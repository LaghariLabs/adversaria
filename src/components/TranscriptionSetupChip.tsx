import type { TranscriptionSetup } from "../hooks/useTranscriptionSetup";

interface TranscriptionSetupChipProps {
  setup: TranscriptionSetup;
  /** Open Settings › AI Model, where transcription models are managed. */
  onOpenModelSettings: () => void;
}

/** Persistent guide chip in the app chrome (SPEC V3 addendum §1).
 *
 * Nothing downloads on its own any more, so the chrome has to keep saying what
 * is missing — and stay clickable until it is fixed. It disappears the moment
 * transcription is ready, and never appears when the app cannot tell (an older
 * service, or one that hasn't answered yet). */
export function TranscriptionSetupChip({
  setup,
  onOpenModelSettings,
}: TranscriptionSetupChipProps) {
  if (setup.state === "ready" || setup.state === "unknown") return null;

  const label =
    setup.state === "downloading"
      ? `Setting up transcription${setup.percent === null ? "…" : ` — ${setup.percent}%`}`
      : setup.state === "failed"
        ? "Transcription setup failed — Fix"
        : setup.state === "loading"
          ? "Starting transcription engine…"
          : "Transcription model needed — Set up";

  const color =
    setup.state === "failed"
      ? "var(--accent-red)"
      : setup.state === "downloading" || setup.state === "loading"
        ? "var(--accent-blue)"
        : "var(--accent-amber)";

  return (
    <button
      type="button"
      className="chrome-chip chrome-chip-guide"
      onClick={onOpenModelSettings}
      style={{ color }}
      title={setup.detail || "Open the model settings to finish setting up transcription."}
    >
      <span className="chrome-chip-dot" style={{ backgroundColor: color }} />
      {label}
    </button>
  );
}
