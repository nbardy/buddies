import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import { BuddiesCore } from '@unleashd/buddies-core';
import { Ingest, defaultRoots } from '@unleashd/ingest';
import type { Provider } from '@unleashd/shared';
import express from 'express';
import { createBriefings } from '../src/buddies/briefing';
import { OWNER, buddyActor } from '../src/buddies/core';
import { announcePost, createBuddyEvents } from '../src/buddies/events';
import type { ExecutionGate } from '../src/buddies/execution-gate';
import { createGrants } from '../src/buddies/grants';
import { startMcpEndpoint } from '../src/buddies/mcp';
import { parseOutcome } from '../src/expeditions/briefs';
import { runCommand } from '../src/expeditions/command';
import {
  CANCEL_GRACE_MS,
  type ExpeditionHost,
  createExpeditionHost,
} from '../src/expeditions/host';
import {
  Charter,
  type Entry,
  type State,
  fold,
  panels,
  workerAttempts,
} from '../src/expeditions/model';
import { clip, clipBlock, goalSummary, launchNews } from '../src/expeditions/news';
import { registerExpeditionRoutes } from '../src/expeditions/routes';
import { createLedger } from '../src/expeditions/store';
import { expeditionView } from '../src/expeditions/view';
import type { IngestSlot } from '../src/ingest/instance';
import { BackgroundWork } from '../src/turns/background-work';
import { tempDir } from './fixtures/temp';

// End to end through the real crate and the real MCP endpoint. The Buddy runner is not started:
// the test plays the crew by answering each request with `core.answer`, then drives `tick`.

async function rpc(spec: McpServerSpec, name: string, args: Record<string, unknown>) {
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
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A throwaway repository with two top-level areas; Cambium keeps its registry inside it. */
function tempRepo(scratch: string): string {
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

/** A validation's check results without their pin reports (pins.ts), for comparing outcomes. */
const outcomes = (v: { runs: { checkIndex: number; outcome: unknown }[] }) =>
  v.runs.map(({ checkIndex, outcome }) => ({ checkIndex, outcome }));

const json = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

async function fixture() {
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
  let expeditions = host();
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
  const treeOf = (id: string, attemptId: string) => {
    const tree = stateOf(id).worktrees[attemptId];
    if (!tree) throw new Error(`no worktree for ${attemptId}`);
    return tree;
  };
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
      .filter((name) => name !== stateOf(id).integrationTree.name);
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
      expeditions = host();
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

const judged = { checks: [{ kind: 'judged', text: 'pnpm test widget passes' }] };
const charter = (name: string, maxLive = 2, done: unknown = judged) => ({
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

test('an expedition runs plan → parallel work → blind check → done, and refuses done without a verified goal check', async () => {
  const f = await fixture();
  try {
    const result = await rpcLaunch(f, 'widget');
    const id = result.id as string;

    // Launch: a crew Buddy, one manager request in the owner↔crew DM, the badge in the owner DM.
    let s = f.stateOf(id);
    assert.equal(s.crew.t, 'ready');
    assert.ok(
      s.statuses.every((x) => x.post.t === 'posted'),
      'the launch badge was posted'
    );
    const m1 = f.manager(id);

    // Manager 1 plans a question and claims done at once: the question lands, done is refused.
    await f.answer(
      id,
      m1,
      json({
        actions: [
          {
            do: 'add_question',
            title: 'Why does the widget fail?',
            detail: 'Find it.',
            scope: 'in',
            paths: ['./widget/'],
            acceptance: { t: 'panel' },
          },
          {
            do: 'add_question',
            title: 'Are the docs stale?',
            detail: 'Read them.',
            scope: 'in',
            paths: ['docs'],
            acceptance: { t: 'panel' },
          },
          { do: 'note', text: 'Start narrow; one question first.' },
          { do: 'done', summary: 'All good' },
        ],
      })
    );
    s = f.stateOf(id);
    assert.equal(s.questions.length, 2);
    assert.deepEqual(s.questions[0].paths, ['widget'], 'custody paths are normalized once');
    assert.equal(s.run.t, 'running');
    assert.ok(
      f.ledgerOf(id).some((e) => e.t === 'rejected' && e.action.do === 'done'),
      'premature done is a typed rejection, not silently applied'
    );
    const q = s.questions[0].id;
    const q2 = s.questions[1].id;

    // The rejection is shown to a fresh manager; it starts three attempts with a live cap of 2.
    const m2 = f.manager(id);
    assert.notEqual(m2, m1);
    const m2Brief = await f.core.getPost(
      OWNER,
      f.liveAttempts(id).find((a) => a.id === m2)!.requestId
    );
    assert.match(
      m2Brief.body,
      new RegExp(`NEW SINCE YOUR LAST DECISION:\\n- QUESTION ADDED ${q} .*\\n.*\\n- REJECTED done`)
    );
    await f.answer(
      id,
      m2,
      json({
        actions: [q, q2, q].map((question, n) => ({
          do: 'work',
          question,
          seat: n % 2,
          brief: `Approach ${n + 1}: SECRET-BRIEF-${n + 1}`,
        })),
      })
    );
    let work = f.liveAttempts(id).filter((a) => a.kind === 'work');
    assert.equal(work.length, 2, 'maxLive bounds parallel work');
    assert.equal(f.stateOf(id).attempts.filter((a) => a.phase.t === 'planned').length, 1);

    // Isolation is structural: each live work attempt has its own worktree at the expedition
    // branch's base, and its brief names that path; the shared checkout is untouched.
    const base = git(f.repo, 'rev-parse', 'HEAD');
    assert.equal(git(f.repo, 'rev-parse', `expedition/${id}`), base);
    for (const w of work) {
      const tree = f.treeOf(id, w.id);
      assert.equal(tree.baseSha, base);
      assert.equal(git(tree.path, 'rev-parse', 'HEAD'), base);
      assert.equal(git(tree.path, 'branch', '--show-current'), tree.branch);
      const brief = await f.core.getPost(OWNER, w.requestId);
      assert.ok(brief.body.includes(`YOUR WORKTREE: ${tree.path}`), `${w.id} brief names its tree`);
    }
    const claimTree = f.treeOf(id, work[0].id);
    const sha = f.commitIn(claimTree.path, 'widget/widget.ts');

    // One claim, one malformed answer: the malformed one is recorded as data, the queued one starts.
    await f.answer(
      id,
      work[0].id,
      json({
        result: 'claim',
        statement: 'The widget passes now',
        change: { t: 'commit', sha },
        evidence: ['widget/widget.ts'],
        howToCheck: 'run the test',
      })
    );
    // R11: a first answer that does not parse gets ONE repair request on the same seat, quoting it;
    // only a second unreadable answer ends the attempt malformed (2026-11-01 incident: a manager's
    // bare JSON and a worker's prose summary were dropped with no second chance).
    await f.answer(id, work[1].id, 'I forgot the JSON block.');
    const repairing = f.stateOf(id).attempts.find((a) => a.id === work[1].id)!;
    assert.equal(repairing.phase.t === 'posted' && repairing.phase.round, 'repair');
    const repair = await f.core.getPost(
      OWNER,
      f.liveAttempts(id).find((a) => a.id === work[1].id)!.requestId
    );
    assert.match(
      repair.body,
      /REPAIR [\s\S]*must end with the json block[\s\S]*I forgot the JSON block\./
    );
    await f.answer(id, work[1].id, 'Still no JSON.');
    s = f.stateOf(id);
    const malformed = s.attempts.find((a) => a.id === work[1].id);
    assert.equal(malformed?.phase.t === 'ended' && malformed.phase.outcome.t, 'malformed');
    // The claim's worktree has a commit: kept for integration. The malformed one made none: its
    // worktree and branch are removed.
    assert.deepEqual(f.treeOf(id, work[0].id).status, { t: 'kept', commits: 1 });
    const emptyTree = f.treeOf(id, work[1].id);
    assert.deepEqual(emptyTree.status, { t: 'removed', branchDeleted: true });
    assert.equal(fs.existsSync(emptyTree.path), false);
    assert.equal(f.branchExists(emptyTree.branch), false);
    assert.equal(git(f.repo, 'status', '--porcelain'), '', 'the shared checkout was never edited');
    work = f.liveAttempts(id).filter((a) => a.kind === 'work');
    assert.equal(work.length, 1, 'the queued attempt took the freed slot');

    // Manager 3 asks a goal check and tries to close the question early: the close is refused.
    const claimId = s.attempts.find(
      (a) => a.phase.t === 'ended' && a.phase.outcome.t === 'work'
    )!.id;
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'check', claimAttempt: claimId, goal: true, panel: 2 },
          { do: 'close_question', question: q, status: 'verified', why: 'claimed' },
        ],
      })
    );
    assert.ok(f.ledgerOf(id).some((e) => e.t === 'rejected' && e.action.do === 'close_question'));
    // A panel of two: one slot is free (the third work attempt holds the other), so one check
    // starts now and the second when a slot frees.
    const check = f.liveAttempts(id).find((a) => a.kind === 'check')!;

    // The check is blind: it sees the claim, never the work attempt's brief. It runs in a tree
    // of its own the host made at the candidate commit, never in the owner's checkout.
    const checkPost = await f.core.getPost(OWNER, check.requestId);
    assert.match(checkPost.body, /The widget passes now/);
    assert.doesNotMatch(checkPost.body, /SECRET-BRIEF/);
    const checkTree = f.treeOf(id, check.id);
    assert.equal(git(checkTree.path, 'rev-parse', 'HEAD'), sha);
    assert.ok(checkPost.body.includes(`YOUR WORKTREE: ${checkTree.path}`));
    assert.doesNotMatch(checkPost.body, /git worktree add/);

    await f.answer(id, check.id, json({ verdict: 'verified', why: 'reproduced' }));
    const second = f.liveAttempts(id).find((a) => a.kind === 'check')!;
    assert.notEqual(second.id, check.id);

    // Independence: the claim came from the claude seat, so every check ran on codex.
    const crewId =
      f.stateOf(id).crew.t === 'ready' ? (f.stateOf(id).crew as { buddyId: string }).buddyId : '';
    const runs = await f.core.listRuns({ kind: 'buddy', buddyId: crewId }, 100);
    for (const c of [check, second]) {
      const run = runs.find((r) => r.input.kind === 'post' && r.input.postId === c.requestId);
      assert.equal(run?.config?.provider, 'codex', `check ${c.id} ran on the claim's author model`);
    }

    // One verified check of two is not a majority: done is still refused.
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'done', summary: 'one check is enough' },
          { do: 'integrate', claimAttempt: claimId },
        ],
      })
    );
    assert.equal(f.stateOf(id).run.t, 'running');
    const refusedIntegration = () =>
      f.ledgerOf(id).flatMap((e) => (e.t === 'rejected' && e.action.do === 'integrate' ? [e] : []));
    // No command checks here, so the check panel is the only evidence: nothing merges before it.
    assert.match(refusedIntegration().at(-1)?.reason ?? '', /a check panel on it is still running/);
    // The second check refutes: 1 of 2 is no majority, so done stays refused after the panel ends.
    await f.answer(id, second.id, json({ verdict: 'refuted', why: 'fails on a clean checkout' }));
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'done', summary: 'split panel' },
          { do: 'integrate', claimAttempt: claimId },
          { do: 'check', claimAttempt: claimId, goal: true, panel: 1 },
        ],
      })
    );
    assert.equal(f.stateOf(id).run.t, 'running', 'a split panel does not verify');
    assert.match(refusedIntegration().at(-1)?.reason ?? '', /latest check panel did not verify/);
    assert.equal(f.stateOf(id).integrations.length, 0);
    const third = f.liveAttempts(id).find((a) => a.kind === 'check')!;
    await f.answer(id, third.id, json({ verdict: 'verified', why: 'reproduced after rebuild' }));
    // A verified goal claim that was never merged cannot finish done: the owner would be told to
    // merge a branch without the verified work (review 2026-11-01).
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'close_question', question: q, status: 'verified', why: 'check verified' },
          { do: 'done', summary: 'too early' },
        ],
      })
    );
    assert.equal(f.stateOf(id).run.t, 'running');
    const refusedDone = f
      .ledgerOf(id)
      .flatMap((e) => (e.t === 'rejected' && e.action.do === 'done' ? [e.reason] : []));
    assert.match(refusedDone.at(-1) ?? '', new RegExp(`goal claim ${claimId} is not integrated`));
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'integrate', claimAttempt: claimId }] })
    );
    assert.equal(f.stateOf(id).integrations[0].status.t, 'integrated');
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'done', summary: 'Widget passes, independently verified.' }] })
    );
    s = f.stateOf(id);
    assert.ok(s.run.t === 'finished');
    assert.deepEqual(
      [s.run.reason, s.run.summary],
      ['done', 'Widget passes, independently verified.']
    );
    assert.equal(s.questions[0].status, 'verified');
    const last = s.statuses.find((x) => x.text.includes('**Done:**'))!;
    assert.equal(last.post.t, 'posted', 'the finish was posted');
    // Finished: every idle worktree is gone; the claim's branch went too, because its commit is
    // merged into the expedition branch (per-attempt branches do not pile up in the owner's repo).
    // The still-running work attempt keeps its tree: its worker may be in it.
    const running = work[0].id;
    for (const tree of Object.values(s.worktrees).filter((t) => t.attemptId !== running)) {
      assert.equal(tree.status.t, 'removed', `${tree.attemptId}: ${JSON.stringify(tree.status)}`);
      assert.equal(fs.existsSync(tree.path), false);
    }
    assert.equal(f.branchExists(claimTree.branch), false, 'a merged attempt branch is deleted');
    git(f.repo, 'merge-base', '--is-ancestor', sha, `expedition/${id}`);
    const runningTree = f.treeOf(id, running);
    assert.equal(runningTree.status.t, 'ready', 'a live worker keeps its tree after finish');
    assert.equal(fs.existsSync(runningTree.path), true);
    // Its end is still observed after finish; only then is its tree (no commits) removed.
    await f.answer(id, running, json({ result: 'finding', statement: 'late', evidence: [] }));
    assert.deepEqual(f.treeOf(id, running).status, { t: 'removed', branchDeleted: true });
    assert.equal(fs.existsSync(runningTree.path), false);
    assert.equal(f.branchExists(runningTree.branch), false);
    s = f.stateOf(id);

    // Where things land: the badge in the launch chat (the owner↔launcher DM here), every update
    // and reflection in the expedition chat (owner↔crew DM), attempts in neither.
    if (s.crew.t !== 'ready' || s.badgePost.t !== 'posted')
      throw new Error('crew and badge expected');
    const crew = s.crew;
    const badge = await f.core.getPost(OWNER, s.badgePost.postId);
    assert.equal(badge.purpose, 'expedition_badge');
    assert.deepEqual(badge.evidence, [`expedition:${id}`]);
    assert.notEqual(badge.channelId, crew.chatChannelId);
    for (const status of s.statuses) {
      if (status.post.t !== 'posted') throw new Error(`status ${status.seq} unposted`);
      const post = await f.core.getPost(OWNER, status.post.postId);
      assert.equal(post.channelId, crew.chatChannelId);
    }
    assert.deepEqual(
      s.reflections.map((r) => r.text),
      ['Start narrow; one question first.']
    );
    assert.ok(s.statuses.some((x) => x.text.includes('Reflection: Start narrow')));
    for (const attempt of s.attempts) {
      if (attempt.phase.t !== 'ended') continue;
      const request = await f.core.getPost(OWNER, attempt.phase.requestId);
      assert.notEqual(request.channelId, crew.chatChannelId, `${attempt.id} cluttered the chat`);
    }

    // The page's data over HTTP; an unknown id is a 404, not a crash.
    const app = express();
    registerExpeditionRoutes(app, () => f.host);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const page = await fetch(`${base}/api/buddies/expeditions/${id}`);
      assert.equal(page.status, 200);
      const body = (await page.json()) as {
        run: { t: string };
        attempts: { brief: string | null }[];
      };
      assert.equal(body.run.t, 'finished');
      assert.ok(
        body.attempts.every((a) => a.brief !== null),
        'every worker shows its instructions'
      );
      assert.equal((await fetch(`${base}/api/buddies/expeditions/nope`)).status, 404);
      // The channel rail's list reads the same fold: this expedition, finished (not a stale "running").
      const list = (await (await fetch(`${base}/api/buddies/expeditions`)).json()) as {
        id: string;
        run: { t: string };
      }[];
      assert.deepEqual(
        list.map((e) => [e.id, e.run.t]),
        [[id, 'finished']]
      );
    } finally {
      server.close();
    }
  } finally {
    await f.close();
  }
});

test('a crash after posting a request but before recording it re-posts the same request, not a second one', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'crash');
    const m1 = f.manager(id);
    const before = f.stateOf(id).attempts.find((a) => a.id === m1)!;
    assert.equal(before.phase.t, 'posted');
    const requestId = before.phase.t === 'posted' ? before.phase.requestId : '';

    // Drop the `attempt_posted` line: the ledger now says "posting" for a request that exists.
    const file = f.ledgerPath(id);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((line) => !(line.includes('"attempt_posted"') && line.includes(m1)));
    assert.equal(kept.length, lines.length - 1);
    fs.writeFileSync(file, `${kept.join('\n')}\n`);

    f.restart();
    await f.host.tick(id);
    const after = f.stateOf(id).attempts.find((a) => a.id === m1)!;
    assert.deepEqual(
      after.phase,
      { t: 'posted', requestId, round: 'brief' },
      'the replay returned the same post'
    );
  } finally {
    await f.close();
  }
});

