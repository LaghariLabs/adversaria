//! Local, redacted diagnostic event log and deliberate export.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use tauri::{AppHandle, Manager};

const MAX_LOG_BYTES: u64 = 512 * 1024;
const LOG_COPIES: usize = 3;
/// How many trailing lines of the sidecar service log the export includes.
const SIDECAR_LOG_TAIL_LINES: usize = 200;
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());

pub fn init(app: &AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Could not locate the diagnostic log directory: {e}"))?;
    fs::create_dir_all(&path)
        .map_err(|e| format!("Could not create the diagnostic log directory: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Could not protect the diagnostic log directory: {e}"))?;
    }
    let _ = LOG_DIR.set(path);
    Ok(())
}

fn log_path(index: usize) -> Option<PathBuf> {
    LOG_DIR
        .get()
        .map(|root| root.join(format!("adversaria-diagnostic.{index}.log")))
}

fn rotate_if_needed(current: &Path) -> std::io::Result<()> {
    if current.metadata().map_or(0, |value| value.len()) < MAX_LOG_BYTES {
        return Ok(());
    }
    for index in (1..LOG_COPIES).rev() {
        if let (Some(source), Some(target)) = (log_path(index - 1), log_path(index)) {
            if source.exists() {
                let _ = fs::remove_file(&target);
                fs::rename(source, target)?;
            }
        }
    }
    Ok(())
}

/// Strip emails and filesystem paths from `value`, preserving line breaks and
/// length. Shared by the short single-line `redact()` (log details) and the
/// multi-line config-file redactor (`redact_config`), which need the same
/// contact-field scrubbing but must keep their own formatting.
fn redact_emails_and_paths(value: &str) -> String {
    static EMAIL: OnceLock<Regex> = OnceLock::new();
    static UNIX_PATH: OnceLock<Regex> = OnceLock::new();
    static WINDOWS_PATH: OnceLock<Regex> = OnceLock::new();
    let email =
        EMAIL.get_or_init(|| Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b").unwrap());
    let unix_path =
        UNIX_PATH.get_or_init(|| Regex::new(r"/(?:Users|home|private|tmp|var)/[^\s,;]+").unwrap());
    let windows_path = WINDOWS_PATH.get_or_init(|| Regex::new(r"(?i)\b[A-Z]:\\[^\s,;]+").unwrap());
    let redacted = email.replace_all(value, "[email]");
    let redacted = unix_path.replace_all(&redacted, "[path]");
    windows_path.replace_all(&redacted, "[path]").into_owned()
}

fn redact(value: &str) -> String {
    let one_line = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let padded = format!("{one_line} ");
    redact_emails_and_paths(&padded)
        .trim()
        .chars()
        .take(300)
        .collect()
}

/// `AppConfig` fields that must never leave the machine, even in a
/// diagnostics bundle: API keys, the PIN verifier, and free-text identity
/// fields the user typed (name, email, custom vocabulary can contain real
/// names). Also covers the nested calendar contact fields
/// (`CalendarAccount.email` / `.display_name`). See `types.rs::AppConfig`.
const SENSITIVE_CONFIG_KEYS: &[&str] = &[
    "claude_api_key",
    "llm_api_key",
    "transcription_api_key",
    "pin_hash",
    "user_name",
    "user_email",
    "custom_vocabulary",
    "email",
    "display_name",
];

/// Recursively blank out any object value whose key is in
/// `SENSITIVE_CONFIG_KEYS`, at any nesting depth.
fn redact_json_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, entry) in map.iter_mut() {
                if SENSITIVE_CONFIG_KEYS.contains(&key.as_str()) {
                    if !entry.is_null() {
                        *entry = serde_json::Value::String("[redacted]".to_string());
                    }
                } else {
                    redact_json_value(entry);
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(redact_json_value),
        _ => {}
    }
}

/// Redact `config.json` for the diagnostics bundle: known-sensitive fields
/// are stripped by name first (catches a bare API key that wouldn't match the
/// email/path patterns), then the same contact-field scrubbing runs over what
/// remains as a second boundary. Falls back to the plain-text scrub if the
/// file isn't valid JSON.
fn redact_config(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return redact_emails_and_paths(raw);
    };
    redact_json_value(&mut value);
    let pretty = serde_json::to_string_pretty(&value).unwrap_or_else(|_| raw.to_string());
    redact_emails_and_paths(&pretty)
}

/// Record only lifecycle/error metadata. Callers must not pass meeting content;
/// redaction is a second boundary for accidental paths or email addresses.
pub fn record(event: &str, detail: &str) {
    let Some(path) = log_path(0) else {
        return;
    };
    let event: String = event
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "._-".contains(*character))
        .take(80)
        .collect();
    let _guard = LOG_LOCK.lock().unwrap();
    if rotate_if_needed(&path).is_err() {
        return;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let Ok(mut file) = options.open(path) else {
        return;
    };
    let entry = serde_json::json!({
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "event": event,
        "detail": redact(detail),
    });
    let _ = writeln!(file, "{entry}");
}

