import { useEffect } from "react";

import type { AppTheme } from "../types";

const THEME_STORAGE_KEY = "adversaria-theme";
const EXPLICIT_THEMES = new Set<Exclude<AppTheme, "system">>([
  "dark",
  "light",
  "cream",
  "navy",
  "laghari",
]);

function isExplicitTheme(theme: string): theme is Exclude<AppTheme, "system"> {
  return EXPLICIT_THEMES.has(theme as Exclude<AppTheme, "system">);
}

function systemTheme(): "dark" | "light" {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = isExplicitTheme(theme)
    ? theme
    : theme === "system"
      ? systemTheme()
      : "dark";
}

// RecordingBubble is rendered in its own webview and does not mount App's hook.
// The shared-origin preference lets that window inherit the last selected theme
// as soon as this module is evaluated through App's eager import.
try {
  applyTheme(window.localStorage.getItem(THEME_STORAGE_KEY) ?? "dark");
} catch {
  applyTheme("dark");
}

export function useTheme(theme: string): void {
  useEffect(() => {
    const normalizedTheme = isExplicitTheme(theme) || theme === "system" ? theme : "dark";

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, normalizedTheme);
    } catch {
      // The root theme still applies when storage is unavailable.
    }

    if (normalizedTheme === "system") {
      const preference = window.matchMedia("(prefers-color-scheme: light)");
      const applySystemTheme = () => {
        document.documentElement.dataset.theme = preference.matches ? "light" : "dark";
      };

      applySystemTheme();
      preference.addEventListener("change", applySystemTheme);
      return () => preference.removeEventListener("change", applySystemTheme);
    }

    document.documentElement.dataset.theme = normalizedTheme;
  }, [theme]);
}
