//! App-managed Ollama lifecycle, tier selection, and pull progress.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::types::ModelDownloadStatus;

pub const SIDECAR_PORT: u16 = 27_434;
pub const EMBED_TAG: &str = "bge-m3";
const EMBED_SIZE_BYTES: u64 = 1_200_000_000;

pub struct TierTag {
    pub profile_id: &'static str,
    pub display_name: &'static str,
    pub tag: &'static str,
    pub mlx_tag: Option<&'static str>,
    pub size_bytes: u64,
    pub minimum_memory_gb: u32,
    pub required_disk_gb: u32,
    pub quality_label: &'static str,
    pub quality_note: &'static str,
}

pub const TIERS: &[TierTag] = &[
    TierTag {
        profile_id: "ollama-tier:light",
        display_name: "Qwen 3.5 4B — lighter and faster",
        tag: "qwen3.5:4b",
        mlx_tag: Some("qwen3.5:4b-mlx"),
        size_bytes: 3_400_000_000,
        minimum_memory_gb: 8,
        required_disk_gb: 5,
        quality_label: "Reduced quality",
        quality_note:
            "Fits smaller machines, but may omit nuance in long or complex meeting notes.",
    },
    TierTag {
        profile_id: "ollama-tier:mid",
        display_name: "Qwen 3.5 9B — balanced quality and speed",
        tag: "qwen3.5:9b",
        mlx_tag: Some("qwen3.5:9b-mlx"),
        size_bytes: 6_600_000_000,
        minimum_memory_gb: 16,
        required_disk_gb: 10,
        quality_label: "Balanced quality",
        quality_note:
            "Strong meeting notes at a practical size; the best default for 16 GB machines.",
    },
    TierTag {
        profile_id: "ollama-tier:high",
        display_name: "Qwen 3.6 27B — best meeting quality",
        tag: "qwen3.6:27b",
        mlx_tag: Some("qwen3.6:27b-nvfp4"),
        size_bytes: 17_000_000_000,
        minimum_memory_gb: 24,
        required_disk_gb: 22,
        quality_label: "Highest quality",
        quality_note: "Best supported local meeting-output profile; slower and larger.",
    },
];

static PULLS: OnceLock<Mutex<HashMap<String, ModelDownloadStatus>>> = OnceLock::new();
static LAST_VERSION: OnceLock<RwLock<Option<String>>> = OnceLock::new();
static LOGGED_FALLBACKS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
pub struct OllamaInstallPlan {
    pub schema_version: u32,
    pub engine_name: String,
    pub engine_version: String,
    pub binary_path: String,
    pub bundled: bool,
    pub models_dir: String,
    pub tier_profile_id: String,
    pub tier_display_name: String,
    pub chat_tag: String,
    pub chat_size_bytes: u64,
    pub embed_tag: String,
    pub embed_size_bytes: u64,
    pub chat_installed: bool,
    pub embed_installed: bool,
    pub mlx: bool,
}

#[derive(serde::Deserialize)]
struct VersionResponse {
    version: String,
}

#[derive(serde::Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagRecord>,
}

#[derive(serde::Deserialize)]
struct TagRecord {
    #[serde(default)]
    name: String,
    #[serde(default)]
    model: String,
}

#[derive(serde::Deserialize)]
struct PullLine {
    #[serde(default)]
    status: String,
    #[serde(default)]
    digest: String,
    #[serde(default)]
    total: u64,
    #[serde(default)]
    completed: u64,
    error: Option<String>,
}

pub fn recommended_tier(memory_gb: u64, disk_gb: u64) -> &'static TierTag {
    if memory_gb >= 24 && disk_gb >= 20 {
        &TIERS[2]
    } else if memory_gb >= 16 && disk_gb >= 7 {
        &TIERS[1]
    } else {
        &TIERS[0]
    }
}

pub fn tier(profile_id: &str) -> Option<&'static TierTag> {
    TIERS
        .iter()
        .find(|candidate| candidate.profile_id == profile_id)
}

pub fn effective_tag(
    selected: &'static TierTag,
    memory_gb: u64,
    ollama_version: &str,
) -> &'static str {
    effective_tag_for(
        selected,
        memory_gb,
        ollama_version,
        cfg!(all(target_os = "macos", target_arch = "aarch64")),
    )
}

