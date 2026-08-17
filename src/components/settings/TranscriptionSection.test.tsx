import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig, ModelDownloadStatus, TranscriptionProvider } from "../../types";
import { appConfig } from "../../test/fixtures";
import { Settings } from "../Settings";
import { TranscriptionSection } from "./TranscriptionSection";
import type { ServiceHealth } from "../../hooks/useServiceHealth";
import type { SettingsModels } from "../../hooks/useSettingsModels";

/**
 * Transcription engine picker (founder call, 2026-08-03): three engines, each
 * with copy that is TRUE for it. A self-hosted Whisper box on the office LAN is
 * the most sovereign setup a company can have — it must never be told its audio
 * leaves the device, and it must never be handed a cloud provider's URL.
 */

/** Nothing here downloads or reaches a service; the section just needs answers. */
function mockTabIpc(overrides: Partial<AppConfig> = {}) {
  mockIPC((command, payload) => {
    if (command === "get_config") return appConfig(overrides);
    if (command === "update_config") return null;
    if (command === "plugin:app|version") return "0.3.73";
    if (command === "get_registration_state") return null;
    if (command === "list_templates") return [{ name: "general", description: "" }];
    if (command === "get_setup_status") {
      return { schema_version: 1, platform: "macos", profiles: [] };
    }
    if (command === "list_whisper_models") {
      return [{ key: "large-v3", label: "Large v3", size: "3 GB", downloaded: true }];
    }
    if (command === "check_service_health") {
      return { status: "ok", ollama_available: true, transcriber_state: "ready" };
    }
    if (command === "get_model_download_status") {
      return {
        profile_id: (payload as { profileId?: string }).profileId ?? "",
        state: "idle",
        downloaded_bytes: 0,
        total_bytes: 0,
        detail: "",
        error_code: null,
        verified: false,
        can_retry: true,
      };
    }
    return null;
  });
}

/** Health and the model layer are shared hooks owned by the shell, so the
 *  section takes them as props. Stubbing them keeps these tests on what this
 *  section is responsible for: the engine choice and the copy that follows from
 *  it. The two tests that need the real wiring render the Settings shell. */
const healthStub = (over: Partial<ServiceHealth> = {}): ServiceHealth => ({
  health: {
    status: "ok",
    whisper_model: "large-v3",
    ollama_available: true,
    transcriber_state: "ready",
  },
  healthStatus: "ok",
  checkHealth: async () => {},
  restartService: async () => {},
  serviceRestarting: false,
  serviceRestartMessage: "",
  ...over,
});

const modelsStub = (over: Partial<SettingsModels> = {}): SettingsModels => ({
  setup: null,
  whisperModels: [
    { key: "large-v3", label: "Large v3", size: "3 GB", downloaded: true },
  ] as SettingsModels["whisperModels"],
  whisperMsg: "",
  setWhisperMsg: () => {},
  modelMsg: "",
  setModelMsg: () => {},
  modelSwitching: false,
  downloads: {},
  beginDownload: async () => {},
  switchLocalModel: async () => {},
  activateWhisperModel: async () => {},
  refreshSetup: async () => {},
  ...over,
});

function renderTab(
  overrides: Partial<AppConfig> = {},
  health: ServiceHealth = healthStub(),
  models: SettingsModels = modelsStub(),
) {
  mockTabIpc(overrides);
  const update = vi.fn();
  const view = render(
    <TranscriptionSection
      active
      config={appConfig(overrides)}
      update={update}
      health={health}
      models={models}
    />,
  );
  return { update, ...view };
}

/** Minimal SetupStatus for a given platform — see SetupStatusStrip.test.tsx's
 *  SETUP literal for the field list; only `platform` varies here. */
const setupFor = (platform: string) => ({
  schema_version: 1,
  platform,
  architecture: "aarch64",
  total_memory_bytes: 32_000_000_000,
  available_disk_bytes: 400_000_000_000,
  rapid_runtime_bundled: true,
  recommended_profile: "",
  profiles: [],
});

/** "Engine" labels two selects in this tab (transcription, then notes). */
const engine = () =>
  screen.getByLabelText("Engine", { selector: "#settings-transcription-engine" });
const baseUrl = () =>
  screen.getByLabelText("Transcription Base URL") as HTMLInputElement;

/** Only the Transcription card. Every section is mounted at once, and the notes
 *  engine names providers of its own, so a whole-tree text match would be
 *  meaningless. The active card is the one on screen. */
const transcriptionCopy = (root: HTMLElement) =>
  root.querySelector(".settings-section-card.active-card")?.textContent ?? "";

