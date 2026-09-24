import { useEffect, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { hudReducer, initialHudState } from "../lib/copilotHud";
import {
  copilotAskLast,
  copilotHudSavePosition,
  copilotHudSaveSize,
  copilotHudStartDrag,
  hideCopilotHud,
} from "../lib/tauri";
import { renderInlineBold } from "../lib/inlineBold";
import type { CopilotAnswerEvent, CopilotCard } from "../types";
import "../styles/copilot-hud.css";

/** Ms of empty streaming before the capsule admits it is still thinking. */
const WORKING_DELAY_MS = 1500;
/** Debounce for persisting the dragged window position. */
const MOVE_SAVE_DEBOUNCE_MS = 400;
/** Debounce for persisting the resized window size. */
const RESIZE_SAVE_DEBOUNCE_MS = 400;
/** A reader scrolled further than this is re-reading; new cards must not yank them back up. */
const SCROLL_STICKY_PX = 24;

/**
 * Floating copilot HUD (prompter layout) — rendered in its own frameless, transparent,
 * always-on-top window (`index.html?widget=copilot-hud`, label `copilot-hud`).
 * Mirrors the main window's `copilot-card` / `copilot-answer` broadcasts; no
 * new events, no new data leaves the device.
 */
export function CopilotHud(): JSX.Element {
  const [state, dispatch] = useReducer(hudReducer, initialHudState);
  const [workingVisible, setWorkingVisible] = useState(false);
  // "Answer this" in-flight + transient error line under the header.
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const answerErrorTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    return () => {
      if (answerErrorTimer.current !== undefined) {
        window.clearTimeout(answerErrorTimer.current);
      }
    };
  }, []);

  const handleAnswerThis = () => {
    if (answering) return;
    let useMeFallback = false;
    try {
      useMeFallback = localStorage.getItem("copilot.micQuestions") === "1";
    } catch {
      useMeFallback = false;
    }
    setAnswering(true);
    setAnswerError(null);
    void copilotAskLast(useMeFallback)
      .catch((e) => {
        if (answerErrorTimer.current !== undefined) {
          window.clearTimeout(answerErrorTimer.current);
        }
        setAnswerError(String(e));
        answerErrorTimer.current = window.setTimeout(() => {
          setAnswerError(null);
          answerErrorTimer.current = undefined;
        }, 4000);
      })
      .finally(() => {
        setAnswering(false);
      });
  };

  // The widget window must stay transparent outside the capsule.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  // Mirror the same broadcast payloads the main window consumes.
  useEffect(() => {
    const cardRegistration = listen<CopilotCard>("copilot-card", (event) => {
      dispatch({ type: "card", card: event.payload });
    });
    const answerRegistration = listen<CopilotAnswerEvent>(
      "copilot-answer",
      (event) => {
        dispatch({ type: "answer", event: event.payload });
      },
    );
    return () => {
      void cardRegistration.then((unlisten) => unlisten());
      void answerRegistration.then((unlisten) => unlisten());
    };
  }, []);

  // Persist the dragged position and resized size (debounced, logical
  // coordinates). The window API is imported lazily so this widget never
  // pulls it into the main entry chunk; a failure here must never break the
  // visible capsule.
  useEffect(() => {
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;
    let moveTimer: number | undefined;
    let resizeTimer: number | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        const win = getCurrentWindow();
        unlistenMoved = await win.onMoved(({ payload }) => {
          const physical = { x: payload.x, y: payload.y };
          if (moveTimer !== undefined) window.clearTimeout(moveTimer);
          moveTimer = window.setTimeout(() => {
            void win
              .scaleFactor()
              .then((factor) =>
                copilotHudSavePosition(
                  physical.x / factor,
                  physical.y / factor,
                ),
              )
              .catch(() => {});
          }, MOVE_SAVE_DEBOUNCE_MS);
        });
        unlistenResized = await win.onResized(({ payload }) => {
          const physical = { width: payload.width, height: payload.height };
          if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(() => {
            void win
              .scaleFactor()
              .then((factor) =>
                copilotHudSaveSize(
                  physical.width / factor,
                  physical.height / factor,
                ),
              )
              .catch(() => {});
          }, RESIZE_SAVE_DEBOUNCE_MS);
        });
      } catch {
        // Not running inside Tauri (e.g. tests) — dragging simply isn't saved.
      }
    })();
    return () => {
      cancelled = true;
      if (moveTimer !== undefined) window.clearTimeout(moveTimer);
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      unlistenMoved?.();
      unlistenResized?.();
    };
  }, []);

  const cards = state.cards;
  const newest = cards.length > 0 ? cards[cards.length - 1] : undefined;
  const newestId = newest?.cardId;
  const newestSession = newest?.sessionId;
  const newestSay = newest?.say;
  const newestStatus = newest?.status;

  // Newest card still streaming with nothing to show yet → "Working it out…"
  // after a beat, so the feed doesn't flash an empty SAY on every question.
  useEffect(() => {
    if (newestStatus === "streaming" && newestSay === "") {
      setWorkingVisible(false);
      const id = window.setTimeout(
        () => setWorkingVisible(true),
        WORKING_DELAY_MS,
      );
      return () => window.clearTimeout(id);
    }
    setWorkingVisible(false);
  }, [newestId, newestSession, newestSay, newestStatus]);

  // Prompter behaviour: a new card scrolls the feed back to the top, unless the
  // reader has scrolled down to re-read something older, in which case the
  // scroll position is left alone. Streaming text growing inside the newest
  // block never moves the scroll.
  const feedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    if (feed.scrollTop <= SCROLL_STICKY_PX) {
      feed.scrollTop = 0;
    }
  }, [newestId, newestSession]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Buttons handle their own clicks — starting an OS drag from one would
    // swallow the click and yank the window instead.
    if ((e.target as HTMLElement).closest("button")) return;
    void copilotHudStartDrag();
  };

  const stopButtonDrag = (e: React.MouseEvent) => e.stopPropagation();

  const renderSpecifics = (card: (typeof cards)[number]): JSX.Element | null => {
    if (card.specifics.length === 0) return null;
    return (
      <>
        {card.specifics.map((line, i) => (
          <p key={i} className="copilot-hud-specific">
            {card.shape === "steps" ? `${i + 1}. ` : "• "}
            {renderInlineBold(line)}
          </p>
        ))}
      </>
    );
  };

  const renderBlock = (
    card: (typeof cards)[number],
    isNewest: boolean,
  ): JSX.Element => (
    <article
      key={`${card.sessionId}:${card.cardId}`}
      className={`copilot-hud-block${isNewest ? "" : " copilot-hud-block--older"}`}
      data-testid={isNewest ? "copilot-hud-newest" : "copilot-hud-older"}
    >
      <p className="copilot-hud-question">{card.question}</p>
      {card.status === "error" ? (
        <p className="copilot-hud-empty">No answer for this one.</p>
      ) : isNewest && workingVisible ? (
        <p className="copilot-hud-working">
          <span className="copilot-hud-dot" aria-hidden="true" />
          Working it out…
        </p>
      ) : (
        <>
          <p className="copilot-hud-say">{renderInlineBold(card.say)}</p>
          {renderSpecifics(card)}
        </>
      )}
    </article>
  );

  // Newest first, like a prompter: the current answer sits at the top and the
  // earlier ones follow beneath a divider.
  const ordered = [...cards].reverse();

  return (
    <div className="copilot-hud-root">
      <div
        className="copilot-hud-panel"
        data-testid="copilot-hud-capsule"
        onMouseDown={handleMouseDown}
      >
        <header className="copilot-hud-header">
          <span className="copilot-hud-title">Copilot</span>
          <div className="copilot-hud-actions">
            <button
              type="button"
              className="copilot-hud-answer"
              aria-label="Answer the latest question"
              onMouseDown={stopButtonDrag}
              onClick={handleAnswerThis}
              disabled={answering}
            >
              Answer this
            </button>
            <button
              type="button"
              className="copilot-hud-hide"
              aria-label="Hide copilot answers"
              onMouseDown={stopButtonDrag}
              onClick={() => void hideCopilotHud()}
            >
              ×
            </button>
          </div>
        </header>
        {answerError !== null ? (
          <p className="copilot-hud-status" role="status">
            {answerError}
          </p>
        ) : null}
        <div className="copilot-hud-feed" ref={feedRef} aria-live="polite">
          {ordered.length === 0 ? (
            <p className="copilot-hud-empty">Listening for a question…</p>
          ) : (
            ordered.map((card, i) => (
              <div key={`${card.sessionId}:${card.cardId}`} className="copilot-hud-entry">
                {i > 0 ? (
                  <hr className="copilot-hud-divider" role="separator" />
                ) : null}
                {renderBlock(card, i === 0)}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