fn effective_tag_for(
    selected: &'static TierTag,
    memory_gb: u64,
    ollama_version: &str,
    apple_silicon: bool,
) -> &'static str {
    if apple_silicon && memory_gb > 32 && version_at_least(ollama_version, (0, 19, 0)) {
        selected.mlx_tag.unwrap_or(selected.tag)
    } else {
        selected.tag
    }
}

fn version_at_least(version: &str, minimum: (u64, u64, u64)) -> bool {
    let mut parts = version
        .trim_start_matches('v')
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok());
    let parsed = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    parsed >= minimum
}

pub fn binary_path(app: &AppHandle) -> Option<PathBuf> {
    let filename = if cfg!(windows) {
        "ollama.exe"
    } else {
        "ollama"
    };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("ollama").join(filename);
        if bundled.is_file() {
            return Some(bundled);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let fallback = PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama");
        if fallback.is_file() {
            log_dev_fallback(&fallback);
            return Some(fallback);
        }
    }

    let fallback = find_on_path(filename)?;
    log_dev_fallback(&fallback);
    Some(fallback)
}

fn log_dev_fallback(path: &Path) {
    let mut logged = LOGGED_FALLBACKS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap();
    if logged.insert(path.to_path_buf()) {
        eprintln!("[ollama-engine] using {} (dev fallback)", path.display());
    }
}

fn find_on_path(filename: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(filename);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn models_dir() -> PathBuf {
    crate::config::app_data_dir().join("ollama").join("models")
}

pub fn host() -> String {
    format!("http://127.0.0.1:{SIDECAR_PORT}")
}

pub fn current_version() -> Option<String> {
    LAST_VERSION
        .get_or_init(|| RwLock::new(None))
        .read()
        .unwrap()
        .clone()
}

fn remember_version(value: &str) {
    *LAST_VERSION
        .get_or_init(|| RwLock::new(None))
        .write()
        .unwrap() = Some(value.to_string());
}

pub async fn start(
    app: &AppHandle,
    process: &Mutex<Option<std::process::Child>>,
) -> Result<(), String> {
    let owned_alive = {
        let mut guard = process.lock().unwrap();
        match guard.as_mut() {
            Some(child) => {
                if child.try_wait().ok().flatten().is_none() {
                    true
                } else {
                    if let Some(mut dead) = guard.take() {
                        let _ = dead.wait();
                    }
                    false
                }
            }
            None => false,
        }
    };
    if owned_alive {
        if let Ok(running_version) = version().await {
            remember_version(&running_version);
            notify_service(app).await;
            return Ok(());
        }
        stop(process);
    }

    if let Ok(running_version) = version().await {
        remember_version(&running_version);
        crate::diagnostics::record("ollama_engine.reused", &running_version);
        eprintln!("[ollama-engine] reusing Ollama already serving on 127.0.0.1:{SIDECAR_PORT}");
        notify_service(app).await;
        return Ok(());
    }

    let executable = binary_path(app)
        .ok_or_else(|| "No local engine binary is available in this build.".to_string())?;
    let model_root = models_dir();
    std::fs::create_dir_all(&model_root)
        .map_err(|error| format!("Could not create the local model directory: {error}"))?;

    let mut command = std::process::Command::new(&executable);
    command
        .arg("serve")
        .env("OLLAMA_HOST", format!("127.0.0.1:{SIDECAR_PORT}"))
        .env("OLLAMA_MODELS", &model_root)
        .env("OLLAMA_KEEP_ALIVE", "30m")
        .env("OLLAMA_NUM_PARALLEL", "1")
        .env("OLLAMA_ORIGINS", "")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the local engine: {error}"))?;
    let stderr_tail = Arc::new(Mutex::new(VecDeque::<String>::with_capacity(24)));
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                eprintln!("[ollama-engine] {line}");
                crate::commands::append_to_sidecar_log(&format!("[ollama-engine] {line}"));
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[ollama-engine] {line}");
                crate::commands::append_to_sidecar_log(&format!("[ollama-engine] {line}"));
                let mut lines = tail.lock().unwrap();
                if lines.len() == 24 {
                    lines.pop_front();
                }
                lines.push_back(line);
            }
        });
    }

    let mut last_error = "The engine did not answer its version endpoint.".to_string();
    for _ in 0..80 {
        if let Some(exit) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect the local engine process: {error}"))?
        {
            last_error = format!("The local engine exited with status {exit}.");
            break;
        }
        match version().await {
            Ok(running_version) => {
                remember_version(&running_version);
                *process.lock().unwrap() = Some(child);
                crate::diagnostics::record("ollama_engine.started", &running_version);
                notify_service(app).await;
                return Ok(());
            }
            Err(error) => last_error = error,
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let _ = child.kill();
    let _ = child.wait();
    let tail = stderr_tail
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    if tail.is_empty() {
        Err(format!(
            "The local engine did not become ready within 20 seconds. {last_error}"
        ))
    } else {
        Err(format!(
            "The local engine did not become ready within 20 seconds. {last_error}\n{tail}"
        ))
    }
}

pub fn stop(process: &Mutex<Option<std::process::Child>>) {
    if let Some(mut child) = process.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
        crate::diagnostics::record("ollama_engine.stopped", "owned process");
    }
}

