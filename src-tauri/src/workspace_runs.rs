//! Workspace execution helpers shared by the Tauri command layer.

use std::collections::{BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};

use crate::context_index::ContextHit;
use crate::types::{Meeting, WorkspaceAddon, WorkspaceEngine, WorkspaceTask};

const RUN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const RUN_POLL_INTERVAL: Duration = Duration::from_millis(500);

pub type LogSink = Arc<dyn Fn(String) + Send + Sync>;

/// Result of supervising a headless agent process.
pub struct AgentRunOutcome {
    pub log: String,
    pub stderr: String,
    pub exit_success: bool,
    pub timed_out: bool,
    pub stopped: bool,
}

/// Build the deterministic Markdown prompt shared by all workspace engines.
#[allow(clippy::too_many_arguments)]
pub fn compose_task_brief(
    task: &WorkspaceTask,
    meetings: &[Meeting],
    related: &[Meeting],
    folders: &[String],
    output_dir: &str,
    transcript_limit: usize,
    agent: Option<&WorkspaceAddon>,
    skills: &[WorkspaceAddon],
    vault_hits: &[ContextHit],
    project_hits: &[ContextHit],
    workspace_instructions: &str,
    network_allowed: bool,
    folder_excerpts: &[(String, String)],
) -> String {
    let mut brief = format!("# Task\n\n{}", task.title);
    if !task.details.trim().is_empty() {
        brief.push_str("\n\n");
        brief.push_str(&task.details);
    }

    if !task.rejection_notes.is_empty() {
        brief.push_str("\n\n# Previous attempts were rejected because\n\n");
        for note in &task.rejection_notes {
            brief.push_str("- ");
            brief.push_str(note);
            brief.push('\n');
        }
        brief.pop();
    }

    if !workspace_instructions.trim().is_empty() {
        brief.push_str("\n\n# Project instructions\n\n");
        brief.push_str(workspace_instructions.trim());
    }

    let deliverable = match task.capability.as_str() {
        "research" => Some(
            "Produce a Markdown report. End with a Sources section listing everything you used.",
        ),
        "write" => Some(
            "Produce the document as Markdown, or one self-contained HTML file when layout matters.",
        ),
        "visualize" => Some(
            "Produce ONE self-contained HTML file embedding a semantic inline SVG diagram with real labels and no external assets. The SVG must stand alone when extracted.",
        ),
        "present" => Some(
            "Produce the deck as ONE self-contained HTML file, one section element per slide, readable without a network.",
        ),
        _ => None,
    };
    if let Some(deliverable) = deliverable {
        brief.push_str("\n\n# Deliverable\n\n");
        brief.push_str(deliverable);
    }

    if network_allowed {
        brief.push_str("\n\n# Network access\n\n");
        brief.push_str(
            "Network access is allowed for this task. You may fetch from the web. List\n",
        );
        brief.push_str("every URL you actually used at the end of your output under a \"Sources\n");
        brief.push_str("fetched\" heading.");
    }

    if let Some(agent) = agent {
        brief.push_str("\n\n# Agent\n\n");
        brief.push_str(&agent.instructions);
    }

    if !skills.is_empty() {
        brief.push_str("\n\n# Skills");
        for skill in skills {
            brief.push_str("\n\n## ");
            brief.push_str(&skill.name);
            brief.push_str("\n\n");
            brief.push_str(&skill.instructions);
        }
    }

    brief.push_str("\n\n# Output instructions\n\n");
    brief.push_str("Write every deliverable file into `");
    brief.push_str(output_dir);
    brief.push_str("`. Markdown is preferred; choose clear filenames.");

    brief.push_str("\n\n# Reference folders (read-only)\n\n");
    if folders.is_empty() {
        brief.push_str("(none)");
    } else {
        for folder in folders {
            brief.push_str("- `");
            brief.push_str(folder);
            brief.push_str("`\n");
        }
        brief.pop();
    }

    if !folder_excerpts.is_empty() {
        brief.push_str("\n\n# Attached folder contents (excerpts)");
        for (folder, excerpt) in folder_excerpts {
            brief.push_str("\n\n## ");
            brief.push_str(folder);
            brief.push_str("\n\n");
            brief.push_str(excerpt);
        }
    }

    brief.push_str("\n\n# Meeting context");
    if meetings.is_empty() {
        brief.push_str("\n\n(none)");
    } else {
        for meeting in meetings {
            brief.push_str("\n\n## ");
            brief.push_str(&meeting.title);
            brief.push_str("\n\n");
            brief.push_str(&meeting.summary);
            brief.push_str("\n\n### Transcript\n\n");

            let mut chars = meeting.transcript.chars();
            let transcript: String = chars.by_ref().take(transcript_limit).collect();
            brief.push_str(&transcript);
            if chars.next().is_some() {
                brief.push_str("\n[transcript truncated]");
            }
        }
    }

    brief.push_str("\n\n# Related meetings (from your meeting graph)");
    if related.is_empty() {
        brief.push_str("\n\n(none)");
    } else {
        for meeting in related {
            brief.push_str("\n\n## ");
            brief.push_str(&meeting.title);
            brief.push_str("\n\n");
            brief.push_str(&meeting.summary);
        }
    }

    brief.push_str("\n\n# From your vault");
    if vault_hits.is_empty() {
        brief.push_str("\n\n(none)");
    } else {
        for hit in vault_hits {
            brief.push_str("\n\n## ");
            brief.push_str(&hit.title);
            brief.push_str(" (");
            brief.push_str(&hit.path);
            brief.push_str(")\n\n");
            brief.push_str(&hit.excerpt);
        }
    }

    brief.push_str("\n\n# Matching projects (read-only folders)");
    if project_hits.is_empty() {
        brief.push_str("\n\n(none)");
    } else {
        for hit in project_hits {
            brief.push_str("\n\n## ");
            brief.push_str(&hit.title);
            brief.push_str(" — `");
            brief.push_str(&hit.path);
            brief.push_str("`\n\n");
            brief.push_str(&hit.excerpt);
        }
    }

    brief.push_str("\n\n# Grounding rule\n\n");
    if meetings.is_empty()
        && related.is_empty()
        && vault_hits.is_empty()
        && project_hits.is_empty()
        && folder_excerpts.is_empty()
    {
        brief.push_str(
            "No meeting, vault, or project context was found for this task. Do NOT invent \
             a premise: work only from the task text, state plainly that no source \
             material was available, and list the open questions someone must answer.",
        );
    } else {
        brief.push_str(
            "Ground your work ONLY in the context above. If a detail is not in the \
             context, say so or leave it as an open question instead of inventing \
             facts, names, or premises.",
        );
    }

    brief
}

const FOLDER_EXCERPT_FILE_CHAR_CAP: usize = 4_000;
const FOLDER_EXCERPT_FILE_SIZE_CAP: u64 = 512 * 1024;

#[derive(Debug)]
struct FolderExcerptCandidate {
    priority: u8,
    relative_path: String,
    path: PathBuf,
}

fn folder_excerpt_priority(path: &Path, at_root: bool) -> Option<u8> {
    let file_name = path.file_name()?.to_string_lossy();
    let lower_name = file_name.to_ascii_lowercase();
    if at_root && lower_name.starts_with("readme") {
        return Some(0);
    }

    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())?;
    if extension == "md" {
        return Some(if at_root { 1 } else { 2 });
    }
    if matches!(
        extension.as_str(),
        "rs" | "ts"
            | "tsx"
            | "py"
            | "js"
            | "go"
            | "java"
            | "swift"
            | "kt"
            | "toml"
            | "json"
            | "yaml"
            | "yml"
    ) {
        return Some(3);
    }
    None
}

fn skipped_excerpt_directory(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "__pycache__" | "venv" | ".git"
        )
}

