//! Second-brain export — mirror meetings into a user-chosen local folder as
//! markdown notes with OKF-style YAML frontmatter + `[[wikilinks]]`, readable
//! by Obsidian and ingestible by graphify (the user's vault knowledge graph).
//!
//! Deliberate scope (user-approved 2026-07-06): meetings only (people/tags
//! become nodes via wikilinks, not stub files), summary only (never the raw
//! transcript), locked meetings excluded, opt-in and off by default. Every
//! file we write carries a `resource: adversaria://meeting/<id>` marker so
//! orphan cleanup can never touch anything user-authored.

use std::collections::HashSet;
use std::path::Path;

use crate::types::{Meeting, PersonProfile};

/// Marker present in every note this module writes; the orphan sweep only
/// deletes files containing it.
const OWNED_MARKER: &str = "adversaria://meeting/";

/// Filesystem-safe, human-readable slug from a meeting title. Keeps unicode
/// letters (Arabic titles stay readable); everything else becomes a dash.
fn slug(title: &str) -> String {
    let dashed: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    dashed
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(60)
        .collect()
}

/// Stable filename: date + slug + id (the id keeps files unique and lets a
/// renamed meeting swap files without colliding).
pub(crate) fn note_filename(meeting: &Meeting) -> String {
    let date = meeting.recorded_at.get(..10).unwrap_or("undated");
    let s = slug(&meeting.title);
    if s.is_empty() {
        format!("{date}-meeting-{}.md", meeting.id)
    } else {
        format!("{date}-{s}-{}.md", meeting.id)
    }
}

/// Escape a string for a double-quoted YAML scalar.
fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Attendees worth linking: real names, not capture labels.
fn linkable_attendees(meeting: &Meeting) -> Vec<&str> {
    meeting
        .attendees
        .iter()
        .map(|a| a.trim())
        .filter(|a| !a.is_empty() && !crate::commands::is_generic_participant(a))
        .collect()
}

/// Render one meeting as an OKF-style markdown note.
pub(crate) fn render_note(meeting: &Meeting) -> String {
    let attendees = linkable_attendees(meeting);
    let tags: Vec<&str> = meeting.tags.iter().map(|t| t.label.as_str()).collect();

    let mut fm = String::from("---\ntype: meeting\n");
    fm.push_str(&format!("title: {}\n", yaml_quote(&meeting.title)));
    fm.push_str(&format!(
        "timestamp: {}\n",
        yaml_quote(&meeting.recorded_at)
    ));
    if !tags.is_empty() {
        let quoted: Vec<String> = tags.iter().map(|t| yaml_quote(t)).collect();
        fm.push_str(&format!("tags: [{}]\n", quoted.join(", ")));
    }
    if !attendees.is_empty() {
        let quoted: Vec<String> = attendees.iter().map(|a| yaml_quote(a)).collect();
        fm.push_str(&format!("attendees: [{}]\n", quoted.join(", ")));
    }
    if !meeting.link.trim().is_empty() {
        fm.push_str(&format!("link: {}\n", yaml_quote(meeting.link.trim())));
    }
    fm.push_str(&format!("resource: {OWNED_MARKER}{}\n---\n", meeting.id));

    let mut body = format!("\n# {}\n", meeting.title);
    let mut meta_line: Vec<String> = Vec::new();
    if !attendees.is_empty() {
        let links: Vec<String> = attendees.iter().map(|a| format!("[[{a}]]")).collect();
        meta_line.push(format!("**Attendees:** {}", links.join(", ")));
    }
    if !tags.is_empty() {
        let links: Vec<String> = tags.iter().map(|t| format!("[[{t}]]")).collect();
        meta_line.push(format!("**Tags:** {}", links.join(", ")));
    }
    if !meta_line.is_empty() {
        body.push_str(&format!("\n{}\n", meta_line.join(" · ")));
    }
    if !meeting.link.trim().is_empty() {
        body.push_str(&format!("\n**Source:** {}\n", meeting.link.trim()));
    }
    if !meeting.summary.trim().is_empty() {
        body.push_str(&format!("\n{}\n", meeting.summary.trim()));
    }
    if !meeting.user_notes.trim().is_empty() {
        body.push_str(&format!("\n## My Notes\n\n{}\n", meeting.user_notes.trim()));
    }

    format!("{fm}{body}")
}

