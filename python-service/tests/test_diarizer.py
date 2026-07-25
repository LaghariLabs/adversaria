"""Tests for the diarizer's pure post-clustering cleanup (no ML deps)."""

from __future__ import annotations

from src.diarizer import (
    drop_unvoiced_turns,
    merge_minor_speakers,
    merge_similar_speakers,
)


class TestMergeMinorSpeakers:
    def test_phantom_cluster_merged_into_nearest_real_speaker(self):
        # Two real speakers (100 s each) + a 3 s phantom cluster right after
        # speaker 1's turn — the "Speaker 13 in a 2-person call" case.
        turns = [
            (0.0, 100.0, 0),
            (100.0, 103.0, 7),  # phantom
            (110.0, 210.0, 1),
        ]
        merged = merge_minor_speakers(turns)
        assert {spk for _, _, spk in merged} == {0, 1}
        # The phantom turn is closest to speaker 0's turn (gap 0 vs 7 s).
        assert merged[1] == (100.0, 103.0, 0)

    def test_speaker_count_capped(self):
        # 12 "speakers" of 20 s each — more than any real meeting's remote side.
        turns = [(i * 20.0, i * 20.0 + 20.0, i) for i in range(12)]
        merged = merge_minor_speakers(turns, max_speakers=8)
        assert len({spk for _, _, spk in merged}) <= 8
        # Every original turn is still present (relabeled, not dropped).
        assert [(s, e) for s, e, _ in merged] == [(s, e) for s, e, _ in turns]

    def test_all_minor_keeps_dominant_voice(self):
        # Everything is under the floor — keep the longest speaker rather
        # than merging into nothing.
        turns = [(0.0, 3.0, 0), (3.0, 8.0, 1)]
        merged = merge_minor_speakers(turns)
        assert {spk for _, _, spk in merged} == {1}

    def test_two_real_speakers_untouched(self):
        turns = [(0.0, 60.0, 0), (60.0, 120.0, 1)]
        assert merge_minor_speakers(turns) == turns

    def test_empty(self):
        assert merge_minor_speakers([]) == []


class TestDropUnvoicedTurns:
    def test_music_only_cluster_dropped(self):
        # Speakers 0/1 carry transcribed speech; speaker 2 covers an intro
        # jingle Whisper produced no text for — a phantom source of speakers.
        turns = [(0.0, 30.0, 0), (30.0, 60.0, 2), (60.0, 90.0, 1)]
        voiced = [1.0, 12.0, 65.0, 80.0]  # transcribed segment starts
        kept = drop_unvoiced_turns(turns, voiced)
        assert {spk for _, _, spk in kept} == {0, 1}

    def test_slack_tolerates_boundary_disagreement(self):
        # Segment starts 0.6 s before the turn — within the 1 s slack.
        turns = [(10.0, 20.0, 0)]
        assert drop_unvoiced_turns(turns, [9.4]) == turns

    def test_fail_open_when_nothing_matches(self):
        # Misaligned inputs must not delete the whole diarization.
        turns = [(0.0, 10.0, 0)]
        assert drop_unvoiced_turns(turns, [500.0]) == turns

    def test_no_voiced_starts_passthrough(self):
        turns = [(0.0, 10.0, 0)]
        assert drop_unvoiced_turns(turns, []) == turns


class TestMergeSimilarSpeakers:
    def test_same_voice_split_is_remerged(self):
        # One voice split into clusters 0 and 1 (near-identical embeddings);
        # the longer-speaking cluster keeps the label.
        turns = [(0.0, 60.0, 0), (60.0, 90.0, 1)]
        embeddings = {0: [1.0, 0.0, 0.1], 1: [1.0, 0.05, 0.1]}
        merged = merge_similar_speakers(turns, embeddings)
        assert {spk for _, _, spk in merged} == {0}
        # Turn boundaries are preserved — only labels change.
        assert [(s, e) for s, e, _ in merged] == [(s, e) for s, e, _ in turns]

    def test_distinct_voices_untouched(self):
        turns = [(0.0, 60.0, 0), (60.0, 120.0, 1)]
        embeddings = {0: [1.0, 0.0, 0.0], 1: [0.0, 1.0, 0.0]}  # orthogonal
        assert merge_similar_speakers(turns, embeddings) == turns

    def test_speaker_without_embedding_left_alone(self):
        turns = [(0.0, 60.0, 0), (60.0, 90.0, 1), (90.0, 100.0, 2)]
        embeddings = {0: [1.0, 0.0], 1: [1.0, 0.01]}  # 2 has no embedding
        merged = merge_similar_speakers(turns, embeddings)
        assert {spk for _, _, spk in merged} == {0, 2}

    def test_transitive_merge_collapses_chain(self):
        # 0~1 and 1~2 similar → all three collapse to the longest speaker.
        turns = [(0.0, 100.0, 0), (100.0, 130.0, 1), (130.0, 150.0, 2)]
        embeddings = {
            0: [1.0, 0.0, 0.0],
            1: [0.95, 0.3, 0.0],
            2: [0.95, 0.31, 0.0],
        }
        merged = merge_similar_speakers(turns, embeddings)
        assert {spk for _, _, spk in merged} == {0}

    def test_fewer_than_two_embeddings_passthrough(self):
        turns = [(0.0, 60.0, 0), (60.0, 120.0, 1)]
        assert merge_similar_speakers(turns, {0: [1.0, 0.0]}) == turns
        assert merge_similar_speakers(turns, {}) == turns

    def test_empty(self):
        assert merge_similar_speakers([], {0: [1.0], 1: [1.0]}) == []
