import { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { getVersion } from "@tauri-apps/api/app";
import {
  Bot,
  CalendarDays,
  Database,
  FileText,
  MessageSquare,
  Mic2,
  ShieldCheck,
  Timer,
  TriangleAlert,
} from "lucide-react";
import type { AppConfig, CalendarAccount, CalendarConfig, ModelDownloadStatus, PromptTemplate, RegistrationState, SetupStatus, TemplateInfo, WhisperModelInfo } from "../types";
import {
  getConfig,
  updateConfig,
  checkServiceHealth,
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  calendarSetCredentials,
  calendarHasCredentials,
  calendarConnect,
  calendarDisconnect,
  calendarStatus,
  calendarMacosEnable,
  testLlmConnection,
  listWhisperModels,
  downloadWhisperModel,
  getSetupStatus,
  setLocalModelProfile,
  startModelDownload,
  getModelDownloadStatus,
  exportAllMeetings,
  exportSecondBrain,
  importAllMeetings,
  exportRedactedDiagnostics,
  getRegistrationState,
  retryRegistration,
} from "../lib/tauri";
import { hashPin, verifyPin } from "../lib/pin";
import { DATE_FORMAT_OPTIONS, setDateFormat, formatDateTime } from "../lib/dateFormat";

const LANGUAGES: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية (Arabic)" },
  { value: "auto", label: "Match spoken language" },
];

type SettingsTab = "summarizer" | "prompts" | "transcription" | "autostop" | "security" | "calendar" | "data" | "feedback";

/** Where beta sign-up + feedback emails are addressed. */
const FEEDBACK_EMAIL = "mhlaghari@gmail.com";

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

