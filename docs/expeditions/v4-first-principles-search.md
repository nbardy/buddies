# Expeditions V4: budgeted search over a frozen gauge

Status: **design, revision 2, 2026-11-09. Not built.** Revision 2 answers an independent critique
(§11). The lens is progress per token. Quint model: `docs/specs/expedition-v4.qnt` (typechecked,
13 directed tests, simulated, mutant-checked; see §9). Inputs: `docs/expeditions/research/{use-cases,prior-art,external}.md`.
Conventions: `docs/design-specs.md`.

**Lineage, stated plainly.** V4 is the leader/round design (`v1-leader-rounds.md`) with three
things removed: Round, Meta-plan and Objective. The Steward is v1's Leader, a wake batch is v1's
round inbox, a Gauge is v1's Evaluator/Gate, and the Notebook with its Families is v1's Finding
index. Pools and Nodes match v1/v3. Rounds were removed because they put a barrier where none is
needed: a child can start the moment its parents settle. The meta-plan was removed because the plan
*is* the frontier of planned nodes, and it can be patched at any time. The Objective was removed
because the charter's `Target` already says what done means. The one new mechanism is `allocate()`:
its width cap, its strike rule and its pool-time cost. That is where the critique found the most,
and it is what §3.1 and the model now specify.

---

## 1. Thesis

An expedition spends a budget of tokens, machine time and owner attention to move one measured
blocker. What limits progress differs by case:
- the verifier's quality and latency (cases 2, 3, 4, 8);
- the diversity of ideas and repeated dead ideas (3, 4);
- context bloat (1, 3);
- coordination and integration (6, 7);
- owner latency (1, 9).

None of these is "the plan was wrong". So V4 is not a planner with steps. It is a **search over a
frontier of work nodes, scored by a frozen, hashed gauge, with a shared notebook of idea
families.** A host function, `allocate()`, sends compute to the family with the highest measured
gain per unit of its scarcest resource.

Width is a property of **one claim**, not of a family. A node is one of three attempts:
- `work`, a distinct item with its own claim;
- `sample`, another independent try at an existing claim;
- `revise`, a new claim that answers a refuted one.

