import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { MeetingWorkspaceBinding, WorkspaceSummary } from "../../types";
import { WorkspaceBindingBanner } from "./WorkspaceBindingBanner";

const workspaces: WorkspaceSummary[] = [
  {
    workspace: {
      id: 5,
      name: "Internal ops",
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
  },
  {
    workspace: {
      id: 6,
      name: "Client launch",
      engine: "claude",
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
    meeting_count: 2,
    folder_count: 1,
  },
];

describe("WorkspaceBindingBanner", () => {
  it("preselects the suggestion and confirms the workspace binding", async () => {
    let binding: MeetingWorkspaceBinding | null = null;
    let bindingPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "get_meeting_workspace_binding") return binding;
      if (command === "list_workspaces") return workspaces;
      if (command === "suggest_workspace_for_meeting") {
        return {
          workspace_id: 6,
          workspace_name: "Client launch",
          related_meeting_count: 2,
          shared_attendee_count: 1,
        };
      }
      if (command === "set_meeting_workspace_binding") {
        bindingPayload = payload;
        binding = {
          meeting_id: 12,
          workspace_id: 6,
          workspace_name: "Client launch",
        };
        return 2;
      }
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspaceBindingBanner meetingId={12} />);

    const select = await screen.findByRole("combobox", {
      name: "Workspace for this meeting",
    });
    expect(select).toHaveValue("6");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(bindingPayload).toEqual({ meetingId: 12, workspaceId: 6 }),
    );
    expect(
      await screen.findByText("2 to-dos pushed to Client launch"),
    ).toBeVisible();
  });

  it("can mark a meeting as not a project", async () => {
    let binding: MeetingWorkspaceBinding | null = null;
    let bindingPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "get_meeting_workspace_binding") return binding;
      if (command === "list_workspaces") return workspaces;
      if (command === "suggest_workspace_for_meeting") return null;
      if (command === "set_meeting_workspace_binding") {
        bindingPayload = payload;
        binding = {
          meeting_id: 12,
          workspace_id: null,
          workspace_name: "",
        };
        return 0;
      }
      return null;
    });
    const user = userEvent.setup();
    render(<WorkspaceBindingBanner meetingId={12} />);

    await user.click(
      await screen.findByRole("button", { name: "Not a project" }),
    );

    await waitFor(() =>
      expect(bindingPayload).toEqual({ meetingId: 12, workspaceId: null }),
    );
  });

  it("renders nothing when there are no workspaces", async () => {
    let listed = false;
    mockIPC((command) => {
      if (command === "get_meeting_workspace_binding") return null;
      if (command === "list_workspaces") {
        listed = true;
        return [];
      }
      return null;
    });
    const { container } = render(<WorkspaceBindingBanner meetingId={12} />);

    await waitFor(() => expect(listed).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });
});
