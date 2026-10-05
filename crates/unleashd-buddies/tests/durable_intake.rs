//! Durable intake (docs/patterns.md#durable-intake; design agent_notes/2026-09-30_pending-delivery-design.md).
//! Every acknowledged input is a row before the ack: a chat run with its text, a post's wakes in
//! the post's own transaction. These tests hold the crate half: the one-time `run` rebuild opens
//! every row shape a live file can hold, and the intake writes are atomic.

mod common;

use common::{WS, buddy, fixture, lease};
use rusqlite::{Connection, params};
use unleashd_buddies::types::*;
use unleashd_buddies::{CoreError, Store};

/// The `run` table and its indexes exactly as the build before durable intake created them
/// (main 0c6a4cd, schema.rs DDL), frozen here: the migration must open what that build wrote.
const OLD_RUN_DDL: &str = "
CREATE TABLE run (
  id TEXT PRIMARY KEY, input_key TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  input_kind TEXT NOT NULL CHECK(input_kind IN ('chat','post','reply','schedule','failure_notice')),
  input_id TEXT NOT NULL, buddy_id TEXT NOT NULL REFERENCES buddy(id), workspace_id TEXT NOT NULL,
  conversation_id TEXT, task_id TEXT, task_epoch INTEGER, after_run_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','complete','failed','cancelled')),
  lease_token TEXT, lease_expires_at TEXT, deadline TEXT,
  snapshot TEXT, outcome TEXT, error_code TEXT, error TEXT,
  ready_at TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, legacy TEXT,
  config TEXT,
  UNIQUE(input_key, attempt)) STRICT;
CREATE UNIQUE INDEX run_live_input ON run(input_key) WHERE status IN ('queued','running','cancel_requested');
CREATE UNIQUE INDEX run_conversation_slot ON run(conversation_id)
  WHERE conversation_id IS NOT NULL AND status IN ('running','cancel_requested');
CREATE INDEX run_queue ON run(ready_at, id) WHERE status = 'queued';
CREATE INDEX run_lease ON run(lease_expires_at) WHERE status IN ('running','cancel_requested');
CREATE INDEX run_active_buddy ON run(buddy_id) WHERE status IN ('running','cancel_requested');
CREATE INDEX run_buddy ON run(buddy_id, status, created_at);
CREATE INDEX run_conversation ON run(conversation_id, created_at) WHERE conversation_id IS NOT NULL;
CREATE INDEX run_task ON run(task_id, status) WHERE task_id IS NOT NULL;
CREATE INDEX run_workspace_live ON run(workspace_id, status, created_at)
  WHERE status IN ('queued','running','cancel_requested');
CREATE INDEX run_workspace_ended ON run(workspace_id, ended_at) WHERE ended_at IS NOT NULL;";

const T0: &str = "2099-01-01T00:00:00.000Z";

/// One legacy row. `lease` is the lease's end for a held row.
struct Old<'a> {
    id: &'a str,
    key: &'a str,
    kind: &'a str,
    input: &'a str,
    status: &'a str,
    conversation: Option<&'a str>,
    lease: Option<&'a str>,
    after: Option<&'a str>,
    legacy: Option<&'a str>,
    config: Option<&'a str>,
}

const fn old<'a>(id: &'a str, key: &'a str, kind: &'a str, input: &'a str, status: &'a str) -> Old<'a> {
    Old { id, key, kind, input, status, conversation: None, lease: None, after: None, legacy: None, config: None }
}

/// Swap the fresh file's `run` for the frozen pre-intake table and seed `rows` into it. `variant`
/// `"pre-0927"` also has `retry_of` and no `config` (a file from before 2026-09-27/28).
fn old_file(variant: &str, rows: &[Old]) -> (common::Fixture, String) {
    let f = fixture();
    let path = f.path.to_str().unwrap().to_string();
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF; DROP TABLE run;").unwrap();
    conn.execute_batch(OLD_RUN_DDL).unwrap();
    conn.execute("UPDATE buddy SET max_active_runs = 10", []).unwrap();
    let with_config = variant != "pre-0927";
    if !with_config {
        conn.execute_batch("ALTER TABLE run DROP COLUMN config; ALTER TABLE run ADD COLUMN retry_of TEXT;").unwrap();
    }
    for r in rows {
        let held = matches!(r.status, "running" | "cancel_requested");
        let ended = matches!(r.status, "complete" | "failed" | "cancelled");
        conn.execute(
            "INSERT INTO run (id, input_key, input_kind, input_id, buddy_id, workspace_id, conversation_id, after_run_id, status,
               lease_token, lease_expires_at, ready_at, created_at, started_at, ended_at, legacy)
             VALUES (?1, ?2, ?3, ?4, 'peer', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, ?14)",
            params![
                r.id,
                r.key,
                r.kind,
                r.input,
                WS,
                r.conversation,
                r.after,
                r.status,
                held.then(|| format!("token-{}", r.id)),
                r.lease,
                T0,
                (held || ended).then_some(T0),
                ended.then_some(T0),
                r.legacy,
            ],
        )
        .unwrap();
        if let (true, Some(config)) = (with_config, r.config) {
            conn.execute("UPDATE run SET config = ?2 WHERE id = ?1", params![r.id, config]).unwrap();
        }
    }
    (f, path)
}

