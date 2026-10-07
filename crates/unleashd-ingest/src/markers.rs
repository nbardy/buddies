//! In-band markers the host writes into the first prompt, and what they say about the session.
//!
//! Every transcript is read by one `Visible` fold: each user message passes through it in
//! history order, markers are removed from the displayed text, and what they say is kept as the
//! session's `Identity`. The order and precedence are those of `sessionToConversation`
//! (disk-adapter.ts) plus the merge-review prefix, which that file stopped stripping when merge
//! was deleted (8c9fcfa) although old transcripts still carry it.

use crate::model::{Identity, WorkerRole};
use crate::text::{js_trim_start, utf16_len};
use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

static SWARM_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<!-- unleashd:swarm-prefix -->\n((?s:.)*?)\n<!-- /unleashd:swarm-prefix -->\n\n").unwrap());
static BUDDY_V1: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<!-- unleashd:buddy-context (.+) -->\n(?s:.)*?\n<!-- /unleashd:buddy-context -->\n\n").unwrap());
static BUDDY_V2_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<!-- unleashd:buddy-context-v2 ([A-Za-z0-9_-]+) ([0-9]+) -->\n").unwrap());
const BUDDY_V2_SUFFIX: &str = "\n<!-- /unleashd:buddy-context-v2 -->\n\n";
static BUILDER_V1_HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^<!-- unleashd:buddy-builder-v1 ([0-9]+) -->\n").unwrap());
const BUILDER_V1_SUFFIX: &str = "\n<!-- /unleashd:buddy-builder-v1 -->\n\n";
// Fix-guard: 3c1d8d6..task_01a10d29 wrote the working directory AFTER the closing marker
// (`-->\nWorking directory: …\n\n`), so the strict suffix failed and every Builder chat showed the
// recovery placeholder and doubled replies. Those transcripts stay on disk; this reads them.
// Guard: builder_envelope_strips_in_every_shape_the_server_has_written.
static BUILDER_V1_SUFFIX_3C1D8D6: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\n<!-- /unleashd:buddy-builder-v1 -->\nWorking directory: [^\n]*\n\n").unwrap());
static MERGE_V0: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<!-- unleashd:merge-prefix -->\n(?s:.)*?\n<!-- /unleashd:merge-prefix -->\n\n").unwrap());
const MERGE_V0_SUFFIX: &str = "\n<!-- /unleashd:merge-prefix -->\n\n";
static MERGE_V1_HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^<!-- unleashd:merge-prefix-v1 ([0-9]+) -->\n").unwrap());
const MERGE_V1_SUFFIX: &str = "\n<!-- /unleashd:merge-prefix-v1 -->\n\n";
static HIDE_TEST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^\s*(?:"|')?\s*\[_HIDE_TEST_\]\s*"#).unwrap());
static AI_WRITING_TOOL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^\s*(?:"|')?\s*\[ai-writing-tool\]\s*"#).unwrap());
static OOMPA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^\s*(?:"|')?\s*\[oompa(?::([^:\]]+)(?::([^\]]+))?)?\]"#).unwrap());

/// Byte index `units` UTF-16 code units after byte `from`, if the string is that long and the
/// point is a char boundary. Envelope lengths were written as JS `.length`.
fn advance_utf16(s: &str, from: usize, units: usize) -> Option<usize> {
    let mut used = 0usize;
    for (offset, ch) in s[from..].char_indices() {
        if used == units {
            return Some(from + offset);
        }
        used += ch.len_utf16();
        if used > units {
            return None;
        }
    }
    (used == units).then_some(s.len())
}

/// Buddy context: stored as JSON, checked for the two ids every consumer keys on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuddyContext {
    pub buddy_id: String,
    pub json: String,
}

fn optional_str_field_ok(record: &serde_json::Map<String, Value>, key: &str) -> bool {
    match record.get(key) {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => !s.is_empty(),
        _ => false,
    }
}

/// `BuddyContextSchema.safeParse`: two required ids plus the typed optional fields.
pub fn buddy_context_from_value(value: &Value) -> Option<BuddyContext> {
    let Value::Object(record) = value else { return None };
    let buddy_id = record.get("buddyId").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    record.get("workspaceId").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let optional =
        ["coordinationRunId", "buddyProjectId", "legacyWorkItemId", "automationRunId", "delegatedByBuddyId", "parentBuddyConversationId"];
    if !optional.iter().all(|k| optional_str_field_ok(record, k)) {
        return None;
    }
    match record.get("allowedBuddyOperations") {
        None => {}
        Some(Value::Array(ops)) if !ops.is_empty() && ops.iter().all(|o| o.as_str().is_some_and(|s| !s.is_empty())) => {}
        Some(_) => return None,
    }
    Some(BuddyContext { buddy_id: buddy_id.to_string(), json: value.to_string() })
}

/// One user message's Buddy envelope: v2 (length-prefixed, base64url JSON) or v1 (inline JSON).
/// Returns the visible text and the context, if the envelope held a valid one.
fn strip_buddy_context(content: &str) -> (String, Option<BuddyContext>) {
    if let Some(header) = BUDDY_V2_HEADER.captures(content) {
        let header_end = header.get(0).unwrap().end();
        let suffix_start = header[2].parse::<usize>().ok().and_then(|len| advance_utf16(content, header_end, len));
        let Some(suffix_start) = suffix_start.filter(|&at| content[at..].starts_with(BUDDY_V2_SUFFIX)) else {
            return ("[Buddy context recovery failed; hidden briefing removed]".to_string(), None);
        };
        let visible = content[suffix_start + BUDDY_V2_SUFFIX.len()..].to_string();
        let payload = base64::engine::GeneralPurpose::new(
            &base64::alphabet::URL_SAFE,
            base64::engine::GeneralPurposeConfig::new()
                .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
                .with_decode_allow_trailing_bits(true),
        )
        .decode(&header[1])
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        return (visible, payload.as_ref().and_then(buddy_context_from_value));
    }
    if let Some(m) = BUDDY_V1.captures(content) {
        let context = serde_json::from_str::<Value>(&m[1]).ok().as_ref().and_then(buddy_context_from_value);
        // v1 is only removed when its JSON is a valid context (as in the TS extractor).
        if let Some(context) = context {
            return (content[m.get(0).unwrap().end()..].to_string(), Some(context));
        }
    }
    (content.to_string(), None)
}

fn strip_builder(content: &str) -> (String, bool) {
    let Some(header) = BUILDER_V1_HEADER.captures(content) else { return (content.to_string(), false) };
    let header_end = header.get(0).unwrap().end();
    let suffix_start = header[1].parse::<usize>().ok().and_then(|len| advance_utf16(content, header_end, len));
    let suffix_end = suffix_start.and_then(|at| {
        let rest = &content[at..];
        match rest.starts_with(BUILDER_V1_SUFFIX) {
            true => Some(at + BUILDER_V1_SUFFIX.len()),
            false => BUILDER_V1_SUFFIX_3C1D8D6.find(rest).map(|m| at + m.end()),
        }
    });
    match suffix_end {
        Some(end) => (content[end..].to_string(), true),
        None => ("[Buddy Builder context recovery failed; hidden briefing removed]".to_string(), false),
    }
}

fn strip_swarm_prefix(content: &str) -> (String, Option<String>) {
    match SWARM_PREFIX.captures(content) {
        Some(m) => (content[m.get(0).unwrap().end()..].to_string(), Some(m[1].to_string())),
        None => (content.to_string(), None),
    }
}

/// Merge reviews injected into a parent's first prompt (the feature is gone; the text is not).
/// Old unversioned envelopes are removed only when the closing marker is unambiguous.
pub fn strip_merge_prefix(content: &str) -> String {
    if let Some(header) = MERGE_V1_HEADER.captures(content) {
        let header_end = header.get(0).unwrap().end();
        let at = header[1].parse::<usize>().ok().and_then(|len| advance_utf16(content, header_end, len));
        return match at.filter(|&at| content[at..].starts_with(MERGE_V1_SUFFIX)) {
            Some(at) => content[at + MERGE_V1_SUFFIX.len()..].to_string(),
            None => content.to_string(),
        };
    }
    if let Some(m) = MERGE_V0.find(content)
        && content.rfind(MERGE_V0_SUFFIX) == Some(m.end() - MERGE_V0_SUFFIX.len())
    {
        return content[m.end()..].to_string();
    }
    content.to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkerTag {
    Hidden,
    Worker { swarm_id: Option<String>, worker_id: Option<String>, role: WorkerRole },
}

fn infer_worker_role(content: &str) -> WorkerRole {
    if content.starts_with("The reviewer found issues") {
        WorkerRole::Fix
    } else if content.contains("VERDICT: APPROVED") || content.contains("VERDICT: NEEDS_CHANGES") {
        WorkerRole::Review
    } else {
        WorkerRole::Work
    }
}

fn strip_worker_tag(content: &str) -> (String, Option<WorkerTag>) {
    for hidden in [&*HIDE_TEST, &*AI_WRITING_TOOL] {
        if let Some(m) = hidden.find(content) {
            return (content[m.end()..].to_string(), Some(WorkerTag::Hidden));
        }
    }
    let Some(m) = OOMPA.captures(content) else { return (content.to_string(), None) };
    let visible = js_trim_start(&content[m.get(0).unwrap().end()..]).to_string();
    let tag = WorkerTag::Worker {
        swarm_id: m.get(1).map(|g| g.as_str().to_string()),
        worker_id: m.get(2).map(|g| g.as_str().to_string()),
        role: infer_worker_role(&visible),
    };
    (visible, Some(tag))
}

/// What a Muse transcript records durably about the session (`record.creation`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Durable {
    pub kind: Option<DurableKind>,
    pub buddy: Option<BuddyContext>,
    pub swarm_prefix: Option<String>,
    pub resumed_from: Option<String>,
    pub builder_purpose: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DurableKind {
    General,
    Buddy(BuddyContext),
    Builder,
}

/// Reads a stored conversation kind; None when the value is not one.
pub fn durable_kind_from_value(value: &Value) -> Option<DurableKind> {
    match value.get("kind").and_then(Value::as_str)? {
        "general" => Some(DurableKind::General),
        "buddy_builder" => Some(DurableKind::Builder),
        "buddy" => buddy_context_from_value(value).map(DurableKind::Buddy),
        _ => None,
    }
}

/// Enough of the first prompt for a 60-unit label after whitespace is collapsed.
const LABEL_SOURCE_UNITS: usize = 2048;

/// Knowledge a later read can supply that changes how the first prompt should have been read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hints {
    /// A Buddy/Builder identity appears only after the first prompt; its worker tags stay.
    pub owned_later: bool,
}

/// Raised when a line proves an earlier emitted message wrong; the source is re-read from 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rebuild {
    /// A later line changes earlier output in a way an append cannot express.
    Reordered,
    /// A Buddy identity was found after the first prompt's worker tag was removed.
    OwnedLater,
}

/// The visible-history fold over user messages. See the module comment.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Visible {
    pub hints: Hints,
    first_user_done: bool,
    extracted_buddy: Option<BuddyContext>,
    extracted_builder: bool,
    extracted_swarm_prefix: Option<String>,
    worker: Option<WorkerTag>,
    /// The first user message's visible text, for the label.
    pub first_user_text: Option<String>,
    pub durable: Durable,
}

