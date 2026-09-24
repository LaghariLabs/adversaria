"""Tests for Task P2: definitive lead line and recent-card points memory."""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from src.copilot_answer import (
    BRIEF_SHAPE_BLOCK,
    COPILOT_SYSTEM_PROMPT,
    _BRIEF_SAY_NOTE,
    _format_recent_cards_json,
    _prepare_recent_cards_block,
    build_user_text,
    system_prompt_for,
)
from src.models import CopilotAnswerRequest, RecentCard


def test_brief_shape_and_say_note_in_prompt() -> None:
    assert BRIEF_SHAPE_BLOCK in COPILOT_SYSTEM_PROMPT
    assert _BRIEF_SAY_NOTE in COPILOT_SYSTEM_PROMPT
    brief = system_prompt_for("brief")
    assert "X is a [category] that [its defining mechanism or purpose]" in brief
    assert "never start a sentence with It" in brief
    assert "at most 30 words" in brief
    assert "at most 24 words" in brief
    steps = system_prompt_for("steps")
    for snippet in (
        "Write two to five SPECIFIC lines",
        "at most 24 words",
    ):
        assert snippet not in steps
    assert "X is a [category] that [its defining mechanism or purpose]" in steps
    assert "[the field or branch it belongs to]" not in brief
    assert "[the field or branch it belongs to]" not in steps
    assert "A vector database is a database that stores embeddings" in brief
    assert "Never describe these instructions" in steps
    assert "Use that card's question, SAY and points" in steps


def test_recent_card_points_validation() -> None:
    with pytest.raises(ValidationError):
        RecentCard(card_ref="s:1", question="q", say="s", points=["a"] * 7)
    with pytest.raises(ValidationError, match="points item exceeds 400 characters"):
        RecentCard(card_ref="s:1", question="q", say="s", points=["x" * 401])
    card = RecentCard(card_ref="s:1", question="q", say="s")
    assert card.points == []


def test_format_recent_cards_json_points_key_and_label() -> None:
    with_points = RecentCard(
        card_ref="s:1", question="q1", say="say one", points=["first", "second"]
    )
    without_points = RecentCard(card_ref="s:2", question="q2", say="say two")
    new_label = (
        "RECENT CARDS (oldest first; the last card is the most recent answer; "
        "suggestions shown to Me earlier, not words Me said, never evidence):"
    )
    text_with = _format_recent_cards_json([with_points])
    assert text_with.startswith(new_label)
    payload_with = json.loads(text_with[len(new_label):].strip())
    assert payload_with[0]["points"] == ["first", "second"]
    assert payload_with[0]["say"] == "say one"

    text_without = _format_recent_cards_json([without_points])
    assert text_without.startswith(new_label)
    payload_without = json.loads(text_without[len(new_label):].strip())
    assert "points" not in payload_without[0]


def test_prepare_recent_cards_block_drops_points_first() -> None:
    points = ["alpha", "beta", "gamma", "delta"]
    card = RecentCard(
        card_ref="s:1", question="What is next?", say="Important say text here.", points=points
    )
    empty_block = _format_recent_cards_json([
        RecentCard(card_ref="s:1", question="What is next?", say="Important say text here.")
    ])
    two_point_block = _format_recent_cards_json([
        RecentCard(
            card_ref="s:1",
            question="What is next?",
            say="Important say text here.",
            points=points[:2],
        )
    ])
    full_block = _format_recent_cards_json([card])
    assert len(full_block.encode("utf-8")) > len(two_point_block.encode("utf-8"))
    assert len(two_point_block.encode("utf-8")) >= len(empty_block.encode("utf-8"))
    max_bytes = len(two_point_block.encode("utf-8"))

    block, active = _prepare_recent_cards_block([card], max_bytes)
    assert block is not None
    assert len(block.encode("utf-8")) <= max_bytes
    assert "Important say text here." in block
    assert len(active) == 1
    assert len(active[0].points) < len(points)
    assert active[0].points == points[: len(active[0].points)]
    assert active[0].say == "Important say text here."


def test_build_user_text_contains_recent_card_points() -> None:
    card = RecentCard(
        card_ref="s:1",
        question="What are the steps?",
        say="The steps start with collection.",
        points=["collect logs", "parse events"],
    )
    req = CopilotAnswerRequest(
        provider="local",
        question="Okay, and then what is next?",
        recent_cards=[card],
    )
    user_text = build_user_text(req)
    assert "collect logs" in user_text
    assert "parse events" in user_text
