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
 * AI Model — the model that writes your notes. On-device model first; the
 * external-service configuration lives behind the Advanced disclosure.
 */
export function AiModelTab({ active, config, update, replaceConfig }: AiModelTabProps) {
  // On-device meeting-model (Rapid-MLX profile) picker — Local engine only.
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const [profileDownload, setProfileDownload] = useState<ModelDownloadStatus | null>(null);
  const [healthStatus, setHealthStatus] = useState<
    "checking" | "ok" | "degraded" | "unreachable"
  >("checking");
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  // Read hardware + pinned meeting-model profiles once, for the Local engine
  // picker. Cheap and best-effort; the free-text model field remains the
  // fallback when this build has no bundled managed runtime.
  useEffect(() => {
    getSetupStatus().then(setSetup).catch(() => {});
    checkHealth();
  }, [checkHealth]);

  // While a profile downloads, poll until it verifies, then refresh the
  // profiles so the row flips to "Verified" (mirrors the Welcome flow).
  useEffect(() => {
    if (!profileDownload || !["preparing", "downloading", "verifying"].includes(profileDownload.state)) {
      return;
    }
    const timer = window.setInterval(() => {
      getModelDownloadStatus(profileDownload.profile_id)
        .then(async (status) => {
          setProfileDownload(status);
          if (status.state === "ready") setSetup(await getSetupStatus());
        })
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(timer);
  }, [profileDownload?.profile_id, profileDownload?.state]);

  const switchLocalModel = async (profileId: string) => {
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
  };

  const downloadLocalModel = async (profileId: string) => {
    setModelMsg("");
    try {
      setProfileDownload(await startModelDownload(profileId));
    } catch (e) {
      setModelMsg(String(e));
    }
  };

  const isCloud = config.llm_provider !== "local";

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">AI Model</h3>
      <p className="settings-card-desc">
        The model that turns transcripts into notes. <strong>Local</strong> runs on
        this computer and is started and stopped by Adversaria — nothing leaves the
        machine. An online service is faster on older hardware, but sends your
        transcript away for summarizing.
      </p>

      {/* Engine */}
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
            // Picking an online service means the setup for it (key, address)
            // is what you need next — open Advanced so it isn't a dead end.
            if (provider !== "local") setAdvancedOpen(true);
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

      {/* Off Apple Silicon the managed engine is llama.cpp and needs a
          one-time consented install ('Not now' in the wizard lands here). The
          card names exactly what installs before anything happens. */}
      {config.llm_provider === "local" &&
        setup &&
        setup.platform !== "macos" &&
        !setup.managed_engine_installed && (
          <EngineInstallCard
            onInstalled={() => {
              getSetupStatus().then(setSetup).catch(() => {});
            }}
          />
        )}

      {/* The Local engine gets a curated on-device model picker (recommend,
          never force). It only appears when this build actually bundles the
          managed runtime (macOS/Apple Silicon); otherwise the free-text model
          field under Advanced is the way in. */}
      {config.llm_provider === "local" && setup?.rapid_runtime_bundled && (
        <div className="settings-form-group">
          <label className="settings-label">On-device meeting model</label>
          <p className="settings-card-desc">
            {setup.profiles.find((p) => p.recommended)?.display_name ?? "The lighter model"} is
            recommended for your Mac ({(setup.total_memory_bytes / 1e9).toFixed(0)} GB). Switching
            restarts the on-device engine and takes effect without a restart — nothing else is changed.
          </p>
          <div className="settings-model-list">
            {setup.profiles.map((profile) => {
              const inUse = profile.model_alias === config.ollama_model;
              const downloading =
                profileDownload?.profile_id === profile.id &&
                ["preparing", "downloading", "verifying"].includes(profileDownload.state);
              return (
                <div className={`settings-model-row${inUse ? " active" : ""}`} key={profile.id}>
                  <div className="settings-model-info">
                    <strong>
                      {profile.display_name}
                      {profile.recommended ? " · Recommended" : ""}
                    </strong>
                    <small>
                      Downloads {profile.required_disk_gb} GB · needs {profile.minimum_memory_gb} GB RAM ·{" "}
                      {profile.installed ? "on this computer" : "not downloaded yet"}
                    </small>
                  </div>
                  <div className="settings-model-action">
                    {inUse ? (
                      <span className="settings-model-inuse">In use</span>
                    ) : downloading ? (
                      <span className="settings-model-dl">
                        {profileDownload && profileDownload.total_bytes > 0
                          ? `${(profileDownload.downloaded_bytes / 1e9).toFixed(1)} / ${(profileDownload.total_bytes / 1e9).toFixed(1)} GB`
                          : "Preparing…"}
                      </span>
                    ) : profile.installed ? (
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={modelSwitching}
                        onClick={() => switchLocalModel(profile.id)}
                      >
                        {modelSwitching ? "Switching…" : "Use"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={modelSwitching}
                        onClick={() => downloadLocalModel(profile.id)}
                      >
                        {profileDownload?.profile_id === profile.id && profileDownload.state === "error"
                          ? "Retry"
                          : "Download"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {modelMsg && <p className="settings-msg">{modelMsg}</p>}
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

      {/* Advanced — everything about connecting an online service, plus the
          local service plumbing. Opens automatically when a service is picked. */}
      <details
        className="settings-advanced"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
      >
        <summary>Advanced — online services &amp; connection details</summary>

        {/* Groq onboarding helper */}
        {config.llm_provider === "groq" && (
          <div className="settings-form-group" style={{ marginTop: 12 }}>
            <div className="settings-note info">
              Get a free API key at{" "}
              <button className="btn-link" onClick={() => open("https://console.groq.com/keys")}>
                console.groq.com/keys
              </button>{" "}
              — no credit card needed. Paste it in the API Key field below.
            </div>
          </div>
        )}

        {/* Base URL — custom only (other providers are preset) */}
        {config.llm_provider === "custom" && (
          <div className="settings-form-group" style={{ marginTop: 12 }}>
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

        {/* Model name — free text for every engine the on-device picker above
            doesn't cover (all online services, and local builds without the
            bundled runtime). */}
        {!(config.llm_provider === "local" && setup?.rapid_runtime_bundled) && (
          <div className="settings-form-group" style={{ marginTop: 12 }}>
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
        )}

        {/* API key (online services only) */}
        {isCloud && (
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