The width rule caps how many tries of one claim run at once:
`w = clamp(ceil(ln(1−q)/ln(1−p̂)), 1, W[verifier])`, with W = 16 for a machine gauge, 4 for model
review and 1 for the owner. Strikes count along revise chains, never across parallel samples or
distinct work. With that, the same loop gives:
- **Routine work** (cases 6, 7, and case 1's collection). Distinct `work` items, each run once on a
  cheap seat. The width rule never applies, so success does not narrow the fan-out and failures never
  cancel siblings.
- **Frontier work** (cases 3, 4, 8). The first try of a claim runs alone. Unexplained refutations
  widen the next try to 4, 8, 11 and then 16 samples. A diagnosed refutation goes one level deeper
  instead (`revise`). A family is exhausted when a revise chain reaches `strikes` refuted groups.
- **Weak verifier** (cases 1, 9). The width stays at 4 or 1, because best-of-N is worth no more than
  its verifier.

None of this needs a mode flag.

The LLM writes ideas, work and judgments in prose. Everything that decides where compute goes is
host code over typed records:
- allocation and width;
- reservations for every LLM turn and every remote run;
- pool caps;
- strikes and exhaustion;
- gauge freezing and hash checks;
- landing;
- finishing.

## 2. Concepts (7)

| # | Noun | One line |
|---|---|---|
| 1 | **Expedition** | The record: goal, owner pins, budget, deadline, target gauge and repo. One JSON file. |
| 2 | **Gauge** | A frozen, hashed verifier made of ordered stages (cheapest first): `command`, `metric`, `review` or `owner`. Changing a gauge creates a new gauge. |
| 3 | **Pool** | A named compute class with a concurrency cap and a quota: seats (every LLM turn), local GPU = 1, compile lock = 1, Modal N with a $ ceiling, "exactly one replay". |
| 4 | **Node** | One bounded unit of work: an attempt kind, typed parent edges, a family, a seat, an access rule, a gauge and a cap. It produces one immutable commit plus a schema report. Its phase only moves forward. |
| 5 | **Family** | An idea lineage (a mechanism plus a representation). It is the unit of dedupe, of exhaustion, and of the allocator's statistics. |
| 6 | **Notebook** | The families plus one bounded digest (at most 6k tokens), versioned. It is the only shared memory, and it is what every brief carries. |
| 7 | **Steward** | The one LLM seat that proposes nodes and families and rewrites the digest. It wakes only on typed wake reasons, holds a seat and a reservation like any turn, and never allocates compute. |

Plus one host function, `allocate()`. It is not a noun. Artifacts are refs (a sha plus paths), not
a concept. Attempt kinds, parent edges and claim groups are variants and fields of Node, not new
concepts.

There is no Round, Phase, Plan, Task queue, Duel, Map or Reduce. These shapes are all patterns of
nodes and parents:
- a map is many `work` siblings;
- a reduce is a node with `reads` edges to many parents;
- best-of-N is a head plus `sample`s;
- a debug loop is a `revise` chain;
- a duel is an attack node and a defense node judged by a review stage on a third provider;
- a phase is a `needs` edge.

---

## 3. Types, Goals, Invariants, Acts, Events, Open questions

### 3.1 Types

These are written as they would become Zod in `shared/src/expedition.ts` (one type source). There
are no optional fields: absence is a named variant.

```ts
// ---- the record -------------------------------------------------------------------------
type Expedition = {
  id: ExpeditionId;
  charter: Charter;           // owner-written; changed only by owner acts
  gauges: Gauge[];            // append-only; each frozen at creation
  pools: Pool[];
  nodes: Node[];              // append-only; phase forward-only
  notebook: Notebook;         // steward-written, host-validated, versioned
  steward: StewardState;
  meter: Meter;               // spent + reserved, per currency and per pool
  status: ExpeditionStatus;
};

type Charter = {
  goal: string;                       // prose
  target: Target;                     // what "done" means, machine-readable
  pins: Pin[];                        // owner rules, verbatim in every brief, never weakened by the steward
  budget: Budget;
  deadline: IsoTime;                  // bounds work, not judgment
  repo: { path: string; baseSha: string; branch: string };   // branch = expedition/<id>
  seats: SeatTier[];                  // e.g. cheap: claude:sonnet, strong: claude:opus, alt: codex:gpt-5 high
  seed: NodeSpec[];                   // initial frontier: a whole plan (case 7) or one instrument node (case 2)
  strikes: number;                    // refuted groups along ONE revise chain that exhaust a family (default 2)
};
type SeatTier = { id: SeatId; provider: ProviderId; model: string; effort: string };

type Target =
  | { t: 'gauge'; gauge: GaugeId; level: ClaimLevel }  // done when a LANDED node keeps on this gauge at this level
  | { t: 'rows'; gauges: GaugeId[]; level: ClaimLevel } // requirement matrix: done when every row's gauge keeps (cases 5, 9)
  | { t: 'owner' };                                     // owner declares done (case 1)
  // Only nodes on a target gauge can meet the Target. A keep on any other gauge is labelled
  // "exploratory" in the finish report. Only the owner changes the Target (`supersede`).

type Budget = { tokens: number; usd: number; ownerAsks: number }; // ownerAsks bounds owner-stage nodes

type Pin = { id: string; text: string; at: IsoTime };    // e.g. "flagship shielded until all Inner towers sunk"

// ---- gauges -------------------------------------------------------------------------------
type Gauge = {
  id: GaugeId;
  hash: Sha256;                // over stages' argv, oracle file digests and rubric bytes, computed at freeze
  stages: Stage[];             // run in order; the first failing stage refutes; cheapest first
  supersedes: GaugeRef;        // owner weakening/strengthening makes a new gauge
};
type GaugeRef = { t: 'none' } | { t: 'gauge'; id: GaugeId };

type Stage =
  | { t: 'command'; argv: Argv; oracle: RepoPath[]; pool: PoolId; timeoutS: number }
      // exit 0 passes. Runs in a fresh detached checkout of the node's sha with the oracle restored
      // from baseSha (today's checks.ts).
  | { t: 'metric'; argv: Argv; oracle: RepoPath[]; pool: PoolId; timeoutS: number; read: MetricRead }
      // The command writes a JSON report; the host reads named numbers. Statistics (paired seeds,
      // sign tests, censoring) live in the REPO's script (e.g. rr/reports/tidewar-balance/compare.py),
      // which emits { pass, values, perInput, diagnosis, costUsd }. The host does no statistics.
  | { t: 'review'; rubric: string; seat: SeatId; independence: Independence; access: Access }
      // An LLM judge turn: it holds a seat and a reservation like any turn. Schema output
      // { pass, grade, diagnosis, family }.
  | { t: 'owner'; ask: string };
      // Parks the node in `awaiting`. Holds no seat, pool slot or reservation.
type Independence =
  | { t: 'provider' }          // judge seat's provider ≠ producer's provider: confers `independent`
  | { t: 'seat' };             // judge seat ≠ producer seat only: a check, confers nothing

type MetricRead = {
  pass: { key: string; op: '<=' | '>='; value: number }[];        // frozen thresholds
  progress: { key: string; better: 'lower' | 'higher'; noise: number; goal: number };
      // gain = share of the remaining gap closed: (parentBest − value) / (parentBest − goal),
      // clamped to [0, 1], 0 inside noise. Comparable across keys and families (case 5 rows).
  audit: Audit;                // a host rule, not a pin
};
type Audit =
  | { t: 'none' }
  | { t: 'review_above'; speedup: number; rubric: string };
      // When the read shows a speedup above `speedup` (e.g. 10x), the host appends a review stage
      // with independence `provider` before the verdict. Part of the frozen gauge and its hash.

// ---- compute ------------------------------------------------------------------------------
type Pool = { id: PoolId; cap: number; quota: Quota; where: Where };
type Quota =
  | { t: 'unlimited' }
  | { t: 'count'; total: number }        // "exactly one replay" = { count, 1 }
  | { t: 'usd'; ceiling: number };       // Modal; each run reserves its estimate and settles its actual cost
type Where =
  | { t: 'seats' }                       // every LLM turn: node, review stage, steward
  | { t: 'host' }                        // local process; cap 1 for local GPU, compile lock, idle-host timing
  | { t: 'remote'; runner: Argv };       // repo-owned launcher (e.g. wave_sim tools/modal_run_v1); scale-to-zero

// ---- work ---------------------------------------------------------------------------------
type Node = {
  id: NodeId;
  spec: NodeSpec;
  phase: NodePhase;
};
type NodeSpec = {
  attempt: Attempt;
  parents: Edge[];            // [] = baseSha
  family: FamilyRef;
  role: string;               // prose: "collect org X", "attack thesis v2", "implement Orders API"
  claim: { hypothesis: string; prediction: string; differsFrom: string }; // frozen before running
  seat: SeatId;
  access: Access;
  gauge: GaugeId;             // pinned version + its hash; never re-pointed
  cap: { tokens: number; wallS: number; probe: Probe };
};
type Attempt =
  | { t: 'work' }                    // a distinct item: own claim; one group of its own
  | { t: 'sample'; of: NodeId }      // another try at `of`'s claim: same parents, claim, gauge; width-capped
  | { t: 'revise'; of: NodeId };     // a new claim answering `of`'s struck group: chain depth + 1
type Edge =
  | { t: 'needs'; node: NodeId }     // must be KEPT; its commit is merged into the node's tree
  | { t: 'reads'; node: NodeId };    // must be SETTLED (any verdict); its report is passed as a ref
type FamilyRef =
  | { t: 'family'; id: FamilyId }
  | { t: 'discover' };               // blind discovery: resolved by the report or the dedupe stage
type Probe =
  | { t: 'none' }
  | { t: 'stage'; stage: number; count: number; usdEach: number };
      // inner-loop calls to ONE named stage, in that stage's pool; count × usdEach is reserved at start
type Access =
  | { t: 'full'; writes: Glob[] }                                  // writes = file fence, checked at produce
  | { t: 'blind'; reads: RepoPath[]; notebook: NotebookView; writes: Glob[] }; // sparse tree (❌ build)
type NotebookView = { t: 'none' } | { t: 'families_only' } | { t: 'full' };

type Reservation = { tokens: number; usd: number; poolCounts: Record<PoolId, number> };
type NodePhase =
  | { t: 'planned'; at: IsoTime }
  | { t: 'running'; run: RunId; tree: TreeRef; reserved: Reservation; startedAt: IsoTime }
  | { t: 'produced'; artifact: Artifact; spent: Usage }
  | { t: 'reviewing'; artifact: Artifact; stage: number; run: RunId; reserved: Reservation; spent: Usage }
  | { t: 'measuring'; artifact: Artifact; stage: number; reserved: Reservation; spent: Usage }
  | { t: 'awaiting'; artifact: Artifact; spent: Usage }                 // owner stage: holds nothing
  | { t: 'kept'; artifact: Artifact; score: Score; level: ClaimLevel; spent: Usage }
  | { t: 'refuted'; artifact: Artifact; stage: number; diagnosis: Diagnosis; spent: Usage }
  | { t: 'interrupted'; reason: InterruptReason; spent: Usage }          // no artifact; never judged
  | { t: 'expired'; artifact: Artifact; why: ExpireReason; spent: Usage } // artifact exists; never judged
  | { t: 'cancelled'; reason: CancelReason };
type Diagnosis = { t: 'none' } | { t: 'diagnosed'; text: string };
type InterruptReason = 'error' | 'timeout' | 'cap' | 'no_report' | 'fence' | 'owner_stop' | 'restart';
type ExpireReason = 'gauge_drift' | 'unfundable' | 'owner_stop' | 'target_met';
type CancelReason = 'steward' | 'family_exhausted' | 'parent_dead' | 'finish' | 'owner';

type Artifact = { sha: string; report: NodeReport };      // the commit always exists; docs are committed too
type NodeReport = {                                        // schema-forced via the `report` tool
  summary: string;                                         // <= 1,200 chars
  files: RepoPath[];                                       // where the evidence is (refs, never contents)
  claims: { text: string; tag: 'VERIFIED' | 'CLAIMED' | 'SPECULATION'; sources: string[] }[];
  family: FamilyClaim;                                     // resolves `discover`, or asks to re-assign
  ideas: IdeaProposal[];                                   // new idea seeds noticed while working
};
type FamilyClaim =
  | { t: 'as_planned' }
  | { t: 'member'; of: FamilyId }
  | { t: 'new'; idea: IdeaProposal };
type IdeaProposal = {
  name: string;
  mechanism: string;               // one sentence: why it would work
  representation: string;          // what is concretely different from every listed family
  differsFrom: FamilyId[];         // the closest families, named by the proposer
};
type Score =
  | { t: 'pass' }
  | { t: 'metric'; values: Record<string, number>; perInput: number[]; gain: number }
  | { t: 'review'; grade: number; diagnosis: string }
  | { t: 'owner'; note: string };
type ClaimLevel = 'measured' | 'independent' | 'accepted';
  // Computed by the host from the stages passed: machine stages = measured; plus a review with
  // independence `provider` = independent; plus an owner stage = accepted. Nobody else sets it.

// ---- knowledge ----------------------------------------------------------------------------
type Notebook = { version: number; families: Family[]; digest: string /* <= 6k tokens */ };
type Family = {
  id: FamilyId;
  name: string;
  representation: string;            // what would have to change to reopen it
  status: FamilyStatus;
  stats: { tries: number; kept: number; struck: number; cost: PoolCost; gain: number };
  best: { t: 'none' } | { t: 'node'; id: NodeId };
};
type PoolCost = Record<PoolId, number>;   // tokens, usd, pool-seconds, counts, per pool
type FamilyStatus =
  | { t: 'open' }
  | { t: 'exhausted'; by: 'strikes' | 'owner' | 'steward'; mechanism: string }
  | { t: 'adopted'; node: NodeId };   // its best was landed

// ---- steward ------------------------------------------------------------------------------
type StewardState =
  | { t: 'idle'; lastWake: IsoTime }
  | { t: 'awake'; run: RunId; reason: WakeReason; reserved: Reservation };
type WakeReason =
  | { t: 'frontier_low' }                       // ready nodes < free seats and no steward plan pending
  | { t: 'struck'; head: NodeId }               // a group struck and its family has no planned node
  | { t: 'batch'; settled: NodeId[] }           // K settled since the last wake (K = max(4, seat cap))
  | { t: 'owner'; post: PostId }
  | { t: 'budget'; crossed: 50 | 80 }
  | { t: 'deadline' };                          // fires at deadline − 15 min: closing digest, land proposals

type ExpeditionStatus =
  | { t: 'running' }
  | { t: 'paused'; by: 'owner' }
  | { t: 'judging'; cause: StopCause; since: IsoTime }   // work stopped; owner asks and target lands remain
  | { t: 'finished'; why: FinishReason; at: IsoTime };
type StopCause = 'deadline' | 'budget' | 'dry' | 'steward_nogo';
type FinishReason = 'target' | StopCause | 'owner_stop';
```

**Claim groups and strikes.** A *group* is a head (a `work` or `revise` node) plus its `sample`s.
- A group is **struck** when every member has settled, none is kept, and at least one is refuted.
  Interrupted and expired members never refute. Each group strikes at most once.
- The strike's **depth** is the head's revise depth. A `work` head has depth 1, and a `revise` of a
  struck head h has depth `depth(h) + 1`. Samples share their head's depth.
- A family is **exhausted by strikes** when a struck head has `depth ≥ charter.strikes`.

So parallel samples are one strike. Distinct `work` items never strike each other. Only a chain of
"tried, refuted, revised, refuted" exhausts a family. The steward can also exhaust a family with a
mechanism sentence, and the owner can `kill` one.

**The allocator** is a pure function `allocate(record) → Start[]`, run in every host step:

```
per family f:   tries_f = judged nodes in f (each sample counts)       p̂_f = (kept_f + 1) / (tries_f + 2)
                gain_f  = Σ gain of f's keeps   (metric: share of gap closed, §3.1 MetricRead;
                                                 command, review or owner keep = 1)
                cost_f  = Σ_pool  spent_f,pool / avail_pool          // fraction of each scarce pool used
                          avail = remaining quota (tokens, usd, count), or cap × time-to-deadline
                          for unlimited host pools (compile lock, gpu-local)
                value_f = gain_f / max(cost_f, ε)  +  c · sqrt(ln N / (tries_f + 1))   // UCB per scarce unit
per group G (head h, gauge strength s):
                w_G = clamp( ceil( ln(1−q) / ln(1−p̂_f) ), 1, W[s] ),   q = 0.8
                W: machine = 16, review = 4, owner = 1                 // best-of-N is worth its verifier
order ready:    by value_f desc; within f, deeper revise chains first, then fewest running in the
                group, then plan time
start while:    the node's seat pool has a free slot
                ∧ spent + reserved + cap ≤ budget, for tokens and usd (cap includes probe usd)
                ∧ running members of G < w_G
                ∧ every `needs` parent kept ∧ every `reads` parent settled
                ∧ family open ∧ target not yet met ∧ now < deadline
```

`w_G` only bounds `sample`s, because a head's group starts with only the head. `work` items are
not width-limited: their concurrency is the seat cap.

**Width as the family's tries refute** (machine gauge, no keeps; integer form `5·(n+1)^w ≤ (n+2)^w`):

| Family history | p̂ | w | What happens |
|---|---|---|---|
| fresh (0 tries) | 0.50 | 3 | A frontier steward may plan the head plus 2 samples up front |
| head refuted (1 try) | 0.33 | 4 | Unexplained: up to 4 samples of the same claim |
| head + 2 samples refuted (3) | 0.20 | 8 | |
| head + 4 samples refuted (5) | 0.14 | 11 | A `revise` at depth 2 (strikes = 2) is the last chance |
| 11 tries refuted | 0.077 | 16 (raw 21) | Reached only at strikes ≥ 3, or across several groups of one family |
| 4 of 4 kept | 0.83 | 1 | Routine: no samples needed |

With the default `strikes = 2`, one chain can reach width 8 to 11. A frontier case that wants 16
sets `strikes = 3`. Breadth across families is separate from that and is bounded by seats (§4.2).

The steward is told `w_G` and `p̂_f` for each family in its wake brief (the "effort table"). Two
cases:
- When the struck group's refutations carry a `diagnosed` diagnosis, the steward plans **depth**:
  one `revise` with the diagnosis in its brief.
- When they do not, it plans **width**: up to `w_G` samples of the same claim, on different seats
  and providers.

The cap is host-enforced (I18). The choice between depth and width is the steward's judgment.

### 3.2 Goals

| ID | Goal | By |
|---|---|---|
| G1 | Compute flows to the highest gain per unit of scarce resource | `allocate()` UCB over `gain_f / cost_f`, where cost is per-pool spend over what remains (`server/src/expeditions/allocate.ts` ❌ build) |
| G2 | Routine work costs about what a fixed plan costs | `charter.seed` carries the whole plan as `work` nodes. Width and strikes never apply to distinct work (test `distinctWorkNeverStrikesTest`). The steward wakes only on `struck` or `frontier_low`. Cheap seat tier by default. |
| G3 | Frontier work scales out when it pays | `w_G` grows 3 → 4 → 8 → 11 → 16 as tries refute (§3.1 table; test `widthGrowsAfterRefutationTest`). Parallel samples cost one strike (`parallelSamplesOneStrikeTest`). Ceiling: local seats (§4.2). |
| G4 | Width never exceeds what the verifier can certify | `W[review] = 4`, `W[owner] = 1` clamp in `allocate()`. Quint `widthClamped` (I18), `widthCapRefusesTest` |
| G5 | No idea is re-tested without a changed representation | The `plan` act refuses nodes in exhausted families (I7). A new family whose normalized `name+representation` equals an exhausted one is refused (write-path assertion). The dedupe review stage re-assigns post hoc (§4.4). ❌ embedding gate (optional) |
| G6 | The verifier cannot be gamed by the work | Gauge `hash` re-checked before each stage and at the verdict. Drift expires the node (I5). Stages run in a fresh detached checkout with the oracle restored from base (`server/src/expeditions/checks.ts`). `Audit.review_above` is a gauge rule, not a pin. Steward-frozen gauges cannot meet the Target. |
| G7 | Owner gates hold no capacity, and the deadline never skips judgment | `awaiting` holds nothing (I2). Work stops at the deadline. With asks open, the status becomes `judging`, where owner verdicts and target lands still run (I19, test `lateOwnerKeepLandsTest`) |
| G8 | No malformed answers, no text signals | The node ends by calling the `report` tool, zod-validated. A missing report is `interrupted{no_report}` and is never judged (I4). |
| G9 | Briefs stay small and cacheable | A three-layer brief (§4.4), the 6k-token digest cap enforced at the `notebook` act, and reports passed as refs |
| G10 | No LLM turn or remote run is ever unfunded | Every LLM turn (node, review stage, steward) reserves through the seats pool, and remote stages reserve usd (I1, I2). ❌ The live usage stream plus a mid-turn cap kill (build step 1). Until then I1 is unguarded in code. |
| G11 | Claims are honest | `ClaimLevel` is computed by the host. `independent` requires a review with `independence: provider` (I6). The finish report quotes levels and labels non-target keeps "exploratory". |
| G12 | The owner steers mid-run without double effects | Bare owner commands are consumed by the host (`host_command`, as in today's `host.ts`). Free text wakes the steward. `steer` uses harness steering per capability (`server/src/buddies/harness-steering.ts`). |
| G13 | Parallel results stack or are rejected | `land` is serial (I10). After each land the host re-measures the target gauge on the expedition branch head, and reverts the land if it regressed. |
| G14 | A restart loses no paid work | ❌ Adopt expedition node runs through execution journals. Today crew turns are discarded (`server/src/lifecycle/shutdown.ts:110`, `ports.discardCrewTurns()`). The model takes the pessimistic case: every in-flight reservation is charged and remote runs are paid again (Quint `crash`). |
| G15 | Lean: one model replaces the retry loop | About 2,800 lines for server plus shared (§8), deleting `fill`, `startAttempt` and the Lesson line. ❌ Retiring the oompa viewer is a later owner decision. |

### 3.3 Invariants

| ID | Invariant | Guard |
|---|---|---|
| I1 | `spent + reserved ≤ budget` for tokens and usd (and each pool quota), counting every LLM turn and every remote run, through parallel starts and a crash | Quint `budgetHolds`, test `reservationRefusesOvershootTest`. **❌ Unguarded in code** until the live usage stream and cap kill exist (build step 1). A mutant whose turn can overrun its cap violates it (§9 V6). ❌ `server/test/expedition-v4-budget.test.ts` |
| I2 | Reservations are held exactly by running turns (node, review stage, steward) and in-flight remote stage runs. Awaiting nodes hold none. | Quint `reservedIsHeld`. Write-path assertion in `commit()` |
| I3 | Seat turns (nodes + review stages + steward) ≤ seat cap, and per-pool runs ≤ cap | Quint `poolCaps`. ❌ stage-runner test with two pools |
| I4 | Only produced artifacts are judged. Interrupted, cancelled and no-report turns never get a verdict | Quint `judgedOnlyProduced` |
| I5 | Every verdict saw the gauge hash pinned at plan, even when a gauge drifts | Quint `gaugeFrozen` with the environment action `drift`. Assertion: the hash is recomputed before each stage and at the verdict, and a mismatch expires the node. Mutant without the check violates it (§9 V6). |
| I6 | A review stage that confers `independent` runs on another provider than the producer | Quint `judgeIndependent` (the model checks provider for every review). Assertion in the `plan` act |
| I7 | No planned node belongs to an exhausted family | Quint `noPlannedInExhausted`. Tests `exhaustCancelsPlannedSiblingTest`, witness `w_noExhaustCancel` |
| I8 | A verdict is written once and never changes | Quint `verdictStable`: the phase must agree with an append-only verdict log written only by `settle()`. A Kept→Refuted flip mutant violates it (§9 V6). |
| I9 | No work starts at or after the deadline. Judgment continues. | Quint `deadlineBoundsWork` (single-guard tripwire on `startN`) |
| I10 | Landing is serial and lands only kept nodes | Quint `landSerialKept` |
| I11 | `finished` holds and awaits nothing. `judging` holds nothing and starts nothing | Quint `finishedIsQuiet` |
| I12 | A node runs only with every `needs` parent kept and every `reads` parent settled | Quint `runsOnSettledParents`, test `reduceOverDeadReadTest` |
| I13 | No planned node waits on a dead `needs` parent: pruning runs in the same write. `reads` never prune. | Quint `noOrphanPlans`, test `refutedParentPrunesChainTest` |
| I14 | A produced commit touches only `access.writes` | ❌ host fence check at `produce`, before any stage: `git diff --name-only parent..sha`. A violation is `interrupted{fence}` |
| I15 | A blind node cannot read outside `reads` | ❌ sparse Cambium tree containing only `reads`, with the notebook view rendered into the brief. Until then, blind is advisory and labelled so in the UI |
| I16 | Every kept artifact's evidence is reachable from a commit on `expedition/<id>` or a harvest ref | `report.files` must be in the commit. ❌ assertion at `produce` |
| I17 | The steward never moves `main`. Only the owner `adopt` act does. | `ALLOWED` act table (`shared/src/expedition.ts`) |
| I18 | Concurrent tries of one claim never exceed `W[verifier]` | Quint `widthClamped`, tests `widthCapRefusesTest` and `widthGrowsAfterRefutationTest`. Mutant without the width guard fails the test (§9 V6). |
| I19 | A kept target node is landed before the expedition finishes (unless the owner stops it) | Quint `noStrandedKeep`, test `lateOwnerKeepLandsTest` |
| I20 | Every finish has a reason whose condition held. `running` has none. | Quint `finishHasReason`, plus one witness per reason |
| I21 | Statistics and strikes land on a resolved family | Quint `resolvedBeforeVerdict`, test `discoveryResolvesFamilyTest` |
| I22 | Exhaustion by strikes comes only from a revise chain of depth ≥ `strikes` | Quint `exhaustOnlyByChain`, tests `parallelSamplesOneStrikeTest` and `distinctWorkNeverStrikesTest` |

### 3.4 Acts

| Act | Who | Requires | Otherwise |
|---|---|---|---|
| `launch` | owner | Charter parses. Every `command`/`metric` stage passes the preflight `ranOrNot` on baseSha (`checks.ts:282`, extended to every gauge in the seed). Review stages with `independence: provider` name a seat on another provider than some producer tier | Refused, with the stage that cannot run |
| `plan(spec)` | steward, or owner | Status `running`, before the deadline. Family open (or `discover`, only for `work`). Gauge exists. `sample`: `of` is a head in the same family, with identical parents, claim and gauge. `revise`: `of` is a struck head of the same family. Review seat check per `independence`. No `needs` parent dead. `onTarget` only if the gauge is the Target's | Refused with a typed reason, shown in the steward's tool result |
| `cancel(node)` | steward, or owner | Node `planned` | No-op refusal |
| `family(new)` | steward | Normalized `name+representation` does not equal an exhausted family's | Refused with the matching graveyard row |
| `exhaust(family, mechanism)` | steward, or owner (`kill F`) | Family open | Refused |
| `reopen(family)` | owner only. Also automatic when a keep lands in a family exhausted **by strikes** | Family exhausted | Refused. The steward must propose a new family with a new representation |
| `notebook(patch)` | steward | Digest ≤ 6k tokens. The version bumps by 1 | Refused, with the size |
| `freeze(gauge)` | steward proposes, host freezes | New id. Preflight passes on baseSha. The new gauge is never the Target | Refused |
| `supersede(gauge)` (weaken, change, or re-point Target) | owner only | New gauge. Applies to nodes planned afterwards | Refused for the steward (lowering a bar after seeing results, use-cases §10.5) |
| `start(node)` | host (`allocate`) | I1, I3, I12, family open, the width cap, target not met, before the deadline | Stays planned |
| `probe(node)` | node, during its turn | `probe.count` left. Runs `probe.stage` of the gauge on the tree's current HEAD in **that stage's pool**, against the usd already reserved at start | Tool error "probe budget spent" or "pool busy, retry after N s" (never blocks the turn) |
| `report(node)` | node, during its turn | Schema valid. Commit exists. Fence holds. `family` resolves | One steer to retry (claude `any-tool`), else `interrupted{no_report}` |
| `review(node, stage)` | host | Produced. A seat is free and `RCOST` fits the budget | Waits. `expired{unfundable}` if the budget can never fund it |
| `measure(node, stage)` | host | Produced or measuring. A pool slot is free and its quota fits | Waits. `expired{unfundable}` if the quota can never fund it |
| `verdict(node, keep)` | owner | Node `awaiting`. Works after the deadline, in `judging` | Refused |
| `land(node)` | steward proposes. Host performs it, and does so on its own for target keeps in `judging` | Node kept. No land in flight. Merge into `expedition/<id>` (merge, never rebase). Then the target gauge is re-run on the head | A conflict plans a resolve node: `work` in the landed node's family, `needs` [node], built on the head. A regression reverts the merge and records it in the notebook |
| `adopt` | owner only | A kept node is landed on the expedition branch | Moving `main` is never done by the steward |
| `steer(node, text)` | owner, or steward | Node running. Delivery per harness (`any-tool` mid-turn; `buddy-tool-only` at the next Buddy tool call). The result names which | The text waits visibly |
| `pin` / `unpin`, `fund`, `extend`, `pause` / `resume` | owner only (bare chat commands consumed by the host) | — | — |
| `stop-work(cause)` | host (`deadline`, `budget`, `dry`), or steward (`nogo`, with written rationale) | Quiet: nothing running, reviewing, measuring or produced, steward idle, no land in flight. The cause's condition holds | Waits for quiet |
| `finish(target)` | host | Target met on a landed node, and quiet | — |
| `close-judging` | host | `judging`. No `awaiting` node. No kept target node unlanded (or the target is met) | Stays `judging` |
| `stop` | owner only | — | Running → `interrupted{owner_stop}`; produced, reviewing, measuring or awaiting → `expired{owner_stop}`; planned → `cancelled`. All reservations are charged |
| `crash` / `adopt-run` | host | Journal exists | Pessimistic: `interrupted{restart}`, with its whole reservation charged, and review or remote runs restarted and paid again |

### 3.5 Events (append-only, in the record's `events[]`, each with an idempotency key `exp:<id>:<kind>:<node>`)

| Event | When | Wakes |
|---|---|---|
| `node.planned` / `node.cancelled` | `plan`, `cancel`, exhaustion, pruning | nobody |
| `node.started` | `allocate` | nobody |
| `node.probe` | each probe (stage, pool, cost, result) | nobody |
| `node.produced` / `node.interrupted` | turn settles | nobody |
| `node.family_resolved` | report or dedupe stage resolves or re-assigns the family | nobody |
| `stage.passed` / `stage.failed` | per stage | nobody |
| `node.kept` / `node.refuted` / `node.expired` | verdict, or a stage that cannot run | steward (`batch`) |
| `group.struck` | a claim group settles with no keep | steward (`struck`, if its family has no planned node) |
| `family.exhausted` / `family.reopened` | strikes chain, owner or steward / a keep after strikes, or owner | steward via the next batch |
| `gauge.frozen` / `gauge.superseded` / `gauge.drift` | `freeze`, `supersede`, hash mismatch | `gauge.drift` posts to the owner |
| `land.done` / `land.conflict` / `land.reverted` | `land` | steward |
| `owner.ask` | node enters `awaiting` | owner inbox, batched (§4.5) |
| `owner.command` | bare command consumed | nobody (`host_command`) |
| `budget.threshold` | 50% or 80% crossed | steward |
| `expedition.judging` / `expedition.finished` | stop-work with asks open / finish | owner |

### 3.6 Open questions

1. **Warm forks.** Can a node start from a forked warm session (prefix already cached) on each
   harness? This is the biggest lever for wide maps (prior-art §7: 20–33k cold-seat cost). ❌ probe
   claude `--fork-session` and codex.
2. **Blind sparse trees.** How do we give blind nodes a sparse Cambium checkout without breaking
   build commands that need the whole repo? Is "blind" read-only research only?
3. **SSH machines.** Is an SSH host a `remote` pool whose runner is `ssh host -- <argv>`, or do we
   wait until a fleet exists? (No fleet is documented today, use-cases §3.)
4. **Allocator constants.** What should `c` (exploration) and `q` (target success probability) be:
   fixed per expedition or per family? The defaults are 0.5 and 0.8, unmeasured.
5. **Gain as share of gap.** Is "share of the remaining gap to the goal, clamped" the right
   comparable gain? It needs every metric's `goal` stated at freeze. A metric with no goal (pure
   exploration) contributes only the exploration term.
6. **Relabel trick.** Chain strikes let a steward dodge exhaustion by planning a fresh `work` for a
   re-worded idea instead of a `revise`. The guards are the dedupe stage and the family-key refusal.
   Is that enough, or should a family exhaust when it has `2·strikes` struck groups and no keep?
7. **Judging without end.** `judging` holds nothing, so waiting costs nothing, but it can last for
   ever. Should asks expire after N days into `expired{ask_expired}`?
8. **Remote agent seats.** LLM nodes run locally, so frontier breadth tops out at the local seat
   cap (§4.2). Should case 4 get remote agent seats, or an in-node evolve tool (OpenEvolve, Shinka)
   that counts as one node with a large probe budget?
9. **Single-provider charters.** With one provider, `independent` is unreachable. Should the charter
   then reject a Target level of `independent` at launch? (Proposed: yes.)

---

## 4. How work flows

### 4.1 The host step (deterministic, serialized per expedition, as today)

`host.ts` keeps `serialized()` and `commit()` (the one write path). Each step:
1. **Fold.** Settled runs become `produced` or `interrupted`. Stage results become `reviewing`,
   `measuring`, `kept`, `refuted`, `expired` or `awaiting`. Every verdict goes through one
   `settle()`, which re-checks the gauge hash and appends to the verdict log. Then the fold runs the
   **rules to a fixpoint**, all in one write:
   - prune planned descendants of dead `needs` parents (I13);
   - mark newly struck groups;
   - exhaust each family whose struck head reaches `depth ≥ strikes`, and cancel its planned nodes
     (I7);
   - reopen a strikes-exhausted family that got a keep;
   - update family stats.
2. **Judge.** For each `produced` node, start its next stage when the stage's pool has a free slot
   and quota fits. A review stage takes a seat and reserves its turn. Cheap stages run first, so a
   broken candidate never reaches the H100. This also runs past the deadline and in `judging`.
3. **Wake.** If a `WakeReason` holds, the steward is idle, a seat is free and its reservation fits,
   start one steward turn. Wake reasons are batched, and a fingerprint of the frontier suppresses a
   wake on an unchanged state (oompa queue-audit).
4. **Allocate.** `allocate()` returns starts. For each start:
   - reserve tokens, probe usd and pool counts;
   - create a Cambium tree from the merged `needs` parents' commits;
   - brief the node, passing `reads` parents' reports as refs;
   - run it (a Buddy run with an execution journal and a live usage stream; a turn that reaches
     `cap.tokens` is killed as `interrupted{cap}`, ❌ build step 1).
5. **Finish check** (§4.6).

There is no tick that wakes an LLM. The steward costs tokens only when something changed that the
host cannot decide.

### 4.2 Parallel and remote compute

Each `Stage` names a `Pool`, and each pool is an independent queue:
- `seats`, for example 6. Every LLM turn uses this pool: node turns, review stages and the steward.
- `gpu-local`, cap 1 (wave_sim's one-GPU-runner rule);
- `compile`, cap 1, wrapping `rr/keel/scripts/lib/build_gate.sh`;
- `modal-l4`, cap 8 with `usd: 40`;
- `replay`, count 1 (case 8).

This replaces today's one host-wide check queue (lean design §11), which would serialize 48-seed
runs and Modal populations for no reason.

Remote pools run a repo-owned runner argv. The host:
1. reserves the stage's estimated cost (the last run's actual cost, or the charter default);
2. runs the runner, which streams a JSON report including `costUsd`;
3. settles the actual cost.

A crash loses the run's result but not its bill. So the host charges the reservation, and the
restarted measurement reserves again. Scale-to-zero is the runner's job (user `CLAUDE.md`). The host
never deploys GPUs.

LLM nodes always run locally as Buddy runs. Remote machines run evaluations, not agents. That keeps
the agent runtime single-host and adoptable. **It also sets the frontier ceiling.** Concurrent tries
across all families are capped by the local seat pool, about 6 on this machine (case 2's host already
sits at load 60–200). So a `w_G` of 16 means 16 tries in sequence waves of at most 6, not 16 at once.
Raising that needs remote agent seats (open question 8).

Each node can also run an **inner loop** through `probe`. The node's `cap.probe` names one stage
index. Each probe runs that stage on the tree's current HEAD **in that stage's pool**, and its usd
is reserved at node start, as part of the node's `Reservation`. If the pool is busy, the probe
returns "retry after N s" and does not block the turn. The host commits nothing. This is Karpathy's
keep-or-reset loop inside one warm context. It costs far fewer tokens than one node per experiment
(about 3% of autoresearch experiments are kept, external §3). The final verdict still re-runs every
stage on the produced sha in a clean checkout, so the inner loop cannot certify itself.

### 4.3 Scaling test-time compute up and down

There is no mode flag. Scaling comes from host rules and one steward judgment.

| Signal | Effect |
|---|---|
| Distinct items, any p̂ (routine maps, collections) | `work` nodes, one try each. Concurrency = seat cap. A failure is one group's strike at depth 1, which never exhausts a family by itself and never cancels a sibling. |
| A head refuted without a diagnosis | The steward may plan up to `w_G` samples of the same claim (4 after one try, 8 after three, §3.1 table). They span seat tiers and providers. The whole fan-out counts as one strike. |
| A refutation with a diagnosis | The steward plans depth: one `revise` carrying the diagnosis. This is the serial debug loop of cases 5 and 8. |
| A struck head at `depth ≥ strikes` | The family is exhausted. Its planned nodes are cancelled, and a graveyard row with the steward's mechanism sentence is written. Its **running** tries finish, because they are paid for. A keep among them reopens the family (`family.reopened`), since the keep refutes the evidence. Owner and steward exhaustion are decisions, and a late keep does not reopen them: it is recorded and the steward is told. |
| Every family exhausted | `frontier_low` wake. The steward must propose a new representation or `nogo`. |

The old "posterior" exhaustion rule (90% upper bound of p̂ < 0.05) was deleted: with a Beta(1, n+1)
posterior it only fires at n ≥ 44, after strikes or the steward have acted.

Budget pressure is visible too. At 80% the steward brief says so, and `allocate()` stops starting
nodes whose cap exceeds what remains.

### 4.4 Knowledge: briefs, notebook, repo owners

Every node brief has three layers, in byte-stable order so prompt caching works (external §7).

| Layer | Content | Changes when | Cache |
|---|---|---|---|
| L1 charter | Goal, pins verbatim, target, gauge contract (stages, thresholds), role card for the node's role kind | owner act | Shared only by turns on the **same provider and model** that start within the cache TTL (5 min; 1 h where the provider offers it) |
| L2 notebook vN | Digest (≤ 6k tokens) plus the family table (name, status, best gain, mechanism) filtered by `access.notebook` | steward wake (batched) | stable across a batch of siblings on one seat tier |
| L3 delta | The node's role, claim, attempt kind, `reads`/`needs` parents' reports (summary + file refs, ≤ 1.2k chars each), the group's and chain's diagnoses | per node | fresh |

There is no per-attempt history paste. A node opens parents' files on demand. The steward's wake
brief is L1 + L2 + the settled reports since its last wake + the allocator's effort table.

**Dedupe** happens at three points:
1. the exact family-key refusal at `plan`;
2. the steward reading the graveyard in L2;
3. for frontier gauges, a `review` stage 0 asked "is this a member of an exhausted family?", with
   the graveyard as rubric input. Its schema output includes `family`. A node it re-assigns to an
   exhausted family X is refuted **as a member of X**. The refutation counts in X's stats, so X's
   graveyard row shows the re-test. It strikes nothing, because X is already exhausted. Blind
   discovery nodes plan with `family: discover`, and the report or this stage resolves the family
   before any statistic or strike is written (I21). That resolves the use-cases §11 question 1
   tension.

**Repo owners.** At finish, or on the owner's `publish`, the steward plans one `publish` node:
- `access.writes` = the repo's knowledge files (for example `wave_sim/KEY_LEARNINGS.md`, the
  Tidewar progression log, the GTM source ledger);
