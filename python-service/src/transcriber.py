"""Speech-to-text transcription using faster-whisper."""

from __future__ import annotations

import logging
import os
import platform
import re
import site
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - annotations only
    # Import for types only. `faster_whisper` loads ctranslate2's native
    # extension, which is imported lazily in `_create_model` instead — see the
    # note there. `from __future__ import annotations` keeps the runtime clean.
    from faster_whisper import WhisperModel

from .models import TranscriptTurn, TranscribeResponse

logger = logging.getLogger(__name__)

_CUDA_DLL_ERROR_FRAGMENTS = ("cublas", "cudnn", "cufft", "curand", ".dll", "library")

#: A transcribed segment: (start time in seconds, end time in seconds, text).
Segment = tuple[float, float, str]


def _safe_end(start: float, end: float | None) -> float:
    """Return *end*, clamped so it is never less than *start*."""
    if end is None or end < start:
        return start
    return end


# --- On-device Whisper model registry ----------------------------------------
# Curated, HF-verified repos per backend. Friendly key -> repo + display info.
# large-v3 is the default: 99 languages incl. Arabic. The others trade accuracy
# for speed/size.
#
# The KEYS are deliberately shared across backends so a `whisper_model` value in
# config.json still resolves after the same account/settings move between a Mac
# and a Windows box; only the weights differ. MLX weights cannot be loaded by
# CTranslate2 (or vice versa), so the registry MUST be selected by the active
# backend — a Windows build offering `mlx-community/*` would report bogus
# download status and then fetch gigabytes faster-whisper can't open.

#: Apple-Silicon (mlx-whisper) weights. Loaded per call, so switching is just a
#: `model_repo` swap — no restart.
_MLX_WHISPER_MODELS: dict[str, dict] = {
    "large-v3": {
        "repo": "mlx-community/whisper-large-v3-mlx",
        "label": "Large v3 — best accuracy, 99 languages (incl. Arabic)",
        "size": "~3 GB",
    },
    "large-v3-turbo": {
        "repo": "mlx-community/whisper-large-v3-turbo",
        "label": "Large v3 Turbo — faster, near-large quality",
        "size": "~1.6 GB",
    },
    "large-v3-turbo-q4": {
        "repo": "mlx-community/whisper-large-v3-turbo-q4",
        "label": "Large v3 Turbo (4-bit) — smallest & fastest",
        "size": "~0.5 GB",
    },
}

#: CTranslate2 (faster-whisper) weights — Windows, Linux, and Intel Macs.
#: There is no CT2 analogue of the MLX 4-bit build: faster-whisper quantizes at
#: load time via `compute_type`, not by shipping separate weights, so the 4-bit
#: tier is an alias rather than a third entry (see _CT2_KEY_ALIASES).
_CT2_WHISPER_MODELS: dict[str, dict] = {
    "large-v3": {
        "repo": "Systran/faster-whisper-large-v3",
        "label": "Large v3 — best accuracy, 99 languages (incl. Arabic)",
        "size": "~3 GB",
    },
    "large-v3-turbo": {
        "repo": "deepdml/faster-whisper-large-v3-turbo-ct2",
        "label": "Large v3 Turbo — faster, near-large quality",
        "size": "~1.6 GB",
    },
}

#: Keys the CT2 registry does not carry, mapped to their nearest equivalent so a
#: config written on a Mac resolves to a sensible model instead of silently
#: snapping back to the (much larger) default.
_CT2_KEY_ALIASES: dict[str, str] = {"large-v3-turbo-q4": "large-v3-turbo"}

DEFAULT_WHISPER_MODEL = "large-v3"


def default_whisper_key() -> str:
    """The default model key for the active backend.

    CTranslate2 machines (Windows, Linux, Intel Macs) mostly run Whisper on
    CPU int8, where large-v3 is both a ~3 GB download and painfully slow —
    turbo is ~1.6 GB at near-large quality and several times faster (decided
    2026-07-31, SETUP_REDESIGN_SPEC V3). Apple-Silicon keeps large-v3: the GPU
    absorbs it, and changing the default would re-download for existing users.
    """
    return DEFAULT_WHISPER_MODEL if backend_is_mlx() else "large-v3-turbo"


def backend_is_mlx() -> bool:
    """True when transcription runs on mlx-whisper.

    Mirrors :func:`create_transcriber`'s selection so the registry and the loaded
    model never disagree. Read at call time, not import time, so the env var is
    honoured by tests and by a service started with an explicit backend.

    Note: `create_transcriber` also falls back to faster-whisper if MLX fails to
    initialise on an Apple-Silicon Mac. That case is rare enough (a broken MLX
    install) that the registry keeps reporting MLX rather than probing the import.
    """
    backend = os.environ.get("WHISPER_BACKEND", "auto").strip().lower()
    if backend == "mlx":
        return True
    if backend == "faster-whisper":
        return False
    return sys.platform == "darwin" and platform.machine() == "arm64"


def active_whisper_models() -> dict[str, dict]:
    """The curated model registry for this machine's transcription backend."""
    return _MLX_WHISPER_MODELS if backend_is_mlx() else _CT2_WHISPER_MODELS


def whisper_repo_for(key: str | None) -> str:
    """Map a friendly model key to the HF repo for the active backend.

    Unknown keys fall back to the default model, so a corrupt or future config
    value degrades to "best accuracy" rather than failing the transcription.
    """
    models = active_whisper_models()
    name = (key or "").strip()
    if name not in models:
        name = _CT2_KEY_ALIASES.get(name, "") if not backend_is_mlx() else ""
    entry = models.get(name) or models[default_whisper_key()]
    return entry["repo"]


def _hf_cache_root() -> Path:
    try:
        from huggingface_hub.constants import HF_HUB_CACHE

        return Path(HF_HUB_CACHE)
    except Exception:
        hf_home = os.environ.get("HF_HOME") or os.path.join(
            os.path.expanduser("~"), ".cache", "huggingface"
        )
        return Path(hf_home) / "hub"


#: Weight files that prove a whisper snapshot is actually usable, per backend:
#: CT2 ships `model.bin`, MLX ships `weights.npz` (older) or `.safetensors`.
_WEIGHT_NAMES = ("model.bin", "weights.npz")
_WEIGHT_SUFFIXES = (".safetensors", ".gguf")


def whisper_model_is_cached(repo: str) -> bool:
    """True if a COMPLETE HF snapshot for `repo` is on disk.

    huggingface_hub links each file into `snapshots/<rev>/` the moment that
    file finishes, so config.json appears seconds into a multi-GB download —
    a non-empty snapshot directory is NOT "downloaded". V3 gates transcriber
    init, the ready state, and MLX's call-time fetch on this predicate, so a
    partial or interrupted download must read as absent (the state stays
    "missing" while the pinned download runs), never as ready — which made
    MLX fetch unpinned weights mid-transcription — nor as a load error.
    """
    snap = _hf_cache_root() / ("models--" + repo.replace("/", "--")) / "snapshots"
    if not snap.is_dir():
        return False
    for revision in snap.iterdir():
        if not revision.is_dir():
            continue
        for file in revision.iterdir():
            if file.name in _WEIGHT_NAMES or file.name.endswith(_WEIGHT_SUFFIXES):
                return True
    return False


def list_whisper_models() -> list[dict]:
    """Curated on-device models with download status, for the Settings picker."""
    return [
        {
            "key": key,
            "label": entry["label"],
            "size": entry["size"],
            "downloaded": whisper_model_is_cached(entry["repo"]),
        }
        for key, entry in active_whisper_models().items()
    ]


def download_whisper_model(key: str) -> None:
    """Proactively fetch a model's HF snapshot so it's ready before recording."""
    from huggingface_hub import snapshot_download

    snapshot_download(whisper_repo_for(key))


