from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from src import model_setup
from src.transcriber import backend_is_mlx


def test_unknown_profile_is_rejected() -> None:
    with pytest.raises(ValueError, match="Unknown"):
        model_setup.model_download_status("user-controlled-repository")


def test_manifest_is_exact_revision_and_keeps_lfs_hashes() -> None:
    # A pin of its own, NOT MODEL_PINS["qwen-4b-light"]: that id resolves per
    # backend, and on non-MLX platforms it carries a GGUF allow_patterns filter
    # that would drop this test's fake .safetensors sibling (caught by the
    # Windows CI leg — this test is about manifest hashing, not pin routing).
    pin = model_setup.ModelPin(
        profile_id="qwen-4b-light",
        repo_id="mlx-community/Qwen3.5-4B-MLX-4bit",
        revision="32f3e8ecf65426fc3306969496342d504bfa13f3",
    )
    info = SimpleNamespace(
        sha=pin.revision,
        siblings=[
            SimpleNamespace(rfilename="config.json", size=2, lfs=None),
            SimpleNamespace(
                rfilename="model.safetensors",
                size=3,
                lfs=SimpleNamespace(sha256="a" * 64),
            ),
        ],
    )
    with patch.object(model_setup.HfApi, "model_info", return_value=info):
        files = model_setup._load_manifest(pin)
    assert files[1].sha256 == "a" * 64


def test_verification_detects_modified_weight(tmp_path: Path) -> None:
    pin = model_setup.MODEL_PINS["qwen-4b-light"]
    root = tmp_path / "snapshot"
    root.mkdir()
    weight = root / "model.safetensors"
    weight.write_bytes(b"abc")
    expected = (
        model_setup.ExpectedFile(
            "model.safetensors", 3, hashlib.sha256(b"different").hexdigest()
        ),
    )
    with patch.object(model_setup, "_snapshot_path", return_value=root):
        with pytest.raises(RuntimeError, match="checksum"):
            model_setup._verify_snapshot(pin, expected)


def test_whisper_models_are_pinned_for_predownload() -> None:
    for profile_id in ("whisper-main", "whisper-live"):
        pin = model_setup.MODEL_PINS[profile_id]
        assert len(pin.revision) == 40
        assert all(char in "0123456789abcdef" for char in pin.revision)


def test_whisper_pins_match_the_active_transcription_backend() -> None:
    """Pre-downloaded weights must be loadable by the backend that will run.

    Asserting `mlx-community/*` unconditionally is what let the Windows build
    spend its setup step pulling ~3.5 GB of weights faster-whisper cannot open.
    `MODEL_PINS` is built at import, so probe the backend the same way rather
    than monkeypatching the env after the fact.
    """
    for profile_id in ("whisper-main", "whisper-live"):
        repo_id = model_setup.MODEL_PINS[profile_id].repo_id
        if backend_is_mlx():
            assert repo_id.startswith("mlx-community/whisper-")
        else:
            # CT2 conversions live under several accounts (Systran, deepdml —
            # the V3 turbo default) but always carry the faster-whisper name.
            assert "faster-whisper" in repo_id
            assert not repo_id.startswith("mlx-community/")


def test_ct2_live_pin_reuses_the_main_model() -> None:
    """faster-whisper has no dedicated live model, so it must not pin a second one.

    `_build_live_transcriber` only builds a fast live model for MLX; elsewhere it
    reuses the main transcriber. A distinct live pin would download ~1.6 GB that
    nothing ever loads.
    """
    if backend_is_mlx():
        pytest.skip("MLX does have a dedicated live model")
    assert (
        model_setup.MODEL_PINS["whisper-live"].repo_id
        == model_setup.MODEL_PINS["whisper-main"].repo_id
    )


