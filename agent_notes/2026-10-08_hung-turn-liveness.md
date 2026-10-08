# 2026-10-08 — Hung-turn liveness diagnosis and successor

Task: task_01a119c4-0545-71da-9ac5-79f9d3553b0b. Owner authorized fixing root issues,
refactoring, committing and pushing at 2026-10-08T07:31Z, post_01a11a6c-8660.
Implementation choice below is the engineer's choice under that mandate, not an owner-selected N.

## What the reported 6.5 hours actually establish

Run run_01a1185c-6b4d-749f-9569-008580e7daf1 belongs to conversation
38b91d03-923e-5820-8b28-3cff6ecc9893, attempt 84ee4f79-de6c-47a9-9582-5ba74c50aaf4.
Read through scoped `runs get` and authenticated GET of the conversation diagnostics on
2026-10-08 around 08:00Z. The preserved, scoped response is
`agent_notes/2026-10-08_hung-turn-liveness/attempt.json` (not a database read).

- Run started 2026-10-07T21:54:32.398Z, ended 2026-10-08T04:25:23.604Z:
  23,451.206 seconds unsettled.
- Original boot 9d553565-a7ea-4f00-a60f-bf9acc15af41 recorded `execution.resume` and
  `session.started` at 21:54:32.426Z. No later heartbeat, native-session advancement,
  text, tool or child event is recorded from that boot for this attempt.
- New boot a8c87063-8ca5-4093-ac53-1187ebf299cd adopted at 04:25:23.264Z;
  replayed `session.started` at .271Z; terminalised `provider_error` at .379Z.
- Run error: `codex exited without a terminal turn.complete event (exit=1; no content
  ever received; Error: thread/resume: thread/resume failed: failed to load configuration:
  Failed to synchronize managed preferences (code -32600))`.

This is NOT evidence of 6.5 hours of active or heartbeating Codex. It is evidence of a run
left unsettled until adoption drained its failed execution. The failure happened during resume;
its original exit time and the old backend's exit/freeze cause are unavailable in this API
snapshot. Do not infer a managed-preferences call itself lasted 6.5 hours. Error diagnostics
GET (status=all, limit=1000) returned no backend-exit groups.

`pmset -g log`, restricted to actual Sleep/Wake categories, had NO Maintenance Sleep on
2026-10-08. One overlapping Clamshell Sleep: 11:31:48–11:31:54 +0800
(03:31:48–03:31:54Z), six seconds. The long Maintenance Sleep cycles on October 7 local
ended before this attempt began (05:54:32 October 8 local). Sleep does not explain the gap.

## Which clock should have acted

At baseline origin/main 4f169034ab9355ef53feba4bd19629daec401a84:
`TurnWatchdog` already has a 2-minute bridge timer and a 60-minute provider-progress timer.
Codex declares no background-wait exemption. With a LIVE backend and no wrapper events the
bridge should fire first around 21:56:32Z; with wrapper-only heartbeats, provider idle should
fire around 22:54:32Z. A lease is a holder heartbeat, NOT either of those timers: the claim
gate expires a dead holder only while a backend is running and making claims. The removal
of background wall-clock budgets in dc299ec does not disable these idle clocks.

Neither a JavaScript watchdog nor a claim gate runs while its backend is dead/frozen.
The absent old-boot activity followed by adoption is consistent with loss of the observer,
not proof that a live watchdog ignored six hours of progress-free work. Adoption correctly
drained the failed journal without inventing a user stop. Adding another in-process timer
cannot enforce a cutoff throughout an absent-backend interval. An autonomous journal-wrapper
watchdog would be a separate design, with progress forwarding and suspend/restart semantics;
this change does not claim to implement one or kill a live turn just because its observer was down.

## Liveness choice and tradeoffs

Reuse ONE typed provider-idle clock, N=60 minutes, and existing `provider_idle_timeout`.
N is the already-established allowance for silent reasoning/tools; keeping it avoids inventing
a shorter policy from one unobserved attempt. It is configurable through the existing
CWV_TURN_PROVIDER_IDLE_TIMEOUT_MS (legacy CWV_TURN_IDLE_TIMEOUT_MS fallback).
Any normalized harness event, including child stream/task/subagent events or typed native-session
advancement, resets it. Timer-only wrapper heartbeats renew the bridge/lease but are not progress.

Remove the Claude launch-only widening to 60 minutes + 12 hours: knowing an agent was launched
is not evidence it is still progressing. This explicitly supersedes the implementation of
`turns/background-wait.ts` at the baseline commit. A child that streams keeps its parent alive;
a completely silent child/tool for 60 minutes now expires even if internally healthy. No
output-based policy can distinguish that case from a hang. Revisit N or add a typed observable
child-progress signal if real healthy silent work hits this boundary. No background absolute
runtime cap is restored; dc299ec stands. Foreground explicit deadlines and leases stay separate.

Preserve the existing persisted stop → signal → joined event/process drain → run settle path.
Carry the idle cause into the durable run instead of flattening it to `execution_failed`.
Adoption starts a fresh idle observation window and replays the journal, never kills a live
process solely because wall time elapsed while the observer was absent.

## Validation

The real-backend regression in `server/test/run-lease.test.ts` launches a fake background
Agent, then goes silent while wrapper heartbeats continue. Before the change its run stays
running past N (launch exemption); after, its run and attempt carry `provider_idle_timeout`,
its conversation is idle, and another request completes on the freed Buddy slot. A second
fake emits child deltas past twice N and completes normally. All stores are temporary.
Final verification counts and commit identity are reported in the Task handoff.
