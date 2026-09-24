"""Tests for MQ-A: copilot answers every question in the turn (brief shape)."""

from __future__ import annotations

from src.copilot_answer import (
    BRIEF_SHAPE_BLOCK,
    COPILOT_SYSTEM_PROMPT,
    STEPS_SHAPE_BLOCK,
    SectionStreamParser,
    _BRIEF_NEXT_RULE,
    _BRIEF_RELATE,
    _BRIEF_SAY_NOTE,
    _specifics_cap,
    system_prompt_for,
)
from src.summarizer import COPILOT_MAX_TOKENS


def test_brief_blocks_each_embedded_exactly_once() -> None:
    for block in (
        BRIEF_SHAPE_BLOCK,
        _BRIEF_SAY_NOTE,
        _BRIEF_RELATE,
        _BRIEF_NEXT_RULE,
    ):
        assert COPILOT_SYSTEM_PROMPT.count(block) == 1


def test_steps_shape_swaps_block_and_keeps_shared_rules() -> None:
    steps = system_prompt_for("steps")
    assert STEPS_SHAPE_BLOCK in steps
    for block in (
        BRIEF_SHAPE_BLOCK,
        _BRIEF_SAY_NOTE,
        _BRIEF_RELATE,
        _BRIEF_NEXT_RULE,
    ):
        assert block not in steps
    assert "UNRECOGNISED NAMES. Apply this rule separately to each question." in steps
    assert (
        "Other questions in the same turn still get their own answers." in steps
    )


def test_specifics_cap_brief_five_steps_six() -> None:
    assert _specifics_cap("brief") == 5
    assert _specifics_cap("steps") == 6


def test_parser_five_specifics_and_two_say_sentences() -> None:
    parser = SectionStreamParser(5)
    stream = (
        "SAY: A is x. B is y.\n"
        "SPECIFIC: **a**: 1\n"
        "SPECIFIC: **b**: 2\n"
        "SPECIFIC: **c**: 3\n"
        "SPECIFIC: **d**: 4\n"
        "SPECIFIC: **e**: 5\n"
        "SPECIFIC: **f**: 6\n"
    )
    frames = parser.feed(stream)
    frames.extend(parser.flush())
    say = sorted(
        f["i"] for f in frames if f.get("sec") == "say" and f.get("t", "").strip()
    )
    assert say == [0, 1]
    grouped: dict[int, list[str]] = {}
    for f in frames:
        if f.get("sec") == "specific" and not f.get("drop") and f.get("t"):
            grouped.setdefault(f["i"], []).append(f["t"])
    assert sorted(grouped) == [0, 1, 2, 3, 4]


def test_copilot_max_tokens_1024() -> None:
    assert COPILOT_MAX_TOKENS == 1024
