"""Qwen3-ASR registry, lazy loading, coarse timestamps, and request routing.

The production dependency and model snapshots are deliberately absent from the
test environment. Every ML boundary is replaced with a small in-memory fake so
these tests cannot install packages, fetch weights, or invoke the Apple GPU.
"""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest
from fastapi.testclient import TestClient

import src.server as server
import src.transcriber as transcriber
from src.models import TranscribeResponse
from src.server import app

QWEN_KEY = "qwen3-asr-0.6b"
QWEN_REPO = "mlx-community/Qwen3-ASR-0.6B-bf16"

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_qwen_cache():
    """A process cache must not leak instances between unit tests."""
    transcriber._QWEN_TRANSCRIBERS.clear()
    yield
    transcriber._QWEN_TRANSCRIBERS.clear()


@pytest.fixture
def qwen_module(monkeypatch: pytest.MonkeyPatch):
    """Provide the optional qwen3-asr-mlx module without importing the wheel."""
    model = MagicMock()
    qwen_class = MagicMock()
    qwen_class.from_pretrained.return_value = model
    module = ModuleType("qwen3_asr_mlx")
    module.Qwen3ASR = qwen_class
    monkeypatch.setitem(sys.modules, "qwen3_asr_mlx", module)
    return model, qwen_class


def _qwen_with_model(fake_model: object) -> transcriber.Qwen3AsrTranscriber:
    instance = transcriber.Qwen3AsrTranscriber(QWEN_REPO)
    instance._model = fake_model
    return instance


def _response(text: str) -> TranscribeResponse:
    return TranscribeResponse(
        text=text,
        language="en",
        duration_seconds=1.0,
        turns=[],
    )


def _resident() -> MagicMock:
    resident = MagicMock()
    resident.model_size = "large-v3"
    resident.model_repo = "mlx-community/whisper-large-v3-mlx"
    resident.initial_prompt = None
    resident.transcribe.return_value = _response("resident transcript")
    return resident


