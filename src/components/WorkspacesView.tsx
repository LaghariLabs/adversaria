import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  addWorkspaceFolderContext,
  createWorkspace,
  createWorkspaceTask,
  deleteWorkspace,
  deleteWorkspaceTask,
  getAgentsPaused,
  getWorkspace,
  listWorkspaces,
  pickWorkspaceFolder,
  removeWorkspaceContext,
  renameWorkspace,
  setAgentsPaused,
} from "../lib/tauri";
import type { WorkspaceDetail, WorkspaceSummary } from "../types";
import { WorkspaceCard } from "./workspaces/WorkspaceCard";
import { WorkspaceDetailView } from "./workspaces/WorkspaceDetailView";

interface WorkspacesViewProps {
  onOpenMeeting: (meetingId: number) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspacesView({ onOpenMeeting }: WorkspacesViewProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const openIdRef = useRef<number | null>(null);
  openIdRef.current = openId;

  const loadList = useCallback(async () => {
    try {
      setWorkspaces(await listWorkspaces());
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    try {
      setDetail(await getWorkspace(id));
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadList();
      try {
        const nextPaused = await getAgentsPaused();
        if (!cancelled) setPaused(nextPaused);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadList]);

  useEffect(() => {
    const unlisten = listen<{ workspace_id: number; task_id: number }>(
      "workspace-task-changed",
      () => {
        void loadList();
        if (openIdRef.current != null) void loadDetail(openIdRef.current);
      },
    );
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [loadDetail, loadList]);

  const togglePaused = async () => {
    if (paused == null) return;
    try {
      await setAgentsPaused(!paused);
      setPaused(await getAgentsPaused());
      setError(null);
    } catch (pauseError) {
      setError(errorMessage(pauseError));
    }
  };

  useEffect(() => {
    if (openId == null) {
      setDetail(null);
      return;
    }
    setDetail(null);
    void loadDetail(openId);
  }, [loadDetail, openId]);

  const refreshDetail = useCallback(async () => {
    if (openId == null) return;
    await loadList();
    await loadDetail(openId);
  }, [loadDetail, loadList, openId]);

  const submitWorkspace = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const workspace = await createWorkspace(name);
      await loadList();
      setNewName("");
      setCreating(false);
      setOpenId(workspace.id);
    } catch (createError) {
      setError(errorMessage(createError));
    }
  };

  const beginCreate = () => {
    setNewName("");
    setCreating(true);
    setError(null);
  };

  if (openId != null) {
    if (!detail) {
      return (
        <div className="ws-layout">
          <button
            className="btn-secondary ws-back"
            type="button"
            onClick={() => setOpenId(null)}
          >
            ← Workspaces
          </button>
          {error ? (
            <p className="ws-error ws-load-error">{error}</p>
          ) : (
            <div className="empty-state">Loading workspace…</div>
          )}
        </div>
      );
    }
    return (
      <div className="ws-layout">
        <WorkspaceDetailView
          detail={detail}
          error={error}
          onBack={() => setOpenId(null)}
          onOpenMeeting={onOpenMeeting}
          onAddTask={async (title) => {
            try {
              await createWorkspaceTask(openId, title, "", null);
              await refreshDetail();
              return true;
            } catch (taskError) {
              setError(errorMessage(taskError));
              return false;
            }
          }}
          onDeleteTask={async (taskId) => {
            try {
              await deleteWorkspaceTask(taskId);
              await refreshDetail();
            } catch (taskError) {
              setError(errorMessage(taskError));
            }
          }}
          onAddFolder={async () => {
            try {
              const path = await pickWorkspaceFolder();
              if (!path) return;
              await addWorkspaceFolderContext(openId, path);
              await refreshDetail();
            } catch (folderError) {
              setError(errorMessage(folderError));
            }
          }}
          onRemoveContext={async (itemId) => {
            try {
              await removeWorkspaceContext(itemId);
              await refreshDetail();
            } catch (contextError) {
              setError(errorMessage(contextError));
            }
          }}
          onRefresh={refreshDetail}
        />
      </div>
    );
  }

  return (
    <div className="ws-layout">
      <div className="ws-header">
        <h2>Workspaces</h2>
        <button className="btn-primary" type="button" onClick={beginCreate}>
          New workspace
        </button>
      </div>
      {paused !== null && (
        <div className="ws-pausebar">
          <span
            className={`badge-tag blue ws-pausebar-chip${
              paused ? " ws-pausebar-chip--paused" : ""
            }`}
          >
            {paused ? "Agents paused" : "✦ Autopilot on"}
          </span>
          <span className="ws-pausebar-text">
            {paused
              ? "Nothing starts until you resume. Running tasks finish."
              : "Queued tasks run as soon as an engine is free, one at a time per workspace."}
          </span>
          <button className="btn-secondary" type="button" onClick={() => void togglePaused()}>
            {paused ? "Resume agents" : "Pause all agents"}
          </button>
        </div>
      )}
      {creating && (
        <input
          className="ws-inline-input ws-new-input"
          value={newName}
          placeholder="Workspace name"
          aria-label="Workspace name"
          autoFocus
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submitWorkspace();
            } else if (event.key === "Escape") {
              setCreating(false);
              setNewName("");
            }
          }}
        />
      )}
      {error && <p className="ws-error">{error}</p>}
      {!loading && workspaces.length === 0 ? (
        <div className="empty-state ws-empty">
          <p>
            A workspace is where meeting work gets done. Create one, add context,
            and send it an action item.
          </p>
          <button className="btn-primary" type="button" onClick={beginCreate}>
            New workspace
          </button>
        </div>
      ) : (
        <div className="ws-card-grid">
          {workspaces.map((summary) => (
            <WorkspaceCard
              key={summary.workspace.id}
              summary={summary}
              menuOpen={menuOpenId === summary.workspace.id}
              onOpen={() => setOpenId(summary.workspace.id)}
              onMenuChange={(open) =>
                setMenuOpenId(open ? summary.workspace.id : null)
              }
              onRename={async (name) => {
                try {
                  await renameWorkspace(summary.workspace.id, name);
                  await loadList();
                  return true;
                } catch (renameError) {
                  setError(errorMessage(renameError));
                  return false;
                }
              }}
              onDelete={async () => {
                try {
                  await deleteWorkspace(summary.workspace.id);
                  await loadList();
                } catch (deleteError) {
                  setError(errorMessage(deleteError));
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
