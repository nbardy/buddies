# Expedition design

Status: design, not built (2026-11-01). Motivation: [README.md](./README.md).

## Primitives

```
Goal       what + done checks + scope fence + explore budget + limits     (owner owns it)
Question   an open unknown or subgoal under the Goal                      (the work frontier)
Attempt    one isolated, budgeted, short-lived agent run on a Question
Result   = Claim(statement, evidence, check)
         | Finding(negative result, evidence)
         | Blocked(need)
         | Waiting(externalJobId)
Check      fresh-context verification of a Claim → Verified | Refuted | Unclear
Ledger     append-only log of everything; all state is derived from it
Tick       stateless f(Goal, Ledger) → next actions; runs on every event + a backstop timer
```

Two more are required and not yet designed in detail (see [Open gaps](#open-gaps)):

```
ExternalJob  a long-running job (GPU run, CI) an Attempt submitted; finishing is an event
Integrate    a merge Attempt for a Verified Claim that carries code, against current main
```

### Goal

```
Goal
  what:          outcome in plain language
  done:          DoneCheck[]            command(s) that pass or fail
                 | OwnerJudgment         explicit: no mechanical check exists
  in scope:      ...
  out of scope:  ...
  explore share: fraction of budget for work outside the in-scope list (e.g. 0.2)
  limits:        budget $, max live attempts, allowed models/harnesses, repo rules
  stop:          Done | BudgetSpent | Deadline | OwnerStop
```

The Goal carries **no strategy**. Children choose their own approach; the
expedition watches the approaches and allocates effort (see
[Strategy cards](#strategy-cards)).

A Goal without a done check is rejected at launch unless it explicitly says
`OwnerJudgment`. No silent "we'll know it when we see it".

### Attempt

Every Attempt:
- runs in its own worktree on its own branch;
- gets a brief built from the Goal, its Question, verified Claims, relevant
  Findings and owner Lessons from the Ledger;
- has a budget (time and $);
- **must end with exactly one Result**. There is no "partial, will continue".

Persistence belongs to the Goal and the Ledger, never to an agent. Every
Attempt ending is an event that triggers a Tick, so a stopped agent cannot
strand the work.

### Attempt kinds

One runner, one Result shape, different briefs:

| Kind | Input | Result |
|---|---|---|
| **Plan** | Goal + Ledger | new Questions (decomposes a half-scoped goal), parking-lot entries |
| **Work** | a Question | Claim / Finding / Blocked / Waiting |
| **Check** | a Claim, *without* the author's conclusion | Verified / Refuted / Unclear |
| **Reflect** | Ledger metrics + strategy cards | allocation changes, brief changes, new Questions |
| **Zoom-out** | Goal + Ledger + north star | proposals: parking-lot Questions or a Goal amendment for the owner |
| **Answer** | an owner `@` question + Ledger | an answer citing runs and results (read-only) |
| **Integrate** | a Verified Claim with code | merged commit, or Blocked(conflict) |

A fixed-shape step inside an Attempt (a 3-verifier Check panel, the failure
re-run trio) can be carried out by a Claude Code workflow. See
[workflows-vs-expeditions.md](./workflows-vs-expeditions.md).

### Strategy cards

Each Work attempt declares its approach in every report:

```
StrategyCard
  approach:   "cut-cell wall in pressure solve"
  hypothesis: "voxel wall underestimates lift via a missing pressure term"
  predicts:   "lift error falls from 15.7% toward <10% as N doubles"
  evidence:   numbers so far
  abandon if: what would make me stop
```

The expedition does not pick the method; it reads the cards across children.

## Scope: enforced by spend

- Questions are **in scope** (under the fence) or **explore**.
- Explore attempts draw on the explore share of the budget only.
- Ideas beyond that land in the **parking lot** as unfunded Questions, shown in
  the digest. Only the owner funds them, or the explore share once it frees up.

It cannot sprawl, because unbudgeted ideas wait. It cannot tunnel, because the
explore share is reserved and Zoom-out keeps filling it.

## Parallelism

The Tick runs every open, funded Question that has no live Attempt, up to the
live-attempt cap. Competing attempts on one Question both continue until a
Check settles it. Parallelism therefore scales with how many Questions the
Plan produces, which is the right thing for it to depend on.

## The loops

| Loop | Who | When | Changes |
|---|---|---|---|
| **Tick** | Code (one model call only when there is a decision) | Every event + backstop timer | Starts/ends attempts. Nothing changed and work is live → sleep, no LLM call |
| **Reflect** | The expedition, fresh context | Metric thresholds, stalls, every few hours | Its own allocation, briefs, routing |
| **Steer** | Owner, via `@` or inspector | Any time | This expedition: redirects and Lessons |
| **Retro** | Owner + expedition | On finish or stop | The tool: playbook rules, brief templates, tool issues |

### Checkpoints that reach the owner

It runs without approvals. The "needs you" count only covers:

| Checkpoint | Why |
|---|---|
| After the first Plan | Steering the breakdown has the most leverage (optional review, not a gate) |
| Goal-level surprise: shared failure, goal looks wrong | Only the owner changes the WHAT |
| Before Integrate into main | The owner decides what lands (configurable) |
| Daily digest | 30-second skim: claims, spend, parking lot, Blocked |

## Self-reflection without a human

The rule: **judge children by measurements, experiments and independent
auditors, never by their opinion of themselves.**

### 1. Measure (code, no LLM)

| Signal | Exposes |
|---|---|
| Check refutation rate per child / brief / model | Over-claiming |
| Prediction vs. outcome on strategy cards | A wrong model of the problem |
| Cost per verified claim | What actually buys progress |
| Attempts per Question with no claim | A stuck Question |
| Files touched outside the Question's scope | Scope drift |
| Time since last Ledger entry | Stalls |
| Near-duplicate briefs or diffs | Duplicated work |
| Strategy cards clustering on one approach | Missing diversity |
| Different approaches failing by the same amount | An upstream problem (measurement, setup, goal) |

Thresholds on these trigger Reflect.

### 2. Diagnose failures by controlled re-run

| Re-run | If it now succeeds | Conclusion |
|---|---|---|
| Same brief, different model | yes | The child slipped |
| Brief enriched with failure context and relevant Ledger results | yes | **Our instructions were the problem** → fix the brief template |
| A different approach to the same Question | also fails the same way | **The strategy or Question is wrong** → split, reframe or park |

### 3. Audit transcripts, sampled

A fresh-context auditor on a different model than the worker reads a sample of
transcripts for: ignored instructions, invented commands or flags, unread
context, loops, changing the test instead of the code.

### 4. Adjust within limits

May change: brief templates (kept as variables, variant kept if it yields more
verified claims per $), model routing per Question type, allocation (split,
park, kill duplicates, fund the leader), and a red-team pre-mortem before any
spend above a threshold.

### 5. The guardrail that matters most

**Reflection may never change the Goal, the done checks, the Check procedure or
the budget.** A self-optimizing system eventually finds that the easiest way to
pass is to soften the test. Those are owner-only. Its own briefs, routing and
allocation are fair game.

## Owner feedback

```
Feedback =
  | Approve(plan | result)
  | Redirect(question, instruction)
  | Fund(parkedQuestion) | Kill(question)
  | Lesson(text, scope: ThisExpedition | Playbook)
  | Pause | Resume | Stop
  | AmendGoal(change)          owner-only
  | RaiseBudget(amount)        owner-only
```

`Lesson` entries enter every later brief. `Playbook`-scoped lessons enter every
future expedition's briefs.

## Inspector (behind the badge)

All tabs are views over the Ledger.

| Tab | Shows |
|---|---|
| Overview | Goal, scope, spend and time vs. budget, latest reflection |
| Questions | Status per Question and its attempts |
| Runs | Every Attempt: kind, model, duration, cost, Result, transcript, branch |
| Results | Verified / refuted claims and findings with evidence |
| Timeline | The Ledger as a feed: decisions and why |
| Parking lot | Noticed, unfunded ideas |
| Self-reflection | Brief changes, routing shifts, audit findings, re-run verdicts |

## Open gaps

1. **Integrate.** Attempts produce branches. Merge order, conflicts, and
   re-verification on current main are not designed. This was the bottleneck
   in every earlier swarm.
2. **External jobs.** Long GPU or CI runs: an Attempt submits and ends with
   `Waiting(jobId)`; job completion is an event. Needs a job adapter per backend
   (Modal, CI).
3. **Plan quality.** Decomposition of vague goals decides everything and is
   only "a brief" today.
4. **Ledger summarization for the Tick.** With hundreds of entries the compact
   view is itself state; it must be derived deterministically, not written by a
   model.
5. **Check cost.** Verifying everything roughly doubles spend on what matters.
   Policy for which Claims require a Check (those that gate decisions or merge)
   is not settled.

## Proof plan

Before building the engine:

1. Pick one real, half-scoped engineering goal.
2. Run it two ways: (A) the current setup; (B) a by-hand expedition: a Claude
   Code session acts as the Tick (`/loop` / `ScheduleWakeup`), the Ledger is a
   JSONL file, workflows run fan-outs and Checks.
3. Compare: owner interventions, verified results per $, whether it finished
   without stalling, whether scope held (parking lot vs. what was built).
4. Build the engine only if B clearly wins, with Integrate and External jobs
   included from the start.
