# Changelog

All notable changes to **Adversaria** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.63] - 2026-07-25

### Added
- **Contact details on people.** Person profiles now hold an email, phone,
  and LinkedIn alongside role, company, and notes — editable from the graph
  dossier, and carried into the Second Brain export's person notes. They're
  yours to type: nothing in a recording reveals an email address, so these
  are never guessed.
- **Profiles fill themselves in from the meeting.** The first time someone
  appears, their role and company are already there if they were mentioned
  out loud — meet the founder of a company and their title and company are
  waiting for you. Anything you've typed yourself always wins; only blank
  fields are ever filled.
- **Search the knowledge graph.** A search box dims everything except
  matching people, meetings, and tags, and zooms to them on Enter.

## [0.3.62] - 2026-07-24

### Added
- **Recording pill docks into the physical notch as a real dynamic island.**
  It now starts collapsed to a slim menu-bar-height strip (dot + timer, plus
  small blue/red live waveforms) so it never covers app content behind the
  notch; hovering expands it to show the live caption, both waveforms, and
  the Stop button, then it collapses again shortly after the mouse leaves.
- **Speakers are color-coded everywhere.** You're always blue (`#3d97ff`),
  other speakers are red (`#ff5f57`) — in the notch waveforms (now driven by
  real per-channel mic/system loudness), the live caption feed, and the
  meeting transcript's speaker labels.

### Fixed
- **Live captions no longer duplicate when your laptop speakers bleed into
  the mic.** The same sentence picked up by both the system and mic audio
  streams (with minor wording drift, e.g. "gonna" vs. "going to") is now
  deduplicated in the live feed via cross-source similarity matching.

## [0.3.61] - 2026-07-24

### Fixed
- **Multi-channel input devices no longer break transcription.** If the macOS
  default input was a multi-channel virtual device (e.g. a 16-channel routing
  device), the mic track recorded every channel as 32-bit float — a 45-minute
  meeting produced 7.6 GB, exceeded the WAV format's 4 GiB limit, and every
  transcription retry failed with "Encrypted mic recording is too large for WAV
  processing". The mic is now downmixed to mono at capture (Whisper mixes to
  mono anyway), and already-recorded oversized tracks are downmixed to mono
  during processing instead of failing — stuck recordings transcribe on the
  next retry.

## [0.3.60] - 2026-07-24

### Added
- **Seamless first-run engine setup.** The two Whisper transcription models
  (large-v3 ~3.1 GB and the live-caption turbo model ~0.5 GB) are now pinned,
  checksum-verified downloads that start automatically the moment setup opens —
  overlapping the registration and disclosure steps — and the selected meeting
  model starts downloading on its own when the model step is reached. One
  combined progress bar ("Setting up your private engine — X / Y GB") covers
  everything across the model and sample steps; "Continue — downloads keep
  running" lets you walk through the wizard while they finish; only the sample
  run waits for the meeting model to verify. Download failures show a single
  Retry button. No step ever requires a manual download click.
- **"Unfolding the meeting model" progress panel.** The first model start
  (loading multi-GB weights into memory, 1–3 minutes) now shows an animated
  progress panel with a live elapsed timer instead of a silent disabled button.
- **Qwen 3.5 9B "balanced" model tier.** A middle option between the 27B and 4B
  profiles (~6 GB download, needs 16 GB RAM), recommended automatically on
  16–23 GB Macs. Display names now show the model generation (Qwen 3.6 27B,
  Qwen 3.5 9B, Qwen 3.5 4B).

### Fixed
- **Setup no longer says "the local setup service is not ready; retry in a
  moment" on fresh machines.** Two causes fixed: the Python service blocked its
  own startup on a hidden multi-minute model download (the live-caption model
  warm-up now runs in the background, so the service answers within seconds of
  launch), and the setup commands failed on the first connection attempt instead
  of waiting (they now wait up to two minutes for the service to boot).

## [0.3.59] - 2026-07-24

### Fixed
- **App crashed at launch on macOS 15 (Sequoia).** The macOS build linked
  `SCScreenshotConfiguration` — a macOS-26-only ScreenCaptureKit class — as a
  *strong* symbol, because `screencapturekit` was built with the `macos_26_0`
  feature. On any Mac older than macOS 26 the symbol is missing and dyld aborted
  the app before it started (`Symbol not found: _OBJC_CLASS_$_SCScreenshotConfiguration`).
  The feature is now capped at the app's deployment target (`macos_14_4`); we only
  use base system-audio capture, so no functionality is lost. (Supersedes the
  0.3.58 build, which had this latent crash.)

## [0.3.58] - 2026-07-24

### Added
- **Settings model picker for the on-device engine.** Settings › AI Engine now
  shows the pinned local meeting-model profiles (e.g. Qwen 4B, Qwen 27B) with the
  recommended one and the currently-active one marked, plus per-row Use / Download
  / Retry with live download progress. Switching restarts the on-device engine and
  takes effect without an app restart — you're no longer locked to the model you
  picked at setup. (New `set_local_model_profile` command; recommend, never force.)

### Changed
- **Simpler first-run model step.** Setup now leads with a single clear
  recommendation ("your Mac has N GB, so this model fits and runs fast") instead of
  two co-equal option cards; the alternative model is one click away behind
  "Change model".

### Fixed
- **Auto-update manifest channel mismatch.** Installed beta builds poll
  `latest-beta.json`, but `publish-release.sh` wrote `latest.json`, so the
  "Update available" prompt could never fire. The publish script now writes the
  channel-matched manifest (`latest-<channel>.json`), so pushing a release reaches
  installed copies.

## [0.3.57] - 2026-07-21

### Fixed
- **Fewer Keychain password prompts while recording.** The recording-encryption
  key was read from the OS keychain on every recording start, every transcription,
  and once per pending recording during recovery — each a potential prompt. It's
  now cached for the app's lifetime, so the keychain is accessed at most once per
  launch. (Recordings stay encrypted at rest; a canceled prompt is still retried.)

