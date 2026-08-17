"""Model-agnostic output robustness: what the summarizer does with a reply that
isn't clean JSON.

Live incident 2026-08-10 that this exists for: a verbose reasoning model
(muse-glimmer:30b-mlx) wrote a near-perfect note that the 16,384 num_ctx window
cut off one closing brace short. The parse failed, the raw JSON blob was shown to
the user AS their meeting note, and a second path blamed the transcript for being
"too short or sparse" — on a 40-minute meeting.
"""

from __future__ import annotations

import importlib
import json
import logging
import pathlib
import sys
from unittest.mock import MagicMock

import pytest

# Mock ollama before any import that might trigger it (see test_summarizer.py)
_fake_ollama = MagicMock()
_fake_client_instance = MagicMock()
_fake_ollama.Client.return_value = _fake_client_instance
sys.modules["ollama"] = _fake_ollama

import src.summarizer  # noqa: E402

importlib.reload(src.summarizer)

from src.summarizer import (  # noqa: E402
    DEFAULT_NUM_CTX,
    NUM_CTX_FLOOR,
    OllamaSummarizer,
    _adaptive_num_ctx,
    _first_balanced_object,
    _hardware_num_ctx_cap,
    _looks_like_json_notes,
    _model_max_ctx,
    _ollama_options,
    _prompt_chars,
    _repair_truncated_json,
    _retry_num_ctx,
    _strip_think,
    normalize_model_output,
)

#: The reply from the live incident, cut off exactly one closing brace short.
LIVE_INCIDENT_REPLY = (
    '{"title": "Q3 Planning", "category": "meeting", '
    '"attendees": [{"name": "Sarah", "role": "CTO", "company": "Acme"}], '
    '"sections": [{"heading": "Decisions", "bullets": '
    '["Ship the beta on the 14th", "Hold pricing at $12 per seat"]}]'
)

#: Long enough that "the transcript may be too short or sparse" is a lie.
LONG_TRANSCRIPT = "Them: we walked through the whole roadmap in detail. " * 60
SHORT_TRANSCRIPT = "Me: hi. Them: hi."


def _summarizer(reply: str) -> OllamaSummarizer:
    """A summarizer whose single completion returns ``reply``."""
    s = OllamaSummarizer(model="test-model", host="http://localhost:11434")
    s._chat = MagicMock(return_value=reply)
    return s


#: Real ``POST /api/show`` responses, captured 2026-08-10 from Ollama 0.32.7 on
#: this machine (license/modelfile/template/tensors stripped — everything the
#: sizing code reads is verbatim). Pins the architecture-prefixed context key so
#: the parser is tested against the API's real shape, not an imagined one.
_SHOW_FIXTURE: dict[str, dict] = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "ollama_show.json").read_text()
)


def _show_response(model: str) -> dict:
    """The captured ``/api/show`` body for ``model``."""
    return _SHOW_FIXTURE[model]


class TestReasoningBlockStripping:
    """Thinking models put their chain-of-thought in front of the answer, in
    <think> or <thinking> depending on the family. It must never reach the parser
    — or the user."""

    def test_balanced_block_before_json(self) -> None:
        raw = '<think>The user wants notes.</think>{"title": "T"}'
        assert normalize_model_output(raw) == '{"title": "T"}'

    def test_thinking_tag_variant(self) -> None:
        raw = '<thinking>\nplanning the note\n</thinking>\n{"title": "T"}'
        assert normalize_model_output(raw) == '{"title": "T"}'

    def test_several_blocks(self) -> None:
        raw = "<think>first</think>\n<think>second</think>\nThe budget is 50k."
        assert _strip_think(raw) == "The budget is 50k."

    def test_closing_tag_only(self) -> None:
        """Some chat templates open the block for the model, so only the closer
        comes back — everything before it is reasoning."""
        raw = 'Let me work through the transcript...</think>{"title": "T"}'
        assert normalize_model_output(raw) == '{"title": "T"}'

    def test_unclosed_opening_tag_keeps_the_answer(self) -> None:
        """Cutting to end-of-string on an unclosed tag would delete the reply."""
        raw = "<think>reasoning that never closed, and the answer trails it"
        assert "the answer trails it" in _strip_think(raw)

    def test_no_block_is_untouched(self) -> None:
        assert _strip_think("Plain answer.") == "Plain answer."


