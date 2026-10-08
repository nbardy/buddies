//! The napi boundary. Every method is async: the call runs on tokio's blocking pool against the
//! one connection this object owns, so SQLite never runs on the JS thread. A panic inside a call
//! surfaces as a rejected promise. Errors carry their typed code as a `[code] message` prefix.

use crate::error::CoreError;
use crate::store::Store;
use crate::types::*;
use napi_derive::napi;
use std::sync::{Arc, Mutex};

#[napi]
pub struct BuddiesCore {
    store: Arc<Mutex<Store>>,
}

fn js_error(e: CoreError) -> napi::Error {
    napi::Error::from_reason(format!("[{}] {e}", e.code()))
}

async fn call<T: Send + 'static>(
    store: &Arc<Mutex<Store>>,
    f: impl FnOnce(&mut Store) -> crate::error::Result<T> + Send + 'static,
) -> napi::Result<T> {
    let store = store.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = store.lock().map_err(|_| napi::Error::from_reason("[poisoned] an earlier call panicked"))?;
        f(&mut guard).map_err(js_error)
    })
    .await
    .map_err(|e| napi::Error::from_reason(format!("[panic] {e}")))?
}

#[napi]
impl BuddiesCore {
    /// Opens (or creates) the database. Refuses a file that is not a buddies-core database.
    #[napi(factory)]
    pub async fn open(path: String) -> napi::Result<BuddiesCore> {
        let store = tokio::task::spawn_blocking(move || Store::open(&path).map_err(js_error))
            .await
            .map_err(|e| napi::Error::from_reason(format!("[panic] {e}")))??;
        Ok(BuddiesCore { store: Arc::new(Mutex::new(store)) })
    }

    #[napi]
    pub async fn post(&self, actor: Actor, channel: ChannelRef, input: PostInput) -> napi::Result<PostWrite> {
        call(&self.store, move |s| s.write_post(&actor, channel, input)).await
    }

    #[napi]
    pub async fn answer(&self, actor: Actor, input: AnswerInput) -> napi::Result<Post> {
        call(&self.store, move |s| s.answer(&actor, input)).await
    }

    #[napi]
    pub async fn get_post(&self, actor: Actor, id: String) -> napi::Result<Post> {
        call(&self.store, move |s| s.get_post(&actor, &id)).await
    }

    #[napi]
    pub async fn open_channel(&self, actor: Actor, channel: ChannelRef) -> napi::Result<Channel> {
        call(&self.store, move |s| s.open_channel(&actor, channel)).await
    }

    #[napi]
    pub async fn list_posts(&self, actor: Actor, query: PostQuery, before: Option<Cursor>, limit: i64) -> napi::Result<PostPage> {
        call(&self.store, move |s| s.list_posts(&actor, query, before, limit)).await
    }

    #[napi]
    pub async fn list_posts_from(&self, actor: Actor, query: PostQuery, post_id: String, limit: i64) -> napi::Result<PostPage> {
        call(&self.store, move |s| s.list_posts_from(&actor, query, &post_id, limit)).await
    }

    #[napi]
    pub async fn thread_stats(&self, actor: Actor, channel_id: String, root_ids: Vec<String>) -> napi::Result<Vec<ThreadStat>> {
        call(&self.store, move |s| s.thread_stats(&actor, &channel_id, &root_ids)).await
    }

    #[napi]
    pub async fn task_posts(&self, actor: Actor, task_id: String, before: Option<Cursor>, limit: i64) -> napi::Result<PostPage> {
        call(&self.store, move |s| s.task_posts(&actor, &task_id, before, limit)).await
    }

    #[napi]
    pub async fn search_posts(&self, actor: Actor, workspace_id: String, query: SearchQuery, before: Option<Cursor>, limit: i64) -> napi::Result<PostPage> {
        call(&self.store, move |s| s.search_posts(&actor, &workspace_id, &query, before, limit)).await
    }

    #[napi]
    pub async fn inbox(&self, actor: Actor, workspace_id: String) -> napi::Result<Inbox> {
        call(&self.store, move |s| s.inbox(&actor, &workspace_id)).await
    }

