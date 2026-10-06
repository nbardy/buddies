//! The store: one owned connection, transactions, `authorize`, the event log with idempotency,
//! and the small identity reads. Behaviour for posts, docs, tasks and runs lives in sibling
//! modules as further `impl Store` blocks.

use crate::error::{CoreError, Result};
use crate::posts::get_channel;
use crate::schema;
use crate::types::*;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use sha2::{Digest, Sha256};

pub struct Store {
    pub(crate) conn: Connection,
}

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// A new row id: the prefix and a time-ordered UUIDv7 (ids.rs), so ids sort in write order.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", crate::ids::next())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Authorization rule of an operation. `authorize` dispatches on it.
enum Rule {
    OwnerOnly,
    SelfOrManager,
    AnyBuddy,
    /// Public and task channels: any active buddy. Direct channels: members only.
    ChannelAccess,
    WorkspaceChannel,
    /// A run: self-or-manager of its Buddy, or (for a request's run) the request's author.
    RunRetry,
}

fn rule(op: Op) -> Rule {
    match op {
        Op::Admin => Rule::OwnerOnly,
        Op::CreateChannel | Op::SearchPosts => Rule::AnyBuddy,
        Op::Post | Op::ReadChannel => Rule::ChannelAccess,
        Op::ArchiveChannel | Op::RenameChannel => Rule::WorkspaceChannel,
        Op::RetryRun => Rule::RunRetry,
        Op::ReadDoc | Op::WriteDoc | Op::WriteTask | Op::EnqueueRun | Op::CancelRun | Op::WriteSchedule => Rule::SelfOrManager,
    }
}

/// A mutation's event row. `key` makes the mutation idempotent per (actor, workspace).
pub(crate) struct Mutation<'a> {
    pub actor: &'a Actor,
    pub workspace_id: &'a str,
    pub buddy_id: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub op: &'a str,
    pub payload: serde_json::Value,
    pub key: Option<&'a str>,
}

impl Store {
    pub fn open(path: &str) -> Result<Store> {
        Ok(Store { conn: schema::open(path)? })
    }

