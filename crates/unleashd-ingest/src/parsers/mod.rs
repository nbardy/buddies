//! Pattern: table-driven (docs/patterns.md#table-driven) — one `Fold` impl per format, one
//! generic driver (read.rs).
//!
//! One parser per provider format, all driven the same way.
//!
//! A JSONL parser is a *fold*: serializable state plus `line()`. The driver (`read.rs`) feeds it
//! the bytes appended since the stored offset, so a growing transcript costs only its new
//! bytes, and the fold is stored with the offset, so a restart resumes instead of re-parsing.
//! When a new line proves earlier output wrong (an out-of-order timestamp, a mode switch) the
//! fold returns `Rebuild` and the driver re-reads the file from 0 with a fresh fold. Every
//! resume therefore produces exactly what a full read of the same bytes would.
//!
//! Gemini (one JSON document) and OpenCode (a directory of JSON files) have no append order;
//! they are re-read whole when their change stamp moves.

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod gemini;
pub mod muse;
pub mod pi;
pub mod opencode;

use crate::markers::{Hints, Rebuild, Visible};
use crate::model::{ContextReading, Cwd, Message, Provider, Role, SubAgent, ToolCall, Usage, UsageTurn};
use crate::paths::ProjectDirResolver;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

/// Session-level facts a parser has accumulated. `None` from `facts()` = no session (yet).
#[derive(Debug, Clone, PartialEq)]
pub struct Facts {
    pub session_id: String,
    pub provider: Provider,
    pub cwd: Cwd,
    pub model: Option<String>,
    pub title: Option<String>,
    /// Earliest and latest recorded time, when the transcript records any.
    pub span: Option<(f64, f64)>,
    pub parent_session_id: Option<String>,
    pub usage: Option<Usage>,
    pub sub_agents: Vec<SubAgent>,
    /// The latest request's context (the context meter), when the transcript records one.
    pub context: Option<ContextReading>,
    /// Codex: the last `rate_limits` payload that has a usage window, raw JSON.
    pub rate_limits: Option<String>,
}

/// What a parser may know about the file it reads, besides its bytes.
pub struct Ctx<'a> {
    pub path: &'a Path,
    pub resolver: &'a ProjectDirResolver,
    pub mtime_ms: f64,
}

impl Ctx<'_> {
    pub fn stem(&self, ext: &str) -> String {
        let name = self.path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name.strip_suffix(ext).unwrap_or(name).to_string()
    }
    pub fn parent_name(&self) -> String {
        self.path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("").to_string()
    }
}

/// A JSONL format's parser. See the module comment for the resume contract.
pub trait Fold: Default + Serialize + DeserializeOwned + Send {
    /// A read from byte 0 is starting. Parsers that sort buffer until `end_full`.
    fn begin_full(&mut self, _hints: Hints) {}
    fn line(&mut self, text: &str, sink: &mut Sink) -> Result<Line, Rebuild>;
    /// The full read reached the end of the file: flush what `begin_full` buffered.
    fn end_full(&mut self, _sink: &mut Sink) -> Result<(), Rebuild> {
        Ok(())
    }
    fn facts(&self, ctx: &Ctx) -> Option<Facts>;
}

/// Where a parser's messages go: through the marker fold, numbered, into this read's output.
#[derive(Debug, Default)]
pub struct Sink {
    pub visible: Visible,
    pub next_seq: u32,
    pub out: Vec<Message>,
    /// Usage turns, in transcript order; numbered from `first_turn`. Never withdrawn.
    pub turns: Vec<UsageTurn>,
    pub first_turn: u32,
    /// The first seq this read numbers; lower seqs are already stored.
    first_seq: u32,
    /// Stored seqs a line of this read withdrew (`withdraw`), in their stored numbering.
    pub withdrawn: Vec<u32>,
}

impl Sink {
    pub fn new(visible: Visible, next_seq: u32, first_turn: u32) -> Sink {
        Sink { visible, next_seq, out: Vec::new(), turns: Vec::new(), first_turn, first_seq: next_seq, withdrawn: Vec::new() }
    }

    pub fn turn(&mut self, turn: UsageTurn) {
        self.turns.push(turn);
    }

    /// Take back earlier messages (ascending seqs, stored or from this read) as if they had never
    /// been pushed: later messages close the gaps. Stored ones go to `withdrawn` for the store to
    /// delete and renumber. At most once per read: `withdrawn` keeps the stored numbering.
    /// Only Codex's switch to event mode withdraws (codex.rs `enter_event_mode`).
    pub fn withdraw(&mut self, seqs: &[u32]) {
        debug_assert!(self.withdrawn.is_empty(), "one withdrawal per read");
        debug_assert!(seqs.windows(2).all(|w| w[0] < w[1]));
        self.withdrawn = seqs.iter().copied().filter(|&s| s < self.first_seq).collect();
        self.out.retain(|m| seqs.binary_search(&m.seq).is_err());
        for m in &mut self.out {
            m.seq -= seqs.partition_point(|&s| s < m.seq) as u32;
        }
        self.next_seq -= seqs.len() as u32;
    }

