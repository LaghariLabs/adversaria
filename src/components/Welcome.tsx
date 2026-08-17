import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import type {
  AppConfig,
  OnboardingState,
  RegistrationState,
  SetupStatus,
  WhisperModelInfo,
} from "../types";
import { classifyTranscriptionProvider } from "../types";
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
  testLlmConnection,
  updateConfig,
  checkCapturePermissions,
  requestMicrophonePermission,
  probeSystemAudio,
  openPrivacySettings,
} from "../lib/tauri";
import type { CapturePermissions } from "../lib/tauri";
import { beginModelDownload, whisperModelId } from "../lib/modelDownloads";
import { useTranscriptionSetup } from "../hooks/useTranscriptionSetup";
import type { TranscriptionSetup } from "../hooks/useTranscriptionSetup";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STEP_ORDER = ["registration", "permissions", "ready"] as const;
type SetupStep = (typeof STEP_ORDER)[number];
/** Bounded catalogue retry: 2 s, 4 s, 8 s, 16 s, 30 s — ~60 s, then give up
 *  and say so. A sidecar that hasn't answered by then isn't booting slowly,
 *  it isn't coming, and re-probing it every 2 s for the life of the wizard
 *  only hides that from the user. */
const CATALOGUE_RETRIES = 5;

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
  /** App's single transcription-setup instance, threaded down so the download
   *  card reads it instead of mounting a second poller (App already shares this
   *  object with MeetingsList and NoteViewer). Optional so the wizard can still
   *  be rendered standalone; it falls back to its own instance then. */
  transcriptionSetup?: TranscriptionSetup;
}

/** Restart-safe first-run setup, three minimal screens (SPEC V3 addendum).
 *
 * NOTHING downloads automatically — here or anywhere. The wizard READS what is
 * already on the machine and says so: transcription ready, or a card that
 * lists the curated models with their sizes and starts a download only on the
 * user's explicit click, with live progress right there (2026-08-03 — the old
 * "download it in Settings" detour let a fresh user record a meeting and get
 * homework instead of notes). Everything else is deferred to the guided tour,
 * which ends on Settings › AI Model. */
