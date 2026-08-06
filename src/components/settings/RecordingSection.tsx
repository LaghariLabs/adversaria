import type { ReactNode } from "react";

import type { AppConfig } from "../../types";

/** Windows machines have no notch, so the pill previews would be picturing
 *  hardware the user doesn't own. There is no platform IPC wrapper on the
 *  frontend, so the user agent is the only signal available here. */
const IS_WINDOWS = navigator.userAgent.includes("Windows");

interface PreviewOptionProps {
  /** Radio group name — shared by every option in one group. */
  group: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  note: string;
  isDefault?: boolean;
  /** The picture: in-page markup only, never a real window. */
  children: ReactNode;
}

/** One picture-backed choice. A radio inside the label keeps the whole card
 *  clickable and keyboard-reachable without any JS. */
function PreviewOption({
  group,
  value,
  checked,
  onSelect,
  title,
  note,
  isDefault,
  children,
}: PreviewOptionProps) {
  return (
    <label className="settings-preview">
      <input type="radio" name={group} value={value} checked={checked} onChange={onSelect} />
      <span className="settings-preview-stage">{children}</span>
      <span className="settings-preview-foot">
        <span>
          <strong>{title}</strong>
          <span>{note}</span>
        </span>
        {isDefault ? <span className="settings-chip">Default</span> : null}
      </span>
    </label>
  );
}

/** The recording indicator's two flanking wings. The middle 72px grid column is
 *  the camera housing — an empty cell, not a control. */
function IslandWings() {
  return (
    <>
      <span className="settings-wing">
        <span className="settings-rec-dot" />
        <span className="settings-timer">12:04</span>
      </span>
      <span />
      <span className="settings-wing">
        <span className="settings-wave">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </span>
    </>
  );
}

/** A mock of the recording window: title bar plus whatever panes the view uses. */
function WireBar() {
  return (
    <span className="settings-wire-bar">
      <i />
      <i />
      <i />
    </span>
  );
}

interface RecordingSectionProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  /** Jump to Transcription, where the engine and models live. */
  onOpenTranscription: () => void;
}

/** Recording — how a recording behaves: start/stop, and what you see while it
 *  runs. Which engine and model transcribe lives in Transcription — one home
 *  for every model choice, so nothing is stated in two places. */
