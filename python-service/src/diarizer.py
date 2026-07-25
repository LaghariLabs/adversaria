"""On-device speaker diarization (sherpa-onnx) for the system-audio channel.

The app captures the local user ("Me", mic) separately from the remote
participants ("Them", system audio), so only the *system-audio* stream needs
diarization — this module splits it into Speaker 1/2/… turns. Models are
downloaded once to a local cache and run fully offline (no HuggingFace gating).
"""

from __future__ import annotations

import logging
import tarfile
import urllib.request
from pathlib import Path

logger = logging.getLogger(__name__)

# sherpa-onnx release assets (~34 MB total, downloaded once on first use).
_SEG_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
# Multilingual (zh + en) speaker-embedding model — better separation on the
# user's English/Arabic meetings than the zh-cn-only model.
_EMB_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/"
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
)

# Clustering threshold: higher = more merging (fewer speakers). On a clean
# 4-speaker reference clip this model keeps all 4 distinct from 0.6–0.7 and only
# starts merging *distinct* speakers at 0.8. Real call audio (short, compressed)
# over-segments a single speaker into several clusters at 0.5, so we sit at the
# top of the safe range (0.7): it merges same-speaker noise while still keeping
# genuinely different speakers apart. Meetings favour under- over over-counting.
_DEFAULT_THRESHOLD = 0.7

_CACHE_DIR = Path.home() / ".cache" / "adversaria" / "diarization"

# Diarization turn: (start_seconds, end_seconds, speaker_index).
Turn = tuple[float, float, int]

# Post-clustering cleanup bounds. Compressed/noisy call audio makes the
# clusterer shave phantom micro-clusters off a real voice ("Speaker 13" in a
# 2-person call): a real participant accumulates at least several seconds of
# speech, and real meetings don't have more than a handful of remote speakers.
# (Tightened 2026-07-03 — 8s/8 still let a demo recording show 8 "speakers".)
_MIN_SPEAKER_SECONDS = 12.0
_MAX_SPEAKERS = 5

# Two clusters whose speaker embeddings are at least this cosine-similar are the
# same voice split by the clusterer (same-speaker pairs typically score ≥0.7 on
# campplus; distinct speakers ≤0.4). Conservative so real speakers never merge.
_SIMILARITY_MERGE_THRESHOLD = 0.60
# Per-speaker audio budget for the merge embedding — longest turns first.
_EMBED_MAX_SECONDS = 20.0

# When intersecting diarization turns with transcribed speech, allow this much
# slack: Whisper segment starts and pyannote turn boundaries disagree slightly.
_VOICED_SLACK_SECONDS = 1.0


def merge_minor_speakers(
    turns: list[Turn],
    min_seconds: float = _MIN_SPEAKER_SECONDS,
    max_speakers: int = _MAX_SPEAKERS,
) -> list[Turn]:
    """Relabel phantom clusters to their temporally nearest real speaker.

    A speaker with under `min_seconds` of total speech is treated as clustering
    noise, and at most `max_speakers` speakers (by speech time) are kept; every
    other turn is reassigned to the nearest kept speaker in time. Pure — no
    models involved — so it is unit-testable.
    """
    if not turns:
        return turns
    totals: dict[int, float] = {}
    for start, end, spk in turns:
        totals[spk] = totals.get(spk, 0.0) + (end - start)
    by_duration = sorted(totals, key=lambda s: totals[s], reverse=True)
    majors = {s for s in by_duration[:max_speakers] if totals[s] >= min_seconds}
    if not majors:
        majors = {by_duration[0]}  # keep the dominant voice at minimum
    major_turns = [t for t in turns if t[2] in majors]

    def nearest_major(start: float, end: float) -> int:
        return min(
            major_turns,
            key=lambda t: max(t[0] - end, start - t[1], 0.0),
        )[2]

    return [
        t if t[2] in majors else (t[0], t[1], nearest_major(t[0], t[1]))
        for t in turns
    ]


