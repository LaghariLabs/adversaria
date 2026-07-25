# -*- mode: python ; coding: utf-8 -*-
"""Pinned, onedir Rapid-MLX runtime for the macOS application bundle."""

import os

import mlx
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = []

for package in (
    "vllm_mlx",
    "mlx",
    "mlx_lm",
    "transformers",
    "tokenizers",
    "huggingface_hub",
    "safetensors",
    "certifi",
):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("fastapi")

# MLX resolves its Metal shader library next to libmlx.dylib. PyInstaller can
# flatten the dylib, so retain a root copy just as the transcription sidecar does.
mlx_dir = list(mlx.__path__)[0]
datas += [(os.path.join(mlx_dir, "lib", "mlx.metallib"), ".")]

a = Analysis(
    ["run_rapid.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "torch",
        "torchvision",
        "mlx_vlm",
        "gradio",
        "cv2",
        "spacy",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="rapid-mlx",
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
    name="rapid-mlx",
)