## [0.3.56] - 2026-07-21

### Fixed
- **Stop button clipped in the expressive island.** When the live caption wrapped
  to two lines, the waveform + Stop row was pushed below the island window and cut
  off. The island is now tall enough for a two-line caption, and the Stop row is
  pinned to the bottom of the frame.

## [0.3.55] - 2026-07-21

### Fixed
- **The expressive notch island now shows live captions.** The pill window wasn't
  permitted to listen for events (its capability granted only its own commands),
  so the live transcript reached the main window but never the island — it stayed
  on "Listening…". Granted the pill `core:event` listen permission.

## [0.3.54] - 2026-07-21

### Fixed
- **Crash during recording.** The recording pill was being converted to a macOS
  `NSPanel` (to float over fullscreen calls); Tauri's window operations on a
  converted panel (closing it when the pill hides, focusing it on drag) aborted
  the app. Reverted to a plain floating window — the pill (minimal and expressive)
  is stable again. Floating over a fullscreen call is deferred to a later,
  properly-prototyped attempt.

## [0.3.53] - 2026-07-21

### Fixed
- **App no longer hangs at launch after an update when recordings are pending.**
  Recovery of pending recordings touches the macOS Keychain, which can prompt for
  access after a freshly-signed build. That recovery ran synchronously during
  startup, so the prompt (often hidden) blocked the whole app from opening — no
  window, no local ML service. Recovery now runs in the background: the window
  opens and the service starts immediately, and any Keychain prompt appears over
  the running app.

## [0.3.52] - 2026-07-21

### Added
- **Expressive notch pill.** Choosing "Expressive" in Settings → Notch & alerts
  now shows a richer island HUD while recording — title, elapsed timer, the live
  caption, both audio channels, and a one-tap Stop — instead of the compact pill.

## [0.3.51] - 2026-07-21

### Added
- **Notch pill — Settings control.** A new "Notch & alerts" group in Settings
  lets you choose the recording pill style (Minimal / Expressive / Hidden) and
  how a detected meeting alerts you (Notch drop / Pill nudge / Off). Config
  fields `notch_pill_style` and `meeting_alert_style`. Expressive, Pill nudge
  and Off are placeholders for a later update; Hidden fully suppresses the pill.

### Changed
- **Recording pill restyle.** The floating recording indicator is now a compact
  black pill — pulsing red dot, elapsed timer, and a live waveform — sitting just
  below the menu bar so it stays clear of the MacBook notch. Replaces the earlier
  red-glass bubble. The inline Stop button is retained.

## [0.3.50] - 2026-07-18

### Fixed
- **Transcription no longer requires a system ffmpeg.** On a fresh Mac
  (no Homebrew), every transcription failed with "[Errno 2] No such file or
  directory: 'ffmpeg'" — the MLX backend now decodes audio in-process via the
  bundled PyAV libraries instead of shelling out.
- **The microphone permission prompt now appears on fresh installs.** The main
  app binary was hardened-runtime-signed without the audio-input entitlement,
  so new machines never got asked (Adversaria didn't even appear under
  Privacy & Security → Microphone) and the mic level stayed flat. Dev machines
  masked this with permission grants that predate hardened builds.

## [0.3.49] - 2026-07-18

### Fixed
- **The focused meeting now highlights in the sidebar on the To-dos board.**
  Clicking a meeting there scopes the board but previously gave no visual
  feedback — the sidebar highlight now tracks the focused meeting (and clears
  when you return to All).
- **To-dos tab counts now match what the list shows.** "Upcoming (9)" over a
  7-row list is gone: the All/Upcoming/Due Today/Overdue counts were computed
  over every raw item, ignoring completed items, "Not mine" dismissals, the
  search box, and the meeting focus — they now count exactly the items the
  queue displays.

## [0.3.48] - 2026-07-18

### Fixed
- **Custom-vocabulary echo can no longer reach the transcript.** A new
  text-level gate drops segments that are essentially the glossary read back
  (shuffled and repeated included) and trims leading glossary runs off real
  sentences — closing the gap where an echo over voiced audio slipped past the
  silence-based gate.
- **Duplicate sentences across channels.** The mic-bleed dedup now also
  matches by word containment, so the same utterance transcribed slightly
  differently on the two tracks no longer shows up twice; exact three-word
  duplicates are caught too.

## [0.3.47] - 2026-07-18

### Changed
- **The sidebar drives the To-dos board.** On the To-dos view, clicking a
  meeting in the sidebar focuses the board on that meeting's items instead of
  navigating away — one titled chip with an × clears the focus. The
  per-meeting chip row (one pill per meeting) is gone; every other view keeps
  click-to-open.

### Added
- **Synthetic demo meetings** in `marketing/demo-data/` — seven generated
  `.adversaria.json` bundles (relative-to-today dates, timed transcripts,
  recurring attendees) for demos, screenshots, and the launch video.

## [0.3.46] - 2026-07-18

### Changed
- **Weekly navigation, de-confused.** The week pager now shows the week you're
  actually viewing ("This week" → "Last week" → "Jun 29 – Jul 5 · 2 wks ago"),
  a "↩ Back to this week" pill appears only when you've left the present, and
  the newer-week arrow visibly dims once you're at the current week.
- **Insights is now labeled Beta and coaches only you.** Talk balance is a
  simple You vs Everyone-else split (other voices stay anonymous on-device),
  and the delivery cards — pace, filler words, longest monologue,
  interruptions — are about your own speaking. An in-tab note explains the
  numbers are approximate; headphones improve accuracy.

### Removed
- **Standalone notes hidden for launch.** The "New Standalone Note" button and
  the ⌘⇧N quick-capture hotkey are shelved until the notes experience earns
  its place. Existing notes stay viewable; per-meeting My Notes and
  Structure-with-AI are untouched.

