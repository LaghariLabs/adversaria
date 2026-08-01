//! Shared types — mirrors the Python + TypeScript contracts.
use serde::{Deserialize, Serialize};

// ---- API shapes ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeResponse {
    pub text: String,
    pub language: String,
    pub duration_seconds: f64,
    /// Category verdict computed at transcription time, before mic bleed was
    /// stripped from the transcript (e.g. "youtube"). Passed to /summarize so
    /// classification doesn't have to re-derive it from the cleaned text.
    #[serde(default)]
    pub category_hint: Option<String>,
    /// Structured speaker turns with timing (Python v0.3.36+). Empty on older
    /// service versions; callers fall back to parsing the flat text.
    #[serde(default)]
    pub turns: Vec<TranscriptTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummarizeResponse {
    pub summary: String,
    pub template_used: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub category: String,
    /// Role/company the model heard stated for each attendee, used to prefill
    /// blank person-profile fields. Empty for older service builds.
    #[serde(default)]
    pub attendee_details: Vec<AttendeeDetail>,
}

/// What the summarizer could tell about one participant from the transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttendeeDetail {
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub company: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateInfo {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub whisper_model: String,
    pub ollama_available: bool,
    /// Transcription readiness reported by the service:
    /// `loading` | `ready` | `missing` | `error`. Absent on older services —
    /// and re-serialized as ABSENT (not null), matching the webview's
    /// `transcriber_state?:` contract; a null here read as "not ready" and
    /// kept the setup chip fast-polling forever against a pre-V3 service.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcriber_state: Option<String>,
    /// Human detail for a non-`ready` `transcriber_state` (e.g. which model is
    /// missing). `None` when the transcriber is ready or the service is older.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcriber_detail: Option<String>,
}

// ---- Meeting ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub label: String,
    /// Palette key: gray|red|orange|yellow|green|blue|purple.
    pub color: String,
}

/// A single speaker turn in a structured transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptTurn {
    pub speaker: String,
    pub text: String,
    /// Segment timing in seconds from recording start (None on rows stored
    /// before v0.3.36 or parsed from flat text).
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
}

/// One embedded chunk of a meeting (a transcript passage or summary section),
/// used by the hybrid Ask retriever.
#[derive(Debug, Clone)]
pub struct ChunkRow {
    pub meeting_id: i64,
    pub kind: String,
    pub text: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meeting {
    pub id: i64,
    pub title: String,
    pub recorded_at: String,
    pub duration_seconds: f64,
    pub transcript: String,
    pub summary: String,
    pub template_used: String,
    pub audio_file_path: Option<String>,
    /// Detected participant display strings (e.g. "Me", "Sarah — Designer").
    #[serde(default)]
    pub attendees: Vec<String>,
    /// Rough notes the user typed live during the meeting (kept verbatim).
    #[serde(default)]
    pub user_notes: String,
    /// Optional source URL (e.g. the YouTube link of a watched video).
    #[serde(default)]
    pub link: String,
    /// User-assigned colored tags (label + palette color).
    #[serde(default)]
    pub tags: Vec<Tag>,
    /// Whether the user pinned this meeting to the top of the list.
    #[serde(default)]
    pub pinned: bool,
    /// Whether the meeting is privacy-locked (content hidden until PIN entry).
    #[serde(default)]
    pub locked: bool,
    /// Whether the user manually archived this meeting (sidebar Archive bin).
    #[serde(default)]
    pub archived: bool,
    /// Structured speaker turns parsed from the flat transcript.
    #[serde(default)]
    pub transcript_turns: Vec<TranscriptTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: i64,
    pub meeting_id: i64,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

/// One prior turn of the cross-meeting "Ask" conversation, sent from the
/// frontend so a follow-up ("which company is he in") can be resolved against
/// context ("…is Wajee in") before retrieval. The caller sends only the last
/// few turns.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatTurn {
    pub role: String, // "user" | "assistant"
    pub content: String,
}

/// A first-class action item extracted from summary markdown (`- [ ]`/`- [x]`).
/// The single source of truth for done-state; no longer stored in localStorage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionItem {
    pub id: i64,
    pub meeting_id: i64,
    pub ord: i64,
    pub text: String,
    pub assignee: String,
    pub due: String, // 'YYYY-MM-DD' or ''
    pub done: bool,
    /// "todo" | "in_progress" | "ai_done" | "done". `done` stays the boolean
    /// everything already understands; this is the richer state an agent walks
    /// through. "ai_done" means an agent reported it finished and is waiting
    /// for the user to accept — deliberately NOT done.
    #[serde(default = "default_item_status")]
    pub status: String,
    /// "" | "you" | "agent:<name>" — who completed it.
    #[serde(default)]
    pub completed_by: String,
    #[serde(default)]
    pub completed_at: String,
    /// What the agent actually did: a one-line summary, ideally with a path or
    /// link. Without this, "done by AI" is a claim nobody can check.
    #[serde(default)]
    pub evidence: String,
}

