//! macOS EventKit calendar reader — zero sign-in, reads from the Mac's
//! Calendar app (iCloud/Google/Exchange).  Feeds the same `CalendarEvent`
//! structs the Google OAuth path uses, so `calendar_upcoming_events` /
//! `calendar_event_at` work unchanged.
//!
//! Entire file is gated behind `#[cfg(target_os = "macos")]` — the
//! EventKit framework only exists on macOS.

#![cfg(target_os = "macos")]

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_event_kit::{EKAuthorizationStatus, EKEntityType, EKEvent, EKEventStore, EKParticipant};
use objc2_foundation::{NSDate, NSURL};

use crate::types::{CalendarAttendee, CalendarEvent};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Create an `NSDate` from a Unix timestamp (seconds since 1970).
fn nsdate_from_secs(secs: f64) -> Retained<NSDate> {
    NSDate::dateWithTimeIntervalSince1970(secs)
}

/// Extract a Unix timestamp from an `NSDate`.
fn nsdate_to_secs(date: &NSDate) -> f64 {
    date.timeIntervalSince1970()
}

/// Open an `EKEventStore` (the gateway to EventKit).
fn store() -> Retained<EKEventStore> {
    unsafe { EKEventStore::new() }
}

/// Check current authorization status without prompting.
fn auth_status() -> EKAuthorizationStatus {
    unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Request full calendar access.  Returns `Ok(true)` if granted / already
/// granted, `Ok(false)` if denied or restricted.  Only shows the macOS
/// permission prompt when the status is `NotDetermined`.
pub fn request_access() -> Result<bool, String> {
    let status = auth_status();
    if status == EKAuthorizationStatus::FullAccess {
        return Ok(true);
    }
    if status == EKAuthorizationStatus::Denied || status == EKAuthorizationStatus::Restricted {
        return Ok(false);
    }
    // NotDetermined — show the permission prompt and block until the
    // user responds.
    let s = store();
    let (tx, rx) = mpsc::channel();
    let completion = RcBlock::new(move |granted: Bool, _err: *mut objc2_foundation::NSError| {
        let _ = tx.send(granted.as_bool());
    });
    let ptr: *mut block2::DynBlock<dyn Fn(Bool, *mut objc2_foundation::NSError)> =
        &*completion as *const _ as *mut _;
    unsafe { s.requestFullAccessToEventsWithCompletion(ptr) };
    let granted = rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false);
    Ok(granted)
}

/// Upcoming events within `[now, now + window_minutes]` from ALL calendars
/// in the Mac's Calendar app.  Returns `Vec<CalendarEvent>` matching the
/// existing B1 shape (provider = `"apple"`).
pub fn upcoming_events(window_minutes: u32) -> Result<Vec<CalendarEvent>, String> {
    // Gate: access must already be granted.
    if auth_status() != EKAuthorizationStatus::FullAccess {
        return Err("Calendar access not granted".to_string());
    }

    let s = store();
    let now = nsdate_from_secs(chrono::Utc::now().timestamp() as f64);
    let end = nsdate_from_secs(
        (chrono::Utc::now() + chrono::Duration::minutes(window_minutes as i64)).timestamp() as f64,
    );

    let predicate =
        unsafe { s.predicateForEventsWithStartDate_endDate_calendars(&now, &end, None) };
    let events = unsafe { s.eventsMatchingPredicate(&predicate) };

    let mut out = Vec::new();
    for event in events.to_vec() {
        if let Some(ce) = map_event(&event) {
            out.push(ce);
        }
    }
    Ok(out)
}

