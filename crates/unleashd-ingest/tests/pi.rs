mod common;
use common::*;
use serde_json::{Value, json};
use unleashd_ingest::model::{Format, Provider};
use unleashd_ingest::read::{Apply, Taken};

fn entry(id: &str, parent: Option<&str>, message: Value) -> Value {
    json!({"type":"message", "id":id, "parentId":parent, "timestamp":"2026-10-13T00:00:00Z", "message":message})
}
fn assistant(text: &str, input: u32) -> Value {
    json!({"role":"assistant", "model":"gpt-6.1-sol", "provider":"openai-codex", "content":[{"type":"text", "text":text}],
        "usage":{"input":input, "output":5, "cacheRead":20, "cacheWrite":3,"cost":{"total":0.01}}})
}

#[test]
fn pi_history_appends_and_branches_preserve_exact_tools_and_all_billed_usage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("--project--/session.jsonl");
    let first = jsonl(&[
        json!({"type":"session", "version":3, "id":"native-session", "cwd":"/project"}),
        entry("u", None, json!({"role":"user", "content":"first"})),
        entry(
            "a",
            Some("u"),
            json!({"role":"assistant", "provider":"openai-codex", "model":"gpt-6.1-sol", "content":[
            {"type":"text", "text":"checking"}, {"type":"toolCall", "name":"codemode", "arguments":{"code":"text(await tools.mcp__buddy__inbox({}));"}}],
            "usage":{"input":100,"output":10,"cacheRead":25,"cacheWrite":0}}),
        ),
        entry(
            "r",
            Some("a"),
            json!({"role":"toolResult", "toolName":"codemode", "content":[{"type":"text","text":"receipt"}],
            "nestedCalls":{"calls":[{"name":"mcp__buddy__inbox","arguments":{},"status":"ok"}],"complete":true}}),
        ),
        entry("b", Some("r"), assistant("old branch", 200)),
    ]);
    write(&path, &first);
    let initial = read(Format::Pi, &path, None);
    let row = initial.row.as_ref().unwrap();
    assert_eq!(row.facts.session_id, "native-session");
    assert_eq!(row.facts.provider, Provider::Pi);
    assert_eq!(row.usage().as_ref().unwrap().input, 300.0);
    assert!(initial.messages[1].parts_json.as_ref().unwrap().contains("text(await tools.mcp__buddy__inbox({}));"));
    assert!(initial.messages[2].parts_json.as_ref().unwrap().contains("mcp__buddy__inbox"));
    assert!(initial.messages[3].parts_json.as_ref().unwrap().contains("receipt"));
    append(
        &path,
        &jsonl(&[entry("u2", Some("b"), json!({"role":"user", "content":"second"})), entry("c", Some("u2"), assistant("appended", 50))]),
    );
    let appended = read(Format::Pi, &path, Some(&initial));
    assert_eq!(appended.taken, Taken::Resumed);
    assert_eq!(appended.messages.len(), 2);
    let mut history = initial.messages.clone();
    apply(&mut history, &appended);
    assert_eq!(history, parse(Format::Pi, &path).0);
    // A new leaf with a different parent is a branch, not an appended answer
    // to the old branch. Usage still includes the abandoned provider calls.
    append(&path, &jsonl(&[entry("d", Some("u"), assistant("new branch", 10))]));
    let branched = read(Format::Pi, &path, Some(&appended));
    assert_eq!(branched.apply, Apply::Replace);
    assert_eq!(contents(&branched.messages), ["first", "new branch"]);
    assert_eq!(branched.row.as_ref().unwrap().usage().as_ref().unwrap().input, 360.0);
    assert_eq!(branched.turns.len(), 4);
    assert_eq!(branched.messages, parse(Format::Pi, &path).0);
}