class TestFenceHandling:
    """Models fence their answer even when told not to, and not always at the
    start — the old leading-fence-only strip missed everything else."""

    def test_fence_after_prose(self) -> None:
        raw = 'Here are your notes:\n\n```json\n{"title": "T"}\n```\n\nHope that helps!'
        assert json.loads(normalize_model_output(raw)) == {"title": "T"}

    def test_bare_fence(self) -> None:
        raw = '```\n{"title": "T"}\n```'
        assert json.loads(normalize_model_output(raw)) == {"title": "T"}

    def test_unterminated_fence_still_yields_its_body(self) -> None:
        """Cut off inside the fence: the body still goes to the repair ladder."""
        raw = '```json\n{"title": "T", "sections": ['
        assert normalize_model_output(raw) == '{"title": "T", "sections": ['

    def test_non_json_fence_is_left_alone(self) -> None:
        raw = "Here is a snippet:\n\n```python\nprint('hi')\n```"
        assert normalize_model_output(raw) == raw


class TestProseEmbeddedJson:
    """A balanced object amid prose is the answer; prose that merely mentions a
    brace is a note and must stay one."""

    def test_object_between_prose(self) -> None:
        raw = 'Here is your summary: {"title": "T", "sections": []} Let me know!'
        assert json.loads(normalize_model_output(raw)) == {"title": "T", "sections": []}

    def test_trailing_prose_after_the_object(self) -> None:
        raw = '{"title": "T"}\n\nI hope this captures the meeting.'
        assert json.loads(normalize_model_output(raw)) == {"title": "T"}

    def test_brace_inside_a_string_does_not_close_the_object(self) -> None:
        raw = 'Notes: {"title": "Pricing {tiers} review", "sections": []} done'
        assert json.loads(normalize_model_output(raw))["title"] == "Pricing {tiers} review"

    def test_prose_mentioning_braces_stays_prose(self) -> None:
        raw = "We agreed to use {placeholder} syntax in the docs."
        assert normalize_model_output(raw) == raw
        assert _first_balanced_object(raw) is None

    def test_unterminated_object_is_not_extraction(self) -> None:
        """An object that never closes is truncation — the repair step's job, and
        never an excuse to return a nested fragment as the whole note."""
        assert _first_balanced_object(LIVE_INCIDENT_REPLY) is None


class TestTruncationRepair:
    """Conservative tail repair: keep what was written, never guess content."""

    def test_missing_final_brace_the_live_incident(self, caplog) -> None:
        with caplog.at_level(logging.WARNING):
            data = _repair_truncated_json(LIVE_INCIDENT_REPLY)
        assert data is not None
        assert data["title"] == "Q3 Planning"
        assert data["sections"][0]["bullets"][1] == "Hold pricing at $12 per seat"
        assert "repaired 1 unclosed scopes" in caplog.text

    def test_cut_mid_string(self) -> None:
        raw = '{"title": "Q3 Planning", "sections": [{"heading": "Decisions", "bullets": ["Ship the bet'
        data = _repair_truncated_json(raw)
        assert data["sections"][0]["bullets"] == ["Ship the bet"]

    def test_cut_mid_key_drops_the_unfinished_member(self) -> None:
        raw = '{"title": "Q3 Planning", "attendees": [], "sections":'
        data = _repair_truncated_json(raw)
        assert data == {"title": "Q3 Planning", "attendees": []}

    def test_trailing_comma(self) -> None:
        raw = '{"title": "Q3 Planning", "sections": [{"heading": "Risks"},'
        data = _repair_truncated_json(raw)
        assert data["sections"] == [{"heading": "Risks"}]

    def test_escaped_quote_before_the_cut(self) -> None:
        raw = '{"title": "Ops", "sections": [{"heading": "Notes", "bullets": ["He said \\"ship it'
        data = _repair_truncated_json(raw)
        assert data["sections"][0]["bullets"] == ['He said "ship it']

    def test_balanced_but_malformed_is_not_repaired(self) -> None:
        """Nothing was left open, so this is a malformed reply, not a cut-off one —
        inventing a fix for it would be guessing."""
        assert _repair_truncated_json('{"title": "T",, "sections": []}') is None

    def test_valid_json_is_not_repair_material(self) -> None:
        assert _repair_truncated_json('{"title": "T"}') is None

    def test_non_object_reply_is_not_repaired(self) -> None:
        assert _repair_truncated_json("[1, 2, 3") is None

    def test_looks_like_json_notes(self) -> None:
        assert _looks_like_json_notes('  {"title": "T"')
        assert _looks_like_json_notes('garbage "sections" garbage')
        assert not _looks_like_json_notes("## Meeting notes\n\n- We shipped it.")


