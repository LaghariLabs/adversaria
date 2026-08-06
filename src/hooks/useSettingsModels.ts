import { useCallback, useEffect, useMemo, useState } from "react";
import type { MutableRefObject } from "react";

import type { AppConfig, ModelDownloadStatus, SetupStatus, WhisperModelInfo } from "../types";
import {
  getConfig,
  getSetupStatus,
  listWhisperModels,
  setLocalModelProfile,
  updateConfig,
} from "../lib/tauri";
import { WHISPER_MODEL_PREFIX, whisperModelId } from "../lib/modelDownloads";
import { useModelDownloads } from "./useModelDownloads";

export interface SettingsModels {
  setup: SetupStatus | null;
  whisperModels: WhisperModelInfo[];
  whisperMsg: string;
  setWhisperMsg: (msg: string) => void;
  modelMsg: string;
  setModelMsg: (msg: string) => void;
  modelSwitching: boolean;
  downloads: Record<string, ModelDownloadStatus>;
  beginDownload: (profileId: string, onError: (msg: string) => void) => Promise<void>;
  switchLocalModel: (profileId: string) => Promise<void>;
  activateWhisperModel: (key: string) => Promise<void>;
  refreshSetup: () => Promise<void>;
}

/**
 * The model layer shared by the Transcription, Notes and Setup-status sections:
 * the curated whisper list, the notes-profile setup, and the one download state
 * machine that serves both.
 *
 * Mounted ONCE by the Settings shell. Each section reading its own copy would
 * duplicate the poller and split the completion-gating set — see
 * `useModelDownloads` and docs/SETTINGS_REDESIGN.md.
 *
 * @param configRef Live mirror of the in-memory config. Immediate writes merge
 *   onto `configRef.current`, never onto a fresh disk read: handing the shell the
 *   whole disk copy is what wiped unsaved edits in every other tab (2026-08-03).
 * @param replaceConfig Applies a merged config to the shell's state.
 * @param onHealthChanged Called after a whisper download lands, so the section
 *   showing transcriber state re-probes. Kept as a callback rather than calling
 *   `useServiceHealth` here, so there is still exactly one health probe.
 */
export function useSettingsModels(
  configRef: MutableRefObject<AppConfig>,
  replaceConfig: (next: AppConfig) => void,
  onHealthChanged: () => Promise<void>,
): SettingsModels {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [whisperModels, setWhisperModels] = useState<WhisperModelInfo[]>([]);
  const [whisperMsg, setWhisperMsg] = useState("");
  const [modelMsg, setModelMsg] = useState("");
  const [modelSwitching, setModelSwitching] = useState(false);

  const loadWhisperModels = useCallback(async (): Promise<WhisperModelInfo[]> => {
    try {
      const models = await listWhisperModels();
      setWhisperModels(models);
      return models;
    } catch (e) {
      setWhisperMsg(String(e));
      return [];
    }
  }, []);

  const refreshSetup = useCallback(async () => {
    try {
      setSetup(await getSetupStatus());
    } catch {
      // Non-fatal: the notes-profile picker stays empty rather than blocking.
    }
  }, []);

  useEffect(() => {
    void refreshSetup();
    void loadWhisperModels();
  }, [refreshSetup, loadWhisperModels]);

  const switchLocalModel = useCallback(
    async (profileId: string) => {
      setModelSwitching(true);
      setModelMsg("Switching model — the on-device engine is restarting…");
      try {
        await setLocalModelProfile(profileId);
        const [cfg, next] = await Promise.all([getConfig(), getSetupStatus()]);
        // Merge back ONLY what that command rewrote (registration.rs
        // `set_selected_model_profile` writes these two). Handing Settings the
        // whole disk copy replaced its state and threw away every unsaved edit
        // in every section — including an engine the user had just picked.
        replaceConfig({
          ...configRef.current,
          ollama_model: cfg.ollama_model,
          llm_provider: cfg.llm_provider,
        });
        setSetup(next);
        setModelMsg("Model switched. It can take a minute to finish loading.");
      } catch (e) {
        setModelMsg(String(e));
      } finally {
        setModelSwitching(false);
      }
    },
    [configRef, replaceConfig],
  );

  /** Make a freshly downloaded transcription model the one in use. Written
   *  straight to disk (like the notes-model switch) — the user pressed
   *  Download; needing a second Save press to actually use it is a dead end. */
  const activateWhisperModel = useCallback(
    async (key: string) => {
      try {
        const cfg = await getConfig();
        await updateConfig({ ...cfg, whisper_model: key });
        // Disk gets the fresh read-modify-write; Settings gets only the field
        // that changed, so a download landing in the background can't wipe an
        // unsaved engine switch or a half-typed API key.
        replaceConfig({ ...configRef.current, whisper_model: key });
      } catch (e) {
        setWhisperMsg(String(e));
      }
    },
    [configRef, replaceConfig],
  );

  const handleDownloadFinished = useCallback(
    async (profileId: string) => {
      if (profileId.startsWith(WHISPER_MODEL_PREFIX)) {
        const key = profileId.slice(WHISPER_MODEL_PREFIX.length);
        const models = await loadWhisperModels();
        await onHealthChanged();
        // Only take over when the configured model isn't actually here —
        // otherwise a user topping up a second model loses the one in use.
        const configured = models.find((m) => m.key === configRef.current.whisper_model);
        if (!configured?.downloaded) await activateWhisperModel(key);
        return;
      }
      await refreshSetup();
      await switchLocalModel(profileId);
    },
    [
      activateWhisperModel,
      configRef,
      loadWhisperModels,
      onHealthChanged,
      refreshSetup,
      switchLocalModel,
    ],
  );

  // Every profile whose download Settings can show: one per curated
  // transcription model, plus the pinned notes tiers (Ollama models are on disk
  // already and are never fetched through this pipeline).
  const watchedIds = useMemo(
    () => [
      ...whisperModels.map((model) => whisperModelId(model.key)),
      ...(setup?.profiles ?? [])
        .map((profile) => profile.id)
        .filter((id) => !id.startsWith("ollama:")),
    ],
    [whisperModels, setup],
  );

  const { downloads, beginDownload } = useModelDownloads(watchedIds, handleDownloadFinished);

  return {
    setup,
    whisperModels,
    whisperMsg,
    setWhisperMsg,
    modelMsg,
    setModelMsg,
    modelSwitching,
    downloads,
    beginDownload,
    switchLocalModel,
    activateWhisperModel,
    refreshSetup,
  };
}
