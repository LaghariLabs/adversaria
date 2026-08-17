//! Capture permissions, handled during first-run setup rather than lazily at
//! the first recording.
//!
//! macOS microphone access can be requested in-process. System audio uses a
//! Core Audio process tap, for which macOS exposes no public check or request
//! API; the app proves access by playing real audio and recording whether the
//! tap hears it. Screen Recording is not used by the capture path.

use serde::{Deserialize, Serialize};

/// TCC state for one permission, as far as the app can observe it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionState {
    /// Usable right now.
    Granted,
    /// The last check showed that access was not available.
    Denied,
    /// Never checked, or the last persisted check could not be read.
    Undetermined,
}

/// Everything the recorder needs before it can capture a meeting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CapturePermissions {
    /// Your own voice ("Me"). Without it only the far side is recorded.
    pub microphone: PermissionState,
    /// System audio ("Them") via the Core Audio process tap. No public
    /// check API exists; this is the persisted result of the last probe.
    pub system_audio: PermissionState,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{CapturePermissions, PermissionState};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use serde::{Deserialize, Serialize};
    use std::sync::mpsc;
    use std::time::Duration;

    #[derive(Serialize, Deserialize)]
    struct SystemAudioProbeResult {
        system_audio_granted: bool,
        checked_at: String,
    }

    fn mic_state() -> PermissionState {
        use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
        let media_type = unsafe { AVMediaTypeAudio }.expect("AVMediaTypeAudio is always present");
        let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
        match status {
            AVAuthorizationStatus::Authorized => PermissionState::Granted,
            AVAuthorizationStatus::NotDetermined => PermissionState::Undetermined,
            // Restricted (MDM/parental controls) is not recoverable by the
            // user either, so it reads the same as denied.
            _ => PermissionState::Denied,
        }
    }

    fn state_from_probe_json(bytes: &[u8]) -> Option<PermissionState> {
        serde_json::from_slice::<SystemAudioProbeResult>(bytes)
            .ok()
            .map(|probe| {
                if probe.system_audio_granted {
                    PermissionState::Granted
                } else {
                    PermissionState::Denied
                }
            })
    }

    fn system_audio_state() -> PermissionState {
        std::fs::read(crate::config::app_data_dir().join("permission-probe.json"))
            .ok()
            .and_then(|bytes| state_from_probe_json(&bytes))
            .unwrap_or(PermissionState::Undetermined)
    }

    pub fn check() -> CapturePermissions {
        CapturePermissions {
            microphone: mic_state(),
            system_audio: system_audio_state(),
        }
    }

    /// Show the microphone prompt and block until the user answers.
    pub fn request_microphone() -> PermissionState {
        use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};
        match mic_state() {
            PermissionState::Undetermined => {}
            settled => return settled,
        }
        let (tx, rx) = mpsc::channel();
        let completion = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let media_type = unsafe { AVMediaTypeAudio }.expect("AVMediaTypeAudio is always present");
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &completion)
        };
        // Same 120 s ceiling as the calendar prompt: long enough for a user who
        // tabbed away, short enough that setup can't hang forever.
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(true) => PermissionState::Granted,
            Ok(false) => PermissionState::Denied,
            Err(_) => mic_state(),
        }
    }

    pub fn persist_system_audio_probe(granted: bool) -> Result<(), String> {
        let dir = crate::config::app_data_dir();
        std::fs::create_dir_all(&dir).map_err(|error| {
            format!(
                "Couldn't prepare the permission-check folder at {}: {error}",
                dir.display()
            )
        })?;
        let path = dir.join("permission-probe.json");
        let temporary = dir.join("permission-probe.tmp");
        let result = SystemAudioProbeResult {
            system_audio_granted: granted,
            checked_at: chrono::Utc::now().to_rfc3339(),
        };
        let bytes = serde_json::to_vec_pretty(&result)
            .map_err(|error| format!("Couldn't save the system-audio check: {error}"))?;
        std::fs::write(&temporary, bytes).map_err(|error| {
            format!(
                "Couldn't save the system-audio check at {}: {error}",
                temporary.display()
            )
        })?;
        std::fs::rename(&temporary, &path).map_err(|error| {
            format!(
                "Couldn't finish saving the system-audio check at {}: {error}",
                path.display()
            )
        })?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn persisted_probe_maps_true_false_and_unreadable_to_permission_states() {
            assert_eq!(
                state_from_probe_json(
                    br#"{"system_audio_granted":true,"checked_at":"2026-08-17T00:00:00Z"}"#
                ),
                Some(PermissionState::Granted)
            );
            assert_eq!(
                state_from_probe_json(
                    br#"{"system_audio_granted":false,"checked_at":"2026-08-17T00:00:00Z"}"#
                ),
                Some(PermissionState::Denied)
            );
            assert_eq!(state_from_probe_json(b"not json"), None);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{CapturePermissions, PermissionState};

    // WASAPI loopback has no TCC gate, so both capture paths are available.
    pub fn check() -> CapturePermissions {
        CapturePermissions {
            microphone: PermissionState::Granted,
            system_audio: PermissionState::Granted,
        }
    }

    pub fn request_microphone() -> PermissionState {
        PermissionState::Granted
    }

    pub fn persist_system_audio_probe(_granted: bool) -> Result<(), String> {
        Ok(())
    }
}

pub use imp::{check, persist_system_audio_probe, request_microphone};

/// Deep link into the exact System Settings pane for a permission, so a denied
/// user isn't told to "go to Settings" and left to find it.
pub fn settings_url(which: &str) -> &'static str {
    match which {
        "microphone" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture",
    }
}
