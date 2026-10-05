//! Conversation records (T23a): compare-and-set under a real two-writer race, the query-plan
//! guard, and the two behaviours config-store.ts carried incident comments for. The one-time importer
//! and its tests were deleted after the 2026-09-27 swap (last at 03fc931).

use rusqlite::Connection;
use std::sync::{Arc, Barrier};
use unleashd_ingest::model::Provider;
use unleashd_ingest::records::*;

const T0: i64 = 1_790_000_000_000;

fn config(model: &str) -> ConversationConfig {
    ConversationConfig {
        provider: Provider::Codex,
        model: ModelSelection::Explicit { model_id: model.into() },
        reasoning: ReasoningSelection::Default,
    }
}

fn resolved(model: &str) -> ResolvedExecutionConfig {
    ResolvedExecutionConfig { provider: Provider::Codex, model_id: model.into(), reasoning_effort: Some("high".into()) }
}

fn binding(session: &str) -> SessionBinding {
    SessionBinding { provider: Provider::Codex, session_id: session.into(), buddy_audience_key: None, latest_usage: None }
}

fn new_record(id: &str) -> NewRecord {
    NewRecord {
        conversation_id: id.into(),
        kind: ConversationKind::Chat,
        session_bindings: vec![],
        current_session: Some(binding(&format!("{id}-s1"))),
        working_directory: Some("/work".into()),
        creation: None,
        config: config("gpt-a"),
        last_resolved_config: Some(resolved("gpt-a")),
        provenance: Provenance::User,
    }
}

fn set(id: &str, expected: i64, model: &str) -> SetConfig {
    SetConfig {
        conversation_id: id.into(),
        expected_config_revision: expected,
        config: config(model),
        last_resolved_config: resolved(model),
        provenance: None,
    }
}

#[test]
fn set_config_is_compare_and_set_across_two_racing_writers() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("records.sqlite");
    let mut a = Records::open(&db).unwrap();
    assert!(matches!(a.create(new_record("c1"), T0).unwrap(), CreateOutcome::Created { .. }));

    // Two connections (the shape of two processes), released together on the same revision.
    let rounds = 40;
    let b = Arc::new(std::sync::Mutex::new(Records::open(&db).unwrap()));
    let a = Arc::new(std::sync::Mutex::new(a));
    for round in 0..rounds {
        let barrier = Arc::new(Barrier::new(2));
        let spawn = |records: Arc<std::sync::Mutex<Records>>, model: &'static str| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut records = records.lock().unwrap();
                barrier.wait();
                records.set_config(set("c1", round, model), T0 + round).unwrap()
            })
        };
        let (x, y) = (spawn(a.clone(), "gpt-x"), spawn(b.clone(), "gpt-y"));
        let outcomes = [x.join().unwrap(), y.join().unwrap()];
        let committed: Vec<_> =
            outcomes.iter().filter_map(|o| if let SetConfigOutcome::Committed { record } = o { Some(record) } else { None }).collect();
        let conflicts: Vec<_> = outcomes
            .iter()
            .filter_map(|o| if let SetConfigOutcome::RevisionConflict { current } = o { Some(current) } else { None })
            .collect();
        assert_eq!((committed.len(), conflicts.len()), (1, 1), "round {round}: exactly one writer wins: {outcomes:?}");
        // The loser is handed the winner's record, not a stale read.
        assert_eq!(conflicts[0], committed[0]);
        assert_eq!(committed[0].config_revision, round + 1);
    }
    let reader = Records::open(&db).unwrap();
    let last = reader.get("c1").unwrap().unwrap();
    assert_eq!((last.config_revision, last.record_revision), (rounds, rounds));

    // A stale expectation, a tombstone and a missing id are typed outcomes, not errors.
    let mut w = b.lock().unwrap();
    assert!(
        matches!(w.set_config(set("c1", 0, "gpt-z"), T0).unwrap(), SetConfigOutcome::RevisionConflict { current } if current.config_revision == rounds)
    );
    assert!(w.mark_deleted("c1", T0).unwrap());
    assert!(matches!(w.set_config(set("c1", rounds, "gpt-z"), T0).unwrap(), SetConfigOutcome::Tombstoned { .. }));
    assert!(matches!(w.set_config(set("nope", 0, "gpt-z"), T0).unwrap(), SetConfigOutcome::Missing));
    assert!(matches!(w.create(new_record("c1"), T0).unwrap(), CreateOutcome::Exists { .. }));
}

