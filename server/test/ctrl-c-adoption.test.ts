import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { WS_PATH, createDefaultConversationConfig } from '@unleashd/shared';
import { WebSocket } from 'ws';
import { NO_AUTO_INSTALL } from './fixtures/backend-env';
import { freePortSync } from './free-port';

/**
 * The owner's question (2026-09-30, Task task_01a0f2cb): "if I ctrl+C the server and bring it back
 * up, do the background agents work?" execution-adoption.test.ts SIGKILLs a bare server.ts; this
 * drives the REAL dev entry instead: `pnpm run dev:server` (pnpm → tools/dev-supervisor.mjs →
 * tools/watch-server.mjs runner → server.ts) in its own process group, stopped the way a terminal
 * stops it: SIGINT to the whole foreground group. Cases: one Ctrl+C, two (the supervisor escalates
 * to SIGKILL), `--replace` over a running runtime, and three outages during which the agent calls
 * a Buddy tool (held by the relay and delivered; held past 55 s and refused clearly; Stopped first).
 *
 * Isolated: temp HOME, UNLEASHD_DATA_DIR, UNLEASHD_BUDDIES_DB, BUDDIES_HOME; a spare PORT (the
 * dev-server task honours it); a PATH holding only the fake CLIs, node and system tools, so no
 * real agent CLI is reachable. Nothing here signals anything outside the groups it starts.
 */

const PORT = freePortSync();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'c7c7c0e9f2b14658a7d3c0e9f2b14658';
const REPO = path.resolve(__dirname, '..', '..');
const PNPM = process.env.npm_execpath ?? '';
const REAL_HOME = os.homedir();

