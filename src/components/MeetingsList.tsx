import { useState, useEffect, useRef } from "react";
import {
  Archive,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pin,
  Search,
  Trash2,
} from "lucide-react";
import { formatDateTime, formatDate, dateLocale } from "../lib/dateFormat";
import type { Meeting, Tag } from "../types";
import type { TranscriptionSetup } from "../hooks/useTranscriptionSetup";
import { TAG_COLORS } from "../lib/tags";
import { updateMeetingTags } from "../lib/tauri";
import { cleanMeetingTitle } from "../lib/summary";
import { DateHeatmap } from "./DateHeatmap";

function isGenericParticipant(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower === "me" || lower === "them" || lower === "both" || lower === "not mine") return true;
  if (/^speaker \d+$/i.test(lower)) return true;
  return false;
}

interface MeetingsListProps {
  meetings: Meeting[];
  onSelect: (meeting: Meeting) => void;
  onTagsUpdated?: () => void;
  onDelete?: (meeting: Meeting) => void;
  onTogglePin?: (meeting: Meeting) => void;
  onToggleLock?: (meeting: Meeting) => void;
  onToggleArchive?: (meeting: Meeting) => void;
  unlockedIds?: Set<number>;
  /** Meeting currently transcribing in the background (shows a "Transcribing…" badge). */
  transcribingId?: number | null;
  /** Meetings waiting in the background transcription queue (show "Queued"). */
  queuedIds?: number[];
  /** The meeting currently open in the note viewer (gets .selected style). */
  selectedId?: number | null;
  /** Days before an unpinned meeting folds into Archive. 0/undefined = never. */
  archiveAfterDays?: number;
  /** Sidebar meeting-list style: "compact" (one-line rows) | "full" (cards). */
  sidebarView?: string;
  /** On-device transcription state, so an untranscribed recording can say it is
   *  waiting for the model rather than looking like a failure. */
  transcriptionSetup?: TranscriptionSetup;
}

function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remaining = mins % 60;
  return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}

