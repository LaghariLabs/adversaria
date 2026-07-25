"""Deterministic text, diarization, and outcome metrics."""

from __future__ import annotations

import itertools
import re
import unicodedata
from collections.abc import Iterable

from eval.schema import TranscriptTurn

_ARABIC_DIACRITICS = re.compile(r"[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]")


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    text = _ARABIC_DIACRITICS.sub("", text)
    text = text.replace("ـ", "")
    return " ".join(
        "".join(char if char.isalnum() else " " for char in text).split()
    )


def tokens(text: str) -> list[str]:
    normalized = normalize_text(text)
    return normalized.split() if normalized else []


def characters(text: str) -> list[str]:
    return list(normalize_text(text).replace(" ", ""))


def edit_distance(reference: list[str], hypothesis: list[str]) -> int:
    previous = list(range(len(hypothesis) + 1))
    for row, reference_item in enumerate(reference, start=1):
        current = [row]
        for column, hypothesis_item in enumerate(hypothesis, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (reference_item != hypothesis_item),
                )
            )
        previous = current
    return previous[-1]


def error_rate(reference: list[str], hypothesis: list[str]) -> float | None:
    if not reference:
        return None
    return edit_distance(reference, hypothesis) / len(reference)


def word_error_rate(reference: str, hypothesis: str) -> float | None:
    return error_rate(tokens(reference), tokens(hypothesis))


def character_error_rate(reference: str, hypothesis: str) -> float | None:
    return error_rate(characters(reference), characters(hypothesis))


def _speakers(turns: Iterable[TranscriptTurn]) -> list[str]:
    return sorted({turn.speaker for turn in turns if turn.end > turn.start})


def _overlap(a: TranscriptTurn, b: TranscriptTurn) -> float:
    return max(0.0, min(a.end, b.end) - max(a.start, b.start))


def _speaker_overlap(
    reference: list[TranscriptTurn], hypothesis: list[TranscriptTurn]
) -> dict[tuple[str, str], float]:
    result: dict[tuple[str, str], float] = {}
    for ref in reference:
        for hyp in hypothesis:
            duration = _overlap(ref, hyp)
            if duration:
                key = (ref.speaker, hyp.speaker)
                result[key] = result.get(key, 0.0) + duration
    return result


def optimal_speaker_mapping(
    reference: list[TranscriptTurn], hypothesis: list[TranscriptTurn]
) -> dict[str, str]:
    ref_speakers = _speakers(reference)
    hyp_speakers = _speakers(hypothesis)
    overlaps = _speaker_overlap(reference, hypothesis)
    if not ref_speakers or not hyp_speakers:
        return {}
    if max(len(ref_speakers), len(hyp_speakers)) > 8:
        remaining = set(ref_speakers)
        mapping: dict[str, str] = {}
        for hyp in hyp_speakers:
            if not remaining:
                break
            ref = max(remaining, key=lambda value: overlaps.get((value, hyp), 0.0))
            mapping[hyp] = ref
            remaining.remove(ref)
        return mapping

    best_score = -1.0
    best: dict[str, str] = {}
    if len(hyp_speakers) <= len(ref_speakers):
        for assignment in itertools.permutations(ref_speakers, len(hyp_speakers)):
            mapping = dict(zip(hyp_speakers, assignment, strict=True))
            score = sum(overlaps.get((ref, hyp), 0.0) for hyp, ref in mapping.items())
            if score > best_score:
                best_score, best = score, mapping
    else:
        for assigned_hyp in itertools.permutations(hyp_speakers, len(ref_speakers)):
            mapping = dict(zip(assigned_hyp, ref_speakers, strict=True))
            score = sum(overlaps.get((ref, hyp), 0.0) for hyp, ref in mapping.items())
            if score > best_score:
                best_score, best = score, mapping
    return best


def diarization_error_rate(
    reference: list[TranscriptTurn], hypothesis: list[TranscriptTurn]
) -> float | None:
    boundaries = sorted(
        {
            point
            for turn in [*reference, *hypothesis]
            for point in (turn.start, turn.end)
            if turn.end > turn.start
        }
    )
    if len(boundaries) < 2:
        return None
    mapping = optimal_speaker_mapping(reference, hypothesis)
    numerator = 0.0
    denominator = 0.0
    for start, end in itertools.pairwise(boundaries):
        duration = end - start
        midpoint = (start + end) / 2
        ref_active = {
            turn.speaker for turn in reference if turn.start <= midpoint < turn.end
        }
        hyp_active_raw = {
            turn.speaker for turn in hypothesis if turn.start <= midpoint < turn.end
        }
        hyp_active = {mapping.get(speaker, f"unmapped:{speaker}") for speaker in hyp_active_raw}
        correct = len(ref_active & hyp_active)
        miss = max(0, len(ref_active) - len(hyp_active))
        false_alarm = max(0, len(hyp_active) - len(ref_active))
        confusion = min(len(ref_active), len(hyp_active)) - correct
        numerator += duration * (miss + false_alarm + confusion)
        denominator += duration * len(ref_active)
    return numerator / denominator if denominator else None


def jaccard_error_rate(
    reference: list[TranscriptTurn], hypothesis: list[TranscriptTurn]
) -> float | None:
    ref_speakers = _speakers(reference)
    if not ref_speakers:
        return None
    mapping = optimal_speaker_mapping(reference, hypothesis)
    inverse = {ref: hyp for hyp, ref in mapping.items()}
    overlaps = _speaker_overlap(reference, hypothesis)

    def total(turns: list[TranscriptTurn], speaker: str) -> float:
        return sum(turn.end - turn.start for turn in turns if turn.speaker == speaker)

    errors = []
    for ref in ref_speakers:
        ref_duration = total(reference, ref)
        hyp = inverse.get(ref)
        hyp_duration = total(hypothesis, hyp) if hyp else 0.0
        overlap = overlaps.get((ref, hyp), 0.0) if hyp else 0.0
        union = ref_duration + hyp_duration - overlap
        errors.append(1.0 - overlap / union if union else 0.0)
    return sum(errors) / len(errors)


def speaker_attributed_word_error_rate(
    reference: list[TranscriptTurn], hypothesis: list[TranscriptTurn]
) -> float | None:
    mapping = optimal_speaker_mapping(reference, hypothesis)
    ref_speakers = _speakers(reference)
    total_words = 0
    total_errors = 0
    for ref_speaker in ref_speakers:
        ref_words = tokens(
            " ".join(turn.text for turn in reference if turn.speaker == ref_speaker)
        )
        hyp_words = tokens(
            " ".join(
                turn.text
                for turn in hypothesis
                if mapping.get(turn.speaker) == ref_speaker
            )
        )
        total_words += len(ref_words)
        total_errors += edit_distance(ref_words, hyp_words)
    unmatched = [
        turn.text for turn in hypothesis if turn.speaker not in mapping
    ]
    total_errors += len(tokens(" ".join(unmatched)))
    return total_errors / total_words if total_words else None


def preservation_rate(values: Iterable[str], output: str) -> float | None:
    expected = [normalize_text(value) for value in values]
    if not expected:
        return None
    normalized_output = normalize_text(output)
    return sum(value in normalized_output for value in expected) / len(expected)

