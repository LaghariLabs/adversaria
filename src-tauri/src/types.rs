//! Shared types — mirrors the Python + TypeScript contracts.
use serde::{Deserialize, Serialize};

fn is_false(value: &bool) -> bool {
    !*value
}

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
    /// Semantic-search readiness reported by the service:
    /// `ready` | `missing` | `unavailable`. Absent on older services.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedder_state: Option<String>,
    /// Human detail for the semantic-search engine state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedder_detail: Option<String>,
    /// English live-caption preview engine: `missing` | `loading` | `ready` |
    /// `error`. Absent on older services.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_captions_state: Option<String>,
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

/// One document discovered in an automatic workspace context source.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextDoc {
    pub id: i64,
    pub source: String,
    pub path: String,
    pub title: String,
    pub body: String,
    pub fingerprint: String,
    pub updated_at: String,
}

/// One embedded passage from a vault note or project card.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextChunkRow {
    pub doc_id: i64,
    pub text: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meeting {
    pub id: i64,
    /// Stable UUID v4 across machines and imports.
    #[serde(default)]
    pub uid: String,
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
pub struct MeetingAttachment {
    pub id: i64,
    pub meeting_id: i64,
    pub kind: String,
    pub value: String,
    pub label: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachmentDraft {
    pub kind: String,
    pub value: String,
    pub label: String,
}

/// Result report from importing an Adversaria document or legacy bundle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportReport {
    pub format: String, /* "adversaria-1" | "legacy-json-1" */
    pub imported: i64,
    pub skipped_existing: i64,
    pub folders_created: i64,
    pub meeting_ids: Vec<i64>,
    pub folder_id: Option<i64>,
    pub path: String,
}

/// An earlier meeting attached while recording, with its still-open action items,
/// sent to the summarizer so the notes get a follow-up check on each item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriorMeeting {
    pub title: String,
    /// `YYYY-MM-DD` of the earlier meeting, or empty when unknown.
    pub date: String,
    pub open_items: Vec<String>,
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
    /// Whether this build can launch the app-managed Ollama sidecar.
    #[serde(default, skip_serializing_if = "is_false")]
    pub ollama_sidecar_available: bool,
    /// Version reported by the managed Ollama binary or running sidecar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ollama_version: Option<String>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RecentCard {
    pub card_ref: String,
    pub question: String,
    pub say: String,
    /// The card's SPECIFIC lines (bullets or steps), oldest card first like the list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<String>,
    pub origin: String,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotFolderReadiness {
    pub session_id: String,
    pub folder_id: Option<i64>,
    pub status: String,
    pub count: usize,
    pub pack_projects: u32,
    pub pack_chars: usize,
    pub pack_hash: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub python_service_url: String,
    pub default_prompt_template: String,
    pub auto_detect_meetings: bool,
    pub ollama_model: String,
    #[serde(default)]
    pub copilot_local_model: String,
    #[serde(default = "crate::config::default_copilot_deepseek_model")]
    pub copilot_deepseek_model: String,
    /// Default summary output language: "en", "ar", or "auto" (match spoken).
    #[serde(default = "default_summary_language")]
    pub summary_language: String,
    /// Main-window appearance: "dark", "light", or "system".
    #[serde(default = "default_theme")]
    pub theme: String,
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
    /// Which transcription engine the user chose: "local" (on-device Whisper),
    /// "self_hosted" (their own Whisper API — audio stays on their network), or
    /// "cloud" (a provider's API — audio leaves the device). Only labels the
    /// remote endpoint below; the request path is the same for both remote
    /// modes. Blank on configs written before this field existed —
    /// `config::load_config` classifies those from `transcription_base_url`.
    #[serde(default)]
    pub transcription_provider: String,
    /// Remote transcription (Bring-Your-Own-Key). When non-empty, the Python
    /// service uploads audio to this OpenAI-compatible /audio/transcriptions
    /// endpoint (a self-hosted Whisper box, or a provider like Groq) instead of
    /// running local Whisper — for users without the hardware to transcribe
    /// on-device. Empty = on-device Whisper (default). Neither remote mode has
    /// on-device diarization.
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
    /// Obsidian vault searched automatically for workspace runs. Empty disables
    /// the source (legacy configs derive it from `second_brain_path` at load).
    #[serde(default)]
    pub context_vault_path: String,
    /// Parent folder whose immediate subdirectories are indexed as projects.
    /// Empty disables automatic project matching.
    #[serde(default)]
    pub context_projects_root: String,
    /// OS notification shortly before a calendar meeting starts. Asked once on
    /// the wizard's Ready screen and editable in Settings › General. Off by
    /// default so existing users never get a surprise notification.
    #[serde(default)]
    pub meeting_reminder_enabled: bool,
    /// Minutes before a meeting's start to notify. Only meaningful while
    /// `meeting_reminder_enabled` is set.
    #[serde(default = "default_meeting_reminder_minutes")]
    pub meeting_reminder_minutes: u32,
    /// Daily OS notification summarising to-dos that are due or overdue
    /// (`reminders.rs`). Distinct from `meeting_reminder_enabled`, which is the
    /// pre-meeting alert in `meeting_reminders.rs`.
    ///
    /// Defaults to **true**: this digest shipped with no gate at all until
    /// 2026-08-05, so defaulting to false would silently switch off a
    /// notification existing users already receive. The point of the field is
    /// that they can now turn it off.
    #[serde(default = "default_true")]
    pub todo_digest_enabled: bool,
    /// Local hour (0–23) at which the daily to-do digest fires. Only meaningful
    /// while `todo_digest_enabled` is set.
    #[serde(default = "default_todo_digest_hour")]
    pub todo_digest_hour: u32,
    /// One-time guided tour after setup (coach marks ending on Settings › AI
    /// Model). False = not yet shown; set true on finish OR skip.
    #[serde(default)]
    pub tour_completed: bool,
    /// Global Pause: when true no workspace task starts by itself.
    #[serde(default)]
    pub agents_paused: bool,
    /// Copilot HUD floating-window position (logical top-left px). `None` =
    /// default (horizontally centred on the primary monitor, 96 px from the
    /// top). Written only via `config::update_config_with` from
    /// `copilot_hud_save_position`.
    #[serde(default)]
    pub copilot_hud_x: Option<f64>,
    #[serde(default)]
    pub copilot_hud_y: Option<f64>,
    /// Copilot HUD floating-window size (logical px). `None` = default
    /// (720 x 180). Written only via `config::update_config_with` from
    /// `copilot_hud_save_size`.
    #[serde(default)]
    pub copilot_hud_w: Option<f64>,
    #[serde(default)]
    pub copilot_hud_h: Option<f64>,
    /// Floating copilot pop-out. Off by default in 0.4.0: the shortcut, the
    /// menu item and the `show_copilot_hud` command are all no-ops until this
    /// is true. Flip it in config.json to try the pop-out in a release build.
    #[serde(default)]
    pub copilot_hud_enabled: bool,
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

/// 09:00 local — the hour the digest hardcoded before it became configurable.
fn default_todo_digest_hour() -> u32 {
    9
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

fn default_theme() -> String {
    "dark".into()
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

// ---- Workspaces ----

/// User-selected roots that feed the automatic workspace context index.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ContextSources {
    pub vault_path: String,
    pub projects_root: String,
}

/// Aggregate state surfaced in Settings for the local context index.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ContextIndexStatus {
    pub vault_docs: i64,
    pub project_docs: i64,
    pub changed: i64,
    pub embedding_errors: i64,
    pub last_synced_at: String,
}

// ---- Meeting folders ----

/// A user-defined collection used only to organize meetings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: i64,
    /// Stable UUID v4 across machines and imports.
    #[serde(default)]
    pub uid: String,
    pub name: String,
    pub color: String,
    pub instructions: String,
    pub copilot_mode: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub purpose: String,
    #[serde(default)]
    pub profile: String,
    #[serde(default)]
    pub profile_hash: String,
    #[serde(default)]
    pub profile_at: String,
    #[serde(default)]
    pub voice_1: String,
    #[serde(default)]
    pub voice_2: String,
}

/// A file or directory explicitly approved as evidence for one folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FolderSource {
    pub id: i64,
    pub folder_id: i64,
    pub path: String,
    pub kind: String,
    pub added_at: String,
    pub doc_count: i64,
}