fn is_excerpt_candidate(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > FOLDER_EXCERPT_FILE_SIZE_CAP {
        return false;
    }

    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut prefix = Vec::with_capacity(4_096);
    if file.take(4_096).read_to_end(&mut prefix).is_err() {
        return false;
    }
    !prefix.contains(&0)
}

fn collect_folder_excerpt_candidates(root: &Path) -> Vec<FolderExcerptCandidate> {
    let mut candidates = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return candidates;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(priority) = folder_excerpt_priority(&path, true) {
                if is_excerpt_candidate(&path) {
                    candidates.push(FolderExcerptCandidate {
                        priority,
                        relative_path: entry.file_name().to_string_lossy().into_owned(),
                        path,
                    });
                }
            }
            continue;
        }
        if !path.is_dir() || skipped_excerpt_directory(&path) {
            continue;
        }

        let Ok(children) = std::fs::read_dir(&path) else {
            continue;
        };
        for child in children.flatten() {
            let child_path = child.path();
            let Some(priority) = folder_excerpt_priority(&child_path, false) else {
                continue;
            };
            if !is_excerpt_candidate(&child_path) {
                continue;
            }
            let relative_path = child_path
                .strip_prefix(root)
                .unwrap_or(&child_path)
                .to_string_lossy()
                .into_owned();
            candidates.push(FolderExcerptCandidate {
                priority,
                relative_path,
                path: child_path,
            });
        }
    }

    candidates.sort_by(|left, right| {
        left.priority
            .cmp(&right.priority)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates
}

/// Read a bounded, prioritized excerpt of a context folder for the brief.
pub fn folder_excerpt(root: &Path, char_cap: usize) -> String {
    let candidates = collect_folder_excerpt_candidates(root);
    let candidate_count = candidates.len();
    let root_name = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let reserved_header = format!(
        "# Folder: {root_name} - {candidate_count} files excerpted of {candidate_count} candidates"
    );
    let body_cap = char_cap.saturating_sub(reserved_header.chars().count());
    let mut body = String::new();
    let mut excerpted_count = 0;

    for candidate in candidates {
        let Ok(content) = std::fs::read_to_string(&candidate.path) else {
            continue;
        };
        let content =
            crate::project_overview::truncate_chars(&content, FOLDER_EXCERPT_FILE_CHAR_CAP);
        let section_header = format!("\n\n## {}\n\n", candidate.relative_path);
        let used = body.chars().count();
        if used + section_header.chars().count() > body_cap {
            break;
        }
        body.push_str(&section_header);
        let remaining = body_cap.saturating_sub(body.chars().count());
        let content_chars = content.chars().count();
        body.push_str(&crate::project_overview::truncate_chars(
            &content, remaining,
        ));
        excerpted_count += 1;
        if content_chars > remaining {
            break;
        }
    }

    let header = format!(
        "# Folder: {root_name} - {excerpted_count} files excerpted of {candidate_count} candidates"
    );
    format!("{header}{body}")
}

/// Write engine-native role and skill files into a workspace run directory.
pub fn write_native_addon_files(
    engine: &str,
    output_dir: &Path,
    agent: Option<&WorkspaceAddon>,
    skills: &[WorkspaceAddon],
) -> std::io::Result<()> {
    match engine {
        "claude" => {
            for skill in skills {
                let skill_dir = output_dir.join(".claude/skills").join(&skill.slug);
                std::fs::create_dir_all(&skill_dir)?;
                std::fs::write(
                    skill_dir.join("SKILL.md"),
                    format!(
                        "---\nname: {}\ndescription: {}\n---\n\n{}\n",
                        skill.slug, skill.description, skill.instructions
                    ),
                )?;
            }
            if let Some(agent) = agent {
                std::fs::create_dir_all(output_dir)?;
                std::fs::write(
                    output_dir.join("CLAUDE.md"),
                    format!("# Role\n\n{}\n", agent.instructions),
                )?;
            }
        }
        "codex" => {
            std::fs::create_dir_all(output_dir)?;
            let mut content = String::new();
            if let Some(agent) = agent {
                content.push_str("# Role\n\n");
                content.push_str(&agent.instructions);
                content.push('\n');
            }
            if !skills.is_empty() {
                if !content.is_empty() {
                    content.push('\n');
                }
                content.push_str("# Skills\n");
                for skill in skills {
                    content.push_str("\n## ");
                    content.push_str(&skill.name);
                    content.push_str("\n\n");
                    content.push_str(&skill.instructions);
                    content.push('\n');
                }
            }
            std::fs::write(output_dir.join("AGENTS.md"), content)?;
        }
        _ => {}
    }
    Ok(())
}

/// The agent and skills chosen for one run, with a human-readable reason per pick.
pub struct Staffing {
    pub agent: Option<WorkspaceAddon>,
    pub skills: Vec<WorkspaceAddon>,
    pub reasons: Vec<String>,
}

const STAFFING_STOP_WORDS: &[&str] = &[
    "the", "and", "for", "with", "from", "that", "this", "into", "your", "what", "when", "each",
    "every", "only", "them", "they", "have", "been", "than", "then", "onto", "over", "under",
];

const DIAGRAM_DOMAIN_WORDS: &[&str] = &[
    "diagram",
    "chart",
    "drawio",
    "draw.io",
    "architecture diagram",
    "flowchart",
    "hld",
    "high level diagram",
];
const SLIDES_DOMAIN_WORDS: &[&str] = &["slide", "slides", "deck", "presentation"];
const RESEARCH_DOMAIN_WORDS: &[&str] = &["research", "investigate", "compare", "landscape"];
const ARCHITECTURE_DOMAIN_WORDS: &[&str] = &["architecture", "design doc", "technical doc"];
const MARKETING_DOMAIN_WORDS: &[&str] = &["copy", "marketing", "launch", "announcement", "landing"];
const REVIEW_DOMAIN_WORDS: &[&str] = &["review", "critique", "feedback"];

const CAPABILITY_KEYWORDS: &[(&str, &[&str])] = &[
    (
        "research",
        &[
            "research",
            "investigate",
            "compare",
            "competitor",
            "competitors",
            "pricing",
            "market",
            "find out",
            "evaluate",
            "benchmark",
        ],
    ),
    (
        "write",
        &[
            "write", "draft", "doc", "document", "spec", "memo", "rfc", "proposal", "summary",
            "brief",
        ],
    ),
    (
        "visualize",
        &[
            "diagram",
            "architecture",
            "chart",
            "flow",
            "flowchart",
            "pipeline",
            "graph",
            "visualize",
            "map",
        ],
    ),
    (
        "present",
        &["slides", "deck", "presentation", "present", "keynote"],
    ),
];

/// The optional installed-skill slugs that can upgrade each capability.
pub fn adapter_slugs_for_capability(capability: &str) -> &'static [&'static str] {
    match capability {
        "research" => &["deep-research"],
        "write" => &[
            "meeting-grounded-writing",
            "architecture-doc",
            "marketing-copy",
        ],
        "visualize" => &["drawio-diagram"],
        "present" => &["slides-deck"],
        _ => &[],
    }
}

fn staffing_keywords(addon: &WorkspaceAddon) -> BTreeSet<String> {
    fn add_keyword(keywords: &mut BTreeSet<String>, word: &str) {
        let word = word.to_lowercase();
        if word.chars().count() >= 4 && !STAFFING_STOP_WORDS.contains(&word.as_str()) {
            keywords.insert(word);
        }
    }

    let mut keywords = BTreeSet::new();
    for word in addon.slug.split('-') {
        add_keyword(&mut keywords, word);
    }
    for word in addon
        .name
        .split(|character: char| !character.is_alphanumeric())
    {
        add_keyword(&mut keywords, word);
    }
    for word in addon
        .description
        .split(|character: char| !character.is_alphanumeric())
    {
        add_keyword(&mut keywords, word);
    }
    keywords
}

