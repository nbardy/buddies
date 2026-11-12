import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { TurnCapabilities } from '@nbardy/agent-cli';
import { WS_PATH, decodeRows } from '@unleashd/shared';
import { WebSocket } from 'ws';
import { priceUsd } from '../src/providers/pricing';
import { type RunTurnOutcome, type RunTurnRequest, turnUsage } from '../src/turns/run-turn';
import { NO_AUTO_INSTALL } from './fixtures/backend-env';
import { freePortSync } from './free-port';

// Bugs caught: progress mistaken for the answer; request replay launches twice; adoption loses
// the caller/capabilities/deadline; missing token classes become zero; timeout becomes user_stop.
// Only the provider is fake. All stores, boot adoption, journals, policies, argv and WS are real.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-turn-'));
const home = path.join(root, 'home');
const bin = path.join(root, 'bin');
const fake = path.join(root, 'fake');
const cwd = path.join(root, 'workspace');
const port = freePortSync();
const data = path.join(root, 'data');
const auth = 'test-run-turn-isolated-auth';
const caps: TurnCapabilities = {
  files: { t: 'read', roots: [cwd] },
  web: 'off',
  instructions: 'none',
  agents: 'off',
  schedule: 'off',
  mcp: 'none',
};
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const codex = path.basename(process.argv[1]) === 'codex';
let prompt = '';
process.stdin.on('data', d => prompt += d); process.stdin.on('end', main);
const say = o => process.stdout.write(JSON.stringify(o) + '\n');
const mark = (name, v) => fs.writeFileSync(path.join(dir, name), v);
async function main() {
  // Let the module initialize its constants before the Codex path runs.
  await Promise.resolve();
  const key = /TAG:(\w+)/.exec(prompt)?.[1];
  if (!key) { say({type:'result',subtype:'success',result:'ok'}); return; }
  fs.appendFileSync(path.join(dir, 'spawns'), key + ' ' + process.pid + '\n');
  mark(key + '.argv', JSON.stringify(process.argv.slice(2)));
  const out = text => say(codex ? {type:'item.completed',item:{type:'agent_message',text}} : {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
  say(codex ? {type:'thread.started',thread_id:'fake-'+key} : {type:'system',subtype:'init',session_id:'fake-'+key});
  out('progress;');
  // Two real request measurements: the result's aggregate must NOT be counted a third time.
  if (!codex) for (const n of [10, 20]) say({type:'assistant',message:{content:[],usage:{input_tokens:n,output_tokens:n/5,cache_read_input_tokens:5,cache_creation_input_tokens:0}}});
  mark(key + '.midturn', String(process.pid));
  await new Promise(resolve => { const timer = setInterval(() => {
    if (fs.existsSync(path.join(dir, key + '.go'))) { clearInterval(timer); resolve(); }
  }, 10); });
  out('final answer');
  say(codex ? {type:'turn.completed',usage:{input_tokens:999,output_tokens:999}} : {type:'result',subtype:'success',result:'final answer',usage:{input_tokens:30,output_tokens:6,cache_read_input_tokens:10,cache_creation_input_tokens:0}});
}
`;
let backend: ChildProcess | undefined;
let serial = 0;
const pending = new Map<number, { resolve(o: RunTurnOutcome): void; reject(e: Error): void }>();
const logs: string[] = [];
function mark(name: string) {
  fs.writeFileSync(path.join(fake, name), '');
}
const exists = (name: string) => fs.existsSync(path.join(fake, name));
const argv = (key: string): string[] =>
  JSON.parse(fs.readFileSync(path.join(fake, `${key}.argv`), 'utf8'));
const count = (key: string) =>
  fs.existsSync(path.join(fake, 'spawns'))
    ? fs
        .readFileSync(path.join(fake, 'spawns'), 'utf8')
        .split('\n')
        .filter((l) => l.startsWith(`${key} `)).length
    : 0;
async function eventually(f: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`${label}: ${logs.slice(-20).join('\n')}`);
}
async function start(): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/run-turn-backend.ts'], {
    cwd: path.join(__dirname, '..'),
    detached: true,
    env: {
      ...process.env,
      ...NO_AUTO_INSTALL,
      HOME: home,
      PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      PORT: String(port),
      UNLEASHD_DATA_DIR: data,
      UNLEASHD_BUDDIES_DB: path.join(root, 'buddies.sqlite'),
      BUDDIES_HOME: path.join(root, 'buddies'),
      UNLEASHD_CHECKOUT_ROOT: cwd,
      UNLEASHD_BUDDY_EXECUTION: '1',
      UNLEASHD_AUTH_TOKEN: auth,
      FAKE_DIR: fake,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  backend = child;
  child.on(
    'message',
    (m: { id: number; outcome: RunTurnOutcome; error?: { name: string; message: string } }) => {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
      else p?.resolve(m.outcome);
    }
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs.slice(-30).join('\n'))), 60_000);
    child.stdout?.on('data', (b: Buffer) => {
      logs.push(b.toString());
      if (b.toString().includes('Initial load complete')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on('data', (b: Buffer) => logs.push(b.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Backend exited ${code}: ${logs.slice(-30).join('\n')}`));
    });
  });
}
async function kill(): Promise<void> {
  const child = backend;
  backend = undefined;
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  for (const p of pending.values()) p.reject(new Error('Backend killed'));
  pending.clear();
}
function call(request: RunTurnRequest): Promise<RunTurnOutcome> {
  return rpc({ request });
}
function rpc(body: unknown): Promise<RunTurnOutcome> {
  const id = ++serial;
  const promise = new Promise<RunTurnOutcome>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    backend!.send({ ...(body as object), id });
  });
  void promise.catch(() => {}); // a failing assertion must still let teardown reject outstanding calls
  return promise;
}
function request(key: string, extra: Partial<RunTurnRequest> = {}): RunTurnRequest {
  return {
    key,
    provider: 'claude',
    model: 'claude-haiku-5-5',
    effort: 'low',
    cwd,
    prompt: `TAG:${key}`,
    maxRuntimeMs: 60_000,
    title: `Visible ${key}`,
    ...extra,
  };
}
async function rows() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
    headers: { authorization: `Bearer ${auth}` },
  });
  try {
    return await new Promise<ReturnType<typeof decodeRows>>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('message', (b) => {
        const m = JSON.parse(b.toString());
        if (m.type === 'hello') resolve(decodeRows(m));
      });
    });
  } finally {
    socket.close();
  }
}

