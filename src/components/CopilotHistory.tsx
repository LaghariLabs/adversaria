import { useEffect, useState } from "react";
import "../styles/copilot-history.css";
import { copilotCardReview, getCopilotHistory } from "../lib/tauri";
import { renderInlineBold } from "../lib/inlineBold";
import type { CopilotHistoryCard, LiveItem } from "../types";

interface CopilotHistoryProps {
  meetingId: number;
}

type Filter = "all" | "answers" | "pinned" | "not_answered" | "dismissed" | "decisions_actions";

export function splitHeadline(say: string[]): { headline: string; rest: string } {
  const joined = say.join(" ");
  if (!joined.trim()) return { headline: "", rest: "" };
  const sentences = joined.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  const headline = sentences[0] ?? "";
  const rest = sentences.slice(1).join(" ");
  return { headline, rest };
}

function formatHHMM(at: string): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return at;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatMMSS(atMs: number): string {
  const totalSec = Math.floor(atMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function liveKindLabel(kind: LiveItem["kind"]): string {
  if (kind === "decision") return "Decision";
  if (kind === "action") return "Action";
  return "Open question";
}

function liveMetaText(item: LiveItem): string {
  if (item.status === "accepted") {
    const ev = [...item.review_events].reverse().find((e) => (e.action as string) === "edit" || e.action === "edit_accept" || e.action === "accept");
    if (ev) return `Edited at ${formatHHMM(ev.at)}`;
    return "Edited";
  }
  if (item.status === "dismissed") {
    const ev = [...item.review_events].reverse().find((e) => (e.action as string) === "delete" || e.action === "dismiss");
    if (ev) return `Deleted at ${formatHHMM(ev.at)}`;
    return "Deleted";
  }
  if (item.status === "retracted") {
    return "Withdrawn";
  }
  return "Kept";
}

export function CopilotHistory({ meetingId }: CopilotHistoryProps): JSX.Element {
  const [cards, setCards] = useState<CopilotHistoryCard[]>([]);
  const [liveItems, setLiveItems] = useState<LiveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [pendingRows, setPendingRows] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCopilotHistory(meetingId)
      .then((res) => {
        if (cancelled) return;
        setCards(Array.isArray(res.cards) ? res.cards : []);
        const raw = (res as { live_items?: LiveItem[] }).live_items;
        if (Array.isArray(raw)) {
          setLiveItems(raw);
        } else {
          setLiveItems([]);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  if (loading) {
    return (
      <section className="ch-frame">
        <div className="ch-head">
          <p className="ch-loading">Loading Copilot history…</p>
        </div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="ch-frame">
        <div className="ch-head">
          <p className="ch-error">Could not load Copilot history: {error}</p>
        </div>
      </section>
    );
  }
  if (cards.length === 0 && liveItems.length === 0) {
    return <section className="ch-empty">No Copilot suggestions were saved for this meeting.</section>;
  }

  function isDismissed(c: CopilotHistoryCard): boolean {
    return c.dismissed_at != null;
  }

  let filtered: CopilotHistoryCard[];
  switch (filter) {
    case "answers":
      filtered = cards.filter((c) => c.status === "done" && !isDismissed(c));
      break;
    case "pinned":
      filtered = cards.filter((c) => c.pinned_at != null && !isDismissed(c));
      break;
    case "not_answered":
      filtered = cards.filter((c) => (c.status === "heard" || c.status === "error" || c.status === "cancelled") && !isDismissed(c));
      break;
    case "dismissed":
      filtered = cards.filter((c) => isDismissed(c));
      break;
    case "decisions_actions":
      filtered = [];
      break;
    case "all":
    default:
      filtered = cards.filter((c) => !isDismissed(c));
      break;
  }

  let filteredLive: LiveItem[];
  switch (filter) {
    case "answers":
    case "pinned":
      filteredLive = [];
      break;
    case "not_answered":
      filteredLive = [];
      break;
    case "dismissed":
      filteredLive = liveItems.filter((it) => it.status === "dismissed");
      break;
    case "decisions_actions":
    case "all":
    default:
      filteredLive = liveItems;
      break;
  }

  const sessionOrder: string[] = [];
  const seen = new Set<string>();
  for (const c of filtered) {
    if (!seen.has(c.session_id)) {
      seen.add(c.session_id);
      sessionOrder.push(c.session_id);
    }
  }
  const sessionIndexMap = new Map<string, number>();
  sessionOrder.forEach((sid, idx) => sessionIndexMap.set(sid, idx + 1));

  const retryMap = new Map<string, boolean>();
  for (const c of cards) {
    if (c.retry_of != null) {
      const key = `${c.session_id}-${c.retry_of}`;
      retryMap.set(key, true);
    }
  }

  function handleReview(card: CopilotHistoryCard, action: "pin" | "unpin" | "dismiss" | "restore"): void {
    const key = `${card.session_id}-${card.card_id}`;
    setPendingRows((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    copilotCardReview(card.session_id, card.card_id, action)
      .then((res) => {
        setCards((prev) => prev.map((c) => (c.session_id === card.session_id && c.card_id === card.card_id ? { ...c, pinned_at: res.pinned_at, dismissed_at: res.dismissed_at } : c)));
      })
      .catch(() => {})
      .finally(() => {
        setPendingRows((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      });
  }

  const liveCount = liveItems.length;
  const subline = `All sessions · Oldest first · ${cards.length} cards${liveCount > 0 ? ` · ${liveCount} live items` : ""}`;

  return (
    <section className="ch-frame">
      <div className="ch-head">
        <h3 className="ch-head-title">AI suggestions and your review</h3>
        <p className="ch-head-sub">{subline}</p>
        <div className="ch-filters" role="group">
          <button className="ch-filter" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All
          </button>
          <button className="ch-filter" aria-pressed={filter === "answers"} onClick={() => setFilter("answers")}>
            Answers
          </button>
          <button className="ch-filter" aria-pressed={filter === "pinned"} onClick={() => setFilter("pinned")}>
            Pinned
          </button>
          <button className="ch-filter" aria-pressed={filter === "not_answered"} onClick={() => setFilter("not_answered")}>
            Not answered
          </button>
          <button className="ch-filter" aria-pressed={filter === "dismissed"} onClick={() => setFilter("dismissed")}>
            Dismissed
          </button>
          <button className="ch-filter" aria-pressed={filter === "decisions_actions"} onClick={() => setFilter("decisions_actions")}>
            Decisions &amp; actions
          </button>
        </div>
      </div>
      {filtered.length === 0 && filteredLive.length === 0 ? (
        <div className="ch-empty">Nothing matches this filter.</div>
      ) : (
        <>
          {sessionOrder.map((sid) => {
            const idx = sessionIndexMap.get(sid) ?? 0;
            const groupCards = filtered.filter((c) => c.session_id === sid);
            return (
              <div key={sid} className="ch-session">
                <p className="ch-session-label">Session {idx}</p>
                {groupCards.map((card) => {
                  const rowKey = `${card.session_id}-${card.card_id}`;
                  const isPending = pendingRows.has(rowKey);
                  const hasRetried = retryMap.has(`${card.session_id}-${card.card_id}`);
                  const retryTarget = cards.find((c) => c.session_id === card.session_id && c.retry_of === card.card_id);
                  const isDone = card.status === "done";
                  const notesLen = card.sections?.notes?.length ?? 0;
                  const showTrust = isDone && card.sections != null && (notesLen > 0 || card.provider === "local" || card.provider === "claude" || card.provider === "deepseek");
                  const trustTone = notesLen > 0 ? "supported" : "unverified";
                  const trustLabel = notesLen > 0 ? `From your notes \u00b7 ${notesLen} passage${notesLen === 1 ? "" : "s"}` : "Model knowledge \u00b7 Unverified";
                  const dismissed = isDismissed(card);
                  return (
                    <article key={rowKey} id={`copilot-card-${card.session_id}-${card.card_id}`} className="ch-entry" data-status={card.status}>
                      <p className="ch-entry-q">
                        {formatHHMM(card.at)} · {card.question}
                      </p>
                      {isDone ? (
                        <>
                          {card.sections ? (
                            <>
                              {(() => {
                                const lead = (card.sections.say ?? []).join(" ").trim();
                                return (
                                  <p className="ch-headline" dir="auto">
                                    {lead}
                                  </p>
                                );
                              })()}
                              {card.sections.specifics.length > 0 && card.answer_shape === "steps" ? (
                                <ol className="ch-steps">
                                  {card.sections.specifics.map((spec, sIdx) => (
                                    <li key={sIdx} dir="auto">
                                      {renderInlineBold(spec)}
                                    </li>
                                  ))}
                                </ol>
                              ) : card.sections.specifics.length > 0 ? (
                                <ul className="ch-bullets">
                                  {card.sections.specifics.map((spec, sIdx) => (
                                    <li key={sIdx} dir="auto">
                                      {renderInlineBold(spec)}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                              {showTrust && (
                                <p className={`ch-trust ch-trust--${trustTone}`}>
                                  <span className="ch-trust-dot" aria-hidden="true" />
                                  {trustLabel}
                                </p>
                              )}
                            </>
                          ) : card.provenance.length > 0 ? (
                            <></>
                          ) : null}
                          {hasRetried && retryTarget && (
                            <button
                              className="ch-link-btn"
                              onClick={() => document.getElementById(`copilot-card-${retryTarget.session_id}-${retryTarget.card_id}`)?.scrollIntoView()}
                            >
                              Retried at {formatHHMM(retryTarget.at)} → View replacement answer
                            </button>
                          )}
                          <div className="ch-meta">
                            <div className="ch-meta-left">
                              {card.passages.length > 0 && (
                                <details className="ch-disclosure">
                                  <summary className="ch-link-btn">› Passages and citations</summary>
                                  <ul>
                                    {card.passages.map((p, pIdx) => (
                                      <li key={pIdx}>
                                        <span>{p.title}</span> <span>{p.source_kind}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                              {card.resolved_question && card.resolved_question !== card.question && (
                                <details className="ch-disclosure">
                                  <summary className="ch-link-btn">› Resolved question</summary>
                                  <p>{card.resolved_question}</p>
                                </details>
                              )}
                              {!card.sections && card.provenance.length > 0 && (
                                <details className="ch-disclosure">
                                  <summary className="ch-link-btn">› Full original answer</summary>
                                  <ul>
                                    {card.provenance.map((b, bIdx) => (
                                      <li key={bIdx}>{b.text}</li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                            </div>
                            <div className="ch-meta-right">
                              {dismissed ? (
                                <>
                                  <span>Dismissed at {formatHHMM(card.dismissed_at as string)}</span>
                                  <button className="ch-link-btn" disabled={isPending} onClick={() => handleReview(card, "restore")}>
                                    Restore
                                  </button>
                                </>
                              ) : (
                                <>
                                  {card.pinned_at ? (
                                    <>
                                      <span>Pinned at {formatHHMM(card.pinned_at)}</span>
                                      <button className="ch-link-btn" disabled={isPending} onClick={() => handleReview(card, "unpin")}>
                                        Unpin
                                      </button>
                                    </>
                                  ) : (
                                    <button className="ch-link-btn" disabled={isPending} onClick={() => handleReview(card, "pin")}>
                                      Pin
                                    </button>
                                  )}
                                  <button className="ch-link-btn" disabled={isPending} onClick={() => handleReview(card, "dismiss")}>
                                    Dismiss
                                  </button>
                                </>
                              )}
                              {(card.pinned_at || card.dismissed_at) && (
                                <details className="ch-activity">
                                  <summary className="ch-link-btn">› Activity</summary>
                                  <ul className="ch-activity-list">
                                    {card.pinned_at && <li>Pinned at {formatHHMM(card.pinned_at)}</li>}
                                    {card.dismissed_at && <li>Dismissed at {formatHHMM(card.dismissed_at)}</li>}
                                  </ul>
                                </details>
                              )}
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          {card.status === "heard" && <p className="ch-state">Heard, no answer was generated</p>}
                          {card.status === "error" && <p className="ch-state">Answer interrupted{card.error ? `: ${card.error}` : ""}</p>}
                          {card.status === "cancelled" && <p className="ch-state">Cancelled{card.reason ? ` \u00b7 ${card.reason}` : ""}</p>}
                          {hasRetried && retryTarget && (
                            <button
                              className="ch-link-btn"
                              onClick={() => document.getElementById(`copilot-card-${retryTarget.session_id}-${retryTarget.card_id}`)?.scrollIntoView()}
                            >
                              Retried at {formatHHMM(retryTarget.at)} → View replacement answer
                            </button>
                          )}
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            );
          })}
          {filteredLive.length > 0 && (
            <div className="ch-session ch-session--live">
              <p className="ch-session-label">Live review</p>
              {filteredLive.map((item) => {
                const edited = item.text !== item.original_text;
                const ownerDueParts: string[] = [];
                if (item.kind === "action") {
                  if (item.owner) ownerDueParts.push(`Owner: ${item.owner}`);
                  if (item.due) ownerDueParts.push(`Due: ${item.due}`);
                }
                return (
                  <article key={item.id} className="ch-entry ch-entry--live">
                    <p className="ch-kind">
                      {formatMMSS(item.at_ms)} · {liveKindLabel(item.kind)}
                    </p>
                    <p className="ch-headline" dir="auto">
                      {item.text}
                    </p>
                    {edited && (
                      <div className="ch-live-edited">
                        <span className="ch-tag">edited</span>
                        <details className="ch-disclosure">
                          <summary className="ch-link-btn">› Original suggestion</summary>
                          <p>{item.original_text}</p>
                        </details>
                      </div>
                    )}
                    {ownerDueParts.length > 0 && <p className="ch-live-owner-due">{ownerDueParts.join(" · ")}</p>}
                    {item.status === "retracted" && item.withdrawal_quote ? (
                      <p className="ch-live-withdrawn" dir="auto">"{item.withdrawal_quote}"</p>
                    ) : null}
                    <div className="ch-meta">
                      <span>{liveMetaText(item)}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default CopilotHistory;