def drop_unvoiced_turns(
    turns: list[Turn],
    voiced_starts: list[float],
    slack: float = _VOICED_SLACK_SECONDS,
) -> list[Turn]:
    """Keep only turns that overlap transcribed speech.

    `voiced_starts` are the start times of the segments Whisper actually
    produced text for. The segmentation model marks music/jingles/SFX as
    "speech" too; those regions get clustered into phantom speakers that eat
    the real participants' slots in `merge_minor_speakers`. A turn containing
    no transcribed-segment start (± `slack`) is such a phantom — drop it.
    Fail-open: if nothing survives, return the turns unchanged. Pure.
    """
    if not turns or not voiced_starts:
        return turns
    kept = [
        t
        for t in turns
        if any(t[0] - slack <= s <= t[1] + slack for s in voiced_starts)
    ]
    return kept if kept else turns


def merge_similar_speakers(
    turns: list[Turn],
    embeddings: dict[int, "list[float]"],
    threshold: float = _SIMILARITY_MERGE_THRESHOLD,
) -> list[Turn]:
    """Merge speakers whose voice embeddings are near-identical.

    `merge_minor_speakers` merges by *duration* only, so a single voice split
    into two long clusters (common on synthetic/compressed audio) survives as
    two "speakers". Here each speaker gets one embedding (`embeddings`, speaker
    index → vector; speakers without one are left alone) and clusters at
    ≥ `threshold` cosine similarity are relabeled to the pair's
    longest-speaking speaker. Pure — embeddings are computed by the caller —
    so it is unit-testable.
    """
    if not turns or len(embeddings) < 2:
        return turns
    import math

    totals: dict[int, float] = {}
    for start, end, spk in turns:
        totals[spk] = totals.get(spk, 0.0) + (end - start)

    def cosine(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(x * x for x in b))
        return dot / (na * nb) if na and nb else 0.0

    # Union-find keyed by speaker index; roots resolve to max total duration.
    parent: dict[int, int] = {s: s for s in totals}

    def find(s: int) -> int:
        while parent[s] != s:
            parent[s] = parent[parent[s]]
            s = parent[s]
        return s

    speakers = sorted(embeddings)
    for i, a in enumerate(speakers):
        for b in speakers[i + 1 :]:
            if cosine(embeddings[a], embeddings[b]) >= threshold:
                ra, rb = find(a), find(b)
                if ra != rb:
                    # Longest-speaking speaker of the pair wins the label.
                    winner, loser = (
                        (ra, rb) if totals[ra] >= totals[rb] else (rb, ra)
                    )
                    parent[loser] = winner
    if all(find(s) == s for s in totals):
        return turns
    return [(start, end, find(spk)) for start, end, spk in turns]


_embedding_extractor = None  # lazy singleton (shares the campplus model file)


def _get_embedding_extractor():
    global _embedding_extractor
    if _embedding_extractor is None:
        import sherpa_onnx

        _, emb = _ensure_models()
        _embedding_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(emb))
        )
    return _embedding_extractor


def _speaker_embeddings(
    turns: list[Turn], audio, sample_rate: int
) -> dict[int, list[float]]:
    """One embedding per speaker from up to `_EMBED_MAX_SECONDS` of their
    longest turns. Speakers with under ~1 s of usable audio are skipped."""
    import numpy as np

    extractor = _get_embedding_extractor()
    by_speaker: dict[int, list[Turn]] = {}
    for t in turns:
        by_speaker.setdefault(t[2], []).append(t)

    embeddings: dict[int, list[float]] = {}
    for spk, spk_turns in by_speaker.items():
        chunks = []
        budget = _EMBED_MAX_SECONDS
        for start, end, _ in sorted(spk_turns, key=lambda t: t[1] - t[0], reverse=True):
            if budget <= 0:
                break
            take = min(end - start, budget)
            lo = int(start * sample_rate)
            hi = int((start + take) * sample_rate)
            chunk = audio[lo:hi]
            if len(chunk):
                chunks.append(chunk)
                budget -= take
        if not chunks:
            continue
        samples = np.concatenate(chunks)
        if len(samples) < sample_rate:  # under ~1 s → embedding too unstable
            continue
        stream = extractor.create_stream()
        stream.accept_waveform(sample_rate, samples)
        stream.input_finished()
        embeddings[spk] = extractor.compute(stream)
    return embeddings


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    logger.info("Downloading diarization model → %s", dest.name)
    urllib.request.urlretrieve(url, tmp)
    tmp.rename(dest)


