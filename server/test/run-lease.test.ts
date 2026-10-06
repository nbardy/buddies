import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { NO_AUTO_INSTALL } from './fixtures/backend-env';

/**
 * A run's lease is its holder's heartbeat, separate from its deadline (decision:
 * agent_notes/2026-10-01_return-route-decision.md, "Successor 14:48Z"; Pattern: lease-heartbeat in
 * docs/patterns.md). Until then the lease WAS the 24 h deadline, so a run whose holder died stayed
 * `running` until the next boot swept every held run: 9.5 h overnight 2026-09-30→10-01, and 14 and
 * 10 orphaned runs at 12:34Z/14:09Z on 09-30. The boot sweep also ended runs another live backend
 * still held (a worktree backend shares ~/.buddies).
 *
 * Real boundary, isolated stores: actual backend processes (server.ts) on a temp HOME, sharing ONE
 * Buddies database the way a worktree backend shares the owner's, each with its own data dir. A
 * fake `claude` on a PATH with no real agent CLI. Leases, heartbeats and the idle timer are
 * shortened by env so the clocks are observable in seconds.
 */

const TOKEN = 'b8e4d1fa03c25769b8e4d1fa03c25769';
const LEASE_MS = 3_000;
const IDLE_MS = 15_000;

// Marker in the prompt picks the behaviour. Nothing on stdout after "one;": the only events the
// backend sees are agent-cli heartbeats, exactly a model thinking silently.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = process.env.FAKE_DIR;
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => main());
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const text = (t) => say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const mark = (name, value = '') => fs.writeFileSync(path.join(dir, name), String(value));
const until = (name) => new Promise((resolve) => { const t = setInterval(() => { if (fs.existsSync(path.join(dir, name))) { clearInterval(t); resolve(); } }, 25); });
async function main() {
  const scenario = (/SCENARIO:(\w+)/.exec(prompt) || [])[1];
  say({ type: 'system', subtype: 'init', session_id: 'fake-' + (scenario || 'other') + '-' + process.pid });
  if (!scenario) { text('ok'); say({ type: 'result', subtype: 'success' }); return; }
  mark(scenario + '.pgid', execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  text('one;');
  mark(scenario + '.midturn', process.pid);
  if (scenario === 'held' || scenario === 'stuck') return setInterval(() => {}, 1000);
  await until(scenario + '.go');
  text('done;');
  say({ type: 'result', subtype: 'success' });
}
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-lease-'));
const home = path.join(root, 'home');
const fakeDir = path.join(root, 'fake');
const bin = path.join(root, 'bin');
const workspaceDir = path.join(root, 'workspace');
const log: string[] = [];
const backends = new Map<string, ChildProcess>();

function startBackend(name: string, port: number, env: Record<string, string>): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOME: home,
      ...NO_AUTO_INSTALL,
      // Only the fakes and node: the Buddy scheduler must never reach a real agent CLI.
      PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      PORT: String(port),
      // Its own data dir (executions, records, MCP port), the SHARED Buddies database under HOME.
      UNLEASHD_DATA_DIR: path.join(root, `data-${name}`),
      // Non-default data dir: Buddy execution needs the opt-in (buddies/execution-gate.ts).
      UNLEASHD_BUDDY_EXECUTION: '1',
      UNLEASHD_AUTH_TOKEN: TOKEN,
      FAKE_DIR: fakeDir,
      NODE_ENV: 'test',
      CWV_BUDDY_RUN_LEASE_MS: String(LEASE_MS),
      CWV_TURN_PROVIDER_IDLE_TIMEOUT_MS: String(IDLE_MS),
      // A heartbeat every 250 ms once the provider is silent for 500 ms (production: 30 s / 25 s).
      AGENT_CLI_HEARTBEAT_CHECK_INTERVAL_MS: '250',
      AGENT_CLI_HEARTBEAT_SILENCE_THRESHOLD_MS: '500',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  backends.set(name, child);
  const record = (chunk: Buffer) =>
    log.push(
      ...chunk
        .toString()
        .split('\n')
        .map((l) => `[${name}] ${l}`)
    );
  child.stderr?.on('data', record);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} did not start: ${log.slice(-40).join('\n')}`)),
      60_000
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      record(chunk);
      if (chunk.toString().includes('Buddy runner started')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) =>
      reject(new Error(`${name} exited ${code}: ${log.slice(-40).join('\n')}`))
    );
  });
}

async function killBackend(name: string): Promise<void> {
  const child = backends.get(name);
  backends.delete(name);
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

function api(port: number) {
  return async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

async function eventually<T>(
  read: () => Promise<T> | T,
  ok: (value: T) => boolean,
  what: string,
  ms = 30_000
) {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${what}; last: ${JSON.stringify(last)}\n${log.slice(-60).join('\n')}`
  );
}

const exists = (name: string) => fs.existsSync(path.join(fakeDir, name));
const readFake = (name: string) => fs.readFileSync(path.join(fakeDir, name), 'utf8');
const killGroup = (scenario: string) => {
  if (!exists(`${scenario}.pgid`)) return;
  try {
    process.kill(-Number(readFake(`${scenario}.pgid`)), 'SIGKILL');
  } catch {}
};

type Http = ReturnType<typeof api>;
type RunRow = { id: string; status: string; errorCode?: string | null; error?: string | null };