- gauge: a `command` stage that checks only those paths changed, plus `owner`.

The notebook itself is never the system of record for the repo (use-cases §10.14).

### 4.5 Owner steering mid-run

The owner talks in the expedition chat.

**Bare commands** are consumed by the host and wake nobody (`host_command`, as today):
- `pin <text>`, `unpin <id>`;
- `kill <family>`, `reopen <family>`;
- `fund tokens <n> | usd <n>`;
- `extend <h>`;
- `pause`, `resume`, `stop`;
- `pass|fail <node> [note]`;
- `weaken <gauge>` (opens a supersede form);
- `steer <node> <text>`;
- `adopt <node>`.

**Free text** wakes the steward with `{t:'owner'}`. **Pins** enter L1 of every later brief. Running
nodes see a pin only through `steer`.

Owner gates are nodes in `awaiting`. They hold nothing. **Asks are batched:** the host posts one
inbox message per steward batch, listing every node that entered `awaiting` since the last post, each
answerable with `pass|fail <node>`. `budget.ownerAsks` bounds the number of nodes. The batching
bounds the number of interruptions (case 9).

### 4.6 Termination

Work stops for one of four causes. Judgment does not stop. If owner asks are open, or a kept target
node is not yet landed, the expedition enters `judging{cause}`. That status holds nothing: no seat, no
reservation, no start. In `judging`:
- owner verdicts are still taken;
- target keeps are landed by the host;
- `close-judging` finishes the expedition with `target` if the target got met, else with the cause.

