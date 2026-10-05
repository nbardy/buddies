//! Thread follows: a Buddy reading a thread asks to be woken by its next post
//! (agent_notes/2026-10-04_thread-follow-and-channel-search-decision.md, Decision 1).
//!
//! The read mark is the follower's `thread_read` row (posts.rs `follow`): its own posts, a follow,
//! a follow wake and a plain thread read (`mark_thread_read`) advance it. "Unread" is always "by
//! someone else, past that mark", so the three answers below agree on what the Buddy has seen.
//!
//! A follow read (`follow_thread`) either returns unread posts at once (`FollowRead::Unread`, no
//! follow) or registers a `thread_follow` row plus ONE queued `RunInput::Follow` run in the
//! conversation that asked, due at `until` (`FollowRead::Following`). The host's 2 s grace wait
//! sits between `catch_up_thread` and `follow_thread` (server mcp.ts `FOLLOW_GRACE_MS`). A post
//! in the thread by anyone but the follower makes the run due now, in the post's own transaction
//! (`wake_followers`). The claimed run (`deliver_follow`) shows the unread posts, settles with no
//! turn when the follower already read them, or reports the timeout: one wake each; the follower
//! follows again to keep waiting.
//!
//! Why a run and not the host's in-memory reply machine (server channel-pair.ts): a follow must
//! survive a backend restart, and the run queue already is the durable, per-conversation serial,
//! pool-limited way a Buddy's conversation gets a turn (the same path a request's answer takes
//! back to a background conversation, posts.rs `send_back`). A queued run outlives the process;
//! recovery only ends runs that were RUNNING when it died.
//!
//! Not `thread_read`: that is the owner's "followed threads" list and unread cursor (posts.rs
//! `follow`), which wakes nobody.

use crate::error::{CoreError, Result};
use crate::posts::{POST_COLS, get_post, post_row};
use crate::runs::Enqueue;
use crate::store::{Store, collect, new_id, now_iso, require};
use crate::types::*;
use chrono::{DateTime, Duration, Utc};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};

/// The longest a follow may wait. A longer wait is a schedule, not a follow.
pub const MAX_FOLLOW_DAYS: i64 = 7;

/// Unread posts of a thread for `?1` (the reader key, also the excluded author): the root and its
/// replies by someone else past the reader's `thread_read` mark. No row: the reader never posted,
/// followed or was woken here, so every such post is unread.
const UNREAD: &str = "(p.id = ?2 OR p.root_id = ?2) AND p.author_id IS NOT ?1
    AND p.ord > coalesce((SELECT t.last_ord FROM thread_read t WHERE t.reader = ?1 AND t.root_id = ?2), '')";

const FOLLOW_COLS: &str = "f.id, f.root_id, f.buddy_id, f.conversation_id, f.through_ord, f.until, f.created_at, \
    (SELECT r.id FROM run r WHERE r.input_key = 'follow:' || f.id ORDER BY r.attempt DESC LIMIT 1)";

fn follow_row(r: &Row) -> rusqlite::Result<ThreadFollow> {
    Ok(ThreadFollow {
        id: r.get(0)?,
        root_id: r.get(1)?,
        buddy_id: r.get(2)?,
        conversation_id: r.get(3)?,
        through_ord: r.get(4)?,
        until: r.get(5)?,
        created_at: r.get(6)?,
        run_id: r.get(7)?,
    })
}

pub(crate) fn get_follow(conn: &Connection, id: &str) -> Result<ThreadFollow> {
    conn.prepare_cached(&format!("SELECT {FOLLOW_COLS} FROM thread_follow f WHERE f.id = ?1"))?
        .query_row([id], follow_row)
        .optional()?
        .ok_or_else(|| CoreError::not_found("thread follow", id))
}

