import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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
const config=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
const swarmId=config.resume_swarm_id?'renewed-swarm':'test-swarm';
const root=path.join(process.cwd(), 'runs', swarmId);
fs.mkdirSync(path.join(root,'workers'),{recursive:true});
let initialMode='';try{initialMode=fs.readFileSync(${JSON.stringify(stubMode)},'utf8')}catch{}
fs.writeFileSync(path.join(root,'started.json'),JSON.stringify({'swarm-id':swarmId,'config-file':process.argv[4],pid:process.pid,workers:initialMode.startsWith('terminal')?[{id:'w0'},{id:'w1'}]:[{id:'w0'}],'continuation-control-dir':process.env.OOMPA_CONTINUATION_CONTROL_DIR}));
console.log('Started event written to runs/'+swarmId+'/started.json');
fs.writeFileSync(path.join(root,'owner-window.json'),JSON.stringify({window:config.task_execution?.owner_window,id:process.env.OOMPA_OWNER_WINDOW_AUTHORIZATION_ID,expires:process.env.OOMPA_OWNER_WINDOW_EXPIRES_AT_MS}));
const update=()=>{
let request; try{request=JSON.parse(fs.readFileSync(path.join(process.env.OOMPA_CONTINUATION_CONTROL_DIR,'continuation-request.json'),'utf8'));}catch{}
let mode='';try{mode=fs.readFileSync(${JSON.stringify(stubMode)},'utf8')}catch{}
if(mode==='exit') process.exit(0);
const state={'worker-id':'w0',status:mode==='active'?'running':'waiting',reason:request&&mode!=='noack'?'host-continuation':'awaiting-buddy-acceptance','updated-at':new Date().toISOString(),execution:mode==='active'?{task_id:'active'}:request&&mode!=='noack'?{host_continuation_id:request.id}:{}};
if(mode.startsWith('terminal')) {
  state.status=mode==='terminal-waiting-stale'?'waiting':'stopped';
  state.reason='needs-reconciliation';
  state['updated-at']=mode==='terminal-bad-date'?'invalid':'2020-01-01T00:00:00Z';
  state.execution={queue_audit:{state:mode==='terminal-bad-audit'?'accepted':'needs-reconciliation'}};
  if(mode==='terminal-active') state.execution.task_id='active';
  const peer={'worker-id':'w1',status:'waiting',reason:mode==='terminal-peer-noack'?'awaiting-buddy-acceptance':'host-continuation','updated-at':new Date().toISOString(),execution:mode==='terminal-peer-noack'?{}:{host_continuation_id:request?.id}};
  const peerFile=path.join(root,'workers','w1.json');fs.writeFileSync(peerFile+'.tmp',JSON.stringify(peer));fs.renameSync(peerFile+'.tmp',peerFile);
}
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
  const launch = async (
    seconds = 60,
    automationSeconds?: number,
    policy: Record<string, unknown> = {}
  ) => {
    const parent = owner();
    const started = await rpc(endpoint.spec(parent), 'oompa', {
      action: {
        kind: 'launch',
        workspaceId: ws.id,
        buddyId: buddy.id,
        workspacePath: repo,
        configPath,
        maxSeconds: seconds,
        ...(automationSeconds === undefined ? {} : { automationSeconds }),
        ...policy,
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
    const got = await rpc(child.spec, 'tasks', { action: { kind: 'get', taskId: w.task.id } });
    assert.equal(got.error, false);
    // One list is the whole scan: rows carry the CAS revision and criteria a worker claims with.
    // Summary rows forced a per-task `get` storm that dropped connections (swarm 00733e4f).
    const listed = await rpc(child.spec, 'tasks', {
      action: { kind: 'list', scope: { workspace: w.ws.id }, include: 'all' },
    });
    const row = listed.value.find((task: { id: string }) => task.id === w.task.id);
    assert.equal(row.revision, got.value.task.revision);
    assert.equal(row.doneCriteria, got.value.task.doneCriteria);
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

test('overnight delegation lets scheduled same-Buddy turns continue and renew exact saved execution without owner authority', async () => {
  const w = await fixture();
  try {
    const child = await w.launch(1, 60);
    const authorization = child.run.automation;
    assert.equal(authorization.buddyId, w.buddy.id);
    assert.equal(authorization.workspaceId, w.ws.id);
    assert.equal(child.run.expiresAt - child.run.originalExpiresAt, 59_000);
    await until(async () => fs.existsSync(path.join(w.repo, 'runs/test-swarm/workers/w0.json')));
    w.grants.revokeConversation(child.parent.conversationId);
    await sleep(1100);
    const manager = w.worker();
    assert.equal(manager.principal.kind, 'buddy');
    const action = {
      kind: 'continue',
      runId: child.run.runId,
      swarmId: 'test-swarm',
      taskId: w.task.id,
      baseRevision: w.task.revision,
      workspacePath: w.candidate,
      sourceCommit: w.commit,
      command: [process.execPath, 'diagnostic.mjs'],
      sourceFiles: { 'diagnostic.mjs': w.diagnosticHash },
      maxSeconds: 5,
    };
    const call = (patch = {}, grant = manager, key = `next-${Math.random()}`) =>
      rpc(w.endpoint.spec(grant), 'oompa', { action: { ...action, ...patch }, key });
    for (const grant of [w.worker('sibling'), w.worker(w.buddy.id, 'foreign'), child.grant])
      assert.equal((await call({}, grant)).error, true);
    for (const patch of [{ taskId: w.foreign.id }, { baseRevision: 99 }, { maxSeconds: 601 }])
      assert.equal((await call(patch)).error, true);
    const first = await call({}, manager, 'scheduled-first');
    assert.equal(first.error, false, first.text);
    await until(async () => fs.existsSync(first.value.continuations[0].exitPath));
    await until(
      async () => !fs.existsSync(path.join(child.run.logDirectory, 'continuation-request.json'))
    );
    const second = await call({}, w.worker(), 'scheduled-second');
    assert.equal(second.error, false, second.text);
    await until(async () => fs.readFileSync(w.diagnosticCounter, 'utf8') === 'xx');
    await until(async () => fs.existsSync(second.value.continuations[1].exitPath));
    await until(
      async () => !fs.existsSync(path.join(child.run.logDirectory, 'continuation-request.json'))
    );
    fs.appendFileSync(path.join(w.candidate, 'oracle.mjs'), '\n// changed validator pin\n');
    execFileSync('git', ['-C', w.candidate, 'add', 'oracle.mjs']);
    execFileSync('git', ['-C', w.candidate, 'commit', '-qm', 'changed validator pin']);
    const changedCommit = execFileSync('git', ['-C', w.candidate, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const changedPin = await call({ sourceCommit: changedCommit });
    assert.equal(changedPin.error, true);
    assert.match(changedPin.text, /validator source pin changed/);
    assert.equal(fs.readFileSync(w.diagnosticCounter, 'utf8'), 'xx');
    await w.restart();
    const afterReload = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: { kind: 'status', runId: child.run.runId },
      key: 'after-reload',
    });
    assert.deepEqual(afterReload.value.automation, { ...authorization, revoked: false });
    fs.writeFileSync(w.stubMode, 'exit');
    await until(async () => fs.existsSync(path.join(child.run.logDirectory, 'exit.json')));
    fs.unlinkSync(w.stubMode);
    const savedPath = path.join(w.repo, 'runs/test-swarm/workers/w0.json');
    const saved = fs.readFileSync(savedPath, 'utf8');
    const configRaw = fs.readFileSync(w.configPath, 'utf8');
    const renewal = {
      kind: 'launch',
      priorRunId: child.run.runId,
      workspaceId: w.ws.id,
      buddyId: w.buddy.id,
      workspacePath: w.repo,
      configPath: w.configPath,
      maxSeconds: 20,
    };
    const renew = (patch = {}, grant = w.worker(), key = `renew-${Math.random()}`) =>
      rpc(w.endpoint.spec(grant), 'oompa', { action: { ...renewal, ...patch }, key });
    for (const grant of [w.worker('sibling'), w.worker(w.buddy.id, 'foreign')])
      assert.equal((await renew({}, grant)).error, true);
    for (const patch of [
      { priorRunId: undefined },
      { automationSeconds: 60 },
      { buddyId: 'sibling' },
      { workspaceId: 'foreign' },
      { workspacePath: w.candidate },
      { maxSeconds: 600 },
    ])
      assert.equal((await renew(patch)).error, true, JSON.stringify(patch));
    type LaunchConfig = {
      task_backend: { task_ids: string[] };
      task_execution: { validators: Record<string, { source_files: Record<string, string> }> };
    };
    for (const alter of [
      (config: LaunchConfig) => config.task_backend.task_ids.push(w.foreign.id),
      (config: LaunchConfig) => {
        config.task_execution.validators[w.task.id].source_files['oracle.mjs'] = '0'.repeat(64);
      },
      (config: LaunchConfig) => {
        config.task_execution.validators = {};
      },
    ]) {
      const config = JSON.parse(configRaw);
      alter(config);
      fs.writeFileSync(w.configPath, JSON.stringify(config));
      const denied = await renew();
      assert.equal(denied.error, true, denied.text);
      assert.match(denied.text, /configuration changed/);
    }
    fs.writeFileSync(w.configPath, configRaw);
    const next = await renew({}, w.worker(), 'scheduled-renewal');
    assert.equal(next.error, false, next.text);
    assert.equal(next.value.priorRunId, child.run.runId);
    assert.deepEqual(next.value.automation, { ...authorization, revoked: false });
    assert.equal(next.value.expiresAt, authorization.expiresAt);
    const resumed = JSON.parse(
      fs.readFileSync(path.join(next.value.logDirectory, 'config.json'), 'utf8')
    );
    assert.deepEqual(resumed, { ...JSON.parse(configRaw), resume_swarm_id: 'test-swarm' });
    assert.equal(
      fs.readFileSync(savedPath, 'utf8'),
      saved,
      'renewal never rewrites prior attempts/session/history'
    );
    assert.equal((await renew({}, w.worker(), 'scheduled-renewal')).value.runId, next.value.runId);
    assert.equal((await renew()).error, true, 'one successor per prior host');
    const nextOwner = JSON.parse(
      fs.readFileSync(path.join(next.value.logDirectory, 'owner.json'), 'utf8')
    );
    const nextSpec = w.endpoint.spec(w.grants.lookup(nextOwner.grant.token)!);
    await w.stop(child.run.runId);
    // Crash after root revocation, before the descendant's phase write: the root marker alone
    // must prevent adoption, independent of execution scan order.
    fs.writeFileSync(
      path.join(next.value.logDirectory, 'phase.json'),
      JSON.stringify({ t: 'running' })
    );
    await w.restart();
    assert.equal(
      await probe(nextSpec),
      401,
      'revoked delegation cannot briefly restore a child bearer'
    );
    const denied = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: { ...renewal, priorRunId: next.value.runId },
      key: 'revoked-renewal',
    });
    assert.equal(denied.error, true);
    assert.match(denied.text, /delegation/);
    const stopped = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: { kind: 'status', runId: next.value.runId },
      key: 'revoked-status',
    });
    assert.notEqual(stopped.value.status, 'running');
    assert.equal(stopped.value.automation.revoked, true);
  } finally {
    await w.close();
  }
});

test('overnight horizon expiry and original owner-free stop remain fail closed', async () => {
  const w = await fixture();
  try {
    const child = await w.launch(60, 1);
    assert.ok(child.run.expiresAt < child.run.originalExpiresAt);
    await until(async () => (await probe(child.spec)) === 401);
    await w.restart();
    const renewal = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: {
        kind: 'launch',
        priorRunId: child.run.runId,
        workspaceId: w.ws.id,
        buddyId: w.buddy.id,
        workspacePath: w.repo,
        configPath: w.configPath,
        maxSeconds: 1,
      },
      key: 'expired-renewal',
    });
    assert.equal(renewal.error, true);
    assert.match(renewal.text, /delegation/);
    const plain = await w.launch();
    const stopped = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: { kind: 'stop', runId: plain.run.runId },
      key: 'ordinary-stop',
    });
    assert.equal(stopped.error, false, stopped.text);
    assert.equal(await probe(plain.spec), 401);
  } finally {
    await w.close();
  }
});

