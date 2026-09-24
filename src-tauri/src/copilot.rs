//! Live Copilot: "Them" question detector, local passage retrieval, and `copilot-card` events.
//!
//! Evaluates incoming live captions from the other party ("them"). When a question or prompt is
//! detected, a background consumer retrieves relevant passages from:
//! 1. Live inputs (typed notes, attached meetings/files)
//! 2. Meeting FTS (folder-prioritized)
//! 3. Context FTS (vault notes + project cards)
//! 4. Semantic enrichment (bounded by remaining budget)
//!
//! Emits "copilot-card" Tauri event with at most 3 deduplicated passages.

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::http_client::HttpClient;
use crate::types::{CopilotLiveContext, CopilotPassage};

macro_rules! info {
    ($($arg:tt)*) => {
        eprintln!("[copilot] {}", format_args!($($arg)*));
    };
}

macro_rules! debug {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("[copilot:debug] {}", format_args!($($arg)*));
        }
    };
}

/// Total retrieval budget before the pipeline returns whatever passages it has gathered.
const RETRIEVAL_BUDGET_MS: u64 = 900;
/// Minimum budget required to attempt semantic enrichment.
const MIN_SEMANTIC_BUDGET_MS: u64 = 300;
/// Maximum character length for any passage text.
const MAX_PASSAGE_CHARS: usize = 600;

/// Conversational fillers to strip from the beginning of candidate prompt sentences.
const FILLERS: &[&str] = &[
    "so", "okay", "ok", "and", "but", "well", "um", "uh", "alright", "right", "wow", "hello",
];

/// Tag questions that should never trigger the copilot.
const TAG_QUESTIONS: &[&str] = &["alright", "got it", "okay", "ok", "right", "you know"];

/// Starter keywords that indicate a question or prompt.
const PROMPT_STARTERS: &[&str] = &[
    "what",
    "how",
    "why",
    "when",
    "where",
    "which",
    "who",
    "can you",
    "could you",
    "would you",
    "do you",
    "did you",
    "have you",
    "are you",
    "is there",
    "tell me about",
    "tell me",
    "walk me through",
    "walk me",
    "describe",
    "explain",
    "talk me through",
    "define",
    "compare",
    "contrast",
    "give me an example",
    "give me",
];

/// English stopwords for keyword extraction.
const STOPWORDS: &[&str] = &[
    "a",
    "about",
    "above",
    "after",
    "again",
    "against",
    "all",
    "also",
    "am",
    "an",
    "and",
    "another",
    "any",
    "are",
    "aren't",
    "as",
    "at",
    "be",
    "because",
    "been",
    "before",
    "being",
    "below",
    "between",
    "both",
    "but",
    "by",
    "came",
    "can",
    "can't",
    "cannot",
    "come",
    "could",
    "couldn't",
    "did",
    "didn't",
    "do",
    "does",
    "doesn't",
    "doing",
    "don't",
    "down",
    "during",
    "each",
    "even",
    "few",
    "for",
    "from",
    "further",
    "get",
    "got",
    "had",
    "hadn't",
    "has",
    "hasn't",
    "have",
    "haven't",
    "having",
    "he",
    "he'd",
    "he'll",
    "he's",
    "her",
    "here",
    "here's",
    "hers",
    "herself",
    "him",
    "himself",
    "his",
    "how",
    "how's",
    "i",
    "i'd",
    "i'll",
    "i'm",
    "i've",
    "if",
    "in",
    "into",
    "is",
    "isn't",
    "it",
    "it's",
    "its",
    "itself",
    "just",
    "let's",
    "like",
    "make",
    "many",
    "me",
    "more",
    "most",
    "much",
    "must",
    "mustn't",
    "my",
    "myself",
    "never",
    "no",
    "nor",
    "not",
    "now",
    "of",
    "off",
    "on",
    "once",
    "only",
    "or",
    "other",
    "ought",
    "our",
    "ours",
    "ourselves",
    "out",
    "over",
    "own",
    "really",
    "same",
    "shan't",
    "she",
    "she'd",
    "she'll",
    "she's",
    "should",
    "shouldn't",
    "so",
    "some",
    "such",
    "tell",
    "than",
    "that",
    "that's",
    "the",
    "their",
    "theirs",
    "them",
    "themselves",
    "then",
    "there",
    "there's",
    "these",
    "they",
    "they'd",
    "they'll",
    "they're",
    "they've",
    "this",
    "those",
    "through",
    "to",
    "too",
    "under",
    "until",
    "up",
    "very",
    "was",
    "wasn't",
    "we",
    "we'd",
    "we'll",
    "we're",
    "we've",
    "well",
    "were",
    "weren't",
    "what",
    "what's",
    "whatever",
    "when",
    "when's",
    "where",
    "where's",
    "which",
    "while",
    "who",
    "who's",
    "whom",
    "why",
    "why's",
    "will",
    "with",
    "won't",
    "would",
    "wouldn't",
    "yeah",
    "yes",
    "you",
    "you'd",
    "you'll",
    "you're",
    "you've",
    "your",
    "yours",
    "yourself",
    "yourselves",
];

/// Generic words excluded from FTS queries to avoid broad, low-relevance matches.
const GENERIC_WORDS: &[&str] = &[
    "system", "systems", "thing", "things", "people", "meeting", "question", "project", "work",
    "time", "today", "going", "think", "know", "really", "right", "okay", "like", "want", "need",
    "make", "said", "talk", "talking", "discuss", "tell",
];

/// Strips leading conversational fillers from a lowercase string slice.
fn strip_leading_fillers(mut text: &str) -> &str {
    let mut changed = true;
    while changed {
        changed = false;
        text = text
            .trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == '-' || c == ':');
        for filler in FILLERS {
            if let Some(rest) = text.strip_prefix(filler) {
                if rest.is_empty() || rest.starts_with(|c: char| !c.is_alphanumeric()) {
                    text = rest;
                    changed = true;
                    break;
                }
            }
        }
    }
    text.trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == '-' || c == ':')
}

/// A bounded question selected by the cheap trigger policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub text: String,
    pub ambiguous: bool,
    pub reason: &'static str,
}

const NARRATION_PREFIXES: &[&str] = &[
    "so what the",
    "what the",
    "as you can see",
    "so as you can see",
    "this is",
    "here is",
    "here's",
    "what i built",
    "what i'm building",
    "let me show",
    "i'll show",
];
const WAKE_WORDS: &[&str] = &["hey copilot", "co-pilot", "copilot"];

/// Recognize a wake word only at the beginning, preserving the remainder's case.
pub fn strip_wake_word(turn: &str) -> Option<&str> {
    let turn = turn.trim_start();
    WAKE_WORDS.iter().find_map(|wake| {
        let prefix = turn.get(..wake.len())?;
        let rest = turn.get(wake.len()..)?;
        (prefix.eq_ignore_ascii_case(wake)
            && (rest.is_empty()
                || rest.starts_with(|c: char| c.is_whitespace() || c == ',' || c == ':')))
        .then(|| rest.trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ':'))
    })
}

/// Whole-sentence greetings/fillers that are never requests on their own.
/// Matching is exact on the normalized sentence, never a prefix, so a greeting
/// sharing a sentence with a request ("Hello, what are LLMs?") stays eligible.
const NOISE_SENTENCES: &[&str] = &[
    "hello",
    "hi",
    "hey",
    "halo",
    "hey whats happening",
    "whats up",
    "how are you",
    "hows it going",
    "good morning",
    "can you hear me",
    "are you there",
    "ok and",
    "okay and",
    "okay",
    "ok",
    "right",
    "alright",
    "got it",
    "you know",
];

/// Imperative starters with a separate minimum: at least one non-punctuation
/// token after the verb ("Define RAG." qualifies; "Tell me about." is rejected).
const BARE_VERB_STARTERS: &[&str] = &["define", "compare", "contrast"];

/// T1 reported-request pattern (Astra): a comma, a wh-word, 0-3 intervening
/// tokens, then an auxiliary + you/we. Applied to a sentence without its
/// terminal punctuation. Deliberately misses comma-free captions and can admit
/// reported speech such as "She asked, what would you choose."
static T1_REPORTED_REQUEST: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i),\s*(?:what|how|which|why|where|when|who)\b(?:\s+[\p{L}\p{N}]+(?:['’][\p{L}]+)?){0,3}\s+(?:will|would|do|can|could|should|did)\s+(?:you|we)\b",
    )
    .expect("T1 reported-request regex")
});

/// Comparison separator (Astra): `versus` or `vs`/`vs.` between operands.
static COMPARISON_SEPARATOR: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)\s+(?:versus|vs\.?)\s+").expect("comparison separator regex")
});

