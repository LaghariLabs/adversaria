# Architecture

How Meeting Note Taker is built and how data flows through it. For *why* it's
shaped this way, see [DECISIONS.md](./DECISIONS.md). For the original full
design spec, see [`superpowers/specs/2026-06-11-meeting-note-taker-design.md`](./superpowers/specs/2026-06-11-meeting-note-taker-design.md).

## Overview

A three-layer local desktop app, cross-platform across **Windows** and **macOS**
(Apple Silicon). Everything runs on one machine; the only network traffic is
loopback HTTP between the Rust backend and the Python service, plus the Python
service talking to a local Ollama server. Only the OS-specific layers differ —
audio capture, meeting detection, and the Whisper backend (see the per-layer
notes below); the React UI, SQLite store, config, and HTTP client are shared.

```
┌──────────────┐  invoke()   ┌────────────────────┐  HTTP :9876   ┌─────────────────────┐
│  React UI    │ ──────────▶ │   Tauri (Rust)     │ ────────────▶ │ Python ML service   │
│  (webview)   │ ◀────────── │   backend          │ ◀──────────── │ (FastAPI/uvicorn)   │
└──────────────┘  Promise    └────────────────────┘  JSON         └─────────────────────┘
                                │   │                                  │           │
                                │   └─ SQLite (%APPDATA%)              │           │
                                └────  WASAPI capture → WAV     faster-whisper   Ollama
                                       (system + mic)            (GPU/CPU)    (localhost:11434)
```

## Layer 1 — React frontend (`src/`)

TypeScript + React 18 + Vite 6 + Tailwind 3, rendered inside the Tauri webview.

- **`App.tsx`** — root component. Holds the view state (`meetings` / `settings`),
  drives the recording lifecycle, wires Tauri event listeners for tray/hotkey
  toggles, and refreshes the meeting list when a recording completes. Uses
  `useRef` for status/template so event-listener closures don't go stale.
- **`lib/tauri.ts`** — the single typed IPC boundary. Every function maps 1:1 to
  a Rust command (`startRecording`, `stopRecording`, `enqueueRecording`,
  `transcribeMeeting`, `resummarizeMeeting`, `getMeetings`, `getMeeting`,
  `getConfig`, `updateConfig`, `checkServiceHealth`). All return Promises that
  reject with the Rust error string.
- **Hooks** — `useRecording` (capture status `idle → recording → stopping`, plus a
  **background transcription queue**: on Stop a recording is enqueued and the
  status returns to `idle` immediately so the next meeting can record while the
  previous one transcribes; a single-worker drain — concurrency 1, paused while a
  recording is active — calls `transcribeMeeting(id)`), `useMeetings` (list +
  selection), `useConfig` (load/merge/save).
- **Components** — `RecordingControls`, `MeetingsList`, `NoteViewer` (summary /
  transcript tabs + re-summarize template picker), `Settings` (service URL,
  model, template, default language, **Your Name** (`user_name`), **Custom
  Vocabulary** (`custom_vocabulary`), the auto-detect toggle, health indicator),
  `ErrorBanner`, `AppShell`.

Conventions: function components with explicit prop interfaces (no `React.FC`),
immutable state updates, dark theme only.

## Layer 2 — Tauri/Rust backend (`src-tauri/src/`)

The native shell. Owns audio capture, persistence, config, the tray/hotkey, and
all communication with the Python service.

- **`lib.rs`** — app entry. Registers plugins (shell, global-shortcut), manages
  `AppState`, and in `setup()` ensures the config dir, inits the DB, seeds the
  demo meeting, builds the tray, registers the hotkey, and starts the
  transcription drain. Lists all IPC commands in the `generate_handler!` macro.
- **`demo.rs`** (V3 Phase B) — the seeded sample meeting: one ordinary,
  deletable meeting row (dual-capture-shaped transcript + house-format notes;
  its **Action Items** feed the to-dos board via the normal
  `sync_action_items` path). Fresh installs only: gated on
  `onboarding_state.demo_meeting_seeded` AND an empty meetings table, flag set
  either way so it never re-evaluates.
- **Sidecar lifecycle (V3, in `commands.rs`)** — `spawn_sidecar` logs the
  child's stdout/stderr to `<app_data>/logs/adversaria-service.log`, sets
  `HF_HUB_DISABLE_XET=1` on all platforms, and a watchdog thread respawns a
  dead sidecar with backoff (an `AppState.shutting_down` flag keeps an
  intentional quit from being raced into a respawn). Two **retroactive
  drains** make degraded states heal themselves: pending recordings
  transcribe once `/health` reports the transcriber ready, and note-less
  transcripts summarize once an LLM engine is configured. `http_client.rs`
  translates every service error (including the structured
  `{"detail":{code,message}}` 503s) into human sentences — raw response
  bodies never reach the webview.
