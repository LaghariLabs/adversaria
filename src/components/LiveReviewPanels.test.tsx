import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { LiveState } from "../types";

const mocks = vi.hoisted(() => ({
  copilotLiveState: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveConfigure: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 2, enabled: false, status: "off", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
  copilotLiveReview: vi.fn().mockResolvedValue({ session_id: "sess-1", revision: 6, enabled: true, status: "idle", reason: null, through_ms: 1000, summary: { bullets: [], evidence_turn_ids: [] }, items: [] }),
}));

vi.mock("../lib/tauri", () => mocks);

import { LiveReviewPanels } from "./LiveReviewPanels";

function makeFixture(overrides: Partial<LiveState> = {}): LiveState {
  return {
    session_id: "sess-1",
    revision: 5,
    enabled: true,
    status: "idle",
    reason: null,
    through_ms: 760000,
    summary: { bullets: ["Bullet one about topic.", "Bullet two."], evidence_turn_ids: ["t1"] },
    items: [
      { id: "li_111111111111", kind: "decision", text: "Decision A", original_text: "Decision A", owner: null, due: null, status: "proposed", revision: 1, evidence_turn_ids: ["t1"], at_ms: 1000, review_events: [] },
      { id: "li_222222222222", kind: "decision", text: "Decision B", original_text: "Decision B", owner: null, due: null, status: "proposed", revision: 1, evidence_turn_ids: ["t2"], at_ms: 2000, review_events: [] },
      { id: "li_333333333333", kind: "action", text: "Prepare demo", original_text: "Prepare demo", owner: "Me", due: null, status: "accepted", revision: 2, evidence_turn_ids: ["t3"], at_ms: 3000, review_events: [{ action: "edit_accept", at: "2026-09-14T00:00:00Z", before_text: null, after_text: "Prepare demo" }] },
      { id: "li_444444444444", kind: "question", text: "What is deadline?", original_text: "What is deadline?", owner: null, due: null, status: "proposed", revision: 1, evidence_turn_ids: ["t4"], at_ms: 4000, review_events: [] },
    ],
    ...overrides,
  };
}

