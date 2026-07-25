# Adversaria

**A meeting notetaker that runs entirely on your own machine.**

No bot joins your call. Nothing is uploaded. The recording is deleted the moment
it's transcribed. Pull the ethernet cable and it works exactly the same.

[**⬇ Download for macOS**](https://github.com/LaghariLabs/adversaria-releases/releases/latest)
· macOS 14.4+ on Apple Silicon · Windows in progress · MIT licensed

---

It records your system audio **and your microphone** as two separate streams (no
bot joins the call), transcribes them locally
([faster-whisper](https://github.com/SYSTRAN/faster-whisper) on Windows/CUDA, MLX
on Apple Silicon), and generates structured notes with a managed local LLM
(Rapid-MLX on macOS, or Ollama on Windows). In the default local mode, meeting
audio, transcripts, and prompts stay on the machine. Optional cloud/BYOK modes
are explicit and disclosed before use; see [the network-boundary guide](docs/PRIVACY_NETWORK_BOUNDARIES.md).

## Features

Capture is the easy part. Adversaria is built around what happens *after* —
turning a pile of recordings into something you can actually search, act on, and
carry with you.

**Recording**
- **No bot joins the call.** It captures the audio your machine already plays and
  the mic it already hears, as **two separate streams**, so it always knows who
  spoke. The audio file is deleted once transcription succeeds.
- **Speaker-labeled transcripts** — `Me:` / `Them:`, plus on-device **diarization**
  of the remote side into Speaker 1/2/…, with `[MM:SS]` timestamps per turn.
  Multilingual, including **Arabic/RTL** summaries.
- **A recording companion + notch pill** — while recording, the app collapses to a
  slim panel for docking beside a call; switch away and a pill tucks into the
  notch with a live timer, per-channel waveforms, and the running caption.
  Toggle from anywhere with **⌘⇧M**; **⌘⇧N** jots a quick note.

**Organization — the point of the whole thing**
- **Notes that match the meeting.** It detects a 1:1, a job interview, a
  brainstorm, a standup, or a video you just watched, and writes each one
  differently. Your manual choice always wins.
- **To-dos, compiled automatically.** Action items are extracted from every
  meeting into one **triage board** (Overdue / This week / Later, drag-and-drop to
  change the due date) or a focus queue — with owners, editable due dates,
  meeting-scope filters, and twice-daily notification digests. You never retype a
  follow-up.
- **Weekly Briefing** — your week written by the local model: decisions made, open
  loops carried forward, plus stats.
- **Knowledge graph** — an interactive map of every meeting, person, tag, and
  action owner, built from local data with zero LLM calls. Click a person for a
  dossier: every meeting you've had together, and an editable profile.
- **Contacts that fill themselves in** — a person's **role and company are
  extracted from what was actually said out loud**; email, phone, and LinkedIn are
  yours to add. Anything you type always beats what the model inferred.
- **Ask across meetings** — hybrid retrieval (SQLite FTS5 + on-device embeddings +
  graph anchoring, RRF-fused) answered by your local model, with the meetings it
  drew from.
- **Meeting insights, zero AI calls** — talk-time share, speaking pace against the
  130–175 wpm target, filler-word rate, interruptions, longest monologue.
- **A sidebar that stays short** — compact rows in date bins, archive, per-meeting
  **tags**, a date heatmap, pin / delete / **privacy-lock** (per-meeting PIN), and
  `@` in search to filter by attendee.

**It's yours to take**
- **Export** a meeting as a dark **slide** (HTML → one-page PDF), **Markdown**, or
  a portable **`.adversaria.json` bundle**; mirror everything into an Obsidian
  vault with `[[wikilinks]]`; back up and restore from Settings → Data.
- **Import** a voice memo or audio file and it's transcribed locally like anything
  else.
- **[MCP server](https://github.com/LaghariLabs/adversaria-mcp)** — a separate,
  open-source, **read-only** server that exposes your meetings and to-dos over the
  Model Context Protocol, so **Claude Desktop, Claude Code, or any MCP client** can
  answer questions from them. It runs locally and makes no network calls of its
  own. Tools: `list_recent_meetings`, `search_meetings`, `get_meeting`,
  `get_action_items`.
- **Chat with a single meeting**, re-summarize on demand, edit summaries, and add
  custom vocabulary for names the transcriber keeps missing.

## Install (macOS, Apple Silicon)

**Just want to use it?** Download the signed, notarized DMG from the
[releases page](https://github.com/LaghariLabs/adversaria-releases/releases/latest),
drag it to Applications, and launch. Requires macOS 14.4+ on Apple Silicon.

To build it yourself instead — the packaged app bundles the Python ML service, so
**no terminal is needed at runtime**:

1. Build the installer (one command; needs the dev toolchain in [Prerequisites](#prerequisites)):
   ```bash
   ./scripts/build-dmg.sh
   ```
   → produces `src-tauri/target/release/bundle/dmg/Adversaria_aarch64.dmg`.
2. Open the `.dmg`, drag **Adversaria** to **Applications**, and launch it.
3. Complete the in-app setup. Adversaria checks hardware, recommends a local
   model sized to your Mac (recommended, not forced — you can switch it later in
   **Settings → AI Engine**), downloads and verifies it, starts its bundled
   Rapid-MLX runtime, and runs a sample summary. No Homebrew, Python, or
   separately launched server is needed.

The model download is several gigabytes and the first local warm-up can take a
few minutes. A locally built ad-hoc DMG is for development only — official builds are signed
and notarized, and are published on the
[releases page](https://github.com/LaghariLabs/adversaria-releases/releases/latest).

## How it works

```
React UI  ──invoke──▶  Tauri (Rust)  ──HTTP──▶  Python ML service (FastAPI :9876)
                        │                        ├─ faster-whisper  (transcription)
                        │                        └─ managed Rapid-MLX / Ollama
                        ├─ native capture → encrypted chunk spool
                        └─ SQLCipher meeting history + OS-keychain keys
```

1. Press **⌘⇧M** (macOS) / **Ctrl+Shift+M** (Windows) — or use the tray menu — to start recording; the Rust
   backend captures system audio via WASAPI loopback into a WAV file.
2. Press it again to stop. The WAV path is sent to the Python service, which
   transcribes it and summarizes the transcript with your chosen prompt template.
3. The meeting (title, transcript, summary) is saved to SQLite and shown in the
   UI. **The audio file is deleted immediately after the meeting is saved.**

## Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| Rust (stable) | Tauri backend | https://rustup.rs |
| Node.js 18+ | React frontend | https://nodejs.org |
| Python 3.11+ & [uv](https://docs.astral.sh/uv/) | ML service | `pip install uv` or the uv installer |
| Ollama | Local LLM summarization | https://ollama.com/download |
| NVIDIA GPU + CUDA/cuDNN | *Optional* — faster transcription | falls back to CPU automatically |

Pull a summarization model once (configured default on Windows is
`qwen3.6:35b-a3b`; any Ollama model works — set it in Settings):

```powershell
ollama pull qwen3.6:35b-a3b
```

Also pull the embedding model that powers semantic cross-meeting Ask search
(v0.3.30+; optional — without it, Ask silently falls back to keyword-only
search):

```powershell
ollama pull bge-m3
```

## Running (development)

You need two processes: the Python ML service and the Tauri app. The commands
below are for Windows.

> **macOS (Apple Silicon):** setup differs — MLX transcription + Rapid-MLX for the
> LLM, `uv sync --extra mlx`, and `HF_HUB_DISABLE_XET=1` (or the model download
> hangs).

**Terminal 1 — Python ML service:**

```powershell
cd python-service
uv sync
uv run uvicorn src.server:app --host 127.0.0.1 --port 9876 --log-level info
```

> The first start downloads the whisper `large-v3` model (~3 GB). On a machine
> without an NVIDIA GPU the service automatically falls back to CPU — consider
> `WHISPER_MODEL=medium` (see below), as `large-v3` is slow on CPU.

**Terminal 2 — the desktop app:**

```powershell
npm install
npm run tauri dev
```

Verify everything is connected: open **Settings** in the app — the service
status indicator should be green — or check manually:

```powershell
curl http://127.0.0.1:9876/health
# {"status":"ok","whisper_model":"large-v3","ollama_available":true}
```

### Try it out

1. Start a recording with **⌘⇧M** (macOS) / **Ctrl+Shift+M** (Windows), the tray menu, or the in-app button.
2. Play any audio with speech (a meeting, a YouTube video, a voice note).
3. Stop the recording. After transcription + summarization finishes, the meeting
   appears in the list with a transcript and structured summary.

## Configuration

### App config

Stored at `%APPDATA%\meeting-note-taker\config.json`, editable in the Settings UI:

| Key | Default | Notes |
|-----|---------|-------|
| `python_service_url` | `http://127.0.0.1:9876` | ML service base URL |
| `default_prompt_template` | `general` | Any template in `python-service/prompts/`: `general`, `one-on-one`, `client-meeting`, `brainstorm`, `youtube`, `interview` |
| `archive_after_days` | `30` | Days before an unpinned meeting folds into the sidebar Archive; `0` = never (search always spans the archive) |
| `sidebar_view` | `compact` | Sidebar meeting-list style: `compact` (one-line rows, details on hover) or `full` (classic cards with snippet and tags) |
| `recording_view` | `balanced` | Layout while recording: `balanced` (live transcript + notes, 50/50) or `transcript` (transcript-first, notes in a footer); applies at the next recording start |
| `ollama_model` | `qwen3.6:35b-a3b` (Win) / hardware-selected pinned profile (macOS) | LLM model name sent to the service |
| `summary_language` | `en` | `en`, `ar` (Arabic), or `auto` (match the spoken language) |
| `user_name` | (blank) | Your display name; replaces the `Me:` speaker label in new transcripts |
| `custom_vocabulary` | (blank) | Names/companies/jargon (comma- or newline-separated) to bias transcription spelling |
| `auto_detect_meetings` | `false` | Prompt to record when a call app uses your mic (mic-based, **not** calendar) |
| `claude_api_key` | `null` | Reserved for cloud fallback (not yet wired up) |

### Personalizing transcription & notes

- **Your Name** — set it in Settings to have your spoken lines labeled with your
  name instead of `Me:` in the transcript, so the notes attribute your action
  items to you by name.
- **Custom Vocabulary** — add names, companies, and jargon (comma- or
  newline-separated) so transcription spells them correctly. It's fed to Whisper
  as an `initial_prompt` on both the Windows/CUDA and Apple-Silicon backends.

### Enabling auto-detect

Auto-detect is **off by default**. To turn it on: **Settings → tick "Auto-detect
meetings" → click _Save Settings_** (ticking alone doesn't apply it — you must
Save). No restart needed. When a recognized call app (Zoom, Teams, Webex, Slack,
or a browser meeting like Google Meet) uses your mic for ~4–6 s, a floating
"Meeting detected — Record / Dismiss" card appears. It's **mic-based, not
calendar-based**, and never records on its own — you click _Record_. macOS 14.4+
only; WhatsApp/FaceTime aren't recognized yet.

### ML service environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `WHISPER_MODEL` | `large-v3` | e.g. `medium`, `small` — smaller is faster on CPU |
| `WHISPER_DEVICE` | `auto` | `auto` tries CUDA, falls back to CPU; or force `cuda`/`cpu` |
| `WHISPER_COMPUTE_TYPE` | `float16` | `int8` is used automatically on CPU |
| `HF_HUB_DISABLE_XET` | (unset) | Set to `1` on macOS if the MLX model download hangs at 0 bytes (broken `hf_xet`) |

Example (CPU-friendly):

```powershell
$env:WHISPER_MODEL = "medium"
uv run uvicorn src.server:app --host 127.0.0.1 --port 9876 --log-level info
```

### Prompt templates

Templates live in `python-service/prompts/*.md`. Each is a system prompt with a
`{{transcript}}` placeholder. Add your own by dropping a new `.md` file in that
directory — it appears in the API and template list automatically.

## Testing

```powershell
# Python service (42+ unit/integration tests, ML deps mocked — runs in <1s)
cd python-service
uv run pytest

# Rust backend
cd src-tauri
cargo check

# Frontend type check
npx tsc --noEmit
```

## Project structure

```
src/                  React frontend (components, hooks, typed IPC wrappers)
src-tauri/src/        Rust backend
  audio/mod.rs        bounded native capture → encrypted spool
  commands.rs         Tauri IPC commands (record, transcribe, history, config)
  http_client.rs      Typed client for the Python service
  storage.rs          SQLite meeting store
  tray.rs             System tray + global hotkeys (⌘⇧M / Ctrl+Shift+M record, ⌘⇧N quick note)
python-service/
  src/server.py       FastAPI app: /health /transcribe /summarize /templates
  src/transcriber.py  faster-whisper wrapper (CUDA with CPU fallback)
  src/summarizer.py   Ollama wrapper + prompt template loading
  prompts/            Editable summarization templates
docs/superpowers/     Design spec and phase plan
```

## Privacy

- In default local mode, meeting audio, transcript text, and prompts stay on the
  device. Explicit cloud transcription or cloud summary sends only the data
  disclosed in Settings and onboarding.
- Captures are encrypted while recording/pending and deleted after successful
  processing; failed processing remains encrypted and visibly retryable.
- Transcripts and summaries are stored locally in SQLite
  (`%APPDATA%\meeting-note-taker\meetings.db`).
- No analytics or automatic crash-report upload. Registration, model downloads,
  updates, calendar integrations, and optional cloud providers are documented in
  [Privacy and Network Boundaries](docs/PRIVACY_NETWORK_BOUNDARIES.md).

## Known limitations

- The live caption while recording is a best-effort rolling preview; the
  authoritative transcript is produced when you stop.
- Speaker labels are channel-based (`Me:` = your mic, `Them:` = system audio);
  individual remote speakers in a group call aren't separated by name yet
  (**speaker diarization** is specced in `docs/SPEC_DIARIZATION.md`, not built).
- The packaged app uses the system **ffmpeg** (Homebrew) via `PATH`; bundling a
  static ffmpeg for portability to other Macs is pending.
- Cloud fallback (Claude API) is planned but not wired up. Cross-meeting search
  is keyword/FTS5 today; **semantic embeddings** are a follow-up.
- **Calendar integration** (Google/Microsoft, read-only) is specced
  (`docs/SPEC_CALENDAR.md`) but not built — it needs your own OAuth client IDs.
