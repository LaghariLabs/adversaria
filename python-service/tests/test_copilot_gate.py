"""Contract tests for the local copilot trigger gate."""

from __future__ import annotations

import json
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from src.copilot_gate import GATE_SYSTEM_PROMPT, build_user_text, decide
from src.models import GateModelOutput, GateRequest, GateResponse
from src.summarizer import OllamaSummarizer


def _request(candidate: str = "Who is the founder of OpenAI?") -> GateRequest:
    return GateRequest(
        candidate=candidate,
        speaker="Me",
        mode="self_ask",
        model="qwen3.6:35b",
    )


def test_prompt_content() -> None:
    for required in (
        "real, unresolved request for information or a decision",
        "addressed to the other side, the group, or the copilot",
        "Ignore narration about the tool or the meeting, quoted examples, rhetorical questions",
        "requests the speaker answers themselves in the same turn",
        "repeats of recent_questions",
        "with every unresolved question or request in the candidate, in the order asked",
        "Do not select just the first or last question",
        "Keep resolved_question within 2000 characters without dropping a request",
        "every entity, negation and constraint",
        "Resolve pronouns only when context_turns makes the antecedent clear",
        "never add facts",
        "Output JSON only.",
    ):
        assert required in GATE_SYSTEM_PROMPT
    assert "the single question" not in GATE_SYSTEM_PROMPT
    assert "founded OpenAI" not in GATE_SYSTEM_PROMPT


def test_prompt_treats_turn_end_demonstration_questions_as_real_requests() -> None:
    rule = (
        "A question the speaker asks at the end of their own turn is a real request even "
        "when it is introduced by \"for example\", \"let's say\" or \"so\", and even when "
        "the rest of the turn is narration; in self_ask mode treat it as addressed to "
        "the copilot. Only treat a question as a quoted example when the turn goes on "
        "to answer it or to talk about it as an example."
    )
    assert rule in GATE_SYSTEM_PROMPT


def test_prompt_requires_question_first_and_has_valid_embedded_example() -> None:
    rule = (
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
    )
    assert rule in GATE_SYSTEM_PROMPT
    examples = GATE_SYSTEM_PROMPT.split(
        "Examples (candidate -> output):\n", 1
    )[1]
    lines = examples.splitlines()
    assert len(lines) == 8
    assert lines[0].startswith('Candidate: "What is Kafka?')
    assert list(json.loads(lines[1])) == ["resolved_question", "action", "reason_code"]
    assert GateModelOutput.model_validate_json(lines[1]) == GateModelOutput(
        resolved_question="What is Kafka? Who maintains Kafka today?",
        action="answer",
        reason_code="direct_question",
    )


def test_prompt_multi_question_examples_parse_and_validate() -> None:
    assert "What is Kafka? Who maintains Kafka today?" in GATE_SYSTEM_PROMPT
    assert "Who pays for the demo hosting?" in GATE_SYSTEM_PROMPT
    examples = GATE_SYSTEM_PROMPT.split(
        "Examples (candidate -> output):\n", 1
    )[1]
    lines = examples.splitlines()
    assert len(lines) % 2 == 0
    for candidate_line, json_line in zip(lines[::2], lines[1::2]):
        assert candidate_line.startswith("Candidate: ")
        assert list(json.loads(json_line)) == [
            "resolved_question",
            "action",
            "reason_code",
        ]
        GateModelOutput.model_validate_json(json_line)


def test_decide_answers_card_206_demonstration_question() -> None:
    req = _request(
        "and this is real time this is not connected to the internet this is my local llm "
        "… So for example, who is the founder of OpenAI? Bye."
    )
    expected = GateResponse(
        action="answer",
        resolved_question="Who founded OpenAI?",
        reason_code="embedded_question",
    )
    summarizer = MagicMock()
    summarizer._chat_ollama_once.return_value = {
        "message": {"content": expected.model_dump_json()}
    }
    summarizer._loads_lenient.side_effect = OllamaSummarizer._loads_lenient

    assert decide(req, summarizer, MagicMock()) == expected

    summarizer._chat_ollama_once.assert_called_once()
    kwargs = summarizer._chat_ollama_once.call_args.kwargs
    assert kwargs["model"] == "qwen3.6:35b"
    assert kwargs["messages"] == [
        {"role": "system", "content": GATE_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                "MODE:\nself_ask\n\nSPEAKER:\nMe\n\nRECENT QUESTIONS:\n(none)"
                f"\n\nCONTEXT TURNS:\n(none)\n\nCANDIDATE:\n{req.candidate}"
            ),
        },
    ]


