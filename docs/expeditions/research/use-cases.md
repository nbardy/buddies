# Expeditions: the nine use cases, as the repos show them

Status: **research brief, 2026-11-09.** Read-only survey of `~/git/wave_sim`,
`~/git/room-runners-arena-lib`, `~/git/nova_docs`, `~/git/geometry_book`, this repo and the
two expedition records in `~/.agent-viewer/expeditions/`. Nothing was run. Every claim about
existing code or results cites a path. Paths starting `wave_sim/`, `rr/` (room-runners-arena-lib)
or `buddies/` are relative to `~/git/`. Numbers are copied from the cited records, not
re-measured.

Companion docs: `docs/expeditions-lean-design.md` (today's host, about 2,000 lines in
`server/src/expeditions/`), `docs/expeditions-leader-design.md` (the leader/rounds proposal).

## 0. Summary table

| # | Case | Dominant shape | Judge / oracle | One evaluation | Compute | Done means |
|---|---|---|---|---|---|---|
| 1 | GTM market research | fan-out, then deep serial, then adversarial loop, then a human gate | owner; source audit; counts | seconds per fetched page; hours per synthesis | local, web only, no paid tools | owner accepts a traceable packet and a buyer test plan |
| 2 | Game design (Tidewar etc.) | parallel A/B search over rule changes, with a theory loop | headless AI-vs-AI metrics over seeds, then a human playtest | ~6.5 s CPU per 45-min match; 48 seeds ≈ 5 min | shared local CPU box (compile lock, load 60–200) | metrics in the owner's target bands, no team bias, human playtest passes |
| 3 | Sim speed + accuracy auto-research | parallel population search with a shared ledger | typed benchmark reports (R1–R12, matched error, ms/step) | 1 s to 30 min of GPU, plus 2–3 min of Modal setup | local Apple M4 (one GPU runner) + Modal L4/L40S/A10G/RTX PRO 6000/H100 | a matched-error speedup on frozen cases, independently judged |
| 4 | Frontier math → algorithms (10–200×) | divergent generation, then a blind census, then one falsifier per candidate | independent blind adjudication + GPU falsifier at matched error | hours of thinking; minutes to hours of GPU per falsifier | as case 3 | one candidate survives a matched-error, complete-cost falsifier |
| 5 | Add capabilities (forces, wind, movable rocks) | requirement matrix × engines; deep serial per row | per-row numeric gate with frozen thresholds | as case 3 | as case 3 | the row passes unchanged on the target engine |
| 6 | Deslop / unify / shrink a codebase | measure, then plan, then waves of fenced slices, then integrate | existing tests, behavior parity, line and perf deltas | minutes (typecheck, tests, screenshots) | local | a canonical owner per fact, old paths deleted, consumers unchanged |
| 7 | CRUD SaaS apps | plan-ahead pipeline, wide fan-out | tests, typecheck, screenshots, owner review | seconds to minutes | local | features pass integration tests and the owner's walkthrough |
| 8 | Geometry engine | deep serial; tight test loop with math design inside it | known-answer geometry tests under an RSS/time guard; independent review | ~1.4–2.8 s per guarded suite | local CPU, 256 MiB / 60 s guard | the finite D2 boundary passes all cases from committed source |
| 9 | Document-model design | adversarial design / critique / reflect | owner rulings; requirement-contract ledger; parity checks | hours of reading and thinking per round | local | the owner ratifies a model that covers the requirement ledger |

---

## 1. Market research (GTM): evidence → thesis → buyer test

**Sources.** The draft record is `~/.agent-viewer/expeditions/gtm-evidence-thesis-buye-dd0984.json`:
`maxAttempts 6`, `hours 6`, `maxLive 1`, `done: owner`, `oracle: []`, repo `wave_sim`. The packet
targets `wave_sim/business/research/2026-11-08_gtm_expedition/`. Inputs it names:
`wave_sim/business/plans/REVENUE_PLAN.md`, `business/plans/2026-10-22_gtm_program.md`, and prior
`business/research/2026-10-03_rl_env_buyers/`.

**Workload shape.** There are four phases, and each has a different shape (see also
`buddies/docs/expeditions-leader-design.md` §1):
1. **Fan-out collection.** 25–40 organizations, each with product, pricing, docs and case-study
   pages. The 3–5 largest public incumbents get their latest 2–3 earnings calls. Then 100+
   reviews and a bounded forum search. The charter requires a source ledger with
   fetched/missing/login-blocked status per surface, query logs, deduplication and stop rules.