impl Visible {
    pub fn with_hints(hints: Hints) -> Self {
        Visible { hints, ..Default::default() }
    }

    fn owned(&self) -> bool {
        match &self.durable.kind {
            Some(DurableKind::Buddy(_)) | Some(DurableKind::Builder) => true,
            Some(DurableKind::General) => false,
            None => {
                self.durable.buddy.is_some() || self.extracted_buddy.is_some() || self.durable.builder_purpose || self.extracted_builder
            }
        }
    }

    /// Transform one user message in history order. Errors when this message (or the durable
    /// record read with it) shows the first prompt was read without knowledge it needed.
    pub fn user_message(&mut self, content: &str) -> Result<String, Rebuild> {
        let (mut text, context) = strip_buddy_context(content);
        if self.extracted_buddy.is_none() {
            self.extracted_buddy = context;
        }
        if !self.first_user_done {
            self.first_user_done = true;
            let (after_builder, builder) = strip_builder(&text);
            self.extracted_builder = builder;
            let (after_swarm, prefix) = strip_swarm_prefix(&after_builder);
            self.extracted_swarm_prefix = prefix;
            text = strip_merge_prefix(&after_swarm);
            if !(self.owned() || self.hints.owned_later) {
                let (after_tag, tag) = strip_worker_tag(&text);
                self.worker = tag;
                text = after_tag;
            }
            // Only the label reads it, and the checkpoint holding it is rewritten on every append:
            // keep a prefix, not a first prompt that can be a megabyte.
            self.first_user_text = Some(crate::text::utf16_prefix(&text, LABEL_SOURCE_UNITS).to_string());
        }
        self.check()?;
        Ok(text)
    }

