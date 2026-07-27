//! Capture permissions, asked for **during first-run setup** rather than lazily
//! at the first recording.
//!
//! The lazy path is a real churn bug: a new user finishes setup, presses
//! Record, and only then meets a macOS prompt — and for Screen Recording, a
//! prompt that requires *relaunching the app* before it takes effect. Setup is
//! the right place to spend that friction, next to the model download.
//!
//! macOS specifics worth knowing before editing:
//! - **Microphone** (`AVCaptureDevice`) can be requested in-process; the prompt
//!   appears immediately and the grant applies without a restart.
//! - **Screen Recording** (what ScreenCaptureKit needs for system audio) can be
//!   requested exactly **once** via `CGRequestScreenCaptureAccess`. After a
//!   denial that call is a no-op forever, so the only remaining path is System
//!   Settings — and the grant does **not** apply until the app restarts. Both
//!   facts are surfaced in the UI instead of being discovered by the user.

use serde::{Deserialize, Serialize};

/// TCC state for one permission, as far as the app can observe it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionState {
    /// Usable right now.
    Granted,
    /// Explicitly refused — only System Settings can undo it.
    Denied,
    /// Never asked; requesting will show the system prompt.
    Undetermined,
}

/// Everything the recorder needs before it can capture a meeting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CapturePermissions {
    /// Your own voice ("Me"). Without it only the far side is recorded.
    pub microphone: PermissionState,
    /// System audio ("Them") via ScreenCaptureKit. Without it a call isn't
    /// captured at all — this is the one that matters most.
    pub screen_recording: PermissionState,
    /// True when Screen Recording was granted in this process but macOS won't
    /// honour it until the app restarts.
    pub needs_relaunch: bool,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{CapturePermissions, PermissionState};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    // CoreGraphics screen-capture gate. Present since macOS 10.15.
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// Set when we observe screen recording flip to granted inside this
    /// process, which macOS only honours after a restart.
    static SCREEN_GRANTED_THIS_RUN: AtomicBool = AtomicBool::new(false);

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

    fn screen_state() -> PermissionState {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            PermissionState::Granted
        } else if SCREEN_GRANTED_THIS_RUN.load(Ordering::Relaxed) {
            // Granted in System Settings but not yet live in this process.
            PermissionState::Granted
        } else {
            // CoreGraphics can't distinguish "never asked" from "denied", so
            // callers treat this as "try the prompt, then fall back to
            // Settings" — which is correct for both.
            PermissionState::Undetermined
        }
    }

    pub fn check() -> CapturePermissions {
        CapturePermissions {
            microphone: mic_state(),
            screen_recording: screen_state(),
            needs_relaunch: SCREEN_GRANTED_THIS_RUN.load(Ordering::Relaxed)
                && !unsafe { CGPreflightScreenCaptureAccess() },
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

    /// Ask for Screen Recording. Only ever prompts once per install; after a
    /// refusal this is a no-op and the caller must send the user to Settings.
    pub fn request_screen_recording() -> PermissionState {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return PermissionState::Granted;
        }
        if unsafe { CGRequestScreenCaptureAccess() } {
            SCREEN_GRANTED_THIS_RUN.store(true, Ordering::Relaxed);
            return PermissionState::Granted;
        }
        PermissionState::Denied
    }

    /// Note that the user granted Screen Recording out-of-process, so the UI
    /// can offer a relaunch.
    pub fn mark_screen_granted_externally() {
        SCREEN_GRANTED_THIS_RUN.store(true, Ordering::Relaxed);
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{CapturePermissions, PermissionState};

    // Windows has no equivalent TCC gate for loopback capture or the mic, so
    // setup shows nothing and the recorder just works.
    pub fn check() -> CapturePermissions {
        CapturePermissions {
            microphone: PermissionState::Granted,
            screen_recording: PermissionState::Granted,
            needs_relaunch: false,
        }
    }
    pub fn request_microphone() -> PermissionState {
        PermissionState::Granted
    }
    pub fn request_screen_recording() -> PermissionState {
        PermissionState::Granted
    }
    pub fn mark_screen_granted_externally() {}
}

pub use imp::{
    check, mark_screen_granted_externally, request_microphone, request_screen_recording,
};

/// Deep link into the exact System Settings pane for a permission, so a denied
/// user isn't told to "go to Settings" and left to find it.
pub fn settings_url(which: &str) -> &'static str {
    match which {
        "microphone" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    }
}
