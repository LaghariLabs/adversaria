import { mockIPC } from "@tauri-apps/api/mocks";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { beginModelDownload } from "../lib/modelDownloads";
import { updateConfig } from "../lib/tauri";
import { appConfig } from "../test/fixtures";
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
        if (command === "get_config") return appConfig();
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

  it("trusts a ready transcriber over a stale failed download alias", async () => {
    let transcriberState = "missing";
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "check_service_health") {
        return {
          status: "ok",
          whisper_model: "large-v3-turbo",
          ollama_available: true,
          transcriber_state: transcriberState,
          transcriber_detail: "",
        };
      }
      if (command === "list_whisper_models") return WHISPER_MODELS;
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        return {
          ...status(id, id === "whisper-live" ? "error" : "idle"),
          detail: id === "whisper-live" ? "The model download was interrupted." : "",
        };
      }
      return null;
    });

    const { result } = renderHook(() => useTranscriptionSetup());
    await waitFor(() => expect(result.current.state).toBe("failed"));

    transcriberState = "ready";
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.detail).toBe("");
  });

  it("retires local-model failures as soon as self-hosted transcription is saved", async () => {
    const local = appConfig();
    mockIPC((command, payload) => {
      if (command === "get_config") return local;
      if (command === "update_config") return null;
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
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        return status(id, id === "whisper-main" ? "error" : "idle");
      }
      return null;
    });

    const { result } = renderHook(() => useTranscriptionSetup());
    await waitFor(() => expect(result.current.state).toBe("failed"));

    await act(async () => {
      await updateConfig(
        appConfig({
          transcription_provider: "self_hosted",
          transcription_base_url: "http://dgx.office.local:8000/v1",
        }),
      );
    });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.detail).toBe("");
  });
});