    pub fn push(
        &mut self,
        role: Role,
        at: Option<f64>,
        completed_at: Option<f64>,
        content: String,
        tool_call: Option<ToolCall>,
    ) -> Result<(), Rebuild> {
        let content = match role {
            Role::User => self.visible.user_message(&content)?,
            Role::Assistant | Role::System => content,
        };
        let parts_json = tool_call.as_ref().map(|call| {
            let input = call.input.as_ref().map(|text| serde_json::from_str::<Value>(text).unwrap_or(Value::String(text.clone())));
            if call.name == "__raw_result__" {
                serde_json::json!([{ "t": "raw_result", "output": input }]).to_string()
            } else {
                serde_json::json!([{ "t": "tool", "name": call.name, "input": input }]).to_string()
            }
        });
        self.out.push(Message { seq: self.next_seq, role, at, completed_at, content: if parts_json.is_some() { String::new() } else { content }, tool_call: None, parts_json });
        self.next_seq += 1;
        Ok(())
    }

    pub fn push_parts(&mut self, role: Role, at: Option<f64>, completed_at: Option<f64>, content: String, parts: Vec<Value>) {
        self.out.push(Message { seq: self.next_seq, role, at, completed_at, content, tool_call: None, parts_json: Some(Value::Array(parts).to_string()) });
        self.next_seq += 1;
    }
}

/// A whole-document read (Gemini, OpenCode): final message order, before the marker fold.
#[derive(Debug, Clone, PartialEq)]
pub struct DocMessage {
    pub role: Role,
    pub at: Option<f64>,
    pub completed_at: Option<f64>,
    pub content: String,
    pub parts_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Doc {
    pub facts: Facts,
    pub messages: Vec<DocMessage>,
    pub turns: Vec<UsageTurn>,
}

/// `typeof v === 'number' && Number.isFinite(v)` (the context meter's `num`).
pub fn finite(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|f| f.is_finite())
}

/// What a line did. `Malformed` lines are skipped and counted, as the TS parsers warned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Line {
    Used,
    Skipped,
    Malformed,
}

/// A 64-bit FNV-1a digest. Checkpoints hold digests of the previous message and of every seen
/// call/request id instead of the text: a checkpoint is rewritten on every append to its file,
/// and holding the text made the largest ones 0.5–1 MB (a 287 KB last message, 490 KB of Codex
/// call ids). A collision would drop one message; at 64 bits that is ~1e-11 for 20k ids.
pub fn digest(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash ^ (text.len() as u64).rotate_left(32)
}

/// Serde for a set of digests: one base64 string of the sorted little-endian values. A checkpoint
/// is rewritten on every append, and the 934 MB rollout's 8.4k Codex call ids as a JSON number
/// array were 176 KB of its 188 KB checkpoint: ~2.4 ms of every append (T13a). Base64 is 11 bytes
/// per id and decodes without number parsing.
pub mod digest_set {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    use serde::{Deserialize, Deserializer, Serializer};
    use std::collections::HashSet;

    pub fn serialize<S: Serializer>(set: &HashSet<u64>, s: S) -> Result<S::Ok, S::Error> {
        let mut sorted: Vec<u64> = set.iter().copied().collect();
        sorted.sort_unstable();
        let bytes: Vec<u8> = sorted.iter().flat_map(|d| d.to_le_bytes()).collect();
        s.serialize_str(&STANDARD_NO_PAD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<HashSet<u64>, D::Error> {
        let text = <std::borrow::Cow<'de, str>>::deserialize(d)?;
        let bytes = STANDARD_NO_PAD.decode(text.as_bytes()).map_err(serde::de::Error::custom)?;
        if bytes.len() % 8 != 0 {
            return Err(serde::de::Error::custom("digest set length is not a multiple of 8"));
        }
        Ok(bytes.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().expect("8 bytes"))).collect())
    }
}

/// Consecutive duplicate suppression plus the "an assistant reply starts when the message before
/// it did" rule, shared by every parser that has it. Holds the previous *raw* message.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Previous {
    pub role: Option<Role>,
    pub content: u64,
    pub at: Option<f64>,
}

impl Previous {
    pub fn is_duplicate(&self, role: Role, content: &str) -> bool {
        self.role == Some(role) && self.content == digest(content)
    }
    pub fn exists(&self) -> bool {
        self.role.is_some()
    }
    pub fn set(&mut self, role: Role, content: &str, at: Option<f64>) {
        self.role = Some(role);
        self.content = digest(content);
        self.at = at;
    }
}

