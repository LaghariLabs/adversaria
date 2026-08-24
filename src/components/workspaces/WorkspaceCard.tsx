import { useEffect, useState } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import type { WorkspaceSummary } from "../../types";
import { engineLabel } from "./engineLabel";

interface WorkspaceCardProps {
  summary: WorkspaceSummary;
  menuOpen: boolean;
  onOpen: () => void;
  onMenuChange: (open: boolean) => void;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<void>;
}

function updatedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function WorkspaceCard({
  summary,
  menuOpen,
  onOpen,
  onMenuChange,
  onRename,
  onDelete,
}: WorkspaceCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(summary.workspace.name);
  const approved = summary.approved_task_count;
  const total = summary.total_task_count;
  const fraction = total === 0 ? 0 : approved / total;
  const circumference = 2 * Math.PI * 24;

  useEffect(() => setName(summary.workspace.name), [summary.workspace.name]);

  const submitRename = async () => {
    const nextName = name.trim();
    if (!nextName) return;
    if (await onRename(nextName)) setRenaming(false);
  };

  return (
    <div
      className={`ws-card${menuOpen ? " ws-card--menu-open" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!renaming && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <svg
        className="ws-ring"
        viewBox="0 0 58 58"
        role="img"
        aria-label={`${approved} of ${total} approved`}
      >
        <circle
          cx="29"
          cy="29"
          r="24"
          stroke="var(--border-color)"
          strokeWidth="5"
          fill="none"
        />
        <circle
          cx="29"
          cy="29"
          r="24"
          stroke="var(--accent-green)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${fraction * circumference} ${circumference}`}
          transform="rotate(-90 29 29)"
          fill="none"
        />
        <text x="29" y="33" textAnchor="middle">
          {approved}/{total}
        </text>
      </svg>
      <div className="ws-card-heading">
        {renaming ? (
          <input
            className="ws-inline-input"
            value={name}
            aria-label="Workspace name"
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                void submitRename();
              } else if (event.key === "Escape") {
                setName(summary.workspace.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h3>{summary.workspace.name}</h3>
        )}
        <span className="badge-tag blue">
          {engineLabel(summary.workspace.engine)}
        </span>
      </div>
      <p className="ws-card-counts">
        <span className="ws-count ws-count--running">
          <b>{summary.running_task_count}</b> running
        </span>
        <span
          className={`ws-count ws-count--review${
            summary.awaiting_review_count > 0 ? " ws-count--hot" : ""
          }`}
        >
          <b>{summary.awaiting_review_count}</b> awaiting review
        </span>
        <span className="ws-count ws-count--queued">
          <b>{summary.queued_task_count}</b> queued
          {summary.needs_you_count > 0 &&
            ` · ${summary.needs_you_count} need you`}
        </span>
      </p>
      <p className="ws-card-updated">
        Updated {updatedLabel(summary.workspace.updated_at)}
      </p>
      <button
        className="mrow-menu-btn"
        type="button"
        aria-label={`Actions for ${summary.workspace.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Actions"
        onClick={(event) => {
          event.stopPropagation();
          onMenuChange(!menuOpen);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {menuOpen && (
        <>
          <div
            className="ws-menu-overlay"
            onClick={(event) => {
              event.stopPropagation();
              onMenuChange(false);
            }}
          />
          <div
            className="tag-add-popup ws-card-menu"
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="settings-menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                onMenuChange(false);
                setRenaming(true);
              }}
            >
              <Pencil size={15} aria-hidden="true" />
              Rename
            </button>
            <button
              className="settings-menu-item"
              type="button"
              role="menuitem"
              style={{ color: "var(--accent-red)" }}
              onClick={() => {
                onMenuChange(false);
                if (
                  window.confirm(
                    "Delete this workspace? Its tasks and context links go with it. Meetings are not touched.",
                  )
                ) {
                  void onDelete();
                }
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
