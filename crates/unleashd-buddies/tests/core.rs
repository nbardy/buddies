mod common;

use common::{WS, buddy, fixture, lease};
use chrono::DateTime;
use std::sync::{Arc, Barrier};
use unleashd_buddies::types::*;
use unleashd_buddies::{CoreError, Store};

fn soul(buddy_id: &str) -> DocRef {
    DocRef { buddy_id: buddy_id.into(), scope: DocScope::Buddy, kind: DocKind::Working, name: String::new() }
}

fn write(buddy_id: &str, content: &str, base: i64, key: &str) -> DocWrite {
    DocWrite { doc: soul(buddy_id), content: content.into(), base_revision: base, reason: "test".into(), key: key.into() }
}

fn dm(a: &str, b: &str) -> ChannelRef {
    ChannelRef::Direct { members: vec![buddy(a), buddy(b)] }
}

fn request(body: &str, key: &str) -> PostInput {
    PostInput {
        kind: PostKind::Request,
        body: body.into(),
        purpose: None,
        evidence: vec![],
        reply_to_id: None,
        task_id: None,
        from_conversation_id: Some("conv-sender".into()),
        mentions: vec![],
        run_config: None,
        broadcast: false,
        key: key.into(),
    }
}

fn chat(buddy_id: &str, turn: &str, conversation: &str) -> ChatEnqueue {
    ChatEnqueue { buddy_id: buddy_id.into(), conversation_id: conversation.into(), turn_id: turn.into(), body: "{}".into() }
}

fn answer(request_id: &str, body: &str, key: &str) -> AnswerInput {
    AnswerInput { request_id: request_id.into(), body: body.into(), evidence: vec![], from_conversation_id: None, key: key.into() }
}

/// Claims the next run and marks it executing, as every holder does right before its spawn.
fn claim_executing(s: &mut Store, at: &str, budgets: RunBudgets) -> Claim {
    let claim = s.claim_run_at(at, budgets, &[]).unwrap().expect("a claimable run");
    s.mark_executing(&claim.run.id, &claim.lease_token).unwrap();
    claim
}

#[test]
fn authorize_is_owner_self_or_transitive_manager() {
    let f = fixture();
    let s = &f.store;
    let on = |id: &str| Subject::Buddy { id: id.into() };
    let allowed = |actor: &Actor, op: Op, subject: &Subject| s.authorize(actor, op, subject).unwrap() == Decision::Allowed;

    assert!(allowed(&Actor::Owner, Op::Admin, &Subject::Owner));
    assert!(allowed(&buddy("ic"), Op::WriteDoc, &on("ic")), "self");
    assert!(allowed(&buddy("lead"), Op::WriteDoc, &on("ic")), "manager of a manager");
    assert!(!allowed(&buddy("ic"), Op::WriteDoc, &on("lead")), "reports do not manage upward");
    assert!(!allowed(&buddy("peer"), Op::WriteDoc, &on("mid")), "peers are not managers");
    assert!(!allowed(&buddy("peer"), Op::Post, &on("mid")), "posts go to channels, not to buddies");
    assert!(!allowed(&buddy("lead"), Op::Admin, &Subject::Owner), "admin is owner only");
    assert!(!allowed(&buddy("gone"), Op::CreateChannel, &Subject::Owner), "archived buddies are denied");
    assert!(!allowed(&buddy("mid"), Op::WriteDoc, &Subject::Owner));
}

