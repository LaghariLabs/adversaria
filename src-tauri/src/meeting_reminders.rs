//! Pre-meeting OS notifications: one alert N minutes before a calendar event
//! starts. Distinct from `reminders` (the to-do digest) — one concern per
//! module. Fires at most once per event occurrence, only while
//! `meeting_reminder_enabled` is set, and stays silent when no calendar is
//! connected (`calendar_upcoming_events` simply returns nothing).

use std::collections::HashSet;
use std::time::Duration;

use tauri_plugin_notification::NotificationExt;

use crate::types::CalendarEvent;

/// Seconds between poll iterations. Minute granularity matches the setting.
const POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Fired-key retention guard so a long-running app never grows unbounded.
const MAX_FIRED_KEYS: usize = 512;

/// Stable fire-once key: the same occurrence never notifies twice, while a
/// rescheduled meeting (same id, new start) legitimately notifies again.
fn fired_key(event: &CalendarEvent) -> String {
    format!("{}:{}:{}", event.provider, event.id, event.start)
}

/// Events whose start lies in `(now, now + minutes]` and were not fired yet.
/// Pure, so the windowing logic tests without a calendar or a clock.
pub fn due_now(
    events: &[CalendarEvent],
    now: chrono::DateTime<chrono::Utc>,
    minutes: u32,
    fired: &HashSet<String>,
) -> Vec<CalendarEvent> {
    events
        .iter()
        .filter(|event| {
            let Ok(start) = chrono::DateTime::parse_from_rfc3339(&event.start) else {
                return false;
            };
            let until = start.with_timezone(&chrono::Utc) - now;
            until > chrono::Duration::zero()
                && until <= chrono::Duration::minutes(i64::from(minutes))
                && !fired.contains(&fired_key(event))
        })
        .cloned()
        .collect()
}

/// Notification body, pluralized like the to-do digest's `digest_line`.
pub fn body_line(event: &CalendarEvent, now: chrono::DateTime<chrono::Utc>) -> String {
    let minutes = chrono::DateTime::parse_from_rfc3339(&event.start)
        .map(|start| {
            let seconds = (start.with_timezone(&chrono::Utc) - now)
                .num_seconds()
                .max(0);
            // Ceil so "4 min 30 s away" reads as "in 5 minutes", never "in 4".
            // (Manual: i64::div_ceil is unstable on this toolchain.)
            (seconds + 59) / 60
        })
        .unwrap_or_default();
    if minutes <= 1 {
        format!("{} starts in 1 minute.", event.title)
    } else {
        format!("{} starts in {minutes} minutes.", event.title)
    }
}

/// Spawn the background poll. Async because the Google calendar source is.
pub fn spawn(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        eprintln!("[meeting-reminders] task started");
        let mut fired: HashSet<String> = HashSet::new();
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let config = crate::config::load_config();
            if !config.meeting_reminder_enabled {
                continue;
            }
            let minutes = config.meeting_reminder_minutes.max(1);
            // +1 so an event landing exactly on the window edge between polls
            // is still seen by the fetch; `due_now` enforces the real bound.
            let events = match crate::commands::calendar_upcoming_events(minutes + 1).await {
                Ok(events) => events,
                Err(err) => {
                    eprintln!("[meeting-reminders] calendar fetch failed: {err}");
                    continue;
                }
            };
            let now = chrono::Utc::now();
            for event in due_now(&events, now, minutes, &fired) {
                let shown = app
                    .notification()
                    .builder()
                    .title("Meeting starting soon")
                    .body(body_line(&event, now))
                    .show();
                match shown {
                    Ok(()) => {
                        fired.insert(fired_key(&event));
                    }
                    Err(err) => eprintln!("[meeting-reminders] notify failed: {err}"),
                }
            }
            if fired.len() > MAX_FIRED_KEYS {
                // Old occurrences can never fire again (their start is in the
                // past), so dropping the set only risks a duplicate for events
                // still inside the window — acceptable at this size bound.
                fired.clear();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, start: &str) -> CalendarEvent {
        CalendarEvent {
            provider: "google".to_string(),
            id: id.to_string(),
            title: format!("Meeting {id}"),
            start: start.to_string(),
            end: start.to_string(),
            attendees: Vec::new(),
        }
    }

    fn at(rfc3339: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    #[test]
    fn fires_only_inside_the_lead_window() {
        let now = at("2026-07-28T10:00:00Z");
        let events = vec![
            event("in-window", "2026-07-28T10:04:00Z"),
            event("too-far", "2026-07-28T10:20:00Z"),
            event("already-started", "2026-07-28T09:59:00Z"),
        ];
        let due = due_now(&events, now, 5, &HashSet::new());
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "in-window");
    }

    #[test]
    fn never_fires_twice_for_the_same_occurrence() {
        let now = at("2026-07-28T10:00:00Z");
        let events = vec![event("standup", "2026-07-28T10:03:00Z")];
        let mut fired = HashSet::new();
        fired.insert(fired_key(&events[0]));
        assert!(due_now(&events, now, 5, &fired).is_empty());
    }

    #[test]
    fn a_rescheduled_meeting_fires_again() {
        let now = at("2026-07-28T10:00:00Z");
        let original = event("standup", "2026-07-28T09:30:00Z");
        let mut fired = HashSet::new();
        fired.insert(fired_key(&original));
        let moved = vec![event("standup", "2026-07-28T10:03:00Z")];
        assert_eq!(due_now(&moved, now, 5, &fired).len(), 1);
    }

    #[test]
    fn unparseable_starts_are_skipped_not_fatal() {
        let now = at("2026-07-28T10:00:00Z");
        let events = vec![event("broken", "not-a-timestamp")];
        assert!(due_now(&events, now, 5, &HashSet::new()).is_empty());
    }

    #[test]
    fn body_rounds_up_and_pluralizes() {
        let now = at("2026-07-28T10:00:00Z");
        assert_eq!(
            body_line(&event("a", "2026-07-28T10:04:30Z"), now),
            "Meeting a starts in 5 minutes."
        );
        assert_eq!(
            body_line(&event("b", "2026-07-28T10:00:40Z"), now),
            "Meeting b starts in 1 minute."
        );
    }
}
