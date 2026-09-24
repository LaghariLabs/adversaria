export function splitHeadline(say: string[]): { headline: string; rest: string } {
  const joined = say.join(" ");
  if (!joined.trim()) return { headline: "", rest: "" };
  const sentences = joined.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  const headline = sentences[0] ?? "";
  const rest = sentences.slice(1).join(" ");
  return { headline, rest };
}
