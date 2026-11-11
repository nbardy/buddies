// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// One required step. Unanswered, it is also the "pending call" plan the kill test uses.
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
  plan: async ({ probe }) => await probe(),
});
