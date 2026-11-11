# Expeditions as keyed, replaceable scripts

Status: superseded by the [keyed expedition system](keyed/v1/DESIGN.md); retained as historical design/research. Old host deleted 2026-11-11.

Status: **independent design, 2026-11-10. Not built, not model-checked.** Written from the
problem statement only (`research/use-cases.md` §10, `research/prior-art.md` §6) without adopting
the structure of V1–V4 or `final/`. Conventions: `../design-specs.md`. §9 says where it overlaps
`final/` and where it differs.

## 1. The idea in one paragraph

An expedition is a **TypeScript script that the host can throw away and replace at any moment
without losing anything.** Every unit of work the script asks for carries a **key**. The host
keeps an append-only log of what each key produced. Running a script means: for each keyed call,
return the logged result if there is one, attach to it if it is running, start it if it is new.
Calls that are running but that the script no longer asks for are cancelled. That one rule
(**reconcile by key**) gives restart recovery, plan revision, "cancel the graph but keep what
happened", and an exact preview of any change, all from the same mechanism.

The comparison is a build system or `terraform plan/apply`, not a workflow engine: the script
says what should exist, the log says what does, and the host computes the difference.

## 2. Why the earlier attempts failed, and what each failure says

| Attempt | What broke | The lesson taken |
|---|---|---|
| oompa (flat queue) | 56% of cycles claimed nothing | Work is assigned by a plan, never self-claimed |
| Ledger engine | 13.5k lines, every run ended at the deadline | The host must be small; rich structure belongs in user code |
| Lean host (today) | One retry loop; a pass ends everything; owner gate held the only slot | Step results and expedition termination are separate things |
| Leader + round graphs (V1/V2) | Bugs in patching a running graph | Never mutate a running plan. Replace it and reconcile |
| Durable script with positional replay (`final/`) | Not built; script must be deterministic, and editing it mid-run is undefined | Identify work by key, not by position, so editing is the normal case |

The pattern across all five: **the plan and the facts were stored in the same structure**, so
changing the plan risked the facts (patch races), or protecting the facts froze the plan (retry
loop, replay). Separating them is the design.

## 3. Three things, three owners

| Thing | Owner | Can change it | Contents |
|---|---|---|---|
| **Contract** | owner | owner only | goal in the owner's words, done criteria, budget, pools, rules, leader |
| **Script** | leader | leader or owner, any time | the plan: ordinary TypeScript over four verbs |
| **Log** | host | nobody edits; host appends | every call's declaration, start, result; every ask and answer; every script version |

Each party writes only its own thing. "Did the leader quietly lower the bar?" has a mechanical
answer: the bar is in the Contract, and the leader cannot write the Contract.

## 4. Types

