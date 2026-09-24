import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This jsdom setup exposes no window.localStorage, but "Answer this" reads
// the mic-questions flag through it — provide a minimal in-memory store.
const hudMemoryStore = new Map<string, string>();
const hudStorageStub = {
  getItem: (key: string) => (hudMemoryStore.has(key) ? hudMemoryStore.get(key)! : null),
  setItem: (key: string, value: string) => {
    hudMemoryStore.set(key, String(value));
  },
  removeItem: (key: string) => {
    hudMemoryStore.delete(key);
  },
  clear: () => {
    hudMemoryStore.clear();
  },
  key: (index: number) => Array.from(hudMemoryStore.keys())[index] ?? null,
  get length() {
    return hudMemoryStore.size;
  },
};
Object.defineProperty(window, "localStorage", {
  value: hudStorageStub,
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: hudStorageStub,
  configurable: true,
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../lib/tauri", () => ({
  hideCopilotHud: vi.fn(() => Promise.resolve()),
  copilotAskLast: vi.fn(() =>
    Promise.resolve({ session_id: "sess-1", card_id: 7 }),
  ),
  copilotHudStartDrag: vi.fn(() => Promise.resolve()),
  copilotHudSavePosition: vi.fn(() => Promise.resolve()),
  copilotHudSaveSize: vi.fn(() => Promise.resolve()),
}));

const windowMocks = vi.hoisted(() => ({
  onMoved: vi.fn(() => Promise.resolve(() => {})),
  onResized: vi.fn(() => Promise.resolve(() => {})),
  scaleFactor: vi.fn(() => Promise.resolve(2)),
  getCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: windowMocks.getCurrentWindow,
}));

import { listen } from "@tauri-apps/api/event";
import {
  copilotAskLast,
  copilotHudSaveSize,
  copilotHudStartDrag,
  hideCopilotHud,
} from "../lib/tauri";
import { CopilotHud } from "./CopilotHud";
import type { CopilotAnswerEvent, CopilotCard } from "../types";

// The repo's vitest config uses `restoreMocks: true`, which resets mock
// implementations between tests — re-establish ours before each test.
beforeEach(() => {
  vi.clearAllMocks();
  windowMocks.getCurrentWindow.mockReturnValue({
    onMoved: windowMocks.onMoved,
    onResized: windowMocks.onResized,
    scaleFactor: windowMocks.scaleFactor,
  });
  windowMocks.onMoved.mockImplementation(() => Promise.resolve(() => {}));
  windowMocks.onResized.mockImplementation(() => Promise.resolve(() => {}));
  windowMocks.scaleFactor.mockImplementation(() => Promise.resolve(2));
  vi.mocked(listen).mockImplementation(() => Promise.resolve(() => {}));
  vi.mocked(hideCopilotHud).mockImplementation(() => Promise.resolve());
  vi.mocked(copilotAskLast).mockImplementation(() =>
    Promise.resolve({ session_id: "sess-1", card_id: 7 }),
  );
  vi.mocked(copilotHudStartDrag).mockImplementation(() => Promise.resolve());
  vi.mocked(copilotHudSaveSize).mockImplementation(() => Promise.resolve());
});

type Handler = (event: { payload: unknown }) => void;

function handlers(): { onCard: Handler; onAnswer: Handler } {
  const calls = vi.mocked(listen).mock.calls;
  const find = (name: string): Handler => {
    const hit = calls.find((c) => c[0] === name);
    if (!hit) throw new Error(`no listener registered for ${name}`);
    return hit[1] as unknown as Handler;
  };
  return { onCard: find("copilot-card"), onAnswer: find("copilot-answer") };
}

function baseCard(overrides: Partial<CopilotCard> = {}): CopilotCard {
  return {
    id: 7,
    session_id: "sess-1",
    status: "answering",
    provider_frozen: "local",
    question: "What is churn?",
    asked_at_ms: 1,
    trigger: "auto",
    passages: [],
    ...overrides,
  };
}

