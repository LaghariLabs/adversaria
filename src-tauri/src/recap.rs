//! On-demand weekly recap — the cross-meeting "recap" Ask intent.
//!
//! Aggregates a Mon–Sun week from the meetings + action items already in memory
//! (no LLM call, no stored artifact). Deliberately mirrors the frontend
//! `WeeklyView.tsx` so the numbers an Ask "summarize my week" returns match the
//! Weekly tab: Monday-start week, decisions/topics pulled from each meeting's
//! summary sections, action-item counts from the DB.

use crate::types::{ActionItem, Meeting, MeetingRef};
use chrono::{DateTime, Datelike, Duration, Local, Utc};

/// The aggregated recap for one week.
pub struct RecapDigest {
    pub period_label: String,
    pub meeting_count: usize,
    pub total_minutes: i64,
    /// "bullet text (Meeting Title)" entries.
    pub decisions: Vec<String>,
    pub topics: Vec<String>,
    pub actions_total: usize,
    pub actions_done: usize,
    pub sources: Vec<MeetingRef>,
}

/// `[Monday 00:00, next Monday 00:00)` for the week `offset_weeks` from now, in
/// local time, returned as UTC instants (mirrors `WeeklyView.startOfWeek`).
pub fn week_window(offset_weeks: i64) -> (DateTime<Utc>, DateTime<Utc>) {
    let now = Local::now();
    let since_monday = now.weekday().num_days_from_monday() as i64; // Mon = 0
    let monday = (now - Duration::days(since_monday) + Duration::weeks(offset_weeks)).date_naive();
    let start = monday
        .and_hms_opt(0, 0, 0)
        .expect("midnight is valid")
        .and_local_timezone(Local)
        .earliest()
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);
    (start, start + Duration::weeks(1))
}

/// Compute the recap for the week `offset_weeks` from now (0 = this week).
pub fn compute(meetings: &[Meeting], items: &[ActionItem], offset_weeks: i64) -> RecapDigest {
    let (start, end) = week_window(offset_weeks);
    let label = match offset_weeks {
        0 => "this week",
        -1 => "last week",
        _ => "that week",
    };
    compute_in_window(meetings, items, start, end, label)
}

/// Pure core (explicit window) — unit-testable without a clock dependency.
fn compute_in_window(
    meetings: &[Meeting],
    items: &[ActionItem],
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    label: &str,
) -> RecapDigest {
    let in_window = |rfc: &str| {
        DateTime::parse_from_rfc3339(rfc)
            .map(|dt| {
                let u = dt.with_timezone(&Utc);
                u >= start && u < end
            })
            .unwrap_or(false)
    };
    let week_meetings: Vec<&Meeting> = meetings
        .iter()
        .filter(|m| in_window(&m.recorded_at))
        .collect();
    let week_ids: std::collections::HashSet<i64> = week_meetings.iter().map(|m| m.id).collect();
    let week_actions: Vec<&ActionItem> = items
        .iter()
        .filter(|a| week_ids.contains(&a.meeting_id))
        .collect();
    let actions_done = week_actions.iter().filter(|a| a.done).count();
    let total_seconds: f64 = week_meetings.iter().map(|m| m.duration_seconds).sum();

    // Heading classifiers mirror WeeklyView.tsx (incl. Arabic); section parsing
    // mirrors storage::extract_action_items (`**Heading**` + `- bullet`).
    let dec_re = regex::Regex::new(r"(?i)(decision|agreement|قرار|الاتفاق|الاتفاقيات)").unwrap();
    let top_re =
        regex::Regex::new(r"(?i)(key topic|discussion|topic|المواضيع|النقاط|المناقشة|مواضيع)")
            .unwrap();
    let heading_re = regex::Regex::new(r"^\*\*(.+?)\*\*:?$").unwrap();
    let bullet_re = regex::Regex::new(r"^[-*•]\s+(.*)$").unwrap();

    let mut decisions = Vec::new();
    let mut topics = Vec::new();
    for m in &week_meetings {
        let mut bucket = 0u8; // 0 = neither, 1 = decision, 2 = topic
        for line in m.summary.lines() {
            let t = line.trim();
            if let Some(c) = heading_re.captures(t) {
                let h = c[1].trim_end_matches(':').trim();
                bucket = if dec_re.is_match(h) {
                    1
                } else if top_re.is_match(h) {
                    2
                } else {
                    0
                };
            } else if bucket != 0 {
                if let Some(c) = bullet_re.captures(t) {
                    let b = c[1].trim();
                    if is_placeholder_bullet(b) {
                        continue;
                    }
                    let entry = format!("{b} ({})", m.title);
                    if bucket == 1 {
                        decisions.push(entry);
                    } else {
                        topics.push(entry);
                    }
                }
            }
        }
    }

    RecapDigest {
        period_label: label.to_string(),
        meeting_count: week_meetings.len(),
        total_minutes: (total_seconds / 60.0).round() as i64,
        decisions,
        topics,
        actions_total: week_actions.len(),
        actions_done,
        sources: week_meetings
            .iter()
            .map(|m| MeetingRef {
                id: m.id,
                title: m.title.clone(),
            })
            .collect(),
    }
}

