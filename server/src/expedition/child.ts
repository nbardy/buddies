import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { labelled } from '../observability/event-loop-stall';
import type { Message } from './author';

export const AUTHOR = path.join(__dirname, 'author.ts');
// Pattern: capability-grants (docs/patterns.md#capability-grants)
// Copy only the source: tsx's case probes must never read the owner's adjacent files.
export function runPlan(
  file: string,
  receive: (m: Message, reply: (result: unknown) => void) => void
) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-plan-')));
  const source = path.join(dir, 'plan.expedition.ts');
  fs.copyFileSync(file, source);
  const loader = require.resolve('tsx');
  const store = `${fs.realpathSync(loader).split(`${path.sep}.pnpm${path.sep}`)[0]}/.pnpm`;
  const ancestors = (p: string): string[] =>
    path.dirname(p) === p
      ? []
      : [path.join(path.dirname(p), 'package.json'), ...ancestors(path.dirname(p))];
  const flip = (p: string) =>
    [...p].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
  const roots = [
    dir,
    flip(dir),
    __dirname,
    flip(__dirname),
    store,
    path.resolve(__dirname, '../../../shared/dist'),
    path.resolve(__dirname, '../../node_modules'),
    ...ancestors(dir),
    ...ancestors(__dirname),
  ];
  const child = spawn(
    process.execPath,
    [
      '--permission',
      '--allow-worker',
      ...roots.map((p) => `--allow-fs-read=${p}`),
      '--disable-warning=SecurityWarning',
      '--import',
      loader,
      path.join(__dirname, 'child.mjs'),
      source,
      AUTHOR,
    ],
    {
      cwd: dir,
      env: {
        TSX_DISABLE_CACHE: '1',
        TSX_TSCONFIG_PATH: path.join(__dirname, 'plan-tsconfig.json'),
      },
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }
  );
  let stderr = '',
    ended = false;
  child.stderr!.on('data', (b) => {
    stderr = (stderr + b).slice(-4000);
  });
  child.on('message', (m: Message) => {
    if (ended) return;
    if (m.t === 'waiting') clearTimeout(timer);
    receive(m, (result) => {
      if (child.connected) child.send({ seq: 'seq' in m ? m.seq : 0, result });
    });
    if (m.t === 'end' || m.t === 'error') kill();
  });
  const kill = () => {
    ended = true;
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {}
  };
  const closed = new Promise<void>((resolve) =>
    child.on('close', () => {
      if (!ended) receive({ t: 'error', why: `Plan exited: ${stderr}` }, () => {});
      kill();
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    })
  );
  const timer = setTimeout(
    labelled('expedition-plan-limit', () => {
      receive({ t: 'error', why: 'Plan exceeded execution time without waiting' }, () => {});
      kill();
    }),
    30_000
  );
  child.on('message', () => timer.unref());
  void closed.then(() => clearTimeout(timer));
  return {
    kill: async () => {
      kill();
      await closed;
    },
    closed,
  };
}
