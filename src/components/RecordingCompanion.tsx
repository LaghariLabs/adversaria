import { useEffect, useRef, useState } from "react";
import type { RecordingStatus } from "../hooks/useRecording";
import { getAudioLevel } from "../lib/tauri";

interface RecordingCompanionProps {
  variant: string;
  value: string;
  onChange: (v: string) => void;
  status: RecordingStatus;
  liveLines: { text: string; source: string }[];
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
  }, [liveLines]);

  const jumpToLatest = () => {
    const feed = feedRef.current;
    if (!feed) return;
    feed.scrollTop = feed.scrollHeight;
    stuckRef.current = true;
    setStuck(true);
  };

  // ---- render helpers ----

  const lines = liveLines.filter((l) => l.text.trim() !== "");

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
      <div className="companion-body">
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
            {lines.length === 0 ? (
              <p className="companion-feed-empty">Listening…</p>
            ) : (
              lines.map((line, i) => (
                <p
                  key={i}
                  dir="auto"
                  className={`companion-feed-line ${line.source === "me" ? "me" : "them"}${
                    i === lines.length - 1 ? " now" : ""
                  }`}
                >
                  {line.text}
                </p>
              ))
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