test('checkpoint drain waits through active work and reload, then revokes only host grant and permits delegated renewal', async () => {
  const w = await fixture();
  try {
    fs.writeFileSync(w.stubMode, 'active');
    const child = await w.launch(1, 60);
    await until(async () => fs.existsSync(path.join(w.repo, 'runs/test-swarm/workers/w0.json')));
    const call = (grant = w.worker(), key = 'checkpoint-drain') =>
      rpc(w.endpoint.spec(grant), 'oompa', {
        action: { kind: 'drain', runId: child.run.runId },
        key,
      });
    for (const grant of [w.worker('sibling'), w.worker(w.buddy.id, 'foreign'), child.grant])
      assert.equal((await call(grant)).error, true);
    const requested = await call();
    assert.equal(requested.error, false, requested.text);
    assert.equal(requested.value.status, 'running');
    assert.equal(requested.value.drain.phase, 'requested');
    assert.equal(requested.value.automation.revoked, false);
    await sleep(200);
    assert.equal(await probe(child.spec), 200, 'active model retains its host capability');
    assert.equal(
      fs.existsSync(path.join(child.run.logDirectory, 'exit.json')),
      false,
      'active worker was not signaled'
    );
    // The intent is authoritative even if its derived control write was lost in a crash.
    fs.unlinkSync(path.join(child.run.logDirectory, 'continuation-request.json'));
    await w.restart();
    await until(async () =>
      fs.existsSync(path.join(child.run.logDirectory, 'continuation-request.json'))
    );
    assert.equal(await probe(child.spec), 200, 'reload adopts active model while drain waits');
    const pending = await call();
    assert.equal(pending.value.drain.id, requested.value.drain.id);
    assert.equal(pending.value.status, 'running');
    fs.unlinkSync(w.stubMode);
    await until(async () => fs.existsSync(path.join(child.run.logDirectory, 'exit.json')));
    assert.equal(await probe(child.spec), 401, 'host grant revoked at idle checkpoint');
    const status = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: { kind: 'status', runId: child.run.runId },
      key: 'drained-status',
    });
    assert.equal(status.value.status, 'ended');
    assert.equal(status.value.drain.phase, 'signaling');
    assert.equal(status.value.automation.revoked, false);
    await w.restart();
    const renewed = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: {
        kind: 'launch',
        priorRunId: child.run.runId,
        workspaceId: w.ws.id,
        buddyId: w.buddy.id,
        workspacePath: w.repo,
        configPath: w.configPath,
        maxSeconds: 10,
      },
      key: 'renew-after-drain',
    });
    assert.equal(renewed.error, false, renewed.text);
    assert.equal(renewed.value.expiresAt, child.run.expiresAt);
    assert.equal(renewed.value.automation.revoked, false);
  } finally {
    await w.close();
  }
});

