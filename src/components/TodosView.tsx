import { useEffect, useMemo, useState } from "react";
import type { Meeting, ActionItem } from "../types";
import { splitLabel, isRtl } from "../lib/summary";
import { dateLocale } from "../lib/dateFormat";
import {
  acceptAgentWork,
  getActionItems,
  setActionItemDone,
  updateActionItem,
} from "../lib/tauri";
import { ListChecks } from "lucide-react";

/** Local today as yyyy-mm-dd. */
function todayStr(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Add (or subtract) days from a yyyy-mm-dd date string, return the same format. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

type DueState = "overdue" | "today" | "upcoming" | "none";
function dueState(due: string | undefined, done: boolean): DueState {
  if (!due || done) return "none";
  const t = todayStr();
  if (due < t) return "overdue";
  if (due === t) return "today";
  return "upcoming";
}

/** "2026-07-04" → "Jul 4" for the due badge. */
function fmtDueDate(due: string): string {
  return new Date(`${due}T00:00:00`).toLocaleDateString(dateLocale(), {
    month: "short",
    day: "numeric",
  });
}

/** Sentinel stored in the `assignee` field for items the user marked "not mine".
 *  Everything is mine by default (empty/other assignee == mine). */
const NOT_MINE = "Not mine";
function isNotMine(assignee: string | undefined): boolean {
  return assignee === NOT_MINE;
}

type FilterTab = "all" | "upcoming" | "today" | "overdue";
const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "upcoming", label: "Upcoming" },
  { id: "today", label: "Due Today" },
  { id: "overdue", label: "Overdue" },
];

type ViewMode = "triage" | "focus";

interface TodosViewProps {
  meetings: Meeting[];
  onOpenMeeting: (id: number) => void;
  scopeMeetingId: number | null;
  onScopeChange: (id: number | null) => void;
}

