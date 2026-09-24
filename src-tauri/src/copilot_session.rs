//! Durable, session-bound Live Copilot queue and answer execution.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;

use crate::commands::AppState;
use crate::copilot_live::{self, Decision, LiveCtl};
use crate::http_client::{CopilotAnswerRequest, CopilotFrame, GateRequest, GateResponse};
use crate::types::{
    CopilotAnswerEvent, CopilotCard, CopilotCitation, CopilotCommandAck, CopilotEgressPassage,
    CopilotFolderReadiness, CopilotLiveContext, CopilotPassage, CopilotSections, RecentCard,
};
use crate::types::{LiveExtractResponse, LiveState};

pub const MAX_QUESTION_CHARS: usize = 2000;
pub const MAX_CONTEXT_TURN_CHARS: usize = 600;
const MAX_CONTEXT_SPEAKER_PREFIX_CHARS: usize = 6;
pub const MAX_PASSAGE_TEXT_CHARS: usize = 600;
pub const MAX_PASSAGE_TITLE_CHARS: usize = 200;
pub const MAX_PASSAGE_SOURCE_CHARS: usize = 300;
pub const MAX_PERSONA_CHARS: usize = 400;
pub const MAX_CONTEXT_TURNS: usize = 4;
pub const MAX_CONTEXT_TURNS_LOCAL: usize = 8;
const MAX_RECENT_DIALOGUE_TURNS: usize = MAX_CONTEXT_TURNS_LOCAL + 1;
const AUTO_SOFT_GAP: Duration = Duration::from_secs(8);
const INTENT_WINDOW: Duration = Duration::from_secs(120);
pub const MAX_PASSAGES: usize = 3;
const ANSWER_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TERMINAL_WRITE_ATTEMPTS: u8 = 3;
const TERMINAL_OPEN: u8 = 0;
const TERMINAL_WRITING: u8 = 1;
const TERMINAL_WRITTEN: u8 = 2;
const SESSION_NOT_ACTIVE: &str = "Copilot session is no longer active";
const SESSION_FOLDER_MISMATCH: &str = "Copilot session does not match this folder";
const WEB_CONSENT_SAVE_FAILED: &str = "Could not save folder web consent";
const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
const DEEPSEEK_MODEL: &str = "deepseek-v4-flash";

/// Thread-safe state owned by the one `AppState.copilot` mutex.
#[derive(Default)]
pub struct CopilotState {
    pub session: Option<CopilotSession>,
}

/// Frozen work snapshot. Retry clones this record and changes only identity/time.
#[derive(Clone)]
pub struct CopilotJob {
    pub row_id: i64,
    pub session_id: String,
    pub card_id: u64,
    pub question: String,
    pub question_source: String,
    pub context_turns: Vec<String>,
    pub stated_figures: Vec<String>,
    pub trigger: String,
    pub asked_at_ms: u64,
    pub provider_frozen: String,
    pub folder_id: Option<i64>,
    pub web_search: bool,
    pub persona: Option<String>,
    pub header: Option<String>,
    pub standing_pack: Option<String>,
    pub recent_cards: Vec<RecentCard>,
    pub resolved_question: Option<String>,
    folder_terms: HashSet<String>,
    pack_frozen: bool,
    pub voice_samples: Vec<String>,
    pub previous_them: Option<String>,
    pub live_context: CopilotLiveContext,
    pub passages: Vec<CopilotPassage>,
    pub retrieval_ms: Option<u64>,
    pub model: Option<String>,
    pub llm_base_url: Option<String>,
    pub llm_api_key: Option<String>,
    pub retry_of: Option<u64>,
    pub reuse_passages: bool,
    validation_error: Option<String>,
    gate_needed: bool,
    policy_reason: &'static str,
    gate_request: Option<GateRequest>,
    announced: bool,
    terminal: Arc<TerminalGuard>,
}

#[derive(Debug, Default, PartialEq)]
struct FrozenLlmConfig {
    model: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
}

#[derive(Clone)]
struct TerminalSnapshot {
    status: String,
    reason: Option<String>,
    job: CopilotJob,
}

struct ActiveCard {
    job: CopilotJob,
    token: CancellationToken,
    answer_md: String,
    sections: CopilotSections,
    say_buffer: String,
    specifics_raw: Vec<String>,
    notes_raw: Vec<String>,
    next_raw: String,
    citations: Vec<CopilotCitation>,
    web_performed: u64,
    usage_seen: bool,
    frame_error: Option<String>,
    egress_bytes: usize,
    dispatched: bool,
    replay_request: Option<serde_json::Value>,
    replay_service: Option<serde_json::Value>,
}

/// Per-recording state. It is protected only by `AppState.copilot`.
pub struct CopilotSession {
    pub session_id: String,
    pub internal_epoch: u64,
    pub folder_id: Option<i64>,
    pub mode_at_start: String,
    pub started_at: Instant,
    pub live: LiveCtl,
    last_answer_finished: Option<Instant>,
    live_enabled_override: Option<bool>,
    pub token: CancellationToken,
    pub notify: Arc<Notify>,
    next_card_id: u64,
    active: Option<ActiveCard>,
    waiting: VecDeque<CopilotJob>,
    recent_norms: VecDeque<(String, HashSet<String>, Instant)>,
    recent_questions: VecDeque<String>,
    card_questions: Vec<String>,
    last_auto_asked: Option<Instant>,
    last_auto_source: Option<String>,
    pub mic_questions: bool,
    active_norm: Option<String>,
    terminal_jobs: HashMap<u64, TerminalSnapshot>,
    pub last_them: Option<String>,
    pub last_me: Option<String>,
    pub last_any: Option<String>,
    last_any_source: &'static str,
    recent_dialogue: VecDeque<DialogueTurn>,
    next_dialogue_seq: u64,
    fact_ledger: crate::copilot_facts::FactLedger,
    pending_them_chunks: Vec<String>,
    pending_me_chunks: Vec<String>,
    pub mode_override: Option<String>,
    live_context: CopilotLiveContext,
    folder_persona: Option<String>,
    header: Option<String>,
    voice_samples: Vec<String>,
    folder_web: bool,
    readiness: CopilotFolderReadiness,
    ready: watch::Sender<bool>,
    standing_pack: Option<String>,
    folder_terms: HashSet<String>,
}

#[derive(Clone)]
struct DialogueTurn {
    speaker: &'static str,
    text: String,
    /// Full turn bounded at [`MAX_QUESTION_CHARS`], kept for request
    /// selection: the 594-char context `text` can lose a question at the end
    /// of a long setup.
    full_text: String,
    /// Monotonically increasing position of this entry in dialogue history.
    seq: u64,
}

/// Atomic second line of defence around the database's guarded terminal update.
pub struct TerminalGuard {
    state: AtomicU8,
}

impl TerminalGuard {
    pub fn new() -> Self {
        Self {
            state: AtomicU8::new(TERMINAL_OPEN),
        }
    }

    pub fn begin_write(&self) -> bool {
        self.state
            .compare_exchange(
                TERMINAL_OPEN,
                TERMINAL_WRITING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    pub fn commit_write(&self) {
        let result = self.state.compare_exchange(
            TERMINAL_WRITING,
            TERMINAL_WRITTEN,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        debug_assert!(result.is_ok(), "terminal guard committed outside a write");
    }

    pub fn release_write(&self) {
        let result = self.state.compare_exchange(
            TERMINAL_WRITING,
            TERMINAL_OPEN,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        debug_assert!(result.is_ok(), "terminal guard released outside a write");
    }

    pub fn is_written(&self) -> bool {
        self.state.load(Ordering::SeqCst) == TERMINAL_WRITTEN
    }
}

impl Default for TerminalGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl CopilotSession {
    fn new(
        session_id: String,
        internal_epoch: u64,
        folder_id: Option<i64>,
        mode_at_start: String,
        folder_persona: Option<String>,
        folder_web: bool,
    ) -> Self {
        let readiness = CopilotFolderReadiness {
            session_id: session_id.clone(),
            folder_id,
            status: if folder_id.is_some() {
                "indexing"
            } else {
                "ready"
            }
            .into(),
            count: 0,
            pack_projects: 0,
            pack_chars: 0,
            pack_hash: String::new(),
            error: None,
        };
        let started_at = Instant::now();
        let enabled = mode_at_start != "no_ai";
        Self {
            live: LiveCtl {
                enabled,
                status: if enabled { "idle" } else { "off" }.into(),
                started_at,
                ..LiveCtl::default()
            },
            last_answer_finished: None,
            live_enabled_override: None,
            readiness,
            ready: watch::channel(folder_id.is_none()).0,
            standing_pack: None,
            folder_terms: HashSet::new(),
            session_id,
            internal_epoch,
            folder_id,
            mode_at_start,
            started_at,
            token: CancellationToken::new(),
            notify: Arc::new(Notify::new()),
            next_card_id: 1,
            active: None,
            waiting: VecDeque::new(),
            recent_norms: VecDeque::new(),
            recent_questions: VecDeque::new(),
            card_questions: Vec::new(),
            last_auto_asked: None,
            last_auto_source: None,
            mic_questions: false,
            active_norm: None,
            terminal_jobs: HashMap::new(),
            last_them: None,
            last_me: None,
            last_any: None,
            last_any_source: "Them",
            recent_dialogue: VecDeque::new(),
            next_dialogue_seq: 0,
            fact_ledger: crate::copilot_facts::FactLedger::default(),
            pending_them_chunks: Vec::new(),
            pending_me_chunks: Vec::new(),
            mode_override: None,
            live_context: CopilotLiveContext::default(),
            folder_persona,
            header: None,
            voice_samples: Vec::new(),
            folder_web,
        }
    }

    fn effective_mode(&self) -> &str {
        self.mode_override.as_deref().unwrap_or(&self.mode_at_start)
    }

    fn accepts_epoch(&self, epoch: u64) -> bool {
        self.internal_epoch == epoch
    }

    pub fn norm(text: &str) -> String {
        text.to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { ' ' })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn is_duplicate(&self, question: &str) -> bool {
        let normalized = Self::norm(question);
        self.is_in_progress(&normalized) || self.is_recent_intent(question)
    }

    fn is_recent_intent(&self, question: &str) -> bool {
        let normalized = Self::norm(question);
        let keywords = crate::copilot::extract_keywords(question);
        self.recent_norms.iter().any(|(norm, recent_keywords, at)| {
            at.elapsed() < INTENT_WINDOW
                && (norm == &normalized
                    || crate::copilot::keyword_jaccard(&keywords, recent_keywords) >= 0.6)
        })
    }

    fn auto_suppression(&self, question: &str, source: &str) -> Option<&'static str> {
        if source == "Me"
            && !question.contains('?')
            && self.last_auto_source.is_some()
            && self
                .last_auto_asked
                .is_some_and(|at| at.elapsed() < AUTO_SOFT_GAP)
        {
            Some("soft_gap")
        } else if self.is_recent_intent(question) {
            Some("same_intent")
        } else {
            None
        }
    }

    fn remember_question(&mut self, question: &str, source: &str, trigger: &str) {
        self.remember_card_question(question);
        let now = Instant::now();
        if self.recent_norms.len() == 32 {
            self.recent_norms.pop_front();
        }
        self.recent_norms.push_back((
            Self::norm(question),
            crate::copilot::extract_keywords(question),
            now,
        ));
        if self.recent_questions.len() == 3 {
            self.recent_questions.pop_front();
        }
        self.recent_questions.push_back(question.to_string());
        if trigger == "auto" {
            self.last_auto_asked = Some(now);
            self.last_auto_source = Some(source.to_string());
        }
    }

    fn is_in_progress(&self, normalized: &str) -> bool {
        self.active_norm.as_deref() == Some(normalized)
            || self
                .waiting
                .iter()
                .any(|job| Self::norm(&job.question) == normalized)
    }

    fn remember_card_question(&mut self, question: &str) {
        let normalized = Self::norm(question);
        if !self
            .card_questions
            .iter()
            .any(|text| Self::norm(text) == normalized)
        {
            self.card_questions.push(question.to_string());
        }
    }

    fn next_card_id(&mut self) -> u64 {
        let card_id = self.next_card_id;
        self.next_card_id += 1;
        card_id
    }

    fn push_dialogue_turn(&mut self, speaker: &'static str, text: &str) {
        self.fact_ledger.observe(speaker, text);
        let full_text = crate::copilot_provenance::truncate_word_boundary(text, MAX_QUESTION_CHARS);
        if full_text.is_empty() {
            return;
        }
        let text = crate::copilot_provenance::truncate_word_boundary(
            text,
            MAX_CONTEXT_TURN_CHARS - MAX_CONTEXT_SPEAKER_PREFIX_CHARS,
        );
        if text.is_empty() {
            return;
        }
        let seq = self.next_dialogue_seq;
        self.next_dialogue_seq += 1;
        self.recent_dialogue.push_back(DialogueTurn {
            speaker,
            text,
            full_text,
            seq,
        });
        while self.recent_dialogue.len() > MAX_RECENT_DIALOGUE_TURNS {
            self.recent_dialogue.pop_front();
        }
    }

    fn context_limit(&self) -> usize {
        if self.effective_mode() == "local" {
            MAX_CONTEXT_TURNS_LOCAL
        } else {
            MAX_CONTEXT_TURNS
        }
    }

    fn context_before(&self, question: &str) -> Vec<String> {
        let normalized = Self::norm(question);
        let mut turns: Vec<&DialogueTurn> = self.recent_dialogue.iter().collect();
        if turns
            .last()
            .is_some_and(|turn| Self::norm(&turn.text) == normalized)
        {
            turns.pop();
        }
        let start = turns.len().saturating_sub(self.context_limit());
        turns[start..]
            .iter()
            .map(|turn| format!("{}: {}", turn.speaker, turn.text))
            .collect()
    }

    fn previous_them_before(&self, question: &str) -> Option<String> {
        let normalized = Self::norm(question);
        self.recent_dialogue
            .iter()
            .rev()
            .find(|turn| turn.speaker == "Them" && Self::norm(&turn.text) != normalized)
            .map(|turn| turn.text.clone())
    }

    fn assemble_caption(&mut self, source: &str, text: &str, boundary: &str) -> Option<String> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        // Forced cuts are confirmed evidence too. Feed the extractor before
        // question-turn assembly can return early or truncate a long monologue.
        let speaker = if source == "them" { "Them" } else { "Me" };
        copilot_live::push_turn(
            &mut self.live,
            speaker,
            text,
            self.started_at.elapsed().as_millis() as u64,
        );
        let chunks = if source == "them" {
            &mut self.pending_them_chunks
        } else {
            &mut self.pending_me_chunks
        };
        chunks.push(text.to_string());
        if boundary == "forced" {
            return None;
        }
        let joined = chunks.join(" ");
        chunks.clear();
        let joined = crate::copilot_provenance::truncate_word_boundary(&joined, MAX_QUESTION_CHARS);
        (!joined.is_empty()).then_some(joined)
    }

    fn accept_waiting(&mut self, job: CopilotJob) -> Vec<CopilotJob> {
        let replaced = self.waiting.drain(..).collect();
        self.waiting.push_back(job);
        replaced
    }

    fn activate_waiting(&mut self) -> Option<(CopilotJob, CancellationToken)> {
        if !self
            .waiting
            .front()
            .is_some_and(|job| job.announced || job.gate_needed)
        {
            return None;
        }
        let job = self.waiting.pop_front()?;
        let norm = Self::norm(&job.question);
        let token = self.token.child_token();
        self.active_norm = Some(norm.clone());
        self.active = Some(ActiveCard {
            job: job.clone(),
            token: token.clone(),
            answer_md: String::new(),
            sections: CopilotSections::default(),
            say_buffer: String::new(),
            specifics_raw: Vec::new(),
            notes_raw: Vec::new(),
            next_raw: String::new(),
            citations: Vec::new(),
            web_performed: 0,
            usage_seen: false,
            frame_error: None,
            egress_bytes: 0,
            dispatched: false,
            replay_request: None,
            replay_service: None,
        });
        Some((job, token))
    }

    fn remember_terminal(&mut self, status: &str, reason: Option<&str>, active: &ActiveCard) {
        if active.job.announced && matches!(status, "done" | "error" | "cancelled") {
            self.terminal_jobs.insert(
                active.job.card_id,
                TerminalSnapshot {
                    status: status.to_string(),
                    reason: reason.map(str::to_string),
                    job: active.job.clone(),
                },
            );
        }
    }

    fn take_active(
        &mut self,
        card_id: u64,
        status: &str,
        reason: Option<&str>,
    ) -> Option<ActiveCard> {
        if self.active.as_ref().map(|active| active.job.card_id) != Some(card_id) {
            return None;
        }
        let active = self.active.take()?;
        self.active_norm = None;
        self.remember_terminal(status, reason, &active);
        Some(active)
    }
}

struct QueuedCard {
    ack: CopilotCommandAck,
    heard: CopilotCard,
    replaced: Vec<CopilotJob>,
    notify: Arc<Notify>,
}

#[derive(Clone)]
struct TerminalAction {
    job: CopilotJob,
    status: String,
    reason: Option<String>,
    answer_md: String,
    sections: CopilotSections,
    say_buffer: String,
    specifics_raw: Vec<String>,
    notes_raw: Vec<String>,
    next_raw: String,
    citations: Vec<CopilotCitation>,
    web_performed: u64,
    egress_bytes: usize,
    dispatched: bool,
    error: Option<String>,
    emit: bool,
    attempts: u8,
    replay_request: Option<serde_json::Value>,
    replay_service: Option<serde_json::Value>,
}

impl TerminalAction {
    fn waiting(job: CopilotJob, reason: &str) -> Self {
        Self {
            job,
            status: "skipped".to_string(),
            reason: Some(reason.to_string()),
            answer_md: String::new(),
            sections: CopilotSections::default(),
            say_buffer: String::new(),
            specifics_raw: Vec::new(),
            notes_raw: Vec::new(),
            next_raw: String::new(),
            citations: Vec::new(),
            web_performed: 0,
            egress_bytes: 0,
            dispatched: false,
            error: None,
            emit: true,
            attempts: 0,
            replay_request: None,
            replay_service: None,
        }
    }

    fn active(
        active: ActiveCard,
        status: &str,
        reason: Option<&str>,
        error: Option<String>,
    ) -> Self {
        Self {
            job: active.job,
            status: status.to_string(),
            reason: reason.map(str::to_string),
            answer_md: active.answer_md,
            sections: active.sections,
            say_buffer: active.say_buffer,
            specifics_raw: active.specifics_raw,
            notes_raw: active.notes_raw,
            next_raw: active.next_raw,
            citations: active.citations,
            web_performed: active.web_performed,
            egress_bytes: active.egress_bytes,
            dispatched: active.dispatched,
            error,
            emit: true,
            attempts: 0,
            replay_request: active.replay_request,
            replay_service: active.replay_service,
        }
    }

    fn web_requested(&self) -> bool {
        self.dispatched && self.job.web_search
    }
}

#[derive(Default)]
struct FolderSnapshot {
    mode: String,
    persona: Option<String>,
    web: bool,
    header: Option<String>,
    voice_samples: Vec<String>,
}

fn freeze_folder_context(
    purpose: &str,
    profile: &str,
    voice_1: &str,
    voice_2: &str,
) -> (Option<String>, Vec<String>) {
    use crate::copilot_provenance::truncate_utf8_bytes;
    let mut parts = Vec::new();
    if !purpose.trim().is_empty() {
        parts.push(format!("Purpose: {}", purpose.trim()));
    }
    if !profile.trim().is_empty() {
        parts.push(format!("About Me: {}", profile.trim()));
    }
    let header = (!parts.is_empty()).then(|| truncate_utf8_bytes(&parts.join("\n"), 1_600));
    let voice_samples = [voice_1, voice_2]
        .into_iter()
        .map(str::trim)
        .filter(|sample| !sample.is_empty())
        .map(|sample| truncate_utf8_bytes(sample, 600))
        .collect();
    (header, voice_samples)
}

fn folder_snapshot(folder_id: Option<i64>) -> Result<FolderSnapshot, String> {
    let Some(folder_id) = folder_id else {
        return Ok(FolderSnapshot {
            mode: "no_ai".to_string(),
            ..FolderSnapshot::default()
        });
    };
    let conn = crate::storage::connect_for_sync()
        .map_err(|error| format!("Database connection error: {error}"))?;
    let folder = crate::storage::get_folder_on(&conn, folder_id)
        .map_err(|error| format!("Could not read folder: {error}"))?
        .ok_or_else(|| "Folder not found".to_string())?;
    let persona =
        crate::copilot_provenance::truncate_word_boundary(&folder.instructions, MAX_PERSONA_CHARS);
    let web = crate::storage::folder_copilot_web(&conn, folder_id)
        .map_err(|error| format!("Could not read folder web consent: {error}"))?;
    let (header, voice_samples) = freeze_folder_context(
        &folder.purpose,
        &folder.profile,
        &folder.voice_1,
        &folder.voice_2,
    );
    Ok(FolderSnapshot {
        mode: valid_mode(&folder.copilot_mode)
            .unwrap_or("no_ai")
            .to_string(),
        persona: (!persona.is_empty()).then_some(persona),
        web,
        header,
        voice_samples,
    })
}

fn valid_mode(mode: &str) -> Option<&str> {
    matches!(mode, "no_ai" | "local" | "claude" | "deepseek").then_some(mode)
}

/// Retire any old session, persist the new durable row, install it, then launch
/// exactly one consumer bound to the new UUID.
pub fn start_session(
    app: &AppHandle,
    internal_epoch: u64,
    folder_id: Option<i64>,
) -> Result<String, String> {
    retire_current_session(app, "session_ended");
    let snapshot = folder_snapshot(folder_id)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now().to_rfc3339();
    crate::storage::insert_copilot_session(&session_id, folder_id, &snapshot.mode, &started_at)
        .map_err(|error| format!("Could not create Copilot session: {error}"))?;

    let mut session = CopilotSession::new(
        session_id.clone(),
        internal_epoch,
        folder_id,
        snapshot.mode,
        snapshot.persona,
        snapshot.web,
    );
    session.header = snapshot.header;
    session.voice_samples = snapshot.voice_samples;
    let notify = session.notify.clone();
    let token = session.token.clone();
    let readiness = session.readiness.clone();
    let ready = session.ready.subscribe();
    let warm_local = session.effective_mode() != "no_ai";
    app.state::<AppState>().copilot.lock().unwrap().session = Some(session);
    let _ = app.emit("copilot-folder-ready", &readiness);
    if let Some(folder_id) = folder_id {
        let task_app = app.clone();
        let task_id = session_id.clone();
        tokio::task::spawn_blocking(move || {
            let result = (|| -> anyhow::Result<_> {
                let count = crate::folder_sources::sync_folder_sources(folder_id)?;
                let conn = crate::storage::connect_for_sync()?;
                let pack = crate::folder_sources::build_pack(&conn, folder_id)?;
                let terms = crate::storage::get_folder_terms_on(&conn, folder_id)?
                    .into_iter()
                    .collect();
                Ok((conn, count, pack, terms))
            })();
            let state = task_app.state::<AppState>();
            let mut copilot = state.copilot.lock().unwrap();
            let Some(session) = readiness_session(&mut copilot, &task_id, internal_epoch) else {
                return;
            };
            let result = result.and_then(|(conn, count, pack, terms)| {
                crate::storage::set_session_pack_on(&conn, &task_id, &pack.text, &pack.hash)?;
                Ok((count, pack, terms))
            });
            match result {
                Ok((count, pack, terms)) => {
                    session.readiness.status = "ready".into();
                    session.readiness.count = count;
                    session.readiness.pack_projects = pack.projects;
                    session.readiness.pack_chars = pack.text.chars().count();
                    session.readiness.pack_hash = pack.hash;
                    session.standing_pack = (!pack.text.is_empty()).then_some(pack.text);
                    session.folder_terms = terms;
                }
                Err(error) => {
                    session.readiness.status = "error".into();
                    session.readiness.error = Some(error.to_string());
                }
            }
            session.ready.send_replace(true);
            let _ = task_app.emit("copilot-folder-ready", &session.readiness);
        });
    }
    if warm_local {
        let task_app = app.clone();
        tokio::spawn(async move {
            match frozen_local_config() {
                Ok(config) => {
                    let state = task_app.state::<AppState>();
                    match state
                        .client
                        .copilot_warm(
                            config.model.as_deref().unwrap_or(""),
                            config.base_url.as_deref(),
                            config.api_key.as_deref(),
                        )
                        .await
                    {
                        Ok(result) => eprintln!(
                            "[copilot] warm ok={} ms={} detail={:?}",
                            result.ok, result.ms, result.detail
                        ),
                        Err(error) => eprintln!("[copilot] warm failed: {error}"),
                    }
                }
                Err(error) => eprintln!("[copilot] warm unavailable: {error}"),
            }
        });
    }

    let live_app = app.clone();
    let live_session_id = session_id.clone();
    let live_token = token.clone();
    tokio::spawn(async move {
        run_live_extractor(live_app, live_session_id, live_token).await;
    });

    let task_app = app.clone();
    let task_session_id = session_id.clone();
    tokio::spawn(async move {
        run_consumer(task_app, task_session_id, notify, token, ready).await;
    });
    Ok(session_id)
}

fn emit_live_state(app: &AppHandle, state: &LiveState) {
    let _ = app.emit("copilot-live-state", state);
}

fn live_session_mut<'a>(
    copilot: &'a mut CopilotState,
    session_id: &str,
) -> Option<&'a mut CopilotSession> {
    copilot
        .session
        .as_mut()
        .filter(|session| session.session_id == session_id && !session.token.is_cancelled())
}

