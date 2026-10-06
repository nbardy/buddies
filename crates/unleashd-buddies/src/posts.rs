//! Posts: every message, channel post and task comment is a post in a channel (DESIGN B.2; owner
//! decision T06b: "direct messages between two buddies or messages to a channel … the same table
//! and the same data type"). A channel is public, direct (a member set) or a task's.
//!
//! A `Request` lives in a direct channel. The other member owes the answer and, if a buddy, gets a
//! `Post` run. The answer is an ordinary post (`reply_to_id` = the request, in its thread):
//! `answer` inserts it and flips the request to answered in one transaction, and the asker's
//! subscription to the thread delivers it (deliveries.rs), like any other post there.
//! Pattern: one-write-path (docs/patterns.md#one-write-path)

use crate::error::{CoreError, Result};
use crate::runs::Enqueue;
use crate::store::{Mutation, Store, collect, corrupt, get_buddy, idempotent, idempotent_write, new_id, now_iso, require};
use crate::tasks::get_task;
use crate::types::*;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};
use serde_json::json;

pub(crate) const POST_COLS: &str = "p.id, p.channel_id, p.author_id, p.root_id, p.reply_to_id, p.task_id, p.purpose, p.body, p.evidence, \
    p.request, p.answer_id, p.conversation_id, p.created_at, p.ord, p.broadcast";

/// The channels `actor_param` (an actor key) may read: the owner every one, a buddy the public and
/// task channels and the direct channels it is a member of. `c` is the channel.
fn readable_by(actor_param: &str) -> String {
    format!(
        "({actor_param} = 'owner' OR c.kind != 'direct'
          OR EXISTS (SELECT 1 FROM channel_member m WHERE m.channel_id = c.id AND m.member = {actor_param}))"
    )
}

