import { useEffect, useState } from "react";
import {
  clearCopilotApiKey,
  clearDeepSeekCopilotApiKey,
  hasCopilotApiKey,
  hasDeepSeekCopilotApiKey,
  setCopilotApiKey,
  setDeepSeekCopilotApiKey,
} from "../../lib/tauri";
import type { AppConfig } from "../../types";

interface CopilotSectionProps {
  active: boolean;
  config?: AppConfig | null;
  update?: (patch: Partial<AppConfig>) => void;
}

export function CopilotSection({ active, config, update }: CopilotSectionProps): JSX.Element {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hasDeepSeekKey, setHasDeepSeekKey] = useState<boolean | null>(null);
  const [deepSeekInput, setDeepSeekInput] = useState("");
  const [deepSeekError, setDeepSeekError] = useState<string | null>(null);

  const refresh = async () => {
    const [anthropic, deepseek] = await Promise.allSettled([
      hasCopilotApiKey(),
      hasDeepSeekCopilotApiKey(),
    ]);
    setHasKey(anthropic.status === "fulfilled" ? anthropic.value : false);
    setHasDeepSeekKey(deepseek.status === "fulfilled" ? deepseek.value : false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleSave = async () => {
    setError(null);
    try {
      await setCopilotApiKey(input);
      setInput("");
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleRemove = async () => {
    setError(null);
    try {
      await clearCopilotApiKey();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDeepSeekSave = async () => {
    setDeepSeekError(null);
    try {
      await setDeepSeekCopilotApiKey(deepSeekInput);
      setDeepSeekInput("");
      await refresh();
    } catch (e) {
      setDeepSeekError(String(e));
    }
  };

  const handleDeepSeekRemove = async () => {
    setDeepSeekError(null);
    try {
      await clearDeepSeekCopilotApiKey();
      await refresh();
    } catch (e) {
      setDeepSeekError(String(e));
    }
  };

  if (!active) return <></>;
  return (
    <div style={{ marginTop: 18 }} className="copilot-settings-section">
      <h3 className="settings-card-title" style={{ marginTop: 0 }}>Live Copilot</h3>
      <p className="settings-card-desc">
        Claude or DeepSeek can answer on the Copilot tab while you record. Only the current question, up to 4 recent conversation turns, up to 3 passages, and folder instructions are sent, never the full transcript.
      </p>
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="copilot-api-key">Anthropic API key</label>
        <input
          id="copilot-api-key"
          aria-label="Anthropic API key"
          type="password"
          className="settings-input-text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={hasKey ? "••••••••" : "sk-ant-..."}
        />
      </div>
      <div className="settings-form-group" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" className="btn-primary" onClick={() => void handleSave()}>
          Save key
        </button>
        <button type="button" className="btn-secondary" onClick={() => void handleRemove()}>
          Remove key
        </button>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {hasKey === null ? "" : hasKey ? "Key saved in your keychain" : "No key saved"}
        </span>
      </div>
      {error && <p className="settings-msg err">{error}</p>}

      <div className="settings-form-group" style={{ marginTop: 20 }}>
        <label className="settings-label" htmlFor="copilot-deepseek-api-key">DeepSeek API key</label>
        <input
          id="copilot-deepseek-api-key"
          aria-label="DeepSeek API key"
          type="password"
          className="settings-input-text"
          value={deepSeekInput}
          onChange={(e) => setDeepSeekInput(e.target.value)}
          placeholder={hasDeepSeekKey ? "••••••••" : "sk-..."}
        />
      </div>
      <div className="settings-form-group" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" className="btn-primary" onClick={() => void handleDeepSeekSave()}>
          Save DeepSeek key
        </button>
        <button type="button" className="btn-secondary" onClick={() => void handleDeepSeekRemove()}>
          Remove DeepSeek key
        </button>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {hasDeepSeekKey === null ? "" : hasDeepSeekKey ? "DeepSeek key saved in your keychain" : "No DeepSeek key saved"}
        </span>
      </div>
      {deepSeekError && <p className="settings-msg err">{deepSeekError}</p>}

      <div className="settings-form-group" style={{ marginTop: 20 }}>
        <label className="settings-label" htmlFor="copilot-deepseek-model">DeepSeek model</label>
        <select
          id="copilot-deepseek-model"
          aria-label="DeepSeek model"
          className="settings-select"
          value={config?.copilot_deepseek_model ?? "deepseek-v4-flash"}
          onChange={(e) => update?.({ copilot_deepseek_model: e.target.value as AppConfig["copilot_deepseek_model"] })}
        >
          <option value="deepseek-v4-flash">Flash, fastest</option>
          <option value="deepseek-v4-pro">Pro</option>
        </select>
      </div>
    </div>
  );
}
