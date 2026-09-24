"""Offline tests for E1a Copilot Replay Harness and synthetic fixtures.

Validates manifest structure, security loopback checks, percentile computations,
secret redaction, dry-run simulation, request shapes, oversized question bounds,
rapid-pair expansion, malformed/missing-usage terminal rejection, and feed continuity
accounting without requiring network access, background services, or TTS tools.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch
import pytest
from pydantic import ValidationError

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts" / "copilot-e2e"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import replay  # type: ignore[import-not-found]  # noqa: E402
from src.models import LiveFeedRequest, CopilotAnswerRequest  # noqa: E402


MANIFEST_PATH = (
    REPO_ROOT / "python-service" / "tests" / "fixtures" / "copilot" / "manifest.json"
)


def test_manifest_contains_required_14_cases():
    assert MANIFEST_PATH.is_file(), f"Manifest file missing at {MANIFEST_PATH}"
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data.get("version") == "2.0.0"
    cases = data.get("cases", [])
    case_ids = {c["id"] for c in cases}

    required_ids = {
        "personal_known",
        "personal_unknown",
        "general",
        "followup",
        "correction",
        "unicode_ar",
        "unicode_zh",
        "tag_question",
        "rapid_pair",
        "injection_passage",
        "injection_notes",
        "long_question_4k",
        "provider_failed",
        "empty_local",
    }

    missing = required_ids - case_ids
    assert not missing, f"Missing required cases from manifest: {missing}"

    for c in cases:
        assert "question" in c and len(c["question"]) > 0
        assert "expected_detector" in c
        assert "audio_replay" in c
        assert isinstance(c["audio_replay"], bool)
        assert "passages" in c
        assert isinstance(c["passages"], list)
        assert len(c["passages"]) <= 3

    injection_notes = next(c for c in cases if c["id"] == "injection_notes")
    assert injection_notes["disallowed_phrase"] == "COPILOT_INJECTION_SUCCEEDED"


def test_loopback_url_validation():
    # Valid loopback URLs
    replay.validate_loopback_url("http://127.0.0.1:9876", "test_url")
    replay.validate_loopback_url("http://localhost:8000", "test_url")
    replay.validate_loopback_url("http://localhost:11434/v1", "test_url")
    replay.validate_loopback_url("http://[::1]:9876", "test_url")

    # Invalid schemes
    with pytest.raises(ValueError, match="scheme must be http"):
        replay.validate_loopback_url("https://127.0.0.1:9876", "test_url")

    with pytest.raises(ValueError, match="scheme must be http"):
        replay.validate_loopback_url("ftp://localhost:8000", "test_url")

    # Remote hosts rejected
    with pytest.raises(ValueError, match="must be a loopback interface"):
        replay.validate_loopback_url("http://api.anthropic.com", "test_url")

    with pytest.raises(ValueError, match="must be a loopback interface"):
        replay.validate_loopback_url("http://192.168.1.50:9876", "test_url")

    # Embedded credentials rejected
    with pytest.raises(ValueError, match="must not contain user credentials"):
        replay.validate_loopback_url("http://user:pass@127.0.0.1:9876", "test_url")

    # Query or fragment parameters rejected
    with pytest.raises(ValueError, match="must not contain query parameters"):
        replay.validate_loopback_url("http://127.0.0.1:9876?token=secret", "test_url")

    with pytest.raises(ValueError, match="must not contain query parameters"):
        replay.validate_loopback_url("http://127.0.0.1:9876#section", "test_url")


def test_percentile_computation():
    # Empty case
    empty_res = replay.compute_percentiles([])
    assert empty_res == {"p50": 0.0, "p95": 0.0, "max": 0.0, "count": 0}

    # Single item
    single_res = replay.compute_percentiles([42.5])
    assert single_res == {"p50": 42.5, "p95": 42.5, "max": 42.5, "count": 1}

    # Multiple items
    data = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0]
    res = replay.compute_percentiles(data)
    assert res["count"] == 10
    assert res["p50"] == 55.0
    assert res["p95"] == 95.5
    assert res["max"] == 100.0


def test_secret_redaction():
    secret_val = "sk-ant-api03-abcdef123456789"
    payload = {
        "status": "passed",
        "api_key": secret_val,
        "nested": {
            "token": secret_val,
            "message": f"Connection succeeded with key {secret_val} on host.",
        },
        "list_data": [f"Header {secret_val}", "unrelated_value"],
    }

    sanitized = replay.redact_secrets(payload, [secret_val])
    assert sanitized["api_key"] == "[REDACTED]"
    assert sanitized["nested"]["token"] == "[REDACTED]"
    assert secret_val not in sanitized["nested"]["message"]
    assert "[REDACTED]" in sanitized["nested"]["message"]
    assert secret_val not in sanitized["list_data"][0]
    assert "[REDACTED]" in sanitized["list_data"][0]
    assert sanitized["list_data"][1] == "unrelated_value"


def test_dry_run_output_structure():
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    report = replay.run_dry_run(manifest_data)
    assert report["status"] == "dry_run"
    assert report.get("simulated") is True
    assert "environment" in report
    assert "summary" in report
    summary = report["summary"]
    assert summary["total_cases"] == 14
    assert summary["simulated_cases"] == 14
    assert (
        summary["executed_cases"] == 0
    )  # Dry-run values are simulated, not executed evidence
    assert summary["passed_cases"] == 0
    assert summary["failed_cases"] == 0
    assert summary["simulated_live_feed_p50_ms"] > 0
    assert summary["simulated_answer_ttft_p50_ms"] > 0
    assert summary["feed_continued_during_answer"] == "simulated"

    # Assert cases list has 14 entries
    assert len(report["cases"]) == 14
    case_map = {c["id"]: c for c in report["cases"]}
    assert case_map["personal_unknown"]["answer_text"].startswith("- Not in your notes")
    assert case_map["tag_question"]["status"] == "audio_fed_detector_untested"
    assert (
        case_map["tag_question"]["detector_expectation"]
        == "not_applicable_service_only"
    )


def test_request_shapes(tmp_path):
    # LiveFeedRequest shape verification
    silence_file = tmp_path / "silence.wav"
    replay.create_silence_wav(silence_file, duration_sec=0.5, sample_rate=16000)
    assert silence_file.is_file()
    assert silence_file.stat().st_size > 44

    feed_payload = {
        "audio_path": str(silence_file.resolve()),
        "session": 12345678,
        "source": "them",
    }
    live_req = LiveFeedRequest(**feed_payload)
    assert live_req.source == "them"
    assert live_req.session == 12345678

    # CopilotAnswerRequest shape verification for local provider
    copilot_payload = {
        "provider": "local",
        "question": "What is the failover timeout?",
        "context_turns": ["Discussed earlier."],
        "passages": [{"title": "Doc", "text": "Timeout is 10s.", "source": "m:1"}],
        "model": "qwen3.5:4b",
        "llm_base_url": "http://127.0.0.1:11434/v1",
        "llm_api_key": None,
    }
    copilot_req = CopilotAnswerRequest(**copilot_payload)
    assert copilot_req.provider == "local"
    assert copilot_req.question == "What is the failover timeout?"
    assert len(copilot_req.passages) == 1


def test_long_question_4k_exceeds_4000_and_is_rejected():
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    long_case = next(c for c in manifest_data["cases"] if c["id"] == "long_question_4k")
    q_text = long_case["question"]
    # Check that the question is materially over 4,000 characters
    assert len(q_text) > 4000, f"long_question_4k length {len(q_text)} must be > 4000"

    # Assert that CopilotAnswerRequest's 2000-character boundary rejects it
    with pytest.raises(ValidationError) as exc_info:
        CopilotAnswerRequest(provider="local", question=q_text)
    assert "question exceeds 2000 characters" in str(exc_info.value)


def test_rapid_pair_expansion():
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    rapid_case = next(c for c in manifest_data["cases"] if c["id"] == "rapid_pair")
    assert "question" in rapid_case and len(rapid_case["question"]) > 0
    assert "rapid_second_question" in rapid_case
    q2 = rapid_case["rapid_second_question"]
    assert "question" in q2 and len(q2["question"]) > 0
    assert q2["question"] != rapid_case["question"]
    assert "passages" in q2 and len(q2["passages"]) > 0

    # Dry run should capture both q1 and q2
    report = replay.run_dry_run(manifest_data)
    rapid_report = next(c for c in report["cases"] if c["id"] == "rapid_pair")
    assert "q1" in rapid_report
    assert "q2" in rapid_report
    assert rapid_report["q1"]["seen_done"] is True
    assert rapid_report["q2"]["seen_done"] is True
    assert "native-only" in rapid_report["detector_queue_note"]


def test_malformed_and_missing_usage_terminal_evaluation():
    class DummyResponse:
        def __init__(self, lines: list[bytes]):
            self._lines = iter(lines)

        def __iter__(self):
            return self

        def __next__(self):
            return next(self._lines)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    # Case A: Stream contains malformed JSON followed by [DONE] -> must fail with malformed error, not done
    malformed_lines = [
        b'data: {"t": "Partial text "}\n\n',
        b"data: {corrupt_json_not_valid\n\n",
        b"data: [DONE]\n\n",
    ]
    with patch("replay.http_open", return_value=DummyResponse(malformed_lines)):
        res_a = replay.consume_copilot_stream(
            "http://127.0.0.1:9876", {"provider": "local", "question": "test"}
        )
        assert res_a["has_malformed_frame"] is True
        assert res_a["terminal_kind"] == "error"
        assert res_a["seen_done"] is False
        assert "Malformed SSE JSON" in res_a["error"]
        assert res_a["full_text"] == "Partial text "

    # Case B: Stream terminates with [DONE] but has no usage frame -> must fail as missing_usage
    missing_usage_lines = [
        b'data: {"t": "Complete answer."}\n\n',
        b"data: [DONE]\n\n",
    ]
    with patch("replay.http_open", return_value=DummyResponse(missing_usage_lines)):
        res_b = replay.consume_copilot_stream(
            "http://127.0.0.1:9876", {"provider": "local", "question": "test"}
        )
        assert res_b["has_malformed_frame"] is False
        assert res_b["terminal_kind"] == "missing_usage"
        assert res_b["seen_done"] is False
        assert "missing or invalid usage frame" in res_b["error"]

    # Case C: Stream has text, valid usage frame, and [DONE] -> must pass as done
    valid_lines = [
        b'data: {"t": "Complete valid answer."}\n\n',
        b'data: {"usage": {"input_tokens": 10, "output_tokens": 15, "web_searches": 0}}\n\n',
        b"data: [DONE]\n\n",
    ]
    with patch("replay.http_open", return_value=DummyResponse(valid_lines)):
        res_c = replay.consume_copilot_stream(
            "http://127.0.0.1:9876", {"provider": "local", "question": "test"}
        )
        assert res_c["has_malformed_frame"] is False
        assert res_c["terminal_kind"] == "done"
        assert res_c["seen_done"] is True
        assert res_c["usage"]["output_tokens"] == 15
        assert res_c["full_text"] == "Complete valid answer."


def test_feed_continuity_and_sample_accounting():
    # Continuity succeeds when at least 1 successful background feed and 0 failed
    case_samples_good = [
        {"source": "them", "during_answer": False, "success": True, "latency_ms": 20.0},
        {"source": "me", "during_answer": True, "success": True, "latency_ms": 25.0},
    ]
    bg_during = [s for s in case_samples_good if s["during_answer"]]
    bg_success_count = sum(1 for s in bg_during if s["success"])
    bg_error_count = sum(1 for s in bg_during if not s["success"])
    assert (bg_success_count >= 1) and (bg_error_count == 0)

    # Continuity fails when 0 background feeds occur
    case_samples_no_bg = [
        {"source": "them", "during_answer": False, "success": True, "latency_ms": 20.0}
    ]
    bg_during_no = [s for s in case_samples_no_bg if s["during_answer"]]
    assert not (sum(1 for s in bg_during_no if s["success"]) >= 1)

    # Continuity fails when a background feed errors
    case_samples_err = [
        {"source": "them", "during_answer": False, "success": True, "latency_ms": 20.0},
        {"source": "me", "during_answer": True, "success": False, "latency_ms": 5000.0},
    ]
    bg_during_err = [s for s in case_samples_err if s["during_answer"]]
    assert not (
        (sum(1 for s in bg_during_err if s["success"]) >= 1)
        and (sum(1 for s in bg_during_err if not s["success"]) == 0)
    )


def test_redirect_refusal():
    import email

    handler = replay.NoRedirectHandler()
    req = replay.urllib.request.Request("http://127.0.0.1:9876/health")

    # 1. Direct redirect_request call raises HTTPError for all redirect codes
    for code in (301, 302, 303, 307, 308):
        with pytest.raises(replay.urllib.error.HTTPError) as exc_info:
            handler.redirect_request(
                req,
                fp=None,
                code=code,
                msg="Redirect",
                headers={},
                newurl="http://remote-attacker.com/evil",
            )
        assert exc_info.value.code == code
        assert f"HTTP redirect blocked ({code})" in str(exc_info.value)

    # 2. Handler methods (http_error_301, http_error_302, etc.) invoke redirect_request and raise
    headers = email.message_from_string("Location: http://remote-attacker.com/evil\n\n")
    for code in (301, 302, 303, 307, 308):
        method_name = f"http_error_{code}"
        handler_method = getattr(handler, method_name)
        with pytest.raises(replay.urllib.error.HTTPError) as exc_info:
            handler_method(req, None, code, "Redirect", headers)
        assert exc_info.value.code == code
        assert f"HTTP redirect blocked ({code})" in str(exc_info.value)

    # 3. Verify NO_REDIRECT_OPENER includes NoRedirectHandler and uses it
    assert any(
        isinstance(h, replay.NoRedirectHandler)
        for h in replay.NO_REDIRECT_OPENER.handlers
    )
    proxy_handlers = [
        h
        for h in replay.NO_REDIRECT_OPENER.handlers
        if isinstance(h, replay.urllib.request.ProxyHandler)
    ]
    # Passing ProxyHandler({}) to build_opener suppresses the default
    # environment-backed ProxyHandler; urllib omits the empty handler itself.
    assert proxy_handlers == []


def test_redaction_preserves_usage_and_timing_fields():
    report = {
        "answer_first_token_ts": "2026-09-05T18:44:10Z",
        "usage": {"input_tokens": 12, "output_tokens": 8, "web_searches": 0},
        "llm_api_key": "local-secret-value",
    }

    redacted = replay.redact_secrets(report, ["local-secret-value"])

    assert redacted["answer_first_token_ts"] == "2026-09-05T18:44:10Z"
    assert redacted["usage"] == {
        "input_tokens": 12,
        "output_tokens": 8,
        "web_searches": 0,
    }
    assert redacted["llm_api_key"] == "[REDACTED]"


def test_readiness_probe_terminal_handling():
    # Case A: Probe receives an error SSE frame -> unready
    error_stream = {
        "has_malformed_frame": False,
        "terminal_kind": "error",
        "seen_done": False,
        "error": "Model uninitialized on loopback host",
        "usage": None,
        "full_text": "",
    }
    with patch("replay.consume_copilot_stream", return_value=error_stream):
        ready, msg = replay.check_local_model_readiness("http://127.0.0.1:9876")
        assert ready is False
        assert "did not receive [DONE] terminal" in msg or "error" in msg

    # Case B: Probe receives malformed frame -> unready
    malformed_stream = {
        "has_malformed_frame": True,
        "terminal_kind": "error",
        "seen_done": False,
        "error": "Malformed JSON frame",
        "usage": None,
        "full_text": "",
    }
    with patch("replay.consume_copilot_stream", return_value=malformed_stream):
        ready, msg = replay.check_local_model_readiness("http://127.0.0.1:9876")
        assert ready is False
        assert "Malformed SSE frame" in msg

    # Case C: Probe receives [DONE] but usage has negative tokens -> unready
    invalid_usage_stream = {
        "has_malformed_frame": False,
        "terminal_kind": "done",
        "seen_done": True,
        "error": None,
        "usage": {"input_tokens": -1, "output_tokens": 5, "web_searches": 0},
        "full_text": "Sample answer",
    }
    with patch("replay.consume_copilot_stream", return_value=invalid_usage_stream):
        ready, msg = replay.check_local_model_readiness("http://127.0.0.1:9876")
        assert ready is False
        assert "missing valid usage metrics" in msg

    # Case D: Probe receives [DONE] but text is empty -> unready
    empty_text_stream = {
        "has_malformed_frame": False,
        "terminal_kind": "done",
        "seen_done": True,
        "error": None,
        "usage": {"input_tokens": 5, "output_tokens": 0, "web_searches": 0},
        "full_text": "   ",
    }
    with patch("replay.consume_copilot_stream", return_value=empty_text_stream):
        ready, msg = replay.check_local_model_readiness("http://127.0.0.1:9876")
        assert ready is False
        assert "empty answer text" in msg

    # Case E: Probe receives valid done terminal with text and usage -> ready and warmed
    valid_stream = {
        "has_malformed_frame": False,
        "terminal_kind": "done",
        "seen_done": True,
        "error": None,
        "usage": {"input_tokens": 12, "output_tokens": 8, "web_searches": 0},
        "full_text": "Local engine is online and responding.",
    }
    with patch("replay.consume_copilot_stream", return_value=valid_stream):
        ready, msg = replay.check_local_model_readiness("http://127.0.0.1:9876")
        assert ready is True
        assert "ready and warmed" in msg


def test_validate_answer_result_rejections():
    base_case = {
        "id": "test_case",
        "required_phrase": "expected answer",
    }
    valid_stream = {
        "has_malformed_frame": False,
        "terminal_kind": "done",
        "seen_done": True,
        "error": None,
        "usage": {"input_tokens": 10, "output_tokens": 10, "web_searches": 0},
        "full_text": "- This is the expected answer text.",
    }

    # 1. Valid stream passes
    ok, reasons = replay.validate_answer_result(valid_stream, base_case)
    assert ok is True
    assert not reasons

    # 2. Empty output fails
    stream_empty = dict(valid_stream, full_text="")
    ok, reasons = replay.validate_answer_result(stream_empty, base_case)
    assert ok is False
    assert any("empty" in r for r in reasons)

    # 3. Missing usage fails
    stream_no_usage = dict(valid_stream, usage=None)
    ok, reasons = replay.validate_answer_result(stream_no_usage, base_case)
    assert ok is False
    assert any("usage" in r for r in reasons)

    # 4. Negative tokens fail
    stream_neg_tokens = dict(
        valid_stream,
        usage={"input_tokens": -1, "output_tokens": 10, "web_searches": 0},
    )
    ok, reasons = replay.validate_answer_result(stream_neg_tokens, base_case)
    assert ok is False
    assert any("usage" in r for r in reasons)

    # 5. Non-numeric usage fails
    stream_str_tokens = dict(
        valid_stream,
        usage={"input_tokens": "ten", "output_tokens": 10, "web_searches": 0},
    )
    ok, reasons = replay.validate_answer_result(stream_str_tokens, base_case)
    assert ok is False
    assert any("usage" in r for r in reasons)

    # 6. Missing seen_done fails
    stream_no_done = dict(valid_stream, seen_done=False)
    ok, reasons = replay.validate_answer_result(stream_no_done, base_case)
    assert ok is False
    assert any("[DONE]" in r for r in reasons)

    # 7. Extra unknown fields allowed if required usage/text exist
    stream_extra = dict(
        valid_stream,
        usage={
            "input_tokens": 10,
            "output_tokens": 10,
            "web_searches": 0,
            "cached_tokens": 100,
            "unknown_metric": 42,
        },
    )
    ok, reasons = replay.validate_answer_result(stream_extra, base_case)
    assert ok is True

    # 8. Local replay enforces the output-shape contract and zero web usage.
    too_many_bullets = dict(
        valid_stream,
        full_text="- expected answer one\n- two\n- three\n- four",
    )
    ok, reasons = replay.validate_answer_result(too_many_bullets, base_case)
    assert ok is False
    assert any("1 to 3" in r for r in reasons)

    long_bullet = dict(
        valid_stream,
        full_text="- expected answer has one two three four five six seven eight nine ten eleven",
    )
    ok, reasons = replay.validate_answer_result(long_bullet, base_case)
    assert ok is False
    assert any("exceeds 12 words" in r for r in reasons)

    prose = dict(valid_stream, full_text="This prose contains the expected answer.")
    ok, reasons = replay.validate_answer_result(prose, base_case)
    assert ok is False
    assert any("not a bullet" in r for r in reasons)

    web_usage = dict(
        valid_stream,
        usage={"input_tokens": 10, "output_tokens": 10, "web_searches": 1},
    )
    ok, reasons = replay.validate_answer_result(web_usage, base_case)
    assert ok is False
    assert any("expected 0" in r for r in reasons)


def test_chunk_request_starts_follow_requested_cadence(tmp_path):
    clock = [0.0]
    starts: list[float] = []
    sleeps: list[float] = []

    def fake_perf_counter():
        return clock[0]

    def fake_sleep(seconds):
        sleeps.append(seconds)
        clock[0] += seconds

    def fake_post(*_args, **_kwargs):
        starts.append(clock[0])
        clock[0] += 0.1
        return {"success": True}

    chunks = [tmp_path / f"chunk-{index}.wav" for index in range(3)]
    with (
        patch("replay.time.perf_counter", side_effect=fake_perf_counter),
        patch("replay.time.sleep", side_effect=fake_sleep),
        patch("replay.post_live_feed_chunk", side_effect=fake_post),
    ):
        samples = replay.post_live_feed_chunks(
            "http://127.0.0.1:9876", chunks, 1, "them", 500
        )

    assert len(samples) == 3
    assert starts == pytest.approx([0.0, 0.5, 1.0])
    assert sleeps == pytest.approx([0.4, 0.4])


def test_foreground_feed_requires_every_scheduled_chunk_to_succeed():
    assert replay.all_feed_samples_succeeded([{"success": True}]) is True
    assert (
        replay.all_feed_samples_succeeded([{"success": True}, {"success": False}])
        is False
    )
    assert replay.all_feed_samples_succeeded([]) is False


def test_vad_flush_uses_the_same_foreground_cadence(tmp_path):
    chunks = [tmp_path / "speech-1.wav", tmp_path / "speech-2.wav"]
    silence = tmp_path / "flush.wav"
    with (
        patch("replay.create_silence_wav") as create_silence,
        patch("replay.post_live_feed_chunks", return_value=[]) as post_chunks,
    ):
        replay.post_live_feed_chunks_with_vad_flush(
            "http://127.0.0.1:9876", chunks, silence, 42, "them", 500
        )

    create_silence.assert_called_once_with(silence, 0.5)
    post_chunks.assert_called_once_with(
        "http://127.0.0.1:9876", [*chunks, silence], 42, "them", 500
    )


def test_feed_error_prevents_overall_pass_even_when_cases_pass():
    assert (
        replay.aggregate_live_status(
            had_tts_skip=False,
            failed_count=0,
            passed_count=1,
            total_error_samples=1,
        )
        == "failed"
    )
    assert (
        replay.aggregate_live_status(
            had_tts_skip=False,
            failed_count=0,
            passed_count=1,
            total_error_samples=0,
        )
        == "passed"
    )


def test_live_cli_requires_model_and_defaults_to_registered_ollama_endpoint(tmp_path):
    output_file = tmp_path / "result.json"
    captured: dict[str, object] = {}

    def fake_readiness(_service_url, **kwargs):
        captured.update(kwargs)
        return False, "offline test"

    argv = [
        "replay.py",
        "--model",
        "qwen3.5:4b",
        "--manifest",
        str(MANIFEST_PATH),
        "--output",
        str(output_file),
    ]
    with (
        patch("sys.argv", argv),
        patch("replay.check_service_health", return_value=(True, "ready")),
        patch("replay.check_local_model_readiness", side_effect=fake_readiness),
    ):
        assert replay.main() == 0

    assert captured["llm_base_url"] == "http://127.0.0.1:11434"
    assert json.loads(output_file.read_text(encoding="utf-8"))["status"] == "skipped"

    without_model = [arg for arg in argv if arg not in {"--model", "qwen3.5:4b"}]
    with (
        patch("sys.argv", without_model),
        patch("replay.check_service_health", return_value=(True, "ready")),
        patch("replay.check_local_model_readiness") as readiness,
    ):
        assert replay.main() == 1
    readiness.assert_not_called()
    report = json.loads(output_file.read_text(encoding="utf-8"))
    assert report["status"] == "invalid"
    assert report["environment"]["model"] == "not_supplied"


def test_first_bullet_prefix_enforcement():
    # Helper extraction
    assert replay.get_first_bullet_text("- Bullet one\n- Bullet two") == "Bullet one"
    assert replay.get_first_bullet_text("* Bullet star\n* Another") == "Bullet star"
    assert replay.get_first_bullet_text("• Bullet dot\n• Another") == "Bullet dot"
    assert (
        replay.get_first_bullet_text("\n\n   - Leading whitespace bullet")
        == "Leading whitespace bullet"
    )
    assert replay.get_first_bullet_text("Prose intro\n- Bullet") == "Prose intro"

    prefix_case = {
        "id": "personal_unknown",
        "required_prefix": "Not in your notes",
    }
    base_stream = {
        "has_malformed_frame": False,
        "terminal_kind": "done",
        "seen_done": True,
        "usage": {"input_tokens": 10, "output_tokens": 10, "web_searches": 0},
    }

    # Pass: prefix is at the first non-empty bullet
    stream_pass = dict(
        base_stream, full_text="- Not in your notes, but according to external docs..."
    )
    ok, reasons = replay.validate_answer_result(stream_pass, prefix_case)
    assert ok is True

    # Pass with asterisk bullet
    stream_pass_star = dict(
        base_stream, full_text="* Not in your notes, but according to external docs..."
    )
    ok, reasons = replay.validate_answer_result(stream_pass_star, prefix_case)
    assert ok is True

    # Fail: prefix appears on second line, not first
    stream_fail_second_line = dict(
        base_stream,
        full_text="- First answer point regarding the cluster.\n- Not in your notes, but extra info.",
    )
    ok, reasons = replay.validate_answer_result(stream_fail_second_line, prefix_case)
    assert ok is False
    assert any("First bullet does not start with required prefix" in r for r in reasons)

    # Fail: intro prose without prefix preceding bullet
    stream_fail_prose = dict(
        base_stream,
        full_text="Here is some general information.\n- Not in your notes, but extra info.",
    )
    ok, reasons = replay.validate_answer_result(stream_fail_prose, prefix_case)
    assert ok is False
    assert any("First bullet does not start with required prefix" in r for r in reasons)

    # Fail: different prefix altogether
    stream_fail_different = dict(
        base_stream, full_text="- In your notes: cluster backup is 14 days."
    )
    ok, reasons = replay.validate_answer_result(stream_fail_different, prefix_case)
    assert ok is False
    assert any("First bullet does not start with required prefix" in r for r in reasons)


def test_rapid_pair_assertions_and_continuity():
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    rapid_case = next(c for c in manifest_data["cases"] if c["id"] == "rapid_pair")
    q2_case = rapid_case["rapid_second_question"]

    # Q1 expects "9102"
    assert rapid_case.get("required_phrase") == "9102"
    # Q2 expects "50 connections"
    assert q2_case.get("required_phrase") == "50 connections"

    base_stream = {
        "has_malformed_frame": False,
        "terminal_kind": "done",
        "seen_done": True,
        "usage": {"input_tokens": 15, "output_tokens": 10, "web_searches": 0},
    }

    # Q1 valid vs invalid
    q1_ok_stream = dict(
        base_stream, full_text="- The metrics exporter listens on TCP port 9102."
    )
    ok1, _ = replay.validate_answer_result(q1_ok_stream, rapid_case)
    assert ok1 is True

    q1_bad_stream = dict(
        base_stream, full_text="- The metrics exporter listens on TCP port 8080."
    )
    ok1_bad, reasons1 = replay.validate_answer_result(q1_bad_stream, rapid_case)
    assert ok1_bad is False
    assert any("9102" in r for r in reasons1)

    # Q2 valid vs invalid
    q2_ok_stream = dict(
        base_stream, full_text="- Postgres maximum pool size is set to 50 connections."
    )
    ok2, _ = replay.validate_answer_result(q2_ok_stream, q2_case)
    assert ok2 is True

    q2_bad_stream = dict(
        base_stream, full_text="- Postgres maximum pool size is set to 10 connections."
    )
    ok2_bad, reasons2 = replay.validate_answer_result(q2_bad_stream, q2_case)
    assert ok2_bad is False
    assert any("50 connections" in r for r in reasons2)


def test_temporal_continuity_calculation():
    # Answer window: [100.0, 110.0]
    ans_start = 100.0
    ans_end = 110.0

    samples = [
        # Completed before answer window
        {"request_start_perf": 95.0, "request_end_perf": 99.0, "success": True},
        # Completed during answer window
        {"request_start_perf": 98.0, "request_end_perf": 102.0, "success": True},
        # Completed strictly inside answer window
        {"request_start_perf": 103.0, "request_end_perf": 107.0, "success": True},
        # Completed after answer window
        {"request_start_perf": 108.0, "request_end_perf": 112.0, "success": True},
    ]

    for s in samples:
        s["during_answer"] = ans_start <= s["request_end_perf"] <= ans_end

    assert samples[0]["during_answer"] is False
    assert samples[1]["during_answer"] is True
    assert samples[2]["during_answer"] is True
    assert samples[3]["during_answer"] is False

    # Continuity check: >=1 success and 0 errors during answer
    bg_during = [s for s in samples if s["during_answer"]]
    successes = sum(1 for s in bg_during if s["success"])
    errors = sum(1 for s in bg_during if not s["success"])
    assert (successes >= 1) and (errors == 0)
    assert replay.aggregate_feed_continuity([]) is False
    assert (
        replay.aggregate_feed_continuity(
            [{"status": "skipped_tts", "feed_continued_during_answer": None}]
        )
        is False
    )
    assert (
        replay.aggregate_feed_continuity(
            [{"status": "passed", "feed_continued_during_answer": True}]
        )
        is True
    )


def test_partial_tts_status_aggregation():
    # When any eligible case has skipped_tts, overall status must be incomplete
    case_results_partial_tts = [
        {
            "id": "personal_known",
            "status": "passed",
            "feed_continued_during_answer": True,
        },
        {"id": "followup", "status": "skipped_tts", "reason": "TTS unavailable"},
    ]
    had_tts_skip = any(
        c.get("status") == "skipped_tts" for c in case_results_partial_tts
    )
    passed_count = sum(
        1 for c in case_results_partial_tts if c.get("status") == "passed"
    )
    failed_count = sum(
        1 for c in case_results_partial_tts if c.get("status") == "failed"
    )

    if had_tts_skip:
        overall_status = "incomplete"
    elif failed_count == 0 and passed_count > 0:
        overall_status = "passed"
    else:
        overall_status = "failed"

    assert had_tts_skip is True
    assert overall_status == "incomplete"
    assert overall_status != "passed"


def test_cadence_ms_validation(capsys):
    with patch("sys.argv", ["replay.py", "--cadence-ms", "0"]):
        ret = replay.main()
        assert ret == 1
        captured = capsys.readouterr()
        assert "--cadence-ms must be greater than 0" in captured.err

    with patch("sys.argv", ["replay.py", "--cadence-ms", "-50"]):
        ret = replay.main()
        assert ret == 1
        captured = capsys.readouterr()
        assert "--cadence-ms must be greater than 0" in captured.err


def test_interruption_and_error_replacement(tmp_path):
    output_file = tmp_path / "result.json"
    secret_token = "secret_api_key_xyz123"

    # Write initial running status
    initial_running = {
        "status": "running",
        "timestamp": replay.iso_now(),
        "summary": {"status": "running"},
    }
    replay.write_json_atomically(output_file, initial_running)
    assert output_file.is_file()
    with open(output_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data["status"] == "running"

    # Simulate KeyboardInterrupt overwrite
    interrupted_report = {
        "status": "interrupted",
        "reason": "Execution interrupted by SIGINT",
        "timestamp": replay.iso_now(),
        "summary": {"status": "interrupted"},
    }
    replay.write_json_atomically(
        output_file,
        replay.redact_secrets(interrupted_report, [secret_token]),
    )
    with open(output_file, "r", encoding="utf-8") as f:
        data_int = json.load(f)
    assert data_int["status"] == "interrupted"

    # Simulate error overwrite with secret and path redaction
    error_report = {
        "status": "error",
        "error": f"Failed with {secret_token} while writing /Users/mhlaghari/private/tmp/file.txt",
        "timestamp": replay.iso_now(),
        "summary": {"status": "error"},
    }
    replay.write_json_atomically(
        output_file,
        replay.redact_secrets(error_report, [secret_token]),
    )
    with open(output_file, "r", encoding="utf-8") as f:
        data_err = json.load(f)
    assert data_err["status"] == "error"
    assert secret_token not in data_err["error"]
    assert "/Users/mhlaghari" not in data_err["error"]
    assert "[REDACTED]" in data_err["error"]
    assert "[PATH]" in data_err["error"]

    # The real CLI must replace a stale pass before network readiness and
    # persist an interruption if readiness is cancelled.
    output_file.write_text('{"status":"passed"}\n', encoding="utf-8")
    argv = [
        "replay.py",
        "--model",
        "qwen3.5:4b",
        "--manifest",
        str(MANIFEST_PATH),
        "--output",
        str(output_file),
    ]
    with (
        patch("sys.argv", argv),
        patch("replay.check_service_health", side_effect=KeyboardInterrupt),
    ):
        assert replay.main() == 130
    assert (
        json.loads(output_file.read_text(encoding="utf-8"))["status"] == "interrupted"
    )

    # The readiness probe is covered by the same outer state boundary.
    output_file.write_text('{"status":"passed"}\n', encoding="utf-8")
    with (
        patch("sys.argv", argv),
        patch("replay.check_service_health", return_value=(True, "ready")),
        patch("replay.check_local_model_readiness", side_effect=KeyboardInterrupt),
    ):
        assert replay.main() == 130
    assert (
        json.loads(output_file.read_text(encoding="utf-8"))["status"] == "interrupted"
    )
