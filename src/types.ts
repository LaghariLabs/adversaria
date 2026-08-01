/** Shared types — mirrors the Python + Rust contracts. */

// ---- Tags ----

export type TagColor =
  | "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export interface Tag {
  label: string;
  color: TagColor;
}

// ---- API request/response shapes ----

export interface TranscribeResponse {
  text: string;
  language: string;
  duration_seconds: number;
}

export interface SummarizeResponse {
  summary: string;
  template_used: string;
  title: string;
  attendees: string[];
  category?: string;
}

export interface TemplateInfo {
  name: string;
  description: string;
}

/** On-device transcription engine state, reported by `/health` (SPEC V3). */
export type TranscriberState = "loading" | "ready" | "missing" | "error";

export interface HealthResponse {
  status: string;
  whisper_model: string;
  ollama_available: boolean;
  /** Absent on builds older than the V3 service — treat as "unknown". */
  transcriber_state?: TranscriberState;
  /** Human sentence explaining a non-ready `transcriber_state`. */
  transcriber_detail?: string | null;
}

// ---- Meeting (stored in SQLite, exposed via IPC) ----

export interface Meeting {
  id: number;
  title: string;
  recorded_at: string; // ISO-8601
  duration_seconds: number;
  transcript: string;
  summary: string;
  template_used: string;
  audio_file_path: string | null;
  attendees: string[];
  user_notes: string;
  /** Optional source URL (e.g. the YouTube link of a watched video). */
  link: string;
  tags: Tag[];
  pinned: boolean;
  locked: boolean;
  archived: boolean;
  transcript_turns: TranscriptTurn[];
}

export interface ChatMessage {
  id: number;
  meeting_id: number;
  role: string;
  content: string;
  created_at: string;
}

/** One prior turn of the cross-meeting Ask conversation, sent so follow-up
 *  questions can be resolved against context before retrieval. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** An editable person profile stored in the local `people` table. */
export interface PersonProfile {
  id: number;
  name: string;
  role: string;
  company: string;
  notes: string;
  aliases: string;
  /** Contact details. Never inferred from audio — the user types these. */
  email: string;
  phone: string;
  linkedin: string;
}

/** A first-class action item extracted from summary markdown (`- [ ]`/`- [x]`).
 *  The single source of truth for done-state; no longer stored in localStorage. */
export interface ActionItem {
  id: number;
  meeting_id: number;
  ord: number;
  text: string;
  assignee: string;
  due: string; // 'YYYY-MM-DD' or ''
  done: boolean;
  /** "todo" | "in_progress" | "ai_done" | "done" — ai_done awaits your accept. */
  status: string;
  /** "" | "you" | "agent:<name>" */
  completed_by: string;
  completed_at: string;
  /** What the agent did — without this, "done by AI" is uncheckable. */
  evidence: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  key: string;
  label: string;
  node_type: "meeting" | "person" | "tag" | "owner";
  meeting_id: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  label: string;
}

export interface MeetingRef {
  id: number;
  title: string;
}

export interface AskResponse {
  answer: string;
  sources: MeetingRef[];
  /** Data layer that answered: "todos"|"recap"|"overview"|"detail" ("" = none). */
  intent: string;
}

/** An open action item surfaced in the weekly briefing (not done, assignee
 *  is not "Not mine"), with the meeting title so the UI can link to it. */
export interface WeeklyOpenLoop {
  text: string;
  due: string;
  meeting_id: number;
  meeting_title: string;
}

/** LLM-written weekly executive briefing: deterministic recap data + a prose
 *  paragraph summarizing the week (fail-open — empty string if the model is
 *  unreachable). */
export interface WeeklyBriefing {
  period_label: string;
  meeting_count: number;
  total_minutes: number;
  actions_total: number;
  actions_done: number;
  prose: string;
  decisions: string[];
  open_loops: WeeklyOpenLoop[];
  sources: { id: number; title: string }[];
}

/** One persisted message in the cross-meeting Ask conversation. */
export interface AskMessage {
  role: "user" | "assistant";
  content: string;
  sources: MeetingRef[];
  intent: string;
}

// ---- Application config ----

export type PromptTemplate = string;

/** Summary output language: English, Arabic, or "match the spoken language". */
export type SummaryLanguage = "en" | "ar" | "auto";

export interface WhisperModelInfo {
  key: string;
  label: string;
  size: string;
  downloaded: boolean;
}

