// Case 06: replace and delete redundant paths toward an 80,000-source-line tree.
// Wide inventories and slices; serial type seams, then one integrated commit per wave.
// Commands judge code; Gemini audits the assumed Claude lead’s retirement claims.
//
// V1 limits and NOTES carried forward:
// No host land or per-call fences: on threads the target and prior waves, a worker integrates
// parallel branches and real checks re-run there. The integration step replaces x.land,
// not another feature. Writable scopes are instructions; extend slice-gate.mjs to verify
// each actual diff is inside its listed fence and graders are unchanged. checks:2 limits
// this expedition, not the machine, and is held through the whole producer/check pair.
// One judge means the chained bash check still reports one combined verdict, as in NOTES.
// The ignored screenshot baseline is not a portable Ref: shots.mjs must persist/retrieve
// output/deslop/base across isolated command checkouts (and done); this is a launch prerequisite.
// SourceLines <=80000 is an explicit assertion over measure.mjs JSON. No moving source
// outside the count. Owner integration is manual; no main branch is mutated by the plan.
//
// Before launch (historical prerequisites; verify against the target checkout):
// - `tools/deslop/measure.mjs` does not exist. It must print JSON with `sourceLines` and `testLines`
//   for the tracked tree (source and tests counted separately, `vendor/` and generated files out).
// - `tools/deslop/target-lint.mjs` does not exist. It must check `TARGET.json`: fences are disjoint
//   within a wave, every slice names what it retires and what it keeps, budgets are present.
// - `tools/deslop/slice-gate.mjs` does not exist. Given `TARGET.json` and a slice id, it must fail
//   a commit that deletes a test the slice did not list or adds net source lines. (The fence is advisory in v1.)
// - `tools/deslop/shots.mjs` does not exist. It would wrap the real `pnpm screenshots` /
//   `pnpm screenshots --baseline` so the host can run it: start a throwaway server on a spare port
//   against a COPY of the stores (execution disabled), take the shots, compare, stop the server.
// - `agent_notes/2026-11-10_deslop/` and its `TARGET.json`, `TARGET.md`, `INVENTORY.md`,
//   `CLOSEOUT.md` are written by this expedition; none exists.
// - The `product-dev` Buddy id is assumed from the "Product Dev" Buddy the server bootstraps. Its
//   provider must not be gemini, or the dry run refuses the closeout's reviewer.
// - The 80,000-line bar and the dollar and hour budgets are illustrative, not measured.
// - The seat model names are copied from example 01, not checked against the catalog.
// - The real commands used as they exist today: `pnpm typecheck`, `pnpm test:server`,
//   `pnpm test:client`, `bash tools/check-client-invariants.sh`, `pnpm screenshots`.
//
// Gates typecheck and dry-run declarations; they never execute or establish existence of these tools.
// Fill in actual Buddy ids and check their providers; test providers below are explicit assumptions.

import {
  type Held,
  type Readable,
  type Result,
  buddy,
  check,
  command,
  expedition,
  need,
  parallel,
  passed,
  review,
  role,
  seat,
  steps,
} from 'expedition';
import { z } from 'zod';

