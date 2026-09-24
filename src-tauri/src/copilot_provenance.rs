//! Copilot provenance labeling and Unicode-safe text extraction helpers.

/// Canonical paths retain their case. Missing paths use lexical normalization.
pub(crate) fn canonical_path(path: &str) -> String {
    use std::path::{Component, Path, PathBuf};
    let path = Path::new(path);
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return strip_verbatim_prefix(&canonical.to_string_lossy());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if normalized.file_name().is_some_and(|name| name != "..") => {
                normalized.pop();
            }
            Component::ParentDir if normalized.has_root() && normalized.file_name().is_none() => {}
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized.to_string_lossy().into_owned()
}

/// `std::fs::canonicalize` on Windows returns extended-length paths
/// (`\\?\C:\dir\a.md`, `\\?\UNC\server\share\a.md`). The lexical
/// fallback in `canonical_path` never produces that prefix, so without stripping it the same
/// file got two different evidence keys depending on whether it existed when
/// the key was computed, and deduplication across sources broke.
pub(crate) fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// `path` spelled with this platform's separator — what `canonical_path`
/// returns for a lexical (non-existent) path. Test helper.
#[cfg(test)]
pub(crate) fn native_separators(path: &str) -> String {
    path.replace('/', std::path::MAIN_SEPARATOR_STR)
}

pub fn canonical_evidence_key(passage: &crate::types::CopilotPassage) -> String {
    match passage.source_kind.as_str() {
        "notes" => "notes".to_string(),
        "meeting" => format!("meeting:{}", passage.source_id),
        "project" => format!("project:{}", canonical_path(&passage.source_id)),
        _ => format!("file:{}", canonical_path(&passage.source_id)),
    }
}

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::types::{CopilotBullet, CopilotCitation, CopilotNote, CopilotPassage, CopilotSections};

const RUN_LENGTH: usize = 5;
const MAX_BULLETS: usize = 8;
const PROSE_FALLBACK_CHARS: usize = 160;

pub fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> String {
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

pub fn truncate_word_boundary(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let cut_byte = trimmed
        .char_indices()
        .nth(max_chars)
        .map_or(trimmed.len(), |(index, _)| index);
    let slice = &trimmed[..cut_byte];
    slice
        .rfind(char::is_whitespace)
        .map_or(slice, |index| &slice[..index])
        .trim_end()
        .to_string()
}

pub(crate) fn keyword_hit_count(text: &str, keywords: &HashSet<String>) -> usize {
    let lower = text.to_lowercase().replace("--", " ");
    lower
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .map(|word| word.trim_matches('-'))
        .filter(|word| keywords.contains(*word))
        .count()
}

pub fn excerpt_around_keywords(text: &str, keywords: &HashSet<String>, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }

    let paragraphs: Vec<&str> = trimmed
        .split("\n\n")
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .collect();
    if paragraphs.len() > 1 {
        let best = paragraphs
            .into_iter()
            .max_by_key(|paragraph| keyword_hit_count(paragraph, keywords))
            .unwrap_or(trimmed);
        return truncate_word_boundary(best, max_chars);
    }

    let lower = trimmed.to_lowercase();
    let first_match = keywords
        .iter()
        .filter_map(|keyword| lower.find(keyword))
        .min();
    let start_char = first_match
        .map(|byte| lower[..byte].chars().count().saturating_sub(max_chars / 3))
        .unwrap_or(0);
    let window: String = trimmed.chars().skip(start_char).collect();
    truncate_word_boundary(&window, max_chars)
}

fn norm_tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect()
}

fn norm_joined(text: &str) -> String {
    norm_tokens(text).join(" ")
}

fn contains_normalized_verbatim(haystack: &str, needle: &str) -> bool {
    let haystack = format!(" {} ", norm_joined(haystack));
    let needle = norm_joined(needle);
    !needle.is_empty() && haystack.contains(&format!(" {needle} "))
}

fn shares_run(left: &str, right: &str, run_length: usize) -> bool {
    let left = norm_tokens(left);
    let right = norm_tokens(right);
    if left.len() < run_length || right.len() < run_length {
        return false;
    }
    left.windows(run_length).any(|needle| {
        right
            .windows(run_length)
            .any(|candidate| needle == candidate)
    })
}

