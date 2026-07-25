//! Meeting-chunk embedding index for the hybrid Ask retriever.
//!
//! Chunks each meeting's transcript (grouped speaker turns) and summary
//! (sections) into ~1.5 KB passages, embeds them via the Python service's
//! local /embed endpoint (Ollama bge-m3), and stores the vectors as BLOBs in
//! SQLite. `sync_index` is self-healing: it re-indexes any meeting whose
//! content fingerprint or embedding model changed, so callers just fire it
//! after content writes and at startup. 100% on-device.

use std::sync::atomic::{AtomicBool, Ordering};

/// Soft cap on a chunk's body size, in chars (title prefix excluded).
pub const CHUNK_TARGET_CHARS: usize = 1500;

/// Cheap content fingerprint used to detect stale index entries.
pub fn fingerprint(m: &crate::types::Meeting) -> String {
    format!(
        "{}:{}:{}",
        m.transcript.len(),
        m.summary.len(),
        m.title.len()
    )
}

/// Split a meeting into (kind, text) chunks for embedding. Kinds are
/// "transcript" and "summary". Every chunk text is prefixed with
/// "{title} ({date})\n" (date = recorded_at up to 'T') so a chunk embeds —
/// and later reads — with its meeting context attached.
pub fn chunk_meeting(m: &crate::types::Meeting) -> Vec<(String, String)> {
    let date = m.recorded_at.split('T').next().unwrap_or("");
    let prefix = format!("{} ({})\n", m.title, date);

    let mut chunks: Vec<(String, String)> = Vec::new();

    // ---- transcript chunks ----
    let lines: Vec<String> = if !m.transcript_turns.is_empty() {
        m.transcript_turns
            .iter()
            .filter(|t| !t.text.trim().is_empty())
            .map(|t| format!("{}: {}", t.speaker, t.text.trim()))
            .collect()
    } else if !m.transcript.trim().is_empty() {
        m.transcript
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect()
    } else {
        Vec::new()
    };

    if !lines.is_empty() {
        let mut body = String::new();
        for line in &lines {
            let needed = if body.is_empty() {
                line.len()
            } else {
                // +1 for the '\n' separator
                body.len() + 1 + line.len()
            };
            if needed > CHUNK_TARGET_CHARS && !body.is_empty() {
                chunks.push(("transcript".to_string(), format!("{prefix}{body}")));
                body.clear();
            }
            // If this line alone is longer than the cap, hard-split it on char
            // boundaries (transcripts contain Arabic; never slice bytes).
            if line.len() > CHUNK_TARGET_CHARS {
                // Flush any partial body first.
                if !body.is_empty() {
                    chunks.push(("transcript".to_string(), format!("{prefix}{body}")));
                    body.clear();
                }
                for piece in line
                    .chars()
                    .collect::<Vec<char>>()
                    .chunks(CHUNK_TARGET_CHARS)
                {
                    let s: String = piece.iter().collect();
                    chunks.push(("transcript".to_string(), format!("{prefix}{s}")));
                }
            } else if body.is_empty() {
                body.push_str(line);
            } else {
                body.push('\n');
                body.push_str(line);
            }
        }
        if !body.is_empty() {
            chunks.push(("transcript".to_string(), format!("{prefix}{body}")));
        }
    }

    // ---- summary chunks ----
    if !m.summary.trim().is_empty() {
        let mut body = String::new();
        for line in m.summary.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // A section heading also flushes the current body first.
            let is_heading = trimmed.starts_with("**") || trimmed.starts_with("## ");
            if is_heading && !body.is_empty() {
                chunks.push(("summary".to_string(), format!("{prefix}{body}")));
                body.clear();
            }
            let needed = if body.is_empty() {
                trimmed.len()
            } else {
                body.len() + 1 + trimmed.len()
            };
            if needed > CHUNK_TARGET_CHARS && !body.is_empty() {
                chunks.push(("summary".to_string(), format!("{prefix}{body}")));
                body.clear();
            }
            if trimmed.len() > CHUNK_TARGET_CHARS {
                if !body.is_empty() {
                    chunks.push(("summary".to_string(), format!("{prefix}{body}")));
                    body.clear();
                }
                for piece in trimmed
                    .chars()
                    .collect::<Vec<char>>()
                    .chunks(CHUNK_TARGET_CHARS)
                {
                    let s: String = piece.iter().collect();
                    chunks.push(("summary".to_string(), format!("{prefix}{s}")));
                }
            } else if body.is_empty() {
                body.push_str(trimmed);
            } else {
                body.push('\n');
                body.push_str(trimmed);
            }
        }
        if !body.is_empty() {
            chunks.push(("summary".to_string(), format!("{prefix}{body}")));
        }
    }

    chunks
}

