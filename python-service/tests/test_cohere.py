"""Cohere Transcribe registry, sherpa loading, chunking, and routing tests."""

from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest
from fastapi.testclient import TestClient

import src.server as server
import src.transcriber as transcriber
from src.models import TranscribeResponse
from src.server import app

# The server calls str() on this Path, so expectations must be built the same
# way — a hardcoded "/first-window.wav" breaks on Windows ("\\first-window.wav").
FIRST_WINDOW = Path("/first-window.wav")

COHERE_KEY = "cohere-transcribe-2b"
COHERE_REPO = (
    "csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01"
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_cohere_caches():
    transcriber._COHERE_TRANSCRIBERS.clear()
    transcriber._COHERE_RECOGNIZERS.clear()
    yield
    transcriber._COHERE_TRANSCRIBERS.clear()
    transcriber._COHERE_RECOGNIZERS.clear()


@pytest.fixture
def sherpa_module(monkeypatch: pytest.MonkeyPatch):
    factory = MagicMock()
    module = ModuleType("sherpa_onnx")
    module.OfflineRecognizer = SimpleNamespace(from_cohere_transcribe=factory)
    monkeypatch.setitem(sys.modules, "sherpa_onnx", module)
    return factory


def _response(text: str, language: str) -> TranscribeResponse:
    return TranscribeResponse(
        text=text,
        language=language,
        duration_seconds=1.0,
        turns=[],
    )


def _resident(language: str = "en") -> MagicMock:
    resident = MagicMock()
    resident.model_size = "large-v3"
    resident.model_repo = "mlx-community/whisper-large-v3-mlx"
    resident.initial_prompt = None
    resident.transcribe.return_value = _response("resident transcript", language)
    return resident


def _cohere() -> MagicMock:
    cohere = MagicMock()
    cohere.model_repo = COHERE_REPO
    cohere.language = "en"
    cohere.initial_prompt = None
    cohere.transcribe.return_value = _response("cohere transcript", "en")
    return cohere


def test_registry_exposes_cohere_on_both_backends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(transcriber, "whisper_model_is_cached", lambda repo: False)

    monkeypatch.setattr(transcriber, "backend_is_mlx", lambda: True)
    mlx_models = {entry["key"]: entry for entry in transcriber.list_whisper_models()}
    assert mlx_models[COHERE_KEY]["engine"] == "cohere"

    monkeypatch.setattr(transcriber, "backend_is_mlx", lambda: False)
    ct2_models = {entry["key"]: entry for entry in transcriber.list_whisper_models()}
    assert ct2_models[COHERE_KEY]["engine"] == "cohere"
    assert transcriber.whisper_repo_for(COHERE_KEY) == COHERE_REPO


def test_cohere_cache_requires_complete_export(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo_root = tmp_path / ("models--" + COHERE_REPO.replace("/", "--"))
    revision = repo_root / "snapshots" / "revision"
    revision.mkdir(parents=True)
    monkeypatch.setattr(transcriber, "_hf_cache_root", lambda: tmp_path)

    (revision / "decoder.int8.onnx").touch()
    assert not transcriber.whisper_model_is_cached(COHERE_REPO)

    for name in transcriber._COHERE_MODEL_FILES:
        (revision / name).touch()
    assert transcriber.whisper_model_is_cached(COHERE_REPO)


def test_get_cohere_transcriber_rejects_missing_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(transcriber, "whisper_model_is_cached", lambda repo: False)

    with pytest.raises(RuntimeError, match="is not downloaded"):
        transcriber.get_cohere_transcriber(COHERE_REPO)


def test_cohere_caches_transcriber_per_repo_and_recognizer_per_language(
    monkeypatch: pytest.MonkeyPatch,
    sherpa_module: MagicMock,
) -> None:
    recognizers = [MagicMock(), MagicMock()]
    sherpa_module.side_effect = recognizers
    monkeypatch.setattr(transcriber, "whisper_model_is_cached", lambda repo: True)
    monkeypatch.setattr(
        transcriber.CohereTranscriber,
        "_snapshot_path",
        lambda self: Path("/models/cohere"),
    )

    first = transcriber.get_cohere_transcriber(COHERE_REPO)
    second = transcriber.get_cohere_transcriber(COHERE_REPO)
    assert first is second
    assert first._load_recognizer() is recognizers[0]
    assert first._load_recognizer() is recognizers[0]

    first.language = "es"
    assert first._load_recognizer() is recognizers[1]
    assert first._load_recognizer() is recognizers[1]
    assert [call.kwargs["language"] for call in sherpa_module.call_args_list] == [
        "en",
        "es",
    ]


def test_chunking_derives_three_windows_for_75_seconds(
    monkeypatch: pytest.MonkeyPatch,
    sherpa_module: MagicMock,
) -> None:
    lengths: list[int] = []
    texts = iter(["window 1", "window 2", "window 3"])

    class FakeRecognizer:
        def create_stream(self):
            return SimpleNamespace(
                accept_waveform=lambda rate, audio: lengths.append(len(audio)),
                result=SimpleNamespace(text=""),
            )

        def decode_stream(self, stream):
            stream.result.text = next(texts)

    samples = np.zeros(75 * transcriber._CLOUD_TARGET_RATE, dtype=np.int16)
    monkeypatch.setattr(transcriber, "_decode_to_mono16k", lambda path: samples)
    instance = transcriber.CohereTranscriber(COHERE_REPO)
    monkeypatch.setattr(instance, "_load_recognizer", lambda: FakeRecognizer())

    segments, info = instance._collect_segments("ignored.wav")

    assert lengths == [30 * 16000, 30 * 16000, 15 * 16000]
    assert segments == [
        (0.0, 30.0, "window 1"),
        (30.0, 60.0, "window 2"),
        (60.0, 75.0, "window 3"),
    ]
    assert info.language == "en"
    assert info.duration == 75.0


def test_empty_window_is_skipped(
    monkeypatch: pytest.MonkeyPatch,
    sherpa_module: MagicMock,
) -> None:
    texts = iter(["  ", "kept"])

    class FakeRecognizer:
        def create_stream(self):
            return SimpleNamespace(
                accept_waveform=lambda rate, audio: None,
                result=SimpleNamespace(text=""),
            )

        def decode_stream(self, stream):
            stream.result.text = next(texts)

    samples = np.zeros(60 * transcriber._CLOUD_TARGET_RATE, dtype=np.int16)
    monkeypatch.setattr(transcriber, "_decode_to_mono16k", lambda path: samples)
    instance = transcriber.CohereTranscriber(COHERE_REPO)
    monkeypatch.setattr(instance, "_load_recognizer", lambda: FakeRecognizer())

    segments, _ = instance._collect_segments("ignored.wav")

    assert segments == [(30.0, 60.0, "kept")]


def test_server_detects_spanish_then_routes_to_cohere(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resident = _resident("es")
    cohere = _cohere()
    requested_repos: list[str] = []

    monkeypatch.setenv("WHISPER_BACKEND", "mlx")
    monkeypatch.setattr(server, "_transcriber", resident)
    monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "ready")
    monkeypatch.setattr(
        server, "decode_first_asr_window", lambda path: FIRST_WINDOW
    )
    monkeypatch.setattr(
        server,
        "get_cohere_transcriber",
        lambda repo: (requested_repos.append(repo), cohere)[1],
    )

    response = client.post(
        "/transcribe",
        json={"audio_path": "/fake.wav", "whisper_model": COHERE_KEY},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "cohere transcript"
    assert requested_repos == [COHERE_REPO]
    assert cohere.language == "es"
    resident.transcribe.assert_called_once_with(str(FIRST_WINDOW))
    cohere.transcribe.assert_called_once_with("/fake.wav")


def test_server_unsupported_language_uses_resident_for_whole_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resident = _resident("hi")

    monkeypatch.setenv("WHISPER_BACKEND", "mlx")
    monkeypatch.setattr(server, "_transcriber", resident)
    monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "ready")
    monkeypatch.setattr(
        server, "decode_first_asr_window", lambda path: FIRST_WINDOW
    )
    get_cohere = MagicMock()
    monkeypatch.setattr(server, "get_cohere_transcriber", get_cohere)

    response = client.post(
        "/transcribe",
        json={"audio_path": "/fake.wav", "whisper_model": COHERE_KEY},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "resident transcript"
    assert [call.args[0] for call in resident.transcribe.call_args_list] == [
        str(FIRST_WINDOW),
        "/fake.wav",
    ]
    get_cohere.assert_not_called()


def test_server_detection_failure_uses_english_cohere(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resident = _resident()
    resident.transcribe.side_effect = RuntimeError("detection failed")
    cohere = _cohere()

    monkeypatch.setenv("WHISPER_BACKEND", "mlx")
    monkeypatch.setattr(server, "_transcriber", resident)
    monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "ready")
    monkeypatch.setattr(
        server, "decode_first_asr_window", lambda path: FIRST_WINDOW
    )
    monkeypatch.setattr(server, "get_cohere_transcriber", lambda repo: cohere)

    response = client.post(
        "/transcribe",
        json={"audio_path": "/fake.wav", "whisper_model": COHERE_KEY},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "cohere transcript"
    assert cohere.language == "en"
    cohere.transcribe.assert_called_once_with("/fake.wav")
