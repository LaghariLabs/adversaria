import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { OnboardingState, RegistrationState, SetupStatus } from "../types";
import { appConfig } from "../test/fixtures";
import { Welcome, resolveProfile, resolveScreen } from "./Welcome";

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

const setup = (installed = false, platform = "macos"): SetupStatus => ({
  schema_version: 1,
  platform,
  architecture: platform === "macos" ? "aarch64" : "x86_64",
  total_memory_bytes: 16_000_000_000,
  available_disk_bytes: 50_000_000_000,
  rapid_runtime_bundled: platform === "macos",
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

const downloadStatus = (id: string) => ({
  profile_id: id,
  state: "ready",
  downloaded_bytes: 1,
  total_bytes: 1,
  detail: "",
  error_code: null,
  verified: true,
  can_retry: true,
});

describe("Welcome", () => {
  it("requires explicit consent, then lands on permissions after registering", async () => {
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
      if (command === "start_model_download" || command === "get_model_download_status") {
        return downloadStatus("whisper-main");
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

    expect(await screen.findByText("Recording permissions")).toBeInTheDocument();
    expect(screen.getByText("Registration queued")).toBeInTheDocument();
    expect(screen.getByText(/Local setup can continue offline/)).toBeInTheDocument();
  });

  it("resumes a legacy 7-step wizard on Ready and persists profile + completion", async () => {
    // A user who finished everything except the old sample/capture steps must
    // NOT restart setup — they land on Ready and finish in one click.
    let current: OnboardingState = {
      ...onboarding(["registration", "disclosure", "hardware", "model", "permissions"]),
      selected_model_profile: "qwen-4b-light",
    };
    let savedReminder: boolean | null = null;
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(true);
      if (command === "get_onboarding_state") return current;
      if (command === "update_config") {
        const args = payload as { config?: { meeting_reminder_enabled?: boolean } };
        savedReminder = args.config?.meeting_reminder_enabled ?? null;
        return null;
      }
      if (command === "complete_onboarding_step") {
        const args = payload as { step?: string; selectedModelProfile?: string | null; setupComplete?: boolean };
        expect(args.step).toBe("ready");
        expect(args.selectedModelProfile).toBe("qwen-4b-light");
        expect(args.setupComplete).toBe(true);
        current = {
          ...current,
          completed_steps: [...current.completed_steps, "ready"],
          setup_complete: true,
        };
        return current;
      }
      if (command === "start_model_download" || command === "get_model_download_status") {
        const args = payload as { profileId?: string };
        return downloadStatus(args.profileId ?? "qwen-4b-light");
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);
    expect(await screen.findByText("You're ready")).toBeInTheDocument();
    // The pre-meeting notification question lives HERE, not buried in
    // Settings; it defaults on and persists when setup finishes.
    expect(screen.getByRole("checkbox")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Start using Adversaria" }));
    await waitFor(() => expect(screen.queryByText("You're ready")).not.toBeInTheDocument());
    expect(savedReminder).toBe(true);
  });

  it("skips the permissions screen on Windows", async () => {
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false, "windows");
      if (command === "get_onboarding_state") return onboarding(["registration"]);
      if (command === "start_model_download" || command === "get_model_download_status") {
        const args = payload as { profileId?: string };
        return downloadStatus(args.profileId ?? "whisper-main");
      }
      return null;
    });

    render(<Welcome />);
    expect(await screen.findByText("You're ready")).toBeInTheDocument();
    expect(screen.queryByText("Recording permissions")).not.toBeInTheDocument();
    // Two visible steps on Windows, and this is the last of them.
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("does not show setup for a migrated existing user", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig({ beta_onboarded: true });
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(true);
      if (command === "get_onboarding_state") return onboarding([...LEGACY_STEP_NAMES, "ready"], true);
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

const LEGACY_STEP_NAMES = ["registration", "disclosure", "hardware", "model", "permissions", "sample", "capture"];

describe("resolveScreen", () => {
  it("starts an empty row on registration", () => {
    expect(resolveScreen([], "macos")).toBe("registration");
  });

  it("maps a legacy mid-wizard row onto the first missing new screen", () => {
    // Completed registration + disclosure + hardware on the 7-step wizard.
    expect(resolveScreen(["registration", "disclosure", "hardware"], "macos")).toBe("permissions");
    // Past permissions (old step 5) — everything else folded into Ready.
    expect(
      resolveScreen(["registration", "disclosure", "hardware", "model", "permissions"], "macos"),
    ).toBe("ready");
    // Old "step 6/7" stall state: all but sample/capture.
    expect(
      resolveScreen(["registration", "disclosure", "hardware", "model", "permissions", "sample"], "macos"),
    ).toBe("ready");
  });

  it("never shows permissions on Windows", () => {
    expect(resolveScreen(["registration"], "windows")).toBe("ready");
  });
});

describe("resolveProfile", () => {
  const withProfiles = (ids: string[], recommended: string): SetupStatus => ({
    ...setup(),
    recommended_profile: recommended,
    profiles: ids.map((id) => ({ ...setup().profiles[0], id })),
  });

  it("keeps a persisted choice this machine still offers", () => {
    const status = withProfiles(["ollama:qwen3:8b", "ollama:llama3.1:8b"], "ollama:qwen3:8b");
    expect(resolveProfile("ollama:llama3.1:8b", status)).toBe("ollama:llama3.1:8b");
  });

  it("drops a profile this machine no longer offers", () => {
    // Regression: onboarding persists the model choice, so an MLX id picked on a
    // build that offered MLX profiles was replayed on every resume — handed to
    // the managed-runtime start, which fails with "Managed Rapid-MLX is
    // currently available on Apple Silicon only" and strands setup on step 6/7.
    const status = withProfiles(["ollama:qwen3.6:35b-a3b"], "ollama:qwen3.6:35b-a3b");
    expect(resolveProfile("qwen-27b-quality", status)).toBe("ollama:qwen3.6:35b-a3b");
  });

  it("falls back to the recommendation when nothing is persisted", () => {
    const status = withProfiles(["ollama:qwen3:8b"], "ollama:qwen3:8b");
    expect(resolveProfile("", status)).toBe("ollama:qwen3:8b");
  });
});