describe("LiveReviewPanels", () => {
  beforeEach(() => {
    mocks.copilotLiveConfigure.mockClear();
    mocks.copilotLiveReview.mockClear();
    mocks.copilotLiveState.mockClear();
    mocks.copilotLiveConfigure.mockResolvedValue(makeFixture());
    mocks.copilotLiveReview.mockResolvedValue(makeFixture({ revision: 6 }));
  });

  it("renders four panels with counts from fixture state", () => {
    const state = makeFixture();
    const { container } = render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    const html = container.textContent ?? "";
    expect(html).toContain("Decisions");
    expect(html).toContain("Decisions · 2");
    expect(html).toContain("Action items");
    expect(html).toContain("Action items · 1");
    expect(html).toContain("Open questions");
    expect(html).toContain("Open questions · 1");
    expect(html).toContain("Running summary");
    expect(html).toContain("Through 12:40");
    expect(screen.getByText("Bullet one about topic.")).toBeInTheDocument();
    expect(screen.getByText("Bullet two.")).toBeInTheDocument();
    expect(screen.getByText("Decision A")).toBeInTheDocument();
    expect(screen.getByText("Prepare demo")).toBeInTheDocument();
    // counts should be simple numbers, not "needs review" / "accepted"
    expect(html).not.toContain("needs review");
    expect(html).not.toContain("need review");
    expect(screen.queryByText(/Accepted/)).not.toBeInTheDocument();
  });

  it("rows render text + two icon buttons and no Accept button", () => {
    const state = makeFixture();
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    expect(screen.getByText("Decision A")).toBeInTheDocument();
    const editButtons = screen.getAllByLabelText("Edit");
    const deleteButtons = screen.getAllByLabelText("Delete");
    expect(editButtons.length).toBeGreaterThanOrEqual(4);
    expect(deleteButtons.length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("Accept")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();

    const actionContainers = screen.getAllByTestId("live-item-actions");
    expect(actionContainers.length).toBeGreaterThanOrEqual(4);
    for (const actions of actionContainers) {
      const row = actions.parentElement;
      expect(row).not.toBeNull();
      expect(row!.classList.contains("live-item")).toBe(true);
      expect(row!.querySelector(".live-item-text")).not.toBeNull();
      const main = row!.querySelector(".live-item-main");
      expect(main).not.toBeNull();
      expect(main!.nextElementSibling).toBe(actions);
    }
  });

  it("edited mark shown for accepted item and meta line", () => {
    const state = makeFixture();
    const { container } = render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    // accepted item shows edited mark
    expect(container.textContent).toContain("edited");
    // meta line contains From mm:ss
    expect(container.textContent).toContain("From 0:03");
    // action item meta includes Owner when present is just the value; here Me + From
    expect(container.textContent).toContain("Me");
  });

  it("deepseek mode renders panels normally", () => {
    const state = makeFixture();
    const { container } = render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="deepseek" onStateChange={vi.fn()} />);
    expect(container.textContent).toContain("Decisions · 2");
    expect(screen.queryByText("Live review needs an AI mode (extraction runs on your local model)")).not.toBeInTheDocument();
  });

  it("no_ai mode shows the muted line and no panels", () => {
    const state = makeFixture();
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="no_ai" onStateChange={vi.fn()} />);
    expect(screen.getByText("Live review needs an AI mode (extraction runs on your local model)")).toBeInTheDocument();
    expect(screen.queryByText("LIVE REVIEW")).not.toBeInTheDocument();
  });

  it("returns null when sessionId is null", () => {
    const { container } = render(<LiveReviewPanels sessionId={null} state={makeFixture()} copilotMode="local" onStateChange={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("Pencil opens form and Save sends edit", async () => {
    const state = makeFixture();
    const nextState = { ...state, revision: 6, items: state.items.map((i) => i.id === "li_111111111111" ? { ...i, text: "Decision A edited", status: "accepted" as const } : i) };
    mocks.copilotLiveReview.mockResolvedValue(nextState);
    const onStateChange = vi.fn();
    const user = userEvent.setup();
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={onStateChange} />);
    await user.click(screen.getAllByLabelText("Edit")[0]);
    const textInput = screen.getByLabelText("Edit text");
    await user.clear(textInput);
    await user.type(textInput, "Decision A edited");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.copilotLiveReview).toHaveBeenCalledWith("sess-1", "li_111111111111", "edit", expect.objectContaining({ text: "Decision A edited" })));
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith(nextState));
  });

  it("Save disabled when text empty", async () => {
    const state = makeFixture();
    const user = userEvent.setup();
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    await user.click(screen.getAllByLabelText("Edit")[0]);
    const textInput = screen.getByLabelText("Edit text");
    await user.clear(textInput);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("X sends delete and shows Deleted · Undo; Undo sends restore", async () => {
    const state = makeFixture();
    const dismissedState: LiveState = {
      ...state,
      revision: 6,
      items: state.items.map((i) => i.id === "li_111111111111" ? { ...i, status: "dismissed" as const, review_events: [{ action: "delete" as unknown as "dismiss", at: new Date().toISOString(), before_text: null, after_text: null }] } : i),
    };
    mocks.copilotLiveReview.mockResolvedValue(dismissedState);
    const onStateChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={onStateChange} />);
    await user.click(screen.getAllByLabelText("Delete")[0]);
    await waitFor(() => expect(mocks.copilotLiveReview).toHaveBeenCalledWith("sess-1", "li_111111111111", "delete", undefined));
    // simulate parent updating state to dismissed
    rerender(<LiveReviewPanels sessionId="sess-1" state={dismissedState} copilotMode="local" onStateChange={onStateChange} />);
    expect(screen.getByText("Deleted")).toBeInTheDocument();
    expect(screen.getByLabelText("Undo")).toBeInTheDocument();
    // dismissed items otherwise hidden without undo window - there should be no disclosure
    expect(screen.queryByText(/Dismissed \(/)).not.toBeInTheDocument();
    // clicking Undo calls restore
    mocks.copilotLiveReview.mockResolvedValue(state);
    await user.click(screen.getByLabelText("Undo"));
    await waitFor(() => expect(mocks.copilotLiveReview).toHaveBeenCalledWith("sess-1", "li_111111111111", "restore", undefined));
  });

  it("switch toggles Live capture via copilotLiveConfigure", async () => {
    const state = makeFixture({ enabled: true });
    const toggled: LiveState = { ...state, enabled: false, status: "off" };
    mocks.copilotLiveConfigure.mockResolvedValue(toggled);
    const onStateChange = vi.fn();
    const user = userEvent.setup();
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={onStateChange} />);
    const checkbox = screen.getByLabelText("Live capture") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    await waitFor(() => expect(mocks.copilotLiveConfigure).toHaveBeenCalledWith("sess-1", false));
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith(toggled));
  });

  it("shows busy status text", () => {
    const state = makeFixture({ status: "busy", enabled: true });
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    expect(screen.getByText("Waiting while Copilot answers")).toBeInTheDocument();
  });

  it("shows updating status text", () => {
    const state = makeFixture({ status: "updating" });
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    expect(screen.getByText("Updating from recent conversation…")).toBeInTheDocument();
  });

  it("shows error status with Retry button that calls configure", async () => {
    const state = makeFixture({ status: "error", reason: "network fail" });
    const onStateChange = vi.fn();
    const next = makeFixture({ status: "idle" });
    mocks.copilotLiveConfigure.mockResolvedValue(next);
    const user = userEvent.setup();
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={onStateChange} />);
    expect(screen.getByText(/Update failed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.copilotLiveConfigure).toHaveBeenCalledWith("sess-1", true));
  });

  it("shows Through time when idle and through_ms > 0", () => {
    const state = makeFixture({ status: "idle", through_ms: 125000 });
    const { container } = render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    const html = container.textContent ?? "";
    expect(html).toContain("Through 2:05");
    expect(html).toContain("LIVE REVIEW");
  });

  it("shows Off when status off", () => {
    const state = makeFixture({ status: "off", enabled: false });
    const { container } = render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    const html = container.textContent ?? "";
    expect(html).toContain("LIVE REVIEW");
    expect(html).toContain("Off");
  });

  it("retracted items are not rendered", () => {
    const state = makeFixture({
      items: [
        ...makeFixture().items,
        { id: "li_retracted0001", kind: "decision", text: "Retracted decision", original_text: "Retracted decision", owner: null, due: null, status: "retracted", revision: 1, evidence_turn_ids: ["t5"], at_ms: 5000, review_events: [] },
      ],
    });
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    expect(screen.queryByText("Retracted decision")).not.toBeInTheDocument();
  });

  it("empty panels show correct messages and none yet counts", () => {
    const empty: LiveState = { session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0, summary: { bullets: [], evidence_turn_ids: [] }, items: [] };
    const { container } = render(<LiveReviewPanels sessionId="sess-1" state={empty} copilotMode="local" onStateChange={vi.fn()} />);
    expect(screen.getByText("No decisions detected yet.")).toBeInTheDocument();
    expect(screen.getByText("No action items detected yet.")).toBeInTheDocument();
    expect(screen.getByText("No open questions detected yet.")).toBeInTheDocument();
    expect(screen.getByText("No summary yet.")).toBeInTheDocument();
    const html = container.textContent ?? "";
    expect(html).toContain("Decisions · none yet");
    expect(html).toContain("Action items · none yet");
    expect(html).toContain("Open questions · none yet");
    expect(html).toContain("Running summary · none yet");
  });

  it("action edit form shows Owner and Due inputs", async () => {
    const state: LiveState = {
      session_id: "sess-1", revision: 1, enabled: true, status: "idle", reason: null, through_ms: 0,
      summary: { bullets: [], evidence_turn_ids: [] },
      items: [{ id: "li_aaaaaaaaaaaaaaaa", kind: "action", text: "Do thing", original_text: "Do thing", owner: "Me", due: "Friday", status: "proposed", revision: 1, evidence_turn_ids: ["t1"], at_ms: 1000, review_events: [] }],
    };
    const user = userEvent.setup();
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={vi.fn()} />);
    await user.click(screen.getByLabelText("Edit"));
    expect(screen.getByPlaceholderText("Owner")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Due")).toBeInTheDocument();
  });

  it("retracted items not counted in summary titles", () => {
    const stateWithRetracted: LiveState = {
      ...makeFixture(),
      items: [
        ...makeFixture().items,
        { id: "li_retracted0002", kind: "decision", text: "Retracted decision 2", original_text: "Retracted decision 2", owner: null, due: null, status: "retracted", revision: 1, evidence_turn_ids: ["t5"], at_ms: 5000, review_events: [] },
      ],
    };
    const { container } = render(<LiveReviewPanels sessionId="sess-1" state={stateWithRetracted} copilotMode="local" onStateChange={vi.fn()} />);
    expect(screen.queryByText("Retracted decision 2")).not.toBeInTheDocument();
    const html = container.textContent ?? "";
    expect(html).toContain("Decisions");
    expect(html).toContain("Decisions · 2");
  });

  it("retracted item renders a Withdrawn row with quote and Undo sends restore", async () => {
    const state = makeFixture({
      items: [
        ...makeFixture().items,
        { id: "li_retracted0003", kind: "decision", text: "Mermaid idea", original_text: "Mermaid idea", owner: null, due: null, status: "retracted" as const, revision: 1, evidence_turn_ids: ["t5"], at_ms: 5000, review_events: [], withdrawal_quote: "scrap the Mermaid idea completely" },
      ],
    });
    const restored: LiveState = {
      ...state,
      items: state.items.map((i) => (i.id === "li_retracted0003" ? { ...i, status: "proposed" as const, withdrawal_quote: null } : i)),
    };
    mocks.copilotLiveReview.mockResolvedValue(restored);
    const onStateChange = vi.fn();
    const user = userEvent.setup();
    render(<LiveReviewPanels sessionId="sess-1" state={state} copilotMode="local" onStateChange={onStateChange} />);
    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    expect(screen.getByText('"scrap the Mermaid idea completely"')).toBeInTheDocument();
    await user.click(screen.getByLabelText("Undo"));
    await waitFor(() => expect(mocks.copilotLiveReview).toHaveBeenCalledWith("sess-1", "li_retracted0003", "restore", undefined));
    await waitFor(() => expect(onStateChange).toHaveBeenCalledWith(restored));
  });
});
