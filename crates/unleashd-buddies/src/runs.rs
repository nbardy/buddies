//! Runs: the queue, leases and outcomes of every buddy turn, and schedules (which only enqueue).
//! A run is live while queued, running or cancel_requested; the unique indexes allow one live
//! run per input key and one running run per conversation.

use crate::error::{CoreError, Result};
use crate::posts::get_post;
use crate::store::{Mutation, Store, collect, corrupt, get_buddy, idempotent, new_id, now_iso, require};
use crate::tasks::get_task;
use crate::types::*;
use chrono::{DateTime, Duration, Utc};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};
use serde_json::json;
use std::str::FromStr;

const RUN_COLS: &str = "id, input_key, attempt, input_kind, input_id, buddy_id, workspace_id, conversation_id, task_id, \
    task_epoch, after_run_id, status, deadline, lease_expires_at, snapshot, outcome, error_code, error, ready_at, \
    created_at, started_at, ended_at, config";

const RUN_WITH_ACTIVITY_SQL: &str = r#"FROM run r
    JOIN buddy b ON b.id = r.buddy_id
    LEFT JOIN (
        SELECT buddy_id, count(*) AS active
        FROM run INDEXED BY run_active_buddy
        WHERE status IN ('running','cancel_requested')
        GROUP BY buddy_id
    ) activity ON activity.buddy_id = r.buddy_id"#;

// Pattern: one-definition (docs/patterns.md#one-definition)
// A run once appeared runnable in one view while the claimer held it for another condition. The
// list and claim now use this exact expression; the crate test fails if either path can drift.
//
// `conversation_busy` is one writer per conversation, and it is only right because every run with
// a conversation_id is a real turn in it. Do not admit a run here whose job is decided after the
// claim: on 2026-10-01 no-op `reply` runs for answers to an owner chat's requests sat behind the
// owner's turn up to 2h44m and read as "blocked" (a Buddy offered to cancel the owner's GPU turn).
// The fix is upstream, not a special case in this gate: the route is fixed when the request is
// sent (types.rs `Returns`), and an Inbox answer creates no run. Guard: buddies-v2 "an answer to
// a request sent from a human chat starts no run and never queues behind that chat".
const WAITING_REASON_SQL: &str = r#"CASE
    WHEN r.ready_at > ?1 THEN json_object('kind','not_before','at',r.ready_at)
    WHEN b.status <> 'active' THEN json_object('kind','buddy_archived')
    WHEN r.after_run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM run a WHERE a.id = r.after_run_id AND a.status IN ('complete','failed','cancelled')
    ) THEN json_object('kind','after_run','runId',r.after_run_id)
    WHEN r.conversation_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM run c WHERE c.conversation_id = r.conversation_id
          AND c.status IN ('running','cancel_requested')
    ) THEN json_object('kind','conversation_busy')
    WHEN coalesce(activity.active, 0) >= b.max_active_runs THEN json_object(
        'kind','pool_full',
        'active',coalesce(activity.active, 0),
        'max',b.max_active_runs
    )
    WHEN r.task_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM task t WHERE t.id = r.task_id AND t.paused = 0
    ) THEN json_object('kind','task_paused')
    ELSE NULL
END"#;

fn run_row(r: &Row) -> rusqlite::Result<Run> {
    let ready_at: String = r.get(18)?;
    Ok(Run {
        id: r.get(0)?,
        input_key: r.get(1)?,
        attempt: r.get(2)?,
        input: RunInput::from_columns(&r.get::<_, String>(3)?, r.get(4)?, &ready_at).map_err(corrupt)?,
        buddy_id: r.get(5)?,
        workspace_id: r.get(6)?,
        conversation_id: r.get(7)?,
        task_id: r.get(8)?,
        task_epoch: r.get(9)?,
        after_run_id: r.get(10)?,
        status: r.get(11)?,
        deadline: r.get(12)?,
        lease_expires_at: r.get(13)?,
        snapshot: r.get(14)?,
        outcome: r.get(15)?,
        error_code: r.get(16)?,
        error: r.get(17)?,
        ready_at,
        created_at: r.get(19)?,
        started_at: r.get(20)?,
        ended_at: r.get(21)?,
        // By name: it is the last column, and index shifts elsewhere must not move it.
        config: r.get::<_, Option<String>>("config")?.map(|json| run_config(&json)).transpose().map_err(corrupt)?,
    })
}

fn run_config(json: &str) -> Result<RunConfig> {
    serde_json::from_str(json).map_err(|e| CoreError::Corrupt(format!("run config {json:?}: {e}")))
}

