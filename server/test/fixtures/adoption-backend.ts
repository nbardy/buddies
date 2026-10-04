import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WS_PATH, createDefaultConversationConfig } from '@unleashd/shared';
import { WebSocket } from 'ws';

/**
 * The real backend process (server.ts) on isolated temp stores, for tests that kill and replace
 * it while a provider turn runs (detached execution, docs/patterns.md#detached-execution). The
 * PATH holds the test's fake `claude`, node and system tools only, so no real agent CLI is
 * reachable; HOME, UNLEASHD_DATA_DIR and the Buddies stores live under one temp root.
 */

const TOKEN = 'b4d1c0e9f2b14658a7d3c0e9f2b14658';

export interface BackendCase {
  readonly port: number;
  readonly root: string;
  readonly home: string;
  readonly dataDir: string;
  readonly fakeDir: string;
  readonly workspaceDir: string;
  readonly log: string[];
  /** The live backend, if any. */
  backend: ChildProcess | null;
}

export function makeBackendCase(port: number, prefix: string, fakeClaude: string): BackendCase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `unleashd-${prefix}-`));
  const home = path.join(root, 'home');
  const fakeDir = path.join(root, 'fake');
  const bin = path.join(root, 'bin');
  const workspaceDir = path.join(root, 'workspace');
  for (const dir of [home, fakeDir, bin, workspaceDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), fakeClaude, { mode: 0o755 });
  // Anything routed to another harness (a memory review) fails at once instead of finding a real CLI.
  for (const other of ['codex', 'gemini', 'cursor-agent'])
    fs.writeFileSync(path.join(bin, other), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // node's own directory may also hold real agent CLIs: link node alone.
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  return {
    port,
    root,
    home,
    dataDir: path.join(home, '.agent-viewer'),
    fakeDir,
    workspaceDir,
    log: [],
    backend: null,
  };
}

/** Start server.ts; resolves once startup (adoption included) is complete. */
export function startBackend(
  c: BackendCase,
  name: string,
  extraEnv: Record<string, string> = {}
): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      HOME: c.home,
      PATH: [path.join(c.root, 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
        path.delimiter
      ),
      PORT: String(c.port),
      UNLEASHD_DATA_DIR: c.dataDir,
      UNLEASHD_BUDDIES_DB: path.join(c.home, '.buddies', 'buddies-v3.sqlite'),
      BUDDIES_HOME: path.join(c.home, '.buddies'),
      UNLEASHD_AUTH_TOKEN: TOKEN,
      FAKE_DIR: c.fakeDir,
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own group, like a supervisor-run backend: killing it must not reach the providers.
    detached: true,
  });
  c.backend = child;
  // The fake CLI may SIGKILL the backend at an exact moment (e.g. the instant Stop reaches it).
  fs.writeFileSync(path.join(c.fakeDir, 'backend.pid'), String(child.pid));
  const record = (chunk: Buffer) =>
    c.log.push(
      ...chunk
        .toString()
        .split('\n')
        .map((l) => `${new Date().toISOString().slice(14, 23)} [${name}] ${l}`)
    );
  child.stderr?.on('data', record);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} did not start: ${c.log.slice(-40).join('\n')}`)),
      90_000
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      record(chunk);
      if (chunk.toString().includes('Initial load complete')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited ${code ?? signal}: ${c.log.slice(-40).join('\n')}`));
    });
  });
}

/** Resolves when the backend process is gone, however it died. */
export function backendExited(c: BackendCase): Promise<void> {
  const child = c.backend;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

/** `promise`, or a loud failure after `ms`: a hung boundary never hangs the test file. */
export function within<T>(c: BackendCase, promise: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${what}\n${c.log.slice(-80).join('\n')}`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function killBackend(c: BackendCase): Promise<void> {
  const child = c.backend;
  c.backend = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

export async function http(c: BackendCase, method: string, route: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${c.port}${route}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function eventually<T>(
  c: BackendCase,
  read: () => Promise<T> | T,
  ok: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${what}; last: ${JSON.stringify(last)}\n${c.log.slice(-80).join('\n')}`
  );
}

