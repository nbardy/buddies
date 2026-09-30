mod common;

use common::{WS, buddy, fixture};
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
        run_config: None,
        broadcast: false,
        key: key.into(),
    }
}

fn chat(buddy_id: &str, turn: &str, conversation: &str) -> EnqueueInput {
    EnqueueInput {
        buddy_id: buddy_id.into(),
        input: RunInput::Chat { turn_id: turn.into() },
        conversation_id: Some(conversation.into()),
        task_id: None,
        after_run_id: None,
        deadline: None,
        config: None,
    }
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
        setup.enqueue_run(&Actor::Owner, chat("peer", &format!("turn-{round}"), &format!("conv-{round}"))).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let winners: Vec<Option<Claim>> = (0..2)
            .map(|_| {
                let (barrier, path) = (barrier.clone(), path.clone());
                std::thread::spawn(move || {
                    let mut store = Store::open(&path).unwrap();
                    barrier.wait();
                    store.claim_run(60_000).unwrap()
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
    s.enqueue_run(&Actor::Owner, chat("peer", "t1", "c1")).unwrap();
    let claim = s.claim_run_at("2099-01-01T00:00:00.000Z", 1_000).unwrap().unwrap();
    let wrong = s.settle_run(&claim.run.id, "not-the-token", Outcome::Complete { text: "x".into() }).unwrap_err();
    assert!(matches!(wrong, CoreError::LeaseLost(_)));
    // The next claim after expiry fails the abandoned run instead of leaving it running forever.
    assert!(s.claim_run_at("2099-01-01T00:00:05.000Z", 1_000).unwrap().is_none());
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
    s.enqueue_run(&Actor::Owner, chat("peer", "t1", "same")).unwrap();
    s.enqueue_run(&Actor::Owner, chat("peer", "t2", "same")).unwrap();
    let first = s.claim_run(60_000).unwrap().unwrap();
    assert!(s.claim_run(60_000).unwrap().is_none(), "the conversation is busy");
    s.settle_run(&first.run.id, &first.lease_token, Outcome::Complete { text: "done".into() }).unwrap();
    assert_eq!(s.claim_run(60_000).unwrap().unwrap().run.input, RunInput::Chat { turn_id: "t2".into() });
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

    let claim = s.claim_run(60_000).unwrap().unwrap();
    assert_eq!((claim.run.buddy_id.as_str(), &claim.run.input), ("ic", &RunInput::Post { post_id: asked.id.clone() }));
    let answer = s
        .answer(
            &buddy("ic"),
            AnswerInput { request_id: asked.id.clone(), body: "done".into(), evidence: vec!["a.md".into()], key: "rep".into() },
        )
        .unwrap();
    assert_eq!(
        (answer.channel_id.as_str(), answer.reply_to_id.as_deref(), answer.root_id.as_deref(), &answer.author),
        (asked.channel_id.as_str(), Some(asked.id.as_str()), Some(asked.id.as_str()), &buddy("ic")),
        "the answer is a reply post in the request's thread"
    );
    assert_eq!(s.get_post(&buddy("mid"), &asked.id).unwrap().request, RequestState::Answered { answer_id: answer.id.clone() });
    let again =
        s.answer(&buddy("ic"), AnswerInput { request_id: asked.id.clone(), body: "twice".into(), evidence: vec![], key: "rep2".into() });
    assert!(matches!(again, Err(CoreError::Invalid(_))), "a request is answered once");
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
    let back = s.claim_run(60_000).unwrap().unwrap();
    assert_eq!((back.run.buddy_id.as_str(), back.run.conversation_id.as_deref()), ("mid", Some("conv-sender")));
    assert_eq!(back.run.input, RunInput::Reply { post_id: asked.id.clone() });
    s.settle_run(&back.run.id, &back.lease_token, Outcome::Complete { text: "read".into() }).unwrap();

    s.mark_read(&buddy("ic"), &asked.channel_id, &answer.id).unwrap();
    s.mark_read(&buddy("ic"), &asked.channel_id, &asked.id).unwrap();
    assert_eq!(unread(s, "ic"), 0, "a cursor only moves forward");

    let failing = s.post(&buddy("mid"), dm("mid", "ic"), request("will fail", "r2")).unwrap();
    let claim = s.claim_run(60_000).unwrap().unwrap();
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Failed { code: "provider_error".into(), error: "boom".into() }).unwrap();
    assert_eq!(s.get_post(&buddy("mid"), &failing.id).unwrap().request, RequestState::Failed);
    let notice = s.claim_run(60_000).unwrap().unwrap();
    assert_eq!((notice.run.buddy_id.as_str(), notice.run.input), ("mid", RunInput::FailureNotice { run_id: claim.run.id }));
}

// 2026-09-28: no run could choose its model, so a Buddy launched four untracked `codex exec`
// workers from a thread (agent_notes/2026-09-28_buddy-worker-spawn-gap.md). A worker is a request
// with a run config: its run carries the config, and the answer returns to the spawning call.
#[test]
fn a_worker_request_runs_on_its_own_config_and_returns_to_the_spawner() {
    let mut f = fixture();
    let s = &mut f.store;
    let sol = RunConfig { provider: "codex".into(), model: "gpt-6-sol".into(), reasoning_effort: Some("high".into()) };
    let work = |body: &str, key: &str| PostInput { run_config: Some(sol.clone()), ..request(body, key) };
    let me_only = || ChannelRef::Direct { members: vec![buddy("mid")] };

    let first = s.post(&buddy("mid"), me_only(), work("sweep A", "w1")).unwrap();
    let second = s.post(&buddy("mid"), me_only(), work("sweep B", "w2")).unwrap();
    let a = s.claim_run(60_000).unwrap().unwrap();
    let b = s.claim_run(60_000).unwrap().unwrap();
    assert_eq!(
        [(&a.run.input, &a.run.config), (&b.run.input, &b.run.config)],
        [(&RunInput::Post { post_id: first.id.clone() }, &Some(sol.clone())), (&RunInput::Post { post_id: second.id.clone() }, &Some(sol.clone()))],
        "each worker is its own tracked run of the spawner, on the chosen model, in parallel"
    );
    s.answer(&buddy("mid"), AnswerInput { request_id: first.id.clone(), body: "A done".into(), evidence: vec![], key: "a1".into() }).unwrap();
    s.settle_run(&a.run.id, &a.lease_token, Outcome::Complete { text: "A done".into() }).unwrap();
    let back = s.claim_run(60_000).unwrap().unwrap();
    assert_eq!(
        (&back.run.input, back.run.conversation_id.as_deref(), &back.run.config),
        (&RunInput::Reply { post_id: first.id.clone() }, Some("conv-sender"), &None),
        "the result wakes the spawning conversation, on the spawner's own profile"
    );

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
                        .answer(&who, AnswerInput { request_id: id, body: format!("{who:?}"), evidence: vec![], key: format!("a-{round}") })
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
    let run = s.enqueue_run(&buddy("ic"), EnqueueInput { task_id: Some(task.id.clone()), ..chat("ic", "t1", "c1") }).unwrap();
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
    let run = s.get_run(&run.id).unwrap();
    assert_eq!((run.status, run.error_code.as_deref()), (RunStatus::Cancelled, Some("task_epoch_stale")));
}

#[test]
fn due_schedules_enqueue_once_per_slot() {
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
                limits: "{}".into(),
                enabled: true,
                key: "s".into(),
            },
        )
        .unwrap();
    let slot = schedule.next_run_at.clone().unwrap();
    assert!(slot.ends_with(":00:00.000Z"), "{slot}");
    let later = "2099-01-01T00:30:00.000Z";
    let runs = s.due_schedules(later).unwrap();
    assert_eq!(runs.len(), 1, "missed slots collapse into one run");
    assert_eq!(runs[0].input, RunInput::Schedule { schedule_id: schedule.id.clone(), slot });
    assert!(s.due_schedules(later).unwrap().is_empty(), "the schedule advanced past now");
    assert_eq!(
        s.list_schedules(ListScope::Buddy { buddy_id: "ic".into() }).unwrap()[0].next_run_at.as_deref(),
        Some("2099-01-01T01:00:00.000Z")
    );
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
    let queued = s.enqueue_run(&Actor::Owner, chat("peer", "t1", "c-peer")).unwrap();
    let archive = BuddyUpdate {
        buddy_id: "peer".into(),
        changes: BuddyChanges { status: Some(BuddyStatus::Archived), ..BuddyChanges::default() },
        key: "archive".into(),
    };
    s.update_buddy(&Actor::Owner, archive).unwrap();
    assert_eq!(s.get_run(&queued.id).unwrap().status, RunStatus::Cancelled);
}

#[test]
fn startup_recovery_ends_runs_a_dead_host_held() {
    let mut f = fixture();
    let s = &mut f.store;
    // A request whose recipient was mid-run when the host died must stop awaiting and tell its
    // sender, exactly as a failed settle would; otherwise it waits out a 24 h foreground lease.
    let ask = s.post(&buddy("mid"), dm("mid", "ic"), request("build it", "ask")).unwrap();
    let claim = s.claim_run(86_400_000).unwrap().unwrap();
    assert_eq!(claim.run.input, RunInput::Post { post_id: ask.id.clone() });
    let waiting_chat = s.enqueue_run(&Actor::Owner, chat("lead", "turn", "c-lead")).unwrap();

    let recovery = s.recover_runs().unwrap();
    assert_eq!(recovery, Recovery { interrupted: 1, abandoned_chats: 1 });
    let run = s.get_run(&claim.run.id).unwrap();
    assert_eq!((run.status, run.error_code.as_deref()), (RunStatus::Failed, Some("interrupted")));
    assert_eq!(s.get_run(&waiting_chat.id).unwrap().status, RunStatus::Cancelled);
    // "What was running when the host died?" is one workspace read (2026-09-30): the interrupted
    // run stays listed after it stops being live, and its row says why it ended.
    let rows = s.list_run_rows(ListScope::Workspace { workspace_id: WS.into() }, 100).unwrap();
    let row = rows.iter().find(|r| r.id == claim.run.id).expect("interrupted run left the workspace list");
    assert_eq!((row.status, row.error_code.as_deref()), (RunStatus::Failed, Some("interrupted")));
    assert!(matches!(s.get_post(&Actor::Owner, &ask.id).unwrap().request, RequestState::Failed));
    let notice = s.list_runs(RunQuery::Buddy { buddy_id: "mid".into() }, 5).unwrap();
    assert!(notice.iter().any(|r| r.input == RunInput::FailureNotice { run_id: claim.run.id.clone() }));
    assert_eq!(
        s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "late".into() }).unwrap_err().code(),
        "lease_lost"
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
    let say = |body: &str, key: &str| PostInput { kind: PostKind::Inform, ..request(body, key) };
    s.post(&buddy("lead"), ChannelRef::Id { id: general.id.clone() }, say("Deploy the ranking model on Friday", "p1")).unwrap();
    s.post(&buddy("mid"), dm("mid", "ic"), say("secret ranking numbers", "p2")).unwrap();
    // Every word must match, in any order, case-insensitively; FTS syntax in the query is literal.
    let hits = |who: &Actor, q: &str| s.search_posts(who, WS, q, None, 10).unwrap().posts.into_iter().map(|p| p.body).collect::<Vec<_>>();
    assert_eq!(hits(&buddy("peer"), "friday RANKING"), ["Deploy the ranking model on Friday"]);
    assert_eq!(hits(&buddy("peer"), "ranking"), ["Deploy the ranking model on Friday"], "a DM is private to its members");
    assert_eq!(hits(&buddy("ic"), "ranking").len(), 2, "a member finds its DM");
    assert_eq!(hits(&Actor::Owner, "ranking").len(), 2, "the owner reads every DM");
    assert!(hits(&Actor::Owner, "rank* OR NEAR(").is_empty(), "operators are words, not syntax");
    assert!(matches!(s.search_posts(&buddy("gone"), WS, "ranking", None, 10), Err(CoreError::Denied(_))), "archived buddies cannot search");
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
    let say = |body: &str, key: &str| PostInput { kind: PostKind::Inform, ..request(body, key) };
    for i in 0..5 {
        s.post(&Actor::Owner, ChannelRef::Id { id: general.id.clone() }, say(&format!("rollout note {i}"), &format!("n{i}"))).unwrap();
    }
    s.post(&Actor::Owner, ChannelRef::Id { id: general.id.clone() }, say("unrelated", "u")).unwrap();
    let mut seen = Vec::new();
    let mut before = None;
    loop {
        let page = s.search_posts(&Actor::Owner, WS, "rollout", before, 2).unwrap();
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
    assert_eq!(s.search_posts(&Actor::Owner, WS, "remember", None, 10).unwrap().posts[0].id, post.id);
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
