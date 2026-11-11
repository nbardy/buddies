> The built format is the one-file form in [v1/DESIGN.md](v1/DESIGN.md); this document preserves the earlier full design.

# Expeditions: the final design

> **Build [`v1/`](v1/DESIGN.md) first.** It is this design cut down to what one real case needs,
> with a worked plan rewrite. This document is the full scope, and its nine example cases are the
> checklist for what v1 defers.

Status: **final design, 2026-11-10. Not built. The host core is not yet model-checked.** The
authoring API is exact ([`api/expedition.d.ts`](api/expedition.d.ts)) and the nine example plans
typecheck against it (`../../../server/node_modules/.bin/tsc -p tsconfig.json` from this folder).
Conventions: `../../design-specs.md`. This replaces the three candidates beside it
([A](A-one-rule.md), [B](B-reads-like-the-plan.md), [C](C-cannot-be-wrong.md)): B's format on A's
kernel with two of C's guards, plus goals that emerge and a shared learning log.

## 1. The goal

**The owner states a goal once. Agents on any harness work toward it for hours or days without
the owner present. The plan changes as the work teaches it. Nothing is lost, overspent or falsely
declared done, and the owner can see and steer the run at any time.**

## 2. The idea

An expedition is **a plan that can be thrown away and replaced at any moment without losing
anything.** Every unit of work has a key. The host keeps an append-only log of what each key
produced. Running a plan means, for each keyed call: return the logged result if it finished,
attach if it is running, start it if it is new. That one rule, **reconcile by key**, gives restart
recovery, plan rewrites, a full history and an exact cost preview.

Three things, three owners. Each writes only its own.

| Thing | Owner | Contents |
|---|---|---|
| **Contract** (`contract.md`) | the owner | the goal in the owner's words, done criteria, budget, pools, rules, leader |
| **Plan** (`plan.ts` + `briefs/`) | the leader, a named Buddy | who does what, in which order, and where the plan reflects |
| **Log** | the host | every call, result, question, answer, learning and plan version |

## 3. What an expedition looks like

A folder. Its name is the expedition id, the one id everything hangs from.

```
gtm-evidence/
  contract.md       goal in prose; done, budget, pools, rules as frontmatter
  plan.ts           the cast table and the phases
  briefs/           one markdown file per step: the prompt, as long as the work needs
```

The plan for the GTM case, complete ([the runnable GTM port](v1/examples/01-gtm.expedition.ts); the sketch below uses the earlier API):

```ts
const { scope, collect, thesis, attack, revise, packet } = steps({
  scope:   lead.lists(Org),
  collect: scout.in(checkout(`${OUT}/sources/`)).judged(check('python tools/gtm/anchors.py', 'tools/gtm/')),
  thesis:  lead.judged(review('traceable', judge)),
  attack:  critic.judged(review('real-counterexample', judge)),
  revise:  lead.judged(review('traceable', judge)),
  packet:  lead.in(checkout(`${OUT}/`)).judged(check(`python tools/gtm/audit_ledger.py ${OUT}`, 'tools/gtm/')),
});

export default plan(async (x) => {
  const orgs = await x.phase('scope', () => scope());
  if (orgs.t !== 'passed') return gap('The scope step produced no list of organizations.', orgs);

  const found = await x.phase('collect', () => wide(orgs.value.out, (org) => collect({ item: org })));
  const sources = passed(found).map((f) => f.value);
  await x.review('Is the coverage enough to argue from, or is a kind of source missing?');

  let current = await x.phase('synthesize', () => thesis({ reads: sources }));
  await x.phase('duel', async () => { /* 3 rounds: critic attacks, lead revises */ });
  …
});
```

How to read a plan:

- **The cast table** (`steps({...})`) lists every step that can run: who does it, where it works
  and how it is judged. Property names are the step names. They appear once, as identifiers.
