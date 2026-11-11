//! Usage turns and the latest context, end to end through the engine and the store, on the
//! record shapes /api/usage (usage-routes.ts) and the context meter (session-context.ts) read.

mod common;

use common::*;
use serde_json::{Value, json};
use std::path::Path;
use unleashd_ingest::engine::Engine;
use unleashd_ingest::model::{Format, Root, UsageGroupBy, UsageKey, UsageQuery};
use unleashd_ingest::store::Reader;

const T0: f64 = 1_788_000_000_000.0; // 2026-08-29T10:40:00Z

fn iso(ms: f64) -> String {
    let secs = (ms / 1000.0) as i64;
    let days = secs.div_euclid(86_400);
    // Civil from days (Hinnant), enough for fixture timestamps.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let rem = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn scan(dir: &Path, roots: Vec<Root>) -> Reader {
    let db = dir.join("ingest.sqlite");
    Engine::open(roots, &db).unwrap().scan(&mut |_| {});
    Reader::open(&db).unwrap()
}

fn claude_assistant(id: &str, at: f64, usage: Value, sidechain: bool) -> Value {
    json!({ "type": "assistant", "timestamp": iso(at), "cwd": "/w", "isSidechain": sidechain,
            "message": { "id": id, "model": "claude-opus-4", "usage": usage, "content": [{ "type": "text", "text": id }] } })
}

#[test]
fn claude_turns_count_each_request_once_and_the_meter_skips_sidechains() {
    let dir = tempfile::tempdir().unwrap();
    let u = |i: u64, o: u64, r: u64, w: u64| json!({ "input_tokens": i, "output_tokens": o, "cache_read_input_tokens": r, "cache_creation_input_tokens": w });
    let text = jsonl(&[
        // One reply written as two content-block lines with the same usage: counted once.
        claude_assistant("m1", T0, u(10, 5, 100, 20), false),
        claude_assistant("m1", T0, u(10, 5, 100, 20), false),
        json!({ "type": "system", "subtype": "compact_boundary", "compactMetadata": { "preTokens": 150_000, "postTokens": 9_000, "trigger": "auto" } }),
        claude_assistant("m2", T0 + 86_400_000.0, u(3, 7, 900, 0), false),
        // A sub-agent request: billed, but it measures the sub-agent's window, not this thread's.
        claude_assistant("m3", T0 + 86_400_000.0 + 1.0, u(1, 1, 50_000, 0), true),
    ]);
    write(&dir.path().join("claude/-w/s1.jsonl"), &text);
    let reader = scan(dir.path(), vec![Root { format: Format::Claude, path: dir.path().join("claude").to_string_lossy().into_owned() }]);

    let by_session = reader.usage(&UsageQuery { since: 0.0, until: None, group_by: UsageGroupBy::Session }).unwrap();
    let [g] = by_session.groups.as_slice() else { panic!("{by_session:?}") };
    assert_eq!((g.turns, g.input, g.output, g.cache_read, g.cache_write), (3, 14.0, 13.0, 51_000.0, 20.0));
    assert!(matches!(&g.key, UsageKey::Session { session_id, model: Some(m), .. } if session_id == "s1" && m == "claude-opus-4"));

    // A window selects turns by their own time; days are UTC.
    let second_day = reader.usage(&UsageQuery { since: T0 + 1.0, until: None, group_by: UsageGroupBy::Day }).unwrap();
    let [d] = second_day.groups.as_slice() else { panic!("{second_day:?}") };
    assert_eq!((&d.key, d.turns, d.input + d.output), (&UsageKey::Day { day: "2026-08-30".into() }, 2, 12.0));

    let context = reader.latest_context("s1").unwrap().unwrap();
    assert_eq!(context.context_tokens, 3.0 + 900.0);
    assert_eq!(context.context_window, None);
    let compaction = context.compaction.unwrap();
    assert_eq!((compaction.count, compaction.pre_tokens, compaction.trigger.as_deref()), (1, Some(150_000.0), Some("auto")));
    assert_eq!(reader.latest_context("nope").unwrap(), None);
}

