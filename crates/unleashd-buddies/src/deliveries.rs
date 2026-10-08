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
use crate::runs::{RUN_WITH_ACTIVITY_SQL, WAITING_REASON_SQL, RUN_COLS, cancel_queued, enqueue, run_row};
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
/// post still being delivered to this Buddy (a note to self, which the Buddy itself authored).
const SHOWABLE: &str = "p.ord > h.mark AND (p.author_id IS NOT ?1 OR EXISTS (
    SELECT 1 FROM run d WHERE d.input_kind = 'deliver' AND d.input_id = p.id AND d.buddy_id = ?1
      AND d.status IN ('queued','running','cancel_requested')))";

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
/// A later attempt (`attempt > 1`: an owner retry, or `redeliver_unanswered`) exists BECAUSE its
/// post was already read, so a read can never have delivered it again: the fence leaves it be.
/// Fencing it let any later read in the thread cancel a re-delivery before it ran (task_01a11a68 6c).
pub(crate) fn fence(tx: &Transaction, buddy_id: &str, root_id: &str, through: &str) -> Result<()> {
    cancel_queued(tx, "consumed", Some("the reader already read it"), "input_kind = 'deliver' AND buddy_id = ?2 AND attempt = 1
           AND input_id IN (SELECT p.id FROM post p WHERE p.root_id = ?3 AND p.ord <= ?4
                            UNION ALL SELECT p.id FROM post p WHERE p.id = ?3 AND p.ord <= ?4)",
        params![now_iso(), buddy_id, root_id, through],
    )?;
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
    // Fix-guard: a failure notice wakes nobody. Without this, two failing Buddies subscribed to one
    // thread woke each other with reply_failed notices (~170 failed turns in 4 min, 2026-10-07).
    // Test: failure_notice_wakes_no_subscriber_but_a_normal_post_still_does (tests/core.rs).
    if post.purpose.as_deref() == Some("reply_failed") {
        return Ok(());
    }
    let subscribers = collect(
        tx.prepare_cached(
            "SELECT t.reader, t.conversation_id FROM thread_read t JOIN buddy b ON b.id = t.reader
             WHERE t.root_id = ?1 AND t.conversation_id IS NOT NULL AND b.status = 'active' AND t.reader IS NOT ?2",
        )?
        .query_map(params![post.root(), post.author.buddy_id()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?,
    )?;
    for (buddy_id, conversation_id) in subscribers.iter().filter(|(b, _)| !skip.contains(b)) {
        enqueue_delivery(tx, buddy_id, post, Some(conversation_id.clone()))?;
    }
    follow_ups(tx, post, skip, &subscribers)
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/// Public and task threads (owner decision 2026-10-07, restoring the follow-up gate of 2026-09):
/// a reply there reaches every OTHER Buddy that has posted in the thread and is not subscribed or
/// woken another way, as a delivery with no conversation. The host asks that Buddy "should you
/// respond?" before it opens its seat (runner.ts `followUpGate`); a `<no>` settles the run with no
/// turn. Direct channels have no participants beyond their members, who subscribe by posting.
/// A failure notice is not announced, so it starts no gate (it would answer a notice with a turn).
fn follow_ups(tx: &Transaction, post: &Post, skip: &[String], subscribed: &[(String, String)]) -> Result<()> {
    let Some(root_id) = &post.root_id else { return Ok(()) };
    if post.purpose.as_deref() == Some("reply_failed") {
        return Ok(());
    }
    let direct: bool = tx
        .prepare_cached("SELECT kind = 'direct' FROM channel WHERE id = ?1")?
        .query_row(params![post.channel_id], |r| r.get(0))?;
    if direct {
        return Ok(());
    }
    let participants = collect(
        tx.prepare_cached(
            "SELECT DISTINCT p.author_id FROM post p JOIN buddy b ON b.id = p.author_id
             WHERE (p.root_id = ?1 OR p.id = ?1) AND b.status = 'active' AND p.author_id IS NOT ?2
               AND coalesce(p.purpose, '') <> 'reply_failed'",
        )?
        .query_map(params![root_id, post.author.buddy_id()], |r| r.get::<_, String>(0))?,
    )?;
    for buddy_id in participants {
        if skip.contains(&buddy_id) || subscribed.iter().any(|(b, _)| *b == buddy_id) {
            continue;
        }
        enqueue_delivery(tx, &buddy_id, post, None)?;
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
    let conversation = subscription(tx, &mention.buddy_id, post.root())?;
    enqueue(tx, EnqueueInput {
        buddy_id: mention.buddy_id.clone(),
        input: RunInput::Deliver { post_id: post.id.clone() },
        conversation_id: conversation,
        task_id: post.task_id.clone(),
        config: mention.config.clone(),
    })
    .map(|_| ())
}

pub(crate) fn enqueue_delivery(tx: &Transaction, buddy_id: &str, post: &Post, conversation_id: Option<String>) -> Result<Run> {
    enqueue(tx, EnqueueInput {
        buddy_id: buddy_id.to_string(),
        input: RunInput::Deliver { post_id: post.id.clone() },
        conversation_id,
        task_id: post.task_id.clone(),
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
    let conversation = subscription(tx, buddy_id, post.root())?;
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
    let args = params![run.buddy_id, run.conversation_id, post.root(), run.through_ord, retried];
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
        None => subscription(tx, &run.buddy_id, post.root())?,
    };
    Ok(Delivery::Posts { posts, unshown, subscribed })
}

/// The delivery is about to run: every thread it covers is read through its `through_ord`, which
/// fences the deliveries of the posts it shows (coalescing). Called by `mark_executing`.
pub(crate) fn delivered(tx: &Transaction, run: &Run, post: &Post) -> Result<()> {
    let Some(through) = &run.through_ord else { return Ok(()) };
    let roots = collect(
        tx.prepare_cached(&format!("WITH {COVERED} SELECT root FROM covered"))?
            .query_map(params![run.buddy_id, run.conversation_id, post.root()], |r| r.get::<_, String>(0))?,
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
    let page = unread_page(tx, buddy_id, root_id, limit)?;
    if let Some(newest) = page.posts.last() {
        advance(tx, &Actor::Buddy { id: buddy_id.to_string() }, root_id, &newest.ord)?;
    }
    Ok(page)
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/// Is a delivery to this Buddy queued in the thread with an explicit pick (model, effort,
/// provider)? The pick lives only on that run (`wake` stores the owner's mention-chip config), and
/// the read mark is one cursor per thread: taking ANY page past it fences that run `consumed`.
fn pick_queued(tx: &Transaction, buddy_id: &str, root_id: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM run d JOIN post p ON p.id = d.input_id
               WHERE d.input_kind = 'deliver' AND d.buddy_id = ?1 AND d.status = 'queued' AND d.config IS NOT NULL
                 AND (p.root_id = ?2 OR p.id = ?2))",
        )?
        .query_row(params![buddy_id, root_id], |r| r.get(0))?)
}

/// Is `run_id` this Buddy's live turn? A take is recorded on the run (`steered_at`) for its
/// settle to check (`redeliver_unanswered`); a settled run has no settle left, so it takes nothing.
fn live_turn(tx: &Transaction, buddy_id: &str, run_id: &str) -> Result<bool> {
    Ok(tx
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM run WHERE id = ?1 AND buddy_id = ?2 AND status IN ('running','cancel_requested'))")?
        .query_row(params![run_id, buddy_id], |r| r.get(0))?)
}

/// Decision 6c (task_01a11a68, 2026-10-08): a take at a turn's LAST tool call (often the reply's
/// own `post`) lands after the reply was written, and the model ends without answering it; its
/// delivery was fenced by the take, so it was lost silently. At settle, if the Buddy wrote nothing
/// in the thread after its last take of an owner post, the newest owner post it took runs again:
/// the next attempt of its delivery, in the same conversation (which holds every steered post).
/// Owner posts only (re-delivering Buddy chatter could ping-pong); an owner Stop re-delivers nothing.
/// Guard: buddies-v2 "a post steered into a turn's last tool call is delivered again".
pub(crate) fn redeliver_unanswered(tx: &Transaction, run: &Run, post_id: &str) -> Result<()> {
    let steered_at: Option<String> =
        tx.prepare_cached("SELECT steered_at FROM run WHERE id = ?1")?.query_row([&run.id], |r| r.get(0))?;
    let Some(steered_at) = steered_at else { return Ok(()) };
    let root = crate::posts::get_post(tx, post_id)?.root().to_string();
    // Strictly after: a reply written in the same tool call as the take (the race this closes)
    // precedes it, and a later model step cannot share its millisecond.
    let latest = tx
        .prepare_cached(
            "SELECT d.id FROM run d JOIN post p ON p.id = d.input_id
              WHERE d.input_kind = 'deliver' AND d.buddy_id = ?2 AND (p.root_id = ?1 OR p.id = ?1)
                AND p.author_id IS NULL AND p.created_at <= ?3 AND p.ord > coalesce(?4, '')
                AND p.ord <= coalesce((SELECT t.last_ord FROM thread_read t WHERE t.reader = ?2 AND t.root_id = ?1), '')
                AND NOT EXISTS (SELECT 1 FROM post r WHERE (r.root_id = ?1 OR r.id = ?1) AND r.author_id = ?2
                                  AND r.created_at > ?3 AND r.purpose IS NOT 'reply_failed')
                AND d.executing_at IS NULL
                AND d.attempt = (SELECT max(attempt) FROM run k WHERE k.input_key = d.input_key)
              ORDER BY p.ord DESC LIMIT 1",
        )?
        .query_row(params![root, run.buddy_id, steered_at, run.through_ord], |r| r.get::<_, String>(0))
        .optional()?;
    if let Some(delivery) = latest {
        crate::runs::next_attempt(tx, &crate::runs::get_run(tx, &delivery)?, run.conversation_id.clone(), None)?;
    }
    Ok(())
}

/// The same page as `take_unread`, NOT marked read: no delivery is fenced.
fn unread_page(tx: &Transaction, buddy_id: &str, root_id: &str, limit: i64) -> Result<ThreadUnread> {
    let unread = "(p.root_id = ?2 OR p.id = ?2) AND p.author_id IS NOT ?1
        AND p.ord > coalesce((SELECT t.last_ord FROM thread_read t WHERE t.reader = ?1 AND t.root_id = ?2), '')";
    let mut posts = collect(
        tx.prepare_cached(&format!("SELECT {POST_COLS} FROM post p WHERE {unread} ORDER BY p.ord DESC LIMIT ?3"))?
            .query_map(params![buddy_id, root_id, limit], post_row)?,
    )?;
    let total: i64 = tx.prepare_cached(&format!("SELECT count(*) FROM post p WHERE {unread}"))?.query_row(params![buddy_id, root_id], |r| r.get(0))?;
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

    // Pattern: route-at-send (docs/patterns.md#route-at-send)
    /// One tool boundary of the live turn `run_id`: take the thread's unread page into it (marked
    /// read, fencing its deliveries) unless a delivery there carries an explicit pick. ONE
    /// transaction on purpose (task_01a11a68 6a): the host checked the pick (listRuns) and read
    /// (catch_up_thread) in two calls, so a pick posted between them was steered into the turn on
    /// the OLD model and its delivery fenced `consumed`, lost with no notice (6/40 release-gate
    /// timeouts). A post and its delivery are one transaction (`wake`), and SQLite serializes
    /// writers: here a post is visible with its pick, or not at all.
    /// Guard: buddies-v2 "an explicit pick posted inside the tool-call window is never steered".
    pub fn take_steering(&mut self, actor: &Actor, run_id: &str, root_id: &str, trigger: SteerTrigger, limit: i64) -> Result<Steering> {
        let buddy_id = reader(actor)?.to_string();
        self.write(|tx| {
            let root = readable_root(tx, actor, root_id)?;
            if !live_turn(tx, &buddy_id, run_id)? {
                return Ok(Steering::Quiet);
            }
            if pick_queued(tx, &buddy_id, &root.id)? {
                return Ok(Steering::PickQueued);
            }
            let page = unread_page(tx, &buddy_id, &root.id, limit)?;
            let owner = page.posts.iter().any(|post| post.author == Actor::Owner);
            let takes = match trigger {
                SteerTrigger::AnyPost => !page.posts.is_empty(),
                SteerTrigger::OwnerPost => owner,
            };
            let Some(newest) = page.posts.last().filter(|_| takes) else { return Ok(Steering::Quiet) };
            advance(tx, &Actor::Buddy { id: buddy_id.clone() }, &root.id, &newest.ord)?;
            if owner {
                tx.prepare_cached("UPDATE run SET steered_at = ?2 WHERE id = ?1")?.execute(params![run_id, now_iso()])?;
            }
            Ok(Steering::Taken { posts: page.posts, unshown: page.unshown })
        })
    }

    /// A thread's unread posts for the Buddy, NOT marked read. Only for a reader that is not the
    /// Buddy's turn itself: a native sub-agent of a running turn sees the owner's message at its
    /// own tool boundary, while the read mark (and so the fence on the queued delivery) waits for
    /// the parent turn, which alone takes it (mcp.ts `steerNativeTool`).
    pub fn peek_thread_unread(&mut self, actor: &Actor, root_id: &str, limit: i64) -> Result<ThreadUnread> {
        let buddy_id = reader(actor)?.to_string();
        self.write(|tx| {
            let root = readable_root(tx, actor, root_id)?;
            unread_page(tx, &buddy_id, &root.id, limit)
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
                    &format!("SELECT r.buddy_id, coalesce(p.root_id, p.id), coalesce(r.started_at, r.created_at), r.status <> 'queued',
                     CASE WHEN r.status = 'queued' THEN ({WAITING_REASON_SQL}) ELSE NULL END
                     {RUN_WITH_ACTIVITY_SQL} JOIN post p ON p.id = r.input_id
                     WHERE r.input_kind = 'deliver' AND r.status IN ('queued','running','cancel_requested') AND p.channel_id = ?2
                     ORDER BY r.created_at"),
                )?
                .query_map(params![now_iso(), channel_id], |r| {
                    let waiting = r.get::<_, Option<String>>(4)?.map(|json| serde_json::from_str::<RunWaiting>(&json).map_err(|error| crate::store::corrupt(CoreError::Corrupt(format!("run waiting reason {json:?}: {error}"))))).transpose()?;
                    Ok(Responding { waiting, buddy_id: r.get(0)?, thread_root_id: r.get(1)?, started_at: r.get(2)?, running: r.get(3)? })
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
