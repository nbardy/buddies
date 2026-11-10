# Design A: One rule

Status: design only, sketch code. Shared goal and base: [README](README.md).

## Motivation set

1. **Fewest concepts.** If two features can be one thing, they are one thing.
2. **Derived, not added.** A feature is either a consequence of the one rule or it is user code.
3. **Small enough to replace.** The host should be short enough to read in a sitting and to
   model-check whole. Today's host is 2,349 lines; the ledger engine was 13.5k and failed.

The test for any proposed host feature: *can a script do it with what exists?* If yes, it is a
library function.

## 1. The whole model

There is **one kind of thing that runs: a Call.** There is **one verb: `run`.** There is **one
rule: reconcile.**

- A judge is a Call. An owner check-in is a Call. The leader's reflection is a Call. The done
  criteria are Calls. Landing code is a Call that needs the `main` pool.
- So there is no judge concept, no gate concept, no leader concept and no landing concept in the
  host. There are Calls, pools and a log.

```ts
// ---- Contract (owner) ----
type Contract = {
  goal: Markdown;
  done: Call[];                 // the host runs these on the candidate; all must pass
  budget: { usd: number; hours: number };
  pools: Record<PoolName, Pool>;
  rules: string[];
  leader: Who;
  autoApply: { usd: number };
};
type Pool =
  | { t: 'slots'; n: number; scope: 'expedition' | 'machine' }   // GPU, compile lock, `main`
  | { t: 'uses'; n: number }
  | { t: 'spend'; usd: number; slots: number };

// ---- The only thing that runs ----
type Call =
  | { t: 'agent'; key: Key; by: Who; prompt: Markdown; inputs: Ref[]; out: JsonSchema;
      tree: { t: 'none' } | { t: 'checkout'; base: Sha };
      context: { t: 'cold' } | { t: 'continue'; of: Key };
      needs: PoolName[]; max: { usd: number; minutes: number } }
  | { t: 'check'; key: Key; argv: string[]; on: Sha; protect: RepoPath[];
      needs: PoolName[]; maxMinutes: number }
  | { t: 'ask'; key: Key; question: string; answer: JsonSchema };
type Who = { t: 'buddy'; id: BuddyId } | { t: 'seat'; provider: string; model: string; effort: string };

type Outcome =
  | { t: 'done'; out: unknown; ref: Ref; code: { t: 'none' } | { t: 'commit'; sha: Sha } }
  | { t: 'failed'; why: string }          // check exited non-zero, or the turn errored
  | { t: 'cancelled'; partial: Ref }
  | { t: 'refused'; reason: 'budget' | 'deadline' | 'pool' | 'needs-owner' };

// ---- Script (leader) ----
type Script = (x: { run(c: Call): Promise<Outcome>; log(): Entry[] }) => Promise<Candidate>;
type Candidate = { ref: Ref; code: { t: 'none' } | { t: 'commit'; sha: Sha }; gaps: string[] };

// ---- Log (host) ----
type Entry = { at: Time } & (
  | { t: 'script'; version: number; by: Who | 'owner'; reason: string;
      dropped: Record<Key, 'cancel' | 'finish'> }
  | { t: 'declared'; call: Call; hash: Hash; scriptVersion: number }
  | { t: 'started'; key: Key; hash: Hash; runId: string; reserved: Reservation }
  | { t: 'settled'; key: Key; hash: Hash; outcome: Outcome; spent: Usage }
  | { t: 'contract'; version: number; change: string }
  | { t: 'finished'; reason: 'met' | 'not-met' | 'budget' | 'deadline' | 'stopped' });
```

That is the entire host surface.

## 2. How everything else is derived

| Feature | In this design |
|---|---|
| Fan-out, pipeline, loop | `Promise.all`, `for`, plain TypeScript |
| Judge | a `check`, or an `agent` on another seat, called after the work; the script reads the result |
| Owner check-in | `ask` |
| Reflection | an `agent` Call to the leader with a decision schema; the script branches |
| Plan rewrite | the host issues the Call `leader/<n>`; its `out` is a new script plus `dropped` |
| Done | the host runs `Contract.done` under keys `done/*` on the candidate's commit |
| Landing | a `check` that runs the repo's own merge script and needs the machine pool `main` (1 slot) |
| Shared knowledge | `x.log()` filtered by the script, passed as `inputs` |
| Blind context | leave it out of `inputs` |
| "Exactly one replay" | a `uses: 1` pool |
| Waterfall | the log, as is |

## 3. The GTM case

