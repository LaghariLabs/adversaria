//! Typed HTTP client for the Python ML service.
//!
//! All communication with the transcription / summarization backend
//! flows through this module.  The base URL is read from `AppConfig`.

use crate::types::{
    AcceptedLiveItem, CopilotCitation, CopilotEgressPassage, HealthResponse, ModelDownloadStatus,
    SummarizeResponse, TemplateInfo, TranscribeResponse, WhisperModelInfo,
};

// ---------------------------------------------------------------------------
// Error translation
//
// Every string produced below can end up rendered verbatim in the app (a
// fresh Windows user saw `Transcription failed: {"detail":"Transcriber not
// initialized"}`). Raw response bodies, reqwest errors and internal component
// names must never reach the webview — same bar the frontend's jargon guard
// holds React copy to.
// ---------------------------------------------------------------------------

/// The local service didn't answer at all (not started yet, or mid-respawn).
const SERVICE_DOWN: &str =
    "The local AI service isn't running. Use Local AI: Offline → Restart at the top of the app, then retry.";
/// No Whisper model is cached, so nothing can transcribe yet.
const TRANSCRIBER_MISSING: &str = "No transcription model is downloaded yet. Open Settings → \
     Transcription and download one — this meeting will be transcribed once it's ready.";
/// A model exists but is still loading into memory.
const TRANSCRIBER_LOADING: &str = "The transcription engine is still starting up. Your meeting is \
     saved and will transcribe shortly — try again in a moment.";
/// Anything else that went wrong while transcribing.
const TRANSCRIBE_FAILED: &str =
    "Transcription didn't finish. Your recording is saved — try again in a moment.";
const TRANSCRIBE_TIMEOUT: &str = "The transcription service did not respond within 30 minutes. \
     The request was abandoned so the queue can continue; the recording is kept for retry.";
/// The notes (summarization) engine could not be reached or used.
const NOTES_UNREACHABLE: &str = "The notes model isn't reachable. Check Settings → Notes.";
const NOTES_TIMEOUT: &str = "The notes service did not respond within 10 minutes. The request was \
     abandoned; the recording and transcript are kept for retry.";
/// A grounded question couldn't be answered because the notes engine is down.
const ANSWER_UNREACHABLE: &str =
    "That question couldn't be answered — the notes model isn't reachable. \
     Check Settings → Notes.";
/// Note templates couldn't be read from the service.
const TEMPLATES_UNAVAILABLE: &str = "Note templates couldn't be loaded — try again in a moment.";
/// The service answered, but not with anything we could read. A serde error
/// here is a bug or a version mismatch — never something to show verbatim.
const UNEXPECTED_RESPONSE: &str =
    "The local AI service returned something unexpected — try again in a moment.";

/// Internal component names, repo ids and stack noise that must never appear in
/// a user-facing sentence, even when the service put them in a `detail` field.
fn mentions_internals(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "ollama",
        "mlx",
        "rapid",
        "sidecar",
        "huggingface",
        "hf_",
        "traceback",
        "faster-whisper",
        "ct2",
        "/",
        "{",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Symptoms of "the engine process isn't answering" in a service `detail`.
fn mentions_connection_failure(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "connect",
        "connection",
        "refused",
        "request failed",
        "timed out",
        "timeout",
        "unreachable",
        "not initialized",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// The human part of a FastAPI error body: either the structured
/// `{"detail": {"code", "message"}}` the service now sends, or a legacy plain
/// `{"detail": "…"}` string. `None` when the body isn't one of those.
enum ServiceError {
    Coded { code: String, message: String },
    Detail(String),
}

fn parse_service_error(body: &str) -> Option<ServiceError> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let detail = value.get("detail")?;
    if let Some(code) = detail.get("code").and_then(serde_json::Value::as_str) {
        return Some(ServiceError::Coded {
            code: code.to_string(),
            message: detail
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
        });
    }
    detail
        .as_str()
        .map(|text| ServiceError::Detail(text.trim().to_string()))
}

/// A sentence a user can act on for a failed `/transcribe`.
fn transcribe_error(body: &str) -> String {
    match parse_service_error(body) {
        Some(ServiceError::Coded { code, message }) => match code.as_str() {
            "transcriber_missing" => TRANSCRIBER_MISSING.to_string(),
            "transcriber_loading" => TRANSCRIBER_LOADING.to_string(),
            // `transcriber_error` carries the service's own human sentence.
            _ if !message.is_empty() && !mentions_internals(&message) => message,
            _ => TRANSCRIBE_FAILED.to_string(),
        },
        // Legacy plain-string detail (a service older than the V3 addendum).
        // "Transcriber not initialized" is that service's way of saying no
        // model is loaded — the 2026-07-31 Windows failure, verbatim. It is
        // jargon, and it is actionable, so translate rather than echo it.
        Some(ServiceError::Detail(detail)) if detail.to_lowercase().contains("not initialized") => {
            TRANSCRIBER_MISSING.to_string()
        }
        Some(ServiceError::Detail(detail))
            if !detail.is_empty()
                && !mentions_internals(&detail)
                && !mentions_connection_failure(&detail)
                && detail.len() < 200 =>
        {
            format!("Transcription failed: {detail}")
        }
        _ => TRANSCRIBE_FAILED.to_string(),
    }
}

/// A sentence a user can act on for a failed `/summarize`. A fresh install's
/// most likely failure is "no notes engine configured yet", which arrives as a
/// connection error naming the engine — never show that.
fn summarize_error(body: &str) -> String {
    match parse_service_error(body) {
        Some(ServiceError::Coded { message, .. })
            if !message.is_empty() && !mentions_internals(&message) =>
        {
            message
        }
        Some(ServiceError::Detail(detail)) if !detail.is_empty() => {
            if mentions_connection_failure(&detail) || mentions_internals(&detail) {
                NOTES_UNREACHABLE.to_string()
            } else if detail.len() < 200 {
                format!("Notes could not be written: {detail}")
            } else {
                NOTES_UNREACHABLE.to_string()
            }
        }
        _ => NOTES_UNREACHABLE.to_string(),
    }
}

/// `text` when it reads like a sentence a user can be shown, else `fallback`.
fn safe_sentence(text: &str, fallback: &str) -> String {
    if text.is_empty() || text.len() >= 200 || mentions_internals(text) {
        return fallback.to_string();
    }
    text.to_string()
}

/// The service's own `detail` when it is safe to show, else `fallback`.
fn service_error(body: &str, fallback: &str) -> String {
    match parse_service_error(body) {
        Some(ServiceError::Coded { message, .. }) => safe_sentence(&message, fallback),
        Some(ServiceError::Detail(detail)) => safe_sentence(&detail, fallback),
        None => fallback.to_string(),
    }
}

async fn read_token_stream(
    mut resp: reqwest::Response,
    mut on_token: impl FnMut(&str),
) -> Result<String, String> {
    // Buffer raw bytes and decode only COMPLETE SSE frames (split on a blank
    // line) — so a multibyte char (e.g. Arabic) straddling a chunk boundary
    // is never decoded mid-character.
    let mut buf: Vec<u8> = Vec::new();
    let mut answer = String::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| ANSWER_UNREACHABLE.to_string())?
    {
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
            let frame: Vec<u8> = buf.drain(..pos + 2).collect();
            for line in String::from_utf8_lossy(&frame).lines() {
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(t) = v.get("t").and_then(|x| x.as_str()) {
                        on_token(t);
                        answer.push_str(t);
                    } else if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                        return Err(service_error(e, ANSWER_UNREACHABLE));
                    }
                }
            }
        }
    }
    Ok(answer)
}

