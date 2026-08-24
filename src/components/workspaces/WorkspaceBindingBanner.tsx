import { useEffect, useState } from "react";

import {
  clearMeetingWorkspaceBinding,
  getMeetingWorkspaceBinding,
  listWorkspaces,
  setMeetingWorkspaceBinding,
  suggestWorkspaceForMeeting,
} from "../../lib/tauri";
import type {
  MeetingWorkspaceBinding,
  WorkspaceSuggestion,
  WorkspaceSummary,
} from "../../types";

interface WorkspaceBindingBannerProps {
  meetingId: number;
  onChanged?: () => void;
}

interface BindingData {
  binding: MeetingWorkspaceBinding | null;
  workspaces: WorkspaceSummary[];
  suggestion: WorkspaceSuggestion | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchBindingData(meetingId: number): Promise<BindingData> {
  const [binding, workspaces] = await Promise.all([
    getMeetingWorkspaceBinding(meetingId),
    listWorkspaces(),
  ]);
  const suggestion =
    binding == null && workspaces.length > 0
      ? await suggestWorkspaceForMeeting(meetingId)
      : null;
  return { binding, workspaces, suggestion };
}

export function WorkspaceBindingBanner({
  meetingId,
  onChanged,
}: WorkspaceBindingBannerProps) {
  const [binding, setBinding] = useState<MeetingWorkspaceBinding | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [suggestion, setSuggestion] = useState<WorkspaceSuggestion | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const applyData = (data: BindingData) => {
    setBinding(data.binding);
    setWorkspaces(data.workspaces);
    setSuggestion(data.suggestion);
    setChoosing(data.binding == null);
    setSelectedId(
      data.suggestion?.workspace_id ?? data.workspaces[0]?.workspace.id ?? null,
    );
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    void fetchBindingData(meetingId)
      .then((data) => {
        if (!cancelled) applyData(data);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const reload = async () => {
    applyData(await fetchBindingData(meetingId));
  };

  const showChooser = async () => {
    setChoosing(true);
    setResult(null);
    setError(null);
    try {
      const proposed = await suggestWorkspaceForMeeting(meetingId);
      setSuggestion(proposed);
      setSelectedId(
        proposed?.workspace_id ?? workspaces[0]?.workspace.id ?? null,
      );
    } catch (suggestionError) {
      setError(errorMessage(suggestionError));
    }
  };

  const confirm = async () => {
    if (selectedId == null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const selected = workspaces.find(
        (summary) => summary.workspace.id === selectedId,
      );
      const count = await setMeetingWorkspaceBinding(meetingId, selectedId);
      await reload();
      setResult(
        count > 0 && selected
          ? `${count} to-do${count === 1 ? "" : "s"} pushed to ${selected.workspace.name}`
          : null,
      );
      onChanged?.();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const markNotProject = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await setMeetingWorkspaceBinding(meetingId, null);
      await reload();
      setResult(null);
      onChanged?.();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const unbind = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      await clearMeetingWorkspaceBinding(meetingId);
      await reload();
      onChanged?.();
    } catch (unbindError) {
      setError(errorMessage(unbindError));
    } finally {
      setSaving(false);
    }
  };

  if (error && workspaces.length === 0) {
    return <p className="ws-error">{error}</p>;
  }
  if (loading || workspaces.length === 0) return null;

  if (binding && !choosing) {
    return (
      <div className="ws-binding-banner ws-binding-banner--set">
        <span aria-hidden="true">✦</span>
        <span>
          {binding.workspace_id == null ? (
            "Not a project: to-dos stay on the board"
          ) : (
            <>
              To-dos from this meeting go to <b>{binding.workspace_name}</b>
            </>
          )}
        </span>
        <button
          className="btn-secondary"
          type="button"
          disabled={saving}
          onClick={() => void showChooser()}
        >
          Change…
        </button>
        {binding.workspace_id != null && (
          <button
            className="btn-secondary"
            type="button"
            disabled={saving}
            onClick={() => void unbind()}
          >
            Unbind
          </button>
        )}
        {result && <span className="ws-binding-result">{result}</span>}
        {error && <p className="ws-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="ws-binding-banner">
      <span aria-hidden="true">✦</span>
      <span>This meeting belongs to</span>
      <select
        aria-label="Workspace for this meeting"
        value={selectedId ?? ""}
        disabled={saving}
        onChange={(event) => setSelectedId(Number(event.target.value))}
      >
        {workspaces.map((summary) => (
          <option value={summary.workspace.id} key={summary.workspace.id}>
            {summary.workspace.name}
          </option>
        ))}
      </select>
      {suggestion && (
        <span className="ws-binding-hint">
          suggested · {suggestion.related_meeting_count} related{" "}
          {suggestion.related_meeting_count === 1 ? "meeting" : "meetings"}
          {suggestion.shared_attendee_count > 0
            ? `, ${suggestion.shared_attendee_count} shared ${
                suggestion.shared_attendee_count === 1 ? "attendee" : "attendees"
              }`
            : ""}
        </span>
      )}
      <button
        className="btn-primary"
        type="button"
        disabled={selectedId == null || saving}
        onClick={() => void confirm()}
      >
        Confirm
      </button>
      <button
        className="btn-secondary"
        type="button"
        disabled={saving}
        onClick={() => void markNotProject()}
      >
        Not a project
      </button>
      {error && <p className="ws-error">{error}</p>}
    </div>
  );
}
