import { useEffect, useRef, useState, useCallback } from "react";
import { chatWithMeetingStream, getChatMessages, clearChat } from "../lib/tauri";
import { isRtl, summaryToHtml } from "../lib/summary";
import { friendlyError } from "../lib/errors";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface MeetingChatProps {
  meetingId: number;
}

interface Msg {
  role: string;
  content: string;
}

const MEETING_WORDS = [
  "Reading the transcript…",
  "Cross-referencing turns…",
  "Connecting the dots…",
  "Weighing the evidence…",
  "Consulting the minutes…",
  "Thinking on-device…",
  "Waking the local model…",
  "Rifling through timestamps…",
];

export function MeetingChat({ meetingId }: MeetingChatProps) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  // Switching tabs/meetings unmounts this component mid-stream; the pending
  // promise and channel callbacks must become no-ops (the exchange is already
  // persisted server-side — load() restores it on return).
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Keep the latest message (and streaming tokens) in view without manual scroll.
  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const load = useCallback(async () => {
    try {
      const history = await getChatMessages(meetingId);
      setMessages(history.map((m) => ({ role: m.role, content: m.content })));
    } catch (e) {
      console.error("Failed to load chat history:", e);
    }
  }, [meetingId]);

  useEffect(() => {
    load();
  }, [load]);

  const ask = async () => {
    const q = question.trim();
    if (!q || pending) return;
    setPending(true);
    setError(null);
    // Add the user message + an empty assistant message we stream into.
    setMessages((prev) => [
      ...prev,
      { role: "user", content: q },
      { role: "assistant", content: "" },
    ]);
    setQuestion("");

    const appendToAssistant = (text: string, replace = false) => {
      if (unmountedRef.current) return;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = {
            ...last,
            content: replace ? text : last.content + text,
          };
        }
        return next;
      });
    };

    try {
      const full = await chatWithMeetingStream(meetingId, q, (tok) =>
        appendToAssistant(tok),
      );
      // Replace with the authoritative full answer (covers any token gaps).
      appendToAssistant(full, true);
    } catch (e) {
      if (!unmountedRef.current) {
        setError(String(e));
        // Drop the empty assistant placeholder we added.
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant" && last.content === "") next.pop();
          return next;
        });
      }
    } finally {
      if (!unmountedRef.current) setPending(false);
    }
  };

  const handleClear = async () => {
    try {
      await clearChat(meetingId);
      setMessages([]);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-history" ref={historyRef}>
        {messages.length === 0 && !pending && (
          <div className="chat-msg ai">
            Ask anything about this meeting — answers come only from its transcript.
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div
              key={i}
              dir={isRtl(m.content) ? "rtl" : "ltr"}
              className="chat-msg user"
            >
              {m.content}
            </div>
          ) : m.content === "" && pending && i === messages.length - 1 ? (
            // The empty assistant placeholder we stream into IS the thinking
            // bubble — rendering the indicator inside it avoids a second bubble.
            <div key={i} className="chat-msg ai">
              <ThinkingIndicator words={MEETING_WORDS} />
            </div>
          ) : (
            <div
              key={i}
              dir={isRtl(m.content) ? "rtl" : "ltr"}
              className="chat-msg ai"
              dangerouslySetInnerHTML={{ __html: summaryToHtml(m.content) }}
            />
          ),
        )}

        {error && (
          <div className="chat-msg ai" style={{ color: "var(--accent-red)" }}>
            {friendlyError(error)}
          </div>
        )}
      </div>

      <div className="chat-input-row">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") ask();
          }}
          disabled={pending}
          placeholder="Ask about this meeting…"
          aria-label="Ask a question about this meeting"
          className="chat-textbox"
        />
        <button
          onClick={ask}
          disabled={pending || !question.trim()}
          className="btn-primary"
        >
          {pending ? "Asking…" : "Send"}
        </button>
        {messages.length > 0 && (
          <button onClick={handleClear} className="btn-secondary">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
