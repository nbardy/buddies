//! Runs: the queue, leases and outcomes of every buddy turn, and schedules (whose fires are posts).
//! A run is live while queued, running or cancel_requested; the unique indexes allow one live
//! run per input key and one running run per conversation. The run table IS the durable queue of
//! a Buddy conversation: its key is `conversation_id` (decision H2), no lanes.

use crate::error::{CoreError, Result};
use crate::deliveries;
use crate::posts::{get_channel, get_post, own_channel, system_post, task_channel};
use crate::store::{Mutation, Store, collect, corrupt, get_buddy, idempotent, new_id, now_iso, require};
use crate::tasks::get_task;
use crate::types::*;
use chrono::{DateTime, Duration, Utc};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};
use serde_json::json;
use std::str::FromStr;

pub(crate) const RUN_COLS: &str = "id, input_key, attempt, input_kind, input_id, buddy_id, workspace_id, conversation_id, task_id, \
    task_epoch, after_run_id, status, deadline, lease_expires_at, outcome, error_code, error, ready_at, \
    created_at, started_at, ended_at, config, body, executing_at, through_ord";

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
// sent (types.rs `Returns`).
//
// SUCCESSOR 2026-10-06 (owner decision A, delivery design D0/D3): an answer now DOES run in the
// chat that asked, owner chats included, so a human chat's queue holds real work. What keeps the
// owner from waiting behind automation in their own chat is `owner_first`: a non-chat run (a
// delivery, or a resumed request) waits while a `chat` run (an owner message for that
// conversation) is queued. The message
// still typed behind a running turn lives in the runtime's in-memory queue and has no run yet; it
// gets one the moment the turn ends (turns/runner.ts `settleOutcome` calls processQueue BEFORE
// the settle lands), so this clause is what the claim gate sees in that window. The owner's
// messages typed while a turn runs therefore go before the returns that queued behind it.
// Guard: buddies-v2 "a worker's answer returns to the owner chat that asked …".
//
// Fix-guard (2026-10-06): a queued chat run is claimed only through the backend's in-memory chat
// ticket, so one left queued by a backend that died can never run, and an unbounded clause would
// hold every return in that conversation behind it forever. Only a chat run queued in the last
// 15 minutes counts; past that, a live owner message loses only its place ahead of returns. Step 6
// (owner messages durable at send, task_01a11013-bac6) makes queued chat runs claimable after a
// restart and can drop this bound. Guard: `an_orphaned_owner_message_stops_holding_returns`.
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
    WHEN r.conversation_id IS NULL AND r.input_kind = 'deliver' AND EXISTS (
        SELECT 1 FROM run c JOIN post cp ON cp.id = c.input_id JOIN post rp ON rp.id = r.input_id
        WHERE c.buddy_id = r.buddy_id AND c.input_kind = 'deliver' AND c.status IN ('running','cancel_requested')
          AND coalesce(cp.root_id, cp.id) = coalesce(rp.root_id, rp.id)
    ) THEN json_object('kind','conversation_busy')
    WHEN r.conversation_id IS NOT NULL AND r.input_kind <> 'chat' AND EXISTS (
        SELECT 1 FROM run c WHERE c.conversation_id = r.conversation_id
          AND c.input_kind = 'chat' AND c.status = 'queued'
          AND c.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '-15 minutes')
    ) THEN json_object('kind','owner_first')
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

