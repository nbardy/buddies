//! Pattern: one-write-path (docs/patterns.md#one-write-path) — `Writer::apply` is the only
//! write; every row a reader sees came through it.
//!
//! Pattern: store-descriptor-isolation (docs/patterns.md#store-descriptor-isolation)
//! Only this crate's connections may hold a descriptor on the file (or its -wal/-shm) in this
//! process. POSIX locks are per process, so ANY other in-process close() on the inode drops every
//! lock this connection holds: a second SQLite library (node:sqlite, 2026-09-25 parity harness)
//! or a plain byte read (the uploads GC worker thread, 2026-09-30). Losing the locks is silent;
//! the damage comes from the next opener in ANY process (sqlite3 CLI, a second backend), which
//! then thinks it is alone, resets the -shm this connection has mapped (SIGBUS) and on close
//! checkpoints and deletes the WAL (sqlite.org/howtocorrupt.html §2.2.1). Other processes are
//! safe only while these locks are held; still never point sqlite3 at a live store.
//! Guard: server/test/sqlite-locks.test.ts.
//!
//! The SQLite store. Written only by the ingest thread (one connection); read through a second
//! connection so a query never waits behind a long ingest transaction (WAL).
//!
//! Tables: `source` (one per file/directory: its stamp and resume checkpoint), `session` (one
//! list row per source that holds a session), `message` (the visible history, keyed by source
//! and seq) and `removed` (tombstones so `listSessions({ since })` can page deletions too).

use crate::model::{
    ContextReading, Cwd, Format, Identity, Message, Provider, Role, SessionRow, SubAgent, TimeFrom, ToolCall, Usage, UsageGroup,
    UsageGroupBy, UsageKey, UsageQuery, UsageReport,
};
use crate::read::{Apply, Checkpoint, Outcome, RowData, Stamp};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;
use std::path::Path;

