//! One-time import of a v33/v34 `@nbardy/buddies` database into the new schema (01 §7.1).
//!
//! The source is opened read-only (`mode=ro`) and the target must be a NEW file. Every source
//! column without a home in the new schema is kept in the row's `legacy` JSON. Soul files are
//! hashed (baseline for the verifier) and never written. Any source value outside the mapped
//! domains aborts the import with a typed error before anything is written.
//!
//! Messages, channel posts and task comments all become posts in channels (T06b): a message goes
//! to the direct channel of {sender, recipient}, its inline reply becomes its own answer post, and
//! owner-channel-reads.json (read-only, optional) becomes the owner's `post_read` cursors.

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use unleashd_buddies::error::{CoreError, Result};
use unleashd_buddies::runs::next_run;
use unleashd_buddies::schema;
use unleashd_buddies::store::{now_iso, sha256_hex};

#[derive(Debug, Serialize)]
pub struct ImportReport {
    pub source: String,
    pub source_version: i64,
    pub target: String,
    pub imported_at: String,
    /// (mapping, source rows, target rows); the import fails unless every pair is equal.
    pub counts: Vec<(String, i64, i64)>,
    /// Audit rows for pure reads, dropped by design (events are mutations only).
    pub dropped_read_events: i64,
    pub non_home_memberships: Vec<Value>,
    /// Memory folds whose winner is not the legacy head (a thread/task/workspace copy was newer).
    pub memory_fold_winners: Vec<Value>,
    /// Memory copies not imported (they are archived by `export-notes`).
    pub folded_copies: i64,
    pub converted_schedules: Vec<Value>,
    /// Dangling references carried over from the source (`PRAGMA foreign_key_check`), reported, not repaired.
    pub foreign_key_violations: Vec<Value>,
    pub soul_files: Vec<SoulFile>,
    /// Messages whose v33 `root_message_id` (the delegation-chain root) is in another direct
    /// channel. It is kept in `legacy.root_message_id`; `root_id` is the thread in the channel.
    pub cross_channel_roots: i64,
    pub owner_reads: OwnerReads,
    pub direct_reads: DirectReads,
    /// Row counts of the v33 tables deleted by design (DESIGN.md "Deleted outright"). They are
    /// not imported; these rows stay only in the v33 backup.
    pub dropped_tables: Vec<DroppedTable>,
}

#[derive(Debug, Serialize)]
pub struct DroppedTable {
    pub table: String,
    pub rows: i64,
}

/// v33 tables with no home in the new schema (DESIGN.md "Deleted outright"). Counted, never read.
pub const DROPPED_TABLES: &[&str] = &[
    "sprints",
    "work_items",
    "buddy_skills",
    "buddy_delegations",
    "buddy_reviews",
    "buddy_approval_requests",
    "buddy_builder_creations",
    "buddy_access_grants",
    "buddy_mail_effects",
    "buddy_mail_inbound",
    "buddy_checkpoints",
];

/// Import choices. `mark_direct_read` is ON by default (owner decision, T11): v33 kept no read
/// state for messages, so without it every imported DM counts as unread for the owner and each
/// member — a flood of hundreds of stale unread posts on the first inbox after the swap.
#[derive(Debug, Clone, Copy)]
pub struct ImportOptions {
    pub mark_direct_read: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions { mark_direct_read: true }
    }
}

/// Whether imported direct channels were marked read through their newest post.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DirectReads {
    NotMarked,
    Marked { cursors: i64 },
}

/// The cursors `mark_direct_read` writes: for every direct channel, the owner and each member,
/// at the channel's newest post. The verifier recomputes the same set from the imported posts.
pub const DIRECT_READ_CURSORS: &str = "SELECT r.reader, c.id AS channel_id, last.id AS post_id, last.created_at AS post_at,
      last.ord AS post_ord
    FROM channel c
    JOIN (SELECT channel_id, member AS reader FROM channel_member UNION SELECT id, 'owner' FROM channel WHERE kind = 'direct') r
      ON r.channel_id = c.id
    JOIN post last ON last.id = (SELECT p.id FROM post p WHERE p.channel_id = c.id ORDER BY p.ord DESC LIMIT 1)
    WHERE c.kind = 'direct'";

/// A read cursor's ordered id: the post's own when it exists, else the ceiling id of its time
/// ("read through that instant": an owner baseline has post id '').
pub const CURSOR_ORD: &str = "coalesce((SELECT p.ord FROM post p WHERE p.id = {post}), ord_ceiling({at}))";

/// `sha256(text)`: hex digest, as `winner_chains` and the knowledge revisions need.
pub fn register_sha256(conn: &Connection) -> Result<()> {
    conn.create_scalar_function("sha256", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        Ok(sha256_hex(ctx.get::<String>(0)?.as_bytes()))
    })?;
    Ok(())
}

/// `ord_ceiling(time)`: the greatest ordered id of that millisecond (ids.rs).
pub fn register_ord_ceiling(conn: &Connection) -> Result<()> {
    conn.create_scalar_function("ord_ceiling", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        let ms = unleashd_buddies::ids::millis(&ctx.get::<String>(0)?).map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
        Ok(unleashd_buddies::ids::ceiling(ms).to_string())
    })?;
    Ok(())
}

/// Imported posts keep their v33 ids: runs, conversation links and client permalinks name them.
/// Each gets an ordered id issued at its SOURCE write time by the one generator, walking the
/// posts in (source time, import order), so the whole history reads in its true order and every
/// post written later sorts after it. v33 kept no cross-table sequence (an inline reply is only
/// `replied_at`), so the source time is the only order the history has; ties keep import order.
fn assign_post_ords(conn: &Connection) -> Result<()> {
    let posts: Vec<(i64, String)> = unleashd_buddies::store::collect(
        conn.prepare("SELECT rowid, created_at FROM post ORDER BY created_at, rowid")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?,
    )?;
    let mut update = conn.prepare("UPDATE post SET ord = ?2 WHERE rowid = ?1")?;
    for (rowid, at) in posts {
        update.execute(params![rowid, unleashd_buddies::ids::next_at(unleashd_buddies::ids::millis(&at)?).to_string()])?;
    }
    Ok(())
}

pub const DIRECT_READ_SOURCE: &str = "import:direct-read";