@pytest.mark.parametrize("with_context", [False, True])
def test_build_user_text_sections(with_context: bool) -> None:
    req = _request()
    if with_context:
        req.context_turns = ["Them: We are discussing OpenAI.", "Me: Tell me more."]
        req.recent_questions = ["What is an LLM?"]
    text = build_user_text(req)
    assert text == (
        "MODE:\nself_ask\n\nSPEAKER:\nMe\n\nRECENT QUESTIONS:\n"
        + ("- What is an LLM?" if with_context else "(none)")
        + "\n\nCONTEXT TURNS:\n"
        + ("\n".join(req.context_turns) if with_context else "(none)")
        + f"\n\nCANDIDATE:\n{req.candidate}"
    )


def test_model_schema_requires_the_decision_fields() -> None:
    schema = GateModelOutput.model_json_schema()
    fields = ["resolved_question", "action", "reason_code"]
    assert list(schema["properties"]) == fields
    assert schema["required"] == fields
    assert schema["properties"]["resolved_question"]["minLength"] == 1
    assert schema["properties"]["resolved_question"]["maxLength"] == 1500
    for field in fields:
        assert schema["properties"][field]["type"] == "string"
        assert "default" not in schema["properties"][field]
        assert "anyOf" not in schema["properties"][field]
    assert schema["properties"]["action"]["enum"] == ["answer", "ignore"]
    assert schema["properties"]["reason_code"]["enum"] == [
        "direct_question", "embedded_question", "narration", "answered_in_turn",
        "repeat", "no_request", "unclear",
    ]


def test_model_schema_max_length_below_grammar_limit() -> None:
    # llama.cpp grammar limit: maxLength 2000+ fails to parse ("failed to parse grammar").
    assert GateModelOutput.model_json_schema()["properties"]["resolved_question"]["maxLength"] < 2000


@pytest.mark.parametrize("field", ["resolved_question", "action", "reason_code"])
def test_model_output_rejects_missing_or_null_fields(field: str) -> None:
    valid = {
        "resolved_question": "Who founded OpenAI?",
        "action": "answer",
        "reason_code": "embedded_question",
    }
    with pytest.raises(ValidationError):
        GateModelOutput.model_validate({key: value for key, value in valid.items() if key != field})
    with pytest.raises(ValidationError):
        GateModelOutput.model_validate({**valid, field: None})


def test_model_output_question_character_bounds() -> None:
    for length in (1, 1500):
        assert GateModelOutput(
            resolved_question="x" * length, action="ignore", reason_code="repeat"
        ).resolved_question == "x" * length
    for length in (0, 1501):
        with pytest.raises(ValidationError):
            GateModelOutput(
                resolved_question="x" * length, action="ignore", reason_code="repeat"
            )


@pytest.mark.parametrize("shape", ["envelope", "object", "fenced", "direct"])
def test_decide_parses_model_output(shape: str, caplog: pytest.LogCaptureFixture) -> None:
    expected = GateResponse(
        action="answer",
        resolved_question="Who founded OpenAI?",
        reason_code="embedded_question",
    )
    payload = expected.model_dump()
    raw = json.dumps(payload)
    responses = {
        "envelope": {"message": {"content": raw}},
        "object": SimpleNamespace(message=SimpleNamespace(content=raw)),
        "fenced": f"```json\n{raw}\n```",
        "direct": payload,
    }
    summarizer = MagicMock()
    summarizer._chat_ollama_once.return_value = responses[shape]
    summarizer._loads_lenient.side_effect = OllamaSummarizer._loads_lenient
    req = _request("So for example, who is the founder of OpenAI? Bye.")

    with caplog.at_level(logging.INFO, logger="src.copilot_gate"):
        response = decide(req, summarizer, MagicMock())

    assert response == expected
    summarizer._chat_ollama_once.assert_called_once()
    kwargs = summarizer._chat_ollama_once.call_args.kwargs
    assert kwargs["messages"] == [
        {"role": "system", "content": GATE_SYSTEM_PROMPT},
        {"role": "user", "content": build_user_text(req)},
    ]
    assert kwargs["model"] == req.model
    assert kwargs["num_ctx"] == 16384
    assert kwargs["json_schema"] == GateModelOutput.model_json_schema()
    assert "action=answer reason_code=embedded_question in " in caplog.text
    assert " ms" in caplog.text


