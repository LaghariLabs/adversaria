//! Typed HTTP client for the Python ML service.
//!
//! All communication with the transcription / summarization backend
//! flows through this module.  The base URL is read from `AppConfig`.

use crate::types::{
    HealthResponse, ModelDownloadStatus, SummarizeResponse, TemplateInfo, TranscribeResponse,
    WhisperModelInfo,
};

/// Owned parameters for the final-transcription HTTP boundary.
#[derive(serde::Serialize)]
pub struct TranscribeParams {
    pub audio_path: String,
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
            .map_err(|e| format!("Health check failed: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Service unhealthy: {body}"));
        }

        resp.json::<HealthResponse>()
            .await
            .map_err(|e| format!("Failed to parse health response: {e}"))
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
            .map_err(|e| format!("Transcribe request failed: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Transcription failed: {body}"));
        }

        resp.json::<TranscribeResponse>()
            .await
            .map_err(|e| format!("Failed to parse transcribe response: {e}"))
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
            .map_err(|e| format!("Transcribe request failed: {e}"))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Transcription failed: {body}"));
        }
        resp.json::<TranscribeResponse>()
            .await
            .map_err(|e| format!("Failed to parse transcribe response: {e}"))
    }

    /// List curated on-device Whisper models with their download status.
    pub async fn whisper_models(&self) -> Result<Vec<WhisperModelInfo>, String> {
        let base_url = self.base_url.read().unwrap().clone();
        let resp = self
            .client
            .get(format!("{}/whisper_models", base_url))
            .send()
            .await
            .map_err(|e| format!("Whisper models request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "Whisper models failed: {}",
                resp.text().await.unwrap_or_default()
            ));
        }
        resp.json::<Vec<WhisperModelInfo>>()
            .await
            .map_err(|e| format!("Failed to parse whisper models: {e}"))
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
            .map_err(|e| format!("Whisper download request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "Whisper download failed: {}",
                resp.text().await.unwrap_or_default()
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
            .map_err(|e| format!("Summarize request failed: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Summarization failed: {body}"));
        }

        resp.json::<SummarizeResponse>()
            .await
            .map_err(|e| format!("Failed to parse summarize response: {e}"))
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
            .map_err(|e| format!("Chat request failed: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Chat failed: {body}"));
        }

        let parsed: ChatResp = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse chat response: {e}"))?;
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
            .map_err(|e| format!("Chat request failed: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Chat failed: {body}"));
        }

        // Buffer raw bytes and decode only COMPLETE SSE frames (split on a blank
        // line) — so a multibyte char (e.g. Arabic) straddling a chunk boundary
        // is never decoded mid-character.
        let mut buf: Vec<u8> = Vec::new();
        let mut answer = String::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("Chat stream error: {e}"))?
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
                            return Err(format!("Chat failed: {e}"));
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
            .map_err(|e| format!("Templates request failed: {e}"))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Templates request failed: {body}"));
        }
        resp.json::<Vec<TemplateInfo>>()
            .await
            .map_err(|e| format!("Failed to parse templates response: {e}"))
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
            .map_err(|e| format!("Get-template request failed: {e}"))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Get-template failed: {body}"));
        }
        resp.json::<Resp>()
            .await
            .map(|r| r.content)
            .map_err(|e| format!("Failed to parse template: {e}"))
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
            .map_err(|e| format!("Save-template request failed: {e}"))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Save-template failed: {body}"));
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
            .map_err(|e| format!("Delete-template request failed: {e}"))?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Delete-template failed: {body}"));
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
