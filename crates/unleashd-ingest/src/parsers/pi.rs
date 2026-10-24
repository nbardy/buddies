//! Pattern: wake-on-write (docs/patterns.md#wake-on-write)
//! Pi appends a session tree. Ordinary appends fold only new bytes; a new
//! branch rebuilds the active path once (Pi branch-history guard).
use super::{Ctx, Facts, Fold, Line, Sink, finite, normalize_dir, parse_time, widen};
use crate::markers::{Hints, Rebuild};
use crate::model::{Compaction, ContextReading, Cwd, Provider, Role, Usage, UsageTurn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PiFold {
    session_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    title: Option<String>,
    leaf: Option<String>,
    span: Option<(f64, f64)>,
    usage: Usage,
    context: Option<ContextReading>,
    compaction: Option<Compaction>,
    billing_model: Option<String>,
    has_messages: bool,
    #[serde(skip)]
    buffering: bool,
    #[serde(skip)]
    entries: Vec<Value>,
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

impl PiFold {
    fn apply(&mut self, entry: &Value, sink: &mut Sink) -> Result<(), Rebuild> {
        let at = parse_time(entry.get("timestamp"));
        if let Some(at) = at {
            widen(&mut self.span, at);
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("model_change") => {
                self.model = entry
                    .get("provider")
                    .and_then(Value::as_str)
                    .zip(entry.get("modelId").and_then(Value::as_str))
                    .map(|(p, m)| format!("{p}/{m}"));
            }
            Some("session_info") => self.title = entry.get("name").and_then(Value::as_str).map(str::to_string),
            Some("message") => {
                let Some(message) = entry.get("message") else { return Ok(()) };
                let at = parse_time(message.get("timestamp")).or(at);
                match message.get("role").and_then(Value::as_str) {
                    Some("user") => {
                        self.has_messages = true;
                        sink.push(Role::User, at, None, text(message.get("content")), None)?;
                    }
                    Some("assistant") => {
                        self.has_messages = true;
                        if let Some(u) = message.get("usage") {
                            self.context = Some(ContextReading {
                                context_tokens: finite(u.get("input")).unwrap_or(0.0)
                                    + finite(u.get("cacheRead")).unwrap_or(0.0)
                                    + finite(u.get("cacheWrite")).unwrap_or(0.0),
                                context_window: None,
                                compaction: self.compaction.clone(),
                            });
                        }
                        self.model = message
                            .get("provider")
                            .and_then(Value::as_str)
                            .zip(message.get("model").and_then(Value::as_str))
                            .map(|(p, m)| format!("{p}/{m}"))
                            .or(self.model.take());
                        let parts: Vec<Value> = message
                            .get("content")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                                Some("text") => Some(serde_json::json!({"t":"text", "text": b.get("text")})),
                                Some("toolCall") => {
                                    Some(serde_json::json!({"t":"tool", "name": b.get("name"), "input": b.get("arguments")}))
                                }
                                _ => None,
                            })
                            .collect();
                        if !parts.is_empty() {
                            sink.push_parts(Role::Assistant, at, at, text(message.get("content")), parts);
                        }
                    }
                    Some("toolResult") => {
                        for nested in message.pointer("/nestedCalls/calls").and_then(Value::as_array).into_iter().flatten() {
                            sink.push_parts(
                                Role::Assistant,
                                at,
                                at,
                                String::new(),
                                vec![serde_json::json!({"t":"tool", "name":nested.get("name"), "input":nested.get("arguments")})],
                            );
                        }
                        sink.push_parts(
                            Role::Assistant,
                            at,
                            at,
                            String::new(),
                            vec![serde_json::json!({"t":"raw_result", "output": message.get("content")})],
                        );
                    }
                    _ => {}
                }
            }
            Some("compaction") => {
                self.compaction = Some(Compaction {
                    count: self.compaction.as_ref().map_or(1, |c| c.count + 1),
                    pre_tokens: finite(entry.get("tokensBefore")),
                    post_tokens: None,
                    trigger: Some("pi".into()),
                });
                self.context = None;
            }
            _ => {}
        }
        sink.visible.check()
    }

    // Billing includes abandoned branches, unlike the visible message path.
    fn account_entry(&mut self, entry: &Value, sink: &mut Sink) {
        let source = entry.get("message").unwrap_or(entry);
        let model = source
            .get("provider")
            .and_then(Value::as_str)
            .zip(source.get("model").or(source.get("modelId")).and_then(Value::as_str))
            .map(|(p, m)| format!("{p}/{m}"));
        if model.is_some() {
            self.billing_model = model;
        }
        let at = parse_time(source.get("timestamp")).or_else(|| parse_time(entry.get("timestamp")));
        let Some(u) = source.get("usage") else { return };
        let usage = Usage {
            input: finite(u.get("input")).unwrap_or(0.0),
            output: finite(u.get("output")).unwrap_or(0.0),
            cache_read: finite(u.get("cacheRead")).unwrap_or(0.0),
            cache_write: finite(u.get("cacheWrite")).unwrap_or(0.0),
        };
        self.usage.input += usage.input;
        self.usage.output += usage.output;
        self.usage.cache_read += usage.cache_read;
        self.usage.cache_write += usage.cache_write;
        sink.turn(UsageTurn { at, model: self.billing_model.clone(), usage, reported_cost: finite(u.pointer("/cost/total")) });
    }
}

