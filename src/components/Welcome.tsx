import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import type {
  AppConfig,
  ModelDownloadStatus,
  OnboardingState,
  RegistrationState,
  SetupStatus,
} from "../types";
import {
  completeOnboardingStep,
  getConfig,
  getModelDownloadStatus,
  getOnboardingState,
  getRegistrationState,
  getSetupStatus,
  retryRegistration,
  startModelDownload,
  submitRegistration,
  updateConfig,
  checkCapturePermissions,
  requestMicrophonePermission,
  requestScreenPermission,
  openPrivacySettings,
  relaunchForPermissions,
} from "../lib/tauri";
import type { CapturePermissions } from "../lib/tauri";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ENGINE_WHISPER_IDS = ["whisper-live", "whisper-main"] as const;
const STEP_ORDER = ["registration", "permissions", "ready"] as const;
type SetupStep = (typeof STEP_ORDER)[number];

function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function emptyRegistration(): RegistrationState {
  return {
    schema_version: 1,
    status: "unregistered",
    name: "",
    email: "",
    consent_version: "",
    consent_timestamp: null,
    source: "desktop-beta",
    app_version: "",
    platform: "",
    attempt_count: 0,
    next_retry_at: null,
    last_error: null,
  };
}

/** Which of the 3 screens a (possibly legacy 7-step) onboarding row lands on.
 *
 * Read-side mapping, never a data migration: old rows keep their old step
 * names, and whatever they completed carries over. Someone who finished
 * registration + disclosure + hardware on the 7-step wizard resumes at
 * Permissions; someone past permissions resumes at Ready. Windows has no
 * TCC-style capture prompts, so the permissions screen never renders there. */
export function resolveScreen(completedSteps: string[], platform: string): SetupStep {
  if (!completedSteps.includes("registration")) return "registration";
  if (platform === "macos" && !completedSteps.includes("permissions")) return "permissions";
  return "ready";
}

/** Restart-safe first-run setup, three minimal screens (SPEC v2 addendum).
 *
 * NOTHING model-related happens here: no LLM ever downloads during setup, no
 * model is picked — the one-time guided tour lands the user on Settings › AI
 * Model afterwards, where installed models are listed and downloads start
 * only on an explicit click. The single exception is Whisper: transcription
 * is always on-device with no API substitute, so its weights quietly cache in
 * the background — skipped entirely when already on this machine — and that
 * is disclosed on the final screen. */