test('an expedition never goes quiet: an empty plan asks the owner, and the owner answering in the expedition chat resumes it', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'idle');
    await f.answer(id, f.manager(id), json({ actions: [] }));
    let s = f.stateOf(id);
    assert.equal(s.run.t, 'waiting_owner');
    assert.match(s.statuses.at(-1)!.text, /Needs you/);

    // The owner replies in the chat, not through a tool (review 2026-11-01: a chat reply used to
    // leave the run stuck at "needs you"). The host records it as steering by itself.
    if (s.crew.t !== 'ready') throw new Error('crew expected');
    const chat = { kind: 'id' as const, id: s.crew.chatChannelId };
    const say = (body: string, key: string) =>
      f.core.post(OWNER, chat, {
        kind: 'inform',
        body,
        evidence: [],
        mentions: [],
        broadcast: false,
        key,
      });
    await say('lesson: Start with the logs.', 'owner-1');
    await f.host.tick(id);
    s = f.stateOf(id);
    assert.equal(s.run.t, 'running');
    assert.deepEqual(s.lessons, ['Start with the logs.']);
    const brief = await f.core.getPost(
      OWNER,
      f.liveAttempts(id).find((a) => a.kind === 'manager')!.requestId
    );
    assert.match(brief.body, /Start with the logs\./, 'lessons reach every later brief');
    await f.host.tick(id);
    const fromChat = () =>
      f.ledgerOf(id).filter((e) => e.t === 'feedback' && e.via.t === 'chat').length;
    assert.equal(fromChat(), 1, 'a chat message is recorded once, however often the host ticks');

    // The control words work in the chat too.
    await say('Pause', 'owner-2');
    await f.host.tick(id);
    assert.equal(f.stateOf(id).run.t, 'paused');
    await say('resume', 'owner-3');
    await f.host.tick(id);
    assert.equal(f.stateOf(id).run.t, 'running');
    assert.equal(fromChat(), 3);
  } finally {
    await f.close();
  }
});

/** A question as a manager adds it; its claims are accepted by a panel unless a test says how. */
const question = (title: string, paths: string[], acceptance: unknown = { t: 'panel' }) => ({
  do: 'add_question',
  title,
  detail: title,
  scope: 'in',
  paths,
  acceptance,
});
/** A question acceptance that runs this command check on the candidate (design.md R11). */
const accept = (check: { argv: string[]; timeoutSeconds: number }) => ({
  t: 'command',
  argv: check.argv,
  timeoutSeconds: check.timeoutSeconds,
});

test('work on overlapping custody waits for the holder even with free slots; disjoint work runs at once', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'custody', 3);
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          question('Fix the widget', ['widget']),
          question('Fix the widget core', ['widget/core']),
          question('Fix the docs', ['docs']),
        ],
      })
    );
    const [outer, inner, docs] = f.stateOf(id).questions.map((q) => q.id);
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [outer, inner, docs].map((q) => ({ do: 'work', question: q, seat: 0, brief: q })),
      })
    );
    const questionOfLive = () =>
      f
        .liveAttempts(id)
        .flatMap((a) => {
          const spec = f.stateOf(id).attempts.find((x) => x.id === a.id)!.spec;
          return spec.kind === 'work' ? [spec.questionId] : [];
        })
        .sort();
    assert.deepEqual(questionOfLive(), [outer, docs].sort(), 'widget/core waits; docs runs');
    const waiting = f.stateOf(id).attempts.find((a) => a.phase.t === 'planned')!;
    assert.equal(waiting.id in f.stateOf(id).worktrees, false, 'a waiting attempt has no worktree');

    // The expedition branch moves past its launch base: a commit in its integration tree (where
    // the host's merges land), never in the owner's checkout.
    const branch = `expedition/${id}`;
    const launchBase = git(f.repo, 'rev-parse', branch);
    const integrationTree = f.stateOf(id).integrationTree.path;
    git(integrationTree, 'commit', '-q', '--allow-empty', '-m', 'integrated');
    const head = git(f.repo, 'rev-parse', branch);

    // The holder ends with a finding: its custody frees and the waiting attempt starts at the
    // expedition branch's current head, not at the launch base.
    const holder = f.liveAttempts(id).find((a) => a.kind === 'work')!;
    await f.answer(id, holder.id, json({ result: 'finding', statement: 'nope', evidence: [] }));
    assert.deepEqual(questionOfLive(), [docs, inner].sort());
    const started = f.treeOf(id, waiting.id);
    assert.notEqual(head, launchBase);
    assert.equal(started.baseSha, head);
    assert.equal(git(started.path, 'rev-parse', 'HEAD'), head);
  } finally {
    await f.close();
  }
});

test('a crash between creating a worktree and recording it adopts that worktree on replay', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'adopt');
    await f.answer(id, f.manager(id), json({ actions: [question('Fix it', ['widget'])] }));
    const q = f.stateOf(id).questions[0].id;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'go' }] })
    );
    const posted = f.liveAttempts(id).find((a) => a.kind === 'work')!;
    const tree = f.treeOf(id, posted.id);

    // Cut the ledger right after the intent: the worktree exists, the ledger says "creating".
    const file = f.ledgerPath(id);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const cut = lines.findIndex((l) => l.includes('"worktree_ready"') && l.includes(posted.id));
    fs.writeFileSync(file, `${lines.slice(0, cut).join('\n')}\n`);
    assert.equal(f.stateOf(id).worktrees[posted.id].status.t, 'creating');

    f.restart();
    await f.host.tick(id);
    const after = f.treeOf(id, posted.id);
    assert.deepEqual([after.status.t, after.path, after.branch], ['ready', tree.path, tree.branch]);
    assert.deepEqual(
      f.workspaces(id),
      [after.name],
      'one Cambium workspace, adopted, not a second'
    );
    const replayed = f.liveAttempts(id).find((a) => a.id === posted.id)!;
    assert.equal(replayed.requestId, posted.requestId, 'the same brief post, not a second');
  } finally {
    await f.close();
  }
});

/**
 * Makes every `cambium add` in `repo` block while `marker` exists: a committed `.cambium.toml`
 * path rule whose prepare command waits on it, allowed by the clone-local config. Cambium runs it
 * after `git worktree add` made the branch and directory and before it registers the workspace,
 * which is exactly the window an interrupted add leaves behind. It touches `<marker>.started` on
 * entry: the branch appears before the directory is populated, so a kill timed on the branch alone
 * raced the checkout (flaky: no directory left, or a half-made one Cambium could not adopt).
 */
function slowCambiumAdd(repo: string, marker: string) {
  fs.writeFileSync(path.join(repo, '.gitignore'), '.slow\n');
  fs.writeFileSync(path.join(repo, 'slow.lock'), '');
  fs.writeFileSync(
    path.join(repo, '.cambium.toml'),
    [
      'version = 1',
      '',
      '[[path]]',
      'path = ".slow"',
      'policy = "recreate"',
      'inputs = ["slow.lock"]',
      `prepare = ["sh", "-c", "touch '${marker}.started'; while [ -e '${marker}' ]; do sleep 0.05; done; mkdir -p .slow"]`,
      '',
    ].join('\n')
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'slow cambium prepare');
  git(repo, 'cambium', 'init', '--allow-policy-commands');
}

const until = async (what: string, ok: () => boolean) => {
  for (let n = 0; n < 400; n += 1) {
    if (ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('a crash during cambium add (branch and directory made, no registry entry) is recovered on replay', async () => {
  const f = await fixture();
  try {
    // Regression: a SIGKILLed `cambium add` (or one GIT_TIMEOUT_MS killed) left exp/<n> and its
    // directory but no `cambium list` entry; the replay ran `cambium add` again, which failed
    // with "branch already exists" on every tick, so the attempt held its slot forever.
    const marker = path.join(path.dirname(f.repo), 'hold-cambium-add');
    slowCambiumAdd(f.repo, marker);
    const { id } = await rpcLaunch(f, 'partial');
    await f.answer(id, f.manager(id), json({ actions: [question('Fix it', ['widget'])] }));
    const q = f.stateOf(id).questions[0].id;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'go' }] })
    );
    const posted = f.liveAttempts(id).find((a) => a.kind === 'work')!;
    const tree = f.treeOf(id, posted.id);

    // Rewind to the intent, then replay the add the way a crash leaves it: killed mid-prepare.
    const file = f.ledgerPath(id);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const cut = lines.findIndex((l) => l.includes('"worktree_creating"') && l.includes(posted.id));
    fs.writeFileSync(file, `${lines.slice(0, cut + 1).join('\n')}\n`);
    git(f.repo, 'cambium', 'remove', '--delete-branch', tree.name);
    fs.writeFileSync(marker, '');
    fs.rmSync(`${marker}.started`, { force: true }); // left by the attempt's own (unheld) add
    const add = spawn(
      'git-cambium',
      ['add', '-b', tree.branch, '-name', tree.name, '-ephemeral', tree.path, tree.baseSha],
      { cwd: f.repo, detached: true, stdio: 'ignore' }
    );
    await until('the interrupted add to reach its prepare step', () =>
      fs.existsSync(`${marker}.started`)
    );
    process.kill(-add.pid!, 'SIGKILL');
    fs.rmSync(marker);
    const registered = () => f.workspaces(id);
    assert.deepEqual(registered(), [], 'the interrupted add registered nothing');
    assert.equal(fs.existsSync(tree.path), true, 'but left its directory');

    f.restart();
    await f.host.tick(id);
    const after = f.treeOf(id, posted.id);
    assert.deepEqual([after.status.t, after.path, after.branch], ['ready', tree.path, tree.branch]);
    assert.deepEqual(registered(), [tree.name], 'one Cambium workspace');
    assert.equal(git(after.path, 'rev-parse', 'HEAD'), tree.baseSha);
    const replayed = f.liveAttempts(id).find((a) => a.id === posted.id)!;
    assert.equal(replayed.requestId, posted.requestId, 'the same brief post, not a second');
  } finally {
    await f.close();
  }
});

test('a claim its own attempt branch does not hold is recorded malformed, and cannot be checked', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'held');
    await f.answer(id, f.manager(id), json({ actions: [question('Fix it', ['widget'])] }));
    const q = f.stateOf(id).questions[0].id;
    /** A work attempt that commits `file` in its tree, then claims `change` (given its tree's
     * base and its commit). */
    const claim = async (
      change: (base: string, sha: string) => unknown,
      file = 'widget/widget.ts'
    ) => {
      await f.answer(
        id,
        f.manager(id),
        json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'go' }] })
      );
      const work = f.liveAttempts(id).find((a) => a.kind === 'work')!;
      const tree = f.treeOf(id, work.id);
      const sha = f.commitIn(tree.path, file);
      await f.answer(
        id,
        work.id,
        json({
          result: 'claim',
          statement: 'fixed',
          change: change(tree.baseSha, sha),
          evidence: [],
          howToCheck: 'look',
        })
      );
      return work.id;
    };
    const outcomeOf = (attemptId: string) => {
      const ended = f
        .ledgerOf(id)
        .find((e) => e.t === 'attempt_ended' && e.attemptId === attemptId);
      return ended?.t === 'attempt_ended' ? ended.outcome : undefined;
    };

    // Naming a commit that is not new on its own branch (here the head every tree starts from,
    // which might pass every check) would let a claim borrow validation it never earned.
    const borrowed = await claim((base) => ({ t: 'commit', sha: base }));
    assert.match(
      JSON.stringify(outcomeOf(borrowed)),
      // Its branch holds a commit it did not claim: the manager sees it and may claim it (R11).
      /"t":"unreported_commits","shas":\["\w+"\],"ended":\{"t":"malformed","error":"claimed commit \w+ is not a new commit on the attempt branch/
    );
    // Saying "no code" after committing would skip candidate validation.
    const hidden = await claim(() => ({ t: 'no_code' }));
    assert.match(
      JSON.stringify(outcomeOf(hidden)),
      /"t":"unreported_commits","shas":\["\w+"\],"ended":\{"t":"malformed","error":"claimed no code, but the attempt branch \S+ has 1 commit/
    );
    // A commit outside its question's paths (docs/, while the question owns widget/) is not
    // held: custody is enforced on what is claimed, so it can never be validated or merged.
    const trespass = await claim((_base, sha) => ({ t: 'commit', sha }), 'docs/README.md');
    assert.match(
      JSON.stringify(outcomeOf(trespass)),
      /"t":"unreported_commits","shas":\["\w+"\],"ended":\{"t":"malformed","error":"claimed commit \w+ changes files outside its question's paths \(widget\): docs\/README.md/
    );

    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'check', claimAttempt: borrowed, goal: false, panel: 1 }] })
    );
    assert.ok(
      f.ledgerOf(id).some((e) => e.t === 'rejected' && /no parsed result/.test(e.reason)),
      'a check of a claim the branch does not hold is refused'
    );
    assert.equal(f.stateOf(id).attempts.filter((a) => a.spec.kind === 'check').length, 0);

    // "No code" on a branch deleted under the attempt is not "zero commits" (audit 2026-11-01:
    // a missing branch counted as 0 commits, so this claim was held and passed on).
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'go' }] })
    );
    const gone = f.liveAttempts(id).find((a) => a.kind === 'work')!.id;
    git(f.repo, 'update-ref', '-d', `refs/heads/${f.treeOf(id, gone).branch}`);
    await f.answer(
      id,
      gone,
      json({
        result: 'claim',
        statement: 'nothing to change',
        change: { t: 'no_code' },
        evidence: [],
        howToCheck: 'look',
      })
    );
    assert.match(
      JSON.stringify(outcomeOf(gone)),
      /"t":"malformed","error":"the attempt branch \S+ does not exist"/
    );
  } finally {
    await f.close();
  }
});

test('launch preflight refuses with every reason (no repository, a check executable that does not resolve) and never runs a check', async () => {
  const f = await fixture();
  try {
    const ws = await f.core.createWorkspace(OWNER, { name: 'Plain', rootPath: tempDir('plain-') });
    const missing = (bin: string) => ({ kind: 'command', argv: [bin], timeoutSeconds: 30 });
    const launch = (key: string, workspaceId: string, done: unknown) =>
      f.host.launch({
        key,
        charter: Charter.parse(charter(key, 2, done)),
        origin: { t: 'direct' },
        launcherId: f.lead.id,
        workspaceId,
      });
    await assert.rejects(
      launch('plain', ws.id, { checks: [missing('no-such-check-xyz')] }),
      (error: Error) => {
        assert.match(error.message, /workspace root .* is not a git repository/);
        assert.match(error.message, /`no-such-check-xyz` is not found/);
        return true;
      }
    );
    // A repository-relative executable resolves only when it exists and is executable there.
    await assert.rejects(
      launch('relative', f.workspaceId, { checks: [missing('widget/widget.ts')] }),
      /`widget\/widget.ts` is not found/
    );
    // A check runs in a checkout of a commit, so an executable script that exists only in the
    // owner's dirty checkout (untracked here) is refused at launch, not an `error` on every run.
    fs.mkdirSync(path.join(f.repo, 'tools'));
    fs.writeFileSync(path.join(f.repo, 'tools', 'check.sh'), '#!/bin/sh\nexit 0\n', {
      mode: 0o755,
    });
    await assert.rejects(
      launch('untracked', f.workspaceId, { checks: [missing('tools/check.sh')] }),
      /`tools\/check.sh` is not found .*committed at HEAD/
    );
    git(f.repo, 'add', 'tools/check.sh');
    git(f.repo, 'commit', '-q', '-m', 'add the check');
    const committed = await launch('committed', f.workspaceId, {
      checks: [missing('tools/check.sh')],
    });
    assert.equal(committed.t, 'launched');
    // An accepted launch resolves its checks' executables but runs none of them (a check may be
    // a paid GPU run): the marker this check would write does not exist after launch.
    const marker = path.join(tempDir('marker-'), 'ran');
    const writes = { kind: 'command', argv: ['sh', '-c', `touch ${marker}`], timeoutSeconds: 30 };
    const { state } = await launch('accepted', f.workspaceId, { checks: [writes] });
    await f.host.drain();
    assert.equal(state.run.t, 'running');
    assert.equal(fs.existsSync(marker), false, 'preflight ran a check');
    assert.equal(f.ledgerOf(state.id)[0].t, 'launched');
  } finally {
    await f.close();
  }
});

/** A command done check: exits 0 only when the widget is fixed, else says why on stderr. */
const widgetFixed = {
  kind: 'command',
  argv: [
    process.execPath,
    '-e',
    "const ok = require('fs').readFileSync('widget/widget.ts', 'utf8').includes('broken = false'); if (!ok) { console.error('widget still broken'); process.exit(3); }",
  ],
  timeoutSeconds: 30,
};

