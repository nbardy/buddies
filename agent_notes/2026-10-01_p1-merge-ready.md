# P1 detach-and-adopt: merge-readiness pass (2026-10-01)

Task: task_01a0f2cb-48ba-722b-b0f6-07e4942fdb5c. Request: post_01a0f65a-888c-77d2-9089-5a2f653b1e0c.
Decision-maker: Buddies Development Lead (assistant). Nothing merged, nothing pushed; merge and
push wait for owner approval of the submodule push.

## Branches
- `continuity/p1-adopt`: candidate. It is ctrl-c-proof rebased onto main 8290148, plus the fixes below.
- `continuity/execution-adoption` (26d9e28) and `continuity/ctrl-c-proof` (c98b9ce): unchanged.
- `continuity/adopt-wip-2026-09-30` (cf24d45): the uncommitted diff the capped run left behind. It is preserved, not finished.
  - It has 10 type errors. The callers in runtime.ts, buddies/runner.ts, policy-port.ts and adopt-executions.ts were never updated, and the "grant revoked" state it reads has no persisted source.
  - It attempted four things: settling inside the policy, no grant revival after Stop or timeout, no deadline for turns that ended during the gap, and journal removal only after the settle.
  - The point-4 part is redone here in fc9094f. 2a and 2b remain open; see below.
- The dcg hook blocks `git checkout --`, hence a branch instead of a discard.

## Rebase
One conflict, in tools/watch-server.mjs (the stopping case). Main had added `appendExit(record('stopped'))`, and the Ctrl+C commit had added a `Backend stopped (...)` log line. Both are kept: ctrl-c-adoption.test.ts asserts on the log line.

## Independent review (sub-agent, read-only) against the four points
1. **Tool calls during downtime: no defect.** Writes are idempotent by key, and the grant is valid again after adoption. Caveat: the MCP endpoint listens before grants are restored in `loadConversations`, so calls in that window get 401 rather than connection-refused. Whether real CLIs give up on a 401 is unproven. **Open.**
2. **Stale credentials: confirmed.**
   - (a) Stop or timeout revokes only in memory. If the backend is SIGKILLed inside the 3 s SIGTERM to SIGKILL grace and the CLI is still alive, adoption re-registers the grant and nothing re-stops the turn. **Open.** A fix needs a persisted stop intent in the journal, plus a decision on how an adopted stopping turn settles (cancelled or failed).
   - (b) The journal is removed when the drain resolves, before the fire-and-forget run settle lands. A SIGKILL in that window recovers a finished run as interrupted. It is not double-settled, because the lease rejects a second settle. **Open.** No deterministic test exists in the current fixtures.
3. **PID reuse: confirmed, fixed.** Commits agent-cli 63a5c1b and outer 74ac993.
   - Before: `followJournal` liveness was `kill(pid,0)` and stop signalled `-pid`, so a lost wrapper whose pid was reused read as running, and stop killed the new owner's process group.
   - Now both require `isOwnWrapper`, and `discard`'s delayed SIGKILL does too.
   - Guard: agent-cli test/journal.test.ts "a lost wrapper whose pid was reused". It failed before the fix (stranger killed) and passes after.
4. **Deadlines: confirmed, fixed.** Commit fc9094f.
   - Before: a turn that finished cleanly during the gap, adopted after its deadline, was sealed as max_runtime_timeout.
   - Now adoption carries `AdoptedExecution` (running | ended). An ended execution arms no deadline, and its watchdog starts at adoption time.
   - Guard: execution-adoption.test.ts "finished during the gap". Before the fix: run failed with "maximum runtime after 10s". After: complete.

## Verification on fc9094f, clean tree, submodule at 63a5c1b
- `pnpm typecheck`: clean.
- `pnpm test:server`, run twice:
  - Run 1: 239 pass, 2 fail, 2 skipped. The extra failure was the ctrl-c-adoption "one Ctrl+C" test: "timed out waiting for journal writes while no backend runs; last: 1".
  - Run 2: 240 pass, 1 fail (the known `buddies-v2` › "a DM new chat opens the next generation"), 2 skipped.
  - The Ctrl+C test passed 6/6 in isolation (3 before the fixes, 3 after) and in the baseline full suite. It looks load-sensitive. **Open flake.**
- `pnpm test:client`: 219/220. `channel-restored` › "the Task filter shows one Task…" also fails on main 8290148; the branch touches no client or shared code.
- `pnpm test:dev-supervisor`: 16/16.
- Rust (crate `pnpm test`, `--no-default-features`): buddies 39/39, ingest 57/57.
  - Node boundary tests: ingest 3/3, buddies 1/2. `node.test.mjs` "a request, its run and its answer cross the napi boundary" (`post.request` undefined) also fails on main, reproduced in a throwaway main worktree.
- `pnpm test:cli` (agent-cli): 290/290.
- `execution-adoption.test.ts` 3× (2/2 each) and `ctrl-c-adoption.test.ts` 3× (4/4 each): all pass.
