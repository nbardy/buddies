# Error-log triage — 2026-10-05

Owner asked to inspect logs and fix actionable failures in the error-journal Task thread.
Read through `pnpm errors:list --limit=1000`; no direct journal or live SQLite access.

## Findings at approximately 08:55 UTC

- 682 retained unresolved groups. 65 groups have `lastSeenAt` on October 5 UTC:
  8 capacity, 6 HTTP 403, 39 event-loop, and 12 other groups. These are groups,
  not today's occurrence counts; each group's count spans its retained history.
- Codex capacity failures affect ordinary turns, workers and memory review.
  Recent reviewer diagnostics name `gpt-6-luna`. Repeated WebSocket 403 failures
  also affect workers and memory reviews. Logs prove rejected connections,
  not whether the cause is authentication, routing, account policy or service availability.
  No model/config changes or automatic retries were performed.
- Frequent 100ms+ stalls: inbox group `c0935a5d6075f520dd5512d8` has 1,815
  retained occurrences. Responding endpoints and swarm timers appear too. The
  monitor records last activity, not a causally proven blocking function.
  Follow-up: `task_01a10b47-33ed-765a-9d84-9ee3ae77993f`.
- Gate output included `<reasoning_effort>12</reasoning_effort>` before `<no>`
  (`ff21e1d427cec3f24b233d2b`), and another was only a thinking-mode tag
  (`7d149da17b39c873cbccccc6`). The existing 32-character cap can stop these
  runs before a decision arrives. Do not fix this by accepting arbitrary embedded yes/no.
  A separate follow-up Task records the boundary investigation and strict admission requirement.
- Restart recovery warnings and a queued reload are present. No backend-exit
  component groups were returned in this retained unresolved view; this is not
  proof that the backend has never crashed.

## Repair

`fingerprintError` normalized volatile IDs in messages and stack frames but hashed
the component verbatim. Components such as `buddy-run-run_<UUIDv7>` therefore
split the same capacity failure by run. Normalize the component with the existing
normalizer when computing the fingerprint; preserve the original diagnostic data.

Regression goes through the installed console capture and temporary journal files,
then reloads the journal. Two run IDs with the same capacity failure must yield one
group of count 2; a 403 failure stays separate. It failed before the repair (3 groups
instead of 2) and passes afterward.

Validation: error-journal tests 6/6; `pnpm typecheck` passed; selected-file Biome passed.
Historical stored fingerprints are preserved; this repairs future capture after backend
reload, without rewriting old groups. No unresolved incident was acknowledged: the
underlying provider failures and stalls have not been repaired.