/// Stable filename for a person profile note.
fn person_filename(p: &PersonProfile) -> String {
    let s = slug(&p.name);
    if s.is_empty() {
        format!("person-{}.md", p.id)
    } else {
        format!("person-{s}-{}.md", p.id)
    }
}

/// Exportable meetings whose attendee list includes this person (by name or any
/// comma-separated alias). Case-insensitive substring match per attendee entry.
fn person_together<'a>(p: &PersonProfile, exportable: &[&'a Meeting]) -> Vec<&'a Meeting> {
    let name_lower = p.name.to_lowercase();
    let aliases: Vec<String> = p
        .aliases
        .split(',')
        .map(|a| a.trim().to_lowercase())
        .filter(|a| !a.is_empty())
        .collect();
    exportable
        .iter()
        .filter(|m| {
            m.attendees.iter().any(|a| {
                let a_lower = a.to_lowercase();
                a_lower.contains(&name_lower) || aliases.iter().any(|alias| a_lower.contains(alias))
            })
        })
        .copied()
        .collect()
}

/// Render one person profile as a vault note with YAML frontmatter.
fn render_person_note(p: &PersonProfile, together: &[&Meeting]) -> String {
    let mut fm = String::from("---\ntype: person\n");
    if !p.role.trim().is_empty() {
        fm.push_str(&format!("role: {}\n", yaml_quote(p.role.trim())));
    }
    if !p.company.trim().is_empty() {
        fm.push_str(&format!("company: {}\n", yaml_quote(p.company.trim())));
    }
    if !p.aliases.trim().is_empty() {
        fm.push_str(&format!("aliases: {}\n", yaml_quote(p.aliases.trim())));
    }
    if !p.email.trim().is_empty() {
        fm.push_str(&format!("email: {}\n", yaml_quote(p.email.trim())));
    }
    if !p.phone.trim().is_empty() {
        fm.push_str(&format!("phone: {}\n", yaml_quote(p.phone.trim())));
    }
    if !p.linkedin.trim().is_empty() {
        fm.push_str(&format!("linkedin: {}\n", yaml_quote(p.linkedin.trim())));
    }
    fm.push_str(&format!("resource: {OWNED_MARKER}{}\n---\n", p.id));

    let mut body = format!("\n# {}\n", p.name);
    if !p.notes.trim().is_empty() {
        body.push_str(&format!("\n{}\n", p.notes.trim()));
    }

    if !together.is_empty() {
        body.push_str("\n## Meetings together\n");
        for m in together {
            let filename = note_filename(m);
            let stem = filename.trim_end_matches(".md");
            let date = m.recorded_at.get(..10).unwrap_or("");
            body.push_str(&format!("- [[{stem}]] — {date}\n"));
        }
    }

    format!("{fm}{body}")
}

/// Render the OKF-reserved index.md linking every exported note, newest first.
fn render_index(meetings: &[&Meeting], people: &[PersonProfile]) -> String {
    let mut out = String::from(
        "---\ntype: index\ntitle: \"Adversaria Meetings\"\n---\n\n# Adversaria Meetings\n\n",
    );
    for m in meetings {
        let stem = note_filename(m);
        let stem = stem.trim_end_matches(".md");
        let date = m.recorded_at.get(..10).unwrap_or("");
        out.push_str(&format!("- [[{stem}]] — {date}\n"));
    }
    if !people.is_empty() {
        out.push_str("\n## People\n\n");
        for p in people {
            let stem = person_filename(p);
            let stem = stem.trim_end_matches(".md");
            out.push_str(&format!("- [[{stem}]]\n"));
        }
    }
    out
}