| Reason | Condition |
|---|---|
| `target` | The `Target` holds on a **landed** node at the required level. Remaining planned nodes are cancelled, and moot asks expire as `expired{target_met}`. Reached from `running` or from `judging`. |
| `deadline` | `now ≥ deadline` and quiet. Then `judging` if anything is open, else finished. |
| `budget` | Quiet, and the cheapest planned node's cap exceeds what remains |
| `dry` | Every family is exhausted, and two consecutive steward wakes planned nothing |
| `steward_nogo` | The steward states a no-go or lower bound with a rationale. This is a valid terminal result (use-cases §4). With asks pending it passes through `judging`. A late keep that meets the target turns it into `target`. |
| `owner_stop` | The owner says `stop`: everything in flight is interrupted or expired and charged |

A pass on a non-target gauge never ends anything (use-cases §10.3).

The finish report is generated by the host from the record:
- kept and landed nodes with their levels ("exploratory" for non-target gauges);
- family table;
- spend per pool;
- expired asks.

The steward's closing digest is written on the `deadline` wake (deadline − 15 min) or the target
land, not after finish.

---

## 5. The nine cases in this model

The token figures below are order-of-magnitude **estimates** in input-equivalent tokens (IET),
using cache read = 0.1, cache write = 1.25 and output = 5. They are not measurements.

**1. GTM research** (repo `wave_sim/business`). Target: `owner`.

Run:
- **Seed:** one `sources-plan` node. Its gauge is a command `source_ledger_check.py` that checks
  ledger schema, surface status and that query logs exist.
- **Fan-out:** the steward plans 30 `collect-org` nodes, 4 earnings-call nodes and 4 review shards.
  Each is `work` (cheap seat, `writes: research/<run>/orgs/<org>.md` plus ledger rows). Their gauge
  is a command stage (counts and source IDs resolve), and they run on six seats. A paywalled or dead
  site refutes one collection. That collection is one depth-1 strike, which cancels nothing.
- **Synthesis:** one node with 38 **`reads`** edges, on the strong seat. It starts when every
  collection has settled, whatever the verdict, and its brief lists which ones failed. Its gauge is a
  command (every claim tag links to a source ID) plus a review with `independence: provider` and
  `access: blind{reads: decisive sources}` that re-opens 5 decisive sources.
- **Adversarial rounds:** three. Each is an attack node and a defend node, judged by a review stage
  on a third provider. A refuted thesis is followed by a `revise`, so with `strikes = 3` the thesis
  family survives three failed rounds.
- **Final node:** "packet + buyer test", with an `owner` stage. It parks in `awaiting` and holds
  nothing. If the deadline arrives first, the expedition enters `judging`, and the owner's later
  `pass` lands the packet and finishes it as `target` (the 2026-11-08 GTM failure cannot recur).

Where tokens go: about 70% on collection, on the cheap tier.

Weakness: there is no machine judge for the thesis, so width is capped at 4, and the owner is the
real bottleneck. V4 makes the wait free, not fast.

**2. Tidewar game design.** Target: `gauge` (the balance gauge) at level `accepted` (the owner
playtest).

Gauges:
- `instrument`: command `cargo test --test fairness` plus a determinism check that 48 seeds give
  distinct first-blood times (fixing the round-1 one-sample bug **first**).
- `balance`: three stages, then the owner:
  1. command build in the `compile` pool (cap 1, the 8-minute rebuild);
  2. metric, 16 seeds in the `cpu` pool (cap 4), through `compare.py` emitting a paired sign test
     and censoring, with `progress.goal` = the fairness threshold;
  3. metric, 64 seeds plus `--mirror`;
  4. owner playtest checklist.

Run:
- **Seed:** `instrument` (a `needs` parent of every lever node) plus an `exploit-hunt` family, so the
  exploit hunter runs in round 0, not late.
- **Levers:** families like `pacing:gold`, `kraken-timer` and `tower-hp`. Each node records its
  prediction in `claim`, so prediction-before-measure is structural.
