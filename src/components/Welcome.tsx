import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import type {
  AppConfig,
  ModelDownloadStatus,
  ModelProfile,
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
import { EngineInstallCard } from "./EngineInstallCard";

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

/** A persisted model choice is only usable if THIS machine still offers it.
 *
 * Onboarding stores `selected_model_profile`, so a choice made on a build that
 * offered different profiles — an MLX id like `qwen-27b-quality` picked before
 * Windows listed Ollama models — is replayed on every resume. Left unchecked it
 * is handed to the managed-runtime start and fails there forever, which is
 * exactly how a resumed setup got stuck on step 6/7. */
export function resolveProfile(persisted: string, setup: SetupStatus): string {
  return setup.profiles.some((profile) => profile.id === persisted)
    ? persisted
    : setup.recommended_profile;
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

/** Restart-safe first-run setup, three screens total. Every completed step is
 * persisted by Rust; a network failure queues registration locally and never
 * blocks local setup. Model downloads start immediately, continue after the
 * wizard closes, and the sample verification runs in the background from
 * SetupStatusStrip — the wizard never makes the user wait for either. */
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
  const [selectedProfile, setSelectedProfile] = useState("");
  // A pinned tier on a platform whose managed engine isn't installed yet is
  // consent-locked: NOTHING about it downloads until the user approves the
  // transparent install plan (SETUP_REDESIGN_SPEC §D). Whisper models are
  // exempt — transcription is core and disclosed on the first screen.
  const engineConsentPending = Boolean(
    setup &&
      setup.platform !== "macos" &&
      !setup.managed_engine_installed &&
      selectedProfile &&
      !selectedProfile.startsWith("ollama:"),
  );
  // Profile ids the download pipeline may actually fetch. An Ollama model is
  // already on disk, and the Rust side's `downloadable_profile` rejects its id
  // outright — so including it here would raise "Unknown model profile" on the
  // start call and again on every one-second status poll.
  const engineDownloadIds = useMemo(
    () =>
      selectedProfile && !selectedProfile.startsWith("ollama:") && !engineConsentPending
        ? [...ENGINE_WHISPER_IDS, selectedProfile]
        : [...ENGINE_WHISPER_IDS],
    [selectedProfile, engineConsentPending],
  );
  const [engineDownloads, setEngineDownloads] = useState<Record<string, ModelDownloadStatus>>({});
  const [engineError, setEngineError] = useState("");

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
        setSelectedProfile(
          resolveProfile(nextOnboarding.selected_model_profile, nextSetup),
        );
      })
      .catch(() => {
        setLoadingError("Setup state could not be loaded. Restart Adversaria and try again.");
      });
  }, []);

  // Whisper models are needed for every provider (transcription is always
  // on-device), so start caching them the moment first-run setup begins —
  // the download overlaps the registration screen. Server-side starts are
  // idempotent; failures are silent here (the service may still be booting)
  // and the Ready screen retries and surfaces real errors.
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

  // Seamless engine setup: the selected profile (and the Whisper models, in
  // case the early start raced the service boot) auto-start — and auto-resume
  // after a relaunch — whenever the Ready screen is showing.
  useEffect(() => {
    if (!selectedProfile || step !== "ready") return;
    engineDownloadIds.forEach((id) => {
      startModelDownload(id).catch((error) => setEngineError(String(error)));
    });
  }, [selectedProfile, step]);

  // Combined polling for all engine downloads (LLM + Whisper models) — one
  // status bar that covers everything the user needs before their first meeting.
  useEffect(() => {
    if (step !== "ready") return;
    const timer = window.setInterval(() => {
      engineDownloadIds.forEach((id) => {
        getModelDownloadStatus(id)
          .then((status) => {
            setEngineDownloads((current) => ({ ...current, [id]: status }));
          })
          .catch(() => {});
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [engineDownloadIds, step]);

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

  // Finishing never blocks on downloads: they continue inside the app, where
  // SetupStatusStrip shows the same aggregate bar and then runs the sample
  // verification. A machine with no local engine yet (Windows without Ollama)
  // finishes with no profile — Settings › AI Model picks it up later.
  const finishReady = async () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (config.meeting_reminder_enabled !== notifyBeforeMeetings) {
        const nextConfig = { ...config, meeting_reminder_enabled: notifyBeforeMeetings };
        await updateConfig(nextConfig);
        setConfig(nextConfig);
      }
      await finishStep("ready", selectedProfile || null, true);
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
  // Must mirror `setup::rapid_mlx_supported()` exactly — it decides which
  // engine's profiles the backend returns, and this decides the copy describing
  // them. Keying on `platform` alone would put on-device wording over an Ollama
  // list on an Intel Mac.
  const isAppleLocalRuntime =
    setup.platform === "macos" && setup.architecture === "aarch64";

  // Windows has no capture-permission prompts, so its wizard is two screens.
  const visibleSteps = STEP_ORDER.filter(
    (value) => value !== "permissions" || setup.platform === "macos",
  );
  const progressIndex = Math.max(0, visibleSteps.indexOf(step ?? "ready"));
  const pendingRegistration = registration.status === "pending";

  // Lead with ONE clear recommendation; the other profiles hide behind a quiet
  // "Change model" disclosure rather than competing as co-equal cards.
  const recommendedProfile =
    setup.profiles.find((profile) => profile.id === setup.recommended_profile) ?? setup.profiles[0];
  const otherProfiles = setup.profiles.filter((profile) => profile.id !== recommendedProfile?.id);
  const renderLocalProfile = (profile: ModelProfile) => (
    <label className={`welcome-profile${selectedProfile === profile.id ? " selected" : ""}`} key={profile.id}>
      <input type="radio" name="model-profile" checked={selectedProfile === profile.id} onChange={() => { setSelectedProfile(profile.id); }} />
      <span>
        <strong>{profile.display_name}{profile.recommended ? " · Recommended" : ""}</strong>
        <small>{profile.quality_label} · {profile.required_disk_gb} GB disk · {profile.minimum_memory_gb} GB memory</small>
        <small>{profile.quality_note}</small>
      </span>
      <em>{profile.installed ? "Verified" : "Not installed"}</em>
    </label>
  );

  const engineStatuses = engineDownloadIds
    .map((id) => engineDownloads[id])
    .filter((status): status is ModelDownloadStatus => Boolean(status));
  const engineTotal = engineStatuses.reduce((sum, status) => sum + status.total_bytes, 0);
  const engineDone = engineStatuses.reduce(
    (sum, status) => sum + Math.min(status.downloaded_bytes, status.total_bytes),
    0,
  );
  const engineFailed = engineStatuses.find((status) => status.state === "error");
  const engineAllReady =
    engineStatuses.length === engineDownloadIds.length &&
    engineStatuses.every((status) => status.state === "ready");

  const retryEngineDownloads = () => {
    setEngineError("");
    engineDownloadIds.forEach((id) => {
      if (engineDownloads[id]?.state === "error") {
        startModelDownload(id).catch((error) => setEngineError(String(error)));
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
            <h2 className="welcome-title" id="setup-title">You're ready</h2>
            {recommendedProfile ? (
              <p className="welcome-sub">
                Recommended for your <strong>{formatGb(setup.total_memory_bytes)}</strong> {deviceLabel}:{" "}
                <strong>{recommendedProfile.display_name}</strong>.{" "}
                {isAppleLocalRuntime
                  ? "It downloads and verifies in the background — you can start using Adversaria right away."
                  : selectedProfile.startsWith("ollama:")
                    ? "This model is already on this computer, so nothing new downloads."
                    : "It downloads after you approve the engine plan below — everything is named before anything installs."}
              </p>
            ) : (
              <p className="welcome-sub">
                Adversaria records and transcribes on this {deviceLabel} out of the
                box. Your meeting-notes model can be set up any time in
                Settings → AI Model.
              </p>
            )}

            {!setup.rapid_runtime_bundled && isAppleLocalRuntime && (
              <p className="welcome-error" role="alert">
                This build is missing its local engine, so meeting notes will need
                a reinstall of Adversaria. Recording and everything you set up here
                are unaffected.
              </p>
            )}
            {!isAppleLocalRuntime && setup.profiles.length === 0 && (
              <p className="welcome-footnote" role="note">
                No local notes engine was found on this computer yet — finish setup
                now and connect one later in Settings → AI Model.
              </p>
            )}
            {engineConsentPending && (
              <EngineInstallCard
                onInstalled={() => {
                  getSetupStatus()
                    .then(setSetup)
                    .catch((error) => setMessage(String(error)));
                }}
              />
            )}

            {otherProfiles.length > 0 && (
              <details className="welcome-more-models">
                <summary>Change model</summary>
                <div className="welcome-profile-list">
                  {recommendedProfile && renderLocalProfile(recommendedProfile)}
                  {otherProfiles.map(renderLocalProfile)}
                </div>
              </details>
            )}

            <div className={`welcome-download ${engineFailed ? "error" : "downloading"}`} role="status">
              <div>
                <strong>
                  {engineFailed
                    ? engineFailed.detail
                    : engineAllReady
                      ? "Your private engine is ready."
                      : "Setting up your private engine in the background…"}
                </strong>
                <span>
                  {engineTotal > 0 ? `${formatGb(engineDone)} / ${formatGb(engineTotal)}` : "Preparing…"}
                </span>
              </div>
              {engineTotal > 0 ? (
                <progress value={engineDone} max={engineTotal} />
              ) : (
                <progress />
              )}
            </div>
            {engineFailed && (
              <div className="welcome-actions">
                <button className="btn-secondary" onClick={retryEngineDownloads} disabled={busy}>
                  Retry downloads
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
              <button className="btn-primary" onClick={finishReady} disabled={busy}>
                {busy ? "Finishing…" : "Start using Adversaria"}
              </button>
            </div>
            <p className="welcome-footnote">
              Anything still downloading keeps going inside Adversaria — a small
              status bar tracks it until your first meeting notes are verified.
            </p>
          </section>
        )}

        {message && <p className={message.includes("success") || message.includes("queued") ? "welcome-success" : "welcome-message"} role="status">{message}</p>}
        {engineError && <p className="welcome-message" role="status">{engineError}</p>}
      </main>
    </div>
  );
}
