/**
 * Typed wrappers around Tauri's `invoke` IPC.
 * Every function maps 1:1 to a Rust command in src-tauri/src/commands.rs.
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ActionItem,
  Meeting,
  MeetingStats,
  PersonProfile,
  ManagedLlmStatus,
  ModelDownloadStatus,
  OnboardingState,
  RegistrationState,
  SetupStatus,
  AppConfig,
  AskMessage,
  AskResponse,
  CalendarAccount,
  CalendarConfig,
  CalendarEvent,
  ChatMessage,
  ChatTurn,
  GraphData,
  HealthResponse,
  Tag,
  TemplateInfo,
  WeeklyBriefing,
  WhisperModelInfo,
} from "../types";

// ---- Recording ----

export function startRecording(): Promise<void> {
  return invoke("start_recording");
}

export interface StopRecordingResult {
  system_path: string;
  mic_path: string | null;
  warning: string | null;
}

export function stopRecording(): Promise<StopRecordingResult> {
  return invoke("stop_recording");
}

/** Bring the main window to the front (from the floating recording bubble). */
export function focusMainWindow(): Promise<void> {
  return invoke("focus_main_window");
}

/** Stop recording from the floating bubble. Routed through Rust (which emits the
 *  same `tray-toggle-recording` the tray/hotkey use + focuses the app) because a
 *  JS emit from the separate bubble webview doesn't reliably reach the minimized
 *  main window. */
export function bubbleStopRecording(): Promise<void> {
  return invoke("bubble_stop_recording");
}

/** Drag the floating bubble. Rust focuses the (unfocused) bubble window first —
 *  macOS won't drag an unfocused window — then starts the native window drag. */
export function bubbleStartDrag(): Promise<void> {
  return invoke("bubble_start_drag");
}

/** Current recording loudness (0..1) — RMS of the last ~120 ms of audio. Polled
 *  by the recording view to drive the live waveform. */
export function getAudioLevel(): Promise<number> {
  return invoke("get_audio_level");
}

/** Per-channel recording loudness as [system "Them", mic "Me"] (0..1 each).
 *  Polled by the recording pill so each waveform tracks its own speaker. */
export function getAudioLevels(): Promise<[number, number]> {
  return invoke("get_audio_levels");
}

/** Expand/collapse the notch-docked expressive island (hover-driven). */
export function setRecordingBubbleExpanded(expanded: boolean): Promise<void> {
  return invoke("set_recording_bubble_expanded", { expanded });
}

/** Seconds since the current recording started (0 when idle). Polled once a
 *  second by the floating bubble's elapsed timer. */
export function getRecordingElapsed(): Promise<number> {
  return invoke("get_recording_elapsed");
}

// ---- Processing ----

/** Transcribe + summarize a fresh recording. Resolves `null` when the recording
 *  contained no speech and was auto-discarded (no typed notes). */
export function transcribeAndSummarize(
  audioFilePath: string,
  templateName?: string,
  userNotes?: string,
): Promise<Meeting | null> {
  return invoke("transcribe_and_summarize", {
    audioPath: audioFilePath,
    template: templateName ?? "general",
    userNotes: userNotes ?? null,
  });
}

/** Retry transcription + summary for a "pending" meeting whose audio was kept
 *  because the ML service was unreachable at stop time. On success the meeting
 *  is filled in and the audio deleted; on failure the audio is kept to retry.
 *  Resolves `null` when the recording contained no speech and was
 *  auto-discarded. */
export function transcribeMeeting(id: number): Promise<Meeting | null> {
  return invoke("transcribe_meeting", { id });
}

/** Retry deletion of an encrypted recording whose transcription already saved. */
export function retryRecordingCleanup(id: number): Promise<Meeting> {
  return invoke("retry_recording_cleanup", { id });
}

/** Save a just-finished recording as a meeting WITHOUT transcribing, and return
 *  it. The background queue then transcribes it via `transcribeMeeting`, so the
 *  UI is free to record the next meeting immediately (back-to-back meetings). */
export function enqueueRecording(
  audioFilePath: string,
  templateName?: string,
  userNotes?: string,
): Promise<Meeting> {
  return invoke("enqueue_recording", {
    audioPath: audioFilePath,
    template: templateName ?? "general",
    userNotes: userNotes ?? null,
  });
}

/** Import a local audio file (.m4a/.mp3/.wav), transcribe as single track,
 *  summarize, and return the new Meeting. */
export function importAudio(
  filePath: string,
  template?: string,
): Promise<Meeting> {
  return invoke("import_audio", {
    filePath,
    template: template ?? null,
  });
}

