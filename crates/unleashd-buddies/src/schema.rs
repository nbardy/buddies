//! The one schema (01-buddies-package.md §6). There are no versions and no migration chain: a
//! database is either empty (and gets this schema) or already carries `APPLICATION_ID`.
//!
//! Deviations from §6, each for a named reason:
//! - every imported table has `legacy TEXT` (JSON of the source columns with no new home; §7.1);
//! - `run.lease_expires_at` (claims need an expiry), no `run.allowed_ops` (02 §8.3: the grant's
//!   role picks the tools; imported op lists stay in `legacy.policy`);
//! - messages, channel posts and task comments are ONE kind of row: a post in a channel (owner
//!   decision 2026-09-25, T06b). A channel is `public` (name, purpose), `direct` (a member set,
//!   one channel per set: `member_key` is the sorted member keys joined by ',', and
//!   `channel_member` indexes it by member) or `task` (one per task). A reply is its own post
//!   (`reply_to_id`, same thread); a request carries `request` and, once answered, `answer_id`;
//! - `post.ord` is the post's ordered id: a time-ordered UUIDv7 from the crate's one monotonic
//!   generator (ids.rs). Threads, pages and read cursors order by it, never by `created_at` ties.
//!   A new post's id is `post_<ord>`; an imported post keeps its v33 id (runs, conversation links
//!   and client permalinks name it) and gets an `ord` issued at its source write time, in source
//!   order, so all history reads in true write order and every later post sorts after it;
//! - `post_read` covers every channel kind. `reader` is `'owner'` or a buddy id; the cursor is
//!   `last_ord` (with `last_post_id`/`last_post_at` for the record). Owner cursors replace
//!   owner-channel-reads.json, whose baseline imports as the ceiling id of baselineAt ("read
//!   through that instant", post id '');
//! - `schedule.name`, `schedule.created_at`;
//! - the optional 12th table `conversation` (§6): 976 conversation↔buddy bindings, 213 of them
//!   with no run, would otherwise be lost.

use crate::error::{CoreError, Result};
use rusqlite::Connection;

/// 'BUDD'. Marks a file as this schema; a v33 file (application_id 0) is refused.
pub const APPLICATION_ID: i64 = 0x4255_4444;

pub const DDL: &str = r#"
CREATE TABLE workspace (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  legacy TEXT) STRICT;

CREATE TABLE buddy (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
  slug TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','archived')),
  manager_id TEXT REFERENCES buddy(id),
  provider TEXT, model TEXT, reasoning_effort TEXT, soul_path TEXT,
  max_active_runs INTEGER NOT NULL DEFAULT 5 CHECK(max_active_runs > 0),
  created_at TEXT NOT NULL, legacy TEXT,
  UNIQUE(workspace_id, slug)) STRICT;

CREATE TABLE task (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
  owner_id TEXT NOT NULL REFERENCES buddy(id), parent_id TEXT REFERENCES task(id),
  title TEXT NOT NULL, done_criteria TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','in_progress','blocked','review','done','cancelled')),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), epoch INTEGER NOT NULL DEFAULT 1,
  next_action TEXT, blocked_reason TEXT, evidence TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, legacy TEXT,
  pin INTEGER NOT NULL DEFAULT 0 CHECK(pin >= 0)) STRICT;

CREATE TABLE channel (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL CHECK(kind IN ('public','direct','task')),
  name TEXT COLLATE NOCASE, purpose TEXT, member_key TEXT UNIQUE, task_id TEXT UNIQUE REFERENCES task(id),
  created_by TEXT REFERENCES buddy(id), created_at TEXT NOT NULL, archived_at TEXT,
  CHECK((kind = 'public') = (name IS NOT NULL AND purpose IS NOT NULL)),
  CHECK((kind = 'direct') = (member_key IS NOT NULL)),
  CHECK((kind = 'task') = (task_id IS NOT NULL)),
  UNIQUE(workspace_id, name)) STRICT;
CREATE TABLE channel_member (
  channel_id TEXT NOT NULL REFERENCES channel(id), member TEXT NOT NULL,
  PRIMARY KEY(channel_id, member)) STRICT, WITHOUT ROWID;

