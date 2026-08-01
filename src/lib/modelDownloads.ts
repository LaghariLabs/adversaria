/**
 * Shared vocabulary for the pinned model-download pipeline (SPEC V3 addendum).
 *
 * Every downloadable model — transcription and notes alike — goes through the
 * same `start_model_download` / `get_model_download_status` pair, keyed by a
 * profile id. Transcription ids are `whisper-main`, `whisper-live` and
 * `whisper-model:<key>`; anything else writes meeting notes.
 */
import type { ModelDownloadStatus } from "../types";

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