/** Open a native file dialog to pick an audio file for import
 *  (.m4a, .mp3, .wav). Returns the absolute path, or null if cancelled. */
export function pickAudioFile(): Promise<string | null> {
  return invoke("pick_audio_file");
}

/** "Structure with AI": turn a standalone note's rough text into structured
 *  notes + extracted action items (they flow into To-dos, the graph, and Ask).
 *  Preserves the raw text in the transcript. Returns the updated note. */
export function structureNote(id: number, template?: string): Promise<Meeting> {
  return invoke("structure_note", { id, template: template ?? null });
}

export function resummarizeMeeting(
  id: number,
  templateName: string,
  language?: string,
): Promise<Meeting> {
  return invoke("resummarize_meeting", {
    id,
    template: templateName,
    language: language ?? null,
  });
}

/** Ask a grounded question about a meeting; resolves to the model's answer. */
export function chatWithMeeting(id: number, question: string): Promise<string> {
  return invoke("chat_with_meeting", { id, question });
}

/** Streaming chat: calls `onToken` with each answer delta as it arrives, and
 *  resolves with the full answer. Uses a Tauri Channel (maps to the Rust
 *  `on_token` param). */
export function chatWithMeetingStream(
  id: number,
  question: string,
  onToken: (token: string) => void,
): Promise<string> {
  const channel = new Channel<string>();
  channel.onmessage = onToken;
  return invoke("chat_with_meeting_stream", { id, question, onToken: channel });
}

/** Load a meeting's saved chat history (oldest first). */
export function getChatMessages(id: number): Promise<ChatMessage[]> {
  return invoke("get_chat_messages", { id });
}

/** Delete a meeting's chat history. */
export function clearChat(id: number): Promise<void> {
  return invoke("clear_chat", { id });
}

/** Replace a meeting's user notes (the live notepad text). */
export function updateMeetingNotes(id: number, notes: string): Promise<void> {
  return invoke("update_meeting_notes", { id, notes });
}

/** Create a standalone note (a meeting with no recording). Resolves to the new note. */
export function createNote(title: string, body: string): Promise<Meeting> {
  return invoke("create_note", { title, body });
}

/** Overwrite a meeting's summary text with a user edit. */
export function updateMeetingSummary(id: number, summary: string): Promise<void> {
  return invoke("update_meeting_summary", { id, summary });
}

/** Pin or unpin a meeting (controls list ordering). */
export function setMeetingPinned(id: number, pinned: boolean): Promise<void> {
  return invoke("set_meeting_pinned", { id, pinned });
}

/** Lock or unlock a meeting (privacy lock). */
export function setMeetingLocked(id: number, locked: boolean): Promise<void> {
  return invoke("set_meeting_locked", { id, locked });
}

/** Archive or unarchive a meeting (sidebar Archive bin). Archiving also unpins. */
export function setMeetingArchived(id: number, archived: boolean): Promise<void> {
  return invoke("set_meeting_archived", { id, archived });
}

/** Permanently delete a meeting and its chat history. */
export function deleteMeeting(id: number): Promise<void> {
  return invoke("delete_meeting", { id });
}

export function updateAttendees(
  id: number,
  attendees: string[],
): Promise<void> {
  return invoke("update_attendees", { id, attendees });
}

/** Replace a meeting's tags. */
export function updateMeetingTags(id: number, tags: Tag[]): Promise<void> {
  return invoke("update_meeting_tags", { id, tags });
}

/** Save summary text to a user-chosen .md file. Resolves to the saved path,
 *  or null if the user cancelled the save dialog. */
export function exportSummary(
  defaultName: string,
  contents: string,
): Promise<string | null> {
  return invoke("export_summary", { defaultName, contents });
}

/** Save a self-contained meeting document to a user-chosen .html file.
 *  Resolves to the saved path, or null if the user cancelled. */
export function exportHtml(
  defaultName: string,
  contents: string,
): Promise<string | null> {
  return invoke("export_html", { defaultName, contents });
}

/** Export one meeting to a self-contained .adversaria.json bundle (save dialog).
 *  Returns the saved path, or null if cancelled. */
export function exportMeetingBundle(id: number): Promise<string | null> {
  return invoke("export_meeting_bundle", { id });
}

/** Import a meeting from a .adversaria.json bundle (file picker).
 *  Returns the new Meeting, or null if cancelled. */
export function importMeetingBundle(): Promise<Meeting | null> {
  return invoke("import_meeting_bundle");
}

/** Back up all meetings (+ action items + Ask history) to one JSON file.
 *  Returns the saved path, or null if cancelled. */
export function exportAllMeetings(): Promise<string | null> {
  return invoke("export_all_meetings");
}