def build_labeled_turns(
    system_segments: list[Segment],
    mic_segments: list[Segment],
    system_labels: list[str] | None = None,
) -> list[TranscriptTurn]:
    """Interleave two segment streams into speaker-coalesced turns with timing.

    Same coalescing logic as :func:`merge_labeled_segments` but returns
    structured :class:`TranscriptTurn` objects instead of flat text.  Each
    turn's ``start`` is the first joined segment's start, ``end`` is the max
    end across the joined segments, ``speaker`` is the label, and ``text`` is
    the whitespace-joined segment text.
    """
    if system_labels is not None:
        labeled: list[tuple[float, float, str, str]] = [
            (start, end, label, text)
            for (start, end, text), label in zip(system_segments, system_labels)
        ]
    else:
        labeled = [(start, end, "Them", text) for start, end, text in system_segments]
    labeled += [(start, end, "Me", text) for start, end, text in mic_segments]
    labeled.sort(key=lambda item: item[0])

    turns: list[TranscriptTurn] = []
    current_speaker: str | None = None
    current_parts: list[str] = []
    current_start: float = 0.0
    current_end: float = 0.0
    for start, end, speaker, text in labeled:
        cleaned = text.strip()
        if not cleaned:
            continue
        if speaker != current_speaker:
            if current_parts:
                turns.append(
                    TranscriptTurn(
                        speaker=current_speaker,
                        text=" ".join(current_parts),
                        start=current_start,
                        end=current_end,
                    )
                )
                current_parts = []
            current_speaker = speaker
            current_start = start
            current_end = end
        else:
            current_end = max(current_end, end)
        current_parts.append(cleaned)
    if current_parts:
        turns.append(
            TranscriptTurn(
                speaker=current_speaker,
                text=" ".join(current_parts),
                start=current_start,
                end=current_end,
            )
        )
    return turns


def merge_labeled_segments(
    system_segments: list[Segment],
    mic_segments: list[Segment],
    system_labels: list[str] | None = None,
) -> str:
    """Interleave two segment streams into a speaker-labeled transcript.

    Delegates to :func:`build_labeled_turns` and renders the flat text from
    the turns, guaranteeing the flat output is always identical to what the
    turns describe.

    `system_labels`, when given, is a per-segment label for the system side
    (e.g. "Speaker 1"/"Speaker 2" from diarization) used instead of a flat
    "Them"; it must be the same length as `system_segments`.
    """
    turns = build_labeled_turns(system_segments, mic_segments, system_labels)
    return "\n".join(f"{t.speaker}: {t.text}" for t in turns)


def build_single_file_turns(segments: list[Segment]) -> list[TranscriptTurn]:
    """Build one :class:`TranscriptTurn` per segment, all labeled "Them".

    For single-file (unlabeled) import transcripts.  The flat text for these
    transcripts is space-joined turn texts (no labels).
    """
    return [
        TranscriptTurn(speaker="Them", text=text.strip(), start=start, end=end)
        for start, end, text in segments
        if text.strip()
    ]


def playback_hint(
    system_segments: list[Segment],
    mic_segments: list[Segment],
) -> str | None:
    """Category verdict computed BEFORE mic bleed is stripped, or None.

    Mic bleed (the speakers echoing into the microphone) is the strongest
    signal that the user was WATCHING something rather than meeting — and
    `strip_mic_bleed` deliberately removes it from the stored transcript, which
    can leave the survivors looking meeting-like (a real recording scored
    containment 0.79 post-strip vs ≥0.9 pre-strip). So the classifier runs
    here, on the raw channels, and the verdict travels with the response.
    """
    if not system_segments or not mic_segments:
        return None
    try:
        from .summarizer import classify_category

        flat = merge_labeled_segments(system_segments, mic_segments)
        if classify_category(flat) == "youtube":
            return "youtube"
    except Exception:  # the hint is best-effort — never break transcription
        pass
    return None


# Mic-bleed dedupe: a mic segment that is a near-verbatim copy of a system
# segment close in time is the speakers bleeding into the microphone, not the
# user talking. Left in, those lines get labeled "Me"/the user's name — a
# watched video then reads as the USER saying the video's words.
_BLEED_SIMILARITY = 0.85  # SequenceMatcher ratio on normalized text
_BLEED_WINDOW_SECONDS = 10.0  # bleed lands within seconds of the source
_BLEED_MIN_WORDS = 3  # short interjections ("yeah", "okay") can't be matched reliably
_BLEED_CONTAINMENT = 0.8  # fraction of mic tokens present in the system text
# Segment-to-segment matching alone misses the common case: the two channels are
# transcribed independently, so Whisper chunks them at DIFFERENT boundaries and a
# mic segment straddles two system segments. Meeting 221 (2026-08-04) was 20/20
# bleed reported as a two-person meeting — every mic line scored only 0.14-0.57
# against any single system segment while being 100% contained in the channel as
# a whole. So also compare against the system text JOINED across the time window.
# Bigrams, not words: genuine speech on the same subject reuses the other
# channel's vocabulary but not its word ORDER. Measured on that transcript —
# real bleed 0.87-1.00 (median 1.00), genuine same-topic speech 0.12-0.38 — so
# 0.70 sits clear of both by a wide margin.
_BLEED_WINDOW_BIGRAM_CONTAINMENT = 0.70
_BLEED_WINDOW_MIN_WORDS = 6  # below this there are too few bigrams to judge

# Glossary-echo gate: Whisper sometimes "transcribes" the vocabulary
# initial_prompt back into the output — shuffled and repeated — even over
# voiced audio, where the VAD gate can't help. A segment that is mostly MADE OF
# glossary tokens is an echo, not speech; a sentence that merely mentions one
# term is not.
_ECHO_MIN_TOKENS = 4  # never drop very short segments outright
_ECHO_GLOSSARY_FRACTION = 0.8  # >= this fraction of tokens must be glossary tokens
_ECHO_MIN_DISTINCT_TERMS = 2  # and >= this many distinct vocabulary terms present
_ECHO_PREFIX_RUN = 3  # leading run of glossary tokens to strip off a mixed segment


def _token_containment(candidate_tokens: list[str], system_tokens: list[str]) -> float:
    """Fraction of candidate tokens present in system tokens, multiset-aware."""
    from collections import Counter

    if not candidate_tokens:
        return 0.0
    cand = Counter(candidate_tokens)
    sysc = Counter(system_tokens)
    return sum((cand & sysc).values()) / len(candidate_tokens)


def _bigram_containment(candidate: str, reference: str) -> float:
    """Fraction of the candidate's word PAIRS that also occur in reference.

    Word pairs rather than words because the two channels talk about the same
    subject: unigram overlap is high for genuine speech too ("meeting",
    "accuracy"), while sharing word ORDER at scale means one channel is echoing
    the other. Multiset-aware, so a repeated pair must be repeated in reference.
    """
    from collections import Counter

    def pairs(text: str) -> list[str]:
        words = text.split()
        return [f"{words[i]} {words[i + 1]}" for i in range(len(words) - 1)]

    candidate_pairs = pairs(candidate)
    if not candidate_pairs:
        return 0.0
    overlap = Counter(candidate_pairs) & Counter(pairs(reference))
    return sum(overlap.values()) / len(candidate_pairs)


