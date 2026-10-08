//! Canonical domain types. Kinds are sum types; the napi attributes make the same types the
//! TypeScript contract (`index.d.ts` is generated from them). Rows are decoded once, here, and
//! a stored value outside its domain is a typed `Corrupt` error, never a default.

use crate::error::{CoreError, Result};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};

macro_rules! str_enum {
    ($name:ident { $($v:ident = $s:literal),+ $(,)? }) => {
        #[cfg_attr(feature = "node", napi_derive::napi(string_enum = "snake_case"))]
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum $name { $($v),+ }
        impl $name {
            pub fn as_str(self) -> &'static str { match self { $(Self::$v => $s),+ } }
            pub fn parse(s: &str) -> Result<Self> {
                match s { $($s => Ok(Self::$v),)+ other => Err(CoreError::Corrupt(format!("{}: {other:?}", stringify!($name)))) }
            }
        }
        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> { Ok(ToSqlOutput::from(self.as_str())) }
        }
        impl FromSql for $name {
            fn column_result(v: ValueRef<'_>) -> FromSqlResult<Self> {
                Self::parse(v.as_str()?).map_err(|e| FromSqlError::Other(Box::new(e)))
            }
        }
    };
}

str_enum!(BuddyStatus { Active = "active", Archived = "archived" });
str_enum!(TaskStatus { Open = "open", InProgress = "in_progress", Blocked = "blocked", Review = "review", Done = "done", Cancelled = "cancelled" });
str_enum!(RunStatus { Queued = "queued", Running = "running", CancelRequested = "cancel_requested", Complete = "complete", Failed = "failed", Cancelled = "cancelled" });
str_enum!(DocKind { Soul = "soul", Working = "working", LongTerm = "long_term", Shared = "shared" });
// Pattern: sum-types (docs/patterns.md#sum-types)
// Stored at enqueue: owner messages bypass max_active_runs, background work stays capped.
str_enum!(Admission { Owner = "owner", Capped = "capped" });
str_enum!(PostKind { Inform = "inform", Request = "request" });
// Pattern: sum-types (docs/patterns.md#sum-types)
// The two live ends of one request (task_01a11a97): the conversation that sent it and the worker
// conversation bound to its run. A request-addressed message goes from one to the other (messages.rs).
str_enum!(RequestEndpoint { Worker = "worker", Parent = "parent" });
// `run.delivery_scope`: how a `deliver` row is received. `thread` = through the Buddy's thread read
// mark (the fence, `compose`); `to_worker`/`to_parent` = one request-addressed message, received
// only by its own run (messages.rs). Stored on the row, surfaced as `RunInput::Message`.
str_enum!(DeliveryScope { Thread = "thread", ToWorker = "to_worker", ToParent = "to_parent" });
str_enum!(Op { ReadDoc = "read_doc", WriteDoc = "write_doc", Post = "post", ReadChannel = "read_channel", SearchPosts = "search_posts", CreateChannel = "create_channel", ArchiveChannel = "archive_channel", RenameChannel = "rename_channel", WriteTask = "write_task", EnqueueRun = "enqueue_run", CancelRun = "cancel_run", RetryRun = "retry_run", WriteSchedule = "write_schedule", Admin = "admin" });

/// Who acts. Stored as NULL (post author / channel creator) or the key `'owner'` (events, read
/// cursors, channel members).
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    Owner,
    Buddy { id: String },
}

pub const OWNER_KEY: &str = "owner";

impl Actor {
    pub fn key(&self) -> &str {
        match self {
            Actor::Owner => OWNER_KEY,
            Actor::Buddy { id } => id,
        }
    }
    pub fn buddy_id(&self) -> Option<&str> {
        match self {
            Actor::Owner => None,
            Actor::Buddy { id } => Some(id),
        }
    }
    pub fn from_nullable(id: Option<String>) -> Actor {
        id.map_or(Actor::Owner, |id| Actor::Buddy { id })
    }
    pub fn from_key(key: &str) -> Actor {
        match key {
            OWNER_KEY => Actor::Owner,
            id => Actor::Buddy { id: id.to_string() },
        }
    }
}