/** Restore all meetings from a backup file. Returns the count imported, or null
 *  if cancelled. */
export function importAllMeetings(): Promise<number | null> {
  return invoke("import_all_meetings");
}

/** Deliberately export rotated diagnostics with paths/contact/content redacted. */
export function exportRedactedDiagnostics(): Promise<string | null> {
  return invoke("export_redacted_diagnostics");
}

// ---- Meetings ----

export function getMeetings(): Promise<Meeting[]> {
  return invoke("get_meetings");
}

export function getMeeting(id: number): Promise<Meeting> {
  return invoke("get_meeting", { id });
}

/** Build a {nodes, edges} knowledge graph of all meetings (structured data, zero LLM). */
export function getMeetingGraph(): Promise<GraphData> {
  return invoke("get_meeting_graph");
}

/** Collapse diarized "Speaker N" labels back into "Them" for one saved meeting
 *  (retroactive fix for over-counted diarization — irreversible, the audio is
 *  gone). Returns the refreshed meeting. */
export function mergeMeetingSpeakers(meetingId: number): Promise<Meeting> {
  return invoke("merge_meeting_speakers", { meetingId });
}

/** Set or clear a meeting's source URL (e.g. the YouTube link of a watched video). */
export function updateMeetingLink(id: number, link: string): Promise<void> {
  return invoke("update_meeting_link", { id, link });
}

/** Export the meeting graph to the configured second-brain folder (markdown
 *  notes + index.md + graph.json). Returns the number of notes written. */
export function exportSecondBrain(): Promise<number> {
  return invoke("export_second_brain");
}

/** Speech statistics for one meeting, computed from stored transcript turns
 *  (word-count fallbacks when the meeting predates turn timing). */
export function getMeetingStats(id: number): Promise<MeetingStats> {
  return invoke("get_meeting_stats", { id });
}

/** Ask a question across ALL meetings; returns the answer + source meetings.
 *  `history` carries the recent conversation turns so follow-ups are resolved
 *  (e.g. "which company is he in" → "…is Wajee in") before retrieval. */
export function askAllMeetings(
  question: string,
  history: ChatTurn[] = [],
): Promise<AskResponse> {
  return invoke("ask_all_meetings", { question, history });
}

/** Load the persisted cross-meeting Ask conversation (survives navigation). */
export function getAskConversation(): Promise<AskMessage[]> {
  return invoke("get_ask_conversation");
}

/** Fetch the weekly executive briefing for a week offset (0 = this week). */
export function weeklyBriefing(offset: number): Promise<WeeklyBriefing> {
  return invoke("weekly_briefing", { offset });
}

/** Clear the persisted Ask conversation ("New conversation"). */
export function clearAskConversation(): Promise<void> {
  return invoke("clear_ask_conversation");
}

// ---- Config ----

export function getConfig(): Promise<AppConfig> {
  return invoke("get_config");
}

export function updateConfig(config: AppConfig): Promise<void> {
  return invoke("update_config", { config });
}

// ---- Templates ----

/** List available prompt templates. */
export function listTemplates(): Promise<TemplateInfo[]> {
  return invoke("list_templates");
}

/** Fetch one template's raw markdown. */
export function getTemplate(name: string): Promise<string> {
  return invoke("get_template", { name });
}

/** Create or overwrite a template. */
export function saveTemplate(name: string, content: string): Promise<void> {
  return invoke("save_template", { name, content });
}

/** Delete a template. */
export function deleteTemplate(name: string): Promise<void> {
  return invoke("delete_template", { name });
}

// ---- Health ----

export function checkServiceHealth(): Promise<HealthResponse> {
  return invoke("check_service_health");
}

/** Probe a cloud LLM provider's /models endpoint to validate base URL + key. */
export function testLlmConnection(baseUrl: string, apiKey: string): Promise<string> {
  return invoke("test_llm_connection", { baseUrl, apiKey });
}

/**
 * Prompt for native biometric auth (Touch ID / Windows Hello), OS password as
 * fallback. Resolves true on success, false on cancel/failure/no-sensor. Used to
 * unlock locked meetings; callers fall back to the PIN when this isn't true.
 */
export function biometricAuthenticate(reason: string): Promise<boolean> {
  return invoke("biometric_authenticate", { reason });
}

// ---- Registration and no-terminal setup ----

export function getRegistrationState(): Promise<RegistrationState> {
  return invoke("get_registration_state");
}

export function submitRegistration(
  name: string,
  email: string,
  consent: boolean,
): Promise<RegistrationState> {
  return invoke("submit_registration", { name, email, consent });
}

