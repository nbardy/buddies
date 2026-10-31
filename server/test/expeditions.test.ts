import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { type ExpeditionHost, createExpeditionHost } from '../src/expeditions/host';
import { Charter, type Entry, type State, fold } from '../src/expeditions/model';
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

const charter = (name: string, maxLive = 2) => ({
  name,
  goal: 'Make the widget pass its test.',
  done: { checks: ['pnpm test widget passes'] },
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
        commit: sha,
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

    // The check is blind: it sees the claim, never the work attempt's brief.
    const checkPost = await f.core.getPost(OWNER, check.requestId);
    assert.match(checkPost.body, /The widget passes now/);
    assert.doesNotMatch(checkPost.body, /SECRET-BRIEF/);

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
    // Finished: every worktree is gone; the claim's branch (unintegrated commits) survives, the
    // still-running attempt's empty branch does not.
    for (const tree of Object.values(s.worktrees)) {
      assert.equal(tree.status.t, 'removed', `${tree.attemptId} worktree released`);
      assert.equal(fs.existsSync(tree.path), false);
    }
    assert.equal(git(f.repo, 'rev-parse', claimTree.branch), sha);
    assert.equal(f.branchExists(f.treeOf(id, work[0].id).branch), false);
    const last = s.statuses.at(-1)!;
    assert.match(last.text, /Finished \(done\)/);
    assert.equal(last.post.t, 'posted', 'the finish was posted');

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

    // The holder ends with a finding: its custody frees and the waiting attempt starts, based on
    // the expedition branch head.
    const holder = f.liveAttempts(id).find((a) => a.kind === 'work')!;
    await f.answer(id, holder.id, json({ result: 'finding', statement: 'nope', evidence: [] }));
    assert.deepEqual(questionOfLive(), [docs, inner].sort());
    assert.equal(f.treeOf(id, waiting.id).baseSha, git(f.repo, 'rev-parse', `expedition/${id}`));
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

async function rpcLaunch(f: Awaited<ReturnType<typeof fixture>>, name: string, maxLive = 2) {
  const launched = await rpc(f.spec(), 'expedition', {
    action: { do: 'launch', charter: charter(name, maxLive) },
  });
  assert.equal(launched.error, false, launched.text);
  return launched.value as { id: string; status: string };
}
