"""On-device Whisper model registry — key→repo mapping and the picker list.

The registry is backend-selected, so every test pins `WHISPER_BACKEND` rather
than relying on the host OS: otherwise these assertions would encode "whatever
platform CI happened to run on", which is exactly the bug that let the Windows
build advertise MLX weights faster-whisper cannot load.
"""

import pytest

from src.transcriber import (
    DEFAULT_WHISPER_MODEL,
    active_whisper_models,
    list_whisper_models,
    whisper_repo_for,
)


@pytest.fixture(params=["mlx", "faster-whisper"])
def backend(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    """Run each test against both transcription backends."""
    monkeypatch.setenv("WHISPER_BACKEND", request.param)
    return str(request.param)


def test_whisper_repo_mapping_and_fallback(backend: str) -> None:
    models = active_whisper_models()
    for key, entry in models.items():
        assert whisper_repo_for(key) == entry["repo"]
    # Unknown / None fall back to the default model's repo.
    default_repo = models[DEFAULT_WHISPER_MODEL]["repo"]
    assert whisper_repo_for(None) == default_repo
    assert whisper_repo_for("nonexistent") == default_repo


def test_default_model_is_always_offered(backend: str) -> None:
    assert DEFAULT_WHISPER_MODEL in active_whisper_models()


def test_registry_weights_match_the_backend(backend: str) -> None:
    """MLX and CTranslate2 weights are not interchangeable in either direction."""
    repos = [entry["repo"] for entry in active_whisper_models().values()]
    if backend == "mlx":
        assert all(repo.startswith("mlx-community/") for repo in repos)
    else:
        assert not any(repo.startswith("mlx-community/") for repo in repos)


def test_macos_only_key_resolves_to_nearest_ct2_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A `whisper_model` written on a Mac must still resolve on Windows.

    There is no CTranslate2 build of the MLX 4-bit turbo model, so the key is
    aliased onto the turbo tier. Without the alias it would fall through to the
    default and quietly hand a user who asked for "smallest & fastest" the 3 GB
    model instead.
    """
    monkeypatch.setenv("WHISPER_BACKEND", "faster-whisper")
    assert (
        whisper_repo_for("large-v3-turbo-q4")
        == active_whisper_models()["large-v3-turbo"]["repo"]
    )


def test_list_whisper_models_schema(backend: str) -> None:
    models = list_whisper_models()
    assert len(models) >= 2
    for entry in models:
        assert set(entry.keys()) == {"key", "label", "size", "downloaded"}
        assert isinstance(entry["downloaded"], bool)
        assert entry["key"] in active_whisper_models()
