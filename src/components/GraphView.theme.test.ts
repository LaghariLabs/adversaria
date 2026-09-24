import { describe, expect, it, vi } from "vitest";

vi.mock("cytoscape", () => ({ default: Object.assign(vi.fn(), { use: vi.fn() }) }));
vi.mock("cytoscape-d3-force", () => ({ default: vi.fn() }));

import {
  buildGraphStyle,
  readGraphTheme,
  DARK_GRAPH_COLORS,
  type GraphThemeColors,
} from "./GraphView";

const COLORS: GraphThemeColors = {
  label: "#111111",
  meetingLabel: "#222222",
  outline: "#333333",
  node: "#444444",
  edge: "#555555",
  highlight: "#666666",
};

function styleFor(styles: ReturnType<typeof buildGraphStyle>, selector: string) {
  const entry = (styles as { selector?: string; style?: Record<string, unknown> }[]).find(
    (s) => s.selector === selector,
  );
  expect(entry).toBeDefined();
  return entry!.style as Record<string, unknown>;
}

describe("buildGraphStyle", () => {
  it("puts each color in the right selector and property", () => {
    const styles = buildGraphStyle(COLORS);
    expect(styleFor(styles, "node").color).toBe("#111111");
    expect(styleFor(styles, "node")["text-outline-color"]).toBe("#333333");
    expect(styleFor(styles, "node")["background-color"]).toBe("#444444");
    expect(styleFor(styles, "node.meeting").color).toBe("#222222");
    expect(styleFor(styles, "edge")["line-color"]).toBe("#555555");
    expect(styleFor(styles, "node.highlighted")["border-color"]).toBe("#666666");
  });
});

describe("readGraphTheme", () => {
  it("reads values from CSS custom properties", () => {
    const el = document.createElement("div");
    el.style.setProperty("--text-secondary", "#111111");
    el.style.setProperty("--text-primary", "#222222");
    el.style.setProperty("--bg-primary", "#333333");
    el.style.setProperty("--text-muted", "#444444");
    const theme = readGraphTheme(el);
    expect(theme.label).toBe("#111111");
    expect(theme.meetingLabel).toBe("#222222");
    expect(theme.outline).toBe("#333333");
    expect(theme.node).toBe("#444444");
    expect(theme.edge).toBe("#444444");
    expect(theme.highlight).toBe("#222222");
  });

  it("falls back to dark colors for unset properties", () => {
    const el = document.createElement("div");
    const theme = readGraphTheme(el);
    expect(theme).toEqual(DARK_GRAPH_COLORS);
  });
});
