import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import d3Force from "cytoscape-d3-force";
import { parseSummary, isRtl } from "../lib/summary";
import { getMeetingGraph, getActionItems, getPerson, savePerson } from "../lib/tauri";
import { formatDate } from "../lib/dateFormat";
import type { GraphData, Meeting, ActionItem, PersonProfile } from "../types";

// Register the d3-force layout once at module scope (idempotent).
cytoscape.use(d3Force);

interface GraphViewProps {
  meetings: Meeting[];
  onSelectMeeting?: (id: number) => void;
}

/** Node palette — one colour per node type; mirrored in the legend below. */
const NODE_COLORS: Record<string, string> = {
  meeting: "#3182ce",
  person: "#38a169",
  tag: "#805ad5",
  owner: "#dd6b20",
};

/** Node types the legend can hide. Meetings are the graph's spine — always shown. */
type ToggleType = "person" | "tag" | "owner";

const LEGEND: { type: "meeting" | ToggleType; label: string }[] = [
  { type: "meeting", label: "Meetings" },
  { type: "person", label: "People" },
  { type: "tag", label: "Tags" },
  { type: "owner", label: "Owners" },
];

/** Keep node labels readable — long meeting titles get ellipsized. */
function truncate(label: string, max = 26): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

interface Selected {
  label: string;
  nodeType: string;
  meetingId: number | null;
}

/** Node positions survive tab switches (module scope outlives the component),
 * so reopening the Graph resumes where it settled instead of re-scattering
 * and re-running the whole settle animation. */
const savedPositions = new Map<string, { x: number; y: number }>();

// ---- Dossier panel ----

/** The editable half of a PersonProfile (everything except the identity). */
type ProfileForm = {
  role: string;
  company: string;
  notes: string;
  aliases: string;
  email: string;
  phone: string;
  linkedin: string;
};

/** Nodes whose visible or full label contains `q` (already lowercased). */
function matchNodes(cy: cytoscape.Core, q: string) {
  return cy
    .nodes()
    .filter((n) =>
      String(n.data("fullLabel") ?? n.data("label") ?? "")
        .toLowerCase()
        .includes(q),
    );
}

const EMPTY_PROFILE_FORM: ProfileForm = {
  role: "",
  company: "",
  notes: "",
  aliases: "",
  email: "",
  phone: "",
  linkedin: "",
};

interface DossierProps {
  selected: Selected;
  meetings: Meeting[];
  personProfile: PersonProfile | null;
  profileForm: ProfileForm;
  setProfileForm: (f: ProfileForm) => void;
  actionItemsCache: React.MutableRefObject<Map<number, ActionItem[]>>;
  allActionItemsCache: React.MutableRefObject<ActionItem[] | null>;
  onSelectMeeting?: (id: number) => void;
  onClose: () => void;
}