fn every_shape() -> Vec<Old<'static>> {
    let lease_end = Some("2099-01-01T00:05:00.000Z");
    vec![
        Old { conversation: Some("c-queued"), ..old("chat-queued", "chat:t1", "chat", "t1", "queued") },
        Old { conversation: Some("c-kept"), lease: lease_end, ..old("chat-kept", "chat:t2", "chat", "t2", "running") },
        Old { conversation: Some("c-dead"), lease: lease_end, ..old("chat-dead", "chat:t3", "chat", "t3", "running") },
        Old { conversation: Some("c-stop"), lease: lease_end, ..old("chat-stop", "chat:t4", "chat", "t4", "cancel_requested") },
        old("chat-done", "chat:t5", "chat", "t5", "complete"),
        old("chat-failed", "chat:t6", "chat", "t6", "failed"),
        old("chat-cancelled", "chat:t7", "chat", "t7", "cancelled"),
        // The pre-2026-10-01 per-post key, queued and running.
        old("post-queued", "post:post_a", "post", "post_a", "queued"),
        // Its lease outlives the test clock: an expiry would close a request no fixture post backs.
        Old { lease: Some("2099-01-02T00:00:00.000Z"), ..old("post-running", "post:post_b", "post", "post_b", "running") },
        old("reply-queued", "reply:post_c", "reply", "post_c", "queued"),
        old("schedule-queued", "schedule:s1:2099-01-01T00:00:00.000Z", "schedule", "s1", "queued"),
        old("failure-queued", "failure:run_z", "failure_notice", "run_z", "queued"),
        Old { after: Some("post-running"), ..old("after-chain", "reply:post_d", "reply", "post_d", "queued") },
        Old { legacy: Some("{\"v33\":true}"), ..old("imported", "post:post_e", "post", "post_e", "complete") },
        Old { config: Some("{\"provider\":\"codex\",\"model\":\"m\"}"), ..old("configured", "post:post_f", "post", "post_f", "queued") },
    ]
}

fn run(s: &Store, id: &str) -> Run {
    s.get_run(id).unwrap()
}

