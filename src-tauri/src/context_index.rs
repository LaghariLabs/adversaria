//! Automatic workspace context from an Obsidian vault and local project root.
//!
//! Documents remain useful through SQLite FTS even when the local embedding
//! service is unavailable. Semantic chunks are an optional, retryable layer.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use tauri::{AppHandle, Manager};

use crate::types::{ContextChunkRow, ContextIndexStatus, ContextSources};

const VAULT_CHUNK_CHARS: usize = 1500;
const MAX_VAULT_FILE_BYTES: u64 = 200 * 1024;
const MAX_EXCERPT_CHARS: usize = 1200;
const OWNED_MEETING_MARKER: &str = "resource: adversaria://meeting/";

#[derive(Debug, Clone, PartialEq)]
pub struct RawDoc {
    pub path: String,
    pub name: String,
    pub title: String,
    pub body: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextHit {
    pub source: String,
    pub path: String,
    pub title: String,
    /// `[text match]` for FTS or a two-decimal cosine label such as `[0.71]`.
    pub signal: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextMatch {
    pub doc_id: i64,
    pub signal: String,
    pub excerpt: String,
}

#[derive(Default)]
struct CollectedDocs {
    docs: Vec<RawDoc>,
    skipped: usize,
}

static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);
static LAST_STATUS: OnceLock<Mutex<ContextIndexStatus>> = OnceLock::new();

struct SyncGuard;

impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_RUNNING.store(false, Ordering::SeqCst);
    }
}

fn status_cell() -> &'static Mutex<ContextIndexStatus> {
    LAST_STATUS.get_or_init(|| Mutex::new(ContextIndexStatus::default()))
}

fn configured_sources() -> ContextSources {
    let config = crate::config::load_config();
    ContextSources {
        vault_path: config.context_vault_path.trim().to_string(),
        projects_root: config.context_projects_root.trim().to_string(),
    }
}

fn modified_unix(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_secs())
}

fn is_skipped_vault_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                ".obsidian" | ".git" | "node_modules" | "graphify-out" | "cache"
            )
        })
}

fn first_markdown_heading(body: &str) -> Option<String> {
    body.lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|heading| !heading.is_empty())
        .map(str::to_string)
}

fn collect_vault_docs_inner(root: &Path) -> CollectedDocs {
    fn visit(dir: &Path, out: &mut CollectedDocs) {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => {
                out.skipped += 1;
                return;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    out.skipped += 1;
                    continue;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    out.skipped += 1;
                    continue;
                }
            };
            if file_type.is_dir() {
                if !is_skipped_vault_dir(&path) {
                    visit(&path, out);
                }
                continue;
            }
            if !file_type.is_file()
                || !path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
            {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    out.skipped += 1;
                    continue;
                }
            };
            if metadata.len() > MAX_VAULT_FILE_BYTES {
                out.skipped += 1;
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    out.skipped += 1;
                    continue;
                }
            };
            let marker_window = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]);
            if marker_window.contains(OWNED_MEETING_MARKER) {
                continue;
            }
            let body = match String::from_utf8(bytes) {
                Ok(body) => body,
                Err(_) => {
                    out.skipped += 1;
                    continue;
                }
            };
            let stem = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = stem
                .chars()
                .map(|character| match character {
                    '-' | '_' => ' ',
                    other => other,
                })
                .collect();
            let title = first_markdown_heading(&body).unwrap_or(stem);
            out.docs.push(RawDoc {
                path: path.to_string_lossy().into_owned(),
                name,
                title,
                body,
                fingerprint: format!("{}:{}", modified_unix(&metadata), metadata.len()),
            });
        }
    }

    let mut collected = CollectedDocs::default();
    visit(root, &mut collected);
    collected.docs.sort_by(|a, b| a.path.cmp(&b.path));
    collected
}

/// Recursively collect user-authored Markdown notes from an Obsidian vault.
pub fn collect_vault_docs(root: &Path) -> Vec<RawDoc> {
    collect_vault_docs_inner(root).docs
}

fn read_text(path: &Path, skipped: &mut usize) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(_) => {
            *skipped += 1;
            None
        }
    }
}

fn json_string_field(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn cargo_package_fields(contents: &str) -> (Option<String>, Option<String>) {
    let mut in_package = false;
    let mut name = None;
    let mut description = None;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_package = trimmed == "[package]";
            continue;
        }
        if !in_package {
            continue;
        }
        let Some((key, raw_value)) = trimmed.split_once('=') else {
            continue;
        };
        let value = raw_value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "name" if name.is_none() => name = Some(value),
            "description" if description.is_none() => description = Some(value),
            _ => {}
        }
    }
    (name, description)
}

