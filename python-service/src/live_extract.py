"""Live extraction of decisions, actions, questions, and running summary for Live Copilot."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from .models import (
    LiveExtractModelOutput,
    LiveExtractModelOutputNoSummary,
    LiveExtractModelOutputWithSummary,
    LiveExtractRequest,
    LiveExtractResponse,
    LiveRetraction,
    LiveSummary,
    LiveTurn,
    LiveUpsert,
)
from .summarizer import COPILOT_NUM_CTX, OllamaSummarizer, normalize_model_output

logger = logging.getLogger(__name__)

LIVE_EXTRACT_SYSTEM_PROMPT = (
    "You maintain a live review board for a meeting from machine-transcribed turns. "
    "Output JSON only, matching the schema. Extract only what the turns support: "
    "a DECISION is something the speakers explicitly agreed or settled; "
    "an ACTION is a concrete commitment by someone to do something "
    '(owner "Me" if the Me speaker committed, "Them" if the other side did, or the name if spoken; '
    "due only if a time was spoken, as spoken); "
    "a QUESTION is a request for information or a decision that was raised and not answered in the turns. "
    "Every item cites the ids of the turns it comes from in evidence_turn_ids; "
    "never cite ids that are not in the input; never invent names, numbers or dates. "
    "Do not restate existing items; when an existing item's wording changed materially or its owner/due became known, "
    "return an upsert with that item's id.\n\n"
    "EXISTING ITEMS are kept meeting records. proposed means kept automatically; "
    "accepted means edited and locked by the user.\n\n"
    "Preserve existing items unless a NEW turn explicitly withdraws or replaces "
    "the identified item. Missing original evidence, silence, topic changes, "
    "completion, and answered questions are not withdrawals.\n\n"
    "Never update, retract, or supersede an accepted item.\n\n"
    "For each retraction, return the target id, evidence_turn_ids, reason_code "
    "(explicit_withdrawal or explicit_replacement), and withdrawal_quote. "
    "Copy withdrawal_quote exactly from a cited NEW turn. It must name the "
    "affected task or choice and explicitly cancel or replace it.\n\n"
    "Do not treat hypothetical, quoted-example, conditional, interrogative, "
    "or negated cancellation language as withdrawal. Bare \"never mind\" or "
    "\"actually not\" without a clear named target is insufficient. If unsure, "
    "return no retraction.\n\n"
    "For explicit_replacement, also return one new upsert with supersedes_id "
    "equal to the retracted id. Never use supersedes_id without that retraction. "
    "Do not disguise a reversal as a wording update.\n\n"
    "Original evidence may be outside this batch. That alone changes nothing. "
    "Return empty mutation lists when there is no supported change. "
    "Keep item text under 20 words, imperative for actions, declarative for decisions, a question sentence for questions. "
    "Do not extract pleasantries, narration about the tool, or hypotheticals. "
    "When update_summary is true, return summary with at most four bullets of at most 20 words each covering the whole conversation so far, "
    "citing turn ids; otherwise summary is null. Return empty lists when nothing qualifies. "
    'A first-person statement of intent or obligation by a speaker ("I will", "I need to", "I\'ll", "I have to", "we should") '
    "is an ACTION with that speaker as owner (Me for the Me speaker). "
    "A question the speaker asks the other side or the group, including a hypothetical design question, "
    "is a QUESTION unless it is answered in the same turns. "
    "Narration about the recording tool itself is not an item. "
    "When UPDATE_SUMMARY is true the summary object is required and must contain one to four bullets; never return null.\n\n"
    "EXAMPLE INPUT:\n"
    't1 Me: "I need to work on Tatweer OS and the ERDC project this week."\n'
    't2 Them: "Should we ship the diagram before Friday?"\n\n'
    "EXAMPLE OUTPUT JSON:\n"
    "{\n"
    '  "upserts": [\n'
    '    {"kind": "action", "text": "Work on Tatweer OS this week.", "owner": "Me", "due": "this week", "evidence_turn_ids": ["t1"]},\n'
    '    {"kind": "action", "text": "Work on the ERDC project this week.", "owner": "Me", "due": "this week", "evidence_turn_ids": ["t1"]},\n'
    '    {"kind": "question", "text": "Should we ship the diagram before Friday?", "evidence_turn_ids": ["t2"]}\n'
    "  ],\n"
    '  "retractions": [],\n'
    '  "summary": {"bullets": ["Me plans work on Tatweer OS and ERDC this week."], "evidence_turn_ids": ["t1"]}\n'
    "}\n\n"
    'A statement that settles a choice ("we go with X", "let\'s use X", "we\'re doing X", '
    '"we\'re not doing Y", "scrap Y") is a DECISION even without the word decide.\n'
    "Example: t3 Me: We go with Cytoscape for diagrams, not Mermaid, because it's already in the app. "
    '→ decision upsert {"kind": "decision", "text": "Use Cytoscape for diagrams instead of Mermaid.", '
    '"evidence_turn_ids": ["t3"]}'
)

MAX_USER_TEXT_CHARS = 24_000


def _normalize_text(s: str) -> str:
    """Lowercase alphanumerics-only representation of text for deduplication."""
    return "".join(c for c in s.lower() if c.isalnum())


def _normalize_ws(s: str) -> str:
    """Lowercase and collapse whitespace runs for quote substring matching."""
    return " ".join(s.lower().split())


def _format_turns(turns: list[LiveTurn]) -> str:
    if not turns:
        return "(none)"
    return "\n".join(
        f"{t.id} [{t.start_ms}-{t.end_ms}] {t.source}: {t.text}" for t in turns
    )


def build_user_text(req: LiveExtractRequest) -> tuple[str, list[str]]:
    """Build user prompt containing existing items, summary, flag, and turns capped at 24,000 characters.

    Returns the prompt text and the ids of the turns actually rendered (after capping).
    """
    # EXISTING ITEMS
    if req.items:
        item_lines = [
            f"{it.id} | {it.kind} | {it.status} | {it.owner if it.owner is not None else ''} | {it.due if it.due is not None else ''} | {','.join(it.evidence_turn_ids)} | {it.text}"
            for it in req.items
        ]
        items_part = "EXISTING ITEMS:\n" + "\n".join(item_lines)
    else:
        items_part = "EXISTING ITEMS:\n(none)"

    # CURRENT SUMMARY
    if req.summary and req.summary.bullets:
        summary_lines = [f"- {b}" for b in req.summary.bullets]
        summary_part = "CURRENT SUMMARY:\n" + "\n".join(summary_lines)
    else:
        summary_part = "CURRENT SUMMARY:\n(none)"

    # UPDATE_SUMMARY
    update_flag = "true" if req.update_summary else "false"
    update_part = f"UPDATE_SUMMARY: {update_flag}"

    prefix = f"{items_part}\n\n{summary_part}\n\n{update_part}\n\nTURNS:\n"

    if not req.turns:
        return f"{prefix}(none)", []

    # Format turn lines
    turn_lines = [
        f"{t.id} [{t.start_ms}-{t.end_ms}] {t.source}: {t.text}" for t in req.turns
    ]

    # Cap total at 24,000 characters by dropping the oldest turns first (never the items)
    start_idx = 0
    while start_idx < len(turn_lines):
        candidate_turns = "\n".join(turn_lines[start_idx:])
        candidate = prefix + candidate_turns
        if len(candidate) <= MAX_USER_TEXT_CHARS:
            return candidate, [t.id for t in req.turns[start_idx:]]
        start_idx += 1

    return prefix + "(none)", []


def _quote_matches_turn(
    quote: str, evidence_turn_ids: list[str], turn_texts: dict[str, str]
) -> bool:
    """True when the (whitespace-normalised, case-folded) quote is an exact substring of a cited turn's text."""
    normalized_quote = _normalize_ws(quote)
    if not normalized_quote:
        return False
    for tid in evidence_turn_ids:
        text = turn_texts.get(tid)
        if text is None:
            continue
        if normalized_quote in _normalize_ws(text):
            return True
    return False


