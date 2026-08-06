import { useEffect, useRef, useState } from "react";

import type { AppConfig } from "../../types";
import { exportAllMeetings, importAllMeetings } from "../../lib/tauri";
import { hashPin, verifyPin } from "../../lib/pin";

interface PrivacyDataSectionProps {
  active: boolean;
  config: AppConfig;
  /** Deferred edits. Nothing in this section defers — every control here writes
   *  immediately — but the shell hands the same props to all eight sections. */
  update: (patch: Partial<AppConfig>) => void;
  /** Write a whole config to disk immediately (encryption, PIN and Touch ID take effect now). */
  persist: (next: AppConfig) => Promise<void>;
}

/** Privacy & data — the lock on your notes, and your own backup of them. */
export function PrivacyDataSection({ active, config, persist }: PrivacyDataSectionProps) {
  // Encryption-at-rest toggle. Persisted immediately; the actual encrypt/decrypt
  // migration runs at the next startup (the database is opened once when the app
  // launches), so it needs an app restart — surfaced via a restart note.
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

  // Only the two success messages auto-dismiss; errors stay until the next try.
  // The timer is tracked so it can be cancelled — untracked, it fired setState
  // 2s after the fact, which becomes a real bug the day sections unmount.
  const pinMsgTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pinMsgTimer.current !== null) window.clearTimeout(pinMsgTimer.current);
    },
    []
  );
  const flashPinMsg = (msg: string) => {
    setPinMsg(msg);
    if (pinMsgTimer.current !== null) window.clearTimeout(pinMsgTimer.current);
    pinMsgTimer.current = window.setTimeout(() => setPinMsg(null), 2000);
  };

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
      flashPinMsg("PIN set.");
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
      flashPinMsg("PIN removed.");
    } catch (e) {
      setPinMsg(String(e));
    }
  };

  // Touch ID was the odd one out: it deferred to the Save button while the three
  // controls beside it wrote immediately, so ticking it and closing Settings lost
  // it. Promoted to an immediate write on 2026-08-06 to match its neighbours.
  // The write can fail, so say so rather than leave the box looking switched on.
  const [bioMsg, setBioMsg] = useState<string | null>(null);
  const handleBiometricToggle = async (enabled: boolean) => {
    setBioMsg(null);
    try {
      await persist({ ...config, biometric_unlock: enabled });
    } catch (e) {
      setBioMsg(String(e));
    }
  };

  // --- Back up & restore --- one busy/message pair for these two buttons.
  const [dataMsg, setDataMsg] = useState<string | null>(null);
  const [dataBusy, setDataBusy] = useState(false);

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Privacy &amp; data</h3>
      <p className="settings-card-desc">
        Lock your notes on this machine, and keep your own backup of them.
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
            onChange={(e) => handleBiometricToggle(e.target.checked)}
          />
          Unlock locked meetings with Touch ID
        </label>
        <p className="settings-help">
          Use your fingerprint (Touch ID on Mac, Windows Hello on Windows) to open
          locked meetings, falling back to the PIN above if biometrics aren't available.
        </p>
        {bioMsg && <p className="settings-msg err">{bioMsg}</p>}
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
    </div>
  );
}
