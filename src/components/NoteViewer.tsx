import { useEffect, useState } from "react";
import {
  exportHtml,
  exportMeetingBundle,
  exportSummary,
  getActionItems,
  getConfig,
  getMeetingStats,
  listTemplates,
  mergeMeetingSpeakers,
  updateMeetingLink,
  resummarizeMeeting,
  retryRecordingCleanup,
  structureNote,
  setActionItemDone,
  transcribeMeeting,
  updateAttendees,
  updateConfig,
  updateMeetingNotes,
  updateMeetingSummary,
  updateMeetingTags,
} from "../lib/tauri";
import type { ActionItem, Meeting, MeetingStats, SummaryLanguage, Tag } from "../types";
import { MeetingChat } from "./MeetingChat";
import { SummaryView } from "./SummaryView";
import {
  cleanMeetingTitle,
  isRtl,
  summaryToHtml,
  summaryToPlainText,
  withoutSpeakerLabels,
} from "../lib/summary";
import { buildSlideHtml, exportFileBase } from "../lib/exportDocument";
import { formatDateTime } from "../lib/dateFormat";
import {
  Download,
  FileJson,
  Lock,
  Pin,
  Presentation,
  Trash2,
} from "lucide-react";

const LANGUAGE_OPTIONS: { value: SummaryLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية" },
  { value: "auto", label: "Match spoken" },
];

interface NoteViewerProps {
  meeting: Meeting;
  onMeetingUpdated: (meeting: Meeting) => void;
  onTogglePin?: (meeting: Meeting) => void;
  onToggleLock?: (meeting: Meeting) => void;
  onDelete?: (meeting: Meeting) => void;
  /** This meeting is currently transcribing in the background queue. */
  isTranscribing?: boolean;
  /** This meeting is waiting in the background transcription queue. */
  isQueued?: boolean;
  /** The meeting was auto-deleted because its recording contained no speech. */
  onDiscarded?: () => void;
}

type Tab = "transcript" | "summary" | "chat" | "notes" | "insights";

function formatTurnTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* Stable per-speaker transcript colors, matching the notch pill's channels:
   the user ("Me"/their configured name) is always blue, other speakers get
   red first, then further hues by order of first appearance. A speaker keeps
   one color for the whole meeting; hues read on dark and light. */
const ME_SPEAKER_COLOR = "#3d97ff";
const OTHER_SPEAKER_COLORS = ["#ff5f57", "#67c587", "#c584e0", "#e0a458", "#58c5e0"];

function speakerColorMap(
  turns: { speaker: string }[],
  meName: string,
): Map<string, string> {
  const colors = new Map<string, string>();
  let others = 0;
  for (const turn of turns) {
    if (colors.has(turn.speaker)) continue;
    const isMe =
      turn.speaker === "Me" ||
      (meName !== "" && turn.speaker.toLowerCase() === meName.toLowerCase());
    colors.set(
      turn.speaker,
      isMe
        ? ME_SPEAKER_COLOR
        : OTHER_SPEAKER_COLORS[others++ % OTHER_SPEAKER_COLORS.length],
    );
  }
  return colors;
}

