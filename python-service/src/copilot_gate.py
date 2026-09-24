"""Stage 2 local gate for Live Copilot: classify ambiguous candidate turns."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from .models import GateModelOutput, GateRequest, GateResponse
from .summarizer import COPILOT_NUM_CTX, OllamaSummarizer, normalize_model_output

logger = logging.getLogger(__name__)

GATE_SYSTEM_PROMPT = (
    "You decide whether a meeting copilot should answer a candidate utterance. "
    "Answer only when the candidate is a real, unresolved request for information or a decision, "
    "addressed to the other side, the group, or the copilot. "
    "Ignore narration about the tool or the meeting, quoted examples, rhetorical questions, "
    "requests the speaker answers themselves in the same turn, and repeats of recent_questions. "
    "A question the speaker asks at the end of their own turn is a real request even when "
    "it is introduced by \"for example\", \"let's say\" or \"so\", and even when the rest of "
    "the turn is narration; in self_ask mode treat it as addressed to the copilot. "
    "Only treat a question as a quoted example when the turn goes on to answer it or "
    "to talk about it as an example. "
    "Always fill resolved_question first with every unresolved question or request "
    "in the candidate, in the order asked. Preserve the setup needed to answer them "
    "and every entity, negation and constraint. Resolve pronouns only when "
    "context_turns makes the antecedent clear; never add facts. Do not select just "
    "the first or last question. Remove only requests that are clearly quoted, "
    "already answered or already addressed. Answer when at least one unresolved "
    "request remains; ignore only when none remain. When ignoring, faithfully "
    "describe the candidate request you are declining. Keep resolved_question within "
    "2000 characters without dropping a request. reason_code must name the actual "
    "reason; use unclear only when no other code fits. "
    "Output JSON only."
    "\nExamples (candidate -> output):\n"
    'Candidate: "What is Kafka? Some background first. Who maintains it today?"\n'
    '{"resolved_question": "What is Kafka? Who maintains Kafka today?", "action": "answer", "reason_code": "direct_question"}\n'
    'Candidate: "How much would the data migration cost, what would you do about downtime, and who should lead it?"\n'
    '{"resolved_question": "How much would the data migration cost, what would you do about downtime, and who should lead the migration?", "action": "answer", "reason_code": "direct_question"}\n'
    'Candidate: "Where is the demo hosted? On Vercel. And who pays for the hosting?"\n'
    '{"resolved_question": "Who pays for the demo hosting?", "action": "answer", "reason_code": "answered_in_turn"}\n'
    'Candidate: "For example, a customer might ask whether we support dark mode? That comes up every week and the answer is in the FAQ. What is our launch date?"\n'
    '{"resolved_question": "What is our launch date?", "action": "answer", "reason_code": "embedded_question"}\n'
)


class _OptionsProxyClient:
    """Proxy around Ollama Client to ensure temperature=0.0 and num_predict=400."""

    def __init__(self, target: Any) -> None:
        self._target = target

    def chat(self, **kwargs: Any) -> Any:
        options = dict(kwargs.get("options") or {})
        options["temperature"] = 0.0
        options["num_predict"] = 400
        kwargs["options"] = options
        kwargs["think"] = False
        return self._target.chat(**kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target, name)


def fallback_response() -> GateResponse:
    """Backend-failure outcome: the gate backend failed, not a model decision.

    Returned (HTTP 200) for every failure path — model exception,
    malformed/unparseable output, uninitialised summarizer — so the desktop
    app can tell a backend failure apart from the model genuinely saying
    "ignore". `unclear` stays a legitimate model reason code and is passed
    through untouched when the model itself emits it.
    """
    return GateResponse(
        action="ignore",
        resolved_question=None,
        reason_code="backend_error",
    )


def _is_valid_resolved_question(resolved: str) -> bool:
    """A resolved question is non-blank, at most 2000 chars, with one alnum."""
    return (
        bool(resolved)
        and len(resolved) <= 2000
        and any(char.isalnum() for char in resolved)
    )


def _salvage_question(candidate: str) -> str:
    """Return the whole candidate, whitespace-normalised, bounded to 2000 chars."""
    resolved = " ".join(candidate.split())
    if len(resolved) > 2000:
        cut = resolved[:2000]
        boundary = cut.rfind(" ")
        resolved = cut[:boundary] if boundary != -1 else cut
    return resolved


def build_user_text(req: GateRequest) -> str:
    """Build user prompt containing sections MODE, SPEAKER, RECENT QUESTIONS, CONTEXT TURNS, CANDIDATE."""
    blocks = [
        f"MODE:\n{req.mode}",
        f"SPEAKER:\n{req.speaker}",
    ]
    if req.recent_questions:
        recent = "\n".join(f"- {q}" for q in req.recent_questions)
        blocks.append(f"RECENT QUESTIONS:\n{recent}")
    else:
        blocks.append("RECENT QUESTIONS:\n(none)")

    if req.context_turns:
        turns = "\n".join(req.context_turns)
        blocks.append(f"CONTEXT TURNS:\n{turns}")
    else:
        blocks.append("CONTEXT TURNS:\n(none)")

    blocks.append(f"CANDIDATE:\n{req.candidate}")
    return "\n\n".join(blocks)


def decide(
    req: GateRequest,
    summarizer: Any,
    client: Any,
) -> GateResponse:
    """Execute gate classification against Ollama and validate output."""
    start_time = time.monotonic()
    raw_content: str | None = None
    try:
        if summarizer is None:
            raise ValueError("Summarizer not initialized")

        user_text = build_user_text(req)
        messages = [
            {"role": "system", "content": GATE_SYSTEM_PROMPT},
            {"role": "user", "content": user_text},
        ]
        json_schema = GateModelOutput.model_json_schema()

        wrapped_client = _OptionsProxyClient(client) if client is not None else None

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
            elif "action" in response:
                data = response
                raw_content = json.dumps(response, ensure_ascii=False, default=str)
            else:
                raw_content = str(response)
        elif hasattr(response, "message"):
            msg = response.message
            raw_content = getattr(msg, "content", str(msg))
        elif isinstance(response, str):
            raw_content = response
        else:
            raw_content = str(response)

        raw_content = str(raw_content)
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

        # Validate the decision independently: a bad rewrite must not reverse it.
        decision = GateResponse(action=data["action"], reason_code=data["reason_code"])
        action = decision.action
        reason_code = decision.reason_code
        if action == "ignore":
            resolved_question = None
        else:
            resolved = data.get("resolved_question")
            resolved_question = resolved.strip() if isinstance(resolved, str) else ""
            if not _is_valid_resolved_question(resolved_question):
                logger.warning(
                    "copilot gate invalid resolved_question; salvaging candidate; "
                    "raw model content=%s",
                    raw_content[:300],
                )
                resolved_question = _salvage_question(req.candidate)
                if not _is_valid_resolved_question(resolved_question):
                    logger.warning(
                        "copilot gate salvage invalid; returning backend_error; "
                        "raw model content=%s",
                        raw_content[:300],
                    )
                    return fallback_response()

        resp = GateResponse(
            action=action,
            resolved_question=resolved_question,
            reason_code=reason_code,
        )
        elapsed_ms = int((time.monotonic() - start_time) * 1000)
        logger.info(
            "copilot gate decided action=%s reason_code=%s in %d ms",
            resp.action,
            resp.reason_code,
            elapsed_ms,
        )
        return resp
    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start_time) * 1000)
        if raw_content is not None:
            logger.warning(
                "copilot gate invalid model output; raw model content=%s",
                str(raw_content)[:300],
            )
        logger.warning(
            "copilot gate failed in %d ms (%s: %s), returning backend_error",
            elapsed_ms,
            type(exc).__name__,
            exc,
        )
        fallback = fallback_response()
        logger.info(
            "copilot gate decided action=%s reason_code=%s in %d ms",
            fallback.action,
            fallback.reason_code,
            elapsed_ms,
        )
        return fallback