const REMOTE_SELF_HOSTED: Partial<AppConfig> = {
  transcription_provider: "self_hosted",
  transcription_base_url: "http://dgx.office.local:8000/v1",
};
const REMOTE_CLOUD: Partial<AppConfig> = {
  transcription_provider: "cloud",
  transcription_base_url: "https://api.groq.com/openai/v1",
};

describe("Transcription engine", () => {
  it("offers three engines and follows the saved provider, not the URL", async () => {
    // A self-hosted install has a base URL exactly like a cloud one — only the
    // saved provider tells them apart.
    renderTab(REMOTE_SELF_HOSTED);

    const select = (await screen.findByLabelText("Engine", {
      selector: "#settings-transcription-engine",
    })) as HTMLSelectElement;
    expect(Array.from(select.options, (o) => o.value)).toEqual([
      "local",
      "self_hosted",
      "cloud",
    ]);
    expect(select.value).toBe("self_hosted");
  });

  it("writes the chosen provider for each engine", async () => {
    const user = userEvent.setup();
    const cases: { from: Partial<AppConfig>; pick: TranscriptionProvider }[] = [
      { from: {}, pick: "self_hosted" },
      { from: {}, pick: "cloud" },
      { from: REMOTE_CLOUD, pick: "local" },
    ];

    for (const { from, pick } of cases) {
      const view = renderTab(from);
      await user.selectOptions(engine(), pick);
      expect(view.update).toHaveBeenCalledWith(
        expect.objectContaining({ transcription_provider: pick }),
      );
      view.unmount();
    }
  });

  it("clears the base URL when switching to on-device", async () => {
    // Blank is what routes transcription on-device — see
    // `configured_transcription_base_url` in src-tauri/src/commands.rs.
    const user = userEvent.setup();
    const { update } = renderTab(REMOTE_CLOUD);

    await user.selectOptions(engine(), "local");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        transcription_provider: "local",
        transcription_base_url: "",
      }),
    );
  });

  it("prefills the cloud preset only into an empty base URL", async () => {
    const user = userEvent.setup();
    const { update } = renderTab();

    await user.selectOptions(engine(), "cloud");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        transcription_base_url: "https://api.groq.com/openai/v1",
      }),
    );
  });

  it("never clobbers a base URL the user already typed", async () => {
    const user = userEvent.setup();
    const { update } = renderTab(REMOTE_SELF_HOSTED);

    await user.selectOptions(engine(), "cloud");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).not.toHaveProperty("transcription_base_url");
  });

  it("drops the provider's address when cloud becomes self-hosted", async () => {
    // The dangerous direction: keeping api.groq.com here would go on uploading
    // to Groq while the panel promised the audio never left the network
    // (`configured_transcription_base_url` ignores the provider field).
    const user = userEvent.setup();
    const { update } = renderTab(REMOTE_CLOUD);

    await user.selectOptions(engine(), "self_hosted");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        transcription_provider: "self_hosted",
        transcription_base_url: "",
      }),
    );
  });

  it("never carries an API key across engines", async () => {
    // A key is issued FOR a host. transcribe_cloud() Bearer-sends whatever is
    // configured, so an internal DGX token must not ride along to a provider.
    const user = userEvent.setup();
    for (const [from, pick] of [
      [{ ...REMOTE_SELF_HOSTED, transcription_api_key: "internal-dgx-token" }, "cloud"],
      [{ ...REMOTE_CLOUD, transcription_api_key: "gsk_secret" }, "self_hosted"],
      [{ ...REMOTE_CLOUD, transcription_api_key: "gsk_secret" }, "local"],
    ] as const) {
      const view = renderTab(from);
      await user.selectOptions(engine(), pick);
      expect(view.update).toHaveBeenCalledWith(
        expect.objectContaining({
          transcription_provider: pick,
          transcription_api_key: "",
        }),
      );
      view.unmount();
    }
  });

  it("refuses to call a public host a server you run", async () => {
    // Reachable by typing one in, and by any config that claims self_hosted
    // with a provider's URL. The claim follows the HOST, not the dropdown.
    const { container } = renderTab({
      transcription_provider: "self_hosted",
      transcription_base_url: "https://api.groq.com/openai/v1",
    });
    await screen.findByLabelText("Transcription Base URL");

    const copy = transcriptionCopy(container);
    expect(copy).not.toMatch(/never to a third party/i);
    expect(copy).not.toMatch(/stays on your network/i);
    expect(copy).toMatch(/isn't an address on your network/i);
    expect(copy).toMatch(/api\.groq\.com/);
    // The remote limitation still has to survive the warning.
    expect(copy).toMatch(/speaker labeling is unavailable/i);
  });

  it("gives self-hosted no provider URL and no cloud sign-up copy", async () => {
    const { container } = renderTab({
      transcription_provider: "self_hosted",
      transcription_base_url: "",
    });

    const base = await screen.findByLabelText("Transcription Base URL");
    expect((base as HTMLInputElement).value).toBe("");
    expect((base as HTMLInputElement).placeholder).toBe(
      "http://dgx.office.local:8000/v1",
    );

    const copy = transcriptionCopy(container);
    expect(copy).not.toMatch(/groq/i);
    expect(copy).not.toMatch(/free key/i);
    expect(screen.queryByRole("button", { name: /console\.groq\.com/ })).toBeNull();
  });

  it("tells self-hosted the truth: your server, your network, key optional", async () => {
    const { container } = renderTab(REMOTE_SELF_HOSTED);
    await screen.findByLabelText("Transcription Base URL");

    const copy = transcriptionCopy(container);
    expect(copy).toMatch(/never to a third party/i);
    expect(copy).toMatch(/stays on your network/i);
    expect(copy).toMatch(/dgx\.office\.local:8000/);
    // The sovereignty warning belongs to cloud only.
    expect(copy).not.toMatch(/not sovereign/i);
    expect(copy).not.toMatch(/audio leaves your device/i);

    // transcribe_cloud() omits the auth header when the key is blank, so
    // "optional" is the honest label here.
    expect(screen.getByLabelText("API Key (optional)")).toBeTruthy();
  });

  it("keeps the sovereignty warning and the key help on cloud", async () => {
    const { container } = renderTab(REMOTE_CLOUD);
    await screen.findByLabelText("Transcription Base URL");

    const copy = transcriptionCopy(container);
    expect(copy).toMatch(/not sovereign/i);
    expect(copy).toMatch(/audio leaves your device/i);
    expect(copy).toMatch(/api\.groq\.com/);
    expect(screen.getByRole("button", { name: "console.groq.com/keys" })).toBeTruthy();
    expect(
      screen.getByLabelText("API Key", { selector: "#settings-transcription-key" }),
    ).toBeTruthy();
  });

  it("keeps the speaker-labeling caveat in both remote modes", async () => {
    for (const from of [REMOTE_SELF_HOSTED, REMOTE_CLOUD]) {
      const view = renderTab(from);
      await screen.findByLabelText("Transcription Base URL");
      expect(transcriptionCopy(view.container)).toMatch(
        /speaker labeling is\s+unavailable/i,
      );
      view.unmount();
    }
  });

  it("offers Base URL, Model and a password key field in both remote modes", async () => {
    for (const from of [REMOTE_SELF_HOSTED, REMOTE_CLOUD]) {
      const view = renderTab(from);
      await screen.findByLabelText("Transcription Base URL");
      expect(baseUrl()).toBeTruthy();
      expect(
        screen.getByLabelText("Model", { selector: "#settings-transcription-model" }),
      ).toBeTruthy();
      const key = view.container.querySelector("#settings-transcription-key");
      expect(key?.getAttribute("type")).toBe("password");
      view.unmount();
    }
  });

  it("warns while a remote engine has no address yet", async () => {
    const { container } = renderTab({
      transcription_provider: "self_hosted",
      transcription_base_url: "",
    });
    await screen.findByLabelText("Transcription Base URL");
    expect(transcriptionCopy(container)).toMatch(
      /transcription runs on this computer/i,
    );
  });

  it("shows the on-device model list, not remote fields, for local", async () => {
    renderTab();
    expect(await screen.findByText("Large v3")).toBeTruthy();
    expect(screen.queryByLabelText("Transcription Base URL")).toBeNull();
  });
});