impl Fold for PiFold {
    fn begin_full(&mut self, _hints: Hints) {
        self.buffering = true;
    }
    fn line(&mut self, line: &str, sink: &mut Sink) -> Result<Line, Rebuild> {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { return Ok(Line::Malformed) };
        if entry.get("type").and_then(Value::as_str) == Some("session") {
            self.session_id = entry.get("id").and_then(Value::as_str).map(str::to_string);
            self.cwd = entry.get("cwd").and_then(Value::as_str).map(normalize_dir);
            return Ok(Line::Used);
        }
        let Some(id) = entry.get("id").and_then(Value::as_str) else { return Ok(Line::Skipped) };
        if self.buffering {
            self.entries.push(entry);
            return Ok(Line::Used);
        }
        let parent = entry.get("parentId").and_then(Value::as_str);
        if parent != self.leaf.as_deref() {
            return Err(Rebuild::Reordered);
        }
        self.leaf = Some(id.to_string());
        self.account_entry(&entry, sink);
        self.apply(&entry, sink)?;
        Ok(Line::Used)
    }
    fn end_full(&mut self, sink: &mut Sink) -> Result<(), Rebuild> {
        self.buffering = false;
        let entries = std::mem::take(&mut self.entries);
        let index: HashMap<&str, &Value> = entries.iter().filter_map(|v| v.get("id").and_then(Value::as_str).map(|id| (id, v))).collect();
        self.leaf = entries.last().and_then(|v| v.get("id")).and_then(Value::as_str).map(str::to_string);
        let mut id = self.leaf.as_deref();
        let mut branch = Vec::new();
        let mut seen = HashSet::new();
        while let Some(key) = id {
            if !seen.insert(key) {
                break;
            }
            let Some(entry) = index.get(key) else { break };
            branch.push(*entry);
            id = entry.get("parentId").and_then(Value::as_str);
        }
        for entry in &entries {
            self.account_entry(entry, sink);
        }
        for entry in branch.into_iter().rev() {
            self.apply(entry, sink)?;
        }
        Ok(())
    }
    fn facts(&self, _ctx: &Ctx) -> Option<Facts> {
        if !self.has_messages {
            return None;
        }
        Some(Facts {
            session_id: self.session_id.clone()?,
            provider: Provider::Pi,
            cwd: self.cwd.clone().map(|path| Cwd::Transcript { path }).unwrap_or(Cwd::Unknown),
            model: self.model.clone(),
            title: self.title.clone(),
            span: self.span,
            parent_session_id: None,
            usage: Some(self.usage.clone()),
            sub_agents: Vec::new(),
            context: self.context.clone(),
            rate_limits: None,
        })
    }
}
