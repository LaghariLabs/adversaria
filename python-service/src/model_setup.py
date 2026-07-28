"""Pinned meeting-model downloads for the desktop onboarding flow.

Only profile IDs owned by the app are accepted.  Downloads use the Hugging Face
content-addressed cache, resume partial blobs automatically, and finish with an
explicit SHA-256 pass over every LFS-backed file before the model is marked ready.
The API exposes aggregate byte counts only; cache paths and repository errors are
never returned to the webview.
"""

from __future__ import annotations

import errno
import hashlib
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi, constants, snapshot_download

from .transcriber import backend_is_mlx


@dataclass(frozen=True)
class ModelPin:
    profile_id: str
    repo_id: str
    revision: str


def _whisper_pins() -> dict[str, ModelPin]:
    """The Whisper weights first-run setup pre-downloads, for THIS backend.

    These were unconditionally `mlx-community/*`, so a Windows install spent the
    setup step pulling ~3.5 GB of MLX weights that faster-whisper cannot load —
    slow, and then useless. CTranslate2 and MLX weights are not interchangeable
    in either direction, so the pins must follow the active backend exactly as
    the runtime registry in `transcriber` does.

    On CTranslate2, `whisper-live` deliberately points at the SAME repo as
    `whisper-main`: `server._build_live_transcriber` only builds a dedicated fast
    model for MLX and otherwise reuses the main transcriber, so pinning a
    separate turbo model here would download 1.6 GB that nothing ever loads.
    Give Windows its own live model and this should point at the turbo repo.
    """
    if backend_is_mlx():
        return {
            "whisper-main": ModelPin(
                profile_id="whisper-main",
                repo_id="mlx-community/whisper-large-v3-mlx",
                revision="49e6aa286ad60c14352c404340ded53710378a11",
            ),
            "whisper-live": ModelPin(
                profile_id="whisper-live",
                repo_id="mlx-community/whisper-large-v3-turbo-q4",
                revision="660c343bbf4e52ac257f0b7d952e5388e6f93bef",
            ),
        }
    main = ModelPin(
        profile_id="whisper-main",
        repo_id="Systran/faster-whisper-large-v3",
        revision="edaa852ec7e145841d8ffdb056a99866b5f0a478",
    )
    return {
        "whisper-main": main,
        "whisper-live": ModelPin(
            profile_id="whisper-live",
            repo_id=main.repo_id,
            revision=main.revision,
        ),
    }


MODEL_PINS = {
    "qwen-27b-quality": ModelPin(
        profile_id="qwen-27b-quality",
        repo_id="mlx-community/Qwen3.6-27B-4bit",
        revision="c000ac2c2057d94be3fa931000c31723aac53282",
    ),
    "qwen-9b-balanced": ModelPin(
        profile_id="qwen-9b-balanced",
        repo_id="mlx-community/Qwen3.5-9B-MLX-4bit",
        revision="938d8919941c6e7efd3c7150eff7fe9d12afa631",
    ),
    "qwen-4b-light": ModelPin(
        profile_id="qwen-4b-light",
        repo_id="mlx-community/Qwen3.5-4B-MLX-4bit",
        revision="32f3e8ecf65426fc3306969496342d504bfa13f3",
    ),
    **_whisper_pins(),
}


@dataclass
class DownloadState:
    profile_id: str
    state: str = "idle"
    downloaded_bytes: int = 0
    total_bytes: int = 0
    detail: str = "Model download has not started."
    error_code: str | None = None
    verified: bool = False
    can_retry: bool = True


@dataclass(frozen=True)
class ExpectedFile:
    name: str
    size: int
    sha256: str | None


_LOCK = threading.Lock()
_STATES = {profile_id: DownloadState(profile_id) for profile_id in MODEL_PINS}
_EXPECTED: dict[str, tuple[ExpectedFile, ...]] = {}


def _pin(profile_id: str) -> ModelPin:
    try:
        return MODEL_PINS[profile_id]
    except KeyError as exc:
        raise ValueError("Unknown local model profile.") from exc


def _snapshot_path(pin: ModelPin) -> Path:
    repo_dir = f"models--{pin.repo_id.replace('/', '--')}"
    return Path(constants.HF_HUB_CACHE) / repo_dir / "snapshots" / pin.revision