- **`commands.rs`** — the IPC commands and `AppState` (holds the `AudioCapture`,
  the `HttpClient`, and the current recording paths). The default record→notes
  path is now **decoupled** for back-to-back meetings: Stop → `enqueue_recording`
  (saves a pending meeting via `save_pending_meeting`, audio kept on disk) →
  the frontend queue → `transcribe_meeting(id)` (transcribe → summarize → derive
  title → update the row in place → delete WAV files). `transcribe_meeting` reads
  audio/template/notes from the DB row (no shared mutable path slot), so queued
  jobs are isolated and restartable. (`transcribe_and_summarize` — the old inline
  transcribe-then-insert — remains registered as a single-shot fallback but is no
  longer on the default path.) `resummarize_meeting` re-runs summarization on a
  stored transcript with a different template.
- **`audio/`** — **dual capture (system audio "Them" + mic "Me"), platform-split.**
  `mod.rs` holds the platform-agnostic surface: `AudioCapture`, `RecordingPaths`,
  the shared `StreamState` accumulator, the float/PCM `write_wav_file`, and the
  rolling-window `snapshot_tail` (live caption). Only the capture mechanism is
  `#[cfg]`-gated:
  - **`wasapi.rs`** (Windows) — two OS threads: the default *render* device in
    loopback mode + the default *capture* device. Shared-mode WASAPI delivers
    32-bit float (`format_tag=3`).
  - **`macos.rs`** — **ScreenCaptureKit** for system audio (planar f32 @ 48 kHz,
    interleaved into the same float-WAV format) + **cpal** for the mic on its own
    thread. The `SCStream` is held in `AudioCapture` so it stays alive between the
    start/stop IPC calls.
  Mic capture is **best-effort** on both: a missing/failing/denied mic flags
  itself not-OK and the meeting falls back to system audio only — it never aborts
  the recording. macOS system-audio capture requires the **Screen Recording**
  permission (granted once in System Settings, then restart).
- **`http_client.rs`** — typed `reqwest` client: `transcribe(audio_path, mic?, me_label?,
  vocabulary?, diarize)`, `summarize(...)`, `chat(...)` and streaming `chat_stream(...)`
  (parses the `/chat_stream` SSE via `resp.chunk()`), `embed(texts)` (batch vectors for
  the hybrid Ask index), `test_llm_connection()`, `check_health()`, `list_templates()`,
  `current_base_url()` (hands background tasks the live sidecar URL — the port is
  dynamic). Also `get_audio_level()` (live waveform) is a direct command, not via this
  client.
- **`storage.rs`** — SQLite via `rusqlite`, **encrypted at rest with SQLCipher** (feature
  `bundled-sqlcipher-vendored-openssl`; a random 256-bit key in the OS keychain, applied
  with `PRAGMA key` on every open; pre-encryption plaintext DBs are migrated in place on
  first launch — ADR-011). Tables: `meetings`, `chat_messages`, `action_items`, `people` (person profiles: role/company/notes/aliases, edited from the Graph dossier, exported to the second-brain vault),
  `meeting_chunks` + `chunk_index_state` (embedding vectors as little-endian f32 BLOBs
  for the hybrid Ask retriever), plus an FTS5 search index; columns/tables added via
  idempotent `ALTER TABLE`/migrations in `init_db`. A new (keyed) connection per call —
  no pool, fine for single user.
- **`embeddings.rs`** (2026-07-09) — the **hybrid Ask retrieval layer**. Chunks each
  meeting (~1.5 KB passages: grouped transcript turns + summary sections, title-prefixed)
  and embeds them via the service's `POST /embed` (Ollama **bge-m3**, 1024-dim,
  multilingual). `sync_index` is self-healing (fingerprint + model staleness,
  concurrency-guarded) and fires at startup, after every transcribe / import /
  re-summarize / structure-note, and on each Ask. Query time: `hybrid_rank` fuses
  FTS5 (w 1.0) + per-chunk cosine (w 1.0, ≥ 0.30 gate) + attendee/tag graph anchors
  (w 1.5) with reciprocal-rank fusion (k = 60); detail answers ground in the matched
  chunks instead of the transcript's first 4 000 chars. If the embed model isn't
  pulled or the service is down, Ask degrades to the pre-hybrid keyword path.