/// 2: `usage_turn`, `session.context`, `session.rate_limits` (T13a).
pub const SCHEMA_VERSION: i64 = 2;
const PARTS_RECORD: &str = "__content_parts_v1__";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS source (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL,
  stamp TEXT NOT NULL,
  checkpoint BLOB
);
CREATE TABLE IF NOT EXISTS session (
  source_id INTEGER PRIMARY KEY REFERENCES source(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  format TEXT NOT NULL,
  source_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  observed_model TEXT,
  title TEXT,
  label TEXT NOT NULL,
  created_at REAL NOT NULL,
  activity_at REAL NOT NULL,
  time_from TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  parent_session_id TEXT,
  identity TEXT NOT NULL,
  listed INTEGER NOT NULL,
  swarm_debug_prefix TEXT,
  resumed_from TEXT,
  usage TEXT,
  sub_agents TEXT NOT NULL,
  rev INTEGER NOT NULL,
  context TEXT,
  rate_limits TEXT
);
CREATE INDEX IF NOT EXISTS session_by_rev ON session(rev);
CREATE INDEX IF NOT EXISTS session_by_id ON session(session_id, activity_at);
CREATE INDEX IF NOT EXISTS session_rate_limits ON session(activity_at) WHERE rate_limits IS NOT NULL;
CREATE TABLE IF NOT EXISTS message (
  source_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  at REAL,
  completed_at REAL,
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_input TEXT,
  PRIMARY KEY (source_id, seq)
) WITHOUT ROWID;
-- One provider-counted request per row (model.rs UsageTurn), numbered per source in file order.
CREATE TABLE IF NOT EXISTS usage_turn (
  source_id INTEGER NOT NULL,
  n INTEGER NOT NULL,
  at REAL,
  model TEXT,
  input REAL NOT NULL,
  output REAL NOT NULL,
  cache_read REAL NOT NULL,
  cache_write REAL NOT NULL,
  reported_cost REAL,
  PRIMARY KEY (source_id, n)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS usage_turn_by_at ON usage_turn(at);
CREATE TABLE IF NOT EXISTS removed (
  source_path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  rev INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS removed_by_rev ON removed(rev);
";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("corrupt row: {0}")]
    Corrupt(String),
    #[error("{0} is an ingest store of schema {1}; this build reads schema {SCHEMA_VERSION}")]
    Schema(String, i64),
}

pub type Result<T> = std::result::Result<T, StoreError>;

fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // The provider files are the source of truth; a lost last transaction is re-read on start.
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // macOS fsync() skips the drive cache; a power cut mid-checkpoint corrupted the attempt
    // store on 2026-09-30. F_FULLFSYNC on checkpoints only keeps commits cheap.
    conn.pragma_update(None, "checkpoint_fullfsync", "ON")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

/// The stored state of a source, without its (possibly large) checkpoint.
#[derive(Debug, Clone)]
pub struct Known {
    pub id: i64,
    pub format: Format,
    pub stamp: Stamp,
}

/// What one committed batch changed, for `onChange`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Committed {
    pub rev: i64,
    pub session_ids: Vec<String>,
    /// The subset of `session_ids` whose stored history was replaced or renumbered (`Apply::Replace`
    /// or `Withdraw`), not only appended: a reader holding earlier seqs of these must refetch from
    /// the start. Without it, the server could not tell an append from a Codex event-mode flip.
    pub rewritten: Vec<String>,
    pub removed: Vec<String>,
    pub messages_written: u64,
    /// Source path → row id, for every source this batch wrote.
    pub sources: Vec<(String, i64)>,
}

pub struct Writer {
    conn: Connection,
}

impl Writer {
    pub fn open(path: &Path) -> Result<Writer> {
        let conn = open(path)?;
        conn.execute_batch(SCHEMA)?;
        let version: Option<i64> = conn.query_row("SELECT value FROM meta WHERE key = 'schema'", [], |r| r.get(0)).optional()?;
        match version {
            None => {
                conn.execute("INSERT INTO meta (key, value) VALUES ('schema', ?1), ('rev', 0)", [SCHEMA_VERSION])?;
            }
            Some(SCHEMA_VERSION) => {}
            Some(other) => return Err(StoreError::Schema(path.display().to_string(), other)),
        }
        Ok(Writer { conn })
    }

    /// Every source's stamp. The one whole-table read, done once at start.
    pub fn known(&self) -> Result<HashMap<String, Known>> {
        let mut stmt = self.conn.prepare("SELECT id, path, format, stamp FROM source")?;
        let rows =
            stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
        let mut out = HashMap::new();
        for row in rows {
            let (id, path, format, stamp) = row?;
            let format = Format::parse(&format).ok_or_else(|| StoreError::Corrupt(format!("format {format}")))?;
            let stamp: Stamp = serde_json::from_str(&stamp).map_err(|e| StoreError::Corrupt(format!("stamp of {path}: {e}")))?;
            out.insert(path, Known { id, format, stamp });
        }
        Ok(out)
    }

    pub fn checkpoint(&self, id: i64) -> Result<Option<Checkpoint>> {
        let blob: Option<Vec<u8>> =
            self.conn.query_row("SELECT checkpoint FROM source WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten();
        // A checkpoint this build cannot decode (an older fold shape) is not an error: the source
        // is read from byte 0, as for an unseen file.
        Ok(blob.and_then(|b| serde_json::from_slice(&b).ok()))
    }

    /// Apply read outcomes and removals in one transaction under one new revision.
    pub fn apply(&mut self, outcomes: Vec<(String, Format, Outcome)>, removed_paths: &[String]) -> Result<Committed> {
        let tx = self.conn.transaction()?;
        let rev: i64 = tx.query_row("UPDATE meta SET value = value + 1 WHERE key = 'rev' RETURNING value", [], |r| r.get(0))?;
        let mut committed = Committed { rev, ..Default::default() };
        {
            let mut upsert_source = tx.prepare_cached(
                "INSERT INTO source (path, format, stamp, checkpoint) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(path) DO UPDATE SET format = excluded.format, stamp = excluded.stamp, checkpoint = excluded.checkpoint
                 RETURNING id",
            )?;
            let mut clear_messages = tx.prepare_cached("DELETE FROM message WHERE source_id = ?1")?;
            let mut clear_turns = tx.prepare_cached("DELETE FROM usage_turn WHERE source_id = ?1")?;
            let mut insert_turn = tx.prepare_cached(
                "INSERT OR REPLACE INTO usage_turn (source_id, n, at, model, input, output, cache_read, cache_write, reported_cost)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            let mut insert_message = tx.prepare_cached(
                "INSERT OR REPLACE INTO message (source_id, seq, role, at, completed_at, content, tool_name, tool_input) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            let mut old_row = tx.prepare_cached("SELECT session_id, listed FROM session WHERE source_id = ?1")?;
            let mut delete_row = tx.prepare_cached("DELETE FROM session WHERE source_id = ?1")?;
            let mut tombstone = tx.prepare_cached("INSERT OR REPLACE INTO removed (source_path, session_id, rev) VALUES (?1, ?2, ?3)")?;
            let mut untombstone = tx.prepare_cached("DELETE FROM removed WHERE source_path = ?1")?;
            let mut upsert_row = tx.prepare_cached(
                "INSERT OR REPLACE INTO session (source_id, session_id, provider, format, source_path, cwd, observed_model, title, label,
                   created_at, activity_at, time_from, message_count, parent_session_id, identity, listed, swarm_debug_prefix,
                   resumed_from, usage, sub_agents, rev, context, rate_limits)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)",
            )?;
            for (path, format, outcome) in outcomes {
                let checkpoint = outcome.checkpoint.as_ref().map(|c| serde_json::to_vec(c).expect("checkpoint serializes"));
                let stamp = serde_json::to_string(&outcome.stamp).expect("stamp serializes");
                let id: i64 = upsert_source.query_row(params![path, format.as_str(), stamp, checkpoint], |r| r.get(0))?;
                committed.sources.push((path.clone(), id));
                match &outcome.apply {
                    Apply::Append => {}
                    Apply::Replace => {
                        clear_messages.execute([id])?;
                        clear_turns.execute([id])?;
                    }
                    Apply::Withdraw(seqs) => withdraw(&tx, id, seqs)?,
                }
                for m in &outcome.messages {
                    let (tool_name, tool_input) = match (&m.parts_json, &m.tool_call) {
                        (Some(parts), _) => (Some(PARTS_RECORD), Some(parts.as_str())),
                        (None, Some(call)) => (Some(call.name.as_str()), call.input.as_deref()),
                        (None, None) => (None, None),
                    };
                    insert_message.execute(params![id, m.seq, m.role.as_str(), m.at, m.completed_at, m.content, tool_name, tool_input])?;
                }
                committed.messages_written += outcome.messages.len() as u64;
                for (i, t) in outcome.turns.iter().enumerate() {
                    let u = &t.usage;
                    let n = outcome.first_turn + i as u32;
                    insert_turn.execute(params![id, n, t.at, t.model, u.input, u.output, u.cache_read, u.cache_write, t.reported_cost])?;
                }
                let previous: Option<(String, bool)> = old_row.query_row([id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
                match (&outcome.row, previous) {
                    (None, None) => {}
                    (None, Some((session_id, listed))) => {
                        delete_row.execute([id])?;
                        if listed {
                            tombstone.execute(params![path, session_id, rev])?;
                            committed.removed.push(session_id);
                        }
                    }
                    (Some(row), previous) => {
                        let listed = !row.hidden && row.message_count > 0;
                        write_row(&mut upsert_row, id, &path, format, row, listed, rev)?;
                        if listed {
                            untombstone.execute([&path])?;
                            committed.session_ids.push(row.facts.session_id.clone());
                            if !matches!(outcome.apply, Apply::Append) {
                                committed.rewritten.push(row.facts.session_id.clone());
                            }
                        } else if let Some((old_id, true)) = previous {
                            tombstone.execute(params![path, old_id, rev])?;
                            committed.removed.push(old_id);
                        }
                    }
                }
            }
            let mut find = tx.prepare_cached("SELECT id FROM source WHERE path = ?1")?;
            let mut delete_source = tx.prepare_cached("DELETE FROM source WHERE id = ?1")?;
            for path in removed_paths {
                let Some(id): Option<i64> = find.query_row([path], |r| r.get(0)).optional()? else { continue };
                if let Some((session_id, listed)) =
                    old_row.query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))).optional()?
                    && listed
                {
                    tombstone.execute(params![path, session_id, rev])?;
                    committed.removed.push(session_id);
                }
                clear_messages.execute([id])?;
                clear_turns.execute([id])?;
                delete_row.execute([id])?;
                delete_source.execute([id])?;
            }
        }
        tx.commit()?;
        Ok(committed)
    }

    /// Record a source's new stamp when nothing it shows changed (a touch, a partial line).
    pub fn restamp(&self, path: &str, outcome: &Outcome) -> Result<()> {
        let checkpoint = outcome.checkpoint.as_ref().map(|c| serde_json::to_vec(c).expect("checkpoint serializes"));
        let stamp = serde_json::to_string(&outcome.stamp).expect("stamp serializes");
        self.conn.execute("UPDATE source SET stamp = ?2, checkpoint = ?3 WHERE path = ?1", params![path, stamp, checkpoint])?;
        Ok(())
    }

    pub fn rev(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT value FROM meta WHERE key = 'rev'", [], |r| r.get(0))?)
    }

    /// The stored context and rate limits of a source, for "did this read change anything?".
    pub fn extras_of(&self, path: &str) -> Result<(Option<ContextReading>, Option<String>)> {
        let mut stmt = self.conn.prepare_cached(EXTRAS_OF)?;
        let found: Option<(Option<String>, Option<String>)> = stmt.query_row([path], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let (context, limits) = found.unwrap_or((None, None));
        let context = context.map(|c| serde_json::from_str(&c)).transpose().map_err(corrupt("context"))?;
        Ok((context, limits))
    }

    /// The stored row of a source, for "did this read change what is shown?".
    pub fn row_of(&self, path: &str) -> Result<Option<SessionRow>> {
        let mut stmt = self.conn.prepare_cached(&format!("{ROW_SELECT} WHERE source_id = (SELECT id FROM source WHERE path = ?1)"))?;
        stmt.query_row([path], decode_row).optional()?.transpose()
    }
}

/// Delete stored messages `seqs` (ascending) of source `id` and renumber the later ones to close
/// the gaps, as `Sink::withdraw` did to this read's own messages. The rows between the i-th and
/// the next withdrawn seq move down by i + 1: one primary-key range update per gap, through
/// negative seqs so no update collides with a key still in use. (A correlated count per row took
/// 0.9 s for the 891 MB rollout's 2,076 withdrawn messages.)
fn withdraw(tx: &rusqlite::Transaction<'_>, id: i64, seqs: &[u32]) -> Result<()> {
    let mut delete = tx.prepare_cached(WITHDRAW_DELETE)?;
    let mut shift = tx.prepare_cached(WITHDRAW_SHIFT)?;
    for (i, &seq) in seqs.iter().enumerate() {
        delete.execute(params![id, seq])?;
        let next = seqs.get(i + 1).map_or(i64::MAX, |&n| n as i64);
        shift.execute(params![id, seq, next, i as i64 + 1])?;
    }
    tx.prepare_cached(WITHDRAW_SETTLE)?.execute([id])?;
    Ok(())
}

const WITHDRAW_DELETE: &str = "DELETE FROM message WHERE source_id = ?1 AND seq = ?2";
const WITHDRAW_SHIFT: &str = "UPDATE message SET seq = -1 - (seq - ?4) WHERE source_id = ?1 AND seq > ?2 AND seq < ?3";
const WITHDRAW_SETTLE: &str = "UPDATE message SET seq = -1 - seq WHERE source_id = ?1 AND seq < 0";

fn write_row(
    stmt: &mut rusqlite::CachedStatement<'_>,
    id: i64,
    path: &str,
    format: Format,
    row: &RowData,
    listed: bool,
    rev: i64,
) -> Result<()> {
    let f = &row.facts;
    stmt.execute(params![
        id,
        f.session_id,
        f.provider.as_str(),
        format.as_str(),
        path,
        serde_json::to_string(&f.cwd).expect("cwd serializes"),
        f.model,
        f.title,
        row.label,
        row.created_at,
        row.activity_at,
        row.time_from.as_str(),
        row.message_count,
        f.parent_session_id,
        serde_json::to_string(&row.identity).expect("identity serializes"),
        listed,
        row.swarm_debug_prefix,
        row.resumed_from,
        f.usage.as_ref().map(|u| serde_json::to_string(u).expect("usage serializes")),
        serde_json::to_string(&f.sub_agents).expect("sub-agents serialize"),
        rev,
        f.context.as_ref().map(|c| serde_json::to_string(c).expect("context serializes")),
        f.rate_limits,
    ])?;
    Ok(())
}

const EXTRAS_OF: &str = "SELECT context, rate_limits FROM session WHERE source_id = (SELECT id FROM source WHERE path = ?1)";

const ROW_SELECT: &str = "SELECT session_id, provider, format, source_path, cwd, observed_model, title, label, created_at, activity_at,
  time_from, message_count, parent_session_id, identity, swarm_debug_prefix, resumed_from, usage, sub_agents, rev FROM session";

fn corrupt<E: std::fmt::Display>(what: &str) -> impl Fn(E) -> StoreError + '_ {
    move |e| StoreError::Corrupt(format!("{what}: {e}"))
}

