# Expeditions V1: a leader running rounds of typed nodes

Status: superseded by the [keyed expedition system](keyed/v1/DESIGN.md); retained as historical design/research. Old host deleted 2026-11-11.

Status: **design only, nothing built.** Written 2026-11-09; **revision 2** the same day answers an
independent critique (§11). This is the owner's model from `docs/expeditions-leader-design.md`,
made precise and checked. It is not a redesign. It follows `docs/design-specs.md`. The
concurrent core is modelled in Quint in `docs/specs/expedition-v1.qnt` and simulated (§9).
Inputs:
- `docs/expeditions/research/use-cases.md` (the nine cases);
- `docs/expeditions/research/prior-art.md` (oompa, three expedition generations, Workflows,
  AI-OS);
- `docs/expeditions/research/external.md` (published systems).

## 1. Thesis

The design in one paragraph:
- **The leader.** An expedition is one durable record with a **leader** that owns the owner's
  goal. The leader wakes only on batched events and spends its own reserved budget for each wake.
- **The meta-plan and rounds.** The leader keeps a loose **meta-plan**: an ordered list of
  round intents. When a round starts, the leader writes it as a small **graph of typed nodes**
  (agent, fan, check, gate) plus **typed predictions** of what the round will show.
- **The host.** The host schedules those nodes against one **budget ledger** of money, scarce
  evaluations and compute pools. Every node reserves its cap when it starts, and paid or GPU
  compute is reachable only through the host (`run_eval`, check nodes), never from an agent's
  shell. Unstarted nodes can be patched by compare-and-swap. Running nodes can be steered or
  cancelled. Finished nodes are immutable and reusable by global ref. A **population** fan is
  refilled by the host from an archive without waking the leader.
- **Reflection.** When a round closes, the host (machine-checkable predictions) and an
  independent judge seat (the rest) **grade** it against its predictions. The leader then records
  one decision: continue, revise the next round, rewrite the meta-plan, propose a finish, or ask
  the owner (outer reflection). Two missed rounds in a row forbid "more of the same". While a round
  runs, the leader and the owner can patch, extend (a bounded number of times), steer, cancel or
  end it (inner reflection).
- **Two goals.** The owner's words are fixed. Objective v0 is signed with the charter. Later
  versions are the leader's hypotheses: additive changes apply at once, and anything else waits
  for the owner to ratify **that exact proposal** against **that exact version**.
- **Finishing.** Only the owner (on a proposal under the current objective), or the host (every
  check criterion of the current objective passing on **one** candidate sha, every charter gate
  answered, charter `finish: on_met`), can finish an expedition as met. The work deadline and the
  budget end it regardless of the objective. They stop work, not judgment. A closing report follows
  every finish.

Why this shape: across nine very different workloads, everything that varies is LLM judgment
about which graph to run next. Everything that must not vary is a small set of structural rules
that a host can enforce and a model checker can attack:
- budget,
- custody,
- gates,
- finish authority,
- objective fidelity,
- reflection,
- termination.

A fixed script cannot be patched while it runs, and a retry loop cannot express phases. A graph
whose node states only move forward, rewritten once per round, can do both, and its rules fit in
one Quint model.

## 2. Concepts

| # | Noun | One line |
|---|---|---|
| 1 | **Expedition** | One JSON record: charter, objective versions, meta-plans, rounds, judgments, ledger, phase. One write path. |
| 2 | **Charter** | The owner-signed fixed part: verbatim `userGoal`, objective v0, deadline, budget, pools, evaluators, limits, gates, seats, round limits, finish mode, family taxonomy. Only an owner amendment changes it. |
| 3 | **Objective** | Versioned criteria. v0 is in the charter; later versions are appended by diff rule or ratification. |
| 4 | **Leader** | The seat that plans and reflects. Asleep or awake; each wake is a reserved, bounded turn. |
| 5 | **Meta-plan** | A versioned, ordered list of round intents (prose). It always keeps the charter gates. |
| 6 | **Round** | One graph of nodes plus frozen predictions. Open, or closed with a host/judge grade and the leader's reflection. |
| 7 | **Node** | One unit of work or judgment, with forward-only state and a spec revision. Its output is an immutable **artifact**. |
| 8 | **Gate** | A question only the owner answers. It is a charter entry and a node kind, and it holds no slot, no round and (when parked) no deadline. |
| 9 | **Ledger** | Money (USD-equivalent), named scarce evaluations, pool slots. Spent plus reserved. |
| 10 | **Event** | What wakes the leader. Events are batched in an inbox. |
| 11 | **Judgment** | An append-only row that only a check, a judge seat or the owner writes: verified, verdict, score, audit hold, new family, representation change. Claims and verdicts are folds over these rows. |

Revision 2 replaced Finding-with-verdict by Judgment and deleted `duel`, `integrate`,
`Round.cap`, `ReadScope` and the leader-written `Versus`. It added `population` (a fan source,
not a kind), `run_eval` (an act, not a kind) and `parked` (a phase). **Honest count:** 11 nouns,
4 node kinds (was 6), and **37 named types** in §3.1, counted mechanically (`type X =` lines in
the block). Revision 1 had 32 by the same count while claiming "11 concepts". The net +5 is
Prediction and Grade (M5), Judgment (M7), FanSource and ParentPolicy (M8), the FamilyKey/RepKey
aliases and AgentTemplate, minus Versus, ReadScope and Finding. The named types, not the nouns,
are the build's real surface.

## 3. Spec

### 3.1 Types

These are written as the discriminated unions they become in Zod in `shared/src/expedition.ts`.
Here an optional field (`?`) appears only where absence is the meaning.

