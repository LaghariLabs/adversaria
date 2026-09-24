# Architecture

How Meeting Note Taker is built and how data flows through it. For *why* it's
shaped this way, see [DECISIONS.md](./DECISIONS.md). For the original full
design spec, see [`superpowers/specs/2026-06-11-meeting-note-taker-design.md`](./superpowers/specs/2026-06-11-meeting-note-taker-design.md).

## Overview

A three-layer desktop app, cross-platform across **Windows** and **macOS**
(Apple Silicon). The private default path runs on one machine through loopback
HTTP between Rust, the Python service, and local engines such as Ollama. When
the user explicitly configures a cloud transcription or LLM provider, or opts
into Live Copilot's Claude and web modes, the Python service also makes those
consented external requests. Only the OS-specific layers differ: audio capture,
meeting detection, and the Whisper backend (see the per-layer notes below); the
React UI, SQLite store, config, and HTTP client are shared.

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
  the shared `StreamState` accumulator, the float/PCM `write_wav_file`, and
  `snapshot_since` (the append-only live buffer's delta since the last byte
  offset — the live-caption feed; `commands.rs::spawn_live_caption` polls it
  every `LIVE_CHUNK_MS` = 500 ms per source and emits `live-transcript` for
  confirmed utterances and `live-partial` for the grey preview, replace
  semantics, cleared on stop). Only the capture mechanism is
  `#[cfg]`-gated:
  - **`wasapi.rs`** (Windows) — two OS threads: the default *render* device in
    loopback mode + the default *capture* device. Shared-mode WASAPI delivers
    32-bit float (`format_tag=3`).
  - **`macos.rs`** — a **Core Audio process tap** (`AudioHardwareCreateProcessTap`,
    driven through cpal's loopback input) for system audio + **cpal** for the mic on
    its own thread. ScreenCaptureKit was removed on 2026-08-13 (`9589e8c`); the tap
    needs the *System Audio Recording* grant, not *Screen Recording* (see
    LESSONS_LEARNED 2026-08-17). The tap stays anchored to the default output
    device chosen at start (`audio/macos.rs` header).
  Mic capture is **best-effort** on both: a missing/failing/denied mic flags
  itself not-OK and the meeting falls back to system audio only — it never aborts
  the recording. macOS system-audio capture requires the **System Audio Recording**
  permission (`kTCCServiceAudioCapture`; an app that already holds Screen Recording
  is silently denied the prompt, see LESSONS_LEARNED 2026-08-17).
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

### Live Copilot v2 (2026-09-05, `feat/live-copilot-c`; ADR-020, spec `docs/superpowers/specs/2026-09-05-realtime-copilot-v2.md`)

Realtime, session-bound answer cards while recording with local passages first and one grounded answer (Local or Claude, by consent):

- **Durable Session Identity & Isolation:** Each recording session generates a UUIDv4 `session_id` (`copilot_session.rs`, `storage.rs`) tracked in `copilot_sessions(session_id PRIMARY KEY, meeting_id, started_at)`. All authoritative IPC events (`copilot-card`, `copilot-answer`) and database rows are tagged with `session_id`. (The expressive bubble headline `copilot-headline` is deferred; the companion answer strip and slide-over sheet are implemented.) The frontend listener drops any event whose `session_id` does not match the active recording session, eliminating cross-session leakage.
- **Latest-Intent Queue & Backpressure:** Replaced legacy FIFO/blackout with a 1-active + 1-waiting slot model (`CopilotSession`). A new distinct question replaces the waiting job (`skipped {reason: "superseded"}`) while the active stream completes without interruption. Distinct check compares normalized text against active, waiting, and the last 3 answered questions.
- **Two-Level Cancellation Model:** Session `CancellationToken` parents per-card child tokens. Stopping recording, starting a new recording, or changing modes (`copilot_set_mode`) triggers immediate cancellation (`cancelled {session_ended | mode_changed}`), retires the active Rust request, and preserves partial markdown. Python's control path polls disconnects every 50 ms and an offline cooperative-generator test closes within 500 ms; actual live SDK/socket teardown timing remains unmeasured.
- **Grounding & Egress Snapshot Timing:** Provider, mode, question, context turns (≤ 2 preceding Them turns ≤ 600 chars each), persona, and web preferences are frozen at capture when a question is heard. Grounding passages (top 3 ≤ 600 chars each, source basename) are retrieved when a queued card transitions to active; retry reuses them only when the original retrieval completed and otherwise retrieves again. Bounds are enforced in Rust before dispatch; `egress_bytes` measures the sidecar request JSON after removing the API key.
- **Registered Local Endpoints:** Local provider requests are restricted to approved loopback endpoints (default Ollama `http://127.0.0.1:11434`, managed Ollama, and managed Rapid-MLX `http://127.0.0.1:port/v1`). Unapproved hosts, non-http schemes, userinfo credentials, or remote endpoints are rejected at snapshot creation in Rust and return HTTP 400 in Python before any socket connection.
- **Authoritative Stream Termination:** Python (`copilot_answer.py`, `summarizer.py`) emits `data: [DONE]` only on authoritative stop signals (`finish_reason: "stop"` or Claude final message). Premature EOF, `length` token cutoff, or exceptions emit typed error frames (`ended_early`, `length`, etc.) and never emit `[DONE]`. Rust treats EOF without `[DONE]` or missing usage as `error {ended_early}`.
- **Deterministic Provenance & Grounding:** `copilot_provenance.rs` assigns `notes` when a bullet shares ≥ 5 consecutive normalized tokens with a passage; `web` requires token match + URL + `web_performed > 0`; otherwise `model`. Questions containing `\b(you|your|yourself)\b` without passages enforce a `"Not in your notes"` prefix on the first bullet.
- **Guarded Persistence & Accounting:** One INSERT when heard; terminal persistence (`done`, `skipped`, `cancelled`, `error`) is guarded, persisted before emit, and retried three times, with no recovery after all three SQLite attempts fail. Meeting attach maps `session_id` to `meeting_id`. Finished meeting receipt calculates `questions`, `claude_questions`, `egress_bytes`, and authoritative `web_performed`.
- **Companion UX:** Balanced view features a one-line answer strip above tabs. Transcript-first view mounts a 360 px slide-over sheet (`companion-copilot-sheet`) above the transcript without unmounting it. Pin to notes writes bracketed provenance tags (`[your notes]`, `[Local]`, `[Claude]`). Mode/key changes handle errors optimistically with UI notices.

### Export formats (2026-09-03)

- **Slide / PDF:** `buildSlideHtml(meeting, ExportTheme)` (`src/lib/exportDocument.ts`) renders one self-contained HTML deck from a snapshot of the live theme tokens (`readExportTheme()` reads `data-theme` + the `--bg-*`, `--text-*`, `--accent-*`, `--font-*` variables); `@media print` keeps the theme (`print-color-adjust: exact`) and the deck carries a `Print / Save as PDF` button. Written by `export_html` (rfd save dialog). There is no native PDF renderer.
- **`.adversaria` document** (`src-tauri/src/adversaria_doc.rs`): UTF-8 JSON `{format:"adversaria", schema_version:1, document_uid, exported_at, app_version, scope{kind,root_uid}, folders[{uid,name,color,instructions,copilot_mode,meeting_uids}], meetings[{uid, …meeting fields…, action_items[{ord,text,assignee,due,done,status,completed_by,completed_at,evidence}], attachments[{kind,label,file_name,meeting_uid}]}]}` — no audio, no embeddings, no paths, no file bytes. `meetings.uid` / `folders.uid` (UUID v4, backfilled by migration) make re-import idempotent. Commands: `export_adversaria(meeting_ids, folder_id)` (selection or whole folder), `import_adversaria(path?) -> ImportReport` (skips existing uids, matches folders by uid then name, else creates; legacy `{schema_version:1, meeting}` `.adversaria.json` still imports), `take_pending_open_files`. OS: `bundle.fileAssociations` registers `.adversaria`; `RunEvent::Opened` (macOS), argv (Windows/Linux) and single-instance args feed the `open-adversaria-file` event (queued until the frontend mounts). The old `export_meeting_bundle` / `import_meeting_bundle` are thin wrappers.

### Live Copilot rev 6 (2026-09-06 to 2026-09-09, `feat/live-copilot-c`, uncommitted; contracts in `.recon/copilot-rev6/` and `.recon/interview-copilot-20260908/spec2-pinned.md`)

Rev 6 turns the copilot into an **interview copilot** (founder decision 2026-09-08; the meeting flow is unchanged). Answers are four labelled sections streamed as `{"t","sec","i"}` frames: `SAY` (spoken, first person, one of four shapes: definition, how/why, compressed STAR experience, design), `SPECIFIC`, `NOTES` (`P<n> | "quote" | clause`, only on real keyword overlap), `NEXT`. The context envelope per request (schema v7, `python-service/src/models.py` `CopilotAnswerRequest`) is, in order: **PACK** (standing pack: the folder profile plus the first paragraph of every `<project>-overview.md` among the folder's sources, ≤ 6,000 bytes, byte-stable so DeepSeek/Anthropic prefix caches hit; built by `folder_sources::build_pack`, stored on `copilot_sessions.pack_text/pack_hash`, frozen per job), **HEADER** (`Purpose:` then `About Me:`), **SUMMARY** (reserved), **RECENT CARDS** (the last three `done` cards of the session as reference-only JSON, ≤ 2,400 bytes local / 1,600 cloud), recent **turns** (8 local / 4 cloud), up to **3 passages** (600 chars, 1,000 bytes cloud), **VOICE** samples, the **QUESTION**; drop order VOICE, RECENT CARDS, SUMMARY, HEADER, PACK, oldest turns, highest passages; envelope 32,768 bytes local / 24,576 cloud; `COPILOT_MAX_TOKENS` 640.

Retrieval (`copilot.rs`): question keywords (≥ 4 letters, plus the folder's acronym allowlist `folders.folder_terms` rebuilt at sync from doc titles) → tiers live notes (0.9) · folder meetings FTS (0.85) · attachments (0.8) · vault/project context under the folder's source paths (semantic, ≥ 0.55) · **folder docs** (FTS5, title ×10, one best paragraph per file, score `0.86 + 0.10 × coverage`, fully covered hits first) → canonical dedup (`file:<path>`, `meeting:<id>`, `notes`, `project:<dir>`) → 3 passages within 900 ms. A `resolved_question` (question keywords plus up to four from the previous card when the question is short or reuses the previous SAY's words) drives retrieval and the NOTES floor. Providers: Local (`copilot_local_model`, default `qwen3.6:35b`, preloaded by `POST /copilot/warm` with the answer path's `num_ctx` and `keep_alive` 30 min), DeepSeek (`copilot_deepseek_model`, default `deepseek-v4-flash`, endpoint locked), Claude (API key, PACK as its own cached block), No AI (passages only). Session start emits `copilot-folder-ready` (`indexing` → `ready {count, pack_projects, pack_chars, pack_hash}` | `error`), mirrored by the `copilot_folder_readiness` command; the retrieval consumer waits for readiness up to 10 s. Deferred: speculative start on partial captions, the practice runner with blind ratings, the running summary, a semantic tier for folder docs. Evidence format for folder sources: `docs/COPILOT_DOSSIER_RECIPE.md`.

### Live Copilot v3 (2026-09-14, `feat/live-copilot-c`, uncommitted; contracts in `.recon/copilot-ux-20260913/slice1-contract.md` and `slice2-contract.md`)

- **History:** `copilot_cards` gains `pinned_at`, `dismissed_at`; Tauri `copilot_cards_for_meeting(meetingId) -> MeetingCopilotHistory` (rows with `meeting_id` or session-attached rows with null meeting_id; `sections` parsed from `answer_md` by `copilot_provenance::parse_sections`) and `copilot_card_review(sessionId, cardId, action: pin|unpin|dismiss|restore)`. Frontend: lazy `CopilotHistory.tsx` behind the note view's **AI Copilot** tab.
- **Live review:** `copilot_live.rs` (pure scheduler/state: `push_turn`, `should_extract`, `build_request`, `apply_response`, `review`, `snapshot`), `copilot_session.rs::run_live_extractor` (5 s tick; runs only when enabled, mode `local`, ≥ 45 s since last run, ≥ 80 new words, no active/waiting answer job, ≥ 3 s after the last answer; back-off 60 s / 180 s after three errors), tables `copilot_live_items` and `copilot_live_summary`, commands `copilot_live_state`, `copilot_live_configure`, `copilot_live_review`, event `copilot-live-state` (`LiveState` snapshot, revision-gated on the frontend). Python `POST /copilot/live_extract` (`live_extract.py`: JSON-schema one-shot Ollama call, `think=False`, temperature 0, `num_predict=768`; evidence ids validated against the request turns). Frontend: lazy `LiveReviewPanels.tsx` under the copilot cards in `RecordingCompanion.tsx`.
- **Accepted items → summary (slice 3):** `SummarizeParams.accepted_live_items` (Rust, omitted when empty; from `accepted_live_items_for_session` at the first summary, `_for_meeting` on regenerate) → `SummarizeRequest.accepted_live_items` → `<accepted_live_items>` prompt block + `general.md` exception → `_ensure_accepted_items_section` before `_render`. `MeetingCopilotHistory.live_items` feeds the AI Copilot tab's Live review group.
- **Secrets:** `secrets.rs` is the single keychain boundary (copilot keys, calendar tokens, spool key, DB key). Release builds use the OS keychain; debug builds use `<app_data>/dev-secrets.json` (0600) with a one-time keychain→file copy on a miss, so unsigned dev rebuilds stop prompting; `ADVERSARIA_SECRET_STORE=keychain|file` overrides.
- **Trigger policy:** `copilot::classify_candidate` → mode rules, soft gap and intent suppression in `copilot_session.rs` → optional `POST /copilot/gate` (`copilot_gate.py`, `answer|ignore` + `resolved_question`) before retrieval; `resolved_question` reaches retrieval, the answer prompt (`HEARD AS`) and the card.
- **Answer shape (updated 2026-09-19):** brief = one plain SAY sentence that names the subject (definition questions: "X is a [category], [field or branch], that [defining mechanism]", at most 30 words, no markdown) plus two or three SPECIFIC lines of the form `**Keyword**: short phrase` (at most 16 words, each one concrete fact); steps = a plain approach sentence plus 2 to 6 steps of at most 10 words, optionally one bold term. Specific caps are 3 (brief) and 6 (steps) in both the Python parser and Rust `specific_cap`; `**` passes through untouched and the frontend renders it with `src/lib/inlineBold.tsx`. Every copilot call to the local model uses `COPILOT_NUM_CTX` (16384) so Ollama never reloads the runner. Recent cards (max 3, oldest first) carry `question`, `say` and `points` (the card's SPECIFIC lines, max 6) so follow-ups can continue a list.
- **Notes editor:** `src/components/NotesEditor.tsx` (TipTap 3.31.3, `@tiptap/markdown`, `@tiptap/extension-list` task items, image by URL; lazy chunk ~480 kB) used by the Personal Notes tab and the companion Notes tab; the stored value stays markdown (`update_meeting_notes` unchanged).
- **Styles:** new per-feature stylesheets `src/styles/live-copilot.css`, `src/styles/copilot-history.css`, `src/styles/notes-editor.css` (tokens only) instead of growing `prototype.css`.

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
| `GET /health` | readiness | → `{status, whisper_model, ollama_available, transcriber_state, transcriber_detail, embedder_state, embedder_detail, live_captions_state}` |
| `GET /templates` | list templates | → `[{name, description}]` |
| `GET /templates/{name}` | raw template | → `{name, content}` |
| `POST /live_feed` | live captions, two tiers | `{audio_path (delta WAV of NEW audio), session (recording epoch), source: "them"\|"me"}` → `{captions: [confirmed utterances], partial: "grey preview of the unconfirmed tail"}` (2026-09-01, ADR-019) |
| `POST /transcribe` | speech→text (+ diarization) | `{audio_path, mic_audio_path?, me_label?, vocabulary?, diarize}` → `{text, language, duration_seconds}` |
| `POST /summarize` | text→notes | `{transcript, template_name, model?, output_language?, user_notes?, attached_context?, prior_meetings?: [{title, date, open_items[]}], meeting_date?, llm_base_url?, llm_api_key?}` → `{summary, template_used, title, attendees, category, attendee_details}` — `user_notes` steer the notes and get a final "From Your Notes" section; `attached_context` (file text + an attached meeting's summary) is background only; `prior_meetings` (attached meetings' OPEN action items, built by `commands.rs::prior_meetings_for`) yield a deterministic "Follow-up from <meeting>" section (`summarizer.py::_ensure_followup_section`, Done/Discussed only with a verbatim transcript quote) |
| `POST /chat` | grounded Q&A | `{transcript, question, model?, llm_base_url?, llm_api_key?}` → `{answer}` |
| `POST /chat_stream` | streaming Q&A | same as `/chat` → SSE: `data:{"t":"…"}` frames, ended by `[DONE]` |
| `POST /copilot_answer_stream` | live copilot answer (slice C) | `{provider: "claude"\|"local", question, context_turns[≤2], passages[≤3]{title,text≤600,source}, persona?, web_search, api_key? (claude), model?, llm_base_url?, llm_api_key?}` → SSE frames `{"t"}` text, `{"c":{kind:notes,passage_index,cited_text}}` / `{"c":{kind:web,url,title,cited_text}}`, `{"w":"searching"}`, `{"usage":{input_tokens,output_tokens,web_searches}}`, `{"error"}`; `[DONE]`. Claude: `anthropic` SDK `messages.stream`, `claude-opus-5`, adaptive thinking, effort low, max_tokens 400, passages as `document` blocks with citations, `web_search_20260209` max_uses 1 `allowed_callers: ["direct"]`. Local: `summarizer.copilot_stream` on the same dispatcher as `/chat_stream` (`copilot_answer.py`) |
| `POST /embed` | batch text embeddings (hybrid Ask) | `{texts, model?}` → `{embeddings, model, dim}`; 503 + `ollama pull bge-m3` hint when the model is missing |

- **`live.py`** — live captions, two tiers per audio source (ADR-019). `LiveCaptionSession`
  buffers the delta feed, Silero-VAD segments it, and yields FINISHED utterances
  once each for the resident Whisper (confirmed `captions`, any language). The
  PREVIEW tier: `unconfirmed_tail()` (audio after the watermark, from the first
  VAD speech region, capped to the LAST 8 s) is re-decoded on every poll by
  `MoonshinePartialEngine` (sherpa-onnx Moonshine v2 tiny, English, pinned profile
  `live-captions-en`, ~44 MB, built at startup / when its download lands) and
  returned as `partial`; loops are trimmed to the sane prefix, fillers dropped,
  and the preview self-gates off when Whisper reports a non-English utterance
  (`note_confirmed_language`). The preview never takes the Whisper lock, so a
  running `/transcribe` delays confirmations only.
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

## Workspaces and Meeting projects — one data model, two surfaces

_Added 2026-08-22 (Phase 3a), extended 2026-08-30. The Workspaces tab remains
development-only; its project-facing Meetings-tab surface is available through
the regular Meetings UI. Both operate on the same workspace rows and bindings._

```
meeting summarized ──sync_action_items──▶ action_items
        │ (bound meeting)                      │
        ▼                                      ▼
meeting_workspace_bindings ──push──▶ workspace_tasks (queued)
                                           │  autopilot::kick → drain
                                           ▼
                                   workspace_runs (running, one per workspace)
                                           │  run ends
                                           ▼
                                 task = awaiting_review ──Approve──▶ done + action_item.done/evidence
                                           └──Reject(note)──▶ queued (attempt+1, note in brief)
```

- **Tables** (`storage.rs`): `workspaces` (including `instructions`, `color`,
  `network_allowed`, and cached-overview fields), `workspace_context_items`,
  `workspace_tasks` (status `queued|running|awaiting_review|done|failed`,
  `action_item_id`, `attempt`, `rejection_notes` JSON), `workspace_runs`,
  `workspace_artifacts`, `meeting_workspace_bindings` (no row = undecided,
  `workspace_id NULL` = "not a project"). `migrate_workspace_tasks_v2` rebuilds
  the task table on databases created before 08-22.
- **Project lifecycle**: `create_workspace` creates the same row used by both
  surfaces. Each meeting has at most one `meeting_workspace_bindings` row.
  `delete_workspace_on` removes bindings for that workspace before deleting the
  container; meeting and action-item rows are deliberately preserved and become
  unfiled. Other projects and their bindings are untouched.
- **Routing**: `suggest_workspace_for_meeting` scores every workspace
  `2·|related meetings via embeddings::hybrid_rank| + |shared attendees|`
  (≥ 2 to suggest). `set_meeting_workspace_binding` stores the decision and
  pushes every open, "mine" to-do of that meeting as a task (dedup by
  `action_item_id`); `sync_action_items` re-links tasks after re-extraction
  and pushes new items.
- **Runs**: `commands::execute_workspace_run` is the single executor (Run
  button and autopilot both call it; the frontend channel is one `LogSink`).
  `AppState.autopilot_gate` serialises "check nothing is running in this
  workspace → mark running". Engines: `local` (streamed from the Python
  service), `claude` / `codex` (headless CLIs supervised in
  `workspace_runs.rs`, 15-min cap, Stop kills the child). Output dir only.
- **Autopilot** (`autopilot.rs`): `kick(app)` is idempotent; it drains when
  `AppConfig.agents_paused` is false: per workspace with nothing running,
  start the oldest queued task on the workspace's engine if detected. Kicked
  on task create, binding set, reject, resume, engine change, run end (only
  after a run existed), summary sync, and 15 s after launch. Startup re-queues
  tasks orphaned in `running`; a task that cannot start is moved to `failed`
  with a failed run carrying the error so the queue keeps moving.
- **Brief**: standing instructions + task + rejection notes + bound meetings (summary + transcript,
  20k chars) + top-3 related meetings from `embeddings::hybrid_rank`
  (summaries only) + read-only folders. The brief explicitly states whether the
  per-project web-research gate allows network access; the run log's first line
  is the context receipt. Artifacts are previewed in-app (`read_workspace_artifact`,
  sandboxed to the workspaces root; `src/lib/markdown.ts`).
- **Context engine** (`context_index.rs`): the Obsidian vault and the projects
  root are indexed (FTS5 + chunk embeddings) like meetings; every run
  searches the to-do text across meetings, vault notes, and project cards
  with a relevance floor, and the receipt names what was used. Skills and
  agents (`addons.rs`) are injected into the brief and written natively for
  Claude Code / Codex.
- **Frontend contract**: `workspace-task-changed` event `{workspace_id,
  task_id}` after every state change; the detail view polls
  `get_latest_workspace_run` every 2 s for runs it did not start (the run log
  is persisted every ~0.5 s by the supervisor, every 40 tokens for `local`).
- **Meetings-tab project surface**: `MeetingsList.tsx` owns create, select,
  move/drag, and confirmed-delete interactions. `App.tsx` resolves project and
  binding state, prioritizes `ProjectView.tsx` over the note/empty pane, and
  clears project selection when a note opens. `ProjectView.tsx` renders a wide
  responsive two-column canvas: overview/meetings/instructions/web controls on
  the left, open action items on the right.
- **Project overview** (`project_overview.rs`): the selected Notes engine
  summarizes only the project's filed meeting summaries/transcript excerpts,
  plus its standing instructions. Generation never browses the web. The cache
  key hashes ordered meeting source content, instructions, and a prompt-version
  constant; changing any of them makes the result stale. The prompt carries the
  exact filed-meeting count to prevent grouped events being reported as the
  number of meetings. Attendee frequency chips are deterministic and do not
  infer roles.

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