@pytest.mark.parametrize("model", ["qwen3.6:35b", "llama3.2"])
def test_decide_forces_local_generation_options(model: str) -> None:
    req = _request()
    req.model = model
    client = MagicMock()
    client.chat.return_value = {
        "message": {
            "content": json.dumps(
                {
                    "resolved_question": req.candidate,
                    "action": "ignore",
                    "reason_code": "repeat",
                }
            )
        }
    }
    summarizer = OllamaSummarizer.__new__(OllamaSummarizer)

    response = decide(req, summarizer, client)

    assert response == GateResponse(action="ignore", reason_code="repeat")
    client.chat.assert_called_once()
    kwargs = client.chat.call_args.kwargs
    assert kwargs["options"]["temperature"] == 0
    assert kwargs["options"]["num_predict"] == 400
    assert kwargs["options"]["num_ctx"] == 16384
    assert kwargs["think"] is False
    assert kwargs["format"] == GateModelOutput.model_json_schema()


@pytest.mark.parametrize(
    "candidate",
    ["Who founded OpenAI?", "This is a meeting copilot."],
)
@pytest.mark.parametrize("failure", ["exception", "invalid_json", "invalid_schema"])
def test_decide_backend_failure_returns_backend_error(
    candidate: str, failure: str
) -> None:
    """Every failure path is its own outcome: ignore + backend_error, never a
    punctuation-sniffed answer, so Rust can tell it from a real verdict."""
    summarizer = MagicMock()
    summarizer._loads_lenient.side_effect = OllamaSummarizer._loads_lenient
    if failure == "exception":
        summarizer._chat_ollama_once.side_effect = RuntimeError("Model unavailable")
    elif failure == "invalid_json":
        summarizer._chat_ollama_once.return_value = "not JSON"
    else:
        summarizer._chat_ollama_once.return_value = {"action": "ignore"}

    assert decide(_request(candidate), summarizer, MagicMock()) == GateResponse(
        action="ignore",
        resolved_question=None,
        reason_code="backend_error",
    )


def test_decide_logs_exception_class_on_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    summarizer = MagicMock()
    summarizer._chat_ollama_once.side_effect = RuntimeError("Model unavailable")

    with caplog.at_level(logging.WARNING, logger="src.copilot_gate"):
        response = decide(_request(), summarizer, MagicMock())

    assert response.reason_code == "backend_error"
    assert "RuntimeError" in caplog.text


def test_decide_passes_through_model_unclear() -> None:
    """`unclear` stays a legitimate model reason: passed through untouched."""
    summarizer = MagicMock()
    summarizer._chat_ollama_once.return_value = {
        "message": {
            "content": json.dumps({
                "resolved_question": "Who founded OpenAI?",
                "action": "ignore",
                "reason_code": "unclear",
            })
        }
    }
    summarizer._loads_lenient.side_effect = OllamaSummarizer._loads_lenient

    assert decide(_request(), summarizer, MagicMock()) == GateResponse(
        action="ignore",
        resolved_question=None,
        reason_code="unclear",
    )


