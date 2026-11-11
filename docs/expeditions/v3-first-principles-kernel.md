# Expeditions V3: a minimal kernel (Jobs on Pools over a Ledger)

Status: **design, revision 2, 2026-11-09. Not built.** Derived from first principles from the
nine owner use cases. Inputs: `docs/expeditions/research/{use-cases,prior-art,external}.md`;
conventions: `docs/design-specs.md`; checked model: `docs/specs/expedition-v3.qnt`. Revision 2
answers an independent critique (§12): three of its probes violated revision 1's own claims in
Quint, and all three are now model invariants that hold. Today's code is cited only as machinery
to reuse.

---

## 1. Thesis

An expedition is **a budgeted stream of immutable Jobs, run on capacity-limited Pools, whose
typed results append to one Ledger, under a frozen Charter.**

- A Job is one unit of compute: an agent turn, a host or remote command, or a question to the
  owner. A job may hold **several pools at once** (an agent seat and the GPU), reserved together.
- A Pool says where and how much: claude seats, the local GPU (1), the compile lock (1), Modal
  (N), an SSH box (N), the integrator (1), the owner (unbounded, judgment class).
- The Ledger is the only shared memory: ideas, measurements, claims, verdicts, integrations,
  notes, amendments, digests and refusals, append-only and keyed. Briefs are bounded projections
  of it, never pasted history.
- The Charter freezes what must not move during a run: goal, done predicate, judges (hashed) and
  their bindings, quotas, budget, pools, views, grants, the plan rule. Owner amendments are
  ledger rows; judges and bindings never change while running.

**What this is, honestly.** The `plan` job (E4) is the leader of the earlier leader/round design
made *stateless*: it holds no session, no verdict power and no rewrite rights, and it runs only
when a pool it fills runs low. Recipes (plan, duel, census, population, evolve) are that design's
per-round node kinds, as spawn-time functions. Charter + amendment rows are its versioned
Objective; reservations are its budget. What is genuinely new: (1) the planner is a job with a
grant, not a seat; (2) any job may spawn within its grant, so topology is data; (3) each pool
fills independently, multi-pool jobs included; (4) judgment (judges, owner, integration) drains
past the deadline while work does not; (5) every termination path has a typed outcome, checked
in Quint.

The host owns only structure, the things LLMs have repeatedly failed at: reservations and caps
(runaways, overshoot); judge independence and claim promotion (self-certification, a lowered
bar); immutability and keys (malformed or double-applied results, re-tested graveyard ideas);
adoption (lost turns); draining (the deadline killing judgment); pruning (idling to the deadline
on work that can never start).

The nine cases differ in *topology* (fan-out, serial, duel, population, human gate) but share
the same *physics*: scarce compute, frozen judges, accumulating evidence. The kernel encodes the
physics and leaves the topology to data.

## 2. Concepts

**Fifteen named things.** Revision 1 claimed six; the critique counted ~15 and was right. Four
primitives carry the rest; each line says what fails without it.

| # | Concept | What it is | Delete it and this fails |
|---|---|---|---|
| 1 | **Charter** | Frozen inputs (§3). Hash recorded at launch. | (2) the G3 bar lowered after results (1.227 vs 1.5); (4) the evaluator not frozen before outputs. |
| 2 | **Job** | One immutable unit: spec → state → one result. Kinds `agent`, `command`, `owner`, `judge`, `integrate`. | (2) a 48-seed A/B has no unit to fan out; every case loses adoption and keyed caching. |
| 3 | **Pool** | Capacity and class (work vs judgment). A job reserves one or more pools. | (1) the owner gate held the only slot past the deadline; (3) GPU 1 vs Modal N; (2) the compile lock; (8) an agent and its guard suite. |
| 4 | **Ledger** | Append-only keyed rows. Quotas count rows; Done reads them; projections render them. | (3) the graveyard re-tested; (2) the progression log lost. |
| 5 | **Claim** | A ledger row with a key, evidence and a ref; its status is its latest verdict. | Nothing is judged, nothing integrated, Done has no atoms. |
| 6 | **Judge + Binding** | A frozen check; a binding maps a row key pattern (claim or idea) to an ordered chain. | Self-certification; novelty never runs. |
| 7 | **Grant** | What a job may spawn: count, pools, views, a spawn guard. Child ≤ parent. | Runaway ("one early failure spawned 50 subagents"). |
| 8 | **Family + Quota** | A family is assigned by owner seeds or by a novelty verdict, never by the proposer. A quota counts `starts` or `refutations`. | Two strikes, exactly one replay, wide-cheap/strict-GPU frontier. |
| 9 | **Reservation (incl. `held`)** | Budget reserved at start, per meter; `held` is judgment reserved for recorded candidates. | Parallel overshoot; unaffordable judgment wedging drain (rev1 finding). |
| 10 | **Done** | A predicate over claim statuses (`all`/`any`/leaf), or `open`. | Cases 5 and 9 cannot be stated. |
| v1 | **Ref** | `{sha}` or `{digest, path}` in the artifact store. | (3) artifacts lost in worker trees; (6) a result citing a dirty tree (48724f4). |
| v2 | **View** | `full`, `blind{allow}` or `none`: a projection filter. | (4) blind discovery leaks architecture; briefs grow with history. |
| v3 | **Session** | `fresh`, `fork{of}`, `resume{of}`, with a lineage root. | Wide fan-outs pay 20–33k cold starts N times; judge independence by lineage. |
| v4 | **Cost** | Per-meter usage on every settled job. | No reservation can be checked. |
| L | **Recipe** | A library function `(args) => JobSpec[]` + prompt + output schema. The kernel never dispatches on recipe names. | Each case hand-writes specs. |

**Deleted in revision 2:** `verdict.pass` (redundant with the outcome), `Expedition.amendments`
and `Charter.rulings` (both are now one `amend` row kind), `Judge.agent.notSeatOf` (a literal
that encoded nothing), the `verdict-request` row (never a type).

**Not concepts** (configurations, §5): leader, round, phase, attempt; map, reduce, duel, census,
population, island; gate, check, review; stop rule, two strikes; the manager chat; scribe and
synthesize (recipes).

## 3. Types

