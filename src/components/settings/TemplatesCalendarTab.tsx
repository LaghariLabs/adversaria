import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { TriangleAlert } from "lucide-react";

import type {
  AppConfig,
  CalendarAccount,
  CalendarConfig,
  PromptTemplate,
  TemplateInfo,
} from "../../types";
import {
  calendarConnect,
  calendarDisconnect,
  calendarHasCredentials,
  calendarMacosEnable,
  calendarSetCredentials,
  calendarStatus,
  deleteTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
} from "../../lib/tauri";
import { formatDateTime } from "../../lib/dateFormat";
import { templateDisplayName } from "../../lib/templateNames";

interface TemplatesCalendarTabProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  /** Write a whole config to disk immediately (used by the calendar toggle). */
  persist: (next: AppConfig) => Promise<void>;
}

/** Templates & Calendar — the prompts that shape notes, and the calendars that fill rosters. */
export function TemplatesCalendarTab({ active, config, update, persist }: TemplatesCalendarTabProps) {
  // --- Prompt templates ---
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<string>("");
  const [templateBody, setTemplateBody] = useState<string>("");
  const [newTemplateName, setNewTemplateName] = useState<string>("");
  const [templateMsg, setTemplateMsg] = useState<string>("");

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

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

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

  // --- Calendar ---
  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const [calendarCfg, setCalendarCfg] = useState<CalendarConfig>(config.calendar);
  const [hasGoogleCreds, setHasGoogleCreds] = useState<boolean | null>(null);
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [googleCredsSaved, setGoogleCredsSaved] = useState(false);
  const [calendarConnecting, setCalendarConnecting] = useState(false);
  const [calendarMsg, setCalendarMsg] = useState<string | null>(null);

  // --- macOS EventKit ---
  const [ekEnabled, setEkEnabled] = useState(config.calendar.macos_eventkit_enabled);
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
    if (!calendarCfg.google) return;
    const account: CalendarAccount = { ...calendarCfg.google, enabled };
    const nextCfg: CalendarConfig = {
      ...calendarCfg,
      google: account,
    };
    setCalendarCfg(nextCfg);
    persist({ ...config, calendar: nextCfg }).catch((e) => setCalendarMsg(String(e)));
  };

  // --- macOS EventKit enable / disable ---
  const handleEkEnable = async (enable: boolean) => {
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

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Templates &amp; Calendar</h3>
      <p className="settings-card-desc">
        The prompts that shape your notes, and the calendars that pre-fill who was
        in the room.
      </p>

      {/* ---- Prompts & templates ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Prompts &amp; Templates</h3>
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
            <option key={t.name} value={t.name}>{templateDisplayName(t.name)}</option>
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
            <option key={t.name} value={t.name}>{templateDisplayName(t.name)}</option>
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

      {/* ---- Calendar ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Calendar</h3>
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
  );
}
