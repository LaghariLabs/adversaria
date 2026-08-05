import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OnboardingState } from "../types";
import { beginModelDownload } from "../lib/modelDownloads";
import { updateConfig } from "../lib/tauri";
import { appConfig } from "../test/fixtures";
import { SetupStatusStrip } from "./SetupStatusStrip";

const onboarding = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({
  schema_version: 1,
  completed_steps: ["registration", "permissions", "ready"],
  selected_model_profile: "",
  setup_complete: true,
  updated_at: "2026-07-28T10:00:00Z",
  ...overrides,
});

const status = (id: string, state: string, downloaded = 0, total = 0) => ({
  profile_id: id,
  state,
  downloaded_bytes: downloaded,
  total_bytes: total,
  detail: state === "error" ? "The model download was interrupted." : "",
  error_code: state === "error" ? "network" : null,
  verified: state === "ready",
  can_retry: true,
});

const WHISPER_MODELS = [
  { key: "large-v3-turbo", label: "Large v3 turbo", size: "1.6 GB", downloaded: false },
];

const SETUP = {
  schema_version: 1,
  platform: "macos",
  architecture: "aarch64",
  total_memory_bytes: 32_000_000_000,
  available_disk_bytes: 400_000_000_000,
  rapid_runtime_bundled: true,
  recommended_profile: "qwen-9b-balanced",
  profiles: [],
};

