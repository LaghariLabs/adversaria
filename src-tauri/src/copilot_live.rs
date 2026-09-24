//! Pure live extraction scheduling and founder review state.

use std::time::{Duration, Instant};

use crate::types::{
    LiveExtractRequest, LiveExtractResponse, LiveItem, LiveItemIn, LiveReviewEvent, LiveState,
    LiveSummary, LiveTurn,
};

const FIRST_MIN_SECS: u64 = 30;
const FIRST_MIN_WORDS: usize = 40;
const NEXT_MIN_SECS: u64 = 30;
const NEXT_MIN_WORDS: usize = 40;
const MAX_REQUEST_DURATION_MS: u64 = 60_000;
const MAX_REQUEST_CHARS: usize = 4_000;
const OVERLAP_MS: u64 = 15_000;

#[derive(Clone)]
pub struct LiveTurnBuf {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub source: &'static str,
    pub text: String,
    pub words: usize,
}

#[derive(Clone)]
pub struct LiveCtl {
    pub enabled: bool,
    pub status: String,
    pub reason: Option<String>,
    pub revision: u64,
    pub extract_seq: u64,
    pub through_ms: u64,
    pub turns: Vec<LiveTurnBuf>,
    pub next_turn_seq: u64,
    pub covered_upto_idx: usize,
    pub last_extract_started: Option<Instant>,
    pub last_summary_words: usize,
    pub last_summary_at: Option<Instant>,
    pub words_since_summary: usize,
    pub consecutive_errors: u32,
    pub backoff_until: Option<Instant>,
    pub summary: LiveSummary,
    pub items: Vec<LiveItem>,
    // Item revisions snapshotted when the in-flight request was built, so a
    // retraction can only mutate items the request actually saw, unchanged since.
    pub in_flight_revisions: Vec<(String, u64)>,
    // Needed for the first 30/120-second thresholds before either clock exists.
    pub started_at: Instant,
}

