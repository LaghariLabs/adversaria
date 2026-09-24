import type { CopilotAnswerEvent, CopilotCard } from "../types";

export type HudCardStatus = "streaming" | "done" | "error" | "cancelled";
export type HudAnswerShape = "brief" | "steps";

export interface HudCard {
  cardId: number;
  sessionId: string;
  question: string;
  say: string;
  specifics: string[];
  status: HudCardStatus;
  shape: HudAnswerShape;
}

export interface HudState {
  cards: HudCard[];
  /** Index into `cards` of the card on screen; -1 when there are no cards. */
  viewIndex: number;
}

export const initialHudState: HudState = { cards: [], viewIndex: -1 };

export type HudAction =
  | { type: "card"; card: CopilotCard }
  | { type: "answer"; event: CopilotAnswerEvent }
  | { type: "prev" }
  | { type: "next" };

function findCard(state: HudState, cardId: number, sessionId: string): number {
  return state.cards.findIndex(
    (c) => c.cardId === cardId && c.sessionId === sessionId,
  );
}

function applyCard(state: HudState, card: CopilotCard): HudState {
  if (findCard(state, card.id, card.session_id) !== -1) return state;
  const next: HudCard = {
    cardId: card.id,
    sessionId: card.session_id,
    question: card.resolved_question || card.question,
    say: "",
    specifics: [],
    status: "streaming",
    shape: card.answer_shape ?? "brief",
  };
  const cards = [...state.cards, next];
  // Follow the newest card only when the user was already viewing the newest;
  // a user who stepped back stays where they put themselves.
  const followingNewest = state.viewIndex === state.cards.length - 1;
  return {
    cards,
    viewIndex: followingNewest ? cards.length - 1 : state.viewIndex,
  };
}

function applyAnswer(state: HudState, event: CopilotAnswerEvent): HudState {
  const idx = findCard(state, event.card_id, event.session_id);
  if (idx === -1) return state;
  const card = state.cards[idx];

  if (event.kind === "delta") {
    if (event.drop === true) return state;
    const text = event.text ?? "";
    if (text === "") return state;
    const section = event.section;
    if (section === "specific") {
      const at = Math.max(0, event.index ?? 0);
      const specifics = [...card.specifics];
      while (specifics.length <= at) specifics.push("");
      specifics[at] = (specifics[at] ?? "") + text;
      const cards = [...state.cards];
      cards[idx] = { ...card, specifics, status: "streaming" };
      return { ...state, cards };
    }
    if (section === "say" || section == null) {
      const cards = [...state.cards];
      cards[idx] = { ...card, say: card.say + text, status: "streaming" };
      return { ...state, cards };
    }
    // "notes" and "next" never reach the HUD.
    return state;
  }

  if (event.kind === "done" || event.kind === "error" || event.kind === "cancelled") {
    const status: HudCardStatus =
      event.kind === "done" ? "done" : event.kind === "error" ? "error" : "cancelled";
    const sections = event.kind === "done" ? event.sections : undefined;
    const cards = [...state.cards];
    cards[idx] = {
      ...card,
      status,
      say: sections ? sections.say.join(" ") : card.say,
      specifics: sections ? [...sections.specifics] : card.specifics,
    };
    return { ...state, cards };
  }

  // citation / searching carry nothing the HUD shows.
  return state;
}

export function hudReducer(state: HudState, action: HudAction): HudState {
  switch (action.type) {
    case "card":
      return applyCard(state, action.card);
    case "answer":
      return applyAnswer(state, action.event);
    case "prev":
      if (state.cards.length === 0 || state.viewIndex <= 0) return state;
      return { ...state, viewIndex: state.viewIndex - 1 };
    case "next":
      if (state.cards.length === 0 || state.viewIndex >= state.cards.length - 1) {
        return state;
      }
      return { ...state, viewIndex: state.viewIndex + 1 };
  }
}