fn normalized_staffing_words(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn staffing_domain_words(addon: &WorkspaceAddon) -> &'static [&'static str] {
    match (addon.kind.as_str(), addon.slug.as_str()) {
        ("skill", "drawio-diagram") | ("agent", "diagrammer") => DIAGRAM_DOMAIN_WORDS,
        ("skill", "slides-deck") => SLIDES_DOMAIN_WORDS,
        ("skill", "deep-research") | ("agent", "researcher") => RESEARCH_DOMAIN_WORDS,
        ("skill", "architecture-doc") | ("agent", "tech-writer") => ARCHITECTURE_DOMAIN_WORDS,
        ("skill", "marketing-copy") => MARKETING_DOMAIN_WORDS,
        ("agent", "reviewer") => REVIEW_DOMAIN_WORDS,
        _ => &[],
    }
}

fn staffing_domain_match(
    lower_title: &str,
    bounded_title_words: &str,
    addon: &WorkspaceAddon,
) -> Option<&'static str> {
    staffing_domain_words(addon).iter().copied().find(|word| {
        if word.contains(' ') {
            lower_title.contains(word)
        } else {
            let word = normalized_staffing_words(word);
            bounded_title_words.contains(&format!(" {word} "))
        }
    })
}

fn staffing_score(
    lower_title: &str,
    lower_details: &str,
    bounded_title_words: &str,
    addon: &WorkspaceAddon,
) -> (u32, Option<String>) {
    let mut score = 0;
    let mut reason = None;
    let mut reason_weight = 0;
    for keyword in staffing_keywords(addon) {
        let weight = if lower_title.contains(&keyword) {
            3
        } else if lower_details.contains(&keyword) {
            1
        } else {
            0
        };
        score += weight;
        if weight > reason_weight {
            reason = Some(keyword);
            reason_weight = weight;
        }
    }
    if let Some(domain_word) = staffing_domain_match(lower_title, bounded_title_words, addon) {
        score += 6;
        reason = Some(domain_word.to_string());
    }
    (score, reason)
}

fn staffing_inputs(title: &str, details: &str) -> (String, String, String) {
    let lower_title = title.to_lowercase();
    let lower_details = details.to_lowercase();
    let title_words = normalized_staffing_words(&lower_title);
    let bounded_title_words = format!(" {title_words} ");
    (lower_title, lower_details, bounded_title_words)
}

/// Pick the strongest installed adapter for a capability, preserving catalog
/// order when scores tie.
pub fn best_adapter_for_capability<'a>(
    title: &str,
    details: &str,
    capability: &str,
    catalog: &'a [WorkspaceAddon],
) -> Option<&'a WorkspaceAddon> {
    let slugs = adapter_slugs_for_capability(capability);
    let (lower_title, lower_details, bounded_title_words) = staffing_inputs(title, details);
    let mut best: Option<(&WorkspaceAddon, u32)> = None;

    for addon in catalog
        .iter()
        .filter(|addon| addon.kind == "skill" && slugs.contains(&addon.slug.as_str()))
    {
        let score = staffing_score(&lower_title, &lower_details, &bounded_title_words, addon).0;
        if best.is_none_or(|(_, best_score)| score > best_score) {
            best = Some((addon, score));
        }
    }

    best.map(|(addon, _)| addon)
}

fn capability_keyword_matches(value: &str, keyword: &str) -> bool {
    let normalized_value = format!(" {} ", normalized_staffing_words(value));
    let normalized_keyword = normalized_staffing_words(keyword);
    // Tolerate simple plurals: "diagrams" must match the "diagram" keyword.
    [
        normalized_keyword.clone(),
        format!("{normalized_keyword}s"),
        format!("{normalized_keyword}es"),
    ]
    .iter()
    .any(|form| normalized_value.contains(&format!(" {form} ")))
}

/// Suggest what the AI should do only when one capability clears the confidence
/// floor and strictly beats every alternative.
pub fn suggest_capability(title: &str, details: &str) -> Option<String> {
    let lower_title = title.to_lowercase();
    let lower_details = details.to_lowercase();
    let mut scored = CAPABILITY_KEYWORDS
        .iter()
        .map(|(capability, keywords)| {
            let score = keywords.iter().fold(0, |score, keyword| {
                score
                    + if capability_keyword_matches(&lower_title, keyword) {
                        3
                    } else if capability_keyword_matches(&lower_details, keyword) {
                        1
                    } else {
                        0
                    }
            });
            (*capability, score)
        })
        .collect::<Vec<_>>();
    scored.sort_by_key(|item| std::cmp::Reverse(item.1));

    let (best_capability, best_score) = scored[0];
    let runner_up_score = scored[1].1;
    if best_score >= 3 && best_score > runner_up_score {
        Some(best_capability.to_string())
    } else {
        None
    }
}

/// Choose an agent and up to `max_skills` skills from `catalog` for one task.
/// Scores each addon by how well its slug/name/description matches the task's
/// title and details. Returns empty staffing when nothing scores above zero.
pub fn suggest_staffing(
    title: &str,
    details: &str,
    catalog: &[WorkspaceAddon],
    max_skills: usize,
) -> Staffing {
    struct ScoredAddon {
        addon: WorkspaceAddon,
        score: u32,
        reason: String,
    }

    let (lower_title, lower_details, bounded_title_words) = staffing_inputs(title, details);
    let mut agents = Vec::new();
    let mut skills = Vec::new();

    for addon in catalog {
        let (score, reason) =
            staffing_score(&lower_title, &lower_details, &bounded_title_words, addon);
        if score == 0 {
            continue;
        }
        let Some(reason) = reason else {
            continue;
        };
        let scored = ScoredAddon {
            addon: addon.clone(),
            score,
            reason,
        };
        match addon.kind.as_str() {
            "agent" => agents.push(scored),
            "skill" => skills.push(scored),
            _ => {}
        }
    }

    let by_score_then_id = |left: &ScoredAddon, right: &ScoredAddon| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.addon.id.cmp(&right.addon.id))
    };
    agents.sort_by(by_score_then_id);
    skills.sort_by(by_score_then_id);

    let agent = agents.into_iter().next();
    let skills = skills.into_iter().take(max_skills).collect::<Vec<_>>();
    let mut reasons = Vec::new();
    if let Some(agent) = &agent {
        reasons.push(format!(
            "Chose the {} agent automatically — the task mentions \"{}\".",
            agent.addon.name, agent.reason
        ));
    }
    for skill in &skills {
        reasons.push(format!(
            "Attached the {} skill automatically — the task mentions \"{}\".",
            skill.addon.name, skill.reason
        ));
    }

    Staffing {
        agent: agent.map(|scored| scored.addon),
        skills: skills.into_iter().map(|scored| scored.addon).collect(),
        reasons,
    }
}