def _ensure_models() -> tuple[Path, Path]:
    """Return (segmentation_model, embedding_model), downloading on first use."""
    seg = _CACHE_DIR / "segmentation.onnx"
    emb = _CACHE_DIR / "campplus_zh_en.onnx"
    if not seg.exists():
        tar = _CACHE_DIR / "seg.tar.bz2"
        _download(_SEG_URL, tar)
        with tarfile.open(tar, "r:bz2") as tf:
            member = next(m for m in tf.getmembers() if m.name.endswith("model.onnx"))
            member.name = "segmentation.onnx"  # flatten out of its folder
            tf.extract(member, _CACHE_DIR)
        tar.unlink(missing_ok=True)
    if not emb.exists():
        _download(_EMB_URL, emb)
    return seg, emb


_diarizer = None  # lazy singleton


def _get_diarizer():
    """Build (once) the sherpa-onnx diarizer; sherpa_onnx is imported lazily so a
    missing/broken dependency degrades to plain 'Them' rather than breaking
    transcription."""
    global _diarizer
    if _diarizer is None:
        import sherpa_onnx

        seg, emb = _ensure_models()
        cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(seg)
                ),
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(emb)),
            clustering=sherpa_onnx.FastClusteringConfig(
                num_clusters=-1, threshold=_DEFAULT_THRESHOLD
            ),
            # 0.5 s drops blips (UI sounds, breaths) that seed phantom clusters.
            min_duration_on=0.5,
            min_duration_off=0.5,
        )
        _diarizer = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    return _diarizer


def diarize(wav_path: str, voiced_starts: list[float] | None = None) -> list[Turn]:
    """Diarize a system-audio WAV. Returns (start, end, speaker) turns sorted by
    start time, or [] if nothing is produced. Raises on a hard failure (callers
    should catch and fall back to 'Them').

    `voiced_starts` (start times of the segments Whisper transcribed) restricts
    clustering to actual speech — turns covering only music/SFX are dropped
    before speaker counting. After the duration cleanup, clusters whose voice
    embeddings match are re-merged (one voice split in two stays one speaker).
    """
    from faster_whisper.audio import decode_audio

    sd = _get_diarizer()
    audio = decode_audio(wav_path, sampling_rate=sd.sample_rate)  # 16k mono float32
    turns = [(t.start, t.end, t.speaker) for t in sd.process(audio).sort_by_start_time()]
    if voiced_starts is not None:
        turns = drop_unvoiced_turns(turns, voiced_starts)
    turns = merge_minor_speakers(turns)
    if len({t[2] for t in turns}) >= 2:
        try:
            embeddings = _speaker_embeddings(turns, audio, sd.sample_rate)
            turns = merge_similar_speakers(turns, embeddings)
        except Exception as exc:  # best-effort refinement — never lose the turns
            logger.warning("Speaker-similarity merge skipped (%s).", exc)
    return turns


def speaker_at(turns: list[Turn], t: float) -> int | None:
    """Speaker index whose turn contains time `t`, else the nearest turn's, or
    None when there are no turns."""
    if not turns:
        return None
    for start, end, spk in turns:
        if start <= t < end:
            return spk
    return min(turns, key=lambda x: abs(x[0] - t))[2]