/// Export everything to the configured folder. Returns the number of meeting
/// notes written; Ok(0) when disabled/unconfigured (unless `force`, which only
/// still requires a configured path).
pub fn sync(force: bool) -> anyhow::Result<usize> {
    let cfg = crate::config::load_config();
    let path = cfg.second_brain_path.trim().to_string();
    if path.is_empty() || (!cfg.second_brain_enabled && !force) {
        return Ok(0);
    }
    let dir = Path::new(&path);
    std::fs::create_dir_all(dir)?;

    let meetings = crate::storage::get_meetings()?;
    // Locked meetings are privacy-gated in the app — they must not leak into a
    // plain-text folder.
    let exportable: Vec<&Meeting> = meetings.iter().filter(|m| !m.locked).collect();

    let mut written: HashSet<String> = HashSet::new();
    for m in &exportable {
        let name = note_filename(m);
        std::fs::write(dir.join(&name), render_note(m))?;
        written.insert(name);
    }

    let people = crate::storage::get_people().unwrap_or_default();
    for p in &people {
        let name = person_filename(p);
        std::fs::write(
            dir.join(&name),
            render_person_note(p, &person_together(p, &exportable)),
        )?;
        written.insert(name);
    }

    std::fs::write(dir.join("index.md"), render_index(&exportable, &people))?;

    // graph.json — the same structured graph the Graph tab renders, for
    // programmatic consumers (graphify et al).
    let items = crate::storage::get_action_items(None).unwrap_or_default();
    let owned: Vec<Meeting> = exportable.iter().map(|m| (*m).clone()).collect();
    let graph =
        crate::commands::build_graph(&owned, &items, &cfg.user_name, &cfg.custom_vocabulary);
    std::fs::write(
        dir.join("graph.json"),
        serde_json::to_string_pretty(&graph)?,
    )?;

    // Orphan sweep: remove OUR notes for meetings that no longer exist (or got
    // locked/renamed). Only files carrying the ownership marker are touched.
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") || name == "index.md" || written.contains(&name) {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(entry.path()) {
            if content.contains(OWNED_MARKER) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    Ok(written.len())
}

