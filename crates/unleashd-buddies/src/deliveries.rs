//! Delivery: the one rule by which a post reaches a Buddy's conversation (owner decisions A–K,
//! 2026-10-06; agent_notes/2026-10-06_delivery-model-design.md §1, §3).
//!
//! A Buddy's `thread_read` row is two things: how far it has read the thread (`last_ord`), and,
//! when `conversation_id` is set, which of its conversations is SUBSCRIBED to it. One
//! conversation per (Buddy, thread): the last one to subscribe wins (decision F/D8). A post by
//! someone else in the thread becomes a `deliver` run for that conversation, in the post's own
//! transaction (`fan_out`), so a committed post never misses its delivery and survives a restart.
//!
//! The read mark is the delivery cursor. Whenever it advances, every queued delivery it covers
//! settles `consumed` with no turn (`fence`). A claimed delivery shows every unread post across
//! all threads its conversation subscribes to (`compose`), so a burst of N posts in M threads
//! costs one turn: marking them read at `mark_executing` fences the other N-1 runs.
//!
//! This one rule replaced the request return route (`Returns`, `post.return_conversation_id`,
//! `send_back`), the follow table and its runs (`thread_follow`, follows.rs) and the reply /
//! failure-notice / follow / schedule run kinds, and (step 5) the host's pair machine and
//! follow-up gate: an @mention or the owner's DM post is a delivery too (`wake`), to the thread's
//! subscription or, with none, to a run with no conversation, for which the host opens the
//! Buddy's seat when it claims it.

use crate::error::{CoreError, Result};
use crate::posts::{POST_COLS, post_row};
use crate::runs::{Enqueue, RUN_COLS, run_row};
use crate::store::{Store, collect, now_iso, require};
use crate::types::*;
use rusqlite::{OptionalExtension, Transaction, params};

/// The most posts one delivery quotes; older unread ones are counted and read with channel_read.
pub const SHOWN: i64 = 20;

/// Every thread a delivery covers: the threads its conversation subscribes to, plus the thread of
/// the post that triggered it (a fresh conversation subscribes only once it is bound), each with
/// the Buddy's read mark. `?1` buddy, `?2` conversation (NULL: none yet), `?3` the trigger's root.
const COVERED: &str = "covered(root, mark) AS (
    SELECT t.root_id, t.last_ord FROM thread_read t WHERE t.conversation_id = ?2 AND t.reader = ?1
    UNION
    SELECT ?3, coalesce((SELECT t.last_ord FROM thread_read t WHERE t.reader = ?1 AND t.root_id = ?3), ''))";

/// What a delivery shows from a covered thread: past the mark, and either by someone else or a
/// post still being delivered to this Buddy (a schedule fire, which the Buddy itself authored).
const SHOWABLE: &str = "p.ord > h.mark AND (p.author_id IS NOT ?1 OR EXISTS (
    SELECT 1 FROM run d WHERE d.input_kind = 'deliver' AND d.input_id = p.id AND d.buddy_id = ?1
      AND d.status IN ('queued','running','cancel_requested')))";

fn root_of(post: &Post) -> &str {
    post.root_id.as_deref().unwrap_or(&post.id)
}

