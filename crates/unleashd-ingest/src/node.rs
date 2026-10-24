//! The napi boundary. Every call is async and runs on tokio's blocking pool (libuv never waits on
//! SQLite or a parse); the watcher runs on its own thread and reaches JS through a threadsafe
//! function. A panic in a call becomes a rejected promise.

use crate::engine::Report;
use crate::model::{ContextReading, Format, Message, Root, SessionRow, UsageQuery, UsageReport};
use crate::store::{MergePrefix, Reader};
use crate::watch::{self, IngestEvent};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::path::PathBuf;

/// Read-only connections `merged_counts` fans out over.
const MERGE_READERS: usize = 8;
use std::sync::{Arc, Mutex};

/// What `onChange` receives.
#[napi(discriminant = "t", discriminant_case = "camelCase")]
#[derive(Debug, Clone)]
pub enum ChangeEvent {
    /// A committed batch: sessions whose rows changed (call `listSessions({ since })`) and
    /// sessions that left the list.
    /// `rewritten` is the subset of `session_ids` whose history was replaced or renumbered rather
    /// than appended; refetch those from seq 0.
    Changes { rev: i64, session_ids: Vec<String>, rewritten: Vec<String>, removed: Vec<String> },
    /// A batch failed as a whole. Stored rows are unchanged; the next change retries.
    Failed { message: String },
}

#[napi(object)]
pub struct ScanReport {
    pub sources: u32,
    pub unchanged: u32,
    pub resumed: u32,
    pub full: u32,
    /// Why each full read happened (`unseen`, `rewritten`, `rebuild:Reordered`, …).
    pub full_reasons: std::collections::HashMap<String, u32>,
    pub removed: u32,
    pub failed: u32,
    pub messages_written: f64,
    pub bytes_read: f64,
    pub malformed_lines: f64,
    pub ms: f64,
    pub errors: Vec<String>,
    /// Roots that do not exist; they are not watched (restart once the provider creates them).
    pub missing_roots: Vec<String>,
    pub rev: i64,
}

#[napi(object)]
pub struct ListOptions {
    /// Revision already seen; 0 lists everything.
    pub since: i64,
}

#[napi(object)]
pub struct RemovedSession {
    pub session_id: String,
    pub source_path: String,
    pub rev: i64,
}

#[napi(object)]
pub struct SessionPage {
    /// Pass as `since` next time.
    pub rev: i64,
    pub rows: Vec<SessionRow>,
    pub removed: Vec<RemovedSession>,
}

/// One deep-search match.
#[napi(object)]
pub struct SearchHit {
    pub session_id: String,
    pub message: Message,
}

#[napi(object)]
pub struct MessagesOptions {
    /// Return messages with `seq` greater than this; -1 starts at the first message.
    pub after_seq: i64,
    pub limit: u32,
}

/// One bound session's settled prefix, as `mergedCounts` takes it.
#[napi(object)]
pub struct MergeSession {
    pub session_id: String,
    pub created_at: f64,
    /// The first `count` messages are the prefix.
    pub count: u32,
}

fn to_js(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::from_reason(format!("[panic] {e}")))?
}

#[napi]
pub struct Ingest {
    db: PathBuf,
    reader: Arc<Mutex<Reader>>,
    handle: Arc<Mutex<Option<watch::Handle>>>,
    report: Arc<ScanReportData>,
}

struct ScanReportData {
    report: Report,
    missing_roots: Vec<String>,
    rev: i64,
}

#[napi]
impl Ingest {
    /// Open (or create) the store at `dbPath`, bring it up to date with `roots`, and watch them.
    /// Resolves after the initial scan is committed; `onChange` also fires during that scan.
    #[napi(factory)]
    pub async fn start(
        roots: Vec<Root>,
        db_path: String,
        on_change: ThreadsafeFunction<ChangeEvent, (), ChangeEvent, Status, false>,
    ) -> Result<Ingest> {
        let path = PathBuf::from(&db_path);
        let (handle, started) = blocking(move || {
            let on_change = Arc::new(on_change);
            watch::start(roots, path, move |event| {
                let js = match event {
                    IngestEvent::Changes(c) => {
                        ChangeEvent::Changes { rev: c.rev, session_ids: c.session_ids, rewritten: c.rewritten, removed: c.removed }
                    }
                    IngestEvent::Failed(message) => ChangeEvent::Failed { message },
                };
                on_change.call(js, ThreadsafeFunctionCallMode::NonBlocking);
            })
            .map_err(to_js)
        })
        .await?;
        let db = PathBuf::from(db_path);
        let reader_db = db.clone();
        let reader = blocking(move || Reader::open(&reader_db).map_err(to_js)).await?;
        Ok(Ingest {
            db,
            reader: Arc::new(Mutex::new(reader)),
            handle: Arc::new(Mutex::new(Some(handle))),
            report: Arc::new(ScanReportData { report: started.report, missing_roots: started.missing_roots, rev: started.rev }),
        })
    }

    /// The initial scan's counts and timing.
    #[napi(getter)]
    pub fn initial_scan(&self) -> ScanReport {
        let r = &self.report.report;
        ScanReport {
            sources: r.sources as u32,
            unchanged: r.unchanged as u32,
            resumed: r.resumed as u32,
            full: r.full as u32,
            full_reasons: r.full_reasons.iter().map(|(k, v)| (k.clone(), *v as u32)).collect(),
            removed: r.removed as u32,
            failed: r.failed as u32,
            messages_written: r.messages_written as f64,
            bytes_read: r.bytes_read as f64,
            malformed_lines: r.malformed_lines as f64,
            ms: r.ms,
            errors: r.errors.clone(),
            missing_roots: self.report.missing_roots.clone(),
            rev: self.report.rev,
        }
    }