/// A search date bound in the stored `created_at` format (UTC, millisecond Z), so the comparison
/// is plain text order. A bare date means midnight UTC.
fn search_instant(field: &str, raw: &str) -> Result<String> {
    use chrono::{DateTime, NaiveDate, Utc};
    let instant = match NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        Ok(day) => day.and_hms_opt(0, 0, 0).expect("midnight").and_utc(),
        Err(_) => DateTime::parse_from_rfc3339(raw)
            .map_err(|_| CoreError::Invalid(format!("search {field}: `{raw}` is not YYYY-MM-DD or an RFC 3339 timestamp")))?
            .with_timezone(&Utc),
    };
    Ok(instant.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// A feed page from `limit + 1` rows, newest first: the extra row only says there is a next page.
fn keyset_page(mut posts: Vec<Post>, limit: i64) -> PostPage {
    let next = match posts.len() as i64 > limit {
        true => {
            posts.truncate(limit as usize);
            posts.last().map(|p| Cursor { ord: p.ord.clone() })
        }
        false => None,
    };
    PostPage { posts, next }
}

/// A channel feed row: a top-level post, or a reply also sent to the channel.
const IN_CHANNEL_FEED: &str = "(p.root_id IS NULL OR p.broadcast = 1)";

pub(crate) fn post_row(r: &Row) -> rusqlite::Result<Post> {
    let request = match (r.get::<_, Option<String>>(9)?.as_deref(), r.get::<_, Option<String>>(10)?) {
        (None, None) => RequestState::None,
        (Some("awaiting"), None) => RequestState::Awaiting,
        (Some("answered"), Some(answer_id)) => RequestState::Answered { answer_id },
        (Some("cancelled"), None) => RequestState::Cancelled,
        (Some("failed"), None) => RequestState::Failed,
        (state, answer) => return Err(corrupt(CoreError::Corrupt(format!("request {state:?} with answer {answer:?}")))),
    };
    Ok(Post {
        id: r.get(0)?,
        channel_id: r.get(1)?,
        author: Actor::from_nullable(r.get(2)?),
        root_id: r.get(3)?,
        reply_to_id: r.get(4)?,
        task_id: r.get(5)?,
        purpose: r.get(6)?,
        body: r.get(7)?,
        evidence: parse_evidence(&r.get::<_, String>(8)?).map_err(corrupt)?,
        request,
        conversation_id: r.get(11)?,
        created_at: r.get(12)?,
        ord: r.get(13)?,
        broadcast: r.get(14)?,
    })
}

pub(crate) fn get_post(conn: &Connection, id: &str) -> Result<Post> {
    conn.prepare_cached(&format!("SELECT {POST_COLS} FROM post p WHERE p.id = ?1"))?
        .query_row([id], post_row)
        .optional()?
        .ok_or_else(|| CoreError::not_found("post", id))
}

const CHANNEL_COLS: &str = "c.id, c.workspace_id, c.kind, c.name, c.purpose, c.member_key, c.task_id, c.created_by, c.created_at, c.archived_at";

fn channel_row(r: &Row) -> rusqlite::Result<Channel> {
    let kind = match (r.get::<_, String>(2)?.as_str(), r.get(3)?, r.get(4)?, r.get::<_, Option<String>>(5)?, r.get(6)?) {
        ("public", Some(name), Some(purpose), None, None) => ChannelKind::Public { name, purpose },
        ("direct", None, None, Some(key), None) => ChannelKind::Direct { members: members_of(&key) },
        ("task", None, None, None, Some(task_id)) => ChannelKind::Task { task_id },
        (kind, ..) => return Err(corrupt(CoreError::Corrupt(format!("channel kind {kind:?} with the columns of another kind")))),
    };
    Ok(Channel { id: r.get(0)?, workspace_id: r.get(1)?, kind, created_by: Actor::from_nullable(r.get(7)?), created_at: r.get(8)?, archived_at: r.get(9)? })
}

pub(crate) fn get_channel(conn: &Connection, id: &str) -> Result<Channel> {
    find_channel(conn, "id", id)?.ok_or_else(|| CoreError::not_found("channel", id))
}

/// `column` is a unique key of `channel`: id, member_key or task_id.
fn find_channel(conn: &Connection, column: &str, value: &str) -> Result<Option<Channel>> {
    Ok(conn
        .prepare_cached(&format!("SELECT {CHANNEL_COLS} FROM channel c WHERE c.{column} = ?1"))?
        .query_row([value], channel_row)
        .optional()?)
}

/// The channel a ref names. A direct or task channel is created on first use; the unique keys
/// (member_key, task_id) and the write lock keep it to one per member set and per task.
fn open_channel(tx: &Connection, actor: &Actor, channel: &ChannelRef) -> Result<Channel> {
    match channel {
        ChannelRef::Id { id } => get_channel(tx, id),
        ChannelRef::Direct { members } => direct_channel(tx, actor, members),
        ChannelRef::Task { task_id } => task_channel(tx, actor, task_id),
    }
}

/// A direct channel is listed in its creator's workspace (the first buddy member's when the owner
/// creates it). Membership, not the workspace, decides who may read and post.
fn direct_channel(tx: &Connection, actor: &Actor, members: &[Actor]) -> Result<Channel> {
    let key = member_key(members);
    if let Some(found) = find_channel(tx, "member_key", &key)? {
        return Ok(found);
    }
    let members = members_of(&key);
    // Creation is where a group DM would come into being; an existing one was found above.
    require_pair(&members)?;
    for id in members.iter().filter_map(Actor::buddy_id) {
        get_buddy(tx, id)?;
    }
    let home = actor
        .buddy_id()
        .or_else(|| members.iter().find_map(Actor::buddy_id))
        .ok_or_else(|| CoreError::Invalid("a direct channel needs a buddy member".into()))?;
    let id = new_id("dm");
    tx.execute(
        "INSERT INTO channel (id, workspace_id, kind, member_key, created_by, created_at) VALUES (?1, ?2, 'direct', ?3, ?4, ?5)",
        params![id, get_buddy(tx, home)?.workspace_id, key, actor.buddy_id(), now_iso()],
    )?;
    for member in &members {
        tx.execute("INSERT INTO channel_member (channel_id, member) VALUES (?1, ?2)", params![id, member.key()])?;
    }
    get_channel(tx, &id)
}

pub(crate) fn task_channel(tx: &Connection, actor: &Actor, task_id: &str) -> Result<Channel> {
    if let Some(found) = find_channel(tx, "task_id", task_id)? {
        return Ok(found);
    }
    let task = get_task(tx, task_id)?;
    let id = new_id("tc");
    tx.execute(
        "INSERT INTO channel (id, workspace_id, kind, task_id, created_by, created_at) VALUES (?1, ?2, 'task', ?3, ?4, ?5)",
        params![id, task.workspace_id, task.id, actor.buddy_id(), now_iso()],
    )?;
    get_channel(tx, &id)
}

/// What a new post asks of the channel. Only a direct channel has members to owe an answer.
enum Ask {
    Inform,
    Request { owed_by: Actor },
}

/// A direct channel is one-to-one: the author and at most one other member (none for a note to
/// self). Owner decision 2026-10-06 (agent_notes/2026-10-06_dm-is-one-to-one-decision.md): a group
/// conversation is a public channel, so a request has exactly one possible owner and needs no
/// mention rule. Existing multi-member DMs stay readable; only a NEW post is refused. Pattern: sum
/// types (docs/patterns.md#sum-types), the channel kind decides, `ask` never branches on member count.
fn counterpart(members: &[Actor], author: &Actor) -> Result<Actor> {
    require_pair(members)?;
    let others: Vec<&Actor> = members.iter().filter(|m| *m != author).collect();
    match others.as_slice() {
        // A channel with only the author in it is a note to self: the author owes the answer.
        [] => Ok(author.clone()),
        [one] => Ok((*one).clone()),
        // Two members, neither the author: the owner (a non-member) asking inside a Buddy-to-Buddy DM.
        _ => Err(CoreError::Invalid("a request needs a recipient: send it from inside a direct message you are in".into())),
    }
}

/// The shape rule, for every post and for creation: at most two members.
fn require_pair(members: &[Actor]) -> Result<()> {
    match members.len() {
        0..=2 => Ok(()),
        n => Err(CoreError::Invalid(format!(
            "a direct message is one-to-one but this one has {n} members: post in a public channel, or send one direct message per recipient"
        ))),
    }
}

/// Refuses a post into a group DM, request or inform alike.
fn require_one_to_one(channel: &Channel) -> Result<()> {
    match &channel.kind {
        ChannelKind::Direct { members } => require_pair(members),
        ChannelKind::Public { .. } | ChannelKind::Task { .. } => Ok(()),
    }
}

fn ask(kind: PostKind, channel: &Channel, author: &Actor) -> Result<Ask> {
    match (kind, &channel.kind) {
        (PostKind::Inform, _) => Ok(Ask::Inform),
        (PostKind::Request, ChannelKind::Direct { members }) => Ok(Ask::Request { owed_by: counterpart(members, author)? }),
        (PostKind::Request, other) => Err(CoreError::Invalid(format!("a request needs a direct channel, got {other:?}"))),
    }
}

impl Ask {
    fn column(&self) -> Option<&'static str> {
        match self {
            Ask::Inform => None,
            Ask::Request { .. } => Some("awaiting"),
        }
    }
    fn owed_by(&self) -> &[Actor] {
        match self {
            Ask::Inform => &[],
            Ask::Request { owed_by } => std::slice::from_ref(owed_by),
        }
    }
}

impl Store {
    pub fn post(&mut self, actor: &Actor, channel: ChannelRef, input: PostInput) -> Result<Post> {
        self.write_post(actor, channel, input).map(|written| written.post)
    }

