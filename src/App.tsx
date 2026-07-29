import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CalendarDays,
  Download,
  FileJson,
  LockKeyhole,
  Mic2,
} from "lucide-react";
import { useRecording } from "./hooks/useRecording";
import { useMeetings } from "./hooks/useMeetings";
import { RecordingControls } from "./components/RecordingControls";
import { MeetingsList } from "./components/MeetingsList";
import { NoteViewer, NoteViewerEmpty } from "./components/NoteViewer";
import { RecordingCompanion } from "./components/RecordingCompanion";
import { ErrorBanner } from "./components/ErrorBanner";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { Welcome } from "./components/Welcome";
import { SetupStatusStrip } from "./components/SetupStatusStrip";
import { GuidedTour } from "./components/GuidedTour";
import {
  getConfig,
  deleteMeeting,
  setMeetingPinned,
  setMeetingArchived,
  setMeetingLocked,
  updateAttendees,
  checkServiceHealth,
  importAudio,
  importMeetingBundle,
  pickAudioFile,
  biometricAuthenticate,
} from "./lib/tauri";
import { verifyPin } from "./lib/pin";
import { setDateFormat } from "./lib/dateFormat";
import type { Meeting, PromptTemplate } from "./types";

// Secondary views are intentionally split from the startup/recording path.
// GraphView alone pulls in Cytoscape; Settings is also large. Loading them only
// when selected keeps the primary entry bundle within the Phase 0 budget.
const Settings = lazy(() =>
  import("./components/Settings").then((module) => ({ default: module.Settings })),
);
const TodosView = lazy(() =>
  import("./components/TodosView").then((module) => ({ default: module.TodosView })),
);
const WeeklyView = lazy(() =>
  import("./components/WeeklyView").then((module) => ({ default: module.WeeklyView })),
);
const AskAllView = lazy(() =>
  import("./components/AskAllView").then((module) => ({ default: module.AskAllView })),
);
const GraphView = lazy(() =>
  import("./components/GraphView").then((module) => ({ default: module.GraphView })),
);

const SILENCE_PROMPT_MS = 5 * 60 * 1000;
const SILENCE_STOP_MS = 10 * 60 * 1000;
const SILENCE_CHECK_MS = 15 * 1000;

type View = "meetings" | "settings" | "todos" | "weekly" | "ask" | "graph";

