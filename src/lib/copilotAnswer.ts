import type { CopilotAnswerEvent, CopilotCard, CopilotSections } from "../types";

function emptySections(): CopilotSections {
  return { say: [], specifics: [], notes: [], next: null };
}

export function applyCopilotAnswerEvent(
  cards: CopilotCard[],
  event: CopilotAnswerEvent,
): CopilotCard[] {
  const idx = cards.findIndex(
    (c) => c.id === event.card_id && c.session_id === event.session_id,
  );
  if (idx === -1) return cards;
  const card = cards[idx];
  let nextCard: CopilotCard;
  const provider = event.provider === "local"
    ? "local"
    : event.provider === "deepseek"
      ? "deepseek"
      : "claude";
  const existing = card.answer;

  switch (event.kind) {
    case "delta": {
      if (event.drop === true) {
        const section = event.section;
        const index = event.index ?? 0;
        if (section === "specific" || section === "notes") {
          if (!existing?.sections) return cards;
          const baseSections: CopilotSections = {
            say: [...existing.sections.say],
            specifics: [...existing.sections.specifics],
            notes: existing.sections.notes.map((n) => ({ ...n })),
            next: existing.sections.next ?? null,
          };
          if (section === "specific") {
            if (index >= 0 && index < baseSections.specifics.length) {
              baseSections.specifics.splice(index, 1);
            }
          } else if (section === "notes") {
            if (index >= 0 && index < baseSections.notes.length) {
              baseSections.notes.splice(index, 1);
            }
          }
          nextCard = {
            ...card,
            answer: {
              ...existing,
              sections: baseSections,
            },
          };
          break;
        }
        // drop with no matching section is a no-op
        return cards;
      }
      const delta = event.text ?? "";
      if (event.section != null) {
        const section = event.section;
        const index = event.index ?? 0;
        const baseSections: CopilotSections = existing?.sections
          ? {
              say: [...existing.sections.say],
              specifics: [...existing.sections.specifics],
              notes: existing.sections.notes.map((n) => ({ ...n })),
              next: existing.sections.next ?? null,
            }
          : emptySections();
        const existingSayLen = existing?.sections?.say.length ?? 0;
        const isSayDuplicate = section === "say" && index < existingSayLen;
        if (section === "say") {
          if (isSayDuplicate) {
            // ignore duplicate - do not push
          } else if (index === baseSections.say.length) {
            baseSections.say.push(delta);
          } else if (index < baseSections.say.length) {
            // shouldn't happen (duplicate already handled)
          } else {
            baseSections.say.push(delta);
          }
        } else if (section === "specific") {
          while (baseSections.specifics.length <= index) baseSections.specifics.push("");
          baseSections.specifics[index] = (baseSections.specifics[index] ?? "") + delta;
        } else if (section === "notes") {
          while (baseSections.notes.length <= index) baseSections.notes.push({ passage_index: null, quote: "", clause: "", text: "" });
          const prev = baseSections.notes[index] ?? { passage_index: null, quote: "", clause: "", text: "" };
          baseSections.notes[index] = { ...prev, text: (prev.text ?? "") + delta };
        } else if (section === "next") {
          baseSections.next = (baseSections.next ?? "") + delta;
        }
        let nextText = existing?.text ?? "";
        if (section === "say" && !isSayDuplicate) {
          nextText = nextText ? nextText + " " + delta : delta;
        }
        // For duplicate say we kept existing text; for non-duplicate we appended above.
        // Simplify: if duplicate we already set nextText to existing.text
        if (existing) {
          nextCard = {
            ...card,
            answer: {
              ...existing,
              text: nextText,
              status: "streaming",
              sections: baseSections,
            },
          };
        } else {
          nextCard = {
            ...card,
            answer: { provider, status: "streaming", text: nextText, citations: [], sections: baseSections },
          };
        }
      } else {
        // legacy delta without section
        if (existing) {
          nextCard = {
            ...card,
            answer: {
              ...existing,
              text: existing.text + delta,
              status: "streaming",
            },
          };
        } else {
          nextCard = {
            ...card,
            answer: { provider, status: "streaming", text: delta, citations: [] },
          };
        }
      }
      break;
    }
    case "citation": {
      const citation = event.citation;
      if (!citation) return cards;
      if (existing) {
        nextCard = {
          ...card,
          answer: {
            ...existing,
            citations: [...existing.citations, citation],
          },
        };
      } else {
        nextCard = {
          ...card,
          answer: {
            provider,
            status: "streaming",
            text: "",
            citations: [citation],
          },
        };
      }
      break;
    }
    case "searching": {
      if (existing) {
        nextCard = { ...card, answer: { ...existing, status: "searching" } };
      } else {
        nextCard = {
          ...card,
          answer: { provider, status: "searching", text: "", citations: [] },
        };
      }
      break;
    }
    case "done": {
      const provenance = event.provenance ?? undefined;
      const egress_bytes = event.egress_bytes ?? undefined;
      const web_requested = event.web_requested ?? undefined;
      const web_performed = event.web_performed ?? undefined;
      const sections = event.sections ?? undefined;
      if (existing) {
        nextCard = {
          ...card,
          answer: {
            ...existing,
            status: "done",
            provenance: provenance ?? existing.provenance,
            egress_bytes: egress_bytes ?? existing.egress_bytes,
            web_requested: web_requested ?? existing.web_requested,
            web_performed: web_performed ?? existing.web_performed,
            sections: sections ?? existing.sections,
          },
        };
        if (sections && nextCard.answer) {
          nextCard.answer.sections = sections;
        }
      } else {
        nextCard = {
          ...card,
          answer: {
            provider,
            status: "done",
            text: "",
            citations: [],
            provenance,
            egress_bytes,
            web_requested,
            web_performed,
            sections,
          },
        };
      }
      break;
    }
    case "error": {
      const msg = event.error ?? "Unknown error";
      const reason = event.reason ?? undefined;
      if (existing) {
        nextCard = {
          ...card,
          answer: { ...existing, status: "error", error: msg, reason },
        };
      } else {
        nextCard = {
          ...card,
          answer: {
            provider,
            status: "error",
            text: "",
            citations: [],
            error: msg,
            reason,
          },
        };
      }
      break;
    }
    case "cancelled": {
      const reason = event.reason ?? undefined;
      const msg = event.error ?? undefined;
      if (existing) {
        nextCard = {
          ...card,
          answer: {
            ...existing,
            status: "cancelled",
            reason,
            error: msg,
          },
        };
      } else {
        nextCard = {
          ...card,
          answer: {
            provider,
            status: "cancelled",
            text: "",
            citations: [],
            reason,
            error: msg,
          },
        };
      }
      break;
    }
    default:
      return cards;
  }

  const next = [...cards];
  next[idx] = nextCard;
  return next;
}

export function upsertCopilotCard(
  cards: CopilotCard[],
  incoming: CopilotCard,
): CopilotCard[] {
  const idx = cards.findIndex(
    (c) => c.id === incoming.id && c.session_id === incoming.session_id,
  );
  if (idx === -1) {
    const next = [incoming, ...cards];
    return next.length > 30 ? next.slice(0, 30) : next;
  }
  const existing = cards[idx];
  const merged: CopilotCard = {
    ...existing,
    ...incoming,
    // preserve answer if incoming has none, else keep incoming answer
    answer: incoming.answer ?? existing.answer,
    answer_shape: incoming.answer_shape ?? existing.answer_shape,
  };
  const next = [...cards];
  next[idx] = merged;
  return next;
}
