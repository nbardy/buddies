import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WS_PATH, createDefaultConversationConfig } from '@unleashd/shared';
import { WebSocket } from 'ws';
import { freePortSync } from './free-port';
import { NO_AUTO_INSTALL } from './fixtures/backend-env';

/**
 * The owner's requirement (2026-09-30, #case-studies post_01a0f2bc): a web-server restart must not
 * drop a running turn or background worker. Until then provider output was piped to the backend,
 * so an abrupt backend death (14 and 10 orphaned runs that day) killed every turn and recovery
 * marked every run interrupted. Design: agent_notes/2026-09-30_execution-adoption-design.md.
 *
 * Real boundary, isolated stores: the actual backend process (server.ts) on a temp HOME, with a
 * fake `claude` CLI on a PATH that holds no real agent CLI. Backend A starts four turns, is
 * SIGKILLed mid-turn, and backend B starts on the same stores. Nothing here touches the owner's
 * stores or runs a live agent.
 */

// node:sqlite postdates the pinned @types/node (20), so it is typed here.
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
  DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void };
};

const PORT = freePortSync();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'a7d3c0e9f2b14658a7d3c0e9f2b14658';

// One CLI for every scenario, chosen by a marker in its prompt. Every step leaves a file in
// FAKE_DIR so the test can tell exactly where each process is. A prompt with no marker (a bootstrap
// or review turn) answers at once.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = process.env.FAKE_DIR;
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => main().catch((e) => { fs.writeFileSync(path.join(dir, 'fatal-' + process.pid), String(e.stack)); process.exit(3); }));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const text = (t) => say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const mark = (name, value = '') => fs.writeFileSync(path.join(dir, name), String(value));
const until = (name) => new Promise((resolve) => { const t = setInterval(() => { if (fs.existsSync(path.join(dir, name))) { clearInterval(t); resolve(); } }, 25); });
function mcp() {
  const i = process.argv.indexOf('--mcp-config');
  if (i < 0) return null;
  const server = Object.values(JSON.parse(process.argv[i + 1]).mcpServers)[0];
  const auth = server.headers.Authorization.replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] ?? '');
  return { url: server.url, auth };
}
async function post(tools, body, key) {
  const response = await fetch(tools.url, {
    method: 'POST',
    headers: { authorization: tools.auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post', arguments: { channel: { direct: ['owner'] }, body, key } } }),
  });
  const raw = await response.text();
  return response.status + ' ' + (raw.includes('"isError":true') ? 'tool-error ' + raw : 'ok');
}
// A CLI busy in a tool call: SIGTERM is recorded and ignored, and from then on it keeps writing
// and calling its tool (the second writer a stop must prevent). The first SIGTERM SIGKILLs the
// backend named in crash-on-sigterm, so the backend dies exactly inside its kill grace.
function ignoreStop(scenario, tools) {
  let stops = 0;
  process.on('SIGTERM', () => {
    const crash = path.join(dir, 'crash-on-sigterm');
    if (fs.existsSync(crash)) {
      const pid = Number(fs.readFileSync(crash, 'utf8'));
      fs.rmSync(crash);
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    if (stops++ > 0) return;
    setInterval(() => text('after-stop;'), 100);
    if (tools) setInterval(() => post(tools, scenario + ' after-stop', scenario + '-after-' + stops++).catch(() => 'down')
      .then((got) => fs.appendFileSync(path.join(dir, scenario + '.poststop'), got + '\n')), 250);
  });
  setInterval(() => {}, 1000);
}
async function main() {
  const scenario = (/SCENARIO:(\w+)/.exec(prompt) || [])[1];
  say({ type: 'system', subtype: 'init', session_id: 'fake-' + (scenario || 'other') + '-' + process.pid });
  if (!scenario) { text('ok'); say({ type: 'result', subtype: 'success' }); return; }
  fs.appendFileSync(path.join(dir, 'spawns.log'), scenario + ' ' + process.pid + '\n');
  mark(scenario + '.pgid', execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  const tools = mcp();
  if (tools) mark(scenario + '.tools', JSON.stringify(tools));
  text('one;');
  if (tools) mark(scenario + '.before', await post(tools, scenario + ' before-restart', scenario + '-before'));
  text('two;');
  mark(scenario + '.midturn', process.pid);
  if (scenario === 'hang' || scenario === 'lost') return setInterval(() => {}, 1000);
  if (scenario === 'stopper' || scenario === 'timeouter') return ignoreStop(scenario, tools);
  if (scenario === 'settler') {
    await until('settler.go');
    say({ type: 'result', subtype: 'success' });
    return mark('settler.exited', process.pid);
  }
  if (scenario === 'quick') {
    await until('quick.go');
    text('quick done;');
    say({ type: 'result', subtype: 'success' });
    return mark('quick.exited', process.pid);
  }
  await until('dead');
  text('during;');
  mark(scenario + '.during');
  await until('release');
  if (tools) mark(scenario + '.after', await post(tools, scenario + ' after-restart', scenario + '-after'));
  text('four;');
  say({ type: 'result', subtype: 'success' });
  mark(scenario + '.exited', process.pid);
}
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-adoption-'));
const home = path.join(root, 'home');
const fakeDir = path.join(root, 'fake');
const bin = path.join(root, 'bin');
const workspaceDir = path.join(root, 'workspace');
const log: string[] = [];
let backend: ChildProcess | null = null;

function startBackend(name: string, extraEnv: Record<string, string> = {}): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOME: home,
      ...NO_AUTO_INSTALL,
      // Only the fakes and node: the Buddy scheduler must never reach a real agent CLI.
      PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      PORT: String(PORT),
      UNLEASHD_DATA_DIR: path.join(home, '.agent-viewer'),
      UNLEASHD_AUTH_TOKEN: TOKEN,
      FAKE_DIR: fakeDir,
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own group, like a supervisor-run backend: killing it must not reach the providers.
    detached: true,
  });
  backend = child;
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
      // Past startup (adoption included): mutations are admitted from here on.
      if (chunk.toString().includes('Initial load complete')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) =>
      reject(new Error(`${name} exited ${code}: ${log.slice(-40).join('\n')}`))
    );
  });
}