class TestSummarizeFallbackTaxonomy:
    """What the user is told when the reply can't be parsed. Three distinct
    outcomes; the 2026-08-10 incident produced the wrong one for all three."""

    def test_truncated_reply_is_repaired_into_real_notes(self) -> None:
        """End-to-end for the live incident: the note is the note, not a blob."""
        s = _summarizer(LIVE_INCIDENT_REPLY)
        result = s.summarize(LONG_TRANSCRIPT)
        assert result.title == "Q3 Planning"
        assert "Ship the beta on the 14th" in result.summary
        assert "Sarah — CTO" in result.attendees
        assert "{" not in result.summary

    def test_prose_reply_is_kept_as_the_note(self) -> None:
        """A readable markdown note beats an error, even though we asked for JSON."""
        prose = "## Meeting notes\n\n- We agreed to ship on the 14th."
        result = _summarizer(prose).summarize(LONG_TRANSCRIPT)
        assert result.summary == prose

    def test_prose_reply_has_its_reasoning_stripped(self) -> None:
        result = _summarizer("<think>hmm</think>## Notes\n\n- Shipped.").summarize(
            LONG_TRANSCRIPT
        )
        assert result.summary == "## Notes\n\n- Shipped."

    def test_json_garbage_is_never_dumped_as_the_note(self) -> None:
        """Balanced but malformed: nothing was cut off, so the honest verdict is
        that the model's answer was unreadable — never the blob itself."""
        garbage = '{"title": "T",, "sections": []}'
        result = _summarizer(garbage).summarize(LONG_TRANSCRIPT)
        assert garbage not in result.summary
        assert "didn't return structured notes" in result.summary

    def test_unrepairable_truncation_says_so(self) -> None:
        """Cut off so early there is nothing to render — the window is the cause,
        and the message must name it."""
        result = _summarizer('{"title": "Q3 Pla').summarize(LONG_TRANSCRIPT)
        assert "didn't fit its response window" in result.summary
        assert "too short or sparse" not in result.summary

    def test_short_transcript_still_gets_the_sparse_message(self) -> None:
        result = _summarizer("{}").summarize(SHORT_TRANSCRIPT)
        assert "too short or sparse" in result.summary

    def test_long_transcript_is_never_called_sparse(self) -> None:
        """The wrong diagnosis from the live incident: a huge transcript blamed
        for a model failure."""
        result = _summarizer("{}").summarize(LONG_TRANSCRIPT)
        assert "too short or sparse" not in result.summary
        assert "didn't return structured notes" in result.summary

    def test_reasoning_block_before_json_still_parses(self) -> None:
        s = _summarizer('<think>planning</think>{"title": "T", "sections": []}')
        assert s.summarize(LONG_TRANSCRIPT).title == "T"

    def test_fenced_json_after_prose_still_parses(self) -> None:
        s = _summarizer('Sure!\n```json\n{"title": "T", "sections": []}\n```')
        assert s.summarize(LONG_TRANSCRIPT).title == "T"


