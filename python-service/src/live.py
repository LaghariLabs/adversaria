"""VAD-gated live captions: transcribe each spoken utterance exactly once.

The old live preview re-transcribed a rolling 30 s window every 12 s — the same
audio was decoded repeatedly and utterances were cut mid-word at window edges.
Here the Rust side streams small audio deltas into a session buffer; Silero VAD
(bundled with faster-whisper, no extra dependency) segments the stream into
complete utterances, and each utterance is transcribed ONCE when it ends
(≥ ``_REDEMPTION_MS`` of trailing silence) or when it exceeds
``_MAX_UTTERANCE_S`` (forced cut so a monologue still captions).

VAD constants follow Meetily's field-tuned values (MIT, verified 2026-07-06:
``frontend/src-tauri/src/audio/vad.rs`` — positive 0.5 / negative 0.35 /
redemption 2000 ms / min speech 250 ms / pad ~300 ms), which their comments
document as the fix for fragmented sentences.

Preview tier (2026-09-01): while an utterance is still being spoken, the
not-yet-confirmed audio tail is re-decoded every poll by
``MoonshinePartialEngine`` (sherpa-onnx Moonshine v2 tiny, English) and shown
grey; the confirmed Whisper caption replaces it. The engine never holds the
Whisper lock.
"""

from __future__ import annotations

import logging
import re
import tempfile
import threading
import wave
from pathlib import Path

logger = logging.getLogger(__name__)

# Whisper's canonical noise-fillers: what the decoder emits for a breath or
# faint noise burst that Silero counted as voice (learned from YouTube outros).
# Normalized (lowercase, no punctuation, collapsed whitespace).
_FILLER_HALLUCINATIONS = {
    "thank you",
    "thank you very much",
    "thank you so much",
    "thanks for watching",
    "thank you for watching",
    "thank you so much for watching",
    "thanks for watching and see you in the next video",
    "you",
}


def is_filler_hallucination(text: str) -> bool:
    """True when a live caption is one of Whisper's canonical noise-fillers
    ("Thank you." on a breath). COSMETIC, LIVE-PREVIEW-ONLY filter — the final
    transcript never passes through here; it relies on the VAD gates instead,
    so a real spoken "thank you" is still stored."""
    norm = re.sub(r"[^\w\s]", "", text, flags=re.UNICODE).strip().lower()
    norm = re.sub(r"\s+", " ", norm)
    return norm in _FILLER_HALLUCINATIONS


def is_repetition_loop(text: str) -> bool:
    """True when a live caption is one or two tokens stuck on repeat
    ("pre pre pre pre pre pre pre pre ...") — Whisper's repetition-loop
    failure mode on noise. COSMETIC, LIVE-PREVIEW-ONLY filter, same contract
    as is_filler_hallucination: the final transcript never passes through
    here, so a real (rare) long emphatic repeat is still stored."""
    norm = re.sub(r"[^\w\s]", "", text, flags=re.UNICODE).strip().lower()
    tokens = norm.split()
    if len(tokens) < 8:
        return False
    return len(set(tokens)) <= 2


def _loop_token(token: str) -> str:
    """Comparison form of a token for loop detection: case- and punctuation-insensitive."""
    return re.sub(r"[^\w]", "", token, flags=re.UNICODE).lower()


def trim_repetition_loop(text: str, max_ngram: int = 4, min_repeats: int = 3) -> str:
    """Cut a PREVIEW at the point where the decoder started looping.

    Re-decoding a short, mid-word audio tail makes Moonshine repeat a token or
    phrase ("the data base to the data base to …"). `is_repetition_loop` only
    catches whole-caption loops; this keeps the sane prefix, keeps ONE copy of
    the looped unit, and drops the rest. Pure and cheap: for each position it
    checks 1..max_ngram-word units for min_repeats consecutive identical runs
    (comparison is case- and punctuation-insensitive). Unchanged text when no
    loop is found. Preview-only — the confirmed transcript never passes here.
    """
    tokens = text.split()
    norm = [_loop_token(t) for t in tokens]
    for i in range(len(tokens)):
        for n in range(1, max_ngram + 1):
            if i + n * min_repeats > len(tokens):
                break
            unit = norm[i : i + n]
            if not any(unit):
                continue
            if all(
                norm[i + k * n : i + (k + 1) * n] == unit for k in range(1, min_repeats)
            ):
                return " ".join(tokens[: i + n]).rstrip(" ,;:")
    return text