/// Normalize a sentence for the noise check: lowercase, straighten then delete
/// apostrophes, replace other punctuation with spaces, collapse whitespace.
fn normalize_noise_sentence(sentence: &str) -> String {
    let straight = sentence.replace(['‘', '’'], "'");
    let no_apostrophes: String = straight.chars().filter(|&c| c != '\'').collect();
    no_apostrophes
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Shared greeting/filler veto: the whole normalized sentence must match the
/// noise list, or every token must be a conversational filler. A single
/// leading greeting token ("Hello, can you hear me?") does not rescue the
/// sentence: strip one greeting token and re-apply the same veto to the
/// remainder, so a greeting glued to a request ("Hello, what are LLMs?")
/// stays eligible.
fn is_noise_sentence(sentence: &str) -> bool {
    let normalized = normalize_noise_sentence(sentence);
    if normalized.is_empty() {
        return false;
    }
    if NOISE_SENTENCES.contains(&normalized.as_str()) {
        return true;
    }
    if normalized
        .split_whitespace()
        .all(|token| FILLERS.contains(&token))
    {
        return true;
    }
    const GREETING_PREFIX_TOKENS: &[&str] = &["hello", "hi", "hey", "halo", "hiya"];
    if let Some((first, rest)) = normalized.split_once(' ') {
        if GREETING_PREFIX_TOKENS.contains(&first) && !rest.trim().is_empty() {
            let remainder = rest.trim();
            if NOISE_SENTENCES.contains(&remainder) {
                return true;
            }
            if remainder
                .split_whitespace()
                .all(|token| FILLERS.contains(&token))
            {
                return true;
            }
        }
    }
    false
}

/// Count non-punctuation (alphanumeric) tokens after a leading starter verb.
fn tokens_after_starter(stripped: &str, starter: &str) -> usize {
    stripped
        .get(starter.len()..)
        .map(|rest| {
            rest.split(|c: char| !c.is_alphanumeric())
                .filter(|token| !token.is_empty())
                .count()
        })
        .unwrap_or(0)
}

/// Comparison request (Astra): normalized to lowercase, 3-8 tokens, non-empty
/// operands around `versus` / `vs` / `vs.`. Admits headings/narration such as
/// "Speed versus accuracy."; the gate handles those.
fn is_comparison_request(stripped: &str) -> bool {
    let normalized = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    if !(3..=8).contains(&normalized.split_whitespace().count()) {
        return false;
    }
    let Some(separator) = COMPARISON_SEPARATOR.find(&normalized) else {
        return false;
    };
    !normalized[..separator.start()].trim().is_empty()
        && !normalized[separator.end()..].trim().is_empty()
}

/// A period directly after a word-boundary "vs" belongs to the abbreviation,
/// not to a sentence boundary ("Rust vs. Go." stays one sentence).
fn is_vs_period(text: &str, period_index: usize) -> bool {
    let before = &text[..period_index];
    let Some(vs_start) = before.len().checked_sub(2) else {
        return false;
    };
    let Some(vs) = before.get(vs_start..) else {
        return false;
    };
    vs.eq_ignore_ascii_case("vs")
        && before
            .get(..vs_start)
            .is_some_and(|head| head.ends_with(|c: char| !c.is_alphanumeric()) || head.is_empty())
}

fn prompt_sentences(text: &str) -> Vec<&str> {
    let text = if let Some((prefix, rest)) = text.split_once(':') {
        if !prefix.contains(['.', '?', '!']) && prefix.split_whitespace().count() <= 3 {
            rest.trim()
        } else {
            text.trim()
        }
    } else {
        text.trim()
    };
    // Same split points as `split_inclusive(['.', '?', '!'])`, except a period
    // that belongs to the "vs." abbreviation never ends a sentence.
    let mut sentences = Vec::new();
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        if !matches!(ch, '.' | '?' | '!') {
            continue;
        }
        if ch == '.' && is_vs_period(text, index) {
            continue;
        }
        let end = index + ch.len_utf8();
        let sentence = text[start..end].trim();
        if !sentence.trim_matches(['.', '?', '!']).trim().is_empty() {
            sentences.push(sentence);
        }
        start = end;
    }
    let tail = text[start..].trim();
    if !tail.trim_matches(['.', '?', '!']).trim().is_empty() {
        sentences.push(tail);
    }
    sentences
}

fn is_prompt_sentence(sentence: &str) -> bool {
    // The greeting/filler veto runs before the unconditional `?` acceptance.
    if is_noise_sentence(sentence) {
        return false;
    }
    let raw = sentence.trim_end_matches(['.', '?', '!']).trim();
    let lower = raw.to_lowercase();
    let clean: String = lower
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect();
    if sentence.ends_with('?') && TAG_QUESTIONS.contains(&clean.trim()) {
        return false;
    }
    let stripped = strip_leading_fillers(&lower);
    let has_starter = PROMPT_STARTERS
        .iter()
        .any(|starter| starts_with_phrase(stripped, starter));
    let bare_verb_ok = BARE_VERB_STARTERS.iter().any(|verb| {
        starts_with_phrase(stripped, verb) && tokens_after_starter(stripped, verb) >= 1
    });
    let reported_request = T1_REPORTED_REQUEST.is_match(raw);
    let comparison = is_comparison_request(stripped);
    let word_count = raw.split_whitespace().count();
    if sentence.ends_with('?') {
        true
    } else {
        (has_starter && word_count > 3) || bare_verb_ok || reported_request || comparison
    }
}

fn starts_with_phrase(text: &str, phrase: &str) -> bool {
    text.strip_prefix(phrase)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(|c: char| !c.is_alphanumeric()))
}

/// Sentence-level question and prompt detector, including starter-only prompts.
pub fn is_prompt(text: &str) -> bool {
    prompt_sentences(text).into_iter().any(is_prompt_sentence)
}

/// Select at most one candidate per turn, holding every qualifying prompt sentence.
/// Reject narration and quoted examples; route uncertain turns to the local gate.
pub fn classify_candidates(turn: &str) -> Vec<Candidate> {
    let sentences = prompt_sentences(turn);
    let mut texts: Vec<&str> = Vec::new();
    let mut reasons: Vec<&'static str> = Vec::new();
    for (index, sentence) in sentences.iter().enumerate() {
        if !is_prompt_sentence(sentence) {
            continue;
        }
        if let Some(candidate) = classify_sentence(turn, &sentences, index) {
            texts.push(sentences[index]);
            reasons.push(candidate.reason);
        }
    }
    if texts.is_empty() {
        return Vec::new();
    }
    let reason = if reasons.contains(&"possibly_answered_in_turn") {
        "possibly_answered_in_turn"
    } else if reasons.contains(&"bare_pronoun") {
        "bare_pronoun"
    } else if reasons.contains(&"long_turn") {
        "long_turn"
    } else if reasons.contains(&"direct_question") {
        "direct_question"
    } else if reasons.contains(&"embedded_question") {
        "embedded_question"
    } else {
        "starter_only"
    };
    vec![Candidate {
        text: texts.join(" "),
        ambiguous: reason != "direct_question",
        reason,
    }]
}

fn is_signoff(sentence: &str) -> bool {
    matches!(
        sentence
            .trim_end_matches(['.', '?', '!'])
            .to_lowercase()
            .as_str(),
        "bye" | "goodbye" | "thanks" | "thank you"
    )
}

/// Backchannel tag questions ("Alright?", "Got it?") are explicitly not
/// requests, so they must not count as in-turn answers to a nearby question.
fn is_tag_question(sentence: &str) -> bool {
    if !sentence.ends_with('?') {
        return false;
    }
    let clean: String = sentence
        .trim_end_matches(['.', '?', '!'])
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect();
    TAG_QUESTIONS.contains(&clean.trim())
}