2. **Deep serial synthesis.** One agent holds the whole corpus and answers the forcing questions
   ("what do winners know that customers would never admit"; "the beliefs the industry takes for
   granted, and what would make each false"). It tags every claim VERIFIED, CLAIMED or SPECULATION
   and links each one to source IDs.
3. **Adversarial loop.** Three recorded rounds: steelman, then counterexample, then revise or
   reject. Each round keeps the original thesis. Design partners are judged separately.
4. **Human gate.** The buyer test needs five account records with checked contact routes, internal
   interview notes, and a pass rule ("≥2 concrete current cases, ≥1 scoped commercial next step").
   The owner does all outreach.

**Judge.** No automatic check. The owner judges at the end, plus an independent re-open of the
decisive sources ("audit counts, deduplication and counterevidence"). There are judgeable
sub-facts: actual counts by segment and platform, every load-bearing claim linked to a source,
three critique rounds present.

**Evaluation speed.** A page fetch takes seconds. The charter itself sets the synthesis target at
"three active research hours". The owner's judgment is the slowest step and has no bound.

**Compute.** Local only. The charter forbids paid scraping or enrichment, GPU, outreach and
publication.

**Knowledge that must persist.** The source ledger, with IDs, URLs, retrieval dates and access
failures. The coverage counts. The belief/falsifier table. Every thesis version and the
counterexample that killed or bent it. Lessons about the world, e.g. attempt 1's lesson in the
record: "TELUS Digital went private, and TaskUs looked as if it had". Raw scrape bodies stay in the
ignored `output/` through `artifact_store_v1` (`wave_sim/AGENTS.md`).

**What went wrong.** Attempt 1 ran 01:30–01:37Z and then sat in `phase: judging`. With
`maxLive: 1`, waiting for the owner held the only slot while the 6-hour deadline ran. The leader
design lists the structural failures it found: a pass ends the whole expedition, six attempts for
six steps leave no retry room, no fan-out, one seat plays both steelman and critic, and the handoff
between attempts is fragile (`buddies/docs/expeditions-leader-design.md` §1).

**Done.** The owner accepts traceable conclusions, actual coverage (or candid gaps), the preserved
adversarial reasoning and a usable buyer-test plan. The charter says: "a polished report does not
establish PMF".

---

## 2. Designing games with AI players (room-runners-arena-lib)

**Sources.** `rr/keel/GAMES.md` (games, AI, the balance status as of 2026-11-01),
`rr/notes/design/2026-11-01_tidewar_balance_theory.md` (theory, predictions and a progression log
of about 600 lines), `rr/notes/design/2026-11-01_balance_swarm_meta_prompt.md` (a reusable swarm
brief with round-1 lessons), `rr/reports/tidewar-balance/` (raw runs, `compare.py`),
`rr/docs/design_proposals/2026-10-13_g3_skill_gate_decision.md` (random vs aware bot skill gate),
`rr/design_docs/PLAYTEST_LOG.md` (8× `AIPlayer` TS playtest), `rr/key_learnings/`.

**What exists.**
- **Headless match runner:** `keel_cli tidewar --seeds N --seed-start S --minutes M --summary
  [--map FILE] [--mirror] [--persona P] [--variation off]`. It reports length, win split and fun
  proxies: lead changes, comebacks, fights, Kraken contest/swing, idle share
  (`rr/keel/GAMES.md` "Balance status").
- **AI:** role brains in `rr/keel/games/game_bships/src/ai/` (minion, lane, captain, shop,
  targeting). Personas are `standard`, `farmer`, `aggressor` and `objective`. Seeded variation
  comes from `DetRng`. A fairness test lives at `tests/it/fairness.rs`.
- **Skill comparator:** a paired random-vs-aware harness over 20 seeds per engine, with a locked
  protocol written before the runs (`rr/reports/gameeng/2026-10-13/g3-gap/paired-skill.ts`).
- **Typed tuning knobs:** a `pacing` block (`game_bships/src/pacing.rs`, `deny_unknown_fields`),
  with each knob shipped off.

**Workload shape.** A search over rule/content variants, run as parallel A/B experiments. A theory
loop sits on top: predict, measure, refute or adopt, update the theory doc. The meta prompt names
the roles: Theorist (1), Instrumenter (1, first), Experimenter (1 per experiment, each in an
isolated worktree), Persona bots (2–4), Exploit hunter (1–2), plus skeptic/reflector roles.
Changes stack only after each one is confirmed alone, and the stack is then re-measured.

**Judge.**
- (a) Headless metrics against the owner's targets: 12–20 min matches, a Kraken about every
  4.5 min, no team bias, and fun proxies.
- (b) Statistics: the same seed set for A and B; ≥16 seeds for length and fun; ≥64 plus a
  mirrored-map run for any team-bias claim; unfinished games treated as censored data; paired sign
  tests (theory doc §0, meta prompt "Principles").
- (c) A human playtest for feel. "AI-vs-AI measures structure, not feel."
- (d) Owner rulings are fixed constraints. Example: the flagship stays shielded until all three
  Inner towers are sunk.

**Evaluation speed.** `rr/reports/tidewar-balance/baseline/seeds_1.time`: 12 seeds × 45-minute
matches took real 78.4 s (user 70.7 s), about 6.5 s of CPU per match. A 48-seed A/B therefore
costs minutes. Rebuilding the binary is the expensive part: "a small release rebuild 8 min wall for
54 s CPU" on the shared box (`rr/AGENTS.md`, Rust edit loop).

**Compute.** One shared local machine. All builds go through a machine-wide compile lock
(`keel/scripts/lib/build_gate.sh`). Load runs 60–200. The doc warns: "Measure performance only on
an idle host". Production is a Hetzner server that the owner provisions; agents never deploy.

**Knowledge that must persist.**
- The progression log: every lever with its prediction (written before the run), the seed set, the
  binary SHA, the numbers, and the verdict "Refuted / Reverted, row and run folder kept".
- The theory doc's derived formulas, with each number tagged `[code: file:line]`, `[derived]`,
  `[assumption]` or `[measured]`.
- Persona definitions, frozen seed sets (1..48, plus a reserved fresh set 1001..1048) and the
  owner rulings.

**What went wrong.**
- Round 1 used 38 agents on 7 experiments. One survived and none shipped
  (`balance_swarm_meta_prompt.md` "Lessons from round 1").
- One deterministic AI made "first blood at 55 s on all 48 seeds". The 48 seeds were really one
  sample, so the measuring stick had to be fixed before any experiment.
- A hidden Crew bias showed up only under some levers. It came from map geography: with every knob
  off, `--mirror` gives team towers-ahead 59/23.
- Two individually confirmed changes stacked into a biased, snowballing game.
- Gold-only levers were inert: the AI build was already finished, so the extra gold bought nothing.
- Tick timings taken under machine load were noise.
- The exploit hunter ran too late. Free duplicate Cannons and a Mortar that outranges towers
  confounded every experiment.
- Reflectors could not edit code, so three blocking fixes had no owner.
- On G3, the bot skill ratio was 1.227 and 1.127 against a 1.5× locked gate. The proposal was to
  defer to an owner playtest rather than lower the bar afterwards.
- The TS harness had a quirk: without `sleep(2)` per tick, `actionsSent` stays 0
  (`PLAYTEST_LOG.md`).

**Done.** On the shipped map, matches land in 12–20 min with no significant team bias (mirror and
sign test) and fun proxies in range. The exploit hunter has signed off. Owner rules are unchanged.
A human playtest checklist passes. The meta prompt is updated with the round's lessons.

---

## 3. Auto-research: wave_sim speed and accuracy, parallel across local and remote machines

**Sources.**
- `wave_sim/AGENTS.md`: work loop, the two-strikes rule, typed tolerances, the GPU ownership rule.
- `wave_sim/SWARM_MANAGEMENT.md`: "Hard Constraint: One GPU Runner".
- `wave_sim/SIMULATORS.md`: 10 live engines across Eulerian VOF, APIC and potential flow.
- `wave_sim/goals/2026-10-12_three_engine_goals.md`: R1–R12, the per-engine status, and cost (R11)
  in ms/step and dollars.
- `wave_sim/KEY_LEARNINGS.md`: the refuted "graveyard", the fast Modal iteration notes.
- `wave_sim/agent_notes/2026-10-05_clean_fast_iteration/MODAL_GPU_LESSONS.md`.
- `wave_sim/auto_research/{README,PROCESS_RETROSPECTIVE,KEY_LEARNINGS,THEORY_FORK_SWARM_RETROSPECTIVE_2026_06_08}.md`.
- `wave_sim/tools/` (`modal_*`, `matched_error_v1/residual_certificate.py`,
  `lobovsky_pressure_bench_v1`, `aalborg_wc1_*`, `dualsphysics_*`, `goal_manager.py`).
- `wave_sim/studio/remote_runner_v0/README.md`.

**Benchmarks / oracles that exist.**
- **R1–R12 plus the curved-wall row**, each with a numeric pass check
  (`three_engine_goals.md` "The requirements (unchanged)"):
  - still water: hydrostatic error <1%, speed <0.001 m/s;
  - waves: sloshing period ±2%, solitary celerity ±3%, dam front ±5% of lab data;
  - forces: foil lift ±10% at Re 1000 on two grids;
  - moving bodies: floating-box draft <2%;
  - sand: settling <10%;
  - wind: setup slope ±10% of τ/(ρgh);
  - conservation ledgers.
- **External benchmark intake:** Lobovsky pressure, Aalborg WC1, DFG 2D-1 cylinder Re20, DualSPHysics
  official cases, and an OpenFOAM head-to-head draft (`goals/2026-08-13_performance_head_to_head_goal.md`,
  DRAFT-UNFUNDED).
- **Speed is only "matched-error speedup":** the flag `matchedErrorSpeedup=false` stays false until
  an audit passes. "Complete cost" counts setup, compile, readback, rejected work and output
  (`wave_sim/AGENTS.md` "Physics and evidence").

**Workload shape.** A population search. Many idea lanes work in parallel: kernel variants, solver
changes, precision. Every idea must clear a matched-error gate before its speed counts. The
expensive stage is GPU-serialized locally and parallel on Modal. Non-GPU agents prepare
"ready-to-run packets" while the GPU runner executes (`SWARM_MANAGEMENT.md` lines ~245–330:
"keep 1–3 shader or kernel workers producing variants while the GPU runner is occupied"). The
owner wants dense shared notes so ideas are not repeated.

**Evaluation speed (recorded examples).**
- A Modal smoke took 157.8 s in total: 38.5 s installing dependencies, 15.1 s compiling CUDA, and
  1.1 s of actual three-step compute (`KEY_LEARNINGS.md` "2026-10-05 — Fast Modal GPU iteration").
- Ridge scene, 2,800 steps on Apple M4: 225 ms/step historically (~10.5 min), and 622 ms/step for
  the wall-repair v4 arm (~29 min) (`KEY_LEARNINGS.md` graveyard).
- Engine E V8 N32 runs at 97 ms/step on an L4 (R11 row).
- DualSPHysics hydrostatic 2 s costs $0.019–0.062 per run, and 10 Dual apps cost $0.050 in total
  (R11 row).
- An A/B pair ("ABBA") is needed for any speed claim, because noisy baselines produced a false 0.842×
  once (`KEY_LEARNINGS.md`, immutable-RHS row).

**Compute.**
- **Local Apple M4** (Metal/WebGPU). One local GPU runner at a time
  (`wave_sim/AGENTS.md` "Shared workspace").
- **Modal GPUs:** L4, L40S, A10G, RTX PRO 6000 (`studio/remote_runner_v0`) and H100. "Independent
  Modal containers may run concurrently without the local GPU lock" (`wave_sim/AGENTS.md`). Modal
  is billed, so scale-to-zero is the default (user `CLAUDE.md`).
- **Other providers:** wave_sim docs also mention B200/H200, CoreWeave and RunPod, mostly in
  business research. No standing remote CPU fleet or SSH worker pool is documented. "Remote
  machines" in practice means Modal apps launched from local scripts (`tools/modal_*.py`,
  `tools/modal_run_v1`).

