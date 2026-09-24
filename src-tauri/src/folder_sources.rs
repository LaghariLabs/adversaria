//! Explicit folder evidence: bounded local indexing and a cached profile of Me.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::http_client::HttpClient;
use crate::storage;

const MAX_FILE_BYTES: usize = 200 * 1024;
const MAX_FILES: usize = 200;
const MAX_DEPTH: usize = 3;
const MAX_PROFILE_INPUT_CHARS: usize = 40_000;
const SEPARATOR: &str = "\n\n---\n\n";

pub const PROFILE_PROMPT: &str = "These documents describe one person, labelled Me. Write a profile of Me in at most 900 characters of plain sentences, no bullets, no headings, no praise: first Me's current role and employer, then each project Me built with one sentence each naming what it does, the stack, and one number if the documents state one, then the tools and skills Me actually used. Use only facts present in the documents. If something is not stated, leave it out.";

fn supported_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt"))
}

pub fn validate_source(path: &str, kind: &str) -> Result<(), String> {
    if !matches!(kind, "file" | "dir") {
        return Err("Invalid source kind".to_string());
    }
    let path = Path::new(path);
    if !path.exists() {
        return Err("Path does not exist".to_string());
    }
    match kind {
        "file" if !supported_file(path) => {
            Err("Only .md and .txt files can be added in this version".to_string())
        }
        "file" if !path.is_file() => Err("Path is not a file".to_string()),
        "dir" if !path.is_dir() => Err("Path is not a directory".to_string()),
        _ => Ok(()),
    }
}

/// Literal path matching, shared by FTS, semantic retrieval and the profile.
pub(crate) fn path_in_sources(path: &str, sources: &[(String, String)]) -> bool {
    sources.iter().any(|(source, kind)| match kind.as_str() {
        "file" => path == source,
        "dir" => path.starts_with(&format!("{}/", source.trim_end_matches('/'))),
        _ => false,
    })
}

fn walk_source(dir: &Path, depth: usize, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    if depth >= MAX_DEPTH || files.len() >= MAX_FILES {
        return Ok(());
    }
    let mut entries = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if files.len() >= MAX_FILES {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.')
            || matches!(name.as_ref(), "node_modules" | "target" | "dist" | "build")
        {
            continue;
        }
        // Do not follow links out of an approved directory or into cycles.
        let kind = entry.file_type()?;
        if kind.is_dir() {
            walk_source(&entry.path(), depth + 1, files)?;
        } else if kind.is_file() && supported_file(&entry.path()) {
            files.push(entry.path());
        }
    }
    Ok(())
}

pub fn sync_folder_sources(folder_id: i64) -> anyhow::Result<usize> {
    let conn = storage::connect_for_sync()?;
    sync_folder_sources_on(&conn, folder_id)
}

