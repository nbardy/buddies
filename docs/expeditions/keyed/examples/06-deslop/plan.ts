import { z } from 'zod';
import {
  buddy,
  check,
  checkout,
  command,
  gap,
  passed,
  plan,
  review,
  role,
  seat,
  steps,
  usd,
  wide,
} from '../../api/expedition';

const NOTES = 'agent_notes/2026-11-10_deslop';
const CODE = [
  'server/src/',
  'server/test/',
  'client/src/',
  'client/test/',
  'shared/src/',
  'crates/',
];
// The repo's real checks, then the slice gate: the commit deletes only the tests its slice lists and adds no net source lines.
const GATE = check(
  `pnpm typecheck && pnpm test:server && pnpm test:client && bash tools/check-client-invariants.sh && node tools/deslop/slice-gate.mjs ${NOTES}/TARGET.json {{id}}`,
  'tools/'
).needs('checks');
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
  kind: z.enum(['seam', 'slice']), // a seam crosses files; a slice stays in its fence
  fence: z.array(z.string()),
  retires: z.string(),
  keeps: z.string(),
});

// Who. Slices and seams are judged by commands, the closeout by a reviewer on a third provider.
const judge = seat('gemini', 'gemini-3.1-pro-preview', 'high');
const lead = role({ by: buddy('product-dev'), max: usd(10), minutes: 60 }).reads(
  ...CODE,
  'docs/',
  'agent_notes/'
);
const scout = role({
  by: seat('claude', 'claude-sonnet-5-5', 'low'),
  max: usd(1),
  minutes: 15,
}).reads(...CODE, 'docs/patterns.md');
const coder = role({ by: seat('claude', 'claude-sonnet-5-5', 'high'), max: usd(4), minutes: 45 });
const typer = role({ by: seat('codex', 'gpt-6.1-sol', 'high'), max: usd(10), minutes: 90 });

const { measure, shots, inventory, target, unify, slice, closeout } = steps({
  measure: command('node tools/deslop/measure.mjs --json', { minutes: 5 }).returns(Size),
  shots: command('node tools/deslop/shots.mjs --out output/deslop/base', { minutes: 30 }).needs(
    'checks'
  ),
  inventory: scout,
  target: lead
    .in(checkout(`${NOTES}/`))
    .lists(Slice)
    .judged(check(`node tools/deslop/target-lint.mjs ${NOTES}/TARGET.json`, 'tools/')),
  unify: typer.in(checkout(...CODE)).judged(GATE),
  slice: coder.in(checkout(...CODE)).judged(GATE),
  closeout: lead.in(checkout(`${NOTES}/`, 'docs/')).judged(review('retired', judge)),
});

export default plan(async (x) => {
  const [before, base] = await x.phase('measure', () =>
    Promise.all([measure({ id: 'before' }), shots()])
  );
  if (before.t !== 'passed' || base.t !== 'passed')
    return gap('The launch base could not be measured.', before, base);

  const scans = passed(
    await x.phase('inventory', () => wide(AREAS, (area) => inventory({ item: area })))
  ).map((s) => s.value);
  const slices = await x.phase('target', () => target({ reads: [before.value, ...scans] }));
  if (slices.t !== 'passed')
    return gap('No lean target passed its lint (disjoint fences, a retirement per slice).', slices);
  const start = await x.land('target', slices.value); // from here every call starts on the latest landed commit
  if (start.t !== 'passed') return gap('The lean target could not be landed.', start);

  await x.review(
    'Is this target worth its waves? Check the budgets against the inventory before any code is cut.'
  );

  let landed = 0;
  for (const n of [...new Set(slices.value.out.map((s) => s.wave))].sort((a, b) => a - b)) {
    const todo = slices.value.out.filter((s) => s.wave === n);
    await x.phase(`wave-${n}`, async () => {
      // Narrow: cross-cutting type unification is one worker at a time, each on the previous seam's landed commit.
      for (const s of todo.filter((s) => s.kind === 'seam')) {
        const built = await unify({ id: s.id, item: s, fence: s.fence, reads: [slices.value] });
        if (built.t === 'passed' && (await x.land(s.id, built.value)).t === 'passed') landed += 1;
      }
      // Wide: each slice in its own fence, on the seams' commit. One slice and its checks run first.
      const cuts = await wide(
        todo.filter((s) => s.kind === 'slice'),
        (s) => slice({ item: s, fence: s.fence, reads: [slices.value] })
      );
      // Serial, re-checked on the merged commit. What did not pass or land stays in the log for the wave review.
      for (const { item, value } of passed(cuts))
        if ((await x.land(item.id, value)).t === 'passed') landed += 1;
    });
    await x.review(
      `Wave ${n}: which slices did not land and why? Did any add an interface without retiring one? Re-cut, or go on?`
    );
  }
  if (landed === 0) return gap('No slice passed the repo checks and landed.', slices);

  const after = await x.phase('remeasure', () => measure({ id: 'after' }));
  if (after.t !== 'passed') return gap('The landed tree could not be measured.', after);
  if (after.value.out.sourceLines >= before.value.out.sourceLines)
    return gap('Slices landed, but source lines did not go down.', before, after);

  const report = await x.phase('closeout', () =>
    closeout({ reads: [before.value, after.value, slices.value, ...scans] })
  );
  if (report.t !== 'passed')
    return gap('The closeout did not show one owner per fact with the old paths deleted.', report);
  const final = await x.land('closeout', report.value);
  return final.t === 'passed' ? final.value : gap('The closeout could not be landed.', final);
});
