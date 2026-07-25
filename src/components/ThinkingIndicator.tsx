import { useEffect, useState } from "react";

interface ThinkingIndicatorProps {
  words: string[];
}

/** The wordmark "A" whose glow traces the letterform while the local model
 *  works, beside a status word that rotates every 1.6 s. Pure CSS/SVG. */
export function ThinkingIndicator({ words }: ThinkingIndicatorProps) {
  const [i, setI] = useState(() => Math.floor(Math.random() * words.length));
  useEffect(() => {
    const id = setInterval(() => setI((p) => (p + 1) % words.length), 1600);
    return () => clearInterval(id);
  }, [words.length]);
  return (
    <div className="chat-thinking" aria-live="polite">
      <span className="think-a" aria-hidden="true">A</span>
      <span className="thinking-word">{words[i]}</span>
    </div>
  );
}
