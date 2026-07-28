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
    pin = model_setup.MODEL_PINS["qwen-4b-light"]
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
    expected = "mlx-community/whisper-" if backend_is_mlx() else "Systran/faster-whisper-"
    for profile_id in ("whisper-main", "whisper-live"):
        assert model_setup.MODEL_PINS[profile_id].repo_id.startswith(expected)


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