- **Briefs** are the prompts. `briefs/<step>.md`, with `{{slots}}` filled from the call's item.
- **`x.phase`, `x.review`, `x.ask`** are the structure. Reading only those lines gives the plan:
  `scope → collect (wide) → ⟳ review → synthesize → duel ×3 → ⟳ review → packet → ✋ owner`.

## 4. Types

The authoring API is [`api/expedition.d.ts`](api/expedition.d.ts). The host canonicalises every
authored call into these, which have no optional fields:

```ts
// ---- Contract: the owner's ----
type Contract = {
  goal: Markdown;                         // verbatim, never edited by anyone else
  done: Criterion[];                      // the host evaluates all of them on ONE commit
  budget: { usd: number; hours: number };
  pools: Record<PoolName, Pool>;
  rules: string[];                        // appended verbatim to every brief
  leader: BuddyId;
  repo: Path;
  autoApply: { usd: number };             // a rewrite adding more new cost than this waits for the owner
};
type Criterion =                          // check and metric reserve `needs` while they run
  | { t: 'check'; command: string; needs: PoolName[] }
  | { t: 'metric'; command: string; field: string; bound: { t: 'atLeast' | 'atMost'; n: number };
      needs: PoolName[] }
  | { t: 'review'; rubric: BriefName; by: Seat }
  | { t: 'owner'; question: string };
type Pool =
  | { t: 'slots'; n: number; scope: 'expedition' | 'machine' }  // agent seats, local GPU, compile lock
  | { t: 'uses'; n: number }                                    // "exactly one replay"
  | { t: 'spend'; usd: number; slots: number };                 // Modal

// ---- A call: the only thing that runs ----
type Call =
  | { t: 'agent'; key: Key; goal: GoalPath; by: Who; brief: Markdown; inputs: Ref[];
      output: JsonSchema; tree: Tree; grant: Grant; context: { t: 'cold' } | { t: 'continue'; of: Key };
      needs: PoolName[]; max: { usd: number; minutes: number }; judge: Judge | { t: 'none' };
      tests: Idea | { t: 'nothing' } }
  | { t: 'command'; key: Key; goal: GoalPath; command: string; on: Sha; protect: Path[];
      output: JsonSchema; needs: PoolName[]; maxMinutes: number }
  | { t: 'ask'; key: Key; goal: GoalPath; question: string; answer: JsonSchema }
  | { t: 'land'; key: Key; goal: GoalPath; sha: Sha; recheck: Criterion[] };
type Grant = { reads: Path[]; web: boolean };   // the call reads its inputs and this; nothing else

// ---- State of one call: forward only ----
type CallState =
  | { t: 'declared' }
  | { t: 'running'; runId: string; reserved: Reservation }
  | { t: 'draining'; runId: string; reserved: Reservation }   // dropped by a rewrite, told to finish
  | { t: 'settled'; outcome: Outcome };
type Outcome =
  | { t: 'passed'; ref: Ref; code: Code; judged: boolean }
  | { t: 'failed'; ref: Ref; why: string }      // it ran; its judge said no
  | { t: 'errored'; why: string }               // no output exists; never judged
  | { t: 'cancelled'; partial: Ref }            // partial work is kept and addressable
  | { t: 'refused'; reason: Refusal };

// ---- Log: the host's. Append-only; all state is a fold over it. ----
type Entry = { at: Time } & (
  | { t: 'plan'; version: number; by: BuddyId | 'owner'; why: string; diff: Diff;
      dropped: Record<Key, 'cancel' | 'finish'> }
  | { t: 'goal'; path: GoalPath; why: string; done: Judge[] }           // emergent sub-goal
  | { t: 'phase'; path: GoalPath; name: string; edge: 'open' | 'close' }
  | { t: 'declared'; call: Call; hash: Hash; planVersion: number }
  | { t: 'started'; key: Key; hash: Hash; runId: string; reserved: Reservation }
  | { t: 'settled'; key: Key; hash: Hash; outcome: Outcome; spent: Usage }
  | { t: 'review'; question: string; decision: 'continue' | 'rewrite' | 'stop'; why: string }
  | { t: 'learned'; row: Learning }
  | { t: 'contract'; version: number; change: string }                  // owner only
  | { t: 'finished'; reason: Finish });
type Diff = { reused: Key[]; attached: Key[]; dropped: Key[]; started: Key[]; newCostUsd: number };
type Finish =
  | { t: 'met'; sha: Sha | null } | { t: 'not-met'; gaps: string[] }
  | { t: 'budget' } | { t: 'deadline' } | { t: 'stopped'; by: string };
```