// Preserve failed outputs as evidence too: passed(...) alone would erase a search's refutations.
function evidence(result: Result<unknown>): Readable[] {
  switch (result.t) {
    case 'passed':
      return [result];
    case 'failed':
      return [result, `failed: ${result.why}`];
    case 'errored':
      return [`errored: ${result.why}`];
    case 'cancelled':
      return [result.partial, 'cancelled'];
    case 'refused':
      return [`refused: ${result.reason}`];
  }
}
const noResult = (why: string) => need({ t: 'errored', why }, why);
const NOTES = 'agent_notes/2026-11-10_deslop';
const CODE = [
  'server/src/',
  'server/test/',
  'client/src/',
  'client/test/',
  'shared/src/',
  'crates/',
];
const AREAS = [
  'shared/src',
  'server/src/conversations',
  'server/src/turns',
  'server/src/http',
  'server/src/ingest',
  'server/src/buddies',
  'client/src/atoms',
  'client/src/components',
  'client/src/mobile',
  'crates/unleashd-buddies',
  'crates/unleashd-ingest',
].map((path) => ({ id: path.replaceAll('/', '-'), path }));
const Size = z.object({ sourceLines: z.number(), testLines: z.number() });
const Slice = z.object({
  id: z.string(),
  wave: z.number(),
  kind: z.enum(['seam', 'slice']),
  fence: z.array(z.string()),
  retires: z.string(),
  keeps: z.string(),
});
const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('product-dev'), usd: 10, minutes: 60 }).reads(
  ...CODE,
  'docs/',
  'agent_notes/'
);
const scout = role({ by: seat('claude', 'claude-sonnet-5-5', 'low'), usd: 1, minutes: 15 }).reads(
  ...CODE,
  'docs/patterns.md'
);
const coder = role({ by: seat('claude', 'claude-sonnet-5-5', 'high'), usd: 4, minutes: 45 });
const typer = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), usd: 10, minutes: 90 });
const gate = (item: z.infer<typeof Slice>) =>
  `bash -c 'pnpm typecheck && pnpm test:server && pnpm test:client && bash tools/check-client-invariants.sh && node tools/deslop/slice-gate.mjs ${NOTES}/TARGET.json ${item.id}'`;
const retired = `# Rubric: is each fact now owned once, and is the old path really gone?

You are reviewing a closeout written on another model, against the commit it describes. Do not
trust its table. You did not write any of this code.

## Check

1. **Single owners.** Take every inventory row the closeout marks \`single\`, or twenty of them
   chosen by you if there are more. For each, search the commit for the type, schema, table or
   function that defines the fact. Pass the row only if one definition is left and the others are
   deleted, not renamed, re-exported or commented out.
2. **Retired paths.** For each landed slice, or fifteen chosen by you, confirm that what it says
   it retired is absent from the commit and has no remaining caller.
3. **Tests.** For the same slices, confirm that every deleted test tested only the retired path,
   and that the behaviour listed as kept is exercised by a test that goes through the real path.
   A test that was weakened or skipped to get green fails the slice.
4. **Honest numbers.** The source and test deltas are reported separately and match the
   measurement in the inputs. Code moved to a place the count excludes is not a reduction.
5. **No preparatory work counted as done.** Any new interface, type or module the closeout counts
   as progress must name what it replaced, and that thing must be gone.

## Verdict

Pass only if every row and slice you checked holds, and section 3 of the closeout lists the
slices that did not land rather than hiding them. One \`single\` row with two live definitions is
a fail.

In your answer list each row and slice you checked, the search you ran and what you found. If you
fail it, name the exact definitions or callers that remain. Do not fail it for missing the
owner's line bar: that is a separate criterion, and a smaller honest cut can still pass here.
`;

