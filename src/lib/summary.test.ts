import { describe, expect, it } from "vitest";

import { parseSummary, splitDue } from "./summary";

// These mirror `split_due` / `action_item_tests` in src-tauri/src/storage.rs.
// The two parsers must agree, or the rendered note and the to-do row disagree.
describe("splitDue", () => {
  it("leaves a bullet without a due marker untouched", () => {
    expect(splitDue("Export the notes.")).toEqual({
      text: "Export the notes.",
      due: "",
    });
  });

  it("parses every accepted due spelling", () => {
    for (const marker of [
      "— due 2026-08-07",
      "– due 2026-08-07",
      "- due 2026-08-07",
      "- due: 2026-08-07",
      "(due 2026-08-07)",
      "(due: 2026-08-07)",
      "— Due 2026-08-07",
      "— due 2026-08-07.",
    ]) {
      expect(splitDue(`Export the notes ${marker}`), marker).toEqual({
        text: "Export the notes",
        due: "2026-08-07",
      });
    }
  });

  it("leaves malformed dates in the text", () => {
    for (const marker of [
      "— due 2026-13-45",
      "— due Friday",
      "— due 08/07/2026",
      "— due 2026-8-7",
      "— duedate 2026-08-07",
    ]) {
      const bullet = `Ship the build ${marker}`;
      expect(splitDue(bullet), marker).toEqual({ text: bullet, due: "" });
    }
  });
});

describe("parseSummary due handling", () => {
  it("strips the due marker from action bullets only", () => {
    const md = [
      "**Decisions Made**",
      "- We ship the beta — due 2026-08-07.",
      "**Action Items**",
      "- Hamza: Ship the beta — due 2026-08-09",
    ].join("\n");
    const { sections } = parseSummary(md);

    expect(sections[0].actionable).toBe(false);
    expect(sections[0].bullets).toEqual(["We ship the beta — due 2026-08-07."]);
    expect(sections[1].actionable).toBe(true);
    expect(sections[1].bullets).toEqual(["Hamza: Ship the beta"]);
  });

  it("keeps a TL;DR section as an ordinary non-actionable section", () => {
    const { sections } = parseSummary("**TL;DR**\n- The team agreed to ship.");
    expect(sections[0].heading).toBe("TL;DR");
    expect(sections[0].actionable).toBe(false);
    expect(sections[0].bullets).toEqual(["The team agreed to ship."]);
  });
});
