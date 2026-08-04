import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig, ModelDownloadStatus, TranscriptionProvider } from "../../types";
import { appConfig } from "../../test/fixtures";
import { AiModelTab } from "./AiModelTab";

/**
 * Transcription engine picker (founder call, 2026-08-03): three engines, each
 * with copy that is TRUE for it. A self-hosted Whisper box on the office LAN is
 * the most sovereign setup a company can have — it must never be told its audio
 * leaves the device, and it must never be handed a cloud provider's URL.
 */

/** Nothing here downloads or reaches a service; the tab just needs answers. */
function mockTabIpc() {
  mockIPC((command, payload) => {
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

function renderTab(overrides: Partial<AppConfig> = {}) {
  mockTabIpc();
  const update = vi.fn();
  const view = render(
    <AiModelTab
      active
      config={appConfig(overrides)}
      update={update}
      replaceConfig={vi.fn()}
    />,
  );
  return { update, ...view };
}

/** "Engine" labels two selects in this tab (transcription, then notes). */
const engine = () =>
  screen.getByLabelText("Engine", { selector: "#settings-transcription-engine" });
const baseUrl = () =>
  screen.getByLabelText("Transcription Base URL") as HTMLInputElement;

/** Only the Transcription section — the notes engine below it names providers
 *  of its own, which would make a whole-card text match meaningless. */
const transcriptionCopy = (root: HTMLElement) =>
  (root.textContent ?? "").split("Meeting notes")[0];

const REMOTE_SELF_HOSTED: Partial<AppConfig> = {
  transcription_provider: "self_hosted",
  transcription_base_url: "http://dgx.office.local:8000/v1",
};
const REMOTE_CLOUD: Partial<AppConfig> = {
  transcription_provider: "cloud",
  transcription_base_url: "https://api.groq.com/openai/v1",
};

describe("AiModelTab transcription engine", () => {
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

describe("AiModelTab background downloads", () => {
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

    const replaceConfig = vi.fn();
    render(
      <AiModelTab
        active
        config={appConfig({
          transcription_provider: "cloud",
          transcription_base_url: "https://api.groq.com/openai/v1",
          transcription_api_key: "typed-but-not-saved",
        })}
        update={vi.fn()}
        replaceConfig={replaceConfig}
      />,
    );

    await waitFor(() => expect(replaceConfig).toHaveBeenCalled());
    // Only the field the backend rewrote comes back; the rest is the user's.
    expect(replaceConfig.mock.calls[0][0]).toMatchObject({
      whisper_model: "large-v3-turbo",
      transcription_provider: "cloud",
      transcription_base_url: "https://api.groq.com/openai/v1",
      transcription_api_key: "typed-but-not-saved",
    });
  });
});
