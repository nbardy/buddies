// Case 05: one Engine E source must pass forces, moving bodies and wind together.
// Rows are wide; each row has a serial diagnosis/repair/replay/paid-strike loop.
// Tests judge Codex repairs; Gemini judges diagnoses and the assumed Claude lead’s matrix.
//
// V1 limits and NOTES carried forward:
// No counted pools, per-row counters or machine-wide locks: strikes:3 is concurrency only.
// The two-round loop caps each row in this plan; validate exactly one E cell per R6/R7/R9
// to avoid duplicate rows buying extra strikes. A rewrite/retry still needs an external
// durable per-row counter and a $40 Modal ledger; --max-usd caps each invocation only.
// Stopping at two strikes is reported as an owner decision, not a kernel state.
// No wide pilot primitive: baseline cells are piloted explicitly; deep independent rows
// start together, since a failure to close one row must not suppress the others.
// No learning rows or no-retest gate; full evidence is handed to record. Integration is a
// worker checkout, not host land. Frozen graders and scopes are review obligations.
// The local replay must have a faithful CPU/WebGPU twin for CUDA; that prerequisite is
// unresolved. Done converts failing <=0 to an exit-code assertion; it re-scores the
// integrated source with --max-usd 6.00, which also counts toward the $40 cap.
//
// Before launch (historical prerequisites; verify against the target checkout):
// - `tools/capability_matrix_v1/` does not exist in wave_sim. The plan assumes four scripts in it,
//   written and committed before launch:
//   - `cells.py --json` prints the cells `{ id, row, engine }` from the matrix file;
//   - `score.py --row R --engine E|A --max-usd N --json` runs that row's frozen case through the
//     central runner on Modal and prints `{ pass, error, bound, usd, sha, device }`; with
//     `--require-pass` it exits non-zero when the row is outside its gate;
//   - `replay.py --row R --require-fixed` replays every saved failure of the row against the
//     checked-out source on the local M4 and exits 0 only if all of them now pass;
//   - `matrix.py --max-usd N --json` scores every cell and prints `{ failing, cells: [...] }`, where
//     `failing` counts Engine E rows outside their gate.
// - `benchmarks/capability_matrix_v1/matrix.json` (rows, engines, case ids, gates, references) and
//   `benchmarks/capability_matrix_v1/saved_failures/` do not exist. The saved failures of the
//   earlier foil, draft and wind runs are scattered across `output/` and `agent_notes/`; collecting
//   them into replayable form is work that must happen before launch.
// - A local M4 replay of a CUDA engine's saved failure does not exist. Engine E is CUDA and the M4
//   has no CUDA. `replay.py` is assumed to run the repaired operator on the saved state through a
//   CPU or WebGPU twin. Whether such a twin can be faithful for each row is not established.
// - The central runner (`bun run sim <engine> <case>`) has no foil, floating-box or wind-setup case
//   today; its case list is still water, sloshing, solitary wave, dam break and four others. The
//   per-row tools that exist (`tools/sim_runner_v1/e_foil_score_v3.py`, `wind_campaign_v3d.ts`,
//   `rocks_campaign_v2.ts`, …) are separate scripts with their own launchers.
// - `python3 -m unittest discover -s prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1 -p 'test_*.py'`
//   is assumed to run that directory's existing Python tests without a GPU. Not verified.
// - `agent_notes/2026-11-10_capabilities/` is a new directory the plan writes failure-class
//   documents into. `goals/2026-11-10_capability_matrix.md` is a new file the record step writes.
// - The `wave-simulation-lead` Buddy id is assumed from "Accountable: Wave Simulation Lead" in the
//   goals file. Its provider is assumed to be claude; the dry run must show it is not gemini.
// - The dollar figures, the three Modal slots and the 72 hours are example numbers.
//
// Gates typecheck and dry-run declarations; they never execute or establish existence of these tools.
// Fill in actual Buddy ids and check their providers; test providers below are explicit assumptions.

import { type Held, type Readable, type Result, expedition, step } from 'expedition';
import { z } from 'zod';

// Preserve failed outputs as evidence too: filtering for passes alone would erase a search's refutations.
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

