"""Tests for the sidecar death certificate (run_service.py).

The packaged service dies where nobody can see it: frozen, windowed, spawned by
Rust. `service-crash.txt` is the only channel that turns "Local AI Offline" into
an actual traceback, so what it contains — and where it lands — is pinned here.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

import run_service
from src import config


def _boom() -> BaseException:
    """A real exception with a real traceback, shaped like the deaths that
    prompted this file: a native library that fails to load at import."""
    try:
        raise RuntimeError("libcudnn_ops.so: cannot open shared object file")
    except RuntimeError as exc:
        return exc


class TestCrashFile:
    """`_write_crash` records the traceback where the desktop app reads it."""

    def test_writes_the_traceback_to_the_data_dir(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The file lands at ADVERSARIA_DATA_DIR/service-crash.txt — the exact
        path `commands.rs::read_sidecar_crash_tail` opens."""
        monkeypatch.setenv("ADVERSARIA_DATA_DIR", str(tmp_path / "appdata"))
        exc = _boom()

        run_service._write_crash(type(exc), exc, exc.__traceback__)

        content = (tmp_path / "appdata" / "service-crash.txt").read_text(encoding="utf-8")
        assert "Traceback (most recent call last)" in content
        assert "RuntimeError: libcudnn_ops.so: cannot open shared object file" in content

    def test_holds_crash_evidence_only(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No "starting" line. The lifespan used to open this file in mode "w"
        to announce a launch, which truncated the crash it was named for."""
        monkeypatch.setenv("ADVERSARIA_DATA_DIR", str(tmp_path))
        exc = _boom()

        run_service._write_crash(type(exc), exc, exc.__traceback__)

        content = (tmp_path / "service-crash.txt").read_text(encoding="utf-8")
        assert "starting" not in content
        # The timestamp is what tells a fresh traceback from a stale one when
        # the app shows this tail weeks later.
        assert content.startswith("crash at ")

    def test_latest_crash_replaces_the_previous_one(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Mode "w" per crash: the death being diagnosed is the last one."""
        monkeypatch.setenv("ADVERSARIA_DATA_DIR", str(tmp_path))
        (tmp_path / "service-crash.txt").write_text("an older death\n", encoding="utf-8")
        exc = _boom()

        run_service._write_crash(type(exc), exc, exc.__traceback__)

        content = (tmp_path / "service-crash.txt").read_text(encoding="utf-8")
        assert "an older death" not in content

    def test_an_unwritable_dir_never_raises(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A reporter that raises inside the excepthook would replace the real
        traceback with its own."""
        blocked = tmp_path / "file"
        blocked.write_text("not a directory", encoding="utf-8")
        monkeypatch.setenv("ADVERSARIA_DATA_DIR", str(blocked / "appdata"))
        exc = _boom()

        run_service._write_crash(type(exc), exc, exc.__traceback__)


class TestCrashDirResolution:
    """The fallback must agree with src/config.py — drift between the two is
    exactly the bug that put the Windows sidecar's files in a macOS path."""

    @staticmethod
    def _as_platform(
        monkeypatch: pytest.MonkeyPatch, platform: str, base: Path | None
    ) -> None:
        """Pretend to be `platform`, with its base-dir env var set or absent."""
        monkeypatch.delenv("ADVERSARIA_DATA_DIR", raising=False)
        monkeypatch.setattr(sys, "platform", platform)
        var = {"win32": "APPDATA", "linux": "XDG_DATA_HOME"}.get(platform)
        if var is None:
            return
        if base is None:
            monkeypatch.delenv(var, raising=False)
        else:
            monkeypatch.setenv(var, str(base))

    @pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
    def test_matches_config_when_the_base_env_var_is_set(
        self, platform: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._as_platform(monkeypatch, platform, tmp_path / "base")

        assert Path(run_service._crash_dir()) == config._packaged_data_dir()

    @pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
    def test_matches_config_when_it_falls_back_to_home(
        self, platform: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No APPDATA/XDG_DATA_HOME — both halves must land on the same
        home-relative path."""
        self._as_platform(monkeypatch, platform, None)

        assert Path(run_service._crash_dir()) == config._packaged_data_dir()

    def test_the_override_wins(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Rust passes ADVERSARIA_DATA_DIR on spawn; nothing else may win."""
        monkeypatch.setenv("ADVERSARIA_DATA_DIR", str(tmp_path / "custom"))
        monkeypatch.setattr(sys, "platform", "win32")

        assert Path(run_service._crash_dir()) == tmp_path / "custom"


class TestExceptHookInstall:
    """The hook is installed at the frozen entry point, before heavy imports."""

    def test_a_thread_death_is_recorded_and_still_propagates(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Threads die independently of the main thread — transcriber-init is
        one — so the mirror on threading.excepthook has to write too, without
        swallowing the hook it replaced."""
        monkeypatch.setenv("ADVERSARIA_DATA_DIR", str(tmp_path))
        seen: list[object] = []
        monkeypatch.setattr(sys, "excepthook", sys.__excepthook__)
        monkeypatch.setattr(threading, "excepthook", lambda args: seen.append(args))

        run_service._install_crash_handler()
        exc = _boom()
        threading.excepthook(
            SimpleNamespace(
                exc_type=type(exc), exc_value=exc, exc_traceback=exc.__traceback__
            )
        )

        assert seen, "the previously installed threading hook must still run"
        content = (tmp_path / "service-crash.txt").read_text(encoding="utf-8")
        assert "RuntimeError: libcudnn_ops.so" in content
        assert sys.excepthook is not sys.__excepthook__
