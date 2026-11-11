# Expeditions: four designs, one verdict

Status: **judgment, 2026-11-09. Nothing is built, committed or launched.** This page compares four
designs for the next generation of expeditions against the owner's nine use cases, re-checks
their Quint models, and recommends what to build. Today's code is the lean retry loop: one crew
turn per attempt, judged by a command's exit code (`done: checks`, `server/src/expeditions/checks.ts`)
or by the owner, with only a one-line `Lesson:` carried forward (`server/src/expeditions/brief.ts`).
It has at most 4 live and 60 attempts (`shared/src/expedition.ts:44-45`) and is 2,349 lines
(server + shared, `wc -l` today). Its live record shows the failure: the GTM expedition
(`~/.agent-viewer/expeditions/gtm-evidence-thesis-buye-dd0984.json`) is still `running` with one
attempt, 40 hours after its 2026-11-08 07:30 deadline. The geometry G0 record finished on
`deadline` with 2 attempts.

**Verdict in one line:** build a hybrid. Use V3's kernel (Jobs on Pools over one Ledger), V4's
typed attempts and edges plus its `judging` status, and V2's warm lanes. Pilot it on case 1 (GTM).
§4 says exactly which concept comes from where.

## 1. File index

| Kind | File | What it is |
|---|---|---|
| Design | [`v1-leader-rounds.md`](v1-leader-rounds.md) | The owner's leader + meta-plan + rounds of typed nodes (agent/fan/check/gate), typed predictions, outer reflection with a two-miss forced change, versioned objective with CAS ratification. Rev 2. |
| Design | [`v2-leader-rounds-refined.md`](v2-leader-rounds-refined.md) | V1 plus 14 changes: warm lanes, quiet clock, family death with cancel, keys counted in providers, anchors, sealed trees, host integration at round close, auto-continue. Rev 3. |
| Design | [`v3-first-principles-kernel.md`](v3-first-principles-kernel.md) | Jobs on Pools over a Ledger under a frozen Charter; judges bound to row keys; a rate-limited stateless plan job; judgment drains past the deadline. Rev 2. |
| Design | [`v4-first-principles-search.md`](v4-first-principles-search.md) | Search over a frontier of nodes scored by frozen gauges; `allocate()` with a per-claim width rule; `work`/`sample`/`revise` attempts; `needs`/`reads` edges; `judging` status. Rev 2. |
| Spec | [`../specs/expedition-v1.qnt`](../specs/expedition-v1.qnt) | 1,037 lines; 23 invariants, 36 witnesses, 14 guard ablations |
| Spec | [`../specs/expedition-v2.qnt`](../specs/expedition-v2.qnt) | 1,464 lines; 34-conjunct `safety`, 57 witnesses, 27 ablations |
| Spec | [`../specs/expedition-v3.qnt`](../specs/expedition-v3.qnt) | 505 lines; 13 outcome invariants, 27 witnesses, 10 mutants (diffs in `../specs/mutants/`) |
| Spec | [`../specs/expedition-v4.qnt`](../specs/expedition-v4.qnt) | 846 lines; 18 invariants, 28 witnesses, 13 directed `quint test`s, 7 mutants (diffs in `../specs/mutants/`) |
| Spec | [`../specs/mutants/`](../specs/mutants/README.md) | V3's 10 and V4's 7 mutants saved as `.diff`s against the committed models, with how to apply and run one. The V4 diffs predate the final model and carry about 48 lines of drift |
| Research | [`research/use-cases.md`](research/use-cases.md) | The nine cases from a read-only repo survey; 22 cross-cutting requirements (§10) |
| Research | [`research/prior-art.md`](research/prior-art.md) | oompa, three expedition generations, Workflows, AI-OS; 20 failure lessons; token numbers |
| Research | [`research/external.md`](research/external.md) | Published systems: FunSearch, AlphaEvolve, Shinka, autoresearch, Anthropic harnesses, judging, caching |
| Research | [`research/scaling.md`](research/scaling.md) | When width helps (arXiv 2512.08296, 2603.12229, 2602.05965) and the seven-rule width decision (§4) |
| Older | `../expeditions-leader-design.md`, `../expeditions-lean-design.md` | The owner's leader sketch and the design of today's code |

## 2. Scorecard

Scores are 1–5 (5 = the case's own failure mode is closed by a host-enforced mechanism; 3 = it
works but rests on LLM judgment or an unbuilt ❌; 1 = the design does not express the case). They
score the **revised** documents, not the pre-revision critiques.

