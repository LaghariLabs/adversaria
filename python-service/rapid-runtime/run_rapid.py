"""Frozen entry point for Adversaria's pinned Rapid-MLX runtime."""

from __future__ import annotations

import multiprocessing


def main() -> None:
    multiprocessing.freeze_support()
    from vllm_mlx.cli import main as rapid_main

    rapid_main()


if __name__ == "__main__":
    main()