async function workspace(http: Http, name: string) {
  const ws = await http('POST', '/api/buddies/workspaces', { name, rootPath: workspaceDir });
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  return ws.body.id as string;
}

async function hire(http: Http, ws: string, slug: string) {
  const buddy = await http('POST', '/api/buddies', {
    workspaceId: ws,
    slug,
    name: slug,
    role: 'test worker',
    provider: 'claude',
    key: `hire-${slug}`,
  });
  assert.equal(buddy.status, 201, JSON.stringify(buddy.body));
  return buddy.body.id as string;
}

async function ask(http: Http, buddyId: string, scenario: string) {
  const dm = await http('POST', `/api/buddies/${buddyId}/direct`);
  const posted = await http('POST', `/api/buddies/channels/${dm.body.channelId}/posts`, {
    kind: 'request',
    body: `Please work. SCENARIO:${scenario}`,
    key: `ask-${scenario}`,
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return (posted.body.post ?? posted.body) as { id: string };
}

async function runOf(http: Http, buddyId: string): Promise<RunRow | undefined> {
  const runs = await http('GET', `/api/buddies/runs?buddyId=${buddyId}`);
  return (runs.body.runs ?? runs.body).find(
    (run: { input: { kind: string } }) => run.input.kind === 'post'
  );
}

/** Watches a run for `ms`, failing the moment it is no longer running. */
async function staysRunning(http: Http, buddyId: string, ms: number, what: string) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const run = await runOf(http, buddyId);
    assert.equal(run?.status, 'running', `${what}: ${JSON.stringify(run)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

before(() => {
  for (const dir of [home, fakeDir, bin, workspaceDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
});

after(async () => {
  for (const name of [...backends.keys()]) await killBackend(name);
  for (const scenario of ['held', 'silent', 'stuck']) killGroup(scenario);
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  'a holder that dies while the backend stays up is cleared within the lease time',
  { timeout: 180_000 },
  async () => {
    const httpA = api(7551);
    const httpB = api(7552);
    await startBackend('A', 7551, {});
    const ws = await workspace(httpA, 'lease');
    const held = await hire(httpA, ws, 'held');
    const request = await ask(httpA, held, 'held');
    await eventually(() => exists('held.midturn'), Boolean, 'held mid-turn');

    // A second backend on the same Buddy store boots while A still drives the turn. Before the
    // lease was a heartbeat, its startup sweep ended every held run, A's live one included.
    await startBackend('B', 7552, {});
    await staysRunning(httpB, held, 2 * LEASE_MS, "A's live, renewing run survives B's boot");

    // A dies, provider and all, while B stays up: nobody renews A's lease and nobody restarts.
    await killBackend('A');
    killGroup('held');
    const diedAt = Date.now();
    const run = await eventually(
      () => runOf(httpB, held),
      (r) => r?.status !== 'running',
      "the dead holder's run to leave running",
      // The lease, plus B's 5 s claim backstop, plus slack. A 24 h lease never gets here.
      LEASE_MS + 10_000
    );
    assert.ok(Date.now() - diedAt < LEASE_MS + 10_000);
    assert.equal(run?.status, 'failed', JSON.stringify(run));
    assert.equal(run?.errorCode, 'lease_expired', JSON.stringify(run));
    // Cleared like any failed settle: the request stops awaiting, so its sender is not left waiting.
    const thread = await httpB('GET', `/api/buddies/posts/${request.id}/thread`);
    assert.equal(thread.body.root.request.state, 'failed', JSON.stringify(thread.body.root));
    await killBackend('B');
  }
);

test(
  'a heartbeating silent turn outlives its lease; a turn with no provider progress still dies of the idle timer',
  { timeout: 180_000 },
  async () => {
    const http = api(7553);
    await startBackend('C', 7553, {});
    const ws = await workspace(http, 'clocks');
    const silent = await hire(http, ws, 'silent');
    const stuck = await hire(http, ws, 'stuck');
    await ask(http, silent, 'silent');
    await ask(http, stuck, 'stuck');
    await eventually(
      () => exists('silent.midturn') && exists('stuck.midturn'),
      Boolean,
      'both mid-turn'
    );
    const startedAt = Date.now();

    // Three leases of provider silence: only agent-cli heartbeats reach the backend, and they
    // renew the lease. Still well inside the provider-idle budget.
    await staysRunning(http, silent, 3 * LEASE_MS, 'a silent, heartbeating turn');
    fs.writeFileSync(path.join(fakeDir, 'silent.go'), '');
    const done = await eventually(
      () => runOf(http, silent),
      (r) => r?.status !== 'running',
      'silent run settled'
    );
    assert.equal(done?.status, 'complete', JSON.stringify(done));

    // The same heartbeats keep `stuck`'s lease alive, but heartbeats are not provider progress:
    // the 60-min idle timer (IDLE_MS here) still ends it, as its own cause, not a lease expiry.
    const killed = await eventually(
      () => runOf(http, stuck),
      (r) => r?.status !== 'running',
      'stuck run ended by the idle timer',
      IDLE_MS + 20_000
    );
    assert.ok(Date.now() - startedAt >= IDLE_MS - 1_000, 'not before the idle budget');
    assert.equal(killed?.status, 'failed', JSON.stringify(killed));
    assert.equal(killed?.errorCode, 'execution_failed', JSON.stringify(killed));
    assert.match(String(killed?.error), /no provider event/, JSON.stringify(killed));
  }
);
