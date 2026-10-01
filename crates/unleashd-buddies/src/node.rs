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
    pub async fn authorize(&self, actor: Actor, op: Op, subject: Subject) -> napi::Result<Decision> {
        call(&self.store, move |s| s.authorize(&actor, op, &subject)).await
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
    pub async fn search_posts(&self, actor: Actor, workspace_id: String, query: String, before: Option<Cursor>, limit: i64) -> napi::Result<PostPage> {
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

    #[napi]
    pub async fn claim_run(&self, budgets: RunBudgets) -> napi::Result<Option<Claim>> {
        call(&self.store, move |s| s.claim_run(budgets)).await
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
    pub async fn cancel_run(&self, actor: Actor, run_id: String) -> napi::Result<Run> {
        call(&self.store, move |s| s.cancel_run(&actor, &run_id)).await
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
    pub async fn list_run_rows(&self, scope: ListScope, limit: i64) -> napi::Result<Vec<RunRow>> {
        call(&self.store, move |s| s.list_run_rows(scope, limit)).await
    }

    #[napi]
    pub async fn put_schedule(&self, actor: Actor, input: ScheduleInput) -> napi::Result<Schedule> {
        call(&self.store, move |s| s.put_schedule(&actor, input)).await
    }

    #[napi]
    pub async fn list_schedules(&self, query: ListScope) -> napi::Result<Vec<Schedule>> {
        call(&self.store, move |s| s.list_schedules(query)).await
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
