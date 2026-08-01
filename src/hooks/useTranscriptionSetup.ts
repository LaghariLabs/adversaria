import { useCallback, useEffect, useMemo, useState } from "react";

import type { HealthResponse, ModelDownloadStatus } from "../types";
import {
  checkServiceHealth,
  getModelDownloadStatus,
  listWhisperModels,
  startModelDownload,
} from "../lib/tauri";
import {
  ENGINE_WHISPER_IDS,
  aggregatePercent,
  isInFlight,
  whisperModelId,
} from "../lib/modelDownloads";

/** What the app can honestly say about on-device transcription right now.
 *
 * `unknown` is its own state on purpose: an older service (no
 * `transcriber_state`) or an unreachable one must never be reported as
 * "model missing" — the app says nothing rather than something false. */
export type TranscriptionSetupState =
  | "unknown"
  | "ready"
  | "loading"
  | "missing"
  | "downloading"
  | "failed";

export interface TranscriptionSetup {
  state: TranscriptionSetupState;
  /** 0–100 while a transcription model downloads; null when sizes are unknown. */
  percent: number | null;
  /** Human sentence explaining a non-ready state ("" when there is nothing to add). */
  detail: string;
  /** Whether the last health poll reached the on-device service. */
  serviceOnline: boolean | null;
  /** Re-check health (and, when relevant, download progress) immediately. */
  refresh: () => void;
  /** Restart every transcription download that failed. */
  retry: () => void;
}

/** Health poll cadence: relaxed once transcription is ready, brisk while the
 *  user is waiting on it (that is when the guide chip has something to say). */
const HEALTH_MS_READY = 20_000;
const HEALTH_MS_WAITING = 4_000;
const DOWNLOAD_MS = 1_000;

/**
 * Single source of truth for "can this machine transcribe yet?" (SPEC V3).
 *
 * Reads `/health`'s `transcriber_state` and — only while that is anything but
 * `ready` — the byte progress of the transcription download profiles. Nothing
 * here ever STARTS a download: the app guides, the user clicks.
 */
export function useTranscriptionSetup(): TranscriptionSetup {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [serviceOnline, setServiceOnline] = useState<boolean | null>(null);
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadStatus>>({});
  // null = catalogue not fetched yet (the sidecar may still be booting).
  const [modelKeys, setModelKeys] = useState<string[] | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Every profile id that can hold the transcription weights: the engine pair
  // plus one per curated model in the picker.
  const whisperIds = useMemo(
    () => [...ENGINE_WHISPER_IDS, ...(modelKeys ?? []).map(whisperModelId)],
    [modelKeys],
  );

  // The catalogue is static once read — but in a packaged build this hook
  // mounts BEFORE the sidecar has bound its port, so a one-shot fetch left
  // the chip and strip blind to per-model downloads for the whole session.
  // Retry until it lands: when the service comes online, and on manual refresh.
  useEffect(() => {
    if (modelKeys !== null) return;
    let alive = true;
    listWhisperModels()
      .then((models) => {
        if (alive) setModelKeys(models.map((model) => model.key));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [modelKeys, serviceOnline, tick]);

  // A pre-V3 service omits the field; normalize a defensive null to undefined
  // so "unknown" can never be mistaken for "not ready" (which fast-polls).
  const transcriberState = health?.transcriber_state ?? undefined;

  useEffect(() => {
    let alive = true;
    const ping = () =>
      checkServiceHealth()
        .then((next) => {
          if (!alive) return;
          setHealth(next);
          setServiceOnline(true);
        })
        .catch(() => {
          if (!alive) return;
          setHealth(null);
          setServiceOnline(false);
        });
    ping();
    const timer = window.setInterval(
      ping,
      transcriberState === "ready" ? HEALTH_MS_READY : HEALTH_MS_WAITING,
    );
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [transcriberState === "ready", tick]);

  // Byte progress is only worth asking for while transcription is NOT ready —
  // a settled machine polls nothing at all.
  const watchDownloads = transcriberState !== undefined && transcriberState !== "ready";

  useEffect(() => {
    if (!watchDownloads) return;
    let alive = true;
    const poll = () => {
      whisperIds.forEach((id) => {
        getModelDownloadStatus(id)
          .then((status) => {
            if (alive) setDownloads((current) => ({ ...current, [id]: status }));
          })
          .catch(() => {});
      });
    };
    poll();
    const timer = window.setInterval(poll, DOWNLOAD_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [watchDownloads, whisperIds, tick]);

  const statuses = whisperIds
    .map((id) => downloads[id])
    .filter((status): status is ModelDownloadStatus => Boolean(status));
  const running = statuses.filter(isInFlight);
  const failed = statuses.find((status) => status.state === "error");

  // A live download outranks health: the service still reports "missing" for
  // the whole fetch, and "Downloading 62 %" is the truer sentence.
  let state: TranscriptionSetupState;
  if (running.length > 0) state = "downloading";
  else if (failed) state = "failed";
  else if (transcriberState === "ready") state = "ready";
  else if (transcriberState === "loading") state = "loading";
  else if (transcriberState === "error") state = "failed";
  else if (transcriberState === "missing") state = "missing";
  else state = "unknown";

  const retry = useCallback(() => {
    whisperIds.forEach((id) => {
      if (downloads[id]?.state === "error") {
        startModelDownload(id).catch(() => {});
      }
    });
  }, [whisperIds, downloads]);

  return {
    state,
    percent: running.length > 0 ? aggregatePercent(running) : null,
    detail: failed?.detail || health?.transcriber_detail || "",
    serviceOnline,
    refresh,
    retry,
  };
}