def _value(obj: object, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _load_manifest(pin: ModelPin) -> tuple[ExpectedFile, ...]:
    info = HfApi().model_info(pin.repo_id, revision=pin.revision, files_metadata=True)
    if info.sha != pin.revision:
        raise RuntimeError("Pinned model revision did not resolve exactly.")
    files: list[ExpectedFile] = []
    for sibling in info.siblings or []:
        name = str(_value(sibling, "rfilename", ""))
        size = int(_value(sibling, "size", 0) or 0)
        lfs = _value(sibling, "lfs")
        sha256 = str(_value(lfs, "sha256", "") or "").lower() or None
        if name and size >= 0:
            files.append(ExpectedFile(name=name, size=size, sha256=sha256))
    if not files or not any(
        file.name.endswith(".safetensors") or file.name == "weights.npz"
        for file in files
    ):
        raise RuntimeError("Pinned model manifest has no weight files.")
    return tuple(files)


def _downloaded_bytes(profile_id: str) -> int:
    pin = _pin(profile_id)
    root = _snapshot_path(pin)
    expected = _EXPECTED.get(profile_id, ())
    total = 0
    for file in expected:
        path = root / file.name
        try:
            total += min(path.stat().st_size, file.size)
        except OSError:
            continue
    return total


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(8 * 1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _verify_snapshot(pin: ModelPin, files: tuple[ExpectedFile, ...]) -> None:
    root = _snapshot_path(pin)
    for expected in files:
        path = root / expected.name
        if not path.is_file() or path.stat().st_size != expected.size:
            raise RuntimeError("Downloaded model is incomplete.")
        if expected.sha256 and _sha256(path) != expected.sha256:
            raise RuntimeError("Downloaded model checksum verification failed.")


def _safe_failure(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
        return (
            "disk-full",
            "The model download ran out of disk space. Free space and retry.",
        )
    lowered = str(exc).lower()
    if "checksum" in lowered or "revision did not resolve" in lowered:
        return "checksum-failed", "The model could not be verified. Retry the download."
    if "401" in lowered or "403" in lowered or "gated" in lowered:
        return "access-denied", "The pinned model repository could not be accessed."
    return (
        "network",
        "The model download was interrupted. Check the connection and retry.",
    )


def _set_state(profile_id: str, **updates: object) -> None:
    with _LOCK:
        state = _STATES[profile_id]
        for key, value in updates.items():
            setattr(state, key, value)


def _run_download(profile_id: str) -> None:
    pin = _pin(profile_id)
    try:
        _set_state(
            profile_id,
            state="preparing",
            detail="Reading the pinned model manifest…",
            error_code=None,
            verified=False,
            can_retry=False,
        )
        files = _load_manifest(pin)
        _EXPECTED[profile_id] = files
        total = sum(file.size for file in files)
        _set_state(
            profile_id,
            state="downloading",
            total_bytes=total,
            detail="Downloading the local meeting model…",
        )
        snapshot_download(repo_id=pin.repo_id, revision=pin.revision)
        _set_state(
            profile_id,
            state="verifying",
            downloaded_bytes=total,
            detail="Verifying model checksums…",
        )
        _verify_snapshot(pin, files)
        _set_state(
            profile_id,
            state="ready",
            downloaded_bytes=total,
            total_bytes=total,
            detail="Local meeting model is downloaded and verified.",
            error_code=None,
            verified=True,
            can_retry=False,
        )
    except Exception as exc:  # worker boundary: expose only a redacted code/message
        code, detail = _safe_failure(exc)
        _set_state(
            profile_id,
            state="error",
            downloaded_bytes=_downloaded_bytes(profile_id),
            detail=detail,
            error_code=code,
            verified=False,
            can_retry=True,
        )


def start_model_download(profile_id: str) -> dict[str, object]:
    _pin(profile_id)
    with _LOCK:
        state = _STATES[profile_id]
        if state.state in {"preparing", "downloading", "verifying", "ready"}:
            return asdict(state)
        state.state = "preparing"
        state.detail = "Preparing the local meeting model…"
        state.error_code = None
        state.can_retry = False
    threading.Thread(
        target=_run_download,
        args=(profile_id,),
        name=f"model-download-{profile_id}",
        daemon=True,
    ).start()
    return model_download_status(profile_id)


def model_download_status(profile_id: str) -> dict[str, object]:
    _pin(profile_id)
    with _LOCK:
        state = DownloadState(**asdict(_STATES[profile_id]))
    if state.state == "downloading":
        state.downloaded_bytes = _downloaded_bytes(profile_id)
        with _LOCK:
            _STATES[profile_id].downloaded_bytes = state.downloaded_bytes
    return asdict(state)
