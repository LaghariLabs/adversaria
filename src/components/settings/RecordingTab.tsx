import type { AppConfig } from "../../types";

interface RecordingTabProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  /** Jump to AI Model, where the transcription engine and models live. */
  onOpenModelTab: () => void;
}

/** Recording — how a recording behaves: start/stop, detection, and what you
 *  see while it runs. Which engine and model transcribe lives in AI Model —
 *  one home for every model choice, so nothing is stated in two places. */
export function RecordingTab({ active, config, update, onOpenModelTab }: RecordingTabProps) {
  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Recording</h3>
      <p className="settings-card-desc">
        When a recording starts and stops, and what the app shows while it runs.{" "}
        Which engine and model turn speech into text lives in{" "}
        <button className="btn-link" type="button" onClick={onOpenModelTab}>
          AI Model →
        </button>
      </p>

      {/* ---- Transcription behavior ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Voice Transcription</h3>
      <p className="settings-card-desc">
        Personalize how speech is transcribed — custom vocabulary helps spell
        names right. (Your name lives in General.)
      </p>

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

      {/* ---- Auto-stop & detection ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Auto-Stop &amp; Detection</h3>
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

      {/* ---- While recording ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>While recording</h3>

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
    </div>
  );
}