fn default_item_status() -> String {
    "todo".to_string()
}

// ---- People profiles ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonProfile {
    pub id: i64,
    pub name: String,
    pub role: String,
    pub company: String,
    pub notes: String,
    pub aliases: String,
    /// Contact details. Never inferred from audio — the user types these.
    pub email: String,
    pub phone: String,
    pub linkedin: String,
}

// ---- Knowledge graph ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub key: String,             // unique id: "meeting-42", "person-sarah", "tag-client"
    pub label: String,           // display text
    pub node_type: String,       // "meeting" | "person" | "tag" | "owner"
    pub meeting_id: Option<i64>, // set only for meeting nodes (click -> navigate)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String, // node key
    pub target: String, // node key
    pub label: String,  // "attended" | "tagged" | "owns-action" | "shared-attendee"
}

/// A meeting referenced as a source for a cross-meeting answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingRef {
    pub id: i64,
    pub title: String,
}

/// Answer to a cross-meeting question plus the meetings it was grounded in.
/// `intent` is the data layer that answered ("todos"|"recap"|"overview"|"detail"),
/// surfaced as a provenance badge; empty for refusals.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskResponse {
    pub answer: String,
    pub sources: Vec<MeetingRef>,
    #[serde(default)]
    pub intent: String,
}

/// An open action item surfaced in the weekly briefing (not done, assignee
/// is not "Not mine"), with the meeting title so the UI can link to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeeklyOpenLoop {
    pub text: String,
    pub due: String,
    pub meeting_id: i64,
    pub meeting_title: String,
}

/// LLM-written weekly executive briefing: deterministic recap data + a prose
/// paragraph summarizing the week (fail-open — empty string if the model is
/// unreachable).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeeklyBriefing {
    pub period_label: String,
    pub meeting_count: usize,
    pub total_minutes: i64,
    pub actions_total: usize,
    pub actions_done: usize,
    pub prose: String,
    pub decisions: Vec<String>,
    pub open_loops: Vec<WeeklyOpenLoop>,
    pub sources: Vec<MeetingRef>,
}

/// One persisted message in the cross-meeting Ask conversation. `sources` is
/// empty for user turns; assistant turns carry the meetings they were grounded in
/// plus the `intent` (which layer answered) for the provenance badge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AskMessage {
    pub role: String, // "user" | "assistant"
    pub content: String,
    #[serde(default)]
    pub sources: Vec<MeetingRef>,
    #[serde(default)]
    pub intent: String,
}

// ---- App config ----

/// Durable, versioned beta-registration state. Contact fields stay in the
/// encrypted local database; only the explicitly documented Formspree payload
/// is sent when registration is attempted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrationState {
    pub schema_version: u32,
    pub status: String,
    pub name: String,
    pub email: String,
    pub consent_version: String,
    pub consent_timestamp: Option<String>,
    pub source: String,
    pub app_version: String,
    pub platform: String,
    pub attempt_count: u32,
    pub next_retry_at: Option<String>,
    pub last_error: Option<String>,
}

impl Default for RegistrationState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            status: "unregistered".to_string(),
            name: String::new(),
            email: String::new(),
            consent_version: String::new(),
            consent_timestamp: None,
            source: "desktop-beta".to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            platform: std::env::consts::OS.to_string(),
            attempt_count: 0,
            next_retry_at: None,
            last_error: None,
        }
    }
}