def _fake_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    profile_id: str,
    files: tuple[model_setup.ExpectedFile, ...],
) -> tuple[Path, Path]:
    """Point HF_HUB_CACHE at an empty repo cache and register the manifest.

    Returns the `snapshots/<revision>` and `blobs` directories so a test can
    plant whichever download stage it exercises.
    """
    pin = model_setup.MODEL_PINS[profile_id]
    repo = tmp_path / f"models--{pin.repo_id.replace('/', '--')}"
    snapshot = repo / "snapshots" / pin.revision
    blobs = repo / "blobs"
    snapshot.mkdir(parents=True)
    blobs.mkdir(parents=True)
    monkeypatch.setattr(model_setup.constants, "HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setitem(model_setup._EXPECTED, profile_id, files)
    return snapshot, blobs


def test_progress_counts_completed_snapshot_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    files = (
        model_setup.ExpectedFile("config.json", 4, None),
        model_setup.ExpectedFile("model.safetensors", 10, "b" * 64),
    )
    snapshot, _ = _fake_cache(tmp_path, monkeypatch, "qwen-4b-light", files)
    (snapshot / "config.json").write_bytes(b"conf")
    (snapshot / "model.safetensors").write_bytes(b"x" * 10)
    assert model_setup._downloaded_bytes("qwen-4b-light") == 14


def test_progress_counts_a_completed_blob_not_yet_linked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A finished blob is only symlinked/copied into snapshots afterwards."""
    files = (model_setup.ExpectedFile("model.safetensors", 10, "b" * 64),)
    _, blobs = _fake_cache(tmp_path, monkeypatch, "qwen-4b-light", files)
    (blobs / ("b" * 64)).write_bytes(b"x" * 10)
    assert model_setup._downloaded_bytes("qwen-4b-light") == 10


@pytest.mark.parametrize("suffix", [".incomplete", ".ab12cd34.incomplete"])
def test_progress_counts_an_in_flight_incomplete_blob(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suffix: str
) -> None:
    """This is where live progress comes from — and it must not stay at zero.

    hf_hub 1.19 writes `blobs/<sha256>.<uuid8>.incomplete`; caches written by
    older versions use `blobs/<sha256>.incomplete`. Both are real on disk.
    """
    files = (model_setup.ExpectedFile("model.safetensors", 100, "b" * 64),)
    _, blobs = _fake_cache(tmp_path, monkeypatch, "qwen-4b-light", files)
    (blobs / ("b" * 64 + suffix)).write_bytes(b"x" * 37)
    assert model_setup._downloaded_bytes("qwen-4b-light") == 37


def test_progress_caps_an_oversized_incomplete_blob(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    files = (model_setup.ExpectedFile("model.safetensors", 10, "b" * 64),)
    _, blobs = _fake_cache(tmp_path, monkeypatch, "qwen-4b-light", files)
    (blobs / ("b" * 64 + ".ab12cd34.incomplete")).write_bytes(b"x" * 99)
    assert model_setup._downloaded_bytes("qwen-4b-light") == 10


def test_progress_mixes_stages_without_double_counting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One file may exist as snapshot, blob and leftover incomplete at once."""
    files = (
        model_setup.ExpectedFile("config.json", 4, None),
        model_setup.ExpectedFile("weights-1.safetensors", 10, "b" * 64),
        model_setup.ExpectedFile("weights-2.safetensors", 100, "c" * 64),
    )
    snapshot, blobs = _fake_cache(tmp_path, monkeypatch, "qwen-4b-light", files)
    (snapshot / "config.json").write_bytes(b"conf")
    (snapshot / "weights-1.safetensors").write_bytes(b"x" * 10)
    (blobs / ("b" * 64)).write_bytes(b"x" * 10)
    (blobs / ("b" * 64 + ".ab12cd34.incomplete")).write_bytes(b"x" * 10)
    (blobs / ("c" * 64 + ".ef56ab78.incomplete")).write_bytes(b"x" * 25)
    assert model_setup._downloaded_bytes("qwen-4b-light") == 4 + 10 + 25


def test_progress_ignores_blobs_of_non_lfs_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without a manifest sha256 the blob name is a git hash we cannot derive."""
    files = (model_setup.ExpectedFile("config.json", 4, None),)
    _, blobs = _fake_cache(tmp_path, monkeypatch, "qwen-4b-light", files)
    (blobs / ("d" * 40)).write_bytes(b"conf")
    assert model_setup._downloaded_bytes("qwen-4b-light") == 0


def test_status_contains_only_aggregate_safe_fields() -> None:
    status = model_setup.model_download_status("qwen-4b-light")
    assert set(status) == {
        "profile_id",
        "state",
        "downloaded_bytes",
        "total_bytes",
        "detail",
        "error_code",
        "verified",
        "can_retry",
    }
    assert "/" not in status["detail"]


def test_qwen_pins_match_the_active_backend() -> None:
    """The qwen profile ids are a cross-platform contract; the repos differ.

    Apple Silicon resolves them to pinned MLX snapshots; everywhere else the
    managed engine is llama.cpp, so they must resolve to single-file GGUF pins
    — MLX weights are as useless to llama.cpp as CT2 weights were to MLX.
    """
    for profile_id in ("qwen-27b-quality", "qwen-9b-balanced", "qwen-4b-light"):
        pin = model_setup.MODEL_PINS[profile_id]
        assert len(pin.revision) == 40
        if backend_is_mlx():
            assert pin.repo_id.startswith("mlx-community/")
            assert pin.allow_patterns is None
        else:
            assert pin.repo_id.startswith("unsloth/")
            assert pin.allow_patterns is not None
            assert all(name.endswith(".gguf") for name in pin.allow_patterns)


def test_gguf_pins_are_single_file() -> None:
    """A GGUF repo publishes every quantization side by side (100+ GB); the
    pin must never mirror the whole repo."""
    with patch.object(model_setup, "backend_is_mlx", return_value=False):
        pins = model_setup._qwen_pins()
    for pin in pins.values():
        assert pin.allow_patterns is not None
        assert len(pin.allow_patterns) == 1


def test_manifest_honors_allow_patterns_and_accepts_gguf() -> None:
    pin = model_setup.ModelPin(
        profile_id="qwen-4b-light",
        repo_id="unsloth/Qwen3.5-4B-GGUF",
        revision="e" * 40,
        allow_patterns=("Qwen3.5-4B-Q4_K_M.gguf",),
    )
    info = SimpleNamespace(
        sha=pin.revision,
        siblings=[
            SimpleNamespace(rfilename="README.md", size=9, lfs=None),
            SimpleNamespace(
                rfilename="Qwen3.5-4B-Q4_K_M.gguf",
                size=5,
                lfs=SimpleNamespace(sha256="b" * 64),
            ),
            SimpleNamespace(
                rfilename="Qwen3.5-4B-Q8_0.gguf",
                size=9,
                lfs=SimpleNamespace(sha256="c" * 64),
            ),
        ],
    )
    with patch.object(model_setup.HfApi, "model_info", return_value=info):
        files = model_setup._load_manifest(pin)
    assert [file.name for file in files] == ["Qwen3.5-4B-Q4_K_M.gguf"]


def test_filtered_download_passes_allow_patterns() -> None:
    pin = model_setup.ModelPin(
        profile_id="qwen-4b-light",
        repo_id="unsloth/Qwen3.5-4B-GGUF",
        revision="e" * 40,
        allow_patterns=("Qwen3.5-4B-Q4_K_M.gguf",),
    )
    manifest = (model_setup.ExpectedFile("Qwen3.5-4B-Q4_K_M.gguf", 3, "b" * 64),)
    with (
        patch.object(model_setup, "_pin", return_value=pin),
        patch.object(model_setup, "_load_manifest", return_value=manifest),
        patch.object(model_setup, "snapshot_download") as download,
        patch.object(model_setup, "_verify_snapshot"),
    ):
        model_setup._run_download("qwen-4b-light")
    assert download.call_args.kwargs["allow_patterns"] == ["Qwen3.5-4B-Q4_K_M.gguf"]


def test_manifest_accepts_ct2_model_bin() -> None:
    """CT2 whisper repos ship `model.bin`, not safetensors/GGUF.

    The weight-file guard rejected them ("no weight files"), so every CT2
    whisper pin failed at manifest load before a single byte moved — one of
    the silent legs of the 2026-07-31 fresh-Windows failure.
    """
    pin = model_setup.ModelPin(
        profile_id="whisper-main",
        repo_id="deepdml/faster-whisper-large-v3-turbo-ct2",
        revision="4df90f75321148c3a29a9e2351b7ddf8f5b115a8",
    )
    info = SimpleNamespace(
        sha=pin.revision,
        siblings=[
            SimpleNamespace(rfilename="config.json", size=2, lfs=None),
            SimpleNamespace(
                rfilename="model.bin",
                size=5,
                lfs=SimpleNamespace(sha256="b" * 64),
            ),
        ],
    )
    with patch.object(model_setup.HfApi, "model_info", return_value=info):
        files = model_setup._load_manifest(pin)
    assert [file.name for file in files] == ["config.json", "model.bin"]


def test_whisper_model_profile_pins_per_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every curated Settings model gets a `whisper-model:<key>` pin, so the
    picker downloads through the byte-progress pipeline, not fire-and-pray."""
    monkeypatch.setenv("WHISPER_BACKEND", "faster-whisper")
    ct2 = model_setup._whisper_model_pins()
    assert set(ct2) == {"whisper-model:large-v3", "whisper-model:large-v3-turbo"}
    assert ct2["whisper-model:large-v3"].repo_id == "Systran/faster-whisper-large-v3"
    assert (
        ct2["whisper-model:large-v3-turbo"].repo_id
        == "deepdml/faster-whisper-large-v3-turbo-ct2"
    )

    monkeypatch.setenv("WHISPER_BACKEND", "mlx")
    mlx = model_setup._whisper_model_pins()
    assert set(mlx) == {
        "whisper-model:large-v3",
        "whisper-model:large-v3-turbo",
        "whisper-model:large-v3-turbo-q4",
    }
    assert all(pin.repo_id.startswith("mlx-community/") for pin in mlx.values())
    for pins in (ct2, mlx):
        for pin in pins.values():
            assert len(pin.revision) == 40


def test_ready_callback_fires_after_verified_download() -> None:
    """A verified download must announce itself — the server's transcriber
    re-init hangs off this, which is what makes 'download from Settings, then
    it just works' true without an app restart."""
    calls: list[str] = []
    model_setup.on_download_ready(calls.append)
    model_setup.on_download_ready(calls.append)  # idempotent: registered once
    try:
        files = (model_setup.ExpectedFile(name="model.bin", size=1, sha256=None),)
        with (
            patch.object(model_setup, "_load_manifest", return_value=files),
            patch.object(model_setup, "snapshot_download"),
            patch.object(model_setup, "_verify_snapshot"),
        ):
            model_setup._run_download("whisper-main")
        assert calls == ["whisper-main"]
        assert model_setup.model_download_status("whisper-main")["state"] == "ready"
    finally:
        model_setup._READY_CALLBACKS.remove(calls.append)