/// Whose resource an operation touches (the `target` of `authorize`).
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Subject {
    Owner,
    Buddy { id: String },
    Channel { id: String },
    /// A run, for `RetryRun`: its Buddy and managers, or the author of the request it answers.
    Run { id: String },
}

#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Denied { reason: String },
}

// Pattern: sum-types (docs/patterns.md#sum-types) — kinds are enums; handlers match exhaustively.
/// What a channel is. Columns: `kind` plus (name, purpose) | member_key | task_id.
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "type", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelKind {
    Public {
        name: String,
        purpose: String,
    },
    /// One channel per member set; the owner is a member like a buddy.
    Direct {
        members: Vec<Actor>,
    },
    Task {
        task_id: String,
    },
}

/// The canonical member set of a direct channel: keys sorted and deduplicated, joined by ','.
pub fn member_key(members: &[Actor]) -> String {
    let mut keys: Vec<&str> = members.iter().map(Actor::key).collect();
    keys.sort_unstable();
    keys.dedup();
    keys.join(",")
}

pub fn members_of(member_key: &str) -> Vec<Actor> {
    member_key.split(',').map(Actor::from_key).collect()
}

/// Where a post goes. A direct or task channel is found, or created on first use.
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelRef {
    Id { id: String },
    Direct { members: Vec<Actor> },
    Task { task_id: String },
    /// A request's other live endpoint (messages.rs): the post lands in the request's thread and is
    /// delivered to that one conversation only, never through the thread's read mark.
    Request { request_id: String, to: RequestEndpoint },
}

/// A post's request lifecycle. Column `request` NULL is `None`; `Answered` names the answer post.
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "state", discriminant_case = "snake_case"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestState {
    None,
    Awaiting,
    Answered { answer_id: String },
    Cancelled,
    Failed,
}

/// Why a run exists. Columns: (input_kind, input_id); the input_key is derived from it.
///
/// Three live kinds (owner decisions H, I; delivery design §3): `chat` (an owner message, or with no
/// conversation a schedule fire, `fire_slot`), `post` (a request the Buddy owes) and `deliver` (a
/// post in a thread a conversation subscribes to). `reply`, `failure_notice` and `follow` were
/// folded into `deliver`; `schedule` is a silent `chat` again. Their ended rows stay `Retired`
/// history; the schema CHECK refuses a queued one, so it is never claimed.
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "snake_case"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunInput {
    Chat {
        turn_id: String,
    },
    /// A request the buddy owes an answer to.
    Post {
        post_id: String,
    },
    /// A post in a thread the run's conversation subscribes to; the turn shows every unread one (`compose`).
    Deliver {
        post_id: String,
    },
    /// A request-addressed message (messages.rs) for exactly this run's conversation: the request's
    /// worker or its parent. Stored as `deliver` + `delivery_scope`; shows only its own post.
    Message {
        post_id: String,
        to: RequestEndpoint,
    },
    /// A row of a kind folded away by the rebuild. Read-only: never enqueued, claimed or retried.
    Retired {
        input_kind: String,
        input_id: String,
    },
}

/// The run kinds a row may still be enqueued as; any other stored kind is history (`Retired`).
pub const RETIRED_KINDS: [&str; 4] = ["reply", "failure_notice", "follow", "schedule"];