def test_decide_normal_decision_is_unchanged() -> None:
    expected = GateResponse(
        action="answer",
        resolved_question="Who founded OpenAI?",
        reason_code="direct_question",
    )
    summarizer = MagicMock()
    summarizer._chat_ollama_once.return_value = {
        "message": {"content": expected.model_dump_json()}
    }
    summarizer._loads_lenient.side_effect = OllamaSummarizer._loads_lenient

    assert decide(_request(), summarizer, MagicMock()) == expected


@pytest.mark.parametrize(
    "resolved_payload",
    [
        {},
        {"resolved_question": None},
        {"resolved_question": ""},
        {"resolved_question": "   "},
        {"resolved_question": "?! ... ?!"},
        {"resolved_question": "x" * 2001},
        {"resolved_question": "word " * 500},
        {"resolved_question": {"garbage": True}},
    ],
)
def test_decide_salvages_invalid_resolved_question(
    resolved_payload: dict[str, object], caplog: pytest.LogCaptureFixture
) -> None:
    summarizer = MagicMock()
    raw = json.dumps({
        "action": "answer",
        "reason_code": "embedded_question",
        **resolved_payload,
    })
    summarizer._chat_ollama_once.return_value = {"message": {"content": raw}}
    summarizer._loads_lenient.side_effect = OllamaSummarizer._loads_lenient
    candidate = (
        "What is this? This is my local llm … "
        "So for example, who is the founder of OpenAI? Bye."
    )
    req = _request(candidate)

    assert decide(req, summarizer, MagicMock()) == GateResponse(
        action="answer",
        resolved_question=candidate,
        reason_code="embedded_question",
    )
    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert warnings[0].getMessage().endswith(f"raw model content={raw[:300]}")
    assert "falling back" not in caplog.text


@pytest.mark.parametrize(
    ("candidate", "expected"),
    [
        (
            "Tell me about the ERDC platform you built. What was the hardest part?",
            "Tell me about the ERDC platform you built. What was the hardest part?",
        ),
        (
            "We are discussing your experience. Tell me about the ERDC platform.",
            "We are discussing your experience. Tell me about the ERDC platform.",
        ),
        ("word " * 80, " ".join(["word"] * 80)),
        ("x" * 2500, "x" * 2000),
        (
            "  What is RAG?\nWhat is a vector database?  ",
            "What is RAG? What is a vector database?",
        ),
    ],
)
def test_decide_salvages_whole_candidate(
    candidate: str, expected: str
) -> None:
    """Salvage keeps every request in the candidate, never one sentence."""
    summarizer = MagicMock()
    summarizer._chat_ollama_once.return_value = {
        "action": "answer",
        "resolved_question": "",
        "reason_code": "embedded_question",
    }
    assert decide(_request(candidate), summarizer, MagicMock()) == GateResponse(
        action="answer", resolved_question=expected, reason_code="embedded_question"
    )


@pytest.mark.parametrize("candidate", ["", "?! ... ?!", "   "])
def test_decide_salvage_failure_returns_backend_error(candidate: str) -> None:
    """When the whole candidate is also invalid, the gate reports backend_error."""
    summarizer = MagicMock()
    summarizer._chat_ollama_once.return_value = {
        "action": "answer",
        "resolved_question": "",
        "reason_code": "embedded_question",
    }
    summarizer._loads_lenient.side_effect = OllamaSummarizer._loads_lenient
    assert decide(_request(candidate), summarizer, MagicMock()) == GateResponse(
        action="ignore",
        resolved_question=None,
        reason_code="backend_error",
    )


def test_decide_accepts_long_multi_question_resolved_question() -> None:
    """A 1000-char multi-question rewrite is accepted as-is, without salvage."""
    resolved = "What is RAG? What is a vector database? " * 25
    assert 900 < len(resolved) < 2000
    expected = GateResponse(
        action="answer",
        resolved_question=resolved.strip(),
        reason_code="direct_question",
    )
    summarizer = MagicMock()
    summarizer._chat_ollama_once.return_value = {
        "message": {"content": expected.model_dump_json()}
    }
    summarizer._loads_lenient.side_effect = OllamaSummarizer._loads_lenient

    assert decide(_request(), summarizer, MagicMock()) == expected