def validate_output(
    raw: LiveExtractModelOutput,
    req: LiveExtractRequest,
    rendered_turn_ids: list[str] | None = None,
) -> tuple[list[LiveUpsert], list[LiveRetraction], LiveSummary | None]:
    """Validate and filter raw model output against the request's context."""
    if rendered_turn_ids is None:
        rendered_turn_ids = [t.id for t in req.turns]
    valid_turn_ids = set(rendered_turn_ids)
    new_turn_ids = set(req.new_turn_ids)
    existing_item_ids = {it.id for it in req.items}
    turn_texts = {t.id: t.text for t in req.turns if t.id in valid_turn_ids}
    existing_norm_texts = {
        _normalize_text(it.text)
        for it in req.items
        if it.status in ("proposed", "accepted")
    }

    validated_upserts: list[LiveUpsert] = []
    for raw_u in raw.upserts:
        # Drop upserts whose evidence_turn_ids is empty or contains an id not in the rendered batch
        if not raw_u.evidence_turn_ids:
            continue
        if any(tid not in valid_turn_ids for tid in raw_u.evidence_turn_ids):
            continue

        # Drop upserts with blank text or text over 240 characters
        trimmed_text = raw_u.text.strip()
        if not trimmed_text or len(trimmed_text) > 240:
            continue

        u = raw_u.model_copy(update={"text": trimmed_text})

        # Drop upserts whose id is set but not in req.items (treat as new: set id None)
        if u.id is not None and u.id not in existing_item_ids:
            u = u.model_copy(update={"id": None})

        # Drop supersedes_id not in req.items
        if u.supersedes_id is not None and u.supersedes_id not in existing_item_ids:
            u = u.model_copy(update={"supersedes_id": None})

        # Dedupe new upserts against existing items by normalized text (lowercase, alphanumerics only):
        # drop a new upsert whose normalized text equals an existing proposed/accepted item's.
        if u.id is None:
            norm = _normalize_text(u.text)
            if not norm or norm in existing_norm_texts:
                continue
            existing_norm_texts.add(norm)

        validated_upserts.append(u)

    superseded_targets = {
        u.supersedes_id for u in validated_upserts if u.supersedes_id is not None
    }

    validated_retractions: list[LiveRetraction] = []
    for raw_r in raw.retractions:
        # Drop retractions whose id is not in req.items
        if raw_r.id not in existing_item_ids:
            continue
        # Drop if evidence is empty or any evidence turn id is unknown to the rendered batch
        if not raw_r.evidence_turn_ids:
            continue
        if any(tid not in valid_turn_ids for tid in raw_r.evidence_turn_ids):
            continue
        # Require at least one evidence id among the newly uncovered turns
        if not any(tid in new_turn_ids for tid in raw_r.evidence_turn_ids):
            continue
        # withdrawal_quote must be an exact (whitespace-normalised, case-insensitive) substring of a cited turn
        if not _quote_matches_turn(
            raw_r.withdrawal_quote, raw_r.evidence_turn_ids, turn_texts
        ):
            continue
        # explicit_replacement requires a matching supersedes_id upsert in the same response
        if raw_r.reason_code == "explicit_replacement" and raw_r.id not in superseded_targets:
            continue
        validated_retractions.append(raw_r)

    kept_replacement_ids = {
        r.id for r in validated_retractions if r.reason_code == "explicit_replacement"
    }
    final_upserts: list[LiveUpsert] = []
    for u in validated_upserts:
        # A bare supersedes_id never changes any status: unpaired replacement upserts become ordinary new items.
        if u.supersedes_id is not None and u.supersedes_id not in kept_replacement_ids:
            u = u.model_copy(update={"supersedes_id": None})
        final_upserts.append(u)

    validated_summary: LiveSummary | None = None
    raw_summary = getattr(raw, "summary", None)
    # If req.update_summary is false force summary None
    if req.update_summary and raw_summary is not None:
        # Drop the summary if any evidence id is unknown
        if any(tid not in valid_turn_ids for tid in raw_summary.evidence_turn_ids):
            validated_summary = None
        else:
            # Keep at most 4 bullets, each trimmed, drop empty ones
            bullets = [b.strip() for b in raw_summary.bullets if b.strip()]
            bullets = bullets[:4]
            if bullets:
                validated_summary = LiveSummary(
                    bullets=bullets,
                    evidence_turn_ids=raw_summary.evidence_turn_ids,
                )
            else:
                validated_summary = None

    return final_upserts, validated_retractions, validated_summary


