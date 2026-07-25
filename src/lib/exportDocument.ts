/**
 * Branded single-page "Meeting Minutes" slide export for a single meeting.
 *
 * `buildSlideHtml()` returns a self-contained `.html` document (inline styles +
 * one tiny inline fit script, no external assets — privacy-clean) styled as a
 * dark 16:9 presentation slide:
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

/** Accent colour for a card, by heading semantics. */
function accentFor(heading: string, actionable: boolean): string {
  if (actionable) return "#ff4d57"; // crimson — the adversarial action edge
  if (DECISION.test(heading)) return "#3fd0a0"; // teal-green — decided
  if (RISK.test(heading)) return "#ff4d57";
  if (TOPIC.test(heading)) return "#8b7bff"; // violet — discussion
  return "#5b9bff"; // azure — default brand
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

const SLIDE_CSS = `
@font-face{
  font-family:"Instrument Serif"; font-style:italic; font-weight:400; font-display:block;
  src:url("data:font/ttf;base64,${INSTRUMENT_SERIF_ITALIC_TTF_B64}") format("truetype");
}
:root{
  --ink:#f5f5f7; --muted:#9a9aa7;
  --azure:#5b9bff; --crimson:#ff4d57;
  --line:rgba(255,255,255,.09); --card:rgba(255,255,255,.04);
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{
  background:#060609; color:var(--ink); height:100vh; overflow:hidden;
  font-family:-apple-system,"Segoe UI",system-ui,sans-serif; -webkit-font-smoothing:antialiased;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
.viewport{position:fixed; inset:0; display:flex; align-items:center; justify-content:center; overflow:hidden;}

/* ---- the slide: a fixed 16:9 stage, scaled to fit the screen ---- */
.stage{
  position:relative; flex:0 0 auto; width:1280px; height:720px;
  transform:scale(var(--vs,1)); transform-origin:center center;
  display:flex; flex-direction:column; padding:34px 40px 24px; overflow:hidden;
  border:1px solid var(--line); border-radius:18px;
  background:
    radial-gradient(680px 420px at 6% -8%, rgba(91,155,255,.20), transparent 60%),
    radial-gradient(620px 420px at 104% 110%, rgba(255,77,87,.16), transparent 55%),
    linear-gradient(155deg,#0b0c12,#070709 62%);
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
.eyebrow{font-family:Georgia,"Times New Roman",serif; font-style:italic; color:var(--muted); font-size:16px;}
.title{margin:14px 0 10px; font-weight:800; line-height:1.1; font-size:32px; unicode-bidi:plaintext; text-align:start;
  background:linear-gradient(180deg,#ffffff,#c4d2ff); -webkit-background-clip:text; background-clip:text; color:transparent;}
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
.bullets li{position:relative; padding-inline-start:1.2em; margin:0 0 0.5em; line-height:1.42; color:#e8e8ef;
  unicode-bidi:plaintext; text-align:start;}
.bullets li::before{content:""; position:absolute; inset-inline-start:0; top:.48em; width:.4em; height:.4em; border-radius:2px;
  background:var(--accent,var(--azure)); transform:rotate(45deg);}
.actions{list-style:none; margin:0; padding:0;}
.actions li{display:flex; gap:.6em; align-items:flex-start; margin:0 0 0.55em; line-height:1.38;}
.actions .box{flex:0 0 auto; width:.95em; height:.95em; margin-top:.15em; border:1.5px solid var(--crimson); border-radius:3px;}
.actions .atxt{unicode-bidi:plaintext; text-align:start; color:#e8e8ef;}
.actions .who{font-weight:700; color:#fff;}
.empty{color:var(--muted); font-style:italic;}

.foot{position:relative; flex:0 0 auto; margin-top:12px; padding-top:11px; border-top:1px solid var(--line);
  display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; color:var(--muted); font-size:10.5px; letter-spacing:.02em;}
.foot .lock{color:var(--azure);}

/* ---- Adversaria reveal intro (screen only) ---- */
.intro{position:fixed; inset:0; z-index:50; background:#060609;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  animation:introOut .65s cubic-bezier(.7,0,.3,1) 2.0s forwards;}
/* The wordmark, written exactly as the app's own splash: Instrument Serif
   italic in solid azure (#24A0ED). The font is embedded (base64) so it renders
   identically without an external fetch; it fades up gently, no stretch. */
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

/* ---- one slide → one PDF page ---- */
@media print{
  html,body{height:auto; overflow:visible; background:#060609;}
  .viewport{position:static; display:block;}
  .stage{transform:none !important; border:none; border-radius:0;}
  .intro{display:none !important;}
  /* background-clip:text on the title paints as a solid box in Chrome's PDF
     renderer — force a solid colour for print instead of the screen gradient. */
  .title{background:none !important; color:#eef2ff !important; -webkit-text-fill-color:#eef2ff !important;}
  @page{size:1280px 720px; margin:0;}
}
`;

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

const BRAND_MARK = `<svg width="20" height="20" viewBox="0 0 24 24" role="img" aria-label="Adversaria"><rect width="24" height="24" rx="6" fill="#11131a"/><rect x="0.5" y="0.5" width="23" height="23" rx="5.5" fill="none" stroke="#2a3350"/><text x="12" y="17" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="15" fill="#5b9bff">A</text></svg>`;

/** A self-contained single-page dark "Meeting Minutes" slide for the export. */
export function buildSlideHtml(meeting: Meeting): string {
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
  if (lead) parts.push(card("Overview", `<p class="lead-line" dir="auto">${clean(lead)}</p>`, "#5b9bff", true));
  for (const s of sections) {
    const body = s.actionable ? renderActionItems(s.bullets) : renderBullets(s.bullets);
    parts.push(card(s.heading, body, accentFor(s.heading, s.actionable)));
  }
  if (followups.length) {
    parts.push(
      card(followups[0].heading, renderBullets(followups.flatMap((s) => s.bullets)), "#ffb454", true),
    );
  }
  const cardsHtml =
    parts.join("") ||
    card("Summary", `<div class="empty">No summary yet.</div>`, "#5b9bff", true);

  const attendeeChips = attendees.length
    ? `<span class="dotsep">·</span>` +
      attendees.map((a) => `<span class="chip" dir="auto">${clean(a)}</span>`).join(" ")
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${titleAttr} — Meeting Minutes</title>
<style>${SLIDE_CSS}
.lead-line{margin:0; line-height:1.45; color:#dcdce4;}</style>
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
        <div class="brand">${BRAND_MARK}<span>ADVERSARIA</span></div>
        <div class="eyebrow">Meeting Minutes</div>
      </div>
      <h1 class="title" dir="auto">${title}</h1>
      <div class="meta">
        <span>${escapeHtml(date)}</span><span class="dotsep">·</span><span>${minutes} min</span>${attendeeChips}
      </div>
    </header>
    <div class="canvas"><div class="flow">${cardsHtml}</div></div>
    <footer class="foot">
      <span><span class="lock">●</span> Generated on-device with Adversaria — created locally; nothing left your machine.</span>
      <span>${escapeHtml(date)}</span>
    </footer>
  </main>
</div>
<script>${FIT_SCRIPT}</script>
</body>
</html>`;
}
