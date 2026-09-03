import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptionSetup } from "../hooks/useTranscriptionSetup";
import { pendingMeeting } from "../test/fixtures";
import type { FolderSummary } from "../types";
import { MeetingsList } from "./MeetingsList";

const tauriMocks = vi.hoisted(() => ({
  suggestFolderForMeeting: vi.fn(),
  updateMeetingTags: vi.fn(),
}));

vi.mock("../lib/tauri", () => tauriMocks);

beforeEach(() => {
  tauriMocks.suggestFolderForMeeting.mockReset();
  tauriMocks.suggestFolderForMeeting.mockResolvedValue(null);
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
  liveCaptionsState: undefined,
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

function folder(id: number, name: string, color: string): FolderSummary {
  return {
    folder: {
      id,
      name,
      color,
      instructions: "",
      created_at: "2026-08-17T10:00:00Z",
      updated_at: "2026-08-17T10:00:00Z",
    },
    meeting_count: 0,
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

describe("MeetingsList folders", () => {
  const alpha = folder(4, "Alpha", "purple");
  const beta = folder(5, "Beta", "green");
  const boundMeeting = pendingMeeting({ id: 41, title: "Bound meeting" });
  const unboundMeeting = pendingMeeting({ id: 42, title: "Unbound meeting" });
  const meetingFolder = {
    meeting_id: boundMeeting.id,
    folder_id: alpha.folder.id,
    folder_name: alpha.folder.name,
  };

  it("shows folders and excludes bound meetings from date bins", () => {
    render(
      <MeetingsList
        meetings={[boundMeeting, unboundMeeting]}
        folders={[beta, alpha]}
        meetingFolders={[meetingFolder]}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Folders")).toBeVisible();
    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByText("Beta")).toBeVisible();
    expect(screen.queryByText("Bound meeting")).not.toBeInTheDocument();
    expect(screen.getByText("Unbound meeting")).toBeVisible();
  });

  it("shows a folder's bound meeting when expanded", async () => {
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[boundMeeting, unboundMeeting]}
        folders={[alpha, beta]}
        meetingFolders={[meetingFolder]}
        onSelect={vi.fn()}
      />,
    );

    await user.click(screen.getByText("Alpha"));
    expect(screen.getByText("Bound meeting")).toBeVisible();
  });

  it("selects a folder from its row while the chevron only expands it", async () => {
    const onSelectFolder = vi.fn();
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[boundMeeting, unboundMeeting]}
        folders={[alpha, beta]}
        meetingFolders={[meetingFolder]}
        onSelect={vi.fn()}
        onSelectFolder={onSelectFolder}
      />,
    );

    const alphaRow = screen.getByText("Alpha").closest('[role="button"]');
    if (!(alphaRow instanceof HTMLElement)) {
      throw new Error("Alpha folder row not found");
    }
    await user.click(
      within(alphaRow).getByRole("button", { name: "Toggle folder meetings" }),
    );
    expect(screen.getByText("Bound meeting")).toBeVisible();
    expect(onSelectFolder).not.toHaveBeenCalled();

    await user.click(alphaRow);
    expect(onSelectFolder).toHaveBeenCalledWith(alpha.folder.id);
  });

  it("assigns an unbound meeting from the row menu", async () => {
    const onAssignToFolder = vi.fn();
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[unboundMeeting]}
        folders={[alpha, beta]}
        meetingFolders={[]}
        onSelect={vi.fn()}
        onAssignToFolder={onAssignToFolder}
        onCreateFolder={vi.fn().mockResolvedValue(null)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Meeting actions" }));
    const menuLabel = await screen.findByText("Move to folder");
    const menu = menuLabel.parentElement;
    if (!menu) throw new Error("Folder menu not found");
    expect(within(menu).getByRole("button", { name: "Alpha" })).toBeVisible();
    expect(within(menu).getByRole("button", { name: "Beta" })).toBeVisible();
    await user.click(within(menu).getByRole("button", { name: "Beta" }));

    expect(onAssignToFolder).toHaveBeenCalledWith(unboundMeeting, beta.folder.id);
  });

  it("creates a folder from the Folders cap with the default blue color", async () => {
    const onCreateFolder = vi.fn().mockResolvedValue(8);
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[unboundMeeting]}
        folders={[]}
        meetingFolders={[]}
        onSelect={vi.fn()}
        onCreateFolder={onCreateFolder}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New folder" }));
    await user.type(screen.getByPlaceholderText("Folder name"), "Launch plan");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreateFolder).toHaveBeenCalledWith("Launch plan", "blue");
  });

  it("opens a folder actions menu and requests deletion", async () => {
    const onDeleteFolder = vi.fn();
    const user = userEvent.setup();
    render(
      <MeetingsList
        meetings={[]}
        folders={[alpha, beta]}
        meetingFolders={[]}
        onSelect={vi.fn()}
        onDeleteFolder={onDeleteFolder}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Actions for folder Alpha" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete folder" }));

    expect(onDeleteFolder).toHaveBeenCalledWith(alpha.folder.id);
    expect(onDeleteFolder).toHaveBeenCalledTimes(1);
  });
});