export function Welcome({ onOpenModelSettings, transcriptionSetup }: WelcomeProps) {
  const [registration, setRegistration] = useState<RegistrationState>(emptyRegistration);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [perms, setPerms] = useState<CapturePermissions | null>(null);
  const [permBusy, setPermBusy] = useState<"" | "microphone" | "system_audio">("");
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
  // The curated transcription models, as the service reports them — the
  // download card's picker. Empty until the catalogue answers.
  const [whisperModels, setWhisperModels] = useState<WhisperModelInfo[]>([]);
  // The remote endpoint answered a probe during THIS session. A base URL that
  // merely exists in config was never contacted, so it may say where audio
  // goes but never "ready ✓".
  const [remoteVerified, setRemoteVerified] = useState(false);
  // The bounded catalogue retry ran out without an answer — the card stops
  // promising a list that is never arriving and offers an explicit retry.
  const [catalogueUnavailable, setCatalogueUnavailable] = useState(false);
  // Bumped by that retry to re-arm the probe (like loadNonce above).
  const [catalogueNonce, setCatalogueNonce] = useState(0);

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

  // A remote transcription endpoint that is already configured — the user's own
  // Whisper server, or a provider's API. Transcription is SET UP on this
  // machine: the local catalogue and the local engine's state say nothing about
  // it, so the wizard must never ask this user to download 1.6 GB.
  const remoteConfigured =
    config !== null &&
    config.transcription_provider !== "local" &&
    config.transcription_base_url.trim() !== "";

  // One read of reality for the final screen. The service is authoritative
  // when it answers; the model list doubles as the download card's picker.
  // The only repetition here is a quiet retry WHILE the catalogue is empty —
  // on a fresh install the sidecar is often still booting when this screen
  // appears, and an empty picker would strand the card's whole point — and it
  // is bounded (CATALOGUE_RETRIES), because a sidecar that never boots used to
  // mean a 2 s probe forever behind copy that never admitted anything was wrong.
  useEffect(() => {
    if (step !== "ready") return;
    // Transcription runs somewhere else: there is nothing local to probe and
    // nothing to download, whatever the local engine happens to report.
    if (remoteConfigured) {
      setTranscriptionReady(true);
      return;
    }
    let alive = true;
    let attempts = 0;
    let timer: number | undefined;
    const probe = () => {
      Promise.allSettled([checkServiceHealth(), listWhisperModels()]).then(
        ([health, models]) => {
          if (!alive) return;
          const state =
            health.status === "fulfilled" ? health.value.transcriber_state : undefined;
          const catalogue = models.status === "fulfilled" ? models.value : [];
          // "error" is the service positively reporting that the model on disk
          // cannot be loaded, so the catalogue's `downloaded` flag must NOT
          // override it — that read is exactly what "Transcription ready ✓"
          // used to promise a machine whose engine had already failed.
          setTranscriptionReady(
            state === "error"
              ? false
              : state === "ready" || catalogue.some((model) => model.downloaded),
          );
          if (catalogue.length > 0) {
            setWhisperModels(catalogue);
            return;
          }
          if (state === "ready") return;
          if (attempts >= CATALOGUE_RETRIES) {
            setCatalogueUnavailable(true);
            return;
          }
          timer = window.setTimeout(probe, Math.min(2000 * 2 ** attempts, 30_000));
          attempts += 1;
        },
      );
    };
    probe();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [step, catalogueNonce, remoteConfigured]);

  // Live permission state for the permissions step. Re-checked on focus because
  // a user who grants in System Settings and tabs back gets no callback.
  useEffect(() => {
    if (step !== "permissions") return;
    let alive = true;
    const refresh = () => {
      checkCapturePermissions()
        .then((p) => { if (alive) setPerms(p); })
        .catch((error) => {
          if (alive) setMessage(`Couldn't load recording permissions: ${String(error)}`);
        });
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

  const checkSystemAudio = async () => {
    setPermBusy("system_audio");
    try {
      setMessage("");
      setPerms(await probeSystemAudio());
    } catch (error) {
      setMessage(String(error));
    } finally {
      setPermBusy("");
    }
  };

  const openSystemAudioSettings = async () => {
    try {
      setMessage("");
      await openPrivacySettings("system_audio");
    } catch (error) {
      setMessage(String(error));
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

  // Name the machine that transcribes when it isn't this one — "ready" with no
  // idea where the audio goes is exactly the copy this wizard shouldn't ship.
  const remoteHost = (() => {
    try {
      return new URL(config.transcription_base_url).host;
    } catch {
      return "";
    }
  })();

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
                <span className={`perm-dot perm-${perms?.system_audio ?? "undetermined"}`} />
                <div className="perm-copy">
                  <strong>System audio</strong>
                  <span>
                    System audio — the sound your Mac plays (the other side of your meetings).
                    Adversaria plays a brief quiet tone to confirm macOS lets it listen. Nothing
                    leaves your Mac.
                  </span>
                  {perms?.system_audio === "denied" && (
                    <span>
                      macOS didn't let Adversaria hear system audio. If your Mac is muted, unmute
                      and check again. Otherwise enable Adversaria under System Audio Recording
                      Only:
                    </span>
                  )}
                </div>
                {permBusy === "system_audio" ? (
                  <span className="perm-ok" role="status">
                    Listening… answer the macOS prompt if one appears.
                  </span>
                ) : perms?.system_audio === "granted" ? (
                  <span className="perm-ok">Granted</span>
                ) : perms?.system_audio === "denied" ? (
                  <div className="settings-row">
                    <button
                      className="btn-secondary"
                      disabled={permBusy !== ""}
                      onClick={() => void openSystemAudioSettings()}
                    >
                      Open System Settings
                    </button>
                    <button
                      className="btn-secondary"
                      disabled={permBusy !== ""}
                      onClick={() => void checkSystemAudio()}
                    >
                      Check again
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn-secondary"
                    disabled={permBusy !== ""}
                    onClick={() => void checkSystemAudio()}
                  >
                    Check system audio
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

            <p className="welcome-footnote">
              Denying doesn't delete anything — you can grant later in System Settings.
              Adversaria never records unless you press Record.
            </p>
            <div className="welcome-actions">
              <button className="btn-primary" onClick={() => finishStep("permissions").catch((error) => setMessage(String(error)))}>
                {perms?.system_audio === "granted" ? "Continue" : "Continue anyway"}
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

            {remoteConfigured ? (
              <p className="welcome-ready-line" role="status">
                {remoteVerified ? "Transcription ready ✓ — " : "Transcription goes to "}
                {config.transcription_provider === "self_hosted"
                  ? "your own Whisper server"
                  : "your transcription provider"}
                {remoteHost ? ` (${remoteHost})` : ""}
                {remoteVerified
                  ? " handles it, so there's nothing to download here."
                  : " — nothing downloads here. Adversaria hasn't reached that address" +
                    " yet; if it doesn't answer, fix it in Settings › AI Model."}
              </p>
            ) : transcriptionReady === true ? (
              <p className="welcome-ready-line" role="status">
                Transcription ready ✓ — the model is already on this {deviceLabel}.
              </p>
            ) : transcriptionReady === false ? (
              (() => {
                const cardProps = {
                  models: whisperModels,
                  defaultKey: config.whisper_model,
                  deviceLabel,
                  onMoreModels: () => finishSetup(true),
                  moreModelsDisabled: busy,
                  catalogueUnavailable,
                  onRetryCatalogue: () => {
                    setCatalogueUnavailable(false);
                    setCatalogueNonce((n) => n + 1);
                  },
                  // A saved endpoint makes `remoteConfigured` true on the next
                  // render, which retires this card — no second source of truth.
                  onEndpointSaved: (next: AppConfig, verified: boolean) => {
                    setConfig(next);
                    setRemoteVerified(verified);
                  },
                };
                // Two components rather than one conditional hook call: with
                // App's instance we poll nothing extra; standalone (tests) the
                // wrapper owns a poller so the card still works.
                return transcriptionSetup ? (
                  <TranscriptionDownloadCard {...cardProps} transcription={transcriptionSetup} />
                ) : (
                  <SelfPolledTranscriptionDownloadCard {...cardProps} />
                );
              })()
            ) : null}

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

/** "~1.6 GB" from the catalogue → "1.6 GB" for buttons and copy. */
function sizeLabel(model: WhisperModelInfo): string {
  return model.size.replace("~", "").trim();
}

interface TranscriptionDownloadCardProps {
  /** Curated transcription models, as the final screen's probe reported them. */
  models: WhisperModelInfo[];
  /** The configured model key (config.whisper_model) — the picker's default. */
  defaultKey: string;
  deviceLabel: string;
  /** Finish setup and land on Settings › AI Model (the full model manager). */
  onMoreModels: () => void;
  moreModelsDisabled: boolean;
  /** The bounded catalogue probe gave up — the list is not coming on its own. */
  catalogueUnavailable: boolean;
  /** Re-arm that probe (the card's "Try again"). */
  onRetryCatalogue: () => void;
  /** A remote Whisper endpoint was saved — hand the fresh config back so the
   *  wizard stops asking for a download. `verified` is true only when that
   *  address actually answered, so nothing is called "ready" on trust. */
  onEndpointSaved: (config: AppConfig, verified: boolean) => void;
  /** Live transcription state — owned by App, never polled twice. */
  transcription: TranscriptionSetup;
}

/** The card for a `Welcome` rendered without App's transcription instance —
 *  it owns a poller so the standalone wizard keeps working. */
function SelfPolledTranscriptionDownloadCard(
  props: Omit<TranscriptionDownloadCardProps, "transcription">,
) {
  const transcription = useTranscriptionSetup();
  return <TranscriptionDownloadCard {...props} transcription={transcription} />;
}

/** In-place transcription-model download for the wizard's final screen.
 *
 * The previous card demoted the download to a "go do it in Settings" detour;
 * a fresh user took the primary path instead, recorded a meeting, and got
 * homework instead of notes. Now the choice and the download happen right
 * here: pick a model, one explicit click, live progress, retry on failure.
 * Still NOTHING starts without that click, and finishing setup never blocks
 * on the download — it keeps going in the app chrome.
 *
 * The quiet second path is "use your own endpoint": an org whose IT already
 * runs one Whisper box shouldn't make every laptop fetch 1.6 GB, and that box
 * is on their own network — the download is the wrong ask, not the private one.
 *
 * Takes the transcription state as a prop rather than polling for itself: App
 * already runs one `useTranscriptionSetup()` at the root, and a second mount
 * doubled every health + download request for as long as this screen was open
 * (measured 2026-08-03) — the very churn the poll-storm fix removed. */
function TranscriptionDownloadCard({
  models,
  defaultKey,
  deviceLabel,
  onMoreModels,
  moreModelsDisabled,
  catalogueUnavailable,
  onRetryCatalogue,
  onEndpointSaved,
  transcription,
}: TranscriptionDownloadCardProps) {
  // "" until the user picks; the configured model (or the first) is the
  // effective default, resolved late because models can arrive after mount.
  const [pickedKey, setPickedKey] = useState("");
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState("");
  // What the service answered when a download couldn't actually start.
  const [startNote, setStartNote] = useState("");
  // The "I already have a Whisper server" path: hidden until asked for, because
  // it is the minority case — but the ONLY sane one for an office that already
  // runs a shared Whisper box (every laptop fetching its own 1.6 GB is waste,
  // and that server is on their own network, not a third party's).
  const [showEndpoint, setShowEndpoint] = useState(false);
  const [endpointUrl, setEndpointUrl] = useState("");
  const [endpointModel, setEndpointModel] = useState("");
  const [endpointKey, setEndpointKey] = useState("");
  const [endpointBusy, setEndpointBusy] = useState(false);
  const [endpointError, setEndpointError] = useState("");
  // URLs the user was warned about and submitted again anyway. The form warns
  // once and then obeys — a public host may be deliberate, and a Whisper server
  // that doesn't serve `/v1/models` is still a working server. Keyed to the URL
  // so editing the address re-arms both warnings.
  const [publicHostAck, setPublicHostAck] = useState("");
  const [unreachableAck, setUnreachableAck] = useState("");

  const selectedKey =
    pickedKey ||
    (models.some((model) => model.key === defaultKey) ? defaultKey : models[0]?.key ?? "");
  const selected = models.find((model) => model.key === selectedKey);
  // No list and no prospect of one: the service isn't answering.
  const catalogueOffline = catalogueUnavailable || transcription.serviceOnline === false;

  const startDownload = async () => {
    if (!selected || startBusy) return;
    setStartBusy(true);
    setStartError("");
    setStartNote("");
    try {
      // Persist the choice first (fresh read-modify-write, exactly like the
      // Settings picker) so the engine loads the model the user picked the
      // moment it lands.
      const fresh = await getConfig();
      await updateConfig({ ...fresh, whisper_model: selected.key });
      const status = await beginModelDownload(whisperModelId(selected.key));
      // The service refuses to re-fetch a profile it already holds
      // (`start_model_download` returns early on "ready"), so re-downloading a
      // model that IS on disk — the shape of an engine-load failure — cannot
      // fix it. Say that out loud instead of leaving a click that looks broken.
      if (status?.state === "ready") {
        setStartNote(
          `${selected.label} is already on this ${deviceLabel}, so there is nothing to re-download. ` +
            "Pick a different model here, or remove and re-download this one in Settings › AI Model.",
        );
      }
    } catch (error) {
      setStartError(String(error));
    } finally {
      setStartBusy(false);
    }
  };

  /** Save a Whisper server the user already runs. Downloads nothing, ever. */
  const saveEndpoint = async (event: FormEvent) => {
    event.preventDefault();
    if (endpointBusy) return;
    const url = endpointUrl.trim();
    // A base URL with no host ("dgx:8000", "not a url") is the mistake that
    // silently produces a transcription engine which can never answer.
    let host = "";
    try {
      host = url === "" ? "" : new URL(url).host;
    } catch {
      host = "";
    }
    if (!host) {
      setEndpointError(
        "Enter the full base URL of your Whisper server, like http://dgx.office.local:8000/v1.",
      );
      return;
    }
    // Which engine this address really is — never a hard-coded "self_hosted"
    // for anything with a host. A public URL stamped as self-hosted inherits
    // "never to a third party / stays on your network" copy here AND in
    // Settings, forever, because nothing re-derives the label afterwards.
    const provider = classifyTranscriptionProvider(url);
    if (provider === "cloud" && publicHostAck !== url) {
      setPublicHostAck(url);
      setEndpointError(
        `${host} isn't an address on your network, so your meeting audio would leave ` +
          `this device — that is not sovereign. Press "Use this server" again to send ` +
          "transcription there anyway.",
      );
      return;
    }
    setEndpointBusy(true);
    setEndpointError("");
    try {
      // Verify before promising. "Transcription ready ✓" used to be a pure
      // config-shape claim, so a typo'd host finished setup as ready, skipped
      // the download, and only failed on the first real meeting. `/v1/models`
      // is the same probe the Settings LLM field uses, and both a self-hosted
      // Whisper server and a provider expose it.
      let verified = true;
      try {
        await testLlmConnection(url, endpointKey.trim());
      } catch (error) {
        verified = false;
        if (unreachableAck !== url) {
          setUnreachableAck(url);
          setEndpointError(
            `Couldn't reach that server: ${String(error)} — check the address, or press ` +
              '"Use this server" again to save it anyway and fix it later in Settings › AI Model.',
          );
          return;
        }
      }
      // Fresh read-modify-write, exactly like startDownload: the mount-time
      // config predates the registration step that wrote user_name/user_email.
      const fresh = await getConfig();
      const next: AppConfig = {
        ...fresh,
        transcription_provider: provider,
        transcription_base_url: url,
        transcription_model:
          endpointModel.trim() || fresh.transcription_model.trim() || "whisper-large-v3",
        transcription_api_key: endpointKey.trim(),
      };
      await updateConfig(next);
      onEndpointSaved(next, verified);
    } catch (error) {
      setEndpointError(String(error));
    } finally {
      setEndpointBusy(false);
    }
  };

  // A download finished while the user was still here: the card's job is done.
  if (transcription.state === "ready") {
    return (
      <p className="welcome-ready-line" role="status">
        Transcription ready ✓ — the model is on this {deviceLabel}.
      </p>
    );
  }

  return (
    <div
      className={`welcome-download${transcription.state === "failed" ? " error" : ""}`}
      role="status"
    >
      <div>
        <strong>Adversaria needs a transcription model to turn recordings into text.</strong>
      </div>
      {transcription.state === "downloading" ? (
        <>
          <p className="welcome-guide-copy">
            {transcription.percent === null
              ? "Downloading…"
              : `Downloading — ${transcription.percent}%.`}{" "}
            You can start using Adversaria now — the download keeps going and
            its progress stays visible at the top of the app.
          </p>
          {transcription.percent === null ? (
            <progress />
          ) : (
            <progress value={transcription.percent} max={100} />
          )}
        </>
      ) : transcription.state === "loading" ? (
        <>
          <p className="welcome-guide-copy">
            The model is here — the transcription engine is starting…
          </p>
          <progress />
        </>
      ) : (
        <>
          {/* A failure — a dead download OR an engine that can't load what is
              already on disk — states itself and then falls through to the
              picker. The old failure branch hid the models, the Settings
              escape and every working action behind one "Retry download"
              button that does nothing at all when no download is in error. */}
          {transcription.state === "failed" && (
            <p className="welcome-error welcome-download-error">
              {transcription.detail || "The download failed. Check your connection and try again."}
            </p>
          )}
          <p className="welcome-guide-copy">
            Pick a model — it's a one-time download that lives on this {deviceLabel}{" "}
            for good. Nothing downloads without your say-so.
          </p>
          {models.length === 0 ? (
            <p className="welcome-guide-copy">
              {catalogueOffline
                ? "The on-device service isn't responding, so the model list can't load. Recording still works — you can set this up later in Settings › AI Model."
                : "The list of models isn't available yet — it appears once the on-device service is running."}
            </p>
          ) : (
            <fieldset className="welcome-model-list" aria-label="Transcription model">
              {models.map((model) => (
                <label key={model.key} className="welcome-check">
                  <input
                    type="radio"
                    name="welcome-whisper-model"
                    checked={model.key === selectedKey}
                    onChange={() => setPickedKey(model.key)}
                  />
                  <span>
                    {model.label} — {sizeLabel(model)}
                    {model.downloaded ? ` · already on this ${deviceLabel}` : ""}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="welcome-actions">
            <button className="btn-link" onClick={onMoreModels} disabled={moreModelsDisabled}>
              More models in Settings
            </button>
            {models.length === 0 && catalogueOffline && (
              <button
                className="btn-primary"
                onClick={() => {
                  transcription.refresh();
                  onRetryCatalogue();
                }}
              >
                Try again
              </button>
            )}
            {selected && (
              <button className="btn-primary" onClick={startDownload} disabled={startBusy}>
                {startBusy ? "Starting…" : `Download (${sizeLabel(selected)})`}
              </button>
            )}
          </div>
          {startError && <p className="welcome-error">{startError}</p>}
          {startNote && <p className="welcome-guide-copy welcome-download-note">{startNote}</p>}

          {showEndpoint ? (
            <form onSubmit={saveEndpoint}>
              <p className="welcome-guide-copy welcome-download-note">
                Point Adversaria at a Whisper server you or your IT team run.
                Audio goes to that server and stays on your network — it is
                never sent to a third party, and nothing downloads here.
              </p>
              <label className="settings-label welcome-field-label" htmlFor="welcome-endpoint-url">
                Base URL
              </label>
              <input
                id="welcome-endpoint-url"
                className="settings-input-text"
                value={endpointUrl}
                onChange={(event) => setEndpointUrl(event.target.value)}
                placeholder="http://dgx.office.local:8000/v1"
              />
              <label className="settings-label welcome-field-label" htmlFor="welcome-endpoint-model">
                Model
              </label>
              <input
                id="welcome-endpoint-model"
                className="settings-input-text"
                value={endpointModel}
                onChange={(event) => setEndpointModel(event.target.value)}
                placeholder="whisper-large-v3"
              />
              <label className="settings-label welcome-field-label" htmlFor="welcome-endpoint-key">
                API key (optional)
              </label>
              <input
                id="welcome-endpoint-key"
                className="settings-input-text"
                type="password"
                value={endpointKey}
                onChange={(event) => setEndpointKey(event.target.value)}
              />
              <p className="welcome-field-hint">
                Speaker labels aren't available with a remote server — everyone
                else on the call is labeled "Them".
              </p>
              {endpointError && (
                <p className="welcome-error welcome-download-error">{endpointError}</p>
              )}
              <div className="welcome-actions">
                <button className="btn-primary" type="submit" disabled={endpointBusy}>
                  {endpointBusy ? "Saving…" : "Use this server"}
                </button>
              </div>
            </form>
          ) : (
            <p className="welcome-guide-copy welcome-download-note">
              Already have a Whisper server?{" "}
              <button className="btn-link" onClick={() => setShowEndpoint(true)}>
                Use your own endpoint.
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
