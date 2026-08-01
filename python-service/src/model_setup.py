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
import logging
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

from huggingface_hub import HfApi, constants, snapshot_download

from .transcriber import backend_is_mlx

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelPin:
    profile_id: str
    repo_id: str
    revision: str
    # When set, only these repo files are fetched and verified. GGUF repos
    # publish every quantization side by side (100+ GB total), so the pin
    # names exactly one weight file instead of mirroring the whole repo.
    allow_patterns: tuple[str, ...] | None = None


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
    separate model here would download gigabytes that nothing ever loads.
    Since V3 (2026-07-31) the CT2 main model is large-v3-turbo — CPU int8
    runs large-v3 painfully slowly, and turbo halves the download too.
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
        repo_id="deepdml/faster-whisper-large-v3-turbo-ct2",
        revision="4df90f75321148c3a29a9e2351b7ddf8f5b115a8",
    )
    return {
        "whisper-main": main,
        "whisper-live": ModelPin(
            profile_id="whisper-live",
            repo_id=main.repo_id,
            revision=main.revision,
        ),
    }


#: Pinned revisions for every curated Settings whisper model, per backend —
#: keys match the runtime registry in `transcriber` (`active_whisper_models`).
#: These power the `whisper-model:<key>` profile family so the Settings picker
#: downloads with the same byte progress / resume / checksum pipeline as the
#: LLM tiers, instead of the old fire-and-pray `/whisper_download` endpoint.
#: Verified against live Hugging Face state 2026-07-31.
_WHISPER_KEY_REVISIONS_MLX = {
    "large-v3": ("mlx-community/whisper-large-v3-mlx", "49e6aa286ad60c14352c404340ded53710378a11"),
    "large-v3-turbo": ("mlx-community/whisper-large-v3-turbo", "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"),
    "large-v3-turbo-q4": ("mlx-community/whisper-large-v3-turbo-q4", "660c343bbf4e52ac257f0b7d952e5388e6f93bef"),
}
_WHISPER_KEY_REVISIONS_CT2 = {
    "large-v3": ("Systran/faster-whisper-large-v3", "edaa852ec7e145841d8ffdb056a99866b5f0a478"),
    "large-v3-turbo": ("deepdml/faster-whisper-large-v3-turbo-ct2", "4df90f75321148c3a29a9e2351b7ddf8f5b115a8"),
}

WHISPER_MODEL_PROFILE_PREFIX = "whisper-model:"


def _whisper_model_pins() -> dict[str, ModelPin]:
    """One pin per curated Settings whisper model: `whisper-model:<key>`."""
    revisions = (
        _WHISPER_KEY_REVISIONS_MLX if backend_is_mlx() else _WHISPER_KEY_REVISIONS_CT2
    )
    pins: dict[str, ModelPin] = {}
    for key, (repo_id, revision) in revisions.items():
        profile_id = f"{WHISPER_MODEL_PROFILE_PREFIX}{key}"
        pins[profile_id] = ModelPin(
            profile_id=profile_id, repo_id=repo_id, revision=revision
        )
    return pins


def _qwen_pins() -> dict[str, ModelPin]:
    """The meeting-model tiers, resolved per platform under the SAME ids.

    The profile ids (`qwen-27b-quality` / `qwen-9b-balanced` / `qwen-4b-light`)
    are the cross-platform contract — onboarding persists them and every Rust
    gate keys on them. What they resolve to differs: Apple Silicon runs the
    pinned MLX snapshots under Rapid-MLX; everywhere else the managed engine is
    llama.cpp, so the ids pin one Q4_K_M GGUF each (unsloth's uploads — the
    official Qwen account publishes no Qwen3.5/3.6 GGUF). Single-file pins via
    `allow_patterns`: mirroring a GGUF repo would download every quantization.

    Pinned 2026-07-28 against live Hugging Face state (SETUP_REDESIGN_SPEC §D).
    """
    if backend_is_mlx():
        return {
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
        }
    return {
        "qwen-27b-quality": ModelPin(
            profile_id="qwen-27b-quality",
            repo_id="unsloth/Qwen3.6-27B-GGUF",
            revision="82d411acf4a06cfb8d9b073a5211bf410bfc29bf",
            allow_patterns=("Qwen3.6-27B-Q4_K_M.gguf",),
        ),
        "qwen-9b-balanced": ModelPin(
            profile_id="qwen-9b-balanced",
            repo_id="unsloth/Qwen3.5-9B-GGUF",
            revision="3885219b6810b007914f3a7950a8d1b469d598a5",
            allow_patterns=("Qwen3.5-9B-Q4_K_M.gguf",),
        ),
        "qwen-4b-light": ModelPin(
            profile_id="qwen-4b-light",
            repo_id="unsloth/Qwen3.5-4B-GGUF",
            revision="e87f176479d0855a907a41277aca2f8ee7a09523",
            allow_patterns=("Qwen3.5-4B-Q4_K_M.gguf",),
        ),
    }


