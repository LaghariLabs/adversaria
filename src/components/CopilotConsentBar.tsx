import { useState } from "react";
import type { CopilotMode } from "../types";
import { COPY } from "../lib/platform";

export interface CopilotConsentBarProps {
  mode: CopilotMode;
  hasClaudeKey: boolean;
  hasDeepSeekKey?: boolean;
  hasFolder?: boolean;
  folderName?: string | null;
  onChange: (mode: CopilotMode) => void;
  compact?: boolean;
}

export const CONSENT_LINES: Record<CopilotMode, string> = {
  no_ai: `No AI \u00b7 passages from your notes only, nothing leaves this ${COPY.device}`,
  local: "Copilot on \u00b7 Local \u00b7 answers from your machine using this folder's sources",
  claude: "Copilot on \u00b7 Claude \u00b7 sends the current question, up to 4 recent turns, up to 3 passages from this folder's sources, this folder's instructions, your folder profile and voice samples; never the full transcript. Also sent: a one-paragraph summary of each project in this folder, and up to three earlier copilot suggestions from this session.",
  deepseek: "Copilot on \u00b7 DeepSeek \u00b7 sends the current question, up to 4 recent turns, up to 3 passages from this folder's sources, this folder's instructions, your folder profile and voice samples; never the full transcript. Also sent: a one-paragraph summary of each project in this folder, and up to three earlier copilot suggestions from this session.",
};

export function CopilotConsentBar({ mode, hasClaudeKey, hasDeepSeekKey = false, hasFolder = true, folderName = null, onChange, compact = false }: CopilotConsentBarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const segmented = (
    <div role="radiogroup" className="lc-consent-seg" aria-label="Copilot mode">
      <button
        type="button"
        role="radio"
        aria-checked={mode === "no_ai"}
        className={mode === "no_ai" ? "lc-consent-seg--active" : undefined}
        onClick={() => onChange("no_ai")}
      >
        No AI
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "local"}
        aria-label="AI · Local"
        className={mode === "local" ? "lc-consent-seg--active" : undefined}
        onClick={() => onChange("local")}
      >
        Local
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "claude"}
        aria-label="AI · Claude"
        className={mode === "claude" ? "lc-consent-seg--active" : undefined}
        disabled={!hasClaudeKey}
        title={!hasClaudeKey ? "Add an Anthropic API key in Settings \u203a Live Copilot" : undefined}
        onClick={() => onChange("claude")}
      >
        Claude
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === "deepseek"}
        aria-label="AI · DeepSeek"
        className={mode === "deepseek" ? "lc-consent-seg--active" : undefined}
        disabled={!hasDeepSeekKey}
        title={!hasDeepSeekKey ? "Add a DeepSeek API key in Settings › Live Copilot" : undefined}
        onClick={() => onChange("deepseek")}
      >
        DeepSeek
      </button>
    </div>
  );
  if (compact) {
    return (
      <div className="copilot-consent copilot-consent--compact">
        {segmented}
      </div>
    );
  }
  const showFolder = hasFolder && !!folderName;
  const folderLabel = hasFolder ? `Folder: ${folderName ?? "…"}` : null;
  const needsClaudeKey = mode === "claude" && !hasClaudeKey;
  const needsDeepSeekKey = mode === "deepseek" && !hasDeepSeekKey;

  return (
    <div className="copilot-consent">
      <div className="lc-consent-row">
        {segmented}
        {showFolder ? <span className="lc-consent-folder">{folderLabel}</span> : null}
        <div style={{ position: "relative", marginLeft: 8 }}>
          <button
            type="button"
            aria-label="Consent details"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="lc-head-menu-btn"
            style={{ width: 24, height: 24, minHeight: 24, fontSize: 12 }}
          >
            …
          </button>
          {menuOpen && (
            <div role="menu" className="lc-head-menu-popover" style={{ minWidth: 280 }}>
              <p className="copilot-consent-line" style={{ fontSize: 11, lineHeight: "16px" }}>{CONSENT_LINES[mode]}</p>
              {!hasFolder && mode !== "no_ai" && (
                <p className="copilot-consent-line" style={{ fontSize: 11, lineHeight: "16px" }}>No folder chosen: only your live notes and attachments are searched.</p>
              )}
            </div>
          )}
        </div>
      </div>
      {(needsClaudeKey || needsDeepSeekKey) && (
        <p className="lc-consent-hint">
          {needsClaudeKey ? "Add an Anthropic API key in Settings › Live Copilot" : "Add a DeepSeek API key in Settings › Live Copilot"}
        </p>
      )}
    </div>
  );
}