fn classify_sentence(turn: &str, sentences: &[&str], index: usize) -> Option<Candidate> {
    let candidate = sentences[index];
    let lower = candidate.to_lowercase();
    let stripped = strip_leading_fillers(&lower);
    if NARRATION_PREFIXES
        .iter()
        .any(|prefix| starts_with_phrase(stripped, prefix))
    {
        return None;
    }
    let turn_lower = turn.to_lowercase();
    let example = turn_lower.contains("for example") || turn_lower.contains("let's say");
    // A sign-off or another request is not a substantive continuation of a quoted
    // example. Reject the question only when a later sentence keeps talking about
    // the example instead of asking something.
    let trailing_signoff = index + 1 < sentences.len()
        && sentences[index + 1..]
            .iter()
            .all(|sentence| is_signoff(sentence));
    let substantive_continuation = sentences[index + 1..].iter().any(|sentence| {
        !is_prompt_sentence(sentence)
            && !is_noise_sentence(sentence)
            && !is_signoff(sentence)
            && sentence.split_whitespace().count() >= 3
    });
    if example && substantive_continuation {
        return None;
    }
    let answered_in_turn = sentences[index + 1..].iter().any(|sentence| {
        !is_prompt_sentence(sentence)
            && !is_noise_sentence(sentence)
            && sentence.split_whitespace().count() >= 3
    });
    // Short answer fragments between two questions (card 191) also require the
    // full-turn gate even though the last question itself looks direct.
    // Backchannel tags ("Got it?") are not answers.
    let earlier_answer = sentences[..index].iter().enumerate().any(|(i, sentence)| {
        is_prompt_sentence(sentence)
            && sentences[i + 1..index].iter().any(|next| {
                !is_prompt_sentence(next) && !is_noise_sentence(next) && !is_tag_question(next)
            })
    });
    let pronoun = ["it", "that", "this", "they", "he", "she", "those", "these"]
        .iter()
        .any(|pronoun| {
            stripped
                .split(|c: char| !c.is_alphanumeric())
                .any(|word| word == *pronoun)
        })
        && extract_keywords(candidate).is_empty();
    let reason = if answered_in_turn || earlier_answer {
        "possibly_answered_in_turn"
    } else if pronoun {
        "bare_pronoun"
    } else if turn.split_whitespace().count() > 40 {
        "long_turn"
    } else if !candidate.ends_with('?') {
        "starter_only"
    } else if example && trailing_signoff {
        "embedded_question"
    } else {
        "direct_question"
    };
    let text = candidate.to_string();
    Some(Candidate {
        text,
        ambiguous: reason != "direct_question",
        reason,
    })
}

/// Extract searchable keywords, normalizing possessives and the spoken LLM acronym.
/// Hyphenated words count as one keyword (e.g. "air-gapped").
pub fn extract_keywords(text: &str) -> HashSet<String> {
    let lower = text.to_lowercase().replace("--", " ").replace('’', "'");
    lower
        .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '\'')
        .map(|w| w.trim_matches(['-', '\'']))
        .filter(|w| !STOPWORDS.contains(w) && !FILLERS.contains(w))
        .map(|w| w.strip_suffix("'s").unwrap_or(w))
        .map(|w| if w == "llms" { "llm" } else { w })
        .filter(|w| (w.len() >= 4 || *w == "llm") && !STOPWORDS.contains(w))
        .map(str::to_string)
        .collect()
}

/// Empty keyword sets do not supply evidence of a shared intent.
pub fn keyword_jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f32 {
    let union = a.union(b).count();
    if union == 0 {
        0.0
    } else {
        a.intersection(b).count() as f32 / union as f32
    }
}

/// Extract candidate FTS keywords: length >= 4, not in stopwords, not in generic words.
/// Deduplicated in encounter order. Hyphenated words count as one keyword.
pub fn extract_fts_keywords(text: &str) -> Vec<String> {
    extract_fts_keywords_for_folder(text, &HashSet::new())
}

pub(crate) fn is_specific_word(word: &str) -> bool {
    !STOPWORDS.contains(&word) && !GENERIC_WORDS.contains(&word)
}

pub fn extract_fts_keywords_for_folder(text: &str, terms: &HashSet<String>) -> Vec<String> {
    let lower = text.to_lowercase().replace("--", " ");
    let mut seen = HashSet::new();
    let mut keywords = Vec::new();

    for raw in lower.split(|c: char| !c.is_alphanumeric() && c != '-') {
        let w = raw.trim_matches('-');
        if (w.chars().count() >= 4 || ((2..=3).contains(&w.chars().count()) && terms.contains(w)))
            && is_specific_word(w)
            && seen.insert(w.to_string())
        {
            keywords.push(w.to_string());
        }
    }

    keywords
}

/// Whether the extracted keywords meet the floor to run FTS tiers:
/// - >= 2 specific keywords, OR
/// - 1 single rare keyword of length >= 7 (e.g. "air-gapped", "kubernetes").
pub fn qualifies_for_fts(keywords: &[String]) -> bool {
    if keywords.len() >= 2 {
        true
    } else if keywords.len() == 1 {
        keywords[0].len() >= 7
    } else {
        false
    }
}

/// Score an FTS hit by keyword coverage: 0.75 * (matched / total).
pub fn fts_coverage_score(matched_keywords: usize, query_keywords: usize) -> f32 {
    if query_keywords == 0 {
        return 0.0;
    }
    0.75 * (matched_keywords as f32 / query_keywords as f32)
}

/// Strips a leading line from `text` that equals `title` (optionally followed by ` (YYYY-MM-DD)`),
/// so the passage body never repeats the meeting chip.
pub fn strip_title_line<'a>(text: &'a str, title: &str) -> &'a str {
    let title_trimmed = title.trim();
    if title_trimmed.is_empty() {
        return text;
    }

    let trimmed = text.trim_start();
    let (first_line, rest) = match trimmed.split_once('\n') {
        Some((fl, r)) => (fl, r),
        None => (trimmed, ""),
    };

    let fl = first_line.trim_end_matches('\r').trim();
    let is_title_line = if let Some(rem) = fl.strip_prefix(title_trimmed) {
        let rem_trimmed = rem.trim();
        if rem_trimmed.is_empty() {
            true
        } else if let Some(inner) = rem_trimmed
            .strip_prefix('(')
            .and_then(|s| s.strip_suffix(')'))
        {
            inner.len() == 10
                && inner.chars().enumerate().all(|(i, c)| {
                    if i == 4 || i == 7 {
                        c == '-'
                    } else {
                        c.is_ascii_digit()
                    }
                })
        } else {
            false
        }
    } else {
        false
    };

    if is_title_line {
        rest.trim_start_matches('\r')
            .trim_start_matches('\n')
            .trim_start()
    } else {
        text
    }
}

