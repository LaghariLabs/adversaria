import { useEffect, useState } from "react";
import type { RecordingStatus } from "../hooks/useRecording";

interface RecordingControlsProps {
  status: RecordingStatus;
  onStart: () => void;
  onStop: () => void;
}

/** Format elapsed seconds as M:SS. */
function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function RecordingControls({
  status,
  onStart,
  onStop,
}: RecordingControlsProps) {
  const [elapsed, setElapsed] = useState(0);

  // Run a 1s timer only while recording; reset whenever we leave that state.
  useEffect(() => {
    if (status !== "recording") {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  const isRecording = status === "recording";
  // Transcription now runs in the background (the queue), so "busy" is just the
  // brief stop — the button frees up right after, ready for the next meeting.
  const isBusy = status === "stopping";
  const busyLabel = "Stopping…";

  return (
    <div className="recording-bar">
      {isBusy ? (
        <button
          className="record-btn-glass active"
          disabled
          aria-label={busyLabel}
        >
          <span aria-hidden="true" className="record-dot-pulse" />
          <div aria-hidden="true" className="record-wave-container">
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
          </div>
          <span>{busyLabel}</span>
        </button>
      ) : isRecording ? (
        <button
          onClick={onStop}
          aria-label="Stop recording"
          className="record-btn-glass active"
        >
          <span aria-hidden="true" className="record-dot-pulse" />
          <div aria-hidden="true" className="record-wave-container">
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
          </div>
          <span>
            Stop &amp; Summarize Note
            <span className="opacity-70"> · </span>
            <span className="tabular-nums">{formatElapsed(elapsed)}</span>
          </span>
        </button>
      ) : (
        <button
          onClick={onStart}
          aria-label="Start recording"
          className="record-btn-glass"
        >
          <span aria-hidden="true" className="record-dot-pulse" />
          <div aria-hidden="true" className="record-wave-container">
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
            <span className="record-wave-bar" />
          </div>
          <span>Record Meeting</span>
        </button>
      )}
    </div>
  );
}