fn collect_project_docs_inner(root: &Path) -> CollectedDocs {
    let mut collected = CollectedDocs::default();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => {
            collected.skipped = 1;
            return collected;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                collected.skipped += 1;
                continue;
            }
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                collected.skipped += 1;
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                collected.skipped += 1;
                continue;
            }
        };

        let mut lines = vec![name.clone()];
        let mut readme_mtime = 0;
        for relative in ["README.md", "CLAUDE.md", "readme.md", "docs/README.md"] {
            let candidate = path.join(relative);
            if !candidate.is_file() {
                continue;
            }
            readme_mtime = candidate
                .metadata()
                .ok()
                .map_or(0, |metadata| modified_unix(&metadata));
            if let Some(contents) = read_text(&candidate, &mut collected.skipped) {
                let excerpt = contents.chars().take(3000).collect::<String>();
                if !excerpt.trim().is_empty() {
                    lines.push(excerpt);
                }
            }
            break;
        }

        let package_json = path.join("package.json");
        if package_json.is_file() {
            if let Some(contents) = read_text(&package_json, &mut collected.skipped) {
                match serde_json::from_str::<serde_json::Value>(&contents) {
                    Ok(value) => {
                        if let Some(value) = json_string_field(&value, "name") {
                            lines.push(format!("package name: {value}"));
                        }
                        if let Some(value) = json_string_field(&value, "description") {
                            lines.push(format!("package description: {value}"));
                        }
                    }
                    Err(_) => collected.skipped += 1,
                }
            }
        }

        let cargo_toml = path.join("Cargo.toml");
        if cargo_toml.is_file() {
            if let Some(contents) = read_text(&cargo_toml, &mut collected.skipped) {
                let (package_name, description) = cargo_package_fields(&contents);
                if let Some(value) = package_name {
                    lines.push(format!("cargo package: {value}"));
                }
                if let Some(value) = description {
                    lines.push(format!("cargo description: {value}"));
                }
            }
        }

        let body = lines.join("\n");
        collected.docs.push(RawDoc {
            path: path.to_string_lossy().into_owned(),
            name: name.clone(),
            title: name,
            fingerprint: format!("{}:{readme_mtime}:{}", modified_unix(&metadata), body.len()),
            body,
        });
    }
    collected.docs.sort_by(|a, b| a.path.cmp(&b.path));
    collected
}

/// Build one compact searchable card for every immediate project directory.
pub fn collect_project_docs(root: &Path) -> Vec<RawDoc> {
    collect_project_docs_inner(root).docs
}

fn flush_paragraph(paragraph: &mut String, paragraphs: &mut Vec<String>) {
    let trimmed = paragraph.trim();
    if !trimmed.is_empty() {
        paragraphs.push(trimmed.to_string());
    }
    paragraph.clear();
}

/// Pack blank-line-separated paragraphs into bounded Unicode-safe passages.
pub fn chunk_text(body: &str, max_chars: usize) -> Vec<String> {
    if max_chars == 0 {
        return Vec::new();
    }
    let mut paragraphs = Vec::new();
    let mut paragraph = String::new();
    for line in body.lines() {
        if line.trim().is_empty() {
            flush_paragraph(&mut paragraph, &mut paragraphs);
        } else if paragraph.is_empty() {
            paragraph.push_str(line);
        } else {
            paragraph.push('\n');
            paragraph.push_str(line);
        }
    }
    flush_paragraph(&mut paragraph, &mut paragraphs);

    let mut chunks = Vec::new();
    let mut current = String::new();
    for paragraph in paragraphs {
        let paragraph_len = paragraph.chars().count();
        if paragraph_len > max_chars {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            let chars = paragraph.chars().collect::<Vec<_>>();
            for piece in chars.chunks(max_chars) {
                chunks.push(piece.iter().collect());
            }
            continue;
        }
        let packed_len = current
            .chars()
            .count()
            .saturating_add(if current.is_empty() { 0 } else { 2 })
            .saturating_add(paragraph_len);
        if packed_len > max_chars && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(&paragraph);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn best_cosine_per_doc(chunks: &[ContextChunkRow], query: &[f32]) -> Vec<(i64, f32, String)> {
    let mut best = HashMap::<i64, (f32, String)>::new();
    for chunk in chunks {
        let score = crate::embeddings::cosine(&chunk.embedding, query);
        best.entry(chunk.doc_id)
            .and_modify(|(current, text)| {
                if current.is_nan() || (!score.is_nan() && score > *current) {
                    *current = score;
                    *text = chunk.text.clone();
                }
            })
            .or_insert_with(|| (score, chunk.text.clone()));
    }
    let mut scored = best
        .into_iter()
        .map(|(doc_id, (score, text))| (doc_id, score, text))
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Less));
    scored
}

