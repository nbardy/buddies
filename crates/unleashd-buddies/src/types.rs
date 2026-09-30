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
str_enum!(PostKind { Inform = "inform", Request = "request" });
str_enum!(Op { ReadDoc = "read_doc", WriteDoc = "write_doc", Post = "post", ReadChannel = "read_channel", SearchPosts = "search_posts", CreateChannel = "create_channel", ArchiveChannel = "archive_channel", RenameChannel = "rename_channel", WriteTask = "write_task", EnqueueRun = "enqueue_run", CancelRun = "cancel_run", WriteSchedule = "write_schedule", Admin = "admin" });

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
    /// The buddy's request was answered; `post_id` is the request.
    Reply {
        post_id: String,
    },
    Schedule {
        schedule_id: String,
        slot: String,
    },
    FailureNotice {
        run_id: String,
    },
}

impl RunInput {
    pub fn columns(&self) -> (&'static str, &str, String) {
        match self {
            RunInput::Chat { turn_id } => ("chat", turn_id, format!("chat:{turn_id}")),
            RunInput::Post { post_id } => ("post", post_id, format!("post:{post_id}")),
            RunInput::Reply { post_id } => ("reply", post_id, format!("reply:{post_id}")),
            RunInput::Schedule { schedule_id, slot } => ("schedule", schedule_id, format!("schedule:{schedule_id}:{slot}")),
            RunInput::FailureNotice { run_id } => ("failure_notice", run_id, format!("failure:{run_id}")),
        }
    }
    /// A schedule run's slot is its `ready_at`.
    pub fn from_columns(kind: &str, id: String, ready_at: &str) -> Result<RunInput> {
        match kind {
            "chat" => Ok(RunInput::Chat { turn_id: id }),
            "post" => Ok(RunInput::Post { post_id: id }),
            "reply" => Ok(RunInput::Reply { post_id: id }),
            "schedule" => Ok(RunInput::Schedule { schedule_id: id, slot: ready_at.to_string() }),
            "failure_notice" => Ok(RunInput::FailureNotice { run_id: id }),
            other => Err(CoreError::Corrupt(format!("run input_kind {other:?}"))),
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
    pub model: String,
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
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
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
    pub return_conversation_id: Option<String>,
    pub created_at: String,
    /// The post's ordered id (UUIDv7): threads, pages and read cursors order by it.
    pub ord: String,
    /// A reply also shown in its channel's feed ("Also send to #channel"). Always false at top level.
    pub broadcast: bool,
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
    pub limits: String,
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
    pub snapshot: Option<String>,
    pub outcome: Option<String>,
    pub error_code: Option<String>,
    pub error: Option<String>,
    pub ready_at: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    /// Absent: the run executes on its buddy's profile.
    pub config: Option<RunConfig>,
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
    AfterRun { run_id: String },
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
    /// What happened to a run that did not complete (e.g. `interrupted`: the host restarted).
    pub error_code: Option<String>,
    pub error: Option<String>,
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
    /// The sender's conversation; a `Request`'s answer returns there.
    pub from_conversation_id: Option<String>,
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
    pub key: String,
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
    pub after_run_id: Option<String>,
    pub deadline: Option<String>,
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
    Queued,
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
    pub limits: String,
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

/// What startup recovery ended: runs a dead process held, and chat turns nobody waits for.
#[cfg_attr(feature = "node", napi_derive::napi(object))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovery {
    pub interrupted: i64,
    pub abandoned_chats: i64,
}
