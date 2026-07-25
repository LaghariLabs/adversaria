"""Meeting summarization using Ollama (local LLM) with prompt templates."""

from __future__ import annotations

import json
import logging
import os
import platform
import re
import sys

import httpx
from ollama import Client

from .config import list_template_files, load_prompt
from .models import (
    AttendeeDetail,
    ChatResponse,
    MeetingNotes,
    SummarizeResponse,
    TemplateInfo,
)
from .names import dedupe_attendees, ground_to_roster

logger = logging.getLogger(__name__)

#: Placeholders local models emit instead of omitting an unknown field.
_NOT_STATED = {"", "null", "none", "n/a", "na", "unknown", "unspecified"}


def _stated(value: object) -> str:
    """Return a trimmed field value, or "" when the model meant "not stated"."""
    text = str(value or "").strip()
    return "" if text.lower() in _NOT_STATED else text

# Ollama defaults to a 2048-token context regardless of the model's real
# capacity, which silently truncates long meeting transcripts. Override it.
# Modern 8B models support far more; 16384 covers ~90 minutes of speech and is
# safe on modest hardware. Raise OLLAMA_NUM_CTX (e.g. 32768) for marathon
# meetings on a GPU with headroom.
DEFAULT_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "16384"))

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
    "qwen3", "deepseek-r1", "-r1", "gpt-oss", "magistral", "reasoning", "thinking",
)


def _is_thinking_model(model: str) -> bool:
    """True if the model family supports a (slow) thinking mode worth disabling."""
    lower = model.lower()
    return any(hint in lower for hint in _THINKING_MODEL_HINTS)


# Some reasoning models (e.g. Groq's qwen3-32b) emit a <think>…</think> block
# before their answer when the reply isn't json-constrained. Strip it from chat
# replies so the user sees the answer, not the chain-of-thought. Local vLLM is
# told enable_thinking=False (no-op there), and summaries use json_object (which
# puts reasoning in a separate field), so this only matters for cloud chat.
_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)


def _strip_think(text: str) -> str:
    """Remove ``<think>…</think>`` reasoning block(s) from a reply. No-op when absent."""
    if "<think>" not in text.lower():
        return text
    return _THINK_BLOCK_RE.sub("", text)


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
        if stripped.lower().startswith("<think>"):
            idx = buffer.lower().find("</think>")
            if idx != -1:
                tail = buffer[idx + len("</think>") :].lstrip()
                passthrough = True
                buffer = ""
                if tail:
                    yield tail
            # else keep buffering until the closing tag arrives
        elif len(stripped) >= len("<think>"):
            passthrough = True  # definitely not a think block — flush + pass on
            out, buffer = buffer, ""
            yield out
    if not passthrough and buffer and not buffer.lstrip().lower().startswith("<think>"):
        yield buffer  # short reply that never reached the decision threshold


