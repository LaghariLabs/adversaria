import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { pendingMeeting } from "../test/fixtures";
import type { ActionItem, FolderOverview, FolderSummary } from "../types";
import { FolderView } from "./FolderView";

const tauriMocks = vi.hoisted(() => ({
  getActionItems: vi.fn(),
  setActionItemDone: vi.fn(),
  setFolderInstructions: vi.fn(),
  setWorkspaceNetworkAllowed: vi.fn(),
  getFolderOverview: vi.fn(),
}));

vi.mock("../lib/tauri", () => tauriMocks);

const folder: FolderSummary = {
  folder: {
    id: 4,
    name: "Launch planning",
    color: "purple",
    instructions: "Focus on launch risks.",
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:00:00Z",
  },
  meeting_count: 2,
};

const meetings = [
  pendingMeeting({
    id: 11,
    title: "Kickoff with Them",
    recorded_at: "2026-08-20T10:00:00Z",
    summary: "We kicked off the launch.",
    attendees: ["Alice", "Bob"],
  }),
  pendingMeeting({
    id: 12,
    title: "Design review",
    recorded_at: "2026-08-19T10:00:00Z",
    summary: "Reviewed designs.",
    attendees: ["Alice", "Charlie"],
  }),
];

function actionItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 21,
    meeting_id: 11,
    ord: 0,
    text: "Send recap",
    assignee: "",
    due: "",
    done: false,
    status: "todo",
    completed_by: "",
    completed_at: "",
    evidence: "",
    ...overrides,
  };
}

function overviewFixture(overrides: Partial<FolderOverview> = {}): FolderOverview {
  return {
    folder_id: folder.folder.id,
    summary:
      "This folder is about launching the new product. It progressed from kickoff to design review. The current focus is finalizing messaging. The most important unresolved thread is pricing approval.",
    generated_at: "2026-08-20T12:00:00Z",
    source_meeting_count: meetings.length,
    stale: false,
    ...overrides,
  };
}

