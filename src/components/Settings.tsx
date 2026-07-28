import { useState, useEffect, useCallback } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Bot, CalendarDays, Mic2, ShieldCheck, User } from "lucide-react";

import type { AppConfig, RegistrationState } from "../types";
import { getConfig, updateConfig, getRegistrationState, retryRegistration } from "../lib/tauri";
import { setDateFormat } from "../lib/dateFormat";
import { GeneralTab } from "./settings/GeneralTab";
import { AiModelTab } from "./settings/AiModelTab";
import { RecordingTab } from "./settings/RecordingTab";
import { TemplatesCalendarTab } from "./settings/TemplatesCalendarTab";
import { PrivacyDataTab } from "./settings/PrivacyDataTab";

type SettingsTab = "general" | "model" | "recording" | "templates" | "privacy";

const TABS: { id: SettingsTab; label: string; icon: JSX.Element }[] = [
  { id: "general", label: "General", icon: <User size={15} aria-hidden="true" /> },
  { id: "model", label: "AI Model", icon: <Bot size={15} aria-hidden="true" /> },
  { id: "recording", label: "Recording", icon: <Mic2 size={15} aria-hidden="true" /> },
  {
    id: "templates",
    label: "Templates & Calendar",
    icon: <CalendarDays size={15} aria-hidden="true" />,
  },
  {
    id: "privacy",
    label: "Privacy & Data",
    icon: <ShieldCheck size={15} aria-hidden="true" />,
  },
];

/**
 * Settings shell: owns the config, the tab menu, and the Save button. Each tab
 * is a card in `./settings/` that receives the config and edits it through
 * `update` (saved on Save) or `persist` (written immediately).
 */
interface SettingsProps {
  /** Tab to open on (used by the guided tour to land on AI Model). */
  initialTab?: string;
}

export function Settings({ initialTab }: SettingsProps) {
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
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>(
    (initialTab as SettingsTab) || "general",
  );

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

  useEffect(() => {
    loadConfig();
    getRegistrationState().then(setRegistrationState).catch(() => {});
  }, [loadConfig]);

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
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  /** Edit + write to disk in one step, for settings that take effect immediately. */
  const persist = async (next: AppConfig) => {
    setConfig(next);
    await updateConfig(next);
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
        <GeneralTab
          active={activeSettingsTab === "general"}
          config={config}
          update={update}
        />
        <AiModelTab
          active={activeSettingsTab === "model"}
          config={config}
          update={update}
          replaceConfig={setConfig}
        />
        <RecordingTab
          active={activeSettingsTab === "recording"}
          config={config}
          update={update}
        />
        <TemplatesCalendarTab
          active={activeSettingsTab === "templates"}
          config={config}
          update={update}
          persist={persist}
        />
        <PrivacyDataTab
          active={activeSettingsTab === "privacy"}
          config={config}
          update={update}
          persist={persist}
          appVersion={appVersion}
        />

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