### 2.1 The nine use cases

| Case | V1 leader + rounds | V2 refined | V3 kernel | V4 search |
|---|---|---|---|---|
| 1 GTM | **3**: parking stops the deadline burn; fetched digest ≠ read; cold seats ≈1.0–1.3× naive | **4**: anchors (quote in stored bytes) + warm lanes for 40 collections + 2-key thesis | **3**: owner pool holds nothing; duel bounded by `newKeys` grant guard; audit is plain LLM | **4**: 38-parent synthesis on `reads` edges survives failed collections; `judging` lands late owner keep |
| 2 Tidewar | **3**: compile-lock pool; stacking left to one agent | **4**: host merge + re-check per round catches "confirmed alone, stacked badly"; lane trees keep `target/` warm | **3**: build as a judge in the chain; `loadBelow` idle rule; no stacking re-check beyond E3 | **4**: cost in compile-lock seconds ranks levers; serial land reverts a biased stack |
| 3 wave_sim | **3**: host-refilled population; Modal only | **3**: `carry` lanes as islands, classified-family eval guard; Modal only; token gain is a guess | **4**: only design with ssh + Modal + local in one pool model, re-attach of remote runs, start vs refutation quotas (ssh ❌ unbuilt) | **3**: probes in the Modal pool keep nodes iterating; no ssh (q3); local seat ceiling |
| 4 Frontier math | **2**: scratch tree has no network denial; parent policy unmodelled | **3**: `llm` pool scales generation with money; only failed checks strike; sealed tree is tier-3 ❌ | **3**: blind views, census `emits`, in-turn evolve on `[agent, gpu]`; one planner in flight | **2**: ~6 concurrent tries (local seats), blind ❌; honest about expecting `nogo` |
| 5 New capabilities | **2**: no nesting; a redesign cell is just `blocked` | **3**: `blocked.needs: redesign` routes it; non-blocking `run_eval` | **4**: `Done = all(row = any(engine))` states the matrix exactly | **3**: `rows` target, share-of-gap gain comparable across cells |
| 6 Deslop | **2**: 1.5–1.6× naive tokens (cold seats); one integrator agent at the end | **4**: per-wave host merge + re-check on the merged sha; auto-continue while green | **4**: per-claim merge, re-check, ff-only, `fix` spawn on red | **3**: fences + serial land; no warm forks, so cold-seat cost per slice |
| 7 CRUD | **3**: works; a Workflow script is lighter | **4**: pre-written graphs auto-continue | **5**: `plan: none`, zero planning tokens | **4**: whole plan seeded as `work`; steward wakes only on a strike |
| 8 Geometry | **3**: named eval count fixes "one replay"; one thinker | **3**: fan of derivations, census spends the replay on the winner | **4**: `[agent, cpu-guard]` inner loop, replay `starts 1`, owner `integrate` on a finished record (cf9ea773) | **4**: probe ×40 inner loop, `replay` count 1, `land` resumes a kept candidate |
| 9 Document model | **3**: trio + parking; two misses force a structural change | **3**: anchors to ledger rows; critic fan | **3**: Done requires `retirement-plan` accepted + every row verified or scoped | **2**: self-rated weakest; gain is 1 per kept row |
| **Sum (of 45)** | **24** | **31** | **33** | **29** |

### 2.2 Cross-cutting columns

