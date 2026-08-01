import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import type {
  AppConfig,
  OnboardingState,
  RegistrationState,
  SetupStatus,
} from "../types";
import {
  checkServiceHealth,
  completeOnboardingStep,
  getConfig,
  getOnboardingState,
  getRegistrationState,
  getSetupStatus,
  listWhisperModels,
  retryRegistration,
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
const STEP_ORDER = ["registration", "permissions", "ready"] as const;
type SetupStep = (typeof STEP_ORDER)[number];

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

interface WelcomeProps {
  /** Finish setup and land on Settings › AI Model (the model manager). */
  onOpenModelSettings?: () => void;
}

/** Restart-safe first-run setup, three minimal screens (SPEC V3 addendum).
 *
 * NOTHING downloads here — not the notes model, and (since V3) not the
 * transcription model either. The wizard READS what is already on the machine
 * and says so: transcription ready, or a card that names what is missing, how
 * big it is, and offers the one click that goes and gets it. Everything else
 * is deferred to the guided tour, which ends on Settings › AI Model. */
export function Welcome({ onOpenModelSettings }: WelcomeProps) {
  const [registration, setRegistration] = useState<RegistrationState>(emptyRegistration);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [perms, setPerms] = useState<CapturePermissions | null>(null);
  const [permBusy, setPermBusy] = useState<"" | "microphone" | "screen">("");
  const [loadingError, setLoadingError] = useState("");
  // Bumped by the error screen's Retry button to restart the load attempts.
  const [loadNonce, setLoadNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  // Asked once, here, because nobody discovers a notification toggle inside
  // Settings. Defaults on; persisted only when setup finishes.
  const [notifyBeforeMeetings, setNotifyBeforeMeetings] = useState(true);
  // What the Ready screen found on this machine: null until the one-shot probe
  // settles, then true/false. Nothing here starts a download.
  const [transcriptionReady, setTranscriptionReady] = useState<boolean | null>(null);
  // e.g. "1.6 GB" — this machine's default model, read from the catalogue.
  const [modelSizeHint, setModelSizeHint] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let attempts = 0;
    let timer: number | undefined;
    const load = () => {
      Promise.all([
        getRegistrationState(),
        getOnboardingState(),
        getSetupStatus(),
        getConfig(),
      ])
        .then(([nextRegistration, nextOnboarding, nextSetup, nextConfig]) => {
          if (!alive) return;
          setLoadingError("");
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
          if (!alive) return;
          // The very first launch is the slowest backend start there is —
          // schema creation, migrations, the demo seed — and the webview can
          // mount before it finishes. That is a wait, not a failure: keep
          // retrying quietly before showing anything scary.
          attempts += 1;
          if (attempts < 10) {
            timer = window.setTimeout(load, 1000);
          } else {
            setLoadingError(
              "Setup state could not be loaded. Restart Adversaria and try again.",
            );
          }
        });
    };
    load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [loadNonce]);

  const step = useMemo<SetupStep | null>(() => {
    if (!onboarding || onboarding.setup_complete || !setup) return null;
    return resolveScreen(onboarding.completed_steps, setup.platform);
  }, [onboarding, setup]);

  // One read of reality for the final screen — no polling, no fetching. The
  // service is authoritative when it answers; the model list is the fallback
  // for a service that hasn't reported a state yet. Neither answering means
  // nothing is cached, which on a fresh install is exactly the truth.
  useEffect(() => {
    if (step !== "ready") return;
    let alive = true;
    Promise.allSettled([checkServiceHealth(), listWhisperModels()]).then(
      ([health, models]) => {
        if (!alive) return;
        const state =
          health.status === "fulfilled" ? health.value.transcriber_state : undefined;
        const anyDownloaded =
          models.status === "fulfilled" && models.value.some((model) => model.downloaded);
        setTranscriptionReady(state === "ready" || anyDownloaded);
        // The size the guide card promises must be the size of THIS machine's
        // default model (~3 GB large-v3 on Apple Silicon, ~1.6 GB turbo on
        // Windows) — a hardcoded number lied on one platform or the other.
        if (models.status === "fulfilled" && models.value.length > 0) {
          const entry =
            models.value.find((model) => model.key === config?.whisper_model) ??
            models.value[0];
          setModelSizeHint(entry.size.replace("~", "").trim() || null);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [step, config?.whisper_model]);

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
          <button
            className="btn-primary"
            onClick={() => {
              setLoadingError("");
              setLoadNonce((n) => n + 1);
            }}
          >
            Try again
          </button>
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
  const finishSetup = async (thenOpenModelSettings = false) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (config.meeting_reminder_enabled !== notifyBeforeMeetings) {
        // Fresh read-modify-write: the mount-time `config` snapshot predates
        // the registration step, which persisted user_name/user_email into
        // config — writing the stale copy here silently erased the name the
        // user just typed (it never appeared in Settings › General).
        const fresh = await getConfig();
        const nextConfig = { ...fresh, meeting_reminder_enabled: notifyBeforeMeetings };
        await updateConfig(nextConfig);
        setConfig(nextConfig);
      }
      await finishStep("ready", null, true);
      if (thenOpenModelSettings) onOpenModelSettings?.();
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
  // A banner (and a Retry button) only when a retry is actually scheduled.
  // Builds without a registration endpoint (every dev build) queue silently
  // with next_retry_at null — retrying there can never succeed, and the old
  // always-on amber banner read as a permanent bug.
  const pendingRegistration =
    registration.status === "pending" && registration.next_retry_at != null;

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
              <p>Your details are saved on this {deviceLabel} and will send automatically once you're back online.</p>
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
              Recording works on this {deviceLabel} right away, and everything
              stays here. A short tour inside the app shows you around —
              including how your meeting notes get written.
            </p>

            {transcriptionReady === true && (
              <p className="welcome-ready-line" role="status">
                Transcription ready ✓ — the model is already on this {deviceLabel}.
              </p>
            )}
            {transcriptionReady === false && (
              <div className="welcome-download" role="status">
                <div>
                  <strong>Adversaria needs a transcription model to turn recordings into text.</strong>
                </div>
                <p className="welcome-guide-copy">
                  {modelSizeHint
                    ? `It's about ${modelSizeHint} and lives on this ${deviceLabel} for good.`
                    : `It's a one-time download that lives on this ${deviceLabel} for good.`}{" "}
                  Nothing downloads without your say-so.
                </p>
                <div className="welcome-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => finishSetup(true)}
                    disabled={busy}
                  >
                    Choose &amp; download it in Settings
                  </button>
                </div>
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
              <button className="btn-primary" onClick={() => finishSetup()} disabled={busy}>
                {busy ? "Finishing…" : "Start using Adversaria"}
              </button>
            </div>
            <p className="welcome-footnote">
              You can go in without a transcription model — recording always
              works, and a meeting recorded now transcribes itself as soon as
              the model lands.
            </p>
          </section>
        )}

        {message && <p className={message.includes("success") || message.includes("queued") ? "welcome-success" : "welcome-message"} role="status">{message}</p>}
      </main>
    </div>
  );
}
