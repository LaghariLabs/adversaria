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
    default_whisper_key,
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
    # Unknown / None fall back to the backend default's repo.
    default_repo = models[default_whisper_key()]["repo"]
    assert whisper_repo_for(None) == default_repo
    assert whisper_repo_for("nonexistent") == default_repo


def test_default_model_is_always_offered(backend: str) -> None:
    assert default_whisper_key() in active_whisper_models()


def test_backend_default_key(backend: str) -> None:
    """MLX keeps large-v3 (the GPU absorbs it); CT2 defaults to turbo —
    large-v3 on CPU int8 is a 3 GB download and painfully slow (V3, 2026-07-31)."""
    if backend == "mlx":
        assert default_whisper_key() == DEFAULT_WHISPER_MODEL
    else:
        assert default_whisper_key() == "large-v3-turbo"


def test_registry_weights_match_the_backend(backend: str) -> None:
    """Backend-specific weights stay compatible; sherpa models are neutral."""
    repos = [
        entry["repo"]
        for entry in active_whisper_models().values()
        if entry.get("engine", "whisper") != "cohere"
    ]
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
        assert set(entry.keys()) == {"key", "label", "size", "engine", "downloaded"}
        assert isinstance(entry["downloaded"], bool)
        assert entry["key"] in active_whisper_models()


def test_partial_snapshot_is_not_cached(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """hf_hub links config.json into snapshots/ seconds into a multi-GB
    download — a snapshot without WEIGHTS must read as absent, or the state
    machine reports fake-ready (MLX) / a spurious load error (CT2) mid-fetch."""
    from src import transcriber as tmod

    repo = "deepdml/faster-whisper-large-v3-turbo-ct2"
    snap = tmp_path / f"models--{repo.replace('/', '--')}" / "snapshots" / "abc123"
    snap.mkdir(parents=True)
    monkeypatch.setattr(tmod, "_hf_cache_root", lambda: tmp_path)

    assert not tmod.whisper_model_is_cached(repo)  # empty revision dir
    (snap / "config.json").write_bytes(b"{}")
    assert not tmod.whisper_model_is_cached(repo)  # config linked, weights not

    (snap / "model.bin").write_bytes(b"w")
    assert tmod.whisper_model_is_cached(repo)  # CT2 weights present


@pytest.mark.parametrize("weight", ["weights.npz", "weights.safetensors", "m.gguf"])
def test_each_backend_weight_shape_counts_as_cached(
    tmp_path, monkeypatch: pytest.MonkeyPatch, weight: str
) -> None:
    from src import transcriber as tmod

    repo = "mlx-community/whisper-large-v3-mlx"
    snap = tmp_path / f"models--{repo.replace('/', '--')}" / "snapshots" / "rev"
    snap.mkdir(parents=True)
    (snap / weight).write_bytes(b"w")
    monkeypatch.setattr(tmod, "_hf_cache_root", lambda: tmp_path)
    assert tmod.whisper_model_is_cached(repo)
