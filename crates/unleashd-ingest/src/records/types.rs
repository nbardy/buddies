//! Pattern: one-type-source (docs/patterns.md#one-type-source)
//!
//! The conversation record is typed here and napi generates `index.d.ts`. Shared Zod schemas
//! describe live input/wire values, not a second stored-record shape. Field names,
//! discriminants and literals stay aligned so app inputs cross without translation.
//!
//! Pattern: sum-types (docs/patterns.md#sum-types) — every Zod union is a Rust enum here:
//! lifecycle status, provenance, model/reasoning selection, knowledge scope, and the stored
//! conversation kind (`ConversationKindSchema`, record v2 since T09).
//!
//! Nullish fields (`z.string().nullish()` in `BuddyContextSchema`) are `Option<Option<T>>`:
//! outer `None` = key absent, `Some(None)` = explicit `null`. 999 of 1,001 real Buddy contexts
//! write `null` and 2 omit the key; keeping the difference is what lets the import verify by
//! content hash instead of by "equal after normalisation".

use crate::model::{Provider, WorkerRole};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

// Doc comments are not forwarded through the macro: napi's typegen prints a forwarded `#[doc]`
// as `r" …` in index.d.ts. Document these enums with `//` comments at the call site.
macro_rules! snake_enum {
    ($name:ident { $($variant:ident = $s:literal),+ $(,)? }) => {
        #[cfg_attr(feature = "node", napi_derive::napi(string_enum = "snake_case"))]
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $s)] $variant),+ }

        impl $name {
            pub fn as_str(&self) -> &'static str {
                match self { $($name::$variant => $s),+ }
            }
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($s => Some($name::$variant),)+ _ => None }
            }
        }
    };
}

// `status`: a deleted record is a tombstone, kept so its transcripts stay recognisable.
snake_enum!(RecordStatus { Active = "active", Deleted = "deleted" });
// Who established the config: the owner, inference from prior usage/defaults, or a discovered
// transcript. Thread inference reuses legacy_inferred; an explicit choice persists as user.
snake_enum!(Provenance { User = "user", LegacyInferred = "legacy_inferred", ExternalDiscovered = "external_discovered" });
snake_enum!(BuddyVisibility { Foreground = "foreground", Background = "background" });

/// Deserialize a present key (value or `null`) as `Some(..)`; `#[serde(default)]` makes an
/// absent key `None`.
fn nullish<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "mode", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ModelSelection {
    Default,
    Explicit { model_id: String },
}

#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "mode", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum ReasoningSelection {
    Default,
    Disabled,
    Explicit { effort: String },
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationConfig {
    pub provider: Provider,
    pub model: ModelSelection,
    pub reasoning: ReasoningSelection,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedExecutionConfig {
    pub provider: Provider,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

/// Provider-counted tokens of the latest request on one session (`ProviderTurnUsageSchema`).
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderTurnUsage {
    pub context_tokens: i64,
    pub output_tokens: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i64>,
    /// Present only when the harness reports one (codex).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    pub observed_at: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionBinding {
    pub provider: Provider,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buddy_audience_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_usage: Option<ProviderTurnUsage>,
}

impl SessionBinding {
    pub fn same_session(&self, other: &SessionBinding) -> bool {
        self.provider == other.provider && self.session_id == other.session_id
    }
}

/// `BuddyKnowledgeScopeSchema` (strict objects).
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "snake_case"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum KnowledgeScope {
    OwnerThread { conversation_id: String },
    Project { project_id: String },
    Workspace { workspace_id: String },
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuddyContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge_scope: Option<KnowledgeScope>,
    #[serde(default, deserialize_with = "nullish", skip_serializing_if = "Option::is_none")]
    pub coordination_run_id: Option<Option<String>>,
    pub buddy_id: String,
    pub workspace_id: String,
    #[serde(default, deserialize_with = "nullish", skip_serializing_if = "Option::is_none")]
    pub buddy_project_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullish", skip_serializing_if = "Option::is_none")]
    pub legacy_work_item_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullish", skip_serializing_if = "Option::is_none")]
    pub automation_run_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullish", skip_serializing_if = "Option::is_none")]
    pub delegated_by_buddy_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullish", skip_serializing_if = "Option::is_none")]
    pub parent_buddy_conversation_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_buddy_operations: Option<Vec<String>>,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationBranch {
    pub source_conversation_id: String,
    pub through_message_id: String,
    pub audience: KnowledgeScope,
    pub handoff: String,
    /// digest → handoff. A BTreeMap so the stored JSON is byte-stable; key order carries no
    /// meaning (the TS reads it only by key and by count).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launches: Option<BTreeMap<String, String>>,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationCreation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<ConversationBranch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_message_dispatch_claimed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_message_dispatch_claim_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_message_dispatched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_debug_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumed_from_conversation_id: Option<String>,
}

/// `ConversationKindSchema`: what the thread is, fixed at creation. The worker ids and role are
/// `.nullable()` (never absent), so they serialize as `null` — `use_nullable` makes napi do the
/// same (without it `None` crosses as an absent key, which the Zod schema rejects).
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "t", discriminant_case = "lowercase", use_nullable = true))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum ConversationKind {
    Chat,
    Buddy { context: BuddyContext, visibility: BuddyVisibility },
    Builder,
    Worker { swarm_id: Option<String>, worker_id: Option<String>, role: Option<WorkerRole> },
}

impl ConversationKind {
    /// The `kind` column: the tag, for counting and eyeballing with the sqlite3 CLI.
    pub fn tag(&self) -> &'static str {
        match self {
            ConversationKind::Chat => "chat",
            ConversationKind::Buddy { .. } => "buddy",
            ConversationKind::Builder => "builder",
            ConversationKind::Worker { .. } => "worker",
        }
    }
}