/// Summarize exactly which context sources were made available to a run.
#[allow(clippy::too_many_arguments)]
pub fn context_receipt(
    meetings: &[Meeting],
    related: &[(Meeting, String)],
    folders: &[String],
    sources: &crate::types::ContextSources,
    vault_hits: &[ContextHit],
    project_hits: &[ContextHit],
    agent: Option<&WorkspaceAddon>,
    skills: &[WorkspaceAddon],
    folder_excerpts_inlined: bool,
) -> String {
    let meeting_word = if meetings.len() == 1 {
        "meeting"
    } else {
        "meetings"
    };
    let folder_word = if folders.len() == 1 {
        "folder"
    } else {
        "folders"
    };
    let related_titles = if related.is_empty() {
        "none".to_string()
    } else {
        related
            .iter()
            .map(|(meeting, label)| format!("{} {label}", meeting.title))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut receipt = format!(
        "Context: {} bound {meeting_word} · {} related via graph ({related_titles}) · {} {folder_word}",
        meetings.len(),
        related.len(),
        folders.len()
    );
    if folder_excerpts_inlined {
        receipt.push_str(", folder excerpts inlined");
    }
    if !sources.vault_path.is_empty() {
        let titles = if vault_hits.is_empty() {
            "none".to_string()
        } else {
            vault_hits
                .iter()
                .map(|hit| format!("{} {}", hit.title, hit.signal))
                .collect::<Vec<_>>()
                .join(", ")
        };
        receipt.push_str(&format!(" · vault: {} ({titles})", vault_hits.len()));
    }
    if !sources.projects_root.is_empty() {
        let titles = if project_hits.is_empty() {
            "none".to_string()
        } else {
            project_hits
                .iter()
                .map(|hit| format!("{} {}", hit.title, hit.signal))
                .collect::<Vec<_>>()
                .join(", ")
        };
        receipt.push_str(&format!(" · projects: {} ({titles})", project_hits.len()));
    }
    if let Some(agent) = agent {
        receipt.push_str(" · agent: ");
        receipt.push_str(&agent.name);
    }
    if !skills.is_empty() {
        receipt.push_str(" · skills: ");
        receipt.push_str(
            &skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    receipt
}

/// Select usable graph-ranked meetings without changing the ranking order.
pub fn select_related_meetings(
    hits: &[crate::embeddings::RelatedHit],
    meetings: &[Meeting],
    limit: usize,
) -> Vec<(Meeting, String)> {
    let meetings_by_id: HashMap<i64, &Meeting> = meetings
        .iter()
        .map(|meeting| (meeting.id, meeting))
        .collect();
    hits.iter()
        .filter_map(|hit| {
            meetings_by_id
                .get(&hit.meeting_id)
                .copied()
                .map(|meeting| (meeting, &hit.signal))
        })
        .filter(|(meeting, _)| !meeting.archived && !meeting.summary.trim().is_empty())
        .take(limit)
        .map(|(meeting, signal)| {
            let label = match signal {
                crate::embeddings::RelatedSignal::TextMatch => "[text match]".to_string(),
                crate::embeddings::RelatedSignal::Semantic(score) => format!("[{score:.2}]"),
            };
            (meeting.clone(), label)
        })
        .collect()
}

/// Prefix a child process PATH with common macOS GUI-missing binary locations.
pub fn configure_gui_path(command: &mut Command) {
    let path = std::env::var("PATH").unwrap_or_default();
    command.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
}

/// Probe one CLI without assuming it is installed on the current machine.
pub fn probe_cli(bin: &str) -> (bool, String) {
    let mut command = Command::new(bin);
    command.arg("--version");
    configure_gui_path(&mut command);
    match command.output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            (true, version)
        }
        _ => (false, String::new()),
    }
}

/// Detect all workspace engines, including a caller-provided local service state.
pub fn detect_engines(service_ok: bool) -> Vec<WorkspaceEngine> {
    let (claude_available, claude_version) = probe_cli("claude");
    let (codex_available, codex_version) = probe_cli("codex");
    vec![
        WorkspaceEngine {
            id: "local".to_string(),
            label: "Local model".to_string(),
            available: service_ok,
            version: String::new(),
            detail: if service_ok {
                String::new()
            } else {
                "The local AI service isn't running. Check Settings → Setup status.".to_string()
            },
        },
        WorkspaceEngine {
            id: "claude".to_string(),
            label: "Claude Code".to_string(),
            available: claude_available,
            version: claude_version,
            detail: if claude_available {
                String::new()
            } else {
                "Claude Code CLI not found on this Mac.".to_string()
            },
        },
        WorkspaceEngine {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            available: codex_available,
            version: codex_version,
            detail: if codex_available {
                String::new()
            } else {
                "Codex CLI not found on this Mac.".to_string()
            },
        },
    ]
}

/// Run and supervise a configured agent command on a blocking thread.
pub fn supervise_agent_run(
    mut command: Command,
    run_id: i64,
    children: Arc<Mutex<HashMap<i64, Child>>>,
    on_log: LogSink,
    initial_log: String,
) -> Result<AgentRunOutcome, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start workspace agent: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Workspace agent stdout was not captured.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Workspace agent stderr was not captured.".to_string())?;

    children.lock().unwrap().insert(run_id, child);

    let shared_log = Arc::new(Mutex::new(initial_log));
    let stdout_log = Arc::clone(&shared_log);
    let stdout_thread = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            let chunk = format!("{line}\n");
            on_log(chunk.clone());
            stdout_log.lock().unwrap().push_str(&chunk);
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut stderr = BufReader::new(stderr);
        let mut output = String::new();
        match stderr.read_to_string(&mut output) {
            Ok(_) => output,
            Err(error) => format!("Couldn't read workspace agent stderr: {error}"),
        }
    });

    let started = Instant::now();
    let mut exit_success = false;
    let mut timed_out = false;
    let mut stopped = false;
    loop {
        if started.elapsed() >= RUN_TIMEOUT {
            if let Some(mut child) = children.lock().unwrap().remove(&run_id) {
                let _ = child.kill();
                let _ = child.wait();
            }
            timed_out = true;
            break;
        }

        let status = {
            let mut children = children.lock().unwrap();
            match children.get_mut(&run_id) {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        children.remove(&run_id);
                        Some(Ok(status.success()))
                    }
                    Ok(None) => None,
                    Err(error) => {
                        if let Some(mut child) = children.remove(&run_id) {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        Some(Err(error.to_string()))
                    }
                },
                None => {
                    stopped = true;
                    break;
                }
            }
        };

        if let Some(status) = status {
            exit_success = status.map_err(|error| {
                format!("Couldn't monitor the workspace agent process: {error}")
            })?;
            break;
        }

        let current_log = shared_log.lock().unwrap().clone();
        let _ = crate::storage::update_workspace_run_log(run_id, &current_log);
        std::thread::sleep(RUN_POLL_INTERVAL);
    }

    let _ = stdout_thread.join();
    let stderr = stderr_thread.join().unwrap_or_default();
    let log = shared_log.lock().unwrap().clone();
    let _ = crate::storage::update_workspace_run_log(run_id, &log);

    Ok(AgentRunOutcome {
        log,
        stderr,
        exit_success,
        timed_out,
        stopped,
    })
}

