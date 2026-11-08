# Expeditions v2: a leader running a self-revising workflow

Status: **design only, nothing built.** Written 2026-11-08 from an owner design conversation. It
proposes replacing the retry loop of today's expeditions (`docs/expeditions-lean-design.md`,
`server/src/expeditions/host.ts`) with a leader that plans and revises rounds of workflow. The
spec follows `docs/design-specs.md`; the concurrent core is to be model-checked in Quint.

## 1. The motivating case, and why today's host cannot run it

The owner asked the Wave_sim CEO for a GTM research expedition following a widely shared
"YC method":
1. Collect raw material: 25–40 competitor sites, earnings calls, 100+ reviews, forum threads.
2. Ask questions that force thinking rather than summary.
3. Steelman the best angle, then tear it apart, for several rounds.
4. Test the result with real buyers.

The CEO drafted `~/.agent-viewer/expeditions/gtm-evidence-thesis-buye-dd0984.json`. It is a
careful charter: about 6,500 characters of goal laying out six steps, `done: owner`,
`maxAttempts: 6`, `hours: 6`, `maxLive: 1`. To inspect a draft:
`jq -r .charter.goal ~/.agent-viewer/expeditions/<id>.json`.

The task has four phases, each with a different shape:

| Phase | Shape | Needs |
|---|---|---|
| Collect | fan-out over many independent sources | parallel workers, a source ledger, honest coverage counts |
| Synthesize | one deep pass over the whole corpus | one agent with all the material |
| Steelman / attack × N | adversarial loop | two different seats; stop when the thesis holds or dies |
| Buyer test | a gate to humans | the owner decides and owns outreach |

Today's host is a **retry-until-pass loop**: every attempt gets the same goal plus one line per
prior attempt. The six steps exist only in prose, which causes six problems:

1. **A pass ends the whole expedition** (`host.ts finishIfDue`). Passing step 1 finishes
   everything, so moving to step 2 means marking step 1 "fail".
2. **No retry room.** Six attempts for six steps: one weak turn loses a step.
3. **It blocks on the owner at every step.** A judging attempt holds the only slot (`host.ts
   fill`), while the deadline clock runs.
4. **Fan-out runs one at a time.** The crew may not start workers, and `maxLive: 1` allows one
   attempt.
5. **The adversary is fake.** One seat plays both steelman and critic.
6. **The handoff is fragile.** Each attempt starts in a fresh worktree from the base and only
   "may" merge earlier branches.

## 2. What the existing systems offer

| | Claude Code Workflow | AI-OS macro (`nbardy/AI-OS`) | Expedition (today) |
|---|---|---|---|
| Form | JS script: `agent()`, `parallel()`, `pipeline()`, schemas | Python file run inside a chat REPL | config only: a charter (goal, done, budgets) |
| Shape | fixed at launch; can branch on results, never rewrites itself | fixed code; results land in chat, so the human steers the next run | one fixed shape: retry the goal, carry lessons |
| Fan-out | excellent | manual | none |
| Judging | whatever the script codes | judge-in-a-loop is the main pattern (`chart_judge_macro.py`, `tdd_macro.py`) | exit-0 checks or owner pass/fail, for the whole expedition |
| Durable state | per run | REPL history | strong: record, worktrees, deadline, budget, manager chat, restart adoption |
| Self-revising | no | only through the human | weakly: lessons and notes change the next brief, never the plan |

Expeditions keep their durability and owner controls. What they lack is a plan with structure,
and the ability to revise it.

## 3. The model

- A **leader** owns the goal. It is an event-driven loop, not one long turn.
- It writes a loose **meta-plan**: a sequence of round intents (collect → synthesize → duel →
  gate → follow-up).
- Each **round** is a small workflow, a graph of typed nodes, written by the leader *when the
  round starts*, not at launch.
- **Reflection between rounds:** after each round the leader judges the outcome against what the
  round predicted, then continues, revises the next round, or rewrites the meta-plan.
- **Reflection within a round:** while a round runs, the leader or the owner can cancel or steer
  a worker, patch nodes that have not started, or end the round early.
- **Two goals:** the owner's words stay fixed. The leader's formalization of them, the
  *objective*, is a versioned hypothesis about intent that the leader revises as evidence
  arrives, under ratification rules (§5).

**Why a round is a graph and not a script:** a running script cannot be patched. Its JS is
mid-execution, so there is no clean answer to "drop the third worker" or "add a step after the
reduce". A graph of nodes with monotone states makes patching trivial:
- unstarted nodes are editable
- running nodes can be steered or cancelled
- finished nodes are immutable

The leader may write the graph directly, or later a builder script that only *produces* the
graph. Scripts are good for authoring; graphs are what the host runs.

## 4. Spec

Types are TS so they can move into Zod in `shared/src/expedition.ts` unchanged. Goals,
invariants and acts are tables, following `docs/design-specs.md`: every goal names the mechanism
that delivers it, every invariant names its enforcement, and gaps are marked ❌. The concurrent
core (node lifecycle, budget, patches, gates, finish) is to be model-checked in Quint (§8).