/// When a new follow's run is due: its `until` (enqueue runs before the row has a run).
pub(crate) fn due_at(conn: &Connection, id: &str) -> Result<String> {
    conn.prepare_cached("SELECT until FROM thread_follow WHERE id = ?1")?
        .query_row([id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| CoreError::not_found("thread follow", id))
}

/// `until` in the store's one time format: `ready_at` is compared as text against `now_iso()`,
/// so an offset like `+02:00` must not reach it unnormalized.
fn follow_until(until: &str, now: DateTime<Utc>) -> Result<String> {
    let at = DateTime::parse_from_rfc3339(until)
        .map_err(|e| CoreError::Invalid(format!("follow until {until:?}: {e}")))?
        .with_timezone(&Utc);
    match (at > now, at <= now + Duration::days(MAX_FOLLOW_DAYS)) {
        (true, true) => Ok(at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
        (false, _) => Err(CoreError::Invalid(format!("follow until {until} is not in the future"))),
        (true, false) => Err(CoreError::Invalid(format!("follow until {until} is more than {MAX_FOLLOW_DAYS} days away"))),
    }
}

/// A post in a thread makes every follow of it by someone else due now. Called inside the post's
/// transaction (posts.rs `insert_post`, `answer`), so a committed post never misses its wake.
/// The follower's own posts wake nobody: it wrote them.
pub(crate) fn wake_followers(tx: &Transaction, author: &Actor, root_id: &str) -> Result<()> {
    let now = now_iso();
    tx.prepare_cached(
        "UPDATE run SET ready_at = ?1
         WHERE input_kind = 'follow' AND status = 'queued' AND ready_at > ?1
           AND input_id IN (SELECT f.id FROM thread_follow f WHERE f.root_id = ?2 AND f.buddy_id IS NOT ?3)",
    )?
    .execute(params![now, root_id, author.buddy_id()])?;
    Ok(())
}

/// The newest `limit` unread posts (oldest first) and how many older unread ones were left out.
/// Advances the reader's mark to the newest of them: returning a post is reading it.
fn take_unread(tx: &Transaction, buddy_id: &str, root_id: &str, limit: i64) -> Result<(Vec<Post>, i64)> {
    let mut posts = collect(
        tx.prepare_cached(&format!("SELECT {POST_COLS} FROM post p WHERE {UNREAD} ORDER BY p.ord DESC LIMIT ?3"))?
            .query_map(params![buddy_id, root_id, limit], post_row)?,
    )?;
    let total: i64 = tx.prepare_cached(&format!("SELECT count(*) FROM post p WHERE {UNREAD}"))?.query_row(params![buddy_id, root_id], |r| r.get(0))?;
    if let Some(newest) = posts.first() {
        mark(tx, buddy_id, root_id, &newest.ord)?;
    }
    posts.reverse();
    let unshown = total - posts.len() as i64;
    Ok((posts, unshown))
}

/// Upsert the follower's read mark; it only moves forward (posts.rs `follow`).
fn mark(tx: &Transaction, buddy_id: &str, root_id: &str, ord: &str) -> Result<()> {
    crate::posts::follow(tx, &Actor::Buddy { id: buddy_id.to_string() }, root_id, ord)
}

/// A thread root the Buddy may read; a reply names its thread instead.
fn readable_root(tx: &Transaction, actor: &Actor, root_id: &str) -> Result<Post> {
    let root = get_post(tx, root_id)?;
    if let Some(thread) = &root.root_id {
        return Err(CoreError::Invalid(format!("post {} is a reply; follow its thread {thread}", root.id)));
    }
    require(tx, actor, Op::ReadChannel, &Subject::Channel { id: root.channel_id.clone() })?;
    Ok(root)
}

fn follower(actor: &Actor) -> Result<String> {
    match actor {
        Actor::Buddy { id } => Ok(id.clone()),
        Actor::Owner => Err(CoreError::Invalid("only a Buddy follows a thread; the owner sees new posts in the app".into())),
    }
}

impl Store {
    /// The first step of a follow read: the thread's unread posts, marked read. Empty means there
    /// is nothing to return yet, and the host holds the read open for its grace window.
    pub fn catch_up_thread(&mut self, actor: &Actor, root_id: &str, limit: i64) -> Result<ThreadUnread> {
        let buddy_id = follower(actor)?;
        self.write(|tx| {
            let root = readable_root(tx, actor, root_id)?;
            let (posts, unshown) = take_unread(tx, &buddy_id, &root.id, limit)?;
            Ok(ThreadUnread { posts, unshown })
        })
    }

    /// The last step of a follow read: unread posts if any arrived (returned, no follow), else the
    /// follow is registered in one transaction with that check, so a post committed after it
    /// finds the queued run in `wake_followers`. Replaces a queued follow of the same thread from
    /// the same conversation (one wake per conversation and thread).
    pub fn follow_thread(&mut self, actor: &Actor, input: FollowInput) -> Result<FollowRead> {
        let buddy_id = follower(actor)?;
        self.write(|tx| {
            let root = readable_root(tx, actor, &input.root_id)?;
            let until = follow_until(&input.until, Utc::now())?;
            let (posts, unshown) = take_unread(tx, &buddy_id, &root.id, input.limit)?;
            if !posts.is_empty() {
                return Ok(FollowRead::Unread { posts, unshown });
            }
            let now = now_iso();
            tx.prepare_cached(
                "UPDATE run SET status = 'cancelled', error_code = 'superseded', error = 'a newer follow of this thread replaced it',
                   ended_at = ?3
                 WHERE input_kind = 'follow' AND status = 'queued'
                   AND input_id IN (SELECT f.id FROM thread_follow f WHERE f.root_id = ?1 AND f.conversation_id = ?2)",
            )?
            .execute(params![root.id, input.conversation_id, now])?;
            let through: String = tx
                .prepare_cached("SELECT max(p.ord) FROM post p WHERE p.id = ?1 OR p.root_id = ?1")?
                .query_row([&root.id], |r| r.get(0))?;
            mark(tx, &buddy_id, &root.id, &through)?;
            let id = new_id("follow");
            tx.prepare_cached(
                "INSERT INTO thread_follow (id, root_id, buddy_id, conversation_id, through_ord, until, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?
            .execute(params![id, root.id, buddy_id, input.conversation_id, through, until, now])?;
            tx.enqueue(EnqueueInput {
                buddy_id: buddy_id.clone(),
                input: RunInput::Follow { follow_id: id.clone() },
                conversation_id: Some(input.conversation_id.clone()),
                task_id: None,
                after_run_id: None,
                deadline: None,
                config: None,
            })?;
            Ok(FollowRead::Following { follow: get_follow(tx, &id)? })
        })
    }

    /// What a claimed follow run shows (sum type `FollowWake`): unread posts after the follow, or
    /// `AlreadyRead` when others posted but the follower read them itself before the run fired
    /// (the host settles it without a turn), or `Timeout` when nobody else posted.
    ///
    /// The upper bound is fixed by the first call (`delivered_through`): the runner composes a job
    /// again when an adopted turn finishes (runner.ts `FINISH.complete`), and that second call
    /// must not mark read the posts that arrived during the wake turn, which it never showed.
    pub fn deliver_follow(&mut self, follow_id: &str, limit: i64) -> Result<FollowWake> {
        self.write(|tx| {
            let follow = get_follow(tx, follow_id)?;
            let upper: String = tx
                .prepare_cached(
                    "SELECT coalesce(f.delivered_through, (SELECT max(p.ord) FROM post p WHERE p.id = f.root_id OR p.root_id = f.root_id))
                     FROM thread_follow f WHERE f.id = ?1",
                )?
                .query_row([&follow.id], |r| r.get(0))?;
            tx.execute("UPDATE thread_follow SET delivered_through = ?2 WHERE id = ?1 AND delivered_through IS NULL", params![follow.id, upper])?;
            let in_window = "p.root_id = ?2 AND p.author_id IS NOT ?1 AND p.ord > ?3 AND p.ord <= ?4";
            let mut posts = collect(
                tx.prepare_cached(&format!(
                    "SELECT {POST_COLS} FROM post p WHERE {in_window}
                       AND p.ord > coalesce((SELECT t.last_ord FROM thread_read t WHERE t.reader = ?1 AND t.root_id = ?2), '')
                     ORDER BY p.ord DESC LIMIT ?5"
                ))?
                .query_map(params![follow.buddy_id, follow.root_id, follow.through_ord, upper, limit], post_row)?,
            )?;
            let others: i64 = tx
                .prepare_cached(&format!("SELECT count(*) FROM post p WHERE {in_window}"))?
                .query_row(params![follow.buddy_id, follow.root_id, follow.through_ord, upper], |r| r.get(0))?;
            let unread: i64 = tx
                .prepare_cached(&format!(
                    "SELECT count(*) FROM post p WHERE {in_window}
                       AND p.ord > coalesce((SELECT t.last_ord FROM thread_read t WHERE t.reader = ?1 AND t.root_id = ?2), '')"
                ))?
                .query_row(params![follow.buddy_id, follow.root_id, follow.through_ord, upper], |r| r.get(0))?;
            mark(tx, &follow.buddy_id, &follow.root_id, &upper)?;
            posts.reverse();
            Ok(match (posts.len(), others) {
                (0, 0) => FollowWake::Timeout { follow },
                (0, _) => FollowWake::AlreadyRead { follow },
                (shown, _) => FollowWake::Posts { unshown: unread - shown as i64, follow, posts },
            })
        })
    }

    /// Buddies whose follow of this thread shows (or showed) the post at `ord`: a live follow not
    /// yet composed, or any follow whose wake was composed after the post (its turn may already
    /// be over: the host asks after the post is announced, and a fast turn beats it). The host
    /// skips their follow-up gate: they asked to be told, and a gate would wake them twice. A
    /// follow composed BEFORE the post, or replaced/cancelled unshown, does not count: that
    /// Buddy never saw the post, so the gate still asks.
    pub fn delivering_followers(&self, root_id: &str, ord: &str) -> Result<Vec<String>> {
        collect(
            self.conn
                .prepare_cached(
                    "SELECT DISTINCT f.buddy_id FROM thread_follow f JOIN run r ON r.input_key = 'follow:' || f.id
                     WHERE f.root_id = ?1 AND f.through_ord < ?2
                       AND (f.delivered_through >= ?2
                            OR (f.delivered_through IS NULL AND r.status IN ('queued','running','cancel_requested')))",
                )?
                .query_map(params![root_id, ord], |r| r.get(0))?,
        )
    }
}
