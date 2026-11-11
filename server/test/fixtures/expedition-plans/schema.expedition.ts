import { expedition, step } from 'expedition';
// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// The host's answer must pass the step's schema before plan code sees it. `echo` reports what
// the plan saw, so the test reads it off the wire.
import { z } from 'zod';

export default expedition({
  contract: {
    goal: 'Probe.',
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
        owner: 'Accept?',
      },
    ],
    rules: [],
  },
  agents: {},
  steps: {
    count: {
      by: 'claude:claude-sonnet-5-5:low',
      usd: 1,
      minutes: 5,
      returns: z.object({ n: z.number() }),
      brief: `Do the work for count.`,
    },
    echo: step({
      run: (item) =>
        `echo ${JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id')))}`,
      minutes: 1,
      item: z.object({ id: z.string() }).passthrough(),
    }),
  },
  plan: async ({ count, echo }) => {
    const seen = await count.try();
    const result = await echo.try(
      seen.t === 'passed'
        ? { id: 'none', t: seen.t, n: seen.out.n }
        : { id: 'none', t: seen.t, why: seen.t === 'errored' ? seen.why : '' }
    );
    if (result.t !== 'passed') throw new Error('echo did not pass');
    return result;
  },
});
