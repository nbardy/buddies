//! Tasks: units of owned work; todos are child tasks. Updates are compare-and-swap on
//! `revision`. Pausing, cancelling or handing a task to a new owner bumps its `epoch`, which
//! cancels runs queued under the old epoch.

use crate::error::{CoreError, Result};
use crate::store::{Mutation, Store, collect, corrupt, get_buddy, idempotent, new_id, now_iso, require};
use crate::types::*;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde_json::json;

const TASK_COLS: &str = "id, workspace_id, owner_id, parent_id, title, done_criteria, status, paused, epoch, next_action, \
    blocked_reason, evidence, position, revision, created_at, updated_at, pin";

fn task_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        owner_id: r.get(2)?,
        parent_id: r.get(3)?,
        title: r.get(4)?,
        done_criteria: r.get(5)?,
        status: r.get(6)?,
        paused: r.get(7)?,
        epoch: r.get(8)?,
        next_action: r.get(9)?,
        blocked_reason: r.get(10)?,
        evidence: parse_evidence(&r.get::<_, String>(11)?).map_err(corrupt)?,
        position: r.get(12)?,
        revision: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        pin: r.get(16)?,
    })
}

pub(crate) fn get_task(conn: &Connection, id: &str) -> Result<Task> {
    conn.prepare_cached(&format!("SELECT {TASK_COLS} FROM task WHERE id = ?1"))?
        .query_row([id], task_row)
        .optional()?
        .ok_or_else(|| CoreError::not_found("task", id))
}

impl Store {
    pub fn upsert_task(&mut self, actor: &Actor, write: TaskWrite) -> Result<Task> {
        self.write(|tx| {
            let id = match write {
                TaskWrite::Create { owner_id, parent_id, title, done_criteria, key } => {
                    create(tx, actor, owner_id, parent_id, title, done_criteria, &key)?
                }
                TaskWrite::Update { task_id, base_revision, changes, key } => update(tx, actor, &task_id, base_revision, changes, &key)?,
            };
            get_task(tx, &id)
        })
    }

    pub fn get_task(&self, id: &str) -> Result<Task> {
        get_task(&self.conn, id)
    }

    pub fn list_tasks(&self, query: TaskQuery) -> Result<Vec<Task>> {
        let (filter, arg) = match query {
            TaskQuery::Owner { buddy_id } => ("owner_id = ?1 ORDER BY updated_at DESC", buddy_id),
            TaskQuery::Workspace { workspace_id } => ("workspace_id = ?1 ORDER BY updated_at DESC", workspace_id),
            TaskQuery::Children { parent_id } => ("parent_id = ?1 ORDER BY position", parent_id),
        };
        let sql = format!("SELECT {TASK_COLS} FROM task WHERE {filter}");
        collect(self.conn.prepare_cached(&sql)?.query_map([arg], task_row)?)
    }

    /// Each Buddy's unfinished top-level tasks in a workspace, and how many of them are blocked:
    /// the directory card's "3 open · 1 blocked". A Buddy with none is absent. The filter repeats
    /// `task_live`'s WHERE term for term, which is what lets SQLite use that partial index.
    pub fn task_counts(&self, workspace_id: &str) -> Result<Vec<TaskCount>> {
        let sql = "SELECT owner_id, count(*), sum(status = 'blocked') FROM task
             WHERE workspace_id = ?1 AND parent_id IS NULL AND status IN ('open','in_progress','blocked','review')
             GROUP BY owner_id";
        collect(
            self.conn
                .prepare_cached(sql)?
                .query_map([workspace_id], |r| Ok(TaskCount { buddy_id: r.get(0)?, open: r.get(1)?, blocked: r.get(2)? }))?,
        )
    }
}

fn create(
    tx: &Transaction,
    actor: &Actor,
    owner_id: String,
    parent_id: Option<String>,
    title: String,
    done_criteria: String,
    key: &str,
) -> Result<String> {
    require(tx, actor, Op::WriteTask, &Subject::Buddy { id: owner_id.clone() })?;
    let owner = get_buddy(tx, &owner_id)?;
    let m = Mutation {
        actor,
        workspace_id: &owner.workspace_id,
        buddy_id: Some(&owner_id),
        task_id: parent_id.as_deref(),
        op: "task.create",
        payload: json!({"owner": owner_id, "parent": parent_id, "title": title, "done_criteria": done_criteria}),
        key: Some(key),
    };
    idempotent(tx, &m, |tx| {
        let position: i64 = match &parent_id {
            None => 0,
            Some(parent) => {
                let parent_ws = get_task(tx, parent)?.workspace_id;
                if parent_ws != owner.workspace_id {
                    return Err(CoreError::Invalid(format!("parent {parent} is in workspace {parent_ws}")));
                }
                tx.query_row("SELECT coalesce(max(position), -1) + 1 FROM task WHERE parent_id = ?1", [parent], |r| r.get(0))?
            }
        };
        let id = new_id("task");
        let now = now_iso();
        tx.execute(
            "INSERT INTO task (id, workspace_id, owner_id, parent_id, title, done_criteria, status, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?8)",
            params![id, owner.workspace_id, owner_id, parent_id, title, done_criteria, position, now],
        )?;
        Ok(id)
    })
}

