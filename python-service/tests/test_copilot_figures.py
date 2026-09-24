"""Contract tests for the L-P fact ledger (stated_figures)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.copilot_answer import build_user_text, system_prompt_for
from src.models import CopilotAnswerPassage, CopilotAnswerRequest, RecentCard


def test_stated_figures_default_empty() -> None:
    req = CopilotAnswerRequest(provider="local", question="What changed?")
    assert req.stated_figures == []


def test_stated_figures_accepted_for_local() -> None:
    req = CopilotAnswerRequest(
        provider="local",
        question="What is the annual value?",
        stated_figures=["Them: We catch 384 failures a year.", "Me: Each costs $10k."],
    )
    assert req.stated_figures == [
        "Them: We catch 384 failures a year.",
        "Me: Each costs $10k.",
    ]


def test_stated_figures_strips_and_drops_blanks() -> None:
    req = CopilotAnswerRequest(
        provider="local",
        question="What changed?",
        stated_figures=["  Me: padded.  ", "   ", ""],
    )
    assert req.stated_figures == ["Me: padded."]


def test_stated_figures_rejects_241_char_entry() -> None:
    with pytest.raises(ValidationError, match="stated figure exceeds 240 characters"):
        CopilotAnswerRequest(
            provider="local",
            question="What changed?",
            stated_figures=["x" * 241],
        )


def test_stated_figures_rejects_over_4000_bytes() -> None:
    with pytest.raises(ValidationError, match="stated_figures exceeds 4000 bytes"):
        CopilotAnswerRequest(
            provider="local",
            question="What changed?",
            stated_figures=["y" * 240 for _ in range(17)],
        )


def test_stated_figures_rejected_for_claude() -> None:
    with pytest.raises(ValidationError, match="stated figures are local only"):
        CopilotAnswerRequest(
            provider="claude",
            question="What changed?",
            api_key="sk-test",
            stated_figures=["Them: 384 failures a year."],
        )


def test_stated_figures_rejected_for_deepseek() -> None:
    with pytest.raises(ValidationError, match="stated figures are local only"):
        CopilotAnswerRequest(
            provider="deepseek",
            question="What changed?",
            llm_api_key="sk-deepseek-test",
            llm_base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            stated_figures=["Them: 384 failures a year."],
        )


def test_figures_block_position_and_absence() -> None:
    card = RecentCard(card_ref="s:1", question="Old Q", say="Old say")
    req = CopilotAnswerRequest(
        provider="local",
        question="What is the annual value?",
        context_turns=["Them: hello"],
        recent_cards=[card],
        stated_figures=[
            "Them: We catch 384 failures a year.",
            "Me: Each failure costs ten thousand dollars.",
        ],
    )
    text = build_user_text(req)
    assert (
        "FIGURES (stated aloud earlier in this meeting, verbatim, oldest first):\n"
        "- Them: We catch 384 failures a year.\n"
        "- Me: Each failure costs ten thousand dollars." in text
    )
    assert text.index("RECENT CARDS") < text.index("FIGURES")
    assert text.index("FIGURES") < text.index("TURNS:")

    empty_req = CopilotAnswerRequest(
        provider="local",
        question="What changed?",
        context_turns=["Them: hello"],
        recent_cards=[card],
    )
    assert "FIGURES" not in build_user_text(empty_req)


def test_figures_not_emitted_for_cloud_envelope() -> None:
    req = CopilotAnswerRequest.model_construct(
        schema_version=7,
        provider="claude",
        question="What changed?",
        question_source="Them",
        context_turns=["Them: hello"],
        stated_figures=["Them: 384 failures a year."],
        api_key="sk-test",
    )
    assert "FIGURES" not in build_user_text(req)


def test_figures_survives_envelope_drops() -> None:
    # Sized so the drop cascade (VOICE, RECENT CARDS, SUMMARY, HEADER, PACK)
    # fits the 32768-byte local envelope exactly when PACK is dropped,
    # leaving FIGURES in place.
    req = CopilotAnswerRequest.model_construct(
        schema_version=7,
        provider="local",
        question="What is the annual value?",
        question_source="Them",
        standing_pack="Standing pack content " * 500,
        voice_samples=["Voice style " * 20],
        recent_cards=[RecentCard(card_ref="s:1", question="Old Q", say="Old say")],
        running_summary="Summary " * 800,
        meeting_header="Header " * 800,
        context_turns=[f"Turn {i}: {'x' * 700}" for i in range(30)],
        passages=[
            CopilotAnswerPassage.model_construct(
                title="PTitle", text="PText " * 200, source="PSrc"
            )
        ],
        stated_figures=[
            "Them: We catch 384 failures a year.",
            "Me: Each failure costs ten thousand dollars.",
        ],
    )
    text = build_user_text(req, include_passages=True)
    assert len(text.encode("utf-8")) <= 32768
    assert "VOICE" not in text
    assert "RECENT CARDS" not in text
    assert "SUMMARY:" not in text
    assert "HEADER" not in text
    assert "PACK" not in text
    assert (
        "FIGURES (stated aloud earlier in this meeting, verbatim, oldest first):"
        in text
    )
    assert "- Them: We catch 384 failures a year." in text
    assert "- Me: Each failure costs ten thousand dollars." in text


@pytest.mark.parametrize("shape", ["brief", "steps"])
def test_system_prompts_contain_figures_rule(shape: str) -> None:
    assert (
        "Never ask for a figure that FIGURES or TURNS already states."
        in system_prompt_for(shape)
    )
