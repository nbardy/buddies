// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// A plan that forgets two awaits: a step and a review are issued and never awaited, so the plan
// returns its candidate while both are still unanswered. The library must end it as `threw`.
import { plan, role, seat, steps } from 'expedition';

const { probe } = steps({ probe: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 }) });

export default plan(async (x) => {
  probe({ id: 'forgotten' });
  x.review('Was the forgotten probe any good?');
  return await probe({ id: 'kept' });
});
