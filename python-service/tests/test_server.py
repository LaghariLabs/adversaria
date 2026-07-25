"""Integration tests for the FastAPI server."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

# Mock heavy dependencies before importing the server module
_fake_transcriber_instance = MagicMock()
_fake_transcriber_instance.model_size = "large-v3"
_fake_transcriber_instance.transcribe.return_value = MagicMock(
    text="Hello world transcript.",
    language="en",
    duration_seconds=42.0,
    category_hint=None,
    turns=[],
)
_fake_transcriber_instance.transcribe_bytes.return_value = MagicMock(
    text="Hello world from bytes.",
    language="en",
    duration_seconds=10.0,
    category_hint=None,
    turns=[],
)

_fake_summarizer_instance = MagicMock()
_fake_summarizer_instance.client = MagicMock()
_fake_summarizer_instance.client.list.return_value = MagicMock()
_fake_summarizer_instance.backend_available.return_value = True


def _fake_summarize(
    transcript: str,
    template_name: str = "general",
    model: str | None = None,
    output_language: str | None = None,
    user_notes: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    known_attendees: list[str] | None = None,
    category_hint: str | None = None,
    auto_template: bool = False,
    viewer_label: str | None = None,
) -> MagicMock:
    """Mock summarize that validates input like the real one."""
    if not transcript.strip():
        raise ValueError("Transcript is empty.")
    return MagicMock(
        summary="This is a test summary.",
        template_used=template_name,
        title="Test meeting",
        attendees=["Me", "Them"],
        category=category_hint or "meeting",
    )


_fake_summarizer_instance.summarize.side_effect = _fake_summarize

# Use real TemplateInfo-like objects for list_templates
from src.models import TemplateInfo  # noqa: E402 — must be after module mocks

_fake_summarizer_instance.list_templates.return_value = [
    TemplateInfo(name="general", description="General meeting notes template."),
    TemplateInfo(name="one-on-one", description="1-on-1 meeting template."),
    TemplateInfo(name="client-meeting", description="Client meeting template."),
]
_fake_summarizer_instance._load_template.return_value = (
    "You are an expert meeting note taker. Template content here."
)


def _fake_load_template(name: str) -> str:
    """Mock _load_template that returns content or raises FileNotFoundError."""
    if name == "nonexistent":
        raise FileNotFoundError(f"Prompt template not found: {name}")
    return f"You are an expert meeting note taker. Template: {name}."


_fake_summarizer_instance._load_template.side_effect = _fake_load_template


def _fake_chat(transcript: str, question: str, model=None, base_url=None, api_key=None):
    """Mock chat that validates input like the real one."""
    from src.models import ChatResponse

    if not transcript.strip():
        raise ValueError("Transcript is empty.")
    if not question.strip():
        raise ValueError("Question is empty.")
    return ChatResponse(answer=f"Answer to: {question}")


_fake_summarizer_instance.chat.side_effect = _fake_chat

# Patch the module-level singletons in server
_mock_whisper_transcriber = MagicMock(return_value=_fake_transcriber_instance)
_mock_ollama_summarizer = MagicMock(return_value=_fake_summarizer_instance)

# Mock faster_whisper and ollama at sys.modules level
_fake_whisper_mod = MagicMock()
_fake_whisper_model = MagicMock()
_fake_whisper_segment = MagicMock()
_fake_whisper_segment.text = "hello world"
_fake_whisper_info = MagicMock()
_fake_whisper_info.language = "en"
_fake_whisper_info.duration = 10.5
_fake_whisper_model.transcribe.return_value = ([_fake_whisper_segment], _fake_whisper_info)
_fake_whisper_mod.WhisperModel.return_value = _fake_whisper_model
sys.modules["faster_whisper"] = _fake_whisper_mod
_fake_ollama_mod = MagicMock()
_fake_ollama_client = MagicMock()
_fake_ollama_mod.Client.return_value = _fake_ollama_client
sys.modules["ollama"] = _fake_ollama_mod

# Now patch the classes used by the server
with (
    patch("src.transcriber.WhisperTranscriber", _mock_whisper_transcriber),
    patch("src.summarizer.OllamaSummarizer", _mock_ollama_summarizer),
):
    import src.server as _server_mod  # noqa: E402
    from src.server import app  # noqa: E402

# Bypass lifespan — inject mock singletons directly
_server_mod._transcriber = _fake_transcriber_instance
_server_mod._live_transcriber = _fake_transcriber_instance
_server_mod._summarizer = _fake_summarizer_instance

client = TestClient(app)


class TestHealthEndpoint:
    """Tests for GET /health."""

    def test_health_returns_200(self) -> None:
        """Test health endpoint returns 200 OK."""
        response = client.get("/health")
        assert response.status_code == 200

    def test_health_returns_health_response_model(self) -> None:
        """Test health endpoint returns the HealthResponse model structure."""
        response = client.get("/health")
        data = response.json()
        assert "status" in data
        assert "whisper_model" in data
        assert "ollama_available" in data
        assert isinstance(data["status"], str)
        assert isinstance(data["whisper_model"], str)
        assert isinstance(data["ollama_available"], bool)

    def test_health_status_is_ok(self) -> None:
        """Test health endpoint reports status 'ok' when services are up."""
        response = client.get("/health")
        data = response.json()
        assert data["status"] in ("ok", "degraded")


class TestTranscribeEndpoint:
    """Tests for POST /transcribe."""

    def test_transcribe_with_valid_path(self) -> None:
        """Test transcribe endpoint with a JSON audio_path body."""
        response = client.post(
            "/transcribe",
            json={"audio_path": "C:/temp/meeting_20260611_100000.wav"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "text" in data
        assert "language" in data
        assert "duration_seconds" in data
        assert "turns" in data
        assert isinstance(data["text"], str)
        assert isinstance(data["language"], str)
        assert isinstance(data["duration_seconds"], float)
        assert isinstance(data["turns"], list)

    def test_transcribe_no_body_returns_422(self) -> None:
        """Test transcribe endpoint returns 422 when no body is sent."""
        response = client.post("/transcribe")
        assert response.status_code == 422

    def test_transcribe_empty_path_returns_400(self) -> None:
        """Test transcribe endpoint rejects an empty audio_path."""
        response = client.post("/transcribe", json={"audio_path": "  "})
        assert response.status_code == 400

    def test_transcribe_missing_file_returns_400(self) -> None:
        """Test transcribe endpoint maps FileNotFoundError to 400."""
        _fake_transcriber_instance.transcribe.side_effect = FileNotFoundError(
            "Audio file not found: /nonexistent/audio.wav"
        )
        response = client.post(
            "/transcribe",
            json={"audio_path": "/nonexistent/audio.wav"},
        )
        assert response.status_code == 400
        _fake_transcriber_instance.transcribe.side_effect = None


class TestSummarizeEndpoint:
    """Tests for POST /summarize."""

    def test_summarize_with_valid_request(self) -> None:
        """Test summarize endpoint with valid request body."""
        response = client.post(
            "/summarize",
            json={
                "transcript": "Alice: Let's ship by Friday. Bob: Agreed.",
                "template_name": "general",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert "summary" in data
        assert "template_used" in data
        assert isinstance(data["summary"], str)
        assert isinstance(data["template_used"], str)

    def test_summarize_empty_transcript_returns_422(self) -> None:
        """Test summarize endpoint returns 422 for empty transcript."""
        response = client.post(
            "/summarize",
            json={"transcript": "", "template_name": "general"},
        )
        assert response.status_code == 422

    def test_summarize_missing_template_returns_400(self) -> None:
        """Test summarize endpoint returns 400 for unknown template."""
        _fake_summarizer_instance.summarize.side_effect = FileNotFoundError(
            "Prompt template not found: nonexistent"
        )
        response = client.post(
            "/summarize",
            json={"transcript": "Test text.", "template_name": "nonexistent"},
        )
        assert response.status_code in (400, 422)
        # Reset side effect
        _fake_summarizer_instance.summarize.side_effect = _fake_summarize

    def test_summarize_default_template(self) -> None:
        """Test summarize endpoint uses default template when not specified."""
        response = client.post(
            "/summarize",
            json={"transcript": "Test transcript text."},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["template_used"] is not None

    def test_summarize_accepts_user_notes(self) -> None:
        resp = client.post(
            "/summarize",
            json={
                "transcript": "Them: pricing talk.",
                "template_name": "general",
                "user_notes": "- pricing pushback",
            },
        )
        assert resp.status_code == 200


class TestTemplatesEndpoint:
    """Tests for GET /templates and GET /templates/{name}."""

    def test_list_templates_returns_200(self) -> None:
        """Test templates endpoint returns 200."""
        response = client.get("/templates")
        assert response.status_code == 200

    def test_list_templates_returns_array(self) -> None:
        """Test templates endpoint returns a JSON array of TemplateInfo."""
        response = client.get("/templates")
        data = response.json()
        assert isinstance(data, list)
        assert len(data) > 0
        for item in data:
            assert "name" in item
            assert "description" in item

    def test_get_template_content_returns_200(self) -> None:
        """Test GET /templates/general returns 200 with content."""
        response = client.get("/templates/general")
        assert response.status_code == 200
        data = response.json()
        assert "name" in data
        assert "content" in data
        assert data["name"] == "general"
        assert len(data["content"]) > 0

    def test_get_template_not_found_returns_404(self) -> None:
        """Test GET /templates/nonexistent returns 404."""
        _fake_summarizer_instance._load_template.side_effect = FileNotFoundError(
            "Prompt template not found: nonexistent"
        )
        response = client.get("/templates/nonexistent")
        assert response.status_code == 404
        _fake_summarizer_instance._load_template.side_effect = _fake_load_template


class TestChat:
    """Tests for POST /chat."""

    def test_chat_with_valid_request(self) -> None:
        resp = client.post(
            "/chat",
            json={"transcript": "Them: pricing is $5k.", "question": "What price?"},
        )
        assert resp.status_code == 200
        assert resp.json()["answer"] == "Answer to: What price?"

    def test_chat_empty_question_returns_422(self) -> None:
        resp = client.post(
            "/chat",
            json={"transcript": "Them: hi.", "question": "   "},
        )
        assert resp.status_code == 422

    def test_chat_missing_body_returns_422(self) -> None:
        resp = client.post("/chat", json={})
        assert resp.status_code == 422


class TestChatStream:
    """Tests for POST /chat_stream SSE streaming with retry."""

    def test_retries_on_empty_first_stream(self) -> None:
        """A zero-token stream is retried once; second call delivers tokens."""
        calls = []

        def _stream(**kwargs):
            calls.append(1)
            if len(calls) == 1:
                return iter([])  # aborted — no tokens
            return iter(["ok"])

        _fake_summarizer_instance.chat_stream = _stream
        try:
            resp = client.post(
                "/chat_stream",
                json={"transcript": "Them: hello.", "question": "What?"},
            )
            body = resp.text
            assert '{"t": "ok"}' in body
            assert "[DONE]" in body
            assert len(calls) == 2
        finally:
            _fake_summarizer_instance.chat_stream = None  # reset

    def test_double_empty_sends_error_frame(self) -> None:
        """Two zero-token streams → error SSE frame, no [DONE]."""

        def _stream(**kwargs):
            return iter([])

        _fake_summarizer_instance.chat_stream = _stream
        try:
            resp = client.post(
                "/chat_stream",
                json={"transcript": "Them: hello.", "question": "What?"},
            )
            body = resp.text
            assert "empty answer" in body
            assert "error" in body
            assert "[DONE]" not in body
        finally:
            _fake_summarizer_instance.chat_stream = None  # reset


class TestTranscribeChunk:
    """Tests for POST /transcribe_chunk (live caption preview)."""

    def test_chunk_returns_text(self) -> None:
        resp = client.post("/transcribe_chunk", json={"audio_path": "C:/tmp/win.wav"})
        assert resp.status_code == 200
        assert "text" in resp.json()

    def test_chunk_empty_path_returns_empty_text(self) -> None:
        resp = client.post("/transcribe_chunk", json={"audio_path": "  "})
        assert resp.status_code == 200
        assert resp.json()["text"] == ""

    def test_chunk_missing_body_returns_422(self) -> None:
        resp = client.post("/transcribe_chunk", json={})
        assert resp.status_code == 422


class TestServerErrorHandling:
    """Tests for server error handling."""

    def test_transcribe_internal_error_returns_500(self) -> None:
        """Test transcribe endpoint returns 500 on internal error."""
        _fake_transcriber_instance.transcribe.side_effect = RuntimeError(
            "Whisper model crashed"
        )
        response = client.post(
            "/transcribe",
            json={"audio_path": "C:/temp/meeting.wav"},
        )
        assert response.status_code == 500
        _fake_transcriber_instance.transcribe.side_effect = None

    def test_summarize_internal_error_returns_500(self) -> None:
        """Test summarize endpoint returns 500 on internal error."""
        _fake_summarizer_instance.summarize.side_effect = RuntimeError(
            "Ollama connection refused"
        )
        response = client.post(
            "/summarize",
            json={"transcript": "Test text.", "template_name": "general"},
        )
        assert response.status_code == 500
        _fake_summarizer_instance.summarize.side_effect = _fake_summarize


class TestImportAudio:
    """Tests for the single-file import path (single_file=true)."""

    def test_single_file_returns_transcribe_response(self) -> None:
        """POST /transcribe with single_file=true returns a TranscribeResponse."""
        with patch("src.server.decode_import_file") as mock_decode:
            mock_path = MagicMock()
            mock_path.__str__.return_value = "/tmp/import_abc.wav"
            mock_decode.return_value = mock_path

            resp = client.post(
                "/transcribe",
                json={
                    "audio_path": "/tmp/voice_memo.m4a",
                    "single_file": True,
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert "text" in data
            assert "language" in data
            assert "duration_seconds" in data
            assert "turns" in data
            assert isinstance(data["turns"], list)
            # The temp WAV must be cleaned up after transcription.
            mock_path.unlink.assert_called_once_with(missing_ok=True)

    def test_single_file_decode_failure_returns_400(self) -> None:
        """POST /transcribe with single_file=true maps ValueError → 400."""
        with patch("src.server.decode_import_file") as mock_decode:
            mock_decode.side_effect = ValueError("Corrupted file")

            resp = client.post(
                "/transcribe",
                json={
                    "audio_path": "/tmp/broken.m4a",
                    "single_file": True,
                },
            )
            assert resp.status_code == 400
            assert "Corrupted file" in resp.json()["detail"]

    def test_single_file_transcribe_failure_returns_500(self) -> None:
        """POST /transcribe with single_file=true maps transcribe error → 500."""
        with patch("src.server.decode_import_file") as mock_decode:
            mock_path = MagicMock()
            mock_path.__str__.return_value = "/tmp/import_abc.wav"
            mock_decode.return_value = mock_path
            _fake_transcriber_instance.transcribe.side_effect = RuntimeError(
                "Whisper crash"
            )

            resp = client.post(
                "/transcribe",
                json={
                    "audio_path": "/tmp/good.m4a",
                    "single_file": True,
                },
            )
            assert resp.status_code == 500
            # Temp file must still be cleaned up even on error.
            mock_path.unlink.assert_called_once_with(missing_ok=True)
            _fake_transcriber_instance.transcribe.side_effect = None


class TestEventLoopResponsiveness:
    """The heavy endpoints must be sync `def` (threadpooled) — an `async def`
    body with blocking ML calls parks the event loop and the whole service
    freezes for the duration of any transcription/summarization."""

    def test_heavy_endpoints_are_sync_def(self):
        import inspect

        for fn in (
            _server_mod.health,
            _server_mod.chat,
            _server_mod.transcribe,
            _server_mod.transcribe_chunk,
            _server_mod.summarize,
        ):
            assert not inspect.iscoroutinefunction(fn), (
                f"{fn.__name__} is async def with a blocking body — it will "
                "freeze the event loop for the duration of the call"
            )

    def test_chunk_skipped_while_whisper_busy(self):
        # A live-caption chunk must not queue behind a long /transcribe —
        # it returns empty text immediately when the Whisper lock is held.
        assert _server_mod._WHISPER_LOCK.acquire(blocking=False)
        _fake_transcriber_instance.transcribe.reset_mock()
        try:
            response = client.post(
                "/transcribe_chunk", json={"audio_path": "/tmp/window.wav"}
            )
            assert response.status_code == 200
            assert response.json()["text"] == ""
            _fake_transcriber_instance.transcribe.assert_not_called()
        finally:
            _server_mod._WHISPER_LOCK.release()
        # Lock free again → the chunk transcribes normally.
        response = client.post(
            "/transcribe_chunk", json={"audio_path": "/tmp/window.wav"}
        )
        assert response.status_code == 200
        assert response.json()["text"] == "Hello world transcript."

    def test_health_responds_while_transcription_runs(self):
        # End-to-end proof: with /transcribe blocked mid-inference, /health
        # still answers (it used to stall behind the event loop).
        import threading as th

        started, release = th.Event(), th.Event()

        def slow_dual(*args, **kwargs):
            started.set()
            assert release.wait(timeout=10), "test released too late"
            return MagicMock(text="done", language="en", duration_seconds=1.0, category_hint=None, turns=[])

        _fake_transcriber_instance.transcribe_dual.side_effect = slow_dual
        worker = th.Thread(
            target=client.post,
            args=("/transcribe",),
            kwargs={
                "json": {
                    "audio_path": "/tmp/sys.wav",
                    "mic_audio_path": "/tmp/mic.wav",
                }
            },
        )
        worker.start()
        try:
            assert started.wait(timeout=5), "transcription never started"
            response = client.get("/health")  # must not block
            assert response.status_code == 200
        finally:
            release.set()
            worker.join(timeout=10)
            _fake_transcriber_instance.transcribe_dual.side_effect = None
        assert not worker.is_alive()


class TestCategoryHint:
    """The transcription-time category verdict must ride through /summarize."""

    def test_hint_overrides_transcript_classification(self):
        response = client.post(
            "/summarize",
            json={
                "transcript": "Them: some video content here.",
                "category_hint": "youtube",
            },
        )
        assert response.status_code == 200
        assert response.json()["category"] == "youtube"

    def test_no_hint_keeps_default_classification(self):
        response = client.post(
            "/summarize",
            json={"transcript": "Me: update.\nThem: sounds good."},
        )
        assert response.status_code == 200
        assert response.json()["category"] == "meeting"


class TestAutoTemplateEndpoint:
    """The /summarize endpoint accepts auto_template and defaults it to False."""

    def test_auto_template_defaults_false_when_absent(self) -> None:
        """auto_template absent in the request body → defaults to False (backwards compat)."""
        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock(
                summary="ok",
                template_used=kwargs.get("template_name", "general"),
                title="T",
                attendees=[],
                category="meeting",
            )

        _fake_summarizer_instance.summarize.side_effect = _capture
        try:
            resp = client.post(
                "/summarize",
                json={"transcript": "Them: hello.", "template_name": "general"},
            )
            assert resp.status_code == 200
            assert captured.get("auto_template") is False
        finally:
            _fake_summarizer_instance.summarize.side_effect = _fake_summarize

    def test_auto_template_accepted_in_request(self) -> None:
        """auto_template=True in the request body reaches the summarizer."""
        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock(
                summary="ok",
                template_used=kwargs.get("template_name", "general"),
                title="T",
                attendees=[],
                category="meeting",
            )

        _fake_summarizer_instance.summarize.side_effect = _capture
        try:
            resp = client.post(
                "/summarize",
                json={
                    "transcript": "Them: hello.",
                    "template_name": "general",
                    "auto_template": True,
                },
            )
            assert resp.status_code == 200
            assert captured.get("auto_template") is True
        finally:
            _fake_summarizer_instance.summarize.side_effect = _fake_summarize


class TestViewerLabelEndpoint:
    """The /summarize endpoint accepts viewer_label and defaults it to None."""

    def test_viewer_label_accepted_in_request(self) -> None:
        """viewer_label in the request body reaches the summarizer."""
        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock(
                summary="ok",
                template_used=kwargs.get("template_name", "general"),
                title="T",
                attendees=[],
                category="meeting",
            )

        _fake_summarizer_instance.summarize.side_effect = _capture
        try:
            resp = client.post(
                "/summarize",
                json={
                    "transcript": "Hamza: some video content.",
                    "template_name": "youtube",
                    "viewer_label": "Hamza",
                },
            )
            assert resp.status_code == 200
            assert captured.get("viewer_label") == "Hamza"
        finally:
            _fake_summarizer_instance.summarize.side_effect = _fake_summarize

    def test_viewer_label_defaults_none_when_absent(self) -> None:
        """viewer_label absent in the request body → defaults to None."""
        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock(
                summary="ok",
                template_used=kwargs.get("template_name", "general"),
                title="T",
                attendees=[],
                category="meeting",
            )

        _fake_summarizer_instance.summarize.side_effect = _capture
        try:
            resp = client.post(
                "/summarize",
                json={"transcript": "Them: hello.", "template_name": "general"},
            )
            assert resp.status_code == 200
            assert captured.get("viewer_label") is None
        finally:
            _fake_summarizer_instance.summarize.side_effect = _fake_summarize


class TestLiveFeedSources:
    """POST /live_feed routes system audio and the mic to INDEPENDENT VAD
    sessions, so the user's own speech is captioned live — not just system
    audio. Regression for: live transcript worked for YouTube (system audio)
    but showed nothing when the user spoke (mic never fed / a shared singleton
    session swallowed it)."""

    class _FakeSession:
        """Deterministic stand-in for LiveCaptionSession (no VAD / decode)."""

        def __init__(self) -> None:
            self.ingested: list[tuple[int, str]] = []

        def ingest(self, session: int, path: str) -> None:
            self.ingested.append((session, path))

        def pending_utterances(self):
            return [(0, 16000)], 16000  # one finished utterance every feed

        def write_utterance_wav(self, start: int, end: int):
            return Path("/tmp/mnt_live_test_utt.wav")  # transcribe is mocked

        def advance(self, watermark: int) -> None:
            pass

    def test_me_and_them_are_independent_sessions(self, monkeypatch) -> None:
        monkeypatch.setattr(_server_mod, "LiveCaptionSession", self._FakeSession)
        _server_mod._live_sessions.clear()

        them = client.post(
            "/live_feed",
            json={"audio_path": "/tmp/sys.wav", "session": 1, "source": "them"},
        )
        me = client.post(
            "/live_feed",
            json={"audio_path": "/tmp/mic.wav", "session": 1, "source": "me"},
        )

        assert them.status_code == 200 and me.status_code == 200
        # Both sources are captioned — the mic is NOT swallowed by the system
        # session's watermark (the pre-fix shared-singleton bug).
        assert them.json()["captions"] == ["Hello world transcript."]
        assert me.json()["captions"] == ["Hello world transcript."]
        # One session object per source for the same recording epoch.
        assert set(_server_mod._live_sessions) == {"them", "me"}
        assert _server_mod._live_sessions["them"].ingested == [(1, "/tmp/sys.wav")]
        assert _server_mod._live_sessions["me"].ingested == [(1, "/tmp/mic.wav")]

    def test_source_defaults_to_them_when_absent(self, monkeypatch) -> None:
        """An old client that omits `source` still works (defaults to system)."""
        monkeypatch.setattr(_server_mod, "LiveCaptionSession", self._FakeSession)
        _server_mod._live_sessions.clear()

        resp = client.post(
            "/live_feed", json={"audio_path": "/tmp/sys.wav", "session": 7}
        )
        assert resp.status_code == 200
        assert list(_server_mod._live_sessions) == ["them"]
