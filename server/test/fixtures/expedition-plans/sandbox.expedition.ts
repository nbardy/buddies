// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Tries what the plan process must not do and reports each attempt's error code in a call's item.
import { expedition, step } from 'expedition';
import { z } from 'zod';

const { readFileSync, writeFileSync } = process.getBuiltinModule('node:fs');
const { execFileSync } = process.getBuiltinModule('node:child_process');

const attempt = (act: () => unknown): string => {
  try {
    act();
    return 'allowed';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

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
    probe: step({
      by: 'claude:claude-sonnet-5-5:low',
      usd: 1,
      minutes: 5,
      brief: (item) =>
        JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id'))),
      item: z.object({ id: z.string() }).passthrough(),
    }),
  },
  plan: async ({ probe }) => {
    const item = {
      id: 'none',
      own: readFileSync(process.argv[2], 'utf8').includes('export default expedition'),
      // The test puts secret.txt beside the plan folder.
      sibling: attempt(() => readFileSync('secret.txt')),
      etcHosts: attempt(() => readFileSync('/etc/hosts')),
      write: attempt(() => writeFileSync('scribble.txt', 'x')),
      spawn: attempt(() => execFileSync('/bin/echo', ['hi'])),
    };
    return await probe(item);
  },
});
