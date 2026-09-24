import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { folderForNewRecording } from "./recordingFolder";

describe("folderForNewRecording", () => {
  it("returns the viewed folder id", () => {
    expect(folderForNewRecording(5)).toBe(5);
  });

  it("returns null when no folder is open", () => {
    expect(folderForNewRecording(null)).toBeNull();
  });

  it("App.tsx has no sticky-folder persistence", () => {
    const appPath = path.join(process.cwd(), "src", "App.tsx");
    const text = fs.readFileSync(appPath, "utf8");
    // Only allowed occurrence is the mount-only cleanup.
    const occurrences = text.split("copilot.lastFolderId").length - 1;
    const removeItemOccurrences = text.split('localStorage.removeItem("copilot.lastFolderId")').length - 1;
    expect(occurrences).toBe(removeItemOccurrences);
    expect(removeItemOccurrences).toBeGreaterThan(0);
    expect(text).not.toContain("start(recordingFolderIdRef.current)");
  });
});