```ts
// ---- Contract: the owner's. Fixed unless the owner changes it. ----
type Contract = {
  goal: Markdown;                      // verbatim, shown beside every result
  done: Criterion[];                   // the host evaluates these on ONE commit; nobody else may
  budget: { usd: number; hours: number };
  pools: Record<PoolName, Pool>;
  rules: string[];                     // carried verbatim into every agent brief
  leader: BuddyId;                     // a persistent, named Buddy with memory
  autoApply: { usd: number };          // a rewrite adding more new cost than this needs the owner
};
type Criterion =
  | { t: 'check'; argv: string[]; protect: RepoPath[] }
  | { t: 'review'; rubric: Markdown; seat: Seat }
  | { t: 'owner'; question: string };
// One concept for every scarce thing: concurrency, countable uses, money, machine-wide locks.
type Pool =
  | { t: 'slots'; n: number; scope: 'expedition' | 'machine' }   // local GPU = 1, compile lock = 1
  | { t: 'uses'; n: number }                                     // "exactly one replay"
  | { t: 'spend'; usd: number; slots: number };                  // Modal

// ---- Script: the leader's. Replaceable. ----
type Script = (x: X) => Promise<Candidate>;
type Candidate = { result: Ref; gaps: string[]; code: { t: 'none' } | { t: 'commit'; sha: Sha } };

interface X {
  agent<T>(key: Key, call: AgentCall<T>): Promise<Outcome<T>>;
  check(key: Key, call: CheckCall): Promise<Checked>;
  ask<T>(key: Key, q: { question: string; answer: Schema<T> }): Promise<T>;
  land(key: Key, l: { sha: Sha; checks: string[][] }): Promise<Landed>;
  rows<T>(kind: string): Row<T>[];     // settled, typed records from the log; read-only
}

type AgentCall<T> = {
  by: { t: 'buddy'; id: BuddyId } | { t: 'seat'; seat: Seat };  // named with memory, or anonymous
  prompt: Markdown;
  inputs: Ref[];                       // EVERYTHING the call may read; nothing else is granted
  out: Schema<T>;                      // schema-forced answer
  tree: { t: 'none' } | { t: 'checkout'; base: Sha };
  context: { t: 'cold' } | { t: 'continue'; of: Key };          // resume another call's conversation
  needs: PoolName[];                   // reserved all-or-nothing before start
  max: { usd: number; minutes: number };
  judge: Judge;                        // declared before the work runs, part of the call's identity
  expect: { t: 'none' } | { t: 'claim'; text: string; metric: MetricBound };
};
type Seat = { provider: string; model: string; effort: string }; // verbatim to vendor/agent-cli-tool
type Judge =
  | { t: 'none' }                                                // output is a CLAIM, never VERIFIED
  | { t: 'check'; argv: string[]; protect: RepoPath[] }
  | { t: 'review'; rubric: Markdown; seat: Seat };               // host refuses seat.provider == producer's
type CheckCall = { argv: string[]; on: Sha; protect: RepoPath[]; needs: PoolName[]; maxMinutes: number };

type Outcome<T> =
  | { t: 'passed'; out: T; ref: Ref; code: Candidate['code']; expected: Graded }
  | { t: 'failed'; out: T; ref: Ref; why: string; expected: Graded }   // judge said no
  | { t: 'errored'; why: string }                                      // turn failed; never judged
  | { t: 'cancelled'; partial: Ref }                                   // work so far is kept
  | { t: 'refused'; reason: 'budget' | 'deadline' | 'pool-exhausted' | 'needs-owner' };
type Graded = { t: 'no-claim' } | { t: 'held' } | { t: 'missed'; measured: number };

// ---- Log: the host's. Append-only; state is a fold over it. ----
// Every entry also carries `at: Time`. The expedition id is the one id everything hangs from:
// script versions, call keys, run ids (the Buddy run and conversation), git refs, asks.
type Entry = { at: Time } & EntryBody;
type EntryBody =
  | { t: 'script'; version: number; by: 'owner' | BuddyId; reason: string; diff: Diff }
  | { t: 'declared'; key: Key; hash: Hash; call: unknown; scriptVersion: number }
  | { t: 'started'; key: Key; hash: Hash; runId: string; reserved: Reservation }
  | { t: 'settled'; key: Key; hash: Hash; outcome: unknown; spent: Usage }
  | { t: 'asked'; key: Key; question: string }
  | { t: 'answered'; key: Key; answer: unknown }
  | { t: 'contract'; version: number; change: string }                 // owner only
  | { t: 'finished'; reason: Finish };
type Diff = { reused: Key[]; attached: Key[]; cancelled: Key[]; started: Key[]; newCostUsd: number };
type Finish =
  | { t: 'met'; sha: Sha | null } | { t: 'not-met'; gaps: string[] }
  | { t: 'budget' } | { t: 'deadline' } | { t: 'stopped'; by: string };
```

`Key` is a path (`collect/acme`, `duel/r2/critic`). The path is also the folder tree the UI shows.
`Hash` covers the whole call: prompt, inputs, seat, judge, expectation.

## 5. The one mechanism: reconcile

Evaluating a script (at launch, after a rewrite, after a backend restart) does this for each
keyed call the script makes:

