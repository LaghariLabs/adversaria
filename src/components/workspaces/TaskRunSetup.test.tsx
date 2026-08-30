import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { TaskStaffing, WorkspaceAddon } from "../../types";
import { TaskRunSetup } from "./TaskRunSetup";

const diagrammer: WorkspaceAddon = {
  id: 1,
  kind: "agent",
  slug: "diagrammer",
  name: "Diagrammer",
  description: "Plans clear visual explanations.",
  instructions: "Turn the task into a diagram.",
  builtin: true,
  created_at: "2026-08-25T10:00:00Z",
};

const drawIo: WorkspaceAddon = {
  id: 2,
  kind: "skill",
  slug: "draw-io-diagram",
  name: "Draw.io diagram",
  description: "Creates editable diagrams.",
  instructions: "Produce a draw.io file.",
  builtin: true,
  created_at: "2026-08-25T10:00:00Z",
};

const meetingBrief: WorkspaceAddon = {
  id: 3,
  kind: "skill",
  slug: "meeting-brief",
  name: "Meeting brief",
  description: "Summarizes decisions and next steps.",
  instructions: "Write a concise meeting brief.",
  builtin: true,
  created_at: "2026-08-25T10:00:00Z",
};

const catalog = [diagrammer, drawIo, meetingBrief];
const reason = 'because the task mentions "diagram"';
const automaticStaffing: TaskStaffing = {
  mode: "automatic",
  agent_id: diagrammer.id,
  skill_ids: [drawIo.id],
  reason,
  resolved_at: "2026-08-25T10:05:00Z",
};

describe("TaskRunSetup", () => {
  it("renders the collapsed staffing summary and reason", async () => {
    mockIPC((command) => {
      if (command === "get_workspace_task_staffing") return automaticStaffing;
      return null;
    });

    render(<TaskRunSetup taskId={42} catalog={catalog} />);

    expect(
      await screen.findByText(
        "Run setup: Automatic · Diagrammer + Draw.io diagram",
      ),
    ).toBeVisible();
    expect(screen.getByText(reason)).toBeVisible();
  });

  it("omits the reason line when staffing has no reason", async () => {
    mockIPC((command) => {
      if (command === "get_workspace_task_staffing") {
        return { ...automaticStaffing, reason: "" };
      }
      return null;
    });

    render(<TaskRunSetup taskId={42} catalog={catalog} />);

    expect(
      await screen.findByText(
        "Run setup: Automatic · Diagrammer + Draw.io diagram",
      ),
    ).toBeVisible();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });

  it("shows mode choices and manual catalog descriptions", async () => {
    mockIPC((command) => {
      if (command === "get_workspace_task_staffing") return automaticStaffing;
      return null;
    });
    const user = userEvent.setup();
    render(<TaskRunSetup taskId={42} catalog={catalog} />);

    await user.click(await screen.findByRole("button", { name: "Change" }));

    expect(
      screen.getByRole("radio", { name: /Automatic \(recommended\)/ }),
    ).toBeVisible();
    const manualOption = screen.getByRole("radio", {
      name: "Choose manually",
    });
    expect(manualOption).toBeVisible();
    await user.click(manualOption);

    expect(
      screen.getByRole("radio", {
        name: /Diagrammer.*Plans clear visual explanations\./,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: /Draw.io diagram.*Creates editable diagrams\./,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: /Meeting brief.*Summarizes decisions and next steps\./,
      }),
    ).toBeVisible();
  });

  it("saves the selected manual staffing", async () => {
    let savePayload: unknown;
    const saved: TaskStaffing = {
      mode: "manual",
      agent_id: diagrammer.id,
      skill_ids: [meetingBrief.id],
      reason: "",
      resolved_at: "2026-08-25T10:10:00Z",
    };
    mockIPC((command, payload) => {
      if (command === "get_workspace_task_staffing") return null;
      if (command === "set_workspace_task_staffing") {
        savePayload = payload;
        return saved;
      }
      return null;
    });
    const user = userEvent.setup();
    render(<TaskRunSetup taskId={42} catalog={catalog} />);

    await user.click(await screen.findByRole("button", { name: "Change" }));
    await user.click(screen.getByRole("radio", { name: "Choose manually" }));
    await user.click(screen.getByRole("radio", { name: /Diagrammer/ }));
    await user.click(screen.getByRole("checkbox", { name: /Meeting brief/ }));
    await user.click(screen.getByRole("button", { name: "Save setup" }));

    await waitFor(() =>
      expect(savePayload).toEqual({
        taskId: 42,
        mode: "manual",
        agentId: diagrammer.id,
        skillIds: [meetingBrief.id],
      }),
    );
  });

  it("re-evaluates staffing in automatic mode", async () => {
    let savePayload: unknown;
    const manualStaffing: TaskStaffing = {
      ...automaticStaffing,
      mode: "manual",
      reason: "",
    };
    mockIPC((command, payload) => {
      if (command === "get_workspace_task_staffing") return manualStaffing;
      if (command === "set_workspace_task_staffing") {
        savePayload = payload;
        return automaticStaffing;
      }
      return null;
    });
    const user = userEvent.setup();
    render(<TaskRunSetup taskId={42} catalog={catalog} />);

    await user.click(await screen.findByRole("button", { name: "Change" }));
    await user.click(
      screen.getByRole("radio", { name: /Automatic \(recommended\)/ }),
    );
    await user.click(screen.getByRole("button", { name: "Save setup" }));

    await waitFor(() =>
      expect(savePayload).toEqual({
        taskId: 42,
        mode: "automatic",
        agentId: null,
        skillIds: [],
      }),
    );
  });

  it("renders an unresolved summary when staffing is null", async () => {
    mockIPC((command) => {
      if (command === "get_workspace_task_staffing") return null;
      return null;
    });

    render(<TaskRunSetup taskId={42} catalog={catalog} />);

    expect(await screen.findByText("Run setup: not resolved yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Change" })).toBeVisible();
  });
});
