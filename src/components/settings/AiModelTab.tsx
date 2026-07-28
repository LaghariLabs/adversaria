import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { TriangleAlert } from "lucide-react";

import type { AppConfig, ModelDownloadStatus, SetupStatus } from "../../types";
import { EngineInstallCard } from "../EngineInstallCard";
import {
  checkServiceHealth,
  getConfig,
  getModelDownloadStatus,
  getSetupStatus,
  setLocalModelProfile,
  startModelDownload,
  testLlmConnection,
} from "../../lib/tauri";

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
 * AI Model — the model that writes your notes (SPEC v2: Meetily-shaped).
 *
 * Provider dropdown first; when Local is selected, a dropdown lists the models
 * already on this machine, with the hardware-recommended one labeled when it
 * isn't downloaded yet. Downloads start ONLY from the explicit button — and on
 * platforms whose managed engine isn't installed, that click first surfaces
 * the transparent install-plan consent card. API providers are first-class:
 * their key/model fields render inline, not behind a disclosure.
 */
export function AiModelTab({ active, config, update, replaceConfig }: AiModelTabProps) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const [profileDownload, setProfileDownload] = useState<ModelDownloadStatus | null>(null);
  const [healthStatus, setHealthStatus] = useState<
    "checking" | "ok" | "degraded" | "unreachable"
  >("checking");
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
      const health = await checkServiceHealth();
      setHealthStatus(health.status === "ok" ? "ok" : "degraded");
    } catch {
      setHealthStatus("unreachable");
    }
  }, []);

  useEffect(() => {
    getSetupStatus().then(setSetup).catch(() => {});
    checkHealth();
  }, [checkHealth]);

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

  // While a profile downloads, poll until it verifies — then make it the
  // active model: the user explicitly asked for THIS model, so finishing the
  // download and not using it would be a dead end.
  useEffect(() => {
    if (!profileDownload || !["preparing", "downloading", "verifying"].includes(profileDownload.state)) {
      return;
    }
    const timer = window.setInterval(() => {
      getModelDownloadStatus(profileDownload.profile_id)
        .then(async (status) => {
          setProfileDownload(status);
          if (status.state === "ready") {
            setSetup(await getSetupStatus());
            await switchLocalModel(status.profile_id);
          }
        })
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [profileDownload?.profile_id, profileDownload?.state, switchLocalModel]);

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
    try {
      setProfileDownload(await startModelDownload(profileId));
    } catch (e) {
      setModelMsg(String(e));
    }
  };

  const isCloud = config.llm_provider !== "local";
  const deviceLabel = setup?.platform === "macos" ? "Mac" : "PC";

  const profiles = setup?.profiles ?? [];
  const inUse = profiles.find((p) => p.model_alias === config.ollama_model);
  const recommended = profiles.find((p) => p.recommended);
  const chosen =
    profiles.find((p) => p.id === chosenId) ?? inUse ?? recommended ?? profiles[0];
  const chosenDownloading =
    chosen &&
    profileDownload?.profile_id === chosen.id &&
    ["preparing", "downloading", "verifying"].includes(profileDownload.state);

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`} data-tour="ai-model">
      <h3 className="settings-card-title">AI Model</h3>
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
                  ? `${(profileDownload.downloaded_bytes / 1e9).toFixed(1)} / ${(profileDownload.total_bytes / 1e9).toFixed(1)} GB`
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
                {profileDownload?.profile_id === chosen.id && profileDownload.state === "error"
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
            if (profileId) {
              startModelDownload(profileId)
                .then(setProfileDownload)
                .catch((e) => setModelMsg(String(e)));
            }
          }}
          onDismiss={() => setEngineConsentFor(null)}
        />
      )}

      {/* Local with nothing detected at all (no pinned tiers, no Ollama). */}
      {config.llm_provider === "local" && profiles.length === 0 && setup && (
        <div className="settings-form-group">
          <div className="settings-note info">
            No local notes engine was found on this computer yet. Pick an online
            engine above, or type the model your own local server exposes under
            Advanced.
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
