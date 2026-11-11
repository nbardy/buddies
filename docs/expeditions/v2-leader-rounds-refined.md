# Expeditions V2: the leader and rounds, refined

Status: superseded by the [keyed expedition system](keyed/v1/DESIGN.md); retained as historical design/research. Old host deleted 2026-11-11.

Status: **design only, nothing built.** Written 2026-11-09; **revision 3** the same day, after an
independent critique (§11 records every item and the response). V2 is a **refinement** of V1
(`docs/expeditions/v1-leader-rounds.md`, revision 2, with its critique in V1 §11), not a rewrite.
The critique was right that 14 changes is not "minor": §0.1 ranks them by evidence and says which
ship first. V2 keeps V1's shape:
- the leader;
- the meta-plan of rounds;
- inner and outer reflection;
- `userGoal` (the owner's words) kept separate from the versioned objective;
- the ledger, CAS, gates with parking, and termination.

Every change from V1 is listed in §0 with its reason and the use case it serves. The doc follows
`docs/design-specs.md`. The concurrent core is modelled in `docs/specs/expedition-v2.qnt`, which is
V1's model with the V2 changes and new ablations, simulated in §9.
Inputs:
- `docs/expeditions/research/use-cases.md`;
- `docs/expeditions/research/prior-art.md`;
- `docs/expeditions/research/external.md`.

## 0. Changes from V1

V1 names its own weak spots (V1 §5, §9 "not covered", §3.6 q3/q8–q11):
- case 4: blindness rests on a scratch tree that has no network denial, and the population is
  unmodelled;
- case 3: remote means Modal only;
- case 5: no nesting;
- case 6: 1.5–1.6× the tokens of a naive loop;
- cases 1 and 9: everything rests on one judge seat, and a fetched digest is not a read;
- `population.ts` is the riskiest line budget.

Reading V1 against the nine cases also turned up two holes V1 did not list:
- **G11 is only checked at plan time.** Host-carved population children and nodes that start after
  a sibling's second reject both spend on dead families. Ablations A15 and A16 reproduce this.
- **Leader ticks are mispriced.** V1 §3.5 wakes the leader every 30 min while capacity work runs,
  and each such wake pays a cold prefix. On case 3 (8 h of GPU work) that is about 16 × 25k =
  0.4M tokens, which V1's §6 table never priced.

| # | Change | Reason (evidence) | Serves |
|---|---|---|---|
| C1 | **Lanes.** A fan runs its children in at most `lanes` reused sessions, each with its own reused Cambium tree. A child is still its own node with its own fence, artifact and candidate sha, but it starts as a warm fork of the round's base session (`context: fresh`) or continues its lane's session (`context: carry`), and it resets the lane's tree to base instead of creating a new worktree. Warm forks move from V1 build step 8 into the core. | A cold seat costs 20–33k tokens (`prior-art.md` §7); V1 priced case 6 at 1.5–1.6× naive because every slice paid one. Cambium creation is slow and once took the wrong HEAD (L14). Claude forks natively and Codex emulates it (`providerSupportsFork`, `server/src/conversations/runtime.ts:598`; FOLLOWUPS #4). | 6, 7, 1 (collection), 3, 4 |
| C2 | **Population simplified.** `ParentPolicy` and `ArchiveId` are deleted. The archive is the fan's own `score` judgments. Parent choice is one fixed host fold: top-k by score, ties to the parent with fewer children (Shinka's two levers). Islands are `carry` lanes: a lane's next item takes its parent from the fold over **its own lineage's** scores, which reach the lane's session as steer messages when evaluations return (the lane does not wait for them). An island reset is a lane rollover, at `rollAt` or when the lane's best sits below the fan's median for `plateau` items, **seeded from the global top-k** plus the family digest. That rollover is how budget moves to better lineages without a leader wake. | `population.ts` had no in-repo analogue and was V1's riskiest budget (180 lines). V1's `ParentPolicy` union was unmodelled. External evidence: weighted parents beat hill climbing, and islands with periodic reset (`external.md` §2). | 3, 4 (q8) |
| C3 | **Dead families stop spending** (rev 3). (a) Every node with a family is checked against dead families when it **starts or is carved**, not only in `plan_round`. (b) An **evaluation is guarded by the classified family**: before the eval of a committed candidate is carved, a cheap one-key judgment (`classified`) assigns the diff's family from the taxonomy; the eval is refused when that family is dead, whatever the generator declared. `declare(family, rep)` stays only as an advisory early exit (a generator that declares a dead family ends at ≈ 3k tokens), never as authority. A node that holds `evals` may not have `family: 'none'`. (c) **A strike is calibrated evidence**: in a family with an evaluator only a failed check strikes; in a family without one a judge reject strikes. (d) **A family's death cancels its running and pending work** in the same write (journaled usage charged). | V1 hole: carved population children never passed G11, and a pending node of a family that died mid-round still started (ablations A15, A16). Critique: `declare` is a self-report, so a relabelled sidecar passed (A27); one LLM reject killed a measurable family, the expensive error for cases 3/4 (FunSearch: 4 of 140 runs found the result) (A24); work of a just-died family kept spending (probe `r_noDeadRunning`, A22). | 3, 4, 5, 2 |
| C4 | **Judge panel, keys counted in providers** (rev 3). The charter names judges on distinct providers. A **key** is (i) a calibrated judge whose **provider** differs from the producer's provider, (ii) a passing check on the subject, or (iii) the owner. One key says no: a reject, a missed grade, an `audit_hold`. Two **distinct** keys say yes: `keep`/`promote`/`verified` on a produced node, `new_family` (the census is its producer), and `rep_change` (no producer: two judges on distinct providers, or one judge plus the owner). With two providers exactly one judge is eligible for any producer, so the second key is a check or the owner; nothing pretends a same-provider judge is independent. **Canaries** come only from an owner-provided known-answer set kept in the expedition store (outside every fence); none is derived from the repo. A miss marks the judge uncalibrated, voids its pending votes **and its strikes** (death is recomputed), and refuses its later judgments until the owner re-seats it. | V1 q3: G10–G12 rested on one seat. LLM judges prefer their own text (`external.md` §6). Critique: with V2's "two judges, neither the producer's seat", a producer on one of two providers left one eligible judge, so a "yes" could never commit; "seat" meaning tier would defeat the rationale. Strikes from a later-uncalibrated judge stayed in force, contradicting G16 (A23). Repo-derived canaries (case 9's 12 decisions, case 3's graveyard) are readable by tool-using judges, so they measured lookup, not calibration. | 1, 9, and G10/G11 for every case |
| C5 | **Anchored claims.** An artifact's load-bearing claims carry `{source digest, quote}`. A built-in host check (no LLM) verifies that the normalized quote occurs in the stored source bytes. Predictions can require an anchor pass rate. | V1's case 1 weak spot: a digest proves a fetch, not a read. An anchor proves that the cited sentence exists in the fetched page, per claim, at zero tokens. | 1, 9, 4 |
| C6 | **Sealed tree** replaces `scratch` (rev 3: one output tool). A sealed node gets **exactly one tool: the host-provided output tool** that takes its schema (the same schema-forced output that fixes the MALFORMED class, prior-art L-list), and nothing else. Its allowlisted inputs are inlined into the prompt. `plan_round` refuses a sealed node on a seat whose harness has no **verified single-output-tool mode** (a per-harness probe: the turn sees one tool, and a call to anything else is impossible, not merely refused). Sealed items do not `declare`; their family is assigned by the census (`classified`). `no-network` becomes advisory. | V1 q11: network denial on a scratch tree had no harness support. A turn whose only tool is the host's output sink cannot reach the network or the repo. Critique: V2's "no tools" also forbade the schema-output tool and `declare`, so case 4's R1 could return neither a schema artifact nor a family. | 4 |
| C7 | ~~Remote ssh pools~~ **Deferred** (rev 3). The design is kept in §3.6 q9 for the day a machine exists. | `use-cases.md`:218: no SSH worker pool is documented. About 40 lines and an invariant for a hypothetical resource. | — |
| C8 | **Quiet clock.** A tick never wakes the leader. `stalled` (no tool or usage activity for its window) does. Ordinary failures (`capped`, `malformed`, `turn_failed`) are batched to the round close. Only `blocked`, `cannot_run`, `dead_on_adopt`, or failure of at least ⅓ of a round's members wakes the leader. | V1's 30-min tick wake was past the 5-min cache TTL, so each one paid a full prefix write. Wide fans (case 1: 40 children) would otherwise wake the leader once per failure. | all; 3, 1 most |
| C9 | **Predictions carry an estimate.** A check prediction may state `estimate: number`. The grade records estimate against measured, and the per-family digest shows the ratio (theory vs real). | Case 3 asks to "measure theoretical vs real results". Case 4's Modal-Schur result (−18% iterations, +30% time) is exactly a theory/real gap. | 3, 4, 2 |
| C10 | **One path for structural change.** `rewrite_meta` and `propose_finish` are reflections only; the standalone acts are deleted. Rev 3: a `rewrite_meta` must change at least one non-done intent or graph (host diff check), and an `ask` counts toward G10 only when it names the missed predictions. | Two paths to the same change. Critique: an identical rewrite or a bare `ask` satisfied G10 (probe `r_rewriteChanges`). | simplicity, G10 |
| C11 | **Non-blocking `run_eval`.** `run_eval` returns a ticket; results arrive as a steer message (mid-turn on claude, next Buddy tool on codex: `harness-steering.ts`). An agent may hold `maxOutstanding` tickets. | Case 3 keeps 1–3 workers preparing variants while the GPU runs (`use-cases.md` §3). Case 5's serial cell and case 8's thinker otherwise sit idle through 10–30 min evaluations. | 3, 5, 8 |
| C12 | **Pre-planned rounds.** A meta-plan entry may carry a pre-written graph. When a round's predictions were all check-typed and all met, **its integration merged cleanly (C15), and the inbox holds no owner event**, the host records `continue` and opens the next pre-written graph without waking the leader, after re-running `plan_round`'s family and typing checks on it. A graph naming a now-dead family is dropped and the leader wakes. Any miss, any judged prediction, or any queued owner event waits for the leader. | Case 7 is "plan ahead and fan out" (`use-cases.md` §7). Critique: V2 let a pre-written round pass over a queued "stop doing X" (probe `r_autoNotOverOwnerMsg`) and claimed checks the model skipped. | 7, 6 |
| C13 | **Typed `blocked.needs`**: `redesign \| owner \| resource`, with an evidence ref. Nesting is declined by argument (§3.6 q10). | Case 5: V1 had a cell needing a redesign just "fail as blocked". The typed `needs` routes it: `redesign` names the cell's family as the next round's required focus, `owner` raises a gate, `resource` pauses that pool's work. | 5 |
| C15 | **Integration between rounds** (rev 3, new host step, no new noun). When `charter.integrate` is a branch, the host at round close merges each done candidate whose check passed onto the integration branch, serially in plan order (fast-forward when possible, else `git merge --no-ff`), and re-runs that candidate's check on the merged sha. The branch head becomes the next round's `base`; every item's tree resets to it. A conflict or a red re-check stops the merge at that candidate, raises `nodeBlocked{needs: 'redesign'}` with the conflict as evidence, and makes the round not met, so `auto_continue` cannot pass it. | Critique: every wave reset to the stale charter base and nothing integrated between rounds, so 30 slices met for the first time in one LLM integration turn, repeating "confirmed alone, stacked badly" and skipping "validate an immutable candidate, then integrate serially" (`use-cases.md`). Ablation A25. | 6, 7, 2 |
| C14 | **Family digest.** Briefs carry a host-rendered table (no LLM), one row per `(family, rep)`: verdict counts, best score, estimate/measured ratio, last evidence ref. It is capped at 40 rows and byte-stable between judgments. The knowledge custodian node writes the same fold into the repo's own file (KEY_LEARNINGS, the progression log). | V1 sent up to 40 raw judgment rows. A fold is denser and cache-stable, and "dense notes so ideas are not repeated" becomes a pure function of the judgments. | 3, 2, 4, 5 |

**Removed:**
- the named types `ParentPolicy` and `Grade` (now inline);
- the `ArchiveId` field;
- the standalone acts `rewrite_meta` and `propose_finish`;
- `Tree.scratch`;
- enforced `no-network`;
- the tick wake;
- rev 3: ssh pools (`Pool.where`, I29), repo-derived canaries and the "1 in 10" canary rate,
  `declare` as an authority, and "several open fans, one per lineage" (one open fan with L
  lanes reallocates by score on its own, §4).

### 0.1 Ship order, ranked by evidence (rev 3)

| Tier | Changes | Evidence | Ship |
|---|---|---|---|
| 1: cheap, evidenced, fixes a measured hole | C1 lanes, C3 (start/carve checks, death cancels, classified evals), C5 anchors, C8 quiet clock, C12 auto-continue (with its rev 3 guards), C14 digest, C15 integration | A15/A16/A22/A25 reproduce the holes (A27 only at a looser bound, §9); the tick and cold-seat costs are priced in §6 | first, in build order §8 |
| 2: evidenced, larger surface | C2 open-fan fold, C4 keys-in-providers (without canaries), C9 estimates, C10, C11 tickets, C13 typed `blocked` | V1 q3/q8 and case 3/5 text; A17/A23/A24/A26 | after tier 1 has run one real expedition |
| 3: unproven, gated on a probe | C4 canaries (only when the owner supplies a known-answer set), C6 sealed (only on a harness whose single-output-tool mode is verified) | no run has shown a drifting judge; no harness probe exists yet | when the probe or the set exists |
| deferred | C7 ssh pools | no machine exists | when one does |

**Kept on purpose**, with the reason:
- `extend_round` (≤ 2): case 2's exploit fix must land mid-round.
- The objective revision machinery (id + base CAS): it is V1's answer to G9.
- Parking: it answers cases 1 and 9.
- No `duel` or `integrate` kind (V1 rev 2).

## 1. Thesis

An expedition is one durable record with a **leader** that owns the owner's goal and wakes only on
events that need judgment. The leader keeps a loose **meta-plan** of round intents. At each round
it writes a small graph of typed nodes plus frozen, typed **predictions**. The **host** runs that
graph against one ledger of money, scarce evaluations and compute pools, local or remote. Fans run
their children in a few warm **lanes**, so width costs one cold start per lane, not per child. A
round closes into a grade written by the host and a **judge panel**, never by the leader, and the
leader then records one reflection: continue, revise, rewrite the meta-plan, propose a finish, or
ask. Two missed rounds force a structural change.

Ideas are **families** in the repo's own taxonomy. Nothing of a dead family may run: a death
cancels its work, and an evaluation is guarded by the family its diff is classified as, not the one
its author declared. Saying "this is new" or "this works" takes two independent keys (a judge on
another provider, a passing check, or the owner); saying "no" takes one, and in a family that has an
evaluator only a failed check says no. Between rounds the host integrates passing candidates, so
the next round builds on them. Inside a round the leader and owner can patch, steer, extend, cancel
or end.

