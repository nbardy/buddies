// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Two phases run concurrently and interleave their awaits; each call must keep its own phase.
// A phase stack shared across the process would mislabel the calls after the first await.
import { expedition } from 'expedition';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

export default expedition({
  contract: {
    goal: 'Probe.',
    leader: 'buddy:lead',
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
  agents: {},
  steps: {
    probe: {
      by: 'claude:claude-sonnet-5-5:low',
      usd: 1,
      minutes: 5,
      brief: `Do the work for probe.`,
    },
  },
  plan: async ({ probe }, x) => {
    const [left] = await Promise.all([
      x.phase('left', async () => {
        await probe.try({ id: 'first' });
        return x.phase('inner', () => Promise.all(items.map((item) => probe.try({ id: item.id }))));
      }),
      x.phase('right', async () => {
        await probe.try({ id: 'first' });
        return Promise.all(items.map((item) => probe.try({ id: item.id })));
      }),
    ]);
    return left[0];
  },
});