impl RunInput {
    /// The input_key is per recipient for a `Post`: `post:<id>:<buddy>`.
    /// Bug (2026-10-01): the key was `post:<id>`, so in a group DM the second recipient's enqueue
    /// matched the first recipient's run and got no run of its own.
    /// Guard: `a_group_request_starts_one_run_per_recipient` (tests/core.rs).
    /// A delivery is one run per (post, recipient), so a retried post write wakes nobody twice.
    /// A message is a `deliver` row (the schema's input_kind CHECK cannot be ALTERed) told apart by
    /// `delivery_scope`, with its own key: one message run per (post, recipient).
    pub fn columns(&self, buddy_id: &str) -> Result<(&str, &str, String, DeliveryScope)> {
        match self {
            RunInput::Chat { turn_id } => Ok(("chat", turn_id, format!("chat:{turn_id}"), DeliveryScope::Thread)),
            RunInput::Post { post_id } => Ok(("post", post_id, format!("post:{post_id}:{buddy_id}"), DeliveryScope::Thread)),
            RunInput::Deliver { post_id } => Ok(("deliver", post_id, format!("deliver:{post_id}:{buddy_id}"), DeliveryScope::Thread)),
            RunInput::Message { post_id, to } => Ok(("deliver", post_id, format!("message:{post_id}:{buddy_id}"), to.scope())),
            RunInput::Retired { input_kind, .. } => Err(CoreError::Invalid(format!("a {input_kind} run is history; it cannot be enqueued"))),
        }
    }
    pub fn from_columns(kind: &str, id: String, scope: DeliveryScope) -> Result<RunInput> {
        match (kind, scope) {
            ("chat", DeliveryScope::Thread) => Ok(RunInput::Chat { turn_id: id }),
            ("post", DeliveryScope::Thread) => Ok(RunInput::Post { post_id: id }),
            ("deliver", DeliveryScope::Thread) => Ok(RunInput::Deliver { post_id: id }),
            ("deliver", DeliveryScope::ToWorker) => Ok(RunInput::Message { post_id: id, to: RequestEndpoint::Worker }),
            ("deliver", DeliveryScope::ToParent) => Ok(RunInput::Message { post_id: id, to: RequestEndpoint::Parent }),
            (retired, DeliveryScope::Thread) if RETIRED_KINDS.contains(&retired) => Ok(RunInput::Retired { input_kind: retired.to_string(), input_id: id }),
            (other, scope) => Err(CoreError::Corrupt(format!("run input_kind {other:?} with delivery_scope {scope:?}"))),
        }
    }
}

impl RequestEndpoint {
    pub fn scope(self) -> DeliveryScope {
        match self {
            RequestEndpoint::Worker => DeliveryScope::ToWorker,
            RequestEndpoint::Parent => DeliveryScope::ToParent,
        }
    }
}

/// How a run ended, reported by the runner.
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Complete { text: String },
    Failed { code: String, error: String },
    Cancelled { reason: String },
}

/// How a run executes when it must not use its buddy's saved profile: a worker the buddy (or its
/// manager) spawned with a model of its choosing. Absent on a run = the profile. Values pass
/// through verbatim (provider-bespoke); the server checks them against its catalog before posting.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfig {
    pub provider: String,
    /// Absent: the provider's default model, resolved by the host when the run is claimed and
    /// written back onto the run (`record_run_model`), so the run says which model answered
    /// (owner decision J, 2026-10-06). A "default" chip pick could not ride a run before this.
    pub model: Option<String>,
    /// Absent: the provider's default effort.
    pub reasoning_effort: Option<String>,
}

/// Doc audience. Columns (scope_kind, scope_id); Buddy scope's id is the buddy, Workspace's the workspace.
/// Memory kinds (soul, working, long_term) are always Buddy-scoped: one per Buddy, read by every
/// turn kind and the owner's Memory tab. Only shared docs may be Workspace-scoped.
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocScope {
    Buddy,
    Workspace { workspace_id: String },
}

impl DocScope {
    pub fn columns<'a>(&'a self, buddy_id: &'a str) -> (&'static str, &'a str) {
        match self {
            DocScope::Buddy => ("buddy", buddy_id),
            DocScope::Workspace { workspace_id } => ("workspace", workspace_id),
        }
    }
    pub fn from_columns(kind: &str, id: String) -> Result<DocScope> {
        match kind {
            "buddy" => Ok(DocScope::Buddy),
            "workspace" => Ok(DocScope::Workspace { workspace_id: id }),
            other => Err(CoreError::Corrupt(format!("doc scope_kind {other:?}"))),
        }
    }
}