fn header_text() -> String {
    format!(
        "Adversaria diagnostics export\n\
         Generated: {}\n\
         App version: {}\n\
         Platform: {}/{}\n\n\
         Included: app/OS/memory facts, sidecar binary status, the last {SIDECAR_LOG_TAIL_LINES} \
         lines of the service log, service-crash.txt (if present), config.json with API keys, \
         the PIN, and identity fields redacted, permission states, and the local diagnostic event log.\n\
         Not included: meeting titles, transcripts, summaries, audio file paths, contact fields, or API keys.\n\n",
        chrono::Utc::now().to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

/// Total + available RAM. Minimal refresh (memory only, same pattern as the
/// sidecar reaper's process-only refresh in `commands::reap_stale_sidecars`)
/// so this stays cheap to call on every export.
fn describe_memory() -> String {
    use sysinfo::{MemoryRefreshKind, RefreshKind, System};
    let system = System::new_with_specifics(
        RefreshKind::nothing().with_memory(MemoryRefreshKind::everything()),
    );
    let total_gb = system.total_memory() as f64 / 1_000_000_000.0;
    let available_gb = system.available_memory() as f64 / 1_000_000_000.0;
    format!("Memory: {total_gb:.1} GB total, {available_gb:.1} GB available\n")
}

/// Sidecar binary presence, size, and modified time — size + mtime only,
/// never a hash (the model snapshot next to it can be 1.6+ GB). `path` is
/// already resolved by the caller (`commands::sidecar_exe_path`) so this stays
/// testable without a `AppHandle`. `None` means the packaged resource
/// directory itself couldn't be resolved (expected in dev).
fn describe_sidecar(path: Option<&Path>) -> String {
    let Some(path) = path else {
        return "Sidecar binary: path could not be resolved (packaged resource directory unavailable — expected in dev)\n".to_string();
    };
    match fs::metadata(path) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
                .unwrap_or_else(|_| "unknown".to_string());
            format!(
                "Sidecar binary: exists=yes\n  size: {} bytes\n  modified: {modified}\n",
                meta.len()
            )
        }
        Err(_) => {
            "Sidecar binary: exists=no — antivirus/EDR quarantine is the usual cause\n".to_string()
        }
    }
}

/// Mic + system-audio permission states (always Granted on Windows, which has
/// no equivalent TCC gate — see `permissions.rs`).
fn describe_permissions() -> String {
    let permissions = crate::permissions::check();
    format!(
        "Permissions:\n  microphone: {:?}\n  system_audio: {:?}\n",
        permissions.microphone, permissions.system_audio
    )
}

/// `service-crash.txt` verbatim — it's already a transcript-free Python
/// traceback (see `run_service.py`).
fn describe_crash_file() -> String {
    let path = crate::config::app_data_dir().join("service-crash.txt");
    match fs::read_to_string(&path) {
        Ok(contents) if !contents.trim().is_empty() => format!("service-crash.txt:\n{contents}\n"),
        _ => "service-crash.txt: (not present)\n".to_string(),
    }
}

/// Last `SIDECAR_LOG_TAIL_LINES` lines of the sidecar's stdout/stderr log.
fn describe_sidecar_log_tail() -> String {
    let Some(path) = crate::commands::sidecar_log_path() else {
        return "adversaria-service.log: (not available)\n".to_string();
    };
    match fs::read_to_string(&path) {
        Ok(contents) if !contents.trim().is_empty() => {
            let lines: Vec<&str> = contents.lines().collect();
            let start = lines.len().saturating_sub(SIDECAR_LOG_TAIL_LINES);
            format!(
                "adversaria-service.log (last {} lines):\n{}\n",
                lines.len() - start,
                lines[start..].join("\n")
            )
        }
        _ => "adversaria-service.log: (not present)\n".to_string(),
    }
}

/// `config.json`, redacted (see `redact_config`).
fn describe_config() -> String {
    let path = crate::config::app_data_dir().join("config.json");
    match fs::read_to_string(&path) {
        Ok(contents) => format!("config.json (redacted):\n{}\n", redact_config(&contents)),
        Err(_) => "config.json: (not present)\n".to_string(),
    }
}

/// The rotated diagnostic event log ring, oldest file first.
fn describe_event_log() -> String {
    let mut output = String::new();
    for index in (0..LOG_COPIES).rev() {
        if let Some(path) = log_path(index) {
            if let Ok(contents) = fs::read_to_string(path) {
                output.push_str(&contents);
            }
        }
    }
    if output.is_empty() {
        output.push_str("(no diagnostic events recorded yet)\n");
    }
    output
}