```ts
// ---- The fixed part: owner-signed at launch ----
type Charter = {
  userGoal: Markdown;          // the owner's words, verbatim, never edited
  budget: Budget;              // spend, wall clock; the leader's own wakes count against it
  deadline: Time;
  limits: Limit[];
  gates: GateSpec[];           // points where the owner must decide; every plan keeps them
};
// Enforced compiles to capability grants at worker launch (no push, no network to X, no paid
// tools). Advisory goes into prompts and is labelled advisory. Only Enforced is claimed by G6.
type Limit = { t: 'enforced'; cap: Capability } | { t: 'advisory'; text: string };

// ---- The leader's formalization: revisable ----
type Objective = { version: number; criteria: Criterion[]; open: Question[]; rationale: string };
type Criterion =
  | { t: 'check'; argv: string[] }
  | { t: 'judged'; rubric: string }
  | { t: 'owner'; question: string };
// clarify answers an open question; tighten adds a criterion or raises a bar; weaken removes or
// edits one; redirect changes the target under the same userGoal.
type Revision = 'clarify' | 'tighten' | 'weaken' | 'redirect';

// ---- Rounds ----
type MetaPlan = { version: number; rounds: RoundIntent[]; reason: string };
type Round = { intent: string; predicts: Claim; nodes: Node[]; reserve: Budget };
type Node =
  | { t: 'agent'; prompt: string; inputs: Ref[]; seat: Seat; out: Schema }
  | { t: 'map'; over: Ref; template: string; maxPar: number; out: Schema } // width = length of `over`
  | { t: 'reduce'; inputs: Ref[]; prompt: string; out: Schema }           // output carries provenance refs
  | { t: 'duel'; thesis: Ref; rounds: number }                              // advocate, critic: separate seats
  | { t: 'check'; argv: string[] }
  | { t: 'gate'; question: string };
// Node lifecycle, forward only: pending -> running -> (done | cancelled)
type NodeState =
  | { t: 'pending' }
  | { t: 'running'; requestId: string }
  | { t: 'done'; out: Artifact }
  | { t: 'cancelled'; why: string };
// Ref is global (r2.n3): a rewritten meta-plan can reuse finished work from any earlier round.

type Expedition = {
  charter: Charter;
  objectives: { objective: Objective; evidence: Evidence; ratified: Ratified }[]; // appended only
  plans: MetaPlan[];                                                               // appended only
  rounds: Round[];
  ledger: { spent: Budget; reserved: Budget };
};
```

### Goals

| ID | Goal | By (mechanism) |
|---|---|---|
| G1 terminates | every expedition finishes by the deadline, with a result or a stated gap | budget and deadline only shrink and the host enforces both; it does not depend on the objective |
| G2 late binding | round k's structure is chosen after rounds 1..k-1 ran | the leader writes each round at its start (`plan_round`) |
| G3 outer reflection | after each round the leader may continue, revise, rewrite, propose finish or ask | `roundDone` wakes the leader with the outcome against the round's `predicts` |
| G4 inner control | a running round can be cancelled, steered or patched | `cancel`, `steer`, `patch`; steer reuses `server/src/buddies/harness-steering.ts` (claude delivers mid-turn after any tool use) |
| G5 dynamic width | fan-out width is decided by runtime data | `map.over` is a `Ref` whose `out` schema is a list, checked when the round is planned (I5) |
| G6 owner supreme | no leader action widens the charter; the owner can always interrupt | `valid()` checks every act against budget, Enforced limits and gates; owner acts bypass the leader |
| G7 durable | survives backend restart without losing or repeating work | today's execution journals and adoption (`docs/turn-lifecycle.md#execution-adoption`) |
| G8 explainable | every structural change has a recorded reason | plans and objectives are appended with reason and evidence |
| G9 fidelity | every objective version traces to `userGoal`; weakening and redirect are owner-ratified | `revise_objective` requires ratification unless the change only adds |
| G10 progress | reflection compares outcome to prediction, not judging by feel | `Round.predicts` is required; repeated misses trigger `rewrite_meta` |

### Invariants

| ID | Invariant | Guard |
|---|---|---|
| I1 charter fixed | the charter never changes after launch | ❌ record write path refuses a changed charter |
| I2 done immutable | a done node and its output never change | ❌ Quint invariant + host test |
| I3 budget safe | `spent + reserved <= budget` at every instant, under parallel starts | ❌ Quint invariant; nodes reserve their estimate at start |
| I4 patch CAS | a patch applies only if the node is still pending when it commits | ❌ Quint invariant (patch racing start) |
| I5 typed graph | a round whose `map.over` is not list-typed never starts | ❌ host test: a mistyped round is rejected at planning |
| I6 gates kept | every plan contains `charter.gates` | ❌ Quint invariant |
| I7 no self finish | only the host or the owner finishes, against the objective | ❌ Quint invariant |

### Acts

