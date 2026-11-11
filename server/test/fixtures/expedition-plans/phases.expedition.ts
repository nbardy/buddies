// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Two phases run concurrently and interleave their awaits; each call must keep its own phase.
// A phase stack shared across the process would mislabel the calls after the first await.
import { expedition, parallel, role, seat, steps } from 'expedition';

const { probe } = steps({
  probe: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 }).brief(
    `Do the work for probe.`
  ),
});
const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

export default expedition({
  contract: {
    goal: 'Probe.',
    leader: 'lead',
    repo: '~/git/x',
    budget: {
      usd: 10,
      hours: 1,
    },
    autoApply: {
      usd: 5,
    },
    pools: {
      claude: 2,
    },
    done: [
      {
        owner: 'Accept?',
      },
    ],
    rules: [],
  },
  plan: async (x) => {
    const [left] = await Promise.all([
      x.phase('left', async () => {
        await probe({ id: 'first' });
        return x.phase('inner', () => parallel(items, (item) => probe({ id: item.id })));
      }),
      x.phase('right', async () => {
        await probe({ id: 'first' });
        return parallel(items, (item) => probe({ id: item.id }));
      }),
    ]);
    return left[0];
  },
});
