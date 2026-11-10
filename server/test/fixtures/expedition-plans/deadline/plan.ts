import { check, need, plan, role, seat, steps } from 'expedition';
// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// A judged step and an owner question in flight together, then a follow-up step: the kernel e2e
// test lets the deadline pass while the judge runs and the question is open.

const worker = role({ by: seat('claude', 'claude-sonnet-5-5', 'medium'), usd: 1, minutes: 10 });
const { probe, after } = steps({
  probe: worker.judged(check('test -s out.md')),
  after: worker,
});

export default plan(async (x) => {
  const [found, segment] = await Promise.all([probe(), x.ask('Which segment first?')]);
  const next = await after({ reads: [segment, need(found, 'The probe found nothing.')] });
  return need(next, 'No follow-up.');
});
