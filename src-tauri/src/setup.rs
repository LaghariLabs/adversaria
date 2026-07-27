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

/// The model name a profile resolves to for the LLM backend that will serve it.
///
/// This is the single id→model mapping the whole app funnels through — onboarding
/// (`complete_step`), the Settings switch (`set_selected_model_profile`), and the
/// managed-runtime spawn all gate on it, and anything it rejects surfaces as
/// "Unknown model profile". It therefore has to know **both** engines: a pinned
/// Rapid-MLX profile, and an Ollama tag.
///
/// Returns `String` rather than `&'static str` because an Ollama tag is
/// discovered at runtime from whatever the user has pulled.
pub fn profile_alias(profile_id: &str) -> Option<String> {
    // An `ollama:` id carries its own alias — the tag after the prefix is exactly
    // what the summarizer asks Ollama for.
    if let Some(tag) = profile_id.strip_prefix("ollama:") {
        return (!tag.is_empty()).then(|| tag.to_string());
    }
    match profile_id {
        "qwen-27b-quality" => Some("qwen3.6-27b-4bit".to_string()),
        "qwen-9b-balanced" => Some("qwen3.5-9b-4bit".to_string()),
        "qwen-4b-light" => Some("qwen3.5-4b-4bit".to_string()),
        _ => None,
    }
}