fn configure_live_mode(session: &mut CopilotSession) {
    session.live.enabled =
        session.effective_mode() != "no_ai" && session.live_enabled_override.unwrap_or(true);
    session.live.status = if session.live.enabled { "idle" } else { "off" }.into();
    session.live.reason = None;
    session.live.revision += 1;
}

pub fn live_state(app: &AppHandle, session_id: &str) -> Result<LiveState, String> {
    let state = app.state::<AppState>();
    let mut copilot = state.copilot.lock().unwrap();
    let session = live_session_mut(&mut copilot, session_id).ok_or("No live copilot session")?;
    Ok(copilot_live::snapshot(&session.live, session_id))
}

pub fn live_configure(
    app: &AppHandle,
    session_id: &str,
    enabled: bool,
) -> Result<LiveState, String> {
    let snapshot = {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let session =
            live_session_mut(&mut copilot, session_id).ok_or("No live copilot session")?;
        session.live_enabled_override = Some(enabled);
        configure_live_mode(session);
        copilot_live::snapshot(&session.live, session_id)
    };
    emit_live_state(app, &snapshot);
    Ok(snapshot)
}

#[allow(clippy::too_many_arguments)]
pub fn live_review(
    app: &AppHandle,
    session_id: &str,
    item_id: &str,
    action: &str,
    text: Option<&str>,
    owner: Option<&str>,
    due: Option<&str>,
) -> Result<LiveState, String> {
    let snapshot = {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let session =
            live_session_mut(&mut copilot, session_id).ok_or("No live copilot session")?;
        let mut reviewed = session.live.clone();
        copilot_live::review(
            &mut reviewed,
            item_id,
            action,
            text,
            owner,
            due,
            &chrono::Utc::now().to_rfc3339(),
        )
        .map_err(|error| error.to_string())?;
        let snapshot = copilot_live::snapshot(&reviewed, session_id);
        // Commit the review before acknowledging it, leaving memory unchanged on failure.
        crate::storage::save_live_snapshot(&snapshot)
            .map_err(|error| format!("Could not save live review: {error}"))?;
        session.live = reviewed;
        snapshot
    };
    emit_live_state(app, &snapshot);
    Ok(snapshot)
}

fn live_failure(request: &crate::types::LiveExtractRequest, reason: String) -> LiveExtractResponse {
    LiveExtractResponse {
        request_id: request.request_id.clone(),
        session_id: request.session_id.clone(),
        base_revision: request.base_revision,
        status: "error".into(),
        reason: Some(reason),
        through_ms: None,
        upserts: Vec::new(),
        retractions: Vec::new(),
        summary: None,
    }
}

fn log_live_extraction_discard(
    session_id: &str,
    extract_seq: u64,
    base_revision: u64,
    reason: &str,
) {
    eprintln!(
        "[copilot] live extraction discarded reason={reason} session={session_id} seq={extract_seq} base_revision={base_revision}"
    );
}

fn apply_live_extraction(
    copilot: &mut CopilotState,
    session_id: &str,
    extract_seq: u64,
    response: &LiveExtractResponse,
    covered: usize,
) -> Option<LiveState> {
    let session = match copilot.session.as_mut() {
        None => Err("session_ended"),
        Some(session) if session.session_id != session_id => Err("session_changed"),
        Some(session) if session.token.is_cancelled() => Err("session_ended"),
        Some(session) if session.live.extract_seq != extract_seq => Err("superseded_extraction"),
        Some(session) => Ok(session),
    };
    let session = match session {
        Ok(session) => session,
        Err(reason) => {
            log_live_extraction_discard(session_id, extract_seq, response.base_revision, reason);
            return None;
        }
    };
    copilot_live::apply_response(
        &mut session.live,
        response,
        Instant::now(),
        covered,
        &session.card_questions,
    );
    Some(copilot_live::snapshot(&session.live, session_id))
}

/// A waiting queue entry does not hold the local model. In particular, a
/// not-yet-announced card must not starve extraction if activation is delayed.
fn live_answer_busy(session: &CopilotSession) -> bool {
    session
        .active
        .as_ref()
        .is_some_and(|active| !active.token.is_cancelled() && !active.job.terminal.is_written())
}

fn note_live_answer_finished(session: &mut CopilotSession, action: &TerminalAction, now: Instant) {
    // Superseded waiting cards and retries of a database write are not new
    // model completions and must not repeatedly restart the cooldown.
    if action.dispatched && action.attempts == 0 {
        session.last_answer_finished = Some(now);
    }
}

#[derive(Default)]
struct LiveTickLog {
    last_decision: Option<Decision>,
    last_logged_at: Option<Instant>,
}

impl LiveTickLog {
    fn reason_if_due(&mut self, decision: Decision, ctl: &LiveCtl, now: Instant) -> Option<String> {
        let changed = self.last_decision != Some(decision);
        self.last_decision = Some(decision);
        let report_wait = matches!(decision, Decision::Run { .. } | Decision::Busy)
            || matches!(decision, Decision::Skip(reason) if reason != "disabled");
        if (!changed && !report_wait)
            || self
                .last_logged_at
                .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(15))
        {
            return None;
        }
        self.last_logged_at = Some(now);
        Some(decision.log_reason(ctl))
    }
}

fn apply_live_tick_status(ctl: &mut LiveCtl, decision: Decision, now: Instant) -> bool {
    match decision {
        Decision::Busy => {
            copilot_live::set_status(ctl, "busy", Some("Waiting while Copilot answers".into()))
        }
        Decision::Run { .. } => copilot_live::set_status(ctl, "updating", None),
        Decision::Skip(_) if ctl.status == "busy" => {
            if ctl.backoff_until.is_some_and(|until| now < until) {
                copilot_live::set_status(
                    ctl,
                    "error",
                    Some("Live capture will retry shortly".into()),
                )
            } else {
                copilot_live::set_status(ctl, "idle", None)
            }
        }
        Decision::Skip(_) => false,
    }
}

async fn run_live_extractor(app: AppHandle, session_id: String, session_token: CancellationToken) {
    let period = Duration::from_secs(5);
    let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut tick_log = LiveTickLog::default();
    loop {
        tokio::select! {
            _ = session_token.cancelled() => return,
            _ = ticks.tick() => {},
        }
        let prepared = {
            let state = app.state::<AppState>();
            let mut copilot = state.copilot.lock().unwrap();
            let Some(session) = live_session_mut(&mut copilot, &session_id) else {
                return;
            };
            if !session.live.enabled {
                continue;
            }
            let now = Instant::now();
            let answer_busy = live_answer_busy(session);
            let decision = copilot_live::should_extract(
                &session.live,
                now,
                answer_busy,
                session.last_answer_finished,
            );
            if let Some(reason) = tick_log.reason_if_due(decision, &session.live, now) {
                eprintln!("[copilot] live tick reason={reason}");
            }
            let changed = apply_live_tick_status(&mut session.live, decision, now);
            if changed && !matches!(decision, Decision::Run { .. }) {
                emit_live_state(&app, &copilot_live::snapshot(&session.live, &session_id));
            }
            match decision {
                Decision::Skip(_) | Decision::Busy => None,
                Decision::Run { update_summary } => {
                    let extract_seq = copilot_live::start_extraction(&mut session.live, now);
                    let model = local_gate_model().unwrap_or_default();
                    let (request, covered) = copilot_live::build_request(
                        &mut session.live,
                        &session_id,
                        &model,
                        &uuid::Uuid::new_v4().to_string(),
                        update_summary,
                    );
                    Some((
                        request,
                        covered,
                        extract_seq,
                        copilot_live::snapshot(&session.live, &session_id),
                    ))
                }
            }
        };
        let Some((request, covered, extract_seq, updating)) = prepared else {
            continue;
        };
        emit_live_state(&app, &updating);
        let state = app.state::<AppState>();
        let result = tokio::select! {
            _ = session_token.cancelled() => {
                log_live_extraction_discard(
                    &session_id, extract_seq, request.base_revision, "session_ended",
                );
                return;
            },
            result = state.client.copilot_live_extract(&request) => result,
        };
        let mut response = result.unwrap_or_else(|reason| live_failure(&request, reason));
        if let Err(reason) =
            copilot_live::validate_response(&mut response, &request, updating.through_ms)
        {
            response = live_failure(&request, reason);
        }
        let snapshot = {
            let mut copilot = state.copilot.lock().unwrap();
            let Some(snapshot) =
                apply_live_extraction(&mut copilot, &session_id, extract_seq, &response, covered)
            else {
                continue;
            };
            snapshot
        };
        if let Err(error) = crate::storage::save_live_snapshot(&snapshot) {
            eprintln!("[copilot] live extraction persistence failed: {error}");
            let mut copilot = state.copilot.lock().unwrap();
            if let Some(session) = live_session_mut(&mut copilot, &session_id) {
                copilot_live::set_status(
                    &mut session.live,
                    "error",
                    Some("Could not save live capture".into()),
                );
                emit_live_state(&app, &copilot_live::snapshot(&session.live, &session_id));
            }
        } else {
            emit_live_state(&app, &snapshot);
        }
    }
}

fn readiness_session<'a>(
    state: &'a mut CopilotState,
    session_id: &str,
    epoch: u64,
) -> Option<&'a mut CopilotSession> {
    state.session.as_mut().filter(|session| {
        session.session_id == session_id
            && session.accepts_epoch(epoch)
            && !session.token.is_cancelled()
    })
}

pub fn folder_readiness(
    state: &AppState,
    session_id: &str,
) -> Result<CopilotFolderReadiness, String> {
    state
        .copilot
        .lock()
        .unwrap()
        .session
        .as_ref()
        .filter(|session| session.session_id == session_id)
        .map(|session| session.readiness.clone())
        .ok_or_else(|| SESSION_NOT_ACTIVE.to_string())
}

/// End the current session. Its active terminal is written from the latest
/// partial snapshot before the session is removed, so late request callbacks
/// can only observe a retired id and are suppressed.
pub fn retire_current_session(app: &AppHandle, reason: &str) -> Option<String> {
    retire_session(app, None, reason)
}

fn retire_session(
    app: &AppHandle,
    expected_session_id: Option<&str>,
    reason: &str,
) -> Option<String> {
    let (session_id, actions, live) = {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let mut session = take_session_if_expected(&mut copilot.session, expected_session_id)?;
        session.token.cancel();
        let mut actions = Vec::new();
        if let Some(active) = session.active.take() {
            active.token.cancel();
            actions.push(TerminalAction::active(
                active,
                "cancelled",
                Some(reason),
                None,
            ));
        }
        for waiting in session.waiting.drain(..) {
            actions.push(TerminalAction::waiting(waiting, reason));
        }
        let live = copilot_live::snapshot(&session.live, &session.session_id);
        (session.session_id, actions, live)
    };
    if let Err(error) = crate::storage::save_live_snapshot(&live) {
        eprintln!("[copilot] final live state persistence failed: {error}");
    }
    for action in actions {
        finish_terminal(app, action);
    }
    Some(session_id)
}

fn take_session_if_expected(
    slot: &mut Option<CopilotSession>,
    expected_session_id: Option<&str>,
) -> Option<CopilotSession> {
    if expected_session_id.is_some_and(|expected| {
        slot.as_ref().map(|session| session.session_id.as_str()) != Some(expected)
    }) {
        return None;
    }
    slot.take()
}

pub fn retire_session_if_current(app: &AppHandle, session_id: &str) -> bool {
    retire_session(app, Some(session_id), "session_ended").is_some()
}

pub fn current_session_id(state: &AppState) -> Option<String> {
    state
        .copilot
        .lock()
        .unwrap()
        .session
        .as_ref()
        .map(|session| session.session_id.clone())
}

pub fn current_mode(state: &AppState) -> String {
    state.copilot.lock().unwrap().session.as_ref().map_or_else(
        || "no_ai".to_string(),
        |session| session.effective_mode().to_string(),
    )
}

/// Persist web consent and publish it to the current session as one locked change.
pub fn set_folder_web(
    state: &AppState,
    session_id: &str,
    folder_id: i64,
    enabled: bool,
) -> Result<(), String> {
    set_folder_web_with(
        &state.copilot,
        session_id,
        folder_id,
        enabled,
        crate::storage::set_folder_copilot_web,
    )
}

fn set_folder_web_with<F, E>(
    copilot: &std::sync::Mutex<CopilotState>,
    session_id: &str,
    folder_id: i64,
    enabled: bool,
    persist: F,
) -> Result<(), String>
where
    F: FnOnce(i64, bool) -> Result<(), E>,
{
    let mut copilot = copilot.lock().unwrap();
    let session = copilot
        .session
        .as_mut()
        .filter(|session| !session_id.trim().is_empty() && session.session_id == session_id)
        .ok_or_else(|| SESSION_NOT_ACTIVE.to_string())?;
    if session.folder_id != Some(folder_id) {
        return Err(SESSION_FOLDER_MISMATCH.to_string());
    }
    persist(folder_id, enabled).map_err(|_| WEB_CONSENT_SAVE_FAILED.to_string())?;
    session.folder_web = enabled;
    Ok(())
}

pub fn set_live_context(
    state: &AppState,
    session_id: &str,
    mut context: CopilotLiveContext,
) -> Result<(), String> {
    let mut copilot = state.copilot.lock().unwrap();
    let session = copilot
        .session
        .as_mut()
        .filter(|session| session.session_id == session_id)
        .ok_or_else(|| "Copilot session is no longer active".to_string())?;
    context.folder_id = session.folder_id;
    session.live_context = context;
    Ok(())
}

fn local_gate_model() -> Option<String> {
    resolve_local_model(
        &crate::config::load_config().copilot_local_model,
        crate::commands::local_llm_model(),
    )
}

fn resolve_local_model(copilot_local_model: &str, fallback: Option<String>) -> Option<String> {
    if copilot_local_model.trim().is_empty() {
        fallback
    } else {
        Some(copilot_local_model.trim().to_string())
    }
}

fn frozen_local_config() -> Result<FrozenLlmConfig, String> {
    validate_and_freeze_local_config(
        local_gate_model(),
        crate::commands::local_llm_base_url(),
        crate::setup::managed_credentials(),
    )
}

#[allow(clippy::type_complexity)]
pub(crate) fn copilot_local_provider(
) -> Result<(Option<String>, Option<String>, Option<String>), String> {
    let config = frozen_local_config()?;
    Ok((config.model, config.base_url, config.api_key))
}

fn validate_and_freeze_local_config(
    model: Option<String>,
    base_url: Option<String>,
    managed_credentials: Option<(String, String)>,
) -> Result<FrozenLlmConfig, String> {
    let base_url = base_url.ok_or_else(|| "Local engine is not configured".to_string())?;
    let credential = managed_credentials.and_then(|(registered, key)| {
        (normalized_url(&base_url) == normalized_url(&registered) && !key.trim().is_empty())
            .then_some(key)
    });
    validate_local_endpoint(&base_url, credential.as_deref())?;
    Ok(FrozenLlmConfig {
        model,
        base_url: Some(base_url),
        api_key: credential,
    })
}

fn deepseek_model(config: &crate::types::AppConfig) -> String {
    match config.copilot_deepseek_model.as_str() {
        "deepseek-v4-flash" | "deepseek-v4-pro" => config.copilot_deepseek_model.clone(),
        _ => DEEPSEEK_MODEL.to_string(),
    }
}

fn frozen_deepseek_config() -> Result<FrozenLlmConfig, String> {
    let api_key = crate::copilot_keys::get_deepseek_api_key()?.ok_or_else(|| {
        "Add a DeepSeek API key in Settings › Live Copilot to use DeepSeek.".to_string()
    })?;
    Ok(freeze_deepseek_config(
        &crate::config::load_config(),
        api_key,
    ))
}

fn freeze_deepseek_config(config: &crate::types::AppConfig, api_key: String) -> FrozenLlmConfig {
    FrozenLlmConfig {
        model: Some(deepseek_model(config)),
        base_url: Some(DEEPSEEK_BASE_URL.to_string()),
        api_key: Some(api_key),
    }
}

const RECENT_CARDS_LABEL: &str =
    "RECENT CARDS (oldest first; the last card is the most recent answer; suggestions shown to Me earlier, not words Me said, never evidence):\n";

fn card_memory(session_id: &str, rows: Vec<crate::storage::RecentDoneCard>) -> Vec<RecentCard> {
    rows.into_iter()
        .map(|row| {
            let passages: Vec<CopilotPassage> =
                serde_json::from_str(&row.passages_json).unwrap_or_default();
            let mut seen = HashSet::new();
            let evidence_refs = passages
                .iter()
                .map(crate::copilot_provenance::canonical_evidence_key)
                .filter(|key| seen.insert(key.clone()))
                .take(3)
                .collect();
            let say = row
                .answer_md
                .lines()
                .filter_map(|line| line.strip_prefix("SAY:").map(str::trim))
                .collect::<Vec<_>>()
                .join(" ");
            let points = row
                .answer_md
                .lines()
                .filter_map(|line| line.strip_prefix("SPECIFIC:"))
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .take(6)
                .map(|text| crate::copilot_provenance::truncate_word_boundary(text, 200))
                .filter(|text| !text.is_empty())
                .collect();
            RecentCard {
                card_ref: format!("{session_id}:{}", row.card_id),
                question: row.question.chars().take(2_000).collect(),
                say: crate::copilot_provenance::truncate_word_boundary(&say, 1_200),
                points,
                origin: "generated_suggestion".into(),
                evidence_refs,
            }
        })
        .collect()
}

fn memory_bytes(cards: &[RecentCard]) -> usize {
    RECENT_CARDS_LABEL.len()
        + serde_json::to_vec(cards)
            .expect("RecentCard serialization")
            .len()
}

fn bound_card_memory(mut cards: Vec<RecentCard>, provider: &str) -> Vec<RecentCard> {
    let cap = if provider == "local" { 2_400 } else { 1_600 };
    while cards.len() > 1 && memory_bytes(&cards) > cap {
        cards.remove(0);
    }
    while !cards.is_empty() && memory_bytes(&cards) > cap {
        let newest = &mut cards[0];
        if !newest.points.is_empty() {
            newest.points.pop();
        } else if !newest.say.is_empty() {
            let (mut sentences, remainder) =
                crate::copilot_provenance::split_sentences(&newest.say);
            if remainder.is_empty() {
                sentences.pop();
            }
            newest.say = sentences.join(" ");
        } else if !newest.question.is_empty() {
            newest.question.pop();
        } else {
            // Path metadata alone can exceed the block; never emit an oversized request.
            cards.clear();
        }
    }
    cards
}

fn freeze_card_memory_on(conn: &rusqlite::Connection, job: &mut CopilotJob) -> anyhow::Result<()> {
    if job.retry_of.is_some() {
        return Ok(());
    }
    let recent = card_memory(
        &job.session_id,
        crate::storage::recent_done_cards_on(conn, &job.session_id, 3)?,
    );
    if job
        .resolved_question
        .as_deref()
        .is_none_or(|question| question.trim().is_empty())
    {
        job.resolved_question = resolve_question(&job.question, &recent);
    }
    job.recent_cards = bound_card_memory(recent, &job.provider_frozen);
    Ok(())
}

fn resolve_question(question: &str, recent: &[RecentCard]) -> Option<String> {
    let newest = recent.last()?;
    let mut keywords = crate::copilot::extract_fts_keywords(question);
    // Preserve repeated terms in SAY so an earlier occurrence does not hide a
    // later phrase such as "subject hash".
    let say_keywords: Vec<_> = newest
        .say
        .split_whitespace()
        .flat_map(crate::copilot::extract_fts_keywords)
        .collect();
    let mentioned = !keywords.is_empty()
        && say_keywords
            .windows(keywords.len())
            .any(|words| words == keywords);
    if keywords.len() >= 2 && !mentioned {
        return None;
    }
    let mut added = 0;
    for keyword in crate::copilot::extract_fts_keywords(&newest.question) {
        if !keywords.contains(&keyword) {
            keywords.push(keyword);
            added += 1;
            if added == 4 {
                break;
            }
        }
    }
    if keywords.is_empty() {
        return None;
    }
    Some(crate::copilot_provenance::truncate_word_boundary(
        &keywords.join(" "),
        2_000,
    ))
}

fn prepare_job(
    session: &mut CopilotSession,
    question: &str,
    question_source: &str,
    context_turns: Vec<String>,
    previous_them: Option<String>,
    trigger: &str,
) -> Result<CopilotJob, String> {
    prepare_policy_job(
        session,
        question,
        question_source,
        context_turns,
        previous_them,
        trigger,
        false,
    )
}

fn prepare_policy_job(
    session: &mut CopilotSession,
    question: &str,
    question_source: &str,
    context_turns: Vec<String>,
    previous_them: Option<String>,
    trigger: &str,
    gate_needed: bool,
) -> Result<CopilotJob, String> {
    let question = crate::copilot_provenance::truncate_word_boundary(question, MAX_QUESTION_CHARS);
    if question.trim().is_empty() {
        return Err("Question cannot be blank".to_string());
    }
    let normalized = CopilotSession::norm(&question);
    if trigger == "auto" {
        if let Some(reason) = session.auto_suppression(&question, question_source) {
            log_suppressed(reason, &question);
            return Err("Question is already in progress".to_string());
        }
    }
    let duplicate = if trigger == "manual" {
        session.is_in_progress(&normalized)
    } else {
        session.is_duplicate(&question)
    };
    if duplicate {
        log_suppressed("in_progress", &question);
        return Err("Question is already in progress".to_string());
    }
    let mut live_context = session.live_context.clone();
    live_context.folder_id = session.folder_id;

    let provider = session.effective_mode().to_string();
    let mut validation_error = None;
    let local_config = match provider.as_str() {
        "local" => match frozen_local_config() {
            Ok(config) => config,
            Err(error) => {
                validation_error = Some(error);
                FrozenLlmConfig::default()
            }
        },
        "claude" => FrozenLlmConfig {
            model: Some("claude-opus-5".to_string()),
            ..FrozenLlmConfig::default()
        },
        "deepseek" => match frozen_deepseek_config() {
            Ok(config) => config,
            Err(error) => {
                validation_error = Some(error);
                FrozenLlmConfig::default()
            }
        },
        _ => FrozenLlmConfig::default(),
    };
    let context_turns = context_turns
        .into_iter()
        .filter(|turn| CopilotSession::norm(turn) != normalized)
        .take(session.context_limit())
        .map(|turn| {
            crate::copilot_provenance::truncate_word_boundary(&turn, MAX_CONTEXT_TURN_CHARS)
        })
        .filter(|turn| !turn.is_empty())
        .collect();
    if !gate_needed {
        session.remember_question(&question, question_source, trigger);
    }
    Ok(CopilotJob {
        row_id: 0,
        session_id: session.session_id.clone(),
        card_id: session.next_card_id(),
        resolved_question: (!gate_needed).then(|| question.clone()),
        question,
        question_source: question_source.to_string(),
        context_turns,
        stated_figures: if provider == "local" {
            session.fact_ledger.snapshot()
        } else {
            Vec::new()
        },
        trigger: trigger.to_string(),
        asked_at_ms: session.started_at.elapsed().as_millis() as u64,
        provider_frozen: provider.clone(),
        folder_id: session.folder_id,
        web_search: session.folder_web && provider == "claude",
        persona: session.folder_persona.clone(),
        header: session.header.clone(),
        standing_pack: session.standing_pack.clone(),
        pack_frozen: session.readiness.status != "indexing",
        folder_terms: session.folder_terms.clone(),
        recent_cards: Vec::new(),
        voice_samples: session.voice_samples.clone(),
        previous_them,
        live_context,
        passages: Vec::new(),
        retrieval_ms: None,
        model: local_config.model,
        llm_base_url: local_config.base_url,
        llm_api_key: local_config.api_key,
        retry_of: None,
        reuse_passages: false,
        validation_error,
        gate_needed,
        policy_reason: "direct_question",
        gate_request: None,
        announced: false,
        terminal: Arc::new(TerminalGuard::new()),
    })
}