/// owner-channel-reads.json, as `server/src/buddies/owner-channel-reads.ts` writes it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OwnerMark {
    pub post_id: String,
    pub created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerReadFile {
    version: i64,
    baseline_at: String,
    marks: BTreeMap<String, OwnerMark>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum OwnerReads {
    /// No file: the owner has no cursors to import.
    Absent {
        path: String,
    },
    Loaded {
        path: String,
        sha256: String,
        baseline_at: String,
        marks: BTreeMap<String, OwnerMark>,
    },
}

pub fn load_owner_reads(path: &Path) -> Result<OwnerReads> {
    let shown = path.display().to_string();
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(OwnerReads::Absent { path: shown }),
        Err(e) => return Err(e.into()),
    };
    let file: OwnerReadFile = serde_json::from_slice(&bytes)?;
    match file.version {
        1 => Ok(OwnerReads::Loaded { path: shown, sha256: sha256_hex(&bytes), baseline_at: file.baseline_at, marks: file.marks }),
        v => Err(CoreError::WrongDatabase(format!("{shown}: owner read state version {v}, expected 1"))),
    }
}

impl OwnerReads {
    /// The owner's cursors as (channel, post id, instant): each mark, and for every other list the
    /// file's baseline, the floor the TS reader applies to a list the owner never opened. A
    /// baseline cursor has post id '' and means "read through that instant".
    pub fn cursors(&self, lists: &[String]) -> Vec<(String, String, String)> {
        match self {
            OwnerReads::Absent { .. } => vec![],
            OwnerReads::Loaded { baseline_at, marks, .. } => {
                let baseline = lists.iter().filter(|l| !marks.contains_key(*l)).map(|l| (l.clone(), String::new(), baseline_at.clone()));
                marks.iter().map(|(l, m)| (l.clone(), m.post_id.clone(), m.created_at.clone())).chain(baseline).collect()
            }
        }
    }
}

/// A message's direct channel: its {sender, recipient} set spelled as `types::member_key` spells
/// it (byte-sorted, deduplicated, ','-joined; a NULL recipient is the owner).
pub const DM_KEY: &str = "CASE WHEN from_buddy_id = coalesce(to_buddy_id, 'owner') THEN from_buddy_id
    ELSE min(from_buddy_id, coalesce(to_buddy_id, 'owner')) || ',' || max(from_buddy_id, coalesce(to_buddy_id, 'owner')) END";

/// Every direct channel's (member_key, member) rows.
const DM_MEMBERS: &str =
    "SELECT member_key, from_buddy_id AS member FROM msg UNION SELECT member_key, coalesce(to_buddy_id, 'owner') FROM msg";

/// Temp objects the mapping reads. `msg_thread` is each message's thread root inside its channel:
/// a message answering another (`in_reply_to_id`) joins the thread of its chain's top message; a
/// top message is threaded under its v33 root only when that root is in the same channel.
fn setup_sql() -> Vec<String> {
    vec![
        format!("CREATE TEMP VIEW msg AS SELECT *, {DM_KEY} AS member_key FROM old.buddy_messages"),
        "CREATE TEMP TABLE msg_thread AS
         WITH RECURSIVE chain(id, top) AS (
           SELECT id, id FROM old.buddy_messages WHERE in_reply_to_id IS NULL
           UNION ALL SELECT m.id, chain.top FROM old.buddy_messages m JOIN chain ON m.in_reply_to_id = chain.id)
         SELECT chain.id, CASE WHEN chain.id = chain.top THEN top.local ELSE coalesce(top.local, chain.top) END AS root_id
         FROM chain JOIN (SELECT a.id, CASE WHEN r.member_key = a.member_key AND a.root_message_id != a.id THEN a.root_message_id END AS local
                          FROM msg a LEFT JOIN msg r ON r.id = a.root_message_id) top ON top.id = chain.top"
            .into(),
        format!("CREATE TEMP TABLE mem_copy AS {}", memory_copies("old.")),
        format!("CREATE TEMP TABLE mem_chain AS {}", winner_chains("old.")),
        "CREATE TEMP TABLE owner_read (list_id TEXT NOT NULL, post_id TEXT NOT NULL, created_at TEXT NOT NULL)".into(),
    ]
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SoulFileState {
    NoPath,
    Missing { path: String },
    Present { path: String, sha256: String },
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct SoulFile {
    pub buddy_id: String,
    pub slug: String,
    #[serde(flatten)]
    pub state: SoulFileState,
}

pub(crate) fn uri(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('%', "%25").replace('?', "%3f").replace('#', "%23");
    format!("file:{raw}?mode=ro")
}

pub fn open_source(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(uri(path), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI)?;
    source_version(&conn, "")?;
    Ok(conn)
}

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// v34 added only buddy_lists.archived_at (legacy lists.js migrateLists, b672694); accepting it
// without mapping that column resurrects archived channels. Guard: v34_archive_and_builder_receipts_survive_import.
pub(crate) fn source_version(conn: &Connection, prefix: &str) -> Result<i64> {
    let version: i64 = conn.query_row(&format!("PRAGMA {prefix}user_version"), [], |r| r.get(0))?;
    if !matches!(version, 33 | 34) {
        return Err(CoreError::WrongDatabase(format!("source user_version {version}, expected 33 or 34")));
    }
    let columns = unleashd_buddies::store::collect(
        conn.prepare(&format!("PRAGMA {prefix}table_info(buddy_lists)"))?
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)))?,
    )?;
    let archive = columns.iter().find(|(name, _, _)| name == "archived_at");
    let expected = match version {
        33 => archive.is_none(),
        34 => archive.is_some_and(|(_, ty, required)| ty.eq_ignore_ascii_case("TEXT") && *required == 0),
        _ => unreachable!(),
    };
    if !expected {
        return Err(CoreError::WrongDatabase(format!("source v{version} has an unexpected buddy_lists.archived_at shape")));
    }
    Ok(version)
}