fn bullet_texts(answer_md: &str) -> Vec<String> {
    let mut bullets = Vec::new();
    for line in answer_md.lines() {
        let trimmed = line.trim();
        let text = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
            .or_else(|| trimmed.strip_prefix("• "))
            .or_else(|| {
                let (prefix, text) = trimmed.split_once(". ")?;
                prefix.chars().all(|c| c.is_ascii_digit()).then_some(text)
            });
        if let Some(text) = text.map(str::trim).filter(|text| !text.is_empty()) {
            bullets.push(text.to_string());
            if bullets.len() == MAX_BULLETS {
                break;
            }
        }
    }

    if bullets.is_empty() {
        let prose = answer_md
            .replace("<think>", " ")
            .replace("</think>", " ")
            .split(['.', '!', '?', '\n'])
            .map(str::trim)
            .find(|sentence| !sentence.is_empty())
            .map(|sentence| truncate_word_boundary(sentence, PROSE_FALLBACK_CHARS));
        if let Some(prose) = prose.filter(|text| !text.is_empty()) {
            bullets.push(prose);
        }
    }
    bullets
}

/// Assign provenance using the single five-token rule shared by both providers.
pub fn label_bullets(
    answer_md: &str,
    passages: &[CopilotPassage],
    citations: &[CopilotCitation],
    web_performed: u64,
) -> Vec<CopilotBullet> {
    label_texts(bullet_texts(answer_md), passages, citations, web_performed)
}

fn label_texts(
    texts: impl IntoIterator<Item = String>,
    passages: &[CopilotPassage],
    citations: &[CopilotCitation],
    web_performed: u64,
) -> Vec<CopilotBullet> {
    texts
        .into_iter()
        .take(MAX_BULLETS)
        .map(|text| {
            let notes_citation = citations.iter().find_map(|citation| {
                if citation.kind != "notes" {
                    return None;
                }
                let index = citation.passage_index?;
                let passage = passages.get(index)?;
                let cited_text = citation
                    .cited_text
                    .as_deref()
                    .filter(|text| !text.trim().is_empty())?;
                (contains_normalized_verbatim(&passage.text, cited_text)
                    && shares_run(&text, cited_text, RUN_LENGTH)
                    && shares_run(&text, &passage.text, RUN_LENGTH))
                .then_some(index)
            });
            let passage_index = notes_citation.or_else(|| {
                passages
                    .iter()
                    .position(|passage| shares_run(&text, &passage.text, RUN_LENGTH))
            });
            if let Some(index) = passage_index {
                return CopilotBullet {
                    text,
                    label: "notes".to_string(),
                    passage_index: Some(index),
                    url: None,
                };
            }

            if web_performed > 0 {
                if let Some(url) = citations.iter().find_map(|citation| {
                    if citation.kind != "web" {
                        return None;
                    }
                    let url = citation.url.as_ref().filter(|url| valid_web_url(url))?;
                    let cited_text = citation
                        .cited_text
                        .as_deref()
                        .filter(|text| !text.trim().is_empty())?;
                    shares_run(&text, cited_text, RUN_LENGTH).then_some(url.clone())
                }) {
                    return CopilotBullet {
                        text,
                        label: "web".to_string(),
                        passage_index: None,
                        url: Some(url),
                    };
                }
            }

            CopilotBullet {
                text,
                label: "model".to_string(),
                passage_index: None,
                url: None,
            }
        })
        .collect()
}

fn valid_web_url(value: &str) -> bool {
    url::Url::parse(value)
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}

/// Keep a trailing punctuation mark buffered until its boundary is known.
pub fn split_sentences(text: &str) -> (Vec<String>, String) {
    let mut sentences = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if ch == '\n'
            || (matches!(ch, '.' | '?' | '!')
                && chars.peek().is_some_and(|(_, next)| next.is_whitespace()))
        {
            let end = index + ch.len_utf8();
            let sentence = text[start..end].trim();
            if !sentence.is_empty() {
                sentences.push(sentence.to_string());
            }
            start = end;
        }
    }
    (sentences, text[start..].to_string())
}

/// Maximal identifier tokens: letters/digits joined by `-` or `.`.
static MODEL_TOKENIZER: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)*").expect("model-token regex")
});