#[test]
fn channel_access_is_membership_for_direct_and_open_for_public_and_task() {
    let mut f = fixture();
    let s = &mut f.store;
    let direct = s.open_channel(&buddy("mid"), dm("mid", "ic")).unwrap();
    let public = s
        .create_channel(
            &buddy("ic"),
            ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "c".into() },
        )
        .unwrap();
    let task = s
        .upsert_task(
            &buddy("ic"),
            TaskWrite::Create { owner_id: "ic".into(), parent_id: None, title: "t".into(), done_criteria: "d".into(), key: "t".into() },
        )
        .unwrap();
    let task = s.open_channel(&buddy("peer"), ChannelRef::Task { task_id: task.id }).unwrap();
    let allowed = |s: &Store, actor: &Actor, op: Op, channel: &Channel| {
        s.authorize(actor, op, &Subject::Channel { id: channel.id.clone() }).unwrap() == Decision::Allowed
    };
    for op in [Op::Post, Op::ReadChannel] {
        assert!(allowed(s, &buddy("ic"), op, &direct) && allowed(s, &Actor::Owner, op, &direct));
        assert!(!allowed(s, &buddy("lead"), op, &direct), "a manager is not a member of its reports' direct channels");
        assert!(allowed(s, &buddy("peer"), op, &public) && allowed(s, &buddy("peer"), op, &task));
        assert!(!allowed(s, &buddy("gone"), op, &public), "archived buddies are denied");
    }
    let read = s.list_posts(&buddy("peer"), PostQuery::Channel { channel_id: direct.id.clone() }, None, 10).unwrap_err();
    assert!(matches!(read, CoreError::Denied(_)), "{read}");
    let wrote = s.post(&buddy("peer"), ChannelRef::Id { id: direct.id.clone() }, request("hi", "k")).unwrap_err();
    assert!(matches!(wrote, CoreError::Denied(_)), "{wrote}");
    // Opening someone else's direct channel is denied, and the attempt leaves no channel behind.
    let opened = s.post(&buddy("peer"), dm("lead", "ic"), request("hi", "k2")).unwrap_err();
    assert!(matches!(opened, CoreError::Denied(_)), "{opened}");
    let conn = rusqlite::Connection::open(&f.path).unwrap();
    assert_eq!(conn.query_row("SELECT count(*) FROM channel WHERE kind = 'direct'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn one_direct_channel_per_member_set_even_under_a_race() {
    let f = fixture();
    let path = f.path.to_str().unwrap().to_string();
    let mut s = Store::open(&path).unwrap();
    let a = s.open_channel(&buddy("mid"), dm("mid", "ic")).unwrap();
    let members = ChannelRef::Direct { members: vec![buddy("ic"), buddy("mid"), buddy("ic")] };
    assert_eq!(s.open_channel(&buddy("ic"), members).unwrap().id, a.id, "order and duplicates do not make a new channel");
    assert_ne!(s.open_channel(&Actor::Owner, ChannelRef::Direct { members: vec![Actor::Owner, buddy("ic")] }).unwrap().id, a.id);

    for round in 0..10 {
        let pair = ["lead", "peer"];
        let barrier = Arc::new(Barrier::new(2));
        let posts: Vec<Post> = (0..2)
            .map(|i| {
                let (barrier, path) = (barrier.clone(), path.clone());
                std::thread::spawn(move || {
                    let mut store = Store::open(&path).unwrap();
                    barrier.wait();
                    let input = PostInput { kind: PostKind::Inform, ..request("hi", &format!("race-{round}-{i}")) };
                    store.post(&buddy(pair[i]), dm(pair[0], pair[1]), input).unwrap()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect();
        assert_eq!(posts[0].channel_id, posts[1].channel_id, "round {round}: both posts land in one channel");
    }
    let conn = rusqlite::Connection::open(&f.path).unwrap();
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(count("SELECT count(*) FROM channel WHERE kind = 'direct' AND member_key = 'lead,peer'"), 1);
    assert_eq!(count("SELECT count(*) FROM channel_member WHERE channel_id = (SELECT id FROM channel WHERE member_key = 'lead,peer')"), 2);
}

#[test]
fn functions_enforce_authorize() {
    let mut f = fixture();
    let err = f.store.write_doc(&buddy("peer"), write("mid", "x", 0, "k")).unwrap_err();
    assert!(matches!(err, CoreError::Denied(_)), "{err}");
    f.store.write_doc(&buddy("lead"), write("ic", "from my manager's manager", 0, "k")).unwrap();
}

#[test]
fn write_doc_is_compare_and_swap_and_keeps_every_revision() {
    let mut f = fixture();
    let s = &mut f.store;
    let first = s.write_doc(&buddy("ic"), write("ic", "one", 0, "a")).unwrap();
    assert_eq!(first.revision, 1);
    let stale = s.write_doc(&buddy("ic"), write("ic", "lost update", 0, "b")).unwrap_err();
    assert!(matches!(stale, CoreError::RevisionConflict { expected: 0, current: 1 }), "{stale}");
    let second = s.write_doc(&buddy("ic"), write("ic", "two", 1, "c")).unwrap();
    assert_eq!((second.revision, second.content.as_str()), (2, "two"));

    let revisions = s.doc_revisions(&buddy("ic"), &second.id).unwrap();
    assert_eq!(revisions.iter().map(|r| r.content.as_str()).collect::<Vec<_>>(), ["one", "two"]);
    for r in &revisions {
        assert_eq!(r.sha256, unleashd_buddies::store::sha256_hex(r.content.as_bytes()));
    }
}

// 2026-09-26: memory scoped per chat left 519 copies and new chats opened empty. A memory kind
// has one address, the Buddy; any other scope is refused, never silently stored as a second copy.
#[test]
fn memory_kinds_are_refused_outside_buddy_scope() {
    let mut f = fixture();
    let s = &mut f.store;
    let workspace = DocScope::Workspace { workspace_id: WS.into() };
    for kind in [DocKind::Soul, DocKind::Working, DocKind::LongTerm] {
        let doc = DocRef { scope: workspace.clone(), kind, ..soul("ic") };
        let err = s.write_doc(&buddy("ic"), DocWrite { doc: doc.clone(), ..write("ic", "x", 0, kind.as_str()) }).unwrap_err();
        assert!(matches!(err, CoreError::Invalid(_)), "{err}");
        assert!(matches!(s.read_doc(&buddy("ic"), doc).unwrap_err(), CoreError::Invalid(_)));
    }
    let shared = DocRef { scope: workspace, kind: DocKind::Shared, name: "plan".into(), ..soul("ic") };
    s.write_doc(&buddy("ic"), DocWrite { doc: shared, ..write("ic", "x", 0, "shared") }).unwrap();
}

#[test]
fn upsert_task_is_compare_and_swap() {
    let mut f = fixture();
    let s = &mut f.store;
    let task = s
        .upsert_task(
            &buddy("mid"),
            TaskWrite::Create { owner_id: "ic".into(), parent_id: None, title: "t".into(), done_criteria: "d".into(), key: "c".into() },
        )
        .unwrap();
    let update = |base: i64, key: &str| TaskWrite::Update {
        task_id: task.id.clone(),
        base_revision: base,
        key: key.into(),
        changes: TaskChanges { status: Some(TaskStatus::InProgress), ..Default::default() },
    };
    assert_eq!(s.upsert_task(&buddy("ic"), update(1, "u1")).unwrap().revision, 2);
    let stale = s.upsert_task(&buddy("ic"), update(1, "u2")).unwrap_err();
    assert!(matches!(stale, CoreError::RevisionConflict { expected: 1, current: 2 }), "{stale}");
    let blocked = TaskWrite::Update {
        task_id: task.id.clone(),
        base_revision: 2,
        key: "u3".into(),
        changes: TaskChanges { status: Some(TaskStatus::Blocked), ..Default::default() },
    };
    assert!(matches!(s.upsert_task(&buddy("ic"), blocked).unwrap_err(), CoreError::Invalid(_)), "blocked needs a reason");
}

// Workspace-home pins ride the ordinary task update: same compare-and-swap, same `write_task`
// authority. Only a top-level task can carry one (a todo pinned to Home would be an orphan card).
#[test]
fn pin_is_an_ordinary_task_update_on_top_level_tasks_only() {
    let mut f = fixture();
    let s = &mut f.store;
    let make = |s: &mut unleashd_buddies::Store, parent: Option<String>, key: &str| {
        s.upsert_task(
            &buddy("mid"),
            TaskWrite::Create { owner_id: "ic".into(), parent_id: parent, title: "t".into(), done_criteria: "d".into(), key: key.into() },
        )
        .unwrap()
    };
    let top = make(s, None, "c1");
    let todo = make(s, Some(top.id.clone()), "c2");
    assert_eq!(top.pin, 0);
    let pin = |task: &Task, actor: &str, pin: i64, key: &str| {
        (
            actor.to_string(),
            TaskWrite::Update {
                task_id: task.id.clone(),
                base_revision: task.revision,
                key: key.into(),
                changes: TaskChanges { pin: Some(pin), ..Default::default() },
            },
        )
    };
    let (actor, write) = pin(&top, "ic", 3, "p1");
    let pinned = s.upsert_task(&buddy(&actor), write).unwrap();
    assert_eq!((pinned.pin, pinned.revision), (3, 2));
    // A stale writer is refused like any update; a peer outside the owner's line has no authority.
    let (actor, write) = pin(&top, "ic", 4, "p2");
    assert!(matches!(s.upsert_task(&buddy(&actor), write).unwrap_err(), CoreError::RevisionConflict { .. }));
    let (actor, write) = pin(&pinned, "peer", 4, "p3");
    assert!(s.upsert_task(&buddy(&actor), write).is_err(), "peer must not pin someone else's task");
    let (actor, write) = pin(&todo, "ic", 1, "p4");
    assert!(matches!(s.upsert_task(&buddy(&actor), write).unwrap_err(), CoreError::Invalid(_)), "a todo cannot be pinned");
    // The pin is part of the idempotent payload: a retried pin replays (no conflict on its now-stale
    // base), and the same key reused for a DIFFERENT pin is refused instead of replaying the old one.
    let (actor, write) = pin(&top, "ic", 3, "p1");
    assert_eq!(s.upsert_task(&buddy(&actor), write).unwrap().revision, 2, "a retried pin replays");
    let (actor, write) = pin(&top, "ic", 7, "p1");
    assert!(matches!(s.upsert_task(&buddy(&actor), write).unwrap_err(), CoreError::IdempotencyConflict(_)));
    let (actor, write) = pin(&pinned, "ic", 0, "p5");
    assert_eq!(s.upsert_task(&buddy(&actor), write).unwrap().pin, 0, "0 unpins");
}

// Home's reorder is two ordinary pin updates; the order must read back from a fresh store (the
// phone and the Buddies read the file, not the writer's memory).
#[test]
fn pin_order_persists_across_reopen() {
    let mut f = fixture();
    let make = |s: &mut unleashd_buddies::Store, title: &str| {
        s.upsert_task(
            &Actor::Owner,
            TaskWrite::Create { owner_id: "ic".into(), parent_id: None, title: title.into(), done_criteria: "d".into(), key: title.into() },
        )
        .unwrap()
    };
    let set = |s: &mut unleashd_buddies::Store, task: &Task, pin: i64| {
        let changes = TaskChanges { pin: Some(pin), ..Default::default() };
        let key = format!("{}-{pin}-{}", task.title, task.revision);
        s.upsert_task(&Actor::Owner, TaskWrite::Update { task_id: task.id.clone(), base_revision: task.revision, changes, key }).unwrap()
    };
    let (a, b) = (make(&mut f.store, "a"), make(&mut f.store, "b"));
    let (a, b) = (set(&mut f.store, &a, 1), set(&mut f.store, &b, 2));
    set(&mut f.store, &b, 1);
    set(&mut f.store, &a, 2);
    let reopened = unleashd_buddies::Store::open(f.path.to_str().unwrap()).unwrap();
    let workspace_id = a.workspace_id.clone();
    let mut pins: Vec<(String, i64)> = reopened
        .list_tasks(TaskQuery::Workspace { workspace_id })
        .unwrap()
        .into_iter()
        .filter(|task| task.pin > 0)
        .map(|task| (task.title, task.pin))
        .collect();
    pins.sort_by_key(|(_, pin)| *pin);
    assert_eq!(pins, [("b".to_string(), 1), ("a".to_string(), 2)]);
}

#[test]
fn idempotency_key_replays_and_rejects_a_changed_payload() {
    let mut f = fixture();
    let s = &mut f.store;
    let a = s.write_post(&buddy("peer"), dm("peer", "mid"), request("hello", "k1")).unwrap();
    let again = s.write_post(&buddy("peer"), dm("peer", "mid"), request("hello", "k1")).unwrap();
    assert!(a.created && !again.created, "the host announces only the write that created the post");
    let (a, again) = (a.post, again.post);
    assert_eq!(a.id, again.id, "a replay returns the first result");
    let page = s.list_posts(&buddy("mid"), PostQuery::Channel { channel_id: a.channel_id.clone() }, None, 10).unwrap();
    assert_eq!(page.posts.len(), 1, "a replay writes nothing");
    assert_eq!(s.list_runs(RunQuery::Buddy { buddy_id: "mid".into() }, 10).unwrap().len(), 1, "and queues no second run");
    let changed = s.post(&buddy("peer"), dm("peer", "mid"), request("a different body", "k1")).unwrap_err();
    assert!(matches!(changed, CoreError::IdempotencyConflict(_)), "{changed}");
}

#[test]
fn two_claimers_one_winner() {
    let f = fixture();
    let path = f.path.to_str().unwrap().to_string();
    let mut setup = Store::open(&path).unwrap();
    for round in 0..25 {
        setup.enqueue_chat(&Actor::Owner, chat("peer", &format!("turn-{round}"), &format!("conv-{round}"))).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let winners: Vec<Option<Claim>> = (0..2)
            .map(|_| {
                let (barrier, path) = (barrier.clone(), path.clone());
                std::thread::spawn(move || {
                    let mut store = Store::open(&path).unwrap();
                    barrier.wait();
                    store.claim_run(lease(60_000), &[]).unwrap()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect();
        let won: Vec<&Claim> = winners.iter().flatten().collect();
        assert_eq!(won.len(), 1, "round {round}: exactly one claimer wins");
        setup.settle_run(&won[0].run.id, &won[0].lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    }
}

#[test]
fn a_lease_is_the_only_way_to_settle_and_it_expires() {
    let mut f = fixture();
    let s = &mut f.store;
    s.enqueue_chat(&Actor::Owner, chat("peer", "t1", "c1")).unwrap();
    let claim = claim_executing(s, "2099-01-01T00:00:00.000Z", lease(1_000));
    let wrong = s.settle_run(&claim.run.id, "not-the-token", Outcome::Complete { text: "x".into() }).unwrap_err();
    assert!(matches!(wrong, CoreError::LeaseLost(_)));
    // The next claim after expiry fails the abandoned run instead of leaving it running forever.
    assert!(s.claim_run_at("2099-01-01T00:00:05.000Z", lease(1_000), &[]).unwrap().is_none());
    let expired = s.get_run(&claim.run.id).unwrap();
    assert_eq!((expired.status, expired.error_code.as_deref()), (RunStatus::Failed, Some("lease_expired")));
    assert!(matches!(
        s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "late".into() }),
        Err(CoreError::LeaseLost(_))
    ));
}

#[test]
fn one_running_run_per_conversation() {
    let mut f = fixture();
    let s = &mut f.store;
    s.enqueue_chat(&Actor::Owner, chat("peer", "t1", "same")).unwrap();
    s.enqueue_chat(&Actor::Owner, chat("peer", "t2", "same")).unwrap();
    let first = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_none(), "the conversation is busy");
    s.settle_run(&first.run.id, &first.lease_token, Outcome::Complete { text: "done".into() }).unwrap();
    assert_eq!(s.claim_run(lease(60_000), &[]).unwrap().unwrap().run.input, RunInput::Chat { turn_id: "t2".into() });
}

#[test]
fn request_answer_round_trip_and_failure_notice() {
    let mut f = fixture();
    let s = &mut f.store;
    let asked = s.post(&buddy("mid"), dm("mid", "ic"), request("please do X", "r1")).unwrap();
    assert_eq!(asked.request, RequestState::Awaiting);
    assert_eq!(s.inbox(&buddy("ic"), WS).unwrap().requests.len(), 1);
    assert_eq!(s.inbox(&buddy("mid"), WS).unwrap().requests.len(), 0, "the asker owes nothing");
    assert_eq!(s.inbox(&buddy("mid"), WS).unwrap().waiting_on.len(), 1);
    let unread = |s: &Store, who: &str| s.inbox(&buddy(who), WS).unwrap().channels.iter().map(|c| c.unread).sum::<i64>();
    assert_eq!((unread(s, "ic"), unread(s, "mid")), (1, 0), "a direct channel has read cursors like any channel");

    let claim = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert_eq!((claim.run.buddy_id.as_str(), &claim.run.input), ("ic", &RunInput::Post { post_id: asked.id.clone() }));
    let answer = s
        .answer(
            &buddy("ic"),
            AnswerInput { request_id: asked.id.clone(), body: "done".into(), evidence: vec!["a.md".into()], from_conversation_id: None, key: "rep".into() },
        )
        .unwrap();
    assert_eq!(
        (answer.channel_id.as_str(), answer.reply_to_id.as_deref(), answer.root_id.as_deref(), &answer.author),
        (asked.channel_id.as_str(), Some(asked.id.as_str()), Some(asked.id.as_str()), &buddy("ic")),
        "the answer is a reply post in the request's thread"
    );
    assert_eq!(s.get_post(&buddy("mid"), &asked.id).unwrap().request, RequestState::Answered { answer_id: answer.id.clone() });
    let again = s.answer(&buddy("ic"), answer_input(&asked.id, "twice", "rep2"));
    assert!(matches!(again, Err(CoreError::Invalid(_))), "a request is answered once");
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    let back = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert_eq!(
        (back.run.buddy_id.as_str(), back.run.conversation_id.as_deref(), &back.run.input),
        ("mid", Some("conv-sender"), &RunInput::Deliver { post_id: answer.id.clone() }),
        "the answer is delivered to the conversation that posted the request"
    );
    s.settle_run(&back.run.id, &back.lease_token, Outcome::Complete { text: "read".into() }).unwrap();

    s.mark_read(&buddy("ic"), &asked.channel_id, &answer.id).unwrap();
    s.mark_read(&buddy("ic"), &asked.channel_id, &asked.id).unwrap();
    assert_eq!(unread(s, "ic"), 0, "a cursor only moves forward");

    let failing = s.post(&buddy("mid"), dm("mid", "ic"), request("will fail", "r2")).unwrap();
    let claim = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Failed { code: "provider_error".into(), error: "boom".into() }).unwrap();
    assert_eq!(s.get_post(&buddy("mid"), &failing.id).unwrap().request, RequestState::Failed);
    let notice = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    let RunInput::Deliver { post_id } = &notice.run.input else { panic!("{:?}", notice.run.input) };
    let posted = s.get_post(&buddy("mid"), post_id).unwrap();
    assert_eq!(
        (posted.purpose.as_deref(), &posted.author, posted.reply_to_id.as_deref(), notice.run.conversation_id.as_deref()),
        (Some("run_failed"), &buddy("ic"), Some(failing.id.as_str()), Some("conv-sender")),
        "the failure notice is the recipient's post in the request's thread, delivered like an answer"
    );
    assert!(posted.body.contains("provider_error") && posted.body.contains(&claim.run.id), "{}", posted.body);
}

// Pattern: fix-guards (docs/patterns.md#fix-guards). 2026-10-01: answers to requests sent from an
// owner chat each queued a no-op `reply` run (`conversation_busy`, up to 2h44m). A run must be
// real work: a request with no subscribed conversation behind it (the owner's, from the app) leaves
// nothing in the run queue when it is answered or fails; the owner reads both in the thread.
#[test]
fn a_request_from_no_conversation_starts_no_run_for_its_answer_or_failure() {
    let mut f = fixture();
    let s = &mut f.store;
    let to_ic = || ChannelRef::Direct { members: vec![Actor::Owner, buddy("ic")] };
    let from_app = |body: &str, key: &str| PostInput { from_conversation_id: None, ..request(body, key) };
    let asked = s.post(&Actor::Owner, to_ic(), from_app("please do X", "r1")).unwrap();
    let claim = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    let answer = s.answer(&buddy("ic"), answer_input(&asked.id, "done", "a")).unwrap();
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    assert_eq!(s.get_post(&Actor::Owner, &asked.id).unwrap().request, RequestState::Answered { answer_id: answer.id });

    let failing = s.post(&Actor::Owner, to_ic(), from_app("will fail", "r2")).unwrap();
    let claim = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Failed { code: "provider_error".into(), error: "boom".into() }).unwrap();
    assert_eq!(s.get_post(&Actor::Owner, &failing.id).unwrap().request, RequestState::Failed);
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_none(), "neither the answer nor the failure queued a run");
    let notices = s.list_posts(&Actor::Owner, PostQuery::Thread { root_id: failing.id.clone() }, None, 5).unwrap().posts;
    assert_eq!(notices.iter().map(|p| p.purpose.as_deref()).collect::<Vec<_>>(), [Some("run_failed")], "the failure is visible in the thread");
}

// Step 6: promoting a queued message makes it the first claim of its conversation, durably.
#[test]
fn a_promoted_chat_is_claimed_before_the_chats_queued_ahead_of_it() {
    let mut f = fixture();
    let s = &mut f.store;
    let first = s.enqueue_chat(&Actor::Owner, chat("mid", "t1", "c1")).unwrap();
    let second = s.enqueue_chat(&Actor::Owner, chat("mid", "t2", "c1")).unwrap();
    s.promote_chat(&Actor::Owner, "t2").unwrap();
    assert_eq!(s.claim_run(lease(60_000), &[]).unwrap().unwrap().run.id, second.id);
    assert_ne!(first.id, second.id);
}

// Pattern: fix-guards (docs/patterns.md#fix-guards). 2026-10-01 (task_01a0f7ff-bbd6): a background
// requester read its answer in its still-running turn, yet the queued return run stayed to resume
// that turn with the same answer until cancelled by hand 17 minutes later. The read fence
// (deliveries.rs `fence`) generalizes it: whatever moves a Buddy's mark in a thread settles every
// queued delivery it covers `consumed`, with no turn; a delivery past the mark still runs once.
#[test]
fn a_mark_advance_consumes_every_covered_delivery() {
    let mut f = fixture();
    let s = &mut f.store;
    let read = s.post(&buddy("mid"), dm("mid", "ic"), request("read me", "r1")).unwrap();
    let unread = s.post(&buddy("mid"), dm("mid", "ic"), request("leave me", "r2")).unwrap();
    let (c1, c2) = (s.claim_run(lease(60_000), &[]).unwrap().unwrap(), s.claim_run(lease(60_000), &[]).unwrap().unwrap());
    let a1 = s.answer(&buddy("ic"), answer_input(&read.id, "done", "a1")).unwrap();
    let a2 = s.answer(&buddy("ic"), answer_input(&unread.id, "done", "a2")).unwrap();
    s.settle_run(&c1.run.id, &c1.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    s.settle_run(&c2.run.id, &c2.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();

    s.mark_thread_read(&buddy("ic"), &read.id, &a1.id).unwrap();
    s.mark_read(&buddy("mid"), &read.channel_id, &read.id).unwrap();
    assert_eq!(queued(s, "mid"), 2, "another reader's cursor, and a channel read that never shows the answer, settle nothing");
    s.mark_thread_read(&buddy("mid"), &read.id, &a1.id).unwrap();

    let runs = s.list_runs(RunQuery::Buddy { buddy_id: "mid".into() }, 10).unwrap();
    let delivered = |post: &str| runs.iter().find(|r| r.input == RunInput::Deliver { post_id: post.into() }).unwrap();
    assert_eq!((delivered(&a1.id).status, delivered(&a1.id).error_code.as_deref()), (RunStatus::Cancelled, Some("consumed")));
    assert_eq!(delivered(&a2.id).status, RunStatus::Queued, "an answer past the mark still delivers");
    assert_eq!(s.claim_run(lease(60_000), &[]).unwrap().unwrap().run.input, RunInput::Deliver { post_id: a2.id.clone() });
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_none(), "exactly once");
}

fn queued(s: &Store, buddy_id: &str) -> usize {
    s.list_runs(RunQuery::Buddy { buddy_id: buddy_id.into() }, 50).unwrap().iter().filter(|r| r.status == RunStatus::Queued).count()
}

fn answer_input(request_id: &str, body: &str, key: &str) -> AnswerInput {
    answer(request_id, body, key)
}

// Delivery design Task 2 criterion (2026-10-06): a busy conversation takes ONE turn per burst. Five
// posts in two subscribed threads arrive while its turn runs; afterwards one delivery shows all
// five and fences the other four, so the burst costs exactly one turn.
#[test]
fn a_burst_in_two_subscribed_threads_costs_one_delivery_turn() {
    let mut f = fixture();
    let s = &mut f.store;
    let t1 = s.post(&buddy("mid"), dm("mid", "ic"), request("thread one", "r1")).unwrap();
    let t2 = s.post(&buddy("mid"), dm("mid", "ic"), request("thread two", "r2")).unwrap();
    for _ in 0..2 {
        let worker = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
        s.settle_run(&worker.run.id, &worker.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    }
    s.enqueue_chat(&Actor::Owner, chat("mid", "busy", "conv-sender")).unwrap();
    let busy = claim_executing(s, "2099-01-01T00:00:00.000Z", lease(600_000));
    let inform = |root: &Post, body: &str, key: &str| PostInput { kind: PostKind::Inform, reply_to_id: Some(root.id.clone()), from_conversation_id: None, ..request(body, key) };
    for (i, root) in [&t1, &t1, &t1, &t2, &t2].into_iter().enumerate() {
        s.post(&buddy("ic"), dm("mid", "ic"), inform(root, &format!("p{i}"), &format!("p{i}"))).unwrap();
    }
    assert_eq!(queued(s, "mid"), 5, "one durable delivery per post");
    assert!(s.claim_run_at("2099-01-01T00:00:01.000Z", lease(600_000), &[]).unwrap().is_none(), "all wait for the busy conversation");
    s.settle_run(&busy.run.id, &busy.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();

    let turn = s.claim_run_at("2099-01-01T00:00:02.000Z", lease(600_000), &[]).unwrap().unwrap();
    let Delivery::Posts { posts, unshown, .. } = s.deliver_posts(&turn.run.id).unwrap() else { panic!("nothing shown") };
    assert_eq!((posts.iter().map(|p| p.body.as_str()).collect::<Vec<_>>(), unshown), (vec!["p0", "p1", "p2", "p3", "p4"], 0));
    s.mark_executing(&turn.run.id, &turn.lease_token).unwrap();
    assert_eq!(queued(s, "mid"), 0, "the other four were fenced: shown in this turn");
    assert!(s.claim_run_at("2099-01-01T00:00:03.000Z", lease(600_000), &[]).unwrap().is_none(), "one turn for the burst");
}

// Decision K (2026-10-06; durable-pending Rev 10, Finding 2, which blocked test 11): a turn composed
// before P2 and P3 arrived replied after them, and its post moved its read mark past both, so their
// deliveries settled "already read" though the Buddy never saw them.
#[test]
fn posting_never_marks_read_a_post_its_author_was_not_shown() {
    let mut f = fixture();
    let s = &mut f.store;
    let root = s.post(&buddy("mid"), dm("mid", "ic"), request("thread", "r1")).unwrap();
    let worker = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    s.settle_run(&worker.run.id, &worker.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    let say = |author: &str, body: &str, key: &str| PostInput {
        kind: PostKind::Inform,
        reply_to_id: Some(root.id.clone()),
        from_conversation_id: Some(format!("conv-{author}")),
        ..request(body, key)
    };
    s.post(&buddy("ic"), dm("mid", "ic"), say("ic", "P2", "p2")).unwrap();
    s.post(&buddy("ic"), dm("mid", "ic"), say("ic", "P3", "p3")).unwrap();
    s.post(&buddy("mid"), dm("mid", "ic"), say("sender", "reply composed before P2", "late")).unwrap();
    assert_eq!(queued(s, "mid"), 2, "P2 and P3 are still owed to the Buddy");
    let unread = s.catch_up_thread(&buddy("mid"), &root.id, 20).unwrap().posts;
    assert_eq!(unread.iter().map(|p| p.body.as_str()).collect::<Vec<_>>(), ["P2", "P3"]);
    assert_eq!(queued(s, "mid"), 0, "reading them fenced their deliveries");
    s.post(&buddy("mid"), dm("mid", "ic"), say("sender", "caught up now", "now")).unwrap();
    assert!(s.catch_up_thread(&buddy("mid"), &root.id, 20).unwrap().posts.is_empty(), "with nothing unseen, its post reads the thread");
}

// 2026-09-28: no run could choose its model, so a Buddy launched four untracked `codex exec`
// workers from a thread (agent_notes/2026-09-28_buddy-worker-spawn-gap.md). A worker is a request
// with a run config: its run carries the config, and the answer returns to the spawning call.
#[test]
fn a_worker_request_runs_on_its_own_config_and_returns_to_the_spawner() {
    let mut f = fixture();
    let s = &mut f.store;
    let sol = RunConfig { provider: "codex".into(), model: Some("gpt-6-sol".into()), reasoning_effort: Some("high".into()) };
    let work = |body: &str, key: &str| PostInput { run_config: Some(sol.clone()), ..request(body, key) };
    let me_only = || ChannelRef::Direct { members: vec![buddy("mid")] };

    let first = s.post(&buddy("mid"), me_only(), work("sweep A", "w1")).unwrap();
    let second = s.post(&buddy("mid"), me_only(), work("sweep B", "w2")).unwrap();
    let a = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    let b = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert_eq!(
        [(&a.run.input, &a.run.config), (&b.run.input, &b.run.config)],
        [(&RunInput::Post { post_id: first.id.clone() }, &Some(sol.clone())), (&RunInput::Post { post_id: second.id.clone() }, &Some(sol.clone()))],
        "each worker is its own tracked run of the spawner, on the chosen model, in parallel"
    );
    // Spawner and worker are one Buddy in one thread: the worker's progress note and answer keep
    // the thread's subscription and read mark the spawner's, so the answer reaches the spawner and
    // is SHOWN there (2026-10-06: an author-based rule delivered it nowhere, or marked it read).
    s.bind_run(&a.run.id, &a.lease_token, "worker-a").unwrap();
    let from_worker = |body: &str, key: &str| PostInput {
        kind: PostKind::Inform,
        reply_to_id: Some(first.id.clone()),
        from_conversation_id: Some("worker-a".into()),
        ..request(body, key)
    };
    s.post(&buddy("mid"), me_only(), from_worker("halfway", "n1")).unwrap();
    let done = s.answer(&buddy("mid"), AnswerInput { from_conversation_id: Some("worker-a".into()), ..answer_input(&first.id, "A done", "a1") }).unwrap();
    s.settle_run(&a.run.id, &a.lease_token, Outcome::Complete { text: "A done".into() }).unwrap();
    let back = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert_eq!(
        (&back.run.input, back.run.conversation_id.as_deref(), &back.run.config),
        (&RunInput::Deliver { post_id: done.id.clone() }, Some("conv-sender"), &None),
        "the result wakes the spawning conversation, on the spawner's own profile"
    );
    let Delivery::Posts { posts, .. } = s.deliver_posts(&back.run.id).unwrap() else { panic!("the answer was not shown") };
    assert_eq!(bodies(&posts), ["A done"], "the spawner is shown the answer, not its worker's own notes");

    let report = s.post(&buddy("mid"), dm("mid", "ic"), work("for my report", "w3")).unwrap();
    assert_eq!(s.list_runs(RunQuery::Buddy { buddy_id: "ic".into() }, 5).unwrap()[0].input, RunInput::Post { post_id: report.id });
    let peer = s.post(&buddy("peer"), dm("peer", "mid"), work("switch models", "w4"));
    assert!(matches!(peer, Err(CoreError::Denied(_))), "a peer cannot move another buddy off its profile: {peer:?}");
    let upward = s.post(&buddy("ic"), dm("ic", "mid"), work("and you", "w5"));
    assert!(matches!(upward, Err(CoreError::Denied(_))), "nor can a report move its manager");
    let inform = s.post(&buddy("mid"), me_only(), PostInput { kind: PostKind::Inform, ..work("note", "w6") });
    assert!(matches!(inform, Err(CoreError::Invalid(_))), "an inform starts no run to configure");
}

#[test]
fn two_answerers_race_and_exactly_one_answer_lands() {
    let f = fixture();
    let path = f.path.to_str().unwrap().to_string();
    let mut s = Store::open(&path).unwrap();
    for round in 0..10 {
        let asked = s.post(&buddy("mid"), dm("mid", "ic"), request("which?", &format!("ask-{round}"))).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let results: Vec<Result<Post, CoreError>> = [buddy("ic"), Actor::Owner]
            .into_iter()
            .map(|who| {
                let (barrier, path, id) = (barrier.clone(), path.clone(), asked.id.clone());
                std::thread::spawn(move || {
                    let mut store = Store::open(&path).unwrap();
                    barrier.wait();
                    store
                        .answer(&who, AnswerInput { request_id: id, body: format!("{who:?}"), evidence: vec![], from_conversation_id: None, key: format!("a-{round}") })
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect();
        let won: Vec<&Post> = results.iter().flatten().collect();
        assert_eq!(won.len(), 1, "round {round}: {results:?}");
        let thread = s.list_posts(&Actor::Owner, PostQuery::Thread { root_id: asked.id.clone() }, None, 10).unwrap();
        assert_eq!(thread.posts.iter().map(|p| &p.id).collect::<Vec<_>>(), [&won[0].id], "round {round}: no orphan answer post");
        assert_eq!(s.get_post(&Actor::Owner, &asked.id).unwrap().request, RequestState::Answered { answer_id: won[0].id.clone() });
    }
}

#[test]
fn pausing_a_task_cancels_its_queued_runs() {
    let mut f = fixture();
    let s = &mut f.store;
    let task = s
        .upsert_task(
            &buddy("ic"),
            TaskWrite::Create { owner_id: "ic".into(), parent_id: None, title: "t".into(), done_criteria: "d".into(), key: "c".into() },
        )
        .unwrap();
    let asked = s.post(&buddy("mid"), dm("mid", "ic"), PostInput { task_id: Some(task.id.clone()), ..request("x", "k") }).unwrap();
    s.upsert_task(
        &buddy("ic"),
        TaskWrite::Update {
            task_id: task.id.clone(),
            base_revision: 1,
            key: "p".into(),
            changes: TaskChanges { paused: Some(true), ..Default::default() },
        },
    )
    .unwrap();
    let run = s.list_runs(RunQuery::Task { task_id: task.id.clone() }, 5).unwrap().remove(0);
    assert_eq!((&run.input, run.status, run.error_code.as_deref()), (&RunInput::Post { post_id: asked.id }, RunStatus::Cancelled, Some("task_epoch_stale")));
}

// Owner decision, 2026-10-07 ("stay simple, don't overload DMs"): a schedule fire posts nothing. It
// is one body-carrying chat run with no conversation, once per slot, and missed slots still
// collapse into one. Before: a post in the schedule's thread (decision I, 2026-10-06).
#[test]
fn a_schedule_fire_posts_nothing_and_queues_one_silent_run() {
    let mut f = fixture();
    let s = &mut f.store;
    let schedule = s
        .put_schedule(
            &buddy("ic"),
            ScheduleInput {
                id: None,
                buddy_id: "ic".into(),
                task_id: None,
                name: "hourly".into(),
                cron: "0 * * * *".into(),
                timezone: "Asia/Seoul".into(),
                prompt: "check".into(),
                enabled: true,
                key: "s".into(),
            },
        )
        .unwrap();
    let slot = schedule.next_run_at.clone().unwrap();
    assert!(slot.ends_with(":00:00.000Z"), "{slot}");
    let later = "2099-01-01T00:30:00.000Z";
    let runs = s.due_schedules(later).unwrap();
    assert_eq!(runs.len(), 1, "missed slots collapse into one fire");
    let run = &runs[0];
    assert_eq!(run.input, RunInput::Chat { turn_id: format!("schedule:{}:{slot}", schedule.id) });
    assert!(run.conversation_id.is_none(), "a fire opens its own background conversation");
    let body = run.body.as_deref().unwrap();
    assert!(body.contains(&slot) && body.ends_with("check"), "{body}");
    assert!(s.due_schedules(later).unwrap().is_empty(), "the schedule advanced past now");
    let posts = s.search_posts(&buddy("ic"), WS, &SearchQuery::text("Scheduled"), None, 50).unwrap();
    assert!(posts.posts.is_empty(), "no post anywhere: {:?}", posts.posts);

    let claim = s.claim_run_at(later, lease(60_000), &[]).unwrap().unwrap();
    assert_eq!(claim.run.id, run.id, "the runner claims it like any background run");
    let deadline = DateTime::parse_from_rfc3339(claim.run.deadline.as_deref().unwrap()).unwrap();
    let started = DateTime::parse_from_rfc3339(claim.run.started_at.as_deref().unwrap()).unwrap();
    assert!((deadline - started).num_milliseconds() < 24 * 3_600_000, "background budget, not an owner chat's");
}

#[test]
fn events_are_idempotent_per_key() {
    let mut f = fixture();
    let s = &mut f.store;
    let input = |key: &str| EventInput {
        workspace_id: WS.into(),
        op: "memory.review".into(),
        payload: "{}".into(),
        key: Some(key.into()),
        buddy_id: Some("ic".into()),
        task_id: None,
    };
    let first = s.append_event(&buddy("ic"), input("e1")).unwrap();
    assert_eq!(s.append_event(&buddy("ic"), input("e1")).unwrap().seq, first.seq, "same key, same event");
}

#[test]
fn team_admin_is_owner_only_and_refuses_a_reporting_cycle() {
    let mut f = fixture();
    let s = &mut f.store;
    let hire = |key: &str| BuddyCreate {
        workspace_id: WS.into(),
        slug: key.into(),
        name: key.into(),
        role: "r".into(),
        manager: ManagerRef::Buddy { id: "lead".into() },
        provider: Some("codex".into()),
        model: None,
        reasoning_effort: None,
        key: key.into(),
    };
    let folder = WorkspaceInput { name: "Docs".into(), root_path: "/tmp/docs".into() };
    assert!(matches!(s.create_workspace(&buddy("lead"), folder.clone()), Err(CoreError::Denied(_))));
    let docs = s.create_workspace(&Actor::Owner, folder.clone()).unwrap();
    assert_eq!(s.create_workspace(&Actor::Owner, folder).unwrap().id, docs.id, "one workspace per folder");
    // A manager is not the owner: team edits stay owner-only (02 §8.3 team_admin).
    assert!(matches!(s.create_buddy(&buddy("lead"), hire("x")), Err(CoreError::Denied(_))));
    let new = s.create_buddy(&Actor::Owner, hire("x")).unwrap();
    assert_eq!(new.manager_id.as_deref(), Some("lead"));
    let cycle = |manager: &str| BuddyUpdate {
        buddy_id: "lead".into(),
        changes: BuddyChanges { manager: Some(ManagerRef::Buddy { id: manager.into() }), ..BuddyChanges::default() },
        key: format!("cycle-{manager}"),
    };
    assert!(matches!(s.update_buddy(&Actor::Owner, cycle("ic")), Err(CoreError::Invalid(_))), "ic reports (via mid) to lead");
    assert!(matches!(s.update_buddy(&Actor::Owner, cycle("lead")), Err(CoreError::Invalid(_))), "nobody manages themselves");
    let top = BuddyUpdate {
        buddy_id: "mid".into(),
        changes: BuddyChanges { manager: Some(ManagerRef::Nobody), name: Some("Mid".into()), ..BuddyChanges::default() },
        key: "top".into(),
    };
    let mid = s.update_buddy(&Actor::Owner, top).unwrap();
    assert_eq!((mid.manager_id, mid.name.as_str(), mid.role.as_str()), (None, "Mid", "role"), "absent fields are unchanged");

    // Archiving cancels the buddy's queued runs: an archived buddy is never claimed again.
    let queued = s.enqueue_chat(&Actor::Owner, chat("peer", "t1", "c-peer")).unwrap();
    let archive = BuddyUpdate {
        buddy_id: "peer".into(),
        changes: BuddyChanges { status: Some(BuddyStatus::Archived), ..BuddyChanges::default() },
        key: "archive".into(),
    };
    s.update_buddy(&Actor::Owner, archive).unwrap();
    assert_eq!(s.get_run(&queued.id).unwrap().status, RunStatus::Cancelled);
}

// 2026-10-01 (Pattern: lease-heartbeat): the claim gate is the ONE way a dead holder's run ends.
// It used to be a startup sweep, and the gate's own expiry was a bare UPDATE that left the run's
// request awaiting forever. An expired executed run ends exactly as a failed settle would: the row
// says why, it leaves the workspace list only as ended, a late settle is rejected, and its request
// goes on (decision G: once in the same conversation, see the test below).
#[test]
fn an_expired_lease_ends_its_run_like_a_failed_settle() {
    let mut f = fixture();
    let s = &mut f.store;
    let ask = s.post(&buddy("mid"), dm("mid", "ic"), request("build it", "ask")).unwrap();
    let claim = claim_executing(s, "2099-01-01T00:00:00.000Z", lease(300_000));
    assert_eq!(claim.run.input, RunInput::Post { post_id: ask.id.clone() });
    // The lease is not the deadline: minutes of lease, an hour of turn budget.
    assert_eq!(claim.run.lease_expires_at.as_deref(), Some("2099-01-01T00:05:00.000Z"));
    assert_eq!(claim.run.deadline.as_deref(), Some("2099-01-01T01:00:00.000Z"));

    // Still inside the lease: the gate leaves a held run alone (no boot-style blanket sweep).
    s.claim_run_at("2099-01-01T00:04:59.000Z", lease(300_000), &[]).unwrap();
    assert_eq!(s.get_run(&claim.run.id).unwrap().status, RunStatus::Running);

    s.claim_run_at("2099-01-01T00:05:01.000Z", lease(300_000), &[]).unwrap();
    let run = s.get_run(&claim.run.id).unwrap();
    assert_eq!((run.status, run.error_code.as_deref()), (RunStatus::Failed, Some("lease_expired")));
    let rows = s.list_run_rows(&Actor::Owner, ListScope::Workspace { workspace_id: WS.into() }, 100).unwrap();
    let row = rows.iter().find(|r| r.id == claim.run.id).expect("expired run left the workspace list");
    assert_eq!((row.status, row.error_code.as_deref()), (RunStatus::Failed, Some("lease_expired")));
    assert_eq!(
        s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "late".into() }).unwrap_err().code(),
        "lease_lost"
    );
}

// Durable intake W0b (745515f), kept by the 2026-10-06 rebuild: a run whose holder died BEFORE
// `mark_executing` never ran, so the gate puts it back in the queue (nothing replayed, nothing
// lost, nothing reported failed); one that had executed ends `lease_expired`.
#[test]
fn a_dead_holder_requeues_an_unexecuted_run_and_fails_an_executed_one() {
    let mut f = fixture();
    let s = &mut f.store;
    s.enqueue_chat(&Actor::Owner, chat("lead", "never-ran", "c-lead")).unwrap();
    let unexecuted = s.claim_run_at("2099-01-01T00:00:00.000Z", lease(300_000), &[]).unwrap().unwrap();
    s.enqueue_chat(&Actor::Owner, chat("peer", "ran", "c-peer")).unwrap();
    let executed = claim_executing(s, "2099-01-01T00:00:00.000Z", lease(300_000));
    s.claim_run_at("2099-01-01T00:05:01.000Z", lease(300_000), &[]).unwrap();
    let (again, ended) = (s.get_run(&unexecuted.run.id).unwrap(), s.get_run(&executed.run.id).unwrap());
    // The gate requeued it and, in the same call, claimed it again: it is running under a new lease.
    assert_eq!((again.status, again.attempt, again.executing_at.as_deref()), (RunStatus::Running, 1, None));
    let void = s.renew_run_at("2099-01-01T00:05:02.000Z", &again.id, &unexecuted.lease_token, 300_000).unwrap_err();
    assert_eq!(void.code(), "lease_lost", "the dead holder's token is void");
    assert_eq!((ended.status, ended.error_code.as_deref()), (RunStatus::Failed, Some("lease_expired")));
}

// Decision G (owner, 2026-10-06): a request whose run had started and whose holder died continues
// ONCE in the SAME conversation (it keeps its context); a second death sends the failure post; an
// explicit stop is never undone. Before: every restart-killed worker ended `lease_expired` and its
// asker had to notice and retry by hand.
#[test]
fn a_request_whose_holder_died_resumes_once_in_its_conversation_then_fails() {
    let mut f = fixture();
    let s = &mut f.store;
    let ask = s.post(&buddy("mid"), dm("mid", "ic"), request("build it", "ask")).unwrap();
    let first = s.claim_run_at("2099-01-01T00:00:00.000Z", lease(300_000), &[]).unwrap().unwrap();
    s.bind_run(&first.run.id, &first.lease_token, "worker-conv").unwrap();
    s.mark_executing(&first.run.id, &first.lease_token).unwrap();
    let resumed = s.claim_run_at("2099-01-01T00:05:01.000Z", lease(300_000), &[]).unwrap().expect("the resume is claimable at once");
    assert_eq!(s.get_run(&first.run.id).unwrap().error_code.as_deref(), Some("lease_expired"));
    assert_eq!(
        (resumed.run.attempt, resumed.run.conversation_id.as_deref(), &resumed.run.input),
        (2, Some("worker-conv"), &RunInput::Post { post_id: ask.id.clone() }),
        "the same request continues in the same conversation"
    );
    assert_eq!(s.get_post(&Actor::Owner, &ask.id).unwrap().request, RequestState::Awaiting, "the asker is told nothing yet");
    assert_eq!(queued(s, "mid"), 0);

    s.mark_executing(&resumed.run.id, &resumed.lease_token).unwrap();
    let notice = s.claim_run_at("2099-01-01T00:10:02.000Z", lease(300_000), &[]).unwrap().expect("the failure post is delivered");
    assert_eq!(notice.run.buddy_id, "mid");
    s.settle_run(&notice.run.id, &notice.lease_token, Outcome::Complete { text: "read".into() }).unwrap();
    assert_eq!(s.get_post(&Actor::Owner, &ask.id).unwrap().request, RequestState::Failed, "a second death fails it");
    assert_eq!(s.list_runs(RunQuery::Buddy { buddy_id: "ic".into() }, 10).unwrap().len(), 2, "no third attempt");

    let stopped = s.post(&buddy("mid"), dm("mid", "ic"), request("stop me", "ask2")).unwrap();
    let run = claim_executing(s, "2099-01-01T01:00:00.000Z", lease(300_000));
    s.cancel_run(&Actor::Owner, &run.run.id).unwrap();
    s.claim_run_at("2099-01-01T01:05:01.000Z", lease(300_000), &[]).unwrap();
    assert_eq!(s.get_run(&run.run.id).unwrap().status, RunStatus::Cancelled);
    assert_eq!(s.get_post(&Actor::Owner, &stopped.id).unwrap().request, RequestState::Cancelled, "a stop is never undone");
}

// Decision J (2026-10-06): a worker may name only its provider; the model is the provider default,
// written onto the run by its holder at claim so the run says which model answered.
#[test]
fn a_model_less_run_records_the_model_it_resolved_once() {
    let mut f = fixture();
    let s = &mut f.store;
    let codex = RunConfig { provider: "codex".into(), model: None, reasoning_effort: None };
    s.post(&buddy("mid"), dm("mid", "ic"), PostInput { run_config: Some(codex), ..request("go", "w") }).unwrap();
    let claim = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert_eq!(claim.run.config.as_ref().unwrap().model, None);
    let run = s.record_run_model(&claim.run.id, &claim.lease_token, "gpt-6.1-sol").unwrap();
    assert_eq!(run.config.unwrap().model.as_deref(), Some("gpt-6.1-sol"));
    let again = s.record_run_model(&claim.run.id, &claim.lease_token, "other");
    assert!(matches!(again, Err(CoreError::Invalid(_))), "a named model is never overwritten: {again:?}");
}

// 2026-10-05: four cancelled worker runs held 24 h leases written by an older build (lease = the
// deadline). With no process left they sat in `cancel_requested` and filled the Buddy's pool 5/5.
// The gate clamps any lease to one heartbeat, so such a run ends one heartbeat later, while a
// current holder's lease (never longer than one heartbeat) is untouched.
#[test]
fn a_lease_longer_than_one_heartbeat_ends_one_heartbeat_later() {
    let mut f = fixture();
    let s = &mut f.store;
    s.post(&buddy("mid"), dm("mid", "ic"), request("build it", "ask")).unwrap();
    let legacy = s.claim_run_at("2099-01-01T00:00:00.000Z", lease(86_400_000), &[]).unwrap().unwrap();
    assert_eq!(legacy.run.lease_expires_at.as_deref(), Some("2099-01-02T00:00:00.000Z"));
    s.cancel_run(&Actor::Owner, &legacy.run.id).unwrap();
    assert_eq!(s.get_run(&legacy.run.id).unwrap().status, RunStatus::CancelRequested);

    s.enqueue_chat(&Actor::Owner, chat("lead", "turn", "c-lead")).unwrap();
    let current = s.claim_run_at("2099-01-01T00:01:00.000Z", lease(300_000), &[]).unwrap().unwrap();
    assert_eq!(current.run.lease_expires_at.as_deref(), Some("2099-01-01T00:06:00.000Z"), "a current lease is not moved");
    assert_eq!(s.get_run(&legacy.run.id).unwrap().lease_expires_at.as_deref(), Some("2099-01-01T00:06:00.000Z"));

    s.renew_run_at("2099-01-01T00:05:00.000Z", &current.run.id, &current.lease_token, 300_000).unwrap();
    s.claim_run_at("2099-01-01T00:06:01.000Z", lease(300_000), &[]).unwrap();
    let run = s.get_run(&legacy.run.id).unwrap();
    assert_eq!(run.status, RunStatus::Cancelled, "the stop finishes one heartbeat after the clamp, not a day later");
    assert_eq!(s.get_run(&current.run.id).unwrap().status, RunStatus::Running, "a renewing holder keeps its run");
}

// The holder's renewals keep a run alive past any number of lease terms; a chat run's deadline is
// the explicit chat budget, never the lease (2026-09-10: a 600 s claim lease killed owner chats).
#[test]
fn a_held_run_is_renewed_by_the_gate_before_it_can_expire() {
    // Regression guard (2026-10-06): a 306 s sleep outlasted the 300 s lease and the gate, running
    // first at wake, ended live runs. A hold passed to the gate renews inside its transaction.
    let mut f = fixture();
    let s = &mut f.store;
    s.post(&buddy("mid"), dm("mid", "ic"), request("build it", "ask")).unwrap();
    let live = claim_executing(s, "2099-01-01T00:00:00.000Z", lease(300_000));
    s.post(&buddy("mid"), dm("mid", "ic"), request("and this", "ask2")).unwrap();
    let dead = claim_executing(s, "2099-01-01T00:00:00.000Z", lease(300_000));

    let hold = RunHold { run_id: live.run.id.clone(), lease_token: live.lease_token.clone() };
    s.claim_run_at("2099-01-01T00:06:06.000Z", lease(300_000), &[hold]).unwrap();
    let live_now = s.get_run(&live.run.id).unwrap();
    assert_eq!(live_now.status, RunStatus::Running, "the held run survives a gap longer than its lease");
    assert_eq!(live_now.lease_expires_at.as_deref(), Some("2099-01-01T00:11:06.000Z"));
    assert_eq!(s.get_run(&dead.run.id).unwrap().status, RunStatus::Failed, "an unheld run still expires");

    // A stale hold (run already ended) is skipped, never resurrected.
    let stale = RunHold { run_id: dead.run.id.clone(), lease_token: dead.lease_token.clone() };
    s.claim_run_at("2099-01-01T00:06:07.000Z", lease(300_000), &[stale]).unwrap();
    assert_eq!(s.get_run(&dead.run.id).unwrap().status, RunStatus::Failed);
}

#[test]
fn a_renewed_lease_outlives_its_first_term() {
    let mut f = fixture();
    let s = &mut f.store;
    s.enqueue_chat(&Actor::Owner, chat("lead", "turn", "c-lead")).unwrap();
    let chat_run = claim_executing(s, "2099-01-01T00:00:00.000Z", lease(300_000));
    assert_eq!(chat_run.run.deadline.as_deref(), Some("2099-01-02T00:00:00.000Z"), "24 h, from the chat budget");
    s.post(&buddy("mid"), dm("mid", "ic"), request("build it", "ask")).unwrap();
    let orphan = claim_executing(s, "2099-01-01T00:00:00.000Z", lease(300_000));

    for minute in [4, 8, 12] {
        let at = format!("2099-01-01T00:{minute:02}:00.000Z");
        s.renew_run_at(&at, &chat_run.run.id, &chat_run.lease_token, 300_000).unwrap();
        s.claim_run_at(&at, lease(300_000), &[]).unwrap();
    }
    assert_eq!(s.get_run(&chat_run.run.id).unwrap().status, RunStatus::Running, "renewed for 12 minutes");
    assert_eq!(s.get_run(&orphan.run.id).unwrap().status, RunStatus::Failed, "never renewed");
    assert_eq!(
        s.renew_run_at("2099-01-01T00:13:00.000Z", &orphan.run.id, &orphan.lease_token, 300_000).unwrap_err().code(),
        "lease_lost",
        "a cleared run cannot be renewed back to life"
    );
    assert_eq!(
        s.renew_run_at("2099-01-01T00:13:00.000Z", &chat_run.run.id, "not-the-token", 300_000).unwrap_err().code(),
        "lease_lost"
    );
    // An adopting backend after a long gap: the lease ran out, but no gate ran since; it renews.
    s.renew_run_at("2099-01-01T00:30:00.000Z", &chat_run.run.id, &chat_run.lease_token, 300_000).unwrap();
    s.claim_run_at("2099-01-01T00:30:01.000Z", lease(300_000), &[]).unwrap();
    s.settle_run(&chat_run.run.id, &chat_run.lease_token, Outcome::Complete { text: "done".into() }).unwrap();
    assert_eq!(
        s.settle_run(&chat_run.run.id, &chat_run.lease_token, Outcome::Complete { text: "again".into() })
            .unwrap_err()
            .code(),
        "lease_lost",
        "a renewed run still settles once"
    );
}

#[test]
fn post_search_finds_words_only_in_channels_the_reader_may_read() {
    let mut f = fixture();
    let s = &mut f.store;
    let general = s
        .create_channel(
            &Actor::Owner,
            ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "g".into() },
        )
        .unwrap();
    let say = |body: &str, key: &str| PostInput { kind: PostKind::Inform, from_conversation_id: None, ..request(body, key) };
    s.post(&buddy("lead"), ChannelRef::Id { id: general.id.clone() }, say("Deploy the ranking model on Friday", "p1")).unwrap();
    s.post(&buddy("mid"), dm("mid", "ic"), say("secret ranking numbers", "p2")).unwrap();
    // Every word must match, in any order, case-insensitively; FTS syntax in the query is literal.
    let hits = |who: &Actor, q: &str| s.search_posts(who, WS, &SearchQuery::text(q), None, 10).unwrap().posts.into_iter().map(|p| p.body).collect::<Vec<_>>();
    assert_eq!(hits(&buddy("peer"), "friday RANKING"), ["Deploy the ranking model on Friday"]);
    assert_eq!(hits(&buddy("peer"), "ranking"), ["Deploy the ranking model on Friday"], "a DM is private to its members");
    assert_eq!(hits(&buddy("ic"), "ranking").len(), 2, "a member finds its DM");
    assert_eq!(hits(&Actor::Owner, "ranking").len(), 2, "the owner reads every DM");
    // FTS5 operators typed by the user are words: if any were syntax, these would find the ranking posts.
    for typed in ["ranking AND friday", "ranking NOT zzzz", "body:ranking", "NEAR(ranking friday)"] {
        assert!(hits(&Actor::Owner, typed).is_empty(), "{typed:?} is words, not syntax");
    }
    assert!(matches!(s.search_posts(&buddy("gone"), WS, &SearchQuery::text("ranking"), None, 10), Err(CoreError::Denied(_))), "archived buddies cannot search");
}

#[test]
fn post_search_pages_older_hits_with_its_cursor() {
    // Search once took no cursor, so a Buddy could only ever see the newest `limit` hits (2026-09-27).
    let mut f = fixture();
    let s = &mut f.store;
    let general = s
        .create_channel(
            &Actor::Owner,
            ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "g".into() },
        )
        .unwrap();
    let say = |body: &str, key: &str| PostInput { kind: PostKind::Inform, from_conversation_id: None, ..request(body, key) };
    for i in 0..5 {
        s.post(&Actor::Owner, ChannelRef::Id { id: general.id.clone() }, say(&format!("rollout note {i}"), &format!("n{i}"))).unwrap();
    }
    s.post(&Actor::Owner, ChannelRef::Id { id: general.id.clone() }, say("unrelated", "u")).unwrap();
    let mut seen = Vec::new();
    let mut before = None;
    loop {
        let page = s.search_posts(&Actor::Owner, WS, &SearchQuery::text("rollout"), before, 2).unwrap();
        seen.extend(page.posts.into_iter().map(|p| p.body));
        match page.next {
            Some(cursor) => before = Some(cursor),
            None => break,
        }
    }
    assert_eq!(seen, ["rollout note 4", "rollout note 3", "rollout note 2", "rollout note 1", "rollout note 0"]);
}

#[test]
fn posts_read_back_in_write_order_within_a_millisecond() {
    // Posts order by their ordered id (UUIDv7 from one monotonic generator), never by timestamp
    // ties. With random ids, 29 of 50 such threads came back shuffled (2026-09-25).
    let mut f = fixture();
    let s = &mut f.store;
    let general = s
        .create_channel(
            &Actor::Owner,
            ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "g".into() },
        )
        .unwrap();
    let to = || ChannelRef::Id { id: general.id.clone() };
    let say = |body: &str, reply: Option<String>| PostInput { kind: PostKind::Inform, reply_to_id: reply, ..request(body, body) };
    let mut same_millisecond = 0;
    for round in 0..20 {
        let root = s.post(&Actor::Owner, to(), say(&format!("root {round}"), None)).unwrap();
        // Written back to back: most land in the same millisecond.
        let written: Vec<Post> =
            (0..4).map(|i| s.post(&buddy("ic"), to(), say(&format!("r{round}-{i}"), Some(root.id.clone()))).unwrap()).collect();
        same_millisecond += written.windows(2).filter(|w| w[0].created_at == w[1].created_at).count();
        let mut read: Vec<String> = s
            .list_posts(&Actor::Owner, PostQuery::Thread { root_id: root.id.clone() }, None, 10)
            .unwrap()
            .posts
            .into_iter()
            .map(|p| p.id)
            .collect();
        read.reverse();
        assert_eq!(read, written.iter().map(|p| p.id.clone()).collect::<Vec<_>>(), "round {round}: a thread reads in write order");
    }
    // Non-vacuous, and no timestamp adjustment: posts really did share a millisecond.
    assert!(same_millisecond > 0, "the workload never wrote two posts in one millisecond");
}

#[test]
fn ordered_ids_are_strictly_increasing_even_within_one_millisecond() {
    use unleashd_buddies::ids;
    // 5,000 ids at one frozen millisecond overflow the 12-bit counter (4,096) at least once.
    let ms = 1_800_000_000_000;
    let issued: Vec<String> = (0..5_000).map(|_| ids::next_at(ms).to_string()).collect();
    assert!(issued.windows(2).all(|w| w[0] < w[1]), "strictly increasing as strings (the order SQLite compares)");
    assert!(issued[0] <= ids::ceiling(ms).to_string(), "the ceiling closes its millisecond");
    // A clock that steps back never issues a smaller id.
    let after_step_back = ids::next_at(ms - 60_000).to_string();
    assert!(after_step_back > *issued.last().unwrap());
}

#[test]
fn channel_rows_carry_reply_stats_the_read_cursor_and_permalink_pages() {
    // T22: the client migration dropped reply counts, "New messages" and reply permalinks because
    // the crate had no per-root stats, exposed no read cursor and could page only from the newest.
    let mut f = fixture();
    let s = &mut f.store;
    let general = s
        .create_channel(
            &Actor::Owner,
            ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "g".into() },
        )
        .unwrap();
    let to = || ChannelRef::Id { id: general.id.clone() };
    let say = |body: &str, reply: Option<String>| PostInput { kind: PostKind::Inform, reply_to_id: reply, ..request(body, body) };
    let root = s.post(&Actor::Owner, to(), say("root", None)).unwrap();
    let quiet = s.post(&Actor::Owner, to(), say("quiet", None)).unwrap();
    let replies: Vec<Post> = (0..5).map(|i| s.post(&buddy("ic"), to(), say(&format!("r{i}"), Some(root.id.clone()))).unwrap()).collect();

    let stats = s.thread_stats(&Actor::Owner, &general.id, &[root.id.clone(), quiet.id.clone()]).unwrap();
    assert_eq!(stats.len(), 1, "a root without replies has no stat");
    assert_eq!((stats[0].replies, &stats[0].last_reply_ord), (5, &replies[4].ord));
    assert_eq!(stats[0].last_reply_author, buddy("ic"));
    let other = s
        .create_channel(&Actor::Owner, ChannelInput { workspace_id: WS.into(), name: "o".into(), purpose: "p".into(), key: "o".into() })
        .unwrap();
    assert!(s.thread_stats(&Actor::Owner, &other.id, std::slice::from_ref(&root.id)).unwrap().is_empty(), "stats stay in their channel");

    let cursor = |s: &Store| {
        let inbox = s.inbox(&Actor::Owner, WS).unwrap();
        inbox.channels.into_iter().find(|c| c.channel.id == general.id).unwrap().last_read_ord
    };
    assert_eq!(cursor(s), None, "never read");
    s.mark_read(&Actor::Owner, &general.id, &replies[1].id).unwrap();
    assert_eq!(cursor(s), Some(replies[1].ord.clone()));

    let thread = || PostQuery::Thread { root_id: root.id.clone() };
    let ids = |page: &PostPage| page.posts.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
    let from = s.list_posts_from(&Actor::Owner, thread(), &replies[2].id, 50).unwrap();
    assert_eq!(ids(&from), [&replies[4], &replies[3], &replies[2]].map(|p| p.id.clone()), "the linked reply and every newer one");
    let older = s.list_posts(&Actor::Owner, thread(), from.next.clone(), 50).unwrap();
    assert_eq!(ids(&older), [&replies[1], &replies[0]].map(|p| p.id.clone()), "`next` pages on below the linked reply");
    assert!(s.list_posts_from(&Actor::Owner, thread(), &replies[0].id, 50).unwrap().next.is_none(), "nothing older");
    let capped = s.list_posts_from(&Actor::Owner, thread(), &replies[0].id, 2).unwrap();
    assert_eq!(ids(&capped), [&replies[1], &replies[0]].map(|p| p.id.clone()), "a cap keeps the linked reply");
    assert!(matches!(s.list_posts_from(&Actor::Owner, thread(), &quiet.id, 5), Err(CoreError::Invalid(_))));
}

#[test]
fn task_posts_gather_one_tasks_posts_across_the_channels_a_reader_may_read() {
    let mut f = fixture();
    let s = &mut f.store;
    let create = |title: &str| TaskWrite::Create {
        owner_id: "ic".into(),
        parent_id: None,
        title: title.into(),
        done_criteria: "d".into(),
        key: title.into(),
    };
    let task = s.upsert_task(&Actor::Owner, create("ship")).unwrap();
    let other = s.upsert_task(&Actor::Owner, create("other")).unwrap();
    let general = s
        .create_channel(
            &Actor::Owner,
            ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "g".into() },
        )
        .unwrap();
    let about = |t: &Task, body: &str| PostInput { kind: PostKind::Inform, task_id: Some(t.id.clone()), ..request(body, body) };
    s.post(&buddy("lead"), ChannelRef::Id { id: general.id.clone() }, about(&task, "public")).unwrap();
    s.post(&buddy("mid"), dm("mid", "ic"), about(&task, "private")).unwrap();
    s.post(&buddy("lead"), ChannelRef::Id { id: general.id.clone() }, about(&other, "elsewhere")).unwrap();
    s.post(
        &buddy("lead"),
        ChannelRef::Task { task_id: task.id.clone() },
        PostInput {
            kind: PostKind::Inform,
            body: "task channel".into(),
            purpose: None,
            evidence: vec![],
            reply_to_id: None,
            task_id: None,
            from_conversation_id: None,
            mentions: vec![],
            run_config: None,
            broadcast: false,
            key: "task-channel".into(),
        },
    )
    .unwrap();
    assert!(matches!(
        s.post(
            &buddy("lead"),
            ChannelRef::Task { task_id: task.id.clone() },
            about(&other, "wrong task"),
        ),
        Err(CoreError::Invalid(_))
    ));
    let bodies = |who: &Actor, before: Option<Cursor>, limit: i64| {
        let page = s.task_posts(who, &task.id, before, limit).unwrap();
        (page.posts.into_iter().map(|p| p.body).collect::<Vec<_>>(), page.next)
    };
    assert_eq!(bodies(&Actor::Owner, None, 10).0, ["task channel", "private", "public"], "the owner reads every channel");
    assert_eq!(bodies(&buddy("peer"), None, 10).0, ["task channel", "public"], "a task channel is readable to its workspace");
    let (first, next) = bodies(&Actor::Owner, None, 1);
    assert_eq!(first, ["task channel"]);
    assert_eq!(bodies(&Actor::Owner, next, 1).0, ["private"], "keyset paging on the ordered id");
}

#[test]
fn a_profile_setting_can_be_cleared_back_to_the_default() {
    // T22: `provider: Option<String>` could only set; Settings had no way back to the default.
    let mut f = fixture();
    let s = &mut f.store;
    let change = |changes: BuddyChanges, key: &str| BuddyUpdate { buddy_id: "ic".into(), changes, key: key.into() };
    let set = |v: &str| Some(Setting::Set { value: v.into() });
    let ic = s
        .update_buddy(&Actor::Owner, change(BuddyChanges { provider: set("codex"), model: set("m1"), ..Default::default() }, "set"))
        .unwrap();
    assert_eq!((ic.provider.as_deref(), ic.model.as_deref()), (Some("codex"), Some("m1")));
    let ic = s.update_buddy(&Actor::Owner, change(BuddyChanges { model: Some(Setting::Default), ..Default::default() }, "clear")).unwrap();
    assert_eq!((ic.provider.as_deref(), ic.model), (Some("codex"), None), "cleared; the absent provider is unchanged");
    let replay = change(BuddyChanges { model: set("m2"), ..Default::default() }, "clear");
    assert!(s.update_buddy(&Actor::Owner, replay).is_err(), "a reused key with another change is refused, not replayed");
}

/// T22: directory cards show "N open · M blocked". Finished tasks and todos (child tasks) must not
/// count, and blocked is a subset of open.
#[test]
fn task_counts_are_unfinished_top_level_tasks_per_buddy() {
    let mut f = fixture();
    let s = &mut f.store;
    let mut make = |owner: &str, parent: Option<String>, status: TaskStatus, key: &str| {
        let task = s
            .upsert_task(
                &Actor::Owner,
                TaskWrite::Create {
                    owner_id: owner.into(),
                    parent_id: parent,
                    title: "t".into(),
                    done_criteria: "d".into(),
                    key: key.into(),
                },
            )
            .unwrap();
        let blocked_reason = (status == TaskStatus::Blocked).then(|| "waiting".to_string());
        let changes = TaskChanges { status: Some(status), blocked_reason, ..Default::default() };
        let update = TaskWrite::Update { task_id: task.id.clone(), base_revision: 1, key: format!("{key}-s"), changes };
        s.upsert_task(&Actor::Owner, update).unwrap().id
    };
    let parent = make("ic", None, TaskStatus::InProgress, "a");
    make("ic", None, TaskStatus::Blocked, "b");
    make("ic", None, TaskStatus::Review, "c");
    make("ic", None, TaskStatus::Done, "d");
    make("ic", None, TaskStatus::Cancelled, "e");
    make("ic", Some(parent), TaskStatus::Blocked, "f");
    make("peer", None, TaskStatus::Open, "g");
    let mut counts = s.task_counts(WS).unwrap();
    counts.sort_by(|a, b| a.buddy_id.cmp(&b.buddy_id));
    assert_eq!(
        counts,
        vec![TaskCount { buddy_id: "ic".into(), open: 3, blocked: 1 }, TaskCount { buddy_id: "peer".into(), open: 1, blocked: 0 },]
    );
    assert!(s.task_counts("ws_other").unwrap().is_empty());
}

#[test]
fn channel_archive_preserves_history_and_restores_posting() {
    let mut f = fixture();
    let s = &mut f.store;
    let channel = s.create_channel(&buddy("ic"), ChannelInput { workspace_id: WS.into(), name: "archive".into(), purpose: "history".into(), key: "archive-channel".into() }).unwrap();
    let channel_ref = || ChannelRef::Id { id: channel.id.clone() };
    let post = s.post(&buddy("ic"), channel_ref(), PostInput { kind: PostKind::Inform, ..request("remember", "remember") }).unwrap();
    assert!(s.inbox(&Actor::Owner, WS).unwrap().channels.iter().any(|c| c.channel.id == channel.id && c.unread == 1));
    let archived = s.set_channel_archived(&buddy("peer"), &channel.id, true, "archive").unwrap();
    assert!(archived.archived_at.is_some());
    assert_eq!(s.set_channel_archived(&buddy("peer"), &channel.id, true, "archive").unwrap().archived_at, archived.archived_at);
    assert!(s.set_channel_archived(&buddy("peer"), &channel.id, false, "archive").is_err());
    assert!(s.set_channel_archived(&buddy("gone"), &channel.id, false, "gone").is_err());
    let conn = rusqlite::Connection::open(&f.path).unwrap();
    conn.execute("INSERT INTO workspace(id, name, root_path, created_at) VALUES ('elsewhere', 'Elsewhere', '/tmp/elsewhere', 'now')", []).unwrap();
    let elsewhere = s.create_channel(&Actor::Owner, ChannelInput { workspace_id: "elsewhere".into(), name: "foreign".into(), purpose: "p".into(), key: "foreign".into() }).unwrap();
    assert!(matches!(s.set_channel_archived(&buddy("peer"), &elsewhere.id, true, "foreign-denied"), Err(CoreError::Denied(_))));

    assert!(!s.inbox(&Actor::Owner, WS).unwrap().channels.iter().any(|c| c.channel.id == channel.id));
    assert_eq!(s.archived_channels(&Actor::Owner, WS).unwrap()[0].id, channel.id);
    assert_eq!(s.open_channel(&Actor::Owner, channel_ref()).unwrap().archived_at, archived.archived_at);
    assert_eq!(s.search_posts(&Actor::Owner, WS, &SearchQuery::text("remember"), None, 10).unwrap().posts[0].id, post.id);
    assert!(s.post(&Actor::Owner, channel_ref(), PostInput { kind: PostKind::Inform, reply_to_id: Some(post.id.clone()), ..request("no", "no") }).is_err());
    s.set_channel_archived(&Actor::Owner, &channel.id, false, "restore").unwrap();
    assert!(s.archived_channels(&Actor::Owner, WS).unwrap().is_empty());
    s.post(&Actor::Owner, channel_ref(), PostInput { kind: PostKind::Inform, ..request("yes", "yes") }).unwrap();
    let direct = s.open_channel(&Actor::Owner, dm("mid", "ic")).unwrap();
    assert!(s.set_channel_archived(&Actor::Owner, &direct.id, true, "no-dm").is_err());
}

#[test]
fn channel_rename_preserves_identity_and_history() {
    let mut f = fixture();
    let s = &mut f.store;
    let channel = s
        .create_channel(
            &buddy("ic"),
            ChannelInput { workspace_id: WS.into(), name: "old-name".into(), purpose: "history".into(), key: "rename-channel".into() },
        )
        .unwrap();
    let post = s
        .post(
            &buddy("ic"),
            ChannelRef::Id { id: channel.id.clone() },
            PostInput { kind: PostKind::Inform, ..request("remember", "remember") },
        )
        .unwrap();

    let renamed = s.rename_channel(&buddy("peer"), &channel.id, "features", "rename").unwrap();
    assert_eq!(renamed.id, channel.id);
    assert!(matches!(renamed.kind, ChannelKind::Public { ref name, ref purpose } if name == "features" && purpose == "history"));
    assert_eq!(s.rename_channel(&buddy("peer"), &channel.id, "features", "rename").unwrap().id, channel.id);
    assert_eq!(s.open_channel(&Actor::Owner, ChannelRef::Id { id: channel.id.clone() }).unwrap().kind, renamed.kind);
    assert_eq!(s.get_post(&Actor::Owner, &post.id).unwrap().id, post.id);

    assert!(matches!(s.rename_channel(&buddy("peer"), &channel.id, "other", "rename"), Err(CoreError::IdempotencyConflict(_))));
    let direct = s.open_channel(&Actor::Owner, dm("mid", "ic")).unwrap();
    assert!(s.rename_channel(&Actor::Owner, &direct.id, "not-a-dm", "direct").is_err());
}

// THREADS_VIEW_2026-09-28.md. Before thread_read, one cursor per channel counted every reply as
// channel unread, and the thread pane marked the CHANNEL read through a reply, silently skipping
// unseen top-level posts. These pin the split: replies belong to followed threads.
#[test]
fn followed_threads_track_replies_apart_from_the_channel() {
    let mut f = fixture();
    let s = &mut f.store;
    let general = s
        .create_channel(&Actor::Owner, ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "g".into() })
        .unwrap();
    let to = || ChannelRef::Id { id: general.id.clone() };
    let say = |body: &str, reply: Option<&Post>| PostInput { kind: PostKind::Inform, reply_to_id: reply.map(|p| p.id.clone()), ..request(body, body) };
    let unread = |s: &Store| {
        let inbox = s.inbox(&Actor::Owner, WS).unwrap();
        (inbox.channels.iter().find(|c| c.channel.id == general.id).unwrap().unread, inbox.unread_threads)
    };
    let order = |s: &Store| s.followed_threads(&Actor::Owner, WS, 10).unwrap().threads.into_iter().map(|t| t.root.id).collect::<Vec<_>>();

    let mine = s.post(&Actor::Owner, to(), say("mine", None)).unwrap();
    let theirs = s.post(&buddy("ic"), to(), say("theirs", None)).unwrap();
    s.mark_read(&Actor::Owner, &general.id, &theirs.id).unwrap();
    assert!(order(s).is_empty(), "a root without replies is no card");

    let r1 = s.post(&buddy("ic"), to(), say("r1", Some(&mine))).unwrap();
    let r2 = s.post(&buddy("mid"), to(), say("r2", Some(&mine))).unwrap();
    s.post(&buddy("ic"), to(), say("elsewhere", Some(&theirs))).unwrap();
    assert_eq!(unread(s), (0, 1), "replies never count as channel unread; only the followed thread is unread");

    let page = s.followed_threads(&Actor::Owner, WS, 10).unwrap();
    assert_eq!(page.threads.len(), 1, "a thread the owner never wrote in is not followed");
    assert_eq!(page.threads[0].participants, [Actor::Owner, buddy("ic"), buddy("mid")]);
    match &page.threads[0].tail {
        ThreadTail::Unread { hidden, posts } => {
            assert_eq!((*hidden, posts.iter().map(|p| &p.id).collect::<Vec<_>>()), (0, vec![&r1.id, &r2.id]))
        }
        other => panic!("expected unread, got {other:?}"),
    }

    s.mark_thread_read(&Actor::Owner, &mine.id, &r2.id).unwrap();
    s.mark_thread_read(&Actor::Owner, &mine.id, &r1.id).unwrap();
    assert_eq!(unread(s), (0, 0), "an older mark never moves the cursor back");
    s.mark_thread_read(&Actor::Owner, &theirs.id, &theirs.id).unwrap();
    assert_eq!(order(s), [mine.id.clone()], "reading a thread does not follow it");

    // Unread sorts first even when a caught-up thread has newer activity.
    let later = s.post(&Actor::Owner, to(), say("later", None)).unwrap();
    s.post(&buddy("ic"), to(), say("l1", Some(&later))).unwrap();
    s.post(&buddy("ic"), to(), say("r3", Some(&mine))).unwrap();
    let r4 = s.post(&Actor::Owner, to(), say("r4 mine", Some(&mine))).unwrap();
    assert_eq!(order(s), [later.id.clone(), mine.id.clone()], "l1 is unread; the owner's own r4 read `mine` through it");
    assert!(s.followed_threads(&Actor::Owner, WS, 1).unwrap().more);
    match &s.followed_threads(&Actor::Owner, WS, 10).unwrap().threads[1].tail {
        ThreadTail::CaughtUp { hidden, posts } => {
            assert_eq!((*hidden, posts.last().map(|p| &p.id)), (2, Some(&r4.id)), "the last two, the rest folded")
        }
        other => panic!("expected caught up, got {other:?}"),
    }

    // Also send to #channel: a flagged reply joins the channel feed and its unread count.
    assert!(matches!(s.post(&Actor::Owner, to(), PostInput { broadcast: true, ..say("top", None) }), Err(CoreError::Invalid(_))));
    let shared = s.post(&buddy("ic"), to(), PostInput { broadcast: true, ..say("decided", Some(&mine)) }).unwrap();
    let feed = s.list_posts(&Actor::Owner, PostQuery::Channel { channel_id: general.id.clone() }, None, 10).unwrap();
    assert_eq!(feed.posts[0].id, shared.id);
    assert!(feed.posts.iter().all(|p| p.root_id.is_none() || p.broadcast), "plain replies stay in their thread");
    assert_eq!(unread(s).0, 1, "the broadcast reply (`later` is the owner's own)");
}

#[test]
fn a_database_from_before_threads_arrives_caught_up() {
    let f = fixture();
    let mut s = f.store;
    let general = s
        .create_channel(&Actor::Owner, ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "g".into() })
        .unwrap();
    let to = || ChannelRef::Id { id: general.id.clone() };
    let say = |body: &str, reply: Option<&Post>| PostInput { kind: PostKind::Inform, reply_to_id: reply.map(|p| p.id.clone()), ..request(body, body) };
    let root = s.post(&buddy("ic"), to(), say("root", None)).unwrap();
    s.post(&Actor::Owner, to(), say("me too", Some(&root))).unwrap();
    s.post(&buddy("ic"), to(), say("answer", Some(&root))).unwrap();
    drop(s);
    // Moving the table aside is a database from before it: `open` recreates and backfills it.
    rusqlite::Connection::open(&f.path).unwrap().execute_batch("ALTER TABLE thread_read RENAME TO thread_read_aside;").unwrap();

    let s = Store::open(f.path.to_str().unwrap()).unwrap();
    let page = s.followed_threads(&Actor::Owner, WS, 10).unwrap();
    assert_eq!(page.threads.len(), 1, "backfilled from the owner's reply");
    assert!(matches!(page.threads[0].tail, ThreadTail::CaughtUp { .. }), "history is read, not a wall of unread");
    assert!(s.followed_threads(&buddy("ic"), WS, 10).unwrap().threads.is_empty(), "the backfill is the owner's only");
}

// Decision 2026-10-06 (agent_notes/2026-10-06_dm-is-one-to-one-decision.md): a DM is one-to-one.
// Before it, a request to a group DM started one run per member (2026-10-01) and the CEO's
// duplicate Warp/PTX worker came from two owners of one request. A group is a public channel.
#[test]
fn a_dm_is_one_to_one_and_a_legacy_group_dm_is_read_only() {
    let mut f = fixture();
    let group = ChannelRef::Direct { members: vec![buddy("mid"), buddy("ic"), buddy("peer")] };
    let refused = f.store.post(&buddy("mid"), group.clone(), request("both of you", "g1")).unwrap_err();
    assert!(refused.to_string().contains("public channel"), "{refused}");
    assert!(f.store.post(&buddy("mid"), group.clone(), PostInput { kind: PostKind::Inform, ..request("fyi", "g2") }).is_err(), "an inform is refused too");
    assert!(f.store.open_channel(&buddy("mid"), group.clone()).is_err(), "the group channel is never created");
    assert!(f.store.list_runs(RunQuery::Queued, 10).unwrap().is_empty());

    // 1:1 and a note to self still work, and the single other member owes the answer.
    let solo = f.store.post(&buddy("mid"), dm("mid", "ic"), request("just you", "s1")).unwrap();
    f.store.post(&buddy("mid"), ChannelRef::Direct { members: vec![buddy("mid")] }, request("remember", "n1")).unwrap();
    let owed: Vec<_> = f.store.list_runs(RunQuery::Queued, 10).unwrap().into_iter().map(|r| r.buddy_id).collect();
    assert!(owed.contains(&"ic".to_string()) && owed.contains(&"mid".to_string()) && owed.len() == 2, "{owed:?}");

    // A group DM written before the rule exists in the db: readable, but no new post.
    let conn = rusqlite::Connection::open(&f.path).unwrap();
    conn.execute(
        "INSERT INTO channel (id, workspace_id, kind, member_key, created_by, created_at) VALUES ('dm_old', ?1, 'direct', 'ic,mid,peer', 'mid', '2026-01-01T00:00:00.000Z')",
        [WS],
    )
    .unwrap();
    for m in ["ic", "mid", "peer"] {
        conn.execute("INSERT INTO channel_member (channel_id, member) VALUES ('dm_old', ?1)", [m]).unwrap();
    }
    conn.execute(
        "INSERT INTO post (id, channel_id, author_id, body, evidence, created_at, ord) VALUES ('post_old', 'dm_old', 'mid', 'old chatter', '[]', '2026-01-01T00:00:00.000Z', '1')",
        [],
    )
    .unwrap();
    let page = f.store.list_posts(&buddy("peer"), PostQuery::Channel { channel_id: "dm_old".into() }, None, 10).unwrap();
    assert_eq!(page.posts.len(), 1);
    assert!(f.store.post(&buddy("peer"), ChannelRef::Id { id: "dm_old".into() }, PostInput { kind: PostKind::Inform, ..request("more", "g3") }).is_err());

    // A run written before the fix carries the bare `post:<id>` key; enqueueing the same post for
    // the same buddy must find it, not start a second run.
    let run = f.store.list_runs(RunQuery::Queued, 10).unwrap().into_iter().find(|r| r.input_key.starts_with(&format!("post:{}", solo.id))).unwrap();
    rusqlite::Connection::open(&f.path)
        .unwrap()
        .execute("UPDATE run SET input_key = ?1 WHERE id = ?2", rusqlite::params![format!("post:{}", solo.id), run.id])
        .unwrap();
    let again = f
        .store
        .enqueue_run(&Actor::Owner, EnqueueInput {
            buddy_id: "ic".into(),
            input: RunInput::Post { post_id: solo.id.clone() },
            conversation_id: Some("c".into()),
            task_id: None,
            after_run_id: None,
            deadline: None,
            config: None,
        })
        .unwrap();
    assert_eq!(again.id, run.id, "a pre-fix run is still matched by its legacy key");
}

// Regression guard (fresh-install trial 2026-10-05): a new workspace had no #general, so Home had
// no composer. Re-registering the folder (every server start runs bootstrap) must not add another,
// and an archived #general keeps the name, so nothing may try to create a second or error.
#[test]
fn new_workspace_has_general_once() {
    let mut f = fixture();
    let s = &mut f.store;
    let folder = WorkspaceInput { name: "Fresh".into(), root_path: "/tmp/fresh".into() };
    let ws = s.create_workspace(&Actor::Owner, folder.clone()).unwrap();
    s.create_workspace(&Actor::Owner, folder).unwrap();
    let general = |s: &Store| -> Vec<Channel> {
        s.inbox(&Actor::Owner, &ws.id).unwrap().channels.into_iter().map(|c| c.channel).filter(|c| matches!(&c.kind, ChannelKind::Public { name, .. } if name == "general")).collect()
    };
    let found = general(s);
    assert_eq!(found.len(), 1, "one #general after create + re-register");

    s.set_channel_archived(&Actor::Owner, &found[0].id, true, "arch").unwrap();
    s.create_workspace(&Actor::Owner, WorkspaceInput { name: "Fresh".into(), root_path: "/tmp/fresh".into() }).unwrap();
    assert!(general(s).is_empty(), "archived #general stays archived; no replacement appears");
    assert_eq!(s.archived_channels(&Actor::Owner, &ws.id).unwrap().len(), 1);
}

#[test]
fn structured_search_filters_before_paging_and_never_leaves_readable_channels() {
    // Main's search was literal words only: no phrase, exclusion, OR or filters, and FTS operators
    // in the query were swallowed as words. Filters must narrow BEFORE the keyset page, or a page
    // of 3 could come back short/empty while matches exist further back.
    let mut f = fixture();
    let (general, ops) = ["general", "ops"].map(|name| {
        f.store
            .create_channel(&Actor::Owner, ChannelInput { workspace_id: WS.into(), name: name.into(), purpose: "p".into(), key: name.into() })
            .unwrap()
    }).into();
    let on = |c: &Channel| ChannelRef::Id { id: c.id.clone() };
    let say = |body: &str, key: &str| PostInput { kind: PostKind::Inform, from_conversation_id: None, ..request(body, key) };
    let s = &mut f.store;
    let mut put = |who: Actor, ch: ChannelRef, body: &str, day: &str| {
        let id = s.post(&who, ch, say(body, &format!("k-{body}"))).unwrap().id;
        (id, day.to_string())
    };
    let mut dated = vec![
        put(Actor::Owner, on(&general), "deploy window opens friday", "2026-03-01"),
        put(buddy("lead"), on(&general), "deploy the canary on friday", "2026-03-05"),
        put(buddy("lead"), on(&general), "deploy draft notes", "2026-03-10"),
        put(buddy("peer"), on(&ops), "canary deploy window closed", "2026-03-15"),
        put(buddy("lead"), dm("lead", "mid"), "deploy secret between lead and mid", "2026-03-16"),
    ];
    for i in 0..6 {
        dated.push(put(buddy("lead"), on(&ops), &format!("deploy bulk {i}"), "2026-03-20"));
    }
    drop(put);
    let conn = rusqlite::Connection::open(&f.path).unwrap();
    for (id, day) in &dated {
        conn.execute("UPDATE post SET created_at = ?1 WHERE id = ?2", rusqlite::params![format!("{day}T12:00:00.000Z"), id]).unwrap();
    }
    let root = dated[0].0.clone();
    let reply = f.store.post(&buddy("lead"), on(&general), PostInput { reply_to_id: Some(root.clone()), ..say("a reply in thread", "r") }).unwrap();
    let s = &f.store;
    let search = |who: &Actor, q: SearchQuery| s.search_posts(who, WS, &q, None, 50).unwrap().posts.into_iter().map(|p| p.body).collect::<Vec<_>>();
    let q = |text: &str| SearchQuery::text(text);
    let peer = buddy("peer");

    assert_eq!(search(&peer, q("window friday")), ["deploy window opens friday"], "words: all must match");
    assert_eq!(search(&peer, q("\"window friday\"")).len(), 0, "a phrase is adjacent words");
    assert_eq!(search(&peer, q("\"deploy window\"")), ["canary deploy window closed", "deploy window opens friday"]);
    assert_eq!(search(&peer, q("deploy -canary -draft -bulk")), ["deploy window opens friday"], "exclusion");
    assert_eq!(search(&peer, q("draft OR canary -window")), ["deploy draft notes", "deploy the canary on friday"], "OR with a global exclusion");
    assert_eq!(search(&peer, q("draft OR window friday")), ["deploy draft notes", "deploy window opens friday"], "AND binds tighter than OR");
    for bad in ["", "\"open", "-x", "a OR", "OR"] {
        assert!(matches!(s.search_posts(&peer, WS, &q(bad), None, 5), Err(CoreError::Invalid(_))), "{bad:?}");
    }
    let with = |text: &str, edit: &dyn Fn(&mut SearchQuery)| {
        let mut query = q(text);
        edit(&mut query);
        query
    };
    assert_eq!(search(&peer, with("deploy", &|x| x.channels = vec!["#general".into()])).len(), 3, "channel by name, # optional");
    assert_eq!(search(&peer, with("deploy", &|x| x.channels = vec![ops.id.clone()])).len(), 7, "channel by id");
    assert_eq!(search(&peer, with("deploy", &|x| x.from = vec!["owner".into()])), ["deploy window opens friday"]);
    assert_eq!(search(&peer, with("deploy", &|x| x.from = vec!["peer".into(), "owner".into()])).len(), 2);
    let range = with("deploy", &|x| {
        x.after = Some("2026-03-05".into());
        x.before = Some("2026-03-15T12:00:00Z".into());
    });
    assert_eq!(search(&peer, range), ["deploy draft notes", "deploy the canary on friday"], "after inclusive, before exclusive");
    assert_eq!(search(&peer, with("reply OR window", &|x| x.in_thread = Some(root.clone()))), [reply.body.clone(), "deploy window opens friday".into()], "the root and its replies only");
    assert!(matches!(s.search_posts(&peer, WS, &with("deploy", &|x| x.after = Some("last week".into())), None, 5), Err(CoreError::Invalid(_))));

    // Authorization: no filter can reach a DM the reader is not in.
    let secret = |who: &Actor, edit: &dyn Fn(&mut SearchQuery)| search(who, with("secret", edit));
    assert!(secret(&peer, &|_| {}).is_empty());
    assert!(secret(&peer, &|x| x.from = vec!["lead".into()]).is_empty());
    assert!(secret(&peer, &|x| x.after = Some("2026-03-16".into())).is_empty());
    assert_eq!(secret(&buddy("mid"), &|x| x.from = vec!["lead".into()]).len(), 1, "a member still finds it");
    let dm_channel = dated[4].0.clone();
    let dm_id = s.get_post(&Actor::Owner, &dm_channel).unwrap().channel_id;
    assert!(secret(&peer, &|x| x.channels = vec![dm_id.clone()]).is_empty(), "naming the DM's id does not open it");

    // Paging a filtered result: lead in #ops, 6 hits, 4 per page-of-2 pages, no gap or duplicate.
    let filtered = with("deploy", &|x| {
        x.channels = vec!["ops".into()];
        x.from = vec!["lead".into()];
        x.after = Some("2026-03-20".into());
    });
    let (mut seen, mut cursor, mut pages) = (Vec::new(), None, 0);
    loop {
        let page = s.search_posts(&peer, WS, &filtered, cursor, 4).unwrap();
        pages += 1;
        seen.extend(page.posts.into_iter().map(|p| p.body));
        match page.next {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    assert_eq!(pages, 2);
    assert_eq!(seen, (0..6).rev().map(|i| format!("deploy bulk {i}")).collect::<Vec<_>>());
}

// Thread follows (2026-10-04) became subscriptions (2026-10-06, decision D2 and delivery design
// Task 3): `follow` subscribes the reading conversation, `follow:false` unsubscribes it, and a post
// by someone else is a durable delivery to that conversation. Before follows a Buddy waiting on
// another's work in a thread had no wake at all.
fn follow_fixture(s: &mut Store) -> (Post, impl Fn(&str, &str) -> PostInput + use<>) {
    let general = s
        .create_channel(&Actor::Owner, ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "g".into() })
        .unwrap();
    let say = |body: &str, key: &str| PostInput { kind: PostKind::Inform, from_conversation_id: None, ..request(body, key) };
    let root = s.post(&Actor::Owner, ChannelRef::Id { id: general.id }, say("ship the model", "root")).unwrap();
    let root_id = root.id.clone();
    (root, move |body: &str, key: &str| PostInput { reply_to_id: Some(root_id.clone()), ..say(body, key) })
}

fn bodies(posts: &[Post]) -> Vec<&str> {
    posts.iter().map(|p| p.body.as_str()).collect()
}

#[test]
fn a_follow_returns_the_unread_posts_once_and_subscribes() {
    let mut f = fixture();
    let s = &mut f.store;
    let (root, reply) = follow_fixture(s);
    let channel = ChannelRef::Id { id: root.channel_id.clone() };
    s.post(&buddy("peer"), channel.clone(), reply("first", "a")).unwrap();
    s.post(&buddy("mid"), channel.clone(), reply("mine", "m")).unwrap();
    s.post(&buddy("peer"), channel, reply("second", "b")).unwrap();
    // A Buddy that never followed a public thread is delivered nothing in a conversation. A
    // participant gets only the follow-up gate's run (no conversation; owner decision 2026-10-07).
    let mut gated = Vec::new();
    while let Some(claim) = s.claim_run(lease(60_000), &[]).unwrap() {
        gated.push((claim.run.buddy_id.clone(), claim.run.conversation_id.clone()));
        s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Cancelled { reason: "gate said no".into() }).unwrap();
    }
    gated.sort();
    assert_eq!(gated, [("mid".to_string(), None), ("peer".to_string(), None)]);
    // "mine" was written without "first" being shown, so it did not read past it (decision K).
    let read = s.follow_thread(&buddy("mid"), &root.id, Some("conv-mid".into()), 20).unwrap();
    assert_eq!((bodies(&read.posts), read.unshown), (vec!["ship the model", "first", "second"], 0));
    assert!(s.catch_up_thread(&buddy("mid"), &root.id, 20).unwrap().posts.is_empty(), "returning them read them");
    assert!(matches!(s.follow_thread(&Actor::Owner, &root.id, Some("c".into()), 20), Err(CoreError::Invalid(_))), "the owner reads in the app");
}

#[test]
fn a_followed_thread_delivers_anothers_post_to_the_following_conversation() {
    let mut f = fixture();
    let s = &mut f.store;
    let (root, reply) = follow_fixture(s);
    let channel = ChannelRef::Id { id: root.channel_id.clone() };
    s.follow_thread(&buddy("mid"), &root.id, Some("conv-mid".into()), 20).unwrap();
    s.post(&buddy("mid"), channel.clone(), reply("on it", "own")).unwrap();
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_none(), "the follower's own post wakes nobody");
    let news = s.post(&buddy("peer"), channel.clone(), reply("model is green", "news")).unwrap();
    assert_eq!(s.responding(&root.channel_id).unwrap().iter().map(|r| r.buddy_id.as_str()).collect::<Vec<_>>(), ["mid"], "the delivery is what shows mid replying");

    let claim = s.claim_run(lease(60_000), &[]).unwrap().expect("another's post is delivered now");
    assert_eq!((&claim.run.input, claim.run.conversation_id.as_deref()), (&RunInput::Deliver { post_id: news.id.clone() }, Some("conv-mid")));
    s.post(&buddy("peer"), channel.clone(), reply("one more thing", "late")).unwrap();
    let Delivery::Posts { posts, .. } = s.deliver_posts(&claim.run.id).unwrap() else { panic!() };
    assert_eq!(bodies(&posts), ["model is green", "one more thing"]);
    s.mark_executing(&claim.run.id, &claim.lease_token).unwrap();
    // The runner composes the job again when an adopted turn finishes: `through_ord` is fixed, so a
    // post during the turn is neither shown nor marked read by that second call.
    s.post(&buddy("peer"), channel, reply("during the turn", "during")).unwrap();
    assert!(matches!(s.deliver_posts(&claim.run.id).unwrap(), Delivery::Consumed));
    assert_eq!(bodies(&s.catch_up_thread(&buddy("mid"), &root.id, 20).unwrap().posts), ["during the turn"]);
}

#[test]
fn follow_false_unsubscribes_and_a_read_first_delivery_is_consumed() {
    let mut f = fixture();
    let s = &mut f.store;
    let (root, reply) = follow_fixture(s);
    let channel = ChannelRef::Id { id: root.channel_id.clone() };
    s.follow_thread(&buddy("mid"), &root.id, Some("conv-mid".into()), 20).unwrap();
    let news = s.post(&buddy("peer"), channel.clone(), reply("done", "d")).unwrap();
    s.mark_thread_read(&buddy("mid"), &root.id, &news.id).unwrap();
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_none(), "read first: the delivery settled consumed");
    s.follow_thread(&buddy("mid"), &root.id, None, 20).unwrap();
    s.post(&buddy("peer"), channel, reply("after", "a")).unwrap();
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_none(), "unsubscribed: nothing is delivered");
}