test('command checks run on the host: each claimed commit is validated in a fresh tree, and done waits for every command check to pass on the head', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'checks', 2, { checks: [widgetFixed] });
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [question('Fix it', ['widget'], accept(widgetFixed))] })
    );
    const q = f.stateOf(id).questions[0].id;
    const work = async (content: string) => {
      await f.answer(
        id,
        f.manager(id),
        json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'fix it' }] })
      );
      const w = f.liveAttempts(id).find((a) => a.kind === 'work')!;
      const tree = f.treeOf(id, w.id);
      fs.writeFileSync(path.join(tree.path, 'widget', 'widget.ts'), content);
      git(tree.path, 'commit', '-q', '-am', 'attempt');
      const sha = git(tree.path, 'rev-parse', 'HEAD');
      await f.answer(
        id,
        w.id,
        json({
          result: 'claim',
          statement: 'fixed',
          change: { t: 'commit', sha },
          evidence: [],
          howToCheck: 'run it',
        })
      );
      await f.host.drain();
      return sha;
    };
    const validations = () => f.ledgerOf(id).flatMap((e) => (e.t === 'validation' ? [e] : []));
    const claimOfSha = (sha: string) =>
      f
        .stateOf(id)
        .validations.flatMap((v) =>
          v.target.t === 'candidate' && v.target.sha === sha ? [v.target.claimAttemptId] : []
        )[0];

    // A failing candidate: the host ran the check at that exact commit; the exit code and the
    // output tail are ledger data, and the scratch tree (and its branch) are gone.
    const bad = await work('export const broken = true; // tried\n');
    const [failed] = validations();
    assert.equal(failed.targetSha, bad);
    assert.equal(failed.checkIndex, 0);
    assert.equal(failed.outcome.t, 'failed');
    if (failed.outcome.t !== 'failed') throw new Error('unreachable');
    assert.equal(failed.outcome.exitCode, 3);
    assert.match(failed.outcome.tail, /widget still broken/);
    const v1 = f.stateOf(id).validations[0];
    if (v1.phase.t !== 'started') throw new Error('validation never started');
    assert.deepEqual(v1.phase.treeStatus, { t: 'removed', branchDeleted: true });
    assert.equal(fs.existsSync(v1.phase.tree.path), false);
    assert.equal(git(f.repo, 'status', '--porcelain'), '', 'the shared checkout was never used');
    // No manager is woken while the claim's validation runs (it could only say "awaiting
    // validation": 2026-11-01 smoke incident); the one planned once it finished is shown both.
    const shown = await f.core.getPost(
      OWNER,
      f.liveAttempts(id).find((a) => a.kind === 'manager')!.requestId
    );
    assert.match(
      shown.body,
      /NEW SINCE YOUR LAST DECISION:\n- \w+ ended: CLAIM: fixed .*\n- validation \w+ of candidate \w+ of \w+: FAILED — check 0 FAILED \(exit 3\): widget still broken/
    );

    // A failed candidate is never merged into the expedition branch.
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'integrate', claimAttempt: claimOfSha(bad) }] })
    );
    assert.ok(
      f
        .ledgerOf(id)
        .some((e) => e.t === 'rejected' && /candidate validation did not pass/.test(e.reason)),
      'a failed candidate is refused integration'
    );
    assert.equal(f.stateOf(id).integrations.length, 0);

    // Done is refused: the expedition branch head (still the base) fails the command check.
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'done', summary: 'try' }] }));
    await f.host.drain();
    let s = f.stateOf(id);
    assert.equal(s.run.t, 'running', 'done before the command checks pass on the head');
    assert.ok(f.ledgerOf(id).some((e) => e.t === 'done_refused'));
    assert.equal(validations().at(-1)?.targetSha, git(f.repo, 'rev-parse', `expedition/${id}`));

    // A passing candidate passes its validation, but the head still lacks it: done stays refused.
    const good = await work('export const broken = false;\n');
    assert.deepEqual(validations().find((v) => v.targetSha === good)?.outcome, { t: 'passed' });
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'done', summary: 'again' }] }));
    await f.host.drain();
    assert.equal(f.stateOf(id).run.t, 'running', 'a passing candidate is not a passing head');

    // Integrate the passing candidate and ask done in the same decision: the head validation
    // waits for the merge, so it runs on the merged head and finishes.
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'integrate', claimAttempt: claimOfSha(good) },
          { do: 'done', summary: 'fixed' },
        ],
      })
    );
    await f.host.drain();
    s = f.stateOf(id);
    assert.ok(s.run.t === 'finished');
    assert.deepEqual([s.run.reason, s.run.summary], ['done', 'fixed']);
    const [merged] = s.integrations;
    if (merged?.status.t !== 'integrated') throw new Error(`not integrated: ${merged?.status.t}`);
    const branch = `expedition/${id}`;
    assert.equal(git(f.repo, 'rev-parse', branch), merged.status.mergeSha);
    assert.equal(git(f.repo, 'rev-parse', `${branch}^2`), good);
    const last = s.validations.at(-1)!;
    assert.deepEqual(last.target, { t: 'head' });
    assert.deepEqual(outcomes(last), [{ checkIndex: 0, outcome: { t: 'passed' } }]);
    const { mergeSha } = merged.status;
    assert.equal(validations().at(-1)?.targetSha, mergeSha, 'done ran on the merge');
    // The owner is told the branch to merge; the owner's checkout never moved.
    assert.ok(
      s.statuses.some((x) =>
        x.text.includes(`merge branch ${branch} (head \`${mergeSha.slice(0, 7)}\`, 1 merged claim)`)
      )
    );
    assert.equal(git(f.repo, 'rev-parse', 'main'), git(f.repo, 'rev-parse', `${branch}^1`));
    // Host-verified (design.md R9): its command checks passed and it merged, so its question
    // closed verified with no panel, and it counts. 2026-11-01 smoke incident: a done expedition
    // showed the question open and "0 verified".
    assert.equal(s.questions[0].status, 'verified');
    const v = f.host.view(id);
    assert.deepEqual(
      v.verifications.map((x) => [x.t, x.claimAttemptId]),
      [['host', claimOfSha(good)]]
    );
    assert.equal(v.counts.verified, 1);
    assert.match(v.badge, / 1 verified /);
    assert.equal(s.integrationTree.status.t, 'removed', 'the integration tree goes at finish');
    for (const v of s.validations) {
      if (v.phase.t !== 'started') throw new Error(`validation ${v.id} never started`);
      assert.equal(v.phase.treeStatus.t, 'removed', `${v.id} tree released`);
    }
  } finally {
    await f.close();
  }
});

test('work on a question waits (stage waiting, no worktree) until its dependency is verified, then starts at the merged head; stages follow the ledger', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'deps', 3, { checks: [widgetFixed] });
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [question('Fix the widget', ['widget'], accept(widgetFixed))] })
    );
    const q1 = f.stateOf(id).questions[0].id;
    const after = (title: string, deps: string[]) => ({
      ...question(title, ['docs'], accept(widgetFixed)),
      after: deps,
    });
    // A dependency must name an existing question: an unknown id is a typed rejection.
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [after('Document the fix', [q1]), after('Bogus', ['q-none'])] })
    );
    assert.ok(
      f
        .ledgerOf(id)
        .some((e) => e.t === 'rejected' && /after names no question q-none/.test(e.reason))
    );
    const q2 = f.stateOf(id).questions[1].id;
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [q2, q1].map((q) => ({ do: 'work', question: q, seat: 0, brief: `work ${q}` })),
      })
    );
    const stage = (q: string) => f.host.view(id).questions.find((x) => x.id === q)!.stage;
    const workOn = (q: string) =>
      f.stateOf(id).attempts.find((a) => a.spec.kind === 'work' && a.spec.questionId === q)!;
    // Free slots and disjoint custody, yet q2's work is held: queued, no worktree, not refused.
    assert.equal(workOn(q2).phase.t, 'planned');
    assert.equal(workOn(q2).id in f.stateOf(id).worktrees, false);
    assert.equal(stage(q2), 'waiting');
    assert.equal(stage(q1), 'implementing');
    // By title, never raw ids (2026-11-01 review: "▶ w9102f5 started: work on qa218ed").
    const chat = f
      .stateOf(id)
      .statuses.map((x) => x.text)
      .join('\n');
    assert.match(
      chat,
      /⏸ Work on “Document the fix” waits until “Fix the widget” is verified/,
      'the chat says why the work waits'
    );
    assert.match(chat, /▶ Started: Work on “Fix the widget” \(claude[^)]*\)/);
    assert.ok(!chat.includes(workOn(q1).id) && !chat.includes(q1), chat);

    // q1's worker fixes the widget and claims its commit; the host validation passes.
    const w1 = workOn(q1).id;
    const sha = f.commitIn(f.treeOf(id, w1).path, 'widget/widget.ts');
    await f.answer(
      id,
      w1,
      json({
        result: 'claim',
        statement: 'fixed',
        change: { t: 'commit', sha },
        evidence: [],
        howToCheck: 'run it',
      })
    );
    await f.host.drain();
    assert.equal(stage(q1), 'validated');
    const shown = f.host.view(id).attempts.find((a) => a.id === w1)!;
    assert.equal(shown.worktree.t === 'tree' && shown.worktree.branch, `exp/${id}/${w1}`);
    assert.equal(stage(q2), 'waiting', 'a validated claim is not a verified question');

    // A blind check verifies it; the manager integrates it and closes q1 verified in one decision.
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'check', claimAttempt: w1, goal: false, panel: 1 }] })
    );
    const liveCheck = () => f.liveAttempts(id).find((a) => a.kind === 'check')!;
    await f.answer(id, liveCheck().id, json({ verdict: 'verified', why: 'reproduced' }));
    // A later panel refutes it: the earlier verification is withdrawn, so q1 cannot close
    // verified on it and its dependants stay held (review 2026-11-01: a stale verified panel
    // unlocked R5 dependencies).
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'check', claimAttempt: w1, goal: false, panel: 1 }] })
    );
    await f.answer(id, liveCheck().id, json({ verdict: 'refuted', why: 'flaky' }));
    assert.equal(f.host.view(id).counts.verified, 0, 'the badge drops a refuted verification');
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'close_question', question: q1, status: 'verified', why: 'it was verified once' },
          { do: 'check', claimAttempt: w1, goal: false, panel: 1 },
        ],
      })
    );
    assert.ok(
      f
        .ledgerOf(id)
        .some(
          (e) =>
            e.t === 'rejected' &&
            e.action.do === 'close_question' &&
            /closes verified only after a check panel verified it/.test(e.reason)
        )
    );
    assert.equal(stage(q2), 'waiting');
    await f.answer(id, liveCheck().id, json({ verdict: 'verified', why: 'reproduced again' }));
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'integrate', claimAttempt: w1 },
          { do: 'close_question', question: q1, status: 'verified', why: 'checked and merged' },
        ],
      })
    );
    await f.host.drain();
    const v = f.host.view(id);
    assert.equal(stage(q1), 'integrated');
    assert.equal(v.integration.integrated, 1);
    // Released, q2's work starts at the merged head: it builds on the dependency's code.
    assert.equal(stage(q2), 'implementing');
    assert.equal(f.treeOf(id, workOn(q2).id).baseSha, v.integration.head);
    assert.equal(git(f.repo, 'rev-parse', `expedition/${id}^2`), sha);
  } finally {
    await f.close();
  }
});

test('a host-verified claim (command checks passed, merged) lets the manager close its question verified; a later refuting panel withdraws that proof everywhere', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'hostproof', 2, { checks: [widgetFixed] });
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [question('Fix it', ['widget'], accept(widgetFixed))] })
    );
    const q = f.stateOf(id).questions[0].id;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'fix it' }] })
    );
    const w = f.liveAttempts(id).find((a) => a.kind === 'work')!;
    const sha = f.commitIn(f.treeOf(id, w.id).path, 'widget/widget.ts');
    await f.answer(
      id,
      w.id,
      json({
        result: 'claim',
        statement: 'fixed',
        change: { t: 'commit', sha },
        evidence: [],
        howToCheck: 'run it',
      })
    );
    await f.host.drain();
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'integrate', claimAttempt: w.id }] }));
    await f.host.drain();
    assert.equal(f.stateOf(id).questions[0].status, 'verified');
    assert.equal(f.host.view(id).counts.verified, 1);
    // The host's close reaches the owner's chat verbatim: by title, never the attempt or
    // validation id (2026-11-02 visual pass: "host-verified: w7b1d11 … (validation vf469ad)").
    await f.host.tick(id);
    const chat = f
      .stateOf(id)
      .statuses.map((x) => x.text)
      .join('\n');
    const validation = f.stateOf(id).validations.find((x) => x.target.t === 'candidate')!;
    assert.match(chat, /✓ verified Fix it: host-verified: its claim passed every command check/);
    assert.doesNotMatch(chat, new RegExp(`\\b(${validation.id}|${w.id})\\b`), chat);

    // 2026-11-01 smoke incident: the manager's close_question verified was refused on host proof.
    const closeVerified = { do: 'close_question', question: q, status: 'verified', why: 'merged' };
    const refusedCloses = () =>
      f.ledgerOf(id).filter((e) => e.t === 'rejected' && e.action.do === 'close_question').length;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [closeVerified, { do: 'check', claimAttempt: w.id, goal: false, panel: 1 }] })
    );
    assert.equal(refusedCloses(), 0, "host proof accepts the manager's close");

    // A panel refutes the integrated claim: the badge, the page and the close rule all drop it
    // (2026-11-01 review: only the close rule applied the refutation).
    const check = f.liveAttempts(id).find((a) => a.kind === 'check')!;
    await f.answer(id, check.id, json({ verdict: 'refuted', why: 'flaky' }));
    const v = f.host.view(id);
    assert.deepEqual(v.verifications, []);
    assert.equal(v.counts.verified, 0);
    await f.answer(id, f.manager(id), json({ actions: [closeVerified] }));
    assert.equal(refusedCloses(), 1, 'a refuted claim no longer proves its question');
  } finally {
    await f.close();
  }
});

test('an expedition holding only work that waits on a dropped dependency asks the owner instead of going quiet', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'stuck');
    await f.answer(id, f.manager(id), json({ actions: [question('Spike', ['widget'])] }));
    const q1 = f.stateOf(id).questions[0].id;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ ...question('Follow-up', ['docs']), after: [q1] }] })
    );
    const q2 = f.stateOf(id).questions[1].id;
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'work', question: q2, seat: 0, brief: 'follow up' },
          { do: 'close_question', question: q1, status: 'dead', why: 'abandoned' },
        ],
      })
    );
    const s = f.stateOf(id);
    assert.equal(s.run.t, 'waiting_owner');
    assert.match(s.run.t === 'waiting_owner' ? s.run.question : '', new RegExp(`waits for ${q1}`));
    const stages = f.host.view(id).questions.map((q) => q.stage);
    assert.deepEqual(stages, ['dead', 'waiting']);
  } finally {
    await f.close();
  }
});

test('integration merges validated candidates one at a time onto the expedition branch, refuses a conflict with its paths, and replays an applied merge as a no-op', async () => {
  const f = await fixture();
  try {
    const noBroken = {
      kind: 'command',
      argv: ['sh', '-c', '! grep -rq BROKEN widget docs'],
      timeoutSeconds: 30,
    };
    const { id } = await rpcLaunch(f, 'merge', 3, { checks: [noBroken] });
    const branch = `expedition/${id}`;
    const base = git(f.repo, 'rev-parse', 'main');
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          question('Fix the widget', ['widget'], accept(noBroken)),
          question('Docs', ['docs'], accept(noBroken)),
        ],
      })
    );
    const [qWidget, qDocs] = f.stateOf(id).questions.map((q) => q.id);
    // Two docs attempts share custody: the second starts when the first ends, still at the base.
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [qWidget, qDocs, qDocs].map((q, n) => ({
          do: 'work',
          question: q,
          seat: n % 2,
          brief: `attempt ${n}`,
        })),
      })
    );
    /** A live work attempt on `q` writes `file`, commits, and claims that commit. */
    const claimOn = async (q: string, file: string, content: string) => {
      const w = f.liveAttempts(id).find((x) => {
        const spec = f.stateOf(id).attempts.find((y) => y.id === x.id)!.spec;
        return spec.kind === 'work' && spec.questionId === q;
      })!;
      const tree = f.treeOf(id, w.id);
      assert.equal(tree.baseSha, base, `${w.id} starts at the launch base`);
      fs.writeFileSync(path.join(tree.path, file), content);
      git(tree.path, 'commit', '-q', '-am', `edit ${file}`);
      const sha = git(tree.path, 'rev-parse', 'HEAD');
      await f.answer(
        id,
        w.id,
        json({
          result: 'claim',
          statement: `edited ${file}`,
          change: { t: 'commit', sha },
          evidence: [],
          howToCheck: 'read it',
        })
      );
      await f.host.drain();
      return { attemptId: w.id, sha };
    };
    const a = await claimOn(qWidget, 'widget/widget.ts', 'export const broken = false;\n');
    const b = await claimOn(qDocs, 'docs/README.md', '# Widget, by B\n');
    const c = await claimOn(qDocs, 'docs/README.md', '# Widget, by C\n');
    assert.ok(
      f.stateOf(id).validations.every((v) => v.runs.every((r) => r.outcome.t === 'passed')),
      'every candidate passed on its own'
    );

    // Integrate all three in order (and A twice): A and B merge, C conflicts with B on the same
    // file and is refused with that path; A again is a typed rejection, not a second merge.
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [a, b, c, a].map((x) => ({ do: 'integrate', claimAttempt: x.attemptId })),
      })
    );
    await f.host.drain();
    let s = f.stateOf(id);
    assert.ok(
      f
        .ledgerOf(id)
        .some((e) => e.t === 'rejected' && /already integrated or being integrated/.test(e.reason))
    );
    const statuses = s.integrations.map((i) => [i.claimAttemptId, i.status.t]);
    assert.deepEqual(statuses, [
      [a.attemptId, 'integrated'],
      [b.attemptId, 'integrated'],
      [c.attemptId, 'refused'],
    ]);
    const [ia, ib, ic] = s.integrations;
    if (ia.status.t !== 'integrated' || ib.status.t !== 'integrated' || ic.status.t !== 'refused')
      throw new Error('unreachable');
    assert.deepEqual(ic.status.refusal, { phase: 'merge', paths: ['docs/README.md'] });
    // In order, each a --no-ff merge of its candidate onto the previous head.
    const mergeB = ib.status.mergeSha;
    assert.equal(git(f.repo, 'rev-parse', branch), mergeB);
    assert.equal(git(f.repo, 'rev-parse', `${mergeB}^1`), ia.status.mergeSha);
    assert.equal(git(f.repo, 'rev-parse', `${mergeB}^2`), b.sha);
    assert.equal(git(f.repo, 'rev-parse', `${ia.status.mergeSha}^1`), base);
    assert.equal(git(f.repo, 'rev-parse', `${ia.status.mergeSha}^2`), a.sha);
    // The refused merge was aborted: the integration tree is clean at the head, not mid-merge.
    const tree = s.integrationTree.path;
    assert.equal(git(tree, 'status', '--porcelain'), '');
    assert.equal(git(tree, 'rev-parse', 'HEAD'), mergeB);
    assert.throws(() => git(tree, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'));
    // The owner's checkout and main never moved.
    assert.equal(git(f.repo, 'rev-parse', 'main'), base);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
    // No manager is planned while merges run; the next one is shown every result, conflict
    // paths included.
    const shown = await f.core.getPost(
      OWNER,
      f.liveAttempts(id).find((x) => x.kind === 'manager')!.requestId
    );
    assert.match(shown.body, /REFUSED — merge conflict in docs\/README\.md/);

    // Replay: B's merge was made but its `integrated` line was never written (a crash between
    // the two). Only that line is dropped: the chat posts after it stay keyed as they were. The
    // host finds its own merge commit and records it; it never merges B a second time.
    const lines = fs.readFileSync(f.ledgerPath(id), 'utf8').split('\n').filter(Boolean);
    const lost = lines.filter((l) => !(l.includes('"t":"integrated"') && l.includes(ib.id)));
    assert.equal(lost.length, lines.length - 1);
    fs.writeFileSync(f.ledgerPath(id), `${lost.join('\n')}\n`);
    assert.equal(f.stateOf(id).integrations[1].status.t, 'pending');
    f.restart();
    await f.host.tick(id);
    await f.host.drain();
    s = f.stateOf(id);
    assert.deepEqual(s.integrations[1].status, { t: 'integrated', mergeSha: mergeB });
    assert.equal(s.integrations[2].status.t, 'refused');
    assert.equal(git(f.repo, 'rev-parse', branch), mergeB, 'no second merge');
    assert.equal(git(f.repo, 'rev-list', '--count', '--merges', `${base}..${branch}`), '2');

    // Done after integration: the command checks run on the merged head, and pass.
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'done', summary: 'A and B in' }] }));
    await f.host.drain();
    s = f.stateOf(id);
    assert.ok(s.run.t === 'finished');
    assert.deepEqual([s.run.reason, s.run.summary], ['done', 'A and B in']);
    const head = s.validations.at(-1)!;
    assert.equal(head.phase.t === 'started' ? head.phase.targetSha : '', mergeB);
    assert.equal(s.integrationTree.status.t, 'removed');
    assert.equal(fs.existsSync(tree), false);
    assert.equal(git(f.repo, 'rev-parse', branch), mergeB, 'the branch outlives its tree');
  } finally {
    await f.close();
  }
});