fn persist_and_queue(session: &mut CopilotSession, job: CopilotJob) -> Result<QueuedCard, String> {
    persist_and_queue_candidate(session, job, false)
}

fn persist_and_queue_candidate(
    session: &mut CopilotSession,
    mut job: CopilotJob,
    append: bool,
) -> Result<QueuedCard, String> {
    // Gated candidates have no database row or event until the gate accepts.
    if !job.gate_needed {
        let conn = crate::storage::connect_for_sync().map_err(|error| error.to_string())?;
        persist_job_on(&conn, &mut job)?;
        if let Some(resolved) = &job.resolved_question {
            session.remember_card_question(resolved);
        }
        if job.retry_of.is_some() {
            session.remember_question(&job.question, &job.question_source, "manual");
        }
    }
    Ok(queue_prepared_job(session, job, append))
}

fn queue_prepared_job(session: &mut CopilotSession, job: CopilotJob, append: bool) -> QueuedCard {
    let heard = card_event(&job, "heard", Vec::new(), None, None);
    let ack = CopilotCommandAck {
        session_id: job.session_id.clone(),
        card_id: job.card_id,
    };
    let notify = session.notify.clone();
    let replaced = if append {
        session.waiting.push_back(job);
        Vec::new()
    } else {
        session.accept_waiting(job)
    };
    QueuedCard {
        ack,
        heard,
        replaced,
        notify,
    }
}

fn persist_job_on(conn: &rusqlite::Connection, job: &mut CopilotJob) -> Result<(), String> {
    freeze_card_memory_on(conn, job)
        .map_err(|error| format!("Could not read recent Copilot cards: {error}"))?;
    job.row_id = crate::storage::insert_copilot_card_resolved_on(
        conn,
        &job.session_id,
        job.card_id,
        job.folder_id,
        &job.provider_frozen,
        &job.trigger,
        job.retry_of,
        &job.question,
        job.resolved_question.as_deref(),
        &chrono::Utc::now().to_rfc3339(),
        answer_shape(job),
    )
    .map_err(|error| format!("Could not save Copilot card: {error}"))?;
    Ok(())
}

fn publish_queued(app: &AppHandle, queued: &QueuedCard) {
    for replaced in queued.replaced.iter().cloned() {
        finish_terminal(app, TerminalAction::waiting(replaced, "superseded"));
    }
    {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let Some(job) = copilot
            .session
            .as_mut()
            .filter(|session| session.session_id == queued.ack.session_id)
            .and_then(|session| {
                session
                    .waiting
                    .iter_mut()
                    .find(|job| job.card_id == queued.ack.card_id && !job.terminal.is_written())
            })
        else {
            return;
        };
        if !job.gate_needed {
            let _ = app.emit("copilot-card", &queued.heard);
            job.announced = true;
        }
    }
    queued.notify.notify_one();
}

/// Confirmed captions update history even when they do not trigger a card.
/// Forced audio cuts are buffered until a real silence completes the speech turn.
fn on_caption(app: &AppHandle, epoch: u64, text: &str, boundary: &str, source: &str) {
    let queued = {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let Some(session) = copilot
            .session
            .as_mut()
            .filter(|session| session.accepts_epoch(epoch))
        else {
            return;
        };
        let Some(turn) = session.assemble_caption(source, text, boundary) else {
            return;
        };
        let speaker = if source == "them" { "Them" } else { "Me" };
        let mut queued = Vec::new();
        for result in detect_turn(session, speaker, &turn) {
            match result
                .and_then(|job| persist_and_queue_candidate(session, job, !queued.is_empty()))
            {
                Ok(card) => queued.push(card),
                Err(error) if error != "Question is already in progress" => {
                    eprintln!("[copilot] could not queue detected question: {error}");
                }
                _ => {}
            }
        }
        session.push_dialogue_turn(speaker, &turn);
        if speaker == "Them" {
            session.last_them = Some(turn.clone());
        } else {
            session.last_me = Some(turn.clone());
        }
        session.last_any = Some(turn);
        session.last_any_source = speaker;
        queued
    };
    for queued in queued {
        publish_queued(app, &queued);
    }
}

fn detect_turn(
    session: &mut CopilotSession,
    speaker: &'static str,
    turn: &str,
) -> Vec<Result<CopilotJob, String>> {
    let addressed = if speaker == "Me" && !session.mic_questions {
        match crate::copilot::strip_wake_word(turn) {
            Some(question) => question,
            None => {
                log_suppressed("interview_mic", turn);
                return Vec::new();
            }
        }
    } else {
        turn
    };
    let mut candidates = crate::copilot::classify_candidates(addressed);
    if candidates.is_empty() {
        log_suppressed("narration_or_no_request", addressed);
        return Vec::new();
    }
    let context = session.context_before(turn);
    let previous = session.previous_them_before(turn);
    let candidate = candidates.remove(0);
    let gate_request = candidate.ambiguous.then(|| GateRequest {
        candidate: addressed.to_string(),
        speaker: speaker.to_string(),
        mode: if session.mic_questions {
            "self_ask"
        } else {
            "interview"
        }
        .into(),
        context_turns: context.clone(),
        recent_questions: session.recent_questions.iter().cloned().collect(),
        model: local_gate_model(),
    });
    // The answer needs the setup around the requests (e.g. a "let's say"
    // premise), which is not part of the candidate text. Carry the whole
    // addressed turn in a separate context vector, chunked and
    // speaker-labelled, trimmed from the front so the turn itself survives.
    let answer_context = if candidate.text != addressed {
        let mut extended = context.clone();
        extended.extend(split_turn_chunks(addressed, speaker));
        while extended.len() > session.context_limit() {
            extended.remove(0);
        }
        extended
    } else {
        context.clone()
    };
    let job = prepare_policy_job(
        session,
        &candidate.text,
        speaker,
        answer_context,
        previous.clone(),
        "auto",
        candidate.ambiguous,
    )
    .map(|mut job| {
        job.policy_reason = candidate.reason;
        job.gate_request = gate_request;
        job
    });
    vec![job]
}

/// Split a turn at word boundaries into speaker-labelled chunks of at most 600
/// characters, so a multi-request turn reaches the answer with its setup.
fn split_turn_chunks(turn: &str, speaker: &str) -> Vec<String> {
    const MAX_CHUNK_CHARS: usize = 600;
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in turn.split_whitespace() {
        // A pathological single word longer than the chunk bound is split on
        // char boundaries so every chunk stays within the bound.
        let mut rest = word;
        while rest.chars().count() > MAX_CHUNK_CHARS {
            let cut: String = rest.chars().take(MAX_CHUNK_CHARS).collect();
            if !current.is_empty() {
                chunks.push(format!("{speaker}: {current}"));
                current = String::new();
            }
            chunks.push(format!("{speaker}: {cut}"));
            rest = &rest[cut.len()..];
        }
        let extra = rest.chars().count() + usize::from(!current.is_empty());
        if current.chars().count() + extra > MAX_CHUNK_CHARS {
            chunks.push(format!("{speaker}: {current}"));
            current = String::new();
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(rest);
    }
    if !current.is_empty() {
        chunks.push(format!("{speaker}: {current}"));
    }
    chunks
}

fn log_suppressed(reason: &str, text: &str) {
    eprintln!(
        "[copilot] suppressed reason={reason} text={}",
        text.chars().take(60).collect::<String>()
    );
}

pub fn on_them_caption(app: &AppHandle, epoch: u64, text: &str, boundary: &str) {
    on_caption(app, epoch, text, boundary, "them");
}

pub fn on_me_caption(app: &AppHandle, epoch: u64, text: &str, boundary: &str) {
    on_caption(app, epoch, text, boundary, "me");
}

/// Dialogue turns searched by a manual "Answer last/this" request.
const MANUAL_SEARCH_TURNS: usize = 6;

struct ManualSelection {
    question: String,
    source: &'static str,
    context: Vec<String>,
    previous: Option<String>,
}

/// Walk back to the newest qualifying request instead of answering the last
/// spoken turn: search the newest [`MANUAL_SEARCH_TURNS`] dialogue turns for
/// the latest turn the shared prompt predicate accepts (greetings and filler
/// never qualify), then build context and previous-Them strictly from the
/// entries before that turn. RECENT CARDS memory stays as today (newest cards).
fn select_manual_turn(
    session: &CopilotSession,
    use_me_fallback: bool,
) -> Result<ManualSelection, String> {
    let eligible =
        |speaker: &'static str| session.mic_questions || use_me_fallback || speaker == "Them";
    let len = session.recent_dialogue.len();
    let start = len.saturating_sub(MANUAL_SEARCH_TURNS);
    for turn in session.recent_dialogue.iter().skip(start).rev() {
        if !eligible(turn.speaker) {
            continue;
        }
        if !crate::copilot::is_prompt(&turn.full_text) {
            continue;
        }
        let selected = turn.seq;
        let prefix: Vec<&DialogueTurn> = session
            .recent_dialogue
            .iter()
            .filter(|entry| entry.seq < selected)
            .collect();
        let context_start = prefix.len().saturating_sub(session.context_limit());
        let context = prefix[context_start..]
            .iter()
            .map(|entry| format!("{}: {}", entry.speaker, entry.text))
            .collect();
        let previous = prefix
            .iter()
            .rev()
            .find(|entry| entry.speaker == "Them")
            .map(|entry| entry.text.clone());
        return Ok(ManualSelection {
            question: turn.full_text.clone(),
            source: turn.speaker,
            context,
            previous,
        });
    }
    // NOTE: legacy fallback answers the last eligible turn even when it is a
    // greeting or otherwise not a request, so it can still answer "Hello".
    let (question, source) = select_last_question(session, use_me_fallback)?;
    let context = session.context_before(&question);
    let previous = session.previous_them_before(&question);
    Ok(ManualSelection {
        question,
        source,
        context,
        previous,
    })
}

fn select_last_question(
    session: &CopilotSession,
    use_me_fallback: bool,
) -> Result<(String, &'static str), String> {
    let (question, source) = if session.mic_questions || use_me_fallback {
        (session.last_any.clone(), session.last_any_source)
    } else {
        (session.last_them.clone(), "Them")
    };
    question
        .map(|question| (question, source))
        .ok_or_else(|| "No speech heard yet".to_string())
}

pub fn set_mic_questions(state: &AppState, enabled: bool) -> Result<(), String> {
    let mut copilot = state.copilot.lock().unwrap();
    let session = copilot
        .session
        .as_mut()
        .ok_or_else(|| "No active Copilot session".to_string())?;
    session.mic_questions = enabled;
    Ok(())
}

pub fn ask_last(app: &AppHandle, use_me_fallback: bool) -> Result<CopilotCommandAck, String> {
    let queued = {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let session = copilot
            .session
            .as_mut()
            .ok_or_else(|| "No active Copilot session".to_string())?;
        let selection = select_manual_turn(session, use_me_fallback)?;
        let job = prepare_job(
            session,
            &selection.question,
            selection.source,
            selection.context,
            selection.previous,
            "manual",
        )?;
        persist_and_queue(session, job)?
    };
    publish_queued(app, &queued);
    Ok(queued.ack)
}

pub fn set_mode(app: &AppHandle, mode: &str) -> Result<String, String> {
    let mode = valid_mode(mode.trim()).ok_or_else(|| {
        format!(
            "Invalid copilot mode `{mode}`. Must be one of 'no_ai', 'local', 'claude', 'deepseek'."
        )
    })?;
    let actions = {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let session = copilot
            .session
            .as_mut()
            .ok_or_else(|| "No active Copilot session".to_string())?;
        if session.effective_mode() == mode {
            session.mode_override = Some(mode.to_string());
            return Ok(mode.to_string());
        }
        let mut actions = Vec::new();
        if let Some(active) = session.active.take() {
            active.token.cancel();
            session.active_norm = None;
            session.remember_terminal("cancelled", Some("mode_changed"), &active);
            actions.push(TerminalAction::active(
                active,
                "cancelled",
                Some("mode_changed"),
                None,
            ));
        }
        for waiting in session.waiting.drain(..) {
            actions.push(TerminalAction::waiting(waiting, "cancelled"));
        }
        session.mode_override = Some(mode.to_string());
        configure_live_mode(session);
        emit_live_state(
            app,
            &copilot_live::snapshot(&session.live, &session.session_id),
        );
        actions
    };
    for action in actions {
        finish_terminal(app, action);
    }
    Ok(mode.to_string())
}

pub fn cancel_card(app: &AppHandle, card_id: u64) -> Result<(), String> {
    let action = {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let session = copilot
            .session
            .as_mut()
            .ok_or_else(|| "Card is not in progress".to_string())?;
        if session.active.as_ref().map(|active| active.job.card_id) == Some(card_id) {
            let active = session.active.take().expect("active card checked");
            active.token.cancel();
            session.active_norm = None;
            session.remember_terminal("cancelled", Some("user"), &active);
            TerminalAction::active(active, "cancelled", Some("user"), None)
        } else if let Some(index) = session
            .waiting
            .iter()
            .position(|job| job.card_id == card_id)
        {
            let waiting = session.waiting.remove(index).expect("waiting card checked");
            TerminalAction::waiting(waiting, "cancelled")
        } else {
            return Err("Card is not in progress".to_string());
        }
    };
    finish_terminal(app, action);
    Ok(())
}

pub fn retry_card(app: &AppHandle, card_id: u64) -> Result<CopilotCommandAck, String> {
    let queued = {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let session = copilot
            .session
            .as_mut()
            .ok_or_else(|| "Card cannot be retried".to_string())?;
        let original = session
            .terminal_jobs
            .get(&card_id)
            .filter(|snapshot| {
                snapshot.status == "error"
                    || (snapshot.status == "cancelled" && snapshot.reason.is_some())
            })
            .map(|snapshot| snapshot.job.clone())
            .ok_or_else(|| "Card cannot be retried".to_string())?;
        validate_retry_consent(session.effective_mode(), session.folder_web, &original)?;
        let mut job = original;
        job.row_id = 0;
        job.card_id = session.next_card_id();
        job.asked_at_ms = session.started_at.elapsed().as_millis() as u64;
        job.trigger = "manual".to_string();
        job.gate_needed = false;
        job.gate_request = None;
        job.retry_of = Some(card_id);
        job.reuse_passages = job.retrieval_ms.is_some();
        job.announced = false;
        job.terminal = Arc::new(TerminalGuard::new());
        persist_and_queue(session, job)?
    };
    publish_queued(app, &queued);
    Ok(queued.ack)
}

fn validate_retry_consent(
    effective_mode: &str,
    folder_web: bool,
    original: &CopilotJob,
) -> Result<(), String> {
    if effective_mode != original.provider_frozen {
        return Err("Copilot mode changed; switch back to retry this card".to_string());
    }
    if original.web_search && !folder_web {
        return Err(
            "Claude web search was turned off; turn it back on to retry this card".to_string(),
        );
    }
    Ok(())
}

async fn run_consumer(
    app: AppHandle,
    session_id: String,
    notify: Arc<Notify>,
    session_token: CancellationToken,
    mut ready: watch::Receiver<bool>,
) {
    let mut waited = false;
    loop {
        let active = {
            let state = app.state::<AppState>();
            let mut copilot = state.copilot.lock().unwrap();
            let Some(session) = copilot
                .session
                .as_mut()
                .filter(|session| session.session_id == session_id)
            else {
                return;
            };
            session.activate_waiting()
        };
        if let Some((job, card_token)) = active {
            if !waited {
                tokio::select! {
                    _ = session_token.cancelled() => return,
                    _ = wait_for_folder(&mut ready, Duration::from_secs(10)) => {},
                }
                waited = true;
            }
            run_job(&app, job, card_token, session_token.clone()).await;
            continue;
        }
        tokio::select! {
            _ = session_token.cancelled() => return,
            _ = notify.notified() => {}
        }
    }
}

async fn wait_for_folder(ready: &mut watch::Receiver<bool>, timeout: Duration) {
    let _ = tokio::time::timeout(timeout, ready.wait_for(|done| *done)).await;
}

fn retrieval_question(job: &CopilotJob) -> (&str, Option<&str>) {
    match job.resolved_question.as_deref() {
        Some(resolved) => (resolved, None),
        None => (&job.question, job.previous_them.as_deref()),
    }
}

fn freeze_session_pack(job: &mut CopilotJob, session: &CopilotSession) {
    if !job.pack_frozen {
        job.standing_pack = session.standing_pack.clone();
        job.folder_terms = session.folder_terms.clone();
        job.pack_frozen = true;
    }
}

/// Whether a gate fallback may fire for this pre-gate ambiguity reason.
/// Only `starter_only` (the sole defect was a missing `?`) and
/// `direct_question` (nothing was wrong) fire. The other reasons are what
/// the gate exists to scrutinise and must never be promoted on a failure.
fn gate_fallback_should_fire(ambiguity_reason: &str) -> bool {
    matches!(ambiguity_reason, "starter_only" | "direct_question")
}

fn gate_failure_cause(error: &str) -> &'static str {
    let lower = error.to_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else {
        "http"
    }
}

/// Resolve a gate outcome to (fire, resolved_question, policy_reason).
/// The fallback runs in exactly two cases — the HTTP call failed, or the
/// response carries `backend_error` — and fires only for `starter_only` /
/// `direct_question`. A firing fallback keeps `resolved_question` as `None`
/// so retrieval still uses `previous_them` and the UI shows no
/// "Understood as:". A genuine model `ignore` is never reinterpreted.
fn gate_resolution(
    ambiguity_reason: &str,
    result: Result<GateResponse, String>,
) -> (bool, Option<String>, String) {
    match result.and_then(GateResponse::validate) {
        Ok(response) => {
            if response.reason_code == "backend_error" {
                let fired = gate_fallback_should_fire(ambiguity_reason);
                eprintln!(
                    "[copilot] gate fallback cause=backend_error reason={ambiguity_reason} fired={fired}"
                );
                (fired, None, "gate_fallback".into())
            } else if response.action == "answer" {
                let resolved = response
                    .resolved_question
                    .map(|text| text.trim().to_string());
                (true, resolved, response.reason_code)
            } else {
                (false, None, response.reason_code)
            }
        }
        Err(error) => {
            let cause = gate_failure_cause(&error);
            let fired = gate_fallback_should_fire(ambiguity_reason);
            eprintln!(
                "[copilot] gate fallback cause={cause} reason={ambiguity_reason} fired={fired}"
            );
            (fired, None, "gate_fallback".into())
        }
    }
}

fn accept_gated_on(
    session: &mut CopilotSession,
    conn: &rusqlite::Connection,
    job: &mut CopilotJob,
) -> Result<bool, String> {
    // Other captions can have produced a card while this gate was running.
    if let Some(reason) = session.auto_suppression(&job.question, &job.question_source) {
        log_suppressed(reason, &job.question);
        return Ok(false);
    }
    persist_job_on(conn, job)?;
    session.remember_question(&job.question, &job.question_source, &job.trigger);
    if let Some(resolved) = &job.resolved_question {
        session.remember_card_question(resolved);
    }
    job.gate_needed = false;
    job.gate_request = None;
    Ok(true)
}

fn publish_gated(app: &AppHandle, job: &mut CopilotJob) -> bool {
    let state = app.state::<AppState>();
    let mut copilot = state.copilot.lock().unwrap();
    let Some(session) = copilot
        .session
        .as_mut()
        .filter(|session| session.session_id == job.session_id && !session.token.is_cancelled())
    else {
        return false;
    };
    if !session.active.as_ref().is_some_and(|active| {
        active.job.card_id == job.card_id
            && !active.token.is_cancelled()
            && !active.job.terminal.is_written()
    }) {
        return false;
    }
    let accepted = crate::storage::connect_for_sync()
        .map_err(|error| error.to_string())
        .and_then(|conn| accept_gated_on(session, &conn, job));
    match accepted {
        Ok(true) => {
            job.announced = true;
            session.active.as_mut().expect("active card checked").job = job.clone();
            let _ = app.emit(
                "copilot-card",
                card_event(job, "heard", Vec::new(), None, None),
            );
            true
        }
        result => {
            if let Err(error) = result {
                log_suppressed("gate_persistence", &job.question);
                eprintln!("[copilot] could not save gated question: {error}");
            }
            session.take_active(job.card_id, "skipped", None);
            false
        }
    }
}

async fn run_job(
    app: &AppHandle,
    mut job: CopilotJob,
    card_token: CancellationToken,
    session_token: CancellationToken,
) {
    if job.gate_needed {
        let state = app.state::<AppState>();
        let gate = async {
            match job.gate_request.as_ref() {
                Some(request) => state.client.copilot_gate(request).await,
                None => Err("Missing Copilot gate request".into()),
            }
        };
        let Some(result) = select_request_or_cancellation(&card_token, &session_token, gate).await
        else {
            return;
        };
        let (fired, resolved, reason) = gate_resolution(job.policy_reason, result);
        if !fired {
            log_suppressed(&reason, &job.question);
            let mut copilot = state.copilot.lock().unwrap();
            if let Some(session) = copilot
                .session
                .as_mut()
                .filter(|session| session.session_id == job.session_id)
            {
                session.take_active(job.card_id, "skipped", None);
            }
            return;
        }
        // A firing fallback keeps `resolved_question` as `None` so retrieval
        // still uses `previous_them` and the UI shows no "Understood as:".
        job.resolved_question = resolved;
        if reason == "gate_fallback" {
            job.policy_reason = "gate_fallback";
        }
        if !publish_gated(app, &mut job) {
            return;
        }
    }
    if !job.pack_frozen {
        let state = app.state::<AppState>();
        let copilot = state.copilot.lock().unwrap();
        let Some(session) = copilot
            .session
            .as_ref()
            .filter(|session| session.session_id == job.session_id)
        else {
            return;
        };
        // A capture during indexing binds to this session's pack before dispatch.
        freeze_session_pack(&mut job, session);
    }
    if !update_active_job(app, &job) {
        return;
    }
    if let Some(error) = job.validation_error.clone() {
        terminalize_active(
            app,
            &job.session_id,
            job.card_id,
            "error",
            Some("validation"),
            Some(error),
        );
        return;
    }
    if !job.reuse_passages {
        let app_state = app.state::<AppState>();
        let retrieval = crate::copilot::retrieve_passages(
            &app_state.client,
            &job.live_context,
            retrieval_question(&job).0,
            retrieval_question(&job).1,
        );
        let Some(result) = await_retrieval(&card_token, &session_token, retrieval).await else {
            return;
        };
        job.passages = sanitize_passages(result.0);
        job.retrieval_ms = Some(result.1);
        if !update_active_job(app, &job) {
            return;
        }
    }

    if job.provider_frozen == "no_ai" {
        terminalize_active(app, &job.session_id, job.card_id, "done", None, None);
        return;
    }

    if !emit_if_active(
        app,
        &job.session_id,
        job.card_id,
        "copilot-card",
        &card_event(
            &job,
            "answering",
            job.passages.clone(),
            job.retrieval_ms,
            None,
        ),
    ) {
        return;
    }

    let request = match build_request(&job) {
        Ok(request) => request,
        Err(error) => {
            terminalize_active(
                app,
                &job.session_id,
                job.card_id,
                "error",
                Some("validation"),
                Some(error),
            );
            return;
        }
    };
    // Capture the exact request that is about to be sent (redacted) so the
    // per-card replay record can be written at every terminal path.
    store_replay_request(
        app,
        &job.session_id,
        job.card_id,
        redacted_copilot_request(&request),
    );
    let egress_bytes = if matches!(job.provider_frozen.as_str(), "claude" | "deepseek") {
        request_bytes_without_credentials(&request)
    } else {
        0
    };
    let callback_app = app.clone();
    let callback_session = job.session_id.clone();
    let card_id = job.card_id;
    let app_state = app.state::<AppState>();
    let request_future = async {
        match mark_active_dispatched(app, &job.session_id, job.card_id, egress_bytes) {
            Ok(true) => {}
            Ok(false) => return Ok(None),
            Err(error) => {
                return Err(format!("Could not record provider dispatch: {error}"));
            }
        }
        app_state
            .client
            .copilot_answer_stream(&request, move |frame| {
                handle_frame(&callback_app, &callback_session, card_id, frame);
            })
            .await
            .map(Some)
    };
    let Some(result) = select_request_or_cancellation(
        &card_token,
        &session_token,
        tokio::time::timeout(ANSWER_TIMEOUT, request_future),
    )
    .await
    else {
        return;
    };

    match result {
        Err(_) => terminalize_active(
            app,
            &job.session_id,
            job.card_id,
            "error",
            Some("timeout"),
            Some("Answer timed out after 20 s".to_string()),
        ),
        Ok(Err(error)) => terminalize_active(
            app,
            &job.session_id,
            job.card_id,
            "error",
            Some(classify_error(&error)),
            Some(error),
        ),
        Ok(Ok(None)) => {}
        Ok(Ok(Some(_summary))) => {
            let (frame_error, usage_seen) = active_result(app, &job.session_id, job.card_id);
            if let Some(error) = frame_error {
                terminalize_active(
                    app,
                    &job.session_id,
                    job.card_id,
                    "error",
                    Some(classify_error(&error)),
                    Some(error),
                );
            } else if !usage_seen {
                terminalize_active(
                    app,
                    &job.session_id,
                    job.card_id,
                    "error",
                    Some("ended_early"),
                    Some("The answer stream ended early".to_string()),
                );
            } else {
                terminalize_active(app, &job.session_id, job.card_id, "done", None, None);
            }
        }
    }
}