def strip_mic_bleed(
    system_segments: list[Segment],
    mic_segments: list[Segment],
) -> list[Segment]:
    """Drop mic segments that duplicate a temporally-close system segment.

    Matches by ordered similarity (SequenceMatcher >= 0.85) or by token
    containment (>= 0.8 of mic tokens found in system tokens, multiset-aware;
    3-word candidates require perfect containment). Keeps genuine user speech
    (it never appears on the system channel) and segments too short to match
    reliably. Pure — unit-testable.
    """
    if not system_segments or not mic_segments:
        return mic_segments
    from difflib import SequenceMatcher

    def norm(text: str) -> str:
        return " ".join("".join(c for c in text.lower() if c.isalnum() or c.isspace()).split())

    normalized_system = [(start, norm(text)) for start, _end, text in system_segments]

    kept: list[Segment] = []
    for start, end, text in mic_segments:
        candidate = norm(text)
        candidate_tokens = candidate.split()
        num_words = len(candidate_tokens)
        # Boundary-independent pass: the system channel as one span of text
        # around this segment, so a mic line straddling two system segments is
        # still recognised as the echo it is.
        if num_words >= _BLEED_WINDOW_MIN_WORDS:
            window = " ".join(
                sys_text
                for sys_start, sys_text in normalized_system
                if abs(start - sys_start) <= _BLEED_WINDOW_SECONDS
            )
            if (
                _bigram_containment(candidate, window)
                >= _BLEED_WINDOW_BIGRAM_CONTAINMENT
            ):
                continue
        if num_words >= _BLEED_MIN_WORDS and any(
            abs(start - sys_start) <= _BLEED_WINDOW_SECONDS
            and (
                SequenceMatcher(None, candidate, sys_text).ratio() >= _BLEED_SIMILARITY
                or (
                    num_words >= 4
                    and _token_containment(candidate_tokens, sys_text.split()) >= _BLEED_CONTAINMENT
                )
                or (
                    num_words == 3
                    and _token_containment(candidate_tokens, sys_text.split()) == 1.0
                )
            )
            for sys_start, sys_text in normalized_system
        ):
            continue  # bleed — the system channel already carries this line
        kept.append((start, end, text))
    if len(kept) < len(mic_segments):
        logger.info(
            "Mic bleed: dropped %d of %d mic segments duplicating system audio.",
            len(mic_segments) - len(kept),
            len(mic_segments),
        )
    return kept


def _glossary_terms(initial_prompt: str | None) -> list[str]:
    """Parse the vocabulary terms out of the "Glossary: a, b, c" prompt."""
    if not initial_prompt:
        return []
    text = initial_prompt.split(":", 1)[1] if ":" in initial_prompt else initial_prompt
    return [t.strip() for t in text.split(",") if t.strip()]


def strip_glossary_echo(
    segments: list[Segment], initial_prompt: str | None
) -> list[Segment]:
    """Drop/trim segments that are the vocabulary prompt echoed back as text.

    Order- and repetition-independent: works on shuffled echoes. Keeps real
    speech that merely mentions a term. Pure — unit-testable.
    """
    terms = _glossary_terms(initial_prompt)
    if not terms:
        return segments

    def norm(text: str) -> str:
        return " ".join(
            "".join(c for c in text.lower() if c.isalnum() or c.isspace()).split()
        )

    # Build glossary token set and per-term token lists.
    glossary_tokens: set[str] = {"glossary"}
    term_token_lists: list[list[str]] = []
    for term in terms:
        tokens = norm(term).split()
        glossary_tokens.update(tokens)
        term_token_lists.append(tokens)

    def _term_present(seg_tokens: list[str], term_tokens: list[str]) -> bool:
        """True if term_tokens appears as a contiguous subsequence in seg_tokens."""
        if not term_tokens:
            return False
        for i in range(len(seg_tokens) - len(term_tokens) + 1):
            if seg_tokens[i : i + len(term_tokens)] == term_tokens:
                return True
        return False

    kept: list[Segment] = []
    dropped = 0
    trimmed = 0
    for start, end, text in segments:
        tokens = norm(text).split()
        if not tokens:
            kept.append((start, end, text))
            continue

        glossary_count = sum(1 for t in tokens if t in glossary_tokens)
        fraction = glossary_count / len(tokens)
        distinct_terms = sum(
            1 for tl in term_token_lists if _term_present(tokens, tl)
        )

        # Drop rule: mostly glossary tokens, with multiple distinct terms.
        if (
            len(tokens) >= _ECHO_MIN_TOKENS
            and fraction >= _ECHO_GLOSSARY_FRACTION
            and distinct_terms >= _ECHO_MIN_DISTINCT_TERMS
        ):
            dropped += 1
            continue

        # Prefix-trim rule: strip a leading run of glossary tokens.
        leading_run = 0
        for t in tokens:
            if t in glossary_tokens:
                leading_run += 1
            else:
                break

        if leading_run >= _ECHO_PREFIX_RUN:
            leading_tokens = tokens[:leading_run]
            if any(
                _term_present(leading_tokens, tl) for tl in term_token_lists
            ):
                words = text.split()
                trimmed_text = " ".join(words[leading_run:]).lstrip()
                if not trimmed_text:
                    dropped += 1
                    continue
                trimmed += 1
                kept.append((start, end, trimmed_text))
                continue

        kept.append((start, end, text))

    if dropped or trimmed:
        logger.info(
            "Glossary echo: dropped %d and trimmed %d of %d segments.",
            dropped,
            trimmed,
            len(segments),
        )
    return kept


# Vocabulary near-miss correction: the initial_prompt only BIASES Whisper toward
# the vocabulary — with "adversaria" in the custom vocabulary it still produced
# "Adverse Area" (meetings 217-219, 2026-08-02) minutes after take 216 got it
# right. This deterministic post-pass rewrites word windows that are near-misses
# of a vocabulary term to the user's term, verbatim.
# Calibration (SequenceMatcher.ratio, normalized window vs "adversaria"):
#   "adverse area" -> 0.8571, len diff 1   (the live miss — MUST correct)
#   "adverse"      -> 0.7059, len diff 3   (real word — must NEVER correct)
#   "tatveer os" vs "tatweer os" -> 0.8889 (typical multi-word near-miss)
# Threshold 0.80 keeps >= 0.02 margin on both contract sides (0.8571 - 0.80 =
# 0.0571 above; 0.80 - 0.7059 = 0.0941 below). Known tradeoff: with
# "Adversaria" in the vocabulary the real words "adversary" (0.8421) and
# "adversarial" (0.9524) would also be corrected — accepted, because the user
# adding the brand name to the vocabulary makes it the far likelier intent.
_VOCAB_FUZZY_MIN_CHARS = 6  # fuzzy only for terms with >= this many normalized chars
_VOCAB_FUZZY_RATIO = 0.80  # SequenceMatcher.ratio() floor on normalized text
_VOCAB_FUZZY_MAX_LEN_DIFF = 2  # normalized length difference bound


