//! The transparent managed local engine for platforms without Rapid-MLX.
//!
//! Decision (2026-07-27, SETUP_REDESIGN_SPEC §D): on Windows the app installs
//! a pinned llama.cpp server itself instead of asking the user to install
//! Ollama — but transparently. `install_plan()` returns exactly what WOULD be
//! installed (versions, sizes, SHA-256s, source URLs) so the UI can show it
//! BEFORE consent; every pin below is auditable in this open-source file.
//! The GGUF model itself downloads through the existing pinned-manifest
//! pipeline in `python-service/src/model_setup.py` — this module only installs
//! the engine binary and knows where the model lands in the HF cache.
//!
//! Pinned 2026-07-28 against live sources:
//! - Engine: github.com/ggml-org/llama.cpp release b10155 (newest with
//!   assets; b10156 had none published yet). The Vulkan build accelerates on
//!   NVIDIA/AMD/Intel alike at 33.6 MB — the CUDA zips are 144–247 MB and
//!   need a 390 MB cudart bundle, which is also how the 0.3.65 installer ran
//!   into NSIS's ~2 GB ceiling.
//! - Models: unsloth's Q4_K_M GGUF uploads (the official Qwen account
//!   publishes no Qwen3.5/3.6 GGUF). Same three-tier contract as macOS.
//!
//! Like the MLX pins, these are deliberately duplicated between here and
//! `model_setup.py` — each side owns its half of the pipeline (Rust: plan +
//! engine + serve; Python: download + checksum). Keep them in lockstep.

use std::path::PathBuf;

use serde::Serialize;

pub const LLAMA_TAG: &str = "b10155";
pub const LLAMA_ASSET: &str = "llama-b10155-bin-win-vulkan-x64.zip";
pub const LLAMA_ASSET_SIZE: u64 = 33_576_473;
pub const LLAMA_ASSET_SHA256: &str =
    "d9d6c72ab8922123b7fb040b4178105e96f15e296cc4b6c3153b938a1c7ff0b4";

pub fn llama_asset_url() -> String {
    format!("https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/{LLAMA_ASSET}")
}

/// One pinned GGUF tier. Ids/aliases are the same cross-platform contract the
/// MLX profiles use; only the artifacts differ.
pub struct GgufPin {
    pub profile_id: &'static str,
    pub alias: &'static str,
    pub display_name: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
    pub file: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    pub minimum_memory_gb: u32,
    pub required_disk_gb: u32,
    pub quality_label: &'static str,
    pub quality_note: &'static str,
}

pub const GGUF_PINS: &[GgufPin] = &[
    GgufPin {
        profile_id: "qwen-27b-quality",
        alias: "qwen3.6-27b-4bit",
        display_name: "Qwen 3.6 27B — best meeting quality",
        repo: "unsloth/Qwen3.6-27B-GGUF",
        revision: "82d411acf4a06cfb8d9b073a5211bf410bfc29bf",
        file: "Qwen3.6-27B-Q4_K_M.gguf",
        size_bytes: 16_817_244_384,
        sha256: "5ed60d0af4650a854b1755bd392f9aef4872643dc25a254bc68043fa638392a0",
        minimum_memory_gb: 24,
        required_disk_gb: 20,
        quality_label: "Highest quality",
        quality_note: "Best supported local meeting-output profile; slower and larger.",
    },
    GgufPin {
        profile_id: "qwen-9b-balanced",
        alias: "qwen3.5-9b-4bit",
        display_name: "Qwen 3.5 9B — balanced quality and speed",
        repo: "unsloth/Qwen3.5-9B-GGUF",
        revision: "3885219b6810b007914f3a7950a8d1b469d598a5",
        file: "Qwen3.5-9B-Q4_K_M.gguf",
        size_bytes: 5_680_522_464,
        sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
        minimum_memory_gb: 16,
        required_disk_gb: 7,
        quality_label: "Balanced quality",
        quality_note:
            "Strong meeting notes at a fraction of the size; good default for 16 GB machines.",
    },
    GgufPin {
        profile_id: "qwen-4b-light",
        alias: "qwen3.5-4b-4bit",
        display_name: "Qwen 3.5 4B — lighter and faster",
        repo: "unsloth/Qwen3.5-4B-GGUF",
        revision: "e87f176479d0855a907a41277aca2f8ee7a09523",
        file: "Qwen3.5-4B-Q4_K_M.gguf",
        size_bytes: 2_740_937_888,
        sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
        minimum_memory_gb: 8,
        required_disk_gb: 3,
        quality_label: "Reduced quality",
        quality_note:
            "Fits smaller machines, but may omit nuance in long or complex meeting notes.",
    },
];