fn update(tx: &Transaction, actor: &Actor, task_id: &str, base_revision: i64, c: TaskChanges, key: &str) -> Result<String> {
    let task = get_task(tx, task_id)?;
    require(tx, actor, Op::WriteTask, &Subject::Buddy { id: task.owner_id.clone() })?;
    if let Some(new_owner) = &c.owner_id {
        require(tx, actor, Op::WriteTask, &Subject::Buddy { id: new_owner.clone() })?;
    }
    let m = Mutation {
        actor,
        workspace_id: &task.workspace_id,
        buddy_id: Some(&task.owner_id),
        task_id: Some(task_id),
        op: "task.update",
        payload: json!({"base": base_revision, "title": c.title, "done_criteria": c.done_criteria, "status": c.status.map(|s| s.as_str()),
            "next_action": c.next_action, "blocked_reason": c.blocked_reason, "evidence": c.evidence, "paused": c.paused,
            "position": c.position, "pin": c.pin, "owner": c.owner_id}),
        key: Some(key),
    };
    idempotent(tx, &m, |tx| {
        if task.revision != base_revision {
            return Err(CoreError::RevisionConflict { expected: base_revision, current: task.revision });
        }
        let next = Task {
            title: c.title.unwrap_or(task.title.clone()),
            done_criteria: c.done_criteria.unwrap_or(task.done_criteria.clone()),
            status: c.status.unwrap_or(task.status),
            next_action: c.next_action.or(task.next_action.clone()),
            blocked_reason: c.blocked_reason.or(task.blocked_reason.clone()),
            evidence: c.evidence.unwrap_or(task.evidence.clone()),
            paused: c.paused.unwrap_or(task.paused),
            position: c.position.unwrap_or(task.position),
            pin: c.pin.unwrap_or(task.pin),
            owner_id: c.owner_id.unwrap_or(task.owner_id.clone()),
            revision: task.revision + 1,
            updated_at: now_iso(),
            ..task.clone()
        };
        if next.status == TaskStatus::Blocked && next.blocked_reason.as_deref().unwrap_or("").trim().is_empty() {
            return Err(CoreError::Invalid("a blocked task needs a blocked_reason".into()));
        }
        // A pin is a Home-level selection: only a top-level task (an initiative) can carry one.
        if next.pin < 0 || (next.pin > 0 && next.parent_id.is_some()) {
            return Err(CoreError::Invalid("only a top-level task can be pinned (pin >= 0; 0 unpins)".into()));
        }
        // Pattern: fix-guards (docs/patterns.md#fix-guards)
        // Unpausing used to bump the epoch too, silently cancelling a request queued while the
        // task was paused (it showed `task_paused`, then vanished instead of running). Only
        // pausing invalidates. Guard: buddies-v2 "task_paused ... becomes claimable".
        let invalidates = (next.paused && !task.paused)
            || next.owner_id != task.owner_id
            || (next.status == TaskStatus::Cancelled && task.status != TaskStatus::Cancelled);
        let epoch = task.epoch + i64::from(invalidates);
        tx.execute(
            "UPDATE task SET title = ?2, done_criteria = ?3, status = ?4, next_action = ?5, blocked_reason = ?6, evidence = ?7,
               paused = ?8, position = ?9, owner_id = ?10, epoch = ?11, revision = ?12, updated_at = ?13, pin = ?14 WHERE id = ?1",
            params![
                task.id,
                next.title,
                next.done_criteria,
                next.status,
                next.next_action,
                next.blocked_reason,
                evidence_json(&next.evidence),
                next.paused,
                next.position,
                next.owner_id,
                epoch,
                next.revision,
                next.updated_at,
                next.pin
            ],
        )?;
        tx.execute(
            "UPDATE run SET status = 'cancelled', error_code = 'task_epoch_stale', ended_at = ?3
             WHERE task_id = ?1 AND status = 'queued' AND task_epoch < ?2",
            params![task.id, epoch, next.updated_at],
        )?;
        Ok(task.id.clone())
    })
}