def apply_vocabulary_corrections(
    segments: list[Segment], initial_prompt: str | None
) -> list[Segment]:
    """Rewrite near-miss transcriptions of vocabulary terms to the term verbatim.

    Scans each segment with sliding word-windows of 1..(term word count + 1)
    words; a window is a near-miss when the normalized (lowercase, alphanumeric
    only) window and term have SequenceMatcher.ratio() >= _VOCAB_FUZZY_RATIO,
    bounded length difference, and the same first character. Exact matches
    (case-insensitive, with a possessive 's peeled off and preserved) always
    win over fuzzy ones, at every window size, so correct text never loses a
    short neighbor word to a greedy fuzzy window. Cased entries rewrite exact
    matches to the entry's casing; an all-lowercase entry carries no casing
    signal and never downgrades correct text (its fuzzy replacements mirror the
    window's sentence capital instead). Fuzzy matching is skipped for terms
    under _VOCAB_FUZZY_MIN_CHARS normalized chars ("Hira" must not attract
    "Hera"). Longest terms first; replaced text is never re-scanned;
    idempotent. Pure — unit-testable.
    """
    terms = _glossary_terms(initial_prompt)
    if not terms or not segments:
        return segments
    from difflib import SequenceMatcher

    def norm(text: str) -> str:
        return "".join(c for c in text.lower() if c.isalnum())

    # Longest normalized term first so multi-word terms claim windows before a
    # shorter term can.
    prepared = sorted(
        ((term, norm(term), len(term.split())) for term in terms),
        key=lambda t: len(t[1]),
        reverse=True,
    )
    prepared = [(t, n, wc) for t, n, wc in prepared if n]
    if not prepared:
        return segments

    corrected = 0

    def correct(text: str) -> str:
        nonlocal corrected
        words = list(re.finditer(r"\S+", text))
        out: list[str] = []
        cursor = 0  # next un-emitted character position in text
        i = 0

        def window_parts(size: int) -> tuple[str, str, str, str]:
            """Split a window into (punct prefix, core, possessive tail, punct
            suffix) so "(Adversaria's)," keeps everything but the core intact."""
            window = text[words[i].start() : words[i + size - 1].end()]
            k = 0
            while k < len(window) and not window[k].isalnum():
                k += 1
            m = len(window)
            while m > 0 and not window[m - 1].isalnum():
                m -= 1
            core = window[k:m]
            tail = ""
            if core[-2:] in ("'s", "’s"):
                core, tail = core[:-2], core[-2:]
            return window[:k], core, tail, window[m:]

        def find_match() -> tuple[int, str] | None:
            avail = len(words) - i
            # Exact matches (case-insensitive, possessive-aware) win over fuzzy
            # across ALL window sizes, so a correct transcription can never lose
            # its short neighbor to a greedy fuzzy window: "Adversaria is"
            # resolves to the exact 1-word window and "is" survives, where the
            # 2-word fuzzy window (len diff 2, ratio 0.909) would swallow it.
            for term, term_norm, term_wc in prepared:
                for size in range(min(term_wc + 1, avail), 0, -1):
                    prefix, core, tail, suffix = window_parts(size)
                    if not core or norm(core) != term_norm:
                        continue
                    if term == term.lower():
                        # An all-lowercase vocabulary entry carries no casing
                        # signal — never downgrade already-correct text. Still
                        # claim the window so fuzzy can't touch it.
                        return size, text[words[i].start() : words[i + size - 1].end()]
                    return size, prefix + term + tail + suffix
            for term, term_norm, term_wc in prepared:
                if len(term_norm) < _VOCAB_FUZZY_MIN_CHARS:
                    continue
                # The term's natural window shape first, then the mis-split
                # shape (+1 word), then smaller merges — so "Adversario is"
                # corrects the 1-word near-miss without swallowing "is".
                sizes = [term_wc, term_wc + 1] + list(range(term_wc - 1, 0, -1))
                for size in (s for s in sizes if 1 <= s <= avail):
                    prefix, core, tail, suffix = window_parts(size)
                    core_norm = norm(core)
                    if (
                        core_norm
                        and core_norm != term_norm
                        and abs(len(core_norm) - len(term_norm))
                        <= _VOCAB_FUZZY_MAX_LEN_DIFF
                        and core_norm[0] == term_norm[0]
                        and SequenceMatcher(None, core_norm, term_norm).ratio()
                        >= _VOCAB_FUZZY_RATIO
                    ):
                        fixed = term
                        if term == term.lower() and core[:1].isupper():
                            # Lowercase entry: mirror the window's sentence
                            # capital instead of imposing lowercase.
                            fixed = term[:1].upper() + term[1:]
                        return size, prefix + fixed + tail + suffix
            return None

        while i < len(words):
            match = find_match()
            if match:
                size, replacement = match
                original = text[words[i].start() : words[i + size - 1].end()]
                if replacement != original:
                    corrected += 1
                out.append(text[cursor : words[i].start()])
                out.append(replacement)
                cursor = words[i + size - 1].end()
                i += size  # never re-scan replaced text
            else:
                i += 1
        out.append(text[cursor:])
        return "".join(out)

    result = [(start, end, correct(text)) for start, end, text in segments]
    if corrected:
        logger.info(
            "Vocabulary: corrected %d near-miss term(s) across %d segments.",
            corrected,
            len(segments),
        )
    return result


# Hallucination gate: Whisper (especially the MLX backend, which has NO built-in
# VAD) invents text on a near-silent mic track — "thank you for watching",
# repetition loops ("God of God of God…") — when the user is mostly listening.
# Those fake lines get labeled as the user and inflate their talk-time /
# interruptions in Insights, pollute the transcript, and skew summaries. Silero
# VAD marks where the mic ACTUALLY carries voice; we drop mic segments that don't
# overlap real speech. (Genuine bleed of others' clean speech IS voice, so it
# survives this gate — strip_mic_bleed handles that separately.)
_MIC_VOICE_MIN_OVERLAP_S = 0.5  # a real utterance carries at least this much voiced audio


def _voiced_regions(audio_path: str) -> list[tuple[float, float]] | None:
    """Silero-VAD voiced [start, end] spans (seconds) over an audio file. Returns
    None when VAD is unavailable/fails, so the caller can fail open (keep all)."""
    try:
        from faster_whisper.audio import decode_audio
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        audio = decode_audio(audio_path, sampling_rate=16000)
        ts = get_speech_timestamps(audio, VadOptions(), sampling_rate=16000)
        return [(t["start"] / 16000, t["end"] / 16000) for t in ts]
    except Exception:
        logger.exception("Mic VAD failed (non-fatal) — keeping all mic segments.")
        return None


def keep_voiced_segments(
    mic_segments: list[Segment],
    voiced: list[tuple[float, float]],
    min_overlap: float = _MIC_VOICE_MIN_OVERLAP_S,
) -> list[Segment]:
    """Keep only mic segments overlapping a voiced span by >= min_overlap seconds.
    Pure — unit-testable. An empty `voiced` (no speech anywhere) drops everything,
    which is correct: a silent mic track is all hallucination."""
    kept: list[Segment] = []
    for start, end, text in mic_segments:
        overlap = sum(max(0.0, min(end, ve) - max(start, vs)) for vs, ve in voiced)
        if overlap >= min_overlap:
            kept.append((start, end, text))
    return kept


def drop_unvoiced_segments(
    segments: list[Segment], audio_path: str, channel: str = "mic"
) -> list[Segment]:
    """Drop segments with no real voice — Whisper hallucinations on silent audio
    (invented filler, or the vocabulary `initial_prompt` echoed back as a
    "transcription"). Applies to BOTH channels: a silent mic invents talk-time,
    a silent system track echoes the vocabulary. Best-effort: if VAD can't run,
    keep everything (previous behavior)."""
    if not segments or not Path(audio_path).exists():
        return segments
    voiced = _voiced_regions(audio_path)
    if voiced is None:
        return segments  # VAD unavailable — fail open
    kept = keep_voiced_segments(segments, voiced)
    if len(kept) < len(segments):
        logger.info(
            "%s VAD: dropped %d of %d segments with no real voice (hallucinations).",
            channel,
            len(segments) - len(kept),
            len(segments),
        )
    return kept


