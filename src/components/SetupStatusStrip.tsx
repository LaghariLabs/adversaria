import { useEffect, useRef, useState } from "react";

import type { AppConfig, ModelDownloadStatus, OnboardingState, SetupStatus } from "../types";
import {
  completeOnboardingStep,
  getConfig,
  getModelDownloadStatus,
  getOnboardingState,
  getSetupStatus,
  startManagedLlm,
  startModelDownload,
  testLocalSetup,
} from "../lib/tauri";
import { ENGINE_WHISPER_IDS } from "./Welcome";

function formatGb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

type SampleState = "waiting" | "running" | "passed" | "failed";

/** Post-wizard engine setup, out of the user's way.
 *
 * The 3-screen wizard never blocks on model downloads or the sample summary —
 * both moved here. While first-run downloads finish, this strip shows the same
 * aggregate progress bar; when the meeting model is ready it runs the sample
 * verification exactly once and records the legacy "sample" step (with
 * `setup_complete` kept true — `complete_step` overwrites that flag, so passing
 * false here would resurrect the wizard). It renders nothing for users whose
 * sample already passed, for cloud providers, and for machines with no local
 * profile yet (Settings › AI Model owns that path). */
export function SetupStatusStrip() {
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [downloads, setDownloads] = useState<Record<string, ModelDownloadStatus>>({});
  const [sample, setSample] = useState<SampleState>("waiting");
  const [sampleError, setSampleError] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const sampleFired = useRef(false);
  const downloadsKicked = useRef(false);

  // The wizard completes in a sibling component this strip can't observe, so
  // re-read onboarding until setup finishes. 3 s is imperceptible next to the
  // downloads this strip exists to babysit.
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      Promise.all([getOnboardingState(), getConfig(), getSetupStatus()])
        .then(([nextOnboarding, nextConfig, nextSetup]) => {
          if (!alive) return;
          setOnboarding(nextOnboarding);
          setConfig(nextConfig);
          setSetup(nextSetup);
        })
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(() => {
      if (onboarding?.setup_complete) return;
      refresh();
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [onboarding?.setup_complete]);

  const profile = onboarding?.selected_model_profile ?? "";
  const sampleRecorded = onboarding?.completed_steps.includes("sample") ?? false;
  // A pinned tier whose managed engine isn't installed is consent-locked
  // (wizard "Not now"): never download it from here — point at Settings
  // instead (SETUP_REDESIGN_SPEC §D).
  const consentPending = Boolean(
    setup &&
      setup.platform !== "macos" &&
      !setup.managed_engine_installed &&
      profile &&
      !profile.startsWith("ollama:"),
  );
  // First-run only: once the sample has ever passed, this strip stays gone.
  const active = Boolean(
    onboarding?.setup_complete &&
      config?.llm_provider === "local" &&
      profile &&
      !sampleRecorded &&
      !consentPending,
  );

  const downloadIds =
    profile && !profile.startsWith("ollama:")
      ? [...ENGINE_WHISPER_IDS, profile]
      : [...ENGINE_WHISPER_IDS];

  // Resume downloads after a relaunch (idempotent server-side), then poll the
  // same aggregate the wizard showed.
  useEffect(() => {
    if (!active) return;
    if (!downloadsKicked.current) {
      downloadsKicked.current = true;
      downloadIds.forEach((id) => {
        startModelDownload(id).catch(() => {});
      });
    }
    const poll = () => {
      downloadIds.forEach((id) => {
        getModelDownloadStatus(id)
          .then((status) => {
            setDownloads((current) => ({ ...current, [id]: status }));
          })
          .catch(() => {});
      });
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => window.clearInterval(timer);
  }, [active, profile]);

  const engineReady =
    profile.startsWith("ollama:") || downloads[profile]?.state === "ready";

  // Run the verification exactly once per app run; Retry re-arms it.
  useEffect(() => {
    if (!active || !engineReady || sampleFired.current || sample !== "waiting") return;
    sampleFired.current = true;
    setSample("running");
    (async () => {
      try {
        await startManagedLlm(profile);
        await testLocalSetup();
        // Keep setup_complete TRUE — complete_step overwrites the flag.
        const next = await completeOnboardingStep("sample", null, true);
        setSample("passed");
        window.setTimeout(() => {
          setDismissed(true);
          setOnboarding(next);
        }, 6000);
      } catch (error) {
        setSampleError(String(error));
        setSample("failed");
      }
    })();
  }, [active, engineReady, sample, profile]);

  if (dismissed) return null;
  if (!active) {
    // Consent-locked engine after wizard "Not now": a quiet pointer, never a
    // download. Everything else inactive renders nothing.
    if (consentPending && onboarding?.setup_complete && !sampleRecorded && config?.llm_provider === "local") {
      return (
        <div className="setup-strip" role="status">
          <div className="setup-strip-text">
            <strong>Your notes engine isn't set up yet.</strong>
            <span>Approve the install in Settings → AI Model whenever you're ready.</span>
          </div>
        </div>
      );
    }
    return null;
  }

  const statuses = downloadIds
    .map((id) => downloads[id])
    .filter((status): status is ModelDownloadStatus => Boolean(status));
  const total = statuses.reduce((sum, status) => sum + status.total_bytes, 0);
  const done = statuses.reduce(
    (sum, status) => sum + Math.min(status.downloaded_bytes, status.total_bytes),
    0,
  );
  const failed = statuses.find((status) => status.state === "error");
  const allReady =
    statuses.length === downloadIds.length &&
    statuses.every((status) => status.state === "ready");

  const retryDownloads = () => {
    downloadIds.forEach((id) => {
      if (downloads[id]?.state === "error") {
        startModelDownload(id).catch(() => {});
      }
    });
  };

  const retrySample = () => {
    sampleFired.current = false;
    setSampleError("");
    setSample("waiting");
  };

  return (
    <div className="setup-strip" role="status" aria-live="polite">
      {sample === "failed" ? (
        <>
          <div className="setup-strip-text">
            <strong>Your notes engine couldn't verify itself.</strong>
            <span>{sampleError}</span>
          </div>
          <button className="btn-secondary" onClick={retrySample}>Retry</button>
        </>
      ) : failed ? (
        <>
          <div className="setup-strip-text">
            <strong>{failed.detail}</strong>
            <span>{total > 0 ? `${formatGb(done)} / ${formatGb(total)}` : ""}</span>
          </div>
          <button className="btn-secondary" onClick={retryDownloads}>Retry</button>
        </>
      ) : sample === "passed" ? (
        <div className="setup-strip-text">
          <strong>✓ Your private engine is ready.</strong>
          <span>First meeting notes verified on this machine.</span>
        </div>
      ) : sample === "running" ? (
        <>
          <div className="setup-strip-text">
            <strong>Verifying your meeting-notes engine…</strong>
            <span>Runs once, on a built-in two-sentence sample.</span>
          </div>
          <progress />
        </>
      ) : (
        <>
          <div className="setup-strip-text">
            <strong>Setting up your private engine — you can already use Adversaria.</strong>
            <span>{total > 0 ? `${formatGb(done)} / ${formatGb(total)}` : "Preparing…"}</span>
          </div>
          {total > 0 && !allReady ? <progress value={done} max={total} /> : <progress />}
        </>
      )}
    </div>
  );
}