export function NoteViewer({
  meeting,
  onMeetingUpdated,
  onTogglePin,
  onToggleLock,
  onDelete,
  isTranscribing,
  isQueued,
  onDiscarded,
}: NoteViewerProps) {
  const [templateNames, setTemplateNames] = useState<string[]>([
    "general",
    "one-on-one",
    "client-meeting",
    "brainstorm",
  ]);
  const [activeTab, setActiveTab] = useState<Tab>("summary");
  // The user's own transcript label (relabel maps mic turns to this name) —
  // used to pin their turns to the "Me" blue in the speaker colors.
  const [meName, setMeName] = useState("");
  useEffect(() => {
    getConfig()
      .then((c) => setMeName(c.user_name || ""))
      .catch(() => {});
  }, []);
  const [template, setTemplate] = useState<string>(meeting.template_used);
  const [language, setLanguage] = useState<SummaryLanguage>("en");
  const [resummarizing, setResummarizing] = useState(false);
  const [resummarizeError, setResummarizeError] = useState<string | null>(null);

  // A "pending" meeting is one saved when transcription couldn't run (ML
  // service down at stop time): the audio is kept on disk and there's no
  // transcript yet. It can be transcribed later with the button below.
  const isPending = !!meeting.audio_file_path && !meeting.transcript;
  const isCleanupPending = !!meeting.audio_file_path && !!meeting.transcript;
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const handleCleanupRetry = async () => {
    setCleaningUp(true);
    setCleanupError(null);
    try {
      onMeetingUpdated(await retryRecordingCleanup(meeting.id));
    } catch (error) {
      setCleanupError(String(error));
    } finally {
      setCleaningUp(false);
    }
  };

  // Retroactive "merge speakers" cleanup for over-counted diarization.
  // Two-click confirm (no modal — window.confirm misbehaves in the webview).
  const [mergeArmed, setMergeArmed] = useState(false);
  const [mergingSpeakers, setMergingSpeakers] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Insights tab — lazy-fetched meeting statistics.
  const [stats, setStats] = useState<MeetingStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== "insights" || stats !== null) return;
    getMeetingStats(meeting.id)
      .then(setStats)
      .catch((e) => setStatsError(String(e)));
  }, [activeTab, meeting.id, stats]);

  // Reset stats when the meeting changes (the component is keyed by meeting id,
  // so this is largely redundant, but kept for safety).
  useEffect(() => {
    setStats(null);
    setStatsError(null);
  }, [meeting.id]);

  const handleTranscribe = async () => {
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const updated = await transcribeMeeting(meeting.id);
      if (updated === null) {
        onDiscarded?.();
        return;
      }
      onMeetingUpdated(updated);
      setActiveTab("summary");
    } catch (e) {
      setTranscribeError(String(e));
    } finally {
      setTranscribing(false);
    }
  };

  // Editable attendee list (local source of truth; persisted in the background).
  const [attendees, setAttendees] = useState<string[]>(
    withoutSpeakerLabels(meeting.attendees ?? []),
  );
  const [newAttendee, setNewAttendee] = useState("");
  const [attendeesError, setAttendeesError] = useState<string | null>(null);

  // Copy / export feedback (transient).
  const [copied, setCopied] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Action items from the DB (authority for done-state).
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);

  // Re-sync when the meeting's attendees change underneath us (e.g. after a
  // re-summarize regenerates them); the component isn't remounted because the
  // meeting id is unchanged.
  useEffect(() => {
    listTemplates()
      .then((ts) => setTemplateNames(ts.map((t) => t.name)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setAttendees(withoutSpeakerLabels(meeting.attendees ?? []));
  }, [meeting.attendees]);

  // Load action items for this meeting from the DB.
  useEffect(() => {
    getActionItems(meeting.id)
      .then(setActionItems)
      .catch(() => setActionItems([]));
  }, [meeting.id]);

  // Editable user notes (local source of truth; saved on blur or button press).
  const [userNotes, setUserNotes] = useState<string>(meeting.user_notes ?? "");
  const [notesSaved, setNotesSaved] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);

  // "Add to dictionary" — append a name/term to the custom-vocabulary setting so
  // future transcriptions spell it correctly.
  const [dictTerm, setDictTerm] = useState("");
  const [dictMsg, setDictMsg] = useState<string | null>(null);

  // Source link (e.g. the YouTube URL of a watched video) — paste once, open
  // any time. Opens in the default browser via the shell plugin.
  const [editingLink, setEditingLink] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  const saveLink = async (raw: string) => {
    setEditingLink(false);
    let value = raw.trim();
    if (value && !/^https?:\/\//i.test(value)) value = `https://${value}`;
    if (value === (meeting.link ?? "")) return;
    setLinkError(null);
    try {
      await updateMeetingLink(meeting.id, value);
      onMeetingUpdated({ ...meeting, link: value });
    } catch (e) {
      setLinkError(String(e));
    }
  };

  const openLink = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(meeting.link);
    } catch (e) {
      setLinkError(String(e));
    }
  };

  // Tag-add popup open/close state (presentation only).
  const [tagPopupOpen, setTagPopupOpen] = useState(false);
  const [tagLabel, setTagLabel] = useState("");
  const [tagColor, setTagColor] = useState<Tag["color"]>("blue");

  const addTag = async () => {
    const label = tagLabel.trim();
    if (!label) return;
    const newTags = [...(meeting.tags ?? []), { label, color: tagColor }];
    await updateMeetingTags(meeting.id, newTags);
    onMeetingUpdated({ ...meeting, tags: newTags });
    setTagLabel("");
    setTagColor("blue");
    setTagPopupOpen(false);
  };

  const removeTag = async (index: number) => {
    const newTags = (meeting.tags ?? []).filter((_, i) => i !== index);
    await updateMeetingTags(meeting.id, newTags);
    onMeetingUpdated({ ...meeting, tags: newTags });
  };

  const handleAddToDictionary = async () => {
    const term = dictTerm.trim();
    if (!term) return;
    setDictMsg(null);
    try {
      const cfg = await getConfig();
      const existing = (cfg.custom_vocabulary ?? "")
        .split(/[,\n]/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (existing.some((t) => t.toLowerCase() === term.toLowerCase())) {
        setDictMsg("Already in dictionary");
        setDictTerm("");
        setTimeout(() => setDictMsg(null), 2000);
        return;
      }
      const next = [...existing, term].join(", ");
      await updateConfig({ ...cfg, custom_vocabulary: next });
      setDictTerm("");
      setDictMsg("Added to dictionary");
      setTimeout(() => setDictMsg(null), 2000);
    } catch (e) {
      setDictMsg(String(e));
    }
  };

  const handleToggleActionItem = async (id: number, done: boolean) => {
    try {
      await setActionItemDone(id, done);
      const items = await getActionItems(meeting.id);
      setActionItems(items);
    } catch {
      // non-critical; checkbox will revert on next load
    }
  };

  useEffect(() => {
    setUserNotes(meeting.user_notes ?? "");
  }, [meeting.user_notes]);

  // Editable summary (raw markdown). Reset when the meeting's summary changes
  // (e.g. after a re-summarize) — the component isn't remounted for the same id.
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState<string>(meeting.summary);
  const [savingSummary, setSavingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    setSummaryDraft(meeting.summary);
    setEditingSummary(false);
  }, [meeting.summary]);

  const handleSaveSummary = async () => {
    setSavingSummary(true);
    setSummaryError(null);
    try {
      await updateMeetingSummary(meeting.id, summaryDraft);
      setEditingSummary(false);
      onMeetingUpdated({ ...meeting, summary: summaryDraft });
      // Re-sync action items from the edited summary.
      const items = await getActionItems(meeting.id);
      setActionItems(items);
    } catch (e) {
      setSummaryError(String(e));
    } finally {
      setSavingSummary(false);
    }
  };

  // A standalone note keeps its "Note" tag; before structuring it has no
  // transcript (the body lives in the summary). Show "Structure with AI" for it.
  const isNote =
    meeting.template_used === "note" ||
    (meeting.tags ?? []).some((t) => t.label === "Note");
  const [structuring, setStructuring] = useState(false);

  const handleStructure = async () => {
    setStructuring(true);
    setResummarizeError(null);
    try {
      const updated = await structureNote(meeting.id, template);
      onMeetingUpdated(updated);
      setActionItems(await getActionItems(meeting.id));
      setActiveTab("summary");
    } catch (e) {
      setResummarizeError(String(e));
    } finally {
      setStructuring(false);
    }
  };

  const handleResummarize = async () => {
    setResummarizing(true);
    setResummarizeError(null);
    try {
      const updated = await resummarizeMeeting(meeting.id, template, language);
      onMeetingUpdated(updated);
      // Resummarize deletes + reinserts action items (new row ids) — reload
      // them or the summary checkboxes keep toggling the old, dead rows.
      setActionItems(await getActionItems(meeting.id));
      setActiveTab("summary");
    } catch (e) {
      setResummarizeError(String(e));
    } finally {
      setResummarizing(false);
    }
  };

  // Diarizer-invented labels present? (Real names / Me / Them don't count.)
  const hasDiarizedSpeakers =
    (meeting.transcript_turns ?? []).some((t) => /^speaker \d+$/i.test(t.speaker)) ||
    /^speaker \d+: /im.test(meeting.transcript ?? "");

  const handleMergeSpeakers = async () => {
    if (!mergeArmed) {
      setMergeArmed(true);
      window.setTimeout(() => setMergeArmed(false), 5000); // disarm quietly
      return;
    }
    setMergeArmed(false);
    setMergingSpeakers(true);
    setMergeError(null);
    try {
      const updated = await mergeMeetingSpeakers(meeting.id);
      onMeetingUpdated(updated);
    } catch (e) {
      setMergeError(String(e));
    } finally {
      setMergingSpeakers(false);
    }
  };

  const persistAttendees = async (next: string[]) => {
    const previous = attendees;
    setAttendees(next); // optimistic
    setAttendeesError(null);
    try {
      await updateAttendees(meeting.id, next);
    } catch (e) {
      setAttendees(previous); // revert on failure
      setAttendeesError(String(e));
    }
  };

  const handleRemoveAttendee = (name: string) => {
    persistAttendees(attendees.filter((a) => a !== name));
  };

  const handleAddAttendee = () => {
    const name = newAttendee.trim();
    if (!name || attendees.includes(name)) {
      setNewAttendee("");
      return;
    }
    setNewAttendee("");
    persistAttendees([...attendees, name]);
  };

  const handleCopy = async () => {
    const text = summaryToPlainText(meeting.summary);
    const flashCopied = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    try {
      // Rich paste (Word/Gmail/Notion) via HTML, with a clean plain-text
      // fallback for plain targets — never the raw markdown.
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const html = summaryToHtml(meeting.summary);
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      flashCopied();
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        flashCopied();
      } catch {
        setExportMsg("Copy failed — clipboard unavailable.");
      }
    }
  };

  const handleSaveNotes = async () => {
    setNotesError(null);
    try {
      await updateMeetingNotes(meeting.id, userNotes);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 1500);
    } catch (e) {
      setNotesError(String(e));
    }
  };

  const handleExport = async () => {
    const safeName =
      meeting.title
        .replace(/[^\w\d\- ]+/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 60) || "meeting-notes";
    const date = formatDateTime(meeting.recorded_at);
    const minutes = Math.round(meeting.duration_seconds / 60);
    const contents = `# ${meeting.title}\n\n_${date} · ${minutes} min_\n\n${meeting.summary}\n`;
    try {
      const path = await exportSummary(`${safeName}.md`, contents);
      if (path) {
        setExportMsg(`Saved to ${path}`);
        setTimeout(() => setExportMsg(null), 4000);
      }
    } catch (e) {
      setExportMsg(String(e));
    }
  };

  // Export the meeting as a self-contained dark "Meeting Minutes" slide (.html).
  // Opens in any browser; can be turned into a PDF from there (Cmd/Ctrl+P).
  const handleExportSlide = async () => {
    try {
      const path = await exportHtml(
        `${exportFileBase(meeting)}.html`,
        buildSlideHtml(meeting),
      );
      if (path) {
        setExportMsg(`Saved to ${path}`);
        setTimeout(() => setExportMsg(null), 4000);
      }
    } catch (e) {
      setExportMsg(String(e));
    }
  };

  const handleExportBundle = async () => {
    try {
      const path = await exportMeetingBundle(meeting.id);
      if (path) {
        setExportMsg(`Saved to ${path}`);
        setTimeout(() => setExportMsg(null), 4000);
      }
    } catch (e) {
      setExportMsg(String(e));
    }
  };

  return (
    <div className="viewer-layout">
      {/* Note Header */}
      <div className="viewer-header">
        <div className="viewer-meta-row">
          <span>{formatDateTime(meeting.recorded_at)}</span>
          <span style={{ color: "var(--text-muted)" }} aria-hidden="true">
            •
          </span>
          <span>{Math.round(meeting.duration_seconds / 60)} minutes</span>
          <span style={{ color: "var(--text-muted)" }} aria-hidden="true">
            •
          </span>
          <span className="badge-tag blue">{meeting.template_used}</span>
        </div>

        <div className="viewer-title-row">
          <h1
            className="viewer-title"
            dir={isRtl(meeting.title) ? "rtl" : "ltr"}
          >
            {cleanMeetingTitle(meeting.title)}
          </h1>

          {/* Glassmorphic toolbar pill */}
          <div className="glass-toolbar">
            <button
              className={`toolbar-btn${meeting.pinned ? " active" : ""}`}
              title="Pin note"
              aria-label="Pin note"
              onClick={() => onTogglePin?.(meeting)}
            >
              <Pin aria-hidden="true" />
            </button>
            <div className="toolbar-separator"></div>
            <button
              className={`toolbar-btn${meeting.locked ? " active" : ""}`}
              title="Lock with privacy PIN"
              aria-label="Lock with privacy PIN"
              onClick={() => onToggleLock?.(meeting)}
            >
              <Lock aria-hidden="true" />
            </button>
            <div className="toolbar-separator"></div>
            <button
              className="toolbar-btn delete"
              title="Delete note"
              aria-label="Delete note"
              onClick={() => onDelete?.(meeting)}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Tags & Addition Row */}
        <div className="detail-tags-container">
          <div className="detail-tags-list">
            {(meeting.tags ?? []).map((tag, index) => (
              <span key={index} className={`detail-tag-badge ${tag.color}`}>
                {tag.label}
                <button
                  type="button"
                  className="tag-badge-remove"
                  aria-label={`Remove ${tag.label} tag`}
                  title="Remove tag"
                  onClick={() => removeTag(index)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div style={{ position: "relative" }}>
            <button
              className="btn-add-tag-pill"
              onClick={() => setTagPopupOpen((v) => !v)}
            >
              + Add Tag
            </button>
            {/* Popup menu to add tag */}
            {tagPopupOpen && (
              <div className="tag-add-popup">
                <input
                  type="text"
                  className="tag-popup-input"
                  placeholder="Tag label…"
                  aria-label="Tag label"
                  autoFocus
                  value={tagLabel}
                  onChange={(e) => setTagLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addTag();
                    if (e.key === "Escape") setTagPopupOpen(false);
                  }}
                />
                <div className="tag-color-dots">
                  {(["blue", "purple", "orange", "green", "red"] as const).map(
                    (c) => (
                      <span
                        key={c}
                        role="button"
                        aria-label={`${c} tag color`}
                        className={`color-dot ${c}${tagColor === c ? " selected" : ""}`}
                        data-color={c}
                        onClick={() => setTagColor(c)}
                      />
                    ),
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    className="btn-popup-action cancel"
                    onClick={() => setTagPopupOpen(false)}
                  >
                    Cancel
                  </button>
                  <button className="btn-popup-action confirm" onClick={addTag}>
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Attendee tags list */}
        <div className="viewer-attendees" style={{ marginTop: 10 }}>
          {attendees.map((name) => (
            <span key={name} className="attendee-badge">
              {name}
              <button
                onClick={() => handleRemoveAttendee(name)}
                aria-label={`Remove ${name}`}
                title={`Remove ${name}`}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="add-attendee-input"
            value={newAttendee}
            onChange={(e) => setNewAttendee(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddAttendee();
            }}
            onBlur={handleAddAttendee}
            placeholder="+ Add attendee"
            aria-label="Add attendee"
          />
        </div>
        {attendeesError && (
          <p style={{ marginTop: 6, fontSize: 12, color: "var(--accent-red)" }}>
            {attendeesError}
          </p>
        )}
        {resummarizeError && (
          <p style={{ marginTop: 6, fontSize: 12, color: "var(--accent-red)" }}>
            {resummarizeError}
          </p>
        )}

        {/* Source-link row: shown for watched videos / external content. */}
        <div className="viewer-attendees" style={{ marginTop: 10 }}>
          {meeting.link ? (
            <>
              <button
                onClick={openLink}
                title={meeting.link}
                style={{
                  fontSize: 12,
                  color: "var(--accent-blue)",
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                🔗 {meeting.link.replace(/^https?:\/\/(www\.)?/i, "").slice(0, 60)}
              </button>
              <button
                onClick={() => saveLink("")}
                aria-label="Remove link"
                title="Remove link"
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </>
          ) : editingLink ? (
            <input
              className="add-attendee-input"
              autoFocus
              value={linkDraft}
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveLink(linkDraft);
                if (e.key === "Escape") setEditingLink(false);
              }}
              onBlur={() => saveLink(linkDraft)}
              placeholder="Paste the source URL (e.g. the YouTube link)…"
              aria-label="Source link"
              style={{ minWidth: 280 }}
            />
          ) : (
            <button
              className="add-attendee-input"
              onClick={() => {
                setLinkDraft("");
                setEditingLink(true);
              }}
              style={{ cursor: "pointer", textAlign: "left" }}
            >
              + Add link
            </button>
          )}
          {linkError && (
            <span style={{ fontSize: 12, color: "var(--accent-red)" }}>{linkError}</span>
          )}
        </div>

        {/* Add-to-dictionary row */}
        <div className="viewer-attendees" style={{ marginTop: 10 }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            Add to dictionary:
          </span>
          <input
            className="add-attendee-input"
            value={dictTerm}
            onChange={(e) => setDictTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddToDictionary();
            }}
            placeholder="name or term"
            aria-label="Add a term to the transcription dictionary"
          />
          <button
            className="btn-add-tag-pill"
            onClick={handleAddToDictionary}
            disabled={!dictTerm.trim()}
          >
            + Add
          </button>
          {dictMsg && (
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {dictMsg}
            </span>
          )}
        </div>
      </div>

      {/* Note Tabs Bar */}
      <div className="viewer-tabs-row">
        <div className="viewer-tabs">
          <button
            className={`tab-link${activeTab === "summary" ? " active" : ""}`}
            onClick={() => setActiveTab("summary")}
          >
            Summary
          </button>
          <button
            className={`tab-link${activeTab === "transcript" ? " active" : ""}`}
            onClick={() => setActiveTab("transcript")}
          >
            Transcript
          </button>
          <button
            className={`tab-link${activeTab === "insights" ? " active" : ""}`}
            onClick={() => setActiveTab("insights")}
          >
            Insights
            <span className="badge-tag orange" style={{ marginLeft: 6 }}>
              Beta
            </span>
          </button>
          <button
            className={`tab-link${activeTab === "chat" ? " active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat with Meeting
          </button>
          <button
            className={`tab-link${activeTab === "notes" ? " active" : ""}`}
            onClick={() => setActiveTab("notes")}
          >
            Personal Notes
          </button>
        </div>

        <div className="tab-actions">
          <select
            className="select-dropdown"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            disabled={resummarizing}
            aria-label="Summary template"
          >
            {templateNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="select-dropdown"
            value={language}
            onChange={(e) => setLanguage(e.target.value as SummaryLanguage)}
            disabled={resummarizing}
            aria-label="Summary language"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {isNote && (
            <button
              className="btn-primary"
              style={{ height: 28, fontSize: 11, padding: "0 10px" }}
              onClick={handleStructure}
              disabled={structuring || resummarizing}
              title="Turn this note into organized notes + action items (flows into To-dos, the graph, and Ask)."
            >
              {structuring ? "Structuring…" : "✨ Structure with AI"}
            </button>
          )}
          <button
            className="btn-secondary"
            style={{ height: 28, fontSize: 11, padding: "0 10px" }}
            onClick={handleResummarize}
            disabled={resummarizing}
          >
            {resummarizing ? "Re-summarizing..." : "Regenerate Notes"}
          </button>
        </div>
      </div>

      {/* Note Tab Contents */}
      <div className="viewer-body">
        {isCleanupPending && (
          <div className="recording-cleanup-banner" role="status">
            <h3>Recording cleanup needs attention</h3>
            <p>
              Your transcript and notes are safe. The encrypted recovery copy
              could not be deleted, so Adversaria retained it and will retry on
              the next launch.
            </p>
            <button
              className="btn-primary"
              onClick={handleCleanupRetry}
              disabled={cleaningUp}
            >
              {cleaningUp ? "Retrying cleanup…" : "Delete encrypted recovery copy"}
            </button>
            {cleanupError && <p className="settings-msg err">{cleanupError}</p>}
          </div>
        )}
        {/* Pending-transcription banner — shown when a recording was saved but
            not transcribed (the ML service was unreachable at stop time). */}
        {isPending && (isTranscribing || isQueued) ? (
          // In the background queue: it'll fill in automatically — no button, so
          // the user can't kick off a second, concurrent transcription.
          <div
            style={{
              border: "1px solid var(--accent-blue, #3d7fd9)",
              background: "color-mix(in srgb, var(--accent-blue, #3d7fd9) 12%, transparent)",
              borderRadius: 10,
              padding: 16,
              marginBottom: 16,
            }}
          >
            <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>
              {isTranscribing ? "Transcribing…" : "Queued for transcription"}
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
              {isTranscribing
                ? "This recording is being transcribed in the background. The notes will appear here automatically when it's done — you can keep recording or working in the meantime."
                : "This recording is waiting in the transcription queue (it runs once the current one finishes). The notes will appear here automatically."}
            </p>
          </div>
        ) : isPending ? (
          <div
            style={{
              border: "1px solid var(--accent-orange, #d98a3d)",
              background: "color-mix(in srgb, var(--accent-orange, #d98a3d) 12%, transparent)",
              borderRadius: 10,
              padding: 16,
              marginBottom: 16,
            }}
          >
            <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>
              Not transcribed yet
            </h3>
            <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-secondary)" }}>
              This recording was saved but couldn't be transcribed — the AI
              service was unreachable when you stopped. Your audio is kept on
              this device until you transcribe it; press the button below once
              the service is running.
            </p>
            <button
              className="btn-primary"
              onClick={handleTranscribe}
              disabled={transcribing}
            >
              {transcribing ? "Transcribing…" : "Transcribe now"}
            </button>
            {transcribeError && (
              <p style={{ marginTop: 10, fontSize: 12, color: "var(--accent-red)" }}>
                {transcribeError}
              </p>
            )}
          </div>
        ) : null}

        {/* TAB: Summary Content */}
        {activeTab === "summary" && (
          <div className="tab-content active" id="tab-content-summary">
            {/* Summary toolbar */}
            <div className="tab-actions" style={{ justifyContent: "flex-end", marginBottom: 12 }}>
              {(summaryError || exportMsg) && (
                <span style={{ marginRight: "auto", fontSize: 12 }}>
                  {summaryError ? (
                    <span style={{ color: "var(--accent-red)" }}>
                      {summaryError}
                    </span>
                  ) : (
                    <span style={{ color: "var(--text-secondary)" }}>
                      {exportMsg}
                    </span>
                  )}
                </span>
              )}
              {editingSummary ? (
                <>
                  <button
                    className="btn-secondary"
                    style={{ height: 28, fontSize: 11, padding: "0 10px" }}
                    onClick={() => {
                      setSummaryDraft(meeting.summary);
                      setEditingSummary(false);
                      setSummaryError(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    style={{ height: 28, fontSize: 11, padding: "0 10px" }}
                    onClick={handleSaveSummary}
                    disabled={savingSummary}
                  >
                    {savingSummary ? "Saving…" : "Save"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn-secondary"
                    style={{ height: 28, fontSize: 11, padding: "0 10px" }}
                    onClick={() => setEditingSummary(true)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ height: 28, fontSize: 11, padding: "0 10px" }}
                    onClick={handleCopy}
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                  <div style={{ position: "relative" }}>
                    <button
                      className="btn-secondary"
                      style={{ height: 28, fontSize: 11, padding: "0 10px" }}
                      onClick={() => setExportMenuOpen((o) => !o)}
                      aria-haspopup="menu"
                      aria-expanded={exportMenuOpen}
                    >
                      Export ▾
                    </button>
                    {exportMenuOpen && (
                      <>
                        {/* click-away overlay */}
                        <div
                          style={{ position: "fixed", inset: 0, zIndex: 20 }}
                          onClick={() => setExportMenuOpen(false)}
                        />
                        <div
                          className="tag-add-popup"
                          style={{
                            left: "auto",
                            right: 0,
                            top: "calc(100% + 4px)",
                            zIndex: 30,
                            minWidth: 180,
                          }}
                          role="menu"
                        >
                          <button
                            className="settings-menu-item"
                            role="menuitem"
                            onClick={() => {
                              setExportMenuOpen(false);
                              handleExportSlide();
                            }}
                          >
                            <Presentation size={15} aria-hidden="true" />
                            Export as Slide…
                          </button>
                          <button
                            className="settings-menu-item"
                            role="menuitem"
                            onClick={() => {
                              setExportMenuOpen(false);
                              handleExport();
                            }}
                          >
                            <Download size={15} aria-hidden="true" />
                            Export Markdown…
                          </button>
                          <button
                            className="settings-menu-item"
                            role="menuitem"
                            title="Plaintext file — anyone who can read it can read your notes."
                            onClick={() => {
                              setExportMenuOpen(false);
                              handleExportBundle();
                            }}
                          >
                            <FileJson size={15} aria-hidden="true" />
                            Export bundle (.json)…
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            {editingSummary ? (
              <>
                <textarea
                  className="notes-textarea"
                  value={summaryDraft}
                  onChange={(e) => setSummaryDraft(e.target.value)}
                  dir="auto"
                  style={{ fontFamily: "var(--font-mono, monospace)", minHeight: "60vh" }}
                />
                <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Editing the raw summary (Markdown). Use this to merge names that
                  were picked up as separate people, or fix any other detail.
                </p>
              </>
            ) : (
              <SummaryView
                summary={meeting.summary}
                actionItems={actionItems}
                onToggleActionItem={handleToggleActionItem}
              />
            )}
          </div>
        )}

        {/* TAB: Transcript Content */}
        {activeTab === "transcript" && (
          <div className="tab-content active" id="tab-content-transcript">
            {hasDiarizedSpeakers && (
              <div
                className="tab-actions"
                style={{ justifyContent: "flex-end", marginBottom: 12, gap: 8 }}
              >
                {mergeError && (
                  <span style={{ marginRight: "auto", fontSize: 12, color: "var(--accent-red)" }}>
                    {mergeError}
                  </span>
                )}
                <button
                  className="btn-ghost"
                  onClick={handleMergeSpeakers}
                  disabled={mergingSpeakers}
                  title='Replace every diarized "Speaker N" label with "Them". Use when the speaker count is wrong — this cannot be undone (the audio was deleted after transcription).'
                >
                  {mergingSpeakers
                    ? "Merging…"
                    : mergeArmed
                      ? "Click again to confirm — can't be undone"
                      : "Merge speakers into “Them”"}
                </button>
              </div>
            )}
            {meeting.transcript_turns && meeting.transcript_turns.length > 0 ? (
              <div id="transcript-container" className="transcript-plain">
                {(() => {
                  const speakerColors = speakerColorMap(meeting.transcript_turns, meName);
                  return meeting.transcript_turns.map((turn, i) => (
                    <p key={i} className="transcript-line" dir="auto">
                      {turn.start != null && (
                        <span className="transcript-time">[{formatTurnTime(turn.start)}]</span>
                      )}
                      <span
                        className="transcript-speaker"
                        style={{ color: speakerColors.get(turn.speaker) }}
                      >
                        {turn.speaker}
                      </span>
                      {turn.text}
                    </p>
                  ));
                })()}
              </div>
            ) : (
              <p
                dir="auto"
                style={{ color: "var(--text-muted)", fontStyle: "italic" }}
              >
                {meeting.transcript || "No transcript available for this note."}
              </p>
            )}
          </div>
        )}

        {/* TAB: Insights */}
        {activeTab === "insights" && (
          <div className="tab-content active" id="tab-content-insights">
            {statsError != null ? (
              <p style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                {statsError}
              </p>
            ) : stats == null ? (
              <p style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                Computing insights…
              </p>
            ) : stats.speakers.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                No transcript to analyze yet.
              </p>
            ) : (
              <InsightsContent stats={stats} />
            )}
          </div>
        )}

        {/* TAB: Chat Inside Meeting */}
        {activeTab === "chat" && (
          <div className="tab-content active" id="tab-content-chat">
            <MeetingChat meetingId={meeting.id} />
          </div>
        )}

        {/* TAB: Personal Notes Editable */}
        {activeTab === "notes" && (
          <div className="tab-content active" id="tab-content-notes">
            <textarea
              className="notes-textarea"
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              onBlur={handleSaveNotes}
              dir="auto"
              placeholder="Jot down notes or thoughts regarding this meeting here. Saves automatically on blur..."
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span
                style={{ fontSize: 12, color: "var(--text-secondary)" }}
              >
                {notesError ? (
                  <span style={{ color: "var(--accent-red)" }}>
                    {notesError}
                  </span>
                ) : notesSaved ? (
                  "Saved"
                ) : (
                  "Saved locally"
                )}
              </span>
              <button
                className="btn-secondary"
                style={{ height: 28, fontSize: 11, padding: "0 10px", flex: "0 0 auto" }}
                onClick={handleSaveNotes}
              >
                Save Now
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8 }}>
              Tip: edit your notes, then "Regenerate Notes" to fold them back into
              the summary.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

interface InsightsContentProps {
  stats: MeetingStats;
}

function InsightsContent({ stats }: InsightsContentProps) {
  const owner =
    stats.owner != null
      ? stats.speakers.find((sp) => sp.name === stats.owner) ?? null
      : null;
  const others = stats.speakers.filter((sp) => sp.name !== stats.owner);
  const othersPct = others.reduce((acc, sp) => acc + sp.talk_pct, 0);
  const othersSeconds = others.reduce(
    (acc, sp) => acc + (sp.talk_seconds ?? 0),
    0
  );
  const othersWords = others.reduce((acc, sp) => acc + sp.words, 0);

  return (
    <div className="insights-wrap">
      <p className="insights-note">
        Beta — numbers are approximate (echo and diarization limits; headphones
        improve accuracy). Focused on your own delivery; other voices stay
        anonymous.
      </p>
      {!stats.has_timing && (
        <p className="insights-note">
          This meeting predates precise turn timing — shares are word-based;
          pace and interruptions need a new recording.
        </p>
      )}

      {/* Talk balance: you vs everyone else */}
      <div>
        <div className="insights-section-cap">Talk balance</div>
        {owner != null ? (
          <>
            <div className="insights-row">
              <span className="insights-row-name">You</span>
              <div className="insights-bar">
                <div
                  className="insights-bar-fill insights-bar-fill--owner"
                  style={{ width: `${owner.talk_pct}%` }}
                />
              </div>
              <span className="insights-row-value">
                {owner.talk_pct.toFixed(0)}%
                {stats.has_timing
                  ? ` · ${formatTurnTime(owner.talk_seconds ?? 0)}`
                  : ` · ${owner.words} words`}
              </span>
            </div>
            {others.length > 0 && (
              <div className="insights-row">
                <span className="insights-row-name">Everyone else</span>
                <div className="insights-bar">
                  <div
                    className="insights-bar-fill"
                    style={{ width: `${othersPct}%` }}
                  />
                </div>
                <span className="insights-row-value">
                  {othersPct.toFixed(0)}%
                  {stats.has_timing
                    ? ` · ${formatTurnTime(othersSeconds)}`
                    : ` · ${othersWords} words`}
                </span>
              </div>
            )}
          </>
        ) : (
          stats.speakers.map((sp) => (
            <div key={sp.name} className="insights-row">
              <span className="insights-row-name" title={sp.name}>
                {sp.name}
              </span>
              <div className="insights-bar">
                <div
                  className="insights-bar-fill"
                  style={{ width: `${sp.talk_pct}%` }}
                />
              </div>
              <span className="insights-row-value">
                {sp.talk_pct.toFixed(0)}%
                {stats.has_timing
                  ? ` · ${formatTurnTime(sp.talk_seconds ?? 0)}`
                  : ` · ${sp.words} words`}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Your delivery — owner only */}
      {owner != null ? (
        <div>
          <div className="insights-section-cap">Your delivery</div>
          <div className="insights-grid">
            <div className="insights-card insights-card--owner">
              <div className="insights-card-name">Pace</div>
              <div className="insights-metric">
                <span className="insights-metric-value">
                  {owner.wpm == null ? "—" : `${Math.round(owner.wpm)} wpm`}
                  {owner.wpm != null && owner.wpm >= 130 && owner.wpm <= 175 ? (
                    <span className="badge-tag green">on target</span>
                  ) : owner.wpm != null && owner.wpm > 175 ? (
                    <span className="badge-tag orange">fast</span>
                  ) : owner.wpm != null ? (
                    <span className="badge-tag orange">slow</span>
                  ) : null}
                </span>
              </div>
            </div>

            <div className="insights-card insights-card--owner">
              <div className="insights-card-name">Filler words</div>
              <div className="insights-metric">
                <span className="insights-metric-value">
                  {owner.fillers} ({(owner.filler_rate * 100).toFixed(1)}%)
                  {owner.filler_rate > 0.04 && owner.words > 50 && (
                    <span className="badge-tag orange">high</span>
                  )}
                </span>
              </div>
            </div>

            <div className="insights-card insights-card--owner">
              <div className="insights-card-name">Longest monologue</div>
              <div className="insights-metric">
                <span className="insights-metric-value">
                  {stats.has_timing
                    ? formatTurnTime(owner.longest_monologue_seconds ?? 0)
                    : `${owner.longest_monologue_words} words`}
                </span>
              </div>
            </div>

            <div className="insights-card insights-card--owner">
              <div className="insights-card-name">Interruptions</div>
              <div className="insights-metric">
                <span className="insights-metric-value">
                  {stats.has_timing ? owner.interruptions : "—"}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <p className="insights-note">
          Couldn't identify your channel in this meeting — delivery coaching
          appears when a recording includes your mic track.
        </p>
      )}

      <p className="insights-note">
        Computed on-device from the transcript — nothing leaves your machine.
      </p>
    </div>
  );
}

export function NoteViewerEmpty() {
  return (
    <div className="empty-view">
      <h2 className="empty-title">Adversaria</h2>
      <p className="empty-desc">
        Select an item from the sidebar, or click the Record button to begin
        transcribing. Privacy first.
      </p>
    </div>
  );
}
