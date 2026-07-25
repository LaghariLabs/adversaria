import { useEffect, useRef, useState } from "react";
import {
  askAllMeetings,
  getAskConversation,
  clearAskConversation,
} from "../lib/tauri";
import type { AskMessage, ChatTurn } from "../types";
import { summaryToHtml } from "../lib/summary";
import { friendlyError } from "../lib/errors";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface AskAllViewProps {
  onOpenMeeting: (id: number) => void;
}

const ASK_WORDS = [
  "Searching all meetings…",
  "Ranking the best matches…",
  "Reading the summaries…",
  "Cross-referencing meetings…",
  "Connecting the dots…",
  "Thinking on-device…",
  "Waking the local model…",
  "Pulling the receipts…",
];

const SUGGESTIONS = [
  "What decisions did we make regarding product launch?",
  "What are my deliverables for next week?",
  "What did we agree on with Hamza?",
];

/** How many recent messages to send back as conversation context. */
const HISTORY_MESSAGES = 8;

/** Provenance badge per answer layer — which source the answer came from. */
const INTENT_BADGE: Record<string, string> = {
  todos: "From your To-dos",
  recap: "Weekly rollup",
  overview: "From summaries",
  detail: "From transcripts",
};

export function AskAllView({ onOpenMeeting }: AskAllViewProps) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load the persisted conversation on mount, and RECONNECT to an answer that's
  // still being generated in the background. The Ask runs entirely in Rust: it
  // persists the user turn immediately and the assistant turn on completion, and
  // keeps running even after this tab unmounts. So if the last stored message is
  // an unanswered user turn, a query is in flight — show "Asking…" and poll
  // until the assistant turn lands (bounded, so a failed run doesn't hang).
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const isAnswered = (msgs: AskMessage[]) =>
      msgs.length === 0 || msgs[msgs.length - 1].role === "assistant";

    const poll = async (attemptsLeft: number) => {
      if (cancelled) return;
      try {
        const msgs = await getAskConversation();
        if (cancelled) return;
        setMessages(msgs);
        if (isAnswered(msgs)) {
          setPending(false);
          return;
        }
      } catch {
        /* keep polling — transient */
      }
      if (attemptsLeft <= 0) {
        // The background run didn't resolve in time (crashed sidecar, etc.).
        if (!cancelled) setPending(false);
        return;
      }
      timer = window.setTimeout(() => poll(attemptsLeft - 1), 2000);
    };

    getAskConversation()
      .then((msgs) => {
        if (cancelled) return;
        setMessages(msgs);
        if (!isAnswered(msgs)) {
          setPending(true); // in-flight from a previous mount → reconnect
          timer = window.setTimeout(() => poll(45), 2000); // ~90 s ceiling
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Keep the latest message in view as the conversation grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const ask = async (override?: string) => {
    const q = (override ?? question).trim();
    if (!q || pending) return;

    // Recent turns become the conversation context for follow-ups ("which
    // company is he in" → "…is Wajee in"). Built from the prior messages.
    const history: ChatTurn[] = messages
      .slice(-HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));

    setError(null);
    setQuestion("");
    // Show the question immediately as its own bubble (before the answer lands).
    setMessages((prev) => [
      ...prev,
      { role: "user", content: q, sources: [], intent: "" },
    ]);
    setPending(true);

    try {
      const res = await askAllMeetings(q, history);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.answer,
          sources: res.sources,
          intent: res.intent,
        },
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  const askSuggestion = (s: string) => {
    ask(s);
  };

  const newConversation = async () => {
    try {
      await clearAskConversation();
    } catch {
      // non-critical; clearing locally is enough for the session
    }
    setMessages([]);
    setError(null);
    setQuestion("");
  };

  const empty = messages.length === 0 && !pending;

  return (
    <div className="ask-layout">
      <div className="ask-header">
        <h1 className="ask-title">Ask Across Meetings</h1>
        <p className="ask-subtitle">
          Ask a question and get an answer grounded in your most relevant
          meetings — all local. Follow-up questions keep their context.
        </p>

        {empty && (
          <div className="ask-suggestions">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                className="ask-suggestion-btn"
                onClick={() => askSuggestion(s)}
                disabled={pending}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {messages.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <button
            className="btn-secondary"
            style={{ height: 28, fontSize: 11, padding: "0 10px" }}
            onClick={newConversation}
            disabled={pending}
          >
            New conversation
          </button>
        </div>
      )}

      <div className="ask-chat-area" ref={scrollRef}>
        {empty && (
          <div className="ask-chat-empty">
            Ask your first cross-meeting query above to search.
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ask-chat-msg user" dir="auto">
              {m.content}
            </div>
          ) : (
            <div key={i} className="ask-chat-msg ai">
              {INTENT_BADGE[m.intent] && (
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-muted)",
                    marginBottom: 6,
                  }}
                >
                  {INTENT_BADGE[m.intent]}
                </div>
              )}
              <div
                dir="auto"
                dangerouslySetInnerHTML={{ __html: summaryToHtml(m.content) }}
              />
              {m.sources.map((s) => (
                <a
                  key={s.id}
                  href="#"
                  className="ask-chat-reference"
                  title="Open meeting"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenMeeting(s.id);
                  }}
                >
                  📄 Reference Note: {s.title}
                </a>
              ))}
            </div>
          ),
        )}

        {pending && <div className="ask-chat-msg ai"><ThinkingIndicator words={ASK_WORDS} /></div>}

        {error && (
          <div className="ask-chat-msg ai" style={{ color: "var(--accent-red)" }}>
            {friendlyError(error)}
          </div>
        )}
      </div>

      <div className="ask-input-row">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") ask();
          }}
          disabled={pending}
          placeholder="Ask a question across all your meetings (e.g. 'What were the action items for marketing?')…"
          aria-label="Ask across all meetings"
          className="ask-textbox"
        />
        <button
          onClick={() => ask()}
          disabled={pending || !question.trim()}
          className="btn-primary"
        >
          {pending ? "Asking…" : "Ask AI"}
        </button>
      </div>
    </div>
  );
}
