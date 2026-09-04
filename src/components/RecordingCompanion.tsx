import { useEffect, useRef, useState } from "react";
import type { RecordingStatus } from "../hooks/useRecording";
import { getAudioLevel, pickContextFile } from "../lib/tauri";
import type { AttachmentDraft } from "../types";

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
}

const BAR_COUNT = 7;

/** Format elapsed seconds as M:SS. */
function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** The recording-companion view — replaces RecordingNotes as the in-meeting
 *  main-area panel.  Two variants: "balanced" (50/50 transcript + notes) and
 *  "transcript" (transcript fills the body, notes tucked into a footer). */
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
}: RecordingCompanionProps) {
  const processing = status === "stopping";
  const recording = status === "recording";
  const layout = variant === "transcript" ? "transcript" : "balanced";

  // ---- elapsed timer ----

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

  // ---- audio-reactive mini-waveform ----

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

  // ---- expand-on-focus state (transcript variant only) ----

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

  // ---- auto-scroll transcript feed ----

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

  // ---- render helpers ----

  const lines = liveLines.filter((l) => l.text.trim() !== "");
  const partials = (["them", "me"] as const)
    .filter((s) => livePartials[s].trim() !== "")
    .map((s) => ({ source: s, text: livePartials[s] }));

  return (
    <div className="companion-layout">
      {/* Chrome row */}
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

      {/* Record bar */}
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

      {/* Body */}
      <div
        className={
          layout === "balanced"
            ? "companion-body balanced-wide"
            : "companion-body"
        }
      >
        {/* Transcript pane */}
        <div className="companion-transcript">
          <div className="companion-section-label">
            LIVE TRANSCRIPT
            {recording && (
              <span className="companion-live-dot" aria-label="live">
                ● live
              </span>
            )}
          </div>
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
        </div>

        {/* Notes area */}
        {layout === "balanced" ? (
          <>
            <div className="companion-divider" />
            <div className="companion-notes">
              <div className="companion-section-label">YOUR NOTES</div>
              <textarea
                className="companion-notes-textarea"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={"- key decision…\n- action: follow up with…"}
                dir="auto"
                disabled={processing}
              />
            </div>
            <aside className="companion-context" aria-label="Meeting context">
              <div className="companion-section-label">THIS MEETING KNOWS</div>
              <div className="companion-context-scroll">
                {attachments.length > 0 ? (
                  <ul className="companion-context-attachments" aria-live="polite">
                    {attachments.map((attachment, index) => (
                      <li className="companion-context-attachment" key={`${attachment.kind}-${attachment.value}-${index}`}>
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
                    Add reference material for the notes.
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
                  <div
                    className="companion-context-meetings"
                    id="companion-recent-meetings"
                  >
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
                      <p className="companion-context-empty">
                        No previous meetings yet.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </aside>
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