Why this is still the right shape after critique:
- **Rounds stay.** Everything that varies across the nine cases is LLM judgment about which graph
  to run next. Everything that must not vary is a short list of host-enforceable rules, and V1
  showed it fits one Quint model.
- **What V2 changes is cost, not shape.** V1's weak cases were weak because of where tokens and
  trust went: cold seats per child, ticks past the cache TTL, one judge seat, checks only at plan
  time. Lanes, declare-before-spend and the two-key panel fix those without adding a node kind or
  a planner.

## 2. Concepts (12)

| # | Noun | One line |
|---|---|---|
| 1 | **Expedition** | One JSON record: charter, objective versions, meta-plans, rounds, judgments, ledger, phase. One write path. |
| 2 | **Charter** | The owner-signed fixed part: verbatim `userGoal`, objective v0, deadline, budget, pools, evaluators, limits, gates, seats with the judge panel, round limits, finish mode, family taxonomy. |
| 3 | **Objective** | Versioned criteria: v0 in the charter; later versions appended, either additive or owner-ratified. |
| 4 | **Leader** | The seat that plans and reflects. Asleep or awake; each wake is a reserved, bounded turn. |
| 5 | **Meta-plan** | A versioned, ordered list of round intents. An intent may carry a pre-written graph (C12). It keeps the charter gates. |
| 6 | **Round** | One graph of nodes plus frozen predictions; open, or closed with a grade and a reflection. |
| 7 | **Node** | One unit of work or judgment with forward-only state. Kinds: agent, fan, check, gate. Its output is an immutable artifact. |
| 8 | **Lane** (new) | A reused session lineage plus worktree that serves a fan's children one at a time. |
| 9 | **Gate** | A question only the owner answers. It holds no slot or round, and no deadline while parked. |
| 10 | **Ledger** | Money, named scarce evaluations, pool slots (local or remote), spent plus reserved. |
| 11 | **Event** | What wakes the leader, batched in an inbox. |
| 12 | **Judgment** | An append-only row written only by a check, the judge panel, a canary, or the owner. Claims, verdicts, scores and families are folds over these rows. |

**Honest count:** 12 nouns (V1 had 11, and Lane is new), 4 node kinds (unchanged), and **37 named
types** in §3.1, counted mechanically as `type X =` lines in the block: the same as V1.
- **Removed:** `ParentPolicy` and `Grade` (now inline) (−2).
- **Added:** `Lane` and `Anchor` (+2).
- **Folded into existing types:** the canary is a `Judgment` variant, blindness is a `Tree`
  variant, and a pool's location and a pre-written graph are inline fields.

A first draft had 39, with `Where` and `Graph` as named types; each was used once, so both were
inlined. The surface did not shrink. The variants grew (Judgment +3, Failure +1, Prediction +1),
and that is V2's real cost.

**Revision 3** adds no noun and no named type: integration is a host step, classification and
merges are `Judgment` variants (+3: `classified`, `merged`, `merge_conflict`), and the `llm` pool
is a `Pool` variant. It removes the ssh `where` field and the `canary` rate.

## 3. Spec

### 3.1 Types

These are written as the discriminated unions they become in Zod in `shared/src/expedition.ts`. An
optional field (`?`) appears only where absence is the meaning. Lines marked `// V2` changed.

```ts
// ---------------- fixed: owner-signed at launch; changed only by an owner amendment
type Charter = {
  userGoal: Markdown;
  objective0: { criteria: Criterion[]; open: Question[] };
  finish: 'on_met' | 'run_to_deadline';
  repo: { root: Path; baseRef: GitRef };
  deadline: { work: Hours; parkMax: Hours };
  rounds: { wallMax: Hours; extendsMax: number };
  budget: Budget;
  pools: Pool[];
  evaluators: Evaluator[];
  limits: Limit[];
  gates: GateSpec[];
  seats: Record<SeatTier, Seat>;
  judges: SeatTier[];                    // C4 rev 3: one per provider; keys are counted in providers
  knownAnswers: { t: 'none' } | { t: 'owner_set'; path: Path };   // C4 rev 3: the only canary source,
                                         // kept in the expedition store, outside every agent fence
  families: Path;                        // the repo's idea taxonomy (wave_sim KEY_LEARNINGS graveyard)
  integrate: { t: 'none' } | { t: 'branch'; name: string };   // C15: branch => host merges at round close
};
type SeatTier = string;
type Seat = { provider: Provider; model?: string; effort?: string };   // absent = provider default
type Budget = { usd: Usd; closeReserve: Usd; evals: Record<EvalName, Scarcity> };
type Scarcity = { t: 'unlimited' } | { t: 'count'; n: number };
type Pool =
  | { t: 'slots'; name: PoolName; cap: number }                        // local-gpu 1, compile-lock 1, cpu 3
  | { t: 'paid'; name: PoolName; cap: number; usdCeiling: Usd }        // modal: N concurrent under $ (launched locally)
  | { t: 'llm'; name: PoolName; cap: number };                         // rev 3: concurrent agent turns; generation
                                                                       // width is bounded by money and this cap, not local CPU
type Evaluator = {
  name: EvalName; argv: Argv; digest: Sha256; pools: PoolName[]; maxUsd: Usd; oracle: Path[];
  report: { t: 'exit' } | { t: 'json'; schema: Schema };   // json: usd, score, perInput, hold, head
  preflight: Argv;
};
type Limit = { t: 'enforced'; cap: 'no-paid-credentials' | 'no-gpu' | 'read-only' }   // V2 C6: no-network removed
           | { t: 'advisory'; text: string };
type GateSpec = { id: GateId; question: string; guards: 'finish' | 'land' | 'spend' };

// ---------------- the objective (unchanged from V1)
type Criterion =
  | { t: 'check'; id: CritId; eval: EvalName; pass: Predicate }
  | { t: 'judged'; id: CritId; rubric: Markdown }                   // V2: graded by the panel, not one seat
  | { t: 'owner'; id: CritId; question: string };
type ObjectiveVersion = {
  v: number; criteria: Criterion[]; open: Question[]; rationale: Markdown;
  basis: { t: 'charter' } | { t: 'additive'; over: number } | { t: 'ratified'; over: number; proposal: RevisionId; at: Time };
};
type PendingRevision =
  | { t: 'none' }
  | { t: 'awaiting'; id: RevisionId; base: number; proposal: ObjectiveVersion; label: string; evidence: Ref[] };

// ---------------- plan and rounds
type MetaPlan = {
  v: number; keeps: GateId[]; reason: Markdown; evidence: Ref[];
  rounds: { intent: Markdown; graph?: { nodes: NodeSpec[]; predicts: Prediction[] } }[];  // V2 C12: absent = the leader writes it when due
};
type Prediction =
  | { t: 'check'; eval: EvalName; on: Ref; expect: Predicate; estimate?: number }   // V2 C9: absent = no estimate made
  | { t: 'anchors'; on: Ref; minPass: number }                                      // V2 C5: host-graded
  | { t: 'judged'; claim: Markdown };                                               // panel-graded, one key
type Round = {
  n: number; intent: Markdown; predicts: Prediction[]; openedAt: Time; extends: number;
  base: Sha;                                                       // C15: integration head at open (charter baseRef for round 1)
  nodes: NodeId[];
  state:
    | { t: 'open' }
    | { t: 'closed'; how: 'all_ended' | 'wall_cap' | 'ended_by_leader' | 'ended_by_owner';
        grade: { met: boolean; hostOnly: boolean;
                 per: ({ t: 'host'; met: boolean; report: Ref; estimate: number | 'none'; measured: number | 'none' }
                     | { t: 'judge'; met: boolean; judgment: string }
                     | { t: 'unrun' })[] };
        carried: NodeId[]; reflection: Reflection }
    | { t: 'finished' };
};
type Reflection =
  | { t: 'pending' }
  | { t: 'continue'; by: 'leader' | 'host_auto'; why: Markdown }  // V2 C12: host_auto only after met + hostOnly
  | { t: 'revise_next'; why: Markdown }
  | { t: 'rewrite_meta'; plan: number; why: Markdown }            // V2 C10: the only path
  | { t: 'propose_finish'; why: Markdown }                        // V2 C10: the only path
  | { t: 'ask'; gate: NodeId; why: Markdown };

type NodeId = string;
type Ref = { node: NodeId; path: string[] };
type Node = { id: NodeId; rev: number; objV: number; carried: boolean; spec: NodeSpec; state: NodeState };
type NodeSpec =
  | { t: 'agent'; prompt: Markdown; inputs: Ref[]; seat: SeatTier; out: Schema; cap: Usd;
      pools: PoolName[]; tree: Tree; writes: Path[]; family: FamilyKey | 'none';   // 'none' refused when evals ≠ []
      evals: EvalName[]; maxOutstanding: number }                  // V2 C11
  | { t: 'fan'; source: FanSource; template: AgentTemplate; lanes: number;   // V2 C1: lanes replaces maxPar
      context: 'fresh' | 'carry'; rollAt: Tokens }                   // carry: lane session continues until rollAt
  | { t: 'check'; eval: EvalName; on: Ref; tests: { t: 'criterion'; id: CritId } | { t: 'diagnostic' } }
  | { t: 'gate'; gate: GateId | { t: 'adhoc'; question: string } };
type AgentTemplate = Omit<Extract<NodeSpec, { t: 'agent' }>, 'inputs' | 'family'>;
type FanSource =
  | { t: 'list'; over: Ref }
  | { t: 'open'; eval: EvalName; budget: Usd; plateau: number; topK: number };  // V2 C2: was 'population' + ParentPolicy + ArchiveId
type Tree =
  | { t: 'none' }
  | { t: 'cambium'; from: { t: 'base' } | { t: 'candidate'; ref: Ref } }
  | { t: 'sealed'; inline: Path[] };    // C6 rev 3: the host output tool only (schema = node.out); inputs inlined;
                                        // refused on harnesses without a verified single-output-tool mode
type Lane = {                           // V2 C1
  fan: NodeId; i: number; session: SessionRef; tree: Path; items: NodeId[]; tokens: Tokens;
  state: { t: 'idle' } | { t: 'busy'; node: NodeId } | { t: 'rolled'; into: number };
};
type NodeState =
  | { t: 'pending' }
  | { t: 'waiting' }
  | { t: 'running'; requestId: string; startedRev: number; reserved: Spend; journal: Path;
      lane: number | 'none'; funded: { t: 'ledger' } | { t: 'carved'; from: NodeId } }
  | { t: 'done'; out: Artifact; spent: Spend }
  | { t: 'failed'; why: Failure; spent: Spend }
  | { t: 'cancelled'; by: 'leader' | 'owner' | 'host'; why: string; spent: Spend };
type Failure =
  | { t: 'capped' } | { t: 'malformed' } | { t: 'turn_failed'; detail: string }
  | { t: 'dead_on_adopt' }
  | { t: 'blocked'; needs: 'redesign' | 'owner' | 'resource'; reason: string; evidence: Ref[] }   // V2 C13
  | { t: 'cannot_run'; detail: string }
  | { t: 'dead_family'; family: FamilyKey };                     // V2 C3: refused at start/carve, before spend
type Artifact = {
  digest: Sha256; store: Path; summary: Markdown; value: Json;
  candidate: { t: 'sha'; sha: Sha } | { t: 'none' };
  hypotheses: { family: FamilyKey; rep: RepKey; claim: Markdown; prediction: Markdown }[];
  claims: { text: Markdown; anchor: Anchor }[];                  // V2 C5
};
type Anchor = { source: Sha256; quote: string };                 // quote must occur in the stored bytes
type FamilyKey = string;
type RepKey = string;

// ---------------- judgments: append-only; agents never write them (I15)
type Judgment = {
  id: string; at: Time;
  by: { t: 'check'; node: NodeId } | { t: 'judge'; seat: SeatTier; node: NodeId } | { t: 'host' } | { t: 'owner' };
  subject: { t: 'artifact'; node: NodeId } | { t: 'hypothesis'; node: NodeId; i: number } | { t: 'family'; key: FamilyKey }
         | { t: 'seat'; tier: SeatTier };
  says:
    | { t: 'verified' }                                          // two keys (C4)
    | { t: 'accepted' }                                          // owner
    | { t: 'audit_hold'; why: string }                           // one key, or an evaluator report
    | { t: 'score'; fan: NodeId; value: number; perInput: number[] }   // check; the open fan's archive (C2)
    | { t: 'verdict'; v: 'keep' | 'promote' }                    // two keys
    | { t: 'verdict'; v: 'reject' | 'retune' | 'pivot' }         // one key; reject strikes only a family with no evaluator
    | { t: 'new_family'; key: FamilyKey; near: FamilyKey[] }     // two keys (the census is the producer)
    | { t: 'rep_change'; family: FamilyKey; from: RepKey; to: RepKey }   // two keys
    | { t: 'vote'; on: string }                                  // a pending first key, voided by a canary miss
    | { t: 'canary'; pass: boolean }                             // host: subject is the judge seat; owner set only
    | { t: 'anchors'; pass: number; of: number }                 // host: C5
    | { t: 'classified'; family: FamilyKey; rep: RepKey }        // rev 3 C3: one key, on the committed diff
    | { t: 'merged'; sha: Sha; recheck: NodeId }                 // rev 3 C15: host
    | { t: 'merge_conflict'; detail: string };                   // rev 3 C15: host; raises nodeBlocked{redesign}
};
// Strikes are a fold, not a field (rev 3): a strike is a failed check judgment in a family with an
// evaluator, or a reject verdict from a still-calibrated judge in a family without one, counted
// since the family's last rep_change. Dead = 2 strikes. A canary miss removes that judge's strikes
// from the fold, so death is recomputed, never sticky.

// ---------------- the record
type Spend = { usd: Usd; evals: Record<EvalName, number> };
type Ledger = { spent: Spend; reserved: Spend; live: Record<PoolName, number> };
type LeaderState = { t: 'asleep' } | { t: 'awake'; wake: number; reserved: Usd };
type Phase =
  | { t: 'draft'; issues: string[] } | { t: 'live' } | { t: 'paused' }
  | { t: 'parked'; since: Time; gate: NodeId }
  | { t: 'finished'; reason: FinishReason; verdict: 'none' | 'accepted' | 'rejected';
      report: { t: 'pending' } | { t: 'written'; ref: Ref } | { t: 'failed'; detail: string } };
type FinishReason =
  | { t: 'met_checks'; objV: number; sha: Sha } | { t: 'met_owner'; objV: number }
  | { t: 'deadline' } | { t: 'budget' } | { t: 'stopped' } | { t: 'setup_failed'; detail: string };
type Expedition = {
  charter: Charter; amendments: { at: Time; diff: Json }[];
  objectives: ObjectiveVersion[]; pending: PendingRevision;
  plans: MetaPlan[]; rounds: Round[]; lanes: Lane[]; judgments: Judgment[];
  answered: { gate: GateId; answer: Markdown; at: Time }[];
  finishProposal: { t: 'none' } | { t: 'proposed'; objV: number; summary: Markdown };
  ledger: Ledger; leader: LeaderState; inbox: Event[]; phase: Phase;
  clock: { work: Hours; wall: Hours };
};
```

