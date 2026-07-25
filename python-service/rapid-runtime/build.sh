#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

rm -rf build dist
uv sync --frozen
uv run pyinstaller rapid-mlx.spec --noconfirm

"$ROOT/dist/rapid-mlx/rapid-mlx" --version