/// Moves `reader`'s mark in a thread forward to `ord` (never back), creating the row, then fences
/// a Buddy's deliveries. The subscription column is left as it is.
pub(crate) fn advance(tx: &Transaction, reader: &Actor, root_id: &str, ord: &str) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO thread_read (reader, root_id, last_ord, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(reader, root_id) DO UPDATE SET last_ord = excluded.last_ord, updated_at = excluded.updated_at
         WHERE excluded.last_ord > thread_read.last_ord",
    )?
    .execute(params![reader.key(), root_id, ord, now_iso()])?;
    match reader {
        Actor::Buddy { id } => fence(tx, id, root_id, ord),
        Actor::Owner => Ok(()),
    }
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/// THE READ FENCE: a Buddy's mark in a thread moved to `through`, so every queued delivery of a
/// post there at or below it was received another way (a thread read, a follow, another delivery
/// that showed it, its own reply after it). It settles `consumed`, with no model turn. A claimed
/// delivery is already composing and finishes.
/// It generalizes the 2026-10-01 consumed fence for answers (`settle_read_returns`): answer
/// post_01a0f62f-c576 was read by its running requester at 06:39:42Z, and its return run stayed
/// queued until cancelled by hand at 06:56Z. Guards: `a_mark_advance_consumes_every_covered_delivery`
/// (tests/core.rs), buddies-v2 "an answer the requester already read settles …".
pub(crate) fn fence(tx: &Transaction, buddy_id: &str, root_id: &str, through: &str) -> Result<()> {
    tx.prepare_cached(
        "UPDATE run SET status = 'cancelled', error_code = 'consumed', error = 'the reader already read it', ended_at = ?4
         WHERE input_kind = 'deliver' AND status = 'queued' AND buddy_id = ?1
           AND input_id IN (SELECT p.id FROM post p WHERE p.root_id = ?2 AND p.ord <= ?3
                            UNION ALL SELECT p.id FROM post p WHERE p.id = ?2 AND p.ord <= ?3)",
    )?
    .execute(params![buddy_id, root_id, through, now_iso()])?;
    Ok(())
}

/// Subscribes `conversation` to the thread for the Buddy (None: unsubscribes, `follow:false`).
/// A new row reads nothing yet ('' sorts before every ord).
pub(crate) fn subscribe(tx: &Transaction, buddy_id: &str, root_id: &str, conversation: Option<&str>) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO thread_read (reader, root_id, last_ord, updated_at, conversation_id) VALUES (?1, ?2, '', ?3, ?4)
         ON CONFLICT(reader, root_id) DO UPDATE SET conversation_id = excluded.conversation_id, updated_at = excluded.updated_at",
    )?
    .execute(params![buddy_id, root_id, now_iso(), conversation])?;
    Ok(())
}

/// Decision K (2026-10-06): a Buddy that was shown a thread through `ord` reads it through `ord`
/// only when nothing it was NOT shown lies between its mark and `ord`: a post by someone else, or
/// a post still being delivered to it. Otherwise the mark stays and those posts stay unread, so
/// they are delivered or read later.
/// Why: posting used to move the author's mark through its own post. A turn composed before P2 and
/// P3 arrived that replied after them jumped the mark past both; the next prompt omitted them and
/// their delivery settled "already read" though the Buddy never saw them (durable-pending Rev 10,
/// Finding 2, which blocked test 11). The owner reads in the app, so the owner's mark moves as
/// before. Guard: `posting_never_marks_read_a_post_its_author_was_not_shown` (tests/core.rs).
pub(crate) fn catch_up(tx: &Transaction, reader: &Actor, root_id: &str, ord: &str) -> Result<()> {
    let buddy_id = match reader {
        Actor::Owner => return advance(tx, reader, root_id, ord),
        Actor::Buddy { id } => id,
    };
    let unseen: bool = tx
        .prepare_cached(&format!(
            "WITH {COVERED}
             SELECT EXISTS(SELECT 1 FROM covered h JOIN post p ON p.root_id = h.root WHERE {SHOWABLE} AND p.ord < ?4)
                 OR EXISTS(SELECT 1 FROM covered h JOIN post p ON p.id = h.root WHERE {SHOWABLE} AND p.ord < ?4)"
        ))?
        .query_row(params![buddy_id, Option::<String>::None, root_id, ord], |r| r.get(0))?;
    match unseen {
        false => advance(tx, reader, root_id, ord),
        // The row still records that the Buddy is in the thread (its Threads view, unread count).
        true => Ok(tx
            .prepare_cached(
                "INSERT INTO thread_read (reader, root_id, last_ord, updated_at) VALUES (?1, ?2, '', ?3)
                 ON CONFLICT(reader, root_id) DO NOTHING",
            )?
            .execute(params![buddy_id, root_id, now_iso()])
            .map(|_| ())?),
    }
}