CREATE TABLE post (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channel(id),
  author_id TEXT REFERENCES buddy(id),
  root_id TEXT REFERENCES post(id), reply_to_id TEXT REFERENCES post(id),
  task_id TEXT REFERENCES task(id),
  purpose TEXT, body TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]',
  request TEXT CHECK(request IN ('awaiting','answered','cancelled','failed')),
  answer_id TEXT REFERENCES post(id),
  conversation_id TEXT, created_at TEXT NOT NULL, legacy TEXT,
  ord TEXT NOT NULL UNIQUE, broadcast INTEGER NOT NULL DEFAULT 0 CHECK(broadcast IN (0,1)),
  CHECK((request IS 'answered') = (answer_id IS NOT NULL))) STRICT;

CREATE TABLE post_read (
  reader TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES channel(id),
  last_post_id TEXT NOT NULL, last_post_at TEXT NOT NULL, last_ord TEXT NOT NULL,
  updated_at TEXT NOT NULL, legacy TEXT,
  PRIMARY KEY(reader, channel_id)) STRICT;

CREATE TABLE doc (
  id TEXT PRIMARY KEY, buddy_id TEXT NOT NULL REFERENCES buddy(id), workspace_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('buddy','workspace')), scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('soul','working','long_term','shared')), name TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL CHECK(revision > 0), content TEXT NOT NULL, updated_at TEXT NOT NULL, legacy TEXT,
  UNIQUE(buddy_id, scope_kind, scope_id, kind, name)) STRICT;
CREATE TABLE doc_revision (
  doc_id TEXT NOT NULL REFERENCES doc(id), revision INTEGER NOT NULL, content TEXT NOT NULL,
  reason TEXT NOT NULL, author TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT '{}',
  sha256 TEXT NOT NULL, created_at TEXT NOT NULL, legacy TEXT,
  PRIMARY KEY(doc_id, revision)) STRICT;

CREATE TABLE schedule (
  id TEXT PRIMARY KEY, buddy_id TEXT NOT NULL REFERENCES buddy(id), workspace_id TEXT NOT NULL,
  task_id TEXT REFERENCES task(id), name TEXT NOT NULL,
  cron TEXT NOT NULL, timezone TEXT NOT NULL, prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_run_at TEXT, archived_at TEXT,
  created_at TEXT NOT NULL, legacy TEXT, root_id TEXT REFERENCES post(id)) STRICT;

CREATE TABLE thread_read (
  reader TEXT NOT NULL, root_id TEXT NOT NULL REFERENCES post(id),
  last_ord TEXT NOT NULL, updated_at TEXT NOT NULL, conversation_id TEXT,
  PRIMARY KEY(reader, root_id)) STRICT, WITHOUT ROWID;

CREATE TABLE conversation (
  id TEXT PRIMARY KEY, buddy_id TEXT NOT NULL REFERENCES buddy(id), workspace_id TEXT NOT NULL,
  task_id TEXT, created_at TEXT NOT NULL, legacy TEXT) STRICT;

CREATE TABLE event (
  seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, workspace_id TEXT NOT NULL,
  buddy_id TEXT, task_id TEXT, op TEXT NOT NULL, payload TEXT NOT NULL,
  idem_key TEXT, payload_hash TEXT, result_ref TEXT, legacy TEXT,
  UNIQUE(actor, workspace_id, idem_key)) STRICT;
"#;