| Act | Who | Requires | Otherwise |
|---|---|---|---|
| `plan_round(intent, predicts, nodes)` | leader | graph type-checks (I5); reserve fits budget (I3) | rejected to the leader with the reason |
| `patch(node, ops)` | leader, owner | node still pending at commit (I4) | rejected; the leader may steer instead |
| `steer(node, msg)` | leader, owner | node running | — |
| `cancel(node)`, `end_round(reason)` | leader, owner | — | — |
| `rewrite_meta(plan, reason)` | leader | gates kept (I6); reason cites outcomes | rejected |
| `revise_objective(o, kind, evidence)` | leader | `clarify`/`tighten`, or owner ratifies; rounds keep running under the old objective until then | waits for `ratify` |
| `ratify(version)` | owner | — | — |
| `propose_finish(summary)` | leader | owner sees `userGoal`, the latest objective and the drift between versions | — |
| `finish(reason)` | host, owner | `charter`-level reason or objective met | — |
| `pause`, `stop`, `extend(hours)` | owner | as today | — |

### Events: what wakes the leader

| Event | Effect |
|---|---|
| `roundDone` | outer reflection |
| `nodeFailed`, `stalled` | inner reflection |
| `budgetMark` | wake at 50% and 80% of the budget |
| `ownerMsg` | bare commands go to the host; anything else wakes the leader |
| `tick` | slow check-in, at most every 15 minutes |

Events are batched: a finished node alone does not wake the leader, because its wakes cost
budget. The leader sees summaries and artifact paths by default and may open any artifact on
demand.

### Open questions

- **q1:** plans as graph JSON only, or also a builder script that produces the graph?
- **q2:** how does the host classify a revision the leader labelled wrongly? Current answer: any
  removed or edited criterion counts as `weaken`.
- **q3:** can one duel seat be another provider, so the critic does not share the advocate's
  biases?

## 5. User goal vs objective

The objective is a **hypothesis about what the owner meant**. Revising it is a normal, logged
event. The risk to guard against is the opposite one: a leader quietly redefining "done" as
something easy to reach. Hence the split:

| Revision | Example (the GTM case) | Who decides |
|---|---|---|
| Clarify | "Public incumbents exist only for comparison; there is no direct RL-data incumbent" | leader, logged with evidence |
| Tighten | "Also require 2+ first-person practitioner complaints per pain" | leader, logged |
| Weaken | "100+ reviews → whatever exists, count reported" | owner ratifies |
| Redirect | "Lead with design partners; RL buyers can't be reached publicly" | owner ratifies |

- **Termination does not depend on the objective.** A wrong objective cannot trap the run. The
  worst case is ending at the deadline with "here is what we learned, and the clarified goal".
- **Open questions are data** (`Objective.open`), so ambiguity is never silently guessed. A
  round may exist only to reduce ambiguity: it predicts "resolves q1 and q2" and outputs a
  proposed revision.
- **Finishing shows the drift.** The owner sees the original words, the final formalization, and
  the path between them. Meeting the criteria isn't enough if the drift answers a different
  question than the one asked.

The CEO's GTM draft is in effect Objective v0 with a first meta-plan, not a contract.

## 6. Gaps the spec found that prose hid

Writing the design half-formally (types, plus a named mechanism for every goal) turned up these, each now an invariant above:
- parallel budget overshoot (I3)
- a plan rewrite that could drop an owner gate (I6)
- a leader certifying its own finish (I7)
- a patch racing a node start (I4)
- fan-out over an output not known to be a list (I5)
- prose limits that cannot be checked; hence the Enforced/Advisory split, and G6 is claimed only
  for Enforced limits

It also narrowed G4 for the leader. The owner can always intervene mid-round, but the leader
wakes only on exceptions plus a slow tick. Two reflection levels that both wake often double
token cost for little gain.

## 7. Migration from today's code

Kept:
- the record file and its write path
- worktrees per unit of work
- deadline and budget enforcement
- the manager chat seat, which becomes the leader
- restart adoption
- bare chat commands

Replaced:
- the attempt loop (`host.ts fill`/`startAttempt`) becomes a graph scheduler plus leader wakes
- `Attempt` becomes `Node`
- `Charter.done` becomes `Objective.criteria`, while `userGoal` and the bounds stay in the charter
- the one-sentence `Lesson` handoff becomes typed node outputs and global refs

## 8. Verification plan

1. **Quint model first** (`docs/specs/expedition-leader.qnt`): node lifecycle, rounds, budget
   ledger with reservations, patches, gates and finish proposals as state and actions; I2–I4,
   I6 and I7 as invariants. `quint run` (random simulation) needs no JVM; `quint verify`
   (Apalache, bounded symbolic check of every interleaving) does. This checks the design before
   code exists.
2. **Types into Zod** in `shared/src/expedition.ts` (one type source).
3. **Link model and code:** drive the real scheduler with the model's transitions (fast-check,
   or replay Quint's ITF traces) so the implementation is checked against the design. Without
   this link the model and the code drift apart.

A proof covers the model, not the code (hence step 3), and it covers structure, never LLM
judgment: "the leader can never drop a gate" is provable, "the leader reflects well" is not.
