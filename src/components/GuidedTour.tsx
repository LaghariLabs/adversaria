import { useEffect, useRef, useState } from "react";

import { getConfig, getOnboardingState, updateConfig } from "../lib/tauri";

interface TourStep {
  /** CSS selector of the element to spotlight (data-tour anchors). */
  selector: string;
  title: string;
  body: string;
  /** Navigation to perform BEFORE showing this step. */
  navigate?: { view: string; settingsTab?: string };
}

const STEPS: TourStep[] = [
  {
    selector: ".recording-bar",
    navigate: { view: "meetings" },
    title: "Record",
    body: "One button captures both sides of a call — your mic and everyone else — entirely on this machine. When you stop, the transcript and notes write themselves in the background.",
  },
  {
    selector: '[data-tour="meeting-list"]',
    navigate: { view: "meetings" },
    title: "Your meetings",
    body: "Every meeting lands here — transcript, notes, and to-dos, searchable forever. Open one to see exactly what you get. Nothing is uploaded anywhere.",
  },
  {
    selector: '[data-tour="todo-board"]',
    navigate: { view: "todos" },
    title: "To-dos",
    body: "Action items from every meeting collect on one board, so nothing agreed in a call gets lost — and an AI agent can pick one up, do the work, and report back for your approval.",
  },
  // The remaining tabs each open for real — a step that talks about a page
  // the user cannot see taught nothing (Hamza, 2026-08-01).
  {
    selector: '[data-tour="weekly-view"]',
    navigate: { view: "weekly" },
    title: "Weekly",
    body: "Once a week, a briefing writes itself from that week's meetings — what happened, what was decided, and what's still open.",
  },
  {
    selector: '[data-tour="ask-view"]',
    navigate: { view: "ask" },
    title: "Ask",
    body: "Ask questions across every meeting you've ever had — \"what did we decide about pricing?\" — answered on this machine, from your own transcripts.",
  },
  {
    selector: '[data-tour="graph-view"]',
    navigate: { view: "graph" },
    title: "Graph",
    body: "The people and topics from your meetings, connected. Open anyone to see every meeting, decision, and to-do they touch.",
  },
  {
    selector: '[data-tour="ai-model"]',
    navigate: { view: "settings", settingsTab: "model" },
    title: "One last thing — how your notes get written",
    body: "", // resolved at render: depends on whether a transcription model exists yet
  },
];

const FINAL_BODY_READY =
  "Pick a model that's already on this machine, download the one recommended for your hardware, or connect your own AI provider with an API key. Nothing downloads until you choose.";
const FINAL_BODY_MISSING =
  "Meetings can't become text until a transcription model is on this machine — and without one, no notes get written either. The Download button right here fetches everything needed. Nothing starts until you click it.";

interface GuidedTourProps {
  /** App-level navigation so the tour can land on Settings › AI Model. */
  onNavigate: (view: string, settingsTab?: string) => void;
  /** The view currently on screen — the tour never STARTS over Settings
   *  (the wizard's guide button just landed the user there on purpose). */
  currentView: string;
  /** True while a setup/download error is being shown — the error outranks
   *  the tour; starting on top of it would bury what the user must see. */
  suspend?: boolean;
  /** True when no transcription model is usable yet — the final step then
   *  tells the user the consequence and points at the Download button. */
  transcriptionMissing?: boolean;
  /** Eligibility poll cadence; tests shorten it. */
  pollMs?: number;
}

/** The guided tour after first-run setup (SPEC V3, Phase B).
 *
 * The wizard deliberately makes NO model choice, so the tour teaches the flow
 * (record → the meeting lands → to-dos) and ends on Settings › AI Model where
 * the one real decision lives — saying plainly what happens if you skip it.
 * Hand-rolled coach marks: dimmed overlay, cutout spotlight, Back/Next,
 * Esc-to-skip, arrow keys. Skippable at every step; finishing OR skipping
 * persists `tour_completed` — and Settings › General can clear that flag to
 * replay the tour any time (skipping is no longer forever). */