async function killBackend(): Promise<void> {
  const child = backend;
  backend = null;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

async function http(method: string, route: string, body?: unknown) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function eventually<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, what: string) {
  const deadline = Date.now() + 30_000;
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
const spawns = () =>
  exists('spawns.log') ? readFake('spawns.log').trim().split('\n').filter(Boolean) : [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function createChat(conversationId: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WS_PATH}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const commandId = crypto.randomUUID();
    socket.on('open', () =>
      socket.send(
        JSON.stringify({
          type: 'create_conversation',
          commandId,
          conversationId,
          workingDirectory: workspaceDir,
          config: createDefaultConversationConfig('claude'),
          initialMessage: message,
          kind: { t: 'chat' },
        })
      )
    );
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; commandId?: string; ok?: boolean };
      if (frame.type !== 'ack' || frame.commandId !== commandId) return;
      socket.close();
      frame.ok === false ? reject(new Error(String(raw))) : resolve();
    });
    socket.on('error', reject);
  });
}

async function hire(ws: string, slug: string) {
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

async function ask(buddyId: string, scenario: string) {
  const posted = await http('POST', '/api/buddies/direct/posts', {
    members: [buddyId],
    kind: 'request',
    body: `Please work. SCENARIO:${scenario}`,
    key: `ask-${scenario}`,
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return posted.body.post ?? posted.body;
}

async function runOf(buddyId: string) {
  const runs = await http('GET', `/api/buddies/runs?buddyId=${buddyId}`);
  return (runs.body.runs ?? runs.body).find(
    (run: { input: { kind: string } }) => run.input.kind === 'post'
  );
}

before(() => {
  for (const dir of [home, fakeDir, bin, workspaceDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  // Anything routed to another harness (a memory review) fails at once instead of finding a real CLI.
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
});

after(async () => {
  await killBackend();
  for (const scenario of ['chat', 'worker', 'hang', 'lost', 'quick', 'stopper', 'timeouter']) {
    if (!exists(`${scenario}.pgid`)) continue;
    try {
      process.kill(-Number(readFake(`${scenario}.pgid`)), 'SIGKILL');
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  'a backend SIGKILLed mid-turn is replaced and the new one adopts every running turn',
  { timeout: 240_000 },
  async () => {
    await startBackend('A');
    const ws = await http('POST', '/api/buddies/workspaces', {
      name: 'adoption',
      rootPath: workspaceDir,
    });
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const workspaceId = ws.body.id as string;
    const worker = await hire(workspaceId, 'worker');
    const hang = await hire(workspaceId, 'hang');
    const lost = await hire(workspaceId, 'lost');
    const chatId = crypto.randomUUID();

    await createChat(chatId, 'Hello. SCENARIO:chat');
    const request = await ask(worker, 'worker');
    await ask(hang, 'hang');
    await ask(lost, 'lost');
    for (const scenario of ['chat', 'worker', 'hang', 'lost'])
      await eventually(() => exists(`${scenario}.midturn`), Boolean, `${scenario} mid-turn`);
    assert.match(readFake('worker.before'), /^200 ok/, 'the Buddy tool works before the restart');
    const pids = Object.fromEntries(
      ['chat', 'worker', 'hang', 'lost'].map((s) => [s, Number(readFake(`${s}.midturn`))])
    );

    // The backend dies abruptly, as it did at 22:09:26 on 2026-09-30.
    await killBackend();
    for (const pid of Object.values(pids)) assert.ok(alive(pid), 'a provider outlives its backend');
    // Output written while no backend exists at all.
    fs.writeFileSync(path.join(fakeDir, 'dead'), '');
    await eventually(
      () => exists('chat.during') && exists('worker.during'),
      Boolean,
      'output during the gap'
    );
    // An execution-owner death, distinct from a restart: its group is SIGKILLed while no backend runs.
    process.kill(-Number(readFake('lost.pgid')), 'SIGKILL');

    await startBackend('B');
    fs.writeFileSync(path.join(fakeDir, 'release'), '');

    // --- the chat turn: continued, ordered, one completion, no false interruption ----------------
    await eventually(() => exists('chat.exited'), Boolean, 'chat provider finished');
    // The attempt backend A opened is the one that succeeds: adopted, not interrupted and redone.
    const chat = await eventually(
      () => http('GET', `/api/conversations/${chatId}`),
      (detail) => detail.status === 200 && detail.body.latestAttempt?.state === 'succeeded',
      'the adopted chat turn to end'
    );
    const page = await http('GET', `/api/conversations/${chatId}/messages?afterSeq=-1&limit=200`);
    const messages = page.body.messages as Array<{
      role: string;
      body: { t: string; text?: string };
    }>;
    const assistant = messages
      .filter((m) => m.role === 'assistant' && m.body.t === 'text')
      .map((m) => m.body.text)
      .join('');
    assert.equal(
      assistant,
      'one;two;during;four;',
      'before, during and after the restart, once each, in order'
    );
    const system = messages.filter((m) => m.role === 'system').map((m) => m.body.text ?? '');
    assert.ok(
      !system.some((t) => /restart|interrupt/i.test(t)),
      `no false interruption: ${system.join(' | ')}`
    );
    assert.equal(chat.body.latestAttempt.terminalCause, 'provider_complete');

    // --- the Buddy worker: same execution, tools work after the restart, one return --------------
    await eventually(() => exists('worker.exited'), Boolean, 'worker provider finished');
    assert.match(readFake('worker.after'), /^200 ok/, 'the same grant works on the new backend');
    const run = await eventually(
      () => runOf(worker),
      (r) => r?.status === 'complete',
      'worker run complete'
    );
    const thread = await http('GET', `/api/buddies/posts/${request.id}/thread`);
    const posts = (thread.body.posts ?? thread.body) as Array<{
      body: string;
      author: { id?: string };
    }>;
    const answers = posts.filter((p) => p.body === 'one;two;during;four;');
    assert.equal(answers.length, 1, 'exactly one answer returns to the requester');
    const dm = await http('GET', `/api/buddies/channels/${request.channelId}/posts`);
    const bodies = (
      (dm.body.posts ?? dm.body) as Array<{ body: string; author: { kind: string; id?: string } }>
    )
      .filter((p) => p.author.id === worker)
      .map((p) => p.body);
    for (const expected of ['worker before-restart', 'worker after-restart'])
      assert.ok(
        bodies.includes(expected),
        `${expected} written as the worker: ${bodies.join(' | ')}`
      );
    assert.equal(run.errorCode ?? null, null);

    // --- no second writer: each scenario spawned exactly one provider, and it is the one that ran --
    const spawned = spawns();
    for (const scenario of ['chat', 'worker', 'hang', 'lost'])
      assert.deepEqual(
        spawned.filter((line) => line.startsWith(`${scenario} `)),
        [`${scenario} ${pids[scenario]}`],
        `${scenario}: one spawn, and the adopted process is that same pid`
      );
    assert.equal(readFake('chat.exited'), String(pids.chat));
    assert.equal(readFake('worker.exited'), String(pids.worker));

    // --- explicit Stop still stops an adopted turn and revokes its tools ------------------------
    assert.ok(alive(pids.hang), 'the hanging turn was adopted, not killed, by the restart');
    const hangRun = await runOf(hang);
    assert.equal(hangRun.status, 'running');
    assert.equal((await http('POST', `/api/buddies/runs/${hangRun.id}/cancel`)).status, 200);
    await eventually(
      () => runOf(hang),
      (r) => r?.status === 'cancelled',
      'hang run cancelled'
    );
    await eventually(() => !alive(pids.hang), Boolean, 'hang provider killed');
    const tools = JSON.parse(readFake('hang.tools')) as { url: string; auth: string };
    const revoked = await fetch(tools.url, {
      method: 'POST',
      headers: {
        authorization: tools.auth,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(revoked.status, 401, 'a stopped turn keeps no tools');

    // --- an execution killed from outside is lost, never success --------------------------------
    const lostRun = await eventually(
      () => runOf(lost),
      (r) => r?.status === 'failed',
      'lost run failed'
    );
    assert.match(String(lostRun.error), /lost/, JSON.stringify(lostRun));

    // Every journal is settled and gone, turns' and memory reviews' alike.
    await eventually(
      () => fs.readdirSync(path.join(home, '.agent-viewer', 'executions')),
      (left) => left.length === 0,
      'journals removed after settle'
    );
  }
);

// Review of P1 (2026-10-01): adoption re-armed the run deadline as max(0, deadline - now), so a
// turn that finished cleanly while no backend ran, adopted after its deadline had passed, was
// sealed as max_runtime_timeout mid-replay and its successful run settled failed.
test(
  'a turn that finished during the gap is adopted as finished, even past its deadline',
  { timeout: 120_000 },
  async () => {
    const deadlineMs = 8_000;
    const env = { CWV_BUDDY_BACKGROUND_TURN_MS: String(deadlineMs) };
    await killBackend(); // the previous test's backend B still holds the port
    await startBackend('C', env);
    const ws = await http('POST', '/api/buddies/workspaces', {
      name: 'gap',
      rootPath: workspaceDir,
    });
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const quick = await hire(ws.body.id as string, 'quick');
    const askedAt = Date.now();
    await ask(quick, 'quick');
    await eventually(() => exists('quick.midturn'), Boolean, 'quick mid-turn');

    await killBackend();
    fs.writeFileSync(path.join(fakeDir, 'quick.go'), '');
    await eventually(() => exists('quick.exited'), Boolean, 'quick finished with no backend');
    assert.ok(Date.now() - askedAt < deadlineMs, 'the provider finished inside its deadline');
    await new Promise((resolve) => setTimeout(resolve, askedAt + deadlineMs + 1_000 - Date.now()));

    await startBackend('D', env);
    const run = await eventually(
      () => runOf(quick),
      (r) => r?.status === 'complete' || r?.status === 'failed',
      'quick run settled'
    );
    assert.equal(run.status, 'complete', JSON.stringify(run));
  }
);

const executionsDir = path.join(home, '.agent-viewer', 'executions');
const terminal = (status: string | undefined) =>
  status === 'complete' || status === 'failed' || status === 'cancelled';

/** One Buddy tool call with a turn's bearer: 200 while its grant is live, 401 once revoked. */
async function toolStatus(scenario: string): Promise<number> {
  const tools = JSON.parse(readFake(`${scenario}.tools`)) as { url: string; auth: string };
  const response = await fetch(tools.url, {
    method: 'POST',
    headers: {
      authorization: tools.auth,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  await response.text();
  return response.status;
}

function stopConversation(conversationId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WS_PATH}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // Left open: the server drops a command whose socket closed before it was dispatched (the
    // `readyState` check after the initial-load await), and this backend dies on the stop anyway.
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'stop_conversation', conversationId }));
      resolve();
    });
    socket.on('error', () => undefined);
    socket.once('unexpected-response', () => reject(new Error('stop socket refused')));
  });
}

async function attemptOf(conversationId: string) {
  const detail = await http('GET', `/api/conversations/${conversationId}`);
  return detail.body?.latestAttempt as { state: string; terminalCause?: string } | undefined;
}

/**
 * A worker turn whose CLI ignores SIGTERM is ended (by `end`), and the CLI SIGKILLs the backend
 * the moment the SIGTERM arrives: the backend dies inside its kill grace with the CLI alive. The
 * replacement must not give the stopped turn its tools back, must kill it, and must settle it as
 * the stop decided. Returns the settled run.
 */
async function crashInsideKillGrace(
  scenario: string,
  env: Record<string, string>,
  end: (conversationId: string) => Promise<void>
) {
  await killBackend();
  await startBackend(`${scenario}-1`, env);
  const ws = await http('POST', '/api/buddies/workspaces', {
    name: scenario,
    rootPath: workspaceDir,
  });
  const buddy = await hire(ws.body.id as string, scenario);
  await ask(buddy, scenario);
  await eventually(() => exists(`${scenario}.midturn`), Boolean, `${scenario} mid-turn`);
  const pid = Number(readFake(`${scenario}.midturn`));
  assert.match(readFake(`${scenario}.before`), /^200 ok/, 'the tool works before the stop');
  const run = await eventually(
    () => runOf(buddy),
    (r) => !!r?.conversationId,
    `${scenario} run bound`
  );
  const dying = backend!;
  fs.writeFileSync(path.join(fakeDir, 'crash-on-sigterm'), String(dying.pid));
  const died = new Promise((resolve) => dying.once('exit', resolve));
  await end(run.conversationId);
  await died;
  backend = null;
  assert.ok(alive(pid), 'the stopped CLI outlived its backend: the window is open');

  await startBackend(`${scenario}-2`, env);
  assert.equal(await toolStatus(scenario), 401, 'a stopped turn gets no tools back after a crash');
  await eventually(() => !alive(pid), Boolean, 'the replacement kills the stopped CLI');
  const settled = await eventually(
    () => runOf(buddy),
    (r) => terminal(r?.status),
    'run settled'
  );
  const poststop = exists(`${scenario}.poststop`) ? readFake(`${scenario}.poststop`) : '';
  assert.ok(!/^200/m.test(poststop), `no tool call after the stop succeeded: ${poststop}`);
  assert.equal(spawns().filter((line) => line.startsWith(`${scenario} `)).length, 1);
  await eventually(
    () => fs.readdirSync(executionsDir),
    (left) => left.length === 0,
    'journal removed once settled'
  );
  return { run: settled, attempt: await attemptOf(run.conversationId) };
}

// 2a (P1 review, 2026-10-01): Stop revoked the grant in memory only, so a backend SIGKILLed inside
// the SIGTERM→SIGKILL grace left a turn the next one adopted as LIVE, grant restored, never
// stopped again. `stopping` is now on disk before the signal (execution-state.ts). On 811f758 the
// tool call after the restart answers 200 and the CLI is never killed.
test(
  'a Stop survives a backend crash inside the kill grace: no tools back, killed, cancelled',
  { timeout: 180_000 },
  async () => {
    const { run, attempt } = await crashInsideKillGrace('stopper', {}, stopConversation);
    // Decision (2026-10-03): an owner Stop settles the run cancelled, live or adopted.
    assert.equal(run.status, 'cancelled', JSON.stringify(run));
    assert.deepEqual(attempt && [attempt.state, attempt.terminalCause], ['cancelled', 'user_stop']);
  }
);

test(
  'a timeout survives a backend crash inside the kill grace: failed as max_runtime_timeout',
  { timeout: 180_000 },
  async () => {
    // The run's deadline: short, so it fires while the test watches.
    const env = { CWV_BUDDY_BACKGROUND_TURN_MS: '6000' };
    const { run, attempt } = await crashInsideKillGrace('timeouter', env, async () => undefined);
    assert.equal(run.status, 'failed', JSON.stringify(run));
    assert.match(String(run.error), /maximum runtime/, JSON.stringify(run));
    assert.deepEqual(attempt && [attempt.state, attempt.terminalCause], [
      'failed',
      'max_runtime_timeout',
    ]);
  }
);

// 2b (P1 review, 2026-10-01): the journal was removed when the drain resolved, before the
// fire-and-forget run settle landed, so a crash between them recovered a finished run as
// interrupted. The window is held open by a write lock on the (temp) Buddies store: the settle
// blocks, the backend dies there. Now the journal says `ended` until the settle lands, and the
// next backend settles that outcome. On 811f758 the journal is gone and the run ends failed.
test(
  'a crash between the drain and the run settle: the next boot settles it complete, once',
  { timeout: 180_000 },
  async () => {
    await killBackend();
    await startBackend('settle-1');
    const ws = await http('POST', '/api/buddies/workspaces', {
      name: 'settle',
      rootPath: workspaceDir,
    });
    const settler = await hire(ws.body.id as string, 'settler');
    const request = await ask(settler, 'settler');
    await eventually(() => exists('settler.midturn'), Boolean, 'settler mid-turn');
    const journal = fs
      .readdirSync(executionsDir)
      .map((name) => path.join(executionsDir, name))
      .find((dir) =>
        fs.readFileSync(path.join(dir, 'owner.json'), 'utf8').includes('SCENARIO:settler')
      );
    assert.ok(journal, 'the settler turn is journaled');

    const lock = new DatabaseSync(path.join(home, '.buddies', 'buddies-v3.sqlite'));
    lock.exec('BEGIN IMMEDIATE');
    try {
      fs.writeFileSync(path.join(fakeDir, 'settler.go'), '');
      // Drained: on this branch the journal says `ended`; on 811f758 it is already removed.
      await eventually(
        () => {
          // 811f758 has no phase.json: read it only where it exists, so that build reaches its crash.
          const phase = path.join(journal, 'phase.json');
          return (
            !fs.existsSync(journal) ||
            (fs.existsSync(phase) && fs.readFileSync(phase, 'utf8').includes('"ended"'))
          );
        },
        Boolean,
        'the backend drained the finished turn'
      );
      await killBackend();
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }

    await startBackend('settle-2');
    const run = await eventually(
      () => runOf(settler),
      (r) => terminal(r?.status),
      'run settled'
    );
    assert.equal(run.status, 'complete', `a finished run is never failed: ${JSON.stringify(run)}`);
    const thread = await http('GET', `/api/buddies/posts/${request.id}/thread`);
    const answers = ((thread.body.posts ?? thread.body) as Array<{ body: string }>).filter(
      (post) => post.body === 'one;two;'
    );
    assert.equal(answers.length, 1, 'exactly one answer returns to the requester');
    assert.deepEqual(
      [
        (await attemptOf(run.conversationId))?.state,
        spawns().filter((l) => l.startsWith('settler ')).length,
      ],
      ['succeeded', 1]
    );
    await eventually(
      () => fs.readdirSync(executionsDir),
      (left) => left.length === 0,
      'journal removed once settled'
    );
  }
);