/// Recognized model/version whole tokens (Astra). Protects identifier
/// spelling, not factual correctness: unverified names such as `GPT-99` or
/// `E123` are also preserved.
static MODEL_TOKEN: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?ix)\A(?:e[0-9]+(?:-[a-z0-9]+)*|gpt-[0-9]+(?:\.[0-9]+)*(?:[a-z][a-z0-9]*)?(?:-[a-z0-9]+)*|bge-(?:m[0-9]+|(?:large|base|small)(?:-(?:en|zh))?(?:-v[0-9]+(?:\.[0-9]+)*)?)|qwen[0-9]+(?:\.[0-9]+)*(?:-[a-z0-9]+)*|llama-?[0-9]+(?:\.[0-9]+)*(?:-[a-z0-9]+)*)\z",
    )
    .expect("model-name regex")
});

/// Standalone size token such as `70B`. Exempt only directly after an accepted
/// model token; a bare `We processed 70B records.` is still masked.
static SIZE_TOKEN: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\A\d+(?:\.\d+)?b\z").expect("size-token regex"));

/// Byte spans in `sentence` whose digits must survive the number rule: whole
/// accepted model tokens, plus a size token separated from one by whitespace.
fn model_token_spans(sentence: &str) -> Vec<(usize, usize)> {
    let tokens: Vec<(usize, usize, &str)> = MODEL_TOKENIZER
        .find_iter(sentence)
        .map(|token| (token.start(), token.end(), token.as_str()))
        .collect();
    let mut spans = Vec::new();
    for (index, (start, end, token)) in tokens.iter().enumerate() {
        if MODEL_TOKEN.is_match(token) {
            spans.push((*start, *end));
        } else if SIZE_TOKEN.is_match(token) && index > 0 {
            let (previous_end, previous) = (tokens[index - 1].1, tokens[index - 1].2);
            if MODEL_TOKEN.is_match(previous)
                && !sentence[previous_end..*start].is_empty()
                && sentence[previous_end..*start]
                    .chars()
                    .all(|c| c.is_whitespace())
            {
                spans.push((*start, *end));
            }
        }
    }
    spans
}

pub fn apply_number_rule(
    sentence: &str,
    question: &str,
    turns: &[String],
    passages: &[CopilotPassage],
) -> String {
    static PERSONAL: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(I|I'm|I've|I'd|we|we've|we're|my|our)\b")
            .expect("personal-claim regex")
    });
    static DIGITS: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\d[\d,.]*\d|\d").expect("digit-run regex"));
    if !PERSONAL.is_match(sentence) {
        return sentence.to_string();
    }
    let allowed: HashSet<String> = std::iter::once(question)
        .chain(turns.iter().map(String::as_str))
        .chain(passages.iter().map(|passage| passage.text.as_str()))
        .flat_map(|text| {
            DIGITS
                .find_iter(text)
                .map(|digits| digits.as_str().replace(',', ""))
        })
        .collect();
    let kept = model_token_spans(sentence);
    DIGITS
        .replace_all(sentence, |captures: &regex::Captures<'_>| {
            let digits = &captures[0];
            let span = captures.get(0).map(|found| (found.start(), found.end()));
            let in_model_token = span.is_some_and(|(start, end)| {
                kept.iter()
                    .any(|&(kept_start, kept_end)| kept_start <= start && end <= kept_end)
            });
            if in_model_token || allowed.contains(&digits.replace(',', "")) {
                digits.to_string()
            } else {
                "[number]".to_string()
            }
        })
        .into_owned()
}

pub fn parse_note_line(line: &str, passages: &[CopilotPassage]) -> Option<CopilotNote> {
    let mut parts = line.split('|').map(str::trim);
    let id = parts.next()?;
    let quote = parts.next()?.trim_matches(['"', '“', '”', '\'']).trim();
    let clause = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let id = id.strip_suffix(':').unwrap_or(id);
    let id = id
        .strip_prefix('[')
        .and_then(|id| id.strip_suffix(']'))
        .unwrap_or(id);
    let number = id.strip_prefix('P')?;
    if number.is_empty() || !number.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    let index = number.parse::<usize>().ok()?.checked_sub(1)?;
    let passage = passages.get(index)?;
    if !contains_normalized_verbatim(&passage.text, quote) {
        return None;
    }
    Some(CopilotNote {
        passage_index: Some(index),
        quote: quote.to_string(),
        clause: clause.to_string(),
        text: line.trim().to_string(),
    })
}

