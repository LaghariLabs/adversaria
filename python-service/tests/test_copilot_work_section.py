"""Contract tests for the W fix: WORK-before-SAY calculation mode."""

from __future__ import annotations

from src.copilot_answer import (
    CALCULATION_MODE_BLOCK,
    SectionStreamParser,
    _needs_calculation,
    system_prompt_for,
    system_prompt_for_request,
)
from src.models import CopilotAnswerRequest


def _local(question: str, **kwargs: object) -> CopilotAnswerRequest:
    return CopilotAnswerRequest(
        provider="local",
        question=question,
        **kwargs,  # type: ignore[arg-type]
    )


FIGS = ["Them: We catch 384 failures a year.", "Me: Each costs $10k."]


def test_needs_calculation_true_for_annual_value() -> None:
    req = _local(
        "What is the annual value of deploying this model?",
        stated_figures=list(FIGS),
    )
    assert _needs_calculation(req) is True


def test_needs_calculation_false_without_figures() -> None:
    req = _local("What is the annual value of deploying this model?")
    assert _needs_calculation(req) is False


def test_needs_calculation_false_for_cloud_providers() -> None:
    claude_req = CopilotAnswerRequest(
        provider="claude",
        question="What is the annual value of deploying this model?",
        api_key="sk-test",
    )
    assert _needs_calculation(claude_req) is False
    deepseek_req = CopilotAnswerRequest(
        provider="deepseek",
        question="What is the annual value of deploying this model?",
        llm_api_key="sk-deepseek-test",
        llm_base_url="https://api.deepseek.com",
        model="deepseek-v4-pro",
    )
    assert _needs_calculation(deepseek_req) is False


def test_needs_calculation_false_for_definition() -> None:
    req = _local("What is a vector database?", stated_figures=list(FIGS))
    assert _needs_calculation(req) is False


def test_needs_calculation_true_for_how_many_per_year() -> None:
    req = _local(
        "How many failures would we catch per year?", stated_figures=list(FIGS)
    )
    assert _needs_calculation(req) is True


def test_needs_calculation_uses_resolved_question() -> None:
    req = _local(
        "What is a vector database?",
        resolved_question="What is the annual value of this model?",
        stated_figures=list(FIGS),
    )
    assert _needs_calculation(req) is True


def test_non_calculation_prompt_is_byte_identical() -> None:
    req = _local("What is a vector database?", stated_figures=list(FIGS))
    assert system_prompt_for_request(req) == system_prompt_for("brief")
    steps_req = _local(
        "What is a vector database?",
        stated_figures=list(FIGS),
        answer_shape="steps",
    )
    assert system_prompt_for_request(steps_req) == system_prompt_for("steps")


def test_calculation_prompt_appends_block() -> None:
    req = _local(
        "What is the annual value of deploying this model?",
        stated_figures=list(FIGS),
    )
    base = system_prompt_for("brief")
    prompt = system_prompt_for_request(req)
    assert prompt == base + "\n\n" + CALCULATION_MODE_BLOCK
    assert "CALCULATION MODE" in prompt


WORK_STREAM = (
    "WORK:\n"
    "120 x 3.2 = 384\n"
    "RESULT: 11.5M dollars\n"
    "SAY: The annual value is 11.5 million dollars.\n"
    "SPECIFIC: **Net**: 15.97 - 4.47 = 11.5\n"
    "NEXT: What drives it?"
)


def _assembled(frames: list[dict[str, object]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for f in frames:
        if f.get("drop"):
            continue
        out.setdefault(str(f["sec"]), []).append(str(f["t"]))
    return out


def _joined(frames: list[dict[str, object]]) -> dict[str, str]:
    return {sec: "".join(chunks) for sec, chunks in _assembled(frames).items()}


def test_parser_swallows_work_whole_string() -> None:
    parser = SectionStreamParser()
    frames = parser.feed(WORK_STREAM)
    frames.extend(parser.flush())
    secs = [f["sec"] for f in frames if not f.get("drop")]
    assert "work" not in secs
    assert set(secs) == {"say", "specific", "next"}
    say_text = " ".join(_assembled(frames)["say"])
    assert say_text == "The annual value is 11.5 million dollars."
    for f in frames:
        assert "384" not in str(f.get("t", ""))
        assert "RESULT" not in str(f.get("t", ""))


def test_parser_char_at_a_time_matches_whole_string() -> None:
    whole = SectionStreamParser()
    whole_frames = whole.feed(WORK_STREAM)
    whole_frames.extend(whole.flush())

    trickle = SectionStreamParser()
    trickle_frames: list[dict[str, object]] = []
    for ch in WORK_STREAM:
        trickle_frames.extend(trickle.feed(ch))
    trickle_frames.extend(trickle.flush())

    assert _joined(trickle_frames) == _joined(whole_frames)


def test_parser_stream_ending_inside_work_emits_nothing() -> None:
    parser = SectionStreamParser()
    frames = parser.feed("WORK:\n120 x 3 = 360\nRESULT: 360 dollars")
    frames.extend(parser.flush())
    assert frames == []


def test_parser_star_label_variant_swallowed() -> None:
    parser = SectionStreamParser()
    frames = parser.feed(
        "**WORK:**\nsecret scratch\nSAY: The annual value is 11.5 million dollars.\n"
    )
    frames.extend(parser.flush())
    secs = [f["sec"] for f in frames if not f.get("drop")]
    assert "work" not in secs
    assert "say" in secs
    for f in frames:
        assert "secret scratch" not in str(f.get("t", ""))