test('checkpoint drain accepts a terminal reconciliation receipt only when peers acknowledge', async () => {
  const w = await fixture();
  try {
    fs.writeFileSync(w.stubMode, 'terminal-active');
    const child = await w.launch(1, 60);
    const workerFile = path.join(w.repo, 'runs/test-swarm/workers/w0.json');
    await until(async () => fs.existsSync(workerFile));
    const requested = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: { kind: 'drain', runId: child.run.runId },
      key: 'terminal-worker-drain',
    });
    assert.equal(requested.error, false, requested.text);
    for (const mode of [
      'terminal-active',
      'terminal-bad-audit',
      'terminal-bad-date',
      'terminal-waiting-stale',
      'terminal-peer-noack',
    ]) {
      fs.writeFileSync(w.stubMode, mode);
      await until(
        async () =>
          JSON.parse(fs.readFileSync(workerFile, 'utf8')).status ===
          (mode === 'terminal-waiting-stale' ? 'waiting' : 'stopped')
      );
      await sleep(150);
      const status = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
        action: { kind: 'status', runId: child.run.runId },
        key: `terminal-${mode}`,
      });
      assert.equal(status.value.status, 'running', mode);
      assert.equal(status.value.drain.phase, 'requested', mode);
    }
    fs.writeFileSync(w.stubMode, 'terminal');
    await until(async () => fs.existsSync(path.join(child.run.logDirectory, 'exit.json')));
    const status = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: { kind: 'status', runId: child.run.runId },
      key: 'terminal-drained-status',
    });
    assert.equal(status.value.status, 'ended');
    assert.equal(status.value.drain.phase, 'signaling');
    assert.equal(status.value.automation.revoked, false);
  } finally {
    await w.close();
  }
});