**Knowledge that must persist.**
- The idea ledger with verdicts. `KEY_LEARNINGS.md` has "Refuted (the graveyard — never delete,
  never re-test without a representation change)", with ~30 rows such as "Multigrid beats Jacobi at
  our grid sizes: 0.93×", "Kernel fusion … 1.06–1.13× — noise", "Pressure warm-start … slower".
- Attempt history per subsystem: "Every request carries the attempt history", and the two-strikes
  rule (`wave_sim/AGENTS.md` Work loop §5).
- Exact source SHA per run: "A commit is the snapshot … A run from a dirty tree is exploratory and
  cannot be cited".
- Artifact digests that outlive worker worktrees.
- Machine identity per measurement.

**What went wrong.**
- Plate lift took ~19 paid attempts, "each moving the fault to the next particle". That produced
  the two-strikes rule.
- f32 tolerances that were too tight failed correct runs three times.
- Process outweighed product. `E_V8_INDEX_COST_V2` has about 7 lines of custody/replay tooling for
  each line of solver, and "Repairs were relabelled 'sidecars', which got around the two-strike
  rule" (`wave_sim/agent_notes/2026-10-12_reset/PLAN.md` §1).
- 114 agent notes were written on 2026-05-11 alone, mostly timestamp/timing-gate checkpoints, out of
  1,763 notes in total. Note volume does not track progress. "Task-completion count as swarm
  progress metric: Hundreds of tasks, zero kernels moved" (graveyard).