function App() {
  const [view, setView] = useState<View>("meetings");
  // Set by the guided tour so its last step can land on Settings › AI Model.
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
  // Service health powers the header "Local ML Service" status pill.
  const [serviceOnline, setServiceOnline] = useState<boolean | null>(null);
  // Sovereignty: "full" = both transcription + LLM local (blue), "partial" = one
  // of them cloud (amber), "none" = both cloud (red). null = not yet known.
  const [sovereign, setSovereign] = useState<"full" | "partial" | "none" | null>(
    null,
  );
  // Transient in-app notice (window.alert is a no-op in the Tauri webview).
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedTemplate] =
    useState<PromptTemplate>("general");
  // App name from an auto-detected meeting, or null when nothing is pending.
  const [detectedApp, setDetectedApp] = useState<string | null>(null);
  const [userNotes, setUserNotes] = useState("");
  const [liveLines, setLiveLines] = useState<{ text: string; source: string }[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const [meetingOverPrompt, setMeetingOverPrompt] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  // Privacy lock: which locked meetings have been unlocked this session, whether
  // a PIN is configured, and the active PIN prompt (if any).
  const [unlockedIds, setUnlockedIds] = useState<Set<number>>(new Set());
  const [archiveAfterDays, setArchiveAfterDays] = useState(30);
  const [sidebarView, setSidebarView] = useState("compact");
  const [pinSet, setPinSet] = useState(false);
  const [pinPrompt, setPinPrompt] = useState<{
    meeting: Meeting;
    purpose: "view" | "unlock";
  } | null>(null);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  // Meeting pending delete-confirmation (in-app modal — window.confirm is a
  // no-op in the Tauri webview, so it can't gate the delete).
  const [deletePrompt, setDeletePrompt] = useState<Meeting | null>(null);
  const [recordingView, setRecordingView] = useState("balanced");
  const [peekBrowse, setPeekBrowse] = useState(false);
  // Auto-stop thresholds, loaded from config (defaults match the old constants).
  const [autoStop, setAutoStop] = useState({
    enabled: true,
    promptMs: SILENCE_PROMPT_MS,
    stopMs: SILENCE_STOP_MS,
  });
  const [todosScope, setTodosScope] = useState<number | null>(null);

  const {
    status,
    error,
    lastMeetingId,
    rosterSuggestion,
    transcriptionQueue,
    transcribingId,
    settledTick,
    lastSettledId,
    lastDiscardedId,
    start,
    stop,
    dismissError,
    dismissRosterSuggestion,
  } = useRecording();
  const lastActivityRef = useRef(Date.now());
  const { meetings, selectedMeeting, selectMeeting, clearSelection, refresh } =
    useMeetings();

  // Refs for Tauri event listeners to avoid stale closures
  const statusRef = useRef(status);
  statusRef.current = status;
  const templateRef = useRef(selectedTemplate);
  templateRef.current = selectedTemplate;
  const userNotesRef = useRef(userNotes);
  userNotesRef.current = userNotes;

  // Load auto-stop preferences; re-fetch on view change so a Settings save
  // (then navigating back to Meetings) takes effect without an app restart.
  useEffect(() => {
    getConfig()
      .then((c) => {
        setDateFormat(c.date_format); // drive app-wide date rendering
        setArchiveAfterDays(c.archive_after_days);
        setSidebarView(c.sidebar_view ?? "compact");
        // Only replace autoStop when a value actually changed: a fresh object
        // identity re-runs the auto-stop effect, which RESETS the silence
        // clock — with this effect keyed on `view`, every tab switch during a
        // recording used to restart the countdown.
        setAutoStop((prev) => {
          const next = {
            enabled: c.auto_stop_enabled,
            promptMs: c.silence_prompt_minutes * 60 * 1000,
            stopMs: c.silence_stop_minutes * 60 * 1000,
          };
          return prev.enabled === next.enabled &&
            prev.promptMs === next.promptMs &&
            prev.stopMs === next.stopMs
            ? prev
            : next;
        });
        setPinSet(!!c.pin_hash);
        // Sovereignty by how many of {transcription, LLM} run locally.
        const txLocal = !c.transcription_base_url?.trim();
        const llmLocal = c.llm_provider === "local";
        const localCount = (txLocal ? 1 : 0) + (llmLocal ? 1 : 0);
        setSovereign(localCount === 2 ? "full" : localCount === 1 ? "partial" : "none");
      })
      .catch(() => {});
  }, [view]);

  // Settings like sidebar_view are saved in Settings and should apply as soon
  // as the user navigates back, without an app restart.
  useEffect(() => {
    if (view !== "meetings") return;
    getConfig()
      .then((c) => {
        setSidebarView(c.sidebar_view ?? "compact");
        setArchiveAfterDays(c.archive_after_days);
      })
      .catch(() => {});
  }, [view]);

  // A stopped recording is saved as a pending meeting and enqueued for
  // background transcription. Surface it immediately (the user sees it
  // "Transcribing…") and clear the notepad/live caption for the next meeting.
  const prevLastMeetingId = useRef<number | null>(lastMeetingId);
  useEffect(() => {
    if (lastMeetingId !== null && lastMeetingId !== prevLastMeetingId.current) {
      prevLastMeetingId.current = lastMeetingId;
      refresh();
      selectMeeting(lastMeetingId);
      setUserNotes("");
      setLiveLines([]);
    }
  }, [lastMeetingId, refresh, selectMeeting]);

  // When a background transcription settles, refresh the list and — if the user
  // is currently viewing that meeting — reload it so the transcript/summary
  // appear, without yanking them away from anything else they've opened.
  const selectedMeetingRef = useRef(selectedMeeting);
  selectedMeetingRef.current = selectedMeeting;
  useEffect(() => {
    if (settledTick === 0) return;
    refresh();
    if (lastSettledId !== null && lastSettledId === lastDiscardedId) {
      setNotice("Recording discarded — no speech was detected.");
      if (selectedMeetingRef.current?.id === lastSettledId) clearSelection();
      return;
    }
    if (lastSettledId !== null && selectedMeetingRef.current?.id === lastSettledId) {
      selectMeeting(lastSettledId);
    }
  }, [settledTick, lastSettledId, lastDiscardedId, refresh, selectMeeting, clearSelection]);

  // Clear the live transcript when returning to idle
  useEffect(() => {
    if (status === "idle") {
      setLiveLines([]);
      setPeekBrowse(false);
    }
  }, [status]);

  // Listen for tray and hotkey events from Rust backend
  useEffect(() => {
    const handleToggle = () => {
      if (statusRef.current === "idle") {
        start();
      } else if (statusRef.current === "recording") {
        stop(templateRef.current, userNotesRef.current);
      }
    };

    // Keep the registration PROMISES for cleanup: under StrictMode's dev
    // double-mount the cleanup can run before registration resolves, and the
    // old push-into-array pattern then unlistened nothing — the first mount's
    // listeners leaked and every toggle event fired twice (twin recordings).
    const registrations = [
      listen("tray-toggle-recording", handleToggle),
      listen("hotkey-toggle-recording", handleToggle),
      // Auto-detection: backend noticed a meeting app using the mic. Only offer
      // when idle; never auto-record.
      listen<{ app: string }>("meeting-detected", (event) => {
        if (statusRef.current === "idle") {
          setDetectedApp(event.payload.app);
        }
      }),
      // Live transcription preview while recording. Each caption carries its
      // source ("me" = mic, "them" = system audio) so lines can be colored.
      listen<{ text: string; source: string }>("live-transcript", (event) => {
        // Keep all lines so the companion can scroll through the full history.
        setLiveLines((prev) => [...prev, event.payload]);
        lastActivityRef.current = Date.now();
        setMeetingOverPrompt(false);
      }),
    ];

    return () => {
      registrations.forEach((registration) => {
        registration.then((unlisten) => unlisten());
      });
    };
  }, [start, stop]);

  // Silence-based auto-stop: reset clock on recording (re)start, check on interval
  useEffect(() => {
    if (status !== "recording" || !autoStop.enabled) return;
    lastActivityRef.current = Date.now();
    setMeetingOverPrompt(false);
    const id = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      if (idle >= autoStop.stopMs) {
        stop(templateRef.current, userNotesRef.current);
      } else if (idle >= autoStop.promptMs) {
        setMeetingOverPrompt(true);
      }
    }, SILENCE_CHECK_MS);
    return () => clearInterval(id);
  }, [status, stop, autoStop]);

  // A new recording takes over the pane: clear any open meeting so the live
  // notes pad shows. (The user can still browse meetings while recording — the
  // pane then shows the meeting with a "back to live notes" strip.)
  useEffect(() => {
    if (status === "recording") {
      clearSelection();
      setView("meetings");
      setLiveLines([]);
      setPeekBrowse(false);
      getConfig()
        .then((c) => setRecordingView(c.recording_view ?? "balanced"))
        .catch(() => {});
    }
  }, [status, clearSelection]);

  // Auto-relock: an unlock lasts only while that meeting is open. Navigating
  // away (or closing it) re-arms the lock instead of leaving it open for the
  // whole session.
  useEffect(() => {
    setUnlockedIds((prev) => {
      if (prev.size === 0) return prev;
      const keep = new Set<number>();
      if (selectedMeeting?.id != null && prev.has(selectedMeeting.id)) {
        keep.add(selectedMeeting.id);
      }
      return keep.size === prev.size ? prev : keep;
    });
  }, [selectedMeeting?.id]);

  const handleRecordDetected = () => {
    setDetectedApp(null);
    start();
  };

  const handleStopRecording = () => {
    stop(selectedTemplate, userNotes);
  };

  // The post-unlock action, shared by the biometric and PIN paths.
  const performUnlock = (meeting: Meeting, purpose: "view" | "unlock") => {
    if (purpose === "view") {
      setUnlockedIds((prev) => new Set(prev).add(meeting.id));
      selectMeeting(meeting.id);
      setView("meetings");
    } else {
      setMeetingLocked(meeting.id, false)
        .then(() => {
          refresh();
          if (selectedMeeting?.id === meeting.id) selectMeeting(meeting.id);
        })
        .catch((e) => console.error("Failed to unlock meeting:", e));
    }
  };

  // Unlock a locked meeting: try Touch ID / Windows Hello first (when enabled in
  // Settings), falling back to the PIN modal on failure or no sensor.
  const requestUnlock = async (meeting: Meeting, purpose: "view" | "unlock") => {
    const cfg = await getConfig().catch(() => null);
    if (cfg?.biometric_unlock) {
      try {
        if (await biometricAuthenticate("Unlock this meeting")) {
          performUnlock(meeting, purpose);
          return;
        }
      } catch {
        // fall through to the PIN modal
      }
    }
    setPinInput("");
    setPinError(null);
    setPinPrompt({ meeting, purpose });
  };

  const handleMeetingSelected = (meeting: typeof selectedMeeting) => {
    if (!meeting) return;
    if (view === "todos") {
      // On the To-dos board the sidebar is a scope filter: clicking a meeting
      // focuses its to-dos without leaving the board. (No unlock needed — the
      // board already lists every meeting's items under "All".)
      setTodosScope(meeting.id);
      return;
    }
    if (meeting.locked && !unlockedIds.has(meeting.id)) {
      requestUnlock(meeting, "view");
      return;
    }
    selectMeeting(meeting.id);
    // Clicking a meeting in the sidebar jumps to its note from any other
    // tab (Weekly / Ask / Graph / Settings).
    setView("meetings");
  };

  const handleToggleLock = async (meeting: Meeting) => {
    if (!meeting.locked) {
      if (!pinSet) {
        setNotice("Set a privacy PIN in Settings → Security first to lock meetings.");
        return;
      }
      try {
        await setMeetingLocked(meeting.id, true);
        setUnlockedIds((prev) => {
          const next = new Set(prev);
          next.delete(meeting.id);
          return next;
        });
        if (selectedMeeting?.id === meeting.id) clearSelection();
        refresh();
      } catch (e) {
        console.error("Failed to lock meeting:", e);
      }
      return;
    }
    // Unlocking the flag requires Touch ID/PIN (unless already unlocked this session).
    if (unlockedIds.has(meeting.id)) {
      try {
        await setMeetingLocked(meeting.id, false);
        refresh();
        if (selectedMeeting?.id === meeting.id) selectMeeting(meeting.id);
      } catch (e) {
        console.error("Failed to unlock meeting:", e);
      }
      return;
    }
    requestUnlock(meeting, "unlock");
  };

  const handlePinSubmit = async () => {
    if (!pinPrompt) return;
    setPinError(null);
    let cfg;
    try {
      cfg = await getConfig();
    } catch {
      setPinError("Could not read settings.");
      return;
    }
    if (!cfg.pin_hash) {
      setPinPrompt(null);
      return;
    }
    const ok = await verifyPin(pinInput, cfg.pin_hash);
    if (!ok) {
      setPinError("Wrong PIN.");
      return;
    }
    performUnlock(pinPrompt.meeting, pinPrompt.purpose);
    setPinPrompt(null);
    setPinInput("");
  };

  const handleOpenFromTodos = (id: number) => {
    selectMeeting(id);
    setView("meetings");
  };

  const handleDeleteMeeting = (meeting: Meeting) => {
    setDeletePrompt(meeting);
  };

  const confirmDelete = async () => {
    if (!deletePrompt) return;
    const meeting = deletePrompt;
    setDeletePrompt(null);
    try {
      await deleteMeeting(meeting.id);
      if (selectedMeeting?.id === meeting.id) clearSelection();
      refresh();
    } catch (e) {
      console.error("Failed to delete meeting:", e);
    }
  };

  const handleTogglePin = async (meeting: Meeting) => {
    try {
      await setMeetingPinned(meeting.id, !meeting.pinned);
      refresh();
      if (selectedMeeting?.id === meeting.id) selectMeeting(meeting.id);
    } catch (e) {
      setNotice("Couldn't pin: " + String(e).slice(0, 120));
      console.error("Failed to pin meeting:", e);
    }
  };

  const handleToggleArchive = async (meeting: Meeting) => {
    try {
      await setMeetingArchived(meeting.id, !meeting.archived);
      refresh();
      if (selectedMeeting?.id === meeting.id) selectMeeting(meeting.id);
    } catch (e) {
      setNotice("Couldn't archive: " + String(e).slice(0, 120));
      console.error("Failed to archive meeting:", e);
    }
  };

  const handleMeetingUpdated = (updated: { id: number }) => {
    selectMeeting(updated.id);
    refresh();
  };

  const isRecordingActive = status === "recording" || status === "stopping";
  const companionActive =
    isRecordingActive && !selectedMeeting && view === "meetings" && !peekBrowse;

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) =>
      setSidebarWidth(Math.min(Math.max(ev.clientX, 220), 560));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const Divider = () => (
    <div onMouseDown={startResize} className="resize-divider" />
  );

  // Sidebar contents — RecordingControls/.recording-bar and the .action-box are
  // fixed at top; MeetingsList (search + heatmap + tag pills + cards) flexes to
  // fill and scrolls. The .sidebar wrapper (a flex column) is applied at the render site.
  // Standalone notes (NewNoteButton) hidden for launch 2026-07-18 — see docs/TODO.md;
  // existing note rows stay viewable in the meetings list.
  const sidebar = (
    <>
      <RecordingControls
        status={status}
        onStart={start}
        onStop={handleStopRecording}
      />
      <div className="action-box">
        <div style={{ position: "relative", flex: 1 }}>
          <button
            className="btn-secondary"
            style={{ width: "100%" }}
            disabled={importing}
            onClick={() => setImportMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={importMenuOpen}
          >
            <Download size={14} aria-hidden="true" />
            {importing ? "Importing…" : "Import ▾"}
          </button>
          {importMenuOpen && (
            <>
              {/* click-away overlay */}
              <div
                style={{ position: "fixed", inset: 0, zIndex: 20 }}
                onClick={() => setImportMenuOpen(false)}
              />
              <div
                className="tag-add-popup"
                style={{ left: 0, top: "calc(100% + 4px)", zIndex: 30, width: "100%", minWidth: 200 }}
                role="menu"
              >
                <button
                  className="settings-menu-item"
                  role="menuitem"
                  onClick={async () => {
                    setImportMenuOpen(false);
                    const path = await pickAudioFile();
                    if (!path) return;
                    setImporting(true);
                    try {
                      const meeting = await importAudio(path);
                      refresh();
                      selectMeeting(meeting.id);
                      setView("meetings");
                    } catch (e) {
                      setNotice(String(e).slice(0, 200));
                    } finally {
                      setImporting(false);
                    }
                  }}
                >
                  <Mic2 size={15} aria-hidden="true" />
                  Audio file (.m4a, .mp3, .wav)…
                </button>
                <button
                  className="settings-menu-item"
                  role="menuitem"
                  onClick={async () => {
                    setImportMenuOpen(false);
                    setImporting(true);
                    try {
                      const meeting = await importMeetingBundle();
                      if (meeting) {
                        refresh();
                        selectMeeting(meeting.id);
                        setView("meetings");
                      }
                    } catch (e) {
                      setNotice(String(e).slice(0, 200));
                    } finally {
                      setImporting(false);
                    }
                  }}
                >
                  <FileJson size={15} aria-hidden="true" />
                  Meeting bundle (.json)…
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <MeetingsList
          meetings={meetings}
          onSelect={handleMeetingSelected}
          onTagsUpdated={refresh}
          onDelete={handleDeleteMeeting}
          onTogglePin={handleTogglePin}
          onToggleLock={handleToggleLock}
          onToggleArchive={handleToggleArchive}
          unlockedIds={unlockedIds}
          transcribingId={transcribingId}
          queuedIds={transcriptionQueue}
          // On the To-dos board the sidebar highlight tracks the SCOPE (the
          // meeting whose to-dos are focused), not the open meeting — without
          // it, clicking a meeting there gave no visual feedback and the
          // focused meeting "got lost".
          selectedId={
            view === "todos" ? todosScope : selectedMeeting?.id ?? null
          }
          archiveAfterDays={archiveAfterDays}
          sidebarView={sidebarView}
        />
      </div>
    </>
  );

  // Poll the local ML service health for the header status pill (every 20s).
  useEffect(() => {
    let alive = true;
    const ping = () =>
      checkServiceHealth()
        .then(() => alive && setServiceOnline(true))
        .catch(() => alive && setServiceOnline(false));
    ping();
    const id = setInterval(ping, 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className={`h-screen flex flex-col${companionActive ? " companion-mode" : ""}`}>
      <Welcome />
      <SetupStatusStrip />
      <GuidedTour
        onNavigate={(nextView, tab) => {
          setSettingsTab(tab);
          setView(nextView as View);
        }}
      />
      <UpdatePrompt />
      {/* Intro / loading splash */}
      {showSplash && (
        <div
          className="splash-anim fixed inset-0 z-50 flex items-center justify-center bg-gray-950"
          onAnimationEnd={() => setShowSplash(false)}
        >
          <div className="text-center">
            <h1
              className="text-8xl italic tracking-tight"
              style={{
                color: "#24A0ED",
                fontFamily: "'Instrument Serif', Georgia, 'Times New Roman', serif",
              }}
            >
              Adversaria
            </h1>
            <p className="mt-3 text-xs tracking-[0.3em] uppercase text-gray-500">
              a Laghari Labs product
            </p>
          </div>
        </div>
      )}

      {/* Header — glass top bar (prototype: logo + centered nav tabs + ML status pill) */}
      <header>
        <div className="logo-container">
          <span className="logo-text">Adversaria</span>
          <span className="logo-subtext">
            a <span>Laghari Labs</span> product
          </span>
        </div>

        <nav id="view-tabs">
          {(
            [
              ["meetings", "Meetings"],
              ["todos", "To-dos"],
              ["weekly", "Weekly"],
              ["ask", "Ask"],
              ["graph", "Graph"],
              ["settings", "Settings"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              data-tour={v}
              onClick={() => setView(v)}
              className={`nav-btn${view === v ? " active" : ""}`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="header-status">
          {/* Sovereignty: blue = fully on-device, amber = partial, red = cloud. */}
          {(() => {
            const sovColor =
              sovereign === "full"
                ? "var(--accent-blue)"
                : sovereign === "partial"
                  ? "var(--accent-amber)"
                  : "var(--accent-red)";
            const sovLabel =
              sovereign === null
                ? "Sovereignty: checking…"
                : sovereign === "full"
                  ? "Completely sovereign"
                  : sovereign === "partial"
                    ? "Partially sovereign"
                    : "Cloud connected";
            const sovTitle =
              sovereign === "full"
                ? "Transcription and the LLM both run on this device — nothing leaves your machine."
                : sovereign === "partial"
                  ? "One of transcription / the LLM uses a cloud provider — some data leaves your device."
                  : "Transcription and the LLM both use cloud providers — data leaves your device.";
            return (
              <span
                title={sovTitle}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: sovColor,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    backgroundColor: sovColor,
                    borderRadius: "50%",
                  }}
                />
                {sovLabel}
              </span>
            );
          })()}
          <span
            style={{
              fontSize: 11,
              fontWeight: 600, // match the sovereignty line above
              color:
                serviceOnline === false
                  ? "var(--accent-red)"
                  : serviceOnline
                    ? "var(--accent-green)"
                    : "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                backgroundColor:
                  serviceOnline === false
                    ? "var(--accent-red)"
                    : serviceOnline
                      ? "var(--accent-green)"
                      : "var(--text-muted)",
                borderRadius: "50%",
              }}
            />
            Local ML Service:{" "}
            {serviceOnline === null
              ? "Checking…"
              : serviceOnline
                ? "Online"
                : "Offline"}
          </span>
        </div>
      </header>

      {/* Error banner */}
      <ErrorBanner message={error} onDismiss={dismissError} />

      {/* Transient in-app notice (e.g. "set a PIN first" — window.alert is a no-op here). */}
      {notice && (
        <div
          className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
          style={{
            background: "rgba(255, 149, 0, 0.12)",
            borderBottom: "1px solid rgba(255, 149, 0, 0.3)",
            color: "var(--accent-amber)",
          }}
        >
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="btn-popup-action cancel">
            Dismiss
          </button>
        </div>
      )}

      {/* Calendar roster suggestion — shown after recording when a matching
          calendar event is found.  The user must confirm before attendees are
          merged (never auto-write — privacy guarantee). */}
      {rosterSuggestion && lastMeetingId !== null && (
        <div className="flex items-center justify-between px-4 py-2 bg-blue-900/30 border-b border-blue-700/50 text-sm">
          <span className="text-blue-200 inline-flex items-center gap-1">
            <CalendarDays size={15} aria-hidden="true" /> Found "{rosterSuggestion.eventTitle}" on{" "}
            {rosterSuggestion.provider} — add{" "}
            {rosterSuggestion.attendees.length} attendee
            {rosterSuggestion.attendees.length > 1 ? "s" : ""}?
          </span>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                try {
                  // Merge calendar attendees into the existing meeting attendee list.
                  // Uses the existing updateAttendees command — no schema change.
                  await updateAttendees(
                    lastMeetingId,
                    rosterSuggestion.attendees,
                  );
                } catch (e) {
                  console.error("Failed to merge roster:", e);
                }
                dismissRosterSuggestion();
              }}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white"
            >
              Add
            </button>
            <button
              onClick={dismissRosterSuggestion}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300"
            >
              Ignore
            </button>
          </div>
        </div>
      )}

      {/* Privacy-lock PIN prompt */}
      {pinPrompt && (
        <div className="modal-overlay open" onClick={() => setPinPrompt(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">
              <LockKeyhole size={18} aria-hidden="true" /> {pinPrompt.purpose === "view" ? "Locked meeting" : "Unlock meeting"}
            </h3>
            <p className="modal-desc">
              Enter your privacy PIN to{" "}
              {pinPrompt.purpose === "view" ? "view this meeting." : "unlock it."}
            </p>
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handlePinSubmit();
                if (e.key === "Escape") setPinPrompt(null);
              }}
              placeholder="PIN"
              className="modal-input"
            />
            {pinError && <div className="modal-error">{pinError}</div>}
            <div className="modal-actions">
              <button onClick={() => setPinPrompt(null)} className="btn-modal cancel">
                Cancel
              </button>
              <button onClick={handlePinSubmit} className="btn-modal confirm">
                {pinPrompt.purpose === "view" ? "Unlock" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deletePrompt && (
        <div className="modal-overlay open" onClick={() => setDeletePrompt(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title" style={{ color: "var(--accent-red)" }}>
              Delete meeting?
            </h3>
            <p className="modal-desc">
              "{deletePrompt.title}" will be permanently deleted. This can't be
              undone.
            </p>
            <div className="modal-actions">
              <button onClick={() => setDeletePrompt(null)} className="btn-modal cancel">
                Cancel
              </button>
              <button onClick={confirmDelete} className="btn-modal delete">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-detected meeting prompt */}
      {detectedApp && status === "idle" && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-blue-100 border-b border-blue-200 text-sm">
          <span className="text-blue-900">
            Looks like a meeting started in{" "}
            <span className="font-medium">{detectedApp}</span>. Record it?
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRecordDetected}
              className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-xs transition-colors"
            >
              Record
            </button>
            <button
              onClick={() => setDetectedApp(null)}
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Silence / meeting-over prompt */}
      {meetingOverPrompt && status === "recording" && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-100 border-b border-amber-200 text-sm">
          <span className="text-amber-900">
            No one's spoken for {Math.round(autoStop.promptMs / 60000)} minutes —
            is the meeting over?
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                lastActivityRef.current = Date.now();
                setMeetingOverPrompt(false);
              }}
              className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs transition-colors"
            >
              Keep recording
            </button>
            <button
              onClick={() => {
                setMeetingOverPrompt(false);
                handleStopRecording();
              }}
              className="px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-xs transition-colors"
            >
              Stop &amp; summarize
            </button>
          </div>
        </div>
      )}

      {/* Main body — sidebar always visible (prototype); the content-area swaps
          its panel by the active view / selection. */}
      <div className="main-wrapper">
        <div className="sidebar" style={{ width: sidebarWidth }}>
          {sidebar}
        </div>
        <Divider />
        <div className="content-area">
          <Suspense fallback={<div className="empty-state">Loading view…</div>}>
            {view === "settings" ? (
              <Settings initialTab={settingsTab} />
            ) : view === "todos" ? (
              <TodosView
                meetings={meetings}
                onOpenMeeting={handleOpenFromTodos}
                scopeMeetingId={todosScope}
                onScopeChange={setTodosScope}
              />
            ) : view === "weekly" ? (
              <WeeklyView meetings={meetings} onOpenMeeting={handleOpenFromTodos} />
            ) : view === "ask" ? (
              <AskAllView onOpenMeeting={handleOpenFromTodos} />
            ) : view === "graph" ? (
              <GraphView meetings={meetings} onSelectMeeting={handleOpenFromTodos} />
            ) : isRecordingActive && !selectedMeeting ? (
              companionActive ? (
                <RecordingCompanion
                  variant={recordingView}
                  value={userNotes}
                  onChange={setUserNotes}
                  status={status}
                  liveLines={liveLines}
                  onStop={handleStopRecording}
                  onBrowse={() => setPeekBrowse(true)}
                />
              ) : (
                <>
                  <div style={{ padding: "10px 16px 0" }}>
                    <button
                      className="btn-ghost"
                      onClick={() => setPeekBrowse(false)}
                      style={{ color: "var(--accent-red)" }}
                      title="The recording continues in the background — this returns you to the live notes pad."
                    >
                      ● Recording in progress — back to live notes
                    </button>
                  </div>
                  <NoteViewerEmpty />
                </>
              )
            ) : selectedMeeting ? (
              <>
                {isRecordingActive && (
                  <div style={{ padding: "10px 16px 0" }}>
                    <button
                      className="btn-ghost"
                      onClick={() => {
                        clearSelection();
                        setPeekBrowse(false);
                      }}
                      style={{ color: "var(--accent-red)" }}
                      title="The recording continues in the background — this returns you to the live notes pad."
                    >
                      ● Recording in progress — back to live notes
                    </button>
                  </div>
                )}
                <NoteViewer
                  key={selectedMeeting.id}
                  meeting={selectedMeeting}
                  onMeetingUpdated={handleMeetingUpdated}
                  onTogglePin={handleTogglePin}
                  onToggleLock={handleToggleLock}
                  onDelete={handleDeleteMeeting}
                  isTranscribing={selectedMeeting.id === transcribingId}
                  isQueued={transcriptionQueue.includes(selectedMeeting.id)}
                  onDiscarded={() => {
                    setNotice("Recording discarded — no speech was detected.");
                    clearSelection();
                    refresh();
                  }}
                />
              </>
            ) : (
              <NoteViewerEmpty />
            )}
          </Suspense>
        </div>
      </div>
    </div>
  );
}

export default App;