/// A folder plus its number of explicitly filed meetings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderSummary {
    pub folder: Folder,
    pub meeting_count: i64,
    pub copilot_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BriefMeetingRef {
    pub id: i64,
    pub title: String,
    pub recorded_at: String,
    pub attendees: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BriefOpenItem {
    pub id: i64,
    pub meeting_id: i64,
    pub meeting_title: String,
    pub recorded_at: String,
    pub ord: i64,
    pub text: String,
    pub assignee: String,
    pub due: String,
    pub meetings_ago: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BriefBullet {
    pub meeting_id: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FolderCopilotBrief {
    pub folder_id: i64,
    pub folder_name: String,
    pub copilot_mode: String,
    pub copilot_web: bool,
    pub meeting_count: i64,
    pub last_meeting: Option<BriefMeetingRef>,
    pub open_items: Vec<BriefOpenItem>,
    pub decisions: Vec<BriefBullet>,
    pub follow_ups: Vec<BriefBullet>,
}

/// Which folder contains a meeting. `folder_id == None` means explicitly unfiled;
/// no row at all means no filing decision has been made.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingFolder {
    pub meeting_id: i64,
    pub folder_id: Option<i64>,
    /// Resolved at read time; empty when explicitly unfiled.
    pub folder_name: String,
}

/// The folder the graph proposes for a meeting, with the evidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderSuggestion {
    pub folder_id: i64,
    pub folder_name: String,
    pub related_meeting_count: i64,
    pub shared_attendee_count: i64,
}

/// A long-lived project container for meeting work.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: i64,
    pub name: String,
    pub engine: String,
    pub model: String,
    pub network_allowed: bool,
    pub instructions: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A workspace plus the counts shown on its home-screen card.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub workspace: Workspace,
    pub queued_task_count: i64,
    pub needs_you_count: i64,
    pub running_task_count: i64,
    pub awaiting_review_count: i64,
    pub approved_task_count: i64,
    pub total_task_count: i64,
    pub meeting_count: i64,
    pub folder_count: i64,
}

