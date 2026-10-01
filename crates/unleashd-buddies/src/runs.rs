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
        let (kind, input_id, key) = input.input.columns();
        let existing = self
            .prepare_cached(&format!("SELECT {RUN_COLS} FROM run WHERE input_key = ?1 ORDER BY attempt DESC LIMIT 1"))?
            .query_row([&key], run_row)
            .optional()?;
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
    pub fn claim_run(&mut self, budgets: RunBudgets) -> Result<Option<Claim>> {
        self.claim_run_at(&now_iso(), budgets)
    }

    // Pattern: lease-heartbeat (docs/patterns.md#lease-heartbeat)
    // THE CLAIM GATE, and the one place a run whose holder is gone stops being `running`. Its
    // first step ends every run whose lease ran out; nothing else sweeps held runs, at boot or
    // anywhere. A lease is a heartbeat of minutes that a live holder renews (`renew_run`); it is NOT
    // the run's deadline, which is the separate `deadline` column (24 h for an owner chat, the
    // background turn budget otherwise) enforced by the holder as max_runtime_timeout.
    // Why one gate and no boot sweep: until 2026-10-01 the lease WAS the 24 h deadline, so a run
    // left `running` only when its holder settled it or the next boot swept every held run.
    // Measured cost: a 9.5 h overnight `running` lie (2026-09-30→10-01); 14 and 10 orphaned runs
    // at 12:34Z and 14:09Z on 09-30; and the sweep also ended runs a second live backend on the
    // same store (a worktree server) still held. The reverse mistake was the 2026-09-10 incident:
    // a 600 s claim lease used as a foreground chat's deadline killed healthy chats. Keeping the
    // two values apart is what lets the lease be short and the deadline long.
    // Guards: crate tests `an_expired_lease_ends_its_run_like_a_failed_settle` and
    // `a_renewed_lease_outlives_its_first_term`; server/test/run-lease.test.ts.
    pub fn claim_run_at(&mut self, now: &str, budgets: RunBudgets) -> Result<Option<Claim>> {
        self.write(|tx| {
            expire_leases(tx, now)?;
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
            let deadline_ms = match get_run(tx, &id)?.input {
                RunInput::Chat { .. } => budgets.chat_deadline_ms,
                RunInput::Post { .. } | RunInput::Reply { .. } | RunInput::Schedule { .. } | RunInput::FailureNotice { .. } => {
                    budgets.turn_deadline_ms
                }
            };
            let token = uuid::Uuid::new_v4().to_string();
            // An enqueue-time deadline (EnqueueInput.deadline; no caller sets one today) wins.
            let claimed = tx.execute(
                "UPDATE run SET status = 'running', lease_token = ?2, lease_expires_at = ?3, started_at = ?4,
                   deadline = coalesce(deadline, ?5)
                 WHERE id = ?1 AND status = 'queued'",
                params![id, token, plus_ms(now, budgets.lease_ms)?, now, plus_ms(now, deadline_ms)?],
            )?;
            match claimed {
                1 => Ok(Some(Claim { run: get_run(tx, &id)?, lease_token: token })),
                _ => Err(CoreError::LeaseLost(id)),
            }
        })
    }

    /// The holder is alive: push its lease `lease_ms` past now. Called on the server's bridge clock
    /// (see `TurnPolicy.bridgeAlive`), never on provider progress. A lease that ran out but was not
    /// yet cleared by the claim gate renews: an adopting backend after a long gap is the holder.
    /// `lease_lost` once the gate cleared it or the run settled: the holder must stop renewing.
    pub fn renew_run(&mut self, run_id: &str, lease_token: &str, lease_ms: i64) -> Result<Run> {
        self.renew_run_at(&now_iso(), run_id, lease_token, lease_ms)
    }

    pub fn renew_run_at(&mut self, now: &str, run_id: &str, lease_token: &str, lease_ms: i64) -> Result<Run> {
        self.write(|tx| {
            leased(tx, run_id, lease_token)?;
            tx.execute("UPDATE run SET lease_expires_at = ?2 WHERE id = ?1", params![run_id, plus_ms(now, lease_ms)?])?;
            get_run(tx, run_id)
        })
    }

    /// Records the outcome of a claimed run. A run whose cancel was requested can only end cancelled.
    pub fn settle_run(&mut self, run_id: &str, lease_token: &str, outcome: Outcome) -> Result<Run> {
        self.write(|tx| {
            let run = leased(tx, run_id, lease_token)?;
            if let (RunStatus::CancelRequested, Outcome::Complete { .. } | Outcome::Failed { .. }) = (&run.status, &outcome) {
                return Err(CoreError::Invalid(format!("run {run_id} was asked to cancel; settle it as cancelled")));
            }
            end_run(tx, &run, &outcome, &now_iso())?;
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
            // Live work, plus what ended in the last 12 h: a run whose holder died is `failed`
            // (lease_expired) soon after, and a live-only view made such runs vanish (2026-09-30).
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

/// The one write of a run's outcome, for a holder's settle and the claim gate's expiry alike.
fn end_run(tx: &Transaction, run: &Run, outcome: &Outcome, now: &str) -> Result<()> {
    let (status, text, code, error) = match outcome {
        Outcome::Complete { text } => ("complete", Some(text.as_str()), None, None),
        Outcome::Failed { code, error } => ("failed", None, Some(code.as_str()), Some(error.as_str())),
        Outcome::Cancelled { reason } => ("cancelled", None, Some("cancelled"), Some(reason.as_str())),
    };
    tx.execute(
        "UPDATE run SET status = ?2, outcome = ?3, error_code = ?4, error = ?5, lease_token = NULL, ended_at = ?6 WHERE id = ?1",
        params![run.id, status, text, code, error, now],
    )?;
    after_settle(tx, run, outcome)
}

/// The claim gate's first step (see `claim_run_at`): every held run whose lease ran out ends as a
/// failed settle would, so its request stops awaiting and its sender gets a failure notice. Until
/// 2026-10-01 this was a bare UPDATE that skipped `after_settle`, leaving requests awaiting forever.
fn expire_leases(tx: &Transaction, now: &str) -> Result<()> {
    let expired = collect(
        tx.prepare_cached(&format!(
            "SELECT {RUN_COLS} FROM run WHERE status IN ('running','cancel_requested') AND lease_expires_at < ?1"
        ))?
        .query_map([now], run_row)?,
    )?;
    for run in &expired {
        let outcome = match run.status {
            RunStatus::Running => Outcome::Failed {
                code: "lease_expired".into(),
                error: "its holder stopped renewing the lease: the backend running it died or lost the turn".into(),
            },
            RunStatus::CancelRequested => {
                Outcome::Cancelled { reason: "its holder stopped renewing the lease before the stop finished".into() }
            }
            RunStatus::Queued | RunStatus::Complete | RunStatus::Failed | RunStatus::Cancelled => {
                return Err(CoreError::Corrupt(format!("run {} is {:?} but was selected as held", run.id, run.status)));
            }
        };
        end_run(tx, run, &outcome, now)?;
    }
    Ok(())
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
    match (closed, failed_run, post.author) {
        (1, Some(run_id), Actor::Buddy { id }) => tx
            .enqueue(EnqueueInput {
                buddy_id: id,
                input: RunInput::FailureNotice { run_id: run_id.to_string() },
                conversation_id: post.return_conversation_id,
                task_id: post.task_id,
                after_run_id: None,
                deadline: None,
                config: None,
            })
            .map(|_| ()),
        _ => Ok(()),
    }
}