function Dossier({
  selected,
  meetings,
  personProfile,
  profileForm,
  setProfileForm,
  actionItemsCache,
  allActionItemsCache,
  onSelectMeeting,
  onClose,
}: DossierProps) {
  const [meetingActions, setMeetingActions] = useState<ActionItem[] | null>(null);
  const [personActions, setPersonActions] = useState<ActionItem[] | null>(null);
  const [allItems, setAllItems] = useState<ActionItem[] | null>(null);
  const [saveLabel, setSaveLabel] = useState<string | null>(null);

  // Fetch meeting action items when a meeting node is selected.
  useEffect(() => {
    if (selected.nodeType === "meeting" && selected.meetingId != null) {
      const cached = actionItemsCache.current.get(selected.meetingId);
      if (cached) {
        setMeetingActions(cached);
      } else {
        getActionItems(selected.meetingId)
          .then((items) => {
            actionItemsCache.current.set(selected.meetingId!, items);
            setMeetingActions(items);
          })
          .catch(() => setMeetingActions([]));
      }
    } else {
      setMeetingActions(null);
    }
  }, [selected]);

  // Fetch all action items once for person nodes.
  useEffect(() => {
    if (selected.nodeType === "person") {
      if (allActionItemsCache.current) {
        setAllItems(allActionItemsCache.current);
      } else {
        getActionItems(null)
          .then((items) => {
            allActionItemsCache.current = items;
            setAllItems(items);
          })
          .catch(() => setAllItems([]));
      }
    } else {
      setAllItems(null);
      setPersonActions(null);
    }
  }, [selected]);

  // Filter person actions when allItems or personProfile changes.
  useEffect(() => {
    if (!allItems || selected.nodeType !== "person") {
      setPersonActions(null);
      return;
    }
    const labelLower = selected.label.toLowerCase();
    const aliasList = (personProfile?.aliases ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    const matches = allItems.filter(
      (a) =>
        !a.done &&
        (a.assignee.toLowerCase() === labelLower ||
          a.text.toLowerCase().includes(labelLower) ||
          aliasList.some(
            (alias) =>
              a.assignee.toLowerCase() === alias ||
              a.text.toLowerCase().includes(alias),
          )),
    );
    setPersonActions(matches.slice(0, 5));
  }, [allItems, selected, personProfile]);

  // Compute meetings-together for person nodes.
  const meetingsTogether = useMemo(() => {
    if (selected.nodeType !== "person") return [];
    const labelLower = selected.label.toLowerCase();
    const aliasList = (personProfile?.aliases ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    return meetings
      .filter((m) =>
        m.attendees.some((a) => {
          const aLower = a.toLowerCase();
          return (
            aLower.includes(labelLower) ||
            aliasList.some((alias) => aLower.includes(alias))
          );
        }),
      )
      .sort(
        (a, b) =>
          new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
      )
      .slice(0, 6);
  }, [selected, meetings, personProfile]);

  const handleSave = async () => {
    try {
      await savePerson({
        name: selected.label,
        ...profileForm,
      });
      setSaveLabel("Saved ✓");
      setTimeout(() => setSaveLabel(null), 1500);
    } catch {
      setSaveLabel("Save failed");
    }
  };

  const meeting = selected.meetingId != null
    ? meetings.find((m) => m.id === selected.meetingId)
    : null;

  // --- Meeting node dossier ---
  if (selected.nodeType === "meeting") {
    const parsed = meeting ? parseSummary(meeting.summary) : null;
    const sections = parsed ? parsed.sections.slice(0, 3) : [];
    const isRtlSummary = meeting ? isRtl(meeting.summary) : false;
    const openItems =
      meetingActions?.filter((a) => !a.done) ?? [];

    return (
      <aside className="graph-dossier" dir={isRtlSummary ? "rtl" : "auto"}>
        <button className="gd-close" onClick={onClose} aria-label="Close">×</button>
        {meeting ? (
          <>
            <div className="graph-dossier-kicker">
              Meeting · {formatDate(meeting.recorded_at)} · {Math.round(meeting.duration_seconds / 60)}m
            </div>
            <h3>{meeting.title}</h3>
            {meeting.attendees.length > 0 && (
              <div className="gd-attendees">
                {meeting.attendees.join(", ")}
              </div>
            )}
            {sections.map((s, i) => (
              <div key={i} className="gd-section">
                <h4 className="gd-section-heading">{s.heading}</h4>
                <ul className="gd-bullets">
                  {s.bullets.slice(0, 4).map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                  {s.bullets.length > 4 && (
                    <li className="gd-more">…more in the full note</li>
                  )}
                </ul>
              </div>
            ))}
            {openItems.length > 0 && (
              <div className="gd-section">
                <h4 className="gd-section-heading">Action Items</h4>
                <ul className="gd-bullets">
                  {openItems.map((a) => (
                    <li key={a.id}>
                      {a.text.trim()}
                      {a.due && (
                        <span className="badge-due">{a.due}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="gd-footer">
              {onSelectMeeting && (
                <button
                  className="todos-tab active"
                  onClick={() => onSelectMeeting(selected.meetingId!)}
                >
                  Open full note →
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="graph-dossier-kicker">Meeting</div>
            <h3>{selected.label}</h3>
            {onSelectMeeting && selected.meetingId != null && (
              <button
                className="todos-tab active"
                onClick={() => onSelectMeeting(selected.meetingId!)}
              >
                Open meeting →
              </button>
            )}
          </>
        )}
      </aside>
    );
  }

  // --- Person node dossier ---
  if (selected.nodeType === "person") {
    const nMeetings = meetingsTogether.length;
    return (
      <aside className="graph-dossier">
        <button className="gd-close" onClick={onClose} aria-label="Close">×</button>
        <div className="graph-dossier-kicker">Person · seen in {nMeetings} meeting{nMeetings !== 1 ? "s" : ""}</div>
        <h3>{selected.label}</h3>

        {/* Editable profile */}
        <div className="gd-section">
          <h4 className="gd-section-heading">Profile</h4>
          <div className="gd-field">
            <label>Role</label>
            <input
              className="settings-input-text"
              value={profileForm.role}
              onChange={(e) =>
                setProfileForm({ ...profileForm, role: e.target.value })
              }
              placeholder="e.g. Engineer, Designer"
            />
          </div>
          <div className="gd-field">
            <label>Company</label>
            <input
              className="settings-input-text"
              value={profileForm.company}
              onChange={(e) =>
                setProfileForm({ ...profileForm, company: e.target.value })
              }
              placeholder="e.g. Stripe, Figma"
            />
          </div>
          <div className="gd-field">
            <label>Notes</label>
            <textarea
              className="settings-input-text"
              rows={2}
              value={profileForm.notes}
              onChange={(e) =>
                setProfileForm({ ...profileForm, notes: e.target.value })
              }
              placeholder="Context, how you know them, what they work on…"
            />
          </div>
          <div className="gd-field">
            <label>Aliases</label>
            <input
              className="settings-input-text"
              value={profileForm.aliases}
              onChange={(e) =>
                setProfileForm({ ...profileForm, aliases: e.target.value })
              }
              placeholder="e.g. Dan, D. Smith — comma-separated"
            />
            <div className="gd-hint">
              Aliases fold other spellings of this person into one profile.
            </div>
          </div>
          <div className="gd-field">
            <label>Email</label>
            <input
              className="settings-input-text"
              type="email"
              value={profileForm.email}
              onChange={(e) =>
                setProfileForm({ ...profileForm, email: e.target.value })
              }
              placeholder="name@company.com"
            />
          </div>
          <div className="gd-field">
            <label>Phone</label>
            <input
              className="settings-input-text"
              value={profileForm.phone}
              onChange={(e) =>
                setProfileForm({ ...profileForm, phone: e.target.value })
              }
              placeholder="+971 50 123 4567"
            />
          </div>
          <div className="gd-field">
            <label>LinkedIn</label>
            <input
              className="settings-input-text"
              value={profileForm.linkedin}
              onChange={(e) =>
                setProfileForm({ ...profileForm, linkedin: e.target.value })
              }
              placeholder="linkedin.com/in/…"
            />
            <div className="gd-hint">
              Contact details stay on this device — they are never inferred from
              audio and never leave with a summary.
            </div>
          </div>
          <button
            className="todos-tab active"
            onClick={handleSave}
            style={{ marginTop: 8 }}
          >
            {saveLabel ?? "Save profile"}
          </button>
        </div>

        {/* Meetings together */}
        {meetingsTogether.length > 0 && (
          <div className="gd-section">
            <h4 className="gd-section-heading">Meetings Together</h4>
            {meetingsTogether.map((m) => (
              <div
                key={m.id}
                className="gd-row"
                onClick={() => onSelectMeeting?.(m.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelectMeeting?.(m.id);
                }}
              >
                <span className="gd-row-title">{m.title}</span>
                <span className="gd-row-meta">{formatDate(m.recorded_at)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Open to-dos involving them */}
        {personActions !== null && personActions.length > 0 && (
          <div className="gd-section">
            <h4 className="gd-section-heading">Open To-Dos</h4>
            <ul className="gd-bullets">
              {personActions.map((a) => (
                <li key={a.id}>
                  {a.text.trim()}
                  {a.due && (
                    <span className="badge-due">{a.due}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    );
  }

  // --- Tag / owner node dossier (minimal) ---
  return (
    <aside className="graph-dossier">
      <button className="gd-close" onClick={onClose} aria-label="Close">×</button>
      <div className="graph-dossier-kicker">{selected.nodeType}</div>
      <h3>{selected.label}</h3>
    </aside>
  );
}

export function GraphView({ meetings, onSelectMeeting }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [hidden, setHidden] = useState<Set<ToggleType>>(new Set());
  const [personProfile, setPersonProfile] = useState<PersonProfile | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileForm>(EMPTY_PROFILE_FORM);
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const actionItemsCache = useRef<Map<number, ActionItem[]>>(new Map());
  const allActionItemsCache = useRef<ActionItem[] | null>(null);

  // Load person profile when a person node is selected.
  useEffect(() => {
    if (selected?.nodeType === "person") {
      getPerson(selected.label)
        .then((p) => {
          setPersonProfile(p);
          if (p) {
            setProfileForm({
              role: p.role,
              company: p.company,
              notes: p.notes,
              aliases: p.aliases,
              email: p.email,
              phone: p.phone,
              linkedin: p.linkedin,
            });
          } else {
            setProfileForm(EMPTY_PROFILE_FORM);
          }
        })
        .catch(() => setPersonProfile(null));
    } else {
      setPersonProfile(null);
    }
  }, [selected]);

  useEffect(() => {
    getMeetingGraph()
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!data || !containerRef.current || data.nodes.length === 0) return;

    // Apply the legend toggles: drop hidden node types and any edge that
    // touches a hidden node.
    const nodes = data.nodes.filter(
      (n) => n.node_type === "meeting" || !hidden.has(n.node_type as ToggleType),
    );
    const keys = new Set(nodes.map((n) => n.key));
    const edges = data.edges.filter((e) => keys.has(e.source) && keys.has(e.target));

    // Degree per node key — connected nodes render larger so hubs (recurring
    // people, busy tags) stand out at a glance.
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const sizeFor = (key: string, type: string) => {
      const d = degree.get(key) ?? 0;
      const base = type === "meeting" ? 24 : 16;
      return Math.min(base + d * 2.5, 60);
    };

    // Returning nodes resume their settled spots; only new ones scatter.
    const hasSaved = nodes.some((n) => savedPositions.has(n.key));
    const w = containerRef.current.clientWidth || 800;
    const h = containerRef.current.clientHeight || 600;
    const posFor = (key: string) =>
      savedPositions.get(key) ?? { x: Math.random() * w, y: Math.random() * h };

    // An uncaught throw in this effect unmounts the ENTIRE React tree (black
    // window) — catch and degrade to the error state instead.
    try {
      const cy = cytoscape({
        container: containerRef.current,
        minZoom: 0.15,
        maxZoom: 3,
        elements: [
          ...nodes.map((n) => ({
            data: {
              id: n.key,
              label: truncate(n.label),
              fullLabel: n.label,
              nodeType: n.node_type,
              meetingId: n.meeting_id,
              size: sizeFor(n.key, n.node_type),
            },
            position: posFor(n.key),
            classes: n.node_type,
          })),
          ...edges.map((e) => ({
            data: {
              id: `${e.source}--${e.label}--${e.target}`,
              source: e.source,
              target: e.target,
              label: e.label,
            },
            classes: e.label,
          })),
        ],
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              width: "data(size)",
              height: "data(size)",
              "text-valign": "bottom",
              "text-halign": "center",
              "text-margin-y": 4,
              "font-size": "9px",
              // Obsidian-style text fade: labels disappear when zoomed out, so
              // the wide view is shapes and structure, not letter soup.
              "min-zoomed-font-size": 8,
              "text-wrap": "wrap",
              "text-max-width": "110px",
              "background-color": "#4a5568",
              color: "#cbd5e0",
              "text-outline-width": 2,
              "text-outline-color": "#1a1a1f",
            },
          },
          {
            selector: "node.meeting",
            style: {
              "background-color": NODE_COLORS.meeting,
              shape: "round-rectangle",
              "font-size": "10px",
              color: "#e2e8f0",
            },
          },
          { selector: "node.person", style: { "background-color": NODE_COLORS.person, shape: "ellipse" } },
          { selector: "node.tag", style: { "background-color": NODE_COLORS.tag, shape: "diamond" } },
          { selector: "node.owner", style: { "background-color": NODE_COLORS.owner, shape: "triangle" } },
          {
            selector: "edge",
            style: {
              width: 1,
              "line-color": "#4a5568",
              "line-opacity": 0.55,
              "target-arrow-shape": "none",
              "curve-style": "haystack",
            },
          },
          // Meeting↔meeting "shared attendee" links are inferred, not recorded —
          // dashed so they read differently from real membership edges.
          {
            selector: "edge.shared-attendee",
            style: { "line-style": "dashed", "line-opacity": 0.35 },
          },
          {
            selector: "node.highlighted",
            style: { "border-width": 3, "border-color": "#ffffff" },
          },
          { selector: ".faded", style: { opacity: 0.12 } },
        ],
        // Every node has an explicit position (saved spot or fresh scatter);
        // the force simulation pulls the structure together from there.
        layout: { name: "preset" },
      });

      // Obsidian-feel physics: an infinite d3-force simulation — nodes keep
      // drifting, and dragging one tugs its neighbors (the extension pins the
      // grabbed node and reheats the simulation; requires animate: true).
      const layout = cy.layout({
        name: "d3-force",
        animate: true,
        infinite: true,
        fit: false, // don't yank the viewport every tick
        fixedAfterDragging: false, // released nodes float back into place
        // REQUIRED: d3's link force resolves edge endpoints by array index
        // unless given an id accessor — string node ids crash without this.
        linkId: (d: { id: string }) => d.id,
        linkDistance: 70,
        linkStrength: 0.4,
        manyBodyStrength: -250, // repel force
        xStrength: 0.05, // weak gravity toward the center
        yStrength: 0.05,
        collideRadius: (n: { size?: number }) => (n.size ?? 24) / 2 + 8,
        // Calm physics: the wrapper reheats to alpha/3 on every drag, so a
        // lower initial alpha both softens the settle-in AND the drag tug;
        // faster alphaDecay + heavy velocityDecay stop the perpetual flutter.
        // Resuming saved positions needs only a gentle relax, not a full settle.
        alpha: hasSaved ? 0.12 : 0.5,
        alphaDecay: 0.05,
        velocityDecay: 0.65,
      } as unknown as cytoscape.LayoutOptions);
      layout.run();

      // The wrapper restarts the simulation with alphaTarget = alpha/3 on grab
      // AND on release, and never brings it back down — after a drag the graph
      // buzzes at constant energy until the tick budget runs out, then freezes
      // mid-motion. Zeroing alphaTarget on release lets it decay smoothly to
      // rest instead. (This handler runs after the wrapper's — cytoscape fires
      // element listeners before core-delegated ones.)
      const sim = (layout as unknown as { simulation?: { alphaTarget(t: number): unknown } })
        .simulation;
      cy.on("free", "node", () => {
        sim?.alphaTarget(0);
      });

      // One fit after the first moments of settling, so the graph is framed
      // without chasing it forever.
      const fitTimer = window.setTimeout(() => cy.fit(undefined, 40), 700);

      // Tap = explore: highlight the node's neighborhood and show its details in
      // the info bar (opening a meeting is an explicit action there, so a stray
      // click can't navigate you away from the graph).
      cy.on("tap", "node", (evt) => {
        const node = evt.target;
        cy.elements().addClass("faded").removeClass("highlighted");
        node.closedNeighborhood().removeClass("faded");
        node.addClass("highlighted");
        setSelected({
          label: node.data("fullLabel") as string,
          nodeType: node.data("nodeType") as string,
          meetingId: (node.data("meetingId") as number | null) ?? null,
        });
      });
      cy.on("tap", (evt) => {
        if (evt.target === cy) {
          cy.elements().removeClass("faded").removeClass("highlighted");
          setSelected(null);
        }
      });

      cyRef.current = cy;
      setSelected(null); // a rebuild may have removed the selected node
      return () => {
        window.clearTimeout(fitTimer);
        layout.stop(); // infinite layouts never stop on their own
        // Remember where everything settled for the next visit.
        cy.nodes().forEach((n) => {
          const p = n.position();
          savedPositions.set(n.id(), { x: p.x, y: p.y });
        });
        cy.destroy();
        cyRef.current = null;
      };
    } catch (e) {
      setError(`Graph rendering failed: ${e}`);
      return;
    }
  }, [data, hidden]);

  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 30);
  }, []);

  // Search dims everything except label matches. It reuses the same
  // faded/highlighted classes as tap-to-explore, so the two can never end up
  // fighting over the graph's visual state.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      cy.elements().removeClass("faded").removeClass("highlighted");
      setMatchCount(null);
      return;
    }
    const matches = matchNodes(cy, q);
    cy.elements().addClass("faded").removeClass("highlighted");
    matches.removeClass("faded").addClass("highlighted");
    setMatchCount(matches.length);
  }, [query, data, hidden]);

  // Enter (or the match count) zooms to whatever matched.
  const handleSearchFit = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const q = query.trim().toLowerCase();
    if (!q) return;
    const matches = matchNodes(cy, q);
    if (matches.length > 0) cy.fit(matches, 80);
  }, [query]);

  const toggleType = (t: ToggleType) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const msgStyle = { padding: 24, color: "var(--text-secondary)", fontSize: 14 };

  if (error) return <div style={msgStyle}>Couldn't load the graph: {error}</div>;
  if (!data) return <div style={msgStyle}>Loading graph…</div>;
  if (data.nodes.length === 0) {
    return (
      <div style={msgStyle}>
        No meetings to graph yet. Graphs get richer as you record or import more meetings.
      </div>
    );
  }

  return (
    <div className="graph-layout">
      <div className="graph-toolbar">
        <div className="graph-legend">
          {LEGEND.map((l) => {
            if (l.type === "meeting") {
              return (
                <span key={l.type} className="graph-legend-item">
                  <span className="graph-legend-dot" style={{ background: NODE_COLORS[l.type] }} />
                  {l.label}
                </span>
              );
            }
            const t = l.type; // narrowed to ToggleType for the closures below
            return (
              <button
                key={t}
                type="button"
                className={`graph-legend-item graph-legend-item--toggle ${hidden.has(t) ? "off" : ""}`}
                onClick={() => toggleType(t)}
                title={hidden.has(t) ? `Show ${l.label.toLowerCase()}` : `Hide ${l.label.toLowerCase()}`}
                aria-pressed={!hidden.has(t)}
              >
                <span className="graph-legend-dot" style={{ background: NODE_COLORS[t] }} />
                {l.label}
              </button>
            );
          })}
        </div>
        <div className="graph-search">
          <input
            className="graph-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearchFit();
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search people, meetings, tags…"
            aria-label="Search the graph"
          />
          {matchCount !== null && (
            <button
              type="button"
              className="graph-search-count"
              onClick={handleSearchFit}
              title="Zoom to matches"
            >
              {matchCount} match{matchCount === 1 ? "" : "es"}
            </button>
          )}
        </div>
        <span className="graph-counts">
          {data.nodes.length} nodes · {data.edges.length} links
        </span>
        <button className="todos-tab" onClick={handleFit} title="Fit graph to view">
          Fit
        </button>
      </div>
      <div ref={containerRef} className="graph-canvas" />
      {selected && (
        <Dossier
          selected={selected}
          meetings={meetings}
          personProfile={personProfile}
          profileForm={profileForm}
          setProfileForm={setProfileForm}
          actionItemsCache={actionItemsCache}
          allActionItemsCache={allActionItemsCache}
          onSelectMeeting={onSelectMeeting}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