/// Assemble the full diagnostics bundle as one text document. Aside from
/// reading local files under the app-data dir (config, crash file, sidecar
/// log — all resolved with no `AppHandle`), this takes only an already-resolved
/// sidecar path, so it's testable without a dialog or a Tauri app instance.
fn build_bundle_text(sidecar_exe: Option<&Path>) -> String {
    let mut output = header_text();
    output.push_str("===== System =====\n");
    output.push_str(&format!(
        "OS: {} {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    output.push_str(&describe_memory());
    output.push('\n');
    output.push_str("===== Sidecar =====\n");
    output.push_str(&describe_sidecar(sidecar_exe));
    output.push('\n');
    output.push_str("===== Permissions =====\n");
    output.push_str(&describe_permissions());
    output.push('\n');
    output.push_str("===== service-crash.txt =====\n");
    output.push_str(&describe_crash_file());
    output.push('\n');
    output.push_str("===== Service log tail =====\n");
    output.push_str(&describe_sidecar_log_tail());
    output.push('\n');
    output.push_str("===== config.json =====\n");
    output.push_str(&describe_config());
    output.push('\n');
    output.push_str("===== Diagnostic event log =====\n");
    output.push_str(&describe_event_log());
    output
}

/// Export the full support-diagnostics bundle to a user-chosen file after an
/// explicit native save dialog. The only observability channel this product
/// allows — never automatic, never uploaded.
pub fn export(app: &AppHandle) -> Result<Option<String>, String> {
    let Some(destination) = rfd::FileDialog::new()
        .set_file_name("adversaria-redacted-diagnostics.txt")
        .save_file()
    else {
        return Ok(None);
    };
    let _guard = LOG_LOCK.lock().unwrap();
    let sidecar_exe = crate::commands::sidecar_exe_path(app);
    let output = build_bundle_text(sidecar_exe.as_deref());
    fs::write(&destination, output).map_err(|e| format!("Could not export diagnostics: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Could not protect exported diagnostics: {e}"))?;
    }
    Ok(Some(destination.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_removes_contact_paths_and_newlines() {
        let value = redact("a@example.com failed at /Users/alice/private/file.wav\nsecret");
        assert!(!value.contains("example.com"));
        assert!(!value.contains("alice"));
        assert!(!value.contains('\n'));
        assert!(value.contains("[email]"));
        assert!(value.contains("[path]"));
    }

    #[test]
    fn config_redaction_strips_api_keys_and_vocabulary() {
        let raw = serde_json::json!({
            "python_service_url": "http://127.0.0.1:9876",
            "claude_api_key": "sk-ant-super-secret",
            "llm_api_key": "sk-llm-secret",
            "transcription_api_key": "gsk_secret",
            "pin_hash": "10000.deadbeef.cafebabe",
            "user_name": "Hamza Al Gharie",
            "user_email": "hamza@example.com",
            "custom_vocabulary": "Adversaria, Hamza, Acme Corp",
            "calendar": {
                "google": {
                    "enabled": true,
                    "email": "hamza@gmail.com",
                    "display_name": "Hamza",
                    "scopes_granted": ["calendar.readonly"],
                    "token_expires_at": "2026-01-01T00:00:00Z"
                }
            }
        })
        .to_string();

        let redacted = redact_config(&raw);

        for secret in [
            "sk-ant-super-secret",
            "sk-llm-secret",
            "gsk_secret",
            "10000.deadbeef.cafebabe",
            "Hamza Al Gharie",
            "hamza@example.com",
            "Adversaria, Hamza, Acme Corp",
            "hamza@gmail.com",
            "\"Hamza\"",
        ] {
            assert!(!redacted.contains(secret), "leaked into export: {secret}");
        }
        // Non-sensitive fields survive untouched so the bundle stays useful.
        assert!(redacted.contains("127.0.0.1:9876"));
    }

    #[test]
    fn sidecar_section_reports_presence_in_both_cases() {
        // Exercises the pure section builder directly (not `build_bundle_text`,
        // which also reads the real app-data dir for config/crash/log — this
        // keeps the test hermetic instead of touching the developer's machine).
        let dir = std::env::temp_dir().join(format!(
            "adversaria-diag-sidecar-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let exe = dir.join("adversaria-service");
        fs::write(&exe, b"fake binary").unwrap();

        assert!(describe_sidecar(Some(&exe)).contains("exists=yes"));

        let missing = dir.join("adversaria-service-gone");
        assert!(describe_sidecar(Some(&missing)).contains("exists=no"));

        let _ = fs::remove_dir_all(&dir);
    }
}