    /// Durable facts may arrive on any line; they can invalidate a worker tag already removed.
    pub fn check(&self) -> Result<(), Rebuild> {
        if self.worker.is_some() && self.owned() {
            return Err(Rebuild::OwnedLater);
        }
        Ok(())
    }

    pub fn hidden(&self) -> bool {
        matches!(self.worker, Some(WorkerTag::Hidden))
    }

    pub fn identity(&self) -> Identity {
        let buddy = |b: &BuddyContext| Identity::Buddy { buddy_id: b.buddy_id.clone(), context: b.json.clone() };
        let worker_or_general = || match &self.worker {
            Some(WorkerTag::Worker { swarm_id, worker_id, role }) => {
                Identity::Worker { swarm_id: swarm_id.clone(), worker_id: worker_id.clone(), role: *role }
            }
            _ => Identity::General,
        };
        match &self.durable.kind {
            Some(DurableKind::Buddy(b)) => buddy(b),
            Some(DurableKind::Builder) => Identity::Builder,
            Some(DurableKind::General) => worker_or_general(),
            None => match self.durable.buddy.as_ref().or(self.extracted_buddy.as_ref()) {
                Some(b) => buddy(b),
                None if self.durable.builder_purpose || self.extracted_builder => Identity::Builder,
                None => worker_or_general(),
            },
        }
    }

