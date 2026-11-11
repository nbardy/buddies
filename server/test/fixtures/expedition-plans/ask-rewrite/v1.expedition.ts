import { expedition, need, role, seat, steps } from 'expedition';

// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Version 1: a different step; version 0's probe and question are no longer asked.

const worker = role({ by: seat('claude', 'claude-sonnet-5-5', 'medium'), usd: 1, minutes: 10 });
const { scan } = steps({
  scan: worker.brief(`# Scan

Scan the repo once.
`),
});

export default expedition({
  contract: {
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
        owner: 'Is the follow-up good?',
      },
    ],
    rules: ['Stay inside the repo.'],
    goal: 'Probe one thing, ask the owner which segment comes first, then follow up.',
  },
  plan: async () => need(await scan(), 'The scan found nothing.'),
});