// Product review 1 (2026-10-01) and design R1. The rebuild must OPEN a file holding every run
// shape a live store can hold, keep every row, invent no body, and leave nothing it would later
// replay: a legacy running row gets `executing_at`, so the "unexecuted → requeue" rule never
// re-runs a turn that already ran. Mutations: drop the `executing_at` backfill → `chat-dead` is
// requeued below; drop the queued-chat disposition → the open fails on the body CHECK.
#[test]
fn the_run_rebuild_keeps_every_row_and_requeues_no_legacy_running_run() {
    for variant in ["current", "pre-0927"] {
        let rows = every_shape();
        let (f, path) = old_file(variant, &rows);
        drop(f.store);
        let mut s = Store::open(&path).unwrap();
        drop(Store::open(&path).unwrap()); // idempotent: a second open does nothing

        let conn = Connection::open(&path).unwrap();
        let count: i64 = conn.query_row("SELECT count(*) FROM run", [], |r| r.get(0)).unwrap();
        assert_eq!(count, rows.len() as i64, "{variant}: every row survives");
        let dangling: i64 = conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(dangling, 0);
        for index in [
            "run_live_input",
            "run_conversation_slot",
            "run_queue",
            "run_lease",
            "run_active_buddy",
            "run_buddy",
            "run_conversation",
            "run_task",
            "run_workspace_live",
            "run_workspace_ended",
            "run_lane_position",
            "run_lane_running",
        ] {
            let present: bool =
                conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?1)", [index], |r| r.get(0)).unwrap();
            assert!(present, "{variant}: index {index} exists after the rebuild");
        }
        let retry_of: bool =
            conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('run') WHERE name = 'retry_of')", [], |r| r.get(0)).unwrap();
        assert!(!retry_of);

        // The queued chat had no text anywhere: it ends visibly, it is not given one.
        let lost = run(&s, "chat-queued");
        assert_eq!((lost.status, lost.error_code.as_deref(), lost.body.as_deref()), (RunStatus::Cancelled, Some("interrupted"), None));
        assert!(lost.error.unwrap().contains("never stored"));
        // Held rows keep status and lease, and count as executed.
        for id in ["chat-kept", "chat-dead", "chat-stop", "post-running"] {
            let held = run(&s, id);
            assert!(matches!(held.status, RunStatus::Running | RunStatus::CancelRequested), "{id}");
            assert_eq!(held.executing_at.as_deref(), Some(T0), "{id}: executed before the column existed");
            assert!(held.lease_expires_at.is_some());
        }
        for id in ["post-queued", "reply-queued", "schedule-queued", "failure-queued", "after-chain", "configured"] {
            let queued = run(&s, id);
            assert_eq!((queued.status, queued.executing_at, queued.lane), (RunStatus::Queued, None, None), "{id}");
        }
        assert_eq!(run(&s, "after-chain").after_run_id.as_deref(), Some("post-running"));
        assert!(run(&s, "imported").config.is_none());
        match variant {
            "current" => assert_eq!(run(&s, "configured").config.map(|c| c.provider), Some("codex".into())),
            _ => assert!(run(&s, "configured").config.is_none()),
        }

        // The adopting backend renews its kept run; the dead one's lease ends it at the claim gate
        // as FAILED (lease_expired), never requeued and replayed.
        s.renew_run_at("2099-01-01T00:04:00.000Z", "chat-kept", "token-chat-kept", 300_000).unwrap();
        s.claim_run_at("2099-01-01T00:06:00.000Z", lease(300_000)).unwrap();
        assert_eq!(run(&s, "chat-kept").status, RunStatus::Running);
        let dead = run(&s, "chat-dead");
        assert_eq!((dead.status, dead.error_code.as_deref()), (RunStatus::Failed, Some("lease_expired")));

        // The old-key post run still claims and settles once.
        conn.execute("UPDATE run SET ready_at = ?1 WHERE status = 'queued' AND id <> 'post-queued'", ["2100-01-01T00:00:00.000Z"])
            .unwrap();
        let claim = s.claim_run_at("2099-01-01T00:06:01.000Z", lease(300_000)).unwrap().expect("old-key post claimable");
        assert_eq!(claim.run.id, "post-queued");
        assert_eq!(claim.run.input_key, "post:post_a");
        s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
        assert_eq!(run(&s, "post-queued").status, RunStatus::Complete);
    }
}

// Design Revision 3: the build that adds the CHECK must accept every chat send. A chat run is
// written with its body by the typed API, refused without one by SQL, and loses it at settle.
#[test]
fn a_queued_chat_always_has_its_text_and_settling_clears_it() {
    let mut f = fixture();
    let s = &mut f.store;
    let chat = s
        .enqueue_chat(
            &Actor::Owner,
            ChatEnqueue {
                buddy_id: "peer".into(),
                conversation_id: "c1".into(),
                turn_id: "t1".into(),
                body: "{\"text\":\"hi\"}".into(),
                placement: Placement::Back,
            },
        )
        .unwrap();
    assert_eq!(chat.body.as_deref(), Some("{\"text\":\"hi\"}"));
    let refused = s
        .enqueue_run(
            &Actor::Owner,
            EnqueueInput {
                buddy_id: "peer".into(),
                input: RunInput::Chat { turn_id: "t2".into() },
                conversation_id: Some("c2".into()),
                task_id: None,
                after_run_id: None,
                deadline: None,
                config: None,
            },
        )
        .unwrap_err();
    assert!(matches!(refused, CoreError::Invalid(_)), "{refused}");
    let bypass = Connection::open(&f.path).unwrap().execute(
        "INSERT INTO run (id, input_key, input_kind, input_id, buddy_id, workspace_id, conversation_id, status, ready_at, created_at)
         VALUES ('run_raw', 'chat:raw', 'chat', 'raw', 'peer', ?1, 'c3', 'queued', ?2, ?2)",
        params![WS, T0],
    );
    assert!(bypass.unwrap_err().to_string().contains("CHECK"), "SQL is the backstop for a body-less chat");

    let s = &mut f.store;
    let claim = s.claim_run(lease(60_000)).unwrap().unwrap();
    assert_eq!(claim.run.id, chat.id);
    s.settle_run(&chat.id, &claim.lease_token, Outcome::Complete { text: "done".into() }).unwrap();
    assert_eq!(s.get_run(&chat.id).unwrap().body, None);
}

