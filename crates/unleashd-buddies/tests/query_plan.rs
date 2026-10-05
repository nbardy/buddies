//! Query-plan guard. Regression class: the 2026-09-25 tick incident (00-reconcile-fix.md), where a
//! 1 s timer ran full-table scans and took 0.6–20 s per tick. Every statement a workload of every
//! public function executes is traced, then `EXPLAIN QUERY PLAN`ned; a plain `SCAN <table>` fails.
//! A walk of a whole index (`SCAN t USING INDEX`) is a scan too, except the partial run-queue walks;
//! a CTE scan and the one list-everything read are fine.

mod common;

use common::{WS, buddy, fixture, lease};
use rusqlite::Connection;
use std::collections::BTreeSet;
use std::sync::Mutex;
use unleashd_buddies::types::*;

static TRACED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn record(sql: &str) {
    TRACED.lock().unwrap().push(sql.to_string());
}

/// Reads whose job is to return every row of a small table.
const WHOLE_TABLE_BY_DESIGN: &[&str] = &["SCAN workspace"];
/// Whole walks of a PARTIAL index whose every row is a candidate: the run queue and live leases.
/// Any other `SCAN t USING INDEX` walks the whole table in index order (T22: the Task filter's
/// `post.task_id` lookup walked `post` by ord before `post_task` existed, and passed).
const INDEX_WALKS_BY_DESIGN: &[&str] = &[
    "SCAN run USING INDEX run_queue",
    "SCAN r USING INDEX run_queue",
    "SCAN run USING INDEX run_lease",
    "SCAN run USING INDEX run_active_buddy",
];
/// Plan lines that scan no table: the manager-walk CTE and its constant seed row.
const NOT_TABLES: &[&str] = &["SCAN up", "SCAN CONSTANT ROW"];