fn decode_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Result<SessionRow>> {
    let provider: String = r.get(1)?;
    let format: String = r.get(2)?;
    let cwd: String = r.get(4)?;
    let time_from: String = r.get(10)?;
    let identity: String = r.get(13)?;
    let usage: Option<String> = r.get(16)?;
    let sub_agents: String = r.get(17)?;
    let decoded = (|| -> Result<SessionRow> {
        Ok(SessionRow {
            session_id: r.get(0)?,
            provider: Provider::parse(&provider).ok_or_else(|| StoreError::Corrupt(format!("provider {provider}")))?,
            format: Format::parse(&format).ok_or_else(|| StoreError::Corrupt(format!("format {format}")))?,
            source_path: r.get(3)?,
            cwd: serde_json::from_str::<Cwd>(&cwd).map_err(corrupt("cwd"))?,
            observed_model: r.get(5)?,
            title: r.get(6)?,
            label: r.get(7)?,
            created_at: r.get(8)?,
            activity_at: r.get(9)?,
            time_from: TimeFrom::parse(&time_from).ok_or_else(|| StoreError::Corrupt(format!("time_from {time_from}")))?,
            message_count: r.get(11)?,
            parent_session_id: r.get(12)?,
            identity: serde_json::from_str::<Identity>(&identity).map_err(corrupt("identity"))?,
            swarm_debug_prefix: r.get(14)?,
            resumed_from_conversation_id: r.get(15)?,
            usage: usage.map(|u| serde_json::from_str::<Usage>(&u)).transpose().map_err(corrupt("usage"))?,
            sub_agents: serde_json::from_str::<Vec<SubAgent>>(&sub_agents).map_err(corrupt("sub_agents"))?,
            rev: r.get(18)?,
        })
    })();
    Ok(decoded)
}

