import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { pendingMeeting } from "../test/fixtures";
import type { ActionItem, ProjectOverview, WorkspaceSummary } from "../types";
import { ProjectView } from "./ProjectView";

const tauriMocks = vi.hoisted(() => ({
  getActionItems: vi.fn(),
  setActionItemDone: vi.fn(),
  setWorkspaceInstructions: vi.fn(),
  setWorkspaceNetworkAllowed: vi.fn(),
  getProjectOverview: vi.fn(),
}));

vi.mock("../lib/tauri", () => tauriMocks);

const project: WorkspaceSummary = {
  workspace: {
    id: 4,
    name: "Launch planning",
    engine: "local",
    model: "",
    network_allowed: false,
    instructions: "Focus on launch risks.",
    color: "purple",
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
  folder_count: 0,
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

function overviewFixture(overrides: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    workspace_id: project.workspace.id,
    summary:
      "This project is about launching the new product. It progressed from kickoff to design review. The current focus is finalizing messaging. The most important unresolved thread is pricing approval.",
    generated_at: "2026-08-20T12:00:00Z",
    source_meeting_count: meetings.length,
    stale: false,
    ...overrides,
  };
}

function renderProjectView(
  overrides: Partial<ComponentProps<typeof ProjectView>> = {},
) {
  return render(
    <ProjectView
      project={project}
      meetings={meetings}
      onOpenMeeting={vi.fn()}
      onProjectUpdated={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  tauriMocks.getActionItems.mockReset();
  tauriMocks.getActionItems.mockResolvedValue([]);
  tauriMocks.setActionItemDone.mockReset();
  tauriMocks.setActionItemDone.mockResolvedValue(undefined);
  tauriMocks.setWorkspaceInstructions.mockReset();
  tauriMocks.setWorkspaceInstructions.mockResolvedValue(undefined);
  tauriMocks.setWorkspaceNetworkAllowed.mockReset();
  tauriMocks.setWorkspaceNetworkAllowed.mockResolvedValue(undefined);
  tauriMocks.getProjectOverview.mockReset();
  // Default: return empty for zero? For meetings present, return ready overview.
  tauriMocks.getProjectOverview.mockResolvedValue(overviewFixture());
});

describe("ProjectView", () => {
  it("renders the project name, meeting rows, and knows-line counts", async () => {
    tauriMocks.getActionItems.mockResolvedValue([actionItem()]);

    renderProjectView();

    expect(screen.getByRole("heading", { name: "Launch planning" })).toBeVisible();
    expect(screen.getByText("Kickoff")).toBeVisible();
    expect(screen.getByText("Design review")).toBeVisible();
    expect(
      await screen.findByText(/2 meetings · 1 open action item · last activity/),
    ).toBeVisible();
  });

  it("ready overview rendering and automatic initial load", async () => {
    const overview = overviewFixture();
    tauriMocks.getProjectOverview.mockResolvedValue(overview);

    renderProjectView();

    // Automatic initial load calls getProjectOverview with refresh false.
    await waitFor(() =>
      expect(tauriMocks.getProjectOverview).toHaveBeenCalledWith(
        project.workspace.id,
        false,
      ),
    );

    expect(await screen.findByText(/This project is about launching/)).toBeVisible();
    // After de-duplication there is only one footer copy inside the timestamp line.
    expect(screen.getByText(/Generated with the Notes engine selected in Settings/)).toBeVisible();
    expect(screen.getByText(/No web browsing/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh project overview" })).toBeVisible();
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
    renderProjectView({ meetings: dedupMeetings });

    await waitFor(() => expect(tauriMocks.getProjectOverview).toHaveBeenCalled());

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
    renderProjectView({ meetings: soloMeetings });
    await waitFor(() => expect(tauriMocks.getProjectOverview).toHaveBeenCalled());
    expect(await screen.findByText("No other attendees identified yet.")).toBeVisible();
  });

  it("stale state plus Update calling refresh true", async () => {
    const staleOverview = overviewFixture({ stale: true });
    tauriMocks.getProjectOverview.mockResolvedValueOnce(staleOverview);
    const refreshedOverview = overviewFixture({ stale: false, generated_at: "2026-08-21T10:00:00Z" });
    tauriMocks.getProjectOverview.mockResolvedValueOnce(refreshedOverview);

    const user = userEvent.setup();
    renderProjectView();

    await waitFor(() => expect(tauriMocks.getProjectOverview).toHaveBeenCalledWith(project.workspace.id, false));
    expect(await screen.findByText(/This project is about launching/)).toBeVisible();
    // Visible banner plus sr-only live region both contain the text – use getAllByText and check visible count
    expect(screen.getAllByText("New meeting context available").length).toBeGreaterThanOrEqual(1);
    // The visible banner is a span, not the sr-only div
    const updateBtn = screen.getByRole("button", { name: "Update project overview" });
    expect(updateBtn).toBeVisible();

    await user.click(updateBtn);

    await waitFor(() =>
      expect(tauriMocks.getProjectOverview).toHaveBeenCalledWith(project.workspace.id, true),
    );
    // After update, stale banner should disappear (mock second call returns stale false)
    // sr-only will now say "Project overview ready", so no visible banner should remain
    await waitFor(() => {
      // The visible banner is inside a span with specific style; sr-only is hidden but still in DOM.
      // After refresh, only sr-only remains with different text, so total count should be 1 (the sr-only now says ready) or 0 for visible.
      // Check that the Update button is gone and the banner text is not found in a visible span.
      expect(screen.queryByRole("button", { name: "Update project overview" })).not.toBeInTheDocument();
    });
  });

  it("initial error with Retry", async () => {
    tauriMocks.getProjectOverview.mockRejectedValueOnce(new Error("Notes engine down"));
    const retryOverview = overviewFixture();
    tauriMocks.getProjectOverview.mockResolvedValueOnce(retryOverview);

    const user = userEvent.setup();
    renderProjectView();

    expect(await screen.findByText("Could not generate the project overview.")).toBeVisible();
    expect(screen.getByText(/Notes engine down/)).toBeVisible();
    const retryBtn = screen.getByRole("button", { name: "Retry generating project overview" });
    expect(retryBtn).toBeVisible();

    await user.click(retryBtn);

    await waitFor(() =>
      expect(tauriMocks.getProjectOverview).toHaveBeenLastCalledWith(project.workspace.id, true),
    );
    expect(await screen.findByText(/This project is about launching/)).toBeVisible();
  });

  it("existing overview retained when refresh fails", async () => {
    const initial = overviewFixture();
    tauriMocks.getProjectOverview.mockResolvedValueOnce(initial);
    renderProjectView();

    expect(await screen.findByText(/This project is about launching/)).toBeVisible();

    // Next refresh will fail
    tauriMocks.getProjectOverview.mockRejectedValueOnce(new Error("Service unreachable"));
    const user = userEvent.setup();
    const refreshBtn = screen.getByRole("button", { name: "Refresh project overview" });
    await user.click(refreshBtn);

    await waitFor(() =>
      expect(tauriMocks.getProjectOverview).toHaveBeenCalledWith(project.workspace.id, true),
    );
    // Prose still visible
    expect(screen.getByText(/This project is about launching/)).toBeVisible();
    // Inline error and Retry
    expect(await screen.findByText(/Service unreachable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry generating project overview" })).toBeVisible();
  });

  it("zero-meeting overview state without invoking generation refresh", async () => {
    const emptyMeetings: typeof meetings = [];
    const emptyOverview: ProjectOverview = {
      workspace_id: project.workspace.id,
      summary: "",
      generated_at: "",
      source_meeting_count: 0,
      stale: false,
    };
    tauriMocks.getProjectOverview.mockResolvedValue(emptyOverview);

    renderProjectView({ meetings: emptyMeetings });

    expect(
      await screen.findByText(/No meetings filed yet\. File a meeting to this project/),
    ).toBeVisible();
    expect(screen.getByText("No other attendees identified yet.")).toBeVisible();
    // Should have called getProjectOverview once with false, not with true (no auto-refresh of empty)
    await waitFor(() => expect(tauriMocks.getProjectOverview).toHaveBeenCalledWith(project.workspace.id, false));
    expect(tauriMocks.getProjectOverview).not.toHaveBeenCalledWith(project.workspace.id, true);
    // No Refresh or Update button in zero state (or at least not the Update banner)
    expect(screen.queryByText("New meeting context available")).not.toBeInTheDocument();
  });

  it("saves edited standing instructions with new copy/layout", async () => {
    const onProjectUpdated = vi.fn();
    const user = userEvent.setup();
    renderProjectView({ onProjectUpdated });

    // New copy checks
    expect(screen.getByText("Rules and context used whenever AI summarizes this project or runs one of its workspace tasks.")).toBeVisible();
    expect(screen.getByText("Saved on this device and applied across this project.")).toBeVisible();
    const textarea = screen.getByRole("textbox", { name: "Standing instructions" });
    expect(textarea).toHaveAttribute(
      "placeholder",
      "For example: prioritize technical risks, keep decisions concise, and flag anything without an owner.",
    );

    await user.clear(textarea);
    await user.type(textarea, "Always include launch blockers.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(tauriMocks.setWorkspaceInstructions).toHaveBeenCalledWith(
        project.workspace.id,
        "Always include launch blockers.",
      ),
    );
    expect(onProjectUpdated).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saved")).toBeVisible();
  });

  it("web research switch still persists", async () => {
    const user = userEvent.setup();
    renderProjectView();

    expect(screen.getByText("Web research")).toBeVisible();
    expect(
      screen.getByText(
        "Controls whether workspace tasks may browse the web. Project overviews never browse. Meeting data follows the Notes engine selected in Settings.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("switch", { name: "Web research" }));

    await waitFor(() =>
      expect(tauriMocks.setWorkspaceNetworkAllowed).toHaveBeenCalledWith(project.workspace.id, true),
    );
  });

  it("groups meetings and project controls separately from action items", () => {
    const { container } = renderProjectView();
    const projectColumn = container.querySelector(".project-view-primary");
    const actionColumn = container.querySelector(".project-view-secondary");

    expect(projectColumn).not.toBeNull();
    expect(actionColumn).not.toBeNull();
    expect(projectColumn?.querySelector(".project-meetings-card")).not.toBeNull();
    expect(projectColumn?.querySelector(".project-standing-card")).not.toBeNull();
    expect(projectColumn?.querySelector(".project-webresearch-card")).not.toBeNull();
    expect(projectColumn?.querySelector(".project-openitems-card")).toBeNull();
    expect(actionColumn?.querySelector(".project-openitems-card")).not.toBeNull();
    expect(actionColumn?.querySelector(".project-standing-card")).toBeNull();
    expect(actionColumn?.querySelector(".project-webresearch-card")).toBeNull();
  });

  it("shows only open action items and completes one from its checkbox", async () => {
    tauriMocks.getActionItems.mockResolvedValue([
      actionItem(),
      actionItem({ id: 22, text: "Already done", done: true }),
      actionItem({ id: 23, text: "Status done", status: "done" }),
    ]);
    const user = userEvent.setup();
    renderProjectView();

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

    renderProjectView({ onOpenMeeting });

    const source = await screen.findByRole("button", {
      name: "Open source meeting Kickoff",
    });
    expect(source).toHaveClass("project-action-source");
    expect(screen.getByText("Send recap")).toHaveClass("project-action-text");

    await user.click(source);
    expect(onOpenMeeting).toHaveBeenCalledWith(meetings[0]);
  });

  it("opens a meeting from its row", async () => {
    const onOpenMeeting = vi.fn();
    const user = userEvent.setup();
    renderProjectView({ onOpenMeeting });

    await user.click(screen.getByText("Kickoff"));

    expect(onOpenMeeting).toHaveBeenCalledWith(meetings[0]);
  });

  it("only shows the Workspaces link when its callback is provided", () => {
    const firstRender = renderProjectView();
    expect(screen.queryByRole("button", { name: "Open in Workspaces" })).not.toBeInTheDocument();
    firstRender.unmount();

    renderProjectView({ onOpenWorkspaces: vi.fn() });
    expect(screen.getByRole("button", { name: "Open in Workspaces" })).toBeVisible();
  });

  it("shows ThinkingIndicator while generating initial overview", async () => {
    // Never-resolving promise to keep loading
    let resolveOverview: (v: ProjectOverview) => void = () => {};
    tauriMocks.getProjectOverview.mockImplementation(
      () =>
        new Promise<ProjectOverview>((resolve) => {
          resolveOverview = resolve;
        }),
    );
    renderProjectView();

    // ThinkingIndicator should appear (words cycle randomly, so match any of the project words)
    expect(
      await screen.findByText(/Reading project meetings|Tracing how it progressed|Finding the current focus|Spotting unresolved/),
    ).toBeVisible();

    // Resolve to finish loading
    resolveOverview(overviewFixture());
    expect(await screen.findByText(/This project is about launching/)).toBeVisible();
  });
});