/// Restart-safe progress through the no-terminal first-run workflow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnboardingState {
    pub schema_version: u32,
    pub completed_steps: Vec<String>,
    pub selected_model_profile: String,
    pub setup_complete: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProfile {
    pub id: String,
    pub display_name: String,
    pub model_alias: String,
    pub model_repo: String,
    pub model_revision: String,
    pub runtime: String,
    pub minimum_memory_gb: u32,
    pub required_disk_gb: u32,
    pub quality_label: String,
    pub quality_note: String,
    pub installed: bool,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupStatus {
    pub schema_version: u32,
    pub platform: String,
    pub architecture: String,
    pub total_memory_bytes: u64,
    pub available_disk_bytes: u64,
    pub rapid_runtime_bundled: bool,
    pub profiles: Vec<ModelProfile>,
    pub recommended_profile: String,
    /// Detected GPU, informational only (consent screen + diagnostics).
    /// None on Apple Silicon and wherever nvidia-smi is absent.
    #[serde(default)]
    pub gpu_name: Option<String>,
    /// Whether the managed llama.cpp engine is installed (non-Apple-Silicon
    /// platforms). Gates the transparent-install consent card in the wizard.
    #[serde(default)]
    pub managed_engine_installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedLlmStatus {
    pub state: String,
    pub profile_id: Option<String>,
    pub detail: String,
}

/// Aggregate-only progress returned by the bundled Python downloader. Paths,
/// repository responses, and credentials never cross into the webview.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownloadStatus {
    pub profile_id: String,
    pub state: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub detail: String,
    pub error_code: Option<String>,
    pub verified: bool,
    pub can_retry: bool,
}

impl Default for OnboardingState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            completed_steps: Vec::new(),
            selected_model_profile: String::new(),
            setup_complete: false,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub python_service_url: String,
    pub default_prompt_template: String,
    pub auto_detect_meetings: bool,
    pub ollama_model: String,
    /// Default summary output language: "en", "ar", or "auto" (match spoken).
    #[serde(default = "default_summary_language")]
    pub summary_language: String,
    /// The user's display name; when set, replaces the "Me" speaker label in
    /// new transcripts so their lines/notes are attributed by name.
    #[serde(default)]
    pub user_name: String,
    /// Free-text list of names/terms (comma or newline separated) used to bias
    /// transcription so Whisper spells them correctly. Empty = no biasing.
    #[serde(default)]
    pub custom_vocabulary: String,
    /// Whether to diarize the system-audio channel into "Speaker 1/2/…" labels
    /// (the mic side stays "Me"). On by default.
    #[serde(default = "default_true")]
    pub diarize: bool,
    /// Whether silence-based auto-stop runs while recording.
    #[serde(default = "default_true")]
    pub auto_stop_enabled: bool,
    /// Minutes of inactivity before prompting "is the meeting over?".
    #[serde(default = "default_silence_prompt_minutes")]
    pub silence_prompt_minutes: u32,
    /// Minutes of inactivity before hard-stopping the recording.
    #[serde(default = "default_silence_stop_minutes")]
    pub silence_stop_minutes: u32,
    /// PBKDF2-SHA256 PIN verifier formatted "iterations.saltHex.hashHex" (set in
    /// Settings). None = no privacy PIN configured. The PIN itself is never stored.
    #[serde(default)]
    pub pin_hash: Option<String>,
    pub claude_api_key: Option<String>,
    /// Read-only calendar integration. None / both-disabled = feature off (default).
    #[serde(default)]
    pub calendar: CalendarConfig,
    /// LLM provider hint for the Settings UI: "local", "grok", "openrouter", "custom".
    #[serde(default = "default_llm_provider")]
    pub llm_provider: String,
    /// OpenAI-compatible base URL used when llm_provider != "local".
    #[serde(default)]
    pub llm_base_url: String,
    /// API key for the cloud LLM provider (only used when llm_base_url is non-empty).
    #[serde(default)]
    pub llm_api_key: String,
    /// Cloud transcription (Bring-Your-Own-Key). When non-empty, the Python
    /// service uploads audio to this OpenAI-compatible /audio/transcriptions
    /// endpoint (e.g. Groq) instead of running local Whisper — for users without
    /// the hardware to transcribe on-device. Empty = on-device Whisper (default).
    /// Cloud mode has no on-device diarization and is not sovereign.
    #[serde(default)]
    pub transcription_base_url: String,
    /// API key for the cloud transcription provider (used when the base URL is set).
    #[serde(default)]
    pub transcription_api_key: String,
    /// Cloud transcription model id (e.g. "whisper-large-v3").
    #[serde(default = "default_transcription_model")]
    pub transcription_model: String,
    /// On-device Whisper model key (e.g. "large-v3", "large-v3-turbo"). Selects
    /// which local MLX model the sidecar uses; only applies when NOT using cloud
    /// transcription. mlx-whisper downloads it on first use.
    #[serde(default = "default_whisper_model")]
    pub whisper_model: String,
    /// Whether the SQLite database is encrypted at rest (SQLCipher, key in the OS
    /// keychain). On by default. Turning it off decrypts the DB to plaintext on the
    /// next launch and deletes the keychain key — which also stops the macOS
    /// keychain-password prompt. Applied at startup; changing it needs a restart.
    #[serde(default = "default_true")]
    pub encrypt_db: bool,
    /// Whether to offer Touch ID / Windows Hello to unlock locked meetings (the PIN
    /// stays as the fallback). On by default; a no-op where no biometric sensor
    /// is present.
    #[serde(default = "default_true")]
    pub biometric_unlock: bool,
    /// The user's email, captured at the first-run beta sign-up. Used only to
    /// pre-fill the "register"/feedback mailto; never sent anywhere automatically.
    #[serde(default)]
    pub user_email: String,
    /// Whether the first-run welcome/sign-up has been completed. When false, the
    /// (required) welcome screen is shown on launch.
    #[serde(default)]
    pub beta_onboarded: bool,
    /// Whether the sign-up was successfully posted to the collection form. False
    /// when the POST failed (e.g. offline at sign-up); retried on next launch so
    /// the email still reaches the list.
    #[serde(default)]
    pub signup_synced: bool,
    /// How dates are displayed across the UI: "system" | "dmy" | "mdy" |
    /// "long" | "iso". Default "system" (the machine locale).
    #[serde(default = "default_date_format")]
    pub date_format: String,
    /// Days a meeting stays in the sidebar's resting view before it folds
    /// into the Archive section. 0 = never archive (flat list as before).
    #[serde(default = "default_archive_after_days")]
    pub archive_after_days: u32,
    /// Sidebar meeting-list style: "compact" (one-line rows) | "full" (cards).
    #[serde(default = "default_sidebar_view")]
    pub sidebar_view: String,
    /// Recording-companion layout: "balanced" (transcript + notes 50/50) |
    /// "transcript" (transcript-first, notes in a footer).
    #[serde(default = "default_recording_view")]
    pub recording_view: String,
    /// Notch pill style shown while recording: "minimal" | "expressive" |
    /// "hidden". "hidden" suppresses the floating pill entirely.
    #[serde(default = "default_notch_pill_style")]
    pub notch_pill_style: String,
    /// How a detected meeting alerts the user: "notch_drop" | "pill_nudge" |
    /// "off". (Only "notch_drop" is wired today; the others land in a later slice.)
    #[serde(default = "default_meeting_alert_style")]
    pub meeting_alert_style: String,
    /// Local folder the second-brain export writes to (markdown notes with
    /// OKF-style frontmatter + [[wikilinks]], e.g. an Obsidian vault subfolder).
    /// Empty = not configured.
    #[serde(default)]
    pub second_brain_path: String,
    /// Auto-export the meeting graph to `second_brain_path` after every meeting
    /// change. Off by default — writing meeting content to a user folder is a
    /// deliberate, opt-in egress.
    #[serde(default)]
    pub second_brain_enabled: bool,
    /// OS notification shortly before a calendar meeting starts. Asked once on
    /// the wizard's Ready screen and editable in Settings › General. Off by
    /// default so existing users never get a surprise notification.
    #[serde(default)]
    pub meeting_reminder_enabled: bool,
    /// Minutes before a meeting's start to notify. Only meaningful while
    /// `meeting_reminder_enabled` is set.
    #[serde(default = "default_meeting_reminder_minutes")]
    pub meeting_reminder_minutes: u32,
    /// One-time guided tour after setup (coach marks ending on Settings › AI
    /// Model). False = not yet shown; set true on finish OR skip.
    #[serde(default)]
    pub tour_completed: bool,
}

