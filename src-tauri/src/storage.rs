//! SQLite-backed meeting store.
//!
//! Uses `rusqlite` with a bundled SQLite to persist `Meeting` records.
//! The database lives at `<app-data>/meeting-note-taker/meetings.db`.

use std::path::PathBuf;
use std::sync::OnceLock;

use rusqlite::{params, Connection};

use crate::types::{ActionItem, Meeting, OnboardingState, RegistrationState};

/// Path to the SQLite database file.
fn db_path() -> PathBuf {
    crate::config::app_data_dir().join("meetings.db")
}

// ---------------------------------------------------------------------------
// Encryption at rest (SQLCipher)
//
// The database is encrypted with SQLCipher (rusqlite `bundled-sqlcipher-*`). A
// random 256-bit key is generated on first run and stored in the OS keychain
// (transparent unlock — no user passphrase; see ADR / DECISIONS.md). EVERY
// connection must apply `PRAGMA key` immediately after opening, before any
// other statement — so all opens go through `open_keyed()`. Pre-encryption
// plaintext databases are migrated in place on first launch (`init_db`).
// ---------------------------------------------------------------------------

const DB_KEYRING_SERVICE: &str = "adversaria-db";
const DB_KEYRING_ACCOUNT: &str = "encryption-key";

/// Process-wide cache of the hex key, set once by `init_db` so per-request
/// `connect()` calls don't re-hit the keychain.
static DB_KEY: OnceLock<String> = OnceLock::new();

/// Whether the database is encrypted, set once by `init_db` from `config.encrypt_db`.
/// Per-request `connect()` reads this to decide whether to apply the key. Defaults
/// to encrypted if `init_db` hasn't run yet (the safe assumption).
static DB_ENCRYPTED: OnceLock<bool> = OnceLock::new();

fn db_encrypted() -> bool {
    *DB_ENCRYPTED.get().unwrap_or(&true)
}

/// 32 random bytes as a 64-char lowercase hex string (a SQLCipher raw key).
fn random_key_hex() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Get the DB key from the OS keychain, generating + storing one on first run.
/// CRITICAL: only a *missing* entry mints a new key — any other keychain error
/// is propagated rather than silently generating a new key, which would make an
/// existing encrypted database permanently unreadable.
fn get_or_create_db_key() -> anyhow::Result<String> {
    let entry = keyring::Entry::new(DB_KEYRING_SERVICE, DB_KEYRING_ACCOUNT)?;
    match entry.get_password() {
        Ok(k) if k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(k),
        Ok(_) => anyhow::bail!(
            "Stored database key is malformed; refusing to overwrite it (that would \
             orphan the encrypted database). Inspect the '{DB_KEYRING_SERVICE}' keychain entry."
        ),
        Err(keyring::Error::NoEntry) => {
            let key = random_key_hex();
            entry.set_password(&key)?;
            Ok(key)
        }
        Err(e) => Err(anyhow::anyhow!("keychain unavailable: {e}")),
    }
}

/// The cached key, or fetch + cache it (covers any `connect()` before `init_db`).
fn db_key() -> rusqlite::Result<String> {
    if let Some(k) = DB_KEY.get() {
        return Ok(k.clone());
    }
    let k = get_or_create_db_key().map_err(|e| {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_AUTH),
            Some(format!("database key unavailable: {e}")),
        )
    })?;
    let _ = DB_KEY.set(k.clone());
    Ok(k)
}

/// Apply `PRAGMA key` to a freshly opened connection. The key is our own 64-char
/// hex (not user input), so interpolating the `x'…'` literal is safe.
fn apply_key(conn: &Connection) -> rusqlite::Result<()> {
    let key = db_key()?;
    conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))?;
    Ok(())
}

/// Open the database, applying the encryption key when encryption is enabled.
/// Use this everywhere instead of `Connection::open(db_path())`. When encryption
/// is off (`config.encrypt_db = false`) the DB is plaintext and no key is applied.
fn open_keyed() -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path())?;
    // Every storage fn opens its own connection, and the background
    // transcription queue writes concurrently with UI reads/writes. Without a
    // busy timeout the loser of any race fails INSTANTLY with "database is
    // locked" (rusqlite default is 0 ms) — wait instead of erroring.
    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    if db_encrypted() {
        apply_key(&conn)?;
    }
    Ok(conn)
}

/// Migrate a pre-encryption plaintext `meetings.db` to SQLCipher, in place, once.
/// No-op on a fresh install (no file) or an already-encrypted DB. Backs the
/// plaintext up and verifies row counts before swapping — on any mismatch it
/// bails WITHOUT touching the original, so no data is lost.
/// Row count for `table`, or 0 when the table does not exist.
///
/// The encryption migrations below run **before** `init_db` creates the schema,
/// so they see whatever schema the database already had. A database written by a
/// build that predates a table simply has no such table — and since
/// `sqlcipher_export` copies the schema it finds, absent-on-both-sides is a
/// legitimate match, not a failed copy.
///
/// Treating a missing table as an error made the app refuse to start with
/// `no such table: action_items` for anyone upgrading from a build older than
/// that table (e.g. the 0.2.x Windows line, whose `meetings.db` has only
/// `meetings`), and the message then blamed the macOS keychain.
fn table_count(conn: &Connection, table: &str) -> rusqlite::Result<i64> {
    let exists: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |r| r.get(0),
    )?;
    if exists == 0 {
        return Ok(0);
    }
    // `table` is a hardcoded literal at every call site, never user input.
    conn.query_row(&format!("SELECT count(*) FROM \"{table}\""), [], |r| {
        r.get(0)
    })
}

fn migrate_plaintext_to_encrypted(path: &std::path::Path, key: &str) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(()); // fresh install — open_keyed() creates an encrypted DB
    }
    // SQLCipher with no `PRAGMA key` behaves as plain SQLite, so a readable
    // sqlite_master means the file is still plaintext and needs migrating.
    let is_plaintext = {
        let probe = Connection::open(path)?;
        probe
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| {
                r.get::<_, i64>(0)
            })
            .is_ok()
    };
    if !is_plaintext {
        return Ok(()); // already encrypted
    }

    let dir = path.parent().expect("db path has a parent");
    let backup = dir.join("meetings.db.pre-encrypt-backup");
    let enc = dir.join("meetings.db.encrypting");

    eprintln!(
        "[storage] encrypting plaintext meetings.db (SQLCipher); plaintext backup → {}",
        backup.display()
    );
    std::fs::copy(path, &backup)?;
    let _ = std::fs::remove_file(&enc);

    // Count rows per table in the plaintext source so we can verify the copy.
    let counts = |conn: &Connection| -> rusqlite::Result<(i64, i64, i64)> {
        Ok((
            table_count(conn, "meetings")?,
            table_count(conn, "action_items")?,
            table_count(conn, "chat_messages")?,
        ))
    };

    let src = {
        let conn = Connection::open(path)?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);"); // flatten any WAL
        let src = counts(&conn)?;
        let enc_lit = enc.to_string_lossy().replace('\'', "''");
        conn.execute_batch(&format!(
            "ATTACH DATABASE '{enc_lit}' AS encrypted KEY \"x'{key}'\";\
             SELECT sqlcipher_export('encrypted');\
             DETACH DATABASE encrypted;"
        ))?;
        src
    };

    // Verify the encrypted copy opens with the key and preserved every table.
    {
        let vconn = Connection::open(&enc)?;
        vconn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))?;
        let dst = counts(&vconn)?;
        if dst != src {
            anyhow::bail!(
                "encryption verify failed (meetings/actions/chats {src:?} → {dst:?}); \
                 left the plaintext DB in place, backup at {}",
                backup.display()
            );
        }
    }

    // Swap the encrypted file into place; drop stale plaintext WAL/SHM sidecars.
    std::fs::rename(&enc, path)?;
    let _ = std::fs::remove_file(dir.join("meetings.db-wal"));
    let _ = std::fs::remove_file(dir.join("meetings.db-shm"));
    eprintln!(
        "[storage] meetings.db encrypted ({} meetings preserved). Plaintext backup kept at {} — \
         delete it once you've confirmed your notes look right.",
        src.0,
        backup.display()
    );
    Ok(())
}

/// Migrate an encrypted SQLCipher `meetings.db` back to plaintext, in place, once
/// (the reverse of `migrate_plaintext_to_encrypted`, used when the user turns
/// encryption off). No-op on a fresh install or an already-plaintext DB. Backs the
/// encrypted file up and verifies row counts before swapping — on any mismatch it
/// bails WITHOUT touching the original, so no data is lost. The caller removes the
/// keychain key afterwards (see `init_db`).
fn migrate_encrypted_to_plaintext(path: &std::path::Path, key: &str) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(()); // fresh install — open() will create a plaintext DB
    }
    // A readable sqlite_master with no key means the file is already plaintext.
    let is_plaintext = {
        let probe = Connection::open(path)?;
        probe
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| {
                r.get::<_, i64>(0)
            })
            .is_ok()
    };
    if is_plaintext {
        return Ok(()); // already plaintext — key unused, nothing to do
    }

    let dir = path.parent().expect("db path has a parent");
    let backup = dir.join("meetings.db.pre-decrypt-backup");
    let plain = dir.join("meetings.db.decrypting");

    eprintln!(
        "[storage] decrypting meetings.db to plaintext; encrypted backup → {}",
        backup.display()
    );
    std::fs::copy(path, &backup)?;
    let _ = std::fs::remove_file(&plain);

    let counts = |conn: &Connection| -> rusqlite::Result<(i64, i64, i64)> {
        Ok((
            table_count(conn, "meetings")?,
            table_count(conn, "action_items")?,
            table_count(conn, "chat_messages")?,
        ))
    };

    // Open the encrypted source with the key, export to a `KEY ''` (plaintext) DB.
    let src = {
        let conn = Connection::open(path)?;
        conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        let src = counts(&conn)?;
        let plain_lit = plain.to_string_lossy().replace('\'', "''");
        conn.execute_batch(&format!(
            "ATTACH DATABASE '{plain_lit}' AS plaintext KEY '';\
             SELECT sqlcipher_export('plaintext');\
             DETACH DATABASE plaintext;"
        ))?;
        src
    };

    // Verify the plaintext copy opens WITHOUT a key and preserved every table.
    {
        let vconn = Connection::open(&plain)?;
        let dst = counts(&vconn)?;
        if dst != src {
            anyhow::bail!(
                "decryption verify failed (meetings/actions/chats {src:?} → {dst:?}); \
                 left the encrypted DB in place, backup at {}",
                backup.display()
            );
        }
    }

    // Swap the plaintext file into place; drop stale encrypted WAL/SHM sidecars.
    std::fs::rename(&plain, path)?;
    let _ = std::fs::remove_file(dir.join("meetings.db-wal"));
    let _ = std::fs::remove_file(dir.join("meetings.db-shm"));
    eprintln!(
        "[storage] meetings.db decrypted ({} meetings preserved). Encrypted backup \
         kept at {}.",
        src.0,
        backup.display()
    );
    Ok(())
}

/// The existing DB key from the keychain, or None if there's no entry. Unlike
/// `get_or_create_db_key`, this NEVER mints a new key — used by the decrypt path,
/// where a fresh key could not open the existing encrypted DB. A malformed entry
/// or keychain error is propagated.
fn read_existing_db_key() -> anyhow::Result<Option<String>> {
    match keyring::Entry::new(DB_KEYRING_SERVICE, DB_KEYRING_ACCOUNT)?.get_password() {
        Ok(k) if k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(Some(k)),
        Ok(_) => anyhow::bail!("stored database key is malformed; refusing to use it"),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow::anyhow!("keychain unavailable: {e}")),
    }
}