export function TodosView({ meetings, onOpenMeeting, scopeMeetingId, onScopeChange }: TodosViewProps) {
  const [items, setItems] = useState<ActionItem[]>([]);

  // View mode persisted in localStorage, default "triage".
  const [view, setView] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem("todos_view") === "focus" ? "focus" : "triage";
    } catch {
      return "triage";
    }
  });

  const setViewPersisted = (v: ViewMode) => {
    setView(v);
    try { localStorage.setItem("todos_view", v); } catch {}
  };

  // Meeting scope — driven by parent (sidebar click scopes the board).
  // null = All.

  // Load all action items from DB on mount and when meetings change.
  useEffect(() => {
    getActionItems(null).then(setItems).catch(() => {});
  }, [meetings]);

  const refresh = () => getActionItems(null).then(setItems).catch(() => {});

  // Also refresh when the app/tab regains focus, so items added while this view
  // was already open (e.g. a meeting summarized via the tray/hotkey) show up
  // without needing to navigate away and back.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  // Join meeting metadata (title, recordedAt, attendees) by meeting_id.
  const meetingById = useMemo(() => {
    const map = new Map<number, Meeting>();
    for (const m of meetings) map.set(m.id, m);
    return map;
  }, [meetings]);

  const toggle = (item: ActionItem) => {
    setActionItemDone(item.id, !item.done).then(refresh);
  };

  // Work an agent reported through the MCP server. It is deliberately NOT done
  // until the user accepts it — an agent can reach "ai_done" and no further.
  const accept = (item: ActionItem) => {
    acceptAgentWork(item.id).then(refresh);
  };

  const patchDue = (item: ActionItem, due: string) => {
    updateActionItem(item.id, item.assignee, due).then(refresh);
  };

  // Everything is mine by default; "Not mine" flips the assignee sentinel.
  const toggleMine = (item: ActionItem) => {
    const next = isNotMine(item.assignee) ? "" : NOT_MINE;
    updateActionItem(item.id, next, item.due).then(refresh);
  };

  const [dragId, setDragId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<"overdue" | "week" | "later" | "done" | null>(null);

  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [filter, setFilter] = useState<FilterTab>("all");

  const total = items.length;

  const q = query.trim().toLowerCase();

  // Base visibility: done filter + search.
  const base = items
    .filter((it) => showDone || !it.done)
    .filter(
      (it) =>
        !q ||
        `${it.text} ${meetingById.get(it.meeting_id)?.title ?? ""} ${it.assignee}`
          .toLowerCase()
          .includes(q),
    );

  // Apply the active due-date filter tab.
  //  - All:      every item.
  //  - Due Today: due === today.
  //  - Overdue:  due set, due < today, and not done.
  //  - Upcoming: due set and due > today.
  // Items with no due date appear only under "All".
  const t = todayStr();
  const filtered = base.filter((it) => {
    if (filter === "all") return true;
    if (!it.due) return false;
    if (filter === "today") return it.due === t;
    if (filter === "overdue") return it.due < t && !it.done;
    return it.due > t; // upcoming
  });

  // Counts for the tab labels. MUST be computed over the same pool the list
  // renders (search + show-completed via `base`, plus not-mine and the meeting
  // scope) — counting raw items made the tabs claim more than the queue shows
  // ("Upcoming (9)" over a 7-row list) whenever items were done or dismissed.
  const countPool = base.filter(
    (it) =>
      !isNotMine(it.assignee) &&
      (scopeMeetingId == null || it.meeting_id === scopeMeetingId),
  );
  const counts = {
    all: countPool.length,
    today: countPool.filter((it) => it.due === t).length,
    overdue: countPool.filter((it) => it.due && it.due < t && !it.done).length,
    upcoming: countPool.filter((it) => it.due && it.due > t).length,
  };

  // Scoping is driven by the parent; the per-meeting chip row is gone.
  // chipCandidates was removed — sidebar click now sets the scope directly.

  // Scope-filtered items — every list both views render applies this.
  const scoped =
    scopeMeetingId != null
      ? (view === "focus" ? filtered : base).filter((it) => it.meeting_id === scopeMeetingId)
      : view === "focus"
        ? filtered
        : base;

  // ---- Focus view data ----
  const openItems = scoped
    .filter((it) => !it.done && !isNotMine(it.assignee))
    .sort((a, b) => {
      const aM = meetingById.get(a.meeting_id);
      const bM = meetingById.get(b.meeting_id);
      const aOverdue = !!(a.due && a.due < t);
      const bOverdue = !!(b.due && b.due < t);
      // Overdue first.
      if (aOverdue && !bOverdue) return -1;
      if (!aOverdue && bOverdue) return 1;
      // Both overdue: most overdue first (earliest due).
      if (aOverdue && bOverdue) return (a.due || "").localeCompare(b.due || "");
      // Both dated non-overdue: earliest due first.
      if (a.due && b.due) return a.due.localeCompare(b.due);
      // Dated before undated.
      if (a.due && !b.due) return -1;
      if (!a.due && b.due) return 1;
      // Both undated: tiebreak by newest source meeting.
      return (bM?.recorded_at || "").localeCompare(aM?.recorded_at || "") || b.meeting_id - a.meeting_id;
    });
  const nextUp = openItems[0];
  const queue = openItems.slice(1);
  const openCount = openItems.length;
  const doneCount = scoped.filter((it) => it.done).length;

  const heroEyebrow = (it: ActionItem) => {
    const st = dueState(it.due, false);
    const m = meetingById.get(it.meeting_id);
    const src = m?.title ?? `Meeting #${it.meeting_id}`;
    if (st === "overdue") return `Next up · Overdue · ${src}`;
    if (st === "today") return `Next up · Due today · ${src}`;
    if (st === "upcoming") return `Next up · Due ${fmtDueDate(it.due!)} · ${src}`;
    return `Next up · ${src}`;
  };

  const queueMeta = (it: ActionItem) => {
    const st = dueState(it.due, false);
    if (st === "overdue") return "Overdue";
    if (st === "today") return "Due today";
    if (st === "upcoming") return `Due ${fmtDueDate(it.due!)}`;
    return "—";
  };

  // ---- Triage view data ----
  const thisWeekEnd = addDays(t, 6);

  const triageItemsAll = scoped.filter((it) => !it.done && !isNotMine(it.assignee));

  // An agent is holding these right now: working on them, or waiting for you to
  // accept what it did. They lift OUT of the due-date lanes into one place and
  // drop back the moment you accept — so the lane is only ever busy while an
  // agent actually is. Empty lane = no agent activity, and it collapses away.
  const withAi = triageItemsAll
    .filter((it) => it.status === "in_progress" || it.status === "ai_done")
    .sort((a, b) => {
      // Work awaiting YOUR decision sits above work still running.
      if (a.status !== b.status) return a.status === "ai_done" ? -1 : 1;
      return (b.completed_at || "").localeCompare(a.completed_at || "");
    });
  // Scope-independent: an agent finishing work you filtered away is work you
  // would simply never hear about. The lane still follows the scope; the
  // notice does not.
  const withAiAnywhere = items.filter(
    (it) => !it.done && (it.status === "in_progress" || it.status === "ai_done"),
  );
  const withAiIds = new Set(withAi.map((it) => it.id));
  const triageItems = triageItemsAll.filter((it) => !withAiIds.has(it.id));

  const overdue = triageItems
    .filter((it) => it.due && it.due < t)
    .sort((a, b) => (a.due || "").localeCompare(b.due || ""));

  const thisWeek = triageItems
    .filter((it) => it.due && it.due >= t && it.due <= thisWeekEnd)
    .sort((a, b) => (a.due || "").localeCompare(b.due || ""));

  const later = triageItems
    .filter((it) => !it.due || it.due > thisWeekEnd)
    .sort((a, b) => {
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due && !b.due) return -1;
      if (!a.due && b.due) return 1;
      const aM = meetingById.get(a.meeting_id);
      const bM = meetingById.get(b.meeting_id);
      return (bM?.recorded_at || "").localeCompare(aM?.recorded_at || "") || b.meeting_id - a.meeting_id;
    });

  // Done tray (triage view only): done items in current scope.
  const triageDoneItems = useMemo(() => {
    return items
      .filter((it) => it.done)
      .filter(
        (it) =>
          !q ||
          `${it.text} ${meetingById.get(it.meeting_id)?.title ?? ""}`
            .toLowerCase()
            .includes(q),
      )
      .filter((it) =>
        scopeMeetingId != null ? it.meeting_id === scopeMeetingId : true,
      );
  }, [items, q, scopeMeetingId, meetingById]);

  const triageDoneCount = triageDoneItems.length;
  const [doneOpen, setDoneOpen] = useState(false);

  // ---- Render helpers ----

  const renderScopeChips = () => {
    const scopedMeeting =
      scopeMeetingId != null ? meetingById.get(scopeMeetingId) : undefined;
    const scopedTitle = scopedMeeting?.title ?? "Meeting";
    return (
      <div className="todo-scope-row">
        <button
          className={`todo-scope-chip ${scopeMeetingId === null ? "active" : ""}`}
          onClick={() => onScopeChange(null)}
        >
          All
        </button>
        {scopeMeetingId != null ? (
          <button
            className="todo-scope-chip active"
            onClick={() => onScopeChange(null)}
            title="Clear meeting filter"
          >
            {scopedTitle.length > 34
              ? `${scopedTitle.slice(0, 34)}…`
              : scopedTitle}{" "}
            ×
          </button>
        ) : (
          <span className="todo-scope-hint">
            Click a meeting in the sidebar to focus its to-dos
          </span>
        )}
      </div>
    );
  };

  const renderTriageCard = (it: ActionItem) => {
    const { label, rest } = splitLabel(it.text);
    const rtl = isRtl(it.text);
    const m = meetingById.get(it.meeting_id);
    const meta = it.due ? fmtDueDate(it.due) : "—";
    const ds = it.due ? dueState(it.due, false) : "none";

    return (
      <div
        key={it.id}
        className={`triage-card ${ds === "overdue" ? "hot" : ds === "today" ? "warm" : ""} ${dragId === it.id ? "dragging" : ""}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", String(it.id));
          e.dataTransfer.effectAllowed = "move";
          setDragId(it.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setDropTarget(null);
        }}
      >
        <div className="triage-card-row">
          <input
            type="checkbox"
            className="triage-card-check"
            checked={it.done}
            onChange={() => toggle(it)}
          />
          <span className="triage-card-text" dir={rtl ? "rtl" : "ltr"}>
            {label && <strong>{label}: </strong>}{rest}
          </span>
        </div>
        {m && (
          <span
            className="triage-card-src"
            role="button"
            tabIndex={0}
            onClick={() => onOpenMeeting(it.meeting_id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onOpenMeeting(it.meeting_id);
            }}
            title="Open meeting"
          >
            {m.title}
          </span>
        )}
        <div className="triage-card-meta">
          <span className={`badge-due ${ds}`}>{meta}</span>
          <input
            type="date"
            className="todo-meta-input todo-meta-date triage-card-dismiss"
            value={it.due ?? ""}
            onChange={(e) => patchDue(it, e.target.value)}
            title="Set due date"
            aria-label="Due date"
          />
          <button
            className="triage-card-dismiss"
            onClick={() => toggleMine(it)}
            title="Remove from your list — mark not mine"
          >
            Not mine
          </button>
        </div>
      </div>
    );
  };

  // ---- JSX ----

  return (
    <div className="todos-layout" data-tour="todo-board">
      {/* Header */}
      <div className="todos-header">
        <h1 className="todos-title">Action Items</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* View toggle */}
          <div className="todos-filter-tabs">
            <button
              onClick={() => setViewPersisted("triage")}
              className={`todos-tab ${view === "triage" ? "active" : ""}`}
            >
              Triage
            </button>
            <button
              onClick={() => setViewPersisted("focus")}
              className={`todos-tab ${view === "focus" ? "active" : ""}`}
            >
              Focus
            </button>
          </div>
          {/* Filter tabs — only in Focus view */}
          {/* Agent work needs your attention in EITHER view. The lane itself
              lives on the triage board, but someone who works in Focus would
              otherwise never learn their agent had finished something. */}
          {(view === "focus" || (view === "triage" && withAi.length === 0 && withAiAnywhere.length > 0)) &&
            (view === "focus" ? withAi.length > 0 : true) && (
            <button
              className="agent-focus-note"
              onClick={() => {
                onScopeChange(null);
                setViewPersisted("triage");
              }}
            >
              <strong>
                {withAiAnywhere.filter((it) => it.status === "ai_done").length > 0
                  ? `${withAiAnywhere.filter((it) => it.status === "ai_done").length} finished by AI — waiting for you`
                  : `AI is working on ${withAiAnywhere.length} of your to-dos`}
              </strong>
              <span>
                {view === "triage" ? "In another meeting — show all →" : "Open the board to review →"}
              </span>
            </button>
          )}

          {view === "focus" && total > 0 && (
            <div className="todos-filter-tabs">
              {FILTER_TABS.map((tab) => {
                const c = counts[tab.id];
                return (
                  <button
                    key={tab.id}
                    onClick={() => setFilter(tab.id)}
                    className={`todos-tab ${filter === tab.id ? "active" : ""}`}
                  >
                    {tab.label}
                    {tab.id !== "all" && c ? ` (${c})` : ""}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      {total > 0 && (
        <div className="todos-header">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search to-dos…"
            aria-label="Search to-dos"
            className="search-input"
          />
          {view === "focus" && (
            <label className="todos-tab" style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
              />
              Show completed
            </label>
          )}
        </div>
      )}

      {/* Meeting scope chips */}
      {renderScopeChips()}

      {/* Body */}
      {total === 0 ? (
        <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "13px", padding: "40px" }}>
          <ListChecks size={28} aria-hidden="true" style={{ marginBottom: 8 }} />
          <p>No action items yet.</p>
          <p style={{ marginTop: "4px" }}>
            Record a meeting — its action items show up here automatically.
          </p>
        </div>
      ) : (view === "focus" ? filtered.length === 0 : scoped.length === 0) ? (
        <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "13px", padding: "40px" }}>
          {q
            ? `No to-dos match "${query}".`
            : view === "focus" && filter !== "all"
              ? "Nothing here. Set a due date on a to-do to see it under this tab."
              : "All caught up — nothing open."}
        </div>
      ) : view === "focus" ? (
        /* ---- Focus view (existing) ---- */
        openItems.length === 0 ? (
          <div className="todo-queue-empty">All caught up — nothing in the queue.</div>
        ) : (
          <div>
            {nextUp && (
              <div className="todo-hero">
                <div className="eyebrow">{heroEyebrow(nextUp)}</div>
                <h3 dir={isRtl(nextUp.text) ? "rtl" : "ltr"}>
                  {(() => {
                    const { label, rest } = splitLabel(nextUp.text);
                    return <>{label && <strong>{label}: </strong>}{rest}</>;
                  })()}
                </h3>
                {(() => {
                  const m = meetingById.get(nextUp.meeting_id);
                  return m ? (
                    <div
                      className="src"
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpenMeeting(nextUp.meeting_id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") onOpenMeeting(nextUp.meeting_id);
                      }}
                      title="Open meeting"
                    >
                      {m.title}
                    </div>
                  ) : null;
                })()}
                <div className="todo-hero-actions">
                  <button className="btn-primary" onClick={() => toggle(nextUp)}>Done</button>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      const d = new Date();
                      d.setDate(d.getDate() + 3);
                      patchDue(nextUp, d.toLocaleDateString("en-CA"));
                    }}
                  >
                    Snooze +3 days
                  </button>
                  <input
                    type="date"
                    className="todo-meta-input todo-meta-date"
                    value={nextUp.due ?? ""}
                    onChange={(e) => patchDue(nextUp, e.target.value)}
                    title="Set due date"
                    aria-label="Due date"
                  />
                  <button
                    className="btn-secondary"
                    onClick={() => onOpenMeeting(nextUp.meeting_id)}
                  >
                    Open meeting
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => toggleMine(nextUp)}
                    title="Remove from your list — mark not mine"
                  >
                    Not mine
                  </button>
                </div>
              </div>
            )}

            {queue.length > 0 && (
              <div className="todo-queue">
                {queue.map((it) => {
                  const { label, rest } = splitLabel(it.text);
                  const rtl = isRtl(it.text);
                  const meta = queueMeta(it);
                  return (
                    <div key={it.id} className="todo-queue-row" dir={rtl ? "rtl" : "ltr"}>
                      <input
                        type="checkbox"
                        checked={it.done}
                        onChange={() => toggle(it)}
                      />
                      <span
                        className="todo-text"
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenMeeting(it.meeting_id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") onOpenMeeting(it.meeting_id);
                        }}
                        title="Open meeting"
                      >
                        {label && <strong>{label}: </strong>}{rest}
                      </span>
                      <span className={`badge-due ${dueState(it.due, it.done)} todo-queue-meta`}>
                        {meta}
                      </span>
                      <input
                        type="date"
                        className="todo-meta-input todo-meta-date todo-dismiss"
                        value={it.due ?? ""}
                        onChange={(e) => patchDue(it, e.target.value)}
                        title="Set due date"
                        aria-label="Due date"
                      />
                      <button
                        className="todos-tab todo-dismiss"
                        onClick={() => toggleMine(it)}
                        title="Remove from your list — mark not mine"
                      >
                        Not mine
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="todo-momentum">
              <div className="todo-momentum-bar" />
              {openCount} open · {doneCount} done
            </div>
          </div>
        )
      ) : (
        /* ---- Triage view ---- */
        <div>
          <div className={`triage-lanes${withAi.length > 0 ? " has-ai" : ""}`}>
            {/* Overdue */}
            <div
              className={`triage-lane hot ${dropTarget === "overdue" ? "drop-ok" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropTarget("overdue");
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDropTarget(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragId ?? Number(e.dataTransfer.getData("text/plain"));
                const item = items.find((it) => it.id === id);
                // "Overdue" as a drop = flag it as late: due yesterday.
                if (item && !item.done && !(item.due && item.due < todayStr())) {
                  patchDue(item, addDays(todayStr(), -1));
                }
                setDragId(null);
                setDropTarget(null);
              }}
            >
              <h4>Overdue · {overdue.length}</h4>
              {overdue.length === 0 ? (
                <div className="triage-lane-empty">Nothing overdue 🎉</div>
              ) : (
                overdue.map(renderTriageCard)
              )}
            </div>

            {/* This week */}
            <div
              className={`triage-lane warm ${dropTarget === "week" ? "drop-ok" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropTarget("week");
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDropTarget(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragId ?? Number(e.dataTransfer.getData("text/plain"));
                const item = items.find((it) => it.id === id);
                if (item && !item.done && item.due !== todayStr()) {
                  patchDue(item, todayStr());
                }
                setDragId(null);
                setDropTarget(null);
              }}
            >
              <h4>This week · {thisWeek.length}</h4>
              {thisWeek.length === 0 ? (
                <div className="triage-lane-empty">Nothing this week</div>
              ) : (
                thisWeek.map(renderTriageCard)
              )}
            </div>

            {/* Later */}
            <div
              className={`triage-lane ${dropTarget === "later" ? "drop-ok" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropTarget("later");
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDropTarget(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragId ?? Number(e.dataTransfer.getData("text/plain"));
                const item = items.find((it) => it.id === id);
                if (item && !item.done && item.due !== "") {
                  patchDue(item, "");
                }
                setDragId(null);
                setDropTarget(null);
              }}
            >
              <h4>Later · {later.length}</h4>
              {later.length === 0 ? (
                <div className="triage-lane-empty">Nothing later</div>
              ) : (
                later.map(renderTriageCard)
              )}
            </div>

            {/* With AI — only present while an agent is actually holding work. */}
            {withAi.length > 0 && (
              <div className="triage-lane with-ai">
                <h4>With AI · {withAi.length}</h4>
                {withAi.map((item) => (
                  <div
                    className={`triage-card agent-card${item.status === "ai_done" ? " awaiting" : ""}`}
                    key={item.id}
                  >
                    <span className="triage-card-text">{item.text}</span>
                    {item.status === "ai_done" ? (
                      <>
                        {item.evidence && <span className="agent-evidence">{item.evidence}</span>}
                        <div className="agent-card-foot">
                          <small>
                            {item.completed_by.replace("agent:", "by ")}
                            {item.due && item.due < t ? " · was overdue" : ""}
                          </small>
                          <button className="btn-primary agent-accept" onClick={() => accept(item)}>
                            Accept
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="agent-card-foot">
                        <small>
                          {item.completed_by.replace("agent:", "")} is working on this…
                        </small>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Done tray */}
          {triageDoneCount > 0 && (
            <div
              className={`triage-done-tray ${dropTarget === "done" ? "drop-ok" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropTarget("done");
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDropTarget(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragId ?? Number(e.dataTransfer.getData("text/plain"));
                const item = items.find((it) => it.id === id);
                if (item && !item.done) {
                  toggle(item);
                }
                setDragId(null);
                setDropTarget(null);
              }}
            >
              <button
                className="triage-done-toggle"
                aria-expanded={doneOpen}
                onClick={() => setDoneOpen((o) => !o)}
              >
                {doneOpen ? "▾" : "▸"} Done ({triageDoneCount})
              </button>
              {doneOpen && (
                <div className="triage-done-list">
                  {triageDoneItems.map((it) => (
                    <div key={it.id} className="triage-done-row">
                      <input
                        type="checkbox"
                        checked={it.done}
                        onChange={() => toggle(it)}
                      />
                      <span>{it.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
