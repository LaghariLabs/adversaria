export function engineLabel(id: string): string {
  if (id === "local") return "Local model";
  if (id === "claude") return "Claude Code";
  if (id === "codex") return "Codex";
  return id;
}