fn public(s: &mut Store) -> String {
    s.create_channel(
        &Actor::Owner,
        ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "general".into() },
    )
    .unwrap()
    .id
}

fn inform(body: &str, key: &str, reply_to: Option<&str>, wakes: Vec<Wake>) -> PostInput {
    PostInput {
        kind: PostKind::Inform,
        body: body.into(),
        purpose: None,
        evidence: vec![],
        reply_to_id: reply_to.map(str::to_owned),
        task_id: None,
        from_conversation_id: None,
        returns: None,
        run_config: None,
        broadcast: false,
        wakes,
        key: key.into(),
    }
}

fn wake(buddy_id: &str, kind: WakeKind) -> Wake {
    Wake { buddy_id: buddy_id.into(), kind, config: None }
}

fn seat_runs(s: &Store, buddy_id: &str) -> Vec<Run> {
    let mut runs = s.list_runs(RunQuery::Buddy { buddy_id: buddy_id.into() }, 50).unwrap();
    runs.retain(|r| matches!(r.input, RunInput::Mention { .. } | RunInput::FollowUp { .. }));
    runs.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    runs
}

// A post and the replies it asks for commit together: an acknowledged post always has its runs
// (the in-memory `posted` event lost them at every restart until 2026-10-05), and a refused wake
// rolls the post back. A replayed key wakes nobody again (review R2 of 2026-09-28).
#[test]
fn a_post_and_its_wakes_commit_together_or_not_at_all() {
    let mut f = fixture();
    let s = &mut f.store;
    let channel = public(s);
    let id = ChannelRef::Id { id: channel.clone() };
    let refused = s.write_post(&Actor::Owner, id.clone(), inform("hi @gone", "k1", None, vec![wake("gone", WakeKind::Mention)]));
    assert!(matches!(refused, Err(CoreError::Invalid(_))));
    let posts = s.list_posts(&Actor::Owner, PostQuery::Channel { channel_id: channel.clone() }, None, 10).unwrap();
    assert!(posts.posts.is_empty(), "the refused wake rolled the post back");

    let self_wake = s.write_post(&buddy("ic"), id.clone(), inform("me", "k2", None, vec![wake("ic", WakeKind::Mention)]));
    assert!(matches!(self_wake, Err(CoreError::Invalid(_))), "a post never wakes its own author");

    let written = s.write_post(&Actor::Owner, id.clone(), inform("hi", "k3", None, vec![wake("ic", WakeKind::Mention)])).unwrap();
    let runs = seat_runs(s, "ic");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].input, RunInput::Mention { post_id: written.post.id.clone() });
    assert_eq!(runs[0].lane.as_deref(), Some(format!("seat:{}:ic", written.post.id).as_str()));
    assert_eq!(runs[0].input_key, format!("mention:{}:ic", written.post.id));

    let replay = s.write_post(&Actor::Owner, id, inform("hi", "k3", None, vec![wake("ic", WakeKind::Mention)])).unwrap();
    assert!(!replay.created);
    assert_eq!(seat_runs(s, "ic").len(), 1, "a replayed key enqueues nothing");
}

// The gate is asked once, about the newest post: a seat's queued follow-ups are superseded by a
// newer one (the old in-memory `deferred` slot). A queued mention is never superseded, and a
// lane runs one input at a time in post order.
#[test]
fn a_newer_follow_up_supersedes_queued_ones_but_never_a_mention() {
    let mut f = fixture();
    let s = &mut f.store;
    let channel = public(s);
    let id = ChannelRef::Id { id: channel };
    let root = s.write_post(&Actor::Owner, id.clone(), inform("root", "r", None, vec![wake("ic", WakeKind::Mention)])).unwrap().post;
    let r = Some(root.id.as_str());
    s.write_post(&Actor::Owner, id.clone(), inform("one", "1", r, vec![wake("ic", WakeKind::FollowUp)])).unwrap();
    s.write_post(&Actor::Owner, id.clone(), inform("two", "2", r, vec![wake("ic", WakeKind::FollowUp)])).unwrap();
    let runs = seat_runs(s, "ic");
    let states: Vec<(String, RunStatus, Option<String>)> =
        runs.iter().map(|r| (r.input_key.split(':').next().unwrap().to_string(), r.status, r.error_code.clone())).collect();
    assert_eq!(
        states,
        vec![
            ("mention".into(), RunStatus::Queued, None),
            ("follow_up".into(), RunStatus::Cancelled, Some("superseded".into())),
            ("follow_up".into(), RunStatus::Queued, None),
        ]
    );
    let first = s.claim_run(lease(60_000)).unwrap().unwrap();
    assert!(matches!(first.run.input, RunInput::Mention { .. }));
    assert!(s.claim_run(lease(60_000)).unwrap().is_none(), "one reply at a time per seat");
    let rows = s.list_run_rows(ListScope::Buddy { buddy_id: "ic".into() }, 10).unwrap();
    let waiting = rows.iter().find(|r| r.status == RunStatus::Queued).unwrap().waiting.clone();
    assert_eq!(waiting, Some(RunWaiting::BehindInLane));
}

