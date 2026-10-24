# Test feedback speed — 2026-10-08

Owner request: ~5 s tests and parallel execution, post_01a11b4a-da31 (11:34Z), captured in
Task task_01a11b4b-e260-778f-91dc-be5347867547. Worker request
post_01a11b4b-e28a-70ca-83b8-68c67aa98486 coordinates existing port Task
 task_01a10d40-3970-76b3-a259-2de45ece3a84. Decision-maker: owner accepted the goal and
commit/push authority; the concrete four-file pool and fast subset are engineering choices.
No main integration, live runtime restart, or live-store inspection was performed.

## Choice and evidence

Source base d094cf36e73fa8837334da7147e8009a990b157b. Supplied baseline: 401.205 s,
333 passing tests, eight manual skips. Independently measured candidate source 912b2a6:

| Mode | Runner wall | Result |
|---|---:|---|
| First fast run (f643d63) | 1.689 s | 29 pass |
| Warm fast | 1.300 s | 29 pass |
| Cold transforms fast | 5.208 s | 29 pass |
| Warm full | 58.999 s | 334 pass, 8 manual skips |
| Cold transforms full | 58.569 s | 334 pass, 8 manual skips |
| Concurrent full A | 95.334 s | 334 pass, 8 manual skips |
| Concurrent full B, second clean worktree | 101.429 s | 334 pass, 8 manual skips |

“Cold” disables tsx's transform cache, not OS/dependency/addon caches. All addon checks hit
existing keys (~0.02 s combined). Runner wall includes child startup/drain/teardown, excludes
pnpm/addon wrapper overhead. Shared bootstrap/submodule setup was required for these worktrees;
no Rust source changed and no rustc ran. There is no fixed-port lock or serialized suite gate.
The concurrent runs used one four-file pool per worktree (eight files total).

The full suite remains tens of seconds: real process startup and repeated death/adoption join
with real timer periods. No claim that all coverage fits five seconds. The seven-file fast gate
is an explicit development subset, never release verification. Four-file bounded fan-out
protects interactive use; more parallelism is an opt-in experiment, not assumed faster.
`timings.json` preserves run measurements; `slowest-tests.json` preserves concurrent A's top
20 case durations (not file wall time). Raw logs/JUnit live in the main checkout's gitignored
`output/test-feedback-speed-2026-10-08/`.

## Changes and preserved failure meaning

- Auth 7527 and lease 7551–7554 were actual remaining fixed sockets. They now use the existing
  `freePortSync` allocator, passed to children. Adoption tests already used it at d094cf3.
  This is probe/release allocation, not a reservation; no remaining allocation race is claimed
  solved. Two simultaneous full suites passed without EADDRINUSE or crossing stores.
- Chrome already owns port 0 and discovers its port from its unique profile. No CDP change.
  Two concurrently opened sessions retained markers [1,2] and both were closed in finally.
- Follow (g) retains a 25 s requested wait, with a controlled later post at 100 ms and a
  <5 s inline-return assertion. It proves early delivery instead of sleeping 20 s. Other
  follow expiry/default-budget tests remain. Short delays used to arrange temporal scenarios
  are distinct from readiness/teardown sleeps.
- Lease period is 1 s; heartbeat checks 100 ms after 200 ms silence; idle is 6 s. Tests still
  observe multiple lease periods, kill a holder while a second backend remains up, and freeze
  the real backend for twice its lease. Freeze has a separate 15 s idle budget. Production
  constants are untouched. Kill grace/backstop use existing explicit budget injection.
- Normal no-backend relay timeout uses 1.5 s; success/restart holds remain 55 s. Real-time mode
  now omits the test override entirely, proving the default rather than explicitly setting55s.
  The override is honored only under NODE_ENV=test or existing UNLEASHD_DEV_PREBUILT=1 test mode.
- Ctrl+C cleanup clears the losing 20 s Promise.race timer in finally. Fake provider event
  iterators always resolve process completion on a throw while keeping the original event
  error; world.close waits for active drains before closing their MCP transport.
- Dropped-hook regression waits for a real backend close (Node HTTP diagnostics) while its
  pending-message query is held, then for that handler's end. This replaces the client's
  end callback and 200 ms guess. The receipt/message-loss/duplicate assertions remain intact.

## Failing-first controls and checks

f643d63 full: 331 pass / 2 fail / 8 manual skips, 106.866 s. Short relay budget was ignored by
NODE_ENV=development from the real dev supervisor; the relay opt-in now recognizes its existing
prebuilt-test mode. The dropped-hook failure was at the next-hook message assertion; controlled
backend close/handler-end removed that nondeterministic client-close fixture. Logs retained.

Removing fake-provider error completion in a temporary copy made the new async-error guard fail
at 5.001 s and leave teardown waiting. Only those deliberately broken mutation processes were
terminated after preserving the failure. The real guard joins process/event drain promptly and
checks the original error in the conversation transcript. No healthy worker/turn was stopped.

Candidate912b2a6: typecheck/line ceiling pass, client261 pass, invariant gates9 pass.
Three real-time relay cases passed in78.432 s: 10 s outage/exactly-once replay, 55 s hold expiry
with NOT delivered error and no later post, and revoked grant401 after Stop. A final unoverridden
55 s default proof runs on the final committed successor. Existing eight paid/manual skips are
unchanged. No receipt guard or lifecycle test is removed.

## Activation and reconsideration

The sole runtime-file edit is server/relay/buddy-mcp-relay.mjs's test-budget opt-in. Its changed
content changes RELAY_VERSION (mcp-relay.ts hashes the entire file). On a backend's next attach,
ensureRelay SIGTERMs an old-version relay and starts the new one on its stable port. A held
request on the old relay can fail during replacement. Existing live CLI processes keep their
configured URL if that port remains available. This lane pushes a branch only and does not
activate it. Integrate/restart only under the parent's release coordination, and rerun the final
fresh-install trial on the integrated SHA. The d094cf3 trial is evidence only for d094cf3.

Revisit pool4 if measured resource headroom improves and concurrent proofs still pass. Revisit
shortened lease budgets if loaded cold runs show scheduler stalls near a lease period. Revisit
the fast inventory when a new canonical contract needs everyday feedback; do not silently turn
it into the release gate. The target has been achieved for warm subset feedback, approximately
for cold transforms; complete lifecycle proof still needs real time.
