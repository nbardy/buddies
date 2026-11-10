// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Two calls under one key in one evaluation: the log could not tell them apart.
import { parallel, plan, role, seat, steps } from 'expedition';

const { probe } = steps({ probe: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 }) });

export default plan(async (x) => {
  const both = await x.phase('twice', () =>
    parallel([{ id: 'same' }, { id: 'same' }], (item) => probe({ item }))
  );
  return both[0];
});