// 2026-09-29 queue stall (888861c): a database created before run_active_buddy existed failed every
// claim_run with "no such index" because the index was DDL-only.
#[test]
fn claim_run_works_on_a_database_missing_run_active_buddy() {
    let f = fixture();
    let (path, _dir) = (f.path.clone(), f.dir);
    drop(f.store);
    rusqlite::Connection::open(&path).unwrap().execute_batch("DROP INDEX run_active_buddy;").unwrap();
    let mut s = Store::open(path.to_str().unwrap()).unwrap();
    s.enqueue_chat(&Actor::Owner, chat("peer", "t1", "conv")).unwrap();
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_some());
}

// 2026-10-06: the lean rewrite (0fef9d4) dropped `buddy.retry_run` (17 uses); a Buddy whose worker
// failed could only re-ask from scratch. A retry is the next attempt on the same input key, the
// request goes back to awaiting, and the answer reaches the asker's subscribed conversation. Rule 5:
// it stays in the failed attempt's conversation unless it moves to another provider.
#[test]
fn retrying_a_failed_run_makes_attempt_two_and_reopens_the_request() {
    let mut f = fixture();
    let s = &mut f.store;
    let fail = |s: &mut Store, conversation: &str| {
        let claim = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
        s.bind_run(&claim.run.id, &claim.lease_token, conversation).unwrap();
        s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Failed { code: "provider_error".into(), error: "boom".into() }).unwrap()
    };
    let read_notice = |s: &mut Store| {
        let notice = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
        assert_eq!(notice.run.buddy_id, "mid", "the failure post is delivered to the asker");
        s.settle_run(&notice.run.id, &notice.lease_token, Outcome::Complete { text: "read".into() }).unwrap();
    };
    let asked = s.post(&buddy("mid"), dm("mid", "ic"), request("please do X", "r1")).unwrap();
    let first = fail(s, "w1");
    assert_eq!(s.get_post(&buddy("mid"), &asked.id).unwrap().request, RequestState::Failed);
    read_notice(s);

    let sol = RunConfig { provider: "codex".into(), model: Some("gpt-6-sol".into()), reasoning_effort: None };
    let retry = s.retry_run(&buddy("mid"), &first.id, Some(sol.clone()), "k1").unwrap();
    assert_eq!((retry.attempt, retry.status, &retry.input, &retry.config), (2, RunStatus::Queued, &first.input, &Some(sol.clone())));
    assert_eq!((retry.input_key.as_str(), retry.conversation_id.as_deref()), (first.input_key.as_str(), None), "a profile run moved to a worker model starts fresh");
    assert_eq!(s.get_post(&buddy("mid"), &asked.id).unwrap().request, RequestState::Awaiting);
    assert_eq!(s.retry_run(&buddy("mid"), &first.id, Some(sol.clone()), "k1").unwrap().id, retry.id, "a replayed key returns the same retry");

    // Live, already-retried and complete runs are typed errors, never silent no-ops.
    let live = s.retry_run(&buddy("mid"), &retry.id, None, "k2");
    assert!(matches!(live, Err(CoreError::Invalid(_))), "{live:?}");
    let stale = s.retry_run(&buddy("mid"), &first.id, None, "k3");
    assert!(matches!(stale, Err(CoreError::Invalid(_))), "attempt 1 is not the latest: {stale:?}");

    let second = fail(s, "w2");
    read_notice(s);
    let third = s.retry_run(&buddy("mid"), &second.id, None, "k4").unwrap();
    assert_eq!((third.attempt, third.conversation_id.as_deref()), (3, Some("w2")), "same model: same conversation");

    let claim = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert_eq!(claim.run.id, third.id);
    let done = s.answer(&buddy("ic"), answer_input(&asked.id, "done", "a")).unwrap();
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    let back = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert_eq!((back.run.buddy_id.as_str(), &back.run.input), ("mid", &RunInput::Deliver { post_id: done.id }));
    let complete = s.retry_run(&buddy("mid"), &third.id, None, "k5");
    assert!(matches!(complete, Err(CoreError::Invalid(_))), "a complete run has nothing to retry: {complete:?}");
}

