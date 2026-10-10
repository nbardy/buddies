# 2026-09-30: a backend death drops every running worker

Owner report (#case-studies, post_01a0f2bc-03b8): Wave Simulation Lead's runs were
marked "interrupted by host restart" at 22:09:34 Makassar (14:09 UTC).

## What happened (evidence)

- The machine did not reboot (`last reboot`: 18:15). `pnpm dev:replace` did not run: the
  supervisor (pid 12732) has been up since 18:36. Only the backend child restarted
  (pid 54232, started 22:09:27).
- At 13:48 UTC the old backend (boot 499727af) queued a reload and kept running to drain
  11 active operations. That is the designed behaviour (`server/src/lifecycle/shutdown.ts`).
- The old backend was still logging attempt activity at 14:09:26.5. The new boot
  (56926d25) came up at 14:09:28. The old one logged no shutdown, no "Server is
  restarting" message and no terminal attempts, so it died abruptly (crash or SIGKILL).
  The ~1.5 s gap matches `tools/watch-server.mjs`: an unexpected exit leads to a restart
  after a 1 s backoff.
- The new boot marked all 10 open attempts `attempt_recovered` / `server_restart`
  (`turn_attempt_event` in `~/.agent-viewer/observability/turn-attempts.sqlite`).
- The same thing happened at 12:34 UTC (20:34 local), with 14 attempts orphaned.
- 14:09:42–47: auto-resume of run_01a0f21f failed 4 times with `thread 01a0f24f… already
  has an active writer`. The OLD codex process was still alive about 15 s after the
  backend died. The new backend neither re-attached to it nor waited for it; it started
  a second writer on the same thread.
- No crash report in ~/Library/Logs/DiagnosticReports and no fatal entry in errors.jsonl.
  The exit code/signal line ("Backend exited (…)") is printed only to the supervisor's
  terminal, so the cause is still unconfirmed.

## Why workers do not survive

`detached: true` (server/src/turns/runner.ts → agent-cli execute.ts → process-runner.ts)
only gives the agent CLI its own process group. A group signal to the server therefore
does not hit it. But:

1. stdio is still `pipe`d to the backend. When the backend dies, nothing reads the
   agent's output, and its next write gets EPIPE, so it dies soon after.
2. The event stream (transcript fold, attempt state, Buddy run completion) exists only in
   the backend's memory. There is no re-attach: on boot, every open attempt is
   declared interrupted.

So restarts are survivable only when they are graceful. A reload drains work first. A
crash or kill loses in-flight turns. No "keep workers running across a backend death"
code was ever built; `detached` never meant that.

## Fix options

1. Real detachment: the agent writes its stdout JSONL to a per-attempt file, not a pipe.
   Record pid + start time + offset on the attempt. On boot, a live pid → re-attach by
   tailing from the offset. A dead pid → interrupted, then resume.
2. Guard now: before auto-resume, check whether the old writer pid is still alive. Wait
   for it, or adopt it; never start a second writer. (That is the "active writer" failure.)
3. Observability: the supervisor journals backend exit code/signal and uptime to
   errors.jsonl, so the next death has a cause.

## Cause of death (follow-up, same day)

Both of today's abrupt backend deaths were **native crashes**, not reloads, signals or reboots:

| Crash report (`~/Library/Logs/DiagnosticReports/Retired/`) | pid | launched | crashed |
|---|---|---|---|
| `node-2026-09-30-203543.ips` | 17864 | 18:43:05 | 20:33:54.8 |
| `node-2026-09-30-220933.ips` | 7154 | 20:33:54.6 | 22:09:27.3 |

- Both reports: parent 12732 (the dev supervisor). `EXC_BAD_ACCESS / SIGBUS`, subtype
  "FS pagein error: 22 Invalid argument". The faulting thread is a `tokio-rt-worker`
  whose whole stack is inside `buddies-core.node`.
- The fault address is not in the addon image. It is in a 32 KB `mapped file` region,
  `rw-/rwx SM=ALI`. The same VM object ids (7c0cf6bc, 1161040f) appear in both crashes,
  so it is a shared file mapping. SQLite maps a WAL index (`-shm`) in 32 KB chunks, and
  buddies-core opens only `~/.buddies/buddies-v3.sqlite`. So the fault is a page-in of
  `buddies-v3.sqlite-shm` that the kernel could not satisfy, as happens when the file is
  truncated under the mapping. (Inference: the report does not name the path.)
- Correlation: an agent ran Apple's `/usr/bin/sqlite3` (3.43.2) against the LIVE
  `~/.buddies/buddies-v3.sqlite` seconds before each crash:
  - 12:33:48.98Z, Claude session 33fe2267: `sqlite3 -readonly -header … select …`.
    Crash at 12:33:54.8Z.
  - 14:09:26.68Z, Claude session 8ab91752 (Task-pins worker, run_01a0f291):
    `sqlite3 -readonly … ".backup /tmp/pins2-home.*/…"`. Crash at 14:09:27.26Z.
  - Other live opens today did NOT crash: 12:35:08Z (select), 13:55:02Z and 14:18:22Z.
- Not reproduced: a node:sqlite WAL writer (360 KB -shm) and the real buddies-core addon
  on a scratch DB (128 KB -shm) both survived repeated `sqlite3 -readonly` selects and
  `.backup`. So the trigger is **strongly correlated, not proven**. Two crashes in about
  8 h, each within 6 s of one of 5 opens, is unlikely to be chance.
- The terminal scrollback (iTerm2, 1000 lines) no longer holds the supervisor's
  "Backend exited (…)" lines.

### Side finding: throwaway server launched real workers

At 14:09:26Z the same pins worker started a throwaway server (port 7611, HOME=/tmp copy,
DB copy) with `codex` on PATH. Its Buddy runner recovered the copy's 10 "interrupted"
runs and spawned 5 real codex workers (see /tmp/pins2-server.log). AGENTS.md forbids
this: a throwaway server must have no agent CLIs on PATH. The worker killed that server
at 14:09:46Z; no codex process parented to it remains.

### Next

- Stop agents from opening the live Buddies DB with the sqlite3 CLI until this is
  understood. For read-only inspection, use the server's HTTP/MCP reads, or `cp` the
  db+wal to a temp dir; `cp` never touches `-shm`.
- Journal the supervisor's child exit code/signal (fix 2 above). Here it would have
  read SIGBUS.
- To prove the trigger: run a looped repro with a large WAL on the real addon under
  concurrent load (several tokio readers mid-transaction), with the CLI
  `.backup`/select racing it.
