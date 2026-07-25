//! Hardware inventory and pinned local-model profiles for first-run setup.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use sysinfo::{Disks, System};
use tauri::{AppHandle, Manager};

use crate::types::{ManagedLlmStatus, ModelProfile, SetupStatus};

const HIGH_REPO: &str = "mlx-community/Qwen3.6-27B-4bit";
const HIGH_REVISION: &str = "c000ac2c2057d94be3fa931000c31723aac53282";
const LIGHT_REPO: &str = "mlx-community/Qwen3.5-4B-MLX-4bit";
const LIGHT_REVISION: &str = "32f3e8ecf65426fc3306969496342d504bfa13f3";
const MID_REPO: &str = "mlx-community/Qwen3.5-9B-MLX-4bit";
const MID_REVISION: &str = "938d8919941c6e7efd3c7150eff7fe9d12afa631";
const RUNTIME_PRIVACY_ARGS: &[&str] = &[
    "--text-only",
    "--disable-prefix-cache",
    "--kv-disk-checkpoint-interval",
    "0",
    "--cors-origins",
    "http://127.0.0.1",
    "--log-level",
    "WARNING",
];

static MANAGED_CREDENTIALS: OnceLock<RwLock<Option<(String, String)>>> = OnceLock::new();

pub struct ManagedLlmProcess {
    child: std::process::Child,
    profile_id: String,
    ready: bool,
}

pub fn managed_credentials() -> Option<(String, String)> {
    MANAGED_CREDENTIALS
        .get_or_init(|| RwLock::new(None))
        .read()
        .unwrap()
        .clone()
}

fn set_managed_credentials(value: Option<(String, String)>) {
    *MANAGED_CREDENTIALS
        .get_or_init(|| RwLock::new(None))
        .write()
        .unwrap() = value;
}

pub fn profile_alias(profile_id: &str) -> Option<&'static str> {
    match profile_id {
        "qwen-27b-quality" => Some("qwen3.6-27b-4bit"),
        "qwen-9b-balanced" => Some("qwen3.5-9b-4bit"),
        "qwen-4b-light" => Some("qwen3.5-4b-4bit"),
        _ => None,
    }
}

/// Profile ids the setup download pipeline may fetch: the LLM profiles plus
/// the two pinned Whisper models (pre-cached during onboarding so the first
/// transcription and the live-caption warm-up never download on a fresh Mac).
pub fn downloadable_profile(profile_id: &str) -> bool {
    profile_alias(profile_id).is_some() || matches!(profile_id, "whisper-main" | "whisper-live")
}

fn cache_root() -> Option<PathBuf> {
    std::env::var_os("HF_HOME")
        .map(PathBuf::from)
        .map(|path| path.join("hub"))
        .or_else(|| {
            directories::BaseDirs::new().map(|dirs| {
                dirs.home_dir()
                    .join(".cache")
                    .join("huggingface")
                    .join("hub")
            })
        })
}

fn snapshot_path(repo: &str, revision: &str) -> Option<PathBuf> {
    let repo_dir = format!("models--{}", repo.replace('/', "--"));
    cache_root().map(|root| root.join(repo_dir).join("snapshots").join(revision))
}

fn snapshot_installed(repo: &str, revision: &str) -> bool {
    snapshot_path(repo, revision).is_some_and(|path| {
        path.join("config.json").is_file()
            && (path.join("model.safetensors").is_file()
                || path.join("model.safetensors.index.json").is_file())
    })
}

pub fn pinned_snapshot(profile_id: &str) -> Result<PathBuf, String> {
    let (repo, revision) = match profile_id {
        "qwen-27b-quality" => (HIGH_REPO, HIGH_REVISION),
        "qwen-9b-balanced" => (MID_REPO, MID_REVISION),
        "qwen-4b-light" => (LIGHT_REPO, LIGHT_REVISION),
        _ => return Err(format!("Unknown model profile: {profile_id}")),
    };
    let path = snapshot_path(repo, revision)
        .ok_or_else(|| "Could not locate the local model cache.".to_string())?;
    if !snapshot_installed(repo, revision) {
        return Err(format!(
            "The pinned {profile_id} model is not installed or is incomplete."
        ));
    }
    Ok(path)
}

fn available_disk_for(path: &Path) -> u64 {
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map_or(0, |disk| disk.available_space())
}

