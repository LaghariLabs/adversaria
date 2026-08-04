import { useEffect, useRef, useState } from "react";

import type { ModelDownloadStatus, OnboardingState } from "../types";
import {
  getModelDownloadStatus,
  getOnboardingState,
  getSetupStatus,
  listWhisperModels,
} from "../lib/tauri";
import {
  ENGINE_WHISPER_IDS,
  beginModelDownload,
  downloadLabel,
  formatGb,
  isInFlight,
  isTranscriptionProfile,
  onModelDownloadStarted,
  whisperModelId,
} from "../lib/modelDownloads";

/** Brisk while something is running, a slow SAFETY heartbeat otherwise. The
 *  `onModelDownloadStarted` bus is the primary wake signal now — every UI path
 *  that starts a download announces it, and the strip polls the instant it
 *  hears one. The idle heartbeat only exists to catch a download no UI action
 *  started (e.g. resumed by the backend). It used to be 4 s, which was 96% of
 *  the sidecar log on every idle install (35,400 lines in 13 h). */
const POLL_ACTIVE_MS = 1_000;
const POLL_IDLE_MS = 60_000;
/** How long "✓ Transcription ready" stays up before the strip hides again. */
const DONE_MS = 5_000;

/** In-flight download visibility, by name (SPEC V3 addendum).
 *
 * Shows byte-accurate progress for any model download that is actually
 * running — transcription or notes, started anywhere in the app — says WHICH
 * one it is, confirms transcription once when it lands, and otherwise stays
 * invisible. It never STARTS a download; the only button here is Retry, on a
 * download that already failed. */
export function SetupStatusStrip() {
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadStatus>>({});
  const [watchedIds, setWatchedIds] = useState<string[]>([...ENGINE_WHISPER_IDS]);
  const [transcriptionDone, setTranscriptionDone] = useState(false);
  // Ids seen mid-download on the previous poll, so a completion can be noticed.
  const runningRef = useRef<Set<string>>(new Set());

  // Re-read onboarding until setup completes (the wizard finishes in a
  // sibling component this strip can't observe).
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      getOnboardingState()
        .then((next) => {
          if (alive) setOnboarding(next);
        })
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(() => {
      if (onboarding?.setup_complete) return;
      refresh();
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [onboarding?.setup_complete]);

  const active = Boolean(onboarding?.setup_complete);

  // Everything that CAN be downloading: the transcription engine pair, one id
  // per curated transcription model, and the pinned notes-model tiers. The
  // catalogue doesn't change while the app runs — but in a packaged build this
  // mounts before the sidecar has bound its port, so retry until BOTH reads
  // land or the strip stays blind to per-model downloads all session.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: number | undefined;
    const read = () => {
      Promise.allSettled([listWhisperModels(), getSetupStatus()]).then(
        ([models, setup]) => {
          if (!alive) return;
          if (models.status !== "fulfilled" && setup.status !== "fulfilled") {
            return; // sidecar still booting — the interval retries
          }
          const whisper =
            models.status === "fulfilled"
              ? models.value.map((m) => whisperModelId(m.key))
              : [];
          const llm =
            setup.status === "fulfilled"
              ? setup.value.profiles
                  .map((profile) => profile.id)
                  .filter((id) => !id.startsWith("ollama:"))
              : [];
          setWatchedIds([...ENGINE_WHISPER_IDS, ...whisper, ...llm]);
          if (models.status === "fulfilled" && setup.status === "fulfilled") {
            window.clearInterval(timer);
          }
        },
      );
    };
    read();
    timer = window.setInterval(read, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active]);

  // Only a live download earns the fast cadence — a failed one sits there until
  // the user hits Retry, and polling it every second changes nothing.
  const anyRunning = watchedIds.some((id) => {
    const status = downloads[id];
    return status ? isInFlight(status) : false;
  });

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = () => {
      Promise.all(
        watchedIds.map((id) =>
          getModelDownloadStatus(id)
            .then((status) => status)
            .catch(() => null),
        ),
      ).then((statuses) => {
        if (!alive) return;
        const next: Record<string, ModelDownloadStatus> = {};
        statuses.forEach((status) => {
          if (status) next[status.profile_id] = status;
        });
        setDownloads(next);

        // A transcription download that WAS running and now isn't gets one
        // brief confirmation, so the user sees the thing they waited for land.
        const previously = runningRef.current;
        const landed = [...previously].some(
          (id) => isTranscriptionProfile(id) && next[id]?.state === "ready",
        );
        if (landed) setTranscriptionDone(true);
        runningRef.current = new Set(
          Object.values(next)
            .filter(isInFlight)
            .map((status) => status.profile_id),
        );
      });
    };
    poll();
    const timer = window.setInterval(poll, anyRunning ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    // A download started anywhere in the app wakes the strip NOW: the immediate
    // poll sees it in flight, which flips anyRunning and re-arms the 1 s cadence.
    const unsubscribe = onModelDownloadStarted(() => poll());
    return () => {
      alive = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [active, watchedIds, anyRunning]);

  useEffect(() => {
    if (!transcriptionDone) return;
    const timer = window.setTimeout(() => setTranscriptionDone(false), DONE_MS);
    return () => window.clearTimeout(timer);
  }, [transcriptionDone]);

  if (!active) return null;

  const statuses = watchedIds
    .map((id) => downloads[id])
    .filter((status): status is ModelDownloadStatus => Boolean(status));
  const inFlight = statuses.filter(isInFlight);
  const failed = statuses.find((status) => status.state === "error");

  if (inFlight.length === 0 && !failed) {
    return transcriptionDone ? (
      <div className="setup-strip" role="status" aria-live="polite">
        <div className="setup-strip-text">
          <strong>✓ Transcription ready</strong>
          <span>Recordings turn into text on this machine from now on.</span>
        </div>
      </div>
    ) : null;
  }

  const total = inFlight.reduce((sum, status) => sum + status.total_bytes, 0);
  const done = inFlight.reduce(
    (sum, status) => sum + Math.min(status.downloaded_bytes, status.total_bytes),
    0,
  );
  const bytesLine = total > 0 ? `${formatGb(done)} of ${formatGb(total)}` : "Preparing…";

  // Say WHICH model is downloading — "Downloading in the background" told the
  // user nothing about what they were waiting for.
  const names = [...new Set(inFlight.map((status) => downloadLabel(status.profile_id)))];

  const retry = () => {
    statuses.forEach((status) => {
      if (status.state === "error") beginModelDownload(status.profile_id).catch(() => {});
    });
  };

  return (
    <div className="setup-strip" role="status" aria-live="polite">
      {failed ? (
        <>
          <div className="setup-strip-text">
            <strong>{downloadLabel(failed.profile_id)} — download failed</strong>
            <span>{failed.detail}</span>
          </div>
          <div className="setup-strip-actions">
            <button className="btn-secondary" onClick={retry}>Retry</button>
          </div>
        </>
      ) : (
        <>
          <div className="setup-strip-text">
            <strong>{names.join(" and ")} downloading — Adversaria stays usable.</strong>
            <span>{bytesLine}</span>
          </div>
          {total > 0 ? <progress value={done} max={total} /> : <progress />}
        </>
      )}
    </div>
  );
}
