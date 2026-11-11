# Expeditions prior art: oompa, today's expeditions, Workflows, AI-OS

Status: superseded by the [keyed expedition system](../keyed/v1/DESIGN.md); retained as historical design/research. Old host deleted 2026-11-11.

Status: research brief, 2026-11-09. Read-only survey to ground the v2 leader design
(`docs/expeditions-leader-design.md`). Every claim cites a path; numbers were measured
on 2026-11-09 unless dated otherwise.

Sources read:
- oompa: `~/git/oompa_loompas/{README.md, docs/SYSTEMS_DESIGN.md, docs/SWARM_PHILOSOPHY.md,
  docs/GOALS_CYCLES_DRIVE.md, docs/systems_architecture.md, docs/run-artifacts.md,
  docs/LEAN_DESIGN_STATUS.md, agent_notes/2026-10-*.md, notes/2025-01-myth_of_long_running_tasks.md,
  schemas/*.json, config/prompts/**}`
- real oompa run logs: `~/git/wave_sim/runs/*/{cycles,reviews}/*.json` (107 run dirs)
- buddies: `historical retry-loop design (git d7bb99a)`, `docs/expeditions-leader-design.md`,
  `expeditions/workflows-vs-expeditions.md`, `server/src/expeditions/*.ts`,
  `shared/src/expedition.ts`, `server/src/buddies/harness-steering.ts`, `server/src/swarm/*`,
  `docs/turn-lifecycle.md#execution-adoption`, `docs/patterns.md#lease-heartbeat`,
  `agent_notes/review_token_usage/FOLLOWUPS.md`
- live expedition records: `~/.agent-viewer/expeditions/*.json` and `.retired/*.json` (JSON only)
- AI-OS: `~/git/AI-OS/{README.md, examples/*.py, ai_os/core/macro_helpers.py}`
- Claude Code Workflow API: the workflow-authoring reference (agent/parallel/pipeline/budget/resume)

---

## 1. TL;DR for the designer

1. **Three generations already exist, and each failed differently.** oompa (flat swarm, file
   task queue) spent most cycles idle; ledger expeditions (Nov 1, ~13.5k lines) expressed a rich
   question/stage/validation model but all four runs hit the deadline with 0–1 verified claims;
   lean expeditions (Nov 3, ~2.3k lines) are robust but are a single-goal retry loop that cannot
   represent multi-phase work (the GTM case, leader design §1).
2. **What reliably worked** is the deterministic shell, not the agent cleverness: worktree per
   unit (Cambium), host-run checks on an immutable sha, serialized integration, typed holds,
   atomic JSON record + serialized step, execution journals with adoption, owner chat commands
   consumed by the host.
3. **What reliably failed:** prose-only plans; text-signal protocols (oompa `CLAIM(...)`, ledger
   "```json block"); validators that cannot run; owner-judged gates blocking the only slot;
   one seat playing both advocate and critic; idle polling of empty queues; loops with no cap
   (codex `/goal`: 20 h unbounded).
4. **Workflows give the right inner shape** (typed `agent()` + schema, `pipeline()` without
   barrier, resume by cached prefix) but are fixed at launch, single-session, Claude-only.
   Their resume-by-prefix idea maps directly onto "finished nodes are immutable" in v2.
5. **Token observation:** the dominant waste in every generation is *context re-sent*, not
   output. oompa: 613/1091 cycles (56%) were `no-claim` spins (13.9 h of wall clock). Ledger
   expeditions: input:output ≈ 13:1 and cache-read ≈ 13× fresh input (DualSPHysics: 1.6M in,
   120k out, 21.3M cache read over 19 attempts). Leader wakes must be batched and cheap.

---

## 2. oompa (`~/git/oompa_loompas`)

### 2.1 Execution model

