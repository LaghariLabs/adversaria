import { useEffect, useMemo, useState } from "react";
import type { WeeklyBriefing } from "../types";
import { dateLocale } from "../lib/dateFormat";
import { weeklyBriefing } from "../lib/tauri";
import { ThinkingIndicator } from "./ThinkingIndicator";

/** Minutes → "2h 10m" (or "45m" under an hour, "1h" on the hour). */
function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Monday 00:00 of the week `offset` weeks from the current week. */
function startOfWeek(offset: number): Date {
  const now = new Date();
  const diffToMonday = (now.getDay() + 6) % 7;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - diffToMonday + offset * 7);
  return monday;
}

interface WeeklyViewProps {
  meetings: any[];
  onOpenMeeting: (id: number) => void;
}

const THINKING_WORDS = [
  "Scanning your week",
  "Sifting through decisions",
  "Collecting open loops",
  "Writing your briefing",
  "Almost there",
];

export function WeeklyView({ onOpenMeeting }: WeeklyViewProps) {
  const [offset, setOffset] = useState(0);
  const [briefing, setBriefing] = useState<WeeklyBriefing | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setBriefing(null);
    weeklyBriefing(offset)
      .then(setBriefing)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [offset]);

  const start = useMemo(() => startOfWeek(offset), [offset]);
  const end = useMemo(() => {
    const e = new Date(start);
    e.setDate(start.getDate() + 7);
    return e;
  }, [start]);

  const fmtRange = () => {
    const last = new Date(end);
    last.setDate(end.getDate() - 1);
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${start.toLocaleDateString(dateLocale(), opts)} – ${last.toLocaleDateString(dateLocale(), opts)}`;
  };

  const label =
    offset === 0 ? "This week" : offset === -1 ? "Last week" : fmtRange();

  return (
    <div className="weekly-layout" data-tour="weekly-view">
      {/* Header: title + nav */}
      <div className="weekly-header weekly-header--row">
        <div>
          <h1 className="weekly-title">Weekly Briefing</h1>
          <div className="weekly-range">{fmtRange()}</div>
        </div>
        <div className="weekly-nav">
          {offset < 0 && (
            <button
              onClick={() => setOffset(0)}
              className="weekly-return-pill"
              title="Back to this week"
            >
              ↩ Back to this week
            </button>
          )}
          <button
            onClick={() => setOffset((o) => o - 1)}
            className="btn-month-nav"
            title="Older week"
            aria-label="Older week"
          >
            ‹
          </button>
          <span className="weekly-nav-label" aria-live="polite">
            {label}
            {offset <= -2 && (
              <span className="weekly-nav-ago"> · {-offset} wks ago</span>
            )}
          </span>
          <button
            onClick={() => setOffset((o) => Math.min(0, o + 1))}
            disabled={offset === 0}
            className="btn-month-nav"
            title="Newer week"
            aria-label="Newer week"
          >
            ›
          </button>
        </div>
      </div>

      {loading ? (
        <div className="brief-loading">
          <ThinkingIndicator words={THINKING_WORDS} />
        </div>
      ) : !briefing ? (
        <div className="empty-view">
          <div className="empty-title">Couldn't load this week</div>
          <p className="empty-desc">
            Check that the Python service is running and try again.
          </p>
        </div>
      ) : briefing.meeting_count === 0 ? (
        <div className="empty-view">
          <div className="empty-title">No meetings this week</div>
          <p className="empty-desc">
            Once you record meetings in this week, your briefing will appear here.
          </p>
        </div>
      ) : (
        <div className="brief-body">
          {/* Prose paragraph */}
          <div className="brief-prose">
            <span className="brief-prose-heading">{label} in review</span>
            {briefing.prose ? (
              <p className="brief-prose-text">{briefing.prose}</p>
            ) : (
              <p className="brief-prose-text brief-prose-fallback">
                A summary of {briefing.meeting_count} meeting
                {briefing.meeting_count !== 1 ? "s" : ""} this week —{" "}
                {formatMinutes(briefing.total_minutes)} recorded,{" "}
                {briefing.actions_done}/{briefing.actions_total} action items
                completed.
              </p>
            )}
          </div>

          {/* Stat tiles */}
          <div className="brief-stat-row">
            <div className="brief-stat">
              <span className="brief-stat-num">{briefing.meeting_count}</span>
              <span className="brief-stat-label">Meetings</span>
            </div>
            <div className="brief-stat">
              <span className="brief-stat-num">{formatMinutes(briefing.total_minutes)}</span>
              <span className="brief-stat-label">In rooms</span>
            </div>
            <div className="brief-stat">
              <span className="brief-stat-num">{briefing.actions_total}</span>
              <span className="brief-stat-label">Actions created</span>
            </div>
            <div className="brief-stat">
              <span className="brief-stat-num">{briefing.actions_done}</span>
              <span className="brief-stat-label">Actions closed</span>
            </div>
          </div>

          {/* Two-column: decisions + open loops */}
          <div className="brief-cols">
            {/* Decisions */}
            <section className="brief-col">
              <h2 className="brief-col-title">Decisions made</h2>
              {briefing.decisions.length === 0 ? (
                <p className="brief-col-empty">None this week</p>
              ) : (
                <ul className="brief-list">
                  {briefing.decisions.map((d, i) => {
                    // Decisions are "bullet text (Meeting Title)" from recap.
                    const m = d.match(/^(.*)\s+\(([^)]+)\)$/);
                    const text = m ? m[1] : d;
                    const mtg = m ? m[2] : null;
                    // Find the meeting to link.
                    const source = mtg
                      ? briefing.sources.find(
                          (s) => s.title === mtg,
                        )
                      : null;
                    return (
                      <li key={i} className="brief-item">
                        <span className="brief-item-text">{text}</span>
                        {source && (
                          <button
                            onClick={() => onOpenMeeting(source.id)}
                            className="brief-meeting-link"
                            title="Open meeting"
                          >
                            {source.title}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Open loops */}
            <section className="brief-col">
              <h2 className="brief-col-title">Carried forward</h2>
              {briefing.open_loops.length === 0 ? (
                <p className="brief-col-empty">Nothing open this week</p>
              ) : (
                <ul className="brief-list">
                  {briefing.open_loops.map((loop, i) => (
                    <li key={i} className="brief-item brief-item--loop">
                      <span className="brief-item-text">{loop.text}</span>
                      <div className="brief-loop-meta">
                        {loop.due && (
                          <span className="brief-loop-due">{loop.due}</span>
                        )}
                        <button
                          onClick={() => onOpenMeeting(loop.meeting_id)}
                          className="brief-meeting-link"
                          title="Open meeting"
                        >
                          {loop.meeting_title}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
