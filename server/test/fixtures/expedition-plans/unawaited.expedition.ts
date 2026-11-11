// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// A plan that forgets two awaits: a step and a review are issued and never awaited, so the plan
// returns its candidate while both are still unanswered. The library must end it as `threw`.
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
  steps: {
    probe: {
      by: 'claude:claude-sonnet-5-5:low',
      usd: 1,
      minutes: 5,
      brief: `Do the work for probe.`,
    },
  },
  plan: async ({ probe }, x) => {
    probe.try({ id: 'forgotten' });
    x.checkin('Was the forgotten probe any good?');
    return await probe.try({ id: 'kept' });
  },
});