const command = (script: string, timeoutSeconds = 30) => ({
  kind: 'command',
  argv: ['sh', '-c', script],
  timeoutSeconds,
});

test('a head check that times out or cannot start is recorded as such, and done is refused for it', async () => {
  const f = await fixture();
  try {
    // Regression guard: only `passed` counts toward done. Treating "not failed" as passing let a
    // head validation that timed out or errored finish the expedition.
    // Check 1's executable resolves at launch (the preflight refuses a missing one) and is gone
    // by the time the head is validated: the spawn error is a typed `error` outcome.
    const gone = path.join(tempDir('gone-'), 'gone-check');
    fs.writeFileSync(gone, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const { id } = await rpcLaunch(f, 'timeout', 2, {
      checks: [command('echo begun; sleep 30', 1), { ...command(''), argv: [gone] }],
    });
    fs.rmSync(gone);
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'done', summary: 'surely' }] }));
    await f.host.drain();
    const runs = f.stateOf(id).validations[0].runs;
    assert.equal(runs[0].outcome.t, 'timed_out');
    assert.match(runs[0].outcome.t === 'timed_out' ? runs[0].outcome.tail : '', /begun/);
    assert.equal(runs[1].outcome.t, 'error');
    const refused = f.ledgerOf(id).find((e) => e.t === 'done_refused');
    assert.match(
      refused?.t === 'done_refused' ? refused.reason : '',
      /command check 0 timed_out on the head \w+; command check 1 error on the head/
    );
    assert.equal(f.stateOf(id).run.t, 'running');
  } finally {
    await f.close();
  }
});

test('finishing while a check runs never removes the tree under it; the tree goes once the check ends', async () => {
  const f = await fixture();
  try {
    const marker = path.join(path.dirname(f.repo), 'hold-check');
    fs.writeFileSync(marker, '');
    const { id } = await rpcLaunch(f, 'held-tree', 2, {
      checks: [command(`while [ -e '${marker}' ]; do sleep 0.05; done`, 60)],
    });
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'done', summary: 'try' }] }));
    const started = () => {
      const v = f.stateOf(id).validations[0];
      return v?.phase.t === 'started' && v.phase.treeStatus.t === 'ready' ? v.phase.tree : null;
    };
    await until('the head check to start', () => started() !== null);
    const tree = started()!;

    await f.host.steer(id, f.lead.id, { t: 'stop' });
    assert.equal(f.stateOf(id).run.t, 'finished');
    assert.equal(fs.existsSync(tree.path), true, 'the running check keeps its tree');
    assert.equal(started()?.path, tree.path, 'no release recorded while the check runs');

    fs.rmSync(marker);
    await f.host.drain();
    const v = f.stateOf(id).validations[0];
    assert.deepEqual(outcomes(v), [{ checkIndex: 0, outcome: { t: 'passed' } }]);
    assert.equal(v.phase.t === 'started' ? v.phase.treeStatus.t : v.phase.t, 'removed');
    assert.equal(fs.existsSync(tree.path), false);
  } finally {
    await f.close();
  }
});

test('a validation interrupted by a crash resumes from the ledger: before its tree, and between checks', async () => {
  const f = await fixture();
  try {
    const scratch = path.dirname(f.repo);
    const counts = [0, 1].map((n) => path.join(scratch, `ran-${n}`));
    const ran = () =>
      counts.map((c) => (fs.existsSync(c) ? fs.readFileSync(c, 'utf8').split('\n').length - 1 : 0));
    const { id } = await rpcLaunch(f, 'replay', 2, {
      checks: counts.map((c) => command(`echo run >> '${c}'`)),
    });
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'done', summary: 'fixed' }] }));
    await f.host.drain();
    assert.equal(f.stateOf(id).run.t, 'finished');
    assert.deepEqual(ran(), [1, 1]);
    const v = f.stateOf(id).validations[0];
    if (v.phase.t !== 'started') throw new Error('validation never started');
    const { tree } = v.phase;

    /** Rewinds the ledger to (and including) the first line matching `keep`. */
    const crashAfter = (keep: (line: string) => boolean) => {
      const lines = fs.readFileSync(f.ledgerPath(id), 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(
        f.ledgerPath(id),
        `${lines.slice(0, lines.findIndex(keep) + 1).join('\n')}\n`
      );
    };
    const replay = async () => {
      f.restart();
      await f.host.tick(id);
      await f.host.drain();
      const after = f.stateOf(id);
      assert.equal(after.run.t, 'finished');
      const runs = after.validations[0].runs.map((r) => [r.checkIndex, r.outcome.t]);
      assert.deepEqual(
        runs,
        [
          [0, 'passed'],
          [1, 'passed'],
        ],
        'each check recorded once'
      );
      assert.equal(fs.existsSync(tree.path), false, 'the replayed tree is released');
    };

    // Crash after the intent, before `cambium add`: the tree is made from the recorded intent.
    crashAfter((l) => l.includes('"t":"validation_started"'));
    assert.equal(f.branchExists(tree.branch), false);
    await replay();
    assert.deepEqual(ran(), [2, 2]);

    // Crash after the first check was recorded, its tree still there: only check 1 runs again.
    crashAfter((l) => l.includes('"t":"validation"'));
    git(
      f.repo,
      'cambium',
      'add',
      '-b',
      tree.branch,
      '-name',
      tree.name,
      '-ephemeral',
      tree.path,
      tree.baseSha
    );
    await replay();
    assert.deepEqual(ran(), [2, 3]);
    // Audit 2026-11-01 #10: the job died with the old process (`validation_running` was on disk),
    // so the restart is typed `interrupted` and runs in a FRESH tree at the same sha, never in the
    // tree an orphaned check may still be writing into.
    const interrupted = f.ledgerOf(id).filter((e) => e.t === 'validation_interrupted');
    assert.equal(interrupted.length, 1);
    const rerun = f.stateOf(id).validations[0];
    if (rerun.phase.t !== 'started') throw new Error('validation never restarted');
    assert.notEqual(rerun.phase.tree.path, tree.path);
    assert.equal(rerun.phase.targetSha, v.phase.targetSha, 'the same immutable sha');
    assert.equal(rerun.interruptions, 1);
  } finally {
    await f.close();
  }
});

test('a command check is killed at its timeout (its whole process group), and an exited check never waits on a background child', async () => {
  const cwd = tempDir('check-');
  const scratch = `${cwd}.scratch`;
  const started = Date.now();
  const slow = await runCommand(
    { argv: ['sh', '-c', 'echo begun; sleep 30 & sleep 30'], timeoutSeconds: 1 },
    cwd,
    scratch
  );
  assert.equal(slow.t, 'timed_out');
  assert.match(slow.t === 'timed_out' ? slow.tail : '', /begun/);
  // Exit 0 with a straggler holding stdout: passed at once, not after the straggler's 30 s.
  const quick = await runCommand(
    { argv: ['sh', '-c', 'sleep 30 & exit 0'], timeoutSeconds: 20 },
    cwd,
    scratch
  );
  assert.deepEqual(quick, { t: 'passed' });
  // A straggler that left the process group (its own session) survives the group kill and holds
  // the pipes: the check still settles, after the pipe grace, at exit and at the timeout (review
  // 2026-11-01: it never settled, and the validation stalled with nothing in the ledger).
  const escaped = (pidFile: string) =>
    `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">${pidFile}"); print F $$; close(F); sleep 20' &`;
  const pids = [path.join(cwd, 'a.pid'), path.join(cwd, 'b.pid')];
  try {
    const exited = await runCommand(
      {
        argv: ['sh', '-c', `${escaped(pids[0])} sleep 0.5; exit 0`],
        timeoutSeconds: 20,
      },
      cwd,
      scratch
    );
    assert.deepEqual(exited, { t: 'passed' });
    const stuck = await runCommand(
      { argv: ['sh', '-c', `${escaped(pids[1])} sleep 30`], timeoutSeconds: 1 },
      cwd,
      scratch
    );
    assert.equal(stuck.t, 'timed_out');
  } finally {
    for (const file of pids)
      try {
        process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGKILL');
      } catch {}
  }
  // Agent-written code never sees the server's secrets: only a curated environment reaches it.
  process.env.EXPEDITION_TEST_SECRET = 'sk-test';
  try {
    const env = await runCommand(
      {
        argv: ['sh', '-c', 'test -z "$EXPEDITION_TEST_SECRET"'],
        timeoutSeconds: 5,
      },
      cwd,
      scratch
    );
    assert.deepEqual(env, { t: 'passed' }, 'the server environment leaked into a check');
  } finally {
    Reflect.deleteProperty(process.env, 'EXPEDITION_TEST_SECRET');
  }
  // Audit 2026-11-01 #3: HOME was the owner's, so agent-written check code could read ~/.ssh.
  // A check gets a throwaway HOME and TMPDIR, made empty for the run and removed after it.
  const realHome = process.env.HOME;
  const owner = tempDir('owner-home-');
  fs.mkdirSync(path.join(owner, '.ssh'));
  fs.writeFileSync(path.join(owner, '.ssh', 'config'), 'IdentityFile OWNER-SECRET-KEY\n');
  process.env.HOME = owner;
  try {
    const home = await runCommand(
      {
        argv: ['sh', '-c', 'echo "home=$HOME tmp=$TMPDIR"; cat "$HOME/.ssh/config"'],
        timeoutSeconds: 5,
      },
      cwd,
      scratch
    );
    assert.equal(home.t, 'failed', "a check read the owner's ~/.ssh/config");
    const tail = home.t === 'failed' ? home.tail : '';
    assert.doesNotMatch(tail, /OWNER-SECRET-KEY/);
    assert.match(tail, new RegExp(`home=${scratch}/home tmp=${scratch}/tmp`));
    assert.equal(fs.existsSync(scratch), false, 'the throwaway home is removed after the run');
  } finally {
    process.env.HOME = realHome;
  }
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
  const missing = await runCommand(
    { argv: ['no-such-binary-xyz'], timeoutSeconds: 5 },
    cwd,
    scratch
  );
  assert.equal(missing.t, 'error');
});

test('an ended attempt records the tokens its settled run measured, never before the transcript is indexed; a run that never executed is "not measured"', async () => {
  const f = await fixture();
  const home = tempDir('expedition-meter-home-');
  // The crew run's transcript: one Claude session with two billed requests.
  const session = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  const turn = (id: string, usage: Record<string, number>) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: session,
      cwd: f.repo,
      timestamp: new Date().toISOString(),
      message: { id, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'ok' }] },
    });
  const transcript = path.join(home, '.claude', 'projects', '-tmp-exp', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: 'user',
        sessionId: session,
        cwd: f.repo,
        message: { content: 'plan' },
      }),
      turn('r1', { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 5_000 }),
      turn('r2', { input_tokens: 500, output_tokens: 100, cache_creation_input_tokens: 300 }),
      '',
    ].join('\n')
  );
  const ingest = await Ingest.start(defaultRoots(home), path.join(home, 'ingest.sqlite'), () => {});
  try {
    f.meter.slot = { t: 'ready', ingest };
    // Launch at the real time: the test reads the run's real end time below, and a launch at the
    // fixture's fixed clock was past its 4h deadline by then on any day after 04:00 UTC.
    f.setClock(Date.now());
    const { id } = await rpcLaunch(f, 'meter');
    const m1 = f.manager(id);
    const requestId = f.liveAttempts(id)[0].requestId;
    // Execute the manager's request the way the Buddy runner does: claim, bind a conversation,
    // mark executing, answer, settle.
    let claim = await f.core.claimRun(BUDGETS, []);
    while (claim && !(claim.run.input.kind === 'post' && claim.run.input.postId === requestId))
      claim = await f.core.claimRun(BUDGETS, []);
    if (!claim) throw new Error('the manager request run was never claimable');
    const conversationId = `buddy-run-${claim.run.id}`;
    f.meter.sessions.set(conversationId, [session]);
    await f.core.bindRun(claim.run.id, claim.leaseToken, conversationId);
    await f.core.markExecuting(claim.run.id, claim.leaseToken);
    f.setClock(Date.now());
    await f.answer(id, m1, json({ actions: [] }));
    // Answered but the run has not settled: the attempt ended, its cost is not read yet.
    assert.ok(!(m1 in f.stateOf(id).costs), 'metered a run that is still running');
    await f.core.settleRun(claim.run.id, claim.leaseToken, { kind: 'complete', text: 'done' });
    f.setClock(Date.now());
    await f.host.tick(id);
    // Settled, but its last transcript lines may not be indexed yet (meter.ts INDEX_GRACE_MS).
    assert.ok(!(m1 in f.stateOf(id).costs), 'metered inside the transcript-index grace');
    f.setClock(Date.now() + 20_000);
    await f.host.tick(id);
    assert.deepEqual(f.stateOf(id).costs[m1], {
      t: 'measured',
      inputTokens: 1_500,
      outputTokens: 300,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 300,
    });
    // An empty plan asks the owner; a note starts the next manager, answered with no run at all
    // (as every other test does): not measured, with the reason; totals count only the measured.
    await f.host.steer(id, f.lead.id, { t: 'note', text: 'Go on.' });
    const m2 = f.manager(id);
    await f.answer(id, m2, json({ actions: [] }));
    assert.deepEqual(f.stateOf(id).costs[m2], {
      t: 'unmeasured',
      reason: 'no Buddy run executed this request',
    });
    const view = f.host.view(id);
    assert.match(view.cost.line, /^Cost: 2k input \+ 300 output tokens .* over 1 measured attempt/);
    assert.match(view.cost.line, /1 not measured \(no Buddy run executed this request\)/);
    assert.equal(view.cost.short, '2k tokens');
    assert.match(f.host.status(id), /Cost: 2k input/);

    // Metering is display only (audit 2026-11-01): a run that never settles is "not measured"
    // once its window passed, so it cannot keep the expedition active forever.
    await f.host.steer(id, f.lead.id, { t: 'note', text: 'Once more.' });
    const m3 = f.manager(id);
    const m3Request = f.liveAttempts(id).find((a) => a.id === m3)!.requestId;
    let stuck = await f.core.claimRun(BUDGETS, []);
    while (stuck && !(stuck.run.input.kind === 'post' && stuck.run.input.postId === m3Request))
      stuck = await f.core.claimRun(BUDGETS, []);
    if (!stuck) throw new Error('the third manager request run was never claimable');
    await f.core.markExecuting(stuck.run.id, stuck.leaseToken);
    await f.answer(id, m3, json({ actions: [] }));
    assert.ok(!(m3 in f.stateOf(id).costs), 'still settling inside the window');
    f.setClock(Date.now() + 2 * 3_600_000);
    await f.host.tick(id);
    assert.deepEqual(f.stateOf(id).costs[m3], {
      t: 'unmeasured',
      reason: 'its runs did not settle within 60 minutes',
    });
  } finally {
    await ingest.stop();
    await f.close();
  }
});

test('draft validates a charter without launching; launch fills only named defaults and says which', async () => {
  const f = await fixture();
  try {
    // Only the WHAT: name, goal, done, budget.
    const minimal = {
      name: 'minimal',
      goal: 'Make the widget pass its test.',
      done: { checks: [{ kind: 'command', argv: ['no-such-binary-xyz'], timeoutSeconds: 60 }] },
      maxAttempts: 10,
    };
    const drafted = await rpc(f.spec(), 'expedition', {
      action: { do: 'draft', charter: minimal },
    });
    assert.equal(drafted.error, false, drafted.text);
    assert.equal(drafted.value.ready, false);
    assert.ok(
      drafted.value.issues.some((i: string) => i.includes('no-such-binary-xyz')),
      drafted.text
    );
    assert.ok(drafted.value.defaulted.some((d: string) => d.startsWith('crew: the default crew')));
    assert.ok(drafted.value.advice.some((a: string) => a.startsWith('No out-of-scope fence')));
    assert.deepEqual(f.host.list(f.workspaceId), [], 'a draft launched nothing');

    // A roster whose only check seat is the work seat's model could never check a claim.
    const sameModel = {
      ...minimal,
      done: { checks: [{ kind: 'command', argv: ['sh', '-c', 'true'], timeoutSeconds: 60 }] },
      crew: {
        manager: { provider: 'claude' },
        work: [{ provider: 'claude' }],
        check: [{ provider: 'claude' }],
      },
    };
    const refused = await rpc(f.spec(), 'expedition', {
      action: { do: 'launch', charter: sameModel },
    });
    assert.equal(refused.error, true);
    assert.match(refused.text, /work seat 0 \(claude\) has no check seat on another model/);
    assert.deepEqual(f.host.list(f.workspaceId), []);

    const launched = await rpc(f.spec(), 'expedition', {
      action: { do: 'launch', charter: { ...sameModel, crew: undefined } },
    });
    assert.equal(launched.error, false, launched.text);
    // The page path is data, never a markdown link to post: the host already posted the badge
    // (2026-11-01 smoke incident: the posted link was refused as a missing media attachment).
    assert.match(launched.value.page, /^\/expeditions\/minimal-[0-9a-f]{6}$/);
    assert.equal('link' in launched.value, false);
    assert.match(launched.value.next, /already in this chat/);
    assert.match(
      launched.value.launched,
      /done when \$ sh -c true \| budget 10 attempts, 2 live, 8h/
    );
    assert.deepEqual(
      launched.value.defaulted.map((d: string) => d.split(':')[0]),
      ['inScope', 'outOfScope', 'maxLive', 'hours', 'exploreShare', 'crew']
    );
    // The ledger holds the full charter, defaults written out.
    const c = f.stateOf(launched.value.id).charter;
    assert.deepEqual([c.maxLive, c.hours, c.exploreShare, c.crew.check.length], [2, 8, 0.2, 2]);
  } finally {
    await f.close();
  }
});

