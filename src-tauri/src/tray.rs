//! System tray icon, context menu, and global hotkey registration.
//!
//! The tray provides quick access to recording controls and window
//! visibility.  A global hotkey (Ctrl+Shift+M) toggles recording so
//! the user does not need to switch away from their meeting.

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Add the system tray icon with a right-click context menu.
///
/// Menu items:
/// - **Show/Hide** — toggle the main window
/// - **Start/Stop Recording** — emit `tray-toggle-recording` event
/// - **Quit** — exit the application
///
/// Left-clicking the tray icon also toggles window visibility.
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let toggle_item = MenuItemBuilder::with_id("toggle_window", "Show/Hide").build(app)?;
    let start_stop_item =
        MenuItemBuilder::with_id("start_stop", "Start/Stop Recording").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&toggle_item)
        .item(&start_stop_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Meeting Note Taker")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle_window" => {
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(false);
                    if visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            "start_stop" => {
                let _ = app.emit("tray-toggle-recording", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(false);
                    if visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Register the recording-toggle global hotkey: **Cmd+Shift+M** on macOS,
/// **Ctrl+Shift+M** elsewhere.
///
/// When pressed the backend emits `hotkey-toggle-recording` — the
/// frontend listens for this event and starts/stops accordingly.
///
/// Registration failure is non-fatal: the tray menu remains the
/// primary toggle; the hotkey is a convenience.
pub fn setup_hotkeys<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // SUPER is the Command (⌘) key on macOS.
    #[cfg(target_os = "macos")]
    let (modifiers, label) = (Modifiers::SUPER | Modifiers::SHIFT, "Cmd+Shift+M");
    #[cfg(not(target_os = "macos"))]
    let (modifiers, label) = (Modifiers::CONTROL | Modifiers::SHIFT, "Ctrl+Shift+M");

    let shortcut = Shortcut::new(Some(modifiers), Code::KeyM);

    // on_shortcut registers the accelerator AND attaches the handler in one
    // call. Do not call register() first: the OS rejects a same-process
    // duplicate registration (macOS eventHotKeyExistsErr), so on_shortcut
    // would fail and the handler would silently never be attached.
    // The handler fires on both key-down and key-up; only act on the press.
    let handle = app.clone();
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = handle.emit("hotkey-toggle-recording", ());
            }
        })
    {
        eprintln!(
            "[hotkey] Could not register {label}. \
             Use the tray menu to toggle recording. ({e:?})"
        );
    }

    // Quick-capture note hotkey (Cmd/Ctrl+Shift+N) removed with the standalone
    // notes hide, 2026-07-18 — a global shortcut that steals focus with no
    // handler would be worse than none. Restore alongside NewNoteButton.

    Ok(())
}
