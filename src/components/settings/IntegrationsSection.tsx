import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { TriangleAlert } from "lucide-react";

import type { AppConfig, CalendarAccount, CalendarConfig } from "../../types";
import {
  calendarConnect,
  calendarDisconnect,
  calendarHasCredentials,
  calendarMacosEnable,
  calendarSetCredentials,
  calendarStatus,
  exportSecondBrain,
} from "../../lib/tauri";
import { formatDateTime } from "../../lib/dateFormat";

interface IntegrationsSectionProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  /** Write a whole config to disk immediately (used by the calendar toggle). */
  persist: (next: AppConfig) => Promise<void>;
}

/** Integrations — the calendars that pre-fill who was in the room, and the folder notes mirror into. */
export function IntegrationsSection({ active, config, update, persist }: IntegrationsSectionProps) {
  // --- Calendar ---
  // Seeded once from the prop and owned locally afterwards: calendar_status and
  // calendar_macos_enable write config through Rust, so the config prop is never
  // refreshed for these fields and syncing to it would show stale values.
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

  // Status messages auto-dismiss on cadences users have learned (2s for a
  // credential save or disconnect, 3s for "Connected!", 4s for Apple Calendar).
  // The originals never cleared their timers, so a dismiss could land after the
  // component went away.
  const calendarMsgTimer = useRef<number | null>(null);
  const ekMsgTimer = useRef<number | null>(null);

  const flashCalendarMsg = useCallback((msg: string, afterMs: number) => {
    setCalendarMsg(msg);
    if (calendarMsgTimer.current !== null) window.clearTimeout(calendarMsgTimer.current);
    calendarMsgTimer.current = window.setTimeout(() => setCalendarMsg(null), afterMs);
  }, []);

  useEffect(
    () => () => {
      if (calendarMsgTimer.current !== null) window.clearTimeout(calendarMsgTimer.current);
      if (ekMsgTimer.current !== null) window.clearTimeout(ekMsgTimer.current);
    },
    [],
  );

  const refreshCalendarState = useCallback(async () => {
    try {
      const status = await calendarStatus();
      // Keep the config-seeded snapshot rather than adopting a missing answer.
      // Storing null here crashed the RENDER — not this callback — so the catch
      // never saw it and the whole Settings pane went blank.
      if (status) {
        setCalendarCfg(status);
        setEkEnabled(status.macos_eventkit_enabled);
      }
      const hasCreds = await calendarHasCredentials("google");
      setHasGoogleCreds(hasCreds);
    } catch (e) {
      console.error("Failed to refresh calendar state:", e);
    }
  }, []);

  // This used to be gated on the "Show calendar setup" disclosure. The setup is
  // always visible now, so it is gated on `active` instead: sections stay
  // mounted, so without a gate this would only ever run at mount and the pane
  // would show a snapshot from app start. hasGoogleCreds starts null, so the
  // Connect button cannot appear until this has run at least once.
  useEffect(() => {
    if (active) {
      void refreshCalendarState();
    }
  }, [active, refreshCalendarState]);

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
      setHasGoogleCreds(true);
      flashCalendarMsg("Credentials saved to keychain.", 2000);
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
      // Connecting does not switch the integration on — that is the toggle below.
      flashCalendarMsg("Connected! Don't forget to enable the toggle below.", 3000);
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
      flashCalendarMsg("Disconnected.", 2000);
    } catch (e) {
      setCalendarMsg(String(e));
    }
  };

  // Writes to disk immediately. As a deferred edit a connected-and-enabled
  // calendar silently reverts, so this must stay a persist().
  // Known hazard, carried over unchanged: `next` is built from the LOCAL
  // calendar snapshot while calendar_macos_enable writes Apple Calendar's flag
  // through Rust and never updates the config prop — so this write can put back
  // a stale macos_eventkit_enabled. Don't make it worse by widening what this
  // spreads.
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
  // Rust owns this flag (it writes config itself) and returns the EFFECTIVE
  // state, so a denied permission comes back false and leaves the toggle off.
  // Never write macos_eventkit_enabled from here as well.
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
      // Keep the config-seeded snapshot rather than adopting a missing answer.
      // Storing null here crashed the RENDER — not this callback — so the catch
      // never saw it and the whole Settings pane went blank.
      if (status) {
        setCalendarCfg(status);
        setEkEnabled(status.macos_eventkit_enabled);
      }
      if (ekMsgTimer.current !== null) window.clearTimeout(ekMsgTimer.current);
      ekMsgTimer.current = window.setTimeout(() => setEkMsg(null), 4000);
    } catch (e) {
      setEkMsg(String(e));
    } finally {
      setEkEnabling(false);
    }
  };

  // --- Second Brain export ---
  // Its own busy/message pair: this button shared one with Back up, Restore and
  // the diagnostics export, and those live in other sections now, so a shared
  // pair would leave this button with no visible result at all.
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const handleSecondBrainExport = async () => {
    setExportBusy(true);
    setExportMsg(null);
    try {
      const count = await exportSecondBrain();
      setExportMsg(
        `Exported ${count} meeting note${count === 1 ? "" : "s"} to ${config.second_brain_path.trim()}`,
      );
    } catch (e) {
      setExportMsg(String(e));
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Integrations</h3>
      <p className="settings-card-desc">
        Calendars that fill in who was in the room, and a folder your notes are
        mirrored into.
      </p>

      {/* ---- Calendar ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Calendar</h3>
      <p className="settings-card-desc">
        Connect your calendars to pre-fill rosters and show upcoming events.
        Everything stays on this device.
      </p>

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

      {/* Apple Calendar (this Mac) — no platform gate today, so this also shows on
          Windows, where the Rust command answers "EventKit is macOS-only". */}
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

      {/* Google Calendar — two steps: credentials into the keychain first, then
          Connect appears. */}
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

      {/* ---- Second Brain ----
          Mirror meetings into a local vault folder as markdown notes (wikilinks
          + OKF frontmatter) for Obsidian/graphify. */}
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
        {/* Both fields above are deferred to Save, which is the only reason this
            sentence exists — and why Export now writes to the folder on disk,
            not the one being typed. */}
        <p className="settings-help">
          Remember to Save Settings after changing these. Each export rewrites
          the notes, an index.md, and a graph.json in that folder.
        </p>
        <div className="settings-row" style={{ gap: 10, marginTop: 8 }}>
          <button
            className="btn-secondary"
            disabled={exportBusy || !config.second_brain_path.trim()}
            onClick={handleSecondBrainExport}
          >
            Export now
          </button>
        </div>
        {exportMsg && <p className="settings-msg">{exportMsg}</p>}
      </div>
    </div>
  );
}
