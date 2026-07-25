"""Tests for the WhisperTranscriber module."""

from __future__ import annotations

import importlib
import struct
import sys
import tempfile
import wave
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Mock faster_whisper before any import that might trigger it
_fake_whisper = MagicMock()
_fake_info = MagicMock()
_fake_info.language = "en"
_fake_info.duration = 10.5
_fake_segment = MagicMock()
_fake_segment.start = 0.0
_fake_segment.end = 1.0
_fake_segment.text = "hello world"
_fake_model_instance = MagicMock()
_fake_model_instance.transcribe.return_value = ([_fake_segment], _fake_info)
_fake_whisper.WhisperModel.return_value = _fake_model_instance
sys.modules["faster_whisper"] = _fake_whisper

# Reload src.transcriber to pick up the mock (addresses ordering issues when
# test_server.py also mocks faster_whisper at the module level)
import src.transcriber  # noqa: E402
importlib.reload(src.transcriber)

from src.transcriber import WhisperTranscriber  # noqa: E402
from src.models import TranscribeResponse  # noqa: E402


@pytest.fixture
def transcriber() -> WhisperTranscriber:
    """Create a WhisperTranscriber with mocked faster-whisper model."""
    return WhisperTranscriber(model_size="large-v3", device="cuda", compute_type="int8_float16")


@pytest.fixture
def silent_audio_path(tmp_path: Path) -> str:
    """Create a minimal valid WAV file for testing."""
    import struct
    import wave

    wav_path = tmp_path / "test.wav"
    sample_rate = 16000
    duration = 0.5
    n_samples = int(sample_rate * duration)
    with wave.open(str(wav_path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(struct.pack(f"<{n_samples}h", *([0] * n_samples)))
    return str(wav_path)


class TestWhisperTranscriberInit:
    """Tests for WhisperTranscriber initialization."""

    def test_init_stores_config(self) -> None:
        """Test that __init__ stores model configuration correctly."""
        t = WhisperTranscriber(model_size="medium", device="cpu", compute_type="int8")
        assert t.model_size == "medium"
        assert t.device == "cpu"
        assert t.compute_type == "int8"

    def test_init_loads_model(self, transcriber: WhisperTranscriber) -> None:
        """Test that __init__ loads the whisper model."""
        assert transcriber.model is not None
        _fake_whisper.WhisperModel.assert_called()


class TestTranscribe:
    """Tests for the transcribe method."""

    def test_transcribe_returns_correct_shape(
        self, transcriber: WhisperTranscriber, silent_audio_path: str
    ) -> None:
        """Test transcribe returns a TranscribeResponse with correct fields."""
        result = transcriber.transcribe(silent_audio_path)
        assert isinstance(result, TranscribeResponse)
        assert isinstance(result.text, str)
        assert isinstance(result.language, str)
        assert isinstance(result.duration_seconds, float)
        assert result.duration_seconds > 0

    def test_transcribe_missing_file_raises(
        self, transcriber: WhisperTranscriber
    ) -> None:
        """Test transcribe raises FileNotFoundError for missing file."""
        with pytest.raises(FileNotFoundError):
            transcriber.transcribe("/nonexistent/path/audio.wav")

    def test_transcribe_calls_whisper_model(
        self, transcriber: WhisperTranscriber, silent_audio_path: str
    ) -> None:
        """Test transcribe delegates to the underlying WhisperModel."""
        transcriber.model.transcribe.reset_mock()
        transcriber.transcribe(silent_audio_path)
        transcriber.model.transcribe.assert_called_once()


class TestTranscribeBytes:
    """Tests for the transcribe_bytes method."""

    def test_transcribe_bytes_returns_correct_shape(
        self, transcriber: WhisperTranscriber, silent_audio_path: str
    ) -> None:
        """Test transcribe_bytes returns a TranscribeResponse with correct fields."""
        audio_bytes = Path(silent_audio_path).read_bytes()
        result = transcriber.transcribe_bytes(audio_bytes)
        assert isinstance(result, TranscribeResponse)
        assert isinstance(result.text, str)
        assert isinstance(result.language, str)
        assert isinstance(result.duration_seconds, float)

    def test_transcribe_bytes_empty_data_raises(
        self, transcriber: WhisperTranscriber
    ) -> None:
        """Test transcribe_bytes raises ValueError for empty bytes."""
        with pytest.raises(ValueError):
            transcriber.transcribe_bytes(b"")


class TestTranscribeResponseFields:
    """Tests validating the shape of TranscribeResponse returned by transcriber."""

    def test_language_field_present(
        self, transcriber: WhisperTranscriber, silent_audio_path: str
    ) -> None:
        """Test the language field is populated."""
        result = transcriber.transcribe(silent_audio_path)
        assert result.language == "en"

    def test_duration_field_positive(
        self, transcriber: WhisperTranscriber, silent_audio_path: str
    ) -> None:
        """Test the duration_seconds field is positive."""
        result = transcriber.transcribe(silent_audio_path)
        assert result.duration_seconds > 0

    def test_text_field_is_string(
        self, transcriber: WhisperTranscriber, silent_audio_path: str
    ) -> None:
        """Test the text field is a non-empty string."""
        result = transcriber.transcribe(silent_audio_path)
        assert isinstance(result.text, str)
        assert len(result.text) > 0


class TestTranscribeResponseTurns:
    """Tests validating the turns field on TranscribeResponse."""

    def test_turns_present_in_response(
        self, transcriber: WhisperTranscriber, silent_audio_path: str
    ) -> None:
        """TranscribeResponse includes a turns list."""
        result = transcriber.transcribe(silent_audio_path)
        assert hasattr(result, "turns")
        assert isinstance(result.turns, list)

    def test_single_file_turns_are_them_labeled(
        self, transcriber: WhisperTranscriber, silent_audio_path: str
    ) -> None:
        """Single-file turns use speaker 'Them' (unlabeled flat text)."""
        result = transcriber.transcribe(silent_audio_path)
        for turn in result.turns:
            assert turn.speaker == "Them"

    def test_turns_empty_for_empty_segments(self, transcriber: WhisperTranscriber) -> None:
        """No segments → no turns."""
        transcriber.model.transcribe.return_value = ([], _fake_info)
        # Create a minimal WAV so transcribe doesn't fail on file check
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sample_rate = 16000
            n_samples = int(sample_rate * 0.1)
            with wave.open(tmp.name, "w") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(struct.pack(f"<{n_samples}h", *([0] * n_samples)))
            result = transcriber.transcribe(tmp.name)
        assert result.turns == []
        # Restore the original mock
        transcriber.model.transcribe.return_value = ([_fake_segment], _fake_info)
