import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import { BuddiesCore } from '@unleashd/buddies-core';
import { type Expedition, Expedition as ExpeditionSchema } from '@unleashd/shared';
import express from 'express';
import { OWNER, buddyActor } from '../../src/buddies/core';
import { createBuddyEvents } from '../../src/buddies/events';
import { createGrants } from '../../src/buddies/grants';
import { startMcpEndpoint } from '../../src/buddies/mcp';
import { type ExpeditionHost, createExpeditionHost } from '../../src/expeditions/host';
import { registerExpeditionRoutes } from '../../src/expeditions/routes';
import { BackgroundWork } from '../../src/turns/background-work';
import { tempDir } from './temp';

// The real expedition fixture: a temp git repo, real sqlite BuddiesCore, real git-cambium, the
// real MCP endpoint and the real HTTP routes (docs/expeditions-lean-design.md §9).

export async function rpc(spec: McpServerSpec, name: string, args: Record<string, unknown>) {
  if (spec.kind !== 'http') throw new Error('HTTP only');
  const client = new Client({ name: 'expeditions-test', version: '1' });
  const init = { requestInit: { headers: spec.headers } };
  await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), init));
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { error: !!result.isError, value: result.isError ? null : JSON.parse(text), text };
  } finally {
    await client.close();
  }
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The oracle: `check.sh` passes once widget.ts says `broken = false`. */
export function tempRepo(scratch: string): string {
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, 'widget'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'widget', 'widget.ts'), 'export const broken = true;\n');
  fs.writeFileSync(path.join(repo, 'check.sh'), "grep -q 'broken = false' widget/widget.ts\n");
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

export const BUDGETS = { leaseMs: 60_000, chatDeadlineMs: 60_000, turnDeadlineMs: 60_000 };
export const charter = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  goal: 'Make the **widget** pass.',
  done: { t: 'checks', checks: [['sh', 'check.sh']] },
  maxAttempts: 5,
  ...extra,
});

export async function fixture() {
  const help = spawnSync('git-cambium', ['remove', '--help'], { encoding: 'utf8' });
  assert.match(`${help.stdout}${help.stderr}`, /-safe/, 'git-cambium must support remove --safe');
  const scratch = tempDir('expeditions-');
  const core = await BuddiesCore.open(path.join(scratch, 'buddies.sqlite'));
  const repo = tempRepo(scratch);
  const ws = await core.createWorkspace(OWNER, { name: 'Repo', rootPath: repo });
  const lead = await core.createBuddy(OWNER, {
    workspaceId: ws.id,
    slug: 'lead',
    name: 'Lead',
    role: 'Lead',
    manager: { kind: 'nobody' },
    key: 'lead',
  });
  const root = path.join(scratch, 'expeditions');
  const events = createBuddyEvents();
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const host = (): ExpeditionHost =>
    createExpeditionHost({
      core,
      events,
      root,
      gate: { t: 'enabled' },
      installed: () => true,
      onBuddyArchived: () => undefined,
      onChannelArchived: () => undefined,
      now: () => {
        clock += 1000;
        return new Date(clock);
      },
    });
  let expeditions = host();
  expeditions.start();
  const grants = createGrants({ ttlMs: 60_000 });
  const endpoint = await startMcpEndpoint({
    core,
    grants,
    events,
    backgroundWork: new BackgroundWork(),
    messages: async () => null,
    openBranch: async () => 'unused',
    uploadsRoot: () => scratch,
    portFile: path.join(scratch, 'buddy-mcp.json'),
    expeditions,
  });
  const app = express();
  app.use(express.json());
  registerExpeditionRoutes(app, () => expeditions);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const grant = grants.issueBuddy({
    role: 'worker',
    buddyId: lead.id,
    workspaceId: ws.id,
    conversationId: 'lead-turn',
    runId: null,
    subscribes: 'self',
    hooks: { t: 'unrecorded' },
  });

  const record = (id: string): Expedition =>
    ExpeditionSchema.parse(JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), 'utf8')));
  const launch = (id: string) => {
    const s = record(id).state;
    if (!('launch' in s)) throw new Error(`${id} is not launched`);
    return s.launch;
  };
  const requestOf = (id: string, n: number) => {
    const p = record(id).attempts[n - 1].phase;
    if (p.t !== 'running') throw new Error(`a${n} is ${p.t}`);
    return p.requestId;
  };
  const settle = async (id: string) => {
    await expeditions.step(id);
    await expeditions.drain();
  };
  return {
    core,
    repo,
    root,
    scratch,
    workspaceId: ws.id,
    leadId: lead.id,
    setClock: (ms: number) => {
      clock = ms;
    },
    spec: () => endpoint.spec(grant),
    get host() {
      return expeditions;
    },
    record,
    launch,
    requestOf,
    settle,
    async act(id: string, body: unknown) {
      const res = await fetch(`${base}/api/buddies/expeditions/${id}/act`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    },
    /** Answers attempt n's request as the crew, then steps until checks settle. */
    async crewAnswer(id: string, n: number, body: string) {
      const requestId = requestOf(id, n);
      const crew = buddyActor(launch(id).crewBuddyId);
      await core.answer(crew, { requestId, body, evidence: [], key: `answer:${requestId}` });
      await settle(id);
      await settle(id);
    },
    async ownerSays(id: string, text: string) {
      const channel = { kind: 'id' as const, id: launch(id).chatChannelId };
      const input = { kind: 'inform' as const, body: text, evidence: [], mentions: [] };
      await core.post(OWNER, channel, {
        ...input,
        broadcast: false,
        key: `owner:${Math.random()}`,
      });
      await settle(id);
    },
    /** A restart as server.ts boots it: the new host is returned unstarted. */
    reboot(): ExpeditionHost {
      expeditions.close();
      expeditions = host();
      return expeditions;
    },
    async close() {
      expeditions.close();
      server.close();
      await endpoint.close();
      const relay = JSON.parse(fs.readFileSync(path.join(scratch, 'buddy-mcp.json'), 'utf8'));
      try {
        process.kill(relay.pid, 'SIGTERM');
      } catch {}
    },
  };
}

/** Claims runs until the one answering `requestId`, then marks it executing (the runner's way). */
export async function executeRequestRun(f: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  let claim = await f.core.claimRun(BUDGETS, []);
  while (claim && !(claim.run.input.kind === 'post' && claim.run.input.postId === requestId))
    claim = await f.core.claimRun(BUDGETS, []);
  if (!claim) throw new Error(`the run for request ${requestId} was never claimable`);
  await f.core.bindRun(claim.run.id, claim.leaseToken, `buddy-run-${claim.run.id}`);
  await f.core.markExecuting(claim.run.id, claim.leaseToken);
  return claim;
}
