# Design C: Cannot be wrong

Status: design only, sketch code; the type-level claims below have not been compiled. Shared goal
and base: [README](README.md).

## Motivation set

1. **A mistake should not be writable.** A guarantee that depends on a check running later is
   weaker than one where the wrong program does not compile or the wrong state has no value.
2. **Kinds are types.** If behaviour differs by kind, the kind is a variant. No optional fields
   that mean "we did not decide", no silent defaults (the repo's own code style, applied to the
   design).
3. **One write path per fact, and a model of it.** Each guarantee lives in exactly one place, and
   the concurrent core is a state machine small enough to model-check.

The failures this targets are the ones the record shows were silent: a judge that shared a seat
with its producer, a failed turn judged on the base commit and passed, a waiting verdict recorded
as skipped, a manager merging work nobody had verified.

## 1. Results carry their proof

```ts
declare const verified: unique symbol;
declare const claimed: unique symbol;

// Only the host can make a Verified: it is what a passed judge returns.
type Verified<T> = { readonly out: T; readonly ref: Ref; readonly [verified]: JudgeRecord };
type Claimed<T>  = { readonly out: T; readonly ref: Ref; readonly [claimed]: true };

type Result<T, J extends Judging> =
  | { t: 'passed'; value: J extends 'judged' ? Verified<T> : Claimed<T> }
  | { t: 'failed'; claim: Claimed<T>; why: string }     // ran, judge said no
  | { t: 'errored'; why: string }                       // no output exists; nothing to judge
  | { t: 'cancelled'; partial: Ref }
  | { t: 'refused'; reason: 'budget' | 'deadline' | 'pool' | 'needs-owner' };
type Judging = 'judged' | 'unjudged';
```

- There is no `.out` on a `Result`. The script must handle the cases to reach a value.
- `land` and the returned candidate accept only `Verified`. Unjudged work can inform later steps,
  but it cannot be merged or finish the expedition.

```ts
interface X {
  land(code: Verified<Commit>): Promise<Result<Commit, 'judged'>>;
  ask<T>(q: Question<T>): Promise<T>;                 // total: it only ever resolves with an answer
}
type Script = (x: X) => Promise<Verified<unknown> | Gap>;   // "no result, here is why" is a value
type Gap = { t: 'gap'; why: string; evidence: Ref[] };
```

## 2. Independence is in the types

```ts
type Provider = 'claude' | 'codex' | 'gemini';
type Seat<P extends Provider> = { provider: P; model: string; effort: string };
type Role<P extends Provider> = { by: Seat<P> | Buddy<P>; grant: Grant; max: Max };

// A reviewing judge for work produced on P must sit on some other provider.
type ReviewBy<P extends Provider> = { rubric: BriefPath; by: Seat<Exclude<Provider, P>> };

declare function judged<P extends Provider, T>(
  role: Role<P>,
  judge: { t: 'check'; argv: string[]; protect: RepoPath[] } | ({ t: 'review' } & ReviewBy<P>),
): Step<T, 'judged'>;
```

`judged(claudeLead, { t: 'review', by: claudeOpus, … })` is a type error. So is a duel whose critic
shares the advocate's provider, if the duel helper is typed the same way.

## 3. A call can only do what its grant says

```ts
type Grant = {
  reads: ReadGrant;                       // 'inputs-only' is the default kind, not an absence
  writes: { t: 'nothing' } | { t: 'fenced'; paths: RepoPath[] };
  tree: { t: 'none' } | { t: 'checkout'; base: Sha };
  network: { t: 'none' } | { t: 'web' };
  pools: PoolName[];
};
type ReadGrant = { t: 'inputs-only' } | { t: 'repo'; paths: RepoPath[] } | { t: 'ledger'; kinds: string[] };
```

- Blind contexts are `reads: inputs-only`. Giving a generator the idea ledger is a visible grant.
- A write outside the fence fails the call's judge step on the host (diff against the fence).
- `network` is enforced only where the harness can enforce it; the dry run reports per call
  whether each grant is **enforced** or **advisory**, and never claims the first for the second.

## 4. The plan, same case

It keeps B's cast table and phases. The types flow from the table, so the author writes few
annotations, but the compiler now rejects the wrong plans.

```ts
const lead   = role(buddy('market-research', 'claude'), reads.repo('business'), usd(8));
const scout  = role(seat('claude', sonnet), web, usd(1.5));
const critic = role(seat('codex', sol), reads.inputsOnly, usd(4));

const { scope, collect, thesis, attack, revise } = steps({
  scope:   unjudged(lead).lists(Org),
  collect: judged(scout, check('python tools/gtm/anchors.py')),
  thesis:  judged(lead, review('briefs/rubric-traceable.md', seat('gemini', pro))),
  attack:  judged(critic, review('briefs/rubric-real-counterexample.md', seat('gemini', pro))),
  revise:  judged(lead, review('briefs/rubric-traceable.md', seat('gemini', pro))).continues(thesis),
});

export default plan(async (x) => {
  const orgs = await x.phase('scope', () => scope());
  if (orgs.t !== 'passed') return gap('no scope', orgs);

  const found = await x.phase('collect', () => wide(orgs.value, collect));
  const facts = verifiedOnly(found);                 // Verified<Sources>[]; the rest are counted gaps

  let t = await x.phase('synthesize', () => thesis({ reads: facts }));
  //                                                      ^ passing `found` here is a type error:
  //                                                        a thesis may cite only verified sources
  for (const round of [1, 2, 3]) {
    if (t.t !== 'passed') break;
    const hit = await attack({ reads: [t.value], id: round });
    if (hit.t === 'passed') t = await revise({ reads: [t.value, hit.value], id: round });
  }
  await x.ask(question('Run these five buyer interviews?', YesNo));
  return t.t === 'passed' ? t.value : gap('thesis did not survive', t);
});
```

