import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { trustSpawnedWrapper } from '@nbardy/agent-cli';
import type { BuddiesCore } from '@unleashd/buddies-core';
import { createGrants } from '../src/buddies/grants';
import { createOompaHost } from '../src/buddies/oompa';
import { tempDir } from './fixtures/temp';

// Regression guard (2026-10-23): `timer oompa-poll` was the #1 event-loop stall (145 stalls, 35 s
// per 30 min). The 1 s tick ran sync refresh() over every run ever found, ended ones included:
// existsSync / readdirSync / readFileSync per run per child, plus a sync `ps` for reused pids.
// A tick over one live idle run and several ended runs must make NO sync fs or spawn call.
test('oompa poll tick performs no sync fs or spawn', async () => {
  const root = tempDir('oompa-poll-');
  const now = Date.now();
  const owner = (id: string) => ({
    version: 1,
    kind: 'oompa',
    id,
    key: id,
    launchHash: id,
    workspacePath: root,
    configPath: path.join(root, 'config.json'),
    validators: {},
    grant: {
      token: `tok-${id}`,
      expiresAt: now + 3_600_000,
      role: 'worker',
      buddyId: 'b',
      workspaceId: 'w',
      runId: null,
      subscribes: {},
      hooks: {},
      oompa: { executionId: id, taskIds: [] },
    },
  });
  const journal = (id: string, phase: unknown) => {
    const dir = path.join(root, id);
    fs.mkdirSync(path.join(dir, 'continuations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner(id)));
    fs.writeFileSync(path.join(dir, 'phase.json'), JSON.stringify(phase));
    return dir;
  };
  for (let i = 0; i < 5; i++) {
    const dir = journal(`ended-${i}`, { t: 'ended', outcome: { t: 'complete', text: 'done' } });
    // A pid that is alive but not ours: the case that re-ran `ps` every tick.
    fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  }
  const host = path.join(root, 'live');
  const liveDir = journal('live', { t: 'running' });
  // The real wrapper's command line names its dir; verifyExecutions keeps only such identities.
  const sleeper = spawn('/bin/sh', ['-c', 'sleep 600; :', liveDir], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(liveDir, 'pid'), String(sleeper.pid));
  trustSpawnedWrapper(liveDir, sleeper.pid!);

  const oompa = createOompaHost({
    core: {} as BuddiesCore,
    grants: createGrants({ ttlMs: 60_000 }),
    url: () => 'http://127.0.0.1:1/mcp',
    root,
    executable: host,
  });
  const names = ['existsSync', 'readFileSync', 'readdirSync', 'statSync', 'writeFileSync'] as const;
  const realFs = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const realCp = {
    execFileSync: childProcess.execFileSync,
    execSync: childProcess.execSync,
    spawnSync: childProcess.spawnSync,
  };
  const forbid = () => {
    throw new Error('synchronous fs or spawn on the oompa poll path');
  };
  try {
    Object.assign(fs, Object.fromEntries(names.map((n) => [n, forbid])));
    Object.assign(childProcess, { execFileSync: forbid, execSync: forbid, spawnSync: forbid });
    syncBuiltinESMExports();
    await oompa.tick();
    await oompa.tick();
  } finally {
    Object.assign(fs, realFs);
    Object.assign(childProcess, realCp);
    syncBuiltinESMExports();
    oompa.close();
    process.kill(-sleeper.pid!, 'SIGKILL');
  }
});