// ---- rows -------------------------------------------------------------------------------------

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Buddy {
    pub id: String,
    pub workspace_id: String,
    pub slug: String,
    pub name: String,
    pub role: String,
    pub status: BuddyStatus,
    pub manager_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub soul_path: Option<String>,
    pub max_active_runs: i64,
    pub created_at: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub workspace_id: String,
    pub owner_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub done_criteria: String,
    pub status: TaskStatus,
    pub paused: bool,
    pub epoch: i64,
    pub next_action: Option<String>,
    pub blocked_reason: Option<String>,
    pub evidence: Vec<String>,
    pub position: i64,
    /// Workspace-home pin: 0 = not pinned, N > 0 = pinned, shown in ascending N. Top-level tasks only.
    pub pin: i64,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A structured post search. `text` is the grammar in `search.rs`; every filter narrows the
/// candidate set BEFORE paging and can only narrow it: readability is checked separately.
/// Empty `channels`/`from` = no filter (the lists are alternatives, ORed within a filter).
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct SearchQuery {
    pub text: String,
    /// Channel ids or public channel names (a leading `#` is ignored).
    pub channels: Vec<String>,
    /// Buddy ids, or `owner`.
    pub from: Vec<String>,
    /// Inclusive lower bound: `YYYY-MM-DD` or an RFC 3339 timestamp.
    pub after: Option<String>,
    /// Exclusive upper bound, same formats.
    pub before: Option<String>,
    /// A thread's root post id: the root and its replies.
    pub in_thread: Option<String>,
}

impl SearchQuery {
    /// No filters: just the text.
    pub fn text(text: &str) -> Self {
        SearchQuery { text: text.into(), channels: vec![], from: vec![], after: None, before: None, in_thread: None }
    }
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Channel {
    pub archived_at: Option<String>,
    pub id: String,
    pub workspace_id: String,
    pub kind: ChannelKind,
    pub created_by: Actor,
    pub created_at: String,
}

/// A post write: the post, and whether this call created it (false: its key replayed).
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct PostWrite {
    pub post: Post,
    pub created: bool,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Post {
    pub id: String,
    pub channel_id: String,
    pub author: Actor,
    pub root_id: Option<String>,
    pub reply_to_id: Option<String>,
    pub task_id: Option<String>,
    pub purpose: Option<String>,
    pub body: String,
    pub evidence: Vec<String>,
    pub request: RequestState,
    pub conversation_id: Option<String>,
    pub created_at: String,
    /// The post's ordered id (UUIDv7): threads, pages and read cursors order by it.
    pub ord: String,
    /// A reply also shown in its channel's feed ("Also send to #channel"). Always false at top level.
    pub broadcast: bool,
}

impl Post {
    /// The thread this post belongs to: its root's id, or its own for a root.
    pub fn root(&self) -> &str {
        self.root_id.as_deref().unwrap_or(&self.id)
    }
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Doc {
    pub id: String,
    pub buddy_id: String,
    pub workspace_id: String,
    pub scope: DocScope,
    pub kind: DocKind,
    pub name: String,
    pub revision: i64,
    pub content: String,
    pub updated_at: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct DocRevision {
    pub doc_id: String,
    pub revision: i64,
    pub content: String,
    pub reason: String,
    pub author: String,
    pub provenance: String,
    pub sha256: String,
    pub created_at: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Schedule {
    pub id: String,
    pub buddy_id: String,
    pub workspace_id: String,
    pub task_id: Option<String>,
    pub name: String,
    pub cron: String,
    pub timezone: String,
    pub prompt: String,
    pub enabled: bool,
    pub next_run_at: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Run {
    pub id: String,
    pub input_key: String,
    pub attempt: i64,
    pub input: RunInput,
    pub buddy_id: String,
    pub workspace_id: String,
    pub conversation_id: Option<String>,
    pub task_id: Option<String>,
    pub task_epoch: Option<i64>,
    pub after_run_id: Option<String>,
    pub status: RunStatus,
    pub deadline: Option<String>,
    pub lease_expires_at: Option<String>,
    pub outcome: Option<String>,
    pub error_code: Option<String>,
    pub error: Option<String>,
    pub ready_at: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    /// Absent: the run executes on its buddy's profile.
    pub config: Option<RunConfig>,
    /// A chat run's input (the owner's message, JSON the host wrote) while it can still be
    /// requeued. The schema refuses a queued chat run without it (Pattern: durable-intake).
    pub body: Option<String>,
    /// When the holder was about to spawn (`mark_executing`). Absent: nothing ran yet, so a dead
    /// holder's run goes back to the queue instead of being replayed or reported lost.
    pub executing_at: Option<String>,
    /// A delivery's newest shown post, fixed by its first compose (deliveries.rs).
    pub through_ord: Option<String>,
    /// Decided at enqueue; see `Admission`.
    pub admission: Admission,
}

/// Why a queued run cannot be claimed yet. This is derived from the claim predicate on every
/// read; it is never stored.
// Pattern: sum-types (docs/patterns.md#sum-types)
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "snake_case"))]
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum RunWaiting {
    NotBefore { at: String },
    BuddyArchived,
    ConversationBusy,
    PoolFull { active: i64, max: i64 },
    TaskPaused,
}

/// The bounded list projection. Full execution state and outcomes stay on `get_run`.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct RunRow {
    pub id: String,
    pub status: RunStatus,
    pub input: RunInput,
    pub task_id: Option<String>,
    pub requester: Option<Actor>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub waiting: Option<RunWaiting>,
    /// The thread the run worked in, so a reader can open or resume it.
    pub conversation_id: Option<String>,
    /// What happened to a run that did not complete (e.g. `lease_expired`: the host or holder died mid-run and the claim gate ended it).
    pub error_code: Option<String>,
    pub error: Option<String>,
    /// What the run is FOR: the `purpose` of its post, when the reader may read that post's channel.
    pub purpose: Option<String>,
    pub task_title: Option<String>,
}

/// A queued or running delivery: "X is replying…" for a channel (deliveries.rs `responding`).
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Responding {
    pub waiting: Option<RunWaiting>,
    pub buddy_id: String,
    pub thread_root_id: String,
    pub started_at: String,
    pub running: bool,
    /// The seat the delivery runs (or is bound to run) in; none for an unbound mention. The host
    /// asks its live turn there what can reach it (channels.ts `reachOf`, task_01a11af2).
    pub conversation_id: Option<String>,
    /// It carries the owner's explicit pick (model, effort, provider): it is never steered into a
    /// live turn and runs as its own (deliveries.rs `take_steering`).
    pub picked: bool,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Claim {
    pub run: Run,
    pub lease_token: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Event {
    pub seq: i64,
    pub at: String,
    pub actor: String,
    pub workspace_id: String,
    pub buddy_id: Option<String>,
    pub task_id: Option<String>,
    pub op: String,
    pub payload: String,
    pub idem_key: Option<String>,
    pub result_ref: Option<String>,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Conversation {
    pub id: String,
    pub buddy_id: String,
    pub workspace_id: String,
    pub task_id: Option<String>,
    pub created_at: String,
}

// ---- inputs and query shapes ----------------------------------------------------------------

/// A Buddy a post wakes. `config`: the owner's mention-chip pick, which the delivery turn runs on.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Mention {
    pub buddy_id: String,
    pub config: Option<RunConfig>,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct PostInput {
    /// `Request` needs a direct channel: the other members owe the answer.
    pub kind: PostKind,
    pub body: String,
    pub purpose: Option<String>,
    pub evidence: Vec<String>,
    /// A reply in a thread: the post it responds to, in the same channel. Absent = a new top-level post.
    pub reply_to_id: Option<String>,
    pub task_id: Option<String>,
    /// The conversation the post was written from: provenance, and in a direct channel (or any
    /// thread it follows) the conversation later posts by others there are delivered to.
    pub from_conversation_id: Option<String>,
    /// The Buddies this post wakes (its @mentions; the Buddies of a DM the owner wrote in), each a
    /// `deliver` run written in the post's own transaction (deliveries.rs `wake`).
    pub mentions: Vec<Mention>,
    /// A `Request` only: its recipients' runs execute with this instead of their profile (a
    /// worker). Every recipient must be the author or report to it (`EnqueueRun`).
    pub run_config: Option<RunConfig>,
    /// A reply that also appears in the channel feed and its unread count. Invalid without `reply_to_id`.
    pub broadcast: bool,
    pub key: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct AnswerInput {
    pub request_id: String,
    pub body: String,
    pub evidence: Vec<String>,
    /// The conversation that answered: provenance, and it subscribes to the request's thread.
    pub from_conversation_id: Option<String>,
    pub key: String,
}

/// A foreground chat input, with its text: the queued run IS the owner's message.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct ChatEnqueue {
    pub buddy_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    /// The message as the host serialized it; never read by the crate.
    pub body: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct DocRef {
    pub buddy_id: String,
    pub scope: DocScope,
    pub kind: DocKind,
    pub name: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct DocWrite {
    pub doc: DocRef,
    pub content: String,
    /// The revision the writer read; 0 when the doc does not exist yet.
    pub base_revision: i64,
    pub reason: String,
    pub key: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, Default)]
pub struct TaskChanges {
    pub title: Option<String>,
    pub done_criteria: Option<String>,
    pub status: Option<TaskStatus>,
    pub next_action: Option<String>,
    pub blocked_reason: Option<String>,
    pub evidence: Option<Vec<String>>,
    pub paused: Option<bool>,
    pub position: Option<i64>,
    /// 0 unpins; N > 0 pins at order N (lower = earlier). Only a top-level task can be pinned.
    pub pin: Option<i64>,
    pub owner_id: Option<String>,
}

/// A task write. Every field of `TaskChanges` is a patch: absent = unchanged.
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone)]
pub enum TaskWrite {
    Create { owner_id: String, parent_id: Option<String>, title: String, done_criteria: String, key: String },
    Update { task_id: String, base_revision: i64, changes: TaskChanges, key: String },
}

#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone)]
pub enum TaskQuery {
    Owner { buddy_id: String },
    Workspace { workspace_id: String },
    Children { parent_id: String },
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct EnqueueInput {
    pub buddy_id: String,
    pub input: RunInput,
    pub conversation_id: Option<String>,
    pub task_id: Option<String>,
    pub config: Option<RunConfig>,
}

#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone)]
pub enum RunQuery {
    Buddy {
        buddy_id: String,
    },
    Conversation {
        conversation_id: String,
    },
    Task {
        task_id: String,
    },
    /// Running (or cancel-requested) runs in a workspace: what its buddies are doing now.
    Live {
        workspace_id: String,
    },
}

// Pattern: one-definition (docs/patterns.md#one-definition)
// Runs and schedules answer the same scope question; one tagged contract keeps their NAPI
// boundary and all generated consumers in sync.
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone)]
pub enum ListScope {
    Buddy { buddy_id: String },
    Task { task_id: String },
    Workspace { workspace_id: String },
}

impl ListScope {
    /// The run/schedule column this scope filters on, with its id.
    pub(crate) fn column(self) -> (&'static str, String) {
        match self {
            ListScope::Buddy { buddy_id } => ("buddy_id", buddy_id),
            ListScope::Task { task_id } => ("task_id", task_id),
            ListScope::Workspace { workspace_id } => ("workspace_id", workspace_id),
        }
    }
}

/// Keyset position: posts strictly older than this ordered id.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Cursor {
    /// The ordered id of the last post of the previous page.
    pub ord: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "snake_case"))]
#[derive(Debug, Clone)]
pub enum PostQuery {
    /// Top-level posts of a channel.
    Channel { channel_id: String },
    /// Replies under a thread root.
    Thread { root_id: String },
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct PostPage {
    pub posts: Vec<Post>,
    pub next: Option<Cursor>,
}

/// A thread root's replies at a glance: the channel row's "3 replies · last reply 2m ago".
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadStat {
    pub root_id: String,
    pub replies: i64,
    pub last_reply_at: String,
    /// The newest reply's ordered id: after the reader's cursor, the thread has something new.
    pub last_reply_ord: String,
    pub last_reply_author: Actor,
}

/// One Buddy's unfinished top-level tasks: `open` counts every one (blocked included).
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCount {
    pub buddy_id: String,
    pub open: i64,
    pub blocked: i64,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct ChannelUnread {
    pub channel: Channel,
    /// Posts by others after the reader's cursor (all of them when it has none).
    pub unread: i64,
    /// The reader's cursor: the ordered id it has read through. Absent: it never read the channel.
    pub last_read_ord: Option<String>,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct Inbox {
    /// Requests addressed to the actor that still await its answer.
    pub requests: Vec<Post>,
    /// The actor's own requests still awaiting someone else's answer.
    pub waiting_on: Vec<Post>,
    /// The actor's channels in the workspace: every public one, its direct ones, and any it has read.
    pub channels: Vec<ChannelUnread>,
    /// Followed threads in the workspace with a reply by someone else after the actor's thread cursor.
    pub unread_threads: i64,
}

/// What a followed thread's card shows after its root: the fold (`hidden` replies) then `posts`,
/// oldest first. D = Unread (the replies after the cursor, at most 20) ⊕ CaughtUp (the last 2).
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "snake_case"))]
#[derive(Debug, Clone)]
pub enum ThreadTail {
    Unread { hidden: i64, posts: Vec<Post> },
    CaughtUp { hidden: i64, posts: Vec<Post> },
}

/// One card of the Threads view: a thread with at least one reply that the actor follows.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct FollowedThread {
    pub channel: Channel,
    pub root: Post,
    pub replies: i64,
    /// Distinct authors, root author first.
    pub participants: Vec<Actor>,
    pub tail: ThreadTail,
}