#[derive(Debug, serde::Deserialize)]
pub struct CopilotWarmResponse {
    pub ok: bool,
    pub ms: u64,
    pub detail: Option<String>,
}

/// Ceiling for the copilot gate round-trip. Temporary: it covers the
/// observed ~4 s queued completions when the 35B model is streaming another
/// card, not a measured optimum.
pub const COPILOT_GATE_TIMEOUT_MS: u64 = 6_000;

#[derive(Debug, Clone, serde::Serialize)]
pub struct GateRequest {
    pub candidate: String,
    pub speaker: String,
    pub mode: String,
    pub context_turns: Vec<String>,
    pub recent_questions: Vec<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateResponse {
    pub action: String,
    pub resolved_question: Option<String>,
    pub reason_code: String,
}

impl GateResponse {
    pub fn validate(self) -> Result<Self, String> {
        // `backend_error` is the Python gate backend reporting its own
        // failure (model call raised, output unparseable, summarizer
        // missing) — never a model verdict. Accept it only as an ignore
        // with no question, so the caller can apply its reason-aware
        // fallback instead of mistaking it for a genuine "ignore".
        if self.reason_code == "backend_error" {
            if self.action == "ignore" && self.resolved_question.is_none() {
                return Ok(self);
            }
            return Err("Invalid Copilot gate response".into());
        }
        let reason_valid = matches!(
            self.reason_code.as_str(),
            "direct_question"
                | "embedded_question"
                | "narration"
                | "answered_in_turn"
                | "repeat"
                | "no_request"
                | "unclear"
        );
        let question_valid = match self.action.as_str() {
            "ignore" => self.resolved_question.is_none(),
            "answer" => self.resolved_question.as_deref().is_some_and(|question| {
                let question = question.trim();
                !question.is_empty()
                    && question.chars().count() <= 2000
                    && question.chars().any(char::is_alphanumeric)
            }),
            _ => false,
        };
        if reason_valid && question_valid {
            Ok(self)
        } else {
            Err("Invalid Copilot gate response".into())
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CopilotAnswerRequest {
    pub provider: String,
    pub schema_version: u32,
    pub standing_pack: Option<String>,
    pub recent_cards: Vec<crate::types::RecentCard>,
    pub resolved_question: Option<String>,
    pub answer_shape: &'static str,
    pub question_source_tier: String,
    pub question: String,
    pub question_source: String,
    pub context_turns: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub stated_figures: Vec<String>,
    pub passages: Vec<CopilotEgressPassage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub voice_samples: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_summary: Option<String>,
    pub web_search: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_api_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CopilotFrame {
    Text(String),
    Replay(serde_json::Value),
    Section {
        section: String,
        index: u32,
        text: String,
        drop: bool,
    },
    Citation(CopilotCitation),
    Searching,
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        web_performed: u64,
    },
    Error(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CopilotStreamSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub web_searches: u64,
}

const COPILOT_ENDED_EARLY: &str = "The answer stream ended early";
const COPILOT_TRANSPORT: &str = "Copilot answer transport failed";
const COPILOT_TIMEOUT: &str = "Answer timed out after 20 s";

fn malformed_copilot_frame() -> String {
    COPILOT_ENDED_EARLY.to_string()
}

pub fn parse_copilot_frame(data: &str) -> Result<Option<CopilotFrame>, String> {
    let v: serde_json::Value = serde_json::from_str(data).map_err(|_| malformed_copilot_frame())?;
    // The per-card replay record (R1) must never be mistaken for another
    // frame, so it is parsed before every other branch. Unknown future keys
    // inside it are preserved verbatim.
    if let Some(replay) = v.get("replay") {
        return Ok(Some(CopilotFrame::Replay(replay.clone())));
    }
    if let Some(t) = v.get("t").and_then(|x| x.as_str()) {
        let drop = match v.get("drop") {
            Some(value) => value.as_bool().ok_or_else(malformed_copilot_frame)?,
            None => false,
        };
        let Some(section) = v.get("sec") else {
            return Ok(Some(CopilotFrame::Text(t.to_string())));
        };
        let section = section
            .as_str()
            .filter(|section| matches!(*section, "say" | "specific" | "notes" | "next"))
            .ok_or_else(malformed_copilot_frame)?;
        let index = match v.get("i") {
            Some(value) => value.as_u64().ok_or_else(malformed_copilot_frame)?,
            None => 0,
        };
        return Ok(Some(CopilotFrame::Section {
            section: section.to_string(),
            index: index as u32,
            text: t.to_string(),
            drop,
        }));
    }
    if v.get("t").is_some() {
        return Err(malformed_copilot_frame());
    }
    if let Some(c) = v.get("c") {
        let citation = serde_json::from_value::<CopilotCitation>(c.clone())
            .map_err(|_| malformed_copilot_frame())?;
        return Ok(Some(CopilotFrame::Citation(citation)));
    }
    if let Some(searching) = v.get("w") {
        if searching.as_str() != Some("searching") {
            return Err(malformed_copilot_frame());
        }
        return Ok(Some(CopilotFrame::Searching));
    }
    if let Some(usage) = v.get("usage") {
        let usage = usage.as_object().ok_or_else(malformed_copilot_frame)?;
        let count = |key| match usage.get(key) {
            Some(value) => value.as_u64().ok_or_else(malformed_copilot_frame),
            None => Ok(0),
        };
        let input_tokens = count("input_tokens")?;
        let output_tokens = count("output_tokens")?;
        let web_performed = count("web_searches")?;
        return Ok(Some(CopilotFrame::Usage {
            input_tokens,
            output_tokens,
            web_performed,
        }));
    }
    if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
        return Ok(Some(CopilotFrame::Error(e.to_string())));
    }
    if v.get("error").is_some() {
        return Err(malformed_copilot_frame());
    }
    Ok(None)
}

#[derive(Default)]
struct CopilotDecoder {
    buffer: Vec<u8>,
    last_usage: Option<CopilotStreamSummary>,
}

impl CopilotDecoder {
    fn push(
        &mut self,
        chunk: &[u8],
        on_frame: &mut impl FnMut(CopilotFrame),
    ) -> Result<Option<CopilotStreamSummary>, String> {
        self.buffer.extend_from_slice(chunk);
        while let Some((position, delimiter_len)) = complete_sse_frame(&self.buffer) {
            let frame: Vec<u8> = self.buffer.drain(..position + delimiter_len).collect();
            let frame = std::str::from_utf8(&frame).map_err(|_| malformed_copilot_frame())?;
            let data = frame
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                return self
                    .last_usage
                    .clone()
                    .map(Some)
                    .ok_or_else(malformed_copilot_frame);
            }
            if let Some(parsed) = parse_copilot_frame(data)? {
                if let CopilotFrame::Usage {
                    input_tokens,
                    output_tokens,
                    web_performed,
                } = &parsed
                {
                    self.last_usage = Some(CopilotStreamSummary {
                        input_tokens: *input_tokens,
                        output_tokens: *output_tokens,
                        web_searches: *web_performed,
                    });
                }
                let error = match &parsed {
                    CopilotFrame::Error(error) => Some(error.clone()),
                    _ => None,
                };
                on_frame(parsed);
                if let Some(error) = error {
                    return Err(error);
                }
            }
        }
        Ok(None)
    }

    fn finish(self) -> Result<CopilotStreamSummary, String> {
        Err(malformed_copilot_frame())
    }
}

fn complete_sse_frame(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|window| window == b"\n\n");
    let crlf = buffer.windows(4).position(|window| window == b"\r\n\r\n");
    match (lf, crlf) {
        (Some(left), Some(right)) if left <= right => Some((left, 2)),
        (Some(_), Some(right)) => Some((right, 4)),
        (Some(position), None) => Some((position, 2)),
        (None, Some(position)) => Some((position, 4)),
        (None, None) => None,
    }
}

async fn read_copilot_stream(
    mut resp: reqwest::Response,
    mut on_frame: impl FnMut(CopilotFrame),
) -> Result<CopilotStreamSummary, String> {
    let mut decoder = CopilotDecoder::default();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| COPILOT_TRANSPORT.to_string())?
    {
        if let Some(summary) = decoder.push(&chunk, &mut on_frame)? {
            return Ok(summary);
        }
    }
    decoder.finish()
}

async fn with_copilot_body_timeout<F>(
    timeout: std::time::Duration,
    read: F,
) -> Result<CopilotStreamSummary, String>
where
    F: std::future::Future<Output = Result<CopilotStreamSummary, String>>,
{
    tokio::time::timeout(timeout, read)
        .await
        .map_err(|_| COPILOT_TIMEOUT.to_string())?
}

/// Owned parameters for the final-transcription HTTP boundary.
#[derive(serde::Serialize)]
pub struct TranscribeParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mic_audio_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub me_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vocabulary: Option<String>,
    pub diarize: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whisper_model: Option<String>,
}

