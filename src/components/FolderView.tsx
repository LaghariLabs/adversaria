import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Folder } from "lucide-react";
import { formatDate, formatDateTime } from "../lib/dateFormat";
import { cleanMeetingTitle } from "../lib/summary";
import {
  getActionItems,
  getFolderOverview,
  setActionItemDone,
  setFolderInstructions,
} from "../lib/tauri";
import type { ActionItem, FolderOverview, FolderSummary, Meeting } from "../types";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface FolderViewProps {
  folder: FolderSummary;
  /** Meetings filed in this folder, newest first. */
  meetings: Meeting[];
  onOpenMeeting: (meeting: Meeting) => void;
  /** Refresh folders and meeting-folder decisions after this view writes. */
  onFolderUpdated: () => void;
}

const FOLDER_COLORS: Record<string, string> = {
  blue: "#8ec5ff",
  purple: "#e1b3ff",
  orange: "#ffd19a",
  green: "#b7ffc6",
  red: "#ffbcba",
};

const CARD_STYLE: CSSProperties = {
  background: "var(--overlay-5)",
  border: "1px solid var(--border-color)",
  borderRadius: 10,
  padding: "14px 16px",
};

const CARD_CAP_STYLE: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.1em",
  marginBottom: 8,
  textTransform: "uppercase",
};

const FOLDER_WORDS = [
  "Reading folder meetings…",
  "Tracing how it progressed…",
  "Finding the current focus…",
  "Spotting unresolved threads…",
];

function derivePeople(meetings: Meeting[]): Array<{ display: string; count: number }> {
  // Map lower -> { display (first spelling), count, seenMeetingIds? } but count at most once per meeting.
  const map = new Map<string, { display: string; count: number }>();
  const order = new Map<string, string>(); // lower -> first display

  for (const meeting of meetings) {
    const seenInMeeting = new Set<string>();
    for (const raw of meeting.attendees ?? []) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (lower === "me" || lower === "you") continue;
      if (seenInMeeting.has(lower)) continue;
      seenInMeeting.add(lower);
      if (!order.has(lower)) {
        order.set(lower, trimmed);
      }
      const existing = map.get(lower);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(lower, { display: order.get(lower)!, count: 1 });
      }
    }
  }

  const list = Array.from(map.values());
  list.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    // name ascending, case-insensitive but stable
    const al = a.display.toLowerCase();
    const bl = b.display.toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    return a.display.localeCompare(b.display);
  });
  return list.slice(0, 12);
}

