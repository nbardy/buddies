# Design B: Reads like the plan

Status: design only, sketch code. Shared goal and base: [README](README.md).

## Motivation set

1. **A person can read the plan in a minute.** The owner approves it and the leader rewrites it,
   so both must be able to take it in quickly. Reading only the structural lines gives the plan.
2. **The prompt is the work.** Most of what decides whether an agent does well is its brief.
   Briefs get room and are edited as prose, not squeezed into string arguments.
3. **Every meta point has a name.** Where the plan reflects, where it waits for the owner, and
   where it was rewritten are visible in the script and in the history.

The earlier example scripts failed all three: 160 lines for the GTM case, twenty of them schemas,
one-line prompts, and no line that says "the plan reflects here".

## 1. An expedition is a folder

```
expeditions/gtm-evidence/
  contract.md        the owner's: goal in prose, then done / budget / pools / rules as frontmatter
  plan.ts            the leader's: a cast table and the phases
  briefs/
    scope.md         one file per step; as long as the work needs
    collect.md       {{org.name}} slots are filled from the step's argument
    synthesize.md
    attack.md
    revise.md
```

The folder name is the expedition id. Script versions are commits of this folder, so a rewrite is
a diff you can read with ordinary tools.

## 2. The plan

```ts
const lead   = role({ by: buddy('market-research'), max: usd(8) });
const scout  = role({ by: seat(sonnet), max: usd(1.5) });
const critic = role({ by: seat(codex),  max: usd(4) });
const anchored = check('python tools/gtm/anchors.py');     // the quote exists in the fetched page

const { scope, collect, thesis, attack, revise } = steps({
  scope:   lead.lists(Org),          // the one schema: the script fans out over it
  collect: scout.judged(anchored),
  thesis:  lead,
  attack:  critic,
  revise:  lead.continues(thesis),   // same conversation as the thesis
});

export default plan(async (x) => {
  const orgs  = await x.phase('scope',      () => scope());
  const found = await x.phase('collect',    () => wide(orgs, collect));
  await x.review('enough coverage?');
  let t       = await x.phase('synthesize', () => thesis({ reads: found }));
  await x.phase('duel', async () => {
    for (const round of [1, 2, 3]) {
      const hit = await attack({ reads: [t], id: round });
      if (hit.t === 'passed') t = await revise({ reads: [t, hit], id: round });
    }
  });
  await x.review('did the thesis hold?');
  await x.ask('Run these five buyer interviews?');
  return t;
});
```

Read the `phase`, `review` and `ask` lines and you have the plan:

```
scope → collect (wide) → ⟳ enough coverage? → synthesize → duel ×3 → ⟳ did the thesis hold? → ✋ owner
```

## 3. The parts

| Part | What it is | Rule |
|---|---|---|
| **Cast table** `steps({...})` | step name → who does it and how it is judged | property names are the step names; each must have `briefs/<name>.md`, checked at dry run |
| **Role** | who, with what limits | declared once; `.judged(j)`, `.lists(schema)`, `.continues(step)`, `.in(tree)` refine it |
| **Brief** | the step's prompt, a markdown file | part of the call's hash; the owner's `rules` are appended by the host |
| **Report** | the default output of every step | `{ summary, claims: { text, level, refs }[], files }`; a schema is written only where the plan reads a field |
| **Phase** | a named group of calls | prefixes keys (`collect/acme`); a band in the timeline |
| **Review** | a named reflection point | the host wakes the leader with the phases since the last review |
| **Ask** | a named owner check-in | holds nothing; answerable after the deadline |

Keys are never typed by hand: `phase / step / item.id`.

## 4. Types

