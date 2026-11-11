# Expeditions v1: the smallest version worth running

Status: **built and connected to the server behind `UNLEASHD_EXPEDITIONS_V1=1` (off by default),
2026-11-11. Two real-agent runs have passed; see [CONNECT_PLAN.md](CONNECT_PLAN.md) §10 for what it
showed and what is open.** The kernel is
`server/src/expedition-kernel/` (about 4,800 lines) with tests `server/test/expedition-kernel-*`:
a pure core driven through 20,000 random steps, real plan child processes, and end-to-end runs of
the GTM plan against a scripted executor (full run, crash and reopen, a rewrite with
cancel-or-finish, every gate failure, the deadline, retry). The concurrent core is modelled in
`docs/specs/expedition-keyed.qnt`: random simulation over 200,000 traces, not a proof. The
executor over Buddy runs, the routes and the timeline view are built (CONNECT_PLAN.md §8).
§10 lists what building it changed. The API
is the authoring library itself
([`server/src/expedition-kernel/authoring/index.ts`](../../../../server/src/expedition-kernel/authoring/index.ts);
[`expedition.d.ts`](expedition.d.ts) re-exports it), and both example plans typecheck
(`../../../../server/node_modules/.bin/tsc -p ../tsconfig.json`, from this folder).

This is what to build first. [`../DESIGN.md`](../DESIGN.md) is the larger design it was cut from;
its nine example cases are the checklist for what v1 leaves out.

## 1. The goal

**The owner states a goal once. Agents on any harness work toward it for hours without the owner
present. The plan can be replaced as the work teaches it, without losing or re-paying for anything
finished. Only the host says "done".**

v1 is a success if one real case (GTM research) runs on it and beats the same case run as a
Claude Code workflow with the owner steering in chat. §8 says how that is measured.

## 2. The idea

An expedition is one TypeScript file, conventionally `<name>.expedition.ts`, anywhere on disk.
It imports only the bare specifiers `expedition` and `zod`:

```ts
import { expedition, role, seat, steps, need } from 'expedition';
const worker = role({ by: seat('claude', 'claude-sonnet-5-5', 'low'), usd: 1, minutes: 10 });
const { probe } = steps({ probe: worker.brief('Find the evidence.') });
export default expedition({
  contract: { goal: 'Find evidence.', leader: 'lead', repo: '~/git/x',
    budget: { usd: 3, hours: 1 }, autoApply: { usd: 1 }, pools: { claude: 1 },
    done: [{ owner: 'Accept the evidence?' }], rules: ['No outreach.'] },
  plan: async (x) => need(await x.phase('probe', () => probe()), 'No evidence.'),
});
```

The contract is a plain JSON literal inside the file; it remains the owner's. Every agent step
has `.brief(text)` or `.brief((item: Org) => text)`. Commands and check commands take the same
string-or-item-function form. Review rubrics are inline strings, including in `contract.done`.
There are no prompt files or template slots. The item function's type reaches the call:
`collect({ item: org })` requires an `Org`; a string brief takes no item. Missing briefs are named
dry-run errors for every cast-table step, including steps the run never reaches. TypeScript
cannot inspect a function's returned prose or defeat explicit casts/`any`; runtime validation
still checks rendered text and the IPC boundary. Attach item-dependent judges after the final
`.brief(...)`: replacing the brief later cannot re-check an already attached callback's item type.

The plan process sends the contract as its first message, before the cast table and calls. The
host validates it with the canonical Contract schema and supplies the two budget-derived caps.
Functions, getters, class instances, cycles and other non-JSON contract data are errors.
Each applied version is `plans/v<N>.expedition.ts`. A leader's draft folder holds one editable
`plan.expedition.ts`; its canonically evaluated contract must equal the launched contract or the
rules gate rejects it. `dispositions.json` remains a sidecar for dropped-running-call decisions,
not part of the plan or contract.

`propose {file}`, preview `{file}`, launch `{workspaceId, file, digest?}` and the proposal card all
name an absolute `.ts` file. Proposals require it inside a folder the Buddy workspace owns. The
digest covers the real path and exact file bytes. No live keyed expeditions exist, so this is a
format replacement with no migration or folder compatibility path.