_SAMPLE_RATE = 16000
_VAD_THRESHOLD = 0.5
_VAD_NEG_THRESHOLD = 0.35
_MIN_SPEECH_MS = 250
# Trailing silence that marks an utterance as finished. Tuned DOWN from Meetily's
# 2000 ms to 900 ms: this is a live *preview*, so a caption ~1 s after you pause
# beats a "correct" one 2 s later. The accurate final transcript is a separate
# full pass at stop and is unaffected by these live constants.
_REDEMPTION_MS = 900
_SPEECH_PAD_MS = 300
# Force-cut so a long, pause-free monologue still captions promptly. Tuned DOWN
# from 30 s → 8 s: without it, speaking continuously (or a noisy mic that never
# dips below the VAD threshold) delayed a caption by up to 30 s — the main cause
# of the "live transcript is very slow" reports.
_MAX_UTTERANCE_S = 8.0
# Keep this much audio behind the emitted watermark so VAD has left context.
_TRIM_MARGIN_S = 2.0
# Moonshine v2's ORT export throws inside ONNX Runtime for inputs >= 10 s
# (probed 2026-09-01), so the preview decodes at most the LAST 8 s of the
# unconfirmed tail — which also matches _MAX_UTTERANCE_S.
LIVE_PARTIAL_MAX_S = 8.0
# Below this much unconfirmed speech there is nothing worth previewing.
LIVE_PARTIAL_MIN_S = 0.3


def completed_utterances(
    speech_ts: list[dict],
    buffer_end: int,
    emitted_upto: int,
    sample_rate: int = _SAMPLE_RATE,
    redemption_ms: int = _REDEMPTION_MS,
    max_utterance_s: float = _MAX_UTTERANCE_S,
) -> tuple[list[tuple[int, int]], int]:
    """Select utterances ready to transcribe. Pure — unit-testable.

    ``speech_ts`` are absolute-sample {"start", "end"} dicts from VAD;
    ``buffer_end`` is the absolute end of buffered audio; ``emitted_upto`` is
    the watermark of already-captioned audio. An utterance is ready when it has
    ≥ ``redemption_ms`` of silence after it (truly finished) or it already
    spans ``max_utterance_s`` (forced cut; the remainder continues next pass).
    Returns (utterances, new_watermark).
    """
    redemption = int(redemption_ms * sample_rate / 1000)
    max_len = int(max_utterance_s * sample_rate)
    ready: list[tuple[int, int]] = []
    watermark = emitted_upto
    for seg in speech_ts:
        start, end = int(seg["start"]), int(seg["end"])
        if end <= emitted_upto:
            continue  # already captioned
        finished = (buffer_end - end) >= redemption
        force_cut = (end - max(start, emitted_upto)) >= max_len
        if not (finished or force_cut):
            continue  # still being spoken — wait for silence
        cut_end = min(end, max(start, emitted_upto) + max_len) if force_cut else end
        ready.append((max(start, emitted_upto), cut_end))
        watermark = max(watermark, cut_end)
    return ready, watermark


