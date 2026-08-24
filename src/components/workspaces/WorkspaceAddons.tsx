import { useEffect, useState } from "react";

import {
  attachWorkspaceAddon,
  createWorkspaceAddon,
  deleteWorkspaceAddon,
  detachWorkspaceAddon,
  listWorkspaceAddons,
} from "../../lib/tauri";
import type { WorkspaceAddon } from "../../types";

interface WorkspaceAddonsProps {
  workspaceId: number;
  attached: WorkspaceAddon[];
  onChanged: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspaceAddons({
  workspaceId,
  attached,
  onChanged,
}: WorkspaceAddonsProps) {
  const [catalog, setCatalog] = useState<WorkspaceAddon[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingAddonId, setPendingAddonId] = useState<number | null>(null);
  const [agentPending, setAgentPending] = useState(false);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [savingCustom, setSavingCustom] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listWorkspaceAddons()
      .then((addons) => {
        if (!cancelled) setCatalog(Array.isArray(addons) ? addons : []);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const agents = catalog.filter((addon) => addon.kind === "agent");
  const skills = catalog.filter((addon) => addon.kind === "skill");
  const attachedAgent = attached.find((addon) => addon.kind === "agent");
  const attachedIds = new Set(attached.map((addon) => addon.id));

  const chooseAgent = async (addon: WorkspaceAddon | null) => {
    if (agentPending) return;
    const shouldDetach = attachedAgent && (!addon || addon.id === attachedAgent.id);
    if (!shouldDetach && !addon) return;
    setAgentPending(true);
    setError(null);
    try {
      if (shouldDetach) {
        await detachWorkspaceAddon(workspaceId, attachedAgent.id);
      } else if (addon) {
        await attachWorkspaceAddon(workspaceId, addon.id);
      }
      await onChanged();
    } catch (changeError) {
      setError(errorMessage(changeError));
    } finally {
      setAgentPending(false);
    }
  };

  const toggleSkill = async (addon: WorkspaceAddon) => {
    if (pendingAddonId !== null || savingCustom) return;
    setPendingAddonId(addon.id);
    setError(null);
    try {
      if (attachedIds.has(addon.id)) {
        await detachWorkspaceAddon(workspaceId, addon.id);
      } else {
        await attachWorkspaceAddon(workspaceId, addon.id);
      }
      await onChanged();
    } catch (changeError) {
      setError(errorMessage(changeError));
    } finally {
      setPendingAddonId(null);
    }
  };

  const deleteCustomSkill = async (addon: WorkspaceAddon) => {
    if (!window.confirm(`Delete ${addon.name}?`)) return;
    setPendingAddonId(addon.id);
    setError(null);
    try {
      await deleteWorkspaceAddon(addon.id);
      setCatalog((current) => current.filter((item) => item.id !== addon.id));
      await onChanged();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setPendingAddonId(null);
    }
  };

  const saveCustomSkill = async () => {
    if (!customName.trim() || !customInstructions.trim() || savingCustom) return;
    setSavingCustom(true);
    setError(null);
    try {
      const created = await createWorkspaceAddon(
        "skill",
        customName,
        customDescription,
        customInstructions,
      );
      setCatalog((current) => [...current, created]);
      await attachWorkspaceAddon(workspaceId, created.id);
      await onChanged();
      setCustomName("");
      setCustomDescription("");
      setCustomInstructions("");
      setShowCustomForm(false);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSavingCustom(false);
    }
  };

  return (
    <>
      <h4 className="ws-section-title">Agent</h4>
      <div className="ws-addon-row" role="radiogroup" aria-label="Workspace agent">
        <button
          className="badge-tag ws-addon-chip"
          type="button"
          aria-pressed={!attachedAgent}
          disabled={agentPending}
          onClick={() => void chooseAgent(null)}
        >
          None
        </button>
        {agents.map((addon) => (
          <button
            className="badge-tag ws-addon-chip"
            type="button"
            key={addon.id}
            aria-pressed={attachedAgent?.id === addon.id}
            disabled={agentPending}
            title={addon.description}
            onClick={() => void chooseAgent(addon)}
          >
            {addon.name}
          </button>
        ))}
      </div>

      <h4 className="ws-section-title">Skills</h4>
      <div className="ws-addon-row">
        {skills.map((addon) => (
          <span
            className="badge-tag ws-addon-chip"
            role="button"
            tabIndex={0}
            key={addon.id}
            aria-label={addon.name}
            aria-pressed={attachedIds.has(addon.id)}
            aria-disabled={pendingAddonId !== null || savingCustom}
            title={addon.description}
            onClick={() => void toggleSkill(addon)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void toggleSkill(addon);
              }
            }}
          >
            {addon.name}
            {!addon.builtin && (
              <button
                className="ws-addon-delete"
                type="button"
                disabled={pendingAddonId !== null || savingCustom}
                aria-label={`Delete skill ${addon.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void deleteCustomSkill(addon);
                }}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>

      {showCustomForm ? (
        <form
          className="ws-addon-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCustomSkill();
          }}
        >
          <input
            className="ws-inline-input"
            aria-label="Skill name"
            value={customName}
            onChange={(event) => setCustomName(event.target.value)}
          />
          <input
            className="ws-inline-input"
            aria-label="Skill description"
            value={customDescription}
            onChange={(event) => setCustomDescription(event.target.value)}
          />
          <textarea
            className="ws-inline-input"
            aria-label="Skill instructions"
            rows={4}
            value={customInstructions}
            onChange={(event) => setCustomInstructions(event.target.value)}
          />
          <div className="ws-addon-row">
            <button
              className="btn-primary"
              type="submit"
              disabled={
                savingCustom || !customName.trim() || !customInstructions.trim()
              }
            >
              Save &amp; attach
            </button>
            <button
              className="btn-secondary"
              type="button"
              disabled={savingCustom}
              onClick={() => setShowCustomForm(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          className="btn-secondary ws-add-custom-skill"
          type="button"
          onClick={() => setShowCustomForm(true)}
        >
          Add custom skill…
        </button>
      )}
      {error && <p className="ws-error">{error}</p>}
    </>
  );
}
