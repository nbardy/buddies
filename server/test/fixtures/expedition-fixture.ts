import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import { BuddiesCore } from '@unleashd/buddies-core';
import type { Provider } from '@unleashd/shared';
import { OWNER, buddyActor } from '../../src/buddies/core';
import { createBuddyEvents } from '../../src/buddies/events';
import type { ExecutionGate } from '../../src/buddies/execution-gate';
import { createGrants } from '../../src/buddies/grants';
import { startMcpEndpoint } from '../../src/buddies/mcp';
import { type ExpeditionHost, createExpeditionHost } from '../../src/expeditions/host';
import {
  type Entry,
  INTEGRATION_TREE,
  type State,
  type Validation,
  currentTree,
  fold,
  workspaceOf,
  worktreeOf,
} from '../../src/expeditions/model';
import type { IngestSlot } from '../../src/ingest/instance';
import { BackgroundWork } from '../../src/turns/background-work';
import { tempDir } from './temp';

// The real-sqlite expedition fixture (extracted from expeditions.test.ts so new small test files
// can reuse it without importing the 418 s monolith). `host()` is the restart constructor.

export async function rpc(spec: McpServerSpec, name: string, args: Record<string, unknown>) {
  if (spec.kind !== 'http') throw new Error('HTTP only');
  const client = new Client({ name: 'expeditions-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } })
  );
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { error: !!result.isError, value: result.isError ? null : JSON.parse(text), text };
  } finally {
    await client.close();
  }
}

