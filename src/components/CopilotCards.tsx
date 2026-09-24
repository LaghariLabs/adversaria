import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CopilotCard, CopilotMode, CopilotPassage } from "../types";
import { copilotCardReview, copilotSetMicQuestions } from "../lib/tauri";
import { renderInlineBold } from "../lib/inlineBold";
import { COPY } from "../lib/platform";

export interface CopilotCardsProps {
  cards: CopilotCard[];
  onForceCard: (useMeFallback: boolean) => void;
  onPin: (card: CopilotCard) => void;
  onCancel?: (cardId: number) => void;
  onRetry?: (cardId: number) => void;
  copilotMode?: CopilotMode;
  webEnabled?: boolean;
  copilotSessionId?: string | null;
  hideHead?: boolean;
}

function providerName(provider: string | undefined): string {
  if (provider === "no_ai") return "No AI";
  if (provider === "local") return "Local";
  if (provider === "deepseek") return "DeepSeek";
  return "Claude";
}

function formatTime(askedAtMs: number): string {
  const d = new Date(askedAtMs);
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${m}:${s}`;
}

function sourceLabel(passage: CopilotPassage): string {
  switch (passage.source_kind) {
    case "meeting":
      return passage.title;
    case "vault":
      return passage.title;
    case "project":
      return passage.title;
    case "notes":
      return "Your notes";
    case "attachment":
      return passage.title;
    case "folder":
      return passage.title;
    default:
      return passage.title;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanPassageText(text: string, title: string): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  if (title && lines.length > 0) {
    const first = lines[0].trim();
    const t = title.trim();
    if (t) {
      const lowerFirst = first.toLowerCase();
      const lowerTitle = t.toLowerCase();
      let shouldDrop = lowerFirst === lowerTitle;
      if (!shouldDrop) {
        const esc = escapeRegExp(t);
        const re = new RegExp(`^${esc}\\s*\\(.*\\)\\s*$`, "i");
        if (re.test(first)) shouldDrop = true;
      }
      if (shouldDrop) {
        lines.shift();
      }
    }
  }
  return lines.join("\n");
}

export function renderPassage(text: string): ReactNode[] {
  if (!text) return [];
  const result: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) result.push(before);
    result.push(<strong key={key++}>{match[1]}</strong>);
    lastIndex = match.index + match[0].length;
  }
  const after = text.slice(lastIndex);
  if (after) result.push(after);
  if (result.length === 0) result.push(text);
  return result;
}

function renderAnswerText(text: string, isStreaming: boolean): JSX.Element {
  const lines = text.split("\n");
  const bulletLines: string[] = [];
  const otherLines: string[] = [];
  for (const line of lines) {
    if (/^\s*-\s/.test(line)) bulletLines.push(line.replace(/^\s*-\s/, ""));
    else if (line.trim() !== "") otherLines.push(line);
  }
  const bullets = bulletLines.length > 0 ? bulletLines : otherLines;
  if (bullets.length === 0 && !text) {
    return <>{isStreaming ? <span className="copilot-answer-cursor">▌</span> : null}</>;
  }
  if (bulletLines.length > 0) {
    return (
      <ul className="copilot-answer-list">
        {bullets.map((b, i) => (
          <li key={i} className="copilot-answer-bullet" dir="auto">
            {b}
            {isStreaming && i === bullets.length - 1 ? <span className="copilot-answer-cursor">▌</span> : null}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className="copilot-answer-text" dir="auto">
      {text}
      {isStreaming ? <span className="copilot-answer-cursor">▌</span> : null}
    </p>
  );
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function splitContextTurn(turn: string): { speaker: string; text: string } {
  const match = /^(Me|Them):\s*([\s\S]*)$/.exec(turn.trim());
  return match ? { speaker: match[1], text: match[2] } : { speaker: "Context", text: turn };
}

function CardArticle({
  card,
  isNewest,
  pinnedIds,
  setPinnedIds,
  dismissedIds,
  setDismissedIds,
  expandedPassages,
  togglePassage,
  expandedSources,
  toggleSources,
  expandedContexts,
  toggleContext,
  copilotMode,
  webEnabled,
  onPin,
  onCancel,
  onRetry,
}: {
  card: CopilotCard;
  isNewest: boolean;
  pinnedIds: Set<number>;
  setPinnedIds: React.Dispatch<React.SetStateAction<Set<number>>>;
  dismissedIds: Set<number>;
  setDismissedIds: React.Dispatch<React.SetStateAction<Set<number>>>;
  expandedPassages: Set<string>;
  togglePassage: (k: string) => void;
  expandedSources: Set<string>;
  toggleSources: (k: string) => void;
  expandedContexts: Set<string>;
  toggleContext: (k: string) => void;
  copilotMode: CopilotMode;
  webEnabled: boolean;
  onPin: (c: CopilotCard) => void;
  onCancel?: (cardId: number) => void;
  onRetry?: (cardId: number) => void;
}): JSX.Element {
  const isStreaming = card.answer?.status === "streaming" || card.answer?.status === "searching";
  const showNothingInNotes = card.passages.length === 0 && card.status !== "heard";
  const canPin = card.passages.length > 0 || !!(card.answer?.text?.trim() || card.answer?.provenance?.length || card.answer?.sections);
  const cardKey = `${card.session_id}-${card.id}`;
  const sourcesAreOpen = expandedSources.has(cardKey);
  const contextIsOpen = expandedContexts.has(cardKey);
  const sourcesId = `copilot-sources-${card.id}`;
  const contextId = `copilot-context-${card.id}`;
  const contextTurns = card.context_turns ?? [];
  const contextCount = contextTurns.length + 1;
  const active = card.status === "heard" || card.status === "answering";
  const [menuOpen, setMenuOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [card.id, card.answer?.status, card.answer?.egress_bytes, card.answer?.provider]);
  useEffect(() => { setFollowUpOpen(false); }, [card.id, card.answer?.sections?.next]);
  const hasNext = !!card.answer?.sections?.next?.trim();
  const nextText = card.answer?.sections?.next?.trim() ?? "";

  return (
    <article
      data-testid={`copilot-card-${card.id}`}
      className={`copilot-card${isNewest ? " copilot-card--new" : ""}${active ? " copilot-card--active" : ""}`}
      aria-label={`Copilot answer for: ${card.question}`}
    >
      <div className="copilot-card-question">
        <span className="copilot-question-text" dir="auto">{card.question}</span>
        <span className="copilot-time">{formatTime(card.asked_at_ms)}</span>
      </div>
      {card.resolved_question != null && card.resolved_question.trim() !== "" && card.resolved_question !== card.question && (
        <p className="copilot-resolved" dir="auto">Understood as: {card.resolved_question}</p>
      )}

      {(() => {
        const answering = card.status === "answering" && card.answer;
        const showAnswering =
          card.status === "answering" &&
          answering &&
          answering.status !== "searching" &&
          answering.status !== "done" &&
          answering.status !== "error" &&
          answering.status !== "cancelled";
        const skippedLabel =
          card.status === "skipped"
            ? card.reason === "superseded"
              ? "Skipped, newer question arrived"
              : card.reason === "cancelled"
                ? "Skipped: cancelled"
                : card.reason === "session_ended"
                  ? "Skipped: session ended"
                  : "Skipped"
            : null;
        const lifecycle: ReactNode =
          card.status === "heard"
            ? "Heard the complete question"
            : card.status === "answering" && card.answer?.status === "searching"
              ? "Searching the web…"
              : showAnswering
                ? <>Answering ({providerName(answering!.provider)})…</>
                : card.status === "answering" && !card.answer
                  ? "Looking in your notes…"
                  : card.status === "done" && card.provider_frozen === "no_ai"
                    ? "Done · No AI · passages only"
                    : skippedLabel;
        return lifecycle ? (
          <p className="copilot-lifecycle" data-testid="copilot-lifecycle">
            {lifecycle}
          </p>
        ) : null;
      })()}

      {card.answer && (
        <div className={`copilot-answer${isStreaming ? " copilot-answer--streaming" : ""}`} aria-live="polite">
          {(() => {
            const answer = card.answer!;
            const retryMatchesConsent =
              card.provider_frozen === copilotMode &&
              !(answer.web_requested === true && !webEnabled);
            const isSteps = card.answer_shape === "steps";
            const sections = answer.sections ?? undefined;
            const hasSections = !!sections && (answer.status === "streaming" || answer.status === "searching" || answer.status === "done");
            const interrupted = answer.status === "error" || answer.status === "cancelled";
            const showStepsInterrupt = isSteps && !!sections && interrupted;

            if (interrupted && !showStepsInterrupt) {
              if (answer.status === "error") {
                return (
                  <>
                    <p className="copilot-answer-error" dir="auto">{answer.error}</p>
                    {onRetry && retryMatchesConsent && <button type="button" className="copilot-retry-btn" onClick={() => onRetry(card.id)}>Retry</button>}
                  </>
                );
              }
              const reasonLabel = answer.reason === "user" ? "Cancelled" : answer.reason === "mode_changed" ? "Cancelled: mode changed" : answer.reason === "session_ended" ? "Cancelled: session ended" : "Cancelled";
              return (
                <>
                  <p className="copilot-answer-cancelled" dir="auto">{reasonLabel}</p>
                  {onRetry && retryMatchesConsent && <button type="button" className="copilot-retry-btn" onClick={() => onRetry(card.id)}>Retry</button>}
                </>
              );
            }

            if (hasSections || showStepsInterrupt) {
              const saySentences = sections?.say ?? [];
              const specifics = (sections?.specifics ?? []).filter((s) => s.trim() !== "");
              const notes = sections?.notes ?? [];
              const lead = saySentences.join(" ").trim();
              return (
                <>
                  {answer.status === "searching" && <p className="copilot-answer-searching">Searching the web…</p>}
                  <p className="copilot-headline" dir="auto">
                    {lead}
                    {isStreaming ? <span className="copilot-answer-cursor">▌</span> : null}
                  </p>
                  {specifics.length > 0 && isSteps ? (
                    <ol className="copilot-steps">
                      {specifics.map((spec, sIdx) => (
                        <li key={sIdx} className="copilot-step" dir="auto">{renderInlineBold(spec)}</li>
                      ))}
                    </ol>
                  ) : specifics.length > 0 ? (
                    <ul className="copilot-brief-bullets">
                      {specifics.map((spec, sIdx) => (
                        <li key={sIdx} className="copilot-brief-bullet" dir="auto">{renderInlineBold(spec)}</li>
                      ))}
                    </ul>
                  ) : null}
                  {notes.length > 0 && (
                    <div className="copilot-notes">
                      <span className="copilot-notes-label">From your notes</span>
                      {notes.map((note, nIdx) => {
                        const title = typeof note.passage_index === "number" ? (card.passages[note.passage_index]?.title ?? `P${(note.passage_index ?? 0) + 1}`) : "Notes";
                        const hasQuote = note.quote && note.quote.trim() !== "";
                        return (
                          <div key={nIdx} className="copilot-note">
                            <span className="copilot-chip chip--notes">{title}</span>
                            {hasQuote ? (
                              <>
                                <q dir="auto">{note.quote}</q>
                                <span className="copilot-note-clause">{note.clause}</span>
                              </>
                            ) : (
                              <span className="copilot-note-raw" dir="auto">{note.text}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {showStepsInterrupt && <p className="copilot-incomplete" dir="auto">Incomplete</p>}
                  {showStepsInterrupt && onRetry && retryMatchesConsent && <button type="button" className="copilot-retry-btn" onClick={() => onRetry(card.id)}>Retry</button>}
                  {isStreaming && onCancel && <button type="button" className="copilot-cancel-btn" onClick={() => onCancel(card.id)}>Cancel</button>}
                </>
              );
            }
            return (
              <>
                {answer.status === "searching" && <p className="copilot-answer-searching">Searching the web…</p>}
                {answer.status === "done" && answer.provenance && answer.provenance.length > 0 ? (
                  <ul className="copilot-answer-list">
                    {answer.provenance.map((bullet, bulletIndex) => {
                      const isWeb = bullet.label === "web" && !!bullet.url;
                      const domain = isWeb ? domainFromUrl(bullet.url!) : "";
                      const chipLabel = bullet.label === "notes" ? "your notes" : isWeb ? `web · ${domain}` : providerName(answer.provider);
                      const chipClass = bullet.label === "notes" ? "chip--notes" : bullet.label === "web" ? "chip--web" : "chip--model";
                      const chip = <span className={`copilot-chip ${chipClass}`}>{chipLabel}</span>;
                      return (
                        <li key={bulletIndex} className="copilot-answer-bullet" dir="auto">
                          {bullet.text}{" "}
                          {isWeb && bullet.url ? <a href={bullet.url} target="_blank" rel="noreferrer">{chip}</a> : chip}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  renderAnswerText(answer.text, isStreaming)
                )}
                {isStreaming && onCancel && <button type="button" className="copilot-cancel-btn" onClick={() => onCancel(card.id)}>Cancel</button>}
              </>
            );
          })()}
        </div>
      )}

      {card.status === "answering" && !card.answer && onCancel && (
        <button type="button" className="copilot-cancel-btn" onClick={() => onCancel(card.id)}>Cancel</button>
      )}

      {(() => {
        const metaNotes = card.answer?.sections?.notes ?? [];
        const metaTrust =
          card.answer?.status === "done" && card.provider_frozen !== "no_ai"
            ? metaNotes.length > 0
              ? `from your notes · ${metaNotes.length}`
              : "model knowledge"
            : "";
        const metaToneDot = metaTrust ? (
          <span className={`copilot-trust-dot copilot-trust--${metaNotes.length > 0 ? "supported" : "unverified"}`} aria-hidden="true" />
        ) : null;
        return (
          <div className="lc-card-disclosure">
            <p className="copilot-card-meta" data-testid="copilot-card-meta">
              {metaToneDot}<span className="copilot-provider-chip">{providerName(card.provider_frozen)}</span>
              {card.trigger === "manual" && <> · <span className="copilot-manual-chip">manual</span></>}
              {metaTrust && <> · <span className="copilot-card-trust">{metaTrust}</span></>}
            </p>
            <div className="lc-card-actions">
              {hasNext && (
                <button
                  type="button"
                  className="lc-disclosure-btn"
                  aria-expanded={followUpOpen}
                  onClick={() => setFollowUpOpen((v) => !v)}
                >
                  <span aria-hidden="true">›</span> Follow-up
                </button>
              )}
              {card.passages.length > 0 && (
                <button
                  type="button"
                  className="lc-disclosure-btn"
                  aria-expanded={expandedSources.has(cardKey)}
                  aria-controls={sourcesId}
                  onClick={() => toggleSources(cardKey)}
                >
                  <span aria-hidden="true">›</span> Sources <span>· {card.passages.length}</span>
                </button>
              )}
              {card.status === "done" && canPin && (
            <button
              type="button"
              className="lc-card-action-btn"
              aria-label={`Pin card ${card.id} to notes`}
              onClick={() => {
                onPin(card);
                copilotCardReview(card.session_id, card.id, "pin").catch(() => {});
                setPinnedIds((prev) => {
                  const next = new Set(prev);
                  next.add(card.id);
                  return next;
                });
              }}
              disabled={pinnedIds.has(card.id)}
            >
              {pinnedIds.has(card.id) ? "Pinned" : "Pin"}
            </button>
          )}
          <div className="lc-card-menu-wrap">
            <button
              type="button"
              className="lc-card-action-btn"
              aria-label="More"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              style={{ minWidth: "32px", width: "32px", padding: 0 }}
            >
              …
            </button>
            {menuOpen && (
              <div role="menu" className="lc-card-menu">
                {card.answer?.status === "done" && (
                  <p className="copilot-answer-footer">
                    {card.answer.provider === "local" ? `0 bytes left this ${COPY.device}` : `Prepared request payload: ${card.answer.egress_bytes ?? 0} bytes`}
                    {card.answer.web_performed != null && card.answer.web_performed > 0 ? ` · ${card.answer.web_performed} web searches` : ""}
                  </p>
                )}
                {showNothingInNotes && (
                  <span className="copilot-no-passages">No matching notes</span>
                )}
                <button
                  type="button"
                  className="lc-disclosure-btn"
                  aria-expanded={contextIsOpen}
                  aria-controls={contextId}
                  onClick={() => toggleContext(cardKey)}
                >
                  <span aria-hidden="true">›</span> Context <span>· {contextCount} {contextCount === 1 ? "turn" : "turns"}</span>
                </button>
                <span className="copilot-retrieval">{card.retrieval_ms != null ? `${card.retrieval_ms} ms` : ""}</span>
                {(card.status === "done" || card.status === "skipped") && !dismissedIds.has(card.id) && (
                  <button
                    type="button"
                    className="lc-disclosure-btn"
                    onClick={() => {
                      copilotCardReview(card.session_id, card.id, "dismiss").catch(() => {});
                      setDismissedIds((prev) => {
                        const next = new Set(prev);
                        next.add(card.id);
                        return next;
                      });
                      setMenuOpen(false);
                    }}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            )}
            </div>
            </div>
          </div>
        );
      })()}
      {hasNext && followUpOpen && (
        <div className="copilot-followup" style={{ marginTop: 8, padding: "8px 0 0", borderTop: "1px solid var(--border-color)" }}>
          <p dir="auto" style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>{nextText}</p>
        </div>
      )}

      {contextIsOpen && (
        <div className="copilot-context-window" id={contextId}>
          <strong>Conversation used for this answer</strong>
          {[...contextTurns, `${card.question_source ?? "Them"}: ${card.question}`].map((turn, turnIndex) => {
            const parsed = splitContextTurn(turn);
            return (
              <div className="copilot-context-turn" key={`${cardKey}-context-${turnIndex}`}>
                <span>{parsed.speaker}</span>
                <p dir="auto">{parsed.text}</p>
              </div>
            );
          })}
        </div>
      )}

      {sourcesAreOpen && card.passages.length > 0 && (
        <div className="copilot-passages" id={sourcesId}>
          {card.passages.map((passage, passageIndex) => {
            const key = `${cardKey}-${passageIndex}`;
            const cleaned = cleanPassageText(passage.text, passage.title);
            const needsToggle = cleaned.split("\n").length > 6 || cleaned.length > 420;
            const isExpanded = expandedPassages.has(key);
            const clamped = needsToggle && !isExpanded;
            return (
              <div key={key} className="copilot-passage">
                <span className="context-used-chip" title={passage.source_id}>{sourceLabel(passage)}</span>
                <p className={`copilot-passage-text${clamped ? " copilot-passage-text--clamped" : ""}`} dir="auto">
                  {renderPassage(cleaned)}
                </p>
                {needsToggle && (
                  <button type="button" className="copilot-passage-toggle" onClick={() => togglePassage(key)}>
                    {isExpanded ? "Show less" : "Show more"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

export function CopilotCards({ cards, onForceCard, onPin, onCancel, onRetry, copilotMode = "no_ai", webEnabled = false, copilotSessionId, hideHead = false }: CopilotCardsProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(cards.length);
  const [expandedPassages, setExpandedPassages] = useState<Set<string>>(() => new Set());
  const [expandedSources, setExpandedSources] = useState<Set<string>>(() => new Set());
  const [expandedContexts, setExpandedContexts] = useState<Set<string>>(() => new Set());
  const [useMeFallback, setUseMeFallback] = useState(() => {
    try {
      return localStorage.getItem("copilot.micQuestions") === "1";
    } catch {
      return false;
    }
  });
  const [showNewPill, setShowNewPill] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<Set<number>>(() => new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(() => new Set());
  const [headMenuOpen, setHeadMenuOpen] = useState(false);

  useLayoutEffect(() => {
    if (cards.length > prevLenRef.current) {
      const el = scrollRef.current;
      if (el) {
        if (el.scrollTop <= 40) {
          el.scrollTop = 0;
          setShowNewPill(false);
        } else {
          const firstArticle = el.querySelector("article") as HTMLElement | null;
          if (firstArticle) {
            el.scrollTop += firstArticle.offsetHeight;
          }
          setShowNewPill(true);
        }
      } else {
        // no inner scroller — show pill if not at top of page
        setShowNewPill(true);
      }
    }
    prevLenRef.current = cards.length;
  }, [cards.length]);

  useEffect(() => {
    const trimmed = copilotSessionId?.trim();
    if (trimmed && useMeFallback) {
      copilotSetMicQuestions(true).catch(() => {});
    }
  }, [copilotSessionId, useMeFallback]);

  useEffect(() => {
    setPinnedIds(new Set());
    setDismissedIds(new Set());
  }, [copilotSessionId]);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop <= 40 && showNewPill) {
      setShowNewPill(false);
    }
  }

  function togglePassage(key: string): void {
    setExpandedPassages((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSources(key: string): void {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleContext(key: string): void {
    setExpandedContexts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const visibleCards = cards.filter((c) => !dismissedIds.has(c.id));
  const latest = visibleCards[0] ?? null;
  const earlier = visibleCards.slice(1);
  const earlierCount = earlier.length;
  const [earlierOpen, setEarlierOpen] = useState(false);

  return (
    <div className="copilot-cards lc-cards">
      {!hideHead && (
        <div className="lc-head">
          <span className="lc-head-label">COPILOT</span>
          <div className="lc-head-actions">
            <button type="button" className="lc-head-btn" onClick={() => onForceCard(useMeFallback)}>
              Answer last
            </button>
            <div className="lc-head-menu-wrap">
            <button type="button" className="lc-head-menu-btn" aria-label="More options" aria-expanded={headMenuOpen} onClick={() => setHeadMenuOpen((v) => !v)}>
              …
            </button>
            {headMenuOpen && (
              <div role="menu" className="lc-head-menu-popover">
                <label className="lc-head-menu-item">
                  <input
                    type="checkbox"
                    checked={useMeFallback}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setUseMeFallback(checked);
                      try {
                        localStorage.setItem("copilot.micQuestions", checked ? "1" : "0");
                      } catch {}
                      copilotSetMicQuestions(checked).catch(() => {});
                    }}
                    aria-label="Self-ask mode: answer questions I ask out loud"
                  />
                  Self-ask mode: answer questions I ask out loud
                </label>
                {(copilotMode === "local" || copilotMode === "no_ai") && (
                  <span className="copilot-privacy">
                    {copilotMode === "local" ? `Current conversation stays on this ${COPY.device} · 0 bytes sent` : `Your notes and conversation stay on this ${COPY.device}`}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {cards.length === 0 ? (
        <>
          <p className="copilot-empty">Questions from the other side will appear here as short, live answers.</p>
          <p className="copilot-hint">Off: only the other side&apos;s questions trigger answers; say &quot;copilot, …&quot; to ask one yourself. On: your own questions trigger answers too.</p>
        </>
      ) : (
        <>
          {showNewPill && (
            <button
              type="button"
              className="lc-new-pill"
              onClick={() => {
                const el = scrollRef.current;
                if (el) el.scrollTo({ top: 0 });
                // also scroll parent if needed
                window.scrollTo({ top: 0 });
                setShowNewPill(false);
              }}
            >
              New answer ↑
            </button>
          )}
          <div className="copilot-list lc-cards-list" ref={scrollRef} role="feed" aria-label="Copilot answers" onScroll={handleScroll}>
            {latest && (
              <CardArticle
                card={latest}
                isNewest={true}
                pinnedIds={pinnedIds}
                setPinnedIds={setPinnedIds}
                dismissedIds={dismissedIds}
                setDismissedIds={setDismissedIds}
                expandedPassages={expandedPassages}
                togglePassage={togglePassage}
                expandedSources={expandedSources}
                toggleSources={toggleSources}
                expandedContexts={expandedContexts}
                toggleContext={toggleContext}
                copilotMode={copilotMode}
                webEnabled={webEnabled}
                onPin={onPin}
                onCancel={onCancel}
                onRetry={onRetry}
              />
            )}
          </div>
          {earlierCount > 0 && (
              <details className="lc-earlier lc-earlier--narrow" open={earlierOpen} onToggle={(e) => setEarlierOpen((e.target as HTMLDetailsElement).open)}>
                <summary onClick={(e) => { e.preventDefault(); setEarlierOpen((v) => !v); }}>Earlier answers ({earlierCount})</summary>
                {earlierOpen && (
                <div className="lc-earlier-body">
                  {earlier.map((card) => (
                    <CardArticle
                      key={`${card.session_id}-${card.id}`}
                      card={card}
                      isNewest={false}
                      pinnedIds={pinnedIds}
                      setPinnedIds={setPinnedIds}
                      dismissedIds={dismissedIds}
                      setDismissedIds={setDismissedIds}
                      expandedPassages={expandedPassages}
                      togglePassage={togglePassage}
                      expandedSources={expandedSources}
                      toggleSources={toggleSources}
                      expandedContexts={expandedContexts}
                      toggleContext={toggleContext}
                      copilotMode={copilotMode}
                      webEnabled={webEnabled}
                      onPin={onPin}
                      onCancel={onCancel}
                      onRetry={onRetry}
                    />
                  ))}
                </div>
                )}
              </details>
          )}
        </>
      )}
    </div>
  );
}
