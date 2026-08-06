import { describe, expect, it } from "vitest";

import { UNRECOVERABLE_PREFIX, isUnrecoverable } from "./recordingErrors";

describe("isUnrecoverable", () => {
  it("flags a spool whose index is gone, so no retry is offered", () => {
    // The real message a Windows user hit: the channel index was removed from the
    // recordings folder, so the encrypted audio can never be decoded.
    const real =
      "This recording can't be recovered — the index for its system audio is missing, " +
      "so the encrypted recording can no longer be read. Security software removing " +
      "files from the recordings folder is the usual cause.";
    expect(isUnrecoverable(real)).toBe(true);
  });

  it("leaves a genuinely retryable failure alone", () => {
    // The local AI service being down IS retryable — the audio is intact and the
    // queue will pick it up. Suppressing the retry here would lose a recording.
    for (const retryable of [
      "The local AI service isn't running. It restarts automatically — try again in a moment.",
      "Could not read system recording manifest: Permission denied (os error 13)",
      "Summarization failed: connection refused",
    ]) {
      expect(isUnrecoverable(retryable)).toBe(false);
    }
  });

  it("matches the phrase the Rust side actually emits", () => {
    // Both sides key off one phrase; if Rust's constant is edited without this
    // one, the retry promise silently comes back.
    expect(UNRECOVERABLE_PREFIX).toBe("This recording can't be recovered");
  });
});