/// Unread threads first, then by newest post. `more`: followed threads beyond `limit`.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct FollowedThreads {
    pub threads: Vec<FollowedThread>,
    pub more: bool,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct ChannelInput {
    pub workspace_id: String,
    pub name: String,
    pub purpose: String,
    pub key: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct ScheduleInput {
    /// Absent = create.
    pub id: Option<String>,
    pub buddy_id: String,
    pub task_id: Option<String>,
    pub name: String,
    pub cron: String,
    pub timezone: String,
    pub prompt: String,
    pub enabled: bool,
    pub key: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct EventInput {
    pub workspace_id: String,
    pub op: String,
    pub payload: String,
    pub key: Option<String>,
    pub buddy_id: Option<String>,
    pub task_id: Option<String>,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct ConversationInput {
    pub id: String,
    pub buddy_id: String,
    pub task_id: Option<String>,
}

pub fn evidence_json(v: &[String]) -> String {
    serde_json::to_string(v).expect("string list serializes")
}

pub fn parse_evidence(s: &str) -> Result<Vec<String>> {
    serde_json::from_str(s).map_err(|e| CoreError::Corrupt(format!("evidence {s:?}: {e}")))
}

// ---- team admin (owner only) ------------------------------------------------------------------

/// Who a buddy reports to. `Nobody` makes it a top-level buddy.
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagerRef {
    Nobody,
    Buddy { id: String },
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct BuddyCreate {
    pub workspace_id: String,
    pub slug: String,
    pub name: String,
    pub role: String,
    pub manager: ManagerRef,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub key: String,
}

/// A profile field's new value: a named choice, or back to the server's default (column NULL).
/// A plain `Option<String>` patch could not say "clear" — absent already means "unchanged".
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "lowercase"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Setting {
    Set { value: String },
    Default,
}

impl Setting {
    /// The column value: `Default` stores NULL.
    pub fn column(&self) -> Option<&str> {
        match self {
            Setting::Set { value } => Some(value),
            Setting::Default => None,
        }
    }
}

/// A patch: every absent field is unchanged.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, Default)]
pub struct BuddyChanges {
    pub name: Option<String>,
    pub role: Option<String>,
    pub manager: Option<ManagerRef>,
    pub provider: Option<Setting>,
    pub model: Option<Setting>,
    pub reasoning_effort: Option<Setting>,
    pub max_active_runs: Option<i64>,
    pub status: Option<BuddyStatus>,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct BuddyUpdate {
    pub buddy_id: String,
    pub changes: BuddyChanges,
    pub key: String,
}

#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct WorkspaceInput {
    pub name: String,
    pub root_path: String,
}

/// A thread's unread posts for one Buddy, oldest first: the newest `limit`, and how many older
/// unread ones were left out.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct ThreadUnread {
    pub posts: Vec<Post>,
    pub unshown: i64,
}

/// A request-addressed message still waiting for its conversation (messages.rs `pending`): the
/// live turn's tool boundary shows it, then settles `run_id` (`acknowledge`).
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone)]
pub struct AddressedMessage {
    pub run_id: String,
    pub to: RequestEndpoint,
    pub post: Post,
}

// Which posts make a live turn's tool boundary take the thread's unread page (deliveries.rs
// `take_steering`): any unread post at a Buddy MCP tool call; only an owner post at a native
// tool hook or a held Stop (Buddy chatter there waits for a Buddy tool call or the next turn).
str_enum!(SteerTrigger { AnyPost = "any_post", OwnerPost = "owner_post" });

/// What one tool boundary of a live thread turn got (deliveries.rs `take_steering`).
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "snake_case"))]
#[derive(Debug, Clone)]
pub enum Steering {
    /// The page was taken into the turn: marked read, fencing its queued deliveries.
    Taken { posts: Vec<Post>, unshown: i64 },
    /// A queued delivery in the thread carries an explicit pick (model, effort, provider): nothing
    /// is read, so that delivery runs as its own turn on the picked config.
    PickQueued,
    /// Nothing the trigger takes: no unread post, or (OwnerPost) none by the owner.
    Quiet,
}