## [0.3.45] - 2026-07-18

### Added
- **To-dos, rebuilt twice over.** A **Triage board** (Overdue / This week / Later
  lanes + a collapsible Done tray) and a **Focus queue** (one next-up hero card
  with Done / Snooze / date controls), switchable and remembered. Meeting-scope
  chips filter either view to one meeting. **Drag-and-drop edits the date**:
  drop on This week = due today, Later = clear the date, Overdue = flag late,
  Done tray = complete. Due dates editable inline everywhere.
- **Weekly Briefing.** The local LLM writes "your week in sixty seconds" from
  your actual meeting notes, above stat tiles, decisions made, and open loops
  carried forward. Fails open to stats when the model is unreachable.
- **Graph side dossier.** Click a meeting node for a notes preview (summary,
  action items, open-full-note); click a person for an **editable profile**
  (role, company, notes, aliases — aliases fold duplicate spellings into one
  person), their meetings together, and related open to-dos. Profiles live in a
  new local `people` table.
- **Person profiles sync to the Obsidian vault** as `person-*.md` notes with
  frontmatter and `[[wikilinks]]` to meeting notes (Second Brain setting).
- **To-do alarm digests.** While the app runs, an OS notification (at launch
  and at 9:00 AM) summarizes what's due today and overdue.
- **A thinking indicator with personality.** While the local model works, the
  chat and Ask tabs show the breathing Adversaria "A" beside rotating status
  lines ("Reading the transcript…", "Waking the local model…").

### Fixed
- In-app drag-and-drop now works (Tauri's file-drop interception was swallowing
  HTML5 drag events; disabled — nothing used OS file drops).
- Chat "Clear" and notes "Save Now" buttons no longer stretch across their rows.
- The chat thinking state no longer renders a second empty bubble.

## [0.3.44] - 2026-07-17

### Added
- **Search by tag with `#`.** Typing `#` in the sidebar search opens a tag
  picker (same keyboard-navigable dropdown as `@` for people); picking a tag
  applies the pill-row filter and shows a removable `# Tag` chip. Plain text
  search now also matches tag labels.