describe("Background downloads", () => {
  const downloadStatus = (
    profile_id: string,
    state: ModelDownloadStatus["state"],
  ): ModelDownloadStatus => ({
    profile_id,
    state,
    downloaded_bytes: 0,
    total_bytes: 0,
    detail: "",
    error_code: null,
    verified: state === "ready",
    can_retry: true,
  });

  it("keeps unsaved Settings edits when a download finishes", async () => {
    // Regression (2026-08-03 review): activating a freshly downloaded model
    // handed Settings the whole config it had just read from DISK, so an engine
    // switch and a half-typed API key — neither saved yet — were silently
    // reverted mid-typing, and Save then persisted the reverted copy.
    let turboPolls = 0;
    mockIPC((command, payload) => {
      if (command === "get_setup_status") {
        return { schema_version: 1, platform: "macos", profiles: [] };
      }
      if (command === "list_whisper_models") {
        return [
          { key: "large-v3", label: "Large v3", size: "3 GB", downloaded: false },
          { key: "large-v3-turbo", label: "Large v3 turbo", size: "1.6 GB", downloaded: true },
        ];
      }
      if (command === "check_service_health") {
        return { status: "ok", ollama_available: true, transcriber_state: "ready" };
      }
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        if (id !== "whisper-model:large-v3-turbo") return downloadStatus(id, "idle");
        turboPolls += 1;
        return downloadStatus(id, turboPolls === 1 ? "downloading" : "ready");
      }
      // What is on disk — it knows nothing about what the user is typing.
      if (command === "get_config") return appConfig();
      if (command === "update_config") return null;
      return null;
    });

    const saved: Record<string, unknown>[] = [];
    mockIPC((command, payload) => {
      if (command === "get_setup_status") {
        return { schema_version: 1, platform: "macos", profiles: [] };
      }
      if (command === "list_whisper_models") {
        return [
          { key: "large-v3", label: "Large v3", size: "3 GB", downloaded: false },
          { key: "large-v3-turbo", label: "Large v3 turbo", size: "1.6 GB", downloaded: true },
        ];
      }
      if (command === "check_service_health") {
        return { status: "ok", ollama_available: true, transcriber_state: "ready" };
      }
      if (command === "get_model_download_status") {
        const id = (payload as { profileId?: string }).profileId ?? "";
        if (id !== "whisper-model:large-v3-turbo") return downloadStatus(id, "idle");
        turboPolls += 1;
        return downloadStatus(id, turboPolls === 1 ? "downloading" : "ready");
      }
      // What is on disk — it knows nothing about what the user is typing.
      if (command === "get_config") return appConfig({ transcription_provider: "cloud" });
      if (command === "update_config") {
        saved.push((payload as { config: Record<string, unknown> }).config);
        return null;
      }
      if (command === "plugin:app|version") return "0.3.73";
      if (command === "list_templates") return [{ name: "general", description: "" }];
      return null;
    });

    const user = userEvent.setup();
    render(<Settings initialTab="transcription" />);

    // An edit the user has NOT saved yet.
    const key = await screen.findByLabelText(/API Key/);
    await user.type(key, "typed-but-not-saved");

    // The background download lands and activates the new model, which writes
    // to disk on its own.
    await waitFor(() =>
      expect(saved.some((c) => c.whisper_model === "large-v3-turbo")).toBe(true),
    );

    // The invariant: the unsaved edit is still on screen, and pressing Save
    // persists it TOGETHER with the activated model. Before the fix, activation
    // handed Settings the whole disk copy and silently reverted the typing.
    expect((key as HTMLInputElement).value).toBe("typed-but-not-saved");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(saved[saved.length - 1]).toMatchObject({
        whisper_model: "large-v3-turbo",
        transcription_api_key: "typed-but-not-saved",
      }),
    );
  });
});