def completed_utterance_events(
    speech_ts: list[dict],
    buffer_end: int,
    emitted_upto: int,
    sample_rate: int = _SAMPLE_RATE,
    redemption_ms: int = _REDEMPTION_MS,
    max_utterance_s: float = _MAX_UTTERANCE_S,
) -> tuple[list[tuple[int, int, str]], int]:
    """Return ready spans with their semantic boundary.

    ``forced`` means the live latency cap split continuous speech and the next
    caption still belongs to the same speech turn. ``silence`` means VAD heard
    enough trailing silence to finish the turn. The original pair-returning
    helper stays stable for callers that only need audio spans.
    """
    redemption = int(redemption_ms * sample_rate / 1000)
    max_len = int(max_utterance_s * sample_rate)
    ready: list[tuple[int, int, str]] = []
    watermark = emitted_upto
    for seg in speech_ts:
        start, end = int(seg["start"]), int(seg["end"])
        if end <= emitted_upto:
            continue
        finished = (buffer_end - end) >= redemption
        force_cut = (end - max(start, emitted_upto)) >= max_len
        if not (finished or force_cut):
            continue
        cut_end = min(end, max(start, emitted_upto) + max_len) if force_cut else end
        ready.append(
            (max(start, emitted_upto), cut_end, "forced" if force_cut else "silence")
        )
        watermark = max(watermark, cut_end)
    return ready, watermark


