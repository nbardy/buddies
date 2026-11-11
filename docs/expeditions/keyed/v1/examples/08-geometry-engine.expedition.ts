// Case 08: preserve the finite D2 analytic boundary under 256 MiB and 60 seconds.
// All work is serial: one engineer’s derivation, <=3 probe rounds, then one replay.
// Codex independently re-derives Claude’s geometry and audits the source plus replay receipt.
//
// V1 limits and NOTES carried forward:
// No counted pool or machine-wide lock: replay:1 is only concurrency, not one lifetime use.
// The plan calls replay once; before launch require an external one-use authorization receipt
// and forbid retrying that key after a guard stop. guard.py supplies actual process caps;
// checkout turns can still run tests, so the prohibition remains advisory. No protected
// grader paths or write fences; verify frozen test/guard bytes independently before execution.
// No learning/no-retest API: probe outcomes and prior attempts are supplied as evidence and
// recorded in WORK.md. derive -> implement -> receipt use continues plus on for one context.
// Done reads a receipt, never replays the suite: v1 cannot name a logged outcome as a done
// criterion. A judge’s grants cannot be configured; package replay output in receipt inputs.
// Unlike the old NOTES assumption, dry-run gates do not require derived.test.ts to exist
// at launch; the first implementation creates it. Do not commit an empty fake test.
//
// Before launch (historical prerequisites; verify against the target checkout):
// - `studio/design_kernel/native_geometry/derived.test.ts` is created by the first round:
//   closed-form known answers and allocation bounds that never realize the full D2 boundary.
//   V1's preview does not execute it, so it need not exist before launch.
// - `tools/geometry/verify_receipt.py` does not exist. It should check that the committed receipt
//   names the candidate commit and the exact guarded command, that peak RSS and elapsed time are
//   under the caps, that every test completed and passed, and that it matches the host's stored
//   output of the `replay` call. It reads a receipt; it does not run the suite.
// - `agent_notes/2026-10-30_own_geometry/G0_RECEIPT.json` and `DERIVATIONS.md` do not exist; the
//   plan's steps write them.
// - The `document-model-lead` Buddy id is assumed from "Document Model Lead" in the repo's notes.
// - Real and used as they are: `python3 oompa/geometry/guard.py -- <command>` and
//   `bun test ./studio/design_kernel/native_geometry/boundary.test.ts`. The use-case brief says the
//   suite covers four radii; the test file was not run or audited for this example.
//
// Gates typecheck and dry-run declarations; they never execute or establish existence of these tools.
// Fill in actual Buddy ids and check their providers; test providers below are explicit assumptions.