| | V1 | V2 | V3 | V4 |
|---|---|---|---|---|
| Simplicity (concepts) | 11 nouns, 4 node kinds, 37 named types; ≈3,800 lines (1.6× today) | 12 nouns, 37 types, more union variants; ≈3,970 lines (1.7×) | 15 named things (honestly recounted from 6); ≤2,900 lines (1.2×) | 7 nouns, many variants; ≈2,800 lines (1.2×) + ≈290 ❌ |
| Token efficiency (all estimates; none measured) | worst: 1.0–1.6× naive at cold seats; 30-min tick wakes unpriced | 0.9× (1), ≈0.6–0.8× (3, labelled a guess), 0.85–1.25× (6) | claims 0.17× (3), 0.4× (2), 0.25× (7) against a quadratic-history naive; optimistic | 0.6× (3, 7), 0.9× (1), stated as upper bounds on savings |
| Frontier scaling (revised after the Scaling examples) | 2 (review: 2.5): population children hold `cpu` (cap 3) while they call `run_eval`, so at most 3 evals run at once, not the 5 its section claims; every new lineage costs a leader wake | 3: lanes ≤ `llm` 8 and rollover by score move budget without a wake; but one open fan per round, so evaluation width is 1 + 4 | 3: evaluation width is separate from planning (E1 spawns judges from `held`, zero planner tokens): `modal` 6 + `gpu-local` 1 today, `ssh-gpu` ❌; but only 4 proposers run at once and the default pushes wide (E4 refills any pool below cap) | 3: the only width formula, but it caps **samples** of one claim; distinct `work` nodes run at the seat cap (~6) above W[review] = 4; the steward wakes to refill |
| Owner control | 4: CAS ratify on (base, id), work clock parks, wall hard stop, 4 owner bugs as ablations | 4: V1's plus auto-continue yields to a queued owner event | 3: amend rows + owner integrate after finish; no objective revision path, judges frozen until relaunch | 4: `judging` keeps owner verdicts live; only the owner `supersede`s a gauge; batched asks |
| Quint evidence (claimed) | 23 inv ok at 3k–20k samples; 36/36 witnesses; 14/14 ablations violate | 34-conjunct `safety` ok on 6 steps; 56/57 witnesses; 21/22 ablations (A27 only in a looser variant); unreached witnesses exposed a design gap (classifying every check starved host-met) | 13 inv ok at 3k and `safety` at 30k; 27/27 witnesses; 10/10 mutants caught; found 1 real design bug (`notStuck`) | `safety` ok at 3k (others at 300); 13/13 tests; 7 mutants caught (M3 only by a directed test); 4 witnesses unreached by simulation |

The frontier-scaling row changed after each design gained a "Scaling example" section and a
review checked them. Scores held, except that V1's writer claimed 3 and the review gave 2.5,
which rounds to 2 on this legend. None reaches 4: in all four, rules 5 and 7 of
`research/scaling.md` §4 and straggler hedging have no host mechanism. Case 3 favours V3,
narrowly ahead of V2; the narrow judgment cases (8, 1, 9) favour V4.

No design ran `quint verify` (no JVM on this machine). Every Quint result anywhere in this folder
is random simulation, not proof.

### 2.3 Quint re-check (this review)

Run with `pnpm dlx @informalsystems/quint@0.33.1` (the same 0.33.1, Rust backend) from
`docs/specs/`, at the seeds the docs record. Script:
`/private/tmp/claude-501/-Users-nicholasbardy-git-buddies/7f8221f8-9cfa-4109-ae0f-8e52e6b36925/scratchpad/judge/runq.sh`.

Load average was 25–45 from other sessions during the runs.

| Model | Command (abridged) | Result here | Matches the doc? |
|---|---|---|---|
| all four | `typecheck expedition-v{1,2,3,4}.qnt` | exit 0 ×4 | yes |
| V1 | `run --invariant=safety --max-samples=3000 --max-steps=80 --seed=0x1472e2a7e30d045e` | **ok** (23 conjuncts), 58 s, every trace runs the full 80 steps | yes (doc: ok at 20,000) |
| V1 | ablation A8 `--step=stepAnyPassFinish --invariant=metOneSha --seed=0xc259f8decde67e52` | **violated**, as required | yes |
| V2 | `run --invariant=safety --max-samples=3000 --max-steps=80 --seed=0x688a117573163bcd` | **ok** (34 conjuncts), 416 s at 7 traces/s | yes |
| V2 | ablation A26 `--step=stepYesSameProvider --invariant=twoKeyYes --seed=0x7d1ecc0ba6cedf4b` | **violated**, as required | yes |
| V3 | `run --invariant=safety --max-samples=3000 --max-steps=40` (two runs, random seeds) | **ok** ×2; mean trace 17.1 and 17.4 steps | yes (doc: mean 16–18) |
| V3 | witness `wNeverIntegFailed --seed=0xd807b652a9a2cea8` | **violated** (state reachable) | yes |
| V3 | mutants m7 `landedChecked`, m5 `strikesAreRefutations`, m4 `notStuck` at the doc's seeds (scratchpad `mut/`) | **violated** ×3 | yes |
| V4 | `run --invariant=safety --max-samples=1000 --max-steps=40 --seed=42` (two runs) | **ok** ×2, 3–4 traces/s | yes (doc: ok at 3,000) |
| V4 | `test expedition-v4.qnt` | **13/13 pass** (two at 10,000 samples) | yes |
| V4 | mutant `m4_nowidth.qnt --invariant=widthClamped --seed=0x277cc92` | **violated** | yes |
| V4 | mutant `m6_readsneeds.qnt`, `quint test` | `reduceOverDeadReadTest` **fails**, as required | yes, with one drift: the mutant file carries 11 of the 13 tests (no `needsChildOfKeptTest`, `budgetFinishTest`); it predates the final model |

