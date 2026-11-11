//! Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, appended only. Port of
//! `parseCodexJsonlFile` + `extractMessagesFromCodexEntries` + the turn-interruption notices
//! (codex-turn-lifecycle.ts) + usage-routes.ts `codexTokenTotals` (usage turns, rate limits) +
//! session-context.ts `parseCodexLines` (the context meter).
//!
//! Most bytes of a rollout are tool output, reasoning and world state that no message keeps, so
//! a line's first two `"type"` tags decide whether it is parsed at all (the TS filter). That
//! filter is what keeps a 934 MB rollout cheap; the tail read is what keeps it cheap on change.

use super::{Ctx, Facts, Fold, Line, Previous, Sink, finite, normalize_dir, parse_time, widen};
use crate::markers::{Hints, Rebuild, Visible};
use crate::model::{Compaction, ContextReading, Cwd, Provider, Role, ToolCall, Usage, UsageTurn};
use crate::text::{has_buddy_receipt, pretty_json};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

const RETAINED_EVENTS: &[&str] = &["user_message", "agent_message", "task_started", "task_complete", "turn_aborted"];

static TYPE_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""type"\s*:\s*"([^"]+)""#).unwrap());
static SESSION_ID_IN_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$").unwrap());
static PLUGINS_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^<recommended_plugins>\nHere is a list of plugins that are available but not installed\.\n\n(?:- [^\n]+\n)+</recommended_plugins>$").unwrap()
});
static AGENTS_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^# AGENTS\.md instructions for [^\n]+\n\n<INSTRUCTIONS>\n(?s:.)*\n</INSTRUCTIONS>$").unwrap());
static ENVIRONMENT_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<environment_context>\n(?s:.)*\n</environment_context>$").unwrap());

/// The first two `"type":"…"` values of a line, without parsing it.
fn line_types(line: &str) -> (Option<&str>, Option<&str>) {
    const KEY: &str = "\"type\":\"";
    if let Some(first) = line.find(KEY) {
        let outer_start = first + KEY.len();
        let outer_end = line[outer_start..].find('"').map(|i| outer_start + i);
        let outer = outer_end.map(|end| &line[outer_start..end]);
        let search_from = outer_end.map_or(line.len(), |e| e + 1);
        let inner = line[search_from..].find(KEY).and_then(|second| {
            let start = search_from + second + KEY.len();
            line[start..].find('"').map(|len| &line[start..start + len])
        });
        return (outer, inner);
    }
    let head = crate::text::utf16_prefix(line, 1024);
    let mut tags = TYPE_TAG.captures_iter(head).map(|c| c.get(1).unwrap().as_str());
    (tags.next(), tags.next())
}

