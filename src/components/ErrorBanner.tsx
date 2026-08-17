import { useEffect, useState } from "react";

import {
  openPrivacySettings,
  PERMISSION_ERROR_PREFIX,
  probeSystemAudio,
} from "../lib/tauri";

interface ErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    setActionError("");
    setChecking(false);
  }, [message]);

  if (!message) return null;

  // A missing capture permission is actionable: open the exact macOS pane, then
  // run the real-audio check again. Give those actions alongside the message.
  const isPermission = message.startsWith(PERMISSION_ERROR_PREFIX);
  const text = isPermission
    ? message.slice(PERMISSION_ERROR_PREFIX.length).trim()
    : message;

  return (
    <div
      className="px-4 py-2 bg-red-100 border-b border-red-200 flex items-center justify-between gap-3"
      role="alert"
    >
      <span className={`text-sm text-red-800 mr-2 ${isPermission ? "" : "truncate"}`}>
        <span>{text}</span>
        {actionError && <span className="block text-xs mt-1">{actionError}</span>}
      </span>
      <span className="flex items-center gap-2 whitespace-nowrap">
        {isPermission && (
          <>
            <button
              onClick={() => {
                setActionError("");
                openPrivacySettings("system_audio").catch((error) => {
                  setActionError(String(error));
                });
              }}
              className="text-xs font-medium px-2 py-1 rounded bg-red-700 text-white hover:bg-red-800 transition-colors"
            >
              Open System Settings
            </button>
            <button
              disabled={checking}
              onClick={() => {
                setChecking(true);
                setActionError("");
                probeSystemAudio()
                  .then((permissions) => {
                    if (permissions.system_audio === "granted") {
                      onDismiss();
                    } else {
                      setActionError(
                        "The check still couldn't hear system audio. Unmute your Mac or enable Adversaria in System Settings, then check again.",
                      );
                    }
                  })
                  .catch((error) => setActionError(String(error)))
                  .finally(() => setChecking(false));
              }}
              className="text-xs font-medium px-2 py-1 rounded border border-red-700 text-red-800 hover:bg-red-200 transition-colors"
            >
              {checking ? "Listening…" : "Check again"}
            </button>
          </>
        )}
        <button
          onClick={onDismiss}
          className="text-red-700 hover:text-red-900 text-xs font-medium transition-colors"
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}
