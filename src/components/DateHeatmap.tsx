import { useMemo, useState } from "react";
import type { Meeting } from "../types";

interface DateHeatmapProps {
  meetings: Meeting[];
  /** Selected local day as yyyy-mm-dd, or null for no date filter. */
  selected: string | null;
  onSelect: (day: string | null) => void;
  /** Show the "Clear filter" affordance (default: a date is selected). */
  showClear?: boolean;
  /** Called by "Clear filter" (default: onSelect(null), i.e. date only). */
  onClear?: () => void;
}

/** Local calendar day (yyyy-mm-dd) for a Date — en-CA yields ISO-style output. */
function ymd(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

/** Heatmap intensity bucket (0–4) for a day's meeting count: 0 = none (lightest),
   4 = busiest (darkest). Absolute buckets so "2 meetings" always reads busier than
   "1", regardless of the month's max. */
function level(count: number): number {
  if (count <= 0) return 0;
  return Math.min(count, 4);
}

export function DateHeatmap({ meetings, selected, onSelect, showClear, onClear }: DateHeatmapProps) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  // Collapsible: the calendar is compact by default; click the month label to
  // expand/collapse the grid (the prototype is always-open; the user wants a toggle).
  const [expanded, setExpanded] = useState(false);

  // Meetings per local day.
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of meetings) {
      const day = new Date(m.recorded_at).toLocaleDateString("en-CA");
      map.set(day, (map.get(day) ?? 0) + 1);
    }
    return map;
  }, [meetings]);

  // Month grid (Sunday-first), with leading cells showing trailing prev-month days.
  const cells = useMemo(() => {
    const year = month.getFullYear();
    const mon = month.getMonth();
    const startOffset = new Date(year, mon, 1).getDay();
    const daysInMonth = new Date(year, mon + 1, 0).getDate();
    const prevMonthDays = new Date(year, mon, 0).getDate();
    const out: ({ date: Date } | { empty: number })[] = [];
    for (let o = startOffset - 1; o >= 0; o--) {
      out.push({ empty: prevMonthDays - o });
    }
    for (let d = 1; d <= daysInMonth; d++) out.push({ date: new Date(year, mon, d) });
    return out;
  }, [month]);

  const monthLabel = month.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
  const shiftMonth = (delta: number) => {
    const d = new Date(month);
    d.setMonth(d.getMonth() + delta);
    setMonth(d);
  };

  return (
    <div className="heatmap-section">
      <div className="heatmap-title">
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {expanded && (
            <button
              className="btn-month-nav"
              onClick={() => shiftMonth(-1)}
              title="Previous Month"
              aria-label="Previous Month"
            >
              ‹
            </button>
          )}
          <span
            role="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse calendar" : "Expand calendar"}
            style={{
              cursor: "pointer",
              userSelect: "none",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <span style={{ fontSize: "9px", opacity: 0.7 }}>
              {expanded ? "▾" : "▸"}
            </span>
            {monthLabel}
          </span>
          {expanded && (
            <button
              className="btn-month-nav"
              onClick={() => shiftMonth(1)}
              title="Next Month"
              aria-label="Next Month"
            >
              ›
            </button>
          )}
        </div>
        {(showClear ?? Boolean(selected)) && (
          <span
            className="heatmap-clear"
            onClick={() => (onClear ? onClear() : onSelect(null))}
            title={onClear ? "Clear all filters" : "Clear date filter"}
          >
            Clear filter
          </span>
        )}
      </div>
      {expanded && (
        <>
          <div className="heatmap-weekdays">
            <span>S</span>
            <span>M</span>
            <span>T</span>
            <span>W</span>
            <span>T</span>
            <span>F</span>
            <span>S</span>
          </div>
          <div className="heatmap-grid-monthly">
            {cells.map((cell, i) => {
              if ("empty" in cell) {
                return (
                  <div key={i} className="heatmap-day-monthly empty">
                    {cell.empty}
                  </div>
                );
              }
              const d = cell.date;
              const key = ymd(d);
              const count = counts.get(key) ?? 0;
              const hasMeetings = count > 0;
              const isSelected = selected === key;
              return (
                <div
                  key={i}
                  onClick={() => onSelect(isSelected ? null : key)}
                  title={`${count} meeting${count === 1 ? "" : "s"}`}
                  className={`heatmap-day-monthly ${
                    hasMeetings ? `has-meetings level-${level(count)}` : ""
                  } ${isSelected ? "active" : ""}`}
                >
                  {d.getDate()}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
