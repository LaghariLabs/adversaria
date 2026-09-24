import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getCopilotHistory: vi.fn(),
  copilotCardReview: vi.fn().mockResolvedValue({ row_id: 1, pinned_at: "2026-09-14T01:10:00+00:00", dismissed_at: null }),
}));

vi.mock("../lib/tauri", () => ({
  getCopilotHistory: mocks.getCopilotHistory,
  copilotCardReview: mocks.copilotCardReview,
}));

import { CopilotHistory, splitHeadline } from "./CopilotHistory";
import type { CopilotHistoryCard, LiveItem } from "../types";

function card(overrides: Partial<CopilotHistoryCard> = {}): CopilotHistoryCard {
  return {
    row_id: 1,
    session_id: "sess-1",
    card_id: 1,
    at: "2026-09-13T19:43:31.090749+00:00",
    finished_at: "2026-09-13T19:43:40.101000+00:00",
    question: "What is LLM?",
    resolved_question: null,
    provider: "local",
    trigger: "auto",
    status: "done",
    reason: null,
    error: null,
    retry_of: null,
    answer_md: "SAY: Hi",
    sections: { say: ["An LLM stands for Large Language Model."], specifics: ["They use transformer architectures."], notes: [], next: null },
    passages: [],
    provenance: [],
    pinned_at: null,
    dismissed_at: null,
    ...overrides,
  };
}

describe("CopilotHistory", () => {
  beforeEach(() => {
    mocks.copilotCardReview.mockClear();
    mocks.copilotCardReview.mockResolvedValue({ row_id: 1, pinned_at: "2026-09-14T01:10:00+00:00", dismissed_at: null });
  });

  it("loads and renders headline + bullets + Model knowledge · Unverified for a done local card", async () => {
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 346, cards: [card()] });
    render(<CopilotHistory meetingId={346} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    expect(screen.getByText("An LLM stands for Large Language Model.")).toBeInTheDocument();
    expect(screen.getByText("They use transformer architectures.")).toBeInTheDocument();
    expect(screen.getByText("Model knowledge \u00b7 Unverified")).toBeInTheDocument();
  });

  it("renders the empty state", async () => {
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [] });
    render(<CopilotHistory meetingId={1} />);
    expect(await screen.findByText("No Copilot suggestions were saved for this meeting.")).toBeInTheDocument();
  });

  it("Not answered filter shows only the error card", async () => {
    const done = card({ row_id: 1, card_id: 1, status: "done" });
    const err = card({ row_id: 2, card_id: 2, status: "error", error: "boom", sections: null, answer_md: null });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [done, err] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Not answered" }));
    expect(screen.queryByText("An LLM stands for Large Language Model.")).not.toBeInTheDocument();
    expect(screen.getByText(/Answer interrupted/)).toBeInTheDocument();
  });

  it("clicking Pin calls copilotCardReview and shows Pinned", async () => {
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [card({ session_id: "sess-1", card_id: 1 })] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(mocks.copilotCardReview).toHaveBeenCalledWith("sess-1", 1, "pin"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Unpin" })).toBeInTheDocument());
  });

  it("a legacy done card without sections shows Full original answer with its provenance text", async () => {
    const legacy = card({ sections: null, provenance: [{ text: "legacy provenance bullet", label: "notes" }] });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [legacy] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("› Full original answer")).toBeInTheDocument());
    // expand disclosure
    const user = userEvent.setup();
    await user.click(screen.getByText("› Full original answer"));
    expect(screen.getByText("legacy provenance bullet")).toBeInTheDocument();
  });

  it("a retry_of chain shows Retried at … → View replacement answer", async () => {
    const original = card({ row_id: 1, card_id: 1, session_id: "sess-1" });
    const retry = card({ row_id: 2, card_id: 2, session_id: "sess-1", retry_of: 1, question: "Retry Q?" });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [original, retry] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText(/Retried at/)).toBeInTheDocument());
    expect(screen.getByText(/View replacement answer/)).toBeInTheDocument();
  });

  it("renders the full say text as a single headline with no rest paragraph", async () => {
    const legacy = card({ sections: { say: ["First sentence. Second sentence here. Third one."], specifics: [], notes: [], next: null } });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [legacy] });
    const { container } = render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    const headline = container.querySelector(".ch-headline");
    expect(headline?.textContent).toBe("First sentence. Second sentence here. Third one.");
    expect(container.querySelector(".ch-headline-rest")).toBeNull();
  });

  it("splitHeadline handles three sentences and single sentence", () => {
    expect(splitHeadline(["First sentence. Second sentence here. Third one."])).toEqual({ headline: "First sentence.", rest: "Second sentence here. Third one." });
    expect(splitHeadline(["Hello world."])).toEqual({ headline: "Hello world.", rest: "" });
  });

  it("active filter pill has aria-pressed=true", async () => {
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [card()] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    const allBtn = screen.getByRole("button", { name: "All" });
    expect(allBtn).toHaveAttribute("aria-pressed", "true");
    const answersBtn = screen.getByRole("button", { name: "Answers" });
    expect(answersBtn).toHaveAttribute("aria-pressed", "false");
    const user = userEvent.setup();
    await user.click(answersBtn);
    expect(answersBtn).toHaveAttribute("aria-pressed", "true");
    expect(allBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("passages disclosure absent when no passages", async () => {
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [card({ passages: [] })] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    expect(screen.queryByText("› Passages and citations")).not.toBeInTheDocument();
  });

  it("passages disclosure present when passages exist", async () => {
    mocks.getCopilotHistory.mockResolvedValueOnce({
      meeting_id: 1,
      cards: [card({ passages: [{ source_kind: "meeting", source_id: "1", title: "Notes", text: "hi", score: 1 }] })],
    });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("› Passages and citations")).toBeInTheDocument());
  });

  it("not-answered entry shows the state line", async () => {
    const err = card({ status: "error", error: "boom", sections: null, answer_md: null });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [err] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Not answered" }));
    expect(screen.getByText(/Answer interrupted: boom/)).toBeInTheDocument();
  });

  it("shows Heard, no answer was generated for heard status", async () => {
    const heard = card({ status: "heard", sections: null, answer_md: null });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [heard] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Not answered" }));
    expect(screen.getByText("Heard, no answer was generated")).toBeInTheDocument();
  });
});