/// Default on-device Whisper model for a fresh config. Windows gets the turbo
/// build (~1.6 GB, and the CT2 default the Python service already ships);
/// elsewhere the full `large-v3` stays the default.
pub(crate) fn default_whisper_model() -> String {
    if cfg!(windows) {
        "large-v3-turbo".to_string()
    } else {
        "large-v3".to_string()
    }
}

fn default_date_format() -> String {
    "system".to_string()
}

fn default_archive_after_days() -> u32 {
    30
}

fn default_sidebar_view() -> String {
    "full".to_string()
}

fn default_recording_view() -> String {
    "balanced".to_string()
}

fn default_notch_pill_style() -> String {
    "minimal".to_string()
}

fn default_meeting_alert_style() -> String {
    "notch_drop".to_string()
}

fn default_meeting_reminder_minutes() -> u32 {
    5
}

/// One curated on-device Whisper model + whether it's already downloaded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperModelInfo {
    pub key: String,
    pub label: String,
    pub size: String,
    pub downloaded: bool,
}

fn default_llm_provider() -> String {
    "local".to_string()
}

fn default_transcription_model() -> String {
    "whisper-large-v3".to_string()
}

fn default_summary_language() -> String {
    "en".to_string()
}

fn default_true() -> bool {
    true
}

