import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { TriangleAlert } from "lucide-react";

import type { AppConfig, WhisperModelInfo } from "../../types";
import { downloadWhisperModel, listWhisperModels } from "../../lib/tauri";

interface RecordingTabProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
}

/** Recording — how speech is transcribed, when recording starts/stops, and what you see while it runs. */
export function RecordingTab({ active, config, update }: RecordingTabProps) {
  // On-device Whisper model picker.
  const [whisperModels, setWhisperModels] = useState<WhisperModelInfo[]>([]);
  const [whisperDownloading, setWhisperDownloading] = useState<string | null>(null);

  const loadWhisperModels = useCallback(async () => {
    try {
      setWhisperModels(await listWhisperModels());
    } catch (e) {
      console.error("Failed to load whisper models:", e);
    }
  }, []);

  useEffect(() => {
    loadWhisperModels();
  }, [loadWhisperModels]);

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

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Recording</h3>
      <p className="settings-card-desc">
        How speech is turned into text, when a recording starts and stops, and
        what the app shows while it runs.
      </p>

      {/* ---- Transcription ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Voice Transcription</h3>
      <p className="settings-card-desc">
        Choose how speech is transcribed, and personalize it — custom vocabulary
        helps spell names right. (Your name lives in General.)
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