test('delegated requeue reopens only the latest proven missing-reviewer hold with CAS and preserves execution history', async () => {
  const w = await fixture();
  try {
    const product = await w.core.createBuddy(OWNER, {
      workspaceId: w.ws.id,
      slug: 'product',
      name: 'Product',
      role: 'test',
      manager: { kind: 'nobody' },
      key: 'product',
    });
    let task = await w.core.upsertTask(OWNER, {
      kind: 'update',
      taskId: w.task.id,
      baseRevision: w.task.revision,
      changes: { ownerId: product.id, status: 'in_progress' },
      key: 'product-claim',
    });
    const config = JSON.parse(fs.readFileSync(w.configPath, 'utf8'));
    config.task_backend.owner_by_task = { [task.id]: product.id };
    fs.writeFileSync(w.configPath, JSON.stringify(config));
    const child = await w.launch(1, 120);
    await until(async () => fs.existsSync(path.join(w.repo, 'runs/test-swarm/workers/w0.json')));
    const manager = w.worker();
    assert.equal(manager.principal.kind, 'buddy');
    const normal = await rpc(w.endpoint.spec(manager), 'task_write', {
      write: {
        kind: 'update',
        taskId: task.id,
        baseRevision: task.revision,
        changes: { status: 'open' },
      },
      key: 'ordinary-other-owner-denied',
    });
    assert.equal(normal.error, true, 'scheduled lead has no ordinary authority over Product tasks');
    const request = (patch = {}) => ({
      kind: 'requeue',
      runId: child.run.runId,
      taskId: task.id,
      baseRevision: task.revision,
      reason: 'Committed framework prompt lookup fix; retain exact source/session',
      ...patch,
    });
    const call = (patch = {}, grant = w.worker(), key = `requeue-${Math.random()}`) =>
      rpc(w.endpoint.spec(grant), 'oompa', { action: request(patch), key });
    assert.equal((await call()).error, true, 'active host cannot requeue');
    assert.equal(
      (await call({}, child.grant)).error,
      true,
      'run-owned child has no controller action'
    );
    await rpc(w.endpoint.spec(manager), 'oompa', {
      action: { kind: 'drain', runId: child.run.runId },
      key: 'drain-for-requeue',
    });
    await until(async () => fs.existsSync(path.join(child.run.logDirectory, 'exit.json')));
    const statePath = path.join(w.repo, 'runs/test-swarm/workers/w0.json');
    const proof = () => ({
      task_id: task.id,
      claim_revision: task.revision,
      held_reason: 'execution-blocked',
      feedback: {
        error: 'Framework prompt not found: config/prompts/_framework/reviewer.md',
        reason: null,
      },
      attempt: 2,
      session_id: 'retained-native-session',
      workspace: { path: w.candidate },
      attempt_history: [
        { attempt: 1, session_id: 'retained-native-session', exit: 0 },
        { attempt: 2, session_id: 'retained-native-session', exit: 0 },
      ],
      deadline_ms: Date.now() + 60_000,
    });
    const writeProof = (value: Record<string, unknown>) =>
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          'worker-id': 'w0',
          status: 'stopped',
          reason: 'interrupted',
          execution: { cycle: 2, attempt: 0, held_executions: { [task.id]: value } },
        })
      );
    writeProof(proof());
    for (const grant of [w.worker('sibling'), w.worker(w.buddy.id, 'foreign')])
      assert.equal((await call({}, grant)).error, true);
    for (const patch of [{ taskId: w.foreign.id }, { baseRevision: task.revision + 1 }])
      assert.equal((await call(patch)).error, true);
    for (const patch of [
      {
        held_reason: 'model-blocked',
        attempt: 9,
        blocked_result: { status: 'blocked', reason: 'Force physics evidence missing' },
      },
      { held_reason: 'attempt-budget-exhausted' },
      { feedback: { error: 'Unknown solver failure' } },
      { feedback: { error: 'Framework prompt not found: config/prompts/_framework/other.md' } },
      { blocked_result: { status: 'blocked', reason: 'Physics evidence' } },
      { session_id: null },
      { deadline_ms: 1 },
      { claim_revision: task.revision + 1 },
    ]) {
      writeProof({ ...proof(), ...patch });
      assert.equal((await call()).error, true, JSON.stringify(patch));
    }
    for (const changes of [
      { status: 'blocked' as const, blockedReason: 'Force attempt 9 awaits independent evidence' },
      { status: 'review' as const },
      { status: 'done' as const },
      { paused: true },
      { ownerId: w.buddy.id },
    ]) {
      task = await w.core.upsertTask(OWNER, {
        kind: 'update',
        taskId: task.id,
        baseRevision: task.revision,
        changes,
        key: `refusal-${Math.random()}`,
      });
      writeProof(proof());
      assert.equal((await call()).error, true, JSON.stringify(changes));
      task = await w.core.upsertTask(OWNER, {
        kind: 'update',
        taskId: task.id,
        baseRevision: task.revision,
        changes: { status: 'in_progress', paused: false, ownerId: product.id },
        key: `restore-${Math.random()}`,
      });
    }
    writeProof(proof());
    const saved = fs.readFileSync(statePath, 'utf8');
    const before = await w.core.getTask(task.id);
    const result = await call({}, w.worker(), 'known-framework-requeue');
    assert.equal(result.error, false, result.text);
    assert.equal(result.value.kind, 'requeued');
    assert.equal(result.value.task.status, 'open');
    assert.equal(result.value.task.revision, before.revision + 1);
    assert.equal(result.value.task.ownerId, product.id);
    assert.equal(result.value.task.doneCriteria, before.doneCriteria);
    assert.deepEqual(result.value.task.evidence, before.evidence);
    assert.match(result.value.task.nextAction, /missing reviewer framework prompt/);
    assert.equal(
      fs.readFileSync(statePath, 'utf8'),
      saved,
      'no attempt/session/workspace/history edits'
    );
    assert.equal(
      (await call({ reason: 'different input' }, w.worker(), 'known-framework-requeue')).error,
      true
    );
    assert.equal((await call()).error, true, 'fresh key cannot reopen an already open task');
    // Crash after CAS, before journal completion: core idempotency prevents another revision.
    const receipt = JSON.parse(fs.readFileSync(result.value.logPath, 'utf8'));
    fs.writeFileSync(
      result.value.logPath,
      JSON.stringify({ ...receipt, phase: 'requesting', task: undefined })
    );
    await w.restart();
    const replay = await call({}, w.worker(), 'known-framework-requeue');
    assert.equal(replay.error, false, replay.text);
    assert.equal(replay.value.task.revision, result.value.task.revision);
    const renewed = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: {
        kind: 'launch',
        priorRunId: child.run.runId,
        workspaceId: w.ws.id,
        buddyId: w.buddy.id,
        workspacePath: w.repo,
        configPath: w.configPath,
        maxSeconds: 10,
      },
      key: 'renew-after-requeue',
    });
    assert.equal(renewed.error, false, renewed.text);
    assert.equal((await call()).error, true, 'old host cannot mutate after its successor exists');
    assert.equal(fs.readFileSync(statePath, 'utf8'), saved);
    const oompaSource = process.env.OOMPA_TEST_SOURCE_ROOT;
    if (oompaSource) {
      const nextOwner = JSON.parse(
        fs.readFileSync(path.join(renewed.value.logDirectory, 'owner.json'), 'utf8')
      );
      const nextSpec = w.endpoint.spec(w.grants.lookup(nextOwner.grant.token)!);
      assert.equal(nextSpec.kind, 'http');
      if (nextSpec.kind !== 'http') throw new Error('HTTP only');
      const selected = await new Promise<string>((resolve, reject) =>
        execFile(
          'bb',
          [
            '-cp',
            path.join(oompaSource, 'agentnet/src'),
            '-e',
            `
(require '[agentnet.tasks :as tasks] '[agentnet.worker :as worker] '[cheshire.core :as json])
(let [[config-path state-path task-id] *command-line-args*
      config (json/parse-string (slurp config-path) true)
      state (json/parse-string (slurp state-path) true)
      held (get-in state [:execution :held_executions (keyword task-id)])]
  (tasks/configure! (:task_backend config))
  (let [selected (#'worker/selected-next-task! {:id "w0"} (:task_execution config) {task-id held})]
    (println (json/generate-string selected))))`,
            path.join(renewed.value.logDirectory, 'config.json'),
            statePath,
            task.id,
          ],
          {
            cwd: w.candidate,
            timeout: 10_000,
            env: {
              ...process.env,
              OOMPA_BUDDY_MCP_URL: nextSpec.url,
              OOMPA_BUDDY_MCP_TOKEN: nextOwner.grant.token,
            },
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout))
        )
      );
      const claimed = JSON.parse(selected.trim().split('\n').at(-1)!);
      assert.equal(claimed.id, task.id, 'real Oompa selector reclaims the requeued task via MCP');
      assert.equal(claimed.status, 'in_progress');
      assert.equal(claimed.revision, result.value.task.revision + 1);
      assert.equal(
        fs.readFileSync(statePath, 'utf8'),
        saved,
        'selection preserves the retained source history'
      );
    }
  } finally {
    await w.close();
  }
});