    /// `post`, saying whether it wrote the post or replayed its key. The host announces only a
    /// created post: a replayed key used to re-run its @mentions and follow-up gates (2026-09-28
    /// review R2, agent_notes/2026-09-28_channels-state-machine-review.md).
    pub fn write_post(&mut self, actor: &Actor, channel: ChannelRef, input: PostInput) -> Result<PostWrite> {
        self.write(|tx| {
            let channel = open_channel(tx, actor, &channel)?;
            require(tx, actor, Op::Post, &Subject::Channel { id: channel.id.clone() })?;
            require_one_to_one(&channel)?;
            let task_id = task_id_for_channel(&channel, input.task_id.as_deref())?;
            let m = Mutation {
                actor,
                workspace_id: &channel.workspace_id,
                buddy_id: actor.buddy_id(),
                task_id: task_id.as_deref(),
                op: "post",
                payload: json!({"channel": channel.id, "kind": input.kind.as_str(), "body": input.body, "purpose": input.purpose,
                    "evidence": input.evidence, "reply_to": input.reply_to_id, "task": task_id,
                    "run_config": input.run_config}),
                key: Some(&input.key),
            };
            let (id, created) = idempotent_write(tx, &m, |tx| insert_post(tx, actor, &channel, &input, task_id.as_deref()))?;
            Ok(PostWrite { post: get_post(tx, &id)?, created })
        })
    }