/// Concurrency guard: only one sync runs at a time.
static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

/// RAII guard that releases SYNC_RUNNING on drop so every return path clears it.
struct SyncGuard;

impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Bring the chunk index up to date with the meeting store. Returns how many
/// meetings were (re)indexed. Runs at most once concurrently — a second
/// caller gets Ok(0) immediately. An Err means the embed service was
/// unreachable or the model isn't pulled; callers log and move on (the next
/// trigger retries).
pub async fn sync_index(client: &crate::http_client::HttpClient) -> Result<usize, String> {
    if SYNC_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(0);
    }
    let _guard = SyncGuard;

    let meetings = crate::storage::get_meetings().map_err(|e| format!("{e}"))?;
    if meetings.is_empty() {
        return Ok(0);
    }

    let state = crate::storage::get_chunk_index_state().map_err(|e| format!("{e}"))?;

    // Model probe: one tiny call that both confirms the vector layer is up and
    // identifies the active embedding model (so an EMBED_MODEL switch
    // re-indexes everything).
    let (_, current_model) = client.embed(&["probe".to_string()]).await?;

    let mut count = 0usize;

    for m in &meetings {
        let fp = fingerprint(m);
        let stale = match state.get(&m.id) {
            None => true,
            Some((stored_fp, stored_model)) => stored_fp != &fp || stored_model != &current_model,
        };
        if !stale {
            continue;
        }

        let chunks = chunk_meeting(m);
        if chunks.is_empty() {
            crate::storage::replace_meeting_chunks(m.id, &[], &current_model, &fp)
                .map_err(|e| format!("{e}"))?;
            continue;
        }

        let texts: Vec<String> = chunks.iter().map(|(_, t)| t.clone()).collect();
        let mut all_vectors: Vec<Vec<f32>> = Vec::with_capacity(texts.len());

        for batch in texts.chunks(64) {
            let (batch_vecs, _) = client.embed(batch).await?;
            all_vectors.extend(batch_vecs);
        }

        if all_vectors.len() != chunks.len() {
            return Err(format!(
                "Vector count mismatch for meeting {}: expected {}, got {}",
                m.id,
                chunks.len(),
                all_vectors.len()
            ));
        }

        let rows: Vec<(String, String, Vec<f32>)> = chunks
            .into_iter()
            .zip(all_vectors)
            .map(|((kind, text), vec)| (kind, text, vec))
            .collect();

        crate::storage::replace_meeting_chunks(m.id, &rows, &current_model, &fp)
            .map_err(|e| format!("{e}"))?;

        count += 1;
    }

    Ok(count)
}

/// Fire-and-forget index sync against the service at `base_url` (callers pass
/// `state.client.current_base_url()`; the sidecar port is dynamic, so a fresh
/// client per task is the safe way to get a 'static future).
pub fn spawn_sync(base_url: String) {
    tauri::async_runtime::spawn(async move {
        let client = crate::http_client::HttpClient::new(base_url);
        match sync_index(&client).await {
            Ok(0) => {}
            Ok(n) => eprintln!("[embeddings] indexed {n} meeting(s)"),
            Err(e) => eprintln!("[embeddings] sync skipped: {e}"),
        }
    });
}

/// RRF constant (standard k=60).
const RRF_K: f64 = 60.0;

