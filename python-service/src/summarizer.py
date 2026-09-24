"""Meeting summarization using Ollama (local LLM) with prompt templates."""

from __future__ import annotations

import json
import logging
import os
import platform
import re
import sys
import time
from collections.abc import Iterator
from datetime import date
from difflib import SequenceMatcher
from typing import TYPE_CHECKING, Any, NamedTuple
from urllib.parse import urlparse

import httpx
from ollama import Client

from .config import list_template_files, load_prompt
from .models import (
    AcceptedLiveItem,
    AttendeeDetail,
    ChatResponse,
    MeetingNotes,
    PriorMeeting,
    SummarizeResponse,
    TemplateInfo,
    validate_copilot_deepseek_endpoint,
)
from .names import dedupe_attendees, ground_to_roster

if TYPE_CHECKING:
    from .copilot_answer import StreamControl

logger = logging.getLogger(__name__)


def _norm_text(s: str) -> str:
    """Normalize text: replace curly quotes, casefold, replace non-alphanumerics with space, collapse whitespace."""
    if not s:
        return ""
    s = s.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    s = s.casefold()
    cleaned = "".join(c if c.isalnum() else " " for c in s)
    return " ".join(cleaned.split())


def _clean_prior_title(title: str) -> str:
    """Strip *, _, backticks, collapse whitespace and truncate to 80 chars."""
    cleaned = re.sub(r"[*_`]", "", title)
    cleaned = " ".join(cleaned.split())
    return cleaned[:80].strip()


DRAFT_SYSTEM_PROMPT = (
    "You write complete deliverable documents in Markdown from a task brief. "
    "Use only the context contained in the brief: its meeting notes, related meetings, "
    "folder references, and any previous rejection notes. Follow the brief's skill and agent "
    "instructions when present. Where the brief does not contain something you need, do not "
    "invent it: list it under a final '## Open questions' heading. Structure the document with "
    "headings, keep it concrete, and output only the document — no preamble, no commentary."
)

#: Placeholders local models emit instead of omitting an unknown field.
_NOT_STATED = {"", "null", "none", "n/a", "na", "unknown", "unspecified"}


def _stated(value: object) -> str:
    """Return a trimmed field value, or "" when the model meant "not stated"."""
    text = str(value or "").strip()
    return "" if text.lower() in _NOT_STATED else text


# ── context-window sizing ───────────────────────────────────────────────────
# Ollama defaults to a 2048-token context regardless of the model's real
# capacity, which silently truncates long meeting transcripts, so num_ctx is
# always sent. It used to be a fixed 16,384 — which is *too small* for a long
# meeting summarized by a verbose reasoning model (live 2026-08-10:
# muse-glimmer:30b-mlx spent its window thinking and the note came back cut off)
# and needlessly large for a five-minute standup. The window is now computed per
# request from the actual prompt, so no user ever has to know this knob exists.

#: Never size below this. It is what shipped, it covers ~90 minutes of speech,
#: and it is safe on modest hardware — so adaptive sizing can only ever add.
NUM_CTX_FLOOR = 16384

#: Conservative chars-per-token divisor for estimating prompt tokens. Measured
#: 2026-08-10 on the real tokenizer (qwen3.5:2b, prompt_eval_count over 2k-char
#: samples): English 5.15, Arabic 3.72, code-switched Arabic/English 4.13
#: chars/token. 3 sits under the densest of those with margin — under-estimating
#: the prompt is what truncates a note; over-estimating only costs a little RAM.
CHARS_PER_TOKEN = 3

#: Tokens reserved on top of the prompt for the model's answer. Generous on
#: purpose: a reasoning model spends thinking tokens *before* the note, and the
#: live-incident note alone was ~5k tokens.
OUTPUT_BUDGET_TOKENS = 8192

#: Windows are rounded up to a multiple of this — a tidy number to log and
#: reason about, and it stops one extra transcript line changing the window.
NUM_CTX_STEP = 2048

#: Total-RAM tier (GiB, exclusive upper bound) → the largest window we will ask
#: a machine of that size to hold. The runner's KV cache grows with num_ctx, so
#: this is the guard that keeps a notetaker from evicting everything else.
_RAM_NUM_CTX_TIERS: tuple[tuple[int, int], ...] = (
    (16, 16384),
    (32, 24576),
    (64, 32768),
)
#: Cap on a machine at or above the last tier.
_RAM_NUM_CTX_MAX = 65536

#: Debug-only pin. When ``OLLAMA_NUM_CTX`` is set, that exact window is used for
#: every call and adaptive sizing is skipped entirely. Unset (the norm, and what
#: every real user runs) means "size it yourself".
NUM_CTX_PIN: int | None = (
    int(os.environ["OLLAMA_NUM_CTX"]) if os.environ.get("OLLAMA_NUM_CTX") else None
)

#: The window a short prompt still gets — the floor, or the pin when one is set.
DEFAULT_NUM_CTX = NUM_CTX_PIN or NUM_CTX_FLOOR

#: Debug-only ceiling for the one retry after a reply is cut off mid-JSON (see
#: _chat_ollama). Unset means the retry is bounded by the hardware tier instead
#: of a hard-coded 32,768, so a 128 GB machine can actually use its headroom.
NUM_CTX_RETRY_CAP: int | None = (
    int(os.environ["OLLAMA_NUM_CTX_RETRY_CAP"])
    if os.environ.get("OLLAMA_NUM_CTX_RETRY_CAP")
    else None
)

#: Memoized results — RAM and a model's trained context never change mid-run.
_hardware_cap_cache: int | None = None
_model_max_ctx_cache: dict[str, int | None] = {}