pub fn setup_status(app: &AppHandle) -> SetupStatus {
    let system = System::new_all();
    let total_memory_bytes = system.total_memory();
    let available_disk_bytes = available_disk_for(&crate::config::app_data_dir());
    let memory_gb = total_memory_bytes / 1_000_000_000;
    let disk_gb = available_disk_bytes / 1_000_000_000;
    let high_recommended = memory_gb >= 24 && disk_gb >= 20;
    let mid_recommended = !high_recommended && memory_gb >= 16 && disk_gb >= 7;
    let runtime = app
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.join("rapid-mlx").join("rapid-mlx"))
        .is_some_and(|path| path.is_file());
    let profiles = vec![
        ModelProfile {
            id: "qwen-27b-quality".to_string(),
            display_name: "Qwen 3.6 27B — best meeting quality".to_string(),
            model_alias: "qwen3.6-27b-4bit".to_string(),
            model_repo: HIGH_REPO.to_string(),
            model_revision: HIGH_REVISION.to_string(),
            runtime: "rapid-mlx-pinned".to_string(),
            minimum_memory_gb: 24,
            required_disk_gb: 20,
            quality_label: "Highest quality".to_string(),
            quality_note: "Best supported local meeting-output profile; slower and larger."
                .to_string(),
            installed: snapshot_installed(HIGH_REPO, HIGH_REVISION),
            recommended: high_recommended,
        },
        ModelProfile {
            id: "qwen-9b-balanced".to_string(),
            display_name: "Qwen 3.5 9B — balanced quality and speed".to_string(),
            model_alias: "qwen3.5-9b-4bit".to_string(),
            model_repo: MID_REPO.to_string(),
            model_revision: MID_REVISION.to_string(),
            runtime: "rapid-mlx-pinned".to_string(),
            minimum_memory_gb: 16,
            required_disk_gb: 7,
            quality_label: "Balanced quality".to_string(),
            quality_note: "Strong meeting notes at a fraction of the size; good default for 16 GB Macs."
                .to_string(),
            installed: snapshot_installed(MID_REPO, MID_REVISION),
            recommended: mid_recommended,
        },
        ModelProfile {
            id: "qwen-4b-light".to_string(),
            display_name: "Qwen 3.5 4B — lighter and faster".to_string(),
            model_alias: "qwen3.5-4b-4bit".to_string(),
            model_repo: LIGHT_REPO.to_string(),
            model_revision: LIGHT_REVISION.to_string(),
            runtime: "rapid-mlx-pinned".to_string(),
            minimum_memory_gb: 8,
            required_disk_gb: 5,
            quality_label: "Reduced quality".to_string(),
            quality_note:
                "Fits smaller Macs, but may omit nuance in long or complex meeting notes."
                    .to_string(),
            installed: snapshot_installed(LIGHT_REPO, LIGHT_REVISION),
            recommended: !high_recommended && !mid_recommended,
        },
    ];
    SetupStatus {
        schema_version: 1,
        platform: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        total_memory_bytes,
        available_disk_bytes,
        rapid_runtime_bundled: runtime,
        recommended_profile: if high_recommended {
            "qwen-27b-quality"
        } else if mid_recommended {
            "qwen-9b-balanced"
        } else {
            "qwen-4b-light"
        }
        .to_string(),
        profiles,
    }
}

fn runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" {
        return Err("Managed Rapid-MLX is currently available on Apple Silicon only.".to_string());
    }
    let path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not locate application resources: {e}"))?
        .join("rapid-mlx")
        .join("rapid-mlx");
    if !path.is_file() {
        return Err(
            "The pinned Rapid-MLX runtime is missing from this build. Reinstall Adversaria or choose an explicit cloud provider."
                .to_string(),
        );
    }
    Ok(path)
}

fn random_api_key() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn status(process: &std::sync::Mutex<Option<ManagedLlmProcess>>) -> ManagedLlmStatus {
    let mut guard = process.lock().unwrap();
    let Some(managed) = guard.as_mut() else {
        return ManagedLlmStatus {
            state: "stopped".to_string(),
            profile_id: None,
            detail: "Local meeting model is stopped.".to_string(),
        };
    };
    if managed.child.try_wait().ok().flatten().is_some() {
        set_managed_credentials(None);
        let profile_id = managed.profile_id.clone();
        *guard = None;
        return ManagedLlmStatus {
            state: "error".to_string(),
            profile_id: Some(profile_id),
            detail: "Local meeting model exited unexpectedly; retry setup.".to_string(),
        };
    }
    ManagedLlmStatus {
        state: if managed.ready { "ready" } else { "starting" }.to_string(),
        profile_id: Some(managed.profile_id.clone()),
        detail: if managed.ready {
            "Local meeting model is ready.".to_string()
        } else {
            "Local meeting model is loading.".to_string()
        },
    }
}

