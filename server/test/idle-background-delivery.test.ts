import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { NO_AUTO_INSTALL } from './fixtures/backend-env';
import { freePortSync } from './free-port';

/**
 * task_01a11aa8 (owner, 2026-10-08): Game Designer's model ended its turn at 07:09:56 after
 * launching a background Workflow; the Claude process lived 29.5 min more with ZERO tool calls,
 * and the owner's 07:14 and 07:20 posts queued behind "replying…" until the Workflow finished.
 * Tool-boundary steering cannot fire with no tool calls. Evidence:
 * agent_notes/2026-10-08_game-designer-art-lead-trace-findings.md.
 *
 * Real boundary: the actual backend (server.ts) on temp stores, and a fake `claude` that behaves
 * like `claude -p` 2.1.294 as probed (agent_notes/2026-10-08_idle-background-delivery.md): after
 * its model turn ends with a background job still running, it runs the Stop hook its `--settings`
 * declares, with `background_tasks` in the hook input, and holds until the hook returns. A
 * `decision: block` continues the model in the same process with the reason; a job that ends
 * while the hook holds still streams its task_notification at once. With no Stop hook it waits
 * for the job, then handles the notice as a new model turn, still in the same process.
 */

const TOKEN = 'c1d2e3f4a5b6c7d8c1d2e3f4a5b6c7d8';

