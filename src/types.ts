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
export type EmbedderState = "ready" | "missing" | "unavailable";
export type LiveCaptionsState = "loading" | "ready" | "missing" | "error";

export interface HealthResponse {
  status: string;
  whisper_model: string;
  ollama_available: boolean;
  /** Absent on builds older than the V3 service — treat as "unknown". */
  transcriber_state?: TranscriberState;
  /** Human sentence explaining a non-ready `transcriber_state`. */
  transcriber_detail?: string | null;
  /** Semantic-search model state; absent on older service builds. */
  embedder_state?: EmbedderState;
  /** Human sentence explaining the semantic-search state. */
  embedder_detail?: string | null;
  /** English live-caption preview engine; absent on older service builds. */
  live_captions_state?: LiveCaptionsState;
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

export interface MeetingAttachment {
  id: number;
  meeting_id: number;
  kind: string;
  value: string;
  label: string;
  created_at: string;
}

export interface AttachmentDraft {
  kind: string;
  value: string;
  label: string;
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

/** Summary output language, or "match the spoken language". */
export type SummaryLanguage = "en" | "ar" | "zh" | "hi" | "es" | "fr" | "bn" | "pt" | "ru" | "ur" | "auto";

/** Where transcription runs: on this device, on a Whisper server the user runs
 *  (audio stays on their network), or on a provider's cloud API. */
export type TranscriptionProvider = "local" | "self_hosted" | "cloud";

/** Which engine a transcription base URL implies — the TypeScript mirror of
 *  `classify_transcription_provider` (src-tauri/src/config.rs:86), kept rule
 *  for rule with it.
 *
 *  The UI must never claim "your own server, on your network" because a
 *  dropdown says `self_hosted`: only the host says where the audio actually
 *  goes. Blank → `"local"`; loopback, an RFC 1918 range, a `.local`/`.internal`
 *  suffix or a bare single-label host → `"self_hosted"`; anything else —
 *  including a URL we can't read a host out of — → `"cloud"`, the conservative
 *  side, since cloud is the mode whose copy warns that audio leaves the device. */
export function classifyTranscriptionProvider(baseUrl: string): TranscriptionProvider {
  const url = baseUrl.trim();
  if (url === "") return "local";
  const host = hostOf(url);
  return host !== "" && isPrivateHost(host) ? "self_hosted" : "cloud";
}

/** Best-effort host extraction — scheme, path, userinfo and port stripped.
 *  `""` when no plausible host can be read (malformed URL). */
function hostOf(url: string): string {
  const scheme = url.indexOf("://");
  const afterScheme = scheme === -1 ? url : url.slice(scheme + 3);
  const authority = afterScheme.split(/[/?#]/)[0];
  const at = authority.lastIndexOf("@");
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  let host: string;
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]"); // [::1]:8000
    if (end === -1) return "";
    host = hostPort.slice(1, end);
  } else if ((hostPort.match(/:/g) ?? []).length > 1) {
    host = hostPort; // bare IPv6 literal, e.g. ::1
  } else {
    host = hostPort.split(":")[0];
  }
  if (host === "" || /\s/.test(host)) return "";
  return host.toLowerCase();
}

/** Whether a host names a machine on the user's own network. */
function isPrivateHost(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    // Not a valid address at all — Rust's parse fails here too, and a
    // dotted name is never private.
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets;
    return (
      a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    );
  }
  // Only loopback counts for IPv6, exactly as `Ipv6Addr::is_loopback` does.
  if (host.includes(":")) return host === "::1" || /^(0+:){7}0*1$/.test(host);
  return (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  );
}

export interface WhisperModelInfo {
  key: string;
  label: string;
  size: string;
  downloaded: boolean;
}

export type AppTheme = "dark" | "light" | "cream" | "navy" | "laghari" | "system";

export interface AppConfig {
  python_service_url: string;
  default_prompt_template: PromptTemplate;
  auto_detect_meetings: boolean;
  ollama_model: string;
  summary_language: string;
  theme: string;
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
  /** Which transcription engine Settings is configured for. Older configs are
   *  classified from `transcription_base_url` when Rust loads them. */
  transcription_provider: TranscriptionProvider;
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
  /** Daily OS notification summarising due/overdue to-dos (`reminders.rs`).
   *  Distinct from `meeting_reminder_enabled` (the pre-meeting alert). Defaults
   *  to true: it shipped ungated, so this preserves existing behaviour. */
  todo_digest_enabled: boolean;
  /** Local hour (0–23) the daily to-do digest fires. Default 9. */
  todo_digest_hour: number;
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
  /** This build can launch the app-managed Ollama sidecar. */
  ollama_sidecar_available?: boolean;
  /** Managed Ollama version, when it can be resolved. */
  ollama_version?: string | null;
}

/** Exact managed Ollama engine/model choice disclosed before download. */
export interface OllamaInstallPlan {
  schema_version: number;
  engine_name: string;
  engine_version: string;
  binary_path: string;
  bundled: boolean;
  models_dir: string;
  tier_profile_id: string;
  tier_display_name: string;
  chat_tag: string;
  chat_size_bytes: number;
  embed_tag: string;
  embed_size_bytes: number;
  chat_installed: boolean;
  embed_installed: boolean;
  mlx: boolean;
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
  state: "stopped" | "starting" | "ready" | "running" | "error";
  profile_id: string | null;
  detail: string;
}

export interface ModelDownloadStatus {
  profile_id: string;
  state:
    | "idle"
    | "queued"
    | "preparing"
    | "downloading"
    | "verifying"
    | "ready"
    | "failed"
    | "error";
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

// ---- Workspaces ----

/** Filesystem roots searched automatically for every workspace run. */
export interface ContextSources {
  vault_path: string;
  projects_root: string;
}

/** Aggregate status of the local vault/project context index. */
export interface ContextIndexStatus {
  vault_docs: number;
  project_docs: number;
  changed: number;
  embedding_errors: number;
  last_synced_at: string;
}

/** A user-defined collection used only to organize meetings. */
export interface Folder {
  id: number;
  name: string;
  color: string;
  instructions: string;
  created_at: string;
  updated_at: string;
}

/** A folder plus its number of explicitly filed meetings. */
export interface FolderSummary {
  folder: Folder;
  meeting_count: number;
}

/** Which folder contains a meeting. `folder_id === null` means explicitly unfiled. */
export interface MeetingFolder {
  meeting_id: number;
  folder_id: number | null;
  folder_name: string;
}

/** The folder proposed for a meeting, with the evidence. */
export interface FolderSuggestion {
  folder_id: number;
  folder_name: string;
  related_meeting_count: number;
  shared_attendee_count: number;
}

/** A long-lived project container for meeting work. */
export interface Workspace {
  id: number;
  name: string;
  engine: string;
  model: string;
  network_allowed: boolean;
  instructions: string;
  color: string;
  created_at: string;
  updated_at: string;
}

/** A workspace plus the counts shown on its home-screen card. */
export interface WorkspaceSummary {
  workspace: Workspace;
  queued_task_count: number;
  needs_you_count: number;
  running_task_count: number;
  awaiting_review_count: number;
  approved_task_count: number;
  total_task_count: number;
  meeting_count: number;
  folder_count: number;
}

/** Which workspace a meeting's to-dos flow into. `workspace_id === null` = "not a project"; no row = undecided. */
export interface MeetingWorkspaceBinding {
  meeting_id: number;
  workspace_id: number | null;
  workspace_name: string;
}

/** The workspace the graph proposes for a meeting, with the evidence. */
export interface WorkspaceSuggestion {
  workspace_id: number;
  workspace_name: string;
  related_meeting_count: number;
  shared_attendee_count: number;
}

/** What would ground a drafted task, shown before it runs. */
export interface TaskGroundingPreview {
  related_meeting_count: number;
  latest_related_title: string;
  vault_hit_count: number;
  top_vault_label: string;
  project_hit_count: number;
}

/** One meeting, folder, or file made available to a workspace. */
export interface WorkspaceContextItem {
  id: number;
  workspace_id: number;
  kind: string;
  value: string;
  label: string;
  created_at: string;
}

/** A queued unit of work inside a workspace. */
export interface WorkspaceTask {
  id: number;
  workspace_id: number;
  title: string;
  details: string;
  capability: string;
  status: string;
  source_meeting_id: number | null;
  /** Resolved at read time; empty when the task has no source meeting. */
  source_meeting_title: string;
  /** The to-do this task was pushed from, when it came from the board. */
  action_item_id: number | null;
  /** 1 for the first run; incremented by every rejection. */
  attempt: number;
  /** One line per rejection, oldest first. Appended to the brief on re-run. */
  rejection_notes: string[];
  /** Whether the autopilot may pick up this task. Manual Run is always available. */
  agent_eligible: boolean;
  created_at: string;
  updated_at: string;
}

/** Which agent and skills a queued task will run with, and why. */
export interface TaskStaffing {
  /** "automatic" | "manual" */
  mode: string;
  agent_id: number | null;
  skill_ids: number[];
  /** Selection explanation or a machine-readable baseline capability. */
  reason: string;
  resolved_at: string;
}

/** One execution attempt for a workspace task. */
export interface WorkspaceRun {
  id: number;
  workspace_id: number;
  task_id: number;
  engine: string;
  status: string;
  log: string;
  report: string;
  error: string;
  started_at: string;
  finished_at: string;
}

/** A file produced by a workspace run. */
export interface WorkspaceArtifact {
  id: number;
  workspace_id: number;
  run_id: number;
  name: string;
  path: string;
  created_at: string;
}

/** Runtime availability information for a workspace execution engine. */
export interface WorkspaceEngine {
  id: string;
  label: string;
  available: boolean;
  version: string;
  detail: string;
}

/** A reusable skill or agent role available to workspaces. */
export interface WorkspaceAddon {
  id: number;
  /** "skill" | "agent" */
  kind: string;
  slug: string;
  name: string;
  description: string;
  /** Markdown instructions injected into the brief. */
  instructions: string;
  builtin: boolean;
  created_at: string;
}

/** The complete data needed by the workspace detail screen. */
export interface WorkspaceDetail {
  workspace: Workspace;
  context_items: WorkspaceContextItem[];
  addons: WorkspaceAddon[];
  tasks: WorkspaceTask[];
  artifacts: WorkspaceArtifact[];
}

export interface ProjectOverview {
  workspace_id: number;
  summary: string;
  generated_at: string;
  source_meeting_count: number;
  stale: boolean;
}

export interface FolderOverview {
  folder_id: number;
  summary: string;
  generated_at: string;
  source_meeting_count: number;
  stale: boolean;
}

/** A related meeting surfaced under a note, with the reason it matched. */
export interface RelatedMeetingRef {
  meeting_id: number;
  title: string;
  recorded_at: string;
  reason: string;
}