### 3.2 Goals

G1–G15 are V1's goals. Rows marked V2 changed their mechanism.

| ID | Goal | By (mechanism) |
|---|---|---|
| G1 terminates, with a result | stops by the deadline; ends with a result or stated gaps | `tick` finishes at the work deadline and at the hard stop (Quint `terminates`, `hardStop`); `exhaust`; `close_report` from `closeReserve` |
| G2 late binding | round k is chosen after 1..k−1 ran and were reflected | `plan_round` and `auto_continue` require every closed round reflected (Quint `reflected`) |
| G3 outer reflection | after each round: continue, revise, rewrite, propose finish, or ask | `reflect`; V2 C10: rewrite and propose finish exist only here; C12 `host_auto` continue only on a met, host-graded, cleanly integrated round with no queued owner event (Quint `autoOnlyOnMet`, `autoYieldsToOwner`; both restate their guard) |
| G4 inner control | a running round can be patched, extended, steered, cancelled, ended | `patch` (CAS), `extend_round` ≤ `extendsMax`, `steer` (per-harness delivery), `cancel`, `end_round` |
| G5 dynamic width | width from runtime data | list fans over list-typed outputs (I5); open fans refilled by the host |
| G6 owner supreme | no leader act widens the charter; the owner can always interrupt | one `valid()` act table; owner acts are host commands |
| G7 durable | restart neither loses nor repeats work | journals + adoption (Quint `noRerun`, A5); **lanes are adopted with their node**: the lane's session id is in the node journal |
| G8 explainable | every structural change has a reason | append-only plans, objectives, reflections, judgments |
| G9 fidelity | v0 is the owner's; later versions trace to it | v0 in the charter; diff classification; ratify CAS on (base, id) |
| G10 progress, not activity | repeated misses force structural change | host/panel grades; two misses refuse `continue`/`revise_next` (Quint `g10`, A11); rev 3: a rewrite must change the plan (Quint `rewriteChanges`, restates guard) and an `ask` must name the missed predictions (❌ write-path check) |
| G11 no repeated ideas | nothing of a dead family runs without an accepted representation change | **rev 3 C3**: checked at plan, start and carve; an eval is guarded by its **classified** family; a death cancels the family's work (Quint `noDeadRunning`: A15, A16, A22; A27 only in a 4-eval variant ❌); a `rep_change` needs two keys (Quint `twoKey`, A17) |
| G12 independent judgment | no producer judges its own output | judgments only from checks, the panel, canaries, owner (I15); a judge key's **provider** ≠ the producer's provider; panel ≠ leader seat (Quint `noSelfJudge`, `twoKeyYes` A26) |
| G13 metered compute | scarce evals, paid runs, GPU reserved when spent | named counts and pools at start and per `run_eval` (I3, I3d) |
| G14 cheap by default | the leader is rarely awake; nodes are warm and read folds | **V2 C1, C8, C12, C14**: lanes (Quint `coldBound`, A20), no tick wakes, auto-continue, the family digest |
| G15 frontier throughput | a population keeps its pools busy without leader wakes, at a width money pays for | open fans refilled by the host; generators on the `llm` pool, not local `cpu`; lane rollover reallocates by score; generators decoupled from evaluations; non-blocking `run_eval` (C11) |
| G16 calibrated judges (V2) | a judge that fails known answers stops counting, **for votes and strikes alike** | owner-set canaries; an uncalibrated judge is refused and its pending votes, yes keys and strikes are void (Quint `twoKey` A18, `strikesCalibrated` A23) |
| G17 claims read, not just fetched (V2) | every load-bearing claim points at real text | anchors checked by the host against stored bytes (C5) ❌ |
| G18 enforced blindness (V2) | a blind node cannot see the repo or the network | sealed tree: only the host output tool, inputs inlined; plan refuses harnesses without a verified single-output-tool mode (C6) ❌ |
| G19 waves stack (rev 3) | round k builds on the integrated, re-checked candidates of rounds 1..k−1 | C15 host merge at close, re-check on the merged sha, next base = branch head; conflict ⇒ `blocked{redesign}`, round not met (Quint `stackedBase`, A25) ❌ merge code |

### 3.3 Invariants

"Quint ✅" means the invariant held in the simulated traces of §9 and, where an ablation is named,
the ablation violates it. "(restates guard)" marks an invariant that copies its guard. Every row
also carries the code guard still to be built (❌).

