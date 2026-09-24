"""Contract tests for the R1 per-card replay frame on /copilot_answer_stream."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from src import copilot_answer
from src.copilot_answer import (
    CLAUDE_DEFAULT_MODEL,
    StreamControl,
    build_claude_content,
    build_claude_content_with_report,
    build_user_text,
    build_user_text_with_report,
    stream_frames,
    system_prompt_for,
    system_prompt_for_request,
)
from src.models import CopilotAnswerRequest
from src.summarizer import COPILOT_MAX_TOKENS, CopilotStreamEvent

REPLAY_KEYS = {
    "v",
    "prompt_sha",
    "calc_mode",
    "user_text",
    "dropped",
    "model",
    "max_tokens",
}


class _FakeSummarizer:
    """Stand-in for OllamaSummarizer.copilot_stream (no network)."""

    def __init__(self, text: str = "SAY: Test answer.\n", model: str = "qwen3-test"):
        self._text = text
        self.model = model
        self.calls: list[dict[str, Any]] = []

    def copilot_stream(
        self,
        system_prompt: str,
        user_text: str,
        model: str | None,
        base_url: str | None,
        api_key: str | None,
        control: object,
        provider: str = "local",
    ):
        self.calls.append(
            {
                "system_prompt": system_prompt,
                "user_text": user_text,
                "model": model,
                "provider": provider,
            }
        )
        return iter(
            [
                CopilotStreamEvent("delta", text=self._text),
                CopilotStreamEvent("done", input_tokens=7, output_tokens=2),
            ]
        )


def _payloads(body: str) -> list[str]:
    out: list[str] = []
    for chunk in body.split("\n\n"):
        chunk = chunk.strip()
        if chunk.startswith("data:"):
            out.append(chunk[len("data:") :].strip())
    return out


def _docs(body: str) -> list[Any]:
    return [json.loads(p) for p in _payloads(body) if p != "[DONE]"]


def _replay_doc(body: str) -> dict[str, Any]:
    docs = _docs(body)
    assert docs, "expected at least one SSE frame"
    assert set(docs[0].keys()) == {"replay"}, f"replay frame must be first: {docs[0]}"
    assert sum(1 for d in docs if "replay" in d) == 1, "replay frame must appear once"
    return docs[0]


def _claude_module() -> MagicMock:
    class AuthenticationError(Exception):
        pass

    class RateLimitError(Exception):
        pass

    class APIConnectionError(Exception):
        pass

    class APIStatusError(Exception):
        pass

    module = MagicMock()
    module.AuthenticationError = AuthenticationError
    module.RateLimitError = RateLimitError
    module.APIConnectionError = APIConnectionError
    module.APIStatusError = APIStatusError
    return module


def _run_claude(req: CopilotAnswerRequest) -> tuple[str, MagicMock]:
    fake_anthropic = _claude_module()
    stream = MagicMock()
    stream.__iter__.return_value = iter(
        [
            SimpleNamespace(
                type="content_block_delta",
                delta=SimpleNamespace(type="text_delta", text="SAY: Test answer.\n"),
            )
        ]
    )
    stream.get_final_message.return_value = SimpleNamespace(
        stop_reason="end_turn",
        usage=SimpleNamespace(
            input_tokens=10,
            output_tokens=5,
            server_tool_use=SimpleNamespace(web_search_requests=0),
        ),
    )
    context = MagicMock()
    context.__enter__.return_value = stream
    context.__exit__.return_value = False
    fake_anthropic.Anthropic.return_value.messages.stream.return_value = context
    with patch.object(copilot_answer, "anthropic", fake_anthropic):
        body = "".join(stream_frames(req, None, StreamControl()))
    return body, fake_anthropic


def test_replay_frame_first_once_exact_keys_and_sha_local() -> None:
    req = CopilotAnswerRequest(
        provider="local", question="What changed?", model="qwen3-test"
    )
    fake = _FakeSummarizer()
    body = "".join(stream_frames(req, fake, StreamControl()))

    replay = _replay_doc(body)["replay"]
    assert set(replay.keys()) == REPLAY_KEYS
    assert replay["v"] == 1
    assert re.fullmatch(r"[0-9a-f]{12}", replay["prompt_sha"])
    expected_prompt = system_prompt_for_request(req)
    assert (
        replay["prompt_sha"]
        == hashlib.sha256(expected_prompt.encode("utf-8")).hexdigest()[:12]
    )
    assert replay["calc_mode"] is False
    assert replay["user_text"] == build_user_text(req)
    assert replay["dropped"] == []
    assert replay["model"] == "qwen3-test"
    assert replay["max_tokens"] == COPILOT_MAX_TOKENS

    # The frame describes the exact strings handed to the provider.
    assert fake.calls[0]["system_prompt"] == expected_prompt
    assert fake.calls[0]["user_text"] == replay["user_text"]

    # The answer still streams after the frame.
    assert body.endswith("data: [DONE]\n\n")
    assert '"usage"' in body


def test_replay_frame_default_model_resolution() -> None:
    local_req = CopilotAnswerRequest(provider="local", question="What changed?")
    body = "".join(
        stream_frames(local_req, _FakeSummarizer(model="fallback-model"), StreamControl())
    )
    assert _replay_doc(body)["replay"]["model"] == "fallback-model"

    claude_req = CopilotAnswerRequest(
        provider="claude", question="What changed?", api_key="sk-test"
    )
    claude_body, _ = _run_claude(claude_req)
    assert _replay_doc(claude_body)["replay"]["model"] == CLAUDE_DEFAULT_MODEL


def test_replay_frame_claude_reuses_prompt_and_text() -> None:
    req = CopilotAnswerRequest(
        provider="claude",
        question="What changed?",
        api_key="sk-test",
        context_turns=["Ship it Friday"],
        passages=[{"title": "Plan", "text": "Polly owns it."}],
    )
    body, fake_anthropic = _run_claude(req)

    replay = _replay_doc(body)["replay"]
    expected_prompt = system_prompt_for(req.answer_shape)
    assert (
        replay["prompt_sha"]
        == hashlib.sha256(expected_prompt.encode("utf-8")).hexdigest()[:12]
    )
    _, expected_text, expected_dropped = build_claude_content_with_report(req)
    assert replay["user_text"] == expected_text
    assert replay["user_text"] == build_claude_content(req)[-1]["text"]
    assert replay["dropped"] == expected_dropped

    kwargs = fake_anthropic.Anthropic.return_value.messages.stream.call_args.kwargs
    assert kwargs["system"][0]["text"] == expected_prompt
    assert kwargs["messages"][0]["content"][-1]["text"] == replay["user_text"]
    assert body.endswith("data: [DONE]\n\n")


def test_replay_frame_deepseek_first_and_explicit_model() -> None:
    req = CopilotAnswerRequest(
        provider="deepseek",
        question="What changed?",
        model="deepseek-v4-pro",
        llm_base_url="https://api.deepseek.com",
        llm_api_key="sk-deepseek-test",
    )
    fake = _FakeSummarizer()
    body = "".join(stream_frames(req, fake, StreamControl()))

    replay = _replay_doc(body)["replay"]
    assert set(replay.keys()) == REPLAY_KEYS
    assert replay["model"] == "deepseek-v4-pro"
    assert fake.calls[0]["provider"] == "deepseek"
    assert fake.calls[0]["user_text"] == replay["user_text"]
    assert body.endswith("data: [DONE]\n\n")


def _oversized_request() -> CopilotAnswerRequest:
    return CopilotAnswerRequest(
        provider="local",
        question="What is the total?",
        standing_pack="P" * 5000,
        meeting_header="H" * 1200,
        persona="I" * 200,
        running_summary="S" * 1200,
        voice_samples=["V" * 500, "W" * 500],
        context_turns=[f"turn {i} " + "T" * 500 for i in range(8)],
        passages=[{"title": f"D{i}", "text": "X" * 500} for i in range(3)],
        recent_cards=[
            {
                "card_ref": f"c{i}",
                "question": f"Q{i}?",
                "say": f"A{i}.",
                "points": [f"p{i}"],
            }
            for i in range(2)
        ],
        stated_figures=["revenue 10", "cost 3"],
    )


def test_replay_dropped_lists_removed_blocks_in_order() -> None:
    req = _oversized_request()
    text, dropped = build_user_text_with_report(req, extra_envelope_used=32768)

    assert dropped == [
        "voice",
        "recent_cards",
        "summary",
        "header",
        "pack",
        "figures",
        "turns",
        "passages",
    ]
    # The wrapper returns the identical text for identical arguments.
    assert text == build_user_text(req, extra_envelope_used=32768)


def test_replay_small_request_reports_no_drops() -> None:
    req = CopilotAnswerRequest(
        provider="local",
        question="What changed?",
        context_turns=["Ship it Friday"],
        passages=[{"title": "Plan", "text": "Polly owns it."}],
    )
    text, dropped = build_user_text_with_report(req)

    assert dropped == []
    assert text == build_user_text(req)


def test_replay_frame_hides_api_keys() -> None:
    claude_key = "SENTINEL_CLAUDE_KEY_9f8e7d6c5b4a"
    llm_key = "SENTINEL_LLM_KEY_1a2b3c4d5e6f"

    local_req = CopilotAnswerRequest(
        provider="local",
        question="What changed?",
        llm_base_url="http://127.0.0.1:11434",
        llm_api_key=llm_key,
    )
    local_body = "".join(stream_frames(local_req, _FakeSummarizer(), StreamControl()))
    local_frame = json.dumps(_replay_doc(local_body))
    assert llm_key not in local_frame

    deepseek_req = CopilotAnswerRequest(
        provider="deepseek",
        question="What changed?",
        model="deepseek-v4-pro",
        llm_base_url="https://api.deepseek.com",
        llm_api_key=llm_key,
    )
    deepseek_body = "".join(
        stream_frames(deepseek_req, _FakeSummarizer(), StreamControl())
    )
    assert llm_key not in json.dumps(_replay_doc(deepseek_body))

    claude_req = CopilotAnswerRequest(
        provider="claude", question="What changed?", api_key=claude_key
    )
    claude_body, _ = _run_claude(claude_req)
    assert claude_key not in json.dumps(_replay_doc(claude_body))


def test_replay_calc_mode() -> None:
    calc_req = CopilotAnswerRequest(
        provider="local",
        question="How much do we save per year?",
        stated_figures=["failures caught: 384 per year", "cost per failure: 55"],
    )
    calc_body = "".join(
        stream_frames(calc_req, _FakeSummarizer(), StreamControl())
    )
    calc_replay = _replay_doc(calc_body)["replay"]
    assert calc_replay["calc_mode"] is True
    assert "CALCULATION MODE" in system_prompt_for_request(calc_req)

    plain_req = CopilotAnswerRequest(
        provider="local", question="How much do we save per year?"
    )
    plain_body = "".join(
        stream_frames(plain_req, _FakeSummarizer(), StreamControl())
    )
    assert _replay_doc(plain_body)["replay"]["calc_mode"] is False

    deepseek_req = CopilotAnswerRequest(
        provider="deepseek",
        question="How much do we save per year?",
        model="deepseek-v4-pro",
        llm_base_url="https://api.deepseek.com",
        llm_api_key="sk-deepseek-test",
    )
    deepseek_body = "".join(
        stream_frames(deepseek_req, _FakeSummarizer(), StreamControl())
    )
    assert _replay_doc(deepseek_body)["replay"]["calc_mode"] is False


def test_replay_frame_failure_never_breaks_answer(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def _boom(_data: bytes) -> str:
        raise RuntimeError("sha unavailable")

    monkeypatch.setattr(copilot_answer.hashlib, "sha256", _boom)
    req = CopilotAnswerRequest(
        provider="local", question="What changed?", model="qwen3-test"
    )
    with caplog.at_level(logging.WARNING, logger="src.copilot_answer"):
        body = "".join(stream_frames(req, _FakeSummarizer(), StreamControl()))

    assert '"replay"' not in body
    assert '{"t": "Test answer.", "sec": "say", "i": 0}' in body
    assert body.endswith("data: [DONE]\n\n")
    assert any(
        "replay" in record.message.lower()
        for record in caplog.records
        if record.levelno >= logging.WARNING
    )