MODEL_PINS = {
    **_qwen_pins(),
    **_whisper_pins(),
    **_whisper_model_pins(),
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

#: Called with the profile_id after a download reaches `ready` (verified).
#: The server registers a transcriber re-init here so a finished whisper
#: download brings transcription alive without an app restart.
_READY_CALLBACKS: list[Callable[[str], None]] = []


def on_download_ready(callback: Callable[[str], None]) -> None:
    """Register a callback for verified download completion (idempotent)."""
    if callback not in _READY_CALLBACKS:
        _READY_CALLBACKS.append(callback)


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
        if pin.allow_patterns is not None and name not in pin.allow_patterns:
            continue
        if name and size >= 0:
            files.append(ExpectedFile(name=name, size=size, sha256=sha256))
    # `.bin` covers CTranslate2 whisper repos (`model.bin`) — without it every
    # CT2 whisper pin failed here with "no weight files" before any byte moved.
    if not files or not any(
        file.name.endswith((".safetensors", ".gguf", ".bin"))
        or file.name == "weights.npz"
        for file in files
    ):
        raise RuntimeError("Pinned model manifest has no weight files.")
    return tuple(files)


def _blobs_path(pin: ModelPin) -> Path:
    """The repo's content-addressed blob directory, sibling of `snapshots/`."""
    return _snapshot_path(pin).parents[1] / "blobs"


def _incomplete_bytes(blobs: Path, sha256: str) -> int:
    """Size of the largest in-flight blob for `sha256`, or 0 if none exists.

    huggingface_hub 1.19 streams each download into a process-unique
    `blobs/<sha256>.<uuid8>.incomplete` (`file_download.py:1848`); caches written
    by older versions use the plain `blobs/<sha256>.incomplete`. The glob covers
    both, and an interrupted download can leave several behind — the largest is
    the one furthest along.
    """
    sizes = []
    for path in blobs.glob(f"{sha256}*.incomplete"):
        try:
            sizes.append(path.stat().st_size)
        except OSError:
            continue
    return max(sizes, default=0)


def _file_bytes(snapshot: Path, blobs: Path, file: ExpectedFile) -> int:
    """Bytes on disk for one expected file, counted through exactly one path.

    A file only reaches `snapshots/<revision>/<name>` once it has fully
    downloaded, so stating snapshots alone reports nothing at all while a
    multi-GB shard streams — the progress bar sticks at the few percent the
    small config files contribute. Probe the download's three stages in order
    (linked snapshot, completed blob, in-flight blob) and stop at the first hit.
    Non-LFS files have no manifest sha256 and therefore no predictable blob
    name; they are KBs of config, so counting them on completion is enough.
    """
    candidates = [snapshot / file.name]
    if file.sha256:
        candidates.append(blobs / file.sha256)
    for path in candidates:
        try:
            return min(path.stat().st_size, file.size)
        except OSError:
            continue
    if not file.sha256:
        return 0
    return min(_incomplete_bytes(blobs, file.sha256), file.size)


def _downloaded_bytes(profile_id: str) -> int:
    pin = _pin(profile_id)
    snapshot = _snapshot_path(pin)
    blobs = _blobs_path(pin)
    expected = _EXPECTED.get(profile_id, ())
    return sum(_file_bytes(snapshot, blobs, file) for file in expected)


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
        snapshot_download(
            repo_id=pin.repo_id,
            revision=pin.revision,
            allow_patterns=list(pin.allow_patterns) if pin.allow_patterns else None,
        )
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
        for callback in list(_READY_CALLBACKS):
            try:
                callback(profile_id)
            except Exception:  # a listener must never poison the download state
                logger.exception("Model-ready callback failed for %s", profile_id)
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
