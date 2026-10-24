mod common;
use common::{WS, buddy, fixture};
use unleashd_buddies::types::*;

#[test]
fn owner_inbox_requests_are_workspace_local_but_buddy_requests_are_global() {
    let mut f = fixture();
    let s = &mut f.store;
    let input = |key: &str| PostInput {
        kind: PostKind::Request, body: "pending".repeat(1000), purpose: None, evidence: vec![],
        reply_to_id: None, task_id: None, from_conversation_id: Some("sender".into()),
        mentions: vec![], run_config: None, broadcast: false, key: key.into(),
    };
    let owner = s.post(&buddy("ic"), ChannelRef::Direct { members: vec![buddy("ic"), Actor::Owner] }, input("owner")).unwrap();
    let peer = s.post(&buddy("ic"), ChannelRef::Direct { members: vec![buddy("ic"), buddy("peer")] }, input("peer")).unwrap();
    let conn = rusqlite::Connection::open(&f.path).unwrap();
    conn.execute("INSERT INTO workspace (id, name, root_path, created_at) VALUES ('elsewhere', 'elsewhere', '/tmp/elsewhere', '2026-01-01T00:00:00.000Z')", []).unwrap();
    for channel in [&owner.channel_id, &peer.channel_id] {
        conn.execute("UPDATE channel SET workspace_id = 'elsewhere' WHERE id = ?1", [channel]).unwrap();
    }
    drop(conn);
    assert!(s.inbox(&Actor::Owner, WS).unwrap().requests.is_empty(), "no unrelated request bodies cross the workspace boundary");
    assert_eq!(s.inbox(&Actor::Owner, "elsewhere").unwrap().requests[0].id, owner.id);
    assert_eq!(s.inbox(&buddy("peer"), WS).unwrap().requests[0].id, peer.id, "a Buddy still sees everything it owes");
}

#[test]
fn owner_unread_matches_inboxes() {
    let mut f = fixture();
    let s = &mut f.store;
    let input = |key: &str| PostInput {
        kind: PostKind::Inform, body: "a long message ".repeat(4000), purpose: None, evidence: vec![],
        reply_to_id: None, task_id: None, from_conversation_id: None, mentions: vec![],
        run_config: None, broadcast: false, key: key.into(),
    };
    let public = s.create_channel(&Actor::Owner, ChannelInput {
        workspace_id: WS.into(), name: "general".into(), purpose: "p".into(), key: "public".into(),
    }).unwrap();
    let channel = ChannelRef::Id { id: public.id.clone() };
    let root = s.post(&Actor::Owner, channel.clone(), input("root")).unwrap();
    s.post(&buddy("ic"), channel.clone(), PostInput { reply_to_id: Some(root.id.clone()), ..input("reply") }).unwrap();
    let top = s.post(&buddy("ic"), channel.clone(), input("top")).unwrap();
    s.post(&buddy("mid"), ChannelRef::Direct { members: vec![buddy("mid"), buddy("ic")] }, input("private")).unwrap();
    let request = s.post(&buddy("ic"), ChannelRef::Direct { members: vec![buddy("ic"), Actor::Owner] }, PostInput {
        kind: PostKind::Request, from_conversation_id: Some("sender".into()), ..input("request")
    }).unwrap();
    let empty = s.create_workspace(&Actor::Owner, WorkspaceInput { repository_identity: None, name: "empty".into(), root_path: "/tmp/empty".into() }).unwrap();
    let check = |s: &mut unleashd_buddies::Store| {
        let rows = s.owner_unread().unwrap();
        for row in &rows {
            let inbox = s.inbox(&Actor::Owner, &row.workspace_id).unwrap();
            assert_eq!(row.requests as usize, inbox.requests.iter().filter(|p| inbox.channels.iter().any(|c| c.channel.id == p.channel_id)).count());
            assert_eq!(row.unread_channels as usize, inbox.channels.iter().filter(|c| !matches!(c.channel.kind, ChannelKind::Task { .. }) && c.unread > 0).count());
            assert_eq!(row.unread_threads, inbox.unread_threads);
        }
        assert_eq!(rows.iter().find(|r| r.workspace_id == empty.id).unwrap().unread_channels, 0);
        rows.into_iter().find(|r| r.workspace_id == WS).unwrap()
    };
    let task = s.upsert_task(&Actor::Owner, TaskWrite::Create {
        owner_id: "ic".into(), parent_id: None, title: "task".into(), done_criteria: "done".into(), key: "task".into(),
    }).unwrap();
    let task_channel = s.open_channel(&Actor::Owner, ChannelRef::Task { task_id: task.id }).unwrap();
    let task_ref = ChannelRef::Id { id: task_channel.id.clone() };
    let task_root = s.post(&Actor::Owner, task_ref.clone(), input("task-root")).unwrap();
    s.mark_read(&Actor::Owner, &task_channel.id, &task_root.id).unwrap();
    s.post(&buddy("ic"), task_ref.clone(), input("task-top")).unwrap();
    let task_reply = s.post(&buddy("ic"), task_ref, PostInput { reply_to_id: Some(task_root.id.clone()), ..input("task-reply") }).unwrap();
    assert_eq!(check(s).unread_threads, 2, "task replies count as followed threads, not rail channels");
    s.mark_thread_read(&Actor::Owner, &task_root.id, &task_reply.id).unwrap();
    let initial = check(s);
    assert_eq!((initial.requests, initial.unread_channels, initial.unread_threads), (1, 2, 1));
    s.set_channel_archived(&Actor::Owner, &public.id, true, "archive").unwrap();
    let archived = check(s);
    assert_eq!((archived.requests, archived.unread_channels, archived.unread_threads), (1, 1, 1));
    s.set_channel_archived(&Actor::Owner, &public.id, false, "restore").unwrap();
    s.mark_read(&Actor::Owner, &public.id, &top.id).unwrap();
    assert_eq!(check(s).unread_channels, 1);
    s.answer(&Actor::Owner, AnswerInput { request_id: request.id, body: "answered".into(), evidence: vec![], from_conversation_id: None, key: "answer".into() }).unwrap();
    assert_eq!(check(s).requests, 0);

    // Badges must execute one SELECT without ever selecting a body or calling inbox per workspace.
    use std::sync::Mutex;
    static SELECTS: Mutex<Vec<String>> = Mutex::new(Vec::new());
    fn trace(sql: &str) { SELECTS.lock().unwrap().push(sql.to_string()); }
    s.trace(Some(trace));
    s.owner_unread().unwrap();
    s.trace(None);
    let sql = SELECTS.lock().unwrap();
    assert_eq!(sql.len(), 1, "one store query regardless of workspace count");
    assert!(!sql[0].contains("body"), "a badge never materializes post bodies");
}