- **`config.rs`** — loads/saves `AppConfig` as JSON in the platform app-data dir.
- **`tray.rs`** — system tray menu + `Ctrl+Shift+M` global hotkey. Both emit
  events (`tray-toggle-recording`, `hotkey-toggle-recording`) the frontend
  listens for. Hotkey registration is non-fatal — if the combo is taken the app
  still starts and the tray menu remains the control.
- **`types.rs`** — shared serde types (`Meeting`, `AppConfig`, the response DTOs).

## Layer 3 — Python ML service (`python-service/`)

A FastAPI app (uvicorn, port 9876) that does the heavy ML. Since V3
(2026-08-01) the service **always serves within seconds, model-less if need
be**: the transcriber loads on a background thread with `local_files_only`
(never downloads — model bytes arrive only through `model_setup`'s pinned
pipeline on an explicit user action), and a module-level state machine
(`loading | ready | missing | error`) is reported by `/health` and re-attempts
init on demand and when a whisper download completes. The summarizer/embedder
singletons still come from the lifespan.

Endpoints:

| Method/Path | Purpose | Request → Response |
|-------------|---------|--------------------|
| `GET /health` | readiness | → `{status, whisper_model, ollama_available, transcriber_state, transcriber_detail}` |
| `GET /templates` | list templates | → `[{name, description}]` |
| `GET /templates/{name}` | raw template | → `{name, content}` |
| `POST /transcribe` | speech→text (+ diarization) | `{audio_path, mic_audio_path?, me_label?, vocabulary?, diarize}` → `{text, language, duration_seconds}` |
| `POST /summarize` | text→notes | `{transcript, template_name, model?, llm_base_url?, llm_api_key?}` → `{summary, template_used, title, attendees, category}` |
| `POST /chat` | grounded Q&A | `{transcript, question, model?, llm_base_url?, llm_api_key?}` → `{answer}` |
| `POST /chat_stream` | streaming Q&A | same as `/chat` → SSE: `data:{"t":"…"}` frames, ended by `[DONE]` |
| `POST /embed` | batch text embeddings (hybrid Ask) | `{texts, model?}` → `{embeddings, model, dim}`; 503 + `ollama pull bge-m3` hint when the model is missing |

- **`embedder.py`** — `OllamaEmbedder`: batch text embeddings via a local Ollama
  model (default `bge-m3`, override with `EMBED_MODEL`). Independent of the
  summarizer's LLM backend (on this Mac the LLM is Rapid-MLX/openai while
  embeddings go to Ollama on :11434).
- **`transcriber.py`** — two transcription backends behind a `create_transcriber()`
  factory (selected by `WHISPER_BACKEND`, else auto: MLX on arm64 macOS,
  faster-whisper elsewhere):
  - **`WhisperTranscriber`** (faster-whisper, Windows/CUDA) — patches the Windows
    PATH for the pip `nvidia-*` CUDA DLLs, tries CUDA then falls back to CPU
    (int8). Uses `vad_filter=True`, `beam_size=5`.
  - **`MlxWhisperTranscriber`** (mlx-whisper, Apple-Silicon GPU) — runs
    `whisper-large-v3-mlx` on the Metal GPU. Greedy-only (no beam search) and no
    VAD, so silence-hallucination is suppressed with `no_speech_threshold` +
    `logprob_threshold` + `compression_ratio_threshold` +
    `condition_on_previous_text=False`. Needs the `ffmpeg` CLI.
  Both share `transcribe_dual()` / `_merge_dual()`, which transcribe the system
  and mic WAVs separately. When `diarize` is on, **`diarizer.py`** (sherpa-onnx,
  offline; ADR-012) splits the *system* channel into `Speaker 1/2/…` by
  time-overlap (mic stays `Me`); otherwise the system side is a flat `Them`.
  `merge_labeled_segments()` then interleaves all segments by start time into a
  `Speaker N:` / `Them:` / `Me:` dialogue. A module-level
  `relabel_me(text, me_label)` then rewrites line-leading `Me:` to the user's
  configured name (from `user_name`). Both backends also carry a per-request
  `initial_prompt`, set by `/transcribe` from `vocabulary` (as `Glossary: <terms>`,
  cleared in a `finally`) and passed to Whisper to bias spelling of names/jargon.