fn chat_in(conversation: &str, turn: &str, placement: Placement) -> ChatEnqueue {
    ChatEnqueue {
        buddy_id: "lead".into(),
        conversation_id: conversation.into(),
        turn_id: turn.into(),
        body: format!("{{\"text\":\"{turn}\"}}"),
        placement,
    }
}

fn turn_of(claim: &Claim) -> String {
    match &claim.run.input {
        RunInput::Chat { turn_id } => turn_id.clone(),
        other => panic!("not a chat: {other:?}"),
    }
}

/// Claim, settle, and return the turn order of every chat run in the store.
fn drain_order(s: &mut Store, now: &str) -> Vec<String> {
    let mut order = vec![];
    while let Some(claim) = s.claim_run_at(now, lease(60_000)).unwrap() {
        order.push(turn_of(&claim));
        s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    }
    order
}

// Product review 2 (2026-10-01), design R3: one writer is not FIFO. Inside a conversation's lane only
// `position` orders. Three sends written with one identical `ready_at` (mutation: order the claim
// by `ready_at, id` alone and the promote below is undone) claim in send order; a promote moves one
// first and survives a reopen from disk.
#[test]
fn a_lane_claims_in_position_order_at_one_frozen_instant() {
    let mut f = fixture();
    for turn in ["one", "two", "three"] {
        f.store.enqueue_chat(&Actor::Owner, chat_in("c", turn, Placement::Back)).unwrap();
    }
    let conn = Connection::open(&f.path).unwrap();
    // Every run at one instant, and ids reversed against send order: only position can order them.
    conn.execute("UPDATE run SET ready_at = ?1", [T0]).unwrap();
    let three = f.store.list_runs(RunQuery::Conversation { conversation_id: "c".into() }, 10).unwrap();
    let three = three.iter().find(|r| r.input == RunInput::Chat { turn_id: "three".into() }).unwrap().id.clone();
    f.store.promote_run(&Actor::Owner, &three).unwrap();
    drop(f.store);
    let mut s = Store::open(f.path.to_str().unwrap()).unwrap();
    assert_eq!(drain_order(&mut s, "2099-01-01T00:00:01.000Z"), ["three", "one", "two"]);

    // interrupt_and_send: a front placement goes ahead of everything queued.
    for turn in ["a", "b"] {
        s.enqueue_chat(&Actor::Owner, chat_in("d", turn, Placement::Back)).unwrap();
    }
    s.enqueue_chat(&Actor::Owner, chat_in("d", "now", Placement::Front)).unwrap();
    assert_eq!(drain_order(&mut s, "2099-01-01T00:00:02.000Z"), ["now", "a", "b"]);
}