const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dir = process.env.FAKE_DIR;
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => main());
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const text = (t) => say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const file = (name) => path.join(dir, name);
const mark = (name, value = '') => fs.appendFileSync(file(name), String(value));
const settings = () => {
  const at = process.argv.indexOf('--settings');
  return at < 0 ? {} : JSON.parse(process.argv[at + 1]);
};
// The turn's Buddy tools, as execution-adoption.test.ts calls them: a reply is a post.
async function post(body, key) {
  const i = process.argv.indexOf('--mcp-config');
  const server = Object.values(JSON.parse(process.argv[i + 1]).mcpServers)[0];
  const auth = server.headers.Authorization.replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] ?? '');
  const thread = JSON.parse(fs.readFileSync(file('thread.json'), 'utf8'));
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post', arguments: { channel: { id: thread.channelId }, replyToId: thread.rootId, body, key } } }),
  });
  mark('posts', response.status + ' ' + (await response.text()).includes('"isError":true') + '\n');
}
function runHook(command, input) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}
async function main() {
  // Every Buddy turn carries a prompt; the backend's CLI probes send none.
  if (prompt.trim()) mark('turns', process.pid + '\n');
  say({ type: 'system', subtype: 'init', session_id: 'fake-' + process.pid });
  if (/SCENARIO:fanout/.test(prompt)) return fanout();
  if (!/SCENARIO:bgidle/.test(prompt)) { text('ok'); say({ type: 'result', subtype: 'success' }); return; }
  mark('pgid', process.pid);
  say({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } } });
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'sleep 600', run_in_background: true }) } } });
  say({ type: 'stream_event', event: { type: 'content_block_stop' } });
  say({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'toolu_bg1', description: 'long job', is_backgrounded: true, task_type: 'local_bash' });
  text('launched;');
  // The model's turn is over; only the background job keeps this process alive.
  let jobDone = false;
  const job = new Promise((resolve) => {
    const t = setInterval(() => {
      if (!fs.existsSync(file('go'))) return;
      clearInterval(t);
      jobDone = true;
      say({ type: 'system', subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'toolu_bg1', status: 'completed', summary: 'long job completed' });
      resolve();
    }, 25);
  });
  mark('idle');
  const stop = settings().hooks?.Stop?.[0]?.hooks?.[0]?.command;
  for (let active = false; stop; active = true) {
    const input = { hook_event_name: 'Stop', stop_hook_active: active, background_tasks: jobDone ? [] : [{ id: 'bg1', type: 'shell', status: 'running', description: 'long job' }] };
    const result = await runHook(stop, input);
    const decision = result.out.trim() ? JSON.parse(result.out) : {};
    if (decision.decision !== 'block') break;
    mark('steered', JSON.stringify({ at: Date.now(), jobDone, reason: decision.reason }) + '\n');
    await post('Switching to a 3x3x3 board; the long job keeps running.', 'answer');
  }
  say({ type: 'result', subtype: 'success', result: 'launched' });
  await job;
  await post('The long job finished.', 'finished');
  mark('notice-handled');
  say({ type: 'result', subtype: 'success', result: 'bg finished' });
}
// Execution 29c47118 as it ran: the model idle on a background Workflow, its sub-agents calling the
// PostToolUse hook (with agent_id) over and over, and NO Stop hook: spawned before 83fd4e1, so the
// parent is never called back until the Workflow ends and the model takes a new turn.
async function fanout() {
  mark('pgid', process.pid);
  say({ type: 'system', subtype: 'task_started', task_id: 'wf1', tool_use_id: 'toolu_wf1', description: 'workflow', is_backgrounded: true, task_type: 'local_workflow' });
  text('launched;');
  say({ type: 'result', subtype: 'success', result: 'launched' });
  mark('idle');
  const tool = settings().hooks.PostToolUse[0].hooks[0].command;
  const context = async (input) => {
    const out = (await runHook(tool, input)).out.trim();
    return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
  };
  while (!fs.existsSync(file('go'))) {
    for (const agent_id of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      const shown = await context({ hook_event_name: 'PostToolUse', agent_id, tool_name: 'Bash' });
      if (shown) mark('notices', JSON.stringify({ agent_id, shown }) + '\n');
    }
    mark('rounds', '.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  say({ type: 'system', subtype: 'task_notification', task_id: 'wf1', tool_use_id: 'toolu_wf1', status: 'completed', summary: 'workflow completed' });
  // The Workflow's notice is a new model turn in this process; its first tool use is the parent's.
  mark('parent', await context({ hook_event_name: 'PostToolUse', tool_name: 'Read' }));
  await post('Switching to a 3x3x3 board.', 'answer');
  say({ type: 'result', subtype: 'success', result: 'done' });
}
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-idle-bg-'));
const home = path.join(root, 'home');
const fakeDir = path.join(root, 'fake');
const bin = path.join(root, 'bin');
const workspaceDir = path.join(root, 'workspace');
const log: string[] = [];
let backend: ChildProcess | null = null;

async function stopBackend(): Promise<void> {
  if (!backend || backend.exitCode !== null) return;
  const exited = new Promise((resolve) => backend?.once('exit', resolve));
  backend.kill('SIGKILL');
  await exited;
}

function startBackend(port: number): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOME: home,
      ...NO_AUTO_INSTALL,
      // The fake, node, and /usr/bin for the hook's curl: never a real agent CLI.
      PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      PORT: String(port),
      UNLEASHD_DATA_DIR: path.join(root, 'data'),
      UNLEASHD_BUDDY_EXECUTION: '1',
      UNLEASHD_AUTH_TOKEN: TOKEN,
      FAKE_DIR: fakeDir,
      NODE_ENV: 'test',
      CWV_BUDDY_RUNNER_BACKSTOP_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  backend = child;
  const record = (chunk: Buffer) => log.push(...chunk.toString().split('\n'));
  child.stderr?.on('data', record);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no start: ${log.slice(-40).join('\n')}`)),
      60_000
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      record(chunk);
      if (chunk.toString().includes('Buddy runner started')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`exited ${code}: ${log.slice(-40).join('\n')}`)));
  });
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

async function eventually<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, what: string) {
  const deadline = Date.now() + 30_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out: ${what}; last: ${JSON.stringify(last)}\n${log.slice(-60).join('\n')}`
  );
}

const fake = (name: string) => path.join(fakeDir, name);
const readFake = (name: string) =>
  fs.existsSync(fake(name)) ? fs.readFileSync(fake(name), 'utf8') : '';

