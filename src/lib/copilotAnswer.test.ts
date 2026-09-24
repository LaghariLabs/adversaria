import { describe, expect, it } from "vitest";
import { applyCopilotAnswerEvent, upsertCopilotCard } from "./copilotAnswer";
import type { CopilotCard, CopilotAnswerEvent } from "../types";

function card(id: number, sessionId = "sess-1"): CopilotCard {
  return { id, session_id: sessionId, status: "answering", provider_frozen: "claude", question: "q", asked_at_ms: 0, trigger: "auto", passages: [], retrieval_ms: 1 };
}

const SESS_A = "sess-a";
const SESS_B = "sess-b";

describe("applyCopilotAnswerEvent", () => {
  it("delta appends", () => {
    const ev: CopilotAnswerEvent = { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "hi" };
    let cards = applyCopilotAnswerEvent([card(1, SESS_A)], ev);
    expect(cards[0].answer?.text).toBe("hi");
    cards = applyCopilotAnswerEvent(cards, { ...ev, text: " there" });
    expect(cards[0].answer?.text).toBe("hi there");
  });
  it("preserves DeepSeek as a distinct provider", () => {
    const ev: CopilotAnswerEvent = { card_id: 1, session_id: SESS_A, provider: "deepseek", kind: "delta", text: "hi" };
    const cards = applyCopilotAnswerEvent([card(1, SESS_A)], ev);
    expect(cards[0].answer?.provider).toBe("deepseek");
  });
  it("citation pushes", () => {
    const ev: CopilotAnswerEvent = { card_id: 1, session_id: SESS_A, provider: "claude", kind: "citation", citation: { kind: "notes", passage_index: 0, cited_text: "x" } };
    const cards = applyCopilotAnswerEvent([card(1, SESS_A)], ev);
    expect(cards[0].answer?.citations).toHaveLength(1);
  });
  it("searching sets status", () => {
    const ev: CopilotAnswerEvent = { card_id: 1, session_id: SESS_A, provider: "claude", kind: "searching" };
    const cards = applyCopilotAnswerEvent([card(1, SESS_A)], ev);
    expect(cards[0].answer?.status).toBe("searching");
  });
  it("done sets provenance and egress", () => {
    const ev: CopilotAnswerEvent = { card_id: 1, session_id: SESS_A, provider: "claude", kind: "done", provenance: [{ text: "b", label: "notes" }], egress_bytes: 100, web_performed: 1 };
    const cards = applyCopilotAnswerEvent([card(1, SESS_A)], ev);
    expect(cards[0].answer?.status).toBe("done");
    expect(cards[0].answer?.provenance).toHaveLength(1);
    expect(cards[0].answer?.egress_bytes).toBe(100);
  });
  it("error sets error", () => {
    const ev: CopilotAnswerEvent = { card_id: 1, session_id: SESS_A, provider: "claude", kind: "error", error: "oops" };
    const cards = applyCopilotAnswerEvent([card(1, SESS_A)], ev);
    expect(cards[0].answer?.status).toBe("error");
    expect(cards[0].answer?.error).toBe("oops");
  });
  it("cancelled sets status", () => {
    const ev: CopilotAnswerEvent = { card_id: 1, session_id: SESS_A, provider: "claude", kind: "cancelled", reason: "user" };
    const cards = applyCopilotAnswerEvent([card(1, SESS_A)], ev);
    expect(cards[0].answer?.status).toBe("cancelled");
  });
  it("unknown card leaves unchanged (same ref)", () => {
    const arr = [card(1, SESS_A)];
    const ev: CopilotAnswerEvent = { card_id: 99, session_id: SESS_A, provider: "claude", kind: "delta", text: "x" };
    expect(applyCopilotAnswerEvent(arr, ev)).toBe(arr);
  });
  it("unrelated session leaves unchanged (same ref)", () => {
    const arr = [card(1, SESS_A)];
    const ev: CopilotAnswerEvent = { card_id: 1, session_id: SESS_B, provider: "claude", kind: "delta", text: "x" };
    expect(applyCopilotAnswerEvent(arr, ev)).toBe(arr);
  });
  it("delayed session A delta cannot affect session B card 1", () => {
    const cardB = card(1, SESS_B);
    cardB.question = "B question";
    const evA: CopilotAnswerEvent = { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "A delta" };
    const result = applyCopilotAnswerEvent([cardB], evA);
    expect(result).toBe(result); // same ref, unchanged
    expect(result[0].question).toBe("B question");
    expect(result[0].answer).toBeUndefined();
  });
  it("say sentences accumulate by index and duplicate ignored", () => {
    let cards = [card(1, SESS_A)];
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "First sentence.", section: "say", index: 0 });
    expect(cards[0].answer?.sections?.say).toEqual(["First sentence."]);
    expect(cards[0].answer?.text).toBe("First sentence.");
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "Second sentence.", section: "say", index: 1 });
    expect(cards[0].answer?.sections?.say).toEqual(["First sentence.", "Second sentence."]);
    expect(cards[0].answer?.text).toBe("First sentence. Second sentence.");
    // duplicate index 0 ignored
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "First sentence.", section: "say", index: 0 });
    expect(cards[0].answer?.sections?.say).toEqual(["First sentence.", "Second sentence."]);
    expect(cards[0].answer?.text).toBe("First sentence. Second sentence.");
  });
  it("specific deltas concatenate per index two items", () => {
    let cards = [card(1, SESS_A)];
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "Spec A", section: "specific", index: 0 });
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: " continued", section: "specific", index: 0 });
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "Spec B", section: "specific", index: 1 });
    expect(cards[0].answer?.sections?.specifics).toEqual(["Spec A continued", "Spec B"]);
  });
  it("notes raw text accumulates at its index", () => {
    let cards = [card(1, SESS_A)];
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "part1", section: "notes", index: 0 });
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: " part2", section: "notes", index: 0 });
    expect(cards[0].answer?.sections?.notes[0].text).toBe("part1 part2");
  });
  it("next concatenates", () => {
    let cards = [card(1, SESS_A)];
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "Follow", section: "next", index: 0 });
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: " up?", section: "next", index: 0 });
    expect(cards[0].answer?.sections?.next).toBe("Follow up?");
  });
  it("done with sections replaces accumulated sections", () => {
    let cards = [card(1, SESS_A)];
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "Old.", section: "say", index: 0 });
    const done: CopilotAnswerEvent = { card_id: 1, session_id: SESS_A, provider: "claude", kind: "done", sections: { say: ["New say."], specifics: ["New spec"], notes: [{ passage_index: 0, quote: "q", clause: "c", text: "t" }], next: "Next?" } };
    cards = applyCopilotAnswerEvent(cards, done);
    expect(cards[0].answer?.sections?.say).toEqual(["New say."]);
    expect(cards[0].answer?.sections?.specifics).toEqual(["New spec"]);
  });
  it("legacy delta without section still appends to text", () => {
    let cards = [card(1, SESS_A)];
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "hello" });
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: " world" });
    expect(cards[0].answer?.text).toBe("hello world");
  });
  it("drop removes notes[0] and leaves specifics untouched", () => {
    let cards = [card(1, SESS_A)];
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "Spec A", section: "specific", index: 0 });
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "Spec B", section: "specific", index: 1 });
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "note0", section: "notes", index: 0 });
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", text: "note1", section: "notes", index: 1 });
    expect(cards[0].answer?.sections?.specifics).toEqual(["Spec A", "Spec B"]);
    expect(cards[0].answer?.sections?.notes).toHaveLength(2);
    cards = applyCopilotAnswerEvent(cards, { card_id: 1, session_id: SESS_A, provider: "claude", kind: "delta", section: "notes", index: 0, drop: true });
    expect(cards[0].answer?.sections?.notes).toHaveLength(1);
    expect(cards[0].answer?.sections?.notes[0].text).toBe("note1");
    expect(cards[0].answer?.sections?.specifics).toEqual(["Spec A", "Spec B"]);
  });
});

describe("upsertCopilotCard", () => {
  it("inserts new card at top", () => {
    const c1 = card(1, SESS_A);
    const c2 = { ...card(2, SESS_A), question: "q2" };
    const result = upsertCopilotCard([c1], c2);
    expect(result[0].id).toBe(2);
    expect(result[1].id).toBe(1);
  });
  it("same-session card event upserts passages/status in place without discarding", () => {
    const original = { ...card(1, SESS_A), status: "heard" as const, passages: [] };
    const updated = { ...card(1, SESS_A), status: "answering" as const, passages: [{ source_kind: "meeting" as const, source_id: "1", title: "M", text: "p", score: 1 }], retrieval_ms: 42 };
    const result = upsertCopilotCard([original], updated);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("answering");
    expect(result[0].passages).toHaveLength(1);
    expect(result[0].retrieval_ms).toBe(42);
  });
  it("different session same id is treated as distinct card", () => {
    const a = card(1, SESS_A);
    const b = card(1, SESS_B);
    const result = upsertCopilotCard([a], b);
    expect(result).toHaveLength(2);
  });
});
