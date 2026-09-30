import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EXITS_FILE, ErrorJournal, reportBackendExits } from '../src/observability';

// The records tools/watch-server.mjs appends; see its onExit.
const exit = (kind: string, state: string, code: number | null, signal: string | null) =>
  `${JSON.stringify({ at: '2026-09-30T14:49:58.982Z', kind, state, code, signal, uptimeMs: 123456, pid: 4321 })}\n`;

async function bootedJournal(directory: string): Promise<ErrorJournal> {
  const journal = new ErrorJournal({ directory });
  await journal.initialize();
  return journal;
}

test('each recorded backend crash is journaled once, across boots', async (t) => {
  // 2026-09-30: a SIGBUS during a drain reached only the terminal. Clean drains
  // and stops must stay out of the journal, and a crash must not be re-reported
  // by every later boot.
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unleashd-exits-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, EXITS_FILE);
  fs.writeFileSync(
    file,
    exit('drained', 'draining', 0, null) +
      exit('crash', 'draining', null, 'SIGBUS') +
      exit('stopped', 'stopping', null, 'SIGTERM')
  );

  assert.equal(await reportBackendExits(await bootedJournal(directory), directory), 1);
  const next = await bootedJournal(directory);
  assert.equal(await reportBackendExits(next, directory), 0);
  const [group] = await next.queryGroups();
  assert.equal(group?.component, 'backend-exit');
  assert.match(group?.message ?? '', /^Backend crashed \(signal SIGBUS\) while draining/);
  assert.equal(group?.count, 1);

  // A later SIGBUS joins the same group; a running-state exit code is its own.
  fs.appendFileSync(
    file,
    exit('crash', 'draining', null, 'SIGBUS') + exit('crash', 'running', 1, null)
  );
  assert.equal(await reportBackendExits(next, directory), 2);
  const groups = await next.queryGroups();
  assert.deepEqual(groups.map((g) => g.count).sort(), [1, 2]);
});
