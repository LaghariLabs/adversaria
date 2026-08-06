"""Tests for the OllamaSummarizer module."""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

# Mock ollama before any import that might trigger it
_fake_ollama = MagicMock()
_fake_client_instance = MagicMock()
_fake_ollama.Client.return_value = _fake_client_instance
sys.modules["ollama"] = _fake_ollama

# Reload src.summarizer to pick up the mock (addresses ordering issues when
# test_server.py also mocks ollama at the module level)
import src.summarizer  # noqa: E402
importlib.reload(src.summarizer)

from src.summarizer import OllamaSummarizer  # noqa: E402
from src.models import SummarizeResponse, TemplateInfo  # noqa: E402


# Path to the real prompts directory for template-loading tests
PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


@pytest.fixture
def summarizer() -> OllamaSummarizer:
    """Create an OllamaSummarizer with mocked ollama client."""
    return OllamaSummarizer(model="llama3.1:8b", host="http://localhost:11434")


@pytest.fixture
def mock_chat_response() -> MagicMock:
    """Create a mock chat response from Ollama."""
    response = MagicMock()
    response.__getitem__ = MagicMock(return_value={"content": "**Summary:** This is a test summary."})
    return response


class TestOllamaSummarizerInit:
    """Tests for OllamaSummarizer initialization."""

    def test_init_stores_config(self) -> None:
        """Test __init__ stores model and host configuration."""
        s = OllamaSummarizer(model="custom-model", host="http://custom:1234")
        assert s.model == "custom-model"
        assert s.host == "http://custom:1234"

    def test_init_creates_client(self, summarizer: OllamaSummarizer) -> None:
        """Test __init__ creates an ollama Client."""
        assert summarizer.client is not None