/// Which workspace a meeting's to-dos flow into. `workspace_id == None`
/// means the user said "not a project"; no row at all means undecided.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingWorkspaceBinding {
    pub meeting_id: i64,
    pub workspace_id: Option<i64>,
    /// Resolved at read time; empty when unbound.
    pub workspace_name: String,
}

/// The workspace the graph proposes for a meeting, with the evidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSuggestion {
    pub workspace_id: i64,
    pub workspace_name: String,
    pub related_meeting_count: i64,
    pub shared_attendee_count: i64,
}

/// What would ground a drafted task, shown before it runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskGroundingPreview {
    pub related_meeting_count: i64,
    pub latest_related_title: String,
    pub vault_hit_count: i64,
    pub top_vault_label: String,
    pub project_hit_count: i64,
}

/// One meeting, folder, or file made available to a workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceContextItem {
    pub id: i64,
    pub workspace_id: i64,
    pub kind: String,
    pub value: String,
    pub label: String,
    pub created_at: String,
}

/// A reusable skill or agent role available to workspaces.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceAddon {
    pub id: i64,
    /// "skill" | "agent"
    pub kind: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    /// Markdown instructions injected into the brief.
    pub instructions: String,
    pub builtin: bool,
    pub created_at: String,
}

/// A queued unit of work inside a workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceTask {
    pub id: i64,
    pub workspace_id: i64,
    pub title: String,
    pub details: String,
    pub capability: String,
    pub status: String,
    pub source_meeting_id: Option<i64>,
    /// Resolved at read time; empty when the task has no source meeting.
    pub source_meeting_title: String,
    /// The to-do this task was pushed from, when it came from the board.
    pub action_item_id: Option<i64>,
    /// 1 for the first run; incremented by every rejection.
    pub attempt: i64,
    /// One line per rejection, oldest first. Appended to the brief on re-run.
    pub rejection_notes: Vec<String>,
    pub agent_eligible: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Which agent and skills a queued task will run with, and why.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TaskStaffing {
    /// "automatic" | "manual"
    pub mode: String,
    pub agent_id: Option<i64>,
    pub skill_ids: Vec<i64>,
    /// Human-readable explanation, empty for manual.
    pub reason: String,
    pub resolved_at: String,
}

