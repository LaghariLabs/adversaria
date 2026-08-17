import { useEffect, useState } from "react";

import type { AppConfig, RegistrationState, SetupStatus, WhisperModelInfo } from "../../types";
import type { ServiceHealth } from "../../hooks/useServiceHealth";
import {
  checkCapturePermissions,
  openPrivacySettings,
  probeSystemAudio,
  requestMicrophonePermission,
} from "../../lib/tauri";
import type { CapturePermissions, PermissionState } from "../../lib/tauri";

/** One row of the Record → Transcribe → Notes ledger. */
interface Stage {
  step: string;
  name: string;
  /** What is active right now, in the user's words. */
  value: string;
  /** Where that work happens — the privacy-relevant half. */
  where: string;
  /** "unknown" renders grey: not yet answered is not the same as not well. */
  tone: "ok" | "warn" | "bad" | "unknown";
  state: string;
  /** Section to open when the stage is selected. */
  jump: SectionId;
}

/** Something blocking the pipeline, with the one action that clears it. */
interface Issue {
  tone: "warn" | "bad";
  title: string;
  detail: string;
  action: string;
  jump: SectionId;
  primary: boolean;
}

type SectionId = "transcription" | "notes" | "recording";

interface SetupStatusSectionProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  health: ServiceHealth;
  setup: SetupStatus | null;
  whisperModels: WhisperModelInfo[];
  appVersion: string;
  registration: RegistrationState | null;
  registrationRetrying: boolean;
  onRegistrationRetry: () => void;
  onOpen: (section: SectionId) => void;
}

/** True when transcription is handled somewhere other than this machine. */
function usesRemoteTranscription(config: AppConfig): boolean {
  return config.transcription_provider !== "local" && Boolean(config.transcription_base_url?.trim());
}

function permissionChip(state: PermissionState | undefined): {
  label: string;
  tone: "ok" | "warn" | "unknown";
} {
  if (state === "granted") return { label: "Granted", tone: "ok" };
  if (state === "denied") return { label: "Not granted", tone: "warn" };
  return { label: "Not checked yet", tone: "unknown" };
}

/**
 * Setup status — the readiness ledger.
 *
 * Settings opens on the question people actually arrive with: can a meeting be
 * recorded, transcribed and written up, and where does each step happen. The
 * three stages name what is active rather than which config key is set, and a
 * blocked stage offers the one action that clears it.
 */
