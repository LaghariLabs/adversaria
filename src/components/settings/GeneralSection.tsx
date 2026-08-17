import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";

import type { AppConfig, AppTheme } from "../../types";
import { exportRedactedDiagnostics } from "../../lib/tauri";
import { DATE_FORMAT_OPTIONS, setDateFormat, formatDateTime } from "../../lib/dateFormat";

/** Where beta sign-up + feedback emails are addressed. */
const FEEDBACK_EMAIL = "mhlaghari@gmail.com";
const THEME_PREVIEW_EVENT = "adversaria-theme-preview";

const LANGUAGES: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية (Arabic)" },
  { value: "zh", label: "中文" },
  { value: "hi", label: "हिन्दी" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "bn", label: "বাংলা" },
  { value: "pt", label: "Português" },
  { value: "ru", label: "Русский" },
  { value: "ur", label: "اردو" },
  { value: "auto", label: "Match spoken language" },
];

interface GeneralSectionProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  /** Shown in About, and tagged into the feedback email subject so every report
   *  arrives with the build it came from. */
  appVersion: string;
  /** Re-arm the guided tour and leave Settings so it can start (Phase B —
   *  skipping the tour used to be forever). */
  onReplayTour?: () => void;
}

/** General — who you are, how dates and lists look, and where to get help. */
export function GeneralSection({
  active,
  config,
  update,
  appVersion,
  onReplayTour,
}: GeneralSectionProps) {
  // Diagnostics gets its OWN busy/message pair. The four export/backup buttons
  // used to share one pair rendered in a single place; now that they live in
  // three different sections, a shared channel would print this result into a
  // card the user cannot see.
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagMsg, setDiagMsg] = useState<string | null>(null);

  const handleDiagnosticExport = async () => {
    setDiagBusy(true);
    setDiagMsg(null);
    try {
      const path = await exportRedactedDiagnostics();
      setDiagMsg(path ? "Redacted diagnostics exported." : "Export cancelled.");
    } catch (error) {
      setDiagMsg(String(error));
    } finally {
      setDiagBusy(false);
    }
  };

  // Feedback — opens the user's own mail client pre-addressed to the developer
  // with their typed message as the body. No backend; nothing is sent until they
  // hit send in their email app (privacy-clean).
  const [feedbackText, setFeedbackText] = useState("");
  const sendFeedback = () => {
    const subject = `Adversaria Feedback${appVersion ? ` (v${appVersion})` : ""}`;
    const body = feedbackText.trim();
    open(
      `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    );
  };

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">General</h3>
      <p className="settings-card-desc">
        Your name, how dates and lists look, and where to get help.
      </p>

      {/* ---- You ---- */}
      <h3 className="settings-card-title">You</h3>
      <p className="settings-card-desc">
        The name that stands in for you in transcripts and notes.
      </p>

      {/* Your name — the first thing anyone should be able to set. */}
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

      {/* ---- Formats ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Formats</h3>

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
        {/* Computed at render time with no state behind it — it only refreshes
            because update() re-renders the parent. Do not memoize. */}
        <p className="settings-help">
          How dates appear throughout the app. Preview: {formatDateTime(new Date().toISOString())}
        </p>
      </div>

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

      {/* Appearance */}
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="settings-theme">Appearance</label>
        <select
          id="settings-theme"
          value={
            config.theme === "light" ||
            config.theme === "cream" ||
            config.theme === "navy" ||
            config.theme === "laghari" ||
            config.theme === "system"
              ? config.theme
              : "dark"
          }
          onChange={(e) => {
            const theme = e.target.value as AppTheme;
            update({ theme });
            window.dispatchEvent(new CustomEvent<string>(THEME_PREVIEW_EVENT, { detail: theme }));
          }}
          className="settings-select"
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="cream">Cream</option>
          <option value="navy">Navy</option>
          <option value="laghari">Laghari Labs</option>
          <option value="system">System</option>
        </select>
      </div>

      {/* ---- The meeting list ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>The meeting list</h3>

      {/* Sidebar meeting list style */}
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="settings-sidebar-view">Sidebar meeting list</label>
        <select
          id="settings-sidebar-view"
          value={config.sidebar_view}
          onChange={(e) => update({ sidebar_view: e.target.value })}
          className="settings-select"
        >
          <option value="full">Full cards (default)</option>
          <option value="compact">Compact rows</option>
        </select>
        <p className="settings-help">
          Compact shows one line per meeting with details on hover; Full shows the classic cards. Applies when you save and go back to your meetings.
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
        {/* Nothing is deleted — say so here, or a retention-shaped setting reads
            as "loses my notes after 30 days". */}
        <p className="settings-help">
          Older meetings fold into the sidebar's Archive section. Search and Ask always include them.
        </p>
      </div>

      {/* ---- About & help ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>About &amp; help</h3>

      {appVersion && (
        <div className="settings-form-group">
          <label className="settings-label">Version</label>
          <p className="settings-help" style={{ marginTop: 0 }}>Adversaria v{appVersion}</p>
        </div>
      )}

      <div className="settings-form-group">
        <h3 className="settings-card-title">Support diagnostics</h3>
        <p className="settings-card-desc">
          Export a diagnostics bundle only when you choose — app/OS/memory facts,
          the local AI service's status and log tail, and your local event log.
          Email addresses, filesystem paths, secrets, and meeting content are
          redacted; nothing is uploaded automatically.
        </p>
        <button className="btn-secondary" disabled={diagBusy} onClick={handleDiagnosticExport}>
          Export redacted diagnostics…
        </button>
        {diagMsg && <p className="settings-help">{diagMsg}</p>}
      </div>

      {/* Guided tour replay */}
      {onReplayTour && (
        <div className="settings-form-group">
          <label className="settings-label">App tour</label>
          <button type="button" className="btn-secondary" onClick={onReplayTour}>
            Replay the tour
          </button>
          <p className="settings-help">
            A one-minute walkthrough: recording, your meetings, to-dos, and where
            your models live.
          </p>
        </div>
      )}

      {/* ---- Feedback ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Feedback</h3>
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
  );
}
