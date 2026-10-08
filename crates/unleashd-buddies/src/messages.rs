//! Request-addressed messages (task_01a11a97; owner 2026-10-08 07:40Z "message worker / message
//! parent", 08:37Z "Complete all the work"; design agent_notes/2026-10-08_live-delivery-review/).
//!
//! Why this exists: a Buddy's self-spawned worker IS that Buddy, so parent and worker share one
//! Buddy id and one thread read mark. A plain inform in the request's thread is the author's own
//! post (`fan_out` never delivers it to its author) and the shared mark cannot say which of the two
//! conversations has read it. Reproduced 2026-10-08 (review reproduction 2): parent direction and
//! worker question both posted fine and neither live turn ever saw the other.
//!
//! A message addresses one ENDPOINT of a request instead: `worker` (the conversation its run is
//! bound to) or `parent` (the conversation the request returns to). It is one ordinary post in the
//! request's thread plus one `deliver` run for exactly that conversation, `delivery_scope`
//! `to_worker | to_parent`. That run is the receipt: the destination's live turn shows the post at
//! its next tool boundary and settles the run `consumed` (`acknowledge`); an idle destination runs
//! it as a turn through ordinary admission. The thread read fence and thread composes never touch
//! it (deliveries.rs `not_addressed!`), so a channel_read by the other endpoint cannot consume it.
//!
//! Endpoint authority is derived from durable rows at every send, never stored per message:
//! - worker = the LATEST attempt of the request's `post` run: its Buddy and bound conversation. A
//!   retry in a new conversation (provider change) moves the endpoint with it.
//! - parent = the request author's subscription to the request thread, the same route `answers`
//!   takes (deliveries.rs `deliver_to_spawner`): for an owner chat that is its background branch.
//!   NOT `request.conversation_id`: `bind_run` overwrites that with the worker's conversation.
//! A sender must write FROM its own endpoint's conversation; the same Buddy id alone is refused,
//! so a sibling worker of the same Buddy can neither read nor speak for another request.
//! Messages need an `awaiting` request. Closing it (answer, failure, cancel) fences every queued
//! `to_worker` message (`close`): a finished or stopped worker is never revived by a late message.

use crate::error::{CoreError, Result};
use crate::posts::{NewPost, POST_COLS, get_post, post_row, write_post};
use crate::runs::{RUN_COLS, cancel_queued, enqueue, run_row};
use crate::store::{collect, now_iso};
use crate::types::*;
use rusqlite::{OptionalExtension, Transaction, params, params_from_iter};
use rusqlite::types::Value;

/// One end of a request: the Buddy and, once it has one, the conversation that receives there.
struct Endpoint {
    buddy_id: String,
    conversation: Option<String>,
}

fn worker(tx: &Transaction, request: &Post) -> Result<Endpoint> {
    let run = tx
        .prepare_cached(&format!("SELECT {RUN_COLS} FROM run WHERE input_kind = 'post' AND input_id = ?1 ORDER BY attempt DESC LIMIT 1"))?
        .query_row([&request.id], run_row)
        .optional()?
        .ok_or_else(|| CoreError::Invalid(format!("request {} has no worker run", request.id)))?;
    Ok(Endpoint { buddy_id: run.buddy_id, conversation: run.conversation_id })
}

fn parent(tx: &Transaction, request: &Post) -> Result<Endpoint> {
    match &request.author {
        Actor::Buddy { id } => Ok(Endpoint { buddy_id: id.clone(), conversation: crate::deliveries::subscription(tx, id, request.root())? }),
        Actor::Owner => Err(CoreError::Invalid(format!("request {} is the owner's: reply in its thread instead", request.id))),
    }
}

fn require_awaiting(request: &Post) -> Result<()> {
    match &request.request {
        RequestState::Awaiting => Ok(()),
        other => Err(CoreError::Invalid(format!("request {} is not awaiting ({other:?}): its worker is done; send a new request", request.id))),
    }
}

/// The fields a message may carry. It is placed by its request: a thread, task, mention, run config
/// or second request would be silently overridden, so each is refused instead.
fn require_plain(input: &PostInput) -> Result<()> {
    let extra: Vec<&str> = [
        (input.kind == PostKind::Request, "kind request"),
        (input.reply_to_id.is_some(), "replyToId"),
        (input.task_id.is_some(), "taskId"),
        (input.run_config.is_some(), "worker"),
        (!input.mentions.is_empty(), "mentions"),
        (input.broadcast, "broadcast"),
    ]
    .into_iter()
    .filter_map(|(set, name)| set.then_some(name))
    .collect();
    match extra.as_slice() {
        [] => Ok(()),
        names => Err(CoreError::Invalid(format!("a request message takes only body, evidence and key; drop {}", names.join(", ")))),
    }
}

