"""Deterministic guard: no SPECIFIC/NEXT after a pure not-familiar SAY.

Covers the parser-level suppression for pure unrecognised-name SAY turns
and the clarification-request answer path (cap 0 + NEXT suppressed).
"""

from __future__ import annotations

from typing import Any

from src.copilot_answer import (
    SectionStreamParser,
    _is_clarification_request,
    _parser_for,
    build_user_text,
)
from src.models import CopilotAnswerRequest, RecentCard


def _feed_all(parser: SectionStreamParser, text: str) -> list[dict[str, Any]]:
    frames = parser.feed(text)
    frames.extend(parser.flush())
    return frames


def _by_sec(
    frames: list[dict[str, Any]], sec: str
) -> list[dict[str, Any]]:
    return [f for f in frames if f.get("sec") == sec and not f.get("drop")]


def test_pure_not_familiar_suppresses_specific_and_next() -> None:
    parser = SectionStreamParser()
    frames = _feed_all(
        parser,
        "SAY: I'm not familiar with Zorblax 9; which product do you mean?\n"
        "SPECIFIC: **Zorblax**: a family.\n"
        "NEXT: What is it?\n",
    )
    say = _by_sec(frames, "say")
    assert len(say) == 1
    assert say[0]["t"] == (
        "I'm not familiar with Zorblax 9; which product do you mean?"
    )
    assert _by_sec(frames, "specific") == []
    assert _by_sec(frames, "next") == []


def test_pure_not_familiar_long_form_suppressed() -> None:
    parser = SectionStreamParser()
    frames = _feed_all(
        parser,
        "SAY: I am not familiar with Zorblax 9; which product do you mean?\n"
        "SPECIFIC: **Zorblax**: a family.\n"
        "NEXT: What is it?\n",
    )
    assert len(_by_sec(frames, "say")) == 1
    assert _by_sec(frames, "specific") == []
    assert _by_sec(frames, "next") == []


def test_mixed_say_keeps_specific() -> None:
    parser = SectionStreamParser()
    frames = _feed_all(
        parser,
        "SAY: I'm not familiar with Zorblax 9; which product do you mean? "
        "An API is a set of rules that lets programs talk.\n"
        "SPECIFIC: **REST**: common style.\n",
    )
    say = _by_sec(frames, "say")
    assert len(say) == 2
    specific = _by_sec(frames, "specific")
    assert len(specific) == 1
    assert specific[0]["t"] == "**REST**: common style."


def test_normal_answer_keeps_specific_and_next() -> None:
    parser = SectionStreamParser()
    frames = _feed_all(
        parser,
        "SAY: A vector database stores embeddings.\n"
        "SPECIFIC: **HNSW**: fast index.\n"
        "NEXT: How is it tuned?\n",
    )
    assert len(_by_sec(frames, "say")) == 1
    assert len(_by_sec(frames, "specific")) == 1
    assert len(_by_sec(frames, "next")) == 1


def test_pure_not_familiar_keeps_notes() -> None:
    parser = SectionStreamParser()
    frames = _feed_all(
        parser,
        "SAY: I'm not familiar with Zorblax 9; which product do you mean?\n"
        'NOTES: P1 | "Zorblax runs it." | adds context\n',
    )
    assert len(_by_sec(frames, "say")) == 1
    notes = _by_sec(frames, "notes")
    assert len(notes) == 1
    assert "P1" in "".join(f["t"] for f in notes)


def test_is_clarification_request() -> None:
    def req_for(question: str) -> CopilotAnswerRequest:
        return CopilotAnswerRequest(provider="local", question=question)

    assert _is_clarification_request(req_for("What do you mean?")) is True
    assert _is_clarification_request(req_for("what do you mean by that")) is True
    assert _is_clarification_request(req_for("Could you clarify?")) is True
    assert _is_clarification_request(req_for("What do you mean by RAG?")) is False
    assert (
        _is_clarification_request(req_for("Can you clarify the pricing model?"))
        is False
    )


def test_parser_for_clarification_suppresses_specific_and_next() -> None:
    req = CopilotAnswerRequest(provider="local", question="What do you mean?")
    parser = _parser_for(req)
    assert parser._max_specifics == 0
    assert parser._suppress_next is True
    frames = _feed_all(
        parser,
        "SAY: Let me restate that simply.\n"
        "SPECIFIC: **Detail**: extra info.\n"
        "NEXT: What is it?\n",
    )
    assert len(_by_sec(frames, "say")) == 1
    assert _by_sec(frames, "specific") == []
    assert _by_sec(frames, "next") == []


def test_parser_for_normal_request_unchanged() -> None:
    req = CopilotAnswerRequest(provider="local", question="How does it work?")
    parser = _parser_for(req)
    assert parser._max_specifics == 5
    assert parser._suppress_next is False


_FIRST_SAY = "I would cache frequent answers and cap the output length."
_LAST_SAY = (
    "I would compare retrieved documents with relevant examples "
    "and measure response time under load."
)


def _clarification_req_with_cards() -> CopilotAnswerRequest:
    return CopilotAnswerRequest(
        provider="local",
        question="What do you mean?",
        recent_cards=[
            RecentCard(
                card_ref="fixture:1",
                question="How would you cut LLM latency?",
                say=_FIRST_SAY,
            ),
            RecentCard(
                card_ref="fixture:2",
                question="How would you check retrieval accuracy and response speed?",
                say=_LAST_SAY,
            ),
        ],
    )


def test_clarification_renders_restate_of_last_card() -> None:
    text = build_user_text(_clarification_req_with_cards())
    assert (
        'Restate your previous answer more simply, in one or two plain sentences: '
        f'"{_LAST_SAY}"'
    ) in text
    assert _FIRST_SAY not in text


def test_clarification_without_cards_leaves_question_unchanged() -> None:
    req = CopilotAnswerRequest(provider="local", question="What do you mean?")
    text = build_user_text(req)
    assert "QUESTION (Them):\nWhat do you mean?" in text
    assert "Restate your previous answer more simply" not in text


def test_normal_question_with_cards_leaves_question_unchanged() -> None:
    req = _clarification_req_with_cards().model_copy(
        update={"question": "How does retrieval work?"}
    )
    text = build_user_text(req)
    assert "QUESTION (Them):\nHow does retrieval work?" in text
    assert "Restate your previous answer more simply" not in text
