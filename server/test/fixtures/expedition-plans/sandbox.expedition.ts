// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Tries what the plan process must not do and reports each attempt's error code in a call's item.
import { expedition, need, role, seat, steps } from 'expedition';

const { readFileSync, writeFileSync } = process.getBuiltinModule('node:fs');
const { execFileSync } = process.getBuiltinModule('node:child_process');
const { probe } = steps({
  probe: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 }).brief((item: object) =>
    JSON.stringify(item)
  ),
});
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
    const item = {
      own: readFileSync(process.argv[2], 'utf8').includes('export default expedition'),
      // The test puts secret.txt beside the plan folder.
      sibling: attempt(() => readFileSync('secret.txt')),
      etcHosts: attempt(() => readFileSync('/etc/hosts')),
      write: attempt(() => writeFileSync('scribble.txt', 'x')),
      spawn: attempt(() => execFileSync('/bin/echo', ['hi'])),
    };
    return need(await probe({ item }), 'probe');
  },
});
