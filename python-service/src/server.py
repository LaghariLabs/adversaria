"""FastAPI server exposing STT transcription and LLM summarization endpoints."""

from __future__ import annotations

import json
import logging
import os
import signal
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from .live import LiveCaptionSession, is_filler_hallucination, is_repetition_loop
from .models import (
    ChatRequest,
    ChatResponse,
    EmbedRequest,
    EmbedResponse,
    HealthResponse,
    LiveFeedRequest,
    LiveFeedResponse,
    ModelDownloadRequest,
    ModelDownloadStatus,
    SummarizeRequest,
    SummarizeResponse,
    TemplateInfo,
    TemplateSaveRequest,
    TranscribeChunkRequest,
    TranscribeChunkResponse,
    TranscribeRequest,
    TranscribeResponse,
    WhisperDownloadRequest,
    WhisperModelInfo,
)
from .model_setup import model_download_status, start_model_download
from .summarizer import OllamaSummarizer, default_llm_backend
from .transcriber import (
    MlxWhisperTranscriber,
    WhisperTranscriber,
    create_transcriber,
    decode_import_file,
    download_whisper_model,
    list_whisper_models,
    relabel_me,
    relabel_turns,
    transcribe_cloud,
    whisper_repo_for,
)
from .config import save_prompt, delete_prompt
from .embedder import OllamaEmbedder

logger = logging.getLogger(__name__)

# Module-level singletons set during lifespan
_transcriber: WhisperTranscriber | MlxWhisperTranscriber | None = None
# Dedicated fast model for the live-caption preview (see _build_live_transcriber).
_live_transcriber: WhisperTranscriber | MlxWhisperTranscriber | None = None
_summarizer: OllamaSummarizer | None = None
_embedder: OllamaEmbedder | None = None

# Live captions use a small, fast Whisper (turbo-q4): ~0.2 s/utterance and a
# quick load, so the preview feels live. The accurate large-v3 model stays for
# the final transcript (turbo drops Arabic diacritics — the user records Arabic).
_LIVE_WHISPER_REPO = "mlx-community/whisper-large-v3-turbo-q4"


def _warm_transcriber(t: object) -> None:
    """Preload a transcriber's model with a tiny silent clip, so the first real
    caption isn't a multi-second cold model load. Best-effort."""
    import os
    import tempfile
    import wave

    fd, name = tempfile.mkstemp(suffix=".wav", prefix="mnt_warm_")
    os.close(fd)
    try:
        with wave.open(name, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 4000)  # 0.25 s of silence
        t.transcribe(name)  # type: ignore[attr-defined]
        logger.info("Live-caption model warmed.")
    except Exception:
        logger.exception("Live-caption warm-up failed (non-fatal).")
    finally:
        try:
            os.unlink(name)
        except OSError:
            pass


