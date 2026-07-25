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
  startManagedLlm,
  startModelDownload,
  submitRegistration,
  testCloudSetup,
  testLlmConnection,
  testLocalSetup,
  updateConfig,
} from "../lib/tauri";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENGINE_WHISPER_IDS = ["whisper-live", "whisper-main"] as const;
const STEP_ORDER = [
  "registration",
  "disclosure",
  "hardware",
  "model",
  "permissions",
  "sample",
  "capture",
] as const;
type SetupStep = (typeof STEP_ORDER)[number];
type ProviderChoice = "local" | "cloud";

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

/** Restart-safe first-run setup. Every completed step is persisted by Rust; a
 * network failure queues registration locally and never blocks local setup. */
export function Welcome() {
  const [registration, setRegistration] = useState<RegistrationState>(emptyRegistration);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loadingError, setLoadingError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [provider, setProvider] = useState<ProviderChoice>("local");
  const [disclosureAccepted, setDisclosureAccepted] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState("");
  const [engineDownloads, setEngineDownloads] = useState<Record<string, ModelDownloadStatus>>({});
  const [engineError, setEngineError] = useState("");
  const [cloudBaseUrl, setCloudBaseUrl] = useState("https://api.openai.com/v1");
  const [cloudApiKey, setCloudApiKey] = useState("");
  const [cloudModel, setCloudModel] = useState("");
  const [cloudDisclosure, setCloudDisclosure] = useState(false);
  const [sampleTitle, setSampleTitle] = useState("");
  const [warmupSeconds, setWarmupSeconds] = useState<number | null>(null);

  const refreshSetup = async () => {
    const value = await getSetupStatus();
    setSetup(value);
    setSelectedProfile((current) => current || value.recommended_profile);
    return value;
  };

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
        setProvider(nextConfig.llm_provider === "local" ? "local" : "cloud");
        setSelectedProfile(
          nextOnboarding.selected_model_profile || nextSetup.recommended_profile,
        );
        setCloudBaseUrl(nextConfig.llm_base_url || "https://api.openai.com/v1");
        setCloudApiKey(nextConfig.llm_api_key || "");
        setCloudModel(nextConfig.ollama_model || "");
      })
      .catch(() => {
        setLoadingError("Setup state could not be loaded. Restart Adversaria and try again.");
      });
  }, []);

  // Whisper models are needed for every provider (transcription is always
  // on-device), so start caching them the moment first-run setup begins —
  // the download overlaps the registration/disclosure steps. Server-side
  // starts are idempotent; failures are silent here (the service may still
  // be booting) and the model step retries and surfaces real errors.
  useEffect(() => {
    if (!onboarding || onboarding.setup_complete) return;
    ENGINE_WHISPER_IDS.forEach((id) => {
      startModelDownload(id).catch(() => {});
    });
  }, [onboarding?.setup_complete]);

  const step = useMemo<SetupStep | null>(() => {
    if (!onboarding || onboarding.setup_complete) return null;
    return STEP_ORDER.find((value) => !onboarding.completed_steps.includes(value)) ?? "capture";
  }, [onboarding]);

  // Seamless engine setup: the selected profile (and the Whisper models, in
  // case the early start raced the service boot) auto-start — and auto-resume
  // after a relaunch — whenever the local model or sample step is active.
  useEffect(() => {
    if (provider !== "local" || !selectedProfile || !["model", "sample"].includes(step ?? "")) {
      return;
    }
    [...ENGINE_WHISPER_IDS, selectedProfile].forEach((id) => {
      startModelDownload(id).catch((error) => setEngineError(String(error)));
    });
  }, [provider, selectedProfile, step]);

  // Combined polling for all engine downloads (LLM + Whisper models) — one
  // status bar that covers everything the user needs before their first meeting.
  useEffect(() => {
    if (provider !== "local" || !selectedProfile || !["model", "sample"].includes(step ?? "")) {
      return;
    }
    const ids = [...ENGINE_WHISPER_IDS, selectedProfile];
    const timer = window.setInterval(() => {
      ids.forEach((id) => {
        getModelDownloadStatus(id)
          .then(async (status) => {
            setEngineDownloads((current) => ({ ...current, [id]: status }));
            if (id === selectedProfile && status.state === "ready") await refreshSetup();
          })
          .catch(() => {});
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [provider, selectedProfile, step]);

  // Elapsed-seconds ticker for the model warm-up panel on the sample step.
  useEffect(() => {
    if (warmupSeconds === null) return;
    const timer = window.setInterval(() => {
      setWarmupSeconds((current) => (current === null ? null : current + 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [warmupSeconds !== null]);

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

  const finishStep = async (
    completedStep: SetupStep,
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

  const saveDisclosure = async () => {
    if (!disclosureAccepted || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const nextConfig = {
        ...config,
        llm_provider: provider === "local" ? "local" : "custom",
      };
      await updateConfig(nextConfig);
      setConfig(nextConfig);
      await finishStep("disclosure");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const chooseLocalModel = async () => {
    if (!selectedProfile || busy) return;
    setBusy(true);
    try {
      await finishStep("model", selectedProfile);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const chooseCloudModel = async () => {
    if (!cloudDisclosure || !cloudBaseUrl || !cloudApiKey || !cloudModel || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await testLlmConnection(cloudBaseUrl.trim(), cloudApiKey.trim());
      const nextConfig = {
        ...config,
        llm_provider: "custom",
        llm_base_url: cloudBaseUrl.trim().replace(/\/$/, ""),
        llm_api_key: cloudApiKey.trim(),
        ollama_model: cloudModel.trim(),
      };
      await updateConfig(nextConfig);
      setConfig(nextConfig);
      await finishStep("model");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const runSample = async () => {
    setBusy(true);
    setMessage(provider === "local" ? "" : "Running a cloud sample…");
    if (provider === "local") setWarmupSeconds(0);
    try {
      let title: string;
      if (provider === "local") {
        await startManagedLlm(selectedProfile);
        setWarmupSeconds(null);
        title = await testLocalSetup();
      } else {
        title = await testCloudSetup(cloudBaseUrl, cloudApiKey, cloudModel);
      }
      setSampleTitle(title);
      setMessage("Sample meeting notes completed successfully.");
      await finishStep("sample");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setWarmupSeconds(null);
      setBusy(false);
    }
  };

  const progressIndex = Math.max(0, STEP_ORDER.indexOf(step ?? "capture"));
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

  const engineStatuses = [...ENGINE_WHISPER_IDS, selectedProfile]
    .map((id) => engineDownloads[id])
    .filter((status): status is ModelDownloadStatus => Boolean(status));
  const engineTotal = engineStatuses.reduce((sum, status) => sum + status.total_bytes, 0);
  const engineDone = engineStatuses.reduce(
    (sum, status) => sum + Math.min(status.downloaded_bytes, status.total_bytes),
    0,
  );
  const engineFailed = engineStatuses.find((status) => status.state === "error");
  const selectedInstalled =
    (setup.profiles.find((profile) => profile.id === selectedProfile)?.installed ?? false) ||
    engineDownloads[selectedProfile]?.state === "ready";

  const retryEngineDownloads = () => {
    setEngineError("");
    [...ENGINE_WHISPER_IDS, selectedProfile].forEach((id) => {
      if (engineDownloads[id]?.state === "error") {
        startModelDownload(id).catch((error) => setEngineError(String(error)));
      }
    });
  };

  return (
    <div className="welcome-overlay">
      <main className="welcome-card welcome-card-wide" aria-labelledby="setup-title">
        <div className="welcome-progress" aria-label={`Setup step ${progressIndex + 1} of ${STEP_ORDER.length}`}>
          <span>Setup</span>
          <span>{progressIndex + 1} / {STEP_ORDER.length}</span>
        </div>
        <div className="welcome-progress-track" aria-hidden="true">
          <span style={{ width: `${((progressIndex + 1) / STEP_ORDER.length) * 100}%` }} />
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
              Register for the beta, then configure private local meeting notes without a terminal.
            </p>
            <label className="settings-label" htmlFor="welcome-name">Name</label>
            <input
              id="welcome-name"
              className="settings-input-text"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
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

        {step === "disclosure" && (
          <section>
            <h2 className="welcome-title" id="setup-title">Choose where meeting notes are created</h2>
            <p className="welcome-sub">Local is the default. Adversaria never falls back to a cloud provider automatically.</p>
            <div className="welcome-choice-grid">
              <button className={`welcome-choice${provider === "local" ? " selected" : ""}`} onClick={() => setProvider("local")}>
                <strong>On this Mac</strong>
                <span>Transcripts and prompts stay on-device. Models download from Hugging Face during setup.</span>
              </button>
              <button className={`welcome-choice${provider === "cloud" ? " selected" : ""}`} onClick={() => setProvider("cloud")}>
                <strong>My cloud provider</strong>
                <span>Meeting text is sent only to the HTTPS provider and model you explicitly configure.</span>
              </button>
            </div>
            <label className="welcome-check">
              <input type="checkbox" checked={disclosureAccepted} onChange={(event) => setDisclosureAccepted(event.target.checked)} />
              <span>I understand this data flow and can change it later in Settings.</span>
            </label>
            <div className="welcome-actions">
              <button className="btn-primary" onClick={saveDisclosure} disabled={!disclosureAccepted || busy}>Continue</button>
            </div>
          </section>
        )}

        {step === "hardware" && (
          <section>
            <h2 className="welcome-title" id="setup-title">Hardware check</h2>
            <p className="welcome-sub">The recommendation uses total memory and currently available disk space. Nothing is uploaded.</p>
            <dl className="welcome-hardware">
              <div><dt>Platform</dt><dd>{setup.platform} / {setup.architecture}</dd></div>
              <div><dt>Memory</dt><dd>{formatGb(setup.total_memory_bytes)}</dd></div>
              <div><dt>Free disk</dt><dd>{formatGb(setup.available_disk_bytes)}</dd></div>
              <div><dt>Local runtime</dt><dd>{setup.rapid_runtime_bundled ? "Bundled" : "Missing from this build"}</dd></div>
            </dl>
            {!setup.rapid_runtime_bundled && provider === "local" && (
              <p className="welcome-error" role="alert">This build is missing the pinned local runtime. You can inspect the model choices, but the sample cannot pass until Adversaria is reinstalled with a complete build.</p>
            )}
            <div className="welcome-actions">
              <button className="btn-primary" onClick={() => finishStep("hardware").catch((error) => setMessage(String(error)))}>Continue</button>
            </div>
          </section>
        )}

        {step === "model" && provider === "local" && (
          <section>
            <h2 className="welcome-title" id="setup-title">Install a local meeting model</h2>
            <p className="welcome-sub">Your Mac has <strong>{formatGb(setup.total_memory_bytes)}</strong> of memory, so <strong>{recommendedProfile?.display_name ?? "the lighter model"}</strong> is recommended — it fits and runs fast. Downloads resume from the content-addressed cache and every weight file is checksum-verified.</p>
            <div className="welcome-profile-list">
              {recommendedProfile && renderLocalProfile(recommendedProfile)}
            </div>
            {otherProfiles.length > 0 && (
              <details className="welcome-more-models">
                <summary>Change model</summary>
                <div className="welcome-profile-list">
                  {otherProfiles.map(renderLocalProfile)}
                </div>
              </details>
            )}
            <div className={`welcome-download ${engineFailed ? "error" : "downloading"}`} role="status">
              <div>
                <strong>
                  {engineFailed
                    ? engineFailed.detail
                    : selectedInstalled
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
            <div className="welcome-actions">
              <button className="btn-primary" onClick={chooseLocalModel} disabled={busy}>
                {selectedInstalled ? "Use this verified model" : "Continue — downloads keep running"}
              </button>
            </div>
          </section>
        )}

        {step === "model" && provider === "cloud" && (
          <section>
            <h2 className="welcome-title" id="setup-title">Connect your cloud provider</h2>
            <p className="welcome-sub">Adversaria will test the connection first. Meeting text is sent only after setup succeeds and cloud remains selected.</p>
            <label className="settings-label" htmlFor="welcome-cloud-url">OpenAI-compatible HTTPS base URL</label>
            <input id="welcome-cloud-url" className="settings-input-text" value={cloudBaseUrl} onChange={(event) => setCloudBaseUrl(event.target.value)} />
            <label className="settings-label welcome-field-label" htmlFor="welcome-cloud-model">Model</label>
            <input id="welcome-cloud-model" className="settings-input-text" value={cloudModel} onChange={(event) => setCloudModel(event.target.value)} />
            <label className="settings-label welcome-field-label" htmlFor="welcome-cloud-key">API key</label>
            <input id="welcome-cloud-key" className="settings-input-text" type="password" autoComplete="off" value={cloudApiKey} onChange={(event) => setCloudApiKey(event.target.value)} />
            <label className="welcome-check">
              <input type="checkbox" checked={cloudDisclosure} onChange={(event) => setCloudDisclosure(event.target.checked)} />
              <span>I understand that transcript text and prompts will be sent to this provider when I use meeting features.</span>
            </label>
            <div className="welcome-actions">
              <button className="btn-primary" onClick={chooseCloudModel} disabled={busy || !cloudDisclosure || !cloudBaseUrl || !cloudApiKey || !cloudModel}>{busy ? "Testing…" : "Test and continue"}</button>
            </div>
          </section>
        )}

        {step === "permissions" && (
          <section>
            <h2 className="welcome-title" id="setup-title">Recording permissions</h2>
            <p className="welcome-sub">macOS asks only when a feature first needs access. Denying a permission does not remove existing notes.</p>
            <ul className="welcome-permissions">
              <li><strong>Microphone</strong><span>Required only to include your voice.</span></li>
              <li><strong>System audio</strong><span>Required to capture calls and playback.</span></li>
              <li><strong>Accessibility</strong><span>Optional; used for meeting detection and app controls.</span></li>
            </ul>
            <p className="welcome-footnote">You can retry denied permissions from macOS System Settings and then return to Adversaria.</p>
            <div className="welcome-actions"><button className="btn-primary" onClick={() => finishStep("permissions").catch((error) => setMessage(String(error)))}>Continue</button></div>
          </section>
        )}

        {step === "sample" && (
          <section>
            <h2 className="welcome-title" id="setup-title">Verify meeting notes</h2>
            <p className="welcome-sub">A synthetic two-sentence meeting will be summarized. No personal or recorded content is used.</p>
            <div className="welcome-sample"><strong>Sample input</strong><p>Amina approved the launch checklist. Omar will send the final draft by Friday.</p></div>
            {provider === "local" && !selectedInstalled && (
              <div className="welcome-download downloading" role="status">
                <div>
                  <strong>Your meeting model is still downloading — this step unlocks when it finishes.</strong>
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
            )}
            {warmupSeconds !== null && (
              <div className="welcome-download downloading" role="status">
                <div>
                  <strong>Unfolding the meeting model into memory…</strong>
                  <span>
                    {Math.floor(warmupSeconds / 60)}:{String(warmupSeconds % 60).padStart(2, "0")} elapsed · usually 1–3 minutes on first start
                  </span>
                </div>
                <progress />
              </div>
            )}
            {sampleTitle && <p className="welcome-success">Created: {sampleTitle}</p>}
            <div className="welcome-actions"><button className="btn-primary" onClick={runSample} disabled={busy || (provider === "local" && !selectedInstalled)}>{busy ? "Running sample…" : "Run sample summary"}</button></div>
          </section>
        )}

        {step === "capture" && (
          <section>
            <h2 className="welcome-title" id="setup-title">Setup is ready</h2>
            <p className="welcome-sub">Your sample succeeded. A short recording test is optional; start one from the Record tab after entering the app.</p>
            <div className="welcome-summary-list">
              <span>Registration: {registration.status === "submitted" ? "submitted" : "queued for retry"}</span>
              <span>Meeting engine: {provider === "local" ? "local on this Mac" : "explicit cloud provider"}</span>
              <span>Recovery: interrupted setup resumes from this step</span>
            </div>
            <div className="welcome-actions"><button className="btn-primary" onClick={() => finishStep("capture", null, true).catch((error) => setMessage(String(error)))}>Finish setup</button></div>
          </section>
        )}

        {message && <p className={message.includes("success") || message.includes("queued") ? "welcome-success" : "welcome-message"} role="status">{message}</p>}
        {engineError && <p className="welcome-message" role="status">{engineError}</p>}
      </main>
    </div>
  );
}