// Design §3, adapted to the lease-heartbeat gate (Revision 6): a holder that dies before it marked
// the run executing leaves nothing that ran, so the claim gate puts the run back in the queue in
// its own slot, ahead of every input sent after it. A holder that died after `mark_executing` left
// a turn that ran: the gate fails it (its journal, if any, is adopted by the next backend before
// that). Mutation: requeue regardless of `executing_at` and the executed run replays here.
#[test]
fn a_dead_holder_requeues_an_unexecuted_run_and_fails_an_executed_one() {
    let mut f = fixture();
    let s = &mut f.store;
    s.enqueue_chat(&Actor::Owner, chat_in("c", "head", Placement::Back)).unwrap();
    s.enqueue_chat(&Actor::Owner, chat_in("busy", "ran", Placement::Back)).unwrap();
    let head = s.claim_run_at(T0, lease(1_000)).unwrap().unwrap();
    let ran = s.claim_run_at(T0, lease(1_000)).unwrap().unwrap();
    assert_eq!((turn_of(&head), turn_of(&ran)), ("head".into(), "ran".into()));
    s.mark_executing(&ran.run.id, &ran.lease_token, None).unwrap();
    // A send arrives behind the claimed head while its holder is alive.
    s.enqueue_chat(&Actor::Owner, chat_in("c", "later", Placement::Back)).unwrap();

    // Both holders die; the next claim after the lease ran out decides each.
    let next = s.claim_run_at("2099-01-01T00:00:05.000Z", lease(1_000)).unwrap().unwrap();
    assert_eq!(turn_of(&next), "head", "the requeued head keeps its slot ahead of the later send");
    assert_ne!(next.lease_token, head.lease_token);
    assert_eq!(s.get_run(&next.run.id).unwrap().attempt, 1, "the same run, not a retry");
    let failed = s.get_run(&ran.run.id).unwrap();
    assert_eq!((failed.status, failed.error_code.as_deref()), (RunStatus::Failed, Some("lease_expired")));
    // The dead holder's late writes are refused: it can never spawn after its run moved on.
    assert_eq!(s.mark_executing(&head.run.id, &head.lease_token, None).unwrap_err().code(), "lease_lost");
}

// Design R2 (product review 3): the read cursor follows completed handling. A channel reply's
// cursor moves in its settle's transaction, to what its prompt showed, and only when it completed;
// composing a prompt moves nothing.
#[test]
fn a_reply_marks_its_thread_read_only_when_it_settles_complete() {
    let mut f = fixture();
    let s = &mut f.store;
    let channel = public(s);
    let id = ChannelRef::Id { id: channel };
    let root = s.write_post(&Actor::Owner, id.clone(), inform("root", "r", None, vec![wake("ic", WakeKind::Mention)])).unwrap().post;
    let conn = Connection::open(&f.path).unwrap();
    let read = || -> Option<String> {
        conn.query_row("SELECT last_ord FROM thread_read WHERE reader = 'ic' AND root_id = ?1", [&root.id], |r| r.get(0)).ok()
    };
    let claim = s.claim_run(lease(60_000)).unwrap().unwrap();
    s.mark_executing(&claim.run.id, &claim.lease_token, Some(root.ord.clone())).unwrap();
    assert_eq!(read(), None, "marking executing reads nothing");
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    assert_eq!(read(), Some(root.ord.clone()));
}

// A seat busy with another turn sends its reply back to the queue, bound to that seat, so the gate
// holds it as `conversation_busy` (no holder polls with a pool slot). Never after it ran.
#[test]
fn a_reply_whose_seat_is_busy_goes_back_to_the_queue_bound_to_it() {
    let mut f = fixture();
    let s = &mut f.store;
    s.enqueue_chat(
        &Actor::Owner,
        ChatEnqueue { buddy_id: "ic".into(), ..chat_in("seat-1", "owner-typing", Placement::Back) },
    )
    .unwrap();
    let typing = s.claim_run(lease(60_000)).unwrap().unwrap();
    let channel = public(s);
    let hi = s.write_post(&Actor::Owner, ChannelRef::Id { id: channel }, inform("hi", "k", None, vec![wake("ic", WakeKind::Mention)])).unwrap().post;
    let mention = s.claim_run(lease(60_000)).unwrap().unwrap();
    assert!(matches!(s.bind_run(&mention.run.id, &mention.lease_token, "seat-1"), Err(CoreError::ConversationBusy(_))));
    s.release_run(&mention.run.id, &mention.lease_token, "seat-1").unwrap();
    assert!(s.claim_run(lease(60_000)).unwrap().is_none());
    let rows = s.list_run_rows(ListScope::Buddy { buddy_id: "ic".into() }, 10).unwrap();
    assert_eq!(rows.iter().find(|r| r.id == mention.run.id).unwrap().waiting, Some(RunWaiting::ConversationBusy));
    s.settle_run(&typing.run.id, &typing.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    let again = s.claim_run(lease(60_000)).unwrap().unwrap();
    assert_eq!(again.run.id, mention.run.id);
    assert_eq!(s.mark_executing(&again.run.id, &again.lease_token, None).unwrap_err().code(), "invalid", "a reply says what it read");
    s.mark_executing(&again.run.id, &again.lease_token, Some(hi.ord.clone())).unwrap();
    assert_eq!(s.release_run(&again.run.id, &again.lease_token, "seat-1").unwrap_err().code(), "invalid");
}
