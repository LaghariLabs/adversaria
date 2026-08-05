import type { AppConfig } from "../../types";
import { DATE_FORMAT_OPTIONS, setDateFormat, formatDateTime } from "../../lib/dateFormat";

const LANGUAGES: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية (Arabic)" },
  { value: "auto", label: "Match spoken language" },
];

interface GeneralTabProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  /** Re-arm the guided tour and leave Settings so it can start (Phase B —
   *  skipping the tour used to be forever). */
  onReplayTour?: () => void;
}

/** General — who you are, plus the app-wide preferences (language, dates, list style). */
export function GeneralTab({ active, config, update, onReplayTour }: GeneralTabProps) {
  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">General</h3>
      <p className="settings-card-desc">
        Your name and the preferences that apply across the whole app.
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

      {/* Pre-meeting notification — the wizard asks this once on its Ready
          screen; this is the same setting, editable later. */}
      <div className="settings-form-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.meeting_reminder_enabled}
            onChange={(e) => update({ meeting_reminder_enabled: e.target.checked })}
          />
          Notify me before my meetings start
        </label>
        {config.meeting_reminder_enabled && (
          <select
            id="settings-meeting-reminder-minutes"
            aria-label="Minutes before the meeting to notify"
            value={config.meeting_reminder_minutes}
            onChange={(e) => update({ meeting_reminder_minutes: Number(e.target.value) })}
            className="settings-select"
          >
            <option value={2}>2 minutes before</option>
            <option value={5}>5 minutes before (default)</option>
            <option value={10}>10 minutes before</option>
            <option value={15}>15 minutes before</option>
          </select>
        )}
        <p className="settings-help">
          One notification per meeting, from your connected calendar
          (Templates &amp; Calendar tab). Nothing fires when no calendar is
          connected.
        </p>
      </div>

      {/* Daily to-do digest. Separate from the pre-meeting alert above: this one
          summarises due/overdue action items. It shipped with no setting at all
          until 2026-08-05, so it stays ON by default — the point is that it can
          now be turned off. */}
      <div className="settings-form-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.todo_digest_enabled}
            onChange={(e) => update({ todo_digest_enabled: e.target.checked })}
          />
          Send me a daily to-do summary
        </label>
        {config.todo_digest_enabled && (
          <select
            id="settings-todo-digest-hour"
            aria-label="Hour to send the daily to-do summary"
            value={config.todo_digest_hour}
            onChange={(e) => update({ todo_digest_hour: Number(e.target.value) })}
            className="settings-select"
          >
            <option value={7}>At 07:00</option>
            <option value={8}>At 08:00</option>
            <option value={9}>At 09:00 (default)</option>
            <option value={12}>At 12:00</option>
            <option value={18}>At 18:00</option>
          </select>
        )}
        <p className="settings-help">
          One notification a day covering to-dos that are due or overdue — never
          one per task. Adversaria has to be running; if it was closed at that
          hour you get the summary shortly after the next launch.
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
          <option value="full">Full cards (default)</option>
          <option value="compact">Compact rows</option>
        </select>
        <p className="settings-help">
          Compact shows one line per meeting with details on hover; Full shows the classic cards. Applies when you save and go back to your meetings.
        </p>
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
    </div>
  );
}
