/**
 * Shared vocabulary for the pinned model-download pipeline (SPEC V3 addendum).
 *
 * Every downloadable model — transcription and notes alike — goes through the
 * same `start_model_download` / `get_model_download_status` pair, keyed by a
 * profile id. Transcription ids are `whisper-main`, `whisper-live` and
 * `whisper-model:<key>`; anything else writes meeting notes.
 */
import type { ModelDownloadStatus } from "../types";
import { startModelDownload } from "./tauri";

/** The transcription engine's own pair (main pass + live captions). */
export const ENGINE_WHISPER_IDS = ["whisper-live", "whisper-main"] as const;

/** Prefix of the per-model transcription ids listed in Settings. */
export const WHISPER_MODEL_PREFIX = "whisper-model:";

/** Download states that mean "something is happening right now". */
const IN_FLIGHT = ["preparing", "downloading", "verifying"];

/** Profile id for one curated transcription model key (e.g. "large-v3"). */
export function whisperModelId(key: string): string {
  return `${WHISPER_MODEL_PREFIX}${key}`;
}

export function isTranscriptionProfile(profileId: string): boolean {
  return profileId.startsWith("whisper");
}

/** What a person calls this download — never the profile id. */
export function downloadLabel(profileId: string): string {
  return isTranscriptionProfile(profileId)
    ? "Transcription model"
    : "Meeting notes model";
}

export function isInFlight(status: ModelDownloadStatus): boolean {
  return IN_FLIGHT.includes(status.state);
}

export function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

// ---- Download-start event bus ----------------------------------------------
//
// Pollers used to hammer the status endpoints every few seconds forever just in
// case a download had started somewhere (96% of the sidecar log on an idle
// install). Instead, every UI code path starts downloads through
// `beginModelDownload`, which pings subscribers the moment one begins — so
// pollers can idle on a slow safety heartbeat and still react instantly.

type ModelDownloadStartedListener = (profileId: string) => void;

const startListeners = new Set<ModelDownloadStartedListener>();

/** Subscribe to download starts. Returns the unsubscribe function. */
export function onModelDownloadStarted(fn: ModelDownloadStartedListener): () => void {
  startListeners.add(fn);
  return () => {
    startListeners.delete(fn);
  };
}

/** The one way the UI starts a model download: kicks the backend and notifies
 *  every subscriber synchronously — even if the call later fails, since a poll
 *  that finds nothing running is cheap, while a poller that never wakes is the
 *  bug. Callers still get the backend's promise. */
export function beginModelDownload(profileId: string): Promise<ModelDownloadStatus> {
  const started = startModelDownload(profileId);
  started
    .catch(() => {}) // never an unhandled rejection if a caller fires-and-forgets
    .finally(() => {
      // Second ping once the backend has actually registered (or refused) the
      // download: the synchronous ping below can race the start command, and a
      // poll that lands too early sees nothing running — which would park the
      // pollers back on the slow heartbeat while bytes are already flowing.
      startListeners.forEach((fn) => fn(profileId));
    });
  startListeners.forEach((fn) => fn(profileId));
  return started;
}

/** Aggregate percentage across several downloads, or null when sizes are unknown. */
export function aggregatePercent(statuses: ModelDownloadStatus[]): number | null {
  const total = statuses.reduce((sum, status) => sum + status.total_bytes, 0);
  if (total <= 0) return null;
  const done = statuses.reduce(
    (sum, status) => sum + Math.min(status.downloaded_bytes, status.total_bytes),
    0,
  );
  return Math.min(100, Math.round((done / total) * 100));
}
