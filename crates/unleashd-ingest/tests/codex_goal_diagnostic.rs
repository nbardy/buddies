//! Characterization only: synthetic records, not an export of the Wave_sim incident.
//! These tests record defects in the current parser, not accepted product behavior.

mod common;

use common::*;
use serde_json::{Value, json};
use unleashd_ingest::model::{Format, Role};

const INTERNAL_LOOKING: &str = "<codex_internal_context source=\"goal\">Continue the goal.</codex_internal_context>";

fn row(kind: &str, payload: Value) -> Value {
    json!({ "timestamp": "2026-10-08T16:42:00.000Z", "type": kind, "payload": payload })
}

fn response(text: &str) -> Value {
    row("response_item", json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] }))
}

fn mixed() -> String {
    jsonl(&[
        response("owner before event mode"),
        response("paired owner message"),
        row("event_msg", json!({ "type": "user_message", "message": "paired owner message" })),
        response("owner after event mode"),
        row("event_msg", json!({ "type": "agent_message", "message": "reply" })),
    ])
}

#[test]
fn characterize_distinct_response_only_owner_messages_lost_in_mixed_stream() {
    let dir = tempfile::tempdir().unwrap();
    let text = mixed();
    let path = dir.path().join("mixed.jsonl");
    write(&path, &text);
    let (messages, _) = parse(Format::Codex, &path);
    assert_eq!(contents(&messages), ["paired owner message", "reply"]);
    // Incremental reads reproduce the same loss: it is not merely a full-read artifact.
    assert_resume_equals_full(Format::Codex, dir.path(), "mixed-resume.jsonl", &text);
}

#[test]
fn characterize_untagged_internal_looking_text_is_user_in_both_modes() {
    let dir = tempfile::tempdir().unwrap();
    for (name, record) in [
        ("response", response(INTERNAL_LOOKING)),
        ("event", row("event_msg", json!({ "type": "user_message", "message": INTERNAL_LOOKING }))),
    ] {
        let path = dir.path().join(format!("{name}.jsonl"));
        write(&path, &jsonl(&[record]));
        let (messages, _) = parse(Format::Codex, &path);
        assert_eq!(contents(&messages), [INTERNAL_LOOKING]);
        assert_eq!(messages[0].role, Role::User);
    }
    // This also proves why a text-prefix filter would delete a genuine owner paste:
    // the synthetic records contain no provenance capable of distinguishing the two.
}

#[test]
#[ignore = "desired regression: fails until event/response reconciliation preserves unpaired messages"]
fn desired_mixed_stream_preserves_distinct_owner_messages_and_dedupes_pair() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixed.jsonl");
    write(&path, &mixed());
    let (messages, _) = parse(Format::Codex, &path);
    assert_eq!(contents(&messages), ["owner before event mode", "paired owner message", "owner after event mode", "reply"]);
}