const TARGET = 'E';
const ENGINE = 'prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1/';
const MATRIX = 'tools/capability_matrix_v1';
const Cell = z.object({
  id: z.string(),
  row: z.enum(['R6', 'R7', 'R9']),
  engine: z.enum(['E', 'A']),
});

const score = (item: z.infer<typeof Cell>) =>
  `python3 ${MATRIX}/score.py --row ${item.row} --engine ${item.engine} --max-usd 0.50 --json`;
const tests = { check: `python3 -m unittest discover -s ${ENGINE} -p 'test_*.py'` };
const failure_class = `# Rubric: does this page localise the failure?

You are reviewing a one-page failure-class document for one row on one engine. A repair will be
built from it, and that repair gets at most two paid runs. You did not write the page. Judge
whether the diagnosis follows from the evidence, not whether the proposed repair sounds sensible.

Open the saved failures and the baseline report the page cites. Check:

1. **The failure is stated as measured.** The number, the gate, the commit and the case match the
   baseline report in the inputs and \`benchmarks/capability_matrix_v1/matrix.json\`.
2. **It is localised by evidence.** The page says which term carries the error and shows data
   that rules out the alternatives it lists (flow, boundary, coupling, measurement). "Most
   likely" with no discriminating evidence fails.
3. **It describes a class.** The page covers more than the one symptom, and the repair it names
   addresses the class. A repair that would only move the fault to the next cell or particle fails.
4. **History is used.** If this is a second round, the page explains why the first repair's
   result is consistent with the new diagnosis. A page that ignores a failed attempt fails.
5. **It predicts.** There is a numeric prediction for the frozen case after the repair, and a
   stated result that would prove the diagnosis wrong.
6. **Nothing frozen moves.** The page does not propose changing the window, the reference, the
   gate or a tolerance below the typed minimum.

Pass only if all six hold. A page that honestly says "the evidence cannot separate these two
mechanisms, and this local replay would" passes item 2 if the replay it names would separate them.

In your answer, quote the evidence you checked for item 2. If you fail the page, say which
alternative mechanism it did not rule out.
`;
const matrix_honest = `# Rubric: does the matrix say exactly what was measured?

You are reviewing \`goals/2026-11-10_capability_matrix.md\` and the entries added to
\`KEY_LEARNINGS.md\` and the failure-class pages. You did not write them and you repaired nothing.
The owner will decide from this file which engine to build on, so an optimistic cell is the worst
error it can contain.

Open the reports in the inputs. Check:

1. **Every cell traces.** Each error, gate, verdict, commit, device and dollar figure matches a
   report. Quote the report field beside each cell you check, and check every Engine E cell.
2. **PASS means the final run.** A cell marked PASS is passing in the matrix run on the integrated
   commit. A row that passed only on its own repair commit must be marked "passed alone".
3. **The gates did not move.** Each gate, window and reference equals
   \`benchmarks/capability_matrix_v1/matrix.json\` at the launch commit. Any difference fails the
   review, whatever the explanation.
4. **Failures are whole.** Each failing Engine E row shows its strikes used, links its
   failure-class page, and states the owner's decision. Each failed repair has a graveyard row
   with its number.
5. **Interference is reported.** If a row's score on the integrated commit is worse than on its
   own repair commit, the file names it.
6. **No promotion.** The file does not call Engine E "working", "validated" or "qualified" unless
   all three rows pass in the final run, and no claim flag was changed.

Pass only if all six hold.

In your answer, give the matrix as you read it from the reports, cell by cell, and mark every
place where the file differs. If the file and the reports agree but a report itself looks wrong
(a cost of zero, a missing commit), pass the file and flag the report for the leader.
`;