/// Every v33 copy of a Buddy's soul/working/long_term memory: the legacy head and each
/// `buddy_knowledge` copy of that kind in any scope. The lean store keeps ONE doc per (Buddy,
/// kind): for working/long_term the newest copy (`updated_at`; the head wins a tie) is the
/// `winner`, imported as `mem_<buddy>_<kind>`. The soul is the owner's: only the v33 head can win
/// it (it must keep matching SOUL.md), however new a thread/task/workspace soul copy is
/// (orchestrator decision, 2026-09-26: 4 of 5 live thread souls were newer than their heads and
/// would otherwise have replaced the Buddy's soul). Every non-winner is archived to agent_notes by
/// `export-notes` (notes.rs). Import, export and verify all read `winner` from this one query, so
/// the fold and the archive cannot drift. `db` is the schema prefix (`old.` inside the import's
/// ATTACH, `` on a directly opened v33 file).
pub fn memory_copies(db: &str) -> String {
    format!(
        "SELECT *, (rank = 1 AND (kind != 'soul' OR source = 'buddy_memory_heads')) AS winner FROM (
         SELECT *, row_number() OVER (PARTITION BY buddy_id, kind
           ORDER BY (kind = 'soul' AND source = 'buddy_memory_heads') DESC, updated_at DESC, source DESC, source_id) AS rank FROM (
           SELECT h.buddy_id, h.document_kind AS kind, 'buddy_memory_heads' AS source, h.revision_id AS source_id,
             'head:' || h.buddy_id || '/' || h.document_kind AS chain, 'buddy' AS scope_kind, h.buddy_id AS scope_id, r.revision,
             r.body AS content, h.updated_at
           FROM {db}buddy_memory_heads h JOIN {db}buddy_memory_revisions r ON r.id = h.revision_id
           UNION ALL
           SELECT buddy_id, kind, 'buddy_knowledge', id, id, scope_kind, scope_id, revision, content, updated_at
           FROM {db}buddy_knowledge WHERE kind IN ('soul','working','long_term')))"
    )
}

/// Each winner's own revision chain, renumbered 1..n in source order (5 knowledge chains on the
/// 2026-09-26 copy have gaps) so the imported doc's revision is its last and CAS works. The
/// source revision stays in `legacy`. `sha256` is the stored hash (memory) or NULL (knowledge).
pub fn winner_chains(db: &str) -> String {
    format!(
        "SELECT 'mem_' || w.buddy_id || '_' || w.kind AS doc_id,
           row_number() OVER (PARTITION BY w.buddy_id, w.kind ORDER BY x.revision) AS revision, x.revision AS source_revision,
           x.content, x.reason, x.author, x.provenance, coalesce(x.sha256, sha256(x.content)) AS sha256, x.stored_sha256, x.created_at,
           json_patch(x.legacy, json_object('source_revision', x.revision)) AS legacy
         FROM ({}) w JOIN (
           SELECT 'head:' || buddy_id || '/' || document_kind AS chain, revision, body AS content, reasoning AS reason, author_kind AS author,
             provenance_json AS provenance, sha256, sha256 AS stored_sha256, created_at,
             json_object('id', id, 'base_revision_id', base_revision_id, 'requested_by', requested_by) AS legacy
           FROM {db}buddy_memory_revisions
           UNION ALL
           SELECT document_id, revision, content, reason, author, provenance, NULL, NULL, created_at, json_object('document_id', document_id)
           FROM {db}buddy_knowledge_revisions) x ON x.chain = w.chain
         WHERE w.winner",
        memory_copies(db)
    )
}

pub const V33_SOUL_PATHS: &str =
    "SELECT b.id, b.slug, b.soul_path, w.root_path FROM buddies b JOIN projects w ON w.id = b.project_id ORDER BY b.slug";

/// Hashes each buddy's soul file. `soul_path` is absolute or relative to the home workspace root.
/// `sql` yields (buddy id, slug, soul_path, workspace root).
pub fn soul_files(conn: &Connection, sql: &str) -> Result<Vec<SoulFile>> {
    let rows: Vec<(String, String, Option<String>, String)> =
        unleashd_buddies::store::collect(conn.prepare(sql)?.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?)?;
    Ok(rows.into_iter().map(|(buddy_id, slug, soul_path, root)| SoulFile { buddy_id, slug, state: soul_state(soul_path, &root) }).collect())
}

pub fn soul_state(soul_path: Option<String>, root: &str) -> SoulFileState {
    match soul_path {
        None => SoulFileState::NoPath,
        Some(p) => {
            let path = Path::new(root).join(&p).to_string_lossy().into_owned();
            match std::fs::read(&path) {
                Ok(bytes) => SoulFileState::Present { sha256: sha256_hex(&bytes), path },
                Err(_) => SoulFileState::Missing { path },
            }
        }
    }
}

/// Source values the mapping does not cover. Each must match zero rows.
const DOMAIN_CHECKS: &[(&str, &str)] = &[
    ("buddies.status outside active|archived", "SELECT count(*) FROM old.buddies WHERE status NOT IN ('active','archived')"),
    ("buddy_relationships.kind = reports_to", "SELECT count(*) FROM old.buddy_relationships WHERE kind = 'reports_to'"),
    (
        "owned_projects.status unknown",
        "SELECT count(*) FROM old.owned_projects WHERE status NOT IN ('backlog','ready','in_progress','blocked','review','done','cancelled')",
    ),
    (
        "buddy_messages.status unknown",
        "SELECT count(*) FROM old.buddy_messages WHERE status NOT IN ('pending','active','replied','failed','cancelled')",
    ),
    (
        "buddy_runs.status claimed",
        "SELECT count(*) FROM old.buddy_runs WHERE status NOT IN ('queued','running','cancel_requested','complete','failed','cancelled')",
    ),
    (
        "buddy_runs.input_kind unknown",
        "SELECT count(*) FROM old.buddy_runs WHERE input_kind NOT IN ('chat','message_request','message_reply','failure_notice','schedule')",
    ),
    (
        "buddy_automation_runs.status claimed",
        "SELECT count(*) FROM old.buddy_automation_runs WHERE status NOT IN ('running','cancel_requested','complete','failed','cancelled')",
    ),
    (
        "buddy_automations.job_kind not prompt",
        "SELECT count(*) FROM old.buddy_automations WHERE job_kind != 'prompt' OR json_extract(job_payload, '$.prompt') IS NULL",
    ),
    (
        "buddy_knowledge.kind unknown",
        "SELECT count(*) FROM old.buddy_knowledge WHERE kind NOT IN ('soul','working','long_term','shared','note')",
    ),
    (
        "shared docs whose names clash once thread/task scope folds into the buddy",
        "SELECT count(*) FROM old.buddy_knowledge a JOIN old.buddy_knowledge b ON b.buddy_id = a.buddy_id AND b.name = a.name AND b.id > a.id
         WHERE a.kind = 'shared' AND b.kind = 'shared' AND a.scope_kind != 'workspace' AND b.scope_kind != 'workspace'",
    ),
    (
        "buddy_knowledge.scope_kind unknown",
        "SELECT count(*) FROM old.buddy_knowledge WHERE scope_kind NOT IN ('owner_thread','project','workspace')",
    ),
    ("conversation_links without an unleashd id", "SELECT count(*) FROM old.conversation_links WHERE unleashd_conversation_id IS NULL"),
    (
        "buddy_todos without a task",
        "SELECT count(*) FROM old.buddy_todos WHERE buddy_project_id NOT IN (SELECT id FROM old.owned_projects)",
    ),
    (
        "buddy_task_comments without a task",
        "SELECT count(*) FROM old.buddy_task_comments WHERE project_id NOT IN (SELECT id FROM old.owned_projects)",
    ),
    (
        "buddy_messages reply columns disagree with status",
        "SELECT count(*) FROM old.buddy_messages WHERE (status = 'replied') != (reply_body IS NOT NULL AND replied_at IS NOT NULL)
           OR (status != 'replied' AND reply_evidence != '[]')",
    ),
    (
        "buddy_messages in_reply_to in another channel or delegation root",
        "SELECT count(*) FROM msg a JOIN msg p ON p.id = a.in_reply_to_id WHERE p.member_key != a.member_key OR p.root_message_id != a.root_message_id",
    ),
    (
        "buddy_list_posts outside their list's workspace",
        "SELECT count(*) FROM old.buddy_list_posts p JOIN old.buddy_lists l ON l.id = p.list_id WHERE p.workspace_id != l.workspace_id",
    ),
    (
        "answer ids ('reply_' || message id) already taken",
        "SELECT count(*) FROM old.buddy_messages WHERE 'reply_' || id IN (SELECT id FROM old.buddy_messages
           UNION ALL SELECT id FROM old.buddy_list_posts UNION ALL SELECT id FROM old.buddy_task_comments)",
    ),
];

