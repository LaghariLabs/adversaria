import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { OnboardingState, RegistrationState, SetupStatus } from "../types";
import { appConfig } from "../test/fixtures";
import { Welcome, resolveScreen } from "./Welcome";

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
  // A scheduled retry is what makes "pending" show the queued banner — a
  // pending state WITHOUT one (endpoint-less builds) stays silent.
  next_retry_at: status === "pending" ? "2026-07-14T10:05:00Z" : null,
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

/** Curated transcription models as the picker reports them. */
const whisperModels = (downloaded: boolean) => [
  { key: "large-v3-turbo", label: "Large v3 turbo", size: "1.6 GB", downloaded },
];

const health = (transcriber_state?: string) => ({
  status: "ok",
  whisper_model: "large-v3-turbo",
  ollama_available: true,
  transcriber_state,
  transcriber_detail: null,
});

describe("Welcome", () => {
  it("requires explicit consent, then lands on permissions after registering", async () => {
    let submitted = false;
    const downloadsStarted: string[] = [];
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration();
      if (command === "get_setup_status") return setup();
      if (command === "list_whisper_models") return whisperModels(false);
      if (command === "check_service_health") return health("missing");
      if (command === "get_onboarding_state") {
        return onboarding(submitted ? ["registration"] : []);
      }
      if (command === "submit_registration") {
        submitted = true;
        return registration("pending");
      }
      if (command === "start_model_download") {
        const args = payload as { profileId?: string };
        downloadsStarted.push(args.profileId ?? "");
        return null;
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
    // SPEC V3: the wizard downloads NOTHING — not even the transcription model.
    expect(downloadsStarted).toEqual([]);
  });

  it("finishes from the final screen with NO model chosen and persists the reminder toggle", async () => {
    let current: OnboardingState = onboarding(["registration", "permissions"]);
    let savedReminder: boolean | null = null;
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(true);
      if (command === "list_whisper_models") return whisperModels(true);
      if (command === "check_service_health") return health("ready");
      if (command === "get_onboarding_state") return current;
      if (command === "update_config") {
        const args = payload as { config?: { meeting_reminder_enabled?: boolean } };
        savedReminder = args.config?.meeting_reminder_enabled ?? null;
        return null;
      }
      if (command === "complete_onboarding_step") {
        const args = payload as { step?: string; selectedModelProfile?: string | null; setupComplete?: boolean };
        expect(args.step).toBe("ready");
        // SPEC v2: the wizard never selects a model — the tour + Settings do.
        expect(args.selectedModelProfile).toBeNull();
        expect(args.setupComplete).toBe(true);
        current = {
          ...current,
          completed_steps: [...current.completed_steps, "ready"],
          setup_complete: true,
        };
        return current;
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);
    expect(await screen.findByText("You're all set")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Start using Adversaria" }));
    await waitFor(() => expect(screen.queryByText("You're all set")).not.toBeInTheDocument());
    expect(savedReminder).toBe(true);
  });

  it("says transcription is ready when the model is already on the machine", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(true);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return whisperModels(true);
      if (command === "check_service_health") return health("ready");
      return null;
    });

    render(<Welcome />);
    expect(await screen.findByText(/Transcription ready ✓/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Choose & download it in Settings/ }),
    ).not.toBeInTheDocument();
  });

  it("guides (never fetches) when no transcription model is on the machine", async () => {
    const downloadsStarted: string[] = [];
    let current: OnboardingState = onboarding(["registration", "permissions"]);
    let openedModelSettings = false;
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return current;
      if (command === "list_whisper_models") return whisperModels(false);
      if (command === "check_service_health") return health("missing");
      if (command === "start_model_download") {
        downloadsStarted.push((payload as { profileId?: string }).profileId ?? "");
        return null;
      }
      if (command === "complete_onboarding_step") {
        current = { ...current, setup_complete: true };
        return current;
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome onOpenModelSettings={() => { openedModelSettings = true; }} />);

    expect(
      await screen.findByText(/needs a transcription model to turn recordings into text/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing downloads without your say-so/)).toBeInTheDocument();
    // Never the old indeterminate "Checking what's already on this machine…".
    expect(screen.queryByText(/Checking what's already on this machine/)).not.toBeInTheDocument();
    // The primary way out stays open regardless.
    expect(screen.getByRole("button", { name: "Start using Adversaria" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /Choose & download it in Settings/ }));
    await waitFor(() => expect(openedModelSettings).toBe(true));
    expect(downloadsStarted).toEqual([]);
  });

  it("skips the permissions screen on Windows", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false, "windows");
      if (command === "get_onboarding_state") return onboarding(["registration"]);
      if (command === "list_whisper_models") return whisperModels(false);
      if (command === "check_service_health") return health("missing");
      return null;
    });

    render(<Welcome />);
    expect(await screen.findByText("You're all set")).toBeInTheDocument();
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