#[test]
fn retry_authority_is_the_requester_a_manager_or_the_owner_and_only_managers_pick_the_model() {
    let mut f = fixture();
    let s = &mut f.store;
    let asked = s.post(&buddy("peer"), dm("peer", "ic"), request("please do X", "r1")).unwrap();
    let claim = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    let failed = s
        .settle_run(&claim.run.id, &claim.lease_token, Outcome::Failed { code: "provider_error".into(), error: "boom".into() })
        .unwrap();
    assert_eq!(asked.request, RequestState::Awaiting);
    let sol = RunConfig { provider: "codex".into(), model: Some("gpt-6-sol".into()), reasoning_effort: None };

    let stranger = s.retry_run(&buddy("gone"), &failed.id, None, "k0");
    assert!(matches!(stranger, Err(CoreError::Denied(_))), "{stranger:?}");
    let requester_picks_model = s.retry_run(&buddy("peer"), &failed.id, Some(sol), "k1");
    assert!(matches!(requester_picks_model, Err(CoreError::Denied(_))), "a requester cannot move a peer's run off its profile");
    assert_eq!(s.retry_run(&buddy("peer"), &failed.id, None, "k2").unwrap().attempt, 2, "the requester may retry as-is");

    let notice = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert_eq!(notice.run.buddy_id, "peer", "the requester is told by the failure post");
    s.settle_run(&notice.run.id, &notice.lease_token, Outcome::Complete { text: "read".into() }).unwrap();
    let claim = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    assert_eq!(claim.run.attempt, 2);
    let failed2 = s
        .settle_run(&claim.run.id, &claim.lease_token, Outcome::Failed { code: "provider_error".into(), error: "boom".into() })
        .unwrap();
    assert_eq!(s.retry_run(&buddy("lead"), &failed2.id, None, "k3").unwrap().attempt, 3, "a transitive manager may retry");
}