pub fn gguf_pin(profile_id: &str) -> Option<&'static GgufPin> {
    GGUF_PINS.iter().find(|pin| pin.profile_id == profile_id)
}

/// Same memory/disk gates as the macOS tiers, so a given machine gets the
/// same tier recommendation regardless of platform.
pub fn recommended_gguf(memory_gb: u64, disk_gb: u64) -> &'static GgufPin {
    if memory_gb >= 24 && disk_gb >= 20 {
        &GGUF_PINS[0]
    } else if memory_gb >= 16 && disk_gb >= 7 {
        &GGUF_PINS[1]
    } else {
        &GGUF_PINS[2]
    }
}

/// Where the pinned GGUF lands via the python download pipeline (the standard
/// HF cache layout — same derivation as `setup::snapshot_path`).
pub fn gguf_path(pin: &GgufPin) -> Option<PathBuf> {
    let repo_dir = format!("models--{}", pin.repo.replace('/', "--"));
    crate::setup::cache_root().map(|root| {
        root.join(repo_dir)
            .join("snapshots")
            .join(pin.revision)
            .join(pin.file)
    })
}

pub fn gguf_installed(pin: &GgufPin) -> bool {
    gguf_path(pin).is_some_and(|path| path.is_file())
}

/// The engine install directory is tag-versioned so an engine upgrade is a
/// fresh directory, never an in-place overwrite.
pub fn engine_dir() -> PathBuf {
    crate::config::app_data_dir()
        .join("llama-engine")
        .join(LLAMA_TAG)
}

pub fn server_path() -> PathBuf {
    let name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    engine_dir().join(name)
}

pub fn engine_installed() -> bool {
    server_path().is_file()
}

/// `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` →
/// "NVIDIA GeForce RTX 4070, 12282 MiB". Pure parse, testable everywhere.
pub fn parse_nvidia_smi(output: &str) -> Option<String> {
    let line = output.lines().find(|line| !line.trim().is_empty())?;
    let mut parts = line.splitn(2, ',');
    let name = parts.next()?.trim();
    if name.is_empty() {
        return None;
    }
    let memory = parts.next().map(str::trim).unwrap_or_default();
    Some(if memory.is_empty() {
        name.to_string()
    } else {
        format!("{name} ({memory})")
    })
}

