//! Meeting auto-detection (Windows).
//!
//! Detects when a conferencing app is actively using the microphone by reading
//! the CapabilityAccessManager ConsentStore in the current user's registry.
//! Each app that has used the mic gets a subkey with a `LastUsedTimeStop`
//! value; Windows sets it to `0` while the app is *currently* using the mic and
//! writes a non-zero timestamp when it stops. So "a known meeting app has a
//! `LastUsedTimeStop == 0`" means "a meeting is probably happening right now".
//!
//! This is read-only, local-only, needs no special permission, reads no audio,
//! and never starts recording on its own — it only emits a `meeting-detected`
//! event so the UI can *offer* to record. Gated by the `auto_detect_meetings`
//! config flag (read live each poll, so toggling Settings takes effect at once).

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::AppState;

/// How often to poll the registry.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Sustained polls of mic use required before prompting (~4–6s). This naturally
/// filters out transient mic use like a one-shot browser voice search.
const DEBOUNCE_POLLS: u32 = 2;
/// Don't re-prompt for the same ongoing situation more often than this.
const REPROMPT_COOLDOWN: Duration = Duration::from_secs(300);

/// Payload for the `meeting-detected` event.
#[derive(Clone, Serialize)]
struct MeetingDetected {
    /// Friendly label of the app that appears to be in a meeting.
    app: String,
}

/// Spawn the background detector thread. No-op effect until the
/// `auto_detect_meetings` flag is enabled (checked live each poll).
pub fn spawn_detector(app: AppHandle) {
    std::thread::spawn(move || {
        eprintln!("[detect] detector thread started");

        let mut consecutive: u32 = 0;
        let mut prompted = false;
        let mut last_prompt: Option<Instant> = None;

        loop {
            std::thread::sleep(POLL_INTERVAL);

            let (enabled, recording) = {
                let state = app.state::<AppState>();
                (
                    state.auto_detect.load(Ordering::Relaxed),
                    state.capture.is_recording(),
                )
            };

            // Reset and idle while disabled or already recording. Also clear the
            // re-prompt cooldown: once the user is recording a detected meeting
            // the earlier prompt is "resolved", so the NEXT meeting — e.g. when
            // they stop and jump straight to another call — should be offered
            // immediately, not suppressed by the leftover REPROMPT_COOLDOWN.
            if !enabled || recording {
                consecutive = 0;
                prompted = false;
                last_prompt = None;
                continue;
            }

            match detect_meeting_app() {
                Some(label) => {
                    consecutive = consecutive.saturating_add(1);
                    eprintln!(
                        "[detect] candidate '{label}' (consecutive={consecutive}, prompted={prompted})"
                    );
                    let cooled = last_prompt.is_none_or(|t| t.elapsed() >= REPROMPT_COOLDOWN);
                    if consecutive >= DEBOUNCE_POLLS && !prompted && cooled {
                        // Fallback in-app banner (only seen if the main window is
                        // open); the floating card below is the primary surface.
                        let _ =
                            app.emit("meeting-detected", MeetingDetected { app: label.clone() });
                        // Granola-style floating card — a small always-on-top
                        // window we draw ourselves, so it shows in dev too
                        // (Windows suppresses OS toasts for unpackaged builds).
                        show_meeting_card(&app, &label);
                        prompted = true;
                        last_prompt = Some(Instant::now());
                    }
                }
                None => {
                    // Meeting ended (or never started) — re-arm for next time.
                    consecutive = 0;
                    prompted = false;
                }
            }
        }
    });
}

/// Show a small frameless, always-on-top "Meeting detected" card in the
/// bottom-right corner. It's a separate webview window we draw ourselves, so it
/// appears in dev too — unlike Windows toasts, which the OS suppresses for
/// unpackaged apps. Window creation must run on the main thread.
fn show_meeting_card(app: &AppHandle, label: &str) {
    // Only one card at a time.
    if app.get_webview_window("notification").is_some() {
        return;
    }
    let handle = app.clone();
    let inner = app.clone();
    let label = label.to_string();
    let _ = handle.run_on_main_thread(move || {
        const W: f64 = 360.0;
        const H: f64 = 112.0;
        const MARGIN: f64 = 16.0;
        // Pass the app label to the card via a query param (only spaces need
        // escaping for these short, alphanumeric labels).
        let encoded = label.replace(' ', "%20");
        let url = WebviewUrl::App(format!("index.html?card=meeting&app={encoded}").into());

        let built = WebviewWindowBuilder::new(&inner, "notification", url)
            .title("Meeting detected")
            .inner_size(W, H)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .transparent(true)
            .focused(true)
            .build();

        match built {
            Ok(win) => {
                // Anchor to the bottom-right, above the taskbar.
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let mw = size.width as f64 / scale;
                    let mh = size.height as f64 / scale;
                    let x = mw - W - MARGIN;
                    let y = mh - H - MARGIN - 48.0;
                    let _ = win.set_position(LogicalPosition::new(x, y));
                }
                eprintln!("[detect] meeting card shown");
            }
            Err(e) => eprintln!("[detect] meeting card FAILED: {e}"),
        }
    });
}