/// A session that left the list (its file was deleted, or it became hidden or empty).
#[derive(Debug, Clone, PartialEq)]
pub struct Removed {
    pub session_id: String,
    pub source_path: String,
    pub rev: i64,
}

pub struct Reader {
    conn: Connection,
}

impl Reader {
    pub fn open(path: &Path) -> Result<Reader> {
        let conn = open(path)?;
        conn.pragma_update(None, "query_only", "ON")?;
        Ok(Reader { conn })
    }

    pub fn rev(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT value FROM meta WHERE key = 'rev'", [], |r| r.get(0))?)
    }

    /// Listed rows changed after `since`, oldest change first, and removals after `since`.
    pub fn list_sessions(&self, since: i64) -> Result<(i64, Vec<SessionRow>, Vec<Removed>)> {
        // Read the revision and the rows in one snapshot so a concurrent ingest commit cannot
        // slip between them (its rows would be skipped by the next `since`).
        let tx = self.conn.unchecked_transaction()?;
        let rev: i64 = tx.query_row("SELECT value FROM meta WHERE key = 'rev'", [], |r| r.get(0))?;
        let rows = {
            let mut stmt = tx.prepare_cached(&format!("{ROW_SELECT} WHERE rev > ?1 AND listed = 1 ORDER BY rev"))?;
            stmt.query_map([since], decode_row)?.map(|r| r?).collect::<Result<Vec<_>>>()?
        };
        let removed = {
            let mut stmt = tx.prepare_cached("SELECT session_id, source_path, rev FROM removed WHERE rev > ?1 ORDER BY rev")?;
            stmt.query_map([since], |r| Ok(Removed { session_id: r.get(0)?, source_path: r.get(1)?, rev: r.get(2)? }))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok((rev, rows, removed))
    }

    /// The listed row for a native session id. Two files can hold the same id (a transcript
    /// copied between project directories); the most recently active one is the session.
    pub fn session(&self, session_id: &str) -> Result<Option<SessionRow>> {
        let mut stmt =
            self.conn.prepare_cached(&format!("{ROW_SELECT} WHERE session_id = ?1 AND listed = 1 ORDER BY activity_at DESC LIMIT 1"))?;
        stmt.query_row([session_id], decode_row).optional()?.transpose()
    }

    pub fn messages(&self, session_id: &str, after_seq: i64, limit: u32) -> Result<Vec<Message>> {
        let source: Option<i64> = self
            .conn
            .prepare_cached("SELECT source_id FROM session WHERE session_id = ?1 AND listed = 1 ORDER BY activity_at DESC LIMIT 1")?
            .query_row([session_id], |r| r.get(0))
            .optional()?;
        let Some(source) = source else { return Ok(Vec::new()) };
        let mut stmt = self.conn.prepare_cached(
            "SELECT seq, role, at, completed_at, content, tool_name, tool_input FROM message WHERE source_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![source, after_seq, limit], |r| {
            let role: String = r.get(1)?;
            let tool_name: Option<String> = r.get(5)?;
            Ok((r.get::<_, u32>(0)?, role, r.get(2)?, r.get(3)?, r.get::<_, String>(4)?, tool_name, r.get::<_, Option<String>>(6)?))
        })?;
        rows.map(|row| {
            let (seq, role, at, completed_at, content, tool_name, tool_input) = row?;
            Ok(Message {
                seq,
                role: Role::parse(&role).ok_or_else(|| StoreError::Corrupt(format!("role {role}")))?,
                at,
                completed_at,
                content,
                parts_json: (tool_name.as_deref() == Some(PARTS_RECORD)).then(|| tool_input.clone()).flatten(),
                tool_call: tool_name.filter(|name| name != PARTS_RECORD).map(|name| ToolCall { name, input: tool_input }),
            })
        })
        .collect()
    }

