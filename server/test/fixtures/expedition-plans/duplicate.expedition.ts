// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Two calls under one key in one evaluation: the log could not tell them apart.
import { expedition, parallel, role, seat, steps } from 'expedition';

const { probe } = steps({
  probe: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 }).brief(
    `Do the work for probe.`
  ),
});

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
    const both = await x.phase('twice', () =>
      parallel([{ id: 'same' }, { id: 'same' }], (item) => probe({ id: item.id }))
    );
    return both[0];
  },
});
