import { useEffect, useRef } from "react";

import type { WorkspaceRun } from "../../types";

interface WorkspaceRunPanelProps {
  engine: string;
  pending: boolean;
  run: WorkspaceRun | null;
  log: string;
  error: string;
  onStop: () => void;
}

function statusLabel(
  engine: string,
  pending: boolean,
  run: WorkspaceRun | null,
): string {
  if (pending) return `Running · ${engine}`;
  if (!run) return "Failed";
  return run.status.charAt(0).toUpperCase() + run.status.slice(1);
}

function statusColor(pending: boolean, run: WorkspaceRun | null): string {
  if (pending) return "blue";
  if (run?.status === "done") return "green";
  if (run?.status === "failed") return "red";
  return "orange";
}

export function WorkspaceRunPanel({
  engine,
  pending,
  run,
  log,
  error,
  onStop,
}: WorkspaceRunPanelProps) {
  const logRef = useRef<HTMLPreElement>(null);
  const stoppable = (pending || run?.status === "running") && engine !== "local";

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log]);

  return (
    <div className="ws-run-panel">
      <div className="ws-run-panel-heading">
        <span className={`badge-tag ${statusColor(pending, run)} ws-run-status`}>
          {statusLabel(engine, pending, run)}
        </span>
        {stoppable && (
          <button
            className="btn-secondary ws-run-stop"
            type="button"
            disabled={run == null}
            onClick={onStop}
          >
            Stop
          </button>
        )}
      </div>
      <pre className="ws-run-log" ref={logRef} aria-live="polite">
        {log}
      </pre>
      {(run?.error || error) && <p className="ws-error">{run?.error || error}</p>}
    </div>
  );
}