/// Rule 1: a post by someone else in a subscribed thread is delivered to the subscribed
/// conversation, one `deliver` run per (post, Buddy). Called inside the post's transaction.
/// `skip`: Buddies already woken another way for this post (a request's recipient gets its `post`
/// run, a mention gets `wake`'s), so nobody is woken twice.
pub(crate) fn fan_out(tx: &Transaction, post: &Post, skip: &[String]) -> Result<()> {
    let subscribers = collect(
        tx.prepare_cached(
            "SELECT t.reader, t.conversation_id FROM thread_read t JOIN buddy b ON b.id = t.reader
             WHERE t.root_id = ?1 AND t.conversation_id IS NOT NULL AND b.status = 'active' AND t.reader IS NOT ?2",
        )?
        .query_map(params![root_of(post), post.author.buddy_id()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?,
    )?;
    for (buddy_id, conversation_id) in subscribers.into_iter().filter(|(b, _)| !skip.contains(b)) {
        enqueue_delivery(tx, &buddy_id, post, Some(conversation_id))?;
    }
    Ok(())
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/// An @mention, or the owner's plain post in a DM, wakes its Buddy: one `deliver` run in the post's
/// own transaction, on the owner's chip pick (`config`). It goes to the conversation the Buddy
/// follows that thread in; with none it carries no conversation, and the host opens the Buddy's
/// seat when it claims the run (runner.ts `deliverJob`). Until 2026-10-06 the host's pair machine
/// did this from memory, one post behind every restart, and a second path (the follow-up gate)
/// asked each other participant a model question per post; both are this one rule now.
/// A Buddy outside the channel's workspace, or archived, is skipped: an unknown mention is the
/// resolver's `unresolved` (mentions.ts), never an error that fails the post.
pub(crate) fn wake(tx: &Transaction, channel: &Channel, post: &Post, mention: &Mention) -> Result<()> {
    let wakeable: bool = tx
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM buddy WHERE id = ?1 AND workspace_id = ?2 AND status = 'active')")?
        .query_row(params![mention.buddy_id, channel.workspace_id], |r| r.get(0))?;
    if !wakeable || post.author.buddy_id() == Some(mention.buddy_id.as_str()) {
        return Ok(());
    }
    let conversation = subscription(tx, &mention.buddy_id, root_of(post))?;
    tx.enqueue(EnqueueInput {
        buddy_id: mention.buddy_id.clone(),
        input: RunInput::Deliver { post_id: post.id.clone() },
        conversation_id: conversation,
        task_id: post.task_id.clone(),
        after_run_id: None,
        deadline: None,
        config: mention.config.clone(),
    })
    .map(|_| ())
}

pub(crate) fn enqueue_delivery(tx: &Transaction, buddy_id: &str, post: &Post, conversation_id: Option<String>) -> Result<Run> {
    tx.enqueue(EnqueueInput {
        buddy_id: buddy_id.to_string(),
        input: RunInput::Deliver { post_id: post.id.clone() },
        conversation_id,
        task_id: post.task_id.clone(),
        after_run_id: None,
        deadline: None,
        config: None,
    })
}

/// A post a Buddy's WORKER writes in the thread of the request that Buddy sent itself (a request
/// in its own DM: the usual way a Buddy spawns a worker, `post {direct:[]} kind request worker`).
/// Spawner and worker are one Buddy, so they share the one (Buddy, thread) subscription and read
/// mark, which belong to the spawner: the worker's posts must not take the subscription (D8 would
/// move the answer's route into the worker itself) nor read the thread for the spawner (its answer
/// would be marked read before it was delivered). The worker is the conversation the request was
/// bound to (runs.rs `bind_run` sets the request's `conversation_id`). Guard:
/// `a_worker_request_runs_on_its_own_config_and_returns_to_the_spawner` (tests/core.rs).
pub(crate) fn from_own_worker(tx: &Transaction, actor: &Actor, post: &Post, from: Option<&str>) -> Result<bool> {
    let (Some(root_id), Some(from)) = (&post.root_id, from) else { return Ok(false) };
    let root = crate::posts::get_post(tx, root_id)?;
    Ok(root.author == *actor && root.request != RequestState::None && root.conversation_id.as_deref() == Some(from))
}

/// Delivers a post its author's own spawner must hear: a self-request's answer or failure. The
/// author-based fan-out never delivers a Buddy's post to that same Buddy.
pub(crate) fn deliver_to_spawner(tx: &Transaction, buddy_id: &str, post: &Post) -> Result<()> {
    let conversation = subscription(tx, buddy_id, root_of(post))?;
    enqueue_delivery(tx, buddy_id, post, conversation).map(|_| ())
}

/// The Buddy's subscribed conversation in a thread, if any.
pub(crate) fn subscription(tx: &Transaction, buddy_id: &str, root_id: &str) -> Result<Option<String>> {
    Ok(tx
        .prepare_cached("SELECT conversation_id FROM thread_read WHERE reader = ?1 AND root_id = ?2")?
        .query_row(params![buddy_id, root_id], |r| r.get::<_, Option<String>>(0))
        .optional()?
        .flatten())
}

/// What a claimed delivery shows: every unread post of the threads it covers, newest `SHOWN`,
/// oldest first. The first compose fixes `through_ord` (the newest shown); a later one (a requeued
/// run, or the runner re-deriving an adopted turn's completion) never reaches past it, so it can
/// never claim to have shown a post that arrived during the turn. Writes nothing else: the marks
/// move at `mark_executing`, once the turn is certain to run (design R2: a holder that dies before
/// it must leave the posts unread, or the requeued run would show nothing).
pub(crate) fn compose(tx: &Transaction, run: &Run, post: &Post) -> Result<Delivery> {
    // A retried attempt always shows its trigger: the failed attempt marked it read when it started
    // (`delivered`), and a retry that showed nothing would settle "already read" and answer nothing.
    let retried = (run.attempt > 1).then_some(post.id.as_str());
    let args = params![run.buddy_id, run.conversation_id, root_of(post), run.through_ord, retried];
    let window = "(?4 IS NULL OR p.ord <= ?4)";
    let select = |what: &str, join: &str| {
        format!("SELECT {what} FROM covered h JOIN post p ON {join} WHERE ({SHOWABLE} OR p.id = ?5) AND {window}")
    };
    let mut posts = collect(
        tx.prepare_cached(&format!(
            // `+ord`: sorting by the bare column let the planner walk all of `post` in ord order
            // (its unique index) instead of each covered thread's replies (query-plan guard).
            "WITH {COVERED} SELECT * FROM ({} UNION ALL {}) ORDER BY +ord DESC LIMIT {SHOWN}",
            select(POST_COLS, "p.root_id = h.root"),
            select(POST_COLS, "p.id = h.root")
        ))?
        .query_map(args, post_row)?,
    )?;
    let total: i64 = tx
        .prepare_cached(&format!(
            "WITH {COVERED} SELECT ({}) + ({})",
            select("count(*)", "p.root_id = h.root"),
            select("count(*)", "p.id = h.root")
        ))?
        .query_row(args, |r| r.get(0))?;
    let Some(newest) = posts.first() else { return Ok(Delivery::Consumed) };
    tx.prepare_cached("UPDATE run SET through_ord = ?2 WHERE id = ?1 AND through_ord IS NULL")?
        .execute(params![run.id, newest.ord])?;
    posts.reverse();
    let unshown = total - posts.len() as i64;
    let subscribed = match run.conversation_id {
        Some(_) => None,
        None => subscription(tx, &run.buddy_id, root_of(post))?,
    };
    Ok(Delivery::Posts { posts, unshown, subscribed })
}

/// The delivery is about to run: every thread it covers is read through its `through_ord`, which
/// fences the deliveries of the posts it shows (coalescing). Called by `mark_executing`.
pub(crate) fn delivered(tx: &Transaction, run: &Run, post: &Post) -> Result<()> {
    let Some(through) = &run.through_ord else { return Ok(()) };
    let roots = collect(
        tx.prepare_cached(&format!("WITH {COVERED} SELECT root FROM covered"))?
            .query_map(params![run.buddy_id, run.conversation_id, root_of(post)], |r| r.get::<_, String>(0))?,
    )?;
    let reader = Actor::Buddy { id: run.buddy_id.clone() };
    for root in roots {
        advance(tx, &reader, &root, through)?;
    }
    Ok(())
}

/// The unread posts of one thread for a Buddy (by others, past its mark), newest `limit`, oldest
/// first, marked read: returning a post is reading it.
pub(crate) fn take_unread(tx: &Transaction, buddy_id: &str, root_id: &str, limit: i64) -> Result<ThreadUnread> {
    let unread = "(p.root_id = ?2 OR p.id = ?2) AND p.author_id IS NOT ?1
        AND p.ord > coalesce((SELECT t.last_ord FROM thread_read t WHERE t.reader = ?1 AND t.root_id = ?2), '')";
    let mut posts = collect(
        tx.prepare_cached(&format!("SELECT {POST_COLS} FROM post p WHERE {unread} ORDER BY p.ord DESC LIMIT ?3"))?
            .query_map(params![buddy_id, root_id, limit], post_row)?,
    )?;
    let total: i64 = tx.prepare_cached(&format!("SELECT count(*) FROM post p WHERE {unread}"))?.query_row(params![buddy_id, root_id], |r| r.get(0))?;
    if let Some(newest) = posts.first() {
        advance(tx, &Actor::Buddy { id: buddy_id.to_string() }, root_id, &newest.ord)?;
    }
    posts.reverse();
    let unshown = total - posts.len() as i64;
    Ok(ThreadUnread { posts, unshown })
}

/// A thread root the Buddy may read; a reply names its thread instead.
fn readable_root(tx: &Transaction, actor: &Actor, root_id: &str) -> Result<Post> {
    let root = crate::posts::get_post(tx, root_id)?;
    if let Some(thread) = &root.root_id {
        return Err(CoreError::Invalid(format!("post {} is a reply; its thread is {thread}", root.id)));
    }
    require(tx, actor, Op::ReadChannel, &Subject::Channel { id: root.channel_id.clone() })?;
    Ok(root)
}

fn reader(actor: &Actor) -> Result<&str> {
    match actor {
        Actor::Buddy { id } => Ok(id),
        Actor::Owner => Err(CoreError::Invalid("only a Buddy's conversation subscribes to a thread; the owner sees new posts in the app".into())),
    }
}

impl Store {
    /// `channel_read {threadId, follow}`: subscribe `conversation` to the thread (None:
    /// unsubscribe, `follow:false`), then return its unread posts, marked read. The host's bounded
    /// wait (≤ 30 s, mcp.ts) sits after this and re-reads with `catch_up_thread`. Subscribing first
    /// means a post during the wait is both returned inline and queued as a delivery; returning it
    /// reads it, which fences that delivery, so the Buddy hears of it once.
    pub fn follow_thread(&mut self, actor: &Actor, root_id: &str, conversation: Option<String>, limit: i64) -> Result<ThreadUnread> {
        let buddy_id = reader(actor)?.to_string();
        self.write(|tx| {
            let root = readable_root(tx, actor, root_id)?;
            subscribe(tx, &buddy_id, &root.id, conversation.as_deref())?;
            take_unread(tx, &buddy_id, &root.id, limit)
        })
    }

    /// A thread's unread posts for the Buddy, marked read (the follow wait's re-read).
    pub fn catch_up_thread(&mut self, actor: &Actor, root_id: &str, limit: i64) -> Result<ThreadUnread> {
        let buddy_id = reader(actor)?.to_string();
        self.write(|tx| {
            let root = readable_root(tx, actor, root_id)?;
            take_unread(tx, &buddy_id, &root.id, limit)
        })
    }

    /// What the claimed delivery `run_id` shows (`compose`).
    pub fn deliver_posts(&mut self, run_id: &str) -> Result<Delivery> {
        self.write(|tx| {
            let run = crate::runs::get_run(tx, run_id)?;
            match &run.input {
                RunInput::Deliver { post_id } => compose(tx, &run, &crate::posts::get_post(tx, post_id)?),
                other => Err(CoreError::Invalid(format!("run {run_id} is not a delivery: {other:?}"))),
            }
        })
    }

    /// The Buddies replying in a channel: its queued and running deliveries, by the thread of the
    /// post that triggered them ("X is replying…", derived from runs, not from host memory).
    pub fn responding(&self, channel_id: &str) -> Result<Vec<Responding>> {
        collect(
            self.conn
                .prepare_cached(
                    "SELECT r.buddy_id, coalesce(p.root_id, p.id), coalesce(r.started_at, r.created_at), r.status <> 'queued'
                     FROM run r JOIN post p ON p.id = r.input_id
                     WHERE r.input_kind = 'deliver' AND r.status IN ('queued','running','cancel_requested') AND p.channel_id = ?1
                     ORDER BY r.created_at",
                )?
                .query_map([channel_id], |r| {
                    Ok(Responding { buddy_id: r.get(0)?, thread_root_id: r.get(1)?, started_at: r.get(2)?, running: r.get(3)? })
                })?,
        )
    }

    /// The owner reruns a reply that failed on another model: the next attempt of the delivery of
    /// `post_id` to `buddy_id` (or a first one, when the failure predates deliveries), in the same
    /// conversation unless the provider changes (a started session cannot change provider; the
    /// host opens a new seat for a run with none). A delivery still queued or running starts
    /// nothing new, so a double click runs once.
    pub fn retry_delivery(&mut self, actor: &Actor, post_id: &str, buddy_id: &str, config: RunConfig) -> Result<Run> {
        self.write(|tx| {
            require(tx, actor, Op::EnqueueRun, &Subject::Buddy { id: buddy_id.to_string() })?;
            let post = crate::posts::get_post(tx, post_id)?;
            let latest = |tx: &Transaction| -> Result<Option<Run>> {
                Ok(tx
                    .prepare_cached(&format!("SELECT {RUN_COLS} FROM run WHERE input_kind = 'deliver' AND input_id = ?1 AND buddy_id = ?2 ORDER BY attempt DESC LIMIT 1"))?
                    .query_row(params![post_id, buddy_id], run_row)
                    .optional()?)
            };
            let id = match latest(tx)? {
                None => {
                    let mention = Mention { buddy_id: buddy_id.to_string(), config: Some(config) };
                    wake(tx, &crate::posts::get_channel(tx, &post.channel_id)?, &post, &mention)?;
                    return latest(tx)?.ok_or_else(|| CoreError::Invalid(format!("{buddy_id} cannot be woken for post {post_id}")));
                }
                Some(run) if matches!(run.status, RunStatus::Queued | RunStatus::Running | RunStatus::CancelRequested) => return Ok(run),
                Some(run) => {
                    let same_provider = run.config.as_ref().is_some_and(|old| old.provider == config.provider);
                    let conversation = if same_provider { run.conversation_id.clone() } else { None };
                    crate::runs::next_attempt(tx, &run, conversation, Some(&config))?
                }
            };
            crate::runs::get_run(tx, &id)
        })
    }
}