| ID | Invariant | Guard |
|---|---|---|
| I1 charter fixed | only an owner amendment changes the charter | ❌ write-path refusal of charter diffs outside `amendments` |
| I2 done immutable | a done artifact never changes | Quint `doneImmutable` ✅; ❌ write-once assertion |
| I3 budget safe | `spent + reserved ≤ usd − closeReserve` until finish, `≤ usd` always; same per eval count | Quint `budgetSafe` ✅ (A1); ❌ ledger test + kill at cap |
| I3a ledger exact | reserved = running reservations + awake wake; carving moves money, never mints it | Quint `ledgerExact` ✅; ❌ assertion in `ledger.ts` |
| I3b capacity | live work ≤ pool caps; gates and open fans hold no slot | Quint `capacity` ✅; ❌ scheduler test (remote pools included) |
| I3c cap margin | a node is killed when `usage + maxMessage > cap` | ❌ (V1 A1, q7) |
| I3d no unmetered compute | agent processes have no paid credentials or GPU; paid/GPU runs are `run_eval` children | Quint `ledgerExact` under `carve` ✅ (structure); ❌ agent env filter + test |
| I4 patch CAS | a patch commits only on a pending node at the revision read | Quint `specFrozen` ✅ (A2) |
| I5 typed fan-out | a list fan's `over` is list-typed | Quint `typedFanout` ✅ |
| I6 gates kept | every meta-plan keeps charter gates; a host finish has them answered | Quint `gatesKept` ✅ (A6, now on the reflection path) |
| I7a met on one sha | a host met names one sha passing every check criterion of the current version | Quint `metOneSha` ✅ (A8) |
| I7b owner met current | an owner met accepts a proposal under the current version | Quint `ownerMetCurrent` ✅ |
| I8 / I8a / I8b | objective fidelity; v0 signed; ratified as seen | Quint `objectiveFidelity` (A3), `v0Signed`, `ratifiedAsSeen` ✅ |
| I9 terminates | work deadline ⇒ finished; wall ≥ deadline + parkMax ⇒ finished | Quint `terminates`, `hardStop` ✅ |
| I10 work stops at finish | nothing pending, no work running, leader asleep | Quint `noWorkAfterFinish`, `leaderBounded` ✅ |
| I11 no rerun | no node started twice; restart adopts | Quint `noRerun` ✅ (A5); ❌ adoption of expedition nodes (L10) |
| I12 frozen yardstick | predictions frozen at open; evaluators run at their digest | ❌ write-path assertion + digest check |
| I13 providers distinct | a judge key's provider ≠ the producer's provider; panel ≠ leader seat; adversarial trios on three seats | Quint `noSelfJudge` ✅ (restates guard, judge half); ❌ `plan_round` test |
| I14 write fences | parallel agents have disjoint `writes`; **a lane's items are serial, so its fence is per item** | ❌ plan-time check + diff check |
| I15 no self-judgment | judgments only from host code paths | ❌ write-path assertion |
| I16 evaluator runs | every evaluator preflighted at plan time | ❌ `plan_round` test (`checks.ts:282` `ranOrNot`) |
| I17 no dead gate | no node waits on an answered gate | Quint `noDeadGate` ✅ |
| I18 gates hold no round | no uncarried pending node depends on a gate or a carried node | Quint `gateFree` ✅ |
| I19 rounds close | never open past `wallMax`; extends ≤ `extendsMax` | Quint `roundBounded`, `extendBounded` ✅ |
| I20 forced change | after two consecutive misses the reflection is structural | Quint `g10` ✅ (A11) |
| I21 reflection first | never more rounds opened than reflected + 1 | Quint `reflected` ✅ |
| **I22 nothing dead runs** (rev 3) | no running work belongs to a dead **declared** family, and no running evaluation to a dead **classified** family | Quint `noDeadRunning` ✅, **not** a restated guard: different actions break it (A15 plan-only check, A16 unchecked population carve, A22 strike without cancel; A27, an eval guarded by the declared family, only in a 4-eval variant ❌). V2's `noDeadSpend` was vacuous (its ghost was set only in the not-dead branch) and is deleted; ❌ start/carve check + cancel-on-death + `classified` before eval |
| **I23 two keys** (V2) | every committed rep change has two distinct judges on distinct providers, neither failing a canary before the commit | Quint `twoKey` ✅ (computed from logs; A17 one key, A18 canary without void); ❌ judgments test |
| **I23b two keys on a produced node** (rev 3) | every committed keep/promote/verified has two distinct keys; a judge key's provider ≠ the producer's and it had not failed a canary at the commit | Quint `twoKeyYes` ✅ (A26 = V2's tier-level seat rule); witnesses `w_noYes`, `w_noJudgeYes` show it commits with two providers; ❌ judgments test. `new_family` uses the same path (unmodelled) |
| **I30 strikes calibrated** (rev 3) | every live strike is a failed check (family with an evaluator) or a reject by a still-calibrated judge (family without one) | Quint `strikesCalibrated` ✅ (A23 canary keeps strikes, A24 judge strikes an evaluator family); ❌ fold test |
| **I31 waves stack** (rev 3) | a node of round r starts from an integration head containing every candidate merged before r | Quint `stackedBase` ✅ (A25 reset to charter base); ❌ scheduler test |
| **I32 rewrite changes** (rev 3) | consecutive meta-plan versions differ | Quint `rewriteChanges` ✅ (restates guard; A6); ❌ host diff check |
| **I33 auto yields** (rev 3) | `auto_continue` never fires with an owner event queued | Quint `autoYieldsToOwner` ✅ (restates guard; A21); ❌ act test |
| **I24 lane serial** (V2) | a lane runs one item at a time | Quint `laneSerial` ✅ (A19); ❌ scheduler test |
| **I25 cold bound** (V2) | cold session starts ≤ lanes declared (+ rollovers) | Quint `coldBound` ✅ (A20 = V1's per-child session) ; ❌ token-audit check on a real fan |
| **I26 auto only on met** (V2) | the host continues on its own only after a met, host-graded round | Quint `autoOnlyOnMet` ✅ (restates guard: `met` and `hostOnly` are nondeterministic at close, so the model checks the act's guard, not the grading; A21); ❌ act test |
| **I27 anchors real** (V2) | an anchor counts only if its quote occurs in bytes whose digest matches | ❌ host check test with a paraphrased quote and a swapped digest |
| **I28 sealed is sealed** (rev 3) | a sealed node's transcript holds no tool call but the host output tool | ❌ per-harness probe at plan time + transcript assertion at settle (any other tool use ⇒ `failed: malformed`) |
| ~~I29 remote runs the sha~~ | deferred with C7 | — |

### 3.4 Acts

One `valid(expedition, act, who)` table, as today's `ALLOWED` in `shared/src/expedition.ts`. Every
refusal is returned with its reason. V2 rows are marked.

| Act | Who | Requires | Otherwise |
|---|---|---|---|
| `plan_round(intent, predicts, nodes)` | leader (awake) | as V1, plus: sealed nodes only on seats with a verified single-output-tool mode (C6); `fan.context: carry` refused for sealed templates; `lanes ≤` the sum of the template's pool caps (generators draw on the `llm` pool); `family ≠ 'none'` on any node with `evals`; the round's `base` is the integration head | refused with every reason |
| `auto_continue` (V2) | host | leader asleep; **no owner event in the inbox**; latest closed round graded `met`, `hostOnly`, integrated without conflict; the next meta-plan entry has a `graph`; `plan_round`'s family and typing checks pass on that graph (modelled: the family check) | a failed check drops that graph; either way the leader is woken with `roundDone` |
| `integrate` (rev 3, C15) | host, at round close, `charter.integrate: branch` only | done candidates whose check passed, not yet merged | merges serially in plan order, re-runs each candidate's check on the merged sha (counted in the ledger like any check), records `merged`; a conflict or red re-check records `merge_conflict`, stops, raises `nodeBlocked{needs: redesign}`, grades the round not met |
| `extend_round(nodes)` | leader, owner | round open; `extends < extendsMax` (owner exempt); `plan_round` checks | refused |
| `patch(node, rev, ops)` | leader, owner | pending and `rev` matches at commit | refused as stale |
| `steer(node, msg)` | leader, owner | running agent | result names delivery: `mid-turn` / `next-buddy-tool` / `queued` |
| `cancel(node)` | leader, owner | pending, waiting or running | charged journaled usage |
| `end_round(reason)` | leader, owner | round open | members cancelled; carried and gates survive; graded |
| `reflect(decision)` | leader | latest closed round graded, unreflected; streak ≥ 2 ⇒ structural; `rewrite_meta.keeps ⊇ gates`; rev 3: a `rewrite_meta` changes at least one non-done intent or graph; an `ask` under streak ≥ 2 names the missed predictions; a `continue`/`revise_next` after a round with `blocked` items or a `merge_conflict` names, in the next graph, a node whose `inputs` include each one's evidence (the round's fix owner) | refused with the reason |
| `revise_objective` / `ratify` / `reject_revision` | leader / owner / owner | as V1 | as V1 |
| `accept` / `reject` | owner | as V1 | as V1 |
| `answer(gate, text)` | owner | any phase | unparks |
| `declare(family, rep)` (V2, advisory in rev 3) | non-sealed generator, first tool call | family in the taxonomy or judge-accepted; not dead | node ends `failed: dead_family` at ≈ 3k tokens. It saves spend; it is **not** what guards an eval (`classify` is) |
| `classify(candidate)` (rev 3) | a cheap judge seat, one key; the census for sealed items | a committed candidate sha **of a node with a family**, before any eval of it is carved or started. Objective checks of the integrated sha and familyless work are not idea evaluations and are never classified, refused or cancelled by a death | writes `classified{family, rep}`; an eval whose classified family is dead is refused `dead_family` |
| `run_eval(eval, sha) → ticket` (V2: non-blocking) | agent node | `eval ∈ node.evals`; the sha's **classified** family not dead; cap covers `maxUsd`; outstanding < `maxOutstanding`; scarce count; pools | refused with the reason |
| `judge(subject, says)` (rev 3) | panel judge | judge calibrated; judge's **provider** ≠ the producer's provider; judge ≠ leader seat. Two-key says commit when a second distinct key exists: another judge on another provider, a passing check on the subject, or the owner (`approve`); else recorded as a `vote` | refused, or recorded as a vote |
| `approve(subject)` (rev 3) | owner | a pending two-key say | the owner's key; commits with any one other key |
| `canary(seat)` (V2) | host | the charter has an owner known-answer set; a judge batch is being built (one canary per batch while the set lasts) | a miss writes `canary{pass:false}`, voids that judge's votes, yes keys **and strikes** (deaths recomputed), refuses its later judgments, and raises `judgeUncalibrated` |
| `finish_met`, `park`, `close_report`, `carve`, `start` | host | as V1, plus: `start` and `carve` refuse dead families (`dead_family`); a fan child needs an idle lane | as V1 |
| (strike) | host, inside the write that lands a failed check or a reject | the family's live strikes reach 2 | the family's pending and running work and evals are cancelled in that write, journaled usage charged |
| `reseat(judge, seat)` (V2) | owner | — | clears `uncalibrated` by replacing the seat |
| `pause`, `resume`, `stop`, `extend`, `note` | owner | as today (`host_command`) | — |

### 3.5 Events: what wakes the leader

| Event | Enqueued when | Wakes |
|---|---|---|
| `launch` | start | yes |
| `roundDone` | a round closed, with its grade | yes, **unless** `auto_continue` fires (C12) |
| `nodeBlocked` | `blocked` (with `needs`), `cannot_run`, `dead_on_adopt`, a `merge_conflict` (C15), or ≥ ⅓ of the round's members failed | yes (V2 C8; was every failure) |
| `familyDied` (rev 3) | a strike killed a family and cancelled its live work | no: batched into the round close, shown in the digest |
| `nodeFailed` | any other failure | **no**: batched into the round close |
| `carriedDone`, `plateau` | as V1 | yes (batched) |
| `stalled` | a running node shows no tool or usage activity for its window | yes |
| `judgeUncalibrated` (V2) | a canary miss | yes, and it is also shown to the owner |
| owner acts (`gateAnswered`, `revisionRatified`, …), `ownerMsg`, `budgetMark` | as V1 | yes, and while one is queued `auto_continue` does not fire (rev 3) |
| `tick` | the host clock | **never** (V2 C8) |
| `nodeDone`, `evalResult` | as V1; `evalResult` goes to the ticket-holding agent as a steer, not to the leader | no |
| `restart` | a boot finds the expedition live | yes |

### 3.6 Open questions

- q1 (V1: graph JSON or builder script). V2 answer: JSON graphs. The meta-plan may hold pre-written
  ones (C12); there are still no scripts.
- q3 (answered by C4, rev 3): keys are counted in providers. With two providers, a yes on a
  produced node is one cross-provider judge plus a check or the owner. With one provider no judge
  is a key on that provider's own output, so every yes needs a check plus the owner.
- q6 (statistical judge): an evaluator in the repo, as in V1.
- q7 (`maxMessage` per provider): open, as in V1.
- q8 (answered by C2): islands are `carry` lanes. Novelty is family-key dedupe plus the exact diff
  digest. **Embedding novelty is not adopted**: there is no embedding service in this repo. Shinka's
  ablation credits embedding rejection as a strong gain (`external.md` §2), so this is a real ❌ for
  case 4.
- q9 (deferred with C7): when a remote machine exists, the kept design is: push the candidate sha
  to `refs/expeditions/<id>/<node>`, run the evaluator over ssh in a detached checkout, require the
  report to echo `head` (mismatch ⇒ `cannot_run`), return the digest and report only.
- q10 (declined): no nesting. A nested expedition would add a second leader, objective and ledger.
  An open fan already has its own budget reservation, and `blocked.needs: redesign` routes the
  redesign to the next round. Re-open this if a case-5 run shows a cell's redesign needing more than
  one round of its own while other cells wait.
- q11 (answered by C6, rev 3): blindness by construction (the host output tool only), not by
  network policy. **No harness has a verified single-output-tool mode yet**; the probe is the first
  build step for C6 (tier 3). Until it passes on a harness, case 4 R1 runs on non-sealed `fresh`
  lanes and blindness is advisory, stated as such.
- **q12 (new): cache TTL for lanes.** The 1-hour TTL costs 2× on write but survives idle gaps.
  Which harnesses expose it? A `carry` lane does not wait for its evaluations (results arrive as
  steers), so it idles past 5 minutes only when starved of an `llm` slot; §6 prices that case.
- **q13 (rev 3): canaries come only from an owner-written known-answer set** stored in the
  expedition store, outside the repo, agent notes and every fence. Repo-derived items (case 9's 12
  decisions, case 3's graveyard rows) were dropped: a tool-using judge can look them up, so they
  measure lookup, not calibration. No detection rate is claimed. Open: will owners write such sets?
  If not, delete canaries (the §8 cut list already puts them first).
- **q14 (new): what tree reuse leaks between items.** Resetting a lane's tree keeps ignored files
  (build caches, which is the point, but also `output/`). Should each item get an `output/`
  subdirectory keyed by node id?
- **q15 (new): `context: carry` and independence.** Items in one lane are not independent samples.
  Should statistical claims ever pool items from one lane? Proposal: no. The prediction must name
  items from distinct lanes.

## 4. How work flows

**The loop.** One serialized `step(id)` per expedition, kept from `server/src/expeditions/host.ts`.
Each step:
1. applies owner commands;
2. finishes the expedition if it is due;
3. cancels orphans;
4. **starts** startable nodes: it reserves money, evals and pools, refuses dead families, and binds
   a fan child to an idle lane;
5. **carves** open-fan generators and evaluations, and queued `run_eval` tickets; an evaluation is
   carved only after its candidate is `classified` and its classified family is alive;
6. closes the round when every member has ended or the wall cap has passed, then:
   - **integrates** (C15): merges passing candidates serially onto the integration branch and
     re-checks each on the merged sha; a conflict stops it and raises `nodeBlocked{redesign}`;
   - grades check and anchor predictions by the host;
   - grades judged predictions by one panel turn, with owner-set canaries mixed in;
7. **auto-continues** if the round was met, host-graded and cleanly integrated, no owner event is
   queued, and the next pre-written graph passes the family and typing checks;
8. parks if the last reflection asked and nothing can move;
9. wakes the leader if a waking event is queued and a wake fits.

The leader acts through the expedition Buddy tool (`server/src/expeditions/tool.ts`) and then
sleeps.

**Lanes (C1).** A fan with `lanes: L` starts at most L sessions. When a round opens, the host
starts one **base session** per seat tier the round uses. The base holds the byte-stable prefix:
role, `userGoal`, the current objective, limits, the family digest and the round intent. Each lane
starts as a fork of that base. Claude forks natively; Codex emulates it by rollout copy (FOLLOWUPS
#4).

Each lane owns one Cambium tree, created once. For each item, the lane's tree is reset to the
item's base, which is the **round's base: the integration-branch head when the round opened**
(C15), or the item's parent candidate in an open fan (`git checkout -B <node-branch> <sha>`, clean of untracked non-ignored files, HEAD
verified, sanitized git env as in `cambium.ts`). The item then runs as a turn in the lane's session
and commits its candidate on its own branch.

The two context settings:
- **`fresh`** (slices, CRUD features, collection items): each item re-forks the base, so the cache
  read is about 0.1× of the prefix and no history is carried.
- **`carry`** (population islands): the session continues, so its lineage is its memory. Scores
  reach it as steer messages when evaluations return; the lane does not wait for them. The next
  item's parent is the host fold over **this lane's** scored candidates (the island), or the
  global top-k while the lane has none scored. It rolls over at `rollAt` tokens, or when its best
  sits below the fan's median for `plateau` items, into a new fork of the base seeded with the
  global top-k and the digest. Keep `rollAt` small (about 3 items): each item re-reads the lineage
  (§6).

A lane is adopted with its running node: the session id is in the node's execution journal.

**Parallel compute.** Pools are still the only concurrency knob:
- `cpu` = 3 (shells, builds, the free test suites);
- `local-gpu` = 1;
- `compile-lock` = 1;
- `modal` = 4 under a $ ceiling;
- **`llm`** (rev 3), e.g. 12: concurrent agent turns. Generators and other agents draw on it, not
  on `cpu`, so generation width scales with money and this cap. V2 put generators on `cpu` (3),
  which capped cases 3, 4 and 8 at about 3 lineages whatever the budget.

Remote ssh pools are deferred (C7, q9).

Generators and their evaluations are decoupled. An open-fan generator ends when it commits a
candidate. The host then carves the evaluation into whichever pool is free, and the lane starts its
next item at once. Agents doing deep serial work use non-blocking `run_eval` tickets (C11) and keep
working while evaluations run.

**Test-time compute, up and down.** The leader prompt carries an effort table (`external.md` §5).
Each row is a node shape with a judge, and the host enforces every row's mechanics:

| Difficulty | Shape | Judge | Lanes / width |
|---|---|---|---|
| Routine | a pre-written graph, `fresh` lanes, cheap seats; `auto_continue` while checks pass | host only | lanes = pool cap |
| Comparison | 2–4 agents, or an adversarial trio on three distinct seats | panel, one key | 3 |
| Frontier | one `open` fan, one `carry` lane per lineage on mixed seats; rollover moves budget to better lineages; sealed discovery first if blindness matters and a sealed harness is verified | evaluator scores; only failed checks strike; two keys (judge on another provider + check, or + owner) for any "yes" | lanes up to the `llm` cap, as money allows |
| Deep single problem (case 8) | a `fresh` list fan of independent derivations, each with its own tree and free test loop on `cpu`; a census ranks them by check results | checks; the scarce eval only on the census winner | 3–4 |
| Weak verifier (cases 1, 9) | width ≤ 4 (best-of-N is capped by its verifier, `external.md` §4) | panel (owner-set canaries if any) + owner gate | ≤ 4 |

Scaling up is the leader's structural reflection after a missed round: wider lanes, more lineages,
stronger seats. Scaling down is automatic, because met routine rounds auto-continue without the
leader.

**Knowledge so ideas are not repeated.**
- **Hypotheses.** Agents write them in their artifacts, keyed `(family, rep)` from the repo
  taxonomy.
- **Verdicts.** Judgments from the panel, with one key for "no" and two for "yes".
- **Two-strike dedupe** (C3) at plan time, at start, at carve (on the classified family), and
  early when a generator declares. A strike is a failed check where the family has an evaluator,
  a calibrated judge's reject where it has none. A death cancels the family's live work.
- **The family digest** (C14). The host renders it from the judgments, one row per family/rep:
  - verdict counts;
  - best score;
  - estimate/measured ratio;
  - last evidence ref.

  It goes into every brief's cached prefix and is rebuilt only when a judgment lands. One custodian
  node per round writes the same fold into the repo's own knowledge files through its fence (I14).
- **Sealed nodes** see none of it. The census classifies them afterwards (`classified`).

**Owner steering mid-run.** Unchanged from V1:
- bare commands are consumed by the host (`host_command`);
- other messages wake the leader;
- steer delivery is per harness (`server/src/buddies/harness-steering.ts`: `any-tool` for claude,
  `buddy-tool-only` for codex);
- patches use CAS.

New: `reseat` replaces an uncalibrated judge. When a judge misses a canary, the owner gets the
`judgeUncalibrated` event.

**Termination.** As V1:
- at the work deadline or hard stop, work stops in one step;
- checks, judgments, gate answers, the verdict and the closing report continue;
- budget exhaustion ends the run;
- `finish_met` or the owner's `accept` finishes it as met;
- `run_to_deadline` keeps searching after a full pass.

Lanes end with their fan. A rolled or idle lane's session is released at round close; a running
lane item is carried like any straggler.

## 5. The nine use cases in V2

Notation:
- `R1…` are rounds; nodes are written `kind×count`;
- `L` is the lane count;
- "1-key" and "2-key" are the panel rules.

Each case says what changed from V1 and where the tokens go.

**1. GTM research** (`gtm-evidence-thesis-buye-dd0984.json` becomes objective v0 plus meta-plan
v1; owner sign on launch).
- **R1 scope:** `agent×1` (strong) writes `Org[]` (25–40 organizations). Prediction (judged,
  1-key): "3–5 public incumbents exist".
- **R2 collect:**
  - shape: `fan(list: R1.orgs, L=6, fresh)` on a cheap seat; each item stores its page bytes and
    digests in the artifact store and returns source-ledger rows;
  - predictions (all host-graded): fetched rows ≥ 0.8 × planned, and **anchors pass ≥ 0.95** on the
    reduce's claims (C5);
  - tokens: 40 items share 6 warm sessions instead of 40 cold ones.
- **R3 synthesis:** one strong agent. Every claim is anchored (C5) and tagged
  VERIFIED/CLAIMED/SPECULATION.
- **R4 steelman/attack** (one round per pass, at least 3):
  - advocate and critic on two providers, adjudicated by the panel;
  - the thesis `keep` verdict is 2-key: the judge on the provider that did not write the thesis,
    plus an anchor-pass check on its claims (or the owner); a `reject` is 1-key;
  - G10 forces a structural change after two misses.
- **R5:** an audit agent (the panel re-opens decisive sources), the buyer-test packet, and a charter
  `gate`. The leader reflects `ask` and the expedition parks.
- **Weak spot, remaining:** a true quote can still be cherry-picked. Anchors prove the text exists,
  not that it is representative. Counterevidence search is still judgment.

**2. Game design** (room-runners-arena-lib, Tidewar).
- **R1 instrument:**
  - `agent×1` freezes the seed sets; the exploit hunter `agent×1` runs **first**;
  - evaluator `tidewar-ab` runs on pools `['compile-lock', 'cpu']`;
  - check predictions carry estimates (C9), e.g. "lever L raises lead changes by 0.8 ± 0.4".
- **R2:**
  - shape: `fan(list: levers, L=3, fresh)`, one lever family per item (`declare`);
  - judge: paired A/B with 16+ seeds plus mirror, sign test in the JSON report;
  - each lane reuses its tree, so incremental `cargo` builds stay warm in the lane's `target/` (the
    8-minute rebuild is paid once per lane, not once per lever).
- **R3:** the host has already integrated the confirmed levers serially at R2's close (C15), each
  re-measured on the merged sha, so a lever that only worked alone shows up as a red re-check
  (`merge_conflict` evidence), not in a final stacking turn. R3 re-measures the stack as a whole.
- **R4:** the playtest `gate`, carried.
- **Strikes:** levers have an evaluator, so a lever family dies on two failed A/B checks, not on
  panel rejects. A lever whose family died mid-round is refused at start or cancelled (C3).
- **Weak spot:** feel is a gate; the 1.227 skill gate stays a miss.

**3. wave_sim speed and accuracy** (M4 + Modal).
- **Charter:** `finish: run_to_deadline`. Pools: `local-gpu` 1, `modal` 4 under $, `llm` 8.
  Evaluators are R1–R12 plus matched error, each with a digest.
- **Each round:**
  - shape: one `open` fan, `L=6, carry` (six islands), strong generators on the `llm` pool;
  - a generator may `declare(family, rep)` first, and a graveyard family ends it at ≈ 3k tokens;
  - each committed candidate is `classified` before its evaluation is carved, so a relabelled
    "sidecar" of a dead family is refused at the eval whatever it declared;
  - the host carves evaluations into whichever of M4 or Modal is free; lanes move on while GPUs run,
    and lanes whose islands trail the median roll over onto the global top-k.
- **Holds and stop rules:**
  - an evaluator `audit_hold` above 10× is lifted to `verified` by two keys: a judge on the other
    provider after a reproduction, plus the reproduction's passing check (or the owner);
  - only failed evaluator checks strike these families; a panel reject is a verdict in the digest,
    not a death.
- **What the leader sees:** it wakes on `plateau`, `stalled` or `blocked`, never on a tick. The
  family digest shows estimate/measured per family, which is the "theoretical vs real" record.
- **Weak spot:**
  - the evaluator is still wave_sim's 7:1 custody tooling;
  - `carry` lanes re-read their lineage each item; `rollAt` ≈ 3 items bounds it (§6, q12).

**4. Frontier math to algorithms** (Astra packet).
- **R1 blind discovery:** sealed generators on a harness whose single-output-tool mode is
  verified (C6; until then non-sealed and blindness is advisory). Inputs inlined:
  `MINIMAL_PROBLEM.md` plus hardware facts.
  - shape: `fan(list: lineages, L=lineages, fresh)`, so each sealed item is independent (no `carry`:
    a carried session would leak lineage between "independent" runs); width is the `llm` cap;
  - each item returns, through the output tool, a derivation, an algorithm sketch, and a labelled
    claim set (TEXTBOOK/LITERATURE/DERIVATION/CONJECTURE); it does not declare a family;
  - the evaluator digest is frozen in the charter.
- **R2 census:** a panel-seat reduce clusters candidates, writes `classified` per item and proposes
  `new_family` rows. A `new_family` is two keys: a judge on the provider that did not run the
  census, plus the owner (or, once R3 has run, a passing falsifier check).
- **R3 implement-and-falsify:** `open` fans per selected family (`carry` lanes, not sealed), with
  one GPU falsifier per candidate. Median, not max, is reported.
- **R4:** the panel adjudicates. Any "this is new and works" is 2-key; a no-go or lower bound is a
  valid finish.
- **Weak spot, remaining:**
  - no embedding novelty (q8);
  - Codex cannot be a sealed seat (q11);
  - FunSearch's 4/140 says rare wins need many lineages. With the `llm` pool, lineages are capped by
    money and that cap, not by local CPU; and since only failed falsifier checks strike, one judge's
    "no" cannot kill a lineage that has not been measured.

**5. New capabilities** (R6 forces, R7 bodies, R8 sand, R9 wind × engines E/A/Dual).
- **Shape:** the meta-plan is the matrix. Each round is a `fan(list: cells, L=#engines, carry)`, so
  a lane stays on one engine and keeps that engine's context across rows.
- **Inside a cell:**
  - one agent with non-blocking `run_eval` (C11), `maxOutstanding: 2`;
  - `evals: { 'paid-replay': count 1 }`;
  - the cell's output is the repo's `Cell` status schema.
- **Redesign:** a cell that needs one fails `blocked{needs: 'redesign', evidence}` (C13). The next
  round runs an `open` fan for that cell's family while the other cells continue as carried nodes.
- **Weak spot:** no nesting (q10). A redesign that needs several rounds holds the meta-plan's
  attention while other cells only progress as carried stragglers.

**6. Deslop buddies.**
- **R1 measure:** `fan(list: scans, L=4, fresh)`, read-only, cheap seats, then a reduce.
- **R2 target:** a strong agent writes the lean target and `Slice[]` with fences and budgets, and
  **pre-writes the slice-wave graphs** into the meta-plan (C12).
- **R3… waves:**
  - shape: `fan(list: slices, L=6, fresh)`; each item resets its lane tree to the **integration
    head** and runs its check on its candidate sha, never the dirty tree (closes 48724f4);
  - at each wave's close the host merges the green slices serially onto `integrate.branch` and
    re-checks each on the merged sha (C15), so wave k builds on waves 1..k−1;
  - waves auto-continue while every check and every merge is green; a red check or a conflict
    wakes the leader with the evidence, and its next graph must own it (fix-owner rule, §3.4).
- **Landing:** the branch is already integrated and checked; a `land` gate. No integrator agent.
- **Weak spot:** V2 makes a 3–4× cut cheaper to attempt, not more likely. The target is still LLM
  judgment.

**7. CRUD SaaS.**
- **Shape:** every round is pre-written. Each round is a `fan(list: features, L=pool, fresh)` on
  cheap seats with integration tests as checks, reset to the integration head, merged and
  re-checked by the host at close (C15). The leader typically wakes about 3 times: launch,
  a red wave, and the walkthrough gate.
- **Weak spot:** it is still more machinery than a Workflow script. V2 narrows the gap, since with
  `auto_continue` the run is a fixed pipeline that becomes a reflective one only on failure.

**8. Geometry engine** (wave_sim `studio/design_kernel`).
- **R1:** a strong agent derives conditions (e.g. the bore-cap refusal at r > √(3.75²−2²)−2.5) as
  hypotheses; the panel attacks the derivation.
- **R2 (rev 3: parallel derivations):**
  - `fan(list: approaches, L=3–4, fresh)`: each item is an independent derivation-and-implementation
    of the same conditions, in its own lane tree with the free bun suite in its shell under `cpu`,
    iterating against that suite at no ledger cost;
  - a census check-grades the items: each candidate's bun-suite result is a check judgment, and the
    census ranks by them; the single `g0-replay` is spent only on the winner, as a `run_eval` ticket
    (C11) so the census agent keeps working;
  - a reviewed candidate stays a `done` node with its sha, so acceptance can resume by ref (the
    oompa `cf9ea773` failure).
- **Weak spot:** the approaches list is the leader's judgment; if all four share one wrong
  assumption, width does not help. `verified` is the cross-provider judge plus the g0-replay check.

**9. Document-model design.**
- **Each round:** an adversarial trio (critic reads G01–G12 and A94), an adjudicator, and a gate per
  batch of owner questions; the expedition parks.
- **Anchors (C5):** every claim that the proposal covers a ledger row anchors to that row's text.
  Every "Zoo/Onshape can do X" claim anchors to a stored source.
- **Canaries:** none by default. The 12 historical owner decisions live in the repo and agent notes,
  so a judge can look them up (q13). If the owner writes fresh known-answer items into the
  expedition store, those are the canaries.
- **Width (rev 3):** two or three independent critics in a `fresh` list fan over the ledger's
  sections, then the adjudicator; this is the case's parallel spend.
- **Weak spot, remaining:** whether a design is good is judgment. A judge on another provider plus
  the owner is better evidence than one judge, not proof. The owner criterion "replaces the running model, with a retirement
  plan" stays the only finish.

## 5b. Scaling example

This section applies the width rule in `research/scaling.md` §4 to V2. It is numbered 5b so that
§6–§11 keep their numbers. Numbers are labelled **measured** (from `use-cases.md` or the papers)
or **estimate** (from §6, which are guesses, not measurements).

**Who decides width.** The leader decides, in `plan_round`: a fan's `lanes`, its `context`, and
the list it fans over. A list's length comes from runtime data (G5, I5). The §4 effort table
guides it, but the table is LLM judgment in the leader prompt. The host enforces only hard
limits: `lanes ≤` the template's pool caps (§3.4), the ledger (I3), scarce eval counts (G13) and
the open fan's own `budget`. There is no host formula for width. Inside a round, the host moves
work between the fixed lanes: an idle lane takes the next item, and a trailing `carry` lane rolls
over onto the global top-k (C2). Changing the lane count needs the leader: a structural
reflection, or `extend_round` (at most `extendsMax`).

### Rule map

| # | Rule (`scaling.md` §4) | V2 mechanism | Host or LLM |
|---|---|---|---|
| 1 | Wide only on decomposable work | The leader picks `agent` (width 1) or a `fan`. I14 requires disjoint `writes` fences for parallel agents. ❌ Nothing checks that a fan's items are independent. Only the fences catch coupling, and only coupling through files. | LLM judgment; fences host-enforced |
| 2 | Never wide without a central verifier | Open fans are scored only by their evaluator (`FanSource.open.eval`, C2). C15 merges only candidates whose check passed. "Yes" takes two keys (C4, I23b). Agents never write judgments (I15). ❌ `plan_round` does not refuse a **list** fan with no check, anchor or judged prediction on its items. A downstream node can take an unchecked artifact as `inputs`. Would need: a plan-time rule that every fan carries a prediction on its items. | Host for open fans; LLM for list fans |
| 3 | Coordinate centrally, preassign, rebalance stragglers | One serialized `step(id)` (§4). Items bind to whichever lane is idle (`start`, §3.4), so fast lanes take more items. Evals are carved into whichever pool is free. `wallMax` closes the round and carries stragglers (I19). Agents cannot message each other; only the leader and owner `steer`. This rebalances **queued** items, not stragglers. `stalled` only wakes the leader, and the response is its choice. ❌ No hedging: an in-flight eval (e.g. a 10.5–29 min M4 run on the single `local-gpu` slot, measured) is never duplicated onto a free pool or rerouted. Would need: a host rule that re-carves a straggling eval onto a free pool and keeps the first result. | Host for queueing; LLM for `stalled`; ❌ hedging |
| 4 | Share selectively through one store | One record with append-only `judgments` (§3.1). The open fan's archive is its `score` rows (C2). The family digest (C14) is a host fold in every brief's prefix. Dedupe is by family key plus diff digest (q8). Carved evals are guarded by the `classified` family (C3). ❌ A `fresh` lane forks the round's base, so mid-round judgments reach its items only if the base is rebuilt; §4 does not say it is. ❌ No embedding novelty (q8). | Host |
| 5 | Respect the ~45% ceiling | ❌ None. Check judgments already give a per-family pass rate. Would need: a host fold of single-lane pass rate per unit, plus a `plan_round` refusal (or required reason) for `lanes > 1` above 45%. | — |
| 6 | Width is earned from the verifier | The §4 effort table: weak verifier ⇒ width ≤ 4; frontier with an evaluator ⇒ lanes up to the `llm` cap. Evaluators must preflight at plan time (I16). Adding one mid-run is a charter change, so it needs the owner (I1). ❌ The ≤ 4 cap for judged work is not in `valid()`; only pool caps are. So §4's sentence "the host enforces every row's mechanics" overstates it: the host enforces each row's node shapes and judges, but the width column is advice. Would need: refuse `lanes > 4` on a fan whose template has no `evals`. | LLM judgment; preflight host |
| 7 | Budget against measured speedup | The ledger records spend per node (`Spend`); per-unit spend is recorded (§7). ❌ Nothing folds tokens per **verified** result, and nothing narrows when it stops improving. `plateau` measures score, not cost. Would need: a host fold `spend / verified` per fan in the digest, and an event when it worsens over N items. | — |

### Worked example A: wide, case 3 (wave_sim speed and accuracy, M4 + Modal)

1. **Charter (owner).** As in §5 case 3: pools `local-gpu` 1, `modal` 4 under a $ ceiling, `llm` 8.
   Evaluators are R1–R12 plus matched error, each with a digest (I12). `families` points at
   `KEY_LEARNINGS.md`, whose graveyard has about 30 refuted rows (measured, `use-cases.md` §3).
   `finish: run_to_deadline`.
2. **Width chosen.** The leader plans one `open` fan with `L=6, carry`. That fits under `llm` 8, so
   `plan_round` accepts it. Rule 6 allows going wide, because the evaluator is exact and numeric.
   Real throughput is bounded by **evaluation**, not generation: at most 1 + 4 = 5 evals run at once.
   A ridge run on the M4 takes about 10.5–29 min (measured). A Modal smoke took 157.8 s, of which
   1.1 s was compute and 38.5 s dependency install (measured). Those are eval times; no generator
   item wall time is measured. Whether six lanes keep five eval slots busy is therefore an
   **estimate**: it holds only if a lane commits a candidate at least as often as an eval slot
   frees. If generation is slower, the evals idle; if faster, more lanes would queue behind the
   pools.
3. **The verifier.** Each committed candidate is first `classified` (C3), then its eval is carved.
   A dead family is refused at the eval, whatever the generator declared. A speed claim needs the
   matched-error gate (`matchedErrorSpeedup=false` until an audit passes) and an ABBA pair, because
   a noisy baseline once gave a false 0.842× (measured). Each check prediction may state an
   `estimate` (C9). The grade stores estimate next to measured, and the digest shows the ratio per
   family: that is the "theoretical vs measured" record. Any `audit_hold` above 10× becomes
   `verified` only with two keys (judge on the other provider after a reproduction, plus its check).
4. **Sharing.** Lanes never talk to each other. Each `carry` lane gets its own lineage's scores as
   steers. A rollover reseeds from the global top-k and the digest (C2). A custodian node writes the
   same fold into `KEY_LEARNINGS.md` through its fence (C14). Only check failures strike these
   families, so one judge's "no" cannot kill an unmeasured idea (C3c).
5. **Stragglers.** A lane does not wait for its evals (C11); it starts its next item at once. An
   eval goes to whichever of M4 or Modal frees first. An island below the fan median for `plateau`
   items rolls over, which moves budget without a wake. A silent lane raises `stalled`. Work left at
   `wallMax` is carried into the next round.
6. **Local vs remote.** Generators run on `llm`. Agents hold no GPU or paid credentials (I3d), so
   every GPU second is a `run_eval` child on `local-gpu` or `modal` and is charged to the ledger.
   ❌ No other remote machines: ssh pools are deferred (C7, q9).
7. **Grow and shrink.** Within a round L is fixed and the host only reallocates. On `plateau` or a
   missed round, the leader may widen (more lanes, up to `llm`) or narrow in its reflection. ❌ No
   cost signal drives that choice (rule 7).
8. **Token shape per verified result (estimate, §6).** One generator item costs about 90–106k
   strong-equivalent tokens, mean about 117k with one cache miss per three items. Classification
   adds about 1k. A graveyard idea stops at about 3k if declared. Per round add one base session
   (about 25k), and about 25k per leader wake. If a fraction `p` of items pass matched error,
   tokens per verified result ≈ 118k / `p`, plus eval dollars. `p` is not measured. The naive loop
   pays about 214k per *new* idea (estimate, §6), before any verification.

### Worked example B: narrow, then widen: case 8 (geometry kernel)

1. **R1, width 1.** Deriving the conditions (e.g. the bore-cap refusal at r > √(3.75²−2²)−2.5) is a
   sequential argument, so rule 1 says width 1: one strong `agent`. Its verifier is the panel
   attacking the derivation. That is judgment, and a judged prediction is one key, so a "no" counts
   and a "yes" does not commit (C4). Widening here would buy more unverified derivations (rule 2).
2. **Invest in the exact check first.** Case 8 already has one: the guarded known-answer boundary
   suite (268,435,456 B RSS cap, 60 s). G1's validator ran 65 checks in 2.776 s (measured). If the
   check is missing, building it is the round's work. It becomes an `Evaluator` only through an
   owner amendment (I1), with a digest (I12) and a preflight (I16).
3. **The trigger.** Width rises when an evaluator for the unit is in the charter **and** its
   preflight passes at `plan_round` (I16). Then the leader may plan R2 as
   `fan(list: approaches, L=3–4, fresh)`, the §4 "deep single problem" row. Each item iterates
   against the free bun suite on `cpu`. The scarce `g0-replay` (count 1) runs only on the census
   winner, as a ticket (C11). The trigger is effectively **LLM judgment**, as in V1. Preflight only
   proves the evaluator runs; nothing in `valid()` ties fan width to an evaluator's existence, so
   the leader may widen without one or stay narrow with one. ❌ Would need: the rule-6 refusal above.
4. **Rule 5 (45% ceiling): ❌.** If one derivation already passes the suite about half the time,
   rule 5 says do not add lanes. V2 has the data (check judgments per item) but no fold or refusal,
   so this rests on the leader reading the digest.
5. **Rule 7 (narrow when tokens per verified result stop improving): ❌.** There is no fold of
   spend per passing candidate. The only width bound beyond pools is the §4 row (3–4). The §5 weak
   spot stands: if all four approaches share one wrong assumption, width does not help.

### Mixed: case 1 (GTM)

Wide collection: R2 is `fan(list: orgs, L=6, fresh)` on a cheap seat over 25–40 items. Its verifier
is host-graded at zero tokens: fetched rows ≥ 0.8 × planned, and anchors pass ≥ 0.95 (C5). The
shared store is the artifact store of page bytes plus digests. Synthesis is narrow: one strong
agent. The steelman/attack duel runs at width ≤ 4 (weak verifier) with a 2-key `keep`. Collection
costs about 0.19M tokens (estimate, §6).

### Verdict

- **Scales well:** frontier search with an exact evaluator (case 3, and case 4 once its falsifier
  exists). The host refills open fans, moves budget by rollover, and guards evals by classified
  family, with no leader wake per refill. Decomposable code waves also scale (cases 6 and 7):
  lanes plus integration at each close (C15).
- **Caps out:** eval pools, not lanes (`local-gpu` 1 + `modal` 4 in case 3). One open fan per round
  (rev 3). Width changes mid-round only through a leader wake or `extend_round` (≤ `extendsMax`).
  No ssh machines (C7).
- **Blind spots:** rules 5 and 7 have no mechanism, and rule 6's ≤ 4 cap for judged work is advice,
  not a refusal. Width is therefore set by LLM judgment, and limited only by pools and money.
- **Smallest change to raise the ceiling:** one host fold, tokens per verified result per fan,
  shown in the family digest (C14). It would raise `plateau` when the value worsens over N items.
  It adds no noun and no type, and it gives the leader the cost signal that rules 5 and 7 need.

## 6. Token and wall-clock economics

**Where tokens go.** Input dominates, at a ratio of 7–13:1 (`prior-art.md` §7), so V2 attacks
input:
- **cold starts:** lanes and warm base forks (C1);
- **leader wakes:** no ticks, batched failures, auto-continue (C8, C12);
- **re-sent history:** the family digest is a byte-stable fold, not rows (C14);
- **wasted generations:** declare-before-spend refuses a dead family at about 3k tokens, before
  code is written (C3).

The two-key panel adds tokens only on "yes" judgments, and the second key is usually a check
(zero tokens) or the owner. Rev 3 adds one cheap `classified` judgment per evaluated candidate
(≈ 3–5k cheap-seat tokens on a diff, ≈ 1k strong-equivalent), and integration re-checks cost
evaluator time, not tokens. Canaries cost one item per judge batch only when an owner set exists.

**What runs without an LLM:**
- scheduling, the ledger, lanes, CAS, gates, parking;
- `auto_continue`;
- every check, score and anchor verification;
- the family digest;
- dedupe by key and diff digest;
- integration (merge, re-check, conflict routing);
- cancel-on-death and the strike fold;
- adoption.

**Relative cost against a naive single-agent loop.** These are estimates, not measurements. Units
are strong-seat fresh input tokens:
- cheap seat = 0.2×;
- cache read = 0.1×;
- output = 5× input;
- cold seat = 25k;
- a warm fork = the cache read of a 25k prefix plus a 5k item brief ≈ 7.5k.

The V1 column is V1 §6's number (cold seats).

| Case | Naive loop | V1 (cold) | V2 | V2 / naive |
|---|---|---|---|---|
| 1 GTM | ≈ 1.5M; did not finish phase 1 in 6 h | ≈ 1.6M (1.0–1.3×) | collect 40 × (7.5k + 16k pages) × 0.2 ≈ 0.19M; synthesis 0.12M; 3 trio rounds 0.3M; panel grading 0.05M + 2-key thesis verdicts 0.04M + canaries 0.01M; anchors 0; leader 6 × 25k = 0.15M (no ticks); outputs 0.5M → **≈ 1.36M** | **≈ 0.9×** |
| 3 wave_sim, 8 h | one agent, ≈ 150k per idea, ≈ 8 ideas, ≈ 30% repeats | ≈ 165k per idea, plus ≈ 0.4M of unpriced 30-min tick wakes | per item, from the formula below: ≈ 90–106k without cache misses, + 31–81k per miss, mean ≈ 117k at one miss per three items; plus classification ≈ 1k; dead families refused at ≈ 3k (declare) or at the eval (classified); leader only on plateau/stall/blocked | **a guess: ≈ 0.6–0.8× per new idea** (naive pays ≈ 214k per *new* idea at 30% repeats), most of it from not repeating graveyard ideas, less from lanes |
| 6 deslop | 30 slices × 60k ≈ 1.8M | ≈ 2.85M (1.5–1.6×) | measure 0.1M; plan 0.15M; base sessions 5 waves × 25k = 0.125M; 30 × (50k + 7.5k) = 1.73M; integration by the host 0 (rev 3; was a 0.2M integrator agent); leader 4 wakes 0.1M plus ≈ 2 conflict wakes 0.05M → **≈ 2.25M**; ≈ 1.5M when half the slices are mechanical deletions on a cheap seat | **≈ 1.25×** (strong seats), **≈ 0.85×** (mixed seats) |

**Case 3's per-item cost is a function of lineage length, not a constant** (critique). For item k
of a `carry` lane (k = 1 after a rollover), with prefix P ≈ 25k, lineage growth h ≈ 20k per item,
m ≈ 4 model calls per item that re-read the context, cache read 0.1×, a 5-minute cache write 1.25×,
and G ≈ 80k of fresh work per item (new tool output and the item's own reasoning, output-weighted):

  cost(k) ≈ G + m·0.1·(P + (k−1)·h) + miss·1.25·(P + (k−1)·h)

where `miss` = 1 if the lane sat idle more than 5 minutes before item k (starved of an `llm` slot;
evaluations do not cause it, since the lane does not wait for them) and 0 otherwise. With miss = 0:
k=1 ≈ 90k, k=2 ≈ 98k, k=3 ≈ 106k; a miss adds ≈ 31k, 56k, 81k at k = 1, 2, 3. The table's ≈ 117k
mean assumes one miss per three items, at k=2. These are guesses from `prior-art.md` §7's ratios, not measurements; the
lane token-audit test (§8) is what would replace them. The rule they imply: keep `rollAt` at about 3
items, and size the `llm` pool so lanes do not starve.

**Wall clock:**
- case 1: about 2–3 h of work plus parked owner time;
- case 3: about 4–6× more ideas per hour than one serial agent, bounded by GPU money;
- case 6: about 3–5× (waves of 6).

**Honest summary.** V2 brings case 6 from 1.5–1.6× to about 1.3×, and below 1× with seat routing
(rev 3's integration removes the 0.2M integrator agent and adds re-check evaluator time). It brings
case 1 to about parity and case 3 somewhat below naive, by a margin that is a guess. It removes V1's
unpriced tick cost. The new spend, two-key judging and classification, is under 5% of a run.

## 7. Comparison

| | Claude Code Workflows | oompa | V1 | V2 |
|---|---|---|---|---|
| Plan | JS fixed at launch | self-claimed queue | per-round graph after a graded reflection | same, plus pre-written graphs that auto-continue while met (C12): a Workflow's fixed pipeline when green, a reflective one when red |
| Width cost | each `agent()` call is a fresh context | one session per worker cycle (cold) | one cold seat per fan child | **one cold start per lane**, warm forks per item (C1) |
| Typed outputs | `agent(schema)` | text signals (130/154 errors) | schema per node | same |
| Search | whatever the script codes | none | host-refilled population (unmodelled policy) | open fan: fixed top-k fold, `carry` lanes as islands that roll over by score, evals guarded by the classified family |
| Judges | whatever the script codes | one reviewer model | one judge seat | **panel**, keys counted in providers: two independent keys (judge on another provider, check, owner) to say yes; only checks strike measurable families |
| Integration | whatever the script codes | serialized merges | an integrator agent at the end | host merge + re-check at every round close (C15) |
| Remote compute | none | none | Modal only | Modal only (ssh deferred) |
| Durability | session-scoped, resume by prefix | event files | journals + adoption | same; lanes adopted with their node |
| Owner | none mid-run | pause file | commands, gates, parking, ratification | same, plus `reseat` |

**Taken from Workflows:**
- schema-forced outputs;
- `pipeline` semantics;
- a hard budget;
- "done nodes are reusable by ref";
- **the fixed pipeline itself, as `auto_continue` while green.**

**Taken from oompa:**
- one worktree per code lane;
- serialized integration;
- typed `blocked`;
- seat tiers;
- fingerprint suppression;
- **one long-lived worker session per lane (oompa's resume loop), now with a fence per item and
  without its text protocol.**

**What V2 does better than both:**
- the plan changes mid-run on graded evidence;
- trust in "yes" is structural (two independent keys, never two runs of one provider);
- dead ideas stop at the spend point, and a death cancels what is already running;
- per-unit spend is recorded.

## 8. Implementation sketch (buddies)

**Reused as is.** All of V1 §8's reused list:
- `record.ts`, `host.ts` `serialized`/`commit`;
- `cambium.ts` (now called once per lane);
- `checks.ts` with `ranOrNot`;
- `seatOf`, `host_command`, idempotency keys;
- `server/src/buddies/harness-steering.ts` (delivers `evalResult` steers);
- `server/src/lifecycle/adopt-executions.ts`;
- the lease/deadline split.

New reuse: native/emulated forks (`providerSupportsFork`, `server/src/conversations/runtime.ts`)
for lane bases.

**Replaced:** as V1. In addition, `shutdown.ts` `discardCrewTurns` (`server/src/lifecycle/shutdown.ts:110`)
is deleted, because nodes and their lanes are adopted.

| File | V1 budget | V2 budget | Why it moved |
|---|---|---|---|
| `shared/src/expedition.ts` | 311 → ~640 | 311 → ~660 | same named-type count; +`Lane`, `Anchor`, more variants |
| `server/src/expeditions/scheduler.ts` | ~420 | ~520 | +lane binding, tree reset per item, auto-continue (inbox + family guards), start-time family check, cancel-on-death, **integration step** (merge, re-check, conflict, ~50) |
| `ledger.ts` | ~140 | ~140 | — |
| `leader.ts` | ~260 | ~240 | no tick wakes; failure batching is simpler than per-failure wakes; digest rendered elsewhere |
| `acts.ts` | ~240 | ~230 | two acts removed; `declare`, `reseat` added |
| `judgments.ts` | ~110 | ~210 | +panel keys (provider rule, check and owner keys), canary rows and void, the strike fold, `classified`, the family digest fold |
| `population.ts` | ~180 (riskiest) | **~90** | parent policy is one fold; lanes carry the session work; the archive is score judgments |
| `checks.ts` | 330 → ~420 | 330 → ~445 | +built-in anchors check (~25); ssh deferred (rev 3, −40) |
| `adopt-executions.ts`, `shutdown.ts` | +60 / −20 | +70 / −20 | lane session in the node journal |
| `host.ts` | 943 → ~420 | 943 → ~420 | — |
| `tool.ts`, `routes.ts`, `brief.ts` | +120 net | +140 net | `declare`, non-blocking `run_eval` tickets |
| agent env filter | ~40 | ~55 | +sealed (single output tool per harness, plus its probe) |
| tests | ~1,000 | ~1,150 | +A15–A27 as integration tests, a lane token-audit test, a merge-conflict fixture, a canary test |

**Budget:** about **3,970** lines (rev 3), against V1's about 3,800 and today's 2,349, excluding
tests and the client round view: about 1.7× today, as the critique said. The row deltas against V1
sum to +170:

| Row | Delta |
|---|---|
| shared | +20 |
| scheduler | +100 (rev 3: +50 integration) |
| leader | −20 |
| acts | −10 |
| judgments | +100 (rev 3: +20 keys, strike fold, classification) |
| population | −90 |
| checks | +25 (rev 3: ssh deferred, −40) |
| adoption | +10 |
| tool/routes/brief | +20 |
| env filter | +15 |
| **Total** | **+170** |

V2 moved about 90 lines out of the riskiest file, which had no analogue, and into well-understood
ones: the scheduler, checks and judgments. The stop rule is unchanged at 4,100. Past it, delete in this order:
1. canaries (keep the keys);
2. sealed trees (blindness becomes advisory again);
3. `population.ts` (open fans become an agent with `run_eval` tickets).

**Build order** (rev 3, follows the tiers of §0.1):
1. types and `valid()`;
2. ledger and scheduler **with lanes and warm forks** (moved up from V1 step 8), cancel-on-death
   and the **integration step**, plus the trace-replay test;
3. adoption, lanes included;
4. leader, briefs, reflection, grading, auto-continue, the family digest, anchors;
5. judgments: the strike fold, `classified`, keys in providers;
6. digests, `run_eval` tickets, `declare`, the `llm` pool, env filter;
7. open fans;
8. tier 3 only after its probe: the sealed single-output-tool mode, then owner-set canaries.

The GTM draft stays the first real run. It exercises lanes, anchors and the panel, but not
populations.

## 9. Verification

Model: `docs/specs/expedition-v2.qnt`, **revision 3**. It is V1's model
(`docs/specs/expedition-v1.qnt`, revision 2) with V2's concurrent changes and the rev 3 fixes:
- C1 lanes (`laneSerial`, `coldBound`);
- C3 start/carve family checks, **cancel-on-death** (`killDead`), the **strike fold** (strikes are a
  set; a canary miss removes a judge's strikes) and **classified-family evals** (`tfam`,
  `spendFam`): `noDeadRunning`, `strikesCalibrated`;
- C4 keys **in providers** (`prov`, judge j on provider j, the cheap seat on provider 1):
  `repVote` (two judges), `yesVote`/`ownerYes`/`castYes` (judge on another provider, check, owner):
  `twoKey`, `twoKeyYes`, `noSelfJudge`;
- C8 quiet clock and batched failures;
- C10 reflection-only rewrite/finish, and a rewrite must change the plan (`bodies`,
  `rewriteChanges`);
- C12 auto-continue, now guarded by an empty owner queue (`ownerQ`) and a family check on the
  pre-written node (`autoOnlyOnMet`, `autoYieldsToOwner`);
- C15 integration at close (`integrated` inside `closeState`/`endRoundState`; a conflict merges
  nothing, enqueues `blocked`, grades the round not met): `stackedBase`.

Quint 0.33.1 has no JVM here, so the model is checked by random simulation (`quint run`, Rust
backend), not `quint verify`.

Bounds are V2's: 8 node slots, 3 rounds, money 14 + 4 per extend, close reserve 2, wake 2,
**2 scarce evals**, GPU 1, CPU 2, 3 live, deadline 12, park 4, round cap 4, 2 extends, 2 families
(family 1 has an evaluator, family 2 does not), 2 strikes, 2 judges on 2 providers, 3 seats, up to
2 lanes per fan, 0–2 pre-written graphs. Judge verdicts, classifications, merge conflicts and canary
outcomes are nondeterministic; a canary misses with probability ¼.

Reach steps. `quint run` picks uniformly among enabled branches, so rare states need weighting.
Every reach step is a **subset of `step`'s transitions**, so it changes probabilities only:
- `stepReach` (V1's), `stepMet` (host-met witnesses);
- `stepFam`: planning, starting, carving, completing, judging, the owner's yes key; no other owner
  acts;
- `stepRecheckBase` (A15b's base), `stepClass` (no rep votes, canaries or yes votes);
- `stepAuto` (rev 3): pre-written rounds with families dying between them;
- `stepDeath` (rev 3): heavy on carve/complete/judge, for A16, A27 and the classification witness.

**Two vacuities, both caught by witnesses.**
1. *Revision 2* ran first with 6 slots and no shape bias, and `noDeadSpend`, `twoKey`, `laneSerial`
   and `coldBound` "passed" without their states ever happening (recorded in V2's battery,
   `scratchpad/v2/battery3k.txt`). The critique then showed `noDeadSpend` was vacuous even on the
   final rev-2 model: its ghost was written only in the not-dead branch. Rev 3 deletes it.
2. *Revision 3's first draft* classified every check into a family. Four V1 witnesses
   (`w_noHostMet`, `w_noHostMetMulti`, `w_noForcedChange`, `w_noCheckAfterFinish`) went unreached:
   one family's death refused or cancelled about half the objective checks. That was a design gap
   as well as a model one (§11, "found while revising"); both are fixed. The draft battery is kept
   (`scratchpad/v2rev3/battery_prefix_draft.txt`).

`Q=…/scratchpad/quint/node_modules/.bin/quint`; `F=docs/specs/expedition-v2.qnt`. Every run is
`$Q run $F --step=<step> --invariant=<name> --max-samples=<n> --max-steps=80`, through
`scratchpad/v2rev3/one.sh`, 9–10 runs in parallel.

`stepDeath`, the 4-eval variant and the diagnostic `w_noRelabelled` were added after the main
battery. They are pure additions, so `step` and every earlier result are unchanged; only comments
changed after that.

**Machine conditions.** Load average 80–118 on 10 cores from other sessions during the battery
(`uptime`, 19:28–20:55). A 3,000-sample run that holds took 20–60 minutes. No run died this time.

| Command | Result |
|---|---|
| `$Q typecheck $F` | clean |
| `safety` (all 34 conjuncts), 3,000 each, on `step` / `stepReach` / `stepFam` / `stepClass` / `stepAuto` / `stepDeath` | **ok** `0x688a117573163bcd` / `0x1df8f2055445306b` / `0x2698a2c597e202b6` / `0x1576f4795d6c6cdf` / `0x2f0f60728c155fd1` / `0x76b349d769caa259` |
| `noDeadRunning` / `strikesCalibrated` / `twoKey` / `twoKeyYes` / `noSelfJudge` / `laneSerial`, step `step`, 3,000 each | **ok** `0x15e8e8fecc7d1f4b` / `0xb6faa837dd8e264a` / `0xd727f2fa01d6b4e5` / `0x122d6e44743c69ae` / `0xfb35164a6f4ab6d9` / `0xa5fbd2dc406b1cb9` |
| `coldBound` / `autoOnlyOnMet` / `stackedBase` / `rewriteChanges` / `autoYieldsToOwner`, step `step`, 3,000 each | **ok** `0x1438813b71e2b404` / `0x1cae062e92445b53` / `0xb41e0ad8108832c4` / `0x891436d3b4fa876a` / `0x864246bba6f67050` |

The 23 V1 invariants are checked inside `safety` (a conjunction fails if any conjunct fails, so per
sample it is at least as strong; what it loses is a separate seed per invariant). The 11 V2/rev 3
invariants were also run one by one.

**The critique's four probes, on the revised model.** Each probe is now a named invariant or is
subsumed by one, and holds on the real step:
- `r_strikesCalibrated` becomes `strikesCalibrated` (ok above; A23 reproduces the V2 behaviour);
- `r_noDeadRunning` becomes `noDeadRunning`, which is stronger: it also covers evals by classified
  family (ok above; A22 reproduces V2);
- `r_rewriteChanges` becomes `rewriteChanges` (ok; A6 breaks it);
- `r_autoNotOverOwnerMsg` becomes `autoYieldsToOwner` (ok; A21 breaks it). The critique's coarse
  probe ("no owner message pending at an auto-continue") is the same guard.

**No real safety violation was found** on any step. Every design defect the revision fixed was
found by the critique's probes or by an unreached witness, not by a failing safety run.

**Non-vacuity witnesses.** Each is expected to be violated. 3,000 samples on `step` unless noted;
"(ok on …)" records a run where the state was not reached before the reach step that did.

V1 witnesses carried over:

| Witness | Result |
|---|---|
| `w_noWorkDone` | violated `0xd3c221608f80240d` |
| `w_noPatchRace` | violated `0xd2ccdc4d5427054a` |
| `w_noPatchApplied` | violated `0x7b29ce287ba05bff` |
| `w_noMapFanout` | violated `0xeac62714a99a560c` |
| `w_noMistypedPlan` | violated `0xf1c1ebdbcb628350` |
| `w_noRewrite` | violated `0x32411b71532791fb` |
| `w_noGateDrop` | violated `0x64544c8a9367aaa4` |
| `w_noRatify` | violated `0xbb52c854083e7c8f` |
| `w_noStaleRatify` | violated `0xa68e8f0eb2068f3b` |
| `w_noIdRefusal` | violated on `stepReach` `0x1bba5b8f73127430` |
| `w_noRevBlocked` | violated `0x43e275a7b754e8a2` |
| `w_noHostMet` | violated on `stepReach` `0x76134fda3ba7b7f` (6,000); violated on `stepMet` `0x12c29737fc55c429`; (ok on `stepReach` at 3,000) |
| `w_noHostMetMulti` | violated on `stepMet` `0x3e52154409534541` |
| `w_noOwnerMet` | violated `0x6e7b1583d623e450` |
| `w_noStaleAccept` | violated `0x6f75f42807a4fe25` |
| `w_noDeadline` | violated `0x71238d3a3e494d97` |
| `w_noBudgetEnd` | violated `0x4fd5d3998f22c555` |
| `w_noCheckAfterFinish` | violated `0x1c53d8d2ceade0c4` |
| `w_noLateVerdict` | violated `0x4f5e238ef3878e8a` |
| `w_noReport` | violated `0x31ba1d48abb922d4` |
| `w_noAdoption` | violated `0x569a172e0006be87` |
| `w_noDeadAdopted` | violated `0xccf4b6382663102f` |
| `w_noThirdRound` | violated `0xa2372b1260e3e985` |
| `w_gpuNeverFull` | violated `0xb602a7ffa62e2f` |
| `w_noOrphan` | violated `0x7924fced2847d847` |
| `w_noExtend` | violated `0xc0db8d816a9c87a` |
| `w_noReflect` | violated `0x11e1a5f6ea5a6261` |
| `w_noForcedChange` | violated `0x2c1582e7269131c` |
| `w_noG10Refusal` | violated on `stepFam` `0x43bf8140fc77b2cf` |
| `w_noGateShortcut` | violated `0xdbae2c2a80da803b` |
| `w_noCarriedDone` | violated `0xc56049349f12b543` |
| `w_noPark` | violated `0xa6633ccf5cf2c9c0` |
| `w_noUnparkByAnswer` | violated `0x24741cae90e62b4` |
| `w_noCapClose` | violated `0x84c759af2c0ad494` |
| `w_noRunEval` | violated `0xa3cff6ab902859ad` |
| `w_noPopulation` | violated `0x85738596ea4670b` |

V2 witnesses:

| Witness (state reached) | Result |
|---|---|
| `w_noWarmLane` (a lane served a second item warm) | violated `0xf4d61528e7f5882f` |
| `w_noVerdict` (a panel verdict) | violated `0x4ea476135476e6a3` |
| `w_noDeadFamily` (a family died (two calibrated strikes)) | violated on `stepFam` `0x929248985d0ababd`; (ok on `step` at 3,000) |
| `w_noFamilyRefusal` (a dead family refused at plan, start or carve) | violated on `stepFam` `0x588dd604e6bae2b7` |
| `w_noRepChange` (a two-judge representation change) | violated on `stepFam` `0xedd0ff4d53191e60`; (ok on `step` at 3,000) |
| `w_noCanaryFail` (a canary miss) | violated `0x724006f8161f1a22` |
| `w_noVoidedVote` (a vote voided) | violated `0x326dd61a324714bd` |
| `w_noAutoContinue` (a host auto-continue) | violated `0xb76d24892deecf3f` |
| `w_noQuietFail` (a failure that did not wake the leader) | violated `0x43bb94f4db3bcb00` |
| `w_noStall` (a stall wake) | violated `0xfb53a4e69747f3c7` |

Revision 3 witnesses:

| Witness (state reached) | Result |
|---|---|
| `w_noYes` (a two-key yes on a produced node commits (with two providers)) | violated `0xba5982091044d911` |
| `w_noJudgeYes` (... with a cross-provider judge as one key) | violated `0x714f7e981e913cd2` |
| `w_noFamKill` (a death cancelled the family's live work) | violated on `stepFam` `0x9ac24d2961b8899b` |
| `w_noClassRefusal` (an eval refused on its classified family while its declared family lived) | ❌ **unreached** on `stepClass` (3,000) and `stepDeath` (3,000 and 10,000). The precondition is reached (`w_noRelabelled` below). With the bound of 2 scarce evals, an eval unit rarely survives to the carve. In the 4-eval variant (`scratchpad/v2rev3/ev4.qnt`, only `eBudget` changed) it is **violated** on `stepDeath` `0x486230d0e0420ab7` |
| `w_noRelabelled` (diagnostic: a running work node of a live declared family whose classified family is dead) | violated on `stepDeath` `0x8b77b06e659f3ca5`; (ok on `step` at 3,000) |
| `w_noStrikeVoid` (a canary miss voided a strike) | violated on `stepFam` `0x3d9e6db7eab29c07` |
| `w_noRevival` (a canary miss revived a dead family) | violated on `stepFam` `0xbc0503bd1db63b2` |
| `w_noStack` (a node started on a non-empty integration head) | violated on `stepFam` `0xee2f180fadd26066` |
| `w_noConflict` (an integration conflict) | violated `0xad73d2c7af0b2872` |
| `w_noAutoRefusal` (a pre-written graph dropped at auto-continue (dead family)) | violated on `stepAuto` `0xf15b7942d622af59` |
| `w_noSameRewrite` (an identical rewrite refused) | violated `0x15cffd528d1b5277` |

V1 ablations (A4, A7, A9, A10, A12–A14 are unchanged code paths, not rerun):

| Ablation | Invariant | Result |
|---|---|---|
| A1 `stepOvershoot` | `budgetSafe` | violated `0xde2ccead1d674f68` |
| A2 `stepBlindPatch` | `specFrozen` | violated `0x457802058484d21` |
| A3 `stepBlindRatify` | `objectiveFidelity` | violated `0xbc0f7800e4d10c49` |
| A5 `stepNoAdopt` | `noRerun` | violated `0xccc47b2081f866a1` |
| A6 `stepBlindRewrite` | `gatesKept` | violated `0x642fd8d7a8af0e63` |
| A6 `stepBlindRewrite` | `rewriteChanges` | violated `0x16eea94d62db621a` |
| A8 `stepAnyPassFinish` | `metOneSha` | violated `0xe9a823d228f6b145` |
| A11 `stepNoG10` | `g10` | violated `0xbc92cfb1f96acf6b` |

V2 and revision 3 ablations (bold = new in rev 3):

| Ablation | Invariant | Result | What it shows |
|---|---|---|---|
| A15 `stepNoRecheck` | `noDeadRunning` | violated `0x79ed6d05983f2566` | V1 as a whole: plan-time check only, strikes cancel nothing |
| A15b `stepNoRecheckOnly` | `noDeadRunning` | ok `0x6edaaccbf4317630` | start recheck alone removed, cancel-on-death kept: **expected to hold** (the recheck is redundant in the model) |
| A16 `stepNoDeclare` | `noDeadRunning` | violated `0x1d2280a3fa9aac99` (base `stepDeath`; ok on the old `stepFam` base at 3,000, since rev 3 deaths are rarer) | population child carved without a family check (V1) |
| A17 `stepOneKey` | `twoKey` | violated `0x34c8bf084e156bab` | rep change on one vote |
| A18 `stepCanaryNoVoid` | `twoKey` | violated `0x56aaa58c63e4d9fa` | canary miss keeps pending votes |
| A19 `stepLaneBlind` | `laneSerial` | violated `0xd13b9cc107c5e9d8` | no lane-busy check |
| A20 `stepFreshSession` | `coldBound` | violated `0x421910fb9603e08b` | one session per child (V1) |
| A21 `stepAutoAny` | `autoOnlyOnMet` | violated `0xec32d928045c2949` | auto-continue after any grade |
| A21 `stepAutoAny` | `autoYieldsToOwner` | violated `0x5b83015a3d9d8b5a` | ... and over a queued owner event |
| **A22** `stepStrikeNoCancel` | `noDeadRunning` | violated `0x12f7d5d80ee308c0` | a strike without cancel-on-death (V2 as written; critique probe r_noDeadRunning) |
| **A23** `stepCanaryKeepStrikes` | `strikesCalibrated` | violated `0x26a6454bcad10eba` | a canary miss keeps the judge's strikes (V2; critique probe r_strikesCalibrated) |
| **A24** `stepJudgeStrikesEval` | `strikesCalibrated` | violated `0xdbfbd7d2d50ad113` | an LLM reject strikes a family with an evaluator (V2) |
| **A25** `stepStaleBase` | `stackedBase` | violated `0xe519f9b46d991cb3` | items reset to the charter base (V2's waves) |
| **A26** `stepYesSameProvider` | `twoKeyYes` | violated `0x7d1ecc0ba6cedf4b` | a yes key from the producer's provider (V2's tier-level seat) |
| **A27** `stepDeclaredOnly` | `noDeadRunning` | ❌ ok `0xc2dc209f03ed2d1a` (10,000, base `stepDeath`; also ok at 3,000 on `stepClass` and `stepDeath`); **violated** in the 4-eval variant `0x2dcbcbd0d756767c`, where `safety` on `stepDeath` stays ok `0x3d1293c64ab1bc5c` | eval guarded by the declared family (V2's `declare`; the sidecar relabel). Unconfirmed at the repo bounds, for the reason in `w_noClassRefusal` |


**Totals (revision 3):**
- typecheck clean;
- `safety` (34 conjuncts) ok on 6 steps; the 11 V2/rev 3 invariants ok one by one;
- 56 of 57 witnesses violated (13 needed a reach step); **`w_noClassRefusal` unreached at the repo
  bounds** and reached in the 4-eval variant;
- 21 of 22 guard ablations violated; **A27 unconfirmed at the repo bounds**, violated in the
  4-eval variant; A15b holds as expected (it is a redundancy check, not a guard ablation).

What this means for the design: cancel-on-death, the strike fold, keys in providers, integration
and the auto-continue guards each have an invariant that a separate action can break, and each
breaking ablation fires. The classified-family guard on evals has model evidence only at a looser
bound; its code guard (❌) and an integration test with a relabelled candidate are the real check.

Scripts and raw outputs are in `scratchpad/v2rev3/`: `one.sh`, `battery.txt`, `battery_out.txt`
(final model), `rerun_out.txt`, `rerun2_out.txt`, `ev4.qnt`, `battery_prefix_draft.txt` (the
pre-fix draft). V2's rev-2 battery is in `scratchpad/v2/`; its seeds are superseded by this one.

**Not covered by the model** (❌ each):
- lane rollover, the base-session fork, `fresh` vs `carry`, and the rollover-by-score reallocation;
- anchors and sealed trees (host checks and plan refusals, not concurrency);
- the family digest, non-blocking `run_eval` ticket delivery, the ⅓-of-round failure wake;
- `new_family` (it shares the produced-node yes path, which is modelled);
- the fix-owner rule and the `ask`-names-the-misses rule (write-path checks);
- integration order and partial merges (the model merges all or none);
- in the model a judge's reject strikes the node's declared family; the design strikes the
  classified family. The two differ only for relabelled nodes;
- the quality of any judgment (verdict, classification, grade, merge outcome): nondeterministic.

Random simulation is not exhaustive. The model covers the model, not the code, and V1's
trace-replay test (§8) remains the link.

## 10. Self-critique log

**Round 1: attack against the nine use cases.**

Strongest objection: **"`carry` lanes destroy the independence that cases 2 and 4 depend on."**
- In case 4, sealed discovery runs must be independent draws. A carried session leaks run k's ideas
  into run k+1, which turns 6 "independent" lineages into 2 correlated ones.
- In case 2, a sign test over levers measured in one lane is not over independent experiments
  either, since the lane's context biases how levers are implemented.

What changed:
- `plan_round` refuses `context: carry` for sealed templates; case 4 R1 now uses
  `L = lineages, fresh`;
- q15 makes statistical predictions name items from distinct lanes;
- case 2's walkthrough uses `fresh` lanes. Its tree reuse still saves the rebuild, because build
  caches live in the tree, not the session.

Second objection, also applied: **"Canaries need ground truth, and case 9 has no graveyard."** q13
now names the sources per case. For case 9 that is the 12 owner decisions with recorded answers.
Where no source exists, the panel runs as `degraded` and two-key "yes" judgments also need the
owner, so they are never silently trusted.

Third objection, also applied: **"Non-blocking `run_eval` returns results as steers, but Codex only
receives them at its next Buddy tool call."** The result now always lands as a ticket readable
through the tool, as well as a steer. A Codex agent polls it at its next tool call, and §4 says
delivery is per harness.

**Round 2: attack against simplicity.**

Strongest objection: **"Fourteen changes is not a minor improvement. Lanes are a new noun with a
state machine; panels, canaries, anchors, ssh, sealed and auto-continue each add surface. V1's
critique already called 37 types too many."**

What changed in response:
- **Lane rollover policy collapsed.** A first draft typed rollover as `{maxItems, contextCap,
  reseed: 'base' | 'topK'}`. It is now one `rollAt: Tokens`. (Rev 3 corrects this line, which
  contradicted C2 and §4: a rollover reseeds from the base fork plus the digest **and the global
  top-k**, and a lane also rolls over when it trails the fan's median for `plateau` items.)
- **The canary is a Judgment variant, not a noun.**
- **`Grade` is no longer a named type.** Its fields are inline.
- **Rejected outright:**
  - a `background` node flag for case 5's long cells (carry already does it);
  - nesting (q10);
  - an embedding novelty service (q8);
  - V4's adaptive width formula (the effort table plus the leader's reflection is enough at this
    scale).
- **Two single-use types inlined:** `Where` and `Graph`.
- **Net result:**
  - named types stayed at 37 (the first draft had 39);
  - acts went −2 +4;
  - the riskiest file halved;
  - the line budget rose by about 135.

  The objection is half-right: V2's union variants grew.

Lanes stay. They are the single largest token lever (cases 1, 6 and 7), and they replace V1's
"warm forks, build step 8" promise rather than adding to it.

Residual risk, stated: auto-continue is a second path that opens rounds. It is guarded by I26 and
the A21 ablation. If it ever needs more conditions than "met and host-only", delete it rather than
grow it.

## 11. Critique and revision (revision 3)

An independent critique scored V2: use-case coverage 6, simplicity 4, token efficiency 7, frontier
scaling 4, owner control 6, Quint fidelity 5. Its four Quint probes were all violated on the V2
model (the seeds below are the critique's, from its copy `scratchpad/rev2/m.qnt`). Each item, and
the response:

**Must fix**

| # | Critique | Verdict | Response |
|---|---|---|---|
| M1 | Two-key "yes" cannot commit when a panel judge's provider also produced the subject: with two providers only one judge is eligible; "seat = tier" would defeat C4's rationale. Hidden because only `rep_change` (no producer) was modelled. | **Right.** | Keys are counted in **providers** (C4): a judge key needs a provider ≠ the producer's; the second key is a passing check or the owner. Modelled: `yesVote`/`ownerYes`/`castYes`, invariant `twoKeyYes`, ablation A26 (a same-provider key), witnesses `w_noYes` and `w_noJudgeYes` show a yes on a produced node commits with two providers. |
| M2 | Sealed nodes cannot call the schema-output tool or `declare`, so case 4 R1 could return neither a schema artifact nor a family. | **Right.** | Sealed = exactly one host output tool, verified per harness by a probe before `plan_round` accepts the seat (C6, tier 3). Sealed items get their family from the census (`classified`). I28 restated: no tool but the output tool. Not modelled (a plan refusal, not concurrency) ❌. |
| M3 | One LLM key kills a family, and a canary miss does not undo its strikes, contradicting G16 (probe `r_strikesCalibrated`, stepFam `0x589633f09109befb`). For cases 3/4 a false "no" is the expensive error. | **Right**, and C4's claim that "no" is the cheap error was wrong for measurable families. | (a) In a family with an evaluator only a failed check strikes; (b) a canary miss voids that judge's strikes as well as its votes, and death is recomputed (strikes are a fold, not a counter); (c) invariant `strikesCalibrated` in `safety`, ablations A23 (miss keeps strikes) and A24 (judge strikes an evaluator family); witnesses `w_noStrikeVoid`, `w_noRevival`. |
| M4 | Waves reset to the stale base and nothing integrates between rounds (cases 6, 7, 2); `integrate: branch` had no act. | **Right.** | C15: a host integration step at round close, serial merge in plan order, re-check on the merged sha, branch head = next round's `base`; a conflict is `blocked{needs: redesign}` and makes the round not met. Modelled in `closeState`/`endRoundState` (`integrated`), invariant `stackedBase`, ablation A25, witnesses `w_noStack`, `w_noConflict`. The end-of-run integrator agent is deleted. |
| M5 | `declare` is a self-report, so the sidecar relabel survives; `family: 'none'` skips every check. | **Right.** | An eval is guarded by the **classified** family of the committed diff (a one-key `classified` judgment before the eval is carved); `declare` is advisory. `'none'` is refused on nodes with `evals` (model: carve from work needs `fam > 0`). I22 now names the guarded quantity per kind (`spendFam`). Ablation A27 (eval guarded by the declared family) violates `noDeadRunning` only in a 4-eval variant of the model; at the repo bounds (2 scarce evals) it and the witness `w_noClassRefusal` are unreached at 10,000 samples (§9, ❌ unconfirmed). Residual: the classifier is one LLM key and can be fooled; a wrong classification now costs one eval, not a reopened family. |
| M6 | `noDeadSpend` was vacuous on the real step (ghost set only in the not-dead branch); a just-died family's running work kept spending (probe `r_noDeadRunning`, stepFam `0xd5add3158cb140e3`). The design was silent on cancel vs steer. | **Right.** The V2 doc's "Quint ✅" for I22 was not evidence. | Decided: **a death cancels the family's pending and running work and evals** in the strike's write, charged at journaled usage (`killDead`). `noDeadSpend` is deleted; `noDeadRunning` replaces it and is broken by different actions (A15, A16, A22 at the repo bounds; A27 in the 4-eval variant), so it is not a restated guard. A side effect, recorded: with cancel-on-death, the start-time recheck alone is redundant in the model (A15b holds); it stays in the design as defence in depth for the non-atomic scheduler. |

**Should fix**

| # | Critique | Response |
|---|---|---|
| S1 | `auto_continue` preempts a queued owner message (probe `r_autoNotOverOwnerMsg`, step `0xdc759d814f9de903`). | Applied: guard "no owner event in the inbox" in §3.4 and the model (`ownerQ == 0`); `autoYieldsToOwner` (restates guard; A21). |
| S2 | The model's autoContinue skipped the claimed `plan_round` checks; its node always had family 0. | Applied: the model runs the family check on the pre-written node (nondeterministic family); a dead family drops the graph and the leader wakes (`w_noAutoRefusal`). The doc now claims "family and typing checks", and says the model covers the family check only (a one-node graph is trivially well-typed). Budget is not checked at plan time in V1 either; it is checked at start. |
| S3 | G10 satisfied by an identical rewrite or a bare `ask` (probe `r_rewriteChanges`, step `0x6beb6bd1fbc69044`). | Applied: a rewrite must change a non-done intent or graph (host diff check; model `bodies`, `rewriteChanges`, restates guard, A6 breaks it, `w_noSameRewrite`); an `ask` under a streak names the missed predictions (❌ write-path check, unmodelled). |
| S4 | Rollover reseeding contradicts itself (C2/§4 vs §10); a `carry` lane gets no fitness signal. | Applied: one rule, the global top-k plus the digest (§10 corrected). Scores reach the lane as steers; the next item's parent is the fold over the lane's own lineage (the island), else the global top-k. |
| S5 | Width capped by local CPU (generators on `cpu` 3); no reallocation across lineages without a wake. | Applied: an `llm` pool variant for agent turns; frontier cases use one open fan with one `carry` lane per lineage, and a lane trailing the fan's median for `plateau` items rolls over onto the global top-k, which moves budget without a wake. |
| S6 | C7 ssh pools serve a resource that does not exist (`use-cases.md`:218). | Applied: C7 deferred, I29 and `Pool.where` deleted, −40 lines; the design is kept as q9. |
| S7 | Canary sources leak (case 9's decisions and case 3's graveyard are readable by tool-using judges); the 1-in-10 rate has no basis. | Applied: canaries only from an owner-written known-answer set in the expedition store, outside every fence; no rate claimed; tier 3 and first on the cut list. |
| S8 | Cases 8 and 9 are one thinker. | Applied: case 8 is a `fresh` list fan of independent derivations, each with its own free bun-suite loop, then a check-graded census that spends the one scarce eval on the winner; case 9 gets a small fan of independent critics. Both cases still rest on judgment, and the doc says so. |
| S9 | No per-round code-fix owner (`use-cases.md`:662; Tidewar's three blocking fixes had none). | Applied as a rule, not a role: a `continue`/`revise_next` after a round with `blocked` items or a `merge_conflict` must name, in the next graph, a node whose inputs include each one's evidence (§3.4 `reflect`). The leader cannot move on without assigning the fix. ❌ write-path check, unmodelled. |
| S10 | Case 3's token figure ignores lineage growth and TTL rewrites. | Applied: §6 prices an item as a function of lineage position and cache misses, and labels the result a guess (≈ 0.6–0.8× per new idea, not 0.65–0.75×). |
| S11 | "Minor refinement" is strained: about 1.7× today's lines. Rank by evidence; ship the cheap evidenced changes first. | Applied: the framing is dropped (header); §0.1 ranks the changes in tiers and §8's build order follows them. The budget is now 3,970 lines (+170 over V1), and the doc says 1.7×. |

**Found while revising (not in the critique).** A first rev-3 model classified every check into a
family. Then one family's death refused or cancelled about half of all objective checks, and the
battery showed four V1 witnesses (`w_noHostMet`, `w_noHostMetMulti`, `w_noForcedChange`,
`w_noCheckAfterFinish`) unreached at 3,000 samples: host-met had become nearly impossible. The
design had the same gap: "an eval is guarded by its classified family" did not say which checks are
evals. Fixed in both: only candidates of nodes with a family are classified (§3.4 `classify`); an
objective check of the integrated sha has no family. The draft battery is kept in the scratchpad
(`battery_prefix_draft.txt`).

**Quint findings**

| Finding | Response |
|---|---|
| `noDeadSpend` constant-true on `step` | Deleted; `noDeadRunning` is checked on the real step and broken by three ablations at the repo bounds and a fourth in a looser variant (above, §9). |
| `autoOnlyOnMet` / `hostOnly` come from nondeterministic booleans, so I26 restates its guard | Agreed and marked "(restates guard)" in §3.3. Grading quality is LLM/host judgment and stays nondeterministic; what the model checks is that the act reads the grade. Integration conflicts now force the grade to not-met, so A21 also covers "auto-continue after a conflict". |
| `twoKey` covers only `rep_change`, with `k = 3 − j` hardcoded | `repVote` now finds the other judge by set; `twoKeyYes` covers keep/promote/verified on produced nodes with the provider rule. `new_family` shares the produced-node path and is not modelled separately ❌. |
| reseat, lanes/rollover, fresh vs carry, sealed, anchors unmodelled | Still unmodelled, listed in §9 ❌. None is a concurrency rule except rollover, which is a host fold over scores. |

**Concept count after revision 3:** 12 nouns (unchanged), 37 named types (unchanged), 4 node
kinds (unchanged). Added: one host step (integrate), two acts (`classify`, `approve`), one pool
variant, three Judgment variants, one goal (G19), five invariants (I23b, I30–I33). Removed: C7 (a
field, an invariant, ≈ 40 lines), repo-derived canaries, the canary rate, `declare` as authority,
the integrator agent, and several open fans per frontier problem.