async fn notify_service(app: &AppHandle) {
    let service_url = app
        .state::<crate::commands::AppState>()
        .client
        .current_base_url();
    let _ = reqwest::Client::new()
        .post(format!("{service_url}/setup/llm_host"))
        .timeout(Duration::from_secs(2))
        .json(&serde_json::json!({ "ollama_host": host() }))
        .send()
        .await;
}

pub async fn version() -> Result<String, String> {
    let response = reqwest::Client::new()
        .get(format!("{}/api/version", host()))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|error| format!("The local engine is not reachable: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The local engine version check failed with HTTP {}.",
            response.status()
        ));
    }
    let parsed = response
        .json::<VersionResponse>()
        .await
        .map_err(|error| format!("The local engine returned an unreadable version: {error}"))?;
    Ok(parsed.version)
}

pub async fn has_tag(tag: &str) -> Result<bool, String> {
    let response = reqwest::Client::new()
        .get(format!("{}/api/tags", host()))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|error| format!("Could not read local engine models: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The local engine model list failed with HTTP {}.",
            response.status()
        ));
    }
    let tags = response
        .json::<TagsResponse>()
        .await
        .map_err(|error| format!("The local engine returned an unreadable model list: {error}"))?;
    Ok(tags
        .models
        .iter()
        .any(|record| tag_matches(&record.name, tag) || tag_matches(&record.model, tag)))
}

fn tag_matches(candidate: &str, requested: &str) -> bool {
    candidate == requested
        || (!requested.contains(':') && candidate.strip_prefix(requested) == Some(":latest"))
}

pub async fn pull(tag: &str) {
    if !begin_pull(tag) {
        return;
    }
    let tag = tag.to_string();
    tauri::async_runtime::spawn(async move {
        run_pull(&tag).await;
    });
}

fn begin_pull(tag: &str) -> bool {
    let mut pulls = PULLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    if pulls.get(tag).is_some_and(|status| {
        matches!(
            status.state.as_str(),
            "queued" | "downloading" | "verifying"
        )
    }) {
        return false;
    }
    pulls.insert(
        tag.to_string(),
        blank_status(tag, "queued", "Queued for download."),
    );
    true
}

async fn run_pull(tag: &str) {
    let response = reqwest::Client::new()
        .post(format!("{}/api/pull", host()))
        .json(&serde_json::json!({ "model": tag, "stream": true }))
        .send()
        .await;
    let Ok(mut response) = response else {
        set_pull_failed(tag, "The local engine could not start the download.");
        return;
    };
    if !response.status().is_success() {
        let detail = response
            .text()
            .await
            .unwrap_or_else(|_| "The local engine rejected the download.".to_string());
        set_pull_failed(tag, &detail);
        return;
    }

    let mut pending = Vec::<u8>::new();
    let mut layers = HashMap::<String, (u64, u64)>::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                pending.extend_from_slice(&chunk);
                while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
                    let line = pending.drain(..=position).collect::<Vec<_>>();
                    let line = String::from_utf8_lossy(&line);
                    update_pull_from_line(tag, &mut layers, line.trim());
                }
            }
            Ok(None) => break,
            Err(error) => {
                set_pull_failed(tag, &format!("The model download was interrupted: {error}"));
                return;
            }
        }
    }
    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending);
        update_pull_from_line(tag, &mut layers, line.trim());
    }
    if pull_status(tag).state != "ready" && pull_status(tag).state != "failed" {
        set_pull_failed(
            tag,
            "The local engine ended the download before reporting success.",
        );
    }
}