/// Fire-and-forget export after a meeting mutation. No-op when the feature is
/// off; errors are logged, never surfaced (the mutation itself succeeded).
pub fn sync_async() {
    std::thread::spawn(|| {
        if let Err(e) = sync(false) {
            eprintln!("[second-brain] export failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Tag, TranscriptTurn};

    fn meeting() -> Meeting {
        Meeting {
            id: 7,
            title: "Q3 Planning: Budget & Roadmap".to_string(),
            recorded_at: "2026-07-06T08:00:00+00:00".to_string(),
            duration_seconds: 60.0,
            transcript: "Me: secret transcript".to_string(),
            summary: "**Key Topics**\n\n- Budget approved".to_string(),
            template_used: "general".to_string(),
            audio_file_path: None,
            attendees: vec![
                "Sarah".to_string(),
                "Them".to_string(),
                "Speaker 2".to_string(),
            ],
            user_notes: "follow up on budget".to_string(),
            link: "https://youtube.com/watch?v=x".to_string(),
            tags: vec![Tag {
                label: "Client".to_string(),
                color: "blue".to_string(),
            }],
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: Vec::<TranscriptTurn>::new(),
        }
    }

    #[test]
    fn filename_is_dated_slugged_and_id_stable() {
        assert_eq!(
            note_filename(&meeting()),
            "2026-07-06-q3-planning-budget-roadmap-7.md"
        );
    }

    #[test]
    fn note_has_frontmatter_links_and_never_the_transcript() {
        let note = render_note(&meeting());
        assert!(note.starts_with("---\ntype: meeting\n"));
        assert!(note.contains("resource: adversaria://meeting/7"));
        assert!(note.contains("[[Sarah]]"));
        assert!(note.contains("[[Client]]"));
        // Generic capture labels never become graph nodes.
        assert!(!note.contains("[[Them]]"));
        assert!(!note.contains("[[Speaker 2]]"));
        // Summary-only export: the raw transcript must never leave the app.
        assert!(!note.contains("secret transcript"));
        assert!(note.contains("Budget approved"));
        assert!(note.contains("## My Notes"));
        assert!(note.contains("**Source:** https://youtube.com/watch?v=x"));
    }

    #[test]
    fn yaml_title_quotes_are_escaped() {
        let mut m = meeting();
        m.title = "He said \"ship it\"".to_string();
        assert!(render_note(&m).contains("title: \"He said \\\"ship it\\\"\""));
    }

    #[test]
    fn arabic_titles_keep_readable_slugs() {
        let mut m = meeting();
        m.title = "مراجعة الميزانية".to_string();
        assert_eq!(note_filename(&m), "2026-07-06-مراجعة-الميزانية-7.md");
    }

    fn person() -> PersonProfile {
        PersonProfile {
            id: 1,
            name: "Daniel".to_string(),
            role: "Engineer".to_string(),
            company: "Acme".to_string(),
            notes: "Works on the rendering pipeline.".to_string(),
            aliases: "Dan,Danny".to_string(),
            email: "daniel@acme.test".to_string(),
            phone: String::new(),
            linkedin: String::new(),
        }
    }

    #[test]
    fn person_filename_uses_slug_and_id() {
        assert_eq!(person_filename(&person()), "person-daniel-1.md");
    }

    #[test]
    fn person_filename_arabic_name_keeps_readable_slug() {
        let mut p = person();
        p.name = "عمر".to_string();
        assert_eq!(person_filename(&p), "person-عمر-1.md");
    }

    #[test]
    fn render_person_note_has_frontmatter_and_owned_marker() {
        let note = render_person_note(&person(), &[]);
        assert!(note.starts_with("---\ntype: person\n"));
        assert!(note.contains("role: \"Engineer\""));
        assert!(note.contains("company: \"Acme\""));
        assert!(note.contains("aliases: \"Dan,Danny\""));
        assert!(note.contains("resource: adversaria://meeting/1"));
        assert!(note.contains("\n# Daniel\n"));
        assert!(note.contains("Works on the rendering pipeline."));
        // No "Meetings together" section when together is empty.
        assert!(!note.contains("## Meetings together"));
    }

    #[test]
    fn render_person_note_lists_together_meetings() {
        let m = meeting();
        let together = vec![&m];
        let note = render_person_note(&person(), &together);
        assert!(note.contains("## Meetings together"));
        // Wikilink uses the meeting's note_filename stem (no .md).
        assert!(note.contains("[[2026-07-06-q3-planning-budget-roadmap-7]]"));
        assert!(note.contains(" — 2026-07-06"));
    }

    #[test]
    fn person_together_matches_name_and_aliases() {
        let p = person(); // name: Daniel, aliases: Dan,Danny
        let m1 = Meeting {
            attendees: vec!["Daniel — daniel@acme.com".to_string()],
            ..meeting()
        };
        let m2 = Meeting {
            id: 8,
            attendees: vec!["Danny".to_string(), "Sarah".to_string()],
            ..meeting()
        };
        let m3 = Meeting {
            id: 9,
            attendees: vec!["Sarah".to_string(), "Bob".to_string()],
            ..meeting()
        };
        let exportable = vec![&m1, &m2, &m3];
        let together = person_together(&p, &exportable);
        assert_eq!(together.len(), 2);
        assert_eq!(together[0].id, m1.id);
        assert_eq!(together[1].id, m2.id);
    }

    #[test]
    fn person_together_case_insensitive() {
        let p = person(); // name: Daniel
        let m = Meeting {
            attendees: vec!["DANIEL".to_string()],
            ..meeting()
        };
        let exportable = vec![&m];
        let together = person_together(&p, &exportable);
        assert_eq!(together.len(), 1);
    }
}