/// Merge FTS and semantic candidates with FTS priority and stable de-duplication.
pub fn merge_context_matches(
    fts: &[i64],
    semantic: &[(i64, f32, String)],
    min_cosine: f32,
    limit: usize,
) -> Vec<ContextMatch> {
    if limit == 0 {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    let mut matches = Vec::new();
    for doc_id in fts {
        if seen.insert(*doc_id) {
            matches.push(ContextMatch {
                doc_id: *doc_id,
                signal: "[text match]".to_string(),
                excerpt: String::new(),
            });
            if matches.len() == limit {
                return matches;
            }
        }
    }
    for (doc_id, score, excerpt) in semantic {
        if *score >= min_cosine && seen.insert(*doc_id) {
            matches.push(ContextMatch {
                doc_id: *doc_id,
                signal: format!("[{score:.2}]"),
                excerpt: excerpt.clone(),
            });
            if matches.len() == limit {
                break;
            }
        }
    }
    matches
}

fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn materialize_hits(matches: Vec<ContextMatch>) -> Vec<ContextHit> {
    let ids = matches.iter().map(|item| item.doc_id).collect::<Vec<_>>();
    let docs = crate::storage::get_context_docs(&ids).unwrap_or_default();
    let docs = docs
        .into_iter()
        .map(|doc| (doc.id, doc))
        .collect::<HashMap<_, _>>();
    matches
        .into_iter()
        .filter_map(|item| {
            let doc = docs.get(&item.doc_id)?;
            let excerpt = if item.signal == "[text match]" {
                truncate_chars(&doc.body, MAX_EXCERPT_CHARS)
            } else {
                truncate_chars(&item.excerpt, MAX_EXCERPT_CHARS)
            };
            Some(ContextHit {
                source: doc.source.clone(),
                path: doc.path.clone(),
                title: doc.title.clone(),
                signal: item.signal,
                excerpt,
            })
        })
        .collect()
}

/// Hybrid context retrieval for one workspace task. FTS remains available when
/// the embedding service is down; semantic results use the active model only.
pub async fn search(
    client: &crate::http_client::HttpClient,
    text: &str,
    vault_limit: usize,
    project_limit: usize,
    min_cosine: f32,
) -> Vec<ContextHit> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let sources = configured_sources();
    let vault_enabled = !sources.vault_path.is_empty();
    let projects_enabled = !sources.projects_root.is_empty();
    if !vault_enabled && !projects_enabled {
        return Vec::new();
    }

    let vault_fts = if vault_enabled {
        crate::storage::search_context_doc_ids(text, Some("vault"), 10).unwrap_or_default()
    } else {
        Vec::new()
    };
    let project_fts = if projects_enabled {
        crate::storage::search_context_doc_ids(text, Some("project"), 10).unwrap_or_default()
    } else {
        Vec::new()
    };
    let input = [text.to_string()];
    let semantic =
        match tokio::time::timeout(std::time::Duration::from_secs(8), client.embed(&input)).await {
            Ok(Ok((vectors, model))) if !vectors.is_empty() => best_cosine_per_doc(
                &crate::storage::get_context_chunks_for_model(&model).unwrap_or_default(),
                &vectors[0],
            ),
            Ok(Ok(_)) => Vec::new(),
            Ok(Err(error)) => {
                eprintln!("[retrieval] embed skipped: {error}");
                Vec::new()
            }
            Err(error) => {
                eprintln!("[retrieval] embed skipped: {error}");
                Vec::new()
            }
        };
    let semantic_ids = semantic.iter().map(|(id, _, _)| *id).collect::<Vec<_>>();
    let source_by_id = crate::storage::get_context_docs(&semantic_ids)
        .unwrap_or_default()
        .into_iter()
        .map(|doc| (doc.id, doc.source))
        .collect::<HashMap<_, _>>();

    let mut hits = Vec::new();
    if vault_enabled {
        let candidates = semantic
            .iter()
            .filter(|(id, _, _)| source_by_id.get(id).is_some_and(|source| source == "vault"))
            .cloned()
            .collect::<Vec<_>>();
        hits.extend(materialize_hits(merge_context_matches(
            &vault_fts,
            &candidates,
            min_cosine,
            vault_limit,
        )));
    }
    if projects_enabled {
        let candidates = semantic
            .iter()
            .filter(|(id, _, _)| {
                source_by_id
                    .get(id)
                    .is_some_and(|source| source == "project")
            })
            .cloned()
            .collect::<Vec<_>>();
        hits.extend(materialize_hits(merge_context_matches(
            &project_fts,
            &candidates,
            min_cosine,
            project_limit,
        )));
    }
    hits
}