/// A pure read in the audit log: `<actor>.get_*`, `.list_*`, `.search_*`, `.recall`.
const IS_READ: &str =
    "(substr(operation, instr(operation, '.') + 1) GLOB 'get_*' OR substr(operation, instr(operation, '.') + 1) GLOB 'list_*'
    OR substr(operation, instr(operation, '.') + 1) GLOB 'search_*' OR substr(operation, instr(operation, '.') + 1) = 'recall')";

fn mapping_sql(source_version: i64) -> Vec<String> {
    vec![
        "INSERT INTO workspace SELECT id, name, root_path, created_at, json_object('slug', slug, 'updated_at', updated_at) FROM old.projects".into(),
        "INSERT INTO buddy (id, workspace_id, slug, name, role, status, manager_id, provider, model, reasoning_effort, soul_path,
           background_enabled, max_active_runs, created_at, legacy)
         SELECT b.id, b.project_id, b.slug, b.name, b.role, b.status,
           (SELECT r.from_buddy_id FROM old.buddy_relationships r WHERE r.kind = 'manager' AND r.to_buddy_id = b.id),
           b.provider, b.model, b.reasoning_effort, b.soul_path, m.background_enabled, m.max_active_runs, b.created_at,
           json_object('memory_path', b.memory_path, 'hire_quota', b.hire_quota, 'profile_revision', b.profile_revision,
             'employment_mode', b.employment_mode, 'updated_at', b.updated_at,
             'home_membership', json_object('assignment_role', m.assignment_role, 'read_all_work', m.read_all_work, 'dispatch', m.dispatch,
               'max_background_runs_per_hour', m.max_background_runs_per_hour, 'max_sends_per_hour', m.max_sends_per_hour,
               'max_pending_runs', m.max_pending_runs, 'background_paused_reason', m.background_paused_reason, 'created_at', m.created_at),
             'other_memberships', json((SELECT json_group_array(json_object('project_id', o.project_id, 'assignment_role', o.assignment_role,
               'read_all_work', o.read_all_work, 'dispatch', o.dispatch, 'background_enabled', o.background_enabled,
               'max_active_runs', o.max_active_runs, 'max_background_runs_per_hour', o.max_background_runs_per_hour,
               'max_sends_per_hour', o.max_sends_per_hour, 'max_pending_runs', o.max_pending_runs,
               'background_paused_reason', o.background_paused_reason, 'created_at', o.created_at))
               FROM old.buddy_projects o WHERE o.buddy_id = b.id AND o.project_id != b.project_id)),
             'relationships', json((SELECT json_group_array(json_object('id', r.id, 'from', r.from_buddy_id, 'to', r.to_buddy_id,
               'kind', r.kind, 'created_at', r.created_at)) FROM old.buddy_relationships r WHERE r.from_buddy_id = b.id OR r.to_buddy_id = b.id)))
         FROM old.buddies b JOIN old.buddy_projects m ON m.buddy_id = b.id AND m.project_id = b.project_id".into(),
        "INSERT INTO task (id, workspace_id, owner_id, parent_id, title, done_criteria, status, paused, epoch, next_action,
           blocked_reason, evidence, position, revision, created_at, updated_at, legacy)
         SELECT id, workspace_id, buddy_id, parent_project_id, title, definition_of_done,
           CASE status WHEN 'backlog' THEN 'open' WHEN 'ready' THEN 'open' ELSE status END,
           execution_state = 'paused', execution_epoch, next_action, blocked_reason, completion_evidence, 0, revision, created_at, updated_at,
           json_object('source', 'owned_projects', 'status', status, 'objective', objective, 'priority', priority,
             'source_path', source_path, 'external_key', external_key, 'sprint_id', sprint_id, 'completed_at', completed_at,
             'execution_state', execution_state, 'pending_owner_id', pending_owner_id, 'accepted_by', accepted_by, 'accepted_at', accepted_at)
         FROM old.owned_projects".into(),
        "INSERT INTO task (id, workspace_id, owner_id, parent_id, title, done_criteria, status, paused, epoch, next_action,
           blocked_reason, evidence, position, revision, created_at, updated_at, legacy)
         SELECT t.id, p.workspace_id, p.buddy_id, t.buddy_project_id, t.title, coalesce(t.definition_of_done, ''), t.status, 0, 1,
           t.next_action, t.blocked_reason, t.completion_evidence, t.position, 1, t.created_at, t.updated_at,
           json_object('source', 'buddy_todos', 'definition_of_done', t.definition_of_done, 'completed_at', t.completed_at)
         FROM old.buddy_todos t JOIN old.owned_projects p ON p.id = t.buddy_project_id".into(),
        // Channels: lists are public; each {sender, recipient} set of messages is one direct channel
        // (the owner is the member 'owner'); each task with comments gets its task channel.
        format!("INSERT INTO channel (id, workspace_id, kind, name, purpose, created_by, created_at, archived_at)
         SELECT id, workspace_id, 'public', name, purpose, created_by_buddy_id, created_at, {} FROM old.buddy_lists",
         if source_version == 34 { "archived_at" } else { "NULL" }),
        "INSERT INTO channel (id, workspace_id, kind, member_key, created_by, created_at)
         SELECT 'dm_' || substr(sha256(member_key), 1, 32), workspace_id, 'direct', member_key, from_buddy_id, created_at
         FROM (SELECT *, row_number() OVER (PARTITION BY member_key ORDER BY created_at, id) AS n FROM msg) WHERE n = 1".into(),
        format!("INSERT INTO channel_member SELECT c.id, m.member FROM ({DM_MEMBERS}) m JOIN channel c ON c.member_key = m.member_key"),
        "INSERT INTO channel (id, workspace_id, kind, task_id, created_by, created_at)
         SELECT 'tc_' || p.id, p.workspace_id, 'task', p.id, nullif(f.author, 'owner'), f.created_at FROM old.owned_projects p
         JOIN (SELECT project_id, author, created_at, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS n
               FROM old.buddy_task_comments) f ON f.project_id = p.id AND f.n = 1".into(),
        // A message is a post in its direct channel. Its v33 root_message_id is the delegation-chain
        // root, often in another channel, so it stays in legacy and `root_id` is the channel thread
        // (msg_thread). An inline reply becomes its own post, answering the request.
        "INSERT INTO post (id, channel_id, author_id, root_id, reply_to_id, task_id, purpose, body, evidence, request, answer_id,
           conversation_id, return_conversation_id, created_at, legacy, ord)
         SELECT m.id, c.id, m.from_buddy_id, t.root_id, m.in_reply_to_id, m.buddy_project_id, m.purpose, m.body, m.evidence,
           CASE WHEN m.status = 'replied' THEN 'answered' WHEN m.expects_reply = 0 THEN NULL
                WHEN m.status IN ('pending','active') THEN 'awaiting' ELSE m.status END,
           CASE WHEN m.status = 'replied' THEN 'reply_' || m.id END,
           m.child_conversation_id, json_extract(m.return_policy, '$.return_conversation_id'), m.created_at,
           json_object('source', 'buddy_messages', 'workspace_id', m.workspace_id, 'root_message_id', m.root_message_id,
             'status', m.status, 'expects_reply', m.expects_reply, 'outcome', m.outcome,
             'replied_by', m.replied_by, 'parent_conversation_id', m.parent_conversation_id, 'wait_until', m.wait_until,
             'wait_status', m.wait_status, 'updated_at', m.updated_at, 'notification_pending', m.notification_pending,
             'source_project_id', m.source_project_id, 'source_workspace_id', m.source_workspace_id, 'caused_by_run_id', m.caused_by_run_id,
             'not_before', m.not_before, 'after_run_id', m.after_run_id, 'continue_from_message_id', m.continue_from_message_id,
             'superseded_by_message_id', m.superseded_by_message_id, 'root_stopped_at', m.root_stopped_at, 'command_key', m.command_key,
             'payload_hash', m.payload_hash, 'return_policy', json(m.return_policy), 'visibility', m.visibility),
           'pending:' || m.id
         FROM msg m JOIN channel c ON c.member_key = m.member_key JOIN msg_thread t ON t.id = m.id".into(),
        "INSERT INTO post (id, channel_id, author_id, root_id, reply_to_id, task_id, body, evidence, created_at, legacy, ord)
         SELECT 'reply_' || m.id, c.id, m.to_buddy_id, coalesce(t.root_id, m.id), m.id, m.buddy_project_id, m.reply_body,
           m.reply_evidence, m.replied_at, json_object('source', 'buddy_messages.reply'), 'pending:reply_' || m.id
         FROM msg m JOIN channel c ON c.member_key = m.member_key JOIN msg_thread t ON t.id = m.id WHERE m.status = 'replied'".into(),
        "INSERT INTO post (id, channel_id, author_id, root_id, task_id, purpose, body, evidence, return_conversation_id, created_at, legacy,
           ord)
         SELECT id, list_id, from_buddy_id, thread_root_id, buddy_project_id, purpose, body, evidence, sender_conversation_id, created_at,
           json_object('source', 'buddy_list_posts', 'sender_conversation_id', sender_conversation_id, 'sender_run_id', sender_run_id),
           'pending:' || id
         FROM old.buddy_list_posts".into(),
        "INSERT INTO post (id, channel_id, author_id, task_id, body, evidence, created_at, legacy, ord)
         SELECT id, 'tc_' || project_id, nullif(author, 'owner'), project_id, body, evidence, created_at,
           json_object('source', 'buddy_task_comments'), 'pending:' || id
         FROM old.buddy_task_comments".into(),
        // Memory folds to one doc per (Buddy, kind): the newest copy wins with its own chain (MEMORY_COPIES).
        "INSERT INTO doc (id, buddy_id, workspace_id, scope_kind, scope_id, kind, name, revision, content, updated_at, legacy)
         SELECT 'mem_' || c.buddy_id || '_' || c.kind, c.buddy_id, b.project_id, 'buddy', c.buddy_id, c.kind, '',
           (SELECT w.revision FROM mem_chain w WHERE w.doc_id = 'mem_' || c.buddy_id || '_' || c.kind AND w.source_revision = c.revision),
           c.content, c.updated_at,
           json_object('source', c.source, 'source_id', c.source_id, 'scope_kind', c.scope_kind, 'scope_id', c.scope_id,
             'revision', c.revision)
         FROM mem_copy c JOIN old.buddies b ON b.id = c.buddy_id WHERE c.winner".into(),
        "INSERT INTO doc_revision SELECT doc_id, revision, content, reason, author, provenance, sha256, created_at, legacy FROM mem_chain".into(),
        // Shared docs: thread/task scope folds into the Buddy's own scope (DOMAIN_CHECKS rejects a name clash).
        // Notes are not imported: they leave as agent_notes/*.md files (`buddies-import export-notes`, notes.rs).
        "INSERT INTO doc (id, buddy_id, workspace_id, scope_kind, scope_id, kind, name, revision, content, updated_at, legacy)
         SELECT k.id, k.buddy_id, k.workspace_id, CASE k.scope_kind WHEN 'workspace' THEN 'workspace' ELSE 'buddy' END,
           CASE k.scope_kind WHEN 'workspace' THEN k.scope_id ELSE k.buddy_id END, k.kind, k.name, k.revision, k.content, k.updated_at,
           json_object('source', 'buddy_knowledge', 'scope_kind', k.scope_kind, 'scope_id', k.scope_id)
         FROM old.buddy_knowledge k WHERE k.kind = 'shared'".into(),
        "INSERT INTO doc_revision SELECT document_id, revision, content, reason, author, provenance, sha256(content), created_at, NULL
         FROM old.buddy_knowledge_revisions WHERE document_id IN (SELECT id FROM old.buddy_knowledge WHERE kind = 'shared')".into(),
        "INSERT INTO run (id, input_key, attempt, input_kind, input_id, buddy_id, workspace_id, conversation_id, task_id, task_epoch,
           after_run_id, retry_of, status, lease_token, lease_expires_at, deadline, snapshot, outcome, error_code, error,
           ready_at, created_at, started_at, ended_at, legacy)
         SELECT id, input_key, attempt,
           CASE input_kind WHEN 'message_request' THEN 'post' WHEN 'message_reply' THEN 'reply' ELSE input_kind END,
           input_id, buddy_id, workspace_id, conversation_id, project_id,
           (SELECT json_extract(e.value, '$.epoch') FROM json_each(project_epochs) e WHERE json_extract(e.value, '$.id') = project_id),
           after_run_id, retry_of_run_id, status, claim_token, claim_expires_at, deadline, execution_snapshot, outcome, error_code, error,
           ready_at, created_at, started_at, ended_at,
           json_object('source', 'buddy_runs', 'input_kind', input_kind, 'policy', json(policy), 'root_message_id', root_message_id,
             'project_epochs', json(project_epochs), 'acknowledged_at', acknowledged_at)
         FROM old.buddy_runs".into(),
        "INSERT INTO run (id, input_key, attempt, input_kind, input_id, buddy_id, workspace_id, conversation_id, task_id, status,
           lease_token, lease_expires_at, outcome, error, ready_at, created_at, started_at, ended_at, legacy)
         SELECT ar.id, ar.idempotency_key, 1, 'schedule', ar.automation_id, a.buddy_id, a.workspace_id, ar.conversation_id,
           a.buddy_project_id, ar.status, ar.claim_token, ar.claim_expires_at, ar.outcome, ar.error, ar.scheduled_for, ar.claimed_at,
           ar.started_at, ar.ended_at,
           json_object('source', 'buddy_automation_runs', 'iteration', ar.iteration, 'policy', json((SELECT json_object(
             'max_runtime_seconds', p.max_runtime_seconds, 'max_iterations', p.max_iterations, 'max_tokens', p.max_tokens,
             'max_cost_usd', p.max_cost_usd, 'allowed_operations', json(p.allowed_operations), 'tokens_used', p.tokens_used,
             'cost_usd', p.cost_usd) FROM old.buddy_automation_run_policies p WHERE p.run_id = ar.id)))
         FROM old.buddy_automation_runs ar JOIN old.buddy_automations a ON a.id = ar.automation_id".into(),
        "INSERT INTO conversation SELECT unleashd_conversation_id, buddy_id, workspace_id, buddy_project_id, started_at,
           json_object('link_id', id, 'provider', provider, 'provider_session_id', provider_session_id, 'status', status,
             'last_active_at', last_active_at, 'ended_at', ended_at, 'work_item_id', work_item_id)
         FROM old.conversation_links".into(),
        // Events: audit mutations, command receipts (key + hash, not the cached result) and builder hires, in time order.
        format!(
            "INSERT INTO event (at, actor, workspace_id, buddy_id, task_id, op, payload, idem_key, payload_hash, result_ref, legacy)
             SELECT * FROM (
               SELECT created_at, CASE WHEN operation GLOB 'owner.*' THEN 'owner' ELSE buddy_id END, workspace_id, buddy_id,
                 buddy_project_id, operation, payload, NULL, NULL, NULL, json_object('source', 'buddy_audit_events', 'id', id)
               FROM old.buddy_audit_events WHERE NOT {IS_READ}
               UNION ALL
               SELECT created_at, actor, workspace_id, NULL, NULL, 'receipt', '{{}}', command_key, payload_hash, NULL,
                 json_object('source', 'buddy_command_receipts', 'result_bytes', length(result))
               FROM old.buddy_command_receipts
               UNION ALL
               SELECT created_at, 'owner', workspace_id, buddy_id, NULL, 'buddy.create',
                 json_object('request_fingerprint', request_fingerprint), 'builder:' || conversation_id || ':' || creation_key, NULL,
                 buddy_id, json_object('source', 'buddy_builder_hires', 'conversation_id', conversation_id, 'creation_key', creation_key)
               FROM old.buddy_builder_hires)
             ORDER BY 1"
        ),
    ]
}

