import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DependenciesSchema } from '@unleashd/shared';
import express from 'express';
import { createDependencyChecks, registerDependencyRoutes } from '../src/providers/dependencies';

test('readiness requires a successful Yes, missing and hanging agents remain actionable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deps-test-'));
  const executable = async (name: string, body: string) =>
    fs.writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const checks = createDependencyChecks({ PATH: dir, HOME: dir, CLAUDECODE: '1' }, 1500);
  const app = express();
  registerDependencyRoutes(app, checks);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await checks.refresh();
  try {
    await executable('rustc', 'echo rustc');
    await executable('cargo', 'echo cargo');
    await executable('claude', '[ -z "$CLAUDECODE" ] || exit 1; echo Yes');
    await checks.refresh();
    let snapshot = DependenciesSchema.parse(await (await fetch(`${url}/api/dependencies`)).json());
    assert.deepEqual(
      snapshot.checks.map((c) => c.status),
      ['ready', 'ready', 'missing']
    );
    await executable('codex', 'echo Yes; exit 1');
    const first = checks.refresh();
    assert.equal(checks.refresh(), first, 'parallel refreshes share one probe');
    await first;
    assert.equal(
      checks.snapshot().checks[2].status,
      'failed',
      'Yes on a failed process is not ready'
    );
    await executable('codex', 'echo Yes');
    assert.equal((await fetch(`${url}/api/dependencies/check`, { method: 'POST' })).status, 202);
    await checks.refresh();
    await executable('claude', '/bin/sleep 10');
    await checks.refresh();
    snapshot = checks.snapshot();
    assert.equal(snapshot.checks[2].status, 'ready');
    assert.match(snapshot.checks[1].message, /no response within/i);
    await executable('claude', 'echo "Weekly limit reached" >&2; exit 1');
    await checks.refresh();
    assert.equal(checks.snapshot().checks[1].failure, 'quota');
    assert.match(checks.snapshot().checks[1].message, /Installed.*usage limit/);
    await executable('claude', 'echo yesterday');
    await checks.refresh();
    assert.equal(checks.snapshot().checks[1].status, 'failed', 'substring yes is not a response');
  } finally {
    checks.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
});