describe("SetupStatusStrip", () => {
  it("names what is downloading, with byte progress, and starts nothing itself", async () => {
    const started: string[] = [];
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "list_whisper_models") return WHISPER_MODELS;
      if (command === "get_setup_status") return SETUP;
      if (command === "start_model_download") {
        started.push((payload as { profileId?: string }).profileId ?? "");
        return status("", "downloading");
      }
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        return id === "whisper-model:large-v3-turbo"
          ? status(id, "downloading", 1_200_000_000, 1_600_000_000)
          : status(id, "idle");
      }
      return null;
    });

    render(<SetupStatusStrip />);
    // Named, not "Downloading in the background" — the user knows what they wait for.
    expect(
      await screen.findByText("Transcription model downloading — Adversaria stays usable."),
    ).toBeInTheDocument();
    expect(screen.getByText("1.2 GB of 1.6 GB")).toBeInTheDocument();
    // SPEC V3: nothing downloads unless the user asked for it.
    expect(started).toEqual([]);
  });

  it("renders nothing when nothing is downloading", async () => {
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "list_whisper_models") return WHISPER_MODELS;
      if (command === "get_setup_status") return SETUP;
      if (command === "get_model_download_status") {
        return status((payload as { profileId?: string }).profileId ?? "", "ready", 1, 1);
      }
      return null;
    });
    const { container } = render(<SetupStatusStrip />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders nothing during the wizard", async () => {
    mockIPC((command) => {
      if (command === "get_onboarding_state") {
        return onboarding({ setup_complete: false, completed_steps: [] });
      }
      return null;
    });
    const { container } = render(<SetupStatusStrip />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("wakes instantly when a download starts anywhere in the app", async () => {
    // The strip no longer discovers work by fast-polling: every UI path starts
    // downloads through beginModelDownload, whose bus event makes the strip
    // poll NOW — no timer has to fire, and no session latch can blind it.
    const polled: string[] = [];
    let downloading = false;
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "list_whisper_models") return WHISPER_MODELS;
      if (command === "get_setup_status") return SETUP;
      if (command === "start_model_download") {
        downloading = true;
        return status("whisper-model:large-v3-turbo", "downloading");
      }
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        polled.push(id);
        if (downloading && id === "whisper-model:large-v3-turbo") {
          return status(id, "downloading", 500_000_000, 1_600_000_000);
        }
        return status(id, "idle");
      }
      return null;
    });

    const { container } = render(<SetupStatusStrip />);
    // Everything idle → invisible, and the watched set is fully loaded.
    await waitFor(() => expect(polled).toContain("whisper-model:large-v3-turbo"));
    await waitFor(() => expect(container).toBeEmptyDOMElement());

    // Settings starts a download through the shared entry point — the strip
    // notices well inside findByText's 1 s default, not on a poll cadence.
    await beginModelDownload("whisper-model:large-v3-turbo");
    expect(
      await screen.findByText("Transcription model downloading — Adversaria stays usable."),
    ).toBeInTheDocument();
  });

  it("the slow idle heartbeat still catches a download nothing announced", async () => {
    // Safety net for downloads no UI action started (e.g. resumed by the
    // backend): the strip must find them on its own — just slowly, because the
    // 4 s idle cadence was 96% of the sidecar log on every installed copy.
    vi.useFakeTimers();
    try {
      let downloading = false;
      mockIPC((command, payload) => {
        if (command === "get_onboarding_state") return onboarding();
        if (command === "list_whisper_models") return WHISPER_MODELS;
        if (command === "get_setup_status") return SETUP;
        if (command === "get_model_download_status") {
          const id = (payload as { profileId?: string }).profileId ?? "";
          if (downloading && id === "whisper-model:large-v3-turbo") {
            return status(id, "downloading", 500_000_000, 1_600_000_000);
          }
          return status(id, "idle");
        }
        return null;
      });

      render(<SetupStatusStrip />);
      // Flush the mount chain (onboarding → catalogue → first poll) without
      // moving the clock.
      for (let i = 0; i < 8; i++) await act(async () => {});

      downloading = true;
      // Just short of the heartbeat: the strip is still idle-blind…
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_000);
      });
      expect(
        screen.queryByText("Transcription model downloading — Adversaria stays usable."),
      ).not.toBeInTheDocument();
      // …and the 60 s tick finds it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(
        screen.getByText("Transcription model downloading — Adversaria stays usable."),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a failed download with the human reason and a retry", async () => {
    const retried: string[] = [];
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "list_whisper_models") return WHISPER_MODELS;
      if (command === "get_setup_status") return SETUP;
      if (command === "start_model_download") {
        retried.push((payload as { profileId?: string }).profileId ?? "");
        return status("", "downloading");
      }
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        return id === "whisper-main" ? status(id, "error") : status(id, "ready", 1, 1);
      }
      return null;
    });

    render(<SetupStatusStrip />);
    expect(await screen.findByText("The model download was interrupted.")).toBeInTheDocument();
    expect(screen.getByText("Transcription model — download failed")).toBeInTheDocument();
    // Retry goes through the shared beginModelDownload entry point → backend.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(retried).toEqual(["whisper-main"]));
  });

  it("clears an irrelevant local transcription failure after switching to self-hosted", async () => {
    const local = appConfig();
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "get_config") return local;
      if (command === "update_config") return null;
      if (command === "list_whisper_models") return WHISPER_MODELS;
      if (command === "get_setup_status") return SETUP;
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        return id === "whisper-main" ? status(id, "error") : status(id, "ready", 1, 1);
      }
      return null;
    });

    const { container } = render(<SetupStatusStrip />);
    expect(await screen.findByText("Transcription model — download failed")).toBeInTheDocument();

    await act(async () => {
      await updateConfig(
        appConfig({
          transcription_provider: "self_hosted",
          transcription_base_url: "http://dgx.office.local:8000/v1",
        }),
      );
    });
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("never runs sample verification or touches onboarding (SPEC v2)", async () => {
    const forbidden: string[] = [];
    mockIPC((command, payload) => {
      if (["start_managed_llm", "test_local_setup", "complete_onboarding_step"].includes(String(command))) {
        forbidden.push(String(command));
      }
      if (command === "get_onboarding_state") return onboarding();
      if (command === "list_whisper_models") return WHISPER_MODELS;
      if (command === "get_setup_status") return SETUP;
      if (command === "get_model_download_status") {
        return status((payload as { profileId?: string }).profileId ?? "", "ready", 1, 1);
      }
      return null;
    });
    const { container } = render(<SetupStatusStrip />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(forbidden).toEqual([]);
  });
});

describe("first-run copy", () => {
  it("keeps engine jargon out of the wizard, strip, chip, and tour", () => {
    // Placement names like Rapid-MLX belong in code identifiers and comments,
    // never in first-run copy (SETUP_REDESIGN_SPEC §B + v2/V3 addenda).
    const sources = [
      "Welcome.tsx",
      "SetupStatusStrip.tsx",
      "GuidedTour.tsx",
      "TranscriptionSetupChip.tsx",
    ].map((name) => readFileSync(join(__dirname, name), "utf-8"));
    for (const source of sources) {
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const term of ["MLX", "Rapid", "GGUF", "CTranslate2", "Ollama", "mlx-community/"]) {
        expect(withoutComments, `${term} leaked into first-run copy`).not.toContain(term);
      }
    }
  });
});