`Key` is `goal path / phase / step / id` (`collect/taskus`, `measuring-stick/instrument/probe`).
It is built by the library and never typed by hand. `Hash` covers the whole call, including its
brief text and its judge.

## 5. Reconcile

Evaluating a plan (at launch, after a rewrite, after a restart) does this for each call it makes:

| The log has | Host does |
|---|---|
| settled, same key and hash | return the logged outcome at once; nothing runs or is spent |
| running, same key and hash | attach |
| running, same key, different hash | cancel it (partial work kept); start the new call |
| nothing, or settled with a different hash | reserve pools and budget atomically, then start; or return `refused` |

Running calls the plan no longer asks for are **dropped**. A rewrite must name `cancel` or
`finish` for every one of them; there is no default. `finish` lets a promising call run to the
end on what it already reserved. Its result lands in the log and wakes the leader once.

A **dry run** is the same evaluation with "start" replaced by "collect". It passes through all
finished work instantly and stops at the frontier, so its output is an exact `Diff` with cost.
The owner sees it at launch; the leader and owner see it at every rewrite.

**The tip.** A call that works in a checkout starts from the expedition's tip unless it names
another commit: the launch base until something lands, then the latest landed commit. So a wave of
work started after a `land` builds on what landed, without the plan threading commits by hand.

The plan runs as ordinary `async` code in a child process with no file or network access. It
holds no state that matters, so the host kills and re-runs it freely.

## 6. How the plan changes

1. **Data decides, inside the plan.** A step returns typed data and the plan branches on it.
2. **A review.** `x.review(question)` wakes the leader with the phases since the last review. It
   continues, stops the run ("nothing worth shipping" is a valid result), or rewrites.
3. **A rewrite.** The leader edits the folder (plan, briefs or both) and submits it with a reason.

The host also wakes the leader when the plan returned and `done` is not met, when the plan threw
or everything left is refused, at 50% and 80% of the budget, when a worker calls `flag`, and when
the owner writes something that is not a command. Each wake is a budgeted call.

A rewrite goes through four gates, in order:

| Gate | Stops |
|---|---|
| `tsc` on the folder | a plan that does not typecheck; errors go back to the leader at no agent cost |
| dry run | missing briefs, a reviewer on the producer's provider, an unknown pool, a duplicate key |
| rules | any change to the Contract; new cost over `autoApply`; a dropped call with no disposition; **no new judged pass since the last applied rewrite** (the second such rewrite goes to the owner) |
| apply | — reconcile runs |

## 7. Goals that emerge

The owner's goal is the root and only the owner changes it. Work often shows that something else
must be true first ("the benchmark is noisy; fix the measuring stick"). The leader records that as
a **sub-goal** under the root:

```ts
const stick = x.goal('measuring-stick', { why: 'Seed variance is larger than the effect we are tuning.',
                                          done: [check('python bench/variance.py --max 0.02')] });
const fixed = await stick.phase('instrument', () => instrument());
…
const ok = await stick.met(work);      // the host judges it; passing a sub-goal never ends the run
```

- A sub-goal has its own `done`, fixed when it is created, and a `why`. Both are logged.
- Every phase belongs to a goal, so the timeline groups work by the goal it serves.
- A goal that does not fit under the owner's goal cannot be adopted. It becomes an `ask`: redirect,
  spin off a new expedition, or drop it.

## 8. The learning log

- **Workers write rows as they work**, with one tool, `learn`: the idea, its family, the
  prediction, what was measured, the verdict (`keep`, `reject`, `retune`) and the evidence.