// CONNECT_PLAN §10, the second real run: every Claude turn wrote its cache at the 1-hour tier
// (2x input) and the rows did not say so, so pricing used the 5-minute rate (1.25x) and recorded
// spend was 27% low. The split must survive into the totals, a record naming no tier must count
// as the dearer one, and a store made before the column must gain it with its old rows priced so.
#[test]
fn claude_cache_writes_keep_their_tier_and_an_unknown_tier_counts_as_1h() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("ingest.sqlite");
    // A store as the build before the split made it: no `cache_write_1h`, one row already in it.
    {
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
             INSERT INTO meta (key, value) VALUES ('schema', 2), ('rev', 0);
             CREATE TABLE usage_turn (source_id INTEGER NOT NULL, n INTEGER NOT NULL, at REAL, model TEXT,
               input REAL NOT NULL, output REAL NOT NULL, cache_read REAL NOT NULL, cache_write REAL NOT NULL,
               reported_cost REAL, PRIMARY KEY (source_id, n)) WITHOUT ROWID;
             INSERT INTO usage_turn VALUES (999, 0, 1, 'claude-opus-4', 0, 0, 0, 40, NULL);",
        )
        .unwrap();
    }
    let split = json!({ "input_tokens": 4, "output_tokens": 941, "cache_read_input_tokens": 10_613,
        "cache_creation_input_tokens": 5_368,
        "cache_creation": { "ephemeral_1h_input_tokens": 5_000, "ephemeral_5m_input_tokens": 368 } });
    let unsplit = json!({ "input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 100 });
    let text = jsonl(&[claude_assistant("m1", T0, split, false), claude_assistant("m2", T0 + 1.0, unsplit, false)]);
    write(&dir.path().join("claude/-w/s1.jsonl"), &text);
    Engine::open(vec![Root { format: Format::Claude, path: dir.path().join("claude").to_string_lossy().into_owned() }], &db)
        .unwrap()
        .scan(&mut |_| {});
    let reader = Reader::open(&db).unwrap();
    let report = reader.usage(&UsageQuery { since: 0.0, until: None, group_by: UsageGroupBy::Session }).unwrap();
    let [g] = report.groups.as_slice() else { panic!("{report:?}") };
    assert_eq!((g.cache_write, g.cache_write_1h), (5_468.0, 5_100.0));

    // The old store opened (the engine wrote into the column it added); the row the old build
    // wrote kept its unknown tier rather than a guessed 0.
    let conn = rusqlite::Connection::open(&db).unwrap();
    let old: Option<f64> = conn.query_row("SELECT cache_write_1h FROM usage_turn WHERE source_id = 999", [], |r| r.get(0)).unwrap();
    assert_eq!(old, None, "an old row's tier was never read");
}

fn codex(at: f64, kind: &str, payload: Value) -> Value {
    json!({ "timestamp": iso(at), "type": kind, "payload": payload })
}

fn token_count(at: f64, total_in: u64, cached: u64, out: u64, last_in: u64) -> Value {
    codex(
        at,
        "event_msg",
        json!({ "type": "token_count",
        "info": { "total_token_usage": { "input_tokens": total_in, "cached_input_tokens": cached, "output_tokens": out },
                  "last_token_usage": { "input_tokens": last_in }, "model_context_window": 272_000 },
        "rate_limits": { "primary": { "used_percent": total_in, "window_minutes": 300 } } }),
    )
}

#[test]
fn codex_turns_telescope_to_the_last_total_and_the_meter_skips_the_reset_sentinel() {
    let dir = tempfile::tempdir().unwrap();
    let text = jsonl(&[
        codex(T0, "session_meta", json!({ "id": "c1", "cwd": "/w" })),
        codex(T0, "turn_context", json!({ "cwd": "/w", "model": "gpt-5-codex" })),
        codex(T0, "event_msg", json!({ "type": "user_message", "message": "go" })),
        token_count(T0 + 1.0, 1000, 800, 50, 1000),
        token_count(T0 + 2.0, 1000, 800, 50, 1000), // a repeated total is no request
        codex(T0 + 3.0, "compacted", json!({ "replacement_history": [] })),
        token_count(T0 + 4.0, 1500, 1100, 90, 0), // the post-compaction reset sentinel
        token_count(T0 + 5.0, 2600, 2000, 130, 1100),
    ]);
    let path = dir.path().join("codex/2026/08/29/rollout-2026-08-29T10-40-00-c1.jsonl");
    write(&path, &text);
    assert_resume_equals_full(Format::Codex, dir.path(), "resume.jsonl", &text);
    let reader = scan(dir.path(), vec![Root { format: Format::Codex, path: dir.path().join("codex").to_string_lossy().into_owned() }]);

    let report = reader.usage(&UsageQuery { since: 0.0, until: None, group_by: UsageGroupBy::Model }).unwrap();
    let [g] = report.groups.as_slice() else { panic!("{report:?}") };
    // usage-routes.ts: the last cumulative total, cached input split out of input.
    assert_eq!((g.turns, g.input, g.cache_read, g.output), (3, 600.0, 2000.0, 130.0));
    assert!(matches!(&g.key, UsageKey::Model { model: Some(m), .. } if m == "gpt-5-codex"));
    assert!(report.codex_rate_limits.unwrap().contains("\"used_percent\":2600"));

    let context = reader.latest_context("c1").unwrap().unwrap();
    assert_eq!((context.context_tokens, context.context_window), (1100.0, Some(272_000.0)));
    assert_eq!(context.compaction.map(|c| c.count), Some(1));
}

// CONNECT_PLAN §10 (second real run): a Codex expedition call started a sub-agent that no flag
// can block; its tokens are in its own rollout, so pricing only the call's session missed them.
// The sub-agent's usage group names its parent, which is how the meter finds and adds it.
#[test]
fn a_codex_sub_agent_rollout_is_its_own_usage_group_naming_its_parent() {
    let dir = tempfile::tempdir().unwrap();
    let parent = jsonl(&[
        codex(T0, "session_meta", json!({ "id": "p1", "cwd": "/w", "source": "exec" })),
        codex(T0, "turn_context", json!({ "cwd": "/w", "model": "gpt-6.1-sol" })),
        codex(T0, "event_msg", json!({ "type": "user_message", "message": "go" })),
        token_count(T0 + 1.0, 1000, 800, 50, 1000),
    ]);
    let child = jsonl(&[
        codex(T0, "session_meta", json!({ "id": "k1", "cwd": "/w",
            "source": { "subagent": { "thread_spawn": { "parent_thread_id": "p1", "depth": 1 } } } })),
        codex(T0, "turn_context", json!({ "cwd": "/w", "model": "gpt-6.1-sol" })),
        codex(T0, "event_msg", json!({ "type": "user_message", "message": "probe" })),
        token_count(T0 + 2.0, 13_258, 0, 5, 13_258),
    ]);
    write(&dir.path().join("codex/2026/08/29/rollout-2026-08-29T10-40-00-p1.jsonl"), &parent);
    write(&dir.path().join("codex/2026/08/29/rollout-2026-08-29T10-40-01-k1.jsonl"), &child);
    let reader = scan(dir.path(), vec![Root { format: Format::Codex, path: dir.path().join("codex").to_string_lossy().into_owned() }]);
    let report = reader.usage(&UsageQuery { since: 0.0, until: None, group_by: UsageGroupBy::Session }).unwrap();
    let mut by: Vec<(String, Option<String>, f64)> = report
        .groups
        .iter()
        .map(|g| match &g.key {
            UsageKey::Session { session_id, parent_session_id, .. } => (session_id.clone(), parent_session_id.clone(), g.input),
            other => panic!("{other:?}"),
        })
        .collect();
    by.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(by, vec![("k1".into(), Some("p1".into()), 13_258.0), ("p1".into(), None, 200.0)]);
}

#[test]
fn muse_context_counts_only_finished_compactions_and_recovers_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let event = |us: u64, kind: &str, event: Value| json!({ "stream": { "kind": "session", "id": "m1" }, "recorded_at": us, "payload_type": "runtime.session", "payload": { "kind": kind, "event": event } });
    let text = jsonl(&[
        event(1_000, "run", json!({ "kind": "started", "prompt": "hi" })),
        event(2_000, "model", json!({ "kind": "model_completed", "usage": { "input_tokens": 22_690 } })),
        event(
            3_000,
            "context",
            json!({ "kind": "context_compaction_candidate", "status": "failed", "trigger": "x",
            "strategy": { "target_budget_tokens": 160_000, "config_fingerprint": "hard=0.9;soft=0.8" } }),
        ),
        event(
            4_000,
            "context",
            json!({ "kind": "context_compaction_candidate", "status": "succeeded", "trigger": "soft_threshold",
            "strategy": { "target_budget_tokens": 160_000, "config_fingerprint": "hard=0.9;soft=0.8" } }),
        ),
        event(5_000, "model", json!({ "kind": "model_completed", "usage": { "input_tokens": 23_158 } })),
    ]);
    write(&dir.path().join("muse/2026/08/29/m1/session.jsonl"), &text);
    let reader = scan(dir.path(), vec![Root { format: Format::Muse, path: dir.path().join("muse").to_string_lossy().into_owned() }]);
    let context = reader.latest_context("m1").unwrap().unwrap();
    assert_eq!((context.context_tokens, context.context_window), (23_158.0, Some(200_000.0)));
    let compaction = context.compaction.unwrap();
    assert_eq!((compaction.count, compaction.trigger.as_deref()), (1, Some("soft_threshold")));
}

