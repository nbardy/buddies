//! Pattern: one-write-path (docs/patterns.md#one-write-path) — `put` is the only statement that
//! writes a record row, and it rebuilds the record's session index rows in the same transaction.
//! Create and every mutation go through it.
//!
//! Pattern: one-store-one-index (docs/patterns.md#one-store-one-index) — `conversation_record`
//! holds the records; `conversation_session` is the one derived index (provider, session id) →
//! conversation. It replaces the 8,822-file `by-session/` directory and the in-memory
//! `SessionIdentityIndex` of config-store.ts, whose "unindexed / building / indexed" states and
//! lazy repair existed only because the file index could be stale. Here it cannot: it is written
//! in the record's own transaction.
//!
//! Hazard (same as the ingest store): only this crate may open the file in the server process.
//! A second SQLite library (node:sqlite) in one process breaks POSIX locking and killed the T12
//! parity run with SIGBUS. Use this API, or the sqlite3 CLI from another process.
//!
//! Mutations run read-modify-write inside one `BEGIN IMMEDIATE` transaction, so two writers (two
//! connections, two processes) serialize on SQLite's write lock and the second one re-reads what
//! the first committed. That is what makes `set_config`'s compare-and-set exact without the
//! per-conversation promise locks config-store.ts kept in memory (which only covered one process).

use super::types::*;
use super::validate;
use crate::model::Provider;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::collections::HashMap;
use std::path::Path;

// 2 (T23b): `kind` is the stored `ConversationKind` JSON (T09's record v2), replacing the
// derived general/buddy/buddy_builder tag and its `buddy_id` column.
//
// 3 (step 6, durable owner messages): `conversation_input`, the pending owner messages of ordinary
// chats and the Builder (Buddy conversations carry theirs as crate `chat` runs). Additive, but an
// older build refuses a v3 file, so the open takes a pre-migration copy first (`backup_v2`).
pub const RECORDS_SCHEMA_VERSION: i64 = 3;