/** Test-side git (sync is fine here; the host's git is async). */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A throwaway repository with two top-level areas; Cambium keeps its registry inside it. */
export function tempRepo(scratch: string): string {
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, 'widget'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'widget', 'widget.ts'), 'export const broken = true;\n');
  fs.writeFileSync(path.join(repo, 'docs', 'README.md'), '# Widget\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

export const json = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

export async function fixture() {
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
  // Attempt cost (meter.ts): the conversation→sessions map and the transcript store a test sets.
  const meter = {
    sessions: new Map<string, string[]>(),
    slot: { t: 'starting' } as IngestSlot,
  };
  const host = (
    gate: ExecutionGate = { t: 'enabled' },
    at = root,
    installed: (provider: Provider) => boolean = () => true
  ): ExpeditionHost =>
    createExpeditionHost({
      core,
      events,
      root: at,
      gate,
      installed,
      onBuddyArchived: () => undefined,
      onChannelArchived: () => undefined,
      meter: {
        ingest: () => meter.slot,
        sessionsOf: async (id) => {
          const ids = meter.sessions.get(id);
          return ids ? { t: 'record', sessionIds: ids } : { t: 'missing' };
        },
      },
      now: () => {
        clock += 1000;
        return new Date(clock);
      },
    });
  /** A booted host: ticking, as server.ts starts it after adoption (`hostWith` stays unstarted). */
  const started = (): ExpeditionHost => {
    const booted = host();
    booted.start();
    return booted;
  };
  let expeditions = started();
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
    // The endpoint keeps the first host; `restart` tests drive the new host directly.
    expeditions,
  });
  /** An MCP grant for a Buddy's turn in a workspace (the lead's by default). */
  const grantFor = (buddyId: string, workspaceId: string) =>
    grants.issueBuddy({
      role: 'worker',
      buddyId,
      workspaceId,
      conversationId: `${buddyId}-turn`,
      runId: null,
      subscribes: 'self',
      hooks: { t: 'unrecorded' },
    });
  const grant = grantFor(lead.id, ws.id);
  const ledgerOf = (id: string): Entry[] =>
    fs
      .readFileSync(path.join(root, id, 'ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      // One line per append batch (host.ts readLedgerFile).
      .flatMap((line) => JSON.parse(line) as Entry[]);
  const stateOf = (id: string): State => fold(ledgerOf(id));
  /** The live attempt's request and its kind, by attempt id prefix (m/w/c). */
  const liveAttempts = (id: string) =>
    stateOf(id).attempts.flatMap((a) =>
      a.phase.t === 'posted' ? [{ id: a.id, kind: a.spec.kind, requestId: a.phase.requestId }] : []
    );
  const answer = async (id: string, attemptId: string, body: string) => {
    const s = stateOf(id);
    const attempt = s.attempts.find((a) => a.id === attemptId);
    if (!attempt || attempt.phase.t !== 'posted' || s.crew.t !== 'ready')
      throw new Error(`attempt ${attemptId} is not live`);
    await core.answer(buddyActor(s.crew.buddyId), {
      requestId: attempt.phase.requestId,
      body,
      evidence: [],
      // Per request: a repaired attempt (design.md R11) answers a second request.
      key: `answer:${attempt.phase.requestId}`,
    });
    await expeditions.tick(id);
  };
  const manager = (id: string) => {
    const m = liveAttempts(id).filter((a) => a.kind === 'manager');
    assert.equal(m.length, 1, 'exactly one live manager');
    return m[0].id;
  };
  /** A work attempt's recorded worktree. */
  const treeOf = (id: string, attemptId: string) => worktreeOf(stateOf(id), attemptId);
  /** The expedition's integration tree. */
  const integrationTree = (id: string) => workspaceOf(stateOf(id), INTEGRATION_TREE);
  /** The tree a validation's checks run in (its newest). */
  const validationTree = (id: string, v: Validation) =>
    workspaceOf(stateOf(id), currentTree(stateOf(id), v).id);
  /** Commits a change inside a worktree, as a worker would; returns the sha. */
  const commitIn = (dir: string, file: string) => {
    fs.writeFileSync(path.join(dir, file), 'export const broken = false;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `fix ${file}`);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const branchExists = (ref: string) => git(repo, 'branch', '--list', ref) !== '';
  /** Cambium workspaces besides the expedition's own integration tree. */
  const workspaces = (id: string) =>
    (JSON.parse(git(repo, 'cambium', 'list', '--json')) as { name: string }[])
      .map((w) => w.name)
      .filter((name) => name !== workspaceOf(stateOf(id), INTEGRATION_TREE).name);
  return {
    core,
    events,
    lead,
    repo,
    meter,
    scratch,
    /** Sets the host clock (it advances 1s per read). */
    setClock(ms: number) {
      clock = ms;
    },
    workspaceId: ws.id,
    treeOf,
    integrationTree,
    validationTree,
    commitIn,
    branchExists,
    workspaces,
    ledgerPath: (id: string) => path.join(root, id, 'ledger.jsonl'),
    spec: () => endpoint.spec(grant),
    /** The MCP endpoint as another Buddy in some workspace sees it. */
    specAs: (buddyId: string, workspaceId: string) => endpoint.spec(grantFor(buddyId, workspaceId)),
    root,
    /** A second host on `at` (never the endpoint's): a copied store's, say. */
    hostWith: host,
    ledgerOf,
    stateOf,
    liveAttempts,
    answer,
    manager,
    get host() {
      return expeditions;
    },
    restart() {
      expeditions.close();
      expeditions = started();
    },
    /** A restart as server.ts boots: the new host is returned unstarted, so a test runs
     * `interruptBootLive` (and adoption) before it calls `start`. */
    reboot(): ExpeditionHost {
      expeditions.close();
      expeditions = host();
      return expeditions;
    },
    async close() {
      expeditions.close();
      await endpoint.close();
      const relay = JSON.parse(fs.readFileSync(path.join(scratch, 'buddy-mcp.json'), 'utf8'));
      try {
        process.kill(relay.pid, 'SIGTERM');
      } catch {}
    },
  };
}

export const judged = { checks: [{ kind: 'judged', text: 'pnpm test widget passes' }] };
export const charter = (name: string, maxLive = 2, done: unknown = judged) => ({
  name,
  goal: 'Make the widget pass its test.',
  done,
  inScope: ['widget'],
  outOfScope: ['the website'],
  maxAttempts: 20,
  maxLive,
  hours: 4,
  exploreShare: 0.2,
  crew: {
    manager: { provider: 'claude' },
    work: [{ provider: 'claude' }, { provider: 'codex' }],
    check: [{ provider: 'codex' }, { provider: 'claude' }],
  },
});

export const BUDGETS = { leaseMs: 60_000, chatDeadlineMs: 60_000, turnDeadlineMs: 60_000 };

export async function rpcLaunch(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  maxLive = 2,
  done: unknown = judged
) {
  const launched = await rpc(f.spec(), 'expedition', {
    action: { do: 'launch', charter: charter(name, maxLive, done) },
  });
  assert.equal(launched.error, false, launched.text);
  return launched.value as { id: string; page: string; launched: string; defaulted: string[] };
}

/**
 * Claims runs until the one answering `requestId` (the way the Buddy runner picks it up), then
 * binds its conversation and marks it executing. Returns the claim for further lease steps.
 */
export async function executeRequestRun(f: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  let claim = await f.core.claimRun(BUDGETS, []);
  while (claim && !(claim.run.input.kind === 'post' && claim.run.input.postId === requestId))
    claim = await f.core.claimRun(BUDGETS, []);
  if (!claim) throw new Error(`the run for request ${requestId} was never claimable`);
  const conversationId = `buddy-run-${claim.run.id}`;
  await f.core.bindRun(claim.run.id, claim.leaseToken, conversationId);
  await f.core.markExecuting(claim.run.id, claim.leaseToken);
  return { claim, conversationId };
}
