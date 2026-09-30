import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WS_PATH, createDefaultConversationConfig } from '@unleashd/shared';
import { WebSocket } from 'ws';

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

const PORT = 7531;
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

function startBackend(name: string): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOME: home,
      // Only the fakes and node: the Buddy scheduler must never reach a real agent CLI.
      PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      PORT: String(PORT),
      UNLEASHD_DATA_DIR: path.join(home, '.agent-viewer'),
      UNLEASHD_AUTH_TOKEN: TOKEN,
      FAKE_DIR: fakeDir,
      NODE_ENV: 'test',
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
  for (const scenario of ['chat', 'worker', 'hang', 'lost']) {
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