export default expedition({
  contract: {
    goal: `I want one engine that does forces, moving bodies and wind at the same time. Today no engine
does. Engine E (the Eulerian CUDA solver) is the one I want to carry all three; Engine A (CUDA
APIC) is measured on the same cases so the matrix shows where each stands.

The rows are the ones already written down in \`goals/2026-10-12_three_engine_goals.md\`, unchanged:

- **R6 forces.** Foil lift within 10% at Re 1000 on two grids, with the error falling.
- **R7 moving bodies.** Floating-box draft within 2%, heave decays, period within 5%; a dropped
  rock settles; momentum exchange closes.
- **R9 wind.** Solved air/water coupling, not only a prescribed stress; setup slope within 10% of
  τ/(ρgh).

R12 conservation is checked inside each of those cases. Sand (R8) is out of scope here.

Where it stood on 2026-10-12: Engine E has foil lift 15.75% low, draft off by 16.5%, wind setup
31% low. Engine A has a sphere force 177% high and nothing else measured on CUDA.

What went wrong before is the reason for the rules. Plate lift took about nineteen paid attempts,
each one moving the fault to the next particle. The beta quietly depended on the hardest physics
row. So: each row gets a written diagnosis of the whole failure class first, a free local replay
of its saved failures before any paid run, and at most two paid tries. The rows are independent
of each other and can be worked at the same time. Inside a row the work is serial.

Done means all three rows pass their frozen gates on Engine E, from one committed source, with
the cost recorded, re-scored by the host and not by the people who fixed it. If a row does not
close in two strikes, I want the matrix to say so plainly and the failure-class document to tell
me what decision I have to make.`,
    leader: 'buddy:wave-simulation-lead',
    repo: '~/git/wave_sim',
    budget: { usd: 220, hours: 72 },
    autoApply: { usd: 15 },
    pools: { claude: 1, codex: 3, gemini: 1, gpu: 1, modal: 3, strikes: 3 },
    done: [
      {
        check: `bash -c 'bun test tools/sim_runner_v1/runner.test.ts tools/sim_runner_v1/tolerance.test.ts'`,
      },
      {
        check: `python3 -c 'import json,subprocess; r=json.loads(subprocess.check_output(["python3","tools/capability_matrix_v1/matrix.py","--max-usd","6.00","--json"])); assert r["failing"] <= 0'`,
      },
      { review: matrix_honest, by: 'judge' },
      {
        owner:
          'Do you accept Engine E as the engine that carries forces, moving bodies and wind together?',
      },
    ],
    rules: [
      'Commit on the work branch; never merge main or push. Integrate supplied commits only inside your private checkout.',
      'Keep predictions and every verdict, including failures, in repo records from the supplied call evidence.',
      'The gates in benchmarks/capability_matrix_v1/matrix.json are frozen. Same Scene, initial state, observation window, reference and scoring for every engine. A changed window or reference is a separate case, never a pass.',
      'Tolerances come from the typed constructors in tools/sim_runner_v1/tolerance.ts. f32 relative tolerances are at least 1e-4. No bare numbers.',
      'Two strikes per row. After a second failed paid run on a row, paid runs on it stop until the owner decides. A repair renamed as a "sidecar" or a "probe" is still a strike.',
      "No paid run before the local replay of every saved failure for that row passes. Agents never launch Modal or the local GPU; the host's benchmark steps do.",
      'A result cites a commit and its complete cost (setup, compile, evolution, output, readback, dollars). A run from a dirty tree is exploratory and cannot be cited.',
      'Say "passes row R on engine X at commit S". Do not write "working", "validated" or "qualified" for an engine that fails any row.',
      'Write a repo research row for each diagnosed mechanism and each repair, with the prediction made before the measurement.',
      'The total Modal cap is $40; require an external spend ledger, scale-to-zero launcher, machine GPU lock and two-strike counter per row before execution. Never retry a paid scoring call automatically.',
    ],
  },
  agents: {
    judge: 'gemini:gemini-3.1-pro-preview',
    lead: { use: 'buddy:wave-simulation-lead', usd: 8, minutes: 60 },
    deep: { use: 'codex:gpt-6.1-sol:high', usd: 15, minutes: 150 },
  },
  steps: {
    cells: { run: `python3 ${MATRIX}/cells.py --json`, minutes: 1, returns: z.array(Cell) },
    measure: {
      item: Cell,
      run: score,
      minutes: 40,
      returns: z.object({ pass: z.boolean() }),
      needs: ['modal'],
    },
    diagnose: step({
      by: 'deep',
      checkout: true,
      brief: (item) => `# Diagnose: why ${item.row} fails on Engine ${item.engine}

You own one cell of the requirement matrix: row ${item.row} on Engine ${item.engine}. It fails its frozen
gate. Your inputs hold the baseline score for this cell and, if this is a second round, the first
round's diagnosis, its repair, its local replay and its paid result. Read all of that history
before anything else. A second diagnosis that repeats the first one is a wasted strike.

You are not fixing anything in this step. You are writing the one-page design of the whole
failure class, so that the repair that follows is aimed at a mechanism and not at a symptom.
Plate lift took about nineteen paid attempts because each fix moved the fault to the next
particle and nobody had written down the class.

## Read first

- \`benchmarks/capability_matrix_v1/matrix.json\`: the case, window, reference and gate for ${item.row}.
- \`goals/2026-10-12_three_engine_goals.md\`: the row's pass check and the 2026-10-12 status.
- \`KEY_LEARNINGS.md\`, especially "2026-10-07: Foil lift deficit is in the flow, not the force
  measurement" and the graveyard. Then the supplied call evidence in your inputs.
- \`agent_notes/2026-10-12_engine_dual/R5_FIXED_SOLIDS_FAILURE_CLASS.md\` as the model for the
  document you are writing.
- The engine source under \`prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1/\` that the row exercises.
- The saved failures for the row in \`benchmarks/capability_matrix_v1/saved_failures/\`.

## Write \`agent_notes/2026-11-10_capabilities/${item.id}_FAILURE_CLASS.md\`, one page

1. The measured failure: the number, the gate, the commit, and where in the run it appears.
2. Localisation. Which term carries the error: the flow, the boundary treatment, the coupling, or
   the measurement? Show the saved-failure evidence that rules the others out. Check units,
   limits and the conservation ledger for the case.
3. The failure class: every way this mechanism can show up, not only the one in front of you.
4. What was already tried on this row, and why each attempt did or did not address the class.
5. One repair, and the prediction: the error you expect after it, as a number, and which saved
   failure will flip first. State what result would prove the diagnosis wrong.

## Answer

Return \`family\` (the mechanism family, in words the supplied call evidence already uses where one fits) and
\`idea\` (the one repair, in a sentence). The plan declares these as what the repair tests. If that
family is already rejected for this engine, your page must say what is different this time.

Write a repo research row for the diagnosed mechanism. A reviewer on another model checks that your
localisation follows from the evidence. If the evidence cannot localise the failure, say which
local replay would, and return that as the idea. Do not launch anything on Modal or the GPU, and
do not edit the gate, the window or the reference.
`,
      item: Cell,
      returns: z.object({ family: z.string(), idea: z.string() }),
      judge: { review: failure_class, by: 'judge' },
    }),
    repair: step({
      by: 'deep',
      checkout: true,
      brief: (item) => `# Repair: ${item.row} on Engine ${item.engine}

You have just written the failure-class page for this cell, and this call continues that
conversation. Now make the one repair the page names. Not a different one, and not two.

## Build

- Change only files under \`prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1/\`. The checkout
  starts from the commit that holds your failure-class page.
- Repair the mechanism in the shared path. Do not add a case-specific branch, a tuned constant
  that only this Scene needs, or a new "sidecar" beside the solver. If the row can only pass with
  a special case, the diagnosis is wrong: say so and stop.
- Keep every other row's physics untouched. Still water (R2) passes on this engine today at
  4e-7 m; a repair that disturbs hydrostatic balance has traded one row for another.
- Any tolerance you add comes from \`tools/sim_runner_v1/tolerance.ts\`. No bare numbers, and no
  f32 relative tolerance below 1e-4.
- GPU legality is part of the method: buffers, capacities, reductions, pass order. No CPU
  fallback in the hot loop.
- Add or extend a \`test_*.py\` beside the source that pins the repaired behaviour on a small known
  answer, with no GPU. The directory's unit tests are your judge; run them and fix what you break.

## What happens after you commit

The host, not you, replays every saved failure for ${item.row} against your commit on the local M4.
Only if all of them pass does it spend one of this row's two paid runs to score the frozen case on
Modal. You get no third run. So before you commit, ask whether the saved failures will pass and
why; if you cannot say why, you are not done.

## Do not

- Launch Modal, the local GPU or any campaign script yourself.
- Touch \`tools/capability_matrix_v1/\`, \`benchmarks/capability_matrix_v1/\` or the scoring window.
- Rename a second attempt so that it does not look like one.
- Claim the row passes. You have not seen a score.

Write a repo research row before you commit: the repair, its family, the error you predict on the
frozen case, and leave the measurement for the host's runs. In your summary, say in three lines
what you changed and what a failed paid run would most likely mean. Stop when the tests pass and
the change is committed.
`,
      item: Cell,
      judge: tests,
    }),
    replay: step({
      run: (item) => `python3 ${MATRIX}/replay.py --row ${item.row} --require-fixed`,
      minutes: 20,
      item: Cell,
      needs: ['gpu'],
    }),
    strike: step({
      run: (item) => `${score(item)} --require-pass`,
      minutes: 40,
      item: Cell,
      needs: ['modal', 'strikes'],
    }),
    integrate: {
      by: 'deep',
      checkout: true,
      brief: `# Integrate: one source that passes every closed row

Your inputs are the repair commits that each closed one row on Engine E, alone. Each started from
the launch base plus its own failure-class page, so none contains the others. Produce one commit
that contains all of them. The host then re-scores the whole matrix on your commit, every cell.

This step exists because of what the owner said about these engines: no single source combines
the rows. A set of rows that each pass on their own branch is not that.

## Do

- Change source under \`prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1/\` only. Carry each row's
  page in \`agent_notes/2026-11-10_capabilities/\` across unchanged.
- Apply the repairs one at a time, in this order: forces, then moving bodies, then wind. After
  each, run the directory's \`test_*.py\` tests.
- Where two repairs touch the same kernel or the same boundary term, read both failure-class
  pages in \`agent_notes/2026-11-10_capabilities/\` before resolving. Keep both mechanisms. If they
  cannot both hold, that is the finding: stop, and report which two rows conflict and in which
  term.
- Keep each repair's own unit test, unchanged.

## Do not

- Re-tune a repair to make the merge easier. The paid score each row earned was for the repair as
  committed; a retuned one has not been scored.
- Add anything new: no clean-up, no refactor, no extra fix for a row that did not close.
- Edit the gates, the scoring tools or the saved failures.
- Launch Modal or the GPU. You cannot know whether the combined source still passes each row, so
  do not say it does.

## Report

List the commits you combined, every conflict you resolved and how, and any place where two
repairs now run in an order that one of the failure-class pages did not assume. If you received
only one commit, check it builds on the base, run the tests, and say there was nothing to combine.
Stop when the tests pass and the result is one commit.
`,
      judge: tests,
    },
    matrix: {
      run: `python3 ${MATRIX}/matrix.py --max-usd 6.00 --json`,
      minutes: 120,
      returns: z.object({ failing: z.number() }),
      needs: ['modal'],
    },
    record: {
      by: 'lead',
      reads: ['goals/', 'KEY_LEARNINGS.md'],
      checkout: true,
      brief: `# Record: the matrix as it now stands

Your inputs hold the baseline score of every cell, the repair commits that closed a row, the
final matrix scored on the integrated commit, and the supplied call evidence. You are working on top of the
integrated commit. Write the tracked record. A reviewer on another model will check every cell
you write against the reports.

## Write

1. \`goals/2026-11-10_capability_matrix.md\`:
   - the matrix: rows R6, R7, R9 against engines E and A. Each cell has the measured error, the
     gate, PASS or FAIL, the commit, the device and the dollars, before and after;
   - for each Engine E row that is still failing: how many paid strikes it used, a link to its
     failure-class page, and the one decision the owner has to make to go further;
   - any row that passed alone and fails on the integrated commit, named as an interference
     between two repairs;
   - the total cost of the run, including failed repairs.
2. In \`goals/2026-10-12_three_engine_goals.md\`, add one dated line at the top pointing to the new
   file. Do not edit its status table; that table is the 2026-10-12 record.
3. \`KEY_LEARNINGS.md\`: one dated entry per diagnosed mechanism, with what was predicted and what
   was measured. A repair whose paid run failed goes in the graveyard table with its number.
4. Each \`agent_notes/2026-11-10_capabilities/*_FAILURE_CLASS.md\` page gets a final "Outcome"
   section: the replay result, the paid result, and whether the diagnosis held.

## Rules

- Copy numbers from the reports. A cell with no report is "not measured", not a guess.
- A cell is PASS only if the final matrix run on the integrated commit says so. A row that passed
  on its own repair commit and was not re-scored is "passed alone", which is a different word.
- Engine A was measured and not repaired. Say that in one line; do not describe it as behind.
- Do not write "working" for Engine E unless all three rows pass. Do not change any claim flag.
- Do not touch engine source, the gates or the scoring tools.

Stop when the files are committed.
`,
      judge: { review: matrix_honest, by: 'judge' },
    },
  },
  plan: async (
    { cells, measure, diagnose, repair, replay, strike, integrate, matrix, record },
    x
  ) => {
    const grid = await x.phase('cells', () => cells());
    const target = grid.out.filter((c) => c.engine === TARGET);
    if (target.length !== 3 || new Set(target.map((c) => c.row)).size !== 3)
      throw new Error('Expected exactly one Engine E cell for each of R6, R7 and R9.');
    if (new Set(grid.out.map((c) => c.id)).size !== grid.out.length)
      throw new Error('Matrix cell ids must be unique.');
    const [first, ...rest] = grid.out;
    if (!first) throw new Error('No baseline cells.');
    const pilot = await x.phase('baseline-pilot', () => measure(first));

    const before = [
      { item: first, result: pilot },
      ...(await x.phase('baseline', () =>
        Promise.all(rest.map(async (item) => ({ item, result: await measure.try(item) })))
      )),
    ];
    const open = before.filter(
      (b) => b.item.engine === TARGET && !(b.result.t === 'passed' && b.result.out.pass)
    );
    await x.checkin(
      'Do the baselines reproduce E: foil 15.75% low, draft 16.5%, setup 31% low? A moved number needs investigation.'
    );
    const rows = await x.phase('rows', () =>
      Promise.all(
        open
          .map((b) => ({ id: b.item.id, ...b }))
          .map(async ({ item, result }) => {
            const history: Readable[] = evidence(result);
            let base: Held<unknown> | undefined;
            for (const round of [1, 2]) {
              const id = `${item.id}-${round}`;
              const cause = await diagnose.try(item, { id, on: base, reads: history });
              history.push(...evidence(cause));
              if (cause.t !== 'passed') continue;
              const fix = await repair.try(item, {
                id,
                on: cause,
                continues: cause,
                reads: [cause],
              });
              history.push(...evidence(fix));
              if (fix.t !== 'passed') continue;
              base = fix;
              const local = await replay.try(item, { id, on: fix });
              history.push(...evidence(local));
              if (local.t !== 'passed') continue;
              const paid = await strike.try(item, { id, on: fix });
              history.push(...evidence(paid));
              if (paid.t === 'passed') return { fixes: [fix], history };
            }
            return { fixes: [], history };
          })
      )
    );
    const fixes = rows.flatMap((r) => r.fixes);
    const trail = [...before.flatMap((b) => evidence(b.result)), ...rows.flatMap((r) => r.history)];
    await x.checkin(
      'Which rows closed? Rows at two strikes need an owner decision, never a third renamed run.'
    );
    let combined: Held<unknown> | undefined;
    if (fixes.length) combined = await x.phase('integrate', () => integrate({ reads: fixes }));
    const after = await x.phase('matrix', () => matrix.try({ on: combined }));
    trail.push(...evidence(after));
    await x.checkin('Did combining repairs cost a row that passed alone? Name any interference.');
    return await x.phase('record', () =>
      record({
        on: combined,
        reads: [
          ...trail,
          ...fixes,
          'If a row remains open, state the owner decision and strikes used.',
        ],
      })
    );
  },
});
