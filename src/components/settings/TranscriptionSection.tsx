import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { TriangleAlert } from "lucide-react";

import type { AppConfig, TranscriptionProvider } from "../../types";
import { classifyTranscriptionProvider } from "../../types";
import type { ServiceHealth } from "../../hooks/useServiceHealth";
import type { SettingsModels } from "../../hooks/useSettingsModels";
import { aggregatePercent, formatGb, isInFlight, whisperModelId } from "../../lib/modelDownloads";
import { resetModelDownload } from "../../lib/tauri";

interface TranscriptionSectionProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  health: ServiceHealth;
  models: SettingsModels;
}

/**
 * Transcription — where meeting audio becomes text.
 *
 * Destination first: the engine choice comes before anything else, and only the
 * fields that destination needs are rendered. The privacy copy is keyed on the
 * HOST, never on the dropdown label — a public URL typed into the self-hosted
 * field is not a server the user runs, and saying otherwise would put a false
 * privacy claim on screen.
 */
export function TranscriptionSection({
  active,
  config,
  update,
  health,
  models,
}: TranscriptionSectionProps) {
  const { setup, whisperModels, whisperMsg, setWhisperMsg, downloads, beginDownload, activateWhisperModel } =
    models;
  const [redownloadArmed, setRedownloadArmed] = useState<string | null>(null);

  const downloadWhisper = async (key: string) => {
    setWhisperMsg("");
    await beginDownload(whisperModelId(key), setWhisperMsg);
  };

  const redownloadWhisper = async (key: string) => {
    const id = whisperModelId(key);
    if (redownloadArmed !== id) {
      setRedownloadArmed(id);
      window.setTimeout(
        () => setRedownloadArmed((current) => (current === id ? null : current)),
        5000,
      );
      return;
    }
    setRedownloadArmed(null);
    setWhisperMsg("");
    try {
      await resetModelDownload(id, true);
      await beginDownload(id, setWhisperMsg);
    } catch (e) {
      setWhisperMsg(String(e));
    }
  };

  // The picker follows the SAVED provider, not "is a URL filled in" — a
  // self-hosted Whisper box and a cloud API both have a base URL, and only the
  // provider tells them apart (their privacy copy is opposite).
  const txProvider = config.transcription_provider;
  const txRemote = txProvider !== "local";
  const txSelfHosted = txProvider === "self_hosted";
  const txHost = (() => {
    try {
      return new URL(config.transcription_base_url).host;
    } catch {
      return "";
    }
  })();
  // The dropdown says what the user MEANT; only the host says where the audio
  // goes. Blank counts as fine: nothing is uploaded yet.
  const txOwnNetwork = classifyTranscriptionProvider(config.transcription_base_url) !== "cloud";
  const transcriberState = health.health?.transcriber_state;
  const transcriptionChip =
    transcriberState === "ready"
      ? { text: "Ready ✓", tone: "ok" }
      : transcriberState === "loading"
        ? { text: "Starting up…", tone: "" }
        : transcriberState === "error"
          ? { text: health.health?.transcriber_detail || "Needs attention", tone: "err" }
          : transcriberState === "missing"
            ? { text: "No model downloaded yet", tone: "warn" }
            : null;

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`} data-tour="ai-model">
      <h3 className="settings-card-title">Transcription</h3>
      <p className="settings-card-desc">
        Where meeting audio becomes text. Pick a destination first — only the settings
        it needs will appear.
      </p>

      {/* Engine choice lives HERE, with the models — Recording only holds
          recording behavior. Two places showing engine state read as a
          duplicate (Hamza, 2026-08-01). */}
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="settings-transcription-engine">Engine</label>
        <select
          id="settings-transcription-engine"
          value={txProvider}
          onChange={(e) => {
            const provider = e.target.value as TranscriptionProvider;
            const patch: Partial<AppConfig> = { transcription_provider: provider };
            // A key is issued FOR a host, and changing the engine changes the
            // host — carrying it over Bearer-sends one org's credential to the
            // new endpoint (python-service/src/transcriber.py `transcribe_cloud`).
            patch.transcription_api_key = "";
            if (provider === "local") {
              // A blank base URL is what routes transcription on-device
              // (src-tauri/src/commands.rs `configured_transcription_base_url`).
              patch.transcription_base_url = "";
            } else {
              // A cloud provider's address is not "a server you run": keeping
              // it would go on uploading there while the panel below promised
              // the audio never left the network.
              if (provider === "self_hosted" && txProvider === "cloud") {
                patch.transcription_base_url = "";
              }
              // Only a provider we can name gets a preset, and only into an
              // empty field — never clobber an address the user typed. A
              // self-hosted box has no address we could guess.
              if (provider === "cloud" && !config.transcription_base_url.trim()) {
                patch.transcription_base_url = "https://api.groq.com/openai/v1";
              }
              patch.transcription_model =
                config.transcription_model?.trim() || "whisper-large-v3";
            }
            update(patch);
          }}
          className="settings-select"
        >
          <option value="local">On-device — private, runs on this computer (recommended)</option>
          <option value="self_hosted">Self-hosted server — your own Whisper API</option>
          <option value="cloud">Cloud service — a provider's API</option>
        </select>
      </div>

      {txRemote ? (
        <>
          <div className="settings-form-group">
            {txSelfHosted && txOwnNetwork ? (
              <div className="settings-note info">
                Your audio goes to the Whisper server <strong>you run</strong>
                {txHost ? ` (${txHost})` : ""} and never to a third party — it
                stays on your network. <strong>Speaker labeling is
                unavailable</strong> on a remote server (its audio is labeled
                "Them", not "Speaker 1/2").
              </div>
            ) : txSelfHosted ? (
              <div className="settings-note warn">
                <TriangleAlert size={14} aria-hidden="true" /> {txHost || "That address"} isn't
                an address on your network — audio sent there leaves this device.
                Point this at your own server, or switch the engine to{" "}
                <strong>Cloud service</strong> so the warning matches what happens.{" "}
                <strong>Speaker labeling is unavailable</strong> on a remote server
                either way (its audio is labeled "Them", not "Speaker 1/2").
              </div>
            ) : (
              <div className="settings-note warn">
                <TriangleAlert size={14} aria-hidden="true" /> Cloud transcription uploads your meeting audio to{" "}
                {txHost || "the provider"}{" "}
                — this is <strong>not sovereign</strong> (audio leaves your device), and{" "}
                <strong>speaker labeling is unavailable</strong> in this mode (remote
                audio is labeled "Them", not "Speaker 1/2"). For private, labeled
                transcripts, use the on-device engine.
              </div>
            )}
          </div>
          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-transcription-base">Transcription Base URL</label>
            <input
              id="settings-transcription-base"
              type="text"
              value={config.transcription_base_url}
              onChange={(e) => update({ transcription_base_url: e.target.value })}
              className="settings-input-text"
              placeholder={
                txSelfHosted
                  ? "http://dgx.office.local:8000/v1"
                  : "https://api.groq.com/openai/v1"
              }
            />
            {!config.transcription_base_url.trim() && (
              <p className="settings-help">
                Until this address is set, transcription runs on this computer.
              </p>
            )}
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
            <label className="settings-label" htmlFor="settings-transcription-key">
              {txSelfHosted ? "API Key (optional)" : "API Key"}
            </label>
            <input
              id="settings-transcription-key"
              type="password"
              value={config.transcription_api_key}
              onChange={(e) => update({ transcription_api_key: e.target.value })}
              className="settings-input-text"
              placeholder={txSelfHosted ? "Leave blank if not required" : "gsk_..."}
            />
            {txSelfHosted ? (
              <p className="settings-help">
                Leave this blank if your server doesn't ask for one — nothing is
                sent with the request unless a key is here.
              </p>
            ) : (
              <p className="settings-help">
                Free key at{" "}
                <button className="btn-link" onClick={() => open("https://console.groq.com/keys")}>
                  console.groq.com/keys
                </button>
                . Large v3 covers 99 languages (including Arabic).
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="settings-form-group">
          {active && health.healthStatus === "unreachable" && (
            <div className="settings-note err">
              <TriangleAlert size={14} aria-hidden="true" /> Local AI is offline — the app can&apos;t reach its on-device service.
              {health.serviceRestartMessage ? ` ${health.serviceRestartMessage}` : ""}
              <br />
              <button className="btn-ghost" onClick={() => health.restartService()} disabled={health.serviceRestarting}>
                {health.serviceRestarting ? "Restarting…" : "Restart Local AI"}
              </button>
              {" "}
              {setup?.platform === "windows"
                ? "If it was just installed, Windows Security may have quarantined it — check Protection history, allow adversaria-service.exe, then restart."
                : "Check logs/adversaria-service.log via Settings, then restart."}
            </div>
          )}
          {health.health?.transcriber_state === "error" && health.health?.transcriber_detail && (
            <div className="settings-note err">{health.health.transcriber_detail}</div>
          )}
          {transcriptionChip && (
            <p className={`settings-msg ${transcriptionChip.tone}`}>{transcriptionChip.text}</p>
          )}
          {whisperModels.length === 0 ? (
            <div className="settings-note info">
              The list of transcription models isn&apos;t available yet — it appears once
              the on-device service is running.
              {health.healthStatus === "unreachable" && " Fix Local AI first."}
            </div>
          ) : (
            <div className="settings-model-list">
              {whisperModels.map((model) => {
                const id = whisperModelId(model.key);
                const status = downloads[id];
                const running = status ? isInFlight(status) : false;
                const percent = status ? aggregatePercent([status]) : null;
                const isActive = model.key === config.whisper_model;
                const downloaded = model.downloaded || status?.state === "ready";
                return (
                  <div
                    key={model.key}
                    className={`settings-model-row${isActive ? " active" : ""}`}
                  >
                    <div className="settings-model-info">
                      <span className="settings-model-name">
                        {model.label.split(" \u2014 ")[0]}
                        {model.label.includes(" \u2014 ") && (
                          <em>{" \u2014 "}{model.label.split(" \u2014 ").slice(1).join(" \u2014 ")}</em>
                        )}
                      </span>
                      <small>
                        {downloaded ? "On this computer" : `${model.size} download`}
                        {isActive ? (downloaded ? " · in use" : " · will be used once downloaded") : ""}
                      </small>
                      {running && status && (
                        <>
                          <small>
                            {status.total_bytes > 0
                              ? `${formatGb(status.downloaded_bytes)} of ${formatGb(status.total_bytes)}`
                              : "Preparing…"}
                          </small>
                          {status.total_bytes > 0 ? (
                            <progress
                              value={status.downloaded_bytes}
                              max={status.total_bytes}
                            />
                          ) : (
                            <progress />
                          )}
                        </>
                      )}
                      {status?.state === "error" && <small>{status.detail}</small>}
                      {downloaded && redownloadArmed === id && (
                        <small>
                          Click again to delete and re-download — use when the model seems corrupt
                        </small>
                      )}
                    </div>
                    <div className="settings-model-action">
                      {running && status ? (
                        <span className="settings-model-dl">
                          {percent === null ? "Downloading…" : `Downloading ${percent}%`}
                        </span>
                      ) : !downloaded ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => downloadWhisper(model.key)}
                          disabled={health.healthStatus === "unreachable"}
                          title={health.healthStatus === "unreachable" ? "Local AI offline — restart it first" : undefined}
                        >
                          {status?.state === "error" ? "Retry" : "Download"}
                        </button>
                      ) : (
                        <>
                          {isActive ? (
                            <span className="settings-model-inuse">In use</span>
                          ) : (
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => activateWhisperModel(model.key)}
                            >
                              Use this one
                            </button>
                          )}
                          {" "}
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => redownloadWhisper(model.key)}
                            disabled={health.healthStatus === "unreachable"}
                            title={
                              health.healthStatus === "unreachable"
                                ? "Local AI offline — restart it first"
                                : "Delete the cached model and download it again"
                            }
                          >
                            {redownloadArmed === id ? "Confirm re-download" : "Re-download"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {health.healthStatus === "unreachable" && (
            <p className="settings-help">
              The local AI service isn&apos;t running — downloads need it. Start Adversaria&apos;s
              service (it launches with the app) or restart the app.
            </p>
          )}
          {whisperMsg && <p className="settings-msg err">{whisperMsg}</p>}
          <p className="settings-help">
            Recordings made before a model is here aren't lost — they transcribe
            themselves as soon as one lands.
          </p>
        </div>
      )}
    </div>
  );
}