/// Writes the message post and its one receipt run. Called inside `write_post`'s idempotent write,
/// after channel access (`Op::Post` on the request's channel) was checked.
pub(crate) fn write(tx: &Transaction, actor: &Actor, request_id: &str, to: RequestEndpoint, input: &PostInput) -> Result<String> {
    require_plain(input)?;
    let request = get_post(tx, request_id)?;
    require_awaiting(&request)?;
    let (from, dest, sender) = match to {
        RequestEndpoint::Worker => (parent(tx, &request)?, worker(tx, &request)?, "parent"),
        RequestEndpoint::Parent => (worker(tx, &request)?, parent(tx, &request)?, "worker"),
    };
    let writes_from_endpoint = actor.buddy_id() == Some(from.buddy_id.as_str())
        && from.conversation.is_some()
        && input.from_conversation_id == from.conversation;
    if !writes_from_endpoint {
        return Err(CoreError::Denied(format!(
            "only the {sender} conversation of request {} may message its {}",
            request.id,
            to.as_str()
        )));
    }
    let conversation = dest.conversation.ok_or_else(|| {
        CoreError::Invalid(format!("request {}'s {} has no conversation yet (not started); send it once it runs", request.id, to.as_str()))
    })?;
    let channel = crate::posts::get_channel(tx, &request.channel_id)?;
    if channel.archived_at.is_some() {
        return Err(CoreError::Invalid("channel is archived; restore it before posting".into()));
    }
    let id = write_post(tx, NewPost {
        channel_id: &request.channel_id,
        author: actor.buddy_id(),
        root_id: Some(request.root()),
        reply_to_id: Some(&request.id),
        task_id: request.task_id.as_deref(),
        purpose: input.purpose.as_deref(),
        body: &input.body,
        evidence: &input.evidence,
        conversation_id: input.from_conversation_id.as_deref(),
        ..NewPost::default()
    })?;
    // No `after_write`: no subscription moves, no thread mark moves, no fan-out. The receipt run
    // below is the message's only delivery (one accepted write, one receipt).
    enqueue(tx, EnqueueInput {
        buddy_id: dest.buddy_id,
        input: RunInput::Message { post_id: id.clone(), to },
        conversation_id: Some(conversation),
        task_id: request.task_id.clone(),
        config: None,
    })?;
    Ok(id)
}

/// What a claimed message run shows: its one post (an idle destination's turn).
pub(crate) fn compose(tx: &Transaction, post_id: &str) -> Result<Delivery> {
    Ok(Delivery::Posts { posts: vec![get_post(tx, post_id)?], unshown: 0, subscribed: None })
}

/// The request left `awaiting`: its queued `to_worker` messages end, so nothing revives a worker
/// that answered, failed or was stopped. A `to_parent` message still reaches the parent (it is
/// information for a live endpoint). Called where a request closes (posts.rs `answer`, runs.rs
/// `close_request`).
pub(crate) fn close(tx: &Transaction, request_id: &str) -> Result<()> {
    cancel_queued(tx, "request_closed", Some("its request is no longer awaiting"),
        "input_kind = 'deliver' AND delivery_scope = 'to_worker' AND input_id IN (SELECT id FROM post WHERE reply_to_id = ?2)",
        params![now_iso(), request_id])?;
    Ok(())
}

/// Queued messages for `conversation`, oldest first: what its live turn's next tool boundary shows.
pub(crate) fn pending(tx: &Transaction, conversation_id: &str) -> Result<Vec<AddressedMessage>> {
    let runs = collect(
        tx.prepare_cached(&format!(
            "SELECT {RUN_COLS} FROM run WHERE conversation_id = ?1 AND status = 'queued' AND input_kind = 'deliver'
               AND delivery_scope <> 'thread' ORDER BY created_at, id"
        ))?
        .query_map([conversation_id], run_row)?,
    )?;
    runs.into_iter()
        .map(|run| match run.input {
            RunInput::Message { post_id, to } => {
                let post = tx.prepare_cached(&format!("SELECT {POST_COLS} FROM post p WHERE p.id = ?1"))?.query_row([&post_id], post_row)?;
                Ok(AddressedMessage { run_id: run.id, to, post })
            }
            other => Err(CoreError::Corrupt(format!("run {} has delivery_scope but input {other:?}", run.id))),
        })
        .collect()
}

/// The live turn of `conversation` was shown these messages: their runs settle `consumed`. Only
/// still-queued runs of that conversation settle; returns how many did.
pub(crate) fn acknowledge(tx: &Transaction, conversation_id: &str, run_ids: &[String]) -> Result<usize> {
    if run_ids.is_empty() {
        return Ok(0);
    }
    let marks = vec!["?"; run_ids.len()].join(",");
    let mut args: Vec<Value> = vec![now_iso().into(), conversation_id.to_string().into()];
    args.extend(run_ids.iter().map(|id| Value::from(id.clone())));
    let sql = format!(
        "UPDATE run SET status = 'cancelled', error_code = 'consumed', error = 'shown at a tool boundary', ended_at = ?1
         WHERE status = 'queued' AND conversation_id = ?2 AND delivery_scope <> 'thread' AND id IN ({marks})"
    );
    Ok(tx.prepare(&sql)?.execute(params_from_iter(args))?)
}

impl crate::store::Store {
    /// Messages waiting for `conversation_id`'s live turn (the host's tool-boundary collector).
    pub fn pending_messages(&mut self, conversation_id: &str) -> Result<Vec<AddressedMessage>> {
        self.write(|tx| pending(tx, conversation_id))
    }

    /// The live turn was shown these messages (the hook response was written, or the Buddy tool
    /// result carried them): their receipts settle `consumed`. Returns how many settled.
    pub fn acknowledge_messages(&mut self, conversation_id: &str, run_ids: &[String]) -> Result<usize> {
        self.write(|tx| acknowledge(tx, conversation_id, run_ids))
    }
}