/// Find the single non-all-day event whose [start, end] contains `at`
/// (RFC3339).  Returns `Ok(None)` if no match.  Ignores all-day events.
pub fn event_at(at_rfc3339: &str) -> Result<Option<CalendarEvent>, String> {
    if auth_status() != EKAuthorizationStatus::FullAccess {
        return Err("Calendar access not granted".to_string());
    }

    let at_dt = chrono::DateTime::parse_from_rfc3339(at_rfc3339)
        .map_err(|e| format!("Invalid at time: {e}"))?;
    let at_utc = at_dt.to_utc();

    // Query [at-6h, at+6h] so we catch long meetings.
    let start_dt = at_utc - chrono::Duration::hours(6);
    let end_dt = at_utc + chrono::Duration::hours(6);

    let s = store();
    let start_ns = nsdate_from_secs(start_dt.timestamp() as f64);
    let end_ns = nsdate_from_secs(end_dt.timestamp() as f64);
    let predicate =
        unsafe { s.predicateForEventsWithStartDate_endDate_calendars(&start_ns, &end_ns, None) };
    let events = unsafe { s.eventsMatchingPredicate(&predicate) };

    for event in events.to_vec() {
        // Skip all-day events (they have no meaningful time boundaries).
        if unsafe { event.isAllDay() } {
            continue;
        }
        let ev_start = nsdate_to_secs(unsafe { &event.startDate() });
        let ev_end = nsdate_to_secs(unsafe { &event.endDate() });
        let ev_start_dt = chrono::DateTime::<chrono::Utc>::from_timestamp(
            ev_start as i64,
            ((ev_start - ev_start.floor()) * 1e9) as u32,
        );
        let ev_end_dt = chrono::DateTime::<chrono::Utc>::from_timestamp(
            ev_end as i64,
            ((ev_end - ev_end.floor()) * 1e9) as u32,
        );
        if let (Some(s), Some(e)) = (ev_start_dt, ev_end_dt) {
            if s <= at_utc && at_utc < e {
                return Ok(map_event(&event));
            }
        }
    }

    Ok(None)
}

// ---------------------------------------------------------------------------
// EKEvent → CalendarEvent conversion
// ---------------------------------------------------------------------------

/// Map an `EKEvent` into our shared `CalendarEvent` type.  Returns `None`
/// for events with no title.
fn map_event(event: &EKEvent) -> Option<CalendarEvent> {
    let title = unsafe { event.title() }.to_string();
    if title.trim().is_empty() {
        return None;
    }

    let id = unsafe { event.calendarItemIdentifier() }.to_string();
    let start = rfc3339_from_nsdate(unsafe { &event.startDate() }).unwrap_or_default();
    let end = rfc3339_from_nsdate(unsafe { &event.endDate() }).unwrap_or_default();

    let attendees: Vec<CalendarAttendee> = unsafe { event.attendees() }
        .map(|arr| arr.to_vec().iter().map(|p| map_participant(p)).collect())
        .unwrap_or_default();

    Some(CalendarEvent {
        provider: "apple".to_string(),
        id,
        title,
        start,
        end,
        attendees,
    })
}

/// Convert an `EKParticipant` into our `CalendarAttendee`.  Response status
/// is intentionally left empty (EventKit attendee data is informational).
fn map_participant(p: &EKParticipant) -> CalendarAttendee {
    let name = unsafe { p.name() }
        .map(|n| n.to_string())
        .unwrap_or_default();
    let email = participant_email(p);
    CalendarAttendee {
        name,
        email,
        response_status: String::new(),
        organizer: false,
    }
}

/// Extract the email address from an `EKParticipant`'s `mailto:` URL.
fn participant_email(p: &EKParticipant) -> String {
    let url: Retained<NSURL> = unsafe { p.URL() };
    let raw = url
        .absoluteString()
        .map(|s| s.to_string())
        .unwrap_or_default();
    raw.strip_prefix("mailto:").unwrap_or("").to_string()
}

/// Format an `NSDate` as an RFC 3339 string (UTC).
fn rfc3339_from_nsdate(date: &NSDate) -> Option<String> {
    let secs = nsdate_to_secs(date);
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(
        secs as i64,
        ((secs - secs.floor()) * 1e9) as u32,
    );
    dt.map(|d| d.to_rfc3339())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    #[test]
    fn participant_email_strips_mailto_prefix() {
        // We can't easily create real EKParticipant objects, but we can
        // test the string logic directly.
        let raw = "mailto:alice@example.com".to_string();
        assert_eq!(
            raw.strip_prefix("mailto:").unwrap_or(""),
            "alice@example.com"
        );

        let no_prefix = "https://example.com".to_string();
        assert_eq!(no_prefix.strip_prefix("mailto:").unwrap_or(""), "");
    }
}
