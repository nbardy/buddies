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
