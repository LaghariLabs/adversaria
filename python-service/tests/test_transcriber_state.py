"""Service resilience: the transcriber state machine and structured 503s (V3).

The 2026-07-31 fresh-Windows failure: the service either blocked its port on a
hidden multi-GB download inside the lifespan, died outright when that fetch
failed, or served forever with `_transcriber = None` and a bare-string 503
pasted verbatim into the UI. These tests pin the V3 contract instead: the
service always serves, `/health` says WHY transcription is unavailable,
`/transcribe` heals without a restart once a model lands, nothing ever
downloads uninvited, and cloud (BYOK) transcription never depends on a local
model.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import src.server as server
from src.server import app

client = TestClient(app)


def _fake_transcriber() -> MagicMock:
    fake = MagicMock()
    fake.model_size = "large-v3-turbo"
    fake.transcribe.return_value = MagicMock(
        text="Hello world transcript.",
        language="en",
        duration_seconds=42.0,
        category_hint=None,
        turns=[],
    )
    return fake


@pytest.fixture(autouse=True)
def _reset_server_state(monkeypatch: pytest.MonkeyPatch):
    """Every test starts from 'fresh machine': no transcriber, state missing."""
    monkeypatch.setattr(server, "_transcriber", None)
    monkeypatch.setattr(server, "_live_transcriber", None)
    monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "missing")
    monkeypatch.setattr(
        server, "_TRANSCRIBER_DETAIL", "No transcription model is downloaded yet."
    )
    # The warm-up thread is irrelevant here and would race the mocks.
    monkeypatch.setattr(server, "_warm_live_model", lambda main: None)
    yield


class TestHealthTranscriberState:
    def test_missing_state_is_reported(self) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["transcriber_state"] == "missing"
        assert data["transcriber_detail"] == "No transcription model is downloaded yet."
        assert data["whisper_model"] == "N/A"

    def test_loaded_transcriber_reads_ready(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(server, "_transcriber", _fake_transcriber())
        # A stale state value must not contradict a live transcriber.
        monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "loading")
        data = client.get("/health").json()
        assert data["transcriber_state"] == "ready"
        assert data["transcriber_detail"] is None
        assert data["whisper_model"] == "large-v3-turbo"


class TestTranscribeStructured503:
    def test_missing_model_returns_code_and_message(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        init_calls: list[bool] = []
        monkeypatch.setattr(
            server, "_init_transcriber", lambda: init_calls.append(True)
        )
        response = client.post("/transcribe", json={"audio_path": "/x.wav"})
        assert response.status_code == 503
        detail = response.json()["detail"]
        assert detail["code"] == "transcriber_missing"
        assert detail["message"]
        # A missing model is retried on demand: the model may have just landed.
        assert init_calls == [True]

    def test_loading_does_not_retry_init(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "loading")
        monkeypatch.setattr(server, "_TRANSCRIBER_DETAIL", None)
        init_calls: list[bool] = []
        monkeypatch.setattr(
            server, "_init_transcriber", lambda: init_calls.append(True)
        )
        response = client.post("/transcribe", json={"audio_path": "/x.wav"})
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "transcriber_loading"
        assert init_calls == []

    def test_error_state_carries_its_detail(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "error")
        monkeypatch.setattr(server, "_TRANSCRIBER_DETAIL", "Model looks incomplete.")
        monkeypatch.setattr(server, "_init_transcriber", lambda: None)
        response = client.post("/transcribe", json={"audio_path": "/x.wav"})
        assert response.status_code == 503
        detail = response.json()["detail"]
        assert detail["code"] == "transcriber_error"
        assert detail["message"] == "Model looks incomplete."

    def test_reinit_heals_the_request(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Download finished moments ago → the same request now succeeds."""
        fake = _fake_transcriber()

        def revive() -> None:
            server._transcriber = fake

        monkeypatch.setattr(server, "_init_transcriber", revive)
        response = client.post("/transcribe", json={"audio_path": "/x.wav"})
        # The guard healed; the request proceeded into real transcription
        # (which 400s on the nonexistent file — the guard is what's under test).
        assert response.status_code != 503


class TestCloudBypassesLocalGuard:
    def test_cloud_transcription_needs_no_local_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """BYOK users were wrongly 503'd when no local model existed."""
        monkeypatch.setattr(
            server,
            "transcribe_cloud",
            lambda *a, **k: MagicMock(
                text="cloud transcript",
                language="en",
                duration_seconds=5.0,
                category_hint=None,
                turns=[],
            ),
        )
        monkeypatch.setattr(server, "_init_transcriber", lambda: None)
        response = client.post(
            "/transcribe",
            json={
                "audio_path": "/x.wav",
                "transcription_base_url": "https://api.example.test/v1",
            },
        )
        assert response.status_code == 200
        assert response.json()["text"] == "cloud transcript"