| Concept | What it is | Where |
|---|---|---|
| Swarm | one `oompa run`; N workers in parallel, optional planner and reviewer; id `runs/<swarm-id>/` | `docs/systems_architecture.md` §Swarm Structure |
| Config | `oompa.json` `workers[]`: `model` = `harness:model[:effort]`, `prompt` (array, concatenated, `#oompa_directive:include_file`), `max_cycle`, `count`, `can_plan`, `needs_review`, `max_wait_for_tasks`; top-level reviewers | `README.md` §Configuration |
| Harnesses | claude, codex, opencode (also cursor/gemini) mixed in one swarm; per-harness `:drive` capability (`:resume` everywhere; codex `:goal` is a stub) | `docs/GOALS_CYCLES_DRIVE.md`, `agentnet/src/agentnet/harness.clj` |
| Cycle | worktree → orient → `CLAIM(ids)` → code (resume loop) → review rounds → serialized merge to main → move tasks to complete → write cycle event → cleanup | `docs/systems_architecture.md` §The Cycle |
| Budget | `max_resumes` per cycle is the one cap; `max_cycle` outer bound; deprecated `--iterations` | `docs/LEAN_DESIGN_STATUS.md` K1, `docs/GOALS_CYCLES_DRIVE.md` |
| Signals | text in stdout: `CLAIM(a,b)`, `COMPLETE_AND_READY_FOR_MERGE`, `__DONE__`; priority `__DONE__` > merge > claim | `docs/systems_architecture.md` §Signal Protocol |
| Task queue | `tasks/{pending,current,complete}/*.json`, claims are atomic `mv`; framework is sole authority on task state | `README.md` §Task System, `docs/SYSTEMS_DESIGN.md` P2/P7 |
| Review | separate reviewer model sees diff, verdict approved / needs-changes / rejected; bounded rounds (~3); last-10 merged subjects injected to flag redundancy | `docs/systems_architecture.md` §review loop, `LEAN_DESIGN_STATUS.md` R1 |
| Worktrees | `git cambium add -b <br> -name <n> -ephemeral <path>`; removal via `cambium remove --safe --json --require-merged HEAD --harvest output`; refusal reasons are typed | `README.md` §Disk-efficient worktrees |
| Run artifacts | events only: `started.json`, `stopped.json`, `cycles/<w>-c<N>.json`, `reviews/<w>-c<N>-r<R>.json`; JSON Schema draft-07 shared with buddies via codegen | `docs/run-artifacts.md`, `schemas/*.schema.json`, `docs/SYSTEMS_DESIGN.md` P10 |
| Buddy-task backend (fork `buddies-cambium`) | Buddy tasks are authority; oompa owns execution. Explicit `task_ids` or `root_task_ids` (subtree re-expanded per scan); CAS claims by revision; merge-ready → **review**, never done; typed `blocked` JSON return reviewed by `block_reviewer.md`; validators = argv + SHA-256-pinned `source_files`; host fast-forwards integration; 12 h task-scoped grant surviving chat settle and backend adoption | `README.md` §Buddy-task fork, `agent_notes/2026-10-19_buddies_cambium.md` |
| Host continuation control | `continuation-request.json` pauses idle workers for a host diagnostic; active work never acks idle | `README.md` (tail), `agent_notes/2026-10-19_buddies_cambium.md` §Host diagnostic |
| Candidate refresh | held candidate merges current integration HEAD (never rebase/reset), invalidates readiness/receipt, reruns review + gate; conflicts stay with the same model session | `agent_notes/2026-10-20_selected_integration_refresh.md` |

Philosophy that still applies (`docs/SWARM_PHILOSOPHY.md`):
- **Divergence then convergence**: design is sequential (one planner, a bottleneck), execution is
  parallel. This is exactly the leader-design round shape (synthesize = 1 agent, collect = map).
- **Intelligence ∝ ambiguity**: big model plans and reviews, cheap models execute.
- **Stub and smooth**: don't block on dependencies.
- **Docs Architect**: a dedicated low-iteration agent to fight entropy in swarms over 1 h.
- **Agents act, framework reacts** (`docs/SYSTEMS_DESIGN.md`): behavior in prompts, shared state
  owned by deterministic code, write events never projections.

### 2.2 Measured outcomes (wave_sim, `~/git/wave_sim/runs/*/cycles/*.json`)

95 swarms with cycle events, 1091 cycles:

