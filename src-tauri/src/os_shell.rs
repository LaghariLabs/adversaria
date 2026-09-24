//! Hand a file, folder, or URL to the operating system.
//!
//! Every "open this in the default app / browser / file manager" call goes
//! through here so each platform's quirks are handled once:
//!
//! - macOS: `open` (and `open -R` to reveal).
//! - Windows: `rundll32 url.dll,FileProtocolHandler`, not `cmd /c start`.
//!   cmd.exe treats `&` as a command separator, so an OAuth URL passed to
//!   `start` was cut at its first query parameter, and cmd flashes a console
//!   window. rundll32 is a GUI-subsystem program and takes the target as one
//!   argument. Reveal uses `explorer /select,"<path>"` with backslashes:
//!   Explorer ignores forward-slash paths and its `/select,` switch does not
//!   follow the standard quoting rules, so the argument is passed raw.
//! - Anything else: `xdg-open`.

use std::io;
use std::process::{Child, Command};

/// Stop a console program spawned by this GUI app from flashing a console
/// window on Windows. A no-op elsewhere.
pub fn hide_console(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Find a command-line tool the way a Windows shell would.
///
/// `Command::new("codex")` on Windows only finds `codex.exe`, but npm installs
/// global CLIs as `codex.cmd` shims, so the tool looked missing. Search PATH for
/// the `.exe`, then the `.cmd`, and fall back to the bare name (which keeps the
/// usual "not found" error). Elsewhere the bare name is already right.
pub fn resolve_cli(bin: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                for ext in ["exe", "cmd"] {
                    let candidate = dir.join(format!("{bin}.{ext}"));
                    if candidate.is_file() {
                        return candidate;
                    }
                }
            }
        }
    }
    std::path::PathBuf::from(bin)
}

/// Where a small always-on-top window sits inside a monitor's work area.
#[derive(Debug, Clone, Copy)]
pub enum Anchor {
    /// Horizontally centered, `top` logical px below the work area's top edge.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    TopCenter { top: f64 },
    /// `margin` logical px in from the work area's bottom-right corner.
    BottomRight { margin: f64 },
}

/// Physical top-left position for a `size` (logical px) window in `area`.
///
/// Uses the work area (the monitor minus taskbar / Dock / menu bar) rather
/// than the full monitor, so a window never lands under a taskbar docked to
/// any edge, and physical coordinates so a monitor to the left of the primary
/// (negative origin) and fractional display scaling both place correctly.
pub fn place_in_work_area(
    area: &tauri::PhysicalRect<i32, u32>,
    scale: f64,
    size: (f64, f64),
    anchor: Anchor,
) -> (i32, i32) {
    place(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        scale,
        size,
        anchor,
    )
}

fn place(
    origin: (i32, i32),
    area: (u32, u32),
    scale: f64,
    size: (f64, f64),
    anchor: Anchor,
) -> (i32, i32) {
    let (ox, oy) = (origin.0 as f64, origin.1 as f64);
    let (aw, ah) = (area.0 as f64, area.1 as f64);
    let (w, h) = (size.0 * scale, size.1 * scale);
    let (x, y) = match anchor {
        Anchor::TopCenter { top } => (ox + (aw - w) / 2.0, oy + top * scale),
        Anchor::BottomRight { margin } => {
            (ox + aw - w - margin * scale, oy + ah - h - margin * scale)
        }
    };
    (x.round() as i32, y.round() as i32)
}

/// Open a file, folder, or URL with its default handler.
pub fn open_default(target: &str) -> io::Result<Child> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(target).spawn()
    }
    #[cfg(windows)]
    {
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(target)
            .spawn()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Command::new("xdg-open").arg(target).spawn()
    }
}

/// Show a file selected in the platform file manager.
pub fn reveal(path: &str) -> io::Result<Child> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(path).spawn()
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("explorer.exe")
            .raw_arg(explorer_select_arg(path))
            .spawn()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let parent = std::path::Path::new(path)
            .parent()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
        Command::new("xdg-open").arg(parent).spawn()
    }
}

/// `/select,"C:\dir\file.md"` — Explorer's own syntax for "open the folder and
/// select this item". Forward slashes are normalized because Explorer silently
/// falls back to opening Documents when given them.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn explorer_select_arg(path: &str) -> String {
    format!("/select,\"{}\"", path.replace('/', "\\"))
}

#[cfg(test)]
mod tests {
    use super::{explorer_select_arg, place, Anchor};

    #[test]
    fn bottom_right_clears_a_bottom_taskbar() {
        // 1920x1080 at 100%, taskbar 48px at the bottom -> work area 1920x1032.
        let (x, y) = place(
            (0, 0),
            (1920, 1032),
            1.0,
            (360.0, 112.0),
            Anchor::BottomRight { margin: 16.0 },
        );
        assert_eq!((x, y), (1920 - 360 - 16, 1032 - 112 - 16));
    }

    #[test]
    fn bottom_right_follows_a_left_monitor_and_scaling() {
        // Secondary monitor left of the primary, 150% scaling, taskbar on the
        // right edge (work area narrower than the monitor).
        let (x, y) = place(
            (-2560, 0),
            (2500, 1440),
            1.5,
            (360.0, 112.0),
            Anchor::BottomRight { margin: 16.0 },
        );
        assert_eq!(x, -2560 + 2500 - 540 - 24);
        assert_eq!(y, 1440 - 168 - 24);
    }

    #[test]
    fn top_center_sits_below_a_top_taskbar() {
        // Taskbar docked to the top: the work area starts at y=48.
        let (x, y) = place(
            (0, 48),
            (1920, 1032),
            1.0,
            (210.0, 30.0),
            Anchor::TopCenter { top: 8.0 },
        );
        assert_eq!((x, y), ((1920 - 210) / 2, 56));
    }

    #[test]
    fn explorer_select_arg_quotes_and_normalizes_slashes() {
        assert_eq!(
            explorer_select_arg("C:/Users/Ada Lovelace/run 1/draft.md"),
            r#"/select,"C:\Users\Ada Lovelace\run 1\draft.md""#
        );
        assert_eq!(
            explorer_select_arg(r"C:\a\b.txt"),
            r#"/select,"C:\a\b.txt""#
        );
    }
}