fn update_pull_from_line(tag: &str, layers: &mut HashMap<String, (u64, u64)>, line: &str) {
    let mut pulls = PULLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    let status = pulls
        .entry(tag.to_string())
        .or_insert_with(|| blank_status(tag, "queued", "Queued for download."));
    apply_pull_line(status, layers, line);
}

fn set_pull_failed(tag: &str, detail: &str) {
    let mut pulls = PULLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    let status = pulls
        .entry(tag.to_string())
        .or_insert_with(|| blank_status(tag, "queued", "Queued for download."));
    status.state = "failed".to_string();
    status.detail = detail.to_string();
    status.error_code = Some("ollama_pull_failed".to_string());
    status.can_retry = true;
    status.verified = false;
}

pub fn pull_status(tag: &str) -> ModelDownloadStatus {
    PULLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .get(tag)
        .cloned()
        .unwrap_or_else(|| blank_status(tag, "idle", "Not downloaded."))
}

pub fn tag_installed(tag: &str) -> bool {
    tag_manifest_path(tag).is_file()
}

pub fn clear_pull_status(tag: &str) {
    PULLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .remove(tag);
}

fn blank_status(tag: &str, state: &str, detail: &str) -> ModelDownloadStatus {
    ModelDownloadStatus {
        profile_id: tag.to_string(),
        state: state.to_string(),
        downloaded_bytes: 0,
        total_bytes: 0,
        detail: detail.to_string(),
        error_code: None,
        verified: state == "ready",
        can_retry: state == "failed",
    }
}

fn apply_pull_line(
    status: &mut ModelDownloadStatus,
    layers: &mut HashMap<String, (u64, u64)>,
    line: &str,
) {
    let Ok(parsed) = serde_json::from_str::<PullLine>(line) else {
        return;
    };
    if let Some(error) = parsed.error.filter(|error| !error.trim().is_empty()) {
        status.state = "failed".to_string();
        status.detail = error;
        status.error_code = Some("ollama_pull_failed".to_string());
        status.verified = false;
        status.can_retry = true;
        return;
    }

    if !parsed.digest.is_empty() && parsed.total > 0 {
        layers.insert(parsed.digest, (parsed.completed, parsed.total));
        status.downloaded_bytes = layers.values().map(|(completed, _)| *completed).sum();
        status.total_bytes = layers.values().map(|(_, total)| *total).sum();
    }

    let lowered = parsed.status.to_lowercase();
    if lowered.contains("success") {
        status.state = "ready".to_string();
        status.detail = "Downloaded and verified.".to_string();
        status.verified = true;
        status.can_retry = false;
        status.error_code = None;
    } else if lowered.contains("verifying") || lowered.contains("writing manifest") {
        status.state = "verifying".to_string();
        status.detail = parsed.status;
    } else if !parsed.status.is_empty() {
        status.state = "downloading".to_string();
        status.detail = parsed.status;
    }
}

pub fn install_plan(app: &AppHandle, memory_gb: u64, disk_gb: u64) -> OllamaInstallPlan {
    let selected = recommended_tier(memory_gb, disk_gb);
    let path = binary_path(app);
    let version = path
        .as_deref()
        .and_then(binary_version)
        .unwrap_or_else(|| "unknown".to_string());
    let chat_tag = effective_tag(selected, memory_gb, &version);
    let bundled = path
        .as_ref()
        .is_some_and(|candidate| is_bundled_path(app, candidate));
    OllamaInstallPlan {
        schema_version: 1,
        engine_name: "Ollama (managed)".to_string(),
        engine_version: version,
        binary_path: path
            .as_ref()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default(),
        bundled,
        models_dir: models_dir().to_string_lossy().to_string(),
        tier_profile_id: selected.profile_id.to_string(),
        tier_display_name: selected.display_name.to_string(),
        chat_tag: chat_tag.to_string(),
        chat_size_bytes: selected.size_bytes,
        embed_tag: EMBED_TAG.to_string(),
        embed_size_bytes: EMBED_SIZE_BYTES,
        chat_installed: tag_installed(chat_tag),
        embed_installed: tag_installed(EMBED_TAG),
        mlx: selected.mlx_tag == Some(chat_tag),
    }
}