def _build_live_transcriber(
    main: WhisperTranscriber | MlxWhisperTranscriber,
) -> WhisperTranscriber | MlxWhisperTranscriber:
    """A dedicated fast model for live captions. MLX only (Apple Silicon); on
    other platforms — or if the small model can't be built — live falls back to
    the main transcriber (previous behavior)."""
    try:
        if isinstance(main, MlxWhisperTranscriber):
            # drop_no_speech: live-only — drop segments Whisper itself flags
            # as probable non-speech (hallucinated fillers on breath/noise).
            live = MlxWhisperTranscriber(
                model_repo=_LIVE_WHISPER_REPO, drop_no_speech=True
            )
            _warm_transcriber(live)  # runs on the warm-up thread, which holds _WHISPER_LOCK
            logger.info("Live-caption model ready (%s).", _LIVE_WHISPER_REPO)
            return live
    except Exception:
        logger.exception("Live-caption model init failed; live uses the main model.")
    return main


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and teardown the ML service singletons."""
    global _transcriber, _live_transcriber, _summarizer, _embedder
    logger.info("Starting ML service lifespan...")
    _transcriber = create_transcriber()
    # Live captions fall back to the main model until the dedicated fast model
    # is built in the background. On a fresh machine _build_live_transcriber
    # downloads its model from Hugging Face; doing that synchronously here kept
    # uvicorn from serving ANY request for minutes, so first-run setup saw
    # "service is not ready" until the download finished.
    _live_transcriber = _transcriber

    def _warm_live_model(main: WhisperTranscriber | MlxWhisperTranscriber) -> None:
        global _live_transcriber
        with _WHISPER_LOCK:
            live = _build_live_transcriber(main)
        _live_transcriber = live

    threading.Thread(
        target=_warm_live_model,
        args=(_transcriber,),
        name="live-model-warmup",
        daemon=True,
    ).start()
    # Backend is platform-resolved: Rapid-MLX (openai) on Apple Silicon, Ollama
    # elsewhere — unless LLM_BACKEND is set explicitly.
    _summarizer = OllamaSummarizer(backend=default_llm_backend())
    _embedder = OllamaEmbedder()
    logger.info("ML service singletons initialized.")
    yield
    logger.info("Shutting down ML service lifespan.")
    _transcriber = None
    _live_transcriber = None
    _summarizer = None
    _embedder = None


app = FastAPI(
    title="Adversaria ML Service",
    version="0.1.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


# NOTE on `def` vs `async def`: the heavy endpoints below are deliberately
# plain `def`. FastAPI runs sync endpoints in its threadpool, so a minutes-long
# transcription/summarization no longer freezes the whole service (an
# `async def` body with blocking calls parks the single event-loop thread —
# live captions, chat, and /health all stalled behind any running job).
_WHISPER_LOCK = threading.Lock()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Return service health status."""
    whisper_model = "N/A"
    ollama_available = False
    status = "degraded"

    if _transcriber is not None:
        whisper_model = _transcriber.model_size
    if _summarizer is not None:
        ollama_available = _summarizer.backend_available()

    if _transcriber is not None and ollama_available:
        status = "ok"

    return HealthResponse(
        status=status,
        whisper_model=whisper_model,
        ollama_available=ollama_available,
    )


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


@app.get("/templates", response_model=list[TemplateInfo])
async def list_templates() -> list[TemplateInfo]:
    """List available prompt template names and descriptions."""
    if _summarizer is None:
        raise HTTPException(status_code=503, detail="Summarizer not initialized")
    return _summarizer.list_templates()


@app.get("/templates/{name}")
async def get_template(name: str) -> dict[str, str]:
    """Return the raw content of a prompt template by name."""
    if _summarizer is None:
        raise HTTPException(status_code=503, detail="Summarizer not initialized")
    try:
        content = _summarizer._load_template(name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"name": name, "content": content}


@app.put("/templates/{name}")
async def put_template(name: str, request: TemplateSaveRequest) -> dict[str, str]:
    """Create or overwrite a prompt template."""
    try:
        save_prompt(name, request.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"name": name, "status": "saved"}


@app.delete("/templates/{name}")
async def remove_template(name: str) -> dict[str, str]:
    """Delete a prompt template."""
    try:
        delete_prompt(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"name": name, "status": "deleted"}


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------