/** Every post the owner can read in the workspace with this purpose (any channel, DMs too). */
async function postsWithPurpose(f: Awaited<ReturnType<typeof fixture>>, purpose: string) {
  const out = [];
  for (const { channel } of (await f.core.inbox(OWNER, f.workspaceId)).channels) {
    const { posts } = await f.core.listPosts(
      OWNER,
      { kind: 'channel', channelId: channel.id },
      null,
      200
    );
    out.push(...posts.filter((p) => p.purpose === purpose));
  }
  return out;
}

// 2026-11-01 owner request: a draft is a card in the chat (Info, Launch), launched over HTTP
// through the tool's own launch path. These are the ways a card could launch the wrong thing,
// launch twice, launch for another workspace, or land in the wrong chat.
test('draft posts one card where the badge goes; the card launches once over HTTP, never a superseded draft, never from another workspace, never by a crew', async () => {
  const f = await fixture();
  const app = express();
  app.use(express.json());
  registerExpeditionRoutes(app, () => f.host);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const draftOf = (id: string, workspaceId = f.workspaceId) =>
      fetch(`${base}/api/buddies/expeditions/drafts/${id}?workspaceId=${workspaceId}`);
    const launchDraft = (id: string, workspaceId = f.workspaceId) =>
      fetch(`${base}/api/buddies/expeditions/drafts/${id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });

    const drafted = await rpc(f.spec(), 'expedition', {
      action: { do: 'draft', charter: charter('cardy') },
    });
    assert.equal(drafted.error, false, drafted.text);
    assert.equal(drafted.value.ready, true, drafted.text);
    assert.match(drafted.value.next, /draft card in this chat/);
    assert.equal('charter' in drafted.value, false, 'the Buddy gets no charter to paste');
    const draftId: string = drafted.value.draftId;
    const cards = await postsWithPurpose(f, 'expedition_draft');
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0].evidence, [`expedition-draft:${draftId}`]);
    assert.equal(cards[0].body, '⛺ Draft expedition: cardy');

    const view = (await (await draftOf(draftId)).json()) as {
      state: { t: string };
      charter: { name: string; goal: string };
      issues: string[];
    };
    assert.deepEqual(view.state, { t: 'open' });
    assert.equal(view.charter.name, 'cardy');
    assert.deepEqual(view.issues, []);

    // Another workspace sees no draft and cannot launch it.
    assert.equal((await draftOf(draftId, 'ws-other')).status, 404);
    assert.equal((await launchDraft(draftId, 'ws-other')).status, 404);
    assert.deepEqual(f.host.list(f.workspaceId), []);

    // Launch: the same host path as the tool; a second click answers the same expedition.
    const first = await launchDraft(draftId);
    assert.equal(first.status, 200);
    const { expeditionId } = (await first.json()) as { expeditionId: string };
    const second = await launchDraft(draftId);
    assert.deepEqual(await second.json(), { expeditionId });
    assert.deepEqual(
      f.host.list(f.workspaceId).map((x) => x.id),
      [expeditionId]
    );
    assert.deepEqual(((await (await draftOf(draftId)).json()) as typeof view).state, {
      t: 'launched',
      expeditionId,
    });
    // The badge lands in the card's chat (one placement rule), and the launch post names the
    // charter and its goal's first sentence, with "Planning…" as its own paragraph.
    const s = f.stateOf(expeditionId);
    if (s.badgePost.t !== 'posted') throw new Error('badge expected');
    const badge = await f.core.getPost(OWNER, s.badgePost.postId);
    assert.equal(badge.channelId, cards[0].channelId);
    assert.equal(
      s.statuses[0].text,
      '⛺ Launched **cardy**: Make the widget pass its test.\n\nPlanning…'
    );

    // Re-drafting a name in the same conversation supersedes the open draft: its Launch is a 409
    // naming the newer draft, and the newer one still launches.
    const older = (
      await rpc(f.spec(), 'expedition', { action: { do: 'draft', charter: charter('twice') } })
    ).value.draftId as string;
    const newer = (
      await rpc(f.spec(), 'expedition', { action: { do: 'draft', charter: charter('twice', 3) } })
    ).value.draftId as string;
    const refused = await launchDraft(older);
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, new RegExp(newer));
    assert.deepEqual(((await (await draftOf(newer)).json()) as typeof view).state, { t: 'open' });

    // Launching by the tool closes that name's open card too, so it no longer offers Launch.
    const viaTool = await rpcLaunch(f, 'twice', 3);
    assert.deepEqual(((await (await draftOf(newer)).json()) as typeof view).state, {
      t: 'launched',
      expeditionId: viaTool.id,
    });

    // A crew Buddy cannot draft (it could otherwise put a Launch button in front of the owner).
    if (s.crew.t !== 'ready') throw new Error('crew expected');
    const crewDraft = await rpc(f.specAs(s.crew.buddyId, f.workspaceId), 'expedition', {
      action: { do: 'draft', charter: charter('nested') },
    });
    assert.equal(crewDraft.error, true);
    assert.match(crewDraft.text, /an expedition crew cannot draft expeditions/);

    // The rosters hide crew Buddies by the server's explicit list (crew_ready entries).
    const crews = (await (await fetch(`${base}/api/buddies/expeditions/crews`)).json()) as {
      buddyIds: string[];
    };
    assert.ok(crews.buddyIds.includes(s.crew.buddyId), JSON.stringify(crews));
    assert.equal(crews.buddyIds.includes(f.lead.id), false);

    // 2026-11-01 review: host.launch appends the ledger before the draft is saved launched. A
    // crash in between left the draft open: a click then got "stop it first" about the
    // expedition this very draft started, and once that finished, launched a second one.
    const recordOf = (id: string) =>
      JSON.parse(fs.readFileSync(path.join(f.root, 'drafts', `${id}.json`), 'utf8'));
    const launchBehind = async (name: string) => {
      const id = (
        await rpc(f.spec(), 'expedition', { action: { do: 'draft', charter: charter(name) } })
      ).value.draftId as string;
      const r = recordOf(id);
      const behind = await f.host.launch({
        key: r.key,
        charter: r.charter,
        origin: r.origin,
        launcherId: r.launcherId,
        workspaceId: r.workspaceId,
      });
      if (behind.t !== 'launched') throw new Error('launch expected');
      assert.deepEqual(recordOf(id).state, { t: 'open' }, 'the crash: draft never marked');
      return { id, expeditionId: behind.state.id };
    };
    const raced = await launchBehind('raced');
    const click = await launchDraft(raced.id);
    assert.equal(click.status, 200, await click.clone().text());
    assert.deepEqual(await click.json(), { expeditionId: raced.expeditionId });
    const crashed = await launchBehind('crashed');

    // A restarted host reads the drafts back: the launched card still says launched, and the
    // crashed draft is launched from its ledger.
    f.restart();
    assert.deepEqual(((await (await draftOf(draftId)).json()) as typeof view).state, {
      t: 'launched',
      expeditionId,
    });
    assert.deepEqual(((await (await draftOf(crashed.id)).json()) as typeof view).state, {
      t: 'launched',
      expeditionId: crashed.expeditionId,
    });
    // A draft file that is not a draft is named at boot and reads as no draft, never a guess.
    fs.writeFileSync(
      path.join(f.root, 'drafts', 'draft-0000beef.json'),
      JSON.stringify({ ...recordOf(crashed.id), id: 'draft-0000beef', charter: { name: 'x' } })
    );
    f.restart();
    assert.equal((await draftOf('draft-0000beef')).status, 404);
  } finally {
    server.close();
    await f.close();
  }
});

// A card must land in the conversation the draft came from (a thread's root, or the DM), and its
// Launch must reflect the charter as it stands at click time, not as it stood when drafted.
test('a thread draft posts its card in that thread; an open draft re-checks its issues on read and on Launch', async () => {
  const f = await fixture();
  const app = express();
  app.use(express.json());
  registerExpeditionRoutes(app, () => f.host);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const channel = await f.core.createChannel(OWNER, {
      workspaceId: f.workspaceId,
      name: 'planning',
      purpose: 'Plans',
      key: 'planning',
    });
    const root = await f.core.post(
      OWNER,
      { kind: 'id', id: channel.id },
      {
        kind: 'inform',
        body: 'Draft the widget expedition.',
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'root',
      }
    );
    const input = (name: string, done: unknown, issues: string[]) => ({
      key: `thread:${name}`,
      charter: Charter.parse(charter(name, 2, done)),
      issues,
      advice: [],
      defaulted: [],
      resolved: [],
      origin: { t: 'thread' as const, channelId: channel.id, rootId: root.post.id },
      launcherId: f.lead.id,
      workspaceId: f.workspaceId,
    });
    // Drafted with a stale issue that no longer holds: the view re-checks and shows none.
    const fine = await f.host.drafts.draft(input('fine', judged, ['stale: binary missing']));
    // Replies are not channel-feed rows: the card is read from the thread itself.
    const thread = await f.core.listPosts(
      OWNER,
      { kind: 'thread', rootId: root.post.id },
      null,
      50
    );
    const cards = thread.posts.filter((p) => p.purpose === 'expedition_draft');
    assert.equal(cards.length, 1, JSON.stringify(thread.posts.map((p) => p.body)));
    const [card] = cards;
    assert.equal(card.channelId, channel.id);
    assert.equal(card.rootId, root.post.id);
    const view = await fetch(
      `${base}/api/buddies/expeditions/drafts/${fine.id}?workspaceId=${f.workspaceId}`
    );
    assert.deepEqual(((await view.json()) as { issues: string[] }).issues, []);

    // Drafted with no issues, but its check's binary is missing: Launch is refused (422) at click.
    const missing = {
      checks: [{ kind: 'command', argv: ['no-such-binary-xyz'], timeoutSeconds: 60 }],
    };
    const broken = await f.host.drafts.draft(input('broken', missing, []));
    const refused = await fetch(`${base}/api/buddies/expeditions/drafts/${broken.id}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: f.workspaceId }),
    });
    assert.equal(refused.status, 422);
    assert.match(((await refused.json()) as { error: string }).error, /no-such-binary-xyz/);
    assert.deepEqual(f.host.list(f.workspaceId), []);
  } finally {
    server.close();
    await f.close();
  }
});

// 2026-11-01 owner screenshot: the launch post read "…Engin", a raw slice cut mid-word.
test('chat lines are clipped at a word boundary, never inside a word; a goal summary is its first sentence', () => {
  const words =
    'Build the beach erosion model on the Engine with real sediment transport and tides'.split(' ');
  const text = words.join(' ');
  for (let n = 5; n < text.length; n++) {
    const out = clip(text, n);
    assert.ok(out.length <= n + 1, `${n}: ${out}`);
    const kept = out.replace(/…$/, '').split(' ');
    for (const word of kept) assert.ok(words.includes(word), `${n}: "${word}" is a cut word`);
  }
  assert.equal(clip(text, 500), text);
  assert.equal(
    goalSummary('## Goal\n1. Make the widget pass. Then document it.\n2. Ship.'),
    'Make the widget pass.'
  );
  assert.equal(
    goalSummary('Use tools, e.g. the linter. Then ship.'),
    'Use tools, e.g. the linter.'
  );
  // A charter name is plain text: its markdown punctuation cannot open emphasis in the post.
  assert.match(launchNews({ name: 'fix *all*_x', goal: 'Go.' }), /\*\*fix \\\*all\\\*\\_x\*\*/);
  // An owner question keeps its list (its own paragraph), and a long one is cut between words.
  const block = clipBlock('**Needs you:**', '1. Option A\n2. Option B');
  assert.match(block, /\n\n1\. Option A\n2\. Option B\n$/);
  const long = clipBlock('L', text, 30).trim().split('\n\n')[1];
  for (const word of long.replace(/…$/, '').split(' ')) assert.ok(words.includes(word), long);
});

const BUDGETS = { leaseMs: 60_000, chatDeadlineMs: 60_000, turnDeadlineMs: 60_000 };

async function rpcLaunch(
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

test('the attempt budget counts work and check attempts only; the last result still reaches a manager; decisions stop at their own cap', async () => {
  const f = await fixture();
  try {
    // 2026-11-01 smoke incident: "Budget 6 attempts" allowed ONE work attempt, because manager
    // decisions counted against it. Here a budget of 2 runs two work attempts after any number
    // of decisions.
    const launchBudget2 = async (name: string) => {
      const launched = await rpc(f.spec(), 'expedition', {
        action: { do: 'launch', charter: { ...charter(name), maxAttempts: 2 } },
      });
      assert.equal(launched.error, false, launched.text);
      return launched.value.id as string;
    };
    const id = await launchBudget2('spent');
    await f.answer(id, f.manager(id), json({ actions: [question('Fix it', ['widget'])] }));
    const q = f.stateOf(id).questions[0].id;
    const workOnce = async () => {
      await f.answer(
        id,
        f.manager(id),
        json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'go' }] })
      );
      const work = f.liveAttempts(id).find((a) => a.kind === 'work');
      assert.ok(work, 'the work attempt was admitted and briefed');
      await f.answer(id, work.id, json({ result: 'finding', statement: 'nope', evidence: [] }));
    };
    await workOnce();
    await workOnce();
    let v = f.host.view(id);
    assert.deepEqual([v.counts.attempts, v.counts.decisions], [2, 4]);
    assert.match(v.badge, / 2\/2 attempts /);
    // The budget is spent, but the last result is news: a manager is shown it before the end.
    assert.equal(f.stateOf(id).run.t, 'running');
    // That manager asks for more work anyway: refused, and neither the refusal nor its new
    // question wakes another manager (2026-11-01 review: each refusal was news, so managers
    // spun up to the decision cap after the budget was gone).
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [{ do: 'work', question: q, seat: 0, brief: 'more' }, question('More', ['docs'])],
      })
    );
    const s = f.stateOf(id);
    assert.ok(s.unseen.some((e) => e.t === 'rejected' && e.reason === 'attempt budget spent'));
    assert.equal(s.run.t === 'finished' && s.run.reason, 'attempts_spent');
    assert.equal(f.host.view(id).counts.decisions, 4, 'one manager after the spend, no more');
    // Live e2e 2026-11-01: a finished expedition's badge read "finished · 10m" two minutes after
    // it ended and kept counting. Its elapsed time stops at the finish.
    const finishedBadge = f.host.view(id).badge;
    f.setClock(Date.parse('2026-11-01T03:00:00Z'));
    assert.equal(f.host.view(id).badge, finishedBadge, 'the finished badge clock stopped');

    // A manager whose every action is refused cannot spin: decisions have their own cap.
    const spin = await launchBudget2('spin');
    let turns = 0;
    while (f.liveAttempts(spin).some((a) => a.kind === 'manager')) {
      turns += 1;
      const bogus = { do: 'close_question', question: 'q-none', status: 'dead', why: 'x' };
      await f.answer(spin, f.manager(spin), json({ actions: [bogus] }));
      assert.ok(turns <= 50, 'manager turns are bounded');
    }
    v = f.host.view(spin);
    assert.equal(turns, v.counts.maxDecisions);
    assert.deepEqual(v.run.t === 'finished' && v.run.reason, 'decisions_spent');
    assert.equal(v.counts.attempts, 0);
  } finally {
    await f.close();
  }
});

test('an attempt run starts in its own worktree (two concurrent runs of one crew do not collide), a manager in its own detached tree, any other Buddy in its workspace; answering a hosted attempt wakes no extra crew run', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'dirs', 2);
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [question('Widget', ['widget']), question('Docs', ['docs'])] })
    );
    const [q1, q2] = f.stateOf(id).questions.map((q) => q.id);
    const managerId = f.manager(id);
    const s0 = f.stateOf(id);
    if (s0.crew.t !== 'ready') throw new Error('crew expected');
    const crewId = s0.crew.buddyId;
    const runOf = async (requestId: string) => {
      const runs = await f.core.listRuns({ kind: 'buddy', buddyId: crewId }, 100);
      const run = runs.find((r) => r.input.kind === 'post' && r.input.postId === requestId);
      if (!run) throw new Error(`no run for ${requestId}`);
      return run;
    };
    const context = (runId: string | null, buddyId = crewId) => ({
      buddyId,
      workspaceId: f.workspaceId,
      coordinationRunId: runId,
    });
    const briefings = createBriefings(
      f.core,
      () => ({ kind: 'agent', provider: 'codex' }) as const,
      (c) => f.host.turnDirectory(c)
    );
    const managerRun = await runOf(f.liveAttempts(id).find((a) => a.id === managerId)!.requestId);
    await briefings.warm(context(managerRun.id));
    // R11 (audit #6): the manager's own detached tree, never the owner's checkout nor the
    // integration tree the host merges into.
    const managerTree = f.stateOf(id).managerTree;
    if (managerTree.t !== 'ready') throw new Error(`manager tree ${managerTree.t}`);
    assert.equal(briefings.current(context(managerRun.id)).workingDirectory, managerTree.path);
    assert.notEqual(managerTree.path, f.stateOf(id).integrationTree.path);
    assert.equal(
      git(managerTree.path, 'rev-parse', 'HEAD'),
      git(f.repo, 'rev-parse', `expedition/${id}`)
    );
    assert.throws(() => git(managerTree.path, 'symbolic-ref', '-q', 'HEAD'), 'detached: no branch');

    await f.answer(
      id,
      managerId,
      json({
        actions: [q1, q2].map((question, n) => ({ do: 'work', question, seat: n, brief: 'go' })),
      })
    );
    const work = f.liveAttempts(id).filter((a) => a.kind === 'work');
    assert.equal(work.length, 2);
    const runs = await Promise.all(work.map((w) => runOf(w.requestId)));
    // Both warm before either turn reads its briefing: a per-Buddy cache would hand both runs
    // the worktree of whichever warmed last.
    await Promise.all(runs.map((r) => briefings.warm(context(r.id))));
    work.forEach((w, n) => {
      assert.equal(
        briefings.current(context(runs[n].id)).workingDirectory,
        f.treeOf(id, w.id).path,
        `${w.id} starts in its own worktree`
      );
    });
    await briefings.warm(context(null, f.lead.id));
    assert.equal(briefings.current(context(null, f.lead.id)).workingDirectory, f.repo);

    // Every other crew turn starts in the crew's own fixed directory, no git checkout (2026-11-01
    // review: a mention or the owner's chat with the crew started in the owner's checkout before
    // setup and after finish). A turn with no run (a boot or creation warm, a chat before its run
    // is armed) and the ended manager attempt's run (a boot warm of an old conversation) both get
    // it, under the Buddy's key, which the chat turn reads.
    const crewDir = path.join(f.root, id, 'crew');
    await briefings.warm(context(null));
    assert.equal(briefings.current(context(null)).workingDirectory, crewDir);
    briefings.forget(managerRun.id); // the runner did at its settle
    await briefings.warm(context(managerRun.id));
    assert.equal(briefings.current(context(managerRun.id)).workingDirectory, crewDir);
    assert.equal(briefings.current(context(null)).workingDirectory, crewDir);
    assert.ok(fs.statSync(crewDir).isDirectory());

    // 2026-11-01 smoke incident: the crew answering its host-posted request enqueued a delivery
    // to the crew itself (no conversation spawned the request), which woke an extra unmetered
    // turn in the workspace root that obeyed the answer and committed on the owner's main.
    await f.answer(id, work[0].id, json({ result: 'finding', statement: 'no', evidence: [] }));
    const crewRuns = await f.core.listRuns({ kind: 'buddy', buddyId: crewId }, 100);
    assert.deepEqual(
      crewRuns.filter((r) => r.input.kind === 'deliver'),
      [],
      'no delivery wakes the crew'
    );
    const posted = f
      .stateOf(id)
      .attempts.filter((a) => a.phase.t === 'posted' || a.phase.t === 'ended');
    assert.equal(crewRuns.length, posted.length, 'one crew run per attempt, no extra');
  } finally {
    await f.close();
  }
});