function renderFolderView(
  overrides: Partial<ComponentProps<typeof FolderView>> = {},
) {
  return render(
    <FolderView
      folder={folder}
      meetings={meetings}
      onOpenMeeting={vi.fn()}
      onFolderUpdated={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  tauriMocks.getActionItems.mockReset();
  tauriMocks.getActionItems.mockResolvedValue([]);
  tauriMocks.setActionItemDone.mockReset();
  tauriMocks.setActionItemDone.mockResolvedValue(undefined);
  tauriMocks.setFolderInstructions.mockReset();
  tauriMocks.setFolderInstructions.mockResolvedValue(undefined);
  tauriMocks.setWorkspaceNetworkAllowed.mockReset();
  tauriMocks.setWorkspaceNetworkAllowed.mockResolvedValue(undefined);
  tauriMocks.getFolderOverview.mockReset();
  // Default: return empty for zero? For meetings present, return ready overview.
  tauriMocks.getFolderOverview.mockResolvedValue(overviewFixture());
});

describe("FolderView", () => {
  it("renders the folder name, meeting rows, and knows-line counts", async () => {
    tauriMocks.getActionItems.mockResolvedValue([actionItem()]);

    renderFolderView();

    expect(screen.getByRole("heading", { name: "Launch planning" })).toBeVisible();
    expect(screen.getByText("Kickoff")).toBeVisible();
    expect(screen.getByText("Design review")).toBeVisible();
    expect(
      await screen.findByText(/2 meetings · 1 open action item · last activity/),
    ).toBeVisible();
  });

  it("ready overview rendering and automatic initial load", async () => {
    const overview = overviewFixture();
    tauriMocks.getFolderOverview.mockResolvedValue(overview);

    renderFolderView();

    // Automatic initial load calls getFolderOverview with refresh false.
    await waitFor(() =>
      expect(tauriMocks.getFolderOverview).toHaveBeenCalledWith(
        folder.folder.id,
        false,
      ),
    );

    expect(await screen.findByText(/This folder is about launching/)).toBeVisible();
    // After de-duplication there is only one footer copy inside the timestamp line.
    expect(screen.getByText(/Generated with the Notes engine selected in Settings/)).toBeVisible();
    expect(screen.getByText(/No web browsing/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh folder overview" })).toBeVisible();
  });

  it("deterministic attendee deduplication/count ordering and self filtering", async () => {
    const dedupMeetings = [
      pendingMeeting({
        id: 11,
        title: "M1",
        recorded_at: "2026-08-20T10:00:00Z",
        attendees: [" Alice ", "alice", "Bob", "Me", "You", ""],
      }),
      pendingMeeting({
        id: 12,
        title: "M2",
        recorded_at: "2026-08-19T10:00:00Z",
        attendees: ["ALICE", "bob", "Charlie", "you"],
      }),
      pendingMeeting({
        id: 13,
        title: "M3",
        recorded_at: "2026-08-18T10:00:00Z",
        attendees: ["  ", "ME"],
      }),
    ];
    renderFolderView({ meetings: dedupMeetings });

    await waitFor(() => expect(tauriMocks.getFolderOverview).toHaveBeenCalled());

    // Should show People across these meetings section
    expect(screen.getByText("People across these meetings")).toBeVisible();
    // Alice 2 meetings, Bob 2 meetings, Charlie 1 meeting – sorted by count desc then name asc: Alice, Bob, Charlie
    const aliceChip = await screen.findByText("Alice");
    expect(aliceChip).toBeVisible();
    expect(screen.getByText("Bob")).toBeVisible();
    expect(screen.getByText("Charlie")).toBeVisible();
    // Check counts – Alice and Bob both have 2 meetings, so there should be two chips with "2 meetings"
    expect(screen.getAllByText("2 meetings").length).toBe(2);
    expect(screen.getByText("1 meeting")).toBeVisible(); // Charlie
    // Self filtering: Me/You not shown
    expect(screen.queryByText(/^Me$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^You$/)).not.toBeInTheDocument();

    // Verify ordering: Alice appears before Bob, Bob before Charlie in DOM order
    const chips = Array.from(document.querySelectorAll("span")).filter((el) =>
      ["Alice", "Bob", "Charlie"].includes(el.textContent ?? ""),
    );
    const texts = chips.map((el) => el.textContent);
    expect(texts.indexOf("Alice")).toBeLessThan(texts.indexOf("Bob"));
    expect(texts.indexOf("Bob")).toBeLessThan(texts.indexOf("Charlie"));
  });

  it("shows quiet empty attendees state when only self", async () => {
    const soloMeetings = [
      pendingMeeting({
        id: 11,
        title: "Solo",
        recorded_at: "2026-08-20T10:00:00Z",
        attendees: ["Me", "You", "  "],
      }),
    ];
    renderFolderView({ meetings: soloMeetings });
    await waitFor(() => expect(tauriMocks.getFolderOverview).toHaveBeenCalled());
    expect(await screen.findByText("No other attendees identified yet.")).toBeVisible();
  });

  it("stale state plus Update calling refresh true", async () => {
    const staleOverview = overviewFixture({ stale: true });
    tauriMocks.getFolderOverview.mockResolvedValueOnce(staleOverview);
    const refreshedOverview = overviewFixture({ stale: false, generated_at: "2026-08-21T10:00:00Z" });
    tauriMocks.getFolderOverview.mockResolvedValueOnce(refreshedOverview);

    const user = userEvent.setup();
    renderFolderView();

    await waitFor(() => expect(tauriMocks.getFolderOverview).toHaveBeenCalledWith(folder.folder.id, false));
    expect(await screen.findByText(/This folder is about launching/)).toBeVisible();
    // Visible banner plus sr-only live region both contain the text – use getAllByText and check visible count
    expect(screen.getAllByText("New meeting context available").length).toBeGreaterThanOrEqual(1);
    // The visible banner is a span, not the sr-only div
    const updateBtn = screen.getByRole("button", { name: "Update folder overview" });
    expect(updateBtn).toBeVisible();

    await user.click(updateBtn);

    await waitFor(() =>
      expect(tauriMocks.getFolderOverview).toHaveBeenCalledWith(folder.folder.id, true),
    );
    // After update, stale banner should disappear (mock second call returns stale false)
    // sr-only will now say "Folder overview ready", so no visible banner should remain
    await waitFor(() => {
      // The visible banner is inside a span with specific style; sr-only is hidden but still in DOM.
      // After refresh, only sr-only remains with different text, so total count should be 1 (the sr-only now says ready) or 0 for visible.
      // Check that the Update button is gone and the banner text is not found in a visible span.
      expect(screen.queryByRole("button", { name: "Update folder overview" })).not.toBeInTheDocument();
    });
  });

  it("initial error with Retry", async () => {
    tauriMocks.getFolderOverview.mockRejectedValueOnce(new Error("Notes engine down"));
    const retryOverview = overviewFixture();
    tauriMocks.getFolderOverview.mockResolvedValueOnce(retryOverview);

    const user = userEvent.setup();
    renderFolderView();

    expect(await screen.findByText("Could not generate the folder overview.")).toBeVisible();
    expect(screen.getByText(/Notes engine down/)).toBeVisible();
    const retryBtn = screen.getByRole("button", { name: "Retry generating folder overview" });
    expect(retryBtn).toBeVisible();

    await user.click(retryBtn);

    await waitFor(() =>
      expect(tauriMocks.getFolderOverview).toHaveBeenLastCalledWith(folder.folder.id, true),
    );
    expect(await screen.findByText(/This folder is about launching/)).toBeVisible();
  });

  it("existing overview retained when refresh fails", async () => {
    const initial = overviewFixture();
    tauriMocks.getFolderOverview.mockResolvedValueOnce(initial);
    renderFolderView();

    expect(await screen.findByText(/This folder is about launching/)).toBeVisible();

    // Next refresh will fail
    tauriMocks.getFolderOverview.mockRejectedValueOnce(new Error("Service unreachable"));
    const user = userEvent.setup();
    const refreshBtn = screen.getByRole("button", { name: "Refresh folder overview" });
    await user.click(refreshBtn);

    await waitFor(() =>
      expect(tauriMocks.getFolderOverview).toHaveBeenCalledWith(folder.folder.id, true),
    );
    // Prose still visible
    expect(screen.getByText(/This folder is about launching/)).toBeVisible();
    // Inline error and Retry
    expect(await screen.findByText(/Service unreachable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry generating folder overview" })).toBeVisible();
  });

  it("zero-meeting overview state without invoking generation refresh", async () => {
    const emptyMeetings: typeof meetings = [];
    const emptyOverview: FolderOverview = {
      folder_id: folder.folder.id,
      summary: "",
      generated_at: "",
      source_meeting_count: 0,
      stale: false,
    };
    tauriMocks.getFolderOverview.mockResolvedValue(emptyOverview);

    renderFolderView({ meetings: emptyMeetings });

    expect(
      await screen.findByText(/No meetings filed yet\. File a meeting to this folder/),
    ).toBeVisible();
    expect(screen.getByText("No other attendees identified yet.")).toBeVisible();
    // Should have called getFolderOverview once with false, not with true (no auto-refresh of empty)
    await waitFor(() => expect(tauriMocks.getFolderOverview).toHaveBeenCalledWith(folder.folder.id, false));
    expect(tauriMocks.getFolderOverview).not.toHaveBeenCalledWith(folder.folder.id, true);
    // No Refresh or Update button in zero state (or at least not the Update banner)
    expect(screen.queryByText("New meeting context available")).not.toBeInTheDocument();
  });

  it("saves edited standing instructions with new copy/layout", async () => {
    const onFolderUpdated = vi.fn();
    const user = userEvent.setup();
    renderFolderView({ onFolderUpdated });

    // New copy checks
    expect(screen.getByText("Guides this folder's overview.")).toBeVisible();
    expect(screen.getByText("Saved on this device and applied across this folder.")).toBeVisible();
    const textarea = screen.getByRole("textbox", { name: "Standing instructions" });
    expect(textarea).toHaveAttribute(
      "placeholder",
      "For example: prioritize technical risks, keep decisions concise, and flag anything without an owner.",
    );

    await user.clear(textarea);
    await user.type(textarea, "Always include launch blockers.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tauriMocks.setFolderInstructions).toHaveBeenCalledWith(
        folder.folder.id,
        "Always include launch blockers.",
      ),
    );
    expect(onFolderUpdated).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saved")).toBeVisible();
  });

  it("groups meetings and folder controls separately from action items", () => {
    const { container } = renderFolderView();
    const folderColumn = container.querySelector(".folder-view-primary");
    const actionColumn = container.querySelector(".folder-view-secondary");

    expect(folderColumn).not.toBeNull();
    expect(actionColumn).not.toBeNull();
    expect(folderColumn?.querySelector(".folder-meetings-card")).not.toBeNull();
    expect(folderColumn?.querySelector(".folder-standing-card")).not.toBeNull();
    expect(folderColumn?.querySelector(".folder-openitems-card")).toBeNull();
    expect(actionColumn?.querySelector(".folder-openitems-card")).not.toBeNull();
    expect(actionColumn?.querySelector(".folder-standing-card")).toBeNull();
    expect(actionColumn?.querySelector(".folder-webresearch-card")).toBeNull();
  });

  it("shows only open action items and completes one from its checkbox", async () => {
    tauriMocks.getActionItems.mockResolvedValue([
      actionItem(),
      actionItem({ id: 22, text: "Already done", done: true }),
      actionItem({ id: 23, text: "Status done", status: "done" }),
    ]);
    const user = userEvent.setup();
    renderFolderView();

    expect(await screen.findByText("Send recap")).toBeVisible();
    expect(screen.queryByText("Already done")).not.toBeInTheDocument();
    expect(screen.queryByText("Status done")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Complete Send recap" }));
    await waitFor(() => expect(tauriMocks.setActionItemDone).toHaveBeenCalledWith(21, true));
    expect(screen.queryByText("Send recap")).not.toBeInTheDocument();
  });

  it("keeps the source meeting as secondary action metadata", async () => {
    tauriMocks.getActionItems.mockResolvedValue([actionItem()]);
    const onOpenMeeting = vi.fn();
    const user = userEvent.setup();

    renderFolderView({ onOpenMeeting });

    const source = await screen.findByRole("button", {
      name: "Open source meeting Kickoff",
    });
    expect(source).toHaveClass("folder-action-source");
    expect(screen.getByText("Send recap")).toHaveClass("folder-action-text");

    await user.click(source);
    expect(onOpenMeeting).toHaveBeenCalledWith(meetings[0]);
  });

  it("opens a meeting from its row", async () => {
    const onOpenMeeting = vi.fn();
    const user = userEvent.setup();
    renderFolderView({ onOpenMeeting });

    await user.click(screen.getByText("Kickoff"));

    expect(onOpenMeeting).toHaveBeenCalledWith(meetings[0]);
  });

  it("shows ThinkingIndicator while generating initial overview", async () => {
    // Never-resolving promise to keep loading
    let resolveOverview: (v: FolderOverview) => void = () => {};
    tauriMocks.getFolderOverview.mockImplementation(
      () =>
        new Promise<FolderOverview>((resolve) => {
          resolveOverview = resolve;
        }),
    );
    renderFolderView();

    // ThinkingIndicator should appear (words cycle randomly, so match any of the folder words)
    expect(
      await screen.findByText(/Reading folder meetings|Tracing how it progressed|Finding the current focus|Spotting unresolved/),
    ).toBeVisible();

    // Resolve to finish loading
    resolveOverview(overviewFixture());
    expect(await screen.findByText(/This folder is about launching/)).toBeVisible();
  });
});
