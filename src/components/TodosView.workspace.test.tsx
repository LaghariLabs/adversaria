import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
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
    network_allowed: false,
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
  it("sends a triage item to the selected workspace", async () => {
    const taskPayloads: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "get_action_items") return [actionItem];
      if (command === "list_meeting_workspace_bindings") return [];
      if (command === "list_workspaces") return [workspace];
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
        },
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