fn sync_folder_sources_on(conn: &Connection, folder_id: i64) -> anyhow::Result<usize> {
    // Source removal cannot interleave with inserting its indexed documents.
    let tx = conn.unchecked_transaction()?;
    let sources = storage::list_folder_sources_on(&tx, folder_id)?;
    let fingerprints: HashMap<_, _> = storage::folder_doc_paths_on(&tx, folder_id)?
        .into_iter()
        .collect();
    let mut indexed = HashSet::new();
    let mut canonical_indexed = HashSet::new();
    let now = chrono::Utc::now().to_rfc3339();
    for source in sources {
        let path = Path::new(&source.path);
        let mut files = Vec::new();
        if source.kind == "file" && path.is_file() && supported_file(path) {
            files.push(path.to_path_buf());
        } else if source.kind == "dir" && path.is_dir() {
            walk_source(path, 0, &mut files)?;
        }
        for file in files {
            let path = file.to_string_lossy().into_owned();
            if !canonical_indexed.insert(crate::copilot_provenance::canonical_path(&path)) {
                continue;
            }
            let metadata = fs::metadata(&file)?;
            let fingerprint = format!(
                "{}-{}",
                metadata.len(),
                metadata.modified()?.duration_since(UNIX_EPOCH)?.as_secs()
            );
            if fingerprints.get(&path) != Some(&fingerprint) {
                let mut bytes = Vec::new();
                fs::File::open(&file)?
                    .take(MAX_FILE_BYTES as u64)
                    .read_to_end(&mut bytes)?;
                let body = crate::copilot_provenance::truncate_utf8_bytes(
                    &String::from_utf8_lossy(&bytes),
                    MAX_FILE_BYTES,
                );
                let title = body
                    .lines()
                    .find_map(|line| line.strip_prefix("# ").map(str::trim))
                    .filter(|title| !title.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        file.file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned()
                    });
                storage::upsert_folder_doc_on(
                    &tx,
                    folder_id,
                    &path,
                    &title,
                    &body,
                    &fingerprint,
                    &now,
                )?;
            }
            indexed.insert(path);
        }
    }
    for path in fingerprints.keys().filter(|path| !indexed.contains(*path)) {
        storage::delete_folder_doc_on(&tx, folder_id, path)?;
    }
    let mut terms: HashSet<String> = "rag fts moe asr vad rrf mlx ipc tcc mcp ct2 llm"
        .split_whitespace()
        .map(str::to_string)
        .collect();
    {
        let mut stmt = tx.prepare("SELECT title FROM folder_docs WHERE folder_id = ?1")?;
        for title in stmt.query_map([folder_id], |row| row.get::<_, String>(0))? {
            for token in title?.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
                if (2..=3).contains(&token.chars().count())
                    && crate::copilot::is_specific_word(token)
                {
                    terms.insert(token.to_string());
                }
            }
        }
    }
    storage::set_folder_terms_on(&tx, folder_id, &terms.into_iter().collect::<Vec<_>>())?;
    tx.commit()?;
    Ok(indexed.len())
}

#[derive(Debug, PartialEq)]
pub struct Pack {
    pub text: String,
    pub hash: String,
    pub projects: u32,
    pub omitted: u32,
}

pub fn build_pack(conn: &Connection, folder_id: i64) -> anyhow::Result<Pack> {
    let folder = storage::get_folder_on(conn, folder_id)?
        .ok_or_else(|| anyhow::anyhow!("Folder not found"))?;
    let sources = storage::folder_source_paths_on(conn, folder_id)?;
    let mut text = if folder.profile.trim().is_empty() {
        String::new()
    } else {
        format!("About Me: {}", folder.profile.trim())
    };
    anyhow::ensure!(
        text.len() <= 6_000,
        "Folder profile exceeds standing pack budget"
    );
    let mut stmt = conn.prepare("SELECT path, title, body FROM folder_docs WHERE folder_id = ?1 ORDER BY path COLLATE BINARY")?;
    let docs = stmt.query_map([folder_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(2)?))
    })?;
    let mut seen = HashSet::new();
    let mut projects = 0;
    let mut omitted = 0;
    let mut full = false;
    for doc in docs {
        let (path, body) = doc?;
        let file = Path::new(&path);
        let Some(name) = file.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let suffix = "-overview.md";
        if !name.to_ascii_lowercase().ends_with(suffix) {
            continue;
        }
        let project = &name[..name.len() - suffix.len()];
        if project.is_empty() {
            continue;
        }
        let belongs = sources.iter().any(|(root, kind)| {
            if kind == "file" {
                return path == *root;
            }
            let Ok(relative) = file.strip_prefix(root) else {
                return false;
            };
            let components: Vec<_> = relative.components().collect();
            components.len() == 1
                || (components.len() == 2
                    && components[0]
                        .as_os_str()
                        .to_str()
                        .is_some_and(|dir| dir.eq_ignore_ascii_case(project)))
        });
        if !belongs || !seen.insert(crate::copilot_provenance::canonical_path(&path)) {
            continue;
        }
        let normalized = body.replace("\r\n", "\n");
        let mut lines = normalized
            .trim_start_matches('\u{feff}')
            .lines()
            .skip_while(|line| line.trim().is_empty())
            .peekable();
        if lines.peek().is_some_and(|line| line.starts_with("# ")) {
            lines.next();
        }
        let paragraph = lines
            .skip_while(|line| line.trim().is_empty())
            .take_while(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if paragraph.is_empty() {
            continue;
        }
        let entry = format!("Project {project}: {paragraph}");
        let separator = if text.is_empty() { "" } else { "\n\n" };
        if full || text.len() + separator.len() + entry.len() > 6_000 {
            full = true;
            omitted += 1;
            continue;
        }
        text.push_str(separator);
        text.push_str(&entry);
        projects += 1;
    }
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    Ok(Pack {
        text,
        hash,
        projects,
        omitted,
    })
}

