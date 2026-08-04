import { mockIPC } from "@tauri-apps/api/mocks";
import { describe, expect, it } from "vitest";

import { beginModelDownload, onModelDownloadStarted } from "./modelDownloads";

const status = (id: string, state: string) => ({
  profile_id: id,
  state,
  downloaded_bytes: 0,
  total_bytes: 0,
  detail: "",
  error_code: null,
  verified: false,
  can_retry: true,
});

describe("model download start bus", () => {
  it("notifies subscribers synchronously and resolves with the backend status", async () => {
    mockIPC((command, payload) => {
      if (command === "start_model_download") {
        return status((payload as { profileId?: string }).profileId ?? "", "downloading");
      }
      return null;
    });
    const seen: string[] = [];
    const unsubscribe = onModelDownloadStarted((id) => seen.push(id));

    const promise = beginModelDownload("whisper-main");
    // Synchronous: the wake signal must not wait on the backend round-trip.
    expect(seen).toEqual(["whisper-main"]);
    await expect(promise).resolves.toMatchObject({
      profile_id: "whisper-main",
      state: "downloading",
    });
    unsubscribe();
  });

  it("still notifies when the backend call fails, and the caller sees the rejection", async () => {
    mockIPC(() => {
      throw new Error("service offline");
    });
    const seen: string[] = [];
    const unsubscribe = onModelDownloadStarted((id) => seen.push(id));

    const promise = beginModelDownload("whisper-live");
    // A poll that finds nothing running is cheap; a poller that never wakes is the bug.
    expect(seen).toEqual(["whisper-live"]);
    await expect(promise).rejects.toThrowError("service offline");
    unsubscribe();
  });

  it("pings again once the backend settles, so a poll can't race the start", async () => {
    mockIPC((command, payload) => {
      if (command === "start_model_download") {
        return status((payload as { profileId?: string }).profileId ?? "", "downloading");
      }
      return null;
    });
    const seen: string[] = [];
    const unsubscribe = onModelDownloadStarted((id) => seen.push(id));

    await beginModelDownload("whisper-main");
    await Promise.resolve(); // drain the settle ping's chained microtask
    await Promise.resolve();
    // The early ping can land before the backend registered the download; the
    // settle ping guarantees one poll AFTER registration.
    expect(seen).toEqual(["whisper-main", "whisper-main"]);
    unsubscribe();
  });

  it("pings again after a failed start, so the error surfaces without waiting a heartbeat", async () => {
    mockIPC(() => {
      throw new Error("service offline");
    });
    const seen: string[] = [];
    const unsubscribe = onModelDownloadStarted((id) => seen.push(id));

    await expect(beginModelDownload("whisper-live")).rejects.toThrowError();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["whisper-live", "whisper-live"]);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", async () => {
    mockIPC((command, payload) => {
      if (command === "start_model_download") {
        return status((payload as { profileId?: string }).profileId ?? "", "downloading");
      }
      return null;
    });
    const seen: string[] = [];
    const unsubscribe = onModelDownloadStarted((id) => seen.push(id));

    await beginModelDownload("whisper-main");
    unsubscribe();
    await beginModelDownload("whisper-live");
    expect(seen).toEqual(["whisper-main"]);
  });
});
