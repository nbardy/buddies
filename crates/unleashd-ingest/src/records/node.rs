//! The napi boundary for conversation records. Every call is async and runs on tokio's blocking
//! pool against the one connection this object owns, so SQLite never runs on the JS thread.
//! Expected outcomes (conflict, exists, missing) are typed return values; only real failures
//! reject, with the message prefixed `[code]` (`sqlite` | `corrupt` | `invalid` | `schema`).
//!
//! Times are epoch milliseconds from the caller (`Date.now()`); the store formats them exactly as
//! `Date.prototype.toISOString` does.

use super::store::{Records, RecordsError};
use super::types::*;
use crate::model::Provider;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn js_error(e: RecordsError) -> Error {
    Error::from_reason(format!("[{}] {e}", e.code()))
}

async fn call<T: Send + 'static>(
    records: &Arc<Mutex<Records>>,
    f: impl FnOnce(&mut Records) -> super::store::Result<T> + Send + 'static,
) -> Result<T> {
    let records = records.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = records.lock().map_err(|_| Error::from_reason("[poisoned] an earlier call panicked"))?;
        f(&mut guard).map_err(js_error)
    })
    .await
    .map_err(|e| Error::from_reason(format!("[panic] {e}")))?
}

#[napi]
pub struct ConversationRecords {
    records: Arc<Mutex<Records>>,
}

#[napi]
impl ConversationRecords {
    /// Open (or create) the records tables in `dbPath`.
    #[napi(factory)]
    pub async fn open(db_path: String) -> Result<ConversationRecords> {
        let records = tokio::task::spawn_blocking(move || Records::open(&PathBuf::from(db_path)).map_err(js_error))
            .await
            .map_err(|e| Error::from_reason(format!("[panic] {e}")))??;
        Ok(ConversationRecords { records: Arc::new(Mutex::new(records)) })
    }

    #[napi]
    pub async fn get(&self, conversation_id: String) -> Result<Option<ConversationRecord>> {
        call(&self.records, move |r| r.get(&conversation_id)).await
    }

    #[napi]
    pub async fn find_by_session(&self, provider: Provider, session_id: String) -> Result<Option<ConversationRecord>> {
        call(&self.records, move |r| r.find_by_session(provider, &session_id)).await
    }

    /// Every record as a list row (active and deleted; filter on `status`).
    #[napi]
    pub async fn list_summaries(&self) -> Result<Vec<RecordSummary>> {
        call(&self.records, |r| r.list_summaries()).await
    }

    #[napi]
    pub async fn create(&self, input: NewRecord, at: i64) -> Result<CreateOutcome> {
        call(&self.records, move |r| r.create(input, at)).await
    }

    #[napi]
    pub async fn set_config(&self, input: SetConfig, at: i64) -> Result<SetConfigOutcome> {
        call(&self.records, move |r| r.set_config(input, at)).await
    }

    /// null = no such record.
    #[napi]
    pub async fn set_done(&self, conversation_id: String, done: bool, at: i64) -> Result<Option<ConversationRecord>> {
        call(&self.records, move |r| r.set_done(&conversation_id, done, at)).await
    }

    /// Tombstone. false = missing or already deleted.
    #[napi]
    pub async fn mark_deleted(&self, conversation_id: String, at: i64) -> Result<bool> {
        call(&self.records, move |r| r.mark_deleted(&conversation_id, at)).await
    }

    /// Remove the row (rollback of an unexposed creation). false = missing.
    #[napi]
    pub async fn purge(&self, conversation_id: String) -> Result<bool> {
        call(&self.records, move |r| r.purge(&conversation_id)).await
    }

    #[napi]
    pub async fn set_current_session(
        &self,
        conversation_id: String,
        binding: SessionBinding,
        at: i64,
    ) -> Result<Option<ConversationRecord>> {
        call(&self.records, move |r| r.set_current_session(&conversation_id, binding, at)).await
    }

    #[napi]
    pub async fn set_current_session_usage(
        &self,
        conversation_id: String,
        session_id: String,
        usage: ProviderTurnUsage,
        at: i64,
    ) -> Result<Option<ConversationRecord>> {
        call(&self.records, move |r| r.set_current_session_usage(&conversation_id, &session_id, usage, at)).await
    }

    #[napi]
    pub async fn add_session_binding(
        &self,
        conversation_id: String,
        binding: SessionBinding,
        at: i64,
    ) -> Result<Option<ConversationRecord>> {
        call(&self.records, move |r| r.add_session_binding(&conversation_id, binding, at)).await
    }

    /// Lease the first-message delivery to `token` (the caller's random UUID). null = not claimed.
    #[napi]
    pub async fn claim_initial_message_dispatch(
        &self,
        conversation_id: String,
        token: String,
        at: i64,
    ) -> Result<Option<ConversationRecord>> {
        call(&self.records, move |r| r.claim_initial_message_dispatch(&conversation_id, &token, at)).await
    }

    /// null = `token` does not hold the lease, or the message was already delivered.
    #[napi]
    pub async fn complete_initial_message_dispatch(
        &self,
        conversation_id: String,
        token: String,
        at: i64,
    ) -> Result<Option<ConversationRecord>> {
        call(&self.records, move |r| r.complete_initial_message_dispatch(&conversation_id, &token, at)).await
    }

    /// Queue an owner message at the back. false = the conversation is missing or deleted, or `id` exists.
    #[napi]
    pub async fn put_input(&self, conversation_id: String, id: String, body: String, queued_at: String) -> Result<bool> {
        call(&self.records, move |r| r.put_input(&conversation_id, &id, &body, &queued_at)).await
    }

    #[napi]
    pub async fn promote_input(&self, id: String) -> Result<bool> {
        call(&self.records, move |r| r.promote_input(&id)).await
    }

    #[napi]
    pub async fn mark_input_executing(&self, id: String, at: String) -> Result<bool> {
        call(&self.records, move |r| r.mark_input_executing(&id, &at)).await
    }

    /// true exactly once per row.
    #[napi]
    pub async fn settle_input(&self, id: String) -> Result<bool> {
        call(&self.records, move |r| r.settle_input(&id)).await
    }

    #[napi]
    pub async fn list_inputs(&self, conversation_id: String) -> Result<Vec<ConversationInput>> {
        call(&self.records, move |r| r.list_inputs(&conversation_id)).await
    }

    #[napi]
    pub async fn conversations_with_inputs(&self) -> Result<Vec<String>> {
        call(&self.records, |r| r.conversations_with_inputs()).await
    }
}