/// (mapping, source count, target count). Every pair must be equal.
fn count_pairs() -> Vec<(&'static str, String, &'static str)> {
    vec![
        ("workspace", "SELECT count(*) FROM old.projects".into(), "SELECT count(*) FROM workspace"),
        ("buddy", "SELECT count(*) FROM old.buddies".into(), "SELECT count(*) FROM buddy"),
        (
            "task",
            "SELECT (SELECT count(*) FROM old.owned_projects) + (SELECT count(*) FROM old.buddy_todos)".into(),
            "SELECT count(*) FROM task",
        ),
        ("channel:public", "SELECT count(*) FROM old.buddy_lists".into(), "SELECT count(*) FROM channel WHERE kind = 'public'"),
        ("channel:direct", "SELECT count(DISTINCT member_key) FROM msg".into(), "SELECT count(*) FROM channel WHERE kind = 'direct'"),
        (
            "channel:task",
            "SELECT count(DISTINCT project_id) FROM old.buddy_task_comments".into(),
            "SELECT count(*) FROM channel WHERE kind = 'task'",
        ),
        ("channel_member", format!("SELECT count(*) FROM ({DM_MEMBERS})"), "SELECT count(*) FROM channel_member"),
        (
            "post:direct (messages + replies)",
            "SELECT (SELECT count(*) FROM old.buddy_messages) + (SELECT count(*) FROM old.buddy_messages WHERE status = 'replied')".into(),
            "SELECT count(*) FROM post p JOIN channel c ON c.id = p.channel_id WHERE c.kind = 'direct'",
        ),
        (
            "post:answered request",
            "SELECT count(*) FROM old.buddy_messages WHERE status = 'replied'".into(),
            "SELECT count(*) FROM post WHERE request = 'answered'",
        ),
        (
            "post:public",
            "SELECT count(*) FROM old.buddy_list_posts".into(),
            "SELECT count(*) FROM post p JOIN channel c ON c.id = p.channel_id WHERE c.kind = 'public'",
        ),
        (
            "post:task",
            "SELECT count(*) FROM old.buddy_task_comments".into(),
            "SELECT count(*) FROM post p JOIN channel c ON c.id = p.channel_id WHERE c.kind = 'task'",
        ),
        (
            "post_read:buddy",
            "SELECT count(*) FROM old.buddy_list_reads".into(),
            "SELECT count(*) FROM post_read WHERE reader != 'owner' AND json_extract(legacy, '$.source') IS NOT 'import:direct-read'",
        ),
        (
            "post_read:owner",
            "SELECT count(*) FROM owner_read".into(),
            "SELECT count(*) FROM post_read WHERE reader = 'owner' AND json_extract(legacy, '$.source') IS NOT 'import:direct-read'",
        ),
        (
            "doc:memory (one per buddy and kind)",
            "SELECT count(*) FROM mem_copy WHERE winner".into(),
            "SELECT count(*) FROM doc WHERE kind != 'shared'",
        ),
        (
            "doc:shared",
            "SELECT count(*) FROM old.buddy_knowledge WHERE kind = 'shared'".into(),
            "SELECT count(*) FROM doc WHERE kind = 'shared'",
        ),
        (
            "doc_revision",
            "SELECT (SELECT count(*) FROM mem_chain) + (SELECT count(*) FROM old.buddy_knowledge_revisions
               WHERE document_id IN (SELECT id FROM old.buddy_knowledge WHERE kind = 'shared'))"
                .into(),
            "SELECT count(*) FROM doc_revision",
        ),
        ("schedule", "SELECT count(*) FROM old.buddy_automations".into(), "SELECT count(*) FROM schedule"),
        (
            "run",
            "SELECT (SELECT count(*) FROM old.buddy_runs) + (SELECT count(*) FROM old.buddy_automation_runs)".into(),
            "SELECT count(*) FROM run",
        ),
        ("conversation", "SELECT count(*) FROM old.conversation_links".into(), "SELECT count(*) FROM conversation"),
        (
            "event",
            format!(
                "SELECT (SELECT count(*) FROM old.buddy_audit_events WHERE NOT {IS_READ}) + (SELECT count(*) FROM old.buddy_command_receipts) + (SELECT count(*) FROM old.buddy_builder_hires)"
            ),
            "SELECT count(*) FROM event",
        ),
    ]
}