/// Execute the bounded multi-tier retrieval pipeline for one frozen question.
pub async fn retrieve_passages(
    client: &HttpClient,
    live: &CopilotLiveContext,
    question: &str,
    previous_them: Option<&str>,
) -> (Vec<CopilotPassage>, u64) {
    let start = Instant::now();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(RETRIEVAL_BUDGET_MS);
    let query = if question.split_whitespace().count() < 6 {
        previous_them.map_or_else(
            || question.to_string(),
            |previous| format!("{question} {previous}"),
        )
    } else {
        question.to_string()
    };

    let sync_live = live.clone();
    let sync_query = query.clone();
    let (mut passages, mut tiers_hit) = run_blocking_until(deadline, move || {
        crate::storage::connect_for_sync()
            .map(|conn| retrieve_sync_tiers(&conn, &sync_live, &sync_query))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default();

    let minimum_semantic_budget = Duration::from_millis(MIN_SEMANTIC_BUDGET_MS);
    let mut semantic_ran = false;
    if let Some(folder_id) = live.folder_id {
        if deadline.saturating_duration_since(tokio::time::Instant::now()) > minimum_semantic_budget
        {
            semantic_ran = true;
            let semantic = tokio::time::timeout_at(
                deadline,
                retrieve_semantic_tier(client, &query, folder_id, deadline),
            )
            .await
            .unwrap_or_default();
            if !semantic.is_empty() {
                tiers_hit.push("semantic");
                passages.extend(semantic);
            }
        }
    }
    if semantic_ran {
        passages.retain(|passage| passage.score >= 0.375);
    }

    let mut passages = dedup_and_sort_passages(passages);
    passages.truncate(3);
    let retrieval_ms = start.elapsed().as_millis() as u64;
    info!(
        "question_len={}, tiers=[{}], passages={}, retrieval_ms={}",
        question.len(),
        tiers_hit.join(","),
        passages.len(),
        retrieval_ms
    );
    (passages, retrieval_ms)
}

pub(crate) fn dedup_and_sort_passages(passages: Vec<CopilotPassage>) -> Vec<CopilotPassage> {
    use crate::copilot_provenance::canonical_evidence_key;
    let mut deduplicated: std::collections::HashMap<String, CopilotPassage> =
        std::collections::HashMap::new();
    for passage in passages {
        let key = canonical_evidence_key(&passage);
        match deduplicated.get(&key) {
            Some(existing) if passage_order(existing, &passage) != std::cmp::Ordering::Greater => {}
            _ => {
                deduplicated.insert(key, passage);
            }
        }
    }
    let mut passages: Vec<_> = deduplicated.into_values().collect();
    passages.sort_by(passage_order);
    passages
}

fn passage_order(left: &CopilotPassage, right: &CopilotPassage) -> std::cmp::Ordering {
    // The tier-d score reaches this value exactly only at full coverage.
    let full = |p: &CopilotPassage| p.source_kind == "folder" && p.score >= 0.86 + 0.10;
    full(right)
        .cmp(&full(left))
        .then_with(|| right.score.total_cmp(&left.score))
        .then_with(|| {
            crate::copilot_provenance::canonical_evidence_key(left)
                .cmp(&crate::copilot_provenance::canonical_evidence_key(right))
        })
}

/// Run every SQLite/FTS/file tier on the blocking pool while sharing the
/// caller's one absolute deadline. Dropping this future on card cancellation
/// detaches the blocking task but immediately stops all result propagation.
async fn run_blocking_until<T, F>(deadline: tokio::time::Instant, work: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    match tokio::time::timeout_at(deadline, tokio::task::spawn_blocking(work)).await {
        Ok(Ok(result)) => Some(result),
        Ok(Err(error)) => {
            debug!("copilot blocking retrieval failed: {error}");
            None
        }
        Err(_) => {
            debug!("copilot blocking retrieval reached the absolute deadline");
            None
        }
    }
}

/// Retrieve synchronous tiers (Live inputs, Meeting FTS, Context FTS) using a given connection.
pub fn retrieve_sync_tiers(
    conn: &Connection,
    live: &CopilotLiveContext,
    query: &str,
) -> (Vec<CopilotPassage>, Vec<&'static str>) {
    let mut passages = Vec::new();
    let mut tiers_hit = Vec::new();
    let query_keywords = extract_keywords(query);

    // -----------------------------------------------------------------------
    // Tier a: Live inputs
    // -----------------------------------------------------------------------
    let mut live_hit = false;

    // 1. Typed notes lines
    let mut best_note_line: Option<(&str, usize)> = None;
    for line in live.notes.lines() {
        let line_trimmed = line.trim();
        if line_trimmed.is_empty() {
            continue;
        }
        let line_keywords = extract_keywords(line_trimmed);
        let shared = query_keywords.intersection(&line_keywords).count();
        if shared >= 2 && best_note_line.is_none_or(|(_, best)| shared > best) {
            best_note_line = Some((line_trimmed, shared));
        }
    }

    if let Some((line, _)) = best_note_line {
        live_hit = true;
        passages.push(CopilotPassage {
            source_kind: "notes".to_string(),
            source_id: "notes".to_string(),
            title: "Notes".to_string(),
            text: crate::copilot_provenance::truncate_word_boundary(line, MAX_PASSAGE_CHARS),
            score: 0.9,
        });
    }

    // 2. Attached meetings and files
    for attachment in &live.attachments {
        if attachment.kind == "meeting" {
            if let Ok(meeting_id) = attachment.value.parse::<i64>() {
                if let Ok(Some(meeting)) = crate::storage::get_meeting_on(conn, meeting_id) {
                    live_hit = true;
                    let text_body = if !meeting.summary.is_empty() {
                        &meeting.summary
                    } else {
                        &meeting.transcript
                    };
                    let stripped = strip_title_line(text_body, &meeting.title);
                    let excerpt = crate::copilot_provenance::excerpt_around_keywords(
                        stripped,
                        &query_keywords,
                        MAX_PASSAGE_CHARS,
                    );
                    let date = meeting
                        .recorded_at
                        .get(..10)
                        .unwrap_or(&meeting.recorded_at);
                    let title = if date.is_empty() {
                        meeting.title
                    } else {
                        format!("{} ({date})", meeting.title)
                    };

                    passages.push(CopilotPassage {
                        source_kind: "meeting".to_string(),
                        source_id: meeting_id.to_string(),
                        title,
                        text: excerpt,
                        score: 0.85,
                    });
                }
            }
        } else {
            let path = std::path::Path::new(&attachment.value);
            if path.exists() {
                if let Ok(file) = std::fs::File::open(path) {
                    use std::io::Read;
                    let mut buffer = String::new();
                    let mut handle = file.take(20 * 1024);
                    if handle.read_to_string(&mut buffer).is_ok() && !buffer.trim().is_empty() {
                        live_hit = true;
                        let excerpt = crate::copilot_provenance::excerpt_around_keywords(
                            &buffer,
                            &query_keywords,
                            MAX_PASSAGE_CHARS,
                        );
                        let title = if attachment.label.is_empty() {
                            path.file_name()
                                .map(|f| f.to_string_lossy().to_string())
                                .unwrap_or_else(|| "Attached File".to_string())
                        } else {
                            attachment.label.clone()
                        };

                        passages.push(CopilotPassage {
                            source_kind: "attachment".to_string(),
                            source_id: attachment.value.clone(),
                            title,
                            text: excerpt,
                            score: 0.8,
                        });
                    }
                }
            }
        }
    }

    if live_hit {
        tiers_hit.push("live");
    }

    let Some(folder_id) = live.folder_id else {
        return (passages, vec!["live"]);
    };
    let folder_ids = crate::storage::folder_meeting_ids_on(conn, folder_id).unwrap_or_default();
    let sources = crate::storage::folder_source_paths_on(conn, folder_id).unwrap_or_default();

    // -----------------------------------------------------------------------
    // Tier b: Meeting FTS
    // -----------------------------------------------------------------------
    let fts_keywords = extract_fts_keywords(query);
    let fts_eligible = qualifies_for_fts(&fts_keywords);

    if fts_eligible && !folder_ids.is_empty() {
        let fts_query = fts_keywords.join(" ");
        let fts_keywords_set: HashSet<String> = fts_keywords.iter().cloned().collect();

        if let Ok(all_meeting_ids) = crate::storage::search_meeting_ids_on(conn, &fts_query, 10) {
            let target_ids: Vec<i64> = all_meeting_ids
                .into_iter()
                .filter(|id| folder_ids.contains(id))
                .collect();

            let mut fts_passages = Vec::new();
            for &meeting_id in &target_ids {
                if let Ok(Some(meeting)) = crate::storage::get_meeting_on(conn, meeting_id) {
                    let chunk_texts = crate::storage::get_meeting_chunk_texts_on(conn, meeting_id)
                        .unwrap_or_default();

                    let mut full_text = format!(
                        "{} {} {}",
                        meeting.title, meeting.summary, meeting.transcript
                    );
                    for chunk in &chunk_texts {
                        full_text.push(' ');
                        full_text.push_str(chunk);
                    }
                    let meeting_words = extract_keywords(&full_text);
                    let matched_count = fts_keywords
                        .iter()
                        .filter(|kw| meeting_words.contains(kw.as_str()))
                        .count();

                    if matched_count == 0 {
                        continue;
                    }

                    let score = fts_coverage_score(matched_count, fts_keywords.len());

                    let raw_text = if !chunk_texts.is_empty() {
                        let mut best_chunk = &chunk_texts[0];
                        let mut best_hits = 0;
                        for chunk in &chunk_texts {
                            let hits = crate::copilot_provenance::keyword_hit_count(
                                chunk,
                                &fts_keywords_set,
                            );
                            if hits > best_hits {
                                best_hits = hits;
                                best_chunk = chunk;
                            }
                        }
                        strip_title_line(best_chunk, &meeting.title)
                    } else {
                        let summary_body = if !meeting.summary.is_empty() {
                            &meeting.summary
                        } else {
                            &meeting.transcript
                        };
                        strip_title_line(summary_body, &meeting.title)
                    };

                    let text = if !chunk_texts.is_empty() {
                        crate::copilot_provenance::truncate_word_boundary(
                            raw_text,
                            MAX_PASSAGE_CHARS,
                        )
                    } else {
                        crate::copilot_provenance::excerpt_around_keywords(
                            raw_text,
                            &fts_keywords_set,
                            MAX_PASSAGE_CHARS,
                        )
                    };

                    let date = meeting
                        .recorded_at
                        .get(..10)
                        .unwrap_or(&meeting.recorded_at);
                    let title = if date.is_empty() {
                        meeting.title
                    } else {
                        format!("{} ({date})", meeting.title)
                    };

                    fts_passages.push(CopilotPassage {
                        source_kind: "meeting".to_string(),
                        source_id: meeting_id.to_string(),
                        title,
                        text,
                        score,
                    });
                }
            }

            if !fts_passages.is_empty() {
                tiers_hit.push("meeting_fts");
                fts_passages.sort_by(|a, b| {
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                passages.extend(fts_passages);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Tier c: Context FTS (vault + project)
    // -----------------------------------------------------------------------
    if fts_eligible && !sources.is_empty() {
        let fts_query = fts_keywords.join(" ");
        let fts_keywords_set: HashSet<String> = fts_keywords.iter().cloned().collect();

        if let Ok(doc_ids) = crate::storage::search_context_doc_ids_on(conn, &fts_query, None, 50) {
            if !doc_ids.is_empty() {
                if let Ok(docs) = crate::storage::get_context_docs_on(conn, &doc_ids) {
                    let mut context_passages = Vec::new();
                    for doc in &docs {
                        if !crate::folder_sources::path_in_sources(&doc.path, &sources) {
                            continue;
                        }
                        let doc_text = format!("{} {}", doc.title, doc.body);
                        let doc_words = extract_keywords(&doc_text);
                        let matched_count = fts_keywords
                            .iter()
                            .filter(|kw| doc_words.contains(kw.as_str()))
                            .count();

                        if matched_count == 0 {
                            continue;
                        }

                        let score = fts_coverage_score(matched_count, fts_keywords.len());
                        let excerpt = crate::copilot_provenance::excerpt_around_keywords(
                            &doc.body,
                            &fts_keywords_set,
                            MAX_PASSAGE_CHARS,
                        );

                        context_passages.push(CopilotPassage {
                            source_kind: doc.source.clone(),
                            source_id: doc.path.clone(),
                            title: doc.title.clone(),
                            text: excerpt,
                            score,
                        });
                    }

                    if !context_passages.is_empty() {
                        tiers_hit.push("context_fts");
                        context_passages.sort_by(|a, b| {
                            b.score
                                .partial_cmp(&a.score)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        });
                        passages.extend(context_passages);
                    }
                }
            }
        }
    }

    // Tier d: Documents indexed directly from this folder's sources.
    let terms = crate::storage::get_folder_terms_on(conn, folder_id)
        .unwrap_or_default()
        .into_iter()
        .collect();
    let fts_keywords = extract_fts_keywords_for_folder(query, &terms);
    if !fts_keywords.is_empty() {
        let fts_query = fts_keywords.join(" ");
        let keywords: HashSet<String> = fts_keywords.iter().cloned().collect();
        if let Ok(ids) = crate::storage::search_folder_doc_ids_on(conn, folder_id, &fts_query, 10) {
            if let Ok(docs) = crate::storage::get_folder_docs_on(conn, &ids) {
                let mut folder_hit = false;
                for (_, path, title, body) in docs {
                    let words: HashSet<_> =
                        extract_fts_keywords_for_folder(&format!("{title} {body}"), &terms)
                            .into_iter()
                            .collect();
                    let matched = fts_keywords
                        .iter()
                        .filter(|word| words.contains(word.as_str()))
                        .count();
                    if matched == 0 {
                        continue;
                    }
                    folder_hit = true;
                    passages.push(CopilotPassage {
                        source_kind: "folder".to_string(),
                        source_id: path,
                        title,
                        text: crate::copilot_provenance::excerpt_around_keywords(
                            &body,
                            &keywords,
                            MAX_PASSAGE_CHARS,
                        ),
                        score: 0.86 + 0.10 * (matched as f32 / fts_keywords.len() as f32),
                    });
                }
                if folder_hit {
                    tiers_hit.push("folder");
                }
            }
        }
    }

    (passages, tiers_hit)
}

/// Retrieve semantic tier candidates within remaining budget.
async fn retrieve_semantic_tier(
    client: &HttpClient,
    query: &str,
    folder_id: i64,
    deadline: tokio::time::Instant,
) -> Vec<CopilotPassage> {
    let Some((folder_ids, sources)) = run_blocking_until(deadline, move || {
        let conn = crate::storage::connect_for_sync().ok()?;
        Some((
            crate::storage::folder_meeting_ids_on(&conn, folder_id).ok()?,
            crate::storage::folder_source_paths_on(&conn, folder_id).ok()?,
        ))
    })
    .await
    .flatten() else {
        return Vec::new();
    };
    let mut results = Vec::new();

    // 1. Related meetings. The embedding request is async; chunk loading,
    // vector ranking, and meeting hydration all stay on the blocking pool.
    let input = [query.to_string()];
    let meeting_results = if folder_ids.is_empty() {
        Vec::new()
    } else {
        match client.embed(&input).await {
            Ok((vectors, model)) if !vectors.is_empty() => {
                let query_vector = vectors[0].clone();
                run_blocking_until(deadline, move || {
                    let mut results = Vec::new();
                    let Ok(conn) = crate::storage::connect_for_sync() else {
                        return results;
                    };
                    let ranked = crate::storage::get_chunks_for_model(&model)
                        .map(|chunks| {
                            crate::embeddings::best_cosine_per_meeting(&chunks, &query_vector)
                        })
                        .unwrap_or_default();
                    for (meeting_id, cosine) in ranked
                        .into_iter()
                        .filter(|(meeting_id, cosine)| {
                            folder_ids.contains(meeting_id) && *cosine >= 0.55
                        })
                        .take(3)
                    {
                        if let Ok(Some(meeting)) = crate::storage::get_meeting_on(&conn, meeting_id)
                        {
                            let date = meeting
                                .recorded_at
                                .get(..10)
                                .unwrap_or(&meeting.recorded_at);
                            let title = if date.is_empty() {
                                meeting.title.clone()
                            } else {
                                format!("{} ({date})", meeting.title)
                            };
                            let text_body = if !meeting.summary.is_empty() {
                                &meeting.summary
                            } else {
                                &meeting.transcript
                            };
                            let stripped = strip_title_line(text_body, &meeting.title);
                            let text = crate::copilot_provenance::truncate_word_boundary(
                                stripped,
                                MAX_PASSAGE_CHARS,
                            );

                            results.push(CopilotPassage {
                                source_kind: "meeting".to_string(),
                                source_id: meeting_id.to_string(),
                                title,
                                text,
                                score: cosine,
                            });
                        }
                    }
                    results
                })
                .await
                .unwrap_or_default()
            }
            _ => Vec::new(),
        }
    };
    results.extend(meeting_results);

    // 2. Context search (vault + project)
    let context_hits = if sources.is_empty() {
        Vec::new()
    } else {
        crate::context_index::search(client, query, 3, 2, 0.55).await
    };
    for hit in context_hits {
        if !crate::folder_sources::path_in_sources(&hit.path, &sources) {
            continue;
        }
        let score = if hit.signal.starts_with("[semantic match: ") {
            hit.signal
                .trim_start_matches("[semantic match: ")
                .trim_end_matches(']')
                .parse::<f32>()
                .unwrap_or(0.55)
        } else {
            0.55
        };

        results.push(CopilotPassage {
            source_kind: hit.source,
            source_id: hit.path,
            title: hit.title,
            text: crate::copilot_provenance::truncate_word_boundary(
                &hit.excerpt,
                MAX_PASSAGE_CHARS,
            ),
            score,
        });
    }

    results
}

// ===========================================================================
// Answer shape
// ===========================================================================

/// Word-bounded phrases that alone request an ordered sequence of steps.
const STEPS_PHRASES: &[&str] = &[
    "walk me through",
    "talk me through",
    "take me through",
    "step by step",
    "what are the steps",
    "what steps",
    "in what order",
    "stages",
];

/// Process-oriented verbs that, only when paired with a process noun, request steps.
const PROCESS_VERBS: &[&str] = &["describe", "explain", "outline", "go through"];
const PROCESS_NOUNS: &[&str] = &["process", "workflow", "pipeline", "procedure"];

/// "How would you …" style openers that request steps when followed by a procedural verb.
const HOW_PHRASES: &[&str] = &[
    "how would you",
    "how do you",
    "how should we",
    "how would we",
    "how do i",
    "how would i",
];
const PROCEDURAL_VERBS: &[&str] = &[
    "approach",
    "clean",
    "debug",
    "investigate",
    "implement",
    "deploy",
    "migrate",
    "test",
    "build",
    "set up",
    "design",
];

/// Lowercase and collapse whitespace so phrase matching is insensitive to case
/// and spacing, while punctuation still acts as a word boundary.
fn normalize_words(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether `needle` occurs in `haystack` as a sequence of whole words.
fn has_word_bounded(haystack: &str, needle: &str) -> bool {
    !word_bounded_positions(haystack, needle).is_empty()
}

/// Every index where `needle` appears in `haystack` bounded by non-alphanumerics.
fn word_bounded_positions(haystack: &str, needle: &str) -> Vec<usize> {
    let mut positions = Vec::new();
    let mut search_from = 0;
    while let Some(offset) = haystack[search_from..].find(needle) {
        let start = search_from + offset;
        let end = start + needle.len();
        let before_ok = start == 0
            || !haystack[..start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric());
        let after_ok = end == haystack.len()
            || !haystack[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric());
        if before_ok && after_ok {
            positions.push(start);
        }
        search_from = start + 1;
    }
    positions
}

/// Whether `before` is immediately followed (word-bounded, same sentence) by `after`.
fn phrase_precedes(haystack: &str, before: &str, after: &str) -> bool {
    word_bounded_positions(haystack, before)
        .into_iter()
        .any(|start| {
            let rest = &haystack[start + before.len()..];
            has_word_bounded(rest, after)
        })
}

fn sentences(text: &str) -> Vec<&str> {
    text.split_inclusive(['.', '?', '!'])
        .map(str::trim)
        .filter(|sentence| !sentence.trim_matches(['.', '?', '!']).trim().is_empty())
        .collect()
}

fn steps_shape(question: &str) -> bool {
    let normalized = normalize_words(question);
    if STEPS_PHRASES
        .iter()
        .any(|phrase| has_word_bounded(&normalized, phrase))
    {
        return true;
    }
    if PROCESS_VERBS
        .iter()
        .any(|verb| has_word_bounded(&normalized, verb))
        && PROCESS_NOUNS
            .iter()
            .any(|noun| has_word_bounded(&normalized, noun))
    {
        return true;
    }
    sentences(question).iter().any(|sentence| {
        let sentence = normalize_words(sentence);
        let Some(verb) = PROCEDURAL_VERBS
            .iter()
            .find(|verb| has_word_bounded(&sentence, verb))
        else {
            return false;
        };
        HOW_PHRASES
            .iter()
            .any(|how| phrase_precedes(&sentence, how, verb))
    })
}

/// Select the answer shape for a resolved question: `"steps"` when the question
/// asks for an ordered sequence, otherwise `"brief"`. A bare "how", "pipeline"
/// or "process" never triggers.
pub fn select_answer_shape(question: &str) -> &'static str {
    if steps_shape(question) {
        "steps"
    } else {
        "brief"
    }
}

// ===========================================================================
// Tests
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_preserve_punctuation_and_gate_intervening_answers() {
        let candidate =
            classify_candidates("What is a mutex? A little context. Who founded OpenAI?")
                .pop()
                .unwrap();
        assert_eq!(candidate.text, "What is a mutex? Who founded OpenAI?");
        assert!(candidate.ambiguous); // An earlier question has an intervening answer.
        let last = classify_candidates("What is a mutex? Who founded OpenAI?")
            .pop()
            .unwrap();
        assert_eq!(last.text, "What is a mutex? Who founded OpenAI?");
        assert!(!last.ambiguous);
        assert!(classify_candidates("We shipped it. Alright? Got it?")
            .pop()
            .is_none());
        assert!(classify_candidates("").pop().is_none());
        // A candidate sentence is kept whole; turns are bounded upstream.
        let whole = classify_candidates(&format!("What is {}?", "界".repeat(310)))
            .pop()
            .unwrap();
        assert_eq!(whole.text, format!("What is {}?", "界".repeat(310)));
        assert!(whole.text.ends_with('?'));
    }

    #[test]
    fn candidates_merge_questions_in_order_and_skip_tags() {
        let questions = [
            "Who founded Anthropic?",
            "How would you design a RAG pipeline for procurement documents?",
        ];
        let candidates = classify_candidates(&questions.join(" "));
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].text, questions.join(" "));
        assert!(!candidates[0].ambiguous);
        let turn = format!(
            "Alright? {} Got it? {} What is Rust?",
            questions[0], questions[1]
        );
        let candidates = classify_candidates(&turn);
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].text,
            format!("{} {} What is Rust?", questions[0], questions[1])
        );
        assert!(!candidates[0].ambiguous);
        // Short explicit questions do not require a question-word starter.
        let candidates = classify_candidates("Rust? Python? Go?");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].text, "Rust? Python? Go?");
        assert!(!candidates[0].ambiguous);
    }

    #[test]
    fn candidates_accept_interview_imperatives_and_merge_starter_requests() {
        for starter in [
            "Tell me about",
            "Tell me",
            "Walk me through",
            "Describe",
            "Explain",
            "Talk me through",
            "Give me an example",
        ] {
            let turn = format!("Okay, well, {starter} the ERDC platform you built.");
            let candidates = classify_candidates(&turn);
            assert_eq!(candidates.len(), 1, "{turn}");
            assert_eq!(candidates[0].text, turn);
            assert_eq!(candidates[0].reason, "starter_only");
        }
        let turn = "Tell me about the ERDC platform you built.";
        assert_eq!(classify_candidates(turn).len(), 1);
        let candidates = classify_candidates(
            "Describe the deployment process. Explain how the ERDC platform works.",
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].text,
            "Describe the deployment process. Explain how the ERDC platform works."
        );
        assert_eq!(candidates[0].reason, "starter_only");
        assert!(candidates[0].ambiguous);
        assert!(classify_candidates("Tell me about.").is_empty());
        assert!(classify_candidates(
            "So what the copilot does as you can see is it listens and answers."
        )
        .is_empty());
        let candidates =
            classify_candidates("Who founded Anthropic? Describe the deployment process.");
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].text,
            "Who founded Anthropic? Describe the deployment process."
        );
        assert_eq!(candidates[0].reason, "direct_question");
        assert!(!candidates[0].ambiguous);
    }

    #[test]
    fn candidate_rejects_narration_after_fillers() {
        for prefix in NARRATION_PREFIXES {
            assert!(
                classify_candidates(&format!("Okay, well, {prefix} the local copilot feature?"))
                    .pop()
                    .is_none(),
                "{prefix}"
            );
        }
        assert!(classify_candidates("What is the copilot feature?")
            .pop()
            .is_some());
        assert!(
            classify_candidates("This island is where we should deploy?")
                .pop()
                .is_some()
        );
    }

    #[test]
    fn candidate_rejects_quoted_examples_with_substantive_continuations() {
        for turn in [
            "For example, who founded OpenAI? This is a demonstration.",
            "Let's say we are interviewing. What is an LLM? That was an example.",
        ] {
            assert!(classify_candidates(turn).pop().is_none(), "{turn}");
        }
        assert!(
            !classify_candidates("For example, who founded OpenAI?")
                .pop()
                .unwrap()
                .ambiguous
        );
        assert!(
            classify_candidates("So for example, who founded OpenAI? Bye.")
                .pop()
                .unwrap()
                .ambiguous
        );
    }

    #[test]
    fn candidate_gates_in_turn_answers_pronouns_long_turns_and_starters() {
        for turn in [
            "Who founded OpenAI? Sam Altman helped found it.",
            "What is it?",
            "Who is that?",
            "What is this?",
            "Who are they?",
            "Who is he?",
            "Who is she?",
            "What are those?",
            "What are these?",
            "Explain how Rust ownership works",
            "What is a mutex.",
        ] {
            assert!(classify_candidates(turn).pop().unwrap().ambiguous, "{turn}");
        }
        assert!(
            !classify_candidates("Who founded OpenAI? Thanks.")
                .pop()
                .unwrap()
                .ambiguous
        );
        assert!(
            !classify_candidates("What is this Kubernetes controller?")
                .pop()
                .unwrap()
                .ambiguous
        );
        let forty_words = format!("{} Who founded OpenAI?", "context ".repeat(37));
        assert!(!classify_candidates(&forty_words).pop().unwrap().ambiguous);
        assert!(
            classify_candidates(&format!("context {forty_words}"))
                .pop()
                .unwrap()
                .ambiguous
        );
    }

    #[test]
    fn candidates_merge_multi_question_turns_into_one_direct_card() {
        let candidate = classify_candidates(
            "Let's say you have a hundred million documents. How will you use RAG? How will you make rag efficient?",
        )
        .pop()
        .unwrap();
        assert_eq!(
            candidate.text,
            "How will you use RAG? How will you make rag efficient?"
        );
        assert_eq!(candidate.reason, "direct_question");
        assert!(!candidate.ambiguous);
        let candidate = classify_candidates("What is RAG? What is a vector database?")
            .pop()
            .unwrap();
        assert_eq!(candidate.text, "What is RAG? What is a vector database?");
        assert_eq!(candidate.reason, "direct_question");
        assert!(!candidate.ambiguous);
        let candidate = classify_candidates("What is RAG? Explain chunking strategies for PDFs.")
            .pop()
            .unwrap();
        assert_eq!(
            candidate.text,
            "What is RAG? Explain chunking strategies for PDFs."
        );
        assert_eq!(candidate.reason, "direct_question");
        assert!(!candidate.ambiguous);
    }

    #[test]
    fn candidates_gate_uncertain_member_of_a_multi_question_turn() {
        let candidate = classify_candidates("What is it? Explain Rust ownership rules.")
            .pop()
            .unwrap();
        assert_eq!(candidate.text, "What is it? Explain Rust ownership rules.");
        assert_eq!(candidate.reason, "bare_pronoun");
        assert!(candidate.ambiguous);
    }

    #[test]
    fn candidates_keep_single_question_turns_unchanged() {
        let candidate = classify_candidates("Who founded OpenAI?").pop().unwrap();
        assert_eq!(candidate.text, "Who founded OpenAI?");
        assert_eq!(candidate.reason, "direct_question");
        assert!(!candidate.ambiguous);
    }

    #[test]
    fn candidates_gate_long_multi_question_turns_as_long_turn() {
        let turn = format!(
            "{}. What is RAG? What is a vector database?",
            "context ".repeat(40).trim_end()
        );
        assert!(turn.split_whitespace().count() > 40);
        let candidate = classify_candidates(&turn).pop().unwrap();
        assert_eq!(candidate.text, "What is RAG? What is a vector database?");
        assert_eq!(candidate.reason, "long_turn");
        assert!(candidate.ambiguous);
    }

    #[test]
    fn wake_words_require_a_prefix_boundary_and_preserve_the_question() {
        for turn in [
            "copilot, Who founded OpenAI?",
            "CO-PILOT: Who founded OpenAI?",
            "  Hey Copilot Who founded OpenAI?",
        ] {
            assert_eq!(strip_wake_word(turn), Some("Who founded OpenAI?"));
        }
        assert_eq!(strip_wake_word("copilot"), Some(""));
        for turn in [
            "my copilot, who founded OpenAI?",
            "copiloting is useful",
            "copilot's question",
            "hey copilots, who?",
            "界界界界界",
        ] {
            assert_eq!(strip_wake_word(turn), None, "{turn}");
        }
    }

    #[test]
    fn keyword_jaccard_handles_empty_partial_and_identical_sets() {
        let a = HashSet::from(["alpha".into(), "bravo".into(), "charlie".into()]);
        let b = HashSet::from(["alpha".into(), "bravo".into(), "delta".into()]);
        assert_eq!(keyword_jaccard(&a, &b), 0.5);
        assert_eq!(keyword_jaccard(&a, &a), 1.0);
        assert_eq!(keyword_jaccard(&a, &HashSet::new()), 0.0);
        assert_eq!(keyword_jaccard(&HashSet::new(), &HashSet::new()), 0.0);
    }

    // Exact QUESTION SENT strings from .recon/copilot-ux-20260913/real-cards.md.
    #[test]
    fn offline_eval_rejects_cards_195_and_204() {
        for turn in [
            "So what the co-pilot does is, as you can see on the left side, my transcript is real-time.",
            "So why I built a meeting co-pilot.  So from my own pain points, I go into a lot of meetings where we discuss. a lot of things that I'm that is foreign to me or might get confusing so a co-pilot could assist me in answering these questions so for example I could say that",
        ] {
            assert!(classify_candidates(turn).pop().is_none(), "{turn}");
        }
    }

    #[test]
    fn offline_eval_gates_cards_191_and_206() {
        for (turn, question) in [
            ("How are you guys uploading the video?  YouTube.  Unlisted. Did any of you put into the YouTube upload?", "How are you guys uploading the video? Did any of you put into the YouTube upload?"),
            ("and this is real time this is not connected to the internet this is my local llm that i have  i can give it more context about my projects or about my previous meetings.  So for example, who is the founder of OpenAI? Bye.", "So for example, who is the founder of OpenAI?"),
        ] {
            let candidate = classify_candidates(turn).pop().unwrap();
            assert!(candidate.ambiguous, "{turn}");
            assert_eq!(candidate.text, question);
        }
    }

    #[test]
    fn offline_eval_plain_cards_take_fast_path_unchanged() {
        for question in [
            "Who founded OpenAI?",            // 198
            "Who is Sam Altman?",             // 199
            "Okay, what's Azure AI Foundry?", // 200
            "What's Palantir Foundry?",       // 201
            "Who's the founder of Palantir?", // 202
            "What's Claude Code?",            // 203
            "What is an LLM?",                // 205
            "Who is the founder of OpenAI?",  // 207
            "What is LLM?",                   // 210
            "Who is Sam Altman?",             // 211
        ] {
            let candidate = classify_candidates(question).pop().unwrap();
            assert_eq!(candidate.text, question);
            assert!(!candidate.ambiguous, "{question}");
        }
    }

    #[test]
    fn offline_eval_card_194_has_the_same_keywords_as_189() {
        let question = "Hello, what are LLM's?";
        let candidate = classify_candidates(question).pop().unwrap();
        assert_eq!(candidate.text, question);
        assert!(!candidate.ambiguous);
        assert_eq!(
            keyword_jaccard(
                &extract_keywords(question),
                &extract_keywords("What are LLMs?")
            ),
            1.0
        );
        assert_eq!(
            extract_keywords("What is an LLM?"),
            extract_keywords(question)
        );
    }

    fn evidence_db() -> Connection {
        let conn = in_memory_db();
        crate::storage::setup_fts(&conn).unwrap();
        crate::storage::setup_context_fts(&conn).unwrap();
        conn.execute("INSERT INTO meetings (id, title, transcript, recorded_at) VALUES (1, 'Other meeting', 'hermetic deployment', '2026-09-07')", []).unwrap();
        for path in [
            "/approved/inside.md",
            "/approved-other/outside.md",
            "/exact.md",
            "/exact.md-other",
        ] {
            crate::storage::upsert_context_doc_on(
                &conn,
                "vault",
                path,
                "Project",
                "Project",
                "hermetic deployment",
                "1",
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn no_folder_never_retrieves_meetings_context_or_folder_documents() {
        let conn = evidence_db();
        crate::storage::upsert_folder_doc_on(
            &conn,
            1,
            "/folder.md",
            "Folder",
            "hermetic deployment",
            "1",
            "now",
        )
        .unwrap();
        let live = CopilotLiveContext {
            folder_id: None,
            notes: "hermetic deployment".into(),
            attachments: Vec::new(),
        };
        let (passages, tiers) = retrieve_sync_tiers(&conn, &live, "hermetic deployment");
        assert_eq!(tiers, vec!["live"]);
        assert_eq!(passages.len(), 1);
        assert_eq!(passages[0].source_kind, "notes");
    }

    #[test]
    fn empty_folder_does_not_fall_back_to_all_meetings() {
        let conn = evidence_db();
        let id = crate::storage::create_folder_on(&conn, "Empty", "blue")
            .unwrap()
            .id;
        let live = CopilotLiveContext {
            folder_id: Some(id),
            ..Default::default()
        };
        let (passages, tiers) = retrieve_sync_tiers(&conn, &live, "hermetic deployment");
        assert!(passages.is_empty());
        assert!(tiers.is_empty());
    }

    #[test]
    fn meeting_fts_only_returns_meetings_filed_in_the_selected_folder() {
        let conn = evidence_db();
        let id = crate::storage::create_folder_on(&conn, "Me", "blue")
            .unwrap()
            .id;
        conn.execute("INSERT INTO meetings (id, title, transcript, recorded_at) VALUES (2, 'Filed meeting', 'hermetic deployment', '2026-09-07')", []).unwrap();
        crate::storage::set_meeting_folder_on(&conn, 2, Some(id)).unwrap();
        let live = CopilotLiveContext {
            folder_id: Some(id),
            ..Default::default()
        };
        let (passages, _) = retrieve_sync_tiers(&conn, &live, "hermetic deployment");
        assert_eq!(passages.len(), 1);
        assert_eq!(passages[0].source_kind, "meeting");
        assert_eq!(passages[0].source_id, "2");
    }

    #[test]
    fn context_documents_require_an_exact_file_or_directory_source() {
        let conn = evidence_db();
        let id = crate::storage::create_folder_on(&conn, "Me", "blue")
            .unwrap()
            .id;
        crate::storage::insert_folder_source_on(&conn, id, "/approved", "dir", "now").unwrap();
        crate::storage::insert_folder_source_on(&conn, id, "/exact.md", "file", "now").unwrap();
        let live = CopilotLiveContext {
            folder_id: Some(id),
            ..Default::default()
        };
        let (passages, tiers) = retrieve_sync_tiers(&conn, &live, "hermetic deployment");
        assert_eq!(tiers, vec!["context_fts"]);
        let paths: HashSet<_> = passages.iter().map(|p| p.source_id.as_str()).collect();
        assert_eq!(paths, HashSet::from(["/approved/inside.md", "/exact.md"]));
    }

    #[test]
    fn folder_document_tier_returns_the_document_title_path_and_excerpt() {
        let conn = in_memory_db();
        let id = crate::storage::create_folder_on(&conn, "Me", "blue")
            .unwrap()
            .id;
        crate::storage::upsert_folder_doc_on(
            &conn,
            id,
            "/me.md",
            "My project",
            "hermetic deployment",
            "1",
            "now",
        )
        .unwrap();
        crate::storage::upsert_folder_doc_on(
            &conn,
            id + 1,
            "/other.md",
            "Other project",
            "hermetic deployment",
            "1",
            "now",
        )
        .unwrap();
        let live = CopilotLiveContext {
            folder_id: Some(id),
            ..Default::default()
        };
        let (passages, tiers) = retrieve_sync_tiers(&conn, &live, "hermetic deployment");
        assert_eq!(tiers, vec!["folder"]);
        assert_eq!(passages.len(), 1);
        assert_eq!(passages[0].source_kind, "folder");
        assert_eq!(passages[0].source_id, "/me.md");
        assert_eq!(passages[0].title, "My project");
        assert_eq!(passages[0].text, "hermetic deployment");
        assert_eq!(passages[0].score, 0.86 + 0.10);
    }

    use crate::storage::in_memory_db;

    #[test]
    fn prompt_detection_keeps_real_questions_and_suppresses_tags() {
        assert!(!is_prompt("Alright?"));
        assert!(!is_prompt("Got it?"));
        assert!(is_prompt("So, can you walk me through it"));
        assert!(is_prompt("Well, what do you think about this?"));
        assert!(!is_prompt("We shipped it."));
    }

    #[test]
    fn trigger_t1_reports_without_terminal_questions() {
        let candidates = classify_candidates("If you were to build a Rag system for a million documents, what techniques will you use to ensure that the accuracy stays high.");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].reason, "starter_only");
        assert!(candidates[0].ambiguous);
        // Documented T1 limitation: reported speech qualifies, but must not panic.
        assert!(classify_candidates("She asked, what would you choose.")
            .pop()
            .is_some());
    }

    #[test]
    fn trigger_t2_imperatives_and_comparisons() {
        for turn in ["Define an AI agent.", "Define RAG.", "Compare Rust and Go."] {
            assert_eq!(classify_candidates(turn).len(), 1, "{turn}");
        }
        assert!(classify_candidates("Tell me about.").is_empty());
        let candidate = classify_candidates("Stateful versus stateless.")
            .pop()
            .unwrap();
        assert_eq!(candidate.reason, "starter_only");
        // "vs." survives sentence splitting as one sentence.
        let candidate = classify_candidates("Rust vs. Go.").pop().unwrap();
        assert_eq!(candidate.text, "Rust vs. Go.");
        assert_eq!(candidate.reason, "starter_only");
    }

    #[test]
    fn trigger_t3_greeting_veto() {
        for turn in ["Hello.", "Hey, what's happening?", "OK, and...", "Okay."] {
            assert!(classify_candidates(turn).is_empty(), "{turn}");
            assert!(!is_prompt(turn), "{turn}");
        }
        // A greeting sharing a sentence with a request stays eligible.
        let candidate = classify_candidates("Hello, what are LLMs?").pop().unwrap();
        assert_eq!(candidate.text, "Hello, what are LLMs?");
        // A greeting sentence is dropped from a mixed turn, not the request.
        let candidate = classify_candidates("How are you? Define an AI agent.")
            .pop()
            .unwrap();
        assert_eq!(candidate.text, "Define an AI agent.");
        assert!(classify_candidates("How are you guys uploading the video?")
            .pop()
            .is_some());
    }

    #[test]
    fn trigger_g1_greeting_prefixed_pleasantries_are_noise() {
        for turn in [
            "Hello, can you hear me?",
            "Hi, are you there?",
            "Hey, how are you?",
            "Hello, okay.",
        ] {
            assert!(classify_candidates(turn).is_empty(), "{turn}");
            assert!(!is_prompt(turn), "{turn}");
        }
        assert!(classify_candidates("Hello, what are LLMs?").pop().is_some());
        assert!(is_prompt("Hello, what are LLMs?"));
        assert!(
            classify_candidates("Hey, how are you guys uploading the video?")
                .pop()
                .is_some()
        );
    }

    #[test]
    fn answer_shape_selects_steps_and_brief() {
        let founder = "Let's say you have a data set and you're a data scientist. What will be your steps in cleaning the data, what will you do first, and just go through the data science pipeline, what would you do?";
        assert_eq!(select_answer_shape(founder), "steps");
        for question in [
            "What is a pipeline?",
            "Why remove duplicates?",
            "What's the difference between a knowledge graph and a mind map?",
        ] {
            assert_eq!(select_answer_shape(question), "brief", "{question}");
        }
        assert_eq!(
            select_answer_shape("How would you approach cleaning a messy dataset?"),
            "steps"
        );
        for question in [
            "Walk me through the deployment.",
            "Talk me through the workflow.",
            "Take me through the process.",
            "What are the steps to migrate?",
            "What steps should I follow?",
            "In what order do these run?",
            "What are the stages of a startup?",
            "Explain the pipeline.",
            "Describe the deployment procedure.",
            "How do you set up a local model?",
            "How would you design a RAG pipeline?",
        ] {
            assert_eq!(select_answer_shape(question), "steps", "{question}");
        }
        // A bare "how", "pipeline" or "process" never triggers.
        for question in [
            "How does this work?",
            "What is a process?",
            "Why does the pipeline matter?",
        ] {
            assert_eq!(select_answer_shape(question), "brief", "{question}");
        }
    }

    #[test]
    fn fts_keyword_floor_and_score_are_stable() {
        let rare = extract_fts_keywords("What is an air-gapped system?");
        assert_eq!(rare, vec!["air-gapped".to_string()]);
        assert!(qualifies_for_fts(&rare));
        assert!(!qualifies_for_fts(&extract_fts_keywords("What do we do?")));
        assert!((fts_coverage_score(2, 3) - 0.5).abs() < 1e-6);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_retrieval_obeys_the_absolute_deadline() {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(10);
        let result = run_blocking_until(deadline, || {
            std::thread::sleep(Duration::from_millis(100));
            "late"
        })
        .await;
        assert_eq!(result, None);
    }

    #[test]
    fn title_line_is_removed_from_passage_body() {
        let text = "Interview — FDE Candidate (2026-07-06)\nHamza: details";
        assert_eq!(
            strip_title_line(text, "Interview — FDE Candidate"),
            "Hamza: details"
        );
    }

    #[test]
    fn live_notes_retrieval_is_bounded_and_ranked_first() {
        let conn = in_memory_db();
        let live = CopilotLiveContext {
            folder_id: None,
            notes: format!(
                "Unrelated\n{}",
                "Deployment cluster configuration remains hermetic ".repeat(30)
            ),
            attachments: Vec::new(),
        };
        let (passages, tiers) = retrieve_sync_tiers(
            &conn,
            &live,
            "How should deployment cluster configuration work?",
        );
        assert!(tiers.contains(&"live"));
        assert_eq!(passages[0].source_kind, "notes");
        assert!(passages[0].text.chars().count() <= MAX_PASSAGE_CHARS);
    }
    #[test]
    fn folder_acronym_coverage() {
        let conn = in_memory_db();
        let folder = crate::storage::create_folder_on(&conn, "Interview", "blue")
            .unwrap()
            .id;
        crate::storage::set_folder_terms_on(&conn, folder, &["rag".into(), "ct2".into()]).unwrap();
        crate::storage::upsert_folder_doc_on(
            &conn,
            folder,
            "/adversaria.md",
            "Adversaria: Hybrid retrieval and GraphRAG tradeoffs",
            "RAG combines FTS retrieval and generation. CT2 runs speech recognition.",
            "1",
            "now",
        )
        .unwrap();
        let live = CopilotLiveContext {
            folder_id: Some(folder),
            ..Default::default()
        };
        for (query, expected) in [
            ("What is RAG?", 0.96),
            ("What is CT2?", 0.96),
            ("RAG latency", 0.91),
        ] {
            let (passages, tiers) = retrieve_sync_tiers(&conn, &live, query);
            assert_eq!(tiers, ["folder"]);
            assert_eq!(passages.len(), 1);
            assert!((passages[0].score - expected).abs() < 0.00001);
        }
        assert!(
            retrieve_sync_tiers(&conn, &CopilotLiveContext::default(), "What is RAG?")
                .0
                .is_empty()
        );
        assert!(retrieve_sync_tiers(&conn, &live, "What is an unknownword?")
            .0
            .is_empty());
        assert!(extract_fts_keywords("What is RAG?").is_empty());
        let terms = ["rag".into(), "ct2".into()].into_iter().collect();
        assert_eq!(
            extract_fts_keywords_for_folder("RAG rag CT2 and no UI", &terms),
            ["rag", "ct2"]
        );
    }

    #[test]
    fn curated_dedup_and_sort() {
        let passage = |kind: &str, path: &str, score| CopilotPassage {
            source_kind: kind.into(),
            source_id: path.into(),
            title: "Evidence".into(),
            text: "RAG".into(),
            score,
        };
        let sorted = dedup_and_sort_passages(vec![
            passage("vault", "/Evidence/./a.md", 0.75),
            passage("notes", "notes", 0.99),
            passage("folder", "/Evidence/a.md", 0.86 + 0.10),
            passage("folder", "/Evidence/c.md", 0.91),
            passage("attachment", "/Evidence/c.md", 0.80),
            passage("folder", "/Evidence/b.md", 0.91),
            passage("vault", "/evidence/a.md", 0.75),
        ]);
        assert_eq!(sorted.len(), 5);
        assert_eq!(
            sorted
                .iter()
                .map(|p| p.source_id.as_str())
                .collect::<Vec<_>>(),
            [
                "/Evidence/a.md",
                "notes",
                "/Evidence/b.md",
                "/Evidence/c.md",
                "/evidence/a.md"
            ]
        );
        assert_eq!(
            crate::copilot_provenance::canonical_evidence_key(&passage(
                "project",
                "/Projects/./A",
                1.0
            )),
            format!(
                "project:{}",
                crate::copilot_provenance::native_separators("/Projects/A")
            )
        );
        assert_eq!(
            crate::copilot_provenance::canonical_evidence_key(&passage("meeting", "42", 1.0)),
            "meeting:42"
        );
    }
}