/// Cosine similarity; -1.0 for mismatched lengths or zero-norm vectors.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return -1.0;
    }
    let (dot, na, nb) =
        a.iter()
            .zip(b.iter())
            .fold((0.0f64, 0.0f64, 0.0f64), |(d, na, nb), (x, y)| {
                (
                    d + (*x as f64) * (*y as f64),
                    na + (*x as f64) * (*x as f64),
                    nb + (*y as f64) * (*y as f64),
                )
            });
    if na == 0.0 || nb == 0.0 {
        return -1.0;
    }
    (dot / (na.sqrt() * nb.sqrt())) as f32
}

/// Semantic hits for a query vector against the chunk index.
pub struct VectorHits {
    /// Meeting ids ranked by their best chunk's cosine (chunks below 0.30
    /// are ignored), best first.
    pub meeting_ranks: Vec<i64>,
    /// Up to 3 best chunk texts per meeting (cosine >= 0.30), best first.
    pub chunks_by_meeting: std::collections::HashMap<i64, Vec<String>>,
}

/// Rank meetings by semantic chunk similarity. Pure — testable with synthetic
/// vectors. Considers only the `top_chunks` best chunks overall. Chunks whose
/// cosine is below 0.30 are excluded from both meeting ranks and chunk texts.
pub fn vector_search(
    chunks: &[crate::types::ChunkRow],
    query: &[f32],
    top_chunks: usize,
) -> VectorHits {
    let mut scored: Vec<(usize, f32)> = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| (i, cosine(&c.embedding, query)))
        .collect();

    // Sort descending by cosine; NaN → smallest.
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Less));

    scored.truncate(top_chunks);

    let mut meeting_ranks: Vec<i64> = Vec::new();
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut chunks_by_meeting: std::collections::HashMap<i64, Vec<String>> =
        std::collections::HashMap::new();

    for (idx, score) in &scored {
        if *score < 0.30 {
            continue;
        }
        let chunk = &chunks[*idx];
        if seen.insert(chunk.meeting_id) {
            meeting_ranks.push(chunk.meeting_id);
        }
        let entry = chunks_by_meeting.entry(chunk.meeting_id).or_default();
        if entry.len() < 3 {
            entry.push(chunk.text.clone());
        }
    }

    VectorHits {
        meeting_ranks,
        chunks_by_meeting,
    }
}

/// Meetings anchored by the question through the metadata graph: an attendee
/// name or tag label appearing as a whole word in the question. Returns ids in
/// `meetings` order (pinned/newest first), capped at 15.
pub fn graph_anchor_meetings(meetings: &[crate::types::Meeting], question: &str) -> Vec<i64> {
    let q_tokens: std::collections::HashSet<String> = question
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3)
        .map(|w| w.to_string())
        .collect();

    if q_tokens.is_empty() {
        return Vec::new();
    }

    let stoplist: std::collections::HashSet<&str> =
        ["meeting", "meetings", "note", "notes", "general"]
            .iter()
            .copied()
            .collect();

    meetings
        .iter()
        .filter(|m| {
            // Attendee match: canonical = part before " — " if present.
            let attendee_hit = m.attendees.iter().any(|a| {
                let canonical = if let Some(pos) = a.find(" — ") {
                    a[..pos].trim().to_lowercase()
                } else {
                    a.trim().to_lowercase()
                };
                if canonical == "me" || canonical == "them" || canonical.starts_with("speaker") {
                    return false;
                }
                canonical
                    .split_whitespace()
                    .filter(|t| t.chars().count() >= 3)
                    .any(|t| q_tokens.contains(t))
            });

            if attendee_hit {
                return true;
            }

            // Tag match: every 3+-char token of a non-stoplisted label in q_tokens.
            m.tags.iter().any(|tag| {
                let label = tag.label.to_lowercase();
                if stoplist.contains(label.as_str()) {
                    return false;
                }
                let tokens: Vec<&str> = label
                    .split_whitespace()
                    .filter(|t| t.chars().count() >= 3)
                    .collect();
                if tokens.is_empty() {
                    return false;
                }
                tokens.iter().all(|t| q_tokens.contains(*t))
            })
        })
        .take(15)
        .map(|m| m.id)
        .collect()
}