/// An automation's cadence as cron. Interval schedules convert only when the interval is a
/// whole number of minutes dividing an hour, or of hours dividing a day; anything else is an error.
fn cadence_cron(kind: &str, expression: &str) -> Result<String> {
    let unconvertible = || CoreError::Invalid(format!("schedule {kind} {expression:?} has no exact cron form"));
    match kind {
        "cron" => Ok(expression.to_string()),
        "interval" => {
            let seconds: i64 = expression.parse().map_err(|_| unconvertible())?;
            match (seconds % 60, seconds / 60) {
                (0, m) if m > 0 && m < 60 && 60 % m == 0 => Ok(format!("*/{m} * * * *")),
                (0, m) if m % 60 == 0 && m / 60 > 0 && 24 % (m / 60) == 0 => Ok(format!("0 */{} * * *", m / 60)),
                _ => Err(unconvertible()),
            }
        }
        other => Err(CoreError::Invalid(format!("schedule kind {other:?}"))),
    }
}

fn import_schedules(conn: &Connection, now: &str) -> Result<Vec<Value>> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    let user_error = |e: CoreError| rusqlite::Error::UserFunctionError(Box::new(e));
    conn.create_scalar_function("cadence_cron", 2, flags, move |ctx| {
        cadence_cron(&ctx.get::<String>(0)?, &ctx.get::<String>(1)?).map_err(user_error)
    })?;
    conn.create_scalar_function("next_slot", 3, flags, move |ctx| {
        next_run(&ctx.get::<String>(0)?, &ctx.get::<String>(1)?, &ctx.get::<String>(2)?).map_err(user_error)
    })?;
    conn.execute(
        "INSERT INTO schedule (id, buddy_id, workspace_id, task_id, name, cron, timezone, prompt, limits, enabled, next_run_at,
           archived_at, created_at, legacy)
         SELECT a.id, a.buddy_id, a.workspace_id, a.buddy_project_id, a.name, cadence_cron(a.schedule_kind, a.schedule_expression),
           a.timezone, json_extract(a.job_payload, '$.prompt'),
           json_object('max_runtime_seconds', p.max_runtime_seconds, 'max_iterations', p.max_iterations, 'max_tokens', p.max_tokens,
             'max_cost_usd', p.max_cost_usd, 'allowed_operations', json(p.allowed_operations)),
           a.enabled, a.next_run_at, a.archived_at, a.created_at,
           json_object('schedule_kind', a.schedule_kind, 'schedule_expression', a.schedule_expression, 'job_kind', a.job_kind,
             'job_payload', json(a.job_payload), 'last_run_at', a.last_run_at, 'updated_at', a.updated_at,
             'policy_created_at', p.created_at, 'policy_updated_at', p.updated_at)
         FROM old.buddy_automations a JOIN old.buddy_automation_policies p ON p.automation_id = a.id",
        [],
    )?;
    // Every imported cadence must be schedulable in its timezone.
    conn.query_row("SELECT count(next_slot(cron, timezone, ?1)) FROM schedule", [now], |r| r.get::<_, i64>(0))?;
    json_rows(
        conn,
        "SELECT json_object('id', id, 'from', json_array(json_extract(legacy, '$.schedule_kind'), json_extract(legacy, '$.schedule_expression')),
           'cron', cron) FROM schedule WHERE json_extract(legacy, '$.schedule_kind') != 'cron'",
    )
}