// 2026-10-06: `inbox.waiting_on` was buddy-wide while `channels` and `unread_threads` were scoped to
// the turn's workspace, so another workspace's open requests leaked into this inbox. The second
// workspace is made by moving one DM channel; the post, author and awaiting state stay as written.
#[test]
fn inbox_waiting_on_is_scoped_to_the_workspace() {
    let mut f = fixture();
    let path = f.path.clone();
    let s = &mut f.store;
    s.post(&buddy("mid"), dm("mid", "ic"), request("here", "r-here")).unwrap();
    let there = s.post(&buddy("mid"), dm("mid", "peer"), request("elsewhere", "r-there")).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("INSERT INTO workspace (id, name, root_path, created_at) VALUES ('ws_2', 'ws2', '/tmp/ws2', '2026-01-01T00:00:00.000Z')", [])
        .unwrap();
    conn.execute("UPDATE channel SET workspace_id = 'ws_2' WHERE id = ?1", [&there.channel_id]).unwrap();
    drop(conn);
    let here: Vec<_> = s.inbox(&buddy("mid"), WS).unwrap().waiting_on.into_iter().map(|p| p.id).collect();
    assert_eq!(here.len(), 1);
    assert!(!here.contains(&there.id));
    assert_eq!(s.inbox(&buddy("mid"), "ws_2").unwrap().waiting_on.len(), 1);
}