| The log has | Host does |
|---|---|
| settled, same key and hash | return the logged outcome at once. Nothing runs, nothing is spent |
| running, same key and hash | attach to the running turn |
| running, same key, different hash | cancel it (partial work kept), start the new call |
| settled, same key, different hash | start the new call; the old outcome stays in the log |
| nothing | reserve its pools and budget atomically, then start; or return `refused` |

When the evaluation has nothing left to do but wait, every running call the script did **not**
ask for is cancelled, and its partial work is kept and addressable.

A **dry run** is the same evaluation with "start" replaced by "collect". It walks through all
finished work instantly (memo hits) and stops at the frontier, so its output is an exact `Diff`:
what is reused, what keeps running, what is cancelled, what would start, and what the new work
costs. That diff is what the owner sees at launch and at every rewrite.

What falls out of this, without further machinery:

- **Restart recovery** is a re-evaluation. No positional replay, no determinism requirement: a
  script that calls `Math.random()` just asks for different keys.
- **Self-modification** is a new script version. Nothing is patched.
- **"Cancel the graph, keep what happened"** is the default behaviour of a rewrite.
- **Resuming a worker's context** is `context: { t: 'continue', of: key }`, which also works on a
  cancelled call's partial conversation.
- **Predict before you measure** is structural: `judge` and `expect` are in the call's
  declaration, logged before it starts, and part of its hash. Changing a judge after seeing a
  result makes a different call, visibly.

### The waterfall

The log is the timeline view with no extra store. Each call is a bar from `started` to `settled`,
nested by its key path; `declared.scriptVersion` says which plan asked for it; each `script` entry
is a vertical marker carrying its reason and diff; an `asked` without an `answered` is a bar still
waiting on the owner. A self-modifying run reads as one chart: what ran under which plan, and
what each rewrite reused, cancelled and started.

## 6. How the plan changes itself

There are two levels, and neither needs a new concept:

1. **Data decides, inside the script.** A reflection is an ordinary `x.agent` call to the leader
   with a typed answer (`{ next: 'duel' | 'collect-more' | 'stop', why }`), and the script
   branches on it. Cheap, anticipated adaptivity.
2. **The leader replaces the script.** For changes the script did not anticipate. The host wakes
   the leader, the leader submits a new version with a reason, the host dry-runs it and applies
   the diff.

| Host wakes the leader when | Why |
|---|---|
| the script returned a candidate and `done` is not met | the plan finished without reaching the goal |
| the script threw, or everything left is `refused` | the plan cannot proceed |
| a call's judge failed twice under the same key prefix | repeated failure in one area |
| spend crosses 50% and 80% of the budget | chance to cut scope |
| a worker calls the `flag(reason)` tool | workers see a broken plan first |
| the owner writes something that is not a command | conversation |

Each wake is itself a budgeted call (`leader/<n>`), so reflection cannot be free or unbounded.

**Kill or let finish is the leader's choice, per call.** The dry run lists every running call
the new script no longer asks for, with its elapsed time, spend so far and last progress line. The
rewrite must then name a disposition for each one: `cancel` (partial work kept) or `finish` (it
runs to completion on the budget and pools it already reserved; its result lands in the log, is
readable through `x.rows` and by any later script, and wakes the leader once). There is no
default: a rewrite that leaves a dropped running call without a disposition is rejected. A
promising call the new plan still wants is simpler: keep its key in the new script and it is
attached, not restarted.

```ts
type Rewrite = { script: Source; reason: string; dropped: Record<Key, 'cancel' | 'finish'> };
```

Rules on a rewrite, all mechanical:

- It may not touch the Contract. A change the leader wants there becomes an `ask`.
- If `diff.newCostUsd > contract.autoApply.usd`, it waits for the owner.
- **Progress rule:** a rewrite is applied only if at least one call has newly `passed` its judge
  since the last applied rewrite. A second rewrite with no new pass goes to the owner with both
  diffs. Activity is not progress; a passed judge is.