fn upsert_collected(
    source: &str,
    collected: CollectedDocs,
    changed_docs: &mut HashSet<i64>,
) -> Result<(usize, usize), String> {
    let keep_paths = collected
        .docs
        .iter()
        .map(|doc| doc.path.clone())
        .collect::<Vec<_>>();
    let mut changed = 0;
    for doc in collected.docs {
        let (doc_id, did_change) = crate::storage::upsert_context_doc(
            source,
            &doc.path,
            &doc.name,
            &doc.title,
            &doc.body,
            &doc.fingerprint,
        )
        .map_err(|error| format!("Failed to index {}: {error}", doc.path))?;
        if did_change {
            // Never serve a stale embedding for new file content. An empty
            // replacement also makes a failed embed discoverable next sync.
            crate::storage::replace_context_chunks(doc_id, &[], "")
                .map_err(|error| format!("Failed to clear stale context chunks: {error}"))?;
            changed_docs.insert(doc_id);
            changed += 1;
        }
    }
    let deleted = crate::storage::delete_context_docs_not_in(source, &keep_paths)
        .map_err(|error| format!("Failed to remove stale {source} documents: {error}"))?;
    Ok((changed + deleted, collected.skipped))
}

/// Bring both configured filesystem sources and their semantic chunks up to date.
pub async fn sync(client: &crate::http_client::HttpClient) -> Result<ContextIndexStatus, String> {
    if SYNC_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(get_status());
    }
    let _guard = SyncGuard;
    let sources = configured_sources();
    let mut changed_docs = HashSet::new();
    let mut changed = 0usize;
    let mut skipped = 0usize;

    let vault = if sources.vault_path.is_empty() {
        CollectedDocs::default()
    } else {
        collect_vault_docs_inner(Path::new(&sources.vault_path))
    };
    let (vault_changed, vault_skipped) = upsert_collected("vault", vault, &mut changed_docs)?;
    changed += vault_changed;
    skipped += vault_skipped;

    let projects = if sources.projects_root.is_empty() {
        CollectedDocs::default()
    } else {
        collect_project_docs_inner(Path::new(&sources.projects_root))
    };
    let (project_changed, project_skipped) =
        upsert_collected("project", projects, &mut changed_docs)?;
    changed += project_changed;
    skipped += project_skipped;

    let (vault_docs, project_docs) =
        crate::storage::context_index_counts().map_err(|error| error.to_string())?;
    let mut embedding_errors = 0usize;
    if vault_docs + project_docs > 0 {
        match client.embed(&["probe".to_string()]).await {
            Ok((_, model)) => {
                let needs_model = crate::storage::context_doc_ids_needing_model(&model)
                    .map_err(|error| error.to_string())?;
                let docs = crate::storage::get_context_docs(&needs_model)
                    .map_err(|error| error.to_string())?;
                for doc in docs {
                    let max_chars = if doc.source == "project" {
                        usize::MAX
                    } else {
                        VAULT_CHUNK_CHARS
                    };
                    let chunks = chunk_text(&doc.body, max_chars);
                    if chunks.is_empty() {
                        crate::storage::replace_context_chunks(doc.id, &[], &model)
                            .map_err(|error| error.to_string())?;
                        if !changed_docs.contains(&doc.id) {
                            changed += 1;
                        }
                        continue;
                    }
                    let mut vectors = Vec::with_capacity(chunks.len());
                    let mut failed = false;
                    for batch in chunks.chunks(64) {
                        match client.embed(batch).await {
                            Ok((batch_vectors, _)) => vectors.extend(batch_vectors),
                            Err(_) => {
                                embedding_errors += 1;
                                failed = true;
                                break;
                            }
                        }
                    }
                    if failed {
                        continue;
                    }
                    if vectors.len() != chunks.len() {
                        embedding_errors += 1;
                        continue;
                    }
                    let rows = chunks.into_iter().zip(vectors).collect::<Vec<_>>();
                    crate::storage::replace_context_chunks(doc.id, &rows, &model)
                        .map_err(|error| error.to_string())?;
                    if !changed_docs.contains(&doc.id) {
                        changed += 1;
                    }
                }
            }
            Err(_) => embedding_errors = changed_docs.len().max(1),
        }
    }

    if skipped > 0 {
        eprintln!("[context-index] skipped {skipped} unreadable or oversized item(s)");
    }
    let status = ContextIndexStatus {
        vault_docs,
        project_docs,
        changed: changed as i64,
        embedding_errors: embedding_errors as i64,
        last_synced_at: chrono::Utc::now().to_rfc3339(),
    };
    *status_cell()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = status.clone();
    Ok(status)
}