```ts
// ---------------- fixed: owner-signed at launch; changed only by an owner amendment
type Charter = {
  userGoal: Markdown;                    // verbatim, never edited, shown at every finish
  objective0: { criteria: Criterion[]; open: Question[] };  // v0: signed WITH the charter (I8a)
  finish: 'on_met' | 'run_to_deadline';  // run_to_deadline: a full pass is an event, not an end
  repo: { root: Path; baseRef: GitRef }; // launch base resolved as today (01acc16)
  deadline: { work: Hours; parkMax: Hours }; // work clock stops while parked; wall hard stop = work + parkMax
  rounds: { wallMax: Hours; extendsMax: number }; // a round closes at wallMax; extend_round <= extendsMax
  budget: Budget;
  pools: Pool[];                         // compute classes with concurrency caps
  evaluators: Evaluator[];               // the only commands a check or run_eval may run
  limits: Limit[];
  gates: GateSpec[];                     // every meta-plan keeps these (I6)
  seats: Record<SeatTier, Seat>;         // must include 'judge' (grades predictions, writes verdicts)
  families: Path;                        // the repo's own idea taxonomy (e.g. wave_sim KEY_LEARNINGS graveyard)
  integrate: { t: 'none' } | { t: 'branch'; name: string }; // main is never a target (owner lands it)
};
type SeatTier = string;                  // tier names are the owner's; the leader picks by name
type Seat = { provider: Provider; model?: string; effort?: string }; // absent = provider default (as today)
type Budget = {
  usd: Usd;                              // LLM usage (provider usage x catalog price) + paid compute
  closeReserve: Usd;                     // set aside for the closing report; never reservable by work
  evals: Record<EvalName, Scarcity>;     // e.g. "g0-replay": count 1
};
type Scarcity = { t: 'unlimited' } | { t: 'count'; n: number };
type Pool =
  | { t: 'slots'; name: PoolName; cap: number }                    // local-gpu 1, compile-lock 1, cpu 3
  | { t: 'paid'; name: PoolName; cap: number; usdCeiling: Usd };   // modal: N concurrent under $
  // ❌ { t: 'ssh'; host; cap } is not designed (case 3 "remote machines" is Modal only in V1)
type Evaluator = {
  name: EvalName; argv: Argv;            // run by the host in a detached checkout (checks.ts)
  digest: Sha256;                        // hash of argv files + oracle at sign time; a mismatch refuses the run (I12)
  pools: PoolName[];                     // reserved atomically, e.g. ['compile-lock', 'cpu']
  maxUsd: Usd;                           // reservation for a paid run (passed as --max-usd)
  oracle: Path[];                        // restored from base before running (today's `oracle`)
  report: { t: 'exit' } | { t: 'json'; schema: Schema }; // json carries usd, score, perInput, hold
  preflight: Argv;                       // must RUN at plan time, or plan_round is refused (I16)
};
// Every agent tree gets 'no-paid-credentials' and 'no-gpu' as enforced limits: paid and GPU
// compute go through run_eval, so the ledger and pools see every call (I3d).
type Limit = { t: 'enforced'; cap: 'no-paid-credentials' | 'no-gpu' | 'no-network' | 'read-only' }
           | { t: 'advisory'; text: string };
type GateSpec = { id: GateId; question: string; guards: 'finish' | 'land' | 'spend' };

// ---------------- the objective: v0 in the charter, then appended only
type Criterion =
  | { t: 'check'; id: CritId; eval: EvalName; pass: Predicate }   // machine-decidable
  | { t: 'judged'; id: CritId; rubric: Markdown; seat: SeatTier }  // judge seat; advisory to the owner
  | { t: 'owner'; id: CritId; question: string };
type ObjectiveVersion = {
  v: number; criteria: Criterion[]; open: Question[]; rationale: Markdown;
  basis:
    | { t: 'charter' }                                                    // v0
    | { t: 'additive'; over: number }                                     // superset: applied at once
    | { t: 'ratified'; over: number; proposal: RevisionId; at: Time };    // owner, CAS on (over, proposal)
};
type PendingRevision =                   // at most one; never overwritten (I8b)
  | { t: 'none' }
  | { t: 'awaiting'; id: RevisionId; base: number; proposal: ObjectiveVersion; label: string; evidence: Ref[] };

// ---------------- plan and rounds
type MetaPlan = { v: number; rounds: { intent: Markdown }[]; keeps: GateId[]; reason: Markdown; evidence: Ref[] };
type Prediction =                        // frozen at open; the leader never grades them
  | { t: 'check'; eval: EvalName; on: Ref; expect: Predicate }    // host grades from the report
  | { t: 'judged'; claim: Markdown };                             // the charter's judge seat grades
type Grade = { met: boolean; per: ({ t: 'host'; met: boolean; report: Ref }
                                  | { t: 'judge'; met: boolean; node: NodeId }
                                  | { t: 'unrun' })[] };          // unrun counts as missed
type Round = {
  n: number; intent: Markdown; predicts: Prediction[]; openedAt: Time; extends: number;
  nodes: NodeId[];
  state:
    | { t: 'open' }
    | { t: 'closed'; how: 'all_ended' | 'wall_cap' | 'ended_by_leader' | 'ended_by_owner';
        grade: Grade; carried: NodeId[]; reflection: Reflection }
    | { t: 'finished' };                 // closed by the expedition's finish: no grade, no reflection
};
type Reflection =                        // the leader's recorded decision after a graded round
  | { t: 'pending' }
  | { t: 'continue'; why: Markdown }
  | { t: 'revise_next'; why: Markdown }
  | { t: 'rewrite_meta'; plan: number; why: Markdown }              // structural
  | { t: 'propose_finish'; why: Markdown }                          // structural
  | { t: 'ask'; gate: NodeId; why: Markdown };                      // structural: raises an adhoc gate, asks to park

type NodeId = string;                    // global: "r2.n3"; refs cross rounds and plan rewrites
type Ref = { node: NodeId; path: string[] };   // [] = the whole output
type Node = { id: NodeId; rev: number; objV: number; carried: boolean; spec: NodeSpec; state: NodeState };
type NodeSpec =
  | { t: 'agent'; prompt: Markdown; inputs: Ref[]; seat: SeatTier; out: Schema; cap: Usd;
      pools: PoolName[]; tree: Tree; writes: Path[]; tests: FamilyKey[]; evals: EvalName[] } // evals: run_eval allowlist
  | { t: 'fan'; source: FanSource; template: AgentTemplate; maxPar: number }
  | { t: 'check'; eval: EvalName; on: Ref; tests: { t: 'criterion'; id: CritId } | { t: 'diagnostic' } }
  | { t: 'gate'; gate: GateId | { t: 'adhoc'; question: string } };
type AgentTemplate = Omit<Extract<NodeSpec, { t: 'agent' }>, 'inputs'>;
type FanSource =
  | { t: 'list'; over: Ref }                                       // over must be list-typed (I5)
  | { t: 'population'; archive: ArchiveId; parents: ParentPolicy; eval: EvalName;
      budget: Usd; plateau: number };                              // host-refilled; ends at budget or plateau
type ParentPolicy = { t: 'top_k'; k: number } | { t: 'weighted'; novelty: number }; // Shinka-style fitness x novelty
// A reduce (collapse/fold) is an agent whose inputs include a fan ref: it waits for every child.
// Integration is an agent whose tree is the integration branch; its check runs on the merged sha.
// An adversarial review is three agent nodes on distinct seats (I13); there is no duel kind.
type Tree =
  | { t: 'none' }
  | { t: 'cambium'; from: { t: 'base' } | { t: 'candidate'; ref: Ref } }
  | { t: 'scratch'; allow: Path[] };     // case 4 blind: copies of allowlisted files, no .git, no network, no findings
type NodeState =
  | { t: 'pending' }
  | { t: 'waiting' }                                       // gate asked; holds no slot, no budget, no round
  | { t: 'running'; requestId: string; startedRev: number; reserved: Spend; journal: Path;
      funded: { t: 'ledger' } | { t: 'carved'; from: NodeId } }   // run_eval / population child
  | { t: 'done'; out: Artifact; spent: Spend }             // immutable (I2)
  | { t: 'failed'; why: Failure; spent: Spend }
  | { t: 'cancelled'; by: 'leader' | 'owner' | 'host'; why: string; spent: Spend };
type Failure =
  | { t: 'capped' } | { t: 'malformed' } | { t: 'turn_failed'; detail: string }
  | { t: 'dead_on_adopt' }                                 // journal adopted, process gone
  | { t: 'blocked'; reason: string }                       // typed hold, never auto-resumed (L12)
  | { t: 'cannot_run'; detail: string };                   // check could not run: not a verdict
type Artifact = {                                          // written once at done; never changes
  digest: Sha256; store: Path;                             // repo's own artifact store, not a worktree
  summary: Markdown;                                       // at most ~2k tokens: what readers get by default
  value: Json;                                             // schema-validated output (no prose parsing, L1)
  candidate: { t: 'sha'; sha: Sha } | { t: 'none' };
  hypotheses: { family: FamilyKey; rep: RepKey; claim: Markdown; prediction: Markdown }[]; // no verdicts
};
type FamilyKey = string;                 // must exist in charter.families, or have a judge-accepted new_family
type RepKey = string;

// ---------------- judgments: append-only; agents never write them (I15)
type Judgment = {
  id: string; at: Time;
  by: { t: 'check'; node: NodeId } | { t: 'judge'; node: NodeId } | { t: 'owner' };
  subject: { t: 'artifact'; node: NodeId } | { t: 'hypothesis'; node: NodeId; i: number } | { t: 'family'; key: FamilyKey };
  says:
    | { t: 'verified' }                                    // check, or judge after an audit hold
    | { t: 'accepted' }                                    // owner only
    | { t: 'audit_hold'; why: string }                     // evaluator report (e.g. speedup > 10x)
    | { t: 'score'; archive: ArchiveId; value: number; perInput: number[] }   // check only
    | { t: 'verdict'; v: 'keep' | 'reject' | 'retune' | 'promote' | 'pivot' } // judge or owner
    | { t: 'new_family'; key: FamilyKey; near: FamilyKey[] }                 // judge or owner
    | { t: 'rep_change'; family: FamilyKey; from: RepKey; to: RepKey };      // judge or owner
};

// ---------------- the record
type Spend = { usd: Usd; evals: Record<EvalName, number> };
type Ledger = { spent: Spend; reserved: Spend; live: Record<PoolName, number> };
type LeaderState = { t: 'asleep' } | { t: 'awake'; wake: number; reserved: Usd };
type Phase =
  | { t: 'draft'; issues: string[] }
  | { t: 'live' } | { t: 'paused' }
  | { t: 'parked'; since: Time; gate: NodeId }             // work clock stopped; only owner acts move it
  | { t: 'finished'; reason: FinishReason; verdict: 'none' | 'accepted' | 'rejected';
      report: { t: 'pending' } | { t: 'written'; ref: Ref } | { t: 'failed'; detail: string } };
type FinishReason =
  | { t: 'met_checks'; objV: number; sha: Sha }            // host: every check criterion of objV on this sha
  | { t: 'met_owner'; objV: number }                       // owner accepted a proposal under objV
  | { t: 'deadline' } | { t: 'budget' } | { t: 'stopped' } | { t: 'setup_failed'; detail: string };
type Expedition = {
  charter: Charter; amendments: { at: Time; diff: Json }[];  // owner only: extend, gates, pools
  objectives: ObjectiveVersion[]; pending: PendingRevision;
  plans: MetaPlan[]; rounds: Round[]; judgments: Judgment[];
  answered: { gate: GateId; answer: Markdown; at: Time }[];
  finishProposal: { t: 'none' } | { t: 'proposed'; objV: number; summary: Markdown };
  ledger: Ledger; leader: LeaderState; inbox: Event[]; phase: Phase;
  clock: { work: Hours; wall: Hours };
};
```

### 3.2 Goals

| ID | Goal | By (mechanism) |
|---|---|---|
| G1 terminates, with a result | Every expedition stops working by the deadline, whatever the objective says, and ends with a result or a stated gap | `tick` finishes at the work deadline, and at the wall hard stop (`work + parkMax`) even while parked (Quint `terminates`, `hardStop`); `exhaust` on budget; `close_report` act paid from `closeReserve` (Quint `closeReport`, witness `w_noReport`) |
| G2 late binding | Round k's graph is chosen after rounds 1..k-1 ran and were reflected | `plan_round` requires every closed round reflected (Quint `reflected`) |
| G3 outer reflection | After a round the leader continues, revises, rewrites the meta-plan, proposes finish, or **asks** | `reflect` act; the host refuses `plan_round` until it is recorded; `ask` raises an adhoc gate and parks |
| G4 inner control | A running round can be patched, extended, steered, cancelled or ended | `patch` (CAS), `extend_round` (≤ `extendsMax`), `steer` (per-harness capability returned), `cancel`, `end_round` |
| G5 dynamic width | Fan-out width comes from runtime data | list fans name a list-typed output (I5); population fans are refilled by the host from the archive (`carve`) |
| G6 owner supreme | No leader act widens the charter; the owner can always interrupt | the act table (§3.4) is checked in one `valid()`; owner acts are host commands and never wait for the leader |
| G7 durable | A backend restart neither loses nor repeats work | running nodes are adopted from execution journals; a dead adopted process becomes `failed: dead_on_adopt` (Quint `restart`, witness `w_noDeadAdopted`) |
| G8 explainable | Every structural change has a recorded reason | plans, objectives, reflections and judgments are appended with reason and evidence refs |
| G9 fidelity | v0 is the owner's; every later version traces to it; weakening needs the owner, on the exact proposal | v0 in the charter (I8a); host diff classification; ratify is CAS on (base, proposal id) (I8, I8b) |
| G10 progress, not activity | Repeated misses force a structural change | the host/judge grades each round against its frozen predictions; two consecutive missed rounds since the last structural change refuse `continue`/`revise_next` (Quint `g10`, ablation A11) |
| G11 no repeated ideas | A rejected idea is not re-tested without an accepted representation change | `agent.tests` keys must be in the charter taxonomy; `plan_round` refuses a family with 2 `reject` verdicts unless a judge `rep_change` row exists (§4) |
| G12 independent judgment | No producer judges its own output | judgments are written only by checks, judge-seat nodes or the owner (I15); judge seat ≠ producer seat and ≠ leader seat (I13); checks run in a detached checkout of an immutable sha |
| G13 metered compute | Scarce evaluations, paid runs and GPU time are all reserved when spent | named `evals` counts and pools reserved at node start and per `run_eval` call (I3, I3d) |
| G14 cheap by default | The leader is rarely awake; nodes read summaries and refs | batched events (§3.5), a byte-stable brief prefix, 2k-token artifact summaries |
| G15 frontier throughput | A population keeps its pool busy without leader wakes | `fan{source: population}` refilled by the host (`carve`, witness `w_noPopulation`); the leader wakes on `plateau` |

### 3.3 Invariants

"Quint ✅" means the invariant held in the simulated traces of §9 and, where an ablation is
named, fails when its guard is removed. **"(restates guard)"** marks an invariant that copies the
guard it checks: it proves only that the ablation is caught, not an independent property. The
code guard is still to be built in every row, so each row also carries a ❌.