| outcome | count | share |
|---|---|---|
| no-claim | 613 | 56% |
| merged | 225 | 21% |
| error | 154 | 14% |
| claimed (unfinished) | 34 | 3% |
| rejected | 30 | 3% |
| no-changes / blocked / needs-followup / merge-failed / interrupted | 35 | 3% |

- Cycle duration p50 1.8 min, p90 17.1 min, max 33 h (1985.9 min — an unbounded resume chain).
- `no-claim` cycles: p50 1.2 min, total **13.9 h** of agent wall clock spent orienting on an empty
  or ineligible queue and exiting.
- 130 of 154 errors are one signature: `merge signaled with changes but no claimed tasks` — the
  agent did work without first emitting `CLAIM(...)`. A text protocol the agent must remember is a
  failure mode, not an API.
- Reviews: 284 needs-changes vs 235 approved; 846/1091 cycles had 0 review rounds.
- Cycle events carry no token counts (`schemas/cycle.schema.json` keys: duration, outcome,
  signals, session-id … no usage). Cost must be reconstructed from native session logs.

### 2.3 How buddies views oompa (quarantined)

- `server/src/swarm/index.ts` is the ONE entry; owner decision 2026-09-25 "keep swarm, deletable in
  one go" (Pattern: quarantine, guard `server/test/swarm-quarantine.test.ts`).
- Read model: `runtime.ts` reads `runs/<id>/{started,stopped,cycles}` async (2 s poll per running
  folder; sync fs on the event loop was a 2026-09-25 regression); `observer.ts`, `read-model-routes.ts`
  serve it; `commands.ts` shells `oompa` and git. Types come from oompa's schemas.
- Sidebar folds oompa worktrees (`<repo>/.ws<swarm>-w3-i7`) via `getProjectRoot`; raw keys made
  1,107 groups for one repo (CLAUDE.md, `client/test/folder-grouping.test.ts`).
- Oompa workers are identified by the first prompt line `[oompa:<swarmId>:<workerId>]` in native
  transcripts (`README.md` §Worker Conversation Persistence) — no oompa-side mirror.
- Unattended oompa launched by a Buddy uses an owner-authorized launch tool with a separate
  task-scoped grant (≤12 h); host journals under `~/.agent-viewer/oompa-executions/<run>/` (34 dirs;
  not read here: they may hold credential journals per `agent_notes/2026-10-19_buddies_cambium.md`).

---

## 3. Expeditions in buddies

### 3.1 Generation 1: ledger engine (2026-11-01, deleted in `bcb2f5f`)

`98b1ab2`…`5e89c68`: R1–R11 over two days; at deletion 13,475 lines removed (ledger.ts 1214,
decide.ts 663, git.ts 668, release.ts 530, news.ts 548, briefs.ts 478, …, tests 3661). Model:
append-only ledger; manager "decisions"; Questions with stages (planned → claimed → validated →
integrated); per-question acceptance by "independent check panel"; host validations on candidate
shas; serialized integration onto `expedition/<id>`; `maxLive` up to 8; measured token meter.

The four real runs (`~/.agent-viewer/expeditions/.retired/*.json`, `t: expedition.retired/v1`,
field `summary`):

| Expedition | End | Attempts / max | Decisions / max | maxLive | Verified | Tokens (in + out; cache read) |
|---|---|---|---|---|---|---|
| One qualified DualSPHysics workflow | deadline (8 h) | 8/12 | 11/26 | 3 | 1 | 1.6M + 120k; 21.3M |
| Actual-game daily local paper trading | deadline | 8/32 | 11/66 | 8 | 0 | 538k + 74k; 6.8M |
| Emergent beach design (R13) | deadline | 4/6 | 9/14 | 3 | 1 | 187k + 92k; 6.4M |
| Own-engine geometry, optional CAD | deadline | 2/10 | 4/22 | 2 | 0 | 171k + 107k; 7.7M |

Read from the DualSPHysics report (`.retired/one-qualified-dualsphysi-404846.json` `.report`):
- 3 of 5 host validations failed on the **same** environment error (python `FileNotFound` in
  `dualsphysics_baseline_v1.py --inspect`) — the check could never pass whatever the crew did. The
  owner had to add a binding lesson mid-run. Fixed in lean as `ranOrNot` + launch preflight
  (`server/src/expeditions/checks.ts:278`, "Incident 2026-11-01 … burned 3 attempts").