- **`summarizer.py`** — LLM summarizer behind a backend abstraction (ADR-009).
  Loads a prompt template, sends the delimited transcript, and requests
  **structured JSON** (`MeetingNotes` schema) — via Ollama `format=` or the
  OpenAI `response_format` field — then parses it into a title, attendee list,
  and sections and renders Markdown. `default_llm_backend()` selects the backend:
  **Rapid-MLX** (OpenAI-compatible, `qwen3.6-27b`) on Apple-Silicon macOS,
  **Ollama** (`qwen3.6:35b-a3b`) elsewhere; `LLM_BACKEND`/`LLM_BASE_URL` override.
  Reasoning models get `think=False` / `enable_thinking=false`. Model is
  configurable per request (the app sends the user's `ollama_model`).
- **`config.py`** — discovers/loads prompt templates from `prompts/*.md`.
- **`models.py`** — Pydantic v2 request/response models.
- **`prompts/`** — editable templates: `general`, `one-on-one`, `client-meeting`.
  Drop a new `.md` file here and it appears in the API automatically.

## End-to-end data flow (record → notes)

1. User toggles recording (button, tray, or `Ctrl+Shift+M`) → `start_recording`
   spawns the two WASAPI capture threads writing to `%TEMP%\meeting_<ts>.wav`
   and `…_mic.wav`.
2. Toggle again → `stop_recording` joins the threads, finalizes the WAVs, returns
   the system path (mic path kept in `AppState`).
3. Frontend calls `enqueueRecording(audioPath, template, notes)` → Rust saves a
   **pending** `Meeting` (audio kept on disk) and returns it immediately; the
   capture status returns to `idle` so the **next meeting can start recording
   right away**. The pending meeting is pushed onto the frontend's transcription
   queue.
4. A single-worker queue drain (concurrency 1, **paused while a recording is
   active**) calls `transcribeMeeting(id)` → Rust POSTs both WAV paths to
   `/transcribe`, plus `me_label` (from `user_name`) and `vocabulary` (from
   `custom_vocabulary`), read fresh per call.
5. Python transcribes (GPU), merges into a speaker-labeled transcript; Rust POSTs
   it to `/summarize` → the LLM returns structured notes.
6. Rust derives a title, **updates the pending row in place** (transcript, summary,
   attendees, tags, duration) and clears `audio_file_path`, then **deletes both
   WAV files** (audio never outlives a *successful* transcription). On failure the
   row stays pending with its audio kept, so the NoteViewer "Transcribe now" banner
   can retry.
7. Frontend refreshes; the meeting shows a **Transcribing…/Queued** badge while in
   the pipeline, then fills in with transcript + summary tabs. Re-summarize with a
   different template at any time.

## Storage & config locations

`directories`/`BaseDirs::data_dir()` resolves per-OS, so the same code lands at:
- Windows: `%APPDATA%\meeting-note-taker\` (`meetings.db`, `config.json`)
- macOS: `~/Library/Application Support/meeting-note-taker/`

Config keys: `python_service_url`, `default_prompt_template`,
`auto_detect_meetings`, `ollama_model`, `summary_language`, `user_name`,
`custom_vocabulary`, `claude_api_key`.

## Tech stack & versions (verified 2026-06-17)

| Area | Stack |
|------|-------|
| Frontend | React 18.3, Vite 6, TypeScript 5.9 (installed; `^5.6.3` floor), Tailwind 3.4, `@tauri-apps/api` 2 |
| Backend (shared) | Tauri 2, `rusqlite` 0.31, `reqwest` 0.12, `tokio` 1, `chrono` 0.4, `directories` 5 |
| Backend (Windows) | `windows` 0.58 (WASAPI capture), `winreg` 0.52 (mic-detect) |
| Backend (macOS) | `screencapturekit` 7.0.1 (system audio), `cpal` 0.18 (mic), `coreaudio-sys` 0.2 + `core-foundation` 0.10 (mic-detect); `macos-private-api` feature for the transparent card |
| ML service | FastAPI ≥0.115, uvicorn ≥0.34, Pydantic 2.13, ollama (py) 0.6.x |
| Transcription | faster-whisper 1.2.1 / CTranslate2 (Windows/CUDA); mlx-whisper 0.4.3 + mlx 0.31 (macOS/Metal, `mlx` extra, needs `ffmpeg`) |
| LLM serving | Ollama (Windows/Linux); Rapid-MLX 0.6 (macOS, OpenAI-compatible on `:8000/v1`) — both via the ADR-009 backend abstraction |
| Models | Whisper `large-v3` (CUDA on Win; `whisper-large-v3-mlx` on Apple GPU); LLM `qwen3.6:35b-a3b` via Ollama / `qwen3.6-27b` (`Qwen3.6-27B-4bit`) via Rapid-MLX — configurable; `think=False` |
| Hardware (dev) | Windows: RTX 5090 (Blackwell sm_120). macOS: Apple M5 Max (arm64, macOS 26.5) |
