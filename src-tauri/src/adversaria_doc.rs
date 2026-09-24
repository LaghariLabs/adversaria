//! `.adversaria` document format: export, import, serialization, parsing, and migration.
//!
//! A first-class document format (JSON with `.adversaria` extension) carrying
//! stable UIDs, folders, meetings, rich action items, and attachments without
//! duplicating on re-import.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::storage::{
    encode_attendees, encode_tags, encode_transcript_turns, insert_meeting_on, new_uid,
    sync_action_items,
};
use crate::types::{ActionItem, ImportReport, Meeting, Tag, TranscriptTurn};

pub const ADVERSARIA_DOCUMENT_FORMAT: &str = "adversaria";
pub const ADVERSARIA_SCHEMA_VERSION: i64 = 1;
pub const LEGACY_BUNDLE_SCHEMA_VERSION: i64 = 1;

/// Root envelope of a `.adversaria` document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdversariaDocument {
    pub format: String,
    pub schema_version: i64,
    pub document_uid: String,
    pub exported_at: String,
    pub app_version: String,
    #[serde(default)]
    pub scope: DocumentScope,
    #[serde(default)]
    pub folders: Vec<AdversariaFolder>,
    #[serde(default)]
    pub meetings: Vec<AdversariaMeeting>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DocumentScope {
    #[serde(default)]
    pub kind: String, // "meeting" | "selection" | "folder"
    #[serde(default)]
    pub root_uid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AdversariaFolder {
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub copilot_mode: String,
    #[serde(default)]
    pub meeting_uids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AdversariaMeeting {
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub recorded_at: String,
    #[serde(default)]
    pub duration_seconds: f64,
    #[serde(default)]
    pub template_used: String,
    #[serde(default)]
    pub transcript: String,
    #[serde(default)]
    pub transcript_turns: Vec<TranscriptTurn>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub user_notes: String,
    #[serde(default)]
    pub link: String,
    #[serde(default)]
    pub tags: Vec<Tag>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub action_items: Vec<AdversariaActionItem>,
    #[serde(default)]
    pub attachments: Vec<AdversariaAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AdversariaActionItem {
    #[serde(default)]
    pub ord: i64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub assignee: String,
    #[serde(default)]
    pub due: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub completed_by: String,
    #[serde(default)]
    pub completed_at: String,
    #[serde(default)]
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AdversariaAttachment {
    #[serde(default)]
    pub kind: String, // "file" | "meeting"
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting_uid: Option<String>,
}

/// Legacy bundle representation (today's `*.adversaria.json` schema v1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyBundle {
    pub schema_version: i64,
    #[serde(default)]
    pub exported_at: String,
    #[serde(default)]
    pub app_version: String,
    pub meeting: serde_json::Value,
}

/// Parsed result from reading an import file.
#[derive(Debug, Clone)]
pub enum ParsedImport {
    Adversaria(AdversariaDocument),
    Legacy(LegacyBundle),
}

/// Build an `AdversariaDocument` from existing database records. Pure on `conn`.
pub fn build_document(
    conn: &Connection,
    meeting_ids: &[i64],
    folder_id: Option<i64>,
) -> anyhow::Result<AdversariaDocument> {
    let mut meetings_to_export: Vec<Meeting> = Vec::new();
    let mut doc_folders: Vec<AdversariaFolder> = Vec::new();
    let scope;

    if let Some(fid) = folder_id {
        let folder = crate::storage::get_folder_on(conn, fid)?
            .ok_or_else(|| anyhow::anyhow!("Folder not found: {fid}"))?;
        let filed_meetings = crate::storage::get_meetings_for_folder_on(conn, fid)?;
        let meeting_uids: Vec<String> = filed_meetings.iter().map(|m| m.uid.clone()).collect();
        doc_folders.push(AdversariaFolder {
            uid: folder.uid.clone(),
            name: folder.name,
            color: folder.color,
            instructions: folder.instructions,
            copilot_mode: folder.copilot_mode,
            meeting_uids,
        });
        meetings_to_export = filed_meetings;
        scope = DocumentScope {
            kind: "folder".to_string(),
            root_uid: Some(folder.uid),
        };
    } else {
        for &id in meeting_ids {
            if let Some(m) = crate::storage::get_meeting_on(conn, id)? {
                meetings_to_export.push(m);
            }
        }
        let kind = if meeting_ids.len() == 1 {
            "meeting".to_string()
        } else {
            "selection".to_string()
        };
        scope = DocumentScope {
            kind,
            root_uid: None,
        };
    }

    let doc_meeting_uids: HashSet<String> =
        meetings_to_export.iter().map(|m| m.uid.clone()).collect();

    // Map numeric meeting IDs to UIDs for meeting-attachment link translation.
    let mut id_to_uid: HashMap<i64, String> = HashMap::new();
    for m in &meetings_to_export {
        id_to_uid.insert(m.id, m.uid.clone());
    }

    let mut doc_meetings: Vec<AdversariaMeeting> = Vec::with_capacity(meetings_to_export.len());
    for m in meetings_to_export {
        let action_items = crate::storage::get_action_items_on(conn, Some(m.id))?
            .into_iter()
            .map(|a| AdversariaActionItem {
                ord: a.ord,
                text: a.text,
                assignee: a.assignee,
                due: a.due,
                done: a.done,
                status: a.status,
                completed_by: a.completed_by,
                completed_at: a.completed_at,
                evidence: a.evidence,
            })
            .collect();

        let raw_attachments = crate::storage::list_meeting_attachments_on(conn, m.id)?;
        let mut doc_attachments: Vec<AdversariaAttachment> =
            Vec::with_capacity(raw_attachments.len());
        for att in raw_attachments {
            if att.kind == "file" {
                let file_name = Path::new(&att.value)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| att.value.clone());
                doc_attachments.push(AdversariaAttachment {
                    kind: "file".to_string(),
                    label: att.label,
                    file_name: Some(file_name),
                    meeting_uid: None,
                });
            } else if att.kind == "meeting" {
                let target_uid = if let Ok(target_id) = att.value.parse::<i64>() {
                    if let Some(uid) = id_to_uid.get(&target_id) {
                        Some(uid.clone())
                    } else if let Some(target_meeting) =
                        crate::storage::get_meeting_on(conn, target_id)?
                    {
                        if doc_meeting_uids.contains(&target_meeting.uid) {
                            Some(target_meeting.uid)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };

                doc_attachments.push(AdversariaAttachment {
                    kind: "meeting".to_string(),
                    label: att.label,
                    file_name: None,
                    meeting_uid: target_uid,
                });
            }
        }

        doc_meetings.push(AdversariaMeeting {
            uid: m.uid,
            title: m.title,
            recorded_at: m.recorded_at,
            duration_seconds: m.duration_seconds,
            template_used: m.template_used,
            transcript: m.transcript,
            transcript_turns: m.transcript_turns,
            summary: m.summary,
            attendees: m.attendees,
            user_notes: m.user_notes,
            link: m.link,
            tags: m.tags,
            pinned: m.pinned,
            locked: m.locked,
            archived: m.archived,
            action_items,
            attachments: doc_attachments,
        });
    }

    Ok(AdversariaDocument {
        format: ADVERSARIA_DOCUMENT_FORMAT.to_string(),
        schema_version: ADVERSARIA_SCHEMA_VERSION,
        document_uid: new_uid(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        scope,
        folders: doc_folders,
        meetings: doc_meetings,
    })
}

/// Serialize and write an `AdversariaDocument` to the given file path.
pub fn write_document(path: &Path, doc: &AdversariaDocument) -> anyhow::Result<()> {
    let contents = serde_json::to_string_pretty(doc)?;
    std::fs::write(path, contents)?;
    Ok(())
}

/// Parse a raw JSON string into either an `Adversaria` document or a `Legacy` bundle.
pub fn parse_document(text: &str) -> anyhow::Result<ParsedImport> {
    let val: serde_json::Value =
        serde_json::from_str(text).map_err(|e| anyhow::anyhow!("Invalid JSON: {e}"))?;

    if val.get("format").and_then(|v| v.as_str()) == Some(ADVERSARIA_DOCUMENT_FORMAT) {
        let version = val
            .get("schema_version")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if version != ADVERSARIA_SCHEMA_VERSION {
            anyhow::bail!(
                "Unsupported Adversaria document schema version: {version}. This version supports v{ADVERSARIA_SCHEMA_VERSION}."
            );
        }
        let doc: AdversariaDocument = serde_json::from_value(val)?;
        Ok(ParsedImport::Adversaria(doc))
    } else if val.get("meeting").is_some() {
        let version = val
            .get("schema_version")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if version != LEGACY_BUNDLE_SCHEMA_VERSION {
            anyhow::bail!(
                "This bundle needs a different version of Adversaria (schema v{version}; this version supports v{LEGACY_BUNDLE_SCHEMA_VERSION})."
            );
        }
        let bundle: LegacyBundle = serde_json::from_value(val)?;
        Ok(ParsedImport::Legacy(bundle))
    } else {
        anyhow::bail!("Unrecognized document format: missing format header or meeting root.");
    }
}

/// Import a parsed document or legacy bundle into the database in one single SQLite transaction.
pub fn import_document_on(conn: &Connection, parsed: ParsedImport) -> anyhow::Result<ImportReport> {
    let tx = conn.unchecked_transaction()?;

    match parsed {
        ParsedImport::Legacy(legacy) => {
            let (mut meeting, action_items) =
                parse_bundle_meeting(&legacy.meeting).map_err(|e| anyhow::anyhow!("{e}"))?;
            meeting.uid = new_uid();
            let new_id = insert_meeting_on(&tx, &meeting)?;
            for item in &action_items {
                tx.execute(
                    "INSERT INTO action_items (meeting_id, ord, text, assignee, due, done)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        new_id,
                        item.ord,
                        item.text,
                        item.assignee,
                        item.due,
                        item.done as i32
                    ],
                )?;
            }
            tx.commit()?;
            Ok(ImportReport {
                format: "legacy-json-1".to_string(),
                imported: 1,
                skipped_existing: 0,
                folders_created: 0,
                meeting_ids: vec![new_id],
                folder_id: None,
                path: String::new(),
            })
        }
        ParsedImport::Adversaria(doc) => {
            let mut imported: i64 = 0;
            let mut skipped_existing: i64 = 0;
            let mut folders_created: i64 = 0;
            let mut meeting_ids: Vec<i64> = Vec::new();
            let mut meeting_uid_to_id: HashMap<String, i64> = HashMap::new();
            let mut newly_imported_uids: HashSet<String> = HashSet::new();

            // Pass 1: Meetings (insert or reuse)
            for doc_m in &doc.meetings {
                let existing_id: Option<i64> = if !doc_m.uid.trim().is_empty() {
                    tx.query_row(
                        "SELECT id FROM meetings WHERE uid = ?1",
                        params![doc_m.uid],
                        |row| row.get(0),
                    )
                    .optional()?
                } else {
                    None
                };

                if let Some(id) = existing_id {
                    skipped_existing += 1;
                    meeting_ids.push(id);
                    meeting_uid_to_id.insert(doc_m.uid.clone(), id);
                } else {
                    let uid = if doc_m.uid.trim().is_empty() {
                        new_uid()
                    } else {
                        doc_m.uid.clone()
                    };

                    tx.execute(
                        "INSERT INTO meetings (uid, title, recorded_at, duration_seconds, transcript, summary, template_used, audio_file_path, attendees, user_notes, link, tags, transcript_turns, pinned, locked, archived)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                        params![
                            uid,
                            doc_m.title,
                            doc_m.recorded_at,
                            doc_m.duration_seconds,
                            doc_m.transcript,
                            doc_m.summary,
                            doc_m.template_used,
                            Option::<String>::None,
                            encode_attendees(&doc_m.attendees),
                            doc_m.user_notes,
                            doc_m.link,
                            encode_tags(&doc_m.tags),
                            encode_transcript_turns(&doc_m.transcript_turns),
                            doc_m.pinned,
                            doc_m.locked,
                            doc_m.archived,
                        ],
                    )?;
                    let new_id = tx.last_insert_rowid();
                    imported += 1;
                    meeting_ids.push(new_id);
                    meeting_uid_to_id.insert(uid.clone(), new_id);
                    newly_imported_uids.insert(uid);

                    // Sync action items from summary
                    sync_action_items(&tx, new_id, &doc_m.summary)?;

                    // Overwrite action item fields from document by ord
                    for item in &doc_m.action_items {
                        let status_val = if item.status.is_empty() {
                            if item.done {
                                "done"
                            } else {
                                "todo"
                            }
                        } else {
                            &item.status
                        };

                        let updated = tx.execute(
                            "UPDATE action_items
                             SET done = ?1, status = ?2, completed_by = ?3, completed_at = ?4, evidence = ?5, assignee = ?6, due = ?7
                             WHERE meeting_id = ?8 AND ord = ?9",
                            params![
                                item.done as i32,
                                status_val,
                                item.completed_by,
                                item.completed_at,
                                item.evidence,
                                item.assignee,
                                item.due,
                                new_id,
                                item.ord,
                            ],
                        )?;
                        if updated == 0 {
                            tx.execute(
                                "INSERT INTO action_items (meeting_id, ord, text, assignee, due, done, status, completed_by, completed_at, evidence)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                                params![
                                    new_id,
                                    item.ord,
                                    item.text,
                                    item.assignee,
                                    item.due,
                                    item.done as i32,
                                    status_val,
                                    item.completed_by,
                                    item.completed_at,
                                    item.evidence,
                                ],
                            )?;
                        }
                    }
                }
            }

            // Pass 2: Attachments for newly imported meetings
            let now = chrono::Utc::now().to_rfc3339();
            for doc_m in &doc.meetings {
                if newly_imported_uids.contains(&doc_m.uid) {
                    if let Some(&local_id) = meeting_uid_to_id.get(&doc_m.uid) {
                        for att in &doc_m.attachments {
                            if att.kind == "meeting" {
                                if let Some(ref target_uid) = att.meeting_uid {
                                    if let Some(&target_id) = meeting_uid_to_id.get(target_uid) {
                                        tx.execute(
                                            "INSERT INTO meeting_attachments (meeting_id, kind, value, label, created_at)
                                             VALUES (?1, ?2, ?3, ?4, ?5)",
                                            params![
                                                local_id,
                                                "meeting",
                                                target_id.to_string(),
                                                att.label,
                                                now
                                            ],
                                        )?;
                                    }
                                }
                            } else if att.kind == "file" {
                                let file_name = att.file_name.as_deref().unwrap_or("");
                                tx.execute(
                                    "INSERT INTO meeting_attachments (meeting_id, kind, value, label, created_at)
                                     VALUES (?1, ?2, ?3, ?4, ?5)",
                                    params![local_id, "file", file_name, att.label, now],
                                )?;
                            }
                        }
                    }
                }
            }

            // Pass 3: Folders (match by uid, else name, else create)
            let mut folder_uid_to_id: HashMap<String, i64> = HashMap::new();
            for doc_f in &doc.folders {
                let mut matched_id: Option<i64> = if !doc_f.uid.trim().is_empty() {
                    tx.query_row(
                        "SELECT id FROM folders WHERE uid = ?1",
                        params![doc_f.uid],
                        |row| row.get(0),
                    )
                    .optional()?
                } else {
                    None
                };

                if matched_id.is_none() && !doc_f.name.trim().is_empty() {
                    matched_id = tx
                        .query_row(
                            "SELECT id FROM folders WHERE name = ?1",
                            params![doc_f.name],
                            |row| row.get(0),
                        )
                        .optional()?;
                }

                let folder_id = match matched_id {
                    Some(f_id) => f_id,
                    None => {
                        let f_uid = if doc_f.uid.trim().is_empty() {
                            new_uid()
                        } else {
                            doc_f.uid.clone()
                        };
                        let folder_color = if doc_f.color.is_empty() {
                            "blue"
                        } else {
                            &doc_f.color
                        };
                        let copilot_mode = if doc_f.copilot_mode.is_empty() {
                            "no_ai"
                        } else {
                            &doc_f.copilot_mode
                        };

                        tx.execute(
                            "INSERT INTO folders (uid, name, color, instructions, copilot_mode, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                            params![
                                f_uid,
                                doc_f.name,
                                folder_color,
                                doc_f.instructions,
                                copilot_mode,
                                now,
                            ],
                        )?;
                        let new_folder_id = tx.last_insert_rowid();
                        folders_created += 1;
                        new_folder_id
                    }
                };

                folder_uid_to_id.insert(doc_f.uid.clone(), folder_id);

                // File each imported meeting listed in meeting_uids
                for m_uid in &doc_f.meeting_uids {
                    if let Some(&m_id) = meeting_uid_to_id.get(m_uid) {
                        tx.execute(
                            "INSERT INTO meeting_folders (meeting_id, folder_id, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?3)
                             ON CONFLICT(meeting_id) DO UPDATE SET
                                 folder_id = excluded.folder_id,
                                 updated_at = excluded.updated_at",
                            params![m_id, folder_id, now],
                        )?;
                    }
                }
            }

            let resolved_folder_id = if doc.scope.kind == "folder" {
                if let Some(ref root_uid) = doc.scope.root_uid {
                    folder_uid_to_id.get(root_uid).copied()
                } else {
                    doc.folders
                        .first()
                        .and_then(|f| folder_uid_to_id.get(&f.uid).copied())
                }
            } else {
                None
            };

            tx.commit()?;

            Ok(ImportReport {
                format: "adversaria-1".to_string(),
                imported,
                skipped_existing,
                folders_created,
                meeting_ids,
                folder_id: resolved_folder_id,
                path: String::new(),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Legacy bundle serialization and parsing helpers (moved from commands.rs)
// ---------------------------------------------------------------------------

/// One action item parsed from a bundle, ready to insert.
#[derive(Debug, Clone)]
pub struct BundleActionItem {
    pub ord: i64,
    pub text: String,
    pub assignee: String,
    pub due: String,
    pub done: bool,
}

/// Reject bundles whose schema version this build doesn't understand.
pub fn check_schema_version(bundle: &serde_json::Value) -> Result<(), String> {
    let v = bundle
        .get("schema_version")
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    if v != LEGACY_BUNDLE_SCHEMA_VERSION {
        return Err(format!(
            "This bundle needs a different version of Adversaria (schema v{v}; this version supports v{LEGACY_BUNDLE_SCHEMA_VERSION})."
        ));
    }
    Ok(())
}

fn bundle_string(obj: &serde_json::Value, key: &str) -> Result<String, String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Bundle is missing the required field: {key}"))
}

fn bundle_string_or(obj: &serde_json::Value, key: &str, default: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| default.to_string())
}

fn bundle_string_array(obj: &serde_json::Value, key: &str) -> Vec<String> {
    obj.get(key)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn bundle_tags(obj: &serde_json::Value) -> Vec<Tag> {
    obj.get("tags")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    Some(Tag {
                        label: v.get("label")?.as_str()?.to_string(),
                        color: v.get("color")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn bundle_transcript_turns(obj: &serde_json::Value) -> Vec<TranscriptTurn> {
    obj.get("transcript_turns")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    Some(TranscriptTurn {
                        speaker: v.get("speaker")?.as_str()?.to_string(),
                        text: v.get("text")?.as_str()?.to_string(),
                        start: v.get("start").and_then(|s| s.as_f64()),
                        end: v.get("end").and_then(|s| s.as_f64()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Serialize a meeting + its action items into the per-meeting bundle object.
pub fn meeting_to_bundle_json(meeting: &Meeting, action_items: &[ActionItem]) -> serde_json::Value {
    serde_json::json!({
        "title": meeting.title,
        "recorded_at": meeting.recorded_at,
        "duration_seconds": meeting.duration_seconds,
        "template_used": meeting.template_used,
        "transcript": meeting.transcript,
        "transcript_turns": meeting.transcript_turns,
        "summary": meeting.summary,
        "attendees": meeting.attendees,
        "user_notes": meeting.user_notes,
        "link": meeting.link,
        "tags": meeting.tags,
        "action_items": action_items.iter().map(|a| serde_json::json!({
            "ord": a.ord,
            "text": a.text,
            "assignee": a.assignee,
            "due": a.due,
            "done": a.done,
        })).collect::<Vec<_>>(),
    })
}

/// Parse the "meeting" object of a bundle into a fresh `Meeting` (id=0) plus its action items.
pub fn parse_bundle_meeting(
    m: &serde_json::Value,
) -> Result<(Meeting, Vec<BundleActionItem>), String> {
    let meeting = Meeting {
        id: 0,
        uid: String::new(),
        title: bundle_string(m, "title")?,
        recorded_at: {
            let raw = bundle_string(m, "recorded_at")?;
            chrono::DateTime::parse_from_rfc3339(&raw)
                .map(|dt| dt.with_timezone(&chrono::Utc).to_rfc3339())
                .unwrap_or(raw)
        },
        duration_seconds: m
            .get("duration_seconds")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        transcript: bundle_string_or(m, "transcript", ""),
        summary: bundle_string_or(m, "summary", ""),
        template_used: bundle_string_or(m, "template_used", "general"),
        audio_file_path: None,
        attendees: bundle_string_array(m, "attendees"),
        user_notes: bundle_string_or(m, "user_notes", ""),
        link: bundle_string_or(m, "link", ""),
        tags: bundle_tags(m),
        pinned: false,
        locked: false,
        archived: false,
        transcript_turns: bundle_transcript_turns(m),
    };

    let action_items = m
        .get("action_items")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|item| BundleActionItem {
                    ord: item.get("ord").and_then(|v| v.as_i64()).unwrap_or(0),
                    text: item
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    assignee: item
                        .get("assignee")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    due: item
                        .get("due")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    done: item.get("done").and_then(|v| v.as_bool()).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok((meeting, action_items))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::in_memory_db;

    fn is_uuid_v4(s: &str) -> bool {
        if s.len() != 36 {
            return false;
        }
        let bytes = s.as_bytes();
        if bytes[8] != b'-' || bytes[13] != b'-' || bytes[18] != b'-' || bytes[23] != b'-' {
            return false;
        }
        if bytes[14] != b'4' {
            return false;
        }
        matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
    }

    #[test]
    fn uid_backfill_and_generation() {
        let conn = in_memory_db();

        // 1. Insert meetings without uid -> get distinct UUID v4s
        let m1 = Meeting {
            id: 0,
            uid: String::new(),
            title: "First Meeting".to_string(),
            recorded_at: "2026-07-01T10:00:00Z".to_string(),
            duration_seconds: 120.0,
            transcript: "Transcript 1".to_string(),
            summary: "Summary 1".to_string(),
            template_used: "general".to_string(),
            audio_file_path: None,
            attendees: vec!["Alice".to_string()],
            user_notes: "Notes 1".to_string(),
            link: "".to_string(),
            tags: vec![],
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: vec![],
        };
        let m2 = Meeting {
            id: 0,
            uid: String::new(),
            title: "Second Meeting".to_string(),
            recorded_at: "2026-07-01T11:00:00Z".to_string(),
            duration_seconds: 180.0,
            transcript: "Transcript 2".to_string(),
            summary: "Summary 2".to_string(),
            template_used: "general".to_string(),
            audio_file_path: None,
            attendees: vec!["Bob".to_string()],
            user_notes: "Notes 2".to_string(),
            link: "".to_string(),
            tags: vec![],
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: vec![],
        };

        let id1 = insert_meeting_on(&conn, &m1).expect("insert m1");
        let id2 = insert_meeting_on(&conn, &m2).expect("insert m2");

        let loaded1 = crate::storage::get_meeting_on(&conn, id1)
            .unwrap()
            .expect("loaded1");
        let loaded2 = crate::storage::get_meeting_on(&conn, id2)
            .unwrap()
            .expect("loaded2");

        assert!(!loaded1.uid.is_empty());
        assert!(!loaded2.uid.is_empty());
        assert_ne!(loaded1.uid, loaded2.uid);
        assert!(
            is_uuid_v4(&loaded1.uid),
            "m1 uid must be uuid v4: {}",
            loaded1.uid
        );
        assert!(
            is_uuid_v4(&loaded2.uid),
            "m2 uid must be uuid v4: {}",
            loaded2.uid
        );

        // get_meeting_by_uid_on finds them
        let by_uid1 = crate::storage::get_meeting_by_uid_on(&conn, &loaded1.uid)
            .unwrap()
            .expect("find m1 by uid");
        assert_eq!(by_uid1.id, id1);
        assert_eq!(by_uid1.title, "First Meeting");

        // 2. Folder insertion generates uid
        let folder =
            crate::storage::create_folder_on(&conn, "Team Folder", "blue").expect("create folder");
        assert!(!folder.uid.is_empty());
        assert!(
            is_uuid_v4(&folder.uid),
            "folder uid must be uuid v4: {}",
            folder.uid
        );

        let by_f_uid = crate::storage::get_folder_by_uid_on(&conn, &folder.uid)
            .unwrap()
            .expect("find folder by uid");
        assert_eq!(by_f_uid.id, folder.id);

        // 3. Backfill test: manually insert row with empty uid
        conn.execute(
            "INSERT INTO meetings (uid, title, recorded_at, duration_seconds) VALUES ('', 'Legacy 1', '2026-06-01T00:00:00Z', 10)",
            [],
        ).unwrap();
        let legacy_id = conn.last_insert_rowid();

        conn.execute(
            "INSERT INTO folders (uid, name, color, created_at, updated_at) VALUES ('', 'Legacy Folder', 'red', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
            [],
        ).unwrap();
        let legacy_f_id = conn.last_insert_rowid();

        crate::storage::backfill_uids(&conn).expect("backfill uids");

        let backfilled_m = crate::storage::get_meeting_on(&conn, legacy_id)
            .unwrap()
            .unwrap();
        assert!(!backfilled_m.uid.is_empty());
        assert!(is_uuid_v4(&backfilled_m.uid));

        let backfilled_f = crate::storage::get_folder_on(&conn, legacy_f_id)
            .unwrap()
            .unwrap();
        assert!(!backfilled_f.uid.is_empty());
        assert!(is_uuid_v4(&backfilled_f.uid));
    }

    #[test]
    fn adversaria_roundtrip_folder() {
        let conn1 = in_memory_db();

        // Create folder
        let folder = crate::storage::create_folder_on(&conn1, "Project Alpha", "green").unwrap();

        // Meeting 1
        let m1 = Meeting {
            id: 0,
            uid: String::new(),
            title: "Kickoff Meeting".to_string(),
            recorded_at: "2026-08-01T10:00:00Z".to_string(),
            duration_seconds: 600.0,
            transcript: "Alice: Let's start.".to_string(),
            summary: "**Summary**\n- Item 1".to_string(),
            template_used: "project".to_string(),
            audio_file_path: Some("/tmp/audio1.wav".to_string()),
            attendees: vec!["Alice".to_string(), "Bob".to_string()],
            user_notes: "Important client notes".to_string(),
            link: "https://example.com/meet".to_string(),
            tags: vec![Tag {
                label: "Client".to_string(),
                color: "green".to_string(),
            }],
            pinned: true,
            locked: false,
            archived: false,
            transcript_turns: vec![TranscriptTurn {
                speaker: "Alice".to_string(),
                text: "Let's start.".to_string(),
                start: Some(0.0),
                end: Some(2.0),
            }],
        };
        let m1_id = insert_meeting_on(&conn1, &m1).unwrap();
        crate::storage::set_meeting_folder_on(&conn1, m1_id, Some(folder.id)).unwrap();

        // Meeting 2
        let m2 = Meeting {
            id: 0,
            uid: String::new(),
            title: "Follow-up Meeting".to_string(),
            recorded_at: "2026-08-02T10:00:00Z".to_string(),
            duration_seconds: 900.0,
            transcript: "Bob: Reviewing tasks.".to_string(),
            summary: "**Summary**\n- Item 2".to_string(),
            template_used: "follow-up".to_string(),
            audio_file_path: None,
            attendees: vec!["Bob".to_string()],
            user_notes: "Bob's notes".to_string(),
            link: "".to_string(),
            tags: vec![],
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: vec![],
        };
        let m2_id = insert_meeting_on(&conn1, &m2).unwrap();
        crate::storage::set_meeting_folder_on(&conn1, m2_id, Some(folder.id)).unwrap();

        // Action items for m1: one done, one with status/evidence
        conn1.execute(
            "INSERT INTO action_items (meeting_id, ord, text, assignee, due, done, status, completed_by, completed_at, evidence)
             VALUES (?1, 0, 'Design architecture', 'Alice', '2026-08-10', 1, 'done', 'Alice', '2026-08-03T12:00:00Z', 'PR #42')",
            params![m1_id],
        ).unwrap();
        conn1.execute(
            "INSERT INTO action_items (meeting_id, ord, text, assignee, due, done, status, completed_by, completed_at, evidence)
             VALUES (?1, 1, 'Review security', 'Bob', '2026-08-12', 0, 'in_review', '', '', 'Audit report attached')",
            params![m1_id],
        ).unwrap();

        // Meeting attachment between m1 and m2 (m1 attaches m2)
        crate::storage::add_meeting_attachments_on(
            &conn1,
            m1_id,
            &[(
                "meeting".to_string(),
                m2_id.to_string(),
                "Prior discussion".to_string(),
            )],
        )
        .unwrap();

        // Build document for folder
        let doc = build_document(&conn1, &[], Some(folder.id)).expect("build_document");
        assert_eq!(doc.scope.kind, "folder");
        assert_eq!(doc.meetings.len(), 2);
        assert_eq!(doc.folders.len(), 1);

        // Serialize and parse
        let json_str = serde_json::to_string_pretty(&doc).unwrap();
        let parsed = parse_document(&json_str).expect("parse_document");

        // Import into FRESH in-memory DB
        let conn2 = in_memory_db();
        let report = import_document_on(&conn2, parsed).expect("import_document_on");

        assert_eq!(
            report,
            ImportReport {
                format: "adversaria-1".to_string(),
                imported: 2,
                skipped_existing: 0,
                folders_created: 1,
                meeting_ids: report.meeting_ids.clone(),
                folder_id: report.folder_id,
                path: String::new(),
            }
        );
        assert!(report.folder_id.is_some());

        // Verify folder in conn2
        let f2 = crate::storage::get_folder_on(&conn2, report.folder_id.unwrap())
            .unwrap()
            .expect("folder exists in conn2");
        assert_eq!(f2.name, "Project Alpha");
        assert_eq!(f2.color, "green");

        // Verify meetings in conn2
        let m1_imported = crate::storage::get_meeting_by_uid_on(&conn2, &doc.meetings[0].uid)
            .unwrap()
            .expect("m1 in conn2");
        let m2_imported = crate::storage::get_meeting_by_uid_on(&conn2, &doc.meetings[1].uid)
            .unwrap()
            .expect("m2 in conn2");

        // Verify folder filing
        let f_meetings = crate::storage::get_meetings_for_folder_on(&conn2, f2.id).unwrap();
        assert_eq!(f_meetings.len(), 2);

        // Verify action items on m1
        let (m1_actual_id, m2_actual_id) = if m1_imported.title == "Kickoff Meeting" {
            (m1_imported.id, m2_imported.id)
        } else {
            (m2_imported.id, m1_imported.id)
        };
        let items = crate::storage::get_action_items_on(&conn2, Some(m1_actual_id)).unwrap();
        assert_eq!(items.len(), 2);
        let done_item = items.iter().find(|i| i.ord == 0).unwrap();
        assert_eq!(done_item.text, "Design architecture");
        assert!(done_item.done);
        assert_eq!(done_item.status, "done");
        assert_eq!(done_item.completed_by, "Alice");
        assert_eq!(done_item.evidence, "PR #42");

        let review_item = items.iter().find(|i| i.ord == 1).unwrap();
        assert_eq!(review_item.text, "Review security");
        assert!(!review_item.done);
        assert_eq!(review_item.status, "in_review");
        assert_eq!(review_item.evidence, "Audit report attached");

        // Verify meeting attachment re-linked to new m2 id
        let attachments =
            crate::storage::list_meeting_attachments_on(&conn2, m1_actual_id).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].kind, "meeting");
        assert_eq!(attachments[0].value, m2_actual_id.to_string());
        assert_eq!(attachments[0].label, "Prior discussion");
    }

    #[test]
    fn adversaria_reimport_skips_existing() {
        let conn1 = in_memory_db();
        let m = Meeting {
            id: 0,
            uid: String::new(),
            title: "Dedup Test".to_string(),
            recorded_at: "2026-08-01T10:00:00Z".to_string(),
            duration_seconds: 300.0,
            transcript: "Testing dedup".to_string(),
            summary: "Dedup summary".to_string(),
            template_used: "general".to_string(),
            audio_file_path: None,
            attendees: vec![],
            user_notes: "".to_string(),
            link: "".to_string(),
            tags: vec![],
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: vec![],
        };
        let id = insert_meeting_on(&conn1, &m).unwrap();
        let doc = build_document(&conn1, &[id], None).unwrap();
        let json_str = serde_json::to_string_pretty(&doc).unwrap();

        // Fresh DB
        let conn2 = in_memory_db();
        let parsed1 = parse_document(&json_str).unwrap();
        let r1 = import_document_on(&conn2, parsed1).unwrap();
        assert_eq!(r1.imported, 1);
        assert_eq!(r1.skipped_existing, 0);

        // Second import of same doc
        let parsed2 = parse_document(&json_str).unwrap();
        let r2 = import_document_on(&conn2, parsed2).unwrap();
        assert_eq!(r2.imported, 0);
        assert_eq!(r2.skipped_existing, 1);

        let count: i64 = conn2
            .query_row("SELECT count(*) FROM meetings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "no duplicate rows created");
    }

    #[test]
    fn legacy_bundle_still_imports() {
        let legacy_json = serde_json::json!({
            "schema_version": 1,
            "exported_at": "2026-07-01T10:00:00Z",
            "app_version": "0.3.83",
            "meeting": {
                "title": "Legacy Standup",
                "recorded_at": "2026-07-01T10:00:00Z",
                "duration_seconds": 600.0,
                "template_used": "general",
                "transcript": "Quick update",
                "summary": "Everything good",
                "attendees": ["Dave"],
                "user_notes": "None",
                "link": "",
                "tags": [],
                "action_items": [
                    { "ord": 0, "text": "Ship feature", "assignee": "Dave", "due": "2026-07-05", "done": true }
                ]
            }
        });

        let text = serde_json::to_string_pretty(&legacy_json).unwrap();
        let parsed = parse_document(&text).expect("parse legacy bundle");

        let conn = in_memory_db();
        let report = import_document_on(&conn, parsed).expect("import legacy");

        assert_eq!(report.format, "legacy-json-1");
        assert_eq!(report.imported, 1);
        assert_eq!(report.skipped_existing, 0);
        assert_eq!(report.meeting_ids.len(), 1);

        let imported_m = crate::storage::get_meeting_on(&conn, report.meeting_ids[0])
            .unwrap()
            .expect("meeting imported");
        assert_eq!(imported_m.title, "Legacy Standup");
        assert!(
            !imported_m.uid.is_empty(),
            "fresh uid generated for legacy import"
        );
        assert!(is_uuid_v4(&imported_m.uid));

        let items = crate::storage::get_action_items_on(&conn, Some(imported_m.id)).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Ship feature");
        assert!(items[0].done);
    }

    #[test]
    fn document_has_no_paths_or_audio() {
        let conn = in_memory_db();
        let m = Meeting {
            id: 0,
            uid: String::new(),
            title: "Private Audio Meeting".to_string(),
            recorded_at: "2026-08-01T10:00:00Z".to_string(),
            duration_seconds: 300.0,
            transcript: "Secret transcript".to_string(),
            summary: "Secret summary".to_string(),
            template_used: "general".to_string(),
            audio_file_path: Some("/Users/mhlaghari/audio/secret.wav".to_string()),
            attendees: vec![],
            user_notes: "".to_string(),
            link: "".to_string(),
            tags: vec![],
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: vec![],
        };
        let m_id = insert_meeting_on(&conn, &m).unwrap();

        // Attach a file with absolute path
        crate::storage::add_meeting_attachments_on(
            &conn,
            m_id,
            &[(
                "file".to_string(),
                "/Users/mhlaghari/Documents/secret_notes.pdf".to_string(),
                "Secret Notes".to_string(),
            )],
        )
        .unwrap();

        let doc = build_document(&conn, &[m_id], None).unwrap();
        let json_str = serde_json::to_string_pretty(&doc).unwrap();

        // Must not contain audio_file_path
        assert!(
            !json_str.contains("audio_file_path"),
            "serialized json must not contain audio_file_path"
        );
        assert!(
            !json_str.contains("secret.wav"),
            "audio file path must not leak into document"
        );

        // Must not contain absolute /Users path
        assert!(
            !json_str.contains("/Users/mhlaghari"),
            "no absolute paths in document"
        );
        // But must contain basename
        assert!(
            json_str.contains("secret_notes.pdf"),
            "file attachment should retain basename"
        );
    }
}