- **Steps say what they test** (`tests: { family, idea }`). The dry run refuses a call whose
  idea's family is already rejected, in this run or an earlier run on the same repo, unless the
  brief states what changed.
- **A judged call that names what it tests writes its own row**: passed is `keep`, failed is
  `reject`. No clerk step is needed to record a verdict, and a host-run benchmark records one as
  reliably as an agent does.
- **Sharing is explicit.** A call sees the log only if the plan passes `x.learnings(...)` in its
  `reads`. A blind step is one that is not given it.
- **At finish the host harvests** the rows three ways: a step writes them into the target repo's
  own knowledge files (landed like any code); the named Buddies who did the work keep them through
  the existing memory review; and a per-repo index feeds the next expedition's dry run.

## 9. Goals, invariants, acts

### Goals

| ID | Goal | By |
|---|---|---|
| G1 | Any shape of work | plain TypeScript inside phases: `wide`, loops, `best`; no step kinds in the host |
| G2 | The plan reads in a minute | cast table + `phase`/`review`/`ask` lines; briefs as files; the outline is extracted at dry run |
| G3 | Replace the plan, keep the work, choose what dies | reconcile (§5); `plan.dropped` |
| G4 | Restart safe | re-evaluation; `started.runId` re-attaches through the execution journal (`docs/turn-lifecycle.md#execution-adoption`) |
| G5 | Never overspend or oversubscribe | reservation of `needs` and `max` is the only path to `running`; machine-scope pools are shared across expeditions |
| G6 | Only the host declares done | the host evaluates `Contract.done` on the plan's candidate, on one commit |
| G7 | Unverified code cannot merge | `land` takes `Verified` only (type) and re-checks on the merged commit (host) |
| G8 | Judges are independent and fixed before the work | judge is in the cast table and the call's hash; the dry run refuses a reviewer on the producer's provider; `check` restores `protect` paths from the base |
| G9 | The deadline bounds work, not judgment | after the deadline `agent` and `command` return `refused`; `ask`, `done` evaluation and `land` complete |
| G10 | Waiting on the owner holds nothing | `ask` reserves no pool and no budget |
| G11 | The goal cannot drift | the Contract is owner-written; sub-goals hang under it with their own logged `done` |
| G12 | Reflection is bounded and tied to evidence | wakes are budgeted calls; the no-new-pass rule |
| G13 | Nothing is tested twice by accident | `tests` + the learning log, checked at dry run |
| G14 | A wide step cannot waste its whole width on a broken setup | `wide` runs one item's whole trial first; if it errored or was refused, the rest are refused unspent. A judged "no" is a real answer and does not stop the rest |
| G15 | Multi-harness, and persistent named Buddies | `seat(...)` through `vendor/agent-cli-tool`; `buddy(...)` runs as a worker run on that Buddy |
| G16 | One id, one timeline | the log: calls are bars, phases and goals are bands, plan versions and reviews are markers |

### Invariants

| ID | Invariant | Guard |
|---|---|---|
| I1 | A `(key, hash)` starts at most once | ❌ Quint invariant; host test with a restart between `declared` and `started` |
| I2 | `spent + reserved <= budget` at every instant | ❌ Quint invariant |
| I3 | A settled outcome never changes | ❌ append-only write path; Quint invariant |
| I4 | After reconcile, every running call is asked for or `draining` | ❌ Quint invariant (rewrite racing a start and a settle) |
| I5 | Only the owner changes the Contract | ❌ write-path check; host test |
| I6 | `finished: met` only after every criterion passed on one sha | ❌ Quint invariant |
| I7 | A pending `ask` survives the deadline and any rewrite | ❌ Quint invariant; regression test from `bce2400` |
| I8 | An `errored` or `cancelled` call is never judged | ❌ no such transition; host test (prior-art L6) |
| I9 | A `draining` call keeps its reservation and starts nothing new | ❌ Quint invariant |
| I10 | A cancelled call's partial work is addressable before its tree is released | ❌ host test |
| I11 | A rewrite that fails `tsc` or the dry run changes no state | ❌ host test |
| I12 | Every call belongs to exactly one goal and one phase | ❌ dry-run error |