def _speech_timestamps(audio) -> list[dict]:
    """VAD over a float32 mono 16 kHz array (module-level for test injection)."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    return get_speech_timestamps(
        audio,
        VadOptions(
            threshold=_VAD_THRESHOLD,
            neg_threshold=_VAD_NEG_THRESHOLD,
            min_speech_duration_ms=_MIN_SPEECH_MS,
            min_silence_duration_ms=_REDEMPTION_MS,
            speech_pad_ms=_SPEECH_PAD_MS,
        ),
        sampling_rate=_SAMPLE_RATE,
    )


class LiveCaptionSession:
    """Accumulates one recording's live audio and yields finished utterances.

    Absolute sample positions are tracked across buffer trims via ``_base`` so
    the emitted watermark survives; a new ``session`` id (the Rust side's
    recording epoch) resets everything.
    """

    def __init__(self) -> None:
        self._session: int | None = None
        self._reset()

    def _reset(self) -> None:
        import numpy as np

        self._buffer = np.zeros(0, dtype="float32")
        self._base = 0  # absolute sample index of _buffer[0]
        self._emitted = 0  # absolute watermark of captioned audio
        self._last_speech: list[dict] = []
        # Preview is English-only; a confirmed utterance in another language
        # pauses it for this source until English returns (see
        # note_confirmed_language).
        self.partials_enabled = True

    def ingest(self, session: int, audio_path: str) -> None:
        """Append a delta WAV (any rate/layout — decoded to 16 kHz mono)."""
        import numpy as np
        from faster_whisper.audio import decode_audio

        if session != self._session:
            self._session = session
            self._reset()
        samples = decode_audio(audio_path, sampling_rate=_SAMPLE_RATE)
        if len(samples):
            self._buffer = np.concatenate([self._buffer, samples.astype("float32")])

    def pending_utterances(self) -> tuple[list[tuple[int, int]], int]:
        """Absolute (start, end) of utterances ready to caption + new watermark."""
        if not len(self._buffer):
            self._last_speech = []
            return [], self._emitted
        speech = _speech_timestamps(self._buffer)
        absolute = [
            {"start": s["start"] + self._base, "end": s["end"] + self._base}
            for s in speech
        ]
        self._last_speech = absolute
        return completed_utterances(
            absolute, self._base + len(self._buffer), self._emitted
        )

    def pending_utterance_events(self) -> tuple[list[tuple[int, int, str]], int]:
        """Ready utterances plus ``forced``/``silence`` turn boundaries."""
        if not len(self._buffer):
            self._last_speech = []
            return [], self._emitted
        speech = _speech_timestamps(self._buffer)
        absolute = [
            {"start": s["start"] + self._base, "end": s["end"] + self._base}
            for s in speech
        ]
        self._last_speech = absolute
        return completed_utterance_events(
            absolute, self._base + len(self._buffer), self._emitted
        )

    def unconfirmed_tail(self, max_seconds: float = LIVE_PARTIAL_MAX_S):
        """Float32 samples of speech not yet confirmed by Whisper: from the
        first VAD speech region at/after the watermark to the end of the
        buffer, capped to the LAST ``max_seconds``. Empty when no speech follows
        the watermark or the span is under LIVE_PARTIAL_MIN_S."""
        import numpy as np

        end = self._base + len(self._buffer)
        starts = [
            max(int(seg["start"]), self._emitted)
            for seg in self._last_speech
            if int(seg["end"]) > self._emitted
        ]
        if not starts:
            return np.zeros(0, dtype="float32")
        start = max(min(starts), end - int(max_seconds * _SAMPLE_RATE))
        if end - start < int(LIVE_PARTIAL_MIN_S * _SAMPLE_RATE):
            return np.zeros(0, dtype="float32")
        lo = max(start - self._base, 0)
        hi = end - self._base
        return self._buffer[lo:hi]

    def note_confirmed_language(self, language: str) -> None:
        """Gate the English-only preview on what Whisper heard: a confirmed
        utterance in another language switches partials off for this source;
        an English one switches them back on. Empty/unknown leaves it as is."""
        lang = (language or "").strip().lower()
        if not lang:
            return
        self.partials_enabled = lang.startswith("en")

    def write_utterance_wav(self, start: int, end: int) -> Path:
        """Write one utterance to a temp 16-bit mono WAV; caller unlinks."""
        import numpy as np

        lo = max(start - self._base, 0)
        hi = min(end - self._base, len(self._buffer))
        clip = np.clip(self._buffer[lo:hi], -1.0, 1.0)
        pcm = (clip * 32767.0).astype("<i2")
        fd, name = tempfile.mkstemp(suffix=".wav", prefix="mnt_live_utt_")
        import os

        os.close(fd)
        with wave.open(name, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(_SAMPLE_RATE)
            w.writeframes(pcm.tobytes())
        return Path(name)

    def advance(self, watermark: int) -> None:
        """Move the emitted watermark forward and trim consumed audio."""
        self._emitted = max(self._emitted, watermark)
        margin = int(_TRIM_MARGIN_S * _SAMPLE_RATE)
        cut = self._emitted - margin - self._base
        if cut > 0:
            self._buffer = self._buffer[cut:]
            self._base += cut


class MoonshinePartialEngine:
    """English streaming preview: re-decodes the unconfirmed audio tail with
    sherpa-onnx Moonshine v2 (offline model, ~12–50 ms per call on CPU).
    Best-effort — any failure yields an empty string, never an exception."""

    FILES = ("encoder_model.ort", "decoder_model_merged.ort", "tokens.txt")

    def __init__(self, snapshot: Path, num_threads: int = 2) -> None:
        import sherpa_onnx  # lazy: keeps the service importable without it

        self.name = "moonshine-v2-tiny-en"
        self._lock = threading.Lock()
        self._recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine_v2(
            encoder=str(snapshot / "encoder_model.ort"),
            decoder=str(snapshot / "decoder_model_merged.ort"),
            tokens=str(snapshot / "tokens.txt"),
            num_threads=num_threads,
            provider="cpu",
        )

    def decode(self, samples) -> str:
        """Text for one float32 mono 16 kHz clip; only the last
        LIVE_PARTIAL_MAX_S seconds are decoded (see the ORT limit above)."""
        if not len(samples):
            return ""
        clip = samples[-int(LIVE_PARTIAL_MAX_S * _SAMPLE_RATE) :]
        with self._lock:
            try:
                stream = self._recognizer.create_stream()
                stream.accept_waveform(_SAMPLE_RATE, clip)
                self._recognizer.decode_stream(stream)
                return stream.result.text.strip()
            except Exception:
                logger.warning("Live preview decode failed (non-fatal)", exc_info=True)
                return ""