// ---- Slice 3: Live review ----

function liveItem(overrides: Partial<LiveItem> = {}): LiveItem {
  return {
    id: "li-1",
    kind: "decision",
    text: "We will ship v2 next week",
    original_text: "We will ship v2 next week",
    owner: null,
    due: null,
    status: "accepted",
    revision: 1,
    evidence_turn_ids: ["t1"],
    at_ms: 65000,
    review_events: [{ action: "edit" as unknown as "accept", at: "2026-09-14T01:10:00+00:00", before_text: null, after_text: null }],
    ...overrides,
  };
}

describe("CopilotHistory live review", () => {
  beforeEach(() => {
    mocks.getCopilotHistory.mockReset();
    mocks.copilotCardReview.mockClear();
  });

  it("renders Live review group with three items, Kept, Edited at, Deleted at, edited + Original suggestion", async () => {
    const c1 = card({ row_id: 1, card_id: 1, session_id: "sess-1" });
    const c2 = card({ row_id: 2, card_id: 2, session_id: "sess-1", question: "Second Q?" });
    const keptDecision = liveItem({
      id: "li-kept",
      kind: "decision",
      text: "Ship v2 with new flag",
      original_text: "Ship v2 with new flag",
      status: "proposed",
      at_ms: 45000,
      review_events: [],
    });
    const editedAction = liveItem({
      id: "li-act",
      kind: "action",
      text: "Prepare release notes edited",
      original_text: "Prepare release notes",
      owner: "Me",
      due: "Friday",
      status: "accepted",
      at_ms: 90000,
      review_events: [{ action: "edit" as unknown as "accept", at: "2026-09-14T01:12:00+00:00", before_text: "Prepare release notes", after_text: "Prepare release notes edited" }],
    });
    const deletedQuestion = liveItem({
      id: "li-q",
      kind: "question",
      text: "Should we delay launch?",
      original_text: "Should we delay launch?",
      status: "dismissed",
      at_ms: 120000,
      review_events: [{ action: "delete" as unknown as "dismiss", at: "2026-09-14T01:13:00+00:00", before_text: null, after_text: null }],
    });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [c1, c2], live_items: [keptDecision, editedAction, deletedQuestion] });
    const { container } = render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("Live review")).toBeInTheDocument());
    expect(screen.getByText("00:45 · Decision")).toBeInTheDocument();
    expect(screen.getByText("01:30 · Action")).toBeInTheDocument();
    expect(screen.getByText("02:00 · Open question")).toBeInTheDocument();
    expect(screen.getByText("Ship v2 with new flag")).toBeInTheDocument();
    expect(screen.getByText("Prepare release notes edited")).toBeInTheDocument();
    expect(screen.getByText("Should we delay launch?")).toBeInTheDocument();
    expect(screen.getByText(/00:45/)).toBeInTheDocument();
    expect(screen.getByText(/01:30/)).toBeInTheDocument();
    expect(screen.getByText(/02:00/)).toBeInTheDocument();
    expect(screen.getByText("Kept")).toBeInTheDocument();
    expect(screen.getAllByText(/Edited at/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Deleted at/)).toBeInTheDocument();
    expect(screen.getByText("edited")).toBeInTheDocument();
    expect(screen.getByText("› Original suggestion")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByText("› Original suggestion"));
    expect(screen.getByText("Prepare release notes")).toBeInTheDocument();
    // owner/due line
    expect(screen.getByText("Owner: Me · Due: Friday")).toBeInTheDocument();
    // live entries have ch-entry--live
    expect(container.querySelectorAll(".ch-entry--live").length).toBe(3);
  });

  it("Decisions & actions pill hides sessions and shows only live items", async () => {
    const c = card();
    const li = liveItem({ id: "li-1", text: "Only live", at_ms: 10000 });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [c], live_items: [li] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    expect(screen.getByText("An LLM stands for Large Language Model.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Decisions & actions" }));
    expect(screen.queryByText("An LLM stands for Large Language Model.")).not.toBeInTheDocument();
    expect(screen.getByText("Only live")).toBeInTheDocument();
  });

  it("Not answered hides live items (live not counted)", async () => {
    const proposed = liveItem({ id: "li-prop", status: "proposed", text: "Proposed decision", kind: "decision", review_events: [], at_ms: 5000 });
    const accepted = liveItem({ id: "li-acc", status: "accepted", text: "Accepted decision", at_ms: 6000 });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [], live_items: [proposed, accepted] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("Live review")).toBeInTheDocument());
    expect(screen.getByText("Proposed decision")).toBeInTheDocument();
    expect(screen.getByText("Accepted decision")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Not answered" }));
    expect(screen.queryByText("Proposed decision")).not.toBeInTheDocument();
    expect(screen.queryByText("Accepted decision")).not.toBeInTheDocument();
    expect(screen.queryByText("Kept")).not.toBeInTheDocument();
  });

  it("Dismissed filter shows deleted live items", async () => {
    const kept = liveItem({ id: "li-kept", status: "proposed", text: "Kept decision", kind: "decision", review_events: [], at_ms: 5000 });
    const deleted = liveItem({ id: "li-del", status: "dismissed", text: "Deleted decision", kind: "decision", review_events: [{ action: "delete" as unknown as "dismiss", at: "2026-09-14T01:13:00+00:00", before_text: null, after_text: null }], at_ms: 6000 });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [card()], live_items: [kept, deleted] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("Live review")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Dismissed" }));
    expect(screen.queryByText("Kept decision")).not.toBeInTheDocument();
    expect(screen.getByText("Deleted decision")).toBeInTheDocument();
    expect(screen.getByText(/Deleted at/)).toBeInTheDocument();
  });

  it("live_items missing from response does not crash", async () => {
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [card()] } as unknown as { meeting_id: number; cards: CopilotHistoryCard[] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("AI suggestions and your review")).toBeInTheDocument());
    expect(screen.getByText("An LLM stands for Large Language Model.")).toBeInTheDocument();
    expect(screen.queryByText("Live review")).not.toBeInTheDocument();
  });

  it("subline shows 3 live items", async () => {
    const lis = [liveItem({ id: "a", at_ms: 1000 }), liveItem({ id: "b", at_ms: 2000 }), liveItem({ id: "c", at_ms: 3000 })];
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [card(), card({ row_id: 2, card_id: 2 })], live_items: lis });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText(/3 live items/)).toBeInTheDocument());
  });

  it("retracted live items show Withdrawn with the quote", async () => {
    const retracted = liveItem({ id: "r", status: "retracted", text: "Mermaid idea", withdrawal_quote: "scrap the Mermaid idea completely", at_ms: 1000 });
    const visible = liveItem({ id: "v", status: "accepted", text: "Visible", at_ms: 2000 });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [], live_items: [retracted, visible] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("Visible")).toBeInTheDocument());
    expect(screen.getByText("Mermaid idea")).toBeInTheDocument();
    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    expect(screen.getByText('"scrap the Mermaid idea completely"')).toBeInTheDocument();
  });

  it("steps card renders an ordered list in history", async () => {
    const steps = card({
      answer_shape: "steps",
      sections: { say: ["Do it in order."], specifics: ["Step one.", "Step two.", "Step three."], notes: [], next: null },
    });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [steps] });
    const { container } = render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("Do it in order.")).toBeInTheDocument());
    const ol = container.querySelector("ol.ch-steps");
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll("li")).toHaveLength(3);
  });

  it("Answers and Pinned hide live items", async () => {
    const li = liveItem({ id: "li-ans", text: "Live should hide" });
    mocks.getCopilotHistory.mockResolvedValueOnce({ meeting_id: 1, cards: [card()], live_items: [li] });
    render(<CopilotHistory meetingId={1} />);
    await waitFor(() => expect(screen.getByText("Live should hide")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Answers" }));
    expect(screen.queryByText("Live should hide")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pinned" }));
    expect(screen.queryByText("Live should hide")).not.toBeInTheDocument();
  });
});
