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
            .and_then(|s| parse_config(&s))
            .unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

/// Parse `config.json`, filling in `transcription_provider` for configs written
/// before that field existed (absent, or blank). Nothing is rewritten to disk —
/// the value is derived on every load until the user saves from Settings.
fn parse_config(json: &str) -> Option<AppConfig> {
    let mut config: AppConfig = serde_json::from_str(json).ok()?;
    if config.transcription_provider.trim().is_empty() {
        config.transcription_provider =
            classify_transcription_provider(&config.transcription_base_url).to_string();
    }
    Some(config)
}

/// Which transcription engine a saved `transcription_base_url` implies:
/// `"local"`, `"self_hosted"`, or `"cloud"`.
///
/// - empty / whitespace → `"local"` (on-device Whisper)
/// - loopback (`127.0.0.1`, `::1`, `localhost`), an RFC 1918 private range
///   (10.x, 172.16–31.x, 192.168.x), a `.local`/`.internal` suffix, or a bare
///   single-label host (`dgx:8000`) → `"self_hosted"`
/// - anything else → `"cloud"`
///
/// A URL we can't read a host out of also classifies as `"cloud"`: that is the
/// conservative side, since cloud is the only mode whose copy warns that audio
/// leaves the device.
pub fn classify_transcription_provider(base_url: &str) -> &'static str {
    if base_url.trim().is_empty() {
        return "local";
    }
    match host_of(base_url.trim()) {
        Some(host) if is_private_host(&host) => "self_hosted",
        _ => "cloud",
    }
}

/// Best-effort host extraction — scheme, path, userinfo and port stripped.
/// `None` when no plausible host can be read (malformed URL).
fn host_of(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = after_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split_once(']').map(|(h, _)| h)? // [::1]:8000
    } else if authority.matches(':').count() > 1 {
        authority // bare IPv6 literal, e.g. ::1
    } else {
        authority.split_once(':').map_or(authority, |(h, _)| h)
    };
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// Whether a host names a machine on the user's own network.
fn is_private_host(host: &str) -> bool {
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
            std::net::IpAddr::V6(v6) => v6.is_loopback(),
        };
    }
    host == "localhost"
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || !host.contains('.')
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
            // On by default (Hamza, 2026-08-01): detection only OFFERS to
            // record when a call app uses the mic — it never records on its
            // own, so the safe default is the helpful one.
            auto_detect_meetings: true,
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
            transcription_provider: "local".to_string(),
            transcription_base_url: String::new(),
            transcription_api_key: String::new(),
            transcription_model: "whisper-large-v3".to_string(),
            whisper_model: crate::types::default_whisper_model(),
            encrypt_db: true,
            biometric_unlock: true,
            user_email: String::new(),
            beta_onboarded: false,
            signup_synced: false,
            date_format: "system".to_string(),
            archive_after_days: 30,
            // Full cards by default (Hamza, 2026-08-01): the welcome meeting —
            // and every meeting — should greet the user as a card with its
            // preview, not a one-line row. Compact stays a Settings choice.
            sidebar_view: "full".to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_all(urls: &[&str], expected: &str) {
        for url in urls {
            assert_eq!(classify_transcription_provider(url), expected, "{url}");
        }
    }

    #[test]
    fn no_endpoint_is_local() {
        assert_all(&["", "   ", "\n\t"], "local");
    }

    #[test]
    fn loopback_is_self_hosted() {
        assert_all(
            &[
                "127.0.0.1",
                "http://127.0.0.1:8000/v1",
                "https://127.0.0.1/v1",
                "http://127.1.2.3:9000",
                "localhost",
                "http://localhost:8000/v1",
                "::1",
                "http://[::1]:8000/v1",
            ],
            "self_hosted",
        );
    }

    #[test]
    fn private_ranges_are_self_hosted() {
        assert_all(
            &[
                "http://10.0.0.5:8000/v1",
                "http://192.168.1.40/v1",
                "http://172.16.0.1:8000/v1",
                "http://172.31.255.254:8000/v1",
            ],
            "self_hosted",
        );
    }

    #[test]
    fn addresses_outside_the_private_ranges_are_cloud() {
        assert_all(
            &[
                "http://172.15.0.1:8000/v1",
                "http://172.32.0.1:8000/v1",
                "http://8.8.8.8:8000/v1",
            ],
            "cloud",
        );
    }

    #[test]
    fn lan_hostnames_are_self_hosted() {
        assert_all(
            &[
                "http://dgx.office.local:8000/v1",
                "https://whisper.corp.internal/v1",
                "dgx:8000",
                "http://dgx/v1",
                "http://key@dgx.office.local:8000/v1",
            ],
            "self_hosted",
        );
    }

    #[test]
    fn public_providers_are_cloud() {
        assert_all(
            &[
                "https://api.groq.com/openai/v1",
                "https://api.openai.com/v1",
                "https://api.groq.com:443/openai/v1",
            ],
            "cloud",
        );
    }

    /// A URL we can't parse must not panic, and must land on the mode whose UI
    /// copy warns that audio leaves the device.
    #[test]
    fn malformed_urls_fall_back_to_cloud() {
        assert_all(
            &[
                "http://",
                "://",
                "http:///v1",
                "http://[::1",
                "not a url",
                "http:// spaced.host/v1",
                "@",
            ],
            "cloud",
        );
    }

    #[test]
    fn config_without_the_provider_field_classifies_from_its_url() {
        // Hamza's own config: no endpoint (a leftover key doesn't make it cloud).
        let legacy = r#"{
            "python_service_url": "http://127.0.0.1:9876",
            "default_prompt_template": "general",
            "auto_detect_meetings": true,
            "ollama_model": "qwen3.6-27b",
            "claude_api_key": null,
            "transcription_base_url": "",
            "transcription_api_key": "gsk_secret"
        }"#;
        let config = parse_config(legacy).expect("legacy config must still parse");
        assert_eq!(config.transcription_provider, "local");
        assert_eq!(config.whisper_model, crate::types::default_whisper_model());

        let office = legacy.replace(
            r#""transcription_base_url": """#,
            r#""transcription_base_url": "http://dgx.office.local:8000/v1""#,
        );
        assert_eq!(
            parse_config(&office).unwrap().transcription_provider,
            "self_hosted"
        );

        let groq = legacy.replace(
            r#""transcription_base_url": """#,
            r#""transcription_base_url": "https://api.groq.com/openai/v1""#,
        );
        assert_eq!(parse_config(&groq).unwrap().transcription_provider, "cloud");
    }

    #[test]
    fn an_explicit_provider_survives_the_migration() {
        let saved = r#"{
            "python_service_url": "http://127.0.0.1:9876",
            "default_prompt_template": "general",
            "auto_detect_meetings": true,
            "ollama_model": "qwen3.6-27b",
            "claude_api_key": null,
            "transcription_provider": "cloud",
            "transcription_base_url": "http://dgx.office.local:8000/v1"
        }"#;
        assert_eq!(parse_config(saved).unwrap().transcription_provider, "cloud");
    }

    #[test]
    fn a_fresh_config_is_local() {
        assert_eq!(AppConfig::default().transcription_provider, "local");
    }
}
