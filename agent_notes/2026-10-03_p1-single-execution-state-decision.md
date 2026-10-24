# P1 detach-and-adopt: one persisted execution state + exhaustive crash checker (2026-10-03)

Task: task_01a0f2cb-48ba-722b-b0f6-07e4942fdb5c (P1). Thread: #tc_01a0ee7d, root post_01a100ce-8dcb-71a2-9908-ddd5d6ecbd32.

## Question
The P1 candidate passes its real-boundary tests but grew the code (server/crate/tools source +701 net,
agent-cli +550, tests +1,165 vs main) and still has two crash-window defects. Merge as-is, or rework first?
Owner also asked: TLA+? pprof?

## Status
- Recommendation: Buddies Development Lead, post_01a100cf-907b-7456-9623-33c6a4b94879 (2026-10-03T08:09Z).
- **ACCEPTED by owner**, post_01a10105-50ed-7113-adf7-e7369cdcd5c0 (2026-10-03T09:08Z):
  "Okay, do all the work yes opus for systems design".

## Decision
Rework P1 before merge. Replace the three separate sources of one execution's truth with one
persisted sum type, driven by a pure transition function and checked by exhaustive small-scope
crash interleaving in `pnpm test`:
- The three sources today: the in-memory grant, the agent-cli journal file and the Buddy run row.
- The sum type: `Running | Stopping(intent) | Ended(outcome) | Settled` (names are the engineer's call).
Then stack the lease-heartbeat change (fix/lease-heartbeat @ 1ad0781) on top. The agent-cli push
and the merge to main still get an explicit owner go-ahead after the evidence is in.

## Why
- Defects 2a and 2b are both crash windows between those stores:
  - 2a: Stop/timeout revokes the grant in memory only. A crash inside the 3 s kill grace revives it on adoption.
  - 2b: the journal is removed before the run settle lands, so a finished run recovers as interrupted.
- With one persisted state written before each side effect, a crash at any point resumes from a defined state.
- The checker enumerates every crash point, which is what found and fixed the channel-dispatch
  ordering bugs (agent_notes/2026-09-28_channels-state-machine-review.md).

## Alternatives
- Merge as-is and patch 2a/2b point-wise. Rejected: each patch adds another cross-store handshake.
  The 2026-10-01 WIP (continuity/adopt-wip-2026-09-30, 10 type errors) showed that path tangles.
- TLA+/TLC spec. Fits the problem, but it needs Java tooling no one runs here, and a separate spec drifts
  from the code. Kept as the fallback if the in-repo checker's state space proves too coarse.
- pprof / CPU profiling. Not relevant: this is crash correctness, not CPU. The Ctrl+C flake is a
  timer-based wait for journal writes; the fix is to wait for the event.

## Evidence (historical versions)
- Candidate: continuity/p1-adopt @ 811f758. Merge-readiness note agent_notes/2026-10-01_p1-merge-ready.md
  at 811f758 (sha256 prefix bf0091b25d091091).
- Against current main c9d94e4 there is one conflict, in server/src/buddies/policy-port.ts (return route, 316ef1f).
- Uncommitted WIP in ../unleashd-ctrlc on p1-adopt, files dated 2026-10-01 23:33 to 2026-10-02 00:21 local.
  - It is 9 modified source files (+349/-57) and new tests: adoption-stop, adoption-settle-crash,
    mcp-boot-readiness, ctrlc-stress.tmp, and fixtures/adoption-backend.
  - Author/run unknown: no run on the P1 task covers it. Diff sha256 prefix ebd4c884fa25b08d.
  - It is input to the rework: preserve it on a branch, never discard it.

## Revisit if
- The single-state design can't express adoption without a fourth store.
- The checker can't reach the 2a/2b interleavings at small scope.
- The rework's net source lines exceed the candidate's.

## Successor 2026-10-03 ~09:15Z: agent-cli budget (owner concern)
Owner, in the same thread: "why did agent-cli grow +550 that seems too much, like a big problem".

**Measured, agent-cli 1b82d82..63a5c1b:** +656/−106 across 10 files.
- Tests: +172/−5.
- Source: +484/−101, so +383 net.
  - journal.ts is new: 261 lines, of which 44 are comments and 21 blank, leaving about 196 lines of code.
  - execute.ts: +147/−71 code lines. It REPLACED the pipe path; it is not a second path.
  - cli/index/runtime-types: about +20.
- Code-only net is about +290.

**Lead assessment (recommendation, not owner decision):**
- The core mechanics are needed: a detached spawn with stdio to files, an exit record, a follow-from-offset, and a pid-identity check.
- But `executionState(dir)` in agent-cli is a fourth derived view of the same execution. The server's `turns/executions.ts` (+127) mirrors it.

**Added to the rework's done criteria:**
- The one persisted execution state lives in the agent-cli journal record. The server reads it and does not keep a parallel copy.
- agent-cli source net, comments included, is at most +250 against 1b82d82, or each line over that is justified.
- Report agent-cli and outer numbers separately.

## Successor 2026-10-04 ~12:00Z: rework results (second resume, run_01a106a5, Opus)
Branch `continuity/p1-state` @ **d92c477** (worktree ../unleashd-p1state), agent-cli
`execution-journal-p1` @ **0acc04f**. Nothing pushed or merged; no backend restart. Stacked on the
lease change a503e92, on main 44bae74. Main has moved to a5a6c92 since then; rebasing is the
follow-through's step.

Commits this resume: 0acc04f (agent-cli), a913ef2 (server reads the one process view),
a6d2420 (2b guard reaches its crash on 811f758), d92c477 (Rust test compile fix after rebase).

### Decisions made by the worker (proposed; the lead/owner may revisit)
- **Where the one state lives.** The journal DIRECTORY is the one store. agent-cli owns the
  process facts (pid, exit.json) and exposes exactly one view of them,
  `executionProcess(dir) = unstarted | live(pid) | ended`, plus `killExecution`. The server's
  phase stays in `phase.json` inside that directory. It was NOT moved into agent-cli's
  `execution.json`: the phase means grant/settle/remove, which are server concepts, and an
  opaque owner slot in agent-cli would add lines there while making no file go away.
  The server no longer keeps a mapped copy: `FoundExecution` held both agent-cli's
  `executionState` and a server `ProcessAt` mapping; it now holds `executionProcess` only, and
  `discard` uses agent-cli's `killExecution` instead of its own TERM/KILL escalation.
  `Execution.phase` in memory is the single writer's last write and is never read at boot.
  Revisit if a second writer of `phase.json` ever appears.
- **2a outcome.** An adopted `stopping` turn settles by its intent: `user_stop` becomes
  `cancelled`, and `timeout` becomes `failed` with its terminal cause (`stopOutcome` in
  execution-state.ts). Stop always kills: adoption signals a live `stopping` journal again.
- **401 window.** Grants of live `running` journals are restored before the Buddy MCP endpoint
  listens (`liveGrants`); a stopped turn's grant is never restored.
- **`lost` completion flag removed** from agent-cli: it had no reader. A lost group still ends
  as reason `killed` with its "execution was lost" error.

### Evidence (on the commit; `git status --porcelain` empty)
| Gate | Result |
|---|---|
| typecheck | exit 0 |
| test:server | 250 pass / 1 fail / 2 skipped. The fail is `a DM new chat opens the next generation`: base 44bae74 requires `key` (804699b) and the test sends `{}`. Main fixed the test in 02b75b3, so it passes on main a5a6c92 and will pass after the rebase. |
| Rust buddies | cargo 41/41 after d92c477. Node boundary test: 1/2, and `a request, its run and its answer cross the napi boundary` also fails on main (post.request undefined) |
| Rust ingest | cargo all ok; Node 3/3 |
| agent-cli | 290/290 |
| dev-supervisor | 16/16 |
| crash checker + mutation check | 2/2 (every crash point; each broken rule caught) |
| 2a/2b guards on 811f758 (temp worktree, agent-cli 63a5c1b) | 3/3 FAIL on the defects. Stop: the grant answers 200, expected 401. Timeout: the turn revives and its journal is never removed. 2b: the finished run is settled `failed`/`interrupted`. |
| 2a/2b guards on this branch | 3/3 pass |
| Ctrl+C flake | 10/10 consecutive full test:server runs: each 250 pass; the 9 adoption/Ctrl+C tests pass every run, and the only failure is the pre-existing DM test. Root cause: each Ctrl+C test launch rebuilt agent-cli, whose build deletes the dist that the parallel test files import. Fix: `UNLEASHD_DEV_PREBUILT`, plus event waits instead of 30 s/120 s timers. |

### Net source lines (vs main, tests excluded, comments included)
| | 811f758 | this branch |
|---|---|---|
| agent-cli src vs 1b82d82 | +383 | **+246** (budget +250: met) |
| outer: P1 | +695 | +695 (same commits, rebased) |
| outer: lease change (task f7f0, separate) | n/a | +161 |
| outer: this rework | n/a | **+456** (+256 code, the rest comments) |
| P1 total excluding lease (outer + agent-cli) | +1078 | +1397 |

**Criterion "outer at or below 811f758" is NOT met (+456).** Where the lines go:
- execution-state.ts +250. The sum type, transition, adoption and grant tables, and applyStep.
  About 90 lines are the reasoning comments the brief requires.
- runner.ts +147: one handler per effect and per adopted phase (perform, signal, settle with
  retry until it lands, adoptRunning/Stopping/Ended).
- adopt-executions.ts +55 (adoption by table, grants before the MCP endpoint listens).
- executions.ts +33 (phase.json, step).
- Removed handshakes: turn-policy −40, policy-port −13, runtime −9, policy −7.
- agent-cli gave back −137.

Cutting the remaining excess would mean merging the three adoption tables or dropping comments
the brief asked for. That trade-off is the lead's call.

## Successor 2026-10-05: integrate onto current main and merge (lead decision)

Decision-maker: Buddies Development Lead, acting on owner authority recorded below. Prior text at sha256 prefix `064ff4128a768860` (file uncommitted).

- **Question:** the 10-04 owner DM "Choose when to merge P1" (post_01a106cd-6126) is still unanswered.
  Does P1 merge now?
- **Evidence of authority:** the owner said "complete commit and merge" (post_01a10106-3917, 10-03). On
  10-05 the owner asked "Whats left here? Can we complete it" about the parent Task (post_01a10bca-e0b4).
  The PDL completion request (post_01a10bcc-901d) says to use the 10-03 authorization, not to re-ask, and to
  stage a safe idle activation.
- **Why merging is the safe idle activation:** the live backend runs under `dev-supervisor --replace`.
  On a source change, watch-server asks the backend to drain, and it reloads only after running turns
  finish (tools/watch-server.mjs, states Running → Draining). No running turn is killed. Main took 55
  commits between 10-04 and 10-05 through that same path. What the owner reserved on 10-03 was the
  restart "that kills running work", and this merge does not do that.
- **Mechanics:** `git merge --no-ff main` into `continuity/p1-state-main`, at 3a21efd. A rebase hit a
  conflict at the first commit, and one merge resolves it once. The single conflict was in
  server/src/server.ts: main hoisted PORT/portNumber, so the branch's duplicate line was dropped. Local
  main is then fast-forwarded only if the full gate is green on 3a21efd. Main is not pushed.
- **Still open, owner:** the pending-delivery schema review (post_01a10bcf-7055). The line budget
  (+456 over 811f758) was reported to the owner on 10-04, and it does not block the merge.
- **Revisit if:** the drained reload is observed killing a turn. If so, stop merging runtime changes
  without an owner-timed window.
