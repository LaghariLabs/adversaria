import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase = "available" | "downloading" | "installing" | "error";

/** An always-running app misses launch-only checks for days — re-check on a slow cadence. */
export const RECHECK_MS = 6 * 60 * 60 * 1000;

interface UpdatePromptProps {
  enabled?: boolean;
  checkForUpdate?: typeof check;
  relaunchApp?: typeof relaunch;
}

/**
 * Auto-update prompt. On launch (production builds only) it quietly checks the
 * release endpoint, then re-checks every 6 hours until an update is found; if a
 * newer signed version exists it shows a small toast with the version + release
 * notes and an Install button that downloads, installs, and relaunches. Any
 * failure to check (dev build, offline, no release yet) is silent.
 */
export function UpdatePrompt({
  enabled = import.meta.env.PROD,
  checkForUpdate = check,
  relaunchApp = relaunch,
}: UpdatePromptProps = {}) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("available");
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Only the packaged app has a signing key + endpoint; skip in `tauri dev`.
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopRechecking = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const runCheck = async () => {
      try {
        const u = await checkForUpdate();
        if (!cancelled && u) {
          setUpdate(u);
          // The toast is up — nothing to gain from checking again.
          stopRechecking();
        }
      } catch {
        // No endpoint / offline / no release yet — silently ignore.
      }
    };
    void runCheck();
    timer = setInterval(() => void runCheck(), RECHECK_MS);
    return () => {
      cancelled = true;
      stopRechecking();
    };
  }, [checkForUpdate, enabled]);

  if (!update || dismissed) return null;

  const install = async () => {
    setErr(null);
    setPhase("downloading");
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
        } else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total > 0) setPct(Math.round((got / total) * 100));
        } else if (e.event === "Finished") {
          setPhase("installing");
        }
      });
      await relaunchApp();
    } catch (e) {
      setErr(String(e));
      setPhase("error");
    }
  };

  return (
    <div className="update-toast">
      <div className="update-toast-title">
        {phase === "error"
          ? "Update failed"
          : `Update available — v${update.version}`}
      </div>
      {phase === "available" && update.body ? (
        <div className="update-toast-notes">{update.body}</div>
      ) : null}
      {phase === "downloading" ? (
        <div className="update-toast-notes">Downloading… {pct}%</div>
      ) : null}
      {phase === "installing" ? (
        <div className="update-toast-notes">Installing & restarting…</div>
      ) : null}
      {phase === "error" && err ? (
        <div className="update-toast-notes update-toast-err">{err}</div>
      ) : null}
      {phase === "available" || phase === "error" ? (
        <div className="update-toast-actions">
          <button className="btn-primary" onClick={install}>
            {phase === "error" ? "Retry" : "Install & Restart"}
          </button>
          <button className="btn-ghost" onClick={() => setDismissed(true)}>
            Later
          </button>
        </div>
      ) : null}
    </div>
  );
}