async function portfolioBoundary(ownerScale: boolean, delegatedScale = false) {
  const w = await fixture();
  try {
    const reviewer = await w.core.createBuddy(OWNER, {
      workspaceId: w.ws.id,
      slug: 'reviewer',
      name: 'Review owner',
      role: 'test',
      manager: { kind: 'nobody' },
      key: 'reviewer',
    });
    const root = await w.core.upsertTask(OWNER, {
      kind: 'update',
      taskId: w.task.id,
      baseRevision: w.task.revision,
      changes: { status: 'blocked', blockedReason: 'Internal source closure needs review' },
      key: 'root-held',
    });
    const done = [];
    for (let i = 0; i < 3; i++) {
      const created = await w.core.upsertTask(OWNER, {
        kind: 'create',
        ownerId: w.buddy.id,
        parentId: root.id,
        title: `Prior child ${i}`,
        doneCriteria: 'Historical receipt',
        key: `done-${i}`,
      });
      done.push(
        await w.core.upsertTask(OWNER, {
          kind: 'update',
          taskId: created.id,
          baseRevision: created.revision,
          changes: { status: 'done', evidence: ['Historical accepted source receipt'] },
          key: `accept-${i}`,
        })
      );
    }
    const original = JSON.parse(fs.readFileSync(w.configPath, 'utf8'));
    original.task_backend.task_ids = [root.id, ...done.map((task) => task.id)];
    original.task_backend.dependencies = { [root.id]: [done[0].id] };
    if (ownerScale || delegatedScale) {
      original.workers = [
        {
          model: 'codex:gpt-6.1-sol:xhigh',
          prompt: ['worker.md'],
          count: 1,
          can_claim_gpu: true,
          max_cycle: 100,
          max_resumes: 100,
          needs_review: true,
          can_plan: false,
          max_wait_for_tasks: 600,
        },
      ];
      original.reviewers = [{ model: 'claude:claude-opus-5-5:high', prompt: ['reviewer.md'] }];
    }
    original.task_execution.wall_time_seconds = 120;
    original.task_execution.attempt_timeout_seconds = 10;
    for (const task of done)
      original.task_execution.validators[task.id] = original.task_execution.validators[root.id];
    original.task_execution.task_readiness = {
      [root.id]: {
        blocker_class: 'internal',
        reason_code: 'source-closure',
        required_owner: w.buddy.id,
        next_action: 'Review source prerequisite',
      },
    };
    fs.writeFileSync(w.configPath, JSON.stringify(original));
    const portfolio = {
      rootTaskIds: [root.id],
      ownerIds: [w.buddy.id, reviewer.id],
      reviewerIds: [reviewer.id],
    };
    const scaleEnvelope = {
      maxWorkers: 6,
      models: ['codex:gpt-6.1-sol:medium', 'codex:gpt-6.1-sol:high', 'claude:claude-opus-5-5:high'],
      maxGpuWorkers: 1,
    };
    if (delegatedScale) {
      const denied = await rpc(w.endpoint.spec(w.owner()), 'oompa', {
        action: {
          kind: 'launch',
          workspaceId: w.ws.id,
          buddyId: w.buddy.id,
          workspacePath: w.repo,
          configPath: w.configPath,
          maxSeconds: 1,
          portfolio,
          scaleEnvelope,
        },
        key: 'envelope-without-automation',
      });
      assert.match(denied.text, /requires owner launch automationSeconds and portfolio/);
      const malformed = await rpc(w.endpoint.spec(w.owner()), 'oompa', {
        action: {
          kind: 'launch',
          workspaceId: w.ws.id,
          buddyId: w.buddy.id,
          workspacePath: w.repo,
          configPath: w.configPath,
          maxSeconds: 1,
          automationSeconds: 120,
          portfolio,
          scaleEnvelope: { maxWorkers: 6, models: scaleEnvelope.models },
        },
        key: 'envelope-requires-explicit-gpu-cap',
      });
      assert.equal(malformed.error, true);
      assert.match(malformed.text, /maxGpuWorkers/);
    }
    const child = await w.launch(1, 120, {
      portfolio,
      ...(delegatedScale ? { scaleEnvelope } : {}),
    });
    if (delegatedScale) {
      const ownerRecord = JSON.parse(
        fs.readFileSync(path.join(child.run.logDirectory, 'owner.json'), 'utf8')
      );
      assert.deepEqual(ownerRecord.automation.scaleEnvelope, scaleEnvelope);
    }
    await until(async () => fs.existsSync(path.join(w.repo, 'runs/test-swarm/workers/w0.json')));
    await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: { kind: 'drain', runId: child.run.runId },
      key: 'portfolio-drain',
    });
    await until(async () => fs.existsSync(path.join(child.run.logDirectory, 'exit.json')));
    const statePath = path.join(w.repo, 'runs/test-swarm/workers/w0.json');
    const oldState = {
      cycle: 4,
      attempt: 0,
      accepted_count: 3,
      deadline_ms: child.run.expiresAt,
      held_executions: {
        [root.id]: {
          task_id: root.id,
          claim_revision: root.revision,
          held_task_revision: root.revision,
          held_reason: 'model-blocked',
          attempt: 9,
          session_id: 'retained-science-session',
          workspace: { path: w.candidate },
          attempt_history: [{ attempt: 9, exit: 0 }],
          deadline_ms: child.run.expiresAt,
        },
      },
      queue_audit: {
        schema: 'oompa.task-graph/v1',
        state: 'needs-reconciliation',
        fingerprint: '1'.repeat(64),
        items: [root, ...done].map((task) => ({ task_id: task.id, revision: task.revision })),
        actions: [{ task_id: root.id, code: 'source-closure', class: 'internal' }],
      },
    };
    fs.writeFileSync(
      statePath,
      JSON.stringify({ 'worker-id': 'w0', status: 'stopped', execution: oldState })
    );
    if (delegatedScale) await w.restart();
    const call = (action: Record<string, unknown>, key = 'portfolio', grant = w.worker()) =>
      rpc(w.endpoint.spec(grant), 'oompa', {
        action: { runId: child.run.runId, ...action },
        key,
      });
    const renewAction = {
      kind: 'launch',
      priorRunId: child.run.runId,
      workspaceId: w.ws.id,
      buddyId: w.buddy.id,
      workspacePath: w.repo,
      configPath: w.configPath,
      maxSeconds: 10,
    };
    const unchanged = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: renewAction,
      key: 'unchanged-graph',
    });
    assert.equal(unchanged.error, true);
    assert.match(unchanged.text, /unchanged queue fingerprint/);
    const definition = {
      kind: 'prerequisite',
      parentTaskId: root.id,
      ownerId: reviewer.id,
      role: 'consumer',
      title: 'Review and repair missing source closure',
      doneCriteria: 'Independent source-pinned consumer passes',
    };
    const created = await call(definition, 'create-prerequisite');
    assert.equal(created.error, false, created.text);
    assert.equal(
      (await call(definition, 'different-key-same-graph')).value.id,
      created.value.id,
      'duplicate unchanged prerequisite is not created twice'
    );
    assert.equal(
      (await call({ ...definition, parentTaskId: w.foreign.id }, 'foreign-parent')).error,
      true
    );
    assert.equal((await call({ ...definition, ownerId: 'foreign' }, 'foreign-owner')).error, true);
    assert.equal((await call(definition, 'peer', w.worker('peer'))).error, true);
    const review = await call(
      {
        ...definition,
        role: 'review',
        title: 'Independent delta/source review',
        doneCriteria: 'Bind exact proposed source and config delta',
      },
      'review-task'
    );
    assert.equal(review.error, false, review.text);
    fs.appendFileSync(path.join(w.repo, 'oracle.mjs'), '\n// reviewed current prompt revision\n');
    w.git('add', 'oracle.mjs');
    w.git('commit', '-qm', 'reviewed source repair');
    const sourceCommit = w.git('rev-parse', 'HEAD');
    const currentPin = createHash('sha256')
      .update(fs.readFileSync(path.join(w.repo, 'oracle.mjs')))
      .digest('hex');
    const proposed = structuredClone(original);
    proposed.task_backend.task_ids.push(created.value.id);
    proposed.task_backend.owner_by_task = { [created.value.id]: reviewer.id };
    proposed.task_execution.validators[created.value.id] = {
      command: [process.execPath, 'oracle.mjs'],
      timeout_seconds: 10,
      source_files: { 'oracle.mjs': currentPin },
    };
    proposed.task_execution.task_readiness[created.value.id] = {
      blocker_class: 'internal',
      reason_code: 'reviewed-source-repair',
      required_owner: reviewer.id,
      next_action: 'Execute reviewed consumer',
      role: 'consumer',
    };
    if (ownerScale || delegatedScale) {
      proposed.workers = [
        { ...original.workers[0], model: 'claude:claude-opus-5-5:high', task_ids: [] },
        {
          ...original.workers[0],
          model: 'codex:gpt-6.1-sol:medium',
          count: 5,
          can_claim_gpu: false,
          task_ids: [created.value.id],
        },
      ];
      if (ownerScale) proposed.reviewers[0].prompt = ['reviewed-reviewer.md'];
      if (delegatedScale) proposed.reviewers[0].model = 'codex:gpt-6.1-sol:high';
    }
    const proposedPath = path.join(w.scratch, 'amended.json');
    fs.writeFileSync(proposedPath, JSON.stringify(proposed));
    const configSha256 = createHash('sha256').update(fs.readFileSync(proposedPath)).digest('hex');
    const baseConfigSha256 = child.run.configSha256;
    w.grants.revokeConversation(child.parent.conversationId);
    const request = await rpc(w.endpoint.spec(w.worker()), 'post', {
      channel: { direct: [reviewer.id] },
      kind: 'request',
      taskId: review.value.id,
      purpose: 'Independent scoped configuration/source review',
      body: `Review only this proposed delta and source, then record your own canonical task evidence: ${baseConfigSha256} ${configSha256} ${sourceCommit}`,
      evidence: [],
      key: 'request-independent-review',
    });
    assert.equal(request.error, false, request.text);
    const deniedReview = await rpc(w.endpoint.spec(w.worker()), 'task_write', {
      write: {
        kind: 'update',
        taskId: review.value.id,
        baseRevision: review.value.revision,
        changes: { status: 'done', evidence: ['self approval'] },
      },
      key: 'self-review-denied',
    });
    assert.equal(deniedReview.error, true);
    const reviewGrant = w.worker(reviewer.id);
    assert.equal(reviewGrant.principal.kind, 'buddy');
    const reviewResult = await rpc(w.endpoint.spec(reviewGrant), 'task_write', {
      write: {
        kind: 'update',
        taskId: review.value.id,
        baseRevision: review.value.revision,
        changes: {
          status: 'done',
          evidence: [`oompa.config-review/v1 ${baseConfigSha256} ${configSha256} ${sourceCommit}`],
        },
      },
      key: 'reviewed-delta',
    });
    assert.equal(reviewResult.error, false, reviewResult.text);
    const reviewed = reviewResult.value;
    const answer = await rpc(w.endpoint.spec(reviewGrant), 'post', {
      answers: request.value.id,
      body: 'Independent delta/source review complete; canonical evidence recorded',
      evidence: [sourceCommit],
      key: 'review-reply',
    });
    assert.equal(answer.error, false, answer.text);
    const taskRevisions = Object.fromEntries(
      [root, ...done, created.value].map((task) => [task.id, task.revision])
    );
    const amendment = {
      kind: 'amend',
      ...(ownerScale ? { ownerScale: true } : {}),
      baseConfigSha256,
      configPath: proposedPath,
      configSha256,
      workspacePath: w.repo,
      sourceCommit,
      reviewTaskId: reviewed.id,
      reviewRevision: reviewed.revision,
      taskRevisions,
    };
    assert.equal((await call({ ...amendment, reviewRevision: 1 }, 'stale-review')).error, true);
    assert.equal((await call({ ...amendment, sourceCommit: w.base }, 'stale-source')).error, true);
    assert.equal((await call(amendment, 'foreign-amend', w.worker('peer'))).error, true);
    const saved = fs.readFileSync(statePath, 'utf8');
    const admittingGrant = ownerScale ? w.owner() : w.worker();
    if (ownerScale) {
      const denied = await call(amendment, 'scheduled-scale');
      assert.equal(denied.error, true);
      assert.match(denied.text, /owner-authored/);
      const { ownerScale: _ownerScale, ...ordinary } = amendment;
      assert.match((await call(ordinary, 'scheduled-unflagged-scale')).text, /frozen/);
      for (const field of ['max_cycle', 'max_resumes', 'max_wait_for_tasks']) {
        const bad = structuredClone(proposed);
        bad.workers[1][field]++;
        const badPath = path.join(w.scratch, `scale-${field}.json`);
        fs.writeFileSync(badPath, JSON.stringify(bad));
        const result = await call(
          {
            ...amendment,
            configPath: badPath,
            configSha256: createHash('sha256').update(fs.readFileSync(badPath)).digest('hex'),
          },
          `scale-${field}`,
          admittingGrant
        );
        assert.equal(result.error, true, field);
        assert.match(result.text, /controls/);
      }
      for (const [label, mutate, reason] of [
        [
          'dependency',
          (bad: typeof proposed) => {
            bad.task_backend.dependencies[root.id] = [];
          },
          /acceptance dependencies/,
        ],
        [
          'budget',
          (bad: typeof proposed) => {
            bad.task_execution.wall_time_seconds++;
          },
          /frozen/,
        ],
        [
          'gpu',
          (bad: typeof proposed) => {
            bad.workers[1].can_claim_gpu = true;
          },
          /one GPU/,
        ],
        [
          'count',
          (bad: typeof proposed) => {
            bad.workers[1].count = 6;
          },
          /six workers/,
        ],
        [
          'foreign-task',
          (bad: typeof proposed) => {
            bad.workers[1].task_ids = [w.foreign.id];
          },
          /outside admitted graph/,
        ],
      ] as const) {
        const bad = structuredClone(proposed);
        mutate(bad);
        const badPath = path.join(w.scratch, `scale-${label}.json`);
        fs.writeFileSync(badPath, JSON.stringify(bad));
        const result = await call(
          {
            ...amendment,
            configPath: badPath,
            configSha256: createHash('sha256').update(fs.readFileSync(badPath)).digest('hex'),
          },
          `scale-${label}`,
          admittingGrant
        );
        assert.equal(result.error, true, label);
        assert.match(result.text, reason);
      }
    }
    if (delegatedScale) {
      const rejectedScale = async (
        label: string,
        mutate: (config: typeof proposed) => void,
        reason: RegExp
      ) => {
        const bad = structuredClone(proposed);
        mutate(bad);
        const badPath = path.join(w.scratch, `envelope-${label}.json`);
        fs.writeFileSync(badPath, JSON.stringify(bad));
        const result = await call(
          {
            ...amendment,
            configPath: badPath,
            configSha256: createHash('sha256').update(fs.readFileSync(badPath)).digest('hex'),
          },
          `envelope-${label}`
        );
        assert.equal(result.error, true, label);
        assert.match(result.text, reason, label);
      };
      await rejectedScale(
        'count',
        (bad) => {
          bad.workers[1].count = 6;
        },
        /maxWorkers exceeded/
      );
      await rejectedScale(
        'gpu',
        (bad) => {
          bad.workers[1].can_claim_gpu = true;
        },
        /maxGpuWorkers exceeded/
      );
      await rejectedScale(
        'model',
        (bad) => {
          bad.workers[1].model = 'codex:unlisted:medium';
        },
        /model not listed/
      );
      await rejectedScale(
        'reviewer-model',
        (bad) => {
          bad.reviewers[0].model = 'codex:unlisted:medium';
        },
        /reviewer model not listed/
      );
      await rejectedScale(
        'worker-prompt',
        (bad) => {
          bad.workers[1].prompt = ['changed.md'];
        },
        /controls/
      );
      for (const field of ['max_cycle', 'max_resumes'] as const)
        await rejectedScale(
          field,
          (bad) => {
            bad.workers[1][field]++;
          },
          /controls/
        );
      await rejectedScale(
        'reviewer-prompt',
        (bad) => {
          bad.reviewers[0].prompt = ['changed.md'];
        },
        /reviewer controls/
      );
      await rejectedScale(
        'budget',
        (bad) => {
          bad.task_execution.wall_time_seconds++;
        },
        /frozen/
      );
      await rejectedScale(
        'attempt-timeout',
        (bad) => {
          bad.task_execution.attempt_timeout_seconds++;
        },
        /frozen/
      );
      await rejectedScale(
        'dependency',
        (bad) => {
          bad.task_backend.dependencies[root.id] = [];
        },
        /acceptance dependencies/
      );
      const attemptedWiden = await call(
        { ...amendment, scaleEnvelope: { ...scaleEnvelope, maxWorkers: 7 } },
        'envelope-amend-widen'
      );
      assert.equal(attemptedWiden.error, true);
    }
    if (!ownerScale && !delegatedScale) {
      const bad = structuredClone(proposed);
      bad.workers = [
        {
          model: 'codex:gpt-6.1-sol:medium',
          prompt: ['worker.md'],
          count: 2,
          can_claim_gpu: false,
        },
      ];
      const badPath = path.join(w.scratch, 'scale-without-envelope.json');
      fs.writeFileSync(badPath, JSON.stringify(bad));
      const denied = await call(
        {
          ...amendment,
          configPath: badPath,
          configSha256: createHash('sha256').update(fs.readFileSync(badPath)).digest('hex'),
        },
        'scale-without-envelope'
      );
      assert.match(denied.text, /frozen/);
      assert.equal(
        (
          await call(
            {
              ...amendment,
              scaleEnvelope: {
                maxWorkers: 6,
                models: ['codex:gpt-6.1-sol:medium'],
                maxGpuWorkers: 1,
              },
            },
            'add-envelope-by-amend'
          )
        ).error,
        true
      );
    }
    const admitted = await call(amendment, 'reviewed-amendment', admittingGrant);
    assert.equal(admitted.error, false, admitted.text);
    assert.equal(fs.readFileSync(statePath, 'utf8'), saved);
    assert.equal(
      (await call(amendment, 'reviewed-amendment', admittingGrant)).value.amendmentId,
      admitted.value.amendmentId
    );
    if (ownerScale)
      assert.match(
        (await call(amendment, 'reviewed-amendment')).text,
        /owner-authored/,
        'scheduled replay of an owner receipt does not gain scale authority'
      );
    const executedPinChange = structuredClone(proposed);
    executedPinChange.task_execution.validators[root.id] =
      executedPinChange.task_execution.validators[created.value.id];
    const badPath = path.join(w.scratch, 'bad-amendment.json');
    fs.writeFileSync(badPath, JSON.stringify(executedPinChange));
    assert.equal(
      (
        await call(
          {
            ...amendment,
            configPath: badPath,
            configSha256: createHash('sha256').update(fs.readFileSync(badPath)).digest('hex'),
          },
          'held-repin',
          admittingGrant
        )
      ).error,
      true
    );
    if (!ownerScale && !delegatedScale) {
      const denied = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
        action: {
          ...renewAction,
          configPath: admitted.value.configPath,
          amendmentId: admitted.value.amendmentId,
          scaleEnvelope: { maxWorkers: 6, models: ['codex:gpt-6.1-sol:medium'], maxGpuWorkers: 1 },
        },
        key: 'renewal-cannot-add-envelope',
      });
      assert.equal(denied.error, true);
    }
    if (delegatedScale) {
      const deniedRenewal = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
        action: {
          ...renewAction,
          configPath: admitted.value.configPath,
          amendmentId: admitted.value.amendmentId,
          scaleEnvelope: { ...scaleEnvelope, maxWorkers: 7 },
        },
        key: 'renewal-cannot-widen-envelope',
      });
      assert.match(
        deniedRenewal.text,
        /new portfolio\/window policy requires a new owner-authored launch/
      );
      const deniedSame = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
        action: {
          ...renewAction,
          configPath: admitted.value.configPath,
          amendmentId: admitted.value.amendmentId,
          scaleEnvelope,
        },
        key: 'renewal-cannot-repeat-envelope',
      });
      assert.equal(deniedSame.error, true);
    }
    const resumed = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: {
        ...renewAction,
        configPath: admitted.value.configPath,
        amendmentId: admitted.value.amendmentId,
      },
      key: 'resume-reviewed-graph',
    });
    assert.equal(resumed.error, false, resumed.text);
    assert.equal(resumed.value.expiresAt, child.run.expiresAt);
    if (delegatedScale) {
      const successorRecord = JSON.parse(
        fs.readFileSync(path.join(resumed.value.logDirectory, 'owner.json'), 'utf8')
      );
      assert.deepEqual(successorRecord.automation.scaleEnvelope, scaleEnvelope);
    }
    assert.ok(resumed.value.taskIds.includes(created.value.id));
    assert.equal(fs.readFileSync(statePath, 'utf8'), saved, 'all original held history retained');
    const runtimeConfig = JSON.parse(
      fs.readFileSync(path.join(resumed.value.logDirectory, 'config.json'), 'utf8')
    );
    assert.equal(runtimeConfig.resume_swarm_id, 'test-swarm');
    if (delegatedScale) {
      assert.equal(
        runtimeConfig.task_execution.wall_time_seconds,
        original.task_execution.wall_time_seconds
      );
      assert.equal(
        runtimeConfig.task_execution.attempt_timeout_seconds,
        original.task_execution.attempt_timeout_seconds
      );
      assert.deepEqual(
        runtimeConfig.task_backend.dependencies[root.id],
        original.task_backend.dependencies[root.id]
      );
      for (const task of [root, ...done])
        assert.equal(
          runtimeConfig.task_backend.owner_by_task?.[task.id] ??
            runtimeConfig.task_backend.buddy_id,
          original.task_backend.owner_by_task?.[task.id] ?? original.task_backend.buddy_id
        );
      for (const worker of runtimeConfig.workers) {
        assert.equal(worker.max_cycle, original.workers[0].max_cycle);
        assert.equal(worker.max_resumes, original.workers[0].max_resumes);
      }
    }
    for (const task of done)
      assert.deepEqual(
        runtimeConfig.task_execution.validators[task.id],
        original.task_execution.validators[task.id],
        'DONE historical pins remain receipts'
      );
    if (process.env.OOMPA_TEST_SOURCE_ROOT && process.env.OOMPA_TEST_PORTFOLIO_DRIVER) {
      const owner = JSON.parse(
        fs.readFileSync(path.join(resumed.value.logDirectory, 'owner.json'), 'utf8')
      );
      const spec = w.endpoint.spec(w.grants.lookup(owner.grant.token)!);
      if (spec.kind !== 'http') throw new Error('HTTP only');
      const candidate = path.join(w.scratch, 'new-prerequisite-source');
      w.git('worktree', 'add', '-qb', 'new-prerequisite', candidate);
      const validatorPath = path.join(w.scratch, 'held-validator.json');
      fs.writeFileSync(validatorPath, JSON.stringify(original.task_execution.validators[root.id]));
      const digest = execFileSync(
        'bb',
        [
          '-cp',
          path.join(process.env.OOMPA_TEST_SOURCE_ROOT!, 'agentnet/src'),
          '-e',
          `(require '[agentnet.task-execution :as execution] '[cheshire.core :as json]) (print (execution/validator-digest (json/parse-string (slurp (first *command-line-args*)) true)))`,
          validatorPath,
        ],
        { encoding: 'utf8' }
      ).trim();
      const driverState = JSON.parse(saved);
      driverState.execution.held_executions[root.id].validator_digest = digest;
      driverState.execution.held_executions[root.id].workspace = {
        path: w.candidate,
        name: 'candidate',
        dir: w.candidate,
        branch: 'candidate',
      };
      fs.writeFileSync(statePath, JSON.stringify(driverState));
      const optionsPath = path.join(w.scratch, 'consumer-options.json');
      fs.writeFileSync(
        optionsPath,
        JSON.stringify({
          configPath: path.join(resumed.value.logDirectory, 'config.json'),
          resumeSwarmId: 'test-swarm',
          workerId: 'w0',
          outputSwarmId: 'consumer-proof',
          newTaskWorkspace: {
            path: candidate,
            name: 'new-prerequisite',
            dir: candidate,
            branch: 'new-prerequisite',
            source_commit: w.git('rev-parse', 'HEAD'),
          },
          registeredWorkspaces: [driverState.execution.held_executions[root.id].workspace],
          rootTaskId: root.id,
          statePath,
        })
      );
      const output = await new Promise<string>((resolve, reject) =>
        execFile(
          'bb',
          [process.env.OOMPA_TEST_PORTFOLIO_DRIVER!, optionsPath],
          {
            cwd: w.repo,
            timeout: 30_000,
            env: {
              ...process.env,
              BABASHKA_CLASSPATH: path.join(process.env.OOMPA_TEST_SOURCE_ROOT!, 'agentnet/src'),
              OOMPA_BUDDY_MCP_URL: spec.url,
              OOMPA_BUDDY_MCP_TOKEN: owner.grant.token,
            },
          },
          (error, stdout, stderr) =>
            error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)
        )
      );
      const result = JSON.parse(output.trim().split('\n').at(-1)!);
      assert.equal((await w.core.getTask(created.value.id)).status, 'done', output);
      assert.equal(fs.readFileSync(w.counter, 'utf8'), 'x', 'new real consumer executed once');
      assert.equal(result.execution.held_executions[root.id].attempt, 9);
      assert.equal(
        result.execution.held_executions[root.id].session_id,
        'retained-science-session'
      );
      assert.deepEqual(
        result.execution.held_executions[root.id].attempt_history,
        oldState.held_executions[root.id].attempt_history
      );
      assert.equal(result.execution.accepted_count, 4);
    }
  } finally {
    await w.close();
  }
}

