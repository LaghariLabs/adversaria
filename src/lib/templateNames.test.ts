import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { templateDisplayName } from "./templateNames";

const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("templateDisplayName", () => {
  it("uses the curated label for every bundled template", () => {
    expect(templateDisplayName("general")).toBe("General");
    expect(templateDisplayName("one-on-one")).toBe("One-on-one");
    expect(templateDisplayName("client-meeting")).toBe("Client meeting");
    expect(templateDisplayName("brainstorm")).toBe("Brainstorm");
    expect(templateDisplayName("interview")).toBe("Interview");
    expect(templateDisplayName("detailed")).toBe("Detailed");
    expect(templateDisplayName("youtube")).toBe("YouTube");
    expect(templateDisplayName("note")).toBe("Note");
    expect(templateDisplayName("brain-dump")).toBe("Brain dump");
  });

  it("prettifies a custom slug the user saved themselves", () => {
    expect(templateDisplayName("q3-planning")).toBe("Q3 planning");
    expect(templateDisplayName("weekly_stand_up")).toBe("Weekly stand up");
  });

  it("returns odd input unchanged instead of crashing", () => {
    expect(templateDisplayName("")).toBe("");
    expect(templateDisplayName("---")).toBe("---");
  });

  it("leaves a name that already has spaces alone apart from the capital", () => {
    expect(templateDisplayName("client meeting")).toBe("Client meeting");
    expect(templateDisplayName("Client meeting")).toBe("Client meeting");
  });

  it("is display-only — option values stay the raw slug", () => {
    // The slug is the API key (the sidecar validates it as a path-safe name),
    // so the formatter must never reach a `value=` or a backend call.
    for (const file of [
      "../components/settings/NotesSection.tsx",
      "../components/NoteViewer.tsx",
    ]) {
      const text = source(file);
      expect(text).toContain("templateDisplayName");
      expect(text).not.toMatch(/value=\{[^}]*templateDisplayName/);
    }
    expect(source("../components/settings/NotesSection.tsx")).toContain(
      "value={t.name}",
    );
    expect(source("../components/NoteViewer.tsx")).toContain("value={name}");
  });
});