- 2 of 8 work answers were `MALFORMED ANSWER (no ```json block)` — structured output requested by
  prose, parsed by regex. Workflows' schema-forced `StructuredOutput` removes this class.
- 11 manager decisions for 8 work attempts: half the turns were manager turns emitting "N actions".
- Charter goal text was enormous (scope/out-of-scope/owner lessons/questions inlined); every brief
  re-sent it, which is the cache-read volume above.
- Result: honest negative/partial findings, 1 merge. The machinery was correct-ish; throughput was not.

### 3.2 Generation 2: lean host (today, `server/src/expeditions/*`, 2,038 lines + shared 311)

Design `historical retry-loop design (git d7bb99a)`; built `bcb2f5f` + 2026-11-03 fixes.
- **Shape:** one crew Buddy; each attempt = one crew turn in a fresh Cambium tree from `baseSha`;
  brief = goal + done + one prior line per attempt (result, `Lesson:` sentence, branch, salvage ref)
  (`brief.ts`). Judge = host checks (argv, exit 0, detached checkout of the turn-end sha with oracle
  files restored from base) or owner pass/fail. Stop on pass, budget, deadline, owner stop.
- **State:** one JSON record `<store>/expeditions/<id>.json`, zod-parsed once at boot (κ), tmp+rename
  saves, per-id promise chain `serialized()`, one write path `commit()`, 1.5 s debounced step +
  60 s backstop (`host.ts`; lean design §3.5).
- **Types:** sum types everywhere (`State`, `AttemptPhase`, `Tree`, `Verdict`, `FinishReason`) with
  `Record<tag, handler>` dispatch (`STEP`, `ACTS`, `JUDGE`, `SETTLE_INTO`, `JUDGED_TURN`).
- **Manager seat:** the same crew Buddy's chat in the owner↔crew DM thread (`exp:<id>:chat`), a
  separate conversation that answers while an attempt runs; `seatOf` decides who may act
  (`host.ts`; lean §12).
- **Owner commands** (`pause|resume|stop|extend Nh|pass|fail|note:`) are consumed by the host,
  posted with purpose `host_command` which the crate fan-out skips, so no manager turn re-applies
  them (lean §12; "extend twice = 4 h" bug).
- **Live records today:** `gtm-evidence-thesis-buye-dd0984.json` running, a1 answered at 01:37 on
  11-08 and still `judging` (owner verdict) past its 07:30 deadline — the leader-design §1 problem 3
  in the wild. `geometry-g0-…-314bb5.json`: a1 interrupted, a2 answered in 6.5 min, then `skipped`
  at deadline waiting for the owner (the incident behind `bce2400`). `.retired/repair-wave-sim-…`:
  the one clean success — `done: checks`, codex medium, passed a1 in 2 min 15 s.

### 3.3 Proposed generation 3: leader (`docs/expeditions-leader-design.md`, design only)

Leader = event-driven loop over rounds; each round a typed node graph (`agent | map | reduce | duel |
check | gate`), forward-only node states, patchable while pending; versioned `Objective` with
clarify/tighten (leader) vs weaken/redirect (owner ratifies); `Round.predicts` for reflection;
budget ledger with reservations (I3); Quint model `docs/specs/expedition-leader.qnt` planned. It
claims G7 durability from execution journals — but see lesson L10: crew turns are not adopted today.

---

## 4. Claude Code Workflows and AI-OS macros

### 4.1 Workflows (orchestration API)

- `agent(prompt, {schema, model, effort, isolation:'worktree', agentType, phase, label})` → text, or a
  schema-validated object (the subagent must call StructuredOutput; validation retries at the tool
  layer). Returns `null` on skip/terminal error.
- `pipeline(items, ...stages)`: per-item chains, **no barrier**; wall clock = slowest chain.
  `parallel(thunks)`: barrier, never rejects (failures → `null`). Concurrency cap min(16, CPUs−2);
  1000 agents/run backstop; 4096 items/call.
- `phase()`, `log()`; `budget.{total, spent(), remaining()}` is a hard ceiling on output tokens
  shared across the turn (agent() throws past it); `workflow()` nests one level.
- Determinism: script fixed at launch, plain JS, `Date.now()`/`Math.random()` throw. Resume
  (`resumeFromRunId`) replays the longest unchanged prefix of `agent()` calls from cache.
- Limits for our use (`expeditions/workflows-vs-expeditions.md`): dies with the session,
  Claude-only, cannot wait on external jobs, no owner steering mid-run, cannot be patched
  mid-execution (leader design §3 "why a round is a graph").

### 4.2 AI-OS macros (`~/git/AI-OS`)

- A macro is a Python file run inside a chat REPL (`/macro`, `@`); helpers in
  `ai_os/core/macro_helpers.py`: `log`, `log_to_context`, `chat`, `shell`, `patch` (propose+apply a
  file patch, optional `user_approval`), `approve` (human y/n), `get_var`. Results land in chat
  context, so the human steers the *next* macro (README "mix your AI chat with your agents").
- `examples/tdd_macro.py` (123 lines): loop 1 generate test → human `approve`; loop 2 patch impl →
  `pytest` exit code → retry on approval. Judge = exit code; human in every retry. Unbounded loops
  (`while True`), hard-coded `src/math_functions.py`.
- `examples/chart_judge_macro.py` (60 lines): draw → one VLM rating. Despite the README ("run a loop
  until it passes a bar"), the code judges **once**; no threshold, no loop.
  `ultra_dense_chart_judge.py` parses a 1–10 score by regex.
- `examples/tree_of_thought.py` (63 lines): 5 seeds → 25 branches via `asyncio.gather` → one
  synthesis. Fixed fan-out widths; no pruning or scoring.
- Value: composability + human-in-context steering. Weakness: no durability, no caps, no typed
  output.

---

## 5. Mechanisms table

| Mechanism | Where | Keep / drop | Why |
|---|---|---|---|
| One JSON record per expedition, zod-parsed at boot, tmp+rename save, unreadable file = visible row | `server/src/expeditions/record.ts`, lean §3.1 | **Keep** | Inspectable, crash-safe, one type source; v2 extends the record (append-only plans/objectives) |
| Per-id serialized step + one write path `commit()` + debounced event step + 60 s backstop | `host.ts` `serialized`, `commit`, `start` | **Keep** | Removes races without locks; v2 scheduler becomes the step body |
| Sum-type phases with `Record<tag, handler>` dispatch | `shared/src/expedition.ts`, `host.ts` STEP/ACTS/JUDGE | **Keep** | Exhaustive, matches house style; NodeState follows the same pattern |
| `ALLOWED` act×state guard table shared by server and client | `shared/src/expedition.ts` | **Keep** | One table for refusals and buttons |
| Cambium tree per unit, `add` from exact `baseSha`, `release` with salvage ref, typed refusal | `server/src/expeditions/cambium.ts`; oompa `README.md` §Disk-efficient worktrees | **Keep**, but per *code-writing node only* | Research/collect nodes don't need a tree; creation can take minutes (oompa 600 s ceiling, `agent_notes/2026-10-20_cambium_startup_custody.md`) |
| Sanitized git env (no hooks/fsmonitor, scrubbed keys) | `cambium.ts:6` (incident audit 2026-11-01 #7) | **Keep** | Agent-written hooks ran with provider keys |
| Host checks in fresh detached checkout of an immutable sha, oracle restored, one host-wide queue | `checks.ts`; lean §11 | **Keep** as the `check` node | Only judgment that can't be gamed; queue protects shared machine |
| Launch preflight: a check that cannot RUN refuses launch (`ranOrNot`) | `checks.ts:278` | **Keep**, extend to plan time | DualSPHysics burned 3 attempts on FileNotFound |
| Lesson line ("Lesson: <one sentence>") as handoff | `brief.ts` CREW_ROLE, `lessonOf` | **Drop** → typed node outputs + refs | One sentence loses evidence; prose parse; leader §7 |
| Retry-until-pass loop (`fill`/`startAttempt`), pass ends expedition | `host.ts` `fill`, `finishIfDue` | **Drop** → graph scheduler | Cannot express phases (leader §1 problems 1–4) |
| Judging attempt holds the live slot | lean §12 deviation, `host.ts fill` | **Drop** for owner gates | Owner gate blocks all progress while clock runs (GTM record) |
| Deadline bounds work, not judgment | `host.ts:345` (`bce2400`, Owner 2026-11-03) | **Keep** | An answered attempt keeps its verdict |
| Manager = crew chat seat, separate conversation, act authority by `seatOf` | `brief.ts:18`, `host.ts:733` | **Keep** → becomes the leader | Owner asked for a chat log with the running manager |
| Owner bare commands consumed by host, `host_command` wakes nobody | `host.ts:768`, crate `WAKES_NOBODY` | **Keep** | Avoids double-apply (extend 2 h → 4 h) and stale manager echoes |
| Seat authority: only owner-started crew turns may act; verdict/relaunch owner-only | `tool.ts:117`, lean §12 | **Keep** | Any Buddy could pass an owner-judged attempt |
| Idempotency keys on every host post (`exp:<id>:a<n>:judged` …) | `host.ts postStatus` | **Keep** | Replays/steps never double-post |
| Execution journals + adoption of running turns | `docs/turn-lifecycle.md#execution-adoption`, `server/src/lifecycle/adopt-executions.ts` | **Keep; extend to expedition nodes** | Today crew turns are discarded at shutdown (`shutdown.ts discardCrewTurns`, lean §5); a node must survive a reload |
| Run lease (5 min heartbeat) separate from deadline | `docs/patterns.md#lease-heartbeat`, `BUDDY_RUN_LEASE_MS` | **Keep** | Never derive node deadlines from the lease (09-10, 09-30 incidents) |
| Harness steering: `any-tool` (claude: mid-turn after any native tool) vs `buddy-tool-only`; idle `stop-hook-hold` | `server/src/buddies/harness-steering.ts` | **Keep** for `steer(node)` | Real mid-turn delivery exists for claude; codex is `buddy-tool-only`, so steer semantics must be per-harness capability, not assumed |
| Typed `blocked` return reviewed, then CAS hold; held work never auto-retried | oompa `README.md` §Buddy-task fork, `agent_notes/2026-10-19_buddies_cambium.md` | **Adopt** as a NodeState/outcome | Force session was resumed 9× while blocked |
| Explicit release of own claim on give-up with reason + retained branch | oompa `README.md` (swarm 455987ea) | **Adopt** | Stuck `in_progress` claims idled a swarm |
| Queue-audit fingerprint: unchanged blocked graph does no work | oompa `README.md` §Buddy-task fork | **Adopt** for leader wakes | Prevents paying to re-observe an unchanged state |
| Candidate refresh by merge (never rebase/reset), invalidate receipts | `agent_notes/2026-10-20_selected_integration_refresh.md` | **Adopt** for code nodes | Parallel candidates from one base diverge after the first integration |
| Text signals (`CLAIM`, `COMPLETE_AND_READY_FOR_MERGE`, `__DONE__`) | oompa `docs/systems_architecture.md` | **Drop** → schema outputs | 130/154 wave_sim errors were the missing-CLAIM signature |
| Filesystem `tasks/` queue with self-claiming workers | oompa `README.md` §Task System | **Drop** | 56% no-claim cycles; leader assigns nodes instead |
| Planner/executor/reviewer tiers (intelligence ∝ ambiguity) | `docs/SWARM_PHILOSOPHY.md` §4 | **Keep** as per-node `seat` | Cheap map workers, strong reduce/duel/leader |
| Separate reviewer model, bounded rounds, redundancy context | oompa review loop | **Keep** as `duel`/review node | 284 needs-changes show reviews do real work |
| Event files, never projections | oompa `docs/SYSTEMS_DESIGN.md` P10 | **Keep** (append-only plans/objectives) | Same as leader G8 |
| `pipeline()` no-barrier stages, schema-forced outputs | Workflow API | **Adopt** semantics in `map`→`reduce` | Throughput and no malformed answers |
| Resume by cached prefix of unchanged calls | Workflow API | **Adopt** as "done nodes immutable, reusable by ref" | Same invariant as leader I2 |
| Fixed-at-launch script | Workflow API | **Drop** for the outer loop; maybe allow as a *round builder* (leader q1) | Cannot patch running work |
| Hard budget ceiling, `remaining()` drives loops | Workflow `budget` | **Adopt** with reservations (leader I3) | Parallel starts overshoot otherwise |
| Human `approve()` inside loop, results in chat context | AI-OS `macro_helpers.py`, `tdd_macro.py` | **Keep the idea** as `gate` node + owner chat | Owner steering is the feature; but never block the whole run |
| Judge-in-loop with numeric score | AI-OS `chart_judge_macro.py`, `ultra_dense_chart_judge.py` | **Adapt** as `judged{rubric}` criterion with schema score | AI-OS versions are one-shot and regex-parsed |
| Fixed-width tree-of-thought fan-out | AI-OS `tree_of_thought.py` | **Drop** fixed widths → `map.over` data-driven | Leader G5 |
| codex `/goal` drive | oompa `docs/GOALS_CYCLES_DRIVE.md` | **Drop** unless externally capped | 20 h unbounded run; claude `/goal` self-bounds (~50 turns) |
| Pre-lean manager "decisions" as separate turns | ledger reports | **Drop** frequent wakes | 11 manager turns per 8 work turns |

---

## 6. Failure lessons with evidence

| # | Lesson | Evidence |
|---|---|---|
| L1 | Text protocols the agent must remember fail at scale; use schema-forced outputs | oompa: 130/154 errors "merge signaled with changes but no claimed tasks" (`~/git/wave_sim/runs/*/cycles`); ledger: 2/8 "MALFORMED ANSWER (no ```json block)" (`.retired/one-qualified-dualsphysi-404846.json`) |
| L2 | Self-claiming from a shared queue wastes most cycles when the queue is thin or role-gated | 613/1091 no-claim cycles, 13.9 h (`~/git/wave_sim/runs`) |
| L3 | A check that cannot run burns the budget; validate checks before spending | `checks.ts:278` Incident 2026-11-01; owner binding lesson in DualSPHysics report |
| L4 | Owner-judged gates must not hold the only slot or race the deadline | `bce2400`, `host.ts:345` Owner 2026-11-03; GTM record a1 `judging` past deadline (`~/.agent-viewer/expeditions/gtm-evidence-thesis-buye-dd0984.json`); geometry record a2 `skipped` |
| L5 | Prefer `done: checks` when a command can decide | `tool.ts:39` Owner 2026-11-03 ("you need to be able to review own work"); the only clean pass is the checks-judged codex run (`.retired/repair-wave-sim-research-bc412b.json`) |
| L6 | A failed/cancelled turn must never be judged (checks on base can pass) | `host.ts:86` Review 2026-11-03 |
| L7 | Cancelling a queued run closes no request: treat "every run settled" as cancelled | lean §12 deviation; `crates/unleashd-buddies/src/runs.rs cancel_queued` |
| L8 | Manager scope must be explicit: merging, moving main, closing tasks are owner calls | `brief.ts:29` Owner 2026-11-03 |
| L9 | Commands applied twice (manager + host) double effects | `host.ts:160` "`extend 2h` added 4 h"; fix: `host_command` purpose |
| L10 | Expedition crew turns are NOT adopted across backend restarts; they are interrupted and re-run | lean §5, `server/src/lifecycle/shutdown.ts:110 discardCrewTurns`, `adopt-executions.ts:172`; geometry record a1 `interrupted`. v2 G7 must close this, not assume it |
| L11 | Unbounded agent loops run away | codex goal 20 h unbounded (`~/git/oompa_loompas/docs/GOALS_CYCLES_DRIVE.md`); oompa max cycle 33 h |
| L12 | Blocked work must become a typed hold, not a resume | force session resumed 9× while blocked (`agent_notes/2026-10-19_buddies_cambium.md` §Blocked-return) |
| L13 | Paid output in ignored files is lost with the workspace unless harvested | wave_sim swarm 455987ea, 2026-10-24 (`oompa README.md` §Disk-efficient worktrees) |
| L14 | Worktree creation is slow and must verify HEAD | 30 s ceiling killed creation; HEAD came from primary main instead of launch root (`agent_notes/2026-10-20_cambium_startup_custody.md`); `01acc16` "Launch from origin's default branch, not stale local main" |
| L15 | Check grading must protect the grader, not the code under test | `checks.ts:175` audit 2026-11-03 (`pytest src` graded base) |
| L16 | Agent-controlled git hooks run with server secrets | `cambium.ts:6` Incident audit 2026-11-01 #7 |
| L17 | Rich ledger machinery shipped fast but bloated (13.5k lines in 2 days) and still ended every run at the deadline; the line budget rewrite overshot its own budget 2–3× | `git show --stat bcb2f5f`; lean §0/§12 |
| L18 | One seat as both advocate and critic is a fake adversary | leader design §1 problem 5 |
| L19 | Salvaged/restarted workers silently lost review via a key mismatch at an event boundary | `~/git/oompa_loompas/docs/LEAN_DESIGN_STATUS.md` (`:reviewer-configs` vs `:reviewer-config`, fixed 2026-11-01) |
| L20 | Pasting history into briefs is the main token sink | ledger cache-read 6–21M per run; FOLLOWUPS "codex swarm prompts re-send instruction lines ×47" (`agent_notes/review_token_usage/FOLLOWUPS.md`) |

