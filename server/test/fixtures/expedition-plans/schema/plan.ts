import { command, plan, role, seat, steps } from 'expedition';
// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// The host's answer must pass the step's schema before plan code sees it. `echo` reports what
// the plan saw, so the test reads it off the wire.
import { z } from 'zod';

const { count, echo } = steps({
  count: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 }).returns(
    z.object({ n: z.number() })
  ),
  echo: command('true', { minutes: 1 }),
});

export default plan(async () => {
  const seen = await count();
  const result = await echo({
    item:
      seen.t === 'passed'
        ? { t: seen.t, n: seen.out.n }
        : { t: seen.t, why: seen.t === 'errored' ? seen.why : '' },
  });
  if (result.t !== 'passed') throw new Error('echo did not pass');
  return result;
});