    /// Deep search (`/api/search`): the newest listed messages whose text contains `needle`, ASCII
    /// case-insensitively (SQLite `LIKE`). This is the one read that scans the message table, so
    /// it is not in `plans()`; `Ingest.search` opens a connection of its own for it,
    /// so a ~1 s scan never holds the reader that serves message pages.
    pub fn search(&self, needle: &str, limit: u32) -> Result<Vec<SearchHit>> {
        let escaped = needle.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let mut stmt = self.conn.prepare(SEARCH)?;
        let rows = stmt.query_map(params![format!("%{escaped}%"), limit], |r| {
            let role: String = r.get(2)?;
            let tool_name: Option<String> = r.get(6)?;
            Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?, role, r.get(3)?, r.get(4)?, r.get::<_, String>(5)?, tool_name, r.get::<_, Option<String>>(7)?))
        })?;
        rows.map(|row| {
            let (session_id, seq, role, at, completed_at, content, tool_name, tool_input) = row?;
            let role = Role::parse(&role).ok_or_else(|| StoreError::Corrupt(format!("role {role}")))?;
            Ok(SearchHit { session_id, message: Message { seq, role, at, completed_at, content, parts_json: (tool_name.as_deref() == Some(PARTS_RECORD)).then(|| tool_input.clone()).flatten(), tool_call: tool_name.filter(|name| name != PARTS_RECORD).map(|name| ToolCall { name, input: tool_input }) } })
        })
        .collect()
    }

    /// The latest request's context for a native session id: the most recently active source of
    /// that id that recorded one (listed or not: a context belongs to whatever file holds it).
    pub fn latest_context(&self, session_id: &str) -> Result<Option<ContextReading>> {
        let mut stmt = self.conn.prepare_cached(LATEST_CONTEXT)?;
        let found: Option<String> = stmt.query_row([session_id], |r| r.get(0)).optional()?;
        found.map(|c| serde_json::from_str(&c)).transpose().map_err(corrupt("context"))
    }

    /// Usage turns in `[since, until)` grouped as asked, plus the latest Codex rate limits.
    /// Pattern: one-write-path (docs/patterns.md#one-write-path) — derived from the turns the
    /// ingest writes; `/api/usage` and the context meter stop re-parsing transcripts.
    pub fn usage(&self, query: &UsageQuery) -> Result<UsageReport> {
        let tx = self.conn.unchecked_transaction()?;
        let until = query.until.unwrap_or(f64::MAX);
        let sql = match query.group_by {
            UsageGroupBy::Session => USAGE_BY_SESSION,
            UsageGroupBy::Day => USAGE_BY_DAY,
            UsageGroupBy::Model => USAGE_BY_MODEL,
        };
        let groups = {
            let mut stmt = tx.prepare_cached(sql)?;
            let rows = stmt.query_map(params![query.since, until], |r| {
                let key = (
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                );
                let totals = UsageGroup {
                    key: UsageKey::Day { day: String::new() },
                    turns: r.get(5)?,
                    sessions: r.get(6)?,
                    input: r.get(7)?,
                    output: r.get(8)?,
                    cache_read: r.get(9)?,
                    cache_write: r.get(10)?,
                    reported_cost_usd: r.get(11)?,
                    first_at: r.get(12)?,
                    last_at: r.get(13)?,
                };
                Ok((key, totals))
            })?;
            rows.map(|row| {
                let ((a, b, c, d, model), totals) = row?;
                let key = usage_key(query.group_by, a, b, c, d, model)?;
                Ok(UsageGroup { key, ..totals })
            })
            .collect::<Result<Vec<_>>>()?
        };
        let codex_rate_limits: Option<String> = tx.query_row(LATEST_RATE_LIMITS, [], |r| r.get(0)).optional()?;
        tx.commit()?;
        Ok(UsageReport { groups, codex_rate_limits })
    }

    /// `EXPLAIN QUERY PLAN` of every read this type runs; used by the query-plan guard.
    pub fn plans(&self) -> Result<Vec<(String, Vec<String>)>> {
        let queries = [
            format!("{ROW_SELECT} WHERE rev > 0 AND listed = 1 ORDER BY rev"),
            "SELECT session_id, source_path, rev FROM removed WHERE rev > 0 ORDER BY rev".to_string(),
            format!("{ROW_SELECT} WHERE session_id = 'x' AND listed = 1 ORDER BY activity_at DESC LIMIT 1"),
            "SELECT source_id FROM session WHERE session_id = 'x' AND listed = 1 ORDER BY activity_at DESC LIMIT 1".to_string(),
            "SELECT seq, role, at, completed_at, content, tool_name, tool_input FROM message WHERE source_id = 1 AND seq > -1 ORDER BY seq LIMIT 10".to_string(),
            format!("{ROW_SELECT} WHERE source_id = (SELECT id FROM source WHERE path = 'x')"),
            "SELECT checkpoint FROM source WHERE id = 1".to_string(),
            "SELECT id FROM source WHERE path = 'x'".to_string(),
            "SELECT session_id, listed FROM session WHERE source_id = 1".to_string(),
            "DELETE FROM message WHERE source_id = 1".to_string(),
            "SELECT value FROM meta WHERE key = 'rev'".to_string(),
            LATEST_CONTEXT.replace("?1", "'x'"),
            LATEST_RATE_LIMITS.to_string(),
            EXTRAS_OF.replace("?1", "'x'"),
            USAGE_BY_SESSION.replace("?1", "0").replace("?2", "1"),
            USAGE_BY_DAY.replace("?1", "0").replace("?2", "1"),
            USAGE_BY_MODEL.replace("?1", "0").replace("?2", "1"),
        ];
        explain(&self.conn, queries.into_iter())
    }
}