pub(crate) fn get_run(conn: &Connection, id: &str) -> Result<Run> {
    conn.prepare_cached(&format!("SELECT {RUN_COLS} FROM run WHERE id = ?1"))?
        .query_row([id], run_row)
        .optional()?
        .ok_or_else(|| CoreError::not_found("run", id))
}

fn plus_ms(now: &str, ms: i64) -> Result<String> {
    let t = DateTime::parse_from_rfc3339(now).map_err(|e| CoreError::Invalid(format!("time {now:?}: {e}")))?;
    Ok((t.with_timezone(&Utc) + Duration::milliseconds(ms)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Enqueue is idempotent on the input key: the key's latest attempt is returned if it exists.
pub(crate) trait Enqueue {
    fn enqueue(&self, input: EnqueueInput) -> Result<Run>;
}

impl Enqueue for Connection {
    fn enqueue(&self, input: EnqueueInput) -> Result<Run> {
        let (kind, input_id, key) = input.input.columns(&input.buddy_id);
        let latest = format!("SELECT {RUN_COLS} FROM run WHERE input_key = ?1 AND buddy_id = ?2 ORDER BY attempt DESC LIMIT 1");
        let mut existing = self.prepare_cached(&latest)?.query_row([&key, &input.buddy_id], run_row).optional()?;
        if let (None, Some(legacy)) = (&existing, input.input.legacy_key()) {
            existing = self.prepare_cached(&latest)?.query_row([&legacy, &input.buddy_id], run_row).optional()?;
        }
        if let Some(run) = existing {
            return Ok(run);
        }
        let buddy = get_buddy(self, &input.buddy_id)?;
        let task_epoch = input.task_id.as_deref().map(|t| get_task(self, t).map(|t| t.epoch)).transpose()?;
        let now = now_iso();
        let ready_at = match &input.input {
            RunInput::Schedule { slot, .. } => slot.clone(),
            RunInput::Chat { .. } | RunInput::Post { .. } | RunInput::Reply { .. } | RunInput::FailureNotice { .. } => now.clone(),
        };
        let id = new_id("run");
        self.prepare_cached(
            "INSERT INTO run (id, input_key, input_kind, input_id, buddy_id, workspace_id, conversation_id, task_id, task_epoch,
               after_run_id, status, deadline, ready_at, created_at, config)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'queued', ?11, ?12, ?13, ?14)",
        )?
        .execute(params![
            id,
            key,
            kind,
            input_id,
            buddy.id,
            buddy.workspace_id,
            input.conversation_id,
            input.task_id,
            task_epoch,
            input.after_run_id,
            input.deadline,
            ready_at,
            now,
            input.config.as_ref().map(|c| serde_json::to_string(c).expect("run config serializes"))
        ])?;
        get_run(self, &id)
    }
}

impl Store {
    pub fn enqueue_run(&mut self, actor: &Actor, input: EnqueueInput) -> Result<Run> {
        self.write(|tx| {
            require(tx, actor, Op::EnqueueRun, &Subject::Buddy { id: input.buddy_id.clone() })?;
            tx.enqueue(input)
        })
    }

    /// Claims the oldest ready run, or None when nothing is claimable.
    pub fn claim_run(&mut self, lease_ms: i64) -> Result<Option<Claim>> {
        self.claim_run_at(&now_iso(), lease_ms)
    }

    pub fn claim_run_at(&mut self, now: &str, lease_ms: i64) -> Result<Option<Claim>> {
        self.write(|tx| {
            tx.execute(
                "UPDATE run SET status = 'failed', error_code = 'lease_expired', error = 'lease expired before settle',
                   lease_token = NULL, ended_at = ?1
                 WHERE status IN ('running','cancel_requested') AND lease_expires_at < ?1",
                [now],
            )?;
            // Ready, predecessor finished, conversation free, buddy under its limit, task not paused.
            // Background work is always claimable: the old per-Buddy hold was removed 2026-09-29
            // (owner) after it silently parked requests as "delivered but held".
            let candidate: Option<String> = tx
                .prepare_cached(&format!(
                    "SELECT r.id {RUN_WITH_ACTIVITY_SQL}
                     WHERE r.status = 'queued' AND ({WAITING_REASON_SQL}) IS NULL
                     ORDER BY r.ready_at, r.id LIMIT 1"
                ))?
                .query_row([now], |r| r.get(0))
                .optional()?;
            let Some(id) = candidate else { return Ok(None) };
            let token = uuid::Uuid::new_v4().to_string();
            let claimed = tx.execute(
                "UPDATE run SET status = 'running', lease_token = ?2, lease_expires_at = ?3, started_at = ?4 WHERE id = ?1 AND status = 'queued'",
                params![id, token, plus_ms(now, lease_ms)?, now],
            )?;
            match claimed {
                1 => Ok(Some(Claim { run: get_run(tx, &id)?, lease_token: token })),
                _ => Err(CoreError::LeaseLost(id)),
            }
        })
    }

    /// Records the outcome of a claimed run. A run whose cancel was requested can only end cancelled.
    pub fn settle_run(&mut self, run_id: &str, lease_token: &str, outcome: Outcome) -> Result<Run> {
        self.write(|tx| {
            let run = leased(tx, run_id, lease_token)?;
            let (status, text, code, error) = match (&run.status, &outcome) {
                (RunStatus::CancelRequested, Outcome::Complete { .. } | Outcome::Failed { .. }) => {
                    return Err(CoreError::Invalid(format!("run {run_id} was asked to cancel; settle it as cancelled")));
                }
                (_, Outcome::Complete { text }) => ("complete", Some(text.as_str()), None, None),
                (_, Outcome::Failed { code, error }) => ("failed", None, Some(code.as_str()), Some(error.as_str())),
                (_, Outcome::Cancelled { reason }) => ("cancelled", None, Some("cancelled"), Some(reason.as_str())),
            };
            tx.execute(
                "UPDATE run SET status = ?2, outcome = ?3, error_code = ?4, error = ?5, lease_token = NULL, ended_at = ?6 WHERE id = ?1",
                params![run_id, status, text, code, error, now_iso()],
            )?;
            after_settle(tx, &run, &outcome)?;
            get_run(tx, run_id)
        })
    }

    /// Binds a claimed run to the conversation the runner opened for it.
    pub fn bind_run(&mut self, run_id: &str, lease_token: &str, conversation_id: &str) -> Result<Run> {
        self.write(|tx| {
            let run = leased(tx, run_id, lease_token)?;
            tx.execute("UPDATE run SET conversation_id = ?2 WHERE id = ?1", params![run_id, conversation_id]).map_err(|e| {
                match e.sqlite_error_code() {
                    Some(rusqlite::ErrorCode::ConstraintViolation) => CoreError::ConversationBusy(conversation_id.to_string()),
                    _ => e.into(),
                }
            })?;
            match &run.input {
                RunInput::Post { post_id } => {
                    tx.execute("UPDATE post SET conversation_id = ?2 WHERE id = ?1", params![post_id, conversation_id])?;
                }
                RunInput::Chat { .. } | RunInput::Reply { .. } | RunInput::Schedule { .. } | RunInput::FailureNotice { .. } => {}
            }
            get_run(tx, run_id)
        })
    }

    /// Queued runs end now; running ones are asked to stop and end when the runner settles them.
    pub fn cancel_run(&mut self, actor: &Actor, run_id: &str) -> Result<Run> {
        self.write(|tx| {
            let run = get_run(tx, run_id)?;
            require(tx, actor, Op::CancelRun, &Subject::Buddy { id: run.buddy_id.clone() })?;
            match run.status {
                RunStatus::Queued => tx.execute(
                    "UPDATE run SET status = 'cancelled', error_code = 'user_stop', ended_at = ?2 WHERE id = ?1",
                    params![run_id, now_iso()],
                )?,
                RunStatus::Running => tx.execute("UPDATE run SET status = 'cancel_requested' WHERE id = ?1", [run_id])?,
                RunStatus::CancelRequested | RunStatus::Complete | RunStatus::Failed | RunStatus::Cancelled => 0,
            };
            get_run(tx, run_id)
        })
    }

    pub fn get_run(&self, id: &str) -> Result<Run> {
        get_run(&self.conn, id)
    }

    /// Startup recovery, run once by the one process that owns the runner. Every running run was
    /// held by a process that is gone, so it ends now instead of blocking its conversation and a
    /// slot of its buddy until its lease expires (a foreground lease is TURN_MAX_RUNTIME_MS, 24 h).
    /// A queued chat run belongs to a conversation queue that died with that process.
    pub fn recover_runs(&mut self) -> Result<Recovery> {
        self.write(|tx| {
            let held = collect(
                tx.prepare_cached(&format!("SELECT {RUN_COLS} FROM run WHERE status IN ('running','cancel_requested')"))?
                    .query_map([], run_row)?,
            )?;
            let now = now_iso();
            for run in &held {
                let (status, outcome) = match run.status {
                    RunStatus::CancelRequested => ("cancelled", Outcome::Cancelled { reason: "the host restarted".into() }),
                    _ => ("failed", Outcome::Failed { code: "interrupted".into(), error: "the host restarted during this run".into() }),
                };
                let (code, error) = outcome.code_and_error();
                tx.execute(
                    "UPDATE run SET status = ?2, error_code = ?3, error = ?4, lease_token = NULL, ended_at = ?5 WHERE id = ?1",
                    params![run.id, status, code, error, now],
                )?;
                after_settle(tx, run, &outcome)?;
            }
            let abandoned = tx.execute(
                "UPDATE run SET status = 'cancelled', error_code = 'interrupted', error = 'the host restarted before this chat turn started',
                   ended_at = ?1 WHERE status = 'queued' AND input_kind = 'chat'",
                [&now],
            )?;
            Ok(Recovery { interrupted: held.len() as i64, abandoned_chats: abandoned as i64 })
        })
    }

    pub fn list_runs(&self, query: RunQuery, limit: i64) -> Result<Vec<Run>> {
        let (filter, mut args): (&str, Vec<Value>) = match query {
            RunQuery::Buddy { buddy_id } => ("buddy_id = ? ORDER BY created_at DESC, id DESC", vec![buddy_id.into()]),
            RunQuery::Conversation { conversation_id } => {
                ("conversation_id = ? ORDER BY created_at DESC, id DESC", vec![conversation_id.into()])
            }
            RunQuery::Task { task_id } => ("task_id = ? ORDER BY created_at DESC, id DESC", vec![task_id.into()]),
            RunQuery::Queued => ("status = 'queued' ORDER BY ready_at, id", vec![]),
            RunQuery::Live { workspace_id } => {
                ("status IN ('running','cancel_requested') AND workspace_id = ? ORDER BY started_at", vec![workspace_id.into()])
            }
        };
        args.push(limit.into());
        let sql = format!("SELECT {RUN_COLS} FROM run WHERE {filter} LIMIT ?");
        collect(self.conn.prepare_cached(&sql)?.query_map(params_from_iter(args), run_row)?)
    }

    pub fn list_run_rows(&self, scope: ListScope, limit: i64) -> Result<Vec<RunRow>> {
        let (filter, scope) = match scope {
            ListScope::Buddy { buddy_id } => ("r.buddy_id = ?2", buddy_id),
            ListScope::Task { task_id } => ("r.task_id = ?2", task_id),
            // Live work, plus what ended in the last 12 h: after a host restart the interrupted
            // runs are already `failed`, and a live-only view made them vanish (2026-09-30).
            ListScope::Workspace { workspace_id } => (
                "r.workspace_id = ?2 AND (r.status IN ('queued','running','cancel_requested')
                   OR r.ended_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '-12 hours'))",
                workspace_id,
            ),
        };
        let requester = "CASE
            WHEN r.input_kind = 'chat' THEN 'owner'
            WHEN r.input_kind = 'post' THEN (SELECT CASE WHEN p.author_id IS NULL THEN 'owner' ELSE p.author_id END FROM post p WHERE p.id = r.input_id)
            WHEN r.input_kind = 'reply' THEN (SELECT CASE WHEN a.author_id IS NULL THEN 'owner' ELSE a.author_id END FROM post p JOIN post a ON a.id = p.answer_id WHERE p.id = r.input_id)
            ELSE NULL END";
        let sql = format!(
            "SELECT r.id, r.status, r.input_kind, r.input_id, r.ready_at, r.task_id,
                    {requester}, r.started_at, r.ended_at,
                    CASE WHEN r.status = 'queued' THEN ({WAITING_REASON_SQL}) ELSE NULL END,
                    r.conversation_id, r.error_code, r.error
             {RUN_WITH_ACTIVITY_SQL}
             WHERE {filter}
             ORDER BY r.status IN ('queued','running','cancel_requested') DESC, r.created_at DESC, r.id DESC LIMIT ?3"
        );
        collect(self.conn.prepare_cached(&sql)?.query_map(params![now_iso(), scope, limit], |r| {
            let ready_at: String = r.get(4)?;
            let waiting = r
                .get::<_, Option<String>>(9)?
                .map(|json| {
                    serde_json::from_str::<RunWaiting>(&json)
                        .map_err(|error| corrupt(CoreError::Corrupt(format!("run waiting reason {json:?}: {error}"))))
                })
                .transpose()?;
            Ok(RunRow {
                id: r.get(0)?,
                status: r.get(1)?,
                input: RunInput::from_columns(&r.get::<_, String>(2)?, r.get(3)?, &ready_at).map_err(corrupt)?,
                task_id: r.get(5)?,
                requester: r.get::<_, Option<String>>(6)?.map(|key| Actor::from_key(&key)),
                started_at: r.get(7)?,
                ended_at: r.get(8)?,
                waiting,
                conversation_id: r.get(10)?,
                error_code: r.get(11)?,
                error: r.get(12)?,
            })
        })?)
    }

    // ---- schedules ---------------------------------------------------------------------------

    pub fn put_schedule(&mut self, actor: &Actor, input: ScheduleInput) -> Result<Schedule> {
        self.write(|tx| {
            require(tx, actor, Op::WriteSchedule, &Subject::Buddy { id: input.buddy_id.clone() })?;
            let buddy = get_buddy(tx, &input.buddy_id)?;
            let next = next_run(&input.cron, &input.timezone, &now_iso())?;
            serde_json::from_str::<serde_json::Value>(&input.limits)?;
            let m = Mutation {
                actor, workspace_id: &buddy.workspace_id, buddy_id: Some(&buddy.id), task_id: input.task_id.as_deref(),
                op: "schedule.put", key: Some(&input.key),
                payload: json!({"id": input.id, "name": input.name, "cron": input.cron, "tz": input.timezone,
                    "prompt": input.prompt, "limits": input.limits, "enabled": input.enabled, "task": input.task_id}),
            };
            let id = idempotent(tx, &m, |tx| {
                let id = match &input.id {
                    None => new_id("schedule"),
                    Some(id) if get_schedule(tx, id)?.buddy_id == buddy.id => id.clone(),
                    Some(id) => return Err(CoreError::Invalid(format!("schedule {id} belongs to another buddy"))),
                };
                tx.execute(
                    "INSERT INTO schedule (id, buddy_id, workspace_id, task_id, name, cron, timezone, prompt, limits, enabled, next_run_at, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                     ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, name = excluded.name, cron = excluded.cron,
                       timezone = excluded.timezone, prompt = excluded.prompt, limits = excluded.limits,
                       enabled = excluded.enabled, next_run_at = excluded.next_run_at",
                    params![id, buddy.id, buddy.workspace_id, input.task_id, input.name, input.cron, input.timezone, input.prompt,
                        input.limits, input.enabled, next, now_iso()],
                )?;
                Ok(id)
            })?;
            get_schedule(tx, &id)
        })
    }

    pub fn list_schedules(&self, query: ListScope) -> Result<Vec<Schedule>> {
        let (column, id) = match query {
            ListScope::Buddy { buddy_id } => ("buddy_id", buddy_id),
            ListScope::Task { task_id } => ("task_id", task_id),
            ListScope::Workspace { workspace_id } => ("workspace_id", workspace_id),
        };
        let sql = format!("SELECT {SCHEDULE_COLS} FROM schedule WHERE {column} = ?1 ORDER BY name");
        collect(self.conn.prepare_cached(&sql)?.query_map([id], schedule_row)?)
    }

    /// Enqueues one `Schedule` run per due schedule and advances it to its next slot after `now`.
    /// Missed slots collapse into one run.
    pub fn due_schedules(&mut self, now: &str) -> Result<Vec<Run>> {
        self.write(|tx| {
            let due = collect(
                tx.prepare_cached(&format!(
                    "SELECT {SCHEDULE_COLS} FROM schedule WHERE enabled = 1 AND archived_at IS NULL AND next_run_at <= ?1 ORDER BY next_run_at"
                ))?
                .query_map([now], schedule_row)?,
            )?;
            due.into_iter().map(|s| enqueue_slot(tx, s, now)).collect()
        })
    }
}