def diarize_system_labels(
    audio_path: str,
    system_segments: list[Segment],
    enabled: bool,
    mic_segments: list[Segment] | None = None,
) -> list[str] | None:
    """Per-segment speaker labels ("Speaker 1"/"Speaker 2"/…) for the system-audio
    side, via on-device diarization of `audio_path`. Returns None — meaning "use a
    flat 'Them'" — when disabled, when there are no segments, when only one speaker
    is found, when the recording looks like media playback, or on any diarization
    failure (best-effort; never breaks transcription).
    """
    if not enabled or not system_segments:
        return None
    # Media gate: a watched video/demo plays TTS and media voices through the
    # system channel — genuinely different voices, but not meeting participants;
    # splitting them into "Speaker N" is how a demo recording grows 8 phantom
    # speakers. classify_category's mic-bleed + ratio heuristic already detects
    # "the user is listening to playback" — skip diarization entirely for those.
    if mic_segments is not None:
        try:
            from .summarizer import classify_category

            flat = merge_labeled_segments(system_segments, mic_segments)
            if classify_category(flat) == "youtube":
                logger.info("Playback-like recording — skipping diarization.")
                return None
        except Exception:  # the gate is best-effort; never block diarization
            pass
    try:
        from . import diarizer

        turns = diarizer.diarize(
            audio_path, voiced_starts=[start for start, _, _ in system_segments]
        )
        if not turns:
            return None
        # Map raw (sparse) speaker ids → contiguous 1..N in first-appearance order.
        order: dict[int, int] = {}
        labels: list[str] = []
        for start, _, _ in system_segments:
            raw = diarizer.speaker_at(turns, start)
            if raw is None:
                labels.append("Them")
                continue
            if raw not in order:
                order[raw] = len(order) + 1
            labels.append(f"Speaker {order[raw]}")
        # A single detected speaker reads better as plain "Them".
        if len(order) <= 1:
            return None
        return labels
    except Exception as exc:  # never let diarization break transcription
        logger.warning(
            "Diarization failed (%s) — labeling system audio as 'Them'.", exc
        )
        return None


# Cloud /audio/transcriptions caps the upload size (Groq: 25 MB free tier,
# 100 MB dev). Raw capture is huge — the macOS system channel is 48 kHz / 2ch /
# 32-bit ≈ 23 MB *per minute* — so we always downsample to 16 kHz mono (Whisper's
# native rate; lossless for ASR and Groq's own recommended preprocessing) and
# split into chunks that stay under the cap. 24 MB is the free-tier bound with
# margin; raise CLOUD_MAX_UPLOAD_BYTES for the dev tier.
_CLOUD_MAX_UPLOAD_BYTES = int(
    os.environ.get("CLOUD_MAX_UPLOAD_BYTES", str(24 * 1024 * 1024))
)
_CLOUD_TARGET_RATE = 16000  # Hz, mono


def _decode_to_mono16k(path: str):
    """Decode any audio file (incl. 48 kHz stereo 32-bit-float WAV) to a mono
    16 kHz int16 numpy array via PyAV.

    PyAV bundles its own ffmpeg libraries, so this works inside the frozen
    sidecar where a system ``ffmpeg`` binary may be absent from the GUI app's
    PATH (a packaged macOS app does not inherit the shell PATH).
    """
    import av
    import numpy as np

    resampler = av.AudioResampler(format="s16", layout="mono", rate=_CLOUD_TARGET_RATE)
    blocks: list = []
    with av.open(path) as container:
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            for rs in resampler.resample(frame):
                blocks.append(rs.to_ndarray().reshape(-1))
        for rs in resampler.resample(None):  # flush the resampler
            blocks.append(rs.to_ndarray().reshape(-1))
    if not blocks:
        return np.zeros(0, dtype=np.int16)
    return np.concatenate(blocks).astype(np.int16)