pub async fn start(
    app: &AppHandle,
    process: &std::sync::Mutex<Option<ManagedLlmProcess>>,
    profile_id: &str,
) -> Result<ManagedLlmStatus, String> {
    if process.lock().unwrap().is_some() {
        return Ok(status(process));
    }
    let executable = runtime_path(app)?;
    let snapshot = pinned_snapshot(profile_id)?;
    crate::diagnostics::record("local_model.starting", profile_id);
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Could not reserve a local model port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not inspect the local model port: {e}"))?
        .port();
    drop(listener);
    let base_url = format!("http://127.0.0.1:{port}/v1");
    let api_key = random_api_key();
    let served_model_name =
        profile_alias(profile_id).ok_or_else(|| format!("Unknown model profile: {profile_id}"))?;
    let mut command = std::process::Command::new(&executable);
    command
        .arg("serve")
        .arg(snapshot)
        .arg("--served-model-name")
        .arg(served_model_name)
        // Text-only avoids bundling unused vision/Torch dependencies. Prefix
        // and KV persistence are disabled so prompts/transcripts never enter a
        // Rapid-MLX disk cache. CORS is loopback-only and auth is mandatory.
        .args(RUNTIME_PRIVACY_ARGS)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--api-key")
        .arg(&api_key)
        .env("RAPID_MLX_TELEMETRY", "0")
        .env("HF_HUB_OFFLINE", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = command
        .spawn()
        .map_err(|e| format!("Could not start the bundled local model runtime: {e}"))?;
    set_managed_credentials(Some((base_url.clone(), api_key.clone())));
    *process.lock().unwrap() = Some(ManagedLlmProcess {
        child,
        profile_id: profile_id.to_string(),
        ready: false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("Could not create local model health client: {e}"))?;
    for _ in 0..90 {
        if process
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|managed| managed.child.try_wait().ok().flatten())
            .is_some()
        {
            stop(process);
            return Err(
                "The bundled local model exited while loading. Retry setup or reinstall."
                    .to_string(),
            );
        }
        if client
            .get(format!("{base_url}/models"))
            .bearer_auth(&api_key)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            if let Some(managed) = process.lock().unwrap().as_mut() {
                managed.ready = true;
            }
            crate::diagnostics::record("local_model.ready", profile_id);
            return Ok(status(process));
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    stop(process);
    crate::diagnostics::record("local_model.timeout", profile_id);
    Err("The local meeting model did not become ready within three minutes.".to_string())
}

pub fn stop(process: &std::sync::Mutex<Option<ManagedLlmProcess>>) {
    set_managed_credentials(None);
    if let Some(mut managed) = process.lock().unwrap().take() {
        crate::diagnostics::record("local_model.stopped", &managed.profile_id);
        let _ = managed.child.kill();
        let _ = managed.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_profiles_use_immutable_revisions() {
        assert_eq!(HIGH_REVISION.len(), 40);
        assert_eq!(MID_REVISION.len(), 40);
        assert_eq!(LIGHT_REVISION.len(), 40);
        assert!(HIGH_REVISION.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(MID_REVISION.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(LIGHT_REVISION.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn unknown_profile_cannot_resolve_a_snapshot() {
        assert!(pinned_snapshot("unknown").is_err());
    }

    #[test]
    fn profile_aliases_are_stable() {
        assert_eq!(profile_alias("qwen-27b-quality"), Some("qwen3.6-27b-4bit"));
        assert_eq!(profile_alias("qwen-9b-balanced"), Some("qwen3.5-9b-4bit"));
        assert_eq!(profile_alias("qwen-4b-light"), Some("qwen3.5-4b-4bit"));
    }

    #[test]
    fn whisper_models_are_downloadable_profiles() {
        assert!(downloadable_profile("whisper-main"));
        assert!(downloadable_profile("whisper-live"));
        assert!(downloadable_profile("qwen-9b-balanced"));
        assert!(!downloadable_profile("unknown"));
    }

    #[test]
    fn managed_runtime_disables_content_bearing_disk_caches() {
        assert!(RUNTIME_PRIVACY_ARGS.contains(&"--disable-prefix-cache"));
        assert!(RUNTIME_PRIVACY_ARGS
            .windows(2)
            .any(|pair| pair == ["--kv-disk-checkpoint-interval", "0"]));
        assert!(RUNTIME_PRIVACY_ARGS.contains(&"--text-only"));
        assert!(RUNTIME_PRIVACY_ARGS.contains(&"http://127.0.0.1"));
    }
}