class TestTruncationRetry:
    """done_reason/finish_reason == "length" means the model was still writing.
    Re-ask once with a bigger window; never hand a fragment downstream silently."""

    @pytest.fixture(autouse=True)
    def _roomy_hardware(self, monkeypatch):
        """Pin the RAM tier so these assertions don't depend on the test box."""
        monkeypatch.setattr(src.summarizer, "_hardware_cap_cache", 65536)
        monkeypatch.setattr(src.summarizer, "NUM_CTX_RETRY_CAP", None)

    @staticmethod
    def _ollama() -> OllamaSummarizer:
        s = OllamaSummarizer(model="muse-glimmer:30b-mlx", host="http://localhost:11434")
        s.client.chat.reset_mock()
        s.client.chat.side_effect = None
        return s

    def test_length_retries_once_with_doubled_num_ctx(self) -> None:
        s = self._ollama()
        s.client.chat.side_effect = [
            {"message": {"content": LIVE_INCIDENT_REPLY}, "done_reason": "length"},
            {
                "message": {"content": '{"title": "Q3 Planning", "sections": []}'},
                "done_reason": "stop",
            },
        ]

        result = s.summarize(LONG_TRANSCRIPT)

        calls = s.client.chat.call_args_list
        assert len(calls) == 2, "exactly one retry"
        # This transcript is short, so the first attempt sits on the floor…
        assert calls[0].kwargs["options"]["num_ctx"] == DEFAULT_NUM_CTX
        # …and the retry doubles whatever the first attempt actually used.
        assert calls[1].kwargs["options"]["num_ctx"] == DEFAULT_NUM_CTX * 2
        assert result.title == "Q3 Planning"  # the retry's answer is the one used

    def test_retry_doubles_from_the_actual_first_attempt_ctx(self) -> None:
        """Not from a fixed 16,384: a long meeting starts high and doubles high."""
        assert _retry_num_ctx(24576) == 49152
        assert _retry_num_ctx(32768) == 65536

    def test_retry_is_capped_by_the_hardware_tier(self, monkeypatch) -> None:
        monkeypatch.setattr(src.summarizer, "_hardware_cap_cache", 32768)
        assert _retry_num_ctx(16384) == 32768
        assert _retry_num_ctx(32768) is None, "already at the cap — no third attempt"
        assert _retry_num_ctx(20000) == 32768, "the double is clamped, not skipped"

    def test_env_retry_cap_overrides_the_hardware_tier(self, monkeypatch) -> None:
        monkeypatch.setattr(src.summarizer, "NUM_CTX_RETRY_CAP", 32768)
        assert _retry_num_ctx(16384) == 32768
        assert _retry_num_ctx(32768) is None

    def test_no_retry_at_the_cap_but_the_note_is_honest(self, monkeypatch) -> None:
        monkeypatch.setattr(src.summarizer, "NUM_CTX_RETRY_CAP", DEFAULT_NUM_CTX)
        s = self._ollama()
        s.client.chat.return_value = {
            "message": {"content": '{"title": "Q3 Pla'},
            "done_reason": "length",
        }

        result = s.summarize(LONG_TRANSCRIPT)

        assert len(s.client.chat.call_args_list) == 1
        assert "didn't fit its response window" in result.summary

    def test_normal_stop_does_not_retry(self) -> None:
        s = self._ollama()
        s.client.chat.return_value = {
            "message": {"content": '{"title": "T", "sections": []}'},
            "done_reason": "stop",
        }

        s.summarize(LONG_TRANSCRIPT)

        assert len(s.client.chat.call_args_list) == 1

    def test_missing_done_reason_does_not_retry(self) -> None:
        """Older Ollama servers omit the field entirely."""
        s = self._ollama()
        s.client.chat.return_value = {"message": {"content": '{"title": "T"}'}}

        s.summarize(LONG_TRANSCRIPT)

        assert len(s.client.chat.call_args_list) == 1

    def test_openai_length_is_reported_not_retried(self, monkeypatch) -> None:
        """The OpenAI chat API has no num_ctx to raise, so a retry would repeat
        the same call against the same limit — report it instead."""
        posts = []

        class FakeResp:
            status_code = 200

            def raise_for_status(self) -> None:
                pass

            def json(self) -> dict:
                return {
                    "choices": [
                        {"message": {"content": '{"title": "Q3 Pla'}, "finish_reason": "length"}
                    ]
                }

        def fake_post(url, json=None, headers=None, timeout=None):
            posts.append(url)
            return FakeResp()

        monkeypatch.setattr("httpx.post", fake_post)
        s = OllamaSummarizer(model="qwen3.6-27b", backend="openai")

        result = s.summarize(LONG_TRANSCRIPT)

        assert len(posts) == 1
        assert "didn't fit its response window" in result.summary


@pytest.mark.parametrize(
    "reply",
    [
        LIVE_INCIDENT_REPLY,
        '<think>reasoning</think>' + LIVE_INCIDENT_REPLY,
        '```json\n' + LIVE_INCIDENT_REPLY,
        'Here you go:\n' + LIVE_INCIDENT_REPLY,
    ],
)
def test_every_wrapper_around_the_truncated_incident_recovers(reply: str) -> None:
    """The ladder composes: reasoning block, fence, and prose prefix all resolve
    to the same salvaged note."""
    result = _summarizer(reply).summarize(LONG_TRANSCRIPT)
    assert result.title == "Q3 Planning"
    assert "Hold pricing at $12 per seat" in result.summary