// 2026-10-06: buddy and task run lists returned the 20 newest runs ever (60-95k chars of old
// errors); only the workspace scope had the live-then-last-12h window. All scopes share it now.
#[test]
fn run_rows_share_one_window_across_scopes() {
    let mut f = fixture();
    let path = f.path.clone();
    let s = &mut f.store;
    s.enqueue_chat(&Actor::Owner, chat("peer", "old", "old")).unwrap();
    let old = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    s.settle_run(&old.run.id, &old.lease_token, Outcome::Complete { text: "done".into() }).unwrap();
    s.enqueue_chat(&Actor::Owner, chat("peer", "new", "new")).unwrap();
    let new = s.claim_run(lease(60_000), &[]).unwrap().unwrap();
    s.settle_run(&new.run.id, &new.lease_token, Outcome::Complete { text: "done".into() }).unwrap();
    s.enqueue_chat(&Actor::Owner, chat("peer", "live", "live")).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE run SET ended_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1", [&old.run.id]).unwrap();
    drop(conn);
    let ids = |q: ListScope| s.list_run_rows(&Actor::Owner, q, 100).unwrap().into_iter().map(|r| r.id).collect::<Vec<_>>();
    for rows in [
        ids(ListScope::Buddy { buddy_id: "peer".into() }),
        ids(ListScope::Workspace { workspace_id: WS.into() }),
    ] {
        assert_eq!(rows.len(), 2, "queued + recently ended; the 2020 run is outside the window");
        assert!(rows.contains(&new.run.id) && !rows.contains(&old.run.id));
    }
}