export function Welcome() {
  const [registration, setRegistration] = useState<RegistrationState>(emptyRegistration);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [perms, setPerms] = useState<CapturePermissions | null>(null);
  const [permBusy, setPermBusy] = useState<"" | "microphone" | "screen">("");
  const [loadingError, setLoadingError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  // Asked once, here, because nobody discovers a notification toggle inside
  // Settings. Defaults on; persisted only when setup finishes.
  const [notifyBeforeMeetings, setNotifyBeforeMeetings] = useState(true);
  const [whisperDownloads, setWhisperDownloads] = useState<Record<string, ModelDownloadStatus>>({});

  useEffect(() => {
    Promise.all([
      getRegistrationState(),
      getOnboardingState(),
      getSetupStatus(),
      getConfig(),
    ])
      .then(([nextRegistration, nextOnboarding, nextSetup, nextConfig]) => {
        setRegistration(nextRegistration);
        // The backend also migrates this legacy flag into the versioned row,
        // but a very fast webview can read both while startup migration is
        // still committing. The legacy completion flag remains authoritative
        // for existing users, so never strand them in first-run setup for the
        // lifetime of this frontend session.
        setOnboarding(
          nextConfig.beta_onboarded && !nextOnboarding.setup_complete
            ? { ...nextOnboarding, setup_complete: true }
            : nextOnboarding,
        );
        setSetup(nextSetup);
        setConfig(nextConfig);
        setName(nextRegistration.name || nextConfig.user_name || "");
        setEmail(nextRegistration.email || nextConfig.user_email || "");
      })
      .catch(() => {
        setLoadingError("Setup state could not be loaded. Restart Adversaria and try again.");
      });
  }, []);

  // Whisper is the ONLY thing that may download during setup (SPEC v2): it is
  // needed for every provider, transcription is always on-device, and a cached
  // copy makes this a no-op. Start it early so it overlaps the wizard screens;
  // failures are silent here (the service may still be booting) and surface
  // on the final screen's status line instead.
  useEffect(() => {
    if (!onboarding || onboarding.setup_complete) return;
    ENGINE_WHISPER_IDS.forEach((id) => {
      startModelDownload(id).catch(() => {});
    });
  }, [onboarding?.setup_complete]);

  const step = useMemo<SetupStep | null>(() => {
    if (!onboarding || onboarding.setup_complete || !setup) return null;
    return resolveScreen(onboarding.completed_steps, setup.platform);
  }, [onboarding, setup]);

  // Whisper caching status for the final screen's disclosure line.
  useEffect(() => {
    if (step !== "ready") return;
    const poll = () => {
      ENGINE_WHISPER_IDS.forEach((id) => {
        getModelDownloadStatus(id)
          .then((status) => {
            setWhisperDownloads((current) => ({ ...current, [id]: status }));
          })
          .catch(() => {});
      });
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  // Live permission state for the permissions step. Re-checked on focus because
  // a user who grants in System Settings and tabs back gets no callback.
  useEffect(() => {
    if (step !== "permissions") return;
    let alive = true;
    const refresh = () => {
      checkCapturePermissions()
        .then((p) => { if (alive) setPerms(p); })
        .catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 2000);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [step]);

  if (loadingError) {
    return (
      <div className="welcome-overlay">
        <div className="welcome-card" role="alert">
          <h2 className="welcome-title">Setup needs attention</h2>
          <p className="welcome-error">{loadingError}</p>
        </div>
      </div>
    );
  }

  if (!onboarding || !setup || !config || onboarding.setup_complete) return null;

  const grantMicrophone = async () => {
    setPermBusy("microphone");
    try {
      const state = await requestMicrophonePermission();
      // Already-denied can't re-prompt; System Settings is the only way back.
      if (state === "denied") await openPrivacySettings("microphone");
      setPerms(await checkCapturePermissions());
    } catch (error) {
      setMessage(String(error));
    } finally {
      setPermBusy("");
    }
  };

  const grantScreen = async () => {
    setPermBusy("screen");
    try {
      const state = await requestScreenPermission();
      // macOS shows this prompt once per install; after that only Settings works.
      if (state !== "granted") await openPrivacySettings("screen");
      setPerms(await checkCapturePermissions());
    } catch (error) {
      setMessage(String(error));
    } finally {
      setPermBusy("");
    }
  };

  const finishStep = async (
    completedStep: string,
    profileId: string | null = null,
    setupComplete = false,
  ) => {
    const next = await completeOnboardingStep(completedStep, profileId, setupComplete);
    setOnboarding(next);
    return next;
  };

  const submitIdentity = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !EMAIL_RE.test(email.trim()) || !consent || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await submitRegistration(name.trim(), email.trim(), consent);
      setRegistration(next);
      setOnboarding(await getOnboardingState());
      if (next.status === "pending") {
        setMessage("Registration is safely queued. Local setup can continue offline.");
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const retryPendingRegistration = async () => {
    setBusy(true);
    try {
      const next = await retryRegistration();
      setRegistration(next);
      setMessage(
        next.status === "submitted"
          ? "Registration submitted."
          : "Registration remains queued and will retry automatically.",
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  // Setup ends with NO model chosen and NO engine configured — that is a legal
  // state (SPEC v2). The guided tour takes over from here and ends on
  // Settings › AI Model, where the actual choice (download vs API) happens.
  const finishSetup = async () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (config.meeting_reminder_enabled !== notifyBeforeMeetings) {
        const nextConfig = { ...config, meeting_reminder_enabled: notifyBeforeMeetings };
        await updateConfig(nextConfig);
        setConfig(nextConfig);
      }
      await finishStep("ready", null, true);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  // `setup.platform` is std::env::consts::OS. The wizard used to hardcode "Mac"
  // in its user-facing copy, which read as a porting bug on Windows ("On this
  // Mac", "Your Mac has 64 GB of memory").
  const deviceLabel = setup.platform === "macos" ? "Mac" : "PC";

  // Windows has no capture-permission prompts, so its wizard is two screens.
  const visibleSteps = STEP_ORDER.filter(
    (value) => value !== "permissions" || setup.platform === "macos",
  );
  const progressIndex = Math.max(0, visibleSteps.indexOf(step ?? "ready"));
  const pendingRegistration = registration.status === "pending";

  const whisperStatuses = ENGINE_WHISPER_IDS
    .map((id) => whisperDownloads[id])
    .filter((status): status is ModelDownloadStatus => Boolean(status));
  const whisperTotal = whisperStatuses.reduce((sum, status) => sum + status.total_bytes, 0);
  const whisperDone = whisperStatuses.reduce(
    (sum, status) => sum + Math.min(status.downloaded_bytes, status.total_bytes),
    0,
  );
  const whisperFailed = whisperStatuses.find((status) => status.state === "error");
  const whisperReady =
    whisperStatuses.length === ENGINE_WHISPER_IDS.length &&
    whisperStatuses.every((status) => status.state === "ready");

  const retryWhisper = () => {
    ENGINE_WHISPER_IDS.forEach((id) => {
      if (whisperDownloads[id]?.state === "error") {
        startModelDownload(id).catch(() => {});
      }
    });
  };

  return (
    <div className="welcome-overlay">
      <main className="welcome-card welcome-card-wide" aria-labelledby="setup-title">
        <div className="welcome-progress" aria-label={`Setup step ${progressIndex + 1} of ${visibleSteps.length}`}>
          <span>Setup</span>
          <span>{progressIndex + 1} / {visibleSteps.length}</span>
        </div>
        <div className="welcome-progress-track" aria-hidden="true">
          <span style={{ width: `${((progressIndex + 1) / visibleSteps.length) * 100}%` }} />
        </div>

        {pendingRegistration && step !== "registration" && (
          <div className="welcome-notice" role="status">
            <div>
              <strong>Registration queued</strong>
              <p>Your details are stored locally and will retry when the service is reachable.</p>
            </div>
            <button className="btn-secondary" onClick={retryPendingRegistration} disabled={busy}>
              Retry now
            </button>
          </div>
        )}

        {step === "registration" && (
          <form onSubmit={submitIdentity}>
            <h2 className="welcome-title" id="setup-title">Welcome to Adversaria</h2>
            <p className="welcome-sub">
              Everything runs on this {deviceLabel} — nothing is uploaded. Meeting
              audio, transcripts, and notes never leave your machine.
            </p>
            <label className="settings-label" htmlFor="welcome-name">Name</label>
            <input
              id="welcome-name"
              className="settings-input-text"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="welcome-field-hint">
              Used as your speaker label in transcripts and notes — change it any
              time in Settings.
            </p>
            <label className="settings-label welcome-field-label" htmlFor="welcome-email">Email</label>
            <input
              id="welcome-email"
              className="settings-input-text"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <label className="welcome-check">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span>
                I agree to send my name, email, app version, platform, and consent time for beta registration.
                No meeting content or hardware details are included.
              </span>
            </label>
            <div className="welcome-actions">
              <button className="btn-primary" type="submit" disabled={busy || !name.trim() || !EMAIL_RE.test(email.trim()) || !consent}>
                {busy ? "Registering…" : "Register and continue"}
              </button>
            </div>
          </form>
        )}

        {step === "permissions" && (
          <section>
            <h2 className="welcome-title" id="setup-title">Recording permissions</h2>
            <p className="welcome-sub">
              Grant these now so your first recording just works. macOS would
              otherwise interrupt you mid-meeting.
            </p>
            <ul className="welcome-permissions perm-live">
              <li>
                <span className={`perm-dot perm-${perms?.screen_recording ?? "undetermined"}`} />
                <div className="perm-copy">
                  <strong>System audio</strong>
                  <span>Records the other people on the call. Without it a meeting captures only you.</span>
                </div>
                {perms?.screen_recording === "granted" ? (
                  <span className="perm-ok">Granted</span>
                ) : (
                  <button className="btn-secondary" disabled={permBusy !== ""} onClick={grantScreen}>
                    {permBusy === "screen" ? "Waiting…" : "Grant"}
                  </button>
                )}
              </li>
              <li>
                <span className={`perm-dot perm-${perms?.microphone ?? "undetermined"}`} />
                <div className="perm-copy">
                  <strong>Microphone</strong>
                  <span>Records your own voice, so notes can tell you and them apart.</span>
                </div>
                {perms?.microphone === "granted" ? (
                  <span className="perm-ok">Granted</span>
                ) : (
                  <button className="btn-secondary" disabled={permBusy !== ""} onClick={grantMicrophone}>
                    {permBusy === "microphone" ? "Waiting…" : "Grant"}
                  </button>
                )}
              </li>
            </ul>

            {perms?.needs_relaunch && (
              <div className="perm-relaunch">
                <p>
                  <strong>Almost there.</strong> macOS only applies Screen Recording after
                  Adversaria restarts. Everything you've set up so far is saved.
                </p>
                <button className="btn-primary" onClick={() => relaunchForPermissions().catch((error) => setMessage(String(error)))}>
                  Relaunch Adversaria
                </button>
              </div>
            )}

            <p className="welcome-footnote">
              Denying doesn't delete anything — you can grant later in System Settings.
              Adversaria never records unless you press Record.
            </p>
            <div className="welcome-actions">
              <button className="btn-primary" onClick={() => finishStep("permissions").catch((error) => setMessage(String(error)))}>
                {perms?.screen_recording === "granted" ? "Continue" : "Continue anyway"}
              </button>
            </div>
          </section>
        )}

        {step === "ready" && (
          <section>
            <h2 className="welcome-title" id="setup-title">You're all set</h2>
            <p className="welcome-sub">
              Adversaria records and transcribes on this {deviceLabel} out of the
              box. A short tour inside the app shows you around — including how
              your meeting notes get written.
            </p>

            <div className="welcome-download downloading" role="status">
              <div>
                <strong>
                  {whisperFailed
                    ? whisperFailed.detail
                    : whisperReady
                      ? "Transcription is ready on this machine."
                      : "Caching the transcription engine in the background…"}
                </strong>
                <span>
                  {whisperReady
                    ? "Nothing else downloads without your say-so."
                    : whisperTotal > 0
                      ? `${formatGb(whisperDone)} / ${formatGb(whisperTotal)} — skipped when already on this machine`
                      : "Checking what's already on this machine…"}
                </span>
              </div>
              {!whisperReady && (whisperTotal > 0 ? (
                <progress value={whisperDone} max={whisperTotal} />
              ) : (
                <progress />
              ))}
            </div>
            {whisperFailed && (
              <div className="welcome-actions">
                <button className="btn-secondary" onClick={retryWhisper} disabled={busy}>
                  Retry
                </button>
              </div>
            )}

            <label className="welcome-check">
              <input
                type="checkbox"
                checked={notifyBeforeMeetings}
                onChange={(event) => setNotifyBeforeMeetings(event.target.checked)}
              />
              <span>
                Notify me {config.meeting_reminder_minutes || 5} minutes before my
                meetings start. Needs a connected calendar — add one any time in
                Settings.
              </span>
            </label>

            <div className="welcome-actions">
              <button className="btn-primary" onClick={finishSetup} disabled={busy}>
                {busy ? "Finishing…" : "Start using Adversaria"}
              </button>
            </div>
            <p className="welcome-footnote">
              Anything still caching keeps going inside Adversaria — you don't
              have to wait for it.
            </p>
          </section>
        )}

        {message && <p className={message.includes("success") || message.includes("queued") ? "welcome-success" : "welcome-message"} role="status">{message}</p>}
      </main>
    </div>
  );
}