No discrepancy in a claimed result. Two observations the docs do not make:
- V3's traces stop early (mean 17 of 40 steps) because a finished record has no enabled action,
  while V1, V2 and V4 always run to `--max-steps` (they have idle or tick actions after finish).
  So V3's 3,000 samples explore fewer states per sample than the others' numbers suggest.
- V1's `safety` ran at 51 traces/s and V2's at 7: V2's model costs about 7× more per trace. Its
  rev-3 additions (strike fold, keys, integration) made the model that much heavier.

## 3. Where the designs really differ

Naming differences are ignored. V4's Steward is V1's Leader, V3's plan job is that leader made
stateless, and V3's recipes are V1's node kinds; each doc admits this. These six axes are real:

| Axis | V1 | V2 | V3 | V4 |
|---|---|---|---|---|
| **A. What forces a decision point** | Round barrier: a round closes, is graded against frozen predictions, then the leader must reflect | Same barrier, but met + host-graded rounds auto-continue | No barrier: a stateless plan job when a fill pool drops below low water, ≤ 1 per cache TTL | No barrier: a child starts the moment its parents settle; steward wakes on typed reasons (batch of K, struck, frontier low) |
| **B. Who decides width** | Leader judgment + effort table | Leader + lanes ≤ `llm` cap; rollover by score moves budget | Plan job inside its grant; `population` sub-grants | Host formula per claim: `clamp(ceil(ln(1−q)/ln(1−p̂)), 1, W[verifier])`, W = 16/4/1 |
| **C. How "progress, not activity" is enforced** | Typed predictions graded by host/judge; two missed rounds refuse `continue` (Quint `g10`) | Same + a rewrite must actually change the plan | Done predicate over claim statuses + quotas; no prediction grading of the planner | Gain per scarce unit drives allocation; strikes along revise chains; no forced plan change |
| **D. What a strike is and what it kills** | Two judge `reject` verdicts on a family, checked at plan time only | Failed checks only (families with an evaluator); death cancels running work; canary miss voids strikes | `refuted` verdicts against a per-family refutation quota; `unjudged` never strikes; separate `starts` quota | A struck claim *group*; exhaustion only along a revise chain of depth ≥ `strikes`; a later keep reopens |
| **E. Integration** | One integrator agent node on a branch | Host merge at every round close, re-check on merged sha, branch head = next base | Host merge per verified claim, re-check, ff-only; judgment class, re-entrant, owner can integrate after finish | Host serial `land` per kept node, re-measure target gauge on head, revert on regression |
| **F. Where judgment lives after the deadline** | Checks, gate answers, verdict and close report continue; parked work clock | Same | `draining`: judges, owner jobs and integration keep **starting**, funded by `held` reserved at production | `judging{cause}` holds nothing; owner verdicts and target lands continue; `close-judging` picks the reason |

Two further differences matter for the build. V3 is the only design whose job may hold **several
pools at once** (an agent seat plus the GPU or the guard-suite slot), which cases 2 and 8 need for
their inner loops. V4 instead runs inner loops as `probe` calls in the stage's pool, and the GPU
is free while the agent thinks. V1 and V2 keep a **versioned Objective** with owner ratification;
V3 and V4 freeze the done condition in the charter and let only the owner change it.

## 4. Recommendation

### 4.1 Build the hybrid "V3 kernel + V4 attempts + V2 lanes", not any single design

V1 and V2 put a round barrier and a stateful leader at the centre. The scaling evidence argues
against both: preassigned central coordination with straggler rebalancing beats barriers
(`research/scaling.md` §2), and leader wakes were 1.4 turns per work turn in the ledger generation
(`prior-art.md`). V2 is also 1.7× today's code before its tier-3 items. V4 has the best width rule
and the cleanest termination, but its frontier tops out at the local seats, and it has no
multi-pool job or remote launcher. V3 has the smallest checked kernel, outcome invariants that a
mutant of each fix breaks (not restated guards), a safety violation that simulation itself found
and the design then fixed (`notStuck`), and the best fit for cases 3, 5, 7 and 8. It lacks V4's typed
attempts and edges, which close real holes in cases 1 and 7.