class TestInitTranscriber:
    """_init_transcriber loads only what is already on disk — never downloads."""

    @pytest.fixture(autouse=True)
    def _pin_backend(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("WHISPER_BACKEND", "faster-whisper")
        monkeypatch.delenv("WHISPER_MODEL", raising=False)
        monkeypatch.delenv("MLX_WHISPER_MODEL", raising=False)
        monkeypatch.setattr(server, "_TRANSCRIBER_STATE", "loading")
        monkeypatch.setattr(server, "_TRANSCRIBER_DETAIL", None)
        yield

    def test_no_cached_model_means_missing_not_dead(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(server, "whisper_model_is_cached", lambda repo: False)
        created: list[object] = []
        monkeypatch.setattr(
            server, "create_transcriber", lambda key=None: created.append(key)
        )
        server._init_transcriber()
        assert server._transcriber is None
        assert server._TRANSCRIBER_STATE == "missing"
        assert created == []

    def test_default_model_loads_when_cached(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(server, "whisper_model_is_cached", lambda repo: True)
        fake = _fake_transcriber()
        keys: list[str | None] = []
        monkeypatch.setattr(
            server, "create_transcriber", lambda key=None: (keys.append(key), fake)[1]
        )
        server._init_transcriber()
        assert server._transcriber is fake
        assert server._TRANSCRIBER_STATE == "ready"
        assert keys == ["large-v3-turbo"]

    def test_falls_back_to_whatever_is_cached(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Default turbo absent but large-v3 present (e.g. a pre-V3 install):
        load what exists instead of reporting missing."""
        monkeypatch.setattr(
            server,
            "whisper_model_is_cached",
            lambda repo: repo == "Systran/faster-whisper-large-v3",
        )
        fake = _fake_transcriber()
        keys: list[str | None] = []
        monkeypatch.setattr(
            server, "create_transcriber", lambda key=None: (keys.append(key), fake)[1]
        )
        server._init_transcriber()
        assert server._transcriber is fake
        assert keys == ["large-v3"]

    def test_qwen_only_machine_is_ready_without_a_resident(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Only Qwen3-ASR weights on disk: final transcription works via
        per-request routing, so health must say ready — but nothing loads
        into the resident slot (live captions need Whisper)."""
        monkeypatch.setenv("WHISPER_BACKEND", "mlx")
        monkeypatch.setattr(
            server,
            "whisper_model_is_cached",
            lambda repo: "qwen3-asr" in repo.lower(),
        )
        created: list[object] = []
        monkeypatch.setattr(
            server, "create_transcriber", lambda key=None: created.append(key)
        )
        server._init_transcriber()
        assert server._transcriber is None
        assert server._TRANSCRIBER_STATE == "ready"
        assert "Live captions" in (server._TRANSCRIBER_DETAIL or "")
        assert created == []

    def test_load_failure_is_an_error_state_not_a_crash(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(server, "whisper_model_is_cached", lambda repo: True)

        def boom(key=None):
            raise RuntimeError("corrupt snapshot")

        monkeypatch.setattr(server, "create_transcriber", boom)
        server._init_transcriber()
        assert server._transcriber is None
        assert server._TRANSCRIBER_STATE == "error"
        assert "Settings" in (server._TRANSCRIBER_DETAIL or "")

    def test_env_override_skips_cache_gating(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """WHISPER_MODEL is the dev escape hatch — honoured verbatim."""
        monkeypatch.setenv("WHISPER_MODEL", "/models/custom")
        cache_probes: list[str] = []
        monkeypatch.setattr(
            server,
            "whisper_model_is_cached",
            lambda repo: (cache_probes.append(repo), False)[1],
        )
        fake = _fake_transcriber()
        keys: list[str | None] = []
        monkeypatch.setattr(
            server, "create_transcriber", lambda key=None: (keys.append(key), fake)[1]
        )
        server._init_transcriber()
        assert server._transcriber is fake
        assert keys == [None]
        assert cache_probes == []


class TestDownloadReadyCallback:
    def test_whisper_download_triggers_reinit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls: list[bool] = []
        monkeypatch.setattr(
            server, "_init_transcriber", lambda wait=False: calls.append(wait)
        )
        server._on_model_download_ready("whisper-model:large-v3-turbo")
        server._on_model_download_ready("whisper-main")
        # wait=True: the completion signal must queue behind an in-flight init,
        # never be dropped by the non-blocking bail-out.
        assert calls == [True, True]

    def test_llm_download_does_not_touch_the_transcriber(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls: list[bool] = []
        monkeypatch.setattr(server, "_init_transcriber", lambda: calls.append(True))
        server._on_model_download_ready("qwen-4b-light")
        assert calls == []

    def test_ready_transcriber_is_left_alone(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(server, "_transcriber", _fake_transcriber())
        calls: list[bool] = []
        monkeypatch.setattr(server, "_init_transcriber", lambda: calls.append(True))
        server._on_model_download_ready("whisper-main")
        assert calls == []


class TestReadyCallbackWaits:
    def test_callback_survives_an_init_in_flight(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A download finishing WHILE an (older, doomed) init holds the lock
        must still initialize afterwards — the signal is queued, not dropped."""
        import threading

        monkeypatch.setenv("WHISPER_BACKEND", "faster-whisper")
        monkeypatch.delenv("WHISPER_MODEL", raising=False)
        monkeypatch.delenv("MLX_WHISPER_MODEL", raising=False)
        monkeypatch.setattr(server, "whisper_model_is_cached", lambda repo: True)
        fake = _fake_transcriber()
        monkeypatch.setattr(server, "create_transcriber", lambda key=None: fake)

        server._INIT_LOCK.acquire()  # simulate an init mid-flight
        worker = threading.Thread(
            target=server._on_model_download_ready, args=("whisper-main",)
        )
        worker.start()
        worker.join(timeout=0.2)
        assert worker.is_alive()  # blocked waiting, not bailed out
        server._INIT_LOCK.release()
        worker.join(timeout=5)
        assert not worker.is_alive()
        assert server._transcriber is fake
        assert server._TRANSCRIBER_STATE == "ready"
