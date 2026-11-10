import { z } from 'zod';
import {
  type Held,
  type Readable,
  type Result,
  buddy,
  check,
  checkout,
  command,
  gap,
  plan,
  review,
  role,
  seat,
  steps,
  usd,
  wide,
} from '../../api/expedition';

const TARGET = 'E'; // the engine every row must pass on; the other engine is measured, not repaired
const ENGINE = 'prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1/';
const MATRIX = 'tools/capability_matrix_v1';
const DOCS = 'agent_notes/2026-11-10_capabilities/';
const GATES = 'benchmarks/capability_matrix_v1/';

const Cell = z.object({ id: z.string(), row: z.string(), engine: z.enum(['E', 'A']) });
const Score = z.object({ pass: z.boolean() }); // the row's frozen gate, applied by the scoring script
const Cause = z.object({ family: z.string(), idea: z.string() }); // the diagnosed mechanism and the one repair it implies
const Matrix = z.object({ failing: z.number() }); // target-engine rows still outside their gate

// Who. The deep worker diagnoses and repairs one row in one conversation; numbers judge its code.
const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('wave-simulation-lead'), max: usd(8), minutes: 60 }).reads(
  'goals/',
  'KEY_LEARNINGS.md'
);
const deep = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), max: usd(15), minutes: 150 });
const score = `python3 ${MATRIX}/score.py --row {{row}} --engine {{engine}} --max-usd 0.50 --json`;
const tests = check(`python3 -m unittest discover -s ${ENGINE} -p 'test_*.py'`);

const { cells, measure, diagnose, repair, replay, strike, integrate, matrix, record } = steps({
  cells: command(`python3 ${MATRIX}/cells.py --json`, { minutes: 1 }).lists(Cell),
  measure: command(score, { minutes: 40 }).returns(Score).needs('modal').protect(GATES),
  diagnose: deep.in(checkout(DOCS)).returns(Cause).judged(review('failure-class', judge)),
  repair: deep.in(checkout(ENGINE)).judged(tests),
  replay: command(`python3 ${MATRIX}/replay.py --row {{row}} --require-fixed`, {
    minutes: 20,
  }).needs('gpu'), // exit 0: every saved failure passes
  strike: command(`${score} --require-pass`, { minutes: 40 })
    .needs('modal', 'strikes')
    .protect(GATES), // exit 0: the row is inside its gate
  integrate: deep.in(checkout(ENGINE, DOCS)).judged(tests),
  matrix: command(`python3 ${MATRIX}/matrix.py --max-usd 6.00 --json`, { minutes: 120 })
    .returns(Matrix)
    .needs('modal')
    .protect(GATES),
  record: lead
    .in(checkout('goals/', 'KEY_LEARNINGS.md', DOCS))
    .judged(review('matrix-honest', judge)),
});

export default plan(async (x) => {
  const grid = await x.phase('cells', () => cells());
  if (grid.t !== 'passed') return gap('The frozen requirement matrix could not be listed.', grid);

  // Every cell, both engines, in parallel on Modal. `wide` pays for one cell before the rest.
  const before = await x.phase('baseline', () => wide(grid.value.out, (c) => measure({ item: c })));
  const open = before.filter(
    (b) => b.item.engine === TARGET && !(b.result.t === 'passed' && b.result.value.out.pass)
  );
  await x.review(
    'Do the baselines reproduce the recorded status (E: foil 15.75% low, draft 16.5%, setup 31% low)? A number that moved means the case is not the frozen case.'
  );

  // One row: serial, and two rounds at most. A paid run happens only after the free local replay passes.
  const close = async (
    c: z.infer<typeof Cell>,
    baseline: Result<unknown, 'judged'>
  ): Promise<Held<unknown>[]> => {
    const history: Readable[] = [baseline];
    for (const round of [1, 2]) {
      const id = `${c.id}-${round}`;
      const cause = await diagnose({ id, item: c, reads: [...history, x.learnings('all')] });
      if (cause.t !== 'passed') {
        history.push(cause);
        continue;
      }
      const fix = await repair({
        id,
        item: c,
        on: cause.value,
        continues: cause.value,
        tests: cause.value.out,
      });
      if (fix.t !== 'passed') {
        history.push(cause.value, fix);
        continue;
      }
      const local = await replay({ id, item: c, on: fix.value });
      history.push(cause.value, fix.value, local);
      if (local.t !== 'passed') continue;
      const paid = await strike({ id, item: c, on: fix.value, tests: cause.value.out }); // passed is `keep`, failed is `reject`
      if (paid.t === 'passed') return [fix.value];
      history.push(paid);
    }
    return [];
  };
  const fixes = (
    await x.phase('rows', () => Promise.all(open.map((o) => close(o.item, o.result))))
  ).flat(); // rows are independent: one deep worker each
  await x.review(
    'Which rows closed and which are at two strikes? A row at two strikes is an owner decision; do not rewrite the plan to buy a third.'
  );
  if (fixes.length === 0)
    return gap(
      'No row closed on Engine E within two rounds. The failure-class documents are in the log.',
      ...before.map((b) => b.result)
    );

  // The owner's point: one source that passes every row together. Combine, then re-score the whole matrix.
  const merged = await x.phase('integrate', () => integrate({ reads: fixes }));
  if (merged.t !== 'passed')
    return gap(
      'The row fixes do not combine into one commit that passes the engine tests.',
      merged,
      ...fixes
    );
  const after = await x.phase('matrix', () => matrix({ on: merged.value }));
  await x.review(
    'Did combining the fixes cost any row that passed alone? If so, which pair interferes?'
  );

  const written = await x.phase('record', () =>
    record({
      on: merged.value,
      reads: [after, ...before.map((b) => b.result), ...fixes, x.learnings('all')],
    })
  );
  if (written.t !== 'passed')
    return gap('The matrix write-up did not pass its independent review.', written, after);
  await x.land('capabilities', written.value);
  return after.t === 'passed' && after.value.out.failing === 0
    ? written.value
    : gap(
        'Engine E does not pass every row yet. The landed matrix says which rows pass at which commit.',
        written.value,
        after
      );
});
