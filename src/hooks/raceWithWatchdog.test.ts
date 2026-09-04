import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { raceWithWatchdog } from "./useRecording";

describe("raceWithWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through a resolved value and clears the watchdog timer", async () => {
    await expect(
      raceWithWatchdog(Promise.resolve("transcribed"), 1_000, "timed out"),
    ).resolves.toBe("transcribed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the given message after the timeout", async () => {
    const result = raceWithWatchdog(
      new Promise<never>(() => undefined),
      1_000,
      "background transcription timed out",
    );
    const rejection = expect(result).rejects.toThrow(
      "background transcription timed out",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
  });

  it("does not leave an unhandled rejection when the real promise rejects late", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    try {
      const realPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("late service rejection")), 2_000);
      });
      const result = raceWithWatchdog(realPromise, 1_000, "watchdog fired");
      const rejection = result.catch((error: unknown) => error);

      vi.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      await expect(rejection).resolves.toEqual(new Error("watchdog fired"));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });
});