// Step 5 (task_01a11013-b205): an @mention is a delivery, in the post's own transaction.
#[test]
fn a_mention_is_a_delivery_with_no_conversation_until_the_buddy_has_one_in_the_thread() {
    let mut f = fixture();
    let s = &mut f.store;
    let (root, reply) = follow_fixture(s);
    let channel = ChannelRef::Id { id: root.channel_id.clone() };
    let pick = RunConfig { provider: "codex".into(), model: None, reasoning_effort: None };
    let mention = |config: Option<RunConfig>| PostInput { mentions: vec![Mention { buddy_id: "peer".into(), config }], ..reply("peer, look", "m1") };
    s.post(&Actor::Owner, channel.clone(), mention(Some(pick.clone()))).unwrap();
    let claim = s.claim_run(lease(60_000), &[]).unwrap().expect("the mention woke peer");
    assert_eq!((claim.run.buddy_id.as_str(), claim.run.conversation_id.as_deref()), ("peer", None));
    assert_eq!(claim.run.config, Some(pick), "the owner's chip pick rides the run");
    let Delivery::Posts { posts, subscribed, .. } = s.deliver_posts(&claim.run.id).unwrap() else { panic!() };
    assert_eq!((bodies(&posts), subscribed), (vec!["ship the model", "peer, look"], None));
    // Once peer follows the thread from a conversation, the next mention goes there, once.
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    s.follow_thread(&buddy("peer"), &root.id, Some("conv-peer".into()), 20).unwrap();
    s.post(&Actor::Owner, channel, PostInput { mentions: vec![Mention { buddy_id: "peer".into(), config: None }], ..reply("again", "m2") }).unwrap();
    let again = s.claim_run(lease(60_000), &[]).unwrap().expect("delivered once");
    assert_eq!(again.run.conversation_id.as_deref(), Some("conv-peer"));
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_none(), "the fan-out skipped the mentioned subscriber: no second run");
}

