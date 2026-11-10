// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Two phases run concurrently and interleave their awaits; each call must keep its own phase.
// A phase stack shared across the process would mislabel the calls after the first await.
import { parallel, plan, role, seat, steps } from 'expedition';

const { probe } = steps({ probe: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 }) });
const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

export default plan(async (x) => {
  const [left] = await Promise.all([
    x.phase('left', async () => {
      await probe({ id: 'first' });
      return x.phase('inner', () => parallel(items, (item) => probe({ item })));
    }),
    x.phase('right', async () => {
      await probe({ id: 'first' });
      return parallel(items, (item) => probe({ item }));
    }),
  ]);
  return left[0];
});