before(() => {
  for (const d of [home, fakeDir, bin, workspaceDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
});

after(async () => {
  await stopBackend();
  if (readFake('pgid'))
    try {
      process.kill(-Number(readFake('pgid')), 'SIGKILL');
    } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  'an owner post reaches a Buddy whose model is idle while its background job runs',
  { timeout: 120_000 },
  async () => {
    const port = freePortSync();
    const http = api(port);
    await startBackend(port);
    const ws = await http('POST', '/api/buddies/workspaces', {
      name: 'bg',
      rootPath: workspaceDir,
    });
    const buddy = await http('POST', '/api/buddies', {
      workspaceId: ws.body.id,
      slug: 'designer',
      name: 'Designer',
      role: 'test worker',
      provider: 'claude',
      key: 'hire-designer',
    });
    const buddyId = buddy.body.id as string;
    // A channel thread, as in the incident: an @mention delivery shows "Designer is replying…".
    const channel = await http('POST', `/api/buddies/workspaces/${ws.body.id}/channels`, {
      name: 'game',
      purpose: 'the incident thread',
      key: 'channel',
    });
    const channelId = channel.body.id as string;
    const asked = await http('POST', `/api/buddies/channels/${channelId}/posts`, {
      kind: 'inform',
      body: `[@Designer](buddy:${buddyId}) Run the long job. SCENARIO:bgidle`,
      key: 'ask',
    });
    const rootId = (asked.body.post ?? asked.body).id as string;
    fs.writeFileSync(fake('thread.json'), JSON.stringify({ channelId, rootId }));
    await eventually(() => fs.existsSync(fake('idle')), Boolean, 'the model turn to end');

    // The status line names the state: neither "replying" nor queued at the run limit.
    const status = await eventually(
      async () => (await http('GET', `/api/buddies/channels/${channelId}/responding`)).body,
      (rows) => rows.some((r: { state: string }) => r.state === 'background'),
      'the background-work status'
    );
    assert.equal(status.length, 1, JSON.stringify(status));

    const correction = await http('POST', `/api/buddies/channels/${channelId}/posts`, {
      kind: 'inform',
      body: `[@Designer](buddy:${buddyId}) While that runs: use a 3x3x3 board.`,
      replyToId: rootId,
      key: 'correction',
    });
    assert.equal(correction.status, 201, JSON.stringify(correction.body));
    const correctionId = (correction.body.post ?? correction.body).id as string;

    // Delivered into the live process while the job still runs, framed and marked read.
    const steered = await eventually(
      () => readFake('steered'),
      Boolean,
      'the post to reach the model'
    );
    const delivered = JSON.parse(steered.trim().split('\n')[0]);
    assert.equal(delivered.jobDone, false, 'answered before the background job ended');
    assert.match(delivered.reason, /While you were working/);
    assert.ok(delivered.reason.includes('use a 3x3x3 board'), delivered.reason);
    const runs = async () => {
      const r = await http('GET', `/api/buddies/runs?buddyId=${buddyId}`);
      return (r.body.runs ?? r.body) as Array<{
        status: string;
        errorCode?: string | null;
        input: { kind: string; postId?: string };
      }>;
    };
    const delivery = (await runs()).find((r) => r.input.postId === correctionId);
    assert.equal(delivery?.errorCode, 'consumed', JSON.stringify(delivery));
    assert.equal(readFake('turns').trim().split('\n').length, 1, 'no second process');
    assert.ok(!fs.existsSync(fake('notice-handled')), 'the job was not ended early');
    const thread = async () => (await http('GET', `/api/buddies/posts/${rootId}/thread`)).body;
    await eventually(
      async () => JSON.stringify(await thread()),
      (page) => page.includes('Switching to a 3x3x3 board'),
      'the answer in the thread'
    );

    // The job's completion is still processed afterwards, and the turn then settles.
    fs.writeFileSync(fake('go'), '');
    await eventually(() => fs.existsSync(fake('notice-handled')), Boolean, 'the job notice');
    await eventually(
      async () => (await runs()).find((r) => r.input.postId === rootId),
      (r) => r?.status === 'complete',
      'the run to complete'
    );
    assert.equal(readFake('turns').trim().split('\n').length, 1, 'still one process');
    assert.equal(readFake('posts'), '200 false\n200 false\n', 'both replies posted');
    assert.deepEqual((await http('GET', `/api/buddies/channels/${channelId}/responding`)).body, []);
  }
);

/**
 * task_01a11af2 (owner, 2026-10-08): execution 29c47118 carried only the PostToolUse hook it was
 * spawned with. Its model sat idle on a 27-agent background Workflow, the owner's 09:30 post went
 * into the SUB-agents 35 times (once per agent id, from host memory, again after the 09:40
 * restart), never to the parent, and the thread said "waiting for the current turn" for 25+ min.
 * Here: one notice in total across every sub-agent and a backend restart; a status that says what
 * reaches the turn (and, for a process from before hook sets were recorded, that it cannot); and
 * the parent takes the post at its own first tool use. Table: agent_notes/2026-10-08_waiting-paths.md.
 */
test(
  'sub-agents of a frozen-hook turn get one notice across a restart, and the parent takes the post',
  { timeout: 180_000 },
  async () => {
    for (const name of ['idle', 'go', 'notices', 'rounds', 'parent', 'turns', 'posts', 'pgid'])
      fs.rmSync(fake(name), { force: true });
    const port = freePortSync();
    const http = api(port);
    await startBackend(port);
    const ws = await http('POST', '/api/buddies/workspaces', { name: 'fan', rootPath: workspaceDir });
    const buddy = await http('POST', '/api/buddies', {
      workspaceId: ws.body.id,
      slug: 'fan-designer',
      name: 'Fan Designer',
      role: 'test worker',
      provider: 'claude',
      key: 'hire-fan-designer',
    });
    const buddyId = buddy.body.id as string;
    const channel = await http('POST', `/api/buddies/workspaces/${ws.body.id}/channels`, {
      name: 'fan',
      purpose: 'the 29c47118 thread',
      key: 'fan-channel',
    });
    const channelId = channel.body.id as string;
    const asked = await http('POST', `/api/buddies/channels/${channelId}/posts`, {
      kind: 'inform',
      body: `[@Fan Designer](buddy:${buddyId}) Run the sweep. SCENARIO:fanout`,
      key: 'fan-ask',
    });
    const rootId = (asked.body.post ?? asked.body).id as string;
    fs.writeFileSync(fake('thread.json'), JSON.stringify({ channelId, rootId }));
    await eventually(() => readFake('rounds').length, (n) => n > 0, 'the sub-agents to run');

    const correction = await http('POST', `/api/buddies/channels/${channelId}/posts`, {
      kind: 'inform',
      body: `[@Fan Designer](buddy:${buddyId}) While that runs: use a 3x3x3 board.`,
      replyToId: rootId,
      key: 'fan-correction',
    });
    const correctionId = (correction.body.post ?? correction.body).id as string;
    const rounds = async (more: number) => {
      const from = readFake('rounds').length;
      await eventually(() => readFake('rounds').length, (n) => n >= from + more, 'sub-agent rounds');
    };
    const notices = () => readFake('notices').trim().split('\n').filter(Boolean);
    const responding = async () =>
      (await http('GET', `/api/buddies/channels/${channelId}/responding`)).body as Array<{
        state: string;
        waiting?: { kind: string };
        reach?: { kind: string };
      }>;
    await rounds(3);
    assert.equal(notices().length, 1, `one notice for five sub-agents: ${notices().join('\n')}`);
    assert.ok(notices()[0].includes('use a 3x3x3 board'), notices()[0]);
    const queued = (await responding()).find((row) => row.state === 'queued');
    assert.equal(queued?.waiting?.kind, 'conversation_busy', JSON.stringify(queued));
    assert.equal(queued?.reach?.kind, 'next_step', 'a turn spawned with the stable hook set');

    // A backend restart adopts the turn. Its journal is rewritten as a backend from before hook
    // sets were recorded wrote it: no `hooks` on the grant.
    await stopBackend();
    const executions = path.join(root, 'data', 'executions');
    const journal = fs
      .readdirSync(executions)
      .map((name) => path.join(executions, name, 'owner.json'))
      .find((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('SCENARIO:fanout'));
    assert.ok(journal, 'the turn journal');
    const owner = JSON.parse(fs.readFileSync(journal, 'utf8'));
    delete owner.policy.grant.hooks;
    fs.writeFileSync(journal, JSON.stringify(owner));
    await startBackend(port);
    await rounds(3);
    assert.equal(notices().length, 1, `no notice again after the restart: ${notices().join('\n')}`);
    const adopted = (await responding()).find((row) => row.state === 'queued');
    assert.equal(adopted?.reach?.kind, 'spawned_before_live_delivery', JSON.stringify(adopted));

    // The Workflow ends; the model's new turn in the same process takes the post at its first tool.
    fs.writeFileSync(fake('go'), '');
    await eventually(() => readFake('parent'), (text) => text.includes('use a 3x3x3 board'), 'the parent to take it');
    assert.match(readFake('parent'), /While you were working/);
    const runs = (await http('GET', `/api/buddies/runs?buddyId=${buddyId}`)).body;
    const delivery = (runs.runs ?? runs).find(
      (r: { input: { postId?: string } }) => r.input.postId === correctionId
    );
    assert.equal(delivery?.errorCode, 'consumed', JSON.stringify(delivery));
    assert.equal(readFake('turns').trim().split('\n').length, 1, 'one process throughout');
  }
);
