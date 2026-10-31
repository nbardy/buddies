import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import { BuddiesCore } from '@unleashd/buddies-core';
import express from 'express';
import { OWNER, buddyActor } from '../src/buddies/core';
import { createBuddyEvents } from '../src/buddies/events';
import { createGrants } from '../src/buddies/grants';
import { startMcpEndpoint } from '../src/buddies/mcp';
import { runCommand } from '../src/expeditions/command';
import { type ExpeditionHost, createExpeditionHost } from '../src/expeditions/host';
import { Charter, type Entry, type State, fold, panels } from '../src/expeditions/model';
import { registerExpeditionRoutes } from '../src/expeditions/routes';
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
  const host = (): ExpeditionHost =>
    createExpeditionHost({
      core,
      events,
      root,
      gate: { t: 'enabled' },
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
  const grant = grants.issueBuddy({
    role: 'worker',
    buddyId: lead.id,
    workspaceId: ws.id,
    conversationId: 'lead-turn',
    runId: null,
    subscribes: 'self',
    hooks: { t: 'unrecorded' },
  });
  const ledgerOf = (id: string): Entry[] =>
    fs
      .readFileSync(path.join(root, id, 'ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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
  return {
    core,
    lead,
    repo,
    treeOf,
    commitIn,
    branchExists,
    ledgerPath: (id: string) => path.join(root, id, 'ledger.jsonl'),
    spec: () => endpoint.spec(grant),
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
    assert.match(m2Brief.body, /NEW SINCE YOUR LAST DECISION:\n- REJECTED done/);
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
      json({ actions: [{ do: 'done', summary: 'one check is enough' }] })
    );
    assert.equal(f.stateOf(id).run.t, 'running');
    // The second check refutes: 1 of 2 is no majority, so done stays refused after the panel ends.
    await f.answer(id, second.id, json({ verdict: 'refuted', why: 'fails on a clean checkout' }));
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'done', summary: 'split panel' },
          { do: 'check', claimAttempt: claimId, goal: true, panel: 1 },
        ],
      })
    );
    assert.equal(f.stateOf(id).run.t, 'running', 'a split panel does not verify');
    const third = f.liveAttempts(id).find((a) => a.kind === 'check')!;
    await f.answer(id, third.id, json({ verdict: 'verified', why: 'reproduced after rebuild' }));
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          { do: 'close_question', question: q, status: 'verified', why: 'check verified' },
          { do: 'done', summary: 'Widget passes, independently verified.' },
        ],
      })
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
    // Finished: every idle worktree is gone, and the claim's branch (unintegrated commits)
    // survives. The still-running work attempt keeps its tree: its worker may be in it.
    const running = work[0].id;
    for (const tree of Object.values(s.worktrees).filter((t) => t.attemptId !== running)) {
      assert.equal(tree.status.t, 'removed', `${tree.attemptId}: ${JSON.stringify(tree.status)}`);
      assert.equal(fs.existsSync(tree.path), false);
    }
    assert.equal(git(f.repo, 'rev-parse', claimTree.branch), sha);
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

