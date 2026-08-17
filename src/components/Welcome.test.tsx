import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ModelDownloadStatus,
  OnboardingState,
  RegistrationState,
  SetupStatus,
} from "../types";
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

/** A two-model catalogue (sizes with the service's "~"), for picker tests.
 *  The fixture default config.whisper_model is "large-v3" — the second entry. */
const modelCatalogue = () => [
  { key: "large-v3-turbo", label: "Large v3 turbo", size: "~1.6 GB", downloaded: false },
  { key: "large-v3", label: "Large v3", size: "~3.1 GB", downloaded: false },
];

const downloadStatus = (
  id: string,
  state: ModelDownloadStatus["state"],
  downloaded = 0,
  total = 0,
): ModelDownloadStatus => ({
  profile_id: id,
  state,
  downloaded_bytes: downloaded,
  total_bytes: total,
  detail: state === "error" ? "The model download was interrupted." : "",
  error_code: state === "error" ? "network" : null,
  verified: state === "ready",
  can_retry: true,
});

const health = (transcriber_state?: string, transcriber_detail: string | null = null) => ({
  status: "ok",
  whisper_model: "large-v3-turbo",
  ollama_available: true,
  transcriber_state,
  transcriber_detail,
});

/** What /health says when the weights are on disk but the engine can't load
 *  them (bad compute_type, missing CUDA libs, a truncated snapshot). */
