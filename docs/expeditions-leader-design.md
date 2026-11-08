# Expeditions v2: a leader running a self-revising workflow

Status: **design only, nothing built.** Written 2026-11-08 from an owner design conversation. It
proposes replacing the retry loop of today's expeditions (`docs/expeditions-lean-design.md`,
`server/src/expeditions/host.ts`) with a leader that plans and revises rounds of workflow. The
spec is in Plumb (`docs/plumb.md`), checked by `pnpm check:plumb`.

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

```plumb
role owner | leader | host | worker

-- ---- The fixed part: owner-signed at launch ----
struct Charter {
  userGoal: md                 -- the owner's words, verbatim, never edited
  budget: Budget               -- spend, wall clock; the leader's own wakes count against it
  deadline: Time
  limits: Limit[]
  gates: GateSpec[]            -- points where the owner must decide; every plan keeps them
}
type Limit = Enforced{cap: Capability} | Advisory{text}
-- Enforced compiles to capability grants at worker launch (no push, no network to X, no paid
-- tools). Advisory goes into prompts and is labelled advisory. Only Enforced is claimed by G6.

-- ---- The leader's formalization: revisable ----
struct Objective { version: n; criteria: Criterion[]; open: Question[]; rationale: text }
type Criterion = Check{argv} | Judged{rubric} | Owner{q}
type Revision = Clarify | Tighten | Weaken | Redirect
-- Clarify answers an open question; Tighten adds a criterion or raises a bar; Weaken removes or
-- edits one; Redirect changes the target under the same userGoal.

-- ---- Rounds ----
struct MetaPlan { version: n; rounds: RoundIntent[]; reason: text }
struct Round { intent: text; predicts: Claim; nodes: Node[]; reserve: Budget }
type Node = Agent{prompt, inputs: Ref[], seat, out: Schema}
  | Map{over: Ref, template, maxPar: n, out: Schema}   -- fan-out width = length of `over`
  | Reduce{inputs: Ref[], prompt, out: Schema}         -- output carries provenance refs
  | Duel{thesis: Ref, rounds: n}                       -- advocate and critic on separate seats
  | Check{argv}
  | Gate{q}
state Node: pending -> running -> (done | cancelled)
-- Ref is global (r2.n3): a rewritten meta-plan can reuse finished work from any earlier round.

struct Expedition {
  charter: Charter
  objectives: (Objective, Evidence, Ratified)[]    -- appended only
  plans: MetaPlan[]                                -- appended only, each with its reason
  rounds: Round[]
  ledger: Ledger                                   -- spent + reserved
}

-- ---- Goals ----
goal G1 terminates: every expedition finishes by charter.deadline, with a result or a stated gap
  by: budget and deadline only shrink, and the host enforces both; it does not depend on the objective
goal G2 late-binding: round k's structure is chosen after rounds 1..k-1 ran
  by: the leader writes each Round at its start (act plan_round)
goal G3 outer-reflect: after each round the leader may continue, revise, rewrite, propose finish or ask
  by: event roundDone wakes the leader with the round's outcome against its predicts
goal G4 inner-control: a running round can be cancelled, steered or patched
  by: acts cancel, steer, patch; steer reuses harness-steering.ts (claude delivers mid-turn after any tool use)
goal G5 dynamic-width: fan-out width is decided by runtime data
  by: Map.over is a Ref whose out Schema is a list, checked when the round is planned (I5)
goal G6 owner-supreme: no leader action widens the charter, and the owner can always interrupt
  by: valid() checks every act against budget, Enforced limits and gates; owner acts bypass the leader
goal G7 durable: survives backend restart without losing or repeating work
  by: today's execution journals and adoption (docs/turn-lifecycle.md#execution-adoption)
goal G8 explainable: every structural change has a recorded reason
  by: plans and objectives are appended with reason and evidence
goal G9 fidelity: every objective version traces to userGoal; weakening and redirect are owner-ratified
  by: act revise_objective requires ratification unless the change only adds
goal G10 progress: reflection compares outcome to prediction rather than judging by feel
  by: Round.predicts is required; repeated misses are the trigger for rewrite_meta

-- ---- Invariants ----
inv I1 charter-fixed: the charter never changes after launch
  guard: ❌ to build: the record write path refuses a changed charter
inv I2 done-immutable: a done node and its output never change
  guard: ❌ to build: test "patch on a done node is rejected"
inv I3 budget-safe: spent + reserved <= budget at every instant, under parallel starts
  guard: ❌ to build: a node reserves its estimate at start; fast-check model of concurrent starts
inv I4 patch-cas: a patch applies to a node only if it is still pending when the patch commits
  guard: ❌ to build: model test racing patch against start
inv I5 typed-graph: a round whose Map.over is not list-typed never starts
  guard: ❌ to build: test planning a mistyped round is rejected
inv I6 gates-kept: every plan contains charter.gates
  guard: ❌ to build: test rewrite_meta dropping a gate is rejected
inv I7 no-self-finish: only the host or the owner finishes an expedition against the objective
  guard: ❌ to build: test that the leader's finish is only a proposal

-- ---- Acts ----
act plan_round(intent, predicts, nodes) @leader
  requires: graph type-checks (I5); reserve fits budget (I3)
  ensures: round starts
  else: reject to the leader with the reason
act patch(node, ops) @leader @owner
  requires: node is pending at commit (I4)
  else: reject; the leader may steer instead
act steer(node, msg) @leader @owner
  requires: node is running
act cancel(node) @leader @owner
act end_round(reason) @leader @owner
act rewrite_meta(plan, reason) @leader
  requires: gates kept (I6); reason cites outcomes
act revise_objective(o, kind, evidence) @leader
  requires: kind is Clarify or Tighten, or the owner ratifies
  ensures: rounds keep running under the old objective until ratified
act ratify(version) @owner
act propose_finish(summary) @leader
  ensures: owner sees userGoal, the latest objective and the drift between versions
act finish(reason) @host @owner
act pause(x) @owner
act stop(x) @owner
act extend(hours) @owner

-- ---- Events: what wakes the leader ----
on roundDone => leader wakes; outer reflection
on nodeFailed => leader wakes; inner reflection
on stalled => leader wakes; inner reflection
on budgetMark => leader wakes at 50% and 80% of the budget
on ownerMsg => bare commands go to the host; anything else wakes the leader
on tick => slow check-in, at most every 15 minutes
-- Events are batched: a finished node alone does not wake the leader (its wakes cost budget).
-- The leader sees summaries and artifact paths by default and may open any artifact on demand.

? q1: plans as graph JSON only, or also a builder script that produces the graph?
? q2: how does the host classify a revision when the leader's kind is wrong? (current answer: any removed or edited criterion counts as Weaken)
? q3: can one Duel seat be another provider, so the critic does not share the advocate's biases?
```

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

Writing the design half-formally turned up these, each now an invariant above:
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

1. Promote the `plumb` types to Zod in `shared/src/expedition.ts` (one type source).
2. Write a TS model of the concurrent core (node lifecycle, patch compare-and-swap, budget
   reservation, wake batching, restart adoption), checked with fast-check against the real
   scheduler. This turns the ❌ guards for I2–I4 into tests.
3. Escalate to Quint only if sampled runs keep missing interleavings (see `docs/plumb.md`).
