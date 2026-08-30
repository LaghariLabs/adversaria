import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ModelProfile,
  SetupStatus,
  WorkspaceDetail,
  WorkspaceEngine,
} from "../../types";
import { WorkspaceDetailView } from "./WorkspaceDetailView";

const engines: WorkspaceEngine[] = [
  {
    id: "local",
    label: "Local model",
    available: true,
    version: "",
    detail: "",
  },
  {
    id: "claude",
    label: "Claude Code",
    available: true,
    version: "2.1.0",
    detail: "",
  },
  {
    id: "codex",
    label: "Codex",
    available: true,
    version: "0.40.0",
    detail: "",
  },
];

const profiles: ModelProfile[] = [
  {
    id: "qwen-4b",
    display_name: "Qwen 4B",
    model_alias: "qwen3.5:4b",
    model_repo: "qwen/4b",
    model_revision: "main",
    runtime: "ollama",
    minimum_memory_gb: 8,
    required_disk_gb: 4,
    quality_label: "Fast",
    quality_note: "For meeting notes",
    installed: true,
    recommended: true,
  },
  {
    id: "qwen-27b",
    display_name: "Qwen 27B",
    model_alias: "qwen3.6:27b",
    model_repo: "qwen/27b",
    model_revision: "main",
    runtime: "ollama",
    minimum_memory_gb: 32,
    required_disk_gb: 18,
    quality_label: "Best",
    quality_note: "For complex deliverables",
    installed: true,
    recommended: false,
  },
  {
    id: "qwen-35b",
    display_name: "Qwen 35B",
    model_alias: "qwen3.6:35b",
    model_repo: "qwen/35b",
    model_revision: "main",
    runtime: "ollama",
    minimum_memory_gb: 48,
    required_disk_gb: 24,
    quality_label: "Largest",
    quality_note: "Not installed",
    installed: false,
    recommended: false,
  },
];

const setupStatus: SetupStatus = {
  schema_version: 1,
  platform: "macos",
  architecture: "aarch64",
  total_memory_bytes: 64_000_000_000,
  available_disk_bytes: 100_000_000_000,
  rapid_runtime_bundled: true,
  profiles,
  recommended_profile: "qwen-4b",
};

function workspaceDetail(engine: string, model = ""): WorkspaceDetail {
  return {
    workspace: {
      id: 4,
      name: "Launch planning",
      engine,
      model,
      network_allowed: false,
      instructions: "",
      color: "blue",
      created_at: "2026-08-17T10:00:00Z",
      updated_at: "2026-08-17T10:00:00Z",
    },
    context_items: [],
    addons: [],
    tasks: [],
    artifacts: [],
  };
}

function renderDetail(
  detail: WorkspaceDetail,
  onRefresh: () => Promise<void> = async () => undefined,
) {
  render(
    <WorkspaceDetailView
      detail={detail}
      error={null}
      onBack={() => undefined}
      onOpenMeeting={() => undefined}
      onAddTask={async () => true}
      onDeleteTask={async () => undefined}
      onAddFolder={async () => undefined}
      onRemoveContext={async () => undefined}
      onRefresh={onRefresh}
    />,
  );
}

function mockWorkspaceSetup(
  onCommand?: (command: string, payload: unknown) => unknown,
) {
  mockIPC((command, payload) => {
    if (command === "detect_workspace_engines") return engines;
    if (command === "get_setup_status") return setupStatus;
    if (command === "list_workspace_addons") return [];
    if (command === "get_context_sources") {
      return { vault_path: "", projects_root: "" };
    }
    return onCommand?.(command, payload) ?? null;
  });
}

describe("WorkspaceDetailView model selection", () => {
  it.each([
    ["codex", "Codex"],
    ["claude", "Claude Code"],
  ])("does not render the model select for the %s engine", async (engine, label) => {
    mockWorkspaceSetup();

    renderDetail(workspaceDetail(engine));

    await screen.findByRole("button", { name: label });
    await waitFor(() => {
      expect(
        screen.queryByRole("combobox", { name: "Workspace model" }),
      ).not.toBeInTheDocument();
    });
  });

  it("offers the notes model and installed local profiles only", async () => {
    mockWorkspaceSetup();

    renderDetail(workspaceDetail("local"));

    const select = await screen.findByRole("combobox", {
      name: "Workspace model",
    });
    expect(select).toHaveValue("");
    expect(
      screen.getByRole("option", { name: "Same as notes model" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("option", { name: "Qwen 4B" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Qwen 27B" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Qwen 35B" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("persists the selected installed model alias", async () => {
    let modelPayload: unknown;
    mockWorkspaceSetup((command, payload) => {
      if (command === "set_workspace_model") {
        modelPayload = payload;
      }
      return null;
    });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderDetail(workspaceDetail("local"), onRefresh);

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Workspace model" }),
      "qwen3.6:27b",
    );

    await waitFor(() => {
      expect(modelPayload).toEqual({ id: 4, model: "qwen3.6:27b" });
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
