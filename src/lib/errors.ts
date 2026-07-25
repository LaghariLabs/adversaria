/**
 * Map a raw IPC/LLM error to a friendly, actionable message when it looks like
 * the LLM server/provider is unreachable. Returns the original string otherwise.
 * The app supports both local (Ollama/MLX) and cloud LLM providers, so the
 * message is deliberately provider-agnostic — no hardcoded server command.
 */
export function friendlyError(raw: string): string {
  const s = raw.toLowerCase();
  const unreachable =
    /connection refused|error sending request|failed to connect|tcp connect|econnrefused|actively refused|connection (error|reset)|could not connect|connect(ion)? timed out|network is unreachable|no route to host|name resolution|dns (error|failure)|request error/.test(
      s,
    );
  if (unreachable) {
    return "Couldn't reach the AI model. If you're running a local model, make sure its server is running (e.g. Ollama, or your MLX/Rapid server on the port set in Settings → AI). If you're using a cloud provider, check your internet connection and your provider/API settings in Settings → AI.";
  }
  return raw;
}