Every unit of work has a **key** (`collect/taskus`). The host keeps an append-only **log** of what
each key produced. Running a plan means, for each keyed call: finished → return the logged result;
running → attach; new → reserve budget and a pool slot, then start. This is **reconcile by key**.
Restart recovery, plan rewrites and the cost preview are all that one rule.

The owner writes the Contract, the leader writes the Plan, the host writes the Log. Nobody writes
another's.

[`gtm.expedition.ts`](gtm.expedition.ts) is the complete worked example. Its structure is the lines that
start `x.phase`, `x.review` and `need(...)`:

```
scope → collect (parallel) → ⟳ review → synthesize → duel ×3 → ⟳ review → packet
```

## 3. What is in, and what is out

| In v1 | Why it cannot wait |
|---|---|
| `agent` steps on any harness; named Buddy or anonymous seat | the point of the thing |
| `command` steps the host runs | objective judging |
| A judge declared on each step: a check command, or a review on another provider | independent judging is the main bet on better results |
| `ask` / `confirm`: owner check-ins that hold nothing | the failure that started this (a verdict wait recorded as "skipped") |
| The cast table, inline briefs, phases | the plan has to be readable to be rewritten |
| `review` and plan rewrite, with cancel-or-finish | the difference from a workflow |
| Budget in dollars and hours; pools as concurrency caps | never overspend |
| Dry run with a cost diff | see a change before paying for it |

| Out of v1 | It comes back when |
|---|---|
| Sub-goals under the owner's goal | a real run needs to fix something first and the timeline cannot show why |
| The learning log and the no-retest check | a second run on the same repo repeats a refuted idea |
| Merging by the host (`land`), verified-only | the owner is tired of merging by hand; until then the owner merges, as today |
| Counted and spend pools, machine-wide locks | the first case that needs a GPU, Modal or "one replay" (cases 2, 3, 5, 8) |
| Per-call fences and protected grader paths | the first code case (6, 7) |
| Pilot one before a fan-out | a fan-out wastes its width on a broken brief once |

Each row on the right is designed in `../DESIGN.md`. None is needed to run GTM.

## 4. Types

The authoring API is the library
([`authoring/index.ts`](../../../../server/src/expedition-kernel/authoring/index.ts), re-exported
by [`expedition.d.ts`](expedition.d.ts)). The host turns each authored call into
one of these, with no optional fields:

```ts
type Contract = {
  goal: Markdown;                      // the owner's words
  done: Criterion[];                   // the host evaluates all of them on the plan's candidate
  budget: { usd: number; hours: number };
  pools: Record<PoolName, number>;     // concurrency caps
  rules: string[];                     // appended to every brief
  leader: BuddyId; repo: Path;
  autoApply: { usd: number };          // a rewrite adding more new cost than this waits for the owner
  leaderWake: Cap;                     // { t: 'given' | 'defaulted'; usd; minutes }: one wake's bound
  doneReview: Cap;                     // the same, for one host-run done check or review
};
type Criterion =
  | { t: 'check'; command: string }
  | { t: 'review'; rubric: Markdown; by: Seat }
  | { t: 'owner'; question: string };

type Call =
  | { t: 'agent'; key: Key; by: Who; brief: Markdown; inputs: Ref[]; output: JsonSchema;
      tree: 'none' | 'checkout'; base: Sha; grant: { reads: Path[]; web: boolean };
      context: { t: 'cold' } | { t: 'continue'; of: Key };
      pools: PoolName[]; max: { usd: number; minutes: number }; judge: Judge | { t: 'none' } }
  | { t: 'command'; key: Key; command: string; on: Sha; output: JsonSchema; pools: PoolName[]; maxMinutes: number }
  | { t: 'ask'; key: Key; question: string };

type CallState =                       // forward only
  | { t: 'declared' }
  | { t: 'running'; runId: string; reserved: Reservation }
  | { t: 'draining'; runId: string; reserved: Reservation }   // dropped by a rewrite, told to finish
  | { t: 'settled'; outcome: Outcome };
type Outcome =
  | { t: 'passed'; ref: Ref } | { t: 'failed'; ref: Ref; why: string }
  | { t: 'errored'; why: string }      // no output; never judged
  | { t: 'cancelled'; partial: Ref }   // partial work kept
  | { t: 'refused'; reason: 'budget' | 'deadline' | 'pool' | 'needs-owner' };

type Entry = { at: Time } & (          // the log: append-only; all state is a fold over it
  | { t: 'plan'; version: number; by: BuddyId | 'owner'; why: string; diff: Diff;
      dropped: Record<Key, 'cancel' | 'finish'> }
  | { t: 'phase'; name: string; edge: 'open' | 'close' }
  | { t: 'declared'; call: Call; hash: Hash; planVersion: number }
  | { t: 'started'; key: Key; hash: Hash; runId: string; reserved: Reservation }
  | { t: 'settled'; key: Key; hash: Hash; outcome: Outcome; spent: Usage }
  | { t: 'review'; question: string; decision: 'continue' | 'rewrite' | 'stop'; why: string }
  | { t: 'contract'; version: number; change: string }
  | { t: 'act'; key: Key; after: BaseWake; act: LeaderAct;   // what became of one leader act
      verdict: { t: 'accepted' } | { t: 'rejected'; issues: string[] } }
  | { t: 'finished'; reason: 'met' | 'not-met' | 'budget' | 'deadline' | 'stopped' });
type Diff = { reused: Key[]; attached: Key[]; dropped: Key[]; started: Key[]; newCostUsd: number };
```