async function ordinaryChat(r: RunTurnRequest): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
    headers: { authorization: `Bearer ${auth}` },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const commandId = randomUUID();
      socket.on('error', reject);
      socket.on('open', () =>
        socket.send(
          JSON.stringify({
            type: 'create_conversation',
            commandId,
            conversationId: randomUUID(),
            workingDirectory: cwd,
            initialMessage: r.prompt,
            kind: { t: 'chat' },
            config: {
              provider: r.provider,
              model: { mode: 'explicit', modelId: r.model },
              reasoning: { mode: 'explicit', effort: r.effort },
            },
          })
        )
      );
      socket.on('message', (b) => {
        const m = JSON.parse(b.toString());
        if (m.type === 'ack' && m.commandId === commandId)
          m.result?.t === 'created' ? resolve() : reject(new Error(b.toString()));
      });
    });
  } finally {
    socket.close();
  }
}
before(async () => {
  for (const dir of [home, bin, fake, cwd]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ['claude', 'codex'])
    fs.writeFileSync(path.join(bin, name), FAKE, { mode: 0o755 });
  await start();
});
after(async () => {
  await kill();
  // Kill only processes whose fake harness recorded their pid in this fixture's private root.
  for (const name of fs.readdirSync(fake).filter((n) => n.endsWith('.midturn'))) {
    const pid = Number(fs.readFileSync(path.join(fake, name), 'utf8'));
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 });
});

test('complete returns final, per-request usage, a listed title, and one turn for every replay', {
  timeout: 90_000,
}, async () => {
  const r = request('complete');
  const a = call(r),
    b = call({ ...r });
  await eventually(() => exists('complete.midturn'), 'provider started');
  const listed = await rows();
  assert.ok(
    listed.some((row) => row.label === r.title && row.kind.t === 'chat'),
    JSON.stringify(listed)
  );
  assert.ok(
    argv(r.key).includes('--dangerously-skip-permissions'),
    'absent capabilities preserve chat argv'
  );
  mark('complete.go');
  const [one, two] = await Promise.all([a, b]);
  assert.deepEqual(one, two);
  assert.equal(one.t, 'complete');
  if (one.t === 'complete') assert.equal(one.text, 'final answer');
  assert.deepEqual(one.usage, {
    t: 'reported',
    tokens: { input: 30, output: 6, cacheRead: 10, cacheWrite: 0, cacheWrite1H: 0 },
  });
  if (one.usage.t === 'reported')
    assert.deepEqual(priceUsd('claude', r.model, { ...one.usage.tokens, reportedCostUsd: 0 }), {
      t: 'priced',
      usd: 0.0000061,
    });
  assert.deepEqual(await call(r), one);
  assert.equal(count(r.key), 1);
  const chat = request('ordinary');
  mark('ordinary.go');
  await ordinaryChat(chat);
  await eventually(() => exists('ordinary.argv'), 'ordinary chat argv');
  const normalize = (args: string[]) =>
    args.map((a) => (/^[a-f0-9-]{36}$/.test(a) ? '<session>' : a));
  assert.deepEqual(
    normalize(argv(r.key)),
    normalize(argv(chat.key)),
    'no capabilities: identical to the existing chat invocation'
  );
  await assert.rejects(call({ ...r, prompt: 'different' }), { name: 'TurnKeyConflictError' });
  await kill();
  await start();
  assert.deepEqual(
    await call(r),
    one,
    'settled outcome survives journal removal and backend restart'
  );
  assert.ok((await rows()).some((row) => row.id === one.conversationId && row.label === r.title));
});

