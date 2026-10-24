# Test concurrency follow-up — 2026-10-08

Successor to the first-pass speed decision at commit77c7729, preserved in
agent_notes/2026-10-08_test-feedback-speed/README.md at that commit. Owner asked
for more parallelism and profiling (post_01a11c09-4f83); request post_01a11c0a-1828.
Base: committed main ddca73e plus authoritative speed candidate6cb0f9d,
merge85b3e8d4ac45ecdc4e28684fbf3be13ec4b6dfe2. Dirty main was preserved.

## Choice, authority and alternatives

Engineering recommendation: keep default pool4. Parent accepted rejecting larger pools
and unproven splitting in post_01a11c17-80c3 and post_01a11c19-e471. The two-file
Ctrl+C split at experimental e3795d9c08b007a1c8d714c5ae4555f24e52b8c9 and its
holder-only idle-headroom override were dropped. Neither showed a speed gain.
Retained: wait for real turn settle before the next gated/authority-test reply;
close lease-case backends/providers after every case, including failed assertions.
All original assertions, case inventory, timing budgets and production defaults remain.

## Measurements and limits

Sequential same-cut85b3e8d warm full benchmarks:

| Pool | Runner seconds | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
|4|78.664|334|0|8|
|6|82.820|333|1|8|
|8|100.830|330|4|8|

Baseline wrapper measurements80.832/85.042/103.658 seconds used a2-second polling
loop, so include up to2 seconds observation error; runner time is the precise
comparison. Addons were warm cache hits. Pool6 raced reply visibility against turn
drain at the third-gate assertion. Pool8 raced the authority follow-up against drain,
and hit the unrelated6-second idle clock while starting backend B. Failed A/B then
left B running, invalidating freeze and idle scenarios in later cases.

Split e3795d9 pool4 passed334 in103.141s runner/103.717s wrapper. Pool6
333passed/1cancelled at the existing300s timeout,376.397s runner/377.146s wrapper.
Raw trace showed the worker falsely declared lost at1642ms, before SIGINT; both
chat and worker had spawned and captured sessions. Worker .during and a1509ms
NOT-delivered result existed. The combined two-journal assertion remained intact.
This is evidence for existing Task01a11636, not a performance-patch production fix.

The queued split pool8 started before the orchestration stop reached the loop.
That timing error was reported in post_01a11c19-263f. Its log has no final summary
and the worker later received execution_failed; preserve as interrupted, never a
verification result. Host restart is possible; the retry cause is unestablished
and must not be attributed to the pre-SIGINT test defect.

Host:10cores/24GiB. Baseline load~6–8; revised runs rose~13→23 and later~33,
with substantial unrelated application/system activity. Sequential experiments do
not eliminate that changing contention. These are not statistically isolated
speed comparisons, and no additional speed gain is claimed.

## Ranked costs and timer floors

Experimental pool4 file wall (includes module setup and teardown): execution-adoption
69.442s, buddies-v2 57.479s, run-lease45.554s, Ctrl+C restart38.119s/outage34.432s.
Adoption and lease cases share stores/backend handles/marker state: blanket case
concurrency changes their meaning. Ctrl+C could isolate module globals in separate
processes, but the extra concurrent startup did not prove worthwhile.

Execution-adoption repeatedly boots/crashes real backends; the gap-completion case
waits past8s+1s, runtime-timeout case observes6s and real kill grace, queue guard
observes2s. Lease observes multiple1s periods,6s provider idle, a1+2+2s freeze
sequence, and4s idle followed by8s child-progress observation. Ctrl+C runs the
pnpm/supervisor/watch/backend chain and retains the1.5s test hold,200ms outage,
and unaltered55s default stress path. Buddy cases repeatedly create real stores,
HTTP/MCP endpoints and runners, with in-process provider fakes; shared BackgroundWork
and diagnostics subscriptions require an isolation audit before case fan-out.

File wall minus case durations was~0.89s for adoption,1.36s Buddy and3.65s lease
in split pool4. This residual combines import/setup/hooks/exit overhead, not pure
cleanup. The dominant measured time is inside cases, including repeated process
startup and required clocks. No new production controller, clock or timer default.

Revisit concurrency only with stable host headroom and a focused A/B demonstrating
benefit while lifecycle guards pass. Keep the explicit fast subset distinct from
full lifecycle proof. Final exact-cut checks and raw evidence are recorded in
output/test-feedback-profile-2026-10-08/RESULT.md; no main movement or live activation.