`Key` is `phase / step / id`, built by the library. `Hash` covers the whole call, brief text
included. `grant` and `tree` decide what the call's turn may do: one policy table
(`server/src/expedition-kernel/access.ts`) turns them into a capability set that the harness
enforces where it can, and the preview says which grants are only advisory (CONNECT_PLAN §10).

## 5. How a plan changes

- `x.review(question)` wakes the leader with what settled since the last review. It continues,
  stops the run with a gap, or rewrites.
- The host also wakes it when the plan ended and `done` is not met, when the plan cannot proceed,
  at 50% and 80% of the budget, and when the owner writes something that is not a command.
- An act a gate refuses changes nothing and wakes the leader again with the reasons; two rejected
  in a row at one wake point and the host asks the owner instead (continue, stop, or wait for a
  rewrite). The count is folded from the log (`act` entries), so it survives a restart.
- A rewrite is the leader editing the file and submitting it with a reason. It passes four
  gates in order: **typecheck**, **dry run** (every agent step has a brief, no reviewer on its producer's
  provider, pools exist, no duplicate key), **rules** (Contract untouched, new cost under
  `autoApply`, at least one new judged pass since the last rewrite, a `cancel` or `finish` for
  every running call the new plan drops), then **apply**.

[`gtm/rewrite/REWRITE.md`](gtm/rewrite/REWRITE.md) walks through one rewrite end to end: the
trigger, the leader's reason, the gates, the diff, the kill-or-finish choice and the timeline.

The plan runs as ordinary `async` code in a child process. It can read only an isolated copy of its
one file and the library/dependencies, cannot write or spawn, and imports only expedition/zod.
Node 24 does not block sockets; do not treat this as network confinement. It holds
no state that matters, so the host kills and re-runs it whenever it needs to.

## 6. Guarantees

| ID | Guarantee | Guard |
|---|---|---|
| I1 | A `(key, hash)` starts at most once, across restarts and rewrites | ❌ Quint invariant; host test |
| I2 | `spent + reserved <= budget` at every instant | ❌ Quint invariant |
| I3 | A settled outcome never changes | ❌ append-only write path; Quint invariant |
| I4 | After reconcile, every running call is asked for or `draining` | ❌ Quint invariant |
| I5 | Only the owner changes the Contract; only the host writes `finished` | ❌ write-path checks; host test |
| I6 | A pending `ask` survives the deadline and any rewrite | ❌ Quint invariant; regression test from `bce2400` |
| I7 | An `errored` or `cancelled` call is never judged | ❌ no such transition; host test |
| I8 | A rewrite that fails a gate changes no state | ❌ host test |

After the deadline no agent or command starts; `ask` and the `done` evaluation still complete.

## 7. What exists, and what is new