/// Current counts plus the most recent completed sync metadata.
pub fn get_status() -> ContextIndexStatus {
    let mut status = status_cell()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    if let Ok((vault_docs, project_docs)) = crate::storage::context_index_counts() {
        status.vault_docs = vault_docs;
        status.project_docs = project_docs;
    }
    status
}

/// Start the delayed startup sync and half-hour refresh loop.
pub fn spawn_periodic(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(40)).await;
        loop {
            let base_url = app
                .state::<crate::commands::AppState>()
                .client
                .current_base_url();
            let client = crate::http_client::HttpClient::new(base_url);
            match sync(&client).await {
                Ok(status) if status.changed > 0 => eprintln!(
                    "[context-index] vault {} · projects {} (+{} updated)",
                    status.vault_docs, status.project_docs, status.changed
                ),
                Ok(_) => {}
                Err(error) => eprintln!("[context-index] sync skipped: {error}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(30 * 60)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::SystemTime;

    fn temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "adversaria-context-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn vault_collection_skips_internal_and_exported_notes_and_uses_titles() {
        let root = temp_dir("vault");
        std::fs::create_dir_all(root.join("wiki/projects")).unwrap();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::write(
            root.join("wiki/projects/MIQ-Agentic.md"),
            "# M|Q Agentic Intelligence\n\nProject decisions",
        )
        .unwrap();
        std::fs::write(root.join("stem-title.md"), "No heading here").unwrap();
        std::fs::write(root.join(".obsidian/private.md"), "# Internal").unwrap();
        std::fs::write(
            root.join("meeting-export.md"),
            "---\nresource: adversaria://meeting/7\n---\n# Export",
        )
        .unwrap();

        let docs = collect_vault_docs(&root);

        assert_eq!(docs.len(), 2);
        assert!(docs
            .iter()
            .any(|doc| doc.title == "M|Q Agentic Intelligence" && doc.name == "MIQ Agentic"));
        assert!(docs.iter().any(|doc| doc.title == "stem-title"));
        assert!(!docs.iter().any(|doc| doc.path.contains(".obsidian")));
        assert!(!docs.iter().any(|doc| doc.title == "Export"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_collection_combines_readme_and_package_metadata() {
        let root = temp_dir("projects");
        let project = root.join("lagharilabs-website");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("README.md"), "# Laghari Labs\nPortfolio site").unwrap();
        std::fs::write(
            project.join("package.json"),
            r#"{"name":"@laghari/site","description":"Founder website"}"#,
        )
        .unwrap();

        let docs = collect_project_docs(&root);

        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].title, "lagharilabs-website");
        assert_eq!(docs[0].name, "lagharilabs-website");
        assert!(docs[0].body.contains("Portfolio site"));
        assert!(docs[0].body.contains("package name: @laghari/site"));
        assert!(docs[0]
            .body
            .contains("package description: Founder website"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn chunk_text_packs_paragraphs_and_hard_splits_oversized_ones() {
        assert_eq!(
            chunk_text("one\n\ntwo\n\nthree", 8),
            vec!["one\n\ntwo".to_string(), "three".to_string()]
        );
        assert_eq!(
            chunk_text("abcdefghij", 4),
            vec!["abcd".to_string(), "efgh".to_string(), "ij".to_string()]
        );
        assert!(chunk_text(" \n\n", 10).is_empty());
    }

    #[test]
    fn search_merge_prioritizes_fts_deduplicates_and_applies_floor() {
        let matches = merge_context_matches(
            &[2, 1],
            &[
                (2, 0.99, "duplicate".to_string()),
                (3, 0.71, "semantic".to_string()),
                (4, 0.40, "below floor".to_string()),
            ],
            0.55,
            3,
        );
        assert_eq!(
            matches,
            vec![
                ContextMatch {
                    doc_id: 2,
                    signal: "[text match]".to_string(),
                    excerpt: String::new(),
                },
                ContextMatch {
                    doc_id: 1,
                    signal: "[text match]".to_string(),
                    excerpt: String::new(),
                },
                ContextMatch {
                    doc_id: 3,
                    signal: "[0.71]".to_string(),
                    excerpt: "semantic".to_string(),
                },
            ]
        );
    }
}