export function RecordingSection({
  active,
  config,
  update,
  onOpenTranscription,
}: RecordingSectionProps) {
  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Recording</h3>
      <p className="settings-card-desc">
        When a recording starts and stops, and what the app shows while it runs.{" "}
        Which engine and model turn speech into text lives in{" "}
        <button className="btn-link" type="button" onClick={onOpenTranscription}>
          Transcription →
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
          Use the exact spelling and casing you want to appear in transcripts
          (e.g. Adversaria, iPhone). Leave blank to disable.
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

      {/* ---- Auto-stop ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Auto-Stop</h3>
      <p className="settings-card-desc">
        Automatically pause or end a recording after a stretch of silence.
      </p>

      {/* All three controls stay in ONE group: the two minute fields are gated
          on the checkbox above them, and splitting them apart is how that
          gating quietly stops reading as one decision. */}
      <div className="settings-form-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.auto_stop_enabled}
            onChange={(e) => update({ auto_stop_enabled: e.target.checked })}
          />
          Stop recording automatically after a stretch of silence
        </label>

        <div className="settings-row" style={{ marginTop: 12 }}>
          <div>
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
          <div>
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
          </div>
        </div>

        <p className="settings-help">
          "Ask after" shows a prompt to keep or stop; "Stop after" ends the recording
          on its own. Inactivity is measured from the live caption.
        </p>
      </div>

      {/* ---- While recording ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>While recording</h3>

      {/* Recording view — a layout you can only judge by looking at it, so the
          options are pictures rather than words. */}
      <div className="settings-form-group">
        <span className="settings-label" id="settings-recording-view-label">Recording view</span>
        <div
          className="settings-previews"
          data-cols="2"
          role="radiogroup"
          aria-labelledby="settings-recording-view-label"
        >
          <PreviewOption
            group="settings-recording-view"
            value="balanced"
            checked={config.recording_view === "balanced"}
            onSelect={() => update({ recording_view: "balanced" })}
            title="Balanced"
            note="Live transcript and notes, side by side."
            isDefault
          >
            <span className="settings-wire">
              <WireBar />
              {/* Only the column count differs between the two views, so it is
                  set here rather than in a class of its own. */}
              <span className="settings-wire-split" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <span className="settings-wire-pane">
                  <span className="settings-wire-label">Transcript</span>
                  <span className="settings-wire-line" />
                  <span className="settings-wire-line" />
                  <span className="settings-wire-line" />
                </span>
                <span className="settings-wire-pane">
                  <span className="settings-wire-label">Notes</span>
                  <span className="settings-wire-line accent" />
                  <span className="settings-wire-line" />
                </span>
              </span>
            </span>
          </PreviewOption>

          <PreviewOption
            group="settings-recording-view"
            value="transcript"
            checked={config.recording_view === "transcript"}
            onSelect={() => update({ recording_view: "transcript" })}
            title="Transcript-first"
            note="Notes tucked into a footer."
          >
            <span className="settings-wire">
              <WireBar />
              <span className="settings-wire-pane">
                <span className="settings-wire-label">Transcript</span>
                <span className="settings-wire-line" />
                <span className="settings-wire-line" />
                <span className="settings-wire-line" />
              </span>
              <span className="settings-wire-pane footer">
                <span className="settings-wire-label">Notes</span>
                <span className="settings-wire-line accent" />
              </span>
            </span>
          </PreviewOption>
        </div>
        <p className="settings-help">
          How the window lays out while a recording is running.
        </p>
      </div>

      {/* Notch pill. These previews are drawn in the page — the real pill
          window must never be spawned as a preview (making it non-activating
          crashed the app and was reverted). The pill style is read off disk
          each time a pill is created, so a change needs Save to take effect. */}
      <div className="settings-form-group">
        <span className="settings-label" id="settings-notch-pill-label">Notch pill</span>
        {IS_WINDOWS ? (
          <p className="settings-preview-note">
            This PC has no notch, so there is no pill to show. The pill is a Mac
            feature — recording works the same either way.
          </p>
        ) : (
          <>
            <div
              className="settings-previews"
              data-cols="3"
              role="radiogroup"
              aria-labelledby="settings-notch-pill-label"
            >
              <PreviewOption
                group="settings-notch-pill"
                value="minimal"
                checked={config.notch_pill_style === "minimal"}
                onSelect={() => update({ notch_pill_style: "minimal" })}
                title="Minimal"
                note="Dot, timer, waveform."
                isDefault
              >
                <span className="settings-screen-top">
                  <span className="settings-island">
                    <IslandWings />
                  </span>
                </span>
              </PreviewOption>

              <PreviewOption
                group="settings-notch-pill"
                value="expressive"
                checked={config.notch_pill_style === "expressive"}
                onSelect={() => update({ notch_pill_style: "expressive" })}
                title="Expressive"
                note="Expands on hover. Not available yet."
              >
                <span className="settings-screen-top">
                  <span className="settings-island settings-island-expressive">
                    <span className="settings-island-strip">
                      <IslandWings />
                    </span>
                    <span className="settings-island-body">
                      <span className="settings-island-line">Weekly sync</span>
                      <span className="settings-island-line dim">Recording · 12:04</span>
                    </span>
                  </span>
                </span>
              </PreviewOption>

              {/* "Hidden" is a privacy affordance, not a cosmetic choice: the
                  pill is captured by screen sharing and this is the way to
                  keep it out of frame. Never drop this option. */}
              <PreviewOption
                group="settings-notch-pill"
                value="hidden"
                checked={config.notch_pill_style === "hidden"}
                onSelect={() => update({ notch_pill_style: "hidden" })}
                title="Hidden"
                note="No pill — nothing shows when you share your screen."
              >
                <span className="settings-screen-top">
                  <span className="settings-notch" />
                </span>
              </PreviewOption>
            </div>
            <p className="settings-help">
              The small pill by the notch while you record. Expressive isn't available yet — it currently shows the minimal pill.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