| Piece | Status |
|---|---|
| Run an agent on any harness, journaled, surviving restarts | exists: `vendor/agent-cli-tool`, Buddy runs, execution adoption |
| Worker runs on a named Buddy or a chosen model | exists: `server/src/buddies/worker-config.ts` |
| Steer a running turn | exists: `server/src/buddies/harness-steering.ts` |
| Checkout per unit of work | exists: `server/src/expeditions/cambium.ts` |
| Host-run checks | exists: `server/src/expeditions/checks.ts` |
| Atomic record writes; owner chat commands | exists: `record.ts`, `brief.ts` |
| The log and reconcile | **new** |
| Plan runner (child process), dry run and diff | **new** |
| Budget and pool reservation | **new** |
| Leader wakes, the four gates, cancel-or-finish | **new** |
| The cast-table library (`steps`, `role`, `need`, `parallel`) | **new**, small |
| Timeline view | **new**, a fold over the log |

It replaces `server/src/expeditions/host.ts` and the per-expedition crew Buddy.

## 8. Build order, and how we will know

0. **Baseline, this week, no code.** Run GTM as a Claude Code workflow with the owner steering in
   chat, using the same briefs. Record: dollars, owner minutes, claims that survive the
   `traceable` review, and what went wrong.
1. **Quint model** of §4's call states, the budget and reconcile (I1–I4, I6).
2. **Kernel:** log, reconcile, reservation, plan runner, dry run, `agent`, `command`, `ask`.
3. **Change:** `review`, leader wakes, the gates, cancel-or-finish, the timeline.
4. **Run GTM on it** and compare with step 0 on the same four numbers.

If step 4 does not beat step 0 on verified claims per dollar or on owner minutes, stop and find
out why before building anything from the "out of v1" list.

## 10. What building it changed

The Quint model found these before the code was written; each is now a rule in the core with a
test that fails without it:

- **Log first.** `started`, with its reservation and a run id derived from the key, hash and
  attempt, is appended before the executor is asked to start. The first design logged it after,
  so a crash or a rewrite in between left a run that spent outside the budget and could not be
  cancelled. At boot an unknown logged start is issued again (start is idempotent).
- **Settling closes the run ids,** so a start that arrives late does nothing.
- **An ask is never cancelled.** A plan that drops or rewords a question leaves it open.
- **Retry is explicit.** An errored, cancelled or refused outcome is reused like any other until
  an owner or leader `retry` moves the call to its next attempt.
- **A judge belongs to its call.** It may start after the deadline, under that call's reservation.
- **A producer that answers while its call is being cancelled** settles `cancelled`, unjudged.

Building the kernel found two more:

- **A dry run cannot see past work that is still running.** In the rewrite walkthrough the four
  new `mine` calls sit behind collects that are still in flight, so the diff's `started` list is
  empty and its new cost is $0 when the rules gate runs. The auto-apply limit therefore only
  bounds work the new plan can start at once, not everything it adds. See §9 q4.
- **Leader wakes and done criteria are calls too** (`leader`, `verdict`), so they use the same
  log, budget, reuse and restart path. The contract bounds each one: `leaderWake` and
  `doneReview`, each `{usd, minutes}`, either the owner's (`given`) or the host's rule applied to the
  budget (`defaulted`, shown as such in the parsed contract). The rule, `defaultCap` in
  `expedition-kernel/contract.ts`: usd = min(budget, clamp(10% of budget, $0.25, $1.00)); minutes =
  min(budget hours, clamp(10% of budget minutes, 5, 20)). The first real run paid $0.039 and 12 s
  for a wake, so the floor is ~6x a real wake; 10% keeps wakes proportionate on a small budget
  (a $3 budget reserves $0.30 per wake, not the $2 that held most of it); the ceiling stops a
  large budget reserving an agent-sized sum per wake. A log written before the fields existed reads
  them as `defaulted` $2 / 20 min, what it ran under.

Keys are `phase/step/id` (`collect/collect/taskus`), not the shorter `collect/taskus` used in
earlier sketches.

## 9. Open questions

- q1 (answered by the model): a rewrite may apply while calls are in flight, given the log-first
  rule in §10. Without it, it is not safe.
- q2: what is reserved for a harness that reports no usage?
- q3: editing a brief reruns every call of that step (REWRITE.md §8). Is strict identity right, or
  should a finished call survive a wording change?
- q4: the cost gate sees only calls the new plan can start immediately (§10). Should a rewrite
  declare a cost ceiling for what it adds, enforced as the added calls start?