fn json_rows(conn: &Connection, sql: &str) -> Result<Vec<Value>> {
    let texts: Vec<String> = unleashd_buddies::store::collect(conn.prepare(sql)?.query_map([], |r| r.get(0))?)?;
    texts.iter().map(|t| serde_json::from_str(t).map_err(Into::into)).collect()
}

pub fn import(source: &Path, target: &Path, owner_reads: &Path, options: ImportOptions) -> Result<ImportReport> {
    if target.exists() {
        return Err(CoreError::Invalid(format!("target {} already exists; the import only writes a new file", target.display())));
    }
    let src = open_source(source)?;
    let source_version = source_version(&src, "")?;
    let soul_baseline = soul_files(&src, V33_SOUL_PATHS)?;
    let lists: Vec<String> = unleashd_buddies::store::collect(src.prepare("SELECT id FROM buddy_lists")?.query_map([], |r| r.get(0))?)?;
    drop(src);
    let owner_reads = load_owner_reads(owner_reads)?;

    let conn = schema::open(&target.to_string_lossy())?;
    conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    register_sha256(&conn)?;
    conn.execute("ATTACH DATABASE ?1 AS old", [uri(source)])?;
    let old_version = self::source_version(&conn, "old.")?;
    if old_version != source_version {
        return Err(CoreError::WrongDatabase(format!("source version changed during import: {source_version} to {old_version}")));
    }
    for sql in setup_sql() {
        conn.execute(&sql, [])?;
    }
    for (list, post, at) in owner_reads.cursors(&lists) {
        conn.execute("INSERT INTO owner_read VALUES (?1, ?2, ?3)", [list, post, at])?;
    }
    let violations: Vec<String> = DOMAIN_CHECKS
        .iter()
        .map(|(label, sql)| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).map(|n| (label, n)))
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .map(|(label, n)| format!("{label}: {n} rows"))
        .collect();
    if !violations.is_empty() {
        return Err(CoreError::Invalid(format!("source values outside the mapping: {}", violations.join("; "))));
    }

    let now = now_iso();
    conn.execute_batch("BEGIN")?;
    for sql in mapping_sql(source_version) {
        conn.execute(&sql, [])?;
    }
    assign_post_ords(&conn)?;
    register_ord_ceiling(&conn)?;
    conn.execute(
        &format!(
            "INSERT INTO post_read (reader, channel_id, last_post_id, last_post_at, last_ord, updated_at, legacy)
             SELECT buddy_id, list_id, last_post_id, last_post_created_at, {}, updated_at, json_object('source', 'buddy_list_reads')
             FROM old.buddy_list_reads",
            CURSOR_ORD.replace("{post}", "last_post_id").replace("{at}", "last_post_created_at")
        ),
        [],
    )?;
    conn.execute(
        &format!(
            "INSERT INTO post_read (reader, channel_id, last_post_id, last_post_at, last_ord, updated_at, legacy)
             SELECT 'owner', list_id, post_id, created_at, {}, ?1, json_object('source', 'owner-channel-reads.json') FROM owner_read",
            CURSOR_ORD.replace("{post}", "post_id").replace("{at}", "created_at")
        ),
        [&now],
    )?;
    let direct_reads = match options.mark_direct_read {
        false => DirectReads::NotMarked,
        true => {
            let cursors = conn.execute(
                &format!(
                    "INSERT INTO post_read (reader, channel_id, last_post_id, last_post_at, last_ord, updated_at, legacy)
                     SELECT reader, channel_id, post_id, post_at, post_ord, ?1, json_object('source', '{DIRECT_READ_SOURCE}')
                     FROM ({DIRECT_READ_CURSORS}) WHERE true ON CONFLICT(reader, channel_id) DO NOTHING"
                ),
                [&now],
            )?;
            DirectReads::Marked { cursors: cursors as i64 }
        }
    };
    let converted_schedules = import_schedules(&conn, &now)?;
    let counts: Vec<(String, i64, i64)> = count_pairs()
        .into_iter()
        .map(|(label, old_sql, new_sql)| -> Result<(String, i64, i64)> {
            Ok((label.to_string(), conn.query_row(&old_sql, [], |r| r.get(0))?, conn.query_row(new_sql, [], |r| r.get(0))?))
        })
        .collect::<Result<_>>()?;
    let mismatched: Vec<String> = counts.iter().filter(|(_, a, b)| a != b).map(|(l, a, b)| format!("{l}: {a} → {b}")).collect();
    if !mismatched.is_empty() {
        conn.execute_batch("ROLLBACK")?;
        return Err(CoreError::Invalid(format!("import count mismatch: {}", mismatched.join("; "))));
    }
    let dropped_read_events: i64 =
        conn.query_row(&format!("SELECT count(*) FROM old.buddy_audit_events WHERE {IS_READ}"), [], |r| r.get(0))?;
    let dropped_tables = DROPPED_TABLES
        .iter()
        .map(|table| -> Result<DroppedTable> {
            let rows = conn.query_row(&format!("SELECT count(*) FROM old.{table}"), [], |r| r.get(0))?;
            Ok(DroppedTable { table: table.to_string(), rows })
        })
        .collect::<Result<Vec<_>>>()?;
    let non_home_memberships = json_rows(
        &conn,
        "SELECT json_object('buddy_id', b.id, 'slug', b.slug, 'home_workspace', b.project_id, 'workspace', m.project_id,
           'background_enabled', m.background_enabled, 'dispatch', m.dispatch)
         FROM old.buddy_projects m JOIN old.buddies b ON b.id = m.buddy_id WHERE m.project_id != b.project_id ORDER BY b.slug, m.project_id",
    )?;
    let memory_fold_winners = json_rows(
        &conn,
        "SELECT json_object('doc_id', 'mem_' || c.buddy_id || '_' || c.kind, 'slug', b.slug, 'kind', c.kind, 'source_id', c.source_id,
           'scope_kind', c.scope_kind, 'scope_id', c.scope_id, 'updated_at', c.updated_at)
         FROM mem_copy c JOIN old.buddies b ON b.id = c.buddy_id WHERE c.winner AND c.source != 'buddy_memory_heads' ORDER BY b.slug, c.kind",
    )?;
    let folded_copies: i64 = conn.query_row("SELECT count(*) FROM mem_copy WHERE NOT winner", [], |r| r.get(0))?;
    let cross_channel_roots: i64 =
        conn.query_row("SELECT count(*) FROM msg a JOIN msg r ON r.id = a.root_message_id WHERE r.member_key != a.member_key", [], |r| {
            r.get(0)
        })?;
    conn.execute_batch("COMMIT")?;
    conn.execute_batch("DROP VIEW msg; DETACH DATABASE old; PRAGMA foreign_keys = ON")?;
    let foreign_key_violations = unleashd_buddies::store::collect(conn.prepare("PRAGMA foreign_key_check")?.query_map([], |r| {
        Ok(serde_json::json!({"table": r.get::<_, String>(0)?, "rowid": r.get::<_, Option<i64>>(1)?, "parent": r.get::<_, String>(2)?}))
    })?)?;
    Ok(ImportReport {
        source: source.display().to_string(),
        source_version,
        target: target.display().to_string(),
        imported_at: now,
        counts,
        dropped_read_events,
        non_home_memberships,
        memory_fold_winners,
        folded_copies,
        converted_schedules,
        foreign_key_violations,
        soul_files: soul_baseline,
        cross_channel_roots,
        owner_reads,
        direct_reads,
        dropped_tables,
    })
}
