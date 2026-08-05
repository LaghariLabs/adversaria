//! To-do alarm digests: an OS notification when due/overdue items need
//! attention. Fires at most twice a day while the app runs: once shortly after
//! launch, and once when the clock crosses `todo_digest_hour` local (09:00 by
//! default).
//!
//! Gated on `todo_digest_enabled`. Until 2026-08-05 this had no setting at all,
//! so a user who did not want to-do notifications could not stop them. Distinct
//! from `meeting_reminders` (the pre-meeting alert) — one concern per module.

use std::time::Duration;

use chrono::Timelike;
use tauri_plugin_notification::NotificationExt;

/// Seconds to wait after launch before the first check.
const INITIAL_DELAY: Duration = Duration::from_secs(20);
/// Seconds between loop iterations.
const POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Today as a local `YYYY-MM-DD` string.
fn today_local() -> String {
    chrono::Local::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string()
}

/// Whether the current local time is at or past `hour` (0–23).
///
/// Values above 23 would make the digest unreachable, so they clamp to 23.
fn past_hour(hour: u32) -> bool {
    chrono::Local::now().time().hour() >= hour.min(23)
}

/// Build the notification body, or `None` when there's nothing to report.
/// Pluralization is correct for singular vs. plural.
pub fn digest_line(due_today: usize, overdue: usize) -> Option<String> {
    match (due_today, overdue) {
        (0, 0) => None,
        (1, 0) => Some("1 to-do due today.".to_string()),
        (t, 0) => Some(format!("{t} due today. Open To-dos to clear them.")),
        (0, 1) => Some("1 overdue to-do waiting.".to_string()),
        (0, o) => Some(format!("{o} overdue to-dos waiting.")),
        (t, o) => Some(format!(
            "{t} due today · {o} overdue. Open To-dos to clear them."
        )),
    }
}

/// Spawn the background reminder thread. Fires at most twice a day: once
/// shortly after launch, and once when the clock crosses `todo_digest_hour`.
///
/// Config is re-read every iteration (same shape as `meeting_reminders`), so
/// turning the digest off in Settings takes effect without restarting the app.
/// The thread keeps looping while disabled so turning it back on also works.
pub fn spawn(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        eprintln!("[reminders] thread started");

        // 1. Sleep 20 s, then do the launch-time check — if it's wanted.
        std::thread::sleep(INITIAL_DELAY);
        let config = crate::config::load_config();
        let mut last_fired: Option<String> = if config.todo_digest_enabled {
            check_and_notify(&app, None, config.todo_digest_hour)
        } else {
            eprintln!("[reminders] to-do digest is off — skipping the launch check");
            None
        };

        // 2. Loop every 60 s: fire at the configured hour if we haven't yet today.
        loop {
            std::thread::sleep(POLL_INTERVAL);

            let config = crate::config::load_config();
            if !config.todo_digest_enabled {
                continue;
            }
            let hour = config.todo_digest_hour;

            if !past_hour(hour) {
                continue;
            }

            let today = today_local();
            if last_fired.as_deref() == Some(&today) {
                continue;
            }

            last_fired = check_and_notify(&app, last_fired.as_deref(), hour);
        }
    });
}

/// Load action items, count due/overdue, and fire a notification if needed.
/// Returns `Some(today)` when the check ran at or after `hour` (marks the daily
/// digest as done), or the previous `last_fired` when it's earlier than that.
fn check_and_notify(app: &tauri::AppHandle, prev: Option<&str>, hour: u32) -> Option<String> {
    let today = today_local();

    let items = match crate::storage::get_action_items(None) {
        Ok(items) => items,
        Err(e) => {
            eprintln!("[reminders] failed to load action items: {e}");
            // Past the digest hour, mark today done so we don't retry every 60 s.
            return if past_hour(hour) {
                Some(today)
            } else {
                prev.map(|s| s.to_string())
            };
        }
    };

    let overdue = items
        .iter()
        .filter(|it| {
            !it.done
                && it.assignee != "Not mine"
                && !it.due.is_empty()
                && it.due.as_str() < today.as_str()
        })
        .count();

    let due_today = items
        .iter()
        .filter(|it| !it.done && it.assignee != "Not mine" && it.due == today)
        .count();

    let body = match digest_line(due_today, overdue) {
        Some(b) => b,
        None => {
            eprintln!("[reminders] nothing due/overdue ({due_today} due today, {overdue} overdue)");
            return if past_hour(hour) {
                Some(today)
            } else {
                prev.map(|s| s.to_string())
            };
        }
    };

    let title = "Adversaria — to-dos need attention";
    let result = app.notification().builder().title(title).body(&body).show();
    match result {
        Ok(_) => eprintln!("[reminders] notification sent: {body}"),
        Err(e) => eprintln!("[reminders] notification failed: {e}"),
    }

    if past_hour(hour) {
        Some(today)
    } else {
        prev.map(|s| s.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{digest_line, past_hour};

    #[test]
    fn hour_zero_is_always_past() {
        // Midnight means "as soon as the loop runs", whatever the local time is.
        assert!(past_hour(0));
    }

    #[test]
    fn absurd_hour_clamps_instead_of_never_firing() {
        // A config hand-edited to 99 must not silence the digest forever; it
        // clamps to 23, so it still fires in the last hour of the day.
        assert_eq!(past_hour(99), past_hour(23));
    }

    #[test]
    fn default_hour_matches_the_previous_hardcoded_behaviour() {
        // The digest used to compare against a literal 9; the default config
        // hour must reproduce exactly that.
        use chrono::Timelike;
        assert_eq!(past_hour(9), chrono::Local::now().time().hour() >= 9);
    }

    #[test]
    fn nothing_to_report() {
        assert_eq!(digest_line(0, 0), None);
    }

    #[test]
    fn both_due_and_overdue() {
        let body = digest_line(3, 2).unwrap();
        assert!(body.contains("3 due today"));
        assert!(body.contains("2 overdue"));
        assert!(body.contains("·"));
    }

    #[test]
    fn singular_due_today() {
        let body = digest_line(1, 0).unwrap();
        assert_eq!(body, "1 to-do due today.");
    }

    #[test]
    fn singular_overdue() {
        let body = digest_line(0, 1).unwrap();
        assert_eq!(body, "1 overdue to-do waiting.");
    }

    #[test]
    fn plural_due_today_only() {
        let body = digest_line(5, 0).unwrap();
        assert_eq!(body, "5 due today. Open To-dos to clear them.");
    }

    #[test]
    fn plural_overdue_only() {
        let body = digest_line(0, 4).unwrap();
        assert_eq!(body, "4 overdue to-dos waiting.");
    }
}
