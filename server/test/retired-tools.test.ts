import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER } from '../src/buddies/core';
import { createBuddyEvents } from '../src/buddies/events';
import { type Role, createGrants } from '../src/buddies/grants';
import { RETIRED_TOOLS, startMcpEndpoint, toolsFor } from '../src/buddies/mcp';
import { BackgroundWork } from '../src/turns/background-work';
import { tempDir } from './fixtures/temp';

// Fix-guard (2026-11-03): the Buddy `oompa` tool was retired with the Oompa host. An adopted turn
// keeps the tools/list it cached when it started (tool-contract.test.ts), so it can still call the
// tool after the backend that listed it is gone. That call must come back as a tool error naming
// the retirement, through the real endpoint, and the endpoint's other tools must keep working.

test('a call to a retired tool from an adopted turn answers [retired]; live tools still run', async () => {
  const scratch = tempDir('retired-tools-');
  const core = await BuddiesCore.open(path.join(scratch, 'buddies.sqlite'));
  const workspaceId = (await core.createWorkspace(OWNER, { name: 'Home', rootPath: scratch })).id;
  const buddyId = (
    await core.createBuddy(OWNER, {
      workspaceId,
      slug: 'lead',
      name: 'lead',
      role: 'lead',
      manager: { kind: 'nobody' },
      key: 'lead',
    })
  ).id;
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
  const spec = endpoint.spec(
    grants.issueBuddy({
      role: 'worker',
      buddyId,
      workspaceId,
      conversationId: 'c-lead',
      runId: null,
      subscribes: 'self',
      hooks: { t: 'stable', version: 1 },
    })
  );
  assert.equal(spec.kind, 'http');
  const client = new Client({ name: 'retired-tools-test', version: '1' });
  try {
    if (spec.kind !== 'http') return;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: { headers: spec.headers },
      })
    );
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!listed.includes('oompa'), 'a retired tool is never listed again');

    // The input an adopted turn would send: the old `oompa` status action.
    const retired = await client.callTool({
      name: 'oompa',
      arguments: { action: { kind: 'status', runId: 'r1' }, key: 'k1' },
    });
    assert.equal(retired.isError, true);
    const text = (retired.content as Array<{ text: string }>)[0].text;
    assert.match(text, /^\[retired\] oompa: the Buddy Oompa host was retired/);

    const live = await client.callTool({
      name: 'tasks',
      arguments: { action: { kind: 'list', scope: { workspace: workspaceId } } },
    });
    assert.equal(live.isError, undefined, JSON.stringify(live.content));
  } finally {
    await client.close();
    await endpoint.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('no role advertises a retired tool name', () => {
  // Reusing a retired name for a new tool would hand an adopted turn's old input to new code.
  for (const role of ['worker', 'owner', 'reviewer', 'builder'] as const satisfies Role[])
    for (const name of Object.keys(RETIRED_TOOLS))
      assert.ok(!(name in toolsFor(role)), `${role} advertises retired tool ${name}`);
});