fn binary_version(path: &Path) -> Option<String> {
    let output = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = format!(
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    text.split_whitespace()
        .find(|part| {
            part.trim_start_matches('v')
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
                && part.contains('.')
        })
        .map(|part| {
            part.trim_matches(|character: char| {
                !(character.is_ascii_digit() || character == '.' || character == 'v')
            })
            .trim_start_matches('v')
            .to_string()
        })
}

fn is_bundled_path(app: &AppHandle, path: &Path) -> bool {
    app.path()
        .resource_dir()
        .ok()
        .is_some_and(|resource| path.starts_with(resource.join("ollama")))
}

fn tag_manifest_path(tag: &str) -> PathBuf {
    let (model, version) = tag.split_once(':').unwrap_or((tag, "latest"));
    models_dir()
        .join("manifests")
        .join("registry.ollama.ai")
        .join("library")
        .join(model)
        .join(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommendation_thresholds_match_setup() {
        assert_eq!(recommended_tier(24, 20).profile_id, "ollama-tier:high");
        assert_eq!(recommended_tier(40, 19).profile_id, "ollama-tier:mid");
        assert_eq!(recommended_tier(16, 7).profile_id, "ollama-tier:mid");
        assert_eq!(recommended_tier(15, 100).profile_id, "ollama-tier:light");
    }

    #[test]
    fn tier_ids_are_stable() {
        assert_eq!(
            tier("ollama-tier:light").map(|value| value.tag),
            Some("qwen3.5:4b")
        );
        assert_eq!(
            tier("ollama-tier:mid").map(|value| value.tag),
            Some("qwen3.5:9b")
        );
        assert_eq!(
            tier("ollama-tier:high").map(|value| value.tag),
            Some("qwen3.6:27b")
        );
        assert!(tier("ollama-tier:unknown").is_none());
    }

    #[test]
    fn mlx_tag_requires_apple_silicon_memory_and_new_ollama() {
        let selected = tier("ollama-tier:high").unwrap();
        assert_eq!(
            effective_tag_for(selected, 40, "0.32.7", true),
            "qwen3.6:27b-nvfp4"
        );
        assert_eq!(
            effective_tag_for(selected, 16, "0.32.7", true),
            selected.tag
        );
        assert_eq!(
            effective_tag_for(selected, 40, "0.18.0", true),
            selected.tag
        );
        assert_eq!(
            effective_tag_for(selected, 40, "0.32.7", false),
            selected.tag
        );
    }

    #[test]
    fn pull_progress_sums_layers_and_reaches_ready() {
        let mut status = blank_status("qwen3.5:4b", "queued", "Queued for download.");
        let mut layers = HashMap::new();
        apply_pull_line(&mut status, &mut layers, r#"{"status":"pulling manifest"}"#);
        assert_eq!(status.state, "downloading");
        apply_pull_line(
            &mut status,
            &mut layers,
            r#"{"status":"pulling layer","digest":"sha256:a","total":100,"completed":40}"#,
        );
        apply_pull_line(
            &mut status,
            &mut layers,
            r#"{"status":"pulling layer","digest":"sha256:b","total":200,"completed":100}"#,
        );
        assert_eq!(status.downloaded_bytes, 140);
        assert_eq!(status.total_bytes, 300);
        apply_pull_line(
            &mut status,
            &mut layers,
            r#"{"status":"pulling layer","digest":"sha256:a","total":100,"completed":100}"#,
        );
        assert_eq!(status.downloaded_bytes, 200);
        apply_pull_line(
            &mut status,
            &mut layers,
            r#"{"status":"verifying sha256 digest"}"#,
        );
        assert_eq!(status.state, "verifying");
        apply_pull_line(&mut status, &mut layers, r#"{"status":"success"}"#);
        assert_eq!(status.state, "ready");
        assert!(status.verified);
    }

    #[test]
    fn pull_error_becomes_retryable_failure() {
        let mut status = blank_status("bge-m3", "queued", "Queued for download.");
        let mut layers = HashMap::new();
        apply_pull_line(
            &mut status,
            &mut layers,
            r#"{"error":"model manifest not found"}"#,
        );
        assert_eq!(status.state, "failed");
        assert_eq!(status.detail, "model manifest not found");
        assert!(status.can_retry);
    }
}