fn workload(s: &mut unleashd_buddies::Store) {
    let ic = buddy("ic");
    let mid = buddy("mid");
    let owner = Actor::Owner;
    s.authorize(&mid, Op::WriteDoc, &Subject::Buddy { id: "lead".into() }).unwrap();
    s.authorize(&buddy("lead"), Op::WriteDoc, &Subject::Buddy { id: "ic".into() }).unwrap();
    let channel = s
        .create_channel(&owner, ChannelInput { workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "ch".into() })
        .unwrap();
    let public = ChannelRef::Id { id: channel.id.clone() };
    let top = s.post(&owner, public.clone(), input(PostKind::Inform, "hi", "p1")).unwrap();
    let top_reply = s.post(&ic, public, PostInput { reply_to_id: Some(top.id.clone()), ..input(PostKind::Inform, "reply", "p2") }).unwrap();
    let dm = ChannelRef::Direct { members: vec![mid.clone(), ic.clone()] };
    let ask =
        s.post(&mid, dm.clone(), PostInput { from_conversation_id: Some("c-mid".into()), returns: Some(Returns::Conversation { id: "c-mid".into() }), ..input(PostKind::Request, "do", "p3") }).unwrap();
    s.post(&ic, dm, input(PostKind::Inform, "on it", "p4")).unwrap();
    let cursor = Some(Cursor { ord: "ffffffff-ffff-7fff-bfff-ffffffffffff".into() });
    for q in [
        PostQuery::Channel { channel_id: channel.id.clone() },
        PostQuery::Thread { root_id: top.id.clone() },
        PostQuery::Channel { channel_id: ask.channel_id.clone() },
    ] {
        s.list_posts(&ic, q.clone(), None, 5).unwrap();
        s.list_posts(&ic, q, cursor.clone(), 5).unwrap();
    }
    s.get_post(&ic, &ask.id).unwrap();
    s.list_posts_from(&ic, PostQuery::Thread { root_id: top.id.clone() }, &top_reply.id, 5).unwrap();
    s.list_posts_from(&ic, PostQuery::Channel { channel_id: channel.id.clone() }, &top.id, 5).unwrap();
    assert_eq!(s.thread_stats(&ic, &channel.id, &[top.id.clone(), ask.id.clone()]).unwrap().len(), 1);
    s.inbox(&ic, WS).unwrap();
    s.inbox(&owner, WS).unwrap();
    assert_eq!(s.followed_threads(&owner, WS, 5).unwrap().threads.len(), 1);
    s.followed_threads(&ic, WS, 5).unwrap();
    s.mark_thread_read(&owner, &top.id, &top_reply.id).unwrap();
    assert_eq!(s.search_posts(&ic, WS, &SearchQuery::text("reply"), None, 5).unwrap().posts.len(), 1);
    s.search_posts(&owner, WS, &SearchQuery::text("on it"), None, 5).unwrap();
    s.search_posts(&owner, WS, &SearchQuery::text("on it"), cursor.clone(), 5).unwrap();
    s.inbox(&owner, WS).unwrap();
    s.mark_read(&ic, &channel.id, &top.id).unwrap();
    s.mark_read(&ic, &ask.channel_id, &ask.id).unwrap();

    let claim = s.claim_run(lease(60_000)).unwrap().unwrap();
    s.bind_run(&claim.run.id, &claim.lease_token, "c-ic").unwrap();
    s.renew_run(&claim.run.id, &claim.lease_token, 60_000).unwrap();
    s.answer(&ic, AnswerInput { request_id: ask.id.clone(), body: "done".into(), evidence: vec![], key: "r".into() }).unwrap();
    s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Failed { code: "x".into(), error: "y".into() }).unwrap();

    let doc = DocRef { buddy_id: "ic".into(), scope: DocScope::Buddy, kind: DocKind::Working, name: String::new() };
    let written = s
        .write_doc(&mid, DocWrite { doc: doc.clone(), content: "m".into(), base_revision: 0, reason: "r".into(), key: "d".into() })
        .unwrap();
    let shared_doc = DocRef { scope: DocScope::Workspace { workspace_id: WS.into() }, kind: DocKind::Shared, ..doc.clone() };
    s.read_doc(&ic, doc).unwrap();
    s.read_doc(&ic, shared_doc).unwrap();
    s.list_docs(&ic, "ic", DocKind::Working).unwrap();
    s.doc_revisions(&ic, &written.id).unwrap();

    let parent = s
        .upsert_task(
            &mid,
            TaskWrite::Create { owner_id: "ic".into(), parent_id: None, title: "t".into(), done_criteria: "d".into(), key: "t1".into() },
        )
        .unwrap();
    s.upsert_task(
        &ic,
        TaskWrite::Create {
            owner_id: "ic".into(),
            parent_id: Some(parent.id.clone()),
            title: "c".into(),
            done_criteria: "d".into(),
            key: "t2".into(),
        },
    )
    .unwrap();
    s.enqueue_run(
        &ic,
        EnqueueInput {
            buddy_id: "ic".into(),
            input: RunInput::Chat { turn_id: "u1".into() },
            conversation_id: Some("c-ic".into()),
            task_id: Some(parent.id.clone()),
            after_run_id: Some(claim.run.id.clone()),
            deadline: None,
            config: None,
        },
    )
    .unwrap();
    s.upsert_task(
        &ic,
        TaskWrite::Update {
            task_id: parent.id.clone(),
            base_revision: 1,
            key: "t3".into(),
            changes: TaskChanges { paused: Some(true), ..Default::default() },
        },
    )
    .unwrap();
    for q in [
        TaskQuery::Owner { buddy_id: "ic".into() },
        TaskQuery::Workspace { workspace_id: WS.into() },
        TaskQuery::Children { parent_id: parent.id.clone() },
    ] {
        s.list_tasks(q).unwrap();
    }
    s.task_counts(WS).unwrap();
    s.get_task(&parent.id).unwrap();
    s.task_posts(&ic, &parent.id, None, 5).unwrap();
    s.task_posts(&owner, &parent.id, Some(Cursor { ord: "ffffffff-ffff-7fff-bfff-ffffffffffff".into() }), 5).unwrap();
    s.post(&ic, ChannelRef::Task { task_id: parent.id.clone() }, input(PostKind::Inform, "comment", "p5")).unwrap();

    let run = s
        .enqueue_run(
            &owner,
            EnqueueInput {
                buddy_id: "peer".into(),
                input: RunInput::Chat { turn_id: "u2".into() },
                conversation_id: None,
                task_id: None,
                after_run_id: None,
                deadline: None,
                config: None,
            },
        )
        .unwrap();
    s.cancel_run(&owner, &run.id).unwrap();
    for q in [
        RunQuery::Buddy { buddy_id: "ic".into() },
        RunQuery::Conversation { conversation_id: "c-ic".into() },
        RunQuery::Task { task_id: parent.id.clone() },
        RunQuery::Queued,
        RunQuery::Live { workspace_id: WS.into() },
    ] {
        s.list_runs(q, 10).unwrap();
    }
    for q in [
        ListScope::Buddy { buddy_id: "ic".into() },
        ListScope::Task { task_id: parent.id.clone() },
        ListScope::Workspace { workspace_id: WS.into() },
    ] {
        s.list_run_rows(q, 10).unwrap();
    }
    s.create_workspace(&owner, WorkspaceInput { name: "w2".into(), root_path: "/tmp/w2".into() }).unwrap();
    let hired = s
        .create_buddy(
            &owner,
            BuddyCreate {
                workspace_id: WS.into(),
                slug: "new".into(),
                name: "New".into(),
                role: "r".into(),
                manager: ManagerRef::Buddy { id: "lead".into() },
                provider: None,
                model: None,
                reasoning_effort: None,
                key: "hire".into(),
            },
        )
        .unwrap();
    s.update_buddy(
        &owner,
        BuddyUpdate {
            buddy_id: hired.id,
            changes: BuddyChanges {
                manager: Some(ManagerRef::Buddy { id: "mid".into() }),
                model: Some(Setting::Default),
                status: Some(BuddyStatus::Archived),
                ..BuddyChanges::default()
            },
            key: "move".into(),
        },
    )
    .unwrap();
    s.put_schedule(
        &ic,
        ScheduleInput {
            id: None,
            buddy_id: "ic".into(),
            task_id: None,
            name: "n".into(),
            cron: "0 * * * *".into(),
            timezone: "UTC".into(),
            prompt: "p".into(),
            limits: "{}".into(),
            enabled: true,
            key: "s".into(),
        },
    )
    .unwrap();
    s.list_schedules(ListScope::Buddy { buddy_id: "ic".into() }).unwrap();
    s.list_schedules(ListScope::Task { task_id: parent.id.clone() }).unwrap();
    s.list_schedules(ListScope::Workspace { workspace_id: WS.into() }).unwrap();
    s.due_schedules("2999-01-01T00:00:00.000Z").unwrap();
    s.append_event(
        &ic,
        EventInput {
            workspace_id: WS.into(),
            op: "x".into(),
            payload: "{}".into(),
            key: Some("e".into()),
            buddy_id: Some("ic".into()),
            task_id: None,
        },
    )
    .unwrap();
    s.list_events("ic", i64::MAX, 10).unwrap();
    s.list_workspaces().unwrap();
    s.get_buddy("ic").unwrap();
    s.list_buddies(WS).unwrap();
    s.bind_conversation(&owner, ConversationInput { id: "c-new".into(), buddy_id: "ic".into(), task_id: None }).unwrap();
    // Thread follows (follows.rs): follow, replace, the wake inside a post, delivery, the gate skip.
    let until = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    s.catch_up_thread(&mid, &top.id, 20).unwrap();
    let follow = FollowInput { root_id: top.id.clone(), conversation_id: "c-follow".into(), until, limit: 20 };
    s.follow_thread(&mid, follow.clone()).unwrap();
    let FollowRead::Following { follow } = s.follow_thread(&mid, follow).unwrap() else { panic!("nothing unread after the catch-up") };
    let woke = s
        .post(&owner, ChannelRef::Id { id: channel.id.clone() }, PostInput { reply_to_id: Some(top.id.clone()), ..input(PostKind::Inform, "news", "pf") })
        .unwrap();
    s.delivering_followers(&top.id, &woke.ord).unwrap();
    s.deliver_follow(&follow.id, 20).unwrap();
}

