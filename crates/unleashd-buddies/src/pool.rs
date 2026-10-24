//! One writer, many readers. Pattern: reader-pool (docs/patterns.md#reader-pool).
//!
//! `Database` owns the single writer `Store` and a small pool of read-only `Store`s on the same
//! WAL file. `write` hands the closure `&mut Store`; `read` hands it `&Store`. Every mutating
//! method takes `&mut self`, so a read closure cannot call one (compile time), and the pooled
//! connections are SQLITE_OPEN_READ_ONLY, so a raw write through them fails (run time).
//!
//! Why: every call used to take one `Mutex<Store>`, so 30 parallel thread reads, inbox polls and
//! the runner's writes queued behind each other (10 ms requests took 300 ms - 6 s under load).
//! WAL lets readers run beside the writer; each pooled call is one statement-sequence with no
//! long-lived read transaction, so it sees every commit made before it started.
//!
//! Classification rule (node.rs): a method that takes `&self` is a read; `&mut self` is a write.
//! Anything that records a marker (read cursors, leases, steering) is `&mut self` and goes to the
//! writer. A read that must be consistent with a following write belongs inside one `write`.

use crate::error::{CoreError, Result};
use crate::store::Store;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, TryLockError};

/// Readers kept open. Reads are short; this bounds descriptors and page-cache copies.
pub const READERS: usize = 4;

pub struct Database {
    writer: Mutex<Store>,
    readers: Vec<Mutex<Store>>,
    next: AtomicUsize,
}

fn poisoned<T>(_: std::sync::PoisonError<T>) -> CoreError {
    CoreError::Corrupt("an earlier call panicked".into())
}

impl Database {
    /// Opens (migrating if needed) the writer, then the readers, so the WAL exists for them.
    pub fn open(path: &str) -> Result<Database> {
        Database::open_with(path, READERS)
    }

    pub fn open_with(path: &str, readers: usize) -> Result<Database> {
        let writer = Store::open(path)?;
        let readers = (0..readers.max(1)).map(|_| Store::open_reader(path).map(Mutex::new)).collect::<Result<Vec<_>>>()?;
        Ok(Database { writer: Mutex::new(writer), readers, next: AtomicUsize::new(0) })
    }

    pub fn write<T>(&self, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
        let mut guard = self.writer.lock().map_err(poisoned)?;
        f(&mut guard)
    }

    pub fn read<T>(&self, f: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
        let guard = self.idle_reader()?;
        f(&guard)
    }

    /// The first free reader from a rotating start; if all are busy, wait on the rotating one.
    fn idle_reader(&self) -> Result<MutexGuard<'_, Store>> {
        let n = self.readers.len();
        let start = self.next.fetch_add(1, Ordering::Relaxed) % n;
        for i in 0..n {
            match self.readers[(start + i) % n].try_lock() {
                Ok(g) => return Ok(g),
                Err(TryLockError::WouldBlock) => {}
                Err(TryLockError::Poisoned(e)) => return Err(poisoned(e)),
            }
        }
        self.readers[start].lock().map_err(poisoned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pooled connections are the second line of defence behind `&Store`: a raw write fails.
    #[test]
    fn a_pooled_connection_refuses_writes() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path().join("p.sqlite").to_str().unwrap()).unwrap();
        let err = db.read(|s| s.conn.execute("UPDATE workspace SET name = 'x'", []).map_err(Into::into)).unwrap_err();
        assert!(matches!(err, CoreError::Sqlite(_)), "{err}");
    }
}