    /// Answers a request: the answer post, the request's flip to answered and the delivery to the
    /// asker's subscribed conversation commit together or not at all.
    pub fn answer(&mut self, actor: &Actor, input: AnswerInput) -> Result<Post> {
        self.write(|tx| {
            let request = get_post(tx, &input.request_id)?;
            let workspace_id = get_channel(tx, &request.channel_id)?.workspace_id;
            require(tx, actor, Op::Post, &Subject::Channel { id: request.channel_id.clone() })?;
            let m = Mutation {
                actor,
                workspace_id: &workspace_id,
                buddy_id: actor.buddy_id(),
                task_id: request.task_id.as_deref(),
                op: "answer",
                payload: json!({"request": request.id, "body": input.body, "evidence": input.evidence}),
                key: Some(&input.key),
            };
            let id = idempotent(tx, &m, |tx| {
                // Insert, then flip only an awaiting request. A request that is no longer awaiting fails
                // the flip, and the error rolls the answer back with the transaction: one answer each.
                let ord = crate::ids::next().to_string();
                let id = format!("post_{ord}");
                let root = request.root_id.clone().unwrap_or(request.id.clone());
                tx.execute(
                    "INSERT INTO post (id, channel_id, author_id, root_id, reply_to_id, task_id, body, evidence, conversation_id, created_at, ord)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        id,
                        request.channel_id,
                        actor.buddy_id(),
                        root,
                        request.id,
                        request.task_id,
                        input.body,
                        evidence_json(&input.evidence),
                        input.from_conversation_id,
                        now_iso(),
                        ord
                    ],
                )?;
                let flipped = tx.execute(
                    "UPDATE post SET request = 'answered', answer_id = ?2 WHERE id = ?1 AND request = 'awaiting'",
                    params![request.id, id],
                )?;
                if flipped != 1 {
                    return Err(CoreError::Invalid(format!("post {} is not awaiting an answer: {:?}", request.id, request.request)));
                }
                // A request lives in a direct channel, so answering subscribes like any DM post.
                let channel = get_channel(tx, &request.channel_id)?;
                let answer = get_post(tx, &id)?;
                let own = request.author == *actor;
                after_write(tx, actor, &channel, &answer, input.from_conversation_id.as_deref(), &[], own)?;
                // A Buddy answering a request it sent itself (its worker): the fan-out never
                // delivers a Buddy's own post to it, so its spawner is told here.
                if let (Actor::Buddy { id: answerer }, true) = (actor, own) {
                    crate::deliveries::deliver_to_spawner(tx, answerer, &answer)?;
                }
                Ok(id)
            })?;
            get_post(tx, &id)
        })
    }

    pub fn get_post(&self, actor: &Actor, id: &str) -> Result<Post> {
        let post = get_post(&self.conn, id)?;
        require(&self.conn, actor, Op::ReadChannel, &Subject::Channel { id: post.channel_id.clone() })?;
        Ok(post)
    }

    /// Finds (or, for a direct or task channel, creates) the channel a ref names.
    pub fn open_channel(&mut self, actor: &Actor, channel: ChannelRef) -> Result<Channel> {
        self.write(|tx| {
            let channel = open_channel(tx, actor, &channel)?;
            require(tx, actor, Op::ReadChannel, &Subject::Channel { id: channel.id.clone() })?;
            Ok(channel)
        })
    }

    /// Newest first, keyset-paged on the ordered id (never on `created_at`, which ties).
    pub fn list_posts(&self, actor: &Actor, query: PostQuery, before: Option<Cursor>, limit: i64) -> Result<PostPage> {
        let (filter, mut args) = self.readable_feed(actor, &query)?;
        let keyset = match before {
            None => "",
            Some(Cursor { ord }) => {
                args.push(ord.into());
                " AND p.ord < ?"
            }
        };
        args.push((limit + 1).into());
        let sql = format!("SELECT {POST_COLS} FROM post p WHERE {filter}{keyset} ORDER BY p.ord DESC LIMIT ?");
        Ok(keyset_page(collect(self.conn.prepare_cached(&sql)?.query_map(params_from_iter(args), post_row)?)?, limit))
    }

    /// A permalink's page: `post_id` and every newer post of the feed (at most `limit`, oldest
    /// kept, so the linked post is always on it), newest first. `next` pages on below the post.
    /// A reply link used to open on the newest page alone and missed an older reply (T22).
    pub fn list_posts_from(&self, actor: &Actor, query: PostQuery, post_id: &str, limit: i64) -> Result<PostPage> {
        let (filter, args) = self.readable_feed(actor, &query)?;
        let target = get_post(&self.conn, post_id)?;
        let in_feed = match &query {
            PostQuery::Channel { channel_id } => target.channel_id == *channel_id && (target.root_id.is_none() || target.broadcast),
            PostQuery::Thread { root_id } => target.root_id.as_deref() == Some(root_id.as_str()),
        };
        if !in_feed {
            return Err(CoreError::Invalid(format!("post {post_id} is not in {query:?}")));
        }
        let at = |extra: Vec<Value>| args.iter().cloned().chain(extra).collect::<Vec<Value>>();
        let sql = format!("SELECT {POST_COLS} FROM post p WHERE {filter} AND p.ord >= ? ORDER BY p.ord ASC LIMIT ?");
        let mut posts = collect(
            self.conn.prepare_cached(&sql)?.query_map(params_from_iter(at(vec![target.ord.clone().into(), limit.into()])), post_row)?,
        )?;
        posts.reverse();
        let older = format!("SELECT p.ord FROM post p WHERE {filter} AND p.ord < ? ORDER BY p.ord DESC LIMIT 1");
        let next = self
            .conn
            .prepare_cached(&older)?
            .query_row(params_from_iter(at(vec![target.ord.clone().into()])), |r| r.get::<_, String>(0))
            .optional()?
            .map(|_| Cursor { ord: target.ord.clone() });
        Ok(PostPage { posts, next })
    }

    /// The SQL filter of a feed, once the actor may read its channel.
    fn readable_feed(&self, actor: &Actor, query: &PostQuery) -> Result<(String, Vec<Value>)> {
        let (channel_id, filter, args): (String, String, Vec<Value>) = match query {
            PostQuery::Channel { channel_id } => {
                (channel_id.clone(), format!("p.channel_id = ? AND {IN_CHANNEL_FEED}"), vec![channel_id.clone().into()])
            }
            PostQuery::Thread { root_id } => (get_post(&self.conn, root_id)?.channel_id, "p.root_id = ?".into(), vec![root_id.clone().into()]),
        };
        require(&self.conn, actor, Op::ReadChannel, &Subject::Channel { id: channel_id })?;
        Ok((filter, args))
    }

    /// Reply count and newest reply of each of `root_ids` that has replies, in one channel.
    pub fn thread_stats(&self, actor: &Actor, channel_id: &str, root_ids: &[String]) -> Result<Vec<ThreadStat>> {
        require(&self.conn, actor, Op::ReadChannel, &Subject::Channel { id: channel_id.to_string() })?;
        if root_ids.is_empty() {
            return Ok(vec![]);
        }
        let marks = vec!["?"; root_ids.len()].join(", ");
        // The newest reply per root by `max(ord)` on post_root, then that row by its unique ord.
        let sql = format!(
            "SELECT l.root_id, (SELECT count(*) FROM post c WHERE c.root_id = l.root_id), l.ord, l.created_at, l.author_id
             FROM post l
             WHERE l.ord IN (SELECT max(r.ord) FROM post r WHERE r.root_id IN ({marks}) GROUP BY r.root_id) AND l.channel_id = ?"
        );
        let args = root_ids.iter().map(|id| Value::from(id.clone())).chain([Value::from(channel_id.to_string())]);
        collect(self.conn.prepare(&sql)?.query_map(params_from_iter(args), |r| {
            Ok(ThreadStat {
                root_id: r.get(0)?,
                replies: r.get(1)?,
                last_reply_ord: r.get(2)?,
                last_reply_at: r.get(3)?,
                last_reply_author: Actor::from_nullable(r.get(4)?),
            })
        })?)
    }

    /// Every post about `task_id` (its `task_id`), in any channel the actor may read, newest first:
    /// the channel browser's Task filter.
    pub fn task_posts(&self, actor: &Actor, task_id: &str, before: Option<Cursor>, limit: i64) -> Result<PostPage> {
        require(&self.conn, actor, Op::SearchPosts, &Subject::Owner)?;
        get_task(&self.conn, task_id)?;
        let mut args: Vec<Value> = vec![task_id.to_string().into(), actor.key().to_string().into()];
        let keyset = match before {
            None => "",
            Some(Cursor { ord }) => {
                args.push(ord.into());
                " AND p.ord < ?3"
            }
        };
        args.push((limit + 1).into());
        let sql = format!(
            "SELECT {POST_COLS} FROM post p JOIN channel c ON c.id = p.channel_id
             WHERE p.task_id = ?1{keyset} AND {} ORDER BY p.ord DESC LIMIT ?{}",
            readable_by("?2"),
            args.len()
        );
        Ok(keyset_page(collect(self.conn.prepare_cached(&sql)?.query_map(params_from_iter(args), post_row)?)?, limit))
    }

    /// Requests the actor owes (across workspaces), its own open requests in `workspace_id`, and its channels in
    /// `workspace_id` with unread counts.
    pub fn inbox(&self, actor: &Actor, workspace_id: &str) -> Result<Inbox> {
        let (me, my_buddy) = (actor.key(), actor.buddy_id());
        let requests = collect(
            self.conn
                .prepare_cached(&format!(
                    "SELECT {POST_COLS} FROM channel_member m JOIN channel c ON c.id = m.channel_id
                       JOIN post p ON p.channel_id = m.channel_id AND p.request = 'awaiting'
                     WHERE m.member = ?1 AND (p.author_id IS NOT ?2 OR c.member_key = ?1) ORDER BY p.ord"
                ))?
                .query_map(params![me, my_buddy], post_row)?,
        )?;
        // Fix-guard: scoped to the turn's workspace like `channels` and `unread_threads`; it was
        // buddy-wide, so another workspace's open requests leaked into this inbox (2026-10-06).
        // Guard: `inbox_waiting_on_is_scoped_to_the_workspace`.
        let waiting_on = collect(
            self.conn
                .prepare_cached(&format!(
                    "SELECT {POST_COLS} FROM post p JOIN channel c ON c.id = p.channel_id
                     WHERE p.author_id IS ?1 AND p.request = 'awaiting' AND c.workspace_id = ?2 ORDER BY p.ord"
                ))?
                .query_map(params![my_buddy, workspace_id], post_row)?,
        )?;
        let channels = collect(
            self.conn
                .prepare_cached(&format!(
                    "SELECT {CHANNEL_COLS}, (SELECT count(*) FROM post p WHERE p.channel_id = c.id AND p.author_id IS NOT ?3
                        AND {IN_CHANNEL_FEED} AND p.ord > coalesce(r.last_ord, '')), r.last_ord
                     FROM channel c LEFT JOIN post_read r ON r.reader = ?1 AND r.channel_id = c.id
                     WHERE c.workspace_id = ?2 AND c.archived_at IS NULL AND (c.kind = 'public' OR r.reader IS NOT NULL
                       OR EXISTS (SELECT 1 FROM channel_member m WHERE m.member = ?1 AND m.channel_id = c.id))
                     ORDER BY c.kind, c.name, c.created_at"
                ))?
                .query_map(params![me, workspace_id, my_buddy], |r| {
                    Ok(ChannelUnread { channel: channel_row(r)?, unread: r.get(10)?, last_read_ord: r.get(11)? })
                })?,
        )?;
        let unread_threads = self.conn.prepare_cached(&format!(
            "SELECT count(*) FROM thread_read t JOIN post root ON root.id = t.root_id JOIN channel c ON c.id = root.channel_id
             WHERE t.reader = ?1 AND c.workspace_id = ?2 AND {}
               AND EXISTS (SELECT 1 FROM post r WHERE r.root_id = t.root_id AND r.ord > t.last_ord AND r.author_id IS NOT ?3)",
            readable_by("?1")
        ))?
        .query_row(params![me, workspace_id, my_buddy], |r| r.get(0))?;
        Ok(Inbox { requests, waiting_on, channels, unread_threads })
    }

    /// Posts in `workspace_id` matching the structured `query` (grammar: `search.rs`), newest
    /// first, from the channels the actor may read: public and task channels, and the direct
    /// channels it is a member of (the owner reads every one). Every filter is a WHERE clause next
    /// to the readability rule, so filters narrow BEFORE the keyset page and never widen access.
    /// Pages older with `before` (keyset on `ord`, like `task_posts`); until 2026-09-27 search took
    /// no cursor, so the MCP `before` was silently ignored and a Buddy could never see past the
    /// newest `limit` hits.
    ///
    /// Typo matching is a fallback, decided once per query and not per page: a query whose exact,
    /// prefix and stem form finds nothing (ignoring the page cursor) is re-run with one-edit typo
    /// terms. Mixed in always, typos of "market" (`marker`, `marked`) buried the real hits, and a
    /// typo hit never outranks an exact one because the two never share a result list.
    pub fn search_posts(&self, actor: &Actor, workspace_id: &str, query: &SearchQuery, before: Option<Cursor>, limit: i64) -> Result<PostPage> {
        require(&self.conn, actor, Op::SearchPosts, &Subject::Owner)?;
        let exact = crate::search::parse(&query.text, &|_| Ok(vec![]))?;
        let parsed = match exact.fts.is_some() && self.search_with(actor, workspace_id, query, &exact, None, 1)?.posts.is_empty() {
            true => crate::search::parse(&query.text, &|word| self.similar_terms(word))?,
            false => exact,
        };
        self.search_with(actor, workspace_id, query, &parsed, before, limit)
    }

    /// One run of a parsed search: the match expression, the filters and the readability rule.
    fn search_with(&self, actor: &Actor, workspace_id: &str, query: &SearchQuery, parsed: &crate::search::Parsed, before: Option<Cursor>, limit: i64) -> Result<PostPage> {
        let mut args: Vec<Value> = vec![workspace_id.to_string().into(), actor.key().to_string().into()];
        let mut clauses = String::new();
        fn bind(args: &mut Vec<Value>, v: Value) -> String {
            args.push(v);
            format!("?{}", args.len())
        }
        // `@Name` in the text is a `from` filter on top of the explicit ones (any of them may match).
        let mut from = query.from.clone();
        for name in &parsed.authors {
            from.extend(self.author_keys(workspace_id, name)?);
        }
        let from_sql = match &parsed.fts {
            Some(fts) => {
                clauses += &format!(" AND post_search MATCH {}", bind(&mut args, fts.clone().into()));
                "post_search s JOIN post p ON p.rowid = s.rowid"
            }
            // Only authors, no words: that author's posts, newest first, no FTS involved.
            None => "post p",
        };
        if let Some(Cursor { ord }) = before {
            clauses += &format!(" AND p.ord < {}", bind(&mut args, ord.into()));
        }
        if !query.channels.is_empty() {
            let slots = query.channels.iter().map(|c| {
                let (id, name) = (bind(&mut args, c.clone().into()), bind(&mut args, c.trim_start_matches('#').to_string().into()));
                format!("c.id = {id} OR c.name = {name}")
            });
            clauses += &format!(" AND ({})", slots.collect::<Vec<_>>().join(" OR "));
        }
        if !from.is_empty() {
            let slots = from.iter().map(|who| match who.as_str() {
                OWNER_KEY => "p.author_id IS NULL".to_string(),
                id => format!("p.author_id = {}", bind(&mut args, id.to_string().into())),
            });
            clauses += &format!(" AND ({})", slots.collect::<Vec<_>>().join(" OR "));
        }
        if let Some(after) = &query.after {
            clauses += &format!(" AND p.created_at >= {}", bind(&mut args, search_instant("after", after)?.into()));
        }
        if let Some(until) = &query.before {
            clauses += &format!(" AND p.created_at < {}", bind(&mut args, search_instant("before", until)?.into()));
        }
        if let Some(root) = &query.in_thread {
            let slot = bind(&mut args, root.clone().into());
            clauses += &format!(" AND (p.id = {slot} OR p.root_id = {slot})");
        }
        args.push((limit + 1).into());
        let sql = format!(
            "SELECT {POST_COLS} FROM {from_sql} JOIN channel c ON c.id = p.channel_id
             WHERE c.workspace_id = ?1{clauses} AND {} ORDER BY p.ord DESC LIMIT ?{}",
            readable_by("?2"),
            args.len()
        );
        Ok(keyset_page(collect(self.conn.prepare_cached(&sql)?.query_map(params_from_iter(args), post_row)?)?, limit))
    }

    /// The `from` keys of the Buddies in `workspace_id` called `name` (or slugged it), or the owner
    /// for `owner`. An unknown name is an error the caller shows ("no Buddy named …"), never an
    /// empty result that reads as "this person never said it".
    fn author_keys(&self, workspace_id: &str, name: &str) -> Result<Vec<String>> {
        if name.eq_ignore_ascii_case(OWNER_KEY) {
            return Ok(vec![OWNER_KEY.to_string()]);
        }
        let ids = collect(
            self.conn
                .prepare_cached("SELECT id FROM buddy WHERE workspace_id = ?1 AND (lower(name) = lower(?2) OR lower(slug) = lower(?2))")?
                .query_map(params![workspace_id, name], |r| r.get::<_, String>(0))?,
        )?;
        match ids.is_empty() {
            true => Err(CoreError::Invalid(format!("no Buddy named \"{name}\""))),
            false => Ok(ids),
        }
    }

    /// Index terms one typo from `word` (lowercase, 5+ letters), most-used first, capped. Reads the
    /// `post_search_vocab` view of the FTS index, so it sees stems and only words that exist.
    /// The first letter is taken as typed: the vocabulary is read by term range, so the scan is one
    /// letter's terms instead of every word ever posted (a typo rarely lands on the first letter).
    fn similar_terms(&self, word: &str) -> Result<Vec<String>> {
        let word: Vec<char> = word.chars().collect();
        let first = word[0];
        let after = char::from_u32(first as u32 + 1).unwrap_or(first);
        let range = (first.to_string(), after.to_string());
        let vocab = collect(
            self.conn
                .prepare_cached("SELECT term, doc FROM post_search_vocab WHERE term >= ?1 AND term < ?2")?
                .query_map([range.0, range.1], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?,
        )?;
        let mut terms: Vec<_> = vocab.into_iter().filter(|(t, _)| crate::search::is_typo_of(&word, &t.chars().collect::<Vec<_>>())).collect();
        terms.sort_by(|a, b| b.1.cmp(&a.1));
        Ok(terms.into_iter().take(crate::search::TYPO_MAX_TERMS).map(|(t, _)| t).collect())
    }

    /// Moves the actor's cursor forward to `post_id`; an older post never moves it back.
    pub fn mark_read(&mut self, actor: &Actor, channel_id: &str, post_id: &str) -> Result<()> {
        self.write(|tx| {
            require(tx, actor, Op::ReadChannel, &Subject::Channel { id: channel_id.to_string() })?;
            let post = get_post(tx, post_id)?;
            if post.channel_id != channel_id {
                return Err(CoreError::Invalid(format!("post {post_id} is not in channel {channel_id}")));
            }
            tx.execute(
                "INSERT INTO post_read (reader, channel_id, last_post_id, last_post_at, last_ord, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(reader, channel_id) DO UPDATE SET last_post_id = excluded.last_post_id,
                   last_post_at = excluded.last_post_at, last_ord = excluded.last_ord, updated_at = excluded.updated_at
                 WHERE excluded.last_ord > post_read.last_ord",
                params![actor.key(), channel_id, post.id, post.created_at, post.ord, now_iso()],
            )?;
            Ok(())
        })
    }

    /// The Threads view: threads with replies that the actor follows in `workspace_id`, unread
    /// first, then by newest post. Each card carries its fold and tail (`ThreadTail`), so no client
    /// decides which replies to show.
    pub fn followed_threads(&self, actor: &Actor, workspace_id: &str, limit: i64) -> Result<FollowedThreads> {
        let (me, my_buddy) = (actor.key(), actor.buddy_id());
        let sql = format!(
            "SELECT t.root_id, t.last_ord,
                    (SELECT count(*) FROM post r WHERE r.root_id = t.root_id) AS replies,
                    (SELECT count(*) FROM post r WHERE r.root_id = t.root_id AND r.ord > t.last_ord AND r.author_id IS NOT ?3) AS unread,
                    (SELECT max(r.ord) FROM post r WHERE r.root_id = t.root_id) AS latest
             FROM thread_read t JOIN post root ON root.id = t.root_id JOIN channel c ON c.id = root.channel_id
             WHERE t.reader = ?1 AND c.workspace_id = ?2 AND {} AND latest IS NOT NULL
             ORDER BY unread > 0 DESC, latest DESC LIMIT ?4",
            readable_by("?1")
        );
        let rows = collect(
            self.conn
                .prepare_cached(&sql)?
                .query_map(params![me, workspace_id, my_buddy, limit + 1], |r| Ok((r.get::<_, String>(0)?, r.get(2)?, r.get(3)?)))?,
        )?;
        let more = rows.len() as i64 > limit;
        let threads = rows
            .into_iter()
            .take(limit as usize)
            .map(|(root_id, replies, unread): (String, i64, i64)| self.followed_thread(&root_id, replies, unread))
            .collect::<Result<Vec<_>>>()?;
        Ok(FollowedThreads { threads, more })
    }

    fn followed_thread(&self, root_id: &str, replies: i64, unread: i64) -> Result<FollowedThread> {
        let root = get_post(&self.conn, root_id)?;
        let channel = get_channel(&self.conn, &root.channel_id)?;
        let shown = match unread > 0 {
            true => unread.min(20),
            false => replies.min(2),
        };
        let mut posts = collect(
            self.conn
                .prepare_cached(&format!("SELECT {POST_COLS} FROM post p WHERE p.root_id = ?1 ORDER BY p.ord DESC LIMIT ?2"))?
                .query_map(params![root_id, shown], post_row)?,
        )?;
        posts.reverse();
        let hidden = replies - posts.len() as i64;
        let participants = collect(
            self.conn
                .prepare_cached("SELECT author_id FROM post WHERE id = ?1 OR root_id = ?1 GROUP BY author_id ORDER BY min(ord)")?
                .query_map([root_id], |r| Ok(Actor::from_nullable(r.get(0)?)))?,
        )?;
        let tail = match unread > 0 {
            true => ThreadTail::Unread { hidden, posts },
            false => ThreadTail::CaughtUp { hidden, posts },
        };
        Ok(FollowedThread { channel, root, replies, participants, tail })
    }

    /// Moves the actor's cursor in a thread it follows forward to `post_id` (the root or a reply).
    /// Never creates a row: reading a thread is not following it. A Buddy's read fences the
    /// deliveries it covers (deliveries.rs `fence`).
    pub fn mark_thread_read(&mut self, actor: &Actor, root_id: &str, post_id: &str) -> Result<()> {
        self.write(|tx| {
            let post = get_post(tx, post_id)?;
            if post.id != root_id && post.root_id.as_deref() != Some(root_id) {
                return Err(CoreError::Invalid(format!("post {post_id} is not in thread {root_id}")));
            }
            require(tx, actor, Op::ReadChannel, &Subject::Channel { id: post.channel_id.clone() })?;
            let moved = tx.execute(
                "UPDATE thread_read SET last_ord = ?3, updated_at = ?4 WHERE reader = ?1 AND root_id = ?2 AND last_ord < ?3",
                params![actor.key(), root_id, post.ord, now_iso()],
            )?;
            match (moved, actor) {
                (1, Actor::Buddy { id }) => crate::deliveries::fence(tx, id, root_id, &post.ord),
                _ => Ok(()),
            }
        })
    }

    /// Archived public channels remain explicitly readable, outside the inbox/unread totals.
    pub fn archived_channels(&self, actor: &Actor, workspace_id: &str) -> Result<Vec<Channel>> {
        require(&self.conn, actor, Op::SearchPosts, &Subject::Owner)?;
        if let Some(id) = actor.buddy_id() {
            if get_buddy(&self.conn, id)?.workspace_id != workspace_id {
                return Err(CoreError::Denied("channels outside workspace".into()));
            }
        }
        collect(self.conn.prepare_cached(&format!("SELECT {CHANNEL_COLS} FROM channel c WHERE c.workspace_id = ?1 AND c.kind = 'public' AND c.archived_at IS NOT NULL ORDER BY c.name"))?.query_map([workspace_id], channel_row)?)
    }

    pub fn set_channel_archived(&mut self, actor: &Actor, channel_id: &str, archived: bool, key: &str) -> Result<Channel> {
        self.write(|tx| {
            let channel = get_channel(tx, channel_id)?;
            require(tx, actor, Op::ArchiveChannel, &Subject::Channel { id: channel.id.clone() })?;
            if !matches!(channel.kind, ChannelKind::Public { .. }) {
                return Err(CoreError::Invalid("only public channels may be archived".into()));
            }
            let m = Mutation { actor, workspace_id: &channel.workspace_id, buddy_id: actor.buddy_id(), task_id: None,
                op: "channel.archive", payload: json!({"channel": channel_id, "archived": archived}), key: Some(key) };
            let id = idempotent(tx, &m, |tx| {
                let timestamp = if archived { channel.archived_at.clone().or_else(|| Some(now_iso())) } else { None };
                tx.execute("UPDATE channel SET archived_at = ?2 WHERE id = ?1", params![channel_id, timestamp])?;
                Ok(channel_id.to_string())
            })?;
            get_channel(tx, &id)
        })
    }

    pub fn rename_channel(&mut self, actor: &Actor, channel_id: &str, name: &str, key: &str) -> Result<Channel> {
        self.write(|tx| {
            let channel = get_channel(tx, channel_id)?;
            require(tx, actor, Op::RenameChannel, &Subject::Channel { id: channel.id.clone() })?;
            if !matches!(channel.kind, ChannelKind::Public { .. }) {
                return Err(CoreError::Invalid("only public channels may be renamed".into()));
            }
            let m = Mutation {
                actor,
                workspace_id: &channel.workspace_id,
                buddy_id: actor.buddy_id(),
                task_id: None,
                op: "channel.rename",
                payload: json!({"channel": channel_id, "name": name}),
                key: Some(key),
            };
            let id = idempotent(tx, &m, |tx| {
                tx.execute("UPDATE channel SET name = ?2 WHERE id = ?1", params![channel_id, name])?;
                Ok(channel_id.to_string())
            })?;
            get_channel(tx, &id)
        })
    }

    pub fn create_channel(&mut self, actor: &Actor, input: ChannelInput) -> Result<Channel> {
        self.write(|tx| {
            require(tx, actor, Op::CreateChannel, &Subject::Owner)?;
            let m = Mutation {
                actor,
                workspace_id: &input.workspace_id,
                buddy_id: actor.buddy_id(),
                task_id: None,
                op: "channel.create",
                payload: json!({"name": input.name, "purpose": input.purpose}),
                key: Some(&input.key),
            };
            let id = idempotent(tx, &m, |tx| {
                let id = new_id("list");
                tx.execute(
                    "INSERT INTO channel (id, workspace_id, kind, name, purpose, created_by, created_at) VALUES (?1, ?2, 'public', ?3, ?4, ?5, ?6)",
                    params![id, input.workspace_id, input.name, input.purpose, actor.buddy_id(), now_iso()],
                )?;
                Ok(id)
            })?;
            get_channel(tx, &id)
        })
    }
}

// Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
// Task-channel posts used to keep the MCP caller's optional task_id (usually absent), so the task
// feed could not see them. The channel is the authoritative task identity at this boundary.
fn task_id_for_channel(channel: &Channel, explicit: Option<&str>) -> Result<Option<String>> {
    match &channel.kind {
        ChannelKind::Task { task_id } => {
            if explicit.is_some_and(|id| id != task_id) {
                return Err(CoreError::Invalid(format!(
                    "post task_id does not match task channel {task_id}"
                )));
            }
            Ok(Some(task_id.clone()))
        }
        _ => Ok(explicit.map(str::to_owned)),
    }
}

fn insert_post(
    tx: &Transaction,
    actor: &Actor,
    channel: &Channel,
    input: &PostInput,
    task_id: Option<&str>,
) -> Result<String> {
    if channel.archived_at.is_some() {
        return Err(CoreError::Invalid("channel is archived; restore it before posting".into()));
    }
    let ask = ask(input.kind, channel, actor)?;
    if let Some(config) = &input.run_config {
        require_worker_authority(tx, actor, &ask, config)?;
    }
    let root_id = input.reply_to_id.as_deref().map(|parent| thread_root(tx, parent, &channel.id)).transpose()?;
    if input.broadcast && root_id.is_none() {
        return Err(CoreError::Invalid("only a reply can also be sent to the channel".into()));
    }
    let ord = crate::ids::next().to_string();
    let id = format!("post_{ord}");
    tx.prepare_cached(
        "INSERT INTO post (id, channel_id, author_id, root_id, reply_to_id, task_id, purpose, body, evidence, request,
           conversation_id, created_at, ord, broadcast)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
    )?
    .execute(params![
        id,
        channel.id,
        actor.buddy_id(),
        root_id,
        input.reply_to_id,
        task_id,
        input.purpose,
        input.body,
        evidence_json(&input.evidence),
        ask.column(),
        // Provenance: the conversation the post was written from. A thread seat reads it to skip
        // its own posts; in a DM it is also where later posts by others are delivered.
        input.from_conversation_id,
        now_iso(),
        ord,
        input.broadcast
    ])?;
    let owed: Vec<String> = ask.owed_by().iter().filter_map(Actor::buddy_id).map(str::to_owned).collect();
    let skip: Vec<String> = owed.iter().chain(&input.mentions).cloned().collect();
    after_write(tx, actor, channel, &get_post(tx, &id)?, input.from_conversation_id.as_deref(), &skip, false)?;
    for recipient in &owed {
        tx.enqueue(EnqueueInput {
            buddy_id: recipient.to_string(),
            input: RunInput::Post { post_id: id.clone() },
            conversation_id: None,
            task_id: task_id.map(str::to_owned),
            after_run_id: None,
            deadline: None,
            config: input.run_config.clone(),
        })?;
    }
    Ok(id)
}

