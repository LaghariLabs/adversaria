import { useEffect, useRef, useState } from "react";

import type { ModelDownloadStatus } from "../types";
import { getModelDownloadStatus } from "../lib/tauri";
import { beginModelDownload, isInFlight } from "../lib/modelDownloads";

export interface ModelDownloads {
  /** Backend-owned download state per watched profile id. */
  downloads: Record<string, ModelDownloadStatus>;
  /** True while any watched profile is mid-download. */
  anyRunning: boolean;
  /** Start a download and mark it eligible to auto-activate on completion. */
  beginDownload: (profileId: string, onError: (msg: string) => void) => Promise<void>;
}

/**
 * The model-download pipeline: re-attach, poll, and fire a completion callback
 * exactly once per download this session.
 *
 * **This is one state machine and it must stay one.** The redesigned Settings
 * splits transcription models and notes profiles into separate sections, and the
 * Setup-status section wants to display both. Giving each section its own copy
 * of this hook is wrong three ways: it doubles `get_model_download_status`
 * traffic, it splits `activating` so a completion is seen by the wrong owner (a
 * finished model either steals the one in use or never activates), and the
 * consumers can disagree about the same download. Mount it ONCE, above the
 * sections, and pass `downloads` down.
 *
 * Progress is deliberately not cached across mounts: every poll asks the backend,
 * so leaving Settings mid-download and coming back re-attaches to where the
 * download actually is rather than where this component last saw it.
 *
 * @param watchedIds Profile ids to follow. Must be referentially stable
 *   (`useMemo`) — it drives the poll effect.
 * @param onFinished Called once, per id, on an in-flight → `ready` transition,
 *   and ONLY for ids seen in flight during this session. A profile that was
 *   already finished at mount must never auto-activate: that is what stops a
 *   previously-downloaded model from hijacking the one the user is using.
 */
export function useModelDownloads(
  watchedIds: string[],
  onFinished: (profileId: string) => void | Promise<void>,
): ModelDownloads {
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadStatus>>({});
  const activating = useRef<Set<string>>(new Set());
  // Read through a ref so a new callback identity does not restart the poll.
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const anyRunning = watchedIds.some((id) => {
    const status = downloads[id];
    return status ? isInFlight(status) : false;
  });

  useEffect(() => {
    if (watchedIds.length === 0) return;
    let alive = true;
    const poll = () => {
      watchedIds.forEach((id) => {
        getModelDownloadStatus(id)
          .then((status) => {
            if (!alive) return;
            setDownloads((current) => ({ ...current, [id]: status }));
            if (isInFlight(status)) {
              activating.current.add(id);
            } else if (status.state === "ready" && activating.current.has(id)) {
              activating.current.delete(id);
              void finishedRef.current(id);
            }
          })
          .catch(() => {});
      });
    };
    poll();
    // Idle machines poll once and stop; only a live download earns an interval.
    if (!anyRunning) {
      return () => {
        alive = false;
      };
    }
    const timer = window.setInterval(poll, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [watchedIds, anyRunning]);

  const beginDownload = async (profileId: string, onError: (msg: string) => void) => {
    try {
      const status = await beginModelDownload(profileId);
      activating.current.add(profileId);
      setDownloads((current) => ({ ...current, [profileId]: status }));
    } catch (e) {
      onError(String(e));
    }
  };

  return { downloads, anyRunning, beginDownload };
}
