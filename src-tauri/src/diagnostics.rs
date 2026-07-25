//! Local, redacted diagnostic event log and deliberate export.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use tauri::{AppHandle, Manager};

const MAX_LOG_BYTES: u64 = 512 * 1024;
const LOG_COPIES: usize = 3;
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

fn redact(value: &str) -> String {
    static EMAIL: OnceLock<Regex> = OnceLock::new();
    static UNIX_PATH: OnceLock<Regex> = OnceLock::new();
    static WINDOWS_PATH: OnceLock<Regex> = OnceLock::new();
    let email =
        EMAIL.get_or_init(|| Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b").unwrap());
    let unix_path =
        UNIX_PATH.get_or_init(|| Regex::new(r"/(?:Users|home|private|tmp|var)/[^\s,;]+").unwrap());
    let windows_path = WINDOWS_PATH.get_or_init(|| Regex::new(r"(?i)\b[A-Z]:\\[^\s,;]+").unwrap());
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
    let redacted = email.replace_all(&padded, "[email]");
    let redacted = unix_path.replace_all(&redacted, "[path]");
    windows_path
        .replace_all(&redacted, "[path]")
        .trim()
        .chars()
        .take(300)
        .collect()
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

pub fn export() -> Result<Option<String>, String> {
    let Some(destination) = rfd::FileDialog::new()
        .set_file_name("adversaria-redacted-diagnostics.txt")
        .save_file()
    else {
        return Ok(None);
    };
    let _guard = LOG_LOCK.lock().unwrap();
    let mut output = format!(
        "Adversaria redacted diagnostics\nGenerated: {}\nApp version: {}\nPlatform: {}/{}\nNo meeting content, contact fields, secrets, or raw paths are included.\n\n",
        chrono::Utc::now().to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
    for index in (0..LOG_COPIES).rev() {
        if let Some(path) = log_path(index) {
            if let Ok(contents) = fs::read_to_string(path) {
                output.push_str(&contents);
            }
        }
    }
    fs::write(&destination, output)
        .map_err(|e| format!("Could not export redacted diagnostics: {e}"))?;
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
}