/// `EXPLAIN QUERY PLAN` of each query: (query, plan lines).
fn explain(conn: &Connection, queries: impl Iterator<Item = String>) -> Result<Vec<(String, Vec<String>)>> {
    queries
        .map(|q| {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {q}"))?;
            let details = stmt.query_map([], |r| r.get::<_, String>(3))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((q, details))
        })
        .collect()
}

impl Writer {
    /// `EXPLAIN QUERY PLAN` of the writer's statements that are not a primary-key lookup by
    /// construction; used by the query-plan guard.
    pub fn plans(&self) -> Result<Vec<(String, Vec<String>)>> {
        let queries = [
            WITHDRAW_SHIFT.replace("?1", "1").replace("?2", "0").replace("?3", "9").replace("?4", "1"),
            WITHDRAW_SETTLE.replace("?1", "1"),
        ];
        explain(&self.conn, queries.into_iter())
    }
}

const SEARCH: &str = "SELECT s.session_id, m.seq, m.role, m.at, m.completed_at, m.content, m.tool_name, m.tool_input
  FROM message m JOIN session s ON s.source_id = m.source_id AND s.listed = 1
  WHERE m.content LIKE ?1 ESCAPE '\\' ORDER BY m.at DESC LIMIT ?2";

/// One deep-search match: the session it belongs to and the message.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub session_id: String,
    pub message: Message,
}