const { measure, shots, inventory, target, unify, slice, integrate, closeout } = steps({
  measure: command('node tools/deslop/measure.mjs --json', { minutes: 5 }).returns(Size),
  shots: command('node tools/deslop/shots.mjs --out output/deslop/base', { minutes: 30 }).needs(
    'checks'
  ),
  inventory: scout.brief(
    (item: {
      id: string;
      path: string;
    }) => `# Inventory: who defines, writes and reads each fact in \`${item.path}\`

You are one of several readers, each given one area of the repo. Yours is \`${item.path}\`. You change
nothing. Someone else will write the lean target from your answer and the other areas' answers, so
what they need from you is a record they can trust, not a plan.

## Read

- Every source file under \`${item.path}\`. Open the files; do not infer from names.
- \`docs/patterns.md\`, for the patterns the code is supposed to follow (one store + one index, sum
  types, one write path, one type source).
- Outside your area, read only as far as needed to answer "who else defines or uses this".

## Record, for your area

1. **Facts with more than one definition.** A fact is something the system knows: a conversation's
   kind, a turn's state, a Buddy's grant, a row's shape on the wire. For each one defined in more
   than one place, list every definition (\`file:line\`), every writer and every reader, and say
   which definition the running code actually obeys.
2. **Parallel paths.** Two code paths that do the same job (an old route beside its replacement, a
   JS implementation beside the Rust one, a mapper beside the schema it mirrors). Name both and
   name the callers of each.
3. **Types that hide a decision.** Optional fields that mean "not decided", string tags compared
   in several places, \`if\` ladders on kind inside a function that should not care.
4. **Dead code.** Exports with no production caller. Give the search you ran. A caller in a test
   only counts as a test, so say so.
5. **Size.** Lines per file, largest first, and the three files you would look at first.

## What good looks like

- Every entry has a \`file:line\` a reader can open. Search a single file before you quote from it:
  recursive search output in this repo is rewritten and is not safe to cite.
- "I did not find a second definition" is a useful answer. Do not manufacture findings.
- Where you are unsure whether two things are the same fact, say so and say what would settle it.

## Do not

- Propose slices, budgets or a design. That is the next step's job.
- Run tests, builds or the app.

Stop after about 15 minutes. An honest partial inventory that names what you did not read is
better than a complete-looking one.
`
  ),
  target: lead
    .checkout()
    .brief(`# Target: the lean design, its budgets and its slices

You are writing the plan of record for this cut: what the code should look like when it is done,
and the fenced slices that get it there. You have the measured size of the tree and one inventory
per area. No code changes in this step.

## Read first

- The measurement and every inventory in your inputs.
- \`agent_notes/2026-09-25_lean-rewrite/CLOSEOUT.md\`, \`FINAL-REPORT.md\` and the three \`BUDGET-*.md\`
  files: what the last cut achieved, what it missed and why. Do not re-plan work that already
  landed, and do not repeat a budget that assumed a move which never happened.
- \`agent_notes/2026-09-27_deslop-all-slices.md\` and \`docs/patterns.md\`.

## Write, under \`agent_notes/2026-11-10_deslop/\`

- \`INVENTORY.md\`: the area inventories merged into one table of facts: each fact, its competing
  definitions, its writers and readers, and the ONE owner you choose for it.
- \`TARGET.md\`: the lean design in prose and types. For each area, a line budget and the reason it
  is achievable, tied to named deletions. Then a "Kept as-is" list: code that looks redundant but
  stays, with the reason.
- \`TARGET.json\`: the slices, the same list you return.

## Slices

Each slice has an \`id\`, a \`wave\`, a \`kind\`, a \`fence\` (the only paths it may change), \`retires\`
(the exact path, export or definition it deletes, and the tests that go with it) and \`keeps\` (the
behaviour a real consumer must still see, and which test or screen shows it).

- A \`slice\` stays inside one fence and replaces and deletes one redundant path. Within a wave no
  two fences overlap, down to the file. A lint checks this before any code is cut. The host
  enforces each fence on its worker, and a fence must lie inside \`server/src/\`, \`server/test/\`,
  \`client/src/\`, \`client/test/\`, \`shared/src/\` or \`crates/\`.
- A \`seam\` is a change that cannot be fenced to one area: moving a type to its one owner in
  \`shared/src\` and re-pointing every consumer. Seams are done by one worker, one at a time, before
  the wave's slices. Keep them few. A wave with three seams is a wave planned wrong.
- Order the waves so that each wave's slices can assume the earlier waves landed. Put the cuts
  with the clearest check and the largest deletion first.
- Size a slice so one worker finishes it in about 40 minutes including a full test run.

## What good looks like

- A reader can take any slice and say what will be gone afterwards.
- No slice is "introduce X". If X is new, the same slice or seam deletes what X replaces.
- The budgets add up to a number, and you say plainly whether it reaches the owner's bar. If it
  does not, say what would be needed and leave that decision to the owner.

Stop when the lint would pass. Do not start cutting.
`)
    .lists(Slice)
    .judged(check(`node tools/deslop/target-lint.mjs ${NOTES}/TARGET.json`)),
  unify: typer
    .checkout()
    .needs('checks')
    .brief(
      (item: z.infer<typeof Slice>) => `# Seam ${item.id}: one owner for one type

This is a cross-cutting change, which is why you have it alone and why nothing else is editing
the code while you work. The target and the full slice list are in your inputs; read this seam's
entry and the inventory rows it rests on before touching a file.

- **Retire:** ${item.retires}
- **Must still hold:** ${item.keeps}
- **You may change:** ${item.fence}

## The job

Make the fact have one definition, in the owner the target names, and make every consumer use it.
Then delete the definitions it replaces. In that order, in one commit.

1. Find every definition and every consumer yourself. The inventory is a lead, not a guarantee;
   a consumer it missed is the usual way a seam breaks.
2. Shape the canonical type so the compiler carries the distinction. Where behaviour differs by
   kind, make the kinds a sum type and dispatch once. Do not carry an optional field that means
   "we did not decide", and do not add a fallback that turns an unknown value into a plausible one.
3. Re-point consumers. A server-to-client schema field that is new on the wire needs a
   \`.default(...)\`, because clients and backends reload at different times.
4. Delete the old definitions and any mapper whose only job was to translate between them.
5. Tag the type at its definition if it implements a pattern from \`docs/patterns.md\`.

## The check

Your commit must pass \`pnpm typecheck\`, \`pnpm test:server\`, \`pnpm test:client\` and
\`bash tools/check-client-invariants.sh\`, then a gate that fails a
deleted test you did not list, or a net gain in source lines. Run the checks yourself on a clean
tree before you finish. The host does not
let you write outside the paths listed above.

## Do not

- Leave both definitions in place "for compatibility". If something still needs the old one, the
  seam is not done; report what needs it.
- Widen the job. A second fact you find duplicated is a new seam for the leader, reported in your
  summary, not something to fix here.
- Change behaviour. If unifying forces a behaviour choice, stop and report the choice.

In your summary list every file where a definition was deleted, every consumer you re-pointed,
and anything you learned about hidden consumers. Stop when the checks pass or when you can say
exactly what blocks them.
`
    )
    .judged(check(gate)),
  slice: coder
    .checkout()
    .needs('checks')
    .brief(
      (item: z.infer<typeof Slice>) => `# Slice ${item.id}: replace and delete one redundant path

You have one small cut to make, in your own checkout, at the same time as other workers who are
making other cuts in other files. Your fence is what keeps the merges clean.

- **Retire:** ${item.retires}
- **Must still hold:** ${item.keeps}
- **You may change only:** ${item.fence}

The lean target and the inventory are in your inputs. Read this slice's entry and the code inside
your fence before you change anything.

## The job

1. Find every caller of the path you are retiring. Search single files before you rely on a
   result; a caller outside your fence means the slice was cut wrong, so see "Stop" below.
2. Move the callers onto the surviving path. If the surviving path lacks something the old one
   did, add it there, once.
3. Delete the old path: the code, its exports, its types, and the tests that tested only it. A
   test that covers behaviour a consumer still relies on is not such a test. Re-point it at the
   surviving path instead.
4. Commit once. List in the message
   every file and every test you deleted.

## The check

Your commit is run through \`pnpm typecheck\`, \`pnpm test:server\`, \`pnpm test:client\` and
\`bash tools/check-client-invariants.sh\`, then a gate that fails on
any deleted test this slice did not list or a net gain in source lines. The host itself refuses
a write outside your fence. Run them yourself first,
on your commit with a clean tree. A green run over uncommitted files proves nothing.

## What good looks like

- The diff is mostly red. Fewer lines, one path where there were two.
- The behaviour under "Must still hold" is shown by a test that exercises the real path, and you
  name that test in your summary.
- Every guard comment and regression test for a past incident survives, unless the code it guards
  is the code you deleted.

## Stop

- If the cut needs a file outside your fence, stop. Do not edit it. Report the file and why; the
  leader will make it a seam or a later slice.
- If the old path turns out to have a behaviour the surviving path does not and should not have,
  stop and report it. That is an owner decision.
- Otherwise stop when the checks pass. Do not tidy neighbouring code, rename things or reformat.

Your summary: what is gone, the line delta for source and for tests separately, the test that
shows the kept behaviour, and anything surprising.
`
    )
    .judged(check(gate)),
  integrate: typer
    .checkout()
    .needs('checks')
    .brief(
      `Integrate this wave's supplied slice commits in order onto your starting checkout. Keep each retirement and every fix-guard. Resolve only integration conflicts; stop if a new behavior decision is needed. Do not push or merge main. Produce one commit containing the target and all prior waves. Run the complete repo checks on the integrated commit and report each unmerged slice with its reason.`
    )
    .judged(
      check(
        `bash -c 'pnpm typecheck && pnpm test:server && pnpm test:client && bash tools/check-client-invariants.sh'`
      )
    ),
  closeout: lead
    .checkout()
    .brief(`# Closeout: what was cut, what was kept, what is still double

The waves are over. You have the measurement before and after, the target with every slice, and
the inventories. Write the record the owner will read and the next cut will start from. You are
working on the last landed commit; describe that commit, not your memory of the plan.

## Write \`agent_notes/2026-11-10_deslop/CLOSEOUT.md\`

1. **Numbers first.** Source lines before and after, tests before and after, as two separate
   deltas. Per area: budget, actual, and for every area still over budget, the specific reason.
   If the owner's bar was not reached, say so in the first paragraph.
2. **Per landed slice:** what it retired (paths, exports, tests) and the test or screen that
   shows the kept behaviour. Take this from the commits, not from the slice list.
3. **Slices that did not land:** each one, with the stage it reached (not started, failed its
   checks, passed but failed on the merged commit) and what blocked it. Do not fold these into a
   count.
4. **One owner per fact.** Go back through \`INVENTORY.md\` row by row. For each fact, check on
   this commit whether one definition is left. Mark it \`single\`, \`still double\` (with both
   \`file:line\`s) or \`kept on purpose\` (with the reason).
5. **Kept as-is.** Everything deliberately left, and why.
6. **What the next cut should know:** hidden consumers found, fences that turned out wrong, checks
   that passed when they should not have.

## Update the repo's own docs

Where a slice changed which file owns something, fix the code tree map and the affected rows in
\`docs/\` in the same commit. Where a seam created or moved a pattern implementation, check the
entry in \`docs/patterns.md\`. Do not write a new guide.

## Rules for this document

- A reviewer on another model will check section 4 against the code. Any row you mark \`single\`
  that still has two definitions fails the whole closeout.
- Do not describe an added interface as a simplification unless you name what it retired.
- Do not round the numbers or report the total without the test delta beside it.
- No code changes in this step. If you find something broken, report it.

Stop when the document is complete and every \`file:line\` in it opens.
`)
    .judged(review(retired, judge)),
});