import {
  type Held,
  type Readable,
  type Result,
  command,
  expedition,
  need,
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
const NG = 'studio/design_kernel/native_geometry';
const GUARD = 'python3 oompa/geometry/guard.py --';
const reviewer = seat('codex', 'gpt-6-sol', 'high');
const engineer = role({
  by: seat('claude', 'claude-opus-5-5', 'high'),
  usd: 10,
  minutes: 90,
}).checkout();
const derivation_holds = `# Rubric: do the derived conditions hold?

You are reviewing a derivation note written on another model. The code that follows will be
built on it, and one scarce evaluation will be spent on that code, so an error here is expensive.

Do not read the note's conclusions first. Open \`studio/design_kernel/native_geometry/curved_wall.ts\`
and take the authored dimensions from the source. Then derive for yourself:

1. **The cap-intersection radius.** At what bore radius does the cutter's end cap meet the inner
   wall? Compare with the note. Check the tangency case is treated as a refusal, not as admitted.
2. **Topology of the admitted case.** Count faces, edges and vertices. Check the Euler
   characteristic for one closed solid of the stated genus. Check every edge joins exactly two
   faces with opposite orientation.
3. **Volume.** Evaluate the cylindrical-chord integral independently for each radius, by a method
   different from the note's if you can (numerical quadrature against a closed form). Agreement
   must be within the note's own stated error.
4. **The memory bound.** Follow the formula from tolerances to triangle count to bytes. Check that
   it is a bound on the peak and not on the final mesh, and that no step rests on a statement
   labelled CONJECTURE.

## Pass

Pass only if your numbers for 1 to 3 match the note's, the topology closes, and the memory bound
is a real upper bound below the 268,435,456 B cap with its margin stated. List each quantity, your
value and the note's value.

Fail for any disagreement, with your derivation. Fail a memory "bound" that is an estimate from a
previous run. Do not fail the note for style, length or for leaving general CSG out of scope: the
scope is the finite D2 boundary only.
`;
const preserved_geometry = `# Rubric: is the geometry behaviour preserved, and is the receipt true?

You are reviewing a candidate written on another model. Inspect the source, not the author's
prose. Read the full diff from the launch base to the candidate commit. Do not execute anything
except read-only git and file inspection; the host owns execution and the one replay is spent.

## The receipt

1. \`G0_RECEIPT.json\` matches the host's stored result of the replay: same commit, same command,
   same peak RSS, duration and counts. All tests completed and passed. Peak RSS and elapsed time
   are under 268,435,456 B and 60 s.
2. No source file changed between the replayed commit and this one. Only notes and the receipt.

## The source

3. Nothing outside \`boundary.ts\`, \`derived.test.ts\` and the notes folder changed.
   \`boundary.test.ts\`, \`oompa/geometry/\` and \`field_core/\` are byte-identical to the base.
4. No cap, tolerance or check was weakened. No refusal case was dropped. Compare each tolerance
   constant and each refusal branch with the base.
5. The boundary is still analytic: curved faces, trim curves and adjacency are constructed, not
   sampled from a grid or a display mesh. No path reaches OCCT, and no unsupported input falls
   back to anything; it refuses with a typed error before a result is published.
6. The cap-intersection and tangency refusals are enforced where \`DERIVATIONS.md\` says, at the
   derived radius.
7. Memory fits by construction: the sizing code the probe counts is the sizing code the mesher
   uses. A bound proved on a copy of the logic does not count.

## Pass

Pass only if all seven hold. Cite the commit, file and line for each. Rank anything you find by
severity.

Fail for any weakened check, any edit outside custody, any receipt field that does not match the
host's record, or a claim beyond the task. This candidate is one finite D2 boundary. It is not a
general kernel, and it does not establish Product receiving, physics or performance.
`;

const { derive, implement, probe, replay, receipt } = steps({
  derive: engineer
    .brief(`# Derive: the geometric conditions, before any code changes

You will hold this whole task in one conversation: derivation now, then implementation rounds
that continue from here. Nothing is run in this step. Take the time it needs.

## Read first

- \`agent_notes/2026-10-30_own_geometry/REQUIREMENTS.md\`, especially the operation-to-core map,
  "Smallest honest first replacement" and "Source-review correction".
- \`agent_notes/2026-10-30_own_geometry/MESH_DESIGN.md\` and \`WORK.md\`.
- \`studio/design_kernel/native_geometry/boundary.ts\`, \`curved_wall.ts\` and \`boundary.test.ts\`
  (read the test; never edit or run it).
- \`oompa/geometry/guard.py\`, and the earlier guarded receipts under
  \`output/2026-10-30_own_geometry/\` if they are present.
- The learning log in your inputs: earlier attempts and why each stopped (residual, capacity,
  timeout). Do not propose again what is already rejected there unless you say what is different.

## Produce \`agent_notes/2026-10-30_own_geometry/DERIVATIONS.md\`

1. **The admitted domain.** Derive, do not quote, the radius at which the bore cap meets the inner
   wall. REQUIREMENTS states r > sqrt(3.75^2 - 2^2) - 2.5; re-derive it from the authored recipe's
   dimensions and say whether you agree. State the tangency case separately. Everything outside
   the seven-face through-bore topology must refuse.
2. **Faces, trim curves, adjacency.** For the admitted domain: each face with its surface type,
   each edge with its curve type and the two faces it joins, and the orientation convention. Show
   closure (every edge used exactly twice, oppositely).
3. **Known answers.** The enclosed volume by an independent cylindrical-chord integral, in closed
   form or as a one-dimensional quadrature with a stated error, for each radius the suite uses.
   Face areas and edge lengths where a closed form exists.
4. **A memory and time bound.** From the mesh tolerances, a bound on vertices, triangles and peak
   allocation for each case, as a formula. The last run died at 270,024,704 B against a cap of
   268,435,456 B. Say where the bytes go and what bound your design guarantees.

## What good looks like

A reviewer on another model re-derives items 1 to 3 from the authored dimensions alone and gets
your numbers. Label each statement TEXTBOOK, DERIVATION or CONJECTURE. A bound you cannot prove is
a CONJECTURE, and item 4 may not rest on one.

Commit the note. Change no source in this step.
`)
    .judged(review(derivation_holds, reviewer)),
  implement: engineer
    .brief(`# Implement: one round of the loop

You are continuing your own conversation. Your derivation note has been independently confirmed.
Each round you make one change, commit it, and the host tests the commit under the guard within
seconds. The result of that test is in your inputs at the start of the next round.

## Each round

1. **Read the last result first.** If this is not round one, your inputs hold the previous probe:
   pass or fail, the guard's reason, peak RSS, elapsed time, the tail of the output. The host
   has already written that round's row in the learning log (a pass is \`keep\`, a fail is
   \`reject\`); use \`learn\` only to add the mechanism the result showed. A refusal that says the family is already rejected means choose a
   different mechanism, not a different wording.
2. **Choose one change.** One mechanism, named. Write down, before you edit, what you predict the
   probe will show.
3. **Edit** \`boundary.ts\`, and \`derived.test.ts\` when the change needs a new check. Round one
   creates \`derived.test.ts\`.
4. **Commit**, and answer with \`family\` (the mechanism family, short and stable across rounds,
   for example \`trim-span-allocation\`) and \`idea\` (this round's specific change).

## What \`derived.test.ts\` is for

It is the cheap stand-in for a suite that can be run only once. It must show, without realizing
the full D2 boundary, that the full suite will pass under the caps:

- the known answers from your derivation (cap-intersection radius, volume integral, face and edge
  counts) checked against the code's own closed-form paths;
- the refusal cases: cap intersection, tangency, an unsupported feature graph;
- allocation counts for each suite case computed from the same sizing code the mesher uses,
  asserted under your derived bound. Count; do not allocate.

If a check here needs the full geometry to run, it is not a probe. Prove the property by
construction instead.

## Do not

- Run \`boundary.test.ts\`, or any test, yourself. You may typecheck.
- Change two mechanisms in one round. You have a first build and two repairs.
- Lower a tolerance, sample a grid where an analytic patch is required, or catch and hide a
  capacity error.

Stop each round at the commit.
`)
    .returns(z.object({ family: z.string(), idea: z.string() })),
  probe: command(`${GUARD} bun test ./${NG}/derived.test.ts`, { minutes: 2 }).needs('guard'),
  replay: command(`${GUARD} bun test ./${NG}/boundary.test.ts`, { minutes: 2 }).needs(
    'guard',
    'replay'
  ),
  receipt: engineer
    .brief(`# Receipt: record the one replay and hand over the candidate

You are continuing your own conversation. The host has run the boundary suite once, under the
guard, on your last commit. Its result is in your inputs. That was the only replay.

Change no source in this step. If you see something you would fix, write it under "Known
limits"; a source change now would make the receipt describe a commit that was never tested.

## Write

\`agent_notes/2026-10-30_own_geometry/G0_RECEIPT.json\`, from the host's stored result and not from
memory: the candidate commit, the exact command, the guard's \`reason\`, \`returncode\`, \`elapsed\`,
\`peakRss\`, \`rssLimit\`, \`secondsLimit\`, the number of tests run and passed, and the host's
reference for the raw output.

Then add to \`agent_notes/2026-10-30_own_geometry/WORK.md\`, under a dated heading:

1. **The receipt in one line**: commit, peak RSS against the cap, duration, result.
2. **Derived conditions and refusal cases**, as they are now implemented, each with the file and
   line that enforces it. Point to \`DERIVATIONS.md\`; do not copy it.
3. **Attempt history**: every round of this run and the earlier stops (270,024,704 B after
   1.42 s, exit -9, zero tests), with the mechanism each one showed.
4. **Operation-to-core map**: which rows of the REQUIREMENTS table this candidate now covers and
   which remain explicitly incomplete. General box, sweep and Boolean combinations remain
   incomplete.
5. **Known limits**, and what Product's receiving checks (edit, Undo, publish, cold reopen) still
   have to establish. Those are not claimed here.

## What good looks like

Someone who was not here can tell which commit passed, under which caps, and what was not shown.
A reviewer on another model will read the whole diff from the launch base, not only this note,
and will check the receipt against the host's record.

Commit and stop. Do not describe the geometry engine as complete; one finite boundary passed.
`)
    .judged(review(preserved_geometry, reviewer)),
});

export default expedition({
  contract: {
    goal: `I decided on 30 October that internal geometry runs on our own implementation and OCCT stays only
at explicit external CAD exchange. The first replacement is the finite D2 analytic boundary: the
curved wall with the cylindrical bore, with real faces, trim curves, adjacency and meshes at the
0.45 m and 0.60 m radii. The code exists in \`native_geometry/boundary.ts\`. What does not exist is
a pass: the known-answer suite was killed by the guard at 270,024,704 B after 1.42 s, just over
the cap, with zero tests complete.

I want every original boundary case passing from a committed candidate under the unchanged caps,
and an independent reviewer confirming that the geometry behaviour is preserved. Then it goes to
Product for edit, Undo, publish and cold reopen, which are their tasks and not this one.

I authorized exactly one replay of the suite. The last expedition never used it: it spent its
attempts and ended on the deadline. So do the thinking first. The correctness here rests on
geometry that has to be derived (the bore cap meets the inner wall above a certain radius, and
that case must refuse), and the memory has to be shown to fit by construction before the replay is
spent, with checks that do not run the full geometry. If the replay fails, stop and tell me what
it showed. Do not ask the host for another.`,
    leader: 'document-model-lead',
    repo: '~/git/wave_sim',
    budget: { usd: 70, hours: 6 },
    autoApply: { usd: 10 },
    pools: { claude: 1, codex: 1, guard: 1, replay: 1 },
    done: [
      {
        check:
          'python3 tools/geometry/verify_receipt.py agent_notes/2026-10-30_own_geometry/G0_RECEIPT.json',
      },
      { review: { rubric: preserved_geometry, by: reviewer } },
      {
        owner:
          'Do you accept the G0 boundary candidate and hand it to Product for the receiving checks?',
      },
    ],
    rules: [
      'The guard caps are 268,435,456 B aggregate RSS and 60 s. Do not raise, bypass or split them. A guard stop is final for that run.',
      'Never run boundary.test.ts, local.test.ts, occt.test.ts or any Product test yourself. The host runs boundary.test.ts once.',
      'No OCCT, FreeCAD or native CAD, no GPU, no Modal, no new package. An unsupported shape refuses with a typed error; it never falls back to OCCT or to a sampled grid.',
      'Do not edit boundary.test.ts, oompa/geometry/, field_core/ or any Product file. Do not weaken a tolerance or drop a refusal case.',
      'The claim flags validatedPhysics, emergenceClaim, acceptedPhysics, objectiveComplete and matchedErrorSpeedup stay false.',
      'V1 execution notes override historical host claims in the briefs: no land, fence, protect, tests/learn tool, automatic learning rows or no-retest gate exists. Commit on the work branch; never merge main or push. Integration may combine supplied commits only inside its private checkout. Carry prior commits explicitly through on/reads; record predictions and every verdict in the repo records from the supplied evidence, including failures. Writable scopes and frozen graders are instructions and review obligations, not host-enforced write fences.',
      'Exactly one boundary replay is authorized. Persist external one-use authorization before live launch; no retry after failure or guard stop. Treat historical learn instructions as WORK.md records; no automatic host row exists.',
    ],
  },
  plan: async (x) => {
    const derived = need(
      await x.phase('derive', () => derive()),
      'The independent geometric re-derivation failed.'
    );
    const trail: Readable[] = [];
    let last: Held<unknown> = derived;
    let green: Held<unknown> | undefined;
    await x.phase('loop', async () => {
      for (const round of [1, 2, 3]) {
        const made = await implement({
          id: round,
          continues: last,
          on: last,
          reads: [derived, ...trail],
        });
        trail.push(...evidence(made));
        if (made.t !== 'passed') break;
        last = made;
        const probed = await probe({ id: round, on: last });
        trail.push(...evidence(probed));
        if (probed.t === 'passed') {
          green = last;
          break;
        }
      }
    });
    if (!green) return noResult('No round passed the guarded probe; the replay was not spent.');
    await x.review(
      'Before spending the one replay: is the full suite bounded by construction, rather than inferred from small cases?'
    );
    const replayed = need(
      await x.phase('replay', () => replay({ on: green })),
      'The single authorized replay failed. There is no second replay or automatic retry.'
    );
    return need(
      await x.phase('receipt', () =>
        receipt({ continues: green, on: green, reads: [derived, replayed, ...trail] })
      ),
      'The reviewer did not confirm preserved geometry or the receipt.'
    );
  },
});
