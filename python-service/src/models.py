"""Pydantic models — the API contract between Tauri and the Python ML service."""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator

DEEPSEEK_COPILOT_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_COPILOT_MODEL = "deepseek-v4-pro"
DEEPSEEK_COPILOT_MODELS = frozenset({"deepseek-v4-flash", "deepseek-v4-pro"})


def validate_copilot_deepseek_endpoint(base_url: str | None) -> str:
    """Accept only DeepSeek's fixed first-party HTTPS Chat Completions base."""
    if base_url is None:
        raise ValueError("DeepSeek endpoint is missing")
    try:
        parsed = urlsplit(base_url)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("DeepSeek endpoint is invalid") from exc
    if (
        parsed.scheme != "https"
        or parsed.hostname != "api.deepseek.com"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/", "/v1", "/v1/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("DeepSeek endpoint is invalid")
    return DEEPSEEK_COPILOT_BASE_URL


# --- Request models ---


class TranscribeRequest(BaseModel):
    audio_path: str | None = Field(
        default=None,
        description=(
            "Absolute path to the audio file on disk. Omitted for mic-only recordings."
        ),
    )
    mic_audio_path: str | None = Field(
        default=None,
        description=(
            "Optional path to a microphone recording of the same meeting. "
            "When present, both files are transcribed and merged into a "
            "speaker-labeled transcript (Me = mic, Them = system audio)."
        ),
    )
    me_label: str | None = Field(
        default=None,
        description=(
            "Display name for the local user. When set, line-leading 'Me:' "
            "labels in the merged transcript are rewritten to this name."
        ),
    )
    vocabulary: str | None = Field(
        default=None,
        description=(
            "Free-text list of names/terms to bias transcription toward "
            "(applied as the Whisper initial_prompt). Empty/None = no biasing."
        ),
    )
    diarize: bool = Field(
        default=True,
        description=(
            "Diarize the system-audio channel into 'Speaker 1'/'Speaker 2'/… "
            "labels instead of a flat 'Them'. The mic side stays 'Me'."
        ),
    )
    transcription_base_url: str | None = Field(
        default=None,
        description=(
            "OpenAI-compatible base URL for CLOUD transcription (e.g. Groq: "
            "https://api.groq.com/openai/v1). When set, each channel is uploaded "
            "to {base_url}/audio/transcriptions instead of using local Whisper. "
            "Cloud mode has no on-device diarization and is not sovereign."
        ),
    )
    transcription_api_key: str | None = Field(
        default=None, description="API key for the cloud transcription provider."
    )
    transcription_model: str | None = Field(
        default=None, description="Cloud transcription model id, e.g. whisper-large-v3."
    )
    whisper_model: str | None = Field(
        default=None,
        description=(
            "On-device Whisper model key (e.g. 'large-v3', 'large-v3-turbo'). "
            "Selects which local MLX model to use for this transcription."
        ),
    )
    single_file: bool = Field(
        default=False,
        description=(
            "When true, treat audio_path as a single-track import file (no mic, "
            "no dual merge). The file is decoded to 16 kHz mono in-process via "
            "PyAV before transcription."
        ),
    )

    @model_validator(mode="after")
    def require_an_audio_path(self) -> TranscribeRequest:
        if self.audio_path is None and self.mic_audio_path is None:
            raise ValueError("audio_path or mic_audio_path is required")
        return self


class PriorMeeting(BaseModel):
    """An earlier meeting the user attached while recording, with its still-open action items."""

    title: str
    date: str = ""  # "YYYY-MM-DD" or ""
    open_items: list[str] = Field(
        default_factory=list
    )  # e.g. "Jena: share the profile with Shadyfah (due 2026-09-05)"


class AcceptedLiveItem(BaseModel):
    """An item confirmed by the user during the live meeting."""

    id: str
    kind: Literal["decision", "action", "question"]
    text: str
    owner: str | None = None
    due: str | None = None
    evidence_turn_ids: list[str] = Field(default_factory=list)
    revision: int = 1


class SummarizeRequest(BaseModel):
    transcript: str = Field(..., description="Raw transcript text to summarize")
    template_name: str = Field(
        default="general",
        description="Prompt template to use: general, one-on-one, client-meeting",
    )
    model: str | None = Field(
        default=None,
        description="Ollama model to use; falls back to the summarizer's default",
    )
    output_language: str | None = Field(
        default=None,
        description=(
            "Language for the summary: 'en', 'ar', 'zh', 'hi', 'es', 'fr', 'bn', "
            "'pt', 'ru', 'ur', or 'auto' (match the language spoken in the meeting). "
            "None defaults to English."
        ),
    )
    user_notes: str | None = Field(
        default=None,
        description=(
            "Rough notes the user typed live during the meeting. When present, "
            "the summary is steered to reflect and organize around them while "
            "staying grounded in the transcript."
        ),
    )
    attached_context: str | None = Field(
        default=None,
        description=(
            "Reference material the user attached to the meeting; background only, "
            "not things said in the meeting"
        ),
    )
    llm_base_url: str | None = Field(
        default=None,
        description=(
            "OpenAI-compatible base URL for cloud summarization. When non-empty, "
            "the summarizer uses the OpenAI path with this URL + api_key regardless "
            "of its default backend. Empty/None = use the service's local default."
        ),
    )
    llm_api_key: str | None = Field(
        default=None,
        description="API key for the cloud LLM provider (only used when llm_base_url is set).",
    )
    category_hint: str | None = Field(
        default=None,
        description=(
            "Category verdict computed at transcription time (pre-bleed-strip), "
            "e.g. 'youtube'. Overrides transcript-based classification."
        ),
    )
    viewer_label: str | None = Field(
        default=None,
        description=(
            "The recording user's speaker label (their configured name). For "
            "watched-video (youtube-template) summaries, lines under this label "
            "and under 'Me' are relabeled to a neutral viewer marker before the "
            "LLM sees them, so mic-bleed lines can't crown the viewer as the "
            "video's presenter."
        ),
    )
    auto_template: bool = Field(
        default=False,
        description=(
            "True when the template came from the app default rather than an "
            "explicit user choice. Lets the service auto-route to the template "
            "matching the detected category (e.g. youtube, interview). Never set "
            "for a manually chosen template."
        ),
    )
    known_attendees: list[str] | None = Field(
        default=None,
        description=(
            "Canonical participant names for roster grounding. When non-empty, the "
            "summarizer is steered toward these exact spellings and extracted names "
            "are normalized to the closest roster entry."
        ),
    )
    meeting_date: str | None = Field(
        default=None,
        description=(
            "The recording's calendar date as ISO YYYY-MM-DD. When set, a date "
            "line is added to the system prompt so spoken relative deadlines "
            "('by Friday') can be resolved to absolute dates. Absent or "
            "malformed = no date context, and no dates are resolved."
        ),
    )
    prior_meetings: list[PriorMeeting] = Field(
        default_factory=list,
        description=(
            "Previous meetings the user attached while recording; each open "
            "action item gets a follow-up check in the notes."
        ),
    )
    accepted_live_items: list[AcceptedLiveItem] = Field(
        default_factory=list,
        description=(
            "Items confirmed by the user during the meeting. When present, "
            "they are traced facts to include under the matching section."
        ),
    )


class TemplateSaveRequest(BaseModel):
    content: str = Field(..., description="Raw markdown system-prompt content")


class ChatRequest(BaseModel):
    transcript: str = Field(
        ..., description="The meeting transcript to ground the answer in"
    )
    question: str = Field(..., description="The user's question about the meeting")
    model: str | None = Field(
        default=None,
        description="Ollama model to use; falls back to the summarizer's default",
    )
    llm_base_url: str | None = Field(
        default=None,
        description=(
            "OpenAI-compatible base URL for cloud chat. When non-empty, the "
            "summarizer uses the OpenAI path with this URL + api_key regardless "
            "of its default backend. Empty/None = use the service's local default."
        ),
    )
    llm_api_key: str | None = Field(
        default=None,
        description="API key for the cloud LLM provider (only used when llm_base_url is set).",
    )


class CopilotAnswerPassage(BaseModel):
    title: str
    text: str
    source: str = ""

    @field_validator("text")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("passage text cannot be blank")
        trimmed = value.strip()
        if len(trimmed) > 600:
            raise ValueError("passage text exceeds 600 characters")
        return trimmed

    @field_validator("title", "source")
    @classmethod
    def trim_passage_metadata(cls, value: str, info) -> str:
        trimmed = value.strip()
        limit = 200 if info.field_name == "title" else 300
        if len(trimmed) > limit:
            raise ValueError(f"{info.field_name} exceeds {limit} characters")
        return trimmed


class RecentCard(BaseModel):
    card_ref: str
    question: str
    say: str
    points: list[str] = Field(default_factory=list, max_length=6)
    origin: Literal["generated_suggestion"] = "generated_suggestion"
    evidence_refs: list[str] = Field(default_factory=list, max_length=3)

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        if len(value) > 2000:
            raise ValueError("question exceeds 2000 characters")
        return value

    @field_validator("say")
    @classmethod
    def validate_say(cls, value: str) -> str:
        if len(value) > 1200:
            raise ValueError("say exceeds 1200 characters")
        return value

    @field_validator("points")
    @classmethod
    def validate_points(cls, value: list[str]) -> list[str]:
        if any(len(item) > 400 for item in value):
            raise ValueError("points item exceeds 400 characters")
        return value

    @field_validator("evidence_refs")
    @classmethod
    def validate_evidence_refs(cls, value: list[str]) -> list[str]:
        if len(value) > 3:
            raise ValueError("evidence_refs exceeds 3 items")
        return value


class CopilotAnswerRequest(BaseModel):
    schema_version: Literal[5, 6, 7] = 7
    provider: Literal["claude", "deepseek", "local"]
    question: str
    question_source: Literal["Me", "Them"] = "Them"
    answer_shape: Literal["brief", "steps"] = "brief"
    context_turns: list[str] = Field(default_factory=list, max_length=8)
    passages: list[CopilotAnswerPassage] = Field(default_factory=list, max_length=3)
    persona: str | None = None
    voice_samples: list[str] = Field(default_factory=list, max_length=2)
    meeting_header: str | None = None
    running_summary: str | None = None
    standing_pack: str | None = None
    recent_cards: list[RecentCard] = Field(default_factory=list, max_length=3)
    stated_figures: list[str] = Field(default_factory=list, max_length=32)
    resolved_question: str | None = None
    question_source_tier: Literal["partial", "confirmed"] = "confirmed"
    web_search: bool = False
    api_key: str | None = None
    model: str | None = None
    llm_base_url: str | None = None
    llm_api_key: str | None = None

    @field_validator("question")
    @classmethod
    def question_must_not_be_blank(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("question cannot be blank")
        if len(trimmed) > 2000:
            raise ValueError("question exceeds 2000 characters")
        return trimmed

    @field_validator("standing_pack")
    @classmethod
    def validate_standing_pack(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value.encode("utf-8")) > 6000:
            raise ValueError("standing_pack exceeds 6000 UTF-8 bytes")
        return value

    @field_validator("recent_cards")
    @classmethod
    def validate_recent_cards(cls, value: list[RecentCard]) -> list[RecentCard]:
        if len(value) > 3:
            raise ValueError("recent_cards exceeds 3 items")
        return value

    @field_validator("stated_figures")
    @classmethod
    def validate_stated_figures(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for item in value:
            stripped = item.strip()
            if not stripped:
                continue
            if len(stripped) > 240:
                raise ValueError("stated figure exceeds 240 characters")
            cleaned.append(stripped)
        total = sum(len(entry.encode("utf-8")) for entry in cleaned)
        if total > 4000:
            raise ValueError("stated_figures exceeds 4000 bytes")
        return cleaned

    @field_validator("resolved_question")
    @classmethod
    def validate_resolved_question(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) > 2000:
            raise ValueError("resolved_question exceeds 2000 characters")
        return value

    @field_validator("context_turns")
    @classmethod
    def validate_context_turn_lengths(cls, value: list[str]) -> list[str]:
        if any(len(item) > 600 for item in value):
            raise ValueError("context turn exceeds 600 characters")
        if any(not item.strip() for item in value):
            raise ValueError("context turns cannot be blank")
        return [item.strip() for item in value]

    @field_validator("voice_samples")
    @classmethod
    def validate_voice_samples(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for item in value:
            stripped = item.strip()
            if not stripped:
                raise ValueError("voice samples cannot be blank")
            if len(stripped) > 600 or len(item) > 600:
                raise ValueError("voice sample exceeds 600 characters")
            cleaned.append(stripped)
        return cleaned

    @field_validator("meeting_header", "running_summary")
    @classmethod
    def validate_optional_context_strings(
        cls, value: str | None, info: ValidationInfo
    ) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        if len(stripped) > 1600 or len(value) > 1600:
            raise ValueError(f"{info.field_name} exceeds 1600 characters")
        return stripped

    @field_validator("persona")
    @classmethod
    def trim_optional_persona(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if len(trimmed) > 400:
            raise ValueError("persona exceeds 400 characters")
        return trimmed or None

    @model_validator(mode="after")
    def validate_provider_fields(self) -> "CopilotAnswerRequest":
        if self.provider in {"claude", "deepseek"} and len(self.context_turns) > 4:
            raise ValueError("context turns exceed 4 for cloud providers")
        if self.provider in {"claude", "deepseek"} and self.stated_figures:
            raise ValueError("stated figures are local only")
        if self.provider == "local":
            if self.api_key is not None or self.web_search:
                raise ValueError(
                    "local provider cannot use Claude credentials or web search"
                )
            if self.llm_api_key is not None and self.llm_base_url is None:
                raise ValueError("local credentials require llm_base_url")
            if self.llm_base_url is not None:
                try:
                    parsed = urlsplit(self.llm_base_url)
                    port = parsed.port
                except ValueError as exc:
                    raise ValueError(
                        "local engine must be a loopback HTTP endpoint"
                    ) from exc
                if (
                    parsed.scheme != "http"
                    or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
                    or port is None
                    or parsed.username is not None
                    or parsed.password is not None
                    or parsed.path not in {"", "/", "/v1", "/v1/"}
                    or parsed.query
                    or parsed.fragment
                ):
                    raise ValueError("local engine must be a loopback HTTP endpoint")
        elif self.provider == "deepseek":
            if self.api_key is not None or self.web_search:
                raise ValueError(
                    "DeepSeek provider cannot use Claude credentials or web search"
                )
            self.llm_base_url = validate_copilot_deepseek_endpoint(self.llm_base_url)
            if not (self.llm_api_key or "").strip():
                raise ValueError("DeepSeek API key missing")
            self.llm_api_key = self.llm_api_key.strip()
            if self.model not in DEEPSEEK_COPILOT_MODELS:
                raise ValueError("DeepSeek model is invalid")
        elif self.llm_base_url is not None or self.llm_api_key is not None:
            raise ValueError("claude provider cannot use local engine fields")
        return self


class CopilotWarmRequest(BaseModel):
    model: str
    llm_base_url: str | None = None
    llm_api_key: str | None = None


class CopilotWarmResponse(BaseModel):
    ok: bool
    ms: int
    detail: str | None = None


class LiveTurn(BaseModel):
    id: str
    start_ms: int
    end_ms: int
    source: Literal["Me", "Them"]
    text: str


class LiveItemIn(BaseModel):
    id: str
    kind: Literal["decision", "action", "question"]
    text: str
    owner: str | None = None
    due: str | None = None
    status: Literal["proposed", "accepted"]
    evidence_turn_ids: list[str] = Field(default_factory=list)


class LiveSummary(BaseModel):
    bullets: list[str] = Field(default_factory=list)
    evidence_turn_ids: list[str] = Field(default_factory=list)


class LiveExtractRequest(BaseModel):
    request_id: str
    session_id: str
    base_revision: int
    model: str
    num_ctx: int = 8192  # ignored: live extraction always uses COPILOT_NUM_CTX
    update_summary: bool = False
    turns: list[LiveTurn] = Field(default_factory=list)
    items: list[LiveItemIn] = Field(default_factory=list)
    summary: LiveSummary = Field(default_factory=LiveSummary)
    new_turn_ids: list[str] = Field(default_factory=list)


class LiveUpsert(BaseModel):
    id: str | None = None
    kind: Literal["decision", "action", "question"]
    text: str
    owner: str | None = None
    due: str | None = None
    evidence_turn_ids: list[str] = Field(default_factory=list)
    supersedes_id: str | None = None


class LiveRetraction(BaseModel):
    id: str
    evidence_turn_ids: list[str]
    reason_code: Literal["explicit_withdrawal", "explicit_replacement"]
    withdrawal_quote: str = Field(min_length=1)


class LiveExtractResponse(BaseModel):
    request_id: str
    session_id: str
    base_revision: int
    status: Literal["ok", "error"]
    reason: str | None = None
    through_ms: int | None = None
    upserts: list[LiveUpsert] = Field(default_factory=list)
    retractions: list[LiveRetraction] = Field(default_factory=list)
    summary: LiveSummary | None = None


class LiveExtractModelOutput(BaseModel):
    upserts: list[LiveUpsert]
    retractions: list[LiveRetraction]


class LiveExtractModelOutputNoSummary(LiveExtractModelOutput):
    pass


class LiveExtractModelOutputWithSummary(LiveExtractModelOutput):
    summary: LiveSummary


class GateRequest(BaseModel):
    candidate: str
    speaker: Literal["Me", "Them"]
    mode: Literal["interview", "self_ask"]
    context_turns: list[str] = Field(default_factory=list)
    recent_questions: list[str] = Field(default_factory=list)
    model: str


class GateResponse(BaseModel):
    action: Literal["answer", "ignore"]
    resolved_question: str | None = None
    reason_code: Literal[
        "direct_question",
        "embedded_question",
        "narration",
        "answered_in_turn",
        "repeat",
        "no_request",
        "unclear",
        # Not a model verdict: the gate backend itself failed (model call
        # raised, output was unparseable, or the summarizer was missing), so
        # the desktop app must apply its reason-aware fallback instead of
        # treating this as the model genuinely saying "ignore".
        "backend_error",
    ] = "unclear"


class GateModelOutput(BaseModel):
    # The schema is compiled into a llama.cpp grammar (Ollama `format`), which rejects string repetitions of 2000 or more ("failed to parse grammar"); 1500 also fits the 400-token `num_predict`. Post-parse validation stays at 2000 characters.
    resolved_question: str = Field(min_length=1, max_length=1500)
    action: Literal["answer", "ignore"]
    reason_code: Literal[
        "direct_question",
        "embedded_question",
        "narration",
        "answered_in_turn",
        "repeat",
        "no_request",
        "unclear",
    ]


class DraftRequest(BaseModel):
    brief: str = Field(
        ..., description="Task brief with all context the writer may use"
    )
    instruction: str = Field(..., description="What to produce from the brief")
    model: str | None = Field(
        default=None,
        description="Model override; falls back to the summarizer's default",
    )
    llm_base_url: str | None = Field(
        default=None,
        description=(
            "OpenAI-compatible base URL for cloud chat. When non-empty, the "
            "summarizer uses the OpenAI path with this URL + api_key regardless "
            "of its default backend. Empty/None = use the service's local default."
        ),
    )
    llm_api_key: str | None = Field(
        default=None,
        description="API key for the cloud LLM provider (only used when llm_base_url is set).",
    )


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., description="Batch of texts to embed")
    model: str | None = Field(
        default=None,
        description="Embedding model override; defaults to the service's "
        "EMBED_MODEL env var or bge-m3",
    )
    ollama_host: str | None = Field(
        default=None,
        description="Per-request local Ollama host; defaults to the host configured by Rust.",
    )


class LlmHostRequest(BaseModel):
    ollama_host: str | None = Field(
        default=None, description="Loopback Ollama host owned by the desktop app"
    )
    local_openai_base_url: str | None = Field(
        default=None,
        description="Loopback OpenAI-compatible base owned by the desktop app",
    )

    @model_validator(mode="after")
    def require_registered_host(self) -> "LlmHostRequest":
        if self.ollama_host is None and self.local_openai_base_url is None:
            raise ValueError("at least one local LLM host is required")
        return self


class EmbedResponse(BaseModel):
    embeddings: list[list[float]] = Field(
        ..., description="One embedding vector per input text, in order"
    )
    model: str = Field(..., description="The embedding model actually used")
    dim: int = Field(..., description="Dimensionality of the vectors")


# --- Structured meeting-notes schema (constrains the LLM via Ollama format=) ---


class Attendee(BaseModel):
    name: str = Field(
        ...,
        description=(
            "A real participant name as spoken. Do NOT list the generic speaker "
            "labels 'Me' or 'Them' — only include actual names mentioned."
        ),
    )
    role: str | None = Field(
        default=None, description="Role/title only if explicitly stated"
    )
    company: str | None = Field(
        default=None,
        description="Company/organization only if explicitly stated in the transcript",
    )


class NoteSection(BaseModel):
    heading: str = Field(..., description="Section heading")
    bullets: list[str] = Field(
        default_factory=list, description="Concise bullet points for this section"
    )


class MeetingNotes(BaseModel):
    """Grounded, structured meeting notes the LLM is constrained to produce."""

    title: str = Field(
        ...,
        description=(
            "Short title (5-8 words). Never use the generic speaker labels 'Me' or "
            "'Them' in the title; if no real names are known, title it by topic."
        ),
    )
    category: str = Field(
        default="meeting",
        description=(
            "Classify this recording from its CONTENT. Exactly one of: "
            "'meeting' (a real multi-person discussion/call), "
            "'one_on_one' (a two-person 1:1 or catch-up), "
            "'interview' (a job interview — screening, technical, or panel), "
            "'standup' (a status/standup/check-in on progress and blockers), "
            "'brainstorm' (one person thinking out loud, an idea dump, or planning), "
            "'youtube' (the user was WATCHING a video/talk/tutorial, not "
            "participating — one-sided presenter speech), "
            "'other' (anything else, e.g. a personal/casual conversation). "
            "Judge by who is talking and why, not by length."
        ),
    )
    attendees: list[Attendee] = Field(default_factory=list)
    sections: list[NoteSection] = Field(default_factory=list)


# --- Response models ---


class TranscriptTurn(BaseModel):
    """One speaker-coalesced turn of the transcript, with segment timing."""

    speaker: str
    text: str
    start: float
    end: float


class TranscribeResponse(BaseModel):
    text: str
    language: str
    duration_seconds: float
    # Category verdict computed AT TRANSCRIPTION TIME, before mic bleed is
    # stripped from the transcript. Bleed is the strongest playback signal —
    # once stripped, the stored transcript can look meeting-like, so the
    # classifier is run pre-strip and the verdict travels with the response.
    category_hint: str | None = None
    # Speaker-coalesced turns with per-turn timing, emitted alongside the flat
    # text. The flat text is always byte-identical to rendering the turns as
    # "Speaker: text" lines for labeled transcripts; for unlabeled single-file
    # imports the turns carry speaker "Them" and the flat text is a space-joined
    # rendering of turn texts (no labels).
    turns: list[TranscriptTurn] = []


class WhisperModelInfo(BaseModel):
    key: str
    label: str
    size: str
    downloaded: bool


class WhisperDownloadRequest(BaseModel):
    model: str = Field(
        ..., description="Friendly model key to download, e.g. 'large-v3-turbo'."
    )


class ModelDownloadRequest(BaseModel):
    profile_id: str = Field(..., description="App-owned pinned local model profile ID.")


class ModelDownloadStatus(BaseModel):
    profile_id: str
    state: str
    downloaded_bytes: int
    total_bytes: int
    detail: str
    error_code: str | None = None
    verified: bool = False
    can_retry: bool = True


class TranscribeChunkRequest(BaseModel):
    audio_path: str = Field(
        ..., description="Path to a short rolling-window WAV on disk"
    )


class TranscribeChunkResponse(BaseModel):
    text: str


class LiveFeedRequest(BaseModel):
    audio_path: str = Field(
        ..., description="Path to a delta WAV of NEW audio since the last feed"
    )
    session: int = Field(
        ..., description="Recording epoch; a new value resets the live session"
    )
    source: str = Field(
        "them",
        description="Audio source this delta belongs to ('them' = system audio, "
        "'me' = microphone). Each source is VAD-segmented in its own session so "
        "the user's own speech is captioned, not just system audio.",
    )


class LiveFeedResponse(BaseModel):
    captions: list[str] = Field(default_factory=list)
    caption_boundaries: list[Literal["silence", "forced"]] = Field(
        default_factory=list,
        description="Boundary for each caption: forced continues the current speech turn; silence completes it.",
    )
    partial: str = Field(
        "",
        description="Best-effort text for audio after the last confirmed utterance of this source (streaming preview; replaced each feed, empty when idle or when no streaming engine is available)",
    )


class AttendeeDetail(BaseModel):
    """What the model could tell about a participant, for profile prefill.

    Only ever populated from things stated out loud in the transcript; the
    desktop app uses it to fill blank profile fields, never to overwrite
    anything the user typed.
    """

    name: str
    role: str = ""
    company: str = ""


class SummarizeResponse(BaseModel):
    summary: str
    template_used: str
    title: str = ""
    attendees: list[str] = Field(default_factory=list)
    category: str = ""
    attendee_details: list[AttendeeDetail] = Field(default_factory=list)


class GenerateTemplateRequest(BaseModel):
    """Ask the configured LLM to write a note template from a description."""

    description: str
    model: str | None = None
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    example_template: str = "general"


class GenerateTemplateResponse(BaseModel):
    template: str


class ChatResponse(BaseModel):
    answer: str


class TemplateInfo(BaseModel):
    name: str
    description: str


class HealthResponse(BaseModel):
    status: str
    whisper_model: str
    ollama_available: bool
    # Why transcription is (un)available: loading | ready | missing | error.
    # "missing" means no model is downloaded — the UI guides the user to
    # Settings instead of showing a dead service (SETUP_REDESIGN_SPEC V3).
    transcriber_state: str = "ready"
    transcriber_detail: str | None = None
    embedder_state: str | None = None
    embedder_detail: str | None = None
    # English live-caption preview engine: missing | loading | ready | error
    # (None from a service predating it).
    live_captions_state: str | None = None