/// Return a friendly label if a known meeting app is currently using the mic.
#[cfg(windows)]
pub fn detect_meeting_app() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const MIC_CONSENT_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    fn key_in_use(key: &RegKey) -> bool {
        // LastUsedTimeStop is a REG_QWORD (FILETIME); 0 means "in use right now".
        matches!(key.get_value::<u64, _>("LastUsedTimeStop"), Ok(0))
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let mic = hkcu.open_subkey(MIC_CONSENT_PATH).ok()?;

    // Packaged / Store apps (e.g. new Teams) are direct subkeys named by package.
    for name in mic.enum_keys().flatten() {
        if name.eq_ignore_ascii_case("NonPackaged") {
            continue;
        }
        if let Ok(k) = mic.open_subkey(&name) {
            if key_in_use(&k) {
                if let Some(label) = classify(&name) {
                    return Some(label);
                }
            }
        }
    }

    // Classic Win32 apps live under NonPackaged; the subkey name is the exe path
    // with '\' replaced by '#'.
    if let Ok(np) = mic.open_subkey("NonPackaged") {
        for name in np.enum_keys().flatten() {
            if let Ok(k) = np.open_subkey(&name) {
                if key_in_use(&k) {
                    if let Some(label) = classify(&name.replace('#', "\\")) {
                        return Some(label);
                    }
                }
            }
        }
    }

    None
}

/// macOS: detect a meeting via the CoreAudio process-object list — the direct
/// analog of the Windows ConsentStore read. We enumerate audio process objects,
/// find those actively capturing input (`kAudioProcessPropertyIsRunningInput`,
/// macOS 14.4+), and classify their bundle id. Read-only, local-only, and needs
/// no TCC permission to enumerate.
#[cfg(target_os = "macos")]
pub fn detect_meeting_app() -> Option<String> {
    macos_detect::detect()
}

#[cfg(target_os = "macos")]
mod macos_detect {
    use std::os::raw::c_void;
    use std::ptr;

    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use coreaudio_sys::{
        AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
        AudioObjectPropertyAddress,
    };

    /// Build a four-char-code property selector (e.g. `b"prl#"`).
    const fn fourcc(b: &[u8; 4]) -> u32 {
        ((b[0] as u32) << 24) | ((b[1] as u32) << 16) | ((b[2] as u32) << 8) | (b[3] as u32)
    }

    const SYSTEM_OBJECT: AudioObjectID = 1; // kAudioObjectSystemObject
    const SCOPE_GLOBAL: u32 = fourcc(b"glob"); // kAudioObjectPropertyScopeGlobal
    const ELEMENT_MAIN: u32 = 0; // kAudioObjectPropertyElementMain
    const PROC_LIST: u32 = fourcc(b"prs#"); // kAudioHardwarePropertyProcessObjectList
    const IS_RUNNING_INPUT: u32 = fourcc(b"piri"); // kAudioProcessPropertyIsRunningInput
    const BUNDLE_ID: u32 = fourcc(b"pbid"); // kAudioProcessPropertyBundleID