### Acts

| Act | Who | Requires | Otherwise |
|---|---|---|---|
| launch | owner | the four gates pass; every `check` command can run on the base | refused with the reason |
| rewrite | leader, owner | the four gates (§6) | back to the leader, or an owner ask |
| change the Contract | owner | — | — |
| add a sub-goal | leader | `done` and `why` given; parent exists | dry-run error |
| steer, cancel a call | leader, owner | the call is running | reported, no change |
| answer an ask | owner | — | — |
| learn, flag | worker | inside its own call | — |
| finish | host | `done` evaluated, or budget, deadline, stop | — |
| pause, resume, stop, extend | owner | as today | — |

## 10. The nine cases

The original folder examples have been ported into [runnable v1 one-file examples](v1/examples/README.md).
This table records the earlier design’s plan-only line counts and intended guarantees;
the ports’ headers state which guarantees v1 does not implement.

| Case | Plan | Briefs | Shape |
|---|---|---|---|
| [01 GTM research](v1/examples/01-gtm.expedition.ts) | 52 lines | 8 | scope → collect (wide, anchored) → ⟳ → synthesize → duel ×3 on three providers → ⟳ → packet → land → ✋ owner |
| [02 Game design](v1/examples/02-game-design.expedition.ts) | 90 lines | 9 | measure the stick → [sub-goal: fix it] → exploit hunt → ⟳ → theory → levers (wide) → host A/B per lever → ⟳ → stack best 3 → confirm on reserved seeds → ✋ playtest → record → land |
| [03 Sim auto-research](v1/examples/03-sim-autoresearch.expedition.ts) | 82 lines | 5 | cases → noise A/A (wide, Modal) → [sub-goal: measuring stick] → ⟳ → 3 generations of propose → implement → gate, keep best 3 → ⟳ → confirm (counted) → record → land |
| [04 Frontier math](v1/examples/04-frontier-math.expedition.ts) | 80 lines | 10 | freeze → 4 blind discovery runs → census on another provider → ⟳ → falsify ≤2 survivors (counted) → ⟳ → record → land, or an honest gap |
| [05 Sim capabilities](v1/examples/05-sim-capabilities.expedition.ts) | 77 lines | 6 | cells → baseline (wide, rows × engines) → ⟳ → per row: diagnose → repair → replay → strike (counted) → ⟳ → integrate → re-score the matrix → ⟳ → record → land |
| [06 Deslop](v1/examples/06-deslop.expedition.ts) | 73 lines | 6 | measure → inventory (wide) → target → land → ⟳ → waves: seams (narrow) → slices (wide, fenced) → land each → ⟳ → re-measure → closeout → land |
| [07 CRUD SaaS](v1/examples/07-crud-saas.expedition.ts) | 47 lines | 5 | foundation → land → first feature → land → the rest (wide, fenced) → integrate → walkthrough → land → ✋ owner |
| [08 Geometry engine](v1/examples/08-geometry-engine.expedition.ts) | 59 lines | 5 | derive → loop ≤3: implement (same conversation) → guarded probe → ⟳ → the one replay → receipt → land → ✋ owner |
| [09 Document model](v1/examples/09-document-model.expedition.ts) | 82 lines | 11 | ledger → design → ≤3 rounds: attack → adjudicate → ✋ rulings ∥ spikes → revise → ⟳ → ✋ ratify → retirement plan → land |

`⟳` is a review, `✋` an owner check-in. Each folder's `contract.md` ends with a "Not yet real"
list (scripts, Buddy ids and paths the example assumes), and its `NOTES.md` lists what the API
could not express for that case.

## 11. Known weaknesses

- **The host runs code the leader wrote.** A child process with only the API, a timeout, and no
  file or network access. The leader already has a shell in its own turns, so the risk is bugs.
