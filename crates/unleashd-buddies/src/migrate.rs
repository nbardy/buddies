//! The 2026-10-06 delivery rebuild: the ONE live migration of the Buddies target system (owner
//! decisions H, H2, I, J; agent_notes/2026-10-06_buddies-target-system-review.md §6–§7). It folds
//! two designs into a single `run` rebuild, because each rebuild is one-way on the live store and
//! the owner accepted exactly one: the durable-pending columns (`body`, `executing_at`; W0a/W0b,
//! 95028f0/745515f) and the delivery model (`deliver`, subscriptions, `through_ord`).
//!
//! One transaction, after a pre-migration copy of the file (9acd4bd):
//! - `run` is rebuilt (`schema::RUN_TABLE`): kinds `chat | post | deliver`, the retired kinds kept
//!   as history only; `snapshot` dropped (an imported value moves into `legacy`);
//! - `thread_read` gains `conversation_id` (the subscription), `schedule` gains `root_id` (its
//!   thread) and loses `limits` (the v33 `max_tokens`/`max_cost_usd` budgets: validated, stored,
//!   never read; todo_6563759d), `post` loses `return_conversation_id`, `thread_follow` is dropped;
//! - every QUEUED row of a folded kind becomes what it now is (delivery design D6), and its old row
//!   ends `cancelled` / `migrated`:
//!   - `reply`: the requester's conversation subscribes to the request's thread, and the answer is
//!     delivered there;
//!   - `failure_notice`: the requester subscribes, and the notice is written as a `run_failed` post,
//!     which delivers it;
//!   - `follow`: its conversation subscribes; posts it has not read are delivered. A follow still
//!     waiting for its `until` has no successor (follow timeouts are gone; use `schedule`) and is
//!     dropped, counted in the log;
//!   - `schedule`: the slot fires as a post in the schedule's thread, delivered to its Buddy;
//! - a queued `chat` row has no stored text (its only copy was the old backend's memory). It ends
//!   `cancelled` / `interrupted`, what the claim gate did to it anyway. No body is invented;
//! - a running or cancel_requested row of any kind was spawned before `executing_at` existed, so it
//!   gets `executing_at = coalesce(started_at, created_at)` and counts as executed: the backend
//!   that adopted it settles it, or its lease ends it. Without this the rule "unexecuted →
//!   requeue" would REPLAY every legacy running turn (the August rule forbids it).
//!
//! The before/after counts are logged. Rollback: an older build cannot read a `deliver` row
//! (`RunInput::from_columns` → Corrupt) and fails loudly; the pre-migration copy is the way back.
//! Guards: tests/migration.rs (a store shaped like the live one on 2026-10-06, with queued reply,
//! follow and failure_notice rows).

use crate::error::{CoreError, Result};
use crate::posts::{get_channel, get_post, system_post};
use crate::runs::{fire_slot, get_run, get_schedule};
use crate::schema::{INDEXES, has_column, run_table};
use crate::store::{collect, now_iso};
use crate::types::*;
use crate::deliveries::{enqueue_delivery, subscribe};
use rusqlite::{Connection, Transaction, params};
use std::collections::BTreeMap;

/// The columns the pre-rebuild `run` table has in every file (after `retry_of` was dropped and
/// `config` added on open), copied by name.
const OLD_COLUMNS: &str = "id, input_key, attempt, input_kind, input_id, buddy_id, workspace_id, conversation_id, task_id, \
    task_epoch, after_run_id, status, lease_token, lease_expires_at, deadline, outcome, error_code, error, ready_at, \
    created_at, started_at, ended_at, config";

/// What the migration did, logged and returned for tests.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    pub backup: String,
    pub runs_before: BTreeMap<String, i64>,
    pub runs_after: BTreeMap<String, i64>,
    pub replies_delivered: i64,
    pub replies_dropped: i64,
    pub failures_posted: i64,
    pub follows_delivered: i64,
    pub follows_subscribed: i64,
    pub follow_timeouts_dropped: i64,
    pub schedules_fired: i64,
    pub chats_interrupted: i64,
    pub subscriptions: i64,
}

/// A queued row of a folded kind, read before the old table goes.
struct Folded {
    id: String,
    kind: String,
    input_id: String,
    buddy_id: String,
    conversation_id: Option<String>,
    ready_at: String,
}