/// Restore the labeled answer persisted on a completed copilot card.
pub fn parse_sections(answer_md: &str, passages: &[CopilotPassage]) -> CopilotSections {
    enum Section {
        Say,
        Specific,
        Note,
        Next,
    }

    let mut sections = CopilotSections::default();
    let mut previous = None;
    for line in answer_md
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(text) = line.strip_prefix("SAY:") {
            if !text.trim().is_empty() {
                sections.say.push(text.trim().to_string());
                previous = Some(Section::Say);
            }
        } else if let Some(text) = line.strip_prefix("SPECIFIC:") {
            if !text.trim().is_empty() {
                sections.specifics.push(text.trim().to_string());
                previous = Some(Section::Specific);
            }
        } else if let Some(text) = line.strip_prefix("NOTES:") {
            if let Some(note) = parse_note_line(text.trim(), passages) {
                sections.notes.push(note);
                previous = Some(Section::Note);
            }
        } else if let Some(text) = line.strip_prefix("NEXT:") {
            if !text.trim().is_empty() {
                sections.next = Some(text.trim().to_string());
                previous = Some(Section::Next);
            }
        } else {
            let entry = match previous {
                Some(Section::Say) => sections.say.last_mut(),
                Some(Section::Specific) => sections.specifics.last_mut(),
                Some(Section::Note) => sections.notes.last_mut().map(|note| {
                    note.clause.push(' ');
                    note.clause.push_str(line);
                    &mut note.text
                }),
                Some(Section::Next) => sections.next.as_mut(),
                None => None,
            };
            if let Some(entry) = entry {
                entry.push(' ');
                entry.push_str(line);
            }
        }
    }
    sections
}

pub fn sections_to_markdown(sections: &CopilotSections) -> String {
    let mut lines = Vec::new();
    let say = sections.say.join(" ");
    if !say.trim().is_empty() {
        lines.push(format!("SAY: {say}"));
    }
    for specific in &sections.specifics {
        if !specific.trim().is_empty() {
            lines.push(format!("SPECIFIC: {specific}"));
        }
    }
    for note in &sections.notes {
        if let Some(index) = note.passage_index {
            lines.push(format!(
                "NOTES: P{} | \"{}\" | {}",
                index + 1,
                note.quote,
                note.clause
            ));
        }
    }
    if let Some(next) = sections
        .next
        .as_deref()
        .filter(|next| !next.trim().is_empty())
    {
        lines.push(format!("NEXT: {next}"));
    }
    lines.join("\n")
}

