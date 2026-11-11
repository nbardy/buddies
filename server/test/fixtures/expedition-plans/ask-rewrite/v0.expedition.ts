import { check, expedition, need, role, seat, steps } from 'expedition';

// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Version 0: a judged probe, an owner question and a review, all at once. The kernel e2e test
// rewrites it at the review to version 1, which asks none of them.

const worker = role({ by: seat('claude', 'claude-sonnet-5-5', 'medium'), usd: 1, minutes: 10 });
const { probe } = steps({
  probe: worker
    .brief(`# Probe

Look once and write out.md.
`)
    .judged(check('test -s out.md')),
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
  plan: async (x) => {
    const [found] = await Promise.all([
      probe(),
      x.ask('Which segment first?'),
      x.review('Change course?'),
    ]);
    return need(found, 'The probe found nothing.');
  },
});