    fn address(selector: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: SCOPE_GLOBAL,
            mElement: ELEMENT_MAIN,
        }
    }

    pub fn detect() -> Option<String> {
        for obj in process_list()? {
            if is_running_input(obj) {
                if let Some(bundle) = bundle_id(obj) {
                    if let Some(label) = classify(&bundle) {
                        return Some(label);
                    }
                }
            }
        }
        None
    }

    /// Read the system-wide list of audio process objects.
    fn process_list() -> Option<Vec<AudioObjectID>> {
        let addr = address(PROC_LIST);
        unsafe {
            let mut size: u32 = 0;
            let st =
                AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &addr, 0, ptr::null(), &mut size);
            if st != 0 || size == 0 {
                return None;
            }
            let count = size as usize / std::mem::size_of::<AudioObjectID>();
            let mut ids = vec![0 as AudioObjectID; count];
            let st = AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &addr,
                0,
                ptr::null(),
                &mut size,
                ids.as_mut_ptr() as *mut c_void,
            );
            (st == 0).then_some(ids)
        }
    }

    /// True when this process currently has active input (microphone) IO.
    fn is_running_input(obj: AudioObjectID) -> bool {
        let addr = address(IS_RUNNING_INPUT);
        unsafe {
            let mut val: u32 = 0;
            let mut size = std::mem::size_of::<u32>() as u32;
            let st = AudioObjectGetPropertyData(
                obj,
                &addr,
                0,
                ptr::null(),
                &mut size,
                &mut val as *mut u32 as *mut c_void,
            );
            st == 0 && val != 0
        }
    }

    /// The process's bundle id (e.g. `us.zoom.xos`), if it has one.
    fn bundle_id(obj: AudioObjectID) -> Option<String> {
        let addr = address(BUNDLE_ID);
        unsafe {
            let mut cfstr: CFStringRef = ptr::null();
            let mut size = std::mem::size_of::<CFStringRef>() as u32;
            let st = AudioObjectGetPropertyData(
                obj,
                &addr,
                0,
                ptr::null(),
                &mut size,
                &mut cfstr as *mut CFStringRef as *mut c_void,
            );
            if st != 0 || cfstr.is_null() {
                return None;
            }
            // The property returns a +1-retained CFString; take ownership so it
            // is released when `s` drops.
            let s = CFString::wrap_under_create_rule(cfstr);
            Some(s.to_string())
        }
    }

    /// Map a mic-using app's bundle id to a friendly label, or `None` if it
    /// isn't a meeting app. Browsers are included for Meet / web Teams / Zoom
    /// web; the caller's debounce filters transient browser mic use.
    fn classify(bundle: &str) -> Option<String> {
        let b = bundle.to_lowercase();
        let label = if b.contains("zoom") {
            "Zoom"
        } else if b.contains("teams") {
            "Microsoft Teams"
        } else if b.contains("webex") || b.contains("cisco") {
            "Webex"
        } else if b.contains("slack") {
            "Slack"
        } else if b.contains("chrome")
            || b.contains("safari")
            || b.contains("edgemac")
            || b.contains("firefox")
            || b.contains("brave")
            || b.contains("thebrowser") // Arc
            || b.contains("opera")
        {
            "a browser meeting"
        } else {
            return None;
        };
        Some(label.to_string())
    }
}

/// Other platforms (Linux): no detection.
#[cfg(not(any(windows, target_os = "macos")))]
pub fn detect_meeting_app() -> Option<String> {
    None
}

/// Apps whose mic use indicates a meeting worth recording (lowercased
/// substrings). Browsers are included because Google Meet / Teams web / Zoom
/// web run in them; the debounce keeps transient browser mic use from firing.
#[cfg(windows)]
const MEETING_APPS: &[&str] = &[
    "teams",
    "msteams",
    "zoom",
    "webex",
    "slack",
    "gotomeeting",
    "bluejeans",
    "ringcentral",
    "whereby",
    "chrome",
    "msedge",
    "firefox",
    "brave",
    "opera",
];

/// Map a mic-using app name to a friendly label, or `None` if it isn't a
/// meeting app.
#[cfg(windows)]
fn classify(app: &str) -> Option<String> {
    let lower = app.to_lowercase();
    // Match the meeting list directly. We deliberately do NOT keep a separate
    // "noise" blocklist checked first: a noise token can be a substring of a
    // real meeting app (e.g. "steam" ⊂ "msteams"), which silently filtered out
    // Microsoft Teams. Non-meeting mic users (Steam, Discord, OBS, dictation
    // tools, …) simply don't match any meeting token and return None here.
    if !MEETING_APPS.iter().any(|m| lower.contains(m)) {
        return None;
    }
    let label = if lower.contains("teams") {
        "Microsoft Teams"
    } else if lower.contains("zoom") {
        "Zoom"
    } else if lower.contains("webex") {
        "Webex"
    } else if lower.contains("slack") {
        "Slack"
    } else if lower.contains("chrome")
        || lower.contains("msedge")
        || lower.contains("firefox")
        || lower.contains("brave")
        || lower.contains("opera")
    {
        "a browser meeting"
    } else {
        "a meeting"
    };
    Some(label.to_string())
}