def test_registry_routes_qwen_only_on_mlx(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(transcriber, "backend_is_mlx", lambda: True)
    monkeypatch.setattr(transcriber, "whisper_model_is_cached", lambda repo: False)

    mlx_models = {entry["key"]: entry for entry in transcriber.list_whisper_models()}
    assert mlx_models["qwen3-asr-0.6b"]["engine"] == "qwen3-asr"
    assert mlx_models["qwen3-asr-1.7b"]["engine"] == "qwen3-asr"
    assert all(
        entry["engine"] == "whisper"
        for key, entry in mlx_models.items()
        if not key.startswith("qwen3-asr-") and key != "cohere-transcribe-2b"
    )

    monkeypatch.setattr(transcriber, "backend_is_mlx", lambda: False)
    ct2_models = {entry["key"]: entry for entry in transcriber.list_whisper_models()}
    assert "qwen3-asr-0.6b" not in ct2_models
    assert "qwen3-asr-1.7b" not in ct2_models
    assert (
        transcriber.whisper_repo_for("qwen3-asr-0.6b")
        == transcriber.active_whisper_models()["large-v3-turbo"]["repo"]
    )


def test_get_qwen_transcriber_rejects_missing_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(transcriber, "whisper_model_is_cached", lambda repo: False)

    with pytest.raises(RuntimeError, match="is not downloaded"):
        transcriber.get_qwen_transcriber(QWEN_REPO)


def test_get_qwen_transcriber_caches_instance_and_loaded_model(
    monkeypatch: pytest.MonkeyPatch,
    qwen_module,
) -> None:
    model, qwen_class = qwen_module
    monkeypatch.setattr(transcriber, "whisper_model_is_cached", lambda repo: True)

    first = transcriber.get_qwen_transcriber(QWEN_REPO)
    second = transcriber.get_qwen_transcriber(QWEN_REPO)
    assert first is second
    assert first._load_model() is model
    assert first._load_model() is model
    qwen_class.from_pretrained.assert_called_once_with(QWEN_REPO)


def test_chunking_derives_three_windows_for_75_seconds(
    monkeypatch: pytest.MonkeyPatch,
    qwen_module,
) -> None:
    lengths: list[int] = []

    class FakeModel:
        def transcribe(self, audio, **kwargs):
            lengths.append(len(audio))
            return SimpleNamespace(text=f"window {len(lengths)}", language="en")

    samples = np.zeros(75 * transcriber._CLOUD_TARGET_RATE, dtype=np.int16)
    monkeypatch.setattr(transcriber, "_decode_to_mono16k", lambda path: samples)
    instance = _qwen_with_model(FakeModel())

    segments, info = instance._collect_segments("ignored.wav")

    assert lengths == [30 * 16000, 30 * 16000, 15 * 16000]
    assert segments == [
        (0.0, 30.0, "window 1"),
        (30.0, 60.0, "window 2"),
        (60.0, 75.0, "window 3"),
    ]
    assert info.language == "en"
    assert info.duration == 75.0


@pytest.mark.parametrize(
    ("prompt", "expected_kwargs"),
    [
        ("Glossary: Adversaria.", {"context": "Glossary: Adversaria."}),
        (None, {}),
    ],
)
def test_context_is_only_passed_when_prompt_is_set(
    monkeypatch: pytest.MonkeyPatch,
    qwen_module,
    prompt: str | None,
    expected_kwargs: dict[str, str],
) -> None:
    calls: list[dict[str, str]] = []

    class FakeModel:
        def transcribe(self, audio, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(text="hello", language="en")

    samples = np.zeros(transcriber._CLOUD_TARGET_RATE, dtype=np.int16)
    monkeypatch.setattr(transcriber, "_decode_to_mono16k", lambda path: samples)
    instance = _qwen_with_model(FakeModel())
    instance.initial_prompt = prompt

    instance._collect_segments("ignored.wav")

    assert calls == [expected_kwargs]


def test_empty_window_is_skipped(
    monkeypatch: pytest.MonkeyPatch,
    qwen_module,
) -> None:
    results = iter(
        [
            SimpleNamespace(text="  ", language="ar"),
            SimpleNamespace(text="kept", language="en"),
        ]
    )

    class FakeModel:
        def transcribe(self, audio, **kwargs):
            return next(results)

    samples = np.zeros(60 * transcriber._CLOUD_TARGET_RATE, dtype=np.int16)
    monkeypatch.setattr(transcriber, "_decode_to_mono16k", lambda path: samples)
    instance = _qwen_with_model(FakeModel())

    segments, info = instance._collect_segments("ignored.wav")

    assert segments == [(30.0, 60.0, "kept")]
    assert info.language == "ar"


def test_server_routes_qwen_request_to_request_local_transcriber(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resident = _resident()
    qwen = MagicMock()
    qwen.model_repo = QWEN_REPO
    qwen.initial_prompt = None
    qwen.transcribe.return_value = _response("qwen transcript")
    requested_repos: list[str] = []

    monkeypatch.setenv("WHISPER_BACKEND", "mlx")
    monkeypatch.setattr(server, "_transcriber", resident)
    monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "ready")
    monkeypatch.setattr(
        server,
        "get_qwen_transcriber",
        lambda repo: (requested_repos.append(repo), qwen)[1],
    )

    response = client.post(
        "/transcribe",
        json={"audio_path": "/fake.wav", "whisper_model": QWEN_KEY},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "qwen transcript"
    assert requested_repos == [QWEN_REPO]
    qwen.transcribe.assert_called_once_with("/fake.wav")
    resident.transcribe.assert_not_called()
    assert qwen.initial_prompt is None


def test_server_falls_back_to_resident_when_qwen_is_not_cached(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resident = _resident()

    def missing(repo: str):
        raise RuntimeError(f"Qwen3-ASR model {repo} is not downloaded")

    monkeypatch.setenv("WHISPER_BACKEND", "mlx")
    monkeypatch.setattr(server, "_transcriber", resident)
    monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "ready")
    monkeypatch.setattr(server, "get_qwen_transcriber", missing)

    response = client.post(
        "/transcribe",
        json={"audio_path": "/fake.wav", "whisper_model": QWEN_KEY},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "resident transcript"
    resident.transcribe.assert_called_once_with("/fake.wav")
    resident.ensure_model_repo.assert_not_called()
    assert resident.initial_prompt is None