class TestLoadTemplate:
    """Tests for _load_template method."""

    def test_load_template_returns_string(self, summarizer: OllamaSummarizer) -> None:
        """Test _load_template returns a non-empty string."""
        content = summarizer._load_template("general")
        assert isinstance(content, str)
        assert len(content) > 0

    def test_load_template_contains_expected_content(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test _load_template returns content with expected keywords."""
        content = summarizer._load_template("general")
        assert "meeting" in content.lower()

    def test_load_template_missing_raises(self, summarizer: OllamaSummarizer) -> None:
        """Test _load_template raises FileNotFoundError for unknown template."""
        with pytest.raises(FileNotFoundError):
            summarizer._load_template("nonexistent_template_xyz")


class TestListTemplates:
    """Tests for list_templates method."""

    def test_list_templates_returns_list_of_template_info(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test list_templates returns a list of TemplateInfo objects."""
        templates = summarizer.list_templates()
        assert isinstance(templates, list)
        assert len(templates) > 0
        for t in templates:
            assert isinstance(t, TemplateInfo)
            assert isinstance(t.name, str)
            assert isinstance(t.description, str)
            assert len(t.name) > 0
            assert len(t.description) > 0

    def test_list_templates_includes_general(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test list_templates includes the 'general' template."""
        templates = summarizer.list_templates()
        names = {t.name for t in templates}
        assert "general" in names

    def test_list_templates_includes_all_three(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test list_templates includes all three default templates."""
        templates = summarizer.list_templates()
        names = {t.name for t in templates}
        assert "general" in names
        assert "one-on-one" in names
        assert "client-meeting" in names


class TestSummarize:
    """Tests for the summarize method."""

    def test_summarize_returns_correct_type(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize returns a SummarizeResponse."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "This is a summary of the meeting."})
        summarizer.client.chat.return_value = mock_message

        result = summarizer.summarize(
            transcript="Alice: Let's ship by Friday. Bob: Agreed.",
            template_name="general",
        )
        assert isinstance(result, SummarizeResponse)
        assert isinstance(result.summary, str)
        assert isinstance(result.template_used, str)

    def test_summarize_uses_correct_template_name(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize records the template_used field correctly."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "Summary text."})
        summarizer.client.chat.return_value = mock_message

        result = summarizer.summarize(
            transcript="Hello world.",
            template_name="client-meeting",
        )
        assert result.template_used == "client-meeting"

    def test_summarize_empty_transcript_raises(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize raises ValueError for empty transcript."""
        with pytest.raises(ValueError):
            summarizer.summarize(transcript="", template_name="general")

    def test_summarize_whitespace_only_transcript_raises(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize raises ValueError for whitespace-only transcript."""
        with pytest.raises(ValueError):
            summarizer.summarize(transcript="   \n  \t  ", template_name="general")

    def test_summarize_calls_ollama_chat(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize calls the ollama client chat method."""
        summarizer.client.chat.reset_mock()
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "Summary."})
        summarizer.client.chat.return_value = mock_message

        summarizer.summarize(
            transcript="Test transcript.",
            template_name="general",
        )
        summarizer.client.chat.assert_called_once()

    def test_summarize_injects_transcript_into_prompt(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize passes the transcript in the user message."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "Summary."})
        summarizer.client.chat.return_value = mock_message

        transcript = "Alice: We need to push the launch to August 15."
        summarizer.summarize(transcript=transcript, template_name="general")

        call_args = summarizer.client.chat.call_args
        messages = call_args[1]["messages"]
        user_message = messages[1]["content"]
        assert "Alice" in user_message
        assert "August 15" in user_message

    def test_summarize_sets_num_ctx_and_temperature(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize passes num_ctx (anti-truncation) and temperature=0."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "Summary."})
        summarizer.client.chat.return_value = mock_message

        summarizer.summarize(transcript="Test transcript.", template_name="general")

        options = summarizer.client.chat.call_args[1]["options"]
        assert options["num_ctx"] >= 8192
        assert options["temperature"] == 0.0

    def test_summarize_does_not_duplicate_template_in_both_messages(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """System holds the instructions; user holds only the transcript."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "Summary."})
        summarizer.client.chat.return_value = mock_message

        transcript = "Me: Ship Friday. Them: Agreed."
        summarizer.summarize(transcript=transcript, template_name="general")

        messages = summarizer.client.chat.call_args[1]["messages"]
        system_msg, user_msg = messages[0]["content"], messages[1]["content"]
        # User message is only the (delimited) transcript, not the template.
        assert transcript in user_msg
        assert "{{transcript}}" not in system_msg
        assert "{{transcript}}" not in user_msg
        # The instructions are not duplicated into the user message.
        assert "expert meeting note taker" in system_msg.lower()
        assert "expert meeting note taker" not in user_msg.lower()

    def test_summarize_passes_structured_output_schema(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize constrains output with the MeetingNotes JSON schema."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "{}"})
        summarizer.client.chat.return_value = mock_message

        summarizer.summarize(transcript="Me: hi. Them: hi.", template_name="general")

        fmt = summarizer.client.chat.call_args[1]["format"]
        assert isinstance(fmt, dict)
        props = fmt.get("properties", {})
        assert {"title", "attendees", "sections"} <= set(props.keys())

    def test_summarize_parses_structured_notes(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize parses structured JSON into title, attendees, markdown."""
        notes = {
            "title": "Sprint planning sync",
            "attendees": [
                {"name": "Me", "role": None},
                {"name": "Sarah", "role": "Designer"},
            ],
            "sections": [
                {"heading": "Decisions Made", "bullets": ["Postpone mobile release"]},
                {"heading": "Action Items", "bullets": []},
            ],
        }
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": json.dumps(notes)})
        summarizer.client.chat.return_value = mock_message

        result = summarizer.summarize(
            transcript="Me: let's postpone. Them: agreed.", template_name="general"
        )
        assert result.title == "Sprint planning sync"
        # 'Me'/'Them' are generic speaker labels, not real attendees → filtered out.
        assert "Me" not in result.attendees
        assert "Sarah — Designer" in result.attendees
        assert "**Decisions Made**" in result.summary
        assert "Postpone mobile release" in result.summary
        # Empty section renders the grounded placeholder, not a fabrication.
        assert "None mentioned" in result.summary

    def test_summarize_tolerates_section_field_variants(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Larger models sometimes key sections as 'title'/'points'; parse anyway."""
        notes = {
            "title": "Planning sync",
            "attendees": [{"name": "Me", "role": None}],
            "sections": [
                {"title": "Decisions Made", "points": ["Ship Friday"]},
            ],
        }
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": json.dumps(notes)})
        summarizer.client.chat.return_value = mock_message

        result = summarizer.summarize(transcript="Me: ship friday.", template_name="general")
        assert result.title == "Planning sync"
        assert "**Decisions Made**" in result.summary
        assert "Ship Friday" in result.summary

    def test_summarize_unwraps_nested_envelope(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Some models (qwen3.6) ignore the schema and nest notes under a
        single wrapper key, e.g. {"meeting_notes": {...}}. Descend into it
        rather than degrading to raw JSON text."""
        notes = {
            "meeting_notes": {
                "title": "Planning sync",
                "attendees": [{"name": "Me", "role": None}],
                "sections": [
                    {"title": "Decisions Made", "bullets": ["Ship Friday"]},
                ],
            }
        }
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": json.dumps(notes)})
        summarizer.client.chat.return_value = mock_message

        result = summarizer.summarize(transcript="Me: ship friday.", template_name="general")
        assert result.title == "Planning sync"
        # 'Me' is a generic speaker label, not a real attendee → filtered out.
        assert "Me" not in result.attendees
        assert "**Decisions Made**" in result.summary
        assert "Ship Friday" in result.summary

    def test_summarize_adds_arabic_language_directive(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """output_language='ar' appends an Arabic directive to the system prompt."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "{}"})
        summarizer.client.chat.return_value = mock_message

        summarizer.summarize(
            transcript="Me: hello.", template_name="general", output_language="ar"
        )
        system_prompt = summarizer.client.chat.call_args[1]["messages"][0]["content"]
        assert "Arabic" in system_prompt

    def test_summarize_no_language_directive_by_default(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """No output_language leaves the prompt free of an OUTPUT LANGUAGE directive."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "{}"})
        summarizer.client.chat.return_value = mock_message

        summarizer.summarize(transcript="Me: hello.", template_name="general")
        system_prompt = summarizer.client.chat.call_args[1]["messages"][0]["content"]
        assert "OUTPUT LANGUAGE" not in system_prompt

    def test_summarize_adds_date_context_when_given(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """meeting_date puts a single DATE CONTEXT line in the system prompt."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "{}"})
        summarizer.client.chat.return_value = mock_message

        summarizer.summarize(
            transcript="Me: hello.",
            template_name="general",
            meeting_date="2026-08-07",
        )
        system_prompt = summarizer.client.chat.call_args[1]["messages"][0]["content"]
        assert "DATE CONTEXT: Today is 2026-08-07 (Friday)" in system_prompt
        assert system_prompt.count("Today is") == 1

    @pytest.mark.parametrize(
        "meeting_date", [None, "", "not-a-date", "07/08/2026", "2026-13-45"]
    )
    def test_summarize_omits_date_context_when_absent_or_malformed(
        self, summarizer: OllamaSummarizer, meeting_date: str | None
    ) -> None:
        """No date, or a date we can't trust, leaves the prompt exactly as before."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "{}"})
        summarizer.client.chat.return_value = mock_message

        summarizer.summarize(
            transcript="Me: hello.",
            template_name="general",
            meeting_date=meeting_date,
        )
        system_prompt = summarizer.client.chat.call_args[1]["messages"][0]["content"]
        # The template mentions DATE CONTEXT as a condition; the injected line is
        # the only thing that ever states a date.
        assert "Today is" not in system_prompt

    def test_summarize_uses_model_override(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test the per-request model override is passed to ollama."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "{}"})
        summarizer.client.chat.return_value = mock_message

        summarizer.summarize(
            transcript="Me: hi.", template_name="general", model="qwen3:8b"
        )
        assert summarizer.client.chat.call_args[1]["model"] == "qwen3:8b"

    def test_summarize_falls_back_on_invalid_json(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize degrades to raw text if the model returns non-schema output."""
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "not json at all"})
        summarizer.client.chat.return_value = mock_message

        result = summarizer.summarize(transcript="Me: hi.", template_name="general")
        assert result.summary == "not json at all"
        assert result.attendees == []

    def test_summarize_handles_ollama_error_gracefully(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize raises RuntimeError on ollama failure."""
        summarizer.client.chat.side_effect = Exception("Connection refused")

        with pytest.raises(RuntimeError):
            summarizer.summarize(
                transcript="Test transcript.",
                template_name="general",
            )

    def test_summarize_template_not_found_raises(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """Test summarize raises FileNotFoundError for invalid template."""
        with pytest.raises(FileNotFoundError):
            summarizer.summarize(
                transcript="Test transcript.",
                template_name="nonexistent_template",
            )


class TestUserNotesMerge:
    """User notes are woven into the summarization prompt."""

    def test_notes_appear_in_user_message(self, summarizer: OllamaSummarizer) -> None:
        captured = {}

        def fake_chat(**kwargs):
            captured.update(kwargs)
            return {"message": {"content": '{"title": "T", "sections": []}'}}

        summarizer.client.chat = MagicMock(side_effect=fake_chat)
        summarizer.summarize(
            "Them: we discussed pricing.",
            user_notes="- pricing pushback\n- send proposal Friday",
        )
        msgs = captured["messages"]
        user_msg = msgs[-1]["content"]
        system_msg = msgs[0]["content"]
        assert "<user_notes>" in user_msg
        assert "send proposal Friday" in user_msg
        assert "USER NOTES" in system_msg
        # Notes must surface VISIBLY: the prompt demands a dedicated final
        # section, so jotted notes can't dissolve invisibly into the summary.
        assert "From Your Notes" in system_msg

    def test_no_notes_leaves_prompt_clean(self, summarizer: OllamaSummarizer) -> None:
        captured = {}

        def fake_chat(**kwargs):
            captured.update(kwargs)
            return {"message": {"content": '{"title": "T", "sections": []}'}}

        summarizer.client.chat = MagicMock(side_effect=fake_chat)
        summarizer.summarize("Them: hello.")  # no notes
        user_msg = captured["messages"][-1]["content"]
        system_msg = captured["messages"][0]["content"]
        assert "<user_notes>" not in user_msg
        assert "USER NOTES" not in system_msg


class TestChat:
    """Tests for the grounded chat method."""

    def test_chat_returns_answer(self, summarizer: OllamaSummarizer) -> None:
        summarizer.client.chat = MagicMock(
            return_value={"message": {"content": "They agreed on $5k."}}
        )
        result = summarizer.chat("Them: pricing is $5k.", "What was the price?")
        assert result.answer == "They agreed on $5k."

    def test_chat_empty_transcript_raises(self, summarizer: OllamaSummarizer) -> None:
        with pytest.raises(ValueError):
            summarizer.chat("   ", "anything?")

    def test_chat_empty_question_raises(self, summarizer: OllamaSummarizer) -> None:
        with pytest.raises(ValueError):
            summarizer.chat("Them: hello.", "  ")

    def test_chat_passes_question_to_model(self, summarizer: OllamaSummarizer) -> None:
        captured = {}

        def fake_chat(**kwargs):
            captured.update(kwargs)
            return {"message": {"content": "ok"}}

        summarizer.client.chat = MagicMock(side_effect=fake_chat)
        summarizer.chat("Them: budget talk.", "What is the budget?")
        user_msg = captured["messages"][-1]["content"]
        assert "What is the budget?" in user_msg
        assert "budget talk" in user_msg

    def test_chat_messages_system_prompt_contains_analysis_clause(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """The system prompt permits grounded analysis/evaluation/opinion."""
        messages = summarizer._chat_messages("Me: I did great.", "How did I do?")
        system = messages[0]["content"]
        assert "analysis, evaluation, or an opinion" in system
        assert "say you don't know" in system  # original guardrail still present

    def test_chat_empty_answer_raises(self, summarizer: OllamaSummarizer) -> None:
        """An empty (or think-only) model answer must surface as a RuntimeError."""
        summarizer.client.chat = MagicMock(
            return_value={"message": {"content": ""}}
        )
        with pytest.raises(RuntimeError, match="empty answer"):
            summarizer.chat("Them: hello.", "What was said?")


class TestOpenAIBackend:
    """The openai-compatible backend routes through httpx and parses choices."""

    def _make(self, monkeypatch) -> OllamaSummarizer:
        s = OllamaSummarizer(model="Qwen/Qwen3.6-35B-A3B-FP8")
        s.backend = "openai"
        s.base_url = "http://127.0.0.1:8000/v1"
        s.api_key = "EMPTY"
        s.client = None
        return s

    def test_chat_openai_parses_answer(self, monkeypatch) -> None:
        captured = {}

        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self):
                return {"choices": [{"message": {"content": "Budget is 50k."}}]}

        def fake_post(url, json=None, headers=None, timeout=None):
            captured["url"] = url
            captured["body"] = json
            return FakeResp()

        monkeypatch.setattr("httpx.post", fake_post)
        s = self._make(monkeypatch)
        result = s.chat("Them: budget is 50k.", "What is the budget?")
        assert result.answer == "Budget is 50k."
        assert captured["url"].endswith("/v1/chat/completions")
        # chat() sends no schema; thinking disabled
        assert "response_format" not in captured["body"]
        assert captured["body"]["chat_template_kwargs"] == {"enable_thinking": False}

    def test_summarize_openai_sends_json_schema(self, monkeypatch) -> None:
        captured = {}

        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self):
                return {"choices": [{"message": {"content": '{"title": "T", "sections": []}'}}]}

        def fake_post(url, json=None, headers=None, timeout=None):
            captured["body"] = json
            return FakeResp()

        monkeypatch.setattr("httpx.post", fake_post)
        s = self._make(monkeypatch)
        s.summarize("Them: we discussed the budget.")
        assert captured["body"]["response_format"]["type"] == "json_schema"
        assert "schema" in captured["body"]["response_format"]["json_schema"]


class TestThinkStripping:
    """Reasoning models (e.g. Groq qwen3-32b) emit <think>…</think> before the
    answer in non-json chat; it must be stripped from chat replies."""

    def test_strip_think_removes_leading_block(self) -> None:
        from src.summarizer import _strip_think

        assert _strip_think("<think>reasoning here</think>\nThe budget is 50k.") == (
            "The budget is 50k."
        )

    def test_strip_think_noop_without_block(self) -> None:
        from src.summarizer import _strip_think

        assert _strip_think("Just a plain answer.") == "Just a plain answer."

    def test_strip_think_stream_drops_block_across_deltas(self) -> None:
        from src.summarizer import _strip_think_stream

        # the think block is split across several deltas, then the answer streams
        deltas = ["<thi", "nk>\nlet me reason", " about it</thi", "nk>\nThe ", "answer", "."]
        assert "".join(_strip_think_stream(deltas)) == "The answer."

    def test_strip_think_stream_passes_through_when_no_block(self) -> None:
        from src.summarizer import _strip_think_stream

        deltas = ["The ", "budget ", "is ", "50k."]
        assert "".join(_strip_think_stream(deltas)) == "The budget is 50k."


class TestSpeakerLabelCleanup:
    """'Me'/'Them' are generic dual-capture speaker labels, not real attendees —
    they must not leak into the title or attendee list."""

    def test_clean_title_strips_them(self) -> None:
        assert (
            OllamaSummarizer._clean_title("Meeting with Hamza and Them")
            == "Meeting with Hamza"
        )

    def test_clean_title_strips_me(self) -> None:
        assert (
            OllamaSummarizer._clean_title("Sync between Me and Sarah")
            == "Sync between Sarah"
        )

    def test_clean_title_keeps_lookalike_words(self) -> None:
        # Word-boundaried: must not touch "Theme" / "Meet".
        assert OllamaSummarizer._clean_title("Theme planning meeting") == (
            "Theme planning meeting"
        )

    def test_clean_title_falls_back_when_emptied(self) -> None:
        assert OllamaSummarizer._clean_title("Me and Them") == "Me and Them"

    def test_render_drops_me_them_attendees(self) -> None:
        _, title, attendees = OllamaSummarizer._render(
            {
                "title": "Standup with Hamza and Them",
                "attendees": ["Me", "Hamza", "Them", "Sarah"],
                "sections": [],
            }
        )
        assert attendees == ["Hamza", "Sarah"]
        assert title == "Standup with Hamza"


class TestAttendeeDetails:
    """Role/company extraction that prefills person profiles in the desktop app."""

    def test_matches_role_suffixed_attendee_and_emits_bare_name(self) -> None:
        details = OllamaSummarizer._attendee_details(
            {"attendees": [{"name": "Sarah", "role": "CTO", "company": "Fluence Pay"}]},
            ["Sarah — CTO"],
        )
        assert len(details) == 1
        assert details[0].name == "Sarah"
        assert details[0].role == "CTO"
        assert details[0].company == "Fluence Pay"

    def test_skips_attendees_the_model_said_nothing_about(self) -> None:
        details = OllamaSummarizer._attendee_details(
            {"attendees": [{"name": "Hamza"}]}, ["Hamza"]
        )
        assert details == []

    def test_treats_null_placeholders_as_not_stated(self) -> None:
        details = OllamaSummarizer._attendee_details(
            {"attendees": [{"name": "Dan", "role": "null", "company": "Acme"}]},
            ["Dan"],
        )
        assert len(details) == 1
        assert details[0].role == ""
        assert details[0].company == "Acme"

    def test_ignores_entries_that_did_not_survive_dedup_or_grounding(self) -> None:
        details = OllamaSummarizer._attendee_details(
            {"attendees": [{"name": "Them", "role": "Guest"}]}, ["Sarah"]
        )
        assert details == []

    def test_tolerates_bare_string_attendees(self) -> None:
        details = OllamaSummarizer._attendee_details(
            {"attendees": ["Sarah", {"name": "Dan", "company": "Acme"}]},
            ["Sarah", "Dan"],
        )
        assert [d.name for d in details] == ["Dan"]


class TestOpenAIJsonSchemaFallback:
    """Some OpenAI-compatible servers (DeepSeek) reject response_format=
    json_schema with HTTP 400; _chat_openai must fall back to json_object."""

    @staticmethod
    def _resp(status: int, content: str | None = None, text: str = "") -> MagicMock:
        r = MagicMock()
        r.status_code = status
        r.text = text
        r.raise_for_status = MagicMock()
        if content is not None:
            r.json = MagicMock(
                return_value={"choices": [{"message": {"content": content}}]}
            )
        return r

    def test_falls_back_to_json_object_on_400(self, summarizer, monkeypatch) -> None:
        import src.summarizer as smod

        smod._NO_JSON_SCHEMA.clear()
        calls: list[dict] = []

        def fake_post(url, json=None, headers=None, timeout=None):
            calls.append(json)
            if json["response_format"]["type"] == "json_schema":
                return self._resp(
                    400, text="This response_format type is unavailable now"
                )
            return self._resp(200, content='{"x":1}')

        monkeypatch.setattr(smod.httpx, "post", fake_post)
        out = summarizer._chat_openai(
            [{"role": "user", "content": "give me json"}],
            "deepseek-v4-flash",
            {"type": "object"},
            base_url="https://api.deepseek.com",
            api_key="sk-x",
        )
        assert out == '{"x":1}'
        assert [c["response_format"]["type"] for c in calls] == [
            "json_schema",
            "json_object",
        ]
        # Host remembered → next call skips the failing schema attempt.
        assert "https://api.deepseek.com" in smod._NO_JSON_SCHEMA

    def test_keeps_json_schema_when_supported(self, summarizer, monkeypatch) -> None:
        import src.summarizer as smod

        smod._NO_JSON_SCHEMA.clear()
        calls: list[dict] = []

        def fake_post(url, json=None, headers=None, timeout=None):
            calls.append(json)
            return self._resp(200, content='{"y":2}')

        monkeypatch.setattr(smod.httpx, "post", fake_post)
        out = summarizer._chat_openai(
            [{"role": "user", "content": "give me json"}],
            "qwen3.6-35b",
            {"type": "object"},
            base_url="http://127.0.0.1:8000/v1",
        )
        assert out == '{"y":2}'
        assert len(calls) == 1
        assert calls[0]["response_format"]["type"] == "json_schema"

    def test_strips_chat_template_kwargs_on_400(self, summarizer, monkeypatch) -> None:
        """Groq rejects the vLLM-only chat_template_kwargs param with HTTP 400
        ("property 'chat_template_kwargs' is unsupported"); _chat_openai must drop
        it and retry (this is what broke summarize/chat after switching to Groq)."""
        import src.summarizer as smod

        smod._NO_JSON_SCHEMA.clear()
        smod._NO_CHAT_TEMPLATE_KWARGS.clear()
        calls: list[dict] = []

        def fake_post(url, json=None, headers=None, timeout=None):
            calls.append(json)
            if "chat_template_kwargs" in json:
                return self._resp(
                    400, text="property 'chat_template_kwargs' is unsupported"
                )
            return self._resp(200, content='{"x":1}')

        monkeypatch.setattr(smod.httpx, "post", fake_post)
        out = summarizer._chat_openai(
            [{"role": "user", "content": "give me json"}],
            "qwen/qwen3-32b",
            None,  # chat-style call (no schema)
            base_url="https://api.groq.com/openai/v1",
            api_key="gsk-x",
        )
        assert out == '{"x":1}'
        assert "chat_template_kwargs" in calls[0]
        assert "chat_template_kwargs" not in calls[1]
        assert "https://api.groq.com/openai/v1" in smod._NO_CHAT_TEMPLATE_KWARGS

    def test_groq_strips_chat_template_kwargs_then_json_schema(
        self, summarizer, monkeypatch
    ) -> None:
        """Groq qwen rejects chat_template_kwargs first, then json_schema; the
        client peels off each in turn and lands on json_object."""
        import src.summarizer as smod

        smod._NO_JSON_SCHEMA.clear()
        smod._NO_CHAT_TEMPLATE_KWARGS.clear()
        calls: list[dict] = []

        def fake_post(url, json=None, headers=None, timeout=None):
            calls.append(json)
            if "chat_template_kwargs" in json:
                return self._resp(
                    400, text="property 'chat_template_kwargs' is unsupported"
                )
            if json.get("response_format", {}).get("type") == "json_schema":
                return self._resp(
                    400,
                    text='{"error":{"message":"This model does not support '
                    'response format json_schema","param":"response_format"}}',
                )
            return self._resp(200, content='{"ok":1}')

        monkeypatch.setattr(smod.httpx, "post", fake_post)
        out = summarizer._chat_openai(
            [{"role": "user", "content": "give me json"}],
            "qwen/qwen3-32b",
            {"type": "object"},
            base_url="https://api.groq.com/openai/v1",
            api_key="gsk-x",
        )
        assert out == '{"ok":1}'
        assert len(calls) == 3
        assert "chat_template_kwargs" not in calls[2]
        assert calls[2]["response_format"]["type"] == "json_object"
        assert "https://api.groq.com/openai/v1" in smod._NO_CHAT_TEMPLATE_KWARGS
        assert "https://api.groq.com/openai/v1" in smod._NO_JSON_SCHEMA

    def test_surfaces_server_error_body(self, summarizer, monkeypatch) -> None:
        """A non-recoverable 400 must surface the server's error body (the real
        cause), not just the bare status line."""
        import src.summarizer as smod

        smod._NO_JSON_SCHEMA.clear()
        smod._NO_CHAT_TEMPLATE_KWARGS.clear()

        def fake_post(url, json=None, headers=None, timeout=None):
            r = self._resp(400, text='{"error":{"message":"model `bogus` does not exist"}}')
            r.raise_for_status = MagicMock(
                side_effect=httpx.HTTPStatusError("400", request=None, response=None)
            )
            return r

        monkeypatch.setattr(smod.httpx, "post", fake_post)
        with pytest.raises(RuntimeError, match="does not exist"):
            summarizer._chat_openai(
                [{"role": "user", "content": "hi"}],
                "bogus",
                None,
                base_url="https://api.groq.com/openai/v1",
                api_key="gsk-x",
            )


class TestResolveCategory:
    """Category precedence: mic-bleed hint > LLM classification > heuristic."""

    def _resolve(self, hint, llm, heuristic):
        from src.summarizer import resolve_category

        return resolve_category(hint, llm, heuristic)

    def test_hint_wins_over_everything(self):
        # A watched video the LLM mistook for a meeting: the physical mic-bleed
        # verdict overrides the LLM's content guess.
        assert self._resolve("youtube", "meeting", "meeting") == "youtube"

    def test_llm_used_when_no_hint(self):
        assert self._resolve(None, "interview", "meeting") == "interview"
        assert self._resolve("", "one_on_one", "brainstorm") == "one_on_one"

    def test_llm_normalized(self):
        assert self._resolve(None, "One-on-One", "meeting") == "one_on_one"
        assert self._resolve(None, "  STANDUP ", "meeting") == "standup"

    def test_invalid_llm_falls_back_to_heuristic(self):
        assert self._resolve(None, "gibberish", "brainstorm") == "brainstorm"
        assert self._resolve(None, None, "meeting") == "meeting"


class TestClassifyCategory:
    """classify_category must handle diarized (Speaker N) transcripts — those
    labels are the REMOTE side, not the local user."""

    def _classify(self, transcript: str) -> str:
        from src.summarizer import classify_category

        return classify_category(transcript)

    def test_diarized_video_is_youtube_not_brainstorm(self):
        # A watched video: all speech is system audio, diarized into Speaker N.
        # Before the fix these lines counted as "me" → me_ratio 1.0 → brainstorm.
        transcript = "\n".join(
            [
                "Speaker 1: Welcome back to the channel, today we cover Rust.",
                "Speaker 2: Thanks for having me, let's dive into ownership.",
                "Speaker 1: First, let's talk about the borrow checker rules.",
            ]
        )
        assert self._classify(transcript) == "youtube"

    def test_diarized_two_way_meeting_stays_meeting(self):
        transcript = "\n".join(
            [
                "Me: Here's my update on the migration work this week.",
                "Speaker 1: Sounds good, what about the deadline we set?",
                "Me: We should be able to hit it if QA starts Monday morning.",
                "Speaker 1: Great, I'll let the client know about the plan.",
            ]
        )
        assert self._classify(transcript) == "meeting"

    def test_solo_brainstorm_still_brainstorm(self):
        transcript = "\n".join(
            [
                "Me: Okay so ideas for the launch, first the landing page.",
                "Me: Then I need to write the Show HN post and the demo video.",
            ]
        )
        assert self._classify(transcript) == "brainstorm"

    def test_flat_them_video_still_youtube(self):
        transcript = "\n".join(
            [
                "Them: In this tutorial we're going to build a neural network.",
                "Them: Start by importing the libraries we need for the model.",
            ]
        )
        assert self._classify(transcript) == "youtube"

    def test_asymmetric_mic_bleed_is_youtube(self):
        # Regression for meeting #90 (2026-07-04): the mic caught only a
        # FRACTION of a played video, so Jaccard overlap stayed at 0.33 and the
        # recording classified as "meeting" — but everything the mic heard was
        # contained in the system channel. Containment must catch this.
        video = [
            "A couple months ago Andrej Karpathy released the idea of the wiki",
            "It is a pattern for building personal knowledge bases using models",
            "The original gist achieved forty thousand stars showing interest",
            "Users can copy the markdown file into a coding engine to generate",
            "The system incrementally builds a persistent wiki reading sources",
            "It extracts key information maintaining interlinked markdown files",
        ]
        lines = [f"Them: {sentence}" for sentence in video]
        # The mic only picked up two of the six sentences (quiet playback).
        lines.insert(1, f"Me: {video[0]}")
        lines.insert(4, f"Me: {video[2]}")
        transcript = "\n".join(lines)
        assert self._classify(transcript) == "youtube"

    def test_echoey_meeting_below_containment_stays_meeting(self):
        # A real call where SOME user words echo back on the system channel
        # (~50% containment, well under the 0.8 trigger) must stay a meeting.
        transcript = "\n".join(
            [
                "Me: quarterly migration deadline requires database schema review",
                "Them: quarterly migration deadline sounds fine for the client",
                "Me: staging environment needs monitoring dashboards before launch",
                "Them: agreed about monitoring but budget approval comes first",
            ]
        )
        assert self._classify(transcript) == "meeting"


class TestRouteTemplate:
    """route_template maps detected categories to prompt templates."""

    def _route(self, category: str) -> str | None:
        from src.summarizer import route_template

        return route_template(category)

    def test_four_mappings(self) -> None:
        assert self._route("youtube") == "youtube"
        assert self._route("brainstorm") == "brainstorm"
        assert self._route("one_on_one") == "one-on-one"
        assert self._route("interview") == "interview"

    def test_unmapped_categories_return_none(self) -> None:
        assert self._route("meeting") is None
        assert self._route("standup") is None
        assert self._route("other") is None
        assert self._route("garbage") is None


class TestClassifyCategoryLLM:
    """_classify_category_llm parses and normalizes the one-word LLM reply."""

    @pytest.fixture
    def s(self) -> OllamaSummarizer:
        return OllamaSummarizer(model="llama3.1:8b")

    def test_normalizes_interview(self, s: OllamaSummarizer) -> None:
        s._chat = MagicMock(return_value="Interview")
        assert s._classify_category_llm("transcript", None, None, None) == "interview"

    def test_normalizes_one_on_one_with_dashes(self, s: OllamaSummarizer) -> None:
        s._chat = MagicMock(return_value="one-on-one")
        assert s._classify_category_llm("transcript", None, None, None) == "one_on_one"

    def test_garbage_reply_returns_none(self, s: OllamaSummarizer) -> None:
        s._chat = MagicMock(return_value="some multi-word reply that is not a category")
        assert s._classify_category_llm("transcript", None, None, None) is None

    def test_chat_raises_returns_none(self, s: OllamaSummarizer) -> None:
        s._chat = MagicMock(side_effect=RuntimeError("LLM down"))
        assert s._classify_category_llm("transcript", None, None, None) is None

    def test_strips_quotes_from_reply(self, s: OllamaSummarizer) -> None:
        s._chat = MagicMock(return_value='"interview"')
        assert s._classify_category_llm("transcript", None, None, None) == "interview"


class TestSummarizeAutoTemplate:
    """auto_template routing in summarize()."""

    @pytest.fixture
    def s(self) -> OllamaSummarizer:
        return OllamaSummarizer(model="llama3.1:8b")

    def _valid_json_reply(self) -> str:
        return json.dumps({
            "title": "Test",
            "category": "meeting",
            "attendees": [],
            "sections": [{"heading": "Notes", "bullets": ["Point 1"]}],
        })

    def test_hint_routes_to_youtube_without_classify_call(self, s: OllamaSummarizer) -> None:
        """category_hint="youtube" routes without calling the classify LLM."""
        s._chat = MagicMock(return_value=self._valid_json_reply())
        result = s.summarize(
            transcript="Them: some video content here.",
            template_name="general",
            auto_template=True,
            category_hint="youtube",
        )
        assert result.template_used == "youtube"
        # Only the main summarize _chat call was made (the classify call was
        # skipped because category_hint was present).
        assert s._chat.call_count == 1

    def test_classify_reply_routes_to_interview(self, s: OllamaSummarizer) -> None:
        """No hint; classify LLM returns 'interview' → template_used == 'interview'."""
        s._chat = MagicMock()
        s._chat.side_effect = [
            "interview",                # _classify_category_llm
            self._valid_json_reply(),   # main summarize
        ]
        result = s.summarize(
            transcript="Them: tell me about your experience with Python.",
            template_name="general",
            auto_template=True,
        )
        assert result.template_used == "interview"
        assert s._chat.call_count == 2

    def test_classify_raises_falls_back_to_heuristic(self, s: OllamaSummarizer) -> None:
        """Classify LLM raises → falls back to heuristic (brainstorm here)."""
        s._chat = MagicMock()
        s._chat.side_effect = [
            RuntimeError("LLM down"),   # _classify_category_llm raises
            self._valid_json_reply(),   # main summarize
        ]
        # A mostly-Me transcript triggers heuristic → brainstorm.
        brainstorm_transcript = "\n".join(["Me: " + f"idea {i}" for i in range(20)])
        result = s.summarize(
            transcript=brainstorm_transcript,
            template_name="general",
            auto_template=True,
        )
        assert result.template_used == "brainstorm"
        # classify LLM was called (and caught its exception), then the main
        # summarize call succeeded — 2 total calls.
        assert s._chat.call_count == 2

    def test_manual_template_not_routed(self, s: OllamaSummarizer) -> None:
        """auto_template=True but template_name='client-meeting' → no routing."""
        s._chat = MagicMock(return_value=self._valid_json_reply())
        result = s.summarize(
            transcript="Them: tell me about your experience.",
            template_name="client-meeting",
            auto_template=True,
        )
        assert result.template_used == "client-meeting"
        # classify LLM was NOT called (template_name != "general").
        assert s._chat.call_count == 1

    def test_auto_template_false_no_routing(self, s: OllamaSummarizer) -> None:
        """auto_template=False (default) even with obvious youtube hint → stays general."""
        s._chat = MagicMock(return_value=self._valid_json_reply())
        result = s.summarize(
            transcript="Them: some video content.",
            template_name="general",
            auto_template=False,
            category_hint="youtube",
        )
        assert result.template_used == "general"
        # classify LLM was NOT called (auto_template is False).
        assert s._chat.call_count == 1

    def test_routed_template_missing_fail_open(self, s: OllamaSummarizer) -> None:
        """Template file missing → fail-open, template stays general."""
        s._chat = MagicMock()
        s._chat.side_effect = [
            "interview",                # _classify_category_llm
            self._valid_json_reply(),   # main summarize
        ]
        # Monkeypatch _load_template to fail for "interview" only.
        original_load = s._load_template

        def _fake_load(name: str) -> str:
            if name == "interview":
                raise FileNotFoundError(f"Prompt template not found: {name}")
            return original_load(name)

        s._load_template = _fake_load  # type: ignore[method-assign]
        try:
            result = s.summarize(
                transcript="Them: tell me about your experience with Python.",
                template_name="general",
                auto_template=True,
            )
            assert result.template_used == "general"
        finally:
            s._load_template = original_load  # type: ignore[method-assign]

    def test_interview_template_loads_and_in_list(self, s: OllamaSummarizer) -> None:
        """interview.md loads via _load_template and appears in /templates list."""
        content = s._load_template("interview")
        assert isinstance(content, str)
        assert len(content) > 0
        assert "job interview" in content.lower()

        templates = s.list_templates()
        names = {t.name for t in templates}
        assert "interview" in names


class TestNeutralizeViewerLines:
    """Unit tests for neutralize_viewer_lines()."""

    def _neutralize(self, transcript: str, viewer_label: str | None = None) -> str:
        from src.summarizer import neutralize_viewer_lines

        return neutralize_viewer_lines(transcript, viewer_label)

    def test_replaces_me_label(self) -> None:
        result = self._neutralize("Me: hello world\nMe: another line")
        assert result == (
            "Viewer mic (not the presenter): hello world\n"
            "Viewer mic (not the presenter): another line"
        )

    def test_replaces_custom_label_case_insensitively(self) -> None:
        result = self._neutralize(
            "Hamza: this is from a video\nhamza: more video content\nHamza: even more",
            viewer_label="Hamza",
        )
        assert "Hamza:" not in result
        assert "hamza:" not in result.lower()
        assert result.count("Viewer mic (not the presenter):") == 3

    def test_other_labels_untouched(self) -> None:
        transcript = "Them: system audio\nSpeaker 1: diarized audio\nMe: my mic"
        result = self._neutralize(transcript, viewer_label="Hamza")
        assert "Them: system audio" in result
        assert "Speaker 1: diarized audio" in result
        assert "Viewer mic (not the presenter): my mic" in result

    def test_colon_deep_in_sentence_untouched(self) -> None:
        transcript = "This sentence has a colon: right in the middle."
        result = self._neutralize(transcript, viewer_label="Hamza")
        assert result == transcript

    def test_arabic_label_replaced(self) -> None:
        transcript = "حمزة: مرحبا بالعالم"
        result = self._neutralize(transcript, viewer_label="حمزة")
        assert "حمزة:" not in result
        assert "Viewer mic (not the presenter): مرحبا بالعالم" in result

    def test_viewer_label_none_still_replaces_me(self) -> None:
        result = self._neutralize("Me: hello\nThem: hi", viewer_label=None)
        assert "Me:" not in result
        assert "Viewer mic (not the presenter): hello" in result
        assert "Them: hi" in result

    def test_empty_viewer_label_still_replaces_me(self) -> None:
        result = self._neutralize("Me: hello", viewer_label="  ")
        assert "Viewer mic (not the presenter): hello" in result

    def test_preserves_indentation(self) -> None:
        result = self._neutralize("  Me: indented line", viewer_label=None)
        assert result == "  Viewer mic (not the presenter): indented line"

    def test_long_prefix_untouched(self) -> None:
        # A prefix > 40 chars before the first colon is not a speaker label.
        long_line = "A" * 41 + ": this is not a label"
        result = self._neutralize(long_line, viewer_label=None)
        assert result == long_line

    def test_lines_without_colon_untouched(self) -> None:
        result = self._neutralize("No colon here\nMe: with colon", viewer_label=None)
        assert "No colon here" in result
        assert "Viewer mic (not the presenter): with colon" in result


class TestSummarizeViewerLabel:
    """Integration: summarize with viewer_label neutralizes youtube-template transcripts."""

    @pytest.fixture
    def s(self) -> OllamaSummarizer:
        return OllamaSummarizer(model="llama3.1:8b")

    def _valid_json_reply(self) -> str:
        return json.dumps({
            "title": "Test",
            "category": "youtube",
            "attendees": [],
            "sections": [{"heading": "Notes", "bullets": ["Point 1"]}],
        })

    def test_youtube_template_neutralizes_viewer_label(self, s: OllamaSummarizer) -> None:
        """When template_name='youtube' and viewer_label='Hamza', the transcript
        passed to the LLM has 'Hamza:' replaced with 'Viewer mic (not the presenter):'."""
        s._chat = MagicMock(return_value=self._valid_json_reply())

        s.summarize(
            transcript="Hamza: Welcome to my tutorial\nHamza: Today we cover Rust.",
            template_name="youtube",
            viewer_label="Hamza",
        )

        user_message = s._chat.call_args[1]["messages"][1]["content"]
        assert "Viewer mic (not the presenter):" in user_message
        assert "Hamza:" not in user_message

    def test_general_template_preserves_viewer_label(self, s: OllamaSummarizer) -> None:
        """When template_name='general', the transcript is NOT neutralized."""
        s._chat = MagicMock(return_value=self._valid_json_reply())

        s.summarize(
            transcript="Hamza: I think we should ship it\nThem: Agreed.",
            template_name="general",
            viewer_label="Hamza",
        )

        user_message = s._chat.call_args[1]["messages"][1]["content"]
        assert "Hamza: I think we should ship it" in user_message
        assert "Viewer mic (not the presenter):" not in user_message

    def test_auto_routed_to_youtube_neutralizes(self, s: OllamaSummarizer) -> None:
        """auto_template=True + category_hint='youtube' → template becomes 'youtube'
        and neutralization fires."""
        s._chat = MagicMock(return_value=self._valid_json_reply())

        s.summarize(
            transcript="Hamza: tutorial content here\nHamza: more content",
            template_name="general",
            auto_template=True,
            category_hint="youtube",
            viewer_label="Hamza",
        )

        user_message = s._chat.call_args[1]["messages"][1]["content"]
        assert "Viewer mic (not the presenter):" in user_message
        assert "Hamza:" not in user_message


class TestNumCtxGuard:
    """EVERY Ollama completion call must pass num_ctx (TODO 2026-08-02: a call
    without it loads the model at its model-default context — 262,144 for
    qwen3.5:9b = 16 GB resident observed live, vs ~7 GB at 16,384)."""

    @staticmethod
    def _assert_all_calls_have_num_ctx(summarizer: OllamaSummarizer) -> None:
        from src.summarizer import DEFAULT_NUM_CTX

        calls = summarizer.client.chat.call_args_list
        assert calls, "expected at least one ollama chat call"
        for call in calls:
            options = call.kwargs["options"]
            assert options["num_ctx"] == DEFAULT_NUM_CTX

    def test_chat_passes_num_ctx(self, summarizer: OllamaSummarizer) -> None:
        """The grounded-chat completion carries num_ctx."""
        summarizer.client.chat.reset_mock()
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "Answer."})
        summarizer.client.chat.return_value = mock_message

        summarizer.chat(transcript="Me: hi. Them: hi.", question="What was said?")

        self._assert_all_calls_have_num_ctx(summarizer)

    def test_chat_stream_passes_num_ctx(self, summarizer: OllamaSummarizer) -> None:
        """The streaming-chat completion carries num_ctx."""
        summarizer.client.chat.reset_mock()
        summarizer.client.chat.return_value = iter([])

        list(summarizer.chat_stream(transcript="Me: hi.", question="What was said?"))

        self._assert_all_calls_have_num_ctx(summarizer)

    def test_classify_and_summarize_completions_pass_num_ctx(
        self, summarizer: OllamaSummarizer
    ) -> None:
        """auto_template fires the extra one-word classification completion —
        both it and the summarize completion must carry num_ctx."""
        summarizer.client.chat.reset_mock()
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "Summary."})
        summarizer.client.chat.return_value = mock_message

        summarizer.summarize(
            transcript="Me: hello there. Them: hi, let's plan the launch.",
            template_name="general",
            auto_template=True,
        )

        assert len(summarizer.client.chat.call_args_list) == 2
        self._assert_all_calls_have_num_ctx(summarizer)


class TestLocalOllamaBaseUrlReroute:
    """Rust routes local Ollama tags through http://127.0.0.1:11434/v1 (its
    OpenAI-compatible surface, commands.rs OLLAMA_OPENAI_BASE_URL) — but that
    API cannot carry num_ctx, which is exactly how the 262k-context / 16 GB
    runner happened live (2026-08-02). A local-Ollama base_url must be served
    by the native Ollama client so _ollama_options() applies."""

    OLLAMA_V1 = "http://127.0.0.1:11434/v1"

    def test_is_local_ollama_url(self) -> None:
        from src.summarizer import _is_local_ollama_url

        assert _is_local_ollama_url("http://127.0.0.1:11434/v1")
        assert _is_local_ollama_url("http://localhost:11434/v1")
        assert _is_local_ollama_url("http://localhost:11434")
        assert not _is_local_ollama_url("https://api.groq.com/openai/v1")
        assert not _is_local_ollama_url("http://127.0.0.1:8765/v1")  # Rapid-MLX
        assert not _is_local_ollama_url(None)
        assert not _is_local_ollama_url("")

    def test_chat_with_local_ollama_base_url_uses_native_client(self) -> None:
        from src.summarizer import DEFAULT_NUM_CTX

        s = OllamaSummarizer(model="qwen3.5:9b", backend="openai")
        assert s.client is None  # the openai backend skips client construction
        s._ollama_client()  # lazy creation (returns the module-level fake)
        s.client.chat.reset_mock()
        mock_message = MagicMock()
        mock_message.__getitem__ = MagicMock(return_value={"content": "ok"})
        s.client.chat.return_value = mock_message

        out = s._chat(
            [{"role": "user", "content": "hi"}],
            "qwen3.5:9b",
            None,
            base_url=self.OLLAMA_V1,
        )

        assert out == "ok"
        call = s.client.chat.call_args
        assert call.kwargs["options"]["num_ctx"] == DEFAULT_NUM_CTX

    def test_chat_stream_with_local_ollama_base_url_uses_native_client(self) -> None:
        from src.summarizer import DEFAULT_NUM_CTX

        s = OllamaSummarizer(model="qwen3.5:9b", backend="openai")
        s._ollama_client()
        s.client.chat.reset_mock()
        s.client.chat.return_value = iter([])

        list(
            s.chat_stream(
                transcript="Me: hi.", question="What?", base_url=self.OLLAMA_V1
            )
        )

        call = s.client.chat.call_args
        assert call.kwargs["stream"] is True
        assert call.kwargs["options"]["num_ctx"] == DEFAULT_NUM_CTX

    def test_cloud_base_url_still_routes_openai(self) -> None:
        s = OllamaSummarizer(model="llama-3.3-70b", backend="openai")
        s._chat_openai = MagicMock(return_value="cloud")

        out = s._chat(
            [{"role": "user", "content": "hi"}],
            "llama-3.3-70b",
            None,
            base_url="https://api.groq.com/openai/v1",
            api_key="k",
        )

        assert out == "cloud"
        s._chat_openai.assert_called_once()
        assert s.client is None  # the native client was never touched


class TestGenerateTemplate:
    """Drafting a template from a description.

    The load-bearing part is not that it returns text — it is that the draft keeps
    the structured-notes contract. A template invented from scratch produces notes
    that look fine and silently stop filling the to-do board, because
    `storage.rs::extract_action_items` parses a specific bullet shape.
    """

    def _summarizer(self, monkeypatch, reply: str):
        s = OllamaSummarizer(model="test-model", host="http://localhost:11434")
        captured: dict = {}

        def fake_chat(messages, model, json_schema, base_url=None, api_key=None):
            captured["messages"] = messages
            captured["json_schema"] = json_schema
            return reply

        monkeypatch.setattr(s, "_chat", fake_chat)
        return s, captured

    def test_shows_the_model_a_real_template_as_the_example(self, monkeypatch) -> None:
        """The example is a REAL bundled template, so the output contract survives."""
        s, captured = self._summarizer(monkeypatch, "# My template\nDo the thing.")
        s.generate_template(description="notes for a 1:1 with my manager")

        user = captured["messages"][1]["content"]
        # The bundled general template is the example; a marker from it must appear.
        assert "EXAMPLE TEMPLATE" in user
        assert "1:1 with my manager" in user
        # Free text, never schema-constrained: the product of this call IS a prompt.
        assert captured["json_schema"] is None

    def test_strips_code_fences(self, monkeypatch) -> None:
        """Models fence prose even when told not to; the fence would be saved."""
        s, _ = self._summarizer(monkeypatch, "```markdown\n# Template\nBody.\n```")
        assert s.generate_template(description="anything") == "# Template\nBody."

    def test_empty_description_is_rejected_before_calling_the_model(self, monkeypatch) -> None:
        s, captured = self._summarizer(monkeypatch, "unused")
        with pytest.raises(ValueError):
            s.generate_template(description="   ")
        assert "messages" not in captured, "must not spend a model call on empty input"

    def test_empty_reply_is_an_error_not_an_empty_template(self, monkeypatch) -> None:
        """Saving an empty template would silently break every note that used it."""
        s, _ = self._summarizer(monkeypatch, "   \n  ")
        with pytest.raises(RuntimeError, match="empty template"):
            s.generate_template(description="notes for standups")

    def test_strips_an_echoed_horizontal_rule(self, monkeypatch) -> None:
        """Verified live: qwen3.6-35b echoed the example's delimiter into the body.

        A stray `---` at the top of a system prompt is harmless to the model but
        makes the saved template look broken to the person reading it.
        """
        s, _ = self._summarizer(monkeypatch, "---\nYou are an expert note taker.\n---")
        assert s.generate_template(description="1:1 notes") == "You are an expert note taker."