def decode_import_file(path: str) -> Path:
    """Decode any audio file (m4a/mp3/wav) to a temporary 16 kHz mono WAV.

    Uses the in-process PyAV decoder (no system ffmpeg). Returns the path to
    the temp WAV, which the caller must delete after use. Raises ValueError on
    decode failure.
    """
    samples = _decode_to_mono16k(path)
    if samples.size == 0:
        raise ValueError(
            f"Could not decode audio from {path} — file may be "
            f"corrupted or in an unsupported codec."
        )
    import wave

    # mkstemp (fd closed immediately), NOT NamedTemporaryFile: the latter keeps
    # its own handle open, which leaked the fd and — on Windows — makes the
    # second open by wave.open fail with PermissionError.
    fd, name = tempfile.mkstemp(suffix=".wav", prefix="mnt_import_")
    os.close(fd)
    with wave.open(name, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(_CLOUD_TARGET_RATE)
        w.writeframes(samples.tobytes())
    return Path(name)


def _write_wav_chunks(
    samples, stem: str, out_dir: str, limit_bytes: int
) -> list[tuple[str, float]]:
    """Write mono-16k int16 ``samples`` as one or more 16 kHz mono WAV files, each
    safely under ``limit_bytes``; return ``(path, start_offset_seconds)`` per file.

    Uses the stdlib ``wave`` writer (no extra deps). The chunk length is sized
    from the raw PCM byte rate, so each uncompressed WAV is guaranteed under the
    cap. Short audio yields a single chunk at offset 0.
    """
    import wave

    # 16 kHz mono 16-bit = 2 bytes/sample; keep a margin under the cap.
    max_samples = max(_CLOUD_TARGET_RATE, int((limit_bytes * 0.9) // 2))
    chunks: list[tuple[str, float]] = []
    total = len(samples)
    start = 0
    idx = 0
    while start < total:
        end = min(start + max_samples, total)
        cpath = os.path.join(out_dir, f"{stem}_{idx:03d}.wav")
        with wave.open(cpath, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(_CLOUD_TARGET_RATE)
            w.writeframes(samples[start:end].tobytes())
        chunks.append((cpath, start / _CLOUD_TARGET_RATE))
        start = end
        idx += 1
    return chunks


def transcribe_cloud(
    audio_path: str,
    mic_audio_path: str | None,
    base_url: str,
    api_key: str,
    model: str,
) -> TranscribeResponse:
    """Transcribe via an OpenAI-compatible cloud endpoint (e.g. Groq) instead of
    local Whisper — for users without the hardware to transcribe on-device.

    Each channel is downsampled to 16 kHz mono, split into chunks under the
    provider's upload cap (so long meetings don't 413), uploaded to
    ``{base_url}/audio/transcriptions`` with ``response_format=verbose_json``,
    and the per-chunk timestamped segments (offset back to the full-recording
    timeline) are merged into a "Me"/"Them" transcript. NOTE: there is no
    on-device diarization in cloud mode (the system side is a flat "Them"), and
    the audio leaves the device — this is the non-sovereign path, surfaced as
    such in the UI.
    """
    import httpx

    url = base_url.rstrip("/") + "/audio/transcriptions"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def _upload(path: str) -> list[Segment]:
        with open(path, "rb") as fh:
            resp = httpx.post(
                url,
                headers=headers,
                files={"file": (Path(path).name, fh, "audio/wav")},
                data={"model": model, "response_format": "verbose_json"},
                timeout=300.0,
            )
        resp.raise_for_status()
        body = resp.json()
        segs: list[Segment] = []
        for s in body.get("segments", []):
            text = (s.get("text") or "").strip()
            if not text:
                continue
            start = float(s.get("start", 0.0))
            end = _safe_end(start, s.get("end"))
            segs.append((start, end, text))
        if not segs and (body.get("text") or "").strip():
            segs = [(0.0, 0.0, body["text"].strip())]
        return segs

    def _channel(path: str) -> tuple[list[Segment], float]:
        samples = _decode_to_mono16k(path)
        if samples.size == 0:
            return [], 0.0
        stem = Path(path).stem
        segs: list[Segment] = []
        with tempfile.TemporaryDirectory() as td:
            for cpath, offset in _write_wav_chunks(
                samples, stem, td, _CLOUD_MAX_UPLOAD_BYTES
            ):
                segs.extend((start + offset, end + offset, txt) for start, end, txt in _upload(cpath))
        return segs, len(samples) / _CLOUD_TARGET_RATE

    system_segments, duration = _channel(audio_path)
    mic_segments: list[Segment] = []
    if mic_audio_path and Path(mic_audio_path).exists():
        try:
            mic_segments, _ = _channel(mic_audio_path)
        except Exception as exc:  # mic is best-effort, never break the meeting
            logger.warning("Cloud mic transcription failed (%s); system audio only.", exc)

    turns = build_labeled_turns(system_segments, mic_segments)
    text = "\n".join(f"{t.speaker}: {t.text}" for t in turns)
    return TranscribeResponse(text=text, language="", duration_seconds=duration, turns=turns)


def relabel_me(text: str, me_label: str | None) -> str:
    """Rewrite line-leading "Me:" labels to the user's name.

    `merge_labeled_segments` emits lines like "Me: ..." and "Them: ...". When the
    user has set a display name, swap "Me" for it so the transcript — and the
    notes derived from it — attribute their lines by name. Blank/None is a no-op.
    """
    if not me_label or not me_label.strip():
        return text
    # A replacement FUNCTION, not a string: re.sub replacement strings process
    # escapes, so a name containing a backslash (pasted "Domain\User") raised
    # re.error and 500'd the whole transcription.
    label = f"{me_label.strip()}:"
    return re.sub(r"(?m)^Me:", lambda _: label, text)


def relabel_turns(turns: list[TranscriptTurn], me_label: str | None) -> list[TranscriptTurn]:
    """Rewrite ``speaker="Me"`` to the user's display name.

    Kept in sync with :func:`relabel_me` so turn speakers and flat text never
    disagree. Blank/None is a no-op.
    """
    if not me_label or not me_label.strip():
        return turns
    name = me_label.strip()
    return [
        TranscriptTurn(
            speaker=name if t.speaker == "Me" else t.speaker,
            text=t.text,
            start=t.start,
            end=t.end,
        )
        for t in turns
    ]


class WhisperTranscriber:
    """Transcribes audio files to text using faster-whisper.

    Supports both file-path-based and raw-bytes-based transcription.
    The whisper model is loaded once at initialization and reused.

    Defaults can be overridden with environment variables:
    WHISPER_MODEL, WHISPER_DEVICE ('auto', 'cuda', 'cpu'), WHISPER_COMPUTE_TYPE.
    """

    def __init__(
        self,
        model_size: str | None = None,
        device: str | None = None,
        compute_type: str | None = None,
    ) -> None:
        """Initialize the transcriber and load the whisper model.

        Args:
            model_size: Whisper model size (e.g. 'large-v3', 'medium', 'tiny').
            device: Compute device ('auto', 'cuda', or 'cpu'). 'auto' tries
                CUDA first and falls back to CPU if unavailable.
            compute_type: Quantization type ('int8_float16', 'int8', 'float16').
        """
        self._patch_cuda_path()
        raw_model = model_size or os.environ.get("WHISPER_MODEL") or default_whisper_key()
        # Resolve a friendly registry key ("large-v3") to this backend's repo id
        # so it compares equal to what the Settings picker sends and
        # `ensure_model_repo` doesn't reload an already-loaded model. Anything
        # else — an explicit repo id, a local path, a bare size like "medium" —
        # passes straight through to faster-whisper.
        self.model_size = (
            _CT2_WHISPER_MODELS[raw_model]["repo"]
            if raw_model in _CT2_WHISPER_MODELS
            else raw_model
        )
        self.device = device or os.environ.get("WHISPER_DEVICE", "auto")
        # float16 is the correct CUDA default: INT8 GPU kernels are disabled on
        # Blackwell (sm_120, e.g. RTX 5090) since CTranslate2 4.6.2, so
        # int8_float16 buys nothing there and historically risked
        # CUBLAS_STATUS_NOT_SUPPORTED. The CPU fallback uses int8 separately.
        self.compute_type = compute_type or os.environ.get(
            "WHISPER_COMPUTE_TYPE", "float16"
        )
        self.model: WhisperModel | None = None
        # Optional Whisper initial_prompt (a glossary of names/terms) set per
        # request by the server to bias decoding. None = no biasing.
        self.initial_prompt: str | None = None
        self._load_model()

    @staticmethod
    def _patch_cuda_path() -> None:
        """Prepend nvidia CUDA DLL directories to PATH on Windows.

        Searches for cublas/cudnn DLLs in (in order):
        - The active Python env's site-packages/nvidia/*/bin (pip nvidia-* packages)
        - Known conda/miniconda site-packages/nvidia/*/bin
        - CUDA Toolkit installation under Program Files
        This is a no-op on non-Windows and when DLLs are already discoverable.
        """
        if sys.platform != "win32":
            return

        site_dirs: list[str] = []
        # Active Python env (works for pip installs of nvidia-* packages)
        try:
            site_dirs.extend(site.getsitepackages())
        except AttributeError:
            pass
        try:
            site_dirs.append(site.getusersitepackages())
        except AttributeError:
            pass
        # conda / miniconda envs: CONDA_PREFIX, CONDA_ROOT, or common install paths
        for conda_env in filter(None, [
            os.environ.get("CONDA_PREFIX"),
            os.environ.get("CONDA_ROOT"),
        ]):
            site_dirs.append(str(Path(conda_env) / "Lib" / "site-packages"))
        # Miniconda default install locations
        home = Path.home()
        for base in [
            home / "AppData" / "Local" / "miniconda3",
            home / "miniconda3",
            home / "anaconda3",
            Path("C:/ProgramData/miniconda3"),
            Path("C:/ProgramData/anaconda3"),
        ]:
            sp = base / "Lib" / "site-packages"
            if sp.is_dir():
                site_dirs.append(str(sp))

        existing = set(os.environ.get("PATH", "").lower().split(os.pathsep))
        additions: list[str] = []

        for site_dir in site_dirs:
            nvidia_dir = Path(site_dir) / "nvidia"
            if not nvidia_dir.is_dir():
                continue
            for pkg_dir in nvidia_dir.iterdir():
                bin_dir = pkg_dir / "bin"
                if bin_dir.is_dir() and str(bin_dir).lower() not in existing:
                    additions.append(str(bin_dir))
                    existing.add(str(bin_dir).lower())

        # CUDA Toolkit (installed via nvidia installer, not pip)
        cuda_root = Path("C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA")
        if cuda_root.is_dir():
            for version_dir in sorted(cuda_root.iterdir(), reverse=True):
                bin_dir = version_dir / "bin"
                if bin_dir.is_dir() and str(bin_dir).lower() not in existing:
                    additions.append(str(bin_dir))
                    existing.add(str(bin_dir).lower())
                    break  # newest version only

        if additions:
            os.environ["PATH"] = os.pathsep.join(additions) + os.pathsep + os.environ.get("PATH", "")
            logger.info("Prepended CUDA DLL paths to PATH: %s", additions)

    def _load_model(self) -> None:
        """Load the faster-whisper model into memory.

        With device='auto', tries CUDA first and falls back to CPU (int8)
        when no usable GPU is present.
        """
        if self.device == "auto":
            try:
                self.model = self._create_model("cuda", self.compute_type)
                self.device = "cuda"
            except Exception as exc:
                logger.warning(
                    "CUDA unavailable (%s) — falling back to CPU with int8. "
                    "Set WHISPER_DEVICE/WHISPER_COMPUTE_TYPE to override.",
                    exc,
                )
                self.device = "cpu"
                self.compute_type = "int8"
                self.model = self._create_model("cpu", "int8")
        else:
            self.model = self._create_model(self.device, self.compute_type)

    def ensure_model_repo(self, repo: str) -> None:
        """Switch the loaded model to *repo*, reloading only on a real change.

        Unlike mlx-whisper (which loads per call, so the server can swap
        `model_repo` for one request and restore it), faster-whisper holds one
        model — and its GPU memory — for the life of the process. Honouring the
        Settings picker therefore means reloading, which costs seconds and
        briefly holds two models, so the new choice is *sticky*: we switch once
        and keep it rather than restoring after every request.

        A failed load keeps the previous model instead of leaving the
        transcriber with none, so a bad pick degrades to the model that was
        already working rather than breaking transcription outright.
        """
        if not repo or repo == self.model_size:
            return
        previous_size, previous_model = self.model_size, self.model
        self.model_size = repo
        try:
            self._load_model()
            logger.info("Whisper model switched to %s.", repo)
        except Exception:
            logger.exception(
                "Whisper model switch to %s failed — keeping %s.", repo, previous_size
            )
            self.model_size, self.model = previous_size, previous_model

    def _create_model(self, device: str, compute_type: str) -> WhisperModel:
        """Instantiate a WhisperModel on the given device.

        `local_files_only=True`: the model must already be in the HF cache.
        Downloads are sanctioned exclusively through `model_setup`'s pinned,
        checksum-verified pipeline (SETUP_REDESIGN_SPEC V3) — loading here used
        to fetch ~3 GB synchronously inside service startup, which left the
        port unbound for the whole download and killed the process on failure.

        The `faster_whisper` import is deliberately here rather than at module
        scope. It loads ctranslate2's native extension, so on a clean Windows box
        without the MSVC redistributable it raises `ImportError: DLL load failed`
        — and at module scope that killed the sidecar before uvicorn could bind,
        which Rust could only observe as a service that never answered. Deferred,
        the service binds, `/health` reports `transcriber_state = error`, and the
        UI can say what is actually wrong.
        """
        from faster_whisper import WhisperModel

        logger.info(
            "Loading whisper model: size=%s device=%s compute_type=%s",
            self.model_size,
            device,
            compute_type,
        )
        model = WhisperModel(
            self.model_size,
            device=device,
            compute_type=compute_type,
            local_files_only=True,
        )
        logger.info("Whisper model loaded successfully on %s.", device)
        return model

    def transcribe(self, audio_path: str) -> TranscribeResponse:
        """Transcribe an audio file from disk.

        Args:
            audio_path: Path to the audio file (.wav, .mp3, etc.).

        Returns:
            TranscribeResponse with text, language, and duration.

        Raises:
            FileNotFoundError: If the audio file does not exist.
            RuntimeError: If transcription fails.
        """
        audio_path_obj = Path(audio_path)
        if not audio_path_obj.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        if self.model is None:
            raise RuntimeError("Whisper model is not loaded.")

        logger.info("Transcribing audio file: %s", audio_path)
        return self._transcribe_with_fallback(str(audio_path_obj))

    def transcribe_dual(self, audio_path: str, mic_audio_path: str, diarize: bool = True) -> TranscribeResponse:
        """Transcribe a system-audio file and a mic file of the same meeting.

        Returns a speaker-labeled transcript ("Me" = mic, "Them" = system).
        The mic file is best-effort: if it is missing or fails to
        transcribe, the system-audio transcript is returned unlabeled-side
        intact rather than failing the whole meeting.
        """
        if not Path(audio_path).exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        logger.info(
            "Transcribing dual audio: system=%s mic=%s", audio_path, mic_audio_path
        )
        system_segments, system_info = self._segments_with_fallback(audio_path)

        mic_segments: list[Segment] = []
        mic_duration = 0.0
        try:
            if Path(mic_audio_path).exists():
                mic_segments, mic_info = self._segments_with_fallback(mic_audio_path)
                mic_duration = mic_info.duration
            else:
                logger.warning("Mic audio file not found: %s", mic_audio_path)
        except Exception as exc:
            logger.warning(
                "Mic transcription failed (%s) — using system audio only.", exc
            )

        hint = playback_hint(system_segments, mic_segments)  # BEFORE the strip
        system_segments = drop_unvoiced_segments(system_segments, audio_path, "system")
        mic_segments = drop_unvoiced_segments(mic_segments, mic_audio_path, "mic")
        system_segments = strip_glossary_echo(system_segments, self.initial_prompt)
        mic_segments = strip_glossary_echo(mic_segments, self.initial_prompt)
        system_segments = apply_vocabulary_corrections(system_segments, self.initial_prompt)
        mic_segments = apply_vocabulary_corrections(mic_segments, self.initial_prompt)
        mic_segments = strip_mic_bleed(system_segments, mic_segments)
        sys_labels = (
            None  # playback: TTS/media voices must not become "Speaker N"
            if hint == "youtube"
            else diarize_system_labels(audio_path, system_segments, diarize, mic_segments)
        )
        turns = build_labeled_turns(system_segments, mic_segments, sys_labels)
        text = "\n".join(f"{t.speaker}: {t.text}" for t in turns)
        return TranscribeResponse(
            text=text,
            language=system_info.language,
            duration_seconds=max(system_info.duration, mic_duration),
            category_hint=hint,
            turns=turns,
        )

    def _transcribe_with_fallback(self, audio_path: str) -> TranscribeResponse:
        """Transcribe one file, retrying on CPU if CUDA inference fails."""
        segments, info = self._segments_with_fallback(audio_path)
        transcript_text = " ".join(text for _, _, text in segments).strip()
        turns = build_single_file_turns(segments)
        return TranscribeResponse(
            text=transcript_text,
            language=info.language,
            duration_seconds=info.duration,
            turns=turns,
        )

    def _segments_with_fallback(self, audio_path: str):
        """Collect segments, falling back to CPU when CUDA DLLs fail."""
        try:
            return self._collect_segments(audio_path)
        except Exception as exc:
            msg = str(exc).lower()
            if self.device == "cuda" and any(f in msg for f in _CUDA_DLL_ERROR_FRAGMENTS):
                logger.warning(
                    "CUDA inference failed (%s) — falling back to CPU for this run.", exc
                )
                self.device = "cpu"
                self.compute_type = "int8"
                self.model = self._create_model("cpu", "int8")
                try:
                    return self._collect_segments(audio_path)
                except Exception as cpu_exc:
                    logger.error("CPU fallback also failed: %s", cpu_exc)
                    raise RuntimeError(f"Transcription failed: {cpu_exc}") from cpu_exc
            logger.error("Transcription failed: %s", exc)
            raise RuntimeError(f"Transcription failed: {exc}") from exc

    def _collect_segments(self, audio_path: str):
        """Run whisper on one file, returning ([(start, end, text), ...], info)."""
        assert self.model is not None
        segments, info = self.model.transcribe(
            audio_path,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            initial_prompt=self.initial_prompt,
        )
        collected: list[Segment] = [
            (seg.start, _safe_end(seg.start, seg.end), seg.text) for seg in segments
        ]
        logger.info(
            "Transcription complete: language=%s duration=%.1fs segments=%d",
            info.language,
            info.duration,
            len(collected),
        )
        return collected, info

    def transcribe_bytes(self, audio: bytes) -> TranscribeResponse:
        """Transcribe raw audio bytes.

        Writes bytes to a temporary file, transcribes, then cleans up.

        Args:
            audio: Raw audio data as bytes.

        Returns:
            TranscribeResponse with text, language, and duration.

        Raises:
            ValueError: If audio bytes are empty.
            RuntimeError: If transcription fails.
        """
        if not audio:
            raise ValueError("Audio bytes are empty.")

        logger.info("Transcribing %d bytes of audio data.", len(audio))
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio)
            tmp_path = tmp.name

        try:
            result = self.transcribe(tmp_path)
        finally:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                logger.warning("Failed to clean up temporary file: %s", tmp_path)

        return result


@dataclass
class _TranscriptInfo:
    """Minimal stand-in for faster-whisper's `info` object."""

    language: str
    duration: float


# Above this, Whisper's own no-speech estimate says the window is probably not
# speech at all — matches the no_speech_threshold used at decode time.
_NO_SPEECH_DROP = 0.6


def drop_no_speech_raw_segments(raw_segments: list[dict]) -> list[dict]:
    """Drop raw mlx-whisper segments flagged as probable non-speech. Pure —
    unit-testable. Segments without a `no_speech_prob` are kept (fail open)."""
    return [
        seg
        for seg in raw_segments
        if float(seg.get("no_speech_prob", 0.0) or 0.0) <= _NO_SPEECH_DROP
    ]


def _merge_dual(collect, audio_path: str, mic_audio_path: str, diarize: bool = True, initial_prompt: str | None = None) -> TranscribeResponse:
    """Shared dual-file orchestration for any backend.

    `collect(path)` returns `(segments, info)` where `segments` is a list of
    `(start_seconds, end_seconds, text)`. The mic file is best-effort: if it is
    missing or fails, the system-audio transcript is returned alone rather than
    failing the whole meeting.
    """
    if not Path(audio_path).exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    system_segments, system_info = collect(audio_path)

    mic_segments: list[Segment] = []
    mic_duration = 0.0
    try:
        if Path(mic_audio_path).exists():
            mic_segments, mic_info = collect(mic_audio_path)
            mic_duration = mic_info.duration
        else:
            logger.warning("Mic audio file not found: %s", mic_audio_path)
    except Exception as exc:
        logger.warning("Mic transcription failed (%s) — using system audio only.", exc)

    hint = playback_hint(system_segments, mic_segments)  # BEFORE the strip
    system_segments = drop_unvoiced_segments(system_segments, audio_path, "system")
    mic_segments = drop_unvoiced_segments(mic_segments, mic_audio_path, "mic")
    system_segments = strip_glossary_echo(system_segments, initial_prompt)
    mic_segments = strip_glossary_echo(mic_segments, initial_prompt)
    system_segments = apply_vocabulary_corrections(system_segments, initial_prompt)
    mic_segments = apply_vocabulary_corrections(mic_segments, initial_prompt)
    mic_segments = strip_mic_bleed(system_segments, mic_segments)
    sys_labels = (
        None  # playback: TTS/media voices must not become "Speaker N"
        if hint == "youtube"
        else diarize_system_labels(audio_path, system_segments, diarize, mic_segments)
    )
    turns = build_labeled_turns(system_segments, mic_segments, sys_labels)
    text = "\n".join(f"{t.speaker}: {t.text}" for t in turns)
    return TranscribeResponse(
        text=text,
        language=system_info.language,
        duration_seconds=max(system_info.duration, mic_duration),
        category_hint=hint,
        turns=turns,
    )


class MlxWhisperTranscriber:
    """Transcribes audio with mlx-whisper on the Apple-Silicon GPU.

    Exposes the same surface as :class:`WhisperTranscriber` (`model_size`,
    `transcribe`, `transcribe_dual`) so it is a drop-in backend on macOS.
    Unlike faster-whisper, mlx-whisper is greedy-only (no beam search) and has
    no built-in VAD, so hallucination-on-silence is suppressed purely with
    decoder thresholds. The MLX model auto-downloads to the Hugging Face cache
    on first use.
    """

    def __init__(
        self, model_repo: str | None = None, drop_no_speech: bool = False
    ) -> None:
        # Imported lazily so the module loads on platforms without mlx-whisper
        # (e.g. Windows), where this backend is never selected.
        import mlx_whisper  # noqa: F401  (import validates availability)

        self.model_repo = model_repo or os.environ.get(
            "MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-mlx"
        )
        # Reported via /health; matches the faster-whisper model family.
        self.model_size = "large-v3"
        self.device = "mlx"
        # Optional Whisper initial_prompt (a glossary of names/terms) set per
        # request by the server to bias decoding. None = no biasing.
        self.initial_prompt: str | None = None
        # Live-caption mode: drop segments Whisper itself marks as probable
        # non-speech. mlx-whisper's built-in no_speech_threshold only suppresses
        # a segment when its avg_logprob is ALSO low, so confident hallucinations
        # on breath/noise ("Thank you.") slip through. The FINAL transcript keeps
        # this off — it is protected by the Silero VAD gates instead.
        self.drop_no_speech = drop_no_speech
        logger.info("MLX whisper backend ready (model=%s).", self.model_repo)

    def _collect_segments(self, audio_path: str) -> tuple[list[Segment], _TranscriptInfo]:
        """Run mlx-whisper on one file, returning `([(start, end, text), ...], info)`."""
        import mlx_whisper
        import numpy as np

        # Decode in-process via PyAV (bundled ffmpeg libs). Passing the PATH
        # would make mlx-whisper's own loader shell out to a system `ffmpeg`
        # binary — absent on fresh Macs (no Homebrew), which broke every
        # transcription on the clean-machine test with
        # "[Errno 2] No such file or directory: 'ffmpeg'".
        samples = _decode_to_mono16k(audio_path)
        if samples.size == 0:
            return [], _TranscriptInfo(language="", duration=0.0)
        audio = samples.astype(np.float32) / 32768.0

        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self.model_repo,
            # Hallucination-on-silence suppression (no VAD in mlx-whisper):
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            logprob_threshold=-1.0,
            compression_ratio_threshold=2.4,
            verbose=False,
            initial_prompt=self.initial_prompt,
        )
        raw = result.get("segments", [])
        if self.drop_no_speech:
            raw = drop_no_speech_raw_segments(raw)
        segments: list[Segment] = [
            (
                float(seg["start"]),
                _safe_end(float(seg["start"]), float(seg.get("end", 0.0) or 0.0)),
                seg["text"],
            )
            for seg in raw
        ]
        # mlx-whisper omits duration; the last segment's end is close enough for
        # the meeting's duration display (trailing silence is irrelevant).
        duration = max((float(seg["end"]) for seg in result.get("segments", [])), default=0.0)
        info = _TranscriptInfo(language=result.get("language", ""), duration=duration)
        logger.info(
            "MLX transcription complete: language=%s duration=%.1fs segments=%d",
            info.language,
            info.duration,
            len(segments),
        )
        return segments, info

    def transcribe(self, audio_path: str) -> TranscribeResponse:
        """Transcribe a single audio file from disk."""
        if not Path(audio_path).exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
        logger.info("Transcribing audio file (MLX): %s", audio_path)
        segments, info = self._collect_segments(audio_path)
        text = " ".join(t for _, _, t in segments).strip()
        turns = build_single_file_turns(segments)
        return TranscribeResponse(
            text=text, language=info.language, duration_seconds=info.duration, turns=turns
        )

    def transcribe_dual(self, audio_path: str, mic_audio_path: str, diarize: bool = True) -> TranscribeResponse:
        """Transcribe a system-audio file and a mic file into a labeled transcript."""
        logger.info(
            "Transcribing dual audio (MLX): system=%s mic=%s", audio_path, mic_audio_path
        )
        return _merge_dual(self._collect_segments, audio_path, mic_audio_path, diarize, initial_prompt=self.initial_prompt)


def create_transcriber(model_key: str | None = None):
    """Build the transcription backend for this machine.

    Selection order: `WHISPER_BACKEND` env (`mlx` | `faster-whisper` | `auto`),
    then auto-detect — MLX on Apple-Silicon macOS, faster-whisper elsewhere.
    Falls back to faster-whisper if MLX can't be initialised.

    `model_key` pins a specific registry model (e.g. the caller found only
    that one cached); None keeps the env-var / backend-default resolution.
    Loading never downloads — see `WhisperTranscriber._create_model`.
    """
    backend = os.environ.get("WHISPER_BACKEND", "auto").strip().lower()
    if backend == "auto":
        is_apple_silicon = sys.platform == "darwin" and platform.machine() == "arm64"
        backend = "mlx" if is_apple_silicon else "faster-whisper"

    if backend == "mlx":
        try:
            return MlxWhisperTranscriber(
                model_repo=whisper_repo_for(model_key) if model_key else None
            )
        except Exception as exc:
            logger.warning(
                "MLX backend unavailable (%s) — falling back to faster-whisper.", exc
            )
    return WhisperTranscriber(model_size=model_key)
