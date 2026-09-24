/**
 * One place to ask "which desktop OS is this?" from the UI.
 *
 * The webview's user agent is available synchronously in every window
 * (main app, recording pill, meeting-detected card), so it is the signal used
 * here. WebView2 on Windows reports "Windows NT"; WKWebView on macOS reports
 * "Macintosh". Rust's `setup.platform` (std::env::consts::OS) agrees with it,
 * but only arrives after an IPC round-trip.
 */

export type DesktopPlatform = "macos" | "windows" | "other";

export function detectPlatform(userAgent: string): DesktopPlatform {
  if (/windows/i.test(userAgent)) return "windows";
  if (/mac/i.test(userAgent)) return "macos";
  return "other";
}

const UA =
  typeof navigator !== "undefined" ? navigator.userAgent || navigator.platform || "" : "";

export const PLATFORM: DesktopPlatform = detectPlatform(UA);
export const IS_MAC = PLATFORM === "macos";
export const IS_WINDOWS = PLATFORM === "windows";

/** Platform-appropriate wording for UI copy. */
export interface PlatformCopy {
  /** "Mac" or "PC". */
  device: string;
  /** The record/stop global shortcut, as the user presses it. */
  recordShortcut: string;
  /** The OS settings app. */
  systemSettings: string;
  /** The file manager, for "Show in …" buttons. */
  fileManager: string;
  /** The OS credential store. */
  credentialStore: string;
  /** The OS biometric unlock. */
  biometric: string;
}

export function platformCopy(platform: DesktopPlatform): PlatformCopy {
  if (platform === "macos") {
    return {
      device: "Mac",
      recordShortcut: "⌘⇧M",
      systemSettings: "System Settings",
      fileManager: "Finder",
      credentialStore: "Keychain",
      biometric: "Touch ID",
    };
  }
  if (platform === "windows") {
    return {
      device: "PC",
      recordShortcut: "Ctrl+Shift+M",
      systemSettings: "Windows Settings",
      fileManager: "File Explorer",
      credentialStore: "Credential Manager",
      biometric: "Windows Hello",
    };
  }
  return {
    device: "computer",
    recordShortcut: "Ctrl+Shift+M",
    systemSettings: "system settings",
    fileManager: "file manager",
    credentialStore: "system keyring",
    biometric: "system authentication",
  };
}

/** Copy for the platform this UI is running on. */
export const COPY: PlatformCopy = platformCopy(PLATFORM);