    /// All writes take the write lock up front (BEGIN IMMEDIATE), so two claimers serialize.
    pub(crate) fn write<T>(&mut self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    /// Statement tracing (the query-plan guard records every statement a workload runs).
    pub fn trace(&mut self, f: Option<fn(&str)>) {
        self.conn.trace(f);
    }

    pub fn authorize(&self, actor: &Actor, op: Op, subject: &Subject) -> Result<Decision> {
        authorize(&self.conn, actor, op, subject)
    }

    pub fn append_event(&mut self, actor: &Actor, input: EventInput) -> Result<Event> {
        self.write(|tx| {
            let payload: serde_json::Value = serde_json::from_str(&input.payload)?;
            let m = Mutation {
                actor,
                workspace_id: &input.workspace_id,
                buddy_id: input.buddy_id.as_deref(),
                task_id: input.task_id.as_deref(),
                op: &input.op,
                payload,
                key: input.key.as_deref(),
            };
            let hash = sha256_hex(m.payload.to_string().as_bytes());
            let seq = match prior(tx, &m, &hash)? {
                Prior::Replay { seq, .. } => seq,
                Prior::Fresh => record(tx, &m, &hash, None)?,
            };
            tx.query_row(&format!("SELECT {EVENT_COLS} FROM event WHERE seq = ?1"), [seq], event_row).map_err(Into::into)
        })
    }

    pub fn list_events(&self, buddy_id: &str, before_seq: i64, limit: i64) -> Result<Vec<Event>> {
        let sql = format!("SELECT {EVENT_COLS} FROM event WHERE buddy_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3");
        collect(self.conn.prepare_cached(&sql)?.query_map(params![buddy_id, before_seq, limit], event_row)?)
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let mut stmt = self.conn.prepare_cached("SELECT id, name, root_path, created_at FROM workspace ORDER BY name")?;
        collect(stmt.query_map([], |r| Ok(Workspace { id: r.get(0)?, name: r.get(1)?, root_path: r.get(2)?, created_at: r.get(3)? }))?)
    }

    pub fn get_buddy(&self, id: &str) -> Result<Buddy> {
        get_buddy(&self.conn, id)
    }

    pub fn list_buddies(&self, workspace_id: &str) -> Result<Vec<Buddy>> {
        let sql = format!("SELECT {BUDDY_COLS} FROM buddy WHERE workspace_id = ?1 ORDER BY slug");
        collect(self.conn.prepare_cached(&sql)?.query_map([workspace_id], buddy_row)?)
    }

    pub fn bind_conversation(&mut self, actor: &Actor, input: ConversationInput) -> Result<Conversation> {
        self.write(|tx| {
            require(tx, actor, Op::EnqueueRun, &Subject::Buddy { id: input.buddy_id.clone() })?;
            let buddy = get_buddy(tx, &input.buddy_id)?;
            tx.execute(
                "INSERT INTO conversation (id, buddy_id, workspace_id, task_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO NOTHING",
                params![input.id, buddy.id, buddy.workspace_id, input.task_id, now_iso()],
            )?;
            get_conversation(tx, &input.id)?.ok_or_else(|| CoreError::not_found("conversation", &input.id))
        })
    }
}

// ---- authorize -------------------------------------------------------------------------------

/// `owner | self | manager-of (transitive) | channel member`. The only authorization point.
// Pattern: capability-grants (docs/patterns.md#capability-grants) — the only authorization rule.
pub fn authorize(conn: &Connection, actor: &Actor, op: Op, subject: &Subject) -> Result<Decision> {
    match actor {
        Actor::Owner => Ok(Decision::Allowed),
        Actor::Buddy { id } => buddy_decision(conn, id, rule(op), subject),
    }
}

fn buddy_decision(conn: &Connection, actor: &str, rule: Rule, subject: &Subject) -> Result<Decision> {
    let status = get_buddy(conn, actor)?.status;
    let denied = |reason: String| Ok(Decision::Denied { reason });
    match (status, rule, subject) {
        (BuddyStatus::Archived, _, _) => denied(format!("{actor} is archived")),
        (_, Rule::OwnerOnly, _) => denied("owner only".into()),
        (_, Rule::AnyBuddy, _) => Ok(Decision::Allowed),
        (_, Rule::WorkspaceChannel, Subject::Channel { id }) => {
            let channel = get_channel(conn, id)?;
            if channel.workspace_id == get_buddy(conn, actor)?.workspace_id {
                Ok(Decision::Allowed)
            } else {
                denied(format!("{id} is outside {actor}'s workspace"))
            }
        }
        (_, Rule::WorkspaceChannel, _) => denied("archive needs a channel".into()),
        (_, Rule::RunRetry, Subject::Run { id }) => run_retry_decision(conn, actor, id),
        (_, Rule::RunRetry, _) => denied("retry needs a run".into()),
        (_, Rule::ChannelAccess, Subject::Channel { id }) => channel_access(conn, actor, id),
        (_, Rule::ChannelAccess, Subject::Owner | Subject::Buddy { .. } | Subject::Run { .. }) => denied("posts live in channels".into()),
        (_, Rule::SelfOrManager, Subject::Owner) => denied("the owner's resources are owner only".into()),
        (_, Rule::SelfOrManager, Subject::Channel { .. } | Subject::Run { .. }) => denied("only a buddy's own resources".into()),
        (_, Rule::SelfOrManager, Subject::Buddy { id }) if id == actor => Ok(Decision::Allowed),
        (_, Rule::SelfOrManager, Subject::Buddy { id }) => match manages(conn, actor, id)? {
            true => Ok(Decision::Allowed),
            false => denied(format!("{actor} is neither {id} nor one of its managers")),
        },
    }
}

/// Retry is open to whoever can already cancel the run (its Buddy, its managers) and to the one
/// who asked for the work: the author of the request the run answers, who is waiting on it.
fn run_retry_decision(conn: &Connection, actor: &str, run_id: &str) -> Result<Decision> {
    let run = crate::runs::get_run(conn, run_id)?;
    let requester = match &run.input {
        RunInput::Post { post_id } => Some(crate::posts::get_post(conn, post_id)?.author),
        RunInput::Chat { .. } | RunInput::Deliver { .. } | RunInput::Retired { .. } => None,
    };
    match requester == Some(Actor::Buddy { id: actor.to_string() }) {
        true => Ok(Decision::Allowed),
        false => buddy_decision(conn, actor, Rule::SelfOrManager, &Subject::Buddy { id: run.buddy_id }),
    }
}

fn channel_access(conn: &Connection, actor: &str, channel_id: &str) -> Result<Decision> {
    match get_channel(conn, channel_id)?.kind {
        ChannelKind::Public { .. } | ChannelKind::Task { .. } => Ok(Decision::Allowed),
        ChannelKind::Direct { members } => match members.contains(&Actor::Buddy { id: actor.to_string() }) {
            true => Ok(Decision::Allowed),
            false => Ok(Decision::Denied { reason: format!("{actor} is not a member of {channel_id}") }),
        },
    }
}

/// Walks the manager chain up from `report` (PK lookups; UNION stops cycles).
fn manages(conn: &Connection, manager: &str, report: &str) -> Result<bool> {
    let sql = "WITH RECURSIVE up(id) AS (
                 SELECT manager_id FROM buddy WHERE id = ?1
                 UNION SELECT b.manager_id FROM buddy b JOIN up ON b.id = up.id)
               SELECT EXISTS(SELECT 1 FROM up WHERE id = ?2)";
    Ok(conn.prepare_cached(sql)?.query_row(params![report, manager], |r| r.get(0))?)
}

pub(crate) fn require(conn: &Connection, actor: &Actor, op: Op, subject: &Subject) -> Result<()> {
    match authorize(conn, actor, op, subject)? {
        Decision::Allowed => Ok(()),
        Decision::Denied { reason } => Err(CoreError::Denied(format!("{}: {reason}", op.as_str()))),
    }
}

// ---- events and idempotency ------------------------------------------------------------------
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys)

