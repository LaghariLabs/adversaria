//! SQLite-backed meeting store.
//!
//! Uses `rusqlite` with a bundled SQLite to persist `Meeting` records.
//! The database lives at `<app-data>/meeting-note-taker/meetings.db`.

use std::path::PathBuf;
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension};

use crate::types::{
    ActionItem, ContextChunkRow, ContextDoc, Folder, FolderSummary, Meeting, MeetingAttachment,
    MeetingFolder, MeetingWorkspaceBinding, OnboardingState, RegistrationState, TaskStaffing,
    Workspace, WorkspaceAddon, WorkspaceArtifact, WorkspaceContextItem, WorkspaceDetail,
    WorkspaceRun, WorkspaceSummary, WorkspaceTask,
};

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
        CREATE TABLE IF NOT EXISTS meeting_attachments (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id INTEGER NOT NULL,
            kind       TEXT    NOT NULL CHECK(kind IN ('file','meeting')),
            value      TEXT    NOT NULL,
            label      TEXT    NOT NULL DEFAULT '',
            created_at TEXT    NOT NULL
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
        CREATE TABLE IF NOT EXISTS context_docs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source      TEXT    NOT NULL CHECK(source IN ('vault','project')),
            path        TEXT    NOT NULL UNIQUE,
            name        TEXT    NOT NULL DEFAULT '',
            title       TEXT    NOT NULL,
            body        TEXT    NOT NULL,
            fingerprint TEXT    NOT NULL,
            updated_at  TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS context_chunks (
            doc_id      INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            text        TEXT    NOT NULL,
            embedding   BLOB    NOT NULL,
            dim         INTEGER NOT NULL,
            model       TEXT    NOT NULL,
            PRIMARY KEY (doc_id, chunk_index)
        );
        CREATE INDEX IF NOT EXISTS idx_context_chunks_doc ON context_chunks(doc_id);
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
        );
        CREATE TABLE IF NOT EXISTS workspaces (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            engine      TEXT    NOT NULL DEFAULT 'local',
            model       TEXT    NOT NULL DEFAULT '',
            network_allowed INTEGER NOT NULL DEFAULT 0,
            instructions TEXT   NOT NULL DEFAULT '',
            color       TEXT    NOT NULL DEFAULT 'blue',
            overview TEXT NOT NULL DEFAULT '',
            overview_source_hash TEXT NOT NULL DEFAULT '',
            overview_generated_at TEXT NOT NULL DEFAULT '',
            created_at  TEXT    NOT NULL,
            updated_at  TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_context_items (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL,
            kind         TEXT    NOT NULL CHECK(kind IN ('folder','meeting','file')),
            value        TEXT    NOT NULL,
            label        TEXT    NOT NULL,
            created_at   TEXT    NOT NULL,
            UNIQUE(workspace_id, kind, value)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_context_ws ON workspace_context_items(workspace_id);
        CREATE TABLE IF NOT EXISTS workspace_addons (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            kind         TEXT    NOT NULL CHECK(kind IN ('skill','agent')),
            slug         TEXT    NOT NULL UNIQUE,
            name         TEXT    NOT NULL,
            description  TEXT    NOT NULL DEFAULT '',
            instructions TEXT    NOT NULL DEFAULT '',
            builtin      INTEGER NOT NULL DEFAULT 0,
            created_at   TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_addon_links (
            workspace_id INTEGER NOT NULL,
            addon_id     INTEGER NOT NULL,
            created_at   TEXT    NOT NULL,
            PRIMARY KEY (workspace_id, addon_id)
        );
        CREATE TABLE IF NOT EXISTS workspace_tasks (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id      INTEGER NOT NULL,
            title             TEXT    NOT NULL,
            details           TEXT    NOT NULL DEFAULT '',
            capability        TEXT    NOT NULL DEFAULT '',
            status            TEXT    NOT NULL DEFAULT 'queued'
                              CHECK(status IN ('queued','running','awaiting_review','done','failed')),
            source_meeting_id INTEGER,
            action_item_id    INTEGER,
            attempt           INTEGER NOT NULL DEFAULT 1,
            rejection_notes   TEXT    NOT NULL DEFAULT '[]',
            agent_eligible    INTEGER NOT NULL DEFAULT 1,
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_tasks_ws ON workspace_tasks(workspace_id);
        CREATE TABLE IF NOT EXISTS workspace_task_staffing (
            task_id     INTEGER PRIMARY KEY,
            mode        TEXT    NOT NULL CHECK(mode IN ('automatic','manual')),
            agent_id    INTEGER,
            skill_ids   TEXT    NOT NULL DEFAULT '[]',
            reason      TEXT    NOT NULL DEFAULT '',
            resolved_at TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_runs (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL,
            task_id      INTEGER NOT NULL,
            engine       TEXT    NOT NULL,
            status       TEXT    NOT NULL DEFAULT 'running'
                         CHECK(status IN ('running','done','failed','stopped')),
            log          TEXT    NOT NULL DEFAULT '',
            report       TEXT    NOT NULL DEFAULT '',
            error        TEXT    NOT NULL DEFAULT '',
            started_at   TEXT    NOT NULL,
            finished_at  TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_runs_task ON workspace_runs(task_id);
        CREATE TABLE IF NOT EXISTS workspace_artifacts (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL,
            run_id       INTEGER NOT NULL,
            name         TEXT    NOT NULL,
            path         TEXT    NOT NULL,
            created_at   TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_ws ON workspace_artifacts(workspace_id);
        CREATE TABLE IF NOT EXISTS meeting_workspace_bindings (
            meeting_id   INTEGER PRIMARY KEY,
            workspace_id INTEGER,
            created_at   TEXT    NOT NULL,
            updated_at   TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS folders (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT    NOT NULL,
            color        TEXT    NOT NULL DEFAULT 'blue',
            instructions TEXT    NOT NULL DEFAULT '',
            created_at   TEXT    NOT NULL,
            updated_at   TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meeting_folders (
            meeting_id INTEGER PRIMARY KEY,
            folder_id  INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS folder_overviews (
            folder_id    INTEGER PRIMARY KEY,
            summary      TEXT NOT NULL,
            source_hash  TEXT NOT NULL,
            generated_at TEXT NOT NULL
        );",
    )?;

    seed_builtin_addons_on(&conn)?;
    migrate_workspace_tasks_v2(&conn)?;
    migrate_workspace_task_agent_eligibility(&conn)?;
    migrate_workspace_task_capability(&conn)?;
    migrate_workspace_model(&conn)?;
    if !column_exists(&conn, "workspace_runs", "report")? {
        conn.execute(
            "ALTER TABLE workspace_runs ADD COLUMN report TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(&conn, "workspaces", "instructions")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN instructions TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(&conn, "workspaces", "color")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN color TEXT NOT NULL DEFAULT 'blue'",
            [],
        )?;
    }
    if !column_exists(&conn, "workspaces", "overview")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN overview TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(&conn, "workspaces", "overview_source_hash")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN overview_source_hash TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(&conn, "workspaces", "overview_generated_at")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN overview_generated_at TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    migrate_workspace_bindings_to_folders(&conn)?;
    migrate_context_docs_name(&conn)?;

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
    if let Err(e) = setup_context_fts(&conn) {
        eprintln!("Warning: context FTS5 index unavailable: {e}");
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

/// Create the external-content FTS index for vault notes and project cards,
/// install keep-in-sync triggers, and backfill rows created before the index.
fn setup_context_fts(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
            title, name, body, content='context_docs', content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS context_fts_ai AFTER INSERT ON context_docs BEGIN
            INSERT INTO context_fts(rowid, title, name, body)
            VALUES (new.id, new.title, new.name, new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS context_fts_ad AFTER DELETE ON context_docs BEGIN
            INSERT INTO context_fts(context_fts, rowid, title, name, body)
            VALUES ('delete', old.id, old.title, old.name, old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS context_fts_au AFTER UPDATE OF title, name, body ON context_docs BEGIN
            INSERT INTO context_fts(context_fts, rowid, title, name, body)
            VALUES ('delete', old.id, old.title, old.name, old.body);
            INSERT INTO context_fts(rowid, title, name, body)
            VALUES (new.id, new.title, new.name, new.body);
        END;
        INSERT INTO context_fts(context_fts) VALUES('rebuild');",
    )?;
    Ok(())
}

fn fts_match_expression(query: &str) -> String {
    query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.len() >= 2)
        .map(|word| format!("\"{word}\""))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Return meeting ids ranked by FTS5 relevance to `query` (best matches first).
/// Returns Err if FTS5 is unavailable; the caller falls back to keyword ranking.
pub fn search_meeting_ids(query: &str, limit: usize) -> anyhow::Result<Vec<i64>> {
    // Build a safe FTS MATCH expression: quote each term, OR them for recall.
    let match_expr = fts_match_expression(query);
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

/// Copy the former Meetings-side workspace filing state into independent folders once.
/// The transaction matters: a partial copy must never leave `folders` non-empty and
/// suppress the remaining migration on the next launch.
fn migrate_workspace_bindings_to_folders(conn: &Connection) -> anyhow::Result<()> {
    let folder_count: i64 = conn.query_row("SELECT COUNT(*) FROM folders", [], |row| row.get(0))?;
    let bound_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM meeting_workspace_bindings WHERE workspace_id IS NOT NULL",
        [],
        |row| row.get(0),
    )?;
    if folder_count != 0 || bound_count == 0 {
        return Ok(());
    }

    let transaction = conn.unchecked_transaction()?;
    let workspaces = {
        let mut statement = transaction.prepare(
            "SELECT DISTINCT w.id, w.name, w.color, w.instructions, w.created_at, w.updated_at,
                    w.overview, w.overview_source_hash, w.overview_generated_at
               FROM workspaces w
               JOIN meeting_workspace_bindings b ON b.workspace_id = w.id
              WHERE b.workspace_id IS NOT NULL
              ORDER BY w.id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut folder_by_workspace = std::collections::HashMap::new();
    for (
        workspace_id,
        name,
        color,
        instructions,
        created_at,
        updated_at,
        overview,
        source_hash,
        generated_at,
    ) in workspaces
    {
        transaction.execute(
            "INSERT INTO folders (name, color, instructions, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, color, instructions, created_at, updated_at],
        )?;
        let folder_id = transaction.last_insert_rowid();
        folder_by_workspace.insert(workspace_id, folder_id);
        if !overview.is_empty() || !source_hash.is_empty() || !generated_at.is_empty() {
            transaction.execute(
                "INSERT INTO folder_overviews (folder_id, summary, source_hash, generated_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![folder_id, overview, source_hash, generated_at],
            )?;
        }
    }

    let bindings = {
        let mut statement = transaction.prepare(
            "SELECT meeting_id, workspace_id, created_at, updated_at
               FROM meeting_workspace_bindings
              ORDER BY meeting_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (meeting_id, workspace_id, created_at, updated_at) in bindings {
        let folder_id = workspace_id.and_then(|id| folder_by_workspace.get(&id).copied());
        transaction.execute(
            "INSERT INTO meeting_folders (meeting_id, folder_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![meeting_id, folder_id, created_at, updated_at],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

/// Rebuild the workspace task table so its status CHECK and review columns are current.
fn migrate_workspace_tasks_v2(conn: &Connection) -> anyhow::Result<()> {
    if column_exists(conn, "workspace_tasks", "action_item_id")? {
        return Ok(());
    }
    conn.execute_batch(
        "CREATE TABLE workspace_tasks_v2 (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id      INTEGER NOT NULL,
            title             TEXT    NOT NULL,
            details           TEXT    NOT NULL DEFAULT '',
            capability        TEXT    NOT NULL DEFAULT '',
            status            TEXT    NOT NULL DEFAULT 'queued'
                              CHECK(status IN ('queued','running','awaiting_review','done','failed')),
            source_meeting_id INTEGER,
            action_item_id    INTEGER,
            attempt           INTEGER NOT NULL DEFAULT 1,
            rejection_notes   TEXT    NOT NULL DEFAULT '[]',
            created_at        TEXT    NOT NULL,
            updated_at        TEXT    NOT NULL
        );
        INSERT INTO workspace_tasks_v2
            (id, workspace_id, title, details, status, source_meeting_id, created_at, updated_at)
        SELECT id, workspace_id, title, details, status, source_meeting_id, created_at, updated_at
          FROM workspace_tasks;
        DROP TABLE workspace_tasks;
        ALTER TABLE workspace_tasks_v2 RENAME TO workspace_tasks;
        CREATE INDEX IF NOT EXISTS idx_workspace_tasks_ws ON workspace_tasks(workspace_id);",
    )?;
    Ok(())
}

/// Add the autopilot eligibility flag without rebuilding the current task table.
fn migrate_workspace_task_agent_eligibility(conn: &Connection) -> anyhow::Result<()> {
    if !column_exists(conn, "workspace_tasks", "agent_eligible")? {
        conn.execute(
            "ALTER TABLE workspace_tasks
             ADD COLUMN agent_eligible INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    Ok(())
}

/// Add the user-selected AI capability without rebuilding the current task table.
fn migrate_workspace_task_capability(conn: &Connection) -> anyhow::Result<()> {
    if !column_exists(conn, "workspace_tasks", "capability")? {
        conn.execute(
            "ALTER TABLE workspace_tasks
             ADD COLUMN capability TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

/// Add the per-workspace local model override without rebuilding the workspace table.
fn migrate_workspace_model(conn: &Connection) -> anyhow::Result<()> {
    if !column_exists(conn, "workspaces", "model")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN model TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

/// Add the display/search name and replace the old two-column FTS table. The
/// derived index is recreated by `setup_context_fts` after migrations finish.
fn migrate_context_docs_name(conn: &Connection) -> anyhow::Result<()> {
    if !column_exists(conn, "context_docs", "name")? {
        conn.execute(
            "ALTER TABLE context_docs ADD COLUMN name TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(conn, "context_fts", "name")? {
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS context_fts_ai;
             DROP TRIGGER IF EXISTS context_fts_ad;
             DROP TRIGGER IF EXISTS context_fts_au;
             DROP TABLE IF EXISTS context_fts;",
        )?;
    }
    Ok(())
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
    b.as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
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
    conn.execute(
        "DELETE FROM meeting_attachments WHERE meeting_id = ?1",
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

/// Meetings explicitly filed to a folder, newest first.
pub fn get_meetings_for_folder(folder_id: i64) -> anyhow::Result<Vec<Meeting>> {
    let conn = connect()?;
    let mut stmt = conn.prepare(
        "SELECT m.id, m.title, m.recorded_at, m.duration_seconds, m.transcript, m.summary, m.template_used, m.audio_file_path, m.attendees, m.user_notes, m.tags, m.pinned, m.locked, m.archived, m.transcript_turns, m.link
         FROM meetings m
         INNER JOIN meeting_folders mf ON mf.meeting_id = m.id
         WHERE mf.folder_id = ?1
         ORDER BY m.recorded_at DESC",
    )?;
    let rows = stmt.query_map(params![folder_id], |row| {
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
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Meetings explicitly filed to a workspace via `meeting_workspace_bindings`, newest first.
pub fn get_meetings_for_workspace(workspace_id: i64) -> anyhow::Result<Vec<Meeting>> {
    let conn = connect()?;
    get_meetings_for_workspace_on(&conn, workspace_id)
}

pub(crate) fn get_meetings_for_workspace_on(
    conn: &Connection,
    workspace_id: i64,
) -> anyhow::Result<Vec<Meeting>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.title, m.recorded_at, m.duration_seconds, m.transcript, m.summary, m.template_used, m.audio_file_path, m.attendees, m.user_notes, m.tags, m.pinned, m.locked, m.archived, m.transcript_turns, m.link
         FROM meetings m
         INNER JOIN meeting_workspace_bindings b ON b.meeting_id = m.id
         WHERE b.workspace_id = ?1
         ORDER BY m.recorded_at DESC",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
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

/// Add context attachments to a meeting, then return its full attachment list.
pub fn add_meeting_attachments(
    meeting_id: i64,
    items: &[(String, String, String)],
) -> anyhow::Result<Vec<MeetingAttachment>> {
    let mut conn = connect()?;
    let tx = conn.transaction()?;
    let created_at = chrono::Utc::now().to_rfc3339();
    for (kind, value, label) in items {
        tx.execute(
            "INSERT INTO meeting_attachments (meeting_id, kind, value, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![meeting_id, kind, value, label, created_at],
        )?;
    }
    tx.commit()?;
    list_meeting_attachments(meeting_id)
}

/// Return one meeting's context attachments in insertion order.
pub fn list_meeting_attachments(meeting_id: i64) -> anyhow::Result<Vec<MeetingAttachment>> {
    let conn = connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, kind, value, label, created_at
         FROM meeting_attachments
         WHERE meeting_id = ?1
         ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![meeting_id], |row| {
        Ok(MeetingAttachment {
            id: row.get(0)?,
            meeting_id: row.get(1)?,
            kind: row.get(2)?,
            value: row.get(3)?,
            label: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    let mut attachments = Vec::new();
    for row in rows {
        attachments.push(row?);
    }
    Ok(attachments)
}

/// Remove one context attachment.
pub fn remove_meeting_attachment(id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    let deleted = conn.execute("DELETE FROM meeting_attachments WHERE id = ?1", params![id])?;
    anyhow::ensure!(deleted == 1, "Meeting attachment not found: {id}");
    Ok(())
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

    conn.execute(
        "UPDATE workspace_tasks
            SET action_item_id = (
                SELECT a.id FROM action_items a
                 WHERE a.meeting_id = ?1 AND a.text = workspace_tasks.title
                 LIMIT 1
            )
          WHERE source_meeting_id = ?1 AND action_item_id IS NOT NULL",
        params![meeting_id],
    )?;
    push_meeting_action_items_on(conn, meeting_id)?;

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
// Automatic workspace context index (vault notes + project cards)
// ---------------------------------------------------------------------------

/// Insert or refresh one context document. `changed` is true only for a new
/// path or a changed fingerprint, which keeps unchanged files off the embed
/// queue while still leaving their FTS row available.
pub fn upsert_context_doc(
    source: &str,
    path: &str,
    name: &str,
    title: &str,
    body: &str,
    fingerprint: &str,
) -> anyhow::Result<(i64, bool)> {
    let conn = connect()?;
    upsert_context_doc_on(&conn, source, path, name, title, body, fingerprint)
}

fn upsert_context_doc_on(
    conn: &Connection,
    source: &str,
    path: &str,
    name: &str,
    title: &str,
    body: &str,
    fingerprint: &str,
) -> anyhow::Result<(i64, bool)> {
    let existing = conn
        .query_row(
            "SELECT id, fingerprint, name FROM context_docs WHERE path = ?1",
            params![path],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((id, stored_fingerprint, stored_name)) = existing {
        if stored_fingerprint == fingerprint {
            if stored_name != name {
                conn.execute(
                    "UPDATE context_docs SET name = ?1, updated_at = ?2 WHERE id = ?3",
                    params![name, chrono::Utc::now().to_rfc3339(), id],
                )?;
            }
            return Ok((id, false));
        }
        conn.execute(
            "UPDATE context_docs
                SET source = ?1, name = ?2, title = ?3, body = ?4,
                    fingerprint = ?5, updated_at = ?6
              WHERE id = ?7",
            params![
                source,
                name,
                title,
                body,
                fingerprint,
                chrono::Utc::now().to_rfc3339(),
                id
            ],
        )?;
        return Ok((id, true));
    }

    conn.execute(
        "INSERT INTO context_docs (source, path, name, title, body, fingerprint, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            source,
            path,
            name,
            title,
            body,
            fingerprint,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    Ok((conn.last_insert_rowid(), true))
}

/// Remove indexed documents for `source` whose paths no longer exist.
pub fn delete_context_docs_not_in(source: &str, keep_paths: &[String]) -> anyhow::Result<usize> {
    let conn = connect()?;
    delete_context_docs_not_in_on(&conn, source, keep_paths)
}

fn delete_context_docs_not_in_on(
    conn: &Connection,
    source: &str,
    keep_paths: &[String],
) -> anyhow::Result<usize> {
    let keep = keep_paths
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut stmt = conn.prepare("SELECT id, path FROM context_docs WHERE source = ?1")?;
    let rows = stmt.query_map(params![source], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut stale = Vec::new();
    for row in rows {
        let (id, path) = row?;
        if !keep.contains(path.as_str()) {
            stale.push(id);
        }
    }
    drop(stmt);

    let tx = conn.unchecked_transaction()?;
    for id in &stale {
        tx.execute("DELETE FROM context_chunks WHERE doc_id = ?1", params![id])?;
        tx.execute("DELETE FROM context_docs WHERE id = ?1", params![id])?;
    }
    tx.commit()?;
    Ok(stale.len())
}

/// Atomically replace every embedded passage for one context document.
pub fn replace_context_chunks(
    doc_id: i64,
    chunks: &[(String, Vec<f32>)],
    model: &str,
) -> anyhow::Result<()> {
    let conn = connect()?;
    replace_context_chunks_on(&conn, doc_id, chunks, model)
}

fn replace_context_chunks_on(
    conn: &Connection,
    doc_id: i64,
    chunks: &[(String, Vec<f32>)],
    model: &str,
) -> anyhow::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM context_chunks WHERE doc_id = ?1",
        params![doc_id],
    )?;
    for (chunk_index, (text, embedding)) in chunks.iter().enumerate() {
        tx.execute(
            "INSERT INTO context_chunks
                (doc_id, chunk_index, text, embedding, dim, model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                doc_id,
                chunk_index as i64,
                text,
                encode_f32(embedding),
                embedding.len() as i64,
                model
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Return every context passage embedded by the active model. Corrupt vector
/// rows are skipped rather than poisoning semantic retrieval.
pub fn get_context_chunks_for_model(model: &str) -> anyhow::Result<Vec<ContextChunkRow>> {
    let conn = connect()?;
    get_context_chunks_for_model_on(&conn, model)
}

fn get_context_chunks_for_model_on(
    conn: &Connection,
    model: &str,
) -> anyhow::Result<Vec<ContextChunkRow>> {
    let mut stmt = conn.prepare(
        "SELECT doc_id, text, embedding, dim
           FROM context_chunks
          WHERE model = ?1
          ORDER BY doc_id, chunk_index",
    )?;
    let rows = stmt.query_map(params![model], |row| {
        let blob: Vec<u8> = row.get(2)?;
        let dim: i64 = row.get(3)?;
        let embedding = decode_f32(&blob);
        if embedding.len() as i64 != dim {
            return Ok(None);
        }
        Ok(Some(ContextChunkRow {
            doc_id: row.get(0)?,
            text: row.get(1)?,
            embedding,
        }))
    })?;
    let mut chunks = Vec::new();
    for row in rows {
        if let Some(chunk) = row? {
            chunks.push(chunk);
        }
    }
    Ok(chunks)
}

/// Context docs with searchable body text but no chunks for `model`. This lets
/// a failed embed retry on the next sync and naturally reindexes model changes.
pub fn context_doc_ids_needing_model(model: &str) -> anyhow::Result<Vec<i64>> {
    let conn = connect()?;
    context_doc_ids_needing_model_on(&conn, model)
}

fn context_doc_ids_needing_model_on(conn: &Connection, model: &str) -> anyhow::Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT d.id
           FROM context_docs d
          WHERE trim(d.body) <> ''
            AND NOT EXISTS (
                SELECT 1 FROM context_chunks c
                 WHERE c.doc_id = d.id AND c.model = ?1
            )
          ORDER BY d.id",
    )?;
    let rows = stmt.query_map(params![model], |row| row.get::<_, i64>(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Return FTS-ranked context document ids, optionally restricted to one source.
pub fn search_context_doc_ids(
    query: &str,
    source: Option<&str>,
    limit: usize,
) -> anyhow::Result<Vec<i64>> {
    let conn = connect()?;
    search_context_doc_ids_on(&conn, query, source, limit)
}

fn search_context_doc_ids_on(
    conn: &Connection,
    query: &str,
    source: Option<&str>,
    limit: usize,
) -> anyhow::Result<Vec<i64>> {
    let match_expr = fts_match_expression(query);
    if match_expr.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let sql = if source.is_some() {
        "SELECT f.rowid
           FROM context_fts f
           JOIN context_docs d ON d.id = f.rowid
          WHERE context_fts MATCH ?1 AND d.source = ?2
          ORDER BY bm25(context_fts, 10.0, 10.0, 1.0)
          LIMIT ?3"
    } else {
        "SELECT f.rowid
           FROM context_fts f
          WHERE context_fts MATCH ?1
          ORDER BY bm25(context_fts, 10.0, 10.0, 1.0)
          LIMIT ?2"
    };
    let mut stmt = conn.prepare(sql)?;
    let mut ids = Vec::new();
    if let Some(source) = source {
        let rows = stmt.query_map(params![match_expr, source, limit as i64], |row| row.get(0))?;
        for row in rows {
            ids.push(row?);
        }
    } else {
        let rows = stmt.query_map(params![match_expr, limit as i64], |row| row.get(0))?;
        for row in rows {
            ids.push(row?);
        }
    }
    Ok(ids)
}

fn context_doc_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContextDoc> {
    Ok(ContextDoc {
        id: row.get(0)?,
        source: row.get(1)?,
        path: row.get(2)?,
        title: row.get(3)?,
        body: row.get(4)?,
        fingerprint: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// Load context documents in the caller's id order, omitting missing rows.
pub fn get_context_docs(ids: &[i64]) -> anyhow::Result<Vec<ContextDoc>> {
    let conn = connect()?;
    get_context_docs_on(&conn, ids)
}

fn get_context_docs_on(conn: &Connection, ids: &[i64]) -> anyhow::Result<Vec<ContextDoc>> {
    let mut docs = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(doc) = conn
            .query_row(
                "SELECT id, source, path, title, body, fingerprint, updated_at
                   FROM context_docs WHERE id = ?1",
                params![id],
                context_doc_from_row,
            )
            .optional()?
        {
            docs.push(doc);
        }
    }
    Ok(docs)
}

/// Return the number of indexed vault notes and project cards.
pub fn context_index_counts() -> anyhow::Result<(i64, i64)> {
    let conn = connect()?;
    context_index_counts_on(&conn)
}

fn context_index_counts_on(conn: &Connection) -> anyhow::Result<(i64, i64)> {
    let vault = conn.query_row(
        "SELECT count(*) FROM context_docs WHERE source = 'vault'",
        [],
        |row| row.get(0),
    )?;
    let projects = conn.query_row(
        "SELECT count(*) FROM context_docs WHERE source = 'project'",
        [],
        |row| row.get(0),
    )?;
    Ok((vault, projects))
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
// Meeting folders
// ---------------------------------------------------------------------------

/// Create a folder used only to organize meetings.
pub fn create_folder(name: &str, color: &str) -> anyhow::Result<Folder> {
    let conn = connect()?;
    create_folder_on(&conn, name, color)
}

fn create_folder_on(conn: &Connection, name: &str, color: &str) -> anyhow::Result<Folder> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO folders (name, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![name, color, now],
    )?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, name, color, instructions, created_at, updated_at
           FROM folders WHERE id = ?1",
        params![id],
        |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                instructions: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .map_err(Into::into)
}

/// Return all meeting folders with their filed-meeting counts.
pub fn list_folders() -> anyhow::Result<Vec<FolderSummary>> {
    let conn = connect()?;
    list_folders_on(&conn)
}

fn list_folders_on(conn: &Connection) -> anyhow::Result<Vec<FolderSummary>> {
    let mut statement = conn.prepare(
        "SELECT f.id, f.name, f.color, f.instructions, f.created_at, f.updated_at,
                (SELECT COUNT(*) FROM meeting_folders mf WHERE mf.folder_id = f.id)
           FROM folders f
          ORDER BY f.updated_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(FolderSummary {
            folder: Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                instructions: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            },
            meeting_count: row.get(6)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Load one folder.
pub fn get_folder(id: i64) -> anyhow::Result<Option<Folder>> {
    let conn = connect()?;
    get_folder_on(&conn, id)
}

fn get_folder_on(conn: &Connection, id: i64) -> anyhow::Result<Option<Folder>> {
    conn.query_row(
        "SELECT id, name, color, instructions, created_at, updated_at
           FROM folders WHERE id = ?1",
        params![id],
        |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                instructions: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// Rename a folder and update its modified timestamp.
pub fn rename_folder(id: i64, name: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    rename_folder_on(&conn, id, name)
}

fn rename_folder_on(conn: &Connection, id: i64, name: &str) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE folders SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Folder not found: {id}");
    Ok(())
}

/// Update the standing overview instructions for a folder.
pub fn set_folder_instructions(id: i64, instructions: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    set_folder_instructions_on(&conn, id, instructions)
}

fn set_folder_instructions_on(
    conn: &Connection,
    id: i64,
    instructions: &str,
) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE folders SET instructions = ?1, updated_at = ?2 WHERE id = ?3",
        params![instructions, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Folder not found: {id}");
    Ok(())
}

/// Update the sidebar color for a folder.
pub fn set_folder_color(id: i64, color: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    set_folder_color_on(&conn, id, color)
}

fn set_folder_color_on(conn: &Connection, id: i64, color: &str) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE folders SET color = ?1, updated_at = ?2 WHERE id = ?3",
        params![color, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Folder not found: {id}");
    Ok(())
}

/// Delete a folder and its filing decisions, leaving meetings untouched.
pub fn delete_folder(id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    delete_folder_on(&conn, id)
}

fn delete_folder_on(conn: &Connection, id: i64) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM meeting_folders WHERE folder_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM folder_overviews WHERE folder_id = ?1",
        params![id],
    )?;
    let updated = conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
    anyhow::ensure!(updated == 1, "Folder not found: {id}");
    Ok(())
}

/// File a meeting into a folder, or explicitly mark it as not filed.
pub fn set_meeting_folder(meeting_id: i64, folder_id: Option<i64>) -> anyhow::Result<()> {
    let conn = connect()?;
    set_meeting_folder_on(&conn, meeting_id, folder_id)
}

fn set_meeting_folder_on(
    conn: &Connection,
    meeting_id: i64,
    folder_id: Option<i64>,
) -> anyhow::Result<()> {
    let meeting_exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)",
        params![meeting_id],
        |row| row.get::<_, bool>(0),
    )?;
    anyhow::ensure!(meeting_exists, "Meeting not found: {meeting_id}");
    if let Some(folder_id) = folder_id {
        let folder_exists = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)",
            params![folder_id],
            |row| row.get::<_, bool>(0),
        )?;
        anyhow::ensure!(folder_exists, "Folder not found: {folder_id}");
    }

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO meeting_folders (meeting_id, folder_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(meeting_id) DO UPDATE SET
             folder_id = excluded.folder_id,
             updated_at = excluded.updated_at",
        params![meeting_id, folder_id, now],
    )?;
    Ok(())
}

/// Remove a meeting's folder decision so it becomes undecided again.
pub fn clear_meeting_folder(meeting_id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    clear_meeting_folder_on(&conn, meeting_id)
}

fn clear_meeting_folder_on(conn: &Connection, meeting_id: i64) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM meeting_folders WHERE meeting_id = ?1",
        params![meeting_id],
    )?;
    Ok(())
}

/// List every stored meeting-folder decision.
pub fn list_meeting_folders() -> anyhow::Result<Vec<MeetingFolder>> {
    let conn = connect()?;
    list_meeting_folders_on(&conn)
}

fn list_meeting_folders_on(conn: &Connection) -> anyhow::Result<Vec<MeetingFolder>> {
    let mut statement = conn.prepare(
        "SELECT mf.meeting_id, mf.folder_id, COALESCE(f.name, '')
           FROM meeting_folders mf
           LEFT JOIN folders f ON f.id = mf.folder_id
          ORDER BY mf.meeting_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(MeetingFolder {
            meeting_id: row.get(0)?,
            folder_id: row.get(1)?,
            folder_name: row.get(2)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Return every explicitly filed folder/meeting pair.
pub fn folder_meeting_ids() -> anyhow::Result<Vec<(i64, i64)>> {
    let conn = connect()?;
    let mut statement = conn.prepare(
        "SELECT folder_id, meeting_id
           FROM meeting_folders
          WHERE folder_id IS NOT NULL",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Load the cached overview for one folder.
pub fn get_folder_overview_cache(
    folder_id: i64,
) -> anyhow::Result<Option<(String, String, String)>> {
    let conn = connect()?;
    get_folder_overview_cache_on(&conn, folder_id)
}

fn get_folder_overview_cache_on(
    conn: &Connection,
    folder_id: i64,
) -> anyhow::Result<Option<(String, String, String)>> {
    conn.query_row(
        "SELECT summary, source_hash, generated_at
           FROM folder_overviews WHERE folder_id = ?1",
        params![folder_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(Into::into)
}

/// Insert or replace the cached overview for one folder.
pub fn upsert_folder_overview(
    folder_id: i64,
    summary: &str,
    source_hash: &str,
    generated_at: &str,
) -> anyhow::Result<()> {
    let conn = connect()?;
    conn.execute(
        "INSERT INTO folder_overviews (folder_id, summary, source_hash, generated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(folder_id) DO UPDATE SET
             summary = excluded.summary,
             source_hash = excluded.source_hash,
             generated_at = excluded.generated_at",
        params![folder_id, summary, source_hash, generated_at],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/// Create a workspace using the default local engine.
pub fn create_workspace(name: &str, color: &str) -> anyhow::Result<Workspace> {
    let conn = connect()?;
    create_workspace_on(&conn, name, color)
}

fn create_workspace_on(conn: &Connection, name: &str, color: &str) -> anyhow::Result<Workspace> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO workspaces (name, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![name, color, now],
    )?;
    let id = conn.last_insert_rowid();
    let workspace = conn.query_row(
        "SELECT id, name, engine, model, network_allowed, instructions, color, created_at, updated_at
         FROM workspaces WHERE id = ?1",
        params![id],
        |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                engine: row.get(2)?,
                model: row.get(3)?,
                network_allowed: row.get::<_, i32>(4)? != 0,
                instructions: row.get(5)?,
                color: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    )?;
    Ok(workspace)
}

/// Return all workspaces with the counts displayed on their cards.
pub fn list_workspaces() -> anyhow::Result<Vec<WorkspaceSummary>> {
    let conn = connect()?;
    list_workspaces_on(&conn)
}

fn list_workspaces_on(conn: &Connection) -> anyhow::Result<Vec<WorkspaceSummary>> {
    let mut stmt = conn.prepare(
        "SELECT w.id, w.name, w.engine, w.model, w.network_allowed, w.instructions, w.color,
                w.created_at, w.updated_at,
                (SELECT COUNT(*) FROM workspace_tasks t
                  WHERE t.workspace_id = w.id AND t.status = 'queued'),
                (SELECT COUNT(*) FROM workspace_tasks t
                  WHERE t.workspace_id = w.id AND t.status = 'queued'
                    AND t.agent_eligible = 0),
                (SELECT COUNT(*) FROM workspace_tasks t
                  WHERE t.workspace_id = w.id AND t.status = 'running'),
                (SELECT COUNT(*) FROM workspace_tasks t
                  WHERE t.workspace_id = w.id AND t.status = 'awaiting_review'),
                (SELECT COUNT(*) FROM workspace_tasks t
                  WHERE t.workspace_id = w.id AND t.status = 'done'),
                (SELECT COUNT(*) FROM workspace_tasks t
                  WHERE t.workspace_id = w.id),
                (SELECT COUNT(*) FROM workspace_context_items c
                  WHERE c.workspace_id = w.id AND c.kind = 'meeting'),
                (SELECT COUNT(*) FROM workspace_context_items c
                  WHERE c.workspace_id = w.id AND c.kind = 'folder')
           FROM workspaces w
          ORDER BY w.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(WorkspaceSummary {
            workspace: Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                engine: row.get(2)?,
                model: row.get(3)?,
                network_allowed: row.get::<_, i32>(4)? != 0,
                instructions: row.get(5)?,
                color: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            },
            queued_task_count: row.get(9)?,
            needs_you_count: row.get(10)?,
            running_task_count: row.get(11)?,
            awaiting_review_count: row.get(12)?,
            approved_task_count: row.get(13)?,
            total_task_count: row.get(14)?,
            meeting_count: row.get(15)?,
            folder_count: row.get(16)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn workspace_addon_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceAddon> {
    Ok(WorkspaceAddon {
        id: row.get(0)?,
        kind: row.get(1)?,
        slug: row.get(2)?,
        name: row.get(3)?,
        description: row.get(4)?,
        instructions: row.get(5)?,
        builtin: row.get::<_, i32>(6)? != 0,
        created_at: row.get(7)?,
    })
}

/// Insert or refresh the built-in skill and agent catalog.
pub(crate) fn seed_builtin_addons_on(conn: &Connection) -> anyhow::Result<()> {
    for addon in crate::addons::BUILTIN {
        conn.execute(
            "INSERT INTO workspace_addons
                 (kind, slug, name, description, instructions, builtin, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
             ON CONFLICT(slug) DO UPDATE SET
                 kind = excluded.kind,
                 name = excluded.name,
                 description = excluded.description,
                 instructions = excluded.instructions
             WHERE workspace_addons.builtin = 1",
            params![
                addon.kind,
                addon.slug,
                addon.name,
                addon.description,
                addon.instructions,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
    }
    Ok(())
}

/// Return the complete workspace skill and agent catalog.
pub fn list_addons() -> anyhow::Result<Vec<WorkspaceAddon>> {
    let conn = connect()?;
    list_addons_on(&conn)
}

fn list_addons_on(conn: &Connection) -> anyhow::Result<Vec<WorkspaceAddon>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, slug, name, description, instructions, builtin, created_at
           FROM workspace_addons
          ORDER BY kind ASC, builtin DESC, name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], workspace_addon_from_row)?;
    let mut addons = Vec::new();
    for row in rows {
        addons.push(row?);
    }
    Ok(addons)
}

fn addon_slug(name: &str, fallback: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for character in name.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character);
            pending_dash = false;
        } else {
            pending_dash = true;
        }
    }
    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug
    }
}

/// Add a custom skill or agent to the catalog.
pub fn create_addon(
    kind: &str,
    name: &str,
    description: &str,
    instructions: &str,
) -> anyhow::Result<WorkspaceAddon> {
    let conn = connect()?;
    create_addon_on(&conn, kind, name, description, instructions)
}

fn create_addon_on(
    conn: &Connection,
    kind: &str,
    name: &str,
    description: &str,
    instructions: &str,
) -> anyhow::Result<WorkspaceAddon> {
    anyhow::ensure!(
        matches!(kind, "skill" | "agent"),
        "Add-on kind must be skill or agent."
    );
    let name = name.trim();
    if name.is_empty() {
        anyhow::bail!(if kind == "skill" {
            "Give the skill a name."
        } else {
            "Give the agent a name."
        });
    }
    let instructions = instructions.trim();
    anyhow::ensure!(!instructions.is_empty(), "Add instructions.");

    let base_slug = addon_slug(name, kind);
    let mut slug = base_slug.clone();
    let mut suffix = 2;
    while conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspace_addons WHERE slug = ?1)",
        params![slug],
        |row| row.get::<_, bool>(0),
    )? {
        slug = format!("{base_slug}-{suffix}");
        suffix += 1;
    }

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO workspace_addons
             (kind, slug, name, description, instructions, builtin, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        params![kind, slug, name, description.trim(), instructions, now],
    )?;
    conn.query_row(
        "SELECT id, kind, slug, name, description, instructions, builtin, created_at
           FROM workspace_addons WHERE id = ?1",
        params![conn.last_insert_rowid()],
        workspace_addon_from_row,
    )
    .map_err(Into::into)
}

/// Delete a custom catalog entry and all of its workspace links.
pub fn delete_addon(id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    delete_addon_on(&conn, id)
}

fn delete_addon_on(conn: &Connection, id: i64) -> anyhow::Result<()> {
    let builtin = conn
        .query_row(
            "SELECT builtin FROM workspace_addons WHERE id = ?1",
            params![id],
            |row| Ok(row.get::<_, i32>(0)? != 0),
        )
        .optional()?;
    let Some(builtin) = builtin else {
        anyhow::bail!("Workspace add-on not found: {id}");
    };
    anyhow::ensure!(!builtin, "Built-in skills and agents can't be deleted.");
    conn.execute(
        "DELETE FROM workspace_addon_links WHERE addon_id = ?1",
        params![id],
    )?;
    conn.execute("DELETE FROM workspace_addons WHERE id = ?1", params![id])?;
    Ok(())
}

/// Attach a skill or the workspace's single agent, returning the attached list.
pub fn attach_addon(workspace_id: i64, addon_id: i64) -> anyhow::Result<Vec<WorkspaceAddon>> {
    let conn = connect()?;
    attach_addon_on(&conn, workspace_id, addon_id)
}

fn attach_addon_on(
    conn: &Connection,
    workspace_id: i64,
    addon_id: i64,
) -> anyhow::Result<Vec<WorkspaceAddon>> {
    let workspace_exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
        params![workspace_id],
        |row| row.get::<_, bool>(0),
    )?;
    anyhow::ensure!(workspace_exists, "Workspace not found: {workspace_id}");
    let kind = conn
        .query_row(
            "SELECT kind FROM workspace_addons WHERE id = ?1",
            params![addon_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(kind) = kind else {
        anyhow::bail!("Workspace add-on not found: {addon_id}");
    };

    if kind == "agent" {
        conn.execute(
            "DELETE FROM workspace_addon_links
              WHERE workspace_id = ?1
                AND addon_id IN (SELECT id FROM workspace_addons WHERE kind = 'agent')",
            params![workspace_id],
        )?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO workspace_addon_links (workspace_id, addon_id, created_at)
         VALUES (?1, ?2, ?3)",
        params![workspace_id, addon_id, chrono::Utc::now().to_rfc3339()],
    )?;
    conn.execute(
        "UPDATE workspaces SET updated_at = ?1 WHERE id = ?2",
        params![chrono::Utc::now().to_rfc3339(), workspace_id],
    )?;
    list_workspace_addons_on(conn, workspace_id)
}

/// Detach one skill or agent from a workspace.
pub fn detach_addon(workspace_id: i64, addon_id: i64) -> anyhow::Result<Vec<WorkspaceAddon>> {
    let conn = connect()?;
    detach_addon_on(&conn, workspace_id, addon_id)
}

fn detach_addon_on(
    conn: &Connection,
    workspace_id: i64,
    addon_id: i64,
) -> anyhow::Result<Vec<WorkspaceAddon>> {
    let workspace_exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
        params![workspace_id],
        |row| row.get::<_, bool>(0),
    )?;
    anyhow::ensure!(workspace_exists, "Workspace not found: {workspace_id}");
    let addon_exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspace_addons WHERE id = ?1)",
        params![addon_id],
        |row| row.get::<_, bool>(0),
    )?;
    anyhow::ensure!(addon_exists, "Workspace add-on not found: {addon_id}");

    conn.execute(
        "DELETE FROM workspace_addon_links WHERE workspace_id = ?1 AND addon_id = ?2",
        params![workspace_id, addon_id],
    )?;
    conn.execute(
        "UPDATE workspaces SET updated_at = ?1 WHERE id = ?2",
        params![chrono::Utc::now().to_rfc3339(), workspace_id],
    )?;
    list_workspace_addons_on(conn, workspace_id)
}

fn list_workspace_addons_on(
    conn: &Connection,
    workspace_id: i64,
) -> anyhow::Result<Vec<WorkspaceAddon>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.kind, a.slug, a.name, a.description, a.instructions,
                a.builtin, a.created_at
           FROM workspace_addons a
           JOIN workspace_addon_links l ON l.addon_id = a.id
          WHERE l.workspace_id = ?1
          ORDER BY CASE WHEN a.kind = 'agent' THEN 0 ELSE 1 END,
                   a.name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map(params![workspace_id], workspace_addon_from_row)?;
    let mut addons = Vec::new();
    for row in rows {
        addons.push(row?);
    }
    Ok(addons)
}

fn workspace_task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceTask> {
    let rejection_notes: String = row.get(12)?;
    Ok(WorkspaceTask {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        details: row.get(3)?,
        capability: row.get(4)?,
        status: row.get(5)?,
        source_meeting_id: row.get(6)?,
        source_meeting_title: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        action_item_id: row.get(10)?,
        attempt: row.get(11)?,
        rejection_notes: serde_json::from_str::<Vec<String>>(&rejection_notes).unwrap_or_default(),
        agent_eligible: row.get::<_, i32>(13)? != 0,
    })
}

/// Load a workspace and all of its context and tasks.
pub fn get_workspace(id: i64) -> anyhow::Result<Option<WorkspaceDetail>> {
    let conn = connect()?;
    get_workspace_on(&conn, id)
}

fn get_workspace_on(conn: &Connection, id: i64) -> anyhow::Result<Option<WorkspaceDetail>> {
    let workspace = conn
        .query_row(
            "SELECT id, name, engine, model, network_allowed, instructions, color, created_at, updated_at
             FROM workspaces WHERE id = ?1",
            params![id],
            |row| {
                Ok(Workspace {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    engine: row.get(2)?,
                    model: row.get(3)?,
                    network_allowed: row.get::<_, i32>(4)? != 0,
                    instructions: row.get(5)?,
                    color: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()?;
    let Some(workspace) = workspace else {
        return Ok(None);
    };

    let mut context_stmt = conn.prepare(
        "SELECT id, workspace_id, kind, value, label, created_at
         FROM workspace_context_items
         WHERE workspace_id = ?1
         ORDER BY kind, label",
    )?;
    let context_rows = context_stmt.query_map(params![id], |row| {
        Ok(WorkspaceContextItem {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            kind: row.get(2)?,
            value: row.get(3)?,
            label: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    let mut context_items = Vec::new();
    for row in context_rows {
        context_items.push(row?);
    }

    let mut task_stmt = conn.prepare(
        "SELECT t.id, t.workspace_id, t.title, t.details, t.capability, t.status,
                t.source_meeting_id, COALESCE(m.title, ''), t.created_at, t.updated_at,
                t.action_item_id, t.attempt, t.rejection_notes, t.agent_eligible
           FROM workspace_tasks t
           LEFT JOIN meetings m ON m.id = t.source_meeting_id
          WHERE t.workspace_id = ?1
          ORDER BY t.created_at DESC",
    )?;
    let task_rows = task_stmt.query_map(params![id], workspace_task_from_row)?;
    let mut tasks = Vec::new();
    for row in task_rows {
        tasks.push(row?);
    }

    let artifacts = list_workspace_artifacts_on(conn, id)?;
    let addons = list_workspace_addons_on(conn, id)?;

    Ok(Some(WorkspaceDetail {
        workspace,
        context_items,
        addons,
        tasks,
        artifacts,
    }))
}

/// Rename a workspace and update its modified timestamp.
pub fn rename_workspace(id: i64, name: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    rename_workspace_on(&conn, id, name)
}

fn rename_workspace_on(conn: &Connection, id: i64, name: &str) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {id}");
    Ok(())
}

/// Update the standing instructions for a workspace.
pub fn set_workspace_instructions(id: i64, instructions: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    set_workspace_instructions_on(&conn, id, instructions)
}

fn set_workspace_instructions_on(
    conn: &Connection,
    id: i64,
    instructions: &str,
) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE workspaces SET instructions = ?1, updated_at = ?2 WHERE id = ?3",
        params![instructions, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {id}");
    Ok(())
}

/// Change whether a workspace may use the network.
pub fn set_workspace_network_allowed(id: i64, allowed: bool) -> anyhow::Result<()> {
    let conn = connect()?;
    set_workspace_network_allowed_on(&conn, id, allowed)
}

fn set_workspace_network_allowed_on(
    conn: &Connection,
    id: i64,
    allowed: bool,
) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE workspaces SET network_allowed = ?1, updated_at = ?2 WHERE id = ?3",
        params![allowed as i32, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {id}");
    Ok(())
}

/// Update the sidebar color for a workspace.
pub fn set_workspace_color(id: i64, color: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    set_workspace_color_on(&conn, id, color)
}

fn set_workspace_color_on(conn: &Connection, id: i64, color: &str) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE workspaces SET color = ?1, updated_at = ?2 WHERE id = ?3",
        params![color, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {id}");
    Ok(())
}

/// Load the cached project overview for one workspace.
pub fn get_project_overview_cache(
    workspace_id: i64,
) -> anyhow::Result<Option<(String, String, String)>> {
    let conn = connect()?;
    get_project_overview_cache_on(&conn, workspace_id)
}

pub(crate) fn get_project_overview_cache_on(
    conn: &Connection,
    workspace_id: i64,
) -> anyhow::Result<Option<(String, String, String)>> {
    let row = conn
        .query_row(
            "SELECT overview, overview_source_hash, overview_generated_at FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .optional()?;
    Ok(row)
}

/// Upsert the cached project overview for one workspace.
pub fn upsert_project_overview(
    workspace_id: i64,
    summary: &str,
    source_hash: &str,
    generated_at: &str,
) -> anyhow::Result<()> {
    let conn = connect()?;
    upsert_project_overview_on(&conn, workspace_id, summary, source_hash, generated_at)
}

pub(crate) fn upsert_project_overview_on(
    conn: &Connection,
    workspace_id: i64,
    summary: &str,
    source_hash: &str,
    generated_at: &str,
) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE workspaces SET overview = ?1, overview_source_hash = ?2, overview_generated_at = ?3, updated_at = ?4 WHERE id = ?5",
        params![summary, source_hash, generated_at, chrono::Utc::now().to_rfc3339(), workspace_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {workspace_id}");
    Ok(())
}

/// Delete a workspace and its children without relying on foreign-key cascades.
pub fn delete_workspace(id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    delete_workspace_on(&conn, id)
}

fn delete_workspace_on(conn: &Connection, id: i64) -> anyhow::Result<()> {
    // Meetings themselves survive project deletion. Removing their bindings
    // makes them unfiled instead of leaving orphaned project ids behind.
    conn.execute(
        "DELETE FROM meeting_workspace_bindings WHERE workspace_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM workspace_artifacts WHERE workspace_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM workspace_runs WHERE workspace_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM workspace_task_staffing
          WHERE task_id IN (SELECT id FROM workspace_tasks WHERE workspace_id = ?1)",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM workspace_tasks WHERE workspace_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM workspace_context_items WHERE workspace_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM workspace_addon_links WHERE workspace_id = ?1",
        params![id],
    )?;
    let updated = conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
    anyhow::ensure!(updated == 1, "Workspace not found: {id}");
    Ok(())
}

/// Add a context item, returning the existing item when the link is a duplicate.
pub fn add_workspace_context(
    workspace_id: i64,
    kind: &str,
    value: &str,
    label: &str,
) -> anyhow::Result<Option<WorkspaceContextItem>> {
    let conn = connect()?;
    add_workspace_context_on(&conn, workspace_id, kind, value, label)
}

fn add_workspace_context_on(
    conn: &Connection,
    workspace_id: i64,
    kind: &str,
    value: &str,
    label: &str,
) -> anyhow::Result<Option<WorkspaceContextItem>> {
    let updated = conn.execute(
        "UPDATE workspaces SET updated_at = ?1 WHERE id = ?2",
        params![chrono::Utc::now().to_rfc3339(), workspace_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {workspace_id}");
    conn.execute(
        "INSERT OR IGNORE INTO workspace_context_items
             (workspace_id, kind, value, label, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            workspace_id,
            kind,
            value,
            label,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    let item = conn
        .query_row(
            "SELECT id, workspace_id, kind, value, label, created_at
             FROM workspace_context_items
             WHERE workspace_id = ?1 AND kind = ?2 AND value = ?3",
            params![workspace_id, kind, value],
            |row| {
                Ok(WorkspaceContextItem {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    kind: row.get(2)?,
                    value: row.get(3)?,
                    label: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .optional()?;
    Ok(item)
}

/// Remove one context item.
pub fn remove_workspace_context(item_id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    remove_workspace_context_on(&conn, item_id)
}

fn remove_workspace_context_on(conn: &Connection, item_id: i64) -> anyhow::Result<()> {
    let updated = conn.execute(
        "DELETE FROM workspace_context_items WHERE id = ?1",
        params![item_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace context item not found: {item_id}");
    Ok(())
}

/// Bind a meeting's open action items to a workspace, or mark it as not a project.
pub fn set_meeting_binding(meeting_id: i64, workspace_id: Option<i64>) -> anyhow::Result<usize> {
    let conn = connect()?;
    set_meeting_binding_on(&conn, meeting_id, workspace_id)
}

fn set_meeting_binding_on(
    conn: &Connection,
    meeting_id: i64,
    workspace_id: Option<i64>,
) -> anyhow::Result<usize> {
    let meeting_exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM meetings WHERE id = ?1)",
        params![meeting_id],
        |row| row.get::<_, bool>(0),
    )?;
    anyhow::ensure!(meeting_exists, "Meeting not found: {meeting_id}");
    if let Some(workspace_id) = workspace_id {
        let workspace_exists = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
            params![workspace_id],
            |row| row.get::<_, bool>(0),
        )?;
        anyhow::ensure!(workspace_exists, "Workspace not found: {workspace_id}");
    }

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO meeting_workspace_bindings
             (meeting_id, workspace_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(meeting_id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             updated_at = excluded.updated_at",
        params![meeting_id, workspace_id, now],
    )?;
    if workspace_id.is_some() {
        push_meeting_action_items_on(conn, meeting_id)
    } else {
        Ok(0)
    }
}

/// Remove a meeting's workspace decision so it becomes undecided again.
pub fn clear_meeting_binding(meeting_id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    clear_meeting_binding_on(&conn, meeting_id)
}

fn clear_meeting_binding_on(conn: &Connection, meeting_id: i64) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM meeting_workspace_bindings WHERE meeting_id = ?1",
        params![meeting_id],
    )?;
    Ok(())
}

/// Return the stored workspace decision for one meeting.
pub fn get_meeting_binding(meeting_id: i64) -> anyhow::Result<Option<MeetingWorkspaceBinding>> {
    let conn = connect()?;
    get_meeting_binding_on(&conn, meeting_id)
}

fn get_meeting_binding_on(
    conn: &Connection,
    meeting_id: i64,
) -> anyhow::Result<Option<MeetingWorkspaceBinding>> {
    conn.query_row(
        "SELECT b.meeting_id, b.workspace_id, COALESCE(w.name, '')
           FROM meeting_workspace_bindings b
           LEFT JOIN workspaces w ON w.id = b.workspace_id
          WHERE b.meeting_id = ?1",
        params![meeting_id],
        |row| {
            Ok(MeetingWorkspaceBinding {
                meeting_id: row.get(0)?,
                workspace_id: row.get(1)?,
                workspace_name: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// List all meeting-to-workspace decisions.
pub fn list_meeting_bindings() -> anyhow::Result<Vec<MeetingWorkspaceBinding>> {
    let conn = connect()?;
    list_meeting_bindings_on(&conn)
}

fn list_meeting_bindings_on(conn: &Connection) -> anyhow::Result<Vec<MeetingWorkspaceBinding>> {
    let mut stmt = conn.prepare(
        "SELECT b.meeting_id, b.workspace_id, COALESCE(w.name, '')
           FROM meeting_workspace_bindings b
           LEFT JOIN workspaces w ON w.id = b.workspace_id
          ORDER BY b.meeting_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(MeetingWorkspaceBinding {
            meeting_id: row.get(0)?,
            workspace_id: row.get(1)?,
            workspace_name: row.get(2)?,
        })
    })?;
    let mut bindings = Vec::new();
    for row in rows {
        bindings.push(row?);
    }
    Ok(bindings)
}

/// Return every workspace/meeting pair from context links and explicit bindings.
pub fn workspace_meeting_ids() -> anyhow::Result<Vec<(i64, i64)>> {
    let conn = connect()?;
    workspace_meeting_ids_on(&conn)
}

fn workspace_meeting_ids_on(conn: &Connection) -> anyhow::Result<Vec<(i64, i64)>> {
    let mut pairs = std::collections::BTreeSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT workspace_id, value FROM workspace_context_items WHERE kind = 'meeting'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (workspace_id, value) = row?;
            if let Ok(meeting_id) = value.parse::<i64>() {
                pairs.insert((workspace_id, meeting_id));
            }
        }
    }
    let mut stmt = conn.prepare(
        "SELECT workspace_id, meeting_id
           FROM meeting_workspace_bindings
          WHERE workspace_id IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    for row in rows {
        pairs.insert(row?);
    }
    Ok(pairs.into_iter().collect())
}

/// Push every eligible open action item from a bound meeting into its workspace.
pub fn push_meeting_action_items(meeting_id: i64) -> anyhow::Result<usize> {
    let conn = connect()?;
    push_meeting_action_items_on(&conn, meeting_id)
}

fn push_meeting_action_items_on(conn: &Connection, meeting_id: i64) -> anyhow::Result<usize> {
    let Some(binding) = get_meeting_binding_on(conn, meeting_id)? else {
        return Ok(0);
    };
    let Some(workspace_id) = binding.workspace_id else {
        return Ok(0);
    };
    let items = {
        let mut stmt = conn.prepare(
            "SELECT id, text
               FROM action_items
              WHERE meeting_id = ?1
                AND done = 0
                AND assignee != 'Not mine'
                AND NOT EXISTS (
                    SELECT 1 FROM workspace_tasks t
                     WHERE t.action_item_id = action_items.id
                )
              ORDER BY ord",
        )?;
        let rows = stmt.query_map(params![meeting_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        items
    };
    for (action_item_id, text) in &items {
        let existing_id = conn
            .query_row(
                "SELECT id FROM workspace_tasks
                  WHERE workspace_id = ?1
                    AND action_item_id IS NULL
                    AND lower(trim(title)) = lower(trim(?2))
                  ORDER BY id
                  LIMIT 1",
                params![workspace_id, text],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if let Some(existing_id) = existing_id {
            conn.execute(
                "UPDATE workspace_tasks
                    SET action_item_id = ?1, updated_at = ?2
                  WHERE id = ?3",
                params![action_item_id, chrono::Utc::now().to_rfc3339(), existing_id],
            )?;
            continue;
        }
        create_workspace_task_with_eligibility_on(
            conn,
            workspace_id,
            text,
            "",
            "",
            Some(meeting_id),
            Some(*action_item_id),
            !crate::task_triage::needs_you(text),
        )?;
    }
    Ok(items.len())
}

/// Queue a workspace task, linking its source meeting into context when present.
pub fn create_workspace_task(
    workspace_id: i64,
    title: &str,
    details: &str,
    capability: &str,
    source_meeting_id: Option<i64>,
    action_item_id: Option<i64>,
) -> anyhow::Result<WorkspaceTask> {
    let conn = connect()?;
    create_workspace_task_on(
        &conn,
        workspace_id,
        title,
        details,
        capability,
        source_meeting_id,
        action_item_id,
    )
}

fn create_workspace_task_on(
    conn: &Connection,
    workspace_id: i64,
    title: &str,
    details: &str,
    capability: &str,
    source_meeting_id: Option<i64>,
    action_item_id: Option<i64>,
) -> anyhow::Result<WorkspaceTask> {
    create_workspace_task_with_eligibility_on(
        conn,
        workspace_id,
        title,
        details,
        capability,
        source_meeting_id,
        action_item_id,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_workspace_task_with_eligibility_on(
    conn: &Connection,
    workspace_id: i64,
    title: &str,
    details: &str,
    capability: &str,
    source_meeting_id: Option<i64>,
    action_item_id: Option<i64>,
    agent_eligible: bool,
) -> anyhow::Result<WorkspaceTask> {
    if let Some(action_item_id) = action_item_id {
        let existing_id = conn
            .query_row(
                "SELECT id FROM workspace_tasks
                  WHERE workspace_id = ?1 AND action_item_id = ?2
                  LIMIT 1",
                params![workspace_id, action_item_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if let Some(existing_id) = existing_id {
            return get_workspace_task_on(conn, existing_id)?.ok_or_else(|| {
                anyhow::anyhow!("Workspace task not found after lookup: {existing_id}")
            });
        }
    }

    let source_meeting_title = match source_meeting_id {
        Some(meeting_id) => {
            let meeting_title = conn
                .query_row(
                    "SELECT title FROM meetings WHERE id = ?1",
                    params![meeting_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            anyhow::ensure!(meeting_title.is_some(), "Meeting not found: {meeting_id}");
            meeting_title.unwrap_or_default()
        }
        None => String::new(),
    };

    let updated = conn.execute(
        "UPDATE workspaces SET updated_at = ?1 WHERE id = ?2",
        params![chrono::Utc::now().to_rfc3339(), workspace_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {workspace_id}");

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO workspace_tasks
             (workspace_id, title, details, capability, source_meeting_id, action_item_id,
              agent_eligible, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            workspace_id,
            title,
            details,
            capability,
            source_meeting_id,
            action_item_id,
            agent_eligible,
            now
        ],
    )?;
    let task_id = conn.last_insert_rowid();

    if let Some(meeting_id) = source_meeting_id {
        conn.execute(
            "INSERT OR IGNORE INTO workspace_context_items
                 (workspace_id, kind, value, label, created_at)
             VALUES (?1, 'meeting', ?2, ?3, ?4)",
            params![
                workspace_id,
                meeting_id.to_string(),
                source_meeting_title,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
    }

    let task = conn.query_row(
        "SELECT t.id, t.workspace_id, t.title, t.details, t.capability, t.status,
                t.source_meeting_id, COALESCE(m.title, ''), t.created_at, t.updated_at,
                t.action_item_id, t.attempt, t.rejection_notes, t.agent_eligible
           FROM workspace_tasks t
           LEFT JOIN meetings m ON m.id = t.source_meeting_id
          WHERE t.id = ?1",
        params![task_id],
        workspace_task_from_row,
    )?;
    Ok(task)
}

/// Delete one workspace task.
pub fn delete_workspace_task(task_id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    delete_workspace_task_on(&conn, task_id)
}

fn delete_workspace_task_on(conn: &Connection, task_id: i64) -> anyhow::Result<()> {
    clear_task_staffing_on(conn, task_id)?;
    let updated = conn.execute(
        "DELETE FROM workspace_tasks WHERE id = ?1",
        params![task_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace task not found: {task_id}");
    Ok(())
}

/// Load the staffing resolved for one queued workspace task.
pub fn get_task_staffing(task_id: i64) -> anyhow::Result<Option<TaskStaffing>> {
    let conn = connect()?;
    get_task_staffing_on(&conn, task_id)
}

fn get_task_staffing_on(conn: &Connection, task_id: i64) -> anyhow::Result<Option<TaskStaffing>> {
    let row = conn
        .query_row(
            "SELECT mode, agent_id, skill_ids, reason, resolved_at
               FROM workspace_task_staffing
              WHERE task_id = ?1",
            params![task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    row.map(|(mode, agent_id, skill_ids, reason, resolved_at)| {
        Ok(TaskStaffing {
            mode,
            agent_id,
            skill_ids: serde_json::from_str(&skill_ids)?,
            reason,
            resolved_at,
        })
    })
    .transpose()
}

/// Persist the resolved staffing for a task, replacing its previous setup.
pub fn set_task_staffing(task_id: i64, staffing: &TaskStaffing) -> anyhow::Result<()> {
    let conn = connect()?;
    set_task_staffing_on(&conn, task_id, staffing)
}

fn set_task_staffing_on(
    conn: &Connection,
    task_id: i64,
    staffing: &TaskStaffing,
) -> anyhow::Result<()> {
    let skill_ids = serde_json::to_string(&staffing.skill_ids)?;
    conn.execute(
        "INSERT INTO workspace_task_staffing
             (task_id, mode, agent_id, skill_ids, reason, resolved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(task_id) DO UPDATE SET
             mode = excluded.mode,
             agent_id = excluded.agent_id,
             skill_ids = excluded.skill_ids,
             reason = excluded.reason,
             resolved_at = excluded.resolved_at",
        params![
            task_id,
            staffing.mode,
            staffing.agent_id,
            skill_ids,
            staffing.reason,
            staffing.resolved_at
        ],
    )?;
    Ok(())
}

/// Remove the resolved staffing for one task.
pub fn clear_task_staffing(task_id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    clear_task_staffing_on(&conn, task_id)
}

fn clear_task_staffing_on(conn: &Connection, task_id: i64) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM workspace_task_staffing WHERE task_id = ?1",
        params![task_id],
    )?;
    Ok(())
}

/// Change whether the autopilot may select a queued task.
pub fn set_workspace_task_agent_eligible(
    task_id: i64,
    eligible: bool,
) -> anyhow::Result<WorkspaceTask> {
    let conn = connect()?;
    set_workspace_task_agent_eligible_on(&conn, task_id, eligible)
}

fn set_workspace_task_agent_eligible_on(
    conn: &Connection,
    task_id: i64,
    eligible: bool,
) -> anyhow::Result<WorkspaceTask> {
    let updated = conn.execute(
        "UPDATE workspace_tasks
            SET agent_eligible = ?1, updated_at = ?2
          WHERE id = ?3",
        params![eligible, chrono::Utc::now().to_rfc3339(), task_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace task not found: {task_id}");
    get_workspace_task_on(conn, task_id)?
        .ok_or_else(|| anyhow::anyhow!("Workspace task not found after update: {task_id}"))
}

/// Load one workspace task.
pub fn get_workspace_task(task_id: i64) -> anyhow::Result<Option<WorkspaceTask>> {
    let conn = connect()?;
    get_workspace_task_on(&conn, task_id)
}

fn get_workspace_task_on(conn: &Connection, task_id: i64) -> anyhow::Result<Option<WorkspaceTask>> {
    conn.query_row(
        "SELECT t.id, t.workspace_id, t.title, t.details, t.capability, t.status,
                t.source_meeting_id, COALESCE(m.title, ''), t.created_at, t.updated_at,
                t.action_item_id, t.attempt, t.rejection_notes, t.agent_eligible
           FROM workspace_tasks t
           LEFT JOIN meetings m ON m.id = t.source_meeting_id
          WHERE t.id = ?1",
        params![task_id],
        workspace_task_from_row,
    )
    .optional()
    .map_err(Into::into)
}

/// Return whether a workspace already has a task in flight.
pub fn workspace_has_running_task(workspace_id: i64) -> anyhow::Result<bool> {
    let conn = connect()?;
    workspace_has_running_task_on(&conn, workspace_id)
}

fn workspace_has_running_task_on(conn: &Connection, workspace_id: i64) -> anyhow::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM workspace_tasks
              WHERE workspace_id = ?1 AND status = 'running'
         )",
        params![workspace_id],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

/// Return the oldest queued task in a workspace.
pub fn next_queued_task(workspace_id: i64) -> anyhow::Result<Option<WorkspaceTask>> {
    let conn = connect()?;
    next_queued_task_on(&conn, workspace_id)
}

fn next_queued_task_on(
    conn: &Connection,
    workspace_id: i64,
) -> anyhow::Result<Option<WorkspaceTask>> {
    conn.query_row(
        "SELECT t.id, t.workspace_id, t.title, t.details, t.capability, t.status,
                t.source_meeting_id, COALESCE(m.title, ''), t.created_at, t.updated_at,
                t.action_item_id, t.attempt, t.rejection_notes, t.agent_eligible
           FROM workspace_tasks t
           LEFT JOIN meetings m ON m.id = t.source_meeting_id
          WHERE t.workspace_id = ?1 AND t.status = 'queued' AND t.agent_eligible = 1
          ORDER BY t.created_at ASC, t.id ASC
          LIMIT 1",
        params![workspace_id],
        workspace_task_from_row,
    )
    .optional()
    .map_err(Into::into)
}

/// Record a failed run for a queued task that could not begin execution.
pub fn fail_task_that_could_not_start(
    task_id: i64,
    engine: &str,
    error: &str,
) -> anyhow::Result<bool> {
    let conn = connect()?;
    fail_task_that_could_not_start_on(&conn, task_id, engine, error)
}

fn fail_task_that_could_not_start_on(
    conn: &Connection,
    task_id: i64,
    engine: &str,
    error: &str,
) -> anyhow::Result<bool> {
    let transaction =
        rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    let Some(task) = get_workspace_task_on(&transaction, task_id)? else {
        transaction.commit()?;
        return Ok(false);
    };
    if task.status != "queued" || workspace_has_running_task_on(&transaction, task.workspace_id)? {
        transaction.commit()?;
        return Ok(false);
    }

    let now = chrono::Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO workspace_runs
             (workspace_id, task_id, engine, status, log, error, started_at, finished_at)
         VALUES (?1, ?2, ?3, 'failed', '', ?4, ?5, ?5)",
        params![task.workspace_id, task_id, engine, error, now],
    )?;
    let updated = transaction.execute(
        "UPDATE workspace_tasks
            SET status = 'failed', updated_at = ?1
          WHERE id = ?2 AND status = 'queued'",
        params![now, task_id],
    )?;
    anyhow::ensure!(
        updated == 1,
        "Workspace task changed before it could be failed: {task_id}"
    );
    transaction.commit()?;
    Ok(true)
}

/// Approve a reviewed task and close its linked action item with run evidence.
pub fn approve_workspace_task(task_id: i64) -> anyhow::Result<()> {
    let conn = connect()?;
    approve_workspace_task_on(&conn, task_id)
}

fn approve_workspace_task_on(conn: &Connection, task_id: i64) -> anyhow::Result<()> {
    let task = get_workspace_task_on(conn, task_id)?
        .ok_or_else(|| anyhow::anyhow!("Workspace task not found: {task_id}"))?;
    anyhow::ensure!(
        task.status == "awaiting_review",
        "Task isn't awaiting review: {task_id}"
    );

    conn.execute(
        "UPDATE workspace_tasks SET status = 'done', updated_at = ?1 WHERE id = ?2",
        params![chrono::Utc::now().to_rfc3339(), task_id],
    )?;

    if let Some(action_item_id) = task.action_item_id {
        let latest_run = conn
            .query_row(
                "SELECT id, engine FROM workspace_runs
                  WHERE task_id = ?1
                  ORDER BY id DESC
                  LIMIT 1",
                params![task_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let (engine, evidence) = match latest_run {
            Some((run_id, engine)) => {
                let evidence = conn
                    .query_row(
                        "SELECT path FROM workspace_artifacts
                          WHERE run_id = ?1
                          ORDER BY id DESC
                          LIMIT 1",
                        params![run_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .unwrap_or_default();
                (engine, evidence)
            }
            None => ("agent".to_string(), String::new()),
        };
        conn.execute(
            "UPDATE action_items
                SET done = 1, status = 'done', completed_by = ?1,
                    completed_at = ?2, evidence = ?3
              WHERE id = ?4",
            params![
                format!("agent:{engine}"),
                chrono::Utc::now().to_rfc3339(),
                evidence,
                action_item_id
            ],
        )?;
    }
    Ok(())
}

/// Reject a reviewed task, preserving the reason for its next attempt.
pub fn reject_workspace_task(task_id: i64, reason: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    reject_workspace_task_on(&conn, task_id, reason)
}

fn reject_workspace_task_on(conn: &Connection, task_id: i64, reason: &str) -> anyhow::Result<()> {
    let reason = reason.trim();
    anyhow::ensure!(
        !reason.is_empty(),
        "Say what the next run should do differently."
    );
    let mut task = get_workspace_task_on(conn, task_id)?
        .ok_or_else(|| anyhow::anyhow!("Workspace task not found: {task_id}"))?;
    anyhow::ensure!(
        task.status == "awaiting_review",
        "Task isn't awaiting review: {task_id}"
    );
    task.rejection_notes.push(reason.to_string());
    let rejection_notes = serde_json::to_string(&task.rejection_notes)?;
    conn.execute(
        "UPDATE workspace_tasks
            SET status = 'queued', attempt = attempt + 1,
                rejection_notes = ?1, updated_at = ?2
          WHERE id = ?3",
        params![rejection_notes, chrono::Utc::now().to_rfc3339(), task_id],
    )?;
    Ok(())
}

fn workspace_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRun> {
    Ok(WorkspaceRun {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        task_id: row.get(2)?,
        engine: row.get(3)?,
        status: row.get(4)?,
        log: row.get(5)?,
        report: row.get(6)?,
        error: row.get(7)?,
        started_at: row.get(8)?,
        finished_at: row.get(9)?,
    })
}

/// Create a run and mark its task as running.
pub fn create_workspace_run(
    workspace_id: i64,
    task_id: i64,
    engine: &str,
) -> anyhow::Result<WorkspaceRun> {
    let conn = connect()?;
    create_workspace_run_on(&conn, workspace_id, task_id, engine)
}

fn create_workspace_run_on(
    conn: &Connection,
    workspace_id: i64,
    task_id: i64,
    engine: &str,
) -> anyhow::Result<WorkspaceRun> {
    let updated = conn.execute(
        "UPDATE workspace_tasks
            SET status = 'running', updated_at = ?1
          WHERE id = ?2 AND workspace_id = ?3 AND status != 'running'",
        params![chrono::Utc::now().to_rfc3339(), task_id, workspace_id],
    )?;
    anyhow::ensure!(
        updated == 1,
        "Workspace task is already running or missing: {task_id}"
    );

    let updated = conn.execute(
        "UPDATE workspaces SET updated_at = ?1 WHERE id = ?2",
        params![chrono::Utc::now().to_rfc3339(), workspace_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {workspace_id}");

    conn.execute(
        "INSERT INTO workspace_runs (workspace_id, task_id, engine, started_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            workspace_id,
            task_id,
            engine,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    let run_id = conn.last_insert_rowid();
    get_workspace_run_on(conn, run_id)?
        .ok_or_else(|| anyhow::anyhow!("Workspace run not found after insert: {run_id}"))
}

/// Finish a run and move successful tasks into review before final approval.
pub fn finish_workspace_run(
    run_id: i64,
    status: &str,
    log: &str,
    error: &str,
) -> anyhow::Result<()> {
    let conn = connect()?;
    finish_workspace_run_on(&conn, run_id, status, log, error)
}

fn finish_workspace_run_on(
    conn: &Connection,
    run_id: i64,
    status: &str,
    log: &str,
    error: &str,
) -> anyhow::Result<()> {
    let task_status = match status {
        "done" => "awaiting_review",
        "failed" => "failed",
        "stopped" => "queued",
        _ => anyhow::bail!("Unknown workspace run status: {status}"),
    };
    let task_id = conn
        .query_row(
            "SELECT task_id FROM workspace_runs WHERE id = ?1",
            params![run_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let task_id = task_id.ok_or_else(|| anyhow::anyhow!("Workspace run not found: {run_id}"))?;

    let updated = conn.execute(
        "UPDATE workspace_runs
            SET status = ?1,
                log = CASE WHEN ?2 = '' THEN log ELSE ?2 END,
                error = ?3,
                finished_at = ?4
          WHERE id = ?5",
        params![status, log, error, chrono::Utc::now().to_rfc3339(), run_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace run not found: {run_id}");

    let updated = conn.execute(
        "UPDATE workspace_tasks SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![task_status, chrono::Utc::now().to_rfc3339(), task_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace task not found: {task_id}");
    Ok(())
}

/// Replace the stored live log without changing run status.
pub(crate) fn update_workspace_run_log(run_id: i64, log: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    let updated = conn.execute(
        "UPDATE workspace_runs SET log = ?1 WHERE id = ?2",
        params![log, run_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace run not found: {run_id}");
    Ok(())
}

/// Store the plain-language summary of a completed workspace run.
pub fn set_workspace_run_report(run_id: i64, report: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    set_workspace_run_report_on(&conn, run_id, report)
}

fn set_workspace_run_report_on(conn: &Connection, run_id: i64, report: &str) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE workspace_runs SET report = ?1 WHERE id = ?2",
        params![report, run_id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace run not found: {run_id}");
    Ok(())
}

/// Recover tasks and runs left in flight when the previous process exited.
pub fn requeue_orphaned_running_tasks() -> anyhow::Result<usize> {
    let conn = connect()?;
    requeue_orphaned_running_tasks_on(&conn)
}

fn requeue_orphaned_running_tasks_on(conn: &Connection) -> anyhow::Result<usize> {
    let now = chrono::Utc::now().to_rfc3339();
    let requeued = conn.execute(
        "UPDATE workspace_tasks
            SET status = 'queued', updated_at = ?1
          WHERE status = 'running'",
        params![now],
    )?;
    conn.execute(
        "UPDATE workspace_runs
            SET status = 'failed',
                error = 'The app closed before this run finished.',
                finished_at = ?1
          WHERE status = 'running'",
        params![now],
    )?;
    Ok(requeued)
}

/// Load a run by id.
pub fn get_workspace_run(run_id: i64) -> anyhow::Result<Option<WorkspaceRun>> {
    let conn = connect()?;
    get_workspace_run_on(&conn, run_id)
}

fn get_workspace_run_on(conn: &Connection, run_id: i64) -> anyhow::Result<Option<WorkspaceRun>> {
    conn.query_row(
        "SELECT id, workspace_id, task_id, engine, status, log, report, error,
                started_at, finished_at
           FROM workspace_runs
          WHERE id = ?1",
        params![run_id],
        workspace_run_from_row,
    )
    .optional()
    .map_err(Into::into)
}

/// Return the most recent run for a task.
pub fn get_latest_workspace_run(task_id: i64) -> anyhow::Result<Option<WorkspaceRun>> {
    let conn = connect()?;
    get_latest_workspace_run_on(&conn, task_id)
}

fn get_latest_workspace_run_on(
    conn: &Connection,
    task_id: i64,
) -> anyhow::Result<Option<WorkspaceRun>> {
    conn.query_row(
        "SELECT id, workspace_id, task_id, engine, status, log, report, error,
                started_at, finished_at
           FROM workspace_runs
          WHERE task_id = ?1
          ORDER BY id DESC
          LIMIT 1",
        params![task_id],
        workspace_run_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn workspace_artifact_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceArtifact> {
    Ok(WorkspaceArtifact {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        run_id: row.get(2)?,
        name: row.get(3)?,
        path: row.get(4)?,
        created_at: row.get(5)?,
    })
}

/// Record one file produced by a workspace run.
pub fn insert_workspace_artifact(
    workspace_id: i64,
    run_id: i64,
    name: &str,
    path: &str,
) -> anyhow::Result<WorkspaceArtifact> {
    let conn = connect()?;
    insert_workspace_artifact_on(&conn, workspace_id, run_id, name, path)
}

fn insert_workspace_artifact_on(
    conn: &Connection,
    workspace_id: i64,
    run_id: i64,
    name: &str,
    path: &str,
) -> anyhow::Result<WorkspaceArtifact> {
    conn.execute(
        "INSERT INTO workspace_artifacts
             (workspace_id, run_id, name, path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            workspace_id,
            run_id,
            name,
            path,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    let artifact_id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, workspace_id, run_id, name, path, created_at
           FROM workspace_artifacts
          WHERE id = ?1",
        params![artifact_id],
        workspace_artifact_from_row,
    )
    .map_err(Into::into)
}

/// List a workspace's artifacts newest first.
pub fn list_workspace_artifacts(workspace_id: i64) -> anyhow::Result<Vec<WorkspaceArtifact>> {
    let conn = connect()?;
    list_workspace_artifacts_on(&conn, workspace_id)
}

fn list_workspace_artifacts_on(
    conn: &Connection,
    workspace_id: i64,
) -> anyhow::Result<Vec<WorkspaceArtifact>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, run_id, name, path, created_at
           FROM workspace_artifacts
          WHERE workspace_id = ?1
          ORDER BY id DESC",
    )?;
    let rows = stmt.query_map(params![workspace_id], workspace_artifact_from_row)?;
    let mut artifacts = Vec::new();
    for row in rows {
        artifacts.push(row?);
    }
    Ok(artifacts)
}

/// Select the execution engine for a workspace.
pub fn set_workspace_engine(id: i64, engine: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    set_workspace_engine_on(&conn, id, engine)
}

fn set_workspace_engine_on(conn: &Connection, id: i64, engine: &str) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE workspaces SET engine = ?1, updated_at = ?2 WHERE id = ?3",
        params![engine, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {id}");
    Ok(())
}

/// Select the model used by a workspace's local-engine runs.
pub fn set_workspace_model(id: i64, model: &str) -> anyhow::Result<()> {
    let conn = connect()?;
    set_workspace_model_on(&conn, id, model)
}

fn set_workspace_model_on(conn: &Connection, id: i64, model: &str) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE workspaces SET model = ?1, updated_at = ?2 WHERE id = ?3",
        params![model, chrono::Utc::now().to_rfc3339(), id],
    )?;
    anyhow::ensure!(updated == 1, "Workspace not found: {id}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) fn create_workspace_tables(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspaces (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL,
             engine TEXT NOT NULL DEFAULT 'local',
             model TEXT NOT NULL DEFAULT '',
             network_allowed INTEGER NOT NULL DEFAULT 0,
             instructions TEXT NOT NULL DEFAULT '',
             color TEXT NOT NULL DEFAULT 'blue',
             overview TEXT NOT NULL DEFAULT '',
             overview_source_hash TEXT NOT NULL DEFAULT '',
             overview_generated_at TEXT NOT NULL DEFAULT '',
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workspace_context_items (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             workspace_id INTEGER NOT NULL,
             kind TEXT NOT NULL CHECK(kind IN ('folder','meeting','file')),
             value TEXT NOT NULL,
             label TEXT NOT NULL,
             created_at TEXT NOT NULL,
             UNIQUE(workspace_id, kind, value)
         );
         CREATE TABLE IF NOT EXISTS workspace_addons (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             kind TEXT NOT NULL CHECK(kind IN ('skill','agent')),
             slug TEXT NOT NULL UNIQUE,
             name TEXT NOT NULL,
             description TEXT NOT NULL DEFAULT '',
             instructions TEXT NOT NULL DEFAULT '',
             builtin INTEGER NOT NULL DEFAULT 0,
             created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workspace_addon_links (
             workspace_id INTEGER NOT NULL,
             addon_id INTEGER NOT NULL,
             created_at TEXT NOT NULL,
             PRIMARY KEY (workspace_id, addon_id)
         );
         CREATE TABLE IF NOT EXISTS workspace_tasks (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             workspace_id INTEGER NOT NULL,
             title TEXT NOT NULL,
             details TEXT NOT NULL DEFAULT '',
             capability TEXT NOT NULL DEFAULT '',
             status TEXT NOT NULL DEFAULT 'queued'
                 CHECK(status IN ('queued','running','awaiting_review','done','failed')),
             source_meeting_id INTEGER,
             action_item_id INTEGER,
             attempt INTEGER NOT NULL DEFAULT 1,
             rejection_notes TEXT NOT NULL DEFAULT '[]',
             agent_eligible INTEGER NOT NULL DEFAULT 1,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workspace_task_staffing (
             task_id INTEGER PRIMARY KEY,
             mode TEXT NOT NULL CHECK(mode IN ('automatic','manual')),
             agent_id INTEGER,
             skill_ids TEXT NOT NULL DEFAULT '[]',
             reason TEXT NOT NULL DEFAULT '',
             resolved_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS meeting_workspace_bindings (
             meeting_id INTEGER PRIMARY KEY,
             workspace_id INTEGER,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS folders (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL,
             color TEXT NOT NULL DEFAULT 'blue',
             instructions TEXT NOT NULL DEFAULT '',
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS meeting_folders (
             meeting_id INTEGER PRIMARY KEY,
             folder_id INTEGER,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS folder_overviews (
             folder_id INTEGER PRIMARY KEY,
             summary TEXT NOT NULL,
             source_hash TEXT NOT NULL,
             generated_at TEXT NOT NULL
         );",
    )?;
    if !column_exists(conn, "workspaces", "instructions")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN instructions TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(conn, "workspaces", "color")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN color TEXT NOT NULL DEFAULT 'blue'",
            [],
        )?;
    }
    if !column_exists(conn, "workspaces", "overview")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN overview TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(conn, "workspaces", "overview_source_hash")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN overview_source_hash TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !column_exists(conn, "workspaces", "overview_generated_at")? {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN overview_generated_at TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

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

    fn workspace_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meetings (
                 id INTEGER PRIMARY KEY,
                 title TEXT NOT NULL,
                 recorded_at TEXT NOT NULL DEFAULT '',
                 duration_seconds REAL NOT NULL DEFAULT 0,
                 transcript TEXT NOT NULL DEFAULT '',
                 summary TEXT NOT NULL DEFAULT '',
                 template_used TEXT NOT NULL DEFAULT '',
                 audio_file_path TEXT,
                 attendees TEXT NOT NULL DEFAULT '[]',
                 user_notes TEXT NOT NULL DEFAULT '',
                 tags TEXT NOT NULL DEFAULT '[]',
                 pinned INTEGER NOT NULL DEFAULT 0,
                 locked INTEGER NOT NULL DEFAULT 0,
                 archived INTEGER NOT NULL DEFAULT 0,
                 transcript_turns TEXT NOT NULL DEFAULT '[]',
                 link TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE workspace_runs (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 workspace_id INTEGER NOT NULL,
                 task_id INTEGER NOT NULL,
                 engine TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'running'
                     CHECK(status IN ('running','done','failed','stopped')),
                 log TEXT NOT NULL DEFAULT '',
                 report TEXT NOT NULL DEFAULT '',
                 error TEXT NOT NULL DEFAULT '',
                 started_at TEXT NOT NULL,
                 finished_at TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE workspace_artifacts (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 workspace_id INTEGER NOT NULL,
                 run_id INTEGER NOT NULL,
                 name TEXT NOT NULL,
                 path TEXT NOT NULL,
                 created_at TEXT NOT NULL
             );
             CREATE TABLE action_items (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 meeting_id INTEGER NOT NULL,
                 ord INTEGER NOT NULL,
                 text TEXT NOT NULL,
                 assignee TEXT NOT NULL DEFAULT '',
                 due TEXT NOT NULL DEFAULT '',
                 done INTEGER NOT NULL DEFAULT 0,
                 status TEXT NOT NULL DEFAULT 'todo',
                 completed_by TEXT NOT NULL DEFAULT '',
                 completed_at TEXT NOT NULL DEFAULT '',
                 evidence TEXT NOT NULL DEFAULT ''
             );",
        )
        .unwrap();
        create_workspace_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn migrate_workspace_tasks_v2_rebuilds_old_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workspace_tasks (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 workspace_id INTEGER NOT NULL,
                 title TEXT NOT NULL,
                 details TEXT NOT NULL DEFAULT '',
                 status TEXT NOT NULL DEFAULT 'queued'
                     CHECK(status IN ('queued','running','done','failed')),
                 source_meeting_id INTEGER,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             INSERT INTO workspace_tasks
                 (workspace_id, title, details, status, source_meeting_id, created_at, updated_at)
             VALUES (2, 'Old task', 'Details', 'done', 7, 'created', 'updated');",
        )
        .unwrap();

        migrate_workspace_tasks_v2(&conn).unwrap();
        migrate_workspace_task_agent_eligibility(&conn).unwrap();
        migrate_workspace_task_capability(&conn).unwrap();
        assert!(column_exists(&conn, "workspace_tasks", "action_item_id").unwrap());
        assert!(column_exists(&conn, "workspace_tasks", "attempt").unwrap());
        assert!(column_exists(&conn, "workspace_tasks", "rejection_notes").unwrap());
        assert!(column_exists(&conn, "workspace_tasks", "agent_eligible").unwrap());
        assert!(column_exists(&conn, "workspace_tasks", "capability").unwrap());
        let old: (String, i64, String) = conn
            .query_row(
                "SELECT title, attempt, rejection_notes FROM workspace_tasks WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(old, ("Old task".to_string(), 1, "[]".to_string()));
        conn.execute(
            "INSERT INTO workspace_tasks
                 (workspace_id, title, status, created_at, updated_at)
             VALUES (2, 'Review task', 'awaiting_review', 'created', 'updated')",
            [],
        )
        .unwrap();
        migrate_workspace_tasks_v2(&conn).unwrap();
        migrate_workspace_task_agent_eligibility(&conn).unwrap();
        migrate_workspace_task_capability(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn migrate_workspace_model_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workspaces (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 engine TEXT NOT NULL DEFAULT 'local',
                 network_allowed INTEGER NOT NULL DEFAULT 0,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );",
        )
        .unwrap();

        migrate_workspace_model(&conn).unwrap();
        migrate_workspace_model(&conn).unwrap();

        assert!(column_exists(&conn, "workspaces", "model").unwrap());
    }

    #[test]
    fn builtin_addon_seed_is_idempotent_updates_builtins_and_preserves_custom_rows() {
        let conn = workspace_conn();
        seed_builtin_addons_on(&conn).unwrap();
        seed_builtin_addons_on(&conn).unwrap();

        let builtin_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workspace_addons WHERE builtin = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(builtin_count as usize, crate::addons::BUILTIN.len());

        conn.execute(
            "UPDATE workspace_addons SET instructions = 'stale' WHERE slug = 'deep-research'",
            [],
        )
        .unwrap();
        let custom = create_addon_on(&conn, "skill", "My research", "Mine", "Keep me").unwrap();
        seed_builtin_addons_on(&conn).unwrap();

        let refreshed: String = conn
            .query_row(
                "SELECT instructions FROM workspace_addons WHERE slug = 'deep-research'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            refreshed,
            crate::addons::BUILTIN
                .iter()
                .find(|addon| addon.slug == "deep-research")
                .unwrap()
                .instructions
        );
        assert_eq!(
            conn.query_row(
                "SELECT instructions FROM workspace_addons WHERE id = ?1",
                params![custom.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "Keep me"
        );

        conn.execute("DELETE FROM workspace_addons WHERE slug = 'reviewer'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO workspace_addons
                 (kind, slug, name, description, instructions, builtin, created_at)
             VALUES ('skill', 'reviewer', 'Custom reviewer', '', 'Custom text', 0, 'now')",
            [],
        )
        .unwrap();
        seed_builtin_addons_on(&conn).unwrap();
        let collision: (String, String, i32) = conn
            .query_row(
                "SELECT kind, instructions, builtin FROM workspace_addons WHERE slug = 'reviewer'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(collision, ("skill".into(), "Custom text".into(), 0));
    }

    #[test]
    fn create_addon_slugifies_deduplicates_and_validates() {
        let conn = workspace_conn();
        let first = create_addon_on(
            &conn,
            "skill",
            "  Plan & Review  ",
            "  Description  ",
            "  Instructions  ",
        )
        .unwrap();
        let second = create_addon_on(&conn, "skill", "Plan & Review", "", "Second").unwrap();
        assert_eq!(first.slug, "plan-review");
        assert_eq!(second.slug, "plan-review-2");
        assert_eq!(first.name, "Plan & Review");
        assert_eq!(first.description, "Description");
        assert_eq!(first.instructions, "Instructions");
        assert!(!first.builtin);

        assert_eq!(
            create_addon_on(&conn, "skill", " ", "", "instructions")
                .unwrap_err()
                .to_string(),
            "Give the skill a name."
        );
        assert_eq!(
            create_addon_on(&conn, "agent", " ", "", "instructions")
                .unwrap_err()
                .to_string(),
            "Give the agent a name."
        );
        assert_eq!(
            create_addon_on(&conn, "skill", "Named", "", " ")
                .unwrap_err()
                .to_string(),
            "Add instructions."
        );
        assert!(create_addon_on(&conn, "other", "Named", "", "Instructions").is_err());
    }

    #[test]
    fn attach_addon_enforces_one_agent_and_keeps_skills() {
        let conn = workspace_conn();
        seed_builtin_addons_on(&conn).unwrap();
        let workspace = create_workspace_on(&conn, "Research", "blue").unwrap();
        let catalog = list_addons_on(&conn).unwrap();
        let researcher = catalog
            .iter()
            .find(|addon| addon.slug == "researcher")
            .unwrap();
        let reviewer = catalog
            .iter()
            .find(|addon| addon.slug == "reviewer")
            .unwrap();
        let skill = catalog
            .iter()
            .find(|addon| addon.slug == "deep-research")
            .unwrap();

        attach_addon_on(&conn, workspace.id, researcher.id).unwrap();
        attach_addon_on(&conn, workspace.id, skill.id).unwrap();
        let attached = attach_addon_on(&conn, workspace.id, reviewer.id).unwrap();

        assert_eq!(attached.len(), 2);
        assert_eq!(attached[0].slug, "reviewer");
        assert_eq!(attached[1].slug, "deep-research");
        assert!(!attached.iter().any(|addon| addon.slug == "researcher"));
        assert!(attach_addon_on(&conn, 404, skill.id).is_err());
        assert!(attach_addon_on(&conn, workspace.id, 404).is_err());
    }

    #[test]
    fn detach_addon_removes_the_workspace_link() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Research", "blue").unwrap();
        let skill = create_addon_on(&conn, "skill", "Brief", "", "Be brief").unwrap();
        attach_addon_on(&conn, workspace.id, skill.id).unwrap();

        let attached = detach_addon_on(&conn, workspace.id, skill.id).unwrap();
        assert!(attached.is_empty());
    }

    #[test]
    fn delete_addon_refuses_builtins_and_removes_links() {
        let conn = workspace_conn();
        seed_builtin_addons_on(&conn).unwrap();
        let workspace = create_workspace_on(&conn, "Research", "blue").unwrap();
        let builtin = list_addons_on(&conn)
            .unwrap()
            .into_iter()
            .find(|addon| addon.builtin)
            .unwrap();
        assert_eq!(
            delete_addon_on(&conn, builtin.id).unwrap_err().to_string(),
            "Built-in skills and agents can't be deleted."
        );

        let custom = create_addon_on(&conn, "skill", "Brief", "", "Be brief").unwrap();
        attach_addon_on(&conn, workspace.id, custom.id).unwrap();
        delete_addon_on(&conn, custom.id).unwrap();
        let link_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workspace_addon_links WHERE addon_id = ?1",
                params![custom.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(link_count, 0);
        assert!(!list_addons_on(&conn)
            .unwrap()
            .iter()
            .any(|addon| addon.id == custom.id));
    }

    #[test]
    fn get_workspace_returns_attached_addons() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Research", "blue").unwrap();
        let agent = create_addon_on(&conn, "agent", "Writer", "", "Write").unwrap();
        let skill = create_addon_on(&conn, "skill", "Citations", "", "Cite").unwrap();
        attach_addon_on(&conn, workspace.id, skill.id).unwrap();
        attach_addon_on(&conn, workspace.id, agent.id).unwrap();

        let detail = get_workspace_on(&conn, workspace.id).unwrap().unwrap();
        assert_eq!(detail.addons.len(), 2);
        assert_eq!(detail.addons[0].kind, "agent");
        assert_eq!(detail.addons[1].kind, "skill");
    }

    #[test]
    fn create_workspace_task_dedups_by_action_item() {
        let conn = workspace_conn();
        let first_workspace = create_workspace_on(&conn, "First", "blue").unwrap();
        let second_workspace = create_workspace_on(&conn, "Second", "blue").unwrap();

        let first = create_workspace_task_on(
            &conn,
            first_workspace.id,
            "Original title",
            "",
            "",
            None,
            Some(5),
        )
        .unwrap();
        let duplicate = create_workspace_task_on(
            &conn,
            first_workspace.id,
            "Changed title",
            "Changed details",
            "",
            None,
            Some(5),
        )
        .unwrap();
        let other_workspace = create_workspace_task_on(
            &conn,
            second_workspace.id,
            "Other task",
            "",
            "",
            None,
            Some(5),
        )
        .unwrap();

        assert_eq!(duplicate.id, first.id);
        assert_eq!(duplicate.title, "Original title");
        assert_ne!(other_workspace.id, first.id);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn task_staffing_set_get_round_trips() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task = create_workspace_task_on(&conn, workspace.id, "Draft memo", "", "", None, None)
            .unwrap();
        let staffing = TaskStaffing {
            mode: "automatic".to_string(),
            agent_id: Some(17),
            skill_ids: vec![23, 29],
            reason: "Researcher matched research. Deep research matched compare.".to_string(),
            resolved_at: "2026-08-25T18:00:00Z".to_string(),
        };

        set_task_staffing_on(&conn, task.id, &staffing).unwrap();
        let stored = get_task_staffing_on(&conn, task.id).unwrap().unwrap();

        assert_eq!(stored.mode, staffing.mode);
        assert_eq!(stored.agent_id, staffing.agent_id);
        assert_eq!(stored.skill_ids, staffing.skill_ids);
        assert_eq!(stored.reason, staffing.reason);
        assert_eq!(stored.resolved_at, staffing.resolved_at);
    }

    #[test]
    fn capability_tasks_persist_adapter_and_baseline_staffing() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Research", "blue").unwrap();
        seed_builtin_addons_on(&conn).unwrap();
        let catalog = list_addons_on(&conn).unwrap();
        let research_skill = catalog
            .iter()
            .find(|addon| addon.slug == "deep-research")
            .unwrap();

        let research = create_workspace_task_on(
            &conn,
            workspace.id,
            "Research competitors",
            "Compare the market",
            "research",
            None,
            None,
        )
        .unwrap();
        let research_staffing = crate::commands::capability_task_staffing(
            &research.title,
            &research.details,
            &research.capability,
            &catalog,
        );
        set_task_staffing_on(&conn, research.id, &research_staffing).unwrap();

        let stored_research = get_workspace_task_on(&conn, research.id).unwrap().unwrap();
        let stored_staffing = get_task_staffing_on(&conn, research.id).unwrap().unwrap();
        assert_eq!(stored_research.capability, "research");
        assert_eq!(stored_staffing.mode, "manual");
        assert_eq!(stored_staffing.skill_ids, vec![research_skill.id]);
        assert_eq!(stored_staffing.reason, "Adapter: deep-research");

        let present = create_workspace_task_on(
            &conn,
            workspace.id,
            "Present the findings",
            "",
            "present",
            None,
            None,
        )
        .unwrap();
        let catalog_without_slides = catalog
            .iter()
            .filter(|addon| addon.slug != "slides-deck")
            .cloned()
            .collect::<Vec<_>>();
        let staffing = crate::commands::capability_task_staffing(
            &present.title,
            &present.details,
            &present.capability,
            &catalog_without_slides,
        );
        set_task_staffing_on(&conn, present.id, &staffing).unwrap();

        let stored = get_task_staffing_on(&conn, present.id).unwrap().unwrap();
        assert!(stored.skill_ids.is_empty());
        assert_eq!(stored.reason, "baseline:present");
    }

    #[test]
    fn task_staffing_set_twice_upserts_same_task() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task = create_workspace_task_on(&conn, workspace.id, "Draft memo", "", "", None, None)
            .unwrap();
        let first = TaskStaffing {
            mode: "automatic".to_string(),
            agent_id: Some(17),
            skill_ids: vec![23],
            reason: "Automatic choice.".to_string(),
            resolved_at: "2026-08-25T18:00:00Z".to_string(),
        };
        let second = TaskStaffing {
            mode: "manual".to_string(),
            agent_id: Some(31),
            skill_ids: vec![37, 41],
            reason: String::new(),
            resolved_at: "2026-08-25T18:05:00Z".to_string(),
        };

        set_task_staffing_on(&conn, task.id, &first).unwrap();
        set_task_staffing_on(&conn, task.id, &second).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workspace_task_staffing WHERE task_id = ?1",
                params![task.id],
                |row| row.get(0),
            )
            .unwrap();
        let stored = get_task_staffing_on(&conn, task.id).unwrap().unwrap();
        assert_eq!(count, 1);
        assert_eq!(stored.mode, "manual");
        assert_eq!(stored.agent_id, second.agent_id);
        assert_eq!(stored.skill_ids, second.skill_ids);
        assert_eq!(stored.reason, "");
        assert_eq!(stored.resolved_at, second.resolved_at);
    }

    #[test]
    fn deleting_workspace_task_removes_its_staffing() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task = create_workspace_task_on(&conn, workspace.id, "Draft memo", "", "", None, None)
            .unwrap();
        set_task_staffing_on(
            &conn,
            task.id,
            &TaskStaffing {
                mode: "manual".to_string(),
                agent_id: None,
                skill_ids: vec![23],
                reason: String::new(),
                resolved_at: "2026-08-25T18:00:00Z".to_string(),
            },
        )
        .unwrap();

        delete_workspace_task_on(&conn, task.id).unwrap();

        assert!(get_task_staffing_on(&conn, task.id).unwrap().is_none());
    }

    #[test]
    fn next_queued_task_returns_oldest_and_none_when_empty() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        assert!(next_queued_task_on(&conn, workspace.id).unwrap().is_none());

        let newer =
            create_workspace_task_on(&conn, workspace.id, "Newer", "", "", None, None).unwrap();
        let oldest =
            create_workspace_task_on(&conn, workspace.id, "Oldest", "", "", None, None).unwrap();
        let running =
            create_workspace_task_on(&conn, workspace.id, "Running", "", "", None, None).unwrap();
        conn.execute(
            "UPDATE workspace_tasks SET created_at = ?1 WHERE id = ?2",
            params!["2026-01-02T00:00:00Z", newer.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE workspace_tasks SET created_at = ?1 WHERE id = ?2",
            params!["2026-01-01T00:00:00Z", oldest.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE workspace_tasks SET created_at = ?1 WHERE id = ?2",
            params!["2025-01-01T00:00:00Z", running.id],
        )
        .unwrap();
        create_workspace_run_on(&conn, workspace.id, running.id, "local").unwrap();

        assert_eq!(
            next_queued_task_on(&conn, workspace.id)
                .unwrap()
                .unwrap()
                .id,
            oldest.id
        );
    }

    #[test]
    fn workspace_running_task_detection_tracks_run_state() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        assert!(!workspace_has_running_task_on(&conn, workspace.id).unwrap());

        let task =
            create_workspace_task_on(&conn, workspace.id, "Draft", "", "", None, None).unwrap();
        let run = create_workspace_run_on(&conn, workspace.id, task.id, "local").unwrap();
        assert!(workspace_has_running_task_on(&conn, workspace.id).unwrap());

        finish_workspace_run_on(&conn, run.id, "failed", "", "failed").unwrap();
        assert!(!workspace_has_running_task_on(&conn, workspace.id).unwrap());
    }

    #[test]
    fn queued_task_that_cannot_start_is_marked_failed() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task =
            create_workspace_task_on(&conn, workspace.id, "Draft", "", "", None, None).unwrap();

        assert!(fail_task_that_could_not_start_on(
            &conn,
            task.id,
            "local",
            "Meeting context is missing."
        )
        .unwrap());
        assert_eq!(
            get_workspace_task_on(&conn, task.id)
                .unwrap()
                .unwrap()
                .status,
            "failed"
        );
        let run = get_latest_workspace_run_on(&conn, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(run.status, "failed");
        assert_eq!(run.engine, "local");
        assert_eq!(run.log, "");
        assert_eq!(run.error, "Meeting context is missing.");
        assert_eq!(run.started_at, run.finished_at);
    }

    #[test]
    fn running_task_is_not_changed_when_start_failure_is_reported() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task =
            create_workspace_task_on(&conn, workspace.id, "Draft", "", "", None, None).unwrap();
        let existing_run = create_workspace_run_on(&conn, workspace.id, task.id, "local").unwrap();

        assert!(
            !fail_task_that_could_not_start_on(&conn, task.id, "codex", "Could not start.")
                .unwrap()
        );
        assert_eq!(
            get_workspace_task_on(&conn, task.id)
                .unwrap()
                .unwrap()
                .status,
            "running"
        );
        let latest = get_latest_workspace_run_on(&conn, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(latest.id, existing_run.id);
        assert_eq!(latest.status, "running");
        assert_eq!(latest.error, "");
    }

    #[test]
    fn queued_task_stays_queued_when_its_workspace_has_another_running_task() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let queued =
            create_workspace_task_on(&conn, workspace.id, "Queued", "", "", None, None).unwrap();
        let running =
            create_workspace_task_on(&conn, workspace.id, "Running", "", "", None, None).unwrap();
        let running_run =
            create_workspace_run_on(&conn, workspace.id, running.id, "local").unwrap();

        assert!(!fail_task_that_could_not_start_on(
            &conn,
            queued.id,
            "codex",
            "Another task is already running in this workspace."
        )
        .unwrap());
        assert_eq!(
            get_workspace_task_on(&conn, queued.id)
                .unwrap()
                .unwrap()
                .status,
            "queued"
        );
        assert!(get_latest_workspace_run_on(&conn, queued.id)
            .unwrap()
            .is_none());
        assert_eq!(
            get_workspace_run_on(&conn, running_run.id)
                .unwrap()
                .unwrap()
                .status,
            "running"
        );
    }

    #[test]
    fn requeue_orphaned_running_tasks_recovers_tasks_and_runs() {
        let conn = workspace_conn();
        let first_workspace = create_workspace_on(&conn, "First", "blue").unwrap();
        let second_workspace = create_workspace_on(&conn, "Second", "blue").unwrap();
        let first_task =
            create_workspace_task_on(&conn, first_workspace.id, "First", "", "", None, None)
                .unwrap();
        let second_task =
            create_workspace_task_on(&conn, second_workspace.id, "Second", "", "", None, None)
                .unwrap();
        let untouched =
            create_workspace_task_on(&conn, first_workspace.id, "Queued", "", "", None, None)
                .unwrap();
        let first_run =
            create_workspace_run_on(&conn, first_workspace.id, first_task.id, "local").unwrap();
        let second_run =
            create_workspace_run_on(&conn, second_workspace.id, second_task.id, "codex").unwrap();

        assert_eq!(requeue_orphaned_running_tasks_on(&conn).unwrap(), 2);
        for task_id in [first_task.id, second_task.id, untouched.id] {
            assert_eq!(
                get_workspace_task_on(&conn, task_id)
                    .unwrap()
                    .unwrap()
                    .status,
                "queued"
            );
        }
        for run_id in [first_run.id, second_run.id] {
            let run = get_workspace_run_on(&conn, run_id).unwrap().unwrap();
            assert_eq!(run.status, "failed");
            assert_eq!(run.error, "The app closed before this run finished.");
            assert!(!run.finished_at.is_empty());
        }
    }

    #[test]
    fn finished_run_awaits_review_and_counts_show_it() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task = create_workspace_task_on(&conn, workspace.id, "Draft memo", "", "", None, None)
            .unwrap();
        let run = create_workspace_run_on(&conn, workspace.id, task.id, "local").unwrap();

        finish_workspace_run_on(&conn, run.id, "done", "draft", "").unwrap();
        assert_eq!(
            get_workspace_task_on(&conn, task.id)
                .unwrap()
                .unwrap()
                .status,
            "awaiting_review"
        );
        let awaiting = list_workspaces_on(&conn).unwrap();
        assert_eq!(awaiting[0].awaiting_review_count, 1);
        assert_eq!(awaiting[0].total_task_count, 1);
        assert_eq!(awaiting[0].approved_task_count, 0);

        approve_workspace_task_on(&conn, task.id).unwrap();
        let approved = list_workspaces_on(&conn).unwrap();
        assert_eq!(approved[0].awaiting_review_count, 0);
        assert_eq!(approved[0].approved_task_count, 1);
        assert_eq!(approved[0].total_task_count, 1);
    }

    #[test]
    fn approve_closes_the_linked_action_item_with_evidence() {
        let conn = workspace_conn();
        conn.execute("INSERT INTO meetings (id, title) VALUES (7, 'Review')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO action_items (id, meeting_id, ord, text)
             VALUES (3, 7, 0, 'Draft memo')",
            [],
        )
        .unwrap();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task =
            create_workspace_task_on(&conn, workspace.id, "Draft memo", "", "", Some(7), Some(3))
                .unwrap();
        let run = create_workspace_run_on(&conn, workspace.id, task.id, "claude").unwrap();
        insert_workspace_artifact_on(&conn, workspace.id, run.id, "memo.md", "/tmp/memo.md")
            .unwrap();
        finish_workspace_run_on(&conn, run.id, "done", "draft", "").unwrap();

        approve_workspace_task_on(&conn, task.id).unwrap();
        let action_item: (i64, String, String, String) = conn
            .query_row(
                "SELECT done, status, completed_by, evidence FROM action_items WHERE id = 3",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            action_item,
            (
                1,
                "done".to_string(),
                "agent:claude".to_string(),
                "/tmp/memo.md".to_string()
            )
        );
        assert!(approve_workspace_task_on(&conn, task.id).is_err());
    }

    #[test]
    fn reject_requeues_with_note_and_attempt() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task = create_workspace_task_on(&conn, workspace.id, "Draft memo", "", "", None, None)
            .unwrap();
        let first_run = create_workspace_run_on(&conn, workspace.id, task.id, "local").unwrap();
        finish_workspace_run_on(&conn, first_run.id, "done", "draft", "").unwrap();

        reject_workspace_task_on(&conn, task.id, "  Too long  ").unwrap();
        let first_rejection = get_workspace_task_on(&conn, task.id).unwrap().unwrap();
        assert_eq!(first_rejection.status, "queued");
        assert_eq!(first_rejection.attempt, 2);
        assert_eq!(first_rejection.rejection_notes, vec!["Too long"]);

        let second_run = create_workspace_run_on(&conn, workspace.id, task.id, "codex").unwrap();
        finish_workspace_run_on(&conn, second_run.id, "done", "draft", "").unwrap();
        reject_workspace_task_on(&conn, task.id, "Wrong tone").unwrap();
        let second_rejection = get_workspace_task_on(&conn, task.id).unwrap().unwrap();
        assert_eq!(second_rejection.status, "queued");
        assert_eq!(second_rejection.attempt, 3);
        assert_eq!(
            second_rejection.rejection_notes,
            vec!["Too long", "Wrong tone"]
        );
        assert!(reject_workspace_task_on(&conn, task.id, " ").is_err());
        assert!(reject_workspace_task_on(&conn, task.id, "Try again").is_err());
    }

    #[test]
    fn binding_pushes_open_items_once() {
        let conn = workspace_conn();
        conn.execute(
            "INSERT INTO meetings (id, title) VALUES (7, 'Planning')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO action_items (meeting_id, ord, text, done) VALUES (7, 0, 'A', 0);
             INSERT INTO action_items (meeting_id, ord, text, done) VALUES (7, 1, 'B', 1);
             INSERT INTO action_items (meeting_id, ord, text, assignee, done)
                 VALUES (7, 2, 'C', 'Not mine', 0);
             INSERT INTO action_items (meeting_id, ord, text, done) VALUES (7, 3, 'D', 0);",
        )
        .unwrap();
        let workspace = create_workspace_on(&conn, "Project", "blue").unwrap();

        assert_eq!(
            set_meeting_binding_on(&conn, 7, Some(workspace.id)).unwrap(),
            2
        );
        assert_eq!(
            set_meeting_binding_on(&conn, 7, Some(workspace.id)).unwrap(),
            0
        );
        let mut stmt = conn
            .prepare(
                "SELECT title, action_item_id, source_meeting_id
                   FROM workspace_tasks ORDER BY title",
            )
            .unwrap();
        let tasks: Vec<(String, Option<i64>, Option<i64>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].0, "A");
        assert!(tasks[0].1.is_some());
        assert_eq!(tasks[0].2, Some(7));
        assert_eq!(tasks[1].0, "D");
        assert!(tasks[1].1.is_some());
        assert_eq!(tasks[1].2, Some(7));
        drop(stmt);

        let binding = get_meeting_binding_on(&conn, 7).unwrap().unwrap();
        assert_eq!(binding.workspace_id, Some(workspace.id));
        assert_eq!(binding.workspace_name, "Project");
        assert_eq!(set_meeting_binding_on(&conn, 7, None).unwrap(), 0);
        assert_eq!(
            get_meeting_binding_on(&conn, 7)
                .unwrap()
                .unwrap()
                .workspace_id,
            None
        );
        clear_meeting_binding_on(&conn, 7).unwrap();
        assert!(get_meeting_binding_on(&conn, 7).unwrap().is_none());

        assert!(set_meeting_binding_on(&conn, 404, Some(workspace.id)).is_err());
        assert!(set_meeting_binding_on(&conn, 7, Some(404)).is_err());
    }

    #[test]
    fn push_links_an_existing_manual_task_by_normalized_title() {
        let conn = workspace_conn();
        conn.execute(
            "INSERT INTO meetings (id, title) VALUES (7, 'Planning')",
            [],
        )
        .unwrap();
        let workspace = create_workspace_on(&conn, "Project", "blue").unwrap();
        set_meeting_binding_on(&conn, 7, Some(workspace.id)).unwrap();
        let manual =
            create_workspace_task_on(&conn, workspace.id, "Draft the memo", "", "", None, None)
                .unwrap();
        conn.execute(
            "INSERT INTO action_items (id, meeting_id, ord, text)
             VALUES (12, 7, 0, 'draft the memo ')",
            [],
        )
        .unwrap();

        assert_eq!(push_meeting_action_items_on(&conn, 7).unwrap(), 1);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM workspace_tasks", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let linked = get_workspace_task_on(&conn, manual.id).unwrap().unwrap();
        assert_eq!(linked.action_item_id, Some(12));
        assert!(linked.agent_eligible);
    }

    #[test]
    fn pushed_tasks_are_triaged_and_person_only_tasks_skip_autopilot() {
        let conn = workspace_conn();
        conn.execute("INSERT INTO meetings (id, title) VALUES (7, 'Launch')", [])
            .unwrap();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        set_meeting_binding_on(&conn, 7, Some(workspace.id)).unwrap();
        conn.execute_batch(
            "INSERT INTO action_items (id, meeting_id, ord, text)
                 VALUES (20, 7, 0, 'Record 90-second demo video this week.');
             INSERT INTO action_items (id, meeting_id, ord, text)
                 VALUES (21, 7, 1, 'Draft the launch memo');",
        )
        .unwrap();

        assert_eq!(push_meeting_action_items_on(&conn, 7).unwrap(), 2);
        let detail = get_workspace_on(&conn, workspace.id).unwrap().unwrap();
        let record = detail
            .tasks
            .iter()
            .find(|task| task.action_item_id == Some(20))
            .unwrap();
        let draft = detail
            .tasks
            .iter()
            .find(|task| task.action_item_id == Some(21))
            .unwrap();
        assert!(!record.agent_eligible);
        assert!(draft.agent_eligible);
        assert_eq!(
            next_queued_task_on(&conn, workspace.id)
                .unwrap()
                .unwrap()
                .id,
            draft.id
        );

        let summary = list_workspaces_on(&conn).unwrap();
        assert_eq!(summary[0].queued_task_count, 2);
        assert_eq!(summary[0].needs_you_count, 1);

        conn.execute(
            "UPDATE workspace_tasks SET updated_at = 'old' WHERE id = ?1",
            params![record.id],
        )
        .unwrap();
        let eligible = set_workspace_task_agent_eligible_on(&conn, record.id, true).unwrap();
        assert!(eligible.agent_eligible);
        assert_ne!(eligible.updated_at, "old");
        assert_eq!(list_workspaces_on(&conn).unwrap()[0].needs_you_count, 0);

        let manual =
            create_workspace_task_on(&conn, workspace.id, "Call the supplier", "", "", None, None)
                .unwrap();
        assert!(manual.agent_eligible);
    }

    #[test]
    fn sync_action_items_relinks_and_pushes_for_bound_meeting() {
        let conn = workspace_conn();
        conn.execute(
            "INSERT INTO meetings (id, title) VALUES (7, 'Planning')",
            [],
        )
        .unwrap();
        let workspace = create_workspace_on(&conn, "Project", "blue").unwrap();
        set_meeting_binding_on(&conn, 7, Some(workspace.id)).unwrap();
        let summary = "**Action Items**\n- Draft the memo\n- Send the recap";

        sync_action_items(&conn, 7, summary).unwrap();
        let first_ids: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT id FROM action_items WHERE meeting_id = 7 ORDER BY ord")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(first_ids.len(), 2);
        let first_task_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspace_tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(first_task_count, 2);

        sync_action_items(&conn, 7, summary).unwrap();
        let current_ids: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT id FROM action_items WHERE meeting_id = 7 ORDER BY ord")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_ne!(current_ids, first_ids);
        let task_ids: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT action_item_id FROM workspace_tasks ORDER BY title")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(task_ids.len(), 2);
        assert_eq!(
            task_ids
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>(),
            current_ids
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
        );
    }

    #[test]
    fn workspace_meeting_ids_unions_context_and_bindings() {
        let conn = workspace_conn();
        conn.execute_batch(
            "INSERT INTO meetings (id, title) VALUES (7, 'Seven');
             INSERT INTO meetings (id, title) VALUES (8, 'Eight');",
        )
        .unwrap();
        let first = create_workspace_on(&conn, "First", "blue").unwrap();
        let second = create_workspace_on(&conn, "Second", "blue").unwrap();
        add_workspace_context_on(&conn, first.id, "meeting", "7", "Seven").unwrap();
        add_workspace_context_on(&conn, first.id, "meeting", "invalid", "Invalid").unwrap();
        set_meeting_binding_on(&conn, 7, Some(first.id)).unwrap();
        set_meeting_binding_on(&conn, 8, Some(second.id)).unwrap();

        assert_eq!(
            workspace_meeting_ids_on(&conn).unwrap(),
            vec![(first.id, 7), (second.id, 8)]
        );
    }

    #[test]
    fn workspace_create_and_list_tracks_queued_tasks() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();

        let before = list_workspaces_on(&conn).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].workspace.id, workspace.id);
        assert_eq!(before[0].queued_task_count, 0);
        assert_eq!(before[0].meeting_count, 0);
        assert_eq!(before[0].folder_count, 0);

        create_workspace_task_on(&conn, workspace.id, "Draft plan", "", "", None, None).unwrap();
        let after = list_workspaces_on(&conn).unwrap();
        assert_eq!(after[0].queued_task_count, 1);
    }

    #[test]
    fn new_workspace_defaults_to_inheriting_notes_model() {
        let conn = workspace_conn();

        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();

        assert_eq!(workspace.model, "");
    }

    #[test]
    fn workspace_model_round_trips_through_loaded_workspace() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();

        set_workspace_model_on(&conn, workspace.id, "qwen3.6:27b").unwrap();

        let loaded = get_workspace_on(&conn, workspace.id).unwrap().unwrap();
        assert_eq!(loaded.workspace.model, "qwen3.6:27b");
    }

    #[test]
    fn workspace_project_fields_round_trip_and_new_schema_migration_is_idempotent() {
        let conn = workspace_conn();
        create_workspace_tables(&conn).unwrap();
        let workspace = create_workspace_on(&conn, "Launch", "purple").unwrap();

        set_workspace_instructions_on(&conn, workspace.id, "Keep decisions concise.").unwrap();
        set_workspace_network_allowed_on(&conn, workspace.id, true).unwrap();

        let listed = list_workspaces_on(&conn).unwrap();
        assert_eq!(listed[0].workspace.color, "purple");
        assert_eq!(listed[0].workspace.instructions, "Keep decisions concise.");
        assert!(listed[0].workspace.network_allowed);

        let loaded = get_workspace_on(&conn, workspace.id).unwrap().unwrap();
        assert_eq!(loaded.workspace.color, "purple");
        assert_eq!(loaded.workspace.instructions, "Keep decisions concise.");
        assert!(loaded.workspace.network_allowed);
    }

    #[test]
    fn project_overview_round_trip_persistence() {
        let conn = workspace_conn();
        create_workspace_tables(&conn).unwrap();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();

        // Initially empty
        let cached = get_project_overview_cache_on(&conn, workspace.id)
            .unwrap()
            .unwrap();
        assert_eq!(cached.0, "");
        assert_eq!(cached.1, "");
        assert_eq!(cached.2, "");

        upsert_project_overview_on(
            &conn,
            workspace.id,
            "Summary text",
            "abc123",
            "2026-08-20T12:00:00Z",
        )
        .unwrap();
        let cached = get_project_overview_cache_on(&conn, workspace.id)
            .unwrap()
            .unwrap();
        assert_eq!(cached.0, "Summary text");
        assert_eq!(cached.1, "abc123");
        assert_eq!(cached.2, "2026-08-20T12:00:00Z");

        // Update
        upsert_project_overview_on(
            &conn,
            workspace.id,
            "New summary",
            "def456",
            "2026-08-21T10:00:00Z",
        )
        .unwrap();
        let cached = get_project_overview_cache_on(&conn, workspace.id)
            .unwrap()
            .unwrap();
        assert_eq!(cached.0, "New summary");
        assert_eq!(cached.1, "def456");
    }

    #[test]
    fn project_overview_migration_idempotence() {
        let conn = workspace_conn();
        // Call twice – second must be no-op and preserve data
        create_workspace_tables(&conn).unwrap();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        upsert_project_overview_on(
            &conn,
            workspace.id,
            "Hello",
            "hash1",
            "2026-08-20T12:00:00Z",
        )
        .unwrap();

        // Re-run migrations via second create call
        create_workspace_tables(&conn).unwrap();
        let cached = get_project_overview_cache_on(&conn, workspace.id)
            .unwrap()
            .unwrap();
        assert_eq!(cached.0, "Hello");
        assert_eq!(cached.1, "hash1");

        // Also verify column_exists idempotence: columns already exist
        assert!(column_exists(&conn, "workspaces", "overview").unwrap());
        assert!(column_exists(&conn, "workspaces", "overview_source_hash").unwrap());
        assert!(column_exists(&conn, "workspaces", "overview_generated_at").unwrap());
    }

    #[test]
    fn workspace_task_source_adds_one_meeting_context_and_resolves_title() {
        let conn = workspace_conn();
        conn.execute(
            "INSERT INTO meetings (id, title) VALUES (7, 'Product review')",
            [],
        )
        .unwrap();
        let workspace = create_workspace_on(&conn, "Product", "blue").unwrap();

        let first = create_workspace_task_on(
            &conn,
            workspace.id,
            "Write follow-up",
            "",
            "",
            Some(7),
            None,
        )
        .unwrap();
        let second = create_workspace_task_on(
            &conn,
            workspace.id,
            "Share decisions",
            "",
            "",
            Some(7),
            None,
        )
        .unwrap();
        assert_eq!(first.source_meeting_title, "Product review");
        assert_eq!(second.source_meeting_title, "Product review");

        let detail = get_workspace_on(&conn, workspace.id).unwrap().unwrap();
        assert_eq!(detail.context_items.len(), 1);
        assert_eq!(detail.context_items[0].kind, "meeting");
        assert_eq!(detail.context_items[0].value, "7");
        assert_eq!(detail.tasks.len(), 2);
        assert!(detail
            .tasks
            .iter()
            .all(|task| task.source_meeting_title == "Product review"));
    }

    #[test]
    fn workspace_task_rejects_unknown_source_meeting() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Research", "blue").unwrap();
        let error =
            create_workspace_task_on(&conn, workspace.id, "Investigate", "", "", Some(404), None)
                .unwrap_err();
        assert!(error.to_string().contains("Meeting not found: 404"));
    }

    #[test]
    fn workspace_delete_removes_children_and_preserves_other_workspaces() {
        let conn = workspace_conn();
        let first = create_workspace_on(&conn, "First", "blue").unwrap();
        let second = create_workspace_on(&conn, "Second", "blue").unwrap();
        conn.execute_batch(
            "INSERT INTO meetings (id, title) VALUES (7, 'First meeting');
             INSERT INTO meetings (id, title) VALUES (8, 'Second meeting');",
        )
        .unwrap();
        set_meeting_binding_on(&conn, 7, Some(first.id)).unwrap();
        set_meeting_binding_on(&conn, 8, Some(second.id)).unwrap();
        add_workspace_context_on(&conn, first.id, "folder", "/first", "first").unwrap();
        add_workspace_context_on(&conn, second.id, "folder", "/second", "second").unwrap();
        create_workspace_task_on(&conn, first.id, "First task", "", "", None, None).unwrap();
        create_workspace_task_on(&conn, second.id, "Second task", "", "", None, None).unwrap();

        delete_workspace_on(&conn, first.id).unwrap();

        let first_tasks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workspace_tasks WHERE workspace_id = ?1",
                params![first.id],
                |row| row.get(0),
            )
            .unwrap();
        let first_context: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM workspace_context_items WHERE workspace_id = ?1",
                params![first.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first_tasks, 0);
        assert_eq!(first_context, 0);
        assert!(get_meeting_binding_on(&conn, 7).unwrap().is_none());
        assert!(get_workspace_on(&conn, first.id).unwrap().is_none());

        let remaining = get_workspace_on(&conn, second.id).unwrap().unwrap();
        assert_eq!(remaining.tasks.len(), 1);
        assert_eq!(remaining.context_items.len(), 1);
        assert_eq!(
            get_meeting_binding_on(&conn, 8)
                .unwrap()
                .unwrap()
                .workspace_id,
            Some(second.id)
        );
    }

    #[test]
    fn workspace_rename_changes_name_and_updated_at_and_rejects_unknown_id() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Old name", "blue").unwrap();
        conn.execute(
            "UPDATE workspaces SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?1",
            params![workspace.id],
        )
        .unwrap();

        rename_workspace_on(&conn, workspace.id, "New name").unwrap();
        let renamed = get_workspace_on(&conn, workspace.id).unwrap().unwrap();
        assert_eq!(renamed.workspace.name, "New name");
        assert_ne!(renamed.workspace.updated_at, "2000-01-01T00:00:00Z");

        let error = rename_workspace_on(&conn, 999, "Missing").unwrap_err();
        assert!(error.to_string().contains("Workspace not found: 999"));
    }

    #[test]
    fn get_workspace_returns_none_for_unknown_id() {
        let conn = workspace_conn();
        assert!(get_workspace_on(&conn, 123).unwrap().is_none());
    }

    #[test]
    fn workspace_run_lifecycle_updates_task_status() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task = create_workspace_task_on(&conn, workspace.id, "Draft memo", "", "", None, None)
            .unwrap();

        let run = create_workspace_run_on(&conn, workspace.id, task.id, "local").unwrap();
        assert_eq!(
            get_workspace_task_on(&conn, task.id)
                .unwrap()
                .unwrap()
                .status,
            "running"
        );
        finish_workspace_run_on(&conn, run.id, "done", "draft", "").unwrap();
        let finished = get_workspace_run_on(&conn, run.id).unwrap().unwrap();
        assert_eq!(finished.status, "done");
        assert!(!finished.finished_at.is_empty());
        assert_eq!(
            get_workspace_task_on(&conn, task.id)
                .unwrap()
                .unwrap()
                .status,
            "awaiting_review"
        );

        let stopped_run = create_workspace_run_on(&conn, workspace.id, task.id, "claude").unwrap();
        finish_workspace_run_on(&conn, stopped_run.id, "stopped", "", "").unwrap();
        assert_eq!(
            get_workspace_task_on(&conn, task.id)
                .unwrap()
                .unwrap()
                .status,
            "queued"
        );
    }

    #[test]
    fn workspace_run_report_round_trips_through_run_getters() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task = create_workspace_task_on(&conn, workspace.id, "Draft memo", "", "", None, None)
            .unwrap();
        let run = create_workspace_run_on(&conn, workspace.id, task.id, "local").unwrap();

        set_workspace_run_report_on(
            &conn,
            run.id,
            "Produced the launch memo and left pricing undecided.",
        )
        .unwrap();

        let loaded = get_workspace_run_on(&conn, run.id).unwrap().unwrap();
        assert_eq!(
            loaded.report,
            "Produced the launch memo and left pricing undecided."
        );
        let latest = get_latest_workspace_run_on(&conn, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(latest.report, loaded.report);
    }

    #[test]
    fn workspace_artifacts_are_newest_first_and_in_workspace_detail() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Research", "blue").unwrap();
        let task =
            create_workspace_task_on(&conn, workspace.id, "Compare notes", "", "", None, None)
                .unwrap();
        let run = create_workspace_run_on(&conn, workspace.id, task.id, "local").unwrap();

        let first =
            insert_workspace_artifact_on(&conn, workspace.id, run.id, "first.md", "/tmp/first.md")
                .unwrap();
        let second = insert_workspace_artifact_on(
            &conn,
            workspace.id,
            run.id,
            "second.md",
            "/tmp/second.md",
        )
        .unwrap();

        let artifacts = list_workspace_artifacts_on(&conn, workspace.id).unwrap();
        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[0].id, second.id);
        assert_eq!(artifacts[1].id, first.id);
        let detail = get_workspace_on(&conn, workspace.id).unwrap().unwrap();
        assert_eq!(detail.artifacts.len(), 2);
        assert_eq!(detail.artifacts[0].name, "second.md");
    }

    #[test]
    fn latest_workspace_run_uses_highest_run_id() {
        let conn = workspace_conn();
        let workspace = create_workspace_on(&conn, "Launch", "blue").unwrap();
        let task = create_workspace_task_on(&conn, workspace.id, "Draft memo", "", "", None, None)
            .unwrap();
        let first = create_workspace_run_on(&conn, workspace.id, task.id, "local").unwrap();
        finish_workspace_run_on(&conn, first.id, "failed", "", "failed").unwrap();
        let second = create_workspace_run_on(&conn, workspace.id, task.id, "codex").unwrap();

        let latest = get_latest_workspace_run_on(&conn, task.id)
            .unwrap()
            .unwrap();
        assert_eq!(latest.id, second.id);
        assert_eq!(latest.engine, "codex");
    }

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

#[cfg(test)]
mod context_index_storage_tests {
    use super::*;

    #[test]
    fn context_name_migration_recreates_and_rebuilds_legacy_fts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE context_docs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL CHECK(source IN ('vault','project')),
                path TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO context_docs
                (source, path, title, body, fingerprint, updated_at)
            VALUES ('vault', '/vault/legacy.md', 'Legacy note', 'Existing body', '1', 'now');
            CREATE VIRTUAL TABLE context_fts USING fts5(
                title, body, content='context_docs', content_rowid='id'
            );",
        )
        .unwrap();

        migrate_context_docs_name(&conn).unwrap();
        setup_context_fts(&conn).unwrap();

        assert!(column_exists(&conn, "context_docs", "name").unwrap());
        assert!(column_exists(&conn, "context_fts", "name").unwrap());
        assert_eq!(
            search_context_doc_ids_on(&conn, "Legacy", Some("vault"), 10).unwrap(),
            vec![1]
        );
    }

    fn context_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE context_docs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL CHECK(source IN ('vault','project')),
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE context_chunks (
                doc_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                embedding BLOB NOT NULL,
                dim INTEGER NOT NULL,
                model TEXT NOT NULL,
                PRIMARY KEY (doc_id, chunk_index)
            );",
        )
        .unwrap();
        setup_context_fts(&conn).unwrap();
        conn
    }

    #[test]
    fn context_storage_crud_vectors_counts_and_fts() {
        let conn = context_connection();
        let (vault_id, inserted) = upsert_context_doc_on(
            &conn,
            "vault",
            "/vault/wiki/projects/MIQ-Agentic.md",
            "MIQ Agentic",
            "M|Q Agentic Intelligence",
            "Agentic intelligence project and launch decisions",
            "1:50",
        )
        .unwrap();
        assert!(inserted);
        let (same_id, changed) = upsert_context_doc_on(
            &conn,
            "vault",
            "/vault/wiki/projects/MIQ-Agentic.md",
            "MIQ Agentic",
            "Ignored while unchanged",
            "Ignored while unchanged",
            "1:50",
        )
        .unwrap();
        assert_eq!(same_id, vault_id);
        assert!(!changed);

        let (_, changed) = upsert_context_doc_on(
            &conn,
            "vault",
            "/vault/wiki/projects/MIQ-Agentic.md",
            "MIQ Agentic",
            "M|Q Agentic Intelligence",
            "Agentic intelligence project with a revised launch plan",
            "2:58",
        )
        .unwrap();
        assert!(changed);
        let (project_id, _) = upsert_context_doc_on(
            &conn,
            "project",
            "/projects/lagharilabs-website",
            "lagharilabs-website",
            "lagharilabs-website",
            "Founder portfolio website",
            "1:0:25",
        )
        .unwrap();

        replace_context_chunks_on(
            &conn,
            vault_id,
            &[("MIQ semantic chunk".to_string(), vec![1.0, 0.5])],
            "bge-m3",
        )
        .unwrap();
        let chunks = get_context_chunks_for_model_on(&conn, "bge-m3").unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].doc_id, vault_id);
        assert_eq!(chunks[0].embedding, vec![1.0, 0.5]);
        assert!(context_doc_ids_needing_model_on(&conn, "bge-m3")
            .unwrap()
            .contains(&project_id));

        assert_eq!(
            search_context_doc_ids_on(&conn, "MIQ launch", Some("vault"), 10).unwrap(),
            vec![vault_id]
        );
        assert_eq!(
            search_context_doc_ids_on(&conn, "MIQ", Some("vault"), 10).unwrap(),
            vec![vault_id]
        );
        assert!(
            search_context_doc_ids_on(&conn, "website", Some("vault"), 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            search_context_doc_ids_on(&conn, "website", Some("project"), 10).unwrap(),
            vec![project_id]
        );

        let docs = get_context_docs_on(&conn, &[project_id, vault_id]).unwrap();
        assert_eq!(docs[0].title, "lagharilabs-website");
        assert_eq!(docs[1].title, "M|Q Agentic Intelligence");
        assert_eq!(context_index_counts_on(&conn).unwrap(), (1, 1));

        let deleted =
            delete_context_docs_not_in_on(&conn, "vault", &["/vault/another-note.md".to_string()])
                .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(context_index_counts_on(&conn).unwrap(), (0, 1));
        assert!(get_context_chunks_for_model_on(&conn, "bge-m3")
            .unwrap()
            .is_empty());
        assert!(search_context_doc_ids_on(&conn, "MIQ", None, 10)
            .unwrap()
            .is_empty());
    }
}
