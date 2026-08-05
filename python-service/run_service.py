"""PyInstaller entry point for the packaged Adversaria ML service sidecar.

Kept separate from `src/server.py` so the package's relative imports
(`from .models import ...`) resolve correctly when frozen. Dev still runs the
service via `uvicorn src.server:app`.
"""

import multiprocessing
import os
import sys


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
    _run()
