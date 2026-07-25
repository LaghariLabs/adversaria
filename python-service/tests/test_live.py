"""Tests for the VAD-gated live-caption session (pure logic; ML mocked)."""

from __future__ import annotations

import wave

import numpy as np

from src import live
from src.live import LiveCaptionSession, completed_utterances

SR = 16000


class TestCompletedUtterances:
    def test_finished_utterance_selected(self):
        # 3 s of speech followed by 3 s of silence — safely finished.
        speech = [{"start": 0, "end": 3 * SR}]
        ready, mark = completed_utterances(speech, buffer_end=6 * SR, emitted_upto=0)
        assert ready == [(0, 3 * SR)]
        assert mark == 3 * SR

    def test_utterance_still_running_waits(self):
        # Only 0.5 s of trailing silence (< 2 s redemption) — still being spoken.
        speech = [{"start": 0, "end": 5 * SR}]
        ready, mark = completed_utterances(speech, buffer_end=5 * SR + SR // 2, emitted_upto=0)
        assert ready == []
        assert mark == 0

    def test_long_monologue_force_cut_and_continuation(self):
        # 31 s of continuous speech with no pause: force-cut at max_utterance_s
        # so the caption still appears. Explicit max_utterance_s keeps this a
        # test of the LOGIC, independent of the product default (tuned to 8 s).
        speech = [{"start": 0, "end": 31 * SR}]
        ready, mark = completed_utterances(
            speech, buffer_end=31 * SR, emitted_upto=0, max_utterance_s=30
        )
        assert ready == [(0, 30 * SR)]
        assert mark == 30 * SR
        # ...and the remainder is captioned from the watermark once it finishes.
        speech2 = [{"start": 0, "end": 33 * SR}]
        ready2, mark2 = completed_utterances(
            speech2, buffer_end=36 * SR, emitted_upto=mark, max_utterance_s=30
        )
        assert ready2 == [(30 * SR, 33 * SR)]
        assert mark2 == 33 * SR

    def test_already_captioned_skipped(self):
        speech = [{"start": 0, "end": 3 * SR}]
        ready, mark = completed_utterances(speech, buffer_end=6 * SR, emitted_upto=3 * SR)
        assert ready == []
        assert mark == 3 * SR

    def test_two_finished_utterances_in_order(self):
        speech = [{"start": SR, "end": 3 * SR}, {"start": 5 * SR, "end": 7 * SR}]
        ready, mark = completed_utterances(speech, buffer_end=10 * SR, emitted_upto=0)
        assert ready == [(SR, 3 * SR), (5 * SR, 7 * SR)]
        assert mark == 7 * SR

    def test_empty(self):
        assert completed_utterances([], buffer_end=SR, emitted_upto=0) == ([], 0)


def _write_wav(path, seconds: float) -> None:
    pcm = np.zeros(int(seconds * SR), dtype="<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


class TestLiveCaptionSession:
    def test_ingest_vad_slice_and_trim(self, tmp_path, monkeypatch):
        # VAD is injected; the session's job is bookkeeping around it.
        monkeypatch.setattr(
            live, "_speech_timestamps", lambda audio: [{"start": SR, "end": 2 * SR}]
        )
        delta = tmp_path / "delta.wav"
        _write_wav(delta, 5.0)

        s = LiveCaptionSession()
        s.ingest(1, str(delta))
        ready, mark = s.pending_utterances()
        assert ready == [(SR, 2 * SR)]  # finished: 3 s trailing silence

        wav = s.write_utterance_wav(SR, 2 * SR)
        try:
            with wave.open(str(wav), "rb") as w:
                assert w.getframerate() == SR
                assert w.getnframes() == SR  # exactly the 1 s utterance
        finally:
            wav.unlink()

        # Advancing trims consumed audio but keeps a lookback margin, and
        # absolute positions survive the trim via the base offset.
        s.advance(4 * SR)
        assert s._base == 2 * SR
        assert s._emitted == 4 * SR

    def test_new_session_resets_state(self, tmp_path, monkeypatch):
        monkeypatch.setattr(live, "_speech_timestamps", lambda audio: [])
        delta = tmp_path / "delta.wav"
        _write_wav(delta, 3.0)

        s = LiveCaptionSession()
        s.ingest(1, str(delta))
        s.advance(2 * SR)
        assert s._emitted == 2 * SR
        s.ingest(2, str(delta))  # new recording epoch → clean slate
        assert s._emitted == 0
        assert len(s._buffer) == 3 * SR


class TestFillerHallucinationFilter:
    """Live-preview cosmetic gate: Whisper's canonical noise-fillers ("Thank
    you." on a breath, "Thanks for watching" on silence) must not caption.
    Real speech — including these words inside a longer sentence — must."""

    def test_canonical_fillers_dropped(self):
        for text in [
            "Thank you.",
            "thank you",
            "Thank you very much.",
            "Thanks for watching!",
            "Thank you for watching.",
            "Thank you so much for watching.",
            "You",
        ]:
            assert live.is_filler_hallucination(text), text

    def test_real_speech_kept(self):
        for text in [
            "Thank you for the update on the migration.",
            "I want to thank you all before we move to the roadmap.",
            "The beta ships Friday.",
            "شكرا جزيلا على العرض التقديمي المفصل",
        ]:
            assert not live.is_filler_hallucination(text), text

    def test_normalization_handles_punctuation_and_spacing(self):
        assert live.is_filler_hallucination("  THANK   YOU!!!  ")


class TestRepetitionLoopFilter:
    """Live-preview cosmetic gate: Whisper's repetition-loop hallucination on
    noise ("pre pre pre pre pre pre pre pre …") must not caption."""

    def test_repetition_loops_dropped(self):
        for text in [
            ("pre " * 200).strip(),
            "pre pre pre pre pre pre pre pre",
            "pre pre, pre pre, pre pre, pre pre.",
        ]:
            assert live.is_repetition_loop(text), repr(text)

    def test_real_speech_kept(self):
        for text in [
            "Good, just fast, just quick. Yeah.",
            "pre pre pre pre pre",
            "so you get a lot of like thank yous",
        ]:
            assert not live.is_repetition_loop(text), repr(text)


class TestDropNoSpeechRawSegments:
    """Live transcriber drops segments Whisper itself flags as probable
    non-speech; segments without the field are kept (fail open)."""

    def test_high_no_speech_dropped_low_kept(self):
        from src.transcriber import drop_no_speech_raw_segments

        segs = [
            {"start": 0.0, "end": 1.0, "text": "Thank you.", "no_speech_prob": 0.92},
            {"start": 1.0, "end": 3.0, "text": "The beta ships Friday.", "no_speech_prob": 0.05},
        ]
        kept = drop_no_speech_raw_segments(segs)
        assert [s["text"] for s in kept] == ["The beta ships Friday."]

    def test_missing_field_fails_open(self):
        from src.transcriber import drop_no_speech_raw_segments

        segs = [{"start": 0.0, "end": 1.0, "text": "kept"}]
        assert drop_no_speech_raw_segments(segs) == segs
