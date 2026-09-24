import { useEffect, useState } from "react";
import { getFolderCopilotBrief, setActionItemDone } from "../lib/tauri";
import type { FolderCopilotBrief, BriefOpenItem } from "../types";

interface LastTimeBriefProps {
  folderId: number | null;
}

function relativeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

export function LastTimeBrief({ folderId }: LastTimeBriefProps) {
  const [brief, setBrief] = useState<FolderCopilotBrief | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<BriefOpenItem[]>([]);

  useEffect(() => {
    if (folderId === null) {
      setBrief(null);
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getFolderCopilotBrief(folderId)
      .then((b) => {
        if (cancelled) return;
        setBrief(b);
        setItems(b.open_items);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderId]);

  if (folderId === null) {
    return <p className="lasttime-empty">Pick a folder above to see what happened last time.</p>;
  }
  if (loading) {
    return <p className="lasttime-empty">Loading…</p>;
  }
  if (error) {
    // Strip "Error:" prefix if present for cleaner display
    const msg = error.replace(/^Error:\s*/, "");
    return <p className="lasttime-empty">Could not load last time: {msg}</p>;
  }
  if (!brief) {
    return null;
  }
  if (brief.meeting_count === 0) {
    return <p className="lasttime-empty">First meeting in this folder.</p>;
  }

  return (
    <div className="lasttime-brief">
      {brief.last_meeting && (
        <div className="lasttime-header">
          <div className="lasttime-header-title" dir="auto">
            Last time · {brief.last_meeting.title} · {relativeDate(brief.last_meeting.recorded_at)}
          </div>
          {brief.last_meeting.attendees.length > 0 && (
            <div className="lasttime-header-attendees">{brief.last_meeting.attendees.join(", ")}</div>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="lasttime-section">
          <div className="companion-section-label">Open since last time · {items.length}</div>
          <ul className="lasttime-open-list">
            {items.map((item) => (
              <li key={item.id} className="lasttime-open-row">
                <input
                  type="checkbox"
                  aria-label={`Mark done: ${item.text}`}
                  onChange={async (e) => {
                    // Only act on check; uncheck is no-op (optimistic single-direction)
                    if (!e.target.checked) return;
                    const prev = items;
                    setItems((cur) => cur.filter((x) => x.id !== item.id));
                    try {
                      await setActionItemDone(item.id, true);
                    } catch (err) {
                      console.warn("Failed to mark action done:", err);
                      setItems(prev);
                    }
                  }}
                />
                <div className="lasttime-open-text">
                  <span dir="auto">{item.text}</span>
                  <span className="lasttime-open-meta">
                    {item.assignee ? `${item.assignee} · ` : ""}
                    {item.due ? `due ${item.due} · ` : ""}
                    {item.meetings_ago === 0 ? "last meeting" : `open ${item.meetings_ago + 1} meetings`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {brief.decisions.length > 0 && (
        <div className="lasttime-section">
          <div className="companion-section-label">Decided last time</div>
          <ul className="lasttime-bullets">
            {brief.decisions.map((b, i) => (
              <li key={`${b.meeting_id}-${i}`} dir="auto">
                {b.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {brief.follow_ups.length > 0 && (
        <div className="lasttime-section">
          <div className="companion-section-label">Follow-ups from last time</div>
          <ul className="lasttime-bullets">
            {brief.follow_ups.map((b, i) => (
              <li key={`${b.meeting_id}-${i}`} dir="auto">
                {b.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
