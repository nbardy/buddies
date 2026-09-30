# Worker continuity: double audit, root cause, rework (2026-09-30)

Author: Buddies Development Lead. Baseline: `7859e70` (read-only audit; no code changed).
Trigger: owner report in #case-studies, thread `post_01a0f2bc-03b8-772d-b42b-ea7b6c73daaf`
("Restarts should not cause dropped background workers … what happened to that code?"; then
"double audit, root cause and rework fix … it keeps breaking and rolling back").
Companion notes (same day): `2026-09-30_backend-death-drops-workers.md` (Buddies UI Engineer,
incident timeline), `2026-09-30_worker-continuity-restart-triage.md` (Product Dev Lead, source
triage + acceptance boundary). Task: `buddy_project_33bb3d10-9da0-4db3-84fe-7f9143ff5592`.

Two independent audits: A = git/design history (regression question), B = current runtime path
+ host logs (told NOT to read the UI Engineer's note). They agree on every point they both cover.

## 1. What killed the workers tonight (root cause: two layers)

### Layer 1: the backend is crashing natively (new finding, audit B, verified)

Both deaths (20:33:54 and 22:09:27 local) are native crashes, not JS exceptions, not restarts:

- `~/Library/Logs/DiagnosticReports/Retired/node-2026-09-30-203543.ips`
- `~/Library/Logs/DiagnosticReports/Retired/node-2026-09-30-220933.ips`

Both: `EXC_BAD_ACCESS / SIGBUS "FS pagein error: 22"`, kernel `cluster_pagein past EOF`, faulting
thread a `tokio-rt-worker` in `buddies-core.node`, on a 32 KB mapped file (SQLite WAL index
`-shm`). Verified by the lead with `grep` on both reports.

Mechanism (audit B, confidence ~85% for the enabling condition): the live backend held **no POSIX
SQLite locks** on its four databases when inspected, while the same addons in a fresh Node process
do hold them. With no lock visible, any outside opener believes it is the first connection and
truncates `-shm`; the backend's mapping then faults → SIGBUS. Candidate triggers: an agent ran
`sqlite3 -readonly ~/.buddies/buddies-v3.sqlite` 5.8 s before crash 1 and `sqlite3 … .backup`
0.6 s before crash 2 (correlation, ~65%).

This is the SAME failure class as 2026-09-25 (`crates/unleashd-ingest/src/store.rs:4-8`: a second
SQLite copy in-process closed a descriptor, dropped the locks, SIGBUS). That guard is a comment
only, lives in one crate, and wrongly concludes "other processes (the sqlite3 CLI) are safe" —
they are safe only while our own locks are held. **Nothing tests that the live backend keeps its
locks.** What drops them now is unknown (next step: `fs_usage`/dtrace on `close` for the backend
pid, or reproduce on temp stores: suspects are any in-process fd opened then closed on a DB inode
— a second SQLite copy, a file watcher/kqueue, a copy/backup/stat-open path).

Nothing recorded these deaths: the error journal sees only JS exceptions; the supervisor's exit line
goes to a terminal; and **`tools/watch-server.mjs` `onExit` in state `draining` logs "Backend
finished its active work" and never prints the code/signal** — tonight both crashes happened while
a reload was queued, so the supervisor mislabelled a SIGBUS as a clean drain.

### Layer 2: nothing lets a turn survive backend death (by design, since August)

Causal chain at HEAD (audit B; confirmed independently by audit A and PDL triage):

1. Spawn `detached: true` (`server/src/turns/runner.ts:313`) = own process group only. stdio are
   backend-owned pipes (`vendor/agent-cli-tool/src/process-runner.ts:70-80`). No pid/pgid/offset
   persisted.
2. Backend dies → nobody reads the pipe → provider output lost; the CLI dies at its next write
   (Codex lingered ~15 s).
3. Buddy MCP: random loopback port (`server/src/buddies/mcp.ts`), grants in a process-local Map
   (`grants.ts`) → a surviving agent loses its tools regardless.
4. Boot: `turn-attempt-journal.ts:114-130` marks every open attempt `server_restart`;
   `recover_runs` (`crates/unleashd-buddies/src/runs.rs:257-282`) fails every running run with
   `interrupted`, no liveness check.
5. `after_settle` queues a FailureNotice → `codex exec resume` on the sender's thread while the old
   Codex still owns it → Codex (not our code) refuses: "already has an active writer" ×4.
6. Non-crash paths are no better: SIGINT/SIGTERM, `dev:replace`, and supervisor IPC loss
   (`shutdown.ts:292` `disconnect → handleSigterm`) all `stop('server_restart')` = SIGTERM→SIGKILL
   the group. Only a *source reload* waits for idle (`shutdown.ts:29-35`), and it waits forever
   while still admitting work (reload starvation, `2026-09-29_dev-backend-reload-starvation.md`),
   which pushes people to `dev:replace`, which kills turns.

## 2. "What happened to that code?" (audit A)

| Commit | Date | Change | At HEAD |
|---|---|---|---|
| 9468bc5 | 02-05 | `detached:true` + `unref()`, SIGTERM stops killing; comment claims "restarted server re-adopts them via the file poller + PID tracker" | Gone. PID tracker never written; stdio stayed piped |
| 59c6330 | 02-25 | Replaced detach-on-SIGTERM with defer-and-drain (turns were being truncated) | Evolved into `shutdown.ts` |
| 6b5cbe2 | 02-25 | Spawn moved into agent-cli; "survives SIGTERM" comment + `unref()` deleted | `detached:true` remains, uncommented |
| 29ce9ac, 59da781 | 07-29 | `watch-server.mjs`; reload = IPC request, drain, exit | Present |
| d3ea123 | 08-22 | Design: daemon **reversed**; detach-and-adopt costed (needs file stdio) and shelved | Doc only |
| 039c303, ae9edc4 | 08-24 | Reload waits for idle; boot marks unfinished runs interrupted; doc §7 "No transparent survival guarantee … must not say 'agents are detached'" | Present |
| 24f7a49 | 09-24 | IPC loss treated as SIGTERM (stops turns); crash → auto-restart | Present |
| 966c8cc | 09-24 | `dev:replace` SIGKILLs recorded child group | Present |
| 9dfbe27 | 09-25 | Rust `recover_runs` unconditional interrupt | Present |
| 3c93975 | 09-26 | Deleted the 5 s file poller (last trace of Feb "re-adopt") + old lifecycle tests | Removed |

Verdict: the "detached workers" the owner remembers existed for 20 days in February and never
worked (piped stdio, no adoption). Since then the only real guarantee is "a cooperative source
reload waits for running turns". Crash/SIGKILL survival was **explicitly deferred** on 08-21 and
08-24. The lean rewrite did not delete a survival guarantee; none existed.

## 3. Why it "keeps rolling back" despite comments and tests

1. **The guarantee the owner believes in was never the guarantee we built.** Every fix protected
   the graceful-reload path; every other path (crash, SIGTERM, `dev:replace`, IPC loss) was
   designed to interrupt. Each incident on a non-graceful path reads as a regression.
2. **The tests enforce the bad behaviour.** `turn-attempt-journal.test.ts:69` and
   `crates/unleashd-buddies/tests/core.rs:615` assert blanket interruption; `shutdown.test.ts:334`
   asserts the backend exits when its runner goes away. The only "detached provider" test
   (`shutdown.test.ts:263`) uses `stdio:'ignore'` and never kills the backend — it proves drain,
   not survival. `watch-server.test.mjs:156` SIGKILLs a stub backend and checks only that it comes
   back.
3. **A misleading artifact survived.** `detached: true` with no comment reads like the feature.
4. **No pattern, no tag.** `docs/patterns.md` has no restart/survival pattern; no `Pattern:` tag in
   `lifecycle/`, `watch-server.mjs` or `runs.rs`. Nothing forces a reader to learn the boundary.
5. **The crash rate went up and was invisible.** The 09-25 SIGBUS fix lived as a comment; its
   recurrence tonight was hidden by the `draining` mislabel.

## 4. Decision record

- **Question:** must an active worker/conversation turn survive an abrupt web-backend death?
- **Prior decision (accepted, repo owner, 2026-08-24, `ae9edc4`):** no — crash/SIGKILL terminalises
  as interrupted; product wording must not claim detachment. Alternative B (detach + adopt) was
  "deferred, not rejected … the correct architecture if crash-transparent execution is a product
  requirement".
- **What changed:** the owner has now stated it IS a requirement (#case-studies thread above,
  2026-09-30: "Restarts should not cause dropped background workers, we should be detached").
  Owner decision; supersedes 08-24 §7 for web-backend replacement. Execution-host death (the
  provider process itself dying, or machine reboot) remains an explicit, visible interruption.
- **Approach (lead recommendation, proposed, not yet owner-reviewed):** detach-and-adopt, NOT a
  daemon. The provider process is the durable executor; a per-attempt file is the durable event
  log; the backend is a replaceable consumer that re-attaches. Reason: 08-21 round-2 review found
  detach-and-adopt adds zero streaming paths while a daemon adds one plus socket auth, contract skew,
  and its own supervision (and `dev:replace` group-kill would reach it). Revisit if adoption across
  agent-cli contract changes proves unworkable.
- **Still holds from August:** one writer, one settlement path, no competing recovery executor; a
  retry is a new explicit occurrence, never a silent replay.

## 5. Rework plan (children of the Task)

P0-a **Stop the crash.** Find what drops the SQLite locks in the live backend (reproduce on temp
  stores: boot, exercise, then check lock bytes from another process). Fix it. Guard: an
  integration test that boots the real backend on temp stores, runs representative work, and
  asserts from a second process that every store's lock is still held, and that an outside
  `sqlite3` open does NOT truncate `-shm`. Correct the `store.rs` comment. Add to AGENTS.md: never
  run `sqlite3` against live `~/.buddies` / `~/.agent-viewer` stores; read through the API.
P0-b **Make deaths visible.** Supervisor records code/signal/uptime in EVERY `onExit` branch
  (including `draining`) to a durable file; the next boot writes it to the error journal.
P0-c **One writer.** Never enqueue a resume or FailureNotice onto a provider thread whose previous
  writer pid is still alive (needs the pid record from P1; interim: record pid on the attempt now).
P1 **Detach-and-adopt.** File-backed stdout/stderr per attempt, no stdin pipe after the prompt;
  persist `{attemptId, runId, pid, pgid, processStartTime, outPath, offset, providerSessionId}`
  before `running`; fold by tailing. Boot: live pid with matching start time → adopt at offset,
  re-arm deadlines from persisted start; dead → interrupted. Stable MCP port + durable hashed grants
  (bound to run, revoked at settle). Reload/SIGTERM/IPC-loss exit WITHOUT killing adopted children;
  only an explicit Stop kills. Change `recover_runs` to adopt-or-interrupt.
P1-guard **Regression-proof.** The acceptance test from the PDL triage note (fake provider on temp
  stores, SIGKILL the backend mid-turn, new backend adopts; ordered output; a Buddy tool write
  succeeds after reattach; one writer; exactly one completion; Stop still kills and revokes).
  Runs in `pnpm test:server`. Rewrite the tests that assert blanket interruption. New
  `docs/patterns.md#detached-execution` + `Pattern:` tags at spawn, boot recovery, shutdown,
  supervisor. Comment `detached: true` with what it does and does not give.

Open questions: MCP calls during the ~1.5 s gap (does each CLI retry, or do we need a tiny stable
proxy?); whether Claude's CLI tolerates file stdout identically to pipes (08-21 experiment says a
file-backed child ran to completion); Windows is out of scope.