- **Renaming a step or editing a brief reruns its finished calls.** Correct, sometimes wasteful.
  The dry run shows the cost first; `autoApply` stops a large one.
- **The launch preview shows only the first wave.** Hard limits come from the Contract.
- **Read and web grants are only as strong as the harness.** The dry run reports each grant as
  enforced or advisory per call.
- **Judge independence is checked at dry run, not by the compiler.** Providers pass through as
  plain strings (a repo rule), so there is no closed list to type against.
- **Steering differs by harness.** `steer` reports whether it was delivered mid-turn or queued.
- **Plans are not twenty lines.** The nine example plans run from about 45 to 90 lines. The cast
  table and the phase lines keep them readable, but a case with real branching is longer than the
  GTM sketch suggested.

Limits the nine cases found and this design does not yet solve (each is recorded in that
example's `NOTES.md`):

- **A pool is held for a whole call.** A compile lock cannot be held for only the build part of a
  build-then-simulate command (case 2).
- **A counted pool is shared, not per item.** "Two strikes per row" is enforced only as a total
  (case 5). More strikes need a Contract change by the owner.
- **A worker's own in-turn runs are not pooled.** The guard pool gates host commands; an agent
  running the same test inside its turn is forbidden by rule only (case 8).
- **A checkout cannot carry a read allowlist**, and a review judge's read grant cannot be stated,
  so blindness for a step that needs a tree is advisory (case 4).
- **`protect` restores from the launch base**, so it cannot guard a grader that an earlier step
  of the same run wrote (case 7).
- **A review judge answers pass or fail.** A typed verdict (`survives`, `revise`, `kill`) needs a
  separate judged step that returns a schema (cases 4 and 9).
- **`land` takes one commit.** Combining several verified commits needs an integrating agent
  step, whose result is verified only by its own judge until re-scored (cases 5 and 6).
- **The plan cannot read the Contract's owner criterion**, so a plan that must branch on the
  owner's ratification asks its own question first (case 9).
- **Staged judgment records a verdict early.** When two calls test the same idea (a cheap screen,
  then the paid gate), each writes a learning row, so `keep` is written before the gate has
  spoken, and a host-written row cannot say `retune` (cases 3 and 5).
- **`tests` on the measuring call refuses late.** If the idea is named on the benchmark and not on
  the change that precedes it, an already-rejected family is refused only after the change was
  paid for (case 2).
- **One judge per step.** Several checks chained into one command record one pass or fail, not
  which check failed (case 6).
- **"Idle host" is not a pool.** A timing measurement that needs a quiet machine cannot ask for
  one (case 3).

## 12. Open questions

- q1: reuse a finished call when only its brief's wording changed? This draft: no, strict hash.
- q2: may a rewrite apply while calls are in flight, or only when the plan is waiting?
- q3: what is reserved for a harness that reports no usage?
- q4: is a named Buddy a one-slot pool, or can it run several calls at once?
- q5: with several expeditions asking the owner at once, how are asks ordered and batched?
- q6: what priority rule do machine-scope pools use between expeditions?
- q7: what progress signal does a running call give the leader for a cancel-or-finish choice?
- q8: does "every check can run on the base" apply to a command whose file an earlier step of the
  same run creates? (cases 7 and 8)
- q9: a `done` check that needs a `uses` pool would spend it again at finish. Should `done` reuse
  a logged result for the same commit? (case 8)

## 13. Build order

0. **Quint model** of §4's call states, the budget ledger and reconcile (I1–I4, I6, I7, I9).
1. **Kernel:** log, reconcile, reservation, dry run, `agent` (no tree), `command`, `ask`; the
   cast table, briefs and phases. Pilot: 01 GTM. Replaces `server/src/expeditions/host.ts`.
2. **Change:** reviews, leader wakes, the four gates, cancel-or-finish, sub-goals, `buddy(...)`,
   the timeline view. Pilot: 09 document model.
3. **Code and compute:** checkouts, `land`, machine and spend pools, the learning log and its
   harvest. Pilot: 03 sim auto-research.
