//! The engine end to end on a temp root: scan, append, delete, restart. Plus the query-plan
//! guard: every read the store serves must use an index (no full-table SCAN).

mod common;

use common::*;
use serde_json::json;
use std::path::Path;
use unleashd_ingest::engine::Engine;
use unleashd_ingest::model::{Format, Root};
use unleashd_ingest::store::{Committed, MergePrefix, Reader, Writer};

fn user(text: &str) -> String {
    format!("{}\n", json!({ "type": "user", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/w", "message": { "content": text } }))
}

fn roots(base: &Path) -> Vec<Root> {
    vec![Root { format: Format::Claude, path: base.join("claude").to_string_lossy().into_owned() }]
}

#[test]
fn scan_append_delete_and_warm_restart() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("claude/-w/a.jsonl");
    let b = dir.path().join("claude/-w/b.jsonl");
    write(&a, &format!("{}{}", user("a1"), user("a2")));
    write(&b, &user("b1"));
    let db = dir.path().join("ingest.sqlite");
    let mut commits: Vec<Committed> = Vec::new();

    let mut engine = Engine::open(roots(dir.path()), &db).unwrap();
    let report = engine.scan(&mut |c| commits.push(c.clone()));
    assert_eq!((report.full, report.messages_written), (2, 3));
    let reader = Reader::open(&db).unwrap();
    let (rev, rows, _) = reader.list_sessions(0).unwrap();
    assert_eq!(rows.len(), 2);

    // Append: only the new message is written, with the next seq.
    append(&a, &user("a3"));
    let report = engine.changed([a.clone()].into(), &mut |c| commits.push(c.clone()));
    assert_eq!((report.resumed, report.messages_written), (1, 1));
    assert_eq!(commits.last().unwrap().session_ids, ["a"]);
    assert!(commits.last().unwrap().rewritten.is_empty(), "an append is not a rewrite");
    let (rev2, changed, _) = reader.list_sessions(rev).unwrap();
    assert_eq!(changed.iter().map(|r| (r.session_id.as_str(), r.message_count)).collect::<Vec<_>>(), [("a", 3)]);
    let tail = reader.messages("a", 1, 10).unwrap();
    assert_eq!(contents(&tail), ["a3"]);
    assert_eq!(tail[0].seq, 2);

    // Delete: a tombstone pages out through `since`.
    std::fs::remove_file(&b).unwrap();
    engine.changed([b.clone()].into(), &mut |c| commits.push(c.clone()));
    let (_, _, removed) = reader.list_sessions(rev2).unwrap();
    assert_eq!(removed.iter().map(|r| r.session_id.as_str()).collect::<Vec<_>>(), ["b"]);
    assert!(reader.session("b").unwrap().is_none());
    drop(engine);

    // Warm restart: the store is reopened, every source is unchanged, nothing is parsed.
    let mut engine = Engine::open(roots(dir.path()), &db).unwrap();
    let report = engine.scan(&mut |_| panic!("an unchanged restart commits nothing"));
    assert_eq!((report.unchanged, report.full, report.resumed, report.messages_written), (1, 0, 0, 0));

    // And a restart after an append resumes from the stored checkpoint.
    drop(engine);
    append(&a, &user("a4"));
    let mut engine = Engine::open(roots(dir.path()), &db).unwrap();
    let report = engine.scan(&mut |_| {});
    assert_eq!((report.resumed, report.full, report.messages_written), (1, 0, 1));
}

#[test]
fn a_codex_event_mode_switch_is_applied_in_the_store_as_a_fresh_read_would_be() {
    // The store half of Apply::Withdraw: delete the withdrawn seqs and renumber the rest.
    let dir = tempfile::tempdir().unwrap();
    let row = |kind: &str, payload: serde_json::Value| {
        format!("{}\n", json!({ "timestamp": "2026-09-10T07:00:00.000Z", "type": kind, "payload": payload }))
    };
    let file = dir.path().join("codex/2026/09/10/rollout-x.jsonl");
    let mut text = row("session_meta", json!({ "id": "s1", "cwd": "/w" }));
    for i in 0..3 {
        text += &row(
            "response_item",
            json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": format!("ask {i}") }] }),
        );
        text += &row("response_item", json!({ "type": "function_call", "name": "shell", "call_id": format!("c{i}"), "arguments": "{}" }));
    }
    write(&file, &text);
    let codex = |base: &Path| vec![Root { format: Format::Codex, path: base.join("codex").to_string_lossy().into_owned() }];
    let db = dir.path().join("a.sqlite");
    let mut engine = Engine::open(codex(dir.path()), &db).unwrap();
    engine.scan(&mut |_| {});
    append(&file, &row("event_msg", json!({ "type": "user_message", "message": "prompt" })));
    let report = engine.changed([file.clone()].into(), &mut |_| {});
    assert_eq!((report.resumed, report.full), (1, 0));
    let fresh = dir.path().join("b.sqlite");
    Engine::open(codex(dir.path()), &fresh).unwrap().scan(&mut |_| {});
    let incremental = Reader::open(&db).unwrap().messages("s1", -1, 100).unwrap();
    let full = Reader::open(&fresh).unwrap().messages("s1", -1, 100).unwrap();
    assert_eq!(incremental, full);
    assert_eq!(full.iter().map(|m| m.seq).collect::<Vec<_>>(), [0, 1, 2, 3]);
    assert_eq!(Reader::open(&db).unwrap().session("s1").unwrap().unwrap().message_count, 4);
}

#[test]
fn every_store_read_uses_an_index() {
    let dir = tempfile::tempdir().unwrap();
    write(&dir.path().join("claude/-w/a.jsonl"), &user("a1"));
    let db = dir.path().join("ingest.sqlite");
    Engine::open(roots(dir.path()), &db).unwrap().scan(&mut |_| {});
    let reader = Reader::open(&db).unwrap();
    let writes = Writer::open(&db).unwrap().plans().unwrap();
    for (query, plan) in reader.plans().unwrap().into_iter().chain(writes) {
        for line in plan {
            // `SCAN t USING INDEX` / `USING COVERING INDEX` walks an index; a bare `SCAN t` reads
            // the whole table.
            let full_scan = line.starts_with("SCAN ") && !line.contains("USING");
            assert!(!full_scan, "full table scan in {query}: {line}");
        }
    }
}

/// The server caches message pages by seq and refetches only the tail on an append; it must learn
/// when a session's history was replaced instead (T13b: without `rewritten` a truncated or
/// rewritten transcript kept its stale prefix in every open client).
#[test]
fn a_rewritten_source_is_reported_as_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("claude/-w/a.jsonl");
    write(&a, &format!("{}{}", user("a1"), user("a2")));
    let db = dir.path().join("ingest.sqlite");
    let mut commits: Vec<Committed> = Vec::new();
    let mut engine = Engine::open(roots(dir.path()), &db).unwrap();
    engine.scan(&mut |c| commits.push(c.clone()));
    write(&a, &user("b1"));
    engine.changed([a.clone()].into(), &mut |c| commits.push(c.clone()));
    let last = commits.last().unwrap();
    assert_eq!((last.session_ids.as_slice(), last.rewritten.as_slice()), (&["a".to_string()][..], &["a".to_string()][..]));
}

/// Deep search replaced a scan of every loaded transcript held in server memory (T13b). `%` and `_`
/// in the query are literal: unescaped, "100%" matched every message containing "100".
#[test]
fn search_finds_listed_messages_newest_first_with_literal_wildcards() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("claude/-w/a.jsonl");
    write(&a, &format!("{}{}{}", user("Deploy at 100% load"), user("deploy at 1000 load"), user("unrelated")));
    let db = dir.path().join("ingest.sqlite");
    Engine::open(roots(dir.path()), &db).unwrap().scan(&mut |_| {});
    let reader = Reader::open(&db).unwrap();
    let hits = reader.search("DEPLOY", 10).unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|h| h.session_id == "a"));
    let literal = reader.search("100%", 10).unwrap();
    assert_eq!(literal.iter().map(|h| h.message.content.as_str()).collect::<Vec<_>>(), ["Deploy at 100% load"]);
}