- Artifacts were lost in worker worktrees, and later GPU reports were cited but missing
  (`THEORY_FORK_SWARM_RETROSPECTIVE` "Artifact Durability Failed").
- The swarm changed one visible knob, then another, instead of localizing the energy injection.
- "'Fresh eyes' from the same model = independent review" is refuted. Only a blind lens found the
  benchmark gap.

**Done.** On a frozen case set with a frozen error metric, a candidate is faster at matched error
under complete cost, measured on named hardware with an A/B protocol, and independently judged.
Everything else is "candidate".

---

## 4. Frontier simulation research: new math → 10–200× algorithms

**Sources.**
- `wave_sim/auto_research/experiments/pending/astra_wave_sim_restart_v1/README.md`: objective
  "materially faster true-3D breaking-water system under matched physical error and complete
  target-GPU cost". Status READY TO FREEZE, NOT LAUNCHED.
- `wave_sim/auto_research/experiments/EXPERIMENT_PACKET_CONTRACT.md`.
- `wave_sim/theory/` (~40 named theory programs, e.g. `offshore_modal_schur_pressure`,
  `manifold_carrier`, `p2g_superaccumulator`).
- `wave_sim/RESEARCH_ORGANIZATION.md#mathematical-workflow`.
- `wave_sim/KEY_LEARNINGS.md` graveyard.

**Workload shape.** Divergent generation in fresh, isolated contexts, then a blind comparative
census, then one GPU falsifier per selected candidate, then independent judgment. The Astra launch
matrix spells this out:
- `N00-A/B`: neutral discovery;
- `S00-A/B`: architecture-blind sub-volume discovery, each producing a candidate or a no-go /
  lower bound;
- `D00`: exact frozen-candidate census and clustering;
- `L01-*`: one GPU-owned falsifier per candidate;
- `L02-*`: independent judging.

Context allowlists are part of the design: discovery runs see only `MINIMAL_PROBLEM.md` and the
hardware facts, never the project's prior architecture. The evaluator contract is "frozen and
hashed before any S00 output". It is search plus adversarial review, with information hiding.

**Judge.** Two layers.
- (a) A math judge. Statements are labelled TEXTBOOK, LITERATURE, DERIVATION or CONJECTURE, and
  checked for units, limits, conservation, closure, error and complete cost
  (`wave_sim/AGENTS.md`). A blind red team does this.
- (b) A physical falsifier: GPU runs at matched error against the best admissible baseline,
  same-stage integrator comparisons included. Example: "Future temporal candidates must be
  Pareto-compared against same-stage Gauss/Lobatto/Radau, Verlet/RATTLE" (graveyard row on
  polynomial slabs).

**Evaluation speed.** Generating and reviewing one candidate takes hours of model time. The
falsifier takes minutes to hours of GPU time (case 3 numbers). Exact-geometry convergence programs
ran for weeks: the exact-quadric program ended 2026-07-29 RED by 3.2× with exact geometry
(graveyard).

**Compute.** Frontier models for generation and review (Astra/Sol/Opus seats), plus the case 3
hardware for falsifiers.

**Knowledge that must persist.** Frozen prompt bytes, context allowlists, rubric hashes, raw
responses, adjudications, candidate lineage, and refuted representations with their mechanism.
Example: "Exact curved geometry fixes R4F convergence: REFUTED … Geometry error was NEVER the
convergence blocker". This keeps the next generator from re-proposing a dead family. It has to be
done without leaking architecture into blind discovery runs, which is a real tension.

**What went wrong.**
- Exact modal–Schur elimination cut PCG iterations 18% but ran 30% slower overall. Speed was
  refuted.
- Panels judged by density proxies used bad discriminators.
- Endpoint "novelty" turned out to be an integrator-order result against an unfair first-order
  baseline.
- Placement engineering on cell 66 was a dead route.
- "For research/physics exploration, stop after two clean sidecars fail to reduce the blocker.
  Page count, theorem count, and polished prose are not progress" (`wave_sim/AGENTS.md`).

**Done.** One candidate survives an independent, matched-error, complete-cost falsifier on target
hardware with a stated speedup factor. A precise no-go / lower bound that saves future spend also
counts as a valid terminal result.

---

## 5. Expand simulator capability: forces, wind, movable rocks

**Sources.**
- `wave_sim/goals/2026-10-12_three_engine_goals.md`: R1–R12 × engines {E: Eulerian CUDA, A: APIC
  CUDA (PTX/CCCL), DualSPHysics}.
