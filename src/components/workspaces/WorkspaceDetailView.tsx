import { useEffect, useState } from "react";
import { CalendarDays, FileText, Folder, Trash2, X } from "lucide-react";

import {
  approveWorkspaceTask,
  detectWorkspaceEngines,
  getContextSources,
  getLatestWorkspaceRun,
  openWorkspaceArtifact,
  rejectWorkspaceTask,
  runWorkspaceTask,
  setWorkspaceTaskAgentEligible,
  setWorkspaceEngine,
  stopWorkspaceRun,
} from "../../lib/tauri";
import type {
  ContextSources,
  WorkspaceContextItem,
  WorkspaceDetail,
  WorkspaceEngine,
  WorkspaceRun,
} from "../../types";
import { ArtifactPreview } from "./ArtifactPreview";
import { engineLabel } from "./engineLabel";
import { WorkspaceAddons } from "./WorkspaceAddons";
import { WorkspaceRunPanel } from "./WorkspaceRunPanel";

interface WorkspaceDetailViewProps {
  detail: WorkspaceDetail;
  error: string | null;
  onBack: () => void;
  onOpenMeeting: (meetingId: number) => void;
  onAddTask: (title: string) => Promise<boolean>;
  onDeleteTask: (taskId: number) => Promise<void>;
  onAddFolder: () => Promise<void>;
  onRemoveContext: (itemId: number) => Promise<void>;
  onRefresh: () => Promise<void>;
}

