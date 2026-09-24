import type { ReactNode } from "react";

/** Renders **term** spans as <strong>; every other character stays literal text. */
export function renderInlineBold(text: string): ReactNode[] {
  if (!text) return [];
  const re = /\*\*([^*\n]+?)\*\*/g;
  const result: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).replace(/\*\*/g, "");
    if (before) result.push(before);
    result.push(<strong key={key++}>{match[1]}</strong>);
    lastIndex = match.index + match[0].length;
  }
  const after = text.slice(lastIndex).replace(/\*\*/g, "");
  if (after) result.push(after);
  return result;
}

/** Plain text with the ** markers removed (for truncated previews). */
export function stripInlineBold(text: string): string {
  if (!text) return "";
  return text.replace(/\*\*([^*\n]+?)\*\*/g, "$1").replace(/\*\*/g, "");
}