---

## 7. Token and throughput observations

- **Input dominates.** Ledger runs: input:output 13:1 (DualSPHysics), 7:1 (paper trading); cache
  reads 6.4M–21.3M per run, i.e. ~0.3–1.1M cache-read per measured attempt. Cause: big charter +
  history re-sent per turn. Design implication: leader and nodes receive refs/summaries, open
  artifacts on demand (leader §4 Events already says this).
- **Throughput per attempt is minutes, not hours.** oompa cycle p50 1.8 min (p90 17 min); lean
  attempts answered in 2–7 min (`repair-wave-sim` 2 m 15 s, geometry a2 6.5 min, GTM a1 7 min).
  Expedition wall clock is dominated by *waiting* (owner verdicts, deadlines), not work. Matches
  oompa `notes/2025-01-myth_of_long_running_tasks.md`: parallel short work, not long turns.
- **Parallelism was under-used.** Ledger maxLive 2–8 but 2–8 attempts total over 8 h; lean
  default `maxLive: 1`. oompa achieved real parallelism, but more than half of it idled.
- **Manager overhead.** Ledger: 11 decision turns for 8 work turns; leader design must wake on
  batched events (roundDone, failures, 50/80% budget, owner msg, ≤ 15-min tick).
- **Start cost floor.** Fresh-input per new seat ~20–33k median (FOLLOWUPS 2026-09-25); a 25-wide
  map pays that 25×. Warm-start forking a base session (FOLLOWUPS #4) is the lever for wide maps.
- **Measurement gap.** oompa cycle events lack tokens; lean records lack token accounting (the
  ledger `meter.ts` was deleted with it). v2 needs per-node usage in the record to enforce I3.
- **Prompt caching.** Idle-gap cache expiry outweighed warm busts (56.7M vs 16.0M rewritten,
  FOLLOWUPS); leader ticks spaced > cache TTL pay full price each wake.

---

## 8. Open questions this brief raises for v2

1. Adopt crew/node turns across restarts (L10), or accept "interrupted, re-run, not counted"?
2. Are node outputs schema-forced via the harness (claude StructuredOutput-like) or host-validated
   JSON with a typed `malformed` outcome per harness?
3. Per-harness steering capability (`any-tool` vs `buddy-tool-only`) should be visible in the
   `steer` act's result, not assumed (G4).
4. Should an oompa run (with its Buddy-task backend) be a node kind for large code fan-out, per
   `expeditions/workflows-vs-expeditions.md` "an oompa swarm could serve as a Work executor"?
5. Where do per-node token counts come from (provider-usage fold, `docs/turn-lifecycle.md#provider-usage`)?