### Fixed
- Double focus ring on the sidebar search input (the accessibility outline
  stacked on the input's own focus glow).

## [0.3.43] - 2026-07-16

### Fixed
- **Silent recordings are now auto-discarded instead of stranding a phantom
  "Untranscribed recording" row.** When a recording contains no speech and has no
  typed notes, the meeting and its audio are deleted automatically. A recording
  with no speech but typed notes is kept as a notes-only meeting (the user's
  content is never destroyed). Imported audio files with no speech return an
  explicit error instead of a pending row that can never succeed.
- **Deleting a meeting now also removes its retained recording + recovery
  state** (audio files and `recording_assets` row), so "Untranscribed recording ·
  Queued" rows no longer accumulate after deletion.
- **One record toggle could start two capture sessions** (twin spools, duplicated
  live captions, a stranded "capturing" spool) — recording start is now atomic
  and the tray/hotkey listeners no longer double-register in dev.
- **Live captions no longer show repetition-loop hallucinations** ("pre pre pre …"
  on noise) — a token-level repeat gate drops these cosmetic-only artifacts.

## [0.3.42] - 2026-07-16

### Added
- **A dedicated recording view.** While recording, the app collapses into a slim
  companion built for a narrow docked window: a record bar (timer, live audio
  level, Stop & summarize), a live transcript that auto-scrolls to the newest
  line, and your notes — split 50/50. Prefer the transcript to own the window?
  Settings → "Recording view" → *Transcript-first* tucks notes into a one-tap
  footer. A "Browse" button lets you peek at your meetings while the recording
  keeps running; the setting applies at the next recording, no restart needed.

### Fixed
- **The global record hotkey finally works.** ⌘⇧M (macOS) / Ctrl+Shift+M
  toggles recording from anywhere, and ⌘⇧N opens a quick note. Both had been
  silently broken since they shipped — the shortcut was registered twice, so
  its handler never attached and presses went nowhere.
- **The live transcript scrolls with the conversation.** It now keeps the full
  history (not just the last 6 lines), sticks to the newest line, pauses when
  you scroll up, and offers "Jump to latest ↓".
- **Silent recordings no longer invent content.** A recording with no speech
  could echo your custom vocabulary back as its "transcript" (and the summary
  then presented it as real discussion). The voice-activity gate that protects
  your microphone now protects the system-audio track too.
- **No more phantom "Thank you / Thanks for watching" in live captions.** The
  live preview now drops what Whisper itself flags as non-speech, plus its
  well-known filler phrases. Your stored transcript is unaffected — a real
  spoken "thank you" is still kept.

## [0.3.41] - 2026-07-14

### Fixed
- **Your meeting stats no longer count silence as you talking.** When you were
  mostly listening, your near-silent microphone made Whisper hallucinate filler
  ("thanks for watching", repetition loops) that got labeled as *you* — wildly
  inflating your talk-time, interruptions, and word count in Insights, and
  polluting the transcript and summary. The microphone track is now
  voice-activity-gated (Silero VAD) before transcription, so silence never
  reaches the model. Real speech is unaffected; this applies to newly recorded
  meetings. (Tip: headphones also remove the separate "bleed" case — your
  speakers leaking the other participants' voices into your mic.)

## [0.3.40] - 2026-07-14

### Fixed
- **The live transcript is fast again.** Captions could lag 20–40 seconds
  because the live preview shared the accurate (but heavy) large-v3 model and
  only showed a line after a 2-second pause — or, if you spoke without a clear
  pause, after a 30-second cutoff. The live preview now uses a dedicated fast
  model (`whisper-large-v3-turbo-q4`, warmed at startup) and tighter timing (a
  line appears after ~0.9s of silence, or ~8s at most, and it checks for new
  speech every second), so captions show up in about 1–2 seconds. The final
  transcript still uses large-v3, so its accuracy — including Arabic — is
  unchanged.

### Fixed
- **The live transcript now shows your own words, not just the other side.**
  While recording, the live caption panel only ever transcribed system audio
  ("Them") — so a YouTube video captioned fine, but when you spoke into your
  mic nothing appeared. Your microphone is now fed through the same live
  pipeline as a separate voice-activity-detected source, so your speech streams
  into the Live Transcript panel in real time too. (The final transcript after
  Stop was already unaffected.)

### Fixed
- **You can no longer be credited as a watched video's presenter — guaranteed.**
  When mic bleed puts a video's own audio under your name in the transcript,
  YouTube-template summaries now relabel those lines to a neutral "Viewer mic
  (not the presenter)" before the AI ever sees them, so the misattribution is
  structurally impossible (prompt-level fixes alone failed live tests). The
  YouTube template's presenter rule was also hardened as a second layer.
  Regenerate any affected video's notes after updating.

## [0.3.37] - 2026-07-10

### Fixed
- **No more dead space after the date in the sidebar.** The hover-only ⋯
  actions button was invisibly reserving room on every row; it now overlays
  and swaps with the date on hover instead.
- **The Insights tab is centered** instead of hugging the left edge of the
  pane.

## [0.3.36] - 2026-07-10

### Added
- **Meeting Insights.** A new Insights tab on every meeting computes speaking
  statistics fully on-device, with zero AI calls: talk-time share per person,
  speaking pace (words per minute, with the 130–175 coaching target), filler
  words (rate against the 4% target), interruptions, and longest monologue.
  Your own row is highlighted. Older meetings recorded before this version
  show word-based shares (precise timing starts with new recordings).
- **Timestamped transcripts.** New recordings keep each turn's start/end time
  from the transcription engine; the Transcript tab now prefixes every turn
  with its [MM:SS] position in the recording.
- **"Detailed" notes template.** A new maximum-detail template: Session
  Summary, Critical Deadlines, Key Decisions, Discussion Notes, Immediate
  Action Items, Next Steps, Open Questions & Risks, and Numbers & Facts
  (every figure quoted with context).

### Fixed
- **YouTube summaries no longer credit you as the presenter.** Your own
  spoken comments while watching are now explicitly treated as viewer
  commentary, not the video's presenter.
- **Prompt-injection guard in all templates.** Things said in a meeting like
  "ignore that" or "don't write this down" are treated as conversation
  content, never as instructions to the note-taker.

## [0.3.35] - 2026-07-10

### Fixed
- **The sidebar view setting applies without a restart.** Changing
  "Sidebar meeting list" (and the archive window) now takes effect as soon
  as you save and return to your meetings — previously it silently waited
  for the next app launch, and the help text didn't say so.

## [0.3.34] - 2026-07-10

### Added
- **Choose your sidebar style.** Settings → "Sidebar meeting list" picks
  between Compact rows (default) and the classic Full cards with snippet and
  tags. Both styles share the same date bins, Archive, highlight, and
  @person search.

### Fixed
- **@person chips render inside the search bar** — they previously sat
  outside the input's border with the search icon overlapping the first
  chip. The bar is now a proper container: icon, chips, and text share one
  box, chips wrap onto extra lines, and the focus ring wraps the whole bar.

## [0.3.33] - 2026-07-10

### Added
- **Archive meetings by hand.** Every meeting row's ⋯ menu now has
  Archive / Unarchive; archiving also unpins. Manual archive works even when
  the age-based window is set to Never, and search/Ask always span the
  archive.
- **Compact meeting rows.** The sidebar's multi-line cards are now one-line
  rows — category-colored dot, title, and time — with the details (date,
  duration, snippet, editable tags) in a hover peek.
- **Real date bins.** The resting list is grouped Pinned / Today / Yesterday /
  This week / Earlier this month / month bins ("June 2026") / Archive,
  replacing the single "Last 30 days" section. Row times adapt per bin
  (clock time today/yesterday, weekday this week, date otherwise).

### Fixed
- **The @person dropdown is scrollable.** It previously hard-capped at 8
  people with no hint more existed; now all matches render in a scrollable
  list and keyboard navigation follows the highlight.

## [0.3.32] - 2026-07-10

### Added
- **Category → template auto-routing.** When a meeting is summarized with the
  default template, the service now detects what the recording actually is —
  transcription-time playback hint, then a cheap one-word local-LLM
  classification, then the speaker-ratio heuristic — and switches to the
  matching prompt template automatically: watched videos → YouTube, idea dumps
  → Brainstorm, 1:1s → One-on-one, interviews → the new Interview template.
  A manually chosen template is never overridden, and any routing failure
  falls back to the previous behavior.
- **Bidirectional Interview template.** New `interview.md` prompt detects
  whether you are the interviewer or the candidate and structures the notes
  from your side: overview, questions asked, answer highlights, red & green
  flags, and follow-ups (which flow into To-dos).
- **Sidebar auto-archive.** With no filters active, the meeting list now shows
  Pinned + the recent window (Settings → "Archive meetings after": Never / 14 /
  30 / 60 / 90 days, default 30); older meetings fold under a collapsed
  "Archive" row. Search, day, and tag filters always span archived meetings.
- **Find meetings by person.** Type `@` in the sidebar search to pick from
  everyone you've met (with meeting counts); each pick becomes a removable
  chip that filters the list to that person's meetings and composes with
  text, day, and tag filters. Attendee names also count as plain search-text
  matches now.

### Fixed
- **The open meeting is highlighted in the sidebar list.** The selected style
  existed but was never applied, so it was easy to lose track of which meeting
  you were reading.
- **"Clear filter" now clears everything.** It previously reset only the date;
  it now clears the search text, selected day, and tag pill together and
  appears whenever any of them is active. The search box also gained its own
  ✕ button.

## [0.3.31] - 2026-07-09

### Fixed
- **Ask reference notes now cite only the meetings the answer actually
  used.** Previously every retrieved candidate (up to 5) was listed as a
  "📄 Reference Note", so a single-meeting answer showed four irrelevant
  references. The model now cites its sources per numbered context section;
  the app filters the list accordingly (and shows none when the answer used
  none). If the citation is missing or malformed, the full candidate list is
  shown as before — behavior never degrades.

## [0.3.30] - 2026-07-09

### Added
- **Hybrid Ask retrieval (semantic + keyword + graph).** Cross-meeting Ask now
  fuses FTS5 keyword search with on-device semantic chunk vectors (Ollama
  **bge-m3**, 1024-dim, multilingual/Arabic) and attendee/tag graph anchoring
  via reciprocal-rank fusion. Detail questions are answered from the matched
  transcript passages instead of each transcript's first 4,000 characters.
  Meetings are chunked and indexed automatically in the background
  (self-healing — at startup, after new/changed meetings, and on each Ask).
  Requires `ollama pull bge-m3`; without it Ask silently keeps the previous
  keyword-only behavior. 100% local, nothing leaves the machine.
- New Python service endpoint `POST /embed` (batch text embeddings, local).

### Fixed
- **Silent empty chat answers.** If the local LLM server aborts a request
  (e.g. under concurrent load), "Chat with meeting" no longer shows nothing:
  the service now retries once automatically and, failing that, shows a clear
  "returned an empty answer — please try again" error.
- **"How did I do?"-style questions.** Chat and Ask may now give an
  assessment grounded solely in the transcript (citing the moments that
  support it, presented as a reading, not fact) instead of refusing
  evaluative questions.

## [0.3.29] - 2026-07-08

### Changed
- **Slide-export intro now reads Adversaria → "A Laghari Labs Product" →
  "Nothing leaves your machine".** Added the product line under the wordmark
  and refreshed the tagline wording.

## [0.3.28] - 2026-07-06

### Added
- **Date format setting.** Settings → date format picker (with a live preview):
  System default, Day/Month/Year (British, 06/07/2026), Month/Day/Year
  (American), Day Month Year (6 July 2026), or ISO (2026-07-06). Applies
  everywhere dates are shown, including the slide export.

### Changed
- **Wider To-dos, Ask, and Weekly Recap layouts.** These three tabs were capped
  narrow (760–900px) and centered, leaving large blank margins on wide displays;
  they now use up to 1200–1400px with comfortable side padding.

## [0.3.27] - 2026-07-06

### Fixed
- **"Structure with AI" no longer errors** with "Prompt template not found:
  note". A note's stored template is the pseudo-value "note", which was passed
  straight to the summarizer; it now falls back to the brainstorm template.
- **Slide-export intro matches the app's own splash.** The previous cursive
  version looked stretched; the wordmark is now "Adversaria" in Instrument Serif
  italic in solid azure (#24A0ED) — the exact font and colour of the in-app
  splash — with a gentle fade-in. The font is embedded so it renders identically
  in the exported HTML and PDF.

## [0.3.26] - 2026-07-06

### Changed
- **Slide-export intro reworked.** The "ADVERSARIA" splash (white "ADVER" + blue
  "SARIA") is now the wordmark in a single flowing cursive script that writes
  itself in left-to-right like handwriting (A first), filled with one blue that
  runs dark → light to match the app's azure. Screen-only, as before.

## [0.3.25] - 2026-07-06

### Added
- **Notes are now first-class.** A standalone note gains a **"✨ Structure with
  AI"** button that runs its rough text through the summarizer — producing
  organized notes and extracting action items that flow into the To-dos tab,
  the knowledge graph, and Ask, exactly like a recorded meeting. The original
  text is preserved (Transcript tab), so you can re-structure any time.
- **Note starter templates** — the New Note dialog offers Blank / Meeting prep /
  Daily standup / Idea dump scaffolds so you don't start from a blank page.
- **Quick-capture hotkey** — press **Cmd/Ctrl+Shift+N** anywhere to bring the
  app forward and open the New Note dialog instantly.

## [0.3.24] - 2026-07-06

### Changed
- **The category tag is now decided by the LLM from meeting content**, not a
  crude speaker-ratio heuristic. During summarization the model classifies each
  recording as meeting / 1:1 / interview / standup / brainstorm / YouTube /
  other and it becomes the tag — so a two-person catch-up is a "1:1", a job
  interview is an "Interview", etc. The mic-bleed "YouTube" signal (which the
  model can't see) still overrides, and the old heuristic remains a fallback.

### Fixed
- **Ask no longer refuses real topic searches.** Typing a bare topic like
  "trading bot" used to be mistaken for a coding request and refused even when
  you had a meeting about it. The router now treats a bare topic/name as a
  search, and as a safety net any refused query that full-text-matches a real
  meeting is answered instead (prompt-injection attempts still refuse).
- **Ask answers now finish in the background.** If you ask a question and switch
  tabs while it's thinking, the answer is generated and saved anyway; returning
  to the Ask tab reconnects and shows it, instead of appearing to stop. Errors
  now resolve into the conversation too, so a question never hangs unanswered.

## [0.3.23] - 2026-07-06

### Added
- **Second Brain export.** Settings → Data gains a "Second Brain" section:
  point it at a local vault folder (e.g. an Obsidian wiki) and Adversaria
  mirrors every meeting there as a markdown note with OKF-style YAML
  frontmatter and [[wikilinks]] for attendees and tags, plus an index.md and a
  machine-readable graph.json. Auto-exports after every meeting change when
  enabled (off by default), with a manual "Export now" button. Summaries only —
  raw transcripts never leave the app — and locked meetings are never exported.
  Orphan cleanup only ever touches files Adversaria wrote (marked with an
  adversaria:// resource id).

## [0.3.22] - 2026-07-06

### Fixed
- **Watched videos classify correctly regardless of mic-bleed stripping.**
  Classification now happens at transcription time, before bleed lines are
  removed (when the playback signal is strongest), and the verdict travels with
  the transcription as a hint that overrides transcript-based re-classification
  — the tag can no longer regress as the transcript gets cleaner. A "youtube"
  verdict also skips diarization directly.
- **Small-bug sweep (2026-07-03 audit close-out):** a recording that captured
  no system audio now errors clearly at stop (revoked Screen Recording
  permission) instead of creating a permanently un-retryable meeting; a
  backslash in "Your Name" no longer crashes transcription; concurrent
  config.json writes can no longer wipe a just-connected calendar account;
  audio-import temp files no longer leak (and no longer break on Windows); an
  Ask question is kept in the thread even when the LLM call fails; imported
  meetings with non-UTC timestamps sort correctly; leaving the chat tab
  mid-answer no longer warns; "None mentioned" placeholder bullets no longer
  shift action-item checkboxes onto the wrong rows.

## [0.3.21] - 2026-07-06

### Changed
- **Live captions are now VAD-gated (utterance-at-a-time).** The old preview
  re-transcribed a rolling 30 s window every 12 s — redundant compute, captions
  cut mid-word, and up to 12 s of lag. Now the recorder streams only new audio
  every 2 s; Silero VAD (bundled with faster-whisper — no new dependencies)
  segments it into complete utterances, each transcribed exactly once when the
  speaker pauses (or at 30 s for long monologues). Captions append line-by-line
  (~2–4 s after each sentence ends), never cut mid-word, silence costs zero
  inference, and utterances that finish while a full transcription holds the
  GPU are captioned on the next pass instead of dropped. Approach adapted from
  Meetily (MIT), with their field-tuned VAD constants.

## [0.3.20] - 2026-07-06

### Added
- **"From Your Notes" summary section.** Notes jotted live during a recording
  now always surface as a dedicated final section of the summary — one bullet
  per note, expanded with transcript detail where it exists — instead of
  influencing the summary invisibly.
- **Per-meeting source link.** A link row under the attendees: paste the URL of
  a watched video (or any source) once, open it any time in the default
  browser. Stored in the DB and carried through export/import bundles.

### Fixed
- **The ML service no longer freezes during transcription/summarization.** The
  heavy endpoints run in a threadpool now; live captions, chat, and the health
  indicator stay responsive through minutes-long jobs. Whisper inference is
  serialized (no shared-state races), and live-caption chunks skip rather than
  queue while a full transcription runs.
- **Live-caption loop leak on rapid stop→start** — stale caption loops now exit
  at their next wake instead of double-running against the same temp file.
- **Wrong meeting shown when clicking meetings quickly** — out-of-order fetch
  results are dropped (latest wins).
- **Silence auto-stop timer no longer resets on tab switches** during a
  recording.
- **Header status lines use one typography** — "Local ML Service" now matches
  the sovereignty pill's weight.

## [0.3.19] - 2026-07-04

### Added
- **"YouTube Video" summary template** — What It's About / Key Points / Tools &
  References / Takeaways. Built for watched videos: keeps attendees empty so a
  video's presenters never enter the knowledge graph.

### Fixed
- **Meetings can be browsed while recording.** The recording pane no longer
  monopolizes the content area — selecting a meeting opens it with a
  "● Recording in progress — back to live notes" strip; the recording continues
  in the background.
- **Locked meetings re-lock automatically.** An unlock now lasts only while the
  meeting is open; navigating away re-arms the lock (was: unlocked until app
  restart).
- **"Regenerate Notes" no longer leaves dead action-item checkboxes** — the
  checkbox list reloads after resummarize (toggles used to silently no-op).
- **"Database is locked" races eliminated** — every SQLite connection now waits
  up to 5 s (busy_timeout) instead of failing instantly when a background
  transcription write races a UI action.

## [0.3.18] - 2026-07-04

### Fixed
- **Watched videos no longer classify as "Meeting" (partial mic bleed).** The
  bleed detector used Jaccard word-overlap, which cannot reach its threshold
  when the mic catches only a fraction of the playback (a real recording scored
  0.33 against the 0.5 threshold). Added a containment test — the share of mic
  words also present on the system channel (≥ 0.8, ≥ 8 words) — calibrated
  against the full 90-meeting corpus: every known video scores ≥ 0.83, the
  highest real meeting 0.75.
- **Speaker bleed is stripped from the transcript at the source.** Mic segments
  that are near-verbatim copies of temporally-close system segments
  (SequenceMatcher ≥ 0.85, ±10 s, ≥ 4 words) are dropped before merging — a
  watched video's words can no longer be attributed to the user, duplicate
  lines disappear, and speakerphone echo in real calls is cleaned up too.

## [0.3.17] - 2026-07-04

### Fixed
- **Diarization no longer over-counts speakers.** Four root-cause fixes for the
  "14 speakers in a 2-person call" failure: (1) turns overlapping no transcribed
  speech are dropped before speaker counting (music/SFX can't mint speakers);
  (2) clusters whose voice embeddings match (cosine ≥ 0.60, campplus) are
  re-merged — one voice split by the clusterer becomes one speaker again;
  (3) playback-like recordings (watched videos/demos, detected via the existing
  mic-bleed heuristic) skip diarization entirely instead of splitting TTS/media
  voices into "Speaker N"; (4) tighter caps — max 5 speakers, 12 s minimum
  speech per speaker, 0.5 s minimum turn.

### Added
- **"Merge speakers into 'Them'"** button on the Transcript tab (shown only for
  meetings with diarized "Speaker N" labels; two-click confirm). Retroactively
  collapses over-counted labels back to a flat "Them", joins adjacent lines, and
  removes phantom "Speaker N" attendees — for saved meetings whose audio is
  already deleted and can't be re-diarized.

## [0.3.15] - 2026-07-03

### Fixed
- **Graph flutter root-caused and fixed.** The cytoscape-d3-force wrapper
  restarts its simulation with `alphaTarget = alpha/3` on every node grab AND
  release and never lowers it back — post-drag the graph buzzed at constant
  energy for ~2 s, then froze mid-motion. `GraphView.tsx` now zeroes
  `alphaTarget` on release so motion decays smoothly to rest. The Graph tab also
  remembers node positions across visits (module-scope position cache + `preset`
  layout, gentle `alpha: 0.12` wake-up) instead of re-scattering and re-running
  the settle animation every time it opens; legend toggles no longer re-scatter
  either.

### Docs
- Full-codebase bug audit (2026-07-03): ranked open findings recorded at the top
  of `docs/TODO.md`; diarization over-count diagnosis + fix plan in
  `docs/HANDOFF.md`.

## [0.3.8] - 2026-06-25

### Added
- **On-device Whisper model picker (download & auto-load).** Settings →
  Transcription (On-device engine) now lists curated MLX Whisper models with
  per-model **download status** and a **"Download now"** button (Downloading… →
  Ready ✓): `large-v3` (recommended — 99 langs incl. Arabic, ~3 GB),
  `large-v3-turbo` (faster, ~1.6 GB), `large-v3-turbo-q4` (smallest/fastest 4-bit,
  ~0.5 GB). The chosen model is threaded through `/transcribe`; MLX loads it
  per-call and HF auto-downloads on first use, so switching needs no restart.
  New config `whisper_model`; Python `/whisper_models` + `/whisper_download`
  endpoints; Rust `list_whisper_models` / `download_whisper_model` commands;
  HF-cache detection for download status. 2 tests.

### Fixed
- **Empty Prompts tab on a sidecar-boot race** — `loadTemplates` now retries on
  empty/failure instead of giving up after one mount-time fetch.

## [0.3.7] - 2026-06-25

### Added
- **Bring-your-own-key cloud transcription (for testers without local-Whisper
  hardware).** Settings → Transcription now has an **Engine** picker: *On-device
  Whisper* (default, sovereign, diarized) or *Cloud — Groq (BYO key)*. In cloud
  mode the Python service uploads each channel to an OpenAI-compatible
  `/audio/transcriptions` endpoint (preset `https://api.groq.com/openai/v1`,
  model `whisper-large-v3`) and merges them into a Me/Them transcript by
  timestamp. The UI clearly warns that cloud mode is **not sovereign** (audio
  leaves the device) and that **speaker diarization is unavailable** there.
  New config: `transcription_base_url` / `transcription_api_key` /
  `transcription_model`; threaded Rust → Python; 2 new tests.
  _(A downloadable local-model picker — faster/smaller Whisper variants and
  NVIDIA Parakeet — is planned next; Parakeet needs a new on-device backend.)_

## [0.3.6] - 2026-06-24

### Changed
- **Settings, rebuilt for clarity.** A Groq-first **"AI Engine"** tab (Groq
  preset added, recommended default; the Python-service URL + health moved into
  an "Advanced" disclosure), a dedicated **"Prompts"** tab with a large editor,
  and a consistent control system — fixed `.btn-primary` (38px, no wrap/squeeze),
  new `.btn-ghost`/`.btn-danger`, and semantic `.settings-note`/`.settings-subcard`
  replacing ad-hoc Tailwind callouts. All existing providers retained.
- **Default summarization prompt hardened against hallucination.** `general`
  template now defines what counts as a decision/action item, forbids inferring
  cause/purpose, forbids reversing negations, forbids substituting "cleaner"
  names for garbled terms, and adds a self-check. On the local 35B this fixed an
  inverted compliance fact, fabricated decisions, merged attendees, and invented
  tool names — matching cloud-model faithfulness while staying on-device.
- **⋯ meeting menu icons** (Pin / Lock / Delete) are now SVGs instead of emoji.

### Fixed
- **False "Local ML Service: Offline" + broken transcription/summary after a
  Settings save.** The app spawns its bundled sidecar on a dynamic port and
  points the client there, but `update_config` reset the client to the configured
  URL (`:9876`) on every save, clobbering the live port. `update_config` now
  only honors the configured URL when no managed sidecar is running.

## [0.3.5] - 2026-06-24

### Changed
- **Calendar is now a meeting-count heatmap.** Sidebar month-calendar day cells
  shade by how many meetings fell on that day (four blue-opacity tiers, busiest
  day darkest, zero-meeting days the faint base), replacing the old binary
  "has meetings" shade. (`DateHeatmap.tsx` `level()` → `level-1..4`;
  `prototype.css` `.heatmap-day-monthly.level-1..4`.)
- **Tag pills are date-scoped.** Selecting a day in the calendar now narrows the
  tag/category filter pills to only the categories present in that day's meetings,
  so you can filter within a single day. (`MeetingsList.tsx`.)

## [0.3.4] - 2026-06-24

### Changed
- **Live, audio-reactive recording waveform.** The bars now track the actual
  recording loudness (louder of system + mic) and **flatline on silence**, instead
  of a canned looping animation. New Rust `get_audio_level` (RMS of the last
  ~120 ms) polled ~14 Hz by the recording view.

### Fixed
- Recording header timer was a hardcoded `00:00:00`; it now shows real elapsed time.

## [0.3.3] - 2026-06-24

### Fixed
- **Floating bubble drag now actually works.** v0.3.2's drag was a no-op: macOS
  (and Tauri) won't drag a window that isn't focused, and the bubble is created
  unfocused. The new Rust `bubble_start_drag` command focuses the bubble first
  (only on your drag, so it still doesn't steal focus when it appears) and then
  starts the native window drag — atomically, to avoid the focus→drag IPC gap.

### Added
- **App version shown in Settings** (sidebar), so you can always tell which build
  is running.

### Changed
- `build-dmg.sh` now auto-installs the build to /Applications and relaunches
  (set `ADVERSARIA_INSTALL=0` to skip), so you're never left running a stale build.

## [0.3.2] - 2026-06-24

### Fixed
- **The floating recording bubble can now be dragged.** It was frameless with no
  drag region, so it was stuck in place. It now moves with a native OS window drag
  (mousedown anywhere on the pill); a plain click still returns to the app and the
  Stop button still stops. Required granting the bubble window
  `core:window:allow-start-dragging`.

## [0.3.1] - 2026-06-24

### Fixed
- **Diarization over-segmented short/real-world calls** — a single remote speaker
  could be split into "Speaker 1/2/3". Raised the clustering threshold 0.5 → 0.7
  (validated as the most conservative value that still keeps genuinely distinct
  speakers separate), so same-speaker noise merges while real speakers stay apart.
  (Applies to new recordings; transcripts already saved keep their labels.)

## [0.3.0] - 2026-06-24

### Added
- **Speaker diarization.** Remote participants are now split into "Speaker 1",
  "Speaker 2", … instead of a flat "Them" (your own mic stays "Me"). Runs fully
  on-device with sherpa-onnx (no HuggingFace gating); models (~34 MB) download once
  to a local cache. Toggle in **Settings → Transcription** (default on); best-effort,
  so it falls back to "Them" if diarization can't run. See ADR-012.

## [0.2.1] - 2026-06-24

### Added
- **Streaming chat.** "Chat with Meeting" now streams the answer token-by-token as
  it's generated, instead of waiting for the whole reply. New `/chat_stream` SSE
  endpoint (Python) → `chat_with_meeting_stream` Tauri command using a `Channel`
  → incremental render in the UI. Works for both local (Ollama) and cloud
  (OpenAI-compatible) backends.

## [0.2.0] - 2026-06-24

### Added
- **Encryption at rest (SQLCipher).** The meetings database is now AES-256 encrypted
  with SQLCipher. The key is a random 256-bit value stored in the OS keychain
  (transparent unlock — no passphrase). Existing plaintext databases are **migrated in
  place on first launch**, keeping a verified `meetings.db.pre-encrypt-backup` (delete
  it once your notes look right). FTS5 search is preserved. The bundled MCP server
  reads the encrypted DB via the same keychain key (macOS may prompt once to allow
  keychain access). See ADR-011 in docs/DECISIONS.md.

## [0.1.3] - 2026-06-23

### Added
- **"Test connection" button for cloud LLM providers (BYOK).** Settings now has a
  Test connection button (shown for non-local providers) that probes the provider's
  OpenAI-compatible `GET {base_url}/models` with your API key and shows a green
  success (with model count) or a specific error (auth / not-found / unreachable),
  so configuring a key/URL isn't "paste and hope".

### Fixed
- **Weekly Recaps:** removed the leftover lorem-ipsum "sample" placeholder card.
  Empty weeks now show only the honest "No meetings this week" state.
- **Friendlier "AI model unreachable" message.** Ask Across Meetings and Chat with
  Meeting previously surfaced the raw connection error (e.g. "Connection refused").
  They now show a provider-agnostic, actionable message (new `lib/errors.ts`).

## [0.1.2] - 2026-06-23

### Fixed
- **Ask Across Meetings: the question now appears above its answer.** Previously
  only the AI answer was shown and the question stayed stuck in the input box. The
  submitted question now renders as a chat bubble above the answer, and the input
  is cleared as soon as the question is sent.
- **Meeting note toolbar no longer breaks at narrow widths.** The tab labels
  ("Chat with Meeting", "Personal Notes") wrapped onto two or three lines and the
  template/language dropdowns + "Regenerate Notes" button got squeezed when the
  window was made smaller. Tab labels now stay on one line, and the action controls
  reflow onto their own line instead of being crushed.

## [0.1.1] - 2026-06-23

### Fixed
- **Weekly Recaps layout no longer chaotic.** Meeting-name attribution in the
  recap reused the `.btn-month-nav` button style (bold, 15px, centered, block-level),
  which dropped each title onto its own centered line. It now renders as a small,
  muted, inline link (`.weekly-meeting-link`). Empty sections that the LLM fills with
  "None mentioned" placeholders are no longer shown as Decisions/Key Topics bullets.
- **Action items dropped from non-English / non-standard headings.** The action-item
  extractor only recognised the literal English headings `Action Items` / `Next Steps` /
  `Deliverables`, so items under an Arabic heading (`عناصر العمل`) — or under LLM heading
  drift like "To-Build", "Tasks", or "To-Do List" — were silently discarded and never
  reached the To-Do view. The heading matcher (Rust `storage.rs` + its TypeScript mirror
  `lib/summary.ts`) now also matches `to-do`/`to-build`/`task` and the common Arabic
  headings. Previously-dropped items are recovered automatically on next launch via the
  startup backfill (meetings with zero stored action items are re-extracted).

### Changed
- Broadened the actionable-heading regex to be tolerant of model heading drift and
  Arabic summaries; kept the Rust and TypeScript copies in sync.

## [0.1.0] - baseline

Initial development baseline: record → on-device transcription (faster-whisper /
MLX) → local-LLM summary (Ollama / Rapid-MLX) → SQLite → UI, with dual capture,
speaker-labelled transcripts, multilingual/RTL summaries, meeting auto-detect, the
floating recording bubble, to-dos, weekly recaps, cross-meeting chat, per-meeting
privacy lock, configurable LLM provider, and calendar integration. (Versioning and
this changelog start at 0.1.1; 0.1.0 covers all prior development.)

[Unreleased]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.3.4...HEAD
[0.3.4]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/mhlaghari/meeting-note-taker/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/mhlaghari/meeting-note-taker/releases/tag/v0.1.1