What the compiler refuses here: returning an unjudged thesis; synthesising from unverified
sources; a critic or judge on the lead's provider; reading a result without handling `failed`,
`errored`, `cancelled` and `refused`.

## 5. A rewrite is checked before it can run

```ts
type Submission =
  | { t: 'rejected'; at: 'typecheck'; errors: CompilerError[] }      // goes back to the leader, free
  | { t: 'rejected'; at: 'dry-run'; reason: string }
  | { t: 'needs-owner'; diff: Diff }                                  // cost, or a Contract change
  | { t: 'applied'; version: number; diff: Diff };
type Rewrite = { plan: FolderDiff; reason: string; dropped: Record<Key, Disposition> };
type Disposition = { t: 'cancel' } | { t: 'finish' };                 // required for every dropped running key
```

The host runs `tsc` on the submitted folder, then the dry run, then applies. Compiler errors are
precise feedback for a model, and they cost no agent time. A rewrite that weakens a judge shows up
as a changed step type, and so as a changed hash for every call of that step.

## 6. The core is one state machine

```ts
type CallState =
  | { t: 'declared' }
  | { t: 'reserved'; reservation: Reservation }
  | { t: 'running'; runId: string; reservation: Reservation }
  | { t: 'draining'; runId: string; reservation: Reservation }   // dropped by a rewrite, told to finish
  | { t: 'settled'; outcome: Outcome };

// The only transitions. Anything else is not a value the host can write.
//   declared → reserved → running → settled
//   declared → settled(refused)
//   running → draining → settled
//   running | draining → settled(cancelled)
```

`docs/specs/expedition-keyed.qnt` models this machine, the budget ledger and reconcile, with the
invariants below. The implementation is then driven by the model's transitions in tests, so the
two cannot drift.

## 7. Goals

| ID | Goal | By |
|---|---|---|
| G1 | Unverified work cannot land or finish | `land` and `Script`'s return type take `Verified` only; only the host constructs one |
| G2 | Judges are independent | `ReviewBy<P>` excludes the producer's provider at compile time; the host re-checks at dry run |
| G3 | Every outcome is handled | `Result` is a sum with no shortcut accessor; exhaustive `switch` |
| G4 | A call does only what it was granted | `Grant`; fence diff on the host; enforced vs advisory reported per call |
| G5 | A bad rewrite never starts | `tsc`, then dry run, then apply |
| G6 | No silent choice on a rewrite | `Disposition` required for every dropped running key |
| G7 | Honest done, bounded spend, restart safe, deadline rule | the shared base; `ask` is total, so a wait can never become a skip |
| G8 | The core is checked, not argued | the Quint model and the model-driven tests |

## 8. Invariants

The shared base's seven (see [A](A-one-rule.md#5-invariants)), plus:

| ID | Invariant | Guard |
|---|---|---|
| I8 | A `Verified` value exists only for a `settled` call whose judge passed | ❌ Quint invariant; the brand has one constructor in the host |
| I9 | An `errored` or `cancelled` call is never judged | ❌ transition table has no such edge; host test (lesson L6) |
| I10 | A `draining` call keeps its reservation until settled and starts nothing new | ❌ Quint invariant |
| I11 | No call writes outside its fence | ❌ host diff check before judging |
| I12 | A rewrite that fails `tsc` changes no state | ❌ host test |
| I13 | `landed` implies `Verified` on the merged commit, not the candidate | ❌ Quint invariant; `land` re-checks after merge |

## 9. What it gives up

- **Types are back in the script.** Fewer than the earlier examples, because they come from the
  cast table, but the author still has to satisfy the compiler, and `verifiedOnly`, `gap` and the
  exhaustive handling add lines. Simple work (case 7) pays this for little benefit.
- **A compiler in the loop.** Every rewrite waits on `tsc`. The leader must be able to fix type
  errors; a leader that cannot will loop on rejections, which the progress rule must bound.
- **Advanced TypeScript.** `Exclude` over providers and branded results give long error messages.
  If the errors are unreadable, the guarantee becomes an obstacle.
- **Grants promise more than harnesses deliver.** Network and read limits are advisory on some
  harnesses. The design reports that plainly, but the name "cannot be wrong" does not cover them.
- **A fixed provider list.** Compile-time independence needs providers as a closed union, which
  conflicts with the repo rule that provider values pass through verbatim as strings.

## 10. Open questions

- q1: is provider independence worth a closed `Provider` union, or should it stay a dry-run check?
- q2: can a `Verified<T>` be passed to a call on a blind grant without leaking who verified it?
- q3: does `draining` need a time limit of its own, or is the call's original `max` enough?
- q4: which grants can each harness in `vendor/agent-cli-tool` enforce today? (Not yet surveyed.)
