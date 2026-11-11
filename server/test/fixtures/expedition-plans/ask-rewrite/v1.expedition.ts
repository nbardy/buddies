import { expedition } from 'expedition';

// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Version 1: a different step; version 0's probe and question are no longer asked.

export default expedition({
  contract: {
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
        owner: 'Is the follow-up good?',
      },
    ],
    rules: ['Stay inside the repo.'],
    goal: 'Probe one thing, ask the owner which segment comes first, then follow up.',
  },
  agents: { worker: { use: 'claude:claude-sonnet-5-5:medium', usd: 1, minutes: 10 } },
  steps: {
    scan: {
      by: 'worker',
      brief: `# Scan

Scan the repo once.
`,
    },
  },
  plan: async ({ scan }) => await scan(),
});