@app.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    """Answer a question grounded in a single meeting's transcript."""
    if _summarizer is None:
        raise HTTPException(status_code=503, detail="Summarizer not initialized")

    try:
        return _summarizer.chat(
            transcript=request.transcript,
            question=request.question,
            model=request.model,
            base_url=request.llm_base_url,
            api_key=request.llm_api_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Chat failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/chat_stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    """Stream a grounded chat answer token-by-token as Server-Sent Events.

    Each frame is `data: {"t": "<token>"}`; the stream ends with `data: [DONE]`.
    Errors arrive as `data: {"error": "<message>"}` so the client can show them
    inline rather than failing the whole request.
    """
    if _summarizer is None:
        raise HTTPException(status_code=503, detail="Summarizer not initialized")

    summarizer = _summarizer

    def generate():
        try:
            sent = 0
            for attempt in range(2):
                for token in summarizer.chat_stream(
                    transcript=request.transcript,
                    question=request.question,
                    model=request.model,
                    base_url=request.llm_base_url,
                    api_key=request.llm_api_key,
                ):
                    sent += 1
                    yield f"data: {json.dumps({'t': token})}\n\n"
                if sent:
                    break
                # A completed stream with zero tokens means the model server
                # aborted the request (e.g. batch error under load) without
                # reporting an error. One immediate retry usually succeeds —
                # the server recovers right after clearing its batch.
                logger.warning("chat_stream yielded no tokens; retrying once")
            if sent:
                yield "data: [DONE]\n\n"
            else:
                yield f"data: {json.dumps({'error': 'The local model returned an empty answer (it may have been interrupted under load) — please try again.'})}\n\n"
        except Exception as exc:  # surface inline instead of failing the request
            logger.exception("Chat stream failed")
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Embed
# ---------------------------------------------------------------------------


@app.post("/embed", response_model=EmbedResponse)
def embed(request: EmbedRequest) -> EmbedResponse:
    """Embed a batch of texts with the local Ollama embedding model."""
    if _embedder is None:
        raise HTTPException(status_code=503, detail="Embedder not initialized")
    if not request.texts:
        raise HTTPException(status_code=400, detail="texts must be a non-empty list")
    if len(request.texts) > 128:
        raise HTTPException(status_code=400, detail="texts: at most 128 per request")
    try:
        embeddings, model = _embedder.embed(request.texts, request.model)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    dim = len(embeddings[0]) if embeddings and embeddings[0] else 0
    return EmbedResponse(embeddings=embeddings, model=model, dim=dim)


# ---------------------------------------------------------------------------
# Transcribe
# ---------------------------------------------------------------------------


@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(request: TranscribeRequest) -> TranscribeResponse:
    """Transcribe an audio file on disk using faster-whisper.

    The Tauri backend and this service run on the same machine, so the
    audio is passed by path rather than uploaded. Local inference is
    serialized by `_WHISPER_LOCK`: the endpoint mutates shared transcriber
    state (initial_prompt, model_repo) and one GPU can't run two Whisper
    jobs anyway.
    """
    if _transcriber is None:
        raise HTTPException(status_code=503, detail="Transcriber not initialized")

    if not request.audio_path.strip():
        raise HTTPException(status_code=400, detail="audio_path is required")

    # Single-file import path: decode in-process, then transcribe as plain
    # single-track (no mic, no dual merge).
    if request.single_file:
        try:
            tmp_wav = decode_import_file(request.audio_path)
            try:
                with _WHISPER_LOCK:
                    result = _transcriber.transcribe(str(tmp_wav))
                return result
            finally:
                tmp_wav.unlink(missing_ok=True)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Import transcription failed")
            raise HTTPException(
                status_code=500, detail=f"Transcription failed: {exc}"
            ) from exc

    # Cloud transcription (Bring-Your-Own-Key, e.g. Groq): upload audio to an
    # OpenAI-compatible endpoint instead of running local Whisper. No on-device
    # diarization in this mode, and the audio leaves the device.
    cloud_url = (request.transcription_base_url or "").strip()
    if cloud_url:
        try:
            logger.info("Transcribing via cloud endpoint: %s", cloud_url)
            result = transcribe_cloud(
                request.audio_path,
                request.mic_audio_path,
                base_url=cloud_url,
                api_key=(request.transcription_api_key or "").strip(),
                model=(request.transcription_model or "whisper-large-v3").strip(),
            )
            result.text = relabel_me(result.text, request.me_label)
            result.turns = relabel_turns(result.turns, request.me_label)
            return result
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Cloud transcription failed")
            raise HTTPException(
                status_code=502, detail=f"Cloud transcription failed: {exc}"
            ) from exc

    # The per-request mutation of the shared transcriber (vocabulary prompt,
    # model repo) is only safe while no other request runs — hold the lock for
    # the whole mutate → transcribe → restore span.
    with _WHISPER_LOCK:
        vocab = (request.vocabulary or "").strip()
        _transcriber.initial_prompt = f"Glossary: {vocab}" if vocab else None
        # On-device model selection (MLX loads per call, so we just swap the repo
        # for this request and restore it after). Ignored for faster-whisper
        # (Windows), which loads one model at startup.
        original_repo = getattr(_transcriber, "model_repo", None)
        if request.whisper_model and isinstance(_transcriber, MlxWhisperTranscriber):
            _transcriber.model_repo = whisper_repo_for(request.whisper_model)
        try:
            logger.info("Transcribing audio file: %s", request.audio_path)
            if request.mic_audio_path:
                result = _transcriber.transcribe_dual(
                    request.audio_path, request.mic_audio_path, diarize=request.diarize
                )
            else:
                result = _transcriber.transcribe(request.audio_path)
            result.text = relabel_me(result.text, request.me_label)
            result.turns = relabel_turns(result.turns, request.me_label)
            return result
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Transcription failed")
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        finally:
            _transcriber.initial_prompt = None
            if original_repo is not None:
                _transcriber.model_repo = original_repo


@app.get("/whisper_models", response_model=list[WhisperModelInfo])
def whisper_models() -> list[WhisperModelInfo]:
    """Curated on-device Whisper models with download status (for the picker)."""
    return [WhisperModelInfo(**m) for m in list_whisper_models()]


@app.post("/whisper_download")
def whisper_download(request: WhisperDownloadRequest) -> dict:
    """Proactively download a Whisper model so it's ready before recording."""
    try:
        download_whisper_model(request.model)
        return {"ok": True}
    except Exception as exc:
        logger.exception("Whisper model download failed")
        raise HTTPException(status_code=502, detail=f"Download failed: {exc}") from exc


@app.post("/setup/model_download", response_model=ModelDownloadStatus)
def setup_model_download(request: ModelDownloadRequest) -> ModelDownloadStatus:
    """Start or resume one app-owned, immutable model snapshot."""
    try:
        return ModelDownloadStatus(**start_model_download(request.profile_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/setup/model_download/{profile_id}", response_model=ModelDownloadStatus)
def setup_model_download_status(profile_id: str) -> ModelDownloadStatus:
    """Return aggregate setup progress without exposing cache paths."""
    try:
        return ModelDownloadStatus(**model_download_status(profile_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Transcribe chunk (live caption preview)
# ---------------------------------------------------------------------------


@app.post("/transcribe_chunk", response_model=TranscribeChunkResponse)
def transcribe_chunk(request: TranscribeChunkRequest) -> TranscribeChunkResponse:
    """Transcribe a short rolling audio window for the live-caption preview.

    Best-effort: any failure returns empty text (HTTP 200) so the live preview
    degrades silently instead of error-spamming the client. The authoritative
    transcript is produced by /transcribe at stop, not here. When a full
    /transcribe holds the Whisper lock, the chunk is SKIPPED (empty text)
    rather than queued — captions poll every ~12 s, so queuing would pile up
    stale windows behind a minutes-long job.
    """
    if _transcriber is None:
        return TranscribeChunkResponse(text="")
    if not request.audio_path.strip():
        return TranscribeChunkResponse(text="")
    if not _WHISPER_LOCK.acquire(blocking=False):
        return TranscribeChunkResponse(text="")
    try:
        result = _transcriber.transcribe(request.audio_path)
        return TranscribeChunkResponse(text=result.text)
    except Exception:
        logger.exception("Live chunk transcription failed (non-fatal)")
        return TranscribeChunkResponse(text="")
    finally:
        _WHISPER_LOCK.release()


# ---------------------------------------------------------------------------
# Live feed (VAD-gated captions — transcribe each utterance exactly once)
# ---------------------------------------------------------------------------

# One recording is live at a time; the Rust side's recording epoch arrives as
# `session` and a new value resets this state. System audio ("them") and the
# microphone ("me") are fed as separate sources so the user's OWN speech is
# captioned too — each source is VAD-segmented in its own session (mixing the
# two streams would fight sample-rate/alignment and lose the You/Them split).
# Only ever two keys ("them", "me"); each self-resets when the epoch changes.
_live_sessions: dict[str, LiveCaptionSession] = {}


@app.post("/live_feed", response_model=LiveFeedResponse)
def live_feed(request: LiveFeedRequest) -> LiveFeedResponse:
    """Ingest a delta of new recording audio; return captions for utterances
    that just FINISHED (Silero-VAD segmented, transcribed once each).

    Best-effort like /transcribe_chunk: failures return empty captions. When a
    full /transcribe holds the Whisper lock, nothing is transcribed and the
    watermark does NOT advance — finished utterances are captioned on a later
    feed instead of being dropped.
    """
    if _live_transcriber is None or not request.audio_path.strip():
        return LiveFeedResponse()
    try:
        session = _live_sessions.setdefault(request.source, LiveCaptionSession())
        session.ingest(request.session, request.audio_path)
        utterances, watermark = session.pending_utterances()
        if not utterances:
            return LiveFeedResponse()
        if not _WHISPER_LOCK.acquire(blocking=False):
            return LiveFeedResponse()  # busy — retry next feed, nothing lost
        try:
            captions: list[str] = []
            for start, end in utterances:
                wav = session.write_utterance_wav(start, end)
                try:
                    text = _live_transcriber.transcribe(str(wav)).text.strip()
                    # Preview-only cosmetic gates: Whisper emits "Thank you." /
                    # "Thanks for watching" for breath/noise that VAD let
                    # through, and loops one token ("pre pre pre ...") on
                    # noise. The final transcript is unaffected.
                    if (
                        text
                        and not is_filler_hallucination(text)
                        and not is_repetition_loop(text)
                    ):
                        captions.append(text)
                finally:
                    wav.unlink(missing_ok=True)
            session.advance(watermark)
            return LiveFeedResponse(captions=captions)
        finally:
            _WHISPER_LOCK.release()
    except Exception:
        logger.exception("Live feed failed (non-fatal)")
        return LiveFeedResponse()


# ---------------------------------------------------------------------------
# Summarize
# ---------------------------------------------------------------------------


@app.post("/summarize", response_model=SummarizeResponse)
def summarize(request: SummarizeRequest) -> SummarizeResponse:
    """Summarize a meeting transcript using the configured LLM template."""
    if _summarizer is None:
        raise HTTPException(status_code=503, detail="Summarizer not initialized")

    try:
        return _summarizer.summarize(
            transcript=request.transcript,
            template_name=request.template_name,
            model=request.model,
            output_language=request.output_language,
            user_notes=request.user_notes,
            base_url=request.llm_base_url,
            api_key=request.llm_api_key,
            known_attendees=request.known_attendees,
            category_hint=request.category_hint,
            auto_template=request.auto_template,
            viewer_label=request.viewer_label,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Summarization failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/shutdown")
async def shutdown() -> dict[str, str]:
    """Gracefully stop the service. Used by the desktop app when it exits so the
    bundled sidecar process doesn't linger. Replies first, then signals itself."""
    logger.info("Shutdown requested.")
    threading.Timer(0.2, lambda: os.kill(os.getpid(), signal.SIGINT)).start()
    return {"status": "shutting down"}


def main() -> None:
    """Run the service as a standalone binary (used by the packaged sidecar).
    Normal dev still uses `uvicorn src.server:app`; this only adds a CLI entry
    point with a configurable --port so Rust can spawn it on a free port."""
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="Adversaria ML service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9876)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
