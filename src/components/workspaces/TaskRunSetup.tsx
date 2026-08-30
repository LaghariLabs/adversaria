import { useEffect, useState } from "react";

import {
  getWorkspaceTaskStaffing,
  setWorkspaceTaskStaffing,
} from "../../lib/tauri";
import type { TaskStaffing, WorkspaceAddon } from "../../types";

interface TaskRunSetupProps {
  taskId: number;
  catalog: WorkspaceAddon[];
}

type SetupMode = "automatic" | "manual";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addonDescription(addon: WorkspaceAddon): string {
  return addon.description.trim() || "No description provided.";
}

export function TaskRunSetup({ taskId, catalog }: TaskRunSetupProps) {
  const [staffing, setStaffing] = useState<TaskStaffing | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [draftMode, setDraftMode] = useState<SetupMode>("automatic");
  const [draftAgentId, setDraftAgentId] = useState<number | null>(null);
  const [draftSkillIds, setDraftSkillIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStaffing(null);
    setExpanded(false);
    setError(null);
    void getWorkspaceTaskStaffing(taskId)
      .then((resolved) => {
        if (cancelled) return;
        setStaffing(resolved);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const agents = catalog.filter((addon) => addon.kind === "agent");
  const skills = catalog.filter((addon) => addon.kind === "skill");
  const selectedNames = staffing
    ? [
        ...(staffing.agent_id === null
          ? []
          : [
              catalog.find((addon) => addon.id === staffing.agent_id)?.name ??
                `Agent ${staffing.agent_id}`,
            ]),
        ...staffing.skill_ids.map(
          (skillId) =>
            catalog.find((addon) => addon.id === skillId)?.name ??
            `Skill ${skillId}`,
        ),
      ]
    : [];
  const summary = staffing
    ? `Run setup: ${staffing.mode === "manual" ? "Manual" : "Automatic"} · ${
        selectedNames.length > 0 ? selectedNames.join(" + ") : "No agent or skills"
      }`
    : "Run setup: not resolved yet";

  const openEditor = () => {
    setDraftMode(staffing?.mode === "manual" ? "manual" : "automatic");
    setDraftAgentId(staffing?.agent_id ?? null);
    setDraftSkillIds([...(staffing?.skill_ids ?? [])]);
    setExpanded(true);
  };

  const toggleSkill = (skillId: number, checked: boolean) => {
    setDraftSkillIds((current) =>
      checked
        ? current.includes(skillId)
          ? current
          : [...current, skillId]
        : current.filter((id) => id !== skillId),
    );
  };

  const saveSetup = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const resolved = await setWorkspaceTaskStaffing(
        taskId,
        draftMode,
        draftMode === "automatic" ? null : draftAgentId,
        draftMode === "automatic" ? [] : draftSkillIds,
      );
      setStaffing(resolved);
      setExpanded(false);
      setError(null);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ws-addon-form">
      <div className="ws-verdict-row">
        <span className="ws-item-label" title={summary}>
          {summary}
        </span>
        <button
          className="ws-artifact-open"
          type="button"
          disabled={saving}
          onClick={openEditor}
        >
          Change
        </button>
      </div>

      {staffing?.reason.trim() && (
        <p className="ws-card-updated">{staffing.reason}</p>
      )}

      {expanded && (
        <form
          className="ws-addon-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveSetup();
          }}
        >
          <div
            className="ws-addon-form"
            role="radiogroup"
            aria-label="Run setup mode"
          >
            <label>
              <input
                type="radio"
                name={`task-run-setup-mode-${taskId}`}
                checked={draftMode === "automatic"}
                onChange={() => setDraftMode("automatic")}
              />{" "}
              <strong>Automatic (recommended)</strong>{" "}
              <span className="m-dim">
                — Adversaria picks one agent and up to two skills from the task.
              </span>
            </label>
            <label>
              <input
                type="radio"
                name={`task-run-setup-mode-${taskId}`}
                checked={draftMode === "manual"}
                onChange={() => setDraftMode("manual")}
              />{" "}
              <strong>Choose manually</strong>
            </label>
          </div>

          {draftMode === "manual" && (
            <>
              <h4 className="ws-section-title">Agent</h4>
              <div
                className="ws-addon-form"
                role="radiogroup"
                aria-label="Agent"
              >
                <label>
                  <input
                    type="radio"
                    name={`task-run-setup-agent-${taskId}`}
                    checked={draftAgentId === null}
                    onChange={() => setDraftAgentId(null)}
                  />{" "}
                  <strong>No agent</strong>{" "}
                  <span className="m-dim">— Run with skills only.</span>
                </label>
                {agents.map((agent) => (
                  <label key={agent.id}>
                    <input
                      type="radio"
                      name={`task-run-setup-agent-${taskId}`}
                      checked={draftAgentId === agent.id}
                      onChange={() => setDraftAgentId(agent.id)}
                    />{" "}
                    <strong>{agent.name}</strong>{" "}
                    <span className="m-dim">
                      — {addonDescription(agent)}
                    </span>
                  </label>
                ))}
              </div>

              <h4 className="ws-section-title">Skills</h4>
              <div className="ws-addon-form" aria-label="Skills">
                {skills.length === 0 ? (
                  <p className="ws-card-updated">No skills available.</p>
                ) : (
                  skills.map((skill) => (
                    <label key={skill.id}>
                      <input
                        type="checkbox"
                        checked={draftSkillIds.includes(skill.id)}
                        onChange={(event) =>
                          toggleSkill(skill.id, event.target.checked)
                        }
                      />{" "}
                      <strong>{skill.name}</strong>{" "}
                      <span className="m-dim">
                        — {addonDescription(skill)}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </>
          )}

          <div className="ws-addon-row">
            <button className="btn-primary" type="submit" disabled={saving}>
              Save setup
            </button>
            <button
              className="btn-secondary"
              type="button"
              disabled={saving}
              onClick={() => setExpanded(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="ws-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
