# Owner Buddy chats interrupted at ten minutes

The August 4 bridge-idle fix remains intact. The September Buddy coordination
implementation introduced a separate foreground deadline: `beginBuddyChatRun`
called `claimBuddyRun` without a runtime budget and inherited its 600-second
background default. The conversation deadline callback then called `stop()`,
misreporting the automatic cancellation as “Stopped by user.”

The event_calendars attempt `2ee31483-0de9-43bb-890e-a9a06d16fd48` started at
2026-09-10 03:24:43.388 UTC, emitted text at 03:34:20.136, and stopped at
03:34:43.417. The investigation itself reproduced it: attempt
`ffba0435-deb9-43eb-a71a-0907aaa0ad57` ran from 06:16:34.233 to 06:26:34.112.
Its durable Buddy run explicitly had a 06:26:34.225 deadline.

Foreground creation now receives `TURN_MAX_RUNTIME_MS`, defaulting to 24 hours,
and passes the same budget to the durable claim. The package defaults foreground
chat creation to 24 hours too. Background claims retain their 600-second default
and one-hour ceiling. Deadline failures enter the existing `max_runtime_timeout`
path; process and event drain still precede ownership settlement. Cancellation
and expired tool authority remain enforced.

Since T11 (2026-09-25) the Buddy side of the guard is `server/test/buddies-v2.test.ts`: the
runner leases every chat run for exactly `TURN_MAX_RUNTIME_MS`, and that lease is the chat's
deadline. The runtime side stays in `conversation-runtime.test.ts`. Originally, regression
coverage lived in `server/test/buddy-coordination.test.ts` (real
packaged store, authority after 11 simulated minutes, explicit budget, expiry,
cancellation, and unchanged background limits) and
`server/test/conversation-runtime.test.ts` (budget propagation, truthful timeout
cause, and joined process/event drain).

The backend reloaded cooperatively after the old turn ended. The resumed run
`buddy_run_e4e4baef-feaf-4de6-b863-1ca707abc338` started at 2026-09-10
06:29:05.864 UTC with a deadline of 2026-09-11 06:29:05.864 UTC, confirming the
new budget is loaded live. Existing attempts keep their assigned deadlines;
historical cancellation rows are retained as recorded.

Initial package source: the existing `system-finish-20260910` Buddies checkout. Its local
team-access changes are preserved; provenance marks this as a non-release local
snapshot. An earlier rebuild from the stale provenance commit omitted those
capabilities and was discarded after integration tests exposed the mismatch.

Verification: full server suite 262 passed, one opt-in test skipped, zero failures;
server TypeScript check passed. The focused runtime, package, and coordination
suite has 25 passing tests.

## End-to-end verification, September 10

The retained turn-attempt logs contain seven cancellations across three
conversations at 599.870–600.078 seconds. All seven were owner Buddy chats,
and all preceded the corrected backend loading at 06:26:35 UTC. Each had
provider text or tool activity within 27 seconds of cancellation. These were
real terminal transitions, not a frozen duration display. A general non-Buddy
conversation also completed after 903.733 seconds before the fix.

The owner's follow-up in this same conversation became the real wall-clock
test: attempt `61608db0-e4fc-45f3-8cac-0d27fa846327` started at
06:49:19.788 UTC. A read-only observer sampled authenticated conversation and
diagnostic endpoints every 15 seconds and listened to the normal WebSocket.
Across 35 samples through 07:00:44 UTC (684.459 elapsed seconds), the same
provider PID 97872 and server boot `29fd49b4-9427-476a-9fc1-16ce368797ee`
remained active, with the same attempt, running/streaming true, no terminal
cause, and no observer errors. Six WebSocket events arrived after 600 seconds.
The observer closed its own socket when its measurement finished.

The actual browser rendered **Running 11m 32s** at 07:00:53 UTC.
A native `buddy.get_runs` call succeeded at 07:00:52.767 UTC and returned
`buddy_run_275a1556-ae8b-42a7-bc39-657555ad5539` still running, with its
deadline on September 11 at 06:49:19.765 UTC. Thus the provider, runtime,
transport, rendered UI, and scoped Buddy tools all survived the former cutoff
within one uninterrupted turn. This verifies the ten-minute regression; it
does not claim a 24-hour soak test or explain unrelated interruptions.

Local evidence is in `output/timeout-e2e-20260910/`:

- `historical-cutoffs.json`: seven correlated start/end/activity records.
- `live-observation.jsonl` and `summary.json`: process, runtime and transport observations.
- `buddy-authority.json`: successful scoped calls after ten and eleven minutes.
- `after-eleven-minutes.png`: browser screenshot showing the live elapsed time.

## Preserve the fix

The failure was an omitted argument at a reused API boundary: foreground chat
creation used the same claim function as bounded background jobs. Its default
was valid for those jobs but silently became an owner-chat deadline. The August
heartbeat fix did not cover this later, independent cancellation path.

Code comments now document the invariant at `TURN_MAX_RUNTIME_MS`, the runtime
claim and deadline callback, and the milliseconds-to-seconds package handoff in
`server.ts`. `AGENTS.md` also links this incident for timer and package changes.
Keep the real packaged-store test that checks authority after eleven minutes,
explicit budgets, expiry/cancellation, and unchanged background limits, plus the
runtime test that checks budget propagation and truthful timeout cleanup. A
healthy heartbeat alone is not evidence that every layer permits a long turn.

At this follow-up, the replacement archive and installed package were checked
again: both retain the 24-hour foreground default and explicit budget forwarding.
Archive provenance now records clean source commit
`bd6e61de4ff7e2a34f6d85de49ec6d53d51e2b95`; the initial local-snapshot caveat
above describes the earlier packaging step.

## Successor, 2026-10-01: the lease and the deadline are separate values

The guard paragraph above says "the runner leases every chat run for exactly
`TURN_MAX_RUNTIME_MS`, and that lease is the chat's deadline". That was true until 2026-10-01.
Making the lease 24 h fixed this incident, but a run whose holder died then stayed `running`
until the next boot. It was a 9.5 h overnight lie on 2026-09-30→10-01, and 14 and 10 runs were
orphaned at 12:34Z/14:09Z on 09-30. The lease is now a 5-minute heartbeat renewed on the turn's
bridge clock (`BUDDY_RUN_LEASE_MS`). The deadline is the run's own `deadline` column, set at claim
from `TURN_MAX_RUNTIME_MS` passed explicitly as `chatDeadlineMs`.

This incident's rule is unchanged: a foreground chat's deadline is `TURN_MAX_RUNTIME_MS`, and
automatic expiry is `max_runtime_timeout`. `buddies-v2.test.ts` now asserts that budget on the
run's `deadline` instead of its `leaseExpiresAt`, and that is the only line of the guard that
moved. The runtime guards in `conversation-runtime.test.ts` are unchanged. Pattern:
`docs/patterns.md#lease-heartbeat`. Decision: `agent_notes/2026-10-01_return-route-decision.md`.
