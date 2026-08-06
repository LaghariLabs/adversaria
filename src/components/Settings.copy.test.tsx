import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { appConfig } from "../test/fixtures";
import { Settings } from "./Settings";

/**
 * Copy guard (docs/SETUP_REDESIGN_SPEC.md § C): Settings must never show engine
 * jargon to the user. Code identifiers are fine — this renders the component and
 * inspects only what a person can actually read, so variable names, config keys,
 * profile ids and comments can keep saying whatever they need to.
 */
const JARGON = [
  { term: "MLX", pattern: /\bmlx\b/i },
  { term: "Rapid", pattern: /\brapid/i },
  { term: "GGUF", pattern: /\bgguf\b/i },
  { term: "CTranslate2", pattern: /ctranslate/i },
  { term: "Ollama", pattern: /\bollama\b/i },
  { term: "pull (download jargon)", pattern: /\bpull(s|ed|ing)?\b/i },
];

/**
 * Raw Hugging Face repo ids. Checked against rendered *text* only — the model
 * name a cloud provider requires (e.g. in the Model field) is a value the user
 * must be able to type, not copy we chose.
 */
const REPO_ID =
  /\b(qwen|mlx-community|thebloke|meta-llama|unsloth|ggml-org|bartowski)\/[\w.-]+/i;

const TAB_LABELS = [
  "Setup status",
  "Recording",
  "Notifications",
  "Transcription",
  "Notes",
  "Integrations",
  "Privacy & data",
  "General",
];

/** A setup status whose *data* is full of jargon none of it may reach the screen. */
const SETUP_STATUS = {
  schema_version: 1,
  platform: "macos",
  architecture: "aarch64",
  total_memory_bytes: 32_000_000_000,
  available_disk_bytes: 400_000_000_000,
  rapid_runtime_bundled: true,
  profiles: [
    {
      id: "qwen-9b-balanced",
      display_name: "Qwen 9B",
      model_alias: "qwen3.5-9b-4bit",
      model_repo: "mlx-community/Qwen3.5-9B-4bit",
      model_revision: "main",
      runtime: "rapid-mlx",
      minimum_memory_gb: 16,
      required_disk_gb: 6,
      quality_label: "Balanced",
      quality_note: "Good notes on most Macs.",
      installed: true,
      recommended: true,
    },
    {
      id: "qwen-27b-quality",
      display_name: "Qwen 27B",
      model_alias: "qwen3.5-27b-4bit",
      model_repo: "mlx-community/Qwen3.5-27B-4bit",
      model_revision: "main",
      runtime: "rapid-mlx",
      minimum_memory_gb: 32,
      required_disk_gb: 17,
      quality_label: "Best quality",
      quality_note: "For 32 GB Macs.",
      installed: false,
      recommended: false,
    },
  ],
  recommended_profile: "qwen-9b-balanced",
};

function mockSettingsIpc(config: ReturnType<typeof appConfig>) {
  mockIPC((command, payload) => {
    if (command === "get_config") return config;
    if (command === "check_service_health") {
      return {
        status: "ok",
        whisper_model: config.whisper_model,
        ollama_available: true,
        // The V3 transcription section renders its state chip from this.
        transcriber_state: "ready",
        transcriber_detail: null,
      };
    }
    if (command === "list_templates") return [{ name: "general", description: "" }];
    if (command === "list_whisper_models") {
      return [
        { key: "large-v3", label: "Large v3", size: "3 GB", downloaded: true },
        { key: "large-v3-turbo", label: "Large v3 turbo", size: "1.6 GB", downloaded: false },
      ];
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
    if (command === "get_setup_status") return SETUP_STATUS;
    if (command === "calendar_status") return config.calendar;
    if (command === "calendar_has_credentials") return false;
    if (command === "plugin:app|version") return "0.3.65";
    return null;
  });
}

/** Everything a person can read: rendered text plus the labelling attributes. */
function visibleCopy(root: HTMLElement): { text: string; attrs: string } {
  const attrs = Array.from(root.querySelectorAll("[placeholder], [aria-label], [title]"))
    .flatMap((el) => [
      el.getAttribute("placeholder"),
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
    ])
    .filter((v): v is string => Boolean(v));
  return { text: root.textContent ?? "", attrs: attrs.join("\n") };
}

function expectNoJargon(root: HTMLElement, where: string) {
  const { text, attrs } = visibleCopy(root);
  for (const { term, pattern } of JARGON) {
    expect(pattern.test(text), `${where}: user-visible text says "${term}"`).toBe(false);
    expect(pattern.test(attrs), `${where}: a placeholder/label says "${term}"`).toBe(false);
  }
  expect(REPO_ID.test(text), `${where}: user-visible text shows a raw model repo id`).toBe(
    false,
  );
}

describe("Settings copy", () => {
  it("keeps engine jargon off every tab", async () => {
    mockSettingsIpc(appConfig());
    const user = userEvent.setup();
    const { container } = render(<Settings />);

    await screen.findByRole("button", { name: "General settings" });
    // The engine picker must say what "local" means in plain language.
    expect(screen.getByRole("option", { name: "Local — on this computer" })).toBeTruthy();
    // The V3 transcription dashboard has to be on screen, or this guard is vacuous.
    expect(await screen.findByRole("heading", { name: "Transcription" })).toBeTruthy();
    expect(await screen.findByText("Large v3 turbo")).toBeTruthy();

    for (const label of TAB_LABELS) {
      await user.click(screen.getByRole("button", { name: `${label} settings` }));
      expectNoJargon(container, label);
    }
  });

  it("keeps engine jargon out of the cloud, PIN, and calendar branches", async () => {
    mockSettingsIpc(
      appConfig({
        llm_provider: "groq",
        llm_base_url: "https://api.groq.com/openai/v1",
        // The engine picker follows the provider, so set it or the cloud
        // transcription branch never renders and this guard goes vacuous.
        transcription_provider: "cloud",
        transcription_base_url: "https://api.groq.com/openai/v1",
        pin_hash: "hash",
      }),
    );
    const user = userEvent.setup();
    const { container } = render(<Settings />);

    // Calendar setup used to hide behind a "Show calendar setup" disclosure. In a
    // section whose whole job is integrations, selecting it is enough.
    await user.click(await screen.findByRole("button", { name: "Integrations settings" }));
    await screen.findByText(/Apple Calendar \(this Mac\)/);

    expectNoJargon(container, "cloud/PIN/calendar branches");
  });
});