pub(crate) fn run_row(r: &Row) -> rusqlite::Result<Run> {
    Ok(Run {
        id: r.get(0)?,
        input_key: r.get(1)?,
        attempt: r.get(2)?,
        input: RunInput::from_columns(&r.get::<_, String>(3)?, r.get(4)?).map_err(corrupt)?,
        buddy_id: r.get(5)?,
        workspace_id: r.get(6)?,
        conversation_id: r.get(7)?,
        task_id: r.get(8)?,
        task_epoch: r.get(9)?,
        after_run_id: r.get(10)?,
        status: r.get(11)?,
        deadline: r.get(12)?,
        lease_expires_at: r.get(13)?,
        outcome: r.get(14)?,
        error_code: r.get(15)?,
        error: r.get(16)?,
        ready_at: r.get(17)?,
        created_at: r.get(18)?,
        started_at: r.get(19)?,
        ended_at: r.get(20)?,
        // By name: the trailing columns came later, and index shifts elsewhere must not move them.
        config: r.get::<_, Option<String>>("config")?.map(|json| run_config(&json)).transpose().map_err(corrupt)?,
        body: r.get("body")?,
        executing_at: r.get("executing_at")?,
        through_ord: r.get("through_ord")?,
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

/// A run to insert: an `EnqueueInput` plus what only the crate's own producers set (a chat's
/// body). Kept off the public `EnqueueInput`, so no host write can queue a body-less chat.
pub(crate) struct NewRun {
    pub input: EnqueueInput,
    pub body: Option<String>,
}

/// Enqueue is idempotent on the input key: the key's latest attempt is returned if it exists.
pub(crate) trait Enqueue {
    fn enqueue(&self, input: EnqueueInput) -> Result<Run> {
        self.insert_run(NewRun { input, body: None })
    }
    fn insert_run(&self, run: NewRun) -> Result<Run>;
}

impl Enqueue for Connection {
    fn insert_run(&self, run: NewRun) -> Result<Run> {
        let NewRun { input, body } = run;
        let (kind, input_id, key) = input.input.columns(&input.buddy_id)?;
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
        let id = new_id("run");
        self.prepare_cached(
            "INSERT INTO run (id, input_key, input_kind, input_id, buddy_id, workspace_id, conversation_id, task_id, task_epoch,
               after_run_id, status, deadline, ready_at, created_at, config, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'queued', ?11, ?12, ?12, ?13, ?14)",
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
            now,
            input.config.as_ref().map(|c| serde_json::to_string(c).expect("run config serializes")),
            body
        ])?;
        get_run(self, &id)
    }
}

impl Store {
    /// Any run but a chat: a chat carries the owner's text and goes through `enqueue_chat`.
    pub fn enqueue_run(&mut self, actor: &Actor, input: EnqueueInput) -> Result<Run> {
        if let RunInput::Chat { .. } = input.input {
            return Err(CoreError::Invalid("a chat run carries its message: use enqueue_chat".into()));
        }
        self.write(|tx| {
            require(tx, actor, Op::EnqueueRun, &Subject::Buddy { id: input.buddy_id.clone() })?;
            tx.enqueue(input)
        })
    }

    // Pattern: durable-intake (docs/patterns.md#durable-intake)
    /// A foreground chat input, written with its text: the queued run is the owner's message, and
    /// the schema refuses one without it. Nothing reads the body yet; step 6 makes queued chat
    /// runs claimable after a restart (task_01a11013-bac6). Producers satisfy the CHECK from the
    /// first build that has it (pending-delivery design Revision 3).
    pub fn enqueue_chat(&mut self, actor: &Actor, input: ChatEnqueue) -> Result<Run> {
        self.write(|tx| {
            require(tx, actor, Op::EnqueueRun, &Subject::Buddy { id: input.buddy_id.clone() })?;
            tx.insert_run(NewRun {
                input: EnqueueInput {
                    buddy_id: input.buddy_id,
                    input: RunInput::Chat { turn_id: input.turn_id },
                    conversation_id: Some(input.conversation_id),
                    task_id: None,
                    after_run_id: None,
                    deadline: None,
                    config: None,
                },
                body: Some(input.body),
            })
        })
    }

    /// Claims the oldest ready run, or None when nothing is claimable.
    pub fn claim_run(&mut self, budgets: RunBudgets, held: &[RunHold]) -> Result<Option<Claim>> {
        self.claim_run_at(&now_iso(), budgets, held)
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
    // `held`: runs the CALLER's own live turns execute; the gate renews them first, in this same
    // transaction, so a process never expires a run it drives. The lease is compared with the WALL
    // clock, and a process frozen longer than the lease finds it lapsed at wake: macOS Maintenance
    // Sleep ran 306 s against the 300 s lease (2026-10-06 16:53Z) and the gate ended five live
    // runs 9 ms after the wake, ~230 ms before the heartbeat's renewal. A host "renew, then claim"
    // is check-then-act: the freeze lands between, and the threadpool runs the queued claim before
    // any JS. A hold whose run already ended is skipped, never resurrected (a stop is never undone).
    // Accepted: ANOTHER backend's gate on the same store still ends lapsed runs; that holder was
    // silent. Guard: `a_held_run_is_renewed_by_the_gate_before_it_can_expire`, run-lease.test.ts.
    pub fn claim_run_at(&mut self, now: &str, budgets: RunBudgets, held: &[RunHold]) -> Result<Option<Claim>> {
        self.write(|tx| {
            let until = plus_ms(now, budgets.lease_ms)?;
            for hold in held {
                tx.prepare_cached("UPDATE run SET lease_expires_at = ?3 WHERE id = ?1 AND lease_token = ?2 AND status IN ('running','cancel_requested')")?
                    .execute(params![hold.run_id, hold.lease_token, until])?;
            }
            expire_leases(tx, now, budgets.lease_ms)?;
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
                RunInput::Post { .. } | RunInput::Deliver { .. } => budgets.turn_deadline_ms,
                // The schema CHECK keeps a retired kind out of the queue.
                RunInput::Retired { input_kind, .. } => return Err(CoreError::Corrupt(format!("queued {input_kind} run {id}"))),
            };
            let token = uuid::Uuid::new_v4().to_string();
            // No `executing_at` here: the holder stamps it with `mark_executing` just before its
            // spawn. Until then it may still compose a prompt, open its conversation or resolve its
            // model, all of which a successor can redo, so a holder that dies here gets the run
            // requeued (`expire_leases`), never replayed. (W0b of durable intake, 745515f.)
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

    // Pattern: durable-intake (docs/patterns.md#durable-intake)
    /// The holder is about to spawn: from now on the run has executed, and a holder that dies is
    /// adopted from its journal or ends visibly, never requeued (the August rule: an executed input
    /// is never silently replayed). Every holder calls it as the last await before the spawn; a
    /// second call keeps the first stamp. A delivery reads its threads through its `through_ord`
    /// here (deliveries.rs `delivered`), which fences the other deliveries of the posts it shows.
    pub fn mark_executing(&mut self, run_id: &str, lease_token: &str) -> Result<Run> {
        self.write(|tx| {
            let run = leased(tx, run_id, lease_token)?;
            tx.execute("UPDATE run SET executing_at = coalesce(executing_at, ?2) WHERE id = ?1", params![run_id, now_iso()])?;
            match (&run.input, &run.executing_at) {
                (RunInput::Deliver { post_id }, None) => deliveries::delivered(tx, &run, &get_post(tx, post_id)?)?,
                (RunInput::Deliver { .. }, Some(_)) | (RunInput::Chat { .. } | RunInput::Post { .. } | RunInput::Retired { .. }, _) => {}
            }
            get_run(tx, run_id)
        })
    }

    /// Decision J (2026-10-06): a run whose config names no model runs on its provider's default,
    /// which only the host's catalog knows. The host resolves it right after the claim and records
    /// it here, before the spawn, so the run row says which model answered even after the catalog's
    /// default moves (the Wave Sim handoff, 2026-09-29: worker model ids drifted with nothing on the
    /// run to show which one ran). A model already named is never overwritten.
    pub fn record_run_model(&mut self, run_id: &str, lease_token: &str, model: &str) -> Result<Run> {
        self.write(|tx| {
            let run = leased(tx, run_id, lease_token)?;
            let config = match run.config {
                Some(RunConfig { model: None, provider, reasoning_effort }) => {
                    RunConfig { provider, model: Some(model.to_string()), reasoning_effort }
                }
                Some(RunConfig { model: Some(named), .. }) => {
                    return Err(CoreError::Invalid(format!("run {run_id} already names model {named}")));
                }
                None => return Err(CoreError::Invalid(format!("run {run_id} runs on its Buddy's profile; it has no model to record"))),
            };
            tx.execute(
                "UPDATE run SET config = ?2 WHERE id = ?1",
                params![run_id, serde_json::to_string(&config).expect("run config serializes")],
            )?;
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

    /// Binds a claimed run to the conversation the runner opened for it. That conversation is the
    /// one the run's thread delivers to from now on (subscription case 2): a request's recipient
    /// conversation, which has read the request; or a delivery's fresh conversation (a schedule's
    /// first fire, or one whose conversation was deleted).
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
                    let request = get_post(tx, post_id)?;
                    let root = request.root_id.clone().unwrap_or(request.id.clone());
                    let me = Actor::Buddy { id: run.buddy_id.clone() };
                    // A Buddy's own worker leaves the thread's subscription and mark to its spawner
                    // (deliveries.rs `from_own_worker`).
                    if request.author != me {
                        deliveries::subscribe(tx, &run.buddy_id, &root, Some(conversation_id))?;
                        deliveries::catch_up(tx, &me, &root, &request.ord)?;
                    }
                }
                RunInput::Deliver { post_id } if run.conversation_id.as_deref() != Some(conversation_id) => {
                    let post = get_post(tx, post_id)?;
                    deliveries::subscribe(tx, &run.buddy_id, post.root_id.as_deref().unwrap_or(&post.id), Some(conversation_id))?;
                }
                RunInput::Deliver { .. } | RunInput::Chat { .. } | RunInput::Retired { .. } => {}
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

    // Pattern: one-write-path (docs/patterns.md#one-write-path) — retry is a run enqueue, not a revive.
    /// Re-enqueues a failed or cancelled run's input as a NEW run on the same input key.
    ///
    /// Attempt numbering: `UNIQUE(input_key, attempt)` means one key has a chain of attempts, and
    /// `enqueue` returns the latest one. A retry is the next link, `max(attempt) + 1`; the failed
    /// run stays as history and is never reset, so its error and conversation remain readable.
    /// Only the LATEST attempt can be retried: retrying attempt 1 after attempt 2 exists would
    /// fork the chain, so it is a typed error naming the newer attempt. A live or complete run is
    /// a typed error too, never a silent no-op (the caller would believe work was restarted).
    ///
    /// The request the run answers goes back to `awaiting`. Settling the failure closed it
    /// (`close_request`) and already sent the sender its failure notice, which stands: it was true
    /// when sent. Without reopening, the retry's answer would find a closed request and the sender
    /// would never be woken with it. The answer then reaches the asker through its subscription to
    /// the request's thread, exactly as a first attempt's would.
    ///
    /// Where the retry runs (rule 5): in the SAME conversation, so it keeps what the failed attempt
    /// learned, unless it moves to another provider (a started session cannot change provider; the
    /// crate knows the provider only when the failed run carried a config, so a profile run moved
    /// onto a worker model starts fresh).
    ///
    /// `config` None keeps the failed run's model/profile; Some moves the retry to another model.
    /// Choosing a model is `EnqueueRun` authority over the run's Buddy (self or a manager), the same
    /// bar as a worker request: the requester alone may retry but cannot move a peer's model.
    /// Idempotent on `key`: a replayed call returns the retry it created.
    pub fn retry_run(&mut self, actor: &Actor, run_id: &str, config: Option<RunConfig>, key: &str) -> Result<Run> {
        self.write(|tx| {
            let run = get_run(tx, run_id)?;
            require(tx, actor, Op::RetryRun, &Subject::Run { id: run.id.clone() })?;
            if config.is_some() {
                require(tx, actor, Op::EnqueueRun, &Subject::Buddy { id: run.buddy_id.clone() })?;
            }
            let m = Mutation {
                actor,
                workspace_id: &run.workspace_id,
                buddy_id: Some(&run.buddy_id),
                task_id: run.task_id.as_deref(),
                op: "run.retry",
                payload: json!({"runId": run.id, "config": config}),
                key: Some(key),
            };
            let id = idempotent(tx, &m, |tx| {
                match run.status {
                    RunStatus::Failed | RunStatus::Cancelled => {}
                    RunStatus::Queued | RunStatus::Running | RunStatus::CancelRequested => {
                        return Err(CoreError::Invalid(format!("run {run_id} is {} and still live; cancel it first or wait", run.status.as_str())));
                    }
                    RunStatus::Complete => return Err(CoreError::Invalid(format!("run {run_id} completed; there is nothing to retry"))),
                }
                let latest: i64 = tx.query_row("SELECT max(attempt) FROM run WHERE input_key = ?1", [&run.input_key], |r| r.get(0))?;
                if latest != run.attempt {
                    return Err(CoreError::Invalid(format!("run {run_id} is attempt {}; attempt {latest} of its input exists, retry that one", run.attempt)));
                }
                let conversation_id = match (&run.input, &config, &run.config) {
                    (RunInput::Retired { input_kind, .. }, ..) => {
                        return Err(CoreError::Invalid(format!("a {input_kind} run is history; its posts are delivered as `deliver` runs now")));
                    }
                    (RunInput::Chat { .. }, ..) => run.conversation_id.clone(),
                    (RunInput::Post { .. } | RunInput::Deliver { .. }, None, _) => run.conversation_id.clone(),
                    (RunInput::Post { .. } | RunInput::Deliver { .. }, Some(new), Some(old)) if new.provider == old.provider => run.conversation_id.clone(),
                    (RunInput::Post { .. } | RunInput::Deliver { .. }, Some(_), _) => None,
                };
                if let RunInput::Post { post_id } = &run.input {
                    tx.execute("UPDATE post SET request = 'awaiting' WHERE id = ?1 AND request IN ('failed','cancelled')", [post_id])?;
                }
                next_attempt(tx, &run, conversation_id, config.as_ref().or(run.config.as_ref()))
            })?;
            get_run(tx, &id)
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

    pub fn list_run_rows(&self, reader: &Actor, scope: ListScope, limit: i64) -> Result<Vec<RunRow>> {
        let (column, scope) = match scope {
            ListScope::Buddy { buddy_id } => ("r.buddy_id", buddy_id),
            ListScope::Task { task_id } => ("r.task_id", task_id),
            ListScope::Workspace { workspace_id } => ("r.workspace_id", workspace_id),
        };
        // Live work, plus what ended in the last 12 h: a run whose holder died is `failed`
        // (lease_expired) soon after, and a live-only view made such runs vanish (2026-09-30).
        // Fix-guard: the window applies to EVERY scope. Buddy/task scopes once returned the 20
        // newest runs ever, each with its full error and input (60-95k chars, 2026-10-06);
        // guard: `run_rows_share_one_window_across_scopes` in tests/core.rs.
        let filter = format!(
            "{column} = ?2 AND (r.status IN ('queued','running','cancel_requested')
               OR r.ended_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '-12 hours'))"
        );
        // Who the run answers to: the owner for a chat; for a request or a delivery, the post's author.
        let requester = "CASE
            WHEN r.input_kind = 'chat' THEN 'owner'
            WHEN r.input_kind IN ('post','deliver') THEN (SELECT CASE WHEN p.author_id IS NULL THEN 'owner' ELSE p.author_id END FROM post p WHERE p.id = r.input_id)
            ELSE NULL END";
        // Pattern: one-definition (docs/patterns.md#one-definition). What the run is FOR, joined here
        // so a reader never opens each run (it was one `getPost` plus one `getTask` per row in
        // tool-views.ts, the F4 N+1). NULL when the post's channel is not the reader's to read (a
        // DM between others), as `readable_by` decides for every other post read.
        let purpose = format!(
            "(SELECT p.purpose FROM post p JOIN channel c ON c.id = p.channel_id
              WHERE p.id = r.input_id AND r.input_kind IN ('post','deliver') AND {})",
            crate::posts::readable_by("?4")
        );
        let sql = format!(
            "SELECT r.id, r.status, r.input_kind, r.input_id, NULL, r.task_id,
                    {requester}, r.started_at, r.ended_at,
                    CASE WHEN r.status = 'queued' THEN ({WAITING_REASON_SQL}) ELSE NULL END,
                    r.conversation_id, r.error_code, r.error,
                    {purpose}, (SELECT t.title FROM task t WHERE t.id = r.task_id)
             {RUN_WITH_ACTIVITY_SQL}
             WHERE {filter}
             ORDER BY r.status IN ('queued','running','cancel_requested') DESC, r.created_at DESC, r.id DESC LIMIT ?3"
        );
        collect(self.conn.prepare_cached(&sql)?.query_map(params![now_iso(), scope, limit, reader.key()], |r| {
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
                input: RunInput::from_columns(&r.get::<_, String>(2)?, r.get(3)?).map_err(corrupt)?,
                task_id: r.get(5)?,
                requester: r.get::<_, Option<String>>(6)?.map(|key| Actor::from_key(&key)),
                started_at: r.get(7)?,
                ended_at: r.get(8)?,
                waiting,
                conversation_id: r.get(10)?,
                error_code: r.get(11)?,
                error: r.get(12)?,
                purpose: r.get(13)?,
                task_title: r.get(14)?,
            })
        })?)
    }

    // ---- schedules ---------------------------------------------------------------------------

    pub fn put_schedule(&mut self, actor: &Actor, input: ScheduleInput) -> Result<Schedule> {
        self.write(|tx| {
            require(tx, actor, Op::WriteSchedule, &Subject::Buddy { id: input.buddy_id.clone() })?;
            let buddy = get_buddy(tx, &input.buddy_id)?;
            let next = next_run(&input.cron, &input.timezone, &now_iso())?;
            let m = Mutation {
                actor, workspace_id: &buddy.workspace_id, buddy_id: Some(&buddy.id), task_id: input.task_id.as_deref(),
                op: "schedule.put", key: Some(&input.key),
                payload: json!({"id": input.id, "name": input.name, "cron": input.cron, "tz": input.timezone,
                    "prompt": input.prompt, "enabled": input.enabled, "task": input.task_id}),
            };
            let id = idempotent(tx, &m, |tx| {
                let id = match &input.id {
                    None => new_id("schedule"),
                    Some(id) if get_schedule(tx, id)?.buddy_id == buddy.id => id.clone(),
                    Some(id) => return Err(CoreError::Invalid(format!("schedule {id} belongs to another buddy"))),
                };
                tx.execute(
                    "INSERT INTO schedule (id, buddy_id, workspace_id, task_id, name, cron, timezone, prompt, enabled, next_run_at, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                     ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, name = excluded.name, cron = excluded.cron,
                       timezone = excluded.timezone, prompt = excluded.prompt,
                       enabled = excluded.enabled, next_run_at = excluded.next_run_at",
                    params![id, buddy.id, buddy.workspace_id, input.task_id, input.name, input.cron, input.timezone, input.prompt,
                        input.enabled, next, now_iso()],
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

    /// The owner's "Run now": the schedule fires at once, a post in its thread delivered to its
    /// Buddy (decision I); its own slots are unchanged.
    pub fn fire_schedule(&mut self, actor: &Actor, schedule_id: &str) -> Result<Run> {
        self.write(|tx| {
            let schedule = get_schedule(tx, schedule_id)?;
            require(tx, actor, Op::WriteSchedule, &Subject::Buddy { id: schedule.buddy_id.clone() })?;
            fire_slot(tx, &schedule, &now_iso())
        })
    }

    /// Fires every due schedule (`fire`) and advances it to its next slot after `now`. Missed slots
    /// collapse into one fire. Returns the deliveries queued.
    pub fn due_schedules(&mut self, now: &str) -> Result<Vec<Run>> {
        self.write(|tx| {
            let due = collect(
                tx.prepare_cached(&format!(
                    "SELECT {SCHEDULE_COLS} FROM schedule WHERE enabled = 1 AND archived_at IS NULL AND next_run_at <= ?1 ORDER BY next_run_at"
                ))?
                .query_map([now], schedule_row)?,
            )?;
            due.into_iter().map(|s| fire(tx, s, now)).collect()
        })
    }
}

/// A schedule fire is a POST in the schedule's thread (owner decision I, 2026-10-06), written for
/// its Buddy and delivered to it: the first fire roots the thread (in its Task's channel, or the
/// Buddy's own DM), later fires reply there. The thread's subscribed conversation, the one that
/// handled an earlier fire, takes the next one, so a schedule continues one conversation instead
/// of opening a fresh one per slot (todo_3c1e58c6), and a slow fire's successor queues behind it
/// as `conversation_busy` instead of piling up beside it. Before: a `schedule` run kind with its own
/// job in the runner, always a fresh conversation.
fn fire(tx: &Transaction, s: Schedule, now: &str) -> Result<Run> {
    let slot = s.next_run_at.clone().ok_or_else(|| CoreError::Corrupt(format!("due schedule {} has no slot", s.id)))?;
    let run = fire_slot(tx, &s, &slot)?;
    tx.execute("UPDATE schedule SET next_run_at = ?2 WHERE id = ?1", params![s.id, next_run(&s.cron, &s.timezone, now)?])?;
    Ok(run)
}

/// One fire's post and its delivery (`fire`; the rebuild converts a queued `schedule` run with it).
pub(crate) fn fire_slot(tx: &Transaction, s: &Schedule, slot: &str) -> Result<Run> {
    let root = s.root_id.as_deref().map(|id| get_post(tx, id)).transpose()?;
    let channel = match (&root, &s.task_id) {
        (Some(root), _) => get_channel(tx, &root.channel_id)?,
        (None, Some(task_id)) => task_channel(tx, &Actor::Buddy { id: s.buddy_id.clone() }, task_id)?,
        (None, None) => own_channel(tx, &s.buddy_id)?,
    };
    let body = format!("Scheduled run \"{}\" ({}, {}), slot {slot}:\n{}", s.name, s.cron, s.timezone, s.prompt);
    let post = system_post(tx, &s.buddy_id, &channel, root.as_ref(), "schedule", &body)?;
    let thread = post.root_id.clone().unwrap_or(post.id.clone());
    tx.execute("UPDATE schedule SET root_id = coalesce(root_id, ?2) WHERE id = ?1", params![s.id, thread])?;
    let conversation = deliveries::subscription(tx, &s.buddy_id, &thread)?;
    deliveries::enqueue_delivery(tx, &s.buddy_id, &post, conversation)
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
    "id, buddy_id, workspace_id, task_id, name, cron, timezone, prompt, enabled, next_run_at, archived_at, created_at, root_id";

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
        enabled: r.get(8)?,
        next_run_at: r.get(9)?,
        archived_at: r.get(10)?,
        created_at: r.get(11)?,
        root_id: r.get(12)?,
    })
}

pub(crate) fn get_schedule(conn: &Connection, id: &str) -> Result<Schedule> {
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

/// The next attempt of `run`'s input: a new queued row on the same key, the failed one kept as
/// history. Shared by a manual retry and the one automatic resume (decision G).
pub(crate) fn next_attempt(tx: &Transaction, run: &Run, conversation_id: Option<String>, config: Option<&RunConfig>) -> Result<String> {
    let task_epoch = run.task_id.as_deref().map(|t| get_task(tx, t).map(|t| t.epoch)).transpose()?;
    let now = now_iso();
    let id = new_id("run");
    let attempt: i64 = tx.query_row("SELECT max(attempt) + 1 FROM run WHERE input_key = ?1", [&run.input_key], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO run (id, input_key, attempt, input_kind, input_id, buddy_id, workspace_id, conversation_id, task_id,
           task_epoch, status, ready_at, created_at, config, body)
         SELECT ?1, input_key, ?2, input_kind, input_id, buddy_id, workspace_id, ?3, task_id, ?4, 'queued', ?5, ?5, ?6, body
         FROM run WHERE id = ?7",
        params![
            id,
            attempt,
            conversation_id,
            task_epoch,
            now,
            config.map(|c| serde_json::to_string(c).expect("run config serializes")),
            run.id
        ],
    )?;
    Ok(id)
}

/// The claim gate's first step (see `claim_run_at`): every held run whose lease ran out ends as a
/// failed settle would, so its request stops awaiting and its sender gets a failure notice. Until
/// 2026-10-01 this was a bare UPDATE that skipped `after_settle`, leaving requests awaiting forever.
///
/// First it clamps every held lease to at most one heartbeat (`lease_ms`) from now. A current
/// holder never has a longer one (claim and renew both write now + lease_ms), so the clamp only
/// touches leases written by an older build, which made the lease the 24 h deadline. On 2026-10-05
/// four cancelled worker runs claimed with such leases sat in `cancel_requested` with no process for
/// 1.5 h after their cancel, filled the Buddy's pool (5/5) and would have queued its work until the
/// next day. Guard: crate test `a_lease_longer_than_one_heartbeat_ends_one_heartbeat_later`.
///
/// Pattern: durable-intake (docs/patterns.md#durable-intake). A run its holder never marked
/// executing has not run: it goes back to the queue (its conversation binding and a delivery's
/// `through_ord` kept), so the input is neither lost nor reported failed. This is the boot rule
/// "`executing_at` NULL → requeue", placed in this gate because the gate is the one place a dead
/// holder's run changes (Pattern: lease-heartbeat: no boot sweep, a second live backend may hold
/// runs). A stop requested before anything ran is not requeued: it ends cancelled below through
/// `end_run`, so its request closes. Guard: `a_dead_holder_requeues_an_unexecuted_run_and_fails_an_executed_one`.
fn expire_leases(tx: &Transaction, now: &str, lease_ms: i64) -> Result<()> {
    tx.prepare_cached(
        "UPDATE run SET lease_expires_at = ?1 WHERE status IN ('running','cancel_requested') AND lease_expires_at > ?1",
    )?
    .execute([plus_ms(now, lease_ms)?])?;
    // The `status IN (...)` term repeats `run_lease`'s partial-index condition so the planner can
    // use it (a bare `status = 'running'` scanned the table; guard: query_plan.rs). A chat run with
    // no stored text (only a pre-rebuild row could be one) cannot go back to the queue: the schema
    // refuses it, and that refusal would fail EVERY claim. It ends below like any held run.
    tx.prepare_cached(
        "UPDATE run SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, started_at = NULL, deadline = NULL
         WHERE status IN ('running','cancel_requested') AND lease_expires_at < ?1
           AND status = 'running' AND executing_at IS NULL AND (input_kind <> 'chat' OR body IS NOT NULL)",
    )?
    .execute([now])?;
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

/// A request whose run failed or was cancelled stops awaiting; a failure tells the sender, unless
/// it is the first death of an executed run (decision G).
fn after_settle(tx: &Transaction, run: &Run, outcome: &Outcome) -> Result<()> {
    match (&run.input, outcome) {
        (RunInput::Post { post_id }, Outcome::Failed { code, .. }) if code == "lease_expired" && !resumed_before(tx, run)? => {
            resume(tx, run, post_id)
        }
        (RunInput::Post { post_id }, Outcome::Failed { code, error }) => close_request(tx, post_id, "failed", Some((run, code, error))),
        (RunInput::Post { post_id }, Outcome::Cancelled { .. }) => close_request(tx, post_id, "cancelled", None),
        (RunInput::Post { .. }, Outcome::Complete { .. })
        | (RunInput::Chat { .. } | RunInput::Deliver { .. } | RunInput::Retired { .. }, _) => Ok(()),
    }
}

fn resumed_before(tx: &Transaction, run: &Run) -> Result<bool> {
    Ok(tx
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM run WHERE input_key = ?1 AND error_code = 'lease_expired' AND id <> ?2)")?
        .query_row(params![run.input_key, run.id], |r| r.get(0))?)
}

/// Decision G (owner, 2026-10-06): a request whose run had started and whose holder then died (a
/// backend restart killed the worker; `lease_expired`) continues ONCE, in the SAME conversation,
/// so it keeps everything the turn had done and read; the runner tells it that it is resuming
/// (runner.ts `requestJob`). The request stays awaiting and the asker hears nothing yet. A second
/// death ends it with the failure post. An explicit stop is never undone: a stopped run whose
/// holder died ends `cancelled`, which never reaches here. A run that never executed is not a
/// death at all: the claim gate requeued it (`expire_leases`).
/// Why: on 2026-10-06 workers killed by restarts ended `lease_expired` and their askers had to
/// notice and `runs retry` by hand (ceo-tooling-feedback-triage). Guard:
/// `a_request_whose_holder_died_resumes_once_in_its_conversation_then_fails`.
fn resume(tx: &Transaction, run: &Run, post_id: &str) -> Result<()> {
    match get_post(tx, post_id)?.request {
        RequestState::Awaiting => next_attempt(tx, run, run.conversation_id.clone(), run.config.as_ref()).map(|_| ()),
        // Answered (or closed) before the holder died: nothing is owed.
        RequestState::None | RequestState::Answered { .. } | RequestState::Cancelled | RequestState::Failed => Ok(()),
    }
}

/// Closes an awaiting request. A failure is told as a `run_failed` post by the recipient in the
/// request's thread (decision: the failure notice is a post), which the asker's subscription
/// delivers like the answer would have been. It replaced the `failure_notice` run kind.
fn close_request(tx: &Transaction, post_id: &str, state: &str, failed: Option<(&Run, &str, &str)>) -> Result<()> {
    let closed = tx.execute("UPDATE post SET request = ?2 WHERE id = ?1 AND request = 'awaiting'", params![post_id, state])?;
    match (closed, failed) {
        (1, Some((run, code, error))) => {
            let request = get_post(tx, post_id)?;
            let channel = get_channel(tx, &request.channel_id)?;
            let body = format!(
                "The run {} for this request failed ({}): {}. The request is closed as failed. Inspect its effects before asking again; if it is safe to repeat, runs {{kind:\"retry\", runId:\"{}\", key}} re-runs it (optionally on another worker model) and reopens the request.",
                run.id, code, error, run.id
            );
            let notice = system_post(tx, &run.buddy_id, &channel, Some(&request), "run_failed", &body)?;
            match request.author.buddy_id() == Some(run.buddy_id.as_str()) {
                // A worker the Buddy spawned for itself: its spawner hears of the failure.
                true => deliveries::deliver_to_spawner(tx, &run.buddy_id, &notice),
                false => Ok(()),
            }
        }
        _ => Ok(()),
    }
}
