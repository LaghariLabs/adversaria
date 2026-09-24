import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CopilotCards, cleanPassageText, renderPassage } from "./CopilotCards";
import type { CopilotCard } from "../types";

function card(text: string, title = "Northstar kickoff"): CopilotCard {
  return {
    id: 7,
    session_id: "sess-1",
    status: "answering",
    provider_frozen: "claude",
    question: "What did we decide?",
    asked_at_ms: 65_000,
    trigger: "manual",
    passages: [{ source_kind: "meeting", source_id: "42", title, text, score: 0.8 }],
    retrieval_ms: 12,
  };
}

describe("copilot passages render safely", () => {
  it("renders HTML in a disclosed passage as literal text, never as elements", async () => {
    const hostile = 'Note: <script>alert(1)</script> and <img src=x onerror="alert(1)"> end';
    const { container } = render(
      <CopilotCards cards={[card(hostile)]} onForceCard={vi.fn()} onPin={vi.fn()} />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Sources · 1" }));
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders **bold** markers as <strong> without raw HTML", async () => {
    const { container } = render(
      <CopilotCards cards={[card("**Key Topics**\n- retry job shipped")]} onForceCard={vi.fn()} onPin={vi.fn()} />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Sources · 1" }));
    const strong = container.querySelector(".copilot-passage-text strong");
    expect(strong?.textContent).toBe("Key Topics");
    expect(container.textContent).not.toContain("**Key Topics**");
  });

  it("drops a leading title line, with or without a date", () => {
    expect(cleanPassageText("Northstar kickoff\nHamza: hello", "Northstar kickoff")).toBe("Hamza: hello");
    expect(cleanPassageText("northstar kickoff (2026-07-06)\nHamza: hello", "Northstar kickoff")).toBe("Hamza: hello");
    expect(cleanPassageText("Other line\nHamza: hello", "Northstar kickoff")).toBe("Other line\nHamza: hello");
  });

  it("renderPassage returns strings and strong nodes only", () => {
    const nodes = renderPassage("a **b** c");
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toBe("a ");
    expect(nodes[2]).toBe(" c");
  });

  it("shows a Show more toggle only for long passages and expands on click", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Speaker ${i % 2}: line ${i} of the transcript`).join("\n");
    render(<CopilotCards cards={[card(long)]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sources · 1" }));
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(document.querySelector(".copilot-passage-text--clamped")).not.toBeNull();
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
    expect(document.querySelector(".copilot-passage-text--clamped")).toBeNull();
  });

  it("has no toggle for a short passage", async () => {
    render(<CopilotCards cards={[card("short")]} onForceCard={vi.fn()} onPin={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sources · 1" }));
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });
});
