// @ts-nocheck: `expedition` resolves only inside the plan runner (runner-child.mjs), not in server typecheck.
// Tries what the plan process must not do and reports each attempt's error code in a call's item.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { need, plan, role, seat, steps } from 'expedition';

const { probe } = steps({ probe: role({ by: seat('claude', 'm', 'low'), usd: 1, minutes: 5 }) });
const attempt = (act: () => unknown): string => {
  try {
    act();
    return 'allowed';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

export default plan(async () => {
  const item = {
    brief: readFileSync('briefs/probe.md', 'utf8').trim(),
    // The test puts secret.txt beside the plan folder.
    sibling: attempt(() => readFileSync('../secret.txt')),
    etcHosts: attempt(() => readFileSync('/etc/hosts')),
    write: attempt(() => writeFileSync('scribble.txt', 'x')),
    spawn: attempt(() => execFileSync('/bin/echo', ['hi'])),
  };
  return need(await probe({ item }), 'probe');
});