const ENGINE_ERROR =
  "The transcription model on this machine could not be loaded. Re-download it from Settings.";

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

  it("probes system audio and shows the denied recovery actions", async () => {
    let probed = 0;
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup();
      if (command === "get_onboarding_state") return onboarding(["registration"]);
      if (command === "check_capture_permissions") {
        return { microphone: "granted", system_audio: "undetermined" };
      }
      if (command === "probe_system_audio") {
        probed += 1;
        return { microphone: "granted", system_audio: "denied" };
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);
    await user.click(await screen.findByRole("button", { name: "Check system audio" }));

    await waitFor(() => expect(probed).toBe(1));
    expect(screen.getByText(/macOS didn't let Adversaria hear system audio/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open System Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue anyway" })).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: /Download \(/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("shows the card, not 'ready ✓', when the engine can't load the model on disk", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(true);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      // The model IS on disk — that flag is exactly what used to win the OR and
      // promise "Transcription ready ✓" on a machine that cannot transcribe.
      if (command === "list_whisper_models") return whisperModels(true);
      if (command === "check_service_health") return health("error", ENGINE_ERROR);
      return null;
    });

    render(<Welcome />);
    expect(await screen.findByText(ENGINE_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(/Transcription ready ✓/)).not.toBeInTheDocument();
    // The failure states itself and still hands over every way forward.
    expect(screen.getByRole("radio", { name: /Large v3 turbo/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More models in Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download (1.6 GB)" })).toBeInTheDocument();
    // The dead button is gone: no action that cannot act.
    expect(screen.queryByRole("button", { name: "Retry download" })).not.toBeInTheDocument();
  });

  it("issues a real request from an engine failure, and says why nothing re-downloads", async () => {
    const started: string[] = [];
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(true);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return whisperModels(true);
      if (command === "check_service_health") return health("error", ENGINE_ERROR);
      if (command === "update_config") return null;
      if (command === "start_model_download") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        started.push(id);
        // The service already holds this profile, so it refuses to re-fetch.
        return downloadStatus(id, "ready", 1, 1);
      }
      if (command === "get_model_download_status") {
        return downloadStatus((payload as { profileId?: string }).profileId ?? "", "idle");
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);
    await user.click(await screen.findByRole("button", { name: "Download (1.6 GB)" }));
    await waitFor(() => expect(started).toEqual(["whisper-model:large-v3-turbo"]));
    expect(await screen.findByText(/nothing to re-download/)).toBeInTheDocument();
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
    // The card offers the download in place — rendering it starts nothing.
    expect(screen.getByRole("button", { name: "Download (1.6 GB)" })).toBeInTheDocument();
    expect(downloadsStarted).toEqual([]);

    await user.click(screen.getByRole("button", { name: "More models in Settings" }));
    await waitFor(() => expect(openedModelSettings).toBe(true));
    expect(downloadsStarted).toEqual([]);
  });

  it("lists every curated model with its size and preselects the configured one", async () => {
    const downloadsStarted: string[] = [];
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig(); // whisper_model: "large-v3"
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return modelCatalogue();
      if (command === "check_service_health") return health("missing");
      if (command === "start_model_download") {
        downloadsStarted.push((payload as { profileId?: string }).profileId ?? "");
        return null;
      }
      if (command === "get_model_download_status") {
        return downloadStatus((payload as { profileId?: string }).profileId ?? "", "idle");
      }
      return null;
    });

    render(<Welcome />);
    // config.whisper_model wins the default; sizes come tilde-stripped.
    expect(await screen.findByRole("radio", { name: "Large v3 — 3.1 GB" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Large v3 turbo — 1.6 GB" })).not.toBeChecked();
    // The primary action names the selected model's size.
    expect(screen.getByRole("button", { name: "Download (3.1 GB)" })).toBeInTheDocument();
    // Rendering the picker starts NOTHING — clicks only.
    expect(downloadsStarted).toEqual([]);
  });

  it("downloads on one explicit click: persists the picked model, starts it, shows progress", async () => {
    const events: string[] = [];
    let started = false;
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return modelCatalogue();
      if (command === "check_service_health") return health("missing");
      if (command === "update_config") {
        const args = payload as { config?: { whisper_model?: string } };
        events.push(`config:${args.config?.whisper_model ?? ""}`);
        return null;
      }
      if (command === "start_model_download") {
        started = true;
        const id = (payload as { profileId?: string }).profileId ?? "";
        events.push(`download:${id}`);
        return downloadStatus(id, "downloading");
      }
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        return started && id === "whisper-model:large-v3-turbo"
          ? downloadStatus(id, "downloading", 1_200_000_000, 1_600_000_000)
          : downloadStatus(id, "idle");
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);

    await user.click(await screen.findByRole("radio", { name: "Large v3 turbo — 1.6 GB" }));
    await user.click(screen.getByRole("button", { name: "Download (1.6 GB)" }));

    // The choice is persisted BEFORE the download starts, like Settings does.
    await waitFor(() =>
      expect(events).toEqual(["config:large-v3-turbo", "download:whisper-model:large-v3-turbo"]),
    );
    // Live progress replaces the picker…
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText(/Downloading — 75%/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText(/the download keeps going/)).toBeInTheDocument();
    // …and finishing setup stays open mid-download.
    expect(screen.getByRole("button", { name: "Start using Adversaria" })).toBeEnabled();
  });

  it("surfaces a failed download, keeps the picker, and restarts the failed model", async () => {
    const retried: string[] = [];
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return modelCatalogue();
      if (command === "check_service_health") return health("missing");
      if (command === "start_model_download") {
        retried.push((payload as { profileId?: string }).profileId ?? "");
        return downloadStatus("", "downloading");
      }
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        return id === "whisper-model:large-v3"
          ? downloadStatus(id, "error")
          : downloadStatus(id, "idle");
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);
    expect(await screen.findByText("The model download was interrupted.")).toBeInTheDocument();
    // A failure never hides the picker or the Settings escape any more.
    expect(screen.getByRole("radio", { name: "Large v3 — 3.1 GB" })).toBeChecked();
    expect(screen.getByRole("button", { name: "More models in Settings" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download (3.1 GB)" }));
    await waitFor(() => expect(retried).toEqual(["whisper-model:large-v3"]));
  });

  it("replaces the card with the ready line when the download lands mid-wizard", async () => {
    vi.useFakeTimers();
    try {
      let started = false;
      mockIPC((command, payload) => {
        if (command === "get_config") return appConfig({ whisper_model: "large-v3-turbo" });
        if (command === "get_registration_state") return registration("submitted");
        if (command === "get_setup_status") return setup(false);
        if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
        if (command === "list_whisper_models") return modelCatalogue();
        if (command === "check_service_health") return health(started ? "ready" : "missing");
        if (command === "update_config") return null;
        if (command === "start_model_download") {
          started = true;
          return downloadStatus("whisper-model:large-v3-turbo", "downloading");
        }
        if (command === "get_model_download_status") {
          const id = (payload as { profileId?: string }).profileId ?? "";
          return started && id === "whisper-model:large-v3-turbo"
            ? downloadStatus(id, "ready", 1, 1)
            : downloadStatus(id, "idle");
        }
        return null;
      });

      render(<Welcome />);
      // Flush the mount chain without moving the clock.
      for (let i = 0; i < 8; i++) await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Download (1.6 GB)" }));
      for (let i = 0; i < 8; i++) await act(async () => {});
      // The next health poll reports the engine ready — ✓ replaces the card.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100);
      });
      expect(screen.getByText(/Transcription ready ✓/)).toBeInTheDocument();
      expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so when the catalogue hasn't answered yet, with Settings as the way out", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return [];
      if (command === "check_service_health") return health("missing");
      return null;
    });

    render(<Welcome />);
    expect(
      await screen.findByText(/The list of models isn't available yet/),
    ).toBeInTheDocument();
    // No dead primary action — Settings remains the escape hatch.
    expect(screen.queryByRole("button", { name: /Download \(/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More models in Settings" })).toBeInTheDocument();
  });

  it("reads App's transcription instance instead of polling for itself", async () => {
    // Regression (2026-08-03 review): the card mounted a SECOND
    // useTranscriptionSetup() while App already runs one at the root, doubling
    // every health + download request for as long as this screen was open.
    // Given App's instance, the card must render from it — a self-mounted hook
    // would report "missing" from the mocked IPC below, not this 42 %.
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return modelCatalogue();
      if (command === "check_service_health") return health("missing");
      return null;
    });

    const appInstance = {
      state: "downloading" as const,
      percent: 42,
      detail: "",
      serviceOnline: true,
      refresh: () => {},
      retry: () => {},
    };
    render(<Welcome transcriptionSetup={appInstance} />);

    expect(await screen.findByText(/42\s*%/)).toBeInTheDocument();
    // Progress replaces the picker while a download runs.
    expect(screen.queryByRole("button", { name: /Download \(/ })).not.toBeInTheDocument();
  });

  it("stops probing a service that never answers, and offers an explicit retry", async () => {
    vi.useFakeTimers();
    try {
      let probes = 0;
      mockIPC((command) => {
        if (command === "get_config") return appConfig();
        if (command === "get_registration_state") return registration("submitted");
        if (command === "get_setup_status") return setup(false);
        if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
        if (command === "list_whisper_models") {
          probes += 1;
          throw new Error("the on-device service is not running");
        }
        if (command === "check_service_health") {
          throw new Error("the on-device service is not running");
        }
        return null;
      });

      render(<Welcome />);
      for (let i = 0; i < 8; i++) await act(async () => {});
      // ~60 s of bounded, backing-off retries — then it admits what's wrong.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(65_000);
      });
      expect(screen.getByText(/The on-device service isn't responding/)).toBeInTheDocument();

      // No 2 s forever-loop: five more minutes must not re-probe at all.
      const settled = probes;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
      });
      expect(probes).toBe(settled);

      // …and the user has an actual way to ask again.
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      for (let i = 0; i < 8; i++) await act(async () => {});
      expect(probes).toBeGreaterThan(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the 'use your own endpoint' form hidden until it is asked for", async () => {
    mockIPC((command) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return modelCatalogue();
      if (command === "check_service_health") return health("missing");
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);

    const reveal = await screen.findByRole("button", { name: "Use your own endpoint." });
    // Quiet by default: the download is still the recommended path.
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
    await user.click(reveal);
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByLabelText("API key (optional)")).toBeInTheDocument();
    // The honest copy for a server on your own network — not the cloud warning.
    expect(screen.getByText(/stays on your network/)).toBeInTheDocument();
    // …and the real limitation of any remote engine survives.
    expect(screen.getByText(/Speaker labels aren't available/)).toBeInTheDocument();
    // The picker is still right there — this is an alternative, not a detour.
    expect(screen.getByRole("button", { name: "Download (3.1 GB)" })).toBeInTheDocument();
  });

  it("saves a self-hosted endpoint, downloads nothing, and reports transcription set up", async () => {
    const saved: Record<string, string>[] = [];
    const downloadsStarted: string[] = [];
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return modelCatalogue();
      if (command === "check_service_health") return health("missing");
      if (command === "update_config") {
        const args = payload as {
          config?: {
            transcription_provider?: string;
            transcription_base_url?: string;
            transcription_model?: string;
            transcription_api_key?: string;
          };
        };
        saved.push({
          provider: args.config?.transcription_provider ?? "",
          base_url: args.config?.transcription_base_url ?? "",
          model: args.config?.transcription_model ?? "",
          api_key: args.config?.transcription_api_key ?? "",
        });
        return null;
      }
      if (command === "start_model_download") {
        downloadsStarted.push((payload as { profileId?: string }).profileId ?? "");
        return null;
      }
      if (command === "get_model_download_status") {
        return downloadStatus((payload as { profileId?: string }).profileId ?? "", "idle");
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);

    await user.click(await screen.findByRole("button", { name: "Use your own endpoint." }));
    await user.type(screen.getByLabelText("Base URL"), "http://dgx.office.local:8000/v1");
    await user.type(screen.getByLabelText("Model"), "whisper-large-v3-turbo");
    await user.type(screen.getByLabelText("API key (optional)"), "office-key");
    await user.click(screen.getByRole("button", { name: "Use this server" }));

    await waitFor(() =>
      expect(saved).toEqual([
        {
          provider: "self_hosted",
          base_url: "http://dgx.office.local:8000/v1",
          model: "whisper-large-v3-turbo",
          api_key: "office-key",
        },
      ]),
    );
    // This path is a configuration, not a fetch.
    expect(downloadsStarted).toEqual([]);
    // The wizard stops asking for a model and names where audio goes.
    expect(await screen.findByText(/Transcription ready ✓/)).toBeInTheDocument();
    expect(screen.getByText(/dgx\.office\.local:8000/)).toBeInTheDocument();
    expect(
      screen.queryByText(/needs a transcription model to turn recordings into text/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download \(/ })).not.toBeInTheDocument();
  });

  it("refuses an unparseable endpoint URL and saves nothing", async () => {
    const saved: string[] = [];
    const downloadsStarted: string[] = [];
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      if (command === "list_whisper_models") return modelCatalogue();
      if (command === "check_service_health") return health("missing");
      if (command === "update_config") {
        saved.push("update_config");
        return null;
      }
      if (command === "start_model_download") {
        downloadsStarted.push((payload as { profileId?: string }).profileId ?? "");
        return null;
      }
      if (command === "get_model_download_status") {
        return downloadStatus((payload as { profileId?: string }).profileId ?? "", "idle");
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Welcome />);

    await user.click(await screen.findByRole("button", { name: "Use your own endpoint." }));
    // A host-less string is the mistake that yields an engine which never answers.
    await user.type(screen.getByLabelText("Base URL"), "dgx:8000");
    await user.click(screen.getByRole("button", { name: "Use this server" }));

    expect(await screen.findByText(/Enter the full base URL/)).toBeInTheDocument();
    expect(saved).toEqual([]);
    expect(downloadsStarted).toEqual([]);
    // The form stays open on the value the user typed — nothing is lost.
    expect(screen.getByLabelText("Base URL")).toHaveValue("dgx:8000");
    expect(screen.queryByText(/Transcription ready ✓/)).not.toBeInTheDocument();
  });

  it("never asks for a download when a remote endpoint is already configured", async () => {
    let probes = 0;
    mockIPC((command) => {
      if (command === "get_config") {
        return appConfig({
          transcription_provider: "self_hosted",
          transcription_base_url: "http://dgx.office.local:8000/v1",
        });
      }
      if (command === "get_registration_state") return registration("submitted");
      if (command === "get_setup_status") return setup(false);
      if (command === "get_onboarding_state") return onboarding(["registration", "permissions"]);
      // The local engine has no model and says so — irrelevant to this machine.
      if (command === "list_whisper_models") {
        probes += 1;
        return modelCatalogue();
      }
      if (command === "check_service_health") return health("missing");
      return null;
    });

    render(<Welcome />);
    // An endpoint restored from config has NOT been contacted in this session,
    // so the screen names it without claiming "ready ✓" — a promise the wizard
    // cannot keep for an address it has never reached (a typo'd host used to
    // finish setup as ready and fail on the first real meeting).
    expect(
      await screen.findByText(/Adversaria hasn't reached that address yet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/your own Whisper server/)).toBeInTheDocument();
    expect(screen.getByText(/dgx\.office\.local:8000/)).toBeInTheDocument();
    expect(screen.queryByText(/Transcription ready ✓/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/needs a transcription model to turn recordings into text/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download \(/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    // Nothing local is even probed: transcription doesn't run here.
    expect(probes).toBe(0);
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