- `wave_sim/product/BETA_SCOPE.md` item 4 (forces and reports) and its "Out of scope" list
  ("Moving rocks, moving/eroding sand, wind, automatic rock-pile settling…").
- `wave_sim/product/MASTER_TASKS.md` §3 (per-row blocked tasks).
- `wave_sim/agent_notes/2026-10-12_reset/PLAN.md`.

**The requirement list.** These are the owner's force / wind / movable-rock requirements:
- **R6 forces:** foil lift ±10% at Re 1000 on two grids, error falling; lift/drag at three speeds
  plus an acceleration ramp; hull drag vs ITTC.
- **R7 moving bodies:** floating-box draft <2%, heave decays, period ±5%, a dropped rock settles,
  momentum exchange closes.
- **R8 sand:** settling <10%, erosion/deposition with feedback, mass ledger to 1e-6.
- **R9 wind:** solved air/water coupling, not only prescribed stress; setup slope ±10%; log-law
  ±10%.
- **R12 conservation.**

Status as of 2026-10-12, with live tasks in `MASTER_TASKS.md`:

| Row | Engine E | Engine A |
|---|---|---|
| R6 foil lift | 15.75% low | sphere +177% |
| R7 draft | 16.5% (needs <2%) | heave decay unmeasured |
| R9 setup | 31% low | WebGPU 38.7% high |

No engine combines all the rows. That is the owner's point.

**Workload shape.** A matrix of requirement rows × engines. Each cell is a deep serial
debug-and-repair loop on one engine, run against a frozen case. The cells are independent, so they
fan out across engines. Within a cell the work is strictly serial and two-strike limited.

**Judge.** The frozen numeric row thresholds, applied to the same `Scene` / initial state /
observation window / reference / scoring through the central runner ("Shared executable cases",
`three_engine_goals.md`). Changing a scoring window makes a separate case, never a pass. Tolerances
come from typed constructors (f32 relative ≥1e-4).

**Evaluation speed / compute.** As case 3. Modal is used for CUDA engines and the local M4 for
WebGPU. Paid runs carry `--max-usd` and per-run dollar estimates in typed results.