test('owner model words resolve to the catalog id once, at ingestion; a name that picks no single model is refused with the valid ids', async () => {
  const f = await fixture();
  try {
    const seats = (work: string, check: string) => ({
      ...charter('models', 2, {
        checks: [{ kind: 'command', argv: ['sh', '-c', 'true'], timeoutSeconds: 30 }],
      }),
      crew: {
        manager: { provider: 'claude', model: 'sonnet' },
        work: [{ provider: 'claude', model: work }],
        check: [{ provider: 'codex', model: check }],
      },
    });
    // 2026-11-01 smoke incident: "claude haiku" failed the launch (the catalog takes full ids).
    const drafted = await rpc(f.spec(), 'expedition', {
      action: { do: 'draft', charter: seats('claude haiku', 'gpt-6-sol') },
    });
    assert.equal(drafted.error, false, drafted.text);
    assert.equal(drafted.value.ready, true, drafted.text);
    // The canonical charter is what the draft persisted (and what its card launches).
    const persisted = (r: { value: { draftId: string } }) =>
      JSON.parse(fs.readFileSync(path.join(f.root, 'drafts', `${r.value.draftId}.json`), 'utf8'))
        .charter;
    assert.equal(persisted(drafted).crew.work[0].model, 'claude-haiku-5-5');
    // An alias kept as written would defeat the independence rule (it compares model strings).
    assert.equal(persisted(drafted).crew.manager.model, 'claude-sonnet-5-5');
    assert.deepEqual(drafted.value.resolved, [
      'manager: "sonnet" → claude-sonnet-5-5',
      'work seat 0: "claude haiku" → claude-haiku-5-5',
    ]);
    // An open provider (opencode accepts ad-hoc ids) keeps its id as written: word matching
    // would rewrite opencode/gpt-5 to opencode/gpt-5-nano, another model (2026-11-01 review).
    const open = await rpc(f.spec(), 'expedition', {
      action: {
        do: 'draft',
        charter: {
          ...seats('haiku', 'gpt-6-sol'),
          crew: {
            manager: { provider: 'claude', model: 'claude-sonnet-5-5' },
            work: [{ provider: 'opencode', model: 'opencode/gpt-5' }],
            check: [{ provider: 'codex', model: 'gpt-6-sol' }],
          },
        },
      },
    });
    assert.equal(persisted(open).crew.work[0].model, 'opencode/gpt-5', open.text);
    assert.deepEqual(open.value.resolved, []);
    // "sol" names three codex models: refused, listing the valid ids, never a guess.
    const refused = await rpc(f.spec(), 'expedition', {
      action: { do: 'draft', charter: seats('haiku', 'sol') },
    });
    assert.equal(refused.value.ready, false);
    assert.match(refused.value.issues.join('\n'), /codex: sol \(valid: .*gpt-6-sol/);
  } finally {
    await f.close();
  }
});

test('boot cuts a torn last append and quarantines a ledger that does not read or fold; the others keep running', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'torn');
    const file = f.ledgerPath(id);
    const before = fs.readFileSync(file, 'utf8');
    // A crash during appendFile: a partial batch with no newline.
    fs.appendFileSync(file, '[{"t":"feedback","at":"2026-11-01T00:00:0');
    const broken = (name: string, text: string) => {
      fs.mkdirSync(path.join(f.root, name));
      fs.writeFileSync(path.join(f.root, name, 'ledger.jsonl'), text);
    };
    broken('garbage-aaaaaa', 'not json\n');
    broken(
      'headless-bbbbbb',
      `${JSON.stringify([{ t: 'status', at: '2026-11-01T00:00:00Z', seq: 0, text: 'x' }])}\n`
    );
    // Before: JSON.parse threw inside createExpeditionHost and aborted server startup.
    f.restart();
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the torn batch is cut off, whole');
    const garbage = f.host.lookup('garbage-aaaaaa');
    assert.equal(garbage.t, 'quarantined');
    const headless = f.host.lookup('headless-bbbbbb');
    assert.match(
      headless.t === 'quarantined' ? headless.reason : '',
      /does not fold: ledger must start with launched/
    );
    assert.deepEqual(
      f.host.list(f.workspaceId).map((x) => x.id),
      [id]
    );
    // The healthy expedition steers on: its next append starts on a line of its own.
    await f.host.steer(id, f.lead.id, { t: 'note', text: 'after the crash' });
    assert.ok(f.ledgerOf(id).some((e) => e.t === 'feedback' && e.via.t === 'tool'));
    const app = express();
    registerExpeditionRoutes(app, () => f.host);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const page = await fetch(`${base}/api/buddies/expeditions/garbage-aaaaaa`);
      assert.equal(page.status, 409);
      assert.match(((await page.json()) as { error: string }).error, /quarantined/);
    } finally {
      server.close();
    }
  } finally {
    await f.close();
  }
});

test("the expedition tool refuses a crew launch or steer and another workspace's status or steer; a relaunch returns the running one, and launches anew after it finished", async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'bounds');
    const s = f.stateOf(id);
    if (s.crew.t !== 'ready') throw new Error('crew expected');
    const asCrew = f.specAs(s.crew.buddyId, f.workspaceId);
    const crewLaunch = await rpc(asCrew, 'expedition', {
      action: { do: 'launch', charter: charter('nested') },
    });
    assert.equal(crewLaunch.error, true);
    assert.match(crewLaunch.text, /an expedition crew cannot launch expeditions/);
    // A crew worker must not override the owner: it cannot resume a paused run, or stop one.
    await f.host.steer(id, f.lead.id, { t: 'pause' });
    const crewResume = await rpc(asCrew, 'expedition', {
      action: { do: 'steer', id, feedback: { t: 'resume' } },
    });
    assert.match(crewResume.text, /an expedition crew cannot steer expeditions/);
    assert.equal(f.stateOf(id).run.t, 'paused');
    assert.equal((await rpc(asCrew, 'expedition', { action: { do: 'status', id } })).error, false);

    const other = await f.core.createWorkspace(OWNER, { name: 'Other', rootPath: tempDir('o-') });
    const stranger = await f.core.createBuddy(OWNER, {
      workspaceId: other.id,
      slug: 'stranger',
      name: 'Stranger',
      role: 'Stranger',
      manager: { kind: 'nobody' },
      key: 'stranger',
    });
    const asStranger = f.specAs(stranger.id, other.id);
    for (const action of [
      { do: 'status', id },
      { do: 'steer', id, feedback: { t: 'stop' } },
    ]) {
      const refused = await rpc(asStranger, 'expedition', { action });
      assert.equal(refused.error, true);
      assert.match(refused.text, new RegExp(`no expedition ${id} here`));
    }
    assert.equal(f.stateOf(id).run.t, 'paused');

    // The same name from the same conversation while it runs: the running one, said so.
    const again = await rpc(f.spec(), 'expedition', {
      action: { do: 'launch', charter: charter('bounds') },
    });
    assert.equal(again.error, false, again.text);
    assert.equal(again.value.id, id);
    assert.match(again.value.alreadyRunning, /still paused; nothing new was launched/);
    // Once it finished, the same name is a new expedition (review 2026-11-01: it silently
    // returned the stopped one).
    const stopped = await rpc(f.spec(), 'expedition', {
      action: { do: 'steer', id, feedback: { t: 'stop' } },
    });
    assert.equal(stopped.error, false, stopped.text);
    assert.equal(f.stateOf(id).run.t, 'finished');
    const fresh = await rpcLaunch(f, 'bounds');
    assert.notEqual(fresh.id, id);
    assert.match(fresh.launched, /budget 20 attempts/);
  } finally {
    await f.close();
  }
});

test('a crew seat on a harness this host has not installed is a draft issue and refuses the launch', async () => {
  // 2026-11-02 visual pass: on a host without codex the default crew drafted with no issue and
  // launched; the manager planned a retry "on seat 1 (codex)" and a claude claim's independent
  // check could only run on codex. Re-breaks if seatIssues stops asking the host what is installed.
  const f = await fixture();
  try {
    const noCodex = f.hostWith(
      { t: 'enabled' },
      path.join(f.scratch, 'no-codex'),
      (p) => p !== 'codex'
    );
    try {
      const c = Charter.parse(charter('no-codex'));
      assert.deepEqual(
        (await noCodex.issues(f.workspaceId, c)).filter((i) => /not installed/.test(i)),
        [
          'work seat 1: codex is not installed on this host; name a crew without it',
          'check seat 0: codex is not installed on this host; name a crew without it',
        ]
      );
      await assert.rejects(
        noCodex.launch({
          key: 'no-codex:launch',
          charter: c,
          origin: { t: 'direct' },
          launcherId: f.lead.id,
          workspaceId: f.workspaceId,
        }),
        /work seat 1: codex is not installed/
      );
      const claudeOnly = Charter.parse({
        ...charter('claude-only'),
        crew: {
          manager: { provider: 'claude' },
          work: [{ provider: 'claude', model: 'claude-sonnet-5-5' }],
          check: [{ provider: 'claude', model: 'claude-haiku-5-5' }],
        },
      });
      assert.deepEqual(await noCodex.issues(f.workspaceId, claudeOnly), []);
    } finally {
      noCodex.close();
    }
  } finally {
    await f.close();
  }
});

test('a host whose execution gate is disabled (a copied store) refuses launch and steer and never ticks a copied ledger', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'copied');
    // A copied store: the ledger as it stood at launch, before the crew existed (create_crew pending).
    const copy = path.join(f.scratch, 'copied');
    fs.mkdirSync(path.join(copy, id), { recursive: true });
    const first = fs.readFileSync(f.ledgerPath(id), 'utf8').split('\n')[0];
    fs.writeFileSync(path.join(copy, id, 'ledger.jsonl'), `${first}\n`);
    const branches = () => git(f.repo, 'branch', '--list', 'expedition/*');
    const before = branches();
    const disabled = f.hostWith({ t: 'disabled', reason: 'a copied store' }, copy);
    try {
      const reason = /expeditions do not run on this server: a copied store/;
      await assert.rejects(
        disabled.launch({
          key: 'copy:launch',
          charter: Charter.parse(charter('copy-launch')),
          origin: { t: 'direct' },
          launcherId: f.lead.id,
          workspaceId: f.workspaceId,
        }),
        reason
      );
      assert.match(
        (await disabled.issues(f.workspaceId, Charter.parse(charter('d')))).join(),
        reason
      );
      await assert.rejects(disabled.steer(id, f.lead.id, { t: 'resume' }), reason);
      // A draft would write its file and post a card with a Launch that can never work.
      const c = Charter.parse(charter('copy-draft'));
      await assert.rejects(
        disabled.drafts.draft({
          key: 'copy:draft',
          charter: c,
          issues: [],
          advice: [],
          defaulted: [],
          resolved: [],
          origin: { t: 'direct' },
          launcherId: f.lead.id,
          workspaceId: f.workspaceId,
        }),
        reason
      );
      await disabled.drain();
      assert.deepEqual(fs.readdirSync(copy), [id], 'nothing was written');
      assert.equal(fs.readFileSync(path.join(copy, id, 'ledger.jsonl'), 'utf8'), `${first}\n`);
      assert.equal(branches(), before, 'no expedition branch or worktree was made');
    } finally {
      disabled.close();
    }
  } finally {
    await f.close();
  }
});

// ---------- R11: robustness and per-question acceptance (2026-11-01) ----------

/** A live ledger from 2026-11-01, scrubbed (fixtures/expeditions-live/README.md): cut just
 * before its deadline `finished`, i.e. in the state it was stuck in. */
const liveFixture = (id: string) =>
  path.join(__dirname, 'fixtures', 'expeditions-live', `${id}.ledger.jsonl`);

/**
 * Replays a live ledger into the test fixture: a crew Buddy and its chat, the integration tree the
 * ledger says is ready, the placeholders filled, and a host restarted at `at` (inside the run's
 * deadline). The crew Buddy has to exist: decide plans nothing for an expedition without one.
 */
async function replayLive(f: Awaited<ReturnType<typeof fixture>>, id: string, at: string) {
  const crew = await f.core.createBuddy(OWNER, {
    workspaceId: f.workspaceId,
    slug: `exp-${id}`.slice(0, 40),
    name: 'Live crew',
    role: 'crew',
    manager: { kind: 'buddy', id: f.lead.id },
    key: `live-crew-${id}`,
  });
  const chat = await f.core.openChannel(OWNER, {
    kind: 'direct',
    members: [OWNER, buddyActor(crew.id)],
  });
  const base = git(f.repo, 'rev-parse', 'HEAD');
  const dir = path.join(f.root, id);
  git(
    f.repo,
    'cambium',
    'add',
    '-b',
    `expedition/${id}`,
    '-name',
    `exp-${id}-integration`,
    path.join(dir, 'integration'),
    base
  );
  const fill: Record<string, string> = {
    ID: id,
    ROOT: f.root,
    REPO: f.repo,
    BASE: base,
    CREW: crew.id,
    CHAT: chat.id,
    LAUNCHER: f.lead.id,
    WORKSPACE: f.workspaceId,
    KEY: `conversation:${id}`,
  };
  const ledger = fs
    .readFileSync(liveFixture(id), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
      if (!(k in fill)) throw new Error(`unfilled placeholder ${k}`);
      return fill[k];
    });
  fs.writeFileSync(f.ledgerPath(id), ledger);
  f.setClock(Date.parse(at));
  f.restart();
  /** The owner's message in the expedition chat, then one tick (the host reads it as feedback). */
  const say = async (body: string) => {
    await f.core.post(
      OWNER,
      { kind: 'id', id: chat.id },
      { kind: 'inform', body, evidence: [], mentions: [], broadcast: false, key: `owner-${body}` }
    );
    await f.host.tick(id);
  };
  return { crew, chat, base, dir, say };
}

const LIVE_ID = 'own-engine-geometry-opti-1b837b';