/// One durable conversation record. `version` is not a field: every stored record is version 2
/// (T09's `kind`); v1 files were migrated by the one-time import, deleted after the 2026-09-27 swap (last at 03fc931).
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationRecord {
    pub conversation_id: String,
    pub kind: ConversationKind,
    /// Earlier sessions of this conversation, oldest first. Indexed for transcript discovery.
    pub session_bindings: Vec<SessionBinding>,
    /// The session a new turn resumes. Absent = no provider session started yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_session: Option<SessionBinding>,
    pub status: RecordStatus,
    /// The owner marked it done: hidden from working lists, still loaded and resumable.
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation: Option<ConversationCreation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub config: ConversationConfig,
    /// Advances on every write; the internal CAS token.
    pub record_revision: i64,
    /// Advances only when `config` changes; the client's CAS token for `set_config`.
    pub config_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_resolved_config: Option<ResolvedExecutionConfig>,
    pub provenance: Provenance,
    pub created_at: String,
    pub updated_at: String,
}

impl ConversationRecord {
    /// `sessionBindings` ∪ `currentSession`, one per (provider, sessionId), first occurrence kept
    /// in position and last occurrence's value (the TS `uniqueBindings` Map semantics).
    pub fn all_bindings(&self) -> Vec<&SessionBinding> {
        unique_bindings(self.session_bindings.iter().chain(self.current_session.iter()))
    }
}

pub fn unique_bindings<'a>(bindings: impl Iterator<Item = &'a SessionBinding>) -> Vec<&'a SessionBinding> {
    let mut out: Vec<&SessionBinding> = Vec::new();
    for binding in bindings {
        match out.iter().position(|b| b.same_session(binding)) {
            Some(i) => out[i] = binding,
            None => out.push(binding),
        }
    }
    out
}

/// A (provider, session id) key.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SessionKey {
    pub provider: Provider,
    pub session_id: String,
}

/// The startup list row: what hydration joins against ingest's session rows. The full record is
/// one `get` away.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordSummary {
    pub conversation_id: String,
    pub status: RecordStatus,
    pub done: bool,
    pub kind: ConversationKind,
    pub provenance: Provenance,
    pub working_directory: Option<String>,
    pub provider: Provider,
    pub current_session: Option<SessionKey>,
    /// Every bound session (history and current), for the join with transcripts.
    pub sessions: Vec<SessionKey>,
    pub config_revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// `create`'s input: a record at revision 0, stamped by the store.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRecord {
    pub conversation_id: String,
    pub kind: ConversationKind,
    pub session_bindings: Vec<SessionBinding>,
    pub current_session: Option<SessionBinding>,
    pub working_directory: Option<String>,
    pub creation: Option<ConversationCreation>,
    pub config: ConversationConfig,
    pub last_resolved_config: Option<ResolvedExecutionConfig>,
    pub provenance: Provenance,
}

#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "t", discriminant_case = "snake_case"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateOutcome {
    Created {
        record: ConversationRecord,
    },
    /// A record with this id exists (the caller decides whether it is a replay of this create).
    Exists {
        current: ConversationRecord,
    },
}

/// `set_config`: compare-and-set on `configRevision`.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetConfig {
    pub conversation_id: String,
    pub expected_config_revision: i64,
    pub config: ConversationConfig,
    pub last_resolved_config: ResolvedExecutionConfig,
    /// Inferred thread choices retain their origin; ordinary edits default to `user`.
    pub provenance: Option<Provenance>,
}

#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "t", discriminant_case = "snake_case"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetConfigOutcome {
    /// Written at `expected + 1`; provenance defaults to `user`.
    Committed {
        record: ConversationRecord,
    },
    /// Another writer moved the revision first. `current` is what won.
    RevisionConflict {
        current: ConversationRecord,
    },
    Tombstoned {
        current: ConversationRecord,
    },
    Missing,
}

/// One owner message that has been sent and has not finished its turn (`conversation_input`).
/// `body` is the server's JSON, opaque here.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationInput {
    pub id: String,
    pub conversation_id: String,
    pub body: String,
    pub queued_at: String,
    pub executing_at: Option<String>,
}