Owner steering mid-run, as chat commands the host applies: `pause`, `resume`, `stop`,
`extend Nh`, `steer <key> <message>` (delivered into the running turn), `cancel <key>`,
`answer <key> …`. A check-in is `x.ask`: it holds no pool, costs nothing while it waits, and
stays answerable after the deadline.

## 6a. What a script should look like

The §4 types are the host's contract, not what an author writes. A script written straight
against them has the faults of the earlier examples (`final/examples/01-gtm.expedition.ts` is 160
lines): schemas and config crowd out the plan, each prompt is squeezed into one line, and nothing
marks where the plan reflects. Four authoring rules fix that. All four are library code over the
four verbs; none adds a host concept.

1. **Briefs are files, not string literals.** Each step's prompt is a markdown file beside the
   script (`briefs/collect.md`), as long as the work needs, with `{{org.name}}` slots. The brief
   is where the thinking goes; the leader and the owner both read and edit it as prose. Its text
   is part of the call's hash.
2. **Roles are declared once.** `role({ by, tree, max, needs })` returns a function, so a call
   site is `scout(key, brief, extras)`, not ten fields.
3. **A standard report is the default output.** Every call returns `{ summary, claims[], refs[] }`
   plus its files. A schema is written only where the script itself reads a field: a list to fan
   out over, a flag to branch on.
4. **Shape and meta points are named lines.** `x.phase(name, body)` groups calls, prefixes their
   keys, and gives the UI its outline. `x.review(name)` is a reflection point: the host wakes the
   leader with that phase's results, and the leader either continues or rewrites. `x.ask` is an
   owner check-in. Reading only the `phase`, `review` and `ask` lines gives the plan.

The GTM case under these rules (sketch, not typechecked):

```ts
const lead   = role({ by: buddy('market-research'), tree: 'none', max: usd(8) });
const scout  = role({ by: seat(sonnet), tree: 'none', max: usd(1.5) });
const critic = role({ by: seat(codex),  tree: 'none', max: usd(4) });   // other provider than lead
const anchored = check('python tools/gtm/anchors.py');                  // quote exists in the fetched page

export default expedition(contract, async (x) => {
  const orgs = await x.phase('scope', () => lead.list('orgs', brief('scope')));

  const found = await x.phase('collect', () =>
    wide(orgs, (o) => scout(o.id, brief('collect', o), { judge: anchored })));

  await x.review('after-collect');            // enough coverage? leader may rewrite from here

  let thesis = await x.phase('synthesize', () => lead('thesis', brief('synthesize'), { reads: found }));

  await x.phase('duel', async () => {
    for (const r of [1, 2, 3]) {
      const attack = await critic(`r${r}/attack`, brief('attack'), { reads: [thesis] });
      if (attack.t !== 'passed') continue;
      thesis = await lead(`r${r}/revise`, brief('revise'), { reads: [thesis, attack], continue: thesis });
    }
  });

  await x.review('after-duel');               // did the thesis hold? stop here is a valid result
  await x.ask('buyer-test', 'Run these five interviews?');
  return thesis;
});
```

The outline the UI draws from it: `scope → collect (wide) → ⟳ review → synthesize → duel ×3 →
⟳ review → ✋ ask`. A rewrite shows as a new outline beside the old one, with the diff between.

## 7. Goals, invariants, acts

### Goals

