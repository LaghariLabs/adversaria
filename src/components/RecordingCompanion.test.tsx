import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecordingCompanion } from "./RecordingCompanion";

const tauriMocks = vi.hoisted(() => ({
  getConfig: vi.fn().mockResolvedValue({ copilot_hud_enabled: false }),
  getAudioLevel: vi.fn().mockResolvedValue(0),
  pickContextFile: vi.fn().mockResolvedValue(null),
  getFolderCopilotBrief: vi.fn().mockResolvedValue({
    folder_id: 1,
    folder_name: "Test",
    copilot_mode: "no_ai",
    copilot_web: false,
    meeting_count: 0,
    last_meeting: null,
    open_items: [],
    decisions: [],
    follow_ups: [],
  }),
  setActionItemDone: vi.fn().mockResolvedValue(undefined),
  hasCopilotApiKey: vi.fn().mockResolvedValue(false),
  hasDeepSeekCopilotApiKey: vi.fn().mockResolvedValue(false),
  copilotGetMode: vi.fn().mockResolvedValue("no_ai"),
  copilotSetMode: vi.fn().mockResolvedValue("local"),
  setFolderCopilotMode: vi.fn().mockResolvedValue(undefined),
  setFolderCopilotWeb: vi.fn().mockResolvedValue(undefined),
  copilotSetMicQuestions: vi.fn().mockResolvedValue(undefined),
  setFolderProfile: vi.fn().mockResolvedValue(undefined),
  copilotCardReview: vi.fn().mockResolvedValue({ row_id: 1, pinned_at: "2026-09-14T00:00:00Z", dismissed_at: null }),
  copilotLiveState: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveConfigure: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveReview: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 2, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotHudIsOpen: vi.fn().mockResolvedValue(false),
}));

vi.mock("../lib/tauri", () => tauriMocks);

const defaultProps = {
  variant: "balanced",
  value: "",
  onChange: vi.fn(),
  status: "idle" as const,
  liveLines: [],
  attachments: [],
  onAddAttachment: vi.fn(),
  onRemoveAttachment: vi.fn(),
  recentMeetings: [],
  onStop: vi.fn(),
  onBrowse: vi.fn(),
  folders: [] as { folder: { id: number; name: string; color: string; instructions: string; created_at: string; updated_at: string; copilot_mode: "no_ai" | "local" | "claude" | "deepseek" }; meeting_count: number }[],
  recordingFolderId: null as number | null,
  onChangeRecordingFolder: vi.fn(),
  copilotCards: [] as import("../types").CopilotCard[],
  onForceCard: vi.fn(),
  onCancel: vi.fn(),
  onRetry: vi.fn(),
  onNotice: vi.fn(),
};

beforeEach(() => {
  tauriMocks.getFolderCopilotBrief.mockResolvedValue({
    folder_id: 1,
    folder_name: "Test",
    copilot_mode: "no_ai",
    copilot_web: false,
    meeting_count: 0,
    last_meeting: null,
    open_items: [],
    decisions: [],
    follow_ups: [],
  });
});

function cardFixture(overrides: Partial<import("../types").CopilotCard> = {}): import("../types").CopilotCard {
  return {
    id: 1,
    session_id: "sess-1",
    status: "answering",
    provider_frozen: "claude",
    question: "What did we decide about the API?",
    asked_at_ms: Date.now(),
    trigger: "auto",
    passages: [
      { source_kind: "meeting", source_id: "42", title: "Kickoff", text: "We chose GraphQL.", score: 0.9 },
    ],
    retrieval_ms: 42,
    ...overrides,
  };
}

