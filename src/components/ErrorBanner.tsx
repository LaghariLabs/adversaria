import { openPrivacySettings, relaunchForPermissions } from "../lib/tauri";
import { PERMISSION_ERROR_PREFIX } from "../lib/tauri";

interface ErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  if (!message) return null;

  // A missing capture permission is the one error the user can actually fix, and
  // it needs two specific steps (grant, then relaunch — macOS won't apply Screen
  // Recording until the app restarts). Give it buttons instead of prose.
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
        {text}
      </span>
      <span className="flex items-center gap-2 whitespace-nowrap">
        {isPermission && (
          <>
            <button
              onClick={() => {
                openPrivacySettings("screen").catch(() => {});
              }}
              className="text-xs font-medium px-2 py-1 rounded bg-red-700 text-white hover:bg-red-800 transition-colors"
            >
              Open Settings
            </button>
            <button
              onClick={() => {
                relaunchForPermissions().catch(() => {});
              }}
              className="text-xs font-medium px-2 py-1 rounded border border-red-700 text-red-800 hover:bg-red-200 transition-colors"
            >
              Relaunch
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