pub fn bullets_from_sections(
    sections: &CopilotSections,
    passages: &[CopilotPassage],
    citations: &[CopilotCitation],
    web_performed: u64,
) -> Vec<CopilotBullet> {
    let mut bullets = label_texts(
        sections.say.iter().chain(&sections.specifics).cloned(),
        passages,
        citations,
        web_performed,
    );
    bullets.extend(sections.notes.iter().map(|note| CopilotBullet {
        text: format!("{} ({})", note.quote, note.clause),
        label: "notes".to_string(),
        passage_index: note.passage_index,
        url: None,
    }));
    bullets.truncate(MAX_BULLETS);
    bullets
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passage(text: &str) -> CopilotPassage {
        CopilotPassage {
            source_kind: "meeting".into(),
            source_id: "1".into(),
            title: "Notes".into(),
            text: text.into(),
            score: 1.0,
        }
    }

    #[test]
    fn personal_numbers_must_be_supported_by_question_turns_or_passages() {
        let passages = vec![passage(
            "The rollout served 1500 requests with 99.9 availability.",
        )];
        let turns = vec!["Me: We had 12 workers.".into()];
        assert_eq!(
            apply_number_rule(
                "I used 12 workers for 1,500 requests over 3 days at 99.9, saving 40%.",
                "Why 3 days?",
                &turns,
                &passages
            ),
            "I used 12 workers for 1,500 requests over 3 days at 99.9, saving [number]%."
        );
        assert_eq!(
            apply_number_rule("Our queue processed 1500 jobs.", "Why 1,500?", &[], &[]),
            "Our queue processed 1500 jobs."
        );
        assert_eq!(
            apply_number_rule("My queue processed 50 jobs.", "Why 1500?", &[], &[]),
            "My queue processed [number] jobs."
        );
        assert_eq!(
            apply_number_rule("We saved 1.5 hours and 2 hours.", "Was it 1.50?", &[], &[]),
            "We saved [number] hours and [number] hours."
        );
        assert_eq!(
            apply_number_rule("We handled ١٢ tasks.", "Why ١٢?", &[], &[]),
            "We handled ١٢ tasks."
        );
    }

    #[test]
    fn model_names_survive_the_number_rule_but_metrics_do_not() {
        let sentence = "I would use models like BGE or E5 and GPT-4o with BGE-M3, BGE-large-v1.5, Qwen3.6 and Llama-3.1-70B for 40% of 2x runs in 200ms over 50k docs or 70B records.";
        assert_eq!(
            apply_number_rule(sentence, "", &[], &[]),
            "I would use models like BGE or E5 and GPT-4o with BGE-M3, BGE-large-v1.5, Qwen3.6 and Llama-3.1-70B for [number]% of [number]x runs in [number]ms over [number]k docs or [number]B records."
        );
        // A size token directly after a model token is part of the identifier.
        assert_eq!(
            apply_number_rule("I served GPT-4o 70B daily.", "", &[], &[]),
            "I served GPT-4o 70B daily."
        );
    }

    #[test]
    fn number_rule_leaves_non_personal_and_numberless_sentences_unchanged() {
        for sentence in [
            "A semaphore permits 12 workers.",
            "I used a bounded queue.",
            "They tried 4 workers.",
            "Ownership needs 2 rules.",
        ] {
            assert_eq!(apply_number_rule(sentence, "", &[], &[]), sentence);
        }
        for personal in [
            "I", "I'm", "I've", "I'd", "we", "we've", "we're", "my", "our", "WE'VE",
        ] {
            let sentence = format!("{personal} handled 42 requests.");
            assert_eq!(
                apply_number_rule(&sentence, "", &[], &[]),
                format!("{personal} handled [number] requests.")
            );
        }
    }

    #[test]
    fn note_lines_require_a_real_passage_and_normalized_quote() {
        let passages = vec![
            passage("Other notes."),
            passage("A bounded, QUEUE limits memory."),
        ];
        for id in ["P2", "[P2]", "P2:"] {
            for quote in ["\"bounded queue\"", "“bounded queue”", "'bounded queue'"] {
                let line = format!(" {id} | {quote} | bounds memory ");
                let note = parse_note_line(&line, &passages).unwrap();
                assert_eq!(note.passage_index, Some(1));
                assert_eq!(note.quote, "bounded queue");
                assert_eq!(note.clause, "bounds memory");
                assert_eq!(note.text, line.trim());
            }
        }
        for line in [
            "P0 | bounded queue | invalid index",
            "P3 | bounded queue | invalid index",
            "P999999999999999999999999 | bounded queue | invalid index",
            "P2 | invented quote | unsupported",
            "P2 | bounded queue",
            "P2 | bounded queue | clause | extra",
            "P2 | \"!!!\" | empty normalized quote",
            "P+2 | bounded queue | invalid id",
        ] {
            assert_eq!(parse_note_line(line, &passages), None, "{line}");
        }
        assert!(parse_note_line("P2 | bound | partial word", &passages).is_none());
        assert_eq!(
            parse_note_line("P1 | \"queue\" | x", &[passage("queues")]),
            None
        );
    }

    #[test]
    fn sentence_splitting_keeps_the_untrimmed_remainder() {
        assert_eq!(
            split_sentences("First sentence. Second sentence! unfinished"),
            (
                vec!["First sentence.".into(), "Second sentence!".into()],
                " unfinished".into()
            )
        );
        assert_eq!(
            split_sentences("First line\nSecond line\n  unfinished"),
            (
                vec!["First line".into(), "Second line".into()],
                "  unfinished".into()
            )
        );
        assert_eq!(
            split_sentences("مرحبا بالعالم. سؤال? بقية"),
            (
                vec!["مرحبا بالعالم.".into(), "سؤال?".into()],
                " بقية".into()
            )
        );
        assert_eq!(
            split_sentences("I saved 1.5 hours."),
            (vec![], "I saved 1.5 hours.".into())
        );
        assert_eq!(
            split_sentences("Done.\nNext? "),
            (vec!["Done.".into(), "Next?".into()], " ".into())
        );
    }

    #[test]
    fn sections_render_in_label_order_without_a_trailing_newline() {
        let sections = CopilotSections {
            say: vec!["I used a queue.".into(), "It bounds memory.".into()],
            specifics: vec!["Apply backpressure.".into(), "Bound worker count.".into()],
            notes: vec![parse_note_line(
                "P2 | bounded queue | bounds memory",
                &[passage("Other notes"), passage("bounded queue")],
            )
            .unwrap()],
            next: Some("How does it recover?".into()),
        };
        assert_eq!(sections_to_markdown(&sections), "SAY: I used a queue. It bounds memory.\nSPECIFIC: Apply backpressure.\nSPECIFIC: Bound worker count.\nNOTES: P2 | \"bounded queue\" | bounds memory\nNEXT: How does it recover?");
        assert_eq!(sections_to_markdown(&CopilotSections::default()), "");
    }

    #[test]
    fn parse_sections_round_trips_labeled_markdown() {
        let passages = vec![passage("A bounded queue limits memory.")];
        let sections = CopilotSections {
            // The existing serializer stores SAY sentences together on one line.
            say: vec!["I used a queue. It bounds memory.".into()],
            specifics: vec!["Apply backpressure.".into(), "Bound worker count.".into()],
            notes: vec![
                parse_note_line("P1 | \"bounded queue\" | bounds memory", &passages).unwrap(),
            ],
            next: Some("How does it recover?".into()),
        };
        assert_eq!(
            parse_sections(&sections_to_markdown(&sections), &passages),
            sections
        );
    }

    #[test]
    fn parse_sections_ignores_legacy_paragraphs() {
        assert_eq!(
            parse_sections("A legacy answer without labels.\nAnother paragraph.", &[]),
            CopilotSections::default()
        );
    }

    #[test]
    fn parse_sections_appends_continuations_and_skips_empty_or_invalid_entries() {
        let passages = vec![passage("A bounded queue limits memory.")];
        let sections = parse_sections(
            "Ignored preamble.\nSAY:   First.\n  Continued.\nSAY: Second.\nSAY: \n\n\
             SPECIFIC: Detail.\nMore detail.\nSPECIFIC:\n\
             NOTES: P1 | \"bounded queue\" | bounds\nmemory\n\
             NOTES: P2 | \"invented\" | invalid\nNOTES:\n\
             NEXT: First question?\nNEXT:\nNEXT: Last\nquestion?",
            &passages,
        );
        assert_eq!(sections.say, ["First. Continued.", "Second."]);
        assert_eq!(sections.specifics, ["Detail. More detail."]);
        assert_eq!(
            sections.notes,
            [parse_note_line("P1 | \"bounded queue\" | bounds memory", &passages).unwrap()]
        );
        assert_eq!(sections.next.as_deref(), Some("Last question?"));
    }

    #[test]
    fn section_bullets_keep_full_text_and_provenance_but_exclude_next() {
        let passages = vec![passage("alpha beta gamma delta epsilon recorded")];
        let citations = vec![CopilotCitation {
            kind: "web".into(),
            passage_index: None,
            cited_text: Some("current release ships this exact feature".into()),
            url: Some("https://example.com/release".into()),
            title: None,
        }];
        let model_sentence = "I would bound the queue and measure the tail latency before tuning concurrency further.";
        let mut sections = CopilotSections {
            say: vec![
                "alpha beta gamma delta epsilon is confirmed.".into(),
                model_sentence.into(),
            ],
            specifics: vec!["current release ships this exact feature".into()],
            notes: vec![
                parse_note_line("P1 | alpha beta | confirms the choice", &passages).unwrap(),
            ],
            next: Some("What fails first?".into()),
        };
        let bullets = bullets_from_sections(&sections, &passages, &citations, 1);
        assert_eq!(
            bullets
                .iter()
                .map(|bullet| bullet.label.as_str())
                .collect::<Vec<_>>(),
            vec!["notes", "model", "web", "notes"]
        );
        assert_eq!(bullets[0].passage_index, Some(0));
        assert_eq!(bullets[1].text, model_sentence);
        assert_eq!(
            bullets[2].url.as_deref(),
            Some("https://example.com/release")
        );
        assert_eq!(bullets[3].text, "alpha beta (confirms the choice)");
        assert_eq!(
            bullets_from_sections(&sections, &passages, &citations, 0)[2].label,
            "model"
        );
        sections.say = vec!["Full sentence.".into(); 9];
        assert_eq!(bullets_from_sections(&sections, &passages, &[], 0).len(), 8);
    }

    #[test]
    fn unicode_excerpt_never_slices_a_multibyte_character() {
        let text = format!("{} هدف مهم للغاية في الخطة القادمة", "你".repeat(120));
        let keywords = HashSet::from(["هدف".to_string()]);
        let excerpt = excerpt_around_keywords(&text, &keywords, 40);
        assert!(excerpt.chars().count() <= 40);
        assert!(excerpt.contains("هدف"));
    }

    #[test]
    fn provenance_requires_five_consecutive_tokens() {
        let passages = vec![passage(
            "alpha beta gamma delta epsilon appears in the notes",
        )];
        let three = label_bullets("- alpha beta gamma invented", &passages, &[], 0);
        assert_eq!(three[0].label, "model");
        let five = label_bullets(
            "- alpha beta gamma delta epsilon is confirmed",
            &passages,
            &[],
            0,
        );
        assert_eq!(five[0].label, "notes");
    }

    #[test]
    fn invalid_note_and_web_citations_do_not_promote_bullets() {
        let passages = vec![passage("one two three four five recorded here")];
        let citations = vec![
            CopilotCitation {
                kind: "notes".into(),
                passage_index: Some(0),
                cited_text: Some("one two three four five absent".into()),
                url: None,
                title: None,
            },
            CopilotCitation {
                kind: "web".into(),
                passage_index: None,
                cited_text: Some("fresh product version ships this week".into()),
                url: None,
                title: None,
            },
        ];
        let bullets = label_bullets(
            "- fresh product version ships this week",
            &passages,
            &citations,
            1,
        );
        assert_eq!(bullets[0].label, "model");
    }

    #[test]
    fn normalized_note_membership_and_http_web_urls_are_required() {
        let passages = vec![passage("Alpha, beta gamma delta epsilon is recorded.")];
        let valid_note = CopilotCitation {
            kind: "notes".into(),
            passage_index: Some(0),
            cited_text: Some("alpha beta gamma delta epsilon".into()),
            url: None,
            title: None,
        };
        let note = label_bullets(
            "- alpha beta gamma delta epsilon is supported",
            &passages,
            &[valid_note],
            0,
        );
        assert_eq!(note[0].label, "notes");

        let invalid_web = CopilotCitation {
            kind: "web".into(),
            passage_index: None,
            cited_text: Some("current release ships this exact feature".into()),
            url: Some("javascript:alert(1)".into()),
            title: None,
        };
        let web = label_bullets(
            "- current release ships this exact feature",
            &[],
            &[invalid_web],
            1,
        );
        assert_eq!(web[0].label, "model");
    }

    #[test]
    fn output_keeps_four_bullets_without_a_preamble() {
        let bullets = label_bullets("- first\n- second\n- third\n- fourth", &[], &[], 0);
        assert_eq!(bullets.len(), 4);
        assert_eq!(bullets[0].text, "first");
    }

    #[test]
    fn prose_falls_back_to_one_bounded_model_bullet() {
        let bullets = label_bullets(&format!("{}.", "word ".repeat(80)), &[], &[], 0);
        assert_eq!(bullets.len(), 1);
        assert!(bullets[0].text.chars().count() <= PROSE_FALLBACK_CHARS);
        assert_eq!(bullets[0].label, "model");
    }

    #[test]
    fn markdown_output_preserves_words_and_more_than_three_bullets() {
        let bullets = label_bullets(
            "+ one two three four five six seven eight nine ten eleven twelve thirteen\n\
             - second\n* third\n- fourth",
            &[],
            &[],
            0,
        );
        assert_eq!(bullets.len(), 4);
        assert_eq!(bullets[0].text.split_whitespace().count(), 13);
        assert_eq!(norm_joined(&bullets[1].text), "second");
    }
}

#[cfg(test)]
mod verbatim_prefix_tests {
    use super::strip_verbatim_prefix;

    #[test]
    fn strips_windows_extended_length_prefixes() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Notes\a.md"),
            r"C:\Notes\a.md"
        );
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\a.md"),
            r"\\server\share\a.md"
        );
        assert_eq!(
            strip_verbatim_prefix("/Users/a/notes.md"),
            "/Users/a/notes.md"
        );
        assert_eq!(strip_verbatim_prefix(r"C:\Notes\a.md"), r"C:\Notes\a.md");
    }
}