function emitCard(card: CopilotCard): void {
  act(() => {
    handlers().onCard({ payload: card });
  });
}

function emitAnswer(event: CopilotAnswerEvent): void {
  act(() => {
    handlers().onAnswer({ payload: event });
  });
}

function say(cardId: number, text: string): CopilotAnswerEvent {
  return {
    card_id: cardId,
    session_id: "sess-1",
    provider: "local",
    kind: "delta",
    section: "say",
    index: 0,
    text,
  };
}

function specific(cardId: number, index: number, text: string): CopilotAnswerEvent {
  return {
    card_id: cardId,
    session_id: "sess-1",
    provider: "local",
    kind: "delta",
    section: "specific",
    index,
    text,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CopilotHud", () => {
  it("renders the empty state", () => {
    render(<CopilotHud />);
    expect(screen.getByText("Listening for a question…")).toBeInTheDocument();
  });

  it("renders question, say and all bullets after events", () => {
    render(<CopilotHud />);
    emitCard(baseCard());
    emitAnswer(say(7, "Churn is customers leaving."));
    emitAnswer(specific(7, 0, "**Price** hikes"));
    emitAnswer(specific(7, 1, "Weak onboarding"));
    emitAnswer(specific(7, 2, "Hidden third"));

    expect(screen.getByText("What is churn?")).toBeInTheDocument();
    expect(screen.getByText("Churn is customers leaving.")).toBeInTheDocument();
    // Bullets share their <p> with a "• " marker (and **bold** splits nodes),
    // so assert on the capsule's full text instead of single-node matchers.
    // Every SPECIFIC line renders; the column clips with a bottom fade.
    const capsule = screen.getByTestId("copilot-hud-capsule");
    expect(capsule.textContent).toContain("Price hikes");
    expect(capsule.textContent).toContain("Weak onboarding");
    expect(capsule.textContent).toContain("Hidden third");
  });

  it("steps shape numbers every step with no +N more", () => {
    render(<CopilotHud />);
    emitCard(baseCard({ id: 9, answer_shape: "steps" }));
    emitAnswer(say(9, "Do this."));
    emitAnswer(specific(9, 0, "First"));
    emitAnswer(specific(9, 1, "Second"));
    emitAnswer(specific(9, 2, "Third"));
    const capsule = screen.getByTestId("copilot-hud-capsule");
    expect(capsule.textContent).toContain("First");
    expect(capsule.textContent).toContain("Second");
    expect(capsule.textContent).toContain("Third");
    expect(capsule.textContent).not.toContain("more");
  });

  it("error shows the question and the fallback line", () => {
    render(<CopilotHud />);
    emitCard(baseCard());
    emitAnswer({
      card_id: 7,
      session_id: "sess-1",
      provider: "local",
      kind: "error",
      error: "boom",
    });
    expect(screen.getByText("What is churn?")).toBeInTheDocument();
    expect(screen.getByText("No answer for this one.")).toBeInTheDocument();
  });

  it("hide button is present without hover and calls hideCopilotHud", () => {
    render(<CopilotHud />);
    // No hover, no card — the × hide button is always visible.
    const hide = screen.getByRole("button", { name: "Hide copilot answers" });
    expect(hide).toBeInTheDocument();
    act(() => {
      hide.click();
    });
    expect(hideCopilotHud).toHaveBeenCalledTimes(1);
  });

  it("mousedown on the capsule starts a drag; mousedown on a button does not", () => {
    render(<CopilotHud />);
    emitCard(baseCard());
    fireEvent.mouseDown(screen.getByTestId("copilot-hud-capsule"));
    expect(copilotHudStartDrag).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(
      screen.getByRole("button", { name: "Hide copilot answers" }),
    );
    expect(copilotHudStartDrag).toHaveBeenCalledTimes(1);
  });

  it("onResized saves the logical size after the debounce", async () => {
    vi.useFakeTimers();
    render(<CopilotHud />);
    await act(async () => {});
    expect(windowMocks.onResized).toHaveBeenCalledTimes(1);
    const calls = windowMocks.onResized.mock.calls as unknown as Array<
      [(e: { payload: { width: number; height: number } }) => void]
    >;
    const onResize = calls[0][0];
    act(() => {
      onResize({ payload: { width: 1440, height: 360 } });
    });
    expect(copilotHudSaveSize).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(copilotHudSaveSize).toHaveBeenCalledTimes(1);
    expect(copilotHudSaveSize).toHaveBeenCalledWith(720, 180);
  });

  it("lists every card newest first with a divider, older ones dimmed", () => {
    render(<CopilotHud />);
    emitCard(baseCard({ id: 1, question: "First?" }));
    emitCard(baseCard({ id: 2, question: "Second?" }));
    const feed = screen.getByTestId("copilot-hud-capsule");
    const questions = Array.from(
      feed.querySelectorAll(".copilot-hud-question"),
    ).map((el) => el.textContent);
    expect(questions).toEqual(["Second?", "First?"]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(screen.getByTestId("copilot-hud-newest").textContent).toContain("Second?");
    expect(screen.getByTestId("copilot-hud-older")).toHaveClass("copilot-hud-block--older");
    expect(screen.queryByRole("button", { name: "Previous answer" })).toBeNull();
  });

  it("a new card scrolls the feed to the top unless the reader scrolled down", () => {
    render(<CopilotHud />);
    emitCard(baseCard({ id: 1, question: "First?" }));
    const feed = document.querySelector(".copilot-hud-feed") as HTMLDivElement;
    feed.scrollTop = 10;
    emitCard(baseCard({ id: 2, question: "Second?" }));
    expect(feed.scrollTop).toBe(0);
    feed.scrollTop = 40;
    emitCard(baseCard({ id: 3, question: "Third?" }));
    expect(feed.scrollTop).toBe(40);
  });

  it("shows the working indicator after 1.5s of empty streaming say", () => {
    vi.useFakeTimers();
    render(<CopilotHud />);
    emitCard(baseCard());
    expect(screen.queryByText("Working it out…")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByText("Working it out…")).toBeInTheDocument();
  });

  it("Answer this asks the latest question without the mic fallback by default", async () => {
    window.localStorage.removeItem("copilot.micQuestions");
    render(<CopilotHud />);
    const answer = screen.getByRole("button", { name: "Answer the latest question" });
    expect(answer).toHaveTextContent("Answer this");
    // Left of the × hide button.
    const header = answer.closest("header");
    const buttons = Array.from(header?.querySelectorAll("button") ?? []);
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Answer the latest question",
      "Hide copilot answers",
    ]);
    act(() => {
      answer.click();
    });
    await waitFor(() => expect(copilotAskLast).toHaveBeenCalledWith(false));
  });

  it("Answer this passes the mic fallback when the companion enabled mic questions", async () => {
    window.localStorage.setItem("copilot.micQuestions", "1");
    try {
      render(<CopilotHud />);
      act(() => {
        screen.getByRole("button", { name: "Answer the latest question" }).click();
      });
      await waitFor(() => expect(copilotAskLast).toHaveBeenCalledWith(true));
    } finally {
      window.localStorage.removeItem("copilot.micQuestions");
    }
  });

  it("a rejected Answer this shows the message under the header", async () => {
    window.localStorage.removeItem("copilot.micQuestions");
    vi.mocked(copilotAskLast).mockImplementationOnce(() =>
      Promise.reject(new Error("No active Copilot session")),
    );
    render(<CopilotHud />);
    act(() => {
      screen.getByRole("button", { name: "Answer the latest question" }).click();
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "No active Copilot session",
    );
  });

  it("mousedown on Answer this never starts a window drag", () => {
    render(<CopilotHud />);
    fireEvent.mouseDown(
      screen.getByRole("button", { name: "Answer the latest question" }),
    );
    expect(copilotHudStartDrag).not.toHaveBeenCalled();
  });
});
