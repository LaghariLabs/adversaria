//! Deterministic fact ledger for Live Copilot (local provider).
//!
//! Local answers see only the last 8 dialogue turns, so a figure read aloud
//! minutes earlier can scroll out of context before the model is asked to
//! compute with it. The ledger keeps every session sentence that states a
//! figure; the frozen snapshot travels with each LOCAL answer request.
//!
//! Pure logic, no I/O: sentence splitting, figure detection, truncation,
//! dedupe, and bounded eviction.

pub const MAX_FACTS: usize = 32;
pub const MAX_FACT_CHARS: usize = 240;
pub const MAX_LEDGER_BYTES: usize = 4_000;

const NUMBER_WORDS: &[&str] = &[
    "percent", "hundred", "thousand", "million", "billion", "trillion",
];

/// Session-scoped store of `"<Speaker>: <sentence>"` entries, oldest first.
#[derive(Debug, Default, Clone)]
pub struct FactLedger {
    entries: std::collections::VecDeque<String>,
    seen: std::collections::HashSet<String>,
}

impl FactLedger {
    /// Observe one full dialogue turn. Sentences stating a figure are kept.
    pub fn observe(&mut self, speaker: &str, text: &str) {
        for sentence in split_sentences(text) {
            let sentence = sentence.trim();
            if sentence.chars().count() < 8 {
                continue;
            }
            if !states_a_figure(sentence) {
                continue;
            }
            let prefix = format!("{speaker}: ");
            let budget = MAX_FACT_CHARS.saturating_sub(prefix.chars().count());
            let truncated = crate::copilot_provenance::truncate_word_boundary(sentence, budget);
            let entry = format!("{prefix}{truncated}");
            if !self.seen.insert(normalize(&entry)) {
                continue;
            }
            self.entries.push_back(entry);
            while self.entries.len() > MAX_FACTS || ledger_bytes(&self.entries) > MAX_LEDGER_BYTES {
                if let Some(oldest) = self.entries.pop_front() {
                    self.seen.remove(&normalize(&oldest));
                } else {
                    break;
                }
            }
        }
    }

    /// Oldest-first snapshot, frozen onto the answer job at capture time.
    pub fn snapshot(&self) -> Vec<String> {
        self.entries.iter().cloned().collect()
    }
}

/// True when the sentence contains an ASCII digit, or (case-insensitive,
/// whole word) a number word: percent, hundred, thousand, million, billion,
/// trillion.
pub fn states_a_figure(sentence: &str) -> bool {
    if sentence.chars().any(|c| c.is_ascii_digit()) {
        return true;
    }
    sentence
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|token| NUMBER_WORDS.contains(&token))
}

/// Split at `.`, `?`, `!` followed by whitespace or end of text — but never
/// at a `.` sitting between two ASCII digits (so "13.8" stays whole).
fn split_sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    for (index, &(byte, c)) in chars.iter().enumerate() {
        if c != '.' && c != '?' && c != '!' {
            continue;
        }
        let prev = if index > 0 {
            Some(chars[index - 1].1)
        } else {
            None
        };
        let next = chars.get(index + 1).map(|&(_, c)| c);
        let decimal_point = c == '.'
            && prev.is_some_and(|c| c.is_ascii_digit())
            && next.is_some_and(|c| c.is_ascii_digit());
        if decimal_point {
            continue;
        }
        if next.is_none_or(|c| c.is_whitespace()) {
            out.push(&text[start..byte + c.len_utf8()]);
            start = byte + c.len_utf8();
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

/// Lowercase, keep only alphanumerics and single spaces.
fn normalize(entry: &str) -> String {
    entry
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn ledger_bytes(entries: &std::collections::VecDeque<String>) -> usize {
    entries.iter().map(|entry| entry.len()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimals_survive_sentence_splitting() {
        let mut ledger = FactLedger::default();
        ledger.observe(
            "Them",
            "There's 13.8 trillion dollars. Of which 1.5 in org development.",
        );
        let facts = ledger.snapshot();
        assert_eq!(facts.len(), 2);
        assert!(facts[0].contains("13.8"));
        assert!(facts[1].contains("1.5"));
    }

    #[test]
    fn number_word_sentence_qualifies_and_plain_sentence_does_not() {
        assert!(states_a_figure(
            "Each hour costs four thousand two hundred dollars"
        ));
        assert!(!states_a_figure("Let us see this new notch."));
    }

    #[test]
    fn repeated_sentence_with_different_case_and_punctuation_dedupes() {
        let mut ledger = FactLedger::default();
        ledger.observe("Them", "The budget is 5 million dollars.");
        ledger.observe("Them", "THE BUDGET is 5 MILLION dollars!!");
        assert_eq!(ledger.snapshot().len(), 1);
    }

    #[test]
    fn eviction_drops_oldest_and_holds_byte_cap() {
        let mut ledger = FactLedger::default();
        for index in 0..40 {
            ledger.observe(
                "Them",
                &format!("Budget line {index} allocates 7 million dollars for phase {index}."),
            );
        }
        let facts = ledger.snapshot();
        assert_eq!(facts.len(), MAX_FACTS);
        assert!(facts[0].contains("Budget line 8"));
        assert!(facts[MAX_FACTS - 1].contains("Budget line 39"));

        let mut heavy = FactLedger::default();
        for index in 0..MAX_FACTS {
            heavy.observe(
                "Them",
                &format!(
                    "Program {index} commits 9 million dollars with a long tail of padding words \
                     to stretch every single ledger entry toward the character limit. Padding {index}."
                ),
            );
        }
        let bytes: usize = heavy.snapshot().iter().map(|entry| entry.len()).sum();
        assert!(bytes <= MAX_LEDGER_BYTES);
        assert!(heavy.snapshot().len() <= MAX_FACTS);
    }

    #[test]
    fn long_entry_is_truncated_with_speaker_prefix() {
        let mut ledger = FactLedger::default();
        let sentence = format!(
            "The program commits {} million dollars to deployment and more padding words.",
            "9 ".repeat(120)
        );
        ledger.observe("Me", &sentence);
        let facts = ledger.snapshot();
        assert_eq!(facts.len(), 1);
        assert!(facts[0].starts_with("Me: "));
        assert!(facts[0].chars().count() <= MAX_FACT_CHARS);
    }
}
