import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri", () => ({
  copilotSetMicQuestions: vi.fn().mockResolvedValue(undefined),
  copilotCardReview: vi.fn().mockResolvedValue({ row_id: 1, pinned_at: "2026-09-14T00:00:00Z", dismissed_at: null }),
}));

import { CopilotCards } from "./CopilotCards";
import type { CopilotCard } from "../types";

function baseCard(overrides: Partial<CopilotCard> = {}): CopilotCard {
  return {
    id: 1,
    session_id: "sess-1",
    status: "done",
    provider_frozen: "local",
    question: "Gen AI vs traditional programming?",
    asked_at_ms: 65_000,
    trigger: "auto",
    passages: [],
    retrieval_ms: 10,
    ...overrides,
  };
}

describe("CopilotCards quiet format", () => {
  it("renders a plain lead line, keyword-bold bullets, and a meta line with no Done text", () => {
    const card = baseCard({
      answer: {
        provider: "local",
        status: "done",
        text: "",
        citations: [],
        sections: {
          say: ["Code follows rules; Gen AI learns from data."],
          specifics: ["**Rules**: predictable inputs.", "**Gen AI**: fuzzy tasks."],
          notes: [],
          next: null,
        },
      },
    });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    const headline = container.querySelector(".copilot-headline");
    expect(headline).not.toBeNull();
    expect(headline?.textContent).toBe("Code follows rules; Gen AI learns from data.");
    expect(headline?.querySelector("strong")).toBeNull();
    const strongs = container.querySelectorAll(".copilot-brief-bullet strong");
    expect(strongs).toHaveLength(2);
    expect(strongs[0].textContent).toBe("Rules");
    expect(strongs[1].textContent).toBe("Gen AI");
    expect(container.textContent).not.toContain("**");
    expect(screen.getByTestId("copilot-card-meta").textContent).toBe("Local · model knowledge");
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("shows the notes count in the meta line when notes exist", () => {
    const card = baseCard({
      passages: [{ source_kind: "meeting", source_id: "1", title: "Kickoff", text: "passage", score: 1 }],
      answer: {
        provider: "local",
        status: "done",
        text: "",
        citations: [],
        sections: {
          say: ["Hello."],
          specifics: [],
          notes: [{ passage_index: 0, quote: "exact quote", clause: "supports", text: "P1" }],
          next: null,
        },
      },
    });
    render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByTestId("copilot-card-meta").textContent).toBe("Local · from your notes · 1");
  });

  it("shows manual in the meta line, not in the question row", () => {
    const card = baseCard({
      trigger: "manual",
      answer: {
        provider: "local",
        status: "done",
        text: "",
        citations: [],
        sections: { say: ["Hello."], specifics: [], notes: [], next: null },
      },
    });
    const { container } = render(<CopilotCards cards={[card]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    expect(screen.getByTestId("copilot-card-meta").textContent).toContain("manual");
    const questionRow = container.querySelector(".copilot-card-question");
    expect(questionRow).not.toBeNull();
    expect(questionRow?.textContent).not.toContain("manual");
  });
});