    #[napi]
    pub async fn list_sessions(&self, options: ListOptions) -> Result<SessionPage> {
        let reader = self.reader.clone();
        blocking(move || {
            let (rev, rows, removed) = reader.lock().map_err(to_js)?.list_sessions(options.since).map_err(to_js)?;
            let removed =
                removed.into_iter().map(|r| RemovedSession { session_id: r.session_id, source_path: r.source_path, rev: r.rev }).collect();
            Ok(SessionPage { rev, rows, removed })
        })
        .await
    }

    #[napi]
    pub async fn session(&self, session_id: String) -> Result<Option<SessionRow>> {
        let reader = self.reader.clone();
        blocking(move || reader.lock().map_err(to_js)?.session(&session_id).map_err(to_js)).await
    }

    #[napi]
    pub async fn messages(&self, session_id: String, options: MessagesOptions) -> Result<Vec<Message>> {
        let reader = self.reader.clone();
        blocking(move || reader.lock().map_err(to_js)?.messages(&session_id, options.after_seq, options.limit).map_err(to_js)).await
    }

    /// How many rows the server's session merge keeps for each group of sessions' prefixes (the
    /// conversation list's message count for a record bound to several sessions), counted in
    /// Rust over the stored rows: ONE call for all groups, no message crosses napi.
    ///
    /// Fix-guard (2026-10-23): the work is ~90 ms of CPU for 614 records, but on a cold page cache
    /// it is ~1,500 scattered range reads (~1.8 s) on one connection. The groups are split over
    /// `MERGE_READERS` read-only connections of their own (like `search`), so the reads overlap and
    /// the shared `reader` stays free for message pages.
    #[napi]
    pub async fn merged_counts(&self, groups: Vec<Vec<MergeSession>>) -> Result<Vec<u32>> {
        let db = self.db.clone();
        blocking(move || {
            let groups: Vec<Vec<MergePrefix>> = groups
                .into_iter()
                .map(|group| group.into_iter().map(|s| MergePrefix { session_id: s.session_id, created_at: s.created_at, count: s.count }).collect())
                .collect();
            let lanes = MERGE_READERS.min(groups.len()).max(1);
            let mut out = vec![0u32; groups.len()];
            let results: Vec<Result<Vec<(usize, u32)>>> = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..lanes)
                    .map(|lane| {
                        let (db, groups) = (&db, &groups);
                        scope.spawn(move || -> Result<Vec<(usize, u32)>> {
                            let reader = Reader::open(db).map_err(to_js)?;
                            (lane..groups.len())
                                .step_by(lanes)
                                .map(|i| Ok((i, reader.merged_count(&groups[i]).map_err(to_js)?)))
                                .collect()
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(Error::from_reason("[panic] merged_counts lane".to_string())))).collect()
            });
            for lane in results {
                for (i, n) in lane? {
                    out[i] = n;
                }
            }
            Ok(out)
        })
        .await
    }

    /// Provider-counted token usage of the turns in `[since, until)`, grouped by session, UTC day
    /// or model, plus the latest Codex rate limits. Replaces `/api/usage`'s transcript parsers.
    #[napi]
    pub async fn usage(&self, query: UsageQuery) -> Result<UsageReport> {
        let reader = self.reader.clone();
        blocking(move || reader.lock().map_err(to_js)?.usage(&query).map_err(to_js)).await
    }

    /// The latest request's context for a native session id (the context meter), or null when no
    /// transcript of that id records one. Replaces session-context.ts.
    #[napi]
    pub async fn latest_context(&self, session_id: String) -> Result<Option<ContextReading>> {
        let reader = self.reader.clone();
        blocking(move || reader.lock().map_err(to_js)?.latest_context(&session_id).map_err(to_js)).await
    }

    /// Deep search: the newest listed messages (at most `limit`) whose text contains `query`, ASCII
    /// case-insensitively. It scans the message table (~0.5-1 s on 290k messages), so it runs on
    /// a connection of its own and never holds the reader that serves message pages.
    #[napi]
    pub async fn search(&self, query: String, limit: u32) -> Result<Vec<SearchHit>> {
        let db = self.db.clone();
        blocking(move || {
            let hits = Reader::open(&db).map_err(to_js)?.search(&query, limit).map_err(to_js)?;
            Ok(hits.into_iter().map(|h| SearchHit { session_id: h.session_id, message: h.message }).collect())
        })
        .await
    }

    /// Stop watching and release `onChange` (so Node can exit). Idempotent.
    #[napi]
    pub async fn stop(&self) -> Result<()> {
        let handle = self.handle.clone();
        blocking(move || {
            if let Some(h) = handle.lock().map_err(to_js)?.take() {
                h.stop();
            }
            Ok(())
        })
        .await
    }
}

/// The standard provider roots under `home`, including any Gemini sandbox homes that exist.
#[napi]
pub fn default_roots(home: String) -> Vec<Root> {
    let home = PathBuf::from(home);
    let at = |format: Format, rel: &str| Root { format, path: home.join(rel).to_string_lossy().into_owned() };
    let mut roots = vec![
        at(Format::Claude, ".claude/projects"),
        at(Format::Codex, ".codex/sessions"),
        at(Format::Cursor, ".cursor/projects"),
        at(Format::Gemini, ".gemini/tmp"),
        at(Format::Opencode, ".local/share/opencode/storage"),
        at(Format::Muse, ".local/share/muse/sessions"),
    ];
    if let Ok(sandboxes) = std::fs::read_dir(home.join(".gemini-sandbox")) {
        for entry in sandboxes.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
            roots.push(Root { format: Format::Gemini, path: entry.path().join(".gemini/tmp").to_string_lossy().into_owned() });
        }
    }
    roots
}