| Concept | From | Why this one |
|---|---|---|
| Charter frozen + hashed; owner changes are `amend` rows | V3 | One versioned record; judges and bindings never move mid-run (use-cases §10.5) |
| **Job** with `pools: [PoolId, …]` reserved all-or-nothing; per-pool queues | V3 | Agent + GPU / guard slot in one job (cases 2, 8); replaces the host-wide check queue (`checks.ts`) |
| **Pool** kinds `agent`, `host{cpu, gpu, lock}`, `remote{modal, ssh}`, `integrator`, `owner` | V3 | The only design that types local + Modal + ssh for case 3 |
| **Ledger** rows + bounded projections; pinned rows never digested away | V3 | One store, selective sharing (`scaling.md` rule 4); kills the Lesson line |
| `unjudged` status, never a strike; E9 prune of unstartable work | V3 | Both are Quint-checked fixes (`rFinishedAllJudged`, `rNoRunningWedge`, mutants m1/m2/m9) |
| Reservation for **every** LLM turn incl. judges and planner; usage-stream kill; I1 overrun-bounded | V3 + V4 M5 | No design is honest without it; V3's `wStrictBudget` shows the strict form cannot hold |
| Attempt kinds `work` / `sample{of}` / `revise{of}` and claim-group strikes | V4 | Routine fan-out never narrows or self-cancels (V4 tests `distinctWorkNeverStrikesTest`, `parallelSamplesOneStrikeTest`) |
| Edges `needs` / `reads` | V4 | A 38-parent GTM synthesis survives failed collections (`reduceOverDeadReadTest`) |
| Width cap per claim, clamped by verifier strength (16/4/1) | V4 | Implements `scaling.md` rule 6 as a host rule for **samples** of one claim (distinct `work` nodes are capped only by their pool; §4.4); only the cap, not UCB ordering |
| `judging{cause}` status (holds nothing; late owner keep still lands) | V4 | Same intent as V3's `draining`, but cleaner: no `held` needed for zero-cost owner verdicts |
| Strikes only from failed **checks** in a family that has a machine judge | V2 C3c | A single LLM "no" must not kill a measurable lineage (FunSearch: 4 of 140 runs) |
| Family assigned by a judge (novelty/classify), never by the proposer | V3 MF8 / V2 `classify` | Closes the "sidecar" relabel at the spend point |
| Warm **lanes**: forked base session per seat tier, reused tree per lane | V2 C1 | The single largest token lever; cold seats cost 20–33k each (`prior-art.md`) |
| Anchors: claim → `{source digest, quote}` checked by the host | V2 C5 | Zero-token source audit for cases 1 and 9 |
| Integration: per verified claim, merge + re-check on merged sha, ff-only, judgment class, re-entrant | V3 E3 | Durable across restart and deadline; closes 48724f4 |
| Plan job: stateless, low-water + `minIntervalS` + horizon batch; `plan: none` for fixed DAGs | V3 | Leader without the session; zero planning tokens on case 7 |
| Plan batches carry typed predictions; two missed batches refuse a non-structural plan | V1 G10 | The only mechanism in any design for "progress means the blocker moved" (use-cases §10.19) |

