import { useEffect, useState } from "react";

import type { EngineInstallPlan } from "../types";
import { getEngineInstallPlan, installLocalEngine } from "../lib/tauri";

function formatSize(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;
}

interface EngineInstallCardProps {
  /** Called after a successful install so the parent can refresh SetupStatus. */
  onInstalled: () => void;
  /** Optional: what happens on "Not now" (the wizard continues; Settings hides the card). */
  onDismiss?: () => void;
}

/** The transparent-install consent card (SETUP_REDESIGN_SPEC §D).
 *
 * Sovereignty means the app never installs anything it hasn't named: this
 * card lists the exact engine build (version, size, SHA-256, source URL) and
 * the exact model file it will download, and nothing happens until the user
 * presses Install. Every value comes from pins compiled into the app and
 * shown in full before consent — auditable at install time regardless of
 * whether the source is published. */
export function EngineInstallCard({ onInstalled, onDismiss }: EngineInstallCardProps) {
  const [plan, setPlan] = useState<EngineInstallPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getEngineInstallPlan()
      .then(setPlan)
      .catch((e) => setError(String(e)));
  }, []);

  if (error && !plan) {
    return <p className="welcome-error" role="alert">{error}</p>;
  }
  if (!plan) return null;

  const install = async () => {
    setBusy(true);
    setError("");
    try {
      await installLocalEngine();
      onInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="engine-install-card" role="region" aria-label="Local engine install plan">
      <strong>Set up your local notes engine</strong>
      <p>
        Adversaria will install the following, verified against checksums
        pinned in the app — nothing else, and only when you press Install. Every
        version, size, source and hash is listed here before anything is
        downloaded:
      </p>
      <ul className="engine-install-list">
        <li>
          <strong>{plan.engine_name} {plan.engine_version}</strong> — {formatSize(plan.asset_size_bytes)}{" "}
          from <code>{plan.source_url}</code>
          <small>SHA-256 {plan.asset_sha256}</small>
        </li>
        <li>
          <strong>{plan.model_display_name}</strong> — {formatSize(plan.model_size_bytes)}{" "}
          from <code>{plan.model_repo}</code> (pinned revision <code>{plan.model_revision.slice(0, 12)}</code>)
          <small>SHA-256 {plan.model_sha256}</small>
        </li>
      </ul>
      <p className="engine-install-gpu">
        {plan.gpu
          ? `Detected GPU: ${plan.gpu} — the engine will use it.`
          : "No dedicated GPU detected — the engine runs on your processor."}
      </p>
      {error && <p className="welcome-error" role="alert">{error}</p>}
      <div className="welcome-actions">
        <button className="btn-primary" onClick={install} disabled={busy}>
          {busy ? "Installing engine…" : "Install"}
        </button>
        {onDismiss && (
          <button className="btn-secondary" onClick={onDismiss} disabled={busy}>
            Not now
          </button>
        )}
      </div>
    </div>
  );
}
