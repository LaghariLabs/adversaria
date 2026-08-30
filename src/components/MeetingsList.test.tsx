import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptionSetup } from "../hooks/useTranscriptionSetup";
import { pendingMeeting } from "../test/fixtures";
import type { WorkspaceSummary } from "../types";
import { MeetingsList } from "./MeetingsList";

const tauriMocks = vi.hoisted(() => ({
  suggestWorkspaceForMeeting: vi.fn(),
  updateMeetingTags: vi.fn(),
}));

vi.mock("../lib/tauri", () => tauriMocks);

beforeEach(() => {
  tauriMocks.suggestWorkspaceForMeeting.mockReset();
  tauriMocks.suggestWorkspaceForMeeting.mockResolvedValue(null);
  tauriMocks.updateMeetingTags.mockReset();
});

const setup = (
  state: TranscriptionSetup["state"],
  percent: number | null = null,
): TranscriptionSetup => ({
  state,
  percent,
  detail: "",
  serviceOnline: true,
  refresh: vi.fn(),
  retry: vi.fn(),
});

function renderList(
  meetings: Parameters<typeof MeetingsList>[0]["meetings"],
  transcriptionSetup?: TranscriptionSetup,
) {
  mockIPC(() => null);
  return render(
    <MeetingsList
      meetings={meetings}
      onSelect={vi.fn()}
      transcriptionSetup={transcriptionSetup}
    />,
  );
}

function project(id: number, name: string, color: string): WorkspaceSummary {
  return {
    workspace: {
      id,
      name,
      engine: "local",
      model: "",
      network_allowed: false,
      instructions: "",
      color,
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
}

describe("MeetingsList transcription badge", () => {
  it("says a recording is waiting for the model, keyed off the data not the tag", () => {
    // The transcript write clears the "Needs transcription" tag and rewrites
    // the title, so the tag cannot carry this state — `transcript === "" &&
    // audio_file_path != null` is what actually means "not transcribed".
    renderList([pendingMeeting({ tags: [] })], setup("missing"));
    expect(screen.getByText("Waiting for the model")).toBeVisible();
  });

  it("counts the model down while it downloads", () => {
    renderList([pendingMeeting({ tags: [] })], setup("downloading", 43));
    expect(screen.getByText("Waiting for the model — 43%")).toBeVisible();
  });

  it("says nothing once transcription is ready", () => {
    renderList([pendingMeeting({ tags: [] })], setup("ready"));
    expect(screen.queryByText(/Waiting for the model/)).not.toBeInTheDocument();
  });

  it("never marks a transcribed meeting as waiting, even with a stale tag", () => {
    const transcribed = pendingMeeting({
      transcript: "Me: done",
      audio_file_path: null,
      tags: [{ label: "Needs transcription", color: "orange" }],
    });
    renderList([transcribed], setup("missing"));
    expect(screen.queryByText(/Waiting for the model/)).not.toBeInTheDocument();
  });
});

describe("MeetingsList projects", () => {
  const alpha = project(4, "Alpha", "purple");
  const beta = project(5, "Beta", "green");
  const boundMeeting = pendingMeeting({ id: 41, title: "Bound meeting" });
  const unboundMeeting = pendingMeeting({ id: 42, title: "Unbound meeting" });
  const binding = {
    meeting_id: boundMeeting.id,
    workspace_id: alpha.workspace.id,
    workspace_name: alpha.workspace.name,
  };

  it("shows projects and excludes bound meetings from date bins", () => {
    render(
      <MeetingsList
        meetings={[boundMeeting, unboundMeeting]}
        projects={[beta, alpha]}
        bindings={[binding]}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Projects")).toBeVisible();
    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByText("Beta")).toBeVisible();
    expect(screen.queryByText("Bound meeting")).not.toBeInTheDocument();
    expect(screen.getByText("Unbound meeting")).toBeVisible();
  });

  it("shows a project's bound meeting when expanded", async () => {
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[boundMeeting, unboundMeeting]}
        projects={[alpha, beta]}
        bindings={[binding]}
        onSelect={vi.fn()}
      />,
    );

    await user.click(screen.getByText("Alpha"));
    expect(screen.getByText("Bound meeting")).toBeVisible();
  });

  it("selects a project from its row while the chevron only expands it", async () => {
    const onSelectProject = vi.fn();
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[boundMeeting, unboundMeeting]}
        projects={[alpha, beta]}
        bindings={[binding]}
        onSelect={vi.fn()}
        onSelectProject={onSelectProject}
      />,
    );

    const alphaRow = screen.getByText("Alpha").closest('[role="button"]');
    if (!(alphaRow instanceof HTMLElement)) {
      throw new Error("Alpha project row not found");
    }
    await user.click(
      within(alphaRow).getByRole("button", { name: "Toggle project meetings" }),
    );
    expect(screen.getByText("Bound meeting")).toBeVisible();
    expect(onSelectProject).not.toHaveBeenCalled();

    await user.click(alphaRow);
    expect(onSelectProject).toHaveBeenCalledWith(alpha.workspace.id);
  });

  it("assigns an unbound meeting from the row menu", async () => {
    const onAssignToProject = vi.fn();
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[unboundMeeting]}
        projects={[alpha, beta]}
        bindings={[]}
        onSelect={vi.fn()}
        onAssignToProject={onAssignToProject}
        onCreateProject={vi.fn().mockResolvedValue(null)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Meeting actions" }));
    const menuLabel = await screen.findByText("Move to project");
    const menu = menuLabel.parentElement;
    if (!menu) throw new Error("Project menu not found");
    expect(within(menu).getByRole("button", { name: "Alpha" })).toBeVisible();
    expect(within(menu).getByRole("button", { name: "Beta" })).toBeVisible();
    await user.click(within(menu).getByRole("button", { name: "Beta" }));

    expect(onAssignToProject).toHaveBeenCalledWith(unboundMeeting, beta.workspace.id);
  });

  it("creates a project from the Projects cap with the default blue color", async () => {
    const onCreateProject = vi.fn().mockResolvedValue(8);
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[unboundMeeting]}
        projects={[]}
        bindings={[]}
        onSelect={vi.fn()}
        onCreateProject={onCreateProject}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByPlaceholderText("Project name"), "Launch plan");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreateProject).toHaveBeenCalledWith("Launch plan", "blue");
  });

  it("opens a project actions menu and requests deletion", async () => {
    const onDeleteProject = vi.fn();
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[]}
        projects={[alpha, beta]}
        bindings={[]}
        onSelect={vi.fn()}
        onDeleteProject={onDeleteProject}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for project Alpha" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete project" }));

    expect(onDeleteProject).toHaveBeenCalledWith(alpha.workspace.id);
    expect(onDeleteProject).toHaveBeenCalledTimes(1);
  });
});