/// Profile ids the setup download pipeline may fetch: the LLM profiles plus
/// the two pinned Whisper models (pre-cached during onboarding so the first
/// transcription and the live-caption warm-up never download on a fresh Mac).
///
/// Ollama models are excluded deliberately: they are already on disk, and asking
/// the Python service to "download" one would fail. `profile_alias` now accepts
/// them, so this can no longer lean on it alone.
pub fn downloadable_profile(profile_id: &str) -> bool {
    if profile_id.starts_with("ollama:") {
        return false;
    }
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

/// Ollama's loopback endpoint — the same host the Python summarizer uses.
const OLLAMA_URL: &str = "http://127.0.0.1:11434";

/// Fraction of total memory a local model may occupy. Weights are only part of
/// the resident footprint (KV cache, the app, the OS), so a model sized at the
/// full memory figure will page or fail to load.
const MODEL_MEMORY_BUDGET: f64 = 0.7;

#[derive(serde::Deserialize)]
struct OllamaTags {
    models: Vec<OllamaModel>,
}

#[derive(serde::Deserialize)]
struct OllamaModel {
    name: String,
    size: u64,
}

/// Local meeting-model choices on a platform with no bundled Rapid-MLX runtime
/// — i.e. everything except Apple Silicon, where the local engine is Ollama.
///
/// Every entry is `installed: true` because an Ollama model is already on disk.
/// That matters: first-run setup gates its "Run sample summary" step on the
/// selected profile being installed, and `installed` could previously only
/// become true for a pinned MLX snapshot — so on Windows the wizard sat on
/// "Your meeting model is still downloading" forever with nothing downloading.
///
/// Returns empty when Ollama isn't reachable; the wizard renders that as "no
/// local engine found" rather than a broken build.
async fn ollama_profiles(memory_gb: u64) -> Vec<ModelProfile> {
    let request = reqwest::Client::new()
        .get(format!("{OLLAMA_URL}/api/tags"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;
    let Ok(response) = request else {
        return Vec::new();
    };
    let Ok(tags) = response.json::<OllamaTags>().await else {
        return Vec::new();
    };

    // Embedding models are pulled alongside chat models for the knowledge-graph
    // index but cannot summarize a meeting. Offering one would produce empty
    // notes with no error, so keep them out of a "meeting model" picker.
    let mut models: Vec<OllamaModel> = tags
        .models
        .into_iter()
        .filter(|model| !model.name.contains("embed"))
        .collect();
    // Largest first: quality tracks size, so the best model that fits wins.
    models.sort_by_key(|model| std::cmp::Reverse(model.size));

    let budget = (memory_gb as f64 * MODEL_MEMORY_BUDGET * 1_000_000_000.0) as u64;
    let recommended = models
        .iter()
        .find(|model| model.size <= budget)
        .map(|model| model.name.clone());

    models
        .iter()
        .map(|model| {
            let size_gb = model.size as f64 / 1_000_000_000.0;
            let fits = model.size <= budget;
            ModelProfile {
                id: format!("ollama:{}", model.name),
                display_name: model.name.clone(),
                // `set_selected_model_profile` writes this straight into
                // `ollama_model`, which is the tag the summarizer requests.
                model_alias: model.name.clone(),
                model_repo: String::new(),
                model_revision: String::new(),
                runtime: "ollama".to_string(),
                minimum_memory_gb: (size_gb / MODEL_MEMORY_BUDGET).ceil() as u32,
                required_disk_gb: size_gb.ceil() as u32,
                quality_label: if fits {
                    "Fits this machine".to_string()
                } else {
                    "Larger than this machine".to_string()
                },
                quality_note: if fits {
                    format!("{size_gb:.1} GB, already pulled in Ollama.")
                } else {
                    format!(
                        "{size_gb:.1} GB — beyond the ~{:.0} GB this machine can hold, so it will \
                         page badly or fail to load.",
                        budget as f64 / 1_000_000_000.0
                    )
                },
                installed: true,
                recommended: recommended.as_deref() == Some(model.name.as_str()),
            }
        })
        .collect()
}

pub async fn setup_status(app: &AppHandle) -> SetupStatus {
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

    // Which engine's profiles to offer is a question about the PLATFORM, not
    // about whether this particular build bundled the runtime.
    //
    // Gating on `runtime` instead would change macOS behaviour: `tauri dev` has
    // no bundled rapid-mlx resource, so a Mac developer would suddenly be shown
    // Ollama models where they have always seen the pinned MLX profiles plus the
    // "missing from this build" notice. `rapid_mlx_supported()` keeps Apple
    // Silicon on the MLX list either way, and correctly routes Intel Macs — where
    // Rapid-MLX can never run — to Ollama alongside Windows and Linux.
    if !rapid_mlx_supported() {
        let profiles = ollama_profiles(memory_gb).await;
        let recommended_profile = profiles
            .iter()
            .find(|profile| profile.recommended)
            .map(|profile| profile.id.clone())
            .unwrap_or_default();
        return SetupStatus {
            schema_version: 1,
            platform: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            total_memory_bytes,
            available_disk_bytes,
            rapid_runtime_bundled: runtime,
            recommended_profile,
            profiles,
        };
    }

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
            quality_note:
                "Strong meeting notes at a fraction of the size; good default for 16 GB Macs."
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

/// Whether a managed Rapid-MLX runtime can run on this machine at all.
///
/// When false the local engine is Ollama, and no profile id — however stale —
/// should ever reach the Rapid-MLX lifecycle.
fn rapid_mlx_supported() -> bool {
    std::env::consts::OS == "macos" && std::env::consts::ARCH == "aarch64"
}

fn runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    if !rapid_mlx_supported() {
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

/// Confirm Ollama is serving `tag`, and report it as a running local engine.
///
/// Adversaria neither spawns nor supervises Ollama, so there is no child process
/// to manage — "starting" it is a reachability check. Both errors are written to
/// be actionable, because this is the first place a user without Ollama (or
/// without that model pulled) finds out.
async fn ollama_ready(tag: &str) -> Result<ManagedLlmStatus, String> {
    let tags = reqwest::Client::new()
        .get(format!("{OLLAMA_URL}/api/tags"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| {
            "Ollama isn't reachable on 127.0.0.1:11434. Start Ollama — or install it from \
             ollama.com — and try again."
                .to_string()
        })?
        .json::<OllamaTags>()
        .await
        .map_err(|error| format!("Ollama returned a model list we couldn't read: {error}"))?;

    if !tags.models.iter().any(|model| model.name == tag) {
        return Err(format!(
            "Ollama doesn't have `{tag}`. Pull it with `ollama pull {tag}`, or choose a different \
             model in setup."
        ));
    }

    crate::diagnostics::record("local_model.ollama_ready", tag);
    Ok(ManagedLlmStatus {
        state: "running".to_string(),
        profile_id: Some(format!("ollama:{tag}")),
        detail: format!("Local meeting notes run through Ollama ({tag})."),
    })
}

pub async fn start(
    app: &AppHandle,
    process: &std::sync::Mutex<Option<ManagedLlmProcess>>,
    profile_id: &str,
) -> Result<ManagedLlmStatus, String> {
    // Where Rapid-MLX cannot run, "local" means Ollama — for ANY profile id, not
    // just an `ollama:`-prefixed one.
    //
    // Keying only off the prefix was not enough: onboarding persists
    // `selected_model_profile`, so anyone who completed the model step on a build
    // that offered MLX profiles still carries an id like `qwen-27b-quality`.
    // Resuming setup replays it here and it fell straight through to
    // `runtime_path()`, failing with "Managed Rapid-MLX is currently available on
    // Apple Silicon only" on a machine that was never going to run Rapid-MLX.
    // A stale id resolves to the configured Ollama tag instead.
    if !rapid_mlx_supported() {
        let tag = profile_id
            .strip_prefix("ollama:")
            .map(str::to_string)
            .unwrap_or_else(|| crate::config::load_config().ollama_model);
        return ollama_ready(&tag).await;
    }
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
        assert_eq!(
            profile_alias("qwen-27b-quality").as_deref(),
            Some("qwen3.6-27b-4bit")
        );
        assert_eq!(
            profile_alias("qwen-9b-balanced").as_deref(),
            Some("qwen3.5-9b-4bit")
        );
        assert_eq!(
            profile_alias("qwen-4b-light").as_deref(),
            Some("qwen3.5-4b-4bit")
        );
    }

    /// Regression: `profile_alias` knew only the three pinned MLX ids, and BOTH
    /// `complete_step` and `set_selected_model_profile` gate on it — so choosing
    /// any Ollama model failed with "Unknown model profile: ollama:<tag>" and
    /// setup could not be completed on Windows.
    #[test]
    fn ollama_profiles_resolve_to_their_tag() {
        assert_eq!(
            profile_alias("ollama:qwen3:14b").as_deref(),
            Some("qwen3:14b")
        );
        assert_eq!(
            profile_alias("ollama:qwen3.6:35b-a3b").as_deref(),
            Some("qwen3.6:35b-a3b")
        );
        // A bare prefix names no model.
        assert_eq!(profile_alias("ollama:"), None);
    }

    #[test]
    fn whisper_models_are_downloadable_profiles() {
        assert!(downloadable_profile("whisper-main"));
        assert!(downloadable_profile("whisper-live"));
        assert!(downloadable_profile("qwen-9b-balanced"));
        assert!(!downloadable_profile("unknown"));
    }

    /// Ollama models are already on disk. `profile_alias` accepts them now, so
    /// `downloadable_profile` must exclude them explicitly or setup would ask the
    /// Python service to "download" a model it cannot fetch.
    #[test]
    fn ollama_profiles_are_never_downloadable() {
        assert!(!downloadable_profile("ollama:qwen3:14b"));
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