/// One execution attempt for a workspace task.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkspaceRun {
    pub id: i64,
    pub workspace_id: i64,
    pub task_id: i64,
    pub engine: String,
    pub status: String,
    pub log: String,
    pub report: String,
    pub error: String,
    pub started_at: String,
    pub finished_at: String,
}

/// A file produced by a workspace run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkspaceArtifact {
    pub id: i64,
    pub workspace_id: i64,
    pub run_id: i64,
    pub name: String,
    pub path: String,
    pub created_at: String,
}

/// Runtime availability information for one workspace execution engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkspaceEngine {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub version: String,
    pub detail: String,
}

/// The complete data needed by the workspace detail screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDetail {
    pub workspace: Workspace,
    pub context_items: Vec<WorkspaceContextItem>,
    pub addons: Vec<WorkspaceAddon>,
    pub tasks: Vec<WorkspaceTask>,
    pub artifacts: Vec<WorkspaceArtifact>,
}

/// Cached, AI-generated understanding of a project built from its filed meetings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectOverview {
    pub workspace_id: i64,
    pub summary: String,
    pub generated_at: String,
    pub source_meeting_count: i64,
    pub stale: bool,
}

/// Cached, AI-generated understanding of a folder built from its filed meetings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderOverview {
    pub folder_id: i64,
    pub summary: String,
    pub generated_at: String,
    pub source_meeting_count: i64,
    pub stale: bool,
}