# Categories the summarizer LLM may assign (content-based). Superset of the
# heuristic's {meeting, youtube, brainstorm, other} — the extras get their own
# tag colours in the Rust category_tag mapping.
_LLM_CATEGORIES = {
    "meeting", "one_on_one", "interview", "standup", "brainstorm", "youtube", "other",
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
        if sep and len(sp) <= 20 and (
            sp.lower() == "them" or re.fullmatch(r"speaker \d+", sp, flags=re.IGNORECASE)
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
    if lang in ("auto", "match"):
        return (
            "OUTPUT LANGUAGE: Write the entire output in the same language the "
            "meeting was primarily conducted in (infer it from the transcript)."
        )
    if lang in ("en", "english"):
        return "OUTPUT LANGUAGE: Write the entire output in English."
    return None


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
        self.host = host
        # Caller may pass an explicit backend (the service does, per platform);
        # otherwise fall back to the env-driven module default ("ollama").
        self.backend = (backend or LLM_BACKEND).strip().lower()
        self.base_url = (base_url or LLM_BASE_URL).rstrip("/")
        self.api_key = api_key or LLM_API_KEY
        # Only the ollama backend needs the ollama client; for openai we use httpx.
        self.client = Client(host=host) if self.backend == "ollama" else None
        logger.info(
            "Summarizer initialized: backend=%s model=%s ollama_host=%s openai_base=%s",
            self.backend, model, host, self.base_url,
        )

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
            self.client.list()
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
            normalized = raw.strip().lower().replace("-", "_").replace(" ", "_")
            # Strip surrounding punctuation / quotes (e.g. '"interview"').
            normalized = normalized.strip('"\'.,;:!?()[]{}<> \t')
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
        while lines and lines[-1].strip().rstrip(":").strip().lower() in ("", "---", "transcript"):
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
    def _loads_lenient(raw: str) -> dict | None:
        """Parse the model's reply as a JSON object, tolerating ``` fences."""
        text = raw.strip()
        if text.startswith("```"):
            # Strip a ```json ... ``` markdown fence.
            inner = text[3:]
            if inner[:4].lower() == "json":
                inner = inner[4:]
            text = inner.rsplit("```", 1)[0].strip()
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            return None
        return data if isinstance(data, dict) else None

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
            if label and label.strip().lower() not in ("me", "them") and label not in attendees:
                attendees.append(label)

        parts: list[str] = []
        if attendees:
            parts.append(f"**Attendees:** {', '.join(attendees)}")

        loose: list[str] = []
        for sec in data.get("sections") or []:
            if isinstance(sec, str):
                line = sec.strip()
                if line:
                    loose.append(line if line.startswith(("-", "*")) else f"- {line}")
                continue
            if not isinstance(sec, dict):
                continue
            heading = next(
                (str(sec[k]).strip() for k in ("heading", "title", "section", "name", "header")
                 if isinstance(sec.get(k), str) and sec[k].strip()),
                "",
            )
            bullets = next(
                (sec[k] for k in ("bullets", "points", "items", "content", "details")
                 if isinstance(sec.get(k), list)),
                None,
            )
            if heading:
                parts.append(f"**{heading}**")
            if bullets:
                rendered = "\n".join(f"- {str(b).strip()}" for b in bullets if str(b).strip())
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
    ) -> str:
        """Send a chat request to the configured backend; return raw text content.

        json_schema (when given) constrains the model to that JSON schema:
        Ollama uses ``format=schema``; OpenAI-compatible servers use
        ``response_format={"type":"json_schema", ...}``.

        When ``base_url`` is provided and non-empty, the request is always routed
        through the OpenAI-compatible path with that URL and key, regardless of
        ``self.backend`` (supports per-request cloud provider overrides).
        Otherwise, the default backend routing (``self.backend``) applies.
        """
        if base_url:
            return self._chat_openai(messages, model, json_schema, base_url=base_url, api_key=api_key)
        if self.backend == "openai":
            return self._chat_openai(messages, model, json_schema)
        return self._chat_ollama(messages, model, json_schema)

    def _chat_ollama(self, messages: list[dict], model: str, json_schema: dict | None) -> str:
        chat_kwargs = dict(
            model=model,
            messages=messages,
            options={"temperature": 0.0, "num_ctx": DEFAULT_NUM_CTX},
        )
        if json_schema is not None:
            chat_kwargs["format"] = json_schema
        if _is_thinking_model(model):
            chat_kwargs["think"] = False
        try:
            response = self.client.chat(**chat_kwargs)
        except Exception as exc:
            if "think" in chat_kwargs:
                logger.warning("chat with think=False failed (%s) — retrying without.", exc)
                chat_kwargs.pop("think")
                try:
                    response = self.client.chat(**chat_kwargs)
                except Exception as exc2:
                    logger.error("Ollama request failed: %s", exc2)
                    raise RuntimeError(f"Ollama request failed: {exc2}") from exc2
            else:
                logger.error("Ollama request failed: %s", exc)
                raise RuntimeError(f"Ollama request failed: {exc}") from exc
        return response["message"]["content"]

    def _chat_openai(
        self,
        messages: list[dict],
        model: str,
        json_schema: dict | None,
        base_url: str | None = None,
        api_key: str | None = None,
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
            return data["choices"][0]["message"]["content"]
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
        base_url: str | None = None,
        api_key: str | None = None,
        known_attendees: list[str] | None = None,
        category_hint: str | None = None,
        auto_template: bool = False,
        viewer_label: str | None = None,
    ) -> SummarizeResponse:
        """Summarize a meeting transcript into grounded, structured notes.

        Uses Ollama structured output (the LLM is constrained to the
        ``MeetingNotes`` JSON schema), then renders Markdown for display and
        extracts the attendee list and a title.

        Args:
            transcript: The raw meeting transcript text.
            template_name: Name of the prompt template to use (e.g. 'general').
            model: Ollama model override; defaults to the summarizer's model.
            base_url: When non-empty, route through the OpenAI-compatible path
                with this URL + api_key regardless of the default backend.
            api_key: API key for the cloud provider (used with base_url).
            known_attendees: Canonical participant names (e.g. from a calendar
                roster or user-edited attendee list). When non-empty, a
                directive is injected encouraging the LLM to use these exact
                spellings, and extracted names are grounded to the closest
                roster entry before deduplication.

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
                or self._classify_category_llm(
                    transcript, model, base_url, api_key
                )
                or heuristic_category
            )
            routed = route_template(pre_category)
            if routed and routed != template_name:
                try:
                    self._load_template(routed)
                except FileNotFoundError:
                    logger.warning(
                        "Auto-route: template %r missing — keeping %r",
                        routed, template_name,
                    )
                else:
                    logger.info(
                        "Auto-routed template: category=%s template=%s",
                        pre_category, routed,
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

        raw_output = self._chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            model=use_model,
            json_schema=MeetingNotes.model_json_schema(),
            base_url=base_url,
            api_key=api_key,
        )

        data = self._loads_lenient(raw_output)
        if data is None:
            # Not JSON at all — degrade gracefully to the raw text rather than
            # failing the whole meeting. No LLM category available here.
            logger.warning("Model output was not JSON — using raw text.")
            return SummarizeResponse(
                summary=raw_output.strip(),
                template_used=template_name,
                category=category_hint or heuristic_category,
            )

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
            markdown = (
                "_Couldn't extract structured notes from this recording — the "
                "transcript may be too short or sparse. Try **Re-summarize**, or "
                "pick the **Brainstorm → To-Dos** template for idea dumps._"
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
        if base_url or self.backend == "openai":
            raw = self._chat_openai_stream(
                messages, use_model, base_url=base_url, api_key=api_key
            )
        else:
            raw = self._chat_ollama_stream(messages, use_model)
        yield from _strip_think_stream(raw)

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
                            json.loads(data)["choices"][0].get("delta", {}).get("content")
                        )
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
                    if delta:
                        yield delta
                return

    def _chat_ollama_stream(self, messages, model):
        """Stream content deltas from the Ollama chat API."""
        kwargs = dict(
            model=model,
            messages=messages,
            stream=True,
            options={"temperature": 0.0, "num_ctx": DEFAULT_NUM_CTX},
        )
        if _is_thinking_model(model):
            kwargs["think"] = False
        for chunk in self.client.chat(**kwargs):
            piece = chunk.get("message", {}).get("content")
            if piece:
                yield piece