async fn select_request_or_cancellation<F, T>(
    card_token: &CancellationToken,
    session_token: &CancellationToken,
    request: F,
) -> Option<T>
where
    F: std::future::Future<Output = T>,
{
    tokio::select! {
        biased;
        _ = card_token.cancelled() => None,
        _ = session_token.cancelled() => None,
        result = request => Some(result),
    }
}

async fn await_retrieval<F, T>(
    card_token: &CancellationToken,
    session_token: &CancellationToken,
    retrieval: F,
) -> Option<T>
where
    F: std::future::Future<Output = T>,
{
    tokio::select! {
        _ = card_token.cancelled() => None,
        _ = session_token.cancelled() => None,
        result = retrieval => Some(result),
    }
}

fn update_active_job(app: &AppHandle, job: &CopilotJob) -> bool {
    let state = app.state::<AppState>();
    let mut copilot = state.copilot.lock().unwrap();
    let Some(active) = copilot
        .session
        .as_mut()
        .filter(|session| session.session_id == job.session_id)
        .and_then(|session| session.active.as_mut())
        .filter(|active| active.job.card_id == job.card_id && !active.job.terminal.is_written())
    else {
        return false;
    };
    active.job = job.clone();
    true
}

fn mark_active_dispatched(
    app: &AppHandle,
    session_id: &str,
    card_id: u64,
    egress_bytes: usize,
) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let mut copilot = state.copilot.lock().unwrap();
    let Some(active) = copilot
        .session
        .as_mut()
        .filter(|session| session.session_id == session_id)
        .and_then(|session| session.active.as_mut())
        .filter(|active| active.job.card_id == card_id && !active.job.terminal.is_written())
    else {
        return Ok(false);
    };
    crate::storage::mark_copilot_card_dispatched(active.job.row_id)
        .map_err(|error| error.to_string())?;
    active.dispatched = true;
    active.egress_bytes = egress_bytes;
    Ok(true)
}

fn active_result(app: &AppHandle, session_id: &str, card_id: u64) -> (Option<String>, bool) {
    let state = app.state::<AppState>();
    let copilot = state.copilot.lock().unwrap();
    copilot
        .session
        .as_ref()
        .filter(|session| session.session_id == session_id)
        .and_then(|session| session.active.as_ref())
        .filter(|active| active.job.card_id == card_id)
        .map_or((None, false), |active| {
            (active.frame_error.clone(), active.usage_seen)
        })
}

fn handle_frame(app: &AppHandle, session_id: &str, card_id: u64, frame: CopilotFrame) {
    let state = app.state::<AppState>();
    let mut copilot = state.copilot.lock().unwrap();
    let Some(active) = copilot
        .session
        .as_mut()
        .filter(|session| session.session_id == session_id)
        .and_then(|session| session.active.as_mut())
        .filter(|active| active.job.card_id == card_id && !active.job.terminal.is_written())
    else {
        return;
    };
    for event in apply_section_frame(active, frame) {
        // Keep the state/emission mutex until the synchronous Tauri emit has
        // completed. Cancellation and retirement take this same mutex, so no
        // nonterminal frame can pass validation and emit after either returns.
        let _ = app.emit("copilot-answer", event);
    }
}

fn section_delta(
    active: &ActiveCard,
    section: &str,
    index: u32,
    text: String,
) -> CopilotAnswerEvent {
    let mut event = answer_event(
        &active.job.session_id,
        active.job.card_id,
        &active.job.provider_frozen,
        "delta",
        Some(text),
    );
    event.section = Some(section.to_string());
    event.index = Some(index);
    event
}

fn append_say(active: &mut ActiveCard, text: &str) -> CopilotAnswerEvent {
    let checked = crate::copilot_provenance::apply_number_rule(
        text,
        &active.job.question,
        &active.job.context_turns,
        &active.job.passages,
    );
    active.sections.say.push(checked.clone());
    section_delta(
        active,
        "say",
        (active.sections.say.len() - 1) as u32,
        checked,
    )
}

fn apply_section_frame(active: &mut ActiveCard, frame: CopilotFrame) -> Vec<CopilotAnswerEvent> {
    let event = match frame {
        // The replay record lives and dies with the card row: it is kept on
        // the in-flight job, never emitted, and never reaches the webview.
        CopilotFrame::Replay(service) => {
            active.replay_service = Some(service);
            None
        }
        CopilotFrame::Section {
            section,
            index,
            text,
            drop,
        } => {
            if !drop {
                active.answer_md.push_str(&text);
            }
            match section.as_str() {
                "say" if !drop => Some(append_say(active, &text)),
                "specific" | "notes" => {
                    let (items, cap) = if section == "specific" {
                        (&mut active.specifics_raw, specific_cap(&active.job))
                    } else {
                        (&mut active.notes_raw, 3)
                    };
                    if drop {
                        if (index as usize) < items.len() {
                            items.remove(index as usize);
                        }
                        let mut event = section_delta(active, &section, index, String::new());
                        event.drop = Some(true);
                        return vec![event];
                    }
                    if index >= cap {
                        return Vec::new();
                    }
                    items.resize_with(items.len().max(index as usize + 1), String::new);
                    items[index as usize].push_str(&text);
                    Some(section_delta(active, &section, index, text))
                }
                "next" if !drop => {
                    active.next_raw.push_str(&text);
                    Some(section_delta(active, "next", 0, text))
                }
                _ => None,
            }
        }
        CopilotFrame::Text(text) => {
            active.answer_md.push_str(&text);
            active.say_buffer.push_str(&text);
            let (sentences, rest) = crate::copilot_provenance::split_sentences(&active.say_buffer);
            active.say_buffer = rest;
            return sentences
                .iter()
                .map(|sentence| append_say(active, sentence))
                .collect();
        }
        CopilotFrame::Citation(citation) => {
            let citation = sanitize_citation(citation);
            active.citations.push(citation.clone());
            let mut event = answer_event(
                &active.job.session_id,
                active.job.card_id,
                &active.job.provider_frozen,
                "citation",
                None,
            );
            event.citation = Some(citation);
            Some(event)
        }
        CopilotFrame::Searching => Some(answer_event(
            &active.job.session_id,
            active.job.card_id,
            &active.job.provider_frozen,
            "searching",
            None,
        )),
        CopilotFrame::Usage { web_performed, .. } => {
            active.web_performed = web_performed;
            active.usage_seen = true;
            None
        }
        CopilotFrame::Error(error) => {
            active.frame_error = Some(error);
            None
        }
    };
    event.into_iter().collect()
}

fn terminalize_active(
    app: &AppHandle,
    session_id: &str,
    card_id: u64,
    status: &str,
    reason: Option<&str>,
    error: Option<String>,
) {
    let action = {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        let Some(session) = copilot
            .session
            .as_mut()
            .filter(|session| session.session_id == session_id)
        else {
            return;
        };
        session
            .take_active(card_id, status, reason)
            .map(|active| TerminalAction::active(active, status, reason, error))
    };
    if let Some(action) = action {
        finish_terminal(app, action);
    }
}

fn finalize_sections(action: &mut TerminalAction) {
    let remainder = std::mem::take(&mut action.say_buffer);
    if !remainder.trim().is_empty() {
        action
            .sections
            .say
            .push(crate::copilot_provenance::apply_number_rule(
                remainder.trim(),
                &action.job.question,
                &action.job.context_turns,
                &action.job.passages,
            ));
    }
    action.sections.specifics = action
        .specifics_raw
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .take(specific_cap(&action.job) as usize)
        .map(str::to_string)
        .collect();
    let question = action
        .job
        .resolved_question
        .as_deref()
        .unwrap_or(&action.job.question);
    let question_keywords = crate::copilot::extract_keywords(question);
    let folder_question_keywords: HashSet<_> =
        crate::copilot::extract_fts_keywords_for_folder(question, &action.job.folder_terms)
            .into_iter()
            .collect();
    action.sections.notes = action
        .notes_raw
        .iter()
        .filter_map(|line| crate::copilot_provenance::parse_note_line(line, &action.job.passages))
        .filter(|note| {
            let passage = note
                .passage_index
                .and_then(|index| action.job.passages.get(index));
            if passage.is_some_and(|passage| passage.source_kind == "folder") {
                let note_keywords: HashSet<_> = crate::copilot::extract_fts_keywords_for_folder(
                    &format!("{} {}", note.quote, note.clause),
                    &action.job.folder_terms,
                )
                .into_iter()
                .collect();
                let passage = passage.expect("folder passage checked");
                let passage_keywords: HashSet<_> = crate::copilot::extract_fts_keywords_for_folder(
                    &format!("{} {}", passage.title, passage.text),
                    &action.job.folder_terms,
                )
                .into_iter()
                .collect();
                return !folder_question_keywords.is_disjoint(&note_keywords)
                    && !folder_question_keywords.is_disjoint(&passage_keywords);
            }
            let note_keywords =
                crate::copilot::extract_keywords(&format!("{} {}", note.quote, note.clause));
            !question_keywords.is_disjoint(&note_keywords)
                || (note.passage_index == Some(0)
                    && passage.is_some_and(|passage| passage.score >= 0.75))
        })
        .collect();
    action.sections.next =
        (!action.next_raw.trim().is_empty()).then(|| action.next_raw.trim().to_string());
    action.answer_md = crate::copilot_provenance::sections_to_markdown(&action.sections);
}

fn finish_terminal(app: &AppHandle, mut action: TerminalAction) {
    if !action.job.terminal.begin_write() {
        return;
    }
    if action.job.row_id == 0 {
        action.job.terminal.commit_write();
        return;
    }
    {
        let state = app.state::<AppState>();
        let mut copilot = state.copilot.lock().unwrap();
        if let Some(session) = live_session_mut(&mut copilot, &action.job.session_id) {
            note_live_answer_finished(session, &action, Instant::now());
        }
    }
    let provenance =
        (action.status == "done" && action.job.provider_frozen != "no_ai").then(|| {
            finalize_sections(&mut action);
            crate::copilot_provenance::bullets_from_sections(
                &action.sections,
                &action.job.passages,
                &action.citations,
                action.web_performed,
            )
        });
    let passages_json = serde_json::to_string(&action.job.passages).unwrap_or_else(|_| "[]".into());
    let provenance_json = provenance
        .as_ref()
        .and_then(|value| serde_json::to_string(value).ok());
    let finished_at = chrono::Utc::now().to_rfc3339();
    let web_requested = action.web_requested();
    let update = crate::storage::CopilotTerminalUpdate {
        status: &action.status,
        reason: action.reason.as_deref(),
        passages_json: &passages_json,
        answer_md: (!action.answer_md.is_empty()).then_some(action.answer_md.as_str()),
        provenance_json: provenance_json.as_deref(),
        error: action.error.as_deref(),
        egress_bytes: i64::try_from(action.egress_bytes).unwrap_or(i64::MAX),
        web_requested,
        web_performed: action.web_performed,
        dispatched: action.dispatched,
        finished_at: &finished_at,
    };
    if let Err(error) = crate::storage::finish_copilot_card_v2_connected(action.job.row_id, &update)
    {
        action.job.terminal.release_write();
        let attempt = action.attempts.saturating_add(1);
        eprintln!(
            "[copilot] terminal persistence attempt {attempt}/{MAX_TERMINAL_WRITE_ATTEMPTS} failed: {error}"
        );
        if attempt < MAX_TERMINAL_WRITE_ATTEMPTS {
            let mut retry = action;
            retry.attempts = attempt;
            let retry_app = app.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50 * u64::from(attempt))).await;
                finish_terminal(&retry_app, retry);
            });
        }
        return;
    }
    action.job.terminal.commit_write();
    write_replay_record(&action);
    if !action.emit || !action.job.announced {
        return;
    }

    if action.status == "skipped"
        || (action.status == "done" && action.job.provider_frozen == "no_ai")
    {
        let card = card_event(
            &action.job,
            &action.status,
            action.job.passages.clone(),
            action.job.retrieval_ms,
            action.reason,
        );
        let _ = app.emit("copilot-card", card);
        return;
    }

    let kind = match action.status.as_str() {
        "done" => "done",
        "cancelled" => "cancelled",
        _ => "error",
    };
    let mut event = answer_event(
        &action.job.session_id,
        action.job.card_id,
        &action.job.provider_frozen,
        kind,
        None,
    );
    event.sections = provenance.as_ref().map(|_| action.sections);
    event.provenance = provenance;
    event.egress_bytes = Some(action.egress_bytes);
    event.web_requested = Some(web_requested);
    event.web_performed = Some(action.web_performed);
    event.reason = action.reason;
    event.error = action.error;
    let _ = app.emit("copilot-answer", event);
}

fn card_event(
    job: &CopilotJob,
    status: &str,
    passages: Vec<CopilotPassage>,
    retrieval_ms: Option<u64>,
    reason: Option<String>,
) -> CopilotCard {
    CopilotCard {
        id: job.card_id,
        session_id: job.session_id.clone(),
        status: status.to_string(),
        provider_frozen: job.provider_frozen.clone(),
        reason,
        retry_of: job.retry_of,
        question: job.question.clone(),
        resolved_question: job.resolved_question.clone(),
        answer_shape: answer_shape(job).to_string(),
        question_source: job.question_source.clone(),
        context_turns: job.context_turns.clone(),
        asked_at_ms: job.asked_at_ms,
        trigger: job.trigger.clone(),
        passages,
        retrieval_ms,
    }
}

fn answer_event(
    session_id: &str,
    card_id: u64,
    provider: &str,
    kind: &str,
    text: Option<String>,
) -> CopilotAnswerEvent {
    CopilotAnswerEvent {
        card_id,
        session_id: session_id.to_string(),
        provider: provider.to_string(),
        kind: kind.to_string(),
        text,
        section: None,
        index: None,
        drop: None,
        sections: None,
        citation: None,
        provenance: None,
        egress_bytes: None,
        web_requested: None,
        web_performed: None,
        error: None,
        reason: None,
    }
}

fn emit_if_active<T: serde::Serialize + Clone>(
    app: &AppHandle,
    session_id: &str,
    card_id: u64,
    event_name: &str,
    payload: &T,
) -> bool {
    let state = app.state::<AppState>();
    let copilot = state.copilot.lock().unwrap();
    let active = copilot
        .session
        .as_ref()
        .filter(|session| session.session_id == session_id)
        .and_then(|session| session.active.as_ref())
        .is_some_and(|active| active.job.card_id == card_id && !active.job.terminal.is_written());
    if active {
        // `cancel_card`, mode changes, and retirement acquire the same mutex.
        let _ = app.emit(event_name, payload.clone());
    }
    active
}

fn sanitize_passages(passages: Vec<CopilotPassage>) -> Vec<CopilotPassage> {
    passages
        .into_iter()
        .filter_map(|mut passage| {
            passage.text = crate::copilot_provenance::truncate_word_boundary(
                &passage.text,
                MAX_PASSAGE_TEXT_CHARS,
            );
            if passage.text.is_empty() {
                return None;
            }
            passage.title = crate::copilot_provenance::truncate_word_boundary(
                &passage.title,
                MAX_PASSAGE_TITLE_CHARS,
            );
            // Keep canonical identity in the durable snapshot. Egress labels are
            // reduced to basenames separately by egress_passages.
            if passage.source_kind != "meeting" && passage.source_kind != "notes" {
                passage.source_id = crate::copilot_provenance::canonical_path(&passage.source_id);
            }
            Some(passage)
        })
        .take(MAX_PASSAGES)
        .collect()
}

fn egress_passages(passages: &[CopilotPassage]) -> Vec<CopilotEgressPassage> {
    passages
        .iter()
        .take(MAX_PASSAGES)
        .filter_map(|passage| {
            let text = crate::copilot_provenance::truncate_word_boundary(
                &passage.text,
                MAX_PASSAGE_TEXT_CHARS,
            );
            if text.is_empty() {
                return None;
            }
            let source_id = if passage.source_kind == "meeting" {
                passage.source_id.clone()
            } else {
                Path::new(&passage.source_id)
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| passage.source_id.clone())
            };
            Some(CopilotEgressPassage {
                title: crate::copilot_provenance::truncate_word_boundary(
                    &passage.title,
                    MAX_PASSAGE_TITLE_CHARS,
                ),
                text,
                source: crate::copilot_provenance::truncate_word_boundary(
                    &format!("{}:{source_id}", passage.source_kind),
                    MAX_PASSAGE_SOURCE_CHARS,
                ),
            })
        })
        .collect()
}

fn answer_shape(job: &CopilotJob) -> &'static str {
    crate::copilot::select_answer_shape(job.resolved_question.as_deref().unwrap_or(&job.question))
}

fn specific_cap(job: &CopilotJob) -> u32 {
    if answer_shape(job) == "steps" {
        6
    } else {
        5
    }
}

fn build_request(job: &CopilotJob) -> Result<CopilotAnswerRequest, String> {
    match job.provider_frozen.as_str() {
        "claude" => {
            let api_key = crate::copilot_keys::get_api_key()?.ok_or_else(|| {
                "Add an Anthropic API key in Settings › Live Copilot to use Claude.".to_string()
            })?;
            Ok(CopilotAnswerRequest {
                provider: "claude".to_string(),
                schema_version: 7,
                standing_pack: job.standing_pack.clone(),
                recent_cards: job.recent_cards.clone(),
                resolved_question: job.resolved_question.clone(),
                answer_shape: answer_shape(job),
                question_source_tier: "confirmed".into(),
                question: job.question.clone(),
                question_source: job.question_source.clone(),
                context_turns: job.context_turns.clone(),
                stated_figures: Vec::new(),
                passages: egress_passages(&job.passages),
                persona: job.persona.clone(),
                voice_samples: job.voice_samples.clone(),
                meeting_header: job.header.clone(),
                running_summary: None,
                web_search: job.web_search,
                api_key: Some(api_key),
                model: job.model.clone(),
                llm_base_url: None,
                llm_api_key: None,
            })
        }
        "local" => {
            let base_url = job
                .llm_base_url
                .as_deref()
                .ok_or_else(|| "Local engine is not configured".to_string())?;
            Ok(CopilotAnswerRequest {
                provider: "local".to_string(),
                schema_version: 7,
                standing_pack: job.standing_pack.clone(),
                recent_cards: job.recent_cards.clone(),
                resolved_question: job.resolved_question.clone(),
                answer_shape: answer_shape(job),
                question_source_tier: "confirmed".into(),
                question: job.question.clone(),
                question_source: job.question_source.clone(),
                context_turns: job.context_turns.clone(),
                stated_figures: job.stated_figures.clone(),
                passages: egress_passages(&job.passages),
                persona: job.persona.clone(),
                voice_samples: job.voice_samples.clone(),
                meeting_header: job.header.clone(),
                running_summary: None,
                web_search: false,
                api_key: None,
                model: job.model.clone(),
                llm_base_url: Some(base_url.to_string()),
                llm_api_key: job.llm_api_key.clone(),
            })
        }
        "deepseek" => {
            let base_url = job
                .llm_base_url
                .as_deref()
                .ok_or_else(|| "DeepSeek endpoint is not configured".to_string())?;
            if normalized_url(base_url) != DEEPSEEK_BASE_URL {
                return Err("DeepSeek endpoint is invalid".to_string());
            }
            let api_key = job
                .llm_api_key
                .clone()
                .filter(|key| !key.trim().is_empty())
                .ok_or_else(|| {
                    "Add a DeepSeek API key in Settings › Live Copilot to use DeepSeek.".to_string()
                })?;
            Ok(CopilotAnswerRequest {
                provider: "deepseek".to_string(),
                schema_version: 7,
                standing_pack: job.standing_pack.clone(),
                recent_cards: job.recent_cards.clone(),
                resolved_question: job.resolved_question.clone(),
                answer_shape: answer_shape(job),
                question_source_tier: "confirmed".into(),
                question: job.question.clone(),
                question_source: job.question_source.clone(),
                context_turns: job.context_turns.clone(),
                stated_figures: Vec::new(),
                passages: egress_passages(&job.passages),
                persona: job.persona.clone(),
                voice_samples: job.voice_samples.clone(),
                meeting_header: job.header.clone(),
                running_summary: None,
                web_search: false,
                api_key: None,
                model: job.model.clone(),
                llm_base_url: Some(DEEPSEEK_BASE_URL.to_string()),
                llm_api_key: Some(api_key),
            })
        }
        _ => Err("Copilot provider is invalid".to_string()),
    }
}

fn normalized_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn validate_local_endpoint(base_url: &str, api_key: Option<&str>) -> Result<(), String> {
    let parsed = url::Url::parse(base_url)
        .map_err(|_| "Local engine is not a registered loopback endpoint".to_string())?;
    let loopback = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    let safe_shape = parsed.scheme() == "http"
        && loopback
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && matches!(parsed.path(), "" | "/" | "/v1")
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    let normalized = normalized_url(base_url);
    let mut registered = vec![
        "http://127.0.0.1:11434".to_string(),
        "http://127.0.0.1:11434/v1".to_string(),
    ];
    if let Some(host) = crate::setup::managed_ollama_host() {
        registered.push(normalized_url(&host));
    }
    let managed_rapid = crate::setup::managed_credentials().map(|(base, _)| normalized_url(&base));
    if let Some(base) = &managed_rapid {
        registered.push(base.clone());
    }
    if !safe_shape || !registered.iter().any(|candidate| candidate == &normalized) {
        return Err("Local engine is not a registered loopback endpoint".to_string());
    }
    if api_key.is_some() && managed_rapid.as_deref() != Some(normalized.as_str()) {
        return Err(
            "Local credentials are only valid for the registered managed engine".to_string(),
        );
    }
    Ok(())
}

fn request_bytes_without_credentials(request: &CopilotAnswerRequest) -> usize {
    let mut request = request.clone();
    request.api_key = None;
    request.llm_api_key = None;
    serde_json::to_vec(&request).map_or(0, |body| body.len())
}

/// The exact `CopilotAnswerRequest` that was sent, with `api_key` and
/// `llm_api_key` REMOVED (keys absent, not blanked). Never contains header values.
pub(crate) fn redacted_copilot_request(request: &CopilotAnswerRequest) -> serde_json::Value {
    let mut value = serde_json::to_value(request).unwrap_or(serde_json::Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.remove("api_key");
        object.remove("llm_api_key");
    }
    value
}

/// The per-card replay document stored in `copilot_cards.replay_json`. A
/// missing service frame (or a card that never dispatched) stores null while
/// the request side is still recorded.
pub(crate) fn build_replay_json(
    request: Option<serde_json::Value>,
    service: Option<serde_json::Value>,
) -> String {
    serde_json::json!({
        "v": 1,
        "request": request.unwrap_or(serde_json::Value::Null),
        "service": service.unwrap_or(serde_json::Value::Null),
    })
    .to_string()
}

fn store_replay_request(
    app: &AppHandle,
    session_id: &str,
    card_id: u64,
    request: serde_json::Value,
) {
    let state = app.state::<AppState>();
    let mut copilot = state.copilot.lock().unwrap();
    if let Some(active) = copilot
        .session
        .as_mut()
        .filter(|session| session.session_id == session_id)
        .and_then(|session| session.active.as_mut())
        .filter(|active| active.job.card_id == card_id && !active.job.terminal.is_written())
    {
        active.replay_request = Some(request);
    }
}

/// Persist the replay record for a finished card. A storage failure is logged
/// and never fails the card.
fn write_replay_record(action: &TerminalAction) {
    if action.job.row_id == 0 {
        return;
    }
    let replay_json =
        build_replay_json(action.replay_request.clone(), action.replay_service.clone());
    if let Err(error) = crate::storage::set_copilot_card_replay(
        &action.job.session_id,
        action.job.card_id,
        &replay_json,
    ) {
        eprintln!("[copilot] replay persistence failed: {error}");
    }
}

