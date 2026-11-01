import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import { BuddiesCore } from '@unleashd/buddies-core';
import { Ingest, defaultRoots } from '@unleashd/ingest';
import express from 'express';
import { createBriefings } from '../src/buddies/briefing';
import { OWNER, buddyActor } from '../src/buddies/core';
import { createBuddyEvents } from '../src/buddies/events';
import type { ExecutionGate } from '../src/buddies/execution-gate';
import { createGrants } from '../src/buddies/grants';
import { startMcpEndpoint } from '../src/buddies/mcp';
import { runCommand } from '../src/expeditions/command';
import { type ExpeditionHost, createExpeditionHost } from '../src/expeditions/host';
import { Charter, type Entry, type State, fold } from '../src/expeditions/model';
import { clip, clipBlock, goalSummary, launchNews } from '../src/expeditions/news';
import { registerExpeditionRoutes } from '../src/expeditions/routes';
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
  const host = (gate: ExecutionGate = { t: 'enabled' }, at = root): ExpeditionHost =>
    createExpeditionHost({
      core,
      events,
      root: at,
      gate,
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
      key: `answer:${attemptId}`,
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
          },
          {
            do: 'add_question',
            title: 'Are the docs stale?',
            detail: 'Read them.',
            scope: 'in',
            paths: ['docs'],
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
    await f.answer(id, work[1].id, 'I forgot the JSON block.');
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
    assert.deepEqual(s.run, {
      t: 'finished',
      reason: 'done',
      summary: 'Widget passes, independently verified.',
    });
    assert.equal(s.questions[0].status, 'verified');
    const last = s.statuses.find((x) => x.text.includes('Finished (done)'))!;
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
    assert.deepEqual(after.phase, { t: 'posted', requestId }, 'the replay returned the same post');
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

const question = (title: string, paths: string[]) => ({
  do: 'add_question',
  title,
  detail: title,
  scope: 'in',
  paths,
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
      /"t":"malformed","error":"claimed commit \w+ is not a new commit on the attempt branch/
    );
    // Saying "no code" after committing would skip candidate validation.
    const hidden = await claim(() => ({ t: 'no_code' }));
    assert.match(
      JSON.stringify(outcomeOf(hidden)),
      /"t":"malformed","error":"claimed no code, but the attempt branch \S+ has 1 commit/
    );
    // A commit outside its question's paths (docs/, while the question owns widget/) is not
    // held: custody is enforced on what is claimed, so it can never be validated or merged.
    const trespass = await claim((_base, sha) => ({ t: 'commit', sha }), 'docs/README.md');
    assert.match(
      JSON.stringify(outcomeOf(trespass)),
      /"t":"malformed","error":"claimed commit \w+ changes files outside its question's paths \(widget\): docs\/README.md/
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
    await f.answer(id, f.manager(id), json({ actions: [question('Fix it', ['widget'])] }));
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
    assert.deepEqual(s.run, { t: 'finished', reason: 'done', summary: 'fixed' });
    const [merged] = s.integrations;
    if (merged?.status.t !== 'integrated') throw new Error(`not integrated: ${merged?.status.t}`);
    const branch = `expedition/${id}`;
    assert.equal(git(f.repo, 'rev-parse', branch), merged.status.mergeSha);
    assert.equal(git(f.repo, 'rev-parse', `${branch}^2`), good);
    const last = s.validations.at(-1)!;
    assert.deepEqual(last.target, { t: 'head' });
    assert.deepEqual(last.runs, [{ checkIndex: 0, outcome: { t: 'passed' } }]);
    const { mergeSha } = merged.status;
    assert.equal(validations().at(-1)?.targetSha, mergeSha, 'done ran on the merge');
    // The owner is told the branch to merge; the owner's checkout never moved.
    assert.ok(
      s.statuses.some((x) =>
        x.text.includes(`merge branch ${branch} (head ${mergeSha.slice(0, 10)}`)
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
    await f.answer(id, f.manager(id), json({ actions: [question('Fix the widget', ['widget'])] }));
    const q1 = f.stateOf(id).questions[0].id;
    const after = (title: string, deps: string[]) => ({
      ...question(title, ['docs']),
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
    assert.ok(
      f
        .stateOf(id)
        .statuses.some((x) =>
          x.text.includes(`⏸ ${workOn(q2).id} waiting: needs ${q1} verified first`)
        ),
      'the chat says why the work waits'
    );

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
    await f.answer(id, f.manager(id), json({ actions: [question('Fix it', ['widget'])] }));
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
      json({ actions: [question('Fix the widget', ['widget']), question('Docs', ['docs'])] })
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
    assert.deepEqual(s.run, { t: 'finished', reason: 'done', summary: 'A and B in' });
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
    assert.deepEqual(v.runs, [{ checkIndex: 0, outcome: { t: 'passed' } }]);
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
  } finally {
    await f.close();
  }
});

test('a command check is killed at its timeout (its whole process group), and an exited check never waits on a background child', async () => {
  const cwd = tempDir('check-');
  const started = Date.now();
  const slow = await runCommand(
    { kind: 'command', argv: ['sh', '-c', 'echo begun; sleep 30 & sleep 30'], timeoutSeconds: 1 },
    cwd
  );
  assert.equal(slow.t, 'timed_out');
  assert.match(slow.t === 'timed_out' ? slow.tail : '', /begun/);
  // Exit 0 with a straggler holding stdout: passed at once, not after the straggler's 30 s.
  const quick = await runCommand(
    { kind: 'command', argv: ['sh', '-c', 'sleep 30 & exit 0'], timeoutSeconds: 20 },
    cwd
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
        kind: 'command',
        argv: ['sh', '-c', `${escaped(pids[0])} sleep 0.5; exit 0`],
        timeoutSeconds: 20,
      },
      cwd
    );
    assert.deepEqual(exited, { t: 'passed' });
    const stuck = await runCommand(
      { kind: 'command', argv: ['sh', '-c', `${escaped(pids[1])} sleep 30`], timeoutSeconds: 1 },
      cwd
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
        kind: 'command',
        argv: ['sh', '-c', 'test -z "$EXPEDITION_TEST_SECRET"'],
        timeoutSeconds: 5,
      },
      cwd
    );
    assert.deepEqual(env, { t: 'passed' }, 'the server environment leaked into a check');
  } finally {
    Reflect.deleteProperty(process.env, 'EXPEDITION_TEST_SECRET');
  }
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
  const missing = await runCommand(
    { kind: 'command', argv: ['no-such-binary-xyz'], timeoutSeconds: 5 },
    cwd
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
    // The test moves the clock to wall time below; launching at the fixture's fixed 2026-11-01
    // 00:00Z put the 4 h deadline behind wall time from 04:00Z that day, and the run finished.
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
    assert.ok(drafted.value.advice.some((a: string) => a.startsWith('no outOfScope fence')));
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

test('an attempt run starts in its own worktree (two concurrent runs of one crew do not collide), a manager in the integration tree, any other Buddy in its workspace; answering a hosted attempt wakes no extra crew run', async () => {
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
    assert.equal(
      briefings.current(context(managerRun.id)).workingDirectory,
      f.stateOf(id).integrationTree.path,
      'a manager starts in the integration tree, never the owner checkout'
    );

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