interface ActiveRun {
  taskId: number;
  engine: string;
  pending: boolean;
  run: WorkspaceRun | null;
  log: string;
  error: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function engineCaption(engine: string): string {
  if (engine === "local") return "Drafts documents from meeting context.";
  return "Full agent: reads folders, writes files.";
}

function runDuration(run: WorkspaceRun): string | null {
  const started = new Date(run.started_at).getTime();
  const finished = new Date(run.finished_at).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return null;
  }
  const totalSeconds = Math.floor((finished - started) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}m ${seconds}s`;
}

function contextIcon(item: WorkspaceContextItem) {
  if (item.kind === "folder") return <Folder size={15} aria-hidden="true" />;
  if (item.kind === "meeting") {
    return <CalendarDays size={15} aria-hidden="true" />;
  }
  return <FileText size={15} aria-hidden="true" />;
}

export function WorkspaceDetailView({
  detail,
  error,
  onBack,
  onOpenMeeting,
  onAddTask,
  onDeleteTask,
  onAddFolder,
  onRemoveContext,
  onRefresh,
}: WorkspaceDetailViewProps) {
  const [taskTitle, setTaskTitle] = useState("");
  const [engines, setEngines] = useState<WorkspaceEngine[]>([]);
  const [engineBusy, setEngineBusy] = useState(false);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [polledRuns, setPolledRuns] = useState<Record<number, WorkspaceRun>>({});
  const [latestRuns, setLatestRuns] = useState<Record<number, WorkspaceRun>>({});
  const [expandedArtifacts, setExpandedArtifacts] = useState<Set<number>>(
    () => new Set(),
  );
  const [rejectingTaskId, setRejectingTaskId] = useState<number | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [verdictTaskId, setVerdictTaskId] = useState<number | null>(null);
  const [eligibilityTaskId, setEligibilityTaskId] = useState<number | null>(null);
  const [contextSources, setContextSources] = useState<ContextSources>({
    vault_path: "",
    projects_root: "",
  });

  const awaitingTasks = detail.tasks.filter(
    (task) => task.status === "awaiting_review",
  );
  const runningTasks = detail.tasks.filter((task) => task.status === "running");
  const queuedTasks = detail.tasks.filter(
    (task) => task.status === "queued" || task.status === "failed",
  );
  const doneTasks = detail.tasks.filter((task) => task.status === "done");
  const reviewRunIds = new Set(
    Object.values(latestRuns).map((run) => run.id),
  );
  const remainingArtifacts = detail.artifacts.filter(
    (artifact) => !reviewRunIds.has(artifact.run_id),
  );
  const pollingTaskKey = runningTasks
    .filter((task) => activeRun?.taskId !== task.id)
    .map((task) => task.id)
    .sort((a, b) => a - b)
    .join(",");

  useEffect(() => {
    let cancelled = false;
    void detectWorkspaceEngines()
      .then((detected) => {
        if (!cancelled) setEngines(Array.isArray(detected) ? detected : []);
      })
      .catch((detectError) => {
        if (!cancelled) setActionError(errorMessage(detectError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getContextSources()
      .then((sources) => {
        if (!cancelled && sources) setContextSources(sources);
      })
      .catch(() => {
        // The rows already render the setup path; a settings hint is more
        // useful here than turning a background config read into a pane error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLatestRuns({});
    setExpandedArtifacts(new Set());
    const taskIds = detail.tasks
      .filter((task) => task.status === "awaiting_review")
      .map((task) => task.id);
    if (taskIds.length === 0) return;

    void Promise.all(
      taskIds.map(async (taskId) => [taskId, await getLatestWorkspaceRun(taskId)] as const),
    )
      .then((entries) => {
        if (cancelled) return;
        const runs: Record<number, WorkspaceRun> = {};
        for (const [taskId, run] of entries) {
          if (run) runs[taskId] = run;
        }
        setLatestRuns(runs);
        setExpandedArtifacts(
          new Set(
            Object.values(runs)
              .map(
                (run) =>
                  detail.artifacts.find((artifact) => artifact.run_id === run.id)
                    ?.id,
              )
              .filter((artifactId): artifactId is number => artifactId !== undefined),
          ),
        );
      })
      .catch((runError: unknown) => {
        if (!cancelled) setActionError(errorMessage(runError));
      });

    return () => {
      cancelled = true;
    };
  }, [detail]);

  useEffect(() => {
    const taskIds = pollingTaskKey
      ? pollingTaskKey.split(",").map((id) => Number(id))
      : [];
    if (taskIds.length === 0) return;

    let cancelled = false;
    const intervals = new Map<number, number>();
    const poll = (taskId: number) => {
      void getLatestWorkspaceRun(taskId)
        .then((run) => {
          if (cancelled || !run) return;
          setPolledRuns((current) => ({ ...current, [taskId]: run }));
          if (run.status !== "running") {
            const interval = intervals.get(taskId);
            if (interval !== undefined) window.clearInterval(interval);
            intervals.delete(taskId);
            void onRefresh();
          }
        })
        .catch((runError: unknown) => {
          if (!cancelled) setActionError(errorMessage(runError));
        });
    };

    for (const taskId of taskIds) {
      const interval = window.setInterval(() => poll(taskId), 2000);
      intervals.set(taskId, interval);
      poll(taskId);
    }

    return () => {
      cancelled = true;
      intervals.forEach((interval) => window.clearInterval(interval));
    };
  }, [onRefresh, pollingTaskKey]);

  const selectedEngineId = engines.some(
    (engine) => engine.id === detail.workspace.engine,
  )
    ? detail.workspace.engine
    : "local";
  const selectedEngine = engines.find((engine) => engine.id === selectedEngineId);
  const selectedEngineAvailable = selectedEngine?.available === true;

  const submitTask = async () => {
    const title = taskTitle.trim();
    if (!title) return;
    if (await onAddTask(title)) setTaskTitle("");
  };

  const chooseEngine = async (engine: WorkspaceEngine) => {
    if (!engine.available || engine.id === selectedEngineId || engineBusy) return;
    setEngineBusy(true);
    setActionError(null);
    try {
      await setWorkspaceEngine(detail.workspace.id, engine.id);
      await onRefresh();
    } catch (selectionError) {
      setActionError(errorMessage(selectionError));
    } finally {
      setEngineBusy(false);
    }
  };

  const startRun = async (taskId: number) => {
    setActionError(null);
    setActiveRun({
      taskId,
      engine: selectedEngineId,
      pending: true,
      run: null,
      log: "",
      error: "",
    });
    let runSettled = false;
    let locatingRun = false;
    const locateRun = async () => {
      if (locatingRun || runSettled) return;
      locatingRun = true;
      try {
        for (let attempt = 0; attempt < 50 && !runSettled; attempt += 1) {
          try {
            const latest = await getLatestWorkspaceRun(taskId);
            if (
              latest?.status === "running" &&
              latest.engine === selectedEngineId
            ) {
              setActiveRun((current) =>
                current?.taskId === taskId ? { ...current, run: latest } : current,
              );
              return;
            }
          } catch {
            // The run command and lookup are separate IPC calls; retry a transient race.
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
        }
      } finally {
        locatingRun = false;
      }
    };

    const runPromise = runWorkspaceTask(taskId, selectedEngineId, (line) => {
      setActiveRun((current) =>
        current?.taskId === taskId
          ? { ...current, log: current.log + line }
          : current,
      );
      void locateRun();
    });
    void locateRun();
    try {
      const finished = await runPromise;
      runSettled = true;
      setActiveRun((current) =>
        current?.taskId === taskId
          ? { ...current, pending: false, run: finished, error: "" }
          : current,
      );
      await onRefresh();
    } catch (runError) {
      runSettled = true;
      const message = errorMessage(runError);
      setActiveRun((current) =>
        current?.taskId === taskId
          ? { ...current, pending: false, error: message }
          : current,
      );
      setActionError(message);
    }
  };

  const stopRun = async () => {
    if (!activeRun?.run) return;
    setActionError(null);
    try {
      await stopWorkspaceRun(activeRun.run.id);
      const stopped = await getLatestWorkspaceRun(activeRun.taskId);
      setActiveRun((current) =>
        current
          ? { ...current, pending: false, run: stopped ?? current.run, error: "" }
          : current,
      );
      await onRefresh();
    } catch (stopError) {
      setActionError(errorMessage(stopError));
    }
  };

  const stopPolledRun = async (run: WorkspaceRun) => {
    setActionError(null);
    try {
      await stopWorkspaceRun(run.id);
      await onRefresh();
    } catch (stopError) {
      setActionError(errorMessage(stopError));
    }
  };

  const approveTask = async (taskId: number) => {
    setActionError(null);
    setVerdictTaskId(taskId);
    try {
      await approveWorkspaceTask(taskId);
      await onRefresh();
    } catch (approveError) {
      setActionError(errorMessage(approveError));
    } finally {
      setVerdictTaskId(null);
    }
  };

  const rejectTask = async (taskId: number) => {
    const reason = rejectionReason.trim();
    if (!reason) return;
    setActionError(null);
    setVerdictTaskId(taskId);
    try {
      await rejectWorkspaceTask(taskId, reason);
      setRejectingTaskId(null);
      setRejectionReason("");
      await onRefresh();
    } catch (rejectError) {
      setActionError(errorMessage(rejectError));
    } finally {
      setVerdictTaskId(null);
    }
  };

  const setAgentEligibility = async (taskId: number, eligible: boolean) => {
    setActionError(null);
    setEligibilityTaskId(taskId);
    try {
      await setWorkspaceTaskAgentEligible(taskId, eligible);
      await onRefresh();
    } catch (eligibilityError) {
      setActionError(errorMessage(eligibilityError));
    } finally {
      setEligibilityTaskId(null);
    }
  };

  const openArtifact = async (path: string) => {
    setActionError(null);
    try {
      await openWorkspaceArtifact(path);
    } catch (openError) {
      setActionError(errorMessage(openError));
    }
  };

  const toggleArtifactPreview = (artifactId: number) => {
    setExpandedArtifacts((current) => {
      const next = new Set(current);
      if (next.has(artifactId)) next.delete(artifactId);
      else next.add(artifactId);
      return next;
    });
  };

  return (
    <div className="ws-detail">
      <button className="btn-secondary ws-back" type="button" onClick={onBack}>
        ← Workspaces
      </button>
      <div className="ws-detail-heading">
        <h2>{detail.workspace.name}</h2>
        {awaitingTasks.length > 0 && (
          <span className="badge-tag ws-review-badge">
            {awaitingTasks.length} awaiting review
          </span>
        )}
        <div className="ws-engine-picker">
          <div className="ws-engine-row" role="group" aria-label="Workspace engine">
            {engines.map((engine) =>
              engine.available ? (
                <button
                  className={`badge-tag blue ws-engine-chip${
                    engine.id === selectedEngineId ? " ws-engine-chip--selected" : ""
                  }`}
                  type="button"
                  aria-pressed={engine.id === selectedEngineId}
                  title={engine.version || undefined}
                  disabled={engineBusy}
                  key={engine.id}
                  onClick={() => void chooseEngine(engine)}
                >
                  {engine.label}
                </button>
              ) : (
                <span
                  className="badge-tag blue ws-engine-chip ws-engine-chip--dimmed"
                  title={engine.detail}
                  role="button"
                  aria-disabled="true"
                  aria-label={`${engine.label}. ${engine.detail}`}
                  tabIndex={0}
                  key={engine.id}
                >
                  {engine.label}
                </span>
              ),
            )}
          </div>
          <p className="ws-context-caption">{engineCaption(selectedEngineId)}</p>
        </div>
      </div>
      {(actionError || error) && <p className="ws-error">{actionError || error}</p>}
      <div className="ws-detail-grid">
        <section className="ws-pane" aria-labelledby="workspace-tasks-title">
          <h3 id="workspace-tasks-title">Tasks</h3>
          <div className="ws-list">
            {awaitingTasks.length > 0 && (
              <>
                <h4 className="ws-section-title">
                  Awaiting your review · {awaitingTasks.length}
                </h4>
                {awaitingTasks.map((task) => {
                  const latestRun = latestRuns[task.id];
                  const artifacts = latestRun
                    ? detail.artifacts.filter(
                        (artifact) => artifact.run_id === latestRun.id,
                      )
                    : [];
                  const duration = latestRun ? runDuration(latestRun) : null;
                  const receipt = latestRun?.log
                    .split(/\r?\n/)
                    .find((line) => line.startsWith("Context:"));
                  const showingRejectForm = rejectingTaskId === task.id;
                  const verdictPending = verdictTaskId === task.id;
                  return (
                    <div
                      className="ws-task-block ws-review-card"
                      key={task.id}
                    >
                      <div className="ws-list-item ws-task-item">
                        <div className="ws-list-main">
                          <span className="ws-item-label">
                            {task.title}
                            {task.attempt > 1 && (
                              <span className="ws-attempt">
                                attempt {task.attempt}
                              </span>
                            )}
                          </span>
                          {task.source_meeting_id != null && (
                            <button
                              className="triage-card-src ws-source-chip"
                              type="button"
                              onClick={() =>
                                onOpenMeeting(task.source_meeting_id!)
                              }
                            >
                              from: {task.source_meeting_title}
                            </button>
                          )}
                        </div>
                        {latestRun && (
                          <span className="badge-tag">
                            {engineLabel(latestRun.engine)}
                            {duration ? ` · ${duration}` : ""}
                          </span>
                        )}
                      </div>
                      {task.rejection_notes.length > 0 && (
                        <ul className="ws-rejections">
                          {task.rejection_notes.map((note, index) => (
                            <li key={`${task.id}-${index}`}>{note}</li>
                          ))}
                        </ul>
                      )}
                      {receipt && <p className="ws-receipt">{receipt}</p>}
                      {artifacts.length > 0 && (
                        <div className="ws-artifact-list">
                          {artifacts.map((artifact) => (
                            <div key={artifact.id}>
                              <div className="ws-artifact-row">
                                <FileText size={15} aria-hidden="true" />
                                <span className="ws-artifact-name">
                                  {artifact.name}
                                </span>
                                <time dateTime={artifact.created_at}>
                                  {new Date(
                                    artifact.created_at,
                                  ).toLocaleDateString()}
                                </time>
                                <button
                                  className="ws-artifact-open"
                                  type="button"
                                  onClick={() => toggleArtifactPreview(artifact.id)}
                                >
                                  {expandedArtifacts.has(artifact.id) ? "Hide" : "Preview"}
                                </button>
                              </div>
                              {expandedArtifacts.has(artifact.id) && (
                                <ArtifactPreview artifact={artifact} />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {latestRun && (
                        <details className="ws-runlog">
                          <summary>Run log</summary>
                          <pre>{latestRun.log}</pre>
                        </details>
                      )}
                      <div className="ws-verdict-row">
                        <button
                          className="btn-primary ws-approve"
                          type="button"
                          disabled={verdictPending}
                          onClick={() => void approveTask(task.id)}
                        >
                          Approve
                        </button>
                        <button
                          className="btn-secondary"
                          type="button"
                          disabled={verdictPending}
                          onClick={() => {
                            setRejectingTaskId(
                              showingRejectForm ? null : task.id,
                            );
                            setRejectionReason("");
                          }}
                        >
                          Reject…
                        </button>
                      </div>
                      {showingRejectForm && (
                        <form
                          className="ws-reject-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void rejectTask(task.id);
                          }}
                        >
                          <label
                            className="m-label"
                            htmlFor={`workspace-rejection-${task.id}`}
                          >
                            What should the next run do differently?
                          </label>
                          <input
                            className="ws-inline-input"
                            id={`workspace-rejection-${task.id}`}
                            aria-label="Rejection reason"
                            value={rejectionReason}
                            autoFocus
                            onChange={(event) =>
                              setRejectionReason(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setRejectingTaskId(null);
                                setRejectionReason("");
                              }
                            }}
                          />
                          <button
                            className="btn-primary"
                            type="submit"
                            disabled={!rejectionReason.trim() || verdictPending}
                          >
                            Re-run with this note
                          </button>
                          <button
                            className="btn-secondary"
                            type="button"
                            onClick={() => {
                              setRejectingTaskId(null);
                              setRejectionReason("");
                            }}
                          >
                            Cancel
                          </button>
                        </form>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {runningTasks.length > 0 && (
              <>
                <h4 className="ws-section-title">
                  Running · {runningTasks.length}
                </h4>
                {runningTasks.map((task) => {
                  const isActive = activeRun?.taskId === task.id;
                  const polledRun = polledRuns[task.id];
                  return (
                    <div className="ws-task-block" key={task.id}>
                      <div className="ws-list-item ws-task-item">
                        <div className="ws-list-main">
                          <span className="ws-item-label">{task.title}</span>
                          {task.source_meeting_id != null && (
                            <button
                              className="triage-card-src ws-source-chip"
                              type="button"
                              onClick={() =>
                                onOpenMeeting(task.source_meeting_id!)
                              }
                            >
                              from: {task.source_meeting_title}
                            </button>
                          )}
                        </div>
                        <div className="ws-task-actions">
                          {!isActive && (
                            <span className="badge-tag blue ws-run-status">
                              Running · {selectedEngineId}
                            </span>
                          )}
                          <button
                            className="ws-icon-button"
                            type="button"
                            disabled
                            aria-label={`Delete task ${task.title}`}
                          >
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      {isActive && activeRun && (
                        <WorkspaceRunPanel
                          engine={activeRun.engine}
                          pending={activeRun.pending}
                          run={activeRun.run}
                          log={activeRun.log}
                          error={activeRun.error}
                          onStop={() => void stopRun()}
                        />
                      )}
                      {!isActive && polledRun && (
                        <WorkspaceRunPanel
                          engine={polledRun.engine}
                          pending={false}
                          run={polledRun}
                          log={polledRun.log}
                          error={polledRun.error}
                          onStop={() => void stopPolledRun(polledRun)}
                        />
                      )}
                    </div>
                  );
                })}
              </>
            )}

            <h4 className="ws-section-title">Queued · {queuedTasks.length}</h4>
            {detail.tasks.length === 0 ? (
              <p className="ws-pane-empty">
                No tasks yet. Send one from the to-do board, or add one below.
              </p>
            ) : (
              queuedTasks.map((task) => {
                const isActive = activeRun?.taskId === task.id;
                const isPending = isActive && activeRun.pending;
                const canRun =
                  selectedEngineAvailable && !isPending;
                return (
                  <div className="ws-task-block" key={task.id}>
                    <div className="ws-list-item ws-task-item">
                      <div className="ws-list-main">
                        <span className="ws-item-label">
                          {task.title}
                          {!task.agent_eligible && (
                            <span className="badge-tag ws-needs-you">
                              needs you
                            </span>
                          )}
                          {task.attempt > 1 && (
                            <span className="ws-attempt">
                              attempt {task.attempt}
                            </span>
                          )}
                        </span>
                        {task.source_meeting_id != null && (
                          <button
                            className="triage-card-src ws-source-chip"
                            type="button"
                            onClick={() => onOpenMeeting(task.source_meeting_id!)}
                          >
                            from: {task.source_meeting_title}
                          </button>
                        )}
                      </div>
                      <div className="ws-task-actions">
                        <button
                          className="btn-secondary ws-eligibility-button"
                          type="button"
                          disabled={
                            isPending || eligibilityTaskId === task.id
                          }
                          onClick={() =>
                            void setAgentEligibility(
                              task.id,
                              !task.agent_eligible,
                            )
                          }
                        >
                          {task.agent_eligible
                            ? "Mark as needs me"
                            : "Let an agent try"}
                        </button>
                        {canRun && (
                          <button
                            className="btn-primary ws-run-button"
                            type="button"
                            onClick={() => void startRun(task.id)}
                          >
                            Run
                          </button>
                        )}
                        <button
                          className="ws-icon-button"
                          type="button"
                          disabled={isPending}
                          aria-label={`Delete task ${task.title}`}
                          onClick={() => void onDeleteTask(task.id)}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    {isActive && (
                      <WorkspaceRunPanel
                        engine={activeRun.engine}
                        pending={activeRun.pending}
                        run={activeRun.run}
                        log={activeRun.log}
                        error={activeRun.error}
                        onStop={() => void stopRun()}
                      />
                    )}
                  </div>
                );
              })
            )}

            {doneTasks.length > 0 && (
              <>
                <h4 className="ws-section-title">Done · {doneTasks.length}</h4>
                {doneTasks.map((task) => (
                  <div className="ws-task-block" key={task.id}>
                    <div className="ws-list-item ws-task-item ws-task-item--done">
                      <div className="ws-list-main">
                        <span className="ws-item-label">{task.title}</span>
                        {task.source_meeting_id != null && (
                          <button
                            className="triage-card-src ws-source-chip"
                            type="button"
                            onClick={() =>
                              onOpenMeeting(task.source_meeting_id!)
                            }
                          >
                            from: {task.source_meeting_title}
                          </button>
                        )}
                      </div>
                      <button
                        className="ws-icon-button"
                        type="button"
                        aria-label={`Delete task ${task.title}`}
                        onClick={() => void onDeleteTask(task.id)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
          <input
            className="ws-inline-input ws-add-input"
            value={taskTitle}
            placeholder="Add a task…"
            aria-label="Add a task"
            onChange={(event) => setTaskTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitTask();
              }
            }}
          />
          {remainingArtifacts.length > 0 && (
            <div className="ws-artifacts">
              <h4>Artifacts</h4>
              <div className="ws-artifact-list">
                {remainingArtifacts.map((artifact) => (
                  <div key={artifact.id}>
                    <div className="ws-artifact-row">
                      <FileText size={15} aria-hidden="true" />
                      <span className="ws-artifact-name">{artifact.name}</span>
                      <time dateTime={artifact.created_at}>
                        {new Date(artifact.created_at).toLocaleDateString()}
                      </time>
                      <div className="ws-task-actions">
                        <button
                          className="ws-artifact-open"
                          type="button"
                          onClick={() => void openArtifact(artifact.path)}
                        >
                          Open
                        </button>
                        <button
                          className="ws-artifact-open"
                          type="button"
                          onClick={() => toggleArtifactPreview(artifact.id)}
                        >
                          {expandedArtifacts.has(artifact.id) ? "Hide" : "Preview"}
                        </button>
                      </div>
                    </div>
                    {expandedArtifacts.has(artifact.id) && (
                      <ArtifactPreview artifact={artifact} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="ws-pane" aria-labelledby="workspace-context-title">
          <h3 id="workspace-context-title">Context</h3>
          <div className="ws-list">
            <div className="ws-list-item ws-list-item--auto">
              <span className="ws-context-icon" aria-hidden="true">
                ◉
              </span>
              <span className="ws-item-label">
                Related meetings via graph
                <span className="m-dim"> · top 3, automatic</span>
              </span>
            </div>
            <div className="ws-list-item ws-list-item--auto">
              <span className="ws-context-icon" aria-hidden="true">
                ◆
              </span>
              <span className="ws-item-label ws-auto-context-label">
                <span>
                  Vault notes via search
                  <span className="m-dim"> · top 5, automatic</span>
                </span>
                <span className="m-dim ws-auto-context-path">
                  {contextSources.vault_path || "Set up in Settings → Integrations"}
                </span>
              </span>
            </div>
            <div className="ws-list-item ws-list-item--auto">
              <span className="ws-context-icon" aria-hidden="true">
                ◫
              </span>
              <span className="ws-item-label ws-auto-context-label">
                <span>
                  Projects via search
                  <span className="m-dim"> · top 2, automatic</span>
                </span>
                <span className="m-dim ws-auto-context-path">
                  {contextSources.projects_root || "Set up in Settings → Integrations"}
                </span>
              </span>
            </div>
            {detail.context_items.map((item) => (
              <div className="ws-list-item" key={item.id}>
                <span className="ws-context-icon">{contextIcon(item)}</span>
                {item.kind === "meeting" ? (
                  <button
                    className="ws-context-link"
                    type="button"
                    onClick={() => onOpenMeeting(Number(item.value))}
                  >
                    {item.label}
                  </button>
                ) : (
                  <span className="ws-item-label">{item.label}</span>
                )}
                <button
                  className="ws-icon-button"
                  type="button"
                  aria-label={`Remove ${item.label} from context`}
                  onClick={() => void onRemoveContext(item.id)}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          <button
            className="btn-secondary ws-add-folder"
            type="button"
            onClick={() => void onAddFolder()}
          >
            <Folder size={15} aria-hidden="true" />
            Add folder…
          </button>
          <WorkspaceAddons
            workspaceId={detail.workspace.id}
            attached={detail.addons}
            onChanged={onRefresh}
          />
          <p className="ws-context-caption">
            What you add here is what the agent will be allowed to read and how it
            will work. Related meetings are pulled from your graph automatically.
          </p>
        </section>
      </div>
    </div>
  );
}