class _OptionsProxyClient:
    """Proxy around Ollama Client to ensure temperature=0.0 and num_predict=768."""

    def __init__(self, target: Any) -> None:
        self._target = target

    def chat(self, **kwargs: Any) -> Any:
        options = dict(kwargs.get("options") or {})
        options["temperature"] = 0.0
        options["num_predict"] = 768
        kwargs["options"] = options
        return self._target.chat(**kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target, name)


def extract(
    req: LiveExtractRequest,
    summarizer: Any,
    client: Any,
) -> LiveExtractResponse:
    """Execute live item extraction against Ollama and validate output."""
    start_time = time.monotonic()
    through_ms = max((t.end_ms for t in req.turns), default=None)

    # Empty turns require no LLM call
    if not req.turns:
        return LiveExtractResponse(
            request_id=req.request_id,
            session_id=req.session_id,
            base_revision=req.base_revision,
            status="ok",
            reason=None,
            through_ms=None,
            upserts=[],
            retractions=[],
            summary=None,
        )

    try:
        user_text, rendered_turn_ids = build_user_text(req)
        messages = [
            {"role": "system", "content": LIVE_EXTRACT_SYSTEM_PROMPT},
            {"role": "user", "content": user_text},
        ]
        if req.update_summary:
            model_cls: type[LiveExtractModelOutput] = LiveExtractModelOutputWithSummary
        else:
            model_cls = LiveExtractModelOutputNoSummary
        json_schema = model_cls.model_json_schema()

        wrapped_client = _OptionsProxyClient(client) if client is not None else None
        if summarizer is None:
            raise ValueError("Summarizer not initialized")

        response = summarizer._chat_ollama_once(
            messages=messages,
            model=req.model,
            json_schema=json_schema,
            num_ctx=COPILOT_NUM_CTX,
            client=wrapped_client,
        )

        data: dict[str, Any] | None = None
        raw_content = ""
        if isinstance(response, dict):
            if "message" in response and isinstance(response["message"], dict):
                raw_content = response["message"].get("content", "")
            elif "message" in response and hasattr(response["message"], "content"):
                raw_content = getattr(response["message"], "content", "")
            elif "upserts" in response:
                data = response
            else:
                raw_content = str(response)
        elif hasattr(response, "message"):
            msg = response.message
            raw_content = getattr(msg, "content", str(msg))
        elif isinstance(response, str):
            raw_content = response
        else:
            raw_content = str(response)

        if data is None:
            normalized = normalize_model_output(raw_content)
            loads_fn = getattr(summarizer, "_loads_lenient", None)
            if loads_fn is not None:
                try:
                    data = loads_fn(normalized)
                except Exception:
                    data = None
            if not isinstance(data, dict):
                data = OllamaSummarizer._loads_lenient(normalized)
            if not isinstance(data, dict):
                try:
                    data = json.loads(normalized)
                except Exception:
                    data = None

        if not isinstance(data, dict):
            raise ValueError(f"Model output was not valid JSON: {raw_content[:200]}")

        raw_output = model_cls.model_validate(data)
        upserts, retractions, summary = validate_output(raw_output, req, rendered_turn_ids)
        if not req.update_summary:
            summary = None

        elapsed_ms = int((time.monotonic() - start_time) * 1000)
        logger.info(
            "live_extract completed in %d ms (upserts=%d retractions=%d summary=%s)",
            elapsed_ms,
            len(upserts),
            len(retractions),
            "yes" if summary is not None else "no",
        )

        return LiveExtractResponse(
            request_id=req.request_id,
            session_id=req.session_id,
            base_revision=req.base_revision,
            status="ok",
            reason=None,
            through_ms=through_ms,
            upserts=upserts,
            retractions=retractions,
            summary=summary,
        )
    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start_time) * 1000)
        logger.warning("live_extract failed in %d ms: %s", elapsed_ms, exc)
        return LiveExtractResponse(
            request_id=req.request_id,
            session_id=req.session_id,
            base_revision=req.base_revision,
            status="error",
            reason=str(exc)[:200],
            through_ms=None,
            upserts=[],
            retractions=[],
            summary=None,
        )
