import { expedition } from 'expedition';

// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// A judged step and an owner question in flight together, then a follow-up step: the kernel e2e
// test lets the deadline pass while the judge runs and the question is open.

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
    after: {
      by: 'worker',
      brief: `# After

Follow up on the probe for the segment the owner chose.
`,
    },
  },
  plan: async ({ probe, after }, x) => {
    const [found, segment] = await Promise.all([probe(), x.ask('Which segment first?')]);
    const next = await after({ reads: [segment, found] });
    return next;
  },
});
