"""PyInstaller entry point for the packaged Adversaria ML service sidecar.

Kept separate from `src/server.py` so the package's relative imports
(`from .models import ...`) resolve correctly when frozen. Dev still runs the
service via `uvicorn src.server:app`.
"""

import multiprocessing
import os
import sys
import threading
import traceback
from datetime import datetime, timezone


def _crash_dir() -> str:
    """The per-user app-data dir `service-crash.txt` is written into.

    The other half of this contract is `src/config.py::_packaged_data_dir` —
    same override, same platform defaults — and `src-tauri/src/config.rs`
    ::app_data_dir, which is what reads the file back
    (`commands.rs::read_sidecar_crash_tail`). Duplicated inline rather than
    imported from `src` on purpose: the failure this hook exists for is an
    import of `src` that died, so it must resolve its own path with nothing
    but the stdlib. Rust passes `ADVERSARIA_DATA_DIR` when it spawns us, so
    the defaults below only matter for a hand-launched frozen binary.
    """
    override = os.environ.get("ADVERSARIA_DATA_DIR")
    if override:
        return override
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        # directories::BaseDirs::data_dir() is %APPDATA% (Roaming) on Windows.
        base = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
    elif sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    return os.path.join(base, "meeting-note-taker")


def _write_crash(typ, value, tb) -> None:
    """Record one death in `service-crash.txt` — the sidecar's death certificate.

    The file holds crash evidence and nothing else: the desktop app shows its
    tail instead of a bare "Local AI Offline" when the service dies repeatedly.
    Mode "w" is deliberate — the latest crash is the one being diagnosed — and
    the timestamp line is what tells a fresh traceback from a stale one.
    """
    try:
        crash_dir = _crash_dir()
        os.makedirs(crash_dir, exist_ok=True)
        with open(os.path.join(crash_dir, "service-crash.txt"), "w", encoding="utf-8") as f:
            f.write(f"crash at {datetime.now(timezone.utc).isoformat()}\n")
            f.write(f"pid {os.getpid()}, exe {sys.executable}, argv {sys.argv}\n")
            traceback.print_exception(typ, value, tb, file=f)
    except Exception:
        # A crash reporter that raises would replace the real traceback with
        # its own, which is strictly worse than reporting nothing.
        pass


def _install_crash_handler() -> None:
    """Route uncaught exceptions to `service-crash.txt` before they kill us.

    Installed here, at the frozen entry point, BEFORE any heavy import — the
    deaths worth reporting are import-time ones (a native DLL that won't load,
    a missing cert bundle), which happen before uvicorn binds a port and so
    leave Rust with nothing but a spawn that never answers. Installing it in
    the FastAPI lifespan, as this originally was, covers only the window after
    every risky import has already succeeded.

    Dev (`uv run uvicorn src.server:app`) never runs this file and so never
    gets the hook — correct: dev has a console showing the traceback already.
    """

    def _excepthook(typ, value, tb) -> None:
        _write_crash(typ, value, tb)
        sys.__excepthook__(typ, value, tb)

    sys.excepthook = _excepthook

    # Threads die independently of the main thread — a transcriber-init or
    # parent-guard thread that raises leaves no trace in sys.excepthook.
    original_thread_hook = threading.excepthook

    def _thread_excepthook(args) -> None:
        _write_crash(args.exc_type, args.exc_value, args.exc_traceback)
        original_thread_hook(args)

    threading.excepthook = _thread_excepthook


def _ensure_stdio() -> None:
    """Give the process real stdout/stderr handles before anything logs.

    The Windows sidecar is frozen with `console=False` so no terminal flashes on
    launch (see adversaria-service-windows.spec). A windowed PyInstaller app has
    `sys.stdout is None`, and uvicorn's default logging config resolves its
    handler stream to `ext://sys.stdout` — `StreamHandler(None)` then raises
    `AttributeError: 'NoneType' object has no attribute 'write'` and the service
    dies before it binds a port, so Rust sees only a spawn that never answers.

    A no-op wherever the streams already exist (dev, and the console-mode macOS
    build), so this stays safe cross-platform.

    **stdin is deliberately excluded.** The parent-death guard
    (`server._watch_parent_stdin`) blocks on `sys.stdin` and exits when it hits
    EOF, so substituting `os.devnull` here would hand it an instant EOF and kill
    the sidecar milliseconds after every launch. A missing stdin is handled where
    it matters — the guard logs it and declines to run — not by inventing one.
    """
    for name in ("stdout", "stderr"):
        if getattr(sys, name, None) is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))


def _run() -> None:
    # Point SSL at the bundled CA bundle BEFORE importing the app — `ollama` (and
    # httpx) build a client at import time and the frozen app has no system certs,
    # which otherwise crashes with FileNotFoundError in ssl.create_default_context.
    try:
        import certifi

        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    except Exception:
        pass
    from src.server import main

    main()


if __name__ == "__main__":
    # Required for PyInstaller-frozen apps: stops multiprocessing child processes
    # from re-running this entry point. Must run before the heavy imports above.
    multiprocessing.freeze_support()
    _ensure_stdio()
    _install_crash_handler()
    _run()
