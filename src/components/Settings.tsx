import { useState, useEffect, useCallback, useRef } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Activity,
  AudioLines,
  Bell,
  FileText,
  Mic2,
  Plug,
  ShieldCheck,
  User,
} from "lucide-react";

import type { AppConfig, RegistrationState } from "../types";
import { getConfig, updateConfig, getRegistrationState, retryRegistration } from "../lib/tauri";
import { setDateFormat } from "../lib/dateFormat";
import { useServiceHealth } from "../hooks/useServiceHealth";
import { useSettingsModels } from "../hooks/useSettingsModels";
import { SetupStatusSection } from "./settings/SetupStatusSection";
import { RecordingSection } from "./settings/RecordingSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { TranscriptionSection } from "./settings/TranscriptionSection";
import { NotesSection } from "./settings/NotesSection";
import { IntegrationsSection } from "./settings/IntegrationsSection";
import { PrivacyDataSection } from "./settings/PrivacyDataSection";
import { GeneralSection } from "./settings/GeneralSection";

type SettingsTab =
  | "setup"
  | "recording"
  | "notifications"
  | "transcription"
  | "notes"
  | "integrations"
  | "privacy"
  | "general";

/** Sidebar order = the order the work happens in, then the app around it.
 *  Each `label` MUST equal its section's first `.settings-card-title`. */
const TABS: { id: SettingsTab; label: string; icon: JSX.Element }[] = [
  { id: "setup", label: "Setup status", icon: <Activity size={15} aria-hidden="true" /> },
  { id: "recording", label: "Recording", icon: <Mic2 size={15} aria-hidden="true" /> },
  { id: "notifications", label: "Notifications", icon: <Bell size={15} aria-hidden="true" /> },
  {
    id: "transcription",
    label: "Transcription",
    icon: <AudioLines size={15} aria-hidden="true" />,
  },
  { id: "notes", label: "Notes", icon: <FileText size={15} aria-hidden="true" /> },
  { id: "integrations", label: "Integrations", icon: <Plug size={15} aria-hidden="true" /> },
  { id: "privacy", label: "Privacy & data", icon: <ShieldCheck size={15} aria-hidden="true" /> },
  { id: "general", label: "General", icon: <User size={15} aria-hidden="true" /> },
];

/** Tab ids that existed before the 8-section rebuild, kept working for one
 *  release. An unknown id used to render the sidebar over a COMPLETELY EMPTY
 *  pane — `.settings-section-card` is `display:none` without `.active-card`, so
 *  nothing matched, with no error and no failing test. Every entry point into
 *  Settings (the wizard, the tour's last step, the transcription chip) went
 *  through one of these, so they resolve rather than 404 into blankness. */
const LEGACY_TABS: Record<string, SettingsTab> = {
  // The engine + model choice that used to live in "AI Model" is transcription's.
  model: "transcription",
  // Prompt templates moved in with the notes model.
  templates: "notes",
};

const DEFAULT_TAB: SettingsTab = "setup";

/** Resolve a caller-supplied id to a real section, never to a blank pane. */
function resolveTab(id: string | undefined): SettingsTab {
  if (!id) return DEFAULT_TAB;
  if (TABS.some((tab) => tab.id === id)) return id as SettingsTab;
  return LEGACY_TABS[id] ?? DEFAULT_TAB;
}

interface SettingsProps {
  /** Section to open on. Accepts the legacy ids above. */
  initialTab?: string;
  /** Bumped by the caller on every navigation request, so a Settings view that
   *  is already open still switches sections when the target is unchanged. */
  tabNonce?: number;
  /** Clears `tour_completed` and navigates away so the tour can restart. */
  onReplayTour?: () => void;
}

/**
 * Settings shell: owns the config, the section menu, and the Save button.
 *
 * It also owns the state that more than one section needs — service health and
 * the model-download pipeline — because those are single state machines. Mounting
 * them per section would double the IPC traffic and split the download
 * completion-gating set, so a finished model would either steal the one in use or
 * never activate. See docs/SETTINGS_REDESIGN.md.
 *
 * Sections are ALL mounted; `active` only toggles a CSS class. That is load
 * bearing: fetches and pollers run regardless of which section is showing, which
 * is what lets a download re-attach after navigating away, and it keeps the
 * jargon-guard test scanning every section's copy.
 */
export function Settings({ initialTab, tabNonce, onReplayTour }: SettingsProps) {
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
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>(resolveTab(initialTab));

  useEffect(() => {
    if (initialTab) setActiveSettingsTab(resolveTab(initialTab));
  }, [initialTab, tabNonce]);

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

  // Live mirror, assigned on every render. Immediate writes merge onto this, not
  // onto a fresh disk read: handing the shell the whole disk copy is what wiped
  // unsaved edits across every tab (2026-08-03).
  const configRef = useRef<AppConfig>(config as AppConfig);
  configRef.current = config as AppConfig;

  const health = useServiceHealth();
  useEffect(() => {
    void health.checkHealth();
  }, [health.checkHealth]);

  const models = useSettingsModels(configRef, setConfig, health.checkHealth);

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
        <SetupStatusSection
          active={activeSettingsTab === "setup"}
          config={config}
          update={update}
          health={health}
          setup={models.setup}
          whisperModels={models.whisperModels}
          appVersion={appVersion}
          registration={registrationState}
          registrationRetrying={registrationRetrying}
          onRegistrationRetry={handleRegistrationRetry}
          onOpen={setActiveSettingsTab}
        />
        <RecordingSection
          active={activeSettingsTab === "recording"}
          config={config}
          update={update}
          onOpenTranscription={() => setActiveSettingsTab("transcription")}
        />
        <NotificationsSection
          active={activeSettingsTab === "notifications"}
          config={config}
          update={update}
        />
        <TranscriptionSection
          active={activeSettingsTab === "transcription"}
          config={config}
          update={update}
          health={health}
          models={models}
        />
        <NotesSection
          active={activeSettingsTab === "notes"}
          config={config}
          update={update}
          models={models}
        />
        <IntegrationsSection
          active={activeSettingsTab === "integrations"}
          config={config}
          update={update}
          persist={persist}
        />
        <PrivacyDataSection
          active={activeSettingsTab === "privacy"}
          config={config}
          update={update}
          persist={persist}
        />
        <GeneralSection
          active={activeSettingsTab === "general"}
          config={config}
          update={update}
          appVersion={appVersion}
          onReplayTour={onReplayTour}
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