## 6. Successor (2026-09-30, later same day): root cause confirmed; unification proposal

**Crash root cause — confirmed by reproduction** (supersedes §1 "unknown"): `server/src/uploads/gc.ts`
(297f4ec, 2026-09-25) scanned every file under the data dir and the Buddies DB dir — the live
SQLite files included — from a `worker_thread`, i.e. inside the backend process. Each `close()`
released all of the process's POSIX locks on that inode. The next outside opener (sqlite3, a copied
backend) then reset the `-shm` the backend had mapped → SIGBUS. Temp-store repro: locks held before
the GC pass, all four stores unlocked after. Fix `b79b2c1` (GC in a child process) + guard
`server/test/sqlite-locks.test.ts` (fails on the old gc.ts) + pattern
`docs/patterns.md#store-descriptor-isolation`; evidence note `2026-09-30_sqlite-locks-sigbus-root-cause.md`
(`fdbe6f1`). Fast-forwarded to local main by the lead after rebase; guards 4/4 + typecheck green.
Remaining uncertainty: tonight's exact outside opener is inferred from timing, not traced.

**Classification.** Crash = small, 5-day-old regression (fixed). Worker loss on backend death =
architecture never built (P1 execution adoption, in progress).

**Map of work paths (Explore audit at 232c6fc):** one execution primitive (`TurnRunner.start`,
`runtime.ts:508-545`) reached by two admission routes: (a) conversation `TurnQueue` + chat run ticket
(owner chats, DM seats, channel seats) — durable row only once an item is queue head; (b) crate run
queue (DM requests, workers, schedules, returns) — durable in the same transaction as the post.
Channel @mentions are least durable: pair queues, gate verdicts, read marks, hop counts are memory only
(`channels.ts:49-51` admits it); the reply gate (`channel-reply-gate.ts`) and memory review spawn
outside the primitive. Task assignment starts no run.

**Proposal (lead recommendation, NOT yet owner-accepted):** one durable run per unit of work, written
in the same transaction as the message/post that caused it — owner chat messages and @mention /
follow-up replies become crate run rows like DM requests already are; the per-conversation queue is the
crate queue; the pair machine becomes a pure function over durable rows; the gate becomes part of the
reply run. With P1 adoption, a reload no longer drains: queued work is on disk, running work is
adopted. Revisit if per-message run rows measurably slow chat latency or bloat the runs table.