test('the live geometry ledger (2026-11-01) folds after the upgrade; "resume" re-plans; the unreported verifier commit is claimed and validated by its question acceptance, never by the goal verifier', async () => {
  // Incident own-engine-geometry-opti-1b837b: the host ran the charter's fail-closed done
  // command (verify.py) on every candidate, so no preparation commit could integrate (L1); the
  // worker that committed the verifier answered without a json block and its commit was dropped,
  // and the manager's bare-JSON answer was dropped too (L2); the run ended in "needs you" asking
  // for a host maintainer (L3). Re-breaks if: a legacy question folds with the done command as its
  // acceptance, candidate validation runs the done command, resume does not re-plan, or a
  // malformed attempt's commit cannot be claimed.
  const f = await fixture();
  try {
    // Just after w64130b's answer was recorded (03:42Z), inside the 4 h deadline (07:22Z).
    const { base, dir, say } = await replayLive(f, LIVE_ID, '2026-11-01T03:45:00Z');
    // w64130b's kept tree with its commit (live: 48ce327, "fail-closed verifier", answered with
    // no json block).
    const verifierTree = path.join(dir, 'worktrees', 'w64130b');
    git(
      f.repo,
      'cambium',
      'add',
      '-b',
      `exp/${LIVE_ID}/w64130b`,
      '-name',
      `exp-${LIVE_ID}-w64130b`,
      '-ephemeral',
      verifierTree,
      base
    );
    fs.mkdirSync(path.join(verifierTree, 'tools', 'geometry_expedition'), { recursive: true });
    fs.writeFileSync(
      path.join(verifierTree, 'tools', 'geometry_expedition', 'verify.py'),
      'import sys\nsys.exit(2)  # fail-closed until G1-G9 pass\n'
    );
    git(verifierTree, 'add', '.');
    git(verifierTree, 'commit', '-q', '-m', 'fail-closed verifier');
    const verifierSha = git(verifierTree, 'rev-parse', 'HEAD');
    // w475a3b answered a `finding` but its kept branch holds ACCEPTANCE_ROUTE.md (live ledger:
    // released `kept, commits:1`): the second commit the incident left nothing able to integrate.
    const routeTree = path.join(dir, 'worktrees', 'w475a3b');
    git(
      f.repo,
      'cambium',
      'add',
      '-b',
      `exp/${LIVE_ID}/w475a3b`,
      '-name',
      `exp-${LIVE_ID}-w475a3b`,
      '-ephemeral',
      routeTree,
      base
    );
    const routeDir = path.join(routeTree, 'agent_notes', '2026-10-30_own_geometry');
    fs.mkdirSync(routeDir, { recursive: true });
    fs.writeFileSync(path.join(routeDir, 'ACCEPTANCE_ROUTE.md'), '# Acceptance route\n');
    git(routeTree, 'add', '.');
    git(routeTree, 'commit', '-q', '-m', 'acceptance route');
    const routeSha = git(routeTree, 'rev-parse', 'HEAD');
    // It folds: legacy questions carry an explicit panel acceptance marked legacy.
    assert.deepEqual(f.host.lookup(LIVE_ID), { t: 'present' });
    let s = f.stateOf(LIVE_ID);
    assert.equal(s.run.t, 'waiting_owner');
    assert.deepEqual(
      s.questions.map(({ acceptance: { rule, provenance, rev } }) => ({ rule, provenance, rev })),
      [
        { rule: { t: 'panel' }, provenance: 'legacy', rev: 0 },
        { rule: { t: 'panel' }, provenance: 'legacy', rev: 0 },
      ]
    );
    // Booting after the upgrade does not resume it by itself (no manager), but gives the manager
    // its own tree.
    await f.host.tick(LIVE_ID);
    s = f.stateOf(LIVE_ID);
    assert.equal(s.run.t, 'waiting_owner');
    assert.equal(s.managerTree.t, 'ready');
    assert.equal(f.liveAttempts(LIVE_ID).length, 0, 'no auto-resume');

    // The owner answers in the chat: "resume" re-plans with the new acceptance model.
    await say('resume');
    assert.equal(f.stateOf(LIVE_ID).run.t, 'running');
    const m = f.manager(LIVE_ID);
    const brief = await f.core.getPost(OWNER, f.liveAttempts(LIVE_ID)[0].requestId);
    assert.match(brief.body, /ACCEPTANCE: every question names how its claims are accepted/);
    assert.match(brief.body, /q904453 .* accepted by an independent check panel \(legacy question/);
    assert.match(brief.body, /OWNER resume/);
    assert.match(brief.body, /w64130b .*MALFORMED ANSWER/);

    // The manager answers with a bare JSON object (no fence): parsed, not dropped (L2). It names a
    // command that can pass for this step as the question's acceptance, and claims the commit.
    const acceptance = {
      t: 'command',
      argv: [
        process.execPath,
        '-e',
        "require('fs').accessSync('tools/geometry_expedition/verify.py')",
      ],
      timeoutSeconds: 30,
    };
    await f.answer(
      LIVE_ID,
      m,
      `Plan below.\n${JSON.stringify({
        actions: [
          { do: 'set_acceptance', question: 'q904453', acceptance },
          {
            do: 'claim',
            attempt: 'w64130b',
            claim: {
              statement: 'The fail-closed verifier exists',
              sha: verifierSha,
              evidence: ['tools/geometry_expedition/verify.py'],
              howToCheck: 'the file exists at that commit',
            },
          },
          {
            do: 'claim',
            attempt: 'w475a3b',
            claim: {
              statement: 'The acceptance route is written down',
              sha: routeSha,
              evidence: ['agent_notes/2026-10-30_own_geometry/ACCEPTANCE_ROUTE.md'],
              howToCheck: 'read it',
            },
          },
        ],
      })}`
    );
    await f.host.drain();
    s = f.stateOf(LIVE_ID);
    assert.deepEqual(s.adoptions.w64130b, { t: 'adopted' });
    // The `finding` attempt's kept commit is claimable too (2026-11-01 review).
    assert.deepEqual(s.adoptions.w475a3b, { t: 'adopted' });
    const [v] = s.validations;
    assert.deepEqual(v.target, { t: 'candidate', claimAttemptId: 'w64130b', sha: verifierSha });
    assert.deepEqual(v.checks, [{ index: 0, argv: acceptance.argv, timeoutSeconds: 30 }]);
    assert.deepEqual(outcomes(v), [{ checkIndex: 0, outcome: { t: 'passed' } }]);
    assert.ok(
      !JSON.stringify(s.validations).includes('verify.py"]'),
      'the goal verifier never ran on a candidate'
    );

    // The preparation commit now integrates; the deadlock is gone.
    await f.answer(
      LIVE_ID,
      f.manager(LIVE_ID),
      json({ actions: [{ do: 'integrate', claimAttempt: 'w64130b' }] })
    );
    s = f.stateOf(LIVE_ID);
    assert.equal(s.integrations[0]?.status.t, 'integrated');
    assert.equal(s.questions.find((q) => q.id === 'q904453')?.status, 'verified');
    assert.equal(
      git(f.repo, 'rev-parse', `expedition/${LIVE_ID}^2`),
      verifierSha,
      'the verifier commit is on the expedition branch'
    );
  } finally {
    await f.close();
  }
});

// The four expeditions stuck in "needs you" on 2026-11-01 (each later finished at its deadline;
// the fixtures are cut before that, in the stuck state). Re-breaks if a live ledger stops folding,
// a boot resumes one by itself, or a resume cannot get past the stuck point.
const LIVE = {
  actualGame: 'actual-game-daily-local--e3153c',
  beach: 'emergent-beach-design-r1-bfeaca',
  dual: 'one-qualified-dualsphysi-404846',
  geometry: LIVE_ID,
};

test('each live 2026-11-01 ledger folds and boots without resuming; dualsphysics keeps its real owner question', async () => {
  for (const id of Object.values(LIVE)) {
    const f = await fixture();
    try {
      const asked = fold(
        fs
          .readFileSync(liveFixture(id), 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((line) => JSON.parse(line) as Entry[])
      ).run;
      assert.equal(asked.t, 'waiting_owner', id);
      await replayLive(f, id, '2026-11-01T05:00:00Z');
      assert.deepEqual(f.host.lookup(id), { t: 'present' }, id);
      await f.host.tick(id);
      const s = f.stateOf(id);
      assert.deepEqual(s.run, asked, `${id}: booting the upgrade changed what it asks`);
      assert.equal(f.liveAttempts(id).length, 0, `${id}: nothing starts before the owner answers`);
      assert.ok(
        s.questions.every(
          (q) => q.acceptance.provenance === 'legacy' && q.acceptance.rule.t === 'panel'
        ),
        `${id}: a legacy question folds with a panel, never the goal's done command`
      );
    } finally {
      await f.close();
    }
  }
  // The manager's own question about missing native evidence, not a host-made "nothing is running".
  const dual = fold(
    fs
      .readFileSync(liveFixture(LIVE.dual), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => JSON.parse(line) as Entry[])
  ).run;
  assert.ok(
    dual.t === 'waiting_owner' && /blocked on original evidence delivery/.test(dual.question)
  );
});

test('live actual-game: after "resume" its three malformed reviewer verdicts get the repair turn they never had, read under the strict schema, and verify the claim', async () => {
  // Incident: c71c918, c2babbc and cee2896 each reproduced w7d647b and answered "VERIFIED." in
  // prose with no json block (pre-R11: no repair turn), so all three panels read not_verified
  // and the manager asked the owner for a "host repair". Re-breaks if a legacy malformed check
  // is never repaired, is repaired without the owner's resume, or a repair costs budget.
  const f = await fixture();
  try {
    const id = LIVE.actualGame;
    const { crew, say } = await replayLive(f, id, '2026-11-01T05:00:00Z');
    const checks = ['c71c918', 'c2babbc', 'cee2896'];
    const before = f.stateOf(id);
    assert.deepEqual(
      panels(before).map((p) => p.verdict),
      ['not_verified', 'not_verified', 'not_verified']
    );
    await say('resume');
    let s = f.stateOf(id);
    assert.equal(s.run.t, 'running');
    for (const c of checks) {
      const a = s.attempts.find((x) => x.id === c)!;
      assert.equal(a.phase.t, 'posted', `${c} was not reopened for its repair`);
      assert.match(s.repairs[c], /REPAIR/);
      assert.match(s.repairs[c], /VERIFIED/i, 'the repair quotes the answer it could not read');
      assert.match(s.repairs[c], /"verdict"/, 'and names the check schema');
    }
    assert.equal(workerAttempts(s), workerAttempts(before), 'a repair is not a new attempt');
    assert.deepEqual(
      panels(s).map((p) => p.verdict),
      ['pending', 'pending', 'pending']
    );
    // Its tree was released at the time: the repair runs in the crew's directory, not a gone path.
    const request = f.liveAttempts(id).find((a) => a.id === checks[0])!.requestId;
    const run = (await f.core.listRuns({ kind: 'buddy', buddyId: crew.id }, 100)).find(
      (r) => r.input.kind === 'post' && r.input.postId === request
    );
    if (!run) throw new Error('no run for the repair request');
    const dir = await f.host.turnDirectory({
      buddyId: crew.id,
      workspaceId: f.workspaceId,
      coordinationRunId: run.id,
    });
    assert.deepEqual(dir, { t: 'crew', path: path.join(f.root, id, 'crew') });

    for (const c of checks)
      await f.answer(
        id,
        c,
        json({ verdict: 'verified', why: 'Reproduced: 6 docs files, sums pass.' })
      );
    s = f.stateOf(id);
    assert.deepEqual(
      panels(s).map((p) => p.verdict),
      ['verified', 'verified', 'verified']
    );
    assert.ok(
      s.attempts.every((a) => a.phase.t !== 'posted' || a.spec.kind === 'manager'),
      'every repaired check ended'
    );
  } finally {
    await f.close();
  }
});

test('live emergent-beach: "resume" re-plans a manager instead of asking the owner again', async () => {
  // Incident: four manager answers in a row failed to parse (a brief over 4000 characters, then
  // fences quoted inside briefs) and the run ended in the host's "Nothing is running" question.
  const f = await fixture();
  try {
    const id = LIVE.beach;
    const { say } = await replayLive(f, id, '2026-11-01T05:00:00Z');
    const asked = f.ledgerOf(id).filter((e) => e.t === 'needs_owner').length;
    await say('resume');
    assert.equal(f.stateOf(id).run.t, 'running');
    f.manager(id);
    assert.equal(
      f.ledgerOf(id).filter((e) => e.t === 'needs_owner').length,
      asked,
      'asked the owner again'
    );
  } finally {
    await f.close();
  }
});

test('a host-side parse failure never by itself asks the owner: one repair, then a typed failure the next manager is shown', async () => {
  // Re-breaks if a malformed answer (manager or worker, after its one repair) leaves the run
  // quiescent and the host asks the owner, as emergent-beach-design-r1 and actual-game did.
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'parse-failures', 2);
    const m1 = f.manager(id);
    await f.answer(id, m1, 'I would like to add a question but here is no json.');
    assert.equal(
      f.manager(id),
      m1,
      'the malformed manager answer got its repair on the same attempt'
    );
    await f.answer(id, m1, 'Still no json.');
    const m2 = f.manager(id);
    assert.notEqual(m2, m1, 'the next manager retries');
    const m2Brief = await f.core.getPost(
      OWNER,
      f.liveAttempts(id).find((a) => a.id === m2)!.requestId
    );
    assert.match(m2Brief.body, new RegExp(`${m1}`), 'and is shown the failed decision');

    await f.answer(id, m2, json({ actions: [question('Widget', ['widget'])] }));
    const q = f.stateOf(id).questions[0].id;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'look around' }] })
    );
    const w = f.liveAttempts(id).find((a) => a.kind === 'work')!.id;
    await f.answer(id, w, 'Looked around, nothing to report, no json.');
    await f.answer(id, w, 'Still no json.');
    const ended = f.stateOf(id).attempts.find((a) => a.id === w)!;
    assert.ok(ended.phase.t === 'ended' && ended.phase.outcome.t === 'malformed');
    f.manager(id);
    const s = f.stateOf(id);
    assert.equal(s.run.t, 'running');
    assert.ok(!f.ledgerOf(id).some((e) => e.t === 'needs_owner'), 'the host asked the owner');
  } finally {
    await f.close();
  }
});

test('a work answer still unreadable after its one repair, whose branch holds commits, is "unreported commits" with the shas; the claimed commit is validated by its question command', async () => {
  const f = await fixture();
  try {
    // The charter's done command always fails: were it run on candidates (pre-R11) nothing passes.
    const neverPasses = { kind: 'command', argv: ['sh', '-c', 'exit 7'], timeoutSeconds: 30 };
    const { id } = await rpcLaunch(f, 'unreported', 2, { checks: [neverPasses] });
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [question('Fix it', ['widget'], accept(widgetFixed))] })
    );
    const q = f.stateOf(id).questions[0].id;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'fix it' }] })
    );
    const w = f.liveAttempts(id).find((a) => a.kind === 'work')!.id;
    const sha = f.commitIn(f.treeOf(id, w).path, 'widget/widget.ts');
    await f.answer(id, w, `I fixed it in ${sha}.`);
    const repair = f.liveAttempts(id).find((a) => a.id === w)!;
    const repairPost = await f.core.getPost(OWNER, repair.requestId);
    assert.match(repairPost.body, /"result":"claim"/, 'the repair names the answer schema');
    assert.match(repairPost.body, new RegExp(`I fixed it in ${sha}`), 'it quotes the answer');
    await f.answer(id, w, 'Really, it is fixed.');
    const ended = f.stateOf(id).attempts.find((a) => a.id === w)!;
    if (ended.phase.t !== 'ended') throw new Error('not ended');
    assert.deepEqual(ended.phase.outcome.t === 'unreported_commits' && ended.phase.outcome.shas, [
      sha,
    ]);
    // Both requests are the attempt's, and metering counts both.
    assert.equal(f.stateOf(id).requests[w].length, 2);

    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          {
            do: 'claim',
            attempt: w,
            claim: { statement: 'fixed', sha, evidence: [], howToCheck: 'run it' },
          },
        ],
      })
    );
    await f.host.drain();
    const s = f.stateOf(id);
    const v = s.validations.find((x) => x.target.t === 'candidate')!;
    assert.deepEqual(outcomes(v), [{ checkIndex: 0, outcome: { t: 'passed' } }]);
    assert.deepEqual(v.checks[0].argv, widgetFixed.argv, 'its question command, not exit 7');
    // The owner's chat names the claim by title and its sha as code, never the attempt or
    // validation ids (2026-11-01 visual pass: "validation v37789f of candidate … of wef7487").
    await f.host.tick(id);
    const chat = f
      .stateOf(id)
      .statuses.map((x) => x.text)
      .join('\n');
    assert.match(chat, new RegExp(`Check passed on \`${sha.slice(0, 7)}\` from Work on “Fix it”`));
    assert.doesNotMatch(chat, new RegExp(`\\b(${v.id}|${w})\\b`), chat);
  } finally {
    await f.close();
  }
});

test('a changed acceptance re-validates an unmerged claim and only the current one decides; an answer arriving after stop is never repaired', async () => {
  // 2026-11-01 review (the geometry deadlock at the level of one claim): a claim got exactly one
  // candidate validation, kept whatever its acceptance became, so a claim first validated by a
  // command that could not pass could never integrate. Re-breaks if set_acceptance does not plan
  // a new validation, or integration still reads the old one. Second half: a malformed answer
  // after the owner's stop got its repair request, a new paid run the one-shot cancel never
  // stopped.
  const f = await fixture();
  try {
    const exit7 = { argv: ['sh', '-c', 'exit 7'], timeoutSeconds: 30 };
    const { id } = await rpcLaunch(f, 'reaccept', 2);
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [question('Fix it', ['widget'], accept(exit7)), question('Docs', ['docs'])] })
    );
    const [q, q2] = f.stateOf(id).questions.map((x) => x.id);
    // A decision made only of set_acceptance (no claim to re-validate) still leads to another
    // manager turn: acceptance_set is news, never a quiescent "needs you" (the L3 loop).
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'set_acceptance', question: q2, acceptance: { t: 'panel' } }] })
    );
    assert.equal(f.stateOf(id).run.t, 'running');
    assert.equal(f.stateOf(id).questions[1].acceptance.rev, 1);
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'fix it' }] })
    );
    const w = f.liveAttempts(id).find((a) => a.kind === 'work')!.id;
    const sha = f.commitIn(f.treeOf(id, w).path, 'widget/widget.ts');
    const claim = { statement: 'fixed', evidence: [], howToCheck: 'run it' };
    await f.answer(id, w, json({ result: 'claim', ...claim, change: { t: 'commit', sha } }));
    await f.host.drain();
    assert.deepEqual(
      f.stateOf(id).validations.map((v) => v.runs.map((r) => r.outcome.t).join()),
      ['failed'],
      'the first acceptance cannot pass'
    );

    // A set_acceptance-only decision is followed by another manager turn, never "needs you".
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'set_acceptance', question: q, acceptance: accept(widgetFixed) }] })
    );
    await f.host.drain();
    let s = f.stateOf(id);
    assert.equal(s.run.t, 'running');
    assert.deepEqual(
      s.validations.map((v) => v.runs.map((r) => r.outcome.t).join()),
      ['failed', 'passed'],
      'the changed acceptance plans a new validation of the same candidate'
    );
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'integrate', claimAttempt: w }] }));
    s = f.stateOf(id);
    assert.equal(s.integrations[0]?.status.t, 'integrated');

    // Stop while a worker is finishing; its answer then arrives without a json block.
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q2, seat: 1, brief: 'docs' }] })
    );
    const w2 = f.liveAttempts(id).find((a) => a.kind === 'work')!.id;
    await f.host.steer(id, f.lead.id, { t: 'stop' });
    await f.answer(id, w2, 'Done, no json.');
    s = f.stateOf(id);
    const ended = s.attempts.find((a) => a.id === w2)!;
    assert.equal(ended.phase.t === 'ended' && ended.phase.outcome.t, 'malformed');
    assert.equal(s.requests[w2].length, 1, 'no repair request after finish');
  } finally {
    await f.close();
  }
});

