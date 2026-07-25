"""Score a validated corpus and enforce release gates without emitting content."""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from statistics import fmean
from typing import Any

from eval.metrics import (
    character_error_rate,
    diarization_error_rate,
    jaccard_error_rate,
    preservation_rate,
    speaker_attributed_word_error_rate,
    tokens,
    word_error_rate,
)
from eval.schema import LoadedSession, ReferenceItem, load_corpus

REPORT_SCHEMA_VERSION = 1
REGRESSION_METRICS = ("wer", "cer", "der", "speaker_attributed_wer")


def _items(*groups: list[ReferenceItem]) -> list[ReferenceItem]:
    return [item for group in groups for item in group]


def _average(values: list[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return fmean(present) if present else None


def _score_session(session: LoadedSession) -> dict[str, Any]:
    manifest = session.manifest
    reference = session.reference_outcomes
    hypothesis = session.hypothesis
    output = f"{hypothesis.transcript}\n{hypothesis.summary}"
    reference_turn_ids = {turn.id for turn in session.reference_turns}
    factual_items = _items(
        reference.facts,
        reference.decisions,
        reference.names,
        reference.entities,
        reference.dates,
        reference.numbers,
    )
    factual_ids = {item.id for item in factual_items}
    action_ids = {item.id for item in reference.action_items}

    valid_claims = sum(
        bool(claim.reference_ids)
        and set(claim.reference_ids).issubset(factual_ids)
        and bool(claim.evidence_turn_ids)
        and set(claim.evidence_turn_ids).issubset(reference_turn_ids)
        for claim in hypothesis.summary_claims
    )
    summary_precision = (
        valid_claims / len(hypothesis.summary_claims)
        if hypothesis.summary_claims
        else (0.0 if factual_items else None)
    )
    traced_actions = sum(
        action.reference_id in action_ids
        and bool(action.evidence_turn_ids)
        and set(action.evidence_turn_ids).issubset(reference_turn_ids)
        for action in hypothesis.action_items
    )
    action_traceability = (
        traced_actions / len(hypothesis.action_items)
        if hypothesis.action_items
        else (0.0 if reference.action_items else None)
    )
    fabricated_critical_decisions = sum(
        claim.kind == "decision"
        and claim.critical
        and not (
            claim.reference_ids
            and set(claim.reference_ids).issubset(
                {item.id for item in reference.decisions}
            )
        )
        for claim in hypothesis.summary_claims
    )

    name_values = [item.text for item in reference.names]
    entity_values = [item.text for item in reference.entities]
    date_values = [item.text for item in reference.dates]
    number_values = [item.text for item in reference.numbers]
    identity_values = [*name_values, *entity_values, *date_values, *number_values]
    reference_words = tokens(session.reference_transcript)
    hypothesis_words = tokens(hypothesis.transcript)
    is_silent = "silence" in manifest.conditions
    is_playback = "playback-only" in manifest.conditions
    hypothesis_speakers = {turn.speaker for turn in hypothesis.turns}

    metrics: dict[str, float | int | None] = {
        "wer": word_error_rate(session.reference_transcript, hypothesis.transcript),
        "cer": character_error_rate(
            session.reference_transcript, hypothesis.transcript
        ),
        "der": diarization_error_rate(session.reference_turns, hypothesis.turns),
        "jer": jaccard_error_rate(session.reference_turns, hypothesis.turns),
        "speaker_attributed_wer": speaker_attributed_word_error_rate(
            session.reference_turns, hypothesis.turns
        ),
        "speaker_count_accuracy": float(
            len(hypothesis_speakers) == manifest.expected_speaker_count
        ),
        "name_preservation": preservation_rate(name_values, output),
        "entity_preservation": preservation_rate(entity_values, output),
        "date_preservation": preservation_rate(date_values, output),
        "number_preservation": preservation_rate(number_values, output),
        "entity_number_preservation": preservation_rate(identity_values, output),
        "summary_factual_precision": summary_precision,
        "action_item_traceability": action_traceability,
        "critical_fabricated_decisions": fabricated_critical_decisions,
        "hallucinated_words": len(hypothesis_words) if is_silent else 0,
        "playback_hallucinated_words": len(hypothesis_words) if is_playback else 0,
        "reference_words": len(reference_words),
        "hypothesis_words": len(hypothesis_words),
    }
    duration_bucket = (
        "under-15m"
        if manifest.duration_seconds < 15 * 60
        else "15m-60m"
        if manifest.duration_seconds < 60 * 60
        else "60m-plus"
    )
    slices = [
        "overall",
        *(f"language:{language}" for language in manifest.languages),
        *(f"condition:{condition}" for condition in manifest.conditions),
        f"duration:{duration_bucket}",
        f"speakers:{manifest.expected_speaker_count}",
        f"model:{hypothesis.model_profile}",
        f"app:{hypothesis.app_version}",
    ]
    return {
        "session_id": manifest.session_id,
        "release_set": manifest.release_set,
        "duration_seconds": manifest.duration_seconds,
        "model_profile": hypothesis.model_profile,
        "app_version": hypothesis.app_version,
        "model_revisions": hypothesis.model_revisions,
        "evaluation_config": hypothesis.evaluation_config,
        "slices": slices,
        "metrics": metrics,
    }


def _aggregate(sessions: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for session in sessions:
        for slice_name in session["slices"]:
            grouped[slice_name].append(session)
    result: dict[str, dict[str, Any]] = {}
    for slice_name, members in sorted(grouped.items()):
        keys = members[0]["metrics"].keys()
        metrics = {
            key: _average(
                [
                    float(member["metrics"][key])
                    if member["metrics"][key] is not None
                    else None
                    for member in members
                ]
            )
            for key in keys
        }
        result[slice_name] = {"session_count": len(members), "metrics": metrics}
    return result


def _gate(name: str, passed: bool | None, detail: str) -> dict[str, Any]:
    return {
        "name": name,
        "status": "skipped" if passed is None else "passed" if passed else "failed",
        "detail": detail,
    }


def _release_gates(
    sessions: list[dict[str, Any]],
    release_slices: dict[str, dict[str, Any]],
    baseline: dict[str, Any] | None,
    all_synthetic: bool,
) -> list[dict[str, Any]]:
    release = [session for session in sessions if session["release_set"]]

    def release_average(metric: str) -> float | None:
        return _average(
            [
                float(session["metrics"][metric])
                if session["metrics"][metric] is not None
                else None
                for session in release
            ]
        )

    silent_words = sum(
        int(session["metrics"]["hallucinated_words"])
        for session in release
        if "condition:silence" in session["slices"]
    )
    critical_fabrications = sum(
        int(session["metrics"]["critical_fabricated_decisions"])
        for session in release
    )
    gates = [
        _gate(
            "silent_audio_hallucinations",
            silent_words == 0,
            f"{silent_words} hallucinated words across silent release sessions",
        ),
        _gate(
            "speaker_count_accuracy",
            (value := release_average("speaker_count_accuracy")) is not None
            and value >= 0.95,
            f"{value if value is not None else 'not measured'}; required >= 0.95",
        ),
        _gate(
            "entity_number_preservation",
            (value := release_average("entity_number_preservation")) is not None
            and value >= 0.95,
            f"{value if value is not None else 'not measured'}; required >= 0.95",
        ),
        _gate(
            "summary_factual_precision",
            (value := release_average("summary_factual_precision")) is not None
            and value >= 0.95,
            f"{value if value is not None else 'not measured'}; required >= 0.95",
        ),
        _gate(
            "action_item_traceability",
            (value := release_average("action_item_traceability")) is not None
            and value >= 0.95,
            f"{value if value is not None else 'not measured'}; required >= 0.95",
        ),
        _gate(
            "critical_fabricated_decisions",
            critical_fabrications == 0,
            f"{critical_fabrications} critical fabricated decisions",
        ),
    ]
    for slice_name, values in release_slices.items():
        if not slice_name.startswith("model:"):
            continue
        for metric in (
            "speaker_count_accuracy",
            "entity_number_preservation",
            "summary_factual_precision",
            "action_item_traceability",
        ):
            measured = values["metrics"].get(metric)
            gates.append(
                _gate(
                    f"{slice_name}/{metric}",
                    measured is not None and measured >= 0.95,
                    f"{measured if measured is not None else 'not measured'}; required >= 0.95",
                )
            )
    duration = sum(session["duration_seconds"] for session in sessions)
    gates.append(
        _gate(
            "private_corpus_readiness",
            None if all_synthetic else len(sessions) >= 20 and duration >= 5 * 60 * 60,
            (
                "synthetic smoke corpus; private-corpus size gate does not apply"
                if all_synthetic
                else f"{len(sessions)} sessions / {duration / 3600:.2f} hours; "
                "required >=20 sessions and >=5 hours"
            ),
        )
    )
    if baseline is None:
        gates.append(_gate("baseline_slice_regression", None, "no baseline supplied"))
        return gates

    regressions: list[str] = []
    baseline_slices = baseline.get("release_slices", baseline.get("slices", {}))
    for slice_name, current in release_slices.items():
        previous = baseline_slices.get(slice_name)
        if not previous:
            continue
        for metric in REGRESSION_METRICS:
            current_value = current["metrics"].get(metric)
            previous_value = previous["metrics"].get(metric)
            if (
                current_value is not None
                and previous_value is not None
                and current_value > previous_value + 0.01
            ):
                regressions.append(
                    f"{slice_name}/{metric}: {previous_value:.4f} -> {current_value:.4f}"
                )
    gates.append(
        _gate(
            "baseline_slice_regression",
            not regressions,
            "; ".join(regressions) if regressions else "no slice regressed >0.01 absolute",
        )
    )
    return gates


def run_evaluation(
    corpus_root: Path, baseline_path: Path | None = None
) -> dict[str, Any]:
    corpus, loaded_sessions = load_corpus(corpus_root)
    scored_sessions = [_score_session(session) for session in loaded_sessions]
    slices = _aggregate(scored_sessions)
    release_slices = _aggregate(
        [session for session in scored_sessions if session["release_set"]]
    )
    baseline = (
        json.loads(baseline_path.read_text(encoding="utf-8"))
        if baseline_path
        else None
    )
    all_synthetic = all(
        session.manifest.provenance.kind == "synthetic"
        for session in loaded_sessions
    )
    gates = _release_gates(
        scored_sessions, release_slices, baseline, all_synthetic
    )
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "generated_at": datetime.now(UTC).isoformat(),
        "corpus_id": corpus.corpus_id,
        "session_count": len(scored_sessions),
        "duration_seconds": sum(
            session["duration_seconds"] for session in scored_sessions
        ),
        "privacy": "aggregate-only; no transcripts, summaries, or claims emitted",
        "sessions": scored_sessions,
        "slices": slices,
        "release_slices": release_slices,
        "gates": gates,
    }


def has_failed_gates(report: dict[str, Any]) -> bool:
    return any(gate["status"] == "failed" for gate in report["gates"])
