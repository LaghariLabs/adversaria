import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LastTimeBrief } from "./LastTimeBrief";
import type { FolderCopilotBrief } from "../types";

function briefFixture(overrides: Partial<FolderCopilotBrief> = {}): FolderCopilotBrief {
  return {
    folder_id: 1,
    folder_name: "Daily stand-up",
    copilot_mode: "no_ai",
    copilot_web: false,
    meeting_count: 2,
    last_meeting: {
      id: 10,
      title: "Stand-up 2026-08-30",
      recorded_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      attendees: ["Alice", "Bob"],
    },
    open_items: [
      {
        id: 101,
        meeting_id: 10,
        meeting_title: "Stand-up 2026-08-30",
        recorded_at: "2026-08-30T09:00:00Z",
        ord: 0,
        text: "Ship the API fix",
        assignee: "Alice",
        due: "2026-09-01",
        meetings_ago: 2,
      },
      {
        id: 102,
        meeting_id: 10,
        meeting_title: "Stand-up 2026-08-30",
        recorded_at: "2026-08-30T09:00:00Z",
        ord: 1,
        text: "Review PR 42",
        assignee: "",
        due: "",
        meetings_ago: 0,
      },
    ],
    decisions: [{ meeting_id: 10, text: "We will use GraphQL" }],
    follow_ups: [{ meeting_id: 10, text: "Follow up with design" }],
    ...overrides,
  };
}

describe("LastTimeBrief", () => {
  it("renders header, open items with meta, decisions, follow-ups from fixture brief", async () => {
    const fixture = briefFixture();
    mockIPC((cmd) => {
      if (cmd === "get_folder_copilot_brief") return fixture;
      return null;
    });
    render(<LastTimeBrief folderId={1} />);

    await waitFor(() => expect(screen.getByText(/Last time · Stand-up 2026-08-30/)).toBeInTheDocument());
    expect(screen.getByText("Alice, Bob")).toBeInTheDocument();
    expect(screen.getByText("Ship the API fix")).toBeInTheDocument();
    expect(screen.getByText("Review PR 42")).toBeInTheDocument();
    // meetings_ago:2 => open 3 meetings
    expect(screen.getByText(/open 3 meetings/)).toBeInTheDocument();
    expect(screen.getByText(/last meeting/)).toBeInTheDocument();
    expect(screen.getByText("We will use GraphQL")).toBeInTheDocument();
    expect(screen.getByText("Follow up with design")).toBeInTheDocument();
    expect(screen.getByText("Open since last time · 2")).toBeInTheDocument();
    expect(screen.getByText("Decided last time")).toBeInTheDocument();
    expect(screen.getByText("Follow-ups from last time")).toBeInTheDocument();
  });

  it("ticking an item invokes set_action_item_done and removes the row", async () => {
    const fixture = briefFixture();
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "get_folder_copilot_brief") return fixture;
      if (cmd === "set_action_item_done") return null;
      return null;
    });
    const user = userEvent.setup();
    render(<LastTimeBrief folderId={1} />);
    await waitFor(() => expect(screen.getByText("Ship the API fix")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Mark done: Ship the API fix"));

    await waitFor(() => expect(screen.queryByText("Ship the API fix")).not.toBeInTheDocument());
    const doneCall = calls.find((c) => c.cmd === "set_action_item_done");
    expect(doneCall).toBeDefined();
    expect(doneCall?.args).toEqual({ id: 101, done: true });
    // other item remains
    expect(screen.getByText("Review PR 42")).toBeInTheDocument();
  });

  it("reverts optimistic removal and warns on error", async () => {
    const fixture = briefFixture();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockIPC((cmd) => {
      if (cmd === "get_folder_copilot_brief") return fixture;
      if (cmd === "set_action_item_done") throw new Error("db failure");
      return null;
    });
    const user = userEvent.setup();
    render(<LastTimeBrief folderId={1} />);
    await waitFor(() => expect(screen.getByText("Ship the API fix")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Mark done: Ship the API fix"));

    await waitFor(() => expect(screen.getByText("Ship the API fix")).toBeInTheDocument());
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("shows pick-a-folder copy when folderId is null", () => {
    mockIPC(() => null);
    render(<LastTimeBrief folderId={null} />);
    expect(screen.getByText("Pick a folder above to see what happened last time.")).toBeInTheDocument();
  });

  it("shows first-meeting copy when meeting_count is 0", async () => {
    const fixture = briefFixture({
      meeting_count: 0,
      last_meeting: null,
      open_items: [],
      decisions: [],
      follow_ups: [],
    });
    mockIPC((cmd) => {
      if (cmd === "get_folder_copilot_brief") return fixture;
      return null;
    });
    render(<LastTimeBrief folderId={1} />);
    await waitFor(() => expect(screen.getByText("First meeting in this folder.")).toBeInTheDocument());
  });

  it("shows error copy when invoke rejects", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_folder_copilot_brief") throw new Error("not found");
      return null;
    });
    render(<LastTimeBrief folderId={1} />);
    await waitFor(() => expect(screen.getByText(/Could not load last time:/)).toBeInTheDocument());
    expect(screen.getByText(/not found/)).toBeInTheDocument();
  });

  it("omits empty sections", async () => {
    const fixture = briefFixture({ decisions: [], follow_ups: [], open_items: [] });
    mockIPC((cmd) => {
      if (cmd === "get_folder_copilot_brief") return fixture;
      return null;
    });
    render(<LastTimeBrief folderId={1} />);
    await waitFor(() => expect(screen.getByText(/Last time ·/)).toBeInTheDocument());
    expect(screen.queryByText("Decided last time")).not.toBeInTheDocument();
    expect(screen.queryByText("Follow-ups from last time")).not.toBeInTheDocument();
    expect(screen.queryByText("Open since last time")).not.toBeInTheDocument();
  });
});