for (const ownerScale of [false, true])
  test(`portfolio MCP admits reviewed canonical prerequisite and preserves history (ownerScale=${ownerScale})`, () =>
    portfolioBoundary(ownerScale));
test('portfolio MCP permits reviewed delegated scale only within the owner launch envelope', () =>
  portfolioBoundary(false, true));

test('only a new owner launch grants an explicit resumed window after expiry without renewing old authority', async () => {
  const w = await fixture();
  try {
    const expired = await w.launch(1, 1);
    await until(async () => fs.existsSync(path.join(expired.run.logDirectory, 'exit.json')));
    const statePath = path.join(w.repo, 'runs/test-swarm/workers/w0.json');
    const oldState = {
      'worker-id': 'w0',
      status: 'stopped',
      execution: {
        deadline_ms: 1,
        attempt: 9,
        session_id: 'old-session',
        attempt_history: [{ attempt: 9 }],
        held_executions: {},
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(oldState));
    const saved = fs.readFileSync(statePath, 'utf8');
    const action = {
      kind: 'launch',
      workspaceId: w.ws.id,
      buddyId: w.buddy.id,
      workspacePath: w.repo,
      configPath: w.configPath,
      maxSeconds: 60,
      automationSeconds: 60,
      resumeRunId: expired.run.runId,
    };
    const denied = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action,
      key: 'worker-new-window-denied',
    });
    assert.equal(denied.error, true);
    const fresh = await rpc(w.endpoint.spec(w.owner()), 'oompa', {
      action,
      key: 'new-owner-window',
    });
    assert.equal(fresh.error, false, fresh.text);
    assert.notEqual(fresh.value.automation.rootRunId, expired.run.automation.rootRunId);
    assert.equal(fresh.value.resumeRunId, expired.run.runId);
    assert.ok(fresh.value.expiresAt > expired.run.expiresAt);
    await until(async () =>
      fs.existsSync(path.join(w.repo, 'runs/renewed-swarm/owner-window.json'))
    );
    const window = JSON.parse(
      fs.readFileSync(path.join(w.repo, 'runs/renewed-swarm/owner-window.json'), 'utf8')
    );
    assert.equal(window.window.authorization_id, fresh.value.runId);
    assert.equal(window.window.prior_deadline_ms, 1);
    assert.equal(window.window.expires_at_ms, fresh.value.expiresAt);
    assert.equal(window.id, fresh.value.runId);
    assert.equal(Number(window.expires), fresh.value.expiresAt);
    assert.equal(
      fs.readFileSync(statePath, 'utf8'),
      saved,
      'host never rewrites original execution history'
    );
    const oldRenewal = await rpc(w.endpoint.spec(w.worker()), 'oompa', {
      action: {
        ...action,
        resumeRunId: undefined,
        priorRunId: expired.run.runId,
        automationSeconds: undefined,
      },
      key: 'old-expired-not-renewed',
    });
    assert.equal(oldRenewal.error, true);
    assert.equal(await probe(expired.spec), 401);
  } finally {
    await w.close();
  }
});