fn sanitize_citation(mut citation: CopilotCitation) -> CopilotCitation {
    citation.cited_text = citation.cited_text.map(|text| {
        crate::copilot_provenance::truncate_word_boundary(&text, MAX_PASSAGE_TEXT_CHARS)
    });
    citation.title = citation.title.map(|title| {
        crate::copilot_provenance::truncate_word_boundary(&title, MAX_PASSAGE_TITLE_CHARS)
    });
    citation.url = citation.url.map(|url| {
        crate::copilot_provenance::truncate_word_boundary(&url, MAX_PASSAGE_SOURCE_CHARS)
    });
    citation
}

fn classify_error(error: &str) -> &'static str {
    let lower = error.to_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else if lower.contains("token limit") || lower.contains("length") {
        "length"
    } else if lower.contains("ended") || lower.contains("eof") {
        "ended_early"
    } else if lower.contains("invalid") || lower.contains("validation") {
        "validation"
    } else if lower.contains("reach") || lower.contains("connect") || lower.contains("transport") {
        "transport"
    } else {
        "provider"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_jobs_and_retry_clones_freeze_folder_header_and_voice() {
        let mut session = session();
        (session.header, session.voice_samples) = freeze_folder_context(
            "Interview",
            "Me builds tools.",
            "So, here is how I work.",
            "In practice, I start small.",
        );
        let original = job(&mut session, "How do you build tools?");
        session.header = Some("Changed after preparation".into());
        session.voice_samples.clear();
        let retry = original.clone();
        assert_eq!(
            retry.header.as_deref(),
            Some("Purpose: Interview\nAbout Me: Me builds tools.")
        );
        assert_eq!(
            retry.voice_samples,
            ["So, here is how I work.", "In practice, I start small."]
        );
        let mut local = retry.clone();
        local.provider_frozen = "local".into();
        local.llm_base_url = Some("http://127.0.0.1:11434".into());
        let request = build_request(&local).unwrap();
        assert_eq!(request.meeting_header, retry.header);
        assert_eq!(request.voice_samples, retry.voice_samples);
        local.provider_frozen = "deepseek".into();
        local.llm_base_url = Some(DEEPSEEK_BASE_URL.into());
        local.llm_api_key = Some("test-key".into());
        let request = build_request(&local).unwrap();
        assert_eq!(request.meeting_header, retry.header);
        assert_eq!(request.voice_samples, retry.voice_samples);
    }

    #[test]
    fn folder_header_omits_empty_parts_and_empty_voice_samples() {
        assert_eq!(
            freeze_folder_context(" Interview ", "", "", " Second "),
            (Some("Purpose: Interview".into()), vec!["Second".into()])
        );
        assert_eq!(
            freeze_folder_context("", "Me builds tools.", "", ""),
            (Some("About Me: Me builds tools.".into()), vec![])
        );
        assert_eq!(freeze_folder_context(" ", "", "", " "), (None, vec![]));
    }

    #[test]
    fn frozen_folder_context_truncates_multibyte_text_by_bytes() {
        let sample = "é".repeat(350);
        assert_eq!(sample.len(), 700);
        let (header, samples) =
            freeze_folder_context("", &"界".repeat(600), &sample, &"界".repeat(234));
        let header = header.unwrap();
        assert!(header.len() <= 1600);
        assert!(header.len() >= 1598);
        assert_eq!(samples[0], "é".repeat(300));
        assert_eq!(samples[1], "界".repeat(200));
    }

    #[test]
    fn live_mode_defaults_and_session_override() {
        for mode in ["local", "no_ai", "claude", "deepseek"] {
            let enabled = mode != "no_ai";
            let mut session = CopilotSession::new("live".into(), 1, None, mode.into(), None, false);
            assert_eq!(session.live.enabled, enabled);
            assert_eq!(session.live.status, if enabled { "idle" } else { "off" });
            assert_eq!(session.live.started_at, session.started_at);
            session.live_enabled_override = Some(true);
            configure_live_mode(&mut session);
            assert_eq!(session.live.enabled, enabled);
            session.mode_override = Some("local".into());
            configure_live_mode(&mut session);
            assert!(session.live.enabled);
            session.live_enabled_override = Some(false);
            configure_live_mode(&mut session);
            assert!(!session.live.enabled);
            session.mode_override = Some("claude".into());
            configure_live_mode(&mut session);
            assert!(!session.live.enabled);
            session.mode_override = Some("local".into());
            configure_live_mode(&mut session);
            assert!(!session.live.enabled);
        }
    }

    #[test]
    fn live_review_is_enabled_in_cloud_modes_and_off_without_ai() {
        for mode in ["claude", "deepseek", "local"] {
            let mut session = CopilotSession::new("live".into(), 1, None, mode.into(), None, false);
            configure_live_mode(&mut session);
            assert!(session.live.enabled, "mode {mode}");
            assert_eq!(session.live.status, "idle");
            assert!(session.live.reason.is_none());
        }
        let mut off = CopilotSession::new("live".into(), 1, None, "no_ai".into(), None, false);
        configure_live_mode(&mut off);
        assert!(!off.live.enabled);
        assert_eq!(off.live.status, "off");
    }

    #[test]
    fn extraction_model_prefers_local_copilot_model_over_any_fallback() {
        assert_eq!(
            resolve_local_model(" qwen3.6-27b-4bit ", Some("fallback".into())),
            Some("qwen3.6-27b-4bit".into())
        );
        assert_eq!(
            resolve_local_model("  ", Some("fallback".into())),
            Some("fallback".into())
        );
        assert_eq!(resolve_local_model("", None), None);
    }

    fn live_extraction_in_flight() -> (CopilotSession, LiveExtractResponse) {
        let mut session = session();
        session.mode_override = Some("local".into());
        configure_live_mode(&mut session);
        copilot_live::push_turn(&mut session.live, "Me", "Prepare the demo", 10_000);
        copilot_live::set_status(&mut session.live, "updating", None);
        assert_eq!(
            copilot_live::start_extraction(&mut session.live, Instant::now()),
            1
        );
        let (request, covered) = copilot_live::build_request(
            &mut session.live,
            &session.session_id,
            "model",
            "x",
            false,
        );
        assert_eq!(covered, 1);
        let response = LiveExtractResponse {
            request_id: request.request_id,
            session_id: request.session_id,
            base_revision: request.base_revision,
            status: "ok".into(),
            reason: None,
            through_ms: Some(10_000),
            upserts: vec![crate::types::LiveUpsert {
                id: None,
                kind: "action".into(),
                text: "Demo".into(),
                owner: None,
                due: None,
                evidence_turn_ids: vec!["t1".into()],
                supersedes_id: None,
            }],
            retractions: vec![],
            summary: None,
        };
        (session, response)
    }

    #[test]
    fn live_result_after_review_adds_items_without_overwriting_accepted_item() {
        for action in ["edit", "edit_accept"] {
            let (session, response) = live_extraction_in_flight();
            let session_id = session.session_id.clone();
            let mut state = CopilotState {
                session: Some(session),
            };
            assert!(apply_live_extraction(&mut state, &session_id, 1, &response, 1).is_some());

            let session = state.session.as_mut().unwrap();
            copilot_live::push_turn(&mut session.live, "Them", "A new detail", 20_000);
            copilot_live::set_status(&mut session.live, "updating", None);
            let seq = copilot_live::start_extraction(&mut session.live, Instant::now());
            let (request, covered) =
                copilot_live::build_request(&mut session.live, &session_id, "model", "next", false);
            let id = session.live.items[0].id.clone();
            // live_review applies a cloned controller after persisting the review.
            let mut reviewed = session.live.clone();
            copilot_live::review(
                &mut reviewed,
                &id,
                action,
                Some("Founder edit"),
                None,
                None,
                "now",
            )
            .unwrap();
            session.live = reviewed;
            let accepted = session.live.items[0].clone();
            assert_eq!(accepted.status, "accepted");
            copilot_live::set_status(&mut session.live, "busy", None);
            configure_live_mode(session);
            assert!(session.live.revision > request.base_revision);
            assert_eq!(session.live.extract_seq, seq);

            let mut late = response;
            late.request_id = request.request_id.clone();
            late.base_revision = request.base_revision;
            late.through_ms = Some(20_000);
            late.upserts[0].id = Some(id.clone());
            late.upserts[0].text = "Model overwrite".into();
            late.upserts.push(crate::types::LiveUpsert {
                id: None,
                kind: "action".into(),
                text: "Follow up on the new detail".into(),
                owner: None,
                due: None,
                evidence_turn_ids: vec!["t2".into()],
                supersedes_id: Some(id.clone()),
            });
            late.retractions.push(crate::types::LiveRetraction {
                id,
                evidence_turn_ids: vec!["t2".into()],
                reason_code: "explicit_withdrawal".into(),
                withdrawal_quote: "scrap it".into(),
            });
            copilot_live::validate_response(&mut late, &request, session.live.through_ms).unwrap();

            assert!(apply_live_extraction(&mut state, &session_id, seq, &late, covered).is_some());
            let ctl = &state.session.as_ref().unwrap().live;
            assert_eq!(ctl.items.len(), 2);
            assert_eq!(ctl.items[0], accepted);
            assert_eq!(ctl.items[1].text, "Follow up on the new detail");
            assert_eq!(ctl.items[1].status, "proposed");
            assert_eq!(ctl.covered_upto_idx, 2);
            assert_eq!(ctl.through_ms, 20_000);
            assert_eq!(ctl.status, "idle");
        }
    }

    #[test]
    fn live_result_from_superseded_extraction_is_discarded() {
        let (mut session, response) = live_extraction_in_flight();
        let session_id = session.session_id.clone();
        let old_seq = session.live.extract_seq;
        let new_seq = copilot_live::start_extraction(&mut session.live, Instant::now());
        assert_eq!(new_seq, old_seq + 1);
        // The revision need not change when another extraction starts.
        assert_eq!(session.live.revision, response.base_revision);
        let before = copilot_live::snapshot(&session.live, &session_id);
        let mut state = CopilotState {
            session: Some(session),
        };
        assert!(apply_live_extraction(&mut state, &session_id, old_seq, &response, 1).is_none());
        let ctl = &state.session.as_ref().unwrap().live;
        assert_eq!(copilot_live::snapshot(ctl, &session_id), before);
        assert_eq!(ctl.extract_seq, new_seq);
        assert_eq!(ctl.status, "updating");
        assert_eq!(ctl.consecutive_errors, 0);
        assert!(ctl.backoff_until.is_none());
    }

    #[test]
    fn live_result_after_retire_is_discarded() {
        let (session, response) = live_extraction_in_flight();
        let session_id = session.session_id.clone();
        let seq = session.live.extract_seq;
        let before = copilot_live::snapshot(&session.live, &session_id);
        let mut state = CopilotState {
            session: Some(session),
        };
        let retired = take_session_if_expected(&mut state.session, Some(&session_id)).unwrap();
        retired.token.cancel();
        assert!(apply_live_extraction(&mut state, &session_id, seq, &response, 1).is_none());
        assert!(state.session.is_none());

        // Cancellation also rejects the result if the session is still in the slot.
        state.session = Some(retired);
        assert!(apply_live_extraction(&mut state, &session_id, seq, &response, 1).is_none());
        assert_eq!(
            copilot_live::snapshot(&state.session.as_ref().unwrap().live, &session_id),
            before
        );
    }

    #[test]
    fn live_result_from_replaced_session_is_discarded() {
        let (previous, response) = live_extraction_in_flight();
        let (current, _) = live_extraction_in_flight();
        assert_eq!(previous.live.extract_seq, current.live.extract_seq);
        let before = copilot_live::snapshot(&current.live, &current.session_id);
        let mut state = CopilotState {
            session: Some(current),
        };
        assert!(apply_live_extraction(
            &mut state,
            &previous.session_id,
            previous.live.extract_seq,
            &response,
            1,
        )
        .is_none());
        let current = state.session.as_ref().unwrap();
        assert_eq!(
            copilot_live::snapshot(&current.live, &current.session_id),
            before
        );
    }

    #[test]
    fn live_access_rejects_unknown_and_cancelled_sessions() {
        let mut state = CopilotState {
            session: Some(session()),
        };
        let id = state.session.as_ref().unwrap().session_id.clone();
        assert!(live_session_mut(&mut state, "missing").is_none());
        assert!(live_session_mut(&mut state, &id).is_some());
        state.session.as_ref().unwrap().token.cancel();
        assert!(live_session_mut(&mut state, &id).is_none());
        state.session = None;
        assert!(live_session_mut(&mut state, &id).is_none());
    }

    fn session() -> CopilotSession {
        CopilotSession::new(
            uuid::Uuid::new_v4().to_string(),
            1,
            None,
            "no_ai".into(),
            Some("Be concise".into()),
            true,
        )
    }

    fn job(session: &mut CopilotSession, question: &str) -> CopilotJob {
        let mut job = prepare_job(session, question, "Them", Vec::new(), None, "auto").unwrap();
        job.announced = true;
        job
    }

    fn section(section: &str, index: u32, text: &str) -> CopilotFrame {
        CopilotFrame::Section {
            section: section.into(),
            index,
            text: text.into(),
            drop: false,
        }
    }

    #[test]
    fn interview_requires_a_wake_word_for_me_and_strips_it() {
        let mut session = session();
        assert!(detect_turn(&mut session, "Me", "Who founded OpenAI?")
            .into_iter()
            .next()
            .is_none());
        let candidate = detect_turn(&mut session, "Me", "copilot, Who founded OpenAI?")
            .into_iter()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(candidate.question, "Who founded OpenAI?");
        assert_eq!(
            candidate.resolved_question.as_deref(),
            Some("Who founded OpenAI?")
        );
        assert!(!candidate.gate_needed);
        assert!(candidate.gate_request.is_none());
        assert_eq!(candidate.policy_reason, "direct_question");
        assert!(detect_turn(&mut session, "Them", "What is a semaphore?")
            .into_iter()
            .next()
            .unwrap()
            .is_ok());
    }

    #[test]
    fn self_ask_soft_gap_only_suppresses_me_without_a_question_mark() {
        let mut session = session();
        session.mic_questions = true;
        assert!(detect_turn(&mut session, "Me", "Who founded Anthropic?")
            .pop()
            .unwrap()
            .is_ok());
        assert_eq!(session.last_auto_source.as_deref(), Some("Me"));
        session.last_auto_asked = Some(Instant::now() - Duration::from_secs(6));
        assert!(detect_turn(
            &mut session,
            "Me",
            "What's the difference between a semaphore and a mutex?"
        )
        .pop()
        .unwrap()
        .is_ok());
        assert_eq!(session.recent_norms.len(), 2);
        assert!(detect_turn(
            &mut session,
            "Me",
            "Tell me about the ERDC platform you built."
        )
        .pop()
        .unwrap()
        .is_err());
        assert!(detect_turn(&mut session, "Them", "What is Kubernetes?")
            .pop()
            .unwrap()
            .is_ok());
        assert_eq!(session.last_auto_source.as_deref(), Some("Them"));
        // Non-question Me prompts still wait after either speaker's card.
        assert!(
            detect_turn(&mut session, "Me", "Explain how Rust ownership works.")
                .pop()
                .unwrap()
                .is_err()
        );
        session.last_auto_asked = Some(Instant::now() - AUTO_SOFT_GAP);
        assert!(
            detect_turn(&mut session, "Me", "Explain how Rust ownership works.")
                .pop()
                .unwrap()
                .is_ok()
        );
        assert!(
            detect_turn(&mut session, "Them", "Describe the platform you built.")
                .pop()
                .unwrap()
                .is_ok()
        );
    }

    #[test]
    fn two_questions_from_one_turn_persist_and_run_as_one_card() {
        let conn = crate::storage::in_memory_db();
        let mut session = session();
        session.mic_questions = true;
        crate::storage::insert_copilot_session_on(&conn, &session.session_id, None, "no_ai", "now")
            .unwrap();
        let turn =
            "Who founded Anthropic? How would you design a RAG pipeline for procurement documents?";
        let jobs = detect_turn(&mut session, "Me", turn);
        assert_eq!(jobs.len(), 1);
        let mut job = jobs.into_iter().next().unwrap().unwrap();
        assert_eq!(job.question, turn);
        assert!(!job.gate_needed);
        persist_job_on(&conn, &mut job).unwrap();
        job.announced = true;
        let queued = queue_prepared_job(&mut session, job, false);
        assert!(queued.replaced.is_empty());
        assert_eq!(queued.heard.question, turn);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM copilot_cards", [], |row| row
                .get::<_, usize>(0))
                .unwrap(),
            1
        );
        let (job, _) = session.activate_waiting().unwrap();
        assert_eq!(job.question, turn);
        session.take_active(job.card_id, "done", None).unwrap();
        assert!(session.activate_waiting().is_none());
    }

    #[test]
    fn merged_turn_obeys_intent_suppression() {
        let mut session = session();
        session.mic_questions = true;
        let results = detect_turn(&mut session, "Me", "What are LLMs? Hello, what are LLM's?");
        assert_eq!(results.len(), 1);
        assert!(results.into_iter().next().unwrap().is_ok());
        assert_eq!(session.recent_norms.len(), 1);
        let results = detect_turn(&mut session, "Me", "What are LLMs? Hello, what are LLM's?");
        assert_eq!(results.len(), 1);
        assert!(results.into_iter().next().unwrap().is_err());
        let results = detect_turn(&mut session, "Me", "What is it? What is it?");
        assert_eq!(results.len(), 1);
        assert!(results.into_iter().next().unwrap().unwrap().gate_needed);
    }

    #[test]
    fn gated_multi_question_turn_sends_whole_turn_with_prior_context_only() {
        let mut session = session();
        let turn = "What is a semaphore? It limits access. How does Rust ownership work?";
        let jobs = detect_turn(&mut session, "Them", turn);
        assert_eq!(jobs.len(), 1);
        let job = jobs.into_iter().next().unwrap().unwrap();
        assert!(job.gate_needed);
        assert_eq!(
            job.question,
            "What is a semaphore? How does Rust ownership work?"
        );
        let gate = job.gate_request.unwrap();
        assert_eq!(gate.candidate, turn);
        assert!(gate.context_turns.is_empty());
    }

    #[test]
    fn multi_question_answer_context_carries_chunked_turn_within_limit() {
        let mut session = session();
        session.mic_questions = true;
        for index in 0..9 {
            session.push_dialogue_turn(
                "Them",
                &format!("Prior discussion point number {index} about deployment pipelines."),
            );
        }
        let turn = "Let's say you have a hundred million documents. How will you use RAG? How will you make rag efficient?";
        let jobs = detect_turn(&mut session, "Them", turn);
        assert_eq!(jobs.len(), 1);
        let job = jobs.into_iter().next().unwrap().unwrap();
        assert_eq!(
            job.question,
            "How will you use RAG? How will you make rag efficient?"
        );
        assert!(!job.gate_needed);
        assert!(job.context_turns.len() <= session.context_limit());
        let last = job.context_turns.last().unwrap();
        assert_eq!(last, &format!("Them: {turn}"));
    }

    #[test]
    fn mic_soft_gap_treats_turn_with_a_question_as_a_question() {
        let mut session = session();
        session.mic_questions = true;
        assert!(detect_turn(&mut session, "Me", "What is a semaphore?")
            .pop()
            .unwrap()
            .is_ok());
        assert_eq!(session.last_auto_source.as_deref(), Some("Me"));
        session.last_auto_asked = Some(Instant::now());
        let result = detect_turn(&mut session, "Me", "What is Rust? Explain ownership.")
            .pop()
            .unwrap();
        assert!(result.is_ok());
        assert_eq!(result.unwrap().question, "What is Rust?");
    }

    #[test]
    fn new_turn_supersedes_both_waiting_candidates_without_touching_active() {
        let mut session = session();
        let active = job(&mut session, "What is Kubernetes?");
        session.accept_waiting(active);
        session.activate_waiting().unwrap();
        let first = job(&mut session, "Who founded Anthropic?");
        queue_prepared_job(&mut session, first, false);
        let second = job(&mut session, "How does a RAG pipeline work?");
        queue_prepared_job(&mut session, second, true);
        let next = job(&mut session, "What is a semaphore?");
        let queued = queue_prepared_job(&mut session, next, false);
        assert_eq!(
            queued
                .replaced
                .iter()
                .map(|job| job.card_id)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(session.waiting.len(), 1);
        assert_eq!(session.waiting.front().unwrap().card_id, 4);
        assert_eq!(session.active.as_ref().unwrap().job.card_id, 1);
    }

    #[test]
    fn live_extraction_filters_card_questions_beyond_the_recent_intent_cache() {
        let (mut session, mut response) = live_extraction_in_flight();
        let question = "What's the difference between a knowledge graph and a mind map?";
        session.remember_question(question, "Me", "auto");
        for index in 0..40 {
            session.remember_question(&format!("Who owns project {index}?"), "Them", "auto");
        }
        assert!(!session
            .recent_norms
            .iter()
            .any(|(norm, _, _)| norm == &CopilotSession::norm(question)));
        response.upserts[0].kind = "question".into();
        response.upserts[0].text = question.into();
        let session_id = session.session_id.clone();
        let mut state = CopilotState {
            session: Some(session),
        };
        let snapshot = apply_live_extraction(&mut state, &session_id, 1, &response, 1).unwrap();
        assert!(snapshot.items.is_empty());
        assert_eq!(snapshot.through_ms, 10_000);
    }

    #[test]
    fn offline_eval_card_194_is_suppressed_thirteen_seconds_after_189() {
        let mut session = session();
        session.mic_questions = true;
        detect_turn(&mut session, "Me", "What are LLMs?")
            .into_iter()
            .next()
            .unwrap()
            .unwrap();
        let thirteen_seconds_ago = Instant::now() - Duration::from_secs(13);
        session.last_auto_asked = Some(thirteen_seconds_ago);
        session.recent_norms[0].2 = thirteen_seconds_ago;
        assert_eq!(
            session.auto_suppression("Hello, what are LLM's?", "Me"),
            Some("same_intent")
        );
        assert!(detect_turn(&mut session, "Me", "Hello, what are LLM's?")
            .into_iter()
            .next()
            .unwrap()
            .is_err());
        assert_eq!(session.recent_norms.len(), 1);
    }

    #[test]
    fn intent_similarity_obeys_threshold_window_and_empty_sets() {
        let mut session = session();
        session.remember_question("alpha bravo charlie", "Them", "auto");
        assert!(session.is_recent_intent("alpha bravo charlie delta echo?"));
        assert!(!session.is_recent_intent("alpha bravo delta?"));
        session.recent_norms[0].2 = Instant::now() - Duration::from_secs(119);
        assert!(session.is_recent_intent("ALPHA BRAVO CHARLIE!"));
        session.recent_norms[0].2 = Instant::now() - INTENT_WINDOW;
        assert!(!session.is_recent_intent("alpha bravo charlie"));
        session.remember_question("What is it?", "Them", "auto");
        assert!(!session.is_recent_intent("Who is he?"));
    }

    #[test]
    fn manual_bypasses_mode_classifier_gap_and_recent_intent() {
        let mut session = session();
        session.remember_question("What are LLMs?", "Them", "auto");
        assert!(!session.mic_questions);
        let candidate = prepare_job(
            &mut session,
            "Hello, what are LLM's?",
            "Me",
            vec![],
            None,
            "manual",
        )
        .unwrap();
        assert!(!candidate.gate_needed);
        assert_eq!(candidate.question_source, "Me");
        assert!(prepare_job(
            &mut session,
            "This is my local copilot.",
            "Me",
            vec![],
            None,
            "manual"
        )
        .is_ok());
    }

    #[test]
    fn gated_request_freezes_full_turn_context_mode_and_last_three_questions() {
        let mut session = session();
        session.mode_override = Some("local".into());
        session.mic_questions = true;
        for index in 0..10 {
            session.push_dialogue_turn("Them", &format!("Earlier turn {index}"));
        }
        for index in 0..4 {
            session.remember_question(&format!("Earlier question {index}?"), "Them", "manual");
        }
        let turn = "Who founded OpenAI? Sam Altman helped found it.";
        let candidate = detect_turn(&mut session, "Me", turn)
            .into_iter()
            .next()
            .unwrap()
            .unwrap();
        assert!(candidate.gate_needed);
        assert_eq!(candidate.resolved_question, None);
        assert_eq!(candidate.question, "Who founded OpenAI?");
        let request = candidate.gate_request.as_ref().unwrap();
        assert_eq!(request.candidate, turn);
        assert_eq!(request.context_turns, session.context_before(turn));
        assert_eq!(request.context_turns.len(), 8);
        assert_eq!(request.mode, "self_ask");
        assert_eq!(request.speaker, "Me");
        assert_eq!(
            request.recent_questions,
            [
                "Earlier question 1?",
                "Earlier question 2?",
                "Earlier question 3?"
            ]
        );
        assert_eq!(session.recent_norms.len(), 4); // No card exists for a pending gate.
        assert!(session.last_auto_asked.is_none());
    }

    fn gate_answer(question: &str) -> Result<GateResponse, String> {
        Ok(GateResponse {
            action: "answer".into(),
            resolved_question: Some(question.into()),
            reason_code: "embedded_question".into(),
        })
    }

    fn backend_error() -> Result<GateResponse, String> {
        Ok(GateResponse {
            action: "ignore".into(),
            resolved_question: None,
            reason_code: "backend_error".into(),
        })
    }

    fn genuine_ignore(reason: &str) -> Result<GateResponse, String> {
        Ok(GateResponse {
            action: "ignore".into(),
            resolved_question: None,
            reason_code: reason.into(),
        })
    }

    /// A backend failure is its own outcome: only `starter_only` (the sole
    /// defect was a missing `?`) and `direct_question` fire, with no rewrite.
    #[test]
    fn gate_fallback_fires_only_for_starter_only_and_direct_question() {
        let timeout: Result<GateResponse, String> =
            Err("Copilot gate request failed: request to /copilot/gate timed out".into());
        let http: Result<GateResponse, String> =
            Err("Copilot gate failed: 500 Internal Server Error".into());
        // (ambiguity reason, fires)
        let cases = [
            ("starter_only", true),
            ("direct_question", true),
            ("possibly_answered_in_turn", false),
            ("bare_pronoun", false),
            ("long_turn", false),
            ("embedded_question", false),
        ];
        for (reason, fires) in cases {
            for result in [timeout.clone(), http.clone(), backend_error()] {
                let (fired, resolved, policy) = gate_resolution(reason, result);
                assert_eq!(fired, fires, "reason={reason}");
                // A firing fallback keeps `resolved_question` as `None` so
                // retrieval still uses `previous_them` and the UI shows no
                // "Understood as:".
                assert_eq!(resolved, None, "reason={reason}");
                assert_eq!(policy, "gate_fallback", "reason={reason}");
            }
        }
        // The exact shapes from the 2026-09-22 incident and the contract,
        // classified end to end: the pre-gate reason drives the fallback.
        let incident = [
            ("what is a mixture of experts model", "starter_only", true),
            ("What is XGBoost?", "direct_question", true),
            (
                "How does caching work? It stores previous results.",
                "possibly_answered_in_turn",
                false,
            ),
            ("Why did they do that?", "bare_pronoun", false),
            (
                "So for example, who is the founder of OpenAI? Bye.",
                "embedded_question",
                false,
            ),
        ];
        for (candidate, reason, fires) in incident {
            let classified = crate::copilot::classify_candidates(candidate);
            assert_eq!(classified.len(), 1, "candidate={candidate}");
            assert_eq!(classified[0].reason, reason, "candidate={candidate}");
            for result in [
                Err::<GateResponse, String>("Copilot gate request failed: timed out".into()),
                Err::<GateResponse, String>("Copilot gate failed: 500".into()),
                backend_error(),
            ] {
                let (fired, resolved, policy) = gate_resolution(classified[0].reason, result);
                assert_eq!(fired, fires, "candidate={candidate}");
                assert_eq!(resolved, None, "candidate={candidate}");
                assert_eq!(policy, "gate_fallback", "candidate={candidate}");
            }
        }
        let long_turn = "We spent the morning reviewing the quarterly deployment pipeline metrics and the new caching layer design for the checkout service across three regions with automatic failover and detailed observability dashboards tracking latency percentiles across every availability zone, so what is the rollout plan for Friday?";
        let classified = crate::copilot::classify_candidates(long_turn);
        assert_eq!(classified.len(), 1);
        assert_eq!(classified[0].reason, "long_turn");
        let (fired, resolved, policy) = gate_resolution(classified[0].reason, backend_error());
        assert!(!fired);
        assert_eq!(resolved, None);
        assert_eq!(policy, "gate_fallback");
    }

    #[test]
    fn gate_genuine_model_verdicts_are_never_reinterpreted() {
        // A genuine model `ignore` stays suppressed whatever its reason.
        for reason in [
            "narration",
            "answered_in_turn",
            "repeat",
            "no_request",
            "unclear",
            "direct_question",
            "embedded_question",
        ] {
            assert_eq!(
                gate_resolution("starter_only", genuine_ignore(reason)),
                (false, None, reason.to_string()),
                "reason={reason}"
            );
        }
        // An answer with a rewrite keeps the rewrite, even for a reason the
        // fallback would suppress.
        assert_eq!(
            gate_resolution(
                "possibly_answered_in_turn",
                gate_answer("  Who established OpenAI?  ")
            ),
            (
                true,
                Some("Who established OpenAI?".to_string()),
                "embedded_question".to_string()
            )
        );
    }

    #[test]
    fn accepted_gate_persists_resolved_question_and_event_uses_it() {
        let conn = crate::storage::in_memory_db();
        let mut session = session();
        crate::storage::insert_copilot_session_on(&conn, &session.session_id, None, "no_ai", "now")
            .unwrap();
        let mut candidate = detect_turn(
            &mut session,
            "Them",
            "Who founded OpenAI? Sam Altman helped found it.",
        )
        .into_iter()
        .next()
        .unwrap()
        .unwrap();
        assert_eq!(candidate.row_id, 0);
        assert!(!candidate.announced);
        session.accept_waiting(candidate.clone());
        assert!(session.activate_waiting().is_some());
        candidate.resolved_question = gate_resolution(
            candidate.policy_reason,
            gate_answer("Who established OpenAI?"),
        )
        .1;
        assert!(accept_gated_on(&mut session, &conn, &mut candidate).unwrap());
        assert!(session.card_questions.contains(&candidate.question));
        assert!(session
            .card_questions
            .contains(&"Who established OpenAI?".to_string()));
        assert!(!candidate.gate_needed);
        assert_eq!(
            retrieval_question(&candidate),
            ("Who established OpenAI?", None)
        );
        let stored: String = conn
            .query_row(
                "SELECT resolved_question FROM copilot_cards WHERE id = ?1",
                [candidate.row_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, "Who established OpenAI?");
        let event = card_event(&candidate, "heard", vec![], None, None);
        assert_eq!(event.question, "Who founded OpenAI?");
        assert_eq!(event.resolved_question.as_deref(), Some(stored.as_str()));
    }

    #[test]
    fn ignored_gate_has_no_history_or_retry_snapshot() {
        let conn = crate::storage::in_memory_db();
        let mut session = session();
        let candidate = detect_turn(
            &mut session,
            "Them",
            "Who founded OpenAI? Sam Altman helped found it.",
        )
        .into_iter()
        .next()
        .unwrap()
        .unwrap();
        let id = candidate.card_id;
        session.accept_waiting(candidate);
        session.activate_waiting().unwrap();
        session.take_active(id, "skipped", None).unwrap();
        assert!(session.active.is_none());
        assert!(session.active_norm.is_none());
        assert!(session.recent_norms.is_empty());
        assert!(session.recent_questions.is_empty());
        assert!(session.last_auto_asked.is_none());
        assert!(session.terminal_jobs.is_empty());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM copilot_cards", [], |row| row
                .get::<_, usize>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn gate_rechecks_intent_before_inserting_a_card() {
        let conn = crate::storage::in_memory_db();
        let mut session = session();
        let mut candidate = detect_turn(
            &mut session,
            "Them",
            "What is a semaphore? It limits concurrent access.",
        )
        .into_iter()
        .next()
        .unwrap()
        .unwrap();
        session.remember_question("What is a semaphore?", "Them", "auto");
        candidate.resolved_question = Some(candidate.question.clone());
        assert!(!accept_gated_on(&mut session, &conn, &mut candidate).unwrap());
        assert_eq!(candidate.row_id, 0);
        assert!(!candidate.announced);
    }

    #[tokio::test]
    async fn gate_wait_obeys_card_and_session_cancellation() {
        for cancel_card in [true, false] {
            let card = CancellationToken::new();
            let session = CancellationToken::new();
            let cancelled = if cancel_card {
                card.clone()
            } else {
                session.clone()
            };
            let gate = async move {
                cancelled.cancel();
                std::future::pending::<Result<GateResponse, String>>().await
            };
            assert!(select_request_or_cancellation(&card, &session, gate)
                .await
                .is_none());
        }
    }

    #[test]
    fn mic_questions_gates_me_channel_detection() {
        let mut session = session();
        assert!(!session.mic_questions);
        assert!(detect_turn(&mut session, "Me", "what is a semaphore?")
            .into_iter()
            .next()
            .is_none());
        assert!(session.recent_norms.is_empty());
        assert!(detect_turn(&mut session, "Them", "what is a mutex?")
            .into_iter()
            .next()
            .unwrap()
            .is_ok());
        session.mic_questions = true;
        session.last_auto_asked = Some(Instant::now() - AUTO_SOFT_GAP);
        let detected = detect_turn(&mut session, "Me", "what is a semaphore?")
            .into_iter()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(detected.question_source, "Me");
        assert_eq!(detected.trigger, "auto");
        assert!(
            detect_turn(&mut session, "Me", "Thanks for the explanation.")
                .into_iter()
                .next()
                .is_none()
        );
    }

    #[test]
    fn mic_questions_setting_requires_an_active_session() {
        let state = AppState::new();
        assert_eq!(
            set_mic_questions(&state, true),
            Err("No active Copilot session".into())
        );
        state.copilot.lock().unwrap().session = Some(session());
        set_mic_questions(&state, true).unwrap();
        assert!(
            state
                .copilot
                .lock()
                .unwrap()
                .session
                .as_ref()
                .unwrap()
                .mic_questions
        );
        set_mic_questions(&state, false).unwrap();
        assert!(
            !state
                .copilot
                .lock()
                .unwrap()
                .session
                .as_ref()
                .unwrap()
                .mic_questions
        );
    }

    #[test]
    fn auto_intent_window_is_one_hundred_twenty_seconds() {
        let mut session = session();
        job(&mut session, "What is a semaphore?");
        let duplicate = prepare_job(
            &mut session,
            "WHAT is a semaphore!",
            "Them",
            vec![],
            None,
            "auto",
        );
        assert_eq!(
            duplicate.err().as_deref(),
            Some("Question is already in progress")
        );
        session.recent_norms[0].2 = Instant::now() - Duration::from_secs(121);
        assert!(prepare_job(
            &mut session,
            "What is a semaphore?",
            "Them",
            vec![],
            None,
            "auto"
        )
        .is_ok());
        for _ in 0..2 {
            assert!(prepare_job(
                &mut session,
                "What is a semaphore?",
                "Them",
                vec![],
                None,
                "manual"
            )
            .is_ok());
        }
        assert_eq!(session.recent_norms.len(), 4);
        for index in 0..40 {
            job(&mut session, &format!("What is item{index}?"));
        }
        assert_eq!(session.recent_norms.len(), 32);
        assert_eq!(session.recent_norms.front().unwrap().0, "what is item8");
    }

    #[test]
    fn ask_last_uses_any_channel_when_mic_questions() {
        let mut session = session();
        for fallback in [false, true] {
            assert_eq!(
                select_last_question(&session, fallback),
                Err("No speech heard yet".into())
            );
        }
        session.last_them = Some("What is a mutex?".into());
        session.last_me = Some("What is a semaphore?".into());
        session.last_any = session.last_me.clone();
        session.last_any_source = "Me";
        assert_eq!(
            select_last_question(&session, false).unwrap(),
            ("What is a mutex?".into(), "Them")
        );
        assert_eq!(
            select_last_question(&session, true).unwrap(),
            ("What is a semaphore?".into(), "Me")
        );
        session.mic_questions = true;
        assert_eq!(
            select_last_question(&session, false).unwrap(),
            ("What is a semaphore?".into(), "Me")
        );
        session.last_any = Some("What is backpressure?".into());
        session.last_any_source = "Them";
        assert_eq!(
            select_last_question(&session, true).unwrap(),
            ("What is backpressure?".into(), "Them")
        );
    }

    #[test]
    fn manual_answer_walks_back_past_greeting_to_question() {
        let mut session = session();
        session.push_dialogue_turn("Me", "I am planning the release.");
        session.push_dialogue_turn("Them", "What is RAG?");
        session.push_dialogue_turn("Them", "That makes sense overall.");
        session.push_dialogue_turn("Them", "Hello");
        let selection = select_manual_turn(&session, false).unwrap();
        assert_eq!(selection.question, "What is RAG?");
        assert_eq!(selection.source, "Them");
        // Context holds only the turns strictly before the selected question.
        assert_eq!(selection.context, vec!["Me: I am planning the release."]);
        assert_eq!(selection.previous, None);
    }

    #[test]
    fn manual_answer_walks_back_past_greeting_prefixed_pleasantry() {
        let mut session = session();
        session.push_dialogue_turn("Them", "Why is LangGraph so popular compared to CrewAI?");
        session.push_dialogue_turn("Me", "Hello, can you hear me?");
        let selection = select_manual_turn(&session, false).unwrap();
        assert_eq!(
            selection.question,
            "Why is LangGraph so popular compared to CrewAI?"
        );
        assert_eq!(selection.source, "Them");
        assert!(selection.context.is_empty());
        assert_eq!(selection.previous, None);
    }

    #[test]
    fn manual_answer_picks_newest_duplicate_and_filters_speakers() {
        let mut repeated = session();
        repeated.push_dialogue_turn("Them", "What is RAG?");
        repeated.push_dialogue_turn("Them", "What is RAG?");
        let selection = select_manual_turn(&repeated, false).unwrap();
        assert_eq!(selection.question, "What is RAG?");
        assert_eq!(selection.context, vec!["Them: What is RAG?"]);

        let mut mixed = session();
        mixed.push_dialogue_turn("Them", "What is RAG?");
        mixed.push_dialogue_turn("Me", "What is a semaphore?");
        let selection = select_manual_turn(&mixed, false).unwrap();
        assert_eq!(selection.question, "What is RAG?");
        assert_eq!(selection.source, "Them");
        assert!(selection.context.is_empty());
        let selection = select_manual_turn(&mixed, true).unwrap();
        assert_eq!(selection.question, "What is a semaphore?");
        assert_eq!(selection.source, "Me");
        assert_eq!(selection.context, vec!["Them: What is RAG?"]);
    }

    #[test]
    fn manual_answer_ignores_a_question_seven_turns_back() {
        let mut session = session();
        session.push_dialogue_turn("Them", "What is RAG?");
        for index in 0..6 {
            session.push_dialogue_turn("Them", &format!("Status update number {index} reported."));
        }
        session.last_them = Some("Status update number 5 reported.".into());
        session.last_any = session.last_them.clone();
        session.last_any_source = "Them";
        let selection = select_manual_turn(&session, false).unwrap();
        assert_eq!(selection.question, "Status update number 5 reported.");
    }

    #[test]
    fn manual_answer_finds_a_question_past_the_context_truncation() {
        let mut session = session();
        let turn = format!("{} What is RAG?", "context ".repeat(120));
        assert!(turn.chars().count() > MAX_CONTEXT_TURN_CHARS);
        session.push_dialogue_turn("Them", &turn);
        session.push_dialogue_turn("Them", "Hello");
        let selection = select_manual_turn(&session, false).unwrap();
        assert_eq!(selection.question, turn);
        assert!(selection.context.is_empty());
    }

    #[test]
    fn manual_answer_bypasses_the_gate() {
        let mut session = session();
        session.push_dialogue_turn("Them", "What is RAG?");
        let selection = select_manual_turn(&session, false).unwrap();
        let job = prepare_job(
            &mut session,
            &selection.question,
            selection.source,
            selection.context,
            selection.previous,
            "manual",
        )
        .unwrap();
        assert!(!job.gate_needed);
        assert!(job.gate_request.is_none());
    }

    #[test]
    fn local_context_window_is_eight_turns() {
        let mut session = session();
        for index in 0..10 {
            session.push_dialogue_turn(
                if index % 2 == 0 { "Me" } else { "Them" },
                &format!("Turn {index}"),
            );
        }
        assert_eq!(session.recent_dialogue.len(), 9);
        for (mode, limit, first) in [("local", 8, "Me: Turn 2"), ("claude", 4, "Me: Turn 6")] {
            session.mode_override = Some(mode.into());
            let context = session.context_before("What comes next?");
            assert_eq!(context.len(), limit);
            assert_eq!(context[0], first);
            assert_eq!(context.last().unwrap(), "Them: Turn 9");
            assert_eq!(session.context_before("Turn 9").len(), limit);
            let prepared = prepare_job(
                &mut session,
                "What comes next?",
                "Me",
                context,
                None,
                "manual",
            )
            .unwrap();
            assert_eq!(prepared.context_turns.len(), limit);
        }
    }

    #[test]
    fn sections_accumulate_and_terminal_builds_markdown() {
        let mut session = session();
        let mut pending = job(&mut session, "What did you build with 12 workers?");
        pending.provider_frozen = "local".into();
        pending.passages = vec![CopilotPassage {
            source_kind: "notes".into(),
            source_id: "notes".into(),
            title: "Notes".into(),
            text: "We used a bounded queue to limit memory.".into(),
            score: 1.0,
        }];
        session.accept_waiting(pending);
        session.activate_waiting().unwrap();
        let active = session.active.as_mut().unwrap();
        // Out-of-order sections and item indices must accumulate independently.
        let frames = [
            section("next", 7, "How does "),
            section("specific", 1, " Bound worker count. "),
            section("notes", 0, "P1 | \"bounded "),
            section("say", 20, "I used 12 workers and saved 40%."),
            section("specific", 0, "Apply "),
            section("notes", 0, "queue\" | bounds memory"),
            section("notes", 1, "P1 | \"invented claim\" | unsupported"),
            section("notes", 2, "P2 | \"bounded queue\" | bad index"),
            section("specific", 0, "backpressure."),
            section("say", 0, "A semaphore permits 99 workers."),
            section("next", 0, "it recover? "),
        ];
        let events: Vec<_> = frames
            .into_iter()
            .flat_map(|frame| apply_section_frame(active, frame))
            .collect();
        assert!(events.iter().all(|event| event.kind == "delta"
            && event.section.is_some()
            && event.index.is_some()));
        let say: Vec<_> = events
            .iter()
            .filter(|event| event.section.as_deref() == Some("say"))
            .collect();
        assert_eq!(
            say[0].text.as_deref(),
            Some("I used 12 workers and saved [number]%.")
        );
        assert_eq!(say[0].index, Some(0));
        assert_eq!(say[1].index, Some(1));
        assert_eq!(events[0].index, Some(0));
        assert!(apply_section_frame(active, section("specific", 5, "Dropped.")).is_empty());
        assert!(apply_section_frame(active, section("notes", u32::MAX, "Dropped.")).is_empty());
        let active = session.take_active(1, "done", None).unwrap();
        let mut action = TerminalAction::active(active, "done", None, None);
        finalize_sections(&mut action);
        assert_eq!(action.sections.notes.len(), 1);
        assert_eq!(action.answer_md, "SAY: I used 12 workers and saved [number]%. A semaphore permits 99 workers.\nSPECIFIC: Apply backpressure.\nSPECIFIC: Bound worker count.\nNOTES: P1 | \"bounded queue\" | bounds memory\nNEXT: How does it recover?");
        let once = action.sections.clone();
        finalize_sections(&mut action);
        assert_eq!(
            action.sections, once,
            "a persistence retry must be idempotent"
        );

        let conn = crate::storage::in_memory_db();
        let at = "2026-09-07T00:00:00Z";
        crate::storage::insert_copilot_session_on(&conn, &action.job.session_id, None, "local", at)
            .unwrap();
        let row_id = crate::storage::insert_copilot_card_v2_on(
            &conn,
            &action.job.session_id,
            action.job.card_id,
            None,
            "local",
            "auto",
            None,
            &action.job.question,
            at,
        )
        .unwrap();
        let provenance = crate::copilot_provenance::bullets_from_sections(
            &action.sections,
            &action.job.passages,
            &action.citations,
            action.web_performed,
        );
        let provenance_json = serde_json::to_string(&provenance).unwrap();
        let passages_json = serde_json::to_string(&action.job.passages).unwrap();
        crate::storage::finish_copilot_card_v2(
            &conn,
            row_id,
            &crate::storage::CopilotTerminalUpdate {
                status: "done",
                reason: None,
                passages_json: &passages_json,
                answer_md: Some(&action.answer_md),
                provenance_json: Some(&provenance_json),
                error: None,
                egress_bytes: 0,
                web_requested: false,
                web_performed: 0,
                dispatched: true,
                finished_at: at,
            },
        )
        .unwrap();
        let stored: (String, String) = conn
            .query_row(
                "SELECT answer_md, provenance_json FROM copilot_cards WHERE id = ?1",
                [row_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored, (action.answer_md, provenance_json));
    }

    #[test]
    fn dropped_section_items_are_removed_and_emit_empty_drop_deltas() {
        for name in ["notes", "specific"] {
            let mut session = session();
            let mut pending = job(&mut session, "How do you bound memory?");
            pending.passages = vec![CopilotPassage {
                source_kind: "folder".into(),
                source_id: "/sources/notes.md".into(),
                title: "Notes".into(),
                text: "We used a bounded queue to limit memory.".into(),
                score: 0.8,
            }];
            session.accept_waiting(pending);
            session.activate_waiting().unwrap();
            let active = session.active.as_mut().unwrap();
            let kept = if name == "notes" {
                "P1 | \"bounded queue\" | bounds memory"
            } else {
                "Bound worker count."
            };
            apply_section_frame(active, section(name, 0, "none"));
            apply_section_frame(active, section(name, 1, kept));
            let frame = crate::http_client::parse_copilot_frame(
                &serde_json::json!({"t": "ignored", "sec": name, "i": 0, "drop": true}).to_string(),
            )
            .unwrap()
            .unwrap();
            let events = apply_section_frame(active, frame);
            assert_eq!(events.len(), 1);
            let event = &events[0];
            assert_eq!(event.kind, "delta");
            assert_eq!(event.section.as_deref(), Some(name));
            assert_eq!(event.index, Some(0));
            assert_eq!(event.text.as_deref(), Some(""));
            assert_eq!(event.drop, Some(true));
            assert_eq!(serde_json::to_value(event).unwrap()["drop"], true);
            assert!(!active.answer_md.contains("ignored"));
            let items = if name == "notes" {
                &active.notes_raw
            } else {
                &active.specifics_raw
            };
            assert_eq!(items, &[kept]);

            // Removing an absent index still forwards the drop without allocating items.
            let events = apply_section_frame(
                active,
                CopilotFrame::Section {
                    section: name.into(),
                    index: u32::MAX,
                    text: String::new(),
                    drop: true,
                },
            );
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].drop, Some(true));
            assert_eq!(events[0].index, Some(u32::MAX));

            let active = session.take_active(1, "done", None).unwrap();
            let mut action = TerminalAction::active(active, "done", None, None);
            finalize_sections(&mut action);
            if name == "notes" {
                assert_eq!(action.sections.notes.len(), 1);
                assert_eq!(action.sections.notes[0].text, kept);
            } else {
                assert_eq!(action.sections.specifics, [kept]);
            }
            assert!(!action.answer_md.contains("none"));
        }
    }

    #[test]
    fn answer_shape_specifics_caps_are_shape_dependent() {
        // steps -> up to 6 specifics survive streaming and finalization
        let mut session1 = session();
        let pending = job(&mut session1, "Walk me through the deployment process.");
        assert_eq!(answer_shape(&pending), "steps");
        session1.accept_waiting(pending);
        session1.activate_waiting().unwrap();
        {
            let active = session1.active.as_mut().unwrap();
            for i in 0..7u32 {
                apply_section_frame(active, section("specific", i, &format!("Step {i}.")));
            }
        }
        let active = session1.take_active(1, "done", None).unwrap();
        let mut action = TerminalAction::active(active, "done", None, None);
        finalize_sections(&mut action);
        assert_eq!(action.sections.specifics.len(), 6);

        // brief -> up to 5 specifics survive streaming and finalization
        let mut session2 = session();
        let pending = job(&mut session2, "What is a pipeline?");
        assert_eq!(answer_shape(&pending), "brief");
        session2.accept_waiting(pending);
        session2.activate_waiting().unwrap();
        {
            let active = session2.active.as_mut().unwrap();
            for i in 0..6u32 {
                apply_section_frame(active, section("specific", i, &format!("Point {i}.")));
            }
        }
        let active = session2.take_active(1, "done", None).unwrap();
        let mut action = TerminalAction::active(active, "done", None, None);
        finalize_sections(&mut action);
        assert_eq!(action.sections.specifics.len(), 5);
    }

    #[test]
    fn specific_frame_keeps_markdown_unchanged() {
        let mut session = session();
        let pending = job(&mut session, "What is a pipeline?");
        assert_eq!(answer_shape(&pending), "brief");
        session.accept_waiting(pending);
        session.activate_waiting().unwrap();
        {
            let active = session.active.as_mut().unwrap();
            apply_section_frame(
                active,
                section("specific", 0, "**Rules**: predictable inputs."),
            );
        }
        let active = session.take_active(1, "done", None).unwrap();
        let mut action = TerminalAction::active(active, "done", None, None);
        finalize_sections(&mut action);
        assert_eq!(
            action.sections.specifics,
            ["**Rules**: predictable inputs."]
        );
        assert!(action.answer_md.contains("**Rules**: predictable inputs."));
    }

    #[test]
    fn build_request_carries_the_resolved_answer_shape() {
        let mut session = session();
        let mut job = job(&mut session, "Walk me through the deployment process.");
        job.provider_frozen = "local".into();
        job.llm_base_url = Some("http://127.0.0.1:11434".into());
        let request = build_request(&job).unwrap();
        assert_eq!(request.answer_shape, "steps");

        job.resolved_question = Some("What is a pipeline?".into());
        let request = build_request(&job).unwrap();
        assert_eq!(request.answer_shape, "brief");
    }

    #[test]
    fn local_job_keeps_stated_figure_after_it_scrolls_out_of_context() {
        let mut session = session();
        session.mode_override = Some("local".into());
        session.push_dialogue_turn(
            "Them",
            "The deployment is worth 13.8 trillion dollars in annual value.",
        );
        for _ in 1..12 {
            session.push_dialogue_turn(
                "Them",
                "Small follow-up remark about the schedule and next steps.",
            );
        }
        let context = session.context_before("What is the annual value of deploying this model?");
        assert_eq!(context.len(), MAX_CONTEXT_TURNS_LOCAL);
        assert!(!context.iter().any(|turn| turn.contains("13.8")));
        let prepared = prepare_job(
            &mut session,
            "What is the annual value of deploying this model?",
            "Me",
            context,
            None,
            "manual",
        )
        .unwrap();
        assert_eq!(prepared.provider_frozen, "local");
        assert_eq!(prepared.context_turns.len(), MAX_CONTEXT_TURNS_LOCAL);
        assert_eq!(prepared.stated_figures.len(), 1);
        assert!(prepared.stated_figures[0].contains("13.8"));

        session.mode_override = Some("claude".into());
        let context = session.context_before("What is the annual value of deploying this model?");
        let cloud = prepare_job(
            &mut session,
            "What is the annual value of deploying this model?",
            "Me",
            context,
            None,
            "manual",
        )
        .unwrap();
        assert!(cloud.stated_figures.is_empty());
    }

    #[test]
    fn build_request_sends_stated_figures_only_for_local() {
        let mut session = session();
        let mut local = job(
            &mut session,
            "What is the annual value of deploying this model?",
        );
        local.provider_frozen = "local".into();
        local.llm_base_url = Some("http://127.0.0.1:11434".into());
        local.stated_figures = vec!["Them: The deployment is worth 13.8 trillion dollars.".into()];
        let value = serde_json::to_value(build_request(&local).unwrap()).unwrap();
        assert_eq!(
            value
                .get("stated_figures")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let mut deepseek = local.clone();
        deepseek.provider_frozen = "deepseek".into();
        deepseek.llm_base_url = Some(DEEPSEEK_BASE_URL.into());
        deepseek.llm_api_key = Some("test-key".into());
        let value = serde_json::to_value(build_request(&deepseek).unwrap()).unwrap();
        assert!(value.get("stated_figures").is_none());

        crate::copilot_keys::set_api_key("sk-ant-test-ledger").unwrap();
        let mut claude = local.clone();
        claude.provider_frozen = "claude".into();
        let value = serde_json::to_value(build_request(&claude).unwrap()).unwrap();
        crate::copilot_keys::clear_api_key().unwrap();
        assert!(value.get("stated_figures").is_none());
    }

    #[test]
    fn replay_request_removes_both_api_key_names_and_values() {
        let mut session = session();
        let mut local = job(
            &mut session,
            "What is the annual value of deploying this model?",
        );
        local.provider_frozen = "local".into();
        local.llm_base_url = Some("http://127.0.0.1:11434".into());
        local.llm_api_key = Some("SENTINEL_B".into());
        let mut request = build_request(&local).unwrap();
        request.api_key = Some("SENTINEL_A".into());
        let redacted = redacted_copilot_request(&request);
        let text = serde_json::to_string(&redacted).unwrap();
        assert!(!text.contains("SENTINEL_A"));
        assert!(!text.contains("SENTINEL_B"));
        assert!(!text.contains("api_key"));
        assert!(!text.contains("llm_api_key"));
        assert_eq!(redacted["question"], serde_json::json!(request.question));
    }

    #[test]
    fn replay_frame_is_kept_on_the_active_card_without_emitting() {
        let mut session = session();
        let pending = job(&mut session, "What is the annual value?");
        session.accept_waiting(pending);
        session.activate_waiting().unwrap();
        let active = session.active.as_mut().unwrap();
        let service = serde_json::json!({"v": 1, "prompt_sha": "abc123"});
        let events = apply_section_frame(active, CopilotFrame::Replay(service.clone()));
        assert!(events.is_empty());
        assert_eq!(active.replay_service, Some(service));
    }

    #[test]
    fn replay_without_service_frame_stores_null_service() {
        let request = serde_json::json!({"question": "q"});
        let replay = build_replay_json(Some(request.clone()), None);
        let value: serde_json::Value = serde_json::from_str(&replay).unwrap();
        assert_eq!(value["v"], 1);
        assert_eq!(value["request"], request);
        assert!(value["service"].is_null());
    }

    fn finalized_note_action(
        passage_index: usize,
        score: f32,
        quote: &str,
        clause: &str,
    ) -> TerminalAction {
        let mut session = session();
        let mut pending = job(&mut session, "How do you manage prompt versioning?");
        pending.passages = vec![
            CopilotPassage {
                source_kind: "folder".into(),
                source_id: "/sources/notes.md".into(),
                title: "Notes".into(),
                text: "Durable workflows. Prompt revisions are tracked.".into(),
                score,
            };
            2
        ];
        session.accept_waiting(pending);
        session.activate_waiting().unwrap();
        let active = session.active.as_mut().unwrap();
        let text = format!("P{} | \"{quote}\" | {clause}", passage_index + 1);
        let events = apply_section_frame(active, section("notes", 0, &text));
        assert_eq!(events.len(), 1, "relevance filtering must wait until done");
        assert_eq!(events[0].text.as_deref(), Some(text.as_str()));
        assert_eq!(events[0].drop, None);
        assert_eq!(active.notes_raw, [text]);
        let active = session.take_active(1, "done", None).unwrap();
        let mut action = TerminalAction::active(active, "done", None, None);
        finalize_sections(&mut action);
        action
    }

    #[test]
    fn notes_without_question_keywords_on_second_passage_are_dropped() {
        let action =
            finalized_note_action(1, 0.9, "durable workflows", "remove unnecessary LLM calls");
        assert!(action.sections.notes.is_empty());
        assert!(!action.answer_md.contains("NOTES:"));
    }

    #[test]
    fn notes_without_overlap_on_top_passage_are_kept_at_relevance_floor() {
        for score in [0.75, 0.8] {
            let mut action = finalized_note_action(
                0,
                score,
                "durable workflows",
                "remove unnecessary LLM calls",
            );
            action.job.passages[0].source_kind = "vault".into();
            finalize_sections(&mut action);
            assert_eq!(action.sections.notes.len(), 1);
            assert_eq!(action.sections.notes[0].passage_index, Some(0));
        }
        let mut action = finalized_note_action(
            0,
            0.749,
            "durable workflows",
            "remove unnecessary LLM calls",
        );
        action.job.passages[0].source_kind = "vault".into();
        finalize_sections(&mut action);
        assert!(action.sections.notes.is_empty());
    }

    #[test]
    fn notes_with_one_shared_keyword_in_quote_or_clause_are_kept() {
        for (quote, clause) in [
            ("Prompt revisions", "track changes"),
            ("durable workflows", "track prompt changes"),
        ] {
            let action = finalized_note_action(1, 0.1, quote, clause);
            assert_eq!(action.sections.notes.len(), 1);
            assert_eq!(action.sections.notes[0].passage_index, Some(1));
        }
    }

    #[test]
    fn notes_relevance_does_not_bypass_quote_validation() {
        let action = finalized_note_action(0, 0.8, "invented prompt quote", "track changes");
        assert!(action.sections.notes.is_empty());
    }

    #[test]
    fn legacy_say_is_number_checked_only_at_sentence_boundaries_and_terminal_flush() {
        let mut session = session();
        let pending = job(&mut session, "What did you do with 1500 requests?");
        session.accept_waiting(pending);
        session.activate_waiting().unwrap();
        let active = session.active.as_mut().unwrap();
        assert!(apply_section_frame(active, CopilotFrame::Text("I served 1,".into())).is_empty());
        assert!(apply_section_frame(active, CopilotFrame::Text("500 requests.".into())).is_empty());
        let events = apply_section_frame(
            active,
            CopilotFrame::Text(" I saved 40%. Next idea\nOur 50 workers".into()),
        );
        assert_eq!(
            events
                .iter()
                .map(|event| event.text.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "I served 1,500 requests.",
                "I saved [number]%.",
                "Next idea"
            ]
        );
        assert_eq!(active.say_buffer, "Our 50 workers");
        let active = session.take_active(1, "done", None).unwrap();
        let mut action = TerminalAction::active(active, "done", None, None);
        finalize_sections(&mut action);
        assert_eq!(action.sections.say.last().unwrap(), "Our [number] workers");
        let once = action.answer_md.clone();
        finalize_sections(&mut action);
        assert_eq!(action.answer_md, once);
        assert_eq!(action.sections.say.len(), 4);
    }

    #[test]
    fn error_and_cancelled_actions_keep_raw_partial_text() {
        for status in ["error", "cancelled"] {
            let mut session = session();
            let pending = job(&mut session, "What failed?");
            session.accept_waiting(pending);
            session.activate_waiting().unwrap();
            let active = session.active.as_mut().unwrap();
            apply_section_frame(active, CopilotFrame::Text("I served 40".into()));
            let active = session.take_active(1, status, None).unwrap();
            let action = TerminalAction::active(active, status, None, None);
            assert_eq!(action.answer_md, "I served 40");
            assert!(action.sections.say.is_empty());
        }
    }

    #[test]
    fn terminal_guard_reopens_after_failure_and_commits_exactly_once() {
        let guard = TerminalGuard::new();
        assert!(guard.begin_write());
        assert!(!guard.begin_write());
        assert!(!guard.is_written());
        guard.release_write();
        assert!(guard.begin_write());
        guard.commit_write();
        assert!(!guard.begin_write());
        assert!(guard.is_written());
    }

    #[test]
    fn sessions_use_unique_durable_ids() {
        assert_ne!(session().session_id, session().session_id);
    }

    #[test]
    fn compare_and_take_never_retires_a_replacement_session() {
        let current = session();
        let current_id = current.session_id.clone();
        let mut slot = Some(current);
        assert!(take_session_if_expected(&mut slot, Some("stale-session-id")).is_none());
        assert_eq!(
            slot.as_ref().map(|value| value.session_id.as_str()),
            Some(current_id.as_str())
        );
        assert!(take_session_if_expected(&mut slot, Some(&current_id)).is_some());
        assert!(slot.is_none());
    }

    #[test]
    fn one_waiting_slot_supersedes_without_touching_active() {
        let mut session = session();
        let first = job(&mut session, "What is the first distinct question?");
        session.accept_waiting(first);
        let (_, _) = session.activate_waiting().unwrap();
        let second = job(&mut session, "How does the second item work?");
        assert!(session.accept_waiting(second).is_empty());
        let third = job(&mut session, "Why is the third item different?");
        let replaced = session.accept_waiting(third).pop().unwrap();
        assert_eq!(replaced.card_id, 2);
        assert_eq!(session.active.as_ref().unwrap().job.card_id, 1);
    }

    #[test]
    fn dedup_checks_active_waiting_and_recent_questions() {
        let mut session = session();
        let first = job(&mut session, "What is Rust ownership?");
        let normalized = CopilotSession::norm(&first.question);
        session.accept_waiting(first);
        session.activate_waiting();
        assert!(session.is_duplicate(&normalized));
        let active = session.take_active(1, "done", None).unwrap();
        assert_eq!(active.job.card_id, 1);
        assert!(session.is_duplicate(&normalized));
    }

    #[test]
    fn manual_ask_can_repeat_a_completed_question_but_not_active_work() {
        let mut session = session();
        let first = job(&mut session, "What is Rust ownership?");
        let normalized = CopilotSession::norm(&first.question);
        session.accept_waiting(first);
        session.activate_waiting();

        assert!(prepare_job(
            &mut session,
            "What is Rust ownership?",
            "Them",
            Vec::new(),
            None,
            "manual",
        )
        .is_err());

        session.take_active(1, "done", None).unwrap();
        assert!(session.is_duplicate(&normalized));
        assert!(prepare_job(
            &mut session,
            "What is Rust ownership?",
            "Them",
            Vec::new(),
            None,
            "manual",
        )
        .is_ok());
    }

    #[test]
    fn cancellation_reason_is_retained_with_the_retry_snapshot() {
        let mut session = session();
        let first = job(&mut session, "Why should this request be cancelled?");
        session.accept_waiting(first);
        session.activate_waiting();
        session.take_active(1, "cancelled", Some("user")).unwrap();
        let terminal = session.terminal_jobs.get(&1).unwrap();
        assert_eq!(terminal.status, "cancelled");
        assert_eq!(terminal.reason.as_deref(), Some("user"));
    }

    #[test]
    fn capture_snapshot_uses_session_elapsed_time_and_frozen_persona() {
        let mut session = session();
        session.mode_override = Some("claude".into());
        let job = job(&mut session, "What should you recommend today?");
        assert!(job.asked_at_ms < 1_000);
        assert_eq!(job.persona.as_deref(), Some("Be concise"));
        assert_eq!(job.provider_frozen, "claude");
        assert!(job.web_search);
    }

    #[test]
    fn web_consent_rejects_blank_stale_and_wrong_folder_without_persisting() {
        for (session_id, folder_id, expected) in [
            ("", 42, SESSION_NOT_ACTIVE),
            ("retired-session", 42, SESSION_NOT_ACTIVE),
            ("current-session", 99, SESSION_FOLDER_MISMATCH),
        ] {
            let state = std::sync::Mutex::new(CopilotState {
                session: Some(CopilotSession::new(
                    "current-session".into(),
                    1,
                    Some(42),
                    "claude".into(),
                    None,
                    true,
                )),
            });
            let persisted = std::cell::Cell::new(false);

            let result = set_folder_web_with(&state, session_id, folder_id, false, |_, _| {
                persisted.set(true);
                Ok::<(), ()>(())
            });

            assert_eq!(result, Err(expected.to_string()));
            assert!(!persisted.get());
            assert!(state.lock().unwrap().session.as_ref().unwrap().folder_web);
        }
    }

    #[test]
    fn web_consent_storage_failure_leaves_memory_unchanged() {
        let state = std::sync::Mutex::new(CopilotState {
            session: Some(CopilotSession::new(
                "current-session".into(),
                1,
                Some(42),
                "claude".into(),
                None,
                true,
            )),
        });

        let result = set_folder_web_with(&state, "current-session", 42, false, |_, _| {
            Err("database unavailable")
        });

        assert_eq!(result, Err(WEB_CONSENT_SAVE_FAILED.to_string()));
        assert!(state.lock().unwrap().session.as_ref().unwrap().folder_web);
    }

    #[test]
    fn web_consent_changes_only_future_capture_snapshots() {
        let mut current = CopilotSession::new(
            "current-session".into(),
            1,
            Some(42),
            "claude".into(),
            None,
            false,
        );
        let existing = job(&mut current, "What was captured before consent changed?");
        current.accept_waiting(existing);
        let state = std::sync::Mutex::new(CopilotState {
            session: Some(current),
        });

        set_folder_web_with(&state, "current-session", 42, true, |id, enabled| {
            assert_eq!(id, 42);
            assert!(enabled);
            Ok::<(), ()>(())
        })
        .unwrap();

        let mut locked = state.lock().unwrap();
        let session = locked.session.as_mut().unwrap();
        assert!(!session.waiting.front().unwrap().web_search);
        let future = job(session, "How does Kubernetes networking work?");
        assert!(future.web_search);
    }

    #[test]
    fn retry_reuses_frozen_snapshot_and_gets_new_terminal_guard() {
        let mut session = session();
        let mut original = job(&mut session, "Why did the provider fail?");
        original.passages = vec![CopilotPassage {
            source_kind: "notes".into(),
            source_id: "notes".into(),
            title: "Notes".into(),
            text: "frozen passage".into(),
            score: 1.0,
        }];
        original.retrieval_ms = Some(12);
        session.terminal_jobs.insert(
            original.card_id,
            TerminalSnapshot {
                status: "error".into(),
                reason: Some("provider".into()),
                job: original.clone(),
            },
        );
        let snapshot = session.terminal_jobs.get(&1).unwrap().job.clone();
        let mut retry = snapshot;
        retry.card_id = session.next_card_id();
        retry.retry_of = Some(1);
        retry.reuse_passages = retry.retrieval_ms.is_some();
        retry.terminal = Arc::new(TerminalGuard::new());
        assert_eq!(retry.passages[0].text, "frozen passage");
        assert_eq!(retry.retry_of, Some(1));
        assert!(retry.terminal.begin_write());
        retry.terminal.commit_write();
        assert!(!original.terminal.is_written());
    }

    #[test]
    fn retry_requires_current_provider_and_web_consent() {
        let mut session = session();
        session.mode_override = Some("claude".into());
        let mut original = job(&mut session, "What current fact should Claude check?");
        original.web_search = true;

        assert!(validate_retry_consent("claude", true, &original).is_ok());
        assert_eq!(
            validate_retry_consent("no_ai", true, &original),
            Err("Copilot mode changed; switch back to retry this card".to_string())
        );
        assert_eq!(
            validate_retry_consent("local", true, &original),
            Err("Copilot mode changed; switch back to retry this card".to_string())
        );
        assert_eq!(
            validate_retry_consent("claude", false, &original),
            Err("Claude web search was turned off; turn it back on to retry this card".to_string())
        );
    }

    #[test]
    fn retry_retrieves_when_original_was_cancelled_before_retrieval_finished() {
        let mut session = session();
        let mut original = job(&mut session, "What was cancelled during retrieval?");
        assert!(original.retrieval_ms.is_none());
        original.reuse_passages = original.retrieval_ms.is_some();
        assert!(!original.reuse_passages);
    }

    #[test]
    fn stale_epoch_cannot_mutate_session_history() {
        let mut session = session();
        assert!(!session.accepts_epoch(2));
        if session.accepts_epoch(2) {
            session.last_any = Some("stale caption".to_string());
        }
        assert!(session.last_any.is_none());
        assert!(session.accepts_epoch(1));
    }

    #[test]
    fn live_busy_tracks_active_work_and_status_recovers_after_completion() {
        let mut session = session();
        session.live.enabled = true;
        let first = job(&mut session, "What is a semaphore?");
        session.accept_waiting(first);
        assert!(!live_answer_busy(&session));
        session.activate_waiting().unwrap();
        assert!(live_answer_busy(&session));
        let now = Instant::now();
        assert!(apply_live_tick_status(
            &mut session.live,
            Decision::Busy,
            now
        ));
        assert_eq!(session.live.status, "busy");
        session.take_active(1, "done", None).unwrap();
        assert!(!live_answer_busy(&session));
        assert!(apply_live_tick_status(
            &mut session.live,
            Decision::Skip("words"),
            now
        ));
        assert_eq!(session.live.status, "idle");
        apply_live_tick_status(&mut session.live, Decision::Busy, now);
        assert!(apply_live_tick_status(
            &mut session.live,
            Decision::Run {
                update_summary: false
            },
            now
        ));
        assert_eq!(session.live.status, "updating");
        apply_live_tick_status(&mut session.live, Decision::Busy, now);
        session.live.backoff_until = Some(now + Duration::from_secs(60));
        apply_live_tick_status(&mut session.live, Decision::Skip("backoff"), now);
        assert_eq!(session.live.status, "error");
    }

    #[test]
    fn live_cooldown_ignores_waiting_cards_and_terminal_write_retries() {
        let mut session = session();
        let now = Instant::now();
        let waiting = job(&mut session, "What is a semaphore?");
        let mut terminal = TerminalAction::waiting(waiting, "superseded");
        note_live_answer_finished(&mut session, &terminal, now);
        assert!(session.last_answer_finished.is_none());
        terminal.dispatched = true;
        terminal.status = "done".into();
        note_live_answer_finished(&mut session, &terminal, now);
        assert_eq!(session.last_answer_finished, Some(now));
        terminal.attempts = 1;
        note_live_answer_finished(&mut session, &terminal, now + Duration::from_secs(4));
        assert_eq!(session.last_answer_finished, Some(now));
    }

    #[test]
    fn live_tick_logs_include_reasons_and_never_exceed_one_per_fifteen_seconds() {
        let now = Instant::now();
        let mut ctl = LiveCtl::default();
        let mut log = LiveTickLog::default();
        assert_eq!(
            log.reason_if_due(Decision::Skip("first_wait"), &ctl, now)
                .as_deref(),
            Some("first_wait")
        );
        assert!(log
            .reason_if_due(Decision::Busy, &ctl, now + Duration::from_secs(5))
            .is_none());
        assert!(log
            .reason_if_due(
                Decision::Run {
                    update_summary: false
                },
                &ctl,
                now + Duration::from_secs(14)
            )
            .is_none());
        assert_eq!(
            log.reason_if_due(Decision::Busy, &ctl, now + Duration::from_secs(15))
                .as_deref(),
            Some("answer_busy")
        );
        assert_eq!(
            log.reason_if_due(Decision::Busy, &ctl, now + Duration::from_secs(30))
                .as_deref(),
            Some("answer_busy")
        );
        copilot_live::push_turn(&mut ctl, "Me", "three new words", 1000);
        ctl.last_extract_started = Some(now);
        assert_eq!(
            log.reason_if_due(Decision::Skip("words"), &ctl, now + Duration::from_secs(45))
                .as_deref(),
            Some("words:3/40")
        );
        assert_eq!(
            log.reason_if_due(
                Decision::Skip("backoff"),
                &ctl,
                now + Duration::from_secs(60)
            )
            .as_deref(),
            Some("backoff")
        );
        assert_eq!(
            log.reason_if_due(
                Decision::Run {
                    update_summary: false
                },
                &ctl,
                now + Duration::from_secs(75)
            )
            .as_deref(),
            Some("run")
        );
        assert_eq!(
            log.reason_if_due(
                Decision::Skip("error:extraction_still_updating"),
                &ctl,
                now + Duration::from_secs(90)
            )
            .as_deref(),
            Some("error:extraction_still_updating")
        );
    }

    #[test]
    fn forced_captions_feed_extraction_before_the_question_turn_finishes() {
        let mut session = session();
        session.live.enabled = true;
        session.live.status = "idle".into();
        let now = Instant::now();
        session.live.started_at = now - Duration::from_secs(80);
        session.live.last_extract_started = Some(now - Duration::from_secs(48));
        for _ in 0..6 {
            assert!(session
                .assemble_caption("me", &"word ".repeat(14), "forced")
                .is_none());
        }
        assert_eq!(
            copilot_live::should_extract(&session.live, now, false, None),
            Decision::Run {
                update_summary: false
            }
        );
        let turn = session
            .assemble_caption("me", "Final two", "silence")
            .unwrap();
        assert_eq!(turn.split_whitespace().count(), 86);
        assert_eq!(
            session
                .live
                .turns
                .iter()
                .map(|turn| turn.words)
                .sum::<usize>(),
            86
        );
        assert_eq!(session.live.turns.len(), 7);
    }

    #[test]
    fn forced_caption_chunks_form_one_turn_with_recent_me_and_them_context() {
        let mut session = session();
        assert_eq!(
            session.assemble_caption(
                "them",
                "If we temporarily connect the local model",
                "forced",
            ),
            None
        );
        let first_turn = session
            .assemble_caption("them", "does it still count as air-gapped?", "silence")
            .unwrap();
        assert_eq!(
            first_turn,
            "If we temporarily connect the local model does it still count as air-gapped?"
        );
        session.push_dialogue_turn("Them", &first_turn);

        let me_turn = session
            .assemble_caption("me", "We only need the connection for research.", "silence")
            .unwrap();
        session.push_dialogue_turn("Me", &me_turn);

        let follow_up = "What vulnerabilities would that introduce?";
        assert_eq!(
            session.context_before(follow_up),
            vec![
                format!("Them: {first_turn}"),
                "Me: We only need the connection for research.".to_string(),
            ]
        );
    }

    #[test]
    fn manual_context_excludes_the_current_turn_but_keeps_prior_dialogue() {
        let mut session = session();
        session.push_dialogue_turn("Them", "We are discussing the deployment.");
        session.push_dialogue_turn("Me", "It will run locally.");
        session.push_dialogue_turn("Them", "How should we secure it?");

        assert_eq!(
            session.context_before("How should we secure it?"),
            vec![
                "Them: We are discussing the deployment.".to_string(),
                "Me: It will run locally.".to_string(),
            ]
        );
        assert_eq!(
            session.previous_them_before("How should we secure it?"),
            Some("We are discussing the deployment.".to_string())
        );
    }

    #[test]
    fn live_context_starts_empty_and_is_frozen_into_the_job() {
        let mut session = session();
        assert_eq!(session.live_context, CopilotLiveContext::default());
        session.live_context.notes = "session-bound note".to_string();
        let job = job(&mut session, "What did the session note say?");
        assert_eq!(job.live_context.notes, "session-bound note");
    }

    #[tokio::test]
    async fn retrieval_wait_returns_immediately_when_card_is_cancelled() {
        let card_token = CancellationToken::new();
        let session_token = CancellationToken::new();
        card_token.cancel();
        let result = tokio::time::timeout(
            Duration::from_millis(50),
            await_retrieval(&card_token, &session_token, std::future::pending::<()>()),
        )
        .await
        .expect("cancelled retrieval must not wait for blocking work");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn cancel_before_request_poll_does_not_begin_dispatch() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let card_token = CancellationToken::new();
        let session_token = CancellationToken::new();
        let dispatched = AtomicBool::new(false);
        card_token.cancel();
        let cancelled = select_request_or_cancellation(&card_token, &session_token, async {
            dispatched.store(true, Ordering::SeqCst);
        })
        .await;
        assert!(cancelled.is_none());
        assert!(!dispatched.load(Ordering::SeqCst));

        let card_token = CancellationToken::new();
        let session_token = CancellationToken::new();
        let dispatched = AtomicBool::new(false);
        let completed = select_request_or_cancellation(&card_token, &session_token, async {
            dispatched.store(true, Ordering::SeqCst);
        })
        .await;
        assert!(completed.is_some());
        assert!(dispatched.load(Ordering::SeqCst));
    }

    #[test]
    fn skipped_frozen_web_job_is_not_counted_as_requested() {
        let mut session = session();
        let mut frozen_web_job = job(&mut session, "Should this waiting job search the web?");
        frozen_web_job.web_search = true;
        let action = TerminalAction::waiting(frozen_web_job, "superseded");
        assert!(!action.web_requested());
    }

    #[test]
    fn invalid_local_endpoint_is_not_frozen_at_capture() {
        let result = validate_and_freeze_local_config(
            Some("model".to_string()),
            Some("http://127.0.0.1:9999/v1".to_string()),
            None,
        );
        assert_eq!(
            result,
            Err("Local engine is not a registered loopback endpoint".to_string())
        );
    }

    #[test]
    fn static_loopback_endpoint_validation_rejects_path_and_userinfo_tricks() {
        assert!(validate_local_endpoint("http://127.0.0.1:11434/v1", None).is_ok());
        assert!(validate_local_endpoint("http://user@127.0.0.1:11434/v1", None).is_err());
        assert!(validate_local_endpoint("http://127.0.0.1:11434/v1/escape", None).is_err());
        assert!(validate_local_endpoint("https://127.0.0.1:11434/v1", None).is_err());
        assert!(validate_local_endpoint("http://example.com:11434/v1", None).is_err());
    }

    #[test]
    fn deepseek_request_uses_fixed_provider_contract_and_hides_credentials_from_receipt_bytes() {
        let mut session = session();
        let mut deepseek = job(&mut session, "What changed in the plan?");
        deepseek.provider_frozen = "deepseek".to_string();
        deepseek.model = Some(DEEPSEEK_MODEL.to_string());
        deepseek.llm_base_url = Some(DEEPSEEK_BASE_URL.to_string());
        deepseek.llm_api_key = Some("sk-deepseek-secret".to_string());

        let request = build_request(&deepseek).unwrap();
        assert_eq!(request.provider, "deepseek");
        assert_eq!(request.schema_version, 7);
        assert_eq!(request.question_source, "Them");
        assert!(request.voice_samples.is_empty());
        assert!(request.meeting_header.is_none());
        assert!(request.running_summary.is_none());
        assert_eq!(request.model.as_deref(), Some(DEEPSEEK_MODEL));
        assert_eq!(request.llm_base_url.as_deref(), Some(DEEPSEEK_BASE_URL));
        assert_eq!(request.llm_api_key.as_deref(), Some("sk-deepseek-secret"));
        assert!(!request.web_search);

        let mut sanitized = request.clone();
        sanitized.api_key = None;
        sanitized.llm_api_key = None;
        assert_eq!(
            request_bytes_without_credentials(&request),
            serde_json::to_vec(&sanitized).unwrap().len()
        );
        assert!(!serde_json::to_string(&sanitized)
            .unwrap()
            .contains("sk-deepseek-secret"));
    }

    #[test]
    fn deepseek_endpoint_cannot_be_overridden() {
        let mut session = session();
        let mut deepseek = job(&mut session, "Should this connect elsewhere?");
        deepseek.provider_frozen = "deepseek".to_string();
        deepseek.model = Some(DEEPSEEK_MODEL.to_string());
        deepseek.llm_base_url = Some("https://evil.example".to_string());
        deepseek.llm_api_key = Some("secret".to_string());
        assert_eq!(
            build_request(&deepseek).unwrap_err(),
            "DeepSeek endpoint is invalid"
        );
    }
    #[test]
    fn deepseek_model_frozen_per_job() {
        let mut config = crate::types::AppConfig::default();
        let mut session = session();
        let mut original = job(&mut session, "How does a semaphore work?");
        let frozen = freeze_deepseek_config(&config, "test-key".into());
        original.provider_frozen = "deepseek".into();
        original.model = frozen.model;
        original.llm_base_url = frozen.base_url;
        original.llm_api_key = frozen.api_key;
        config.copilot_deepseek_model = "deepseek-v4-pro".into();
        assert_eq!(
            freeze_deepseek_config(&config, "test-key".into())
                .model
                .as_deref(),
            Some("deepseek-v4-pro")
        );
        let mut retry = original.clone();
        retry.retry_of = Some(original.card_id);
        for job in [&original, &retry] {
            assert_eq!(
                build_request(job).unwrap().model.as_deref(),
                Some("deepseek-v4-flash")
            );
        }
        let mut future = original.clone();
        future.model = freeze_deepseek_config(&config, "test-key".into()).model;
        assert_eq!(
            build_request(&future).unwrap().model.as_deref(),
            Some("deepseek-v4-pro")
        );
    }

    fn insert_memory_card(
        conn: &rusqlite::Connection,
        session_id: &str,
        card_id: u64,
        status: &str,
        question: &str,
        say: &str,
    ) -> i64 {
        let row = crate::storage::insert_copilot_card_v2_on(
            conn, session_id, card_id, None, "local", "auto", None, question, "now",
        )
        .unwrap();
        conn.execute(
            "UPDATE copilot_cards SET status = ?2, answer_md = ?3, finished_at = ?4 WHERE id = ?1",
            rusqlite::params![
                row,
                status,
                format!("SAY: {say}\nSPECIFIC: Not part of memory."),
                format!("2026-09-09T00:00:{card_id:02}Z")
            ],
        )
        .unwrap();
        row
    }

    #[test]
    fn memory_done_only_frozen() {
        let conn = crate::storage::in_memory_db();
        let mut session = session();
        crate::storage::insert_copilot_session_on(&conn, &session.session_id, None, "local", "now")
            .unwrap();
        for (id, status) in [
            (1, "done"),
            (2, "cancelled"),
            (3, "error"),
            (4, "done"),
            (5, "done"),
            (6, "done"),
        ] {
            insert_memory_card(
                &conn,
                &session.session_id,
                id,
                status,
                &format!("Earlier question {id}"),
                "A bounded queue controls concurrency.",
            );
        }
        let no_ai = insert_memory_card(
            &conn,
            &session.session_id,
            7,
            "done",
            "No AI card",
            "Never remember this.",
        );
        conn.execute(
            "UPDATE copilot_cards SET provider_frozen = 'no_ai' WHERE id = ?1",
            [no_ai],
        )
        .unwrap();
        let legacy = insert_memory_card(&conn, &session.session_id, 8, "done", "Legacy", "legacy");
        conn.execute(
            "UPDATE copilot_cards SET answer_md = 'unlabelled' WHERE id = ?1",
            [legacy],
        )
        .unwrap();
        insert_memory_card(
            &conn,
            "other-session",
            9,
            "done",
            "Other session",
            "Never remember this either.",
        );
        let mut captured = job(&mut session, "How is retrieval evaluated?");
        captured.provider_frozen = "local".into();
        freeze_card_memory_on(&conn, &mut captured).unwrap();
        let frozen = captured.recent_cards.clone();
        assert_eq!(
            frozen
                .iter()
                .map(|card| card.card_ref.as_str())
                .collect::<Vec<_>>(),
            [4, 5, 6]
                .iter()
                .map(|id| format!("{}:{id}", session.session_id))
                .collect::<Vec<_>>()
        );
        assert!(frozen
            .iter()
            .all(|card| card.origin == "generated_suggestion" && !card.say.contains("SPECIFIC")));
        insert_memory_card(
            &conn,
            &session.session_id,
            10,
            "done",
            "Completes after capture",
            "A late answer.",
        );
        let mut retry = captured.clone();
        retry.retry_of = Some(captured.card_id);
        freeze_card_memory_on(&conn, &mut retry).unwrap();
        assert_eq!(captured.recent_cards, frozen);
        assert_eq!(retry.recent_cards, frozen);
        let mut future = job(&mut session, "How do future captures work?");
        freeze_card_memory_on(&conn, &mut future).unwrap();
        assert!(future
            .recent_cards
            .last()
            .unwrap()
            .card_ref
            .ends_with(":10"));
    }

    #[test]
    fn subject_hash_followup() {
        let conn = crate::storage::in_memory_db();
        let mut session = session();
        let folder = crate::storage::create_folder_on(&conn, "Interview", "blue")
            .unwrap()
            .id;
        crate::storage::insert_copilot_session_on(
            &conn,
            &session.session_id,
            Some(folder),
            "local",
            "now",
        )
        .unwrap();
        insert_memory_card(
            &conn,
            &session.session_id,
            1,
            "done",
            "Design an idempotent key for a tool that sends emails",
            "I would combine the recipient and subject hash into the key.",
        );
        let mut followup = job(&mut session, "What is subject hash?");
        // Legacy jobs with no policy resolution retain the keyword expansion fallback.
        followup.resolved_question = None;
        followup.previous_them = Some("Unrelated previous turn".into());
        freeze_card_memory_on(&conn, &mut followup).unwrap();
        let (query, previous) = retrieval_question(&followup);
        assert!(query.starts_with("subject hash"));
        assert!(query.contains("idempotent"));
        assert!(previous.is_none());
        assert_eq!(followup.question, "What is subject hash?");
        crate::storage::upsert_folder_doc_on(
            &conn,
            folder,
            "/email.md",
            "Idempotent email delivery",
            "A stable recipient and subject hash form an idempotent key.",
            "1",
            "now",
        )
        .unwrap();
        let live = CopilotLiveContext {
            folder_id: Some(folder),
            ..Default::default()
        };
        let (passages, _) = crate::copilot::retrieve_sync_tiers(&conn, &live, query);
        assert_eq!(passages.len(), 1);
        assert_eq!(passages[0].source_id, "/email.md");
        let row = crate::storage::insert_copilot_card_resolved_on(
            &conn,
            &session.session_id,
            2,
            Some(folder),
            "local",
            "auto",
            None,
            &followup.question,
            followup.resolved_question.as_deref(),
            "now",
            "brief",
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT resolved_question FROM copilot_cards WHERE id = ?1",
                [row],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            query
        );
        assert!(resolve_question(
            "How does Kubernetes networking work?",
            &followup.recent_cards
        )
        .is_none());
        assert!(resolve_question("What?", &followup.recent_cards)
            .unwrap()
            .contains("idempotent"));
        let memory = vec![RecentCard {
            question: "What is subject hash?".into(),
            say: "The subject identifies the message. I would include a subject hash.".into(),
            points: Vec::new(),
            ..RecentCard::default()
        }];
        assert_eq!(
            resolve_question("What is subject hash?", &memory).as_deref(),
            Some("subject hash")
        );
    }

    #[test]
    fn memory_byte_caps_and_canonical_evidence_refs() {
        let row = crate::storage::RecentDoneCard {
            card_id: 1,
            question: "What changed?".into(),
            answer_md: "SAY: First sentence.\nSAY: Second sentence.\nNOTES: ignore".into(),
            passages_json: serde_json::to_string(&[
                CopilotPassage {
                    source_kind: "vault".into(),
                    source_id: "/Files/./A.md".into(),
                    title: "A".into(),
                    text: "A".into(),
                    score: 0.75,
                },
                CopilotPassage {
                    source_kind: "folder".into(),
                    source_id: "/Files/A.md".into(),
                    title: "A".into(),
                    text: "A".into(),
                    score: 0.96,
                },
            ])
            .unwrap(),
        };
        let cards = card_memory("session", vec![row]);
        assert_eq!(cards[0].say, "First sentence. Second sentence.");
        assert_eq!(
            cards[0].evidence_refs,
            [format!(
                "file:{}",
                crate::copilot_provenance::native_separators("/Files/A.md")
            )]
        );
        let json = serde_json::to_string(&cards).unwrap();
        assert!(json
            .starts_with("[{\"card_ref\":\"session:1\",\"question\":\"What changed?\",\"say\":"));
        assert!(json.contains("\"origin\":\"generated_suggestion\",\"evidence_refs\":"));
        for (provider, cap) in [("local", 2400), ("deepseek", 1600), ("claude", 1600)] {
            let mut newest = cards[0].clone();
            newest.card_ref = "session:3".into();
            newest.say = format!(
                "First complete sentence. {}. {}.",
                "界".repeat(300),
                "語".repeat(300)
            );
            let bounded =
                bound_card_memory(vec![cards[0].clone(), cards[0].clone(), newest], provider);
            assert!(memory_bytes(&bounded) <= cap);
            assert!(bounded.last().unwrap().card_ref.ends_with(":3"));
            assert!(bounded.last().unwrap().say.ends_with('.'));
            let mut huge = cards[0].clone();
            huge.question = "界".repeat(2000);
            huge.say = "Small sentence.".into();
            let bounded = bound_card_memory(vec![huge], provider);
            assert_eq!(bounded.len(), 1);
            assert!(memory_bytes(&bounded) <= cap);
            assert!(bounded[0].say.is_empty());
            assert!(bounded[0].question.len() < 6000);
        }
    }

    #[test]
    fn card_memory_extracts_points_and_say() {
        let row = crate::storage::RecentDoneCard {
            card_id: 1,
            question: "How does the pipeline work?".into(),
            answer_md: "SAY: A pipeline has stages.\nSPECIFIC: **Collect**: pull raw data.\nSPECIFIC: **Clean**: fix gaps.\nNEXT: What next?".into(),
            passages_json: "[]".into(),
        };
        let cards = card_memory("session", vec![row]);
        assert_eq!(cards[0].say, "A pipeline has stages.");
        assert_eq!(
            cards[0].points,
            vec![
                "**Collect**: pull raw data.".to_string(),
                "**Clean**: fix gaps.".to_string(),
            ]
        );
    }

    #[test]
    fn card_memory_caps_points_at_six_and_truncates_long_points() {
        let mut answer = String::from("SAY: Overview.\n");
        for i in 0..8 {
            if i == 2 {
                answer.push_str(&format!("SPECIFIC: {}\n", "w".repeat(300)));
            } else {
                answer.push_str(&format!("SPECIFIC: **Step{i}**: detail {i}.\n"));
            }
        }
        let row = crate::storage::RecentDoneCard {
            card_id: 2,
            question: "What are the steps?".into(),
            answer_md: answer,
            passages_json: "[]".into(),
        };
        let cards = card_memory("session", vec![row]);
        assert_eq!(cards[0].points.len(), 6);
        assert_eq!(cards[0].points[0], "**Step0**: detail 0.");
        assert_eq!(cards[0].points[1], "**Step1**: detail 1.");
        assert!(cards[0].points[2].chars().count() <= 200);
        assert!(cards[0].points[2].len() < 300);
        assert_eq!(cards[0].points[5], "**Step5**: detail 5.");
    }

    #[test]
    fn bound_card_memory_drops_points_before_trimming_say() {
        let say = "A pipeline has stages.".to_string();
        let points: Vec<String> = (0..6)
            .map(|i| format!("point {i} {}", "x".repeat(400)))
            .collect();
        let card = RecentCard {
            card_ref: "session:1".into(),
            question: "What is next?".into(),
            say: say.clone(),
            points: points.clone(),
            origin: "generated_suggestion".into(),
            evidence_refs: Vec::new(),
        };
        assert!(memory_bytes(std::slice::from_ref(&card)) > 2_400);
        let bounded = bound_card_memory(vec![card], "local");
        assert_eq!(bounded.len(), 1);
        assert!(memory_bytes(&bounded) <= 2_400);
        assert_eq!(bounded[0].say, say);
        assert!(bounded[0].points.len() < points.len());
        assert_eq!(
            bounded[0].points.as_slice(),
            &points[..bounded[0].points.len()]
        );
    }

    #[test]
    fn recent_card_points_serde_skips_empty() {
        let empty = RecentCard {
            card_ref: "session:1".into(),
            question: "Q?".into(),
            say: "S.".into(),
            points: Vec::new(),
            origin: "generated_suggestion".into(),
            evidence_refs: Vec::new(),
        };
        let value = serde_json::to_value(&empty).unwrap();
        assert!(value.get("points").is_none());
        let with_points = RecentCard {
            points: vec!["**Collect**: pull raw data.".into()],
            ..empty.clone()
        };
        let value = serde_json::to_value(&with_points).unwrap();
        assert_eq!(value["points"][0], "**Collect**: pull raw data.");
        let round_trip: RecentCard = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, with_points);
        assert_eq!(
            RECENT_CARDS_LABEL,
            "RECENT CARDS (oldest first; the last card is the most recent answer; suggestions shown to Me earlier, not words Me said, never evidence):\n"
        );
    }

    #[test]
    fn memory_and_pack_increase_egress_bytes_without_credentials() {
        let mut session = session();
        let mut captured = job(&mut session, "How does this work?");
        captured.provider_frozen = "deepseek".into();
        captured.model = Some(DEEPSEEK_MODEL.into());
        captured.llm_base_url = Some(DEEPSEEK_BASE_URL.into());
        captured.llm_api_key = Some("secret".into());
        let empty = request_bytes_without_credentials(&build_request(&captured).unwrap());
        captured.standing_pack = Some("Project A: Local retrieval.".into());
        captured.resolved_question = Some("retrieval local".into());
        captured.recent_cards = vec![RecentCard {
            card_ref: "session:1".into(),
            question: "What is retrieval?".into(),
            say: "Retrieval finds evidence.".into(),
            points: Vec::new(),
            origin: "generated_suggestion".into(),
            evidence_refs: vec!["notes".into()],
        }];
        let request = build_request(&captured).unwrap();
        assert_eq!(request.schema_version, 7);
        assert_eq!(request.question_source_tier, "confirmed");
        assert_eq!(request.recent_cards, captured.recent_cards);
        assert_eq!(request.standing_pack, captured.standing_pack);
        assert_eq!(request.resolved_question, captured.resolved_question);
        assert!(request_bytes_without_credentials(&request) > empty);
        captured.llm_api_key = Some("much longer secret never counted".into());
        assert_eq!(
            request_bytes_without_credentials(&build_request(&captured).unwrap()),
            request_bytes_without_credentials(&request)
        );
    }

    #[test]
    fn curated_dedup_and_notes() {
        let mut action =
            finalized_note_action(0, 0.96, "durable workflows", "remove unnecessary LLM calls");
        action.job.resolved_question = Some("subject hash idempotent".into());
        finalize_sections(&mut action);
        assert!(action.sections.notes.is_empty());
        assert!(!action.answer_md.contains("NOTES:"));
        action.job.passages[0].text = "RAG retrieves evidence.".into();
        action.job.folder_terms.insert("rag".into());
        action.job.resolved_question = Some("rag".into());
        action.notes_raw = vec!["P1 | \"RAG retrieves evidence\" | grounds the answer".into()];
        finalize_sections(&mut action);
        assert_eq!(action.sections.notes.len(), 1);
        let mut vault = action.job.passages[0].clone();
        vault.source_kind = "vault".into();
        vault.score = 0.75;
        assert_eq!(
            crate::copilot::dedup_and_sort_passages(vec![vault, action.job.passages[0].clone()])
                .len(),
            1
        );
    }

    #[test]
    fn stored_passages_preserve_canonical_identity_and_egress_labels_stay_bounded() {
        let passages = sanitize_passages(vec![CopilotPassage {
            source_kind: "folder".into(),
            source_id: "/Private/Project/./overview.md".into(),
            title: "Overview".into(),
            text: "A project paragraph.".into(),
            score: 0.96,
        }]);
        let native = crate::copilot_provenance::native_separators("/Private/Project/overview.md");
        assert_eq!(passages[0].source_id, native);
        assert_eq!(
            crate::copilot_provenance::canonical_evidence_key(&passages[0]),
            format!("file:{native}")
        );
        assert_eq!(egress_passages(&passages)[0].source, "folder:overview.md");
    }

    #[test]
    fn readiness_epoch_guard() {
        let current = session();
        let id = current.session_id.clone();
        let epoch = current.internal_epoch;
        let mut state = CopilotState {
            session: Some(current),
        };
        assert!(readiness_session(&mut state, "stale", epoch).is_none());
        assert!(readiness_session(&mut state, &id, epoch + 1).is_none());
        let current = readiness_session(&mut state, &id, epoch).unwrap();
        assert_eq!(current.readiness.session_id, id);
        current.token.cancel();
        assert!(readiness_session(&mut state, &id, epoch).is_none());
    }

    #[tokio::test]
    async fn folder_readiness_waits_and_times_out() {
        let (ready, mut listener) = watch::channel(false);
        let waiting = wait_for_folder(&mut listener, Duration::from_secs(1));
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("retrieval started while indexing"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {},
        }
        ready.send_replace(true);
        tokio::time::timeout(Duration::from_millis(100), waiting)
            .await
            .unwrap();
        let mut late = ready.subscribe();
        tokio::time::timeout(
            Duration::from_millis(100),
            wait_for_folder(&mut late, Duration::from_secs(10)),
        )
        .await
        .unwrap();
        let (_pending, mut listener) = watch::channel(false);
        tokio::time::timeout(
            Duration::from_millis(100),
            wait_for_folder(&mut listener, Duration::from_millis(10)),
        )
        .await
        .unwrap();
    }

    #[test]
    fn specific_cap_keeps_five_brief_specifics_and_six_for_steps() {
        let mut session = session();
        let brief = job(&mut session, "What is a vector database?");
        assert_eq!(answer_shape(&brief), "brief");
        assert_eq!(specific_cap(&brief), 5);
        let steps = job(&mut session, "What are the steps to deploy the pipeline?");
        assert_eq!(answer_shape(&steps), "steps");
        assert_eq!(specific_cap(&steps), 6);
        // Frame routing keeps index < cap and drops index >= cap.
        for i in 0..=4 {
            assert!(i < specific_cap(&brief), "brief index {i} kept");
        }
        assert!(5 >= specific_cap(&brief), "brief index 5 dropped");
        assert!(5 < specific_cap(&steps), "steps index 5 kept");
    }

    #[test]
    fn session_pack_freezes_before_dispatch_and_retry() {
        let mut session = session();
        session.readiness.status = "indexing".into();
        let mut captured = job(&mut session, "Explain retrieval latency");
        assert!(!captured.pack_frozen);
        session.standing_pack = Some("Project A: Stable bytes 界.".into());
        session.folder_terms.insert("rag".into());
        session.readiness.status = "ready".into();
        freeze_session_pack(&mut captured, &session);
        assert!(captured.pack_frozen);
        assert_eq!(captured.standing_pack, session.standing_pack);
        assert!(captured.folder_terms.contains("rag"));
        let mut retry = captured.clone();
        retry.retry_of = Some(captured.card_id);
        session.standing_pack = Some("A later change".into());
        freeze_session_pack(&mut retry, &session);
        assert_eq!(retry.standing_pack, captured.standing_pack);
        let future = job(&mut session, "Explain semantic retrieval");
        assert_eq!(future.standing_pack, session.standing_pack);
    }
}