// Fix-guard (2026-10-23): boot counted merged histories by paging every message through napi and
// hashing it in JS (618 records, seconds of main thread). The count now lives in the store; it
// must equal what the server's merge keeps: an inherited prefix once, a repeated identical row
// within a session at its in-session count, and a diverging tail added. The TS parity test
// (server/test/ingest-history.test.ts) checks the same against the real `mergeSessionMessages`.
#[test]
fn merged_count_counts_an_inherited_prefix_once() {
    let dir = tempfile::tempdir().unwrap();
    let line = |text: &str, second: u32| {
        format!(
            "{}\n",
            json!({ "type": "user", "timestamp": format!("2026-09-22T00:00:{second:02}.000Z"), "cwd": "/w", "message": { "content": text } })
        )
    };
    // `a`: Plan, Again, Plan (the same row twice). `b` forks it, then diverges.
    let prefix = format!("{}{}{}", line("Plan", 0), line("Again", 1), line("Plan", 0));
    write(&dir.path().join("claude/-w/a.jsonl"), &prefix);
    write(&dir.path().join("claude/-w/b.jsonl"), &format!("{prefix}{}{}", line("Tail one", 3), line("Tail two", 4)));
    let db = dir.path().join("ingest.sqlite");
    Engine::open(roots(dir.path()), &db).unwrap().scan(&mut |_| {});
    let reader = Reader::open(&db).unwrap();
    let of = |id: &str, count: u32| MergePrefix { session_id: id.to_string(), created_at: 0.0, count };
    assert_eq!(reader.merged_count(&[of("a", 3)]).unwrap(), 3, "one session: its own prefix");
    assert_eq!(reader.merged_count(&[of("a", 3), of("b", 5)]).unwrap(), 5, "the fork's prefix counts once");
    assert_eq!(reader.merged_count(&[of("a", 2), of("b", 5)]).unwrap(), 5, "a shorter settled prefix adds nothing");
    assert_eq!(reader.merged_count(&[of("a", 1), of("b", 1)]).unwrap(), 1, "only the settled prefix is counted");
    assert_eq!(reader.merged_count(&[of("missing", 4)]).unwrap(), 0, "an unknown session contributes nothing");
}

// Fix-guard (2026-10-23): `known()` read the `source` table, whose rows carry the fold checkpoint
// inline, so a cold start spent 1.6 s on it (11k sources). It must stay on the covering index.
#[test]
fn reading_every_stamp_never_touches_the_checkpoint_pages() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("ingest.sqlite");
    let plans = Writer::open(&db).unwrap().plans().unwrap();
    let (_, plan) = plans.iter().find(|(q, _)| q == unleashd_ingest::store::KNOWN).expect("known() is in plans()");
    assert!(plan.iter().any(|line| line.contains("COVERING INDEX")), "known() left its covering index: {plan:?}");
}
