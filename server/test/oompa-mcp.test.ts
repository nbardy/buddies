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
  git('add', 'oracle.mjs');
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
  fs.writeFileSync(executable, '#!/bin/sh\necho $$\nsleep 90 &\necho $!\nwait\n', { mode: 0o755 });
  let grants = createGrants({ ttlMs: 60_000 });
  const owner = () => {
    const grant = grants.issueBuddy({
      role: 'worker',
      buddyId: buddy.id,
      workspaceId: ws.id,
      conversationId: `owner-${Math.random()}`,
      runId: null,
      subscribes: 'self',
      hooks: { t: 'unrecorded' },
    });
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
    launch,
    stop,
    owner,
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
      return lines.length === 2 ? lines.map(Number) : false;
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
