# 2026-10-07: a live turn loses its lease (Task task_01a1122b-5dbb-70c1-b700-c5c97e92762d)

Worker investigation, branch `fix/live-turn-lease` from `97e337d`. Status: root cause found from
evidence. The fix below is an engineering decision by this worker, not an owner decision.

## Question

At 2026-10-06T16:53:14Z the claim gate ended five runs as `lease_expired` while their turns were
alive in the backend that held them (F8 worker run_01a11217-76c1, run_01a1120b-3a81,
run_01a1120b-5a2b, run_01a1120d-d9a1, run_01a1120e-f2c2). Why did the renewals stop?

## Root cause: the host machine slept for longer than the lease

The four candidates were the bridge heartbeat, renewal scheduling, event-loop starvation and adoption.
It was none of the four on its own. **The Mac was in Maintenance Sleep for 306 s, longer than the
300 s lease.** The backend and every agent CLI froze together. The lease is a wall-clock time in the
crate, and wall-clock time kept running through the sleep. At the DarkWake, the backend's overdue
timers ran first. One of them was the runner's claim-gate backstop, and it ended every lease that
had lapsed during the sleep. The heartbeats that would have renewed those leases arrived a few
milliseconds later and got `lease_lost`.

Evidence. `pmset -g log` times are local (+0800); they are converted to Z here. Error-journal lines
come from `~/.agent-viewer/observability/errors.jsonl` (no store was opened).

| Sleep → DarkWake (Z) | Sleep length | Error journal at that wake |
|---|---|---|
| 16:42:30 → 16:43:01 | 31 s | stall "up to 28655ms" (16:43:32) |
| 16:43:46 → 16:44:46 | 60 s | `Event loop stalled 58183ms` 16:44:46.529 |
| 16:48:08 → 16:53:14 | 306 s | `Event loop stalled 304406ms` 16:53:14.570, then 5× `lost its lease` 16:53:14.576–.586 |
| 16:53:59 → 16:59:02 | 303 s | `Event loop stalled 301453ms` 16:59:02.451; `MCP server unleashd_buddy failed during startup: no reply within 30000ms` 16:59:03.451 |
| 17:11:17 → 17:16:24 | 307 s | `Event loop stalled 305480ms` 17:16:24.719, then `lost its lease` run_01a11227-bcb7 17:16:24.961 |

- `monitorEventLoopDelay` counts the sleep as a stall, because Node's monotonic clock on this machine
  keeps running during sleep. So in this journal, every "stall" of about 300 s is a sleep, not
  blocking JS. On 2026-10-02 to 10-06 there are dozens of them, at about a 6-minute cadence: macOS
  Maintenance Sleep of about 300 s, then a 45 s DarkWake.
- Every `lost its lease` line since 2026-10-06T00:14Z sits 6–400 ms after one of these stalls
  (00:14:29.536 after a 304943 ms stall at .526, and the 16:53 and 17:16 cases above). There is no
  other occurrence.
- The machine had a 6% charge on AC with the display off, so macOS slept despite running work. The
  workers were not dead: F8 was still running tests at 16:59, after waking with the backend.

Why the gate wins the race at wake: libuv runs the timers phase before the poll phase. The runner's
backstop `setInterval(wake)` is overdue, so it starts `drain → claimRun`, and the crate's claim gate
(`expire_leases`) compares `lease_expires_at` with the wall clock. The agent-cli heartbeat is also a
timer, but its renewal goes `emit → queue → for-await (microtasks) → bridgeAlive → renewLease`, a
separate off-loop napi call. The heartbeat queues a renewal at the earliest; it never orders that
renewal before a claim already in flight.

The same mechanism applies to any real event-loop stall longer than the lease, so the fix does not
depend on sleep being the cause.

### The 16:59:03 MCP startup timeout (done criterion 4)

Run run_01a11222-ec31 started its turn during the 16:53:14 DarkWake. The machine slept again at
16:53:59 and woke at 16:59:02, so agent-cli's 30 s required-MCP probe timer timed out at
16:59:03.451, 1 s after the wake. Sleep explains it. Nothing in the endpoint failed, so it gets no
Task of its own. Its downstream effect was the lease loss at 17:16, which was the same sleep
mechanism again.

### The G resume failing into the busy conversation

Decision G works as designed for a dead holder. After a false `lease_expired`, the in-memory turn
continues unowned, so the conversation is busy here, and attempt 2 (run_01a11222-35ec) failed with
"Conversation is busy" and posted `run_failed`. Repairing G alone would have kept the false loss and
its failure notice. The fix removes the false loss.

## Decision (worker, proposed for lead review)

**Chosen: the claim gate never ends a run whose turn is alive in the backend that runs the gate.**
Before every claim pass, the runner awaits a renewal of each run held by a live turn in this process,
and then claims. A lease that lapsed while its own holder was frozen (sleep or stall) is not
evidence that the holder died, because the gate's own process was frozen too. This makes the
renewal happen-before the gate in-process, whatever the timer order at wake.

Rejected: **G recognises its own live turn and re-attaches.** That would resurrect a run the crate
had already ended: the requester was already told it failed, a late settle is rejected
(`lease_lost`), and "a stop is never undone" would need an exception. It would also need a second
path in the runner that asks "is this conversation's turn mine?", which is a structural branch that
the gate fix makes unnecessary.

Also rejected: **a longer lease.** Measured Maintenance Sleeps reach 307 s, but nothing bounds sleep
length, so any lease length fails eventually. It also brings back the dead-holder lie the 5-min lease
fixed (09-30 → 10-01, 9.5 h).

Residual risk, accepted: two backends on one store (a worktree backend sharing `~/.buddies`) that
wake together may still race, with one backend's gate ending the other's runs. That is one gate
against a different process, and the lease semantics there are correct ("that holder was silent for
the lease").