// Mirror the prototype's card snippet: first paragraph after the Overview
// heading (or the start of the summary), with markdown markers stripped.
function snippetFor(summary: string): string {
  const body = summary.split("### Overview\n")[1] || summary;
  return body.split("\n\n")[0].replace(/\*\*|#/g, "").trim();
}

export function MeetingsList({
  meetings,
  onSelect,
  onTagsUpdated,
  onDelete,
  onTogglePin,
  onToggleLock,
  onToggleArchive,
  unlockedIds,
  transcribingId,
  queuedIds,
  selectedId,
  archiveAfterDays,
  sidebarView,
  transcriptionSetup,
}: MeetingsListProps) {
  const queuedSet = new Set(queuedIds ?? []);

  // The live badge on a meeting row. Note the last case is keyed off the DATA,
  // never the "Needs transcription" tag: writing a transcript now clears that
  // tag (and rewrites the title), so the tag can't carry this state any more.
  // The backend drains these automatically once the model lands, so "waiting"
  // is a promise the app keeps rather than a chore for the user.
  const waitingForModel =
    transcriptionSetup?.state === "missing" ||
    transcriptionSetup?.state === "loading" ||
    transcriptionSetup?.state === "downloading";
  const pipelineLabelFor = (meeting: Meeting): string | null => {
    if (meeting.id === transcribingId) return "Transcribing…";
    if (queuedSet.has(meeting.id)) return "Queued";
    if (waitingForModel && meeting.transcript === "" && meeting.audio_file_path != null) {
      return transcriptionSetup?.state === "downloading" && transcriptionSetup.percent !== null
        ? `Waiting for the model — ${transcriptionSetup.percent}%`
        : "Waiting for the model";
    }
    return null;
  };
  // Pinned first, then newest first
  const sorted = [...meetings].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime();
  });

  const [query, setQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; index: number } | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftColor, setDraftColor] = useState<string>("blue");
  const [personFilters, setPersonFilters] = useState<string[]>([]);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState("");
  const [tagMentionHighlight, setTagMentionHighlight] = useState(0);
  const [tagMentionDismissed, setTagMentionDismissed] = useState("");
  const saveTag = async (meeting: Meeting, index: number) => {
    const label = draftLabel.trim();
    if (!label) { setEditing(null); return; }
    // Per-meeting edit only: tags categorize each meeting independently, so
    // changing one meeting's tag must NOT affect any other meeting.
    const next: Tag[] = (meeting.tags ?? []).map((t, i) =>
      i === index ? { label, color: draftColor as Tag["color"] } : t,
    );
    setEditing(null);
    try {
      await updateMeetingTags(meeting.id, next);
      onTagsUpdated?.();
    } catch (e) {
      console.error("Failed to update tag:", e);
    }
  };

  // Pills are scoped to the selected day: clicking a date narrows the tag pills
  // to only the categories present in that day's meetings (so you filter within
  // the 22nd, not the whole history). With no date selected, all tags show.
  // One pill per distinct tag LABEL (colored by the first meeting using it);
  // filtering is by label — robust to per-meeting color differences.
  const dateScoped = dateFilter
    ? meetings.filter(
        (m) => new Date(m.recorded_at).toLocaleDateString("en-CA") === dateFilter,
      )
    : meetings;
  const tagByLabel = new Map<string, { label: string; color: string }>();
  for (const m of dateScoped)
    for (const t of m.tags ?? []) {
      if (!tagByLabel.has(t.label))
        tagByLabel.set(t.label, { label: t.label, color: t.color });
    }
  const pillars = [...tagByLabel.values()];

  // ---- @person search ----
  const people = (() => {
    const seen = new Map<string, { display: string; count: number }>();
    for (const m of meetings) {
      const counted = new Set<string>();
      for (const a of m.attendees ?? []) {
        if (isGenericParticipant(a)) continue;
        const key = a.toLowerCase();
        if (!counted.has(key)) {
          counted.add(key);
          const existing = seen.get(key);
          if (existing) {
            existing.count++;
          } else {
            seen.set(key, { display: a, count: 1 });
          }
        }
      }
    }
    return [...seen.values()].sort(
      (a, b) => b.count - a.count || a.display.localeCompare(b.display),
    );
  })();

  const tokens = query.split(/\s+/);
  const lastToken = tokens[tokens.length - 1] ?? "";
  const mentionActive =
    lastToken.startsWith("@") && lastToken !== mentionDismissed;
  const mentionFragment = mentionActive ? lastToken.slice(1) : "";
  const mentionMatches = mentionActive
    ? people
        .filter(
          (p) =>
            mentionFragment === "" ||
            p.display.toLowerCase().includes(mentionFragment.toLowerCase()),
        )
    : [];
  const safeMentionHighlight =
    mentionMatches.length > 0
      ? Math.min(mentionHighlight, mentionMatches.length - 1)
      : 0;

  const mentionPopupRef = useRef<HTMLDivElement | null>(null);
  const tagMentionPopupRef = useRef<HTMLDivElement | null>(null);

  // Reset keyboard highlight when the mention token/fragment changes.
  useEffect(() => {
    setMentionHighlight(0);
  }, [lastToken]);

  // Scroll highlighted row into view during keyboard nav.
  useEffect(() => {
    if (mentionMatches.length === 0) return;
    const el = mentionPopupRef.current?.querySelector(
      ".mention-row.highlighted",
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [safeMentionHighlight, mentionMatches.length]);

  const pickPerson = (name: string) => {
    if (!personFilters.some((p) => p.toLowerCase() === name.toLowerCase())) {
      setPersonFilters((prev) => [...prev, name]);
    }
    // Remove the @token from the query.
    const parts = query.split(/\s+/);
    parts.pop();
    setQuery(parts.join(" ") + (parts.length > 0 ? " " : ""));
    setMentionDismissed("");
  };
  // ---- end @person search ----

  // ---- #tag search ----
  const tagMentionActive =
    lastToken.startsWith("#") && lastToken !== tagMentionDismissed;
  const tagFragment = tagMentionActive ? lastToken.slice(1) : "";
  const tagMatches = tagMentionActive
    ? pillars
        .filter(
          (t) =>
            tagFragment === "" ||
            t.label.toLowerCase().includes(tagFragment.toLowerCase()),
        )
    : [];
  const safeTagHighlight =
    tagMatches.length > 0
      ? Math.min(tagMentionHighlight, tagMatches.length - 1)
      : 0;

  // Reset keyboard highlight when the tag token/fragment changes.
  useEffect(() => {
    setTagMentionHighlight(0);
  }, [lastToken]);

  // Scroll highlighted tag row into view during keyboard nav.
  useEffect(() => {
    if (tagMatches.length === 0) return;
    const el = tagMentionPopupRef.current?.querySelector(
      ".mention-row.highlighted",
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [safeTagHighlight, tagMatches.length]);

  const pickTag = (label: string) => {
    // Always SET (unlike the pill row's toggle): picking from the popup is an
    // explicit choice, even if that tag is already active.
    setActiveTag(label);
    // Remove the #token from the query.
    const parts = query.split(/\s+/);
    parts.pop();
    setQuery(parts.join(" ") + (parts.length > 0 ? " " : ""));
    setTagMentionDismissed("");
  };
  // ---- end #tag search ----

  // Guard against a stale active filter: if the selected label no longer exists
  // among current pills, behave as "All" rather than silently matching nothing.
  const activeKey = pillars.some((p) => p.label === activeTag) ? activeTag : null;

  // Text query with @tokens stripped so an in-progress mention doesn't
  // feed into the text search.
  const q = query
    .split(/\s+/)
    .filter((t) => !t.startsWith("@") && !t.startsWith("#"))
    .join(" ")
    .trim()
    .toLowerCase();
  const visible = sorted
    .filter((m) => !activeKey || (m.tags ?? []).some((t) => t.label === activeKey))
    .filter(
      (m) =>
        !dateFilter ||
        new Date(m.recorded_at).toLocaleDateString("en-CA") === dateFilter,
    )
    .filter(
      (m) =>
        !q ||
        `${m.title} ${m.summary} ${m.transcript} ${(m.attendees ?? []).join(" ")} ${(m.tags ?? []).map((t) => t.label).join(" ")}`
          .toLowerCase()
          .includes(q),
    )
    .filter(
      (m) =>
        personFilters.length === 0 ||
        personFilters.every((p) =>
          (m.attendees ?? []).some((a) => a.toLowerCase() === p.toLowerCase()),
        ),
    );

  const clearAllFilters = () => {
    setQuery("");
    setDateFilter(null);
    setActiveTag(null);
    setPersonFilters([]);
  };
  const filtersActive =
    q !== "" || dateFilter !== null || activeKey !== null || personFilters.length > 0;

  // ---- Compact row rendering (Sidebar v2) ----

  const DOT_COLORS: Record<string, string> = {
    blue: "#8ec5ff",
    purple: "#e1b3ff",
    orange: "#ffd19a",
    green: "#b7ffc6",
    red: "#ffbcba",
    gray: "#b0b0b0",
    yellow: "#ffe08a",
  };

  function dotColor(m: Meeting): string {
    if (m.locked && !(unlockedIds?.has(m.id) ?? false)) return "var(--text-muted)";
    const firstTag = m.tags?.[0];
    if (firstTag && DOT_COLORS[firstTag.color]) return DOT_COLORS[firstTag.color];
    return "var(--text-muted)";
  }

  function rowWhenLabel(
    meeting: Meeting,
    bin: string,
  ): string {
    const d = new Date(meeting.recorded_at);
    if (bin === "today" || bin === "yesterday") {
      return d.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });
    }
    if (bin === "this-week") {
      return d.toLocaleDateString(dateLocale(), { weekday: "short" });
    }
    return formatDate(meeting.recorded_at);
  }

  const renderRow = (
    meeting: Meeting,
    opts: { isArchive?: boolean; bin?: string } = {},
  ) => {
    const isArchived = opts.isArchive ?? false;
    const bin = opts.bin ?? "flat";
    const hidden = meeting.locked && !(unlockedIds?.has(meeting.id) ?? false);
    const pipelineLabel = pipelineLabelFor(meeting);
    const displayTags = pipelineLabel
      ? (meeting.tags ?? []).filter((t) => t.label !== "Needs transcription")
      : meeting.tags ?? [];
    const menuOpen = menuOpenId === meeting.id;
    const isSelected = meeting.id === selectedId;
    const peekOpen = menuOpen || editing?.id === meeting.id;

    const rowClass = [
      "mrow",
      isArchived && "mrow--archived",
      isSelected && "mrow--selected",
      peekOpen && "mrow--peek-open",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div key={meeting.id} className="mrow-wrap">
        <div
          className={rowClass}
          onClick={() => onSelect(meeting)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(meeting);
            }
          }}
        >
          <span className="mrow-dot" style={{ background: dotColor(meeting) }} />
          {meeting.pinned && (
            <Pin className="mrow-pin" aria-label="Pinned" fill="currentColor" />
          )}
          <span className="mrow-title">
            {hidden ? (
              <span style={{ fontStyle: "italic", color: "var(--text-muted)" }}>Locked meeting</span>
            ) : (
              cleanMeetingTitle(meeting.title)
            )}
          </span>
          <span className="mrow-when">
            {pipelineLabel ? (
              <span className="badge-tag blue">{pipelineLabel}</span>
            ) : (
              rowWhenLabel(meeting, bin)
            )}
          </span>
          <button
            className="mrow-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpenId(menuOpen ? null : meeting.id);
            }}
            title="Actions"
            aria-label="Meeting actions"
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        </div>

        {/* hover peek */}
        <div className="mrow-peek" onClick={(e) => e.stopPropagation()}>
          <div className="mrow-peek-snippet">
            {hidden ? (
              <em style={{ opacity: 0.5 }}>Locked</em>
            ) : (
              <>
                <span>{formatDateTime(meeting.recorded_at)}</span>
                <span> · </span>
                <span>{formatDuration(meeting.duration_seconds)}</span>
                {snippetFor(meeting.summary) && (
                  <>
                    <span> · </span>
                    <span>{snippetFor(meeting.summary)}</span>
                  </>
                )}
              </>
            )}
          </div>

          {/* ---- ⋯ menu ---- */}
          {menuOpen && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 20 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpenId(null);
                  }}
                />
                <div
                  className="tag-add-popup"
                  style={{ left: "auto", right: 0, zIndex: 30 }}
                >
                  <button
                    onClick={() => {
                      setMenuOpenId(null);
                      onTogglePin?.(meeting);
                    }}
                    className="settings-menu-item"
                  >
                    <Pin size={15} aria-hidden="true" />
                    {meeting.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpenId(null);
                      onToggleArchive?.(meeting);
                    }}
                    className="settings-menu-item"
                  >
                    <Archive size={15} aria-hidden="true" />
                    {meeting.archived ? "Unarchive" : "Archive"}
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpenId(null);
                      onToggleLock?.(meeting);
                    }}
                    className="settings-menu-item"
                  >
                    {meeting.locked ? (
                      <LockOpen size={15} aria-hidden="true" />
                    ) : (
                      <Lock size={15} aria-hidden="true" />
                    )}
                    {meeting.locked ? "Unlock" : "Lock"}
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpenId(null);
                      onDelete?.(meeting);
                    }}
                    className="settings-menu-item"
                    style={{ color: "var(--accent-red)" }}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                    Delete
                  </button>
                </div>
              </>
            )}

            {/* ---- tag pills (shown in peek when tags exist) ---- */}
            {!hidden && displayTags.length > 0 && (
              <div className="mrow-peek-badges">
                {displayTags.map((t, index) => {
                  const isEditing =
                    editing?.id === meeting.id && editing?.index === index;
                  return (
                    <span key={index} style={{ position: "relative", display: "inline-block" }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDraftLabel(t.label);
                          setDraftColor(t.color);
                          setEditing(isEditing ? null : { id: meeting.id, index });
                        }}
                        className={`badge-tag ${t.color}`}
                        style={{ border: "none", cursor: "pointer" }}
                      >
                        {t.label}
                      </button>
                      {isEditing && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="tag-add-popup"
                        >
                          <input
                            autoFocus
                            value={draftLabel}
                            onChange={(e) => setDraftLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveTag(meeting, index);
                              if (e.key === "Escape") setEditing(null);
                            }}
                            placeholder="Rename tag…"
                            className="tag-popup-input"
                          />
                          <div className="tag-color-dots">
                            {TAG_COLORS.map((c) => (
                              <button
                                key={c}
                                onClick={() => setDraftColor(c)}
                                aria-label={`color ${c}`}
                                className={`color-dot ${c} ${draftColor === c ? "selected" : ""}`}
                              />
                            ))}
                          </div>
                          <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
                            <button
                              onClick={() => setEditing(null)}
                              className="btn-popup-action cancel"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => saveTag(meeting, index)}
                              className="btn-popup-action confirm"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
      </div>
    );
  };

  // ---- Full-card rendering (classic pre-v2 layout) ----
  const renderCard = (
    meeting: Meeting,
    opts?: { isArchive?: boolean; bin?: string },
  ) => {
    const isArchive = opts?.isArchive ?? false;
    const hidden =
      meeting.locked && !(unlockedIds?.has(meeting.id) ?? false);
    // Background-transcription status (the queue). While in the pipeline,
    // hide the orange "Needs transcription" tag — that's the failed/idle
    // state; the live badge below says what's actually happening.
    const pipelineLabel = pipelineLabelFor(meeting);
    const displayTags = pipelineLabel
      ? (meeting.tags ?? []).filter((t) => t.label !== "Needs transcription")
      : meeting.tags ?? [];
    const cardClass =
      meeting.id === selectedId
        ? isArchive ? "meeting-card selected meeting-card--archived" : "meeting-card selected"
        : isArchive ? "meeting-card meeting-card--archived" : "meeting-card";
    return (
      <div
        key={meeting.id}
        className={cardClass}
        onClick={() => onSelect(meeting)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(meeting);
          }
        }}
      >
        <div className="card-icon-container">
          {meeting.pinned && (
            <Pin aria-label="Pinned" fill="currentColor" />
          )}
          {meeting.locked && (
            <Lock aria-label="Locked" />
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpenId(menuOpenId === meeting.id ? null : meeting.id);
            }}
            title="Actions"
            aria-label="Meeting actions"
            className="btn-tag-delete"
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
          {menuOpenId === meeting.id && (
            <>
              {/* click-away overlay */}
              <div
                style={{ position: "fixed", inset: 0, zIndex: 20 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpenId(null);
                }}
              />
              <div
                onClick={(e) => e.stopPropagation()}
                className="tag-add-popup"
                style={{ left: "auto", right: 0, zIndex: 30 }}
              >
                <button
                  onClick={() => {
                    setMenuOpenId(null);
                    onTogglePin?.(meeting);
                  }}
                  className="settings-menu-item"
                >
                  <Pin size={15} aria-hidden="true" />
                  {meeting.pinned ? "Unpin" : "Pin"}
                </button>
                <button
                  onClick={() => {
                    setMenuOpenId(null);
                    onToggleArchive?.(meeting);
                  }}
                  className="settings-menu-item"
                >
                  <Archive size={15} aria-hidden="true" />
                  {meeting.archived ? "Unarchive" : "Archive"}
                </button>
                <button
                  onClick={() => {
                    setMenuOpenId(null);
                    onToggleLock?.(meeting);
                  }}
                  className="settings-menu-item"
                >
                  {meeting.locked ? (
                    <LockOpen size={15} aria-hidden="true" />
                  ) : (
                    <Lock size={15} aria-hidden="true" />
                  )}
                  {meeting.locked ? "Unlock" : "Lock"}
                </button>
                <button
                  onClick={() => {
                    setMenuOpenId(null);
                    onDelete?.(meeting);
                  }}
                  className="settings-menu-item"
                  style={{ color: "var(--accent-red)" }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  Delete
                </button>
              </div>
            </>
          )}
        </div>

        <div className="meeting-card-header">
          <h4 className="meeting-card-title">
            {hidden ? (
              <span style={{ fontStyle: "italic", color: "var(--text-muted)" }}>
                Locked meeting
              </span>
            ) : (
              cleanMeetingTitle(meeting.title)
            )}
          </h4>
        </div>

        <div className="meeting-card-meta">
          <span>{formatDateTime(meeting.recorded_at)}</span>
          <span>{formatDuration(meeting.duration_seconds)}</span>
        </div>

        {pipelineLabel && (
          <div className="meeting-card-badges">
            <span className="badge-tag blue">{pipelineLabel}</span>
          </div>
        )}

        {!hidden && snippetFor(meeting.summary) && (
          <p className="meeting-card-snippet">{snippetFor(meeting.summary)}</p>
        )}

        {!hidden && displayTags.length > 0 && (
          <div className="meeting-card-badges">
            {displayTags.map((t, index) => {
              const isEditing =
                editing?.id === meeting.id && editing?.index === index;
              return (
                <span key={index} style={{ position: "relative", display: "inline-block" }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDraftLabel(t.label);
                      setDraftColor(t.color);
                      setEditing(isEditing ? null : { id: meeting.id, index });
                    }}
                    className={`badge-tag ${t.color}`}
                    style={{ border: "none", cursor: "pointer" }}
                  >
                    {t.label}
                  </button>
                  {isEditing && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="tag-add-popup"
                    >
                      <input
                        autoFocus
                        value={draftLabel}
                        onChange={(e) => setDraftLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveTag(meeting, index);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        placeholder="Rename tag…"
                        className="tag-popup-input"
                      />
                      <div className="tag-color-dots">
                        {TAG_COLORS.map((c) => (
                          <button
                            key={c}
                            onClick={() => setDraftColor(c)}
                            aria-label={`color ${c}`}
                            className={`color-dot ${c} ${draftColor === c ? "selected" : ""}`}
                          />
                        ))}
                      </div>
                      <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
                        <button
                          onClick={() => setEditing(null)}
                          className="btn-popup-action cancel"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => saveTag(meeting, index)}
                          className="btn-popup-action confirm"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // ---- Renderer selector ----
  const renderMeeting = sidebarView === "full" ? renderCard : renderRow;

  // ---- Binning (Sidebar v2) ----

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const dayOfWeek = now.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const thisMondayStart = todayStart - daysSinceMonday * 86_400_000;
  const firstOfMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const ageCutoff = archiveAfterDays && archiveAfterDays > 0
    ? now.getTime() - archiveAfterDays * 86_400_000
    : 0;

  function meetingIsArchived(m: Meeting): boolean {
    if (m.archived) return true;
    if (m.pinned) return false;
    if (!archiveAfterDays || archiveAfterDays <= 0) return false;
    return new Date(m.recorded_at).getTime() < ageCutoff;
  }

  function meetingDateKey(m: Meeting): number {
    const d = new Date(m.recorded_at);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  type Bin = { label: string; key: string; meetings: Meeting[]; collapsible: boolean };

  function buildBins(filteredMeetings: Meeting[]): Bin[] {
    const pinned: Meeting[] = [];
    const today: Meeting[] = [];
    const yesterday: Meeting[] = [];
    const thisWeek: Meeting[] = [];
    const earlierMonth: Meeting[] = [];
    const monthMap = new Map<string, Meeting[]>();
    const archive: Meeting[] = [];

    for (const m of filteredMeetings) {
      if (m.pinned) { pinned.push(m); continue; }
      if (meetingIsArchived(m)) { archive.push(m); continue; }

      const dk = meetingDateKey(m);
      if (dk === todayStart) { today.push(m); }
      else if (dk === yesterdayStart) { yesterday.push(m); }
      else if (dk >= thisMondayStart) { thisWeek.push(m); }
      else if (dk >= firstOfMonthStart) { earlierMonth.push(m); }
      else {
        const d = new Date(m.recorded_at);
        const label = d.toLocaleDateString(dateLocale(), { month: "long", year: "numeric" });
        if (!monthMap.has(label)) monthMap.set(label, []);
        monthMap.get(label)!.push(m);
      }
    }

    const bins: Bin[] = [];
    if (pinned.length) bins.push({ label: "Pinned", key: "pinned", meetings: pinned, collapsible: false });
    if (today.length) bins.push({ label: "Today", key: "today", meetings: today, collapsible: false });
    if (yesterday.length) bins.push({ label: "Yesterday", key: "yesterday", meetings: yesterday, collapsible: false });
    if (thisWeek.length) bins.push({ label: "This week", key: "this-week", meetings: thisWeek, collapsible: false });
    if (earlierMonth.length) bins.push({ label: "Earlier this month", key: "earlier-month", meetings: earlierMonth, collapsible: false });
    for (const [label, ms] of monthMap) {
      bins.push({ label, key: `month-${label}`, meetings: ms, collapsible: false });
    }
    if (archive.length) bins.push({ label: "Archive", key: "archive", meetings: archive, collapsible: true });
    return bins;
  }

  const [archiveOpen, setArchiveOpen] = useState(false);

  return (
    <div
      data-tour="meeting-list"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      {/* Search + date filter */}
      <div style={{ position: "relative" }}>
        <div className="search-container">
          <div
            className={
              "search-bar" +
              (personFilters.length > 0 || activeKey !== null ? " search-bar--chips" : "")
            }
          >
            <Search className="search-icon" size={14} aria-hidden="true" />
            {personFilters.map((name) => (
              <span className="person-chip" key={name.toLowerCase()}>
                @ {name}
                <button
                  type="button"
                  className="person-chip-remove"
                  onClick={() =>
                    setPersonFilters((prev) =>
                      prev.filter((p) => p.toLowerCase() !== name.toLowerCase()),
                    )
                  }
                  aria-label={"Remove filter " + name}
                >
                  ×
                </button>
              </span>
            ))}
            {activeKey !== null && (
              <span className="person-chip tag-chip">
                # {activeKey}
                <button
                  type="button"
                  className="person-chip-remove"
                  onClick={() => setActiveTag(null)}
                  aria-label={"Remove tag filter " + activeKey}
                >
                  ×
                </button>
              </span>
            )}
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search meetings…  @ people · # tags"
              aria-label="Search meetings"
              className="search-input"
              onKeyDown={(e) => {
                if (mentionActive && mentionMatches.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionHighlight((prev) =>
                      Math.min(prev + 1, mentionMatches.length - 1),
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionHighlight((prev) => Math.max(prev - 1, 0));
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    pickPerson(mentionMatches[safeMentionHighlight].display);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMentionDismissed(lastToken);
                    return;
                  }
                }
                if (tagMentionActive && tagMatches.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setTagMentionHighlight((prev) =>
                      Math.min(prev + 1, tagMatches.length - 1),
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setTagMentionHighlight((prev) => Math.max(prev - 1, 0));
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    pickTag(tagMatches[safeTagHighlight].label);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setTagMentionDismissed(lastToken);
                    return;
                  }
                }
                if (
                  e.key === "Backspace" &&
                  query === "" &&
                  (activeKey !== null || personFilters.length > 0)
                ) {
                  if (activeKey !== null) {
                    setActiveTag(null);
                  } else {
                    setPersonFilters((prev) => prev.slice(0, -1));
                  }
                }
              }}
            />
            {query !== "" && (
              <button
                type="button"
                className="search-clear"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        {mentionMatches.length > 0 && (
          <div className="mention-popup" ref={mentionPopupRef}>
            {mentionMatches.map((p, i) => (
              <button
                key={p.display.toLowerCase()}
                type="button"
                className={
                  "mention-row" +
                  (i === safeMentionHighlight ? " highlighted" : "")
                }
                onClick={() => pickPerson(p.display)}
                onMouseEnter={() => setMentionHighlight(i)}
              >
                <span className="mention-avatar">{p.display[0]}</span>
                {p.display}
                <span className="mention-count">
                  {p.count} meeting{p.count !== 1 ? "s" : ""}
                </span>
              </button>
            ))}
          </div>
        )}
        {tagMatches.length > 0 && (
          <div className="mention-popup" ref={tagMentionPopupRef}>
            {tagMatches.map((t, i) => (
              <button
                key={t.label}
                type="button"
                className={
                  "mention-row" +
                  (i === safeTagHighlight ? " highlighted" : "")
                }
                onClick={() => pickTag(t.label)}
                onMouseEnter={() => setTagMentionHighlight(i)}
              >
                <span className="mention-avatar">#</span>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <DateHeatmap
        meetings={meetings}
        selected={dateFilter}
        onSelect={setDateFilter}
        showClear={filtersActive}
        onClear={clearAllFilters}
      />

      {pillars.length > 0 && (
        <div className="tags-scroll">
          <button
            onClick={() => setActiveTag(null)}
            className={`tag-pill ${activeKey === null ? "active" : ""}`}
          >
            All
          </button>
          {pillars.map((t) => (
            <button
              key={t.label}
              onClick={() => setActiveTag(activeKey === t.label ? null : t.label)}
              className={`tag-pill ${activeKey === t.label ? "active" : ""}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Meetings list */}
      <div className="meetings-list-wrapper">
        {sorted.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: "12px",
              marginTop: "30px",
            }}
          >
            <p style={{ fontWeight: 500, marginBottom: "4px" }}>No meetings yet</p>
            <p>Press Record or use {navigator.userAgent.includes("Mac") ? "⌘⇧M" : "Ctrl+Shift+M"} to start</p>
          </div>
        ) : filtersActive ? (
          /* ---- Filtered view: flat compact rows ---- */
          visible.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: "12px",
                marginTop: "30px",
              }}
            >
              {query
                ? `No meetings match "${query}"`
                : "No meetings match your filters"}
            </div>
          ) : (
            visible.map((m) =>
              renderMeeting(m, { isArchive: meetingIsArchived(m), bin: "flat" }),
            )
          )
        ) : (
          /* ---- Resting view: date bins ---- */
          <>
            {(() => {
              const bins = buildBins(sorted);
              if (bins.length === 0) {
                return (
                  <p
                    style={{
                      textAlign: "center",
                      color: "var(--text-muted)",
                      fontSize: "12px",
                      marginTop: "30px",
                    }}
                  >
                    No meetings yet
                  </p>
                );
              }
              return bins.map((bin) => {
                if (bin.collapsible) {
                  return (
                    <div key={bin.key}>
                      <button
                        className="archive-toggle"
                        onClick={() => setArchiveOpen((v) => !v)}
                        aria-expanded={archiveOpen}
                      >
                        <Archive size={14} aria-hidden="true" />
                        {bin.label}
                        <span className="archive-toggle-hint">
                          {bin.meetings.length} older · searchable
                        </span>
                      </button>
                      {archiveOpen &&
                        bin.meetings.map((m) =>
                          renderMeeting(m, { isArchive: true, bin: bin.key }),
                        )}
                    </div>
                  );
                }
                return (
                  <div key={bin.key}>
                    <div className="list-section-cap">{bin.label}</div>
                    {bin.meetings.map((m) =>
                      renderMeeting(m, { bin: bin.key }),
                    )}
                  </div>
                );
              });
            })()}
          </>
        )}
      </div>
    </div>
  );
}