class TestAdaptiveNumCtx:
    """The context window sizes itself per request — no setting, no env var.

    Founder requirement: "I'm not going to do anything in the back settings.
    Neither are the people who will use this. If it's Qwen, Gemma, or Muse, it
    should work for all." A fixed 16,384 is what truncated a long meeting under a
    verbose reasoning model on 2026-08-10.
    """

    @pytest.fixture(autouse=True)
    def _isolated(self, monkeypatch):
        """Pin the RAM tier and clear the per-model cache for every case."""
        monkeypatch.setattr(src.summarizer, "_hardware_cap_cache", 65536)
        monkeypatch.setattr(src.summarizer, "NUM_CTX_PIN", None)
        monkeypatch.setattr(src.summarizer, "_model_max_ctx_cache", {})

    def test_short_prompt_gets_the_floor(self) -> None:
        assert _adaptive_num_ctx(500) == NUM_CTX_FLOOR
        assert _adaptive_num_ctx(0) == NUM_CTX_FLOOR

    def test_long_prompt_grows_past_the_floor(self) -> None:
        # 90k chars ≈ 30k tokens at the conservative 3 chars/token, + 8k budget.
        assert _adaptive_num_ctx(90_000) == 38912
        assert _adaptive_num_ctx(90_000) > NUM_CTX_FLOOR

    def test_sizing_rounds_up_to_the_step(self) -> None:
        # 3001 chars → ceil(3001/3)=1001 tokens + 8192 = 9193 → floor anyway;
        # use a size above the floor to see the rounding itself.
        for chars in (60_000, 60_003, 60_600):
            assert _adaptive_num_ctx(chars) % 2048 == 0

    def test_output_budget_is_reserved_on_top_of_the_prompt(self) -> None:
        """The window always leaves room for thinking tokens + the note."""
        chars = 120_000
        assert _adaptive_num_ctx(chars) >= chars / 3 + 8192

    def test_hardware_tier_caps_a_huge_prompt(self, monkeypatch) -> None:
        monkeypatch.setattr(src.summarizer, "_hardware_cap_cache", 24576)
        assert _adaptive_num_ctx(1_000_000) == 24576

    def test_ram_tiers(self, monkeypatch) -> None:
        """<16 GB → 16384, <32 → 24576, <64 → 32768, ≥64 → 65536."""
        for gib, expected in ((8, 16384), (16, 24576), (18, 24576), (36, 32768), (64, 65536), (128, 65536)):
            monkeypatch.setattr(src.summarizer, "_hardware_cap_cache", None)
            monkeypatch.setattr(
                src.summarizer, "_total_ram_bytes", lambda gib=gib: gib * 1024**3
            )
            assert _hardware_num_ctx_cap() == expected, f"{gib} GiB"

    def test_unreadable_ram_falls_back_to_the_floor(self, monkeypatch) -> None:
        monkeypatch.setattr(src.summarizer, "_hardware_cap_cache", None)
        monkeypatch.setattr(src.summarizer, "_total_ram_bytes", lambda: None)
        assert _hardware_num_ctx_cap() == NUM_CTX_FLOOR
        # …and a huge prompt on that machine is clamped to it, not to a guess.
        monkeypatch.setattr(src.summarizer, "_hardware_cap_cache", None)
        assert _adaptive_num_ctx(1_000_000) == NUM_CTX_FLOOR

    def test_model_max_binds_when_it_is_the_smallest(self) -> None:
        client = MagicMock()
        client.show.return_value = _show_response("llama3:8b")  # 8192 trained ctx
        # model_max (8192) < floor, so the floor still wins — nothing regresses.
        assert _adaptive_num_ctx(1_000_000, "llama3:8b", client) == NUM_CTX_FLOOR

        client2 = MagicMock()
        client2.show.return_value = _show_response("muse-glimmer:30b-mlx")  # 131072
        # Under the hardware cap of 65536, the hardware tier binds instead.
        assert _adaptive_num_ctx(1_000_000, "muse-glimmer:30b-mlx", client2) == 65536

    def test_model_max_below_the_hardware_cap_binds(self, monkeypatch) -> None:
        monkeypatch.setattr(src.summarizer, "_hardware_cap_cache", 65536)
        client = MagicMock()
        client.show.return_value = {"model_info": {"gemma4.context_length": 32768}}
        assert _adaptive_num_ctx(1_000_000, "gemma4:31b", client) == 32768

    def test_env_pin_wins_over_everything(self, monkeypatch) -> None:
        monkeypatch.setattr(src.summarizer, "NUM_CTX_PIN", 4096)
        assert _adaptive_num_ctx(1_000_000) == 4096, "the debug pin is exact"
        assert _adaptive_num_ctx(10) == 4096

    def test_prompt_chars_counts_every_message(self) -> None:
        messages = [
            {"role": "system", "content": "abc"},
            {"role": "user", "content": "defg"},
            {"role": "assistant"},  # tolerated: no content key
        ]
        assert _prompt_chars(messages) == 7

    def test_a_long_meeting_is_sized_right_on_the_first_attempt(self) -> None:
        """The regression the whole change exists for: no retry, no repair."""
        s = OllamaSummarizer(model="muse-glimmer:30b-mlx", host="http://localhost:11434")
        s.client.chat.reset_mock()
        s.client.chat.side_effect = None
        s.client.show.return_value = _show_response("muse-glimmer:30b-mlx")
        s.client.chat.return_value = {
            "message": {"content": '{"title": "Q3 Planning", "sections": []}'},
            "done_reason": "stop",
        }

        # ~55k chars — a real two-hour meeting transcript.
        s.summarize("Them: we walked through the whole roadmap in detail. " * 1050)

        calls = s.client.chat.call_args_list
        assert len(calls) == 1, "sized right the first time — no retry needed"
        assert calls[0].kwargs["options"]["num_ctx"] >= 20480