/// Runs the rebuild once: a file whose `run` CHECK already names `'deliver'` has it.
pub fn rebuild_for_delivery(conn: &Connection, path: &str) -> Result<Option<Report>> {
    let sql: String = conn.query_row("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'run'", [], |r| r.get(0))?;
    if sql.contains("'deliver'") {
        return Ok(None);
    }
    let mut report = Report { backup: backup(conn, path)?, runs_before: run_counts(conn)?, ..Report::default() };
    // Outside the transaction (SQLite ignores it inside one): the rebuild drops and renames `run`
    // and drops columns. The check after the commit proves nothing was left dangling.
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let migrated = (|| -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        migrate(&tx, &mut report)?;
        tx.commit()?;
        Ok(())
    })();
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    migrated?;
    let dangling: i64 = conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0))?;
    if dangling != 0 {
        return Err(CoreError::Corrupt(format!("the delivery rebuild left {dangling} dangling references")));
    }
    report.runs_after = run_counts(conn)?;
    report.subscriptions = conn.query_row("SELECT count(*) FROM thread_read WHERE conversation_id IS NOT NULL", [], |r| r.get(0))?;
    eprintln!("[buddies-core] delivery rebuild: {report:?}");
    Ok(Some(report))
}

/// The pre-migration copy (owner requirement, 2026-10-05). After the rebuild an older build cannot
/// read the `run` table, so this file is the only way back to it. Taken before the first write,
/// next to the database, named after the schema it holds (`run-v1`: the table before this rebuild)
/// and the time. `VACUUM INTO` writes one consistent file that includes the WAL, unlike copying
/// the main file. If it fails (a full disk), the open fails and nothing is migrated: a migration
/// without its way back never runs. Guard: `the_rebuild_leaves_a_pre_migration_copy_at_the_old_schema`.
fn backup(conn: &Connection, path: &str) -> Result<String> {
    let backup = format!("{path}.before-delivery.run-v1.{}.sqlite", chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"));
    conn.execute("VACUUM INTO ?1", [&backup])?;
    eprintln!("[buddies-core] delivery rebuild: pre-migration copy at {backup}");
    Ok(backup)
}

fn run_counts(conn: &Connection) -> Result<BTreeMap<String, i64>> {
    let rows = collect(
        conn.prepare("SELECT input_kind || ':' || status, count(*) FROM run GROUP BY 1")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?,
    )?;
    Ok(rows.into_iter().collect())
}

fn migrate(tx: &Transaction, report: &mut Report) -> Result<()> {
    let now = now_iso();
    if !has_column(tx, "thread_read", "conversation_id")? {
        tx.execute_batch("ALTER TABLE thread_read ADD COLUMN conversation_id TEXT;")?;
    }
    if !has_column(tx, "schedule", "root_id")? {
        tx.execute_batch("ALTER TABLE schedule ADD COLUMN root_id TEXT REFERENCES post(id);")?;
    }
    for (table, column) in [("schedule", "limits"), ("post", "return_conversation_id")] {
        if has_column(tx, table, column)? {
            tx.execute_batch(&format!("ALTER TABLE {table} DROP COLUMN {column};"))?;
        }
    }
    let folded = collect(
        tx.prepare("SELECT id, input_kind, input_id, buddy_id, conversation_id, ready_at FROM run
                    WHERE status = 'queued' AND input_kind IN ('reply','failure_notice','follow','schedule') ORDER BY ready_at, id")?
            .query_map([], |r| {
                Ok(Folded {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    input_id: r.get(2)?,
                    buddy_id: r.get(3)?,
                    conversation_id: r.get(4)?,
                    ready_at: r.get(5)?,
                })
            })?,
    )?;
    report.chats_interrupted = tx.query_row("SELECT count(*) FROM run WHERE input_kind = 'chat' AND status = 'queued'", [], |r| r.get(0))?;
    let snapshot = match has_column(tx, "run", "snapshot")? {
        true => "snapshot",
        false => "NULL",
    };
    tx.execute_batch(&format!(
        "{new_table}
         INSERT INTO run_new ({OLD_COLUMNS}, legacy, executing_at)
           SELECT {OLD_COLUMNS},
                  CASE WHEN {snapshot} IS NULL THEN legacy
                       WHEN legacy IS NULL THEN json_object('snapshot', {kept})
                       WHEN json_valid(legacy) THEN json_set(legacy, '$.snapshot', {kept})
                       ELSE json_object('legacy', legacy, 'snapshot', {kept}) END,
                  CASE WHEN status IN ('running','cancel_requested') THEN coalesce(started_at, created_at) END
           FROM run WHERE status <> 'queued' OR input_kind = 'post';
         UPDATE run SET status = 'cancelled', lease_token = NULL, error_code = 'interrupted',
                error = 'queued before durable intake; the text was never stored', ended_at = '{now}'
           WHERE status = 'queued' AND input_kind = 'chat';
         UPDATE run SET status = 'cancelled', lease_token = NULL, error_code = 'migrated',
                error = 'folded into deliver by the 2026-10-06 rebuild', ended_at = '{now}'
           WHERE status = 'queued';
         INSERT INTO run_new ({OLD_COLUMNS}, legacy)
           SELECT {OLD_COLUMNS}, legacy FROM run WHERE id NOT IN (SELECT id FROM run_new);
         DROP TABLE run;
         ALTER TABLE run_new RENAME TO run;
         {INDEXES}",
        new_table = run_table("run_new"),
        kept = format!("CASE WHEN json_valid({snapshot}) THEN json({snapshot}) ELSE {snapshot} END"),
    ))?;
    for row in folded {
        match row.kind.as_str() {
            "reply" => reply(tx, &row, report)?,
            "failure_notice" => failure(tx, &row, report)?,
            "follow" => follow(tx, &row, report)?,
            "schedule" => {
                fire_slot(tx, &get_schedule(tx, &row.input_id)?, &row.ready_at)?;
                report.schedules_fired += 1;
            }
            other => return Err(CoreError::Corrupt(format!("folded run {} has kind {other}", row.id))),
        }
    }
    tx.execute_batch("DROP TABLE IF EXISTS thread_follow;")?;
    Ok(())
}

fn root_of(post: &Post) -> &str {
    post.root_id.as_deref().unwrap_or(&post.id)
}

/// A queued return of an answer: the answer, delivered to the conversation that asked.
fn reply(tx: &Transaction, row: &Folded, report: &mut Report) -> Result<()> {
    let request = get_post(tx, &row.input_id)?;
    let RequestState::Answered { answer_id } = &request.request else {
        report.replies_dropped += 1;
        return Ok(());
    };
    if let Some(conversation) = &row.conversation_id {
        subscribe(tx, &row.buddy_id, root_of(&request), Some(conversation))?;
    }
    enqueue_delivery(tx, &row.buddy_id, &get_post(tx, answer_id)?, row.conversation_id.clone())?;
    report.replies_delivered += 1;
    Ok(())
}

/// A queued failure notice: the `run_failed` post it now is, delivered to the asker.
fn failure(tx: &Transaction, row: &Folded, report: &mut Report) -> Result<()> {
    let failed = get_run(tx, &row.input_id)?;
    let RunInput::Post { post_id } = &failed.input else {
        return Err(CoreError::Corrupt(format!("failure notice {} names run {} of {:?}", row.id, failed.id, failed.input)));
    };
    let request = get_post(tx, post_id)?;
    if let Some(conversation) = &row.conversation_id {
        subscribe(tx, &row.buddy_id, root_of(&request), Some(conversation))?;
    }
    let body = format!(
        "The run {} for this request failed ({}): {}. The request is closed as failed. Inspect its effects before asking again; if it is safe to repeat, runs {{kind:\"retry\", runId:\"{}\", key}} re-runs it (optionally on another worker model) and reopens the request.",
        failed.id,
        failed.error_code.as_deref().unwrap_or("failed"),
        failed.error.as_deref().unwrap_or("no error recorded"),
        failed.id
    );
    let notice = system_post(tx, &failed.buddy_id, &get_channel(tx, &request.channel_id)?, Some(&request), "run_failed", &body)?;
    // The asker's subscription delivered it; one queued with no conversation gets a fresh one.
    if row.conversation_id.is_none() {
        enqueue_delivery(tx, &row.buddy_id, &notice, None)?;
    }
    report.failures_posted += 1;
    Ok(())
}

/// A queued follow: its conversation subscribes; anything it has not read is delivered now.
fn follow(tx: &Transaction, row: &Folded, report: &mut Report) -> Result<()> {
    let (root_id, conversation): (String, String) = tx.query_row(
        "SELECT root_id, conversation_id FROM thread_follow WHERE id = ?1",
        params![row.input_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    subscribe(tx, &row.buddy_id, &root_id, Some(&conversation))?;
    report.follows_subscribed += 1;
    let newest: Option<String> = tx.query_row(
        "SELECT max(p.ord) FROM post p WHERE (p.root_id = ?2 OR p.id = ?2) AND p.author_id IS NOT ?1
           AND p.ord > coalesce((SELECT t.last_ord FROM thread_read t WHERE t.reader = ?1 AND t.root_id = ?2), '')",
        params![row.buddy_id, root_id],
        |r| r.get(0),
    )?;
    match newest {
        Some(ord) => {
            let post_id: String = tx.query_row("SELECT id FROM post WHERE ord = ?1", [ord], |r| r.get(0))?;
            enqueue_delivery(tx, &row.buddy_id, &get_post(tx, &post_id)?, Some(conversation))?;
            report.follows_delivered += 1;
        }
        None => report.follow_timeouts_dropped += 1,
    }
    Ok(())
}