/// Full-text search over post bodies: an external-content FTS5 index kept in step by triggers.
/// Added after the T06b schema, so `open` creates it on a file that lacks it (and fills it once).
/// `porter unicode61` stems at index AND query time ("posts" = "post", "marketing" = "market"),
/// which is what lets a prefix term like `"market"*` find word forms; see `search.rs`. Files built
/// with the plain tokenizer (before 2026-10-05) are rebuilt by `ensure_post_search`.
/// `post_search_vocab` lists the index's terms; typo matching reads it.
const POST_SEARCH: &str = r#"
CREATE VIRTUAL TABLE post_search USING fts5(body, content='post', content_rowid='rowid', tokenize='porter unicode61');
CREATE VIRTUAL TABLE post_search_vocab USING fts5vocab(post_search, 'row');
CREATE TRIGGER post_search_insert AFTER INSERT ON post BEGIN
  INSERT INTO post_search(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER post_search_delete AFTER DELETE ON post BEGIN
  INSERT INTO post_search(post_search, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER post_search_update AFTER UPDATE OF body ON post BEGIN
  INSERT INTO post_search(post_search, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO post_search(rowid, body) VALUES (new.rowid, new.body);
END;
INSERT INTO post_search(post_search) VALUES ('rebuild');
"#;

/// Removes the derived search index so POST_SEARCH can recreate it (triggers first: they name it).
const DISCARD_POST_SEARCH: &str = "
DROP TRIGGER IF EXISTS post_search_insert;
DROP TRIGGER IF EXISTS post_search_delete;
DROP TRIGGER IF EXISTS post_search_update;
DROP TABLE IF EXISTS post_search_vocab;
DROP TABLE IF EXISTS post_search;";

// Pattern: one-definition (docs/patterns.md#one-definition)
/// EVERY index of the schema, created IF NOT EXISTS on every open of every file, fresh or old.
/// There is no other index list: `DDL` and `RUN_TABLE` declare tables only. Until 2026-10-06 the
/// base DDL and four on-open lists each carried some indexes (task_01a0ee7e-0f7b), and the
/// 2026-09-29 queue stall (888861c) was an index only the base DDL created: every file older than
/// it lacked `run_active_buddy` and every claim failed. Guard: `every_index_is_recreated_on_open`.
///
/// Why each non-obvious one exists:
/// - `post_reply_to`, `post_answer`, `thread_read_root`, `schedule_root`: SQLite plans the
///   foreign-key checks of every post insert against each table that references `post`, and
///   without these they are full scans (the query-plan guard caught `schedule_root`, 2026-10-06);
/// - `post_task`: the Task filter (T22); `task_live`: the directory's live-task counts (T22);
/// - `schedule_*`, `run_workspace_*`: the shared MCP list scopes (`query_plan.rs` checks each);
/// - `run_active_buddy`: the claim gate reads `FROM run INDEXED BY run_active_buddy`;
/// - `run_deliver`: who a post was delivered to, and the read fence (deliveries.rs);
/// - `thread_read_conversation`: a delivery composes every thread its conversation subscribes to.
pub const INDEXES: &str = "
CREATE INDEX IF NOT EXISTS buddy_manager ON buddy(manager_id) WHERE manager_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_owner ON task(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS task_workspace ON task(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS task_parent ON task(parent_id, position) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_live ON task(workspace_id, owner_id, status)
  WHERE parent_id IS NULL AND status IN ('open','in_progress','blocked','review');
CREATE INDEX IF NOT EXISTS channel_member_by_member ON channel_member(member, channel_id);
CREATE INDEX IF NOT EXISTS post_channel ON post(channel_id, ord);
CREATE INDEX IF NOT EXISTS post_root ON post(root_id, ord) WHERE root_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_awaiting ON post(channel_id, created_at) WHERE request = 'awaiting';
CREATE INDEX IF NOT EXISTS post_awaiting_author ON post(author_id, created_at) WHERE request = 'awaiting';
CREATE INDEX IF NOT EXISTS post_reply_to ON post(reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_answer ON post(answer_id) WHERE answer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS post_task ON post(task_id, ord) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS thread_read_root ON thread_read(root_id);
CREATE INDEX IF NOT EXISTS thread_read_conversation ON thread_read(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS schedule_due ON schedule(next_run_at) WHERE enabled = 1 AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS schedule_buddy ON schedule(buddy_id);
CREATE INDEX IF NOT EXISTS schedule_task ON schedule(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS schedule_workspace ON schedule(workspace_id);
CREATE INDEX IF NOT EXISTS schedule_root ON schedule(root_id);
CREATE UNIQUE INDEX IF NOT EXISTS run_live_input ON run(input_key) WHERE status IN ('queued','running','cancel_requested');
CREATE UNIQUE INDEX IF NOT EXISTS run_conversation_slot ON run(conversation_id)
  WHERE conversation_id IS NOT NULL AND status IN ('running','cancel_requested');
CREATE INDEX IF NOT EXISTS run_queue ON run(ready_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS run_lease ON run(lease_expires_at) WHERE status IN ('running','cancel_requested');
CREATE INDEX IF NOT EXISTS run_active_buddy ON run(buddy_id) WHERE status IN ('running','cancel_requested');
CREATE INDEX IF NOT EXISTS run_buddy ON run(buddy_id, status, created_at);
CREATE INDEX IF NOT EXISTS run_conversation ON run(conversation_id, created_at) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_task ON run(task_id, status) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_workspace_live ON run(workspace_id, status, created_at)
  WHERE status IN ('queued','running','cancel_requested');
CREATE INDEX IF NOT EXISTS run_workspace_ended ON run(workspace_id, ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_deliver ON run(input_id, buddy_id) WHERE input_kind = 'deliver';
CREATE INDEX IF NOT EXISTS conversation_buddy ON conversation(buddy_id, created_at);
CREATE INDEX IF NOT EXISTS event_at ON event(at);
CREATE INDEX IF NOT EXISTS event_buddy ON event(buddy_id, seq) WHERE buddy_id IS NOT NULL;";

// Pattern: durable-intake (docs/patterns.md#durable-intake)
/// The `run` table, named `{table}` so the one rebuild (`rebuild_for_delivery`) creates `run_new`
/// from the SAME text a fresh file gets. Rebuilt 2026-10-06 (owner decisions H, H2, I, J; the
/// durable-pending W0a/W0b columns folded into the delivery design, ONE live migration):
/// - kinds: `chat`, `post`, `deliver`. The kinds folded into `deliver` (`reply`, `failure_notice`,
///   `follow`, `schedule`) stay readable as history but can never be queued again (the CHECK), so
///   no claim ever meets one;
/// - `body`: a queued chat run is the ONLY copy of the owner's text (8 owner chats were lost at a
///   restart on 2026-09-29), so the CHECK refuses one without it. Only while queued: past
///   `executing_at` the provider journal and transcript hold the prompt;
/// - `executing_at`: set just before the side-effecting spawn. NULL = nothing ran, so a run whose
///   holder died is requeued, never replayed or reported lost (runs.rs `expire_leases`);
/// - `through_ord`: a delivery's newest shown post, fixed by its first compose, so an adopted turn
///   that recomposes never marks read what arrived after (it replaced `thread_follow.delivered_through`);
/// - NO `lane`/`position` (decision H2): `conversation_id` is the queue key;
/// - `snapshot` is gone: no code wrote it since the v3 store. An imported value moves into `legacy`.
/// STRICT CHECKs cannot be ALTERed, hence a rebuild, not ADD COLUMN.
const RUN_TABLE: &str = r#"
CREATE TABLE {table} (
  id TEXT PRIMARY KEY, input_key TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  input_kind TEXT NOT NULL CHECK(input_kind IN ('chat','post','deliver','reply','failure_notice','follow','schedule')),
  input_id TEXT NOT NULL, buddy_id TEXT NOT NULL REFERENCES buddy(id), workspace_id TEXT NOT NULL,
  conversation_id TEXT, task_id TEXT, task_epoch INTEGER, after_run_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','complete','failed','cancelled')),
  lease_token TEXT, lease_expires_at TEXT, deadline TEXT,
  outcome TEXT, error_code TEXT, error TEXT,
  ready_at TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, legacy TEXT,
  config TEXT, body TEXT, executing_at TEXT, through_ord TEXT,
  CHECK(input_kind IN ('chat','post','deliver') OR status <> 'queued'),
  CHECK(input_kind <> 'chat' OR status <> 'queued' OR body IS NOT NULL),
  UNIQUE(input_key, attempt)) STRICT;
"#;

/// A file imported before ordered ids has no `post.ord`: it cannot be ordered correctly, so it is
/// refused with the fix (re-import), never opened half-working. No live file predates it (T15).
fn require_ordered_ids(conn: &Connection, path: &str) -> Result<()> {
    let has_ord: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('post') WHERE name = 'ord')", [], |r| r.get(0))?;
    match has_ord {
        true => Ok(()),
        false => Err(CoreError::WrongDatabase(format!("{path}: imported before ordered ids (no post.ord); re-import it"))),
    }
}

pub(crate) fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)", [table, column], |r| r.get(0))?)
}

/// Additive compatibility: add `table.column` (declared by `decl`) to a database created before it.
fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    if !has_column(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
}

fn drop_column(conn: &Connection, table: &str, column: &str) -> Result<()> {
    if has_column(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} DROP COLUMN {column};"))?;
    }
    Ok(())
}

/// Followed threads (THREADS_VIEW_2026-09-28.md): a `thread_read` row is both "the reader follows
/// this thread" and how far it has read. A database created before it gets the table plus a
/// one-time backfill: every thread the owner started or replied in, read through its newest post,
/// so history arrives caught up instead of as a wall of unread. `post.broadcast` marks a reply
/// also shown in its channel ("Also send to #channel"). Created in its pre-delivery shape; the
/// delivery rebuild adds `conversation_id`.
fn ensure_threads(conn: &Connection) -> Result<()> {
    ensure_column(conn, "post", "broadcast", "INTEGER NOT NULL DEFAULT 0 CHECK(broadcast IN (0,1))")?;
    let present: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'thread_read')", [], |r| r.get(0))?;
    if present {
        return Ok(());
    }
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE thread_read (
           reader TEXT NOT NULL, root_id TEXT NOT NULL REFERENCES post(id),
           last_ord TEXT NOT NULL, updated_at TEXT NOT NULL,
           PRIMARY KEY(reader, root_id)) STRICT, WITHOUT ROWID;
         INSERT INTO thread_read (reader, root_id, last_ord, updated_at)
           SELECT 'owner', t.root, (SELECT max(x.ord) FROM post x WHERE x.id = t.root OR x.root_id = t.root),
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           FROM (SELECT DISTINCT coalesce(p.root_id, p.id) AS root FROM post p WHERE p.author_id IS NULL) t;
         COMMIT;",
    )?;
    Ok(())
}

fn ensure_post_search(conn: &Connection) -> Result<()> {
    let sql: Option<String> = conn.query_row("SELECT (SELECT sql FROM sqlite_schema WHERE name = 'post_search')", [], |r| r.get(0))?;
    match sql {
        Some(sql) if sql.contains("porter") => Ok(()),
        // The index predates the stemming tokenizer. It is derived data (`post` is the source of
        // truth), so replace it in one transaction and let POST_SEARCH refill it: nothing is lost.
        Some(_) => Ok(conn.execute_batch(&format!(
            "BEGIN; {DISCARD_POST_SEARCH} {POST_SEARCH} COMMIT;"
        ))?),
        None => Ok(conn.execute_batch(&format!("BEGIN; {POST_SEARCH} COMMIT;"))?),
    }
}

fn configure(conn: &Connection) -> Result<()> {
    // checkpoint_fullfsync: macOS fsync() skips the drive cache, and a power cut mid-checkpoint
    // corrupted the attempt store on 2026-09-30. Only checkpoints pay for F_FULLFSYNC.
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA checkpoint_fullfsync = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")?;
    Ok(())
}

/// Open (or create) a buddies-core database. An existing file must carry `APPLICATION_ID`.
pub fn open(path: &str) -> Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    let app_id: i64 = conn.query_row("PRAGMA application_id", [], |r| r.get(0))?;
    let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_schema WHERE type = 'table'", [], |r| r.get(0))?;
    match (app_id == APPLICATION_ID, tables) {
        (true, _) => {
            require_ordered_ids(&conn, path)?;
            ensure_column(&conn, "channel", "archived_at", "TEXT")?;
            // Workspace-home pins (2026-09-30): additive, so an older build still opens the file.
            ensure_column(&conn, "task", "pin", "INTEGER NOT NULL DEFAULT 0 CHECK(pin >= 0)")?;
            // `run.retry_of` was stored but never set (a retry is the next `attempt` of its key);
            // dropped from files created before 2026-09-27. `buddy.background_enabled` held every
            // non-chat run queued while off; the owner removed it 2026-09-29. `run.config` (a
            // worker's own model) came 2026-09-28. The rebuild below copies the columns these
            // three steps leave, so they run first.
            drop_column(&conn, "run", "retry_of")?;
            drop_column(&conn, "buddy", "background_enabled")?;
            ensure_column(&conn, "run", "config", "TEXT")?;
            ensure_threads(&conn)?;
            crate::migrate::rebuild_for_delivery(&conn, path)?;
            conn.execute_batch(INDEXES)?;
            ensure_post_search(&conn)?;
            Ok(conn)
        }
        (false, 0) => {
            let run = RUN_TABLE.replace("{table}", "run");
            conn.execute_batch(&format!("BEGIN; {DDL} {run} {INDEXES} PRAGMA application_id = {APPLICATION_ID}; COMMIT;"))?;
            ensure_post_search(&conn)?;
            Ok(conn)
        }
        (false, n) => Err(CoreError::WrongDatabase(format!("{path}: {n} tables, application_id {app_id}"))),
    }
}

/// The run table's DDL under another name (the rebuild's `run_new`).
pub(crate) fn run_table(name: &str) -> String {
    RUN_TABLE.replace("{table}", name)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression guard for the 2026-09-29 queue stall (888861c): an index created only for a NEW
    // file is missing from every existing one. Drop every index, reopen, and demand each back.
    #[test]
    fn every_index_is_recreated_on_open() {
        let names: Vec<&str> = INDEXES
            .lines()
            .filter_map(|l| l.strip_prefix("CREATE INDEX IF NOT EXISTS ").or_else(|| l.strip_prefix("CREATE UNIQUE INDEX IF NOT EXISTS ")))
            .map(|rest| rest.split_whitespace().next().unwrap())
            .collect();
        assert!(names.contains(&"run_active_buddy") && names.contains(&"post_root"), "the parser found the indexes");
        assert!(!DDL.contains("CREATE INDEX") && !RUN_TABLE.contains("CREATE INDEX"), "INDEXES is the only index list");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        let path = path.to_str().unwrap();
        let conn = open(path).unwrap();
        for n in &names {
            conn.execute_batch(&format!("DROP INDEX {n};")).unwrap();
        }
        drop(conn);
        let conn = open(path).unwrap();
        let missing: Vec<&&str> = names
            .iter()
            .filter(|n| {
                !conn
                    .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?1)", [n], |r| {
                        r.get::<_, bool>(0)
                    })
                    .unwrap()
            })
            .collect();
        assert!(missing.is_empty(), "indexes not recreated on open: {missing:?}");
    }

    // A live file created before 2026-09-28 has no run.config; every run read names it.
    #[test]
    fn run_config_is_added_to_an_existing_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        let path = path.to_str().unwrap();
        open(path).unwrap().execute_batch("ALTER TABLE run DROP COLUMN config;").unwrap();
        let conn = open(path).unwrap();
        let present: bool =
            conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('run') WHERE name = 'config')", [], |r| r.get(0)).unwrap();
        assert!(present);
        open(path).unwrap();
    }

    // A file created before 2026-09-30 has no task.pin; every task read names it.
    #[test]
    fn task_pin_is_added_to_an_existing_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        let path = path.to_str().unwrap();
        open(path).unwrap().execute_batch("ALTER TABLE task DROP COLUMN pin;").unwrap();
        let conn = open(path).unwrap();
        let present: bool =
            conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('task') WHERE name = 'pin')", [], |r| r.get(0)).unwrap();
        assert!(present);
        open(path).unwrap();
    }

    // A file created before 2026-09-29 carries buddy.background_enabled (default 0), which held
    // every background run queued. Opening drops it and keeps the buddy rows.
    #[test]
    fn background_enabled_is_dropped_from_an_existing_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        let path = path.to_str().unwrap();
        open(path)
            .unwrap()
            .execute_batch(
                "ALTER TABLE buddy ADD COLUMN background_enabled INTEGER NOT NULL DEFAULT 0 CHECK(background_enabled IN (0,1));
                 INSERT INTO workspace (id, name, root_path, created_at) VALUES ('w', 'w', '/w', 'now');
                 INSERT INTO buddy (id, workspace_id, slug, name, role, status, created_at) VALUES ('b', 'w', 'b', 'B', 'r', 'active', 'now');",
            )
            .unwrap();
        let conn = open(path).unwrap();
        let (present, buddies): (bool, i64) = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('buddy') WHERE name = 'background_enabled'), (SELECT count(*) FROM buddy)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((present, buddies), (false, 1));
    }

    #[test]
    fn channel_archive_upgrades_existing_lean_database_without_losing_channels() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE channel(id TEXT PRIMARY KEY); INSERT INTO channel VALUES ('kept');").unwrap();
        ensure_column(&conn, "channel", "archived_at", "TEXT").unwrap();
        ensure_column(&conn, "channel", "archived_at", "TEXT").unwrap();
        let row: (String, Option<String>) = conn.query_row("SELECT id, archived_at FROM channel", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(row, ("kept".into(), None));
    }
}
