"""Tests for the UNRECOGNISED NAMES prompt rule (Task U)."""

from __future__ import annotations

from src.copilot_answer import COPILOT_SYSTEM_PROMPT, system_prompt_for

RULE = (
    "UNRECOGNISED NAMES. Apply this rule separately to each question. "
    "A name described in TURNS or passages is identified: when TURNS or a passage says what the named thing is or does, answer normally using that description and never use the unfamiliar-name sentence. "
    "Otherwise, answer normally when you reliably identify the exact named thing from established knowledge and that meaning fits the question. "
    "If the spoken name closely resembles a well-known term and the current topic strongly supports that term, name the correction once in SAY, for example \"LangGraph, if that's the word:\", then answer normally without an unfamiliar-name preface. "
    "A known spelling or expansion that does not fit the intended subject is not identification; do not substitute a familiar organisation for an unknown technical format. "
    "Different categories alone do not make a comparison invalid. "
    "A familiar company or model-family name inside the name (for example Qwen, GPT, Llama, Gemini) does not make that specific product or version recognised. "
    "If the subject remains unidentified, its SAY sentence must be exactly: I'm not familiar with [name]; which [model / product / company / person / event / term] do you mean? "
    "Substitute the name and the appropriate single category. "
    "Copy that sentence word for word; never paraphrase it as 'not a recognized model', 'not a standard term', 'knowledge base', 'training data' or 'as an AI'. "
    "Example: \"What is Zorblex?\" -> SAY: I'm not familiar with Zorblex; which product do you mean? That sentence is the entire SAY; write no SPECIFIC and no NEXT. "
    "Never guess an acronym's expansion. An acronym the supplied evidence does not define stays unidentified even when its topic is clear. "
    "When an acronym has no definition in the supplied evidence and you are not certain of its exact expansion, use the not-familiar sentence with category term rather than guessing an expansion. "
    "If the turn asks only about that subject, this sentence is the entire SAY; write no SPECIFIC and no NEXT. "
    "If the turn also asks other questions, answer those normally in order; SPECIFIC and NEXT may address those other subjects. "
    "Never write a SPECIFIC about a name's absence from the supplied context. "
    "For a subject that remains unidentified after this identification order, this rule overrides the definition form, subject-first wording and requests for supporting detail. "
    "Do not claim that the thing does not exist or invent its capabilities or release history."
)

NUMBER_FORMAT_SENTENCE = (
    "Write every number in SAY and SPECIFIC as digits with its unit "
    "(for example $11.45 million, 55%, 3.2 seconds), never spelled out in words."
)


def test_unrecognised_names_rule_in_shared_prompt() -> None:
    assert COPILOT_SYSTEM_PROMPT.count(RULE) == 1


def test_unrecognised_names_rule_in_both_shapes() -> None:
    assert RULE in system_prompt_for("brief")
    assert RULE in system_prompt_for("steps")
    assert "does not make that specific product or version recognised" in system_prompt_for("brief")
    assert "does not make that specific product or version recognised" in system_prompt_for("steps")


def test_number_format_sentence_in_both_shapes() -> None:
    assert NUMBER_FORMAT_SENTENCE in system_prompt_for("brief")
    assert NUMBER_FORMAT_SENTENCE in system_prompt_for("steps")


def test_shared_p1_statistics_paragraph_in_both_shapes() -> None:
    for shape in ("brief", "steps"):
        text = system_prompt_for(shape)
        assert "Never invent statistics, percentages, benchmark results" in text
        assert "These rules apply to SAY and SPECIFIC." in text


def test_shared_p3_what_else_rule_in_both_shapes() -> None:
    for shape in ("brief", "steps"):
        text = system_prompt_for(shape)
        assert (
            'For "what else", "anything else", "other ways" or "what more"'
            in text
        )
        assert "reordering or paraphrasing an existing suggestion is not new" in text


def test_shared_p4_clarification_rule_in_both_shapes() -> None:
    for shape in ("brief", "steps"):
        text = system_prompt_for(shape)
        assert (
            'When "What do you mean?" refers to the most recent relevant card'
            in text
        )
        assert "If SAY contains only clarification, write no SPECIFIC" in text


def test_steps_shape_carries_clarification_exceptions() -> None:
    assert (
        "these exceptions override the usual action count"
        in system_prompt_for("steps")
    )


def test_removed_wording_absent_from_both_shapes() -> None:
    for shape in ("brief", "steps"):
        text = system_prompt_for(shape)
        assert "[the field or branch it belongs to]" not in text
        assert "transcription-correction guidance" not in text


def test_split_misspelled_name_sentence_in_both_shapes() -> None:
    for shape in ("brief", "steps"):
        text = system_prompt_for(shape)
        assert '"Lama Index" means LlamaIndex' in text
        assert '"Pie Torch" means PyTorch' in text
