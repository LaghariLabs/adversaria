import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { TriangleAlert } from "lucide-react";

import type {
  AppConfig,
  HealthResponse,
  ModelDownloadStatus,
  SetupStatus,
  WhisperModelInfo,
} from "../../types";
import { EngineInstallCard } from "../EngineInstallCard";
import {
  checkServiceHealth,
  getConfig,
  getModelDownloadStatus,
  getSetupStatus,
  listWhisperModels,
  setLocalModelProfile,
  startModelDownload,
  testLlmConnection,
  updateConfig,
} from "../../lib/tauri";
import {
  WHISPER_MODEL_PREFIX,
  aggregatePercent,
  formatGb,
  isInFlight,
  whisperModelId,
} from "../../lib/modelDownloads";

// Per-provider hints so the simplified engine picker can stay tidy.
const MODEL_PLACEHOLDER: Record<string, string> = {
  groq: "qwen/qwen3-32b",
  grok: "grok-3",
  openrouter: "qwen/qwen3.6-35b",
  deepseek: "deepseek-v4-pro",
  custom: "model-name",
  local: "qwen3.5-4b-4bit",
};

const PROVIDER_LABEL: Record<string, string> = {
  groq: "Groq",
  grok: "xAI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  custom: "an external service",
};

// The local LLM model name is OS-specific: macOS serves it via Rapid-MLX under
// the alias `qwen3.6-35b`; Windows uses the Ollama tag `qwen3.6:35b-a3b`. Pick
// the right one so switching to "Local" sets a model the local server actually
// has (otherwise the request 404s with "model … does not exist").
const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform || navigator.userAgent || "");
const LOCAL_DEFAULT_MODEL = IS_MAC ? "qwen3.5-4b-4bit" : "qwen3.6:35b-a3b";

// Default model for each provider, applied when the user switches engine so the
// model name always matches the selected provider.
const DEFAULT_MODEL: Record<string, string> = {
  groq: "qwen/qwen3-32b",
  grok: "grok-3",
  openrouter: "qwen/qwen3.6-35b",
  deepseek: "deepseek-v4-pro",
  local: LOCAL_DEFAULT_MODEL,
};

interface AiModelTabProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  /** Replace the whole config in the parent (used after the backend rewrites it). */
  replaceConfig: (next: AppConfig) => void;
}

/**
 * AI Model — the model dashboard: transcription first, then the notes model
 * (SPEC V3 addendum).
 *
 * Both families download through the same pinned pipeline, and the pipeline's
 * state lives in the backend — so this tab RE-ATTACHES to whatever is running
 * when it mounts instead of owning the progress itself. Leaving Settings
 * mid-download and coming back now shows the same bar, and a download that
 * finishes while you're away still ends up in use.
 *
 * Downloads start ONLY from an explicit button — and on platforms whose managed
 * engine isn't installed, that click first surfaces the transparent
 * install-plan consent card. API providers are first-class: their key/model
 * fields render inline, not behind a disclosure.
 */