// Chosen by a SCENARIO marker in the prompt; every step leaves a file in FAKE_DIR. A prompt with
// no marker (bootstrap, review) answers at once. `down` and `longdown` also call a Buddy tool while
// no backend runs and record what they got back (`<scenario>.gap`, and the raw body in `.raw`);
// `down` then replays that call with the same key. `stopped` hands its in-gap call to a detached
// child, so the call is still made after Stop killed the CLI's group.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = process.env.FAKE_DIR;
const gapChild = process.argv.indexOf('--gap-child');
let prompt = '';
if (gapChild < 0) process.stdin.on('data', (d) => (prompt += d));
if (gapChild < 0) process.stdin.on('end', () => main().catch((e) => { fs.writeFileSync(path.join(dir, 'fatal-' + process.pid), String(e.stack)); process.exit(3); }));
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
  try {
    const response = await fetch(tools.url, {
      method: 'POST',
      headers: { authorization: tools.auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post', arguments: { channel: { direct: ['owner'] }, body, key } } }),
    });
    const raw = await response.text();
    fs.writeFileSync(path.join(dir, key + '.raw'), raw);
    // isError: the tool failed; a JSON-RPC error: the call never reached a tool (the relay's answer).
    const failed = raw.includes('"isError":true') || raw.includes('"error":{');
    return response.status + ' ' + (failed ? 'tool-error ' + raw : 'ok');
  } catch (error) {
    return 'transport-error ' + (error.cause?.code ?? error.message);
  }
}
// The in-gap call: '.gap-sent' just before it, '.gap' with its result, '.gap-ms' how long it took.
async function gapCall(tools, scenario) {
  mark(scenario + '.gap-sent');
  const started = Date.now();
  const result = await post(tools, scenario + ' in-gap', scenario + '-gap');
  mark(scenario + '.gap-ms', Date.now() - started);
  mark(scenario + '.gap', result);
}
if (gapChild >= 0) until('dead').then(() => gapCall(JSON.parse(process.argv[gapChild + 1]), 'stopped'));
async function main() {
  const scenario = (/SCENARIO:(\w+)/.exec(prompt) || [])[1];
  say({ type: 'system', subtype: 'init', session_id: 'fake-' + (scenario || 'other') + '-' + process.pid });
  if (!scenario) { text('ok'); say({ type: 'result', subtype: 'success' }); return; }
  fs.appendFileSync(path.join(dir, 'spawns.log'), scenario + ' ' + process.pid + '\n');
  mark(scenario + '.pgid', execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  const tools = mcp();
  text('one;');
  if (tools) mark(scenario + '.before', await post(tools, scenario + ' before-restart', scenario + '-before'));
  text('two;');
  if (tools && scenario === 'stopped') {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [__filename, '--gap-child', JSON.stringify(tools)], { detached: true, stdio: 'ignore', env: process.env });
    mark('stopped-child.pgid', child.pid);
    child.unref();
  }
  mark(scenario + '.midturn', process.pid);
  await until('dead');
  text('during;');
  if (tools && (scenario === 'down' || scenario === 'longdown')) await gapCall(tools, scenario);
  mark(scenario + '.during');
  await until('release');
  if (tools) mark(scenario + '.after', await post(tools, scenario + ' after-restart', scenario + '-after'));
  if (tools && scenario === 'down') mark(scenario + '.replay', await post(tools, scenario + ' in-gap', scenario + '-gap'));
  text('four;');
  say({ type: 'result', subtype: 'success' });
  mark(scenario + '.exited', process.pid);
}
`;

interface Case {
  readonly root: string;
  readonly home: string;
  readonly dataDir: string;
  readonly fakeDir: string;
  readonly workspaceDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log: string[];
  /** The last `eventually` this case waited on, for the diagnosis of a timed-out test. */
  waitingFor: string;
  finished: boolean;
}

interface DevGroup {
  readonly name: string;
  readonly child: ChildProcess;
  readonly pgid: number;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
}

const cases: Case[] = [];
const groups: DevGroup[] = [];

function makeCase(name: string): Case {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `unleashd-ctrlc-${name}-`));
  const home = path.join(root, 'home');
  const dataDir = path.join(home, '.agent-viewer');
  const fakeDir = path.join(root, 'fake');
  const bin = path.join(root, 'bin');
  const workspaceDir = path.join(root, 'workspace');
  for (const dir of [home, fakeDir, bin, workspaceDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  // Anything routed to another harness (a memory review) fails at once instead of finding a real CLI.
  for (const other of ['codex', 'gemini', 'cursor-agent'])
    fs.writeFileSync(path.join(bin, other), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // node's own directory also holds real agent CLIs (codex, gemini): link node alone.
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const created: Case = {
    root,
    home,
    dataDir,
    fakeDir,
    workspaceDir,
    log: [],
    waitingFor: '',
    finished: false,
    env: {
      ...process.env,
      HOME: home,
      ...NO_AUTO_INSTALL,
      // The dev task's first step (tools/ensure-addons.mjs) keys the shared addon cache on rustc's
      // version, so the toolchain and that cache stay the real ones; no agent CLI lives there.
      PATH: [
        bin,
        path.join(REAL_HOME, '.cargo', 'bin'),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].join(path.delimiter),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(REAL_HOME, '.rustup'),
      CARGO_HOME: process.env.CARGO_HOME ?? path.join(REAL_HOME, '.cargo'),
      UNLEASHD_BUILD_ROOT:
        process.env.UNLEASHD_BUILD_ROOT ?? path.join(REAL_HOME, '.cache', 'unleashd'),
      PORT: String(PORT),
      UNLEASHD_DATA_DIR: dataDir,
      // Non-default stores: Buddy execution needs the opt-in (buddies/execution-gate.ts).
      UNLEASHD_BUDDY_EXECUTION: '1',
      UNLEASHD_BUDDIES_DB: path.join(home, '.buddies', 'buddies-v3.sqlite'),
      BUDDIES_HOME: path.join(home, '.buddies'),
      UNLEASHD_AUTH_TOKEN: TOKEN,
      FAKE_DIR: fakeDir,
      // The dists are built before the suite; a rebuild here deletes them under every other test
      // file (tools/dev-supervisor.mjs taskPlan).
      UNLEASHD_DEV_PREBUILT: '1',
    },
  };
  cases.push(created);
  return created;
}

/** `pnpm run dev:server [args]` as a terminal starts it: its own foreground process group. */
function launch(c: Case, name: string, args: string[] = []): DevGroup {
  assert.ok(PNPM, 'run through pnpm (pnpm test:server) so npm_execpath names pnpm');
  const child = spawn(process.execPath, [PNPM, 'run', 'dev:server', ...args], {
    cwd: REPO,
    env: c.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  assert.ok(child.pid);
  let seen = '';
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const record = (chunk: Buffer) => {
    const textChunk = chunk.toString();
    c.log.push(
      ...textChunk
        .split('\n')
        .map((l) => `${new Date().toISOString().slice(14, 23)} [${name}] ${l}`)
    );
    seen += textChunk;
    // Full dev-runtime output for the manual run, which fails far from where it went wrong.
    if (process.env.CTRLC_LOG_FILE)
      fs.appendFileSync(process.env.CTRLC_LOG_FILE, `[${name}] ${textChunk}`);
    // Past startup (adoption included): mutations are admitted from here on.
    if (seen.includes('Initial load complete')) resolveReady();
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  // No startup timer: readiness is the log line, failure is the exit; the test's own timeout
  // bounds a hang (a 120 s timer here raced a loaded machine's startup).
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  void exited.then(() =>
    rejectReady(new Error(`${name} exited before ready:\n${c.log.slice(-60).join('\n')}`))
  );
  const group = { name, child, pgid: child.pid, ready, exited };
  groups.push(group);
  return group;
}

function processesIn(pgid: number): number[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => group === pgid && pid > 0)
    .map(([pid]) => pid);
}

// Only a group that still has members: an emptied pgid can be reused by an unrelated process.
const signalGroup = (pgid: number, sig: NodeJS.Signals) => {
  if (processesIn(pgid).length === 0) return;
  try {
    process.kill(-pgid, sig);
  } catch {}
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Wait until the condition holds. No deadline of its own: every wait here is for an event the
 * system under test produces, and the test's timeout bounds a hang. Fixed 30 s deadlines failed
 * under full-suite load while nothing was wrong (the P1 Ctrl+C flake). `what` and the case log
 * are printed by `after` for a case that never finished.
 */
async function eventually<T>(
  c: Case,
  read: () => Promise<T> | T,
  ok: (value: T) => boolean,
  what: string
) {
  c.waitingFor = what;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

function createChat(c: Case, conversationId: string, message: string): Promise<void> {
  return wsCommand({
    type: 'create_conversation',
    conversationId,
    workingDirectory: c.workspaceDir,
    config: createDefaultConversationConfig('claude'),
    initialMessage: message,
    kind: { t: 'chat' },
  });
}

/** One correlated WS command, resolved on its ack. */
function wsCommand(command: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WS_PATH}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const commandId = crypto.randomUUID();
    socket.on('open', () => socket.send(JSON.stringify({ ...command, commandId })));
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; commandId?: string; ok?: boolean };
      if (frame.type !== 'ack' || frame.commandId !== commandId) return;
      socket.close();
      frame.ok === false ? reject(new Error(String(raw))) : resolve();
    });
    socket.on('error', reject);
  });
}

async function runOf(buddyId: string) {
  const runs = await http('GET', `/api/buddies/runs?buddyId=${buddyId}`);
  return (runs.body.runs ?? runs.body).find(
    (run: { input: { kind: string } }) => run.input.kind === 'post'
  );
}

/** A chat turn and a Buddy worker run, both parked mid-turn on the fake CLI. */
async function startWork(c: Case, workerScenario: string) {
  const ws = await http('POST', '/api/buddies/workspaces', {
    name: 'ctrlc',
    rootPath: c.workspaceDir,
  });
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const hired = await http('POST', '/api/buddies', {
    workspaceId: ws.body.id,
    slug: workerScenario,
    name: workerScenario,
    role: 'test worker',
    provider: 'claude',
    key: `hire-${workerScenario}`,
  });
  assert.equal(hired.status, 201, JSON.stringify(hired.body));
  const worker = hired.body.id as string;
  const chatId = crypto.randomUUID();
  await createChat(c, chatId, 'Hello. SCENARIO:chat');
  const dm = await http('POST', `/api/buddies/${worker}/direct`);
  const posted = await http('POST', `/api/buddies/channels/${dm.body.channelId}/posts`, {
    kind: 'request',
    body: `Please work. SCENARIO:${workerScenario}`,
    key: `ask-${workerScenario}`,
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const request = posted.body.post ?? posted.body;
  const fake = (name: string) => fs.readFileSync(path.join(c.fakeDir, name), 'utf8');
  for (const scenario of ['chat', workerScenario])
    await eventually(
      c,
      () => fs.existsSync(path.join(c.fakeDir, `${scenario}.midturn`)),
      Boolean,
      `${scenario} mid-turn`
    );
  assert.match(fake(`${workerScenario}.before`), /^200 ok/, 'the Buddy tool works before Ctrl+C');
  const pids = {
    chat: Number(fake('chat.midturn')),
    worker: Number(fake(`${workerScenario}.midturn`)),
  };
  return { worker, chatId, request, pids, workerScenario, fake };
}

type Work = Awaited<ReturnType<typeof startWork>>;

/** Every process the terminal's group held is gone; the agents are not, and keep journaling. */
async function assertGroupGoneAgentsJournaling(c: Case, group: DevGroup, work: Work) {
  await group.exited;
  await eventually(
    c,
    () => processesIn(group.pgid),
    (left) => left.length === 0,
    `group ${group.pgid} empty`
  );
  for (const pid of Object.values(work.pids))
    assert.ok(alive(pid), 'the agent outlives the dev runtime');
  fs.writeFileSync(path.join(c.fakeDir, 'dead'), '');
  const journaled = () =>
    fs
      .readdirSync(path.join(c.dataDir, 'executions'))
      .map((id) => path.join(c.dataDir, 'executions', id, 'stdout'))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .filter((out) => out.includes('during;')).length;
  // Both the chat and the worker wrote their "during" output to their journals with no backend.
  await eventually(c, journaled, (n) => n >= 2, 'journal writes while no backend runs');
}

/** After the relaunch: ordered output, a Buddy tool call on the new backend, one completion each. */
async function assertAdoptedAndCompleted(c: Case, work: Work) {
  fs.writeFileSync(path.join(c.fakeDir, 'release'), '');
  const exists = (name: string) => fs.existsSync(path.join(c.fakeDir, name));
  await eventually(
    c,
    () => exists('chat.exited') && exists(`${work.workerScenario}.exited`),
    Boolean,
    'agents finished'
  );
  const chat = await eventually(
    c,
    () => http('GET', `/api/conversations/${work.chatId}`),
    (detail) => detail.status === 200 && detail.body.latestAttempt?.state === 'succeeded',
    'the adopted chat turn to end'
  );
  assert.equal(chat.body.latestAttempt.terminalCause, 'provider_complete');
  const page = await http(
    'GET',
    `/api/conversations/${work.chatId}/messages?afterSeq=-1&limit=200`
  );
  const messages = page.body.messages as Array<{
    role: string;
    body: { t: string; text?: string };
  }>;
  assert.equal(
    messages
      .filter((m) => m.role === 'assistant' && m.body.t === 'text')
      .map((m) => m.body.text)
      .join(''),
    'one;two;during;four;',
    'before, during and after Ctrl+C, once each, in order'
  );
  const system = messages.filter((m) => m.role === 'system').map((m) => m.body.text ?? '');
  assert.ok(
    !system.some((t) => /restart|interrupt/i.test(t)),
    `no false interruption: ${system.join(' | ')}`
  );

  assert.match(
    work.fake(`${work.workerScenario}.after`),
    /^200 ok/,
    'the same grant works on the new backend'
  );
  const run = await eventually(
    c,
    () => runOf(work.worker),
    (r) => r?.status === 'complete',
    'worker run complete'
  );
  assert.equal(run.errorCode ?? null, null);
  const thread = await http('GET', `/api/buddies/posts/${work.request.id}/thread`);
  const posts = (thread.body.posts ?? thread.body) as Array<{ body: string }>;
  assert.equal(
    posts.filter((p) => p.body === 'one;two;during;four;').length,
    1,
    'exactly one answer returns to the requester'
  );
  const spawned = fs.readFileSync(path.join(c.fakeDir, 'spawns.log'), 'utf8').trim().split('\n');
  assert.deepEqual(
    spawned.sort(),
    [`chat ${work.pids.chat}`, `${work.workerScenario} ${work.pids.worker}`].sort(),
    'one spawn per turn, and the adopted process is that same pid'
  );
}

// Fix-guard: adopted turns run under the agent-cli journal wrapper, which is deliberately outside
// the dev server's process group (it must survive the backend). Killing the group and the fake's
// `.pgid` files therefore missed them: fake `claude` processes parented to PID 1 piled up across
// runs (seen 2026-10-06, alive since 01:00). Any process whose command line names this case's
// temp root is ours (the root is a fresh mkdtemp dir), so sweep by that before deleting it.
function killProcessesUnder(root: string) {
  const rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  for (const row of rows) {
    const [pid, ...command] = row.trim().split(/\s+/);
    if (Number(pid) === process.pid || !command.join(' ').includes(root)) continue;
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
}

async function stopGroup(group: DevGroup) {
  signalGroup(group.pgid, 'SIGINT');
  await Promise.race([group.exited, new Promise((resolve) => setTimeout(resolve, 20_000))]);
  signalGroup(group.pgid, 'SIGKILL');
}

after(async () => {
  for (const group of groups) await stopGroup(group);
  for (const c of cases) {
    if (!c.finished)
      console.error(
        `[${c.root}] unfinished, waiting for ${c.waitingFor}:\n${c.log.slice(-80).join('\n')}`
      );
    for (const file of fs.existsSync(c.fakeDir) ? fs.readdirSync(c.fakeDir) : []) {
      if (!file.endsWith('.pgid')) continue;
      signalGroup(Number(fs.readFileSync(path.join(c.fakeDir, file), 'utf8')), 'SIGKILL');
    }
    killProcessesUnder(c.root);
    fs.rmSync(c.root, { recursive: true, force: true });
  }
});

test(
  'one Ctrl+C on pnpm dev:server: agents survive and the relaunched backend adopts them',
  { timeout: 300_000 },
  async () => {
    const c = makeCase('single');
    const first = launch(c, 'A');
    await first.ready;
    const work = await startWork(c, 'worker');
    signalGroup(first.pgid, 'SIGINT');
    await assertGroupGoneAgentsJournaling(c, first, work);
    // One press is a graceful stop. Until 2026-10-01 pnpm's relay of the same SIGINT counted as a
    // second press and the supervisor SIGKILLed the backend ~30 ms into its shutdown.
    assert.ok(
      c.log.some((l) => l.includes('Backend stopped (exit 0)')),
      `one Ctrl+C exits gracefully:\n${c.log.filter((l) => l.includes('server-watch')).join('\n')}`
    );
    const second = launch(c, 'B');
    await second.ready;
    await assertAdoptedAndCompleted(c, work);
    await stopGroup(second);
    c.finished = true;
  }
);

test(
  'two Ctrl+C (supervisor escalates to SIGKILL): agents survive and are adopted',
  { timeout: 300_000 },
  async () => {
    const c = makeCase('double');
    const first = launch(c, 'A');
    await first.ready;
    const work = await startWork(c, 'worker');
    // A message queued behind the running turn is in-memory work: the first press waits up to
    // 3 s for it (lifecycle/shutdown.ts), which is the wait a user cuts short by pressing again.
    await wsCommand({ type: 'queue_message', conversationId: work.chatId, content: 'queued' });
    signalGroup(first.pgid, 'SIGINT');
    await eventually(
      c,
      () => c.log.some((l) => l.includes('SIGINT — shutting down')),
      Boolean,
      'backend saw SIGINT'
    );
    // A human second press: well outside the supervisor's relay window.
    await new Promise((resolve) => setTimeout(resolve, 400));
    signalGroup(first.pgid, 'SIGINT');
    await assertGroupGoneAgentsJournaling(c, first, work);
    // The supervisor's escalation, not the backend's own SIGINT exit, is what ended the backend.
    assert.ok(
      c.log.some((l) => l.includes('Backend stopped (signal SIGKILL)')),
      `second Ctrl+C escalated to SIGKILL:\n${c.log.filter((l) => l.includes('server-watch')).join('\n')}`
    );
    const second = launch(c, 'B');
    await second.ready;
    await assertAdoptedAndCompleted(c, work);
    await stopGroup(second);
    c.finished = true;
  }
);

test(
  'pnpm dev:server --replace over a running runtime: agents survive and are adopted',
  { timeout: 300_000 },
  async () => {
    const c = makeCase('replace');
    const first = launch(c, 'A');
    await first.ready;
    const work = await startWork(c, 'worker');
    const second = launch(c, 'B', ['--replace']);
    await assertGroupGoneAgentsJournaling(c, first, work);
    await second.ready;
    await assertAdoptedAndCompleted(c, work);
    await stopGroup(second);
    c.finished = true;
  }
);

/**
 * Bodies the worker posted to its DM with the owner. The channel id comes from the worker's
 * `before` call, which landed while backend A ran.
 */
async function ownerDmBodies(c: Case, scenario: string): Promise<string[]> {
  const raw = fs.readFileSync(path.join(c.fakeDir, `${scenario}-before.raw`), 'utf8');
  const channelId = /channelId\\*":\\*"([^"\\]+)/.exec(raw)?.[1];
  assert.ok(channelId, `no channel id in ${raw}`);
  const page = await http('GET', `/api/buddies/channels/${channelId}/posts`);
  return (page.body.posts as Array<{ body: string }>).map((post) => post.body);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Task task_01a0f65c. Until the relay (server/relay/buddy-mcp-relay.mjs), this call got
// ECONNREFUSED: neither claude nor codex retries that, so the post was lost unless the model chose
// to try again (agent_notes/2026-10-05_outage-tool-delivery.md). Now the relay, which outlives the
// Ctrl+C, holds the call and the relaunched backend delivers it.
test(
  'a ~10 s outage: a Buddy post made with no backend lands once after relaunch; its replay creates nothing',
  { timeout: 300_000 },
  async () => {
    const c = makeCase('downtime');
    const first = launch(c, 'A');
    await first.ready;
    const work = await startWork(c, 'down');
    signalGroup(first.pgid, 'SIGINT');
    await assertGroupGoneAgentsJournaling(c, first, work);
    await eventually(
      c,
      () => fs.existsSync(path.join(c.fakeDir, 'down.gap-sent')),
      Boolean,
      'tool call in the gap'
    );
    await sleep(10_000);
    assert.ok(
      !fs.existsSync(path.join(c.fakeDir, 'down.gap')),
      `held while no backend runs, not failed: ${fs.existsSync(path.join(c.fakeDir, 'down.gap')) && work.fake('down.gap')}`
    );
    const second = launch(c, 'B');
    await second.ready;
    await eventually(
      c,
      () => fs.existsSync(path.join(c.fakeDir, 'down.gap')),
      Boolean,
      'the held call to return'
    );
    assert.match(work.fake('down.gap'), /^200 ok/, 'the in-gap post was delivered');
    await assertAdoptedAndCompleted(c, work);
    // The same call again with the same key (a CLI or model retry) replays the first result.
    assert.match(work.fake('down.replay'), /^200 ok/);
    const bodies = await ownerDmBodies(c, 'down');
    assert.equal(bodies.filter((b) => b === 'down in-gap').length, 1, 'exactly once');
    await stopGroup(second);
    c.finished = true;
  }
);

test(
  'an outage longer than the hold: the in-gap call gets a clear tool error at ~55 s, never a hang',
  { timeout: 300_000 },
  async () => {
    const c = makeCase('longdown');
    const first = launch(c, 'A');
    await first.ready;
    const work = await startWork(c, 'longdown');
    signalGroup(first.pgid, 'SIGINT');
    await assertGroupGoneAgentsJournaling(c, first, work);
    await eventually(
      c,
      () => fs.existsSync(path.join(c.fakeDir, 'longdown.gap')),
      Boolean,
      'the held call to give up'
    );
    const gap = work.fake('longdown.gap');
    assert.match(gap, /^200 tool-error .*NOT delivered/, gap);
    // Before claude's own 60 s request timeout, so the model reads the relay's message.
    const waited = Number(work.fake('longdown.gap-ms'));
    assert.ok(waited >= 50_000 && waited < 60_000, `held ${waited} ms`);
    const second = launch(c, 'B');
    await second.ready;
    await assertAdoptedAndCompleted(c, work);
    assert.deepEqual(
      (await ownerDmBodies(c, 'longdown')).filter((b) => b === 'longdown in-gap'),
      [],
      'the call that got the error never lands later'
    );
    await stopGroup(second);
    c.finished = true;
  }
);

test(
  'a turn Stopped before the outage: its call held through the outage gets 401, never a post',
  { timeout: 300_000 },
  async () => {
    const c = makeCase('stopped');
    const first = launch(c, 'A');
    await first.ready;
    const work = await startWork(c, 'stopped');
    const run = await runOf(work.worker);
    const cancelled = await http('POST', `/api/buddies/runs/${run.id}/cancel`);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    // Stop is durable (`stopping` on disk) and kills the CLI's group; the detached child that
    // holds the grant's token lives on and calls during the outage.
    await eventually(
      c,
      () => alive(work.pids.worker),
      (a) => !a,
      'the stopped CLI to exit'
    );
    signalGroup(first.pgid, 'SIGINT');
    await first.exited;
    fs.writeFileSync(path.join(c.fakeDir, 'dead'), '');
    await eventually(
      c,
      () => fs.existsSync(path.join(c.fakeDir, 'stopped.gap-sent')),
      Boolean,
      'tool call in the gap'
    );
    await sleep(3_000);
    const second = launch(c, 'B');
    await second.ready;
    await eventually(
      c,
      () => fs.existsSync(path.join(c.fakeDir, 'stopped.gap')),
      Boolean,
      'the held call to return'
    );
    assert.match(work.fake('stopped.gap'), /^401 /, "a stopped turn's grant is not restored");
    assert.deepEqual(
      (await ownerDmBodies(c, 'stopped')).filter((b) => b === 'stopped in-gap'),
      []
    );
    fs.writeFileSync(path.join(c.fakeDir, 'release'), '');
    await stopGroup(second);
    c.finished = true;
  }
);

// Manual, never in CI: a REAL claude CLI through the same Ctrl+C → 30 s down → relaunch, on fresh
// empty temp stores. It spends real tokens, so it runs only with UNLEASHD_REAL_CLAUDE=1. The CLI
// authenticates from the real home (its credentials live there), so its one session transcript
// lands in ~/.claude/projects; the test deletes that directory afterwards.
test(
  'manual: a real claude worker survives Ctrl+C and 30 s with no backend',
  { skip: process.env.UNLEASHD_REAL_CLAUDE !== '1', timeout: 600_000 },
  async () => {
    const c = makeCase('real');
    const realClaude = execFileSync('/bin/zsh', ['-lc', 'whence -p claude'], {
      encoding: 'utf8',
    }).trim();
    const bin = path.join(c.root, 'bin');
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/bin/sh\nexec env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_EXECPATH -u CLAUDE_PID HOME="${REAL_HOME}" "${realClaude}" "$@"\n`,
      { mode: 0o755 }
    );
    const model = process.env.UNLEASHD_REAL_CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
    const report: Record<string, unknown> = { model };
    const first = launch(c, 'A');
    await first.ready;
    const ws = await http('POST', '/api/buddies/workspaces', {
      name: 'real',
      rootPath: c.workspaceDir,
    });
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const hired = await http('POST', '/api/buddies', {
      workspaceId: ws.body.id,
      slug: 'real',
      name: 'real',
      role: 'continuity check',
      provider: 'claude',
      model,
      reasoningEffort: 'low',
      key: 'hire-real',
    });
    assert.equal(hired.status, 201, JSON.stringify(hired.body));
    const buddy = hired.body.id as string;
    const buddyDm = await http('POST', `/api/buddies/${buddy}/direct`);
    const posted = await http('POST', `/api/buddies/channels/${buddyDm.body.channelId}/posts`, {
      kind: 'request',
      body: [
        'Manual continuity check. Do exactly these steps and nothing else:',
        '1. Run the shell command `sleep 15` with your Bash tool.',
        '2. Call the Buddy `post` tool once: channel {"direct":["owner"]}, body "real after sleep", key "real-after-sleep".',
        `3. If step 2 returned any error, wait for the backend with Bash: \`until curl -s -o /dev/null http://127.0.0.1:${PORT}/; do sleep 2; done\` (timeout 180000 ms), then call the same \`post\` once more with body "real retry" and key "real-retry".`,
        '4. Answer with the word FINISHED and one line quoting exactly what each post call returned.',
      ].join('\n'),
      key: 'ask-real',
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const request = posted.body.post ?? posted.body;
    const executions = path.join(c.dataDir, 'executions');
    const journal = await eventually(
      c,
      () =>
        (fs.existsSync(executions) ? fs.readdirSync(executions) : [])
          .map((id) => path.join(executions, id))
          .find(
            (dir) =>
              fs.existsSync(path.join(dir, 'stdout')) &&
              /sleep 15/.test(fs.readFileSync(path.join(dir, 'stdout'), 'utf8'))
          ),
      Boolean,
      'the real CLI to start its sleep'
    );
    assert.ok(journal);
    const wrapper = Number(fs.readFileSync(path.join(journal, 'pid'), 'utf8'));
    const size = () => fs.statSync(path.join(journal, 'stdout')).size;
    signalGroup(first.pgid, 'SIGINT');
    await first.exited;
    await eventually(
      c,
      () => processesIn(first.pgid),
      (left) => left.length === 0,
      'group empty'
    );
    report.bytesAtCtrlC = size();
    report.aliveAfterCtrlC = alive(wrapper);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    report.bytesAfter30sDown = size();
    report.aliveAfter30sDown = alive(wrapper);
    // What the CLI wrote with no backend at all: its tool calls, their results, its answer.
    const gap = fs
      .readFileSync(path.join(journal, 'stdout'), 'utf8')
      .slice(Number(report.bytesAtCtrlC));
    if (process.env.CTRLC_LOG_FILE)
      fs.writeFileSync(`${process.env.CTRLC_LOG_FILE}.gap.jsonl`, gap);
    report.writtenWhileDown = gap
      .split('\n')
      .filter((line) => /^\{"type":"(assistant|user|result)"/.test(line))
      .map((line) => {
        const event = JSON.parse(line);
        if (event.type === 'result') return `result ${event.subtype}: ${event.result}`;
        return (event.message.content as Array<Record<string, unknown>>)
          .map((part) =>
            part.type === 'text'
              ? `text: ${part.text}`
              : part.type === 'tool_use'
                ? `tool_use ${part.name} ${JSON.stringify(part.input)}`
                : `${part.type} ${String(JSON.stringify(part.content ?? '')).slice(0, 500)}`
          )
          .join(' | ');
      });
    const second = launch(c, 'B');
    await second.ready;
    const run = await eventually(
      c,
      () => runOf(buddy),
      (r) => ['complete', 'failed', 'cancelled'].includes(r?.status),
      'the real run to settle'
    );
    report.run = { status: run.status, error: run.error ?? null };
    const dm = await http('GET', `/api/buddies/channels/${request.channelId}/posts`);
    report.buddyPosts = (
      (dm.body.posts ?? dm.body) as Array<{ body: string; author: { id?: string } }>
    )
      .filter((p) => p.author.id === buddy)
      .map((p) => p.body);
    const thread = await http('GET', `/api/buddies/posts/${request.id}/thread`);
    report.answer = (
      (thread.body.posts ?? thread.body) as Array<{ body: string; author: { id?: string } }>
    )
      .filter((p) => p.author.id === buddy)
      .map((p) => p.body);
    console.log(`[real claude] ${JSON.stringify(report, null, 2)}`);
    await stopGroup(second);
    c.finished = true;
    fs.rmSync(
      path.join(
        REAL_HOME,
        '.claude',
        'projects',
        fs.realpathSync(c.workspaceDir).replace(/[^a-zA-Z0-9]/g, '-')
      ),
      {
        recursive: true,
        force: true,
      }
    );
    assert.equal(run.status, 'complete');
  }
);