| ID | Invariant | Guard |
|---|---|---|
| I1 charter fixed | Only an owner amendment changes the charter (incl. objective v0, evaluator digests) | ❌ the record write path refuses a charter diff that is not an `amendments` entry |
| I2 done immutable | A done node's artifact never changes; claims and verdicts live in judgments, not in the artifact | Quint `doneImmutable` ✅; ❌ write-path assertion: artifacts are written once |
| I3 budget safe | `spent + reserved ≤ usd − closeReserve` until finish, `≤ usd` always; the same for every eval count | Quint `budgetSafe` ✅ (A1 violates it); ❌ ledger unit test + the kill-at-cap path |
| I3a ledger exact | Reserved equals the sum of running reservations plus the awake leader's wake; carving moves money between nodes, never mints it | Quint `ledgerExact` ✅; ❌ assertion in `ledger.ts` commit |
| I3b capacity | Live work/check nodes ≤ the pool caps; gates and populations never hold a slot | Quint `capacity` ✅; ❌ scheduler test |
| I3c cap margin | A node is killed when `usage + maxMessage > cap` | ❌ build: provider-usage fold per node; A1 finding |
| I3d no unmetered compute | An agent's process has no paid-compute credentials and no GPU device; its paid/GPU runs are `run_eval` children | Quint: `carve` keeps `ledgerExact` ✅ (structure only); ❌ env filter for agent turns (today only git's env is filtered, `cambium.ts` `gitEnv`) + a test that `MODAL_TOKEN_*` is absent in an agent shell |
| I4 patch CAS | A patch commits only if the node is still pending at the revision read | Quint `specFrozen` ✅ (A2 violates it); ❌ act test racing `patch` against `start` |
| I5 typed fan-out | A list fan whose `over` is not list-typed never enters a round | Quint `typedFanout` ✅; ❌ `plan_round` test |
| I6 gates kept | Every meta-plan keeps the charter gates; a host finish has every charter gate answered | Quint `gatesKept` ✅ (A6 violates the plan clause; the finish clause restates guard); ❌ act test |
| I7a met on one sha | A host `met` names one sha on which every check criterion of the **current** version passed, each by a check testing that criterion; no owner criterion; charter `finish: on_met` | Quint `metOneSha` ✅ (A4 stale-version and A8 any-pass ablations violate it); ❌ host test with criteria A, B passing on different shas |
| I7b owner met current | An owner `met` accepted a proposal written under the current objective version | Quint `ownerMetCurrent` ✅ (A12 violates it); ❌ act test |
| I8 objective fidelity | Each version is a superset of its predecessor, or owner-ratified against that exact predecessor | Quint `objectiveFidelity` ✅ (A3 violates it); ❌ act test |
| I8a v0 signed | Objective v0 carries owner authority | Quint `v0Signed` ✅ (structural: init only); ❌ `launch` refuses a charter without `objective0` |
| I8b ratified as seen | A ratified version is exactly the proposal the owner was shown; a pending revision is never overwritten | Quint `ratifiedAsSeen` ✅ (A7, the pre-review base-only ratify, violates it); ❌ act test: reject + re-propose, then a stale ratify |
| I9 terminates | `work ≥ deadline ⇒ finished`; `wall ≥ deadline + parkMax ⇒ finished` | Quint `terminates`, `hardStop` ✅ (A14 violates `hardStop`); ❌ host test with a fake clock |
| I10 work stops at finish | After finish, nothing pending, no work running, leader asleep; only checks, gate answers, the verdict and the report continue | Quint `noWorkAfterFinish`, `leaderBounded` ✅; ❌ host test |
| I11 no rerun | No node is started twice; restart adopts; a dead adopted process fails | Quint `noRerun` ✅ (structural in the model; A5 shows the guard); ❌ build: expedition nodes in `adopt-executions.ts` |
| I12 frozen yardstick | `Round.predicts` never changes after open; an evaluator runs only at its charter digest | ❌ write-path assertion + digest check in `checks.ts` |
| I13 seats distinct | A judge node's seat ≠ the producer's seat and ≠ the leader's; adversarial trios use three distinct seats | ❌ `plan_round` validation test |
| I14 write fences | Parallel agent nodes have disjoint `writes`; a candidate's diff stays inside its fence | ❌ plan-time check + `check` preflight on the diff |
| I15 no self-judgment | Judgments are written only by check nodes, judge-seat nodes or the owner; artifacts carry no verdicts | ❌ write-path assertion (judgments come from host code paths only; agents have no act that writes one) |
| I16 evaluator runs | Every evaluator a round uses passed its preflight at plan time | ❌ `plan_round` test (extends `checks.ts:282` `ranOrNot`) |
| I17 no dead gate | No node waits on a gate that is already answered | Quint `noDeadGate` ✅ (A9, the pre-review start, violates it); ❌ scheduler test |
| I18 gates hold no round | No uncarried pending node depends on a gate or on a carried node | Quint `gateFree` ✅ (A10 violates it); ❌ `plan_round` test |
| I19 rounds close | A round is never open past `rounds.wallMax`; `extend_round` ≤ `extendsMax` per round | Quint `roundBounded` ✅ (A13 violates it), `extendBounded` ✅ (restates guard); ❌ host test |
| I20 forced change | Every reflection after two consecutive missed rounds since the last structural change is structural | Quint `g10` ✅ (recomputed from history, not from the guard's counter; A11 violates it); ❌ act test |
| I21 reflection first | Never more rounds opened than reflected + 1 | Quint `reflected` ✅; ❌ act test |

### 3.4 Acts

The acts are checked in one `valid(expedition, act, who)` table, like today's `ALLOWED` in
`shared/src/expedition.ts`. Every refusal goes back to the actor with its reason; nothing is
silently dropped.

| Act | Who | Requires | Otherwise |
|---|---|---|---|
| `plan_round(intent, predicts, nodes)` | leader (awake) | no open round; **every closed round reflected**; graph type-checks (I5) and is acyclic; refs exist; gate dependents marked carried (I18); seats distinct (I13); fences disjoint (I14); evaluators preflighted at their digests (I12, I16); every `tests` key in the taxonomy or judge-accepted; no family with 2 `reject` verdicts without a `rep_change` judgment (G11); `evals` ⊆ charter evaluators | refused with every reason |
| `extend_round(nodes)` | leader, owner | round open; `round.extends < extendsMax` (owner exempt); the same checks as `plan_round` | refused |
| `patch(node, rev, ops)` | leader, owner | node `pending` and `node.rev == rev` at commit (I4) | refused as stale |
| `steer(node, msg)` | leader, owner | node `running`, agent kind | the result names the delivery: `mid-turn` (claude), `next-buddy-tool` or `queued` (`harness-steering.ts`) |
| `cancel(node)` | leader, owner | pending, waiting or running | — (charged its journaled usage; the full cap only when usage is unknown) |
| `end_round(reason)` | leader, owner | round open | pending and running members cancelled; carried nodes and waiting gates survive; the round is graded |
| `reflect(decision)` | leader | the latest closed round is graded and unreflected; if the miss streak ≥ 2, decision ∈ {`rewrite_meta`, `propose_finish`, `ask`} | refused: "two missed rounds: change the plan, propose a finish, or ask" |
| `rewrite_meta(plan, reason)` | leader | `keeps ⊇ charter.gates` (I6) | refused |
| `revise_objective(version, label, evidence)` | leader | the host diffs it against the current version: a superset applies; anything else becomes the pending revision with a fresh id, **refused if one is pending** | refused: "revision r7 awaits the owner" |
| `ratify(base, proposalId)` / `reject_revision(proposalId)` | owner | pending revision with that id; `base == current v` (I8, I8b) | id mismatch: refused, the owner's view reloads; stale base: refused and the leader is told to rebase |
| `propose_finish(summary)` | leader | — (records the current `objV`) | — (it never finishes by itself) |
| `accept` / `reject` | owner | live: a proposal whose `objV` is current (I7b); finished: no verdict yet | stale proposal: refused, the leader is told to re-propose |
| `answer(gate, text)` | owner | any phase, finished included | — (unparks a parked expedition) |
| `run_eval(eval, sha)` | agent node (its own turn) | `eval ∈ node.evals`; the node's remaining cap covers `maxUsd`; scarce count, pools free | refused with the reason; the agent decides (no silent queue) |
| `finish_met` | host | `charter.finish == on_met`; one sha with every check criterion of the current version passed by a check testing it (I7a); no owner criterion; charter gates answered | — |
| `park` | host | the last reflection was `ask`; no round open; nothing running; a gate waiting | — |
| `close_report` | host | finished; no report yet | — (one bounded turn from `closeReserve`; a failure is recorded, never retried) |
| `carve(parent)` | host | parent running (agent `run_eval`, or a population refill); child fits the parent's remaining reservation, pools, scarce counts | stays queued until a slot frees |
| `pause`, `resume`, `stop`, `extend(hours, usd)`, `note` | owner | as today (bare chat commands, `host_command` purpose); `resume` also unparks | — |
| `start(node)` | host | phase live; dependencies done (a fan ref waits for all children); member of the open round, or carried; reservation fits money, evals, every named pool; a gate whose question is already answered goes straight to done | stays pending |

### 3.5 Events: what wakes the leader

| Event | Enqueued when | Wakes |
|---|---|---|
| `launch` | the expedition starts | yes |
| `roundDone` | a round closed (all members ended, wall cap, or ended); carries the grade | yes: outer reflection |
| `nodeFailed` | failed, `blocked`, `cannot_run`, `dead_on_adopt`, or an orphan cancelled because its input failed | yes: inner reflection |
| `carriedDone` | a carried node (gate dependent or round straggler) ended | yes (batched) |
| `plateau` | a population ended: budget used, or no archive improvement in `plateau` children | yes |
| `gateAnswered`, `revisionRatified`, `revisionRejected`, `finishRejected`, `proposalStale` | owner acts | yes |
| `ownerMsg` | a non-command chat message | yes |
| `budgetMark` | 50% and 80% of usd or of any eval count | yes |
| `stalled` | a running node shows no tool or usage activity for its stall window | yes |
| `tick` | every 30 min **while capacity work runs**; never while nothing runs or while parked | yes. A tick is a safety net, not the loop: 30 min is far past the 5-minute prompt-cache TTL, so every tick pays a full prefix write (about 25k tokens) |
| `nodeDone` | an uncarried node completes | **no**: batched until the next wake (the round's close, or a population's refill, does not need the leader) |
| `restart` | a backend boot finds the expedition live | yes (re-delivers a lost wake) |

A wake reserves its cap first (I3a). The leader reads the inbox, the open round's states, and the
summaries of new artifacts. It opens any artifact on demand. The model's `tick` enqueues a wake
only while capacity work runs (revision 2; revision 1 enqueued one on every live tick).

### 3.6 Open questions

- **q1** (from the leader design): should rounds be graph JSON only, or also come from a builder
  script? Current answer: JSON only in V1.
- **q2** (answered): the host classifies a revision by its diff, not by the leader's label.
- **q3:** should the judge seat be a different provider from the leader and producers by default?
  Proposed yes when the charter has two providers (`external.md` §5, self-preference). Every
  judgment-quality claim in G10/G11/G12 rests on this seat.
- **q4** (answered by `tree: scratch`): a blind node sees only the allowlisted files and no
  findings. The census agent applies the taxonomy after discovery.
- **q5** (answered): the deadline is on a **work clock** that stops while `parked`; parking starts
  only from an `ask` reflection with nothing running, and the wall hard stop
  (`work deadline + parkMax`) still ends it.
- **q6:** where should the statistical judge (paired sign test, censoring) live? V1: in the repo,
  as an evaluator with a JSON report (`rr/reports/tidewar-balance/compare.py`).
- **q7:** what should `maxMessage` (I3c) be per provider, and is usage streamed mid-turn by every
  harness? If codex reports only at turn end, its cap must be wall-clock.
- **q8:** islands, embedding novelty rejection and a model bandit (ShinkaEvolve) are not in V1's
  population: it has exact-diff dedupe, family keys and fitness × novelty parent weights. Are
  islands needed for case 4's "several independent lineages", or are separate population nodes
  enough?
- **q9:** `ssh` pools for remote machines other than Modal (case 3) are not designed.
- **q10:** case 5's "a cell needs a solver redesign" wants a nested expedition. V1 has no nesting;
  the cell fails as `blocked` and the leader plans a case-4 style round.
- **q11:** is enforcing `no-network` for `scratch` trees feasible on every harness (claude
  settings deny, codex `--sandbox`)? Until it is, case 4 blindness is advisory for network.

## 4. How work flows

**The loop.** The host runs one serialized `step(id)` per expedition. It keeps today's
`serialized`/`commit` from `server/src/expeditions/host.ts`. A step:
1. applies owner commands;
2. finishes the expedition if it is due (work deadline, hard stop, budget, `finish_met`);
3. cancels orphans;
4. starts every startable node whose reservation fits, and carves population refills and queued
   `run_eval` calls;
5. closes the round if every member ended or the wall cap passed (stragglers are carried), and
   grades it: check-typed predictions from the evaluator reports, judged ones by one judge-seat
   turn that sees the predictions and the artifacts, not the leader's reasoning;
6. parks if the last reflection asked and nothing can move;
7. wakes the leader if the inbox holds a waking event and a wake fits.

The leader's turn is a Buddy turn in the existing manager seat. It acts through the expedition
Buddy tool (`server/src/expeditions/tool.ts`) and then sleeps, and its usage settles its
reservation. Nothing else calls the leader.

**Gates never hold work.** A node depending on a gate is **carried** from the moment it is planned:
it belongs to no round, so the round closes without it, and the host starts it as soon as the
gate is answered, round open or not. A gate answered before its node starts is done at once. When
the leader has nothing to do but wait, it reflects `ask` and the expedition parks with its work
clock stopped. This answers the GTM failure where an owner gate burned the deadline (cases 1, 9).

**Parallel and remote compute.** Pools are the only concurrency knob, for example:
- `cpu` = 3;
- `local-gpu` = 1 (wave_sim `AGENTS.md`);
- `compile-lock` = 1 (rr `build_gate.sh`);
- `modal` = 4 under a $ ceiling.

Evaluators and agents name **lists** of pools, reserved atomically: case 2's evaluator takes
`['compile-lock', 'cpu']`, and an agent that compiles in its own tree reserves `compile-lock` too.
An agent's own process has no paid credentials and no GPU (I3d). Paid or GPU runs go through
`run_eval(eval, sha)`: the host runs the charter evaluator in a detached checkout and funds it from
the agent's own reservation plus a pool slot and a scarce count. The evaluator's JSON report
returns the real dollars, which settle the ledger. Today one host-wide check queue (`checks.ts`,
`CHECK_TIMEOUT_MS` 2 h) serializes everything; per-pool caps replace it.

**Test-time compute up and down.** Width, depth and seat tier are leader judgment, guided by an
effort table in the leader prompt:
- **routine:** 1 cheap agent per slice;
- **comparison:** 2–4 agents, or an adversarial trio on distinct seats;
- **frontier:** one or more **population** fans (separate populations are independent lineages;
  FunSearch found its result in 4 of 140 runs).

**Populations.** `fan{source: population}` reserves its whole budget at start and holds no slot.
The host refills it without leader wakes:
1. pick parents from the archive by the charter policy (top-k, or fitness × novelty weights);
2. carve one generator child (the template agent, given the parents' summaries and scores);
3. when the child yields a candidate sha, run the population's evaluator on it;
4. reject an exact duplicate diff digest, write the `score` judgment (value and per-input scores),
   and add the entry to the archive.

The population ends at its budget or after `plateau` children without improvement, and then wakes
the leader. This is the FunSearch/AlphaEvolve/ShinkaEvolve loop (`external.md` §2) with the
leader moved off the hot path. The inner keep/discard loop of autoresearch fits either here or
inside one agent node using `run_eval`.

**Knowledge so ideas are not repeated.**
- **Hypotheses** come from agents, in `Artifact.hypotheses`, keyed `(family, rep)`. Family keys
  come from the repo's own taxonomy file (`charter.families`, e.g. wave_sim's KEY_LEARNINGS
  graveyard table). The agent picks a key; it cannot invent one.
- **Verdicts are judgments**, written by a judge-seat node that reads the hypothesis, its check
  results and the graveyard. An agent cannot mark its own idea `keep`.
- **New families and representation changes** need a judge `new_family` or `rep_change` row.
  Relabelling a repair as a "sidecar" now needs a judge to agree that the representation changed.
- **Dedupe at plan time.** `plan_round` refuses an agent whose `tests` names a family with two
  `reject` verdicts unless a `rep_change` judgment exists.
- **What briefs carry.** A byte-stable prefix (role, `userGoal`, current objective, limits), then
  the judgment rows for the node's families (about 40 at most), and its refs. `scratch` nodes get
  neither.
- **Durable homes.** One node per round holds write custody of the repo's knowledge files
  (KEY_LEARNINGS, the theory progression log, the source ledger) through its fence (I14).

**Integration.** There is no integrate kind. An integrator is an `agent` whose tree is the
charter's integration branch. It merges candidate refs one at a time inside its own node, so
integration is serial because it is one node, and it repairs conflicts itself. A check then runs
on the merged sha. Main is never a target: landing on main is the owner's own act after a `land`
gate, done from a fresh `origin/main` as the repo rules require. The owner's dirty main checkout
(150+ files) is never read or written.

**Owner steering mid-run.**
- **Commands.** Bare commands (`pause`, `stop`, `extend 2h`, `answer g1: …`, `ratify r7 on v3`,
  `cancel r2.n4`) are consumed by the host and wake nobody. This is today's `host_command`,
  which fixed the double-applied extend (L9).
- **Messages.** Any other message wakes the leader.
- **Steering and patching** as before: the reply names where a steer lands; owner patches use
  CAS on the revision shown.

**Termination.**
- **Deadline.** At the work deadline or the wall hard stop, work stops in the same step. Pending
  nodes are cancelled, running agents are cancelled and charged (journaled usage, or the cap when
  unknown), and the leader is put to sleep.
- **What continues.** Running checks finish and record judgments. Gate answers, the owner's
  verdict and the closing report land after the finish (witnesses `w_noCheckAfterFinish`,
  `w_noLateVerdict`, `w_noReport`).
- **Budget.** Exhaustion ends a run with nothing running and no affordable wake.
- **Closing report.** One bounded host-started turn on the judge seat, paid from `closeReserve`:
  `userGoal` verbatim, the final objective and its basis chain, what was met on which sha, the
  stated gaps (unmet criteria, unanswered gates, open questions), and spend.
- **Finishing as met.** That needs `finish_met` or the owner's `accept`. Under
  `finish: run_to_deadline` (cases 3, 4) a full pass is an event and the search continues.

## 5. The nine use cases in this model

In the walkthroughs below, `R1…` are rounds, nodes are written as `kind×count`, and the judge is
named per node.

**1. GTM research** (wave_sim/business; the draft record `gtm-evidence-thesis-buye-dd0984.json`
is objective v0 plus meta-plan v1, and v0 is now signed with the charter).
- **R1 scope:** `agent×1` (strong) writes the sampling frame as a list of 25–40 organizations
  (`out: Org[]`). Prediction (judged): "3–5 public incumbents exist".
- **R2 collect:** `fan(list: R1.orgs)` with cheap seats, each returning source-ledger rows with
  `fetched | missing | blocked`; every `fetched` row stores the page bytes in the artifact store
  with their digest. A reduce `agent` dedupes and counts. Prediction (check): an evaluator
  counts fetched rows whose digest resolves to stored bytes longer than a snippet.
- **R3:** one strong synthesis `agent`, every claim tagged with a row.
- **R4:** an adversarial trio: advocate and critic `agent`s on distinct seats, then a judge-seat
  `agent` that writes a verdict judgment on the thesis (I13). If the round is graded missed twice,
  `continue` is refused (G10).
- **R5:** a judge-seat audit `agent`, the buyer-test packet, and the charter `gate` ("buyer test
  plan acceptable?"). The leader reflects `ask`, and the expedition parks instead of burning the
  deadline while the owner reads.
- **Weak spot:** a fetched page can still be irrelevant. The digest check proves fetching, not
  reading.

**2. Game design** (room-runners-arena-lib, Tidewar).
- **R1 instrument:** `agent×1` fixes the measuring stick and writes the frozen seed sets; its
  evaluator `tidewar-ab` takes pools `['compile-lock', 'cpu']`, so the 8-minute release build
  serializes on the lock and the seeds run on cpu. An exploit hunter `agent×1` runs first, not late.
- **R2:** `fan(list: R1.levers)`, each child in its own Cambium tree and fence, `tests: [lever
  family]`, with a paired A/B check (16+ seeds plus mirror, sign test in the JSON report, q6).
- **R3:** stack the confirmed levers in one `agent` and re-measure.
- **R4:** `gate` for the human playtest (carried dependents start when it is answered).
- **Weak spot:** feel cannot be checked; the gate is the only judge of fun, and a 1.227 skill-gate
  miss stays a miss (I12 freezes the yardstick).

**3. wave_sim speed and accuracy** (local M4 plus Modal).
- **Pools:** `local-gpu` 1, `modal` 4 under a $ ceiling. Evaluators: R1–R12 plus the
  matched-error report, each with a digest.
- **Charter:** `finish: run_to_deadline`.
- **Each round:** one `population` fan per active idea lineage, its generator a strong-seat
  agent template with `tests` keys from the graveyard taxonomy. The host refills it as Modal and
  M4 checks return, so the pool stays busy between leader wakes. The evaluator's JSON report puts
  an `audit_hold` on any matched-error speedup over 10×; the claim stays unverified until a
  `scratch`-tree judge node reproduces it.
- **Two strikes:** a family with two `reject` verdicts is refused unless a judge accepted a
  `rep_change`.
- **Weak spot:** "local AND remote machines" is local plus Modal; ssh hosts are q9. The evaluator
  is wave_sim's 7:1 custody tooling, which V1 does not shrink.

**4. Frontier math to algorithms** (Astra packet).
- **R1:** several `population` fans (independent lineages) whose generator template uses
  `tree: scratch` (allowlist `MINIMAL_PROBLEM.md` plus hardware facts), on distinct seats. The
  evaluator digest is frozen in the charter (I12).
- **R2:** a census reduce `agent` (judge seat) clusters frozen candidates and applies the
  taxonomy (`new_family` judgments).
- **R3:** `fan(list: R2.selected)`, one GPU falsifier check per candidate via `local-gpu`.
- **R4:** an independent judge `agent`.
- **Stop rule:** two missed rounds force `propose_finish` with a no-go or lower bound as the valid
  result, or a structural rewrite.
- **Weak spot:** network denial for `scratch` depends on the harness (q11). Islands are q8.

**5. New capabilities** (R6 forces, R7 moving bodies, R8 sand, R9 wind × engines E/A/Dual).
- **Shape:** the meta-plan is a matrix. Each round is a `fan(list: cells)` over (row, engine)
  pairs whose output schema is the repo's `Cell = { row; engine; status: 'pass' | 'fail' |
  'blocked' | 'not_run'; evidence: Ref }`, so the matrix status is typed data, not prose.
- **Inside a cell:** the serial debug loop runs in one `agent` with `run_eval` for the paid
  replay. `evals: { 'paid-replay': count 1 }` enforces "a local replay before paid spend".
- **Weak spot:** no nesting (q10). A cell needing a solver redesign fails as `blocked`.

**6. Deslop buddies.**
- **R1 measure:** `fan` of cheap read-only scans (`limits: read-only`), then a reduce into an
  inventory.
- **R2:** a strong `agent` writes the lean target and `Slice[]` with fences and line budgets.
- **R3…:** `fan(list: slices)`, one Cambium tree and fence per slice (I14), each with a check
  (`pnpm typecheck`, tests, screenshots `--baseline`) on its **candidate sha**, not the dirty tree.
  That closes the 48724f4 class.
- **Integration:** an integrator `agent` on the charter's integration branch merges passed slices
  in order and repairs conflicts; a check runs on the merged sha; a `land` gate precedes the
  owner's own push.
- **Weak spot:** V1 cannot make a 3–4× cut happen. It only stops a 25% cut being reported done.

**7. CRUD SaaS apps.**
- **Shape:** all rounds written up front; each round is a `fan`. Reflection is cheap: predictions
  are check-typed, so the host grades them and `continue` is allowed while they are met.
- **Judge:** integration tests per feature on the candidate sha, then a walkthrough `gate`.
- **Weak spot:** a Claude Code Workflow does this with less machinery; V1 adds durability, owner
  steering and serial integration.

**8. Geometry engine** (wave_sim `studio/design_kernel`).
- **Evaluator:** the guarded bun suite (256 MiB / 60 s, about 2 s per run), pool `cpu`, with
  `evals: { 'g0-replay': count 1 }`.
- **R1:** a strong `agent` derives the geometric conditions as hypotheses; a judge-seat critic
  attacks the derivation and writes verdict judgments.
- **R2:** an `agent` with an inner test loop in a Cambium tree. The free bun suite runs in its
  shell under its reserved `cpu` slot. The one scarce replay is a `run_eval` (or a separate
  `check`) that reserves the `g0-replay` count. A reviewed candidate is a `done` node that a later
  round integrates by ref.
- **Weak spot:** mostly one deep thinker; V1's value is the scarce-eval enforcement and custody.

**9. Document-model design.**
- **Rounds:** each round is an adversarial trio over the current proposal (the critic reads the
  requirement ledger G01–G12 and A94), then an adjudicating `agent`, then a `gate` per batch of
  owner questions. The leader reflects `ask`, and the expedition parks while the owner answers.
- **Objective:** `check` rows for the executable spikes (Z5, Z9) and an owner criterion:
  "replaces the running model, with a retirement plan".
- **Stopping the redesign loop:** each round predicts (judged) "this proposal has a retirement
  plan the critic cannot break". Two misses force a structural change.
- **Weak spot:** whether a design is good is judgment. The model only keeps the record honest.

## 5b. Scaling example

This section applies the width rule in `research/scaling.md` §4 to V1. Numbers are from
`scaling.md`, `use-cases.md`, `prior-art.md` or §6 here, and each is marked **measured** or
**estimate**.

**Who decides width.** The leader decides, as LLM judgment, when it writes a round. The effort
table in §4 guides it, and it sets the number of population fans, `fan.maxPar` and seat tiers.
There is no host formula and no separate plan job. The host only **clamps** width: pool caps
(I3b), reservations against the ledger (I3, I3a), scarce eval counts (G13), and `carve` refills
inside a population's budget. Pools and evaluators are charter entries, so only the owner raises
them, by amendment (I1).

### Rule map

| Rule (`scaling.md` §4) | V1 mechanism | Enforced by |
|---|---|---|
| 1 wide only on decomposable work | Effort table (§4): routine 1, comparison 2–4, frontier populations. Disjoint `writes` fences (I14) refuse overlapping parallel agents | Leader judgment; fences are host. ❌ No host check that a unit is decomposable. It would need a typed `shape: 'chain' \| 'pieces'` on the meta-plan intent, with `plan_round` refusing a fan on a chain |
| 2 never wide without a central verifier | A population needs an `eval` (`FanSource`). Judgments come only from checks, judges or the owner (I15). Round predictions are graded by host or judge (M5) | Host for populations. ❌ For list fans: `plan_round` accepts a fan whose children have no `check` or judge node before a reduce reads them. It would need a "fan ref read only through a check" rule in `plan_round` |
| 3 coordinate centrally; rebalance stragglers | One planner (leader); agents have no act that messages another agent, only `inputs: Ref[]`. A list fan starts children as slots free (pipeline, §7). Populations refill on every free slot (`carve`). Round `wallMax` carries stragglers (I19). `stalled` wakes the leader to `steer` or `cancel` | Host for refill and the wall cap. ❌ Stragglers: work already handed to a slow child is never split or reassigned, and `stalled` only wakes the leader to judge. It would need a host hedge rule, e.g. "a node past p× its fan's median wall time gets a duplicate on a free slot, first done wins, the other is cancelled" |
| 4 share selectively through one store | Immutable artifacts in one store (I2); append-only `Judgment` rows; the population archive with exact-diff dedupe; family keys from `charter.families`; G11 refuses a twice-rejected family; briefs carry ≤ ~40 judgment rows for the node's families | Host. Gaps: siblings in one list fan never see each other until the next round; no embedding novelty (q8) |
| 5 respect the ~45% ceiling | ❌ Nothing. V1 never measures single-agent success on a unit. It would need a judgments fold "pass rate of width-1 attempts per family" and a `plan_round` refusal of width > 1 above 0.45 | — |
| 6 width is earned from the verifier | ❌ No width follows from verifier quality or speed. A population needs an evaluator to exist at all (`FanSource`), but its width is set by the leader and clamped by pools (`cpu` 3, `modal` 4, `local-gpu` 1). Scarce evals (`g0-replay` count 1) clamp how often an expensive check runs, not how many agents work | ❌ It would need a `plan_round` cap per fan derived from its verifier: `check` criterion vs `judged`, and the evaluator's measured run time. Today a leader may fan 20 agents graded only by a judge seat |
| 7 budget against measured speedup | The ledger records `Spend` per node; `score` judgments record value; a population ends at `plateau` children without archive improvement; `budgetMark` at 50%/80% | Host for plateau and marks. ❌ No "$ per verified result" fold and no rule that narrows on it; plateau measures score, not cost. Narrowing is leader judgment at reflection |

### Worked example A, wide: case 3, wave_sim speed and accuracy

1. **Charter.** Pools `local-gpu` 1 (the M4), `modal` 4 under a $ ceiling, `cpu` 3. Evaluators:
   R1–R12 and the matched-error report, each with a digest (I12) and a JSON report carrying
   `usd`, `score`, `perInput` and `hold`. `finish: run_to_deadline`. `families` = the
   KEY_LEARNINGS graveyard (~30 rows, measured).
2. **Width chosen.** The leader writes R1 with one `population` fan per idea lineage, say kernel
   variants, solver changes and precision. That is three independent lineages, chosen by leader
   judgment. Each fan has a budget, a `plateau` count and a parent policy. A population holds no
   slot; its children reserve `cpu` to write code, then call `run_eval`, which carves a `modal` or
   `local-gpu` slot. A child keeps its `cpu` slot while its `run_eval` runs (§3.4, §4). So at most
   3 children exist at once, across all lineages, and at most 3 evaluations run at once. The
   `modal` 4 + `local-gpu` 1 eval capacity is never filled while `cpu` is 3. Raising width means
   an owner amendment to `cpu`, which is a local-CPU bound. V2 names this same ceiling as its S5
   critique of V1.
3. **Width grows.** Refill is host work: when a child's check returns, `carve` starts the next
   child without a leader wake (G15). More lineages need an `extend_round` (≤ `extendsMax`) or the
   next round. More Modal slots need an owner `extend`/amendment.
4. **Width shrinks.** A lineage ends at its budget or at `plateau`, and wakes the leader. A
   graveyard family with two `reject` verdicts is refused at plan time (G11). Two missed rounds
   forbid "more of the same" (G10). `budgetMark` wakes the leader at 50% and 80% of usd.
5. **Central verifier.** The evaluator, not a model. Its report gives exact numbers per frozen
   case (`perInput`) at matched error under complete cost; ABBA pairs are the repo's protocol
   inside the evaluator. **Theoretical vs measured:** an agent's `hypotheses[].prediction` holds
   the predicted speedup; the round's `check` prediction (`expect: Predicate`) is graded by the
   host from the measured report. A speedup over 10× gets an `audit_hold`, lifted only by a
   judge's `verified` after a `scratch`-tree reproduction (S5).
6. **Sharing.** Everything goes through one store: artifacts, `score` judgments with per-input
   values, and the archive. Parents are drawn from the archive (top-k or fitness × novelty);
   exact duplicate diffs are rejected; briefs carry the family's judgment rows. No agent messages
   another. One node per round holds write custody of KEY_LEARNINGS (I14).
7. **Stragglers.** A slow Modal run delays only its own child; refills continue around it. A
   `run_eval` that finds its pool busy is refused and the agent decides (§3.4). The local M4 is
   the real straggler: a ridge run took 10.5–29 min (measured), so `local-gpu` 1 serializes named
   hardware runs and Modal carries the breadth. ❌ A slow child is never hedged or reassigned
   (rule 3 row); it holds its `cpu` slot until it ends or hits the round's `wallMax`.
8. **Remote vs local.** Agents run locally only. Remote means Modal evaluation only. ❌ ssh pools
   (q9), and ❌ remote agent seats (README §5.1).
9. **Token and $ shape (estimate, from §6).** ≈ 165k strong-input tokens per new idea (140k work
   + 25k cold seat), repeats refused at 0 tokens, ≈ 25k per leader wake at each plateau: ≈ 0.8×
   a naive loop per new idea. GPU $ per run is unchanged: a Modal smoke took 157.8 s, of which
   1.1 s was compute (measured), and a DualSPHysics run cost $0.019–0.062 (measured). **Per
   verified result** = (165k tokens + run $) ÷ the fraction of ideas that verify, plus one judge
   reproduction per audit hold. V1 does not record that fraction (rule 7 ❌), so the figure is
   unknown.

### Worked example B, narrow then widen: case 8, geometry kernel

1. **Start at width 1–2.** The verifier is judgment at first: the geometric conditions (e.g. the
   bore-cap refusal at r > √(3.75²−2²)−2.5) are derived, not tested. R1 is one strong `agent`
   that writes them as hypotheses, plus a judge-seat critic on a distinct seat (I13). That is
   width 2, and the second agent is a verifier, not a producer.
2. **Invest in the exact check first.** R2 is one `agent` that turns the derivation into the
   known-answer bun suite under the guard (256 MiB / 60 s; runs take 1.42–2.78 s, measured).
   The charter's evaluators are fixed (I1). Whether an owner amendment may **add** an evaluator
   mid-run is not settled: I1 lets amendments change evaluator digests, but the `amendments`
   field comment lists only "extend, gates, pools" (§3.1). ❌ open question. Otherwise the suite
   must be a charter evaluator from the start, or run as the agent's own shell command under
   `cpu` (as §5 case 8 does) and not count as a `check`. If it is added, its digest and
   preflight hold (I12, I16). A `check` criterion naming it is a superset of
   the objective, so `revise_objective` applies it at once.
3. **Trigger to widen.** Once that evaluator preflights and a check criterion names it, the
   leader may plan a list fan or a small population over candidate constructions, each in its
   own Cambium tree, with the free suite under `cpu` 3. That trigger is **leader judgment**: no
   host rule ties width to the evaluator's existence for list fans (rule 6 ❌). The scarce
   `g0-replay` stays at count 1 whatever the width, and that clamp is host-enforced (G13).
4. **Rule 5 (❌).** If one deep agent already passes the suite on most attempts, V1 cannot tell.
   It records no width-1 pass rate, so nothing stops a needless fan.
5. **Rule 7 (❌, partial proxy).** A population's `plateau` stops it when scores stop rising. A
   list fan has no such stop, and no rule narrows when $ per verified candidate stops improving.
   The leader sees spend per node at reflection and may narrow by judgment.

### Mixed: case 1, GTM

R2 is wide: `fan(list: R1.orgs)` over 25–40 organizations on cheap seats, each verified by the
digest-count evaluator, all writing page bytes and ledger rows to the one artifact store; a reduce
agent dedupes. R3 is narrow: one strong synthesis agent. R4 is an adversarial trio on distinct
seats. The verifier is weak: a digest proves a page was fetched, not read (§5 case 1).

### Verdict

- **Score: 2.5/5** (README's "Frontier scaling" row gives 2). Above 2 for host refill and one shared store. Below 3
  for the `cpu` 3 ceiling, a leader wake per new lineage, no rule 5, 6 or 7 mechanism, and list
  fans with no verifier requirement.
- **Scales well:** host-refilled populations refill up to 3 concurrent children without leader
  wakes (not `modal` 4: `cpu` 3 binds first); one store with exact-diff dedupe and family
  refusal (rule 4); one central planner (rule 3, minus stragglers); scarce evals and pools clamp
  how often expensive checks run.
- **Caps out:** `cpu` 3 bounds concurrent children; width is leader judgment with no host
  formula (rules 1, 2 for list fans, 3 for stragglers, 5, 6, 7 are ❌ or partial); agents are local only, with no agent-seat pool, and remote means Modal only
  (q9); a list fan's siblings share nothing until the round closes; each new lineage needs a
  leader wake (≈ 25k cold, estimate).
- **Smallest change that raises the ceiling:** a `judgments.ts` fold of $ per verified result per
  fan and population, plus a second `plateau` condition that ends a population when that figure
  stops improving. It reuses `Spend`, `score`/`verified` rows and the existing plateau wake, and
  turns rule 7 from ❌ into a host rule.

## 6. Token and wall-clock economics

**Where tokens go.** Measured history (`prior-art.md` §7) shows input dominates, at a ratio of
7–13 to 1. Cold seats cost 20–33k tokens each, and history re-sent in briefs is the main sink.
V1 puts tokens in node work, node cold starts (wide fans pay N times), leader wakes, and judges.

**What runs without an LLM:** scheduling, the ledger, CAS, gates, parking; every check and
population score (statistics and matched error are repo evaluators); dedupe by key and diff
digest; adoption.

**Relative cost against a naive single-agent loop.** Estimates, not measurements. Units are
strong-seat fresh input tokens; cheap seat = 0.2×, cache read = 0.1×, output = 5× input.
**Revision 2 prices every node at cold-seat cost (25k)**, because warm forked sessions
(FOLLOWUPS #4) are not built; the "warm" column is what step 8 of §8 would buy. Leader wakes are
priced cold too (ticks are past the cache TTL).

| Case | Naive single-agent loop | V1, cold seats | Ratio cold (warm) | Wall clock |
|---|---|---|---|---|
| 1 GTM | 6 serial strong attempts: ≈1.0M input + 100k output ≈ 1.5M. Observed: did not finish phase 1 inside 6 h | Collect 40 × (5k + 25k cold + 16k pages) × 0.2 ≈ 0.37M; synthesis 0.12M; trio 3 × 2 × 50k = 0.3M; audit 0.05M; judge grading 5 × 10k = 0.05M; leader 8 × 25k = 0.2M; outputs ≈ 0.5M. ≈ 1.6M | **≈ 1.0–1.3×** (0.9–1.1×) | about 2–3 h for all phases vs not finishing, plus owner time parked off the clock |
| 3 wave_sim speed | One agent, idea → code → GPU serially: ≈150k per idea, ≈8 ideas in 8 h, ≈30% repeating graveyard families | Population children ≈ 140k + 25k cold = 165k per idea; repeats refused at 0 tokens; leader ≈ 25k per plateau, not per idea. GPU $ unchanged per run | **≈ 0.8× per new idea** (0.7×) | about 4–6× more ideas per hour (Modal 4 kept busy by host refills), bounded by GPU $ |
| 6 deslop | One agent slicing serially; context grows; 30 slices × 60k ≈ 1.8M | Measure fan ≈ 0.1M; plan 0.15M; 30 slices × (50k + 25k cold) = 2.25M; integrator 0.2M; leader 0.15M ≈ 2.85M | **≈ 1.5–1.6×** (1.1×) | about 3–5× (waves of 6–8 slices; integration serial in one node) |

The honest summary: at cold-seat prices V1 spends **as much or up to 1.6× more** tokens than a
naive loop on code fan-out, about the same on research, and less per new idea on search. It buys
wall clock, removed repeats, owner time off the clock, and durability. Warm forks (§8 step 8) are
the main token lever, and the case 6 numbers argue for building them before a wide deslop run.
Overhead (leader, grading, reductions) is budgeted at 10–15%.

## 7. Comparison

| | Claude Code Workflows | oompa | V1 |
|---|---|---|---|
| Plan | JS fixed at launch | none: a self-claimed task queue | meta-plan plus a round graph written per round, after a graded reflection |
| Patch running work | no | no | CAS patch, bounded extend, steer, cancel, end round |
| Typed outputs | `agent(schema)`, StructuredOutput | text signals (`CLAIM(...)`; 130/154 errors) | schema per node; `malformed` is a typed failure |
| Barrier semantics | `pipeline` none, `parallel` barrier | none | children start as inputs become ready; a reduce waits on a fan ref; gates and stragglers are carried |
| Search | whatever the script codes | none | host-refilled populations with archive and parent policy |
| Durability | per session; resume replays cached prefix | event files; worktrees | one record, journals, adoption (I11) |
| Budget | output-token ceiling, no reservations | `max_resumes` | money, evals and pools with reservations; paid compute only via the host (I3, I3d) |
| Judges | whatever the script codes | reviewer model, about 3 rounds | host checks on immutable shas, judge seat, append-only judgments, owner gates |
| Owner | none mid-run | host pause file | host commands, gates with parking, ratification by id, verdict after finish |

**Taken from Workflows:** schema-forced outputs; `pipeline` semantics for fan children; a hard
budget ceiling, extended with reservations; "a done node is immutable and reusable by ref".
**Taken from oompa:** a worktree per code node; serialized integration (now one integrator
node); a separate reviewer seat; typed `blocked` holds; seat tiers; event logs, never
projections; fingerprint suppression of unchanged inboxes. **Done better:** no self-claiming
queue (the 56% no-claim cycles), no text protocol, per-unit spend recorded.

## 8. Implementation sketch (buddies)

**Reused as is:** the record file, zod parse once, tmp+rename save, `serialized` + `commit`
(`record.ts`, `host.ts`); the Cambium add/release with salvage (`cambium.ts`); the
detached-checkout check runner with oracle restore and `ranOrNot` (`checks.ts`); the manager seat,
`seatOf`, `host_command`, idempotency keys (`host.ts`, `tool.ts`); harness steering
(`server/src/buddies/harness-steering.ts`, 121 lines); execution journals and adoption
(`server/src/lifecycle/adopt-executions.ts`, 224 lines); the lease/deadline split; provider usage
events; `max_runtime_timeout`.

**Replaced:** the attempt loop in `host.ts` (`settleAll` through `releasePending`, lines
255–460, about 200 lines for one node kind) becomes `scheduler.ts`; `Attempt` becomes `Node`;
`Charter.done` (owner-signed today) becomes `Charter.objective0`, so the owner's signature carries
over; the `Lesson` line in `brief.ts` becomes artifacts and judgments; the host-wide check queue
becomes pools; `shutdown.ts` `discardCrewTurns` is deleted (L10).

**New, each ❌ until built.** Each budget names its measured analogue.

| File | Lines | Analogue | Content |
|---|---|---|---|
| `shared/src/expedition.ts` | 311 → ~640 | today: 311 lines for ~12 types + `ALLOWED`; V1 has 37 named types (several are aliases) | §3.1 types, `valid()` act table |
| `server/src/expeditions/scheduler.ts` | ~420 | the 200-line attempt loop × 4 kinds, minus shared settle | start/settle/close/carry/grade/park; fan expansion; carve |
| `server/src/expeditions/ledger.ts` | ~140 | none (new) | reserve/settle/charge/carve; I3a assertion at commit; kill-at-cap trigger |
| `server/src/expeditions/leader.ts` | ~260 | `brief.ts` 174 + wake/inbox | inbox batching, wake reservation, brief, reflection guard |
| `server/src/expeditions/acts.ts` | ~240 | today's act half of `host.ts` (`launch`…`draft`, lines 524–708, ~185) | plan/extend/patch/revise/ratify/rewrite validation, diff classification |
| `server/src/expeditions/judgments.ts` | ~110 | none | append, folds (claim, verdict counts), the plan-time taxonomy and dedupe checks |
| `server/src/expeditions/population.ts` | ~180 | none in repo; OpenEvolve's controller is far larger, so this is the riskiest budget | archive, parent policy, refill, plateau |
| `checks.ts` | 330 → ~420 | itself | pools[], digests, JSON reports with usd, `run_eval` entry |
| `adopt-executions.ts`, `shutdown.ts` | +60 / −20 | adoption of Buddy turns today | adopt expedition node turns; `dead_on_adopt` |
| `host.ts` | 943 → ~420 | itself minus the loop and acts | composition, finish, owner commands, close report |
| `tool.ts`, `routes.ts`, `brief.ts` | +120 net | — | leader acts, `run_eval` tool, the round view API |
| agent env filter | ~40 | `cambium.ts` `gitEnv` (20 lines) | strip paid-compute credentials and GPU from agent turns (I3d) |
| tests | ~1,000 | — | one integration test per I-row, plus a **trace-replay test**: Quint ITF traces (`quint run --out-itf`) drive the real scheduler and acts |

**Budget:** today's 2,349 lines grow to about **3,800** (the rows above summed: +2,170 new or
grown, −523 from `host.ts`, −20 from `shutdown.ts`), excluding tests and the client round view
(about 400). Revision 1 said 3,300 for less. **Stop rule:** past 4,100 lines, delete
`population.ts` and run populations as an agent node calling `run_eval` (metered either way), and
do not add machinery. (The ledger
generation reached 13.5k lines in two days, L17.)

Build order:
1. types and `valid()`;
2. the ledger and the scheduler with the trace-replay test;
3. adoption;
4. the leader, briefs, reflection and grading;
5. judgments;
6. pools, digests, `run_eval` and the agent env filter;
7. populations;
8. warm forked seats (FOLLOWUPS #4), before any wide fan run (case 6).

The GTM draft is the first real run.

## 9. Verification

Model: `docs/specs/expedition-v1.qnt` (revision 2; Quint 0.33.1, no JVM, so no `quint verify`;
random simulation with the Rust backend). Bounds: 6 node slots, 3 rounds, money 14 (plus 4 per
extend, at most 2 extends), close reserve 2, wake cost 2, 2 scarce evaluations, GPU cap 1, CPU
cap 2, 3 live nodes, work deadline 12, park allowance 4, round wall cap 4, 2 extends per round,
2 candidate shas, wall time at most 26. LLM choices (graph shape, check pass, round grade, actual
spend up to the cap, revision content, reflection decision) are nondeterministic. Objective v0
and the finish mode are chosen at init.

`Q=/private/tmp/claude-501/-Users-nicholasbardy-git-buddies/7f8221f8-9cfa-4109-ae0f-8e52e6b36925/scratchpad/quint/node_modules/.bin/quint`;
`F=docs/specs/expedition-v1.qnt`. Every run below is `$Q run $F --step=<step>
--invariant=<name> --max-samples=<n> --max-steps=80`.

| Command | Result |
|---|---|
| `$Q typecheck $F` | clean |
| `safety`, step `step`, 20,000 samples | **ok** (all 23 conjuncts), seed `0x1472e2a7e30d045e` |
| `safety`, step `stepReach`, 20,000 samples | **ok**, seed `0x50500ea1f2bbcdad` |

**Each invariant alone**, step `step`, 3,000 samples: **ok** for all 23. Seeds: doneImmutable
`0x1c70278cdeba9324`, budgetSafe `0x55d4db67d9eb1294`, ledgerExact `0x729131f1bf47019a`, capacity
`0xfc7eb399e2ee35b`, specFrozen `0x63fce092aa29fd15`, typedFanout `0xc99049d60eed50ab`, gatesKept
`0x7618e7f155aff54a`, metOneSha `0xbad3cc6bd515f95c`, ownerMetCurrent `0x7403ba2bbe12a087`,
objectiveFidelity `0x64da74864bbaa18f`, v0Signed `0xce440d6e16cba655`, ratifiedAsSeen
`0x98c0ecd4eb8e6af5`, terminates `0x3f4da8dda443e0fe`, hardStop `0xcee0a1c2b60aa60d`,
noWorkAfterFinish `0x3b9c9d77bdb4c1ab`, noRerun `0xff7514b14017a750`, leaderBounded
`0x773d66fc0fdc23e4`, noDeadGate `0x7702f967f18641c2`, gateFree `0x37c9ae0f9bd66702`, roundBounded
`0x8ce3da956143efda`, extendBounded `0x6ede8bfda607fb59`, g10 `0xf8f6f3803b91aca0`, reflected
`0x7dffea3a528f232e`.

**Non-vacuity witnesses.** Each is expected to be violated, and each was (3,000 samples on `step`
unless noted; "20k" = 20,000 samples):

| Witness (state reached) | Result, seed |
|---|---|
| `w_noWorkDone`, `w_noPatchRace`, `w_noPatchApplied` | violated `0x35a9bebae6ee75e`, `0x2519381eea4d4de7`, `0x20d4e0113ad10ab` |
| `w_noMapFanout` (list fan expands), `w_noMistypedPlan` (mistyped fan refused) | violated `0xc70fdc41bbe6a7a0`, `0x902071a0df916626` |
| `w_noRewrite`, `w_noGateDrop` | violated `0x75cc476d95e222b1`, `0xcb94ad58022390d6` |
| `w_noRatify`, `w_noStaleRatify` (base went stale under an additive revision) | violated `0xe27e88426fc2c9c5`, `0xce48e151b5ed2174` |
| `w_noIdRefusal` (ratify of a proposal id no longer pending refused) | ok at 3,000; violated at 20k `0x3af281371f5f538a` |
| `w_noRevBlocked` (second non-additive revision refused) | violated `0x3c25e47e283e10f9` |
| `w_noHostMet` | ok at 3,000 in one run; violated at 20k `0x9a2b6f94e2b2c7cc` |
| `w_noHostMetMulti` (host Met on a ≥2-criterion objective) | violated `0xdf78ff1e29df326b` (step, 3,000; replayed on the final model) and `0x1a44f342b64d1e9c` (`stepReach`, 20k); another 20k `stepReach` run missed it (`0x7ad78a7affc1c3e9`): rare |
| `w_noOwnerMet`, `w_noStaleAccept` (stale proposal refused) | violated `0xb63900b49b699e83`, `0xfd0ac45099fa6a69` |
| `w_noDeadline`, `w_noBudgetEnd` | violated `0x3ca3f930eca67e93`, `0xf6fb04f145dd826b` |
| `w_noCheckAfterFinish`, `w_noLateVerdict`, `w_noReport` | violated `0x827232d7b35277fd`, `0x347e92aa7a745e38`, `0x530c9adde2ca4e78` |
| `w_noAdoption`, `w_noDeadAdopted` (adopted process found dead) | violated `0x2e15eeecd31ee170`, `0xd5cec3e023f6e2e9` |
| `w_noThirdRound`, `w_gpuNeverFull`, `w_noOrphan`, `w_noExtend` | violated `0x916643457cc31cf2`, `0xf05e86e553e78334`, `0xca90c73ee5f03e62`, `0x65e8540df9323b9` |
| `w_noReflect`, `w_noForcedChange` (structural reflection after two misses) | violated `0x7518a14ecae9074b`, `0xce6facf1cac9a5ae` |
| `w_noG10Refusal` (`continue` refused after two misses) | ok at 3,000; violated at 20k `0x5c22ecdfcfc9df7d` |
| `w_noGateShortcut` (answered-early gate goes straight to done), `w_noCarriedDone` | violated `0xee445bc5f80384a6`, `0xe724aa4aafec3ab7` |
| `w_noPark`, `w_noUnparkByAnswer` | violated `0x5da85513cf563c8b`, `0x1f6038368d725fdf` |
| `w_noCapClose` (round closed by wall cap, stragglers carried) | violated `0x224abe1faded8554` |
| `w_noRunEval`, `w_noPopulation` | violated `0x533870e200554fbf`, `0x2aa1e38a9a3539c8` |

**Guard ablations.** Each removes one guard (`--step=<ablation>`) and must violate its invariant:

| Ablation | Invariant | Result, seed | What it shows |
|---|---|---|---|
| A1 `stepOvershoot`: a node ends one message past its cap | `budgetSafe` | violated `0x221265d589142059` | reservations alone do not give I3; I3c (kill at `usage + maxMessage > cap`) ❌, q7 |
| A2 `stepBlindPatch`: commit without status/revision check | `specFrozen` | violated `0xb13870a98c436c6d` | a patch lands on a running node |
| A3 `stepBlindRatify`: ratify without the base check | `objectiveFidelity` | violated `0x63d9585bb8ce862d` | a weakening over v_k lands on v_k+1 and drops its tightening |
| A4 `stepStaleFinishR`: host finish ignoring which version a check was planned under | `metOneSha` | violated `0x80429639992bc263` (20k `stepReach`, replayed on the final model); a later 20k run missed it (`0x82fc5fad4426fe26`): rare | a check is evidence for one objective version only |
| A5 `stepNoAdopt`: restart reverts running nodes (today's crew behaviour) | `noRerun` | violated `0x4d7eab5829a3ef6e` | adoption must be built (L10) |
| A6 `stepBlindRewrite`: no gate check on rewrite | `gatesKept` | violated `0x2a6d2ea4542ebe9a` | a rewrite drops the charter gate |
| A7 `stepBaseOnlyRatifyR`: revision-1 ratify (base only, no id) | `ratifiedAsSeen` | violated `0x432888e888328b43` (20k `stepReach`) | **critique M3 reproduced**: reject + re-propose, then the owner's stale screen ratifies content they never saw |
| A8 `stepAnyPassFinish`: revision-1 host finish (one passing current check) | `metOneSha` | violated `0xc259f8decde67e52` | **critique M1 reproduced** |
| A9 `stepBlindGate`: revision-1 gate start (always Waiting) | `noDeadGate` | violated `0x1b7d1801c6bcb0a1` | **critique M2a reproduced** |
| A10 `stepNoCarry`: gate dependents stay round members | `gateFree` | violated `0x3fb555224b23bbb0` | **critique M2b reproduced** |
| A11 `stepNoG10`: reflect without the two-miss rule | `g10` | violated `0xb0aad7b42174f756` | **critique M5**: without the rule, `continue` follows two misses |
| A12 `stepStaleAccept`: accept a proposal written under an older version | `ownerMetCurrent` | violated `0x3b2e53462bf35c67` | the stale-proposal hole from S9 |
| A13 `stepNoRoundCap`: tick without the round wall cap | `roundBounded` | violated `0xaed3c0910023a61e` | rounds stay open indefinitely |
| A14 `stepNoHardStop`: tick checks only the work clock | `hardStop` | ok at 3,000 (`0x6590da476a87d42e`); violated at 20k `0x8c7be0ca065cb474` | parking with no wall bound never ends |

Totals: typecheck clean; 23/23 invariants ok; 36/36 witnesses violated (5 needed 20k samples or
`stepReach`); 14/14 ablations violated (A4, A7 and A14 needed 20k samples or `stepReach`). One
earlier battery run died silently after 46 commands (the same exit 144 as a 100,000-sample run).
The missing commands were rerun separately, and every rare result above has a recorded violating
seed. The scripts and raw outputs are in the session scratchpad
(`.../scratchpad/v1rev/runall.sh`, `final.txt`, `final2.txt`).

**Simulation gotchas** (recorded at the code site in the `.qnt` too):
- A `nondet` written *inside* one branch of an `if/else` silently disabled that branch (revision 1:
  the fan-out witness was vacuous until it was hoisted).
- Revision 2: in `hostFinishMet` a `nondet` written after the guards inside `all { }` left the act
  unfired in 20,000 traces. Hoisting it above the guards did not by itself make it fire: the real
  bottleneck was rarity (answered gate × passing current check on the chosen sha × mode). The fix
  was weighting `answerGate` up, planning "an agent and its check" half the time, and a
  `stepReach` step for the rarest witnesses. `stepReach` uses a **subset** of `step`'s transitions
  (no owner stop, cancel, end or pause), so every state it reaches is reachable by `step`.
- `quint run` picks uniformly among `any` branches, so weights decide reachability within a
  sample budget. Without the weighting, `w_noHostMet` was unreached at 20,000 samples while
  `metOneSha` "passed": the vacuity that witnesses exist to catch.
- `quint run` has no temporal properties. Liveness is written as bounded-response safety
  (`noDeadGate`, `gateFree`, `roundBounded`, `hardStop`); real `eventually` properties need
  `quint verify` (JVM) ❌.

**Not covered by the model** (❌ each):
- steer delivery; populations' parent policy, archive contents and novelty (a population is a
  budgeted carver here);
- named pools beyond two classes, and atomic multi-pool reservation;
- write fences, findings taxonomy and judgment authority (I12–I16 are test or assertion guards);
- the judge seat's grading quality (a nondeterministic boolean here);
- the closing report's content (only its cost and timing are modelled).

Random simulation is not exhaustive. The model covers the model, not the code; the trace-replay
test (§8) is the link.

## 10. Self-critique log (revision 1)

**Round 1: attack against the nine use cases.** Case 3's continuous GPU population idled the pool
until each round closed (the oompa idle problem). Revision 1 added `extend_round` and pipeline
fan semantics. Revision 2 found that insufficient (§11, item 8) and added host-refilled
populations. Case 4's blind discovery against the findings index became `tree: scratch`. Case 8's
"exactly one replay" became named eval counts.

**Round 2: attack against simplicity.** Reduce stopped being a kind; revision authority became
host-computed (additive vs not); findings became an index; a line stop rule was set. Revision 2
went further and deleted `duel` and `integrate` outright (§11).

## 11. Critique and revision (2026-11-09)

An independent critique scored revision 1: use-case coverage 6, simplicity 5, token efficiency 6,
frontier scaling 4, owner control 5, Quint fidelity 5. It reproduced five reviewer invariants
against the model. Every item and the response:

### Must fix

| # | Critique | Response | Evidence |
|---|---|---|---|
| M1 | Host `finish_met` needs only one passing check; checks are not linked to criteria (r_hostMetOnePassMulti violated, seed `0x504acf67ff16e9e6`); A on sha1 and B on sha2 finishes a goal no sha meets | **Fixed.** Every criterion has an id; a check node `tests` one criterion. `finish_met` needs one sha on which every check criterion of the current version passed by a check of that criterion. New invariant I7a `metOneSha` | ablations A4, A8 violate `metOneSha`; witness `w_noHostMetMulti` reached (§9) |
| M2 | Gates deadlock: an early answer leaves the node Waiting forever (seed `0x714b86d90102cba8`); a gate's pending dependent holds the round (seed `0x6873ae08db175bf`); q5 open | **Fixed.** A gate already answered starts straight into done. Gate dependents are carried from planning and hold no round. q5 settled: a work clock that stops while `parked`, entered only from an `ask` reflection with nothing running, bounded by a wall hard stop | `noDeadGate` (A9), `gateFree` (A10), `hardStop` (A14), witnesses `w_noGateShortcut`, `w_noCarriedDone`, `w_noPark`, `w_noUnparkByAnswer` |
| M3 | A pending revision can be swapped; `ratify(base)` never checks which proposal (seed `0x3ae2a100eef4e362`) | **Fixed.** Revisions carry an id; `ratify(base, id)` is CAS on both; a second non-additive revision is refused while one is pending. Additive revisions still apply, which is what keeps the base CAS meaningful (without them the base could never go stale and A3 would be dead) | `ratifiedAsSeen` (A7 = the old base-only ratify), witnesses `w_noIdRefusal`, `w_noRevBlocked`, `w_noStaleRatify` |
| M4 | Objective v0 has no owner authority | **Fixed.** `Charter.objective0` is signed with the charter (it replaces `Charter.done`, which the owner signs today); `basis: charter` | `v0Signed` (structural, init only) + ❌ launch refusal |
| M5 | Outer reflection and G10 are leader-graded, dodgeable by unbounded `extend_round`, and absent from the model | **Fixed.** Predictions are typed (`check` or `judged`); the host grades check-typed ones from reports, the judge seat grades the rest; the leader never writes a grade. `extend_round` ≤ `extendsMax`; rounds close at `wallMax`, carrying stragglers. The model has `reflect`, the "every closed round reflected" guard, the two-miss rule and an ablation | `g10` (A11), `reflected`, `roundBounded` (A13), `extendBounded`, witnesses `w_noReflect`, `w_noForcedChange`, `w_noG10Refusal`, `w_noCapClose` |
| M6 | Paid and GPU compute inside agent nodes escapes the ledger | **Fixed, both halves:** agent processes get enforced `no-paid-credentials` and `no-gpu` limits (I3d), and paid/GPU runs go through `run_eval`, which carves from the agent's reservation plus a pool slot and a scarce count. Agents reserve their own `pools` for local runs (case 8's suite) | `carve` keeps `ledgerExact`/`capacity`; witness `w_noRunEval`; ❌ env filter (today only `gitEnv` filters, `cambium.ts`) |
| M7 | Findings dedupe is gameable: free-text keys, self-reported verdicts; I2 contradicts rising claims | **Fixed.** Verdicts and claims are append-only `Judgment` rows written only by checks, judge seats or the owner (I15); artifacts are immutable and hold only hypotheses (I2 is now true). Family keys come from the repo's taxonomy file; new families and representation changes need a judge row | ❌ write-path assertion and plan-time test (not modelled: no concurrency in it) |
| M8 | Frontier throughput is leader-gated; no archive, parent selection, per-input scores or novelty | **Fixed** with no new kind: `fan.source = population` (archive, parent policy, eval, budget, plateau) refilled by the host via `carve`; scores with per-input values are judgments; exact-diff novelty rejection; the leader wakes on `plateau`. Islands and embedding novelty stay open (q8) | witness `w_noPopulation`; stop rule falls back to an agent running `run_eval` |

### Should fix

| # | Critique | Response |
|---|---|---|
| S1 | `ReadScope.blind` is unenforced; no evaluator digest | **Applied.** `ReadScope` deleted; `tree: scratch` holds copies of the allowlisted files only, no `.git`, no network (q11 for harness support), no findings in the brief. `Evaluator.digest` checked before every run (I12) |
| S2 | One pool per evaluator or agent | **Applied.** `pools: PoolName[]`, reserved atomically; agents that compile reserve `compile-lock` (not modelled ❌) |
| S3 | Cancel charges the full cap | **Applied.** Settle from journaled usage or the evaluator's reported $; the full cap only when usage is unknown (model: `cancelNode` takes the usage, bulk ends take the cap) |
| S4 | Tick cadence contradicts the cache TTL; the model's tick wakes on every live tick | **Applied.** §3.5 states ticks run every 30 min only while capacity work runs and pay a cold prefix each time; the model's `tick` enqueues only while capacity work runs |
| S5 | ">10× triggers an audit" is leader judgment | **Applied.** It is an `audit_hold` judgment written from the evaluator's report; only a judge's `verified` lifts it |
| S6 | `finish_met` ends open-ended optimization on the first pass | **Applied.** `Charter.finish: on_met \| run_to_deadline` (modelled as `mode`) |
| S7 | Cut `duel` and `integrate` now; the noun count is understated; budget each file against an analogue | **Applied.** Both kinds deleted (trio of agents; integrator agent). `Round.cap`, `ReadScope` and leader-written `Versus` deleted too. §2 gives the honest count (37 named types, up from 32: the must-fixes cost 5); §8 budgets each file against a measured analogue |
| S8 | Quint hygiene: vacuous `by != Leader`; restated clauses; `r_pausedAsleep` contradicts a comment; adoption structural; no liveness | **Applied.** `Who` has no `Leader` (impossible by type); restating invariants are marked "(restates guard)"; the pause comment now says what happens (a turn begun while live may finish; its acts are refused); `restart` can find adopted processes dead → Failed; bounded-response forms of liveness added (`noDeadGate`, `gateFree`, `roundBounded`, `hardStop`); real `eventually` needs Apalache ❌ |
| S9 | Model omits the closing report, round caps, stale proposals, integrate, findings, fences, pools, budgetMark/stalled | **Partly applied.** Modelled now: closing report, round wall cap and extend bound, stale-proposal refusal (A12), carry, parking, `run_eval` and population carving, dead adoption. Integrate no longer exists. Not modelled and listed ❌ in §9: fences, judgments/taxonomy, named multi-pools, budgetMark/stalled events. I14 and the round cap are no longer counted as Quint-guarded |
| S10 | Use-case gaps: case 3 ssh; case 5 nesting and typed matrix; case 6 conflicts and dirty main; case 1 fetched vs snippet | **Applied where lean:** case 5's `Cell` status schema; case 6's integrator agent owns conflicts and never touches the dirty main checkout; case 1 stores fetched bytes with digests checked by an evaluator. **Left open:** ssh pools (q9), nesting (q10) |
| S11 | Token tables assume unbuilt warm forks | **Applied.** §6 tables redone at cold-seat cost (case 6 is now 1.5–1.6×); warm forks are build step 8 |
| S12 | G3 lacks "ask"; G1's "result or stated gap" depends on an unmodelled report | **Applied.** `Reflection.ask` (raises an adhoc gate, parks); `close_report` act with a stated-gaps section, modelled for cost and timing |

### Argued, not applied

- **"Refuse every `revise_objective` while one is pending."** Applied only to non-additive
  revisions. Refusing additive ones too makes the pending base impossible to stale, so the base
  CAS and ablation A3 become dead code, and the leader cannot tighten while the owner is away. The
  id CAS (M3) already prevents the swap.
- **"A `population` node kind."** Applied as a fan *source*, not a kind: a list fan and a
  population share expansion, carry, cancellation and reduce semantics. Only the source differs,
  which is what a variant of a field is for.

### What the critique did not change

The ledger, CAS and termination core, which the critique called sound, kept their invariants and
ablations A1–A6, re-run green and red on revision 2 (§9).