def _total_ram_bytes() -> int | None:
    """Physical RAM in bytes, stdlib-only, or None if it can't be read.

    ``psutil`` would be one line, but it is a dependency this service does not
    have and does not need for one number.
    """
    try:
        if sys.platform == "win32":
            import ctypes

            class _MemoryStatusEx(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = _MemoryStatusEx()
            status.dwLength = ctypes.sizeof(_MemoryStatusEx)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return None
            return int(status.ullTotalPhys)
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except Exception:  # noqa: BLE001 — any failure means "unknown", never a crash
        logger.debug(
            "Could not read total RAM; using the conservative window.", exc_info=True
        )
        return None


def _hardware_num_ctx_cap() -> int:
    """Largest window this machine's RAM tier allows. Falls back to the floor.

    Computed once per process — RAM does not change while we run.
    """
    global _hardware_cap_cache
    if _hardware_cap_cache is not None:
        return _hardware_cap_cache
    total = _total_ram_bytes()
    if total is None:
        _hardware_cap_cache = NUM_CTX_FLOOR
        return _hardware_cap_cache
    gib = total / (1024**3)
    cap = _RAM_NUM_CTX_MAX
    for threshold, tier_cap in _RAM_NUM_CTX_TIERS:
        if gib < threshold:
            cap = tier_cap
            break
    _hardware_cap_cache = cap
    logger.info("Context sizing: %.0f GiB RAM → num_ctx cap %d", gib, cap)
    return cap


def _model_max_ctx(model: str, client: Any) -> int | None:
    """The model's own trained context length via Ollama's ``/api/show``, or None.

    Verified live against Ollama 0.32.7 on 2026-08-10: ``POST /api/show`` returns
    a ``model_info`` map (``ShowResponse.modelinfo`` on the python client 0.6.2)
    whose context key is *architecture-prefixed* — ``qwen35.context_length``:
    262144, ``muse_glimmer.context_length``: 131072, ``llama.context_length``:
    8192 — with the architecture itself under ``general.architecture``. The
    suffix scan is the fallback for an architecture we can't read.

    Any failure (Ollama down, old server, field absent) returns None, which drops
    this bound from the clamp rather than failing the summary. Cached per model.
    """
    if model in _model_max_ctx_cache:
        return _model_max_ctx_cache[model]
    value: int | None = None
    try:
        response = client.show(model)
        info = getattr(response, "modelinfo", None)
        if info is None and isinstance(response, dict):
            info = response.get("model_info")
        if isinstance(info, dict):
            arch = info.get("general.architecture")
            if isinstance(arch, str):
                candidate = info.get(f"{arch}.context_length")
                value = candidate if isinstance(candidate, int) else None
            if value is None:
                value = next(
                    (
                        v
                        for k, v in info.items()
                        if k.endswith(".context_length") and isinstance(v, int)
                    ),
                    None,
                )
    except Exception:  # noqa: BLE001 — an unknown ceiling is not an error
        logger.debug("Could not read the context length of %s", model, exc_info=True)
        value = None
    _model_max_ctx_cache[model] = value
    return value


def _prompt_chars(messages: list[dict]) -> int:
    """Total characters the model will actually be sent."""
    return sum(len(str(m.get("content") or "")) for m in messages)


def _adaptive_num_ctx(prompt_chars: int, model: str = "", client: Any = None) -> int:
    """The context window for one completion, sized from its own prompt.

    ``max(floor, min(prompt + output budget, hardware tier, model's own max))``,
    rounded up to a multiple of ``NUM_CTX_STEP``. No setting, no env var, no
    per-model table: a five-minute standup gets the floor and a two-hour meeting
    on a 128 GB machine gets room for the transcript *and* a reasoning model's
    thinking tokens. Logs the chosen window and which bound decided it.

    Two env vars exist for debugging only and are never required:
    ``OLLAMA_NUM_CTX`` pins this value exactly (adaptive sizing is skipped), and
    ``OLLAMA_NUM_CTX_RETRY_CAP`` overrides the truncation-retry ceiling.
    """
    if NUM_CTX_PIN:
        logger.info(
            "Context sizing: pinned to num_ctx=%d by OLLAMA_NUM_CTX", NUM_CTX_PIN
        )
        return NUM_CTX_PIN

    prompt_tokens = -(-max(prompt_chars, 0) // CHARS_PER_TOKEN)  # ceil
    needed = prompt_tokens + OUTPUT_BUDGET_TOKENS
    needed = -(-needed // NUM_CTX_STEP) * NUM_CTX_STEP  # round up to the next step

    bounds: dict[str, int] = {"prompt": needed, "hardware_cap": _hardware_num_ctx_cap()}
    model_max = _model_max_ctx(model, client) if model and client is not None else None
    if model_max:
        bounds["model_max"] = model_max

    bound, num_ctx = min(bounds.items(), key=lambda kv: kv[1])
    if num_ctx < NUM_CTX_FLOOR:
        bound, num_ctx = "floor", NUM_CTX_FLOOR
    logger.info(
        "Context sizing: adaptive: prompt≈%dk tok + %dk budget → %d (bound by %s)",
        round(prompt_tokens / 1000),
        round(OUTPUT_BUDGET_TOKENS / 1000),
        num_ctx,
        bound,
    )
    return num_ctx


def _ollama_options(num_ctx: int) -> dict[str, float | int]:
    """Base ``options`` for EVERY Ollama completion call (chat + stream).

    ``num_ctx`` must always be present: a completion request without it makes
    Ollama load the model at its *model-default* context — qwen3.5:9b defaults
    to 262,144, observed live 2026-08-02 as a 16 GB resident runner vs ~7 GB at
    our 16,384. It is a required argument (not a defaulted one) so a new call
    site cannot silently inherit someone else's window: resolve it with
    ``_adaptive_num_ctx(_prompt_chars(messages), model, client)`` first, then
    build options here (override temperature per-site if needed).

    ``num_predict`` must always be present too, and always ``-1``: without it,
    this path's effective default cut muse-glimmer:30b-mlx at ~5k output
    tokens while reporting ``done_reason: "stop"`` — a silent cap wearing a
    normal stop's face (observed live 2026-08-11; the same request with -1
    generated 10,980 tokens of complete JSON). With -1, the ONLY output bound
    is the num_ctx we sized deliberately, and hitting it reports ``"length"``
    honestly, which is what the truncation retry keys on.
    """
    return {"temperature": 0.0, "num_ctx": num_ctx, "num_predict": -1}


def _retry_num_ctx(current: int) -> int | None:
    """Doubled context window for the truncation retry, or None at the cap.

    Doubles from whatever the first attempt actually used (not a fixed 16,384),
    bounded by the hardware tier — or by ``OLLAMA_NUM_CTX_RETRY_CAP`` when that
    debug override is set.
    """
    cap = NUM_CTX_RETRY_CAP or _hardware_num_ctx_cap()
    doubled = min(current * 2, cap)
    return doubled if doubled > current else None


def _stop_reason(response: object) -> str:
    """Ollama's ``done_reason`` for a completion ("stop" / "length"), "" if absent.

    Tolerant on purpose: the field is optional in the API and absent entirely on
    older servers, and a missing stop reason must never fail a summary.
    """
    try:
        value = response.get("done_reason")
    except (AttributeError, TypeError):
        return ""
    return value if isinstance(value, str) else ""


_LOCAL_OLLAMA_HOSTS = {
    "http://127.0.0.1:11434",
    "http://localhost:11434",
}
_MANAGED_OLLAMA_HOST: str | None = None
_MANAGED_LOCAL_OPENAI_BASE: str | None = None

COPILOT_TIMEOUT_SECONDS = 18.0
COPILOT_MAX_TOKENS = 1024
# One context window for every Live Copilot call to the local model (gate, live
# extraction, answer stream, warm-up). Ollama reloads the runner whenever num_ctx
# changes; mixed 4096/8192/16384 calls reloaded qwen3.6:35b nine times in one
# five-minute meeting (2026-09-18), 5 to 6 s each.
COPILOT_NUM_CTX = NUM_CTX_FLOOR
LOCAL_STREAM_EARLY = "Local engine ended the stream early"
LOCAL_STREAM_LENGTH = "Answer cut off at token limit"
LOCAL_STREAM_TIMEOUT = "Local engine timed out after 18 s"
LOCAL_STREAM_PROVIDER = "The local engine could not complete the answer"
DEEPSEEK_STREAM_EARLY = "DeepSeek ended the stream early"
DEEPSEEK_STREAM_TIMEOUT = "DeepSeek timed out after 18 s"
DEEPSEEK_STREAM_PROVIDER = "DeepSeek could not complete the answer"


class CopilotStreamEvent(NamedTuple):
    kind: str
    text: str = ""
    input_tokens: int = 0
    output_tokens: int = 0


class CopilotStreamError(RuntimeError):
    def __init__(self, message: str, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


def _nonnegative_int(value: object) -> int:
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        else 0
    )


def _normalize_local_ollama_host(url: str | None) -> str | None:
    """Return a safe native-client host for a loopback Ollama URL."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.params
        or parsed.path not in ("", "/", "/v1", "/v1/")
    ):
        return None
    host = f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname
    return f"http://{host}:{port}"


def _normalize_registered_ollama_host(url: str | None) -> str | None:
    """Canonicalize the host accepted by the app-owned registration route."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.params
        or parsed.path not in ("", "/")
    ):
        return None
    host = f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname
    return f"http://{host}:{port}"


def _normalize_local_openai_base(url: str | None) -> str | None:
    """Canonicalize a registered loopback OpenAI-compatible base URL."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/", "/v1", "/v1/")
        or parsed.params
    ):
        return None
    host = f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname
    suffix = "/v1" if parsed.path.rstrip("/") == "/v1" else ""
    return f"http://{host}:{port}{suffix}"


def configure_local_ollama_host(url: str) -> str:
    """Allow one additional app-owned loopback Ollama port for this process."""
    global _MANAGED_OLLAMA_HOST
    normalized = _normalize_registered_ollama_host(url)
    if normalized is None:
        raise ValueError("ollama_host must be an http:// loopback URL without a path")
    _MANAGED_OLLAMA_HOST = normalized
    return normalized


def configure_local_openai_base_url(url: str) -> str:
    """Register the one app-managed Rapid-MLX endpoint for this process."""
    global _MANAGED_LOCAL_OPENAI_BASE
    normalized = _normalize_local_openai_base(url)
    if normalized is None:
        raise ValueError(
            "local_openai_base_url must be an http:// loopback URL with only an optional /v1 path"
        )
    _MANAGED_LOCAL_OPENAI_BASE = normalized
    return normalized


def validate_copilot_local_endpoint(url: str | None, api_key: str | None) -> str:
    """Return the registered local endpoint kind, or reject without doing I/O."""
    normalized_ollama = _normalize_local_ollama_host(url)
    default_ollama = normalized_ollama == "http://127.0.0.1:11434"
    managed_ollama = (
        normalized_ollama is not None and normalized_ollama == _MANAGED_OLLAMA_HOST
    )
    normalized_openai = _normalize_local_openai_base(url)
    managed_openai = (
        normalized_openai is not None
        and normalized_openai == _MANAGED_LOCAL_OPENAI_BASE
    )
    if api_key is not None and not managed_openai:
        raise ValueError(
            "local credentials are only valid for the registered managed engine"
        )
    if managed_openai:
        return "openai"
    if default_ollama or managed_ollama:
        return "ollama"
    raise ValueError("local engine is not a registered loopback endpoint")


def _is_local_ollama_url(url: str | None) -> bool:
    """True for Ollama's default loopback host or the app-managed loopback host.

    Both the traditional port 11434 and Adversaria's private sidecar port are
    routed through the native Ollama client so ``num_ctx`` and the other local
    runtime options remain available. A random loopback OpenAI-compatible URL
    is not assumed to be Ollama unless Rust explicitly registered it.
    """
    normalized = _normalize_local_ollama_host(url)
    return normalized is not None and (
        normalized in _LOCAL_OLLAMA_HOSTS or normalized == _MANAGED_OLLAMA_HOST
    )


def _is_apple_silicon() -> bool:
    """True on Apple-Silicon macOS, where the LLM is served by Rapid-MLX."""
    return sys.platform == "darwin" and platform.machine() == "arm64"


# Default summarization model. On Apple Silicon the LLM is served by Rapid-MLX
# (ADR-010) under the served name `qwen3.6-27b`; elsewhere it's the Ollama tag
# `qwen3.6:35b-a3b` — a sparse MoE (35B total, ~3B active) that won a benchmark
# over qwen3:8b/14b, gemma4:31b, gpt-oss:20b, mistral 24b and llama3.1:8b on a
# real 5,200-word transcript (best depth + attribution, fastest warm latency,
# ~5s MoE load avoiding the cold-load timeout). See python-service/bench_models.py.
# The desktop app sends its configured model on every request — this is only the
# fallback for direct API calls. Override with OLLAMA_MODEL.
DEFAULT_MODEL = os.environ.get(
    "OLLAMA_MODEL", "qwen3.6-27b" if _is_apple_silicon() else "qwen3.6:35b-a3b"
)

# LLM backend selection. "ollama" talks to a local Ollama server; "openai" talks
# to any OpenAI-compatible server (Rapid-MLX on Apple Silicon, or vLLM /
# llama-server / LM Studio). This module constant stays "ollama" by default so
# the Ollama-coupled unit tests are unaffected; the running service resolves the
# platform-appropriate backend via default_llm_backend() and passes it in.
LLM_BACKEND = os.environ.get("LLM_BACKEND", "ollama").strip().lower()
# Base URL + key for the openai-compatible backend (ignored for ollama).
# 127.0.0.1:8000/v1 is Rapid-MLX's default serve address.
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:8000/v1").rstrip("/")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "EMPTY")

# Hosts that rejected response_format=json_schema (e.g. DeepSeek, Groq qwen).
# Remembered for the process lifetime so we only pay the failed schema attempt
# once and go straight to json_object thereafter. See _chat_openai.
_NO_JSON_SCHEMA: set[str] = set()

# Hosts that rejected the vLLM-only `chat_template_kwargs` extension with HTTP 400
# (e.g. Groq: "property 'chat_template_kwargs' is unsupported"; OpenAI). Remembered
# per process so we only pay the failed attempt once. See _chat_openai.
_NO_CHAT_TEMPLATE_KWARGS: set[str] = set()


def default_llm_backend() -> str:
    """Backend the running service should use. Explicit LLM_BACKEND env always
    wins; otherwise default to Rapid-MLX (openai-compatible) on Apple Silicon and
    Ollama everywhere else (ADR-010)."""
    env = os.environ.get("LLM_BACKEND")
    if env:
        return env.strip().lower()
    return "openai" if _is_apple_silicon() else "ollama"


# Reasoning models "think" before answering, which is slow and wasted for a
# constrained extraction task — we disable it (think=False) for these. Name
# fragments of model families that support a thinking mode.
_THINKING_MODEL_HINTS = (
    "qwen3",
    "deepseek-r1",
    "-r1",
    "gpt-oss",
    "magistral",
    "reasoning",
    "thinking",
)


def _is_thinking_model(model: str) -> bool:
    """True if the model family supports a (slow) thinking mode worth disabling."""
    lower = model.lower()
    return any(hint in lower for hint in _THINKING_MODEL_HINTS)


# Reasoning models emit their chain-of-thought inline before the answer, tagged
# <think> (Ollama/Groq qwen, deepseek-r1) or <thinking> (several HF/MLX chat
# templates), and they do it on the json-constrained summarize path too when
# think=False isn't honoured. It must go before the reply is read or parsed.
_THINK_BLOCK_RE = re.compile(
    r"<(think|thinking)>.*?</\1>\s*", re.DOTALL | re.IGNORECASE
)
_THINK_CLOSE_RE = re.compile(r"</think(?:ing)?>", re.IGNORECASE)
_THINK_OPEN_RE = re.compile(r"^<think(?:ing)?>", re.IGNORECASE)


def _strip_think(text: str) -> str:
    """Remove inline reasoning block(s) from a reply. No-op when absent.

    Covers the three shapes seen in the wild: balanced blocks (any number of
    them), and the degenerate "closing tag only" reply where the chat template
    opened the block for the model so only ``</think>`` comes back — there,
    everything up to the LAST closer is reasoning. An *unclosed* opening tag is
    left alone: the answer would be inside it, and cutting to end-of-string
    would delete the whole reply.
    """
    lowered = text.lower()
    if "<think" not in lowered and "</think" not in lowered:
        return text
    stripped = _THINK_BLOCK_RE.sub("", text)
    closers = list(_THINK_CLOSE_RE.finditer(stripped))
    if closers:
        stripped = stripped[closers[-1].end() :]
    return stripped.lstrip()


def _strip_think_stream(deltas):
    """Filter a content-delta stream, dropping a leading ``<think>…</think>`` block
    (some models stream reasoning into ``content``). Buffers until the block
    closes, then passes everything through; passes through immediately when there
    is no think block."""
    buffer = ""
    passthrough = False
    for delta in deltas:
        if passthrough:
            yield delta
            continue
        buffer += delta
        stripped = buffer.lstrip()
        if not stripped:
            continue  # only whitespace so far — can't decide yet
        if _THINK_OPEN_RE.match(stripped):
            closer = _THINK_CLOSE_RE.search(buffer)
            if closer:
                tail = buffer[closer.end() :].lstrip()
                passthrough = True
                buffer = ""
                if tail:
                    yield tail
            # else keep buffering until the closing tag arrives
        elif len(stripped) >= len("<thinking>"):
            passthrough = True  # definitely not a think block — flush + pass on
            out, buffer = buffer, ""
            yield out
    if not passthrough and buffer and not _THINK_OPEN_RE.match(buffer.lstrip()):
        yield buffer  # short reply that never reached the decision threshold


# ── model-output robustness ladder ──────────────────────────────────────────
# Every backend (native Ollama, OpenAI-compatible/Rapid-MLX, cloud) and every
# model family gets the same treatment before its reply is parsed: reasoning
# blocks out, then a fenced block found anywhere, then a balanced object embedded
# in prose, and — when the reply was cut off — a conservative repair of the tail.
# Live 2026-08-10: a verbose reasoning model overran num_ctx by one closing brace
# and the raw JSON blob was shown to the user as their meeting note.

_FENCE_RE = re.compile(r"```[a-zA-Z0-9_+-]*[ \t]*\r?\n?(.*?)```", re.DOTALL)
_OPEN_FENCE_RE = re.compile(r"```[a-zA-Z0-9_+-]*[ \t]*\r?\n?")

#: Each trim drops one member the model never finished; a reply needing more
#: than a few was not merely cut off at the tail.
_REPAIR_MAX_TRIMS = 4


class _JsonScan(NamedTuple):
    """What a string-aware walk over (possibly incomplete) JSON found."""

    scopes: list[str]  # "{" / "[" still open at the end, outermost first
    in_string: bool  # the text ended inside a string literal
    escaped: bool  # …and its last character was a backslash
    object_end: int | None  # index just past the first balanced top-level object
    last_boundary: int | None  # last structural "," / "{" / "[" outside a string


def _json_scan(text: str) -> _JsonScan:
    """Walk ``text`` as JSON, tracking string and escape state.

    Shared by the prose-embedded extractor and the truncation repair: both need
    brace depth that ignores braces inside string values ("costs {x} per seat"),
    which a regex cannot give correctly.
    """
    scopes: list[str] = []
    in_string = False
    escaped = False
    object_end: int | None = None
    last_boundary: int | None = None
    for i, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            last_boundary = i
            scopes.append(ch)
        elif ch in "}]":
            if scopes:
                scopes.pop()
            if ch == "}" and not scopes and object_end is None:
                object_end = i + 1
        elif ch == ",":
            last_boundary = i
    return _JsonScan(scopes, in_string, escaped, object_end, last_boundary)


def _fenced_json(text: str) -> str | None:
    """Contents of the first ```-fenced block holding a JSON object, or None.

    Models fence their answer even when told not to, and not always at the start
    ("Here are the notes:\\n```json\\n{…"), which a leading-fence-only strip
    misses. A fence the reply was cut off inside still yields its body — whether
    that body is salvageable is the repair step's call, not this one's.
    """
    for match in _FENCE_RE.finditer(text):
        body = match.group(1).strip()
        if body.startswith("{"):
            return body
    opening = _OPEN_FENCE_RE.search(text)
    if opening:
        body = text[opening.end() :].strip()
        if body.startswith("{"):
            return body
    return None


def _first_balanced_object(text: str) -> str | None:
    """The first balanced top-level ``{…}`` in ``text`` that parses as an object.

    For replies that wrap the JSON in prose ("Here is your summary: {…} Let me
    know…"). Requiring it to parse is what stops a genuine prose note — which may
    well mention a brace — from being mistaken for JSON. An object that never
    closes means the reply was cut off, not embedded: stop and leave it to the
    repair step rather than descending into a nested fragment.
    """
    pos = text.find("{")
    while pos != -1:
        scan = _json_scan(text[pos:])
        if scan.object_end is None:
            return None
        candidate = text[pos : pos + scan.object_end]
        try:
            if isinstance(json.loads(candidate), dict):
                return candidate
        except ValueError:
            pass
        pos = text.find("{", pos + scan.object_end)
    return None


def normalize_model_output(raw: str) -> str:
    """Reduce any model's raw reply to the text a parser should see.

    The one normalization every backend path runs before its first parse
    attempt. Each JSON-oriented step only fires when it actually finds an
    object, so a model that answered in prose comes back unchanged and stays a
    readable note.
    """
    text = _strip_think(raw).strip()
    fenced = _fenced_json(text)
    if fenced is not None:
        return fenced
    embedded = _first_balanced_object(text)
    return embedded if embedded is not None else text


def _looks_like_json_notes(text: str) -> bool:
    """True when a reply was *trying* to be the notes object rather than prose.

    Decides which failure the user is told about — and that a reply of this shape
    is never handed to them raw.
    """
    return text.lstrip().startswith("{") or '"sections"' in text


def _repair_truncated_json(text: str) -> dict | None:
    """Close a JSON object the model was cut off part-way through, or None.

    Tail truncation ONLY: everything emitted before the cut is kept verbatim, an
    unterminated string is closed, a member the model never finished is dropped
    whole (guessing its value would be inventing meeting content), and the scopes
    still open are closed in order. The repair is accepted only if the result
    parses to an object.
    """
    start = text.find("{")
    if start == -1:
        return None
    body = text[start:]
    for _ in range(_REPAIR_MAX_TRIMS):
        scan = _json_scan(body)
        if not scan.scopes and not scan.in_string:
            return None  # nothing left open — malformed, not cut off
        candidate = body
        if scan.in_string:
            if scan.escaped:
                candidate = candidate[:-1]  # a dangling \ would escape our quote
            candidate += '"'
        candidate = candidate.rstrip()
        if candidate.endswith(","):
            candidate = candidate[:-1]
        candidate += "".join("}" if s == "{" else "]" for s in reversed(scan.scopes))
        try:
            data = json.loads(candidate)
        except ValueError:
            if scan.last_boundary is None:
                return None
            body = body[: scan.last_boundary]
            continue
        if not isinstance(data, dict):
            return None
        logger.warning(
            "model output was truncated — repaired %d unclosed scopes", len(scan.scopes)
        )
        return data
    return None


# A transcript shorter than this (characters) plausibly had nothing to summarize:
# speech transcribes at ~900 chars/minute, so this is under two minutes of talk.
# ONLY such a recording may be blamed for empty notes — telling the owner of a
# 40-minute meeting that their transcript was "too short or sparse" sent them
# hunting the wrong bug (live 2026-08-10).
_SPARSE_TRANSCRIPT_CHARS = 1500


# Categories the summarizer LLM may assign (content-based). Superset of the
# heuristic's {meeting, youtube, brainstorm, other} — the extras get their own
# tag colours in the Rust category_tag mapping.
_LLM_CATEGORIES = {
    "meeting",
    "one_on_one",
    "interview",
    "standup",
    "brainstorm",
    "youtube",
    "other",
}


# Detected category → the prompt template that fits it. None = keep the
# requested template (no dedicated template exists / general is right).
_CATEGORY_TEMPLATES: dict[str, str] = {
    "youtube": "youtube",
    "brainstorm": "brainstorm",
    "one_on_one": "one-on-one",
    "interview": "interview",
}


def route_template(category: str) -> str | None:
    """Map a detected category to its dedicated prompt template, if any."""
    return _CATEGORY_TEMPLATES.get(category)


def resolve_category(hint: str | None, llm: str | None, heuristic: str) -> str:
    """Pick the final category by precedence: transcription-time mic-bleed hint
    (physical, wins) → the LLM's content classification → the ratio heuristic.

    The LLM understands *content* (a 1:1 vs an interview vs a watched video) far
    better than the me/them ratio, but it can't see mic bleed (stripped from the
    transcript), so a 'youtube' hint always overrides it. Pure — unit-testable.
    """
    if hint:
        return hint
    if llm:
        normalized = llm.strip().lower().replace("-", "_").replace(" ", "_")
        if normalized in _LLM_CATEGORIES:
            return normalized
    return heuristic


def neutralize_viewer_lines(transcript: str, viewer_label: str | None) -> str:
    """Replace the viewer's speaker labels with a neutral marker.

    Used for watched-video summaries: mic bleed puts the video's own audio
    under the viewer's name, and no prompt rule reliably stops the LLM from
    crediting the viewer as presenter — so the name is removed outright.
    """
    targets: set[str] = {"me"}
    if viewer_label:
        label = viewer_label.strip()
        if label:
            targets.add(label.lower())

    result: list[str] = []
    for line in transcript.splitlines():
        stripped = line.lstrip()
        if ":" in stripped:
            prefix = stripped.split(":", 1)[0]
            if len(prefix) <= 40 and prefix.strip().lower() in targets:
                indent = line[: len(line) - len(stripped)]
                body = stripped.split(":", 1)[1]
                result.append(f"{indent}Viewer mic (not the presenter):{body}")
                continue
        result.append(line)
    return "\n".join(result)


def classify_category(transcript: str) -> str:
    """Classify a recording from its speaker-labeled transcript.

    `Them:` and diarized `Speaker N:` lines are the remote/system audio; every
    other speaker-labeled line is the local user (labeled `Me:` or their name).
    Returns one of "meeting" | "youtube" | "brainstorm" | "other".
    """
    them_parts: list[str] = []
    me_parts: list[str] = []
    for line in transcript.splitlines():
        s = line.strip()
        if not s:
            continue
        speaker, sep, body = s.partition(":")
        sp = speaker.strip()
        # Remote side: flat "Them" or a diarized "Speaker N" label. (Without the
        # Speaker-N case, diarized system audio was counted as the local user,
        # inflating me_ratio — a watched video then classified as "brainstorm".)
        if (
            sep
            and len(sp) <= 20
            and (
                sp.lower() == "them"
                or re.fullmatch(r"speaker \d+", sp, flags=re.IGNORECASE)
            )
        ):
            them_parts.append(body.strip())
        elif sep and len(sp) <= 20 and " " not in sp:
            me_parts.append(body.strip())
        else:
            me_parts.append(s)
    me_text = " ".join(me_parts)
    them_text = " ".join(them_parts)
    me = len(me_text)
    them = len(them_text)
    total = them + me
    if total < 20:
        return "other"
    # Microphone bleed: when the mic ("Me") and system ("Them") channels carry
    # nearly the same words, the mic is just picking up audio playing through the
    # speakers — i.e. the user is *listening* to something (a video/podcast), not
    # in a two-way conversation. Real meetings have distinct content per side.
    me_words = {w for w in me_text.lower().split() if len(w) > 3}
    them_words = {w for w in them_text.lower().split() if len(w) > 3}
    if me_words and them_words:
        overlap = len(me_words & them_words) / len(me_words | them_words)
        if overlap >= 0.5:
            return "youtube"
        # Jaccard can't fire when the mic catches only a FRACTION of the
        # playback (small ∩ over a them-dominated ∪). Containment — how much of
        # what the mic heard is also on the system channel — is the right test
        # for asymmetric bleed. Corpus-calibrated 2026-07-04: every known
        # video/demo scores ≥ 0.83, the highest real meeting (an echoey
        # standup) 0.75; ≥ 8 words guards against tiny-sample noise.
        containment = len(me_words & them_words) / len(me_words)
        if containment >= 0.8 and len(me_words) >= 8:
            return "youtube"
    me_ratio = me / total
    if me_ratio >= 0.85:
        return "brainstorm"
    if me_ratio <= 0.15:
        return "youtube"
    return "meeting"


def _language_directive(language: str | None) -> str | None:
    """A system-prompt directive forcing the summary's output language.

    Returns None for the default (no directive — the model writes English).
    """
    if not language:
        return None
    lang = language.strip().lower()
    if lang in ("ar", "arabic"):
        return (
            "OUTPUT LANGUAGE: Write the ENTIRE output — the title, every section "
            "heading, and every bullet — in Arabic (Modern Standard Arabic), in "
            "Arabic script. Keep product names, acronyms, and technical terms in "
            "their original form when there is no common Arabic equivalent."
        )
    language_names = {
        "zh": "Simplified Chinese",
        "chinese": "Simplified Chinese",
        "simplified chinese": "Simplified Chinese",
        "hi": "Hindi, in Devanagari script",
        "hindi": "Hindi, in Devanagari script",
        "es": "Spanish",
        "spanish": "Spanish",
        "fr": "French",
        "french": "French",
        "bn": "Bengali, in Bengali script",
        "bengali": "Bengali, in Bengali script",
        "pt": "Portuguese",
        "portuguese": "Portuguese",
        "ru": "Russian, in Cyrillic script",
        "russian": "Russian, in Cyrillic script",
        "ur": "Urdu, in Arabic script",
        "urdu": "Urdu, in Arabic script",
    }
    language_name = language_names.get(lang)
    if language_name:
        return (
            "OUTPUT LANGUAGE: Write the ENTIRE output — the title, every section "
            f"heading, and every bullet — in {language_name}. Keep product names, "
            "acronyms, and technical terms in their original form when there is no "
            f"common {language_name} equivalent."
        )
    if lang in ("auto", "match"):
        return (
            "OUTPUT LANGUAGE: Write the entire output in the same language the "
            "meeting was primarily conducted in (infer it from the transcript)."
        )
    if lang in ("en", "english"):
        return "OUTPUT LANGUAGE: Write the entire output in English."
    return None


#: Weekday names indexed by ``date.weekday()``. Hard-coded rather than
#: ``strftime("%A")`` so the prompt never varies with the host's locale.
_WEEKDAYS = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)

#: Strict ISO calendar date. ``date.fromisoformat`` alone is too permissive on
#: Python 3.11+ (it accepts "20260807" and full datetimes).
_ISO_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _date_directive(meeting_date: str | None) -> str | None:
    """A one-line system-prompt directive stating the recording's date.

    Without it the model cannot turn a spoken "by Friday" into a real date.
    Returns None for anything that is not a well-formed ``YYYY-MM-DD`` — no
    date context is strictly better than a wrong one, and the prompt then looks
    exactly as it did before this field existed.
    """
    if not meeting_date:
        return None
    value = meeting_date.strip()
    if not _ISO_DATE_RE.fullmatch(value):
        return None
    try:
        day = date.fromisoformat(value)
    except ValueError:
        return None
    return (
        f"DATE CONTEXT: Today is {value} ({_WEEKDAYS[day.weekday()]}) — the date "
        "of this recording. Use it ONLY to resolve relative dates that were "
        'actually spoken in the transcript (e.g. "Friday", "next week"); never '
        "introduce a date that was not spoken."
    )


class OllamaSummarizer:
    """Summarizes meeting transcripts using Ollama with configurable prompt templates.

    Templates are loaded from the prompts/ directory as markdown files.
    Each template uses the {{transcript}} placeholder which is replaced
    with the actual transcript before sending to the LLM.
    """

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        host: str = "http://localhost:11434",
        backend: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self.model = model
        self.host = host.rstrip("/")
        # Caller may pass an explicit backend (the service does, per platform);
        # otherwise fall back to the env-driven module default ("ollama").
        self.backend = (backend or LLM_BACKEND).strip().lower()
        self.base_url = (base_url or LLM_BASE_URL).rstrip("/")
        self.api_key = api_key or LLM_API_KEY
        # Only the ollama backend needs the ollama client; for openai we use httpx.
        self.client = Client(host=self.host) if self.backend == "ollama" else None
        self._ollama_clients: dict[str, Client] = {}
        if self.client is not None:
            self._ollama_clients[self.host] = self.client
        logger.info(
            "Summarizer initialized: backend=%s model=%s ollama_host=%s openai_base=%s",
            self.backend,
            model,
            self.host,
            self.base_url,
        )

    def set_ollama_host(self, host: str) -> None:
        """Make an app-registered Ollama host the default local backend."""
        self.host = host.rstrip("/")
        self.backend = "ollama"
        self.client = self._ollama_client(self.host)

    def backend_available(self) -> bool:
        """True if the configured LLM backend is reachable (used by /health)."""
        try:
            if self.backend == "openai":
                resp = httpx.get(
                    f"{self.base_url}/models",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    timeout=3.0,
                )
                return resp.status_code == 200
            self._ollama_client().list()
            return True
        except Exception:
            return False

    def _load_template(self, name: str) -> str:
        """Load a prompt template from the prompts directory.

        Args:
            name: Template name without extension (e.g. 'general').

        Returns:
            The template content as a string.

        Raises:
            FileNotFoundError: If the template does not exist.
        """
        return load_prompt(name)

    @staticmethod
    def _extract_description(content: str) -> str:
        """Extract a short description from the first line of a template.

        Args:
            content: Full template text.

        Returns:
            The first sentence or line of the template as a description.
        """
        first_line = content.strip().split("\n")[0].rstrip(".")
        return first_line[:120]

    def list_templates(self) -> list[TemplateInfo]:
        """List all available prompt templates with descriptions.

        Returns:
            A list of TemplateInfo objects, one per template file.
        """
        templates: list[TemplateInfo] = []
        for name in list_template_files():
            content = self._load_template(name)
            description = self._extract_description(content)
            templates.append(TemplateInfo(name=name, description=description))
        return templates

    def _classify_category_llm(
        self,
        transcript: str,
        model: str | None,
        base_url: str | None,
        api_key: str | None,
    ) -> str | None:
        """Classify the meeting transcript into one category via a cheap one-word
        LLM call over the transcript head. Used only for template auto-routing;
        failures return ``None`` so routing always fails open."""
        try:
            excerpt = transcript[:4000]
            system = (
                "You classify a speaker-labeled meeting-transcript excerpt into "
                "exactly one category. Reply with ONE WORD only, chosen from: "
                "meeting, one_on_one, interview, standup, brainstorm, youtube, "
                "other. Definitions: interview = a job interview (one side asks "
                "about the other's experience, skills, and fit; the other answers); "
                "one_on_one = a private check-in between two colleagues or a "
                "manager and report; standup = a team status round; "
                "brainstorm = mostly one person thinking out loud or dumping ideas; "
                "youtube = the audio of a watched video, talk, or tutorial rather "
                "than a live conversation; meeting = any other live work meeting "
                "with multiple participants; other = anything else."
            )
            raw = self._chat(
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": excerpt},
                ],
                model=model or self.model,
                json_schema=None,
                base_url=base_url,
                api_key=api_key,
            )
            # A reasoning model answers this one-word question with a paragraph of
            # thinking in front of it; unstripped, every such model silently loses
            # auto-routing (the reply matches no category and routing fails open).
            normalized = (
                _strip_think(raw).strip().lower().replace("-", "_").replace(" ", "_")
            )
            # Strip surrounding punctuation / quotes (e.g. '"interview"').
            normalized = normalized.strip("\"'.,;:!?()[]{}<> \t")
            if normalized in _LLM_CATEGORIES:
                return normalized
            return None
        except Exception:
            logger.warning("Category classification LLM call failed", exc_info=True)
            return None

    @staticmethod
    def _instructions_only(template_content: str) -> str:
        """Strip any legacy ``{{transcript}}`` placeholder from a template.

        The transcript is now sent as a separate ``user`` message, so the
        template is used purely as the ``system`` instruction. Remove the
        placeholder and any trailing ``Transcript:`` heading / ``---`` rule
        left over from the old inline format so the transcript isn't implied
        twice.
        """
        text = template_content.replace("{{transcript}}", "")
        lines = text.rstrip().splitlines()
        while lines and lines[-1].strip().rstrip(":").strip().lower() in (
            "",
            "---",
            "transcript",
        ):
            lines.pop()
        return "\n".join(lines).strip()

    @staticmethod
    def _build_user_message(transcript: str) -> str:
        """Wrap the transcript in delimiters for the ``user`` message.

        Delimiters keep the model from confusing meeting content with the
        instructions and are a basic prompt-injection guard for untrusted
        transcript text.
        """
        return f"<transcript>\n{transcript.strip()}\n</transcript>"

    @staticmethod
    def _loads_lenient(text: str) -> dict | None:
        """Parse already-normalized model output (``normalize_model_output``) as a
        JSON object, repairing a reply the context window cut off.

        Returns None for a reply that was never a notes object (prose), or one
        JSON-shaped past saving — the caller decides what the user is told.
        """
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            data = None
        if data is not None:
            return data if isinstance(data, dict) else None
        if not _looks_like_json_notes(text):
            return None
        return _repair_truncated_json(text)

    @staticmethod
    def _was_truncated(normalized: str, reply_meta: dict) -> bool:
        """True when the reply was cut off rather than malformed: the backend said
        so (done_reason/finish_reason), or the JSON it emitted still has scopes
        open at the end, which only a cut can cause."""
        return bool(reply_meta.get("truncated")) or bool(_json_scan(normalized).scopes)

    @staticmethod
    def _no_notes_message(truncated: bool, transcript: str) -> str:
        """The note shown when the model's reply yielded nothing renderable.

        The diagnosis must match what actually happened: on 2026-08-10 a reply
        truncated at 16k on a long meeting was reported to its owner as "the
        transcript may be too short or sparse", which is only ever true of a
        genuinely short recording.
        """
        if truncated:
            return (
                "_The notes model's answer didn't fit its response window, so the "
                "notes came back incomplete. Try **Re-summarize** — or pick a less "
                "verbose model in Settings for long meetings._"
            )
        if len(transcript.strip()) < _SPARSE_TRANSCRIPT_CHARS:
            return (
                "_Couldn't extract structured notes from this recording — the "
                "transcript may be too short or sparse. Try **Re-summarize**, or "
                "pick the **Brainstorm → To-Dos** template for idea dumps._"
            )
        return (
            "_The notes model didn't return structured notes Adversaria could "
            "read — try **Re-summarize**, or a different model in Settings._"
        )

    @staticmethod
    def _attendee_str(item: object) -> str | None:
        """Coerce one attendee (dict ``{name, role}`` or bare string) to display."""
        if isinstance(item, str):
            return item.strip() or None
        if isinstance(item, dict):
            name = str(item.get("name", "")).strip()
            if not name:
                return None
            role = str(item.get("role") or "").strip()
            return f"{name} — {role}" if role else name
        return None

    @staticmethod
    def _attendee_details(
        data: dict, final_attendees: list[str]
    ) -> list[AttendeeDetail]:
        """Pair each final attendee with the role/company the model stated.

        ``final_attendees`` are display strings that may carry a role suffix
        ("Sarah — CTO"), while profiles are keyed on the bare name, so matching
        and the emitted name both use the part before the dash. Attendees the
        model said nothing about are skipped — there is nothing to prefill.
        """
        bare = {
            s.split("—")[0].strip().lower(): s.split("—")[0].strip()
            for s in final_attendees
        }
        out: list[AttendeeDetail] = []
        seen: set[str] = set()
        for item in data.get("attendees") or []:
            if not isinstance(item, dict):
                continue
            name = bare.get(str(item.get("name") or "").strip().lower())
            if not name or name in seen:
                continue
            role = _stated(item.get("role"))
            company = _stated(item.get("company"))
            if not role and not company:
                continue
            seen.add(name)
            out.append(AttendeeDetail(name=name, role=role, company=company))
        return out

    #: Top-level keys ``_render`` knows how to extract.
    _RENDERABLE_KEYS = ("title", "attendees", "sections")

    @classmethod
    def _unwrap_envelope(cls, data: dict) -> dict:
        """Descend into a single-level wrapper like ``{"meeting_notes": {...}}``.

        Some models (notably qwen3.6) ignore the ``format=`` schema and nest the
        real notes one level down under a wrapper key. If the top level has none
        of the keys we render but a nested dict does, return that inner dict so
        the rest of rendering proceeds normally.
        """
        if any(k in data for k in cls._RENDERABLE_KEYS):
            return data
        for value in data.values():
            if isinstance(value, dict) and any(
                k in value for k in cls._RENDERABLE_KEYS
            ):
                return value
        return data

    @staticmethod
    def _clean_title(title: str) -> str:
        """Strip the generic speaker labels 'Me'/'Them' from an LLM-generated
        title, e.g. 'Meeting with Hamza and Them' -> 'Meeting with Hamza', and
        tidy any dangling connectors. Falls back to the original if cleaning
        would empty it. Word-boundaried + case-insensitive (won't touch 'Theme').
        """
        if not title:
            return title
        t = re.sub(r"\s*\b(and|with|&|,)\s+(me|them)\b", "", title, flags=re.IGNORECASE)
        t = re.sub(r"\b(me|them)\b\s*(and|with|&|,)\s+", "", t, flags=re.IGNORECASE)
        t = re.sub(r"\b(me|them)\b", "", t, flags=re.IGNORECASE)
        t = re.sub(r"\s{2,}", " ", t).strip().strip(",&").strip()
        t = re.sub(r"\s+(and|with|&)$", "", t, flags=re.IGNORECASE).strip()
        return t or title

    @staticmethod
    def _ensure_followup_section(
        data: dict,
        prior_meetings: list[PriorMeeting],
        transcript: str,
    ) -> None:
        """Deterministic follow-up check on an attached previous meeting's open action items."""
        items: list[tuple[str, str, str]] = []
        p_idx = 1
        for m in prior_meetings:
            for item in m.open_items:
                items.append((f"P{p_idx}", m.title, item))
                p_idx += 1

        sections = data.get("sections")
        if not isinstance(sections, list):
            sections = []
            data["sections"] = sections

        found_section_idx: int | None = None
        bullets: list[str] = []

        for idx, sec in enumerate(sections):
            if not isinstance(sec, dict):
                continue
            heading = next(
                (
                    str(sec[key]).strip()
                    for key in ("heading", "title", "section", "name", "header")
                    if isinstance(sec.get(key), str) and sec[key].strip()
                ),
                "",
            )
            if _norm_text(heading).startswith("follow up from"):
                found_section_idx = idx
                raw_bullets = (
                    sec.get("bullets") or sec.get("items") or sec.get("points") or []
                )
                if isinstance(raw_bullets, list):
                    bullets = [
                        str(b).strip()
                        for b in raw_bullets
                        if isinstance(b, str) and b.strip()
                    ]
                break

        norm_transcript = _norm_text(transcript)
        final_bullets: list[str] = []
        done_count = 0
        discussed_count = 0
        still_open_count = 0
        downgraded_count = 0

        for i, (_tag, _meeting_title, text) in enumerate(items):
            tag_num = i + 1
            tag_pattern = re.compile(
                rf"(?:\[\s*P{tag_num}\s*\]|P{tag_num}\s*[:\]\)]|\(\s*P{tag_num}\s*\))",
                re.IGNORECASE,
            )
            candidate: str | None = None
            for b in bullets:
                if tag_pattern.search(b):
                    candidate = b
                    break

            if candidate is None:
                norm_text_prefix = _norm_text(text)[:30]
                if norm_text_prefix:
                    for b in bullets:
                        if norm_text_prefix in _norm_text(b):
                            candidate = b
                            break

            if (
                candidate is None
                and len(bullets) == len(items)
                and 0 <= i < len(bullets)
            ):
                candidate = bullets[i]

            status = "Still open"
            initially_claimed_done_or_discussed = False
            if candidate is not None:
                c_clean = candidate.replace("“", '"').replace("”", '"').strip()
                stripped = re.sub(r"^[-*•]\s*", "", c_clean)
                stripped = re.sub(
                    r"^(?:\[\s*P\d+\s*\]|P\d+\s*[:\]\)]|\(\s*P\d+\s*\))\s*[-—–:\.]?\s*",
                    "",
                    stripped,
                    flags=re.IGNORECASE,
                )
                matches = list(
                    re.finditer(
                        r"(?:^|[—–:\-\(\[]\s*)(done|resolved|completed|closed|discussed|in progress|still open|open|not discussed|not mentioned)\b",
                        stripped,
                        flags=re.IGNORECASE,
                    )
                )
                if matches:
                    kw = matches[-1].group(1).lower()
                    if kw in ("done", "resolved", "completed", "closed"):
                        status = "Done"
                        initially_claimed_done_or_discussed = True
                    elif kw in ("discussed", "in progress"):
                        status = "Discussed"
                        initially_claimed_done_or_discussed = True
                    else:
                        status = "Still open"
                else:
                    status = "Still open"

            grounded_span: str | None = None
            if status in ("Done", "Discussed") and candidate is not None:
                c_norm_quotes = candidate.replace("“", '"').replace("”", '"')
                spans = re.findall(r'"([^"]+)"', c_norm_quotes)
                for span in spans:
                    span_clean = span.strip()
                    if 3 <= len(span_clean) <= 200:
                        raw_fragments = re.split(
                            r"(?:\[\s*(?:\.\.\.|…)\s*\]|\.\s*\.\s*\.|\.{3,}|…)",
                            span_clean,
                        )
                        fragments = [f.strip() for f in raw_fragments if f.strip()]
                        if fragments and all(
                            len(_norm_text(f).split()) >= 3
                            and _norm_text(f) in norm_transcript
                            for f in fragments
                        ):
                            grounded_span = span_clean
                            break

                if grounded_span is None:
                    status = "Still open"
                    if initially_claimed_done_or_discussed:
                        downgraded_count += 1

            if status in ("Done", "Discussed") and grounded_span is not None:
                final_bullets.append(f'{status} — {text}: "{grounded_span}"')
                if status == "Done":
                    done_count += 1
                else:
                    discussed_count += 1
            else:
                final_bullets.append(f"{status} — {text}")
                still_open_count += 1

        for m in prior_meetings:
            if not m.open_items:
                final_bullets.append(
                    f"No open action items from {m.title} to follow up on."
                )

        if len(prior_meetings) == 1:
            clean_title = _clean_prior_title(prior_meetings[0].title)
            # Mirror the Rust to-do extractor's heading regex (storage.rs
            # `re_actionable`) so this heading can never be read as a to-do list.
            actionable = re.search(
                r"(?i)(action item|action point|next step|to[ -]?(?:do|build)|deliverable|task)",
                clean_title,
            )
            if clean_title and not actionable:
                heading = f"Follow-up from {clean_title}"
            else:
                heading = "Follow-up from previous meetings"
        else:
            heading = "Follow-up from previous meetings"

        if found_section_idx is not None:
            sections[found_section_idx] = {
                "heading": heading,
                "bullets": final_bullets,
            }
        else:
            notes_idx: int | None = None
            for idx, sec in enumerate(sections):
                if isinstance(sec, dict):
                    h = next(
                        (
                            str(sec[k]).strip()
                            for k in ("heading", "title", "section", "name", "header")
                            if isinstance(sec.get(k), str) and sec[k].strip()
                        ),
                        "",
                    )
                    if h.casefold() == "from your notes":
                        notes_idx = idx
                        break
            if notes_idx is not None:
                sections.insert(
                    notes_idx, {"heading": heading, "bullets": final_bullets}
                )
            else:
                sections.append({"heading": heading, "bullets": final_bullets})

        logger.info(
            "Follow-up check: items=%d done=%d discussed=%d still_open=%d downgraded=%d",
            len(items),
            done_count,
            discussed_count,
            still_open_count,
            downgraded_count,
        )

    @staticmethod
    def _ensure_user_notes_section(data: dict, notes: str) -> None:
        """Keep live user notes visible when a small model omits the requested
        ``From Your Notes`` section.

        The prompt asks the model to enrich the notes with transcript context,
        but 4B models occasionally skip the section entirely. In that case an
        honest verbatim fallback is better than silently losing the user's own
        writing. Existing model-generated sections are left untouched.
        """
        sections = data.get("sections")
        if not isinstance(sections, list):
            sections = []
            data["sections"] = sections
        for section in sections:
            if not isinstance(section, dict):
                continue
            heading = next(
                (
                    str(section[key]).strip()
                    for key in ("heading", "title", "section", "name", "header")
                    if isinstance(section.get(key), str) and section[key].strip()
                ),
                "",
            )
            if heading.casefold() == "from your notes":
                return

        bullets: list[str] = []
        for raw in notes.splitlines():
            line = raw.strip()
            line = re.sub(r"^(?:[-*•]\s+|\d+[.)]\s+)", "", line)
            line = re.sub(r"^\[[ xX]\]\s*", "", line).strip()
            if line:
                bullets.append(line)
        if bullets:
            sections.append({"heading": "From Your Notes", "bullets": bullets})

    @staticmethod
    def _ensure_accepted_items_section(
        data: dict, items: list[AcceptedLiveItem]
    ) -> None:
        """Reconcile user-confirmed live items into Decisions, Action Items, or Follow-ups.

        Finds the target section by heading casefold ('decisions', 'action items',
        'follow-ups'). If missing, creates it with the canonical heading ('Decisions',
        'Action Items', 'Follow-ups'), inserting Decisions and Action Items before
        Follow-ups (if present) else appending to the end, and appending Follow-ups.
        Deduplicates against existing bullets using normalized alphanumerics:
        equality, containment (one contains the other), or SequenceMatcher ratio >= 0.8.
        Placeholder bullets ('None mentioned', 'None') are replaced instead of
        appending after them. The operation is idempotent.
        """
        if not items:
            return

        sections = data.get("sections")
        if not isinstance(sections, list):
            sections = []
            data["sections"] = sections

        def _norm_alphanumeric(text: str) -> str:
            return " ".join(re.findall(r"[a-z0-9]+", text.lower()))

        def _is_placeholder(bullet: str) -> bool:
            return _norm_alphanumeric(bullet) in ("none mentioned", "none")

        def _matches(candidate: str, canonical: str, item_text: str) -> bool:
            c_cand = _norm_alphanumeric(candidate)
            if not c_cand or _is_placeholder(candidate):
                return False
            for target in (canonical, item_text):
                t_norm = _norm_alphanumeric(target)
                if not t_norm:
                    continue
                if (
                    c_cand == t_norm
                    or c_cand in t_norm
                    or t_norm in c_cand
                    or SequenceMatcher(None, c_cand, t_norm).ratio() >= 0.8
                ):
                    return True
            return False

        def _get_heading(sec: dict) -> str:
            return next(
                (
                    str(sec[k]).strip()
                    for k in ("heading", "title", "section", "name", "header")
                    if isinstance(sec.get(k), str) and sec[k].strip()
                ),
                "",
            )

        def _find_or_create_section(
            canonical_heading: str, target_cases: set[str]
        ) -> dict:
            for s in sections:
                if not isinstance(s, dict):
                    continue
                h = _get_heading(s)
                if h.casefold() in target_cases:
                    return s

            new_sec = {"heading": canonical_heading, "bullets": []}
            if canonical_heading == "Decisions":
                # Insert before Action Items if present, else before Follow-ups if present, else append
                insert_idx = None
                for idx, s in enumerate(sections):
                    if not isinstance(s, dict):
                        continue
                    h = _get_heading(s).casefold()
                    if h in (
                        "action items",
                        "action item",
                        "follow-ups",
                        "follow-up",
                        "follow ups",
                    ):
                        insert_idx = idx
                        break
                if insert_idx is not None:
                    sections.insert(insert_idx, new_sec)
                else:
                    sections.append(new_sec)
            elif canonical_heading == "Action Items":
                # Insert before Follow-ups if present, else append
                insert_idx = None
                for idx, s in enumerate(sections):
                    if not isinstance(s, dict):
                        continue
                    h = _get_heading(s).casefold()
                    if h in ("follow-ups", "follow-up", "follow ups"):
                        insert_idx = idx
                        break
                if insert_idx is not None:
                    sections.insert(insert_idx, new_sec)
                else:
                    sections.append(new_sec)
            else:
                sections.append(new_sec)
            return new_sec

        for item in items:
            kind = (item.kind or "").strip().lower()
            text = (item.text or "").strip()
            if not text:
                continue

            if kind == "decision":
                canonical_heading = "Decisions"
                target_cases = {"decisions", "decision"}
                canonical_bullet = text
            elif kind == "action":
                canonical_heading = "Action Items"
                target_cases = {"action items", "action item"}
                owner = (
                    item.owner.strip()
                    if item.owner and item.owner.strip()
                    else "Unassigned"
                )
                due_part = ""
                if item.due and item.due.strip():
                    due_clean = item.due.strip()
                    if re.match(r"^\d{4}-\d{2}-\d{2}$", due_clean):
                        due_part = f" — due {due_clean}"
                    else:
                        due_part = f" (due {due_clean})"
                canonical_bullet = f"{owner}: {text}{due_part}"
            elif kind == "question":
                canonical_heading = "Follow-ups"
                target_cases = {"follow-ups", "follow-up", "follow ups"}
                q_text = text
                if q_text.casefold().startswith("open question:"):
                    q_text = q_text[len("open question:"):].strip()
                canonical_bullet = f"Open question: {q_text}"
            else:
                continue

            target_sec = _find_or_create_section(canonical_heading, target_cases)
            bullets = next(
                (
                    target_sec[k]
                    for k in ("bullets", "points", "items", "content", "details")
                    if isinstance(target_sec.get(k), list)
                ),
                None,
            )
            if bullets is None:
                bullets = []
                target_sec["bullets"] = bullets

            # Check if any existing non-placeholder bullet matches
            if any(_matches(str(b), canonical_bullet, text) for b in bullets):
                continue

            # Replace placeholder bullet if one exists, else append
            placeholder_idx = next(
                (i for i, b in enumerate(bullets) if _is_placeholder(str(b))),
                None,
            )
            if placeholder_idx is not None:
                bullets[placeholder_idx] = canonical_bullet
                bullets[:] = [
                    b
                    for i, b in enumerate(bullets)
                    if i == placeholder_idx or not _is_placeholder(str(b))
                ]
            else:
                bullets.append(canonical_bullet)

    @classmethod
    def _render(cls, data: dict) -> tuple[str, str, list[str]]:
        """Render any reasonably-shaped notes JSON into (markdown, title, attendees).

        Tolerates the schema drift seen across models: notes may be nested under a
        single wrapper key; ``sections`` may be a list of ``{heading, bullets}``
        objects (with heading/bullets under various keys) or a flat list of bullet
        strings; ``attendees`` may be objects or strings. Anything unrenderable is
        skipped rather than failing.
        """
        data = cls._unwrap_envelope(data)
        title = data.get("title")
        title = title.strip() if isinstance(title, str) else ""
        title = cls._clean_title(title)

        attendees: list[str] = []
        for item in data.get("attendees") or []:
            label = cls._attendee_str(item)
            # Drop the generic dual-capture speaker labels — they aren't real
            # named attendees (Me = the local mic, Them = remote/system audio).
            if (
                label
                and label.strip().lower() not in ("me", "them")
                and label not in attendees
            ):
                attendees.append(label)

        parts: list[str] = []
        if attendees:
            parts.append(f"**Attendees:** {', '.join(attendees)}")

        loose: list[str] = []
        seen_headings: set[str] = set()
        for sec in data.get("sections") or []:
            if isinstance(sec, str):
                line = sec.strip()
                if line:
                    loose.append(line if line.startswith(("-", "*")) else f"- {line}")
                continue
            if not isinstance(sec, dict):
                continue
            heading = next(
                (
                    str(sec[k]).strip()
                    for k in ("heading", "title", "section", "name", "header")
                    if isinstance(sec.get(k), str) and sec[k].strip()
                ),
                "",
            )
            bullets = next(
                (
                    sec[k]
                    for k in ("bullets", "points", "items", "content", "details")
                    if isinstance(sec.get(k), list)
                ),
                None,
            )
            if heading:
                key = heading.casefold()
                if key in seen_headings:
                    continue
                seen_headings.add(key)
                parts.append(f"**{heading}**")
            if bullets:
                rendered = "\n".join(
                    f"- {str(b).strip()}" for b in bullets if str(b).strip()
                )
                parts.append(rendered or "None mentioned")
            elif heading:
                parts.append("None mentioned")
        if loose:
            parts.append("\n".join(loose))

        return "\n\n".join(p for p in parts if p).strip(), title, attendees

    def _chat(
        self,
        messages: list[dict],
        model: str,
        json_schema: dict | None,
        base_url: str | None = None,
        api_key: str | None = None,
        meta: dict | None = None,
    ) -> str:
        """Send a chat request to the configured backend; return raw text content.

        ``meta``, when given, is filled with what the request layer learned about
        the reply — ``{"truncated": bool, "num_ctx": int | None}`` — so a caller
        can tell an answer the context window cut off from one the model simply
        malformed. Only summarize() needs it; every other call site wants text.

        json_schema (when given) constrains the model to that JSON schema:
        Ollama uses ``format=schema``; OpenAI-compatible servers use
        ``response_format={"type":"json_schema", ...}``.

        When ``base_url`` is provided and non-empty, the request is routed
        through the OpenAI-compatible path with that URL and key, regardless of
        ``self.backend`` (supports per-request cloud provider overrides) —
        UNLESS the URL is the local Ollama /v1 surface, which is served by the
        native Ollama client so ``num_ctx`` applies (the OpenAI API can't carry
        it, and without it Ollama loads the model at its 262k model default).
        Otherwise, the default backend routing (``self.backend``) applies.
        """
        if _is_local_ollama_url(base_url):
            return self._chat_ollama(
                messages,
                model,
                json_schema,
                meta=meta,
                host=_normalize_local_ollama_host(base_url),
            )
        if base_url:
            return self._chat_openai(
                messages,
                model,
                json_schema,
                base_url=base_url,
                api_key=api_key,
                meta=meta,
            )
        if self.backend == "openai":
            return self._chat_openai(messages, model, json_schema, meta=meta)
        return self._chat_ollama(messages, model, json_schema, meta=meta)

    def _ollama_client(self, host: str | None = None) -> Client:
        """The native Ollama client, created lazily on the openai backend.

        The openai backend skips client construction at init, but a local
        Ollama base_url override still needs one (see ``_is_local_ollama_url``).
        """
        selected_host = (host or self.host).rstrip("/")
        client = self._ollama_clients.get(selected_host)
        if client is None:
            if selected_host == self.host and self.client is not None:
                client = self.client
            else:
                client = Client(host=selected_host)
            self._ollama_clients[selected_host] = client
        if selected_host == self.host:
            self.client = client
        return client

    def _chat_ollama(
        self,
        messages: list[dict],
        model: str,
        json_schema: dict | None,
        meta: dict | None = None,
        host: str | None = None,
    ) -> str:
        """One native-Ollama completion, retried once if the window cut it off.

        ``done_reason == "length"`` means the model was still writing when it ran
        out of context — the reply is a fragment, so re-ask with a bigger window
        instead of handing a half-written note downstream. Exactly one retry: a
        transcript that overruns twice needs a different model, not a third try.

        The first attempt is already sized to this prompt (``_adaptive_num_ctx``),
        so the retry is the safety net for a model more verbose than the output
        budget assumed — not the mechanism that makes long meetings work.
        """
        client = self._ollama_client(host)
        num_ctx = _adaptive_num_ctx(_prompt_chars(messages), model, client)
        response = self._chat_ollama_once(messages, model, json_schema, num_ctx, client)
        if _stop_reason(response) == "length":
            retry_ctx = _retry_num_ctx(num_ctx)
            logger.warning(
                "model hit the context window (num_ctx=%d) before finishing%s",
                num_ctx,
                f" — retrying once at num_ctx={retry_ctx}"
                if retry_ctx
                else " (already at the retry cap)",
            )
            if retry_ctx:
                num_ctx = retry_ctx
                response = self._chat_ollama_once(
                    messages, model, json_schema, num_ctx, client
                )
        if meta is not None:
            meta.update(truncated=_stop_reason(response) == "length", num_ctx=num_ctx)
        return response["message"]["content"]

    def _chat_ollama_once(
        self,
        messages: list[dict],
        model: str,
        json_schema: dict | None,
        num_ctx: int,
        client: Client,
    ) -> Any:
        """Issue one Ollama chat request; return the raw response (content + stop
        reason), which only _chat_ollama unpacks."""
        chat_kwargs = dict(
            model=model,
            messages=messages,
            options=_ollama_options(num_ctx),
        )
        if json_schema is not None:
            chat_kwargs["format"] = json_schema
        if _is_thinking_model(model):
            chat_kwargs["think"] = False
        try:
            response = client.chat(**chat_kwargs)
        except Exception as exc:
            if "think" in chat_kwargs:
                logger.warning(
                    "chat with think=False failed (%s) — retrying without.", exc
                )
                chat_kwargs.pop("think")
                try:
                    response = client.chat(**chat_kwargs)
                except Exception as exc2:
                    logger.error("Ollama request failed: %s", exc2)
                    raise RuntimeError(f"Ollama request failed: {exc2}") from exc2
            else:
                logger.error("Ollama request failed: %s", exc)
                raise RuntimeError(f"Ollama request failed: {exc}") from exc
        return response

    def _chat_openai(
        self,
        messages: list[dict],
        model: str,
        json_schema: dict | None,
        base_url: str | None = None,
        api_key: str | None = None,
        meta: dict | None = None,
    ) -> str:
        url = (base_url or self.base_url).rstrip("/")
        key = api_key or self.api_key or "EMPTY"

        def _build_body() -> dict:
            body: dict = {
                "model": model,
                "messages": messages,
                "temperature": 0.0,
            }
            # Disable Qwen3-style "thinking" on local vLLM/Rapid-MLX. This is a
            # vLLM extension, NOT an OpenAI-API field — cloud servers (Groq,
            # OpenAI) 400 on unknown params — so only send it to hosts we haven't
            # learned reject it.
            if url not in _NO_CHAT_TEMPLATE_KWARGS:
                body["chat_template_kwargs"] = {"enable_thinking": False}
            if json_schema is not None:
                # Prefer strict json_schema (local vLLM/Rapid-MLX enforces it);
                # hosts that reject it (DeepSeek, Groq qwen) fall back to the
                # widely-supported json_object. The summarize prompt already pins
                # the JSON shape, so json_object degrades cleanly.
                body["response_format"] = (
                    {
                        "type": "json_schema",
                        "json_schema": {"name": "MeetingNotes", "schema": json_schema},
                    }
                    if url not in _NO_JSON_SCHEMA
                    else {"type": "json_object"}
                )
            return body

        def _post() -> httpx.Response:
            return httpx.post(
                f"{url}/chat/completions",
                json=_build_body(),
                headers={"Authorization": f"Bearer {key}"},
                timeout=600.0,
            )

        resp: httpx.Response | None = None
        try:
            # Some OpenAI-compatible servers reject specific request fields with
            # HTTP 400 — Groq rejects chat_template_kwargs, then (for qwen)
            # json_schema. On each such 400, remember the offending field for this
            # host and retry without it; a few iterations cover the worst case.
            for _ in range(3):
                resp = _post()
                if resp.status_code == 400:
                    low = resp.text.lower()
                    if (
                        "chat_template_kwargs" in low
                        and url not in _NO_CHAT_TEMPLATE_KWARGS
                    ):
                        logger.warning(
                            "%s rejects chat_template_kwargs; retrying without it", url
                        )
                        _NO_CHAT_TEMPLATE_KWARGS.add(url)
                        continue
                    if (
                        "response_format" in low
                        and json_schema is not None
                        and url not in _NO_JSON_SCHEMA
                    ):
                        logger.warning(
                            "%s rejects json_schema response_format; retrying with json_object",
                            url,
                        )
                        _NO_JSON_SCHEMA.add(url)
                        continue
                break
            resp.raise_for_status()
            data = resp.json()
            choice = data["choices"][0]
            truncated = choice.get("finish_reason") == "length"
            if truncated:
                # Reported, not retried: the OpenAI chat API has no num_ctx knob
                # (that is why local Ollama is rerouted to the native client) and
                # we send no max_tokens, so re-asking would repeat the same call
                # against the same server-side limit. The reply still goes down
                # the repair ladder, and the note says what happened.
                logger.warning(
                    "model hit the context window before finishing "
                    "(finish_reason=length, host=%s) — no num_ctx to raise on this API",
                    url,
                )
            if meta is not None:
                meta.update(truncated=truncated, num_ctx=None)
            return choice["message"]["content"]
        except Exception as exc:
            # Surface the server's error body — it names the real cause (bad
            # model, unsupported param, auth) where raise_for_status alone only
            # gives the bare status line.
            detail = ""
            if resp is not None:
                try:
                    detail = f" — {resp.text[:300]}"
                except Exception:
                    detail = ""
            logger.error("OpenAI-compatible request failed: %s%s", exc, detail)
            raise RuntimeError(
                f"OpenAI-compatible request failed: {exc}{detail}"
            ) from exc

    def summarize(
        self,
        transcript: str,
        template_name: str = "general",
        model: str | None = None,
        output_language: str | None = None,
        user_notes: str | None = None,
        attached_context: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        known_attendees: list[str] | None = None,
        category_hint: str | None = None,
        auto_template: bool = False,
        viewer_label: str | None = None,
        meeting_date: str | None = None,
        prior_meetings: list[PriorMeeting] | None = None,
        accepted_live_items: list[AcceptedLiveItem] | None = None,
    ) -> SummarizeResponse:
        """Summarize a meeting transcript into grounded, structured notes.

        Uses Ollama structured output (the LLM is constrained to the
        ``MeetingNotes`` JSON schema), then renders Markdown for display and
        extracts the attendee list and a title.

        Args:
            transcript: The raw meeting transcript text.
            template_name: Name of the prompt template to use (e.g. 'general').
            model: Ollama model override; defaults to the summarizer's model.
            attached_context: User-attached reference material. It may resolve
                names and details but is never evidence of what this meeting said.
            base_url: When non-empty, route through the OpenAI-compatible path
                with this URL + api_key regardless of the default backend.
            api_key: API key for the cloud provider (used with base_url).
            known_attendees: Canonical participant names (e.g. from a calendar
                roster or user-edited attendee list). When non-empty, a
                directive is injected encouraging the LLM to use these exact
                spellings, and extracted names are grounded to the closest
                roster entry before deduplication.
            meeting_date: The recording's date as ISO ``YYYY-MM-DD``. When
                well-formed, a single date line is added to the system prompt so
                spoken relative deadlines resolve to absolute dates. Absent or
                malformed leaves the prompt untouched.
            accepted_live_items: Items confirmed by the user during the live
                meeting. Included under matching sections as traced facts.

        Returns:
            SummarizeResponse with markdown ``summary``, ``title``, and
            ``attendees`` (display strings).

        Raises:
            ValueError: If the transcript is empty or whitespace-only.
            FileNotFoundError: If the template does not exist.
            RuntimeError: If the Ollama request fails.
        """
        if not transcript.strip():
            raise ValueError("Transcript is empty.")

        # Category precedence (resolved after summarization below):
        #   1. category_hint — a transcription-time verdict from mic bleed, the
        #      strongest playback signal, stripped from the stored transcript so
        #      it can't be re-derived here. Physical, so it wins.
        #   2. the LLM's own content-based classification (data["category"]).
        #   3. the me/them-ratio heuristic, as a last-resort fallback.
        heuristic_category = classify_category(transcript)

        # ── template auto-routing ──────────────────────────────────────────
        # When the app passes the default template (no explicit user choice),
        # detect the recording's actual category and swap in the matching
        # dedicated prompt template (youtube→youtube, interview→interview, …).
        # Precedence mirrors resolve_category: category_hint > LLM > heuristic.
        # Fail-open: any routing error → proceed with the requested template.
        if auto_template and template_name == "general":
            pre_category = (
                category_hint
                or self._classify_category_llm(transcript, model, base_url, api_key)
                or heuristic_category
            )
            routed = route_template(pre_category)
            if routed and routed != template_name:
                try:
                    self._load_template(routed)
                except FileNotFoundError:
                    logger.warning(
                        "Auto-route: template %r missing — keeping %r",
                        routed,
                        template_name,
                    )
                else:
                    logger.info(
                        "Auto-routed template: category=%s template=%s",
                        pre_category,
                        routed,
                    )
                    template_name = routed

        # ── viewer-label neutralization ────────────────────────────────────
        # For youtube-template summaries, strip the viewer's speaker label
        # from the transcript before the LLM sees it. Mic bleed puts video
        # audio under the viewer's name, and no prompt rule reliably stops
        # the model from crediting them as presenter — remove the name.
        if template_name == "youtube":
            transcript = neutralize_viewer_lines(transcript, viewer_label)

        use_model = model or self.model
        logger.info(
            "Summarizing transcript: template=%s model=%s transcript_len=%d",
            template_name,
            use_model,
            len(transcript),
        )

        system_prompt = self._instructions_only(self._load_template(template_name))
        # Opt-in: only templates that SAY they use the date get it. A template
        # handed a "Today is …" line it has no rules for is being invited to do
        # something undefined with it (2026-08-03 review) — and most of the nine
        # templates say nothing about deadlines. Mentioning DATE CONTEXT is how a
        # template (including a user's own) declares it knows what to do.
        date_line = (
            _date_directive(meeting_date) if "DATE CONTEXT" in system_prompt else None
        )
        if date_line:
            system_prompt = f"{system_prompt}\n\n{date_line}"
        directive = _language_directive(output_language)
        if directive:
            system_prompt = f"{system_prompt}\n\n{directive}"

        roster = [n.strip() for n in (known_attendees or []) if n.strip()]
        if roster:
            roster_list = ", ".join(roster)
            system_prompt = (
                f"{system_prompt}\n\n"
                f"KNOWN PARTICIPANTS: {roster_list}. "
                "Attribute spoken lines to the closest of these canonical "
                "names; use these exact spellings; do NOT invent new attendee "
                "names or split one participant into spelling variants."
            )

        notes = (user_notes or "").strip()
        if notes:
            system_prompt = (
                f"{system_prompt}\n\n"
                "USER NOTES: The user jotted rough notes live during the meeting "
                "(provided in the <user_notes> block of the user message). Treat "
                "them as strong signals of what mattered most: make sure the "
                "summary captures and organizes around those points, expanding "
                "them with supporting detail FROM THE TRANSCRIPT. Still ground "
                "every fact in the transcript — never invent support for a note "
                "that the transcript doesn't back up. IN ADDITION, append one "
                'extra FINAL section titled exactly "From Your Notes" with one '
                "bullet per distinct note: restate the note clearly (fix "
                "typos/shorthand, keep its meaning), and where the transcript "
                "covers it add the key supporting detail after an em dash. These "
                "are the user's own annotations — include every one of them even "
                "when the transcript never mentions it (do NOT invent transcript "
                "support; just keep the note as written)."
            )

        accepted = list(accepted_live_items or [])
        if accepted:
            system_prompt = (
                f"{system_prompt}\n\n"
                "Items inside <accepted_live_items> were confirmed by the user "
                "during the meeting. Treat them as traced facts: include each "
                "one under the matching section (decision → Decisions, action → "
                "Action Items, question → Follow-ups) with its wording, owner and "
                "due date unchanged, and never drop or contradict them."
            )

        prior = [m for m in (prior_meetings or [])]

        context = (attached_context or "").strip()
        if context:
            system_prompt = (
                f"{system_prompt}\n\n"
                "ATTACHED CONTEXT: The material in the <attached_context> block "
                "of the user message is reference/background the user attached. "
                "Use it to resolve names, context, and details, but NEVER treat it "
                "as something said in this meeting. Claims about what happened or "
                "was said in this meeting must stay grounded in the transcript."
            )

        if prior:
            system_prompt = (
                f"{system_prompt}\n\n"
                "PRIOR MEETING FOLLOW-UP: The <prior_open_items> block of the "
                "user message lists open action items from an earlier meeting the "
                'user attached. Append one extra FINAL section titled exactly "Follow-up '
                'from previous meeting" (when a "From Your Notes" section is also '
                'requested, put "Follow-up from previous meeting" before it) with '
                "exactly one bullet per listed item, in the listed order, each bullet "
                "starting with the item's [P#] tag. After the tag write one of three "
                'statuses: "Done — " when the transcript explicitly says the item was '
                'completed, "Discussed — " when the transcript talks about the item '
                'without completing it, or "Still open — " when the transcript never '
                'mentions it. For "Done" and "Discussed", write the item text, then a '
                "colon, then a 3–12 word quote copied verbatim from the transcript inside "
                'double quotes. Never write "Done" or "Discussed" without such a verbatim '
                'quote. If the transcript does not mention an item, write only "Still open — " '
                "and the item text. Do not turn these items into new Action Items unless "
                "the transcript assigns them again."
            )

        # Pin the exact JSON shape in the prompt. Local vLLM/Rapid-MLX enforces it
        # via response_format=json_schema, but cloud servers like DeepSeek don't
        # support json_schema (we fall back to json_object), so without this the
        # model's shape drifts run-to-run — `sections` came back as bare strings,
        # which render as empty headings. Spelling out the structure (without
        # naming sections — the template above already lists them) keeps the
        # output renderable on every backend.
        system_prompt = (
            f"{system_prompt}\n\n"
            "Return ONLY a single JSON object with EXACTLY this structure — no "
            "prose, no markdown fences, no extra keys:\n"
            '{"title": "<short specific title>", '
            '"category": "<meeting|one_on_one|interview|standup|brainstorm|youtube|other>", '
            '"attendees": [{"name": "<Full Name>", "role": "<stated role or null>", '
            '"company": "<stated company or null>"}], '
            '"sections": [{"heading": "<one of the section names listed above>", '
            '"bullets": ["<specific point from the transcript>", "..."]}]}\n'
            "Include every section listed above, in that order, each as its own "
            'object. Every element of "sections" MUST be an object with a '
            '"heading" string and a "bullets" array of strings — NEVER a bare '
            "string. Fill bullets with specific content from the transcript; if a "
            'section genuinely has nothing, use ["None mentioned"].'
        )

        user_message = self._build_user_message(transcript)
        if notes:
            user_message = f"{user_message}\n\n<user_notes>\n{notes}\n</user_notes>"
        if context:
            user_message = (
                f"{user_message}\n\n<attached_context>\n{context}\n</attached_context>"
            )
        if accepted:
            items_lines = "\n".join(
                f"{item.kind} | {item.owner or '-'} | {item.due or '-'} | {item.text}"
                for item in accepted
            )
            user_message = f"{user_message}\n\n<accepted_live_items>\n{items_lines}\n</accepted_live_items>"
        if prior:
            prior_blocks: list[str] = []
            p_idx = 1
            for m in prior:
                date_part = f" ({m.date})" if m.date and m.date.strip() else ""
                prior_blocks.append(f"Meeting: {m.title}{date_part}")
                if m.open_items:
                    for item in m.open_items:
                        prior_blocks.append(f"- [P{p_idx}] {item}")
                        p_idx += 1
                else:
                    prior_blocks.append("(no open action items)")
            prior_content = "\n".join(prior_blocks)
            user_message = f"{user_message}\n\n<prior_open_items>\n{prior_content}\n</prior_open_items>"
        if directive:
            # Same-script languages (es/fr/pt/…) lose to the English template by
            # recency: the directive sits FIRST (system prompt) while the English
            # template + transcript are the LAST thing the model reads — and the
            # JSON-shape pin above even says to reuse "the section names listed
            # above" verbatim. Arabic survived that conflict on script momentum;
            # Spanish stayed English even on a 35B model (founder-reproduced,
            # 2026-08-13). Repeat the directive as the final instruction and
            # resolve the heading conflict explicitly.
            language = (output_language or "").strip().lower()
            if language in ("en", "english"):
                heading_instruction = (
                    "Use every section heading exactly as written in the template; "
                    "do not rename or translate the headings."
                )
            else:
                heading_instruction = (
                    "This applies to the JSON too: write each section heading as the "
                    "template section's translation into the required output language "
                    "(same order, same meaning) — do not reuse the English section "
                    "names verbatim."
                )
            user_message = f"{user_message}\n\n{directive}\n{heading_instruction}"

        reply_meta: dict = {}
        raw_output = self._chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            model=use_model,
            json_schema=MeetingNotes.model_json_schema(),
            base_url=base_url,
            api_key=api_key,
            meta=reply_meta,
        )

        normalized = normalize_model_output(raw_output)
        data = self._loads_lenient(normalized)
        if data is None:
            if _looks_like_json_notes(normalized):
                # A JSON-shaped reply that never parsed is a failure of the model
                # or its window, not a note. Dumping the blob is exactly what put
                # raw JSON in someone's meeting note (live 2026-08-10).
                truncated = self._was_truncated(normalized, reply_meta)
                logger.warning(
                    "Model output was JSON-shaped but unparseable (truncated=%s) — "
                    "returning an honest failure, not the blob. raw=%.200r",
                    truncated,
                    raw_output,
                )
                return SummarizeResponse(
                    summary=self._no_notes_message(truncated, transcript),
                    template_used=template_name,
                    category=category_hint or heuristic_category,
                )
            # Genuine prose — the model wrote a readable note instead of JSON.
            # Keep it: a readable note beats an error.
            logger.warning(
                "Model output was not JSON — using the prose reply as the note."
            )
            return SummarizeResponse(
                summary=normalized.strip(),
                template_used=template_name,
                category=category_hint or heuristic_category,
            )

        data = self._unwrap_envelope(data)
        if prior:
            self._ensure_followup_section(data, prior, transcript)
        if notes:
            self._ensure_user_notes_section(data, notes)
        if accepted:
            self._ensure_accepted_items_section(data, accepted)

        category = resolve_category(
            category_hint, data.get("category"), heuristic_category
        )

        markdown, title, attendees = self._render(data)

        # Post-extraction attendee cleanup: ground to roster (if known), then
        # deduplicate deterministically.
        if roster:
            attendees = ground_to_roster(attendees, roster)
        attendees = dedupe_attendees(attendees)

        if not markdown:
            # The model returned JSON that didn't match the notes shape (e.g. a
            # bare attendee object on a very sparse transcript). Never surface raw
            # JSON to the user — show a clear, actionable placeholder instead.
            logger.warning(
                "Rendered notes were empty (unrecognized JSON shape); returning a "
                "placeholder instead of raw JSON. raw=%.200r",
                raw_output,
            )
            markdown = self._no_notes_message(
                self._was_truncated(normalized, reply_meta), transcript
            )
        logger.info(
            "Summarization complete: template=%s attendees=%d md_chars=%d",
            template_name,
            len(attendees),
            len(markdown),
        )
        return SummarizeResponse(
            summary=markdown,
            template_used=template_name,
            title=title,
            attendees=attendees,
            category=category,
            attendee_details=self._attendee_details(data, attendees),
        )

    def generate_template(
        self,
        description: str,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        example_template: str = "general",
    ) -> str:
        """Write a new note template from a plain-language description.

        Free-text (not schema-constrained): the product of this call IS a prompt,
        so forcing it through the summarize JSON schema would mean smuggling
        markdown out through a string field.

        A real bundled template is passed as the example on purpose. Templates are
        not free-form writing instructions — they must emit the structured-notes
        shape that `storage.rs::extract_action_items` parses into to-do rows, so a
        template invented from scratch produces notes that look right and silently
        stop populating the to-do board. Showing the model a working template is
        what keeps that contract.

        Args:
            description: What the user wants the notes to look like.
            model: Model override; defaults to the summarizer's model.
            base_url: When non-empty, route through the OpenAI-compatible path.
            api_key: Credential for that path.
            example_template: Name of the bundled template to show as the example.

        Returns:
            The generated template body, ready to review and save. Never written
            to disk here — the user names and saves it.
        """
        if not description.strip():
            raise ValueError("Describe the notes you want before generating.")

        try:
            example = load_prompt(example_template)
        except Exception:  # noqa: BLE001 - a missing example must not block the feature
            logger.warning(
                "Example template %r unavailable; generating without one.",
                example_template,
            )
            example = ""

        use_model = model or self.model
        logger.info(
            "Generate template: model=%s description_len=%d example=%s",
            use_model,
            len(description),
            example_template if example else "none",
        )

        system = (
            "You write system prompts ('templates') for a meeting-notes app. "
            "A template instructs a smaller model how to turn a meeting transcript "
            "into structured notes.\n\n"
            "Rules:\n"
            "1. Copy the STRUCTURE and output contract of the example exactly — the "
            "same headings, the same bullet shape, the same action-item format. The "
            "app parses those to build a to-do list; changing the shape breaks it.\n"
            "2. Change only what the user asked for: the sections, the emphasis, the "
            "tone, what to include or leave out.\n"
            "3. Keep every anti-invention rule from the example. The notes must never "
            "state anything the transcript does not support.\n"
            "4. Output ONLY the template text. No preamble, no explanation, no code "
            "fences."
        )
        user = (
            f"EXAMPLE TEMPLATE (follow its structure):\n\n{example}\n\n"
            f"END OF EXAMPLE.\n\n"
            f"Write a new template for this request:\n\n{description.strip()}"
            if example
            else f"Write a note template for this request:\n\n{description.strip()}"
        )

        raw = self._chat(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            model=use_model,
            json_schema=None,
            base_url=base_url,
            api_key=api_key,
        )
        template = _strip_think(raw).strip()
        # Models wrap prose in fences even when told not to; the fence would end up
        # inside the saved prompt.
        template = re.sub(r"^```[a-zA-Z]*\n?", "", template)
        template = re.sub(r"\n?```$", "", template).strip()
        # A leading/trailing horizontal rule is an echoed delimiter, not content.
        template = re.sub(r"^(?:-{3,}|\*{3,}|={3,})\s*\n", "", template)
        template = re.sub(r"\n\s*(?:-{3,}|\*{3,}|={3,})$", "", template).strip()
        if not template:
            raise RuntimeError(
                "The model returned an empty template — please try again, or "
                "describe the notes you want in more detail."
            )
        return template

    def chat(
        self,
        transcript: str,
        question: str,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> ChatResponse:
        """Answer a question about a meeting, grounded strictly in its transcript.

        Free-text (not schema-constrained) so the model can answer naturally, but
        the system prompt forbids using any knowledge outside the transcript.

        Args:
            transcript: The meeting transcript to ground the answer in.
            question: The user's question.
            model: Ollama model override; defaults to the summarizer's model.
            base_url: When non-empty, route through the OpenAI-compatible path
                with this URL + api_key regardless of the default backend.
            api_key: API key for the cloud provider (used with base_url).

        Returns:
            ChatResponse with the model's ``answer``.

        Raises:
            ValueError: If the transcript or question is empty/whitespace-only.
            RuntimeError: If the Ollama request fails.
        """
        if not transcript.strip():
            raise ValueError("Transcript is empty.")
        if not question.strip():
            raise ValueError("Question is empty.")

        use_model = model or self.model
        logger.info(
            "Chat: model=%s transcript_len=%d question_len=%d",
            use_model,
            len(transcript),
            len(question),
        )

        raw = self._chat(
            messages=self._chat_messages(transcript, question),
            model=use_model,
            json_schema=None,
            base_url=base_url,
            api_key=api_key,
        )
        answer = _strip_think(raw).strip()
        if not answer:
            raise RuntimeError(
                "The local model returned an empty answer (it may have been "
                "interrupted under load) — please try again."
            )
        return ChatResponse(answer=answer)

    def _chat_messages(self, transcript: str, question: str) -> list[dict]:
        """Build the grounded chat messages shared by chat() and chat_stream()."""
        system_prompt = (
            "You answer questions about a single meeting using ONLY the transcript "
            "provided by the user. Ground every statement in the transcript. If the "
            "answer is not present in the transcript, say you don't know rather than "
            "guessing or using outside knowledge. "
            "When the user asks for analysis, evaluation, or an opinion (e.g. how someone "
            "performed, how a conversation went), give a concise assessment based solely on "
            "what was said in the transcript — point to the moments that support it, and "
            "present it as your reading of the transcript, not as fact. "
            "Be concise and direct. When useful, "
            "quote or paraphrase what a speaker actually said. The transcript is "
            "speaker-labeled (Me = the user, Them = the other participants)."
        )
        user_message = (
            f"{self._build_user_message(transcript)}\n\nQuestion: {question.strip()}"
        )
        return [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ]

    def chat_stream(
        self,
        transcript: str,
        question: str,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
    ):
        """Like chat(), but yields the answer token-by-token for live streaming.

        Yields str deltas. Routes to the OpenAI-compatible or Ollama streaming
        backend the same way _chat() dispatches.
        """
        if not transcript.strip():
            raise ValueError("Transcript is empty.")
        if not question.strip():
            raise ValueError("Question is empty.")
        use_model = model or self.model
        messages = self._chat_messages(transcript, question)
        yield from _strip_think_stream(
            self._stream_messages(messages, use_model, base_url, api_key)
        )

    def copilot_stream(
        self,
        system_prompt: str,
        user_text: str,
        model: str | None,
        base_url: str | None,
        api_key: str | None,
        control: StreamControl,
        provider: str = "local",
    ) -> Iterator[CopilotStreamEvent]:
        """Stream Copilot deltas plus one authoritative terminal usage event."""
        if not system_prompt.strip():
            raise ValueError("System prompt is empty.")
        if not user_text.strip():
            raise ValueError("User text is empty.")
        use_model = model or self.model
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ]
        if provider == "local":
            endpoint = validate_copilot_local_endpoint(base_url, api_key)
            upstream = (
                self._copilot_ollama_stream(messages, use_model, base_url, control)
                if endpoint == "ollama"
                else self._copilot_openai_stream(
                    messages,
                    use_model,
                    base_url=base_url,
                    api_key=api_key,
                    control=control,
                    provider="local",
                )
            )
        elif provider == "deepseek":
            endpoint = validate_copilot_deepseek_endpoint(base_url)
            if not (api_key or "").strip():
                raise ValueError("DeepSeek API key missing")
            upstream = self._copilot_openai_stream(
                messages,
                use_model,
                base_url=endpoint,
                api_key=api_key,
                control=control,
                provider="deepseek",
            )
        else:
            raise ValueError("Unsupported Copilot streaming provider")
        yield from self._strip_copilot_think_stream(upstream)

    @staticmethod
    def _strip_copilot_think_stream(
        events: Iterator[CopilotStreamEvent],
    ) -> Iterator[CopilotStreamEvent]:
        """Remove a leading reasoning block without losing terminal metadata."""
        buffer = ""
        passthrough = False
        for event in events:
            if event.kind != "delta":
                if (
                    not passthrough
                    and buffer
                    and not _THINK_OPEN_RE.match(buffer.lstrip())
                ):
                    yield CopilotStreamEvent("delta", text=buffer)
                yield event
                return
            if passthrough:
                yield event
                continue
            buffer += event.text
            stripped = buffer.lstrip()
            if not stripped:
                continue
            if _THINK_OPEN_RE.match(stripped):
                closer = _THINK_CLOSE_RE.search(buffer)
                if closer:
                    tail = buffer[closer.end() :].lstrip()
                    buffer = ""
                    passthrough = True
                    if tail:
                        yield CopilotStreamEvent("delta", text=tail)
            elif not "<thinking>".startswith(
                stripped.lower()
            ) and not "<think>".startswith(stripped.lower()):
                passthrough = True
                yield CopilotStreamEvent("delta", text=buffer)
                buffer = ""

    def _copilot_openai_stream(
        self,
        messages: list[dict],
        model: str,
        base_url: str | None,
        api_key: str | None,
        control: StreamControl,
        provider: str = "local",
    ) -> Iterator[CopilotStreamEvent]:
        """Strict OpenAI-compatible Copilot stream; EOF is never success."""
        url = (base_url or self.base_url).rstrip("/")
        key = api_key or self.api_key or "EMPTY"
        deadline = time.monotonic() + COPILOT_TIMEOUT_SECONDS
        deepseek = provider == "deepseek"
        early_error = DEEPSEEK_STREAM_EARLY if deepseek else LOCAL_STREAM_EARLY
        timeout_error = DEEPSEEK_STREAM_TIMEOUT if deepseek else LOCAL_STREAM_TIMEOUT
        provider_error = DEEPSEEK_STREAM_PROVIDER if deepseek else LOCAL_STREAM_PROVIDER

        def body() -> dict:
            request: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "temperature": 0.0,
                "stream": True,
                "max_tokens": COPILOT_MAX_TOKENS,
                "stream_options": {"include_usage": True},
            }
            if deepseek:
                request["thinking"] = {"type": "disabled"}
            elif url not in _NO_CHAT_TEMPLATE_KWARGS:
                request["chat_template_kwargs"] = {"enable_thinking": False}
            return request

        input_tokens = 0
        output_tokens = 0
        stop_seen = False
        # Copilot traffic must never inherit an HTTP(S)_PROXY or follow a
        # redirect to a different endpoint.
        client = httpx.Client(trust_env=False, follow_redirects=False)
        registration = control.register(client.close)
        try:
            for _ in range(2):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CopilotStreamError(timeout_error, "timeout")
                with client.stream(
                    "POST",
                    f"{url}/chat/completions",
                    json=body(),
                    headers={"Authorization": f"Bearer {key}"},
                    timeout=remaining,
                ) as response:
                    if response.status_code == 400:
                        response.read()
                        if (
                            not deepseek
                            and "chat_template_kwargs" in response.text.lower()
                            and url not in _NO_CHAT_TEMPLATE_KWARGS
                        ):
                            _NO_CHAT_TEMPLATE_KWARGS.add(url)
                            continue
                    if deepseek and response.status_code in (401, 403):
                        response.read()
                        raise CopilotStreamError(
                            "DeepSeek rejected the API key.", "provider"
                        )
                    if deepseek and response.status_code == 429:
                        response.read()
                        raise CopilotStreamError(
                            "DeepSeek rate limit, try again shortly.", "provider"
                        )
                    if response.status_code >= 400:
                        response.read()
                        raise CopilotStreamError(provider_error, "provider")
                    for line in response.iter_lines():
                        if time.monotonic() >= deadline:
                            raise CopilotStreamError(timeout_error, "timeout")
                        if not line:
                            continue
                        if not line.startswith("data:"):
                            continue
                        data = line[len("data:") :].strip()
                        if data == "[DONE]":
                            if not stop_seen:
                                raise CopilotStreamError(early_error, "ended_early")
                            yield CopilotStreamEvent(
                                "done",
                                input_tokens=input_tokens,
                                output_tokens=output_tokens,
                            )
                            return
                        try:
                            payload = json.loads(data)
                        except json.JSONDecodeError as exc:
                            raise CopilotStreamError(
                                early_error, "ended_early"
                            ) from exc
                        if not isinstance(payload, dict):
                            raise CopilotStreamError(early_error, "ended_early")
                        usage = payload.get("usage")
                        if usage is not None:
                            if not isinstance(usage, dict):
                                raise CopilotStreamError(early_error, "ended_early")
                            input_tokens = _nonnegative_int(
                                usage.get("prompt_tokens") or usage.get("input_tokens")
                            )
                            output_tokens = _nonnegative_int(
                                usage.get("completion_tokens")
                                or usage.get("output_tokens")
                            )
                        choices = payload.get("choices", [])
                        if not isinstance(choices, list):
                            raise CopilotStreamError(early_error, "ended_early")
                        for choice in choices:
                            if not isinstance(choice, dict):
                                raise CopilotStreamError(early_error, "ended_early")
                            finish_reason = choice.get("finish_reason")
                            if finish_reason == "length":
                                raise CopilotStreamError(LOCAL_STREAM_LENGTH, "length")
                            if finish_reason == "stop":
                                stop_seen = True
                            delta_payload = choice.get("delta", {})
                            if delta_payload is None:
                                delta_payload = {}
                            if not isinstance(delta_payload, dict):
                                raise CopilotStreamError(early_error, "ended_early")
                            delta = delta_payload.get("content")
                            if delta is not None and not isinstance(delta, str):
                                raise CopilotStreamError(early_error, "ended_early")
                            if delta:
                                yield CopilotStreamEvent("delta", text=delta)
                    raise CopilotStreamError(early_error, "ended_early")
            raise CopilotStreamError(provider_error, "provider")
        except httpx.TimeoutException as exc:
            raise CopilotStreamError(timeout_error, "timeout") from exc
        except httpx.HTTPError as exc:
            raise CopilotStreamError(provider_error, "transport") from exc
        finally:
            if control.unregister(registration):
                try:
                    client.close()
                except Exception:
                    pass

    def _copilot_ollama_stream(
        self,
        messages: list[dict],
        model: str,
        base_url: str | None,
        control: StreamControl,
    ) -> Iterator[CopilotStreamEvent]:
        """Strict Ollama Copilot stream with bounded generation and timeout."""
        host = _normalize_local_ollama_host(base_url)
        client = Client(
            host=host or self.host,
            timeout=COPILOT_TIMEOUT_SECONDS,
            trust_env=False,
            follow_redirects=False,
        )
        registration = control.register(client.close)
        try:
            options = _ollama_options(COPILOT_NUM_CTX)
            options["num_predict"] = COPILOT_MAX_TOKENS
            options["keep_alive"] = "30m"
            kwargs: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "stream": True,
                "options": options,
                "keep_alive": "30m",
            }
            if _is_thinking_model(model):
                kwargs["think"] = False
            deadline = time.monotonic() + COPILOT_TIMEOUT_SECONDS
            for chunk in client.chat(**kwargs):
                if time.monotonic() >= deadline:
                    raise CopilotStreamError(LOCAL_STREAM_TIMEOUT, "timeout")
                piece = chunk.get("message", {}).get("content")
                if piece:
                    yield CopilotStreamEvent("delta", text=piece)
                if chunk.get("done") is True:
                    reason = _stop_reason(chunk)
                    if reason == "length":
                        raise CopilotStreamError(LOCAL_STREAM_LENGTH, "length")
                    if reason != "stop":
                        raise CopilotStreamError(LOCAL_STREAM_EARLY, "ended_early")
                    yield CopilotStreamEvent(
                        "done",
                        input_tokens=_nonnegative_int(chunk.get("prompt_eval_count")),
                        output_tokens=_nonnegative_int(chunk.get("eval_count")),
                    )
                    return
            raise CopilotStreamError(LOCAL_STREAM_EARLY, "ended_early")
        except httpx.TimeoutException as exc:
            raise CopilotStreamError(LOCAL_STREAM_TIMEOUT, "timeout") from exc
        finally:
            if control.unregister(registration):
                try:
                    client.close()
                except Exception:
                    pass

    def _stream_messages(
        self,
        messages,
        use_model,
        base_url=None,
        api_key=None,
    ):
        """Dispatch a prepared message list to the configured streaming backend."""
        # Same dispatch as _chat(): a local Ollama base_url is served natively
        # so num_ctx applies; any other base_url (or openai backend) streams
        # over the OpenAI-compatible path.
        if _is_local_ollama_url(base_url):
            return self._chat_ollama_stream(
                messages, use_model, host=_normalize_local_ollama_host(base_url)
            )
        if base_url or self.backend == "openai":
            return self._chat_openai_stream(
                messages, use_model, base_url=base_url, api_key=api_key
            )
        return self._chat_ollama_stream(messages, use_model)

    def draft_stream(
        self,
        brief: str,
        instruction: str,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
    ):
        """Stream a drafted document (token deltas) for a workspace task brief."""
        if not brief.strip():
            raise ValueError("Brief is empty.")
        if not instruction.strip():
            raise ValueError("Instruction is empty.")
        messages = [
            {"role": "system", "content": DRAFT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"{brief.strip()}\n\n# Instruction\n\n{instruction.strip()}",
            },
        ]
        yield from _strip_think_stream(
            self._stream_messages(messages, model or self.model, base_url, api_key)
        )

    def _chat_openai_stream(self, messages, model, base_url=None, api_key=None):
        """Stream content deltas from an OpenAI-compatible /chat/completions SSE."""
        url = (base_url or self.base_url).rstrip("/")
        key = api_key or self.api_key or "EMPTY"

        def _body() -> dict:
            b: dict = {
                "model": model,
                "messages": messages,
                "temperature": 0.0,
                "stream": True,
            }
            # See _chat_openai: cloud servers (Groq) 400 on this vLLM-only param.
            if url not in _NO_CHAT_TEMPLATE_KWARGS:
                b["chat_template_kwargs"] = {"enable_thinking": False}
            return b

        for _ in range(2):
            with httpx.stream(
                "POST",
                f"{url}/chat/completions",
                json=_body(),
                headers={"Authorization": f"Bearer {key}"},
                timeout=600.0,
            ) as resp:
                if resp.status_code == 400:
                    resp.read()
                    if (
                        "chat_template_kwargs" in resp.text.lower()
                        and url not in _NO_CHAT_TEMPLATE_KWARGS
                    ):
                        logger.warning(
                            "%s rejects chat_template_kwargs; retrying without it", url
                        )
                        _NO_CHAT_TEMPLATE_KWARGS.add(url)
                        continue
                if resp.status_code >= 400:
                    resp.read()
                    raise RuntimeError(
                        f"LLM stream error {resp.status_code}: {resp.text[:300]}"
                    )
                for line in resp.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if data == "[DONE]":
                        break
                    try:
                        delta = (
                            json.loads(data)["choices"][0]
                            .get("delta", {})
                            .get("content")
                        )
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
                    if delta:
                        yield delta
                return

    def _chat_ollama_stream(self, messages, model, host=None):
        """Stream content deltas from the Ollama chat API."""
        client = self._ollama_client(host)
        kwargs = dict(
            model=model,
            messages=messages,
            stream=True,
            # Grounded chat carries the whole transcript too, so it is sized the
            # same way as a summarize call rather than pinned to the floor.
            options=_ollama_options(
                _adaptive_num_ctx(_prompt_chars(messages), model, client)
            ),
        )
        if _is_thinking_model(model):
            kwargs["think"] = False
        for chunk in client.chat(**kwargs):
            piece = chunk.get("message", {}).get("content")
            if piece:
                yield piece

    def copilot_warm(
        self,
        model: str,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> tuple[bool, int, str | None]:
        """Perform one minimal chat completion against the local backend to keep it warm."""
        start = time.monotonic()
        try:
            endpoint = validate_copilot_local_endpoint(base_url, api_key)
            use_model = model or self.model
            if endpoint == "ollama":
                client = Client(
                    host=_normalize_local_ollama_host(base_url) or self.host,
                    timeout=COPILOT_TIMEOUT_SECONDS,
                    trust_env=False,
                    follow_redirects=False,
                )
                try:
                    # Every copilot call uses COPILOT_NUM_CTX: Ollama reloads the
                    # runner when num_ctx changes, which would waste the warm-up.
                    options = _ollama_options(COPILOT_NUM_CTX)
                    options["num_predict"] = 1
                    options["keep_alive"] = "30m"
                    kwargs: dict[str, Any] = {
                        "model": use_model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "stream": False,
                        "options": options,
                        "keep_alive": "30m",
                    }
                    if _is_thinking_model(use_model):
                        kwargs["think"] = False
                    client.chat(**kwargs)
                finally:
                    client.close()
            else:
                url = (base_url or self.base_url).rstrip("/")
                key = api_key or self.api_key or "EMPTY"
                headers: dict[str, str] = {"Authorization": f"Bearer {key}"}
                body: dict[str, Any] = {
                    "model": use_model,
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                    "stream": False,
                }
                if url not in _NO_CHAT_TEMPLATE_KWARGS:
                    body["chat_template_kwargs"] = {"enable_thinking": False}
                with httpx.Client(
                    trust_env=False,
                    follow_redirects=False,
                    timeout=COPILOT_TIMEOUT_SECONDS,
                ) as http_client:
                    resp = http_client.post(
                        f"{url}/chat/completions",
                        json=body,
                        headers=headers,
                    )
                    resp.raise_for_status()
            elapsed_ms = int((time.monotonic() - start) * 1000)
            return True, elapsed_ms, None
        except Exception as exc:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            return False, elapsed_ms, str(exc)
