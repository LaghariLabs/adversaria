"""PyInstaller entry point for the packaged Adversaria ML service sidecar.

Kept separate from `src/server.py` so the package's relative imports
(`from .models import ...`) resolve correctly when frozen. Dev still runs the
service via `uvicorn src.server:app`.
"""

import multiprocessing
import os


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
    _run()
