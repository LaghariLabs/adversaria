import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ActionItem, WorkspaceSummary } from "../types";
import { pendingMeeting } from "../test/fixtures";
import { TodosView } from "./TodosView";

const actionItem: ActionItem = {
  id: 9,
  meeting_id: 12,
  ord: 0,
  text: "Prepare proposal",
  assignee: "",
  due: "",
  done: false,
  status: "todo",
  completed_by: "",
  completed_at: "",
  evidence: "",
};

const workspace: WorkspaceSummary = {
  workspace: {
    id: 6,
    name: "Client launch",
    engine: "local",
    model: "",
    network_allowed: false,
    instructions: "",
    color: "blue",
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:00:00Z",
  },
  queued_task_count: 0,
  needs_you_count: 0,
  running_task_count: 0,
  awaiting_review_count: 0,
  approved_task_count: 0,
  total_task_count: 0,
  meeting_count: 0,
  folder_count: 0,
};

describe("TodosView workspace menu", () => {
  it("shows four capability chips with the suggestion preselected", async () => {
    const suggestionPayloads: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "get_action_items") return [actionItem];
      if (command === "list_meeting_workspace_bindings") return [];
      if (command === "list_workspaces") return [workspace];
      if (command === "suggest_task_capability") {
        suggestionPayloads.push(payload);
        return "present";
      }
      return null;
    });
    const user = userEvent.setup();
    render(
      <TodosView
        meetings={[pendingMeeting({ id: 12, title: "Client call" })]}
        onOpenMeeting={vi.fn()}
        scopeMeetingId={null}
        onScopeChange={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Workspace actions for Prepare proposal",
      }),
    );

    const group = await screen.findByRole("group", {
      name: "How should AI help",
    });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "+ Research",
      "+ Write",
      "+ Visualize",
      "+ Present",
    ]);
    for (const chip of chips) {
      expect(chip.getAttribute("style")).not.toContain("dashed");
    }
    expect(screen.getByRole("button", { name: "+ Present" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("suggested")).toBeVisible();
    expect(suggestionPayloads).toEqual([
      { title: "Prepare proposal", details: "" },
    ]);
  });

  it("sends the selected capability with a triage item", async () => {
    const taskPayloads: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "get_action_items") return [actionItem];
      if (command === "list_meeting_workspace_bindings") return [];
      if (command === "list_workspaces") return [workspace];
      if (command === "suggest_task_capability") return "present";
      if (command === "create_workspace_task") {
        taskPayloads.push(payload);
        return null;
      }
      return null;
    });
    const user = userEvent.setup();
    render(
      <TodosView
        meetings={[pendingMeeting({ id: 12, title: "Client call" })]}
        onOpenMeeting={vi.fn()}
        scopeMeetingId={null}
        onScopeChange={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Workspace actions for Prepare proposal",
      }),
    );
    expect(await screen.findByRole("menuitem", { name: "Client launch" })).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Client launch" }));

    await waitFor(() =>
      expect(taskPayloads).toEqual([
        {
          workspaceId: 6,
          title: "Prepare proposal",
          details: "",
          sourceMeetingId: 12,
          actionItemId: 9,
          capability: "present",
        },
      ]),
    );
  });

  it("stages a workspace click until a capability is picked, then sends", async () => {
    const taskPayloads: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "get_action_items") return [actionItem];
      if (command === "list_meeting_workspace_bindings") return [];
      if (command === "list_workspaces") return [workspace];
      if (command === "suggest_task_capability") return null;
      if (command === "create_workspace_task") {
        taskPayloads.push(payload);
        return null;
      }
      return null;
    });
    const user = userEvent.setup();
    render(
      <TodosView
        meetings={[pendingMeeting({ id: 12, title: "Client call" })]}
        onOpenMeeting={vi.fn()}
        scopeMeetingId={null}
        onScopeChange={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Workspace actions for Prepare proposal",
      }),
    );

    const row = await screen.findByRole("menuitem", { name: "Client launch" });
    expect(row).toBeEnabled();
    expect(screen.getByText("Pick how AI should help first")).toBeVisible();

    // Clicking a workspace first stages the send instead of firing it.
    await user.click(row);
    expect(taskPayloads).toEqual([]);
    expect(
      screen.getByText("Pick how AI should help, then this sends to Client launch"),
    ).toBeVisible();

    // Picking a capability completes the staged send.
    await user.click(screen.getByRole("button", { name: "+ Research" }));
    await waitFor(() =>
      expect(taskPayloads).toEqual([
        expect.objectContaining({ workspaceId: 6, capability: "research" }),
      ]),
    );
  });

  it("shows the workspace routed from the source meeting", async () => {
    mockIPC((command) => {
      if (command === "get_action_items") return [actionItem];
      if (command === "list_meeting_workspace_bindings") {
        return [
          {
            meeting_id: 12,
            workspace_id: 6,
            workspace_name: "Client launch",
          },
        ];
      }
      return null;
    });

    render(
      <TodosView
        meetings={[pendingMeeting({ id: 12, title: "Client call" })]}
        onOpenMeeting={vi.fn()}
        scopeMeetingId={null}
        onScopeChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("→ Client launch")).toBeVisible();
  });

  it("shows workspace routing controls on a meeting-scoped board", async () => {
    mockIPC((command) => {
      if (command === "get_action_items") return [actionItem];
      if (command === "list_meeting_workspace_bindings") return [];
      if (command === "list_workspaces") return [workspace];
      if (command === "get_meeting_workspace_binding") return null;
      if (command === "suggest_workspace_for_meeting") return null;
      return null;
    });

    render(
      <TodosView
        meetings={[pendingMeeting({ id: 12, title: "Client call" })]}
        onOpenMeeting={vi.fn()}
        scopeMeetingId={12}
        onScopeChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Confirm" }),
    ).toBeVisible();
  });

  it("routes a to-do's meeting to the scoped board from its menu", async () => {
    const onScopeChange = vi.fn();
    mockIPC((command) => {
      if (command === "get_action_items") return [actionItem];
      if (command === "list_meeting_workspace_bindings") return [];
      if (command === "list_workspaces") return [workspace];
      return null;
    });
    const user = userEvent.setup();
    render(
      <TodosView
        meetings={[pendingMeeting({ id: 12, title: "Client call" })]}
        onOpenMeeting={vi.fn()}
        scopeMeetingId={null}
        onScopeChange={onScopeChange}
      />,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Workspace actions for Prepare proposal",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", {
        name: "Route this meeting's to-dos…",
      }),
    );

    expect(onScopeChange).toHaveBeenCalledWith(12);
  });
});