test('an expedition never goes quiet: an empty plan with nothing running asks the owner, and a lesson resumes it', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'idle');
    await f.answer(id, f.manager(id), json({ actions: [] }));
    let s = f.stateOf(id);
    assert.equal(s.run.t, 'waiting_owner');
    assert.match(s.statuses.at(-1)!.text, /Needs you/);

    const steered = await rpc(f.spec(), 'expedition', {
      action: { do: 'steer', id, feedback: { t: 'lesson', text: 'Start with the logs.' } },
    });
    assert.equal(steered.error, false, steered.text);
    s = f.stateOf(id);
    assert.equal(s.run.t, 'running');
    const brief = await f.core.getPost(
      OWNER,
      f.liveAttempts(id).find((a) => a.kind === 'manager')!.requestId
    );
    assert.match(brief.body, /Start with the logs\./, 'lessons reach every later brief');
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
    // Questions alone leave nothing new for a manager; an owner note asks for the next decision.
    await f.host.steer(id, f.lead.id, { t: 'note', text: 'Start the work.' });
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

    // The expedition branch moves past its launch base (as integration will move it): a commit
    // on top of it, made without touching any checkout.
    const branch = `expedition/${id}`;
    const launchBase = git(f.repo, 'rev-parse', branch);
    const head = git(f.repo, 'commit-tree', `${branch}^{tree}`, '-p', branch, '-m', 'integrated');
    git(f.repo, 'update-ref', `refs/heads/${branch}`, head);

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
    await f.host.steer(id, f.lead.id, { t: 'note', text: 'Start the work.' });
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
    const workspaces = JSON.parse(git(f.repo, 'cambium', 'list', '--json')) as { name: string }[];
    assert.deepEqual(
      workspaces.map((w) => w.name),
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
 * which is exactly the window an interrupted add leaves behind.
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
      `prepare = ["sh", "-c", "while [ -e '${marker}' ]; do sleep 0.05; done; mkdir -p .slow"]`,
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
    await f.host.steer(id, f.lead.id, { t: 'note', text: 'Start the work.' });
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
    const add = spawn(
      'git-cambium',
      ['add', '-b', tree.branch, '-name', tree.name, '-ephemeral', tree.path, tree.baseSha],
      { cwd: f.repo, detached: true, stdio: 'ignore' }
    );
    await until('the interrupted add to make its branch', () => f.branchExists(tree.branch));
    process.kill(-add.pid!, 'SIGKILL');
    fs.rmSync(marker);
    const registered = () =>
      (JSON.parse(git(f.repo, 'cambium', 'list', '--json')) as { name: string }[]).map(
        (w) => w.name
      );
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

test('a check whose claimed commit does not exist is dropped as typed data; its panel settles', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'bogus');
    await f.answer(id, f.manager(id), json({ actions: [question('Fix it', ['widget'])] }));
    await f.host.steer(id, f.lead.id, { t: 'note', text: 'Start the work.' });
    const q = f.stateOf(id).questions[0].id;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'go' }] })
    );
    const work = f.liveAttempts(id).find((a) => a.kind === 'work')!;
    const bogus = 'f'.repeat(40);
    await f.answer(
      id,
      work.id,
      json({
        result: 'claim',
        statement: 'fixed',
        change: { t: 'commit', sha: bogus },
        evidence: [],
        howToCheck: 'look',
      })
    );
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'check', claimAttempt: work.id, goal: false, panel: 1 }] })
    );
    // No worktree can exist at a commit that does not: the check never starts, the failure is a
    // ledger entry (not a tick that throws on every retry), and the next manager is shown it.
    const s = f.stateOf(id);
    const check = s.attempts.find((a) => a.spec.kind === 'check')!;
    assert.equal(check.phase.t, 'dropped');
    assert.ok(f.ledgerOf(id).some((e) => e.t === 'worktree_failed' && e.attemptId === check.id));
    assert.equal(panels(s)[0].verdict, 'not_verified', 'a dropped check settles its panel');
    const next = await f.core.getPost(
      OWNER,
      f.liveAttempts(id).find((a) => a.kind === 'manager')!.requestId
    );
    assert.ok(
      next.body.includes(`${check.id} NOT STARTED`),
      'the next manager is told of the drop'
    );
  } finally {
    await f.close();
  }
});

test('launch is refused with a reason when the workspace is not a git repository', async () => {
  const f = await fixture();
  try {
    const ws = await f.core.createWorkspace(OWNER, { name: 'Plain', rootPath: tempDir('plain-') });
    await assert.rejects(
      f.host.launch({
        key: 'plain',
        charter: Charter.parse(charter('plain')),
        origin: { t: 'direct' },
        launcherId: f.lead.id,
        workspaceId: ws.id,
      }),
      /refused: workspace root .* is not a git repository/
    );
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
    await f.host.steer(id, f.lead.id, { t: 'note', text: 'Start the work.' });
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
    // The manager planned when the claim ended saw it running; the next one is shown the result.
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'note', text: 'validating' }] }));
    const shown = await f.core.getPost(
      OWNER,
      f.liveAttempts(id).find((a) => a.kind === 'manager')!.requestId
    );
    assert.match(
      shown.body,
      /NEW SINCE YOUR LAST DECISION:\n- validation \w+ of candidate \w+ of \w+: FAILED — check 0 FAILED \(exit 3\): widget still broken/
    );

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

    // The head carries the fix (as integration will make it): done validates it and finishes.
    git(f.repo, 'update-ref', `refs/heads/expedition/${id}`, good);
    await f.answer(id, f.manager(id), json({ actions: [{ do: 'done', summary: 'fixed' }] }));
    await f.host.drain();
    s = f.stateOf(id);
    assert.deepEqual(s.run, { t: 'finished', reason: 'done', summary: 'fixed' });
    const last = s.validations.at(-1)!;
    assert.deepEqual(last.target, { t: 'head' });
    assert.deepEqual(last.runs, [{ checkIndex: 0, outcome: { t: 'passed' } }]);
    for (const v of s.validations) {
      if (v.phase.t !== 'started') throw new Error(`validation ${v.id} never started`);
      assert.equal(v.phase.treeStatus.t, 'removed', `${v.id} tree released`);
    }
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
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  const missing = await runCommand(
    { kind: 'command', argv: ['no-such-binary-xyz'], timeoutSeconds: 5 },
    cwd
  );
  assert.equal(missing.t, 'error');
});

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
  return launched.value as { id: string; status: string };
}