export function Settings() {
  // App version (so the user can always tell which build is running).
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [registrationState, setRegistrationState] = useState<RegistrationState | null>(null);
  const [registrationRetrying, setRegistrationRetrying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [healthStatus, setHealthStatus] = useState<
    "checking" | "ok" | "degraded" | "unreachable"
  >("checking");
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<string>("");
  const [templateBody, setTemplateBody] = useState<string>("");
  const [newTemplateName, setNewTemplateName] = useState<string>("");
  const [templateMsg, setTemplateMsg] = useState<string>("");

  // On-device Whisper model picker.
  const [whisperModels, setWhisperModels] = useState<WhisperModelInfo[]>([]);
  const [whisperDownloading, setWhisperDownloading] = useState<string | null>(null);

  // On-device meeting-model (Rapid-MLX profile) picker — Local engine only.
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const [profileDownload, setProfileDownload] = useState<ModelDownloadStatus | null>(null);

  const [llmTest, setLlmTest] = useState<{
    status: "idle" | "testing" | "ok" | "error";
    msg: string;
  }>({ status: "idle", msg: "" });

  const handleTestLlm = async () => {
    if (!config) return;
    setLlmTest({ status: "testing", msg: "" });
    try {
      const msg = await testLlmConnection(config.llm_base_url, config.llm_api_key);
      setLlmTest({ status: "ok", msg });
    } catch (e) {
      setLlmTest({ status: "error", msg: String(e) });
    }
  };

  // Read hardware + pinned meeting-model profiles once, for the Local engine
  // picker. Cheap and best-effort; the free-text model field remains the
  // fallback when this build has no bundled managed runtime.
  useEffect(() => {
    getSetupStatus().then(setSetup).catch(() => {});
  }, []);

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
      setConfig(cfg);
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

  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>("summarizer");

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await getConfig();
      setConfig(cfg);
    } catch (e) {
      console.error("Failed to load config:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const health = await checkServiceHealth();
      setHealthStatus(health.status === "ok" ? "ok" : "degraded");
    } catch {
      setHealthStatus("unreachable");
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    // The Python sidecar takes a few seconds to boot (Whisper load) on startup,
    // so /templates isn't ready the instant Settings mounts. A one-shot fetch
    // would leave the Prompts tab permanently blank if it lost that race. There
    // are always >=4 bundled templates, so an empty result means "not ready yet"
    // — retry a few times before giving up. (Refreshes after save/delete hit on
    // the first attempt since the sidecar is up by then.)
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const t = await listTemplates();
        if (t.length > 0) {
          setTemplates(t);
          return;
        }
      } catch (e) {
        console.error("Failed to load templates (attempt", attempt, "):", e);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }, []);

  const loadWhisperModels = useCallback(async () => {
    try {
      setWhisperModels(await listWhisperModels());
    } catch (e) {
      console.error("Failed to load whisper models:", e);
    }
  }, []);

  const handleWhisperDownload = async (key: string) => {
    setWhisperDownloading(key);
    try {
      await downloadWhisperModel(key);
      await loadWhisperModels(); // refresh → "Ready ✓"
    } catch (e) {
      console.error("Whisper model download failed:", e);
    } finally {
      setWhisperDownloading(null);
    }
  };

  useEffect(() => {
    loadConfig();
    checkHealth();
    loadTemplates();
    loadWhisperModels();
    getRegistrationState().then(setRegistrationState).catch(() => {});
  }, [loadConfig, checkHealth, loadTemplates, loadWhisperModels]);

  const handleRegistrationRetry = async () => {
    setRegistrationRetrying(true);
    try {
      setRegistrationState(await retryRegistration());
    } finally {
      setRegistrationRetrying(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await updateConfig(config);
      setDateFormat(config.date_format); // persist the app-wide date format
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error("Failed to save config:", e);
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<AppConfig>) => {
    if (!config) return;
    setConfig({ ...config, ...patch });
  };

  // Encryption-at-rest toggle. Persisted immediately; the actual encrypt/decrypt
  // migration runs at the next startup (so it needs an app restart, like the
  // service-URL setting), surfaced via a restart note.
  const [encMsg, setEncMsg] = useState<string | null>(null);
  const handleEncryptToggle = async (enabled: boolean) => {
    if (!config) return;
    const next = { ...config, encrypt_db: enabled };
    setConfig(next);
    try {
      await updateConfig(next);
      setEncMsg(
        enabled
          ? "Database will be encrypted on next launch — restart the app to apply."
          : "Encryption will be turned off on next launch (database decrypted, keychain prompt removed) — restart the app to apply."
      );
    } catch (e) {
      setEncMsg(String(e));
    }
  };

  // Feedback — opens the user's own mail client pre-addressed to the developer
  // with their typed message as the body. No backend; nothing is sent until they
  // hit send in their email app (privacy-clean).
  const [feedbackText, setFeedbackText] = useState("");
  const [dataMsg, setDataMsg] = useState<string | null>(null);
  const [dataBusy, setDataBusy] = useState(false);
  const sendFeedback = () => {
    const subject = `Adversaria Feedback${appVersion ? ` (v${appVersion})` : ""}`;
    const body = feedbackText.trim();
    open(
      `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    );
  };

  const handleDiagnosticExport = async () => {
    setDataBusy(true);
    setDataMsg(null);
    try {
      const path = await exportRedactedDiagnostics();
      setDataMsg(path ? "Redacted diagnostics exported." : "Export cancelled.");
    } catch (error) {
      setDataMsg(String(error));
    } finally {
      setDataBusy(false);
    }
  };

  // --- Privacy PIN ---
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [pinCurrent, setPinCurrent] = useState("");
  const [pinMsg, setPinMsg] = useState<string | null>(null);

  const handleSetPin = async () => {
    if (!config) return;
    setPinMsg(null);
    if (!/^\d{4,}$/.test(pin1)) {
      setPinMsg("PIN must be at least 4 digits.");
      return;
    }
    if (pin1 !== pin2) {
      setPinMsg("PINs do not match.");
      return;
    }
    try {
      const hash = await hashPin(pin1);
      const next = { ...config, pin_hash: hash };
      setConfig(next);
      await updateConfig(next);
      setPin1("");
      setPin2("");
      setPinMsg("PIN set.");
      setTimeout(() => setPinMsg(null), 2000);
    } catch (e) {
      setPinMsg(String(e));
    }
  };

  const handleRemovePin = async () => {
    if (!config || !config.pin_hash) return;
    setPinMsg(null);
    const ok = await verifyPin(pinCurrent, config.pin_hash);
    if (!ok) {
      setPinMsg("Wrong PIN.");
      return;
    }
    try {
      const next = { ...config, pin_hash: null };
      setConfig(next);
      await updateConfig(next);
      setPinCurrent("");
      setPinMsg("PIN removed.");
      setTimeout(() => setPinMsg(null), 2000);
    } catch (e) {
      setPinMsg(String(e));
    }
  };

  // --- Calendar ---
  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const [calendarCfg, setCalendarCfg] = useState<CalendarConfig>(config?.calendar ?? { google: null, microsoft: null, macos_eventkit_enabled: false });
  const [hasGoogleCreds, setHasGoogleCreds] = useState<boolean | null>(null);
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [googleCredsSaved, setGoogleCredsSaved] = useState(false);
  const [calendarConnecting, setCalendarConnecting] = useState(false);
  const [calendarMsg, setCalendarMsg] = useState<string | null>(null);

  // --- macOS EventKit ---
  const [ekEnabled, setEkEnabled] = useState(calendarCfg.macos_eventkit_enabled);
  const [ekEnabling, setEkEnabling] = useState(false);
  const [ekMsg, setEkMsg] = useState<string | null>(null);

  const refreshCalendarState = useCallback(async () => {
    try {
      const status = await calendarStatus();
      setCalendarCfg(status);
      setEkEnabled(status.macos_eventkit_enabled);
      const hasCreds = await calendarHasCredentials("google");
      setHasGoogleCreds(hasCreds);
    } catch (e) {
      console.error("Failed to refresh calendar state:", e);
    }
  }, []);

  useEffect(() => {
    if (calendarExpanded) {
      refreshCalendarState();
    }
  }, [calendarExpanded, refreshCalendarState]);

  const handleGoogleCredsSave = async () => {
    if (!googleClientId.trim()) {
      setCalendarMsg("Client ID is required.");
      return;
    }
    try {
      await calendarSetCredentials(
        "google",
        googleClientId.trim(),
        googleClientSecret.trim() || null,
      );
      setGoogleCredsSaved(true);
      setCalendarMsg("Credentials saved to keychain.");
      setHasGoogleCreds(true);
      setTimeout(() => setCalendarMsg(null), 2000);
    } catch (e) {
      setCalendarMsg(String(e));
    }
  };

  const handleGoogleConnect = async () => {
    setCalendarConnecting(true);
    setCalendarMsg("Complete sign-in in your browser...");
    try {
      const account = await calendarConnect("google");
      setCalendarCfg((prev) => ({ ...prev, google: account }));
      setCalendarMsg("Connected! Don't forget to enable the toggle below.");
      setTimeout(() => setCalendarMsg(null), 3000);
    } catch (e) {
      setCalendarMsg(String(e));
    } finally {
      setCalendarConnecting(false);
    }
  };

  const handleGoogleDisconnect = async () => {
    try {
      await calendarDisconnect("google");
      setCalendarCfg((prev) => ({ ...prev, google: null }));
      setHasGoogleCreds(false);
      setGoogleCredsSaved(false);
      setCalendarMsg("Disconnected.");
      setTimeout(() => setCalendarMsg(null), 2000);
    } catch (e) {
      setCalendarMsg(String(e));
    }
  };

  const handleGoogleToggle = (enabled: boolean) => {
    if (!config || !calendarCfg.google) return;
    const account: CalendarAccount = { ...calendarCfg.google, enabled };
    const nextCfg: CalendarConfig = {
      ...calendarCfg,
      google: account,
    };
    setCalendarCfg(nextCfg);
    const nextConfig: AppConfig = { ...config, calendar: nextCfg };
    setConfig(nextConfig);
    updateConfig(nextConfig).catch((e) => setCalendarMsg(String(e)));
  };

  // --- macOS EventKit enable / disable ---
  const handleEkEnable = async (enable: boolean) => {
    if (!config) return;
    setEkEnabling(true);
    setEkMsg(null);
    try {
      const granted = await calendarMacosEnable(enable);
      if (enable) {
        if (granted) {
          setEkEnabled(true);
          setEkMsg("Enabled ✓");
        } else {
          setEkEnabled(false);
          setEkMsg("Permission denied — grant Calendars in System Settings › Privacy");
        }
      } else {
        setEkEnabled(false);
        setEkMsg("Disabled.");
      }
      // Refresh local state from config.
      const status = await calendarStatus();
      setCalendarCfg(status);
      setEkEnabled(status.macos_eventkit_enabled);
      setTimeout(() => setEkMsg(null), 4000);
    } catch (e) {
      setEkMsg(String(e));
    } finally {
      setEkEnabling(false);
    }
  };

  const saveCurrentTemplate = async () => {
    const name = (newTemplateName.trim() || editingTemplate).toLowerCase();
    if (!name) {
      setTemplateMsg("Pick a template or enter a new name.");
      return;
    }
    try {
      await saveTemplate(name, templateBody);
      setTemplateMsg("Saved.");
      setNewTemplateName("");
      setEditingTemplate(name);
      await loadTemplates();
    } catch (err) {
      setTemplateMsg(String(err));
    }
  };

  const deleteCurrentTemplate = async () => {
    if (!editingTemplate) return;
    try {
      await deleteTemplate(editingTemplate);
      setTemplateMsg("Deleted.");
      setEditingTemplate("");
      setTemplateBody("");
      await loadTemplates();
    } catch (err) {
      setTemplateMsg(String(err));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        Loading settings...
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex items-center justify-center h-full text-red-600">
        Failed to load configuration.
      </div>
    );
  }

  const isCloud = config.llm_provider !== "local";

  const TABS: { id: SettingsTab; label: string; icon: JSX.Element }[] = [
    {
      id: "summarizer",
      label: "AI Engine",
      icon: <Bot size={15} aria-hidden="true" />,
    },
    {
      id: "prompts",
      label: "Prompts",
      icon: <FileText size={15} aria-hidden="true" />,
    },
    {
      id: "transcription",
      label: "Transcription",
      icon: <Mic2 size={15} aria-hidden="true" />,
    },
    {
      id: "autostop",
      label: "Auto-Stop",
      icon: <Timer size={15} aria-hidden="true" />,
    },
    {
      id: "security",
      label: "Security",
      icon: <ShieldCheck size={15} aria-hidden="true" />,
    },
    {
      id: "calendar",
      label: "Calendar",
      icon: <CalendarDays size={15} aria-hidden="true" />,
    },
    {
      id: "data",
      label: "Data",
      icon: <Database size={15} aria-hidden="true" />,
    },
    {
      id: "feedback",
      label: "Feedback",
      icon: <MessageSquare size={15} aria-hidden="true" />,
    },
  ];

  return (
    <div className="settings-sidebar-layout">
      {/* Inner Settings Sidebar */}
      <div className="settings-inner-sidebar">
        <div className="settings-sidebar-title">Settings</div>
        {appVersion && (
          <div className="settings-version" title="Installed app version">
            Adversaria v{appVersion}
          </div>
        )}
        {registrationState?.status === "pending" && (
          <div className="settings-registration-pending" role="status">
            <strong>Registration queued</strong>
            <span>It will retry automatically when online.</span>
            <button type="button" className="btn-link" onClick={handleRegistrationRetry} disabled={registrationRetrying}>
              {registrationRetrying ? "Retrying…" : "Retry now"}
            </button>
          </div>
        )}
        <div className="settings-menu-list">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`settings-menu-item${activeSettingsTab === tab.id ? " active" : ""}`}
              onClick={() => setActiveSettingsTab(tab.id)}
              aria-label={`${tab.label} settings`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Inner Settings Viewport Contents */}
      <div className="settings-inner-viewport">

        {/* SECTION: AI Engine */}
        <div className={`settings-section-card${activeSettingsTab === "summarizer" ? " active-card" : ""}`}>
          <h3 className="settings-card-title">AI Engine</h3>
          <p className="settings-card-desc">
            Choose how Adversaria turns transcripts into notes. <strong>Groq</strong> is
            free and the easiest — create a key, paste it, done. <strong>Local</strong>{" "}
            keeps everything on your device and is started and stopped by Adversaria.
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
                update(patch);
              }}
              className="settings-select"
            >
              <option value="groq">Groq — free, recommended</option>
              <option value="custom">Bring your own (OpenAI-compatible)</option>
              <option value="deepseek">DeepSeek</option>
              <option value="openrouter">OpenRouter</option>
              <option value="grok">xAI Grok</option>
              <option value="local">Local (Rapid-MLX / Ollama)</option>
            </select>
          </div>

          {/* Groq onboarding helper */}
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

          {/* Base URL — custom only (other providers are preset) */}
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

          {/* Model — the Local engine gets a curated on-device profile picker
              (recommend, never force); every other provider keeps the free-text
              model field. The picker only appears when this build actually
              bundles the managed runtime (macOS/Apple Silicon). */}
          {config.llm_provider === "local" && setup?.rapid_runtime_bundled ? (
            <div className="settings-form-group">
              <label className="settings-label">On-device meeting model</label>
              <p className="settings-card-desc">
                {setup.profiles.find((p) => p.recommended)?.display_name ?? "The lighter model"} is
                recommended for your Mac ({(setup.total_memory_bytes / 1e9).toFixed(0)} GB). Switching
                restarts the on-device engine and takes effect without a restart — nothing else is changed.
              </p>
              <div className="settings-model-list">
                {setup.profiles.map((profile) => {
                  const active = profile.model_alias === config.ollama_model;
                  const downloading =
                    profileDownload?.profile_id === profile.id &&
                    ["preparing", "downloading", "verifying"].includes(profileDownload.state);
                  return (
                    <div className={`settings-model-row${active ? " active" : ""}`} key={profile.id}>
                      <div className="settings-model-info">
                        <strong>
                          {profile.display_name}
                          {profile.recommended ? " · Recommended" : ""}
                        </strong>
                        <small>
                          {profile.required_disk_gb} GB · needs {profile.minimum_memory_gb} GB RAM ·{" "}
                          {profile.installed ? "Verified" : "Not installed"}
                        </small>
                      </div>
                      <div className="settings-model-action">
                        {active ? (
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
          ) : (
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
          )}

          {/* API key (cloud only) */}
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

          {/* Cloud warning */}
          {isCloud && (
            <div className="settings-form-group">
              <div className="settings-note warn">
                <TriangleAlert size={14} aria-hidden="true" /> Cloud engine: your meeting transcript is sent to{" "}
                {PROVIDER_LABEL[config.llm_provider] ?? "an external service"} for
                summarization. Choose <strong>Local</strong> to keep everything on this device.
              </div>
            </div>
          )}

          {/* Default summary language */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-summary-language">Summary Language</label>
            <select
              id="settings-summary-language"
              value={config.summary_language}
              onChange={(e) => update({ summary_language: e.target.value })}
              className="settings-select"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
            <p className="settings-help">
              Language for new summaries. You can also change it per meeting in the note view.
            </p>
          </div>

          {/* Date format */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-date-format">Date Format</label>
            <select
              id="settings-date-format"
              value={config.date_format}
              onChange={(e) => {
                setDateFormat(e.target.value); // live preview across the app
                update({ date_format: e.target.value });
              }}
              className="settings-select"
            >
              {DATE_FORMAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <p className="settings-help">
              How dates appear throughout the app. Preview: {formatDateTime(new Date().toISOString())}
            </p>
          </div>

          {/* Archive meetings after */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-archive-days">Archive meetings after</label>
            <select
              id="settings-archive-days"
              value={config.archive_after_days}
              onChange={(e) => update({ archive_after_days: Number(e.target.value) })}
              className="settings-select"
            >
              <option value={0}>Never</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days (default)</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
            <p className="settings-help">
              Older meetings fold into the sidebar's Archive section. Search and Ask always include them.
            </p>
          </div>

          {/* Sidebar meeting list style */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-sidebar-view">Sidebar meeting list</label>
            <select
              id="settings-sidebar-view"
              value={config.sidebar_view}
              onChange={(e) => update({ sidebar_view: e.target.value })}
              className="settings-select"
            >
              <option value="compact">Compact rows (default)</option>
              <option value="full">Full cards</option>
            </select>
            <p className="settings-help">
              Compact shows one line per meeting with details on hover; Full shows the classic cards. Applies when you save and go back to your meetings.
            </p>
          </div>

          {/* Recording view */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-recording-view">Recording view</label>
            <select
              id="settings-recording-view"
              value={config.recording_view}
              onChange={(e) => update({ recording_view: e.target.value })}
              className="settings-select"
            >
              <option value="balanced">Balanced — live transcript + notes, 50/50</option>
              <option value="transcript">Transcript-first — notes tucked into a footer</option>
            </select>
            <p className="settings-help">
              How the window lays out while a recording is running.
            </p>
          </div>

          {/* Notch pill style */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-notch-pill">Notch pill</label>
            <select
              id="settings-notch-pill"
              value={config.notch_pill_style}
              onChange={(e) => update({ notch_pill_style: e.target.value })}
              className="settings-select"
            >
              <option value="minimal">Minimal — dot, timer, waveform (default)</option>
              <option value="expressive">Expressive — expands on hover</option>
              <option value="hidden">Hidden — no pill</option>
            </select>
            <p className="settings-help">
              The small pill by the notch while you record. Expressive isn't available yet — it currently shows the minimal pill.
            </p>
          </div>

          {/* Meeting-detected alert style */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-meeting-alert">When a meeting is detected</label>
            <select
              id="settings-meeting-alert"
              value={config.meeting_alert_style}
              onChange={(e) => update({ meeting_alert_style: e.target.value })}
              className="settings-select"
            >
              <option value="notch_drop">Notch drop — a card offering to record (default)</option>
              <option value="pill_nudge">Pill nudge — a quiet "Record →" pill</option>
              <option value="off">Off — no alert</option>
            </select>
            <p className="settings-help">
              Adversaria never records on its own — an alert only offers; recording starts when you confirm or press ⌘⇧M. (Pill nudge and Off aren't wired yet.)
            </p>
          </div>

          {/* Advanced — local service plumbing tucked away */}
          <details className="settings-advanced">
            <summary>Advanced — local service</summary>
            <div className="settings-form-group" style={{ marginTop: 12 }}>
              <label className="settings-label">Service Status</label>
              {healthStatus === "checking" ? (
                <p className="settings-msg">Checking…</p>
              ) : healthStatus === "ok" ? (
                <p className="settings-msg ok">● Python ML service and model server are running</p>
              ) : healthStatus === "degraded" ? (
                <p className="settings-msg warn">● Service reachable, but the model server is not available</p>
              ) : (
                <p className="settings-msg err">● Python ML service is not reachable</p>
              )}
            </div>
            <div className="settings-form-group">
              <label className="settings-label" htmlFor="settings-service-url">Python Service URL</label>
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

        {/* SECTION: Prompts */}
        <div className={`settings-section-card${activeSettingsTab === "prompts" ? " active-card" : ""}`}>
          <h3 className="settings-card-title">Prompts &amp; Templates</h3>
          <p className="settings-card-desc">
            Templates are the system prompts that turn a transcript into structured
            notes. Pick a default, edit an existing one, or create your own.
          </p>

          {/* Default template */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-default-template">
              Default template for new meetings
            </label>
            <select
              id="settings-default-template"
              value={config.default_prompt_template}
              onChange={(e) =>
                update({ default_prompt_template: e.target.value as PromptTemplate })
              }
              className="settings-select"
            >
              {templates.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </div>

          {/* Editor */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-edit-template">Edit a template</label>
            <select
              id="settings-edit-template"
              value={editingTemplate}
              onChange={async (e) => {
                const name = e.target.value;
                setEditingTemplate(name);
                setTemplateMsg("");
                if (name) {
                  try {
                    setTemplateBody(await getTemplate(name));
                  } catch (err) {
                    setTemplateBody("");
                    setTemplateMsg(String(err));
                  }
                } else {
                  setTemplateBody("");
                }
              }}
              className="settings-select"
            >
              <option value="">— select a template to edit —</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
            <textarea
              value={templateBody}
              onChange={(e) => setTemplateBody(e.target.value)}
              placeholder="Select a template above, or type a new prompt and name it below."
              className="settings-textarea font-mono"
              style={{ marginTop: 10, minHeight: 300 }}
            />
          </div>

          {/* Save as */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-new-template">Save as</label>
            <div className="settings-row">
              <input
                id="settings-new-template"
                type="text"
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                placeholder="template-name (lowercase, hyphens) — or blank to overwrite"
                className="settings-input-text font-mono"
              />
              <button onClick={saveCurrentTemplate} className="btn-primary">Save</button>
              <button onClick={deleteCurrentTemplate} disabled={!editingTemplate} className="btn-danger">
                Delete
              </button>
            </div>
            {templateMsg && (
              <p className={`settings-msg${templateMsg === "Saved." || templateMsg === "Deleted." ? " ok" : templateMsg.startsWith("Pick") ? " warn" : ""}`}>
                {templateMsg}
              </p>
            )}
            <p className="settings-help">
              Names use lowercase letters, digits, and hyphens. Each template is a system
              prompt that produces the structured-notes JSON; new templates appear in the
              dropdowns immediately.
            </p>
          </div>
        </div>

        {/* SECTION: Transcription */}
        <div className={`settings-section-card${activeSettingsTab === "transcription" ? " active-card" : ""}`}>
          <h3 className="settings-card-title">Voice Transcription</h3>
          <p className="settings-card-desc">
            Choose how speech is transcribed, and personalize it — your name
            replaces the "Me" label, and custom vocabulary helps spell names right.
          </p>

          {/* Transcription engine */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-transcription-engine">Engine</label>
            <select
              id="settings-transcription-engine"
              value={config.transcription_base_url.trim() ? "cloud" : "local"}
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
              <option value="local">On-device — Whisper (sovereign, recommended)</option>
              <option value="cloud">Cloud — Groq (bring your own key)</option>
            </select>
          </div>

          {config.transcription_base_url.trim() ? (
            <>
              <div className="settings-form-group">
                <div className="settings-note warn">
                  <TriangleAlert size={14} aria-hidden="true" /> Cloud transcription uploads your meeting audio to{" "}
                  {(() => {
                    try { return new URL(config.transcription_base_url).host; }
                    catch { return "the provider"; }
                  })()}{" "}
                  — this is <strong>not sovereign</strong> (audio leaves your device), and{" "}
                  <strong>speaker diarization is unavailable</strong> in cloud mode (remote
                  audio is labeled "Them", not "Speaker 1/2"). For private, diarized
                  transcripts, use On-device Whisper.
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
                  . Whisper large-v3 covers 99 languages (including Arabic).
                </p>
              </div>
            </>
          ) : (
            <div className="settings-form-group">
              <label className="settings-label" htmlFor="settings-whisper-model">On-device model</label>
              <select
                id="settings-whisper-model"
                value={config.whisper_model}
                onChange={(e) => update({ whisper_model: e.target.value })}
                className="settings-select"
              >
                {whisperModels.length === 0 && (
                  <option value={config.whisper_model}>{config.whisper_model}</option>
                )}
                {whisperModels.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                    {m.downloaded ? "  ✓ downloaded" : `  ·  ${m.size}`}
                  </option>
                ))}
              </select>

              {(() => {
                const sel = whisperModels.find((m) => m.key === config.whisper_model);
                if (!sel) return null;
                if (sel.downloaded) {
                  return <p className="settings-msg ok">Ready ✓ — on this device.</p>;
                }
                if (whisperDownloading === sel.key) {
                  return <p className="settings-msg">Downloading… ({sel.size}) — this can take a few minutes.</p>;
                }
                return (
                  <div className="settings-row" style={{ marginTop: 10 }}>
                    <span className="settings-msg" style={{ margin: 0 }}>
                      Not downloaded yet ({sel.size}).
                    </span>
                    <button
                      className="btn-ghost"
                      onClick={() => handleWhisperDownload(sel.key)}
                      disabled={whisperDownloading !== null}
                    >
                      Download now
                    </button>
                  </div>
                );
              })()}

              <p className="settings-help">
                Fully private, on-device, with speaker diarization. Models are cached after
                the first download; if you pick one that isn't downloaded, it fetches on first
                use (or hit "Download now" to fetch it ahead of time). <strong>Large v3</strong>{" "}
                is recommended — best accuracy and 99 languages, including Arabic.
              </p>
            </div>
          )}

          {/* Your name */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-user-name">Your Name</label>
            <input
              id="settings-user-name"
              type="text"
              value={config.user_name}
              onChange={(e) => update({ user_name: e.target.value })}
              className="settings-input-text"
              placeholder="e.g. Hamza"
            />
            <p className="settings-help">
              Replaces the "Me" speaker label in new transcripts (and the notes) with
              your name. Leave blank to keep "Me".
            </p>
          </div>

          {/* Custom vocabulary */}
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-vocabulary">Custom Vocabulary</label>
            <textarea
              id="settings-vocabulary"
              value={config.custom_vocabulary}
              onChange={(e) => update({ custom_vocabulary: e.target.value })}
              rows={3}
              className="settings-textarea"
              placeholder="Names, companies, jargon — comma or newline separated (e.g. Laghari, Tatweer OS, SearXNG)"
            />
            <p className="settings-help">
              Helps transcription spell names and terms it would otherwise get wrong.
              Leave blank to disable.
            </p>
          </div>

          {/* Speaker diarization */}
          <div className="settings-form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.diarize}
                onChange={(e) => update({ diarize: e.target.checked })}
              />
              Label remote speakers (Speaker 1, 2, …)
            </label>
            <p className="settings-help">
              Splits the other participants' audio into separate speakers on-device.
              Adds a little processing time per meeting. Your own mic stays "Me".
            </p>
          </div>
        </div>

        {/* SECTION: Auto-Stop */}
        <div className={`settings-section-card${activeSettingsTab === "autostop" ? " active-card" : ""}`}>
          <h3 className="settings-card-title">Auto-Stop &amp; Detection</h3>
          <p className="settings-card-desc">
            Automatically pause or end a recording after a stretch of silence, and
            choose whether meetings are auto-detected.
          </p>

          <div className="settings-form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.auto_stop_enabled}
                onChange={(e) => update({ auto_stop_enabled: e.target.checked })}
              />
              Stop recording automatically after a stretch of silence
            </label>
          </div>

          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-silence-prompt">Ask after (minutes)</label>
            <input
              id="settings-silence-prompt"
              type="number"
              min={1}
              value={config.silence_prompt_minutes}
              onChange={(e) =>
                update({ silence_prompt_minutes: Math.max(1, Number(e.target.value) || 1) })
              }
              disabled={!config.auto_stop_enabled}
              className="settings-input-text"
            />
          </div>

          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-silence-stop">Stop after (minutes)</label>
            <input
              id="settings-silence-stop"
              type="number"
              min={1}
              value={config.silence_stop_minutes}
              onChange={(e) =>
                update({ silence_stop_minutes: Math.max(1, Number(e.target.value) || 1) })
              }
              disabled={!config.auto_stop_enabled}
              className="settings-input-text"
            />
            <p className="settings-help">
              "Ask after" shows a prompt to keep or stop; "Stop after" ends the recording
              on its own. Inactivity is measured from the live caption.
            </p>
          </div>

          <div className="settings-form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.auto_detect_meetings}
                onChange={(e) => update({ auto_detect_meetings: e.target.checked })}
              />
              Auto-detect meetings (prompt to record when a call app uses your mic)
            </label>
          </div>
        </div>

        {/* SECTION: Security */}
        <div className={`settings-section-card${activeSettingsTab === "security" ? " active-card" : ""}`}>
          <h3 className="settings-card-title">Security &amp; Privacy Lock</h3>
          <p className="settings-card-desc">
            Encrypt the database on disk, and lock specific confidential meetings.
          </p>

          {/* Encryption at rest */}
          <div className="settings-form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.encrypt_db}
                onChange={(e) => handleEncryptToggle(e.target.checked)}
              />
              Encrypt database at rest (recommended)
            </label>
            <p className="settings-help">
              Encrypts your meetings on disk (SQLCipher) with a key kept in your
              system keychain — protects your notes if this device is lost or stolen.
              Turning it off decrypts the database and removes the macOS keychain
              password prompt. Takes effect after an app restart.
            </p>
            {encMsg && <p className="settings-msg ok">{encMsg}</p>}
          </div>

          {config.pin_hash ? (
            <div className="settings-form-group">
              <label className="settings-label" htmlFor="settings-pin-current">
                A privacy PIN is set — enter it to remove
              </label>
              <div className="settings-row">
                <input
                  id="settings-pin-current"
                  type="password"
                  inputMode="numeric"
                  value={pinCurrent}
                  onChange={(e) => setPinCurrent(e.target.value)}
                  placeholder="current PIN"
                  className="settings-input-text"
                />
                <button onClick={handleRemovePin} className="btn-danger">Remove PIN</button>
              </div>
            </div>
          ) : (
            <div className="settings-form-group">
              <label className="settings-label" htmlFor="settings-pin-new">Create Privacy PIN (4+ digits)</label>
              <div className="settings-row">
                <input
                  id="settings-pin-new"
                  type="password"
                  inputMode="numeric"
                  value={pin1}
                  onChange={(e) => setPin1(e.target.value)}
                  placeholder="new PIN"
                  className="settings-input-text"
                />
                <input
                  type="password"
                  inputMode="numeric"
                  value={pin2}
                  onChange={(e) => setPin2(e.target.value)}
                  placeholder="confirm"
                  className="settings-input-text"
                  aria-label="Confirm PIN"
                />
                <button onClick={handleSetPin} className="btn-primary">Set PIN</button>
              </div>
            </div>
          )}
          {pinMsg && (
            <p className={`settings-msg${pinMsg === "PIN set." || pinMsg === "PIN removed." ? " ok" : pinMsg.includes("Wrong") || pinMsg.includes("must") || pinMsg.includes("not match") ? " err" : ""}`}>
              {pinMsg}
            </p>
          )}
          <p className="settings-help">
            Lock individual meetings (shown with a lock in the list) to hide their content behind
            this PIN. The meeting database itself is encrypted on disk separately.
          </p>

          {/* Biometric unlock (Touch ID / Windows Hello) */}
          <div className="settings-form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.biometric_unlock}
                onChange={(e) => update({ biometric_unlock: e.target.checked })}
              />
              Unlock locked meetings with Touch ID
            </label>
            <p className="settings-help">
              Use your fingerprint (Touch ID on Mac, Windows Hello on Windows) to open
              locked meetings, falling back to the PIN above if biometrics aren't available.
            </p>
          </div>
        </div>

        {/* SECTION: Calendar */}
        <div className={`settings-section-card${activeSettingsTab === "calendar" ? " active-card" : ""}`}>
          <h3 className="settings-card-title">Calendar</h3>
          <p className="settings-card-desc">
            Connect your calendars to pre-fill rosters and show upcoming events.
            Everything stays on this device.
          </p>

          <div className="settings-form-group">
            <button
              onClick={() => setCalendarExpanded(!calendarExpanded)}
              className="btn-ghost"
              aria-expanded={calendarExpanded}
            >
              {calendarExpanded ? "Hide calendar setup" : "Show calendar setup"}
            </button>
          </div>

          {calendarExpanded && (
            <>
              {/* Consent explanation */}
              <div className="settings-form-group">
                <div className="settings-note info">
                  <p>
                    <strong>What is read:</strong> your calendar events within a small time
                    window + attendee names and emails. <strong>No write access</strong> —
                    we never create, edit, or delete calendar events.
                  </p>
                  <p style={{ marginTop: 8 }}>
                    <strong>Where data lives:</strong> tokens in this machine's keychain
                    (never in config or the database), fetched events in memory only.
                    Nothing leaves this device.
                  </p>
                </div>
              </div>

              {/* Apple Calendar (this Mac) */}
              <div className={`settings-subcard${ekEnabled ? " ok" : ""}`}>
                <div className="settings-subcard-head">
                  🍎 Apple Calendar (this Mac)
                  <span className={`status ${ekEnabled ? "on" : "off"}`}>
                    {ekEnabled ? "Enabled ✓" : "Not enabled"}
                  </span>
                </div>
                <p className="settings-help" style={{ marginTop: 0, marginBottom: 12 }}>
                  Use the calendars already in your Mac's Calendar app — no sign-in, no
                  OAuth, no client IDs. Works with iCloud, Google, Exchange, and any
                  calendar added to the app.
                </p>
                {ekEnabled ? (
                  <button onClick={() => handleEkEnable(false)} className="btn-ghost">
                    Disable Apple Calendar
                  </button>
                ) : (
                  <button onClick={() => handleEkEnable(true)} disabled={ekEnabling} className="btn-primary">
                    {ekEnabling ? "Requesting permission…" : "Enable Apple Calendar"}
                  </button>
                )}
                {ekMsg && (
                  <p className={`settings-msg${ekMsg.includes("denied") ? " warn" : ""}`}>{ekMsg}</p>
                )}
              </div>

              {/* Google Calendar */}
              <div className="settings-subcard">
                <div className="settings-subcard-head">
                  Google Calendar
                  <span className={`status ${calendarCfg.google ? "on" : "off"}`}>
                    {calendarCfg.google ? `connected · ${calendarCfg.google.email}` : "Not connected"}
                  </span>
                </div>

                {!calendarCfg.google && (
                  <>
                    <p className="settings-help" style={{ marginTop: 0 }}>
                      A power-user option: because there's no backend, you register your own
                      Google OAuth client. Most people should use Apple Calendar above.
                    </p>

                    <details className="settings-advanced">
                      <summary>How to get a Google OAuth client ID</summary>
                      <ol className="list-decimal list-inside settings-help" style={{ marginTop: 8 }}>
                        <li>
                          Go to{" "}
                          <button
                            onClick={() => open("https://console.cloud.google.com/apis/credentials")}
                            className="btn-link"
                          >
                            Google Cloud Console
                          </button>
                        </li>
                        <li>Enable the <strong>Google Calendar API</strong>.</li>
                        <li>
                          Configure the <strong>OAuth consent screen</strong> (External; add
                          yourself as a test user) with the{" "}
                          <code>.../auth/calendar.events.readonly</code> scope.
                        </li>
                        <li>Create an OAuth client ID of type <strong>Desktop app</strong>.</li>
                        <li>Paste the Client ID (and secret, if shown) below.</li>
                      </ol>
                      <p className="settings-msg warn">
                        <TriangleAlert size={15} aria-hidden="true" /> Until your app is verified by Google, refresh tokens expire in 7
                        days — you'll need to reconnect periodically.
                      </p>
                    </details>

                    <div className="settings-form-group" style={{ marginTop: 12 }}>
                      <input
                        type="text"
                        value={googleClientId}
                        onChange={(e) => { setGoogleClientId(e.target.value); setGoogleCredsSaved(false); }}
                        placeholder="Client ID (required)"
                        className="settings-input-text font-mono"
                        aria-label="Google Client ID"
                        style={{ marginBottom: 8 }}
                      />
                      <input
                        type="password"
                        value={googleClientSecret}
                        onChange={(e) => { setGoogleClientSecret(e.target.value); setGoogleCredsSaved(false); }}
                        placeholder="Client secret (optional)"
                        className="settings-input-text font-mono"
                        aria-label="Google Client secret"
                        style={{ marginBottom: 10 }}
                      />
                      <div className="settings-row">
                        <button onClick={handleGoogleCredsSave} disabled={!googleClientId.trim()} className="btn-primary">
                          {googleCredsSaved ? "Saved ✓" : "Save to Keychain"}
                        </button>
                        {hasGoogleCreds && (
                          <button onClick={handleGoogleConnect} disabled={calendarConnecting} className="btn-ghost">
                            {calendarConnecting ? "Opening browser…" : "Connect Google Calendar"}
                          </button>
                        )}
                      </div>
                    </div>
                  </>
                )}

                {calendarCfg.google && (
                  <>
                    <p className="settings-help" style={{ marginTop: 0 }}>
                      {calendarCfg.google.display_name && <>{calendarCfg.google.display_name} · </>}
                      token expires {formatDateTime(calendarCfg.google.token_expires_at)}
                    </p>
                    <label className="checkbox-label" style={{ marginBottom: 12 }}>
                      <input
                        type="checkbox"
                        checked={calendarCfg.google.enabled}
                        onChange={(e) => handleGoogleToggle(e.target.checked)}
                      />
                      Enable calendar integration (pre-fill rosters, show upcoming events)
                    </label>
                    <button onClick={handleGoogleDisconnect} className="btn-danger">
                      Disconnect Google Calendar
                    </button>
                  </>
                )}
              </div>

              <p className="settings-help">Microsoft Outlook — coming in a future update.</p>
              {calendarMsg && <p className="settings-msg">{calendarMsg}</p>}
            </>
          )}
        </div>

        {/* SECTION: Data (backup / restore) */}
        <div className={`settings-section-card${activeSettingsTab === "data" ? " active-card" : ""}`}>
          <h3 className="settings-card-title">Data &amp; Backup</h3>
          <p className="settings-card-desc">
            Back up every meeting (notes, transcripts, action items) to a single
            file, or restore them on another machine. The backup is{" "}
            <strong>plaintext JSON</strong> — anyone who can read the file can read
            your notes, so store it somewhere safe.
          </p>
          <div className="settings-form-group">
            <div className="settings-row" style={{ gap: 10 }}>
              <button
                className="btn-primary"
                disabled={dataBusy}
                onClick={async () => {
                  setDataBusy(true);
                  setDataMsg(null);
                  try {
                    const path = await exportAllMeetings();
                    if (path) setDataMsg(`Backed up to ${path}`);
                  } catch (e) {
                    setDataMsg(String(e));
                  } finally {
                    setDataBusy(false);
                  }
                }}
              >
                {dataBusy ? "Working…" : "Back up all meetings…"}
              </button>
              <button
                className="btn-secondary"
                disabled={dataBusy}
                onClick={async () => {
                  setDataBusy(true);
                  setDataMsg(null);
                  try {
                    const count = await importAllMeetings();
                    if (count !== null) setDataMsg(`Restored ${count} meeting${count === 1 ? "" : "s"}. Reopen Meetings to see them.`);
                  } catch (e) {
                    setDataMsg(String(e));
                  } finally {
                    setDataBusy(false);
                  }
                }}
              >
                Restore from backup…
              </button>
            </div>
            {dataMsg && <p className="settings-help">{dataMsg}</p>}
          </div>

          <div className="settings-form-group">
            <h3 className="settings-card-title">Support diagnostics</h3>
            <p className="settings-card-desc">
              Export a small local lifecycle log only when you choose. Email addresses,
              filesystem paths, secrets, and meeting content are redacted; nothing is
              uploaded automatically.
            </p>
            <button className="btn-secondary" disabled={dataBusy} onClick={handleDiagnosticExport}>
              Export redacted diagnostics…
            </button>
          </div>

          {/* Second Brain export: mirror meetings into a local vault folder as
              markdown notes (wikilinks + OKF frontmatter) for Obsidian/graphify. */}
          <h3 className="settings-card-title" style={{ marginTop: 18 }}>Second Brain</h3>
          <p className="settings-card-desc">
            Mirror your meetings into a local folder as markdown notes with
            [[wikilinks]] — readable by Obsidian and your knowledge graph.
            Summaries only (never raw transcripts); locked meetings are never
            exported. Everything stays on this machine.
          </p>
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="second-brain-path">
              Vault folder
            </label>
            <input
              id="second-brain-path"
              className="settings-input-text"
              type="text"
              value={config.second_brain_path}
              onChange={(e) => update({ second_brain_path: e.target.value })}
              placeholder="/Users/you/vault/wiki/meetings"
            />
            <label className="checkbox-label" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={config.second_brain_enabled}
                onChange={(e) => update({ second_brain_enabled: e.target.checked })}
              />
              Auto-export after every meeting change
            </label>
            <p className="settings-help">
              Remember to Save Settings after changing these. Each export rewrites
              the notes, an index.md, and a graph.json in that folder.
            </p>
            <div className="settings-row" style={{ gap: 10, marginTop: 8 }}>
              <button
                className="btn-secondary"
                disabled={dataBusy || !config.second_brain_path.trim()}
                onClick={async () => {
                  setDataBusy(true);
                  setDataMsg(null);
                  try {
                    const count = await exportSecondBrain();
                    setDataMsg(
                      `Exported ${count} meeting note${count === 1 ? "" : "s"} to ${config.second_brain_path.trim()}`,
                    );
                  } catch (e) {
                    setDataMsg(String(e));
                  } finally {
                    setDataBusy(false);
                  }
                }}
              >
                Export now
              </button>
            </div>
          </div>
        </div>

        {/* SECTION: Feedback */}
        <div className={`settings-section-card${activeSettingsTab === "feedback" ? " active-card" : ""}`}>
          <h3 className="settings-card-title">Feedback</h3>
          <p className="settings-card-desc">
            Found a bug or have an idea? Send it straight to the developer. This opens
            your email app with a message addressed to {FEEDBACK_EMAIL} — nothing is
            sent until you press send.
          </p>
          <div className="settings-form-group">
            <textarea
              className="settings-textarea"
              rows={6}
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              placeholder="What's working, what's broken, what you'd love to see…"
            />
            <div className="settings-row" style={{ marginTop: 10 }}>
              <button onClick={sendFeedback} className="btn-primary">Send Feedback</button>
            </div>
            <p className="settings-help">Your message is included as the email body.</p>
          </div>
        </div>

        {/* Bottom action bar */}
        <div className="settings-actionbar">
          {saved && <span className="settings-msg ok" style={{ margin: 0 }}>Settings saved</span>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary"
            aria-label="Save settings"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

      </div>
    </div>
  );
}