/// Skip "None mentioned"/"None"/Arabic-none placeholder bullets (mirrors
/// `lib/summary.isPlaceholderBullet`).
fn is_placeholder_bullet(b: &str) -> bool {
    let l = b.trim().to_lowercase();
    l.is_empty()
        || l == "none"
        || l == "n/a"
        || l == "na"
        || l == "-"
        || l == "—"
        || l.starts_with("none ")
        || b.contains("لا يوجد")
}

/// Render the digest as the grounded markdown answer for the Ask thread.
pub fn to_markdown(d: &RecapDigest) -> String {
    if d.meeting_count == 0 {
        return format!("You had no meetings {}.", d.period_label);
    }
    let mut s = format!(
        "**{} meeting{} · {} min recorded · {}/{} action items done** ({}).\n\n",
        d.meeting_count,
        if d.meeting_count == 1 { "" } else { "s" },
        d.total_minutes,
        d.actions_done,
        d.actions_total,
        d.period_label
    );
    s.push_str("**Decisions**\n");
    if d.decisions.is_empty() {
        s.push_str("- None this week\n");
    } else {
        for x in &d.decisions {
            s.push_str(&format!("- {x}\n"));
        }
    }
    s.push_str("\n**Key topics**\n");
    if d.topics.is_empty() {
        s.push_str("- None this week\n");
    } else {
        for x in &d.topics {
            s.push_str(&format!("- {x}\n"));
        }
    }
    s.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Tag;

    fn meeting(id: i64, recorded_at: &str, summary: &str, dur: f64) -> Meeting {
        Meeting {
            id,
            title: format!("Meeting {id}"),
            recorded_at: recorded_at.to_string(),
            duration_seconds: dur,
            transcript: String::new(),
            summary: summary.to_string(),
            template_used: String::new(),
            audio_file_path: None,
            attendees: vec![],
            user_notes: String::new(),
            link: String::new(),
            tags: Vec::<Tag>::new(),
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: vec![],
        }
    }
    fn action(meeting_id: i64, done: bool) -> ActionItem {
        ActionItem {
            id: 0,
            meeting_id,
            ord: 0,
            text: "t".into(),
            assignee: String::new(),
            due: String::new(),
            done,
            status: "todo".to_string(),
            completed_by: String::new(),
            completed_at: String::new(),
            evidence: String::new(),
        }
    }

    #[test]
    fn aggregates_only_in_window_and_classifies_sections() {
        let start = DateTime::parse_from_rfc3339("2026-06-22T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let end = start + Duration::weeks(1);
        let meetings = vec![
            meeting(
                1,
                "2026-06-23T10:00:00Z", // in window
                "**Decisions Made**\n- Ship v1\n- None\n**Key Topics Discussed**\n- Pricing",
                600.0,
            ),
            meeting(
                2,
                "2026-06-20T10:00:00Z", // before window — excluded
                "**Decisions Made**\n- Old decision",
                300.0,
            ),
        ];
        let items = vec![action(1, true), action(1, false), action(2, false)];
        let d = compute_in_window(&meetings, &items, start, end, "this week");
        assert_eq!(d.meeting_count, 1); // only meeting 1
        assert_eq!(d.total_minutes, 10);
        assert_eq!(d.decisions.len(), 1); // "Ship v1" (placeholder "None" skipped)
        assert_eq!(d.topics.len(), 1); // "Pricing"
        assert_eq!(d.actions_total, 2); // only meeting 1's items
        assert_eq!(d.actions_done, 1);
        assert!(d.decisions[0].contains("Ship v1"));
    }

    #[test]
    fn empty_week_renders_friendly() {
        let start = DateTime::parse_from_rfc3339("2026-01-05T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let end = start + Duration::weeks(1);
        let d = compute_in_window(&[], &[], start, end, "this week");
        assert_eq!(d.meeting_count, 0);
        assert_eq!(to_markdown(&d), "You had no meetings this week.");
    }
}
