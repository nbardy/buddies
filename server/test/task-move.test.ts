import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import { BuddiesCore, type Task } from '@unleashd/buddies-core';
import { OWNER } from '../src/buddies/core';
import { createBuddyEvents } from '../src/buddies/events';
import { createGrants } from '../src/buddies/grants';
import { startMcpEndpoint } from '../src/buddies/mcp';
import { BackgroundWork } from '../src/turns/background-work';
import { tempDir } from './fixtures/temp';

// Moving (reparenting) a task through the real Buddy MCP `task_write` and the real crate: before
// 2026-10-24 a tree could only be reorganized by cancel-and-recreate, which lost history, comments
// and queued runs. These pin the move's refusals (each a typed error, never a silent no-op) and
// its authority: write_task on the task's owner AND on the new parent's owner (tasks.rs
// `require_parent`), so a Buddy cannot graft its work into a peer's subtree.

async function call(spec: McpServerSpec, args: Record<string, unknown>) {
  if (spec.kind !== 'http') throw new Error('HTTP only');
  const client = new Client({ name: 'task-move-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } })
  );
  try {
    const result = await client.callTool({ name: 'task_write', arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return {
      error: !!result.isError,
      text,
      task: result.isError ? null : (JSON.parse(text) as Task),
    };
  } finally {
    await client.close();
  }
}

async function fixture() {
  const scratch = tempDir('task-move-');
  const core = await BuddiesCore.open(path.join(scratch, 'buddies.sqlite'));
  const ws = (await core.createWorkspace(OWNER, { name: 'Home', rootPath: scratch })).id;
  const other = (
    await core.createWorkspace(OWNER, { name: 'Other', rootPath: path.join(scratch, 'other') })
  ).id;
  const hire = async (workspaceId: string, slug: string, managerId: string | null) =>
    (
      await core.createBuddy(OWNER, {
        workspaceId,
        slug,
        name: slug,
        role: slug,
        manager: managerId === null ? { kind: 'nobody' } : { kind: 'buddy', id: managerId },
        key: slug,
      })
    ).id;
  const lead = await hire(ws, 'lead', null);
  const ic = await hire(ws, 'ic', lead);
  const peer = await hire(ws, 'peer', null);
  const foreigner = await hire(other, 'foreigner', null);
  const task = (ownerId: string, title: string, parentId?: string) =>
    core.upsertTask(OWNER, {
      kind: 'create',
      ownerId,
      parentId,
      title,
      doneCriteria: 'd',
      key: title,
    });
  const grants = createGrants({ ttlMs: 60_000 });
  const endpoint = await startMcpEndpoint({
    core,
    grants,
    events: createBuddyEvents(),
    backgroundWork: new BackgroundWork(),
    messages: async () => null,
    openBranch: async () => 'unused',
    uploadsRoot: () => scratch,
    portFile: path.join(scratch, 'buddy-mcp.json'),
  });
  const as = (buddyId: string) =>
    endpoint.spec(
      grants.issueBuddy({
        role: 'worker',
        buddyId,
        workspaceId: ws,
        conversationId: `c-${buddyId}`,
        runId: null,
        subscribes: 'self',
        hooks: { t: 'stable', version: 1 },
      })
    );
  let n = 0;
  /** A move of `subject`'s current revision, as `actor`. */
  const move = async (actor: string, subject: Task, parentId: string | null) =>
    call(as(actor), {
      write: {
        kind: 'update',
        taskId: subject.id,
        baseRevision: (await core.getTask(subject.id)).revision,
        changes: { parentId },
      },
      key: `move-${++n}`,
    });
  const children = async (id: string) =>
    (await core.listTasks({ kind: 'children', parentId: id })).map((t) => t.title);
  return {
    core,
    lead,
    ic,
    peer,
    foreigner,
    task,
    move,
    children,
    async close() {
      await endpoint.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

test('a move reparents under a new parent, and to top level, through task_write', async () => {
  const f = await fixture();
  try {
    const alpha = await f.task(f.ic, 'alpha');
    const beta = await f.task(f.ic, 'beta');
    const todo = await f.task(f.ic, 'todo', alpha.id);
    await f.task(f.ic, 'beta-first', beta.id);

    const moved = await f.move(f.ic, todo, beta.id);
    assert.equal(moved.error, false, moved.text);
    assert.equal(moved.task!.parentId, beta.id);
    assert.equal(moved.task!.revision, todo.revision + 1);
    // Children lists are derived from parentage: the old parent loses it, the new one appends it.
    assert.deepEqual(await f.children(alpha.id), []);
    assert.deepEqual(await f.children(beta.id), ['beta-first', 'todo']);

    const top = await f.move(f.ic, todo, null);
    assert.equal(top.error, false, top.text);
    assert.equal(top.task!.parentId, undefined, 'null makes it top-level');
    assert.deepEqual(await f.children(beta.id), ['beta-first']);
    // A manager moves its report's task under its own: write_task on both owners holds.
    const leads = await f.task(f.lead, 'lead-initiative');
    const managed = await f.move(f.lead, todo, leads.id);
    assert.equal(managed.error, false, managed.text);
    assert.equal(managed.task!.parentId, leads.id);
  } finally {
    await f.close();
  }
});

test('a move into its own subtree, another workspace or a cancelled parent is refused', async () => {
  const f = await fixture();
  try {
    const root = await f.task(f.ic, 'root');
    const mid = await f.task(f.ic, 'mid', root.id);
    const leaf = await f.task(f.ic, 'leaf', mid.id);
    for (const parent of [root, mid, leaf]) {
      const refused = await f.move(f.ic, root, parent.id);
      assert.equal(refused.error, true, `root under ${parent.title}`);
      assert.match(refused.text, /\[invalid\].*cycle/);
    }
    const foreign = await f.task(f.foreigner, 'foreign');
    // A Buddy has no authority over another workspace's owners, so it is denied before the tree
    // is judged; the owner (authority everywhere) reaches the workspace refusal itself.
    const crossed = await f.move(f.ic, leaf, foreign.id);
    assert.match(crossed.text, /\[denied\]/);
    await assert.rejects(
      f.core.upsertTask(OWNER, {
        kind: 'update',
        taskId: leaf.id,
        baseRevision: leaf.revision,
        changes: { parent: { kind: 'task', id: foreign.id } },
        key: 'owner-cross',
      }),
      /\[invalid\].*workspace/
    );
    const dead = await f.task(f.ic, 'dead');
    await f.core.upsertTask(OWNER, {
      kind: 'update',
      taskId: dead.id,
      baseRevision: dead.revision,
      changes: { status: 'cancelled' },
      key: 'cancel-dead',
    });
    const buried = await f.move(f.ic, leaf, dead.id);
    assert.equal(buried.error, true);
    assert.match(buried.text, /\[invalid\].*cancelled/);
    const missing = await f.move(f.ic, leaf, 'task_missing');
    assert.match(missing.text, /\[not_found\]/);
    // Every refusal left the tree as it was.
    assert.equal((await f.core.getTask(root.id)).parentId, undefined);
    assert.equal((await f.core.getTask(leaf.id)).parentId, mid.id);
  } finally {
    await f.close();
  }
});

test("a Buddy cannot move a task into a peer's subtree, nor move a peer's task", async () => {
  const f = await fixture();
  try {
    const mine = await f.task(f.ic, 'mine');
    const theirs = await f.task(f.peer, 'theirs');
    const graft = await f.move(f.ic, mine, theirs.id);
    assert.equal(graft.error, true);
    assert.match(graft.text, /\[denied\]/);
    const steal = await f.move(f.peer, mine, theirs.id);
    assert.equal(steal.error, true);
    assert.match(steal.text, /\[denied\]/);
    // A report cannot pull its manager's task under its own either (authority runs down, not up).
    const leads = await f.task(f.lead, 'leads');
    const up = await f.move(f.ic, leads, mine.id);
    assert.match(up.text, /\[denied\]/);
    assert.equal((await f.core.getTask(mine.id)).parentId, undefined);
    assert.equal((await f.core.getTask(leads.id)).parentId, undefined);
  } finally {
    await f.close();
  }
});