struct ProfileInput {
    text: String,
    hash: String,
    cached: Option<String>,
}

fn profile_input_on(conn: &Connection, folder_id: i64) -> anyhow::Result<ProfileInput> {
    let folder = storage::get_folder_on(conn, folder_id)?
        .ok_or_else(|| anyhow::anyhow!("Folder not found"))?;
    let sources = storage::folder_source_paths_on(conn, folder_id)?;
    let mut text = String::new();
    let mut count = 0;
    let mut append = |body: &str| {
        if body.trim().is_empty() {
            return true;
        }
        let separator = if count == 0 { "" } else { SEPARATOR };
        let length = separator.chars().count() + body.chars().count();
        if count + length > MAX_PROFILE_INPUT_CHARS {
            return false;
        }
        text.push_str(separator);
        text.push_str(body);
        count += length;
        true
    };
    let mut room = append(&folder.purpose) && append(&folder.instructions);
    let mut stmt =
        conn.prepare("SELECT path, title, body FROM folder_docs WHERE folder_id = ?1")?;
    let mut docs = stmt
        .query_map([folder_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    docs.sort_by_cached_key(|(path, title, _)| {
        let title = title.to_lowercase();
        let file_name = Path::new(path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let priority = ["cv", "resume", "résumé", "profile", "pitch"]
            .iter()
            .any(|term| title.contains(term) || file_name.contains(term));
        (!priority, path.clone())
    });
    for (_, _, body) in docs {
        if !room {
            break;
        }
        room = append(&body);
    }
    if room && !sources.is_empty() {
        let mut stmt = conn.prepare("SELECT path, body FROM context_docs ORDER BY id")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (path, body) = row?;
            if path_in_sources(&path, &sources) && !append(&body) {
                break;
            }
        }
    }
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let cached = (!text.is_empty() && hash == folder.profile_hash && !folder.profile.is_empty())
        .then_some(folder.profile);
    Ok(ProfileInput { text, hash, cached })
}

fn trim_profile(reply: &str) -> String {
    let reply = reply.trim();
    if reply.chars().count() <= 1_200 {
        return reply.to_string();
    }
    let prefix: String = reply.chars().take(1_200).collect();
    // Include the next character so punctuation at the cutoff is only treated
    // as a boundary if it is actually followed by whitespace in the reply.
    let boundary_input: String = reply.chars().take(1_201).collect();
    let (sentences, _) = crate::copilot_provenance::split_sentences(&boundary_input);
    let mut result = String::new();
    for sentence in sentences {
        let separator = if result.is_empty() { "" } else { " " };
        if result.chars().count() + separator.len() + sentence.chars().count() > 1_200 {
            break;
        }
        result.push_str(separator);
        result.push_str(&sentence);
    }
    if result.is_empty() {
        prefix.trim().to_string()
    } else {
        result
    }
}

async fn profile_reply(client: &HttpClient, input: &ProfileInput) -> Result<String, String> {
    if let Some(cached) = &input.cached {
        return Ok(cached.clone());
    }
    if input.text.is_empty() {
        return Ok(String::new());
    }
    let (model, base_url, api_key) = crate::copilot_session::copilot_local_provider()
        .map_err(|e| format!("Could not read the profile model: {e}"))?;
    let reply = client
        .chat(
            &input.text,
            PROFILE_PROMPT,
            model.as_deref(),
            base_url.as_deref(),
            api_key.as_deref(),
        )
        .await
        .map_err(|e| format!("Could not read the profile model: {e}"))?;
    Ok(trim_profile(&reply))
}

pub async fn refresh_folder_profile(client: &HttpClient, folder_id: i64) -> Result<String, String> {
    let input = tokio::task::spawn_blocking(move || {
        let conn = storage::connect_for_sync()?;
        profile_input_on(&conn, folder_id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let profile = profile_reply(client, &input).await?;
    if input.cached.is_some() {
        return Ok(profile);
    }
    let saved = profile.clone();
    tokio::task::spawn_blocking(move || {
        storage::set_folder_profile(
            folder_id,
            &saved,
            &input.hash,
            &chrono::Utc::now().to_rfc3339(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("copilot-sources-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
        fn source(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn validates_types_paths_and_case_insensitive_extensions() {
        let temp = TempDir::new();
        fs::write(temp.path("bad.pdf"), "pdf").unwrap();
        fs::write(temp.path("good.MARKDOWN"), "text").unwrap();
        assert_eq!(
            validate_source(temp.path("bad.pdf").to_str().unwrap(), "file").unwrap_err(),
            "Only .md and .txt files can be added in this version"
        );
        assert_eq!(
            validate_source(temp.path("missing.md").to_str().unwrap(), "file").unwrap_err(),
            "Path does not exist"
        );
        assert!(validate_source(temp.path("good.MARKDOWN").to_str().unwrap(), "file").is_ok());
        assert!(validate_source(&temp.source(), "dir").is_ok());
        assert!(validate_source(temp.path("good.MARKDOWN").to_str().unwrap(), "dir").is_err());
        assert_eq!(
            validate_source(&temp.source(), "bogus").unwrap_err(),
            "Invalid source kind"
        );
    }

    #[test]
    fn sync_is_bounded_incremental_and_removes_vanished_documents() {
        let temp = TempDir::new();
        fs::write(
            temp.path("first.md"),
            "before\n# First project\nhermetic deployment",
        )
        .unwrap();
        fs::write(temp.path("second.MD"), "plain text").unwrap();
        fs::write(temp.path("skip.pdf"), "hidden").unwrap();
        for dir in [
            "node_modules",
            "target",
            ".venv",
            "dist",
            "build",
            ".hidden",
        ] {
            fs::create_dir_all(temp.path(dir)).unwrap();
            fs::write(temp.path(dir).join("skip.md"), "hidden").unwrap();
        }
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Me", "blue").unwrap().id;
        storage::insert_folder_source_on(&conn, id, &temp.source(), "dir", "now").unwrap();
        assert_eq!(sync_folder_sources_on(&conn, id).unwrap(), 2);
        let docs = storage::get_folder_docs_on(
            &conn,
            &storage::search_folder_doc_ids_on(&conn, id, "hermetic", 10).unwrap(),
        )
        .unwrap();
        assert_eq!(docs[0].2, "First project");
        conn.execute("UPDATE folder_docs SET updated_at = 'sentinel'", [])
            .unwrap();
        assert_eq!(sync_folder_sources_on(&conn, id).unwrap(), 2);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM folder_docs WHERE updated_at = 'sentinel'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        fs::write(
            temp.path("first.md"),
            "# Changed project\nchanged body with a different size",
        )
        .unwrap();
        sync_folder_sources_on(&conn, id).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM folder_docs WHERE updated_at != 'sentinel'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        fs::remove_file(temp.path("second.MD")).unwrap();
        assert_eq!(sync_folder_sources_on(&conn, id).unwrap(), 1);
        assert_eq!(storage::folder_doc_paths_on(&conn, id).unwrap().len(), 1);
    }

    #[test]
    fn directory_depth_file_count_and_utf8_body_limits() {
        let temp = TempDir::new();
        fs::create_dir_all(temp.path("one/two/three")).unwrap();
        fs::write(temp.path("one/two/visible.txt"), "visible").unwrap();
        fs::write(temp.path("one/two/three/hidden.md"), "too deep").unwrap();
        fs::write(temp.path("large.md"), "界".repeat(MAX_FILE_BYTES)).unwrap();
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Me", "blue").unwrap().id;
        storage::insert_folder_source_on(&conn, id, &temp.source(), "dir", "now").unwrap();
        assert_eq!(sync_folder_sources_on(&conn, id).unwrap(), 2);
        let body: String = conn
            .query_row(
                "SELECT body FROM folder_docs WHERE title = 'large'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(body.len() <= MAX_FILE_BYTES);
        assert!(body.is_char_boundary(body.len()));
        for i in 0..210 {
            fs::write(temp.path(&format!("doc{i:03}.md")), "doc").unwrap();
        }
        assert_eq!(sync_folder_sources_on(&conn, id).unwrap(), MAX_FILES);
    }

    #[tokio::test]
    async fn matching_profile_hash_returns_cache_without_model_configuration_or_transport() {
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Me", "blue").unwrap().id;
        storage::set_folder_copilot_fields_on(&conn, id, "Interview", "", "").unwrap();
        let input = profile_input_on(&conn, id).unwrap();
        storage::set_folder_profile_on(&conn, id, "Me builds systems.", &input.hash, "now")
            .unwrap();
        let input = profile_input_on(&conn, id).unwrap();
        assert_eq!(
            profile_reply(&HttpClient::new("http://127.0.0.1:1"), &input)
                .await
                .unwrap(),
            "Me builds systems."
        );
        assert_eq!(
            storage::get_folder_on(&conn, id)
                .unwrap()
                .unwrap()
                .profile_at,
            "now"
        );
    }

    #[test]
    fn profile_input_is_ordered_scoped_and_drops_later_sources_whole() {
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Me", "blue").unwrap().id;
        storage::set_folder_copilot_fields_on(&conn, id, "Purpose", "", "").unwrap();
        conn.execute(
            "UPDATE folders SET instructions = 'Instructions' WHERE id = ?1",
            [id],
        )
        .unwrap();
        storage::insert_folder_source_on(&conn, id, "/approved", "dir", "now").unwrap();
        storage::upsert_folder_doc_on(&conn, id, "/approved/a.md", "A", "First doc", "1", "now")
            .unwrap();
        storage::upsert_context_doc_on(&conn, "vault", "/outside/b.md", "B", "B", "Unrelated", "1")
            .unwrap();
        storage::upsert_context_doc_on(
            &conn,
            "vault",
            "/approved/c.md",
            "C",
            "C",
            "Context doc",
            "1",
        )
        .unwrap();
        let input = profile_input_on(&conn, id).unwrap();
        assert_eq!(
            input.text,
            ["Purpose", "Instructions", "First doc", "Context doc"].join(SEPARATOR)
        );
        assert_eq!(
            input.hash,
            format!("{:x}", Sha256::digest(input.text.as_bytes()))
        );
        storage::upsert_folder_doc_on(
            &conn,
            id,
            "/approved/big.md",
            "Big",
            &"界".repeat(MAX_PROFILE_INPUT_CHARS),
            "1",
            "now",
        )
        .unwrap();
        assert_eq!(
            profile_input_on(&conn, id).unwrap().text,
            ["Purpose", "Instructions", "First doc"].join(SEPARATOR)
        );
    }

    #[tokio::test]
    async fn empty_profile_input_ignores_a_stale_profile() {
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Me", "blue").unwrap().id;
        storage::set_folder_profile_on(&conn, id, "Stale", "hash", "now").unwrap();
        let input = profile_input_on(&conn, id).unwrap();
        assert_eq!(
            profile_reply(&HttpClient::new("http://127.0.0.1:1"), &input)
                .await
                .unwrap(),
            ""
        );
        assert_eq!(
            profile_input_on(&conn, 999).err().unwrap().to_string(),
            "Folder not found"
        );
    }

    #[test]
    fn profile_input_prioritizes_cv_inserted_last_then_sorts_other_docs_by_path() {
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Me", "blue").unwrap().id;
        for (path, title, body) in [
            ("/sources/b.md", "Interview B", "Second interview"),
            ("/sources/a.md", "Interview A", "First interview"),
            ("/sources/z-CV.md", "Work history", "Current role from CV"),
        ] {
            storage::upsert_folder_doc_on(&conn, id, path, title, body, "1", "now").unwrap();
        }
        assert_eq!(
            profile_input_on(&conn, id).unwrap().text,
            [
                "Current role from CV",
                "First interview",
                "Second interview"
            ]
            .join(SEPARATOR)
        );
    }

    #[test]
    fn profile_input_prioritizes_each_term_in_title_or_filename_but_not_directory() {
        for term in ["CV", "RESUME", "RÉSUMÉ", "PROFILE", "PITCH"] {
            for in_title in [true, false] {
                let conn = storage::in_memory_db();
                let id = storage::create_folder_on(&conn, "Me", "blue").unwrap().id;
                let path = if in_title {
                    "/sources/y.md".to_string()
                } else {
                    format!("/sources/y-{term}.md")
                };
                let title = if in_title { term } else { "Work history" };
                for (path, title, body) in [
                    ("/CV/a.md", "Interview", "Ordinary doc"),
                    ("/sources/z.md", "Profile of Me", "Later priority doc"),
                    (path.as_str(), title, "Earlier priority doc"),
                ] {
                    storage::upsert_folder_doc_on(&conn, id, path, title, body, "1", "now")
                        .unwrap();
                }
                assert_eq!(
                    profile_input_on(&conn, id).unwrap().text,
                    ["Earlier priority doc", "Later priority doc", "Ordinary doc"].join(SEPARATOR),
                    "{term}, in_title={in_title}"
                );
            }
        }
    }

    #[test]
    fn profile_input_accepts_40000_unicode_characters_and_drops_overflow_whole() {
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Me", "blue").unwrap().id;
        let cv = "界".repeat(30_000);
        let notes = "語".repeat(10_000 - SEPARATOR.chars().count());
        for (path, body) in [
            ("/sources/CV.md", cv.as_str()),
            ("/sources/a.md", notes.as_str()),
            ("/sources/b.md", "Overflow"),
        ] {
            storage::upsert_folder_doc_on(&conn, id, path, "Doc", body, "1", "now").unwrap();
        }
        let input = profile_input_on(&conn, id).unwrap();
        assert_eq!(input.text.chars().count(), 40_000);
        assert_eq!(input.text, [cv, notes].join(SEPARATOR));
    }

    #[test]
    fn manual_profile_is_preserved_by_field_changes_and_uncached_for_refresh() {
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Me", "blue").unwrap().id;
        storage::set_folder_profile_manual_on(&conn, id, "My corrected role.").unwrap();
        storage::set_folder_copilot_fields_on(&conn, id, "Interview", "So,", "").unwrap();
        let input = profile_input_on(&conn, id).unwrap();
        assert!(
            input.cached.is_none(),
            "explicit refresh must call the model"
        );
        assert_ne!(input.hash, "manual");
        let folder = storage::get_folder_on(&conn, id).unwrap().unwrap();
        assert_eq!(folder.profile, "My corrected role.");
        assert_eq!(folder.profile_hash, "manual");
    }

    #[test]
    fn profile_trimming_keeps_whole_sentences_and_unicode_boundaries() {
        assert_eq!(
            trim_profile(&format!("Me builds tools. {}", "x".repeat(1300))),
            "Me builds tools."
        );
        assert_eq!(trim_profile(&"界".repeat(1300)).chars().count(), 1200);
        assert_eq!(trim_profile(" Short answer. "), "Short answer.");
    }

    #[test]
    fn source_prefixes_do_not_match_siblings_or_file_prefixes() {
        let sources = vec![
            ("/approved".into(), "dir".into()),
            ("/one.md".into(), "file".into()),
        ];
        assert!(path_in_sources("/approved/note.md", &sources));
        assert!(path_in_sources("/one.md", &sources));
        assert!(!path_in_sources("/approved-other/note.md", &sources));
        assert!(!path_in_sources("/one.md/other", &sources));
    }
    #[test]
    fn pack_deterministic_utf8() {
        let temp = TempDir::new();
        let conn = storage::in_memory_db();
        let folder = storage::create_folder_on(&conn, "Interview", "blue")
            .unwrap()
            .id;
        storage::insert_folder_source_on(&conn, folder, &temp.source(), "dir", "now").unwrap();
        storage::set_folder_profile_manual_on(&conn, folder, "Me builds tools.").unwrap();
        let huge = format!("# Large\n\n{}", "界".repeat(1_960));
        for (path, body) in [
            ("z-overview.md", "# Z\n\nOmit after the cap."),
            ("c-overview.md", huge.as_str()),
            (
                "b/b-overview.MD",
                "# B\n\nNested project.\n\nSecond paragraph is excluded.",
            ),
            (
                "a-overview.md",
                "\u{feff}\r\n\r\n# A\r\n\r\nFirst project 界.\r\nWrapped line.\r\n\r\nIgnore this.",
            ),
            ("a-details.md", "Not an overview."),
            ("wrong/x-overview.md", "Wrong project directory."),
            ("b/deeper/b-overview.md", "Too deep."),
        ] {
            storage::upsert_folder_doc_on(
                &conn,
                folder,
                temp.path(path).to_str().unwrap(),
                "Doc",
                body,
                "1",
                "now",
            )
            .unwrap();
        }
        let first = build_pack(&conn, folder).unwrap();
        let second = build_pack(&conn, folder).unwrap();
        assert_eq!(first, second);
        assert!(first.text.starts_with("About Me: Me builds tools.\n\nProject a: First project 界.\nWrapped line.\n\nProject b: Nested project."));
        assert_eq!(first.projects, 3);
        assert_eq!(first.omitted, 1);
        assert!(first.text.len() <= 6_000);
        assert!(first.text.ends_with('界'));
        assert_eq!(
            first.hash,
            format!("{:x}", Sha256::digest(first.text.as_bytes()))
        );
        assert!(!first.text.contains("Ignore") && !first.text.contains("Second paragraph"));
        storage::set_session_pack_on(&conn, "missing", &first.text, &first.hash).unwrap_err();
        storage::insert_copilot_session_on(&conn, "frozen", Some(folder), "local", "now").unwrap();
        storage::set_session_pack_on(&conn, "frozen", &first.text, &first.hash).unwrap();
        storage::set_folder_profile_manual_on(&conn, folder, "Changed profile.").unwrap();
        assert_ne!(build_pack(&conn, folder).unwrap().hash, first.hash);
        assert_eq!(
            storage::get_session_pack_on(&conn, "frozen").unwrap(),
            (first.text, first.hash)
        );
    }

    #[test]
    fn folder_terms_rebuild_and_sync_counts_canonical_documents() {
        let temp = TempDir::new();
        fs::write(
            temp.path("one.md"),
            "# RAG CT2 GPU UI API XYZ and the\nBody",
        )
        .unwrap();
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Interview", "blue")
            .unwrap()
            .id;
        storage::insert_folder_source_on(&conn, id, &temp.source(), "dir", "now").unwrap();
        storage::insert_folder_source_on(
            &conn,
            id,
            temp.path("./one.md").to_str().unwrap(),
            "file",
            "now",
        )
        .unwrap();
        assert_eq!(sync_folder_sources_on(&conn, id).unwrap(), 1);
        let terms = storage::get_folder_terms_on(&conn, id).unwrap();
        for term in ["rag", "ct2", "gpu", "ui", "api", "xyz", "mcp", "llm"] {
            assert!(terms.contains(&term.to_string()), "{term}");
        }
        assert!(!terms.contains(&"and".to_string()) && !terms.contains(&"the".to_string()));
        assert!(terms.windows(2).all(|pair| pair[0] < pair[1]));
        fs::write(temp.path("one.md"), "# RAG only\nNew body").unwrap();
        assert_eq!(sync_folder_sources_on(&conn, id).unwrap(), 1);
        let terms = storage::get_folder_terms_on(&conn, id).unwrap();
        assert!(terms.contains(&"rag".to_string()));
        assert!(!terms.contains(&"xyz".to_string()));
    }

    #[test]
    fn pack_omits_whole_entries_and_canonical_duplicates() {
        let temp = TempDir::new();
        fs::write(temp.path("a-overview.md"), "# A\n\nOne project.").unwrap();
        let conn = storage::in_memory_db();
        let id = storage::create_folder_on(&conn, "Interview", "blue")
            .unwrap()
            .id;
        storage::insert_folder_source_on(&conn, id, &temp.source(), "dir", "now").unwrap();
        for path in ["a-overview.md", "./a-overview.md"] {
            storage::upsert_folder_doc_on(
                &conn,
                id,
                temp.path(path).to_str().unwrap(),
                "A",
                "# A\n\nOne project.",
                "1",
                "now",
            )
            .unwrap();
        }
        storage::upsert_folder_doc_on(
            &conn,
            id,
            temp.path("b-overview.md").to_str().unwrap(),
            "B",
            &"界".repeat(2_000),
            "1",
            "now",
        )
        .unwrap();
        storage::upsert_folder_doc_on(
            &conn,
            id,
            temp.path("c-overview.md").to_str().unwrap(),
            "C",
            "Small but later.",
            "1",
            "now",
        )
        .unwrap();
        let pack = build_pack(&conn, id).unwrap();
        assert_eq!(pack.text, "Project a: One project.");
        assert_eq!(pack.projects, 1);
        assert_eq!(pack.omitted, 2);
    }
}