describe("RecordingCompanion", () => {
  it("renders live transcript lines with speaker classes", () => {
    render(
      <RecordingCompanion
        {...defaultProps}
        liveLines={[
          { text: "I will send the proposal.", source: "me" },
          { text: "I will review it tomorrow.", source: "them" },
        ]}
      />,
    );

    expect(screen.getByText("I will send the proposal.")).toHaveClass("me");
    expect(screen.getByText("I will review it tomorrow.")).toHaveClass("them");
  });

  it("renders the streaming partial after confirmed lines", () => {
    const { container } = render(
      <RecordingCompanion
        {...defaultProps}
        liveLines={[{ text: "We shipped it.", source: "them" }]}
        livePartials={{ me: "and I think we", them: "" }}
      />,
    );

    expect(screen.getByText("and I think we")).toHaveClass("partial", "me");
    expect(
      Array.from(container.querySelectorAll(".companion-feed-line")).map(
        (line) => line.textContent,
      ),
    ).toEqual(["We shipped it.", "and I think we"]);
  });

  it("shows the partial instead of Listening… when nothing is confirmed yet", () => {
    render(
      <RecordingCompanion
        {...defaultProps}
        liveLines={[]}
        livePartials={{ me: "", them: "hello every" }}
      />,
    );

    expect(screen.queryByText("Listening…")).toBeNull();
    expect(screen.getByText("hello every")).toBeInTheDocument();
  });

  it("calls onChange when typing balanced notes", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<RecordingCompanion {...defaultProps} onChange={onChange} />);

    await user.type(screen.getByRole("textbox"), "A");

    expect(onChange).toHaveBeenCalledWith("A");
  });

  it("calls onStop and disables the stop button while stopping", async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <RecordingCompanion
        {...defaultProps}
        status="recording"
        onStop={onStop}
      />,
    );

    const stopButton = screen.getByRole("button", {
      name: "Stop & summarize",
    });
    await user.click(stopButton);
    expect(onStop).toHaveBeenCalledOnce();

    rerender(
      <RecordingCompanion
        {...defaultProps}
        status="stopping"
        onStop={onStop}
      />,
    );
    expect(stopButton).toBeDisabled();
  });

  it("adds the wide-layout class only to the balanced variant", () => {
    const { container, rerender } = render(
      <RecordingCompanion {...defaultProps} variant="balanced" />,
    );

    expect(container.querySelector(".companion-body")).toHaveClass(
      "balanced-wide",
    );

    rerender(<RecordingCompanion {...defaultProps} variant="transcript" />);
    expect(container.querySelector(".companion-body")).not.toHaveClass(
      "balanced-wide",
    );
  });

  it("renders staged attachments and removes the selected draft", async () => {
    const onRemoveAttachment = vi.fn();
    const user = userEvent.setup();
    render(
      <RecordingCompanion
        {...defaultProps}
        attachments={[
          { kind: "file", value: "/tmp/project-brief.md", label: "Project brief.md" },
        ]}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    expect(screen.getByText("Project brief.md")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Remove Project brief.md" }),
    );

    expect(onRemoveAttachment).toHaveBeenCalledWith(0);
  });

  it("adds a selected recent meeting as staged context", async () => {
    const onAddAttachment = vi.fn();
    const user = userEvent.setup();
    render(
      <RecordingCompanion
        {...defaultProps}
        onAddAttachment={onAddAttachment}
        recentMeetings={[{ id: 42, title: "Northstar kickoff" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "+ Add meeting" }));
    await user.click(screen.getByRole("button", { name: "Northstar kickoff" }));

    expect(onAddAttachment).toHaveBeenCalledWith({
      kind: "meeting",
      value: "42",
      label: "Northstar kickoff",
    });
  });

  it("explains what attaching a meeting does", () => {
    render(<RecordingCompanion {...defaultProps} />);

    expect(
      screen.getByText(
        "Attach a previous meeting and your notes will include a follow-up check on its open action items. Attached files are used as background.",
      ),
    ).toBeVisible();
  });

  it("renders Notes and Last time tabs, switching hides notes textarea and shows folder select", async () => {
    const user = userEvent.setup();
    const folders = [
      { folder: { id: 3, name: "Daily stand-up", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" as const }, meeting_count: 2 },
    ];
    const onChangeRecordingFolder = vi.fn();
    render(
      <RecordingCompanion
        {...defaultProps}
        folders={folders}
        recordingFolderId={null}
        onChangeRecordingFolder={onChangeRecordingFolder}
      />,
    );

    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Last time" })).toHaveAttribute("aria-selected", "false");
    // Notes tab visible
    expect(screen.getByRole("textbox")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Last time" }));

    expect(screen.getByRole("tab", { name: "Last time" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Folder for this meeting")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("changing the folder select calls onChangeRecordingFolder", async () => {
    const user = userEvent.setup();
    const folders = [
      { folder: { id: 3, name: "Daily stand-up", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" as const }, meeting_count: 2 },
      { folder: { id: 5, name: "Planning", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" as const }, meeting_count: 0 },
    ];
    const onChangeRecordingFolder = vi.fn();
    render(
      <RecordingCompanion
        {...defaultProps}
        folders={folders}
        recordingFolderId={null}
        onChangeRecordingFolder={onChangeRecordingFolder}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Last time" }));
    await user.selectOptions(screen.getByLabelText("Folder for this meeting"), "3");
    expect(onChangeRecordingFolder).toHaveBeenCalledWith(3);
  });

  it("shows Filing into line in Notes tab when folder set", async () => {
    const folders = [
      { folder: { id: 3, name: "Daily stand-up", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" as const }, meeting_count: 2 },
    ];
    render(
      <RecordingCompanion
        {...defaultProps}
        folders={folders}
        recordingFolderId={3}
        onChangeRecordingFolder={vi.fn()}
      />,
    );
    expect(screen.getByText("Filing into: Daily stand-up")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Last time" }));
    expect(screen.queryByText("Filing into: Daily stand-up")).not.toBeInTheDocument();
  });

  it("does not show tabs in transcript variant", () => {
    render(<RecordingCompanion {...defaultProps} variant="transcript" />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("renders Copilot tab and shows cards when active", async () => {
    const user = userEvent.setup();
    const card = cardFixture();
    const { container } = render(<RecordingCompanion {...defaultProps} copilotCards={[card]} />);

    expect(screen.getByRole("tab", { name: /Copilot/ })).toBeInTheDocument();
    // question appears in strip even before tab, but full card passage hidden until Copilot tab active
    expect(container.querySelector(".copilot-passage-text")).not.toBeInTheDocument();
    // strip shows truncated question
    expect(screen.getByTestId("copilot-answer-strip")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Copilot/ }));

    expect(screen.queryByText("We chose GraphQL.")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Sources · 1" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sources · 1" }));
    expect(screen.getByText("We chose GraphQL.")).toBeInTheDocument();
  });

  it("badge shows 1 when card arrives while on Notes and clears after switching", async () => {
    const user = userEvent.setup();
    const card = cardFixture({ id: 5, question: "New question?", passages: [], status: "heard" });
    const { rerender } = render(<RecordingCompanion {...defaultProps} copilotCards={[]} />);

    expect(screen.queryByText("1")).not.toBeInTheDocument();

    rerender(<RecordingCompanion {...defaultProps} copilotCards={[card]} />);

    // badge visible while on Notes
    expect(screen.getByText("1")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Copilot/ }));

    // badge cleared after entering Copilot tab
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("pinning appends formatted text through onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const card = cardFixture({ id: 7, status: "done", question: "What is the deadline?", passages: [{ source_kind: "meeting", source_id: "10", title: "Kickoff", text: "Deadline is Friday.", score: 0.9 }], answer: { provider: "claude", status: "done", text: "", citations: [], provenance: [{ text: "Deadline is Friday.", label: "notes", passage_index: 0 }] } });
    render(
      <RecordingCompanion {...defaultProps} value="existing notes" onChange={onChange} copilotCards={[card]} />,
    );
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    await user.click(screen.getByRole("button", { name: "Pin card 7 to notes" }));

    expect(onChange).toHaveBeenCalled();
    const called = String(onChange.mock.calls[0][0]);
    expect(called).toContain("Copilot:");
    expect(called).toContain("What is the deadline?");
    expect(called).toContain("[your notes]");
  });

  it("pinning with empty notes does not add leading newline", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const card = cardFixture({ id: 8, status: "done", question: "Q?", passages: [{ source_kind: "meeting", source_id: "1", title: "M", text: "Answer.", score: 1 }], answer: { provider: "claude", status: "done", text: "", citations: [], provenance: [{ text: "Answer.", label: "notes", passage_index: 0 }] } });
    render(<RecordingCompanion {...defaultProps} value="" onChange={onChange} copilotCards={[card]} />);
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    await user.click(screen.getByRole("button", { name: "Pin card 8 to notes" }));
    const called = String(onChange.mock.calls[0][0]);
    expect(called.startsWith("Copilot:")).toBeTruthy();
    expect(called).toContain("Q?");
  });

  it("pinning a sections card writes Copilot suggestion with Say and notes", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const card = cardFixture({
      id: 9,
      status: "done",
      question: "What is status?",
      passages: [{ source_kind: "meeting", source_id: "1", title: "Kickoff", text: "p", score: 1 }],
      answer: {
        provider: "claude",
        status: "done",
        text: "Hello world",
        citations: [],
        sections: {
          say: ["Hello world."],
          specifics: ["Spec line"],
          notes: [{ passage_index: 0, quote: "exact quote", clause: "supports", text: "P1 | \"exact quote\" | supports" }],
          next: "Follow?",
        },
      },
    });
    render(<RecordingCompanion {...defaultProps} value="existing" onChange={onChange} copilotCards={[card]} />);
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    await user.click(screen.getByRole("button", { name: "Pin card 9 to notes" }));
    const pinned = String(onChange.mock.calls[0][0]);
    expect(pinned).toContain("Copilot suggestion:");
    expect(pinned).toContain("Say:");
    expect(pinned).toContain("- From your notes:");
  });

  it("shows Folder: Interviews when brief resolves Interviews", async () => {
    tauriMocks.getFolderCopilotBrief.mockResolvedValue({
      folder_id: 2,
      folder_name: "Interviews",
      copilot_mode: "no_ai",
      copilot_web: false,
      meeting_count: 0,
      last_meeting: null,
      open_items: [],
      decisions: [],
      follow_ups: [],
    });
    const user = userEvent.setup();
    render(
      <RecordingCompanion
        {...defaultProps}
        folders={[{ folder: { id: 2, name: "Interviews", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" }, meeting_count: 0 }]}
        recordingFolderId={2}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    // folder readiness lives in the head menu; brief resolves async
    await user.click(screen.getByRole("button", { name: "More options" }));
    expect(await screen.findByText(/Folder: Interviews/)).toBeVisible();
  });

  it("shows Folder: none without folder", async () => {
    const user = userEvent.setup();
    render(<RecordingCompanion {...defaultProps} recordingFolderId={null} />);
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    await user.click(screen.getByRole("button", { name: "More options" }));
    expect(await screen.findByText("Folder: none")).toBeVisible();
  });

  it("copilot tab shows processing line inside head and correct block order", async () => {
    const user = userEvent.setup();
    const newer = cardFixture({ id: 2, question: "Newer?" });
    const older = cardFixture({ id: 1, question: "Older?" });
    const liveState = { session_id: "sess-1", revision: 1, enabled: true, status: "idle" as const, reason: null, through_ms: 710000, summary: { bullets: [], evidence_turn_ids: [] }, items: [{ id: "li_1", kind: "decision" as const, text: "Decision", original_text: "Decision", owner: null, due: null, status: "proposed" as const, revision: 1, evidence_turn_ids: [], at_ms: 1000, review_events: [] }] };
    const { container } = render(
      <RecordingCompanion
        {...defaultProps}
        liveLines={[{ text: "Hello", source: "them" }, { text: "World", source: "me" }]}
        copilotCards={[newer, older]}
        liveState={liveState}
        copilotSessionId="sess-1"
      />,
    );
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    // transcript untouched
    expect(container.querySelector(".companion-transcript")).not.toBeNull();
    // processing line lives in the head menu, not in the head row
    expect(container.querySelector(".lc-head-process")).toBeNull();
    expect(screen.queryByText(/Transcript: local/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More options" }));
    expect(await screen.findByText(/Transcript: local/)).toBeVisible();
    expect(screen.getByText(/Web off/)).toBeVisible();
    expect(container.querySelector(".lc-process")).toBeNull();
    expect(container.querySelector(".lc-transcript")).toBeNull();
    expect(container.querySelector(".lc-col-head")).toBeNull();
    // right side split
    expect(container.querySelector(".lc-copilot-row")).not.toBeNull();
    expect(container.querySelector(".lc-copilot-col")).not.toBeNull();
    expect(container.querySelector(".lc-review-col")).not.toBeNull();
    expect(container.querySelectorAll(".lc-head").length).toBe(1);
    // block order: head (with compact consent) -> card -> panels -> earlier (one scroller)
    const row = container.querySelector(".lc-copilot-row") as HTMLElement;
    expect(row).not.toBeNull();
    // compact consent seg lives inside the head row next to Answer last
    expect(row.querySelector(".lc-head .copilot-consent--compact .lc-consent-seg")).not.toBeNull();
    expect(row.querySelector(".lc-copilot-col .copilot-card")).not.toBeNull();
    // wait for lazy LiveReviewPanels
    await new Promise((r) => setTimeout(r, 50));
    const reviewCol = container.querySelector(".lc-review-col") as HTMLElement;
    expect(reviewCol).not.toBeNull();
    expect(reviewCol.textContent).toMatch(/Live review|Live capture/);
  });

  it("processing line reflects AI mode and web flag", async () => {
    const user = userEvent.setup();
    const { container } = render(<RecordingCompanion {...defaultProps} copilotCards={[]} />);
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    expect(container.querySelector(".lc-head-process")).toBeNull();
    await user.click(screen.getByRole("button", { name: "More options" }));
    expect(await screen.findByText(/AI: No AI/)).toBeVisible();
    expect(screen.getByText(/Web off/)).toBeVisible();
  });

  it("copilot tab right side splits and transcript untouched", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <RecordingCompanion
        {...defaultProps}
        liveLines={[{ text: "Hello", source: "them" }]}
        copilotCards={[cardFixture({ id: 1, question: "Q?" })]}
        folders={[{ folder: { id: 1, name: "Interviews", color: "#fff", instructions: "", created_at: "", updated_at: "", copilot_mode: "no_ai" }, meeting_count: 1 }]}
        recordingFolderId={1}
        copilotSessionId="sess-1"
        liveState={{ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 60000, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /Copilot/ }));
    expect(await screen.findByText("Q?")).toBeInTheDocument();
    // transcript untouched
    expect(container.querySelector(".companion-transcript")).not.toBeNull();
    expect(container.querySelector(".lc-copilot-row")).not.toBeNull();
    expect(container.querySelector(".lc-copilot-col")).not.toBeNull();
    expect(container.querySelector(".lc-review-col")).not.toBeNull();
    expect(container.querySelectorAll(".lc-head").length).toBe(1);
    expect(container.querySelector(".lc-transcript")).toBeNull();
    expect(container.querySelector(".lc-col-head")).toBeNull();
    // compact consent
    const seg = container.querySelector(".lc-consent-seg");
    expect(seg).not.toBeNull();
    expect(seg?.querySelectorAll("button").length).toBe(4);
    // Notes tab still renders .companion-notes
    await user.click(screen.getByRole("tab", { name: /Notes/ }));
    expect(container.querySelector(".companion-notes")).not.toBeNull();
  });
});