fn input(kind: PostKind, body: &str, key: &str) -> PostInput {
    PostInput {
        kind,
        body: body.into(),
        purpose: None,
        evidence: vec![],
        reply_to_id: None,
        task_id: None,
        from_conversation_id: None,
        returns: None,
        run_config: None,
        broadcast: false,
        key: key.into(),
    }
}

#[test]
fn every_statement_uses_an_index() {
    let mut f = fixture();
    f.store.trace(Some(record));
    workload(&mut f.store);
    f.store.trace(None);

    let statements: BTreeSet<String> = TRACED
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.trim().to_string())
        // "-- TRIGGER x" lines trace trigger bodies, which are planned with their statement.
        .filter(|s| {
            !(s.starts_with("BEGIN")
                || s.starts_with("COMMIT")
                || s.starts_with("ROLLBACK")
                || s.starts_with("PRAGMA")
                || s.starts_with("--"))
        })
        .collect();
    assert!(statements.len() > 40, "the workload should exercise many statements, saw {}", statements.len());

    let conn = Connection::open(&f.path).unwrap();
    let table_scans = |sql: &str| -> Vec<String> {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let plan: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(3)).unwrap().map(Result::unwrap).collect();
        plan.into_iter()
            // An FTS5 MATCH plans as "SCAN <fts> VIRTUAL TABLE INDEX n:M..": an index lookup.
            .filter(|line| line.starts_with("SCAN ") && !line.contains("VIRTUAL TABLE INDEX 0:M"))
            .filter(|line| {
                ![WHOLE_TABLE_BY_DESIGN, NOT_TABLES, INDEX_WALKS_BY_DESIGN].iter().any(|allowed| allowed.contains(&line.as_str()))
            })
            .collect()
    };
    // The detector itself must see a scan, or a changed SQLite plan format would pass everything.
    assert_eq!(table_scans("SELECT * FROM post WHERE body = 'x'"), ["SCAN post"]);
    assert_eq!(table_scans("SELECT id FROM post WHERE body = 'x' ORDER BY ord"), ["SCAN post USING INDEX sqlite_autoindex_post_2"]);
    let scans: Vec<String> =
        statements.iter().flat_map(|sql| table_scans(sql).into_iter().map(move |line| format!("{line}\n    in: {sql}"))).collect();
    assert!(scans.is_empty(), "full table scans:\n{}", scans.join("\n"));
}