test('observation that keeps failing never wedges the run: the owner stop still finishes it, failures are recorded once per backoff step, and the deadline (moved by extend) still lands', async () => {
  // Audit 2026-11-01 #1: observe ran before decide and a persistent error threw, so a stop or the
  // deadline never landed and the tick retried hot with only a console warning.
  const f = await fixture();
  const getPost = f.core.getPost.bind(f.core);
  const breakReads = () => {
    f.core.getPost = async () => {
      throw new Error('crate unavailable');
    };
  };
  try {
    const { id } = await rpcLaunch(f, 'wedge');
    assert.equal(f.liveAttempts(id).length, 1, 'a manager is live, so observation reads it');
    breakReads();
    for (let n = 0; n < 4; n += 1) await f.host.tick(id);
    const failed = () => f.ledgerOf(id).filter((e) => e.t === 'tick_failed');
    assert.equal(failed().length, 1, 'recorded once, then backing off (the 4th tick waited)');
    assert.match(
      JSON.stringify(failed()[0]),
      /"failures":3,"reason":"attempt m\w+: crate unavailable"/
    );
    // An owner post in the expedition chat (the L3 resume path) is read at once, never after the
    // backoff (2026-11-01 review: only the steer tool cleared it, up to 30 minutes).
    f.core.getPost = getPost;
    const crew = f.stateOf(id).crew;
    if (crew.t !== 'ready') throw new Error('crew not ready');
    const feedbacks = () => f.ledgerOf(id).filter((e) => e.t === 'feedback').length;
    const before = feedbacks();
    // Announced as the chat route does (routes.ts emits `posted`), which is what wakes the host.
    const ownerPost = await f.core.post(
      OWNER,
      { kind: 'id', id: crew.chatChannelId },
      {
        kind: 'inform',
        body: 'carry on',
        evidence: [],
        mentions: [],
        broadcast: false,
        key: 'owner-note-wedge',
      }
    );
    await announcePost(f, OWNER, ownerPost.post);
    await f.host.tick(id);
    assert.equal(feedbacks(), before + 1, 'the owner post is observed despite the backoff');
    breakReads();
    await f.host.steer(id, f.lead.id, { t: 'stop' });
    assert.equal(f.stateOf(id).run.t, 'finished');
    f.core.getPost = getPost;

    const launchedAt = Date.parse('2026-11-01T06:00:00Z');
    f.setClock(launchedAt);
    const late = await rpcLaunch(f, 'late');
    await f.host.steer(late.id, f.lead.id, { t: 'extend', hours: 2 });
    f.setClock(launchedAt + 5 * 3_600_000);
    await f.host.tick(late.id);
    assert.equal(f.stateOf(late.id).run.t, 'running', 'the 4h deadline moved to 6h');
    breakReads();
    f.setClock(launchedAt + 6.5 * 3_600_000);
    await f.host.tick(late.id);
    const run = f.stateOf(late.id).run;
    assert.equal(run.t === 'finished' && run.reason, 'deadline');
  } finally {
    f.core.getPost = getPost;
    await f.close();
  }
});

test('a ledger append that fails partway leaves the file as it was, so the next append and a reboot still read it', async () => {
  // Audit 2026-11-01 #4: a bare appendFile that failed mid-line (ENOSPC) left half a line, the
  // next append was glued onto it, and boot quarantined the whole expedition.
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'append');
    await f.answer(id, f.manager(id), json({ actions: [] }));
    const file = f.ledgerPath(id);
    const before = fs.readFileSync(file, 'utf8');
    const realOpen = fsp.open;
    mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'write')
            return async (data: string) => {
              await target.write(data.slice(0, 12));
              throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    try {
      await assert.rejects(f.host.steer(id, f.lead.id, { t: 'note', text: 'lost' }), /ENOSPC/);
    } finally {
      mock.restoreAll();
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'cut back to the size before the write');
    await f.host.steer(id, f.lead.id, { t: 'note', text: 'kept' });
    f.restart();
    assert.deepEqual(f.host.lookup(id), { t: 'present' });
    const notes = f
      .ledgerOf(id)
      .flatMap((e) => (e.t === 'feedback' && e.feedback.t === 'note' ? [e.feedback.text] : []));
    assert.deepEqual(notes, ['kept']);
  } finally {
    await f.close();
  }
});

test(
  'a check job that cannot run at all records one terminal validation_failed (never a hot retry), and a NUL argv is refused at charter ingestion',
  { timeout: 120_000 },
  async () => {
    // Audit 2026-11-01 #5: a rejected check job was only logged and re-run on every tick; a NUL
    // byte in argv (which passed the charter schema) makes spawn throw every time.
    const nul = { kind: 'command', argv: [process.execPath, '-e', 'a\0b'], timeoutSeconds: 30 };
    const parsed = Charter.safeParse(charter('nul', 2, { checks: [nul] }));
    assert.equal(parsed.success, false);
    assert.match(JSON.stringify(parsed.error?.issues), /NUL byte/);
    const f = await fixture();
    try {
      // A ledger written before the schema refused it (host.launch takes a charter as stored).
      const { state } = await f.host.launch({
        key: 'nul-key',
        charter: charter('nul', 2, { checks: [nul] }) as Charter,
        origin: { t: 'direct' },
        launcherId: f.lead.id,
        workspaceId: f.workspaceId,
      });
      const id = state.id;
      await f.answer(id, f.manager(id), json({ actions: [{ do: 'done', summary: 'try' }] }));
      await f.host.drain();
      for (let n = 0; n < 3; n += 1) await f.host.tick(id);
      await f.host.drain();
      const failures = f.ledgerOf(id).filter((e) => e.t === 'validation_failed');
      assert.equal(failures.length, 1);
      assert.ok(
        f.ledgerOf(id).some((e) => e.t === 'done_refused' && /could not run/.test(e.reason))
      );
    } finally {
      await f.close();
    }
  }
);

test('the integration head is verified before each merge: a branch moved outside the host is refused, not merged onto; the host state equals a replay of its ledger', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'moved');
    const passes = { argv: [process.execPath, '-e', '0'], timeoutSeconds: 30 };
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [question('Fix it', ['widget'], accept(passes))] })
    );
    const q = f.stateOf(id).questions[0].id;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'fix it' }] })
    );
    const w = f.liveAttempts(id).find((a) => a.kind === 'work')!.id;
    const sha = f.commitIn(f.treeOf(id, w).path, 'widget/widget.ts');
    await f.answer(
      id,
      w,
      json({
        result: 'claim',
        statement: 'fixed',
        change: { t: 'commit', sha },
        evidence: [],
        howToCheck: 'run',
      })
    );
    await f.host.drain();
    // Someone commits onto the expedition branch outside the host (audit 2026-11-01 #6).
    const integration = f.stateOf(id).integrationTree.path;
    git(integration, 'commit', '-q', '--allow-empty', '-m', 'outside the host');
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'integrate', claimAttempt: w }] }));
    const [i] = f.stateOf(id).integrations;
    assert.equal(i.status.t, 'refused');
    assert.match(JSON.stringify(i.status), /"phase":"tree".*moved outside the host/);
    assert.equal(
      git(integration, 'log', '-1', '--format=%s'),
      'outside the host',
      'nothing merged'
    );

    // Incremental fold (audit #8): the host's cached state equals a fresh replay of its file.
    const strip = (v: ReturnType<ExpeditionHost['view']>) => ({ ...v, badge: '', now: '' });
    const replayed = expeditionView(f.stateOf(id), '', '');
    assert.deepEqual(strip(f.host.view(id)), strip(replayed));
  } finally {
    await f.close();
  }
});

test('expedition creation is exclusive: a second create of the same id refuses and leaves the first ledger untouched', async () => {
  // Audit 2026-11-01: creation used mkdir -p and appendFile, so a colliding id appended a second
  // launch to another expedition's ledger.
  const dir = path.join(tempDir('exp-create-'), 'same-id');
  const file = path.join(dir, 'ledger.jsonl');
  const first = [{ t: 'badge_posted', at: 'a', postId: 'p1' }] as Entry[];
  await createLedger(dir, file, first);
  await assert.rejects(
    createLedger(dir, file, [{ t: 'badge_posted', at: 'b', postId: 'p2' }] as Entry[]),
    /EEXIST/
  );
  assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(first)}\n`);
});

test('a check verdict counts only when explicit: one verdict that ends the answer (oompa "NOT APPROVED" incident)', () => {
  // Oompa's queue reviewer approved on any `\bAPPROVED\b`, so "NOT APPROVED" passed (audit
  // 2026-11-01). Its strict parse (explicit-approval?) also refused a quoted example verdict
  // followed by the real one, and prose after the verdict; a panel vote here does the same.
  const fence = (v: unknown) => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
  const verified = { verdict: 'verified', why: 'the test passes' };
  const refuted = { verdict: 'refuted', why: 'the test fails' };
  const notCounted = [
    'NOT APPROVED',
    'The candidate appears verified, but I have no final verdict.',
    fence({ verdict: 'not verified', why: 'x' }),
    `Here is a quoted example:\n${fence(verified)}\nMy verdict:\n${fence(refuted)}`,
    `${fence(verified)}\nActually NOT verified: the test fails on a clean checkout.`,
  ];
  for (const body of notCounted)
    assert.equal(parseOutcome('check', body).t, 'malformed', `counted as a verdict: ${body}`);
  for (const body of [`Checked.\n${fence(verified)}\n`, `Checked.\n${JSON.stringify(verified)}`])
    assert.deepEqual(parseOutcome('check', body), { t: 'check', result: verified });
  // The bare-JSON path (L2) holds the same rule: two bare verdicts are ambiguous.
  assert.equal(
    parseOutcome('check', `${JSON.stringify(verified)} actually\n${JSON.stringify(refuted)}`).t,
    'malformed'
  );
  // 2026-11-01 review: an answer quoting a fenced snippet and ending with its own bare result
  // parsed the snippet (malformed, a repair turn lost). The final bare object wins.
  const finding = { result: 'finding', statement: 'done', evidence: [] };
  assert.deepEqual(
    parseOutcome('work', `I edited:\n${fence({ port: 1 })}\nResult:\n${JSON.stringify(finding)}`),
    { t: 'work', result: finding }
  );
});

test('host git never runs repository hooks; a check that rewrites its own validator never passes, and every check records its pinned validator bytes', async () => {
  // Audit 2026-11-01 #7: host git (worktree adds, validation trees, integration merges) inherited
  // the full server environment and ran repository hooks, so a hook saw every provider key.
  // Oompa port: validator source pins, verified after the run (`expedition.validation/v1`).
  const f = await fixture();
  const marker = path.join(f.scratch, 'hook-ran');
  process.env.EXPEDITION_HOOK_SECRET = 'sk-hook-secret';
  try {
    // The trusted validator rewrites itself when a candidate ships widget/rewrite (a stand-in for
    // a test runner that patches its own test while it runs).
    const honest =
      "[ -f widget/rewrite ] && printf 'exit 0\\n' > widget/check.sh\ngrep -q 'broken = false' widget/widget.ts\n";
    fs.writeFileSync(path.join(f.repo, 'widget', 'check.sh'), honest);
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-q', '-m', 'validator');
    for (const hook of ['post-checkout', 'post-merge', 'pre-merge-commit']) {
      const file = path.join(f.repo, '.git', 'hooks', hook);
      fs.writeFileSync(file, `#!/bin/sh\necho "${hook} $EXPEDITION_HOOK_SECRET" >> '${marker}'\n`);
      fs.chmodSync(file, 0o755);
    }
    const { id } = await rpcLaunch(f, 'pins');
    const check = { argv: ['sh', 'widget/check.sh'], timeoutSeconds: 30 };
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [question('Fix it', ['widget'], accept(check))] })
    );
    const q = f.stateOf(id).questions[0].id;
    const work = async (validator: string, rewrite = false) => {
      await f.answer(
        id,
        f.manager(id),
        json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'fix it' }] })
      );
      const w = f.liveAttempts(id).find((a) => a.kind === 'work')!.id;
      const tree = f.treeOf(id, w).path;
      fs.writeFileSync(path.join(tree, 'widget', 'check.sh'), validator);
      if (rewrite) fs.writeFileSync(path.join(tree, 'widget', 'rewrite'), '');
      const sha = f.commitIn(tree, 'widget/widget.ts');
      const claim = { statement: 'fixed', evidence: [], howToCheck: 'run it' };
      await f.answer(id, w, json({ result: 'claim', ...claim, change: { t: 'commit', sha } }));
      await f.host.drain();
      const v = f
        .stateOf(id)
        .validations.find((x) => x.target.t === 'candidate' && x.target.sha === sha)!;
      return { w, run: v.runs[0] };
    };
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

    // 2026-11-01 review: pins taken at the candidate sha only recorded a committed cheat's own
    // hash. A candidate that commits `exit 0` to the validator its acceptance names is refused
    // before it runs: the validator is trusted as it was when the acceptance was declared.
    const committed = await work('exit 0\n');
    assert.equal(committed.run.outcome.t, 'error');
    assert.match(
      JSON.stringify(committed.run.outcome),
      /the candidate changed the validator widget\/check\.sh/
    );
    assert.deepEqual(committed.run.report.pins, []);

    // The trusted validator rewrites itself to `exit 0` while it runs: never a pass.
    const cheated = await work(honest, true);
    assert.equal(cheated.run.outcome.t, 'error');
    assert.match(
      JSON.stringify(cheated.run.outcome),
      /changed its own validator source.*widget\/check\.sh/
    );
    assert.deepEqual(cheated.run.report.pins, [
      { path: 'widget/check.sh', sha256: sha256(honest) },
    ]);
    assert.deepEqual(cheated.run.report.pinCheck, { t: 'changed', paths: ['widget/check.sh'] });

    // An honest candidate passes with its pins held, and is merged.
    const fixed = await work(honest);
    assert.deepEqual(fixed.run.outcome, { t: 'passed' });
    assert.equal(fixed.run.report.t, 'expedition.validation/v1');
    assert.deepEqual(fixed.run.report.pins, [{ path: 'widget/check.sh', sha256: sha256(honest) }]);
    assert.deepEqual(fixed.run.report.pinCheck, { t: 'held' });
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'integrate', claimAttempt: fixed.w }] })
    );
    assert.equal(f.stateOf(id).integrations[0]?.status.t, 'integrated');
    assert.equal(
      fs.existsSync(marker),
      false,
      `a repository hook ran for the host: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`
    );
  } finally {
    Reflect.deleteProperty(process.env, 'EXPEDITION_HOOK_SECRET');
    await f.close();
  }
});

test('stop cancels live attempts and releases every tree safely: a submodule tree is force-removed after its guards pass, unintegrated commits are salvaged, ignored output harvested, a dirty tree left', async () => {
  // Audit 2026-11-01 #2 (stop cancelled nothing), #9 (release never forced, so a tree with an
  // initialized submodule leaked), and the oompa ports: salvage refs (run 9f004a39 deleted ~2.5 h
  // of approved work) and harvesting ignored output (swarm 455987ea lost a paid run's gauges).
  const f = await fixture();
  try {
    const sub = path.join(f.scratch, 'sub');
    fs.mkdirSync(sub);
    git(sub, 'init', '-q');
    git(
      sub,
      '-c',
      'user.email=t@e',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      's'
    );
    fs.writeFileSync(path.join(f.repo, '.gitignore'), 'output/\n');
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, 'vendor/sub');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-q', '-m', 'submodule and ignored output');
    const { id } = await rpcLaunch(f, 'release', 3);
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [question('A', ['widget']), question('B', ['docs']), question('C', ['notes'])],
      })
    );
    const qs = f.stateOf(id).questions.map((q) => q.id);
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: qs.map((question, seat) => ({
          do: 'work',
          question,
          seat: seat % 2,
          brief: 'go',
        })),
      })
    );
    const [w1, w2, w3] = f
      .liveAttempts(id)
      .filter((a) => a.kind === 'work')
      .map((a) => a.id);
    const finding = json({ result: 'finding', statement: 'partial', evidence: [] });

    // w1 builds (submodule initialized), commits, writes ignored run output, reports a finding.
    const t1 = f.treeOf(id, w1).path;
    git(t1, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'update', '--init');
    const sha = f.commitIn(t1, 'widget/widget.ts');
    fs.mkdirSync(path.join(t1, 'output'));
    fs.writeFileSync(path.join(t1, 'output', 'run.log'), 'gauges\n');
    await f.answer(id, w1, finding);
    // A finding whose branch holds a commit is claimable data, never a dropped commit
    // (2026-11-01 review: live w475a3b answered `finding` with ACCEPTANCE_ROUTE.md committed).
    const w1End = f.stateOf(id).attempts.find((a) => a.id === w1)!.phase;
    assert.deepEqual(
      w1End.t === 'ended' && w1End.outcome.t === 'unreported_commits' && w1End.outcome.shas,
      [sha]
    );
    // w2 leaves an uncommitted edit; w3 never answers.
    const t2 = f.treeOf(id, w2).path;
    fs.writeFileSync(path.join(t2, 'docs', 'README.md'), 'half done\n');
    await f.answer(id, w2, finding);

    await f.host.steer(id, f.lead.id, { t: 'stop' });
    let s = f.stateOf(id);
    assert.equal(s.run.t, 'finished');
    const cancel = s.cancels[w3];
    assert.ok(cancel && cancel.runIds.length > 0, 'the live attempt was asked to stop');
    for (const runId of cancel.runIds)
      assert.equal((await f.core.getRun(runId)).status, 'cancelled');

    // w1: salvaged, harvested, then force-removed; its unmerged branch stays for the owner.
    assert.deepEqual(s.worktrees[w1].status, { t: 'removed', branchDeleted: false });
    assert.equal(fs.existsSync(t1), false);
    assert.equal(git(f.repo, 'rev-parse', `refs/salvage/expeditions/${id}/${w1}`), sha);
    const harvested = path.join(f.root, id, 'harvest', w1, 'output', 'run.log');
    assert.equal(fs.readFileSync(harvested, 'utf8'), 'gauges\n');
    assert.deepEqual(
      s.preserved.filter((p) => p.treeOf === w1).map((p) => p.preserved.t),
      ['salvaged', 'harvested']
    );
    // w2: never forced away with its uncommitted change.
    assert.equal(s.worktrees[w2].status.t, 'left');
    assert.match(JSON.stringify(s.worktrees[w2].status), /uncommitted changes/);
    assert.equal(fs.existsSync(t2), true);

    // w3's run ignored the stop (no runner here): after the grace the host abandons it and its
    // tree goes.
    f.setClock(Date.parse(cancel.at) + CANCEL_GRACE_MS + 60_000);
    await f.host.tick(id);
    s = f.stateOf(id);
    const ended = s.attempts.find((a) => a.id === w3)!;
    assert.equal(ended.phase.t === 'ended' && ended.phase.outcome.t, 'abandoned');
    assert.deepEqual(s.worktrees[w3].status, { t: 'removed', branchDeleted: true });
  } finally {
    await f.close();
  }
});
