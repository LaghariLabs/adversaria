import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { RecordingStatus } from "../hooks/useRecording";
import {
  copilotFolderReadiness,
  copilotGetMode,
  copilotSetMicQuestions,
  copilotHudIsOpen,
  getConfig,
  toggleCopilotHud,
  copilotSetMode,
  getAudioLevel,
  getFolderCopilotBrief,
  hasCopilotApiKey,
  hasDeepSeekCopilotApiKey,
  pickContextFile,
  setFolderCopilotMode,
  setFolderCopilotWeb,
} from "../lib/tauri";
import type { AttachmentDraft, CopilotCard, CopilotFolderReadiness, CopilotMode, FolderSummary, LiveState } from "../types";
import { LastTimeBrief } from "./LastTimeBrief";
import { CopilotConsentBar, CONSENT_LINES } from "./CopilotConsentBar";
import "../styles/live-copilot.css";
import { CopilotAnswerStrip } from "./CopilotAnswerStrip";
import { COPY } from "../lib/platform";

const CopilotCards = lazy(() =>
  import("./CopilotCards").then((m) => ({ default: m.CopilotCards })),
);
const LiveReviewPanels = lazy(() =>
  import("./LiveReviewPanels").then((m) => ({ default: m.LiveReviewPanels })),
);
const NotesEditor = lazy(() => import("./NotesEditor"));

interface RecordingCompanionProps {
  variant: string;
  value: string;
  onChange: (v: string) => void;
  status: RecordingStatus;
  liveLines: { text: string; source: string }[];
  livePartials?: { me: string; them: string };
  attachments: AttachmentDraft[];
  onAddAttachment: (attachment: AttachmentDraft) => void;
  onRemoveAttachment: (index: number) => void;
  recentMeetings: { id: number; title: string }[];
  onStop: () => void;
  onBrowse: () => void;
  folders: FolderSummary[];
  recordingFolderId: number | null;
  onChangeRecordingFolder: (id: number | null) => void;
  copilotCards: CopilotCard[];
  onForceCard: (useMeFallback: boolean) => void;
  onCancel?: (cardId: number) => void;
  onRetry?: (cardId: number) => void;
  onNotice?: (msg: string) => void;
  copilotSessionId?: string | null;
  isRecordingActive?: boolean;
  liveState?: LiveState | null;
  onLiveStateChange?: (s: LiveState) => void;
}