**Knowledge that must persist.**
- Per-row failure-class documents (e.g. `agent_notes/2026-10-12_engine_dual/R5_FIXED_SOLIDS_FAILURE_CLASS.md`).
- Saved failures that can be replayed locally before paid spend ("Write a one-page design of the
  whole failure class and a local GPU replay of every saved failure before spending again").
- Diagnosed mechanisms. Example: "Foil lift deficit is in the flow, not the force measurement"
  (`KEY_LEARNINGS.md` 2026-10-07).

**What went wrong.**
- Beta silently depended on the hardest physics row. Item 4 needed force qualification that no
  engine passes.
- Three finish lines (launch, core redesign, physics qualification) were mixed together, so none
  finished (`reset/PLAN.md` §1).
- The plate-lift loop took 19 paid attempts.
- DualSPHysics R5 failed after three methods, and paid R5 runs were stopped for an owner decision.

**Done.** A row passes unchanged on the named engine, from committed source, with complete cost,
and independently re-checked. The matrix records which engine passes which rows. "Working" means
all rows.

---

## 6. Deslop: unify the data model and types, shrink the code (e.g. buddies)

**Sources.**
- `buddies/agent_notes/2026-09-25_lean-rewrite/`: ~70 slice notes T00–T23, `FINAL-REPORT.md`,
  `CLOSEOUT.md`, budgets `BUDGET-{SERVER,CLIENT,BUDDIES}.md`, `DEADCODE.md`, `FEATURE-AUDIT.md`.
- `buddies/agent_notes/2026-09-27_deslop-*.md`.
- The `deslop` skill.
- `wave_sim/goals/deslop_method.md`.
- `rr/docs/DESLOP_PLAN_2026-10-13.md`: ten read-only Haiku scans → an Opus plan → slices.
- `wave_sim/SLOP_ANTI_PATTERNS.md`.

**Workload shape.** A pipeline:
1. Measure: line counts, performance, the data model inventory.
2. Write the lean target with line budgets and canonical owners.
3. Run waves of file-fenced slices in parallel worktrees, each slice "replace and delete one
   redundant path".
4. Integrate serially.
5. Run a final review.

Parallelism is in the middle and must be fenced by file custody ("file-exclusive slices integrate
cleanly, cross-file seams go to a later slice", `rr/key_learnings/agent_workflow_and_evidence.md`).

**Judge.**
- Existing tests and typecheck (`pnpm typecheck` with `tsc -b`).
- Behavior parity through real consumers.
- Screenshots with `--baseline` pixel diffs (buddies `CLAUDE.md`).
- Measured line, performance and data-model deltas.
- The rule "a new interface without retirement is preparatory work, not a completed
  simplification" (`deslop_method.md`).
- Owner review of preserved behavior.

**Evaluation speed.** Minutes per slice (typecheck, unit/integration tests, a screenshot run). Rust
crates add cargo time, and the build cache makes hits cheap (`S12-build-cache.md`: bootstrap on a
cache hit took 5.5 s vs ~68 s cold).

**Compute.** Local. The machine is shared with concurrent sessions, and the tree routinely carries
150+ dirty files (buddies `CLAUDE.md`).

**Knowledge that must persist.**
- The inventory (competing definitions, writers, readers).
- The target design and budgets.
- Per-slice deletion lists and the behavior they preserve.
- The merge-survival checklist (`CLOSEOUT.md` "Source work preserved during closeout").
- Owner "keep" pins (e.g. `rr` DESLOP_PLAN "Kept as-is (non-negotiable)").

**What went wrong.**
- The buddies lean rewrite cut total lines 25% (133,955 → 99,841) and sped things up a lot (WS
  init 1.87 MB → 274 KB; `/api/usage` 16.5 s → 0.97 s). But "the original 3–4× line target was
  not achieved" (`CLOSEOUT.md`).
- A half-applied multi-file commit (48724f4) verified green against the dirty tree (buddies
  `CLAUDE.md` "Verify the COMMIT").
- A shared working file was not an ownership boundary: concurrent commits captured another lane's
  hunks (`rr/key_learnings/agent_workflow_and_evidence.md`).
- The importer pointed at the wrong directory imported 0 records, and verify still passed
  (`FINAL-REPORT.md` 9055ba7).

**Done.** One canonical owner per fact. Superseded paths are deleted along with their tests. Real
consumers behave the same (tests and screenshots). A net source delta is reported, with tests
counted separately. Verified on the commit, not on the working tree.

---

## 7. Straightforward CRUD SaaS apps

**Sources.** The owner named no target repo, so no current CRUD product repo was surveyed. The
nearest grounded precedent for "plan ahead, then fan out" is the buddies lean rewrite above
(T-numbered slices with budgets and owners, `agent_notes/2026-09-25_lean-rewrite/PROJECT.md`).

**Workload shape.** A plan-ahead pipeline with wide fan-out: schema, then API, then UI per entity,
plus auth and deploy. Most dependencies are known before launch, so the plan can be fixed at
launch, unlike every other case. The risks are integration seams (shared schema/types files) and
drift between parallel workers' conventions.

**Judge.** Tests, typecheck, integration tests through real boundaries (`docs/test-strategy.md`),
screenshots, and owner acceptance of the walkthrough.

**Evaluation speed.** Seconds to minutes. **Compute:** local.

**Knowledge that must persist.** The schema and type source of truth ("one type source",
`docs/patterns.md`), conventions, and which feature slices are done or verified.

**What went wrong (analogues).** Merge conflicts when several workers edit shared docs/status files
in one phase (`wave_sim/auto_research/THEORY_FORK_SWARM_RETROSPECTIVE_2026_06_08.md` "Merge
Conflict And Manual Repair"). Taskless workers making changes the merge path later refused.

**Done.** Every planned feature passes its integration test on the integrated commit, and the
owner accepts the walkthrough. This is the only case where a fixed workflow script would be
enough.

---

## 8. Geometry engine for the new document model

**Sources.**
- `wave_sim/studio/design_kernel/DESIGN.md`: owner amendment of 30 October 2026, "our own
  geometry implementation for internal operations, with OCCT confined to explicit external CAD
  compatibility".
- `wave_sim/agent_notes/2026-10-30_own_geometry/{REQUIREMENTS,WORK,MESH_DESIGN,SWARM,RETROSPECTIVE,G2_EVIDENCE}.md`.
- `wave_sim/studio/design_kernel/field_core/` (field core, implicit fields).
- `wave_sim/oompa/geometry/` (guard and swarm config).
- The record `~/.agent-viewer/expeditions/geometry-g0-one-memory-r-314bb5.json`.
- `~/git/geometry_book` is an outline-stage visual geometry textbook (`content/outline.md`,
  one chapter). It is background reading, not engine code.
- `~/git/nova_docs` holds only `speedun_script.py` (a personal-introduction talk script). Nothing
  relevant to the geometry engine or the document model is in it.

**Workload shape.** Deep serial work. There is a small amount of code and a tight test loop, with
math and algorithm design inside the loop. The first replacement is a finite D2 analytic boundary:
curved wall plus cylindrical bore, faces, trim curves, adjacency, meshes, at radii 0.45/0.60 m.
Its correctness depends on geometric facts that have to be derived. Example: the bore cap
intersects the inner wall at r > √(3.75²−2²)−2.5, so that case must be refused
(`REQUIREMENTS.md` "Source-review correction"). Some parallelism exists when packets are
independent (G1 Rust field core ∥ G2 OCCT/STEP separation, `RETROSPECTIVE.md`).

**Judge.**
- The known-answer boundary suite under a resource guard:
  `python3 oompa/geometry/guard.py -- bun test ./studio/design_kernel/native_geometry/boundary.test.ts`.
  The guard is 268,435,456 B aggregate RSS and 60 s. The suite covers all four radii and the
  negative controls.
- Independent cylindrical-chord volume.
- Closure, orientation and manifold checks.
- Cold-reopen identity.
- An independent reviewer. Owner judgment for G0.

**Evaluation speed.** Seconds. The G0 failure was peak 270,024,704 B (just over cap) after 1.42 s,
exit −9, zero tests complete. G1's validator ran 65 checks in 2.776 s at 157 MB peak.

**Compute.** Local CPU only. No OCCT/native CAD, GPU or Modal in these packets.

**Knowledge that must persist.**
- The operation-to-core map (`REQUIREMENTS.md` table).
- Derived geometric conditions and refusal cases.
- Each guarded receipt (commit, command, peak RSS, duration, result).
- The attempt history, including prior residual, capacity and timeout failures.
- Replay budgets: G0 authorized exactly one replay, with "No second replay … no automatic retries".

**What went wrong.**
- **G0 expedition:** attempt 1 was interrupted after ~2 minutes. Attempt 2 answered at 08:31Z with
  the lesson "With a one-shot replay budget, prove equivalence by construction and run synthetic
  checks that don't touch the geometry". It was then `verdict: skipped`, and the expedition ended
  on `deadline` at 10:23Z. The host had no notion of a scarce, one-shot evaluation that is distinct
  from attempts.
- **Oompa swarm `cf9ea773`:** two reviewed and approved candidates, zero automatic merges. The
  acceptance preflight required the shared owner checkout to be clean, so unrelated dirty files
  blocked validation of isolated candidates. The refusal wrote no validator journal. There was no
  supported "resume acceptance of a retained candidate" operation. Lead reporting conflated "eight
  held" with failures. No serial baseline or token cost was assembled (`RETROSPECTIVE.md` "What
  went poorly"). The adapter inspected was `buddies/server/src/buddies/oompa.ts`.

**Done.** All original boundary cases pass from a committed candidate under unchanged caps. An
independent reviewer confirms preserved geometry behavior. The candidate is then handed to Product
for the edit / Undo / publish / cold-reopen receiving checks, which are separate tasks.

---

## 9. Design and critique a new document model (Zoo / Onshape capacity, leaner interface)

**Sources.**
- `wave_sim/studio/DOCUMENT_MODEL.md` (the actual model and its layers).
- `wave_sim/agent_notes/2026-10-11_model_comparison/DESIGN_GOALS_AND_USE_CASES.md` (twelve design
  goals G01–G12 with "how we know it works").
- `.../model_comparison/COMPARISON.md` and `design_v1/{CODE_PLAN,ACCEPTANCE,RETIREMENT}.md`.
- `wave_sim/agent_notes/2026-10-09_document_model_parity/REQUIREMENT_CONTRACTS.md` (the ledger;
  A94 has 22 `OWNER` assertion gaps).
- `wave_sim/agent_notes/2026-10-14_document_model_owner_decisions.md` (12 owner questions, each
  with A/B/C options and a default).
- `wave_sim/studio/design_kernel/09_ADJUDICATION.md` (critique, e.g. "smuggling a feature catalog
  while calling B-rep a backend problem").
- `MASTER_TASKS.md` §7 Zoo-parity roadmap Z1–Z11 (sketch constraint solver, NURBS, graph view as a
  projection, column evaluation within 3× of plain JS, agent-productivity benchmark).

**Workload shape.** An adversarial design loop: propose, critique against the use cases and the
requirement ledger, adjudicate, put questions to the owner, revise. Mostly reading and thinking,
little code. Some prototyping happens to test expressiveness, e.g. the Z9 agent-productivity
benchmark comparing the extension path with the built-in path.

**Judge.**
- The owner, who ratifies.
- The requirement-contract ledger, row by row.
- An independent critique seat.
- Executable spikes where a claim is testable (Z5 performance bound; consumer journeys such as
  edit → Undo → save → cold reopen).

**Evaluation speed.** Hours per design round. Owner latency dominates.

**Compute.** Local.

**Knowledge that must persist.**
- Prior designs and why each was abandoned.
- Owner rulings (dated posts) and the open questions with their defaults.
- The ledger status.
- The capability comparison against Zoo/Onshape.

**What went wrong.** "The data model was redesigned roughly eight times. Authoring v1–v4 and v7,
L6, Marine v0.5, feature_program, PR146, ae4487, DG and cleanroom. None replaced what runs in the
app" (`wave_sim/agent_notes/2026-10-12_reset/PLAN.md` §1 item 3). Design rounds that never
converge into a retirement of the running model are the failure mode.

**Done.** The owner ratifies a model that covers the ledger rows (or explicitly scopes them out),
plus a migration/retirement plan that replaces what runs. A design that sits beside the running
model is not done.

---

## 10. Cross-cutting requirements a single expedition model must satisfy

Each requirement names the cases that force it.

### Shape and plan

1. **Phases have different shapes inside one expedition** (1, 2, 4, 6). The model needs at least
   these as first-class step kinds: fan-out/map over a list with a reduce; a deep serial worker
   with a whole-context handoff; an adversarial pair (distinct seats, see 9); a population/search
   step that keeps the best N and records the rest; a human/owner gate. Today's single
   retry-the-goal loop expresses none of them (`expeditions-leader-design.md` §1).
2. **The plan is revisable between rounds, and unstarted work is patchable within a round**
   (2, 3, 4, 9). Round outcomes change what comes next: an instrumenter must fix the measuring
   stick first, a refuted lever changes the theory, a census selects candidates. A fixed launch
   plan only suffices for case 7.
3. **A pass on one step must not end the expedition, and a fail must not be faked to advance**
   (1). Step results and expedition termination are separate.

### Judges

4. **Judges belong to steps and come in kinds:** exit-code check (8); numeric threshold over a
   typed report (3, 5); statistical comparison over a frozen seed set, with censoring and
   paired/sign tests (2); independent blind model review (3, 4, 9); owner/human (1, 2 playtest,
   8, 9). The model must not reduce all of these to "exit 0 or owner pass/fail for the whole
   expedition".
5. **Judges and metrics are frozen before the run** ("predict before you measure", locked
   protocols, rubric hashed before output; 2, 3, 4). A step records its prediction, then its
   measurement, then its verdict. Lowering a bar after seeing results is forbidden (G3 skill gate).
6. **Judge independence is structural.** The checker is a different seat, model or context than
   the producer. "Fresh eyes from the same model" is refuted (`wave_sim/KEY_LEARNINGS.md`). Blind
   discovery contexts need information hiding: an allowlist of what a node may read (4).
7. **Owner gates must not hold worker capacity or burn the deadline** (1, 8). Waiting for a
   judgment is a state, not a live attempt.

### Evaluations and compute

8. **Evaluations are a scarce, typed resource, separate from attempts** (3, 5, 8). Budgets come in
   kinds: dollars (Modal), count ("exactly one replay", "two strikes then stop paid runs"), and
   wall time. They must be enforced at the moment of spending, not only checked at launch.
9. **Compute classes with concurrency caps** (2, 3, 5): local GPU = 1 runner; the machine-wide
   compile lock = 1; Modal = N concurrent under a dollar ceiling and scale-to-zero; plus "idle
   host required" for timing measurements. Today checks run one at a time host-wide
   (`expeditions-lean-design.md` §11), which would serialize case 2's 48-seed A/B fan-out and
   case 3's Modal population for no reason.
10. **Evaluation cost spans five orders of magnitude**: ~1 s geometry suites, ~6.5 s per match,
    ~2.5 min Modal smoke (mostly setup), 10–30 min GPU scenes, hours of synthesis. Scheduling and
    progress reporting must not assume uniform steps. Complete cost (setup, compile, readback,
    rejected work, tokens) is recorded per evaluation (3, 5; the geometry retro lacked token cost
    and a serial baseline).

### Knowledge across attempts

11. **A structured idea/hypothesis ledger, shared by all parallel workers, written as work
    happens** (2, 3, 4, 5). Each row holds: hypothesis, mechanism family, prediction, source SHA,
    machine, result, verdict (keep / reject / retune-one-family / promote / pivot), evidence
    pointer. New proposals are checked against it ("never re-test without a representation
    change"). One-line lessons per attempt, as the host carries today, are too thin for this.
12. **Attempt history travels with every request to the same subsystem**, and stop rules read it:
    two strikes per subsystem; two clean sidecars that fail end the research; retune only one
    named parameter family; one change family per experiment (2, 3, 5).
13. **Artifacts outlive worker trees.** Each result keeps a digest, a small tracked summary and a
    pointer to raw output in the repo's artifact store. "Only in a worker worktree" is not an
    acceptable completion (3, theory-fork retro). Results cite a commit, never a dirty tree.
14. **A canonical home per kind of knowledge, in the target repo's own structure** (the theory doc
    with its progression log, KEY_LEARNINGS, the failure-class doc, the source ledger), not a new
    notes root. Expeditions write into existing owners. Generated output goes to the ignored
    `output/` (`wave_sim/AGENTS.md`, `wave_sim/auto_research/README.md`).

### Integration and custody

15. **Validate an immutable candidate commit independently of the shared checkout, then integrate
    serially through an owned clean checkout** (6, 8). A dirty shared tree must not block
    validation. Every pre-validation refusal persists its phase and reason. A retained,
    already-reviewed candidate can resume acceptance without being recoded.
16. **Write custody per step.** Only one role edits shared docs/status files in a phase.
    Experimenters are fenced to files or worktrees. Every round has a role that owns code fixes
    and one that owns the meta-plan, because reflectors that cannot edit stall the round (2, 6,
    theory-fork retro).
17. **Distinguish stages explicitly in status**: selected / implementing / reviewed / validated /
    integrated, versus planned / waiting on dependency / resource-stopped (8 retro).

### Honesty and stopping

18. **Typed claim levels on outputs** (candidate vs accepted; VERIFIED / CLAIMED / SPECULATION;
    claim flags false until audited). Expedition summaries cannot promote a claim (1, 3, 4, 5).
19. **Progress means the blocker moved, not activity.** Notes, task count, page count and theorem
    count are not progress (3, 4). The leader's reflection compares outcome to prediction and can
    end the run with "no change worth shipping" as a valid result (2, round 1).
20. **The deadline bounds work, not judgment.** At the deadline the expedition delivers the
    best-supported state and honest gaps (1; repo commit `bce2400`). A finished expedition still
    gets its verdict.
21. **Owner rules are fixed inputs.** Levers that bend them are proposed, never applied (2). Spend
    holds, numerical tolerances and scope pins carry through every brief unchanged (3, 5, 8).

### Leanness

22. **One model, not a framework per case.** The repos already contain an Oompa task queue, a
    `goal_manager.py`, Workflow scripts, AI-OS macros, the v4 auto-research runner and the
    expedition host. Each case above can be expressed as a few step kinds plus a ledger plus typed
    budgets. The design must replace machinery, not add a seventh orchestrator. wave_sim's
    7-to-1 custody-to-solver ratio is the warning.

## 11. Open questions this brief surfaces (not answered here)

- How should a node read the shared ledger without breaking blind-context isolation (4 vs 11)?
- Is a "population/search" step its own kind, or a fan-out with a selection reduce?
- Where does the statistical judge live: a check script in the target repo (e.g.
  `rr/reports/tidewar-balance/compare.py`) or a host primitive?
- Should remote compute be a host-level resource class, or only a budget the step's own scripts
  spend (Modal launches are repo scripts today)?
- What does "matched error" look like as a generic judge contract that is not specific to
  wave_sim?

## Cross-cutting requirement: parallel scaling (added 2026-11-09)

Every design must decide its width per unit of work, following the decision rule in
`scaling.md` §4. The rule comes from the primary sources checked on 2026-11-09:
- Google/DeepMind/MIT (arXiv 2512.08296): parallel work gains +80.8% on decomposable tasks and
  loses up to −70% on sequential ones. Unverified independent agents amplify errors 17.2×,
  centralized ones 4.4×. Above 45% single-agent accuracy, extra agents give negative returns.
- Princeton et al. (arXiv 2603.12229): centralized preassigned teams beat decentralized ones
  (1.36× vs 0.88×), and real speedups stay below the Amdahl bound.
- Learning to Share (arXiv 2602.05965): shared memory across parallel teams cuts repeated work.

How each case applies the rule:
- **Wide** (decomposable, with a cheap verifier): case 1 collection, case 2 simulated games,
  case 3 benchmark configs on local and remote machines, case 5 independent features, case 7 CRUD
  modules, case 4/8 candidate search once an exact benchmark exists.
- **Narrow** (sequential or judgment-gated): case 4/8/9 derivations and design arguments, case 6
  cross-cutting type unification.