export function AiModelTab({ active, config, update, replaceConfig }: AiModelTabProps) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  // Backend-owned download state for every watched profile, transcription and
  // notes alike, keyed by profile id.
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadStatus>>({});
  const [whisperModels, setWhisperModels] = useState<WhisperModelInfo[]>([]);
  const [whisperMsg, setWhisperMsg] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthStatus, setHealthStatus] = useState<
    "checking" | "ok" | "degraded" | "unreachable"
  >("checking");
  // Profiles seen mid-download during THIS mount. Only those may auto-activate
  // on completion — a profile that was already finished when the tab mounted
  // must never hijack the model the user is actually using.
  const activatingRef = useRef<Set<string>>(new Set());
  // Read inside stable callbacks so a keystroke in another tab doesn't restart
  // the download poll.
  const configRef = useRef(config);
  configRef.current = config;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Which profile the dropdown is showing (not necessarily in use yet).
  const [chosenId, setChosenId] = useState<string | null>(null);
  // Windows: a Download click on a pinned tier first opens the engine consent
  // card; the model download follows only after the engine install succeeds.
  const [engineConsentFor, setEngineConsentFor] = useState<string | null>(null);

  const [llmTest, setLlmTest] = useState<{
    status: "idle" | "testing" | "ok" | "error";
    msg: string;
  }>({ status: "idle", msg: "" });

  const handleTestLlm = async () => {
    setLlmTest({ status: "testing", msg: "" });
    try {
      const msg = await testLlmConnection(config.llm_base_url, config.llm_api_key);
      setLlmTest({ status: "ok", msg });
    } catch (e) {
      setLlmTest({ status: "error", msg: String(e) });
    }
  };

  const checkHealth = useCallback(async () => {
    try {
      const next = await checkServiceHealth();
      setHealth(next);
      setHealthStatus(next.status === "ok" ? "ok" : "degraded");
    } catch {
      setHealth(null);
      setHealthStatus("unreachable");
    }
  }, []);

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

  useEffect(() => {
    getSetupStatus().then(setSetup).catch(() => {});
    loadWhisperModels();
    checkHealth();
  }, [checkHealth, loadWhisperModels]);

  const switchLocalModel = useCallback(
    async (profileId: string) => {
      setModelSwitching(true);
      setModelMsg("Switching model — the on-device engine is restarting…");
      try {
        await setLocalModelProfile(profileId);
        const [cfg, next] = await Promise.all([getConfig(), getSetupStatus()]);
        replaceConfig(cfg);
        setSetup(next);
        setModelMsg("Model switched. It can take a minute to finish loading.");
      } catch (e) {
        setModelMsg(String(e));
      } finally {
        setModelSwitching(false);
      }
    },
    [replaceConfig],
  );

  /** Make a freshly downloaded transcription model the one in use. Written
   *  straight to disk (like the notes-model switch) — the user pressed
   *  Download; needing a second Save press to actually use it is a dead end. */
  const activateWhisperModel = useCallback(
    async (key: string) => {
      try {
        const cfg = await getConfig();
        const next = { ...cfg, whisper_model: key };
        await updateConfig(next);
        replaceConfig(next);
      } catch (e) {
        setWhisperMsg(String(e));
      }
    },
    [replaceConfig],
  );

  const handleDownloadFinished = useCallback(
    async (profileId: string) => {
      if (profileId.startsWith(WHISPER_MODEL_PREFIX)) {
        const key = profileId.slice(WHISPER_MODEL_PREFIX.length);
        const models = await loadWhisperModels();
        await checkHealth();
        // Only take over when the configured model isn't actually here —
        // otherwise a user topping up a second model loses the one in use.
        const configured = models.find((m) => m.key === configRef.current.whisper_model);
        if (!configured?.downloaded) await activateWhisperModel(key);
        return;
      }
      setSetup(await getSetupStatus());
      await switchLocalModel(profileId);
    },
    [activateWhisperModel, checkHealth, loadWhisperModels, switchLocalModel],
  );

  // Every profile whose download this tab can show: one per curated
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

  const anyRunning = watchedIds.some((id) => {
    const status = downloads[id];
    return status ? isInFlight(status) : false;
  });

  // Re-attach on mount, then follow anything that is running. Progress is NOT
  // component state: it is asked for fresh, so navigating away mid-download and
  // coming back picks the same download up where it actually is.
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
              activatingRef.current.add(id);
            } else if (status.state === "ready" && activatingRef.current.has(id)) {
              activatingRef.current.delete(id);
              void handleDownloadFinished(id);
            }
          })
          .catch(() => {});
      });
    };
    poll();
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
  }, [watchedIds, anyRunning, handleDownloadFinished]);

  const beginDownload = async (profileId: string, onError: (msg: string) => void) => {
    try {
      const status = await startModelDownload(profileId);
      activatingRef.current.add(profileId);
      setDownloads((current) => ({ ...current, [profileId]: status }));
    } catch (e) {
      onError(String(e));
    }
  };

  const downloadLocalModel = async (profileId: string) => {
    setModelMsg("");
    // Consent gate (SPEC v2/§D): a pinned tier on a platform without the
    // managed engine shows the install plan BEFORE anything downloads.
    if (
      setup &&
      setup.platform !== "macos" &&
      !setup.managed_engine_installed &&
      !profileId.startsWith("ollama:")
    ) {
      setEngineConsentFor(profileId);
      return;
    }
    await beginDownload(profileId, setModelMsg);
  };

  const downloadWhisper = async (key: string) => {
    setWhisperMsg("");
    await beginDownload(whisperModelId(key), setWhisperMsg);
  };

  const isCloud = config.llm_provider !== "local";
  const deviceLabel = setup?.platform === "macos" ? "Mac" : "PC";

  const profiles = setup?.profiles ?? [];
  const inUse = profiles.find((p) => p.model_alias === config.ollama_model);
  const recommended = profiles.find((p) => p.recommended);
  const chosen =
    profiles.find((p) => p.id === chosenId) ?? inUse ?? recommended ?? profiles[0];
  const profileDownload = chosen ? downloads[chosen.id] ?? null : null;
  const chosenDownloading = Boolean(profileDownload && isInFlight(profileDownload));

  // Transcription: what's on this machine, what state the engine is in.
  const usesCloudTranscription = config.transcription_base_url.trim() !== "";
  const transcriberState = health?.transcriber_state;
  const transcriptionChip =
    transcriberState === "ready"
      ? { text: "Ready ✓", tone: "ok" }
      : transcriberState === "loading"
        ? { text: "Starting up…", tone: "" }
        : transcriberState === "error"
          ? { text: health?.transcriber_detail || "Needs attention", tone: "err" }
          : transcriberState === "missing"
            ? { text: "No model downloaded yet", tone: "warn" }
            : null;

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`} data-tour="ai-model">
      <h3 className="settings-card-title">AI Model</h3>
      <p className="settings-card-desc">
        The two models Adversaria uses: one turns speech into text, the other
        turns that text into notes. Nothing is fetched until you press Download.
      </p>

      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Transcription</h3>
      <p className="settings-card-desc">
        The model that turns your recordings into text.
      </p>

      {/* Engine choice lives HERE, with the models — Recording only holds
          recording behavior. Two places showing engine state read as a
          duplicate (Hamza, 2026-08-01). */}
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="settings-transcription-engine">Engine</label>
        <select
          id="settings-transcription-engine"
          value={usesCloudTranscription ? "cloud" : "local"}
          onChange={(e) => {
            if (e.target.value === "cloud") {
              update({
                transcription_base_url: "https://api.groq.com/openai/v1",
                transcription_model: config.transcription_model?.trim() || "whisper-large-v3",
              });
            } else {
              update({ transcription_base_url: "" });
            }
          }}
          className="settings-select"
        >
          <option value="local">On-device — private, runs on this computer (recommended)</option>
          <option value="cloud">Online service — bring your own key</option>
        </select>
      </div>

      {usesCloudTranscription ? (
        <>
          <div className="settings-form-group">
            <div className="settings-note warn">
              <TriangleAlert size={14} aria-hidden="true" /> Online transcription uploads your meeting audio to{" "}
              {(() => {
                try { return new URL(config.transcription_base_url).host; }
                catch { return "the provider"; }
              })()}{" "}
              — this is <strong>not sovereign</strong> (audio leaves your device), and{" "}
              <strong>speaker labeling is unavailable</strong> in this mode (remote
              audio is labeled "Them", not "Speaker 1/2"). For private, labeled
              transcripts, use the on-device engine.
            </div>
          </div>
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-transcription-base">Transcription Base URL</label>
            <input
              id="settings-transcription-base"
              type="text"
              value={config.transcription_base_url}
              onChange={(e) => update({ transcription_base_url: e.target.value })}
              className="settings-input-text"
              placeholder="https://api.groq.com/openai/v1"
            />
          </div>
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-transcription-model">Model</label>
            <input
              id="settings-transcription-model"
              type="text"
              value={config.transcription_model}
              onChange={(e) => update({ transcription_model: e.target.value })}
              className="settings-input-text"
              placeholder="whisper-large-v3"
            />
          </div>
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-transcription-key">API Key</label>
            <input
              id="settings-transcription-key"
              type="password"
              value={config.transcription_api_key}
              onChange={(e) => update({ transcription_api_key: e.target.value })}
              className="settings-input-text"
              placeholder="gsk_..."
            />
            <p className="settings-help">
              Free key at{" "}
              <button className="btn-link" onClick={() => open("https://console.groq.com/keys")}>
                console.groq.com/keys
              </button>
              . Large v3 covers 99 languages (including Arabic).
            </p>
          </div>
        </>
      ) : (
        <div className="settings-form-group">
          {transcriptionChip && (
            <p className={`settings-msg ${transcriptionChip.tone}`}>{transcriptionChip.text}</p>
          )}
          {whisperModels.length === 0 ? (
            <div className="settings-note info">
              The list of transcription models isn't available yet — it appears once
              the on-device service is running.
            </div>
          ) : (
            <div className="settings-model-list">
              {whisperModels.map((model) => {
                const id = whisperModelId(model.key);
                const status = downloads[id];
                const running = status ? isInFlight(status) : false;
                const percent = status ? aggregatePercent([status]) : null;
                const isActive = model.key === config.whisper_model;
                return (
                  <div
                    key={model.key}
                    className={`settings-model-row${isActive ? " active" : ""}`}
                  >
                    <div className="settings-model-info">
                      <span>{model.label}</span>
                      <small>
                        {model.downloaded ? "On this computer" : `${model.size} download`}
                        {isActive ? " · in use" : ""}
                      </small>
                      {running && status && (
                        <>
                          <small>
                            {status.total_bytes > 0
                              ? `${formatGb(status.downloaded_bytes)} of ${formatGb(status.total_bytes)}`
                              : "Preparing…"}
                          </small>
                          {status.total_bytes > 0 ? (
                            <progress
                              value={status.downloaded_bytes}
                              max={status.total_bytes}
                            />
                          ) : (
                            <progress />
                          )}
                        </>
                      )}
                      {status?.state === "error" && <small>{status.detail}</small>}
                    </div>
                    <div className="settings-model-action">
                      {running && status ? (
                        <span className="settings-model-dl">
                          {percent === null ? "Downloading…" : `Downloading ${percent}%`}
                        </span>
                      ) : !model.downloaded ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => downloadWhisper(model.key)}
                        >
                          {status?.state === "error" ? "Retry" : "Download"}
                        </button>
                      ) : isActive ? (
                        <span className="settings-model-inuse">In use</span>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => activateWhisperModel(model.key)}
                        >
                          Use this one
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {whisperMsg && <p className="settings-msg err">{whisperMsg}</p>}
          <p className="settings-help">
            Recordings made before a model is here aren't lost — they transcribe
            themselves as soon as one lands.
          </p>
        </div>
      )}

      <h3 className="settings-card-title" style={{ marginTop: 22 }}>Meeting notes</h3>
      <p className="settings-card-desc">
        The model that turns transcripts into notes. <strong>Local</strong> runs on
        this computer and is started and stopped by Adversaria — nothing leaves the
        machine. An online service is faster on older hardware, but sends your
        transcript away for summarizing.
      </p>

      {/* Provider — first-class, first control. */}
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="settings-provider">Engine</label>
        <select
          id="settings-provider"
          value={config.llm_provider}
          onChange={(e) => {
            const provider = e.target.value;
            const patch: Partial<AppConfig> = { llm_provider: provider };
            if (provider === "local") {
              patch.llm_base_url = "";
            } else if (provider === "groq") {
              patch.llm_base_url = "https://api.groq.com/openai/v1";
            } else if (provider === "grok") {
              patch.llm_base_url = "https://api.x.ai/v1";
            } else if (provider === "openrouter") {
              patch.llm_base_url = "https://openrouter.ai/api/v1";
            } else if (provider === "deepseek") {
              patch.llm_base_url = "https://api.deepseek.com";
            }
            // Also switch the model to one that matches the new provider, so a
            // model name from the previous provider isn't sent to the new one
            // (e.g. a Groq model name → local server → 404). "custom" keeps
            // whatever base URL + model the user typed.
            if (provider !== "custom") {
              patch.ollama_model = DEFAULT_MODEL[provider];
            }
            update(patch);
          }}
          className="settings-select"
        >
          <option value="local">Local — on this computer</option>
          <option value="groq">Groq — free, easiest to set up</option>
          <option value="custom">Bring your own (OpenAI-compatible)</option>
          <option value="deepseek">DeepSeek</option>
          <option value="openrouter">OpenRouter</option>
          <option value="grok">xAI Grok</option>
        </select>
      </div>

      {/* Local: dropdown of what's on this machine; the recommended model is
          labeled when missing and downloads only from the button below. */}
      {config.llm_provider === "local" && profiles.length > 0 && chosen && (
        <div className="settings-form-group">
          <label className="settings-label" htmlFor="settings-local-model">Meeting model</label>
          <select
            id="settings-local-model"
            className="settings-select"
            value={chosen.id}
            onChange={(e) => {
              setChosenId(e.target.value);
              setEngineConsentFor(null);
              setModelMsg("");
            }}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.display_name}
                {profile.installed
                  ? " — on this computer"
                  : profile.recommended
                    ? ` — Recommended for your ${deviceLabel} (not downloaded)`
                    : " — not downloaded"}
              </option>
            ))}
          </select>
          <p className="settings-help">
            {chosen.quality_note} Needs {chosen.minimum_memory_gb} GB RAM
            {chosen.installed ? "." : ` · ${chosen.required_disk_gb} GB download.`}
          </p>

          <div className="settings-model-action-row">
            {inUse?.id === chosen.id ? (
              <span className="settings-model-inuse">In use</span>
            ) : chosenDownloading ? (
              <span className="settings-model-dl">
                {profileDownload && profileDownload.total_bytes > 0
                  ? `${formatGb(profileDownload.downloaded_bytes)} of ${formatGb(profileDownload.total_bytes)}`
                  : "Preparing…"}
              </span>
            ) : chosen.installed ? (
              <button
                type="button"
                className="btn-primary"
                disabled={modelSwitching}
                onClick={() => switchLocalModel(chosen.id)}
              >
                {modelSwitching ? "Switching…" : "Use this model"}
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary"
                disabled={modelSwitching}
                onClick={() => downloadLocalModel(chosen.id)}
              >
                {profileDownload?.state === "error"
                  ? "Retry download"
                  : `Download (${chosen.required_disk_gb} GB)`}
              </button>
            )}
          </div>
          {chosenDownloading && profileDownload && profileDownload.total_bytes > 0 && (
            <progress
              value={profileDownload.downloaded_bytes}
              max={profileDownload.total_bytes}
            />
          )}
          {modelMsg && <p className="settings-msg">{modelMsg}</p>}
        </div>
      )}

      {/* Consent card appears ONLY after a Download click needs the engine. */}
      {config.llm_provider === "local" && engineConsentFor && (
        <EngineInstallCard
          onInstalled={() => {
            const profileId = engineConsentFor;
            setEngineConsentFor(null);
            getSetupStatus().then(setSetup).catch(() => {});
            // The consent card named this model too — continue into its download.
            if (profileId) void beginDownload(profileId, setModelMsg);
          }}
          onDismiss={() => setEngineConsentFor(null)}
        />
      )}

      {/* Local with nothing detected at all (no pinned tiers, no Ollama). */}
      {config.llm_provider === "local" && profiles.length === 0 && setup && (
        <div className="settings-form-group">
          <div className="settings-note info">
            <strong>No notes model on this computer yet.</strong> Your meetings
            still record and transcribe — only the written summary is waiting.
            The quickest route is the free online option in the Engine list
            above (an API key, no download); if you'd rather keep everything on
            this {deviceLabel}, this list fills in once a model is installed.
          </div>
        </div>
      )}

      {/* Cloud warning — stays in plain sight, never behind a disclosure. */}
      {isCloud && (
        <div className="settings-form-group">
          <div className="settings-note warn">
            <TriangleAlert size={14} aria-hidden="true" /> Online engine: your meeting transcript is sent to{" "}
            {PROVIDER_LABEL[config.llm_provider] ?? "an external service"} for
            summarization. Choose <strong>Local</strong> to keep everything on this device.
          </div>
        </div>
      )}

      {/* API provider setup — first-class, inline (SPEC v2), not "Advanced". */}
      {isCloud && (
        <>
          {config.llm_provider === "groq" && (
            <div className="settings-form-group">
              <div className="settings-note info">
                Get a free API key at{" "}
                <button className="btn-link" onClick={() => open("https://console.groq.com/keys")}>
                  console.groq.com/keys
                </button>{" "}
                — no credit card needed. Paste it in the API Key field below.
              </div>
            </div>
          )}

          {config.llm_provider === "custom" && (
            <div className="settings-form-group">
              <label className="settings-label" htmlFor="settings-base-url">Base URL</label>
              <input
                id="settings-base-url"
                type="text"
                value={config.llm_base_url}
                onChange={(e) => update({ llm_base_url: e.target.value })}
                className="settings-input-text"
                placeholder="https://api.example.com/v1"
              />
            </div>
          )}

          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-model">Model</label>
            <input
              id="settings-model"
              type="text"
              value={config.ollama_model}
              onChange={(e) => update({ ollama_model: e.target.value })}
              className="settings-input-text"
              placeholder={MODEL_PLACEHOLDER[config.llm_provider] ?? "model-name"}
            />
          </div>

          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-api-key">API Key</label>
            <div className="settings-row">
              <input
                id="settings-api-key"
                type="password"
                value={config.llm_api_key}
                onChange={(e) => update({ llm_api_key: e.target.value })}
                className="settings-input-text"
                placeholder={config.llm_provider === "groq" ? "gsk_..." : "sk-..."}
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={handleTestLlm}
                disabled={llmTest.status === "testing" || !config.llm_base_url}
              >
                {llmTest.status === "testing" ? "Testing…" : "Test"}
              </button>
            </div>
            {llmTest.status === "ok" && <p className="settings-msg ok">{llmTest.msg}</p>}
            {llmTest.status === "error" && <p className="settings-msg err">{llmTest.msg}</p>}
          </div>
        </>
      )}

      {/* Advanced — local service plumbing only. */}
      <details
        className="settings-advanced"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary>Advanced — connection details</summary>

        {/* Model free-text for a local setup with no detected profiles (e.g.
            the user's own OpenAI-compatible server on this machine). */}
        {config.llm_provider === "local" && profiles.length === 0 && (
          <div className="settings-form-group" style={{ marginTop: 12 }}>
            <label className="settings-label" htmlFor="settings-local-free-model">Model</label>
            <input
              id="settings-local-free-model"
              type="text"
              value={config.ollama_model}
              onChange={(e) => update({ ollama_model: e.target.value })}
              className="settings-input-text"
              placeholder={MODEL_PLACEHOLDER.local}
            />
          </div>
        )}

        <div className="settings-form-group" style={{ marginTop: 12 }}>
          <label className="settings-label">Service Status</label>
          {healthStatus === "checking" ? (
            <p className="settings-msg">Checking…</p>
          ) : healthStatus === "ok" ? (
            <p className="settings-msg ok">● On-device services are running</p>
          ) : healthStatus === "degraded" ? (
            <p className="settings-msg warn">● Service reachable, but the model server is not available</p>
          ) : (
            <p className="settings-msg err">● The on-device service is not reachable</p>
          )}
        </div>
        <div className="settings-form-group">
          <label className="settings-label" htmlFor="settings-service-url">On-device service address</label>
          <input
            id="settings-service-url"
            type="text"
            value={config.python_service_url}
            onChange={(e) => update({ python_service_url: e.target.value })}
            className="settings-input-text"
            placeholder="http://localhost:9876"
          />
          <p className="settings-help">
            The on-device transcription service. Most people never change this.
          </p>
        </div>
      </details>
    </div>
  );
}
