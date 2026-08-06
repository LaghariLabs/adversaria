import type { AppConfig } from "../../types";

interface NotificationsSectionProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
}

/** Notifications — every moment Adversaria speaks up on its own. The offer to
 *  record leads the section: it is the one thing people go hunting for when it
 *  stops appearing, and it used to sit halfway down the Recording tab. */
export function NotificationsSection({ active, config, update }: NotificationsSectionProps) {
  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Notifications</h3>
      <p className="settings-card-desc">
        The three times Adversaria speaks up on its own: when it notices a call,
        before a meeting on your calendar, and once a day about your to-dos.
      </p>

      {/* ---- The record offer ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>
        Offer to record when a meeting starts
      </h3>
      <p className="settings-card-desc">
        Adversaria watches for a call app using your microphone, then offers to
        record.
      </p>

      <div className="settings-form-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.auto_detect_meetings}
            onChange={(e) => update({ auto_detect_meetings: e.target.checked })}
          />
          Auto-detect meetings (prompt to record when a call app uses your mic)
        </label>
        <p className="settings-help">
          With this off, no offer appears and you start every recording yourself.
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

      {/* ---- Before a calendar meeting ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Before a meeting on your calendar</h3>

      {/* The wizard asks this once on its Ready screen; this is the same
          setting, editable later. */}
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
          (Integrations). Nothing fires when no calendar is connected.
        </p>
      </div>

      {/* ---- Daily to-do summary ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Daily to-do summary</h3>

      {/* Separate from the pre-meeting alert above: this one summarises
          due/overdue action items. It shipped with no setting at all until
          2026-08-05, so it stays ON by default — the point is that it can now
          be turned off. */}
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
    </div>
  );
}
