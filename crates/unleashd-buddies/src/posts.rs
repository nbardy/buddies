//! Posts: every message, channel post and task comment is a post in a channel (DESIGN B.2; owner
//! decision T06b: "direct messages between two buddies or messages to a channel … the same table
//! and the same data type"). A channel is public, direct (a member set) or a task's.
//!
//! A `Request` lives in a direct channel. The other members owe the answer, and each buddy among
//! them gets a `Post` run. The answer is an ordinary post (`reply_to_id` = the request, in its
//! thread). `answer` inserts it, flips the request to answered and queues the `Reply` run back to
//! Pattern: one-write-path (docs/patterns.md#one-write-path)
//! a buddy author, all in one transaction.

use crate::error::{CoreError, Result};
use crate::runs::Enqueue;
use crate::store::{Mutation, Store, collect, corrupt, get_buddy, idempotent, idempotent_write, new_id, now_iso, require};
use crate::tasks::get_task;
use crate::types::*;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params, params_from_iter};
use serde_json::json;

const POST_COLS: &str = "p.id, p.channel_id, p.author_id, p.root_id, p.reply_to_id, p.task_id, p.purpose, p.body, p.evidence, \
    p.request, p.answer_id, p.conversation_id, p.return_conversation_id, p.created_at, p.ord, p.broadcast";

/// The channels `actor_param` (an actor key) may read: the owner every one, a buddy the public and
/// task channels and the direct channels it is a member of. `c` is the channel.
fn readable_by(actor_param: &str) -> String {
    format!(
        "({actor_param} = 'owner' OR c.kind != 'direct'
          OR EXISTS (SELECT 1 FROM channel_member m WHERE m.channel_id = c.id AND m.member = {actor_param}))"
    )
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

fn post_row(r: &Row) -> rusqlite::Result<Post> {
    let request = match (r.get::<_, Option<String>>(9)?.as_deref(), r.get::<_, Option<String>>(10)?) {
        (None, None) => RequestState::None,
        (Some("awaiting"), None) => RequestState::Awaiting,
        (Some("answered"), Some(answer_id)) => RequestState::Answered { answer_id },
        (Some("cancelled"), None) => RequestState::Cancelled,
        (Some("failed"), None) => RequestState::Failed,
        (state, answer) => return Err(corrupt(CoreError::Corrupt(format!("request {state:?} with answer {answer:?}")))),
    };
    let returns = returns_of(&request, r.get(12)?);
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
        returns,
        created_at: r.get(13)?,
        ord: r.get(14)?,
        broadcast: r.get(15)?,
    })
}