describe("Local AI recovery", () => {
  it("offers a real restart when the sidecar is unreachable", async () => {
    let restartCalls = 0;
    mockIPC((command, payload) => {
      // The shell loads the config before it renders anything, so this mock has
      // to answer it or Settings shows "Failed to load configuration."
      if (command === "get_config") return appConfig();
      if (command === "update_config") return null;
      if (command === "plugin:app|version") return "0.3.73";
      if (command === "list_templates") return [{ name: "general", description: "" }];
      if (command === "get_setup_status") {
        return { schema_version: 1, platform: "windows", profiles: [] };
      }
      if (command === "list_whisper_models") {
        return [{ key: "large-v3", label: "Large v3", size: "3 GB", downloaded: true }];
      }
      if (command === "check_service_health") {
        throw new Error("connection refused");
      }
      if (command === "get_model_download_status") {
        return {
          profile_id: (payload as { profileId?: string }).profileId ?? "",
          state: "idle",
          downloaded_bytes: 0,
          total_bytes: 0,
          detail: "",
          error_code: null,
          verified: false,
          can_retry: true,
        };
      }
      if (command === "restart_local_ai_service") {
        restartCalls += 1;
        return null;
      }
      return null;
    });

    const user = userEvent.setup();
    // The recovery action moved to Setup status, where a blocked pipeline is
    // reported — it is no longer buried in an "Advanced" disclosure.
    render(<Settings initialTab="setup" />);

    await screen.findByText(/The on-device service is not reachable/);
    await user.click(screen.getByRole("button", { name: "Restart Local AI" }));

    expect(restartCalls).toBe(1);
    expect(screen.getByText("Local AI is restarting…")).toBeTruthy();
  });
});

