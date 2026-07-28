import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";

import type { AppConfig } from "../../types";
import {
  exportAllMeetings,
  exportRedactedDiagnostics,
  exportSecondBrain,
  importAllMeetings,
} from "../../lib/tauri";
import { hashPin, verifyPin } from "../../lib/pin";

/** Where beta sign-up + feedback emails are addressed. */
const FEEDBACK_EMAIL = "mhlaghari@gmail.com";

interface PrivacyDataTabProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  /** Write a whole config to disk immediately (encryption + PIN take effect now). */
  persist: (next: AppConfig) => Promise<void>;
  appVersion: string;
}

/** Privacy & Data — the lock, the backups, the diagnostics, the vault export, and feedback. */
export function PrivacyDataTab({ active, config, update, persist, appVersion }: PrivacyDataTabProps) {
  // Encryption-at-rest toggle. Persisted immediately; the actual encrypt/decrypt
  // migration runs at the next startup (so it needs an app restart, like the
  // service-URL setting), surfaced via a restart note.
  const [encMsg, setEncMsg] = useState<string | null>(null);
  const handleEncryptToggle = async (enabled: boolean) => {
    try {
      await persist({ ...config, encrypt_db: enabled });
      setEncMsg(
        enabled
          ? "Database will be encrypted on next launch — restart the app to apply."
          : "Encryption will be turned off on next launch (database decrypted, keychain prompt removed) — restart the app to apply."
      );
    } catch (e) {
      setEncMsg(String(e));
    }
  };

  // --- Privacy PIN ---
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [pinCurrent, setPinCurrent] = useState("");
  const [pinMsg, setPinMsg] = useState<string | null>(null);

  const handleSetPin = async () => {
    setPinMsg(null);
    if (!/^\d{4,}$/.test(pin1)) {
      setPinMsg("PIN must be at least 4 digits.");
      return;
    }
    if (pin1 !== pin2) {
      setPinMsg("PINs do not match.");
      return;
    }
    try {
      const hash = await hashPin(pin1);
      await persist({ ...config, pin_hash: hash });
      setPin1("");
      setPin2("");
      setPinMsg("PIN set.");
      setTimeout(() => setPinMsg(null), 2000);
    } catch (e) {
      setPinMsg(String(e));
    }
  };

  const handleRemovePin = async () => {
    if (!config.pin_hash) return;
    setPinMsg(null);
    const ok = await verifyPin(pinCurrent, config.pin_hash);
    if (!ok) {
      setPinMsg("Wrong PIN.");
      return;
    }
    try {
      await persist({ ...config, pin_hash: null });
      setPinCurrent("");
      setPinMsg("PIN removed.");
      setTimeout(() => setPinMsg(null), 2000);
    } catch (e) {
      setPinMsg(String(e));
    }
  };

  // --- Data & backup ---
  const [dataMsg, setDataMsg] = useState<string | null>(null);
  const [dataBusy, setDataBusy] = useState(false);

  const handleDiagnosticExport = async () => {
    setDataBusy(true);
    setDataMsg(null);
    try {
      const path = await exportRedactedDiagnostics();
      setDataMsg(path ? "Redacted diagnostics exported." : "Export cancelled.");
    } catch (error) {
      setDataMsg(String(error));
    } finally {
      setDataBusy(false);
    }
  };

  // Feedback — opens the user's own mail client pre-addressed to the developer
  // with their typed message as the body. No backend; nothing is sent until they
  // hit send in their email app (privacy-clean).
  const [feedbackText, setFeedbackText] = useState("");
  const sendFeedback = () => {
    const subject = `Adversaria Feedback${appVersion ? ` (v${appVersion})` : ""}`;
    const body = feedbackText.trim();
    open(
      `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    );
  };

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Privacy &amp; Data</h3>
      <p className="settings-card-desc">
        Locks, backups, diagnostics, and where your notes can be mirrored — all of
        it on this machine.
      </p>

      {/* ---- Security & privacy lock ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Security &amp; Privacy Lock</h3>
      <p className="settings-card-desc">
        Encrypt the database on disk, and lock specific confidential meetings.
      </p>

      {/* Encryption at rest */}
      <div className="settings-form-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.encrypt_db}
            onChange={(e) => handleEncryptToggle(e.target.checked)}
          />
          Encrypt database at rest (recommended)
        </label>
        <p className="settings-help">
          Encrypts your meetings on disk (SQLCipher) with a key kept in your
          system keychain — protects your notes if this device is lost or stolen.
          Turning it off decrypts the database and removes the macOS keychain
          password prompt. Takes effect after an app restart.
        </p>
        {encMsg && <p className="settings-msg ok">{encMsg}</p>}
      </div>

      {config.pin_hash ? (
        <div className="settings-form-group">
          <label className="settings-label" htmlFor="settings-pin-current">
            A privacy PIN is set — enter it to remove
          </label>
          <div className="settings-row">
            <input
              id="settings-pin-current"
              type="password"
              inputMode="numeric"
              value={pinCurrent}
              onChange={(e) => setPinCurrent(e.target.value)}
              placeholder="current PIN"
              className="settings-input-text"
            />
            <button onClick={handleRemovePin} className="btn-danger">Remove PIN</button>
          </div>
        </div>
      ) : (
        <div className="settings-form-group">
          <label className="settings-label" htmlFor="settings-pin-new">Create Privacy PIN (4+ digits)</label>
          <div className="settings-row">
            <input
              id="settings-pin-new"
              type="password"
              inputMode="numeric"
              value={pin1}
              onChange={(e) => setPin1(e.target.value)}
              placeholder="new PIN"
              className="settings-input-text"
            />
            <input
              type="password"
              inputMode="numeric"
              value={pin2}
              onChange={(e) => setPin2(e.target.value)}
              placeholder="confirm"
              className="settings-input-text"
              aria-label="Confirm PIN"
            />
            <button onClick={handleSetPin} className="btn-primary">Set PIN</button>
          </div>
        </div>
      )}
      {pinMsg && (
        <p className={`settings-msg${pinMsg === "PIN set." || pinMsg === "PIN removed." ? " ok" : pinMsg.includes("Wrong") || pinMsg.includes("must") || pinMsg.includes("not match") ? " err" : ""}`}>
          {pinMsg}
        </p>
      )}
      <p className="settings-help">
        Lock individual meetings (shown with a lock in the list) to hide their content behind
        this PIN. The meeting database itself is encrypted on disk separately.
      </p>

      {/* Biometric unlock (Touch ID / Windows Hello) */}
      <div className="settings-form-group">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={config.biometric_unlock}
            onChange={(e) => update({ biometric_unlock: e.target.checked })}
          />
          Unlock locked meetings with Touch ID
        </label>
        <p className="settings-help">
          Use your fingerprint (Touch ID on Mac, Windows Hello on Windows) to open
          locked meetings, falling back to the PIN above if biometrics aren't available.
        </p>
      </div>

      {/* ---- Data & backup ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Data &amp; Backup</h3>
      <p className="settings-card-desc">
        Back up every meeting (notes, transcripts, action items) to a single
        file, or restore them on another machine. The backup is{" "}
        <strong>plaintext JSON</strong> — anyone who can read the file can read
        your notes, so store it somewhere safe.
      </p>
      <div className="settings-form-group">
        <div className="settings-row" style={{ gap: 10 }}>
          <button
            className="btn-primary"
            disabled={dataBusy}
            onClick={async () => {
              setDataBusy(true);
              setDataMsg(null);
              try {
                const path = await exportAllMeetings();
                if (path) setDataMsg(`Backed up to ${path}`);
              } catch (e) {
                setDataMsg(String(e));
              } finally {
                setDataBusy(false);
              }
            }}
          >
            {dataBusy ? "Working…" : "Back up all meetings…"}
          </button>
          <button
            className="btn-secondary"
            disabled={dataBusy}
            onClick={async () => {
              setDataBusy(true);
              setDataMsg(null);
              try {
                const count = await importAllMeetings();
                if (count !== null) setDataMsg(`Restored ${count} meeting${count === 1 ? "" : "s"}. Reopen Meetings to see them.`);
              } catch (e) {
                setDataMsg(String(e));
              } finally {
                setDataBusy(false);
              }
            }}
          >
            Restore from backup…
          </button>
        </div>
        {dataMsg && <p className="settings-help">{dataMsg}</p>}
      </div>

      <div className="settings-form-group">
        <h3 className="settings-card-title">Support diagnostics</h3>
        <p className="settings-card-desc">
          Export a small local lifecycle log only when you choose. Email addresses,
          filesystem paths, secrets, and meeting content are redacted; nothing is
          uploaded automatically.
        </p>
        <button className="btn-secondary" disabled={dataBusy} onClick={handleDiagnosticExport}>
          Export redacted diagnostics…
        </button>
      </div>

      {/* Second Brain export: mirror meetings into a local vault folder as
          markdown notes (wikilinks + OKF frontmatter) for Obsidian/graphify. */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Second Brain</h3>
      <p className="settings-card-desc">
        Mirror your meetings into a local folder as markdown notes with
        [[wikilinks]] — readable by Obsidian and your knowledge graph.
        Summaries only (never raw transcripts); locked meetings are never
        exported. Everything stays on this machine.
      </p>
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="second-brain-path">
          Vault folder
        </label>
        <input
          id="second-brain-path"
          className="settings-input-text"
          type="text"
          value={config.second_brain_path}
          onChange={(e) => update({ second_brain_path: e.target.value })}
          placeholder="/Users/you/vault/wiki/meetings"
        />
        <label className="checkbox-label" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={config.second_brain_enabled}
            onChange={(e) => update({ second_brain_enabled: e.target.checked })}
          />
          Auto-export after every meeting change
        </label>
        <p className="settings-help">
          Remember to Save Settings after changing these. Each export rewrites
          the notes, an index.md, and a graph.json in that folder.
        </p>
        <div className="settings-row" style={{ gap: 10, marginTop: 8 }}>
          <button
            className="btn-secondary"
            disabled={dataBusy || !config.second_brain_path.trim()}
            onClick={async () => {
              setDataBusy(true);
              setDataMsg(null);
              try {
                const count = await exportSecondBrain();
                setDataMsg(
                  `Exported ${count} meeting note${count === 1 ? "" : "s"} to ${config.second_brain_path.trim()}`,
                );
              } catch (e) {
                setDataMsg(String(e));
              } finally {
                setDataBusy(false);
              }
            }}
          >
            Export now
          </button>
        </div>
      </div>

      {/* ---- Feedback ---- */}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Feedback</h3>
      <p className="settings-card-desc">
        Found a bug or have an idea? Send it straight to the developer. This opens
        your email app with a message addressed to {FEEDBACK_EMAIL} — nothing is
        sent until you press send.
      </p>
      <div className="settings-form-group">
        <textarea
          className="settings-textarea"
          rows={6}
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
          placeholder="What's working, what's broken, what you'd love to see…"
        />
        <div className="settings-row" style={{ marginTop: 10 }}>
          <button onClick={sendFeedback} className="btn-primary">Send Feedback</button>
        </div>
        <p className="settings-help">Your message is included as the email body.</p>
      </div>
    </div>
  );
}