#[test]
fn rebinding_the_same_session_keeps_its_usage_and_a_new_session_starts_fresh() {
    // config-store.ts: "Re-binding the SAME session (an audience-key change) must not discard its
    // measured usage" — the context meter would drop to zero on every Buddy audience change.
    let dir = tempfile::tempdir().unwrap();
    let mut r = Records::open(&dir.path().join("r.sqlite")).unwrap();
    r.create(new_record("c1"), T0).unwrap();
    let usage = ProviderTurnUsage {
        context_tokens: 1000,
        output_tokens: 10,
        cached_input_tokens: None,
        cache_write_tokens: None,
        context_window: None,
        observed_at: "2026-09-25T10:00:00.000Z".into(),
    };
    r.set_current_session_usage("c1", "c1-s1", usage.clone(), T0).unwrap();
    // A late usage write for a session that is not current is dropped.
    let late = r.set_current_session_usage("c1", "other", usage.clone(), T0).unwrap().unwrap();
    assert_eq!(late.current_session.as_ref().unwrap().session_id, "c1-s1");

    let rebound = SessionBinding { buddy_audience_key: Some("aud-2".into()), ..binding("c1-s1") };
    let same = r.set_current_session("c1", rebound, T0).unwrap().unwrap();
    assert_eq!(same.current_session.as_ref().unwrap().latest_usage, Some(usage));
    assert_eq!(same.current_session.as_ref().unwrap().buddy_audience_key.as_deref(), Some("aud-2"));

    let moved = r.set_current_session("c1", binding("c1-s2"), T0).unwrap().unwrap();
    assert_eq!(moved.current_session.as_ref().unwrap().latest_usage, None);
    assert_eq!(moved.session_bindings.iter().map(|b| b.session_id.as_str()).collect::<Vec<_>>(), ["c1-s1"]);
    // Both sessions resolve to the conversation through the index.
    for s in ["c1-s1", "c1-s2"] {
        assert_eq!(r.find_by_session(Provider::Codex, s).unwrap().unwrap().conversation_id, "c1");
    }
}

#[test]
fn the_first_message_lease_is_exclusive_for_fifteen_seconds() {
    // Two dispatchers must not both deliver a creation message; a crashed one must not strand it.
    let dir = tempfile::tempdir().unwrap();
    let mut r = Records::open(&dir.path().join("r.sqlite")).unwrap();
    let input = NewRecord {
        creation: Some(ConversationCreation { initial_message: Some("hello".into()), ..Default::default() }),
        ..new_record("c1")
    };
    r.create(input, T0).unwrap();
    assert!(r.claim_initial_message_dispatch("c1", "tok-a", T0).unwrap().is_some());
    assert!(r.claim_initial_message_dispatch("c1", "tok-b", T0 + 14_999).unwrap().is_none(), "lease held");
    assert!(r.claim_initial_message_dispatch("c1", "tok-b", T0 + 15_000).unwrap().is_some(), "an expired lease is re-claimable");
    assert!(r.complete_initial_message_dispatch("c1", "tok-a", T0 + 15_001).unwrap().is_none(), "the old holder lost it");
    let done = r.complete_initial_message_dispatch("c1", "tok-b", T0 + 15_002).unwrap().unwrap();
    let creation = done.creation.unwrap();
    assert_eq!(creation.initial_message_dispatched_at.as_deref(), Some("2026-09-21T14:13:35.002Z"), "formatted as Date.toISOString");
    assert_eq!((creation.initial_message_dispatch_claim_token, creation.initial_message_dispatch_claimed_at), (None, None));
    assert!(r.claim_initial_message_dispatch("c1", "tok-c", T0 + 99_999).unwrap().is_none(), "delivered once");
}

#[test]
fn two_connections_open_a_new_file_at_once() {
    // Regression (T23b): concurrent opens of a fresh file raced on the WAL switch and the schema
    // row, and one failed (`database is locked` / `UNIQUE constraint failed: meta.key`).
    for _ in 0..50 {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("r.sqlite");
        let barrier = Arc::new(Barrier::new(8));
        let opens: Vec<_> = (0..8)
            .map(|_| {
                let (db, barrier) = (db.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    Records::open(&db).map(|_| ())
                })
            })
            .collect();
        for open in opens {
            open.join().unwrap().unwrap();
        }
    }
}

#[test]
fn no_record_read_or_write_scans_a_table() {
    // Pattern: fix-guards (docs/patterns.md#fix-guards). config-store.ts read all ~7,800 files
    // (42 MB, ~3.2 s) on a lookup miss; a by-session lookup that scans would bring that back.
    let dir = tempfile::tempdir().unwrap();
    let mut r = Records::open(&dir.path().join("r.sqlite")).unwrap();
    for i in 0..50 {
        r.create(new_record(&format!("c{i}")), T0).unwrap();
    }
    Connection::open(dir.path().join("r.sqlite")).unwrap().execute_batch("ANALYZE").unwrap();
    for (query, plan) in r.plans().unwrap() {
        for step in &plan {
            assert!(!step.starts_with("SCAN"), "full scan in `{query}`: {plan:?}");
        }
    }
}

#[test]
fn records_and_the_ingest_store_share_one_file_without_interfering() {
    // T23b may keep one file for backups; both schemas must open in either order and keep their data.
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("unleashd.sqlite");
    let mut records = Records::open(&db).unwrap();
    records.create(new_record("c1"), T0).unwrap();
    let writer = unleashd_ingest::store::Writer::open(&db).unwrap();
    assert_eq!(writer.rev().unwrap(), 0);
    drop(writer);
    let reopened = Records::open(&db).unwrap();
    assert_eq!(reopened.get("c1").unwrap().unwrap().conversation_id, "c1");
    assert!(unleashd_ingest::store::Reader::open(&db).unwrap().list_sessions(0).unwrap().1.is_empty());
}
