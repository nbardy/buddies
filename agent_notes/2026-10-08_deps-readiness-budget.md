# Dependencies test: separate readiness and hang budgets (test-only)

Branch `test/deps-readiness-budget`, based on origin/main 83fd4e1. Touches only
`server/test/dependencies.test.ts`. No product source changes.

## Failure being fixed

The f1011d0 full-suite rerun (`agent_notes/2026-10-08_f1011d0-full-suite-rerun.md`, failure 3)
failed `readiness requires a successful Yes…` with `['missing','failed','missing']` in 3,052 ms.
Every `createDependencyChecks` in the file used one 1,500 ms probe budget (production: 45 s,
`server.ts`). Under suite load, `/bin/sh` stubs that answer still took over 1.5 s. rustc/cargo
timed out and read as `missing`, and the claude Yes probe timed out and read as `failed`.

## Change

- `READY_BUDGET_MS = 30_000`: used by every instance whose probes are meant to answer, including
  the install budget for the first-boot and auto-install-off tests.
- `HANG_BUDGET_MS = 3_000`: a second instance used only for the hang assertion. The stub now sleeps
  60 s, and the message must name the budget (`no response within 3 seconds`). A hanging agent
  times out twice (`--version`, then the Yes probe), so this step takes about 6 s. Before, it took
  about 3 s.
- The sibling assertion (codex stays `ready` while claude hangs) still runs under the hang budget.
  Remaining exposure: one codex stub spawn would have to take more than 3 s. Before, 1.5 s was enough to fail it.

## Evidence (`output/deps-budget/` in the worktree, gitignored)

| Run | Patched | Unpatched (origin/main copy) |
|---|---|---|
| Ambient load ~8-11, 3 to 4 runs each | 4/4 pass every run | 4/4 pass every run |
| 40 `yes` busy loops (load average up to ~170), 4 runs each | pass | pass (CPU load alone does not reproduce) |
| Every stub prefixed with `/bin/sleep 2` (deterministic slow spawn) | 4/4 pass | **readiness fails `['missing','failed','missing']` in 3,040 ms**; first-boot also fails |

The 2 s slow-spawn run reproduces the production signature and timing exactly. That confirms the
mechanism. It also shows the first-boot test had the same exposure.

Typecheck: `tsc -p server/tsconfig.test.json --noEmit` exit 0. Lint: `biome check` is clean.
Wall time for the file at ambient load: about 12 s, up from 6-7 s.

## Inclusion

This is the test half of the next cut. It goes in with the reviewed steering-race fix SHA from
task_01a11a68. The next candidate's gates and DMG cover both. f1011d0 and its DMG stay unchanged.
