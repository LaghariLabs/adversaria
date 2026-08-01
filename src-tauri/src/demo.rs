//! The seeded sample meeting (Setup V3, Phase B).
//!
//! A brand-new library is never empty: one finished meeting — transcript *and*
//! notes — shows the end product before the user records anything. It is an
//! ordinary meeting row in every respect (deletable, searchable, exportable,
//! no audio), so nothing anywhere else special-cases it.
//!
//! Seeded once, on fresh installs only: both the `demo_meeting_seeded` flag
//! must be unset AND the meetings table must be empty. The flag is set either
//! way, so an existing library is asked about exactly once and never seeded.

use rusqlite::Connection;

use crate::types::{Meeting, Tag};

/// Title of the sample meeting. Stable — the frontend tour may look for it.
pub const DEMO_MEETING_TITLE: &str = "Welcome to Adversaria";

/// A ~2-minute welcome from the founder, in the exact shape a real transcript
/// is stored in: one `Speaker:` labelled turn per line
/// (`storage::parse_transcript_turns` accepts any label). Every claim in the
/// notes below is grounded in a line here, like a real summarization would be.
const DEMO_TRANSCRIPT: &str = "\
Hamza: Welcome to Adversaria — I'm Hamza, the Chief Note Taker. This meeting you're reading was written by Adversaria itself, entirely on this computer, and that's the whole idea: nothing you say in a meeting ever leaves your machine.
Hamza: Here's how you use it. When a meeting starts, hit the record button at the top. Adversaria captures both sides of the call — your microphone and the other participants.
Hamza: When you stop, the transcript and structured notes like these write themselves in the background. You don't type a thing.
Hamza: Every action item agreed in a call lands on the To-dos board automatically. If you connect an AI agent, it can pick one up, do the work, and report back — and only you can mark it done.
Hamza: The Weekly tab writes you a briefing of each week's meetings. Ask answers questions across everything you've ever recorded. Graph connects the people and topics.
Hamza: Two things to set up before your first meeting: your transcription model, and how notes get written. Both live in Settings, under AI Model — your to-dos will walk you through it.
Hamza: That's everything. Delete this meeting whenever you like — it's yours, like everything else here. And if Adversaria saves you time, come tell me: connect with me on LinkedIn.";

/// Notes in the exact markdown the Python summarizer emits: `**Section**`
/// headings, each followed by `- ` bullets, sections separated by a blank line
/// (`summarizer.py` `_render`, parsed by `src/lib/summary.ts` `parseSummary` —
/// which accepts any heading — and by `storage::extract_action_items`, which
/// specifically reads the `Action Items` section; those bullets ARE the
/// getting-started checklist on the To-dos board). No `**Attendees:**` line.
const DEMO_SUMMARY: &str = "\
**Welcome**

- Adversaria is a private meeting notetaker: recording, transcription, and notes all happen on this computer, and nothing is uploaded anywhere.
- These notes were written by Adversaria itself — open the Transcript tab to see what they were written from. Delete this meeting whenever you like.

**How to use Adversaria**

- When a meeting starts, hit the record button at the top — both sides of the call are captured, your microphone and the other participants.
- Stop the recording and the transcript and notes write themselves in the background; you don't type a thing.
- Action items agreed in a call land on the To-dos board automatically. A connected AI agent can work on them and report back — only you can mark them done.
- Weekly writes a briefing of each week's meetings; Ask answers questions across everything you've recorded; Graph connects the people and topics.

**Action Items**

- Me: Download your transcription model in Settings → AI Model.
- Me: Choose how your notes get written — a local model, or your own AI provider.
- Me: Record your first meeting with Adversaria.
- Me: Open the notes it writes, then tick these off on the To-dos board.

**From the Chief Note Taker**

- Thanks for trying Adversaria. If it saves you time — or if it doesn't — I want to hear about it.
- — Mohammad Hamza Laghari, Chief Note Taker. Connect with me on LinkedIn: https://www.linkedin.com/in/mhlaghari/";

