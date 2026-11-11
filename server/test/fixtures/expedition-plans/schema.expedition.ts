import { command, expedition, role, seat, steps } from 'expedition';
// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// The host's answer must pass the step's schema before plan code sees it. `echo` reports what
// the plan saw, so the test reads it off the wire.
import { z } from 'zod';

const { count, echo } = steps({
  count: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 })
    .returns(z.object({ n: z.number() }))
    .brief(`Do the work for count.`),
  echo: command((item: object) => `echo ${JSON.stringify(item)}`, { minutes: 1 }),
});

export default expedition({
  contract: {
    goal: 'Probe.',
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
        owner: 'Accept?',
      },
    ],
    rules: [],
  },
  plan: async () => {
    const seen = await count();
    const result = await echo({
      item:
        seen.t === 'passed'
          ? { t: seen.t, n: seen.out.n }
          : { t: seen.t, why: seen.t === 'errored' ? seen.why : '' },
    });
    if (result.t !== 'passed') throw new Error('echo did not pass');
    return result;
  },
});