    #[napi]
    pub async fn mark_read(&self, actor: Actor, channel_id: String, post_id: String) -> napi::Result<()> {
        call(&self.store, move |s| s.mark_read(&actor, &channel_id, &post_id)).await
    }

    #[napi]
    pub async fn followed_threads(&self, actor: Actor, workspace_id: String, limit: i64) -> napi::Result<FollowedThreads> {
        call(&self.store, move |s| s.followed_threads(&actor, &workspace_id, limit)).await
    }

    #[napi]
    pub async fn mark_thread_read(&self, actor: Actor, root_id: String, post_id: String) -> napi::Result<()> {
        call(&self.store, move |s| s.mark_thread_read(&actor, &root_id, &post_id)).await
    }

    #[napi]
    pub async fn archived_channels(&self, actor: Actor, workspace_id: String) -> napi::Result<Vec<Channel>> {
        call(&self.store, move |s| s.archived_channels(&actor, &workspace_id)).await
    }

    #[napi]
    pub async fn set_channel_archived(&self, actor: Actor, channel_id: String, archived: bool, key: String) -> napi::Result<Channel> {
        call(&self.store, move |s| s.set_channel_archived(&actor, &channel_id, archived, &key)).await
    }

    #[napi]
    pub async fn rename_channel(&self, actor: Actor, channel_id: String, name: String, key: String) -> napi::Result<Channel> {
        call(&self.store, move |s| s.rename_channel(&actor, &channel_id, &name, &key)).await
    }

    #[napi]
    pub async fn create_channel(&self, actor: Actor, input: ChannelInput) -> napi::Result<Channel> {
        call(&self.store, move |s| s.create_channel(&actor, input)).await
    }

    #[napi]
    pub async fn read_doc(&self, actor: Actor, doc: DocRef) -> napi::Result<Option<Doc>> {
        call(&self.store, move |s| s.read_doc(&actor, doc)).await
    }

    #[napi]
    pub async fn write_doc(&self, actor: Actor, input: DocWrite) -> napi::Result<Doc> {
        call(&self.store, move |s| s.write_doc(&actor, input)).await
    }

    #[napi]
    pub async fn list_docs(&self, actor: Actor, buddy_id: String, kind: DocKind) -> napi::Result<Vec<Doc>> {
        call(&self.store, move |s| s.list_docs(&actor, &buddy_id, kind)).await
    }

    #[napi]
    pub async fn doc_revisions(&self, actor: Actor, doc_id: String) -> napi::Result<Vec<DocRevision>> {
        call(&self.store, move |s| s.doc_revisions(&actor, &doc_id)).await
    }

    #[napi]
    pub async fn upsert_task(&self, actor: Actor, write: TaskWrite) -> napi::Result<Task> {
        call(&self.store, move |s| s.upsert_task(&actor, write)).await
    }

    #[napi]
    pub async fn get_task(&self, id: String) -> napi::Result<Task> {
        call(&self.store, move |s| s.get_task(&id)).await
    }

    #[napi]
    pub async fn list_tasks(&self, query: TaskQuery) -> napi::Result<Vec<Task>> {
        call(&self.store, move |s| s.list_tasks(query)).await
    }

    #[napi]
    pub async fn task_counts(&self, workspace_id: String) -> napi::Result<Vec<TaskCount>> {
        call(&self.store, move |s| s.task_counts(&workspace_id)).await
    }

    #[napi]
    pub async fn enqueue_run(&self, actor: Actor, input: EnqueueInput) -> napi::Result<Run> {
        call(&self.store, move |s| s.enqueue_run(&actor, input)).await
    }

    /// A foreground chat input with its text (the queued run is the owner's message).
    #[napi]
    pub async fn enqueue_chat(&self, actor: Actor, input: ChatEnqueue) -> napi::Result<Run> {
        call(&self.store, move |s| s.enqueue_chat(&actor, input)).await
    }