/// Seed the sample meeting if this install has never been asked. Returns
/// whether a meeting was actually inserted.
pub fn seed_demo_meeting() -> anyhow::Result<bool> {
    let conn = crate::storage::connect_for_sync()?;
    seed_demo_meeting_on(&conn)
}

/// [`seed_demo_meeting`] on a caller-supplied connection.
fn seed_demo_meeting_on(conn: &Connection) -> anyhow::Result<bool> {
    if crate::storage::demo_meeting_seeded(conn)? {
        return Ok(false);
    }
    // An existing library must never gain a sample meeting. Answer the question
    // for them anyway, so this check runs exactly once per install.
    let fresh = crate::storage::meetings_are_empty(conn)?;
    if fresh {
        let id = crate::storage::insert_meeting_on(conn, &demo_meeting())?;
        // Same path every real meeting takes: the action items come from the
        // notes, so the board and the notes can't disagree.
        crate::storage::sync_action_items(conn, id, DEMO_SUMMARY)?;
    }
    crate::storage::mark_demo_meeting_seeded(conn)?;
    Ok(fresh)
}

/// The sample meeting as an ordinary, fully-processed row: transcript and notes
/// present (nothing for the notes drain), no audio (nothing for the
/// transcription drain).
fn demo_meeting() -> Meeting {
    Meeting {
        id: 0, // assigned by SQLite
        title: DEMO_MEETING_TITLE.to_string(),
        recorded_at: chrono::Utc::now().to_rfc3339(),
        duration_seconds: 132.0,
        transcript: DEMO_TRANSCRIPT.to_string(),
        summary: DEMO_SUMMARY.to_string(),
        template_used: "general".to_string(),
        audio_file_path: None,
        attendees: vec!["Hamza".to_string()],
        user_notes: String::new(),
        link: String::new(),
        // What `commands::category_tag` produces for the "meeting" category.
        tags: vec![Tag {
            label: "Meeting".to_string(),
            color: "blue".to_string(),
        }],
        pinned: false,
        locked: false,
        archived: false,
        transcript_turns: crate::storage::parse_transcript_turns(DEMO_TRANSCRIPT),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live schema for the three tables the seeder touches.
    fn seeded_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meetings (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 title       TEXT    NOT NULL,
                 recorded_at TEXT    NOT NULL,
                 duration_seconds REAL NOT NULL DEFAULT 0,
                 transcript  TEXT    NOT NULL DEFAULT '',
                 summary     TEXT    NOT NULL DEFAULT '',
                 template_used TEXT  NOT NULL DEFAULT 'general',
                 audio_file_path TEXT,
                 attendees   TEXT    NOT NULL DEFAULT '[]',
                 user_notes  TEXT    NOT NULL DEFAULT '',
                 link        TEXT    NOT NULL DEFAULT '',
                 tags        TEXT    NOT NULL DEFAULT '[]',
                 pinned      INTEGER NOT NULL DEFAULT 0,
                 locked      INTEGER NOT NULL DEFAULT 0,
                 archived    INTEGER NOT NULL DEFAULT 0,
                 transcript_turns TEXT NOT NULL DEFAULT '[]'
             );
             CREATE TABLE action_items (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 meeting_id  INTEGER NOT NULL,
                 ord         INTEGER NOT NULL,
                 text        TEXT    NOT NULL,
                 assignee    TEXT    NOT NULL DEFAULT '',
                 due         TEXT    NOT NULL DEFAULT '',
                 done        INTEGER NOT NULL DEFAULT 0,
                 status       TEXT    NOT NULL DEFAULT 'todo',
                 completed_by TEXT    NOT NULL DEFAULT '',
                 completed_at TEXT    NOT NULL DEFAULT '',
                 evidence     TEXT    NOT NULL DEFAULT ''
             );
             CREATE TABLE onboarding_state (
                 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                 schema_version INTEGER NOT NULL,
                 completed_steps TEXT NOT NULL DEFAULT '[]',
                 selected_model_profile TEXT NOT NULL DEFAULT '',
                 setup_complete INTEGER NOT NULL DEFAULT 0,
                 demo_meeting_seeded INTEGER NOT NULL DEFAULT 0,
                 updated_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn
    }

    fn meeting_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM meetings", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn seeds_a_sample_meeting_on_a_fresh_install() {
        let conn = seeded_conn();
        assert!(seed_demo_meeting_on(&conn).unwrap(), "fresh install seeds");
        assert_eq!(meeting_count(&conn), 1);

        let (title, transcript, summary, audio, turns): (
            String,
            String,
            String,
            Option<String>,
            String,
        ) = conn
            .query_row(
                "SELECT title, transcript, summary, audio_file_path, transcript_turns
                 FROM meetings",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(title, DEMO_MEETING_TITLE);
        assert!(!transcript.trim().is_empty(), "transcript must be present");
        assert!(!summary.trim().is_empty(), "notes must be present");
        // No audio: nothing for the transcription drain to pick up, nothing to
        // delete, no missing file to explain.
        assert!(audio.is_none(), "the sample has no recording");
        assert!(turns.contains("\"speaker\":\"Hamza\""), "turns are parsed");
        assert!(
            summary.contains("linkedin.com/in/mhlaghari"),
            "the Chief Note Taker sign-off links out"
        );
        assert!(crate::storage::demo_meeting_seeded(&conn).unwrap());
    }

    #[test]
    fn seeded_meeting_carries_the_getting_started_checklist() {
        let conn = seeded_conn();
        seed_demo_meeting_on(&conn).unwrap();
        let mut stmt = conn
            .prepare("SELECT text, assignee, done, status FROM action_items ORDER BY ord")
            .unwrap();
        let items: Vec<(String, String, bool, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(items.len(), 4, "the four getting-started steps");
        assert_eq!(
            items[0].0,
            "Download your transcription model in Settings → AI Model."
        );
        assert_eq!(
            items[1].0,
            "Choose how your notes get written — a local model, or your own AI provider."
        );
        assert_eq!(items[2].0, "Record your first meeting with Adversaria.");
        assert_eq!(
            items[3].0,
            "Open the notes it writes, then tick these off on the To-dos board."
        );
        assert!(items
            .iter()
            .all(|(_, assignee, done, status)| { assignee == "Me" && !*done && status == "todo" }));
    }

    #[test]
    fn never_seeds_an_existing_library_but_still_answers_the_question() {
        let conn = seeded_conn();
        conn.execute(
            "INSERT INTO meetings (title, recorded_at) VALUES ('Real meeting', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        assert!(
            !seed_demo_meeting_on(&conn).unwrap(),
            "a library with meetings must never gain a sample"
        );
        assert_eq!(meeting_count(&conn), 1, "only the user's own meeting");
        assert!(
            crate::storage::demo_meeting_seeded(&conn).unwrap(),
            "the flag is set anyway, so the check never re-evaluates"
        );
    }

    #[test]
    fn never_seeds_twice() {
        let conn = seeded_conn();
        assert!(seed_demo_meeting_on(&conn).unwrap());
        // Second launch: flag set, so no second sample even though the user has
        // since deleted the first one.
        conn.execute("DELETE FROM meetings", []).unwrap();
        assert!(!seed_demo_meeting_on(&conn).unwrap());
        assert_eq!(meeting_count(&conn), 0, "a deleted sample stays deleted");
    }

    /// The flag is set independently of the rest of the onboarding row, and
    /// `save_onboarding_state` (which doesn't list the column) can't clear it.
    #[test]
    fn the_flag_survives_an_onboarding_state_write() {
        let conn = seeded_conn();
        seed_demo_meeting_on(&conn).unwrap();
        conn.execute(
            "INSERT INTO onboarding_state
                (singleton, schema_version, completed_steps, selected_model_profile,
                 setup_complete, updated_at)
             VALUES (1, 1, '[\"welcome\"]', 'balanced', 1, '2026-01-01T00:00:00Z')
             ON CONFLICT(singleton) DO UPDATE SET
                completed_steps = excluded.completed_steps,
                setup_complete = excluded.setup_complete",
            [],
        )
        .unwrap();
        assert!(crate::storage::demo_meeting_seeded(&conn).unwrap());
    }
}
