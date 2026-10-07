//! The 2026-10-06 delivery rebuild, run on a store shaped like the live one (owner decision H: ONE
//! live migration; migrate.rs). The fixture is main fda9fa3's schema, frozen in
//! fixtures/schema-fda9fa3.sql, seeded with one row of every shape the live store can hold:
//! queued `reply`, `failure_notice`, `follow` (one with news, one only waiting for its `until`) and
//! `schedule` rows, a queued chat with no stored text, running chat and request rows an adopting
//! backend may still hold, ended history of every folded kind, an imported `snapshot`, a v33
//! `limits` budget, a request's stored return route. Never the live store: a temp dir only.
//! `cargo test --test migration -- --nocapture` prints the crate's before/after count log.

mod common;

use common::lease;
use rusqlite::{Connection, params};
use std::collections::BTreeMap;
use unleashd_buddies::Store;
use unleashd_buddies::types::*;

const SCHEMA: &str = include_str!("fixtures/schema-fda9fa3.sql");
const T: &str = "2026-10-06T00:00:00.000Z";

fn ord(n: u32) -> String {
    format!("01a10000-0000-7000-8000-{n:012}")
}

/// The pre-rebuild file. `pre_0927`: the older run columns (`retry_of`, no `config`), which open()
/// fixes before the rebuild.
fn legacy_store(path: &str, pre_0927: bool) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(&format!("PRAGMA foreign_keys = ON; {SCHEMA} PRAGMA application_id = {};", unleashd_buddies::schema::APPLICATION_ID))
        .unwrap();
    let seed = |sql: &str, args: &[&dyn rusqlite::ToSql]| {
        conn.execute(sql, args).unwrap();
    };
    seed("INSERT INTO workspace (id, name, root_path, created_at) VALUES ('ws', 'ws', '/tmp/ws', ?1)", &[&T]);
    for b in ["lead", "mid", "ic", "peer"] {
        seed(
            "INSERT INTO buddy (id, workspace_id, slug, name, role, status, max_active_runs, created_at) VALUES (?1, 'ws', ?1, ?1, 'r', 'active', 5, ?2)",
            &[&b, &T],
        );
    }
    seed("INSERT INTO channel (id, workspace_id, kind, member_key, created_at) VALUES ('dm', 'ws', 'direct', 'ic,mid', ?1)", &[&T]);
    seed("INSERT INTO channel_member VALUES ('dm', 'ic'), ('dm', 'mid')", &[]);
    seed("INSERT INTO channel (id, workspace_id, kind, name, purpose, created_at) VALUES ('general', 'ws', 'public', 'general', 'p', ?1)", &[&T]);
    let post = |id: &str, n: u32, channel: &str, author: Option<&str>, root: Option<&str>, request: Option<&str>, answer: Option<&str>, ret: Option<&str>| {
        conn.execute(
            "INSERT INTO post (id, channel_id, author_id, root_id, reply_to_id, body, request, answer_id, conversation_id,
               return_conversation_id, created_at, ord)
             VALUES (?1, ?2, ?3, ?4, ?4, ?1, ?5, ?6, ?7, ?7, ?8, ?9)",
            params![id, channel, author, root, request, answer, ret, T, ord(n)],
        )
        .unwrap();
    };
    // r1 answered (its return queued), r2 failed (its failure notice queued), r3 still being worked.
    post("r1", 1, "dm", Some("mid"), None, Some("awaiting"), None, Some("conv-mid"));
    post("a1", 2, "dm", Some("ic"), Some("r1"), None, None, None);
    conn.execute("UPDATE post SET request = 'answered', answer_id = 'a1' WHERE id = 'r1'", []).unwrap();
    post("r2", 3, "dm", Some("mid"), None, Some("failed"), None, Some("conv-mid"));
    post("r3", 4, "dm", Some("mid"), None, Some("awaiting"), None, Some("conv-mid"));
    // A public thread mid follows with an unread reply, and one it follows with nothing new.
    post("t1", 5, "general", Some("mid"), None, None, None, None);
    post("t1-news", 6, "general", Some("peer"), Some("t1"), None, None, None);
    post("t2", 7, "general", Some("mid"), None, None, None, None);
    for (reader, root, n) in [("mid", "r1", 1), ("mid", "r2", 3), ("mid", "r3", 4), ("mid", "t1", 5), ("mid", "t2", 7), ("owner", "t1", 6)] {
        seed("INSERT INTO thread_read (reader, root_id, last_ord, updated_at) VALUES (?1, ?2, ?3, ?4)", &[&reader, &root, &ord(n), &T]);
    }
    seed(
        "INSERT INTO thread_follow (id, root_id, buddy_id, conversation_id, through_ord, until, created_at)
         VALUES ('f-news', 't1', 'mid', 'conv-follow', ?1, '2099-01-01T00:00:00.000Z', ?2),
                ('f-idle', 't2', 'mid', 'conv-idle', ?3, '2099-01-01T00:00:00.000Z', ?2)",
        &[&ord(5), &T, &ord(7)],
    );
    seed(
        "INSERT INTO schedule (id, buddy_id, workspace_id, name, cron, timezone, prompt, limits, enabled, next_run_at, created_at)
         VALUES ('s1', 'ic', 'ws', 'hourly', '0 * * * *', 'UTC', 'check the build', '{\"max_tokens\":50000,\"max_cost_usd\":5}', 1, '2099-01-01T00:00:00.000Z', ?1)",
        &[&T],
    );
    let run = |id: &str, kind: &str, input: &str, buddy: &str, conv: Option<&str>, status: &str, extra: &str| {
        let key = format!("{kind}:{input}:{id}");
        conn.execute(
            "INSERT INTO run (id, input_key, input_kind, input_id, buddy_id, workspace_id, conversation_id, status, ready_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'ws', ?6, ?7, ?8, ?8)",
            params![id, key, kind, input, buddy, conv, status, T],
        )
        .unwrap();
        if !extra.is_empty() {
            conn.execute_batch(&format!("UPDATE run SET {extra} WHERE id = '{id}'")).unwrap();
        }
    };
    run("w1", "post", "r1", "ic", Some("buddy-run-w1"), "complete", "ended_at = '2026-10-06T00:01:00.000Z'");
    run("w2", "post", "r2", "ic", Some("buddy-run-w2"), "failed", "error_code = 'provider_error', error = 'boom', ended_at = '2026-10-06T00:01:00.000Z'");
    run("w3", "post", "r3", "ic", Some("buddy-run-w3"), "running", "lease_token = 'tok-w3', lease_expires_at = '2026-10-06T00:05:00.000Z', started_at = '2026-10-06T00:00:01.000Z'");
    run("q-reply", "reply", "r1", "mid", Some("conv-mid"), "queued", "");
    run("q-failure", "failure_notice", "w2", "mid", Some("conv-mid"), "queued", "");
    run("q-follow-news", "follow", "f-news", "mid", Some("conv-follow"), "queued", "ready_at = '2099-01-01T00:00:00.000Z'");
    run("q-follow-idle", "follow", "f-idle", "mid", Some("conv-idle"), "queued", "ready_at = '2099-01-01T00:00:00.000Z'");
    run("q-schedule", "schedule", "s1", "ic", None, "queued", "ready_at = '2026-10-06T01:00:00.000Z'");
    run("q-chat", "chat", "turn-lost", "lead", Some("lead-chat"), "queued", "");
    run("live-chat", "chat", "turn-live", "lead", Some("lead-chat-2"), "running", "lease_token = 'tok-c', lease_expires_at = '2026-10-06T00:05:00.000Z', started_at = '2026-10-06T00:00:02.000Z'");
    run("old-reply", "reply", "r0", "mid", Some("conv-mid"), "complete", "ended_at = '2026-10-05T00:00:00.000Z', snapshot = '{\"v33\":true}'");
    run("old-follow", "follow", "f-old", "mid", Some("conv-mid"), "cancelled", "error_code = 'superseded', ended_at = '2026-10-05T00:00:00.000Z'");
    run("old-schedule", "schedule", "s1", "ic", None, "complete", "ended_at = '2026-10-05T00:00:00.000Z'");
    if pre_0927 {
        conn.execute_batch("ALTER TABLE run ADD COLUMN retry_of TEXT; ALTER TABLE run DROP COLUMN config;").unwrap();
    }
}

