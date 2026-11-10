import { z } from 'zod';
import type { Held, Readable } from '../../api/expedition';
import { checkout, command, gap, plan, review, role, seat, steps, usd } from '../../api/expedition';

const NG = 'studio/design_kernel/native_geometry';
const NOTES = 'agent_notes/2026-10-30_own_geometry';
const GUARD = 'python3 oompa/geometry/guard.py --'; // 268,435,456 B aggregate RSS, 60 s; a stop is final
const Change = z.object({ family: z.string(), idea: z.string() });

// Who. One engineer holds the whole derivation and the code in one conversation. The reviewer is
// on another provider. The fence leaves out boundary.test.ts and the guard, and both commands
// restore them from the base: the work cannot edit what grades it.
const reviewer = seat('codex', 'gpt-6-sol', 'high');
const engineer = role({
  by: seat('claude', 'claude-opus-5-5', 'high'),
  max: usd(10),
  minutes: 90,
}).in(checkout(`${NG}/boundary.ts`, `${NG}/derived.test.ts`, `${NOTES}/`));

const { derive, implement, probe, replay, receipt } = steps({
  derive: engineer.judged(review('derivation-holds', reviewer)),
  implement: engineer.returns(Change),
  probe: command(`${GUARD} bun test ./${NG}/derived.test.ts`, { minutes: 2 })
    .needs('guard')
    .protect('oompa/geometry/'),
  replay: command(`${GUARD} bun test ./${NG}/boundary.test.ts`, { minutes: 2 })
    .needs('guard', 'replay')
    .protect(`${NG}/boundary.test.ts`, 'oompa/geometry/'),
  receipt: engineer.judged(review('preserved-geometry', reviewer)),
});

export default plan(async (x) => {
  // Earlier attempts (residual, capacity, timeout) travel with the work. Nothing here is blind.
  const derived = await x.phase('derive', () => derive({ reads: [x.learnings('all')] }));
  if (derived.t !== 'passed')
    return gap('The geometric conditions did not survive an independent re-derivation.', derived);

  // The tight loop: one conversation, continued. A first build and two repairs (the repo's
  // two-strikes rule), each tested in seconds by the host. The replay is not touched here.
  const trail: Readable[] = [];
  const loop = await x.phase('loop', async () => {
    let last: Held<unknown> = derived.value;
    for (const round of [1, 2, 3]) {
      const made = await implement({
        id: round,
        continues: last,
        on: last,
        reads: [derived.value, ...trail],
      });
      trail.push(made);
      if (made.t !== 'passed') break;
      last = made.value;
      const probed = await probe({ id: round, on: last, tests: made.value.out }); // the host writes the row: pass is keep, fail is reject; a rejected family is refused
      trail.push(probed);
      if (probed.t === 'passed') return { t: 'green' as const, at: last };
    }
    return { t: 'stuck' as const };
  });
  if (loop.t === 'stuck')
    return gap('No round passed the guarded probe. The replay was not spent.', ...trail);

  await x.review(
    'The one replay is about to be spent. Does the probe show by construction that the suite fits the caps, or only that small cases pass?'
  );

  const replayed = await x.phase('replay', () => replay({ on: loop.at }));
  if (replayed.t !== 'passed')
    return gap(
      'The single authorized replay did not pass. There is no second replay and no retry.',
      replayed,
      ...trail
    );

  const candidate = await x.phase('receipt', () =>
    receipt({ continues: loop.at, on: loop.at, reads: [derived.value, replayed.value] })
  );
  if (candidate.t !== 'passed')
    return gap(
      'The independent reviewer did not confirm preserved geometry behaviour.',
      candidate,
      replayed
    );

  const landed = await x.land('d2-boundary', candidate.value);
  if (landed.t !== 'passed')
    return gap('The candidate passed its replay and review but did not land.', landed, candidate);
  return candidate.value; // the contract's owner criterion is the G0 judgment and the hand-off to Product
});