export interface AppConfig {
  python_service_url: string;
  default_prompt_template: PromptTemplate;
  auto_detect_meetings: boolean;
  ollama_model: string;
  summary_language: string;
  user_name: string;
  custom_vocabulary: string;
  diarize: boolean;
  auto_stop_enabled: boolean;
  silence_prompt_minutes: number;
  silence_stop_minutes: number;
  pin_hash: string | null;
  claude_api_key: string | null;
  llm_provider: string;
  llm_base_url: string;
  llm_api_key: string;
  transcription_base_url: string;
  transcription_api_key: string;
  transcription_model: string;
  whisper_model: string;
  encrypt_db: boolean;
  biometric_unlock: boolean;
  user_email: string;
  beta_onboarded: boolean;
  signup_synced: boolean;
  /** How dates render across the UI: "system"|"dmy"|"mdy"|"long"|"iso". */
  date_format: string;
  /** Days a meeting stays in the sidebar's resting view before folding into Archive. 0 = never. */
  archive_after_days: number;
  /** Sidebar meeting-list style: "compact" (one-line rows) | "full" (cards). */
  sidebar_view: string;
  /** Recording-companion layout: "balanced" (transcript + notes 50/50) | "transcript" (transcript-first). */
  recording_view: string;
  /** Notch pill style while recording: "minimal" | "expressive" | "hidden". */
  notch_pill_style: string;
  /** Detected-meeting alert style: "notch_drop" | "pill_nudge" | "off". */
  meeting_alert_style: string;
  /** Local folder the second-brain export writes markdown notes into. */
  second_brain_path: string;
  /** Auto-export the meeting graph after every meeting change. */
  second_brain_enabled: boolean;
  /** OS notification N minutes before a calendar meeting starts. */
  meeting_reminder_enabled: boolean;
  meeting_reminder_minutes: number;
  /** One-time guided tour shown after setup; true once finished or skipped. */
  tour_completed: boolean;
  calendar: CalendarConfig;
}

export interface RegistrationState {
  schema_version: number;
  status: "unregistered" | "pending" | "submitted";
  name: string;
  email: string;
  consent_version: string;
  consent_timestamp: string | null;
  source: string;
  app_version: string;
  platform: string;
  attempt_count: number;
  next_retry_at: string | null;
  last_error: string | null;
}

export interface OnboardingState {
  schema_version: number;
  completed_steps: string[];
  selected_model_profile: string;
  setup_complete: boolean;
  updated_at: string;
}

export interface ModelProfile {
  id: string;
  display_name: string;
  model_alias: string;
  model_repo: string;
  model_revision: string;
  runtime: string;
  minimum_memory_gb: number;
  required_disk_gb: number;
  quality_label: string;
  quality_note: string;
  installed: boolean;
  recommended: boolean;
}

export interface SetupStatus {
  schema_version: number;
  platform: string;
  architecture: string;
  total_memory_bytes: number;
  available_disk_bytes: number;
  rapid_runtime_bundled: boolean;
  profiles: ModelProfile[];
  recommended_profile: string;
  /** Detected GPU (informational); absent on Apple Silicon / no nvidia-smi. */
  gpu_name?: string | null;
  /** Managed llama.cpp engine installed (non-Apple-Silicon platforms). */
  managed_engine_installed?: boolean;
}

/** Everything the transparent Windows engine install would do — shown on the
 * consent card BEFORE anything downloads (SETUP_REDESIGN_SPEC §D). */
export interface EngineInstallPlan {
  schema_version: number;
  engine_name: string;
  engine_version: string;
  asset_name: string;
  asset_size_bytes: number;
  asset_sha256: string;
  source_url: string;
  install_dir: string;
  engine_installed: boolean;
  gpu: string | null;
  model_profile_id: string;
  model_display_name: string;
  model_repo: string;
  model_revision: string;
  model_file: string;
  model_size_bytes: number;
  model_sha256: string;
  model_installed: boolean;
}

export interface ManagedLlmStatus {
  state: "stopped" | "starting" | "ready" | "error";
  profile_id: string | null;
  detail: string;
}

export interface ModelDownloadStatus {
  profile_id: string;
  state: "idle" | "preparing" | "downloading" | "verifying" | "ready" | "error";
  downloaded_bytes: number;
  total_bytes: number;
  detail: string;
  error_code: string | null;
  verified: boolean;
  can_retry: boolean;
}

// ---- Calendar integration ----

export interface CalendarConfig {
  google: CalendarAccount | null;
  microsoft: CalendarAccount | null;
  /** macOS EventKit calendar (reads from the Mac's Calendar app — no sign-in). */
  macos_eventkit_enabled: boolean;
}

export interface CalendarAccount {
  enabled: boolean;
  email: string;
  display_name: string;
  scopes_granted: string[];
  token_expires_at: string;
}

export interface CalendarEvent {
  provider: string; // "google" | "microsoft"
  id: string;
  title: string;
  start: string; // RFC3339
  end: string; // RFC3339
  attendees: CalendarAttendee[];
}

export interface CalendarAttendee {
  name: string;
  email: string;
  response_status: string; // accepted/declined/tentative/needsAction
  organizer: boolean;
}

// ---- Meeting statistics (§Build B) ----

export interface TranscriptTurn {
  speaker: string;
  text: string;
  start?: number | null;
  end?: number | null;
}

export interface SpeakerStats {
  name: string;
  words: number;
  talk_seconds: number | null;
  talk_pct: number;
  wpm: number | null;
  fillers: number;
  filler_rate: number;
  interruptions: number;
  longest_monologue_seconds: number | null;
  longest_monologue_words: number;
}

export interface MeetingStats {
  has_timing: boolean;
  total_speech_seconds: number | null;
  owner: string | null;
  speakers: SpeakerStats[];
}