export function FolderView({
  folder,
  meetings,
  onOpenMeeting,
  onFolderUpdated,
}: FolderViewProps) {
  const folderDetails = folder.folder;
  const [instructionsDraft, setInstructionsDraft] = useState(folderDetails.instructions);
  const [savedInstructions, setSavedInstructions] = useState(folderDetails.instructions);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | null>(null);
  const [openItems, setOpenItems] = useState<ActionItem[]>([]);

  // Folder overview state
  const [overview, setOverview] = useState<FolderOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Sync the draft when the folder changes externally.
  useEffect(() => {
    setInstructionsDraft(folderDetails.instructions);
    setSavedInstructions(folderDetails.instructions);
    setInstructionsSaved(false);
    setInstructionsError(null);
  }, [folderDetails.id, folderDetails.instructions]);

  useEffect(() => {
    let cancelled = false;
    const meetingIds = new Set(meetings.map((meeting) => meeting.id));
    setOpenItems([]);
    getActionItems(null)
      .then((items) => {
        if (cancelled) return;
        setOpenItems(
          items.filter(
            (item) =>
              meetingIds.has(item.meeting_id) &&
              !item.done &&
              item.status !== "done",
          ),
        );
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("Failed to load folder action items:", error);
        setOpenItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [folderDetails.id, meetings]);

  const people = useMemo(() => derivePeople(meetings), [meetings]);

  const meetingsSignature = useMemo(() => {
    // Stable signature over source hash inputs: id, title, recorded_at, summary, attendees
    return JSON.stringify(
      meetings.map((m) => ({
        id: m.id,
        title: m.title,
        recorded_at: m.recorded_at,
        summary: m.summary,
        attendees: m.attendees,
      })),
    );
  }, [meetings]);

  // Load overview when the folder, its instructions, or its meeting inputs change.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // Zero meetings: backend returns empty without model, but we still call to get correct empty state with stale false.
      // Show loading only when we have no overview yet.
      const hadOverview = overview !== null;
      if (!hadOverview) setOverviewLoading(true);
      else setRefreshing(true);
      setOverviewError(null);
      try {
        const result = await getFolderOverview(folderDetails.id, false);
        if (cancelled) return;
        setOverview(result);
        setOverviewError(null);
      } catch (error) {
        if (cancelled) return;
        // Keep existing overview visible; show error.
        setOverviewError(String(error));
        // If we had no overview and error, overview stays null so initial error UI shows.
      } finally {
        if (cancelled) return;
        setOverviewLoading(false);
        setRefreshing(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderDetails.id, folderDetails.instructions, meetingsSignature]);

  const handleRefresh = async () => {
    // Keep existing prose visible while disabling trigger and showing progress.
    setRefreshing(true);
    setOverviewError(null);
    try {
      const result = await getFolderOverview(folderDetails.id, true);
      setOverview(result);
      setOverviewError(null);
    } catch (error) {
      // Retain prose if we had it; show inline error.
      setOverviewError(String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const saveInstructions = async () => {
    setSavingInstructions(true);
    setInstructionsError(null);
    try {
      await setFolderInstructions(folderDetails.id, instructionsDraft);
      setSavedInstructions(instructionsDraft);
      setInstructionsSaved(true);
      onFolderUpdated();
    } catch (error) {
      setInstructionsError(String(error));
    } finally {
      setSavingInstructions(false);
    }
  };

  const completeActionItem = async (id: number) => {
    try {
      await setActionItemDone(id, true);
      setOpenItems((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      console.warn("Failed to complete folder action item:", error);
    }
  };

  const meetingCountLabel = `${meetings.length} ${meetings.length === 1 ? "meeting" : "meetings"}`;
  const actionItemCountLabel = `${openItems.length} open action ${openItems.length === 1 ? "item" : "items"}`;
  const knowsLine =
    meetings.length > 0
      ? `${meetingCountLabel} · ${actionItemCountLabel} · last activity ${formatDate(meetings[0].recorded_at)}`
      : `${meetingCountLabel} · ${actionItemCountLabel}`;
  const meetingTitleById = new Map(
    meetings.map((meeting) => [meeting.id, cleanMeetingTitle(meeting.title)]),
  );
  const meetingById = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  const instructionsChanged = instructionsDraft !== savedInstructions;

  const hasMeetings = meetings.length > 0;
  const overviewEmpty = !hasMeetings;
  const overviewSummary = overview?.summary ?? "";
  const hasCachedSummary = overviewSummary.trim().length > 0;
  const isStale = overview?.stale ?? false;
  const isInitialError = !hasCachedSummary && overviewError !== null && !overviewLoading;
  const isRefreshError = hasCachedSummary && overviewError !== null;

  const generationStatus = overviewLoading
    ? "Generating folder overview"
    : refreshing
      ? "Updating folder overview"
      : isStale
        ? "New meeting context available"
        : overviewError
          ? "Folder overview error"
          : hasCachedSummary
            ? "Folder overview ready"
            : overviewEmpty
              ? "No meetings filed"
              : "Folder overview idle";

  return (
    <div className="viewer-layout">
      <div className="viewer-header">
        <div className="viewer-meta-row">
          <span
            style={{
              alignItems: "center",
              color: "var(--text-muted)",
              display: "inline-flex",
              fontSize: 11,
              fontWeight: 600,
              gap: 6,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            <Folder
              size={12}
              aria-hidden="true"
              style={{
                color: FOLDER_COLORS[folderDetails.color] ?? FOLDER_COLORS.blue,
              }}
            />
            Folder
          </span>
        </div>
        <div className="viewer-title-row">
          <h1 className="viewer-title">{folderDetails.name}</h1>
        </div>
        <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>{knowsLine}</div>
      </div>

      <div className="viewer-body">
        <div className="folder-view-container">
          <div className="folder-view-grid">
            <div className="folder-view-column folder-view-primary">
              {/* Folder overview – the primary folder narrative */}
              <div className="folder-card folder-overview-card" style={CARD_STYLE}>
              <div style={CARD_CAP_STYLE}>Folder overview</div>

              <div aria-live="polite" className="sr-only">
                {generationStatus}
              </div>

              {overviewEmpty ? (
                <div style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.6 }}>
                  No meetings filed yet. File a meeting to this folder to generate an overview of what it&apos;s
                  about and where things stand.
                </div>
              ) : overviewLoading && !hasCachedSummary ? (
                <ThinkingIndicator words={FOLDER_WORDS} />
              ) : isInitialError ? (
                <div>
                  <div style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 8 }}>
                    Could not generate the folder overview.
                  </div>
                  <div role="alert" style={{ color: "var(--accent-red)", fontSize: 12, marginBottom: 10 }}>
                    {overviewError}
                  </div>
                  <button
                    type="button"
                    className="btn-popup-action confirm"
                    onClick={() => void handleRefresh()}
                    disabled={refreshing}
                    aria-label="Retry generating folder overview"
                    style={{ height: 28, fontSize: 12 }}
                  >
                    Retry
                  </button>
                </div>
              ) : hasCachedSummary ? (
                <div>
                  <div className="folder-overview-prose" style={{ color: "var(--text-primary)", fontSize: 14, lineHeight: 1.7 }}>
                    {overviewSummary}
                  </div>

                  {refreshing && (
                    <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 8 }} aria-live="polite">
                      Updating…
                    </div>
                  )}

                  {!refreshing && isStale && (
                    <div
                      style={{
                        alignItems: "center",
                        background: "var(--overlay-3)",
                        border: "1px solid var(--border-color)",
                        borderRadius: 8,
                        display: "flex",
                        gap: 10,
                        justifyContent: "space-between",
                        marginTop: 12,
                        padding: "8px 10px",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>New meeting context available</span>
                      <button
                        type="button"
                        className="btn-popup-action confirm"
                        onClick={() => void handleRefresh()}
                        disabled={refreshing}
                        aria-label="Update folder overview"
                        style={{ height: 26, fontSize: 11, padding: "0 10px" }}
                      >
                        Update
                      </button>
                    </div>
                  )}

                  {!refreshing && !isStale && (
                    <div
                      style={{
                        alignItems: "center",
                        display: "flex",
                        gap: 10,
                        justifyContent: "space-between",
                        marginTop: 12,
                      }}
                    >
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                        {overview?.generated_at ? `Generated ${formatDateTime(overview.generated_at)}` : ""}{" "}
                        <span style={{ opacity: 0.8 }}>· Generated with the Notes engine selected in Settings. No web browsing.</span>
                      </span>
                      <button
                        type="button"
                        className="btn-popup-action cancel"
                        onClick={() => void handleRefresh()}
                        disabled={refreshing}
                        aria-label="Refresh folder overview"
                        style={{ height: 26, fontSize: 11, padding: "0 10px" }}
                      >
                        Refresh
                      </button>
                    </div>
                  )}

                  {isRefreshError && (
                    <div style={{ marginTop: 10 }}>
                      <div role="alert" style={{ color: "var(--accent-red)", fontSize: 11, marginBottom: 6 }}>
                        {overviewError}
                      </div>
                      <button
                        type="button"
                        className="btn-popup-action cancel"
                        onClick={() => void handleRefresh()}
                        disabled={refreshing}
                        aria-label="Retry generating folder overview"
                        style={{ height: 26, fontSize: 11, padding: "0 10px" }}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                // No cached summary but not loading/error/empty – fallback (should not happen)
                <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No overview yet.</div>
              )}

              {/* People subsection – always available (deterministic) */}
              <div className="folder-overview-divider" style={{ borderTop: "1px solid var(--border-color)", margin: "14px 0 10px" }} />
              <div style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                People across these meetings
              </div>
              {people.length > 0 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {people.map((person) => (
                    <span
                      key={person.display.toLowerCase()}
                      style={{
                        alignItems: "center",
                        background: "var(--overlay-3)",
                        border: "1px solid var(--border-color)",
                        borderRadius: 999,
                        color: "var(--text-secondary)",
                        display: "inline-flex",
                        fontSize: 12,
                        gap: 6,
                        padding: "4px 10px",
                      }}
                    >
                      <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{person.display}</span>
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                        {person.count === 1 ? "1 meeting" : `${person.count} meetings`}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No other attendees identified yet.</div>
              )}
              </div>

              {/* Meetings – folder history beneath the overview */}
              <div className="folder-card folder-meetings-card" style={CARD_STYLE}>
              <div style={CARD_CAP_STYLE}>Meetings</div>
              {meetings.length > 0 ? (
                meetings.map((meeting) => (
                  <button
                    key={meeting.id}
                    type="button"
                    onClick={() => onOpenMeeting(meeting)}
                    style={{
                      alignItems: "center",
                      background: "transparent",
                      border: "none",
                      borderRadius: 6,
                      color: "var(--text-primary)",
                      cursor: "pointer",
                      display: "flex",
                      fontSize: 13,
                      gap: 8,
                      padding: "6px 8px",
                      textAlign: "left",
                      width: "100%",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        background: "var(--text-muted)",
                        borderRadius: "50%",
                        flexShrink: 0,
                        height: 7,
                        width: 7,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {cleanMeetingTitle(meeting.title)}
                    </span>
                    <span
                      style={{
                        color: "var(--text-muted)",
                        flexShrink: 0,
                        fontSize: 11,
                      }}
                    >
                      {formatDate(meeting.recorded_at)}
                    </span>
                  </button>
                ))
              ) : (
                <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No meetings filed here yet. Drag one in from the sidebar.</div>
              )}
              </div>

              {/* Folder controls belong with folder context, beneath Meetings. */}
              <div className="folder-card folder-standing-card" style={CARD_STYLE}>
                <div style={CARD_CAP_STYLE}>Standing instructions</div>
                <div style={{ color: "var(--text-secondary)", fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>
                  Guides this folder&apos;s overview.
                </div>
                <textarea
                  aria-label="Standing instructions"
                  value={instructionsDraft}
                  onChange={(event) => {
                    setInstructionsDraft(event.target.value);
                    setInstructionsSaved(false);
                    setInstructionsError(null);
                  }}
                  placeholder="For example: prioritize technical risks, keep decisions concise, and flag anything without an owner."
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-primary)",
                    fontFamily: "inherit",
                    fontSize: 14,
                    lineHeight: 1.6,
                    minHeight: 72,
                    outline: "none",
                    resize: "vertical",
                    width: "100%",
                  }}
                />
                <div
                  style={{
                    alignItems: "center",
                    display: "flex",
                    gap: 10,
                    justifyContent: "space-between",
                  }}
                >
                  <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Saved on this device and applied across this folder.</span>
                  <div
                    style={{
                      alignItems: "center",
                      display: "flex",
                      flexShrink: 0,
                      gap: 8,
                    }}
                  >
                    {instructionsError && (
                      <span role="alert" style={{ color: "var(--accent-red)", fontSize: 11 }}>
                        {instructionsError}
                      </span>
                    )}
                    {instructionsChanged ? (
                      <button
                        type="button"
                        className="btn-popup-action confirm"
                        disabled={savingInstructions}
                        onClick={() => void saveInstructions()}
                        style={{ height: 24, fontSize: 11, padding: "0 10px" }}
                      >
                        Save
                      </button>
                    ) : instructionsSaved ? (
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Saved</span>
                    ) : null}
                  </div>
                </div>
              </div>

            </div>

            <div className="folder-view-column folder-view-secondary">
              {/* Open action items – the supporting execution rail */}
              <div className="folder-card folder-openitems-card" style={CARD_STYLE}>
                <div style={CARD_CAP_STYLE}>Open action items</div>
                {openItems.length > 0 ? (
                  openItems.map((item) => (
                    <div key={item.id} className="folder-action-item">
                      <input
                        type="checkbox"
                        checked={false}
                        aria-label={`Complete ${item.text}`}
                        onChange={() => void completeActionItem(item.id)}
                        className="folder-action-checkbox"
                      />
                      <div className="folder-action-content">
                        <span className="folder-action-text">{item.text}</span>
                        {meetingById.get(item.meeting_id) && (
                          <button
                            type="button"
                            className="folder-action-source"
                            onClick={() => onOpenMeeting(meetingById.get(item.meeting_id)!)}
                            aria-label={`Open source meeting ${meetingTitleById.get(item.meeting_id)}`}
                          >
                            {meetingTitleById.get(item.meeting_id)}
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Nothing open.</div>
                )}
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
