//! Google Calendar API reads — upcoming events, event-at-time lookup.
//!
//! All calls go through `refresh_if_needed()` first so the access token is
//! always fresh.  See SPEC §3 and §5.3.

use crate::calendar::oauth;
use crate::types::{CalendarAttendee, CalendarEvent};

const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3";

/// Fetch upcoming events from the user's primary calendar within
/// `[now, now + window_minutes]`.  Includes attendees.
pub async fn upcoming_events(window_minutes: u32) -> Result<Vec<CalendarEvent>, String> {
    let token = oauth::refresh_if_needed("google").await?;
    let now = chrono::Utc::now();
    let time_min = now.to_rfc3339();
    let time_max = (now + chrono::Duration::minutes(window_minutes as i64)).to_rfc3339();

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{CALENDAR_API}/calendars/primary/events"))
        .bearer_auth(&token)
        .query(&[
            ("timeMin", time_min.as_str()),
            ("timeMax", time_max.as_str()),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
        ])
        .send()
        .await
        .map_err(|e| format!("Calendar API request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Calendar API error: {body}"));
    }

    let data: EventsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse calendar response: {e}"))?;

    Ok(data
        .items
        .unwrap_or_default()
        .into_iter()
        .map(event_to_calendar_event)
        .collect())
}

/// Find the single non-all-day event whose [start, end] contains `at`
/// (RFC3339).  Returns `None` if no matching event is found.  All-day events
/// are ignored; comparisons are done in UTC.
pub async fn event_at(at: &str) -> Result<Option<CalendarEvent>, String> {
    let token = oauth::refresh_if_needed("google").await?;

    let at_dt =
        chrono::DateTime::parse_from_rfc3339(at).map_err(|e| format!("Invalid at time: {e}"))?;

    // Fetch a window around `at` large enough to contain any reasonable meeting.
    let time_min = (at_dt - chrono::Duration::minutes(30)).to_rfc3339();
    let time_max = (at_dt + chrono::Duration::minutes(120)).to_rfc3339();

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{CALENDAR_API}/calendars/primary/events"))
        .bearer_auth(&token)
        .query(&[
            ("timeMin", time_min.as_str()),
            ("timeMax", time_max.as_str()),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
        ])
        .send()
        .await
        .map_err(|e| format!("Calendar API request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Calendar API error: {body}"));
    }

    let data: EventsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse calendar response: {e}"))?;

    let events = data.items.unwrap_or_default();
    let at_utc = at_dt.to_utc();

    // Find the first non-all-day event whose [start, end] contains `at`.
    for raw in &events {
        // Skip all-day events (they have no meaningful time boundaries).
        if is_all_day(raw) {
            continue;
        }
        if let (Some(start), Some(end)) =
            (event_date_time(raw, "start"), event_date_time(raw, "end"))
        {
            if start <= at_utc && at_utc < end {
                return Ok(Some(event_to_calendar_event(raw.clone())));
            }
        }
    }

    Ok(None)
}

// ---------------------------------------------------------------------------
// Deserialisation helpers
// ---------------------------------------------------------------------------

/// Top-level Google Calendar v3 events list response.
#[derive(serde::Deserialize)]
struct EventsResponse {
    #[serde(default)]
    items: Option<Vec<RawEvent>>,
}

/// A single event from the Google Calendar API.
#[derive(Debug, Clone, serde::Deserialize)]
struct RawEvent {
    id: String,
    #[serde(default)]
    summary: String,
    start: Option<EventTime>,
    end: Option<EventTime>,
    #[serde(default)]
    attendees: Option<Vec<RawAttendee>>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct EventTime {
    /// Present for non-all-day events (e.g. "2026-06-20T09:00:00-07:00").
    #[serde(default)]
    date_time: Option<String>,
    /// Present for all-day events (e.g. "2026-06-20").
    #[serde(default)]
    date: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct RawAttendee {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    email: String,
    #[serde(default)]
    response_status: Option<String>,
    #[serde(default)]
    organizer: Option<bool>,
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

fn event_to_calendar_event(raw: RawEvent) -> CalendarEvent {
    CalendarEvent {
        provider: "google".to_string(),
        id: raw.id,
        title: raw.summary,
        start: raw
            .start
            .as_ref()
            .and_then(|s| s.date_time.clone())
            .unwrap_or_default(),
        end: raw
            .end
            .as_ref()
            .and_then(|e| e.date_time.clone())
            .unwrap_or_default(),
        attendees: raw
            .attendees
            .unwrap_or_default()
            .into_iter()
            .map(|a| CalendarAttendee {
                name: a.display_name.unwrap_or_default(),
                email: a.email,
                response_status: a.response_status.unwrap_or_default(),
                organizer: a.organizer.unwrap_or(false),
            })
            .collect(),
    }
}

fn is_all_day(event: &RawEvent) -> bool {
    event
        .start
        .as_ref()
        .map(|s| s.date.is_some())
        .unwrap_or(false)
        || event
            .end
            .as_ref()
            .map(|e| e.date.is_some())
            .unwrap_or(false)
}

fn event_date_time(event: &RawEvent, field: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let time = match field {
        "start" => &event.start,
        "end" => &event.end,
        _ => &None,
    };
    time.as_ref()
        .and_then(|t| t.date_time.as_deref())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.to_utc())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_at_matches_time_window() {
        // Parse a few sample events and verify event_at-style matching logic.
        let raw = RawEvent {
            id: "ev1".into(),
            summary: "Standup".into(),
            start: Some(EventTime {
                date_time: Some("2026-06-20T09:00:00-07:00".into()),
                date: None,
            }),
            end: Some(EventTime {
                date_time: Some("2026-06-20T09:30:00-07:00".into()),
                date: None,
            }),
            attendees: None,
        };

        assert!(!is_all_day(&raw));

        // A time inside the event should match.
        let inside = "2026-06-20T09:10:00-07:00";
        let at_dt = chrono::DateTime::parse_from_rfc3339(inside)
            .unwrap()
            .to_utc();
        let start = event_date_time(&raw, "start").unwrap();
        let end = event_date_time(&raw, "end").unwrap();
        assert!(start <= at_dt && at_dt < end);

        // A time before the event should not match.
        let before = "2026-06-20T08:50:00-07:00";
        let at_dt = chrono::DateTime::parse_from_rfc3339(before)
            .unwrap()
            .to_utc();
        assert!(!(start <= at_dt && at_dt < end));

        // A time after the event should not match.
        let after = "2026-06-20T09:35:00-07:00";
        let at_dt = chrono::DateTime::parse_from_rfc3339(after)
            .unwrap()
            .to_utc();
        assert!(!(start <= at_dt && at_dt < end));
    }

    #[test]
    fn all_day_is_skipped() {
        let raw = RawEvent {
            id: "ev2".into(),
            summary: "Holiday".into(),
            start: Some(EventTime {
                date_time: None,
                date: Some("2026-06-20".into()),
            }),
            end: Some(EventTime {
                date_time: None,
                date: Some("2026-06-21".into()),
            }),
            attendees: None,
        };
        assert!(is_all_day(&raw));
    }
}
