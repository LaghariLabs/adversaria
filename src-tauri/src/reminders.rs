//! To-do alarm digests: an OS notification when due/overdue items need
//! attention. v1 fires at most twice a day while the app runs: once shortly
//! after launch, and once when the clock crosses 09:00 local.

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

/// Whether the current local time is at or past 09:00.
fn past_nine() -> bool {
    chrono::Local::now().time().hour() >= 9
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
/// shortly after launch, and once when the clock crosses 09:00 local.
pub fn spawn(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        eprintln!("[reminders] thread started");

        // 1. Sleep 20 s, then do the launch-time check.
        std::thread::sleep(INITIAL_DELAY);
        let mut last_fired: Option<String> = check_and_notify(&app, None);

        // 2. Loop every 60 s: fire at 09:00 if we haven't yet today.
        loop {
            std::thread::sleep(POLL_INTERVAL);

            if !past_nine() {
                continue;
            }

            let today = today_local();
            if last_fired.as_deref() == Some(&today) {
                continue;
            }

            last_fired = check_and_notify(&app, last_fired.as_deref());
        }
    });
}

/// Load action items, count due/overdue, and fire a notification if needed.
/// Returns `Some(today)` when the check ran after 09:00 (marks the daily
/// digest as done), or the previous `last_fired` when it's before 9am.
fn check_and_notify(app: &tauri::AppHandle, prev: Option<&str>) -> Option<String> {
    let today = today_local();

    let items = match crate::storage::get_action_items(None) {
        Ok(items) => items,
        Err(e) => {
            eprintln!("[reminders] failed to load action items: {e}");
            // If post-9am, mark today as done so we don't retry every 60 s.
            return if past_nine() {
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
            return if past_nine() {
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

    if past_nine() {
        Some(today)
    } else {
        prev.map(|s| s.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::digest_line;

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