    /// The owner promoted a queued message: claimed before the conversation's other queued chats.
    #[napi]
    pub async fn promote_chat(&self, actor: Actor, turn_id: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.promote_chat(&actor, &turn_id)).await
    }

    /// The owner cancelled a queued message.
    #[napi]
    pub async fn cancel_chat(&self, actor: Actor, turn_id: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.cancel_chat(&actor, &turn_id)).await
    }

    /// `channel_read {threadId, follow}`: subscribe (or, with no conversation, unsubscribe) this
    /// Buddy's conversation to a thread and return its unread posts, marked read (deliveries.rs).
    #[napi]
    pub async fn follow_thread(&self, actor: Actor, root_id: String, conversation_id: Option<String>, limit: i64) -> napi::Result<ThreadUnread> {
        call(&self.store, move |s| s.follow_thread(&actor, &root_id, conversation_id, limit)).await
    }

    /// The thread's unread posts for this Buddy, marked read (the follow wait's re-read).
    #[napi]
    pub async fn catch_up_thread(&self, actor: Actor, root_id: String, limit: i64) -> napi::Result<ThreadUnread> {
        call(&self.store, move |s| s.catch_up_thread(&actor, &root_id, limit)).await
    }

    /// One tool boundary of a live thread turn: its unread page, taken unless a queued delivery
    /// there carries an explicit pick (deliveries.rs `take_steering`; one transaction).
    #[napi]
    pub async fn take_steering(&self, actor: Actor, run_id: String, root_id: String, trigger: SteerTrigger, limit: i64) -> napi::Result<Steering> {
        call(&self.store, move |s| s.take_steering(&actor, &run_id, &root_id, trigger, limit)).await
    }

    /// The thread's unread posts for this Buddy, NOT marked read (a native sub-agent's view).
    #[napi]
    pub async fn peek_thread_unread(&self, actor: Actor, root_id: String, limit: i64) -> napi::Result<ThreadUnread> {
        call(&self.store, move |s| s.peek_thread_unread(&actor, &root_id, limit)).await
    }

    /// Request-addressed messages waiting for this conversation's live turn (messages.rs).
    #[napi]
    pub async fn pending_messages(&self, conversation_id: String) -> napi::Result<Vec<AddressedMessage>> {
        call(&self.store, move |s| s.pending_messages(&conversation_id)).await
    }

    /// Settles the receipts of messages a live turn was shown (messages.rs `acknowledge`).
    #[napi]
    pub async fn acknowledge_messages(&self, conversation_id: String, run_ids: Vec<String>) -> napi::Result<u32> {
        call(&self.store, move |s| s.acknowledge_messages(&conversation_id, &run_ids).map(|n| n as u32)).await
    }

    /// What a claimed delivery shows (deliveries.rs `compose`).
    #[napi]
    pub async fn deliver_posts(&self, run_id: String) -> napi::Result<Delivery> {
        call(&self.store, move |s| s.deliver_posts(&run_id)).await
    }

    /// The Buddies replying in a channel: its queued and running deliveries.
    #[napi]
    pub async fn responding(&self, channel_id: String) -> napi::Result<Vec<Responding>> {
        call(&self.store, move |s| s.responding(&channel_id)).await
    }

    /// The owner reruns a failed reply on another model (deliveries.rs `retry_delivery`).
    #[napi]
    pub async fn retry_delivery(&self, actor: Actor, post_id: String, buddy_id: String, config: RunConfig) -> napi::Result<Run> {
        call(&self.store, move |s| s.retry_delivery(&actor, &post_id, &buddy_id, config)).await
    }

    /// The holder is about to spawn (Pattern: durable-intake).
    #[napi]
    pub async fn mark_executing(&self, run_id: String, lease_token: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.mark_executing(&run_id, &lease_token)).await
    }

    /// The provider default a model-less run config resolved to at claim (decision J).
    #[napi]
    pub async fn record_run_model(&self, run_id: String, lease_token: String, model: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.record_run_model(&run_id, &lease_token, &model)).await
    }

    #[napi]
    pub async fn claim_run(&self, budgets: RunBudgets, held: Vec<RunHold>) -> napi::Result<Option<Claim>> {
        call(&self.store, move |s| s.claim_run(budgets, &held)).await
    }

    #[napi]
    pub async fn renew_run(&self, run_id: String, lease_token: String, lease_ms: i64) -> napi::Result<Run> {
        call(&self.store, move |s| s.renew_run(&run_id, &lease_token, lease_ms)).await
    }

    #[napi]
    pub async fn settle_run(&self, run_id: String, lease_token: String, outcome: Outcome) -> napi::Result<Run> {
        call(&self.store, move |s| s.settle_run(&run_id, &lease_token, outcome)).await
    }

    #[napi]
    pub async fn bind_run(&self, run_id: String, lease_token: String, conversation_id: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.bind_run(&run_id, &lease_token, &conversation_id)).await
    }

    #[napi]
    pub async fn defer_run(&self, run_id: String, lease_token: String, conversation_id: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.defer_run(&run_id, &lease_token, &conversation_id)).await
    }

    #[napi]
    pub async fn cancel_run(&self, actor: Actor, run_id: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.cancel_run(&actor, &run_id)).await
    }

    #[napi]
    pub async fn retry_run(&self, actor: Actor, run_id: String, config: Option<RunConfig>, key: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.retry_run(&actor, &run_id, config, &key)).await
    }

    #[napi]
    pub async fn create_workspace(&self, actor: Actor, input: WorkspaceInput) -> napi::Result<Workspace> {
        call(&self.store, move |s| s.create_workspace(&actor, input)).await
    }

    #[napi]
    pub async fn create_buddy(&self, actor: Actor, input: BuddyCreate) -> napi::Result<Buddy> {
        call(&self.store, move |s| s.create_buddy(&actor, input)).await
    }

    #[napi]
    pub async fn update_buddy(&self, actor: Actor, input: BuddyUpdate) -> napi::Result<Buddy> {
        call(&self.store, move |s| s.update_buddy(&actor, input)).await
    }

    #[napi]
    pub async fn get_run(&self, id: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.get_run(&id)).await
    }

    #[napi]
    pub async fn list_runs(&self, query: RunQuery, limit: i64) -> napi::Result<Vec<Run>> {
        call(&self.store, move |s| s.list_runs(query, limit)).await
    }

    #[napi]
    pub async fn list_run_rows(&self, reader: Actor, scope: ListScope, limit: i64) -> napi::Result<Vec<RunRow>> {
        call(&self.store, move |s| s.list_run_rows(&reader, scope, limit)).await
    }

    #[napi]
    pub async fn put_schedule(&self, actor: Actor, input: ScheduleInput) -> napi::Result<Schedule> {
        call(&self.store, move |s| s.put_schedule(&actor, input)).await
    }

    #[napi]
    pub async fn list_schedules(&self, query: ListScope) -> napi::Result<Vec<Schedule>> {
        call(&self.store, move |s| s.list_schedules(query)).await
    }

    /// "Run now": the schedule fires at once (one silent chat run, no post).
    #[napi]
    pub async fn fire_schedule(&self, actor: Actor, schedule_id: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.fire_schedule(&actor, &schedule_id)).await
    }

    #[napi]
    pub async fn due_schedules(&self, now: String) -> napi::Result<Vec<Run>> {
        call(&self.store, move |s| s.due_schedules(&now)).await
    }

    #[napi]
    pub async fn append_event(&self, actor: Actor, input: EventInput) -> napi::Result<Event> {
        call(&self.store, move |s| s.append_event(&actor, input)).await
    }

    #[napi]
    pub async fn list_events(&self, buddy_id: String, before_seq: i64, limit: i64) -> napi::Result<Vec<Event>> {
        call(&self.store, move |s| s.list_events(&buddy_id, before_seq, limit)).await
    }

    #[napi]
    pub async fn list_workspaces(&self) -> napi::Result<Vec<Workspace>> {
        call(&self.store, move |s| s.list_workspaces()).await
    }

    #[napi]
    pub async fn get_buddy(&self, id: String) -> napi::Result<Buddy> {
        call(&self.store, move |s| s.get_buddy(&id)).await
    }

    #[napi]
    pub async fn list_buddies(&self, workspace_id: String) -> napi::Result<Vec<Buddy>> {
        call(&self.store, move |s| s.list_buddies(&workspace_id)).await
    }

    #[napi]
    pub async fn bind_conversation(&self, actor: Actor, input: ConversationInput) -> napi::Result<Conversation> {
        call(&self.store, move |s| s.bind_conversation(&actor, input)).await
    }
}