pub fn session_id_from_name(stem: &str) -> Option<String> {
    SESSION_ID_IN_NAME.captures(stem).map(|c| c[1].to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum TurnStatus {
    Running,
    Completed,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Turn {
    order: u64,
    status: TurnStatus,
    started_at: f64,
    completed_at: Option<f64>,
    reason: Option<String>,
}

/// A message or notice waiting for the end of a full read, where it is sorted.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pending {
    role: Role,
    at: Option<f64>,
    completed_at: Option<f64>,
    content: String,
    tool_call: Option<ToolCall>,
    /// A response-item message: withdrawn if the file turns out to have event messages.
    #[serde(default)]
    from_response: bool,
}

/// Messages sort by time; a notice sorts after messages of the same time (it was appended after
/// all of them before a stable sort). `None` sorts last: JS stamped it `new Date()`.
fn sort_key(at: Option<f64>, notice: bool) -> (f64, bool) {
    (at.unwrap_or(f64::INFINITY), notice)
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CodexFold {
    retained: u64,
    session_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    parent: Option<String>,
    span: Option<(f64, f64)>,
    /// Mode: event messages exist, so response-item messages are never shown.
    has_events: bool,
    /// An event message was read. Until then response-item messages are parsed (and widen the
    /// time span) even in event mode, as the single-pass TS parser did.
    events_seen: bool,
    response_messages_shown: bool,
    #[serde(with = "super::digest_set")]
    seen_calls: HashSet<u64>,
    prev: Previous,
    /// Until event mode: the seqs of the response-item messages shown, and `prev` / the order
    /// key as they would be without them (what event mode must continue from).
    response_seqs: Vec<u32>,
    other_prev: Previous,
    other_key: Option<(f64, bool)>,
    turns: HashMap<String, Turn>,
    next_turn_order: u64,
    last_key: Option<(f64, bool)>,
    buffering: bool,
    buffer: Vec<Pending>,
    usage: Option<Usage>,
    /// The last real request's input (`last_token_usage`; a 0 after a compaction is a reset
    /// sentinel, not a request), the reported window, and top-level `compacted` records.
    context_tokens: Option<f64>,
    context_window: Option<f64>,
    compactions: u32,
    rate_limits: Option<String>,
}

fn parse_epoch(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64().filter(|f| f.is_finite())?;
    super::js_time(if n.abs() < 100_000_000_000.0 { n * 1000.0 } else { n })
}

fn classify_abort(reason: Option<&str>) -> &'static str {
    let Some(reason) = reason.filter(|r| !r.is_empty()) else { return "unknown" };
    let lower = reason.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    let restart = has(&["restart", "shutdown"]) || Regex::new(r"hot.?reload|server.?stop").unwrap().is_match(&lower);
    if restart {
        "restart"
    } else if has(&["error", "fail", "panic", "crash"]) {
        "error"
    } else if has(&["interrupt", "cancel", "kill", "abort", "stop"]) {
        "interrupted"
    } else {
        "unknown"
    }
}

fn interruption_message(reason: Option<&str>) -> String {
    let trimmed = reason.map(crate::text::js_trim).filter(|r| !r.is_empty());
    match (classify_abort(reason), trimmed) {
        ("restart", Some(r)) if r != "server restart" => format!("Turn interrupted by restart: {r}"),
        ("restart", _) => "Turn interrupted by server restart.".into(),
        ("error", Some(r)) => format!("Turn failed: {r}"),
        ("error", None) => "Turn failed.".into(),
        ("interrupted", Some(r)) if r != "interrupted" => format!("Turn interrupted: {r}"),
        ("interrupted", _) => "Turn interrupted.".into(),
        (_, Some(r)) => format!("Turn aborted: {r}"),
        (_, None) => "Turn aborted.".into(),
    }
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| matches!(b.get("type").and_then(Value::as_str), Some("input_text" | "output_text" | "text")))
            .filter_map(|b| b.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

const SETUP_KINDS: &[&str] = &["agents_md.instructions", "environments.environment_context", "plugins.recommendations"];

/// Codex app transcripts carry setup blocks (AGENTS.md, environment, plugin lists) as user
/// content. They are removed by their provenance tags, never by matching text, so a user's own
/// pasted AGENTS.md stays visible (`extractCodexUserContent`).
fn user_content(payload: &Value, before_first_message: bool) -> String {
    let metadata = payload.get("internal_chat_message_metadata_passthrough");
    let kinds = metadata.and_then(|m| m.get("content_item_kinds"));
    let content = payload.get("content");
    if let (Some(Value::Array(blocks)), Some(Value::Array(kinds))) = (content, kinds)
        && kinds.len() == blocks.len()
    {
        let kept: Vec<Value> = blocks
            .iter()
            .zip(kinds)
            .filter(|(_, kind)| !kind.as_str().is_some_and(|k| SETUP_KINDS.contains(&k)))
            .map(|(block, _)| block.clone())
            .collect();
        return content_text(Some(&Value::Array(kept)));
    }
    // Codex 0.146 did not tag its startup bundle; only that exact three-block envelope is removed.
    if before_first_message
        && kinds.is_none()
        && metadata.and_then(|m| m.get("turn_id")).is_some_and(Value::is_string)
        && let Some(Value::Array(blocks)) = content
        && blocks.len() == 3
        && blocks.iter().all(|b| b.get("type").and_then(Value::as_str) == Some("input_text"))
    {
        let texts: Vec<String> = blocks.iter().map(|b| content_text(Some(&Value::Array(vec![b.clone()])))).collect();
        if PLUGINS_BLOCK.is_match(&texts[0]) && AGENTS_BLOCK.is_match(&texts[1]) && ENVIRONMENT_BLOCK.is_match(&texts[2]) {
            return String::new();
        }
    }
    content_text(content)
}

/// A `rate_limits` payload with at least one usage window (`primary` or `secondary`).
fn has_window(limits: &Value) -> bool {
    crate::text::truthy(limits.get("primary")) || crate::text::truthy(limits.get("secondary"))
}

impl CodexFold {
    /// A `token_count` event: the cumulative total (the last one wins; its growth is one usage
    /// turn), this request's context, the window, and the rate limits.
    fn token_count(&mut self, sink: &mut Sink, payload: &Value, at: Option<f64>) {
        // Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate) — the boundary keeps
        // only a payload the Usage panel can draw. Codex writes one `rate_limits` payload per
        // bucket (`limit_id` `codex`, `codex_bengalfox`, `premium`, ...), interleaved in a
        // session. Since 2026-09 the newest is usually `premium` with `primary` and `secondary`
        // both null; keeping "the last payload" stored that and the panel showed no Codex limits
        // (S9). The panel draws exactly the primary and secondary windows, so a windowless bucket
        // carries nothing for it and never replaces one that has a window.
        if let Some(limits) = payload.get("rate_limits").filter(|r| has_window(r)) {
            self.rate_limits = Some(limits.to_string());
        }
        let Some(info) = payload.get("info").filter(|i| crate::text::truthy(Some(i))) else { return };
        self.context_window = finite(info.get("model_context_window")).or(self.context_window);
        if let Some(input) = finite(info.pointer("/last_token_usage/input_tokens")).filter(|i| *i > 0.0) {
            self.context_tokens = Some(input);
        }
        let Some(total) = info.get("total_token_usage").filter(|t| crate::text::truthy(Some(t))) else { return };
        // Cached input is a subset of input; split out so `input` means uncached, as for Claude.
        let n = |k: &str| total.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        let cached = n("cached_input_tokens");
        let now = Usage { input: n("input_tokens") - cached, output: n("output_tokens"), cache_read: cached, cache_write: 0.0 };
        let before = self.usage.clone().unwrap_or_default();
        let grew = Usage {
            input: now.input - before.input,
            output: now.output - before.output,
            cache_read: now.cache_read - before.cache_read,
            cache_write: 0.0,
        };
        // Codex repeats an unchanged total (rate-limit refreshes); that is no request.
        if grew != Usage::default() {
            // Codex writes no cache (`cache_write` is 0), so no part of it is 1-hour.
            sink.turn(UsageTurn { at, model: self.model.clone(), usage: grew, cache_write_1h: 0.0, reported_cost: None });
        }
        self.usage = Some(now);
    }

    fn emit(&mut self, sink: &mut Sink, item: Pending, notice: bool) -> Result<(), Rebuild> {
        if self.buffering {
            self.buffer.push(item);
            return Ok(());
        }
        let key = sort_key(item.at, notice);
        if self.last_key.is_some_and(|last| key.partial_cmp(&last) == Some(std::cmp::Ordering::Less)) {
            return Err(Rebuild::Reordered);
        }
        self.push(sink, item, key)
    }

    /// Number and show one item in final order.
    fn push(&mut self, sink: &mut Sink, item: Pending, key: (f64, bool)) -> Result<(), Rebuild> {
        self.last_key = Some(key);
        if item.from_response {
            self.response_seqs.push(sink.next_seq);
        } else {
            self.other_key = Some(key);
        }
        sink.push(item.role, item.at, item.completed_at, item.content, item.tool_call)
    }

    /// The first event message: the TS parser shows event messages and never response-item
    /// messages once a file has any. Withdraw the response-item messages already shown and go on
    /// as if they had never been read. Nothing else depends on them: only they read or wrote
    /// `prev` (event messages come after) and the first-prompt markers (the only user messages),
    /// and every other item keeps its order. This was a full re-read from byte 0 (`Rebuild::
    /// EventMode`): 1.7–3.5 s for the 891 MB rollout on one appended line (BENCH-ingest-js-vs-rust).
    /// Guard: tests/tail.rs `codex_switch_to_event_mode_withdraws_without_a_reread`.
    fn enter_event_mode(&mut self, sink: &mut Sink) {
        self.has_events = true;
        self.buffer.retain(|p| !p.from_response);
        sink.withdraw(&std::mem::take(&mut self.response_seqs));
        sink.visible = Visible::with_hints(sink.visible.hints);
        self.prev = self.other_prev.clone();
        self.last_key = self.other_key;
    }

    /// A message in transcript order (dedupe + reply start time), before any sort.
    fn message(&mut self, sink: &mut Sink, role: Role, content: String, at: Option<f64>) -> Result<(), Rebuild> {
        if content.is_empty() || self.prev.is_duplicate(role, &content) {
            return Ok(());
        }
        let from_response = !self.has_events;
        let pending = match role {
            Role::Assistant => Pending {
                role,
                at: if self.prev.exists() { self.prev.at } else { at },
                completed_at: at,
                content,
                tool_call: None,
                from_response,
            },
            _ => Pending { role, at, completed_at: None, content, tool_call: None, from_response },
        };
        self.prev.set(role, &pending.content, pending.at);
        self.emit(sink, pending, false)
    }

    fn other(&mut self, sink: &mut Sink, content: String, at: Option<f64>, tool_call: Option<ToolCall>) -> Result<(), Rebuild> {
        self.prev.set(Role::Assistant, &content, at);
        self.other_prev.set(Role::Assistant, &content, at);
        self.emit(sink, Pending { role: Role::Assistant, at, completed_at: None, content, tool_call, from_response: false }, false)
    }

    fn tool_call(&mut self, sink: &mut Sink, kind: &str, payload: &Value, at: Option<f64>) -> Result<(), Rebuild> {
        let Some(name) = payload.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) else { return Ok(()) };
        let call_id = payload.get("call_id").or_else(|| payload.get("id")).and_then(Value::as_str);
        if let Some(id) = call_id.filter(|id| !id.is_empty())
            && !self.seen_calls.insert(super::digest(id))
        {
            return Ok(());
        }
        let raw = payload.get("arguments").filter(|v| !v.is_null()).or_else(|| payload.get("input"));
        let mut input_text = match raw {
            Some(Value::String(s)) => Some(s.clone()),
            Some(v) => Some(pretty_json(v)),
            None => None,
        };
        if let (true, Some(Value::String(s))) = (kind == "function_call", raw)
            && let Ok(parsed) = serde_json::from_str::<Value>(s)
        {
            input_text = Some(pretty_json(&parsed));
        }
        self.other(sink, String::new(), at, Some(ToolCall { name: name.to_string(), input: input_text }))
    }

    fn lifecycle(&mut self, sink: &mut Sink, kind: &str, payload: &Value, entry_at: Option<f64>) -> Result<(), Rebuild> {
        let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) else { return Ok(()) };
        if kind == "task_started" {
            let Some(started) = parse_epoch(payload.get("started_at")).or(entry_at) else { return Ok(()) };
            let order = self.next_turn_order;
            let turn = self.turns.entry(turn_id.to_string()).or_insert_with(|| Turn {
                order,
                status: TurnStatus::Running,
                started_at: started,
                completed_at: None,
                reason: None,
            });
            turn.started_at = started;
            if turn.order == order {
                self.next_turn_order += 1;
            }
            return Ok(());
        }
        let Some(completed) = parse_epoch(payload.get("completed_at")).or(entry_at) else { return Ok(()) };
        let started = parse_epoch(payload.get("started_at")).or_else(|| self.turns.get(turn_id).map(|t| t.started_at)).unwrap_or(completed);
        let reason = payload.get("reason").and_then(Value::as_str).map(str::to_string);
        let status = if kind == "task_complete" { TurnStatus::Completed } else { TurnStatus::Aborted };
        let was_terminal = self.turns.get(turn_id).is_some_and(|t| t.completed_at.is_some());
        let order = self.next_turn_order;
        let turn = self.turns.entry(turn_id.to_string()).or_insert_with(|| Turn {
            order,
            status,
            started_at: started,
            completed_at: None,
            reason: None,
        });
        if turn.order == order {
            self.next_turn_order += 1;
        }
        turn.status = status;
        turn.started_at = started;
        turn.completed_at = Some(completed);
        turn.reason = reason.clone();
        if self.buffering {
            return Ok(()); // notices are derived from the final turn states in end_full
        }
        if was_terminal {
            // A second terminal row rewrites a notice that may already be shown.
            return Err(Rebuild::Reordered);
        }
        if status == TurnStatus::Aborted {
            let notice = Pending {
                role: Role::System,
                at: Some(completed),
                completed_at: None,
                content: interruption_message(reason.as_deref()),
                tool_call: None,
                from_response: false,
            };
            return self.emit(sink, notice, true);
        }
        Ok(())
    }
}

impl Fold for CodexFold {
    fn begin_full(&mut self, _hints: Hints) {
        self.buffering = true;
    }

    fn line(&mut self, text: &str, sink: &mut Sink) -> Result<Line, Rebuild> {
        let (outer, inner) = line_types(text);
        if outer == Some("compacted") {
            // Tagged at the top level; its payload (the replacement history) is never needed.
            self.compactions += 1;
            return Ok(Line::Used);
        }
        let is_metadata = matches!(outer, Some("session_meta" | "turn_context"));
        let is_event = outer == Some("event_msg") && inner.is_some_and(|i| RETAINED_EVENTS.contains(&i));
        let is_response_message = !self.events_seen && outer == Some("response_item") && inner == Some("message");
        let is_tool_call = outer == Some("response_item") && matches!(inner, Some("function_call" | "custom_tool_call"));
        // Typed Buddy UI receipts; other tool output rows are never expanded.
        let is_receipt = outer == Some("response_item")
            && matches!(inner, Some("function_call_output" | "custom_tool_call_output"))
            && (text.contains("buddyBuilderEvent") || text.contains("homeWorkspace") || text.contains("buddyWorkerThread"));
        let is_token_count = outer == Some("event_msg") && inner == Some("token_count");
        if !(is_metadata || is_event || is_response_message || is_tool_call || is_receipt || is_token_count) {
            return Ok(Line::Skipped);
        }
        let Ok(entry) = serde_json::from_str::<Value>(text) else { return Ok(Line::Malformed) };
        let entry_type = entry.get("type").and_then(Value::as_str);
        let payload = entry.get("payload").cloned().unwrap_or(Value::Null);
        let payload_type = payload.get("type").and_then(Value::as_str);
        if is_token_count {
            if let (Some("event_msg"), Some("token_count")) = (entry_type, payload_type) {
                self.token_count(sink, &payload, parse_time(entry.get("timestamp")));
            }
            return Ok(Line::Used);
        }
        let at = parse_time(entry.get("timestamp"));
        if let Some(at) = at {
            widen(&mut self.span, at);
        }
        match entry_type {
            Some("session_meta") => {
                if self.session_id.is_none() {
                    self.session_id = payload.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                }
                if self.cwd.is_none() {
                    self.cwd = payload.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
                }
                if self.parent.is_none() {
                    self.parent = payload
                        .pointer("/source/subagent/thread_spawn/parent_thread_id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                }
            }
            Some("turn_context") => {
                if self.cwd.is_none() {
                    self.cwd = payload.get("cwd").and_then(Value::as_str).map(str::to_string);
                }
                if let Some(model) = payload.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                    self.model = Some(model.to_string());
                }
            }
            _ => {}
        }
        let event_message = entry_type == Some("event_msg") && matches!(payload_type, Some("user_message" | "agent_message"));
        let retained = event_message
            || is_event
            || is_tool_call
            || is_receipt
            || (is_response_message
                && entry_type == Some("response_item")
                && payload_type == Some("message")
                && matches!(payload.get("role").and_then(Value::as_str), Some("user" | "assistant")));
        if !retained {
            return Ok(Line::Used);
        }
        self.retained += 1;
        if event_message {
            self.events_seen = true;
            if !self.has_events {
                self.enter_event_mode(sink);
            }
        }
        match (entry_type, payload_type) {
            (Some("response_item"), Some(kind @ ("function_call" | "custom_tool_call"))) => self.tool_call(sink, kind, &payload, at)?,
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                if has_buddy_receipt(payload.get("output")) {
                    self.other(sink, String::new(), at, Some(ToolCall { name: "__raw_result__".to_string(), input: payload.get("output").map(Value::to_string) }))?;
                }
            }
            (Some("event_msg"), Some(kind @ ("user_message" | "agent_message"))) => {
                let role = if kind == "user_message" { Role::User } else { Role::Assistant };
                let content = payload.get("message").and_then(Value::as_str).unwrap_or("").to_string();
                self.message(sink, role, content, at)?;
            }
            (Some("event_msg"), Some(kind @ ("task_started" | "task_complete" | "turn_aborted"))) => {
                self.lifecycle(sink, kind, &payload, at)?;
            }
            (Some("response_item"), Some("message")) if !self.has_events => {
                let role = if payload.get("role").and_then(Value::as_str) == Some("user") { Role::User } else { Role::Assistant };
                let content = match role {
                    Role::User => user_content(&payload, !self.prev.exists()),
                    _ => content_text(payload.get("content")),
                };
                if !content.is_empty() && !self.prev.is_duplicate(role, &content) {
                    self.response_messages_shown = true;
                }
                self.message(sink, role, content, at)?;
            }
            _ => {}
        }
        Ok(Line::Used)
    }

    fn end_full(&mut self, sink: &mut Sink) -> Result<(), Rebuild> {
        self.buffering = false;
        let mut items: Vec<(Pending, bool)> = std::mem::take(&mut self.buffer).into_iter().map(|p| (p, false)).collect();
        let mut turns: Vec<&Turn> = self.turns.values().collect();
        turns.sort_by_key(|t| t.order);
        for turn in turns.into_iter().filter(|t| t.status == TurnStatus::Aborted) {
            let content = interruption_message(turn.reason.as_deref());
            let notice =
                Pending { role: Role::System, at: turn.completed_at, completed_at: None, content, tool_call: None, from_response: false };
            items.push((notice, true));
        }
        // Stable sort by time only, as JS `Array.prototype.sort` did on the appended list.
        items.sort_by(|a, b| a.0.at.unwrap_or(f64::INFINITY).total_cmp(&b.0.at.unwrap_or(f64::INFINITY)));
        for (item, notice) in items {
            let key = sort_key(item.at, notice);
            self.push(sink, item, key)?;
        }
        Ok(())
    }

    fn facts(&self, ctx: &Ctx) -> Option<Facts> {
        if self.retained == 0 {
            return None;
        }
        let stem = ctx.stem(".jsonl");
        let session_id = self.session_id.clone().or_else(|| session_id_from_name(&stem)).unwrap_or(stem);
        let cwd = match self.cwd.as_deref().filter(|c| !c.is_empty()) {
            Some(path) => Cwd::Transcript { path: normalize_dir(path) },
            None => Cwd::Unknown,
        };
        Some(Facts {
            session_id,
            provider: Provider::Codex,
            cwd,
            model: self.model.clone(),
            title: None,
            span: self.span,
            parent_session_id: self.parent.clone(),
            usage: self.usage.clone(),
            sub_agents: Vec::new(),
            context: self.context_tokens.map(|context_tokens| ContextReading {
                context_tokens,
                context_window: self.context_window,
                // Codex records the boundary but no token counts alongside it.
                compaction: (self.compactions > 0).then_some(Compaction {
                    count: self.compactions,
                    pre_tokens: None,
                    post_tokens: None,
                    trigger: None,
                }),
            }),
            rate_limits: self.rate_limits.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_types_reads_the_first_two_type_tags() {
        let line = r#"{"timestamp":"t","type":"response_item","payload":{"type":"function_call","name":"x"}}"#;
        assert_eq!(line_types(line), (Some("response_item"), Some("function_call")));
        let spaced = r#"{"type" : "event_msg", "payload": {"type": "user_message"}}"#;
        assert_eq!(line_types(spaced), (Some("event_msg"), Some("user_message")));
    }

    #[test]
    fn abort_reasons_become_the_ts_notice_text() {
        assert_eq!(interruption_message(Some("interrupted")), "Turn interrupted.");
        assert_eq!(interruption_message(Some("server restart")), "Turn interrupted by server restart.");
        assert_eq!(interruption_message(Some("model error")), "Turn failed: model error");
        assert_eq!(interruption_message(None), "Turn aborted.");
    }
}