```ts
type StepDef<In, Out> = { role: Role; brief: BriefPath; judge: Judge; output: Schema<Out> };
type Role = { by: Who; max: Max; tree: Tree; context: Context; needs: PoolName[] };
type Judge = { t: 'none' } | { t: 'check'; argv: string[] } | { t: 'review'; rubric: BriefPath; by: Who };

type Report = { summary: string; claims: Claim[]; files: Ref[] };
type Claim = { text: string; level: 'verified' | 'claimed' | 'speculation'; refs: Ref[] };

type Result<Out> =
  | { t: 'passed'; out: Out; ref: Ref }       // ran and its judge passed (or it has no judge)
  | { t: 'failed'; out: Out; ref: Ref; why: string }
  | { t: 'errored'; why: string }
  | { t: 'cancelled'; partial: Ref }
  | { t: 'refused'; reason: 'budget' | 'deadline' | 'pool' | 'needs-owner' };

// What a review returns. The leader writes `why` in plain words; it is shown in the timeline.
type Reviewed =
  | { t: 'continue'; why: string }
  | { t: 'rewrite'; why: string; plan: FolderDiff; dropped: Record<Key, 'cancel' | 'finish'> }
  | { t: 'stop'; why: string };                // "nothing worth shipping" is a valid result

// Added to the shared log
type Entry =
  | { t: 'phase-open'; name: string } | { t: 'phase-close'; name: string; passed: number; failed: number }
  | { t: 'review'; name: string; decision: Reviewed }
  | { t: 'asked'; name: string } | { t: 'answered'; name: string; answer: unknown }
  /* plus declared / started / settled / script / contract / finished from the shared base */;
```

## 5. What the owner sees

- **At launch:** the outline, the cast table, the first wave's calls and cost, and links to each
  brief. Approving a plan means reading about twenty lines and the briefs that matter.
- **During the run:** one timeline. Phases are bands, calls are bars inside them, reviews are
  diamonds with the leader's `why`, asks are bars that wait.
- **At a rewrite:** the old and new outlines side by side, the folder diff (which briefs changed,
  in prose), and the list of running calls with the leader's choice for each: cancel or finish.
  Over the `autoApply` cost, it waits for the owner.

```
before:  scope → collect → ⟳ → synthesize → duel ×3 → ⟳ → ✋
after:   scope → collect → ⟳ → interview-mining (wide) → synthesize → duel ×3 → ⟳ → ✋
reason:  "Reviews are too thin for RL buyers; practitioner threads have the complaints."
running: collect/appen  82% done, $1.10  → finish      collect/labelbox  5% done → cancel
```

## 6. Goals

| ID | Goal | By |
|---|---|---|
| G1 | The plan reads in a minute | cast table + `phase`/`review`/`ask` lines; the outline is extracted from them at dry run |
| G2 | Briefs get room | one markdown file per step, required at dry run |
| G3 | Meta points are visible | `review` and `ask` are named lines and named log entries |
| G4 | Judges are independent | the host reads the cast table: a `review` judge on the producer's provider fails the dry run |
| G5 | Replace the plan, keep the work, choose what dies | reconcile; `Reviewed.rewrite.dropped` |
| G6 | A rewrite is reviewable by a person | outline diff + folder diff + `why` |
| G7 | Any shape | `wide`, loops and plain TypeScript inside phases |
| G8 | Honest done, bounded spend, restart safe, deadline rule | the shared base, unchanged |

## 7. Invariants

The shared base's seven (see [A](A-one-rule.md#5-invariants)), plus:

| ID | Invariant | Guard |
|---|---|---|
| I8 | Every step in the cast table has a brief file | ❌ dry-run error; host test |
| I9 | A `review` judge never shares a provider with its producer | ❌ dry-run error; host test |
| I10 | Every call belongs to exactly one phase | ❌ a call outside `x.phase` is a dry-run error |
| I11 | A rewrite names a disposition for every dropped running call | ❌ rejected otherwise; host test |

## 8. What it gives up

- **A bigger host.** Phases, the outline, the standard report, the brief loader and the cast
  table are host or first-party library code that A does not have.
- **Conventions.** Briefs must be files with the step's name; every call must sit in a phase.
  Work that fits the conventions is short; work that does not has to bend.
- **Heavy typed data.** Cases 3 and 5 pass numeric reports between steps. Each such step needs a
  schema, and the plan gets longer. The standard report does not help there.
- **The outline is a summary.** A loop that runs "until the metric stops improving" shows as one
  phase; its real length is only visible in the timeline.

## 9. Open questions

- q1: is a `review` a call the script makes (this draft), or can the host also insert one on
  budget marks and repeated failures?
- q2: should the standard report's claim levels be set by the agent, or only by a judge?
- q3: do briefs need includes (a shared preamble), or does that recreate the context-resend cost?
