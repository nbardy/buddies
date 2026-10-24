# 2026-10-05 — Copied-store guard: Buddy execution gate

Task: task_01a0f2d0-cc9c-77a6-91b3-5a602168de7d. Incident: 2026-09-30 22:09, a throwaway
server on a `.backup` copy of the live Buddies DB, with codex on PATH, ended 10 runs as
`interrupted` and launched 5 real codex workers.

## Question
How does a backend on copied stores avoid launching real agent workers, given that tests
also point the stores at temp dirs and still need Buddies to run?

## Choice (worker built it; lead accepted it and merged to local main)
- One gate, decided once at composition: `admitExecution(decideExecutionGate(), live)` in
  `server/src/buddies/execution-gate.ts`. It covers scan and adoption of journaled
  executions, runner start and resume (scheduler, recovery follow-ups, worker spawns) and
  the memory reviewer. A disabled backend still serves data and owner commands.
- "Not the owner's default" means `UNLEASHD_BUDDIES_DB`, `BUDDIES_HOME` or
  `UNLEASHD_DATA_DIR` is SET and resolves somewhere other than the `$HOME` default.
  The opt-in is `UNLEASHD_BUDDY_EXECUTION=1` (documented in AGENTS.md).
- Alternative rejected: disabling on "any override is set". The worker measured the five
  suites that boot server.ts: execution-adoption runs on its default dir under a temp
  HOME, so a path-keyed rule needs only two opt-ins (run-lease, ctrl-c-adoption).

## Evidence
- Commits 7c88111 and b9955bb on fix/copied-store-guard (base 3a21efd). Merge 2e31fa4
  merges main 0c6a4cd into the branch; local main was fast-forwarded to it. Not pushed.
- Worker: the guard test fails on 3a21efd's server.ts (a real `claude` spawn) and passes
  on the branch. test:server on the branch (3 runs): 260 pass, 1 flaky failure each, a
  different one every run. On the base: 257 pass, 2 failures, also flaky.
- Lead, on 2e31fa4 with a clean tree: `pnpm typecheck` passed; copied-store-guard,
  run-lease, execution-adoption and auth passed 31/31. The full test:server suite was
  not rerun on the merge.
- Live backend (pid 2862, cwd ~/git/unleashd/server) sets none of the three store vars,
  so the gate stays enabled after reload. Checked with `ps eww`.

## Known gap
A copy placed at the default paths under a fake `HOME` is not gated, because
`os.homedir()` follows HOME. That is the execution-adoption test's setup. It is accepted
for now: agent CLIs under a fake HOME usually lack credentials. Revisit if a copied store
under a temp HOME ever launches a worker, or if the screenshots guidance moves to a
temp-HOME copy.
