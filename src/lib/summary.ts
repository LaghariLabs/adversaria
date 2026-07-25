/**
 * Parse the LLM's markdown summary into structured sections for rich rendering.
 *
 * The summary is produced by the Python service in a stable shape: an optional
 * `**Attendees:** …` line (shown separately as chips, so skipped here), then a
 * series of `**Section Heading**` blocks each followed by `- bullet` lines.
 * Parsing is deliberately tolerant — anything unexpected degrades to a bullet
 * or preamble rather than being dropped.
 */

export interface SummarySection {
  heading: string;
  bullets: string[];
  /** Action-oriented section whose bullets render as checkboxes. */
  actionable: boolean;
}

export interface ParsedSummary {
  /** Stray text appearing before the first section heading. */
  preamble: string[];
  sections: SummarySection[];
}

// Action-oriented section headings. Tolerant of LLM heading drift ("To-Build",
// "Tasks", "To-Do List") and Arabic headings. Mirror of the Rust `re_actionable`
// in src-tauri/src/storage.rs — keep the two in sync.
const ACTIONABLE =
  /(action item|action point|next step|to[ -]?(?:do|build)|deliverable|task|عناصر العمل|الخطوات التالية|المهام)/i;

/**
 * True for "empty" placeholder bullets the LLM emits when a section has nothing,
 * e.g. "None mentioned", "None", or the Arabic "لا يوجد". Used to keep these out
 * of aggregated views. Mirrors the skip in the Rust action-item extractor.
 */
export function isPlaceholderBullet(text: string): boolean {
  const norm = text.replace(/[.．]+$/, "").trim().toLowerCase();
  return (
    norm === "" || norm === "none" || norm === "none mentioned" || norm === "لا يوجد"
  );
}

// Arabic + Supplement + Extended-A + Presentation-Forms-A/B ranges.
const RTL_SCRIPT =
  /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** True if the text contains right-to-left (Arabic) script. */
export function isRtl(text: string): boolean {
  return RTL_SCRIPT.test(text);
}

/**
 * Drop the generic dual-capture speaker labels ("Me"/"Them") from a name list.
 * They aren't real attendees (Me = local mic, Them = remote/system audio). Used
 * to clean the displayed attendee chips for meetings recorded before the backend
 * stopped emitting them.
 */
export function withoutSpeakerLabels(names: string[]): string[] {
  return names.filter((n) => !["me", "them"].includes(n.trim().toLowerCase()));
}

/**
 * Strip the "Me"/"Them" speaker labels from a meeting title for display, e.g.
 * "Meeting with Hamza and Them" → "Meeting with Hamza". Word-boundaried +
 * case-insensitive (won't touch "Theme"); falls back to the original if cleaning
 * would empty it. Mirrors the backend's `_clean_title` for older meetings.
 */
export function cleanMeetingTitle(title: string): string {
  if (!title) return title;
  const t = title
    .replace(/\s*\b(and|with|&|,)\s+(me|them)\b/gi, "")
    .replace(/\b(me|them)\b\s*(and|with|&|,)\s+/gi, "")
    .replace(/\b(me|them)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[,&]+$/, "")
    .trim()
    .replace(/\s+(and|with|&)$/i, "")
    .trim();
  return t || title;
}

/** A line that is entirely bold, e.g. `**Decisions Made**` or `**Decisions:**`. */
function headingText(line: string): string | null {
  const match = line.match(/^\*\*(.+?)\*\*:?$/);
  return match ? match[1].replace(/:$/, "").trim() : null;
}

/** The bullet body if `line` is a `-`/`*`/`•` bullet, else null. */
function bulletText(line: string): string | null {
  const match = line.match(/^[-*•]\s+(.*)$/);
  return match ? match[1].trim() : null;
}

export function parseSummary(markdown: string): ParsedSummary {
  const preamble: string[] = [];
  const sections: SummarySection[] = [];
  let current: SummarySection | null = null;

  for (const raw of (markdown ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const heading = headingText(line);
    if (heading) {
      // Attendees are rendered as editable chips elsewhere — skip the line.
      if (/^attendees/i.test(heading)) {
        current = null;
        continue;
      }
      current = { heading, bullets: [], actionable: ACTIONABLE.test(heading) };
      sections.push(current);
      continue;
    }

    // Inline "**Attendees:** a, b" (heading and content on one line) — skip.
    if (/^\*\*attendees\b/i.test(line)) {
      current = null;
      continue;
    }

    const bullet = bulletText(line);
    const text = bullet !== null ? bullet : line;
    if (current) current.bullets.push(text);
    else preamble.push(text);
  }

  return { preamble, sections };
}

/**
 * Split a bullet into an optional leading label and the rest, so the label can
 * be emphasized. Handles `**Label:** rest` and a short `Label: rest` prefix.
 */
export function splitLabel(text: string): { label: string | null; rest: string } {
  const bold = text.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
  if (bold) return { label: bold[1].replace(/:$/, "").trim(), rest: bold[2].trim() };

  const idx = text.indexOf(": ");
  if (idx > 0 && idx <= 48 && !/[.?!]/.test(text.slice(0, idx))) {
    return { label: text.slice(0, idx).trim(), rest: text.slice(idx + 2).trim() };
  }
  return { label: null, rest: text };
}

function stripBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Clean plain-text rendering of the summary for the clipboard: drops the `**`
 * bold markers and normalizes bullets to "• ", so it pastes tidily into
 * plain-text targets instead of showing raw markdown.
 */
export function summaryToPlainText(markdown: string): string {
  return (markdown ?? "")
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return "";
      const bullet = line.match(/^[-*•]\s+(.*)$/);
      return bullet ? `• ${stripBold(bullet[1])}` : stripBold(line);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Formatted HTML rendering of the summary for rich-text paste (Word, Gmail,
 * Notion): bold headings/labels and real bullet lists, RTL-wrapped for Arabic.
 */
export function summaryToHtml(markdown: string): string {
  const parts: string[] = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      parts.push("</ul>");
      listOpen = false;
    }
  };

  for (const raw of (markdown ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      if (!listOpen) {
        parts.push("<ul>");
        listOpen = true;
      }
      parts.push(`<li>${escapeHtml(stripBold(bullet[1]))}</li>`);
      continue;
    }

    closeList();
    const labeled = line.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
    if (labeled && labeled[2]) {
      parts.push(
        `<p><strong>${escapeHtml(labeled[1])}:</strong> ${escapeHtml(labeled[2])}</p>`,
      );
    } else if (labeled) {
      parts.push(`<p><strong>${escapeHtml(labeled[1])}</strong></p>`);
    } else {
      parts.push(`<p>${escapeHtml(stripBold(line))}</p>`);
    }
  }
  closeList();

  const dir = isRtl(markdown) ? ' dir="rtl"' : "";
  return `<div${dir}>${parts.join("")}</div>`;
}