/// What a claimed delivery shows (deliveries.rs `compose`).
#[cfg_attr(feature = "node", napi_derive::napi(discriminant = "kind", discriminant_case = "snake_case"))]
#[derive(Debug, Clone)]
pub enum Delivery {
    /// Posts the conversation has not read, oldest first, across every thread it subscribes to;
    /// `unshown` older ones were left out (they are read with channel_read).
    /// `subscribed`: the conversation the Buddy follows the trigger's thread in, for a delivery
    /// that was queued with none (a mention): the host runs it there, not in a new seat.
    Posts { posts: Vec<Post>, unshown: i64, subscribed: Option<String> },
    /// Everything it would show was read meanwhile: the run settles with no turn.
    Consumed,
}

/// A run the caller's live turn executes; the claim gate renews it before expiring leases.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunHold {
    pub run_id: String,
    pub lease_token: String,
}

/// The two clocks a claim starts, kept apart because one number serving both killed owner chats
/// at 600 s (2026-09-10) and left dead holders' runs `running` for 24 h (2026-09-30).
/// `lease_ms`: how long the holder may go without renewing before the claim gate ends the run.
/// `chat_deadline_ms` / `turn_deadline_ms`: the absolute runtime budget of a foreground chat run
/// and of every other run, written to the run's `deadline` column. All three are required: the
/// host passes TURN_MAX_RUNTIME_MS for chats explicitly, never a default (AGENTS.md).
/// A zero turn_deadline_ms disables the background cutoff (deadline is NULL), not the lease.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunBudgets {
    pub lease_ms: i64,
    pub chat_deadline_ms: i64,
    pub turn_deadline_ms: i64,
}
