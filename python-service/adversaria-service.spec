# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Adversaria ML service sidecar (macOS / Apple Silicon).

Builds a --onedir bundle: a `adversaria-service` launcher + an `_internal`
payload. Bundles the MLX stack, uvicorn's dynamically-imported submodules, and
the default prompt templates (config.py seeds a writable copy on first run).

Build:  cd python-service && uv run --with pyinstaller pyinstaller adversaria-service.spec --noconfirm
"""
import os

import mlx
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = []

# Heavy / dynamically-loaded packages need their data + native libs collected.
# faster_whisper/av/ctranslate2 are imported at module load by transcriber.py even
# on the macOS MLX path, so they must be present (av/ctranslate2 ship native libs).
for pkg in (
    "mlx",
    "mlx_whisper",
    # Qwen3-ASR engine (0.3.77): imported lazily by transcriber.py when a qwen
    # model is selected — invisible to import analysis, so it must be collected
    # explicitly or the packaged app's Qwen engine silently becomes dev-only.
    "qwen3_asr_mlx",
    "av",
    "ctranslate2",
    "faster_whisper",
    "tiktoken",
    "huggingface_hub",
    "certifi",
    # Speaker diarization: ships native libs under sherpa_onnx/lib (the
    # _sherpa_onnx extension + libonnxruntime + libsherpa-onnx-*); all must be
    # collected or the frozen sidecar can't dlopen them.
    "sherpa_onnx",
):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# PyInstaller flattens libmlx.dylib to the bundle root, but MLX looks for
# mlx.metallib *next to the dylib* — so place a copy at the root too, else MLX
# fails with "Failed to load the default metallib" and falls back to CPU.
_mlx_dir = list(mlx.__path__)[0]
_mlx_metallib = os.path.join(_mlx_dir, "lib", "mlx.metallib")
datas += [(_mlx_metallib, ".")]

# uvicorn imports its protocol/lifespan/loop backends by string at runtime;
# tiktoken loads its encodings via plugin modules under tiktoken_ext.
hiddenimports += collect_submodules("uvicorn")
hiddenimports += ["uvicorn.logging", "tiktoken_ext", "tiktoken_ext.openai_public"]

# Default prompt templates -> bundle root /prompts (config.py reads sys._MEIPASS/prompts).
datas += [("prompts", "prompts")]

a = Analysis(
    ["run_service.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="adversaria-service",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    target_arch="arm64",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="adversaria-service",
)
