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

describe("SetupStatusStrip", () => {
  it("shows the aggregate bar while a download is in flight, and only kicks whisper", async () => {
    const started: string[] = [];
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "start_model_download") {
        const args = payload as { profileId?: string };
        started.push(args.profileId ?? "");
        return status(args.profileId ?? "", "downloading");
      }
      if (command === "get_model_download_status") {
        const args = payload as { profileId?: string };
        return status(args.profileId ?? "", "downloading", 1_000_000_000, 3_000_000_000);
      }
      return null;
    });

    render(<SetupStatusStrip />);
    expect(
      await screen.findByText("Downloading in the background — Adversaria stays usable."),
    ).toBeInTheDocument();
    // SPEC v2: the strip resumes the whisper cache only; LLM downloads start
    // exclusively from an explicit click in Settings.
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((id) => id.startsWith("whisper-"))).toBe(true);
  });

  it("renders nothing when nothing is downloading", async () => {
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "start_model_download" || command === "get_model_download_status") {
        const args = payload as { profileId?: string };
        return status(args.profileId ?? "", "ready", 1, 1);
      }
      return null;
    });
    const { container } = render(<SetupStatusStrip />);
    // Give the first poll a tick, then confirm it stayed invisible.
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

  it("surfaces a failed download with a retry", async () => {
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "start_model_download") {
        const args = payload as { profileId?: string };
        return status(args.profileId ?? "", "downloading");
      }
      if (command === "get_model_download_status") {
        const args = payload as { profileId?: string };
        return args.profileId === "whisper-main"
          ? status("whisper-main", "error")
          : status(args.profileId ?? "", "ready", 1, 1);
      }
      return null;
    });

    render(<SetupStatusStrip />);
    expect(await screen.findByText("The model download was interrupted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("never runs sample verification or touches onboarding (SPEC v2)", async () => {
    const forbidden: string[] = [];
    mockIPC((command, payload) => {
      if (["start_managed_llm", "test_local_setup", "complete_onboarding_step"].includes(String(command))) {
        forbidden.push(String(command));
      }
      if (command === "get_onboarding_state") return onboarding();
      if (command === "start_model_download" || command === "get_model_download_status") {
        const args = payload as { profileId?: string };
        return status(args.profileId ?? "", "ready", 1, 1);
      }
      return null;
    });
    const { container } = render(<SetupStatusStrip />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(forbidden).toEqual([]);
  });
});

describe("first-run copy", () => {
  it("keeps engine jargon out of the wizard, strip, and tour", () => {
    // Placement names like Rapid-MLX belong in code identifiers and comments,
    // never in first-run copy (SETUP_REDESIGN_SPEC §B + v2 addendum).
    const sources = ["Welcome.tsx", "SetupStatusStrip.tsx", "GuidedTour.tsx"].map((name) =>
      readFileSync(join(__dirname, name), "utf-8"),
    );
    for (const source of sources) {
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const term of ["MLX", "Rapid", "GGUF", "CTranslate2", "mlx-community/"]) {
        expect(withoutComments, `${term} leaked into first-run copy`).not.toContain(term);
      }
    }
  });
});