/// Reciprocal-rank fusion over weighted ranked id lists:
/// score(id) = sum over lists of weight / (RRF_K + rank). Deterministic —
/// ties break toward the higher id (newer meeting). Returns the top `k`.
pub fn rrf_fuse(lists: &[(&[i64], f64)], k: usize) -> Vec<i64> {
    let mut scores: std::collections::HashMap<i64, f64> = std::collections::HashMap::new();
    for (ids, weight) in lists {
        for (rank, id) in ids.iter().enumerate() {
            *scores.entry(*id).or_default() += weight / (RRF_K + rank as f64);
        }
    }
    let mut scored: Vec<(i64, f64)> = scores.into_iter().collect();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Less)
            .then_with(|| b.0.cmp(&a.0))
    });
    scored.truncate(k);
    scored.into_iter().map(|(id, _)| id).collect()
}

/// Hybrid ranking for an Ask query: FTS (weight 1.0) + semantic vectors
/// (weight 1.0) + graph anchors (weight 1.5), RRF-fused. Also returns the best
/// chunk texts per meeting for detail-context stuffing.
pub async fn hybrid_rank(
    client: &crate::http_client::HttpClient,
    meetings: &[crate::types::Meeting],
    q: &str,
    k: usize,
) -> (Vec<i64>, std::collections::HashMap<i64, Vec<String>>) {
    let fts = crate::storage::search_meeting_ids(q, 15).unwrap_or_default();
    let anchors = graph_anchor_meetings(meetings, q);

    let vector = match client.embed(&[q.to_string()]).await {
        Ok((vecs, model)) if !vecs.is_empty() => {
            let chunks = crate::storage::get_chunks_for_model(&model).unwrap_or_default();
            vector_search(&chunks, &vecs[0], 30)
        }
        _ => VectorHits {
            meeting_ranks: Vec::new(),
            chunks_by_meeting: std::collections::HashMap::new(),
        },
    };

    let fused = rrf_fuse(
        &[
            (&fts[..], 1.0),
            (&vector.meeting_ranks[..], 1.0),
            (&anchors[..], 1.5),
        ],
        k,
    );

    (fused, vector.chunks_by_meeting)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Meeting, TranscriptTurn};

    fn mk_meeting(
        title: &str,
        transcript: &str,
        summary: &str,
        turns: Vec<TranscriptTurn>,
    ) -> Meeting {
        Meeting {
            id: 0,
            title: title.to_string(),
            recorded_at: "2026-07-09T14:00:00Z".to_string(),
            duration_seconds: 0.0,
            transcript: transcript.to_string(),
            summary: summary.to_string(),
            template_used: "general".to_string(),
            audio_file_path: None,
            attendees: vec![],
            user_notes: String::new(),
            link: String::new(),
            tags: vec![],
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: turns,
        }
    }

    #[test]
    fn many_turns_produces_multiple_transcript_chunks() {
        // 60 turns of ~80 chars each → ≥ 2 transcript chunks, all starting with
        // the title prefix, first chunk contains the first turn's text.
        let turns: Vec<TranscriptTurn> = (0..60)
            .map(|i| TranscriptTurn {
                speaker: if i % 2 == 0 {
                    "Me".to_string()
                } else {
                    "Them".to_string()
                },
                text: format!(
                    "Turn number {i}: some text to pad the line so it is roughly eighty characters long."
                ),
                start: None,
                end: None,
            })
            .collect();
        let m = mk_meeting("Standup", "", "", turns);
        let chunks = chunk_meeting(&m);
        let transcript_chunks: Vec<_> = chunks.iter().filter(|(k, _)| k == "transcript").collect();
        assert!(
            transcript_chunks.len() >= 2,
            "expected ≥ 2 transcript chunks, got {}",
            transcript_chunks.len()
        );
        for (_, text) in &transcript_chunks {
            assert!(
                text.starts_with("Standup (2026-07-09)\n"),
                "chunk missing prefix: {:?}",
                &text[..50.min(text.len())]
            );
            assert!(
                text.len() <= CHUNK_TARGET_CHARS + "Standup (2026-07-09)\n".len() + 100,
                "chunk too large: {} chars",
                text.len()
            );
        }
        assert!(
            transcript_chunks[0].1.contains("Turn number 0"),
            "first chunk should contain first turn"
        );
    }

    #[test]
    fn flat_transcript_without_turns() {
        // Turn-less meeting with a flat multi-line transcript → transcript chunks
        // produced from lines.
        let lines: Vec<String> = (0..40)
            .map(|i| format!("Line {i}: some content to fill space in the transcript buffer for chunking purposes."))
            .collect();
        let transcript = lines.join("\n");
        let m = mk_meeting("Notes", &transcript, "", vec![]);
        let chunks = chunk_meeting(&m);
        let transcript_chunks: Vec<_> = chunks.iter().filter(|(k, _)| k == "transcript").collect();
        assert!(
            transcript_chunks.len() >= 2,
            "expected ≥ 2 transcript chunks from flat transcript, got {}",
            transcript_chunks.len()
        );
        for (_, text) in &transcript_chunks {
            assert!(text.starts_with("Notes (2026-07-09)\n"));
        }
    }

    #[test]
    fn summary_heading_flush_rule() {
        // Two **Heading** sections whose combined size < the cap → still 2 summary
        // chunks (heading flush rule).
        let summary =
            "**Decisions**\n- We decided to use Rust.\n**Action Items**\n- Hamza: Write the code.";
        let m = mk_meeting("Sync", "", summary, vec![]);
        let chunks = chunk_meeting(&m);
        let summary_chunks: Vec<_> = chunks.iter().filter(|(k, _)| k == "summary").collect();
        assert_eq!(
            summary_chunks.len(),
            2,
            "heading flush should produce 2 summary chunks, got {:?}",
            summary_chunks
        );
    }

    #[test]
    fn long_single_line_hard_split() {
        // A single 4000-char line (no newlines) → hard-split into 3 chunks on char
        // boundaries — includes Arabic to prove no byte-slicing panic.
        let arabic = "مرحبا بالعالم هذا نص عربي طويل للتأكد من أن التقسيم يعمل بشكل صحيح مع النصوص متعددة اللغات.";
        let mut line = String::new();
        while line.chars().count() < 4000 {
            line.push_str(arabic);
        }
        let m = mk_meeting("Test", &line, "", vec![]);
        let chunks = chunk_meeting(&m);
        assert!(
            chunks.len() >= 3,
            "expected ≥ 3 chunks from 4000-char line, got {}",
            chunks.len()
        );
        for (_, text) in &chunks {
            // Every chunk should be valid UTF-8 (no byte-slicing panic already
            // proves it, but verify the text is intact).
            assert!(!text.is_empty());
            assert!(text.starts_with("Test (2026-07-09)\n"));
        }
    }

    #[test]
    fn empty_meeting_produces_empty_chunks() {
        let m = mk_meeting("Empty", "", "", vec![]);
        let chunks = chunk_meeting(&m);
        assert!(chunks.is_empty());
    }

    #[test]
    fn fingerprint_changes_when_summary_changes() {
        let m1 = mk_meeting("A", "transcript", "summary one", vec![]);
        let m2 = mk_meeting("A", "transcript", "summary changed", vec![]);
        assert_ne!(fingerprint(&m1), fingerprint(&m2));
    }

    #[test]
    fn fingerprint_stable_when_unchanged() {
        let m1 = mk_meeting("A", "transcript", "summary", vec![]);
        let m2 = mk_meeting("A", "transcript", "summary", vec![]);
        assert_eq!(fingerprint(&m1), fingerprint(&m2));
    }

    // ---- helpers for hybrid-retrieval tests ----

    fn mk_meeting_full(
        id: i64,
        title: &str,
        attendees: Vec<String>,
        tags: Vec<crate::types::Tag>,
    ) -> Meeting {
        Meeting {
            id,
            title: title.to_string(),
            recorded_at: "2026-07-09T14:00:00Z".to_string(),
            duration_seconds: 0.0,
            transcript: String::new(),
            summary: String::new(),
            template_used: "general".to_string(),
            audio_file_path: None,
            attendees,
            user_notes: String::new(),
            link: String::new(),
            tags,
            pinned: false,
            locked: false,
            archived: false,
            transcript_turns: vec![],
        }
    }

    // ---- cosine ----

    #[test]
    fn cosine_identical_vectors() {
        let v = vec![1.0f32, 2.0, 3.0];
        let s = cosine(&v, &v);
        assert!((s - 1.0).abs() < 1e-6, "expected ~1.0, got {s}");
    }

    #[test]
    fn cosine_orthogonal() {
        let a = vec![1.0f32, 0.0];
        let b = vec![0.0f32, 1.0];
        let s = cosine(&a, &b);
        assert!(s.abs() < 1e-6, "expected ~0.0, got {s}");
    }

    #[test]
    fn cosine_mismatched_lengths() {
        assert_eq!(cosine(&[1.0f32], &[1.0f32, 2.0]), -1.0);
    }

    #[test]
    fn cosine_zero_vector() {
        assert_eq!(cosine(&[0.0f32, 0.0], &[1.0f32, 0.0]), -1.0);
        assert_eq!(cosine(&[1.0f32, 0.0], &[0.0f32, 0.0]), -1.0);
    }

    // ---- rrf_fuse ----

    #[test]
    fn rrf_fuse_two_lists_beats_one() {
        // id 42 ranked #1 in two lists; id 99 ranked #1 in only one.
        let a = [42i64, 99];
        let b = [42i64, 88];
        let result = rrf_fuse(&[(&a[..], 1.0), (&b[..], 1.0)], 5);
        assert_eq!(result[0], 42, "id ranked top in both lists should win");
    }

    #[test]
    fn rrf_fuse_weight_dominates() {
        // id 1 at rank 0 (weight 1.5) vs id 2 at rank 0 (weight 1.0).
        let a = [1i64];
        let b = [2i64];
        let result = rrf_fuse(&[(&a[..], 1.5), (&b[..], 1.0)], 5);
        assert_eq!(
            result[0], 1,
            "1.5-weight list should dominate equal-rank 1.0"
        );
    }

    #[test]
    fn rrf_fuse_tie_breaks_toward_higher_id() {
        // Two ids each in one list at rank 0 with same weight → tied score.
        let a = [10i64];
        let b = [20i64];
        let result = rrf_fuse(&[(&a[..], 1.0), (&b[..], 1.0)], 5);
        assert_eq!(result[0], 20, "tie should break toward higher id");
        assert_eq!(result[1], 10);
    }

    #[test]
    fn rrf_fuse_capped_at_k() {
        let a: Vec<i64> = (1..=10).collect();
        let result = rrf_fuse(&[(&a[..], 1.0)], 3);
        assert_eq!(result.len(), 3);
    }

    // ---- graph_anchor_meetings ----

    #[test]
    fn graph_anchor_attendee_basim() {
        let m = mk_meeting_full(1, "Sync", vec!["Basim Al-Rawi — PM".to_string()], vec![]);
        let result = graph_anchor_meetings(&[m], "what did I discuss with basim");
        assert_eq!(result, vec![1]);
    }

    #[test]
    fn graph_anchor_skip_me() {
        let m = mk_meeting_full(1, "Sync", vec!["Me".to_string()], vec![]);
        let result = graph_anchor_meetings(&[m], "what did me and the team decide");
        assert!(result.is_empty(), "Me should never anchor");
    }

    #[test]
    fn graph_anchor_skip_speaker_n() {
        let m = mk_meeting_full(1, "Sync", vec!["Speaker 2".to_string()], vec![]);
        let result = graph_anchor_meetings(&[m], "speaker 2 said something");
        assert!(result.is_empty(), "Speaker 2 should never anchor");
    }

    #[test]
    fn graph_anchor_tag_youtube() {
        let m = mk_meeting_full(
            2,
            "Watch",
            vec![],
            vec![crate::types::Tag {
                label: "YouTube".to_string(),
                color: "red".to_string(),
            }],
        );
        let result = graph_anchor_meetings(&[m], "the youtube video about rust");
        assert_eq!(result, vec![2]);
    }

    #[test]
    fn graph_anchor_skip_stoplisted_tag() {
        let m = mk_meeting_full(
            3,
            "Pricing",
            vec![],
            vec![crate::types::Tag {
                label: "Meeting".to_string(),
                color: "blue".to_string(),
            }],
        );
        let result = graph_anchor_meetings(&[m], "the pricing meeting");
        assert!(
            result.is_empty(),
            "stoplisted tag Meeting should not anchor"
        );
    }

    #[test]
    fn graph_anchor_arabic_name() {
        let m = mk_meeting_full(4, "اجتماع", vec!["باسم الراوي — مدير".to_string()], vec![]);
        let result = graph_anchor_meetings(&[m], "ماذا ناقشت مع باسم الراوي");
        assert_eq!(
            result,
            vec![4],
            "Arabic attendee name should anchor on Arabic question"
        );
    }

    // ---- vector_search ----

    #[test]
    fn vector_search_ranks_and_filters() {
        use crate::types::ChunkRow;

        // meeting 1: chunks near (1,0) — high cosine with query (1,0)
        // meeting 2: chunks near (0,1) — near-zero cosine with query (1,0)
        // meeting 3: chunks near (-1,0) — negative cosine with query (1,0)
        let chunks = vec![
            // meeting 1 — 5 chunks near (1, 0)
            ChunkRow {
                meeting_id: 1,
                kind: "transcript".into(),
                text: "m1-chunk-a".into(),
                embedding: vec![0.95, 0.05],
            },
            ChunkRow {
                meeting_id: 1,
                kind: "transcript".into(),
                text: "m1-chunk-b".into(),
                embedding: vec![0.90, 0.10],
            },
            ChunkRow {
                meeting_id: 1,
                kind: "transcript".into(),
                text: "m1-chunk-c".into(),
                embedding: vec![0.85, -0.05],
            },
            ChunkRow {
                meeting_id: 1,
                kind: "transcript".into(),
                text: "m1-chunk-d".into(),
                embedding: vec![0.80, -0.10],
            },
            ChunkRow {
                meeting_id: 1,
                kind: "transcript".into(),
                text: "m1-chunk-e".into(),
                embedding: vec![0.75, 0.15],
            },
            // meeting 2 — 1 chunk near (0,1)
            ChunkRow {
                meeting_id: 2,
                kind: "transcript".into(),
                text: "m2-chunk-a".into(),
                embedding: vec![0.05, 0.95],
            },
            // meeting 3 — 1 chunk near (-1,0)
            ChunkRow {
                meeting_id: 3,
                kind: "transcript".into(),
                text: "m3-chunk-a".into(),
                embedding: vec![-0.95, 0.05],
            },
        ];

        let query = vec![1.0f32, 0.0];
        let result = vector_search(&chunks, &query, 30);

        // meeting_ranks: meeting 1 first (best cosine), then meeting 2 (~0), meeting 3 last
        assert!(!result.meeting_ranks.is_empty());
        assert_eq!(result.meeting_ranks[0], 1, "meeting 1 should rank first");

        // meeting 3's negative-cosine chunk is excluded from chunks_by_meeting
        assert!(
            !result.chunks_by_meeting.contains_key(&3),
            "meeting 3 negative cosine should be below 0.30 threshold"
        );

        // meeting 1 with 5 high-scoring chunks keeps only 3 texts
        let m1_texts = result.chunks_by_meeting.get(&1).unwrap();
        assert_eq!(
            m1_texts.len(),
            3,
            "meeting 1 should have at most 3 chunk texts, got {}",
            m1_texts.len()
        );
    }

    #[test]
    fn vector_search_respects_top_chunks_cap() {
        use crate::types::ChunkRow;

        let mut chunks: Vec<ChunkRow> = Vec::new();
        for i in 0..20 {
            chunks.push(ChunkRow {
                meeting_id: (i / 5) + 1,
                kind: "transcript".into(),
                text: format!("chunk-{i}"),
                embedding: vec![1.0f32, 0.0],
            });
        }

        let query = vec![1.0f32, 0.0];
        let result = vector_search(&chunks, &query, 5);

        // Only 5 chunks are considered, so at most 5 unique meeting texts collected.
        let total_texts: usize = result.chunks_by_meeting.values().map(|v| v.len()).sum();
        assert!(
            total_texts <= 5,
            "top_chunks=5 should cap total texts, got {total_texts}"
        );
    }
}
