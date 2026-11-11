// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
import { expedition } from 'expedition';

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
  steps: {},
  plan: async () => {
    throw new Error('boom from plan code');
  },
});