/// A related meeting surfaced under a note, with the reason it matched.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelatedMeetingRef {
    pub meeting_id: i64,
    pub title: String,
    pub recorded_at: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotPassage {
    pub source_kind: String,
    pub source_id: String,
    pub title: String,
    pub text: String,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotCard {
    pub id: u64,
    pub session_id: String,
    pub status: String,
    pub provider_frozen: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_of: Option<u64>,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_question: Option<String>,
    #[serde(default = "default_answer_shape")]
    pub answer_shape: String,
    #[serde(default = "default_copilot_question_source")]
    pub question_source: String,
    #[serde(default)]
    pub context_turns: Vec<String>,
    pub asked_at_ms: u64,
    pub trigger: String,
    pub passages: Vec<CopilotPassage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_ms: Option<u64>,
}

fn default_copilot_question_source() -> String {
    "Them".to_string()
}

fn default_answer_shape() -> String {
    "brief".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CopilotLiveContext {
    pub folder_id: Option<i64>,
    pub notes: String,
    pub attachments: Vec<AttachmentDraft>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotAnswerEvent {
    pub card_id: u64,
    pub session_id: String,
    pub provider: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drop: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sections: Option<CopilotSections>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation: Option<CopilotCitation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Vec<CopilotBullet>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub egress_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_requested: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_performed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotCommandAck {
    pub session_id: String,
    pub card_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotCitation {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cited_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotBullet {
    pub text: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CopilotNote {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage_index: Option<usize>,
    pub quote: String,
    pub clause: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CopilotSections {
    pub say: Vec<String>,
    pub specifics: Vec<String>,
    pub notes: Vec<CopilotNote>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotHistoryCard {
    pub row_id: i64,
    pub session_id: String,
    pub card_id: i64,
    pub at: String,
    pub finished_at: Option<String>,
    pub question: String,
    pub resolved_question: Option<String>,
    #[serde(default = "default_answer_shape")]
    pub answer_shape: String,
    pub provider: String,
    pub trigger: String,
    pub status: String,
    pub reason: Option<String>,
    pub error: Option<String>,
    pub retry_of: Option<i64>,
    pub answer_md: Option<String>,
    pub sections: Option<CopilotSections>,
    pub passages: Vec<CopilotPassage>,
    pub provenance: Vec<CopilotBullet>,
    pub pinned_at: Option<String>,
    pub dismissed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetingCopilotHistory {
    pub meeting_id: i64,
    pub cards: Vec<CopilotHistoryCard>,
    #[serde(default)]
    pub live_items: Vec<LiveItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotCardReviewState {
    pub row_id: i64,
    pub pinned_at: Option<String>,
    pub dismissed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveReviewEvent {
    pub action: String,
    pub at: String,
    pub before_text: Option<String>,
    pub after_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub original_text: String,
    pub owner: Option<String>,
    pub due: Option<String>,
    pub status: String,
    pub revision: u64,
    pub evidence_turn_ids: Vec<String>,
    pub at_ms: u64,
    pub review_events: Vec<LiveReviewEvent>,
    #[serde(default)]
    pub withdrawal_quote: Option<String>,
    #[serde(default)]
    pub withdrawn_at: Option<String>,
}

/// User-confirmed live facts carried into the final meeting summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct AcceptedLiveItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub owner: Option<String>,
    pub due: Option<String>,
    pub evidence_turn_ids: Vec<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct LiveSummary {
    #[serde(default)]
    pub bullets: Vec<String>,
    #[serde(default)]
    pub evidence_turn_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveState {
    pub session_id: String,
    pub revision: u64,
    pub enabled: bool,
    pub status: String,
    pub reason: Option<String>,
    pub through_ms: u64,
    pub summary: LiveSummary,
    pub items: Vec<LiveItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveTurn {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub source: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveItemIn {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub owner: Option<String>,
    pub due: Option<String>,
    pub status: String,
    #[serde(default)]
    pub evidence_turn_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveExtractRequest {
    pub request_id: String,
    pub session_id: String,
    pub base_revision: u64,
    pub model: String,
    pub num_ctx: u64,
    pub update_summary: bool,
    #[serde(default)]
    pub turns: Vec<LiveTurn>,
    #[serde(default)]
    pub items: Vec<LiveItemIn>,
    #[serde(default)]
    pub new_turn_ids: Vec<String>,
    pub summary: LiveSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveUpsert {
    pub id: Option<String>,
    pub kind: String,
    pub text: String,
    pub owner: Option<String>,
    pub due: Option<String>,
    #[serde(default)]
    pub evidence_turn_ids: Vec<String>,
    pub supersedes_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveRetraction {
    pub id: String,
    #[serde(default)]
    pub evidence_turn_ids: Vec<String>,
    #[serde(default)]
    pub reason_code: String,
    #[serde(default)]
    pub withdrawal_quote: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveExtractResponse {
    pub request_id: String,
    pub session_id: String,
    pub base_revision: u64,
    pub status: String,
    pub reason: Option<String>,
    pub through_ms: Option<u64>,
    #[serde(default)]
    pub upserts: Vec<LiveUpsert>,
    #[serde(default)]
    pub retractions: Vec<LiveRetraction>,
    pub summary: Option<LiveSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CopilotReceipt {
    pub questions: u32,
    pub passages: u32,
    pub claude_questions: u32,
    pub deepseek_questions: u32,
    pub local_questions: u32,
    pub web_requested: u32,
    pub web_performed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotEgressPassage {
    pub title: String,
    pub text: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CopilotEgressPayload {
    pub question: String,
    pub context_turns: Vec<String>,
    pub passages: Vec<CopilotEgressPassage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_folder_json_defaults_new_copilot_fields() {
        let folder: Folder = serde_json::from_value(serde_json::json!({
            "id": 1, "name": "Legacy", "color": "blue", "instructions": "",
            "copilot_mode": "no_ai", "created_at": "now", "updated_at": "now"
        }))
        .unwrap();
        let value = serde_json::to_value(folder).unwrap();
        for key in [
            "purpose",
            "profile",
            "profile_hash",
            "profile_at",
            "voice_1",
            "voice_2",
        ] {
            assert_eq!(value[key], "");
        }
    }

    #[test]
    fn folder_source_wire_keys_round_trip() {
        let value = serde_json::json!({"id": 1, "folder_id": 2, "path": "/me.md", "kind": "file", "added_at": "now", "doc_count": 1});
        let source: FolderSource = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(source).unwrap(), value);
    }

    #[test]
    fn copilot_hud_position_defaults_to_none_for_older_configs_and_round_trips() {
        let mut value = serde_json::to_value(AppConfig::default()).unwrap();
        assert_eq!(value["copilot_hud_x"], serde_json::Value::Null);
        assert_eq!(value["copilot_hud_y"], serde_json::Value::Null);
        value.as_object_mut().unwrap().remove("copilot_hud_x");
        value.as_object_mut().unwrap().remove("copilot_hud_y");
        let mut config: AppConfig = serde_json::from_value(value).unwrap();
        assert_eq!(config.copilot_hud_x, None);
        assert_eq!(config.copilot_hud_y, None);
        config.copilot_hud_x = Some(100.0);
        config.copilot_hud_y = Some(200.0);
        let round_tripped = serde_json::to_value(config).unwrap();
        assert_eq!(round_tripped["copilot_hud_x"], 100.0);
        assert_eq!(round_tripped["copilot_hud_y"], 200.0);
    }

    #[test]
    fn copilot_hud_size_defaults_to_none_for_older_configs_and_round_trips() {
        let mut value = serde_json::to_value(AppConfig::default()).unwrap();
        assert_eq!(value["copilot_hud_w"], serde_json::Value::Null);
        assert_eq!(value["copilot_hud_h"], serde_json::Value::Null);
        value.as_object_mut().unwrap().remove("copilot_hud_w");
        value.as_object_mut().unwrap().remove("copilot_hud_h");
        let mut config: AppConfig = serde_json::from_value(value).unwrap();
        assert_eq!(config.copilot_hud_w, None);
        assert_eq!(config.copilot_hud_h, None);
        config.copilot_hud_w = Some(900.0);
        config.copilot_hud_h = Some(240.0);
        let round_tripped = serde_json::to_value(config).unwrap();
        assert_eq!(round_tripped["copilot_hud_w"], 900.0);
        assert_eq!(round_tripped["copilot_hud_h"], 240.0);
    }

    #[test]
    fn copilot_local_model_defaults_for_legacy_config_and_round_trips() {
        let mut value = serde_json::to_value(AppConfig::default()).unwrap();
        assert_eq!(value["copilot_local_model"], "");
        value.as_object_mut().unwrap().remove("copilot_local_model");
        let mut config: AppConfig = serde_json::from_value(value).unwrap();
        assert_eq!(config.copilot_local_model, "");
        config.copilot_local_model = "qwen3.6:35b".into();
        assert_eq!(
            serde_json::to_value(config).unwrap()["copilot_local_model"],
            "qwen3.6:35b"
        );
    }

    #[test]
    fn copilot_sections_serialize_with_snake_case_and_omit_absent_next() {
        let sections = CopilotSections {
            say: vec!["I used a bounded queue.".into()],
            specifics: vec!["Apply backpressure.".into()],
            notes: vec![CopilotNote {
                passage_index: Some(1),
                quote: "bounded queue".into(),
                clause: "bounds memory".into(),
                text: "P2 | \"bounded queue\" | bounds memory".into(),
            }],
            next: None,
        };
        let value = serde_json::to_value(&sections).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "say": ["I used a bounded queue."],
                "specifics": ["Apply backpressure."],
                "notes": [{
                    "passage_index": 1,
                    "quote": "bounded queue",
                    "clause": "bounds memory",
                    "text": "P2 | \"bounded queue\" | bounds memory"
                }]
            })
        );
        assert_eq!(
            serde_json::from_value::<CopilotSections>(value).unwrap(),
            sections
        );
        assert!(serde_json::to_value(CopilotNote::default())
            .unwrap()
            .get("passage_index")
            .is_none());
    }

    #[test]
    fn copilot_answer_event_serializes_with_snake_case_keys() {
        let event = CopilotAnswerEvent {
            card_id: 42,
            session_id: "s1".to_string(),
            provider: "claude".to_string(),
            kind: "done".to_string(),
            text: None,
            section: None,
            index: None,
            drop: None,
            sections: None,
            citation: None,
            provenance: Some(vec![CopilotBullet {
                text: "First bullet".to_string(),
                label: "notes".to_string(),
                passage_index: Some(0),
                url: None,
            }]),
            egress_bytes: Some(150),
            web_requested: Some(true),
            web_performed: Some(1),
            error: None,
            reason: Some("ok".to_string()),
        };

        let val = serde_json::to_value(&event).unwrap();
        assert_eq!(val.get("card_id").and_then(|v| v.as_u64()), Some(42));
        assert_eq!(val.get("session_id").and_then(|v| v.as_str()), Some("s1"));
        assert_eq!(val.get("provider").and_then(|v| v.as_str()), Some("claude"));
        assert_eq!(val.get("kind").and_then(|v| v.as_str()), Some("done"));
        assert_eq!(val.get("egress_bytes").and_then(|v| v.as_u64()), Some(150));
        assert_eq!(
            val.get("web_requested").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(val.get("web_performed").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(val.get("reason").and_then(|v| v.as_str()), Some("ok"));
        assert!(val.get("text").is_none());
        assert!(val.get("drop").is_none());
        assert!(val.get("citation").is_none());
        assert!(val.get("error").is_none());
        let prov = val.get("provenance").and_then(|v| v.as_array()).unwrap();
        assert_eq!(prov.len(), 1);
        assert_eq!(
            prov[0].get("passage_index").and_then(|v| v.as_u64()),
            Some(0)
        );
        assert!(prov[0].get("url").is_none());
    }

    #[test]
    fn copilot_command_ack_serializes() {
        let ack = CopilotCommandAck {
            session_id: "s2".to_string(),
            card_id: 123,
        };
        let val = serde_json::to_value(&ack).unwrap();
        assert_eq!(val.get("session_id").and_then(|v| v.as_str()), Some("s2"));
        assert_eq!(val.get("card_id").and_then(|v| v.as_u64()), Some(123));
    }

    #[test]
    fn copilot_card_v2_serializes_with_session_id() {
        let card = CopilotCard {
            id: 1,
            session_id: "s3".to_string(),
            status: "heard".to_string(),
            provider_frozen: "no_ai".to_string(),
            reason: Some("retry".to_string()),
            retry_of: Some(42),
            question: "Q?".to_string(),
            resolved_question: Some("What was asked?".to_string()),
            answer_shape: "brief".to_string(),
            question_source: "Them".to_string(),
            context_turns: vec!["Me: Earlier context".to_string()],
            asked_at_ms: 1000,
            trigger: "auto".to_string(),
            passages: vec![],
            retrieval_ms: Some(10),
        };
        let val = serde_json::to_value(&card).unwrap();
        assert_eq!(val.get("session_id").and_then(|v| v.as_str()), Some("s3"));
        assert_eq!(val.get("status").and_then(|v| v.as_str()), Some("heard"));
        assert_eq!(
            val.get("provider_frozen").and_then(|v| v.as_str()),
            Some("no_ai")
        );
        assert_eq!(val.get("reason").and_then(|v| v.as_str()), Some("retry"));
        assert_eq!(val.get("retry_of").and_then(|v| v.as_u64()), Some(42));
        assert_eq!(val["resolved_question"], "What was asked?");
        let mut legacy = val;
        legacy.as_object_mut().unwrap().remove("resolved_question");
        let legacy: CopilotCard = serde_json::from_value(legacy).unwrap();
        assert!(legacy.resolved_question.is_none());
        assert!(serde_json::to_value(legacy)
            .unwrap()
            .get("resolved_question")
            .is_none());
    }

    #[test]
    fn folder_copilot_brief_serializes_with_snake_case_keys() {
        let brief = FolderCopilotBrief {
            folder_id: 7,
            folder_name: "Daily stand-up".to_string(),
            copilot_mode: "no_ai".to_string(),
            copilot_web: true,
            meeting_count: 1,
            last_meeting: Some(BriefMeetingRef {
                id: 11,
                title: "Stand-up".to_string(),
                recorded_at: "2026-07-03T09:00:00Z".to_string(),
                attendees: vec!["Sam".to_string()],
            }),
            open_items: vec![BriefOpenItem {
                id: 13,
                meeting_id: 11,
                meeting_title: "Stand-up".to_string(),
                recorded_at: "2026-07-03T09:00:00Z".to_string(),
                ord: 0,
                text: "Send recap".to_string(),
                assignee: "Sam".to_string(),
                due: String::new(),
                meetings_ago: 0,
            }],
            decisions: Vec::new(),
            follow_ups: Vec::new(),
        };

        let value = serde_json::to_value(brief).unwrap();
        assert!(value.get("folder_id").is_some());
        assert_eq!(
            value.get("copilot_web").and_then(|item| item.as_bool()),
            Some(true)
        );
        assert!(value.get("last_meeting").is_some());
        assert!(value.get("open_items").is_some());
        assert!(value["open_items"][0].get("meetings_ago").is_some());
    }
}
