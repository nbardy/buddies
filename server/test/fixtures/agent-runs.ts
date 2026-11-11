import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { keyed } from '@unleashd/shared';
import type { RawOutcome, RunSpec, RunStatus } from '../../src/expedition-kernel/ports';
import type { AskAnswer } from '../../src/expeditions-v1/executor/asks';
import type { Read } from '../../src/expeditions-v1/executor/durable';
import type { RunRecord } from '../../src/expeditions-v1/executor/records';
import type { OwnerFile } from '../../src/expeditions-v1/owner/book';
import { freePortSync } from '../free-port';
import { NO_AUTO_INSTALL } from './backend-env';
import { tempDir } from './temp';

// The harness of expeditions-v1-*.test.ts: the REAL backend (server.ts) on temp stores (non-default
// data dir, so Buddy execution is opted in with UNLEASHD_BUDDY_EXECUTION=1), a temp git repo, and a
// fake `claude` on a PATH that holds no real agent CLI. The agent CLI is the only fake. The entry
// is either server.ts with a second keyed host beside it and a control port for its ports
// (`expedition-backend`, expedition-backend.ts), or server.ts alone (`server`: its own keyed
// host, driven through its HTTP routes, expeditions-v1-server.test.ts).

// One CLI for every scenario, chosen by markers in its prompt (the request body is in it):
// TAG:<name> names the turn's files in FAKE_DIR; MODE:<mode> picks what it does; ANSWER_JSON:<json>
// is what it answers. A prompt with no TAG (a memory reviewer would be one, but it runs on the fake
// codex) answers at once. A leader wake (its body starts "Leader wake leader/<n> of expedition
// <id>") is named `leader-<id>-<n>`: it records its prompt and argv, then waits for the test's script
// `<name>.json` ({ files: {path: text}, answer: text }), writes the files into its working
// directory (the draft folder) and answers `answer` verbatim.
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
const git = (...args) => execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim();
function mcp() {
  const i = process.argv.indexOf('--mcp-config');
  if (i < 0) return null;
  const server = Object.values(JSON.parse(process.argv[i + 1]).mcpServers)[0];
  const auth = server.headers.Authorization.replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] ?? '');
  return { url: server.url, auth };
}
async function rpc(tools, method, params) {
  const response = await fetch(tools.url, {
    method: 'POST',
    headers: { authorization: tools.auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const raw = await response.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : raw);
}
// The Buddy tools the turn is shown; a turn given no MCP server (an expedition call) is shown none.
async function listTools(name) {
  const tools = mcp();
  mark(name + '.tools', tools ? JSON.stringify((await rpc(tools, 'tools/list', {})).result.tools.map((t) => t.name)) : '[]');
}
function answer() {
  const json = (/ANSWER_JSON:(.*)$/m.exec(prompt) || [])[1];
  text('Here is my answer.\n\n');
  const fence = String.fromCharCode(96).repeat(3);
  text(json === undefined ? 'no answer marker' : fence + 'json\n' + json + '\n' + fence);
  say({ type: 'result', subtype: 'success' });
}
function transcript(sessionId, tokens) {
  const projects = path.join(process.env.HOME, '.claude', 'projects', 'fake-' + sessionId);
  fs.mkdirSync(projects, { recursive: true });
  const at = new Date().toISOString();
  const line = { type: 'assistant', sessionId, cwd: process.cwd(), timestamp: at, uuid: 'a-' + sessionId,
    message: { role: 'assistant', id: 'msg-' + sessionId, model: 'claude-opus-5-5', usage: tokens, content: [{ type: 'text', text: 'working' }] } };
  fs.writeFileSync(path.join(projects, sessionId + '.jsonl'), JSON.stringify(line) + '\n');
}
async function leader(name) {
  fs.appendFileSync(path.join(dir, 'spawns.log'), name + ' ' + process.pid + '\n');
  mark(name + '.pgid', execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  mark(name + '.cwd', process.cwd());
  mark(name + '.prompt', prompt);
  mark(name + '.argv', JSON.stringify(process.argv.slice(2)));
  await listTools(name);
  text('reading;');
  mark(name + '.midturn', process.pid);
  await until(name + '.json');
  const script = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));
  for (const [file, body] of Object.entries(script.files || {})) fs.writeFileSync(path.join(process.cwd(), file), body);
  text(script.answer);
  say({ type: 'result', subtype: 'success' });
}
async function main() {
  const wake = /Leader wake leader\/(\d+) of expedition (\S+) /.exec(prompt);
  if (wake) {
    say({ type: 'system', subtype: 'init', session_id: 'fake-leader-' + process.pid });
    return leader('leader-' + wake[2] + '-' + wake[1]);
  }
  const tag = (/TAG:(\w+)/.exec(prompt) || [])[1];
  const mode = (/MODE:(\w+)/.exec(prompt) || [])[1];
  const session = 'fake-' + (tag || 'other') + '-' + process.pid;
  say({ type: 'system', subtype: 'init', session_id: session });
  if (!tag) { text('ok'); say({ type: 'result', subtype: 'success' }); return; }
  fs.appendFileSync(path.join(dir, 'spawns.log'), tag + ' ' + process.pid + '\n');
  mark(tag + '.pgid', execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  mark(tag + '.cwd', process.cwd());
  mark(tag + '.prompt', prompt);
  mark(tag + '.argv', JSON.stringify(process.argv.slice(2)));
  await listTools(tag);
  const tools = mcp();
  text('working;');
  mark(tag + '.midturn', process.pid);
  if (mode === 'finalonly') {
    const fence = String.fromCharCode(96).repeat(3);
    text(fence + 'json\n{"n":999}\n' + fence);
    const json = (/ANSWER_JSON:(.*)$/m.exec(prompt) || [])[1];
    text(json);
    say({ type: 'result', subtype: 'success', result: json });
    return;
  }
  if (mode === 'answer' || mode === 'malformed') return answer();
  if (mode === 'hold') { await until(tag + '.go'); return answer(); }
  if (mode === 'hang') return setInterval(() => {}, 1000);
  if (mode === 'commit') {
    fs.writeFileSync('made-by-call.txt', 'work\n');
    git('add', 'made-by-call.txt');
    git('-c', 'user.name=Call', '-c', 'user.email=call@example.com', 'commit', '-qm', 'the call');
    return answer();
  }
  // A review judge reporting what it can see: each read root that is a git checkout (its HEAD and
  // files) and the diff file its prompt names.
  if (mode === 'lookcode') {
    const dirs = process.argv.flatMap((a, i) => (a === '--add-dir' ? [process.argv[i + 1]] : []));
    const code = dirs.filter((d) => fs.existsSync(path.join(d, '.git'))).map((d) => ({
      dir: d, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim(), files: fs.readdirSync(d).sort() }));
    const diffAt = (/the diff at (\S+?\.diff)/.exec(prompt) || [])[1];
    mark(tag + '.look', JSON.stringify({ code, diffAt, diff: diffAt ? fs.readFileSync(diffAt, 'utf8') : null }));
    return answer();
  }
  if (mode === 'dirty') { fs.writeFileSync('half-done.txt', 'partial\n'); return setInterval(() => {}, 1000); }
  if (mode === 'usage' || mode === 'usagehang') {
    // 250k uncached input + 50k output on Opus 5.5 ($4 / $20 per 1M) is $1 + $1.
    transcript(session, { input_tokens: 250000, output_tokens: 50000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    if (mode === 'usagehang') return setInterval(() => {}, 1000);
    return answer();
  }
  if (mode === 'refuse') {
    const target = fs.readFileSync(path.join(dir, 'refuse.target'), 'utf8').trim();
    const call = (action) => rpc(tools, 'tools/call', { name: 'runs', arguments: { action } });
    const cancel = await call({ kind: 'cancel', runId: target });
    const retry = await call({ kind: 'retry', runId: target, key: 'refuse-retry' });
    mark(tag + '.refused', JSON.stringify([cancel.result, retry.result]));
    text('tried');
    say({ type: 'result', subtype: 'success' });
    return;
  }
  text('unknown mode ' + mode);
  say({ type: 'result', subtype: 'success' });
}
`;

/** One report the executor made, and whether the run's ref existed at that moment. */
export type Settled = {
  runId: string;
  raw: RawOutcome;
  spent: keyed.Usage;
  refAtReport: boolean;
};

export const TOKEN = 'c9f5e2ab14d36870c9f5e2ab14d36870';
const SERVER_DIR = path.resolve(__dirname, '..', '..');
/** What `boot` runs, and what on its stdout says it is ready (the scheduler line is the last step
 * of startup; with execution disabled it reads "Buddy runner not started"). */
const ENTRIES = {
  'expedition-backend': {
    file: path.join(__dirname, 'expedition-backend.ts'),
    ready: (seen: string) =>
      seen.includes('Buddy runner started') && seen.includes('[expedition-backend] control ready'),
  },
  server: {
    file: path.join(SERVER_DIR, 'src', 'server.ts'),
    ready: (seen: string) => /Buddy runner (not )?started/.test(seen),
  },
} as const;

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }
  ).trim();

export type Harness = ReturnType<typeof harness>;

export function harness(name: string, entry: keyof typeof ENTRIES = 'expedition-backend') {
  const ENTRY = ENTRIES[entry];
  const root = fs.realpathSync(tempDir(`unleashd-${name}-`));
  const home = path.join(root, 'home');
  const fakeDir = path.join(root, 'fake');
  const bin = path.join(root, 'bin');
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  const port = freePortSync();
  const control = freePortSync();
  const log: string[] = [];
  let backend: ChildProcess | null = null;

  // The transcript root exists at boot, so the backend's ingest watches it (the fake writes a
  // Claude transcript there for the usage test).
  const projects = path.join(home, '.claude', 'projects');
  for (const dir of [home, projects, fakeDir, bin, data, repo])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  // The memory reviewer's first rung. It logs each run, then fails at once (a `failed` receipt).
  fs.writeFileSync(
    path.join(bin, 'codex'),
    `#!/bin/sh\necho "$$" >> "${path.join(fakeDir, 'codex.log')}"\nexit 1\n`,
    { mode: 0o755 }
  );
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const cambium = path.dirname(execFileSync('which', ['git-cambium'], { encoding: 'utf8' }).trim());

  async function boot(label: string, extra: Record<string, string> = {}): Promise<void> {
    // A backend still up (a test that failed before its stop) would hold the port and, orphaned,
    // keep the test process alive until the runner's 10-minute kill.
    await kill();
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY.file], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        HOME: home,
        ...NO_AUTO_INSTALL,
        // The fakes, node and git (with Cambium): never a real agent CLI.
        PATH: [bin, path.dirname(process.execPath), cambium, '/usr/bin', '/bin'].join(
          path.delimiter
        ),
        PORT: String(port),
        UNLEASHD_DATA_DIR: data,
        UNLEASHD_BUDDY_EXECUTION: '1',
        UNLEASHD_AUTH_TOKEN: TOKEN,
        FAKE_DIR: fakeDir,
        NODE_ENV: 'test',
        EXP_CONTROL_PORT: String(control),
        EXP_DEBOUNCE_MS: '100',
        EXP_BACKSTOP_MS: '300',
        EXP_USAGE_POLL_MS: '300',
        EXP_USAGE_WAIT_MS: '8000',
        EXP_USAGE_RETRY_MS: '250',
        CWV_BUDDY_RUNNER_BACKSTOP_MS: '200',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    backend = child;
    const record = (chunk: Buffer) =>
      log.push(
        ...chunk
          .toString()
          .split('\n')
          .map((l) => `[${label}] ${l}`)
      );
    child.stderr?.on('data', record);
    let seen = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} did not start: ${log.slice(-40).join('\n')}`)),
        90_000
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        record(chunk);
        seen += chunk.toString();
        if (ENTRY.ready(seen)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) =>
        reject(new Error(`${label} exited ${code}: ${log.slice(-40).join('\n')}`))
      );
    });
  }

  async function kill(): Promise<void> {
    const child = backend;
    backend = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }

  /** A clean shutdown (what a reload or Ctrl-C does): SIGTERM, then wait for the exit. */
  async function stop(): Promise<number | null> {
    const child = backend;
    backend = null;
    if (!child || child.exitCode !== null) return child?.exitCode ?? null;
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    return exited;
  }

  async function http(method: string, route: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  /** One executor call inside the backend. */
  async function ex<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${control}/${route}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${route}: ${text}`);
    return JSON.parse(text) as T;
  }

  async function eventually<T>(
    read: () => Promise<T> | T,
    ok: (value: T) => boolean,
    what: string,
    ms = 90_000
  ): Promise<T> {
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

  const fake = (file: string) => path.join(fakeDir, file);
  const exists = (file: string) => fs.existsSync(fake(file));
  const read = (file: string) => fs.readFileSync(fake(file), 'utf8');
  const spawnsOf = (tag: string) =>
    exists('spawns.log')
      ? read('spawns.log')
          .split('\n')
          .filter((l) => l.split(' ')[0] === tag).length
      : 0;

  return {
    root,
    home,
    data,
    port,
    repo,
    base,
    log,
    boot,
    kill,
    stop,
    http,
    ex,
    eventually,
    exists,
    read,
    fake,
    spawnsOf,
    release: (tag: string) => fs.writeFileSync(fake(`${tag}.go`), ''),
    expRoot: path.join(data, 'expeditions-v1'),

    async workspace(): Promise<string> {
      const ws = await http('POST', '/api/buddies/workspaces', { name: 'calls', rootPath: repo });
      assert.equal(ws.status, 201, JSON.stringify(ws.body));
      return ws.body.id as string;
    },
    async hire(workspaceId: string, slug: string): Promise<string> {
      const buddy = await http('POST', '/api/buddies', {
        workspaceId,
        slug,
        name: slug,
        role: 'test worker',
        provider: 'claude',
        key: `hire-${slug}`,
      });
      assert.equal(buddy.status, 201, JSON.stringify(buddy.body));
      return buddy.body.id as string;
    },
    /** An owner request to a Buddy (a normal, non-call turn). */
    async ask(buddyId: string, body: string, key: string) {
      const dm = await http('POST', `/api/buddies/${buddyId}/direct`);
      const posted = await http('POST', `/api/buddies/channels/${dm.body.channelId}/posts`, {
        kind: 'request',
        body,
        key,
      });
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      return (posted.body.post ?? posted.body) as { id: string; channelId: string };
    },
    async buddies(workspaceId: string) {
      const overview = await http('GET', '/api/buddies/overview');
      const ws = (overview.body as Array<{ id: string; buddies: unknown[] }>).find(
        (w) => w.id === workspaceId
      );
      return (ws?.buddies ?? []) as Array<{ id: string; slug: string; maxActiveRuns: number }>;
    },
    async runsOf(buddyId: string) {
      const runs = await http('GET', `/api/buddies/runs?buddyId=${buddyId}`);
      return (runs.body.runs ?? runs.body) as Array<{
        id: string;
        status: string;
        input: { kind: string; postId?: string };
        error?: string;
        conversationId?: string;
      }>;
    },

    /** An expedition the executor can find: its log's `launched` line. */
    launchLog(id: string, workspaceId: string, pools: Record<string, number> = { claude: 4 }) {
      const dir = path.join(data, 'expeditions-v1', id);
      fs.mkdirSync(dir, { recursive: true });
      const launched = keyed.Entry.parse({
        t: 'launched',
        at: new Date().toISOString(),
        id,
        baseSha: base,
        workspace: { t: 'workspace', id: workspaceId },
        contract: {
          goal: 'g',
          done: [{ t: 'owner', question: 'done?' }],
          budget: { usd: 50, hours: 4 },
          pools,
          rules: [],
          leader: 'lead',
          repo,
          autoApply: { usd: 0 },
        },
      });
      fs.writeFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify(launched)}\n`);
      return dir;
    },

    start: (runId: string, spec: RunSpec) => ex<null>('start', { runId, spec }),
    cancel: (runId: string) => ex<null>('cancel', { runId }),
    close: (runId: string) => ex<null>('close', { runId }),
    status: (runId: string) => ex<RunStatus>('status', { runId }),
    record: (runId: string) => ex<Read<RunRecord>>('record', { runId }),
    settledList: () => ex<Settled[]>('settled'),
    async settledOf(runId: string, ms = 90_000) {
      const list = await eventually(
        () => ex<Settled[]>('settled'),
        (l) => l.some((s) => s.runId === runId),
        `${runId} settled`,
        ms
      );
      return list.filter((s) => s.runId === runId);
    },
    reviews: (buddyId: string) =>
      ex<Array<{ conversationId: string; status: string }>>('reviews', { buddyId }),
    provider: (who: keyed.Who) => ex<unknown>('provider', { who }),

    // ---- the keyed host (launch, open, views) and the owner's side of the DM ----
    leaderName: (exp: string, n: number) => `leader-${exp}-${n}`,
    /** What leader wake `n` of `exp` does: files it writes into its draft folder, its answer. */
    leaderAnswers(
      exp: string,
      n: number,
      script: { files?: Record<string, string>; answer: string }
    ): void {
      fs.writeFileSync(fake(`leader-${exp}-${n}.json`), JSON.stringify(script));
    },
    async launch(file: string, workspaceId: string, baseSha: string = base): Promise<string> {
      const r = await ex<{ t: string; id?: string; issues?: string[] }>('launch', {
        file,
        baseSha,
        workspace: { t: 'workspace', id: workspaceId },
      });
      assert.equal(r.t, 'launched', JSON.stringify(r));
      return r.id as string;
    },
    open: (id: string) => ex<{ t: string }>('open', { id }),
    view: (id: string) => ex<keyed.KeyedView>('view', { id }),
    entries: (id: string) => ex<keyed.Entry[]>('entries', { id }),
    ownerBook: (id: string) => ex<OwnerFile>('book', { id }),
    answerAsk: (id: string, ref: string, answer: AskAnswer) =>
      ex<{ t: string; why?: string }>('answerAsk', { id, ref, answer }),
    answerApproval: (id: string, approved: boolean) =>
      ex<{ t: string }>('answerApproval', { id, approved }),
    /** The owner↔Buddy DM's channel id. */
    async dm(buddyId: string): Promise<string> {
      const opened = await http('POST', `/api/buddies/${buddyId}/direct`);
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      return opened.body.channelId as string;
    },
    async rootPosts(channelId: string): Promise<Post[]> {
      const page = await http('GET', `/api/buddies/channels/${channelId}/posts?limit=200`);
      return page.body.posts as Post[];
    },
    async thread(rootId: string): Promise<Post[]> {
      const page = await http('GET', `/api/buddies/posts/${rootId}/thread?limit=200`);
      return (page.body.posts as Post[]).filter((p) => p.id !== rootId);
    },
    /** The owner replies in a thread, through the owner post route (what the UI sends). */
    async reply(channelId: string, rootId: string, body: string, key: string): Promise<Post> {
      const posted = await http('POST', `/api/buddies/channels/${channelId}/posts`, {
        kind: 'inform',
        body,
        replyToId: rootId,
        key,
      });
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      return posted.body.post as Post;
    },
  };
}

/** A post as the Buddy routes return it (the fields these tests read). */
export type Post = {
  id: string;
  ord: string;
  body: string;
  purpose?: string;
  evidence: string[];
  author: { kind: string; id?: string };
  replyToId?: string;
};

// ---- specs ----

export const HASH = (c: string) => c.repeat(64);
export const runIdOf = (
  exp: string,
  key: string,
  h: string,
  role: 'producer' | 'judge' = 'producer'
) => `${exp}/${key}@${HASH(h)}#1:${role}`;
export const N_SCHEMA = {
  type: 'object',
  properties: { n: { type: 'number' } },
  required: ['n'],
  additionalProperties: false,
};
export const SEAT: keyed.Who = {
  t: 'seat',
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'low',
};

export function agentSpec(
  key: string,
  brief: string,
  x: {
    by?: keyed.Who;
    tree?: 'none' | 'checkout';
    max?: keyed.Max;
    context?: keyed.AgentCall['context'];
    grant?: keyed.AgentCall['grant'];
    inputs?: keyed.AgentCall['inputs'];
  } = {}
): RunSpec {
  return {
    t: 'agent',
    call: {
      t: 'agent',
      key,
      by: x.by ?? SEAT,
      brief,
      inputs: x.inputs ?? [],
      output: N_SCHEMA,
      tree: x.tree ?? 'none',
      base: { t: 'launch' },
      grant: x.grant ?? { reads: [], web: false },
      context: x.context ?? { t: 'cold' },
      pools: ['claude'],
      max: x.max ?? { usd: 20, minutes: 30 },
      judge: { t: 'none' },
    },
  };
}
