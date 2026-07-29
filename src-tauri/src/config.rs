//! User configuration management.
//!
//! Loads and saves `AppConfig` as JSON in the platform-appropriate
//! application data directory.

use std::path::PathBuf;

use crate::types::{AppConfig, CalendarConfig};

/// Returns the directory where config and data files are stored.
pub(crate) fn app_data_dir() -> PathBuf {
    // Keep embedded desktop tests hermetic. The override is deliberately
    // unavailable in release builds so production data cannot be redirected by
    // an inherited environment variable.
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("ADVERSARIA_DATA_DIR") {
        return PathBuf::from(dir);
    }

    directories::BaseDirs::new()
        .expect("Could not determine home directory")
        .data_dir()
        .join("meeting-note-taker")
}

/// Full path to config.json.
fn config_path() -> PathBuf {
    app_data_dir().join("config.json")
}

/// Ensure the application data directory exists.
pub fn ensure_config_dir() -> anyhow::Result<()> {
    let dir = app_data_dir();
    std::fs::create_dir_all(&dir)?;
    Ok(())
}

/// Directory where in-progress recordings are written. Lives under app-data
/// (not the system temp dir) so a recording kept for later transcription —
/// when the ML service was unreachable at stop time — survives an app restart
/// or reboot. Created on demand.
pub fn recordings_dir() -> anyhow::Result<PathBuf> {
    let dir = app_data_dir().join("recordings");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Load `AppConfig` from disk, falling back to defaults if the file
/// does not exist or is unreadable.
pub fn load_config() -> AppConfig {
    let path = config_path();
    if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

/// Persist `AppConfig` to disk as pretty-printed JSON.
pub fn save_config(config: &AppConfig) -> anyhow::Result<()> {
    ensure_config_dir()?;
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(config_path(), json)?;
    Ok(())
}

/// Serializes whole load→modify→save cycles so concurrent writers can't
/// interleave (see `update_config_with`).
static CONFIG_UPDATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Atomically load, modify, and save the config. Every read-modify-write of
/// `config.json` must go through here: two concurrent naive cycles (e.g. a
/// calendar OAuth callback landing while another update runs) interleave as
/// load/load/save/save, and the second save silently reverts the first.
pub fn update_config_with(mutate: impl FnOnce(&mut AppConfig)) -> anyhow::Result<AppConfig> {
    let _guard = CONFIG_UPDATE.lock().unwrap();
    let mut config = load_config();
    mutate(&mut config);
    save_config(&config)?;
    Ok(config)
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            python_service_url: "http://127.0.0.1:9876".to_string(),
            default_prompt_template: "general".to_string(),
            auto_detect_meetings: false,
            ollama_model: default_llm_model(),
            summary_language: "en".to_string(),
            user_name: String::new(),
            custom_vocabulary: String::new(),
            diarize: true,
            auto_stop_enabled: true,
            silence_prompt_minutes: 5,
            silence_stop_minutes: 10,
            pin_hash: None,
            claude_api_key: None,
            llm_provider: "local".to_string(),
            llm_base_url: String::new(),
            llm_api_key: String::new(),
            calendar: CalendarConfig::default(),
            transcription_base_url: String::new(),
            transcription_api_key: String::new(),
            transcription_model: "whisper-large-v3".to_string(),
            whisper_model: "large-v3".to_string(),
            encrypt_db: true,
            biometric_unlock: true,
            user_email: String::new(),
            beta_onboarded: false,
            signup_synced: false,
            date_format: "system".to_string(),
            archive_after_days: 30,
            sidebar_view: "compact".to_string(),
            recording_view: "balanced".to_string(),
            notch_pill_style: "minimal".to_string(),
            meeting_alert_style: "notch_drop".to_string(),
            second_brain_path: String::new(),
            second_brain_enabled: false,
            meeting_reminder_enabled: false,
            meeting_reminder_minutes: 5,
            tour_completed: false,
        }
    }
}

/// Default LLM model name sent to the Python service. On macOS the LLM is served
/// by Rapid-MLX (ADR-010) under the served name `qwen3.6-27b`; elsewhere it's the
/// Ollama tag `qwen3.6:35b-a3b` (ADR-008). Field stays named `ollama_model` for
/// back-compat even though it now also names the Rapid-MLX model.
#[cfg(target_os = "macos")]
fn default_llm_model() -> String {
    "qwen3.6-27b".to_string()
}
#[cfg(not(target_os = "macos"))]
fn default_llm_model() -> String {
    "qwen3.6:35b-a3b".to_string()
}