const BAR_COUNT = 7;

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function RecordingCompanion({
  variant,
  value,
  onChange,
  status,
  liveLines,
  livePartials = { me: "", them: "" },
  attachments,
  onAddAttachment,
  onRemoveAttachment,
  recentMeetings,
  onStop,
  onBrowse,
  folders,
  recordingFolderId,
  onChangeRecordingFolder,
  copilotCards,
  onForceCard,
  onCancel,
  onRetry,
  onNotice,
  copilotSessionId,
  isRecordingActive: _isRecordingActive,
  liveState,
  onLiveStateChange,
}: RecordingCompanionProps) {
  const processing = status === "stopping";
  const recording = status === "recording";
  const layout = variant === "transcript" ? "transcript" : "balanced";

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [recording]);

  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  useEffect(() => {
    if (!recording) {
      setBars(Array(BAR_COUNT).fill(0));
      return;
    }
    let smooth = 0;
    const id = setInterval(async () => {
      try {
        const level = await getAudioLevel();
        smooth = smooth * 0.4 + level * 0.6;
        setBars(
          Array.from(
            { length: BAR_COUNT },
            () => smooth * (0.5 + Math.random() * 0.5),
          ),
        );
      } catch {
        /* best-effort */
      }
    }, 70);
    return () => clearInterval(id);
  }, [recording]);

  const [activeTab, setActiveTab] = useState<"notes" | "lasttime" | "copilot">("notes");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetFocusId, setSheetFocusId] = useState<number | null>(null);

  const [copilotMode, setCopilotMode] = useState<CopilotMode>("no_ai");
  const [hasClaudeKey, setHasClaudeKey] = useState(false);
  const [hasDeepSeekKey, setHasDeepSeekKey] = useState(false);
  const [folderWebEnabled, setFolderWebEnabled] = useState(false);
  const [briefFolderName, setBriefFolderName] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<CopilotFolderReadiness | null>(null);

  // Session-scoped folder readiness: subscribe to copilot-folder-ready for current session
  useEffect(() => {
    const sid = copilotSessionId?.trim();
    if (!sid) {
      setReadiness(null);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    try {
      const maybe = listen<CopilotFolderReadiness>("copilot-folder-ready", (event) => {
        const payload = event.payload;
        if (!payload || payload.session_id !== sid) return;
        if (cancelled) return;
        setReadiness(payload);
      });
      // listen returns Promise<unlisten>
      (maybe as Promise<() => void>).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      }).catch(() => {});
    } catch {
      // vitest without tauri runtime
    }
    // copilotFolderReadiness may be undefined when tests mock ../lib/tauri incompletely
    let getter: ((sid: string) => Promise<CopilotFolderReadiness>) | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const maybe = copilotFolderReadiness as unknown as ((sid: string) => Promise<CopilotFolderReadiness>) | undefined;
      getter = maybe;
    } catch {
      getter = undefined;
    }
    if (typeof getter === "function") {
      getter(sid)
        .then((r) => {
          if (cancelled) return;
          if (!r || r.session_id !== sid) return;
          setReadiness(r);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [copilotSessionId]);

  const briefRequestRef = useRef(0);
  useEffect(() => {
    const requestId = ++briefRequestRef.current;
    let cancelled = false;
    hasCopilotApiKey()
      .then((v) => {
        if (!cancelled && requestId === briefRequestRef.current) setHasClaudeKey(v);
      })
      .catch(() => {});
    hasDeepSeekCopilotApiKey()
      .then((v) => {
        if (!cancelled && requestId === briefRequestRef.current) setHasDeepSeekKey(v);
      })
      .catch(() => {});
    copilotGetMode()
      .then((mm) => {
        if (!cancelled && requestId === briefRequestRef.current) setCopilotMode(mm as CopilotMode);
      })
      .catch(() => {});
    if (recordingFolderId != null) {
      getFolderCopilotBrief(recordingFolderId)
        .then((b) => {
          if (cancelled || requestId !== briefRequestRef.current) return;
          if (b.copilot_mode) setCopilotMode(b.copilot_mode as CopilotMode);
          // Persisted web flag is authoritative; reset safely on folder switch
          setFolderWebEnabled(!!b.copilot_web);
          setBriefFolderName(b.folder_name ?? null);
        })
        .catch(() => {
          if (!cancelled && requestId === briefRequestRef.current) {
            // keep prior web state? reset to false to avoid stale true from previous folder
            setFolderWebEnabled(false);
            setBriefFolderName(null);
          }
        });
    } else {
      setFolderWebEnabled(false);
      setBriefFolderName(null);
    }
    return () => {
      cancelled = true;
    };
  }, [recordingFolderId]);

  const handleCopilotModeChange = async (mode: CopilotMode) => {
    const prev = copilotMode;
    setCopilotMode(mode);
    try {
      const effective = await copilotSetMode(mode) as CopilotMode;
      setCopilotMode(effective);
    } catch (e) {
      setCopilotMode(prev);
      onNotice?.(String(e).slice(0, 200));
      return;
    }
    if (recordingFolderId != null) {
      try {
        await setFolderCopilotMode(recordingFolderId, mode);
      } catch (e) {
        onNotice?.(String(e).slice(0, 200));
      }
    }
  };

  const handleWebToggle = async (enabled: boolean) => {
    if (recordingFolderId == null || !copilotSessionId?.trim()) return;
    const prev = folderWebEnabled;
    setFolderWebEnabled(enabled);
    try {
      await setFolderCopilotWeb(recordingFolderId, enabled, copilotSessionId);
    } catch (e) {
      setFolderWebEnabled(prev);
      onNotice?.(String(e).slice(0, 200));
    }
  };

  const lastSeenCopilotIdRef = useRef<number>(0);
  const pendingCopilotCount = copilotCards.filter((c) => c.id > lastSeenCopilotIdRef.current).length;

  useEffect(() => {
    if (activeTab === "copilot" && copilotCards.length > 0) {
      const maxId = Math.max(...copilotCards.map((c) => c.id));
      lastSeenCopilotIdRef.current = maxId;
    }
  }, [activeTab, copilotCards]);

  function domainFromUrl(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
  }

  function handlePin(card: CopilotCard): void {
    const passageLines = card.passages.slice(0, 3).map((p) => `  · ${p.title}`);
    if (card.answer?.sections) {
      const sections = card.answer.sections;
      const sayText = (sections.say ?? []).join(" ");
      const lines: string[] = [];
      lines.push(`Copilot suggestion: ${card.question}`);
      lines.push(`Say: ${sayText}`);
      for (const spec of sections.specifics ?? []) {
        if (spec.trim() !== "") lines.push(`- ${spec}`);
      }
      for (const note of sections.notes ?? []) {
        if (note.quote && note.quote.trim() !== "") {
          const title = typeof note.passage_index === "number" ? (card.passages[note.passage_index]?.title ?? `P${(note.passage_index ?? 0) + 1}`) : "Notes";
          lines.push(`- From your notes: "${note.quote}" (${title}) ${note.clause}`.trim());
        }
      }
      const pinText = lines.join("\n") + "\n" + passageLines.join("\n") + "\n";
      const next = value + (value.endsWith("\n") || value === "" ? "" : "\n") + pinText;
      onChange(next);
      return;
    }
    let bullets: string[] = [];
    if (card.answer?.provenance && card.answer.provenance.length > 0) {
      for (const b of card.answer.provenance.slice(0, 3)) {
        let label = "";
        if (b.label === "notes") label = "[your notes]";
        else if (b.label === "web" && b.url) label = `[web · ${domainFromUrl(b.url)}]`;
        else if (b.label === "web") label = "[web]";
        else if (b.label === "model") {
          label = card.answer?.provider === "local"
            ? "[Local]"
            : card.answer?.provider === "deepseek"
              ? "[DeepSeek]"
              : "[Claude]";
        }
        bullets.push(`- ${b.text} ${label}`.trim());
      }
    } else if (card.answer?.text?.trim()) {
      bullets.push(`- ${card.answer.text.trim().slice(0, 160)} [partial]`);
    }
    const pinText = "Copilot: " + card.question + "\n" + bullets.join("\n") + (bullets.length ? "\n" : "") + passageLines.join("\n") + "\n";
    const next = value + (value.endsWith("\n") || value === "" ? "" : "\n") + pinText;
    onChange(next);
  }

  const [footerFocused, setFooterFocused] = useState(false);
  const footerExpanded = footerFocused || value.length > 0;
  const [meetingListOpen, setMeetingListOpen] = useState(false);
  const [pickingFile, setPickingFile] = useState(false);

  const handlePickFile = async () => {
    setPickingFile(true);
    try {
      const picked = await pickContextFile();
      if (!picked) return;
      const [path, filename] = picked;
      onAddAttachment({ kind: "file", value: path, label: filename });
    } catch (error) {
      console.warn("[recording] context file picker failed:", error);
    } finally {
      setPickingFile(false);
    }
  };

  const feedRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);

  const handleFeedScroll = () => {
    const feed = feedRef.current;
    if (!feed) return;
    const atBottom =
      feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
    stuckRef.current = atBottom;
    setStuck(atBottom);
  };

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed || !stuckRef.current) return;
    feed.scrollTop = feed.scrollHeight;
  }, [liveLines, livePartials]);

  const jumpToLatest = () => {
    const feed = feedRef.current;
    if (!feed) return;
    feed.scrollTop = feed.scrollHeight;
    stuckRef.current = true;
    setStuck(true);
  };

  const lines = liveLines.filter((l) => l.text.trim() !== "");
  const partials = (["them", "me"] as const)
    .filter((s) => livePartials[s].trim() !== "")
    .map((s) => ({ source: s, text: livePartials[s] }));

  const filingName = folders.find((f) => f.folder.id === recordingFolderId)?.folder.name ?? null;
  function folderReadinessLine(): string {
    if (recordingFolderId == null) return "Folder: none";
    const simpleName = briefFolderName ?? filingName ?? String(recordingFolderId);
    const hasSession = !!copilotSessionId?.trim();
    if (!hasSession) return `Folder: ${simpleName}`;
    const folderName =
      (readiness?.folder_id != null
        ? folders.find((f) => f.folder.id === readiness.folder_id)?.folder.name
        : null) ?? briefFolderName ?? filingName ?? String(recordingFolderId);
    if (!readiness || readiness.status === "indexing") {
      return `Folder: ${folderName} \u00b7 indexing\u2026`;
    }
    if (readiness.status === "error") {
      return `Folder: ${folderName} \u00b7 indexing failed: ${readiness.error ?? "unknown"}`;
    }
    return `Folder: ${folderName} \u00b7 ${readiness.count} sources indexed \u00b7 pack ${readiness.pack_projects} projects`;
  }
  const copilotFolderLabel = folderReadinessLine();

  const openCopilot = (cardId?: number) => {
    if (layout === "transcript") {
      setSheetFocusId(cardId ?? null);
      setSheetOpen(true);
    } else {
      setActiveTab("copilot");
      if (cardId != null) {
        // scroll to card after tab switch
        setTimeout(() => {
          const el = document.querySelector(`[data-testid="copilot-card-${cardId}"]`) as HTMLElement | null;
          try { el?.scrollIntoView?.({ block: "nearest" } as any); } catch {}
        }, 50);
      }
    }
  };

  // Escape closes sheet
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  useEffect(() => {
    if (sheetOpen && sheetFocusId != null) {
      setTimeout(() => {
        const el = document.querySelector(`[data-testid="copilot-card-${sheetFocusId}"]`) as HTMLElement | null;
        try { el?.scrollIntoView?.({ block: "nearest" } as any); } catch {}
      }, 100);
    }
  }, [sheetOpen, sheetFocusId]);

  const isCopilotFocus = layout !== "balanced" && (activeTab === "copilot" || sheetOpen);
  function aiLabel(mode: CopilotMode): string {
    if (mode === "no_ai") return "No AI";
    if (mode === "local") return "Local";
    if (mode === "deepseek") return "DeepSeek";
    return "Claude";
  }
  const lcProcessText = `Transcript: local \u00b7 AI: ${aiLabel(copilotMode)} \u00b7 Web ${folderWebEnabled ? "on" : "off"}`;
  const [lcHeadMenuOpen, setLcHeadMenuOpen] = useState(false);
  const [lcHudOpen, setLcHudOpen] = useState(false);
  // The pop-out ships dark in 0.4.0; the menu item only appears once the
  // config flag is on (the Rust side ignores the shortcut and command too).
  const [hudEnabled, setHudEnabled] = useState(false);
  useEffect(() => {
    getConfig()
      .then((config) => setHudEnabled(config.copilot_hud_enabled === true))
      .catch(() => {});
  }, []);
  const [lcUseMeFallback, setLcUseMeFallback] = useState(() => {
    try { return localStorage.getItem("copilot.micQuestions") === "1"; } catch { return false; }
  });
  return (
    <div className="companion-layout">
      <div className="companion-chrome">
        <span className="companion-wordmark">Adversaria</span>
        <button
          className="companion-browse-btn"
          onClick={onBrowse}
          title="Browse meetings — the recording keeps running"
        >
          Browse ⌄
        </button>
      </div>

      <div className="companion-recbar">
        <div className="companion-recbar-left">
          <span
            className="companion-dot"
            aria-hidden="true"
            style={{ animationName: recording ? "companion-dot-pulse" : "none" }}
          />
          <span className="companion-elapsed">{formatElapsed(elapsed)}</span>
          <span className="companion-status-label">
            {processing ? "Wrapping up…" : "Recording"}
          </span>
          <span className="companion-waveform">
            {bars.map((h, i) => (
              <span
                key={i}
                className="companion-wave-bar"
                style={{ height: `${4 + h * 12}px` }}
              />
            ))}
          </span>
        </div>
        <button
          className="companion-stop-btn"
          disabled={processing}
          onClick={onStop}
        >
          Stop &amp; summarize
        </button>
      </div>

      <div
        className={
          layout === "balanced"
            ? "companion-body balanced-wide"
            : isCopilotFocus
              ? "companion-body companion-body--copilot-focus"
              : "companion-body"
        }
      >
        <div className="companion-transcript">
          <div className="companion-section-label">
            LIVE TRANSCRIPT
            {recording && (
              <span className="companion-live-dot" aria-label="live">
                ● live
              </span>
            )}
          </div>
          {layout === "transcript" && (
            <CopilotAnswerStrip cards={copilotCards} activeTab={sheetOpen ? "copilot" : "transcript"} onOpen={(id) => openCopilot(id)} />
          )}
          <div
            className="companion-feed"
            ref={feedRef}
            onScroll={handleFeedScroll}
          >
            {lines.length === 0 && partials.length === 0 ? (
              <p className="companion-feed-empty">Listening…</p>
            ) : (
              <>
                {lines.map((line, i) => (
                  <p
                    key={i}
                    dir="auto"
                    className={`companion-feed-line ${line.source === "me" ? "me" : "them"}${
                      i === lines.length - 1 ? " now" : ""
                    }`}
                  >
                    {line.text}
                  </p>
                ))}
                {partials.map((p) => (
                  <p
                    key={`partial-${p.source}`}
                    dir="auto"
                    className={`companion-feed-line partial ${p.source}`}
                  >
                    {p.text}
                  </p>
                ))}
              </>
            )}
          </div>
          {!stuck && lines.length > 0 && (
            <button className="companion-jump" onClick={jumpToLatest}>
              Jump to latest ↓
            </button>
          )}
          {layout === "transcript" && sheetOpen && (
            <div className="companion-copilot-sheet" role="dialog" aria-label="Copilot" aria-modal="true">
              <div className="companion-sheet-header">
                <span className="companion-sheet-title">Copilot</span>
                <button type="button" className="companion-sheet-close" onClick={() => setSheetOpen(false)} aria-label="Close Copilot">Close</button>
              </div>
              <div className="companion-sheet-body">
                <p className="copilot-folder-line">{copilotFolderLabel}</p>
                <CopilotConsentBar mode={copilotMode} hasClaudeKey={hasClaudeKey} hasDeepSeekKey={hasDeepSeekKey} hasFolder={recordingFolderId != null} folderName={filingName ?? briefFolderName ?? (recordingFolderId != null ? String(recordingFolderId) : null)} onChange={handleCopilotModeChange} />
                <Suspense fallback={null}>
                  <CopilotCards cards={copilotCards} onForceCard={onForceCard} onPin={handlePin} onCancel={onCancel} onRetry={onRetry} copilotMode={copilotMode} webEnabled={folderWebEnabled} copilotSessionId={copilotSessionId ?? null} />
                </Suspense>
                <Suspense fallback={null}>
                  <LiveReviewPanels sessionId={copilotSessionId ?? null} state={liveState ?? null} copilotMode={copilotMode} onStateChange={onLiveStateChange ?? (() => {})} />
                </Suspense>
              </div>
            </div>
          )}
        </div>

        {layout === "balanced" ? (
          <>
            <div className="companion-divider" />
            <div className="companion-right">
              <CopilotAnswerStrip cards={copilotCards} activeTab={activeTab} onOpen={(id) => openCopilot(id)} />
              <div role="tablist" className="companion-tabs">
                <button
                  role="tab"
                  aria-selected={activeTab === "notes"}
                  className={`companion-tab${activeTab === "notes" ? " active" : ""}`}
                  onClick={() => setActiveTab("notes")}
                >
                  Notes
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === "lasttime"}
                  className={`companion-tab${activeTab === "lasttime" ? " active" : ""}`}
                  onClick={() => setActiveTab("lasttime")}
                >
                  Last time
                </button>
                <button
                  role="tab"
                  aria-selected={activeTab === "copilot"}
                  className={`companion-tab${activeTab === "copilot" ? " active" : ""}`}
                  onClick={() => setActiveTab("copilot")}
                >
                  Copilot
                  {pendingCopilotCount > 0 && activeTab !== "copilot" && (
                    <span className="copilot-badge">{pendingCopilotCount}</span>
                  )}
                </button>
              </div>

              {activeTab === "notes" ? (
                <div className="companion-right-row">
                  <div className="companion-notes">
                    {filingName ? <div className="lasttime-filing">Filing into: {filingName}</div> : null}
                    <div className="companion-section-label">YOUR NOTES</div>
                    <Suspense
                      fallback={
                        <textarea
                          className="companion-notes-textarea"
                          value={value}
                          onChange={(e) => onChange(e.target.value)}
                          placeholder={"- key decision…\n- action: follow up with…"}
                          dir="auto"
                          disabled={processing}
                        />
                      }
                    >
                      <NotesEditor
                        value={value}
                        onChange={onChange}
                        placeholder={"- key decision… - action: follow up with…"}
                        disabled={processing}
                        compact
                        ariaLabel="Meeting notes"
                      />
                    </Suspense>
                  </div>
                  <aside className="companion-context" aria-label="Meeting context">
                    <div className="companion-section-label">THIS MEETING KNOWS</div>
                    <div className="companion-context-scroll">
                      {attachments.length > 0 ? (
                        <ul className="companion-context-attachments" aria-live="polite">
                          {attachments.map((attachment, index) => (
                            <li
                              className="companion-context-attachment"
                              key={`${attachment.kind}-${attachment.value}-${index}`}
                            >
                              <span
                                className="companion-context-attachment-label"
                                dir="auto"
                                title={attachment.label}
                              >
                                {attachment.label}
                              </span>
                              <button
                                type="button"
                                className="companion-context-remove"
                                aria-label={`Remove ${attachment.label}`}
                                onClick={() => onRemoveAttachment(index)}
                                disabled={processing}
                              >
                                ×
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="companion-context-empty">
                          Attach a previous meeting and your notes will include a follow-up check on its open action items. Attached
                          files are used as background.
                        </p>
                      )}

                      <div className="companion-context-actions">
                        <button
                          type="button"
                          className="companion-context-action"
                          onClick={() => void handlePickFile()}
                          disabled={processing || pickingFile}
                        >
                          {pickingFile ? "Choosing…" : "+ Add file"}
                        </button>
                        <button
                          type="button"
                          className="companion-context-action"
                          aria-expanded={meetingListOpen}
                          aria-controls="companion-recent-meetings"
                          onClick={() => setMeetingListOpen((open) => !open)}
                          disabled={processing}
                        >
                          + Add meeting
                        </button>
                      </div>

                      {meetingListOpen && (
                        <div className="companion-context-meetings" id="companion-recent-meetings">
                          {recentMeetings.length > 0 ? (
                            recentMeetings.slice(0, 10).map((meeting) => (
                              <button
                                type="button"
                                className="companion-context-meeting"
                                key={meeting.id}
                                title={meeting.title}
                                onClick={() => {
                                  onAddAttachment({
                                    kind: "meeting",
                                    value: String(meeting.id),
                                    label: meeting.title,
                                  });
                                  setMeetingListOpen(false);
                                }}
                              >
                                <span dir="auto">{meeting.title}</span>
                              </button>
                            ))
                          ) : (
                            <p className="companion-context-empty">No previous meetings yet.</p>
                          )}
                        </div>
                      )}
                    </div>
                  </aside>
                </div>
              ) : activeTab === "lasttime" ? (
                <div className="companion-panel">
                  <div className="companion-panel-inner">
                    <select
                      aria-label="Folder for this meeting"
                      value={recordingFolderId ?? ""}
                      disabled={!!copilotSessionId?.trim()}
                      title={copilotSessionId?.trim() ? "Folder is locked for this meeting — it uses the folder chosen when recording started." : undefined}
                      onChange={(e) => {
                        const v = e.target.value;
                        onChangeRecordingFolder(v === "" ? null : Number(v));
                      }}
                    >
                      <option value="">(no folder)</option>
                      {folders.map((f) => (
                        <option key={f.folder.id} value={f.folder.id}>
                          {f.folder.name}
                        </option>
                      ))}
                    </select>
                    <label className="folder-web-toggle">
                      <input
                        type="checkbox"
                        checked={folderWebEnabled}
                        disabled={recordingFolderId == null || !copilotSessionId?.trim()}
                        onChange={(e) => void handleWebToggle(e.target.checked)}
                        aria-label="Allow web search (Claude only)"
                      />
                      Allow web search (Claude only)
                    </label>
                    <LastTimeBrief folderId={recordingFolderId} />
                  </div>
                </div>
              ) : (
                <div className="companion-panel">
                  <div className="companion-right-row lc-copilot-row">
                    <div className="lc-copilot-col">
                      <div className="lc-head">
                        <div className="lc-head-left">
                          <span className="lc-head-label">Copilot</span>
                          <CopilotConsentBar compact mode={copilotMode} hasClaudeKey={hasClaudeKey} hasDeepSeekKey={hasDeepSeekKey} hasFolder={recordingFolderId != null} folderName={filingName ?? briefFolderName ?? (recordingFolderId != null ? String(recordingFolderId) : null)} onChange={handleCopilotModeChange} />
                        </div>
                        <div className="lc-head-actions">
                          <button type="button" className="lc-head-btn" onClick={() => onForceCard(lcUseMeFallback)}>Answer last</button>
                          <div className="lc-head-menu-wrap">
                            <button type="button" className="lc-head-menu-btn" aria-label="More options" aria-expanded={lcHeadMenuOpen} onClick={() => { const next = !lcHeadMenuOpen; setLcHeadMenuOpen(next); if (next) copilotHudIsOpen().then(setLcHudOpen).catch(() => {}); }}>…</button>
                            {lcHeadMenuOpen && (
                              <div role="menu" className="lc-head-menu-popover">
                                <p className="lc-head-menu-info">{copilotFolderLabel}</p>
                                <p className="lc-head-menu-info">{lcProcessText}</p>
                                <p className="lc-head-menu-info">{CONSENT_LINES[copilotMode]}</p>
                                {recordingFolderId == null && copilotMode !== "no_ai" && (
                                  <p className="lc-head-menu-info">No folder chosen: only your live notes and attachments are searched.</p>
                                )}
                                <label className="lc-head-menu-item">
                                  <input
                                    type="checkbox"
                                    checked={lcUseMeFallback}
                                    onChange={(e) => {
                                      const checked = e.target.checked;
                                      setLcUseMeFallback(checked);
                                      try { localStorage.setItem("copilot.micQuestions", checked ? "1" : "0"); } catch {}
                                      copilotSetMicQuestions(checked).catch(() => {});
                                    }}
                                    aria-label="Questions can come from my mic"
                                  />
                                  Questions can come from my mic
                                </label>
                                {(copilotMode === "local" || copilotMode === "no_ai") && (
                                  <span className="copilot-privacy">{copilotMode === "local" ? `Current conversation stays on this ${COPY.device} · 0 bytes sent` : `Your notes and conversation stay on this ${COPY.device}`}</span>
                                )}
                                {hudEnabled && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="lc-head-menu-item lc-head-menu-action"
                                  onClick={() => {
                                    setLcHeadMenuOpen(false);
                                    void toggleCopilotHud().catch(() => {});
                                  }}
                                >
                                  {lcHudOpen ? "Close pop-out" : "Pop out answers"}
                                </button>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      {copilotMode === "claude" && !hasClaudeKey && (
                        <p className="lc-consent-hint">Add an Anthropic API key in Settings › Live Copilot</p>
                      )}
                      {copilotMode === "deepseek" && !hasDeepSeekKey && (
                        <p className="lc-consent-hint">Add a DeepSeek API key in Settings › Live Copilot</p>
                      )}
                      <Suspense fallback={null}>
                        <CopilotCards cards={copilotCards} onForceCard={onForceCard} onPin={handlePin} onCancel={onCancel} onRetry={onRetry} copilotMode={copilotMode} webEnabled={folderWebEnabled} copilotSessionId={copilotSessionId ?? null} hideHead />
                      </Suspense>
                    </div>
                    <div className="lc-review-col">
                      <Suspense fallback={null}>
                        <LiveReviewPanels sessionId={copilotSessionId ?? null} state={liveState ?? null} copilotMode={copilotMode} onStateChange={onLiveStateChange ?? (() => {})} />
                      </Suspense>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="companion-notefoot">
            <textarea
              className={`companion-notefoot-input${footerExpanded ? " expanded" : ""}`}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="+ Jot a note — folds into the summary…"
              dir="auto"
              disabled={processing}
              onFocus={() => setFooterFocused(true)}
              onBlur={(e) => {
                if (e.target.value.trim() === "") setFooterFocused(false);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
