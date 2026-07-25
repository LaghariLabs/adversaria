import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  bubbleStartDrag,
  bubbleStopRecording,
  focusMainWindow,
  getAudioLevels,
  getRecordingElapsed,
  setRecordingBubbleExpanded,
} from "../lib/tauri";
import { Square } from "lucide-react";

/** 74 → "1:14"; 3675 → "1:01:15". */
function formatElapsed(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** Four CSS-animated waveform bars. `level` (0..1) drives the amplitude so the
 *  bars only dance while that channel actually has audio — "Me" moves when the
 *  mic hears the user, "Them" when the call plays sound. */
function Waveform({ variant, level }: { variant?: "them"; level?: number }) {
  return (
    <span
      className={`record-pill-wave${variant === "them" ? " them" : ""}`}
      style={
        level === undefined
          ? undefined
          : ({ "--lvl": Math.min(1, level) } as React.CSSProperties)
      }
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * Floating "Recording" pill — rendered in a small, frameless, always-on-top
 * window (label "recording"). The Rust side shows it while recording when the
 * main window is minimized/blurred and picks the size + `style` query param
 * from the user's `notch_pill_style` setting:
 *   - "minimal"    → a compact pill (dot · timer · waveform).
 *   - "expressive" → the same pill that blooms into an island on hover (title,
 *                    live caption, both channels, one-tap Stop).
 * Clicking the pill returns to the app; the Stop button ends the recording.
 */
export function RecordingBubble() {
  const params = new URLSearchParams(window.location.search);
  const expressive = params.get("style") === "expressive";
  const notch = params.get("notch") === "1";
  const notchWidth = Number(params.get("nw") ?? 0);
  const notchHeight = Number(params.get("nh") ?? 0);
  const wing = Number(params.get("wing") ?? 108);

  const [elapsed, setElapsed] = useState<number | null>(null);
  const [caption, setCaption] = useState<string>("");
  // [system "Them", mic "Me"] loudness (0..1) — drives the waveform amplitudes.
  const [levels, setLevels] = useState<[number, number]>([0, 0]);
  // Docked expressive island: collapsed strip by default; hover expands (the
  // window itself is resized Rust-side so the collapsed pill never covers app
  // content below the menu bar).
  const [islandOpen, setIslandOpen] = useState(false);
  const collapseTimer = useRef<number | null>(null);

  const openIsland = () => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    setIslandOpen(true);
    void setRecordingBubbleExpanded(true);
  };

  const closeIslandSoon = () => {
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    collapseTimer.current = window.setTimeout(() => {
      collapseTimer.current = null;
      setIslandOpen(false);
      void setRecordingBubbleExpanded(false);
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    };
  }, []);

  useEffect(() => {
    // The window is transparent so the rounded pill edges show through.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  // Elapsed-time timer: poll Rust once a second (this pill is a separate
  // webview — it can't see the main window's recording state directly).
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      getRecordingElapsed()
        .then((s) => {
          if (!cancelled) setElapsed(s);
        })
        .catch(() => {});
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Per-channel loudness poll (~8 Hz) so each waveform tracks its own speaker.
  useEffect(() => {
    const id = window.setInterval(() => {
      getAudioLevels()
        .then(setLevels)
        .catch(() => {});
    }, 130);
    return () => window.clearInterval(id);
  }, []);

  // Live caption for the expressive island: the app broadcasts `live-transcript`
  // to every webview while recording, so the pill just subscribes. Minimal mode
  // never expands, so it skips the listener.
  useEffect(() => {
    if (!expressive) return;
    const unlisten = listen<{ text: string }>("live-transcript", (e) => {
      const text = e.payload?.text?.trim();
      if (text) setCaption(text);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [expressive]);

  // Stop uses the same signal as the tray/hotkey — the MAIN window owns the stop
  // + transcribe/summarize pipeline, so we let it handle it (handleToggle stops
  // when recording). Then bring the app forward so the user sees the result;
  // Rust closes this pill once recording ends.
  // Screen position at mousedown, so a click (no movement) returns to the app
  // while an actual drag just moves the window (it never triggers the return).
  const downPos = useRef<{ x: number; y: number } | null>(null);

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Route through Rust: a JS emit from this separate pill webview doesn't
    // reliably reach the (usually minimized) main window, so Stop appeared to do
    // nothing. The command emits the tray toggle from Rust — the proven path the
    // tray/hotkey use — and brings the app forward so the user sees the result.
    await bubbleStopRecording();
  };

  // Drag the frameless pill with the OS-native window drag (handles the cursor
  // leaving this tiny window mid-drag, which a manual JS drag can't).
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // left button only
    downPos.current = { x: e.screenX, y: e.screenY };
    // Rust focuses the unfocused pill window, then starts the OS drag (macOS
    // won't drag an unfocused window — the root cause of the pill being stuck).
    void bubbleStartDrag();
  };

  const handleClick = (e: React.MouseEvent) => {
    const d = downPos.current;
    // Only a genuine click (negligible movement) returns to the app.
    if (d && Math.hypot(e.screenX - d.x, e.screenY - d.y) < 5) {
      void focusMainWindow();
    }
  };

  const time = elapsed === null ? "" : formatElapsed(elapsed);

  // ---- Notch-docked minimal pill: the center column (--nw) sits behind the
  //      hardware notch; content lives in the left/right wings beside it. ----
  if (!expressive && notch) {
    return (
      <div
        className="notch-dock"
        style={
          {
            "--nw": `${notchWidth}px`,
            "--nh": `${notchHeight}px`,
            "--wing": `${wing}px`,
          } as React.CSSProperties
        }
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        title="Drag to move · click to return to Adversaria"
      >
        <div className="notch-island">
          <span className="notch-wing notch-wing-l">
            <span className="record-pill-dot" aria-hidden="true" />
            <span className="record-pill-time">{time}</span>
          </span>
          <span className="notch-gap" aria-hidden="true" />
          <span className="notch-wing notch-wing-r">
            <Waveform level={Math.max(levels[0], levels[1])} />
            <button
              className="record-pill-stop"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={handleStop}
              title="Stop & summarize"
              aria-label="Stop recording"
            >
              <Square size={9} fill="currentColor" aria-hidden="true" />
            </button>
          </span>
        </div>
      </div>
    );
  }

  // ---- Notch-docked expressive island: the notch row (top strip) reserves
  //      the center column; rich content sits below the notch line. ----
  if (expressive && notch) {
    return (
      <div
        className="notch-dock"
        style={
          {
            "--nw": `${notchWidth}px`,
            "--nh": `${notchHeight}px`,
            "--wing": `${wing}px`,
          } as React.CSSProperties
        }
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onMouseEnter={openIsland}
        onMouseLeave={closeIslandSoon}
        title="Hover for controls · click to return to Adversaria"
      >
        <div className="notch-island notch-island-expressive">
          <div className="notch-strip">
            <span className="notch-wing notch-wing-l">
              <span className="record-pill-dot" aria-hidden="true" />
              <span className="isl-time">{time}</span>
            </span>
            <span className="notch-gap" aria-hidden="true" />
            <span className="notch-wing notch-wing-r">
              <Waveform level={levels[1]} />
              <Waveform variant="them" level={levels[0]} />
            </span>
          </div>
          {islandOpen && (
            <div className="notch-body">
              <div className="isl-cap">
                {caption ? caption : <span className="isl-idle">Listening…</span>}
              </div>
              <div className="isl-wave-row">
                <Waveform level={levels[1]} />
                <Waveform variant="them" level={levels[0]} />
                <button
                  className="isl-stop"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={handleStop}
                  title="Stop & summarize"
                  aria-label="Stop recording"
                >
                  <Square size={11} fill="currentColor" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!expressive) {
    // ---- Minimal pill (shipped in 0.3.51) ----
    return (
      <div
        className="record-pill"
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        title="Drag to move · click to return to Adversaria"
      >
        <span className="record-pill-left">
          <span className="record-pill-dot" aria-hidden="true" />
          <span className="record-pill-time">{time}</span>
        </span>
        <span className="record-pill-right">
          <Waveform level={Math.max(levels[0], levels[1])} />
          <button
            className="record-pill-stop"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleStop}
            title="Stop & summarize"
            aria-label="Stop recording"
          >
            <Square size={9} fill="currentColor" aria-hidden="true" />
          </button>
        </span>
      </div>
    );
  }

  // ---- Expressive island: a persistent, richer HUD ----
  // The whole window is the opaque black island (no large transparent area —
  // macOS/Tauri can't make CSS-transparent regions click-through, so a big
  // see-through pill would block the call behind it). It floats over the call
  // as a non-activating NSPanel (Rust side) showing title, timer, the live
  // caption, both channels, and a one-tap Stop.
  return (
    <div
      className="record-island"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      title="Drag to move · click to return to Adversaria"
    >
      <div className="isl-top">
        <span className="isl-ico" aria-hidden="true">
          <span className="record-pill-dot" />
        </span>
        <div className="isl-t">
          <div className="isl-a">Recording</div>
          <div className="isl-b">local only</div>
        </div>
        <span className="isl-time">{time}</span>
      </div>

      <div className="isl-cap">
        {caption ? caption : <span className="isl-idle">Listening…</span>}
      </div>

      <div className="isl-wave-row">
        <Waveform level={levels[1]} />
        <Waveform variant="them" level={levels[0]} />
        <button
          className="isl-stop"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleStop}
          title="Stop & summarize"
          aria-label="Stop recording"
        >
          <Square size={11} fill="currentColor" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