/// S9 (2026-09-26): Codex writes one `rate_limits` payload per bucket. On the dev machine the
/// newest was `premium` with both windows null, and `usage()` returned it, so the Usage panel
/// showed no Codex limits. The newest payload that has a window must win, across sessions and
/// within one.
#[test]
fn codex_rate_limits_skip_a_newer_bucket_without_windows() {
    let dir = tempfile::tempdir().unwrap();
    let limits = |at: f64, bucket: &str, primary: Value| {
        codex(
            at,
            "event_msg",
            json!({ "type": "token_count", "info": null,
            "rate_limits": { "limit_id": bucket, "primary": primary, "secondary": null, "plan_type": "pro" } }),
        )
    };
    let window = json!({ "used_percent": 29.0, "window_minutes": 10080, "resets_at": 1_790_518_542 });
    let older = jsonl(&[
        codex(T0, "session_meta", json!({ "id": "c1", "cwd": "/w" })),
        codex(T0, "event_msg", json!({ "type": "user_message", "message": "go" })),
        limits(T0 + 1.0, "codex", window),
        limits(T0 + 2.0, "premium", Value::Null), // same session, newer, windowless
    ]);
    let newer = jsonl(&[
        codex(T0 + 60_000.0, "session_meta", json!({ "id": "c2", "cwd": "/w" })),
        codex(T0 + 60_000.0, "event_msg", json!({ "type": "user_message", "message": "go" })),
        limits(T0 + 60_001.0, "premium", Value::Null),
    ]);
    write(&dir.path().join("codex/2026/08/29/rollout-2026-08-29T10-40-00-c1.jsonl"), &older);
    write(&dir.path().join("codex/2026/08/29/rollout-2026-08-29T10-41-00-c2.jsonl"), &newer);
    let reader = scan(dir.path(), vec![Root { format: Format::Codex, path: dir.path().join("codex").to_string_lossy().into_owned() }]);

    let report = reader.usage(&UsageQuery { since: 0.0, until: None, group_by: UsageGroupBy::Model }).unwrap();
    let limits: Value = serde_json::from_str(&report.codex_rate_limits.unwrap()).unwrap();
    assert_eq!((limits["limit_id"].as_str(), limits["primary"]["used_percent"].as_f64()), (Some("codex"), Some(29.0)));
}