impl Default for LiveCtl {
    fn default() -> Self {
        Self {
            enabled: false,
            status: "off".into(),
            reason: None,
            revision: 0,
            extract_seq: 0,
            through_ms: 0,
            turns: Vec::new(),
            next_turn_seq: 1,
            covered_upto_idx: 0,
            last_extract_started: None,
            last_summary_words: 0,
            last_summary_at: None,
            words_since_summary: 0,
            consecutive_errors: 0,
            backoff_until: None,
            summary: LiveSummary::default(),
            items: Vec::new(),
            in_flight_revisions: Vec::new(),
            started_at: Instant::now(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Skip(&'static str),
    Busy,
    Run { update_summary: bool },
}

pub fn start_extraction(ctl: &mut LiveCtl, now: Instant) -> u64 {
    ctl.extract_seq += 1;
    ctl.last_extract_started = Some(now);
    ctl.extract_seq
}

pub fn push_turn(ctl: &mut LiveCtl, source: &'static str, text: &str, now_ms: u64) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let start_ms = ctl.turns.last().map_or(0, |turn| turn.end_ms);
    let words = text.split_whitespace().count();
    ctl.turns.push(LiveTurnBuf {
        id: format!("t{}", ctl.next_turn_seq),
        start_ms,
        end_ms: now_ms.max(start_ms),
        source,
        text: text.into(),
        words,
    });
    ctl.next_turn_seq += 1;
    ctl.words_since_summary += words;
}

pub fn uncovered_words(ctl: &LiveCtl) -> usize {
    ctl.turns[ctl.covered_upto_idx..]
        .iter()
        .map(|turn| turn.words)
        .sum()
}

fn extraction_thresholds(ctl: &LiveCtl) -> (u64, usize) {
    if ctl.last_extract_started.is_none() {
        (FIRST_MIN_SECS, FIRST_MIN_WORDS)
    } else {
        (NEXT_MIN_SECS, NEXT_MIN_WORDS)
    }
}

impl Decision {
    pub fn log_reason(self, ctl: &LiveCtl) -> String {
        match self {
            Self::Skip("words") => format!(
                "words:{}/{}",
                uncovered_words(ctl),
                extraction_thresholds(ctl).1
            ),
            Self::Skip(reason) => reason.into(),
            Self::Busy => "answer_busy".into(),
            Self::Run { .. } => "run".into(),
        }
    }
}

pub fn should_extract(
    ctl: &LiveCtl,
    now: Instant,
    answer_busy: bool,
    last_answer_finished: Option<Instant>,
) -> Decision {
    if !ctl.enabled {
        return Decision::Skip("disabled");
    }
    if answer_busy {
        return Decision::Busy;
    }
    if ctl.status == "updating" {
        return Decision::Skip("error:extraction_still_updating");
    }
    if ctl.backoff_until.is_some_and(|until| now < until) {
        return Decision::Skip("backoff");
    }
    let (min_secs, min_words) = extraction_thresholds(ctl);
    if now.saturating_duration_since(ctl.last_extract_started.unwrap_or(ctl.started_at))
        < Duration::from_secs(min_secs)
    {
        return Decision::Skip(if ctl.last_extract_started.is_none() {
            "first_wait"
        } else {
            "cooldown"
        });
    }
    if uncovered_words(ctl) < min_words {
        return Decision::Skip("words");
    }
    if last_answer_finished
        .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(3))
    {
        return Decision::Skip("cooldown");
    }
    Decision::Run {
        update_summary: ctl.words_since_summary >= 200
            && now.saturating_duration_since(ctl.last_summary_at.unwrap_or(ctl.started_at))
                >= Duration::from_secs(120),
    }
}

pub fn build_request(
    ctl: &mut LiveCtl,
    session_id: &str,
    model: &str,
    request_id: &str,
    update_summary: bool,
) -> (LiveExtractRequest, usize) {
    let start = ctl.covered_upto_idx;
    let mut end = start;
    let mut duration = 0;
    let mut chars = 0;
    for turn in &ctl.turns[start..] {
        let next_duration = duration + turn.end_ms.saturating_sub(turn.start_ms);
        let next_chars = chars + turn.text.chars().count();
        // Turns are indivisible evidence. Always send the first pending turn so
        // an unusually long boundary cannot permanently block the queue.
        if end > start
            && (next_duration > MAX_REQUEST_DURATION_MS || next_chars > MAX_REQUEST_CHARS)
        {
            break;
        }
        duration = next_duration;
        chars = next_chars;
        end += 1;
    }
    let overlap_start = ctl.turns.get(start).map_or(start, |first| {
        let cutoff = first.start_ms.saturating_sub(OVERLAP_MS);
        ctl.turns[..start]
            .iter()
            .position(|turn| turn.end_ms >= cutoff)
            .unwrap_or(start)
    });
    let turns = ctl.turns[overlap_start..end]
        .iter()
        .map(|turn| LiveTurn {
            id: turn.id.clone(),
            start_ms: turn.start_ms,
            end_ms: turn.end_ms,
            source: turn.source.into(),
            text: turn.text.clone(),
        })
        .collect();
    let items = ctl
        .items
        .iter()
        .filter(|item| matches!(item.status.as_str(), "proposed" | "accepted"))
        .map(|item| LiveItemIn {
            id: item.id.clone(),
            kind: item.kind.clone(),
            text: item.text.clone(),
            owner: item.owner.clone(),
            due: item.due.clone(),
            status: item.status.clone(),
            evidence_turn_ids: item.evidence_turn_ids.clone(),
        })
        .collect();
    // The 15 s overlap turns are context, not new evidence. Snapshot every
    // sent item's revision so retractions can only mutate items the model saw,
    // unchanged since the request was built.
    let new_turn_ids = ctl.turns[start..end]
        .iter()
        .map(|turn| turn.id.clone())
        .collect();
    ctl.in_flight_revisions = ctl
        .items
        .iter()
        .filter(|item| matches!(item.status.as_str(), "proposed" | "accepted"))
        .map(|item| (item.id.clone(), item.revision))
        .collect();
    (
        LiveExtractRequest {
            request_id: request_id.into(),
            session_id: session_id.into(),
            base_revision: ctl.revision,
            model: model.into(),
            // Must equal the Python COPILOT_NUM_CTX: Ollama reloads the model when num_ctx changes.
            num_ctx: 16384,
            update_summary,
            turns,
            items,
            new_turn_ids,
            summary: ctl.summary.clone(),
        },
        end,
    )
}

pub fn set_status(ctl: &mut LiveCtl, status: &str, reason: Option<String>) -> bool {
    if ctl.status == status && ctl.reason == reason {
        return false;
    }
    ctl.status = status.into();
    ctl.reason = reason;
    ctl.revision += 1;
    true
}

fn valid_evidence(ctl: &LiveCtl, ids: &[String]) -> bool {
    !ids.is_empty()
        && ids
            .iter()
            .all(|id| ctl.turns.iter().any(|turn| &turn.id == id))
}

/// Validate against the actual request, which can be a strict subset of the
/// session buffer. Malformed envelopes fail without advancing coverage.
pub fn validate_response(
    resp: &mut LiveExtractResponse,
    req: &LiveExtractRequest,
    through_ms: u64,
) -> Result<(), String> {
    // Revision is diagnostic metadata; extraction generations guard stale results.
    if resp.request_id != req.request_id || resp.session_id != req.session_id {
        return Err("Live capture returned a mismatched response".into());
    }
    if resp.status == "error" {
        return Ok(());
    }
    if resp.status != "ok"
        || !resp.through_ms.is_some_and(|through| {
            through > through_ms && req.turns.iter().any(|turn| turn.end_ms == through)
        })
    {
        return Err("Live capture returned invalid coverage".into());
    }
    let valid = |ids: &[String]| {
        !ids.is_empty()
            && ids
                .iter()
                .all(|id| req.turns.iter().any(|turn| &turn.id == id))
    };
    resp.upserts.retain(|item| valid(&item.evidence_turn_ids));
    resp.retractions
        .retain(|item| valid(&item.evidence_turn_ids));
    if resp.summary.as_ref().is_some_and(|summary| {
        !req.update_summary
            || (!summary.bullets.is_empty() && !valid(&summary.evidence_turn_ids))
            || summary
                .evidence_turn_ids
                .iter()
                .any(|id| !req.turns.iter().any(|t| &t.id == id))
            || summary.bullets.len() > 4
            || summary
                .bullets
                .iter()
                .any(|bullet| bullet.split_whitespace().count() > 20)
    }) {
        resp.summary = None;
    }
    Ok(())
}

pub fn apply_response(
    ctl: &mut LiveCtl,
    resp: &LiveExtractResponse,
    now: Instant,
    new_covered_idx: usize,
    card_questions: &[String],
) -> bool {
    if resp.status != "ok" {
        ctl.consecutive_errors += 1;
        ctl.backoff_until =
            Some(now + Duration::from_secs(if ctl.consecutive_errors >= 3 { 180 } else { 60 }));
        ctl.status = "error".into();
        ctl.reason = Some(
            resp.reason
                .clone()
                .unwrap_or_else(|| "Live capture could not update".into()),
        );
        ctl.revision += 1;
        return true;
    }
    let Some(through) = resp.through_ms else {
        return false;
    };
    let before = snapshot(ctl, "");
    let card_questions: Vec<_> = card_questions
        .iter()
        .map(|question| {
            (
                crate::copilot_session::CopilotSession::norm(question),
                crate::copilot::extract_keywords(question),
            )
        })
        .collect();
    let withdrawn_at = chrono::Utc::now().to_rfc3339();
    // Turns newly uncovered by this batch. The 15 s overlap turns are context
    // and never authorize a withdrawal on their own.
    let new_turn_ids: std::collections::HashSet<&str> = ctl.turns
        [ctl.covered_upto_idx..new_covered_idx.min(ctl.turns.len())]
        .iter()
        .map(|turn| turn.id.as_str())
        .collect();
    let reason_ok = |reason: &str| matches!(reason, "explicit_withdrawal" | "explicit_replacement");

    // Classify upserts against the pre-application state so replacement
    // atomicity and the update loophole share one source of truth.
    enum UpsertKind {
        New,
        OrdinaryUpdate,
        ReplacementUpdate,
        Ignored,
    }
    let kinds: Vec<UpsertKind> = resp
        .upserts
        .iter()
        .map(|upsert| {
            if !valid_evidence(ctl, &upsert.evidence_turn_ids)
                || !matches!(upsert.kind.as_str(), "decision" | "action" | "question")
                || upsert.text.trim().is_empty()
            {
                return UpsertKind::Ignored;
            }
            let normalized = crate::copilot_session::CopilotSession::norm(&upsert.text);
            if ctl.items.iter().any(|item| {
                item.status == "dismissed"
                    && crate::copilot_session::CopilotSession::norm(&item.text) == normalized
            }) {
                return UpsertKind::Ignored;
            }
            if upsert.kind == "question" {
                let keywords = crate::copilot::extract_keywords(&upsert.text);
                if card_questions.iter().any(|(question, card_keywords)| {
                    question == &normalized
                        || crate::copilot::keyword_jaccard(&keywords, card_keywords) >= 0.6
                }) {
                    return UpsertKind::Ignored;
                }
            }
            match &upsert.id {
                None => UpsertKind::New,
                Some(id) => match ctl
                    .items
                    .iter()
                    .find(|item| item.id == *id && item.status == "proposed")
                {
                    Some(item)
                        if crate::copilot_session::CopilotSession::norm(&item.text)
                            != normalized =>
                    {
                        UpsertKind::ReplacementUpdate
                    }
                    Some(_) => UpsertKind::OrdinaryUpdate,
                    None => UpsertKind::Ignored,
                },
            }
        })
        .collect();

    // Decide each retraction before mutating anything.
    let retraction_applies: Vec<bool> = resp
        .retractions
        .iter()
        .map(|retraction| {
            let target_ok = ctl.items.iter().any(|item| {
                item.id == retraction.id
                    && item.status == "proposed"
                    && ctl
                        .in_flight_revisions
                        .iter()
                        .any(|(id, revision)| id == &item.id && *revision == item.revision)
            });
            if !target_ok
                || !reason_ok(&retraction.reason_code)
                || retraction.withdrawal_quote.trim().is_empty()
                || !valid_evidence(ctl, &retraction.evidence_turn_ids)
                || !retraction
                    .evidence_turn_ids
                    .iter()
                    .any(|id| new_turn_ids.contains(id.as_str()))
            {
                return false;
            }
            // A replacement is atomic: it needs a live new upsert superseding
            // the target. A dropped upsert keeps the old item.
            if retraction.reason_code == "explicit_replacement" {
                resp.upserts.iter().zip(&kinds).any(|(upsert, kind)| {
                    upsert.supersedes_id.as_deref() == Some(retraction.id.as_str())
                        && matches!(kind, UpsertKind::New)
                })
            } else {
                true
            }
        })
        .collect();

    for (upsert, kind) in resp.upserts.iter().zip(&kinds) {
        match kind {
            UpsertKind::Ignored | UpsertKind::ReplacementUpdate => continue,
            UpsertKind::New | UpsertKind::OrdinaryUpdate => {}
        }
        let at_ms = ctl
            .turns
            .iter()
            .filter(|turn| upsert.evidence_turn_ids.contains(&turn.id))
            .map(|turn| turn.start_ms)
            .min()
            .unwrap_or(0);
        if let Some(id) = &upsert.id {
            let Some(item) = ctl
                .items
                .iter_mut()
                .find(|item| &item.id == id && item.status == "proposed")
            else {
                continue;
            };
            item.owner = upsert.owner.clone();
            item.due = upsert.due.clone();
            item.evidence_turn_ids = upsert.evidence_turn_ids.clone();
            item.at_ms = at_ms;
            item.revision += 1;
        } else {
            ctl.items.push(LiveItem {
                id: format!("li_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
                kind: upsert.kind.clone(),
                text: upsert.text.clone(),
                original_text: upsert.text.clone(),
                owner: upsert.owner.clone(),
                due: upsert.due.clone(),
                status: "proposed".into(),
                revision: 1,
                evidence_turn_ids: upsert.evidence_turn_ids.clone(),
                at_ms,
                review_events: Vec::new(),
                withdrawal_quote: None,
                withdrawn_at: None,
            });
        }
    }
    for (retraction, applies) in resp.retractions.iter().zip(&retraction_applies) {
        if !applies {
            continue;
        }
        if let Some(item) = ctl
            .items
            .iter_mut()
            .find(|item| item.id == retraction.id && item.status == "proposed")
        {
            item.status = "retracted".into();
            item.withdrawal_quote = Some(retraction.withdrawal_quote.clone());
            item.withdrawn_at = Some(withdrawn_at.clone());
            item.revision += 1;
        }
    }
    ctl.through_ms = through;
    ctl.covered_upto_idx = ctl.turns[..new_covered_idx.min(ctl.turns.len())]
        .iter()
        .take_while(|turn| turn.end_ms <= through)
        .count()
        .max(ctl.covered_upto_idx);
    if let Some(summary) = &resp.summary {
        if summary.bullets.len() <= 4
            && summary
                .bullets
                .iter()
                .all(|bullet| bullet.split_whitespace().count() <= 20)
            && (summary.bullets.is_empty() || valid_evidence(ctl, &summary.evidence_turn_ids))
            && summary
                .evidence_turn_ids
                .iter()
                .all(|id| ctl.turns.iter().any(|turn| &turn.id == id))
        {
            ctl.summary = summary.clone();
            ctl.last_summary_at = Some(now);
            ctl.last_summary_words = ctl.turns[..ctl.covered_upto_idx]
                .iter()
                .map(|turn| turn.words)
                .sum();
            ctl.words_since_summary = ctl.turns[ctl.covered_upto_idx..]
                .iter()
                .map(|turn| turn.words)
                .sum();
        }
    }
    ctl.consecutive_errors = 0;
    ctl.backoff_until = None;
    ctl.status = if ctl.enabled { "idle" } else { "off" }.into();
    ctl.reason = None;
    let changed = before != snapshot(ctl, "");
    if changed {
        ctl.revision += 1;
    }
    changed
}

#[allow(clippy::too_many_arguments)]
pub fn review(
    ctl: &mut LiveCtl,
    item_id: &str,
    action: &str,
    text: Option<&str>,
    owner: Option<&str>,
    due: Option<&str>,
    now_iso: &str,
) -> anyhow::Result<()> {
    let item = ctl
        .items
        .iter_mut()
        .find(|item| item.id == item_id)
        .ok_or_else(|| anyhow::anyhow!("Live item not found"))?;
    let action = match action {
        "accept" => return Ok(()),
        "edit_accept" => "edit",
        "dismiss" => "delete",
        action => action,
    };
    let status = match (action, item.status.as_str()) {
        ("edit", "proposed" | "accepted" | "dismissed") => "accepted",
        ("delete", "proposed" | "accepted") => "dismissed",
        ("restore", "dismissed") => "proposed",
        ("restore", "retracted") => "accepted",
        _ => anyhow::bail!("Review action not allowed in this state"),
    };
    let before_text = item.text.clone();
    if action == "edit" {
        item.text = text
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Edited text is required"))?
            .into();
        item.owner = owner.map(str::to_string);
        item.due = due.map(str::to_string);
    }
    item.status = status.into();
    item.revision += 1;
    item.review_events.push(LiveReviewEvent {
        action: action.into(),
        at: now_iso.into(),
        before_text: Some(before_text),
        after_text: Some(item.text.clone()),
    });
    ctl.revision += 1;
    Ok(())
}

pub fn snapshot(ctl: &LiveCtl, session_id: &str) -> LiveState {
    let mut items = ctl.items.clone();
    items.sort_by(|a, b| (a.at_ms, &a.id).cmp(&(b.at_ms, &b.id)));
    LiveState {
        session_id: session_id.into(),
        revision: ctl.revision,
        enabled: ctl.enabled,
        status: ctl.status.clone(),
        reason: ctl.reason.clone(),
        through_ms: ctl.through_ms,
        summary: ctl.summary.clone(),
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LiveRetraction, LiveUpsert};

    fn ready() -> (LiveCtl, Instant) {
        let now = Instant::now();
        let mut ctl = LiveCtl {
            enabled: true,
            status: "idle".into(),
            started_at: now - Duration::from_secs(120),
            ..LiveCtl::default()
        };
        push_turn(&mut ctl, "Me", &"word ".repeat(80), 10_000);
        (ctl, now)
    }

    fn response() -> LiveExtractResponse {
        LiveExtractResponse {
            request_id: "x1".into(),
            session_id: "s1".into(),
            base_revision: 0,
            status: "ok".into(),
            reason: None,
            through_ms: Some(10_000),
            upserts: vec![LiveUpsert {
                id: None,
                kind: "action".into(),
                text: "Prepare the demo.".into(),
                owner: Some("Me".into()),
                due: Some("Friday".into()),
                evidence_turn_ids: vec!["t1".into()],
                supersedes_id: None,
            }],
            retractions: vec![],
            summary: None,
        }
    }

    #[test]
    fn turns_have_boundary_times_ids_and_word_counts() {
        let mut ctl = LiveCtl::default();
        push_turn(&mut ctl, "Me", "  hello world  ", 700);
        push_turn(&mut ctl, "Them", "Next", 900);
        push_turn(&mut ctl, "Them", "  ", 950);
        assert_eq!(ctl.turns.len(), 2);
        assert_eq!(
            (
                &ctl.turns[0].id,
                ctl.turns[0].start_ms,
                ctl.turns[0].end_ms,
                ctl.turns[0].words
            ),
            (&"t1".to_string(), 0, 700, 2)
        );
        assert_eq!(
            (&ctl.turns[1].id, ctl.turns[1].start_ms, ctl.turns[1].end_ms),
            (&"t2".to_string(), 700, 900)
        );
        assert_eq!(ctl.words_since_summary, 3);
    }

    #[test]
    fn founder_empty_intro_replays_followup_extraction_timeline() {
        let start = Instant::now();
        let at = |seconds| start + Duration::from_secs(seconds);
        let mut ctl = LiveCtl {
            enabled: true,
            status: "idle".into(),
            started_at: start,
            ..LiveCtl::default()
        };
        push_turn(&mut ctl, "Me", &"intro ".repeat(44), 32_775);
        assert_eq!(
            should_extract(&ctl, at(32), false, None),
            Decision::Run {
                update_summary: false
            }
        );
        set_status(&mut ctl, "updating", None);
        ctl.last_extract_started = Some(at(32));
        let (request, covered) = build_request(
            &mut ctl,
            "dc76a0aa-f426-46bd-a712-5cb1e3a25d02",
            "test-model",
            "intro",
            false,
        );
        let mut empty = LiveExtractResponse {
            request_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            base_revision: request.base_revision,
            status: "ok".into(),
            reason: None,
            through_ms: Some(32_775),
            upserts: vec![],
            retractions: vec![],
            summary: None,
        };
        validate_response(&mut empty, &request, ctl.through_ms).unwrap();
        assert!(apply_response(&mut ctl, &empty, at(38), covered, &[]));
        assert_eq!(ctl.covered_upto_idx, 1);
        assert_eq!(ctl.through_ms, 32_775);
        assert!(ctl.items.is_empty());
        assert_eq!(ctl.consecutive_errors, 0);
        assert!(ctl.backoff_until.is_none());
        assert_eq!(ctl.last_extract_started, Some(at(32)));
        for with_answer in [false, true] {
            let mut ctl = ctl.clone();
            let mut first_followup = None;
            for second in 39..=120 {
                if [40, 48, 55, 60, 65, 70, 75, 80].contains(&second) {
                    push_turn(&mut ctl, "Me", &"followup ".repeat(14), second * 1000);
                }
                if second % 5 != 0 {
                    continue;
                }
                let busy = with_answer && (65..75).contains(&second);
                let finished = (with_answer && second >= 75).then(|| at(75));
                let decision = should_extract(&ctl, at(second), busy, finished);
                assert_eq!(decision == Decision::Busy, busy, "tick {second}");
                let uncovered = uncovered_words(&ctl);
                let elapsed =
                    at(second).saturating_duration_since(ctl.last_extract_started.unwrap());
                let eligible = elapsed >= Duration::from_secs(30)
                    && uncovered >= 40
                    && !busy
                    && finished.is_none_or(|finished| {
                        at(second).duration_since(finished) >= Duration::from_secs(3)
                    });
                assert_eq!(
                    matches!(decision, Decision::Run { .. }),
                    eligible,
                    "tick {second}, uncovered={uncovered}, decision={decision:?}"
                );
                if busy {
                    set_status(&mut ctl, "busy", None);
                }
                if matches!(decision, Decision::Run { .. }) {
                    first_followup.get_or_insert(second);
                    set_status(&mut ctl, "updating", None);
                    ctl.last_extract_started = Some(at(second));
                    let (request, covered) =
                        build_request(&mut ctl, "session", "test-model", "followup", false);
                    assert_eq!(covered, ctl.turns.len());
                    let through = ctl.turns[covered - 1].end_ms;
                    let mut followup = LiveExtractResponse {
                        request_id: request.request_id.clone(),
                        session_id: request.session_id.clone(),
                        base_revision: request.base_revision,
                        through_ms: Some(through),
                        ..empty.clone()
                    };
                    validate_response(&mut followup, &request, ctl.through_ms).unwrap();
                    apply_response(&mut ctl, &followup, at(second + 1), covered, &[]);
                    assert_eq!(uncovered_words(&ctl), 0);
                    assert_eq!(ctl.covered_upto_idx, covered);
                }
            }
            // First tick after 32 + 30; an active answer and its cooldown still take precedence.
            assert_eq!(first_followup, Some(if with_answer { 80 } else { 65 }));
        }
    }

    #[test]
    fn scheduling_checks_every_gate_and_inclusive_thresholds() {
        let (ctl, now) = ready();
        assert_eq!(
            should_extract(&ctl, now, false, None),
            Decision::Run {
                update_summary: false
            }
        );
        let mut off = ctl.clone();
        off.enabled = false;
        assert_eq!(
            should_extract(&off, now, true, None),
            Decision::Skip("disabled")
        );
        assert_eq!(should_extract(&ctl, now, true, None), Decision::Busy);
        let mut first = ctl.clone();
        first.started_at = now - Duration::from_secs(29);
        assert_eq!(
            should_extract(&first, now, false, None),
            Decision::Skip("first_wait")
        );
        first.started_at = now - Duration::from_secs(30);
        assert!(matches!(
            should_extract(&first, now, false, None),
            Decision::Run { .. }
        ));
        first.turns[0].words = 39;
        assert_eq!(
            should_extract(&first, now, false, None),
            Decision::Skip("words")
        );
        first.turns[0].words = 40;
        assert!(matches!(
            should_extract(&first, now, false, None),
            Decision::Run { .. }
        ));
        first.covered_upto_idx = 1;
        assert_eq!(
            should_extract(&first, now, false, None),
            Decision::Skip("words")
        );
        let mut later = ctl.clone();
        later.last_extract_started = Some(now - Duration::from_secs(29));
        assert_eq!(
            should_extract(&later, now, false, None),
            Decision::Skip("cooldown")
        );
        later.last_extract_started = Some(now - Duration::from_secs(30));
        assert!(matches!(
            should_extract(&later, now, false, None),
            Decision::Run { .. }
        ));
        later.turns[0].words = 39;
        assert_eq!(
            should_extract(&later, now, false, None),
            Decision::Skip("words")
        );
        later.turns[0].words = 40;
        assert!(matches!(
            should_extract(&later, now, false, None),
            Decision::Run { .. }
        ));
        later.covered_upto_idx = 1;
        assert_eq!(
            should_extract(&later, now, false, None),
            Decision::Skip("words")
        );
        assert_eq!(
            should_extract(&ctl, now, false, Some(now - Duration::from_millis(2999))),
            Decision::Skip("cooldown")
        );
        assert!(matches!(
            should_extract(&ctl, now, false, Some(now - Duration::from_secs(3))),
            Decision::Run { .. }
        ));
        let mut backoff = ctl.clone();
        backoff.backoff_until = Some(now + Duration::from_millis(1));
        assert_eq!(
            should_extract(&backoff, now, false, None),
            Decision::Skip("backoff")
        );
        backoff.backoff_until = Some(now);
        assert!(matches!(
            should_extract(&backoff, now, false, None),
            Decision::Run { .. }
        ));
        backoff.status = "updating".into();
        assert_eq!(
            should_extract(&backoff, now, false, None),
            Decision::Skip("error:extraction_still_updating")
        );
    }

    #[test]
    fn summary_requires_both_time_and_new_words() {
        let (mut ctl, now) = ready();
        ctl.words_since_summary = 199;
        assert_eq!(
            should_extract(&ctl, now, false, None),
            Decision::Run {
                update_summary: false
            }
        );
        ctl.words_since_summary = 200;
        assert_eq!(
            should_extract(&ctl, now, false, None),
            Decision::Run {
                update_summary: true
            }
        );
        ctl.last_summary_at = Some(now - Duration::from_secs(119));
        assert_eq!(
            should_extract(&ctl, now, false, None),
            Decision::Run {
                update_summary: false
            }
        );
        ctl.last_summary_at = Some(now - Duration::from_secs(120));
        assert_eq!(
            should_extract(&ctl, now, false, None),
            Decision::Run {
                update_summary: true
            }
        );
    }

    #[test]
    fn request_caps_uncovered_duration_and_keeps_overlap() {
        let mut ctl = LiveCtl::default();
        for i in 1..=4 {
            push_turn(&mut ctl, "Me", "turn", i * 40_000);
        }
        ctl.covered_upto_idx = 1;
        let (req, covered) = build_request(&mut ctl, "s", "model", "x", true);
        assert_eq!(covered, 2);
        assert_eq!(
            req.turns.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["t1", "t2"]
        );
        assert_eq!(req.turns[1].start_ms, 40_000);
        assert_eq!(req.num_ctx, 16384);
        assert!(req.update_summary);
        ctl.covered_upto_idx = covered;
        assert_eq!(build_request(&mut ctl, "s", "model", "x2", false).1, 3);
    }

    #[test]
    fn cap_with_ninety_seconds_of_turns_yields_two_requests() {
        let mut ctl = LiveCtl::default();
        for i in 1..=3 {
            push_turn(&mut ctl, "Me", "turn", i * 30_000);
        }
        let (first, covered) = build_request(&mut ctl, "s", "model", "x", false);
        assert_eq!(covered, 2);
        assert_eq!(first.new_turn_ids, ["t1", "t2"]);
        ctl.covered_upto_idx = covered;
        let (second, covered) = build_request(&mut ctl, "s", "model", "x2", false);
        assert_eq!(covered, 3);
        assert_eq!(second.new_turn_ids, ["t3"]);
    }

    #[test]
    fn request_caps_characters_without_splitting_evidence() {
        let mut ctl = LiveCtl::default();
        for i in 1..=3 {
            push_turn(&mut ctl, "Me", &"é".repeat(4000), i * 10_000);
        }
        let (req, covered) = build_request(&mut ctl, "s", "m", "x", false);
        assert_eq!(covered, 1);
        assert_eq!(
            req.turns
                .iter()
                .map(|t| t.text.chars().count())
                .sum::<usize>(),
            4000
        );
        let mut long = LiveCtl::default();
        push_turn(&mut long, "Me", "long silence before boundary", 130_000);
        assert_eq!(build_request(&mut long, "s", "m", "x", false).1, 1);
    }

    #[test]
    fn request_only_contains_active_items_and_exact_wire_fields() {
        let (mut ctl, _) = ready();
        apply_response(&mut ctl, &response(), Instant::now(), 1, &[]);
        for (i, status) in ["accepted", "dismissed", "retracted"].iter().enumerate() {
            let mut item = ctl.items[0].clone();
            item.id = i.to_string();
            item.status = (*status).into();
            ctl.items.push(item);
        }
        let (req, _) = build_request(&mut ctl, "s1", "m", "x1", false);
        assert_eq!(req.items.len(), 2);
        let value = serde_json::to_value(&req).unwrap();
        assert_eq!(value["items"][0].as_object().unwrap().len(), 7);
        assert!(value.get("base_revision").is_some());
        assert!(value["items"][0].get("original_text").is_none());
    }

    #[test]
    fn apply_new_then_update_preserves_original_and_assigns_ids() {
        let (mut ctl, _) = ready();
        assert!(apply_response(
            &mut ctl,
            &response(),
            Instant::now(),
            1,
            &[]
        ));
        let id = ctl.items[0].id.clone();
        assert_eq!(id.len(), 15);
        assert!(id.starts_with("li_"));
        assert!(id[3..]
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_eq!(ctl.items[0].revision, 1);
        assert_eq!(ctl.covered_upto_idx, 1);
        let mut update = response();
        update.upserts[0].id = Some(id);
        update.upserts[0].owner = Some("Amina".into());
        update.upserts[0].due = None;
        apply_response(&mut ctl, &update, Instant::now(), 1, &[]);
        assert_eq!(ctl.items.len(), 1);
        assert_eq!(ctl.items[0].text, "Prepare the demo.");
        assert_eq!(ctl.items[0].original_text, "Prepare the demo.");
        assert_eq!(ctl.items[0].owner.as_deref(), Some("Amina"));
        assert_eq!(ctl.items[0].revision, 2);
        assert_eq!(ctl.items[0].due, None);
    }

    #[test]
    fn accepted_items_ignore_updates_retractions_and_supersedes() {
        let (mut ctl, _) = ready();
        apply_response(&mut ctl, &response(), Instant::now(), 1, &[]);
        let id = ctl.items[0].id.clone();
        review(
            &mut ctl,
            &id,
            "edit",
            Some("User-edited demo"),
            Some("Amina"),
            Some("Monday"),
            "now",
        )
        .unwrap();
        let accepted = ctl.items[0].clone();
        let mut update = response();
        update.upserts[0].id = Some(id.clone());
        update.upserts[0].text = "Changed".into();
        update.retractions.push(LiveRetraction {
            id: id.clone(),
            evidence_turn_ids: vec!["t1".into()],
            reason_code: "explicit_withdrawal".into(),
            withdrawal_quote: "scrap it".into(),
        });
        assert!(!apply_response(&mut ctl, &update, Instant::now(), 1, &[]));
        assert_eq!(ctl.items[0], accepted);
        update.upserts[0].id = None;
        update.upserts[0].supersedes_id = Some(id);
        apply_response(&mut ctl, &update, Instant::now(), 1, &[]);
        assert_eq!(ctl.items[0], accepted);
        assert_eq!(ctl.items.len(), 2);
    }

    #[test]
    fn apply_drops_copilot_questions_by_normalized_text_or_keyword_similarity() {
        let (mut ctl, _) = ready();
        let cards = vec![
            "What's the difference between a knowledge graph and a mind map?".into(),
            "What is it?".into(),
            "alpha bravo charlie".into(),
        ];
        let mut resp = response();
        resp.upserts[0].kind = "question".into();
        for text in [
            "  WHAT'S THE DIFFERENCE BETWEEN A KNOWLEDGE GRAPH AND A MIND MAP! ",
            "How does a knowledge graph compare with a mind map?",
            "What is it!", // Equal normalized text with no keywords.
            "alpha bravo charlie delta echo?", // Jaccard is exactly 0.6.
        ] {
            resp.upserts[0].text = text.into();
            apply_response(&mut ctl, &resp, Instant::now(), 1, &cards);
            assert!(ctl.items.is_empty(), "{text}");
        }
        resp.upserts[0].text = "alpha bravo delta?".into(); // Below the threshold.
        apply_response(&mut ctl, &resp, Instant::now(), 1, &cards);
        assert_eq!(ctl.items.len(), 1);
        let original = ctl.items[0].clone();
        resp.upserts[0].id = Some(original.id.clone());
        resp.upserts[0].text = cards[0].clone();
        apply_response(&mut ctl, &resp, Instant::now(), 1, &cards);
        assert_eq!(ctl.items[0], original);
        resp.upserts[0].id = None;
        resp.upserts[0].kind = "decision".into();
        apply_response(&mut ctl, &resp, Instant::now(), 1, &cards);
        assert_eq!(ctl.items.len(), 2); // Card filtering only applies to questions.
    }

    #[test]
    fn deleted_items_block_normalized_readds_until_restored() {
        let (mut ctl, _) = ready();
        apply_response(&mut ctl, &response(), Instant::now(), 1, &[]);
        let id = ctl.items[0].id.clone();
        review(&mut ctl, &id, "delete", None, None, None, "now").unwrap();
        let deleted = ctl.items[0].clone();
        let mut resp = response();
        resp.upserts[0].text = "  PREPARE   the demo! ".into();
        for kind in ["action", "decision", "question"] {
            resp.upserts[0].kind = kind.into();
            apply_response(&mut ctl, &resp, Instant::now(), 1, &[]);
            assert_eq!(ctl.items, std::slice::from_ref(&deleted));
        }
        resp.upserts[0].text = "Prepare the launch.".into();
        apply_response(&mut ctl, &resp, Instant::now(), 1, &[]);
        let kept = ctl.items[1].clone();
        resp.upserts[0].id = Some(kept.id.clone());
        resp.upserts[0].text = deleted.text.clone();
        apply_response(&mut ctl, &resp, Instant::now(), 1, &[]);
        assert_eq!(ctl.items[1], kept); // Updating another ID cannot bypass deletion.
        review(&mut ctl, &id, "restore", None, None, None, "later").unwrap();
        resp.upserts[0].id = Some(id);
        apply_response(&mut ctl, &resp, Instant::now(), 1, &[]);
        assert_eq!(ctl.items[0].status, "proposed");
        assert_eq!(ctl.items[0].revision, deleted.revision + 2);
    }

    #[test]
    fn bare_supersedes_never_changes_status_and_proposed_only_retracts() {
        let (mut ctl, _) = ready();
        apply_response(&mut ctl, &response(), Instant::now(), 1, &[]);
        let mut update = response();
        update.upserts[0].supersedes_id = Some(ctl.items[0].id.clone());
        apply_response(&mut ctl, &update, Instant::now(), 1, &[]);
        assert_eq!(ctl.items[0].status, "proposed");
        assert_eq!(ctl.items[0].revision, 1);
        assert_eq!(ctl.items.len(), 2);
    }

    fn retraction_setup() -> (LiveCtl, String) {
        let (mut ctl, now) = ready();
        build_request(&mut ctl, "s1", "m", "r1", false);
        apply_response(&mut ctl, &response(), now, 1, &[]);
        let id = ctl.items[0].id.clone();
        push_turn(&mut ctl, "Them", "scrap the demo completely", 20_000);
        build_request(&mut ctl, "s1", "m", "r2", false);
        (ctl, id)
    }

    fn retraction(id: &str, evidence: &[&str], reason: &str, quote: &str) -> LiveRetraction {
        LiveRetraction {
            id: id.into(),
            evidence_turn_ids: evidence.iter().map(|s| s.to_string()).collect(),
            reason_code: reason.into(),
            withdrawal_quote: quote.into(),
        }
    }

    fn extract_response(
        upserts: Vec<LiveUpsert>,
        retractions: Vec<LiveRetraction>,
    ) -> LiveExtractResponse {
        LiveExtractResponse {
            request_id: "x1".into(),
            session_id: "s1".into(),
            base_revision: 0,
            status: "ok".into(),
            reason: None,
            through_ms: Some(20_000),
            upserts,
            retractions,
            summary: None,
        }
    }

    #[test]
    fn founder_two_batches_without_new_evidence_preserve_all_items() {
        let (mut ctl, now) = ready();
        build_request(&mut ctl, "s1", "m", "r1", false);
        apply_response(
            &mut ctl,
            &extract_response(
                (1..=4)
                    .map(|n| LiveUpsert {
                        id: None,
                        kind: "action".into(),
                        text: format!("Action {n}"),
                        owner: None,
                        due: None,
                        evidence_turn_ids: vec!["t1".into()],
                        supersedes_id: None,
                    })
                    .collect(),
                vec![],
            ),
            now,
            1,
            &[],
        );
        assert_eq!(ctl.items.len(), 4);
        push_turn(&mut ctl, "Them", "moving on to something else", 20_000);
        build_request(&mut ctl, "s1", "m", "r2", false);
        let ids: Vec<String> = ctl.items.iter().map(|item| item.id.clone()).collect();
        let mut retractions = Vec::new();
        for id in &ids {
            retractions.push(retraction(id, &["t1"], "explicit_withdrawal", ""));
        }
        apply_response(
            &mut ctl,
            &extract_response(vec![], retractions),
            now,
            2,
            &[],
        );
        assert_eq!(ctl.items.len(), 4);
        assert!(ctl
            .items
            .iter()
            .all(|item| item.status == "proposed" && item.withdrawal_quote.is_none()));
    }

    #[test]
    fn explicit_withdrawal_with_new_turn_quote_retracts_and_stores_quote() {
        let (mut ctl, id) = retraction_setup();
        apply_response(
            &mut ctl,
            &extract_response(
                vec![],
                vec![retraction(
                    &id,
                    &["t2"],
                    "explicit_withdrawal",
                    "scrap the demo completely",
                )],
            ),
            Instant::now(),
            2,
            &[],
        );
        assert_eq!(ctl.items[0].status, "retracted");
        assert_eq!(
            ctl.items[0].withdrawal_quote.as_deref(),
            Some("scrap the demo completely")
        );
        assert!(ctl.items[0].withdrawn_at.is_some());
    }

    #[test]
    fn overlap_only_evidence_preserves_item() {
        let (mut ctl, id) = retraction_setup();
        apply_response(
            &mut ctl,
            &extract_response(
                vec![],
                vec![retraction(&id, &["t1"], "explicit_withdrawal", "scrap it")],
            ),
            Instant::now(),
            2,
            &[],
        );
        assert_eq!(ctl.items[0].status, "proposed");
        assert!(ctl.items[0].withdrawal_quote.is_none());
    }

    #[test]
    fn retraction_requires_valid_reason_and_nonempty_quote() {
        let (ctl, id) = retraction_setup();
        for (reason, quote) in [
            ("invented", "scrap the demo completely"),
            ("explicit_withdrawal", ""),
        ] {
            let mut ctl = ctl.clone();
            apply_response(
                &mut ctl,
                &extract_response(vec![], vec![retraction(&id, &["t2"], reason, quote)]),
                Instant::now(),
                2,
                &[],
            );
            assert_eq!(ctl.items[0].status, "proposed", "{reason}/{quote}");
        }
    }

    #[test]
    fn revision_changed_skips_only_that_retraction() {
        let (mut ctl, id) = retraction_setup();
        ctl.items[0].revision += 1;
        apply_response(
            &mut ctl,
            &extract_response(
                vec![],
                vec![retraction(
                    &id,
                    &["t2"],
                    "explicit_withdrawal",
                    "scrap the demo completely",
                )],
            ),
            Instant::now(),
            2,
            &[],
        );
        assert_eq!(ctl.items[0].status, "proposed");
    }

    #[test]
    fn explicit_replacement_with_dropped_upsert_preserves_item() {
        let (mut ctl, id) = retraction_setup();
        let replacement = LiveUpsert {
            id: None,
            kind: "action".into(),
            text: "Ship the new plan".into(),
            owner: None,
            due: None,
            evidence_turn_ids: vec!["missing".into()],
            supersedes_id: Some(id.clone()),
        };
        apply_response(
            &mut ctl,
            &extract_response(
                vec![replacement],
                vec![retraction(
                    &id,
                    &["t2"],
                    "explicit_replacement",
                    "scrap the demo completely",
                )],
            ),
            Instant::now(),
            2,
            &[],
        );
        assert_eq!(ctl.items.len(), 1);
        assert_eq!(ctl.items[0].status, "proposed");
    }

    #[test]
    fn explicit_replacement_applies_atomically_with_new_upsert() {
        let (mut ctl, id) = retraction_setup();
        let replacement = LiveUpsert {
            id: None,
            kind: "action".into(),
            text: "Ship the new plan".into(),
            owner: None,
            due: None,
            evidence_turn_ids: vec!["t2".into()],
            supersedes_id: Some(id.clone()),
        };
        apply_response(
            &mut ctl,
            &extract_response(
                vec![replacement],
                vec![retraction(
                    &id,
                    &["t2"],
                    "explicit_replacement",
                    "scrap the demo completely",
                )],
            ),
            Instant::now(),
            2,
            &[],
        );
        assert_eq!(ctl.items.len(), 2);
        assert_eq!(ctl.items[0].status, "retracted");
        assert_eq!(ctl.items[1].status, "proposed");
        assert_eq!(ctl.items[1].text, "Ship the new plan");
    }

    #[test]
    fn restore_from_retracted_locks_as_accepted() {
        let (mut ctl, id) = retraction_setup();
        apply_response(
            &mut ctl,
            &extract_response(
                vec![],
                vec![retraction(
                    &id,
                    &["t2"],
                    "explicit_withdrawal",
                    "scrap the demo completely",
                )],
            ),
            Instant::now(),
            2,
            &[],
        );
        assert_eq!(ctl.items[0].status, "retracted");
        review(&mut ctl, &id, "restore", None, None, None, "later").unwrap();
        assert_eq!(ctl.items[0].status, "accepted");
        assert_eq!(ctl.items[0].review_events.last().unwrap().action, "restore");
        // Accepted items are locked, so the same withdrawal cannot replay.
        apply_response(
            &mut ctl,
            &extract_response(
                vec![],
                vec![retraction(
                    &id,
                    &["t2"],
                    "explicit_withdrawal",
                    "scrap the demo completely",
                )],
            ),
            Instant::now(),
            2,
            &[],
        );
        assert_eq!(ctl.items[0].status, "accepted");
    }

    #[test]
    fn apply_drops_unknown_empty_or_invalid_evidence_and_unknown_item_ids() {
        let (mut ctl, _) = ready();
        for evidence in [
            vec!["missing".into()],
            vec!["t1".into(), "missing".into()],
            vec![],
        ] {
            let mut resp = response();
            resp.upserts[0].evidence_turn_ids = evidence;
            apply_response(&mut ctl, &resp, Instant::now(), 1, &[]);
            assert!(ctl.items.is_empty());
        }
        let mut resp = response();
        resp.upserts[0].id = Some("unknown".into());
        apply_response(&mut ctl, &resp, Instant::now(), 1, &[]);
        assert!(ctl.items.is_empty());
        resp.upserts[0].id = None;
        resp.upserts[0].kind = "invented".into();
        apply_response(&mut ctl, &resp, Instant::now(), 1, &[]);
        assert!(ctl.items.is_empty());
    }

    #[test]
    fn summary_replaces_and_counts_only_covered_words() {
        let (mut ctl, _) = ready();
        push_turn(&mut ctl, "Them", "still pending", 20_000);
        let mut resp = response();
        resp.summary = Some(LiveSummary {
            bullets: vec!["A demo is planned.".into()],
            evidence_turn_ids: vec!["t1".into()],
        });
        apply_response(&mut ctl, &resp, Instant::now(), 2, &[]);
        assert_eq!(ctl.summary, resp.summary.clone().unwrap());
        assert_eq!(ctl.last_summary_words, 80);
        assert_eq!(ctl.words_since_summary, 2);
        assert_eq!(ctl.covered_upto_idx, 1);
        assert!(ctl.last_summary_at.is_some());
        let previous = ctl.summary.clone();
        resp.summary = None;
        apply_response(&mut ctl, &resp, Instant::now(), 2, &[]);
        assert_eq!(ctl.summary, previous);
    }

    #[test]
    fn response_backoff_and_summary_use_the_supplied_clock() {
        let (mut ctl, _) = ready();
        let now = Instant::now() + Duration::from_secs(10_000);
        let mut error = response();
        error.status = "error".into();
        error.through_ms = None;
        apply_response(&mut ctl, &error, now, 1, &[]);
        assert_eq!(ctl.backoff_until, Some(now + Duration::from_secs(60)));
        let mut success = response();
        success.upserts.clear();
        success.summary = Some(LiveSummary {
            bullets: vec![],
            evidence_turn_ids: vec![],
        });
        apply_response(&mut ctl, &success, now + Duration::from_secs(61), 1, &[]);
        assert!(ctl.backoff_until.is_none());
        assert_eq!(ctl.last_summary_at, Some(now + Duration::from_secs(61)));
    }

    #[test]
    fn errors_back_off_and_success_resets_them() {
        let (mut ctl, _) = ready();
        let mut resp = response();
        resp.status = "error".into();
        resp.reason = Some("Model unavailable".into());
        resp.through_ms = None;
        for errors in 1..=3 {
            let before = Instant::now();
            apply_response(&mut ctl, &resp, Instant::now(), 1, &[]);
            assert_eq!(ctl.consecutive_errors, errors);
            assert_eq!(ctl.status, "error");
            assert_eq!(ctl.reason.as_deref(), Some("Model unavailable"));
            let delay = ctl.backoff_until.unwrap().duration_since(before).as_secs();
            assert_eq!(delay, if errors >= 3 { 180 } else { 60 });
            assert_eq!(ctl.covered_upto_idx, 0);
            assert!(ctl.items.is_empty());
        }
        apply_response(&mut ctl, &response(), Instant::now(), 1, &[]);
        assert_eq!(ctl.consecutive_errors, 0);
        assert_eq!(ctl.backoff_until, None);
        assert_eq!(ctl.status, "idle");
    }

    #[test]
    fn review_transition_matrix_and_logs() {
        let (mut ctl, _) = ready();
        apply_response(&mut ctl, &response(), Instant::now(), 1, &[]);
        for status in ["proposed", "accepted", "dismissed", "retracted"] {
            for action in [
                "edit",
                "delete",
                "restore",
                "accept",
                "edit_accept",
                "dismiss",
                "unknown",
            ] {
                let mut candidate = ctl.clone();
                candidate.items[0].status = status.into();
                let id = candidate.items[0].id.clone();
                let before = snapshot(&candidate, "s");
                let canonical = match action {
                    "edit_accept" => "edit",
                    "dismiss" => "delete",
                    action => action,
                };
                let expected_status = match (canonical, status) {
                    ("accept", status) => Some(status),
                    ("edit", "proposed" | "accepted" | "dismissed") => Some("accepted"),
                    ("delete", "proposed" | "accepted") => Some("dismissed"),
                    ("restore", "dismissed") => Some("proposed"),
                    ("restore", "retracted") => Some("accepted"),
                    _ => None,
                };
                let result = review(
                    &mut candidate,
                    &id,
                    action,
                    Some(" edited "),
                    Some("Them"),
                    Some("Monday"),
                    "time",
                );
                assert_eq!(
                    result.is_ok(),
                    expected_status.is_some(),
                    "{status}/{action}"
                );
                if action == "accept" {
                    assert_eq!(snapshot(&candidate, "s"), before);
                } else if let Some(expected_status) = expected_status {
                    let item = &candidate.items[0];
                    assert_eq!(item.status, expected_status);
                    assert_eq!(candidate.revision, before.revision + 1);
                    assert_eq!(item.revision, before.items[0].revision + 1);
                    let event = &item.review_events[0];
                    assert_eq!(event.action, canonical);
                    assert_eq!(event.at, "time");
                    assert_eq!(event.before_text, Some("Prepare the demo.".into()));
                    assert_eq!(event.after_text.as_deref(), Some(item.text.as_str()));
                    assert_eq!(
                        item.text,
                        if canonical == "edit" {
                            "edited"
                        } else {
                            "Prepare the demo."
                        }
                    );
                    assert_eq!(
                        item.owner.as_deref(),
                        Some(if canonical == "edit" { "Them" } else { "Me" })
                    );
                    assert_eq!(
                        item.due.as_deref(),
                        Some(if canonical == "edit" {
                            "Monday"
                        } else {
                            "Friday"
                        })
                    );
                    assert_eq!(item.original_text, "Prepare the demo.");
                } else {
                    assert_eq!(
                        result.unwrap_err().to_string(),
                        "Review action not allowed in this state"
                    );
                    assert_eq!(snapshot(&candidate, "s"), before);
                }
            }
        }
    }

    #[test]
    fn edit_requires_nonblank_text_and_preserves_state_on_failure() {
        let (mut ctl, _) = ready();
        apply_response(&mut ctl, &response(), Instant::now(), 1, &[]);
        let id = ctl.items[0].id.clone();
        let before = snapshot(&ctl, "s");
        for action in ["edit", "edit_accept"] {
            for text in [None, Some(""), Some(" \n ")] {
                assert!(review(&mut ctl, &id, action, text, None, None, "now").is_err());
                assert_eq!(snapshot(&ctl, "s"), before);
            }
        }
        assert!(review(&mut ctl, "missing", "accept", None, None, None, "now").is_err());
        review(
            &mut ctl,
            &id,
            "edit_accept",
            Some("Revised"),
            None,
            None,
            "now",
        )
        .unwrap();
        assert_eq!(ctl.items[0].owner, None);
        assert_eq!(ctl.items[0].due, None);
    }

    #[test]
    fn snapshot_sorts_all_statuses_and_serializes_nulls() {
        let (mut ctl, _) = ready();
        apply_response(&mut ctl, &response(), Instant::now(), 1, &[]);
        ctl.items[0].id = "z".into();
        ctl.items[0].at_ms = 10;
        for (id, at, status) in [("b", 0, "dismissed"), ("a", 0, "retracted")] {
            let mut item = ctl.items[0].clone();
            item.id = id.into();
            item.at_ms = at;
            item.status = status.into();
            ctl.items.push(item);
        }
        let state = snapshot(&ctl, "session");
        assert_eq!(
            state
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "z"]
        );
        let value = serde_json::to_value(state).unwrap();
        assert!(value["reason"].is_null());
        assert_eq!(value["session_id"], "session");
        assert_eq!(ctl.items[0].id, "z");
    }

    #[test]
    fn validation_restricts_evidence_to_request_and_checks_envelope() {
        let (mut ctl, _) = ready();
        let (req, _) = build_request(&mut ctl, "s1", "m", "x1", false);
        push_turn(&mut ctl, "Me", "arrived during HTTP", 20_000);
        let mut resp = response();
        resp.upserts[0].evidence_turn_ids = vec!["t2".into()];
        resp.summary = Some(LiveSummary {
            bullets: vec!["Bad".into()],
            evidence_turn_ids: vec!["t1".into()],
        });
        validate_response(&mut resp, &req, 0).unwrap();
        assert!(resp.upserts.is_empty());
        assert!(resp.summary.is_none());
        for mismatch in ["request", "session", "coverage", "status"] {
            let mut resp = response();
            match mismatch {
                "request" => resp.request_id = "other".into(),
                "session" => resp.session_id = "other".into(),
                "coverage" => resp.through_ms = Some(20_000),
                _ => resp.status = "invalid".into(),
            }
            assert!(validate_response(&mut resp, &req, 0).is_err());
        }
        let mut resp = response();
        resp.base_revision = req.base_revision + 1;
        assert!(validate_response(&mut resp, &req, 0).is_ok());
    }

    #[test]
    fn status_changes_increment_revision_once() {
        let mut ctl = LiveCtl::default();
        assert!(set_status(
            &mut ctl,
            "busy",
            Some("Waiting while Copilot answers".into())
        ));
        assert_eq!(ctl.revision, 1);
        assert!(!set_status(
            &mut ctl,
            "busy",
            Some("Waiting while Copilot answers".into())
        ));
        assert_eq!(ctl.revision, 1);
        assert!(set_status(&mut ctl, "idle", None));
        assert_eq!(ctl.revision, 2);
    }
}
