import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER } from '../src/buddies/core';
import { createBuddyEvents } from '../src/buddies/events';
import { type BuddyGrant, createGrants } from '../src/buddies/grants';
import { startMcpEndpoint } from '../src/buddies/mcp';
import { BackgroundWork } from '../src/turns/background-work';
import { tempDir } from './fixtures/temp';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(f: () => Promise<T | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const x = await f();
    if (x) return x;
    await sleep(40);
  }
  throw new Error('test boundary timed out');
}
async function rpc(spec: McpServerSpec, name: string, args: Record<string, unknown>) {
  if (spec.kind !== 'http') throw new Error('HTTP only');
  const client = new Client({ name: 'oompa-boundary-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers },
    })
  );
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { error: !!result.isError, value: result.isError ? null : JSON.parse(text), text };
  } finally {
    await client.close();
  }
}
async function probe(spec: McpServerSpec) {
  if (spec.kind !== 'http') throw new Error('HTTP only');
  const response = await fetch(spec.url, {
    method: 'POST',
    headers: {
      ...spec.headers,
      'content-type': 'application/json',
      accept: 'application/json,text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'probe', version: '1' },
      },
    }),
  });
  await response.text();
  return response.status;
}
async function fixture() {
  const scratch = tempDir('oompa-boundary-');
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  const counter = path.join(scratch, 'oracle-count');
  const oracle = `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(counter)}, 'x');
await new Promise(resolve => setTimeout(resolve, 500));
console.log(JSON.stringify({schema:'oompa.task-validation/v1',task_id:process.env.OOMPA_TASK_ID,source_commit:process.env.OOMPA_SOURCE_COMMIT,accepted:true}));\n`;
  fs.writeFileSync(path.join(repo, 'oracle.mjs'), oracle);
  const diagnosticCounter = path.join(scratch, 'diagnostic-count');
  const diagnostic = `import fs from 'node:fs';
import { spawn } from 'node:child_process';
fs.appendFileSync(${JSON.stringify(diagnosticCounter)}, 'x');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
console.log(JSON.stringify({pid:child.pid, credential:!!process.env.UNLEASHD_AUTH_TEST}));
await new Promise(resolve => setTimeout(resolve, Number(process.argv[2] || 200)));
if(process.argv[3] === 'dirty') fs.writeFileSync('result.txt', 'changed');
child.kill();
`;
  fs.writeFileSync(path.join(repo, 'diagnostic.mjs'), diagnostic);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'runs/\n');
  git('add', 'oracle.mjs', 'diagnostic.mjs', '.gitignore');
  git('commit', '-qm', 'initial');
  const base = git('rev-parse', 'HEAD');
  const candidate = path.join(scratch, 'candidate');
  git('worktree', 'add', '-qb', 'candidate', candidate);
  fs.writeFileSync(path.join(candidate, 'result.txt'), 'actual candidate\n');
  execFileSync('git', ['-C', candidate, 'add', 'result.txt']);
  execFileSync('git', ['-C', candidate, 'commit', '-qm', 'candidate']);
  const commit = execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const core = await BuddiesCore.open(path.join(scratch, 'buddies.sqlite'));
  const ws = await core.createWorkspace(OWNER, { name: 'Repo', rootPath: repo });
  const buddy = await core.createBuddy(OWNER, {
    workspaceId: ws.id,
    slug: 'lead',
    name: 'Lead',
    role: 'test',
    manager: { kind: 'nobody' },
    key: 'lead',
  });
  const task = await core.upsertTask(OWNER, {
    kind: 'create',
    ownerId: buddy.id,
    title: 'Selected',
    doneCriteria: 'real source accepted',
    key: 'task',
  });
  const foreign = await core.upsertTask(OWNER, {
    kind: 'create',
    ownerId: buddy.id,
    title: 'Foreign',
    doneCriteria: 'not admitted',
    key: 'foreign',
  });
  const configPath = path.join(scratch, 'oompa.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      task_backend: {
        type: 'buddies',
        workspace_id: ws.id,
        buddy_id: buddy.id,
        task_ids: [task.id],
      },
      task_execution: {
        validators: {
          [task.id]: {
            command: [process.execPath, 'oracle.mjs'],
            timeout_seconds: 10,
            source_files: { 'oracle.mjs': createHash('sha256').update(oracle).digest('hex') },
          },
        },
      },
    })
  );
  const executable = path.join(scratch, 'oompa-stub');
  const stubMode = path.join(scratch, 'stub-mode');
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), {spawn} = require('node:child_process');
const sleeper = spawn('sleep', ['90']);
console.log(process.pid); console.log(sleeper.pid);
const root=path.join(process.cwd(), 'runs', 'test-swarm');
fs.mkdirSync(path.join(root,'workers'),{recursive:true});
fs.writeFileSync(path.join(root,'started.json'),JSON.stringify({'swarm-id':'test-swarm','config-file':process.argv[4],pid:process.pid,workers:[{id:'w0'}],'continuation-control-dir':process.env.OOMPA_CONTINUATION_CONTROL_DIR}));
console.log('Started event written to runs/test-swarm/started.json');
const update=()=>{
let request; try{request=JSON.parse(fs.readFileSync(path.join(process.env.OOMPA_CONTINUATION_CONTROL_DIR,'continuation-request.json'),'utf8'));}catch{}
let mode='';try{mode=fs.readFileSync(${JSON.stringify(stubMode)},'utf8')}catch{}
const state={'worker-id':'w0',status:mode==='active'?'running':'waiting',reason:request&&mode!=='noack'?'host-continuation':'awaiting-buddy-acceptance','updated-at':new Date().toISOString(),execution:mode==='active'?{task_id:'active'}:request&&mode!=='noack'?{host_continuation_id:request.id}:{}};
const file=path.join(root,'workers','w0.json');fs.writeFileSync(file+'.tmp',JSON.stringify(state));fs.renameSync(file+'.tmp',file);
};update();setInterval(update,30);
`,
    { mode: 0o755 }
  );
  let grants = createGrants({ ttlMs: 60_000 });
  const worker = (buddyId = buddy.id, workspaceId = ws.id) =>
    grants.issueBuddy({
      role: 'worker',
      buddyId,
      workspaceId,
      conversationId: `turn-${Math.random()}`,
      runId: null,
      subscribes: 'self',
      hooks: { t: 'unrecorded' },
    });
  const owner = () => {
    const grant = worker();
    grants.promoteToOwner(grant.conversationId);
    return grant;
  };
  const start = () =>
    startMcpEndpoint({
      core,
      grants,
      events: createBuddyEvents(),
      backgroundWork: new BackgroundWork(),
      messages: async () => null,
      openBranch: async () => 'unused',
      uploadsRoot: () => scratch,
      portFile: path.join(scratch, 'buddy-mcp.json'),
      oompaOptions: { executable },
    });
  let endpoint = await start();
  const launch = async (seconds = 60) => {
    const parent = owner();
    const started = await rpc(endpoint.spec(parent), 'oompa', {
      action: {
        kind: 'launch',
        workspaceId: ws.id,
        buddyId: buddy.id,
        workspacePath: repo,
        configPath,
        maxSeconds: seconds,
      },
      key: `launch-${Math.random()}`,
    });
    assert.equal(started.error, false, started.text);
    assert.equal(
      JSON.stringify(started.value).includes('token'),
      false,
      'launch returns no credential'
    );
    const record = JSON.parse(
      fs.readFileSync(path.join(started.value.logDirectory, 'owner.json'), 'utf8')
    );
    const grant = grants.lookup(record.grant.token) as BuddyGrant;
    assert.ok(grant?.oompa);
    return { parent, run: started.value, grant, spec: endpoint.spec(grant) };
  };
  const stop = async (runId: string) =>
    rpc(endpoint.spec(owner()), 'oompa', {
      action: { kind: 'stop', runId },
      key: `stop-${Math.random()}`,
    });
  return {
    scratch,
    repo,
    candidate,
    base,
    commit,
    git,
    core,
    ws,
    buddy,
    task,
    foreign,
    counter,
    diagnosticCounter,
    diagnosticHash: createHash('sha256').update(diagnostic).digest('hex'),
    stubMode,
    configPath,
    launch,
    stop,
    owner,
    worker,
    get grants() {
      return grants;
    },
    get endpoint() {
      return endpoint;
    },
    async restart() {
      await endpoint.close();
      grants = createGrants({ ttlMs: 60_000 });
      endpoint = await start();
    },
    async close() {
      const root = path.join(scratch, 'oompa-executions');
      if (fs.existsSync(root)) for (const id of fs.readdirSync(root)) await stop(id);
      await sleep(3300);
      await endpoint.close();
      const relay = JSON.parse(fs.readFileSync(path.join(scratch, 'buddy-mcp.json'), 'utf8'));
      try {
        process.kill(relay.pid, 'SIGTERM');
      } catch {}
    },
  };
}

test('run-owned MCP outlives parent settle and backend reload; scope, stop and expiry remain authoritative', async () => {
  const w = await fixture();
  try {
    const child = await w.launch();
    const pids = await until(async () => {
      const lines = fs
        .readFileSync(path.join(child.run.logDirectory, 'stdout'), 'utf8')
        .trim()
        .split('\n');
      const pids = lines.filter((line) => /^\d+$/.test(line)).map(Number);
      return pids.length === 2 ? pids : false;
    });
    w.grants.revokeConversation(child.parent.conversationId);
    assert.equal(await probe(w.endpoint.spec(child.parent)), 401);
    assert.equal(
      (await rpc(child.spec, 'tasks', { action: { kind: 'get', taskId: w.task.id } })).error,
      false
    );
    for (const [name, args] of [
      ['tasks', { action: { kind: 'get', taskId: w.foreign.id } }],
      ['tasks', { action: { kind: 'list', scope: { workspace: 'foreign' } } }],
      [
        'task_write',
        {
          write: {
            kind: 'update',
            taskId: w.foreign.id,
            baseRevision: 1,
            changes: { status: 'review' },
          },
          key: 'foreign',
        },
      ],
      [
        'task_write',
        {
          write: {
            kind: 'update',
            taskId: w.task.id,
            baseRevision: 1,
            changes: { status: 'done' },
          },
          key: 'forged-done',
        },
      ],
      [
        'task_write',
        {
          write: {
            kind: 'update',
            taskId: w.task.id,
            baseRevision: 1,
            changes: { ownerId: 'owner' },
          },
          key: 'reassign',
        },
      ],
      ['team_admin', { action: { kind: 'anything' } }],
      ['doc_read', { kind: 'working' }],
      ['oompa', { action: { kind: 'launch', workspaceId: w.ws.id }, key: 'escalate' }],
    ] as Array<[string, Record<string, unknown>]>)
      assert.equal((await rpc(child.spec, name, args)).error, true, name);
    await w.restart();
    assert.equal(await probe(child.spec), 200, 'same run capability is adopted with same expiry');
    assert.equal((await w.stop(child.run.runId)).error, false);
    assert.equal(await probe(child.spec), 401, 'Stop revokes before process drain');
    await until(async () =>
      pids.every((pid) => {
        try {
          return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
            .trim()
            .startsWith('Z');
        } catch {
          return true;
        }
      })
    );
    const expired = await w.launch(1);
    await until(async () => (await probe(expired.spec)) === 401);
    assert.equal(w.grants.lookup(expired.grant.token), null);
  } finally {
    await w.close();
  }
});

test('ordinary launch Buddy can monitor and stop, while peers, foreign scope and worker launch are denied', async () => {
  const w = await fixture();
  try {
    const child = await w.launch();
    w.grants.revokeConversation(child.parent.conversationId);
    const manager = w.worker();
    const call = (grant: BuddyGrant, kind: 'status' | 'stop') =>
      rpc(w.endpoint.spec(grant), 'oompa', {
        action: { kind, runId: child.run.runId },
        key: `${kind}-${Math.random()}`,
      });
    const status = await call(manager, 'status');
    assert.equal(status.error, false, status.text);
    assert.equal(status.value.runId, child.run.runId);
    assert.equal(status.value.expiresAt, child.grant.expiresAt);
    const peer = await w.core.createBuddy(OWNER, {
      workspaceId: w.ws.id,
      slug: 'peer',
      name: 'Peer',
      role: 'peer',
      manager: { kind: 'nobody' },
      key: 'peer',
    });
    for (const other of [w.worker(peer.id), w.worker(w.buddy.id, 'foreign-workspace')]) {
      assert.equal((await call(other, 'status')).error, true);
      assert.equal((await call(other, 'stop')).error, true);
    }
    const deniedLaunch = await rpc(w.endpoint.spec(manager), 'oompa', {
      action: {
        kind: 'launch',
        workspaceId: w.ws.id,
        buddyId: w.buddy.id,
        workspacePath: w.repo,
        configPath: w.configPath,
        maxSeconds: 60,
      },
      key: 'worker-launch-denied',
    });
    assert.equal(deniedLaunch.error, true);
    assert.match(deniedLaunch.text, /owner-authored/);
    assert.equal(
      (await call(child.grant, 'stop')).error,
      true,
      'run-owned child cannot stop its supervisor'
    );
    assert.equal((await call(manager, 'stop')).error, false);
    assert.equal(await probe(child.spec), 401);
  } finally {
    await w.close();
  }
});

test('only the pinned host oracle can accept, integrates the exact candidate, and replay runs no oracle twice', async () => {
  const w = await fixture();
  try {
    const child = await w.launch();
    const claim = await rpc(child.spec, 'task_write', {
      write: {
        kind: 'update',
        taskId: w.task.id,
        baseRevision: 1,
        changes: { status: 'in_progress' },
      },
      key: 'claim',
    });
    assert.equal(claim.error, false, claim.text);
    const pinnedOracle = fs.readFileSync(path.join(w.candidate, 'oracle.mjs'), 'utf8');
    fs.writeFileSync(
      path.join(w.candidate, 'oracle.mjs'),
      `${pinnedOracle}\n// worker changes the oracle\n`
    );
    execFileSync('git', ['-C', w.candidate, 'commit', '-qam', 'attempt to change oracle']);
    const forgedHead = execFileSync('git', ['-C', w.candidate, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const forged = await rpc(child.spec, 'oompa', {
      action: {
        kind: 'accept',
        taskId: w.task.id,
        baseRevision: claim.value.revision,
        sourceCommit: forgedHead,
        workspacePath: w.candidate,
      },
    });
    assert.equal(forged.value.kind, 'blocked');
    assert.match(forged.value.validation.reason, /source pin changed/);
    assert.equal(fs.existsSync(w.counter), false, 'tampered oracle never runs');
    fs.writeFileSync(path.join(w.candidate, 'oracle.mjs'), pinnedOracle);
    execFileSync('git', ['-C', w.candidate, 'commit', '-qam', 'restore pinned oracle']);
    const cleanHead = execFileSync('git', ['-C', w.candidate, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const action = {
      kind: 'accept',
      taskId: w.task.id,
      baseRevision: claim.value.revision,
      sourceCommit: cleanHead,
      workspacePath: w.candidate,
    };
    const initial = await rpc(child.spec, 'oompa', { action });
    assert.equal(initial.error, false, initial.text);
    assert.equal(initial.value.kind, 'validating', initial.text);
    await w.restart();
    const accepted = await until(async () => {
      const response = await rpc(child.spec, 'oompa', { action });
      assert.equal(response.error, false, response.text);
      if (response.value.kind === 'validating') return false;
      assert.equal(response.value.kind, 'accepted', response.text);
      return response.value;
    });
    assert.equal(accepted.task.status, 'done');
    assert.equal(w.git('rev-parse', 'HEAD'), cleanHead);
    assert.equal(fs.readFileSync(w.counter, 'utf8'), 'x');
    const repeated = await rpc(child.spec, 'oompa', { action });
    assert.equal(repeated.value.kind, 'accepted', repeated.text);
    assert.equal(repeated.value.task.revision, accepted.task.revision);
    assert.equal(fs.readFileSync(w.counter, 'utf8'), 'x');
  } finally {
    await w.close();
  }
});

test('bounded continuation requires owner, exact scope/revision/source and idle ack; replay/reload runs exactly once', async () => {
  const w = await fixture();
  try {
    const child = await w.launch();
    await until(async () => fs.existsSync(path.join(w.repo, 'runs/test-swarm/workers/w0.json')));
    const action = {
      kind: 'continue',
      runId: child.run.runId,
      swarmId: 'test-swarm',
      taskId: w.task.id,
      baseRevision: w.task.revision,
      workspacePath: w.candidate,
      sourceCommit: w.commit,
      command: [process.execPath, 'diagnostic.mjs', '1000'],
      sourceFiles: { 'diagnostic.mjs': w.diagnosticHash },
      maxSeconds: 10,
    };
    const call = (patch = {}, key = 'diagnostic', grant = w.owner()) =>
      rpc(w.endpoint.spec(grant), 'oompa', { action: { ...action, ...patch }, key });
    for (const patch of [
      { taskId: w.foreign.id },
      { baseRevision: 99 },
      { sourceCommit: w.base },
      { sourceFiles: { 'diagnostic.mjs': '0'.repeat(64) } },
      { sourceFiles: {} },
      { maxSeconds: 601 },
      { swarmId: 'unknown' },
    ])
      assert.equal((await call(patch)).error, true, JSON.stringify(patch));
    assert.equal((await call({}, 'worker-denied', w.worker())).error, true);
    assert.equal((await call({}, 'child-denied', child.grant)).error, true);
    fs.writeFileSync(path.join(w.candidate, 'dirty.txt'), 'dirty');
    assert.equal((await call()).error, true);
    fs.unlinkSync(path.join(w.candidate, 'dirty.txt'));
    fs.writeFileSync(w.stubMode, 'active');
    await sleep(100);
    const active = await call();
    assert.equal(active.error, true);
    assert.match(active.text, /active/);
    fs.unlinkSync(w.stubMode);
    await sleep(100);
    process.env.UNLEASHD_AUTH_TEST = 'must-not-inherit';
    const started = await call();
    Reflect.deleteProperty(process.env, 'UNLEASHD_AUTH_TEST');
    assert.equal(started.error, false, started.text);
    assert.equal(started.value.continuations.length, 1);
    const dir = started.value.continuations[0].logDirectory;
    await until(async () => fs.existsSync(w.diagnosticCounter));
    assert.equal((await call({}, 'overlap')).error, true);
    assert.equal(
      (await call({ command: [process.execPath, 'diagnostic.mjs', '500'] }, 'diagnostic')).error,
      true
    );
    const accept = await rpc(child.spec, 'oompa', {
      action: {
        kind: 'accept',
        taskId: w.task.id,
        baseRevision: w.task.revision,
        sourceCommit: w.commit,
        workspacePath: w.candidate,
      },
    });
    assert.equal(accept.error, true, accept.text);
    await w.restart();
    const repeated = await call();
    assert.equal(repeated.error, false, repeated.text);
    await until(async () => fs.existsSync(path.join(dir, 'exit.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8')).status, 0);
    assert.equal(fs.readFileSync(w.diagnosticCounter, 'utf8'), 'x');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'stdout'), 'utf8')).credential, false);
    await until(
      async () => !fs.existsSync(path.join(child.run.logDirectory, 'continuation-request.json'))
    );
    assert.equal(
      (await w.core.getTask(w.task.id)).status,
      w.task.status,
      'diagnostic never accepts the task'
    );
    assert.equal((await call()).error, false);
    assert.equal(fs.readFileSync(w.diagnosticCounter, 'utf8'), 'x');
    const interruptedId = createHash('sha256').update('interrupted').digest('hex');
    const interruptedDir = path.join(child.run.logDirectory, 'continuations', interruptedId);
    fs.mkdirSync(interruptedDir);
    fs.writeFileSync(
      path.join(interruptedDir, 'continuation.json'),
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(path.join(dir, 'continuation.json'), 'utf8')),
        key: 'interrupted',
        phase: 'requesting',
      })
    );
    fs.writeFileSync(
      path.join(child.run.logDirectory, 'continuation-request.json'),
      JSON.stringify({ id: interruptedId, deadline_ms: Date.now() + 10000 })
    );
    await w.restart();
    const interrupted = await call({}, 'interrupted');
    assert.equal(interrupted.error, false, interrupted.text);
    assert.equal(
      interrupted.value.continuations.find((x: { key: string }) => x.key === 'interrupted').phase,
      'failed'
    );
    assert.equal(
      fs.readFileSync(w.diagnosticCounter, 'utf8'),
      'x',
      'pre-spawn crash never re-executes on replay'
    );
    assert.equal(
      fs.existsSync(path.join(child.run.logDirectory, 'continuation-request.json')),
      false
    );
  } finally {
    Reflect.deleteProperty(process.env, 'UNLEASHD_AUTH_TEST');
    await w.close();
  }
});

