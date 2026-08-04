import { mockIPC } from "@tauri-apps/api/mocks";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { beginModelDownload } from "../lib/modelDownloads";
import { useTranscriptionSetup } from "./useTranscriptionSetup";

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

const WHISPER_MODELS = [
  { key: "large-v3-turbo", label: "Large v3 turbo", size: "1.6 GB", downloaded: false },
];

describe("useTranscriptionSetup download cadence", () => {
  it("idles at the slow poll and wakes instantly on the start event", async () => {
    vi.useFakeTimers();
    try {
      const downloadPolls: string[] = [];
      let downloading = false;
      mockIPC((command, payload) => {
        if (command === "check_service_health") {
          return {
            status: "ok",
            whisper_model: "large-v3-turbo",
            ollama_available: true,
            transcriber_state: "missing",
            transcriber_detail: "No transcription model on this machine yet.",
          };
        }
        if (command === "list_whisper_models") return WHISPER_MODELS;
        if (command === "start_model_download") {
          downloading = true;
          return status("whisper-model:large-v3-turbo", "downloading");
        }
        if (command === "get_model_download_status") {
          const id = (payload as { profileId?: string }).profileId ?? "";
          downloadPolls.push(id);
          return status(
            id,
            downloading && id === "whisper-model:large-v3-turbo" ? "downloading" : "idle",
          );
        }
        return null;
      });

      const { result } = renderHook(() => useTranscriptionSetup());
      // Flush the mount chain (health → catalogue → first poll) without
      // moving the clock.
      for (let i = 0; i < 8; i++) await act(async () => {});
      expect(result.current.state).toBe("missing");

      // Nothing in flight → no 1 s cadence; nothing polled before the 5 s tick…
      downloadPolls.length = 0;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_500);
      });
      expect(downloadPolls).toEqual([]);
      // …but the idle tick itself still polls (safety net).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(downloadPolls.length).toBeGreaterThan(0);

      // A start announced on the bus is picked up with no timer at all.
      downloadPolls.length = 0;
      await act(async () => {
        await beginModelDownload("whisper-model:large-v3-turbo");
      });
      expect(downloadPolls.length).toBeGreaterThan(0);
      expect(result.current.state).toBe("downloading");
    } finally {
      vi.useRealTimers();
    }
  });
});
