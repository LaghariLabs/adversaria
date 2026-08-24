//! Cheap, deterministic routing for action items that require a person.

const VERBS: &[&str] = &[
    "record",
    "film",
    "shoot",
    "call",
    "phone",
    "ring",
    "meet",
    "attend",
    "book",
    "buy",
    "order",
    "pay",
    "sign",
    "visit",
    "print",
    "ship",
    "mail",
    "interview",
    "present",
    "demo",
    "rehearse",
    "practice",
    "practise",
    "approve",
    "decide",
    "choose",
    "introduce",
    "onboard",
    "hire",
    "fire",
    "travel",
    "fly",
    "drive",
];

const VERB_PHRASES: &[&[&str]] = &[
    &["meet", "with"],
    &["join", "the"],
    &["go", "to"],
    &["pick", "up"],
    &["drop", "off"],
    &["hand", "over"],
    &["speak", "to"],
    &["talk", "to"],
    &["confirm", "with"],
    &["check", "with"],
    &["follow", "up", "with"],
];

const PERSON_ONLY_WORDS: &[&str] = &["dentist", "doctor", "gym"];
const PERSON_ONLY_PHRASES: &[&[&str]] =
    &[&["in", "person"], &["on", "site"], &["face", "to", "face"]];

fn words(text: &str) -> Vec<String> {
    text.split(|character: char| !(character.is_alphanumeric() || character == '\''))
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

fn contains_phrase(words: &[String], phrase: &[&str]) -> bool {
    words
        .windows(phrase.len())
        .any(|window| window.iter().map(String::as_str).eq(phrase.iter().copied()))
}

fn owner_prefix_len(normalized: &str, words: &[String]) -> usize {
    if words.first().is_some_and(|word| word == "i'll") {
        return 1;
    }
    if words.len() >= 2 && words[0] == "i" && words[1] == "will" {
        return 2;
    }
    if normalized.starts_with("me:") {
        return 1;
    }
    if words.len() >= 2 && words[1] == "will" {
        return 2;
    }
    0
}

/// True when a to-do is something only the person can do (record, call,
/// attend, buy, sign…), so agents must not pick it up.
pub fn needs_you(text: &str) -> bool {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_lowercase();
    let lower_words = words(&lower);
    if lower_words.is_empty() {
        return false;
    }

    if PERSON_ONLY_WORDS
        .iter()
        .any(|keyword| lower_words.iter().any(|word| word == keyword))
        || PERSON_ONLY_PHRASES
            .iter()
            .any(|phrase| contains_phrase(&lower_words, phrase))
    {
        return true;
    }

    let original_words = words(&normalized);
    let start = owner_prefix_len(&lower, &lower_words);
    let candidate = &lower_words[start..];
    if candidate.is_empty() {
        return false;
    }

    if VERBS.iter().any(|verb| candidate[0] == *verb)
        || VERB_PHRASES.iter().any(|phrase| {
            candidate
                .iter()
                .take(phrase.len())
                .map(String::as_str)
                .eq(phrase.iter().copied())
        })
    {
        return true;
    }

    candidate[0] == "ask"
        && original_words
            .get(start + 1)
            .and_then(|word| word.chars().next())
            .is_some_and(char::is_uppercase)
}

#[cfg(test)]
mod tests {
    use super::needs_you;

    #[test]
    fn recognises_person_only_tasks() {
        for text in [
            "Record 90-second demo video this week.",
            "Hamza will call the vendor",
            "Book the dentist",
            "Ask Lina for the brand assets",
            "Me: sign the supplier agreement",
            "I'll attend the launch briefing",
            "Follow up with Omar about the venue",
            "Research venues for an on-site workshop",
            "Pick up the printed brochures",
        ] {
            assert!(needs_you(text), "expected person-only task: {text}");
        }
    }

    #[test]
    fn leaves_agent_friendly_tasks_eligible() {
        for text in [
            "Draft full social calendar once demo video is finalized.",
            "Review landing page copy",
            "Prepare the recording setup checklist",
            "Research the vendor options",
            "Write the launch plan",
            "Update call notes in the project doc",
            "Ask for the latest analytics export",
            "Compare the two proposals",
        ] {
            assert!(!needs_you(text), "expected agent-friendly task: {text}");
        }
    }
}