    pub fn swarm_debug_prefix(&self) -> Option<String> {
        let prefix = self.durable.swarm_prefix.clone().or_else(|| self.extracted_swarm_prefix.clone());
        match (&self.durable.kind, self.owned()) {
            (Some(_), _) => prefix,
            (None, true) => None,
            (None, false) => prefix,
        }
    }

    /// `title`, else the first prompt's visible text on one line, at most 60 UTF-16 units.
    pub fn label(&self, title: Option<&str>) -> String {
        let source = title.or(self.first_user_text.as_deref()).unwrap_or("");
        let line = source.split_whitespace().collect::<Vec<_>>().join(" ");
        if utf16_len(&line) <= 60 { line } else { format!("{}…", crate::text::utf16_prefix(&line, 59)) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v2(json: &str, briefing: &str, visible: &str) -> String {
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
        format!("<!-- unleashd:buddy-context-v2 {b64} {} -->\n{briefing}{BUDDY_V2_SUFFIX}{visible}", utf16_len(briefing))
    }

    #[test]
    fn buddy_v2_envelope_is_removed_and_its_length_counts_utf16() {
        // The briefing holds an emoji: 2 UTF-16 units, 4 bytes. A byte count would miss the suffix.
        let msg = v2(r#"{"buddyId":"b1","workspaceId":"w"}"#, "brief 😀 ing", "hello");
        let mut v = Visible::default();
        assert_eq!(v.user_message(&msg).unwrap(), "hello");
        assert!(matches!(v.identity(), Identity::Buddy { buddy_id, .. } if buddy_id == "b1"));
    }

    #[test]
    fn a_broken_v2_envelope_still_hides_the_briefing() {
        let msg = "<!-- unleashd:buddy-context-v2 e30 999 -->\nsecret";
        assert_eq!(Visible::default().user_message(msg).unwrap(), "[Buddy context recovery failed; hidden briefing removed]");
    }

    #[test]
    fn oompa_tag_marks_a_worker_and_leaves_clean_text() {
        let mut v = Visible::default();
        assert_eq!(v.user_message("[oompa:sw1:w2] The reviewer found issues: x").unwrap(), "The reviewer found issues: x");
        assert_eq!(v.identity(), Identity::Worker { swarm_id: Some("sw1".into()), worker_id: Some("w2".into()), role: WorkerRole::Fix });
    }

    #[test]
    fn a_buddy_found_after_a_worker_tag_forces_a_reread_that_keeps_the_tag() {
        // sessionToConversation skips worker extraction for Buddy threads, so the tag stays text.
        let mut v = Visible::default();
        v.user_message("[oompa] go").unwrap();
        let later = v2(r#"{"buddyId":"b","workspaceId":"w"}"#, "x", "next");
        assert_eq!(v.user_message(&later), Err(Rebuild::OwnedLater));
        let mut again = Visible::with_hints(Hints { owned_later: true });
        assert_eq!(again.user_message("[oompa] go").unwrap(), "[oompa] go");
        assert_eq!(again.user_message(&later).unwrap(), "next");
        assert!(matches!(again.identity(), Identity::Buddy { .. }));
    }

    #[test]
    fn merge_review_prefix_is_still_stripped() {
        let review = "review doc";
        let msg = format!("<!-- unleashd:merge-prefix-v1 {} -->\n{review}{MERGE_V1_SUFFIX}my prompt", utf16_len(review));
        assert_eq!(strip_merge_prefix(&msg), "my prompt");
        // An unversioned envelope whose closing marker also appears later is ambiguous: kept.
        let ambiguous = format!("<!-- unleashd:merge-prefix -->\na\n<!-- /unleashd:merge-prefix -->\n\nb{MERGE_V0_SUFFIX}");
        assert_eq!(strip_merge_prefix(&ambiguous), ambiguous);
    }

    /// `builderFirstTurnPrompt` (server/src/buddies/turn-policy.ts) as published from 3c1d8d6:
    /// the working-directory line sat after the closing marker.
    fn builder_prompt_3c1d8d6(briefing: &str, cwd: &str, visible: &str) -> String {
        format!(
            "<!-- unleashd:buddy-builder-v1 {} -->\n{briefing}\n<!-- /unleashd:buddy-builder-v1 -->\nWorking directory: {cwd}\n\n{visible}",
            utf16_len(briefing)
        )
    }

    /// `builderFirstTurnPrompt` now: the working-directory line is inside the counted body.
    fn builder_prompt(briefing: &str, cwd: &str, visible: &str) -> String {
        let body = format!("{briefing}\n\nWorking directory: {cwd}");
        format!("<!-- unleashd:buddy-builder-v1 {} -->\n{body}{BUILDER_V1_SUFFIX}{visible}", utf16_len(&body))
    }

    #[test]
    fn builder_envelope_strips_in_every_shape_the_server_has_written() {
        // Regression (task_01a10d29, 2026-10-06): 3c1d8d6 wrote `-->\nWorking directory:` while
        // this reader wanted `-->\n\n`, so every fresh Builder chat showed the recovery placeholder.
        let shapes = [
            builder_prompt("You are the Builder 😀", "/tmp/ws", "Kick off my Buddies"),
            builder_prompt_3c1d8d6("You are the Builder 😀", "/tmp/ws", "Kick off my Buddies"),
            format!("<!-- unleashd:buddy-builder-v1 2 -->\nhi{BUILDER_V1_SUFFIX}Kick off my Buddies"),
        ];
        for msg in shapes {
            let mut v = Visible::default();
            assert_eq!(v.user_message(&msg).unwrap(), "Kick off my Buddies", "{msg}");
            assert_eq!(v.identity(), Identity::Builder);
        }
    }

    #[test]
    fn hidden_test_sessions_are_flagged() {
        let mut v = Visible::default();
        assert_eq!(v.user_message("  [_HIDE_TEST_] probe").unwrap(), "probe");
        assert!(v.hidden());
    }
}