- **Stacking:** kept levers land serially. The host re-runs `balance` on the expedition head after
  each land, and a stack that turns biased is reverted (G13, the "two confirmed changes stacked
  badly" lesson).
- **Edits:** reflectors are ordinary nodes with `writes`, so the "no owner for blocking fixes"
  failure cannot arise.
- **Finish:** the playtest is the gauge's owner stage, so the deadline cannot finish the expedition
  before the owner rules. It waits in `judging`.

Where compute goes: the compile pool is the binding constraint, about 7 builds an hour. `cost_f` now
counts compile-pool seconds over `cap × time-to-deadline`, so a family that burns builds without gain
sinks in the ranking even if its tokens are cheap. Probes name stage 1 with an incremental debug
build in the `cpu` pool (not the compile lock), which keeps nodes iterating while release builds
queue.

Weakness: the seats share a machine already at load 60–200. More seats do not help. The allocator
only helps by spending the 7 builds an hour on the right families.

**3. wave_sim speed and accuracy.** Target: `gauge` `matched-speed` at level `independent`.

Notebook seeded from `KEY_LEARNINGS.md`: about 30 graveyard rows imported as exhausted families,
each with its mechanism.

Gauge stages:
1. command, a 3-step correctness smoke on `gpu-local` (cap 1, seconds);
2. metric, matched error on a small case on `modal-l4` (cap 8, usd quota, about 2.5 minutes mostly
   setup);
3. metric, the full ridge scene using the ABBA protocol on `modal-h100` (cap 2);
4. `audit: review_above 10x` (external §1: median, not max). The host appends a provider-independent
   review.

Run:
- **Nodes:** families are kernel, solver and precision ideas. Nodes have
  `probe: {stage: 1, count: 10, usdEach: 0.15}`. That is 10 Modal runs reserved at node start, run in
  `modal-l4`, never waiting on the `gpu-local` lock. Stage 0 runs locally for verdicts while Modal
  probes run for other nodes. That is the "1–3 workers prepare packets while the GPU runner runs"
  pattern, enforced by pools.
- **Strikes:** `charter.strikes = 2`, the two-strikes pin. An idea fails, its revision fails, and the
  family is exhausted. The "sidecar" relabel trick is now caught by the dedupe stage, not by a
  family-wide counter (open question 6).
- **Steward:** wakes every K = 6 settles and rewrites the digest. That replaces 114 notes a day with
  one versioned 6k digest.
- **Artifacts:** each is a commit plus the JSON report in the repo artifact store (I16).

Weakness: matched error is wave_sim-specific. The host only reads keys; the repo owns the metric.

**4. Frontier math to algorithms.** Target: `gauge` `falsifier` at level `independent`, or
`steward_nogo` with a lower bound.

Discovery:
- **Discovery nodes:** `work` with `family: discover`,
  `access: blind{reads: [MINIMAL_PROBLEM.md, hardware.md], notebook: none}`, on strong seats across
  providers.
- **Discovery gauge:**
  1. review stage 0, "member of an exhausted family?", against the graveyard. It resolves or
     re-assigns the family, so strikes and statistics go to the true lineage (I21).
  2. review stage 1, a math judge checking units, limits, conservation and complete cost, on another
     provider.

Census and falsifiers:
- **Census:** one reduce node with `reads` edges to the discovery nodes (strong seat, ranking schema).
- **Falsifiers:** one node per selected candidate, which implements and runs it. Its gauge is a
  metric for matched error at complete cost on H100 against the best admissible baseline (that
  baseline is in the gauge's oracle; the integrator-order lesson).

Width and stopping:
- Discovery width is capped at `W[review] = 4` per claim. Diversity comes from many families, not
  many samples.
- The two-clean-sidecars stop rule is `strikes = 2` on each falsifier chain.

Where tokens go: about 80% on discovery and review thinking. GPU money goes to falsifiers only after
two review stages.

Weakness: this is the case the local seat ceiling hurts most (§4.2). The decisive verifier is hours
of GPU, so the frontier is $-bound. FunSearch-style millions of samples are out of reach. V4 bets on
few, well-filtered candidates, and the repeatability evidence (4 of 140) says to expect `nogo` often.
I15 (blind sparse tree) is ❌, so blindness is advisory today.

**5. New simulator capabilities.** Target: `rows` for R6, R7, R8, R9 and R12 × the engines named
in the charter.

Run:
- **Families:** one per (row, engine) cell. Each row gauge is a metric through the central runner
  with frozen thresholds and a `goal`, so gain (share of gap closed) is comparable across cells.
- **Allocation:** cells fan out across engines in parallel. Within a cell, refutations carry a
  diagnosis (the failure-class doc), so the steward plans `revise` chains. `strikes = 2` per chain.
- **Pin:** "write the failure-class doc and replay saved failures locally before paid spend". It is
  a pin, plus a gauge stage 0 command `replay_saved_failures.sh` on `gpu-local`.

Where compute goes: GPU dollars and serial depth. The `cost_f` denominator is dominated by usd.

Weakness: rows are judged by thresholds, but partial progress on a row that never passes still
spends. The steward has to call a row `nogo`.

**6. Deslop (buddies).** Target: `gauge` `lean` (typecheck + tests + screenshot baseline + a metric
for the line delta below budget) at level `measured`, plus an owner review.

Run:
- **Measure:** a seed node writes the inventory (gauge: command, the inventory JSON parses).
- **Slices:** the steward plans file-fenced slices as `work` (`writes` globs), each with a `needs`
  edge to the inventory. The gauge runs in a detached checkout of the commit, so the 48724f4 class
  (green against a dirty tree) cannot occur.
- **Integration:** serial land, re-running `lean` on the head after each land.
- **Fences:** a fence violation is `interrupted{fence}`, which removes the "swept another lane's
  hunks" failure. A metric stage requiring `records > 0` for imports catches the "imported 0
  records" class.

Width: none. A refuted slice gets one `revise` on the strong seat.

Weakness: deciding the lean target is judgment. It stays a steward plus owner act, and V4 doesn't
make it better than the deslop skill does.

**7. CRUD SaaS.** Target: `gauge` `app` (typecheck, integration tests, screenshots) and `owner`
walkthrough.

Run:
- **Seed:** the whole plan as `work` nodes. A schema node, then per-entity API nodes (`needs` schema),
  then UI nodes (`needs` API). The edges encode the DAG.
- **Steward:** wakes only on a struck group.
- **Allocation:** cheap seat, `writes` fences per entity, the shared schema file owned by one node.
  The 20 entity nodes are distinct work, so their success never narrows the fan-out: they run 6 at a
  time, at the seat cap.

This is a Workflow script with durability, owner steering and serial landing. Tokens are about one
node per feature.

Weakness: none structural. The overhead versus a Workflow script is the Buddy run startup per node.

**8. Geometry engine.** Target: `gauge` `boundary` at level `independent`.

Gauge stages:
1. command `python3 oompa/geometry/guard.py -- bun test …boundary.test.ts` (256 MiB, 60 s,
   1.4–2.8 s per run);
2. command, the independent chord-volume check;
3. review by an alternate provider.

Pools and nodes:
- **Pools:** `replay` with `count: 1` (G0's "exactly one replay"), enforced at spend.
- **Nodes:** few and deep. `revise` chains run on the strong seat with `probe: {stage: 0, count: 40}`.
  A tight TDD loop runs in-context.
- **Derivation nodes:** these write `derivations/*.md` (for example the bore-cap condition
  r > √(3.75² − 2²) − 2.5). Their review gauge checks the math, and they are `needs` parents of code
  nodes.

Validation runs on immutable shas in a detached checkout, so the dirty shared checkout that blocked
swarm cf9ea773 is irrelevant. `land` on an already-kept node is the "resume acceptance of a retained
candidate" act that was missing.

Where tokens go: thinking-heavy strong-seat nodes, with very cheap evaluations.

Weakness: the true bottleneck is insight. V4 only keeps the loop tight and the attempts remembered.

**9. Document model.** Target: `rows`, where each requirement-ledger row (G01–G12 plus the A94
gaps) is a review gauge against `REQUIREMENT_CONTRACTS.md`. Add one machine gauge: an executable
consumer-journey spike (edit, Undo, save, cold reopen), plus an `owner` ratification.

Run:
- **Families:** design alternatives.
- **Duels:** an attack node and a defend node, judged by a review stage on a third provider.
- **Owner questions:** each design node that needs a ruling ends in an owner stage. They are posted
  as one batched inbox message per steward batch (§4.5), bounded by `ownerAsks`.

The "8 redesigns, none replaced the app" failure is addressed only by making the target include the
machine spike and a retirement-plan command check. A design cannot count as progress unless the
spike moves.

Weakness: this is the weakest case. Most gauges are model or owner, so width is capped at 1–4 and
progress per token is bounded by owner latency. Gain is 1 per kept row, so the allocator cannot tell
a deep row from a shallow one. V4 mostly helps by not burning the deadline and not re-proposing dead
designs.

---

## Scaling example

How V4 follows the width rule in `research/scaling.md` §4. Labels: **measured** = recorded in
`research/use-cases.md`, `scaling.md` or `prior-art.md`; **design** = a value this doc sets;
**estimate** = from §6's assumptions, not measured.

### Rule map

| # | Rule (scaling.md §4) | V4 mechanism | Who decides, enforced how |
|---|---|---|---|
| 1 | Wide only on decomposable work | Distinct items are `work` nodes, run at the seat cap. Sequential chains are `needs` edges and `revise` chains, which cannot run in parallel (I12). | Owner (`charter.seed`) and steward (`plan`) choose `work` vs `needs`/`revise`: **LLM judgment**. The host enforces only the edges. ❌ No check that `work` siblings really are independent. |
| 2 | Never wide without a central verifier | Every node names a frozen, hashed gauge (G6, I5). Only produced artifacts are judged (I4). A `needs` child builds only on a kept parent (I12). | **Host-enforced.** A `reads` reduce sees refuted reports too, but labelled as refuted (case 1 synthesis). |
| 3 | Coordinate centrally, preassign, rebalance stragglers | `allocate()` is the one dispatcher. Nodes never message each other. There is no barrier, so a free seat takes the next ready node (§4.1 step 4). A slow node ends at `cap.wallS` as `interrupted{timeout}`. It is never judged and never strikes. | Allocation is **host-enforced**. ❌ No straggler hedge: there is no `WakeReason` for "a node is slow" and no host rule to start a `sample` beside it. Building it needs a `straggler` wake reason (or a host hedge) keyed on `startedAt` vs the family's median wall time. |
| 4 | Share selectively through one store | The Notebook (concept 6): families plus a digest of at most 6k tokens, written only by the steward (`notebook` act). Dedupe at three points (§4.4). Parents' reports pass as refs. | Admission to the digest is **steward judgment**. The 6k cap and the family-key refusal are **host-enforced**. Blind views (`access.notebook`) give island-style diversity, but I15 is ❌, so blindness is advisory. |
| 5 | Respect the ~45% ceiling | `w_G` falls as `p̂_f` rises. But with `q = 0.8` the formula still gives w = 3 at p̂ = 0.45–0.5 and w = 2 at p̂ = 0.6–0.7. It reaches 1 only at p̂ ≥ 0.8 (computed from §3.1). | ❌ Nothing applies rule 5 as `scaling.md` §4 states it. Two caveats. (a) `p̂_f = (kept+1)/(tries+2)` is a Laplace prior, so the fresh-family p̂ = 0.5 is no data, not a measured single-agent rate. (b) The 45% finding (β = −0.236) is about coordinated teams. V4 samples are independent best-of-N, each judged by the gauge, which is not the setting it was measured in. So whether rule 5 binds V4 samples is unproven. Building it: a clamp `w_G = 1 when p̂_f ≥ 0.45 and tries_f ≥ n_min` in `allocate()` (n_min unset), so the prior alone never fires it, plus a Quint test beside `widthCapRefusesTest`. |
| 6 | Width is earned from the verifier | `W[machine] = 16`, `W[review] = 4`, `W[owner] = 1` (G4, I18). Cheap stages run first (§4.1 step 2). `probe` gives an inner loop at the verifier's speed. `cost_f` charges scarce pool time. | **Host-enforced only for samples.** §3.1: "`w_G` only bounds `sample`s … `work` items are not width-limited: their concurrency is the seat cap". ❌ Distinct `work` nodes with a `review` or `owner` gauge run at the seat cap (about 6), above `W[review] = 4` and `W[owner] = 1`, so verifier strength does not limit them. Building it: a per-gauge-strength running cap on `work` nodes in `allocate()`. The steward's depth (`revise`) vs width (samples) choice is **LLM judgment**. Gap: §3.1 does not say which stage sets the strength `s` of a mixed gauge. This section assumes the weakest stage present. |
| 7 | Budget against measured speedup; narrow when tokens per verified result stop improving | `value_f = gain_f / cost_f` ranks families by gain per scarce unit. At 80% budget, big-cap nodes stop (§4.3). | Ranking is **host**. ❌ Nothing narrows width over time. `allocate()` never compares tokens per keep across widths or windows. Per-node usage is itself ❌ (build step 1). Building it: record tokens per kept node per family per steward batch, and drop seat concurrency (or `W`) when the ratio worsens for two batches. |

**Who sets width.** For samples, the host formula `w_G` is a host-enforced cap (I18). For distinct
work, it is the seat pool cap (I3, about 6 here). Whether to use the width at all is the steward's
judgment. Owner knobs: pool caps, `strikes`, seat tiers. There is no plan job.

### Worked example A, wide: case 3, wave_sim speed and accuracy

1. **Charter.** Target `matched-speed` at level `independent`. `strikes = 2` (owner's two-strikes
   pin). Pools: `seats` 6, `gpu-local` cap 1, `modal-l4` cap 8 with `usd: 40`, `modal-h100` cap 2
   (all **design**). The notebook is seeded with about 30 graveyard rows as exhausted families
   (**measured** count, `KEY_LEARNINGS.md`).
2. **Central verifier** (gauge `matched-speed`, cheapest first):
   - command: 3-step correctness smoke on `gpu-local`, seconds;
   - metric: matched error on a small case on `modal-l4`. A recorded Modal smoke took 157.8 s, of
     which 1.1 s was compute (**measured**);
   - metric: ridge scene, ABBA protocol, on `modal-h100`. ABBA is required because a noisy baseline
     once gave a false 0.842× (**measured**);
   - `audit: review_above 10x`, which appends a provider-independent review.
   Theory vs measurement: each node freezes `claim.prediction` before running, and the metric stage
   reports the measured value. ❌ The host never compares the two. The comparison lives in the
   repo's script output or in the review stage.
3. **Width grows.** Breadth is many families, at most 6 nodes running at once (seat cap). Within one
   claim, an undiagnosed refutation lets the steward plan samples up to `w_G`: 4 after one refuted
   try, 8 after three, 11 after five (§3.1 table). 16 needs `strikes = 3`. Samples span providers.
4. **Width shrinks.**
   - A diagnosed refutation becomes one `revise` (width 1).
   - Keeps raise `p̂_f`, which lowers `w_G`.
   - A struck head at depth 2 exhausts the family and cancels its planned nodes (I7).
   - At 80% budget, big-cap nodes stop starting.
   - ❌ Rules 5 and 7 do not shrink it (see the map).
5. **Sharing.** Nodes never talk to each other. Each brief carries the L2 notebook (digest plus
   family table). The steward wakes every K = 6 settles and rewrites the digest. That replaces the
   114 notes written on 2026-05-11 (**measured**) with one versioned digest. The dedupe stage catches
   the "sidecar" relabel trick (open question 6).
6. **Stragglers.** No barrier. A probe that finds its pool busy returns "retry after N s" and does
   not block. A finished node frees its seat for the next ready node at once. A hung node waits
   for `cap.wallS` (no hedge, ❌ rule 3). A refill needs ready nodes: when the frontier runs dry, a
   `frontier_low` steward wake must plan more. **Every refill of ideas costs a steward turn.**
7. **Local vs remote.** LLM nodes run locally as Buddy runs. Modal runs evaluations only, through
   the repo's runner argv. The host reserves the estimated usd, then settles the actual cost.
   Scale-to-zero is the runner's job. `gpu-local` (cap 1) runs the smoke for verdicts while Modal
   runs other nodes' probes. SSH machines are open question 3.
8. **Cost per verified result (estimate).** §6 puts 40 experiments (8 nodes × 5 probes) at about
   4.4M IET, about 110k IET per experiment (**estimate**). No keep rate is recorded for wave_sim.
   Borrowing autoresearch's roughly 3% (external §3, another domain) gives about 1 keep in 40, so
   about 4.4M IET per verified result. Treat that as illustrative only: the IET per experiment is
   the usable number, and IET per keep scales as 110k ÷ (the real keep rate). Dollars, on §6's
   5 probes per node: 5 × $0.15 = $0.75 per node on L4, about $6 for 8 nodes (**design** price).
   The reservation is larger: a probe cap of 10 (**design**) reserves $1.50 per node, about $12,
   and the unspent part is released at settle. H100 stage-3 runs come on top; no price is recorded.

### Worked example B, narrow then widen: case 8, geometry kernel

1. **Start narrow.** The first work is derivations, for example the bore-cap condition
   r > √(3.75² − 2²) − 2.5. Those nodes have a `review` gauge. `W[review] = 4` would cap samples
   of one claim only; distinct derivation `work` nodes would run at the seat cap (❌ rule 6). The
   work is a sequential argument (rule 1), so the steward plans a `revise` chain on the strong
   seat: width 1.
   Code nodes `need` the derivation nodes, so none start early (I12).
2. **Invest in an exact check first.** The steward plans a `work` node that writes a machine check
   (the independent chord-volume check, or closure and manifold checks), then proposes
   `freeze(gauge)`. A steward-frozen gauge can never be the Target (S5). The owner `supersede`s to
   make it one. The existing machine stage is the guarded boundary suite: 1.4–2.8 s per run, cap
   256 MiB and 60 s (**measured**).
3. **Inner loop, not width.** Code nodes run `probe: {stage: 0, count: 40}` (**design**): 40 test
   runs in one warm context. Suite failures name the failing radius, so refutations are diagnosed
   and the steward keeps planning depth.
4. **The trigger to widen.** The host enforces only the ceiling: `w_G` samples per group, up to
   `W[s]` for the gauge's strength (4 for `review`, 16 for `machine`). The trigger is the steward's
   judgment (§3.1): it plans width when a head's refutation carries no diagnosis, and depth when it
   does. Here suite failures are usually diagnosed, so width is rare. When it does widen, the host
   clamps samples at 4, then 8 (§3.1 table). Under this section's reading of rule 6, the
   `boundary` gauge's stage 3 review caps that at `W = 4`. A pure machine gauge (stages 1–2 only,
   non-Target) reaches 16.
5. **Replay quota.** The `replay` pool has `count: 1` (G0's exactly-one-replay rule). Samples that
   need that stage end `expired{unfundable}`. They never reach the second replay.
6. **Rule 5.** A family that keeps 1 of its first 2 tries has p̂ = (1+1)/(2+2) = 0.5, and `w_G` = 3.
   Two tries are thin evidence, and these samples are independent and machine-checked, not a
   coordinated team. Whether rule 5 should stop them is open; V4 has no rule either way (❌).
7. **Rule 7.** Tokens dominate this case (strong-seat thinking; evaluation takes seconds). Rule 7
   matters most here, and it is ❌ (no per-node usage, no narrowing rule).

### Mixed: case 1, GTM

Wide collection: 38 `work` nodes on 6 cheap seats, each with a command gauge (source IDs resolve).
Narrow synthesis: one node with 38 `reads` edges on the strong seat. Then three duels, each an attack
node and a defend node judged by a review on a third provider, as a `revise` chain (`strikes = 3`).
The duels are a chain, so width 1. `W[review] = 4` would cap only samples of one thesis. Distinct
thesis `work` nodes would run at the seat cap, about 6 (❌ rule 6). The shared store is the source
ledger plus the notebook.
About 70% of tokens go to cheap-tier collection (**estimate**, §5).

### Verdict

- **Scales well:** routine maps run at the seat cap with no width penalty (G2). Sample width is a
  host-enforced cap tied to verifier strength (I18). Distinct `work` width is not (❌ rule 6). The notebook gives one deduplicated store with
  no peer traffic. Remote pools run evaluations in parallel without remote agents.
- **Caps out at the local seat pool**, about 6 (§4.2). `w = 16` means waves of at most 6, not 16 at
  once. Case 4 is hit hardest.
- **The steward is in the refill loop.** New ideas need a `frontier_low` or `batch` wake. A wide
  frontier pays a steward turn per refill, batched at K = max(4, seat cap).
- **Missing narrowing rules:** no 45% clamp (rule 5), no tokens-per-keep narrowing (rule 7), no
  straggler hedge (rule 3), no verifier cap on distinct work (rule 6). Rule 7 depends on per-node
  usage, which is itself ❌ (build step 1). None is sized here.
- **Smallest change that raises the ceiling:** open question 8's in-node evolve loop. One node with
  a large `probe` budget fans candidates across `modal-l4`. Width then moves from local seats (6) to
  the remote pool cap (8) and its usd quota, with no change to the agent runtime. It still needs
  concurrent probes from one node, which §4.2 does not specify (❌).

---

## 6. Token and wall-clock economics

**Where tokens go.** Input dominates: 7–13:1 input to output, and 6–21M cache reads per run
(prior-art §7). V4 attacks input:
1. **No history paste.** L3 carries ≤ 1.2k chars per parent plus the diagnoses. The ledger runs
   re-sent the charter and history every turn.
2. **A stable cached prefix within each turn.** A node's own calls reuse its prefix at 0.1x. Sharing
   *across* nodes is smaller than revision 1 claimed. It happens only between nodes on the same
   provider and model that start within the TTL. Siblings spread across tiers and providers, or
   queued behind a pool, each pay their own prefix write. The estimates below assume no cross-node
   sharing.
3. **Inner loops.** Ten probes in one warm context instead of ten cold nodes, each paying the
   20–33k cold-seat cost.
4. **Sleeping steward.** No ticks. Wakes are batched (K settles), and a fingerprint suppresses
   unchanged states. Ledger runs had about 1.4 manager turns per work turn; V4 targets ≤ 0.2.
5. **Cheap seats for routine work and collection, strong seats for frontier work and judging**
   (RouteLLM: 95% of the quality at more than 85% lower cost).

**What runs without an LLM:**
- allocation, width, reservations, pool queues;
- every `command` and `metric` stage;
- strikes, exhaustion, reopening, pruning;
- gauge hash checks;
- landing merges (an LLM only on conflict) and re-measuring after a land;
- moving between `running`, `judging` and `finished`, and the finish report.

**Estimates.** These are IET, from the assumptions in §5, with every review turn, probe output,
steward wake and per-node prefix write counted. They are not measured, and a build should measure
them with per-node usage (build step 1). Read each ratio as **an upper bound on the saving**: the
real saving can be smaller, not larger.

| Case | Naive single-agent loop | V4 | Ratio | Wall clock |
|---|---|---|---|---|
| 3 (40 experiments) | One long session at about 8 calls per experiment, average context about 120k: 320 × 120k × 0.1 + writes 1.2M + output 2.4M ≈ **7.4M**. It also re-tests dead ideas (19 plate-lift attempts). | 8 nodes × 5 probes. Per node: own prefix write 21k + 30 calls × 70k × 0.1 + output 225k ≈ 456k, so 3.65M. Probe results read back ≈ 0.4M. 2 steward wakes 0.15M. 2 audit reviews 0.2M. ≈ **4.4M** | **≈ 0.6x**, less if graveyard dedupe avoids repeats | 40 × ~10 min serial ≈ 7 h, versus 4–8 Modal lanes ≈ 1.5–2 h |
| 7 (20 features) | One session, about 600 calls, average context about 100k: 6M + 2.25M + 3M ≈ **11M** | 21 nodes × (21k + 30 × 45k × 0.1 + 150k) ≈ 6.4M + steward 0.06M + 2 conflict nodes 0.3M ≈ **6.8M** | **≈ 0.6x** (and cheap-seat pricing, so ≈ 0.2x in $) | about 5 h serial, versus about 1.2 h at 6 seats plus serial landing |
| 1 (GTM) | One session with compaction, about 500 calls at about 150k: 7.5M + 2.5M + 2.5M ≈ **12.5M**. Quality decays with context rot. | 38 collections × 190k ≈ 7.2M + synthesis 0.6M + its blind review 0.3M + 6 duel nodes 1.8M + 3 duel judges 0.6M + ~7 steward wakes 0.56M ≈ **11.1M** | **≈ 0.9x** tokens, ≈ 0.35x $ with cheap collection | about 8 h, versus about 1.5 h plus owner time (which no longer burns the deadline) |

The honest reading: V4 saves at most about 1.7x tokens on routine and research loops, and roughly
nothing on judgment-bound cases (1, 9). Its big wins are wall clock (parallel pools), dollars (seat
tiers), and not re-buying dead ideas.

---

## 7. Against Claude Code Workflows and oompa

| | Claude Code Workflows | oompa | V4 |
|---|---|---|---|
| Plan | A JS script fixed at launch | A self-claimed file task queue | Seed nodes plus steward `plan` acts. Unstarted work is patchable. |
| Typed outputs | `agent({schema})` with StructuredOutput | Text signals (`CLAIM(...)`, 130/154 errors) | The `report` tool, zod-validated (taken from Workflows) |
| Parallelism | `parallel` / `pipeline`, cap min(16, CPUs−2) | N workers; 56% idle no-claim cycles | Pools per compute class. The allocator assigns, so nothing spins on an empty queue. |
| Judge | Whatever the script codes | A reviewer model, merge to main | Frozen, hashed gauge stages on immutable shas. Provider independence is enforced. |
| Memory | None across runs; resume replays a cached prefix | Last-10 merged subjects | Families with chain strikes plus a bounded digest. Done nodes are immutable and reusable by ref (the Workflows resume idea). |
| Budget | Hard output-token ceiling | `max_resumes` | Tokens, usd and count quotas, reserved for every LLM turn and remote run (I1) |
| Durability / steering | Dies with the session, no steering, Claude-only | Survives as processes; host pause file | One JSON record, Buddy runs with journals (❌ adoption), owner commands, mid-turn steer, any harness |
| Compute scaling | Width written by the author | `count` written by the author | Width per claim, derived from `p̂_f` and verifier strength |

What V4 takes:
- **From Workflows:** schema-forced outputs; no-barrier flow (a child starts the moment its parents
  settle, never at a round barrier); done-is-immutable; a hard budget.
- **From oompa:** a worktree per code unit; serial integration; candidate refresh by merge; a
  reviewer as a separate model; intelligence ∝ ambiguity as seat tiers; events, never projections.

What V4 does better: computed width; a shared memory that refuses repeats; typed scarce-evaluation
budgets; owner gates that hold nothing and still land after the deadline; and no idle polling.

Where Workflows wins: case 7 with no need for durability. A script is simpler. V4 should accept a
Workflow-style seed so that case costs the same.

---

## 8. Implementation sketch (this repo)

**Reused as-is or nearly:**

| Machinery | Where | Role in V4 |
|---|---|---|
| One JSON record, zod-parsed once, tmp+rename | `server/src/expeditions/record.ts` | The record (new schema) |
| `serialized()`, `commit()`, debounced step plus 60 s backstop | `server/src/expeditions/host.ts` | Host step body (§4.1) |
| Detached checkout, oracle restore, `ranOrNot` preflight | `server/src/expeditions/checks.ts` | `command` and `metric` stage runner. The single host-wide queue becomes per-pool queues. |
| Cambium add from exact sha, sanitized git env, salvage release | `server/src/expeditions/cambium.ts` | Node trees (code-writing nodes only). Collection nodes may use a shared read tree. |
| Buddy runs with leases; execution journals | `docs/patterns.md#lease-heartbeat`, `server/src/lifecycle/adopt-executions.ts` | Node turns, review-stage turns and the steward turn |
| Harness steering (`any-tool`, `buddy-tool-only`, `stop-hook-hold`) | `server/src/buddies/harness-steering.ts` | The `steer` act, and the `report` retry nudge |
| Manager chat seat, `seatOf`, `host_command` consumption | `host.ts`, `brief.ts` | Becomes the steward seat and owner commands |
| `ALLOWED` act × state table | `shared/src/expedition.ts` | Extended to the acts in §3.4 and the `judging` status |
| Retire | `server/src/expeditions/retire.ts` | Unchanged |

**New or rewritten, with a line budget:**

| File | Lines | Replaces |
|---|---|---|
| `shared/src/expedition.ts` | 480 (from 311) | The Charter/Attempt schema |
| `server/src/expeditions/host.ts` | 680 (from 943) | Deletes `fill`, `startAttempt`, the retry loop and `finishIfDue` pass-ends-all. Adds the rules fixpoint and `judging` |
| `server/src/expeditions/gauge.ts` (from `checks.ts`) | 420 (from 330) | Adds stages, pools, quotas, remote runner, metric read, audit, hash re-check |
| `server/src/expeditions/allocate.ts` | 170 | New, pure, unit-tested on fixtures: groups, width, pool-time cost |
| `server/src/expeditions/notebook.ts` | 160 | New: families, the key-dedupe guard, the digest cap, the three-layer brief (absorbs `brief.ts`, 174) |
| `server/src/expeditions/steward.ts` | 200 | New: wake reasons, fingerprint, effort table, steward reservation |
| `server/src/expeditions/tool.ts` | 280 (from 156) | Adds `report` (with `family`), `probe`, the steward acts |
| `cambium.ts`, `record.ts`, `retire.ts`, `routes.ts` | 435 (unchanged ±) | — |
| **Server + shared total** | **≈ 2,800** (today 2,349) | About +450 net. The retry loop and the Lesson line are deleted. |
| Client: frontier view (family table, node DAG list, pools, owner inbox, judging banner) | ≈ 500 | Replaces the attempt list |
| ❌ Per-node live usage + mid-turn cap kill | ≈ 90 (provider-usage fold, `docs/turn-lifecycle.md#provider-usage`, + a kill in the turn runner) | Build step 1. Without it I1 is unguarded |
| ❌ Node adoption across restart | ≈ 120 in `adopt-executions.ts` / `shutdown.ts` | Deletes `discardCrewTurns` for expedition nodes |
| ❌ Blind sparse tree | ≈ 80 in `cambium.ts` | I15 |
| ❌ Tests | `server/test/expedition-v4-{allocate,budget,gauge-pools,fence,land-regress,judging}.test.ts` | Each is a real-fixture integration test through the host step, per `docs/test-strategy.md`. The Quint directed tests name the scenarios. |

Build order (each step usable):
1. Gauge stages and pools, `report`, one reservation path for every LLM turn (node, review,
   steward), live per-node usage and the cap kill. This alone fixes the GTM and geometry failures
   (owner stage holds nothing; replay quota) and makes I1 true in code.
2. Nodes with typed edges, `allocate()` without width, and the `judging` status. This is cases 1 and 7.
3. Families, attempt kinds, chain strikes, the rules fixpoint and the notebook. This is cases 3, 5
   and 8.
4. The width rule, probes with explicit stages, remote pools and pool-time cost. This is cases 2, 3
   and 4.
5. Adoption.
6. Only if case 4 needs breadth beyond the seats: remote agent seats (open question 8).

---

## 9. Verification

Model: `docs/specs/expedition-v4.qnt` (revision 2). Bounds: 5 nodes, 2 families, 3 seat tiers on 2
providers (tiers 1 and 2 share one), seat cap 4 shared by node, review and steward turns, remote
measure cap 1, node cost 2, review cost 1, steward cost 1, token budget 10, usd budget 6 at 2 per
measurement, deadline at tick 6, horizon 9, strikes 2, W = {machine 4, review 2, owner 1} (scaled
down from 16/4/1 to fit five nodes), three gauge versions, one drift, one crash.

LLM judgment (plan contents, review and owner verdicts, measure outcomes, family resolution, the
steward's no-go) is `nondet`. The crash is the pessimistic no-adoption case.

The quint binary was
`/private/tmp/claude-501/-Users-nicholasbardy-git-buddies/7f8221f8-9cfa-4109-ae0f-8e52e6b36925/scratchpad/quint/node_modules/.bin/quint`
v0.33.1 (Rust simulator backend). There is no JVM, so `quint verify` (Apalache) was **not** run.
Every safety result below is random simulation, not proof.

Mutant copies and the runner scripts are in
`/private/tmp/claude-501/-Users-nicholasbardy-git-buddies/7f8221f8-9cfa-4109-ae0f-8e52e6b36925/scratchpad/rev5/`
(not committed). All runs used `--max-steps=40 --seed=42`. The machine was heavily oversubscribed
during these runs (load average 12–16 at the start, 370–450 later, from other sessions), and that
dictated the sample counts below.

**V1: Typecheck.** `quint typecheck expedition-v4.qnt` exits 0.

**V2: Safety.** `quint run expedition-v4.qnt --invariant=safety --max-samples=3000 --max-steps=40
--seed=42` reports `[ok] No violation found`. `safety` is the conjunction of all 18 modelled
invariants (I1–I13, I18–I22). The simulator draws its traces from the seed alone, not from the
invariant, so with one seed every individual invariant is checked on exactly these 3,000 traces.
The individual runs at 3,000 samples that completed agree with that:

| Invariant | 3,000 samples, seed 42 |
|---|---|
| `safety` (conjunction) | pass |
| `budgetHolds` (I1) | pass |
| `reservedIsHeld` (I2) | pass |
| `poolCaps` (I3) | pass |

Every invariant was also run on its own against the final model file (after the last witness and
test edits) with `--max-samples=300 --max-steps=40 --seed=42`, and each reported `[ok] No violation
found`:

| Invariant | 300 samples |
|---|---|
| `safety` | pass |
| `budgetHolds` (I1), `reservedIsHeld` (I2), `poolCaps` (I3) | pass |
| `judgedOnlyProduced` (I4), `gaugeFrozen` (I5), `judgeIndependent` (I6) | pass |
| `noPlannedInExhausted` (I7), `verdictStable` (I8), `deadlineBoundsWork` (I9) | pass |
| `landSerialKept` (I10), `finishedIsQuiet` (I11), `runsOnSettledParents` (I12), `noOrphanPlans` (I13) | pass |
| `widthClamped` (I18), `noStrandedKeep` (I19), `finishHasReason` (I20) | pass |
| `resolvedBeforeVerdict` (I21), `exhaustOnlyByChain` (I22) | pass |

The 3,000-sample per-invariant runs for I4–I22 were started too, then stopped unfinished when the
machine's load passed 400. The 3,000-sample `safety` run covers them on the same traces.

An early 300-sample run of `safety` on the first draft of this model also passed, and found no real
violation. Revision 2 found no new design bug by simulation. The design changes came from the
critique, and the tests and mutants below show that the model now catches each one.

**V3: Simulation performance (a model finding, not a design one).** The first revision-2 model ran
at about 0.3 traces per second. The cause was one `plan` action with ten nondeterministic choices
(the simulator rarely hit an enabled combination) and the rules fixpoint being evaluated before the
guards. Two fixes brought it to about 10 traces per second, and the comments at `commit` and
`planWork` say why:
- `plan` was split into `planWork`, `planSample` and `planRevise`;
- the fixpoint runs inside `commit(...)`, after the guards.

**V4: Directed tests.** `quint test expedition-v4.qnt` passes 13 tests. Each test names a must-fix
item it guards:

| Test | Shows | Critique item |
|---|---|---|
| `parallelSamplesOneStrikeTest` | 3 refuted samples of one claim = 1 strike, family open | M1 |
| `distinctWorkNeverStrikesTest` | 2 refuted collections, family open, the third collection still planned | M2 |
| `exhaustCancelsPlannedSiblingTest` | head + revise refuted → exhausted, planned sibling cancelled in the same write | M1, I7 |
| `refutedParentPrunesChainTest` | a dead `needs` parent prunes child and grandchild | I13 |
| `reduceOverDeadReadTest` | a reduce with one refuted and one kept `reads` parent runs and keeps | M3 |
| `widthCapRefusesTest` | at p̂ = 0.5 a 4th concurrent sample is refused although seats and budget allow it | M9 |
| `widthGrowsAfterRefutationTest` | after one refuted try, 4 samples run at once | M1, M9 |
| `lateOwnerKeepLandsTest` | an owner keep after the deadline lands the target from `judging` (10,000 samples) | M4 |
| `keepReopensStrikeExhaustedTest` | a keep in a strikes-exhausted family reopens it | S4 |
| `discoveryResolvesFamilyTest` | a `discover` node's strike lands on the family its report resolved | M7 |
| `needsChildOfKeptTest` | a `needs` child of a kept parent runs and keeps | I12 |
| `budgetFinishTest` | budget stop-work with open asks → `judging` → `finished{budget}` (10,000 samples) | S3 |
| `reservationRefusesOvershootTest` | the steward's reservation is what makes the 5th start overshoot | M5 |

**V5: Non-vacuity witnesses.** Each witness is a claim that should be false. Each was run with
`quint run --invariant=<w> --max-samples=3000 --max-steps=40 --seed=42`:

| Witness (claim that should be false) | Result |
|---|---|
| `w_noKept` | violated (`--seed=0x5931eb`) |
| `w_noReplan` | violated (`0x5931eb`) |
| `w_noInterruptedByCrash` | violated (`0xaa057`) |
| `w_noTwoParallel` | violated (`0x1a440e8`) |
| `w_noExhaustCancel` | violated (`0xea9d4`; this can come from an owner `kill`, so it does not by itself show strike exhaustion) |
| `w_noOrphanPruned` | violated (`0x13b590`) |
| `w_noVerdictOnRevisedGauge` | violated (`0x34514c8`) |
| `w_noLanding` | violated (`0x72cb039`) |
| `w_budgetSlack` | violated (`0x9082146`) |
| `w_noReviewTurn` (a review stage never holds a seat) | violated (`0xb0eb74`) |
| `w_noStewardTurn` | violated (`0x30f0`) |
| `w_noResolvedDiscovery` (no `discover` node ever gets a verdict) | violated (`0x14b7d58`) |
| `w_noReduceOverDeadRead` | violated (`0x34514c8`) |
| `w_noDriftExpired` (gauge drift never expires a node) | violated (`0x7d8e4`) |
| `w_noStrikeOnce` | violated (`0x3ed7eda`) |
| `w_noJudging` | violated (`0x1ed3da3`) |
| `w_noLateOwnerVerdict` (no owner verdict in `judging`) | violated (`0x72cb039`) |
| `w_noLateLand` (no land in `judging`) | violated (`0x72cb039`) |
| `w_noDeadlineFinish` | violated (`0x66eb800`) |
| `w_noDryFinish` | violated (`0x11c710`) |
| `w_noNogoFinish` | violated (`0x1f7e4`) |
| `w_noOwnerStop` | violated (`0x2a`) |
| `w_noExhausted` (no family exhausted by strikes) | **not violated** in 3,000 samples. Reached by `exhaustCancelsPlannedSiblingTest`, which asserts `not(w_noExhausted)` |
| `w_noChildOfKept` | **not violated**. Reached by `needsChildOfKeptTest` |
| `w_noWidth3` (no claim ever runs 3 tries at once) | **not violated**. Reached by `widthGrowsAfterRefutationTest` (4 at once) |
| `w_noReopen` | **not violated**. Reached by `keepReopensStrikeExhaustedTest` |
| `w_noTargetFinish` | run stopped unfinished under machine load. Reached by `lateOwnerKeepLandsTest` |
| `w_noBudgetFinish` | run stopped unfinished under machine load. Reached by `budgetFinishTest` |

The four unreached witnesses need 10 or more specific steps in order (two refuted groups in a chain,
a kept parent then its child), which the uniform random walk over about 30 actions rarely produces.
For those, the directed tests are the evidence, as V4 of revision 1 already noted for the exhaustion
race. ❌ Run `quint verify` (Apalache) when a JVM is available. It would cover every interleaving
within the bounds.

**V6: Mutants (are the invariants vacuous?).** Each mutant removes one guard, and the property that
the guard protects must then fail:

| Mutant | Command | Result |
|---|---|---|
| M1 `m1_flip.qnt`: an extra action flips a Kept node to Refuted | `quint run m1_flip.qnt --step=stepM --invariant=verdictStable --max-samples=3000` | **violated** (`0x39c6334`). Revision 1's `verdictStable` passed this mutant |
| M2 `m2_nodrift.qnt`: `settle()` skips the hash re-check | `quint run m2_nodrift.qnt --invariant=gaugeFrozen --max-samples=3000` | **violated** (`0x25c7510`) |
| M3 `m3_overrun.qnt`: a turn may use `COST + 1` (no cap kill) | `quint run … --invariant=budgetHolds --max-samples=3000` | not violated by random simulation (`[ok]`). The directed `quint test m3_overrun.qnt --match=overrunBreaksBudgetTest` (two concurrent overruns at the budget edge) **fails** with "Expect condition does not hold true": I1 needs the cap kill |
| M4 `m4_nowidth.qnt`: `startN` drops the width guard | `quint run … --invariant=widthClamped --max-samples=3000` | **violated** (`0x277cc92`). `quint test` → `widthCapRefusesTest` **fails** |
| M5 `m5_nojudging.qnt`: stop-work always finishes | `quint test m5_nojudging.qnt` | `lateOwnerKeepLandsTest` **fails** (revision 1's dead-letter verdict) |
| M6 `m6_readsneeds.qnt`: `reads` parents must be kept | `quint test m6_readsneeds.qnt` | `reduceOverDeadReadTest` **fails** (revision 1's stuck reduce) |
| M7 `m7_oldstrikes.qnt`: exhaust at 2 refutations in a family | `quint test m7_oldstrikes.qnt` | `parallelSamplesOneStrikeTest`, `distinctWorkNeverStrikesTest` and `keepReopensStrikeExhaustedTest` **fail** (revision 1's strike rule) |

Single-guard tripwires, stated plainly: `deadlineBoundsWork` restates the `clock < DEADLINE` guard
in `startN`, and `judgeIndependent` restates the provider guard in `planWith`. They stay because they
fail if those guards are removed.

**Not modelled:**
- the allocator's ordering (UCB per scarce unit; any order is allowed, which is stronger);
- probes and probe usd;
- fences and blind access;
- land regressions and conflicts;
- `pause`;
- the steward's "two empty wakes" condition for `dry` (modelled as "every family exhausted");
- `expired{ask_expired}`;
- the 15-minute closing-digest wake.

---

## 10. Self-critique log

**Round 1. Attack against the nine cases.**

The strongest objection: *"The width rule widens exactly where width is waste."* In case 5 (a cell
debug loop) and case 8 (geometry), refutations are correlated: every sibling hits the same bug. A
falling `p̂` would launch up to 16 siblings, which is the 38-agents-on-7-experiments failure of
Tidewar round 1. Test-time-compute evidence agrees: compute-optimal scaling helps only where the
base model sometimes succeeds *independently* (external §4).

Changed:
1. `w` is a **cap**, not a mandate.
2. Refutations carry a `diagnosis` (from the failing stage's JSON or the review schema). A diagnosed
   refutation makes the steward plan **depth** (in revision 2: a `revise`), not width.
3. Width is spent only on unexplained failures, and is spread across seat tiers and providers, so
   siblings are not clones.

Second objection, same round: *"Owner gates still stall case 1."* Accepted as a stated weakness
(§5.1). V4 frees the slot and the deadline, but does not speed the owner up. `ownerAsks` was added
so the steward cannot flood the owner.

**Round 2. Attack against simplicity.**

The strongest objection: *"Seven nouns, five stage kinds, views, fences, quotas, claim levels: this
is the 13.5k-line ledger again (L17)."*

Changed:
1. **Statistics left the host.** The `paired` stage kind was deleted. Seed sets, sign tests and
   censoring live in the repo's own script, which a `metric` stage reads as numbers. That resolves
   use-cases §11's "where does the statistical judge live": the repo. Four stage kinds remain.
2. **Read and write rules merged.** `View` and `Fence` became one `Access` union.
3. **No step kinds.** Map, reduce, duel and gate are patterns of nodes, parents and stages, not
   types.
4. **No new bookkeeping concept.** The steward's "effort table" is derived output of `allocate()`.
5. **`ClaimLevel` is computed, never stored by an agent.**

Residual objections after revision 2:
- The relabel trick (open question 6).
- The local seat ceiling for case 4 (open question 8).
- Blind isolation (I15) and adoption (G14) are ❌.
- The economics in §6 are estimates, and upper bounds on savings, until per-node usage is recorded.

---

## 11. Critique and revision

An independent review (scores: use-case coverage 5, simplicity 7, token efficiency 6, frontier
scaling 3, owner control 6, Quint fidelity 4; verdict "not ready") raised 9 must-fix and 9
should-fix items. Each one is listed below with the response. Its probes ran on a scratchpad copy
(`.../scratchpad/rev4/probe.qnt`); their revision-2 counterparts are in §9.

### Must-fix

| # | Critique | Response | Where |
|---|---|---|---|
| M1 | Strikes cancel width. With `strikes = 2`, a family dies at p̂ = 0.25, before width can grow. The "0.1 → 16" row needs 8 refutations. Parallel siblings count as consecutive strikes. The posterior rule needs n ≥ 44. | **Accepted.** Strikes are now counted per claim **group**, so a whole fan-out is one strike. Exhaustion needs a **revise chain** of struck groups at depth ≥ `strikes`. The width table was recomputed from the integer rule: 3 → 4 → 8 → 11 → 16. With strikes = 2 one chain reaches 8–11, and 16 needs strikes = 3. G3 now says so. The posterior rule was deleted. | §3.1 claim groups and width table, §4.3, G3, I22; Quint `rulesOnce`, `exhaustOnlyByChain`, `parallelSamplesOneStrikeTest`, `widthGrowsAfterRefutationTest` |
| M2 | A family means both replicas and distinct work. Case 7 narrows to width 1 as it succeeds. Case 1 loses all collection after two failures. | **Accepted, with the suggested typed variant.** `Attempt = work \| sample{of} \| revise{of}`. Width bounds only samples of one claim. Strikes come only from chains. Distinct `work` never narrows, never strikes another item, and is never cancelled by another item's failure. | §3.1 `Attempt`, §4.3 first row, cases 1 and 7; `distinctWorkNeverStrikesTest`, mutant M7 in §9 V6 |
| M3 | A reduce over many parents cannot complete: one failed collection cancels the 38-parent synthesis. The model had `parent: int`. | **Accepted.** `Edge = needs \| reads`. `needs` must be kept and prunes on death. `reads` needs any settled verdict, never prunes, and passes the report as a ref. The model now has `needs: Set[int]` and `reads: Set[int]`, and I12 and I13 were re-checked over sets. | §3.1 `Edge`, I12, I13, case 1; `reduceOverDeadReadTest`, witness `w_noReduceOverDeadRead`, mutant M6 |
| M4 | Owner verdicts after finish are dead letters (`r_lateKeepLands` violated). | **Accepted: finish waits.** A new status, `judging{cause}`, holds nothing. Owner verdicts and target lands still run in it, and `close-judging` picks `target` if the target got met. `steward_nogo` with asks pending goes through `judging` too. The owner's `stop` expires open asks explicitly. | §3.1 `ExpeditionStatus`, §4.6, G7, I11, I19; `lateOwnerKeepLandsTest`, `noStrandedKeep`, witnesses `w_noJudging`, `w_noLateLand`, mutant M5 |
| M5 | Review, steward and retry turns are not reserved, so I1 covers only nodes. I2 contradicts remote usd reservations. | **Accepted.** Every LLM turn (node, `reviewing` stage, steward) takes a seat and a reservation. I2 is restated as "held exactly by running turns and in-flight remote runs". The `report` retry is a steer inside the node's own turn and its reservation. The model has `Reviewing`, a steward seat, and usd for measuring. | §3.1 `NodePhase.reviewing`, `StewardState`, I1–I3; Quint `reservedIsHeld`, `poolCaps`, `reservationRefusesOvershootTest` (the steward's reservation is what refuses the start) |
| M6 | I1 depends on a token cap nothing enforces. | **Accepted, both halves.** Live usage plus a mid-turn cap kill moved to build step 1. I1 is marked "❌ unguarded in code" until then. The model's `used ≤ COST` is labelled as that guard, and mutant M3 lets a turn overrun its cap, which violates `budgetHolds`. | I1, G10, §8 build order; §9 V6 |
| M7 | Family identity at plan time breaks blind discovery and post-hoc dedupe. `IdeaProposal` was undefined. | **Accepted.** `FamilyRef = family \| discover`. The report's `FamilyClaim` and the dedupe stage's `family` output resolve or re-assign it before any statistic or strike is written. `IdeaProposal` is now defined. A re-assignment to an exhausted family counts as a re-test in that family's stats. | §3.1, §4.4 dedupe point 3, case 4, I21; `discoveryResolvesFamilyTest`, `resolvedBeforeVerdict` |
| M8 | `verdictStable` is vacuous. `gaugeFrozen` mirrors one assignment. | **Accepted.** `verdictStable` now checks the phase against an append-only verdict log written only by `settle()`. The flip mutant (M1) violates it. `gaugeFrozen` now runs against an environment action `drift`, which changes a version's hash under its id. `settle()` re-checks the hash and expires the node on a mismatch. The mutant without that check (M2) violates it. `deadlineBoundsWork` and `judgeIndependent` remain single-guard tripwires, and the table says so. | I5, I8; §9 V6 |
| M9 | The thesis mechanism (allocator, width, W clamp) is unmodelled. `r_ownerWidthOne` was violated. | **Accepted.** `startN` now enforces the width formula in integers (`5·(n−k+1)^w ≤ (n+2)^w`) with the W clamp per gauge kind. `widthClamped` (I18) holds, `widthCapRefusesTest` and `widthGrowsAfterRefutationTest` drive it, and mutant M4 (no width guard) fails the test. The allocator's **order** (UCB) is still unmodelled, because any order is allowed in the model, which is stronger. | §3.1, I18; Quint `width`, `startN` |

### Should-fix

| # | Critique | Response |
|---|---|---|
| S1 | Probe pools are inconsistent: case 3 probes stage 1 while §4.2 says stage 0. Probes block on a cap-1 pool, and probe usd is unreserved. | **Accepted.** `Probe = none \| stage{stage, count, usdEach}` names the stage. The probe runs in that stage's pool and never blocks ("retry after N s"). `count × usdEach` is part of the node's `Reservation`. Case 3 probes stage 1 on `modal-l4`. |
| S2 | Gain is undefined for non-metric gauges and not comparable across keys. The cost should be pool time. | **Accepted.** A keep on a command, review or owner gauge has gain 1. A metric's gain is the share of the gap to its frozen `goal` that was closed, which is comparable across keys. The cost is per-pool spend over what remains in that pool (`cap × time-to-deadline` for unlimited host pools), so the compile lock and GPU dollars rank families in cases 2 and 3. |
| S3 | Finish is ungated (`r_finishHasReason`). No reasons are modelled. | **Accepted.** `stop-work(cause)`, `finish(target)`, `close-judging` and `stop` are separate acts, each guarded. I20 `finishHasReason` holds, with one witness per reason (§9 V5). |
| S4 | A keep after exhaustion leaves the family dead. Siblings run in exhausted families. | **Decided.** A keep in a family exhausted by strikes reopens it (`keepReopensStrikeExhaustedTest`). Owner and steward exhaustion stand, and the keep is recorded. Running tries in an exhausted family are **allowed to finish**: they are paid for, and a keep among them is exactly what reopens the family. So `r_noRunInExhausted` is not a design invariant, and the doc says why (§4.3). |
| S5 | The steward can freeze an easier gauge and report progress on it. | **Accepted.** Only nodes on a Target gauge can meet the Target. `freeze` never creates a Target gauge, and only the owner's `supersede` changes the Target. Keeps on other gauges are labelled "exploratory" in the finish report. The model's `onTarget` flag carries this. |
| S6 | Independence is per seat, not per provider. The >10x audit is only a pin. | **Accepted.** `Independence = provider \| seat`, and only `provider` confers `independent` (checked at `plan`; the model checks provider for every review). `Audit.review_above` makes the >10x audit part of the frozen gauge. |
| S7 | The frontier ceiling is the local seat count. | **Accepted and stated** (§4.2): `w = 16` means waves of at most about 6. Remote agent seats are open question 8 and build step 6, case 4 only. |
| S8 | Several token claims do not hold: cache sharing needs the same model, the 5-minute TTL, and review and probe turns were omitted. | **Accepted.** §6 now assumes no cross-node cache sharing, counts review turns, probe output and steward wakes, and calls each ratio an upper bound on savings. Case 3 moves from 0.55x to about 0.6x, and case 1 from 0.8x to about 0.9x. |
| S9 | This is v1 under new names, not "not built on" v1. | **Accepted.** The header now states the lineage: what was removed (Round, Meta-plan, Objective) and why, and that `allocate()` is the one new mechanism. |
| S10 | Smaller items: G15 versus §8 line counts; crash re-pays remote usd; land-conflict resolve semantics; owner-ask batching; nogo with pending asks. | **All fixed.** G15 and §8 now both say ≈ 2,800. `crash` charges in-flight usd, and the restarted measurement reserves again (modelled). A resolve node is a `work` item in the landed node's family with `needs: [node]`, so it can never exhaust a family alone. Asks are batched per steward batch (§4.5). `steward_nogo` with pending asks goes through `judging`. |

### What did not change

- Seven concepts. Attempt kinds, edges, the judging status and the expired phase are variants of
  existing types, not new nouns. One concept-level rule was deleted: the posterior exhaustion rule.
- The thesis still rests on one host function. The critique's point was that the function was wrong,
  not that it was the wrong idea. Its arithmetic is now in the model. Its ordering heuristic (UCB per
  scarce unit) is still prose plus a ❌ unit test, because the model's "any order" is a superset.
