import { useCallback, useEffect, useRef, useState } from "react";

import { TriangleAlert } from "lucide-react";

import type { AppConfig, PromptTemplate, TemplateInfo } from "../../types";
import type { SettingsModels } from "../../hooks/useSettingsModels";
import { EngineInstallCard } from "../EngineInstallCard";
import { formatGb, isInFlight } from "../../lib/modelDownloads";
import {
  deleteTemplate,
  generateTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
  testLlmConnection,
} from "../../lib/tauri";
import { templateDisplayName, templateSlug } from "../../lib/templateNames";

const PROVIDER_LABEL: Record<string, string> = {
  groq: "Groq",
  grok: "xAI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  custom: "an external service",
};

// The local LLM model name is OS-specific: macOS serves it via Rapid-MLX under
// the alias `qwen3.6-35b`; Windows uses the Ollama tag `qwen3.6:35b-a3b`. Pick
// the right one so switching to "Local" sets a model the local server actually
// has (otherwise the request 404s with "model … does not exist").
const IS_MAC =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.platform || navigator.userAgent || "");
const LOCAL_DEFAULT_MODEL = IS_MAC ? "qwen3.5-4b-4bit" : "qwen3.6:35b-a3b";

// Default model for each provider, applied when the user switches engine so the
// model name always matches the selected provider.
const DEFAULT_MODEL: Record<string, string> = {
  groq: "qwen/qwen3-32b",
  grok: "grok-3",
  openrouter: "qwen/qwen3.6-35b",
  deepseek: "deepseek-v4-pro",
  local: LOCAL_DEFAULT_MODEL,
};

/** Per-provider hints so the simplified engine picker can stay tidy. */
const MODEL_PLACEHOLDER: Record<string, string> = {
  groq: "qwen/qwen3-32b",
  openrouter: "qwen/qwen3-32b",
  local: "qwen3.6:35b",
};

interface NotesSectionProps {
  active: boolean;
  config: AppConfig;
  update: (patch: Partial<AppConfig>) => void;
  models: SettingsModels;
}

/**
 * Notes — where a transcript becomes written notes.
 *
 * Only the transcript is used at this step; the recording is never sent
 * anywhere, which is why a cloud notes engine is a much smaller privacy
 * decision than a cloud transcription engine.
 */