/// A request's stored route: `return_conversation_id` NULL is `Inbox` (see `Returns`).
fn returns_of(request: &RequestState, conversation: Option<String>) -> Option<Returns> {
    match request {
        RequestState::None => None,
        RequestState::Awaiting | RequestState::Answered { .. } | RequestState::Cancelled | RequestState::Failed => {
            Some(conversation.map_or(Returns::Inbox, |id| Returns::Conversation { id }))
        }
    }
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

fn task_channel(tx: &Connection, actor: &Actor, task_id: &str) -> Result<Channel> {
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
    Request { owed_by: Vec<Actor> },
}

fn ask(kind: PostKind, channel: &Channel, author: &Actor) -> Result<Ask> {
    match (kind, &channel.kind) {
        (PostKind::Inform, _) => Ok(Ask::Inform),
        (PostKind::Request, ChannelKind::Direct { members }) => {
            let others: Vec<Actor> = members.iter().filter(|m| *m != author).cloned().collect();
            // A channel with only the author in it is a note to self: the author owes the answer.
            let owed_by = if others.is_empty() { vec![author.clone()] } else { others };
            Ok(Ask::Request { owed_by })
        }
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
            Ask::Request { owed_by } => owed_by,
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

    /// Answers a request: the answer post, the request's flip to answered and the `Reply` run back
    /// to a buddy author commit together or not at all.
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
                tx.execute(
                    "INSERT INTO post (id, channel_id, author_id, root_id, reply_to_id, task_id, body, evidence, created_at, ord)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        id,
                        request.channel_id,
                        actor.buddy_id(),
                        request.root_id.as_deref().unwrap_or(&request.id),
                        request.id,
                        request.task_id,
                        input.body,
                        evidence_json(&input.evidence),
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
                follow(tx, actor, request.root_id.as_deref().unwrap_or(&request.id), &ord)?;
                notify_author(tx, &request)?;
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

    /// Requests the actor owes (across workspaces), its own open requests, and its channels in
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
        let waiting_on = collect(
            self.conn
                .prepare_cached(&format!(
                    "SELECT {POST_COLS} FROM post p WHERE p.author_id IS ?1 AND p.request = 'awaiting' ORDER BY p.ord"
                ))?
                .query_map([my_buddy], post_row)?,
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

    /// Posts in `workspace_id` whose body contains every word of `query` (literal words, not FTS
    /// syntax), newest first, from the channels the actor may read: public and task channels, and
    /// the direct channels it is a member of (the owner reads every one). Pages older with `before`
    /// (keyset on `ord`, like `task_posts`); until 2026-09-27 search took no cursor, so the MCP
    /// `before` was silently ignored and a Buddy could never see past the newest `limit` hits.
    pub fn search_posts(&self, actor: &Actor, workspace_id: &str, query: &str, before: Option<Cursor>, limit: i64) -> Result<PostPage> {
        require(&self.conn, actor, Op::SearchPosts, &Subject::Owner)?;
        let words: Vec<String> = query.split_whitespace().map(|w| format!("\"{}\"", w.replace('"', "\"\""))).collect();
        if words.is_empty() {
            return Err(CoreError::Invalid("an empty search".into()));
        }
        let mut args: Vec<Value> = vec![words.join(" ").into(), workspace_id.to_string().into(), actor.key().to_string().into()];
        let keyset = match before {
            None => "",
            Some(Cursor { ord }) => {
                args.push(ord.into());
                " AND p.ord < ?4"
            }
        };
        args.push((limit + 1).into());
        let sql = format!(
            "SELECT {POST_COLS} FROM post_search s JOIN post p ON p.rowid = s.rowid JOIN channel c ON c.id = p.channel_id
             WHERE post_search MATCH ?1 AND c.workspace_id = ?2{keyset} AND {} ORDER BY p.ord DESC LIMIT ?{}",
            readable_by("?3"),
            args.len()
        );
        Ok(keyset_page(collect(self.conn.prepare_cached(&sql)?.query_map(params_from_iter(args), post_row)?)?, limit))
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
    /// Never creates a row: reading a thread is not following it.
    pub fn mark_thread_read(&mut self, actor: &Actor, root_id: &str, post_id: &str) -> Result<()> {
        self.write(|tx| {
            let post = get_post(tx, post_id)?;
            if post.id != root_id && post.root_id.as_deref() != Some(root_id) {
                return Err(CoreError::Invalid(format!("post {post_id} is not in thread {root_id}")));
            }
            require(tx, actor, Op::ReadChannel, &Subject::Channel { id: post.channel_id.clone() })?;
            tx.execute(
                "UPDATE thread_read SET last_ord = ?3, updated_at = ?4 WHERE reader = ?1 AND root_id = ?2 AND last_ord < ?3",
                params![actor.key(), root_id, post.ord, now_iso()],
            )?;
            Ok(())
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
           conversation_id, return_conversation_id, created_at, ord, broadcast)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
        // its own posts. It is NOT the return route: an owner chat is provenance too, and its
        // answers must not come back as runs (`Returns`).
        input.from_conversation_id,
        ask.column().and(match &input.returns {
            Some(Returns::Conversation { id }) => Some(id.as_str()),
            Some(Returns::Inbox) | None => None,
        }),
        now_iso(),
        ord,
        input.broadcast
    ])?;
    follow(tx, actor, root_id.as_deref().unwrap_or(&id), &ord)?;
    for recipient in ask.owed_by().iter().filter_map(Actor::buddy_id) {
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
        Ask::Request { owed_by } => owed_by.iter().try_for_each(|recipient| match recipient {
            Actor::Owner => Err(CoreError::Invalid("the owner runs no worker; a run config needs buddy recipients".into())),
            Actor::Buddy { id } => require(tx, actor, Op::EnqueueRun, &Subject::Buddy { id: id.clone() }),
        }),
    }
}

/// Writing in a thread follows it and reads it through the new post (THREADS_VIEW_2026-09-28.md).
fn follow(tx: &Transaction, actor: &Actor, root_id: &str, ord: &str) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO thread_read (reader, root_id, last_ord, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(reader, root_id) DO UPDATE SET last_ord = excluded.last_ord, updated_at = excluded.updated_at
         WHERE excluded.last_ord > thread_read.last_ord",
    )?
    .execute(params![actor.key(), root_id, ord, now_iso()])?;
    Ok(())
}

/// A reply joins its parent's thread, which must be in the same channel.
fn thread_root(tx: &Transaction, parent_id: &str, channel_id: &str) -> Result<String> {
    let parent = get_post(tx, parent_id)?;
    match parent.channel_id == channel_id {
        true => Ok(parent.root_id.unwrap_or(parent.id)),
        false => Err(CoreError::Invalid(format!("post {parent_id} is in another channel"))),
    }
}

/// An answer goes back along the route its request fixed when it was sent.
fn notify_author(tx: &Transaction, request: &Post) -> Result<()> {
    send_back(tx, request, RunInput::Reply { post_id: request.id.clone() })
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/// The one place a request's answer or failure notice becomes a run, shared by `notify_author`
/// and the failure path (runs.rs `close_request`). It reads the route the request was sent with
/// and asks nothing else: whether the sender's conversation is a human chat was settled at send.
/// An `Inbox` route enqueues NOTHING. Before 2026-10-01 it enqueued a run tagged with the origin
/// conversation and let the runner discover after claim that it was a no-op; those runs waited
/// behind the owner's turn up to 2h44m and read as "blocked" (see `Returns`). A run here is real
/// model work in a background conversation, so serializing it behind that conversation is right.
/// Guard: `an_inbox_request_starts_no_run_for_its_answer_or_failure` (tests/core.rs).
pub(crate) fn send_back(tx: &Transaction, request: &Post, input: RunInput) -> Result<()> {
    match (&request.author, &request.returns) {
        (Actor::Buddy { id }, Some(Returns::Conversation { id: conversation })) => tx
            .enqueue(EnqueueInput {
                buddy_id: id.clone(),
                input,
                conversation_id: Some(conversation.clone()),
                task_id: request.task_id.clone(),
                after_run_id: None,
                deadline: None,
                config: None,
            })
            .map(|_| ()),
        // The owner reads answers in the UI; an Inbox sender reads its inbox. Neither is a run.
        (Actor::Owner, _) | (Actor::Buddy { .. }, Some(Returns::Inbox) | None) => Ok(()),
    }
}