test('continuation refuses missing handshake and deadline extension; parent stop and outage deadline cancel its childtree', async () => {
  const w = await fixture();
  try {
    const child = await w.launch(40);
    await until(async () => fs.existsSync(path.join(w.repo, 'runs/test-swarm/workers/w0.json')));
    const action = {
      kind: 'continue',
      runId: child.run.runId,
      swarmId: 'test-swarm',
      taskId: w.task.id,
      baseRevision: w.task.revision,
      workspacePath: w.candidate,
      sourceCommit: w.commit,
      command: [process.execPath, 'diagnostic.mjs', '60000'],
      sourceFiles: { 'diagnostic.mjs': w.diagnosticHash },
      maxSeconds: 4,
    };
    const call = (patch = {}, key = 'deadline') =>
      rpc(w.endpoint.spec(w.owner()), 'oompa', { action: { ...action, ...patch }, key });
    assert.equal((await call({ maxSeconds: 50 })).error, true);
    const started = await call();
    assert.equal(started.error, false, started.text);
    const dir = started.value.continuations[0].logDirectory;
    await until(async () => fs.statSync(path.join(dir, 'stdout')).size > 0);
    const pid = JSON.parse(fs.readFileSync(path.join(dir, 'stdout'), 'utf8')).pid;
    await w.restart();
    await until(async () => fs.existsSync(path.join(dir, 'exit.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8')).status, 124);
    await until(async () => {
      try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' })
          .trim()
          .startsWith('Z');
      } catch {
        return true;
      }
    });
    const stopped = await call({ maxSeconds: 10 }, 'stop-child');
    assert.equal(stopped.error, false, stopped.text);
    const second = stopped.value.continuations.find((x: { key: string }) => x.key === 'stop-child');
    await until(async () => fs.statSync(second.stdoutPath).size > 0);
    await w.stop(child.run.runId);
    await w.restart();
    await until(async () => fs.existsSync(second.exitPath));
    assert.notEqual(JSON.parse(fs.readFileSync(second.exitPath, 'utf8')).status, 0);
  } finally {
    await w.close();
  }
});