/// A JS time value: `new Date(ms)` truncates fractional milliseconds (TimeClip). Muse records
/// microseconds, so `us / 1000` has a fraction; without the truncation every Muse time was off
/// by <1 ms and equal-millisecond records sorted differently (parity run, 2026-09-25).
pub fn js_time(ms: f64) -> Option<f64> {
    (ms.is_finite() && ms.abs() <= 8.64e15).then(|| ms.trunc())
}

/// `new Date(x).getTime()` for an ISO string or epoch-ms number; `None` where JS gave NaN.
pub fn parse_time(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64().and_then(js_time),
        Value::String(s) => parse_iso(s),
        _ => None,
    }
}

/// ISO-8601 as JS `Date` parses it: `YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH:MM]`. A date-only
/// string is UTC; a date-time without a zone is local time in JS, which no transcript writes.
pub fn parse_iso(s: &str) -> Option<f64> {
    let b = s.trim().as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0i64, |acc, d| acc * 10 + (d - b'0') as i64))
    };
    let year = num(0, 4)?;
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let month = num(5, 2)?;
    let day = num(8, 2)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0.0);
    let mut i;
    let mut offset_min = 0i64;
    if b.len() > 10 {
        if b[10] != b'T' && b[10] != b't' && b[10] != b' ' {
            return None;
        }
        hour = num(11, 2)?;
        if b.get(13) != Some(&b':') {
            return None;
        }
        minute = num(14, 2)?;
        i = 16;
        if b.get(16) == Some(&b':') {
            second = num(17, 2)?;
            i = 19;
            if b.get(19) == Some(&b'.') {
                let mut j = 20;
                let mut frac = String::new();
                while j < b.len() && b[j].is_ascii_digit() {
                    frac.push(b[j] as char);
                    j += 1;
                }
                if frac.is_empty() {
                    return None;
                }
                // JS keeps millisecond precision (truncating further digits).
                let ms: String = frac.chars().chain("000".chars()).take(3).collect();
                millis = ms.parse::<f64>().ok()?;
                i = j;
            }
        }
        match b.get(i) {
            None => return None, // local time: never written by a provider, not guessed
            Some(b'Z') | Some(b'z') if i + 1 == b.len() => {}
            Some(sign @ (b'+' | b'-')) => {
                let oh = num(i + 1, 2)?;
                let om = if b.get(i + 3) == Some(&b':') { num(i + 4, 2)? } else { num(i + 3, 2)? };
                offset_min = (oh * 60 + om) * if *sign == b'+' { 1 } else { -1 };
            }
            _ => return None,
        }
        if hour > 24 || minute > 59 || second > 59 {
            return None;
        }
    }
    // Days from civil (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + hour * 3600 + minute * 60 + second - offset_min * 60;
    Some(secs as f64 * 1000.0 + millis)
}

/// Widen a span with one observation.
pub fn widen(span: &mut Option<(f64, f64)>, at: f64) {
    *span = Some(match *span {
        None => (at, at),
        Some((lo, hi)) => (lo.min(at), hi.max(at)),
    });
}

/// `inferProviderFromModel` (jsonl.ts): a Claude Code transcript names its provider by model.
pub fn provider_from_model(model: Option<&str>) -> Provider {
    let lower = model.unwrap_or("unknown").to_lowercase();
    if lower.contains("gemini") {
        Provider::Gemini
    } else if ["opencode", "kimi-k2", "minimax", "trinity"].iter().any(|m| lower.contains(m)) {
        Provider::Opencode
    } else if lower.contains("codex") || lower.contains("gpt") {
        Provider::Codex
    } else {
        Provider::Claude
    }
}

/// Resolve `.`/`..` and trailing slashes (`normalizeDirPath`) of an absolute path. A relative
/// path is left as recorded: resolving it against this process's cwd would invent a location.
pub fn normalize_dir(path: &str) -> String {
    if !path.starts_with('/') {
        return path.to_string();
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_times_match_js_date() {
        // Values checked against `new Date(s).getTime()` in Node 24.
        assert_eq!(parse_iso("2026-09-25T10:11:12.345Z"), Some(1790331072345.0));
        assert_eq!(parse_iso("2026-09-25T10:11:12Z"), Some(1790331072000.0));
        assert_eq!(parse_iso("2026-09-25T18:11:12.345+08:00"), Some(1790331072345.0));
        assert_eq!(parse_iso("2026-09-25T10:11:12.345678Z"), Some(1790331072345.0));
        assert_eq!(parse_iso("2026-09-25"), Some(1790294400000.0));
        assert_eq!(parse_iso("not a date"), None);
    }
}
