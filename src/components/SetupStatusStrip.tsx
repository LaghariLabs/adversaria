import { useEffect, useRef, useState } from "react";

import type { ModelDownloadStatus, OnboardingState } from "../types";
import {
  getModelDownloadStatus,
  getOnboardingState,
  startModelDownload,
} from "../lib/tauri";
import { ENGINE_WHISPER_IDS } from "./Welcome";

function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** In-flight download visibility, nothing else (SPEC v2).
 *
 * Shows the byte-accurate aggregate for model downloads that are actually
 * running — the background Whisper cache disclosed during setup, plus any
 * model download the user started from Settings › AI Model — and disappears
 * when nothing is in flight. It never STARTS an LLM download (downloads begin
 * only from an explicit click in Settings); it only resumes the Whisper cache
 * after a relaunch, which is a no-op when already cached. */
export function SetupStatusStrip() {
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadStatus>>({});
  const whisperKicked = useRef(false);

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

  // Watched ids: the Whisper pair always (resume-kicked once, a no-op when
  // cached) plus the persisted model profile IF it is a downloadable pinned id
  // — so a Settings-started download stays visible after leaving Settings.
  const profile = onboarding?.selected_model_profile ?? "";
  const watchedIds =
    profile && !profile.startsWith("ollama:") && profile !== "legacy-existing-setup"
      ? [...ENGINE_WHISPER_IDS, profile]
      : [...ENGINE_WHISPER_IDS];

  useEffect(() => {
    if (!active) return;
    if (!whisperKicked.current) {
      whisperKicked.current = true;
      ENGINE_WHISPER_IDS.forEach((id) => {
        startModelDownload(id).catch(() => {});
      });
    }
    const poll = () => {
      watchedIds.forEach((id) => {
        getModelDownloadStatus(id)
          .then((status) => {
            setDownloads((current) => ({ ...current, [id]: status }));
          })
          .catch(() => {});
      });
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => window.clearInterval(timer);
  }, [active, profile]);

  if (!active) return null;

  const statuses = watchedIds
    .map((id) => downloads[id])
    .filter((status): status is ModelDownloadStatus => Boolean(status));
  const inFlight = statuses.filter((status) =>
    ["preparing", "downloading", "verifying"].includes(status.state),
  );
  const failed = statuses.find((status) => status.state === "error");

  // Nothing running and nothing failed → invisible. This is the normal state.
  if (inFlight.length === 0 && !failed) return null;

  const total = inFlight.reduce((sum, status) => sum + status.total_bytes, 0);
  const done = inFlight.reduce(
    (sum, status) => sum + Math.min(status.downloaded_bytes, status.total_bytes),
    0,
  );

  const retry = () => {
    watchedIds.forEach((id) => {
      if (downloads[id]?.state === "error") {
        startModelDownload(id).catch(() => {});
      }
    });
  };

  return (
    <div className="setup-strip" role="status" aria-live="polite">
      {failed ? (
        <>
          <div className="setup-strip-text">
            <strong>{failed.detail}</strong>
            <span>{total > 0 ? `${formatGb(done)} / ${formatGb(total)}` : ""}</span>
          </div>
          <button className="btn-secondary" onClick={retry}>Retry</button>
        </>
      ) : (
        <>
          <div className="setup-strip-text">
            <strong>Downloading in the background — Adversaria stays usable.</strong>
            <span>{total > 0 ? `${formatGb(done)} / ${formatGb(total)}` : "Preparing…"}</span>
          </div>
          {total > 0 ? <progress value={done} max={total} /> : <progress />}
        </>
      )}
    </div>
  );
}
