//! Workspace execution helpers shared by the Tauri command layer.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

    brief
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
        );
        assert!(!brief.contains("# Agent"));
        assert!(!brief.contains("# Skills"));
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
            context_receipt(&[], &[], &[], &sources_off, &[], &[], None, &[]),
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
                &[]
            ),
            "Context: 1 bound meeting · 1 related via graph (Pricing follow-up [text match]) · 1 folder"
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
                &[]
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
                &skills
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
                &[]
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