/// Return every regular file under an output directory in deterministic order.
pub fn scan_output_files(output_dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    fn visit(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                visit(&entry.path(), files)?;
            } else if file_type.is_file() {
                files.push(entry.path());
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(output_dir, &mut files)?;
    files.sort();
    Ok(files)
}

fn drawio_element_has_vertex(element: &BytesStart<'_>, position: u64) -> Result<bool, String> {
    let mut has_vertex = false;
    for attribute in element.attributes() {
        let attribute = attribute
            .map_err(|error| format!("not well-formed XML at position {position}: {error}"))?;
        let value = attribute
            .decoded_and_normalized_value(XmlVersion::Implicit1_0, element.decoder())
            .map_err(|error| format!("not well-formed XML at position {position}: {error}"))?;
        if attribute.key.as_ref() == b"vertex" && value == "1" {
            has_vertex = true;
        }
    }
    Ok(has_vertex)
}

fn drawio_path_is(stack: &[Vec<u8>], expected: &[&[u8]]) -> bool {
    stack.len() == expected.len()
        && stack
            .iter()
            .zip(expected)
            .all(|(actual, expected)| actual.as_slice() == *expected)
}

/// Validate that a produced .drawio artifact is uncompressed, well-formed XML
/// with the mxfile/diagram/mxGraphModel/root nesting and at least one vertex.
pub fn validate_drawio(content: &str) -> Result<(), String> {
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);

    let mut stack = Vec::<Vec<u8>>::new();
    let mut saw_mxfile = false;
    let mut saw_diagram = false;
    let mut saw_graph_model = false;
    let mut saw_root = false;
    let mut vertex_count = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = element.name().as_ref().to_vec();
                if name == b"mxfile" && stack.is_empty() {
                    saw_mxfile = true;
                } else if name == b"diagram" && drawio_path_is(&stack, &[b"mxfile"]) {
                    saw_diagram = true;
                } else if name == b"mxGraphModel"
                    && drawio_path_is(&stack, &[b"mxfile", b"diagram"])
                {
                    saw_graph_model = true;
                } else if name == b"root"
                    && drawio_path_is(&stack, &[b"mxfile", b"diagram", b"mxGraphModel"])
                {
                    saw_root = true;
                }
                let has_vertex = drawio_element_has_vertex(&element, reader.buffer_position())?;
                if name == b"mxCell" && has_vertex {
                    vertex_count += 1;
                }
                stack.push(name);
            }
            Ok(Event::Empty(element)) => {
                let name = element.name().as_ref().to_vec();
                if name == b"mxfile" && stack.is_empty() {
                    saw_mxfile = true;
                } else if name == b"diagram" && drawio_path_is(&stack, &[b"mxfile"]) {
                    saw_diagram = true;
                } else if name == b"mxGraphModel"
                    && drawio_path_is(&stack, &[b"mxfile", b"diagram"])
                {
                    saw_graph_model = true;
                } else if name == b"root"
                    && drawio_path_is(&stack, &[b"mxfile", b"diagram", b"mxGraphModel"])
                {
                    saw_root = true;
                }
                let has_vertex = drawio_element_has_vertex(&element, reader.buffer_position())?;
                if name == b"mxCell" && has_vertex {
                    vertex_count += 1;
                }
            }
            Ok(Event::End(_)) => {
                stack.pop();
            }
            Ok(Event::Text(text)) => {
                if stack.last().is_some_and(|name| name == b"diagram") {
                    let text = text.decode().map_err(|error| {
                        format!(
                            "not well-formed XML at position {}: {error}",
                            reader.buffer_position()
                        )
                    })?;
                    if text
                        .split_whitespace()
                        .any(|run| run.chars().count() > 40 && !run.contains('<'))
                    {
                        return Err(
                            "compressed draw.io payload — must be uncompressed XML".to_string()
                        );
                    }
                }
            }
            Ok(Event::Eof) => {
                if let Some(name) = stack.last() {
                    return Err(format!(
                        "not well-formed XML at position {}: unexpected EOF with unclosed <{}> element",
                        reader.buffer_position(),
                        String::from_utf8_lossy(name)
                    ));
                }
                break;
            }
            Ok(_) => {}
            Err(error) => {
                return Err(format!(
                    "not well-formed XML at position {}: {error}",
                    reader.buffer_position()
                ));
            }
        }
    }

    for (name, saw_element) in [
        ("mxfile", saw_mxfile),
        ("diagram", saw_diagram),
        ("mxGraphModel", saw_graph_model),
        ("root", saw_root),
    ] {
        if !saw_element {
            return Err(format!(
                "missing <{name}> element — is the file compressed or truncated?"
            ));
        }
    }
    if vertex_count == 0 {
        return Err("no vertex cells — the diagram is empty".to_string());
    }
    Ok(())
}

/// Scan an output dir and return one warning line per invalid .drawio artifact.
pub fn drawio_artifact_warnings(output_dir: &Path) -> Vec<String> {
    let Ok(files) = scan_output_files(output_dir) else {
        return Vec::new();
    };

    files
        .into_iter()
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("drawio"))
        })
        .filter_map(|path| {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            let error = match std::fs::read_to_string(&path) {
                Ok(content) => validate_drawio(&content).err(),
                Err(error) => Some(format!("could not read file: {error}")),
            }?;
            Some(format!(
                "Warning: {name} failed draw.io validation: {error}"
            ))
        })
        .collect()
}

