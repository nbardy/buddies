import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER, buddyActor } from '../src/buddies/core';

// Regression (incident 2026-09-30 22:09): a throwaway backend booted on a COPY of the live Buddies
// DB with an agent CLI on PATH ended 10 'interrupted' runs, queued their failure notices and
// launched 5 real codex workers. A backend on a non-default store must start with Buddy execution
// disabled unless UNLEASHD_BUDDY_EXECUTION=1 (buddies/execution-gate.ts). The fake CLI writes a
// marker file when launched; the control boot (opt-in) proves the seeded store really would have
// launched it, so an absent marker is not an accident of the seed.

const SERVER_DIR = path.resolve(__dirname, '..');

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// A store with a request queued for a Buddy and a run `running` under an already-expired lease:
// the claim gate ends the latter as interrupted and queues its failure notice.
async function seedStore(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const core = await BuddiesCore.open(path.join(dir, 'buddies-v3.sqlite'));
  const workspace = await core.createWorkspace(OWNER, { name: 'Team', rootPath: dir });
  const buddy = await core.createBuddy(OWNER, {
    workspaceId: workspace.id,
    slug: 'lead',
    name: 'Lead',
    role: 'Lead role',
    manager: { kind: 'nobody' },
    provider: 'claude',
    key: 'lead',
  });
  const ask = (key: string) =>
    core.post(
      OWNER,
      { kind: 'direct', members: [OWNER, buddyActor(buddy.id)] },
      { kind: 'request', body: `Do the thing ${key}`, evidence: [], broadcast: false, key }
    );
  await ask('stale'); // its run is claimed below and left running under a 1 ms lease
  const claimed = await core.claimRun({ leaseMs: 1, chatDeadlineMs: 1, turnDeadlineMs: 1 });
  assert.equal(claimed?.run.status, 'running');
  await ask('queued'); // a request nobody has claimed yet
}

async function boot(name: string, optIn: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `copied-store-${name}-`));
  const marker = path.join(root, 'agent-launched');
  // PATH: node and a fake claude/codex only. Never a real agent CLI.
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const cli of ['claude', 'codex']) {
    const file = path.join(bin, cli);
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join(' ').slice(0, 200) + '\\n');\n`
    );
    fs.chmodSync(file, 0o755);
  }
  const home = path.join(root, 'home');
  const buddies = path.join(root, 'buddies');
  fs.mkdirSync(home, { recursive: true });
  await seedStore(buddies);
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      UNLEASHD_DATA_DIR: path.join(root, 'data'),
      BUDDIES_HOME: buddies,
      UNLEASHD_BUDDIES_DB: path.join(buddies, 'buddies-v3.sqlite'),
      UNLEASHD_HOST: '127.0.0.1',
      UNLEASHD_AUTH_TOKEN: '',
      PORT: String(await freePort()),
      NODE_ENV: 'test',
      ...(optIn ? { UNLEASHD_BUDDY_EXECUTION: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  backend.stdout.on('data', (c: Buffer) => (log += c.toString()));
  backend.stderr.on('data', (c: Buffer) => (log += c.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend never became ready:\n${log}`)), 60_000);
    const poll = setInterval(() => {
      if (log.includes('Initial load complete')) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 50);
    backend.once('exit', (code) => reject(new Error(`backend exited (${code}):\n${log}`)));
  });
  const stop = async () => {
    backend.kill('SIGKILL');
    if (backend.exitCode === null && backend.signalCode === null)
      await new Promise((resolve) => backend.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { marker, stop, log: () => log };
}

// The startup agent audit (`--version`, and a "Respond with only Yes" health probe) runs on every
// boot and touches no store; it is not Buddy execution. Everything else is a worker.
const workerLaunches = (marker: string) =>
  (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n') : []).filter(
    (line) => line && !line.includes('--version') && !line.includes('Respond with only Yes')
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a backend on a copied store launches no agent unless execution is opted in', async (t) => {
  const control = await boot('control', true);
  t.after(control.stop);
  const deadline = Date.now() + 30_000;
  while (workerLaunches(control.marker).length === 0 && Date.now() < deadline) await sleep(100);
  assert.ok(workerLaunches(control.marker).length > 0, `bait store never launched the fake CLI:\n${control.log()}`);

  const guarded = await boot('guarded', false);
  t.after(guarded.stop);
  await sleep(5_000);
  assert.match(guarded.log(), /Execution disabled/);
  assert.deepEqual(workerLaunches(guarded.marker), [], 'a copied store launched an agent');
});