enum Prior {
    Fresh,
    Replay { result_ref: Option<String>, seq: i64 },
}

/// Looks up the event already recorded under the mutation's key. Same payload = replay;
/// a different payload under the same key is `IdempotencyConflict`.
fn prior(tx: &Transaction, m: &Mutation, hash: &str) -> Result<Prior> {
    let row: Option<(String, Option<String>, i64)> = tx
        .prepare_cached("SELECT payload_hash, result_ref, seq FROM event WHERE actor = ?1 AND workspace_id = ?2 AND idem_key = ?3")?
        .query_row(params![m.actor.key(), m.workspace_id, m.key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    match row {
        None => Ok(Prior::Fresh),
        Some((h, result_ref, seq)) if h == hash => Ok(Prior::Replay { result_ref, seq }),
        Some(_) => Err(CoreError::IdempotencyConflict(m.key.unwrap_or_default().to_string())),
    }
}

fn record(tx: &Transaction, m: &Mutation, hash: &str, result_ref: Option<&str>) -> Result<i64> {
    tx.prepare_cached(
        "INSERT INTO event (at, actor, workspace_id, buddy_id, task_id, op, payload, idem_key, payload_hash, result_ref)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?
    .execute(params![
        now_iso(),
        m.actor.key(),
        m.workspace_id,
        m.buddy_id,
        m.task_id,
        m.op,
        m.payload.to_string(),
        m.key,
        hash,
        result_ref
    ])?;
    Ok(tx.last_insert_rowid())
}

/// Runs `work` once per (actor, workspace, key) and records the mutation event. A replay
/// returns the first result's id without running `work`.
pub(crate) fn idempotent(tx: &Transaction, m: &Mutation, work: impl FnOnce(&Transaction) -> Result<String>) -> Result<String> {
    idempotent_write(tx, m, work).map(|(id, _)| id)
}

/// `idempotent`, also saying whether this call did the write (true) or replayed it (false).
pub(crate) fn idempotent_write(tx: &Transaction, m: &Mutation, work: impl FnOnce(&Transaction) -> Result<String>) -> Result<(String, bool)> {
    let hash = sha256_hex(m.payload.to_string().as_bytes());
    match prior(tx, m, &hash)? {
        Prior::Replay { result_ref: Some(id), .. } => Ok((id, false)),
        Prior::Replay { result_ref: None, seq } => Err(CoreError::Corrupt(format!("event {seq} has no result_ref"))),
        Prior::Fresh => {
            let id = work(tx)?;
            record(tx, m, &hash, Some(&id))?;
            Ok((id, true))
        }
    }
}

const EVENT_COLS: &str = "seq, at, actor, workspace_id, buddy_id, task_id, op, payload, idem_key, result_ref";

fn event_row(r: &Row) -> rusqlite::Result<Event> {
    Ok(Event {
        seq: r.get(0)?,
        at: r.get(1)?,
        actor: r.get(2)?,
        workspace_id: r.get(3)?,
        buddy_id: r.get(4)?,
        task_id: r.get(5)?,
        op: r.get(6)?,
        payload: r.get(7)?,
        idem_key: r.get(8)?,
        result_ref: r.get(9)?,
    })
}

// ---- shared reads ----------------------------------------------------------------------------

pub(crate) const BUDDY_COLS: &str = "id, workspace_id, slug, name, role, status, manager_id, provider, model, \
    reasoning_effort, soul_path, max_active_runs, created_at";

pub(crate) fn buddy_row(r: &Row) -> rusqlite::Result<Buddy> {
    Ok(Buddy {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        slug: r.get(2)?,
        name: r.get(3)?,
        role: r.get(4)?,
        status: r.get(5)?,
        manager_id: r.get(6)?,
        provider: r.get(7)?,
        model: r.get(8)?,
        reasoning_effort: r.get(9)?,
        soul_path: r.get(10)?,
        max_active_runs: r.get(11)?,
        created_at: r.get(12)?,
    })
}

pub(crate) fn get_buddy(conn: &Connection, id: &str) -> Result<Buddy> {
    conn.prepare_cached(&format!("SELECT {BUDDY_COLS} FROM buddy WHERE id = ?1"))?
        .query_row([id], buddy_row)
        .optional()?
        .ok_or_else(|| CoreError::not_found("buddy", id))
}

fn get_conversation(conn: &Connection, id: &str) -> Result<Option<Conversation>> {
    Ok(conn
        .prepare_cached("SELECT id, buddy_id, workspace_id, task_id, created_at FROM conversation WHERE id = ?1")?
        .query_row([id], |r| {
            Ok(Conversation { id: r.get(0)?, buddy_id: r.get(1)?, workspace_id: r.get(2)?, task_id: r.get(3)?, created_at: r.get(4)? })
        })
        .optional()?)
}

pub fn collect<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> Result<Vec<T>> {
    rows.collect::<rusqlite::Result<Vec<T>>>().map_err(Into::into)
}

/// Maps a decode failure raised inside a row closure back to a typed error.
pub(crate) fn corrupt(e: CoreError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
}
