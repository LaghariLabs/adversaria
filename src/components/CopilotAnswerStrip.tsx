import type { CopilotCard } from "../types";
import { stripInlineBold } from "../lib/inlineBold";

interface Props {
  cards: CopilotCard[];
  activeTab: string;
  onOpen: (cardId: number) => void;
}

function truncate(text: string, max = 80): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function providerName(provider: string | undefined): string {
  if (provider === "local") return "Local";
  if (provider === "deepseek") return "DeepSeek";
  return "Claude";
}

function stateLabel(card: CopilotCard): string {
  if (card.status === "heard") return "Heard";
  if (card.status === "answering") {
    const ans = card.answer;
    if (ans?.status === "searching") return "Searching the web…";
    if (ans?.status === "streaming") {
      return `Thinking (${providerName(ans.provider)})…`;
    }
    if (ans?.status === "done" && ans.provenance && ans.provenance.length > 0) {
      return stripInlineBold(ans.provenance[0].text).slice(0, 80);
    }
    return `Thinking (${providerName(ans?.provider)})…`;
  }
  if (card.status === "done") {
    const prov = card.answer?.provenance;
    if (prov && prov.length > 0) return stripInlineBold(prov[0].text).slice(0, 80);
    if (card.answer?.text) return stripInlineBold(card.answer.text).slice(0, 80);
    return "Done";
  }
  if (card.status === "skipped") return "Skipped";
  return "Heard";
}

export function CopilotAnswerStrip({ cards, activeTab, onOpen }: Props): JSX.Element | null {
  if (cards.length === 0) return null;
  if (activeTab === "copilot") return null;
  const latest = cards[0];
  if (!latest) return null;
  const question = truncate(latest.question, 80);
  const state = stateLabel(latest);
  return (
    <div className="copilot-answer-strip" data-testid="copilot-answer-strip">
      <span className="copilot-strip-question" dir="auto">{question}</span>
      <span className="copilot-strip-state">{state}</span>
      <button
        type="button"
        className="copilot-strip-open"
        onClick={() => onOpen(latest.id)}
        aria-label="Open Copilot"
      >
        Open
      </button>
    </div>
  );
}