fn counts(conn: &Connection, sql: &str) -> BTreeMap<String, i64> {
    let mut stmt = conn.prepare(sql).unwrap();
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).unwrap().map(Result::unwrap).collect()
}

fn run_counts(conn: &Connection) -> BTreeMap<String, i64> {
    counts(conn, "SELECT input_kind || ':' || status, count(*) FROM run GROUP BY 1")
}

fn backups(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.to_string_lossy().contains(".before-delivery.run-v1.")).collect()
}

#[test]
fn the_live_shaped_store_migrates_once_with_every_queued_row_converted() {
    for pre_0927 in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("buddies-v3.sqlite");
        let path = path.to_str().unwrap();
        legacy_store(path, pre_0927);
        let before = run_counts(&Connection::open(path).unwrap());
        eprintln!("[migration test] pre_0927={pre_0927} runs before: {before:?}");

        let mut s = Store::open(path).unwrap();
        let conn = Connection::open(path).unwrap();
        let after = run_counts(&conn);
        eprintln!("[migration test] pre_0927={pre_0927} runs after: {after:?}");
        let subscriptions = counts(&conn, "SELECT reader || ' ' || root_id || ' ' || conversation_id, 1 FROM thread_read WHERE conversation_id IS NOT NULL");
        eprintln!("[migration test] subscriptions after: {:?}", subscriptions.keys().collect::<Vec<_>>());

        // Nothing lost: every old row is still there, and only deliveries were added.
        assert_eq!(before.values().sum::<i64>(), 13);
        let added: i64 = after.iter().filter(|(k, _)| k.starts_with("deliver:")).map(|(_, n)| n).sum();
        assert_eq!(after.values().sum::<i64>(), 13 + added + 1, "plus the schedule fire");
        assert_eq!(
            after.iter().filter(|(k, _)| k.ends_with(":queued")).map(|(k, n)| (k.as_str(), *n)).collect::<Vec<_>>(),
            [("chat:queued", 1), ("deliver:queued", 3)],
            "queued: the schedule fire (a silent chat run) and the deliveries: the answer, the failure post, the followed news"
        );
        assert_eq!(after.get("chat:cancelled"), Some(&1), "the queued chat had no stored text");
        assert_eq!((after.get("reply:cancelled"), after.get("follow:cancelled"), after.get("failure_notice:cancelled")), (Some(&1), Some(&3), Some(&1)));

        let one = |sql: &str| -> String { conn.query_row(&format!("SELECT CAST(({sql}) AS TEXT)"), [], |r| r.get(0)).unwrap() };
        assert_eq!(one("SELECT error_code || '/' || status FROM run WHERE id = 'q-chat'"), "interrupted/cancelled");
        assert_eq!(one("SELECT executing_at FROM run WHERE id = 'live-chat'"), "2026-10-06T00:00:02.000Z", "a running row counts as executed");
        assert_eq!(one("SELECT status || ' ' || lease_token FROM run WHERE id = 'w3'"), "running tok-w3", "an adoptable run keeps its lease");
        assert_eq!(one("SELECT CAST(json_extract(legacy, '$.snapshot.v33') AS TEXT) FROM run WHERE id = 'old-reply'"), "1", "an imported snapshot moved into legacy");

        let deliveries = counts(&conn, "SELECT input_id || ' ' || coalesce(conversation_id, '-'), 1 FROM run WHERE input_kind = 'deliver'");
        let delivered: Vec<&String> = deliveries.keys().collect();
        let notice = one("SELECT id FROM post WHERE purpose = 'run_failed'");
        assert!(delivered.contains(&&"a1 conv-mid".to_string()), "the answer goes to the conversation that asked: {delivered:?}");
        assert!(delivered.contains(&&format!("{notice} conv-mid")), "the failure notice is a post, delivered there: {delivered:?}");
        assert!(delivered.contains(&&"t1-news conv-follow".to_string()), "the followed news: {delivered:?}");
        assert_eq!(one("SELECT count(*) FROM post WHERE purpose = 'schedule'"), "0", "a schedule slot posts nothing");
        assert_eq!(one("SELECT input_id FROM run WHERE input_kind = 'chat' AND status = 'queued'"), "schedule:s1:2026-10-06T01:00:00.000Z");
        assert_eq!(one("SELECT author_id || ' ' || reply_to_id FROM post WHERE purpose = 'run_failed'"), "ic r2");
        assert!(subscriptions.contains_key("mid r1 conv-mid") && subscriptions.contains_key("mid t1 conv-follow"));
        assert!(subscriptions.contains_key("mid t2 conv-idle"), "a follow waiting only for its timeout still subscribes");

        let gone = |table: &str, column: &str| -> bool {
            conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)", [table, column], |r| r.get(0)).unwrap()
        };
        assert!(gone("post", "return_conversation_id") && gone("schedule", "limits") && gone("run", "snapshot") && gone("run", "retry_of"));
        assert_eq!(one("SELECT count(*) FROM sqlite_schema WHERE name = 'thread_follow'"), "0");
        assert_eq!(conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get::<_, i64>(0)).unwrap(), 0);

        // The pre-migration copy opens at the old schema with the old rows.
        let copies = backups(dir.path());
        assert_eq!(copies.len(), 1);
        let old = Connection::open(&copies[0]).unwrap();
        assert!(!one_of(&old, "SELECT sql FROM sqlite_schema WHERE name = 'run'").contains("'deliver'"));
        assert_eq!(run_counts(&old), before, "the copy holds the store as it was");

        // A second open migrates nothing and copies nothing.
        drop(s);
        s = Store::open(path).unwrap();
        assert_eq!(backups(dir.path()).len(), 1);
        assert_eq!(run_counts(&conn), after);

        // After the migration the queue works: the three deliveries and the schedule fire claim; the legacy running rows,
        // executed, end at the gate as lease_expired instead of being requeued and replayed.
        let mut claimed = vec![];
        while let Some(claim) = s.claim_run_at("2099-01-02T00:00:00.000Z", lease(300_000), &[]).unwrap() {
            claimed.push(claim.run.input.clone());
            if let RunInput::Deliver { .. } = claim.run.input {
                assert!(matches!(s.deliver_posts(&claim.run.id).unwrap(), Delivery::Posts { .. }), "{:?}", claim.run);
            }
            s.settle_run(&claim.run.id, &claim.lease_token, Outcome::Complete { text: "ok".into() }).unwrap();
        }
        assert_eq!(one("SELECT status || ' ' || error_code FROM run WHERE id = 'live-chat'"), "failed lease_expired");
        assert_eq!(one("SELECT status || ' ' || error_code FROM run WHERE id = 'w3'"), "failed lease_expired");
        assert!(claimed.contains(&RunInput::Post { post_id: "r3".into() }), "the executed request resumed once (decision G): {claimed:?}");
        assert_eq!(claimed.iter().filter(|i| matches!(i, RunInput::Deliver { .. })).count(), 3);
        assert_eq!(claimed.iter().filter(|i| matches!(i, RunInput::Chat { turn_id } if turn_id.starts_with("schedule:"))).count(), 1, "the fire claims as a background run");
    }
}

fn one_of(conn: &Connection, sql: &str) -> String {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

// Mutation guard (pending-delivery design R1, kept): without the `executing_at` backfill the
// requeue rule would REPLAY a request that was running when the old build stopped. Shown on the
// migrated file by clearing the backfill and letting the gate act.
#[test]
fn without_the_executing_backfill_a_legacy_running_turn_would_be_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("buddies-v3.sqlite");
    let path = path.to_str().unwrap();
    legacy_store(path, false);
    let mut s = Store::open(path).unwrap();
    Connection::open(path).unwrap().execute("UPDATE run SET executing_at = NULL WHERE id IN ('w3', 'live-chat')", []).unwrap();
    while s.claim_run_at("2099-01-02T00:00:00.000Z", lease(300_000), &[]).unwrap().is_some() {}
    let (w3, chat) = (s.get_run("w3").unwrap(), s.get_run("live-chat").unwrap());
    assert_eq!((w3.status, w3.attempt), (RunStatus::Running, 1), "requeued and claimed again: the backfill is what prevents this replay");
    assert_eq!(chat.status, RunStatus::Failed, "a chat with no stored text is never requeued, and the gate keeps working");
}