export function retryRegistration(): Promise<RegistrationState> {
  return invoke("retry_registration");
}

export function getOnboardingState(): Promise<OnboardingState> {
  return invoke("get_onboarding_state");
}

export function completeOnboardingStep(
  step: string,
  selectedModelProfile: string | null = null,
  setupComplete = false,
): Promise<OnboardingState> {
  return invoke("complete_onboarding_step", {
    step,
    selectedModelProfile,
    setupComplete,
  });
}

export function getSetupStatus(): Promise<SetupStatus> {
  return invoke("get_setup_status");
}

export function startModelDownload(profileId: string): Promise<ModelDownloadStatus> {
  return invoke("start_model_download", { profileId });
}

export function getModelDownloadStatus(profileId: string): Promise<ModelDownloadStatus> {
  return invoke("get_model_download_status", { profileId });
}

export function getManagedLlmStatus(): Promise<ManagedLlmStatus> {
  return invoke("get_managed_llm_status");
}

export function startManagedLlm(profileId: string): Promise<ManagedLlmStatus> {
  return invoke("start_managed_llm", { profileId });
}

export function stopManagedLlm(): Promise<void> {
  return invoke("stop_managed_llm");
}

/** Switch the on-device model after setup (Settings picker). Persists the new
 * pinned profile and restarts the managed runtime on it. */
export function setLocalModelProfile(profileId: string): Promise<ManagedLlmStatus> {
  return invoke("set_local_model_profile", { profileId });
}

export function testLocalSetup(): Promise<string> {
  return invoke("test_local_setup");
}

export function testCloudSetup(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<string> {
  return invoke("test_cloud_setup", { baseUrl, apiKey, model });
}

// ---- On-device Whisper models ----

/** Curated on-device Whisper models with download status (for the picker). */
export function listWhisperModels(): Promise<WhisperModelInfo[]> {
  return invoke("list_whisper_models");
}

/** Pre-download (cache) an on-device Whisper model so it's ready before recording. */
export function downloadWhisperModel(model: string): Promise<void> {
  return invoke("download_whisper_model", { model });
}

// ---- Action items ----

/** Return action items. Pass `null` to get all items across all meetings. */
export function getActionItems(meetingId: number | null): Promise<ActionItem[]> {
  return invoke("get_action_items", { meetingId: meetingId ?? null });
}

/** Toggle the done flag on a single action item. */
export function setActionItemDone(id: number, done: boolean): Promise<void> {
  return invoke("set_action_item_done", { id, done });
}

/** Update the assignee and/or due date on a single action item. */
export function updateActionItem(
  id: number,
  assignee: string,
  due: string,
): Promise<void> {
  return invoke("update_action_item", { id, assignee, due });
}

// ---- Calendar ----

export function calendarSetCredentials(
  provider: string,
  clientId: string,
  clientSecret: string | null,
): Promise<void> {
  return invoke("calendar_set_credentials", { provider, clientId, clientSecret });
}

export function calendarHasCredentials(provider: string): Promise<boolean> {
  return invoke("calendar_has_credentials", { provider });
}

export function calendarConnect(provider: string): Promise<CalendarAccount> {
  return invoke("calendar_connect", { provider });
}

export function calendarDisconnect(provider: string): Promise<void> {
  return invoke("calendar_disconnect", { provider });
}

export function calendarStatus(): Promise<CalendarConfig> {
  return invoke("calendar_status");
}

export function calendarUpcomingEvents(
  windowMinutes: number,
): Promise<CalendarEvent[]> {
  return invoke("calendar_upcoming_events", { windowMinutes });
}

export function calendarEventAt(at: string): Promise<CalendarEvent | null> {
  return invoke("calendar_event_at", { at });
}

/** Enable/disable the macOS EventKit calendar provider. Triggers the
 *  macOS Calendar permission prompt when enabling. Returns the effective
 *  enabled state (false if permission was denied). */
export function calendarMacosEnable(enable: boolean): Promise<boolean> {
  return invoke("calendar_macos_enable", { enable });
}

/** Whether the macOS EventKit provider is enabled and has calendar access. */
export function calendarMacosStatus(): Promise<boolean> {
  return invoke("calendar_macos_status");
}

// ---- People profiles ----

/** Look up a person profile by name (case-insensitive, matches aliases too). */
export function getPerson(name: string): Promise<PersonProfile | null> {
  return invoke("get_person", { name });
}

/** Create or update a person profile. */
export function savePerson(p: {
  name: string;
  role: string;
  company: string;
  notes: string;
  aliases: string;
  email: string;
  phone: string;
  linkedin: string;
}): Promise<PersonProfile> {
  return invoke("save_person", p);
}