const LATEST_CONTEXT: &str = "SELECT context FROM session WHERE session_id = ?1 AND context IS NOT NULL ORDER BY activity_at DESC LIMIT 1";
const LATEST_RATE_LIMITS: &str = "SELECT rate_limits FROM session WHERE rate_limits IS NOT NULL ORDER BY activity_at DESC LIMIT 1";

/// The totals every grouping selects, after its five key columns.
macro_rules! usage_totals {
    () => {
        "count(*), count(DISTINCT t.source_id), sum(t.input), sum(t.output), sum(t.cache_read), sum(t.cache_write),
         coalesce(sum(t.reported_cost), 0), min(t.at), max(t.at)
         FROM usage_turn t JOIN session s ON s.source_id = t.source_id
         WHERE t.at >= ?1 AND t.at < ?2"
    };
}

const USAGE_BY_SESSION: &str = concat!(
    "SELECT s.session_id, s.source_path, s.provider, s.format,
       (SELECT u.model FROM usage_turn u WHERE u.source_id = t.source_id AND u.model IS NOT NULL ORDER BY u.n LIMIT 1), ",
    usage_totals!(),
    " GROUP BY t.source_id"
);
const USAGE_BY_DAY: &str =
    concat!("SELECT strftime('%Y-%m-%d', t.at / 1000, 'unixepoch') AS day, NULL, NULL, NULL, NULL, ", usage_totals!(), " GROUP BY day");
const USAGE_BY_MODEL: &str = concat!("SELECT NULL, NULL, s.provider, NULL, t.model, ", usage_totals!(), " GROUP BY s.provider, t.model");

fn usage_key(
    by: UsageGroupBy,
    a: Option<String>,
    b: Option<String>,
    provider: Option<String>,
    format: Option<String>,
    model: Option<String>,
) -> Result<UsageKey> {
    let provider = || {
        let p = provider.clone().unwrap_or_default();
        Provider::parse(&p).ok_or_else(|| StoreError::Corrupt(format!("provider {p}")))
    };
    Ok(match by {
        UsageGroupBy::Session => {
            let f = format.clone().unwrap_or_default();
            UsageKey::Session {
                session_id: a.unwrap_or_default(),
                source_path: b.unwrap_or_default(),
                provider: provider()?,
                format: Format::parse(&f).ok_or_else(|| StoreError::Corrupt(format!("format {f}")))?,
                model,
            }
        }
        UsageGroupBy::Day => UsageKey::Day { day: a.unwrap_or_default() },
        UsageGroupBy::Model => UsageKey::Model { provider: provider()?, model },
    })
}
