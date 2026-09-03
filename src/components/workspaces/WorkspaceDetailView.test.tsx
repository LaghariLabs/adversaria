import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ModelProfile,
  SetupStatus,
  WorkspaceAddon,
  WorkspaceDetail,
  WorkspaceEngine,
  WorkspaceRun,
  WorkspaceTask,
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

const drawioSkill: WorkspaceAddon = {
  id: 21,
  kind: "skill",
  slug: "drawio-diagram",
  name: "Draw.io diagram",
  description: "Creates editable diagrams.",
  instructions: "Produce a draw.io file.",
  builtin: true,
  created_at: "2026-08-25T10:00:00Z",
};

const researchSkill: WorkspaceAddon = {
  id: 22,
  kind: "skill",
  slug: "deep-research",
  name: "Deep research",
  description: "Produces grounded research.",
  instructions: "Research before writing.",
  builtin: true,
  created_at: "2026-08-25T10:00:00Z",
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

function workspaceTask(overrides: Partial<WorkspaceTask> = {}): WorkspaceTask {
  return {
    id: 41,
    workspace_id: 4,
    title: "Prepare launch plan",
    details: "",
    capability: "write",
    status: "queued",
    source_meeting_id: null,
    source_meeting_title: "",
    action_item_id: null,
    attempt: 1,
    rejection_notes: [],
    agent_eligible: true,
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
    ...overrides,
  };
}

function workspaceRun(report: string): WorkspaceRun {
  return {
    id: 51,
    workspace_id: 4,
    task_id: 41,
    engine: "local",
    status: "done",
    log: "Context: 1 meeting, 0 related meetings.",
    report,
    error: "",
    started_at: "2026-08-25T10:00:00Z",
    finished_at: "2026-08-25T10:01:00Z",
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
  catalog: WorkspaceAddon[] = [],
) {
  mockIPC((command, payload) => {
    if (command === "detect_workspace_engines") return engines;
    if (command === "get_setup_status") return setupStatus;
    if (command === "list_workspace_addons") return catalog;
    if (command === "get_context_sources") {
      return { vault_path: "", projects_root: "" };
    }
    return onCommand?.(command, payload) ?? null;
  });
}

describe("WorkspaceDetailView two-pane project screen", () => {
  it("renders what the project knows with singular and plural counts", async () => {
    const detail: WorkspaceDetail = {
      ...workspaceDetail("local"),
      context_items: [
        {
          id: 1,
          workspace_id: 4,
          kind: "meeting",
          value: "11",
          label: "Kickoff",
          created_at: "2026-08-25T10:00:00Z",
        },
        {
          id: 2,
          workspace_id: 4,
          kind: "meeting",
          value: "12",
          label: "Design review",
          created_at: "2026-08-25T10:00:00Z",
        },
        {
          id: 3,
          workspace_id: 4,
          kind: "folder",
          value: "/tmp/launch",
          label: "launch",
          created_at: "2026-08-25T10:00:00Z",
        },
      ],
      addons: [drawioSkill, researchSkill],
      tasks: [workspaceTask({ status: "done" })],
    };
    mockWorkspaceSetup(undefined, [drawioSkill, researchSkill]);

    renderDetail(detail);

    expect(
      await screen.findByText(
        "2 meetings · 1 folder · 2 skills attached · 1 task done",
      ),
    ).toBeVisible();
  });

  it("lists workspace folders as read-only grounding", async () => {
    const folderPath = "/Users/hamza/MyProjects/launch-planning";
    const detail: WorkspaceDetail = {
      ...workspaceDetail("local"),
      context_items: [
        {
          id: 3,
          workspace_id: 4,
          kind: "folder",
          value: folderPath,
          label: "launch-planning",
          created_at: "2026-08-25T10:00:00Z",
        },
      ],
    };
    mockWorkspaceSetup();

    renderDetail(detail);

    const projectBrain = screen.getByRole("complementary", {
      name: "Project brain",
    });
    const groundedHeading = within(projectBrain).getByRole("heading", {
      name: "Grounded in",
    });
    const groundedCard = groundedHeading.closest("section");
    if (!(groundedCard instanceof HTMLElement)) {
      throw new Error("Grounded in card not found");
    }
    expect(within(groundedCard).getByText(folderPath)).toHaveAttribute(
      "title",
      folderPath,
    );
    expect(within(groundedCard).getByText("read-only")).toHaveClass(
      "ws-read-only-tag",
    );
  });

  it("previews what would ground a drafted task", async () => {
    mockWorkspaceSetup((command) => {
      if (command === "preview_task_grounding") {
        return {
          related_meeting_count: 2,
          latest_related_title: "Launch readiness review",
          vault_hit_count: 4,
          top_vault_label: "Go-to-market notes",
          project_hit_count: 3,
        };
      }
      return null;
    });
    const user = userEvent.setup();
    renderDetail(workspaceDetail("local"));

    await user.type(
      screen.getByRole("textbox", { name: "Task title" }),
      "Draft the launch brief",
    );

    const projectBrain = screen.getByRole("complementary", {
      name: "Project brain",
    });
    expect(
      await within(projectBrain).findByText(
        "2 related meetings · latest: Launch readiness review",
        {},
        { timeout: 2000 },
      ),
    ).toBeVisible();
    expect(
      within(projectBrain).getByText("4 vault hits · top: Go-to-market notes"),
    ).toBeVisible();
    expect(
      within(projectBrain).getByText("3 project folder matches"),
    ).toBeVisible();
  });

  it("renders Web research in the right pane and persists its switch", async () => {
    let networkPayload: unknown;
    mockWorkspaceSetup((command, payload) => {
      if (command === "set_workspace_network_allowed") {
        networkPayload = payload;
      }
      return null;
    });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderDetail(workspaceDetail("local"), onRefresh);

    const projectBrain = screen.getByRole("complementary", {
      name: "Project brain",
    });
    await user.click(
      within(projectBrain).getByRole("switch", { name: "Web research" }),
    );

    await waitFor(() => {
      expect(networkPayload).toEqual({ id: 4, allowed: true });
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("uses Needs you for tasks awaiting review", async () => {
    const detail: WorkspaceDetail = {
      ...workspaceDetail("local"),
      tasks: [workspaceTask({ status: "awaiting_review" })],
    };
    mockWorkspaceSetup();

    renderDetail(detail);

    expect(await screen.findByText("Needs you · 1")).toBeVisible();
    expect(
      screen.queryByText(/Awaiting your review/),
    ).not.toBeInTheDocument();
  });

  it("runs a queued task from its compact row", async () => {
    let runPayload: unknown;
    const detail: WorkspaceDetail = {
      ...workspaceDetail("local"),
      tasks: [workspaceTask()],
    };
    mockWorkspaceSetup((command, payload) => {
      if (command === "run_workspace_task") {
        runPayload = payload;
        return workspaceRun("Finished the launch plan.");
      }
      return null;
    });
    const user = userEvent.setup();

    renderDetail(detail);

    const runButton = await screen.findByRole("button", { name: "Run" });
    await waitFor(() => expect(runButton).toBeEnabled());
    await user.click(runButton);

    await waitFor(() =>
      expect(runPayload).toMatchObject({ taskId: 41, engine: "local" }),
    );
  });

  it("keeps a review task collapsed until its row is clicked", async () => {
    const report =
      "Produced a launch plan and left the release date undecided.";
    const detail: WorkspaceDetail = {
      ...workspaceDetail("local"),
      tasks: [workspaceTask({ status: "awaiting_review" })],
      artifacts: [
        {
          id: 71,
          workspace_id: 4,
          run_id: 51,
          name: "launch-plan.md",
          path: "/tmp/launch-plan.md",
          created_at: "2026-08-25T10:01:00Z",
        },
      ],
    };
    mockWorkspaceSetup((command) => {
      if (command === "get_latest_workspace_run") return workspaceRun(report);
      if (command === "read_workspace_artifact") return "# Launch plan";
      return null;
    });

    renderDetail(detail);

    await screen.findByRole("button", { name: "Reveal in Finder" });
    const taskRow = screen.getByRole("button", {
      name: "Prepare launch plan details",
    });
    expect(taskRow).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(report)).not.toBeInTheDocument();
    expect(screen.queryByText("launch-plan.md")).not.toBeInTheDocument();

    await userEvent.click(taskRow);

    const reportText = await screen.findByText(report);
    const artifactName = screen.getByText("launch-plan.md");
    expect(taskRow).toHaveAttribute("aria-expanded", "true");
    expect(reportText).toHaveClass("ws-task-report");
    expect(
      reportText.compareDocumentPosition(artifactName) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("rejects with feedback and immediately reruns the task", async () => {
    const commands: string[] = [];
    let rejectPayload: unknown;
    let runPayload: unknown;
    const detail: WorkspaceDetail = {
      ...workspaceDetail("local"),
      tasks: [workspaceTask({ status: "awaiting_review" })],
    };
    mockWorkspaceSetup((command, payload) => {
      if (command === "get_latest_workspace_run") {
        return workspaceRun("Drafted the launch plan.");
      }
      if (command === "reject_workspace_task") {
        commands.push(command);
        rejectPayload = payload;
        return null;
      }
      if (command === "run_workspace_task") {
        commands.push(command);
        runPayload = payload;
        return workspaceRun("Revised the launch plan.");
      }
      return null;
    });
    const user = userEvent.setup();

    renderDetail(detail);

    const taskRow = await screen.findByRole("button", {
      name: "Prepare launch plan details",
    });
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(taskRow).toHaveAttribute("aria-expanded", "false");

    const feedback = screen.getByPlaceholderText("What should be different?");
    await user.type(feedback, "Make the risks more specific");
    await user.click(screen.getByRole("button", { name: "Rerun" }));

    await waitFor(() => {
      expect(rejectPayload).toEqual({
        taskId: 41,
        reason: "Make the risks more specific",
      });
      expect(runPayload).toMatchObject({ taskId: 41, engine: "local" });
    });
    expect(commands).toEqual(["reject_workspace_task", "run_workspace_task"]);
    expect(
      screen.queryByPlaceholderText("What should be different?"),
    ).not.toBeInTheDocument();
  });

  it("omits the report paragraph when an expanded run report is empty", async () => {
    const detail: WorkspaceDetail = {
      ...workspaceDetail("local"),
      tasks: [workspaceTask({ status: "awaiting_review" })],
    };
    mockWorkspaceSetup((command) => {
      if (command === "get_latest_workspace_run") return workspaceRun("");
      return null;
    });

    renderDetail(detail);

    const taskRow = await screen.findByRole("button", {
      name: "Prepare launch plan details",
    });
    await userEvent.click(taskRow);
    const taskBlock = taskRow.closest(".ws-task-block");
    expect(taskBlock?.querySelector(".ws-task-report")).toBeNull();
  });

  it("saves edited standing instructions", async () => {
    let instructionsPayload: unknown;
    mockWorkspaceSetup((command, payload) => {
      if (command === "set_workspace_instructions") {
        instructionsPayload = payload;
        return null;
      }
      return null;
    });
    const user = userEvent.setup();
    renderDetail(workspaceDetail("local"));

    const projectBrain = screen.getByRole("complementary", {
      name: "Project brain",
    });
    await user.type(
      within(projectBrain).getByRole("textbox", {
        name: "Standing instructions",
      }),
      "Prioritize launch risks.",
    );
    await user.click(within(projectBrain).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(instructionsPayload).toEqual({
        id: 4,
        instructions: "Prioritize launch risks.",
      });
    });
  });

  it("reveals the engine and sources only after Project settings opens", async () => {
    mockWorkspaceSetup((command) => {
      if (command === "get_context_sources") {
        return {
          vault_path: "/Users/hamza/laghari-vault",
          projects_root: "/Users/hamza/MyProjects",
        };
      }
      return null;
    });
    const user = userEvent.setup();
    renderDetail(workspaceDetail("local"));

    const settingsButton = screen.getByRole("button", {
      name: "Project settings",
    });
    expect(settingsButton).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("group", { name: "Workspace engine" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Vault notes via search")).not.toBeInTheDocument();

    await user.click(settingsButton);

    const settings = screen.getByRole("heading", {
      name: "Project settings",
    }).parentElement;
    if (!(settings instanceof HTMLElement)) {
      throw new Error("Project settings section not found");
    }
    expect(settingsButton).toHaveAttribute("aria-expanded", "true");
    expect(
      within(settings).getByRole("group", { name: "Workspace engine" }),
    ).toBeVisible();
    expect(within(settings).getByText("Vault notes via search")).toBeVisible();
  });
});

describe("WorkspaceDetailView task capabilities", () => {
  it("renders four capability chips without missing states", async () => {
    mockWorkspaceSetup();
    renderDetail(workspaceDetail("local"));

    const group = await screen.findByRole("group", { name: "How should AI help" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "+ Research",
      "+ Write",
      "+ Visualize",
      "+ Present",
    ]);
    for (const chip of chips) {
      expect(chip.getAttribute("style")).not.toContain("dashed");
      expect(chip).not.toHaveAttribute("title");
    }
  });

  it("keeps Create disabled until a capability is selected", async () => {
    mockWorkspaceSetup();
    const user = userEvent.setup();
    renderDetail(workspaceDetail("local"));

    await user.type(await screen.findByRole("textbox", { name: "Task title" }), "Draft");

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("creates a Research task with the selected capability", async () => {
    let createPayload: unknown;
    mockWorkspaceSetup((command, payload) => {
      if (command === "create_workspace_task") {
        createPayload = payload;
        return null;
      }
      return null;
    }, [researchSkill]);
    const user = userEvent.setup();
    renderDetail(workspaceDetail("local"));

    await user.type(
      await screen.findByRole("textbox", { name: "Task title" }),
      "Compare competitors",
    );
    await user.click(screen.getByRole("button", { name: "+ Research" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(createPayload).toEqual({
        workspaceId: 4,
        title: "Compare competitors",
        details: "",
        sourceMeetingId: null,
        actionItemId: null,
        capability: "research",
      }),
    );
  });

  it("marks a confident visualize match as suggested", async () => {
    mockWorkspaceSetup((command) => {
      if (command === "suggest_task_capability") return "visualize";
      return null;
    }, [drawioSkill]);
    const user = userEvent.setup();
    renderDetail(workspaceDetail("local"));

    await user.type(
      await screen.findByRole("textbox", { name: "Task title" }),
      "Diagram the auth flow",
    );

    expect(
      await screen.findByText("suggested", {}, { timeout: 1500 }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "+ Visualize" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows the baseline hint when no adapter is installed", async () => {
    mockWorkspaceSetup();
    const user = userEvent.setup();
    renderDetail(workspaceDetail("local"));

    await user.click(
      await screen.findByRole("button", { name: "+ Visualize" }),
    );

    expect(
      screen.getByText("Runs as HTML/SVG baseline, exports PNG and SVG."),
    ).toHaveStyle({ fontSize: "11px", color: "var(--text-muted)" });
  });

  it("renders the capability badge in the compact task row", async () => {
    const detail: WorkspaceDetail = {
      ...workspaceDetail("local"),
      tasks: [workspaceTask({ capability: "write" })],
    };
    mockWorkspaceSetup();
    renderDetail(detail);

    const title = await screen.findByText("Prepare launch plan");
    const row = title.closest(".ws-task-row");
    if (!(row instanceof HTMLElement)) {
      throw new Error("Task row not found");
    }
    expect(within(row).getByText("Write")).toHaveStyle({
      background: "rgba(175, 82, 222, 0.12)",
      color: "rgb(225, 179, 255)",
    });
  });
});

describe("WorkspaceDetailView model selection", () => {
  it.each([
    ["codex", "Codex"],
    ["claude", "Claude Code"],
  ])("does not render the model select for the %s engine", async (engine, label) => {
    mockWorkspaceSetup();
    const user = userEvent.setup();

    renderDetail(workspaceDetail(engine));

    await user.click(screen.getByRole("button", { name: "Project settings" }));
    await screen.findByRole("button", { name: label });
    await waitFor(() => {
      expect(
        screen.queryByRole("combobox", { name: "Workspace model" }),
      ).not.toBeInTheDocument();
    });
  });

  it("offers the notes model and installed local profiles only", async () => {
    mockWorkspaceSetup();
    const user = userEvent.setup();

    renderDetail(workspaceDetail("local"));

    await user.click(screen.getByRole("button", { name: "Project settings" }));
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

    await user.click(screen.getByRole("button", { name: "Project settings" }));
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
