import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const COPILOT_TOKEN =
  '--font-copilot: "Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("copilot font guard", () => {
  it("defines --font-copilot exactly once, in the base :root block only", () => {
    const css = read("src/index.css");

    // Exactly one definition in the whole file.
    const occurrences = css.split("--font-copilot:").length - 1;
    expect(occurrences).toBe(1);

    // The single definition is the exact token string.
    expect(css).toContain(COPILOT_TOKEN);

    // Everything from the first theme block on must not mention it.
    const themeStart = css.indexOf(":root[data-theme");
    expect(themeStart).toBeGreaterThan(-1);
    const base = css.slice(0, themeStart);
    const themed = css.slice(themeStart);
    expect(base).toContain(COPILOT_TOKEN);
    expect(themed).not.toContain("--font-copilot");
  });

  it("copilot stylesheets never use theme fonts", () => {
    for (const rel of [
      "src/styles/live-copilot.css",
      "src/styles/copilot-hud.css",
      "src/styles/copilot-history.css",
    ]) {
      const css = read(rel);
      expect(css, `${rel} must not use var(--font-sans)`).not.toContain("var(--font-sans)");
      expect(css, `${rel} must not use var(--font-serif)`).not.toContain("var(--font-serif)");
    }
  });
});