/// Delete the DB encryption key from the keychain (idempotent). Called after a
/// verified decrypt so the macOS keychain-password prompt stops.
fn delete_db_key() {
    if let Ok(entry) = keyring::Entry::new(DB_KEYRING_SERVICE, DB_KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

/// Ensure the database directory and schema exist. `encrypt` (from
/// `config.encrypt_db`) decides whether the DB is kept encrypted at rest: when
/// true, the key is fetched/created and any plaintext DB is migrated to SQLCipher;
/// when false, any encrypted DB is decrypted to plaintext and the key removed.
pub fn init_db(encrypt: bool) -> anyhow::Result<()> {
    let parent = db_path()
        .parent()
        .expect("db_path has no parent")
        .to_path_buf();
    std::fs::create_dir_all(&parent)?;

    // Record the encryption mode for per-request connect(), then bring the DB into
    // that state. Encrypted: get/create the key (cached for connect()) and migrate
    // any plaintext DB to SQLCipher. Plaintext: decrypt any encrypted DB and drop
    // the key. Either migration is a verified, backed-up, idempotent no-op when the
    // DB is already in the target state.
    let _ = DB_ENCRYPTED.set(encrypt);
    if encrypt {
        let key = get_or_create_db_key()?;
        let _ = DB_KEY.set(key.clone());
        migrate_plaintext_to_encrypted(&db_path(), &key)?;
    } else if let Some(key) = read_existing_db_key()? {
        // A key exists → the DB may be encrypted. Decrypt with it (no-op if the DB
        // is already plaintext), then drop the key so the keychain prompt stops.
        // No key means the DB is already plaintext (we remove the key only after a
        // verified decrypt), so there's nothing to do.
        migrate_encrypted_to_plaintext(&db_path(), &key)?;
        delete_db_key();
    }

    let conn = open_keyed()?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meetings (
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
            archived    INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id  INTEGER NOT NULL,
            role        TEXT    NOT NULL,
            content     TEXT    NOT NULL,
            created_at  TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS action_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id  INTEGER NOT NULL,
            ord         INTEGER NOT NULL,
            text        TEXT    NOT NULL,
            assignee    TEXT    NOT NULL DEFAULT '',
            due         TEXT    NOT NULL DEFAULT '',
            done        INTEGER NOT NULL DEFAULT 0,
            -- Agent workflow. done stays the boolean every existing query
            -- uses; status is the richer state an agent moves through, and
            -- ai_done is deliberately NOT done: work an agent claims to have
            -- finished waits for the user to accept it.
            status       TEXT    NOT NULL DEFAULT 'todo',
            completed_by TEXT    NOT NULL DEFAULT '',
            completed_at TEXT    NOT NULL DEFAULT '',
            evidence     TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON action_items(meeting_id);
        CREATE TABLE IF NOT EXISTS ask_messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            role        TEXT    NOT NULL,
            content     TEXT    NOT NULL,
            sources     TEXT    NOT NULL DEFAULT '[]',
            intent      TEXT    NOT NULL DEFAULT '',
            created_at  TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meeting_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB NOT NULL,
            dim INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_chunks_meeting ON meeting_chunks(meeting_id);
        CREATE TABLE IF NOT EXISTS chunk_index_state (
            meeting_id INTEGER PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            model TEXT NOT NULL,
            indexed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            role TEXT NOT NULL DEFAULT '',
            company TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            aliases TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            linkedin TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS recording_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id INTEGER,
            session_id TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            format_version INTEGER NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('capturing', 'pending', 'processing', 'cleanup_pending')),
            channel_metadata TEXT NOT NULL DEFAULT '{}',
            last_committed_chunk INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registration_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            schema_version INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('unregistered', 'pending', 'submitted')),
            name TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            consent_version TEXT NOT NULL DEFAULT '',
            consent_timestamp TEXT,
            source TEXT NOT NULL,
            app_version TEXT NOT NULL,
            platform TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_retry_at TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS onboarding_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            schema_version INTEGER NOT NULL,
            completed_steps TEXT NOT NULL DEFAULT '[]',
            selected_model_profile TEXT NOT NULL DEFAULT '',
            setup_complete INTEGER NOT NULL DEFAULT 0,
            demo_meeting_seeded INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );",
    )?;

    // Migration: add `intent` (provenance badge) to ask_messages tables created
    // before it existed.
    if !column_exists(&conn, "ask_messages", "intent")? {
        conn.execute(
            "ALTER TABLE ask_messages ADD COLUMN intent TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }

    // Migration: the one-shot demo-meeting flag on onboarding_state tables
    // created before it existed. Existing installs start at 0 and are then
    // resolved to 1 by the first seed check — which skips them, because their
    // meetings table is not empty.
    if !column_exists(&conn, "onboarding_state", "demo_meeting_seeded")? {
        conn.execute(
            "ALTER TABLE onboarding_state ADD COLUMN demo_meeting_seeded INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    // Migration: agent workflow columns on action_items. Existing rows keep
    // their boolean `done`; status is derived from it once so a long-standing
    // board doesn't reset to "todo" on upgrade.
    if !column_exists(&conn, "action_items", "status")? {
        conn.execute(
            "ALTER TABLE action_items ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'",
            [],
        )?;
        conn.execute(
            "ALTER TABLE action_items ADD COLUMN completed_by TEXT NOT NULL DEFAULT ''",
            [],
        )?;
        conn.execute(
            "ALTER TABLE action_items ADD COLUMN completed_at TEXT NOT NULL DEFAULT ''",
            [],
        )?;
        conn.execute(
            "ALTER TABLE action_items ADD COLUMN evidence TEXT NOT NULL DEFAULT ''",
            [],
        )?;
        conn.execute(
            "UPDATE action_items SET status = 'done', completed_by = 'you' WHERE done = 1",
            [],
        )?;
    }

    // Migration: add `attendees` to databases created before it existed.
    // ALTER TABLE errors if the column already exists, so ignore that error.
    if !column_exists(&conn, "meetings", "attendees")? {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    if !column_exists(&conn, "meetings", "user_notes")? {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN user_notes TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(&conn, "meetings", "link")? {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN link TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(&conn, "meetings", "tags")? {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    if !column_exists(&conn, "meetings", "pinned")? {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !column_exists(&conn, "meetings", "locked")? {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN locked INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !column_exists(&conn, "meetings", "archived")? {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !column_exists(&conn, "meetings", "transcript_turns")? {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN transcript_turns TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    // Migration: contact details on `people`, added when profiles grew CRM fields.
    for column in ["email", "phone", "linkedin"] {
        if !column_exists(&conn, "people", column)? {
            conn.execute(
                &format!("ALTER TABLE people ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"),
                [],
            )?;
        }
    }

    // PROACTIVELY repair/migrate the FTS index BEFORE any UPDATE fires its triggers.
    // The external-content index can fall out of sync (a different SQLite version, a
    // partial write); the keep-in-sync triggers then raise SQLITE_CORRUPT_VTAB on the
    // NEXT `UPDATE meetings` — which broke pin/lock/delete/tags, not just startup
    // (the old self-heal below only triggered when a backfill actually ran, so an
    // already-backfilled DB was never repaired). FTS5 `integrity-check` does NOT
    // detect this. So we always rebuild the index from content here + drop the
    // triggers so setup_fts recreates them with the current (narrower) definition.
    repair_fts(&conn);

    // Run the startup backfills. Both `UPDATE meetings`; if the FTS index were still
    // somehow corrupt the triggers would raise SQLITE_CORRUPT_VTAB — recover by
    // dropping the (derived) index + triggers and retrying. setup_fts rebuilds it.
    if let Err(e) = run_startup_backfills(&conn) {
        if is_db_corruption(&e) {
            eprintln!("[storage] FTS5 index corrupt; dropping it for a clean rebuild and retrying");
            drop_fts(&conn);
            run_startup_backfills(&conn)?;
        } else {
            return Err(e);
        }
    }

    // Full-text search index (best-effort: ignored if this SQLite lacks FTS5).
    if let Err(e) = setup_fts(&conn) {
        eprintln!("Warning: FTS5 index unavailable, search falls back to keyword: {e}");
    }
    Ok(())
}

/// The idempotent startup backfills, in order. Separated so [`init_db`] can retry
/// them after repairing a corrupt FTS index (see its call site).
fn run_startup_backfills(conn: &Connection) -> anyhow::Result<()> {
    // transcript_turns: parse the flat transcript into structured turns for rows
    // still empty. action_items: extract action items for meetings that have none.
    backfill_transcript_turns(conn)?;
    backfill_action_items(conn)?;
    Ok(())
}

/// Drop the FTS5 index + its keep-in-sync triggers. The index is derived data
/// (rebuilt from `meetings` by [`setup_fts`]), so this loses no meeting content.
fn drop_fts(conn: &Connection) {
    let _ = conn.execute_batch(
        "DROP TRIGGER IF EXISTS meetings_fts_ai;
         DROP TRIGGER IF EXISTS meetings_fts_ad;
         DROP TRIGGER IF EXISTS meetings_fts_au;
         DROP TABLE IF EXISTS meetings_fts;",
    );
}

/// Repair / migrate the FTS5 index at startup so meetings-table writes (pin, lock,
/// delete, tag, summary edits) can't fail with SQLITE_CORRUPT_VTAB.
///
/// Two things: (1) drop the keep-in-sync triggers so [`setup_fts`] recreates them
/// with the current definition (older DBs had an `_au` trigger that fired on EVERY
/// column, so pinning re-indexed FTS and hit a bad index — the new one only fires
/// on title/summary/transcript); (2) rebuild the external-content index from
/// `meetings` to fix any desync, or drop the table if it's too corrupt to rebuild
/// (setup_fts then recreates it fresh). The index is derived data — no content lost.
/// Best-effort: never returns an error, never fails init.
fn repair_fts(conn: &Connection) {
    let _ = conn.execute_batch(
        "DROP TRIGGER IF EXISTS meetings_fts_ai;
         DROP TRIGGER IF EXISTS meetings_fts_ad;
         DROP TRIGGER IF EXISTS meetings_fts_au;",
    );
    let has_fts = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meetings_fts'",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !has_fts {
        return; // setup_fts will create it
    }
    // `rebuild` reconstructs the index from the content table (fixes any desync).
    if conn
        .execute_batch("INSERT INTO meetings_fts(meetings_fts) VALUES('rebuild');")
        .is_err()
    {
        let _ = conn.execute_batch("DROP TABLE IF EXISTS meetings_fts;");
        eprintln!("[storage] FTS5 index unrebuildable; dropped for a fresh recreate");
    }
}

/// Whether an error is a SQLite corruption error (primary code SQLITE_CORRUPT,
/// which covers the extended SQLITE_CORRUPT_VTAB=267 raised by a bad FTS5 index).
fn is_db_corruption(err: &anyhow::Error) -> bool {
    matches!(
        err.downcast_ref::<rusqlite::Error>(),
        Some(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::DatabaseCorrupt
    )
}

/// Create the FTS5 index over meetings + keep-in-sync triggers, and backfill
/// existing rows once. Returns Err if FTS5 isn't compiled into this SQLite — the
/// caller treats that as non-fatal.
fn setup_fts(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
            title, summary, transcript, content='meetings', content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS meetings_fts_ai AFTER INSERT ON meetings BEGIN
            INSERT INTO meetings_fts(rowid, title, summary, transcript)
            VALUES (new.id, new.title, new.summary, new.transcript);
        END;
        CREATE TRIGGER IF NOT EXISTS meetings_fts_ad AFTER DELETE ON meetings BEGIN
            INSERT INTO meetings_fts(meetings_fts, rowid, title, summary, transcript)
            VALUES ('delete', old.id, old.title, old.summary, old.transcript);
        END;
        CREATE TRIGGER IF NOT EXISTS meetings_fts_au AFTER UPDATE OF title, summary, transcript ON meetings BEGIN
            INSERT INTO meetings_fts(meetings_fts, rowid, title, summary, transcript)
            VALUES ('delete', old.id, old.title, old.summary, old.transcript);
            INSERT INTO meetings_fts(rowid, title, summary, transcript)
            VALUES (new.id, new.title, new.summary, new.transcript);
        END;",
    )?;
    // One-time backfill of rows that predate the index/triggers.
    let fts_count: i64 = conn.query_row("SELECT count(*) FROM meetings_fts", [], |r| r.get(0))?;
    let meeting_count: i64 = conn.query_row("SELECT count(*) FROM meetings", [], |r| r.get(0))?;
    if fts_count == 0 && meeting_count > 0 {
        conn.execute(
            "INSERT INTO meetings_fts(rowid, title, summary, transcript)
             SELECT id, title, summary, transcript FROM meetings",
            [],
        )?;
    }
    Ok(())
}

/// Return meeting ids ranked by FTS5 relevance to `query` (best matches first).
/// Returns Err if FTS5 is unavailable; the caller falls back to keyword ranking.
pub fn search_meeting_ids(query: &str, limit: usize) -> anyhow::Result<Vec<i64>> {
    // Build a safe FTS MATCH expression: quote each term, OR them for recall.
    let match_expr = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 2)
        .map(|w| format!("\"{w}\""))
        .collect::<Vec<_>>()
        .join(" OR ");
    if match_expr.is_empty() {
        return Ok(Vec::new());
    }
    let conn = connect()?;
    let mut stmt = conn.prepare(
        "SELECT rowid FROM meetings_fts WHERE meetings_fts MATCH ?1 ORDER BY rank LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![match_expr, limit as i64], |row| {
        row.get::<_, i64>(0)
    })?;
    let mut ids = Vec::new();
    for r in rows {
        ids.push(r?);
    }
    Ok(ids)
}

/// Whether `table` has a column named `column`.
fn column_exists(conn: &Connection, table: &str, column: &str) -> anyhow::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Encode an attendee list for storage as a JSON text column.
fn encode_attendees(attendees: &[String]) -> String {
    serde_json::to_string(attendees).unwrap_or_else(|_| "[]".to_string())
}

/// Decode an attendee list from the JSON text column (empty on any error).
fn decode_attendees(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn encode_tags(tags: &[crate::types::Tag]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string())
}

fn decode_tags(raw: &str) -> Vec<crate::types::Tag> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// Parse a flat speaker-labeled transcript into structured turns.
///
/// Each non-empty line is split on the FIRST `": "` into `{speaker, text}`.
/// A line with no `": "` is continuation text — it is space-joined to the
/// previous turn's text. If there is no previous turn, it becomes a turn
/// with an empty speaker.
pub fn parse_transcript_turns(transcript: &str) -> Vec<crate::types::TranscriptTurn> {
    let mut turns: Vec<crate::types::TranscriptTurn> = Vec::new();
    for line in transcript.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(pos) = trimmed.find(": ") {
            let speaker = trimmed[..pos].trim().to_string();
            let text = trimmed[pos + 2..].trim().to_string();
            turns.push(crate::types::TranscriptTurn {
                speaker,
                text,
                start: None,
                end: None,
            });
        } else {
            // Continuation line — append to the previous turn's text.
            if let Some(last) = turns.last_mut() {
                last.text.push(' ');
                last.text.push_str(trimmed);
            } else {
                // No previous turn — keep as a turn with an empty speaker.
                turns.push(crate::types::TranscriptTurn {
                    speaker: String::new(),
                    text: trimmed.to_string(),
                    start: None,
                    end: None,
                });
            }
        }
    }
    turns
}

fn encode_transcript_turns(turns: &[crate::types::TranscriptTurn]) -> String {
    serde_json::to_string(turns).unwrap_or_else(|_| "[]".to_string())
}

fn decode_transcript_turns(raw: &str) -> Vec<crate::types::TranscriptTurn> {
    serde_json::from_str(raw).unwrap_or_default()
}

/// One-time backfill: for every row where `transcript_turns` is empty (`[]`)
/// AND the flat `transcript` is non-empty, parse the flat transcript into
/// structured turns and write them back. Idempotent — running twice is a
/// no-op because it only fills rows that are still empty.
fn backfill_transcript_turns(conn: &Connection) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, transcript FROM meetings
         WHERE transcript_turns = '[]' AND transcript != ''",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    for (id, transcript) in &rows {
        let turns = parse_transcript_turns(transcript);
        let json = encode_transcript_turns(&turns);
        conn.execute(
            "UPDATE meetings SET transcript_turns = ?1 WHERE id = ?2",
            params![json, id],
        )?;
    }
    if !rows.is_empty() {
        eprintln!(
            "[storage] backfilled transcript_turns for {} meetings",
            rows.len()
        );
    }
    Ok(())
}

/// Encode an f32 vector as little-endian bytes for BLOB storage.
fn encode_f32(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// Decode a little-endian BLOB back into an f32 vector.
fn decode_f32(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Open a connection to the database (encryption key applied).
fn connect() -> Result<Connection, rusqlite::Error> {
    open_keyed()
}

/// Open a connection to the database (pub for sync use from commands.rs).
pub fn connect_for_sync() -> Result<Connection, rusqlite::Error> {
    open_keyed()
}

/// Insert a new meeting record.
///
/// The `id` field on the input is ignored — SQLite auto-generates it.
/// Returns the newly assigned row id.
pub fn insert_meeting(meeting: &Meeting) -> anyhow::Result<i64> {
    let conn = connect()?;
    insert_meeting_on(&conn, meeting)
}

/// [`insert_meeting`] on a caller-supplied connection, for writers that need
/// several statements on one connection (e.g. the demo seeder).
pub fn insert_meeting_on(conn: &Connection, meeting: &Meeting) -> anyhow::Result<i64> {
    conn.execute(
        "INSERT INTO meetings (title, recorded_at, duration_seconds, transcript, summary, template_used, audio_file_path, attendees, user_notes, link, tags, transcript_turns)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            meeting.title,
            meeting.recorded_at,
            meeting.duration_seconds,
            meeting.transcript,
            meeting.summary,
            meeting.template_used,
            meeting.audio_file_path,
            encode_attendees(&meeting.attendees),
            meeting.user_notes,
            meeting.link,
            encode_tags(&meeting.tags),
            encode_transcript_turns(&meeting.transcript_turns),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Replace the summary (and derived title/template/attendees) of a meeting.
pub fn update_meeting_summary(
    id: i64,
    title: &str,
    summary: &str,
    template_used: &str,
    attendees: &[String],
) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET title = ?1, summary = ?2, template_used = ?3, attendees = ?4 WHERE id = ?5",
        params![title, summary, template_used, encode_attendees(attendees), id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Replace the user's notes for an existing meeting.
pub fn update_meeting_notes(id: i64, notes: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET user_notes = ?1 WHERE id = ?2",
        params![notes, id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Overwrite a meeting's summary text with a user-edited version.
pub fn update_meeting_summary_text(id: i64, summary: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET summary = ?1 WHERE id = ?2",
        params![summary, id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Pin or unpin a meeting (controls list ordering).
pub fn set_meeting_pinned(id: i64, pinned: bool) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET pinned = ?1 WHERE id = ?2",
        params![pinned, id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Lock or unlock a meeting (privacy lock).
pub fn set_meeting_locked(id: i64, locked: bool) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET locked = ?1 WHERE id = ?2",
        params![locked, id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Archive or unarchive a meeting (sidebar Archive bin). Archiving also unpins.
pub fn set_meeting_archived(id: i64, archived: bool) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET archived = ?1, pinned = CASE WHEN ?1 THEN 0 ELSE pinned END WHERE id = ?2",
        params![archived, id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Permanently delete a meeting and its chat history + action items.
pub fn delete_meeting(id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    conn.execute(
        "DELETE FROM chat_messages WHERE meeting_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM action_items WHERE meeting_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM meeting_chunks WHERE meeting_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM chunk_index_state WHERE meeting_id = ?1",
        params![id],
    )?;
    let deleted = conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
    anyhow::ensure!(deleted == 1, "Meeting not found: {id}");
    Ok(())
}

/// Replace the tag list of an existing meeting.
pub fn update_meeting_tags(id: i64, tags: &[crate::types::Tag]) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET tags = ?1 WHERE id = ?2",
        params![encode_tags(tags), id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Replace the attendee list of an existing meeting (user edit).
pub fn update_meeting_attendees(id: i64, attendees: &[String]) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET attendees = ?1 WHERE id = ?2",
        params![encode_attendees(attendees), id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Set or clear a meeting's source URL (e.g. the YouTube link of a watched video).
pub fn update_meeting_link(id: i64, link: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET link = ?1 WHERE id = ?2",
        params![link.trim(), id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// True for a diarizer-invented "Speaker N" label (any digit count).
fn is_speaker_n_label(label: &str) -> bool {
    label
        .trim()
        .to_lowercase()
        .strip_prefix("speaker ")
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

/// Relabel every "Speaker N" turn to "Them" and join now-adjacent same-speaker
/// turns. Returns the rewritten flat transcript + structured turns. Pure.
pub fn collapse_speaker_turns(transcript: &str) -> (String, Vec<crate::types::TranscriptTurn>) {
    let mut turns: Vec<crate::types::TranscriptTurn> = Vec::new();
    for mut turn in parse_transcript_turns(transcript) {
        if is_speaker_n_label(&turn.speaker) {
            turn.speaker = "Them".to_string();
        }
        match turns.last_mut() {
            Some(last) if last.speaker == turn.speaker => {
                last.text.push(' ');
                last.text.push_str(&turn.text);
            }
            _ => turns.push(turn),
        }
    }
    let flat = turns
        .iter()
        .map(|t| {
            if t.speaker.is_empty() {
                t.text.clone()
            } else {
                format!("{}: {}", t.speaker, t.text)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    (flat, turns)
}

/// Collapse diarized "Speaker N" labels in a saved meeting back to a flat
/// "Them". Retroactive cleanup for recordings whose diarization over-counted —
/// the audio is deleted after transcription, so the labels can never be
/// recomputed. Rewrites the flat transcript and `transcript_turns` (the FTS
/// update trigger re-indexes), and scrubs "Speaker N" attendee entries.
pub fn merge_meeting_speakers(id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    let (transcript, attendees_raw): (String, String) = conn.query_row(
        "SELECT transcript, attendees FROM meetings WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let (flat, turns) = collapse_speaker_turns(&transcript);
    let attendees: Vec<String> = decode_attendees(&attendees_raw)
        .into_iter()
        .filter(|a| !is_speaker_n_label(a))
        .collect();
    let updated = conn.execute(
        "UPDATE meetings SET transcript = ?1, transcript_turns = ?2, attendees = ?3
         WHERE id = ?4",
        params![
            flat,
            encode_transcript_turns(&turns),
            encode_attendees(&attendees),
            id
        ],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Rename a person everywhere a saved meeting references them — speaker
/// labels, transcript text, notes, attendees, and action items. The audio is
/// deleted after transcription, so a misheard name can never be re-derived;
/// editing the stored text is the only fix.
pub fn rename_meeting_person(id: i64, from: &str, to: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    rename_meeting_person_on(&conn, id, from, to)
}

fn rename_meeting_person_on(
    conn: &Connection,
    id: i64,
    from: &str,
    to: &str,
) -> anyhow::Result<()> {
    let (transcript, transcript_turns_raw, summary, attendees_raw): (
        String,
        String,
        String,
        String,
    ) = conn.query_row(
        "SELECT transcript, transcript_turns, summary, attendees
         FROM meetings WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let person_re = regex::Regex::new(&format!(r"(?i)\b{}\b", regex::escape(from)))?;
    let from_lower = from.to_lowercase();

    let mut transcript_turns = decode_transcript_turns(&transcript_turns_raw);
    for turn in &mut transcript_turns {
        if turn.speaker.to_lowercase() == from_lower {
            turn.speaker = to.to_string();
        }
        turn.text = person_re
            .replace_all(&turn.text, regex::NoExpand(to))
            .into_owned();
    }
    let transcript = person_re
        .replace_all(&transcript, regex::NoExpand(to))
        .into_owned();
    let summary = person_re
        .replace_all(&summary, regex::NoExpand(to))
        .into_owned();

    let mut seen_attendees = std::collections::HashSet::new();
    let attendees: Vec<String> = decode_attendees(&attendees_raw)
        .into_iter()
        .map(|attendee| {
            if attendee.to_lowercase() == from_lower {
                to.to_string()
            } else {
                attendee
            }
        })
        .filter(|attendee| seen_attendees.insert(attendee.to_lowercase()))
        .collect();

    let updated = conn.execute(
        "UPDATE meetings
         SET transcript = ?1, transcript_turns = ?2, summary = ?3, attendees = ?4
         WHERE id = ?5",
        params![
            transcript,
            encode_transcript_turns(&transcript_turns),
            summary,
            encode_attendees(&attendees),
            id,
        ],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");

    let action_items: Vec<(i64, String, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, text, assignee FROM action_items WHERE meeting_id = ?1")?;
        let rows = stmt.query_map(params![id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (action_id, text, assignee) in action_items {
        let renamed_text = person_re
            .replace_all(&text, regex::NoExpand(to))
            .into_owned();
        let renamed_assignee = if assignee.to_lowercase() == from_lower {
            to.to_string()
        } else {
            assignee.clone()
        };
        if renamed_text != text || renamed_assignee != assignee {
            conn.execute(
                "UPDATE action_items SET text = ?1, assignee = ?2 WHERE id = ?3",
                params![renamed_text, renamed_assignee, action_id],
            )?;
        }
    }
    Ok(())
}

/// Fill a previously "pending" recording (saved when transcription couldn't run)
/// with its transcription + summary results, and clear the stored audio path —
/// the caller deletes the WAV on success. Title / transcript / turns / duration /
/// summary / template / attendees / tags are written in one statement; the
/// title/summary/transcript-scoped FTS trigger re-indexes the now-filled row.
#[allow(clippy::too_many_arguments)]
pub fn update_meeting_transcription(
    id: i64,
    title: &str,
    duration_seconds: f64,
    transcript: &str,
    transcript_turns: &[crate::types::TranscriptTurn],
    summary: &str,
    template_used: &str,
    attendees: &[String],
    tags: &[crate::types::Tag],
) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings
         SET title = ?1, duration_seconds = ?2, transcript = ?3, transcript_turns = ?4,
             summary = ?5, template_used = ?6, attendees = ?7, tags = ?8
         WHERE id = ?9",
        params![
            title,
            duration_seconds,
            transcript,
            encode_transcript_turns(transcript_turns),
            summary,
            template_used,
            encode_attendees(attendees),
            encode_tags(tags),
            id,
        ],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

/// Clear the retained audio reference only after encrypted and temporary files
/// were actually deleted.
pub fn clear_meeting_audio_path(id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET audio_file_path = NULL WHERE id = ?1",
        params![id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

pub fn set_meeting_audio_path(id: i64, path: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE meetings SET audio_file_path = ?1 WHERE id = ?2",
        params![path, id],
    )?;
    anyhow::ensure!(updated == 1, "Meeting not found: {id}");
    Ok(())
}

pub fn create_recording_asset(
    path: &str,
    session_id: &str,
    state: &str,
    channel_metadata: &str,
    last_committed_chunk: u64,
) -> anyhow::Result<()> {
    let conn = connect()?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO recording_assets
            (session_id, path, format_version, state, channel_metadata,
             last_committed_chunk, created_at, updated_at)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(path) DO UPDATE SET
            session_id = excluded.session_id,
            state = excluded.state,
            channel_metadata = excluded.channel_metadata,
            last_committed_chunk = excluded.last_committed_chunk,
            updated_at = excluded.updated_at",
        params![
            session_id,
            path,
            state,
            channel_metadata,
            last_committed_chunk as i64,
            now,
        ],
    )?;
    Ok(())
}

pub fn update_recording_asset(
    path: &str,
    state: &str,
    channel_metadata: &str,
    last_committed_chunk: u64,
    last_error: Option<&str>,
) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE recording_assets
         SET state = ?1, channel_metadata = ?2, last_committed_chunk = ?3,
             last_error = ?4, updated_at = ?5
         WHERE path = ?6",
        params![
            state,
            channel_metadata,
            last_committed_chunk as i64,
            last_error,
            chrono::Utc::now().to_rfc3339(),
            path,
        ],
    )?;
    anyhow::ensure!(updated == 1, "Recording asset not found: {path}");
    Ok(())
}

pub fn attach_recording_asset(path: &str, meeting_id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE recording_assets SET meeting_id = ?1, updated_at = ?2 WHERE path = ?3",
        params![meeting_id, chrono::Utc::now().to_rfc3339(), path],
    )?;
    anyhow::ensure!(updated == 1, "Recording asset not found: {path}");
    Ok(())
}

pub fn delete_recording_asset(path: &str) -> anyhow::Result<()> {
    connect()?.execute(
        "DELETE FROM recording_assets WHERE path = ?1",
        params![path],
    )?;
    Ok(())
}

pub fn meeting_id_for_audio_path(path: &str) -> anyhow::Result<Option<i64>> {
    let conn = connect()?;
    let mut statement =
        conn.prepare("SELECT id FROM meetings WHERE audio_file_path = ?1 LIMIT 1")?;
    let mut rows = statement.query(params![path])?;
    Ok(rows.next()?.map(|row| row.get(0)).transpose()?)
}

pub fn pending_audio_paths() -> anyhow::Result<Vec<(i64, String)>> {
    let conn = connect()?;
    let mut statement = conn.prepare(
        "SELECT id, audio_file_path FROM meetings
         WHERE audio_file_path IS NOT NULL AND audio_file_path != ''",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Meetings whose recording is still on disk because transcription never
/// succeeded — the retroactive-transcription queue. Oldest first, so a backlog
/// drains in the order it was recorded.
pub fn meetings_awaiting_transcription() -> anyhow::Result<Vec<i64>> {
    let conn = connect()?;
    let mut statement = conn.prepare(
        "SELECT id FROM meetings
         WHERE audio_file_path IS NOT NULL AND audio_file_path != ''
           AND TRIM(COALESCE(transcript, '')) = ''
         ORDER BY recorded_at ASC",
    )?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Meetings that have a transcript but no notes — recorded before an LLM engine
/// was configured (or while it was down). Oldest first.
pub fn meetings_missing_summary() -> anyhow::Result<Vec<i64>> {
    let conn = connect()?;
    let mut statement = conn.prepare(
        "SELECT id FROM meetings
         WHERE TRIM(COALESCE(transcript, '')) != '' AND TRIM(COALESCE(summary, '')) = ''
         ORDER BY recorded_at ASC",
    )?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

pub fn get_registration_state() -> anyhow::Result<RegistrationState> {
    let conn = connect()?;
    let mut statement = conn.prepare(
        "SELECT schema_version, status, name, email, consent_version,
                consent_timestamp, source, app_version, platform, attempt_count,
                next_retry_at, last_error
         FROM registration_state WHERE singleton = 1",
    )?;
    let mut rows = statement.query([])?;
    let Some(row) = rows.next()? else {
        return Ok(RegistrationState::default());
    };
    Ok(RegistrationState {
        schema_version: row.get::<_, i64>(0)? as u32,
        status: row.get(1)?,
        name: row.get(2)?,
        email: row.get(3)?,
        consent_version: row.get(4)?,
        consent_timestamp: row.get(5)?,
        source: row.get(6)?,
        app_version: row.get(7)?,
        platform: row.get(8)?,
        attempt_count: row.get::<_, i64>(9)? as u32,
        next_retry_at: row.get(10)?,
        last_error: row.get(11)?,
    })
}

pub fn save_registration_state(state: &RegistrationState) -> anyhow::Result<()> {
    let conn = connect()?;
    conn.execute(
        "INSERT INTO registration_state
            (singleton, schema_version, status, name, email, consent_version,
             consent_timestamp, source, app_version, platform, attempt_count,
             next_retry_at, last_error, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(singleton) DO UPDATE SET
            schema_version = excluded.schema_version,
            status = excluded.status,
            name = excluded.name,
            email = excluded.email,
            consent_version = excluded.consent_version,
            consent_timestamp = excluded.consent_timestamp,
            source = excluded.source,
            app_version = excluded.app_version,
            platform = excluded.platform,
            attempt_count = excluded.attempt_count,
            next_retry_at = excluded.next_retry_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at",
        params![
            state.schema_version,
            state.status,
            state.name,
            state.email,
            state.consent_version,
            state.consent_timestamp,
            state.source,
            state.app_version,
            state.platform,
            state.attempt_count,
            state.next_retry_at,
            state.last_error,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

pub fn get_onboarding_state() -> anyhow::Result<OnboardingState> {
    let conn = connect()?;
    let mut statement = conn.prepare(
        "SELECT schema_version, completed_steps, selected_model_profile,
                setup_complete, updated_at
         FROM onboarding_state WHERE singleton = 1",
    )?;
    let mut rows = statement.query([])?;
    let Some(row) = rows.next()? else {
        return Ok(OnboardingState::default());
    };
    let steps: String = row.get(1)?;
    Ok(OnboardingState {
        schema_version: row.get::<_, i64>(0)? as u32,
        completed_steps: serde_json::from_str(&steps).unwrap_or_default(),
        selected_model_profile: row.get(2)?,
        setup_complete: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

pub fn save_onboarding_state(state: &OnboardingState) -> anyhow::Result<()> {
    let conn = connect()?;
    conn.execute(
        "INSERT INTO onboarding_state
            (singleton, schema_version, completed_steps, selected_model_profile,
             setup_complete, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(singleton) DO UPDATE SET
            schema_version = excluded.schema_version,
            completed_steps = excluded.completed_steps,
            selected_model_profile = excluded.selected_model_profile,
            setup_complete = excluded.setup_complete,
            updated_at = excluded.updated_at",
        params![
            state.schema_version,
            serde_json::to_string(&state.completed_steps)?,
            state.selected_model_profile,
            state.setup_complete,
            state.updated_at,
        ],
    )?;
    Ok(())
}

/// Whether the one-time "should this install get a sample meeting?" question
/// has already been answered. Lives on `onboarding_state` — the same singleton
/// row that holds `setup_complete` — rather than in config.json, because
/// `update_config` saves whatever the frontend sends and would reset a flag the
/// TypeScript `AppConfig` doesn't know about.
pub fn demo_meeting_seeded(conn: &Connection) -> anyhow::Result<bool> {
    // COALESCE covers the fresh install where the singleton row doesn't exist yet.
    let seeded: bool = conn.query_row(
        "SELECT COALESCE(
            (SELECT demo_meeting_seeded FROM onboarding_state WHERE singleton = 1), 0)",
        [],
        |row| row.get(0),
    )?;
    Ok(seeded)
}

/// Record that the sample-meeting question is answered — whether the sample was
/// actually seeded or deliberately skipped. Leaves every other onboarding field
/// alone (and `save_onboarding_state` in turn leaves this one alone).
pub fn mark_demo_meeting_seeded(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO onboarding_state
            (singleton, schema_version, demo_meeting_seeded, updated_at)
         VALUES (1, ?1, 1, ?2)
         ON CONFLICT(singleton) DO UPDATE SET demo_meeting_seeded = 1",
        params![
            OnboardingState::default().schema_version,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

/// True when the library holds no meetings at all (fresh install).
pub fn meetings_are_empty(conn: &Connection) -> anyhow::Result<bool> {
    let count: i64 = conn.query_row("SELECT count(*) FROM meetings", [], |row| row.get(0))?;
    Ok(count == 0)
}

/// Return all meetings ordered by most recent first.
pub fn get_meetings() -> anyhow::Result<Vec<Meeting>> {
    let conn = connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, recorded_at, duration_seconds, transcript, summary, template_used, audio_file_path, attendees, user_notes, tags, pinned, locked, archived, transcript_turns, link
         FROM meetings
         ORDER BY pinned DESC, recorded_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Meeting {
            id: row.get(0)?,
            title: row.get(1)?,
            recorded_at: row.get(2)?,
            duration_seconds: row.get(3)?,
            transcript: row.get(4)?,
            summary: row.get(5)?,
            template_used: row.get(6)?,
            audio_file_path: row.get(7)?,
            attendees: decode_attendees(&row.get::<_, String>(8)?),
            user_notes: row.get(9)?,
            tags: decode_tags(&row.get::<_, String>(10)?),
            pinned: row.get(11)?,
            locked: row.get(12)?,
            archived: row.get(13)?,
            transcript_turns: decode_transcript_turns(&row.get::<_, String>(14)?),
            link: row.get(15)?,
        })
    })?;
    let mut meetings = Vec::new();
    for row in rows {
        meetings.push(row?);
    }
    Ok(meetings)
}

/// Look up a single meeting by its id.
pub fn get_meeting(id: i64) -> anyhow::Result<Option<Meeting>> {
    let conn = connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, recorded_at, duration_seconds, transcript, summary, template_used, audio_file_path, attendees, user_notes, tags, pinned, locked, archived, transcript_turns, link
         FROM meetings
         WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(Meeting {
            id: row.get(0)?,
            title: row.get(1)?,
            recorded_at: row.get(2)?,
            duration_seconds: row.get(3)?,
            transcript: row.get(4)?,
            summary: row.get(5)?,
            template_used: row.get(6)?,
            audio_file_path: row.get(7)?,
            attendees: decode_attendees(&row.get::<_, String>(8)?),
            user_notes: row.get(9)?,
            tags: decode_tags(&row.get::<_, String>(10)?),
            pinned: row.get(11)?,
            locked: row.get(12)?,
            archived: row.get(13)?,
            transcript_turns: decode_transcript_turns(&row.get::<_, String>(14)?),
            link: row.get(15)?,
        })
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Append one chat message for a meeting.
pub fn insert_chat_message(
    meeting_id: i64,
    role: &str,
    content: &str,
    created_at: &str,
) -> anyhow::Result<()> {
    let conn = connect()?;
    conn.execute(
        "INSERT INTO chat_messages (meeting_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![meeting_id, role, content, created_at],
    )?;
    Ok(())
}

/// All chat messages for a meeting, oldest first.
pub fn get_chat_messages(meeting_id: i64) -> anyhow::Result<Vec<crate::types::ChatMessage>> {
    let conn = connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, role, content, created_at FROM chat_messages
         WHERE meeting_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(crate::types::ChatMessage {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Delete all chat messages for a meeting.
pub fn clear_chat_messages(meeting_id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    conn.execute(
        "DELETE FROM chat_messages WHERE meeting_id = ?1",
        params![meeting_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Cross-meeting "Ask" conversation (single persisted thread)
// ---------------------------------------------------------------------------

/// Append one message to the persisted cross-meeting Ask conversation. `sources`
/// is a JSON array of MeetingRef (empty `[]` for user turns).
pub fn insert_ask_message(
    role: &str,
    content: &str,
    sources_json: &str,
    intent: &str,
    created_at: &str,
) -> anyhow::Result<()> {
    let conn = connect()?;
    conn.execute(
        "INSERT INTO ask_messages (role, content, sources, intent, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![role, content, sources_json, intent, created_at],
    )?;
    Ok(())
}

/// Load the full persisted Ask conversation, oldest first.
pub fn get_ask_messages() -> anyhow::Result<Vec<crate::types::AskMessage>> {
    let conn = connect()?;
    let mut stmt =
        conn.prepare("SELECT role, content, sources, intent FROM ask_messages ORDER BY id")?;
    let rows = stmt.query_map([], |row| {
        let sources_json: String = row.get(2)?;
        Ok(crate::types::AskMessage {
            role: row.get(0)?,
            content: row.get(1)?,
            sources: serde_json::from_str(&sources_json).unwrap_or_default(),
            intent: row.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Clear the persisted Ask conversation ("New conversation").
pub fn clear_ask_messages() -> anyhow::Result<()> {
    let conn = connect()?;
    conn.execute("DELETE FROM ask_messages", [])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------

/// Raw extracted item (no id/meeting_id — assigned at sync).
struct ActionItemRaw {
    ord: i64,
    text: String,
    assignee: String,
    due: String,
    done: bool,
}

/// Extract action items the way the UI's `parseSummary` (lib/summary.ts) does:
/// bullets under a `**Heading**` whose title matches action/next-step/deliverable.
/// A bullet may lead with an assignee label, e.g. `- Hamza: do the thing`, and
/// may end with a due marker, e.g. `- Ship it — due 2026-08-07` (see
/// `split_due`). `done` starts false (it is toggled later via the
/// action_items table).
fn extract_action_items(summary: &str) -> Vec<ActionItemRaw> {
    let re_heading = regex::Regex::new(r"^\*\*(.+?)\*\*:?$").unwrap();
    let re_bullet = regex::Regex::new(r"^[-*•]\s+(.*)$").unwrap();
    // Match action-oriented section headings tolerantly: the local LLM drifts on
    // heading wording (e.g. "To-Build", "Tasks", "To-Do List") and emits Arabic
    // headings for Arabic meetings. Mirror lib/summary.ts `ACTIONABLE`.
    let re_actionable = regex::Regex::new(
        r"(?i)(action item|action point|next step|to[ -]?(?:do|build)|deliverable|task|عناصر العمل|الخطوات التالية|المهام)",
    )
    .unwrap();
    let mut items: Vec<ActionItemRaw> = Vec::new();
    let mut in_actionable = false;

    for line in summary.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(c) = re_heading.captures(trimmed) {
            let heading = c[1].trim_end_matches(':').trim();
            in_actionable =
                !heading.to_lowercase().starts_with("attendees") && re_actionable.is_match(heading);
            continue;
        }
        if !in_actionable {
            continue;
        }
        if let Some(c) = re_bullet.captures(trimmed) {
            // Due marker FIRST: `split_label` grabs any `word: ` prefix within
            // 48 chars, so on an owner-less bullet ("Ship the installer due:
            // 2026-08-07") it would claim "Ship the installer due" as the
            // assignee and leave the bare date as the task. Stripping the due
            // marker first leaves `split_label` only a real owner to find.
            let (body, due) = split_due(c[1].trim());
            let (assignee, text) = split_label(&body);
            // Skip placeholder bullets ("None mentioned." / "None" / "لا يوجد") and empties.
            let norm = text.trim_end_matches('.').trim().to_lowercase();
            if text.is_empty() || norm == "none mentioned" || norm == "none" || norm == "لا يوجد"
            {
                continue;
            }
            items.push(ActionItemRaw {
                ord: items.len() as i64,
                text,
                assignee,
                due,
                done: false,
            });
        }
    }
    items
}

/// Split a bullet into an optional leading assignee label and the rest, mirroring
/// the frontend `splitLabel`: `**Label:** rest` or a short `Label: rest` prefix.
fn split_label(text: &str) -> (String, String) {
    let re_bold = regex::Regex::new(r"^\*\*(.+?)\*\*:?\s*(.*)$").unwrap();
    if let Some(c) = re_bold.captures(text) {
        return (
            c[1].trim_end_matches(':').trim().to_string(),
            c[2].trim().to_string(),
        );
    }
    if let Some(idx) = text.find(": ") {
        if idx > 0 && idx <= 48 && !text[..idx].contains(['.', '?', '!']) {
            return (
                text[..idx].trim().to_string(),
                text[idx + 2..].trim().to_string(),
            );
        }
    }
    (String::new(), text.trim().to_string())
}

/// Split a trailing due marker off an action bullet, returning the bullet text
/// without it plus the ISO date. The general template emits `… — due
/// 2026-08-07`; models drift, so an en dash / plain hyphen, a `due:` colon, and
/// a parenthesized `(due 2026-08-07)` are all accepted. Only a REAL calendar
/// date in `YYYY-MM-DD` is taken — the To-dos tab string-compares `due` against
/// today, so a bogus value is worse than none and stays part of the text.
/// Mirrors `splitDue` in src/lib/summary.ts — keep the two in sync.
fn split_due(text: &str) -> (String, String) {
    // The separator before "due" is OPTIONAL. The template emits the em-dash
    // form, but a local LLM drifts to "due: 2026-08-07" with no dash — and that
    // form used to fall through to `split_label`, which claimed everything up
    // to the colon as the assignee and left the bare date as the task text
    // (2026-08-03 review). `\bdue\b` keeps "overdue"/"subdued" out.
    let re_due = regex::Regex::new(
        r"(?i)\s*(?:[-–—]\s*)?\(?\s*\bdue\b\s*:?\s*(\d{4}-\d{2}-\d{2})\s*\)?\s*\.?$",
    )
    .unwrap();
    let unchanged = || (text.trim().to_string(), String::new());
    let Some(c) = re_due.captures(text) else {
        return unchanged();
    };
    let (Some(whole), Some(date)) = (c.get(0), c.get(1)) else {
        return unchanged();
    };
    if chrono::NaiveDate::parse_from_str(date.as_str(), "%Y-%m-%d").is_err() {
        return unchanged();
    }
    (
        text[..whole.start()].trim().to_string(),
        date.as_str().to_string(),
    )
}

#[cfg(test)]
mod action_item_tests {
    use super::{extract_action_items, merge_due};

    #[test]
    fn extracts_real_summary_format() {
        let summary = "**Key Topics Discussed**\n\n- A topic.\n\n**Action Items**\n\n- Hamza: Export the notes.\n- Sarah: Publish the guide.\n\n**Follow-ups Needed**\n\n- None mentioned.";
        let items = extract_action_items(summary);
        assert_eq!(items.len(), 2, "two action bullets");
        assert_eq!(items[0].assignee, "Hamza");
        assert_eq!(items[0].text, "Export the notes.");
        assert_eq!(items[1].assignee, "Sarah");
        assert!(!items[0].done && items[0].due.is_empty());
    }

    #[test]
    fn ignores_non_actionable_sections_and_placeholders() {
        let s = "**Decisions Made**\n- We decided X.\n**Next Steps**\n- Do the thing.\n- None mentioned.";
        let items = extract_action_items(s);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Do the thing.");
        assert_eq!(items[0].assignee, "");
    }

    #[test]
    fn extracts_arabic_action_heading() {
        // Arabic "Action Items" heading with an Arabic placeholder bullet to skip.
        let s =
            "**المواضيع الرئيسية**\n- موضوع.\n**عناصر العمل**\n- Them: مراجعة الكود.\n- لا يوجد.";
        let items = extract_action_items(s);
        assert_eq!(items.len(), 1, "one real Arabic action bullet");
        assert_eq!(items[0].assignee, "Them");
        assert_eq!(items[0].text, "مراجعة الكود.");
    }

    #[test]
    fn extracts_drifted_brainstorm_headings() {
        // LLM heading drift away from the template's literal "Action Items".
        for heading in ["To-Build", "To-Do List", "Tasks"] {
            let s = format!("**Ideas**\n- An idea.\n**{heading}**\n- Build the thing.");
            let items = extract_action_items(&s);
            assert_eq!(items.len(), 1, "heading {heading:?} should be actionable");
            assert_eq!(items[0].text, "Build the thing.");
        }
    }

    #[test]
    fn bullet_without_a_due_marker_is_untouched() {
        let s = "**Action Items**\n- Hamza: Export the notes.";
        let items = extract_action_items(s);
        assert_eq!(items[0].text, "Export the notes.");
        assert_eq!(items[0].due, "");
    }

    #[test]
    fn parses_every_accepted_due_spelling() {
        // The template emits the em-dash form; models drift to the rest.
        for marker in [
            "— due 2026-08-07",
            "– due 2026-08-07",
            "- due 2026-08-07",
            "- due: 2026-08-07",
            "(due 2026-08-07)",
            "(due: 2026-08-07)",
            "— Due 2026-08-07",
            "— due 2026-08-07.",
        ] {
            let s = format!("**Action Items**\n- Hamza: Export the notes {marker}");
            let items = extract_action_items(&s);
            assert_eq!(items.len(), 1, "marker {marker:?}");
            assert_eq!(items[0].due, "2026-08-07", "marker {marker:?}");
            assert_eq!(items[0].text, "Export the notes", "marker {marker:?}");
            assert_eq!(items[0].assignee, "Hamza", "marker {marker:?}");
        }
    }

    #[test]
    fn malformed_due_dates_stay_in_the_text() {
        // Never store a value the To-dos tab would string-compare as a date.
        for marker in [
            "— due 2026-13-45",     // shaped right, not a real calendar date
            "— due Friday",         // unresolved relative date
            "— due 08/07/2026",     // wrong format
            "— due 2026-8-7",       // unpadded
            "— duedate 2026-08-07", // not the marker word
        ] {
            let s = format!("**Action Items**\n- Ship the build {marker}");
            let items = extract_action_items(&s);
            assert_eq!(items.len(), 1, "marker {marker:?}");
            assert_eq!(
                items[0].due, "",
                "marker {marker:?} must not become a due date"
            );
            assert_eq!(
                items[0].text,
                format!("Ship the build {marker}"),
                "marker {marker:?} stays part of the text"
            );
        }
    }

    #[test]
    fn due_marker_in_a_non_actionable_section_is_ignored() {
        let s = "**Decisions Made**\n- We ship the beta — due 2026-08-07.\n**Action Items**\n- Ship the beta — due 2026-08-09";
        let items = extract_action_items(s);
        assert_eq!(items.len(), 1, "only the actionable section yields items");
        assert_eq!(items[0].text, "Ship the beta");
        assert_eq!(items[0].due, "2026-08-09");
    }

    #[test]
    fn resync_never_overrides_the_stored_due() {
        assert_eq!(
            merge_due("2026-09-01"),
            "2026-09-01",
            "a user-set due is never overwritten"
        );
        // Regression (2026-08-03 review): a deadline the user CLEARED in the
        // To-dos tab must stay cleared. Refilling it from the summary silently
        // undid an explicit user action on every re-summarize.
        assert_eq!(
            merge_due(""),
            "",
            "a deliberately cleared due stays cleared"
        );
        assert_eq!(merge_due("  "), "  ", "whitespace is the user's value too");
    }

    #[test]
    fn a_due_marker_survives_a_bullet_with_no_owner() {
        // Regression (2026-08-03 review): `split_label` ran first and claimed
        // "Ship the installer due" as the assignee, leaving the bare date as
        // the task text.
        let s = "**Action Items**\n- Ship the installer due: 2026-08-07";
        let items = extract_action_items(s);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].assignee, "", "no owner was written on that bullet");
        assert_eq!(items[0].text, "Ship the installer");
        assert_eq!(items[0].due, "2026-08-07");
    }

    #[test]
    fn an_owner_and_a_due_marker_coexist() {
        let s = "**Action Items**\n- Hamza: Ship the installer — due 2026-08-07";
        let items = extract_action_items(s);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].assignee, "Hamza");
        assert_eq!(items[0].text, "Ship the installer");
        assert_eq!(items[0].due, "2026-08-07");
    }
}

/// The due date to keep when re-syncing an action item whose text is unchanged.
/// A stored value always wins — it may be a user edit — but an EMPTY one is
/// nothing to protect, so a date freshly parsed out of the summary comes
/// through. Without this, meetings summarized before the template emitted due
/// dates would keep their blank `due` forever, even after a re-summarize.
/// The due date to keep for an action item that ALREADY EXISTED and whose text
/// still matches — i.e. one the user has had the chance to edit.
///
/// The stored value always wins, **including an empty one**. Treating empty as
/// "nothing to protect" meant a deadline the user deliberately cleared in the
/// To-dos tab came back on the next re-summarize (2026-08-03 review, reproduced
/// end-to-end). Known consequence, accepted: an item extracted before this
/// feature existed keeps its blank date through a re-summarize — visible and
/// harmless, unlike silently overriding an explicit user action. A genuinely
/// new item is not routed here at all; it takes the date the summary produced.
fn merge_due(old_due: &str) -> String {
    old_due.to_string()
}

/// Sync action_items for a meeting from its current summary. Deletes existing
/// rows then re-inserts from extract_action_items, preserving user-editable
/// fields (done, assignee, due) by `ord` when the text at that ord still
/// matches (best-effort). `text` always comes fresh from extraction.
pub fn sync_action_items(conn: &Connection, meeting_id: i64, summary: &str) -> anyhow::Result<()> {
    // Read existing (done, text, assignee, due) keyed by ord before deletion.
    let mut old_by_ord: std::collections::HashMap<i64, (bool, String, String, String)> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT ord, done, text, assignee, due FROM action_items WHERE meeting_id = ?1",
        )?;
        let rows = stmt.query_map(params![meeting_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (ord, done, text, assignee, due) = row?;
            old_by_ord.insert(ord, (done, text, assignee, due));
        }
    }

    // Delete existing items for this meeting.
    conn.execute(
        "DELETE FROM action_items WHERE meeting_id = ?1",
        params![meeting_id],
    )?;

    // Re-insert from extraction, preserving old user state when text matches.
    let items = extract_action_items(summary);
    for item in &items {
        let (done, assignee, due) = old_by_ord
            .get(&item.ord)
            .filter(|(_, old_text, _, _)| old_text == &item.text)
            .map(|(old_done, _, old_assignee, old_due)| {
                (*old_done, old_assignee.clone(), merge_due(old_due))
            })
            .unwrap_or_else(|| (item.done, item.assignee.clone(), item.due.clone()));
        conn.execute(
            "INSERT INTO action_items (meeting_id, ord, text, assignee, due, done)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![meeting_id, item.ord, item.text, assignee, due, done as i32,],
        )?;
    }

    if !items.is_empty() {
        eprintln!(
            "[storage] synced {} action items for meeting {}",
            items.len(),
            meeting_id
        );
    }
    Ok(())
}

/// One-time backfill: for every meeting that has no action_items rows yet,
/// extract and insert them from its current summary. Idempotent.
fn backfill_action_items(conn: &Connection) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.summary FROM meetings m
         WHERE NOT EXISTS (SELECT 1 FROM action_items a WHERE a.meeting_id = m.id)",
    )?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();

    let count = rows.len();
    for (id, summary) in &rows {
        sync_action_items(conn, *id, summary)?;
    }
    if count > 0 {
        eprintln!("[storage] backfilled action_items for {count} meetings");
    }
    Ok(())
}

/// Return action items. When `meeting_id` is `None`, returns all items across
/// all meetings ordered by meeting_id, ord.
pub fn get_action_items(meeting_id: Option<i64>) -> anyhow::Result<Vec<ActionItem>> {
    let conn = connect()?;
    let (sql, params_vec): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = match meeting_id {
        Some(_) => (
            "SELECT id, meeting_id, ord, text, assignee, due, done
             , status, completed_by, completed_at, evidence
             FROM action_items WHERE meeting_id = ?1 ORDER BY ord",
            vec![Box::new(meeting_id) as Box<dyn rusqlite::types::ToSql>],
        ),
        None => (
            "SELECT id, meeting_id, ord, text, assignee, due, done
             , status, completed_by, completed_at, evidence
             FROM action_items ORDER BY meeting_id, ord",
            vec![],
        ),
    };
    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        params_vec.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        Ok(ActionItem {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            ord: row.get(2)?,
            text: row.get(3)?,
            assignee: row.get(4)?,
            due: row.get(5)?,
            done: row.get::<_, i32>(6)? != 0,
            status: row.get(7)?,
            completed_by: row.get(8)?,
            completed_at: row.get(9)?,
            evidence: row.get(10)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Toggle the done flag on a single action item.
pub fn set_action_item_done(id: i64, done: bool) -> anyhow::Result<()> {
    let conn = connect()?;
    // Keep `status` in lockstep with the boolean so the board and every older
    // query agree. A user ticking the box owns the completion outright — it
    // clears any agent claim, including one that was awaiting review.
    let (status, by) = if done { ("done", "you") } else { ("todo", "") };
    let updated = conn.execute(
        "UPDATE action_items
            SET done = ?1,
                status = ?2,
                completed_by = ?3,
                completed_at = CASE WHEN ?1 = 1 THEN ?4 ELSE '' END,
                evidence = CASE WHEN ?1 = 1 THEN evidence ELSE '' END
          WHERE id = ?5",
        params![done as i32, status, by, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Action item not found: {id}");
    Ok(())
}

/// Accept work an agent reported: `ai_done` becomes a real `done`, keeping the
/// evidence and the credit. This is the human gate — an agent can never move an
/// item into `done` itself.
pub fn accept_agent_work(id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE action_items SET done = 1, status = 'done' WHERE id = ?1 AND status = 'ai_done'",
        params![id],
    )?;
    anyhow::ensure!(
        updated == 1,
        "No agent-completed action item to accept: {id}"
    );
    Ok(())
}

/// Update the assignee and/or due date on a single action item.
pub fn update_action_item(id: i64, assignee: &str, due: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE action_items SET assignee = ?1, due = ?2 WHERE id = ?3",
        params![assignee, due, id],
    )?;
    anyhow::ensure!(updated == 1, "Action item not found: {id}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Chunk index (embedding storage for the hybrid Ask retriever)
// ---------------------------------------------------------------------------

/// Replace a meeting's chunk index atomically: delete its old chunks, insert
/// the new ones, and upsert the per-meeting index state. `chunks` items are
/// (kind, text, embedding). An empty `chunks` still records the state row so
/// content-less meetings aren't re-scanned every sync.
pub fn replace_meeting_chunks(
    meeting_id: i64,
    chunks: &[(String, String, Vec<f32>)],
    model: &str,
    fingerprint: &str,
) -> anyhow::Result<()> {
    let mut conn = connect()?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM meeting_chunks WHERE meeting_id = ?1",
        params![meeting_id],
    )?;
    for (i, (kind, text, embedding)) in chunks.iter().enumerate() {
        tx.execute(
            "INSERT INTO meeting_chunks (meeting_id, chunk_index, kind, text, embedding, dim)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                meeting_id,
                i as i64,
                kind,
                text,
                encode_f32(embedding),
                embedding.len() as i64,
            ],
        )?;
    }
    let indexed_at = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO chunk_index_state (meeting_id, fingerprint, model, indexed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(meeting_id) DO UPDATE SET fingerprint = excluded.fingerprint,
         model = excluded.model, indexed_at = excluded.indexed_at",
        params![meeting_id, fingerprint, model, indexed_at],
    )?;
    tx.commit()?;
    Ok(())
}

/// Per-meeting index state: meeting_id -> (fingerprint, model).
pub fn get_chunk_index_state() -> anyhow::Result<std::collections::HashMap<i64, (String, String)>> {
    let conn = connect()?;
    let mut stmt = conn.prepare("SELECT meeting_id, fingerprint, model FROM chunk_index_state")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut map = std::collections::HashMap::new();
    for r in rows {
        let (id, fp, model) = r?;
        map.insert(id, (fp, model));
    }
    Ok(map)
}

/// All chunks whose meeting was indexed with `model`, with decoded vectors.
/// Rows whose BLOB length disagrees with `dim` are skipped (defensive).
pub fn get_chunks_for_model(model: &str) -> anyhow::Result<Vec<crate::types::ChunkRow>> {
    let conn = connect()?;
    let mut stmt = conn.prepare(
        "SELECT c.meeting_id, c.kind, c.text, c.embedding, c.dim
         FROM meeting_chunks c
         JOIN chunk_index_state s ON s.meeting_id = c.meeting_id
         WHERE s.model = ?1
         ORDER BY c.meeting_id, c.chunk_index",
    )?;
    let rows = stmt.query_map(params![model], |row| {
        let blob: Vec<u8> = row.get(3)?;
        let dim: i64 = row.get(4)?;
        let embedding = decode_f32(&blob);
        if embedding.len() as i64 != dim {
            return Ok(None);
        }
        Ok(Some(crate::types::ChunkRow {
            meeting_id: row.get(0)?,
            kind: row.get(1)?,
            text: row.get(2)?,
            embedding,
        }))
    })?;
    let mut out = Vec::new();
    for r in rows {
        if let Some(row) = r? {
            out.push(row);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// People profiles
// ---------------------------------------------------------------------------

/// Look up a person by name, case-insensitively, matching against `people.name`
/// or any comma-separated entry in `aliases`. The table is tiny — load all rows
/// and match in Rust.
pub fn get_person(name: &str) -> anyhow::Result<Option<crate::types::PersonProfile>> {
    let conn = connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, role, company, notes, aliases, email, phone, linkedin FROM people",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(crate::types::PersonProfile {
            id: row.get(0)?,
            name: row.get(1)?,
            role: row.get(2)?,
            company: row.get(3)?,
            notes: row.get(4)?,
            aliases: row.get(5)?,
            email: row.get(6)?,
            phone: row.get(7)?,
            linkedin: row.get(8)?,
        })
    })?;
    let name_lower = name.trim().to_lowercase();
    for row in rows {
        let profile = row?;
        if profile.name.to_lowercase() == name_lower {
            return Ok(Some(profile));
        }
        if !profile.aliases.is_empty() {
            let alias_match = profile
                .aliases
                .split(',')
                .any(|a| a.trim().to_lowercase() == name_lower);
            if alias_match {
                return Ok(Some(profile));
            }
        }
    }
    Ok(None)
}

/// Insert a new person or update the non-name fields of an existing one (case-
/// insensitive match on `name`). Returns the row after the upsert.
// Mirrors the editable profile fields; see `save_person`.
#[allow(clippy::too_many_arguments)]
pub fn upsert_person(
    name: &str,
    role: &str,
    company: &str,
    notes: &str,
    aliases: &str,
    email: &str,
    phone: &str,
    linkedin: &str,
) -> anyhow::Result<crate::types::PersonProfile> {
    let conn = connect()?;
    conn.execute(
        "INSERT INTO people (name, role, company, notes, aliases, email, phone, linkedin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(name) DO UPDATE SET
            role = excluded.role,
            company = excluded.company,
            notes = excluded.notes,
            aliases = excluded.aliases,
            email = excluded.email,
            phone = excluded.phone,
            linkedin = excluded.linkedin",
        params![
            name.trim(),
            role.trim(),
            company.trim(),
            notes.trim(),
            aliases.trim(),
            email.trim(),
            phone.trim(),
            linkedin.trim(),
        ],
    )?;
    // last_insert_rowid() is stale on the UPDATE path — read the row back so
    // the returned id is right for updates too.
    let profile = conn.query_row(
        "SELECT id, name, role, company, notes, aliases, email, phone, linkedin
         FROM people WHERE name = ?1 COLLATE NOCASE",
        params![name.trim()],
        |row| {
            Ok(crate::types::PersonProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                role: row.get(2)?,
                company: row.get(3)?,
                notes: row.get(4)?,
                aliases: row.get(5)?,
                email: row.get(6)?,
                phone: row.get(7)?,
                linkedin: row.get(8)?,
            })
        },
    )?;
    Ok(profile)
}

/// Fill in a person's role/company from what a meeting stated, without ever
/// clobbering something the user typed.
///
/// Creates the row if this is the first time we've heard the name. On an
/// existing row each field is only written when it is currently blank, so a
/// hand-corrected title survives every future summary. Contact details are
/// never touched — they can't come from audio.
pub fn prefill_person(name: &str, role: &str, company: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    prefill_person_on(&conn, name, role, company)
}

fn prefill_person_on(
    conn: &Connection,
    name: &str,
    role: &str,
    company: &str,
) -> anyhow::Result<()> {
    let name = name.trim();
    if name.is_empty() || (role.trim().is_empty() && company.trim().is_empty()) {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO people (name, role, company)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET
            role = CASE WHEN people.role = '' THEN excluded.role ELSE people.role END,
            company = CASE WHEN people.company = '' THEN excluded.company
                           ELSE people.company END",
        params![name, role.trim(), company.trim()],
    )?;
    Ok(())
}

/// Return all people profiles ordered by name.
pub fn get_people() -> anyhow::Result<Vec<crate::types::PersonProfile>> {
    let conn = connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, name, role, company, notes, aliases, email, phone, linkedin
         FROM people ORDER BY name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(crate::types::PersonProfile {
            id: row.get(0)?,
            name: row.get(1)?,
            role: row.get(2)?,
            company: row.get(3)?,
            notes: row.get(4)?,
            aliases: row.get(5)?,
            email: row.get(6)?,
            phone: row.get(7)?,
            linkedin: row.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod encryption_tests {
    use super::*;

    /// A database written before `action_items` existed still migrates.
    ///
    /// Regression: the pre-copy verification counted rows in `action_items` and
    /// `chat_messages` unconditionally, but the encryption migration runs BEFORE
    /// `init_db` creates the schema. Upgrading from the 0.2.x Windows line —
    /// whose `meetings.db` has only `meetings` — therefore failed with
    /// `no such table: action_items`, and the app refused to start while
    /// blaming the macOS keychain. 147 real meetings hit this.
    #[test]
    fn migrate_plaintext_from_a_schema_predating_action_items() {
        let dir = std::env::temp_dir().join(format!("adv-oldschema-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meetings.db");

        // Exactly the old shape: `meetings` and nothing else.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT);
                 INSERT INTO meetings (title) VALUES ('Alpha'), ('Beta');",
            )
            .unwrap();
        }

        let key = random_key_hex();
        migrate_plaintext_to_encrypted(&path, &key)
            .expect("a pre-action_items database must still migrate");

        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))
            .unwrap();
        let meetings: i64 = conn
            .query_row("SELECT count(*) FROM meetings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(meetings, 2, "no meeting may be lost by the migration");
        // The absent tables stay absent; init_db creates them afterwards.
        assert_eq!(table_count(&conn, "action_items").unwrap(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `table_count` reports 0 for an absent table and the real count otherwise.
    #[test]
    fn table_count_tolerates_a_missing_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meetings (id INTEGER PRIMARY KEY); INSERT INTO meetings DEFAULT VALUES;",
        )
        .unwrap();
        assert_eq!(table_count(&conn, "meetings").unwrap(), 1);
        assert_eq!(table_count(&conn, "action_items").unwrap(), 0);
    }

    /// A plaintext DB is migrated to SQLCipher in place: row counts are
    /// preserved, the result needs the key, and a plaintext backup is kept.
    #[test]
    fn migrate_plaintext_roundtrip() {
        let dir = std::env::temp_dir().join(format!("adv-enc-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meetings.db");

        // Build a plaintext DB (no PRAGMA key) with rows in each table.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT);
                 CREATE TABLE action_items (id INTEGER PRIMARY KEY, meeting_id INTEGER);
                 CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, meeting_id INTEGER);
                 INSERT INTO meetings (title) VALUES ('Alpha'), ('Beta'), ('Gamma');
                 INSERT INTO action_items (meeting_id) VALUES (1), (2);
                 INSERT INTO chat_messages (meeting_id) VALUES (1);",
            )
            .unwrap();
        }

        let key = random_key_hex();
        migrate_plaintext_to_encrypted(&path, &key).unwrap();

        // Opening WITH the key works and preserved every row.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))
                .unwrap();
            let m: i64 = conn
                .query_row("SELECT count(*) FROM meetings", [], |r| r.get(0))
                .unwrap();
            let a: i64 = conn
                .query_row("SELECT count(*) FROM action_items", [], |r| r.get(0))
                .unwrap();
            let c: i64 = conn
                .query_row("SELECT count(*) FROM chat_messages", [], |r| r.get(0))
                .unwrap();
            assert_eq!((m, a, c), (3, 2, 1));
        }

        // Opening WITHOUT the key must fail — proves the file is encrypted.
        {
            let conn = Connection::open(&path).unwrap();
            assert!(
                conn.query_row("SELECT count(*) FROM meetings", [], |r| r.get::<_, i64>(0))
                    .is_err(),
                "encrypted DB must not be readable without the key"
            );
        }

        // The plaintext backup is kept and still readable.
        let backup = dir.join("meetings.db.pre-encrypt-backup");
        assert!(backup.exists(), "plaintext backup should be kept");
        {
            let conn = Connection::open(&backup).unwrap();
            let m: i64 = conn
                .query_row("SELECT count(*) FROM meetings", [], |r| r.get(0))
                .unwrap();
            assert_eq!(m, 3);
        }

        // A second run is a no-op (already encrypted, not re-migrated).
        migrate_plaintext_to_encrypted(&path, &key).unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An encrypted DB is decrypted back to plaintext in place: row counts are
    /// preserved, the result opens WITHOUT a key, and an encrypted backup is kept.
    #[test]
    fn migrate_decrypt_roundtrip() {
        let dir = std::env::temp_dir().join(format!("adv-dec-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meetings.db");

        // Build a plaintext DB, then encrypt it (the state encryption-on leaves).
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT);
                 CREATE TABLE action_items (id INTEGER PRIMARY KEY, meeting_id INTEGER);
                 CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, meeting_id INTEGER);
                 INSERT INTO meetings (title) VALUES ('Alpha'), ('Beta'), ('Gamma');
                 INSERT INTO action_items (meeting_id) VALUES (1), (2);
                 INSERT INTO chat_messages (meeting_id) VALUES (1);",
            )
            .unwrap();
        }
        let key = random_key_hex();
        migrate_plaintext_to_encrypted(&path, &key).unwrap();

        // Now decrypt it back.
        migrate_encrypted_to_plaintext(&path, &key).unwrap();

        // Opening WITHOUT a key works and preserved every row.
        {
            let conn = Connection::open(&path).unwrap();
            let m: i64 = conn
                .query_row("SELECT count(*) FROM meetings", [], |r| r.get(0))
                .unwrap();
            let a: i64 = conn
                .query_row("SELECT count(*) FROM action_items", [], |r| r.get(0))
                .unwrap();
            let c: i64 = conn
                .query_row("SELECT count(*) FROM chat_messages", [], |r| r.get(0))
                .unwrap();
            assert_eq!((m, a, c), (3, 2, 1));
        }

        // The encrypted backup is kept and still needs the key.
        let backup = dir.join("meetings.db.pre-decrypt-backup");
        assert!(backup.exists(), "encrypted backup should be kept");
        {
            let conn = Connection::open(&backup).unwrap();
            assert!(
                conn.query_row("SELECT count(*) FROM meetings", [], |r| r.get::<_, i64>(0))
                    .is_err(),
                "encrypted backup must not be readable without the key"
            );
        }

        // A second run is a no-op (already plaintext — key unused).
        migrate_encrypted_to_plaintext(&path, &key).unwrap();
        {
            let conn = Connection::open(&path).unwrap();
            let m: i64 = conn
                .query_row("SELECT count(*) FROM meetings", [], |r| r.get(0))
                .unwrap();
            assert_eq!(m, 3);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Faithful migration check against a real database. Skipped unless
    /// `ADV_REAL_DB` points at a (copy of a) plaintext meetings.db. Verifies
    /// every meeting/action/chat row survives and the result needs the key.
    /// Run: `ADV_REAL_DB=/tmp/real.db cargo test migrate_real_db -- --ignored`
    #[test]
    #[ignore]
    fn migrate_real_db() {
        let Ok(src_path) = std::env::var("ADV_REAL_DB") else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("adv-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meetings.db");
        std::fs::copy(&src_path, &path).unwrap();

        let before = {
            let c = Connection::open(&path).unwrap();
            (
                c.query_row("SELECT count(*) FROM meetings", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                c.query_row("SELECT count(*) FROM action_items", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
                c.query_row("SELECT count(*) FROM chat_messages", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
            )
        };

        let key = random_key_hex();
        migrate_plaintext_to_encrypted(&path, &key).unwrap();

        let c = Connection::open(&path).unwrap();
        c.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))
            .unwrap();
        let after = (
            c.query_row("SELECT count(*) FROM meetings", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            c.query_row("SELECT count(*) FROM action_items", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
            c.query_row("SELECT count(*) FROM chat_messages", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        );
        assert_eq!(before, after, "row counts must survive migration");
        eprintln!("[real-db test] preserved meetings/actions/chats = {after:?}");

        let plain = Connection::open(&path).unwrap();
        assert!(
            plain
                .query_row("SELECT count(*) FROM meetings", [], |r| r.get::<_, i64>(0))
                .is_err(),
            "migrated real DB must require the key"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A fresh install (no DB file yet) is a no-op, not an error.
    #[test]
    fn migrate_noop_when_missing() {
        let dir = std::env::temp_dir().join(format!("adv-enc-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meetings.db");
        migrate_plaintext_to_encrypted(&path, &random_key_hex()).unwrap();
        assert!(
            !path.exists(),
            "migration must not create a DB for a fresh install"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person_rename_conn(
        transcript: &str,
        turns: &[crate::types::TranscriptTurn],
        summary: &str,
        attendees: &[String],
        action_text: &str,
        action_assignee: &str,
    ) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meetings (
                 id INTEGER PRIMARY KEY,
                 transcript TEXT NOT NULL,
                 transcript_turns TEXT NOT NULL,
                 summary TEXT NOT NULL,
                 attendees TEXT NOT NULL
             );
             CREATE TABLE action_items (
                 id INTEGER PRIMARY KEY,
                 meeting_id INTEGER NOT NULL,
                 text TEXT NOT NULL,
                 assignee TEXT NOT NULL
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO meetings (id, transcript, transcript_turns, summary, attendees)
             VALUES (1, ?1, ?2, ?3, ?4)",
            params![
                transcript,
                encode_transcript_turns(turns),
                summary,
                encode_attendees(attendees)
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO action_items (id, meeting_id, text, assignee)
             VALUES (10, 1, ?1, ?2)",
            params![action_text, action_assignee],
        )
        .unwrap();
        conn
    }

    fn renamed_meeting(
        conn: &Connection,
    ) -> (
        String,
        Vec<crate::types::TranscriptTurn>,
        String,
        Vec<String>,
    ) {
        conn.query_row(
            "SELECT transcript, transcript_turns, summary, attendees FROM meetings WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    decode_transcript_turns(&row.get::<_, String>(1)?),
                    row.get(2)?,
                    decode_attendees(&row.get::<_, String>(3)?),
                ))
            },
        )
        .unwrap()
    }

    #[test]
    fn rename_person_rewrites_every_saved_meeting_reference() {
        let turns = vec![crate::types::TranscriptTurn {
            speaker: "Dhanesh".into(),
            text: "Ask dhanesh to review the plan.".into(),
            start: Some(1.0),
            end: Some(3.0),
        }];
        let conn = person_rename_conn(
            "Dhanesh: Flat text asks DHANESH to review.",
            &turns,
            "Dhanesh owns the notes; ping dhanesh tomorrow.",
            &["Alice".into(), "DHANESH".into()],
            "Dhanesh will send the notes to dhanesh.",
            "dHaNeSh",
        );

        rename_meeting_person_on(&conn, 1, "dhanesh", "Danish").unwrap();

        let (transcript, turns, summary, attendees) = renamed_meeting(&conn);
        assert_eq!(transcript, "Danish: Flat text asks Danish to review.");
        assert_eq!(turns[0].speaker, "Danish");
        assert_eq!(turns[0].text, "Ask Danish to review the plan.");
        assert_eq!(summary, "Danish owns the notes; ping Danish tomorrow.");
        assert_eq!(attendees, vec!["Alice", "Danish"]);
        let action: (String, String) = conn
            .query_row(
                "SELECT text, assignee FROM action_items WHERE id = 10",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(action.0, "Danish will send the notes to Danish.");
        assert_eq!(action.1, "Danish");
    }

    #[test]
    fn rename_person_holds_word_boundaries() {
        let turns = vec![crate::types::TranscriptTurn {
            speaker: "Danish".into(),
            text: "Danish approved it.".into(),
            start: None,
            end: None,
        }];
        let conn = person_rename_conn(
            "Danish: Danish approved it.",
            &turns,
            "Danish owns it.",
            &["Danish".into()],
            "Ask Danish to approve.",
            "Danish",
        );

        rename_meeting_person_on(&conn, 1, "Dan", "Daniel").unwrap();

        let (transcript, turns, summary, attendees) = renamed_meeting(&conn);
        assert_eq!(transcript, "Danish: Danish approved it.");
        assert_eq!(turns[0].speaker, "Danish");
        assert_eq!(turns[0].text, "Danish approved it.");
        assert_eq!(summary, "Danish owns it.");
        assert_eq!(attendees, vec!["Danish"]);
        let action: (String, String) = conn
            .query_row(
                "SELECT text, assignee FROM action_items WHERE id = 10",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(action, ("Ask Danish to approve.".into(), "Danish".into()));
    }

    #[test]
    fn rename_person_matches_source_case_insensitively() {
        let turns = vec![crate::types::TranscriptTurn {
            speaker: "Dhanesh".into(),
            text: "dhanesh met Dhanesh.".into(),
            start: None,
            end: None,
        }];
        let conn = person_rename_conn("dhanesh met Dhanesh.", &turns, "", &[], "", "");

        rename_meeting_person_on(&conn, 1, "dhanesh", "Danish").unwrap();

        let (transcript, turns, _, _) = renamed_meeting(&conn);
        assert_eq!(transcript, "Danish met Danish.");
        assert_eq!(turns[0].speaker, "Danish");
        assert_eq!(turns[0].text, "Danish met Danish.");
    }

    #[test]
    fn rename_person_inserts_dollar_signs_literally() {
        let turns = vec![crate::types::TranscriptTurn {
            speaker: "dhanesh".into(),
            text: "dhanesh owns this.".into(),
            start: None,
            end: None,
        }];
        let conn = person_rename_conn(
            "dhanesh owns this.",
            &turns,
            "Ask dhanesh.",
            &["dhanesh".into()],
            "Notify dhanesh.",
            "dhanesh",
        );

        rename_meeting_person_on(&conn, 1, "dhanesh", "Da$h").unwrap();

        let (transcript, turns, summary, attendees) = renamed_meeting(&conn);
        assert_eq!(transcript, "Da$h owns this.");
        assert_eq!(turns[0].speaker, "Da$h");
        assert_eq!(turns[0].text, "Da$h owns this.");
        assert_eq!(summary, "Ask Da$h.");
        assert_eq!(attendees, vec!["Da$h"]);
        let action: (String, String) = conn
            .query_row(
                "SELECT text, assignee FROM action_items WHERE id = 10",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(action, ("Notify Da$h.".into(), "Da$h".into()));
    }

    #[test]
    fn rename_person_dedupes_attendee_collisions_in_order() {
        let conn = person_rename_conn(
            "",
            &[],
            "",
            &["Alice".into(), "dhanesh".into(), "Danish".into()],
            "",
            "",
        );

        rename_meeting_person_on(&conn, 1, "dhanesh", "Danish").unwrap();

        let (_, _, _, attendees) = renamed_meeting(&conn);
        assert_eq!(attendees, vec!["Alice", "Danish"]);
    }

    #[test]
    fn parse_exact_format() {
        let input = "Them: Thank you.\nHamza: What is happening? This is just a test.";
        let turns = parse_transcript_turns(input);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].speaker, "Them");
        assert_eq!(turns[0].text, "Thank you.");
        assert_eq!(turns[1].speaker, "Hamza");
        assert_eq!(turns[1].text, "What is happening? This is just a test.");
    }

    #[test]
    fn parse_continuation_line() {
        let input = "Hamza: This is\njust a test.\nThem: Okay.";
        let turns = parse_transcript_turns(input);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].speaker, "Hamza");
        assert_eq!(turns[0].text, "This is just a test.");
        assert_eq!(turns[1].speaker, "Them");
        assert_eq!(turns[1].text, "Okay.");
    }

    #[test]
    fn parse_empty() {
        let turns = parse_transcript_turns("");
        assert!(turns.is_empty());
    }

    #[test]
    fn collapse_speaker_turns_merges_diarized_labels_into_them() {
        // The "14 speakers in a 2-person call" cleanup: every Speaker N line
        // becomes Them, and now-adjacent Them turns join into one.
        let input = "Me: Hello everyone.\n\
                     Speaker 1: First voice.\n\
                     Speaker 13: Same voice, phantom cluster.\n\
                     Me: Right.\n\
                     Speaker 2: Another line.\n\
                     Them: Already flat.";
        let (flat, turns) = collapse_speaker_turns(input);
        assert_eq!(
            flat,
            "Me: Hello everyone.\n\
             Them: First voice. Same voice, phantom cluster.\n\
             Me: Right.\n\
             Them: Another line. Already flat."
        );
        assert_eq!(turns.len(), 4);
        assert!(turns
            .iter()
            .all(|t| t.speaker == "Me" || t.speaker == "Them"));
    }

    #[test]
    fn collapse_speaker_turns_leaves_named_speakers_alone() {
        // Real names (user_name relabeling) and plain Me/Them are untouched.
        let input = "Hamza: Hi.\nBasim: Hey.\nThem: Ok.";
        let (flat, turns) = collapse_speaker_turns(input);
        assert_eq!(flat, input);
        assert_eq!(turns.len(), 3);
    }

    #[test]
    fn parse_no_speaker() {
        let input = "Just a line without a colon separator.";
        let turns = parse_transcript_turns(input);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].speaker, "");
        assert_eq!(turns[0].text, "Just a line without a colon separator.");
    }

    #[test]
    fn parse_continuation_at_start() {
        let input = "continuation line\nHamza: Hello.";
        let turns = parse_transcript_turns(input);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].speaker, "");
        assert_eq!(turns[0].text, "continuation line");
        assert_eq!(turns[1].speaker, "Hamza");
        assert_eq!(turns[1].text, "Hello.");
    }

    #[test]
    fn parse_multiple_continuations() {
        let input = "Them: Line one\ncontinuation one\ncontinuation two\nHamza: Reply.";
        let turns = parse_transcript_turns(input);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].speaker, "Them");
        assert_eq!(turns[0].text, "Line one continuation one continuation two");
        assert_eq!(turns[1].speaker, "Hamza");
        assert_eq!(turns[1].text, "Reply.");
    }

    #[test]
    fn parse_colon_in_text() {
        // Only split on the FIRST ": " — a colon in the text is kept.
        let input = "Hamza: Let's talk about A: and B: items.";
        let turns = parse_transcript_turns(input);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].speaker, "Hamza");
        assert_eq!(turns[0].text, "Let's talk about A: and B: items.");
    }

    #[test]
    fn parse_colon_without_space_is_text() {
        // "word:word" is not a speaker separator — only ": " (colon+space) is.
        let input = "Hamza: Look at 10:30.";
        let turns = parse_transcript_turns(input);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].speaker, "Hamza");
        assert_eq!(turns[0].text, "Look at 10:30.");
    }

    // Action-item extraction tests live in `action_item_tests` above (they cover
    // the REAL summary format: bullets under an actionable **Heading**).

    /// A `people` table matching the live schema, for prefill tests.
    fn people_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE people (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                 role TEXT NOT NULL DEFAULT '',
                 company TEXT NOT NULL DEFAULT '',
                 notes TEXT NOT NULL DEFAULT '',
                 aliases TEXT NOT NULL DEFAULT '',
                 email TEXT NOT NULL DEFAULT '',
                 phone TEXT NOT NULL DEFAULT '',
                 linkedin TEXT NOT NULL DEFAULT ''
             );",
        )
        .unwrap();
        conn
    }

    fn person_row(conn: &Connection, name: &str) -> (String, String, String) {
        conn.query_row(
            "SELECT role, company, email FROM people WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    #[test]
    fn prefill_creates_a_profile_the_first_time_a_name_is_heard() {
        let conn = people_conn();
        prefill_person_on(&conn, "Sarah", "CTO", "Fluence Pay").unwrap();
        assert_eq!(
            person_row(&conn, "Sarah"),
            ("CTO".into(), "Fluence Pay".into(), String::new())
        );
    }

    #[test]
    fn prefill_never_overwrites_what_the_user_typed() {
        let conn = people_conn();
        // The user corrected the title and added an email by hand.
        conn.execute(
            "INSERT INTO people (name, role, company, email)
             VALUES ('Sarah', 'Co-founder & CTO', '', 'sarah@fluence.test')",
            [],
        )
        .unwrap();

        // A later meeting says something different — the hand-edit must win,
        // while the blank company is still filled in.
        prefill_person_on(&conn, "Sarah", "CTO", "Fluence Pay").unwrap();

        assert_eq!(
            person_row(&conn, "Sarah"),
            (
                "Co-founder & CTO".into(),
                "Fluence Pay".into(),
                "sarah@fluence.test".into()
            )
        );
    }

    #[test]
    fn prefill_ignores_empty_input_instead_of_creating_blank_rows() {
        let conn = people_conn();
        prefill_person_on(&conn, "Nobody", "", "").unwrap();
        prefill_person_on(&conn, "   ", "CTO", "Acme").unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM people", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn prefill_matches_an_existing_name_case_insensitively() {
        let conn = people_conn();
        conn.execute("INSERT INTO people (name) VALUES ('Dan')", [])
            .unwrap();
        prefill_person_on(&conn, "dan", "Engineer", "Acme").unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM people", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "should update the existing row, not add a second");
        assert_eq!(
            person_row(&conn, "Dan"),
            ("Engineer".into(), "Acme".into(), String::new())
        );
    }

    #[test]
    fn init_recovers_when_fts_update_trigger_hits_corruption() {
        // Reproduce the startup-brick: an FTS index missing a row's posting makes
        // the keep-in-sync UPDATE trigger raise SQLITE_CORRUPT_VTAB. The M1/M2
        // backfills do exactly such an UPDATE, so this used to crash on launch.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meetings (
                 id INTEGER PRIMARY KEY,
                 title TEXT NOT NULL DEFAULT '',
                 summary TEXT NOT NULL DEFAULT '',
                 transcript TEXT NOT NULL DEFAULT '',
                 transcript_turns TEXT NOT NULL DEFAULT '[]'
             );
             INSERT INTO meetings (id,title,summary,transcript)
             VALUES (1,'Standup','We shipped','Them: hello');",
        )
        .unwrap();
        setup_fts(&conn).unwrap(); // index has row 1, triggers installed

        // Insert row 2 WITHOUT firing the insert trigger → its posting is missing,
        // leaving the external-content index out of sync (the real corruption).
        conn.execute_batch("DROP TRIGGER meetings_fts_ai;").unwrap();
        conn.execute(
            "INSERT INTO meetings (id,title,summary,transcript) VALUES (2,'Sync','Plan','Me: ok')",
            [],
        )
        .unwrap();
        setup_fts(&conn).unwrap(); // restore the insert trigger (no rebuild)

        // A trigger-firing UPDATE on the un-indexed row raises corruption, and
        // is_db_corruption() must classify it so init_db triggers recovery.
        let err = conn
            .execute("UPDATE meetings SET title='Sync 2' WHERE id=2", [])
            .unwrap_err();
        let any = anyhow::Error::from(err);
        assert!(
            is_db_corruption(&any),
            "expected SQLITE_CORRUPT_VTAB, got {any:?}"
        );

        // The fix: drop the derived index + triggers, retry — now the UPDATE works.
        drop_fts(&conn);
        conn.execute("UPDATE meetings SET title='Sync 2' WHERE id=2", [])
            .unwrap();

        // setup_fts rebuilds a clean, consistent index over all content.
        setup_fts(&conn).unwrap();
        conn.execute_batch("INSERT INTO meetings_fts(meetings_fts) VALUES('integrity-check');")
            .expect("index consistent after rebuild");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM meetings_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn pin_update_skips_fts_and_survives_a_bad_index() {
        // The user's bug: set_meeting_pinned does `UPDATE meetings SET pinned=…`,
        // and the OLD `_au` trigger fired on EVERY column → it hit a corrupt FTS
        // index → "database disk image is malformed". The scoped trigger (AFTER
        // UPDATE OF title,summary,transcript) means pinning never touches FTS.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meetings (
                 id INTEGER PRIMARY KEY,
                 title TEXT NOT NULL DEFAULT '',
                 summary TEXT NOT NULL DEFAULT '',
                 transcript TEXT NOT NULL DEFAULT '',
                 transcript_turns TEXT NOT NULL DEFAULT '[]',
                 pinned INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO meetings (id,title,summary,transcript)
             VALUES (1,'Standup','We shipped','Them: hello');",
        )
        .unwrap();
        setup_fts(&conn).unwrap();

        // Make the index inconsistent: add a row whose posting was never indexed.
        conn.execute_batch("DROP TRIGGER meetings_fts_ai;").unwrap();
        conn.execute(
            "INSERT INTO meetings (id,title,summary,transcript) VALUES (2,'Sync','Plan','Me: ok')",
            [],
        )
        .unwrap();
        setup_fts(&conn).unwrap(); // restore the insert trigger (no rebuild)

        // A title change on the un-indexed row DOES fire the scoped _au → corrupt.
        assert!(
            conn.execute("UPDATE meetings SET title='Sync 2' WHERE id=2", [])
                .is_err(),
            "title update should fire the FTS trigger and hit the bad index"
        );

        // But pinning (a non-indexed column) must NOT fire _au → succeeds even with
        // the bad index. This is exactly what was failing for the user.
        conn.execute("UPDATE meetings SET pinned=1 WHERE id=2", [])
            .expect("pin update must not touch FTS");

        // And repair_fts() heals the index so even title edits / deletes work again.
        repair_fts(&conn);
        setup_fts(&conn).unwrap();
        conn.execute("UPDATE meetings SET title='Sync 3' WHERE id=2", [])
            .expect("title update works after repair_fts");
    }
}

#[cfg(test)]
mod chunk_tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let v: Vec<f32> = vec![0.0, 1.5, -3.25, std::f32::consts::PI];
        let encoded = encode_f32(&v);
        let decoded = decode_f32(&encoded);
        assert_eq!(decoded.len(), v.len());
        for (a, b) in v.iter().zip(decoded.iter()) {
            assert!((a - b).abs() < 1e-6, "mismatch: {a} vs {b}");
        }
    }

    #[test]
    fn encode_decode_empty() {
        let v: Vec<f32> = vec![];
        let encoded = encode_f32(&v);
        assert!(encoded.is_empty());
        let decoded = decode_f32(&encoded);
        assert!(decoded.is_empty());
    }

    #[test]
    fn encode_decode_negative_values() {
        let v: Vec<f32> = vec![-1.0, -0.5, 0.0, 0.5, 1.0];
        let encoded = encode_f32(&v);
        let decoded = decode_f32(&encoded);
        assert_eq!(decoded.len(), v.len());
        for (a, b) in v.iter().zip(decoded.iter()) {
            assert!((a - b).abs() < 1e-6, "mismatch: {a} vs {b}");
        }
    }
}