| ID | Goal | By |
|---|---|---|
| G1 | Any shape: fan-out, deep serial, duel, population search, gate | plain TypeScript over `agent`/`check`/`ask`/`land` (`Promise.all`, loops, sort and slice). No step kinds in the host |
| G2 | The plan can be replaced at any time without losing work | reconcile by key (§5) |
| G3 | Survives backend restart without re-running or re-spending | re-evaluation with memo hits; running turns re-attached through the execution journal (`docs/turn-lifecycle.md#execution-adoption`) by the `runId` in `started` |
| G4 | Never overspend or oversubscribe | reservation of `needs` and `max` inside `agent`/`check` before `started`; machine-scope pools shared across expeditions |
| G5 | A step's result never ends the expedition; the expedition ends only on `done`, budget, deadline or stop | only the host evaluates `Contract.done`, on the script's returned candidate |
| G6 | Judges are independent and fixed before the work | `judge` in the declaration and hash; host refuses a review seat on the producer's provider; `check` restores `protect` paths from the base |
| G7 | The deadline bounds work, not judgment | after the deadline `agent` and non-`done` `check` return `refused`; `ask`, `done` evaluation and `land` complete |
| G8 | Waiting on the owner holds nothing | `ask` reserves no pool and no budget |
| G9 | The goal cannot drift silently | Contract is owner-written only; every change is a `contract` entry |
| G10 | Reflection is bounded and tied to evidence | leader wakes are budgeted calls; the progress rule |
| G11 | Blind contexts and shared knowledge both work | a call reads only its `inputs`; sharing is the script passing `x.rows(kind)` as inputs |
| G12 | Multi-harness, and persistent named Buddies | `by: seat` through `vendor/agent-cli-tool`; `by: buddy` runs as a worker run on that Buddy with its role and memory |
| G13 | Code lands safely | `land`: serial per repo, merge, re-run checks on the merged commit, fast-forward only |
| G14 | The owner can see and review any change before it costs money | dry-run `Diff` at launch and on every rewrite; `autoApply` threshold |
| G15 | Lean | four verbs, one log, one mechanism. Rounds, duels, sampling, width rules are library code, not host code |

### Invariants

| ID | Invariant | Guard |
|---|---|---|
| I1 | A `(key, hash)` starts at most once | ❌ Quint invariant; host test with a restart between `declared` and `started` |
| I2 | `spent + reserved <= budget` at every instant, including parallel starts and leader wakes | ❌ Quint invariant; reservation is the only path to `started` |
| I3 | A settled outcome is never changed or removed | ❌ append-only log write path refuses rewrites; Quint invariant |
| I4 | After reconcile quiesces, every running call is one the current script asked for | ❌ Quint invariant (rewrite racing a settle, rewrite racing a start) |
| I5 | The Contract changes only by an owner act | ❌ write-path check; host test that a leader rewrite touching it is rejected |
| I6 | Only the host writes `finished`, and `met` only after every criterion passed on one sha | ❌ Quint invariant |
| I7 | A cancelled call's partial work is addressable before its tree is released | ❌ host test (salvage ref exists, then release) |
| I8 | No key is declared twice in one evaluation | ❌ dry-run error; host test |
| I9 | An `errored` or `cancelled` call is never judged | ❌ host test (lesson L6: checks on the base can pass) |
| I10 | A pending `ask` survives the deadline and a rewrite | ❌ Quint invariant; regression test from `bce2400` |

### Acts

| Act | Who | Requires | Otherwise |
|---|---|---|---|
| launch | owner | dry run succeeds; every `check` argv can run on the base (lesson L3) | refused with the reason |
| rewrite script | leader, owner | Contract untouched; cost under `autoApply`; progress rule | becomes an owner `ask` |
| change Contract | owner | — | — |
| steer, cancel a call | leader, owner | call is running | no-op, reported |
| answer an ask | owner | — | — |
| flag | worker | inside its own call | — |
| finish | host | `done` evaluated, or budget, deadline, stop | — |
| pause, resume, stop, extend | owner | as today | — |

## 8. The nine cases

| Case | In this model |
|---|---|
| 1 GTM research | `Promise.all` of 40 `collect/<org>` calls with `tree: none`; one synthesis call with their refs as inputs; a loop of advocate and critic on different providers; `ask` for the buyer test. Passing collection ends nothing |
| 2 Game design | one call per rule change; judge is the repo's own comparison script as a `check` needing the `compile-lock` and `cpu` pools; `ask` for the human playtest |
| 3 Sim auto-research | population loop in the script; `needs: ['modal']` or `['local-gpu']`; ideas returned as typed `out` rows, passed back in as inputs so nothing is re-tested |
| 4 Frontier math | generators get no ledger in `inputs` (blind); a census call on another provider; one `uses: 1` pool per falsifier |
| 5 New capabilities | nested loops over rows × engines; `done` is one check per row |
| 6 Deslop | waves of fenced calls, then `land` after each wave re-checks the merged commit |
| 7 CRUD | a fixed script; the leader is never woken |
| 8 Geometry | serial loop with `context: continue`; the replay is a `uses: 1` pool; independent review as a `review` judge |
| 9 Document model | design, critique and reflect calls on distinct seats; rulings are `ask`s; `done` is `owner` |

