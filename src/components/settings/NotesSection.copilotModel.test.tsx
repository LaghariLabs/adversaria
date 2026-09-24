import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NotesSection } from "./NotesSection";
import { appConfig } from "../../test/fixtures";
import type { SettingsModels } from "../../hooks/useSettingsModels";

vi.mock("../../lib/tauri", () => ({
  listTemplates: vi.fn().mockResolvedValue([{ name: "general", description: "" }]),
  getTemplate: vi.fn().mockResolvedValue(""),
  saveTemplate: vi.fn().mockResolvedValue(undefined),
  deleteTemplate: vi.fn().mockResolvedValue(undefined),
  generateTemplate: vi.fn().mockResolvedValue("draft"),
  testLlmConnection: vi.fn().mockResolvedValue("ok"),
}));

function modelsStub(over: Partial<SettingsModels> = {}): SettingsModels {
  return {
    setup: {
      schema_version: 1,
      platform: "macos",
      architecture: "aarch64",
      total_memory_bytes: 32_000_000_000,
      available_disk_bytes: 400_000_000_000,
      rapid_runtime_bundled: true,
      recommended_profile: "p1",
      profiles: [
        {
          id: "p1",
          display_name: "Qwen",
          model_alias: "qwen3.6-35b",
          model_repo: "repo",
          model_revision: "rev",
          runtime: "ollama",
          minimum_memory_gb: 8,
          required_disk_gb: 2,
          quality_label: "good",
          quality_note: "note",
          installed: true,
          recommended: true,
        },
      ],
    } as unknown as SettingsModels["setup"],
    whisperModels: [],
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
  };
}

describe("NotesSection Copilot model", () => {
  it("renders exactly one Copilot model input and typing calls update", async () => {
    const update = vi.fn();
    const user = userEvent.setup();
    render(
      <NotesSection
        active
        config={appConfig({ llm_provider: "local", copilot_local_model: "" })}
        update={update}
        models={modelsStub()}
      />,
    );
    const inputs = document.querySelectorAll("#settings-copilot-model");
    expect(inputs).toHaveLength(1);
    expect(screen.getByLabelText("Copilot model")).toBeInTheDocument();
    const input = screen.getByLabelText("Copilot model") as HTMLInputElement;
    expect(input.placeholder).toBe("qwen3.6:35b");
    await user.type(input, "q");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ copilot_local_model: expect.any(String) }));
    // ensure last call contains the typed value
    const last = update.mock.calls[update.mock.calls.length - 1][0] as { copilot_local_model: string };
    expect(last.copilot_local_model).toContain("q");
    // helper text
    expect(screen.getByText(/Ollama tag used by the Live Copilot/)).toBeInTheDocument();
  });

  it("has only one id in any state", async () => {
    const update = vi.fn();
    render(
      <NotesSection
        active
        config={appConfig({ llm_provider: "local", copilot_local_model: "my-tag" })}
        update={update}
        models={modelsStub()}
      />,
    );
    expect(document.querySelectorAll("#settings-copilot-model")).toHaveLength(1);
  });
});
