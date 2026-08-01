import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OnboardingState } from "../types";
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

  it("keeps watching after an idle round — no session latch", async () => {
    // The old strip latched itself off the first time everything was idle, so a
    // download started later in Settings was invisible for the rest of the
    // session. Two things have to hold: it keeps polling on its own timer with
    // no dependency change to prod it, and it renders what that poll finds.
    const polled: string[] = [];
    let downloading = false;
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "list_whisper_models") return WHISPER_MODELS;
      if (command === "get_setup_status") return SETUP;
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

    // Nothing changes except time — no re-render, no new watched id. Only the
    // strip's own timer can find this download.
    downloading = true;
    expect(
      await screen.findByText(
        "Transcription model downloading — Adversaria stays usable.",
        undefined,
        { timeout: 8000 },
      ),
    ).toBeInTheDocument();
  }, 20000);

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
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
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