```ts
// shared/src/expedition-v3.ts (one type source; Zod mirrors these)

type Charter = {
  v: 3;
  goal: string;                          // prose, byte-stable: first in every brief (cache prefix)
  done: Done;
  deadline: { hours: number };
  budget: Meters;                        // whole-expedition ceiling, per meter (I1)
  pools: Record<PoolId, Pool>;
  judges: Record<JudgeId, Judge>;        // frozen; hashed
  bindings: Binding[];                   // row key pattern → judge chain; frozen; hashed
  families: Families;
  quotas: Record<Family, Quota[]>;       // a family may carry a start quota AND a strike quota
  quotaDefault: Quota[];                 // explicit for families not listed ([] = unbounded)
  views: Record<ViewId, View>;           // launch adds 'full' and 'none' if absent (explicit, listed in the draft)
  grants: Record<GrantId, Grant>;        // launch adds 'leaf' = {spawn: 0} if absent
  plan: PlanRule | { t: 'none' };        // 'none': seeds are the whole DAG (case 7)
  seeds: JobSpec[];
  integrate: { t: 'auto'; branch: string } | { t: 'owner' } | { t: 'never' };
  base: Ref;                             // launch commit: oracle source for command judges
  hash: string;                          // sha256 of the canonical charter
};
type Meters = { tokens: number; usd: number };   // count-type limits are quotas, not meters

type Done = { t: 'open' } | { t: 'pred'; p: Pred };
type Pred =
  | { t: 'all'; of: Pred[] }
  | { t: 'any'; of: Pred[] }
  | { t: 'claim'; key: ClaimKey; at: StatusTag[] };  // the claim's CURRENT status ∈ at
// No ordering between levels: `at` is a set. Status = the latest verdict row for the claim.

type Families =
  | { t: 'seeded' }                      // only charter seeds name families (cases 5, 7, 8)
  | { t: 'judged'; binding: BindingId }; // an idea's novelty chain assigns the family (cases 2, 3, 4)
type Quota = { counts: 'starts' | 'refutations'; max: number };

type PlanRule = {
  grant: GrantId;
  fill: PoolId[];        // E4 considers ONLY these pools (never judge or synthesis pools)
  horizon: number;       // plan to pending = horizon × cap per fill pool (default 2)
  minIntervalS: number;  // ≥ one cache TTL (default 300); owner `plan now` bypasses it
};

type Pool =
  | { t: 'agent'; provider: string; model: string; effort: string; cap: number;
      fork: 'native' | 'emulated' | 'none' }                 // from the harness (vendor/agent-cli-tool/src/session.ts)
  | { t: 'host'; cap: number; class: 'cpu' | 'gpu' | 'lock'; idle: IdleRule }
  | { t: 'remote'; cap: number; usd: number; launcher: Launcher }
  | { t: 'integrator' }                                      // cap 1, judgment class
  | { t: 'owner' };                                          // cap ∞, judgment class, cost 0
type IdleRule = { t: 'any' } | { t: 'loadBelow'; load: number };
type Launcher =
  | { t: 'modal'; app: string }                              // remote id = Modal call id
  | { t: 'ssh'; host: string; workdir: string };             // remote id = host:pidfile

type Judge =
  | { t: 'command'; argv: Argv; oracle: RepoPath[]; pool: PoolId; emits: SchemaId }
  | { t: 'stat'; argv: Argv; pool: PoolId; test: 'paired-sign' | 'threshold'; seeds: SeedSet }
  | { t: 'agent'; rubric: string; pool: PoolId; view: ViewId; independence: 'provider' | 'model' }
  | { t: 'owner'; question: string; expires: { t: 'never' } | { t: 'hours'; h: number };
      remindEveryH: number };
type Binding = { id: BindingId; match: { row: 'claim' | 'idea'; prefix: string }; chain: JudgeId[] };

type Grant = {
  spawn: number;                          // child spawns are decremented from this (I13)
  pools: PoolId[]; views: ViewId[];
  guard: { t: 'any' } | { t: 'newKeys'; prefix: string };  // spawn accepted only if THIS result wrote a new key under prefix
};

type JobSpec = {
  key: SpecKey;               // sha256(kind, inputs, view, attempt)
  attempt: number;            // a lost/failed/cancelled key may be re-spawned at attempt+1
  pools: [PoolId, ...PoolId[]];   // all reserved at start, all-or-nothing (no hold-and-wait)
  kind: JobKind;
  view: ViewId;
  after: SpecKey[];
  family: Family | { t: 'none' };   // seeds: owner-named; spawned: inherited, or the cited idea's
  grant: GrantId;
  session: { t: 'fresh' } | { t: 'fork'; of: JobId } | { t: 'resume'; of: JobId };
  emits: { claims: number; ideas: number };   // reserved judgment = claims × maxChain(claim) + ideas × maxChain(idea)
};

type JobKind =
  | { t: 'agent'; recipe: string; prompt: string; output: SchemaId;
      tree: { t: 'none' } | { t: 'cambium'; from: Ref } }
  | { t: 'command'; argv: Argv; at: Ref; harvest: RepoPath[] }
  | { t: 'owner'; question: string; options: string[] }
  | { t: 'judge'; judge: JudgeId; row: RowKey }               // engine only
  | { t: 'integrate'; claim: ClaimKey };                      // engine or owner act only

type JobState =
  | { t: 'pending' }
  | { t: 'running'; since: string; reserved: Meters; exec: ExecRef }  // agents AND commands: journaled
  | { t: 'done'; result: Result; cost: Cost }
  | { t: 'failed'; why: Failure; cost: Cost }
  | { t: 'lost'; at: string; charged: Meters }                // journal found its process dead
  | { t: 'cancelled'; why: 'drain' | 'owner' | 'quota' | 'budget' };
type ExecRef =
  | { t: 'buddy-run'; executionId: string }
  | { t: 'local'; journal: string; pid: number }
  | { t: 'modal'; callId: string }
  | { t: 'ssh'; host: string; pidfile: string };
type Failure =
  | { t: 'exit'; code: number; tail: string } | { t: 'malformed'; issues: string[] }
  | { t: 'timeout' } | { t: 'cannot_run'; why: string }      // checks.ts ranOrNot: never a strike
  | { t: 'reservation'; reserved: Meters; used: Meters }      // killed on the usage stream
  | { t: 'refused'; why: string };
type Cost = Meters & { tokensIn: number; tokensOut: number; cacheRead: number; wallMs: number };
type Result = { rows: RowInput[]; spawn: JobSpec[]; refs: Ref[] };

type Ref = { t: 'commit'; sha: string } | { t: 'artifact'; digest: string; path: RepoPath };
type View =
  | { t: 'full' }
  | { t: 'blind'; allow: RowTag[]; files: RepoPath[] }
  | { t: 'none' };

type Row = { at: string; by: Author; key: RowKey } & (
  | { t: 'idea'; hypothesis: string; mechanism: string; prediction: Prediction[] }   // no family field
  | { t: 'measurement'; job: JobId; metrics: Record<string, number>; at: Ref; machine: string; cost: Cost }
  | { t: 'claim'; claim: ClaimKey; level: 'claimed' | 'candidate'; idea: RowKey | { t: 'none' };
      evidence: RowKey[]; at: Ref }
  | { t: 'verdict'; judge: JudgeId | { t: 'owner' }; job: JobId | { t: 'act' }; on: VerdictOn }
  | { t: 'integration'; claim: ClaimKey; outcome: { t: 'landed'; sha: string }
      | { t: 'conflict'; files: RepoPath[] } | { t: 'recheck-failed'; judge: JudgeId } }
  | { t: 'note'; text: string }
  | { t: 'amend'; change: Amendment }                        // owner only
  | { t: 'digest'; covers: RowKey[]; text: string }
  | { t: 'refused'; what: 'spawn' | 'row' | 'claim'; why: string; job: JobId });
type Prediction = { metric: string; value: number };        // [] for non-metric ideas
type VerdictOn =
  | { t: 'claim'; claim: ClaimKey; status: Status }
  | { t: 'idea'; idea: RowKey; outcome: { t: 'family'; family: Family } | { t: 'duplicate'; of: RowKey } };
type Status =
  | { t: 'verified' } | { t: 'refuted'; why: string } | { t: 'scoped'; why: string }
  | { t: 'unjudged'; why: 'judge-failed' | 'lost' | 'owner-timeout' }   // never a strike
  | { t: 'accepted' } | { t: 'rejected'; why: string };               // owner acts
type StatusTag = Status['t'];
type Amendment =
  | { t: 'rule'; text: string } | { t: 'budget'; add: Meters } | { t: 'deadline'; addHours: number }
  | { t: 'quota'; family: Family; quota: Quota };
type Author = { t: 'owner' } | { t: 'job'; job: JobId; seat: SeatId } | { t: 'host' };
type SeatId = { provider: string; model: string; lineage: JobId };   // lineage = root of fork/resume chain

type Expedition = {
  charter: Charter;
  jobs: Record<JobId, { spec: JobSpec; parent: JobId | 'charter' | 'owner' | 'engine'; state: JobState }>;
  ledger: Row[];
  held: Meters;
  plan: { lastFp: string | { t: 'never' }; lastAt: string | { t: 'never' } };
  state: ExpState;
};
type ExpState =
  | { t: 'draft'; issues: string[] }
  | { t: 'running'; launchedAt: string; deadline: string }
  | { t: 'paused'; launchedAt: string; deadline: string }
  | { t: 'draining'; reason: EndReason }
  | { t: 'finished'; reason: EndReason; at: string };
type EndReason = { t: 'done' } | { t: 'deadline' } | { t: 'budget'; overrun: Meters }
  | { t: 'stalled' } | { t: 'stopped'; by: 'owner' };
```

**Classes.** Work: `agent` and `command` jobs (and plans). Judgment: `judge`, `owner`,
`integrate`. Drain cancels pending work only; judgment keeps starting and running.

### Engine reactions (the whole "orchestrator")

Each runs inside the one serialized `commit()` (`server/src/expeditions/host.ts` pattern).

