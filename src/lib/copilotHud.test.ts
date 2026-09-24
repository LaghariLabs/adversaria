import { describe, expect, it } from "vitest";
import { hudReducer, initialHudState, type HudState } from "./copilotHud";
import type { CopilotAnswerEvent, CopilotCard } from "../types";

function card(id: number, overrides: Partial<CopilotCard> = {}): CopilotCard {
  return {
    id,
    session_id: "sess-1",
    status: "answering",
    provider_frozen: "local",
    question: `question ${id}?`,
    asked_at_ms: 0,
    trigger: "auto",
    passages: [],
    ...overrides,
  };
}

function answer(
  cardId: number,
  overrides: Partial<CopilotAnswerEvent> = {},
): CopilotAnswerEvent {
  return {
    card_id: cardId,
    session_id: "sess-1",
    provider: "local",
    kind: "delta",
    ...overrides,
  };
}

function withCards(n: number): HudState {
  let state = initialHudState;
  for (let id = 1; id <= n; id++) {
    state = hudReducer(state, { type: "card", card: card(id) });
  }
  return state;
}

describe("copilotHud reducer", () => {
  it("starts empty with viewIndex -1", () => {
    expect(initialHudState.cards).toEqual([]);
    expect(initialHudState.viewIndex).toBe(-1);
  });

  it("card adds with resolved_question preferred and follows newest", () => {
    let state = hudReducer(initialHudState, {
      type: "card",
      card: card(1, {
        question: "raw?",
        resolved_question: "resolved?",
        answer_shape: "steps",
      }),
    });
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0].question).toBe("resolved?");
    expect(state.cards[0].shape).toBe("steps");
    expect(state.cards[0].status).toBe("streaming");
    expect(state.viewIndex).toBe(0);

    state = hudReducer(state, { type: "card", card: card(2) });
    expect(state.cards).toHaveLength(2);
    expect(state.cards[1].question).toBe("question 2?");
    expect(state.cards[1].shape).toBe("brief");
    expect(state.viewIndex).toBe(1);
  });

  it("duplicate card is ignored (same ref)", () => {
    const state = withCards(1);
    expect(hudReducer(state, { type: "card", card: card(1) })).toBe(state);
  });

  it("say delta appends to say", () => {
    let state = withCards(1);
    state = hudReducer(state, {
      type: "answer",
      event: answer(1, { section: "say", index: 0, text: "Churn is " }),
    });
    state = hudReducer(state, {
      type: "answer",
      event: answer(1, { section: "say", index: 1, text: "bad." }),
    });
    expect(state.cards[0].say).toBe("Churn is bad.");
  });

  it("specific delta routes by index, padding gaps", () => {
    let state = withCards(1);
    state = hudReducer(state, {
      type: "answer",
      event: answer(1, { section: "specific", index: 0, text: "Price" }),
    });
    state = hudReducer(state, {
      type: "answer",
      event: answer(1, { section: "specific", index: 0, text: " hikes" }),
    });
    state = hudReducer(state, {
      type: "answer",
      event: answer(1, { section: "specific", index: 2, text: "Third" }),
    });
    expect(state.cards[0].specifics).toEqual(["Price hikes", "", "Third"]);
  });

  it("notes and next deltas are ignored (same ref)", () => {
    const state = withCards(1);
    expect(
      hudReducer(state, {
        type: "answer",
        event: answer(1, { section: "notes", index: 0, text: "note" }),
      }),
    ).toBe(state);
    expect(
      hudReducer(state, {
        type: "answer",
        event: answer(1, { section: "next", index: 0, text: "next?" }),
      }),
    ).toBe(state);
  });

  it("delta for an unknown card is ignored (same ref)", () => {
    const state = withCards(1);
    expect(
      hudReducer(state, {
        type: "answer",
        event: answer(99, { section: "say", text: "x" }),
      }),
    ).toBe(state);
  });

  it("done sets status and adopts final sections", () => {
    let state = withCards(1);
    state = hudReducer(state, {
      type: "answer",
      event: answer(1, {
        kind: "done",
        sections: {
          say: ["Final", "say."],
          specifics: ["One", "Two"],
          notes: [],
          next: null,
        },
      }),
    });
    expect(state.cards[0].status).toBe("done");
    expect(state.cards[0].say).toBe("Final say.");
    expect(state.cards[0].specifics).toEqual(["One", "Two"]);
  });

  it("error and cancelled set status", () => {
    let state = withCards(1);
    state = hudReducer(state, {
      type: "answer",
      event: answer(1, { kind: "error", error: "boom" }),
    });
    expect(state.cards[0].status).toBe("error");

    state = withCards(1);
    state = hudReducer(state, {
      type: "answer",
      event: answer(1, { kind: "cancelled", reason: "user" }),
    });
    expect(state.cards[0].status).toBe("cancelled");
  });

  it("new card follows when viewing newest, stays put when stepped back", () => {
    let state = withCards(2);
    expect(state.viewIndex).toBe(1);
    state = hudReducer(state, { type: "card", card: card(3) });
    expect(state.viewIndex).toBe(2);

    state = hudReducer(state, { type: "prev" });
    expect(state.viewIndex).toBe(1);
    state = hudReducer(state, { type: "card", card: card(4) });
    expect(state.cards).toHaveLength(4);
    expect(state.viewIndex).toBe(1);
    expect(state.cards[state.viewIndex].cardId).toBe(2);
  });

  it("prev/next clamp at the ends", () => {
    const state = withCards(2);
    expect(hudReducer(state, { type: "next" })).toBe(state);
    let moved = hudReducer(state, { type: "prev" });
    expect(moved.viewIndex).toBe(0);
    expect(hudReducer(moved, { type: "prev" })).toBe(moved);
    moved = hudReducer(moved, { type: "next" });
    expect(moved.viewIndex).toBe(1);
  });

  it("prev/next on empty state are no-ops", () => {
    expect(hudReducer(initialHudState, { type: "prev" })).toBe(initialHudState);
    expect(hudReducer(initialHudState, { type: "next" })).toBe(initialHudState);
  });
});
