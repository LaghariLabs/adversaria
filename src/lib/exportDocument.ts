/**
 * Branded single-page "Meeting Minutes" slide export for a single meeting.
 *
 * `buildSlideHtml()` returns a self-contained `.html` document (inline styles +
 * one tiny inline fit script, no external assets — privacy-clean) styled as a
 * 16:9 presentation slide:
 *   - a fixed 1280×720 "stage" that scales to fit the viewport (never scrolls)
 *     and maps 1:1 to a single print page (`@page { size: 1280px 720px }`), so
 *     Save-as-PDF from a browser yields exactly ONE page;
 *   - an ADVERSARIA reveal intro (screen only; hidden in print);
 *   - the meeting in multi-column cards (Key Topics / Decisions / Action Items /
 *     Follow-ups), with the body auto-shrinking to fit one frame.
 *
 * Sections come from `parseSummary`, so the layout adapts to any template and to
 * Arabic summaries (RTL handled per-block with `unicode-bidi: plaintext`).
 *
 * (In-app PDF was dropped: Tauri's macOS WKWebview no-ops `window.print()`. The
 * PDF path is Save-as-PDF from a browser, which this slide is built to honour.)
 */

import type { Meeting } from "../types";
import { INSTRUMENT_SERIF_ITALIC_TTF_B64 } from "./instrumentSerifFont";
import { formatDateTime } from "./dateFormat";
import {
  cleanMeetingTitle,
  isPlaceholderBullet,
  parseSummary,
  splitLabel,
} from "./summary";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape + drop markdown bold markers for inline text. */
function clean(s: string): string {
  return escapeHtml(s.replace(/\*\*(.+?)\*\*/g, "$1"));
}