class TestOllamaShowShape:
    """Pins the REAL /api/show field naming, captured from the Ollama running on
    this machine (0.32.7, 2026-08-10) with:

        curl -s localhost:11434/api/show -d '{"model":"qwen3.5:2b"}'

    The context key is architecture-PREFIXED — `qwen35.context_length`,
    `muse_glimmer.context_length`, `llama.context_length` — never a flat
    `context_length`, which is why this is a fixture and not a guess.
    """

    @pytest.fixture(autouse=True)
    def _clear_cache(self, monkeypatch):
        monkeypatch.setattr(src.summarizer, "_model_max_ctx_cache", {})

    @pytest.mark.parametrize(
        ("model", "expected"),
        [
            ("qwen3.5:2b", 262144),
            ("muse-glimmer:30b-mlx", 131072),
            ("llama3:8b", 8192),
        ],
    )
    def test_reads_the_architecture_prefixed_context_length(
        self, model: str, expected: int
    ) -> None:
        client = MagicMock()
        client.show.return_value = _show_response(model)
        assert _model_max_ctx(model, client) == expected

    def test_reads_the_python_client_attribute_shape(self) -> None:
        """ollama-python 0.6.2 returns ShowResponse.modelinfo, not ['model_info']."""

        class FakeShowResponse:
            modelinfo = _SHOW_FIXTURE["qwen3.5:2b"]["model_info"]

        client = MagicMock()
        client.show.return_value = FakeShowResponse()
        assert _model_max_ctx("qwen3.5:2b", client) == 262144

    def test_unknown_architecture_falls_back_to_the_suffix_scan(self) -> None:
        client = MagicMock()
        client.show.return_value = {"model_info": {"brandnew.context_length": 40960}}
        assert _model_max_ctx("brandnew:1b", client) == 40960

    def test_show_failure_drops_the_bound(self) -> None:
        client = MagicMock()
        client.show.side_effect = ConnectionError("ollama is down")
        assert _model_max_ctx("qwen3.5:2b", client) is None

    def test_missing_field_drops_the_bound(self) -> None:
        client = MagicMock()
        client.show.return_value = {"model_info": {"general.architecture": "qwen35"}}
        assert _model_max_ctx("qwen3.5:2b", client) is None

    def test_result_is_cached_per_model(self) -> None:
        client = MagicMock()
        client.show.return_value = _show_response("llama3:8b")
        assert _model_max_ctx("llama3:8b", client) == 8192
        assert _model_max_ctx("llama3:8b", client) == 8192
        assert client.show.call_count == 1, "asked Ollama once, then remembered"


class TestOllamaOptionsInvariants:
    """The two never-rely-on-a-default invariants, pinned together.

    num_ctx: absent -> the model loads at its own default window (262k = a
    16 GB runner, live 2026-08-02). num_predict: absent -> this path's
    effective default cut muse-glimmer at ~5k output tokens while reporting
    done_reason="stop" (live 2026-08-11); -1 makes the deliberately sized
    window the only output bound, and overflowing it reports "length"
    honestly — which is what the truncation retry keys on.
    """

    def test_options_always_carry_num_ctx_and_unlimited_num_predict(self) -> None:
        options = _ollama_options(16384)
        assert options["num_ctx"] == 16384
        assert options["num_predict"] == -1