fn enqueue_slot(tx: &Transaction, s: Schedule, now: &str) -> Result<Run> {
    let slot = s.next_run_at.clone().ok_or_else(|| CoreError::Corrupt(format!("due schedule {} has no slot", s.id)))?;
    let run = tx.enqueue(EnqueueInput {
        buddy_id: s.buddy_id.clone(),
        input: RunInput::Schedule { schedule_id: s.id.clone(), slot },
        conversation_id: None,
        task_id: s.task_id.clone(),
        after_run_id: None,
        deadline: None,
        config: None,
    })?;
    tx.execute("UPDATE schedule SET next_run_at = ?2 WHERE id = ?1", params![s.id, next_run(&s.cron, &s.timezone, now)?])?;
    Ok(run)
}

/// The first cron slot strictly after `after`, in the schedule's timezone, as UTC ISO.
pub fn next_run(cron: &str, timezone: &str, after: &str) -> Result<String> {
    let tz = chrono_tz::Tz::from_str(timezone).map_err(|e| CoreError::Invalid(format!("timezone {timezone:?}: {e}")))?;
    let parsed = croner::Cron::new(cron).parse().map_err(|e| CoreError::Invalid(format!("cron {cron:?}: {e}")))?;
    let after = DateTime::parse_from_rfc3339(after).map_err(|e| CoreError::Invalid(format!("time {after:?}: {e}")))?;
    let next = parsed
        .find_next_occurrence(&after.with_timezone(&tz), false)
        .map_err(|e| CoreError::Invalid(format!("cron {cron:?} has no next slot: {e}")))?;
    Ok(next.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

const SCHEDULE_COLS: &str =
    "id, buddy_id, workspace_id, task_id, name, cron, timezone, prompt, limits, enabled, next_run_at, archived_at, created_at";

fn schedule_row(r: &Row) -> rusqlite::Result<Schedule> {
    Ok(Schedule {
        id: r.get(0)?,
        buddy_id: r.get(1)?,
        workspace_id: r.get(2)?,
        task_id: r.get(3)?,
        name: r.get(4)?,
        cron: r.get(5)?,
        timezone: r.get(6)?,
        prompt: r.get(7)?,
        limits: r.get(8)?,
        enabled: r.get(9)?,
        next_run_at: r.get(10)?,
        archived_at: r.get(11)?,
        created_at: r.get(12)?,
    })
}

fn get_schedule(conn: &Connection, id: &str) -> Result<Schedule> {
    conn.prepare_cached(&format!("SELECT {SCHEDULE_COLS} FROM schedule WHERE id = ?1"))?
        .query_row([id], schedule_row)
        .optional()?
        .ok_or_else(|| CoreError::not_found("schedule", id))
}

/// The run, if `lease_token` still holds its lease.
fn leased(tx: &Connection, run_id: &str, lease_token: &str) -> Result<Run> {
    let held: bool = tx
        .prepare_cached("SELECT lease_token = ?2 AND status IN ('running','cancel_requested') FROM run WHERE id = ?1")?
        .query_row(params![run_id, lease_token], |r| r.get::<_, Option<bool>>(0))
        .optional()?
        .ok_or_else(|| CoreError::not_found("run", run_id))?
        .unwrap_or(false);
    match held {
        true => get_run(tx, run_id),
        false => Err(CoreError::LeaseLost(run_id.to_string())),
    }
}

/// A request whose run failed or was cancelled stops awaiting; a failure tells the sender.
fn after_settle(tx: &Transaction, run: &Run, outcome: &Outcome) -> Result<()> {
    match (&run.input, outcome) {
        (RunInput::Post { post_id }, Outcome::Failed { .. }) => close_request(tx, post_id, "failed", Some(&run.id)),
        (RunInput::Post { post_id }, Outcome::Cancelled { .. }) => close_request(tx, post_id, "cancelled", None),
        (RunInput::Post { .. }, Outcome::Complete { .. })
        | (RunInput::Chat { .. } | RunInput::Reply { .. } | RunInput::Schedule { .. } | RunInput::FailureNotice { .. }, _) => Ok(()),
    }
}

fn close_request(tx: &Transaction, post_id: &str, state: &str, failed_run: Option<&str>) -> Result<()> {
    let closed = tx.execute("UPDATE post SET request = ?2 WHERE id = ?1 AND request = 'awaiting'", params![post_id, state])?;
    let post = get_post(tx, post_id)?;
    // A failure notice follows the request's route, like its answer would (posts.rs `send_back`).
    match (closed, failed_run) {
        (1, Some(run_id)) => crate::posts::send_back(tx, &post, RunInput::FailureNotice { run_id: run_id.to_string() }),
        _ => Ok(()),
    }
}

impl Outcome {
    /// The (error_code, error) columns of an outcome that did not complete.
    fn code_and_error(&self) -> (Option<&str>, Option<&str>) {
        match self {
            Outcome::Complete { .. } => (None, None),
            Outcome::Failed { code, error } => (Some(code), Some(error)),
            Outcome::Cancelled { reason } => (Some("cancelled"), Some(reason)),
        }
    }
}