/** One correlated WS command, resolved on its ack. */
export function wsCommand(c: BackendCase, command: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${c.port}${WS_PATH}`, {
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

/**
 * A WS command the server never acknowledges (stop_conversation). The socket stays open until
 * `done()` observes the command's effect: a socket closed right after sending can be torn down
 * before the server reads the frame, and the command is silently dropped.
 */
export function wsSend(
  c: BackendCase,
  command: Record<string, unknown>,
  done: () => boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${c.port}${WS_PATH}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const deadline = Date.now() + 30_000;
    const finish = (error?: Error) => {
      clearInterval(poll);
      socket.close();
      error ? reject(error) : resolve();
    };
    const poll = setInterval(() => {
      if (done()) finish();
      else if (Date.now() > deadline)
        finish(
          new Error(`no effect of ${JSON.stringify(command)}\n${c.log.slice(-40).join('\n')}`)
        );
    }, 50);
    socket.on('open', () => socket.send(JSON.stringify(command)));
    // A backend that dies of the command (the test's crash point) ends the socket: wait on `done`.
    socket.on('error', () => undefined);
  });
}

export function createChat(c: BackendCase, conversationId: string, message: string) {
  return wsCommand(c, {
    type: 'create_conversation',
    conversationId,
    workingDirectory: c.workspaceDir,
    config: createDefaultConversationConfig('claude'),
    initialMessage: message,
    kind: { t: 'chat' },
  });
}

/** A Buddy workspace rooted at the case's workspace directory. */
export async function workspace(c: BackendCase, name: string): Promise<string> {
  const ws = await http(c, 'POST', '/api/buddies/workspaces', {
    name,
    rootPath: c.workspaceDir,
  });
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  return ws.body.id as string;
}

export async function hire(c: BackendCase, workspaceId: string, slug: string): Promise<string> {
  const buddy = await http(c, 'POST', '/api/buddies', {
    workspaceId,
    slug,
    name: slug,
    role: 'test worker',
    provider: 'claude',
    key: `hire-${slug}`,
  });
  assert.equal(buddy.status, 201, JSON.stringify(buddy.body));
  return buddy.body.id as string;
}

/** An owner request to `buddyId` whose prompt carries `SCENARIO:<scenario>` for the fake CLI. */
export async function ask(c: BackendCase, buddyId: string, scenario: string) {
  const posted = await http(c, 'POST', '/api/buddies/direct/posts', {
    members: [buddyId],
    kind: 'request',
    body: `Please work. SCENARIO:${scenario}`,
    key: `ask-${scenario}`,
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  return (posted.body.post ?? posted.body) as { id: string; channelId: string };
}

export interface RunView {
  id: string;
  status: string;
  conversationId?: string;
  errorCode?: string;
  error?: string;
}

/** The buddy's request (`post`) run. */
export async function runOf(c: BackendCase, buddyId: string): Promise<RunView | undefined> {
  const runs = await http(c, 'GET', `/api/buddies/runs?buddyId=${buddyId}`);
  return (runs.body.runs ?? runs.body).find(
    (run: { input: { kind: string } }) => run.input.kind === 'post'
  );
}

export function fakeFile(c: BackendCase, name: string): string {
  return path.join(c.fakeDir, name);
}

export const fakeExists = (c: BackendCase, name: string) => fs.existsSync(fakeFile(c, name));
export const readFake = (c: BackendCase, name: string) =>
  fs.readFileSync(fakeFile(c, name), 'utf8');

export function spawnsOf(c: BackendCase, scenario: string): string[] {
  if (!fakeExists(c, 'spawns.log')) return [];
  return readFake(c, 'spawns.log')
    .trim()
    .split('\n')
    .filter((line) => line.startsWith(`${scenario} `));
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One JSON-RPC call with a turn's MCP credentials (as the agent would make it). */
export async function mcpCall(
  tools: { url: string; auth: string },
  method = 'tools/list'
): Promise<number> {
  const response = await fetch(tools.url, {
    method: 'POST',
    headers: {
      authorization: tools.auth,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  });
  await response.text();
  return response.status;
}

export function executionJournals(c: BackendCase): string[] {
  const root = path.join(c.dataDir, 'executions');
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

/** Kill every provider group the fake recorded, then delete the temp root. */
export async function disposeCase(c: BackendCase): Promise<void> {
  await killBackend(c);
  for (const file of fs.existsSync(c.fakeDir) ? fs.readdirSync(c.fakeDir) : []) {
    if (!file.endsWith('.pgid')) continue;
    try {
      process.kill(-Number(readFake(c, file)), 'SIGKILL');
    } catch {}
  }
  fs.rmSync(c.root, { recursive: true, force: true });
}

/**
 * The fake CLI's shared prelude: reads the prompt from stdin, then calls `main(scenario)`, which the
 * test supplies. Helpers: `say`, `text`, `mark`, `until(name)`, `mcp()`, `post(tools, body, key)`,
 * `killBackend()` (SIGKILL of the backend whose pid the test wrote to FAKE_DIR/backend.pid).
 */
export function fakeClaude(main: string): string {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const dir = process.env.FAKE_DIR;
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const scenario = (/SCENARIO:(\w+)/.exec(prompt) || [])[1];
  say({ type: 'system', subtype: 'init', session_id: 'fake-' + (scenario || 'other') + '-' + process.pid });
  if (!scenario) { text('ok'); say({ type: 'result', subtype: 'success' }); return; }
  fs.appendFileSync(path.join(dir, 'spawns.log'), scenario + ' ' + process.pid + '\n');
  mark(scenario + '.pgid', execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  const tools = mcp();
  if (tools) mark(scenario + '.tools', JSON.stringify(tools));
  main(scenario, tools).catch((e) => { fs.writeFileSync(path.join(dir, 'fatal-' + process.pid), String(e.stack)); process.exit(3); });
});
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const text = (t) => say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const mark = (name, value = '') => fs.writeFileSync(path.join(dir, name), String(value));
const until = (name) => new Promise((resolve) => { const t = setInterval(() => { if (fs.existsSync(path.join(dir, name))) { clearInterval(t); resolve(); } }, 25); });
const killBackend = () => { try { process.kill(Number(fs.readFileSync(path.join(dir, 'backend.pid'), 'utf8')), 'SIGKILL'); } catch {} };
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
    return response.status + ' ' + (raw.includes('"isError":true') ? 'tool-error' : 'ok');
  } catch (error) {
    return 'transport-error ' + (error.cause?.code ?? error.message);
  }
}
${main}
`;
}
