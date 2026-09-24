import { describe, expect, it, vi, afterEach } from "vitest";
import { pendingMeeting } from "../test/fixtures";
import { buildSlideHtml, readExportTheme, type ExportTheme } from "./exportDocument";

function makeRoot(themeId: string, vars: Record<string, string> = {}): HTMLElement {
  const el = document.createElement("div");
  // Ensure it's attached so getComputedStyle works in jsdom for inline styles
  document.body.appendChild(el);
  el.dataset.theme = themeId;
  for (const [k, v] of Object.entries(vars)) {
    el.style.setProperty(k, v);
  }
  return el;
}

function lightTheme(): ExportTheme {
  return {
    id: "light",
    label: "Light",
    bg: "#f6f6f7",
    bgSecondary: "#efeff1",
    bgTertiary: "#ffffff",
    text: "#1a1a1f",
    textSecondary: "#494951",
    textMuted: "#6b6b74",
    accentBlue: "#007aff",
    accentPurple: "#7c3aed",
    accentGreen: "#1f9d4d",
    accentAmber: "#b45309",
    accentRed: "#d92d20",
    fontSans: "'Inter', sans-serif",
    fontSerif: "'Instrument Serif', serif",
    dark: false,
  };
}

function darkTheme(): ExportTheme {
  return {
    id: "dark",
    label: "Dark",
    bg: "#09090b",
    bgSecondary: "#121215",
    bgTertiary: "#1a1a1f",
    text: "#f4f4f5",
    textSecondary: "#a1a1aa",
    textMuted: "#71717a",
    accentBlue: "#007aff",
    accentPurple: "#af52de",
    accentGreen: "#34c759",
    accentAmber: "#ff9500",
    accentRed: "#ff3b30",
    fontSans: "'Inter', sans-serif",
    fontSerif: "'Instrument Serif', serif",
    dark: true,
  };
}

describe("readExportTheme", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("resolves data-theme laghari with computed variables to tokens", () => {
    const vars = {
      "--bg-primary": "#f2ebda",
      "--bg-secondary": "#e8dfc6",
      "--bg-tertiary": "#fbf6ea",
      "--text-primary": "#0e0e12",
      "--text-secondary": "#2b2730",
      "--text-muted": "#6b6470",
      "--accent-blue": "#3a86ff",
      "--accent-purple": "#b388ff",
      "--accent-green": "#06d6a0",
      "--accent-amber": "#c29500",
      "--accent-red": "#ff4d2e",
      "--font-sans": "\"IBM Plex Mono\", monospace",
      "--font-serif": "\"Pixelify Sans\", serif",
    };
    const root = makeRoot("laghari", vars);
    const theme = readExportTheme(root);
    expect(theme.id).toBe("laghari");
    expect(theme.label).toBe("Laghari Labs");
    expect(theme.bg).toBe("#f2ebda");
    expect(theme.accentBlue).toBe("#3a86ff");
    expect(theme.fontSans).toContain("IBM Plex Mono");
    root.remove();
  });

  it("falls back to dark defaults when variables are empty", () => {
    const root = makeRoot("dark", {});
    const theme = readExportTheme(root);
    expect(theme.bg).toBe("#09090b");
    expect(theme.accentBlue).toBe("#007aff");
    expect(theme.text).toBe("#f4f4f5");
    root.remove();
  });

  it("resolves system to light when matchMedia prefers light", () => {
    const orig = window.matchMedia;
    // @ts-ignore
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
    const root = makeRoot("system", {});
    const theme = readExportTheme(root);
    expect(theme.id).toBe("light");
    expect(theme.label).toBe("Light");
    root.remove();
    window.matchMedia = orig;
  });

  it("resolves system to dark when matchMedia prefers dark", () => {
    const orig = window.matchMedia;
    // @ts-ignore
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    const root = makeRoot("system", {});
    const theme = readExportTheme(root);
    expect(theme.id).toBe("dark");
    root.remove();
    window.matchMedia = orig;
  });

  it("unknown theme falls back to dark", () => {
    const root = makeRoot("unknown-theme", {});
    const theme = readExportTheme(root);
    expect(theme.id).toBe("dark");
    expect(theme.label).toBe("Dark");
    root.remove();
  });
});

describe("buildSlideHtml", () => {
  const meeting = pendingMeeting({
    id: 1,
    title: "Test Meeting",
    recorded_at: "2026-08-10T10:00:00Z",
    summary: "# Overview\nHello world\n## Decisions\n- [ ] Ship",
    attendees: ["Alice"],
  });

  it("light theme output contains light bg in body and @media print, meta theme, print button, and no leftover #060609", () => {
    const html = buildSlideHtml(meeting, lightTheme());
    // body background
    expect(html).toContain("background:#f6f6f7");
    // @media print background also light
    expect(html).toContain("@media print");
    // meta adversaria-theme
    expect(html).toContain('name="adversaria-theme" content="light"');
    // Print button
    expect(html).toContain("Print / Save as PDF");
    expect(html).toContain("window.print()");
    // No leftover dark hardcoded
    expect(html).not.toContain("#060609");
    // footer contains theme label
    expect(html).toContain("Laghari Labs · Light theme");
  });

  it("dark theme output still contains Instrument Serif embed and print color adjust", () => {
    const html = buildSlideHtml(meeting, darkTheme());
    expect(html).toContain("Instrument Serif");
    expect(html).toContain("data:font/ttf;base64");
    expect(html).toContain("-webkit-print-color-adjust: exact");
    expect(html).toContain("print-color-adjust: exact");
    // dark bg present
    expect(html).toContain("background:#09090b");
    expect(html).toContain('name="adversaria-theme" content="dark"');
    expect(html).toContain("Print / Save as PDF");
    // hidden under print
    expect(html).toContain(".adversaria-print-btn");
    expect(html).toContain("@media print");
  });
});