Open questions from the use-case brief, answered: the statistical judge is a script in the target
repo run as a `check` (the host knows no statistics); remote compute is a pool, launched by the
repo's own scripts; population search is a loop plus a sort, not a step kind; blind isolation is
the default and sharing is explicit.

## 9. Relation to `final/`

Shared with it: a TypeScript script over a small API, guarantees inside the primitives, pools,
host-run checks, serial landing, the deadline rule. Those were what the evidence supported.

Different:

| | `final/` | This design |
|---|---|---|
| Identity of work | position in a deterministic replay | explicit key + content hash |
| Editing the script mid-run | undefined | the normal way the plan changes |
| Plan revision | `Decision` values the script must have anticipated; `restructure` | data in the script, or a new script, reconciled |
| Goal revision | objective versions with clarify/tighten/weaken/redirect | Contract is the owner's; leader asks |
| Host surface | `round`, `reflect`, `sample`, `objective.revise`, `integrate`, notebook, watcher | four verbs and `rows` |
| Preview | examples typecheck | dry-run diff with cost, at launch and every rewrite |
| Who runs a call | seat | named Buddy with memory, or seat |

## 10. Known weaknesses

- **The host executes code the leader wrote.** The leader already has a shell in its own turns,
  so the threat is bugs, not malice. The script runs in a child process with only `x`, a step
  timeout and no filesystem or network. A script error costs nothing: it wakes the leader.
- **A careless key rename reruns finished work.** The diff shows the cost before it is spent, and
  `autoApply` stops a large one. It is still a real way to waste money under the threshold.
- **A wording fix to a prompt changes the hash** and reruns that call. Correct, but sometimes
  wasteful. See q1.
- **The launch preview shows only the first wave.** Later calls depend on results that do not
  exist yet. Hard limits come from the Contract, not from the preview.
- **Steering differs by harness.** `steer` must report whether the message was delivered mid-turn
  or queued for the next turn.
- **The authoring layer in §6a is a sketch.** It has not been typechecked or tried on the other
  eight cases; a case with heavy typed data flow (3, 5) may need more schemas than the GTM one.
- **Nothing here is checked.** I1–I4, I6 and I10 are a small concurrent core (log, reservations,
  reconcile against settle and start). They need a Quint model before code.

## 11. Open questions

- **q1:** should a finished call be reused when only its prompt text changed? Options: strict
  hash (this draft); or an explicit `rev` number the author bumps, with drift shown in the diff.
- **q2:** does a leader rewrite run while calls are in flight, or only when the script is
  waiting? This draft allows any time; the Quint model should say whether that is safe.
- **q3:** where do per-call dollars come from for each harness, and what is reserved when a
  harness reports no usage?
- **q4:** can `by: buddy` run several calls on one Buddy at once, or is a named Buddy a
  `slots: 1` pool?
- **q5:** should worker `flag`s wake the leader immediately or batch with other events?

## 12. Build slices

1. **Runner and log:** script evaluation with reconcile, `agent` (seat, `tree: none`), `check`,
   `ask`, budget and pool reservation, dry run. Pilot: GTM (case 1). Replaces
   `server/src/expeditions/host.ts`.
2. **Rewrite:** leader wakes, diff and `autoApply`, progress rule, `steer`/`cancel`, `by: buddy`,
   the tree view by key. Pilot: document model (case 9).
3. **Code and compute:** `tree: checkout`, `land`, machine-scope and spend pools,
   `context: continue`. Pilot: wave_sim auto-research (case 3).

Before slice 1: the Quint model of §7's concurrent core.
