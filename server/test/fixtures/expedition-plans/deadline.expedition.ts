import { check, expedition, need, role, seat, steps } from 'expedition';

// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// A judged step and an owner question in flight together, then a follow-up step: the kernel e2e
// test lets the deadline pass while the judge runs and the question is open.

const worker = role({ by: seat('claude', 'claude-sonnet-5-5', 'medium'), usd: 1, minutes: 10 });
const { probe, after } = steps({
  probe: worker
    .brief(`# Probe

Look once and write out.md.
`)
    .judged(check('test -s out.md')),
  after: worker.brief(`# After

Follow up on the probe for the segment the owner chose.
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
  plan: async (x) => {
    const [found, segment] = await Promise.all([probe(), x.ask('Which segment first?')]);
    const next = await after({ reads: [segment, need(found, 'The probe found nothing.')] });
    return need(next, 'No follow-up.');
  },
});