export function NotesSection({ active, config, update, models }: NotesSectionProps) {
  const {
    setup,
    modelMsg,
    setModelMsg,
    modelSwitching,
    downloads,
    beginDownload,
    switchLocalModel,
    refreshSetup,
  } = models;
  // Which profile the dropdown is showing (not necessarily in use yet).
  const [chosenId, setChosenId] = useState<string | null>(null);
  // Windows: a Download click on a pinned tier first opens the engine consent
  // card; the model download follows only after the engine install succeeds.
  const [engineConsentFor, setEngineConsentFor] = useState<string | null>(null);
  const [llmTest, setLlmTest] = useState<{
    status: "idle" | "testing" | "ok" | "error";
    msg: string;
  }>({ status: "idle", msg: "" });

  // --- Prompt templates ---
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<string>("");
  const [templateBody, setTemplateBody] = useState<string>("");
  const [newTemplateName, setNewTemplateName] = useState<string>("");
  const [templateMsg, setTemplateMsg] = useState<string>("");

  const loadTemplates = useCallback(async () => {
    // The Python sidecar takes a few seconds to boot (Whisper load) on startup,
    // so /templates isn't ready the instant Settings mounts. A one-shot fetch
    // would leave the Prompts tab permanently blank if it lost that race. There
    // are always >=4 bundled templates, so an empty result means "not ready yet"
    // — retry a few times before giving up. (Refreshes after save/delete hit on
    // the first attempt since the sidecar is up by then.)
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const t = await listTemplates();
        if (t.length > 0) {
          setTemplates(t);
          return;
        }
      } catch (e) {
        console.error("Failed to load templates (attempt", attempt, "):", e);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const saveCurrentTemplate = async () => {
    const name = templateSlug(newTemplateName) || editingTemplate;
    if (!name) {
      setTemplateMsg("Pick a template or enter a new name.");
      return;
    }
    try {
      await saveTemplate(name, templateBody);
      setTemplateMsg("Saved.");
      setNewTemplateName("");
      setEditingTemplate(name);
      await loadTemplates();
    } catch (err) {
      setTemplateMsg(String(err));
    }
  };

  const deleteCurrentTemplate = async () => {
    if (!editingTemplate) return;
    try {
      await deleteTemplate(editingTemplate);
      setTemplateMsg("Deleted.");
      setEditingTemplate("");
      setTemplateBody("");
      await loadTemplates();
    } catch (err) {
      setTemplateMsg(String(err));
    }
  };

  // Draft a template from a description, using the LLM already configured.
  const [templateWish, setTemplateWish] = useState("");
  const [generating, setGenerating] = useState(false);
  // Feedback has to sit BESIDE the button. `templateMsg` renders below a 300px
  // textarea, so the first draft looked like nothing happened: the result landed
  // off-screen and the status was further down still.
  const [wishMsg, setWishMsg] = useState("");
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const generateFromWish = async () => {
    if (!templateWish.trim() || generating) return;
    setGenerating(true);
    setTemplateMsg("");
    setWishMsg("");
    try {
      const draft = await generateTemplate(templateWish);
      // Into the editor, never straight to disk: a template is a system prompt,
      // so the user reads the draft and names it before anything is saved.
      setTemplateBody(draft);
      setEditingTemplate("");
      setNewTemplateName("");
      setTemplateMsg("Draft ready — read it, then name it and press Save.");
      setWishMsg("Draft ready below.");
      // Scroll the editor into view. Without this the draft appears in a textarea
      // the user cannot see, which reads as "the button did nothing".
      requestAnimationFrame(() => {
        editorRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
        editorRef.current?.focus();
      });
    } catch (e) {
      setTemplateMsg(String(e));
      setWishMsg(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const handleTestLlm = async () => {
    setLlmTest({ status: "testing", msg: "" });
    try {
      const msg = await testLlmConnection(config.llm_base_url, config.llm_api_key);
      setLlmTest({ status: "ok", msg });
    } catch (e) {
      setLlmTest({ status: "error", msg: String(e) });
    }
  };

  const downloadLocalModel = async (profileId: string) => {
    setModelMsg("");
    // Consent gate (SPEC v2/§D): a pinned tier on a platform without the
    // managed engine shows the install plan BEFORE anything downloads.
    if (
      setup &&
      setup.platform !== "macos" &&
      !setup.managed_engine_installed &&
      !profileId.startsWith("ollama:")
    ) {
      setEngineConsentFor(profileId);
      return;
    }
    await beginDownload(profileId, setModelMsg);
  };

  const isCloud = config.llm_provider !== "local";
  const deviceLabel = setup?.platform === "macos" ? "Mac" : "PC";
  const profiles = setup?.profiles ?? [];
  const inUse = profiles.find((p) => p.model_alias === config.ollama_model);
  const recommended = profiles.find((p) => p.recommended);
  const chosen = profiles.find((p) => p.id === chosenId) ?? inUse ?? recommended ?? profiles[0];
  const profileDownload = chosen ? downloads[chosen.id] ?? null : null;
  const chosenDownloading = Boolean(profileDownload && isInFlight(profileDownload));

  return (
    <div className={`settings-section-card${active ? " active-card" : ""}`}>
      <h3 className="settings-card-title">Notes</h3>
      <p className="settings-card-desc">
        Where a transcript becomes written notes. Only the transcript is used here —
        your recording is never sent anywhere.
      </p>
      <p className="settings-card-desc">
        The model that turns transcripts into notes. <strong>Local</strong> runs on
        this computer and is started and stopped by Adversaria — nothing leaves the
        machine. An online service is faster on older hardware, but sends your
        transcript away for summarizing.
      </p>

      {/* Provider — first-class, first control. */}
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="settings-provider">Engine</label>
        <select
          id="settings-provider"
          value={config.llm_provider}
          onChange={(e) => {
            const provider = e.target.value;
            const patch: Partial<AppConfig> = { llm_provider: provider };
            if (provider === "local") {
              patch.llm_base_url = "";
            } else if (provider === "groq") {
              patch.llm_base_url = "https://api.groq.com/openai/v1";
            } else if (provider === "grok") {
              patch.llm_base_url = "https://api.x.ai/v1";
            } else if (provider === "openrouter") {
              patch.llm_base_url = "https://openrouter.ai/api/v1";
            } else if (provider === "deepseek") {
              patch.llm_base_url = "https://api.deepseek.com";
            }
            // Also switch the model to one that matches the new provider, so a
            // model name from the previous provider isn't sent to the new one
            // (e.g. a Groq model name → local server → 404). "custom" keeps
            // whatever base URL + model the user typed.
            if (provider !== "custom") {
              patch.ollama_model = DEFAULT_MODEL[provider];
            }
            update(patch);
          }}
          className="settings-select"
        >
          <option value="local">Local — on this computer</option>
          <option value="groq">Groq — free, easiest to set up</option>
          <option value="custom">Bring your own (OpenAI-compatible)</option>
          <option value="deepseek">DeepSeek</option>
          <option value="openrouter">OpenRouter</option>
          <option value="grok">xAI Grok</option>
        </select>
      </div>

      {/* Local: dropdown of what's on this machine; the recommended model is
          labeled when missing and downloads only from the button below. */}
      {config.llm_provider === "local" && profiles.length > 0 && chosen && (
        <div className="settings-form-group">
          <label className="settings-label" htmlFor="settings-local-model">Meeting model</label>
          <select
            id="settings-local-model"
            className="settings-select"
            value={chosen.id}
            onChange={(e) => {
              setChosenId(e.target.value);
              setEngineConsentFor(null);
              setModelMsg("");
            }}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.display_name}
                {profile.installed
                  ? " — on this computer"
                  : profile.recommended
                    ? ` — Recommended for your ${deviceLabel} (not downloaded)`
                    : " — not downloaded"}
              </option>
            ))}
          </select>
          <p className="settings-help">
            {chosen.quality_note} Needs {chosen.minimum_memory_gb} GB RAM
            {chosen.installed ? "." : ` · ${chosen.required_disk_gb} GB download.`}
          </p>

          <div className="settings-model-action-row">
            {inUse?.id === chosen.id ? (
              <span className="settings-model-inuse">In use</span>
            ) : chosenDownloading ? (
              <span className="settings-model-dl">
                {profileDownload && profileDownload.total_bytes > 0
                  ? `${formatGb(profileDownload.downloaded_bytes)} of ${formatGb(profileDownload.total_bytes)}`
                  : "Preparing…"}
              </span>
            ) : chosen.installed ? (
              <button
                type="button"
                className="btn-primary"
                disabled={modelSwitching}
                onClick={() => switchLocalModel(chosen.id)}
              >
                {modelSwitching ? "Switching…" : "Use this model"}
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary"
                disabled={modelSwitching}
                onClick={() => downloadLocalModel(chosen.id)}
              >
                {profileDownload?.state === "error"
                  ? "Retry download"
                  : `Download (${chosen.required_disk_gb} GB)`}
              </button>
            )}
          </div>
          {chosenDownloading && profileDownload && profileDownload.total_bytes > 0 && (
            <progress
              value={profileDownload.downloaded_bytes}
              max={profileDownload.total_bytes}
            />
          )}
          {modelMsg && <p className="settings-msg">{modelMsg}</p>}
        </div>
      )}

      {/* Consent card appears ONLY after a Download click needs the engine. */}
      {config.llm_provider === "local" && engineConsentFor && (
        <EngineInstallCard
          onInstalled={() => {
            const profileId = engineConsentFor;
            setEngineConsentFor(null);
            void refreshSetup();
            // The consent card named this model too — continue into its download.
            if (profileId) void beginDownload(profileId, setModelMsg);
          }}
          onDismiss={() => setEngineConsentFor(null)}
        />
      )}

      {/* Local with nothing detected at all (no pinned tiers, no Ollama). */}
      {config.llm_provider === "local" && profiles.length === 0 && setup && (
        <div className="settings-form-group">
          <div className="settings-note info">
            <strong>No notes model on this computer yet.</strong> Your meetings
            still record and transcribe — only the written summary is waiting.
            The quickest route is the free online option in the Engine list
            above (an API key, no download); if you'd rather keep everything on
            this {deviceLabel}, this list fills in once a model is installed.
          </div>
        </div>
      )}

      {/* Cloud warning — stays in plain sight, never behind a disclosure. */}
      {isCloud && (
        <div className="settings-form-group">
          <div className="settings-note warn">
            <TriangleAlert size={14} aria-hidden="true" /> Online engine: your meeting transcript is sent to{" "}
            {PROVIDER_LABEL[config.llm_provider] ?? "an external service"} for
            summarization. Choose <strong>Local</strong> to keep everything on this device.
          </div>
        </div>
      )}

      {/* API provider setup — first-class, inline (SPEC v2), not "Advanced". */}
      {isCloud && (
        <>
          {config.llm_provider === "groq" && (
            <div className="settings-form-group">
              <div className="settings-note info">
                Get a free API key at{" "}
                <button className="btn-link" onClick={() => open("https://console.groq.com/keys")}>
                  console.groq.com/keys
                </button>{" "}
                — no credit card needed. Paste it in the API Key field below.
              </div>
            </div>
          )}

          {config.llm_provider === "custom" && (
            <div className="settings-form-group">
              <label className="settings-label" htmlFor="settings-base-url">Base URL</label>
              <input
                id="settings-base-url"
                type="text"
                value={config.llm_base_url}
                onChange={(e) => update({ llm_base_url: e.target.value })}
                className="settings-input-text"
                placeholder="https://api.example.com/v1"
              />
            </div>
          )}

          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-model">Model</label>
            <input
              id="settings-model"
              type="text"
              value={config.ollama_model}
              onChange={(e) => update({ ollama_model: e.target.value })}
              className="settings-input-text"
              placeholder={MODEL_PLACEHOLDER[config.llm_provider] ?? "model-name"}
            />
          </div>

          <div className="settings-form-group">
            <label className="settings-label" htmlFor="settings-api-key">API Key</label>
            <div className="settings-row">
              <input
                id="settings-api-key"
                type="password"
                value={config.llm_api_key}
                onChange={(e) => update({ llm_api_key: e.target.value })}
                className="settings-input-text"
                placeholder={config.llm_provider === "groq" ? "gsk_..." : "sk-..."}
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={handleTestLlm}
                disabled={llmTest.status === "testing" || !config.llm_base_url}
              >
                {llmTest.status === "testing" ? "Testing…" : "Test"}
              </button>
            </div>
            {llmTest.status === "ok" && <p className="settings-msg ok">{llmTest.msg}</p>}
            {llmTest.status === "error" && <p className="settings-msg err">{llmTest.msg}</p>}
          </div>
        </>
      )}

      {/* Model free-text for a local setup with no detected profiles (e.g. the
          user's own OpenAI-compatible server on this machine). Was buried in an
          "Advanced" disclosure; it belongs with the other notes-model controls. */}

        {/* Model free-text for a local setup with no detected profiles (e.g.
            the user's own OpenAI-compatible server on this machine). */}
        {config.llm_provider === "local" && profiles.length === 0 && (
          <div className="settings-form-group" style={{ marginTop: 12 }}>
            <label className="settings-label" htmlFor="settings-local-free-model">Model</label>
            <input
              id="settings-local-free-model"
              type="text"
              value={config.ollama_model}
              onChange={(e) => update({ ollama_model: e.target.value })}
              className="settings-input-text"
              placeholder={MODEL_PLACEHOLDER.local}
            />
          </div>
        )}
      <h3 className="settings-card-title" style={{ marginTop: 18 }}>Prompts &amp; Templates</h3>
      <p className="settings-card-desc">
        Templates are the system prompts that turn a transcript into structured
        notes. Pick a default, edit an existing one, or create your own.
      </p>

      {/* Default template */}
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="settings-default-template">
          Default template for new meetings
        </label>
        <select
          id="settings-default-template"
          value={config.default_prompt_template}
          onChange={(e) =>
            update({ default_prompt_template: e.target.value as PromptTemplate })
          }
          className="settings-select"
        >
          {templates.map((t) => (
            <option key={t.name} value={t.name}>{templateDisplayName(t.name)}</option>
          ))}
        </select>
      </div>

      {/* Editor */}
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="settings-template-wish">
          Describe the notes you want
        </label>
        <div className="settings-row">
          <input
            id="settings-template-wish"
            type="text"
            className="settings-input-text"
            value={templateWish}
            placeholder="e.g. a weekly 1:1 with my manager — wins, blockers, what I need from them"
            onChange={(e) => setTemplateWish(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void generateFromWish();
            }}
            disabled={generating}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => void generateFromWish()}
            disabled={generating || !templateWish.trim()}
          >
            {generating ? "Writing…" : "Draft it"}
          </button>
        </div>
        {(generating || wishMsg) && (
          <p className={`settings-msg${!generating && wishMsg.startsWith("Draft ready") ? " ok" : generating ? "" : " err"}`} role="status">
            {generating ? "Writing your template — this can take up to a minute…" : wishMsg}
          </p>
        )}
        <p className="settings-help">
          Your own AI writes the template and puts the draft below — nothing is saved
          until you name it and press Save. It follows an existing template's shape,
          so your notes keep filling the to-do list.
        </p>

        <label className="settings-label" htmlFor="settings-edit-template" style={{ marginTop: 16 }}>Edit a template</label>
        <select
          id="settings-edit-template"
          value={editingTemplate}
          onChange={async (e) => {
            const name = e.target.value;
            setEditingTemplate(name);
            setTemplateMsg("");
            if (name) {
              try {
                setTemplateBody(await getTemplate(name));
              } catch (err) {
                setTemplateBody("");
                setTemplateMsg(String(err));
              }
            } else {
              setTemplateBody("");
            }
          }}
          className="settings-select"
        >
          <option value="">— select a template to edit —</option>
          {templates.map((t) => (
            <option key={t.name} value={t.name}>{templateDisplayName(t.name)}</option>
          ))}
        </select>
        <textarea
          ref={editorRef}
          value={templateBody}
          onChange={(e) => setTemplateBody(e.target.value)}
          placeholder="Select a template above, or type a new prompt and name it below."
          className="settings-textarea font-mono"
          style={{ marginTop: 10, minHeight: 300 }}
        />
      </div>

      {/* Save as */}
      <div className="settings-form-group">
        <label className="settings-label" htmlFor="settings-new-template">Save as</label>
        <div className="settings-row">
          <input
            id="settings-new-template"
            type="text"
            value={newTemplateName}
            onChange={(e) => setNewTemplateName(e.target.value)}
            placeholder="Name it however you like — or leave blank to overwrite"
            className="settings-input-text"
          />
          <button onClick={saveCurrentTemplate} className="btn-primary">Save</button>
          <button onClick={deleteCurrentTemplate} disabled={!editingTemplate} className="btn-danger">
            Delete
          </button>
        </div>
        {templateSlug(newTemplateName) &&
          templateSlug(newTemplateName) !== newTemplateName.trim() && (
            <p className="settings-help">
              Will be saved as <strong>{templateSlug(newTemplateName)}</strong>
            </p>
          )}
        {templateMsg && (
          <p
            className={`settings-msg${
              templateMsg === "Saved." || templateMsg === "Deleted."
                ? " ok"
                : templateMsg.startsWith("Pick") || templateMsg.startsWith("Draft ready")
                  ? " warn"
                  : " err"
            }`}
            role="status"
          >
            {templateMsg}
          </p>
        )}
        <p className="settings-help">
          Names use lowercase letters, digits, and hyphens. Each template is a system
          prompt that produces the structured-notes JSON; new templates appear in the
          dropdowns immediately.
        </p>
      </div>

      {/* ---- Calendar ---- */}
    </div>
  );
}
