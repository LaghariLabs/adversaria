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
    selector: '.recording-bar',
    navigate: { view: "meetings" },
    title: "Record",
    body: "One button captures both sides of a call — your mic and the other participants — entirely on this machine.",
  },
  {
    selector: '[data-tour="meetings"]',
    title: "Your meetings",
    body: "Every meeting lands here with its transcript and notes, searchable forever. Nothing is uploaded anywhere.",
  },
  {
    selector: '[data-tour="todos"]',
    title: "To-dos",
    body: "Action items from every meeting collect on one board, so nothing agreed in a call gets lost.",
  },
  {
    selector: '[data-tour="ai-model"]',
    navigate: { view: "settings", settingsTab: "model" },
    title: "One last thing — how your notes get written",
    body: "Pick a model that's already on this machine, download the one recommended for your hardware, or connect your own AI provider with an API key. Nothing downloads until you choose.",
  },
];

interface GuidedTourProps {
  /** App-level navigation so the tour can land on Settings › AI Model. */
  onNavigate: (view: string, settingsTab?: string) => void;
}

/** One-time guided tour after first-run setup (SPEC v2 addendum).
 *
 * The wizard deliberately makes NO engine choice, so this tour's whole job is
 * to end the journey on Settings › AI Model where that choice actually lives.
 * Hand-rolled coach marks: a dimmed overlay with a cutout spotlight over one
 * anchor at a time. Skippable at every step; finishing OR skipping persists
 * `tour_completed`, so it never shows twice. Existing users see it once after
 * the redesign too — settings moved, and this is the "what changed" walk. */
export function GuidedTour({ onNavigate }: GuidedTourProps) {
  const [eligible, setEligible] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const finishing = useRef(false);

  // Eligible once: setup complete and the tour never completed. Poll until
  // setup completes (the wizard finishes in a sibling component).
  useEffect(() => {
    let alive = true;
    const check = () => {
      Promise.all([getOnboardingState(), getConfig()])
        .then(([onboarding, config]) => {
          if (!alive) return;
          if (onboarding.setup_complete && !config.tour_completed) setEligible(true);
        })
        .catch(() => {});
    };
    check();
    const timer = window.setInterval(() => {
      if (eligible) return;
      check();
    }, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [eligible]);

  const step = STEPS[stepIndex];

  // Per step: navigate if asked, then track the anchor's rect until it exists
  // (the target view may still be mounting) and on every resize.
  useEffect(() => {
    if (!eligible || dismissed || !step) return;
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
  }, [eligible, dismissed, stepIndex]);

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
    }
  };

  if (!eligible || dismissed || !step) return null;

  const last = stepIndex === STEPS.length - 1;
  const next = () => {
    if (last) {
      void persistDone();
    } else {
      setStepIndex((current) => current + 1);
    }
  };

  // Tooltip below the anchor when there's room, above otherwise.
  const below = rect ? rect.bottom + 220 < window.innerHeight : true;
  const tooltipStyle = rect
    ? {
        top: below ? rect.bottom + 12 : undefined,
        bottom: below ? undefined : window.innerHeight - rect.top + 12,
        left: Math.max(16, Math.min(rect.left, window.innerWidth - 340)),
      }
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
        <p>{step.body}</p>
        <div className="tour-actions">
          <span className="tour-count">{stepIndex + 1} / {STEPS.length}</span>
          <button className="btn-secondary" onClick={() => void persistDone()}>Skip</button>
          <button className="btn-primary" onClick={next}>{last ? "Done" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}