export function GuidedTour({
  onNavigate,
  currentView,
  suspend = false,
  transcriptionMissing = false,
  pollMs = 3000,
}: GuidedTourProps) {
  const [eligible, setEligible] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const finishing = useRef(false);

  // Poll until the tour should run: setup complete and `tour_completed` false.
  // Replay support: Settings clears the flag, so a dismissed tour re-arms when
  // the poll sees it false again — `finishing` guards our own in-flight write
  // from being mistaken for a replay request.
  useEffect(() => {
    let alive = true;
    const check = () => {
      Promise.all([getOnboardingState(), getConfig()])
        .then(([onboarding, config]) => {
          if (!alive) return;
          if (config.tour_completed) {
            finishing.current = false; // our write landed; future replays re-arm
            return;
          }
          if (!onboarding.setup_complete || finishing.current) return;
          if (eligible && !dismissed) return; // already running
          if (suspend || currentView === "settings") return; // wrong moment to start
          setStepIndex(0);
          setDismissed(false);
          setEligible(true);
        })
        .catch(() => {});
    };
    check();
    const timer = window.setInterval(check, pollMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [eligible, dismissed, suspend, currentView, pollMs]);

  const active = eligible && !dismissed;
  const step = STEPS[stepIndex];

  // Per step: navigate if asked, then track the anchor's rect until it exists
  // (the target view may still be mounting) and on every resize.
  useEffect(() => {
    if (!active || !step) return;
    if (step.navigate) onNavigate(step.navigate.view, step.navigate.settingsTab);
    setRect(null);
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const el = document.querySelector(step.selector);
      if (el) setRect(el.getBoundingClientRect());
    };
    const timer = window.setInterval(measure, 200);
    measure();
    window.addEventListener("resize", measure);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [active, stepIndex]);

  const persistDone = async () => {
    if (finishing.current) return;
    finishing.current = true;
    setDismissed(true);
    try {
      // Fresh read-modify-write so we never clobber concurrent config edits.
      const config = await getConfig();
      await updateConfig({ ...config, tour_completed: true });
    } catch {
      // Non-fatal: worst case the tour offers itself once more next launch.
      finishing.current = false;
    }
  };

  const last = stepIndex === STEPS.length - 1;
  const next = () => {
    if (last) {
      void persistDone();
    } else {
      setStepIndex((current) => current + 1);
    }
  };
  const back = () => setStepIndex((current) => Math.max(0, current - 1));

  // Keyboard: Esc skips, arrows/Enter move. Registered only while showing.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void persistDone();
      } else if (event.key === "ArrowRight" || event.key === "Enter") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // next/back are stable enough per render; stepIndex drives their meaning.
  }, [active, stepIndex]);

  if (!active || !step) return null;

  const body = last
    ? transcriptionMissing
      ? FINAL_BODY_MISSING
      : FINAL_BODY_READY
    : step.body;
  const doneLabel = transcriptionMissing ? "Got it — I'll download it here" : "Done";

  // Tooltip below the anchor when there's room, above when there's room up
  // there — and INSIDE the spotlight when the anchor is (near) full-screen.
  // Full-page anchors (the To-dos board, the tab views) used to force the
  // "above" branch, pinning the tooltip off the top of the window with only
  // its button row peeking in.
  const below = rect ? rect.bottom + 220 < window.innerHeight : true;
  const above = rect ? rect.top > 240 : false;
  const left = rect ? Math.max(16, Math.min(rect.left, window.innerWidth - 340)) : 0;
  const tooltipStyle = rect
    ? below
      ? { top: rect.bottom + 12, left }
      : above
        ? { bottom: window.innerHeight - rect.top + 12, left }
        : { top: Math.max(16, rect.top + 24), left }
    : { top: "40%", left: "50%", transform: "translateX(-50%)" };

  return (
    <div className="tour-overlay" role="dialog" aria-label="Guided tour">
      {rect && (
        <div
          className="tour-spotlight"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}
      <div className="tour-tooltip" style={tooltipStyle}>
        <strong>{step.title}</strong>
        <p>{body}</p>
        <div className="tour-actions">
          <span className="tour-count">{stepIndex + 1} / {STEPS.length}</span>
          {stepIndex > 0 && (
            <button className="btn-secondary" onClick={back}>Back</button>
          )}
          <button className="btn-secondary" onClick={() => void persistDone()}>Skip</button>
          <button className="btn-primary" onClick={next}>{last ? doneLabel : "Next"}</button>
        </div>
      </div>
    </div>
  );
}