describe("Model re-download", () => {
  it("resets with force before it starts the download", async () => {
    const calls: string[] = [];
    const status = (
      profile_id: string,
      state: ModelDownloadStatus["state"],
    ): ModelDownloadStatus => ({
      profile_id,
      state,
      downloaded_bytes: 0,
      total_bytes: 0,
      detail: "",
      error_code: null,
      verified: state === "ready",
      can_retry: true,
    });
    mockIPC((command, payload) => {
      if (command === "get_config") return appConfig();
      if (command === "update_config") return null;
      if (command === "plugin:app|version") return "0.3.73";
      if (command === "get_registration_state") return null;
      if (command === "list_templates") return [{ name: "general", description: "" }];
      if (command === "get_setup_status") return setupFor("macos");
      if (command === "list_whisper_models") {
        return [{ key: "large-v3", label: "Large v3", size: "3 GB", downloaded: true }];
      }
      if (command === "check_service_health") {
        return { status: "ok", ollama_available: true, transcriber_state: "ready" };
      }
      if (command === "get_model_download_status") {
        return status((payload as { profileId?: string }).profileId ?? "", "idle");
      }
      if (command === "reset_model_download") {
        calls.push("reset");
        expect(payload).toMatchObject({
          profileId: "whisper-model:large-v3",
          force: true,
        });
        return status("whisper-model:large-v3", "idle");
      }
      if (command === "start_model_download") {
        calls.push("start");
        return status("whisper-model:large-v3", "preparing");
      }
      return null;
    });

    const user = userEvent.setup();
    render(<Settings initialTab="transcription" />);

    await user.click(await screen.findByRole("button", { name: "Re-download" }));
    expect(
      screen.getByText(
        "Click again to delete and re-download — use when the model seems corrupt",
      ),
    ).toBeTruthy();
    expect(calls).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Confirm re-download" }));
    await waitFor(() => expect(calls).toEqual(["reset", "start"]));
  });
});

describe("Offline recovery copy", () => {
  const NOT_DOWNLOADED = [
    { key: "large-v3-turbo", label: "Large v3 turbo", size: "1.6 GB", downloaded: false },
  ];

  it("disables model downloads and explains that they need Local AI", async () => {
    renderTab(
      {},
      healthStub({ healthStatus: "unreachable" }),
      modelsStub({
        whisperModels: [
          ...NOT_DOWNLOADED,
          { key: "large-v3", label: "Large v3", size: "3 GB", downloaded: true },
        ],
      }),
    );

    const download = await screen.findByRole("button", { name: "Download" });
    const redownload = screen.getByRole("button", { name: "Re-download" });
    expect(download).toBeDisabled();
    expect(redownload).toBeDisabled();
    expect(download).toHaveAttribute("title", "Local AI offline — restart it first");
    expect(redownload).toHaveAttribute("title", "Local AI offline — restart it first");
    expect(
      screen.getByText(
        "The local AI service isn't running — downloads need it. Start Adversaria's service (it launches with the app) or restart the app.",
      ),
    ).toBeTruthy();
  });

  it("leaves Download enabled once Local AI answers again", async () => {
    renderTab({}, healthStub({ healthStatus: "ok" }), modelsStub({ whisperModels: NOT_DOWNLOADED }));

    const button = await screen.findByRole("button", { name: "Download" });
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute("title");
  });

  it("points macOS at the log file, not Windows Security, when Local AI is unreachable", async () => {
    const { container } = renderTab(
      {},
      healthStub({ healthStatus: "unreachable" }),
      modelsStub({ setup: setupFor("macos") }),
    );

    const copy = transcriptionCopy(container);
    expect(copy).toMatch(/adversaria-service\.log/);
    expect(copy).not.toMatch(/Windows Security/);
  });

  it("points Windows at Windows Security, not the macOS log path, when Local AI is unreachable", async () => {
    const { container } = renderTab(
      {},
      healthStub({ healthStatus: "unreachable" }),
      modelsStub({ setup: setupFor("windows") }),
    );

    const copy = transcriptionCopy(container);
    expect(copy).toMatch(/Windows Security/);
    expect(copy).not.toMatch(/adversaria-service\.log/);
  });
});
