import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NO_AUTO_INSTALL } from './fixtures/backend-env';
import { freePortSync } from './free-port';

// Fix-guard (2026-11-03): the Buddy Oompa host was retired, but the owner's data dir still holds
// its journals: `oompa-executions/<run>/` (owner.json kind 'oompa', phase, config, pid) and, should
// one ever have landed there, a `kind: 'oompa'` journal under `executions/`. A backend without the
// host must boot past adoption, report the stray journal once, and delete or kill nothing: the
// files are the owner's record of past runs. Real backend, temp HOME and stores, no agent CLI on
// PATH; execution is opted in only so the boot scan and adoption actually run over the journals.

function oompaJournal(dir: string): Record<string, string> {
  const files: Record<string, string> = {
    'owner.json': JSON.stringify({
      version: 1,
      kind: 'oompa',
      id: path.basename(dir),
      key: 'k',
      launchHash: 'h',
      workspacePath: dir,
      configPath: path.join(dir, 'config.json'),
      validators: {},
      grant: { token: 'retired-token', role: 'worker', expiresAt: Date.now() + 3_600_000 },
    }),
    'phase.json': JSON.stringify({ t: 'running' }),
    'config.json': JSON.stringify({ task_backend: { type: 'buddies' } }),
    pid: '999999', // a pid that is not alive: the run's wrapper is long gone
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return files;
}

test('a backend without the Oompa host boots over old Oompa journals and leaves them alone', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-oompa-boot-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const buddies = path.join(root, 'buddies');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(buddies, { recursive: true });
  const hostRun = path.join(data, 'oompa-executions', 'run-1');
  const stray = path.join(data, 'executions', 'stray-oompa');
  const journals = { [hostRun]: oompaJournal(hostRun), [stray]: oompaJournal(stray) };

  const port = freePortSync();
  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      HOME: home,
      ...NO_AUTO_INSTALL,
      PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      UNLEASHD_DATA_DIR: data,
      BUDDIES_HOME: buddies,
      UNLEASHD_BUDDIES_DB: path.join(buddies, 'buddies-v3.sqlite'),
      UNLEASHD_BUDDY_EXECUTION: '1',
      UNLEASHD_HOST: '127.0.0.1',
      UNLEASHD_AUTH_TOKEN: '',
      PORT: String(port),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  backend.stdout.on('data', (c: Buffer) => {
    log += c.toString();
  });
  backend.stderr.on('data', (c: Buffer) => {
    log += c.toString();
  });
  t.after(async () => {
    backend.kill('SIGKILL');
    if (backend.exitCode === null && backend.signalCode === null)
      await new Promise((resolve) => backend.once('exit', resolve));
    // The backend's Buddy MCP relay is detached by design and outlives the SIGKILL; it was still
    // writing its state file under `data` while this removed the tree (ENOTEMPTY, 1 run in 3 at
    // load ~40, 2026-11-11). Stop it, and retry the removal as the other backend tests do.
    const relayState = path.join(data, 'buddy-mcp.json');
    if (fs.existsSync(relayState)) {
      try {
        process.kill(JSON.parse(fs.readFileSync(relayState, 'utf8')).pid, 'SIGTERM');
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`backend never became ready:\n${log}`)),
      60_000
    );
    const poll = setInterval(() => {
      if (log.includes('Initial load complete')) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 50);
    backend.once('exit', (code) => reject(new Error(`backend exited (${code}):\n${log}`)));
  });

  const response = await fetch(`http://127.0.0.1:${port}/api/conversations`);
  assert.ok(response.status < 500, `backend answered ${response.status}`);
  assert.equal(backend.exitCode, null, `backend died after boot:\n${log}`);
  const reports = log
    .split('\n')
    .filter((line) => line.includes('retired oompa execution journal'));
  assert.deepEqual(reports.length, 1, log);
  assert.match(reports[0], /stray-oompa/);
  for (const [dir, files] of Object.entries(journals))
    for (const [name, body] of Object.entries(files))
      assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), body, `${dir}/${name} changed`);
});