// A failed attempt marked its trigger read when it started; its retry must still show it.
#[test]
fn a_retried_delivery_shows_its_trigger_and_a_second_click_starts_nothing() {
    let mut f = fixture();
    let s = &mut f.store;
    let (root, reply) = follow_fixture(s);
    let channel = ChannelRef::Id { id: root.channel_id.clone() };
    let trigger = s.post(&Actor::Owner, channel, PostInput { mentions: vec![Mention { buddy_id: "peer".into(), config: None }], ..reply("peer, please", "m1") }).unwrap();
    let claim = claim_executing(s, "2099-01-01T00:00:00.000Z", lease(60_000));
    s.deliver_posts(&claim.run.id).unwrap();
    s.mark_executing(&claim.run.id, &claim.lease_token).unwrap();
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Failed { code: "execution_failed".into(), error: "out of tokens".into() }).unwrap();
    let to = |model: &str| RunConfig { provider: "claude".into(), model: Some(model.into()), reasoning_effort: None };
    let retry = s.retry_delivery(&Actor::Owner, &trigger.id, "peer", to("opus")).unwrap();
    assert_eq!(retry.attempt, 2);
    assert_eq!(s.retry_delivery(&Actor::Owner, &trigger.id, "peer", to("sonnet")).unwrap().id, retry.id, "a queued retry is not doubled");
    let again = s.claim_run(lease(60_000), &[]).unwrap().expect("the retry runs");
    let Delivery::Posts { posts, .. } = s.deliver_posts(&again.run.id).unwrap() else { panic!("a retry showing nothing would answer nothing") };
    assert!(posts.iter().any(|p| p.id == trigger.id));
}

// Two mentions of one Buddy in one thread must not open its seat twice (both would reply).
#[test]
fn deliveries_to_one_buddy_in_one_thread_run_one_at_a_time_until_it_has_a_conversation() {
    let mut f = fixture();
    let s = &mut f.store;
    let (root, reply) = follow_fixture(s);
    let channel = ChannelRef::Id { id: root.channel_id.clone() };
    let wake = || vec![Mention { buddy_id: "peer".into(), config: None }];
    s.post(&Actor::Owner, channel.clone(), PostInput { mentions: wake(), ..reply("one", "m1") }).unwrap();
    s.post(&Actor::Owner, channel, PostInput { mentions: wake(), ..reply("two", "m2") }).unwrap();
    let first = s.claim_run(lease(60_000), &[]).unwrap().expect("the first");
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_none(), "the second waits for the first's conversation");
    s.settle_run(&first.run.id, &first.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_some());
}

// Owner decision 2026-10-07 (agent_notes/2026-10-06_buddies-target-system-review.md, item 7 and 8):
// step 5 made posting subscribe in public and task threads too, so replies followed whichever
// conversation wrote last. Back to step 4's seam: a thread's follow-up reaches the Buddy's seat
// (a run with no conversation), and only DMs, requests and explicit follows subscribe.
#[test]
fn posting_in_a_public_thread_does_not_subscribe_and_a_follow_up_goes_to_the_seat() {
    let mut f = fixture();
    let s = &mut f.store;
    let (root, reply) = follow_fixture(s);
    let channel = ChannelRef::Id { id: root.channel_id.clone() };
    s.post(&buddy("peer"), channel.clone(), PostInput { from_conversation_id: Some("conv-peer".into()), ..reply("on it", "p1") }).unwrap();
    s.post(&Actor::Owner, channel.clone(), reply("and then?", "o1")).unwrap();
    let claim = s.claim_run(lease(60_000), &[]).unwrap().expect("peer posted here, so the gate is asked");
    assert_eq!((claim.run.buddy_id.as_str(), claim.run.conversation_id.as_deref()), ("peer", None));
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Cancelled { reason: "gate said no".into() }).unwrap();
    // A failure notice is not announced: it starts no gate.
    s.post(&buddy("mid"), channel, PostInput { purpose: Some("reply_failed".into()), ..reply("Couldn't reply", "f1") }).unwrap();
    assert!(s.claim_run(lease(60_000), &[]).unwrap().is_none());
}

// Owner decision 2026-10-07: a seat opened for an @mention is bound to its run but not subscribed.
// A subscribed seat would be delivered every later post of the thread without the follow-up gate.
#[test]
fn a_seat_bound_in_a_public_thread_is_not_subscribed() {
    let mut f = fixture();
    let s = &mut f.store;
    let (root, reply) = follow_fixture(s);
    let channel = ChannelRef::Id { id: root.channel_id.clone() };
    let mention = vec![Mention { buddy_id: "peer".into(), config: None }];
    s.post(&Actor::Owner, channel.clone(), PostInput { mentions: mention, ..reply("peer, look", "m1") }).unwrap();
    let claim = s.claim_run(lease(60_000), &[]).unwrap().expect("the mention woke peer");
    s.bind_run(&claim.run.id, &claim.lease_token, "seat-peer").unwrap();
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    s.post(&buddy("peer"), channel.clone(), reply("looking", "p1")).unwrap();
    s.post(&Actor::Owner, channel, reply("thanks, and?", "o2")).unwrap();
    let next = s.claim_run(lease(60_000), &[]).unwrap().expect("a follow-up for the participant");
    assert_eq!((next.run.buddy_id.as_str(), next.run.conversation_id.as_deref()), ("peer", None), "gate-bound, not delivered to the seat");
}
