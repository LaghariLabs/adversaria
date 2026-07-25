"""Pydantic models — the API contract between Tauri and the Python ML service."""

from __future__ import annotations

from pydantic import BaseModel, Field


# --- Request models ---


class TranscribeRequest(BaseModel):
    audio_path: str = Field(..., description="Absolute path to the audio file on disk")
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
            "Language for the summary: 'en', 'ar' (Arabic), or 'auto' (match the "
            "language spoken in the meeting). None defaults to English."
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


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., description="Batch of texts to embed")
    model: str | None = Field(
        default=None,
        description="Embedding model override; defaults to the service's "
        "EMBED_MODEL env var or bge-m3",
    )


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


class ChatResponse(BaseModel):
    answer: str


class TemplateInfo(BaseModel):
    name: str
    description: str


class HealthResponse(BaseModel):
    status: str
    whisper_model: str
    ollama_available: bool
