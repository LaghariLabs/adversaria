import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({
  copilotSetMicQuestions: vi.fn().mockResolvedValue(undefined),
  copilotCardReview: vi.fn().mockResolvedValue({ row_id: 1, pinned_at: "2026-09-14T00:00:00Z", dismissed_at: null }),
}));

import { CopilotCards } from "./CopilotCards";
import type { CopilotCard } from "../types";
import { COPY } from "../lib/platform";

function baseCard(overrides: Partial<CopilotCard> = {}): CopilotCard {
  return {
    id: 1,
    session_id: "sess-1",
    status: "answering",
    provider_frozen: "claude",
    question: "Q?",
    asked_at_ms: 65_000,
    trigger: "auto",
    passages: [{ source_kind: "meeting", source_id: "1", title: "M", text: "passage", score: 1 }],
    retrieval_ms: 10,
    ...overrides,
  };
}

describe("CopilotCards answer", () => {
  it("streaming shows text + cursor", () => {
    const card = baseCard({ answer: { provider: "claude", status: "streaming", text: "- hello world", citations: [] } });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(container.textContent).toContain("hello world");
    expect(container.querySelector(".copilot-answer-cursor")).not.toBeNull();
  });
  it("searching shows line", () => {
    const card = baseCard({ answer: { provider: "claude", status: "searching", text: "", citations: [] } });
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getAllByText("Searching the web…").length).toBeGreaterThan(0);
  });
  it("done renders provenance chips and footer", async () => {
    const card = baseCard({
      answer: {
        provider: "claude", status: "done", text: "- bullet", citations: [],
        provenance: [
          { text: "note bullet", label: "notes", passage_index: 0 },
          { text: "web bullet", label: "web", url: "https://example.com" },
          { text: "model bullet", label: "model" },
        ],
        egress_bytes: 812, web_performed: 1,
      },
    });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByText("your notes")).toBeInTheDocument();
    expect(screen.getByText("web · example.com")).toBeInTheDocument();
    expect(screen.getAllByText("Claude")).toHaveLength(2);
    await userEvent.setup().click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText((content) => content.includes("Prepared request payload: 812 bytes"))).toBeInTheDocument();
    expect(container.querySelector("a[href='https://example.com']")).not.toBeNull();
  });
  it("local done shows stayed and Local chip", async () => {
    const card = baseCard({
      answer: { provider: "local", status: "done", text: "", citations: [], provenance: [{ text: "b", label: "model" }], egress_bytes: 0 },
    });
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText(`0 bytes left this ${COPY.device}`)).toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
  });
  it("error shows message and Retry", () => {
    const card = baseCard({ answer: { provider: "claude", status: "error", text: "", citations: [], error: "boom" } });
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} onRetry={vi.fn()} copilotMode="claude" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
  it("cancelled shows message and Retry", () => {
    const card = baseCard({ answer: { provider: "claude", status: "cancelled", text: "", citations: [], reason: "user" } });
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} onRetry={vi.fn()} copilotMode="claude" />);
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
  it("hostile string renders as text", () => {
    const card = baseCard({ answer: { provider: "claude", status: "streaming", text: "<img src=x onerror=alert(1)>", citations: [] } });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
  it("done without provenance falls back to streamed text", () => {
    const card = baseCard({ answer: { provider: "claude", status: "done", text: "fallback text", citations: [] } });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(container.textContent).toContain("fallback text");
  });
  it("renders the full say text as a single plain headline with no rest paragraph", () => {
    const card = baseCard({
      status: "done",
      answer: {
        provider: "claude",
        status: "done",
        text: "First sentence. Second sentence.",
        citations: [],
        sections: { say: ["First sentence.", "Second sentence."], specifics: [], notes: [], next: null },
      },
    });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.queryByText("Say")).toBeNull();
    const headline = container.querySelector(".copilot-headline");
    expect(headline).not.toBeNull();
    expect(headline?.textContent).toBe("First sentence. Second sentence.");
    expect(container.querySelector(".copilot-headline-rest")).toBeNull();
    expect(container.querySelector(".copilot-more")).toBeNull();
  });
  it("renders specifics as brief bullets with the trust in the meta line for a local answer", () => {
    const card = baseCard({
      status: "done",
      provider_frozen: "local",
      answer: {
        provider: "local",
        status: "done",
        text: "",
        citations: [],
        sections: { say: ["Hello."], specifics: ["Spec one", "Spec two"], notes: [], next: null },
      },
    });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(container.querySelectorAll(".copilot-brief-bullet")).toHaveLength(2);
    expect(container.querySelector(".copilot-trust")).toBeNull();
    expect(screen.getByTestId("copilot-card-meta").textContent).toBe("Local · model knowledge");
  });
  it("shows a supported trust line when notes cite a passage", () => {
    const card = baseCard({
      passages: [{ source_kind: "meeting", source_id: "1", title: "Kickoff", text: "passage", score: 1 }],
      status: "done",
      answer: {
        provider: "claude",
        status: "done",
        text: "",
        citations: [],
        sections: { say: ["Hi."], specifics: [], notes: [{ passage_index: 0, quote: "exact quote", clause: "supports", text: "P1 | \"exact quote\" | supports" }], next: null },
      },
    });
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByTestId("copilot-card-meta").textContent).toBe("Claude · from your notes · 1");
  });
  it("pin calls onPin and persists the review, then reads Pinned", async () => {
    const { copilotCardReview } = await import("../lib/tauri");
    const mocked = vi.mocked(copilotCardReview);
    mocked.mockClear();
    const onPin = vi.fn();
    const card = baseCard({
      status: "done",
      answer: { provider: "claude", status: "done", text: "", citations: [], sections: { say: ["Hi."], specifics: [], notes: [], next: null } },
    });
    const user = userEvent.setup();
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={onPin} />);
    await user.click(screen.getByRole("button", { name: "Pin card 1 to notes" }));
    expect(onPin).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(mocked).toHaveBeenCalledWith("sess-1", 1, "pin");
    expect(screen.getByText("Pinned")).toBeInTheDocument();
  });
  it("dismiss hides the card and persists the review", async () => {
    const { copilotCardReview } = await import("../lib/tauri");
    const mocked = vi.mocked(copilotCardReview);
    mocked.mockClear();
    const card = baseCard({ status: "done", answer: { provider: "claude", status: "done", text: "", citations: [], sections: { say: ["Hi."], specifics: [], notes: [], next: null } } });
    const user = userEvent.setup();
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(container.textContent).toContain("Hi.");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(mocked).toHaveBeenCalledWith("sess-1", 1, "dismiss");
    expect(container.textContent).not.toContain("Hi.");
  });
  it("first-person sentence is rendered", () => {
    const card = baseCard({
      status: "done",
      answer: {
        provider: "claude",
        status: "done",
        text: "I built the gating agent first. Second.",
        citations: [],
        sections: { say: ["I built the gating agent first.", "Second."], specifics: [], notes: [], next: null },
      },
    });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(container.textContent).toContain("I built the gating agent first.");
  });
  it("note with passage_index 0 shows title chip and quote in q", () => {
    const card = baseCard({
      passages: [{ source_kind: "meeting", source_id: "1", title: "Kickoff", text: "passage", score: 1 }],
      status: "done",
      answer: {
        provider: "claude",
        status: "done",
        text: "",
        citations: [],
        sections: { say: ["Hi."], specifics: [], notes: [{ passage_index: 0, quote: "exact quote", clause: "supports", text: "P1 | \"exact quote\" | supports" }], next: null },
      },
    });
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByText("Kickoff")).toBeInTheDocument();
    const q = document.querySelector("q");
    expect(q).not.toBeNull();
    expect(q?.textContent).toBe("exact quote");
  });
  it("non-empty next renders as Follow-up disclosure row", async () => {
    const card = baseCard({
      status: "done",
      answer: {
        provider: "claude",
        status: "done",
        text: "",
        citations: [],
        sections: { say: ["Hi."], specifics: [], notes: [], next: "What next?" },
      },
    });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Follow-up" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("What next?");
    await userEvent.setup().click(screen.getByRole("button", { name: "Follow-up" }));
    expect(container.textContent).toContain("What next?");
    expect(container.querySelector("details.copilot-next")).toBeNull();
  });
  it("card with text and no sections still renders text", () => {
    const card = baseCard({ status: "done", answer: { provider: "claude", status: "done", text: "fallback text", citations: [] } });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(container.textContent).toContain("fallback text");
  });
  it("error answer with partial sections shows error text", () => {
    const card = baseCard({
      answer: {
        provider: "claude",
        status: "error",
        text: "",
        citations: [],
        error: "boom error",
        sections: { say: ["Partial."], specifics: [], notes: [], next: null },
      },
    });
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} onRetry={vi.fn()} copilotMode="claude" />);
    expect(screen.getByText("boom error")).toBeInTheDocument();
    expect(screen.queryByText("Partial.")).not.toBeInTheDocument();
  });

  it("steps answer renders an ordered list directly after the headline with trust in the meta line", () => {
    const card = baseCard({
      status: "done",
      answer_shape: "steps",
      answer: {
        provider: "claude",
        status: "done",
        text: "",
        citations: [],
        sections: { say: ["I'd define success, then clean the data."], specifics: ["Define the target.", "Audit types.", "Fit the model."], notes: [], next: null },
      },
    });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    const ol = container.querySelector("ol.copilot-steps");
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll("li.copilot-step")).toHaveLength(3);
    const headline = container.querySelector(".copilot-headline");
    expect(container.querySelector(".copilot-trust")).toBeNull();
    expect(headline?.nextElementSibling).toBe(ol);
    expect(screen.getByTestId("copilot-card-meta").textContent).toBe("Claude · model knowledge");
  });

  it("steps answer shows no trust line during streaming, only the provider in the meta", () => {
    const card = baseCard({
      status: "answering",
      answer_shape: "steps",
      answer: {
        provider: "claude",
        status: "streaming",
        text: "",
        citations: [],
        sections: { say: ["I'd define success first."], specifics: ["Define the target."], notes: [], next: null },
      },
    });
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.queryByText(/model knowledge/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("copilot-card-meta").textContent).toBe("Claude");
  });

  it("interrupted steps answer keeps its steps and shows Incomplete", () => {
    const card = baseCard({
      answer_shape: "steps",
      answer: {
        provider: "claude",
        status: "error",
        text: "",
        citations: [],
        error: "boom",
        sections: { say: ["I'd define success first."], specifics: ["Define the target.", "Audit the data."], notes: [], next: null },
      },
    });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} onRetry={vi.fn()} copilotMode="claude" />);
    expect(container.querySelector("ol.copilot-steps")).not.toBeNull();
    expect(screen.getByText("Define the target.")).toBeInTheDocument();
    expect(screen.getByText("Audit the data.")).toBeInTheDocument();
    expect(screen.getByText("Incomplete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