**Not taken:** rounds and meta-plans (V1/V2), the versioned Objective and its CAS ratification
(owner `amend` rows cover it), canaries and sealed trees (V2 tier 3, no probe exists),
`auto_continue` (V3's `plan: none` and low-water planning make it unnecessary), UCB allocation
order (V4 leaves it unmodelled; slice 1 uses spawn order), `allocate()`'s gain/cost ranking until
per-job cost is recorded.

Honest size: about 16 named concepts and ≈ 3,000 lines (V3's ≤ 2,900 + lanes ≈ 80 + anchors ≈ 25 +
attempt/edge variants), i.e. 1.3× today. Stop rule: past 3,300 lines, cut lanes to plain forks and
drop the width cap before adding anything.

### 4.2 The smallest first slice (case 1, GTM)

Pilot **case 1**, not case 3. It is the live failure (a record running 40 h past its deadline), it
needs no GPU or Modal money, and it exercises the parts every case shares: fan-out, a `reads`
reduce, an adversarial duel, an owner gate, and the deadline. Case 3 needs remote pools, families
and quotas first, and wastes paid compute if the kernel is wrong.

Slice 1 (each item is a ❌ today):

1. **Per-job usage and the reservation kill** (V4 build step 1, V3 MF10). Wire the provider-usage
   fold (`docs/turn-lifecycle.md#provider-usage`) into each job, stop the turn at its reservation
   with reason `reservation` (never `user_stop`). Without this no budget invariant is true in code.
2. **Job / Pool / Ledger record and `fill()`** with per-pool caps and all-or-nothing multi-pool
   reservation. Reuse `record.ts` and `host.ts` `serialized`/`commit`. Delete `fill`/`startAttempt`
   and `brief.ts` `lessonOf`.
3. **Schema-forced `report` tool** (from `tool.ts`), with `malformed` as a typed failure.
4. **`needs` / `reads` edges and the `owner` pool**, judgment class, plus the `judging` status.
5. **Anchors** as a built-in host judge.
6. **Charter with `plan: none`**: the GTM DAG is seeded by hand (scope → 25–40 collect `work` jobs →
   synthesis with `reads` on all → 3 attack/defend pairs with a cross-provider judge → packet →
   owner judge). No plan job, no families, no width, no integration, no remote pools in slice 1.
7. **Adoption of expedition job turns**: stop discarding them (`server/src/lifecycle/shutdown.ts:110`
   `ports.discardCrewTurns()`). If this slips, the pilot must not span a backend restart.

Slice 2 adds lanes (warm forks), the plan job with predictions and the two-miss rule, families
with judge-assigned identity, and per-claim integration. Slice 3 adds remote pools, quotas, the
width cap, two new host width rules (the rule-5 ceiling and the rule-7 narrowing, both ❌ in every
design; §4.4), and case 3.

Before any code: port the hybrid's core to one Quint model. That means V3's model plus V4's
`needs`/`reads` and attempt groups. Re-run V3's 10 mutants and V4's 7 against it.

### 4.3 What to measure in the first real run

Record each per job and compare with the 2026-11-08 run (one 7-minute attempt that then held the
only slot in `judging`; phase 1 never finished in 6 h):

| Measure | Why | Pass line |
|---|---|---|
| Tokens per job: input, output, cache read, cache write; $ per seat tier | Every token table in all four docs is an estimate | Recorded for 100% of jobs |
| Cold-start tokens per collection job | Prices lanes before slice 2 builds them | Number, not a guess (prior-art says 20–33k) |
| Planner/steward turns per work turn | Ledger generation ran 1.4 | ≤ 0.2 (V4's target); 0 with `plan: none` |
| Wall clock to synthesis start; to packet | Fan-out benefit | Synthesis inside 2 h |
| Collections refuted or interrupted, and whether synthesis still ran | `reads` semantics | Synthesis runs with any number of failed collections |
| Anchor pass rate on synthesis claims; claims tagged VERIFIED vs CLAIMED | Source audit without tokens | ≥ 0.95 or the claim is demoted |
| Duel rounds that produced a new counterexample key | Is the adversary real (prior-art "fake adversary") | ≥ 1 of 3 |
| Owner wait time, and time spent in `judging` | Gates must hold nothing | Zero seats held while waiting |
| Overrun Δ per job and per provider | V3 I1 bound, V3 open q5 (codex reports per turn) | Δ ≤ one response on claude; codex measured |
| Restart behaviour, if a reload happens | Adoption | No job re-run, none lost |

### 4.4 Scaling example for the hybrid

This section applies `research/scaling.md` §4 to the §4.1 hybrid. **(m)** marks a number measured
in `research/use-cases.md` or `prior-art.md`. **(e)** marks an estimate from a design doc. The
owner's summary of frontier scaling, "mostly just get more in parallel but also share results in a
good way", maps to rules 3, 4 and 6 below. The hybrid inherits those mechanisms. It inherits no
mechanism for rules 5 and 7 or for stragglers.

| # | Rule | Hybrid concept (§4.1 row) | Status |
|---|---|---|---|
| 1 | Wide only on decomposable work | Attempt kinds: `revise{of}` chains stay width 1; `plan: none` seeds a fixed DAG | Partly host. ❌ Decomposability is not typed; only pool caps stop a plan fanning out a sequential chain |
| 2 | Never wide without a central verifier | Judges bound to row keys; `unjudged` never strikes; integration only of verified claims; anchors | Host for claims. ❌ Agent-written rows (collect, idea, measurement) reach briefs unverified |
| 3 | Coordinate centrally; rebalance stragglers | One stateless plan job; `fill()` hands the next pending spec to any freed pool slot | Host for queued work. ❌ No hedge or reassign of a slow job in flight. Needs a straggler rule (a duplicate start, or cancel and requeue past a wall multiple) |
| 4 | Share selectively through one store | Ledger + bounded projections, pinned rows; family assigned by a judge | Host. No job messages another. Selection is weak where rule 2 is ❌ |
| 5 | No added agents above ~45% single-agent success | none | ❌, and contradicted: both inherited width rules widen in the 0.45–0.5 band (V3 §5 table: "contested → 2–4 variants"; V4 formula: w = 3 at p̂ 0.45–0.5) |
| 6 | Width earned from the verifier | Width cap per claim, W = 16 / 4 / 1 by gauge strength; remote pools for exact evals | Host for `sample`s of one claim only. ❌ Distinct `work` nodes are capped by their pool, not by W |
| 7 | Narrow when tokens per verified result stop improving | Per-job usage (slice 1 item 1) makes the number computable | ❌ No narrowing rule. `allocate()`'s gain/cost ranking is explicitly not taken (§4.1) |

**Example A, wide: case 3 wave_sim (slice 3 only).**
1. Verifier: exact R-gates (m: hydrostatic error < 1%, sloshing period ±2%, solitary celerity ±3%,
   dam front ±5%), then ABBA matched-error timing, as in V3's case-3 charter. Gauge strength is
   machine, so W = 16 samples per claim.
2. Proposers: V3's charter has `claude-opus` 2 + `codex` 2, so 4 proposers run at once. V2 warm
   lanes cut the per-seat start cost (m: 20–33k fresh input per cold seat). The 16 samples still
   arrive in waves of about 4, bounded by the agent pools, not by W.
3. Evaluation: judges are spawned from `held` (V3 E1), so evals fan out at zero planner tokens on
   `modal` 6 + `gpu-local` 1. `ssh-gpu` waits for its ❌ launcher.
4. Sharing: each `idea` row gets its family from a judge, so a relabelled sidecar maps back to its
   family. Only failed checks strike (V2 C3c).
5. Gaps: a 29-minute M4 run (m) blocks `gpu-local` with no hedge (rule 3 ❌). A Modal smoke took
   157.8 s in total for 1.1 s of compute (m), so fixed overhead dominates short evals. V3's cost
   estimate is 1.3M tokens for 50 experiments against ~7.5M naive (e). Tokens per verified result
   becomes measurable after slice 1, but nothing narrows on it (rule 7 ❌).

**Example B, narrow then widen: case 8 geometry kernel.**
1. Narrow: one `work` seed on `[claude-opus, cpu-guard]` (multi-pool job), with V3's case-8 pools
   (`cpu-guard` 2, `claude-opus` 1, `codex-high` 1). The agent runs the guard suite in its own turn
   (m: 65 checks in 2.776 s). The derivation continues as `revise` chains at width 1.
2. Scarce replay: family `g0-replay` has quota `starts 1`, so a second replay is pruned.
3. Invest in the verifier: the run writes the derived refusal conditions as known-answer cases,
   judged by codex review and the owner (judgment gauge, W ≤ 4 samples).
4. Widen: ❌ not inside the run. The hybrid keeps V3's frozen charter ("judges never move mid-run"),
   so the accepted suite becomes a `command` judge only on an owner relaunch with higher caps.
   V4's steward `freeze` + owner `supersede` path is not in the §4.1 table. Widening is an owner
   act, not a host trigger, unless an `amend` variant for judges and pool caps is added.

**Rules 5 and 7 become slice-3 host rules (added to §4.2).** Both are cheap once per-job usage
(slice 1) and families (slice 2) exist, and without them nothing in the hybrid ever narrows.
- **Rule 7:** record verified results per 1k tokens per family from per-job usage. When it stops
  improving across successive plan batches, the host lowers that family's width cap. The window
  length is a charter setting, not yet chosen.
- **Rule 5, with a qualification:** the 45% result came from *coordinated* teams. Independent
  samples each gated by an exact verifier are pass@k, a different setting. So the clamp applies to
  `work` fans and judgment-gauged claims, not to machine-gauged `sample`s. It fires on a
  **measured** first-try verify rate over a minimum try count, never on a prior (V4's p̂ starts at
  0.5 with zero data). The inherited 0.45–0.5 band in V3's §5 table and V4's formula must change to
  match.
- **Stragglers** (rule 3) stay ❌ and are not in any slice yet.

## 5. Completeness critic

### 5.1 What no design handles well

- **Case 4 (frontier math) and case 9 (document model) stay judgment-bound in all four.** Novelty,
  a fair baseline, "new math" and "a good design" are LLM or owner judgments. Every design only
  routes them to another provider and fences them with budget. None measures judge accuracy;
  V2's canaries need an owner-written known-answer set that does not exist.
- **Remote agent seats.** Every design runs agents locally and only evaluations remotely. Case 3's
  "parallel across local AND remote machines" is met for evaluation only. Agent breadth stops at
  the local seat cap (≈ 6), which V4 says outright and the others leave implicit. No ssh fleet is
  documented (`use-cases.md`), so V3's ssh launcher is designed for a resource that does not
  exist yet.
- **Blind isolation is unbuilt in all four** (V1 scratch tree without network denial, V2 sealed
  tree pending a harness probe, V3 `blind` views as projection filters only, V4 sparse tree ❌).
  For case 4, blindness is advisory everywhere.
- **Judge independence collapses with one provider.** All four count "independent" as "another
  provider". A one-provider charter has no independent judge; only V2 (q3) and V4 (q9) say so.
- **The relabel trick is narrowed, not closed.** V2's `classify`, V3's novelty judge and V4's
  dedupe stage are each a single LLM key. V4 names its own hole: a steward plans a fresh `work`
  instead of a `revise` to dodge chain strikes (V4 q6).
- **Embedding novelty is absent everywhere.** Shinka's ablation credits it with most of its
  dedupe gain (`external.md` §2); none of the designs has an embedding service.
- **Width: every design now has a "Scaling example", and the same ❌s remain in all four.**
  Rule 5 (no added agents above ~45% single-agent success) and rule 7 (narrow when tokens per
  verified result stop improving) have no host mechanism anywhere. Two designs contradict rule 5:
  V3's §5 table and V4's formula both widen in the 0.45–0.5 band. No design hedges or reassigns
  a straggler; a 29-minute M4 run holds `gpu-local` alone. In every design the ceiling is host-set
  but the actual width is LLM judgment, and the only verifier-derived cap (V4's W) covers samples,
  not distinct `work` nodes. Sharing is right in all four: one deduplicated store, no peer
  messages. §4.4 adds rules 5 and 7 to slice 3.
- **Statistics live in the target repo**, as all four agree (`compare.py`). That is lean, but no
  design checks that a repo's statistical script is itself correct. Tidewar's one-sample bug (48
  seeds behaving as one) was exactly a broken instrument.
- **Owner latency dominates cases 1 and 9 in every design.** Parking, `judging` and owner pools
  make waiting free, not fast. Only V4 bounds the number of owner asks (`budget.ownerAsks`).
- **Token economics are unmeasured in all four.** No design records per-job tokens today, and the
  token-audit tool exists but none of them uses it as a gate.

### 5.2 What was not checked

- **No `quint verify` (Apalache).** No JVM on this machine, so no result in this folder is a proof.
  Liveness appears only as bounded-response safety.
- **The models check the models, not code.** V1's ITF trace-replay test (traces drive the real
  scheduler) is the right link, and no design has built it.
- **V3's and V4's mutants are saved as diffs** in `docs/specs/mutants/` (not yet committed), with
  apply-and-run steps in its README. The V4 diffs were cut from an earlier model revision and carry
  about 48 lines of drift (two later `quint test`s missing). This review did not re-run every diff.
- **V4's per-invariant runs** for I4–I22 were stopped at 3,000 samples under machine load; they
  rest on the 3,000-sample `safety` conjunction and 300-sample individual runs. Four witnesses
  were reached only by directed tests.
- **V2's A27** (the eval guarded by the declared family, the relabel) is unconfirmed at the
  repo's model bounds and violated only in a looser 4-eval variant that is not committed.
- **Not modelled anywhere:** lanes and rollover, anchors, sealed or blind trees, fences, the
  allocator's ordering, population parent policy, digests and pins, grants and spawn trees,
  ssh/Modal re-attach, separate token and $ meters, the quality of any LLM judgment (always
  nondeterministic).
- **This review re-ran** typecheck on all four models and one `safety` run plus one ablation,
  witness or test battery per model (§2.3). It did not re-run every witness, ablation or mutant.
