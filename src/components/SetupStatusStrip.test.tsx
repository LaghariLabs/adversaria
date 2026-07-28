import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OnboardingState } from "../types";
import { appConfig } from "../test/fixtures";
import { SetupStatusStrip } from "./SetupStatusStrip";

const onboarding = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({
  schema_version: 1,
  completed_steps: ["registration", "permissions", "ready"],
  selected_model_profile: "qwen-4b-light",
  setup_complete: true,
  updated_at: "2026-07-28T10:00:00Z",
  ...overrides,
});

describe("SetupStatusStrip", () => {
  it("runs the sample verification exactly once when the engine turns ready, keeping setup_complete true", async () => {
    const calls: string[] = [];
    let current = onboarding();
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return current;
      if (command === "get_config") return appConfig({ llm_provider: "local" });
      if (command === "start_model_download" || command === "get_model_download_status") {
        const args = payload as { profileId?: string };
        return {
          profile_id: args.profileId ?? "",
          state: "ready",
          downloaded_bytes: 1,
          total_bytes: 1,
          detail: "",
          error_code: null,
          verified: true,
          can_retry: true,
        };
      }
      if (command === "start_managed_llm") {
        calls.push("start_managed_llm");
        return { state: "ready", profile_id: "qwen-4b-light", detail: "" };
      }
      if (command === "test_local_setup") {
        calls.push("test_local_setup");
        return "Launch checklist approved";
      }
      if (command === "complete_onboarding_step") {
        const args = payload as { step?: string; setupComplete?: boolean };
        calls.push(`complete:${args.step}`);
        // Regression guard: complete_step OVERWRITES setup_complete, so the
        // strip must pass true or it would resurrect the wizard.
        expect(args.setupComplete).toBe(true);
        current = { ...current, completed_steps: [...current.completed_steps, "sample"] };
        return current;
      }
      return null;
    });

    render(<SetupStatusStrip />);
    await waitFor(() =>
      expect(screen.getByText("✓ Your private engine is ready.")).toBeInTheDocument(),
    );
    expect(calls.filter((value) => value === "start_managed_llm")).toHaveLength(1);
    expect(calls.filter((value) => value === "test_local_setup")).toHaveLength(1);
    expect(calls).toContain("complete:sample");
  });

  it("renders nothing once the sample step is already recorded", async () => {
    mockIPC((command) => {
      if (command === "get_onboarding_state") {
        return onboarding({ completed_steps: ["registration", "permissions", "ready", "sample"] });
      }
      if (command === "get_config") return appConfig({ llm_provider: "local" });
      return null;
    });
    const { container } = render(<SetupStatusStrip />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders nothing during the wizard and for machines with no local profile", async () => {
    mockIPC((command) => {
      if (command === "get_onboarding_state") {
        return onboarding({ setup_complete: false, completed_steps: [] });
      }
      if (command === "get_config") return appConfig();
      return null;
    });
    const { container } = render(<SetupStatusStrip />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("surfaces a failed verification with a retry", async () => {
    let fail = true;
    mockIPC((command, payload) => {
      if (command === "get_onboarding_state") return onboarding();
      if (command === "get_config") return appConfig({ llm_provider: "local" });
      if (command === "start_model_download" || command === "get_model_download_status") {
        const args = payload as { profileId?: string };
        return {
          profile_id: args.profileId ?? "",
          state: "ready",
          downloaded_bytes: 1,
          total_bytes: 1,
          detail: "",
          error_code: null,
          verified: true,
          can_retry: true,
        };
      }
      if (command === "start_managed_llm") {
        if (fail) {
          fail = false;
          throw new Error("The local meeting model did not become ready.");
        }
        return { state: "ready", profile_id: "qwen-4b-light", detail: "" };
      }
      if (command === "test_local_setup") return "Launch checklist approved";
      if (command === "complete_onboarding_step") return onboarding({ completed_steps: ["ready", "sample"] });
      return null;
    });

    render(<SetupStatusStrip />);
    expect(
      await screen.findByText("Your notes engine couldn't verify itself."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("wizard copy", () => {
  it("keeps engine jargon out of the first-run screens", () => {
    // Placement names like Rapid-MLX belong in Settings' technical disclosures
    // and code identifiers, never in first-run copy (SETUP_REDESIGN_SPEC §B).
    const sources = ["Welcome.tsx", "SetupStatusStrip.tsx"].map((name) =>
      readFileSync(join(__dirname, name), "utf-8"),
    );
    for (const source of sources) {
      // Strings the user can see are the JSX text and quoted literals; comments
      // legitimately mention engine names, so strip them first.
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const term of ["MLX", "Rapid", "GGUF", "CTranslate2", "mlx-community/"]) {
        expect(withoutComments, `${term} leaked into first-run copy`).not.toContain(term);
      }
    }
  });
});
