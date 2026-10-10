# 2026-10-07 — "execution was lost" for a live turn: the liveness probe dies of Ctrl+C

Task: task_01a11636-4f6f-761d-9e61-087f9060493c (child of core review task_01a115b8-5aa4-73d3-a8ed-aada574adde1).
Status: phase 1 (diagnosis) done; phase 2 (fix) is a PROPOSAL by the lead, awaiting the owner under the 2026-10-07 behavior freeze.

## Finding (worker, Opus, post_01a1163a-2c17-75f8-a971-91f9b97ae91f)
- `vendor/agent-cli-tool/src/journal.ts` `isOwnWrapper` runs `ps -o command= -p <pid>` via `execFileSync`.
  `ps` is a child in the BACKEND's process group, so a Ctrl+C (SIGINT to the group) kills it mid-call.
  The catch returns `false`, and `followJournal` resolves `lost` while the wrapper is alive.
- Repro: instrumented copy (/tmp/lostdiag), 3/3 runs `signal=SIGINT`, `end=lost`, `wrapperAlive=true`.
- Failing run log `/tmp/core-review-logs/server-ae5881f.log:1219,1223`: `lost` at 40:54.972, SIGINT handler at
  40:54.988. The handler runs after the blocking `execFileSync` tick has already resolved `lost`.
- Load is not the cause; it only makes `ps` slower, widening the window. Explains why the ctrl-c-adoption test
  passes alone and fails intermittently in full-suite runs.
- Live incidence: `pnpm errors:list --all --limit=1000` (786 groups, 2026-09-22 → 2026-10-07): 0 "execution was lost".
  Still reachable: any Ctrl+C of `pnpm dev` (or a dev-supervisor group signal) during a probe. Hot reload signals only
  the backend pid, so it does not.

## Test (failing-first)
Submodule branch `diag/lost-liveness` @ 6a826c0 (pushed; submodule main and outer pointer untouched):
`test/journal.test.ts` "a liveness probe that dies (ps killed by the Ctrl+C sent to the backend's group) never reads a
live wrapper as lost". Skipped unless `RUN_PHASE2=1`.
Lead re-ran it from a clean `git archive` of 6a826c0 (base 7a41287 src): RUN_PHASE2=1 → fails
(`a live wrapper is still being followed, not settled as lost`); default → 4 pass, 1 skipped.

## Proposed fix (assistant recommendation, NOT an owner decision)
`isOwnWrapper(): boolean` → `Liveness = Alive | Gone | Unknown(cause)`.
- `kill(pid,0)` ESRCH → Gone; `ps` exits normally without our dir → Gone (pid reused);
  `ps` killed by a signal / spawn failure / nonzero with no output → Unknown.
- followJournal: Alive/Unknown keep following; only Gone resolves `lost`.
- signalOwnGroup: signals only on Alive (today an interrupted probe silently skips Stop).
- executionProcess (boot): Unknown → live, so boot never discards a live agent's journal on a failed probe.
Tradeoff: a probe that keeps failing leaves a turn tracked until its max-runtime deadline instead of ending early.
Alternative considered: run `ps` outside the backend's group. Rejected as the sole fix: `spawnSync` has no `detached`,
and it would not cover other transient probe failures (EAGAIN); Unknown covers every failure cause in one variant.

Revisit if: a turn is observed stuck until max-runtime because the probe keeps returning Unknown.