/// A worker: a request whose recipients' runs execute with `config`, not their profile. Only a
/// recipient the author may enqueue runs for (itself, a report) takes it, so no buddy can move a
/// peer or its manager off the model the owner picked. An inform starts no run to configure.
fn require_worker_authority(tx: &Transaction, actor: &Actor, ask: &Ask, config: &RunConfig) -> Result<()> {
    match ask {
        Ask::Inform => Err(CoreError::Invalid(format!("a run config needs a request; got one on an inform: {config:?}"))),
        Ask::Request { owed_by } => match owed_by {
            Actor::Owner => Err(CoreError::Invalid("the owner runs no worker; a run config needs buddy recipients".into())),
            Actor::Buddy { id } => require(tx, actor, Op::EnqueueRun, &Subject::Buddy { id: id.clone() }),
        },
    }
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/// What every written post does to the delivery state, in the post's own transaction:
/// 1. the author has read the thread through its post, unless that would skip a post it was never
///    shown (decision K, deliveries.rs `catch_up`);
/// 2. a Buddy posting from a conversation in a direct channel SUBSCRIBES that conversation to the
///    thread (rule 1; the last writer wins, decision F). This replaced the request's stored return
///    route (`Returns`, `post.return_conversation_id`): an answer reaches the conversation that
///    asked because that conversation posted the request, and so does any later post there.
///    Public and task threads subscribe only by `follow` until step 5: their replies still run on
///    the host's seat machine (mentions, the follow-up gate), and a seat that subscribed by
///    posting would be woken by both (task_01a11013-b205 moves seats onto delivery);
/// 3. every other subscribed Buddy gets a delivery (`fan_out`), except `skip`.
/// A Buddy's self-spawned worker writing in its request's thread does neither 1 nor 2: the thread's
/// subscription and mark are its spawner's (deliveries.rs `from_own_worker`).
fn after_write(tx: &Transaction, actor: &Actor, channel: &Channel, post: &Post, from: Option<&str>, skip: &[String], spawner_owns: bool) -> Result<()> {
    let root = post.root_id.as_deref().unwrap_or(&post.id);
    if !spawner_owns && !crate::deliveries::from_own_worker(tx, actor, post, from)? {
        crate::deliveries::catch_up(tx, actor, root, &post.ord)?;
        if let (Actor::Buddy { id }, Some(conversation), ChannelKind::Direct { .. }) = (actor, from, &channel.kind) {
            crate::deliveries::subscribe(tx, id, root, Some(conversation))?;
        }
    }
    crate::deliveries::fan_out(tx, post, skip)
}

/// A post the system writes for a Buddy: a failed request's `run_failed` notice, a schedule
/// fire. The Buddy did not write it in a turn, so its read mark and subscriptions stay as they
/// were (its own mark moving past the post would fence the post's own delivery). Delivered to
/// every subscriber but the author, like any post.
pub(crate) fn system_post(tx: &Transaction, author: &str, channel: &Channel, reply_to: Option<&Post>, purpose: &str, body: &str) -> Result<Post> {
    let ord = crate::ids::next().to_string();
    let id = format!("post_{ord}");
    let root = reply_to.map(|p| p.root_id.clone().unwrap_or(p.id.clone()));
    let task_id = match &channel.kind {
        ChannelKind::Task { task_id } => Some(task_id.clone()),
        ChannelKind::Public { .. } | ChannelKind::Direct { .. } => reply_to.and_then(|p| p.task_id.clone()),
    };
    tx.prepare_cached(
        "INSERT INTO post (id, channel_id, author_id, root_id, reply_to_id, task_id, purpose, body, created_at, ord)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?
    .execute(params![id, channel.id, author, root, reply_to.map(|p| &p.id), task_id, purpose, body, now_iso(), ord])?;
    let post = get_post(tx, &id)?;
    crate::deliveries::fan_out(tx, &post, &[])?;
    Ok(post)
}

/// The direct channel a Buddy talks to itself in (its own DM, `member_key` = its id).
pub(crate) fn own_channel(tx: &Transaction, buddy_id: &str) -> Result<Channel> {
    let me = Actor::Buddy { id: buddy_id.to_string() };
    direct_channel(tx, &me, std::slice::from_ref(&me))
}

/// A reply joins its parent's thread, which must be in the same channel.
fn thread_root(tx: &Transaction, parent_id: &str, channel_id: &str) -> Result<String> {
    let parent = get_post(tx, parent_id)?;
    match parent.channel_id == channel_id {
        true => Ok(parent.root_id.unwrap_or(parent.id)),
        false => Err(CoreError::Invalid(format!("post {parent_id} is in another channel"))),
    }
}
