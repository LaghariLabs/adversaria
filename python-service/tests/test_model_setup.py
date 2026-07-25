from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from src import model_setup


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
        assert pin.repo_id.startswith("mlx-community/whisper-")
        assert len(pin.revision) == 40
        assert all(char in "0123456789abcdef" for char in pin.revision)


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