test('SIGKILL mid-turn: adopts the real answer, capabilities and usage without another spawn', {
  timeout: 120_000,
}, async () => {
  const r = request('adopt', { capabilities: caps });
  const lost = call(r).catch(() => undefined);
  await eventually(() => exists('adopt.midturn'), 'provider started');
  assert.ok(!argv(r.key).includes('--dangerously-skip-permissions'));
  assert.ok(argv(r.key).includes('--tools'), 'capabilities encoded by agent-cli');
  const journal = fs
    .readdirSync(path.join(data, 'executions'))
    .map((n) => path.join(data, 'executions', n))
    .find((p) => fs.readFileSync(path.join(p, 'owner.json'), 'utf8').includes('"key":"adopt"'))!;
  const owner = JSON.parse(fs.readFileSync(path.join(journal, 'owner.json'), 'utf8'));
  assert.deepEqual(owner.policy.capabilities, caps);
  await kill();
  await lost;
  await start();
  const joined = call(r);
  mark('adopt.go');
  const outcome = await joined;
  assert.equal(outcome.t, 'complete', JSON.stringify(outcome));
  if (outcome.t === 'complete') assert.equal(outcome.text, 'final answer');
  assert.equal(outcome.usage.t, 'reported');
  assert.equal(count(r.key), 1);
  assert.deepEqual(await call(r), outcome);
});

test('deadline survives adoption as timeout; cancel is cancelled after the joined drain', {
  timeout: 120_000,
}, async () => {
  const r = request('deadline', { maxRuntimeMs: 12_000 });
  const lost = call(r).catch(() => undefined);
  await eventually(() => exists('deadline.midturn'), 'deadline provider started');
  await kill();
  await lost;
  await start();
  const outcome = await call(r);
  assert.equal(outcome.t, 'failed');
  if (outcome.t === 'failed') assert.equal(outcome.cause, 'max_runtime_timeout');
  assert.equal(outcome.usage.t, 'reported', 'sealed adoption retains pre-stop usage');
  assert.equal(count(r.key), 1);
  const cancel = request('cancel');
  const running = call(cancel);
  await eventually(() => exists('cancel.midturn'), 'cancel provider started');
  await rpc({ cancel: cancel.key });
  const cancelled = await running;
  assert.equal(cancelled.t, 'cancelled');
  assert.equal(cancelled.usage.t, 'reported');
  assert.deepEqual(await call(cancel), cancelled);
  assert.equal(count(cancel.key), 1);
});

test('Codex capabilities reach argv and unavailable usage stays explicitly unreported', {
  timeout: 90_000,
}, async () => {
  const r = request('codex', { provider: 'codex', model: 'gpt-6-luna', capabilities: caps });
  const running = call(r);
  await eventually(() => exists('codex.midturn'), 'codex provider started');
  const args = argv(r.key);
  assert.ok(args.includes('-s') && args.includes('read-only'), JSON.stringify(args));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  mark('codex.go');
  const outcome = await running;
  assert.equal(outcome.t, 'complete');
  if (outcome.t === 'complete') assert.equal(outcome.text, 'final answer');
  assert.equal(outcome.usage.t, 'unreported');
});

test('usage classes: absent cache class and unknown cache-write tier are never priced as zero', () => {
  for (const requests of [
    [],
    [{ t: 'total' as const, tokens: { t: 'unreported' as const, why: 'missing cached read' } }],
    [{ t: 'total' as const, tokens: { t: 'unreported' as const, why: 'missing cache tiers' } }],
  ]) {
    const usage = turnUsage(requests);
    assert.equal(usage.t, 'unreported');
    if (usage.t === 'unreported') assert.deepEqual(usage.requests, requests);
  }
});
