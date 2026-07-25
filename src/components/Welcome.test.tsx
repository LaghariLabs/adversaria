import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { OnboardingState, RegistrationState, SetupStatus } from "../types";
import { appConfig } from "../test/fixtures";
import { Welcome } from "./Welcome";

const registration = (status: RegistrationState["status"] = "unregistered"): RegistrationState => ({
  schema_version: 1,
  status,
  name: "",
  email: "",
  consent_version: status === "unregistered" ? "" : "beta-registration-v1",
  consent_timestamp: status === "unregistered" ? null : "2026-07-14T10:00:00Z",
  source: "desktop-beta",
  app_version: "0.3.41",
  platform: "macos",
  attempt_count: status === "pending" ? 1 : 0,
  next_retry_at: null,
  last_error: status === "pending" ? "Registration is queued." : null,
});

const onboarding = (completed_steps: string[] = [], setup_complete = false): OnboardingState => ({
  schema_version: 1,
  completed_steps,
  selected_model_profile: "",
  setup_complete,
  updated_at: "2026-07-14T10:00:00Z",
});

const setup = (installed = false): SetupStatus => ({
  schema_version: 1,
  platform: "macos",
  architecture: "aarch64",
  total_memory_bytes: 16_000_000_000,
  available_disk_bytes: 50_000_000_000,
  rapid_runtime_bundled: true,
  recommended_profile: "qwen-4b-light",
  profiles: [{
    id: "qwen-4b-light",
    display_name: "Qwen 4B — lighter and faster",
    model_alias: "qwen3.5-4b-4bit",
    model_repo: "mlx-community/Qwen3.5-4B-MLX-4bit",
    model_revision: "a".repeat(40),
    runtime: "rapid-mlx-pinned",
    minimum_memory_gb: 8,
    required_disk_gb: 5,
    quality_label: "Reduced quality",
    quality_note: "Fits smaller Macs.",
    installed,
    recommended: true,
  }],
});

describe("Welcome", () => {
  it("requires explicit consent and continues when registration is queued offline", async () => {
    let submitted = false;
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration();
      if (command === "get_setup_status") return setup();
      if (command === "get_onboarding_state") {
        return onboarding(submitted ? ["registration"] : []);
      }
      if (command === "submit_registration") {
        submitted = true;
        return registration("pending");
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);

    const submit = await screen.findByRole("button", { name: "Register and continue" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Name"), "Hamza");
    await user.type(screen.getByLabelText("Email"), "hamza@example.com");
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText("Choose where meeting notes are created")).toBeInTheDocument();
    expect(screen.getByText("Registration queued")).toBeInTheDocument();
    expect(screen.getByText(/Local setup can continue offline/)).toBeInTheDocument();
  });

  it("resumes at the first incomplete step and persists a verified local profile", async () => {
    let current = onboarding(["registration", "disclosure", "hardware"]);
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(true);
      if (command === "get_onboarding_state") return current;
      if (command === "complete_onboarding_step") {
        const args = payload as { step?: string; selectedModelProfile?: string };
        expect(args.step).toBe("model");
        expect(args.selectedModelProfile).toBe("qwen-4b-light");
        current = { ...current, completed_steps: [...current.completed_steps, "model"], selected_model_profile: "qwen-4b-light" };
        return current;
      }
      if (command === "start_model_download" || command === "get_model_download_status") {
        const args = payload as { profileId?: string };
        const id = args.profileId ?? "qwen-4b-light";
        return { profile_id: id, state: "ready", downloaded_bytes: 1, total_bytes: 1, detail: "", error_code: null, verified: true, can_retry: true };
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);
    expect(await screen.findByText("Install a local meeting model")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use this verified model" }));
    await waitFor(() => expect(screen.getByText("Recording permissions")).toBeInTheDocument());
  });

  it("does not show setup for a migrated existing user", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig({ beta_onboarded: true });
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(true);
      if (command === "get_onboarding_state") return onboarding([...STEP_NAMES], true);
      return null;
    });
    render(<Welcome />);
    await waitFor(() => expect(screen.queryByText("Welcome to Adversaria")).not.toBeInTheDocument());
  });

  it("does not flash setup while the backend is committing a legacy migration", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig({ beta_onboarded: true });
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(true);
      if (command === "get_onboarding_state") return onboarding();
      return null;
    });
    render(<Welcome />);
    await waitFor(() => expect(screen.queryByText("Welcome to Adversaria")).not.toBeInTheDocument());
  });
});

const STEP_NAMES = ["registration", "disclosure", "hardware", "model", "permissions", "sample", "capture"];
