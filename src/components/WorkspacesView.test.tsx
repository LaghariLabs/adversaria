import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  WorkspaceAddon,
  WorkspaceDetail,
  WorkspaceEngine,
  WorkspaceRun,
  WorkspaceSummary,
  WorkspaceTask,
} from "../types";
import { WorkspacesView } from "./WorkspacesView";

const summary: WorkspaceSummary = {
  workspace: {
    id: 4,
    name: "Launch planning",
    engine: "local",
    model: "",
    network_allowed: false,
    instructions: "",
    color: "blue",
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:00:00Z",
  },
  queued_task_count: 1,
  needs_you_count: 1,
  running_task_count: 1,
  awaiting_review_count: 3,
  approved_task_count: 4,
  total_task_count: 9,
  meeting_count: 3,
  folder_count: 1,
};

const detail: WorkspaceDetail = {
  workspace: summary.workspace,
  context_items: [],
  addons: [],
  tasks: [],
  artifacts: [],
};

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
    available: false,
    version: "",
    detail: "Codex CLI not found on this Mac.",
  },
];

const attachedSkill: WorkspaceAddon = {
  id: 6,
  kind: "skill",
  slug: "architecture-doc",
  name: "Architecture doc",
  description: "Grounded architecture writing.",
  instructions: "Reference files by path.",
  builtin: true,
  created_at: "2026-08-22T10:00:00Z",
};

function workspaceTask(overrides: Partial<WorkspaceTask> = {}): WorkspaceTask {
  return {
    id: 11,
    workspace_id: 4,
    title: "Draft launch memo",
    details: "",
    capability: "",
    status: "queued",
    source_meeting_id: null,
    source_meeting_title: "",
    action_item_id: null,
    attempt: 1,
    rejection_notes: [],
    agent_eligible: true,
    created_at: "2026-08-18T10:00:00Z",
    updated_at: "2026-08-18T10:00:00Z",
    ...overrides,
  };
}

const finishedRun: WorkspaceRun = {
  id: 21,
  workspace_id: 4,
  task_id: 11,
  engine: "local",
  status: "done",
  log: "# Launch memo",
  report: "",
  error: "",
  started_at: "2026-08-18T10:59:00Z",
  finished_at: "2026-08-18T11:00:00Z",
};