export function SetupStatusSection({
  active,
  config,
  update,
  health,
  setup,
  whisperModels,
  appVersion,
  registration,
  registrationRetrying,
  onRegistrationRetry,
  onOpen,
}: SetupStatusSectionProps) {
  const [permissions, setPermissions] = useState<CapturePermissions | null>(null);
  const [permissionBusy, setPermissionBusy] = useState<"" | "microphone" | "system_audio">("");
  const [permissionError, setPermissionError] = useState("");

  useEffect(() => {
    let alive = true;
    checkCapturePermissions()
      .then((result) => {
        if (alive && result) setPermissions(result);
      })
      .catch((error) => {
        if (alive) setPermissionError(`Couldn't load recording permissions: ${String(error)}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  const requestMicrophone = async () => {
    setPermissionBusy("microphone");
    setPermissionError("");
    try {
      await requestMicrophonePermission();
      setPermissions(await checkCapturePermissions());
    } catch (error) {
      setPermissionError(String(error));
    } finally {
      setPermissionBusy("");
    }
  };

  const checkSystemAudio = async () => {
    setPermissionBusy("system_audio");
    setPermissionError("");
    try {
      setPermissions(await probeSystemAudio());
    } catch (error) {
      setPermissionError(String(error));
    } finally {
      setPermissionBusy("");
    }
  };

  const openPermissionSettings = async (which: "microphone" | "system_audio") => {
    setPermissionError("");
    try {
      await openPrivacySettings(which);
    } catch (error) {
      setPermissionError(String(error));
    }
  };

  const remote = usesRemoteTranscription(config);
  const serviceDown = health.healthStatus === "unreachable";
  const issues: Issue[] = [];

  // --- Record. Capture is local and always available; the recording only fails
  // later, at transcription, which is where we report it.
  const record: Stage = {
    step: "Step 1 · Record",
    name: "Record",
    value: "Microphone + system audio",
    where: "Captured on this computer",
    tone: "ok",
    state: "Ready",
    jump: "recording",
  };

  // --- Transcribe.
  let transcribe: Stage;
  if (remote) {
    // A configured remote engine makes the local model cache irrelevant: the
    // recording path never reads those weights. Reporting local model trouble
    // here is what made a working self-hosted setup look broken (0.3.73).
    const host = config.transcription_base_url?.trim() ?? "";
    transcribe = {
      step: "Step 2 · Transcribe",
      name: "Transcribe",
      value: config.transcription_model?.trim() || "Your transcription service",
      where:
        config.transcription_provider === "self_hosted"
          ? `Your server · ${host.replace(/^https?:\/\//, "").split("/")[0]}`
          : "A cloud provider",
      tone: "ok",
      state: "Ready",
      jump: "transcription",
    };
  } else if (serviceDown) {
    transcribe = {
      step: "Step 2 · Transcribe",
      name: "Transcribe",
      value: "Local AI cannot start",
      where: "Your recordings are safe on this computer",
      tone: "bad",
      state: "Blocked",
      jump: "transcription",
    };
    issues.push({
      tone: "bad",
      title: "The local AI service isn't running",
      detail:
        "Security software may be blocking it. Nothing is lost — finished recordings wait on this computer until it is back.",
      action: "Repair",
      jump: "transcription",
      primary: true,
    });
  } else {
    const downloaded = whisperModels.some((m) => m.downloaded);
    const state = health.health?.transcriber_state;
    if (state === "ready") {
      const inUse = whisperModels.find((m) => m.key === config.whisper_model);
      transcribe = {
        step: "Step 2 · Transcribe",
        name: "Transcribe",
        value: inUse?.label || config.whisper_model || "On-device model",
        where: "Runs on this computer",
        tone: "ok",
        state: "Ready",
        jump: "transcription",
      };
    } else if (state === "loading") {
      transcribe = {
        step: "Step 2 · Transcribe",
        name: "Transcribe",
        value: "Starting up",
        where: "Runs on this computer",
        tone: "warn",
        state: "Starting",
        jump: "transcription",
      };
    } else if (state === undefined) {
      // Not an answer yet — the first /health has not landed, or this service
      // predates V3 and reports no transcriber state at all. Reporting an unknown
      // as a problem is what told a user with large-v3 sitting on disk that
      // transcription "needs attention" (2026-08-07). Say what is true: we do not
      // know yet, and raise nothing.
      transcribe = {
        step: "Step 2 · Transcribe",
        name: "Transcribe",
        value: "Checking…",
        where: "Runs on this computer",
        tone: "unknown",
        state: "Checking",
        jump: "transcription",
      };
    } else {
      // state is "error" or "missing": a real answer, and a real problem.
      const detail = health.health?.transcriber_detail?.trim();
      transcribe = {
        step: "Step 2 · Transcribe",
        name: "Transcribe",
        value:
          state === "missing"
            ? "No model downloaded yet"
            : "The model on this computer wouldn't load",
        where: "Recordings are kept until this is ready",
        tone: "warn",
        state: state === "missing" ? "Not set up" : "Not ready",
        jump: "transcription",
      };
      issues.push({
        tone: "warn",
        title:
          state === "missing"
            ? "Choose how audio becomes text"
            : "The transcription model wouldn't load",
        // The service always sends a reason for an error; prefer it over our
        // guess, and never let a downloaded model be described as missing.
        detail:
          detail ||
          (state === "missing"
            ? "Download a model to transcribe on this computer, or point Adversaria at a service you run."
            : downloaded
              ? "A model is downloaded but could not be loaded. On Windows this is usually a missing system runtime library — the service log says which."
              : "Download a model, or point Adversaria at a transcription service you run."),
        action: state === "missing" ? "Choose" : "Open",
        jump: "transcription",
        primary: true,
      });
    }
  }

  // --- Notes.
  const notesRemote = config.llm_provider !== "local";
  const notesModel = config.ollama_model?.trim();
  const notes: Stage = notesRemote
    ? {
        step: "Step 3 · Notes",
        name: "Notes",
        value: notesModel || "Your notes service",
        where: "A service you chose — transcript only, never the recording",
        tone: "ok",
        state: "Ready",
        jump: "notes",
      }
    : {
        step: "Step 3 · Notes",
        name: "Notes",
        value: notesModel || "No model chosen",
        where: notesModel ? "Runs on this computer" : "Transcripts save without a summary",
        tone: notesModel ? "ok" : "warn",
        state: notesModel ? "Ready" : "Not set up",
        jump: "notes",
      };
  if (!notesRemote && !notesModel) {
    issues.push({
      tone: "warn",
      title: "Choose how notes are written",
      detail: "Transcripts are still saved without this — you just won't get a summary.",
      action: "Choose",
      jump: "notes",
      primary: issues.length === 0,
    });
  }

  const stages = [record, transcribe, notes];
  // "unknown" is deliberately not counted: a pipeline still being probed is not a
  // pipeline in trouble, and an amber badge during a normal startup trains people
  // to ignore amber.
  const worst = stages.some((s) => s.tone === "bad")
    ? "bad"
    : stages.some((s) => s.tone === "warn")
      ? "warn"
      : "ok";

  // The privacy route, stated as one sentence. This is the product's whole
  // promise, so it is derived from where the work actually happens — never from
  // the label the user picked.
  const route = remote
    ? config.transcription_provider === "self_hosted"
      ? "Audio goes to a server you control · notes stay on this computer"
      : "Audio leaves this device for transcription · notes stay on this computer"
    : "Audio and transcript never leave this computer";
  const microphonePermission = permissionChip(permissions?.microphone);
  const systemAudioPermission = permissionChip(permissions?.system_audio);

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Setup status</h3>
      <p className="settings-card-desc">
        Whether a meeting can be recorded, transcribed and turned into notes — and where
        each step happens. Select a step to change or repair it.
      </p>

      <div className="settings-ledger" aria-label="Meeting pipeline">
        {stages.map((stage) => (
          <button
            key={stage.name}
            type="button"
            className="settings-stage"
            data-tone={stage.tone}
            onClick={() => onOpen(stage.jump)}
            aria-label={`${stage.name}: ${stage.state}. ${stage.value}`}
          >
            <span className="settings-stage-top">
              <span className="settings-stage-step">{stage.step}</span>
              <span className="settings-chip" data-tone={stage.tone}>
                <span className="settings-dot" />
                {stage.state}
              </span>
            </span>
            <span className="settings-stage-value">{stage.value}</span>
            <span className="settings-stage-where">{stage.where}</span>
          </button>
        ))}
      </div>

      <div className="settings-route">
        <span className="settings-route-label">Where your data goes</span>
        <span className="settings-route-line" aria-hidden="true" />
        <span>{route}</span>
      </div>

      <h3 className="settings-card-title" style={{ marginTop: 22 }}>
        Permissions
      </h3>
      <p className="settings-card-desc">
        Confirm that both sides of a meeting can reach the recorder.
      </p>
      <div className="settings-subcard" aria-label="Capture permissions">
        <div className="settings-row" style={{ justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>Microphone</strong>
            <p className="settings-help" style={{ margin: "2px 0 0" }}>
              Your side of the meeting (&quot;Me&quot;)
            </p>
          </div>
          <span
            className="settings-chip"
            data-tone={microphonePermission.tone}
            aria-label={`Microphone permission: ${microphonePermission.label}`}
          >
            <span className="settings-dot" />
            {microphonePermission.label}
          </span>
          <div className="settings-row">
            {permissions?.microphone === "undetermined" || permissions == null ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={permissionBusy !== ""}
                onClick={() => void requestMicrophone()}
              >
                {permissionBusy === "microphone" ? "Requesting…" : "Request"}
              </button>
            ) : permissions.microphone === "denied" ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={permissionBusy !== ""}
                onClick={() => void openPermissionSettings("microphone")}
              >
                Open System Settings
              </button>
            ) : null}
          </div>
        </div>
        <div
          className="settings-row"
          style={{
            justifyContent: "space-between",
            borderTop: "1px solid var(--border-color)",
            marginTop: 14,
            paddingTop: 14,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>System audio</strong>
            <p className="settings-help" style={{ margin: "2px 0 0" }}>
              What your Mac plays (&quot;Them&quot;)
            </p>
          </div>
          <span
            className="settings-chip"
            data-tone={systemAudioPermission.tone}
            aria-label={`System audio permission: ${systemAudioPermission.label}`}
          >
            <span className="settings-dot" />
            {systemAudioPermission.label}
          </span>
          <div className="settings-row">
            <button
              type="button"
              className="btn-secondary"
              disabled={permissionBusy !== ""}
              onClick={() => void checkSystemAudio()}
            >
              {permissionBusy === "system_audio" ? "Checking…" : "Check"}
            </button>
            {permissions?.system_audio === "denied" && (
              <button
                type="button"
                className="btn-secondary"
                disabled={permissionBusy !== ""}
                onClick={() => void openPermissionSettings("system_audio")}
              >
                Open System Settings
              </button>
            )}
          </div>
        </div>
        {permissionError && (
          <p className="settings-msg err" role="alert">
            {permissionError}
          </p>
        )}
      </div>

      <h3 className="settings-card-title" style={{ marginTop: 22 }}>
        Needs attention
      </h3>
      {issues.length === 0 ? (
        <p className="settings-empty">
          {worst === "ok"
            ? "Nothing is blocking your next meeting."
            : "No action needed right now."}
        </p>
      ) : (
        <div>
          {issues.map((issue) => (
            <div className="settings-issue" data-tone={issue.tone} key={issue.title}>
              <span className="settings-issue-stripe" />
              <span>
                <strong>{issue.title}</strong>
                <span>{issue.detail}</span>
              </span>
              <button
                type="button"
                className={issue.primary ? "btn-primary" : "btn-secondary"}
                onClick={() => onOpen(issue.jump)}
              >
                {issue.action}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Registration retry. Only when a retry is actually scheduled:
          endpoint-less builds (every dev build) queue silently, and retrying
          there can never work. */}
      {registration?.status === "pending" && registration.next_retry_at != null && (
        <>
          <h3 className="settings-card-title" style={{ marginTop: 22 }}>
            Registration
          </h3>
          <div className="settings-row">
            <div>
              <strong>Registration queued</strong>
              <p className="settings-help">It will retry automatically when you're online.</p>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={onRegistrationRetry}
              disabled={registrationRetrying}
            >
              {registrationRetrying ? "Retrying…" : "Retry now"}
            </button>
          </div>
        </>
      )}

      <h3 className="settings-card-title" style={{ marginTop: 22 }}>
        The local AI service
      </h3>
      <p className="settings-card-desc">
        Adversaria runs this in the background to transcribe and write notes.
      </p>
      <div className="settings-form-group">
        <span className="settings-label">Service status</span>
        {health.healthStatus === "checking" ? (
          <p className="settings-msg">Checking…</p>
        ) : health.healthStatus === "ok" ? (
          <p className="settings-msg ok">● On-device services are running</p>
        ) : health.healthStatus === "degraded" ? (
          <p className="settings-msg warn">
            ● Service reachable, but the model server is not available
          </p>
        ) : (
          <p className="settings-msg err">● The on-device service is not reachable</p>
        )}
        {/* Only when there is something to recover. Rendering it always — even
            disabled — put a dead grey button directly under a green "services are
            running" line, which reads as a broken control rather than an
            unnecessary one. */}
        {serviceDown && (
          <button
            type="button"
            className="btn-primary"
            style={{ marginTop: 10, alignSelf: "flex-start" }}
            onClick={() => void health.restartService()}
            disabled={health.serviceRestarting}
          >
            {health.serviceRestarting ? "Restarting…" : "Restart Local AI"}
          </button>
        )}
        {health.serviceRestartMessage && (
          <p className="settings-help" role="status">
            {health.serviceRestartMessage}
          </p>
        )}
      </div>

      <details className="settings-advanced">
        <summary>Advanced — connection details</summary>
        <div className="settings-form-group" style={{ marginTop: 12 }}>
          <label className="settings-label" htmlFor="settings-service-url">
            On-device service address
          </label>
          <input
            id="settings-service-url"
            type="text"
            value={config.python_service_url}
            onChange={(e) => update({ python_service_url: e.target.value })}
            className="settings-input-text"
          />
          {/* Both caveats are real and neither was stated before. Users trust a
              "Setup status" screen, so an address that is neither live nor
              immediately applied has to say so. */}
          <p className="settings-help">
            Most people never change this. Adversaria normally starts the service itself
            on a private address that changes each launch, so the value here may not be
            the one in use. A change takes effect after you restart Adversaria.
          </p>
        </div>
      </details>

      {appVersion && (
        <p className="settings-note" style={{ marginTop: 18 }}>
          Adversaria v{appVersion}
        </p>
      )}
      {setup?.gpu_name && <p className="settings-note">Graphics: {setup.gpu_name}</p>}
    </div>
  );
}