/// Owned parameters for the summary-generation HTTP boundary.
#[derive(serde::Serialize)]
pub struct SummarizeParams {
    pub transcript: String,
    pub template_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attached_context: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub prior_meetings: Vec<crate::types::PriorMeeting>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub accepted_live_items: Vec<AcceptedLiveItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_attendees: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_hint: Option<String>,
    pub auto_template: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer_label: Option<String>,
    /// The recording's calendar date as `YYYY-MM-DD`, so the summarizer can
    /// resolve a spoken "by Friday" into a real due date. Omitted from the wire
    /// when `None` — an older service ignores the field, and a newer service
    /// treats its absence as "no date context" (no dates are invented).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_date: Option<String>,
}

/// One `/live_feed` reply: finished utterances plus the streaming preview
/// of what is being said right now (empty when idle or unsupported).
#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct LiveFeedResult {
    pub captions: Vec<String>,
    #[serde(default)]
    pub caption_boundaries: Vec<String>,
    #[serde(default)]
    pub partial: String,
}

/// Typed client for the Python ML service running on localhost.
pub struct HttpClient {
    client: reqwest::Client,
    base_url: std::sync::RwLock<String>,
}

impl HttpClient {
    /// Create a new client pointed at `base_url` (e.g. `"http://127.0.0.1:9876"`).
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: std::sync::RwLock::new(base_url.into()),
        }
    }

    /// Replace the base URL at runtime (e.g. after the user edits the service
    /// URL in Settings), so the change takes effect without an app restart.
    pub fn set_base_url(&self, base_url: impl Into<String>) {
        *self.base_url.write().unwrap() = base_url.into();
    }

    /// Check whether the Python service is healthy.
    pub async fn check_health(&self) -> Result<HealthResponse, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .get(format!("{}/health", base_url))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    "The local AI service did not respond within 5 seconds.".to_string()
                } else {
                    SERVICE_DOWN.to_string()
                }
            })?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(
                &body,
                "The local AI service isn't ready yet — try again in a moment.",
            ));
        }

        resp.json::<HealthResponse>()
            .await
            .map_err(|_| UNEXPECTED_RESPONSE.to_string())
    }

    /// Send audio file path(s) to the transcription endpoint.  When a
    /// mic recording is provided the service returns a speaker-labeled
    /// transcript (Me = mic, Them = system audio).
    pub async fn transcribe(&self, params: TranscribeParams) -> Result<TranscribeResponse, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/transcribe", base_url))
            .json(&params)
            .timeout(std::time::Duration::from_secs(30 * 60))
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    TRANSCRIBE_TIMEOUT.to_string()
                } else {
                    SERVICE_DOWN.to_string()
                }
            })?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(transcribe_error(&body));
        }

        resp.json::<TranscribeResponse>()
            .await
            .map_err(|_| TRANSCRIBE_FAILED.to_string())
    }

    /// Transcribe a single-track import file (no mic, no dual merge). The Python
    /// service decodes the file in-process and runs plain single-track Whisper.
    pub async fn transcribe_import(&self, audio_path: &str) -> Result<TranscribeResponse, String> {
        #[derive(serde::Serialize)]
        struct Req {
            audio_path: String,
            single_file: bool,
        }
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/transcribe", base_url))
            .json(&Req {
                audio_path: audio_path.to_string(),
                single_file: true,
            })
            .timeout(std::time::Duration::from_secs(30 * 60))
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    TRANSCRIBE_TIMEOUT.to_string()
                } else {
                    SERVICE_DOWN.to_string()
                }
            })?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(transcribe_error(&body));
        }
        resp.json::<TranscribeResponse>()
            .await
            .map_err(|_| TRANSCRIBE_FAILED.to_string())
    }

    /// List curated on-device Whisper models with their download status.
    pub async fn whisper_models(&self) -> Result<Vec<WhisperModelInfo>, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .get(format!("{}/whisper_models", base_url))
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(
                &body,
                "The list of transcription models couldn't be loaded — try again in a moment.",
            ));
        }
        resp.json::<Vec<WhisperModelInfo>>()
            .await
            .map_err(|_| UNEXPECTED_RESPONSE.to_string())
    }

    /// Download (cache) an on-device Whisper model so it's ready before recording.
    /// Can take a while (multi-GB); the request client must not impose a short timeout.
    pub async fn whisper_download(&self, model: &str) -> Result<(), String> {
        #[derive(serde::Serialize)]
        struct Req<'a> {
            model: &'a str,
        }
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/whisper_download", base_url))
            .json(&Req { model })
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(
                &body,
                "The transcription model couldn't be downloaded — check your connection and try again.",
            ));
        }
        Ok(())
    }

    /// Wait until the local service is accepting HTTP requests. The bundled
    /// sidecar takes a while to boot on first launch (Gatekeeper scan + Python
    /// imports), so setup-path callers use this instead of failing on the
    /// first connect error.
    pub async fn wait_until_ready(&self, max_wait: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + max_wait;
        loop {
            let base_url = self.base_url.read().unwrap().clone();
            let ready = matches!(
                self.client
                    .get(format!("{base_url}/health"))
                    .timeout(std::time::Duration::from_secs(5))
                    .send()
                    .await,
                Ok(resp) if resp.status().is_success()
            );
            if ready {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        }
    }

    /// Start or resume an immutable, app-owned local meeting-model snapshot.
    pub async fn start_model_download(
        &self,
        profile_id: &str,
    ) -> Result<ModelDownloadStatus, String> {
        #[derive(serde::Serialize)]
        struct Req<'a> {
            profile_id: &'a str,
        }
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{base_url}/setup/model_download"))
            .json(&Req { profile_id })
            .send()
            .await
            .map_err(|_| "The local setup service is not ready; retry in a moment.".to_string())?;
        if !resp.status().is_success() {
            return Err("The selected local model could not be started.".to_string());
        }
        resp.json::<ModelDownloadStatus>()
            .await
            .map_err(|_| "The local setup service returned an invalid response.".to_string())
    }

    /// Reset one pinned model download, optionally deleting its cached weights.
    pub async fn reset_model_download(
        &self,
        profile_id: &str,
        force: bool,
    ) -> Result<ModelDownloadStatus, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!(
                "{base_url}/setup/model_download/{profile_id}/reset"
            ))
            .query(&[("force", force)])
            .send()
            .await
            .map_err(|_| "The local setup service is not ready; retry in a moment.".to_string())?;
        if !resp.status().is_success() {
            return Err("The selected local model could not be reset.".to_string());
        }
        resp.json::<ModelDownloadStatus>()
            .await
            .map_err(|_| "The local setup service returned an invalid response.".to_string())
    }

    /// Read safe aggregate progress for one pinned local model profile.
    pub async fn model_download_status(
        &self,
        profile_id: &str,
    ) -> Result<ModelDownloadStatus, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .get(format!("{base_url}/setup/model_download/{profile_id}"))
            .send()
            .await
            .map_err(|_| "The local setup service is not ready; retry in a moment.".to_string())?;
        if !resp.status().is_success() {
            return Err("The selected local model has no download status.".to_string());
        }
        resp.json::<ModelDownloadStatus>()
            .await
            .map_err(|_| "The local setup service returned an invalid response.".to_string())
    }

    /// Transcribe a short rolling-window WAV for the live-caption preview.
    /// Returns the window's text (empty string on a non-2xx or parse issue —
    /// the live preview is best-effort and must never break recording).
    pub async fn transcribe_chunk(&self, audio_path: &str) -> Result<String, String> {
        #[derive(serde::Serialize)]
        struct ChunkRequest {
            audio_path: String,
        }
        #[derive(serde::Deserialize)]
        struct ChunkResp {
            text: String,
        }

        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/transcribe_chunk", base_url))
            .json(&ChunkRequest {
                audio_path: audio_path.to_string(),
            })
            .send()
            .await
            .map_err(|e| format!("Chunk request failed: {e}"))?;

        if !resp.status().is_success() {
            return Ok(String::new());
        }
        match resp.json::<ChunkResp>().await {
            Ok(parsed) => Ok(parsed.text),
            Err(_) => Ok(String::new()),
        }
    }

    /// Feed a delta of new recording audio to the VAD-gated live-caption
    /// session; returns finished utterances plus the current streaming preview.
    /// Best-effort — non-2xx and parse failures return an empty result.
    pub async fn live_feed(
        &self,
        audio_path: &str,
        session: u64,
        source: &str,
    ) -> Result<LiveFeedResult, String> {
        #[derive(serde::Serialize)]
        struct FeedRequest {
            audio_path: String,
            session: u64,
            source: String,
        }

        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/live_feed", base_url))
            .json(&FeedRequest {
                audio_path: audio_path.to_string(),
                session,
                source: source.to_string(),
            })
            .send()
            .await
            .map_err(|e| format!("Live feed request failed: {e}"))?;

        if !resp.status().is_success() {
            return Ok(LiveFeedResult::default());
        }
        match resp.json::<LiveFeedResult>().await {
            Ok(parsed) => Ok(parsed),
            Err(_) => Ok(LiveFeedResult::default()),
        }
    }

    /// Ask the Python service to summarise a transcript using the given
    /// prompt template and (optionally) a specific Ollama model.
    pub async fn summarize(&self, params: SummarizeParams) -> Result<SummarizeResponse, String> {
        if !params.accepted_live_items.is_empty() {
            eprintln!(
                "[copilot] [info] attaching {} accepted live items to summary",
                params.accepted_live_items.len()
            );
        }
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/summarize", base_url))
            .json(&params)
            .timeout(std::time::Duration::from_secs(10 * 60))
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    NOTES_TIMEOUT.to_string()
                } else {
                    SERVICE_DOWN.to_string()
                }
            })?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(summarize_error(&body));
        }

        resp.json::<SummarizeResponse>()
            .await
            .map_err(|_| UNEXPECTED_RESPONSE.to_string())
    }

    pub async fn copilot_gate(&self, req: &GateRequest) -> Result<GateResponse, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let started = std::time::Instant::now();
        let result = self
            .client
            .post(format!("{}/copilot/gate", base_url.trim_end_matches('/')))
            .timeout(std::time::Duration::from_millis(COPILOT_GATE_TIMEOUT_MS))
            .json(req)
            .send()
            .await
            .map_err(|error| format!("Copilot gate request failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("Copilot gate failed: {error}"))?
            .json::<GateResponse>()
            .await
            .map_err(|error| format!("Copilot gate returned invalid JSON: {error}"))?
            .validate();
        let elapsed_ms = started.elapsed().as_millis();
        match &result {
            Ok(response) => eprintln!(
                "[copilot] gate ms={elapsed_ms} action={} reason={}",
                response.action, response.reason_code
            ),
            Err(error) => eprintln!("[copilot] gate ms={elapsed_ms} action=error reason={error}"),
        }
        result
    }

    pub async fn copilot_live_extract(
        &self,
        req: &crate::types::LiveExtractRequest,
    ) -> Result<crate::types::LiveExtractResponse, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let response = self
            .client
            .post(format!(
                "{}/copilot/live_extract",
                base_url.trim_end_matches('/')
            ))
            .timeout(std::time::Duration::from_secs(12))
            .json(req)
            .send()
            .await
            .map_err(|error| format!("Live capture request failed: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "Live capture failed ({status}): {}",
                body.chars().take(300).collect::<String>()
            ));
        }
        response
            .json()
            .await
            .map_err(|error| format!("Live capture returned an unreadable response: {error}"))
    }

    /// Draft a note template from a plain-language description.
    ///
    /// Returns the text only; nothing is saved. The user reviews the draft in the
    /// editor and names it, so a poor draft costs nothing.
    pub async fn generate_template(
        &self,
        description: &str,
        model: &str,
        llm_base_url: &str,
        llm_api_key: &str,
    ) -> Result<String, String> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            description: &'a str,
            model: &'a str,
            llm_base_url: &'a str,
            llm_api_key: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Reply {
            template: String,
        }

        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/generate-template", base_url))
            .json(&Body {
                description,
                model,
                llm_base_url,
                llm_api_key,
            })
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(summarize_error(&body));
        }

        resp.json::<Reply>()
            .await
            .map(|reply| reply.template)
            .map_err(|_| UNEXPECTED_RESPONSE.to_string())
    }

    /// Ask a grounded question about a meeting transcript; returns the answer text.
    pub async fn chat(
        &self,
        transcript: &str,
        question: &str,
        model: Option<&str>,
        llm_base_url: Option<&str>,
        llm_api_key: Option<&str>,
    ) -> Result<String, String> {
        #[derive(serde::Serialize)]
        struct ChatRequest {
            transcript: String,
            question: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            model: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            llm_base_url: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            llm_api_key: Option<String>,
        }

        #[derive(serde::Deserialize)]
        struct ChatResp {
            answer: String,
        }

        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/chat", base_url))
            .json(&ChatRequest {
                transcript: transcript.to_string(),
                question: question.to_string(),
                model: model.map(str::to_string),
                llm_base_url: llm_base_url.map(str::to_string),
                llm_api_key: llm_api_key.map(str::to_string),
            })
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(&body, ANSWER_UNREACHABLE));
        }

        let parsed: ChatResp = resp
            .json()
            .await
            .map_err(|_| ANSWER_UNREACHABLE.to_string())?;
        Ok(parsed.answer)
    }

    /// Like `chat`, but streams: `on_token` is called with each text delta as it
    /// arrives, and the full accumulated answer is returned. Talks to the
    /// service's `/chat_stream` SSE endpoint — frames `data: {"t":"…"}`, ended by
    /// `data: [DONE]`; an error frame is `data: {"error":"…"}`.
    pub async fn chat_stream(
        &self,
        transcript: &str,
        question: &str,
        model: Option<&str>,
        llm_base_url: Option<&str>,
        llm_api_key: Option<&str>,
        on_token: impl FnMut(&str),
    ) -> Result<String, String> {
        #[derive(serde::Serialize)]
        struct ChatRequest {
            transcript: String,
            question: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            model: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            llm_base_url: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            llm_api_key: Option<String>,
        }

        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/chat_stream", base_url))
            .json(&ChatRequest {
                transcript: transcript.to_string(),
                question: question.to_string(),
                model: model.map(str::to_string),
                llm_base_url: llm_base_url.map(str::to_string),
                llm_api_key: llm_api_key.map(str::to_string),
            })
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(&body, ANSWER_UNREACHABLE));
        }

        read_token_stream(resp, on_token).await
    }

    /// Stream a workspace deliverable drafted from a self-contained task brief.
    pub async fn draft_stream(
        &self,
        brief: &str,
        instruction: &str,
        model: Option<&str>,
        llm_base_url: Option<&str>,
        llm_api_key: Option<&str>,
        on_token: impl FnMut(&str),
    ) -> Result<String, String> {
        #[derive(serde::Serialize)]
        struct DraftRequest {
            brief: String,
            instruction: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            model: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            llm_base_url: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            llm_api_key: Option<String>,
        }

        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/draft_stream", base_url))
            .json(&DraftRequest {
                brief: brief.to_string(),
                instruction: instruction.to_string(),
                model: model.map(str::to_string),
                llm_base_url: llm_base_url.map(str::to_string),
                llm_api_key: llm_api_key.map(str::to_string),
            })
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(&body, ANSWER_UNREACHABLE));
        }

        read_token_stream(resp, on_token).await
    }

    fn copilot_warm_request(
        &self,
        model: &str,
        base_url: Option<&str>,
        api_key: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let service_url = self.base_url.read().unwrap().clone();
        self.client
            .post(format!("{service_url}/copilot/warm"))
            .timeout(std::time::Duration::from_secs(120))
            .json(&serde_json::json!({"model": model, "llm_base_url": base_url, "llm_api_key": api_key}))
    }

    pub async fn copilot_warm(
        &self,
        model: &str,
        base_url: Option<&str>,
        api_key: Option<&str>,
    ) -> Result<CopilotWarmResponse, String> {
        self.copilot_warm_request(model, base_url, api_key)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json()
            .await
            .map_err(|error| error.to_string())
    }

    /// Stream live Copilot answers, requiring authoritative usage and `[DONE]`.
    pub async fn copilot_answer_stream(
        &self,
        req: &CopilotAnswerRequest,
        on_frame: impl FnMut(CopilotFrame),
    ) -> Result<CopilotStreamSummary, String> {
        self.copilot_answer_stream_with_timeout(req, on_frame, std::time::Duration::from_secs(20))
            .await
    }

    async fn copilot_answer_stream_with_timeout(
        &self,
        req: &CopilotAnswerRequest,
        on_frame: impl FnMut(CopilotFrame),
        timeout: std::time::Duration,
    ) -> Result<CopilotStreamSummary, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/copilot_answer_stream", base_url))
            .timeout(timeout)
            .json(req)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    COPILOT_TIMEOUT.to_string()
                } else {
                    COPILOT_TRANSPORT.to_string()
                }
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if matches!(status.as_u16(), 400 | 422) {
                return Err("Copilot request validation failed".to_string());
            }
            return Err(service_error(&body, "Copilot answer provider failed"));
        }

        with_copilot_body_timeout(timeout, read_copilot_stream(resp, on_frame)).await
    }

    /// Fetch the list of available prompt templates from the service.
    pub async fn list_templates(&self) -> Result<Vec<TemplateInfo>, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .get(format!("{}/templates", base_url))
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(&body, TEMPLATES_UNAVAILABLE));
        }
        resp.json::<Vec<TemplateInfo>>()
            .await
            .map_err(|_| TEMPLATES_UNAVAILABLE.to_string())
    }

    /// Fetch one template's raw markdown content.
    pub async fn get_template(&self, name: &str) -> Result<String, String> {
        #[derive(serde::Deserialize)]
        struct Resp {
            content: String,
        }
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .get(format!("{}/templates/{}", base_url, name))
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(&body, TEMPLATES_UNAVAILABLE));
        }
        resp.json::<Resp>()
            .await
            .map(|r| r.content)
            .map_err(|_| TEMPLATES_UNAVAILABLE.to_string())
    }

    /// Create or overwrite a template.
    pub async fn save_template(&self, name: &str, content: &str) -> Result<(), String> {
        #[derive(serde::Serialize)]
        struct Body {
            content: String,
        }
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .put(format!("{}/templates/{}", base_url, name))
            .json(&Body {
                content: content.to_string(),
            })
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(
                &body,
                "That note template could not be saved.",
            ));
        }
        Ok(())
    }

    /// Delete a template.
    pub async fn delete_template(&self, name: &str) -> Result<(), String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .delete(format!("{}/templates/{}", base_url, name))
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(service_error(
                &body,
                "That note template could not be deleted.",
            ));
        }
        Ok(())
    }

    /// The client's current base URL — for handing a background task its own
    /// client (the sidecar port is chosen dynamically at spawn).
    pub fn current_base_url(&self) -> String {
        self.base_url.read().unwrap().clone()
    }

    /// Embed a batch of texts with the service's local embedding model.
    /// Returns (one vector per text, model name). An Err means the vector layer
    /// is unavailable (service down or embedding model not pulled) — callers
    /// treat that as "skip semantic search", never as a user-facing failure.
    pub async fn embed(&self, texts: &[String]) -> Result<(Vec<Vec<f32>>, String), String> {
        #[derive(serde::Serialize)]
        struct EmbedRequest<'a> {
            texts: &'a [String],
        }

        #[derive(serde::Deserialize)]
        struct EmbedResp {
            embeddings: Vec<Vec<f32>>,
            model: String,
        }

        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/embed", base_url))
            .json(&EmbedRequest { texts })
            .send()
            .await
            .map_err(|e| format!("Embedding request failed: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Embedding failed: {body}"));
        }

        resp.json::<EmbedResp>()
            .await
            .map(|parsed| (parsed.embeddings, parsed.model))
            .map_err(|e| format!("Failed to parse embed response: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_wire_request_matches_the_local_service_contract() {
        let request = GateRequest {
            candidate: "So for example, who is the founder of OpenAI? Bye.".into(),
            speaker: "Me".into(),
            mode: "self_ask".into(),
            context_turns: vec!["Them: We discussed OpenAI.".into()],
            recent_questions: vec!["What is an LLM?".into()],
            model: Some("qwen3.6:35b".into()),
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "candidate": "So for example, who is the founder of OpenAI? Bye.",
                "speaker": "Me", "mode": "self_ask",
                "context_turns": ["Them: We discussed OpenAI."],
                "recent_questions": ["What is an LLM?"], "model": "qwen3.6:35b"
            })
        );
    }

    #[test]
    fn gate_response_rejects_invalid_actions_reasons_and_resolutions() {
        let valid = serde_json::json!({
            "action": "answer", "resolved_question": "Who founded OpenAI?",
            "reason_code": "direct_question"
        });
        let parse = |value: serde_json::Value| {
            serde_json::from_value::<GateResponse>(value)
                .map_err(|error| error.to_string())
                .and_then(GateResponse::validate)
        };
        assert!(parse(valid.clone()).is_ok());
        for (key, value) in [
            ("action", serde_json::json!("maybe")),
            ("reason_code", serde_json::json!("unknown")),
            ("resolved_question", serde_json::Value::Null),
            ("resolved_question", serde_json::json!("   ")),
            ("resolved_question", serde_json::json!("?! ... ?!")),
            ("resolved_question", serde_json::json!("x".repeat(2001))),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(parse(invalid).is_err(), "{key}");
        }
        assert!(parse(serde_json::json!({"action": "ignore", "resolved_question": null, "reason_code": "narration"})).is_ok());
        assert!(parse(serde_json::json!({"action": "ignore", "resolved_question": "Who founded OpenAI?", "reason_code": "narration"})).is_err());
        assert!(serde_json::from_str::<GateResponse>("not JSON").is_err());
    }

    #[test]
    fn gate_response_accepts_multi_question_and_unbounded_resolved_questions() {
        let parse = |resolved: &str| {
            serde_json::from_value::<GateResponse>(serde_json::json!({
                "action": "answer",
                "resolved_question": resolved,
                "reason_code": "direct_question",
            }))
            .map_err(|error| error.to_string())
            .and_then(GateResponse::validate)
        };
        // One card holds every request: declaratives, several questions and
        // long rewrites are all valid within 2000 characters.
        assert!(parse("What is X? What is Y?").is_ok());
        assert!(parse("OpenAI was founded.").is_ok());
        assert!(parse(&format!("Who {}?", "founded ".repeat(60))).is_ok());
        assert!(parse(&"x".repeat(2000)).is_ok());
    }

    #[test]
    fn gate_response_accepts_backend_error_only_as_questionless_ignore() {
        let parse = |value: serde_json::Value| {
            serde_json::from_value::<GateResponse>(value)
                .map_err(|error| error.to_string())
                .and_then(GateResponse::validate)
        };
        assert!(parse(serde_json::json!({"action": "ignore", "resolved_question": null, "reason_code": "backend_error"})).is_ok());
        assert!(
            parse(serde_json::json!({"action": "ignore", "reason_code": "backend_error"})).is_ok()
        );
        assert!(parse(serde_json::json!({"action": "answer", "resolved_question": "Who founded OpenAI?", "reason_code": "backend_error"})).is_err());
        assert!(parse(serde_json::json!({"action": "ignore", "resolved_question": "Who founded OpenAI?", "reason_code": "backend_error"})).is_err());
    }

    #[test]
    fn summarize_params_omit_empty_accepted_items_and_preserve_wire_fields() {
        let mut params = SummarizeParams {
            transcript: "The team discussed the launch checklist.".into(),
            template_name: "general".into(),
            model: None,
            output_language: None,
            user_notes: None,
            attached_context: None,
            prior_meetings: Vec::new(),
            accepted_live_items: Vec::new(),
            llm_base_url: None,
            llm_api_key: None,
            known_attendees: None,
            category_hint: None,
            auto_template: false,
            viewer_label: None,
            meeting_date: None,
        };
        let empty = serde_json::to_value(&params).unwrap();
        assert!(empty.get("accepted_live_items").is_none());

        params.accepted_live_items.push(AcceptedLiveItem {
            id: "li_action".into(),
            kind: "action".into(),
            text: "Send the revised launch checklist".into(),
            owner: Some("Amina".into()),
            due: Some("2026-09-18".into()),
            evidence_turn_ids: vec!["t8".into(), "t9".into()],
            revision: 3,
        });
        let populated = serde_json::to_value(&params).unwrap();
        assert_eq!(
            populated["accepted_live_items"],
            serde_json::json!([{
                "id": "li_action",
                "kind": "action",
                "text": "Send the revised launch checklist",
                "owner": "Amina",
                "due": "2026-09-18",
                "evidence_turn_ids": ["t8", "t9"],
                "revision": 3
            }])
        );
        params.accepted_live_items[0].owner = None;
        params.accepted_live_items[0].due = None;
        let no_metadata = serde_json::to_value(&params).unwrap();
        assert_eq!(
            no_metadata["accepted_live_items"][0].get("owner"),
            Some(&serde_json::Value::Null)
        );
        assert_eq!(
            no_metadata["accepted_live_items"][0].get("due"),
            Some(&serde_json::Value::Null)
        );
        let round_trip: Vec<AcceptedLiveItem> =
            serde_json::from_value(no_metadata["accepted_live_items"].clone()).unwrap();
        assert_eq!(round_trip, params.accepted_live_items);
    }

    /// The exact body a fresh Windows 0.3.68 install produced. It reached the
    /// user verbatim as `Transcription failed: {"detail":"Transcriber not
    /// initialized"}` — the failure that triggered the V3 addendum.
    #[test]
    fn legacy_transcriber_body_never_reaches_the_user() {
        let message = transcribe_error(r#"{"detail":"Transcriber not initialized"}"#);
        assert_eq!(message, TRANSCRIBER_MISSING);
        assert!(!message.contains('{'));
        assert!(!message
            .to_lowercase()
            .contains("transcriber not initialized"));
    }

    /// A plain sentence from the service is still worth showing.
    #[test]
    fn legacy_human_detail_survives() {
        assert_eq!(
            transcribe_error(r#"{"detail":"The audio file is empty."}"#),
            "Transcription failed: The audio file is empty."
        );
    }

    #[test]
    fn structured_transcriber_codes_become_instructions() {
        assert_eq!(
            transcribe_error(
                r#"{"detail":{"code":"transcriber_missing","message":"No model cached"}}"#
            ),
            TRANSCRIBER_MISSING
        );
        assert_eq!(
            transcribe_error(
                r#"{"detail":{"code":"transcriber_loading","message":"Still loading"}}"#
            ),
            TRANSCRIBER_LOADING
        );
    }

    #[test]
    fn transcriber_error_keeps_a_human_sentence_but_drops_internals() {
        assert_eq!(
            transcribe_error(
                r#"{"detail":{"code":"transcriber_error","message":"The recording could not be read."}}"#
            ),
            "The recording could not be read."
        );
        // A traceback / repo id / path must never survive translation.
        assert_eq!(
            transcribe_error(
                r#"{"detail":{"code":"transcriber_error","message":"Traceback: faster-whisper failed"}}"#
            ),
            TRANSCRIBE_FAILED
        );
    }

    #[test]
    fn summarize_connection_failures_point_at_settings() {
        assert_eq!(
            summarize_error(r#"{"detail":"Ollama request failed: Connection refused"}"#),
            NOTES_UNREACHABLE
        );
        assert_eq!(summarize_error("not json at all"), NOTES_UNREACHABLE);
    }

    #[test]
    fn service_error_falls_back_when_the_body_is_unusable() {
        assert_eq!(
            service_error("", TEMPLATES_UNAVAILABLE),
            TEMPLATES_UNAVAILABLE
        );
        assert_eq!(
            service_error(
                r#"{"detail":"That template name is already taken."}"#,
                TEMPLATES_UNAVAILABLE
            ),
            "That template name is already taken."
        );
    }

    #[test]
    fn parse_copilot_frame_handles_all_frame_kinds() {
        assert_eq!(
            parse_copilot_frame(r#"{"t": "Hello world"}"#),
            Ok(Some(CopilotFrame::Text("Hello world".to_string())))
        );
        assert_eq!(
            parse_copilot_frame(
                r#"{"c": {"kind": "notes", "passage_index": 2, "cited_text": "sample text"}}"#
            ),
            Ok(Some(CopilotFrame::Citation(CopilotCitation {
                kind: "notes".to_string(),
                passage_index: Some(2),
                cited_text: Some("sample text".to_string()),
                url: None,
                title: None,
            })))
        );
        assert_eq!(
            parse_copilot_frame(
                r#"{"c": {"kind": "web", "url": "https://example.com", "title": "Example", "cited_text": "web quote"}}"#
            ),
            Ok(Some(CopilotFrame::Citation(CopilotCitation {
                kind: "web".to_string(),
                passage_index: None,
                cited_text: Some("web quote".to_string()),
                url: Some("https://example.com".to_string()),
                title: Some("Example".to_string()),
            })))
        );
        assert_eq!(
            parse_copilot_frame(r#"{"w": "searching"}"#),
            Ok(Some(CopilotFrame::Searching))
        );
        assert_eq!(
            parse_copilot_frame(
                r#"{"usage": {"input_tokens": 120, "output_tokens": 45, "web_searches": 2}}"#
            ),
            Ok(Some(CopilotFrame::Usage {
                input_tokens: 120,
                output_tokens: 45,
                web_performed: 2,
            }))
        );
        assert_eq!(
            parse_copilot_frame(r#"{"error": "Anthropic rate limit reached"}"#),
            Ok(Some(CopilotFrame::Error(
                "Anthropic rate limit reached".to_string()
            )))
        );
        assert_eq!(parse_copilot_frame(r#"{"future": true}"#), Ok(None));
        assert!(parse_copilot_frame("not json").is_err());
        assert!(parse_copilot_frame(r#"{"t": 42}"#).is_err());
    }

    #[test]
    fn replay_frame_decodes_verbatim_and_text_usage_still_decode() {
        let replay = serde_json::json!({"v": 1, "prompt_sha": "abc123", "future_key": [1, 2]});
        let data = serde_json::json!({"replay": replay}).to_string();
        assert_eq!(
            parse_copilot_frame(&data),
            Ok(Some(CopilotFrame::Replay(replay)))
        );
        let mut decoder = CopilotDecoder::default();
        let mut frames = Vec::new();
        assert_eq!(
            decoder.push(b"data: {\"replay\":{\"v\":1}}\n\n", &mut |frame| frames
                .push(frame)),
            Ok(None)
        );
        assert_eq!(
            frames,
            vec![CopilotFrame::Replay(serde_json::json!({"v": 1}))]
        );
        assert_eq!(
            parse_copilot_frame(r#"{"t": "Hello world"}"#),
            Ok(Some(CopilotFrame::Text("Hello world".to_string())))
        );
        assert_eq!(
            parse_copilot_frame(
                r#"{"usage": {"input_tokens": 120, "output_tokens": 45, "web_searches": 2}}"#
            ),
            Ok(Some(CopilotFrame::Usage {
                input_tokens: 120,
                output_tokens: 45,
                web_performed: 2,
            }))
        );
    }

    #[test]
    fn copilot_parser_reads_sections_and_legacy_text() {
        assert_eq!(
            parse_copilot_frame(r#"{"t":"x","sec":"say","i":0,"future":true}"#),
            Ok(Some(CopilotFrame::Section {
                section: "say".into(),
                index: 0,
                text: "x".into(),
                drop: false,
            }))
        );
        assert_eq!(
            parse_copilot_frame(r#"{"t":"x"}"#),
            Ok(Some(CopilotFrame::Text("x".into())))
        );
        for section in ["specific", "notes", "next"] {
            let value = serde_json::json!({"t": "x", "sec": section});
            assert_eq!(
                parse_copilot_frame(&value.to_string()),
                Ok(Some(CopilotFrame::Section {
                    section: section.into(),
                    index: 0,
                    text: "x".into(),
                    drop: false,
                }))
            );
        }
        for value in [
            r#"{"t":"x","sec":"bogus"}"#,
            r#"{"t":"x","sec":null}"#,
            r#"{"t":"x","sec":1}"#,
            r#"{"t":"x","sec":"say","i":-1}"#,
            r#"{"t":"x","sec":"say","i":0.5}"#,
            r#"{"t":"x","sec":"say","i":"0"}"#,
            r#"{"t":"x","sec":"say","i":null}"#,
        ] {
            assert_eq!(
                parse_copilot_frame(value),
                Err(malformed_copilot_frame()),
                "{value}"
            );
        }
    }

    #[test]
    fn copilot_parser_reads_drop_flags_and_rejects_non_boolean_values() {
        for drop in [true, false] {
            let value = serde_json::json!({"t": "", "sec": "notes", "i": 1, "drop": drop});
            assert_eq!(
                parse_copilot_frame(&value.to_string()),
                Ok(Some(CopilotFrame::Section {
                    section: "notes".into(),
                    index: 1,
                    text: String::new(),
                    drop,
                }))
            );
        }
        for invalid in [
            serde_json::json!("true"),
            serde_json::json!(1),
            serde_json::Value::Null,
        ] {
            let value = serde_json::json!({"t": "", "sec": "notes", "i": 0, "drop": invalid});
            assert_eq!(
                parse_copilot_frame(&value.to_string()),
                Err(malformed_copilot_frame())
            );
        }
    }

    #[test]
    fn copilot_decoder_handles_split_utf8_unknown_keys_usage_and_done() {
        let mut decoder = CopilotDecoder::default();
        let mut frames = Vec::new();
        let frame_text = "data: {\"t\": \"مرحبا\"}\n\n";
        let bytes = frame_text.as_bytes();
        let split_pos = bytes.iter().position(|&b| b == 0xD9).unwrap() + 1;
        assert_eq!(
            decoder.push(&bytes[..split_pos], &mut |frame| frames.push(frame)),
            Ok(None)
        );
        assert!(frames.is_empty());
        assert_eq!(
            decoder.push(&bytes[split_pos..], &mut |frame| frames.push(frame)),
            Ok(None)
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], CopilotFrame::Text("مرحبا".to_string()));
        assert_eq!(
            decoder.push(b"data: {\"future\":true}\n\n", &mut |frame| frames
                .push(frame)),
            Ok(None)
        );
        assert_eq!(
            decoder.push(
                b"data: {\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"web_searches\":1}}\n\n",
                &mut |frame| frames.push(frame),
            ),
            Ok(None)
        );
        assert_eq!(
            decoder.push(b"data: [DONE]\n\n", &mut |frame| frames.push(frame)),
            Ok(Some(CopilotStreamSummary {
                input_tokens: 3,
                output_tokens: 2,
                web_searches: 1,
            }))
        );
    }

    #[test]
    fn copilot_decoder_rejects_every_non_authoritative_terminal() {
        let cases: &[&[u8]] = &[
            b"data: {\"t\":\"partial\"}\n\n",
            b"data: {malformed}\n\n",
            b"data: {\"t\":\"partial\"}",
            b"data: {\"usage\":{}}\n\ndata: [DONE]",
            b"data: [DONE]\n\n",
        ];
        for bytes in cases {
            let mut decoder = CopilotDecoder::default();
            let pushed = decoder.push(bytes, &mut |_| {});
            if pushed.is_ok() {
                assert_eq!(decoder.finish(), Err(COPILOT_ENDED_EARLY.to_string()));
            } else {
                assert_eq!(pushed, Err(COPILOT_ENDED_EARLY.to_string()));
            }
        }

        let mut decoder = CopilotDecoder::default();
        let error = decoder.push(
            b"data: {\"error\":\"Answer cut off at token limit\"}\n\ndata: {\"usage\":{}}\n\ndata: [DONE]\n\n",
            &mut |_| {},
        );
        assert_eq!(error, Err("Answer cut off at token limit".to_string()));
    }

    #[test]
    fn copilot_decoder_rejects_invalid_utf8_data() {
        let mut decoder = CopilotDecoder::default();
        assert_eq!(
            decoder.push(b"data: {\"t\":\"\xff\"}\n\n", &mut |_| {}),
            Err(COPILOT_ENDED_EARLY.to_string())
        );
    }

    #[tokio::test]
    async fn copilot_reader_has_an_independent_body_timeout() {
        let read = std::future::pending::<Result<CopilotStreamSummary, String>>();
        let result = with_copilot_body_timeout(std::time::Duration::from_millis(10), read).await;
        assert_eq!(result, Err(COPILOT_TIMEOUT.to_string()));
    }
    #[test]
    fn copilot_warm_request_and_response_contract() {
        let client = HttpClient::new("http://127.0.0.1:9876");
        let request = client
            .copilot_warm_request("local-model", Some("http://127.0.0.1:11434"), None)
            .build()
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url().as_str(), "http://127.0.0.1:9876/copilot/warm");
        assert_eq!(
            request.timeout(),
            Some(&std::time::Duration::from_secs(120))
        );
        let body: serde_json::Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"model": "local-model", "llm_base_url": "http://127.0.0.1:11434", "llm_api_key": null})
        );
        let response: CopilotWarmResponse =
            serde_json::from_str(r#"{"ok":true,"ms":12,"detail":null}"#).unwrap();
        assert!(response.ok);
        assert_eq!(response.ms, 12);
        assert!(response.detail.is_none());
        let response: CopilotWarmResponse =
            serde_json::from_str(r#"{"ok":false,"ms":2,"detail":"Model unavailable"}"#).unwrap();
        assert!(!response.ok);
        assert_eq!(response.detail.as_deref(), Some("Model unavailable"));
    }
}
