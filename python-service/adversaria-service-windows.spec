# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Adversaria ML service sidecar (Windows / x86_64).

The Windows twin of `adversaria-service.spec`. Same --onedir shape (an
`adversaria-service.exe` launcher + an `_internal` payload) so the existing
`bundle.resources` mapping in tauri.conf.json copies it unchanged.

Differences from the macOS spec, and why:
- **No MLX.** `mlx` / `mlx_whisper` / `mlx.metallib` are Apple-Silicon only.
  Windows transcribes with faster-whisper (CTranslate2); `create_transcriber()`
  already selects that backend off `sys.platform`.
- **CUDA DLLs are baked in.** `transcriber.py::_patch_cuda_path()` hunts
  site-packages and the CUDA Toolkit, neither of which exists inside a frozen
  bundle — so it is a no-op here and the DLLs MUST ship in the bundle.
- **`console=False`.** A console-subsystem exe flashes a black terminal on every
  launch. See the stdio guard in `run_service.py` — a windowed PyInstaller app
  gets `sys.stdout is None`, which crashes uvicorn's logging config.
- **No `target_arch`.** Windows builds are x86_64; the macOS spec pins arm64.

Build (must run ON Windows — PyInstaller does not cross-compile):
    cd python-service
    uv sync --extra cuda
    uv run --with pyinstaller pyinstaller adversaria-service-windows.spec --noconfirm

**Defaults to CPU-only, because the CUDA build cannot be packaged at all.**
Bundling the CUDA runtime makes this sidecar ~2.4 GB (1.9 GB of it 15 CUDA
DLLs, `cublasLt64_12.dll` alone being 638 MB), and NSIS tops out around 2 GB —
`makensis` dies with "Internal compiler error #12345: error mmapping datablock".
MSI is no better. See docs/LESSONS_LEARNED.md.

Transcription still works CPU-only: `device="auto"` falls back to int8. A user
who has the NVIDIA CUDA Toolkit installed still gets GPU, because
`_patch_cuda_path()`'s Toolkit branch is the one that still works when frozen.

Set ADVERSARIA_BUNDLE_CUDA=1 to bundle it anyway — useful for a zip-distributed
GPU build, but the NSIS step WILL fail. docs/TODO.md tracks the real fix
(download the CUDA runtime on first run, as model weights already are).
"""
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = []

# Heavy / dynamically-loaded packages need their data + native libs collected.
# av and ctranslate2 ship native libs; faster_whisper is the Windows transcription
# backend; sherpa_onnx ships the diarization runtime (onnxruntime + native libs)
# and cannot dlopen them unless they are collected.
for pkg in (
    "av",
    "ctranslate2",
    "faster_whisper",
    "tiktoken",
    "huggingface_hub",
    "certifi",
    "sherpa_onnx",
):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# --- CUDA runtime -----------------------------------------------------------
# CTranslate2 loads cublas64_12.dll / cudnn*.dll through the OS loader, which
# searches the executable's directory — NOT nested subdirectories. The nvidia-*
# wheels lay their DLLs out as `nvidia/<pkg>/bin/*.dll`, so collecting them
# verbatim would place them where the loader will never look and the GPU path
# would fail at runtime with a DLL-not-found that silently degrades to CPU.
# Flatten every CUDA DLL to the bundle root instead.
#
# NOTE: CTranslate2 >=4.5 requires cuDNN 9 + CUDA >=12.3 for Blackwell (sm_120,
# e.g. RTX 5090); an older pair throws CUBLAS_STATUS_NOT_SUPPORTED at load.
if os.environ.get("ADVERSARIA_BUNDLE_CUDA", "0") == "1":
    # Discover whatever `uv sync --extra cuda` actually installed rather than
    # hardcoding a list. The extra declares cublas and cudnn, but pip resolves
    # further runtime deps (cuda_nvrtc today), and a hardcoded list would drop a
    # future addition silently — surfacing only as a DLL-not-found at runtime
    # that degrades to CPU without an error the user would ever see.
    _nvidia_pkgs = []
    try:
        import nvidia

        _nvidia_pkgs = sorted(
            f"nvidia.{child.name}"
            for root in nvidia.__path__
            for child in Path(root).iterdir()
            if child.is_dir() and not child.name.startswith("_")
        )
    except ImportError:
        pass

    _cuda_dll_count = 0
    for pkg in _nvidia_pkgs:
        try:
            _, b, _ = collect_all(pkg)
        except Exception as exc:
            print(f"[spec] WARNING: {pkg} not collected ({exc}).")
            continue
        _cuda_dll_count += len(b)
        # Re-point every collected binary at the bundle root.
        binaries += [(src, ".") for src, _dest in b]

    if _cuda_dll_count:
        print(f"[spec] CUDA runtime: {_cuda_dll_count} libs from {', '.join(_nvidia_pkgs)}")
    else:
        print(
            "[spec] WARNING: no CUDA runtime collected. Run `uv sync --extra cuda` "
            "for a GPU-capable sidecar, or set ADVERSARIA_BUNDLE_CUDA=0 to silence this."
        )
else:
    print(
        "[spec] CPU-only sidecar (the packageable default). "
        "Set ADVERSARIA_BUNDLE_CUDA=1 to bundle CUDA — NSIS will then fail on size."
    )

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
    excludes=["tkinter", "mlx", "mlx_whisper"],
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
    # Windowed: no console flashes when Rust spawns the sidecar. run_service.py
    # repoints sys.stdout/stderr at devnull so uvicorn's logging still works.
    console=False,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="adversaria-service",
)
