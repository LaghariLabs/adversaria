"""Command-line entry point for private/local and synthetic CI evaluation."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from eval.report import write_reports
from eval.runner import has_failed_gates, run_evaluation


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--corpus",
        type=Path,
        help="Corpus root; defaults to ADVERSARIA_EVAL_CORPUS",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--fail-on-gate", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    corpus = args.corpus
    if corpus is None:
        value = os.environ.get("ADVERSARIA_EVAL_CORPUS")
        if not value:
            print(
                "Set ADVERSARIA_EVAL_CORPUS or pass --corpus. Private audio must stay outside Git.",
                file=sys.stderr,
            )
            return 2
        corpus = Path(value)
    try:
        report = run_evaluation(corpus, args.baseline)
        json_path, html_path = write_reports(report, args.output)
    except (OSError, ValueError) as error:
        print(f"Evaluation failed: {error}", file=sys.stderr)
        return 2
    print(f"Aggregate JSON: {json_path}")
    print(f"Aggregate HTML: {html_path}")
    for gate in report["gates"]:
        print(f"{gate['status'].upper():7} {gate['name']}: {gate['detail']}")
    return 1 if args.fail_on_gate and has_failed_gates(report) else 0


if __name__ == "__main__":
    raise SystemExit(main())