/// A claimed-but-unacknowledged first-message delivery is re-claimable after this long.
pub const INITIAL_MESSAGE_DISPATCH_LEASE_MS: i64 = 15_000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS conversation_record (
  conversation_id TEXT PRIMARY KEY NOT NULL CHECK (length(conversation_id) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  deleted_at TEXT,
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  kind TEXT NOT NULL CHECK (json_extract(kind, '$.t') IN ('chat', 'buddy', 'builder', 'worker')),
  provenance TEXT NOT NULL CHECK (provenance IN ('user', 'legacy_inferred', 'external_discovered')),
  working_directory TEXT,
  config TEXT NOT NULL,
  config_revision INTEGER NOT NULL CHECK (config_revision >= 0),
  record_revision INTEGER NOT NULL CHECK (record_revision >= 0),
  last_resolved TEXT,
  current_session TEXT,
  session_bindings TEXT NOT NULL,
  creation TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  import_defaults TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS conversation_session (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversation_record(conversation_id) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (provider, session_id, conversation_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS conversation_session_by_conversation ON conversation_session(conversation_id);
-- One row per owner message that was sent and has not finished its turn. `body` is opaque to this
-- crate (the server's QueuedMessage, provenance and both wordings); the row's identity, order and
-- `executing_at` are what the store decides. `position` is the queue order: push back = max + 1,
-- promote = min - 1.
CREATE TABLE IF NOT EXISTS conversation_input (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  conversation_id TEXT NOT NULL REFERENCES conversation_record(conversation_id) ON DELETE CASCADE ON UPDATE CASCADE,
  position INTEGER NOT NULL,
  body TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  executing_at TEXT,
  UNIQUE (conversation_id, position)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS conversation_record_reject (
  source_path TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  content BLOB NOT NULL
) WITHOUT ROWID;
";

#[derive(Debug, thiserror::Error)]
pub enum RecordsError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("corrupt row {0}: {1}")]
    Corrupt(String, String),
    #[error("invalid record {0}: {1:?}")]
    Invalid(String, Vec<String>),
    #[error("{0} holds conversation records of schema {1}; this build reads schema {RECORDS_SCHEMA_VERSION}")]
    Schema(String, i64),
}

impl RecordsError {
    /// The napi layer prefixes the JS error message with this, so callers branch on a code.
    pub fn code(&self) -> &'static str {
        match self {
            RecordsError::Sqlite(_) => "sqlite",
            RecordsError::Corrupt(..) => "corrupt",
            RecordsError::Invalid(..) => "invalid",
            RecordsError::Schema(..) => "schema",
        }
    }
}

pub type Result<T> = std::result::Result<T, RecordsError>;

/// What a mutation decided about the record it read.
pub enum Edit<T> {
    Keep(T),
    Write(ConversationRecord, T),
}

/// A mutation's result: no record, or the record as it now stands plus the mutation's verdict.
pub enum Found<T> {
    Missing,
    Found(ConversationRecord, T),
}

const COLUMNS: &str = "conversation_id, status, deleted_at, done, provenance, working_directory, config, config_revision,
  record_revision, last_resolved, current_session, session_bindings, creation, created_at, updated_at, kind";

pub struct Records {
    conn: Connection,
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("record types serialize")
}

fn decode_json<T: serde::de::DeserializeOwned>(id: &str, what: &str, s: &str) -> Result<T> {
    serde_json::from_str(s).map_err(|e| RecordsError::Corrupt(id.to_string(), format!("{what}: {e}")))
}

fn decode(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<ConversationRecord>> {
    let id: String = r.get(0)?;
    let status: String = r.get(1)?;
    let provenance: String = r.get(4)?;
    let config: String = r.get(6)?;
    let last_resolved: Option<String> = r.get(9)?;
    let current: Option<String> = r.get(10)?;
    let bindings: String = r.get(11)?;
    let creation: Option<String> = r.get(12)?;
    let kind: String = r.get(15)?;
    let (deleted_at, done, working_directory, config_revision, record_revision, created_at, updated_at) =
        (r.get(2)?, r.get(3)?, r.get(5)?, r.get(7)?, r.get(8)?, r.get(13)?, r.get(14)?);
    Ok((|| {
        Ok(ConversationRecord {
            status: RecordStatus::parse(&status).ok_or_else(|| RecordsError::Corrupt(id.clone(), format!("status {status}")))?,
            provenance: Provenance::parse(&provenance)
                .ok_or_else(|| RecordsError::Corrupt(id.clone(), format!("provenance {provenance}")))?,
            config: decode_json(&id, "config", &config)?,
            last_resolved_config: last_resolved.map(|s| decode_json(&id, "last_resolved", &s)).transpose()?,
            current_session: current.map(|s| decode_json(&id, "current_session", &s)).transpose()?,
            session_bindings: decode_json(&id, "session_bindings", &bindings)?,
            creation: creation.map(|s| decode_json(&id, "creation", &s)).transpose()?,
            kind: decode_json(&id, "kind", &kind)?,
            deleted_at,
            done,
            working_directory,
            config_revision,
            record_revision,
            created_at,
            updated_at,
            conversation_id: id,
        })
    })())
}

fn load(tx: &Connection, id: &str) -> Result<Option<ConversationRecord>> {
    let mut stmt = tx.prepare_cached(&format!("SELECT {COLUMNS} FROM conversation_record WHERE conversation_id = ?1"))?;
    stmt.query_row([id], decode).optional()?.transpose()
}

/// The one write. Validates against the Zod refinements, upserts the row, and rebuilds the
/// record's session index rows. `import_defaults` held the one-time importer's provenance; the
/// first write cleared it by design and the importer is gone (2026-09-27), so writes store NULL.
fn put(tx: &Transaction<'_>, record: &ConversationRecord) -> Result<()> {
    let issues = validate::record(record);
    if !issues.is_empty() {
        return Err(RecordsError::Invalid(record.conversation_id.clone(), issues));
    }
    tx.prepare_cached(
        "INSERT INTO conversation_record (conversation_id, status, deleted_at, done, kind, provenance, working_directory,
           config, config_revision, record_revision, last_resolved, current_session, session_bindings, creation, created_at,
           updated_at, import_defaults)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(conversation_id) DO UPDATE SET status = excluded.status, deleted_at = excluded.deleted_at,
           done = excluded.done, kind = excluded.kind, provenance = excluded.provenance,
           working_directory = excluded.working_directory, config = excluded.config,
           config_revision = excluded.config_revision, record_revision = excluded.record_revision,
           last_resolved = excluded.last_resolved, current_session = excluded.current_session,
           session_bindings = excluded.session_bindings, creation = excluded.creation, created_at = excluded.created_at,
           updated_at = excluded.updated_at, import_defaults = excluded.import_defaults",
    )?
    .execute(params![
        record.conversation_id,
        record.status.as_str(),
        record.deleted_at,
        record.done,
        json(&record.kind),
        record.provenance.as_str(),
        record.working_directory,
        json(&record.config),
        record.config_revision,
        record.record_revision,
        record.last_resolved_config.as_ref().map(json),
        record.current_session.as_ref().map(json),
        json(&record.session_bindings),
        record.creation.as_ref().map(json),
        record.created_at,
        record.updated_at,
        None::<String>,
    ])?;
    tx.prepare_cached("DELETE FROM conversation_session WHERE conversation_id = ?1")?.execute([&record.conversation_id])?;
    let mut index = tx.prepare_cached("INSERT INTO conversation_session (provider, session_id, conversation_id) VALUES (?1, ?2, ?3)")?;
    for binding in record.all_bindings() {
        index.execute(params![binding.provider.as_str(), binding.session_id, record.conversation_id])?;
    }
    Ok(())
}

pub(crate) fn open_connection(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    // Switching a NEW file to WAL needs its exclusive lock, and SQLite answers a concurrent
    // switch with SQLITE_BUSY without calling the busy handler (3 of 30 concurrent opens from
    // Node, T23b). Retry within the same 10 s budget.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match conn.pragma_update(None, "journal_mode", "WAL") {
            Ok(()) => break,
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::DatabaseBusy && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Err(e) => return Err(e.into()),
        }
    }
    // Records are authoritative (nothing re-derives them, unlike ingest's rows): a committed CAS
    // must survive power loss, so every commit syncs the WAL. Measured cost: see T23a report.
    conn.pragma_update(None, "synchronous", "FULL")?;
    // macOS fsync() skips the drive cache; a power cut mid-checkpoint corrupted the attempt
    // store on 2026-09-30. F_FULLFSYNC on checkpoints keeps the main file consistent.
    conn.pragma_update(None, "checkpoint_fullfsync", "ON")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // The v2 -> v3 step takes its copy BEFORE the first write, and outside any transaction
    // (the copy statement refuses one). Two processes can both see v2 and both copy; each copy is
    // consistent, so the race costs a file, not data.
    backup_v2(&conn, path)?;
    // Pattern: fix-guards (docs/patterns.md#fix-guards). Two connections opening a NEW file at
    // once (two server processes, two test stores) both saw no `records_schema` row and the
    // second INSERT failed (`UNIQUE constraint failed: meta.key`, 2 of 30 concurrent opens,
    // T23b). One IMMEDIATE transaction serializes the schema step on the write lock.
    // Guard: `two_connections_open_a_new_file_at_once` in tests/records.rs.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(SCHEMA)?;
    tx.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('records_schema', ?1)", [RECORDS_SCHEMA_VERSION])?;
    tx.execute("UPDATE meta SET value = ?1 WHERE key = 'records_schema' AND value = 2", [RECORDS_SCHEMA_VERSION])?;
    let version: i64 = tx.query_row("SELECT value FROM meta WHERE key = 'records_schema'", [], |r| r.get(0))?;
    tx.commit()?;
    match version {
        RECORDS_SCHEMA_VERSION => Ok(conn),
        other => Err(RecordsError::Schema(path.display().to_string(), other)),
    }
}

/// The pre-migration copy (owner rule, 2026-10-05: a migration without its way back never runs).
/// A v3 file is refused by a v2 build, so before the first v3 write a file still at v2 is copied
/// next to itself, named after the schema it holds and the time. The copy is one consistent file
/// that includes the WAL. A failed copy (a full disk) fails the open. A new or current file takes
/// no copy. Guard: `a_v2_file_is_copied_then_migrated_with_its_records_intact`.
fn backup_v2(conn: &Connection, path: &Path) -> Result<()> {
    let has_meta: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meta')", [], |r| r.get(0))?;
    if !has_meta {
        return Ok(());
    }
    let version: Option<i64> = conn.query_row("SELECT value FROM meta WHERE key = 'records_schema'", [], |r| r.get(0)).optional()?;
    if version != Some(2) {
        return Ok(());
    }
    let backup = format!("{}.before-input-v3.records-v2.{}.sqlite", path.display(), chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"));
    conn.execute("VACUUM INTO ?1", [&backup])?;
    eprintln!("[records] schema 2 -> 3: pre-migration copy at {backup}");
    Ok(())
}

impl Records {
    pub fn open(path: &Path) -> Result<Records> {
        Ok(Records { conn: open_connection(path)? })
    }

    pub fn get(&self, conversation_id: &str) -> Result<Option<ConversationRecord>> {
        load(&self.conn, conversation_id)
    }

    /// The record that binds this provider session. Two records can claim one session (a legacy
    /// copy of a transcript); the most recently updated wins, then the smaller id, so the
    /// answer is deterministic (config-store.ts answered with whichever file its scan met first).
    pub fn find_by_session(&self, provider: Provider, session_id: &str) -> Result<Option<ConversationRecord>> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT {} FROM conversation_session s JOIN conversation_record r ON r.conversation_id = s.conversation_id
             WHERE s.provider = ?1 AND s.session_id = ?2 ORDER BY r.updated_at DESC, r.conversation_id LIMIT 1",
            COLUMNS.split(',').map(|c| format!("r.{}", c.trim())).collect::<Vec<_>>().join(", ")
        ))?;
        stmt.query_row(params![provider.as_str(), session_id], decode).optional()?.transpose()
    }

    /// Every record as a list row. The one whole-table read (startup), two sequential scans.
    pub fn list_summaries(&self) -> Result<Vec<RecordSummary>> {
        let tx = self.conn.unchecked_transaction()?;
        let mut sessions: HashMap<String, Vec<SessionKey>> = HashMap::new();
        {
            let mut stmt = tx.prepare_cached(SUMMARY_SESSIONS)?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
            for row in rows {
                let (id, provider, session_id) = row?;
                let provider = parse_provider(&id, &provider)?;
                sessions.entry(id).or_default().push(SessionKey { provider, session_id });
            }
        }
        let mut stmt = tx.prepare_cached(SUMMARY_ROWS)?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, i64>(9)?,
                r.get::<_, String>(10)?,
                r.get::<_, String>(11)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                status,
                done,
                kind,
                provenance,
                working_directory,
                provider,
                cur_provider,
                cur_session,
                config_revision,
                created_at,
                updated_at,
            ) = row?;
            let kind = decode_json(&id, "kind", &kind)?;
            let current_session = match (cur_provider, cur_session) {
                (Some(p), Some(session_id)) => Some(SessionKey { provider: parse_provider(&id, &p)?, session_id }),
                (None, None) => None,
                _ => return Err(RecordsError::Corrupt(id, "current_session without provider or sessionId".into())),
            };
            out.push(RecordSummary {
                status: RecordStatus::parse(&status).ok_or_else(|| RecordsError::Corrupt(id.clone(), format!("status {status}")))?,
                provenance: Provenance::parse(&provenance)
                    .ok_or_else(|| RecordsError::Corrupt(id.clone(), format!("provenance {provenance}")))?,
                provider: parse_provider(&id, &provider)?,
                sessions: sessions.remove(&id).unwrap_or_default(),
                done,
                kind,
                working_directory,
                current_session,
                config_revision,
                created_at,
                updated_at,
                conversation_id: id,
            });
        }
        Ok(out)
    }

    /// Insert a new record at revision 0. An existing id is returned, never overwritten.
    pub fn create(&mut self, input: NewRecord, at: i64) -> Result<CreateOutcome> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(current) = load(&tx, &input.conversation_id)? {
            return Ok(CreateOutcome::Exists { current });
        }
        let now = validate::iso(at);
        let record = ConversationRecord {
            conversation_id: input.conversation_id,
            kind: input.kind,
            session_bindings: input.session_bindings,
            current_session: input.current_session,
            status: RecordStatus::Active,
            done: false,
            working_directory: input.working_directory,
            creation: input.creation,
            deleted_at: None,
            config: input.config,
            record_revision: 0,
            config_revision: 0,
            last_resolved_config: input.last_resolved_config,
            provenance: input.provenance,
            created_at: now.clone(),
            updated_at: now,
        };
        put(&tx, &record)?;
        tx.commit()?;
        Ok(CreateOutcome::Created { record })
    }

    /// Read, decide, write — one IMMEDIATE transaction. A write advances `recordRevision`.
    pub fn mutate<T>(&mut self, id: &str, f: impl FnOnce(&ConversationRecord) -> Edit<T>) -> Result<Found<T>> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(current) = load(&tx, id)? else { return Ok(Found::Missing) };
        let found = match f(&current) {
            Edit::Keep(verdict) => Found::Found(current, verdict),
            Edit::Write(mut next, verdict) => {
                next.record_revision = current.record_revision + 1;
                put(&tx, &next)?;
                Found::Found(next, verdict)
            }
        };
        tx.commit()?;
        Ok(found)
    }

    /// Compare-and-set on `configRevision` (the `set_config` command).
    pub fn set_config(&mut self, input: SetConfig, at: i64) -> Result<SetConfigOutcome> {
        let found = self.mutate(&input.conversation_id, |current| match (current.status, current.config_revision) {
            (RecordStatus::Deleted, _) => Edit::Keep(Verdict::Tombstoned),
            (RecordStatus::Active, rev) if rev != input.expected_config_revision => Edit::Keep(Verdict::Conflict),
            (RecordStatus::Active, rev) => Edit::Write(
                ConversationRecord {
                    config: input.config,
                    config_revision: rev + 1,
                    last_resolved_config: Some(input.last_resolved_config),
                    provenance: input.provenance.unwrap_or(Provenance::User),
                    updated_at: validate::iso(at),
                    ..current.clone()
                },
                Verdict::Committed,
            ),
        })?;
        Ok(match found {
            Found::Missing => SetConfigOutcome::Missing,
            Found::Found(record, Verdict::Committed) => SetConfigOutcome::Committed { record },
            Found::Found(current, Verdict::Conflict) => SetConfigOutcome::RevisionConflict { current },
            Found::Found(current, Verdict::Tombstoned) => SetConfigOutcome::Tombstoned { current },
        })
    }

    pub fn set_done(&mut self, id: &str, done: bool, at: i64) -> Result<Option<ConversationRecord>> {
        let found = self.mutate(id, |r| match r.done == done {
            true => Edit::Keep(()),
            false => Edit::Write(ConversationRecord { done, updated_at: validate::iso(at), ..r.clone() }, ()),
        })?;
        Ok(found.record())
    }

    /// Tombstone. False when missing or already deleted.
    pub fn mark_deleted(&mut self, id: &str, at: i64) -> Result<bool> {
        let found = self.mutate(id, |r| match r.status {
            RecordStatus::Deleted => Edit::Keep(false),
            RecordStatus::Active => {
                let now = validate::iso(at);
                Edit::Write(
                    ConversationRecord { status: RecordStatus::Deleted, deleted_at: Some(now.clone()), updated_at: now, ..r.clone() },
                    true,
                )
            }
        })?;
        Ok(matches!(found, Found::Found(_, true)))
    }

    /// Physically remove (rollback of a creation never exposed). The index rows cascade.
    pub fn purge(&mut self, id: &str) -> Result<bool> {
        Ok(self.conn.prepare_cached("DELETE FROM conversation_record WHERE conversation_id = ?1")?.execute([id])? > 0)
    }

    /// Make `binding` the session a new turn resumes; the previous current joins the history.
    pub fn set_current_session(&mut self, id: &str, binding: SessionBinding, at: i64) -> Result<Option<ConversationRecord>> {
        let found = self.mutate(id, |r| {
            let unchanged = r.current_session.as_ref().is_some_and(|c| {
                c.same_session(&binding) && (binding.buddy_audience_key.is_none() || c.buddy_audience_key == binding.buddy_audience_key)
            });
            if unchanged {
                return Edit::Keep(());
            }
            let history = r.all_bindings().into_iter().filter(|b| !b.same_session(&binding)).cloned().collect();
            // Re-binding the SAME session (an audience-key change) keeps its measured usage; a new
            // session starts a fresh provider context and therefore a fresh count.
            let current = match &r.current_session {
                Some(c) if c.session_id == binding.session_id => {
                    SessionBinding { latest_usage: c.latest_usage.clone().or(binding.latest_usage.clone()), ..binding.clone() }
                }
                _ => binding.clone(),
            };
            Edit::Write(
                ConversationRecord {
                    session_bindings: history,
                    current_session: Some(current),
                    updated_at: validate::iso(at),
                    ..r.clone()
                },
                (),
            )
        })?;
        Ok(found.record())
    }

    /// Attach usage to the CURRENT session. A late write for a session that has moved on is
    /// dropped on purpose: usage belongs to the session that produced it.
    pub fn set_current_session_usage(
        &mut self,
        id: &str,
        session_id: &str,
        usage: ProviderTurnUsage,
        at: i64,
    ) -> Result<Option<ConversationRecord>> {
        let found = self.mutate(id, |r| match &r.current_session {
            Some(c) if c.session_id == session_id => Edit::Write(
                ConversationRecord {
                    current_session: Some(SessionBinding { latest_usage: Some(usage), ..c.clone() }),
                    updated_at: validate::iso(at),
                    ..r.clone()
                },
                (),
            ),
            _ => Edit::Keep(()),
        })?;
        Ok(found.record())
    }

    /// Remember an earlier session of this conversation (transcript discovery).
    pub fn add_session_binding(&mut self, id: &str, binding: SessionBinding, at: i64) -> Result<Option<ConversationRecord>> {
        let found = self.mutate(id, |r| {
            let is_current = r.current_session.as_ref().is_some_and(|c| c.same_session(&binding));
            let known = r.session_bindings.iter().any(|b| b.same_session(&binding));
            match is_current || known {
                true => Edit::Keep(()),
                false => {
                    let mut session_bindings = r.session_bindings.clone();
                    session_bindings.push(binding);
                    Edit::Write(ConversationRecord { session_bindings, updated_at: validate::iso(at), ..r.clone() }, ())
                }
            }
        })?;
        Ok(found.record())
    }

    /// Lease delivery of the creation message to `token`. Some = this caller holds the lease.
    pub fn claim_initial_message_dispatch(&mut self, id: &str, token: &str, at: i64) -> Result<Option<ConversationRecord>> {
        let found = self.mutate(id, |r| {
            let Some(creation) = pending_initial_message(r) else { return Edit::Keep(false) };
            let leased = creation
                .initial_message_dispatch_claimed_at
                .as_deref()
                .and_then(validate::parse_ms)
                .is_some_and(|claimed| at - claimed < INITIAL_MESSAGE_DISPATCH_LEASE_MS);
            match leased {
                true => Edit::Keep(false),
                false => {
                    let now = validate::iso(at);
                    let creation = ConversationCreation {
                        initial_message_dispatch_claimed_at: Some(now.clone()),
                        initial_message_dispatch_claim_token: Some(token.to_string()),
                        ..creation.clone()
                    };
                    Edit::Write(ConversationRecord { creation: Some(creation), updated_at: now, ..r.clone() }, true)
                }
            }
        })?;
        Ok(found.record_if(|claimed| claimed))
    }

    /// Acknowledge delivery by the lease holder. Some = acknowledged by this call.
    pub fn complete_initial_message_dispatch(&mut self, id: &str, token: &str, at: i64) -> Result<Option<ConversationRecord>> {
        let found = self.mutate(id, |r| {
            let holder = pending_initial_message(r).filter(|c| c.initial_message_dispatch_claim_token.as_deref() == Some(token));
            match holder {
                None => Edit::Keep(false),
                Some(creation) => {
                    let now = validate::iso(at);
                    let creation = ConversationCreation {
                        initial_message_dispatch_claimed_at: None,
                        initial_message_dispatch_claim_token: None,
                        initial_message_dispatched_at: Some(now.clone()),
                        ..creation.clone()
                    };
                    Edit::Write(ConversationRecord { creation: Some(creation), updated_at: now, ..r.clone() }, true)
                }
            }
        })?;
        Ok(found.record_if(|done| done))
    }

    // --- pending owner messages (ordinary chats and the Builder) --------------------------------
    //
    // Pattern: durable-intake (docs/patterns.md#durable-intake). The row is written when the owner
    // sends, before the send is acknowledged, so a message queued behind a running turn survives
    // any backend exit. `executing_at` is stamped just before the turn spawns (the August rule: an
    // executed input is never replayed): at boot a row without it goes back to the queue, one with
    // it is dropped by the server, because its turn was adopted from its journal or ended visibly.

    /// Queue a message at the back. false = the conversation is missing or deleted, or `id` exists.
    pub fn put_input(&mut self, conversation_id: &str, id: &str, body: &str, queued_at: &str) -> Result<bool> {
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO conversation_input (id, conversation_id, position, body, queued_at)
             SELECT ?1, ?2, coalesce((SELECT max(position) FROM conversation_input WHERE conversation_id = ?2), 0) + 1, ?3, ?4
             WHERE EXISTS (SELECT 1 FROM conversation_record WHERE conversation_id = ?2 AND status = 'active')",
            params![id, conversation_id, body, queued_at],
        )?;
        Ok(n == 1)
    }

    /// Move a not-yet-executing message first. false = unknown, or already executing.
    pub fn promote_input(&mut self, id: &str) -> Result<bool> {
        let n = self.conn.execute(
            "UPDATE conversation_input SET position = (SELECT min(position) FROM conversation_input i WHERE i.conversation_id = conversation_input.conversation_id) - 1
             WHERE id = ?1 AND executing_at IS NULL",
            [id],
        )?;
        Ok(n == 1)
    }

    /// The turn is about to spawn. A second call keeps the first stamp. false = unknown.
    pub fn mark_input_executing(&mut self, id: &str, at: &str) -> Result<bool> {
        let n = self.conn.execute("UPDATE conversation_input SET executing_at = coalesce(executing_at, ?2) WHERE id = ?1", params![id, at])?;
        Ok(n == 1)
    }

    /// Delete the row (the message finished, was cancelled, or its executed turn is accounted for).
    /// true exactly once per row.
    pub fn settle_input(&mut self, id: &str) -> Result<bool> {
        Ok(self.conn.execute("DELETE FROM conversation_input WHERE id = ?1", [id])? == 1)
    }

    /// One conversation's messages in queue order.
    pub fn list_inputs(&self, conversation_id: &str) -> Result<Vec<ConversationInput>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, conversation_id, body, queued_at, executing_at FROM conversation_input WHERE conversation_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map([conversation_id], |r| {
            Ok(ConversationInput { id: r.get(0)?, conversation_id: r.get(1)?, body: r.get(2)?, queued_at: r.get(3)?, executing_at: r.get(4)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every conversation that holds a message: what boot hydrates.
    pub fn conversations_with_inputs(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare_cached("SELECT DISTINCT conversation_id FROM conversation_input ORDER BY conversation_id")?;
        Ok(stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// `EXPLAIN QUERY PLAN` of every statement this module runs, except `list_summaries`' two
    /// deliberate whole-table scans; used by the query-plan guard.
    pub fn plans(&self) -> Result<Vec<(String, Vec<String>)>> {
        let queries = [
            format!("SELECT {COLUMNS} FROM conversation_record WHERE conversation_id = 'x'"),
            "SELECT r.conversation_id FROM conversation_session s JOIN conversation_record r ON r.conversation_id = s.conversation_id
             WHERE s.provider = 'claude' AND s.session_id = 'x' ORDER BY r.updated_at DESC, r.conversation_id LIMIT 1"
                .to_string(),
            "DELETE FROM conversation_session WHERE conversation_id = 'x'".to_string(),
            "DELETE FROM conversation_record WHERE conversation_id = 'x'".to_string(),
            "SELECT value FROM meta WHERE key = 'records_schema'".to_string(),
        ];
        queries
            .into_iter()
            .map(|q| {
                let mut stmt = self.conn.prepare(&format!("EXPLAIN QUERY PLAN {q}"))?;
                let details = stmt.query_map([], |r| r.get::<_, String>(3))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((q, details))
            })
            .collect()
    }
}

const SUMMARY_SESSIONS: &str = "SELECT conversation_id, provider, session_id FROM conversation_session";
const SUMMARY_ROWS: &str = "SELECT conversation_id, status, done, kind, provenance, working_directory,
  json_extract(config, '$.provider'), json_extract(current_session, '$.provider'), json_extract(current_session, '$.sessionId'),
  config_revision, created_at, updated_at FROM conversation_record";

fn parse_provider(id: &str, s: &str) -> Result<Provider> {
    Provider::parse(s).ok_or_else(|| RecordsError::Corrupt(id.to_string(), format!("provider {s}")))
}

/// The creation of a record whose first message is still undelivered.
fn pending_initial_message(r: &ConversationRecord) -> Option<&ConversationCreation> {
    match (r.status, r.creation.as_ref()) {
        (RecordStatus::Active, Some(c)) if c.initial_message.is_some() && c.initial_message_dispatched_at.is_none() => Some(c),
        _ => None,
    }
}

enum Verdict {
    Committed,
    Conflict,
    Tombstoned,
}

impl<T> Found<T> {
    fn record(self) -> Option<ConversationRecord> {
        match self {
            Found::Missing => None,
            Found::Found(record, _) => Some(record),
        }
    }

    fn record_if(self, keep: impl FnOnce(T) -> bool) -> Option<ConversationRecord> {
        match self {
            Found::Missing => None,
            Found::Found(record, verdict) => keep(verdict).then_some(record),
        }
    }
}
