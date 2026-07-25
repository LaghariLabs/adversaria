//! Compute per-speaker and aggregate meeting statistics from transcript turns.
//!
//! Word-based fallbacks apply when the meeting predates turn timing (v0.3.36).

use crate::types::{MeetingStats, SpeakerStats, TranscriptTurn};

/// English filler words and phrases. Case-insensitive matching; single-word
/// fillers match whole tokens only; multi-word phrases match at word boundaries.
/// Non-English text will score near zero — this list is English by design.
const FILLER_SINGLE: &[&str] = &[
    "um",
    "uh",
    "erm",
    "hmm",
    "like",
    "so",
    "right",
    "actually",
    "basically",
    "literally",
];

const FILLER_PHRASES: &[&str] = &["you know", "i mean", "kind of", "sort of"];

/// Words per spoken minute: only when timed AND talk_seconds > 5.0.
const WPM_MIN_TALK_SECS: f64 = 5.0;

/// Gap (seconds) to count as an interruption:
/// `turns[i].start < turns[i-1].end - INTERRUPTION_GRACE`
const INTERRUPTION_GRACE: f64 = 0.3;

pub fn compute_meeting_stats(turns: &[TranscriptTurn], owner_label: Option<&str>) -> MeetingStats {
    if turns.is_empty() {
        return MeetingStats {
            has_timing: false,
            total_speech_seconds: None,
            owner: None,
            speakers: Vec::new(),
        };
    }

    let has_timing = turns
        .iter()
        .all(|t| t.start.is_some() && t.end.is_some() && t.end.unwrap() >= t.start.unwrap());

    let mut total_words: u32 = 0;
    let mut total_seconds: f64 = 0.0;

    // Accumulate per-speaker. Use a Vec to keep insertion order (stable) before sorting.
    #[derive(Debug, Clone)]
    struct Acc {
        words: u32,
        talk_seconds: f64,
        fillers: u32,
        interruptions: u32,
        longest_monologue_seconds: f64,
        longest_monologue_words: u32,
    }
    use std::collections::BTreeMap;
    let mut acc: BTreeMap<String, Acc> = BTreeMap::new();

    for (i, turn) in turns.iter().enumerate() {
        let speaker = &turn.speaker;
        let words = count_words(&turn.text);
        let fillers = count_fillers(&turn.text);
        let dur = if has_timing {
            let d = turn.end.unwrap() - turn.start.unwrap();
            total_seconds += d;
            d
        } else {
            0.0
        };

        let entry = acc.entry(speaker.clone()).or_insert(Acc {
            words: 0,
            talk_seconds: 0.0,
            fillers: 0,
            interruptions: 0,
            longest_monologue_seconds: 0.0,
            longest_monologue_words: 0,
        });
        entry.words += words;
        entry.talk_seconds += dur;
        entry.fillers += fillers;
        if dur > entry.longest_monologue_seconds {
            entry.longest_monologue_seconds = dur;
        }
        if words > entry.longest_monologue_words {
            entry.longest_monologue_words = words;
        }
        total_words += words;

        // Interruption: this speaker started before the previous speaker's turn
        // ended (timed meetings only).
        if has_timing && i > 0 {
            let prev = &turns[i - 1];
            if speaker != &prev.speaker {
                let prev_end = prev.end.unwrap();
                let this_start = turn.start.unwrap();
                if this_start < prev_end - INTERRUPTION_GRACE {
                    let e = acc.get_mut(speaker).unwrap();
                    e.interruptions += 1;
                }
            }
        }
    }

    // Build speaker stats sorted by talk share descending.
    let mut speakers: Vec<SpeakerStats> = acc
        .into_iter()
        .map(|(name, a)| {
            let talk_pct = if has_timing {
                if total_seconds > 0.0 {
                    (a.talk_seconds / total_seconds) * 100.0
                } else {
                    0.0
                }
            } else {
                if total_words > 0 {
                    (a.words as f64 / total_words as f64) * 100.0
                } else {
                    0.0
                }
            };
            let wpm = if has_timing && a.talk_seconds > WPM_MIN_TALK_SECS {
                Some(a.words as f64 / (a.talk_seconds / 60.0))
            } else {
                None
            };
            let filler_rate = if a.words > 0 {
                a.fillers as f64 / a.words as f64
            } else {
                0.0
            };
            let talk_seconds = if has_timing {
                Some(a.talk_seconds)
            } else {
                None
            };
            let longest_monologue_seconds = if has_timing {
                Some(a.longest_monologue_seconds)
            } else {
                None
            };
            SpeakerStats {
                name,
                words: a.words,
                talk_seconds,
                talk_pct,
                wpm,
                fillers: a.fillers,
                filler_rate,
                interruptions: a.interruptions,
                longest_monologue_seconds,
                longest_monologue_words: a.longest_monologue_words,
            }
        })
        .collect();

    // Sort by talk_pct descending.
    speakers.sort_by(|a, b| {
        b.talk_pct
            .partial_cmp(&a.talk_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Resolve owner: user_name match (case-insensitive), else "Me" if present, else None.
    let owner = resolve_owner(&speakers, owner_label);

    let total_speech_seconds = if has_timing {
        Some(total_seconds)
    } else {
        None
    };

    MeetingStats {
        has_timing,
        total_speech_seconds,
        owner,
        speakers,
    }
}

/// Count whitespace-split tokens in `text` (works for Arabic too).
fn count_words(text: &str) -> u32 {
    text.split_whitespace().count() as u32
}

/// Count filler words and phrases in `text` (case-insensitive, English-only).
/// Builds a cleaned token vector once (whitespace-split, punctuation-stripped),
/// then counts single-word fillers from it and two-word phrase fillers via a
/// sliding window — no false positives from substringoverlaps ("you knowledge"
/// is not "you know").
fn count_fillers(text: &str) -> u32 {
    let tokens: Vec<String> = text
        .split_whitespace()
        .map(|t| {
            t.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|t| !t.is_empty())
        .collect();

    if tokens.is_empty() {
        return 0;
    }

    let mut count = 0u32;

    // Single-word fillers.
    for token in &tokens {
        if FILLER_SINGLE.iter().any(|f| f == token) {
            count += 1;
        }
    }

    // Two-word phrases via a sliding window. All current phrases are exactly
    // 2 words; the assert keeps this honest as the list evolves.
    for phrase in FILLER_PHRASES {
        let words: Vec<&str> = phrase.split_whitespace().collect();
        debug_assert_eq!(
            words.len(),
            2,
            "FILLER_PHRASES contains a non-2-word entry: {phrase:?}"
        );
        for w in tokens.windows(2) {
            if w[0] == words[0] && w[1] == words[1] {
                count += 1;
            }
        }
    }

    count
}

/// Pick the owner speaker: match `owner_label` case-insensitively first;
/// fall back to literal "Me" if present; otherwise None.
fn resolve_owner(speakers: &[SpeakerStats], owner_label: Option<&str>) -> Option<String> {
    if let Some(label) = owner_label {
        let lower = label.to_lowercase();
        if let Some(s) = speakers.iter().find(|s| s.name.to_lowercase() == lower) {
            return Some(s.name.clone());
        }
    }
    speakers
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case("Me"))
        .map(|s| s.name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(speaker: &str, text: &str, start: f64, end: f64) -> TranscriptTurn {
        TranscriptTurn {
            speaker: speaker.to_string(),
            text: text.to_string(),
            start: Some(start),
            end: Some(end),
        }
    }

    fn turn_untimed(speaker: &str, text: &str) -> TranscriptTurn {
        TranscriptTurn {
            speaker: speaker.to_string(),
            text: text.to_string(),
            start: None,
            end: None,
        }
    }

    #[test]
    fn timed_two_speaker_with_interruption() {
        let turns = vec![
            turn("Alice", "Hello how are you", 0.0, 3.0), // 4 words, 3s
            turn("Bob", "I'm good thanks", 2.5, 6.0), // start before Alice ends → interruption for Bob
            turn("Alice", "Great let's begin", 6.5, 9.0), // 3 words, 2.5s
            turn("Bob", "Sure thing", 9.5, 11.0),     // 2 words, 1.5s
        ];

        let stats = compute_meeting_stats(&turns, None);
        assert!(stats.has_timing);

        // Alice: 4+3 = 7 words, 3.0+2.5 = 5.5s
        // Bob: 3+2 = 5 words, 3.5+1.5 = 5.0s
        // Total: 10.5s
        assert_eq!(stats.total_speech_seconds, Some(10.5));
        assert_eq!(stats.speakers.len(), 2);

        let alice = &stats.speakers[0]; // more talk share → first
        assert_eq!(alice.name, "Alice");
        assert_eq!(alice.words, 7);
        assert_eq!(alice.talk_seconds, Some(5.5));
        assert!((alice.talk_pct - (5.5 / 10.5 * 100.0)).abs() < 0.01);
        // wpm: 7 / (5.5/60) = 76.36
        assert!(alice.wpm.is_some());
        assert!((alice.wpm.unwrap() - 76.36).abs() < 1.0);
        assert_eq!(alice.interruptions, 0);
        assert_eq!(alice.longest_monologue_seconds, Some(3.0));
        assert_eq!(alice.longest_monologue_words, 4);

        let bob = &stats.speakers[1];
        assert_eq!(bob.name, "Bob");
        assert_eq!(bob.words, 5);
        assert_eq!(bob.talk_seconds, Some(5.0));
        // Bob interrupted Alice at 2.5s (Alice had 0.5s remaining; gap is -0.5 < 0.3 grace, so counted)
        assert_eq!(bob.interruptions, 1);
        assert_eq!(bob.longest_monologue_seconds, Some(3.5));
        assert_eq!(bob.longest_monologue_words, 3);

        // pcts sum to ~100%
        let sum: f64 = stats.speakers.iter().map(|s| s.talk_pct).sum();
        assert!((sum - 100.0).abs() < 0.1);
    }

    #[test]
    fn small_overlap_not_counted_as_interruption() {
        let turns = vec![
            turn("Alice", "Hello", 0.0, 2.0),
            turn("Bob", "Hi there", 1.8, 3.0), // 0.2s overlap: 1.8 < 2.0-0.3? No (1.8 >= 1.7), so NOT an interruption
        ];
        let stats = compute_meeting_stats(&turns, None);
        let bob = stats.speakers.iter().find(|s| s.name == "Bob").unwrap();
        assert_eq!(bob.interruptions, 0);
    }

    #[test]
    fn untimed_fallback_word_based_pct() {
        let turns = vec![
            turn_untimed("Alice", "one two three"), // 3 words
            turn_untimed("Bob", "four"),            // 1 word
        ];
        let stats = compute_meeting_stats(&turns, None);
        assert!(!stats.has_timing);
        assert_eq!(stats.total_speech_seconds, None);

        let alice = stats.speakers.iter().find(|s| s.name == "Alice").unwrap();
        assert_eq!(alice.words, 3);
        assert!((alice.talk_pct - 75.0).abs() < 0.1);
        assert_eq!(alice.talk_seconds, None);
        assert_eq!(alice.wpm, None);
        assert_eq!(alice.longest_monologue_seconds, None);

        let bob = stats.speakers.iter().find(|s| s.name == "Bob").unwrap();
        assert_eq!(bob.words, 1);
        assert!((bob.talk_pct - 25.0).abs() < 0.1);
    }

    #[test]
    fn filler_counting_with_phrases_and_boundaries() {
        let turns = vec![
            turn(
                "Me",
                "Um, I think so, like, you know what I mean, basically",
                0.0,
                5.0,
            ),
            turn("Them", "solike is not a filler", 5.0, 7.0), // "solike" is not "like" because word-boundary
        ];
        let stats = compute_meeting_stats(&turns, None);

        let me = stats.speakers.iter().find(|s| s.name == "Me").unwrap();
        // Fillers in Me text:
        // "Um," → token "um" after strip punctuation → match
        // "I" → no
        // "think" → no
        // "so," → token "so" after strip → match
        // "like," → match
        // "you know" → phrase match
        // "what" → no
        // "I" → no
        // "mean," → no (but "I mean" → phrase match!)
        // "basically" → match
        // Total: um(1) + so(1) + like(1) + "you know"(1) + "i mean"(1) + basically(1) = 6
        assert_eq!(me.fillers, 6);

        let them = stats.speakers.iter().find(|s| s.name == "Them").unwrap();
        // "solike" → token is "solike", cleaned is "solike" → not in the filler list
        assert_eq!(them.fillers, 0);
    }

    #[test]
    fn phrase_fillers_not_substring_matches() {
        // "you knowledge" is not "you know"; "kind offer" is not "kind of".
        let turns = vec![
            turn_untimed("Me", "you knowledge is growing"),
            turn_untimed("Them", "that was a kind offer"),
        ];
        let stats = compute_meeting_stats(&turns, None);
        for s in &stats.speakers {
            assert_eq!(s.fillers, 0, "speaker {} should have 0 fillers", s.name);
        }
    }

    #[test]
    fn phrase_fillers_with_comma_between() {
        // "you know, I mean it" — comma must not break matching since tokens are
        // punctuation-stripped: ["you", "know", "i", "mean", "it"].
        let turns = vec![turn_untimed("Me", "you know, I mean it")];
        let stats = compute_meeting_stats(&turns, None);
        assert_eq!(stats.speakers[0].fillers, 2); // "you know" + "i mean"
    }

    #[test]
    fn filler_counting_punctuation_stripping() {
        // "So," should count as filler "so" after stripping trailing comma.
        let turns = vec![turn("Me", "So, what now?", 0.0, 2.0)];
        let stats = compute_meeting_stats(&turns, None);
        let me = &stats.speakers[0];
        assert_eq!(me.fillers, 1); // "So,"
    }

    #[test]
    fn filler_rate_zero_when_no_words() {
        let turns = vec![turn("Me", "um uh", 0.0, 2.0)];
        let stats = compute_meeting_stats(&turns, None);
        let me = &stats.speakers[0];
        // "um" and "uh" are both fillers AND they're the only words
        assert_eq!(me.words, 2);
        assert_eq!(me.fillers, 2);
        assert_eq!(me.filler_rate, 1.0); // 2/2
    }

    #[test]
    fn owner_resolution_case_insensitive() {
        let turns = vec![
            turn("Hamza", "Hello", 0.0, 1.0),
            turn("Them", "Hey", 1.5, 2.5),
        ];
        let stats = compute_meeting_stats(&turns, Some("hamza"));
        assert_eq!(stats.owner.as_deref(), Some("Hamza"));

        // Fallback to "Me" when owner_label doesn't match any speaker
        let turns2 = vec![
            turn("Stranger", "Hello", 0.0, 1.0),
            turn("Me", "Hey", 1.5, 2.5),
        ];
        let stats2 = compute_meeting_stats(&turns2, Some("hamza"));
        assert_eq!(stats2.owner.as_deref(), Some("Me"));

        // No match at all
        let turns3 = vec![turn("Stranger", "Hello", 0.0, 1.0)];
        let stats3 = compute_meeting_stats(&turns3, Some("hamza"));
        assert_eq!(stats3.owner, None);
    }

    #[test]
    fn empty_input() {
        let stats = compute_meeting_stats(&[], None);
        assert!(!stats.has_timing);
        assert_eq!(stats.total_speech_seconds, None);
        assert_eq!(stats.owner, None);
        assert!(stats.speakers.is_empty());
    }
}
