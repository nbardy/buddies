//! Claude Code: `~/.claude/projects/<encoded cwd>/<session id>.jsonl`, one record per line,
//! appended only. Port of `foldClaudeTranscript` + usage-routes.ts `parseClaudeSession` (usage
//! turns) + session-context.ts `parseClaudeLines` (the context meter).

use super::{Ctx, Facts, Fold, Line, Previous, Sink, finite, normalize_dir, parse_time, provider_from_model, widen};
use crate::markers::Rebuild;
use crate::model::{Compaction, ContextReading, Cwd, Role, Usage, UsageTurn};
use crate::subagents::SubAgentFold;
use crate::text::js_trim;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Deserialize)]
struct Entry {
    #[serde(rename = "type")]
    kind: Option<String>,
    cwd: Option<Value>,
    timestamp: Option<Value>,
    message: Option<Value>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<Value>,
    #[serde(rename = "customTitle")]
    custom_title: Option<Value>,
    subtype: Option<Value>,
    #[serde(rename = "compactMetadata")]
    compact_metadata: Option<Value>,
    #[serde(rename = "isSidechain")]
    is_sidechain: Option<Value>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ClaudeFold {
    entries: u64,
    cwd: Option<String>,
    model: Option<String>,
    span: Option<(f64, f64)>,
    ai_title: Option<String>,
    custom_title: Option<String>,
    prev: Previous,
    /// Claude Code stamps the same request usage on every content-block line of a reply;
    /// counting each line overcounted ~2.4x (usage-routes.ts, 2026-09-25). One count per id.
    #[serde(with = "super::digest_set")]
    usage_ids: HashSet<u64>,
    usage: Usage,
    sub_agents: SubAgentFold,
    /// The last main-thread request's context; sub-agent (sidechain) rows measure the
    /// sub-agent's own window, so they are skipped here (but billed in `usage`).
    context_tokens: Option<f64>,
    compaction: Option<Compaction>,
}

fn number(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

fn truthy_string(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

impl ClaudeFold {
    fn observe_usage(&mut self, message: &Value, at: Option<f64>, sink: &mut Sink) {
        let Some(usage) = message.get("usage").filter(|u| crate::text::truthy(Some(u))) else { return };
        // `countedMessages.has(entry.message.id)`: a missing id is the key "undefined".
        let id = match message.get("id") {
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => "undefined".to_string(),
        };
        if !self.usage_ids.insert(super::digest(&id)) {
            return;
        }
        let turn = Usage {
            input: number(usage.get("input_tokens")),
            output: number(usage.get("output_tokens")),
            cache_read: number(usage.get("cache_read_input_tokens")),
            cache_write: number(usage.get("cache_creation_input_tokens")),
        };
        self.usage.input += turn.input;
        self.usage.output += turn.output;
        self.usage.cache_read += turn.cache_read;
        self.usage.cache_write += turn.cache_write;
        // `cache_creation` splits the write by tier; a record without it (an older CLI) says
        // nothing about the tier, so all of it counts as the dearer 1-hour one (model.rs).
        let cache_write_1h = match usage.get("cache_creation") {
            Some(split) if split.is_object() => number(split.get("ephemeral_1h_input_tokens")),
            _ => turn.cache_write,
        };
        let model = truthy_string(message.get("model")).map(str::to_string);
        sink.turn(UsageTurn { at, model, usage: turn, cache_write_1h, reported_cost: None });
    }

    /// Context is input + cache read + cache write: Claude reports cache hits in separate fields.
    fn observe_context(&mut self, message: &Value) {
        let Some(usage) = message.get("usage").filter(|u| crate::text::truthy(Some(u))) else { return };
        let parts = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].map(|k| finite(usage.get(k)));
        if parts.iter().any(Option::is_some) {
            self.context_tokens = Some(parts.iter().map(|p| p.unwrap_or(0.0)).sum());
        }
    }

    fn compact_boundary(&mut self, metadata: Option<&Value>) {
        let count = self.compaction.as_ref().map_or(0, |c| c.count) + 1;
        self.compaction = Some(Compaction {
            count,
            pre_tokens: finite(metadata.and_then(|m| m.get("preTokens"))),
            post_tokens: finite(metadata.and_then(|m| m.get("postTokens"))),
            trigger: metadata.and_then(|m| m.get("trigger")).and_then(Value::as_str).map(str::to_string),
        });
    }

    fn push(&mut self, sink: &mut Sink, role: Role, content: String, at: Option<f64>, completed: Option<f64>) -> Result<(), Rebuild> {
        let duplicate = self.prev.is_duplicate(role, &content);
        self.prev.set(role, &content, at);
        if duplicate {
            return Ok(());
        }
        sink.push(role, at, completed, content, None)
    }

    fn push_parts(&mut self, sink: &mut Sink, parts: Vec<Value>, content: String, at: Option<f64>, completed: Option<f64>) {
        let identity = Value::Array(parts.clone()).to_string();
        let duplicate = self.prev.is_duplicate(Role::Assistant, &identity);
        self.prev.set(Role::Assistant, &identity, at);
        if !duplicate { sink.push_parts(Role::Assistant, at, completed, content, parts); }
    }
}

impl Fold for ClaudeFold {
    fn line(&mut self, text: &str, sink: &mut Sink) -> Result<Line, Rebuild> {
        let Ok(entry) = serde_json::from_str::<Entry>(text) else { return Ok(Line::Malformed) };
        self.entries += 1;
        let kind = entry.kind.as_deref().unwrap_or("");
        match kind {
            "ai-title" => {
                if let Some(t) = entry.ai_title.as_ref().and_then(Value::as_str).map(js_trim).filter(|t| !t.is_empty()) {
                    self.ai_title = Some(t.to_string());
                }
                return Ok(Line::Used);
            }
            "custom-title" => {
                if let Some(t) = entry.custom_title.as_ref().and_then(Value::as_str).map(js_trim).filter(|t| !t.is_empty()) {
                    self.custom_title = Some(t.to_string());
                }
                return Ok(Line::Used);
            }
            "system" => {
                if entry.subtype.as_ref().and_then(Value::as_str) == Some("compact_boundary") {
                    self.compact_boundary(entry.compact_metadata.as_ref());
                }
                return Ok(Line::Used);
            }
            "user" | "assistant" => {}
            _ => return Ok(Line::Used),
        }
        if self.cwd.is_none() {
            self.cwd = truthy_string(entry.cwd.as_ref()).map(str::to_string);
        }
        let at = parse_time(entry.timestamp.as_ref());
        if let Some(at) = at {
            widen(&mut self.span, at);
        }
        let Some(message) = entry.message else { return Ok(Line::Used) };
        if kind == "user" {
            if let Some(Value::Array(blocks)) = message.get("content") {
                for block in blocks {
                    // Claude persists MCP results as user-role transport blocks, not user prose.
                    let is_result = block.get("type").and_then(Value::as_str) == Some("tool_result");
                    let Some(content) = block.get("content").filter(|_| is_result) else { continue };
                    if crate::text::truthy(block.get("is_error")) {
                        continue;
                    }
                    if crate::text::has_buddy_receipt(Some(content)) {
                        self.push_parts(sink, vec![serde_json::json!({ "t": "raw_result", "output": content })], String::new(), at, None);
                    }
                }
            }
            // Array content only ever renders as "[Tool result: …]" lines, which are dropped; a
            // user message is string content (extractUserContent + its filter).
            if let Some(content) = message.get("content").and_then(Value::as_str)
                && !content.is_empty()
                && !content.starts_with("[Tool result:")
            {
                self.push(sink, Role::User, content.to_string(), at, None)?;
            }
            return Ok(Line::Used);
        }
        // assistant
        if self.model.as_deref().is_none_or(|m| m == "unknown")
            && let Some(model) = truthy_string(message.get("model"))
        {
            self.model = Some(model.to_string());
        }
        self.observe_usage(&message, at, sink);
        if entry.is_sidechain.as_ref().and_then(Value::as_bool) != Some(true) {
            self.observe_context(&message);
        }
        let provider = provider_from_model(self.model.as_deref());
        let mut parts: Vec<Value> = Vec::new();
        let mut prose = Vec::new();
        let mut has_tool = false;
        if let Some(Value::Array(blocks)) = message.get("content") {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        prose.push(text.to_string());
                        parts.push(serde_json::json!({ "t": "text", "text": text }));
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("undefined");
                        has_tool = true;
                        parts.push(serde_json::json!({ "t": "tool", "name": name, "input": block.get("input") }));
                        let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        self.sub_agents.tool_use(provider, id, name, &input, at);
                    }
                    _ => {} // thinking blocks are internal reasoning
                }
            }
        }
        let content = prose.join("\n");
        if !parts.is_empty() {
            let started = if self.prev.exists() { self.prev.at } else { at };
            if has_tool { self.push_parts(sink, parts, content, started, at); }
            else { self.push(sink, Role::Assistant, content, started, at)?; }
        }
        Ok(Line::Used)
    }

    fn facts(&self, ctx: &Ctx) -> Option<Facts> {
        if self.entries == 0 {
            return None;
        }
        let cwd = match &self.cwd {
            Some(path) => Cwd::Transcript { path: normalize_dir(path) },
            None => ctx.resolver.claude_cwd(&ctx.parent_name()),
        };
        Some(Facts {
            session_id: ctx.stem(".jsonl"),
            provider: provider_from_model(self.model.as_deref()),
            cwd,
            model: self.model.clone(),
            title: self.custom_title.clone().or_else(|| self.ai_title.clone()),
            span: self.span,
            parent_session_id: None,
            usage: Some(self.usage.clone()),
            sub_agents: self.sub_agents.finished(),
            context: self.context_tokens.map(|context_tokens| ContextReading {
                context_tokens,
                context_window: None,
                compaction: self.compaction.clone(),
            }),
            rate_limits: None,
        })
    }
}