@pytest.mark.parametrize(
    "resolved_payload",
    [
        {},
        {"resolved_question": "Who founded OpenAI?"},
        {"resolved_question": None},
        {"resolved_question": {"garbage": True}},
        {"resolved_question": ["not", "a", "question"]},
        {"resolved_question": "word " * 80},
    ],
)
def test_decide_clears_resolved_question_when_ignoring(
    resolved_payload: dict[str, object], caplog: pytest.LogCaptureFixture
) -> None:
    summarizer = MagicMock()
    summarizer._chat_ollama_once.return_value = {
        "action": "ignore",
        "reason_code": "answered_in_turn",
        **resolved_payload,
    }
    assert decide(_request(), summarizer, MagicMock()) == GateResponse(
        action="ignore", reason_code="answered_in_turn"
    )
    assert not caplog.records


@pytest.mark.parametrize("invalid_json", [False, True])
def test_decide_logs_invalid_model_content_prefix(
    invalid_json: bool, caplog: pytest.LogCaptureFixture
) -> None:
    raw = (
        "not JSON " * 80
        if invalid_json
        else json.dumps({"action": "invalid", "resolved_question": "word " * 80})
    )
    summarizer = MagicMock()
    summarizer._chat_ollama_once.return_value = {"message": {"content": raw}}
    summarizer._loads_lenient.side_effect = OllamaSummarizer._loads_lenient

    assert decide(_request("A statement."), summarizer, MagicMock()) == GateResponse(
        action="ignore", reason_code="backend_error"
    )
    warnings = [
        record for record in caplog.records if "raw model content=" in record.getMessage()
    ]
    assert len(warnings) == 1
    assert warnings[0].levelno == logging.WARNING
    assert warnings[0].getMessage().endswith(f"raw model content={raw[:300]}")


@pytest.mark.parametrize("existing_client", [False, True])
def test_route_returns_mocked_decision(existing_client: bool) -> None:
    from test_server import client

    req = _request()
    expected = GateResponse(
        action="answer",
        resolved_question="Who founded OpenAI?",
        reason_code="direct_question",
    )
    summarizer = MagicMock()
    local_client = MagicMock()
    summarizer.client = local_client if existing_client else None
    summarizer._ollama_client.return_value = local_client

    with (
        patch("src.server._summarizer", summarizer),
        patch("src.server.copilot_gate.decide", return_value=expected) as mock_decide,
    ):
        response = client.post("/copilot/gate", json=req.model_dump())

    assert response.status_code == 200
    assert response.json() == expected.model_dump()
    mock_decide.assert_called_once_with(req, summarizer, local_client)
    if existing_client:
        summarizer._ollama_client.assert_not_called()
    else:
        summarizer._ollama_client.assert_called_once_with()


@pytest.mark.parametrize(
    "candidate",
    ["Who founded OpenAI?", "This is a meeting copilot."],
)
def test_route_returns_backend_error_without_summarizer(candidate: str) -> None:
    from test_server import client

    with (
        patch("src.server._summarizer", None),
        patch("src.server.copilot_gate.decide") as mock_decide,
    ):
        response = client.post("/copilot/gate", json=_request(candidate).model_dump())

    assert response.status_code == 200
    assert response.json() == {
        "action": "ignore",
        "resolved_question": None,
        "reason_code": "backend_error",
    }
    mock_decide.assert_not_called()


@pytest.mark.parametrize(
    ("method", "path", "status", "keep"),
    [
        ("POST", "/copilot/gate", 200, False),
        ("POST", "/copilot/gate?trace=1", 204, False),
        ("POST", "/copilot/gate", 500, True),
        ("GET", "/copilot/gate", 200, True),
        ("POST", "/copilot_answer_stream", 200, True),
    ],
)
def test_gate_access_log_filter(method: str, path: str, status: int, keep: bool) -> None:
    from src.server import _ACCESS_LOG_POLL_FILTER

    record = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname="",
        lineno=0,
        msg="",
        args=("127.0.0.1", method, path, "1.1", status),
        exc_info=None,
    )
    assert _ACCESS_LOG_POLL_FILTER.filter(record) is keep