/// Best-effort GPU detection for the consent screen and diagnostics. Absence
/// of nvidia-smi is normal (AMD/Intel/none) — the Vulkan engine build still
/// accelerates there, so this is informational, never a gate.
pub fn detect_gpu() -> Option<String> {
    let mut command = std::process::Command::new("nvidia-smi");
    command.args(["--query-gpu=name,memory.total", "--format=csv,noheader"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_nvidia_smi(&String::from_utf8_lossy(&output.stdout))
}

/// Everything the consent screen shows BEFORE anything is installed.
/// Pure data; no side effects.
#[derive(Debug, Clone, Serialize)]
pub struct EngineInstallPlan {
    pub schema_version: u32,
    pub engine_name: String,
    pub engine_version: String,
    pub asset_name: String,
    pub asset_size_bytes: u64,
    pub asset_sha256: String,
    pub source_url: String,
    pub install_dir: String,
    pub engine_installed: bool,
    pub gpu: Option<String>,
    pub model_profile_id: String,
    pub model_display_name: String,
    pub model_repo: String,
    pub model_revision: String,
    pub model_file: String,
    pub model_size_bytes: u64,
    pub model_sha256: String,
    pub model_installed: bool,
}

pub fn install_plan(memory_gb: u64, disk_gb: u64) -> EngineInstallPlan {
    let pin = recommended_gguf(memory_gb, disk_gb);
    EngineInstallPlan {
        schema_version: 1,
        engine_name: "llama.cpp server (Vulkan)".to_string(),
        engine_version: LLAMA_TAG.to_string(),
        asset_name: LLAMA_ASSET.to_string(),
        asset_size_bytes: LLAMA_ASSET_SIZE,
        asset_sha256: LLAMA_ASSET_SHA256.to_string(),
        source_url: llama_asset_url(),
        install_dir: engine_dir().to_string_lossy().to_string(),
        engine_installed: engine_installed(),
        gpu: detect_gpu(),
        model_profile_id: pin.profile_id.to_string(),
        model_display_name: pin.display_name.to_string(),
        model_repo: pin.repo.to_string(),
        model_revision: pin.revision.to_string(),
        model_file: pin.file.to_string(),
        model_size_bytes: pin.size_bytes,
        model_sha256: pin.sha256.to_string(),
        model_installed: gguf_installed(pin),
    }
}

/// Download, verify, and unpack the pinned engine. Idempotent: an existing
/// verified install returns Ok immediately. The checksum gates the unpack —
/// a mismatched archive never reaches disk in executable form.
pub async fn install() -> Result<(), String> {
    if cfg!(not(windows)) {
        return Err("The managed engine installer currently supports Windows only.".to_string());
    }
    if engine_installed() {
        return Ok(());
    }
    crate::diagnostics::record("llama_engine.install.starting", LLAMA_TAG);
    let dir = engine_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the engine directory: {e}"))?;

    let url = llama_asset_url();
    let response = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("Could not download the local engine: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The engine download failed with HTTP {}.",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("The engine download was interrupted: {e}"))?;

    use sha2::Digest;
    let digest = format!("{:x}", sha2::Sha256::digest(&bytes));
    if digest != LLAMA_ASSET_SHA256 {
        crate::diagnostics::record("llama_engine.install.checksum_failed", &digest);
        return Err(
            "The engine download did not match its pinned checksum and was discarded.".to_string(),
        );
    }

    let archive = dir.join(LLAMA_ASSET);
    std::fs::write(&archive, &bytes)
        .map_err(|e| format!("Could not store the engine archive: {e}"))?;

    // Windows 10+ ships bsdtar as tar.exe, and it extracts zip archives —
    // no archive crate needed for a Windows-only path.
    let extracted = std::process::Command::new("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(&dir)
        .output()
        .map_err(|e| format!("Could not unpack the engine archive: {e}"))?;
    let _ = std::fs::remove_file(&archive);
    if !extracted.status.success() {
        return Err(format!(
            "Unpacking the engine archive failed: {}",
            String::from_utf8_lossy(&extracted.stderr)
        ));
    }
    if !engine_installed() {
        return Err("The engine archive unpacked but llama-server was not inside it.".to_string());
    }
    crate::diagnostics::record("llama_engine.install.ready", LLAMA_TAG);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_are_immutable_revisions_and_real_checksums() {
        assert_eq!(LLAMA_ASSET_SHA256.len(), 64);
        for pin in GGUF_PINS {
            assert_eq!(pin.revision.len(), 40);
            assert!(pin.revision.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_eq!(pin.sha256.len(), 64);
            assert!(pin.file.ends_with(".gguf"));
        }
    }

    #[test]
    fn tier_gates_match_the_macos_recommendation() {
        assert_eq!(recommended_gguf(32, 100).profile_id, "qwen-27b-quality");
        assert_eq!(recommended_gguf(24, 20).profile_id, "qwen-27b-quality");
        // Plenty of memory but a nearly full disk falls to the mid tier.
        assert_eq!(recommended_gguf(32, 10).profile_id, "qwen-9b-balanced");
        assert_eq!(recommended_gguf(16, 50).profile_id, "qwen-9b-balanced");
        assert_eq!(recommended_gguf(8, 50).profile_id, "qwen-4b-light");
    }

    #[test]
    fn aliases_agree_with_the_shared_profile_map() {
        // `complete_step` persists `profile_alias(id)` into config.ollama_model,
        // and llama-server serves under `pin.alias` — they must be the same
        // string or the summarizer requests a model the server doesn't expose.
        for pin in GGUF_PINS {
            assert_eq!(
                crate::setup::profile_alias(pin.profile_id).as_deref(),
                Some(pin.alias)
            );
        }
    }

    #[test]
    fn nvidia_smi_parsing_is_tolerant() {
        assert_eq!(
            parse_nvidia_smi("NVIDIA GeForce RTX 4070, 12282 MiB\n"),
            Some("NVIDIA GeForce RTX 4070 (12282 MiB)".to_string())
        );
        assert_eq!(
            parse_nvidia_smi("NVIDIA T600\n"),
            Some("NVIDIA T600".to_string())
        );
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("\n\n"), None);
    }

    #[test]
    fn install_plan_is_fully_disclosed() {
        let plan = install_plan(16, 100);
        assert_eq!(plan.engine_version, LLAMA_TAG);
        assert!(plan
            .source_url
            .starts_with("https://github.com/ggml-org/llama.cpp/"));
        assert_eq!(plan.asset_sha256.len(), 64);
        assert_eq!(plan.model_profile_id, "qwen-9b-balanced");
        assert!(plan.model_size_bytes > 1_000_000_000);
        assert_eq!(plan.model_sha256.len(), 64);
    }
}