/// Return the last `limit` Unicode scalar values from a string.
pub fn tail_chars(value: &str, limit: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    chars[chars.len().saturating_sub(limit)..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embeddings::{RelatedHit, RelatedSignal};

    fn task() -> WorkspaceTask {
        WorkspaceTask {
            id: 1,
            workspace_id: 2,
            title: "Write the launch memo".to_string(),
            details: "Cover decisions and next steps.".to_string(),
            capability: String::new(),
            status: "queued".to_string(),
            source_meeting_id: None,
            source_meeting_title: String::new(),
            action_item_id: None,
            attempt: 1,
            rejection_notes: Vec::new(),
            agent_eligible: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn meeting(transcript: String) -> Meeting {
        Meeting {
            id: 7,
            title: "Launch review".to_string(),
            recorded_at: String::new(),
            duration_seconds: 0.0,
            transcript,
            summary: "The team approved the staged launch.".to_string(),
            template_used: String::new(),
            audio_file_path: None,
            attendees: Vec::new(),
            user_notes: String::new(),
            link: String::new(),
            tags: Vec::new(),
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: Vec::new(),
        }
    }

    fn addon(kind: &str, slug: &str, name: &str, instructions: &str) -> WorkspaceAddon {
        WorkspaceAddon {
            id: 1,
            kind: kind.to_string(),
            slug: slug.to_string(),
            name: name.to_string(),
            description: format!("{name} description"),
            instructions: instructions.to_string(),
            builtin: true,
            created_at: String::new(),
        }
    }

    fn staffing_catalog() -> Vec<WorkspaceAddon> {
        [
            (
                "skill",
                "drawio-diagram",
                "Draw.io diagram",
                "Produce an editable .drawio file (plus a short legend) that opens in draw.io desktop.",
            ),
            (
                "skill",
                "slides-deck",
                "Slides deck",
                "A presentation as a Marp Markdown deck: one idea per slide, speaker notes, sources.",
            ),
            (
                "skill",
                "deep-research",
                "Deep research",
                "Structured research from the context you have, with confidence and open questions.",
            ),
            (
                "skill",
                "architecture-doc",
                "Architecture doc",
                "Turn a repo and its meetings into a grounded architecture document.",
            ),
            (
                "skill",
                "marketing-copy",
                "Marketing copy",
                "Audience first, one promise per piece, concrete nouns, two variants.",
            ),
            (
                "skill",
                "meeting-grounded-writing",
                "Meeting-grounded writing",
                "Every claim points at the meeting it came from; gaps are named, not filled.",
            ),
            (
                "agent",
                "diagrammer",
                "Diagrammer",
                "Explains systems with diagrams first, prose second.",
            ),
            (
                "agent",
                "researcher",
                "Researcher",
                "Investigates before writing; separates what is known from what is guessed.",
            ),
            (
                "agent",
                "tech-writer",
                "Technical writer",
                "Writes precise, structured documents grounded in code and meetings.",
            ),
            (
                "agent",
                "reviewer",
                "Reviewer",
                "A critical reader: finds problems, ranks them, proposes fixes; never rewrites wholesale.",
            ),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (kind, slug, name, description))| WorkspaceAddon {
            id: index as i64 + 1,
            kind: kind.to_string(),
            slug: slug.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            instructions: format!("{name} instructions"),
            builtin: true,
            created_at: String::new(),
        })
        .collect()
    }

    fn addon_temp_dir(label: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "adversaria-addon-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    fn valid_drawio() -> &'static str {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="drawio"><diagram name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="A" style="rounded=1" vertex="1" parent="1"><mxGeometry x="0" y="0" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="3" value="writes" style="edgeStyle=orthogonalEdgeStyle" edge="1" parent="1" source="2" target="2"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>"#
    }

    #[test]
    fn empty_context_brief_forbids_invented_premises() {
        let brief = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            4_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(brief.contains("# Grounding rule"));
        assert!(brief.contains("No meeting, vault, or project context was found"));
        assert!(brief.contains("Do NOT invent"));
    }

    #[test]
    fn task_brief_includes_folder_excerpt_section_only_when_provided() {
        let folder_excerpts = vec![(
            "/tmp/reference".to_string(),
            "# Folder: reference - 1 files excerpted of 1 candidates\n\n## README.md\n\nProject overview."
                .to_string(),
        )];
        let with_excerpt = compose_task_brief(
            &task(),
            &[],
            &[],
            &["/tmp/reference".to_string()],
            "/tmp/output",
            4_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &folder_excerpts,
        );
        let without_excerpt = compose_task_brief(
            &task(),
            &[],
            &[],
            &["/tmp/reference".to_string()],
            "/tmp/output",
            4_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );

        assert!(with_excerpt.contains(
            "# Attached folder contents (excerpts)\n\n## /tmp/reference\n\n# Folder: reference"
        ));
        assert!(!without_excerpt.contains("# Attached folder contents (excerpts)"));
        assert!(!with_excerpt.contains("No meeting, vault, or project context was found"));
    }

    #[test]
    fn folder_excerpt_prioritizes_root_readme() {
        let dir = addon_temp_dir("folder-excerpt-priority");
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("notes.md"), "Root notes").unwrap();
        std::fs::write(dir.join("README.MD"), "Read me first").unwrap();
        std::fs::write(dir.join("docs/guide.md"), "Nested guide").unwrap();
        std::fs::write(dir.join("main.rs"), "fn main() {}").unwrap();

        let excerpt = folder_excerpt(&dir, 20_000);

        assert!(excerpt.starts_with("# Folder:"));
        let readme = excerpt.find("## README.MD").unwrap();
        let root_markdown = excerpt.find("## notes.md").unwrap();
        let nested_markdown = excerpt.find("## docs/guide.md").unwrap();
        let source = excerpt.find("## main.rs").unwrap();
        assert!(readme < root_markdown);
        assert!(root_markdown < nested_markdown);
        assert!(nested_markdown < source);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn folder_excerpt_respects_unicode_character_cap() {
        let dir = addon_temp_dir("folder-excerpt-cap");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("README.md"), "é".repeat(5_000)).unwrap();

        let excerpt = folder_excerpt(&dir, 180);

        assert!(excerpt.chars().count() <= 180);
        assert!(excerpt.contains("## README.md"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn folder_excerpt_skips_node_modules() {
        let dir = addon_temp_dir("folder-excerpt-node-modules");
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("visible.md"), "Visible").unwrap();
        std::fs::write(dir.join("node_modules/hidden.md"), "Hidden dependency").unwrap();

        let excerpt = folder_excerpt(&dir, 20_000);

        assert!(excerpt.contains("## visible.md"));
        assert!(!excerpt.contains("hidden.md"));
        assert!(!excerpt.contains("Hidden dependency"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn folder_excerpt_skips_binary_files() {
        let dir = addon_temp_dir("folder-excerpt-binary");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("good.md"), "Readable text").unwrap();
        std::fs::write(dir.join("binary.md"), b"binary\0payload").unwrap();

        let excerpt = folder_excerpt(&dir, 20_000);

        assert!(excerpt.contains("1 files excerpted of 1 candidates"));
        assert!(excerpt.contains("## good.md"));
        assert!(!excerpt.contains("binary.md"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn plural_keywords_still_suggest() {
        assert_eq!(
            suggest_capability(
                "Create full low-level and high-level diagrams for the MIQ project",
                ""
            )
            .as_deref(),
            Some("visualize")
        );
    }

    #[test]
    fn capabilities_map_to_their_optional_adapters() {
        assert_eq!(adapter_slugs_for_capability("research"), &["deep-research"]);
        assert_eq!(
            adapter_slugs_for_capability("write"),
            &[
                "meeting-grounded-writing",
                "architecture-doc",
                "marketing-copy"
            ]
        );
        assert_eq!(
            adapter_slugs_for_capability("visualize"),
            &["drawio-diagram"]
        );
        assert_eq!(adapter_slugs_for_capability("present"), &["slides-deck"]);
        assert!(adapter_slugs_for_capability("unknown").is_empty());
    }

    #[test]
    fn task_capability_suggestion_requires_a_unique_confident_match() {
        assert_eq!(
            suggest_capability("Diagram the auth flow", "").as_deref(),
            Some("visualize")
        );
        assert_eq!(suggest_capability("call that guy back", ""), None);
        assert_eq!(suggest_capability("prepare the client briefing", ""), None);
    }

    #[test]
    fn suggest_staffing_picks_diagrammer_and_drawio_for_high_level_diagram() {
        let staffing = suggest_staffing(
            "high level diagram for Adversaria",
            "",
            &staffing_catalog(),
            2,
        );

        assert_eq!(staffing.agent.as_ref().unwrap().slug, "diagrammer");
        assert!(staffing
            .skills
            .iter()
            .any(|skill| skill.slug == "drawio-diagram"));
        assert!(!staffing.reasons.is_empty());
        assert_eq!(
            staffing.reasons[0],
            "Chose the Diagrammer agent automatically — the task mentions \"diagram\"."
        );
        assert!(staffing.reasons.iter().any(|reason| {
            reason
            == "Attached the Draw.io diagram skill automatically — the task mentions \"diagram\"."
        }));
    }

    #[test]
    fn suggest_staffing_picks_slides_without_diagrammer_for_slide_deck() {
        let staffing = suggest_staffing(
            "Build a slide deck for the beta launch",
            "",
            &staffing_catalog(),
            2,
        );

        assert!(staffing
            .skills
            .iter()
            .any(|skill| skill.slug == "slides-deck"));
        assert_ne!(
            staffing.agent.as_ref().map(|agent| agent.slug.as_str()),
            Some("diagrammer")
        );
    }

    #[test]
    fn suggest_staffing_picks_research_for_comparison() {
        let staffing = suggest_staffing(
            "Compare the top three notetakers",
            "",
            &staffing_catalog(),
            2,
        );

        assert!(
            staffing
                .agent
                .as_ref()
                .is_some_and(|agent| agent.slug == "researcher")
                || staffing
                    .skills
                    .iter()
                    .any(|skill| skill.slug == "deep-research")
        );
    }

    #[test]
    fn suggest_staffing_returns_empty_for_unmatched_task() {
        let staffing = suggest_staffing("asdfgh qwerty", "", &staffing_catalog(), 2);

        assert!(staffing.agent.is_none());
        assert!(staffing.skills.is_empty());
        assert!(staffing.reasons.is_empty());
    }

    #[test]
    fn suggest_staffing_respects_max_skills() {
        let staffing = suggest_staffing(
            "Create a diagram, slides, and research summary",
            "",
            &staffing_catalog(),
            2,
        );

        assert!(staffing.skills.len() <= 2);
    }

    #[test]
    fn suggest_staffing_is_deterministic() {
        let catalog = staffing_catalog();
        let first = suggest_staffing("Research an architecture diagram", "", &catalog, 2);
        let second = suggest_staffing("Research an architecture diagram", "", &catalog, 2);
        let slugs = |staffing: &Staffing| {
            (
                staffing.agent.as_ref().map(|agent| agent.slug.clone()),
                staffing
                    .skills
                    .iter()
                    .map(|skill| skill.slug.clone())
                    .collect::<Vec<_>>(),
            )
        };

        assert_eq!(slugs(&first), slugs(&second));
    }

    #[test]
    fn validates_minimal_uncompressed_drawio() {
        assert_eq!(validate_drawio(valid_drawio()), Ok(()));
    }

    #[test]
    fn rejects_truncated_drawio() {
        let valid = valid_drawio();
        let truncated = &valid[..valid.len() - 20];
        let error = validate_drawio(truncated).unwrap_err();
        assert!(error.contains("well-formed"), "{error}");
    }

    #[test]
    fn rejects_unescaped_ampersand_in_drawio_attribute() {
        let invalid = valid_drawio().replacen("value=\"A\"", "value=\"A & B\"", 1);
        assert!(validate_drawio(&invalid).is_err());
    }

    #[test]
    fn rejects_drawio_without_vertices() {
        let invalid = r#"<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="drawio"><diagram name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
</root></mxGraphModel></diagram></mxfile>"#;
        let error = validate_drawio(invalid).unwrap_err();
        assert!(error.contains("no vertex"), "{error}");
    }

    #[test]
    fn rejects_compressed_drawio_payload() {
        let invalid = r#"<mxfile host="app"><diagram id="x">dGhpcyBpcyBkZWZpbml0ZWx5IG5vdCB4bWwgYXQgYWxsIGp1c3QgYmFzZTY0</diagram></mxfile>"#;
        let error = validate_drawio(invalid).unwrap_err();
        assert!(error.contains("compressed"), "{error}");
    }

    #[test]
    fn drawio_warnings_name_only_the_invalid_artifact() {
        let dir = addon_temp_dir("drawio-warnings");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("valid.drawio"), valid_drawio()).unwrap();
        std::fs::write(dir.join("broken.drawio"), "<mxfile>").unwrap();

        let warnings = drawio_artifact_warnings(&dir);

        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("broken.drawio"), "{}", warnings[0]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn task_brief_contains_context_and_truncates_long_transcripts() {
        let transcript = "x".repeat(30_000);
        let brief = compose_task_brief(
            &task(),
            &[meeting(transcript)],
            &[],
            &["/Users/example/reference".to_string()],
            "/Users/example/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );

        assert!(brief.contains("Write the launch memo"));
        assert!(brief.contains("/Users/example/output"));
        assert!(brief.contains("/Users/example/reference"));
        assert!(brief.contains("Launch review"));
        assert!(brief.contains("The team approved the staged launch."));
        assert!(brief.contains(&"x".repeat(20_000)));
        assert!(!brief.contains(&"x".repeat(20_001)));
        assert!(brief.contains("[transcript truncated]"));
    }

    #[test]
    fn task_brief_honors_transcript_limit() {
        let brief = compose_task_brief(
            &task(),
            &[meeting("1234567890extra".to_string())],
            &[],
            &[],
            "/tmp/output",
            10,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(brief.contains("### Transcript\n\n1234567890\n[transcript truncated]"));
        assert!(!brief.contains("1234567890e"));
    }

    #[test]
    fn task_brief_lists_rejection_notes() {
        let without_notes = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(!without_notes.contains("# Previous attempts were rejected because"));

        let mut rejected = task();
        rejected.rejection_notes = vec!["Too long".to_string(), "Cite the source".to_string()];
        let with_notes = compose_task_brief(
            &rejected,
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(with_notes.contains(
            "# Previous attempts were rejected because\n\n- Too long\n- Cite the source"
        ));
    }

    #[test]
    fn task_brief_includes_related_summaries_or_an_explicit_empty_section() {
        let mut related = meeting("Related transcript must stay out".to_string());
        related.id = 8;
        related.title = "Pricing follow-up".to_string();
        related.summary = "The team agreed on the enterprise tier.".to_string();

        let with_related = compose_task_brief(
            &task(),
            &[],
            &[related],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(with_related.contains(
            "# Related meetings (from your meeting graph)\n\n## Pricing follow-up\n\nThe team agreed on the enterprise tier."
        ));
        assert!(!with_related.contains("Related transcript must stay out"));

        let without_related = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(without_related.contains("# Related meetings (from your meeting graph)\n\n(none)"));
    }

    #[test]
    fn task_brief_includes_vault_and_project_matches() {
        let vault = ContextHit {
            source: "vault".to_string(),
            path: "/vault/wiki/projects/MIQ-Agentic.md".to_string(),
            title: "MIQ Agentic".to_string(),
            signal: "[text match]".to_string(),
            excerpt: "The project uses an agentic research loop.".to_string(),
        };
        let project = ContextHit {
            source: "project".to_string(),
            path: "/projects/lagharilabs-website".to_string(),
            title: "lagharilabs-website".to_string(),
            signal: "[0.71]".to_string(),
            excerpt: "Founder portfolio website.".to_string(),
        };

        let brief = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[vault],
            &[project],
            "",
            false,
            &[],
        );

        assert!(brief.contains(
            "# From your vault\n\n## MIQ Agentic (/vault/wiki/projects/MIQ-Agentic.md)\n\nThe project uses an agentic research loop."
        ));
        assert!(brief.contains(
            "# Matching projects (read-only folders)\n\n## lagharilabs-website — `/projects/lagharilabs-website`\n\nFounder portfolio website."
        ));
    }

    #[test]
    fn task_brief_injects_agent_and_skills_after_the_task() {
        let mut rejected = task();
        rejected.rejection_notes = vec!["Use sources".to_string()];
        let agent = addon("agent", "researcher", "Researcher", "Investigate first.");
        let skills = vec![
            addon(
                "skill",
                "deep-research",
                "Deep research",
                "Show confidence.",
            ),
            addon("skill", "citations", "Citations", "Cite every source."),
        ];
        let brief = compose_task_brief(
            &rejected,
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            Some(&agent),
            &skills,
            &[],
            &[],
            "",
            false,
            &[],
        );

        assert!(brief.contains(
            "# Previous attempts were rejected because\n\n- Use sources\n\n# Agent\n\nInvestigate first.\n\n# Skills\n\n## Deep research\n\nShow confidence.\n\n## Citations\n\nCite every source."
        ));
    }

    #[test]
    fn task_brief_can_inject_only_skills() {
        let skills = vec![addon(
            "skill",
            "deep-research",
            "Deep research",
            "Show confidence.",
        )];
        let brief = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &skills,
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(!brief.contains("# Agent"));
        assert!(brief.contains("# Skills\n\n## Deep research\n\nShow confidence."));
    }

    #[test]
    fn task_brief_adds_no_addon_sections_when_none_are_attached() {
        let brief = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(!brief.contains("# Agent"));
        assert!(!brief.contains("# Skills"));
    }

    #[test]
    fn task_brief_includes_project_instructions_when_present() {
        let brief = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "Prioritize technical risks.",
            false,
            &[],
        );
        assert!(brief.contains("# Project instructions\n\nPrioritize technical risks."));
        // Must be before Agent/Skills and after rejection notes.
        let agent = addon("agent", "researcher", "Researcher", "Investigate first.");
        let with_agent = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            Some(&agent),
            &[],
            &[],
            &[],
            "Keep decisions concise.",
            false,
            &[],
        );
        let instr_pos = with_agent.find("# Project instructions").unwrap();
        let agent_pos = with_agent.find("# Agent").unwrap();
        assert!(instr_pos < agent_pos);
    }

    #[test]
    fn task_brief_includes_each_capability_deliverable_contract() {
        let contracts = [
            (
                "research",
                "Produce a Markdown report. End with a Sources section listing everything you used.",
            ),
            (
                "write",
                "Produce the document as Markdown, or one self-contained HTML file when layout matters.",
            ),
            (
                "visualize",
                "Produce ONE self-contained HTML file embedding a semantic inline SVG diagram with real labels and no external assets. The SVG must stand alone when extracted.",
            ),
            (
                "present",
                "Produce the deck as ONE self-contained HTML file, one section element per slide, readable without a network.",
            ),
        ];

        for (capability, contract) in contracts {
            let mut capability_task = task();
            capability_task.capability = capability.to_string();
            let brief = compose_task_brief(
                &capability_task,
                &[],
                &[],
                &[],
                "/tmp/output",
                20_000,
                None,
                &[],
                &[],
                &[],
                "Keep decisions concise.",
                false,
                &[],
            );
            assert!(brief.contains(&format!("# Deliverable\n\n{contract}")));
            assert!(
                brief.find("# Project instructions").unwrap()
                    < brief.find("# Deliverable").unwrap()
            );
        }

        let brief = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(!brief.contains("# Deliverable"));
    }

    #[test]
    fn task_brief_omits_project_instructions_when_blank() {
        let brief_empty = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "",
            false,
            &[],
        );
        assert!(!brief_empty.contains("# Project instructions"));
        let brief_whitespace = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "   \n\t  ",
            false,
            &[],
        );
        assert!(!brief_whitespace.contains("# Project instructions"));
        // Trimming
        let brief_trimmed = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "  keep decisions concise  ",
            false,
            &[],
        );
        assert!(brief_trimmed.contains("# Project instructions\n\nkeep decisions concise"));
    }

    #[test]
    fn task_brief_states_when_network_access_is_allowed() {
        let allowed = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "Keep decisions concise.",
            true,
            &[],
        );
        let forbidden = compose_task_brief(
            &task(),
            &[],
            &[],
            &[],
            "/tmp/output",
            20_000,
            None,
            &[],
            &[],
            &[],
            "Keep decisions concise.",
            false,
            &[],
        );
        let section = "# Network access\n\nNetwork access is allowed for this task. You may fetch from the web. List\nevery URL you actually used at the end of your output under a \"Sources\nfetched\" heading.";

        assert!(allowed.contains(section));
        assert!(!forbidden.contains("# Network access"));
        assert!(
            allowed.find("# Project instructions").unwrap()
                < allowed.find("# Network access").unwrap()
        );
    }

    #[test]
    fn native_claude_files_include_skill_frontmatter_and_role() {
        let dir = addon_temp_dir("claude");
        std::fs::create_dir_all(&dir).unwrap();
        let agent = addon("agent", "researcher", "Researcher", "Investigate first.");
        let skill = addon(
            "skill",
            "deep-research",
            "Deep research",
            "Show confidence.",
        );
        write_native_addon_files("claude", &dir, Some(&agent), &[skill]).unwrap();

        let skill_file =
            std::fs::read_to_string(dir.join(".claude/skills/deep-research/SKILL.md")).unwrap();
        assert!(skill_file.starts_with(
            "---\nname: deep-research\ndescription: Deep research description\n---\n\n"
        ));
        assert!(skill_file.ends_with("Show confidence.\n"));
        assert_eq!(
            std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
            "# Role\n\nInvestigate first.\n"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn native_codex_file_includes_role_and_skills() {
        let dir = addon_temp_dir("codex");
        std::fs::create_dir_all(&dir).unwrap();
        let agent = addon("agent", "writer", "Writer", "Write precisely.");
        let skill = addon("skill", "citations", "Citations", "Cite sources.");
        write_native_addon_files("codex", &dir, Some(&agent), &[skill]).unwrap();

        let content = std::fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(content.contains("# Role\n\nWrite precisely."));
        assert!(content.contains("# Skills\n\n## Citations\n\nCite sources."));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn native_local_engine_writes_nothing() {
        let dir = addon_temp_dir("local");
        std::fs::create_dir_all(&dir).unwrap();
        let skill = addon("skill", "citations", "Citations", "Cite sources.");
        write_native_addon_files("local", &dir, None, &[skill]).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn context_receipt_handles_zero_one_and_many_sources() {
        let sources_off = crate::types::ContextSources::default();
        assert_eq!(
            context_receipt(&[], &[], &[], &sources_off, &[], &[], None, &[], false),
            "Context: 0 bound meetings · 0 related via graph (none) · 0 folders"
        );

        let bound = meeting(String::new());
        let mut related_one_meeting = meeting(String::new());
        related_one_meeting.title = "Pricing follow-up".to_string();
        let related_one = (related_one_meeting, "[text match]".to_string());
        assert_eq!(
            context_receipt(
                std::slice::from_ref(&bound),
                std::slice::from_ref(&related_one),
                &["/tmp/reference".to_string()],
                &sources_off,
                &[],
                &[],
                None,
                &[],
                true,
            ),
            "Context: 1 bound meeting · 1 related via graph (Pricing follow-up [text match]) · 1 folder, folder excerpts inlined"
        );

        let mut related_two_meeting = meeting(String::new());
        related_two_meeting.title = "Launch retrospective".to_string();
        let related_two = (related_two_meeting, "[0.71]".to_string());
        assert_eq!(
            context_receipt(
                &[bound.clone(), bound],
                &[related_one, related_two],
                &["/tmp/one".to_string(), "/tmp/two".to_string()],
                &sources_off,
                &[],
                &[],
                None,
                &[],
                false,
            ),
            "Context: 2 bound meetings · 2 related via graph (Pricing follow-up [text match], Launch retrospective [0.71]) · 2 folders"
        );

        let agent = addon("agent", "researcher", "Researcher", "Investigate.");
        let skills = vec![
            addon("skill", "citations", "Citations", "Cite."),
            addon("skill", "brief", "Brief", "Be brief."),
        ];
        assert_eq!(
            context_receipt(
                &[],
                &[],
                &[],
                &sources_off,
                &[],
                &[],
                Some(&agent),
                &skills,
                false,
            ),
            "Context: 0 bound meetings · 0 related via graph (none) · 0 folders · agent: Researcher · skills: Citations, Brief"
        );

        let sources_on = crate::types::ContextSources {
            vault_path: "/vault".to_string(),
            projects_root: "/projects".to_string(),
        };
        let vault_hits = vec![ContextHit {
            source: "vault".to_string(),
            path: "/vault/miq.md".to_string(),
            title: "MIQ".to_string(),
            signal: "[text match]".to_string(),
            excerpt: String::new(),
        }];
        assert_eq!(
            context_receipt(
                &[],
                &[],
                &[],
                &sources_on,
                &vault_hits,
                &[],
                None,
                &[],
                false,
            ),
            "Context: 0 bound meetings · 0 related via graph (none) · 0 folders · vault: 1 (MIQ [text match]) · projects: 0 (none)"
        );
    }

    #[test]
    fn related_meetings_keep_hit_order_labels_and_limit() {
        let mut first = meeting(String::new());
        first.id = 1;
        first.title = "First".to_string();
        let mut second = meeting(String::new());
        second.id = 2;
        second.title = "Second".to_string();
        let mut third = meeting(String::new());
        third.id = 3;
        third.title = "Third".to_string();

        let hits = [
            RelatedHit {
                meeting_id: 3,
                signal: RelatedSignal::Semantic(0.714),
            },
            RelatedHit {
                meeting_id: 1,
                signal: RelatedSignal::TextMatch,
            },
            RelatedHit {
                meeting_id: 2,
                signal: RelatedSignal::TextMatch,
            },
        ];
        let selected = select_related_meetings(&hits, &[first, second, third], 1);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].0.id, 3);
        assert_eq!(selected[0].1, "[0.71]");
    }

    #[test]
    fn related_meetings_skip_archived_empty_and_unknown_ranked_ids() {
        let mut archived = meeting(String::new());
        archived.id = 4;
        archived.archived = true;
        let mut empty = meeting(String::new());
        empty.id = 5;
        empty.summary = "   ".to_string();
        let mut usable = meeting(String::new());
        usable.id = 6;

        let hits = [4, 99, 5, 6].map(|meeting_id| RelatedHit {
            meeting_id,
            signal: RelatedSignal::TextMatch,
        });
        let selected = select_related_meetings(&hits, &[archived, empty, usable], 3);
        assert_eq!(
            selected
                .iter()
                .map(|(meeting, _)| meeting.id)
                .collect::<Vec<_>>(),
            vec![6]
        );
    }

    #[test]
    fn engine_detection_reports_all_engines_and_local_service_failure() {
        let engines = detect_engines(false);
        assert_eq!(engines.len(), 3);
        let local = engines.iter().find(|engine| engine.id == "local").unwrap();
        assert_eq!(local.label, "Local model");
        assert!(!local.available);
        assert_eq!(
            local.detail,
            "The local AI service isn't running. Check Settings → Setup status."
        );
        assert_eq!(
            engines
                .iter()
                .find(|engine| engine.id == "claude")
                .unwrap()
                .label,
            "Claude Code"
        );
        assert_eq!(
            engines
                .iter()
                .find(|engine| engine.id == "codex")
                .unwrap()
                .label,
            "Codex"
        );
    }
}
