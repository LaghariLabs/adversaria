//! Typed HTTP client for the Python ML service.
//!
//! All communication with the transcription / summarization backend
//! flows through this module.  The base URL is read from `AppConfig`.

use crate::types::{
    HealthResponse, ModelDownloadStatus, SummarizeResponse, TemplateInfo, TranscribeResponse,
    WhisperModelInfo,
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
/// The notes (summarization) engine could not be reached or used.
const NOTES_UNREACHABLE: &str = "The notes model isn't reachable. Check Settings → Notes.";
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
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;

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
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;

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
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;
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
    /// session; returns captions for utterances that just finished (usually
    /// empty). Best-effort — errors surface as an empty list at the caller.
    pub async fn live_feed(
        &self,
        audio_path: &str,
        session: u64,
        source: &str,
    ) -> Result<Vec<String>, String> {
        #[derive(serde::Serialize)]
        struct FeedRequest {
            audio_path: String,
            session: u64,
            source: String,
        }
        #[derive(serde::Deserialize)]
        struct FeedResp {
            captions: Vec<String>,
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
            return Ok(Vec::new());
        }
        match resp.json::<FeedResp>().await {
            Ok(parsed) => Ok(parsed.captions),
            Err(_) => Ok(Vec::new()),
        }
    }

    /// Ask the Python service to summarise a transcript using the given
    /// prompt template and (optionally) a specific Ollama model.
    pub async fn summarize(&self, params: SummarizeParams) -> Result<SummarizeResponse, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .post(format!("{}/summarize", base_url))
            .json(&params)
            .send()
            .await
            .map_err(|_| SERVICE_DOWN.to_string())?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(summarize_error(&body));
        }

        resp.json::<SummarizeResponse>()
            .await
            .map_err(|_| UNEXPECTED_RESPONSE.to_string())
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
        mut on_token: impl FnMut(&str),
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
        let mut resp = self
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
}