| # | When | Engine does |
|---|---|---|
| E1 | a `claim` row at `candidate`, or an `idea` row, is written | Find its binding by key prefix. Spawn the chain head, drawing from `held`. No binding: write `refused{claim}` and keep the claim at `claimed`. Candidates beyond `spec.emits.claims` (or ideas beyond `emits.ideas`) are refused the same way. |
| E2 | a judge job settles | Pass, not last: spawn the next judge from `held`. Last pass: `verdict{verified}` (idea: `family{f}` or `duplicate`). Fail: `verdict{refuted}`. **Judge job failed** (malformed, timeout, cannot_run) or lost: `verdict{unjudged{judge-failed|lost}}`, never a strike, never refuted. A chain that stops early releases the rest of its `held`. |
| E3 | `verdict{verified}` on a claim with a `commit` ref and `integrate.t = 'auto'` | Spawn an `integrate` job (judgment class, integrator pool, serial). It merges the claim sha onto the branch head in a detached checkout, **re-runs the claim's command and stat judges on the merged sha**, and fast-forwards only if the branch head is unchanged and every re-check passes. Writes `integration{landed|conflict|recheck-failed}`. On failure while running: spawns a `fix` agent spec (`session: resume` of the producer, same family, counted as a start). While draining or finished: the row stays for the owner's `integrate` act. |
| E4 | no plan in flight, some pool in `plan.fill` has pending + running < cap (below low water), the ledger fingerprint ≠ `plan.lastFp`, `minIntervalS` passed since `plan.lastAt`, and remaining ≥ a plan's reservation | Spawn one `plan` job (grant `plan.grant`). Its prompt asks it to fill each `fill` pool to `horizon × cap` pending specs in one turn. |
| E5 | nothing runs or waits, no plan in flight, and (remaining < a plan's reservation, or the last plan read the current fingerprint) | Drain: `budget`, else `stalled`. |
| E6 | Done holds, the deadline passes, or the owner stops | Drain: cancel pending work, keep judgment. |
| E7 | draining and nothing runs or waits | Finish. The report is a deterministic projection. |
| E8 | rows since the last digest exceed D (default 40) | Spawn one `synthesize` job on the cheapest agent pool. A digest may supersede only `note` and `measurement` rows in projections; **pinned** rows (refuted and unjudged claims with mechanism, verdicts, amendments, open owner questions, integration failures) always render verbatim. |
| E9 | every commit, after the above | **Prune and police.** (a) A pending work spec whose family quota is closed: `cancelled{quota}`. (b) If no job that can release budget is running (owner gates release nothing): every pending work spec that fails `reserve()`, and a pending plan, is `cancelled{budget}`. (c) spent + Σreserved + held > budget on any meter: drain `budget{overrun}`. Without (a)/(b) the run idles until the deadline (critique probe, Quint `rNoRunningWedge`). |

**Ledger fingerprint** = hash of the row keys the plan view projects. Every row changes it,
which is why E4 is rate-limited by low water and interval, not by the fingerprint alone.

**Reservations and overrun.** `reserve(spec)` = the spec's own ceiling on every meter + its
`emits` judgment (I12) + all pools free. An agent job's token ceiling is enforced on the usage
stream (provider-usage fold, `docs/turn-lifecycle.md#provider-usage`): when cumulative usage
reaches the reservation the host stops the turn with reason `reservation` (never `user_stop`),
and it settles `failed{reservation}`. Its wall ceiling is `max_runtime_timeout`. Usage arrives in
events, so a job can overshoot by at most one event (Δ: one response's output plus one tool
result). Commands are hard-capped by their own `--max-usd` and wall cap. Hence I1 is
overrun-bounded: spent + Σreserved + held ≤ budget + Δ × (jobs that overran), and the first
overrun past the budget drains `budget{overrun}` (E9c).

## 4. Goals, Invariants, Acts, Events, Open questions

### Goals

| ID | Goal | By |
|---|---|---|
| G1 | Every use case is a charter, not a feature | Recipes (`server/src/expeditions/recipes/*.ts`) emit `JobSpec[]`. The engine dispatches on `JobKind.t` (5 handlers) and `Row.t`. §6 shows all 9. |
| G2 | Parallel compute is used whenever a pool is free | `fill()` starts any pending spec whose `after` is settled, all of whose pools have capacity, and whose reservation fits. E4 refills `plan.fill` pools to a horizon. |
| G3 | Remote and local compute in one run | `Pool.host` (local GPU/CPU/lock), `Pool.remote{modal}`, `Pool.remote{ssh}`: the job ships `at` as a git bundle, runs under `nohup` with a pidfile journal, harvests `harvest` paths by scp and verifies their digests into the artifact store. ❌ Build the ssh launcher (`jobs/command.ts`). |
| G4 | Agents never wait on slow evaluations, yet tight inner loops stay in-turn | Slow evals (minutes+): the agent emits `command` specs and ends. Tight loops (seconds: guard suite, autoresearch-style runs): the job spec holds `[agent, host]` pools for the turn. Never a lease mid-turn (§12 MF5). |
| G5 | Test-time compute scales with difficulty | Plan brief carries the `effort` projection per family (attempts, first-try verify rate, strikes left, starts left, best-score slope, verified per 1k tokens per seat), the `residual` projection (prediction vs measurement per idea and family) and the `parents` projection (below). Grant caps width. |
| G6 | Ideas are never repeated | Exact idea key colliding with a refuted row: refused at the write path unless a `representationChange` note is cited. Near-duplicates: the `families.judged` binding's novelty judge (E1 on idea rows) returns `duplicate{of}`. |
| G7 | Briefs stay bounded and cache-friendly | Brief = byte-stable prefix [goal, amend rows of kind rule, role, recipe prompt] + `project(view)` ≤ 8k tokens (digest, pinned rows, best K, graveyard, open questions) + delta. |
| G8 | Judges are frozen and independent | `charter.hash` covers judges and bindings. Agent judge: provider ≠ producer's provider by default (`independence: 'model'` must be chosen explicitly) and `lineage` ≠ producer's lineage (no fork of the producer's session). Verdicts written only by E2 or owner acts. |
| G9 | Owner gates hold no slot and don't burn the deadline | `Pool.owner`: judgment class, cap ∞, cost 0. `expires` gives `unjudged{owner-timeout}`; `remindEveryH` re-notifies. |
| G10 | Deadline bounds work, not judgment | E6 cancels pending work; judges, owner jobs and integrations drain. Witness `wNoJudgeAfterDeadline` reached. |
| G11 | Survive backend restarts | Agent jobs: Buddy-run journals, adopted. Commands: journaled with `ExecRef` (local pid, Modal call id, ssh pidfile) and re-attached, not re-run (no double billing). A dead process: `lost`, reservation charged; re-spawn is a new attempt and counts as a start. A dead integration re-enters (idempotent by claim + merged sha). ❌ Stop discarding expedition turns (`server/src/lifecycle/shutdown.ts:110 discardCrewTurns`). |
| G12 | Knowledge lands in the repo's own owners | A `scribe` recipe job on the integrator pool exports pinned rows to charter-named files. Commands harvest outputs before the tree is released. |
| G13 | Steer mid-run | Owner acts (§4). Notes reach claude jobs mid-turn (`harness-steering.ts` `any-tool`), codex at the next Buddy tool call (`buddy-tool-only`). |
| G14 | Fixed-plan work runs with zero planning tokens | `plan: {t:'none'}`; `seeds` hold the whole DAG (case 7); workers get grant `leaf`. |
| G15 | Per-job token and $ accounting | `Cost` on every settled job from the provider-usage fold and remote scripts' typed results. ❌ Wire usage into the job record and the reservation kill. |
| G16 | Frontier search scales width without a wide planner | Deterministic `parents(family, k)`: top-K verified by score, weighted Shinka-style (rank fitness × 1/(1+children)). `population` recipe: one plan spawns a batch of K `evolve` children, each with a sub-grant, each staged through cheap → expensive chains. Start quotas let cheap stages spend wide while refutation quotas keep GPU falsifiers strict. |

### Invariants

| ID | Invariant | Guard |
|---|---|---|
| I1 | spent + Σreserved + held ≤ budget + Δ × overrunners, per meter; the first overrun drains `budget` | Quint `budgetBounded`; witness `wStrictBudget` shows the strict form breaks. ❌ Usage-stream kill test. |
| I2 | running per pool ≤ cap, counting a job in every pool it holds | Quint `poolCaps` (with a multi-pool job, witness `wNeverMultiPool`). Assertion in `fill()`. |
| I3 | A reservation exists only while running | Assertion in `settle()`; restart charges dead reservations. |
| I4 | No work job starts after the deadline or stop; judgment may | Assertion in `fill()`. Witness `wNoJudgeAfterDeadline`. ❌ Test. |
| I5 | A family's `starts` quota bounds starts; its `refutations` quota counts only `refuted`/`rejected` verdicts. `unjudged` never counts. | Quint `startsQuota`, `strikesAreRefutations` (mutant m5 breaks it). ❌ Test: a cannot_run judge does not strike. |
| I6 | Verdicts come only from E2 or owner acts; agent judge seat independent by provider and lineage | Write-path assertion: `verdict` rows from `Author.t = 'job'` are refused. ❌ Test on lineage. |
| I7 | Only verified claims integrate, one at a time; nothing lands without re-check on the merged sha | Quint `landedChecked` (mutant m7 breaks it); integrator pool cap 1. |
| I8 | A settled result is written once | `commit()` refuses a settle on a non-running job. |
| I9 | finished ⇒ nothing running or pending | Quint `finishedQuiet`. |
| I10 | finished with `done` ⇒ the Done predicate holds at finish | Quint `doneHonest`. |
| I11 | A finished run has no claim at `candidate` | Quint `rFinishedAllJudged` (critique probe 1; mutant m1 breaks it). |
| I12 | Judgment is always affordable: producers reserve `emits` judgment; excess candidates are refused; zero-cost judgment needs no budget | Quint `notStuck`, `rHeldReleased` (mutants m4, m10 break it). |
| I13 | A child grant ≤ its parent's; spawns refused unless running | ❌ Write-path assertion in `spawn()` + test. Witness `wNeverSpawnRefused` (drain refusal) reached. |
| I14 | A blind brief contains only allowlisted tags and files | ❌ Projection test. |
| I15 | Command judges run on the candidate sha (and on the merged sha at integration) with oracles from `charter.base` | Existing `checks.ts` detached checkout + oracle restore. ❌ Re-point at `Judge.command`. |
| I16 | Launch refuses if any command judge cannot run on base | Existing `ranOrNot` (`checks.ts:282`), at launch and at spawn of a `command` spec. |
| I17 | A running run never idles holding pending work it can never start | Quint `rNoRunningWedge` (critique probe 2; mutants m2, m9 break it). |
| I18 | At finish every verified claim has `landed` or a typed integration failure | Quint `rVerifiedIntegratedAtFinish` (critique probe 3; mutants m3, m6 break it). |
| I19 | Plan wakes ≤ 1 + elapsed / minInterval | Quint `planWakesBounded` (mutant m8 breaks it). |
| I20 | A digest never hides a pinned row | ❌ Projection test: a refuted row covered by a digest still renders. |

### Acts

| Act | Who | Requires | Otherwise |
|---|---|---|---|
| `launch` | owner | draft without issues; every judge preflights (I16); every seed claim pattern has a binding | refused with issues |
| `spawn` via `Result.spawn` | the job, within its grant | expedition `running`; grant count, pools, views; `guard` holds; family open; key not live | spec dropped, `refused{spawn}` row (fingerprint changes, the plan sees it) |
| `spawn` direct | owner | running | refused |
| write rows via `Result.rows` | the job | kinds for its JobKind (agent: idea, measurement, claim ≤ candidate, note; command: measurement); claims within `emits` | `refused{row|claim}` row; other rows still written |
| `verdict` | E2; owner acts | — | impossible by type for jobs |
| `answer` | owner | an owner job running | — |
| `accept` / `reject` / `scope` claim | owner | claim exists | — (a verdict row authored by the owner; latest wins) |
| `rejudge` | owner | claim `unjudged` | spawns its chain, reserving from remaining; refused if it does not fit |
| `integrate` | owner | claim verified with no `landed` row; any state but draft, **including finished** (re-opens to `draining`, reason kept) | refused |
| `note` | owner, any job | — | — |
| `amend` (rule, budget, deadline, quota) | owner | not finished | refused; budget/deadline/quota do not wake agents (`host_command`) |
| `plan now` | owner | running, no plan in flight | refused |
| `cancel` spec/job | owner | pending, or running (kills it) | — |
| `pause` / `resume` | owner | running / paused | refused |
| `stop` | owner | running or paused | refused |
| `amend judge` / bindings | owner | never while running | refused: stop and relaunch |
| `retire` | owner | finished | refused |

### Events (append-only; one idempotency key each)

| Event | Key | Wakes |
|---|---|---|
| `job.spawned` | `x:<id>:j:<key>:<attempt>` | scheduler |
| `job.started` / `job.settled` | `x:<id>:j:<job>:start|settle` | scheduler; E1–E5, E8, E9 |
| `row.appended` | `x:<id>:r:<rowkey>` | E1, E6, E8 |
| `owner.act` | `x:<id>:o:<postId>` | the act's handler |
| `owner.remind` | `x:<id>:remind:<job>:<n>` | owner notification |
| `deadline` | `x:<id>:deadline` | E6 |
| `restart.adopted` / `restart.lost` / `restart.reentered` | `x:<id>:boot:<bootId>:<job>` | scheduler |
| `usage.reservation` | `x:<id>:j:<job>:kill` | settle as `failed{reservation}` |
| `drained` / `finished` | `x:<id>:end:<n>` | report projection, owner notification |

### Open questions

1. Plan session: fork a frozen "charter-read" session every time (default) or resume one warm
   session (cheaper, accumulates context)?
2. Who adds a `Binding` for a new claim kind mid-run? Today only a relaunch. A census inventing
   claim kinds must map onto launch-time prefixes.
3. `stat` judges: host-generic paired-sign test, or always the repo's script
   (`rr/reports/tidewar-balance/compare.py`)? Default: the repo script with a typed schema.
4. Novelty: exact key plus a cheap judge, or embedding dedupe first (Shinka: >0.95 cosine, then
   an LLM; its ablation found the embedding step carries most of the gain)?
5. Is Δ (one usage event) small enough on codex, which reports usage per turn rather than per
   response? If not, codex pools need a lower reservation or a wall cap that binds first.
6. Emulated fork (codex, gemini: copy-and-resume, `vendor/agent-cli-tool/src/fork-emulation.ts`):
   does the provider's prefix cache hit on the copied session? §7 assumes no.
7. Should `held` be refunded when the owner stops? Judges still drain, so default no.

## 5. How work flows

**Runtime loop.** One serialized step per expedition: `commit(event) → apply → E1–E9 → fill()`.

`fill()` walks pending specs in spawn order and starts each whose `after` keys have settled, all
of whose pools have free capacity (and meet idle rules), and whose `reserve()` fits. Multi-pool
specs reserve all their pools at once or none: no job ever holds one pool while waiting for
another, so there is no deadlock.

Starting a job: **agent** = a Buddy run in a Cambium tree (`cambium.ts`, sanitized env), brief =
prefix + `project(view)` + delta; **command** = the pool's launcher (local detached checkout,
Modal, ssh), journaled with its `ExecRef`; **owner** = a thread post, no process.

Settling validates output against `SchemaId` (`malformed` is typed, never a regex), writes rows,
applies spawns, records `Cost`.

**Parallel and remote compute.** Parallelism is pool capacity: agent cap 4 runs 4 proposers,
`gpu-local` cap 1 runs the M4 scene, `modal` cap 6 runs six falsifiers, `ssh-box` cap 2 runs two
scenes on a remote GPU. Staged evaluation is a judge chain ordered cheap → expensive, so a
candidate failing stage 1 never reserves stage 3.

**Inner loops.** A job spec `pools: ['claude-opus', 'cpu-guard']` holds both for the turn: the
agent runs the 1.4–2.8 s suite dozens of times (case 8), or an autoresearch-style 5-minute loop
on `['claude-opus', 'gpu-local']` (`research/external.md` §2.1: "run an inner autoresearch loop
inside one attempt"). The GPU is idle while the agent thinks; that is the price of the tight
loop, and the spec chooses it explicitly.

**Scaling test-time compute.** The charter sets the ceiling (budget, grants, pool caps,
quotas). The plan job decides width from the effort projection and an explicit table: routine
(verify rate > 0.5) → 1 job, cheap seat; contested → 2–4 variants on 2 providers; frontier
(verify rate < 0.1, flat slope) → the `population` recipe: K `evolve` children, each seeded from
`parents(family, k)`, each with its own sub-grant (so width is not serialized through one
planner), each candidate staged through cheap judges first. A family with a closed quota gets
nothing (E9a prunes, the write path refuses).

**Knowledge accumulation.** Ideas carry typed predictions before measurements (`after` orders
them). The `residual` projection compares each idea's prediction with its measurement and
aggregates |error| per family, so "theory said 3×, measured 1.1×" is visible to the plan and to
the effort table. Projections: latest digest, pinned rows, K best per family, graveyard with
mechanisms, open owner questions, rules.

**Owner steering.** Owner posts are host-consumed acts (`host_command`, no double apply) or
notes (a ledger row; mid-turn on claude, next tool call on codex). A note changes the
fingerprint; E4 still waits for its interval unless the owner says `plan now`.

**Termination.** The run drains on done, deadline, budget (pruned or overrun), stalled or stop.
Draining cancels pending work, lets running work finish, keeps judgment running and starting
(judges from `held`, integrations and owner gates at zero cost). It finishes when nothing runs or
waits. Every claim then has a status, every verified claim an integration outcome (I11, I18). An
owner judge without expiry may hold `draining` indefinitely; it costs nothing, the rail shows
`awaiting owner (n)`, and `remindEveryH` re-notifies.

## 6. The nine use cases as charters

### 1. GTM market research

- **Pools:** `claude-sonnet` cap 6, `claude-opus` cap 1, `codex-high` cap 1, `owner`.
- **Plan:** `fill: ['claude-sonnet']`. The first plan spawns 30 `collect(org)` jobs (forked from
  one warm charter session; claude forks natively), per-platform `collect-reviews`, and
  `synthesize` (opus, `after:` all collect) which writes `claim{thesis/v1, candidate}`.
- **Bindings:** `thesis/*` → [`coverage` command, `source-audit` agent (codex: another
  provider), `owner`]; `counterexample/*` → [`source-audit`].
- **Duel as spec chains:** the duel recipe spawns `attack_1` (codex, grant `{spawn: 1, guard:
  newKeys('counterexample/')}`). An attack writes `claim{counterexample/…}` rows and may spawn
  `defend_k` (opus) only if it wrote a new counterexample key: the stop condition "attack found
  nothing new" is evaluated at the spawn write path. `defend_k` writes `claim{thesis/vk}` and
  spawns `attack_{k+1}`; grant decrement bounds rounds at 3. The best thesis is not picked by any
  agent: every `thesis/*` claim goes through its chain, and Done is
  `any(thesis/* at accepted)` over the versions, decided by the owner judge.
- **Owner gate:** the buyer test is the owner judge, judgment class, no slot (fixes the live
  `judging` record).
- **Weak:** source audit and "what customers won't admit" are LLM judgment; the kernel only
  routes them to another provider and the owner.

### 2. Game design (Tidewar)

- **Pools:** `compile` (host lock, cap 1), `cpu` (host, cap 4, `loadBelow 40`), `claude` cap 3,
  `codex` cap 1, `owner`.
- **Families:** `judged` (a haiku novelty judge on `idea/*` assigns `lever/<name>`). Quotas:
  `lever/*` = refutations 2.
- **Seeds:** (1) `instrument` agent job + claim `measuring-stick-valid` bound to a `stat` judge
  (48 seeds not collapsed, mirror unbiased); (2) `exploit-hunt` on codex in parallel.
- **Experiments:** each `experiment(lever)` agent job edits in a Cambium tree, writes its idea
  and prediction, and ends with `claim{lever/L, candidate, at: sha}`. Its chain: `build`
  (command on `compile`), `matches` (command, `keel_cli tidewar --seeds 1..48 --mirror` on
  `cpu`), `stat` (paired sign test in the repo's `compare.py`). The build is a judge, not an
  in-turn step: an 8-minute cap-1 lock held for a whole agent turn would serialize every
  experiment's thinking. A build failure is `refuted{build}` with the log tail; the plan spawns a
  `resume` continuation of that session (warm cache, so the "cold start" is a cache read).
- **Stacking** is its own claim `stack/{L1,L2}` with its own measurement.
- **Rulings** ("flagship stays shielded") are `amend{rule}` rows, and the binding for `idea/*`
  includes an agent judge that refuses ideas bending a rule.
- **Weak:** shared-box load stalls `loadBelow` timing; the compile lock is the ceiling; the kernel
  stops paying for dead levers but cannot make 38 agents useful when 1 lever survives.

### 3. wave_sim speed and accuracy

- **Pools:** `gpu-local` (M4, cap 1), `ssh-gpu` (`remote{ssh}`, cap 2: the stated multi-machine
  requirement), `modal` (cap 6, `usd: 60`), `cpu` cap 4, `claude-opus` cap 2, `codex` cap 2,
  `claude-haiku` cap 2 (novelty, synthesis; not in `plan.fill`).
- **Families:** `judged` by a haiku novelty binding on `idea/*` that returns `family{f}` or
  `duplicate`. The proposer writes an idea with no family field; a candidate's family is its
  cited idea's verdict. A "sidecar" relabel is now a different idea that the novelty judge maps
  back to the same family. Quotas per family: refutations 2 (strict on GPU falsifiers), starts 12
  (wide on cheap stages).
- **Bindings:** `speedup/*` → [`R-gates` command on `cpu`, `matched-error` on `modal` or
  `ssh-gpu` (ABBA timing), blind `audit` agent judge if > 10×, `owner`]. The owner judge has
  `expires: 48 h` → `unjudged{owner-timeout}`, so the run can finish.
- **Done:** `open`. **Plan:** `fill: ['claude-opus', 'codex']`, horizon 2: each plan queues up to
  8 proposals; ≤ 1 plan per 5 min.
- **Theory vs measurement:** every idea predicts its speedup and error; the `residual`
  projection shows which families' theory is trustworthy.
- **Weak:** Modal's 158 s setup dominates cheap evals (exposed in `Cost.wallMs`, not fixed).

### 4. Frontier math to algorithms

- **Views:** `blind{allow: [problem, hardware, refuted-mechanism], files: [MINIMAL_PROBLEM.md]}`
  for discovery; `full` for the census.
- **Seeds:** `N00-A/B`, `S00-A/B` on four providers, `blind`, grant `leaf`. A `census` job
  (`after:` all four, `emits.claims: 8`) clusters and writes up to 8 candidates; each gets
  [`math-audit` agent (provider ≠ producer, lineage ≠ producer), `falsify` command on Modal,
  `owner`]. A 9th candidate is refused, not silently unjudged.
- **Evolve:** a candidate worth search becomes an `evolve` job on `['claude-opus', 'gpu-local']`
  running OpenEvolve/Shinka inside the turn against the frozen falsifier.
- **Stop:** family `frontier` refutations 2.
- **Weak:** novelty and fair baselines are judgment; GPU-hour falsifiers keep width small by
  budget.

### 5. New capabilities (forces, wind, movable rocks)

- **Seeds:** one `cell(row, engine)` per (R6/R7/R9 × E/A), family `row×engine` (seeded), quota
  refutations 2. Each cell spawns its own `resume` continuation after a verdict (`after`), and
  after strike 1 the continuation's `after` includes a `failure-class` agent job.
- **Done:** `all(R6, R7, R9 each = any(cell/R/E at [verified, accepted], cell/R/A at [verified,
  accepted]))`: every row on at least one engine.
- **Weak:** per-cell progress is the agent's skill; the kernel adds strikes, frozen thresholds
  and parallel cells.

### 6. Deslop (buddies)

- **Seeds:** `measure` command; `target` agent job (opus) whose output spawns a slice DAG with
  file fences (`tree: cambium`, `after` for seams).
- **Bindings:** `slice/*` → [typecheck + tests in a detached checkout of the slice sha, line
  delta, screenshots `--baseline`, `retired-old-path` agent judge].
- **Integration:** E3 merges each verified slice onto the branch head and re-runs typecheck and
  tests **on the merged sha** before fast-forward. Two slices that each pass alone but break
  together fail `recheck-failed` and spawn a fix, which is exactly the 48724f4 class.
- **Weak:** reaching 3–4× is planning quality; the kernel guarantees honest deltas.

### 7. CRUD SaaS

- **Charter:** `plan: none`; seeds = the full DAG (schema → API → UI → e2e); workers grant
  `leaf`, cheap seats. **Bindings:** tests, typecheck, e2e; owner walkthrough last.
- **Weak:** a Workflows script would do; the kernel adds durability and re-checked integration.

### 8. Geometry engine

- **Pools:** `cpu-guard` (host, cap 2), `claude-opus` cap 1, `codex-high` cap 1, `owner`.
- **Seed:** `derive-and-build`, pools `['claude-opus', 'cpu-guard']`: the agent runs the guard
  suite inside its turn while holding the guard slot (I2 holds in reality, not just in the
  model). Emits `claim{g0, candidate, at: sha}`.
- **Bindings:** `g0` → [boundary suite (command, detached checkout, oracle restored), volume
  check, codex reviewer, owner].
- **"Exactly one replay":** family `g0-replay` with quota `starts 1`; a second replay spec is
  pruned `cancelled{quota}` at once (E9a), and a `lost` replay is charged, never silently re-run.
- **Integration:** a verified candidate whose integration failed, or was not reached before
  finish, is integrated later by the owner's `integrate` act on the finished record (I18).
- **Weak:** reflection and math design are the agent's.

### 9. Document model

- **Pools:** `claude-opus`, `codex-high`, `gemini`, `owner`.
- **Seeds:** `propose(model)`; the duel recipe (`critique` on another provider, view = A94 ledger,
  G01–G12, Z1–Z11); `adjudicate` on a third provider writing `claim{model/vN}`.
- **Bindings:** `req/*` → [agent judge returning `verified`, `scoped{why}` or `refuted`];
  `model/*` and `retirement-plan` → [owner]. Owner questions are owner jobs; answers are
  `amend{rule}` rows.
- **Done:** `all(model/* at [accepted], retirement-plan at [accepted], req/A1..A94 each at
  [verified, scoped])`. A model without a retirement plan cannot finish `done`.
- **Weak:** owner latency dominates; waiting costs nothing.

**Fit.** Strongest where cheap verifiers exist: 2, 3, 5, 6, 7, 8. Adequate where judgment
dominates: 1, 9. Weakest: 4.

## 6A. Scaling example

This section applies the width rule in `research/scaling.md` §4 to this design. It is lettered
6A so §7–§12 keep their numbers. **(m)** marks a measured number from `research/use-cases.md`.
**(e)** marks an estimate from §7. A derived number names its inputs.

### Who decides width

| Layer | Decides | Enforced by |
|---|---|---|
| Charter (owner, at launch) | ceilings: `Pool.cap`, `Grant.spawn`, `quotas`, `budget` | host: I2 in `fill()`, I5, I1; I13 is ❌ |
| `fill()` | starts every pending spec whose pools are free and whose reservation fits | host formula (G2) |
| `plan` job (E4) | how many specs to queue, up to `horizon × cap` per `plan.fill` pool, using the §5 width table | LLM judgment, rate-limited by `minIntervalS` (I19) |
| `population` recipe | K `evolve` children with sub-grants (G16) | LLM picks K; the grant caps it |

The ceiling is host-enforced. The actual width is LLM judgment. The default pushes wide: E4 wakes
the plan whenever a fill pool is below cap, so narrowing means the plan under-fills on purpose,
and it is woken again after the next interval. Caps cannot change mid-run: `Amendment` is
`rule | budget | deadline | quota`, with no pool cap. Mid-run, width moves only through quotas
(E9a), budget pruning (E9b), plan under-fill and the owner's `cancel`.

### Rule map

| # | Rule (`scaling.md` §4) | Mechanism in V3 | Who |
|---|---|---|---|
| 1 | Wide only on decomposable work; sequential chains at width 1 | `JobSpec.after` chains; `plan: none` + `seeds` for a fixed DAG (G14); the §5 table sends "routine" work to 1 job. ❌ Decomposability is not typed: nothing but pool caps stops a plan fanning out a sequential chain. Needs a per-family or per-recipe width bound in the charter. | LLM within host caps |
| 2 | Never wide without a central verifier | E1 refuses a candidate with no binding; `launch` refuses seed claim patterns without one; verdicts come only from E2 or owner acts (I6); only verified claims integrate (I7); `parents(family, k)` draws only verified claims (G16). ❌ Agent-written `measurement`, `idea` and `note` rows reach projections unverified; no projection marks or filters them by `Author`. | Host |
| 3 | Coordinate centrally, preassign, rebalance stragglers | One top-level plan in flight (E4; §12 "Not changed"). No act lets one job address another. `fill()` hands the next pending spec to any freed slot, so work is pulled per spec. ❌ No straggler policy: a slow job keeps its slot until its own wall cap (`max_runtime_timeout`) or an owner `cancel`. Needs a relative-runtime rule (for example, re-spawn at k× the family's median wall time). | Host pulls; owner handles stragglers |
| 4 | Share selectively through one deduplicated store; no peer messages | The Ledger is the only shared memory (§1). Exact-key refusal plus the novelty judge's `duplicate{of}` (G6). Briefs are a bounded `project(view)` of ≤ 8k tokens (G7). The graveyard is pinned (E8; I20 test ❌). `blind` views (I14 test ❌). ❌ The *selective* part is not host-enforced for agent-written `measurement`, `idea` and `note` rows: they reach briefs unverified (same gap as rule 2). | Host for one store, dedup and brief size; selection ❌ |
| 5 | If one agent already succeeds ~45%+ of the time, do not add agents | The effort projection carries the first-try verify rate (G5). The §5 table: verify rate > 0.5 → 1 job. ❌ Not host-enforced. The 0.45–0.5 band lands in "contested → 2–4 variants", the opposite of rule 5. ❌ The default is wide, not neutral: E4 refills any `plan.fill` pool below cap, so staying at 1 job means the plan under-fills on purpose, and it is woken again every `minIntervalS`. Needs the host to cap a family's width from its verify rate. | LLM, against a wide default |
| 6 | Width is earned from the verifier | Judge chains run cheap → expensive (§5). Judge kinds are typed (`command`/`stat` vs `agent`/`owner`). Start quotas spend wide on cheap stages; refutation quotas stay strict (G16). ❌ Nothing derives width from a chain's kind or speed; the owner sets caps once, at launch. | Owner at launch, LLM after |
| 7 | Budget against measured speedup; narrow when tokens per verified result stop improving | The effort projection includes "verified per 1k tokens per seat" (G5); `Cost` on every settled job. ❌ `Cost` is not wired (G15), so the column is empty today. ❌ No host rule narrows on it, and there is no serial baseline to measure speedup against. ❌ The default is wide: narrowing means the plan deliberately under-fills a pool that E4 keeps asking it to refill. Of the four designs this is the worst default for rules 5 and 7. | LLM, against a wide default; metric unbuilt |

### Worked example A, wide: case 3 wave_sim (§6 case 3 charter)

1. **Launch and the central verifier.** I16 preflights every command judge on `charter.base`. The
   verifier is the `speedup/*` binding: `R-gates` (command, `cpu`) → `matched-error` (ABBA timing)
   → blind `audit` agent if > 10× → `owner` with `expires: 48 h`. R-gates are exact numeric checks
   (m): hydrostatic error < 1%, sloshing period ±2%, solitary celerity ±3%, dam front ±5%. ABBA is
   required because a noisy baseline once gave a false 0.842× (m).
2. **Theory vs measured.** Each idea row carries `Prediction[]` (speedup and error) before its
   measurement exists (`after` orders them). The `residual` projection shows, per family, whether
   theory tracks the measurement ("theory said 3×, measured 1.1×", §5).
3. **Initial width.** `plan.fill` = `claude-opus` (cap 2) + `codex` (cap 2), horizon 2, so the first
   plan queues ≤ 8 specs and 4 run. Evaluation width is separate and wider: `modal` 6, `ssh-gpu` 2,
   `gpu-local` 1, `cpu` 4. E1 spawns judges from `held`, not the plan, so evaluation fans out with
   zero planner tokens.
4. **Local vs remote.** `gpu-local` (M4, cap 1) fits long scenes (m: ridge scene at 225 ms/step,
   ~10.5 min; the v4 arm at 622 ms/step, ~29 min) and in-turn loops on `[agent, gpu-local]` (G4).
   Modal fits parallel falsifiers, not cheap evals: one smoke took 157.8 s, of which 1.1 s was
   compute (m). `ssh-gpu` is the multi-machine pool; its launcher is ❌ (G3), and wave_sim documents
   no SSH pool today. ❌ `Judge.pool` is one `PoolId`, so "matched-error on modal or ssh-gpu" needs
   two judge ids split by binding prefix. A judge cannot take the first free of several pools.
5. **Sharing.** Proposers write `idea` rows with no family. The haiku novelty binding returns
   `family{f}` or `duplicate{of}` (G6, MF8), so a relabelled "sidecar" maps back to its family and
   its strikes. Each `measurement` row carries `at: Ref`, `machine` and `Cost`. The graveyard is
   pinned. No job messages another; the next brief is a projection of the Ledger.
6. **Grow.** When a family's verify rate is < 0.1 with a flat slope, the plan switches it to
   `population`: K `evolve` children seeded from `parents(family, k)`, each with a sub-grant (G16).
   Growth stops at pool caps. `amend{budget}` adds money, not slots.
7. **Shrink.** Two refutations close a family (`refutations 2`); so does its 12th start
   (`starts 12`). E9a then cancels its pending specs at once. Dropping families whose verified per
   1k tokens falls is plan judgment (rule 7 row).
8. **Stragglers.** A freed Modal slot takes the next pending judge in spawn order. A 29-minute M4
   arm holds `gpu-local` alone, and nothing reroutes it (rule 3 ❌).
9. **Cost shape (e, §7).** 50 experiments ≈ 1.3M tokens, about 26k per experiment (derived),
   against ~7.5M for one naive session; wall ≈ 2 h against ≈ 12 h. Tokens per verified result =
   1.3M ÷ V, where V is unknown until G15 records `Cost`. Dollars: a DualSPHysics hydrostatic 2 s
   run costs $0.019–0.062 (m, R11). A Modal smoke took 157.8 s in total, of which 38.5 s was
   dependency install, 15.1 s CUDA compile and 1.1 s compute (m); the rest is not itemised. Fixed
   overhead, not compute, dominates a short eval.

### Worked example B, narrow then widen: case 8 geometry kernel (§6 case 8 charter)

1. **Start narrow.** One seed, `derive-and-build`, on `[claude-opus, cpu-guard]`. `claude-opus`
   cap 1 and `codex-high` cap 1 allow at most 2 agents. The work is a derivation (for example the
   bore-cap refusal at r > √(3.75²−2²)−2.5), sequential under rule 1. The charter lists seeds and
   no plan rule, so width is the seed set and its grants.
2. **Exact vs judgment.** The boundary suite is exact and fast (m: G1's validator ran 65 checks in
   2.776 s; G0 hit 270,024,704 B against the 268,435,456 B cap after 1.42 s). The volume check is
   exact. The codex reviewer and the owner are judgment. The derived refusal conditions have no
   exact check until someone writes them as known-answer cases.
3. **Invest in the verifier first.** Judges are frozen while running (`amend judge` is refused;
   Open question 2). So building the exact check is its own run: a seed writes the new
   known-answer cases as `claim{oracle/…}` bound to [reviewer, owner], like case 2's
   `measuring-stick-valid` seed. ❌ A verified oracle cannot become a `Judge` in the same run.
4. **The trigger to widen** is an owner act: relaunch with the accepted oracle as a `command`
   judge and higher `claude-opus` / `cpu-guard` caps. Then `population` with `evolve` children on
   `[claude-opus, cpu-guard]` satisfies rule 6. ❌ There is no mid-run widen: caps are not
   amendable, and no host rule fires on "the verifier is now exact".
5. **Scarce evals stay narrow by the host.** Family `g0-replay` has `starts 1`; E9a prunes a
   second replay, and a lost replay is charged, never silently re-run.
6. **Rule 5 (~45%).** The effort projection shows the first-try verify rate, and the §5 table says
   1 job above 0.5. But this charter has no plan job to read it, and the host does not enforce it
   (❌, rule map 5).
7. **Rule 7.** "Verified per 1k tokens per seat" exists as a projection, but `Cost` is unwired
   (G15 ❌). Narrowing on it is plan judgment, with no host trigger (❌).

### Mixed: case 1 GTM (§6 case 1 charter)

Wide collection: the first plan spawns 30 `collect(org)` jobs on `claude-sonnet` (cap 6), forked
from one warm session. Narrow synthesis: one `synthesize` on `claude-opus` (cap 1), `after:` every
collect. Narrow duel: attack/defend chains capped at 3 rounds by grant decrement and
`newKeys('counterexample/')`. One store: collect rows land in the Ledger, and only `thesis/*`
claims pass the central chain [coverage, source-audit on codex, owner]. The collect rows
themselves are unverified (rule 2 ❌).

### Verdict

- **Scales well** where a `command` or `stat` verifier exists (cases 2, 3, 7). Rule 2, most of 3
  and the one-store part of 4 are host-enforced through bindings, the `fill()` pull and the
  Ledger. Working evaluation width today is Modal 6 + `gpu-local` 1, and it costs no planner
  tokens. The charter's `ssh-gpu` 2 is not usable until its launcher is built (G3 ❌).
- **Caps out on three ceilings.** (1) Pool caps are frozen at launch. In case 3 the binding agent
  ceiling is the `plan.fill` concurrency: `claude-opus` 2 + `codex` 2 = 4 proposers running at
  once. The plan rate (≤ 12 plans per hour at `minIntervalS` 300 s, × 8 specs = ≤ 96 specs per
  hour; derived from the charter, not measured) is a loose bound on queueing, and E4 fires only below low water, so it rarely
  binds. `population` sub-grants can add children, still within pool caps. (2) The local GPU is
  cap 1. (3) The ssh launcher is ❌ (G3).
- **The default pushes wide.** E4 refills every fill pool below cap, so narrowing (rules 5, 7)
  needs the plan to under-fill deliberately, every `minIntervalS`.
- **Rules 5–7 live in a plan prompt**, read off an effort projection whose cost column is unwired
  (G15 ❌). Width tracks the verifier only as well as the plan LLM reads that table.
- **Smallest change that raises the ceiling (a proposal, not in the design):** wire G15 `Cost`,
  and add one `Amendment` variant that sets a pool's cap mid-run (I2 still checks it). Case 8
  could then widen without a relaunch, and case 3 could narrow when tokens per verified result
  flatten.

## 7. Token and wall-clock economics

Tokens go to agent inputs (cached prefix + ≤ 8k projection + delta), agent outputs, agent judges,
and plan/synthesize jobs. Zero LLM tokens: scheduler, reservations, quotas, pruning, command and
stat judges, integration and its re-check, projections, the report.

**Caching.** Prefixes are byte-stable per charter. Wide fan-outs fork one warm session on claude
(native fork). Codex and gemini forks are emulated by copy-and-resume
(`vendor/agent-cli-tool/src/fork-emulation.ts`); this table prices them as fresh (Open question
6). A harness with no fork starts fresh and its `Cost` shows it.

**Plan frequency.** E4 fires only below low water on `plan.fill` pools, at most once per
`minIntervalS`, and each plan fills to `horizon × cap`. Case 3: fill pools total cap 4, horizon
2 → ≤ 8 specs per plan → ~7 plans per 50 experiments, not one per settle.

Estimates relative to one naive long session (Sonnet-class pricing, cached input 0.1×,
quadratic history growth):

| Case | Naive single agent | V3 | Relative | Where |
|---|---|---|---|---|
| 3 (50 experiments, 8 h) | ~50 × 150k = 7.5M in; wall ≈ 12 h serial | 25 claude proposers × 12.5k effective + 25 codex × 35k (fresh) + 7 plans × 15k + 4 synth ≈ 1.3M; evals 0 tokens; wall ≈ runs / (6 Modal + 2 ssh + 1 local) ≈ 2 h | **~0.17× tokens, ~0.2× wall** | no waiting turns, bounded briefs, parallel GPUs |
| 2 (10 levers, 48 seeds) | ≈ 1.5M in; ≈ 2.2 h | 10 × 40k + instrument + exploit + 3 plans ≈ 0.6M; compile lock 10 × 8 min ≈ 1.4 h | **~0.4×, ~0.6×** | matches without agents; lock is the floor |
| 7 (20 features) | ≈ 3M in; 20 × 10 min | 20 × 35k forked ≈ 0.7M, 0 planning; 4-wide ≈ 50 min | **~0.25×, ~0.25×** | no history, parallel |

Frontier mode (case 4) costs *more* than naive by design (3–8×), bounded by budget and quotas.
All numbers are estimates until G15 records `Cost`.

## 8. Compared with Claude Code Workflows and oompa

| | Workflows | oompa | V3 |
|---|---|---|---|
| Unit | `agent()` call, schema-forced | worker cycle; text signals | Job, one `Result` schema |
| Plan | fixed JS at launch | self-claiming file queue | seeds + spawns within grants; a rate-limited plan job below low water |
| Fan-out / join | `parallel`, `pipeline` | N workers pull | pool capacity + `after`; multi-pool jobs |
| Durability | dies with the session | events on disk | journaled agents and commands, adoption, re-entrant integration |
| External waits | impossible | cycles poll | command jobs on host/remote pools |
| Judges | the script | reviewer model | frozen, hashed chains; typed statuses incl. `unjudged` |
| Budget | output-token ceiling | `max_resumes` | per-meter reservations, usage-stream kill, bounded overrun |
| Harnesses | Claude only | claude, codex, opencode | any Buddy harness per pool |

**Taken from Workflows:** schema-forced outputs; immutable calls reusable by key; `pipeline`
without a barrier; a hard budget. **From oompa:** worktree per code unit; separate reviewer
seat; serial merge with refresh-by-merge **and re-review** (`prior-art.md`: "held candidate
merges current integration HEAD … reruns review + gate"); agents act, the framework reacts;
events as truth; typed blocked holds. **Better than both:** no text protocol or self-claiming;
not fixed at launch; waits without holding a turn; independent frozen verdicts; a typed ledger
with dedupe and quotas; width as a bounded dial.

## 9. Implementation sketch (buddies)

**Reused:**

| Machinery | Where | Role |
|---|---|---|
| Record + serialized step + `commit()` | `server/src/expeditions/record.ts`, `host.ts` | record; E1–E9 inside `commit` |
| Sum-type dispatch, ACTS table | `shared/src/expedition.ts`, `host.ts` | JobKind/JobState/Row handlers; Acts |
| Cambium tree per code job | `server/src/expeditions/cambium.ts` | `tree: cambium` |
| Detached checkout, oracle restore, `ranOrNot` | `server/src/expeditions/checks.ts` (`ranOrNot` :282, `CHECK_TIMEOUT_MS` :202) | command jobs, judges, integration re-check |
| Execution journals, adoption | `server/src/lifecycle/adopt-executions.ts` | agent jobs; ❌ stop `discardCrewTurns` (`shutdown.ts:110`) |
| Harness steering | `server/src/buddies/harness-steering.ts` | notes mid-turn |
| Fork / emulated fork | `vendor/agent-cli-tool/src/session.ts`, `fork-emulation.ts` | `Session.fork`, `Pool.agent.fork` |
| Provider usage fold | `docs/turn-lifecycle.md#provider-usage` | `Cost`, reservation kill (❌ wire) |
| Lease ≠ deadline | `docs/patterns.md#lease-heartbeat` | a job's wall cap is its own |

**Measured today** (`wc -l`, 2026-11-09): `server/src/expeditions/*.ts` 2,038; `shared/src/
expedition.ts` 311; `client/src/components/buddies/Expedition*.tsx` 982; tests 583.

**Target** (server + shared, excluding tests and client): **≤ 2,900 lines**, i.e. +550 over
today's 2,349, not "the same size" as revision 1 claimed:

| File | Lines | What |
|---|---|---|
| `shared/src/expedition-v3.ts` | 450 | types, Zod, ACTS |
| `server/src/expeditions/engine.ts` | 550 | E1–E9, `fill()` (multi-pool), reserve/settle, prune, drain |
| `server/src/expeditions/ledger.ts` | 400 | write-path checks, projections (pinned, effort, residual, parents), fingerprint |
| `server/src/expeditions/jobs/{agent,command,owner}.ts` | 550 | Buddy run + usage kill; local/Modal/ssh launchers + journals + harvest; owner post + reminders |
| `server/src/expeditions/integrate.ts` | 180 | merge, re-check on merged sha, ff-only |
| `server/src/expeditions/recipes/*.ts` | 350 | plan, duel, census, population, evolve, synthesize, scribe, fix |
| routes, tool, retire, V1 read-only reader | 420 | V1 records stay readable as history (≤ 120 of these) |

**Deleted:** `host.ts` retry loop (`fill`/`startAttempt`/`finishIfDue`), `brief.ts` `lessonOf`,
the V1 `Done` union, `maxLive`/`maxAttempts`. The client is adapted, not budgeted here (❌).

Build order: (1) ledger and types; (2) engine + command jobs (case 8 end to end); (3) agent jobs
with adoption and the usage kill; (4) owner pool and acts; (5) integration with re-check;
(6) recipes; (7) remote pools (Modal, ssh).

## 10. Verification

Model: `docs/specs/expedition-v3.qnt` (revision 2). It covers 11 jobs and the recurring plan:
two producers (one with `maxClaims 2`, one whose second claim is refused), a multi-pool inner
job (`agent + gpu`), a replay command, three judges, an owner gate, three integrations; pools
agent 2, gpu 1, owner 99, integ 1; budget 8 with overrun Δ = 1 per agent job; family A
refutation quota 2, family R start quota 1; E4 (low water on the agent pool, fingerprint,
interval 5) and E5; E9 pruning; restart with adoption, loss and integration re-entry; Done =
`any(c1, all(c2, c3))`; the owner `integrate` act on a finished record.

`Q=/private/tmp/claude-501/-Users-nicholasbardy-git-buddies/7f8221f8-9cfa-4109-ae0f-8e52e6b36925/scratchpad/quint/node_modules/.bin/quint`
(0.33.1, rust backend). No JVM, so `quint verify` (Apalache) was **not** run: every result
below is random simulation, not exhaustive. Run from `docs/specs/`.

| Command | Result |
|---|---|
| `$Q typecheck expedition-v3.qnt` | pass |
| `$Q run expedition-v3.qnt --invariant=<I> --max-samples=3000 --max-steps=40` for each of `budgetBounded`, `poolCaps`, `finishedQuiet`, `doneHonest`, `rFinishedAllJudged`, `rNoRunningWedge`, `rVerifiedIntegratedAtFinish`, `rHeldReleased`, `strikesAreRefutations`, `startsQuota`, `landedChecked`, `notStuck`, `planWakesBounded` | no violation for each (traces avg 16–18 steps, max 41) |
| `… --invariant=safety --max-samples=3000 --max-steps=40` | no violation |
| `… --invariant=safety --max-samples=30000 --max-steps=60` | no violation (avg 17.3, max 61) |

**Non-vacuity witnesses** (each expected violated; all were at 3000/40 unless noted):

| Witness | Reached state | Seed |
|---|---|---|
| `wNeverVerified` / `wNeverRefuted` / `wNeverUnjudged` | a claim verified / refuted / unjudged | 0x3272207f83fab5ff / 0x43e609827533b2b / 0x832ecd23023ff546 |
| `wNeverExcessClaim` | a claim beyond maxClaims refused (`claimed`) | 0x9204887aa5e3cce8 |
| `wNeverTwoCandidates` | one producer, two judged claims | 0xe81b40b04fc023ad |
| `wNeverLanded` / `wNeverTwoLanded` | one / two integrations landed | 0x1d05485d208e064d / 0xb71c4902f0537ece |
| `wNeverIntegFailed` | integration failed (conflict or re-check) | 0xd807b652a9a2cea8 |
| `wNeverReintegrated` | owner `integrate` on a finished record | 0x50b9000583295df3 |
| `wNeverReEntered` | restart re-entered an integration | 0x2295fe8b132b6f04 |
| `wNeverFinishedDone` / `Deadline` / `Budget` / `Stalled` | each end reason reached | 0x3c6edc7dce0aa711 / 0x10d78eea7ea5b91f / 0x1223cd421d63dec3 / 0xc5923afdfcd2e2cd |
| `wNeverAdopted` / `wNeverLost` | restart adopted / lost a job | 0x8e210e40f31a6435 / 0x5dda931270ace39a |
| `wStrikeQuotaNeverClosed` | family A closed by two refutations | 0x6293ba441c08a8f5 |
| `wNeverPrunedQuota` / `wNeverPrunedBudget` | E9 cancelled for quota / budget | 0xb770bf064ef697f7 / 0x9178283641e4a471 |
| `wNeverSpawnRefused` | a spawn refused (drain or closed family) | 0xd61912e241998b57 |
| `wNoJudgeAfterDeadline` | a judge started after the deadline | 0xf5e5553248c150ae |
| `wOwnerBlocksWork` | owner gate and work ran together | 0xac4346ff4a8fd2d8 |
| `wNeverMultiPool` | the agent+gpu job ran | 0x818aae7f93a57298 |
| `wNeverOverrun` / `wStrictBudget` | an overrun; the strict I1 broken | 0xe91b41398aeed1a4 / 0xf9836d0f7818d881 |
| `wNeverHeld` | judgment held | 0xee4a409186123a8d |
| `wSinglePlan` | a second plan ran | 0x5e36513d2bb1ad11 |

**Mutation checks** (each mutant reverts one fix in a scratch copy,
`/private/tmp/claude-501/-Users-nicholasbardy-git-buddies/7f8221f8-9cfa-4109-ae0f-8e52e6b36925/scratchpad/mut/m<N>.qnt`; run with
`--max-samples=3000 --max-steps=40`). Each guard catches the regression it exists for, which is
the evidence that the invariants are not restating their guards:

| Mutant | Reverted fix | Invariant | Result |
|---|---|---|---|
| m1 | failed judge job leaves the claim at candidate (rev1) | `rFinishedAllJudged` | violated, 0xc01ed83da0408fda |
| m2 | no budget prune (rev1) | `rNoRunningWedge` | violated, 0xb96894ecbc6c8def |
| m9 | no quota prune | `rNoRunningWedge` | violated, 0xdcbb731f91f1f498 |
| m3 | dead integration is `lost`, not re-entered (rev1) | `rVerifiedIntegratedAtFinish` | violated, 0xcb38cdcbeee624b |
| m6 | integration is work class (drain cancels it, rev1) | `rVerifiedIntegratedAtFinish` | violated, 0x9d16ae4c8f5e04a7 |
| m4 | zero-cost judgment needs `remaining ≥ 0` | `notStuck` | violated, 0x36b9c2729ef8b1ce |
| m10 | `held` covers one judgment per producer (rev1) | `notStuck` (via `safety`) | violated, 0xd474a6e9354bc8c8 (safety), 0xcf3c59b7e15a5c41 (notStuck) |
| m5 | a failed judge job counts as a strike | `strikesAreRefutations` | violated, 0xec3319dd2d44b737 |
| m7 | land after merge without re-check | `landedChecked` | violated, 0x70d93b86314fec88 |
| m8 | E4 without the minimum interval | `planWakesBounded` | violated, 0xf0a41c131786c30e |

**Findings the simulator produced:**

1. **rev1, unaffordable judgment wedges drain** (seed 0x287581c0a591edc8). Fix: producers
   reserve judgment; candidates convert it to `held` (I12).
2. **rev1 → critique probes** (seeds 0x96c664cf36ac8874, 0xa488abb5063b34de,
   0xe9c7b722aee15a3b): failed judge job, budget/quota wedge, lost integration. Fixes: E2
   `unjudged`, E9 prune, integration judgment-class and re-entrant (I11, I17, I18).
3. **rev2, new: overrun wedges zero-cost judgment.** `notStuck` violated at seed
   0xdd3c4e2515d4c460: an agent overrun made `remaining` negative after the budget drain; the
   pending integration and owner gate (cost 0) failed `remaining ≥ 0` and drain never finished.
   Fix in the design: a job that reserves nothing is always affordable (§3 reservations; m4).
4. **Model vacuity fix (rev1):** a logical clock, so the deadline and stop do not drain every
   trace in 4 steps.
5. **rev2 model fix:** with `planWakesBounded` stated over the whole clock, the no-interval
   mutant still passed (the bound was slack). Restated over `planAt` with interval 5; m8 now
   violates it.

**Still not modeled** (❌, guarded by tests to write): grants and spawn trees (I13), views (I14),
digests and pins (I20), `after` joins, multiple meters (tokens vs $ are one meter here), judge
chains longer than one, seat lineage, owner expiry, ssh/Modal re-attach. Coverage is simulation
only; `quint verify` needs a JVM (❌ run it on a machine with one).

## 11. Self-critique log (revision 1)

**Round 1. "E4 is a leader in disguise, and quiescence planning starves the pools."** Revision 1
moved E4 from global quiescence to pool idleness. That over-corrected: cheap judge pools idle
almost always, so a plan followed nearly every settle. Revision 2 restricts E4 to `plan.fill`
pools, low water, horizon batching and a minimum interval (§12 MF9). On the leader charge, §1 now
says plainly that the plan job is the old leader made stateless.

**Round 2. "The Ledger is a junk drawer, and blind views contradict the graveyard."** Layered
dedupe and tag-level blind views stand. Revision 1's claim that family came from "the idea's key
prefix" was wrong (the proposer picks the key); revision 2 assigns family by verdict (§12 MF8).

## 12. Critique and revision (revision 2, 2026-11-09)

Scores received: coverage 5, simplicity 6, token efficiency 6, frontier scaling 4, owner control
6, Quint fidelity 4. Every item, and the response.

### Must fix

| # | Critique | Response |
|---|---|---|
| MF1 | A failed judge JOB leaves the claim at candidate forever (`rFinishedAllJudged` violated). | **Fixed.** E2: a failed or lost judge job writes `unjudged{judge-failed|lost}`, never `refuted`, never a strike. Owner `rejudge` act re-spawns the chain from remaining. No automatic retry: a retry would need a second `held` draw, and a broken judge usually fails twice. Model: three-way judge outcome; `rFinishedAllJudged` holds; mutant m1 violates it. |
| MF2 | Budget/quota wedge burns the deadline (`rNoRunningWedge` violated). | **Fixed.** E9 prunes in every commit: a quota-closed pending spec is cancelled at once; with nothing budget-live running, an unaffordable spec (or plan) is cancelled{budget}. E5 then drains `budget`. The "nothing running" condition matters: while a job runs, its settle may release budget, so earlier cancellation would be premature. Model: `react()` in every action; `rNoRunningWedge` holds; m2 and m9 violate it. |
| MF3 | Integration not durable; doc contradicts itself on case 8 (`rVerifiedIntegratedAtFinish` violated). | **Fixed.** Integration is judgment class (drains past the deadline, not cancelled by drain) and re-entrant on restart (idempotent by claim + merged sha; dead integration returns to pending). Verified-not-landed after finish: the owner `integrate` act re-opens the record to `draining`. Model: integ pool journaled with re-entry, `ownerReintegrate`; invariant holds; m3 and m6 violate it. |
| MF4 | Merge-refresh lands a sha nobody judged (48724f4 class). | **Fixed.** E3: merge onto the branch head, re-run the claim's command and stat judges on the merged sha, ff-only if the head is unchanged. Conflict or re-check failure is a typed `integration` row and spawns a `fix` spec while running. Agent judges are not re-run (cost); the re-check is the mechanical part. Model: `landedChecked`; m7 violates it. |
| MF5 | A job cannot hold two resources. | **Fixed with `JobSpec.pools: [PoolId, ...]`**, reserved all-or-nothing. Rejected the in-turn `acquire(pool)` lease: it adds hold-and-wait (an agent seat held while waiting on a lock), hides demand from `fill()`, and is a new concept. Case 2's compile step becomes a judge in the chain instead, so the lock is never held through thinking. Model: job 3 on `{agent, gpu}`; `poolCaps` counts it in both; witness `wNeverMultiPool` reached. |
| MF6 | Quota semantics wrong in doc and model. | **Fixed.** `quotas: Record<Family, Quota[]>`, `Quota = {counts: 'starts' | 'refutations'; max}`. Refutations increment on `refuted`/`rejected` verdicts of that family; starts on every start of that family (attempts included). `unjudged` and failed jobs never count. Model: family A refutations, family R starts; `strikesAreRefutations` (m5 violates), `startsQuota`. |
| MF7 | Charter missing bindings, families, quotas, whole budget, view/grant defaults; unbound claim undefined. | **Fixed.** Charter has `budget: Meters`, `bindings`, `families`, `quotas`, `quotaDefault`, `plan`; launch adds `full`/`none` views and the `leaf` grant explicitly and lists them in the draft. "count" is not a meter: count limits are quotas. A candidate with no binding is refused (`refused{claim}`, stays `claimed`), and launch refuses seeds whose claim patterns lack a binding. |
| MF8 | Novelty judge never spawned; proposer still picks the family. | **Fixed.** Bindings match `idea` rows too (E1). `Row.idea` has no family field; `families: judged` makes the novelty chain's verdict `family{f}` the only source; a claim's family is its cited idea's. Seeds may name families (owner-authored). |
| MF9 | E4 fires on nearly every settle. | **Fixed.** `PlanRule{fill, horizon, minIntervalS}`: only `fill` pools count, low water = pending + running < cap, each plan fills to horizon × cap, at most one plan per interval (default 300 s ≈ cache TTL). §7 now derives ~7 plans per 50 experiments from that rule. Model: E4 and E5 modeled (`planTick`, `planStart`, `planSettle`, `quiesce`); `planWakesBounded`; m8 violates it. |
| MF10 | Reservations unenforced; model hard-codes no overrun. | **Fixed.** Usage-stream kill at the reservation (`failed{reservation}`), `max_runtime_timeout` for wall, commands hard-capped. I1 restated as overrun-bounded; the first overrun past budget drains `budget{overrun}`. Model: `actual ∈ 0..cost+OVER` for agent jobs; `budgetBounded` holds; `wStrictBudget` shows the strict I1 fails. This surfaced finding 3 (zero-cost judgment wedged after an overrun), fixed. |
| MF11 | `held` covers one judgment per producer. | **Fixed.** `JobSpec.emits {claims, ideas}`; the start reserves emits × max chain cost; each candidate moves one chain into `held`; excess candidates are refused at the write path and stay `claimed`. Model: producer 1 emits 2, producer 2's second claim is refused; m10 (one judgment per producer) violates `notStuck`. |
| MF12 | Done cannot express OR or "scoped"; model's done is "integrated > 0". | **Fixed.** `Done = open | pred`, `Pred = all | any | claim{key, at: StatusTag[]}` with `scoped` as a status. Cases 5 and 9 written in it (§6). Model: Done = `any(c1, all(c2, c3))`; `doneHonest` checks it at finish. |

### Should fix

| # | Critique | Response |
|---|---|---|
| SF1 | Spawning during drain unspecified. | **Fixed.** Acts: spawn requires `running`; otherwise `refused{spawn}`. Model: plan spawns while draining are refused (`wNeverSpawnRefused` reached). |
| SF2 | Owner judge can hold drain forever untyped. | **Fixed.** `Judge.owner.expires` → `unjudged{owner-timeout}`; `remindEveryH`; event `owner.remind`. Default stays `never` only when the charter says so. |
| SF3 | Seat independence underspecified. | **Fixed.** `SeatId = {provider, model, lineage}`; agent judges default `independence: 'provider'` and forbid a shared lineage; `notSeatOf` removed. ❌ test. |
| SF4 | Lost commands double-run and double-bill. | **Fixed.** Commands journal an `ExecRef` (local pid, Modal call id, ssh pidfile) and are re-attached. Only a dead process is `lost`; a re-spawn is a new `attempt` (key includes it) and counts as a start, so "exactly one replay" cannot be exceeded by a restart. |
| SF5 | Digests can drop the graveyard. | **Fixed.** E8 pins refuted/unjudged claims, verdicts, amendments, open questions and integration failures; a digest supersedes only notes and measurements. I20 ❌ test. |
| SF6 | Duel recipe hand-waved. | **Fixed.** Concrete spec chains (case 1): rounds bounded by grant decrement; "attack found nothing new" is `Grant.guard: newKeys('counterexample/')` evaluated at the spawn write path; the best thesis is decided by each version's judge chain and Done, not by an agent. `verdict-request` deleted. Cost: one field on Grant. |
| SF7 | Case 3 needs local and remote machines; SSH ❌. | **Fixed in design.** `Launcher.ssh` (git bundle in, nohup + pidfile journal, scp harvest by digest). Build is ❌ in G3. |
| SF8 | Theory vs real results not compared. | **Fixed.** `Prediction[]` typed on ideas; `residual` projection per idea and family feeds the plan and effort tables. |
| SF9 | Frontier scaling narrow. | **Partly fixed.** `parents(family, k)` deterministic projection (Shinka-style weighting); `population` recipe spawns K `evolve` children with sub-grants, so width is not serialized through one planner; start vs refutation quotas per family. Kept: one *top-level* plan in flight (two concurrent planners would race for the same pool slots). |
| SF10 | Concept count understated. | **Fixed.** §2 states fifteen, and deletes `verdict.pass`, `Amendment` vs ruling (now one `amend` row), `notSeatOf`, `verdict-request`. |
| SF11 | Re-derivation honesty. | **Fixed.** §1 names what is re-derived (stateless leader, node kinds as recipes, versioned objective, budget) and what is new. "No leader" removed. |
| SF12 | Quint invariants restate guards; one integrate job; thin coverage. | **Fixed.** Guard mirrors (`noWorkAfterDeadline`, `quotaHolds`, `judgeIndependent`, `integrationSerial`, `everyCandidateJudged`, `resultsImmutable`) removed from the model; their guards are now write-path assertions or ❌ tests in §4. Outcome invariants replace them, three integrate jobs and a two-claim producer are modeled, and ten mutation checks show each invariant catches its regression. `quint verify` not run: no JVM (❌). Every witness is now reached at 3000/40; rev1 needed 30000/60 for two of them. |
| SF13 | Fork assumed for non-Claude pools. | **Fixed.** Checked: claude has native fork; codex and gemini have emulated copy-and-resume (`vendor/agent-cli-tool/src/fork-emulation.ts`); others none. `Pool.agent.fork` records it; §7 prices non-Claude forks as fresh (case 3 went from ~0.1× to ~0.17×). |
| SF14 | Line budget optimistic; deleted list incomplete. | **Fixed.** Measured today's sizes; target ≤ 2,900 server + shared lines (+550), including a ≤ 120-line V1 read-only reader; client adaptation listed as ❌, not hidden. |

### Not changed, with reasons

- **One top-level plan in flight** (SF9). Width comes from batch size (horizon) and from
  `population` sub-grants. Two concurrent top-level planners would read the same projection and
  fill the same slots twice.
- **No automatic judge retry** (MF1 offered it as an option). `unjudged` is typed, visible, not a
  strike, and the owner can `rejudge`. A retry would double the `held` reservation for every
  candidate to cover a rare case.