export default expedition({
  contract: {
    goal: `The September lean rewrite cut this repo from 133,955 lines to 99,841 and made it much faster, but
it missed its own 3–4× target, and the same facts are still defined in more than one place. I want
the next cut done properly: one canonical owner for each fact in the data model, every superseded
path deleted along with its tests, and the types unified so the compiler carries the distinctions
instead of \`if\` ladders and optional fields.

Measure before anything is changed. Then write the lean target with line budgets and a named owner
per fact, and cut toward it in waves of small, file-fenced slices that each pass the real checks on
their own commit. I do not want another large branch that verifies green against a dirty tree.

Everything I use must keep working: chats, Buddies, channels, expeditions, the mobile tree. Report
the net source delta with tests counted separately, the deletion list per slice, and anything you
chose to keep and why. If the 80,000-line bar turns out to be wrong, say so with the numbers; do
not hit it by moving code into places the count does not look.`,
    leader: 'product-dev',
    repo: '~/git/buddies',
    budget: { usd: 150, hours: 16 },
    autoApply: { usd: 15 },
    pools: { claude: 4, codex: 1, gemini: 1, checks: 2 },
    done: [
      {
        check: `bash -c 'pnpm typecheck && pnpm test:server && pnpm test:client && bash tools/check-client-invariants.sh'`,
      },
      { check: 'node tools/deslop/shots.mjs --baseline output/deslop/base' },
      {
        check: `python3 -c 'import json,subprocess; r=json.loads(subprocess.check_output(["node","tools/deslop/measure.mjs","--json"])); assert r["sourceLines"] <= 80000'`,
      },
      { review: { rubric: retired, by: judge } },
      {
        owner:
          'Does everything you use still behave the same, and is the code that is left the code you want to own?',
      },
    ],
    rules: [
      'Every slice replaces AND deletes. A new interface with nothing retired is preparatory work, not a simplification.',
      'Change only files inside your fence. If the right fix is outside it, stop and report the seam; do not reach across.',
      'Verify the commit, not the working tree. Other sessions leave dirty files in shared checkouts; never stash, never reset.',
      'Never open ~/.buddies or ~/.agent-viewer, never run the Buddies CLI without BUDDIES_HOME at a tmpdir, never format vendor/.',
      'Do not weaken, skip or delete a test to get green. A test goes only when the path it tests goes, and the deletion is listed.',
      'Keep every fix-guard comment and its regression test (docs/patterns.md#fix-guards) unless the guarded code itself is retired.',
      'V1 execution notes override historical host claims in the briefs: no land, fence, protect, tests/learn tool, automatic learning rows or no-retest gate exists. Commit on the work branch; never merge main or push. Integration may combine supplied commits only inside its private checkout. Carry prior commits explicitly through on/reads; record predictions and every verdict in the repo records from the supplied evidence, including failures. Writable scopes and frozen graders are instructions and review obligations, not host-enforced write fences.',
    ],
  },
  plan: async (x) => {
    const [beforeResult, baseResult] = await x.phase('measure', () =>
      Promise.all([measure({ id: 'before' }), shots()])
    );
    const before = need(beforeResult, 'The launch base could not be measured.');
    need(baseResult, 'No screenshot baseline.');
    const scans = passed(
      await x.phase('inventory', () => parallel(AREAS, (item) => inventory({ item })))
    );
    const targetPlan = need(
      await x.phase('target', () => target({ reads: [before, ...scans] })),
      'No linted lean target.'
    );
    await x.review('Are the budgets achievable and each retirement worth its wave?');
    let current: Held<unknown> = targetPlan;
    const trail: Readable[] = [targetPlan, ...scans];
    let cutCount = 0;
    for (const wave of [...new Set(targetPlan.out.map((s) => s.wave))].sort((a, b) => a - b)) {
      await x.phase(`wave-${wave}`, async () => {
        const todo = targetPlan.out.filter((s) => s.wave === wave);
        for (const item of todo.filter((s) => s.kind === 'seam')) {
          const built = await unify({ item, on: current, reads: [targetPlan] });
          trail.push(...evidence(built));
          current = need(built, `Seam ${item.id} failed; dependent slices cannot start.`);
          cutCount += 1;
        }
        const cuts = todo.filter((s) => s.kind === 'slice');
        const [first, ...rest] = cuts;
        const pilot = first
          ? await slice({ item: first, on: current, reads: [targetPlan] })
          : undefined;
        if (pilot) need(pilot, 'The pilot slice failed.');
        const built = pilot
          ? [
              pilot,
              ...(await parallel(rest, (item) =>
                slice({ item, on: current, reads: [targetPlan] })
              )),
            ]
          : [];
        trail.push(...built.flatMap(evidence));
        const accepted = passed(built);
        if (accepted.length) {
          current = need(
            await integrate({ on: current, reads: [targetPlan, ...accepted] }),
            'The combined wave failed its repo checks.'
          );
          cutCount += accepted.length;
        }
      });
      await x.review(
        `Wave ${wave}: which cuts failed, and did each new interface retire its predecessor?`
      );
    }
    if (!cutCount) return noResult('No slice passed and integrated.');
    const after = need(
      await x.phase('remeasure', () => measure({ id: 'after', on: current })),
      'The combined source could not be measured.'
    );
    if (after.out.sourceLines >= before.out.sourceLines)
      return noResult('Source lines did not go down.');
    return need(
      await x.phase('closeout', () => closeout({ on: current, reads: [before, after, ...trail] })),
      'The closeout did not prove one owner per fact.'
    );
  },
});