```ts
export default async function run(x: X): Promise<Candidate> {
  const lead = buddy('market-research'), scout = seat('claude', 'sonnet'), critic = seat('codex', 'sol');
  const none = { t: 'none' } as const, cold = { t: 'cold' } as const;

  const scope = await x.run({ t: 'agent', key: 'scope', by: lead, prompt: file('briefs/scope.md'),
    inputs: [repo('business/plans')], out: OrgList, tree: none, context: cold, needs: ['claude'], max: usd(2) });
  if (scope.t !== 'done') return gap('scope did not finish');

  const found = await Promise.all(orgs(scope).map(async (o) => {
    const got = await x.run({ t: 'agent', key: `collect/${o.id}`, by: scout,
      prompt: fill('briefs/collect.md', o), inputs: [], out: Sources, tree: none, context: cold,
      needs: ['claude'], max: usd(1.5) });
    if (got.t !== 'done') return got;
    const ok = await x.run({ t: 'check', key: `collect/${o.id}/anchors`,
      argv: ['python', 'tools/gtm/anchors.py', got.ref], on: BASE, protect: ['tools/gtm'], needs: ['cpu'], maxMinutes: 2 });
    return ok.t === 'done' ? got : ok;
  }));

  let thesis = await x.run({ t: 'agent', key: 'thesis', by: lead, prompt: file('briefs/synthesize.md'),
    inputs: refs(found), out: Thesis, tree: none, context: cold, needs: ['claude'], max: usd(8) });

  for (const r of [1, 2, 3]) {
    const attack = await x.run({ t: 'agent', key: `duel/${r}/attack`, by: critic,
      prompt: file('briefs/attack.md'), inputs: refs([thesis]), out: Attack, tree: none, context: cold,
      needs: ['codex'], max: usd(4) });
    if (attack.t !== 'done') continue;
    thesis = await x.run({ t: 'agent', key: `duel/${r}/revise`, by: lead, prompt: file('briefs/revise.md'),
      inputs: refs([thesis, attack]), out: Thesis, tree: none, context: { t: 'continue', of: 'thesis' },
      needs: ['claude'], max: usd(5) });
  }

  await x.run({ t: 'ask', key: 'buyer-test', question: 'Run these five interviews?', answer: YesNo });
  return candidate(thesis);
}
```

It is all there and nothing is hidden, and that is also its fault: every call repeats eight
fields, and the plan's shape has to be read out of the control flow.

## 4. Goals

| ID | Goal | By |
|---|---|---|
| G1 | Any shape | plain TypeScript over `run` |
| G2 | Replace the plan, keep the work, choose what dies | reconcile; `script.dropped` must name every dropped running key |
| G3 | Restart safe | re-evaluation; `started.runId` re-attaches through the execution journal |
| G4 | Never oversubscribe | reservation of `needs` and `max` is the only path to `started` |
| G5 | Honest done | only the host runs `Contract.done`, on one commit |
| G6 | Deadline bounds work, not judgment | after the deadline `agent` and script `check` return `refused`; `ask` and `done/*` complete |
| G7 | One id, one timeline | the log |
| G8 | Small | one verb, three call kinds, one pool type, one log |

## 5. Invariants

| ID | Invariant | Guard |
|---|---|---|
| I1 | A `(key, hash)` starts at most once | ❌ Quint invariant |
| I2 | `spent + reserved <= budget` always | ❌ Quint invariant |
| I3 | A settled outcome never changes | ❌ append-only write path; Quint invariant |
| I4 | After reconcile, every running call is asked for or marked `finish` | ❌ Quint invariant |
| I5 | Only the owner changes the Contract | ❌ write-path check |
| I6 | `finished: met` only after every `done/*` passed on one sha | ❌ Quint invariant |
| I7 | A pending `ask` survives the deadline and a rewrite | ❌ Quint invariant |

Seven invariants over one log and one rule: this is the design most likely to be fully
model-checked.

## 6. What it gives up

- **Readable scripts.** The GTM plan is about 45 dense lines. A library can shorten it, but then
  the library is a second design nobody specified.
- **Enforced judge independence.** The host does not know which call judges which. A helper can
  refuse a same-provider judge, and the dry run can warn, but a script can skip the helper.
- **Visible reflection points.** A leader call looks like any other call. The UI can only show
  the key tree, not an outline.
- **Verified vs claimed.** The host knows only what `Contract.done` says. Intermediate results
  carry no claim level.

## 7. Open questions

- q1: is `leader/<n>` issued by the host on events, or only when the script asks? (This draft:
  host, on script return without `done`, script error, all-refused, and 50%/80% of budget.)
- q2: strict hash, or reuse a finished call when only its prompt text changed?
- q3: what is reserved for a harness that reports no usage?
