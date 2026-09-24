import { useEffect, useRef, useState } from "react";
import { Pencil, Undo2, X } from "lucide-react";
import type { CopilotMode, LiveItem, LiveState } from "../types";
import { copilotLiveConfigure, copilotLiveReview } from "../lib/tauri";

interface LiveReviewPanelsProps {
  sessionId: string | null;
  state: LiveState | null;
  copilotMode: CopilotMode;
  onStateChange: (s: LiveState) => void;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function panelSummaryNode(title: string, count: number): JSX.Element {
  const countText = count > 0 ? String(count) : "none yet";
  return (
    <span>
      {title} <span className="lc-panel-count lc-panel-count--idle">· {countText}</span>
    </span>
  );
}

function LiveItemRow({
  item,
  sessionId,
  onStateChange,
  onDeleted,
}: {
  item: LiveItem;
  sessionId: string;
  onStateChange: (s: LiveState) => void;
  onDeleted: (id: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(item.text);
  const [draftOwner, setDraftOwner] = useState(item.owner ?? "");
  const [draftDue, setDraftDue] = useState(item.due ?? "");
  const [busy, setBusy] = useState(false);
  const isAction = item.kind === "action";

  const doReview = (
    action: "edit" | "delete" | "restore",
    fields?: { text?: string; owner?: string | null; due?: string | null },
  ) => {
    setBusy(true);
    copilotLiveReview(sessionId, item.id, action, fields)
      .then((next) => {
        onStateChange(next);
        if (action === "delete") onDeleted(item.id);
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  if (editing) {
    const emptyText = draftText.trim() === "";
    return (
      <div className="live-item" data-status={item.status}>
        <div className="live-item-form">
          <input
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder="Text"
            aria-label="Edit text"
          />
          {isAction && (
            <>
              <input
                value={draftOwner}
                onChange={(e) => setDraftOwner(e.target.value)}
                placeholder="Owner"
                aria-label="Owner"
              />
              <input
                value={draftDue}
                onChange={(e) => setDraftDue(e.target.value)}
                placeholder="Due"
                aria-label="Due"
              />
            </>
          )}
          <div className="live-item-form-actions">
            <button
              disabled={emptyText || busy}
              onClick={() => {
                const fields: { text?: string; owner?: string | null; due?: string | null } = {
                  text: draftText,
                };
                if (isAction) {
                  fields.owner = draftOwner.trim() === "" ? null : draftOwner.trim();
                  fields.due = draftDue.trim() === "" ? null : draftDue.trim();
                }
                setBusy(true);
                copilotLiveReview(sessionId, item.id, "edit", fields)
                  .then((next) => {
                    onStateChange(next);
                    setEditing(false);
                  })
                  .catch(() => {})
                  .finally(() => setBusy(false));
              }}
            >
              Save
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraftText(item.text);
                setDraftOwner(item.owner ?? "");
                setDraftDue(item.due ?? "");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // meta line: Owner · Due · From mm:ss for actions, From mm:ss otherwise, plus edited
  const metaParts: string[] = [];
  if (isAction) {
    if (item.owner) metaParts.push(item.owner);
    if (item.due) metaParts.push(item.due);
  }
  metaParts.push(`From ${mmss(item.at_ms)}`);
  const isEdited = item.status === "accepted";
  const metaText = metaParts.join(" · ") + (isEdited ? " · edited" : "");
  const showMeta = metaText.length > 0;

  return (
    <div className="live-item" data-status={item.status}>
      <div className="live-item-main">
        <div className="live-item-text">{item.text}</div>
        {showMeta && <div className="live-item-meta">{metaText}</div>}
      </div>
      <div className="live-item-icons" data-testid="live-item-actions">
        <button
          className="live-icon-btn"
          aria-label="Edit"
          disabled={busy}
          onClick={() => {
            setDraftText(item.text);
            setDraftOwner(item.owner ?? "");
            setDraftDue(item.due ?? "");
            setEditing(true);
          }}
        >
          <Pencil size={14} />
        </button>
        <button
          className="live-icon-btn"
          aria-label="Delete"
          disabled={busy}
          onClick={() => doReview("delete")}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function WithdrawnRow({
  item,
  sessionId,
  onStateChange,
}: {
  item: LiveItem;
  sessionId: string;
  onStateChange: (s: LiveState) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const quote = item.withdrawal_quote ?? null;
  return (
    <div className="live-item live-item--withdrawn">
      <span className="live-withdrawn-text">Withdrawn</span>
      {quote ? (
        <>
          <span className="live-withdrawn-dot">·</span>
          <span className="live-withdrawn-quote" dir="auto">"{quote}"</span>
        </>
      ) : null}
      <span className="live-withdrawn-dot">·</span>
      <button
        className="live-undo-btn"
        aria-label="Undo"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          copilotLiveReview(sessionId, item.id, "restore", undefined)
            .then((next) => {
              onStateChange(next);
            })
            .catch(() => {})
            .finally(() => setBusy(false));
        }}
      >
        <Undo2 size={14} /> Undo
      </button>
    </div>
  );
}

function DeletedRow({
  itemId,
  sessionId,
  onStateChange,
  onUndoDone,
}: {
  itemId: string;
  sessionId: string;
  onStateChange: (s: LiveState) => void;
  onUndoDone: (id: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <div className="live-item live-item--deleted">
      <span className="live-deleted-text">Deleted</span>
      <span className="live-deleted-dot">·</span>
      <button
        className="live-undo-btn"
        aria-label="Undo"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          copilotLiveReview(sessionId, itemId, "restore", undefined)
            .then((next) => {
              onStateChange(next);
              onUndoDone(itemId);
            })
            .catch(() => {})
            .finally(() => setBusy(false));
        }}
      >
        <Undo2 size={14} /> Undo
      </button>
    </div>
  );
}

export function LiveReviewPanels(props: LiveReviewPanelsProps): JSX.Element | null {
  const { sessionId: rawSessionId, state, copilotMode, onStateChange } = props;

  if (rawSessionId == null || rawSessionId.trim() === "") return null;
  const sessionId = rawSessionId;

  if (copilotMode === "no_ai") {
    return (
      <p className="live-review-off">Live review needs an AI mode (extraction runs on your local model)</p>
    );
  }

  const enabled = state?.enabled ?? false;
  const status = state?.status ?? "off";
  const throughMs = state?.through_ms ?? 0;

  const handleToggle = (checked: boolean) => {
    copilotLiveConfigure(sessionId, checked).then(onStateChange).catch(() => {});
  };

  const allItems = state?.items ?? [];
  const decisions = allItems.filter((i) => i.kind === "decision" && i.status !== "retracted");
  const actions = allItems.filter((i) => i.kind === "action" && i.status !== "retracted");
  const questions = allItems.filter((i) => i.kind === "question" && i.status !== "retracted");
  const retractedDecisions = allItems.filter((i) => i.kind === "decision" && i.status === "retracted");
  const retractedActions = allItems.filter((i) => i.kind === "action" && i.status === "retracted");
  const retractedQuestions = allItems.filter((i) => i.kind === "question" && i.status === "retracted");

  const summaryBullets = state?.summary?.bullets ?? [];

  // track recently deleted ids for 6s undo window
  const [recentlyDeleted, setRecentlyDeleted] = useState<Set<string>>(() => new Set());
  const timersRef = useRef<Map<string, number>>(new Map());

  const markDeleted = (id: string) => {
    setRecentlyDeleted((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    const existing = timersRef.current.get(id);
    if (existing) window.clearTimeout(existing);
    const t = window.setTimeout(() => {
      setRecentlyDeleted((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      timersRef.current.delete(id);
    }, 6000);
    timersRef.current.set(id, t);
  };

  const clearDeleted = (id: string) => {
    setRecentlyDeleted((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    const t = timersRef.current.get(id);
    if (t) window.clearTimeout(t);
    timersRef.current.delete(id);
  };

  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  // when an item is restored (status back to proposed), remove from deleted set
  useEffect(() => {
    const visibleIds = new Set(allItems.filter((i) => i.status === "proposed" || i.status === "accepted").map((i) => i.id));
    setRecentlyDeleted((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (visibleIds.has(id)) {
          next.delete(id);
          const t = timersRef.current.get(id);
          if (t) window.clearTimeout(t);
          timersRef.current.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [allItems]);

  function panelBody(items: LiveItem[], retracted: LiveItem[], emptyText: string): JSX.Element {
    const visible = items.filter((i) => i.status === "proposed" || i.status === "accepted");
    const deletedOverlay = items.filter((i) => i.status === "dismissed" && recentlyDeleted.has(i.id));
    if (visible.length === 0 && deletedOverlay.length === 0 && retracted.length === 0) {
      return <p className="live-empty">{emptyText}</p>;
    }
    return (
      <>
        {visible.map((item) => (
          <LiveItemRow key={item.id} item={item} sessionId={sessionId} onStateChange={onStateChange} onDeleted={markDeleted} />
        ))}
        {deletedOverlay.map((item) => (
          <DeletedRow key={item.id} itemId={item.id} sessionId={sessionId} onStateChange={onStateChange} onUndoDone={clearDeleted} />
        ))}
        {retracted.map((item) => (
          <WithdrawnRow key={item.id} item={item} sessionId={sessionId} onStateChange={onStateChange} />
        ))}
      </>
    );
  }

  const headerThrough = status === "off" ? "Off" : throughMs > 0 ? `Through ${mmss(throughMs)}` : "";
  return (
    <div className="lc-review">
      <div className="live-review-head">
        <span className="live-review-title">LIVE REVIEW{headerThrough ? ` · ${headerThrough}` : ""}</span>
        <label className="live-review-switch">
          <input type="checkbox" checked={enabled} onChange={(e) => handleToggle(e.target.checked)} /> Live capture
        </label>
      </div>
      {status === "updating" && <span className="live-review-status">Updating from recent conversation…</span>}
      {status === "busy" && <span className="live-review-status">Waiting while Copilot answers</span>}
      {status === "error" && <span className="live-review-status">Update failed · <button onClick={() => copilotLiveConfigure(sessionId, true).then(onStateChange).catch(() => {})}>Retry</button></span>}
      {status === "off" && !headerThrough && <span className="live-review-status">Off</span>}
      <details className="live-panel" data-kind="decision" open>
        <summary>{panelSummaryNode("Decisions", decisions.filter((i) => i.status === "proposed" || i.status === "accepted").length)}</summary>
        <div className="live-panel-body">{panelBody(decisions, retractedDecisions, "No decisions detected yet.")}</div>
      </details>
      <details className="live-panel" data-kind="action">
        <summary>{panelSummaryNode("Action items", actions.filter((i) => i.status === "proposed" || i.status === "accepted").length)}</summary>
        <div className="live-panel-body">{panelBody(actions, retractedActions, "No action items detected yet.")}</div>
      </details>
      <details className="live-panel" data-kind="question">
        <summary>{panelSummaryNode("Open questions", questions.filter((i) => i.status === "proposed" || i.status === "accepted").length)}</summary>
        <div className="live-panel-body">{panelBody(questions, retractedQuestions, "No open questions detected yet.")}</div>
      </details>
      <details className="live-panel" data-kind="summary" open={summaryBullets.length > 0}>
        <summary>{summaryBullets.length > 0 ? `Running summary · Through ${mmss(throughMs)}` : "Running summary · none yet"}</summary>
        <div className="live-panel-body">
          {summaryBullets.length === 0 ? (
            <p className="live-empty">No summary yet.</p>
          ) : (
            <ul className="live-summary-bullets">
              {summaryBullets.map((b, idx) => (
                <li key={idx}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}
