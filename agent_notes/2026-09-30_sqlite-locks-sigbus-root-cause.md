# Backend SIGBUS: what dropped the live backend's SQLite locks (2026-09-30)

Task: `task_01a0f2cb-29d1-777b-a62a-508abae5baf3`. Request: `post_01a0f2cb-83fc-73a7-b23d-03e0e206b279`.
Predecessor: `agent_notes/2026-09-30_worker-continuity-double-audit.md` §1 (at `7859e70`).
Branch `wc/sqlite-locks` off `7859e70`. All reproduction ran on temp stores. Against the live backend
(pid 54232) this work only ran a read-only `lsof`, and nothing opened the live stores.

## Cause

`server/src/uploads/gc.ts` (landed `297f4ec`, 2026-09-25) scans every file under its reference roots.
Those roots include `APP_DATA_DIR` (`~/.agent-viewer`: `ingest.sqlite`, `conversation-records.sqlite`,
`observability/turn-attempts.sqlite`) and `path.dirname(buddiesDatabasePath())` (`~/.buddies`). The scan
does `fs.promises.open(file,'r')` → read → `close()` on every `*.sqlite`, `-wal` and `-shm`. It ran in a
`worker_thread`, which is the same process, and POSIX locks belong to the process. Each `close()`
therefore released every lock the addons held on that inode: the SHARED lock on the db file and the DMS
read lock on `-shm`.

A pass scans only when some upload entry is more than 30 days old. The live uploads dir has 309 of 357
entries with a directory mtime over 30 days old, so every live boot drops all four stores' locks seconds
after start. Any later opener in any process then:
- on open, takes the DMS lock, decides it is the first connection and truncates and re-initialises the
  `-shm` that the backend has mmapped. A backend page-in past the new EOF is `cluster_pagein past EOF`,
  i.e. SIGBUS, which matches both crash reports;
- on close, takes EXCLUSIVE, checkpoints and deletes (or truncates) the backend's WAL.

The audit's correlation fits: `sqlite3 -readonly` 5.8 s before crash 1 and `.backup` 0.6 s before
crash 2.

## Evidence (temp stores; lock probe = `fcntl(F_GETLK)` from a second process)

- Fresh backend with no stale uploads: all 4 stores `db-shared: R pid=<backend>`, `shm-dms: R pid=<backend>`.
- Same setup plus one upload entry dated 2026-01-01, after `[uploads-gc] deleted 1 entries … scanned
  12 files`: all 4 stores `db-shared: free shm-dms: free`.
- Mechanism check on a toy DB: one `os.open(-shm)` and `os.close` in the owning process turns
  `shm-dms: R` into `free`.
- Outside opener after the GC pass: `/usr/bin/sqlite3 buddies-v3.sqlite 'pragma journal_mode'` left the
  backend's `-wal` at 0 bytes. A `node:sqlite` open, one `SELECT` and close deleted the `-wal` and `-shm`
  of `ingest.sqlite` (98912 B) and `conversation-records.sqlite` (24752 B) while the backend ran.

## Fix

The GC pass runs in a forked child process (`runUploadsGcInChild`). A child's descriptors carry their
own locks, so reading the store bytes (still needed to find upload references in records and posts)
cannot touch the backend's locks. The IPC messages are tagged with the task because tsx's preflight
shares the channel. Pattern `store-descriptor-isolation` was added to `docs/patterns.md`, tagged at the
fix site and in `store.rs`, whose "other processes are safe" claim is corrected.

Alternatives considered:
- Skip SQLite files in the walk. This loses real references: Buddy posts can embed
  `uploads/<id>/…` of a conversation whose record is gone.
- Query references through the addons. This needs new native APIs, so it is a bigger change for the
  same guarantee.

## Guard

`server/test/sqlite-locks.test.ts` boots the real `src/server.ts` on temp stores with a stale upload,
waits for the GC pass, then opens every store from the test process with `node:sqlite` and asserts that
the WAL and `-shm` survive. Pre-fix it failed with: `ingest.sqlite: an outside opener found no lock held
by the backend (before {"wal":98912,"shm":32768}, after {"wal":"absent","shm":"absent"})`.

## Limits / not done

- The live backend still runs the old code. Its locks come back only after a restart onto this fix,
  and restarting is the owner's call. Until then, any outside `sqlite3` on the live stores can crash
  it or delete its WAL.
- Not audited: other in-process byte readers that a user can point at a store, such as the
  `/api/files?path=` style routes and swarm file reads. The guard covers the boot and GC path only.
- Whether the 2026-09-25 incident, attributed to the parity harness, also involved the GC (same day
  as `297f4ec`) is unknown.
