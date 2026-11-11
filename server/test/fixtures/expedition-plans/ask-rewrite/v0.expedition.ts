import { expedition } from 'expedition';

// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Version 0: a judged probe, an owner question and a review, all at once. The kernel e2e test
// rewrites it at the review to version 1, which asks none of them.

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
    probe: {
      by: 'worker',
      brief: `# Probe

Look once and write out.md.
`,
      judge: { check: 'test -s out.md' },
    },
  },
  plan: async ({ probe }, x) => {
    const [found] = await Promise.all([
      probe(),
      x.ask('Which segment first?'),
      x.checkin('Change course?'),
    ]);
    return found;
  },
});