fn default_silence_prompt_minutes() -> u32 {
    5
}

fn default_silence_stop_minutes() -> u32 {
    10
}

// ---- Meeting statistics (§Build B) ----

/// Per-speaker statistics computed from transcript turns.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SpeakerStats {
    pub name: String,
    pub words: u32,
    /// None when the meeting predates turn timing.
    pub talk_seconds: Option<f64>,
    /// Time-share when timed, else word-share; 0–100.
    pub talk_pct: f64,
    /// Words per spoken minute; None without timing or <5s speech.
    pub wpm: Option<f64>,
    pub fillers: u32,
    /// Fillers / words; 0.0 when words == 0.
    pub filler_rate: f64,
    /// Times this speaker started before another's turn ended.
    pub interruptions: u32,
    pub longest_monologue_seconds: Option<f64>,
    pub longest_monologue_words: u32,
}

/// Aggregate speech statistics for one meeting.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MeetingStats {
    pub has_timing: bool,
    pub total_speech_seconds: Option<f64>,
    /// Which speaker row is "the user" (resolved from user_name or "Me").
    pub owner: Option<String>,
    /// Sorted by talk share descending.
    pub speakers: Vec<SpeakerStats>,
}

// ---- Calendar integration (§5.1) ----

/// Per-provider calendar configuration. No tokens here — keychain only.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CalendarConfig {
    #[serde(default)]
    pub google: Option<CalendarAccount>,
    #[serde(default)]
    pub microsoft: Option<CalendarAccount>,
    /// macOS EventKit calendar (reads from the Mac's Calendar app — no sign-in).
    /// Only meaningful on macOS; ignored on Windows.
    #[serde(default)]
    pub macos_eventkit_enabled: bool,
}

/// Non-secret metadata for a connected calendar account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarAccount {
    pub enabled: bool,
    pub email: String,
    pub display_name: String,
    pub scopes_granted: Vec<String>,
    /// RFC3339; UI "needs reconnect" hint only.
    pub token_expires_at: String,
}

/// An event returned from a calendar read. In-memory only; never persisted as-is.
/// Attendees are used for roster pre-fill; see SPEC §5.3.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEvent {
    pub provider: String, // "google" | "microsoft"
    pub id: String,
    pub title: String,
    pub start: String, // RFC3339
    pub end: String,   // RFC3339
    pub attendees: Vec<CalendarAttendee>,
}

/// A calendar event attendee — richer than the display string we persist.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarAttendee {
    pub name: String,
    pub email: String,
    pub response_status: String, // accepted/declined/tentative/needsAction
    pub organizer: bool,
}