/** A filesystem-safe base name derived from the meeting title. */
export function exportFileBase(meeting: Meeting): string {
  return (
    cleanMeetingTitle(meeting.title)
      .replace(/[^\w\d\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "meeting-notes"
  );
}

const FOLLOWUP = /follow|متابع/i;
const DECISION = /decision|decided|قرار/i;
const RISK = /risk|concern|blocker|issue|مخاطر|مشكل/i;
const TOPIC = /topic|discuss|overview|key|agenda|summary|موضوع|ملخص/i;

export interface ExportTheme {
  id: string;
  label: string;
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accentBlue: string;
  accentPurple: string;
  accentGreen: string;
  accentAmber: string;
  accentRed: string;
  fontSans: string;
  fontSerif: string;
  dark: boolean;
}

const DARK_DEFAULTS: Omit<ExportTheme, "id" | "label" | "dark"> = {
  bg: "#09090b",
  bgSecondary: "#121215",
  bgTertiary: "#1a1a1f",
  text: "#f4f4f5",
  textSecondary: "#a1a1aa",
  textMuted: "#71717a",
  accentBlue: "#007aff",
  accentPurple: "#af52de",
  accentGreen: "#34c759",
  accentAmber: "#ff9500",
  accentRed: "#ff3b30",
  fontSans: "'Inter', -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif",
  fontSerif: "'Instrument Serif', Georgia, serif",
};

const THEME_LABEL: Record<string, string> = {
  dark: "Dark",
  light: "Light",
  cream: "Cream",
  navy: "Navy",
  laghari: "Laghari Labs",
};

const DARK_SET = new Set(["dark", "navy"]);

function resolveThemeId(raw: string): string {
  const valid = new Set(["dark", "light", "cream", "navy", "laghari", "system"]);
  if (!valid.has(raw)) return "dark";
  if (raw !== "system") return raw;
  try {
    const m = window.matchMedia?.("(prefers-color-scheme: light)");
    if (m && m.matches) return "light";
    return "dark";
  } catch {
    return "dark";
  }
}

export function readExportTheme(root: HTMLElement = document.documentElement): ExportTheme {
  const raw = (root.dataset.theme ?? root.getAttribute("data-theme") ?? "dark").trim().toLowerCase();
  const id = resolveThemeId(raw);
  const label = THEME_LABEL[id] ?? "Dark";
  const dark = DARK_SET.has(id);

  const style = (() => {
    try {
      return getComputedStyle(root);
    } catch {
      return null as unknown as CSSStyleDeclaration;
    }
  })();

  function getVar(name: string, fallback: string): string {
    if (!style) return fallback;
    const v = style.getPropertyValue(name).trim();
    return v || fallback;
  }

  return {
    id,
    label,
    bg: getVar("--bg-primary", DARK_DEFAULTS.bg),
    bgSecondary: getVar("--bg-secondary", DARK_DEFAULTS.bgSecondary),
    bgTertiary: getVar("--bg-tertiary", DARK_DEFAULTS.bgTertiary),
    text: getVar("--text-primary", DARK_DEFAULTS.text),
    textSecondary: getVar("--text-secondary", DARK_DEFAULTS.textSecondary),
    textMuted: getVar("--text-muted", DARK_DEFAULTS.textMuted),
    accentBlue: getVar("--accent-blue", DARK_DEFAULTS.accentBlue),
    accentPurple: getVar("--accent-purple", DARK_DEFAULTS.accentPurple),
    accentGreen: getVar("--accent-green", DARK_DEFAULTS.accentGreen),
    accentAmber: getVar("--accent-amber", DARK_DEFAULTS.accentAmber),
    accentRed: getVar("--accent-red", DARK_DEFAULTS.accentRed),
    fontSans: getVar("--font-sans", DARK_DEFAULTS.fontSans),
    fontSerif: getVar("--font-serif", DARK_DEFAULTS.fontSerif),
    dark,
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.trim();
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(h);
  if (!m) return `rgba(0,0,0,${alpha})`;
  let r = 0, g = 0, b = 0;
  const v = m[1];
  if (v.length === 3) {
    r = parseInt(v[0] + v[0], 16);
    g = parseInt(v[1] + v[1], 16);
    b = parseInt(v[2] + v[2], 16);
  } else if (v.length === 6 || v.length === 8) {
    r = parseInt(v.slice(0, 2), 16);
    g = parseInt(v.slice(2, 4), 16);
    b = parseInt(v.slice(4, 6), 16);
  } else {
    return `rgba(0,0,0,${alpha})`;
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function accentFor(theme: ExportTheme, heading: string, actionable: boolean): string {
  if (actionable) return theme.accentRed;
  if (DECISION.test(heading)) return theme.accentGreen;
  if (RISK.test(heading)) return theme.accentRed;
  if (TOPIC.test(heading)) return theme.accentPurple;
  return theme.accentBlue;
}

function slideCss(theme: ExportTheme): string {
  const line = hexToRgba(theme.text, 0.09);
  const cardBg = hexToRgba(theme.text, 0.04);
  const glowBlue = hexToRgba(theme.accentBlue, theme.dark ? 0.2 : 0.12);
  const glowRed = hexToRgba(theme.accentRed, theme.dark ? 0.16 : 0.1);
  const stageBg1 = theme.bgTertiary;
  const stageBg2 = theme.bg;
  const bulletText = theme.dark ? "#e8e8ef" : theme.text;
  const titleGradient = theme.dark
    ? `linear-gradient(180deg,#ffffff,#c4d2ff)`
    : `linear-gradient(180deg,${theme.text},${hexToRgba(theme.accentBlue, 0.7)})`;
  const titlePrintColor = theme.dark ? "#eef2ff" : theme.text;
  const whoColor = theme.dark ? "#fff" : theme.text;

  return `
@font-face{
  font-family:"Instrument Serif"; font-style:italic; font-weight:400; font-display:block;
  src:url("data:font/ttf;base64,${INSTRUMENT_SERIF_ITALIC_TTF_B64}") format("truetype");
}
:root{
  --ink:${theme.text}; --muted:${theme.textMuted};
  --azure:${theme.accentBlue}; --crimson:${theme.accentRed};
  --line:${line}; --card:${cardBg};
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{
  background:${theme.bg}; color:var(--ink); height:100vh; overflow:hidden;
  font-family:${theme.fontSans}; -webkit-font-smoothing:antialiased;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.viewport{position:fixed; inset:0; display:flex; align-items:center; justify-content:center; overflow:hidden;}

/* ---- the slide: a fixed 16:9 stage, scaled to fit the screen ---- */
.stage{
  position:relative; flex:0 0 auto; width:1280px; height:720px;
  transform:scale(var(--vs,1)); transform-origin:center center;
  display:flex; flex-direction:column; padding:34px 40px 24px; overflow:hidden;
  border:1px solid var(--line); border-radius:18px;
  background:
    radial-gradient(680px 420px at 6% -8%, ${glowBlue}, transparent 60%),
    radial-gradient(620px 420px at 104% 110%, ${glowRed}, transparent 55%),
    linear-gradient(155deg,${stageBg1},${stageBg2} 62%);
}
.stage::before{
  content:""; position:absolute; inset:0; pointer-events:none;
  background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:46px 46px; opacity:.18;
  -webkit-mask-image:radial-gradient(circle at 50% 18%,#000,transparent 78%);
  mask-image:radial-gradient(circle at 50% 18%,#000,transparent 78%);
}

.head{position:relative; flex:0 0 auto; border-bottom:1px solid var(--line); padding-bottom:14px;}
.top{display:flex; align-items:center; justify-content:space-between; gap:16px;}
.brand{display:flex; align-items:center; gap:9px; font-weight:700; letter-spacing:.22em; font-size:12px;}
.eyebrow{font-family:${theme.fontSerif}; font-style:italic; color:var(--muted); font-size:16px;}
.title{margin:14px 0 10px; font-weight:800; line-height:1.1; font-size:32px; unicode-bidi:plaintext; text-align:start;
  background:${titleGradient}; -webkit-background-clip:text; background-clip:text; color:transparent;}
.meta{display:flex; flex-wrap:wrap; gap:7px 11px; align-items:center; color:var(--muted); font-size:12.5px;}
.chip{background:var(--card); border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:11.5px; color:var(--ink);}
.dotsep{opacity:.45;}

.canvas{position:relative; flex:1 1 auto; min-height:0; overflow:hidden; margin-top:14px;}
.flow{font-size:15px; columns:3; column-gap:22px;}
.card{break-inside:avoid; position:relative; overflow:hidden; margin:0 0 0.95em; padding:0.85em 0.95em 0.7em;
  background:var(--card); border:1px solid var(--line); border-radius:12px;}
.card.wide{column-span:all;}
.card::before{content:""; position:absolute; inset:0 0 auto 0; height:3px; background:var(--accent,var(--azure)); opacity:.95;}
.card h2{margin:0.15em 0 0.65em; font-size:0.78em; font-weight:700; letter-spacing:.13em; text-transform:uppercase;
  color:var(--muted); unicode-bidi:plaintext; text-align:start;}

.bullets{list-style:none; margin:0; padding:0;}
.bullets li{position:relative; padding-inline-start:1.2em; margin:0 0 0.5em; line-height:1.42; color:${bulletText};
  unicode-bidi:plaintext; text-align:start;}
.bullets li::before{content:""; position:absolute; inset-inline-start:0; top:.48em; width:.4em; height:.4em; border-radius:2px;
  background:var(--accent,var(--azure)); transform:rotate(45deg);}
.actions{list-style:none; margin:0; padding:0;}
.actions li{display:flex; gap:.6em; align-items:flex-start; margin:0 0 0.55em; line-height:1.38;}
.actions .box{flex:0 0 auto; width:.95em; height:.95em; margin-top:.15em; border:1.5px solid var(--crimson); border-radius:3px;}
.actions .atxt{unicode-bidi:plaintext; text-align:start; color:${bulletText};}
.actions .who{font-weight:700; color:${whoColor};}
.empty{color:var(--muted); font-style:italic;}

.foot{position:relative; flex:0 0 auto; margin-top:12px; padding-top:11px; border-top:1px solid var(--line);
  display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; color:var(--muted); font-size:10.5px; letter-spacing:.02em;}
.foot .lock{color:var(--azure);}

/* ---- Adversaria reveal intro (screen only) ---- */
.intro{position:fixed; inset:0; z-index:50; background:${theme.bg};
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  animation:introOut .65s cubic-bezier(.7,0,.3,1) 2.0s forwards;}
.intro-word{
  font-family:"Instrument Serif",Georgia,"Times New Roman",serif;
  font-style:italic; font-weight:400; letter-spacing:-.02em;
  font-size:clamp(60px,9vw,104px); line-height:1; color:#24A0ED;
  opacity:0; transform:translateY(8px) scale(.985);
  animation:wordIn .9s cubic-bezier(.2,.7,.2,1) .2s forwards;}
.intro-sub{margin-top:10px; font-size:12px; letter-spacing:.3em; text-transform:uppercase; color:var(--muted);
  opacity:0; animation:fadeIn .55s ease .75s forwards;}
.intro-rule{height:3px; width:0; margin-top:20px; border-radius:2px;
  background:linear-gradient(90deg,var(--azure),var(--crimson)); animation:ruleIn .6s ease 1.05s forwards;}
.intro-tag{margin-top:16px; font-size:11px; letter-spacing:.36em; text-transform:uppercase; color:var(--muted);
  opacity:0; animation:fadeIn .55s ease 1.3s forwards;}
@keyframes wordIn{to{opacity:1; transform:none;}}
@keyframes ruleIn{to{width:min(360px,70vw);}}
@keyframes fadeIn{to{opacity:1;}}
@keyframes introOut{to{opacity:0; visibility:hidden;}}

.adversaria-print-btn{position:fixed; bottom:20px; right:20px; z-index:40; padding:10px 18px; border-radius:999px; border:1px solid ${line}; background:${theme.bgTertiary}; color:${theme.text}; font-family:${theme.fontSans}; font-size:13px; font-weight:600; cursor:pointer; box-shadow:0 4px 16px rgba(0,0,0,${theme.dark ? 0.3 : 0.12});}
.adversaria-print-btn:hover{filter:brightness(1.05);}

/* ---- one slide → one PDF page ---- */
@media print{
  html,body{height:auto; overflow:visible; background:${theme.bg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;}
  .viewport{position:static; display:block;}
  .stage{transform:none !important; border:none; border-radius:0;}
  .intro{display:none !important;}
  .adversaria-print-btn{display:none !important;}
  .title{background:none !important; color:${titlePrintColor} !important; -webkit-text-fill-color:${titlePrintColor} !important;}
  @page{size:1280px 720px; margin:0;}
}
`;
}

function renderActionItems(bullets: string[]): string {
  const rows = bullets.filter((b) => !isPlaceholderBullet(b));
  if (!rows.length) return `<div class="empty">None noted.</div>`;
  return `<ul class="actions">${rows
    .map((b) => {
      const { label, rest } = splitLabel(b);
      const who = label ? `<span class="who">${clean(label)}:</span> ` : "";
      return `<li><span class="box" aria-hidden="true"></span><span class="atxt" dir="auto">${who}${clean(rest || b)}</span></li>`;
    })
    .join("")}</ul>`;
}

function renderBullets(bullets: string[]): string {
  const rows = bullets.filter((b) => !isPlaceholderBullet(b));
  if (!rows.length) return `<div class="empty">None noted.</div>`;
  return `<ul class="bullets">${rows
    .map((b) => `<li dir="auto">${clean(b)}</li>`)
    .join("")}</ul>`;
}

/** Card markup. `wide` cards span all columns (used for Overview / Follow-ups). */
function card(heading: string, body: string, accent: string, wide = false): string {
  return `<section class="card${wide ? " wide" : ""}" style="--accent:${accent}"><h2 dir="auto">${clean(heading)}</h2>${body}</section>`;
}

// Fit the stage to the viewport, and shrink the body until it fills exactly one
// frame (so the slide never scrolls and prints as a single page).
const FIT_SCRIPT = `
(function(){
  function fitViewport(){
    var s=document.querySelector('.stage'); if(!s) return;
    if(window.matchMedia&&window.matchMedia('print').matches){ s.style.removeProperty('--vs'); return; }
    s.style.setProperty('--vs', Math.min(window.innerWidth/1304, window.innerHeight/744));
  }
  function fitContent(){
    var flow=document.querySelector('.flow'), canvas=document.querySelector('.canvas');
    if(!flow||!canvas) return;
    var size=15; flow.style.fontSize=size+'px';
    for(var i=0;i<32 && flow.scrollHeight>canvas.clientHeight && size>8;i++){ size-=0.5; flow.style.fontSize=size+'px'; }
  }
  function fit(){ fitViewport(); fitContent(); }
  window.addEventListener('load', fit);
  window.addEventListener('resize', fit);
  window.addEventListener('beforeprint', fitContent);
})();
`;
const PRINT_SCRIPT = `
window.addEventListener('load', function(){
  if(location.hash === '#print'){
    setTimeout(function(){ window.print(); }, 400);
  }
});
`;

function brandMark(theme: ExportTheme): string {
  const fill = theme.dark ? "#11131a" : theme.bgSecondary;
  const stroke = hexToRgba(theme.text, theme.dark ? 0.15 : 0.12);
  return `<svg width="20" height="20" viewBox="0 0 24 24" role="img" aria-label="Adversaria"><rect width="24" height="24" rx="6" fill="${fill}"/><rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="none" stroke="${stroke}"/><text x="12" y="17" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="15" fill="${theme.accentBlue}">A</text></svg>`;
}

/** A self-contained single-page "Meeting Minutes" slide for the export. */
export function buildSlideHtml(meeting: Meeting, theme: ExportTheme): string {
  const title = clean(cleanMeetingTitle(meeting.title));
  const titleAttr = escapeHtml(cleanMeetingTitle(meeting.title));
  const date = formatDateTime(meeting.recorded_at);
  const minutes = Math.round(meeting.duration_seconds / 60);
  const attendees = meeting.attendees.filter((a) => a.trim());

  const parsed = parseSummary(meeting.summary || "");
  const lead = parsed.preamble
    .filter((p) => !isPlaceholderBullet(p))
    .join(" ")
    .trim();

  const followups = parsed.sections.filter((s) => FOLLOWUP.test(s.heading));
  const sections = parsed.sections.filter((s) => !FOLLOWUP.test(s.heading));

  const parts: string[] = [];
  if (lead) parts.push(card("Overview", `<p class="lead-line" dir="auto">${clean(lead)}</p>`, theme.accentBlue, true));
  for (const s of sections) {
    const body = s.actionable ? renderActionItems(s.bullets) : renderBullets(s.bullets);
    parts.push(card(s.heading, body, accentFor(theme, s.heading, s.actionable)));
  }
  if (followups.length) {
    parts.push(
      card(followups[0].heading, renderBullets(followups.flatMap((s) => s.bullets)), theme.accentAmber, true),
    );
  }
  const cardsHtml =
    parts.join("") ||
    card("Summary", `<div class="empty">No summary yet.</div>`, theme.accentBlue, true);

  const attendeeChips = attendees.length
    ? `<span class="dotsep">·</span>` +
      attendees.map((a) => `<span class="chip" dir="auto">${clean(a)}</span>`).join(" ")
    : "";

  const css = slideCss(theme);
  const leadColor = theme.dark ? "#dcdce4" : theme.textSecondary;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="adversaria-theme" content="${escapeHtml(theme.id)}" />
<title>${titleAttr} — Meeting Minutes</title>
<style>${css}
.lead-line{margin:0; line-height:1.45; color:${leadColor};}</style>
</head>
<body>
<div class="intro" aria-hidden="true">
  <div class="intro-word">Adversaria</div>
  <div class="intro-sub">A Laghari Labs Product</div>
  <div class="intro-rule"></div>
  <div class="intro-tag">Nothing leaves your machine</div>
</div>
<div class="viewport">
  <main class="stage">
    <header class="head">
      <div class="top">
        <div class="brand">${brandMark(theme)}<span>ADVERSARIA</span></div>
        <div class="eyebrow">Meeting Minutes</div>
      </div>
      <h1 class="title" dir="auto">${title}</h1>
      <div class="meta">
        <span>${escapeHtml(date)}</span><span class="dotsep">·</span><span>${minutes} min</span>${attendeeChips}
      </div>
    </header>
    <div class="canvas"><div class="flow">${cardsHtml}</div></div>
    <footer class="foot">
      <span><span class="lock">●</span> Generated on-device with Adversaria — created locally; nothing left your machine. · ${theme.label.includes("Laghari Labs") ? "Laghari Labs theme" : `Laghari Labs · ${escapeHtml(theme.label)} theme`}</span>
      <span>${escapeHtml(date)}</span>
    </footer>
  </main>
</div>
<button class="adversaria-print-btn" onclick="window.print()">Print / Save as PDF</button>
<script>${FIT_SCRIPT}</script>
<script>${PRINT_SCRIPT}</script>
</body>
</html>`;
}
