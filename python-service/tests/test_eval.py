from __future__ import annotations

import json
from pathlib import Path

from eval.cli import main
from eval.metrics import (
    character_error_rate,
    diarization_error_rate,
    speaker_attributed_word_error_rate,
    word_error_rate,
)
from eval.runner import has_failed_gates, run_evaluation
from eval.schema import TranscriptTurn


FIXTURE = Path(__file__).parents[1] / "eval" / "fixtures" / "synthetic"


def _turn(identifier: str, speaker: str, text: str, start: float, end: float):
    return TranscriptTurn(
        id=identifier, speaker=speaker, text=text, start=start, end=end
    )


def test_text_metrics_are_deterministic_and_arabic_diacritic_tolerant():
    assert word_error_rate("hello world", "hello there") == 0.5
    assert character_error_rate("مَرْحَبًا", "مرحبا") == 0.0


def test_speaker_mapping_ignores_anonymous_label_names():
    reference = [
        _turn("r1", "speaker-a", "hello", 0, 2),
        _turn("r2", "speaker-b", "world", 2, 4),
    ]
    hypothesis = [
        _turn("h1", "Them", "hello", 0, 2),
        _turn("h2", "Me", "world", 2, 4),
    ]
    assert diarization_error_rate(reference, hypothesis) == 0.0
    assert speaker_attributed_word_error_rate(reference, hypothesis) == 0.0


def test_synthetic_release_fixture_passes_and_contains_no_content():
    report = run_evaluation(FIXTURE)
    assert not has_failed_gates(report)
    encoded = json.dumps(report)
    assert "Amina approved" not in encoded
    assert report["slices"]["language:en"]["session_count"] == 2
    assert report["slices"]["overall"]["metrics"]["wer"] == 0.0


def test_cli_writes_json_and_html(tmp_path):
    assert (
        main(
            [
                "--corpus",
                str(FIXTURE),
                "--output",
                str(tmp_path),
                "--fail-on-gate",
            ]
        )
        == 0
    )
    assert (tmp_path / "report.json").is_file()
    assert "Release gates" in (tmp_path / "report.html").read_text(encoding="utf-8")


def test_baseline_ratchet_fails_a_one_point_slice_regression(tmp_path):
    baseline = run_evaluation(FIXTURE)
    baseline["release_slices"]["language:en"]["metrics"]["wer"] = -0.02
    baseline_path = tmp_path / "baseline.json"
    baseline_path.write_text(json.dumps(baseline), encoding="utf-8")

    report = run_evaluation(FIXTURE, baseline_path)
    regression_gate = next(
        gate for gate in report["gates"] if gate["name"] == "baseline_slice_regression"
    )
    assert regression_gate["status"] == "failed"
    assert "language:en/wer" in regression_gate["detail"]