describe("WorkspacesView", () => {
  it("renders the workspace empty state", async () => {
    mockIPC((command) => {
      if (command === "list_workspaces") return [];
      if (command === "get_agents_paused") return false;
      if (command === "plugin:event|listen") return null;
      return null;
    });
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    expect(
      await screen.findByText(
        "A workspace is where meeting work gets done. Create one, add context, and send it an action item.",
      ),
    ).toBeVisible();
  });

  it("renders workspace card counts", async () => {
    mockIPC((command) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_agents_paused") return false;
      if (command === "plugin:event|listen") return null;
      return null;
    });
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    expect(await screen.findByText("Launch planning")).toBeVisible();
    expect(screen.getByText("4/9")).toBeVisible();
    expect(screen.getByText("awaiting review")).toHaveTextContent(
      "3 awaiting review",
    );
    expect(screen.getByText(/queued/)).toHaveTextContent(
      "1 queued · 1 need you",
    );
  });

  it("lets the user return a needs-you task to the agent queue", async () => {
    const needsYouDetail: WorkspaceDetail = {
      ...detail,
      tasks: [workspaceTask({ agent_eligible: false })],
    };
    let eligibilityPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") return needsYouDetail;
      if (command === "list_workspace_addons") return [];
      if (command === "detect_workspace_engines") return engines;
      if (command === "get_agents_paused") return false;
      if (command === "get_latest_workspace_run") return null;
      if (command === "set_workspace_task_agent_eligible") {
        eligibilityPayload = payload;
        return null;
      }
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    await user.click(
      await screen.findByRole("button", {
        name: "Draft launch memo details",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Let an agent try" }),
    );

    await waitFor(() =>
      expect(eligibilityPayload).toEqual({ taskId: 11, eligible: true }),
    );
  });

  it("pauses and resumes all agents", async () => {
    let paused = false;
    let pausePayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_agents_paused") return paused;
      if (command === "set_agents_paused") {
        pausePayload = payload;
        paused = (payload as { paused: boolean }).paused;
        return null;
      }
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(
      await screen.findByRole("button", { name: "Pause all agents" }),
    );

    expect(pausePayload).toEqual({ paused: true });
    expect(
      await screen.findByRole("button", { name: "Resume agents" }),
    ).toBeVisible();
  });

  it("loads workspace detail when a card is opened", async () => {
    const commands: string[] = [];
    mockIPC((command) => {
      commands.push(command);
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") return detail;
      if (command === "list_workspace_addons") return [];
      if (command === "get_agents_paused") return false;
      if (command === "get_latest_workspace_run") return null;
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    const title = await screen.findByText("Launch planning");
    const card = title.closest(".ws-card");
    if (!(card instanceof HTMLElement)) throw new Error("Workspace card not found");
    await user.click(card);

    await waitFor(() => expect(commands).toContain("get_workspace"));
    expect(await screen.findByText("Tasks")).toBeVisible();
  });

  it("shows vault and project search as automatic context", async () => {
    mockIPC((command) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") return detail;
      if (command === "get_agents_paused") return false;
      if (command === "get_latest_workspace_run") return null;
      if (command === "get_context_sources") {
        return {
          vault_path: "/Users/hamza/laghari-vault",
          projects_root: "/Users/hamza/MyProjects",
        };
      }
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    await user.click(screen.getByRole("button", { name: "Project settings" }));

    expect(await screen.findByText("Vault notes via search")).toBeVisible();
    expect(screen.getByText("Projects via search")).toBeVisible();
    expect(screen.getByText("/Users/hamza/laghari-vault")).toBeVisible();
    expect(screen.getByText("/Users/hamza/MyProjects")).toBeVisible();
  });

  it("renders engine availability and changes to an available engine", async () => {
    let enginePayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") return detail;
      if (command === "list_workspace_addons") return [];
      if (command === "detect_workspace_engines") return engines;
      if (command === "get_agents_paused") return false;
      if (command === "get_latest_workspace_run") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "set_workspace_engine") {
        enginePayload = payload;
        return null;
      }
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    await user.click(screen.getByRole("button", { name: "Project settings" }));
    expect(await screen.findByText("Local model")).toBeVisible();
    expect(document.querySelectorAll(".ws-engine-chip")).toHaveLength(3);
    const unavailable = screen.getByText("Codex");
    expect(unavailable).toHaveClass("ws-engine-chip--dimmed");
    expect(unavailable).toHaveAttribute("title", "Codex CLI not found on this Mac.");

    await user.click(screen.getByRole("button", { name: "Claude Code" }));
    await waitFor(() =>
      expect(enginePayload).toMatchObject({ id: 4, engine: "claude" }),
    );
  });

  it("shows staffing on its queued task instead of in the Context pane", async () => {
    const detailWithSkill: WorkspaceDetail = {
      ...detail,
      addons: [attachedSkill],
      tasks: [workspaceTask()],
    };
    mockIPC((command) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") return detailWithSkill;
      if (command === "list_workspace_addons") return [attachedSkill];
      if (command === "get_workspace_task_staffing") {
        return {
          mode: "manual",
          agent_id: null,
          skill_ids: [attachedSkill.id],
          reason: "",
          resolved_at: "2026-08-25T10:05:00Z",
        };
      }
      if (command === "detect_workspace_engines") return engines;
      if (command === "get_agents_paused") return false;
      if (command === "get_latest_workspace_run") return null;
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    await user.click(
      await screen.findByRole("button", {
        name: "Draft launch memo details",
      }),
    );

    expect(
      await screen.findByText("Runs as Architecture doc · Local model"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Architecture doc" }),
    ).not.toBeInTheDocument();
  });

  it("runs a task, refreshes artifacts, and opens the produced file", async () => {
    const taskDetail: WorkspaceDetail = {
      ...detail,
      tasks: [workspaceTask()],
    };
    const refreshedDetail: WorkspaceDetail = {
      ...taskDetail,
      tasks: [{ ...taskDetail.tasks[0], status: "awaiting_review" }],
      artifacts: [
        {
          id: 31,
          workspace_id: 4,
          run_id: 21,
          name: "draft.md",
          path: "/tmp/workspaces/4/run-21/draft.md",
          created_at: "2026-08-18T11:00:00Z",
        },
      ],
    };
    let getWorkspaceCalls = 0;
    let runPayload: unknown;
    let openPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") {
        getWorkspaceCalls += 1;
        return getWorkspaceCalls === 1 ? taskDetail : refreshedDetail;
      }
      if (command === "list_workspace_addons") return [];
      if (command === "detect_workspace_engines") return engines;
      if (command === "get_agents_paused") return false;
      if (command === "get_latest_workspace_run") return finishedRun;
      if (command === "plugin:event|listen") return null;
      if (command === "run_workspace_task") {
        runPayload = payload;
        return finishedRun;
      }
      if (command === "open_workspace_artifact") {
        openPayload = payload;
        return null;
      }
      if (command === "read_workspace_artifact") return "# Launch memo";
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    await user.click(await screen.findByRole("button", { name: "Run" }));

    await waitFor(() =>
      expect(runPayload).toMatchObject({ taskId: 11, engine: "local" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Draft launch memo details",
      }),
    );
    expect(await screen.findByText("Run log")).toBeVisible();
    expect(await screen.findByText("draft.md")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(openPayload).toMatchObject({
        path: "/tmp/workspaces/4/run-21/draft.md",
      }),
    );
  });

  it("keeps review details collapsed and previews an artifact on demand", async () => {
    const reviewDetail: WorkspaceDetail = {
      ...detail,
      tasks: [workspaceTask({ status: "awaiting_review" })],
      artifacts: [
        {
          id: 31,
          workspace_id: 4,
          run_id: 21,
          name: "plan.md",
          path: "/tmp/workspaces/4/run-21/plan.md",
          created_at: "2026-08-18T11:00:00Z",
        },
      ],
    };
    mockIPC((command) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") return reviewDetail;
      if (command === "list_workspace_addons") return [];
      if (command === "detect_workspace_engines") return engines;
      if (command === "get_agents_paused") return false;
      if (command === "get_latest_workspace_run") return finishedRun;
      if (command === "read_workspace_artifact") return "# Plan\n\n- one\n- two";
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    const taskRow = await screen.findByRole("button", {
      name: "Draft launch memo details",
    });
    expect(taskRow).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("heading", { name: "Plan", level: 1 }),
    ).not.toBeInTheDocument();

    await user.click(taskRow);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const heading = await screen.findByRole("heading", {
      name: "Plan",
      level: 1,
    });
    expect(heading.closest(".ws-task-details")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("heading", { name: "Plan", level: 1 })).toBeNull();
  });

  it("previews a general artifact and reveals it in Finder", async () => {
    const artifactPath = "/tmp/workspaces/4/run-20/notes.md";
    const artifactDetail: WorkspaceDetail = {
      ...detail,
      artifacts: [
        {
          id: 32,
          workspace_id: 4,
          run_id: 20,
          name: "notes.md",
          path: artifactPath,
          created_at: "2026-08-18T11:00:00Z",
        },
      ],
    };
    let revealPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") return artifactDetail;
      if (command === "list_workspace_addons") return [];
      if (command === "detect_workspace_engines") return engines;
      if (command === "get_agents_paused") return false;
      if (command === "read_workspace_artifact") return "# Notes";
      if (command === "reveal_workspace_artifact") {
        revealPayload = payload;
        return null;
      }
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    await user.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("heading", { name: "Notes", level: 1 })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    await waitFor(() => expect(revealPayload).toEqual({ path: artifactPath }));
  });

  it("offers draw.io artifacts without reading them into the preview", async () => {
    const artifactPath = "/tmp/workspaces/4/run-20/architecture.drawio";
    const artifactDetail: WorkspaceDetail = {
      ...detail,
      artifacts: [
        {
          id: 33,
          workspace_id: 4,
          run_id: 20,
          name: "architecture.drawio",
          path: artifactPath,
          created_at: "2026-08-18T11:00:00Z",
        },
      ],
    };
    let readCalls = 0;
    let openPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") return artifactDetail;
      if (command === "list_workspace_addons") return [];
      if (command === "detect_workspace_engines") return engines;
      if (command === "get_agents_paused") return false;
      if (command === "read_workspace_artifact") {
        readCalls += 1;
        return "diagram source";
      }
      if (command === "open_workspace_artifact") {
        openPayload = payload;
        return null;
      }
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    await user.click(await screen.findByRole("button", { name: "Preview" }));

    expect(await screen.findByText("Diagram — opens in draw.io")).toBeVisible();
    expect(readCalls).toBe(0);
    await user.click(screen.getByRole("button", { name: "Open in draw.io" }));
    await waitFor(() => expect(openPayload).toEqual({ path: artifactPath }));
  });

  it("approves a task awaiting review and refreshes the workspace", async () => {
    const reviewDetail: WorkspaceDetail = {
      ...detail,
      tasks: [workspaceTask({ status: "awaiting_review" })],
    };
    let approvePayload: unknown;
    let getWorkspaceCalls = 0;
    mockIPC((command, payload) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") {
        getWorkspaceCalls += 1;
        return reviewDetail;
      }
      if (command === "list_workspace_addons") return [];
      if (command === "detect_workspace_engines") return engines;
      if (command === "get_agents_paused") return false;
      if (command === "get_latest_workspace_run") return finishedRun;
      if (command === "approve_workspace_task") {
        approvePayload = payload;
        return null;
      }
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    expect(await screen.findByText("Needs you · 1")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(approvePayload).toEqual({ taskId: 11 }));
    await waitFor(() => expect(getWorkspaceCalls).toBeGreaterThan(1));
  });

  it("rejects a task with a required re-run note", async () => {
    const reviewDetail: WorkspaceDetail = {
      ...detail,
      tasks: [workspaceTask({ status: "awaiting_review" })],
    };
    let rejectPayload: unknown;
    let runPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "list_workspaces") return [summary];
      if (command === "get_workspace") return reviewDetail;
      if (command === "list_workspace_addons") return [];
      if (command === "detect_workspace_engines") return engines;
      if (command === "get_agents_paused") return false;
      if (command === "get_latest_workspace_run") return finishedRun;
      if (command === "reject_workspace_task") {
        rejectPayload = payload;
        return null;
      }
      if (command === "run_workspace_task") {
        runPayload = payload;
        return finishedRun;
      }
      if (command === "plugin:event|listen") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspacesView onOpenMeeting={vi.fn()} />);

    await user.click(await screen.findByText("Launch planning"));
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    const submit = screen.getByRole("button", { name: "Rerun" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: "Rejection reason" }), "Too long");
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(rejectPayload).toEqual({ taskId: 11, reason: "Too long" }),
    );
    await waitFor(() =>
      expect(runPayload).toMatchObject({ taskId: 11, engine: "local" }),
    );
  });
});