test('continuation fails closed on unsupported handshake and source changes after execution', async () => {
  const w = await fixture();
  try {
    const child = await w.launch();
    await until(async () => fs.existsSync(path.join(w.repo, 'runs/test-swarm/workers/w0.json')));
    const action = {
      kind: 'continue',
      runId: child.run.runId,
      swarmId: 'test-swarm',
      taskId: w.task.id,
      baseRevision: w.task.revision,
      workspacePath: w.candidate,
      sourceCommit: w.commit,
      command: [process.execPath, 'diagnostic.mjs', '100', 'dirty'],
      sourceFiles: { 'diagnostic.mjs': w.diagnosticHash },
      maxSeconds: 10,
    };
    const call = (key: string) => rpc(w.endpoint.spec(w.owner()), 'oompa', { action, key });
    const marker = path.join(child.run.logDirectory, 'continuation-control.json');
    fs.unlinkSync(marker);
    const unsupported = await call('unsupported');
    assert.equal(unsupported.error, true);
    assert.match(unsupported.text, /needs restart/);
    fs.writeFileSync(marker, JSON.stringify({ version: 1 }));
    fs.writeFileSync(w.stubMode, 'noack');
    await sleep(100);
    const noack = await call('noack');
    assert.equal(noack.error, true);
    assert.match(noack.text, /did not acknowledge/);
    assert.equal(fs.existsSync(w.diagnosticCounter), false);
    assert.equal(
      fs.existsSync(path.join(child.run.logDirectory, 'continuation-request.json')),
      false
    );
    fs.unlinkSync(w.stubMode);
    await sleep(100);
    const started = await call('dirty-after');
    assert.equal(started.error, false, started.text);
    const job = started.value.continuations.find((x: { key: string }) => x.key === 'dirty-after');
    await until(async () => fs.existsSync(job.exitPath));
    const exit = JSON.parse(fs.readFileSync(job.exitPath, 'utf8'));
    assert.equal(exit.status, 126);
    assert.match(exit.sourceError, /source changed/);
    assert.equal((await w.core.getTask(w.task.id)).status, w.task.status);
  } finally {
    await w.close();
  }
});
