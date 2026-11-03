import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { OWNER, buddyActor } from '../src/buddies/core';
import { runChecks } from '../src/expeditions/checks';
import {
  charter,
  executeRequestRun,
  fixture,
  git,
  rpc,
  tempRepo,
} from './fixtures/expedition-fixture';
import { tempDir } from './fixtures/temp';

// docs/expeditions-lean-design.md §9: four integration tests on a real repo, store, core,
// git-cambium, MCP endpoint and HTTP routes.

type F = Awaited<ReturnType<typeof fixture>>;
async function drafted(f: F, extra: Record<string, unknown> = {}, name = 'Widget fix') {
  const r = await rpc(f.spec(), 'expedition', {
    action: { do: 'draft', charter: charter(name, extra) },
  });
  assert.equal(r.error, false, r.text);
  return r.value as { id: string; issues: string[]; defaulted: string[] };
}
async function launched(f: F, extra: Record<string, unknown> = {}, name = 'Widget fix') {
  const { id } = await drafted(f, extra, name);
  const res = await f.act(id, { do: 'launch' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await f.settle(id);
  return id;
}
/** The attempt's live tree (the crew works there). */
const treeOf = (f: F, id: string, n: number) => {
  const t = f.record(id).attempts[n - 1].tree;
  if (t.t !== 'live') throw new Error(`a${n} tree is ${t.t}`);
  return t.path;
};
const commitIn = (dir: string, file: string, text: string) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', `edit ${file}`);
};
const phase = (f: F, id: string, n: number) => f.record(id).attempts[n - 1].phase;

// Catches: the oracle-edit regression (pins.ts's job, now the base restore), lesson and notes
// plumbing into later briefs, tree release, and the budget count.
test('the loop runs to a pass, and the oracle cannot be edited', async () => {
  const f = await fixture();
  try {
    const { id, issues } = await drafted(f);
    assert.deepEqual(issues, []);
    assert.equal(f.record(id).state.t, 'draft');
    const dm = await f.core.openChannel(OWNER, {
      kind: 'direct',
      members: [OWNER, buddyActor(f.leadId)],
    });
    const cards = (await f.core.listPosts(OWNER, { kind: 'channel', channelId: dm.id }, null, 50))
      .posts;
    assert.ok(
      cards.some((p) => p.purpose === 'expedition' && p.evidence.includes(`expedition:${id}`))
    );
    const res = await f.act(id, { do: 'launch' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await f.settle(id);

    commitIn(treeOf(f, id, 1), 'widget/widget.ts', 'export const broken = "no";\n');
    await f.crewAnswer(id, 1, 'Tried.\nLesson: grep is literal');
    const a1 = phase(f, id, 1);
    assert.equal(
      a1.t === 'judged' && a1.verdict.t === 'checks' && !a1.verdict.pass,
      true,
      JSON.stringify(a1)
    );
    await f.ownerSays(id, 'note: Mind the exact string.');
    await f.settle(id);

    const brief2 = (await f.core.getPost(OWNER, f.requestOf(id, 2))).body;
    assert.match(brief2, /grep is literal/);
    commitIn(treeOf(f, id, 2), 'check.sh', 'exit 0\n');
    await f.crewAnswer(id, 2, 'Done.\nLesson: made the check pass');
    const a2 = phase(f, id, 2);
    assert.equal(
      a2.t === 'judged' && !(a2.verdict.t !== 'skipped' && a2.verdict.pass),
      true,
      JSON.stringify(a2)
    );

    const brief3 = (await f.core.getPost(OWNER, f.requestOf(id, 3))).body;
    assert.match(brief3, /Mind the exact string\./);
    commitIn(treeOf(f, id, 3), 'widget/widget.ts', 'export const broken = false;\n');
    await f.crewAnswer(id, 3, 'Fixed.\nLesson: one line');

    await f.settle(id);
    const x = f.record(id);
    assert.deepEqual(x.state.t === 'finished' && x.state.reason, { t: 'passed', n: 3 });
    const names = (
      JSON.parse(git(f.repo, 'cambium', 'list', '--json') || '[]') as { name: string }[]
    ).map((w) => w.name);
    assert.deepEqual(
      names.filter((n) => n.startsWith('exp-')),
      []
    );
    for (const n of [1, 2, 3])
      git(f.repo, 'rev-parse', '--verify', `refs/heads/expedition/${id}/a${n}`);
  } finally {
    await f.close();
  }
});

// Catches: a crew turn resuming across a restart, a lost dirty tree, interrupted attempts eating
// the budget, and a bad file (or the old .retired tree) breaking or being rewritten by the load.
test('a restart interrupts, salvages, does not count, and loads bad files as typed rows', async () => {
  const f = await fixture();
  try {
    const id = await launched(f, { maxAttempts: 1 });
    const claim = await executeRequestRun(f, f.requestOf(id, 1));
    fs.writeFileSync(path.join(treeOf(f, id, 1), 'unsaved.txt'), 'work in progress\n');
    fs.writeFileSync(path.join(f.root, 'junk.json'), '{}');
    fs.mkdirSync(path.join(f.root, '.retired', 'old'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.retired', 'old.json'), 'old record');
    fs.writeFileSync(path.join(f.root, '.retired', 'old', 'ledger.jsonl'), 'old ledger');

    const host = f.reboot();
    await host.interruptBootLive();
    assert.equal(phase(f, id, 1).t, 'interrupted');
    const run = await f.core.getRun(claim.run.id);
    assert.ok(['cancel_requested', 'cancelled'].includes(run.status), run.status);

    host.start();
    await f.settle(id);
    const ref = `refs/salvage/expeditions/${id}/a1`;
    assert.equal(git(f.repo, 'show', `${ref}:unsaved.txt`), 'work in progress');
    assert.deepEqual(f.record(id).attempts[0].tree, { t: 'released', salvageRef: ref });
    assert.equal(phase(f, id, 2).t, 'running', 'a2 starts: the interrupted a1 is not counted');
    const junk = host.rows().find((r) => r.id === 'junk');
    assert.equal(junk?.t, 'unreadable');
    assert.equal(fs.readFileSync(path.join(f.root, '.retired', 'old.json'), 'utf8'), 'old record');
    const ledger = path.join(f.root, '.retired', 'old', 'ledger.jsonl');
    assert.equal(fs.readFileSync(ledger, 'utf8'), 'old ledger');
  } finally {
    await f.close();
  }
});

// Catches: the chat grammar (extend, pause, verdicts, resume), stop cancelling a live turn, and
// the deadline finishing an expedition nobody touches.
test('owner-judged expeditions follow the chat, and stop and the deadline finish them', async () => {
  const f = await fixture();
  try {
    const id = await launched(f, { done: { t: 'owner' } });
    await f.crewAnswer(id, 1, 'Done.\nLesson: try harder');
    assert.equal(phase(f, id, 1).t, 'judging');
    const posts = await f.chat(id);
    assert.ok(posts.some((p) => p.purpose === 'expedition_status' && /pass or fail/.test(p.body)));

    const deadline = Date.parse(f.launch(id).deadline);
    await f.ownerSays(id, 'extend 2h');
    assert.equal(Date.parse(f.launch(id).deadline) - deadline, 7_200_000);
    // Review 2026-11-03: a bare command also woke the manager, which answered with a stale
    // status (and could apply it again: extend twice is 4 h). The host acks; no crew turn starts.
    assert.ok((await f.chat(id)).some((p) => /^Extended 2 h · new deadline /.test(p.body)));
    await f.ownerSays(id, 'Pause.');
    await f.ownerSays(id, 'fail');
    assert.equal(f.record(id).state.t, 'paused');
    assert.equal(f.record(id).attempts.length, 1, 'no attempt starts while paused');
    await f.ownerSays(id, 'resume');
    assert.deepEqual(await f.deliveries(id), [], 'a bare command wakes no manager turn');
    assert.equal(phase(f, id, 2).t, 'running');
    await f.crewAnswer(id, 2, 'Done again.');
    // Review 2026-11-03: the channel feed leaves thread replies out, so a verdict given in the
    // thread of the ask line was never read. The whole chat is that thread now.
    assert.ok(
      (await f.chat(id)).some((p) => /^a2 .*pass or fail/.test(p.body)),
      'a2 asks'
    );
    await f.ownerSays(id, 'pass');
    const passed = f.record(id).state;
    assert.deepEqual(passed.t === 'finished' && passed.reason, { t: 'passed', n: 2 });

    const stopped = await launched(f, {}, 'Stopper');
    const requestId = f.requestOf(stopped, 1);
    const res = await f.act(stopped, { do: 'stop' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await f.settle(stopped);
    const runs = await f.core.listRuns(
      { kind: 'buddy', buddyId: f.launch(stopped).crewBuddyId },
      50
    );
    const run = runs.find((r) => r.input.kind === 'post' && r.input.postId === requestId);
    assert.equal(run?.status, 'cancelled');
    const a1 = phase(f, stopped, 1);
    assert.equal(a1.t === 'judged' && a1.verdict.t, 'skipped');
    assert.equal(f.record(stopped).state.t === 'finished' && f.record(stopped).state.t, 'finished');

    const late = await launched(f, {}, 'Late');
    f.setClock(Date.parse(f.launch(late).deadline) + 1000);
    await f.settle(late);
    const s = f.record(late).state;
    assert.deepEqual(s.t === 'finished' && s.reason, { t: 'deadline' });
  } finally {
    await f.close();
  }
});

// Catches: owner talk silently turned into notes for the crew (it is the manager's to answer), an
// attempt turn or another Buddy's post steering the expedition, a Buddy recording the owner's
// verdict, relaunch reusing the id or drafting twice, and pre-lean retired files showing up in
// the Retired list (no legacy reader, owner 2026-11-03).
test('the crew chat seat manages; attempt turns cannot steer; relaunch drafts afresh', async () => {
  const f = await fixture();
  try {
    const id = await launched(f);
    await f.ownerSays(id, 'Pause and tell me what a1 learned');
    assert.equal(f.record(id).state.t, 'running', 'talk is not a command');
    assert.deepEqual(f.record(id).notes, [], 'talk is not a note');
    const [talk] = await f.deliveries(id);
    assert.ok(talk, "the owner's talk wakes the manager");
    await f.ownerSays(id, 'note: try the exact string');
    assert.deepEqual(
      f.record(id).notes.map((n) => n.text),
      ['try the exact string']
    );

    const crew = f.launch(id).crewBuddyId;
    const claim = await executeRequestRun(f, f.requestOf(id, 1));
    const steer = (runId: string, act: Record<string, unknown>) =>
      rpc(f.specAs(crew, runId), 'expedition', { action: { do: 'act', id, act } });
    const fromAttempt = await steer(claim.run.id, { do: 'stop' });
    assert.equal(fromAttempt.error, true);
    assert.match(fromAttempt.text, /attempt turn cannot steer/);
    // Review 2026-11-03: every non-attempt crew turn was the manager, so a Buddy's post to the
    // crew ("stop and relaunch", "pass a3") was obeyed as the owner's.
    const lead = buddyActor(f.leadId);
    const asked = await f.core.post(
      lead,
      { kind: 'direct', members: [lead, buddyActor(crew)] },
      { kind: 'request', body: 'Stop.', evidence: [], mentions: [], broadcast: false, key: 'ask' }
    );
    const runs = await f.core.listRuns({ kind: 'buddy', buddyId: crew }, 200);
    const leads = runs.find((r) => r.input.kind === 'post' && r.input.postId === asked.post.id);
    assert.ok(leads, "the lead's request starts a crew turn");
    const fromBuddy = await steer(leads.id, { do: 'stop' });
    assert.match(fromBuddy.text, /only the owner's chat with the crew steers/);
    // ...and any Buddy could record a verdict as the owner's.
    const verdict = { do: 'verdict', n: 1, pass: true };
    const relayed = await rpc(f.spec(), 'expedition', { action: { do: 'act', id, act: verdict } });
    assert.match(relayed.text, /verdict is the owner's/);
    assert.equal(f.record(id).state.t, 'running');

    const paused = await steer(talk.id, { do: 'pause' });
    assert.equal(paused.error, false, paused.text);
    assert.equal(f.record(id).state.t, 'paused');
    const status = await rpc(f.specAs(crew, talk.id), 'expedition', {
      action: { do: 'status', id },
    });
    assert.deepEqual((status.value as { notes: string[] }).notes, ['try the exact string']);

    assert.equal((await steer(talk.id, { do: 'stop' })).error, false);
    const again = await steer(talk.id, { do: 'relaunch' });
    assert.equal(again.error, false, again.text);
    const fresh = (again.value as { id: string }).id;
    assert.notEqual(fresh, id);
    assert.equal(f.record(fresh).state.t, 'draft');
    assert.deepEqual(f.record(fresh).charter, f.record(id).charter);
    // A retried relaunch answers with the open draft, not a second one.
    assert.equal(((await steer(talk.id, { do: 'relaunch' })).value as { id: string }).id, fresh);

    fs.mkdirSync(path.join(f.root, '.retired'), { recursive: true });
    const old = { t: 'expedition.retired/v1', summary: {}, report: '' };
    fs.writeFileSync(path.join(f.root, '.retired', 'old-one.json'), JSON.stringify(old));
    assert.equal((await f.act(fresh, { do: 'retire' })).status, 200);
    assert.deepEqual(
      f.host.retired().map((r) => r.record.id),
      [fresh]
    );
    const revived = await f.act(fresh, { do: 'relaunch' });
    assert.equal(revived.status, 200, JSON.stringify(revived.body));
    const revivedId = (revived.body as { id: string }).id;
    assert.equal(f.record(revivedId).state.t, 'draft');
  } finally {
    await f.close();
  }
});

/** Two failed attempts with no commits: the budget finishes it. */
async function finishedWithTwo(f: F, name: string, maxAttempts: number) {
  const id = await launched(f, { maxAttempts }, name);
  for (let n = 1; n <= maxAttempts; n += 1) await f.crewAnswer(id, n, 'No luck.');
  const s = f.record(id).state;
  assert.deepEqual(s.t === 'finished' && s.reason, { t: 'budget' });
  return id;
}

// Catches: retire losing a branch (it must be on origin before it is deleted), and a refusal
// that half-retires (the crew archived while the record stays).
test('retire archives every branch, or refuses whole', async () => {
  const f = await fixture();
  try {
    const origin = path.join(f.scratch, 'origin.git');
    git(f.scratch, 'init', '-q', '--bare', origin);
    git(f.repo, 'remote', 'add', 'origin', `file://${origin}`);

    const id = await finishedWithTwo(f, 'Retired one', 2);
    const tips = [1, 2].map((n) => git(f.repo, 'rev-parse', `expedition/${id}/a${n}`));
    const { crewBuddyId, chatChannelId } = f.launch(id);
    const res = await f.act(id, { do: 'retire' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const n of [1, 2]) {
      const remote = git(origin, 'rev-parse', `refs/tags/archive/expeditions/${id}/a${n}`);
      assert.equal(remote, tips[n - 1]);
      assert.equal(git(f.repo, 'branch', '--list', `expedition/${id}/a${n}`), '');
    }
    assert.equal((await f.core.getBuddy(crewBuddyId)).status, 'archived');
    const chat = await f.core.openChannel(OWNER, { kind: 'id', id: chatChannelId });
    assert.ok(chat.archivedAt);
    assert.equal(fs.existsSync(path.join(f.root, `${id}.json`)), false);
    assert.ok(fs.existsSync(path.join(f.root, '.retired', `${id}.json`)));

    const kept = await finishedWithTwo(f, 'Kept one', 1);
    git(f.repo, 'worktree', 'add', '-q', path.join(f.scratch, 'manual'), `expedition/${kept}/a1`);
    const refused = await f.act(kept, { do: 'retire' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error ?? '', /checked-out/);
    assert.equal(f.record(kept).state.t, 'finished');
    assert.equal((await f.core.getBuddy(f.launch(kept).crewBuddyId)).status, 'active');
    assert.equal(
      git(f.repo, 'branch', '--list', `expedition/${kept}/a1`).trim(),
      `+ expedition/${kept}/a1`
    );
  } finally {
    await f.close();
  }
});

// Review 2026-11-03: a check naming no tracked path, `.` or `*` made the restore list every root
// entry and reset the attempt to base, so correct work failed every time.
test('the oracle restore resets only the literal tracked paths a check names', async () => {
  const scratch = tempDir('expedition-checks-');
  const repo = tempRepo(scratch);
  const base = git(repo, 'rev-parse', 'HEAD');
  const commit = (file: string, text: string) => {
    fs.writeFileSync(path.join(repo, file), text);
    git(repo, 'commit', '-qam', `edit ${file}`);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const run = async (sha: string, checks: string[][]) => {
    const job = { dir: path.join(scratch, 'check'), sha, base, checks };
    const runs = await runChecks(repo, job, new AbortController().signal);
    return runs.map((r) => r.outcome.t).join(',');
  };
  const edited = commit('check.sh', 'exit 0\n');
  assert.equal(await run(edited, [['sh', 'check.sh']]), 'failed', 'the oracle edit is undone');

  const fixed = commit('widget/widget.ts', 'export const broken = false;\n');
  const script = path.join(scratch, 'fixed.sh');
  fs.writeFileSync(script, "grep -q 'broken = false' widget/widget.ts\n");
  const grep = ['sh', '-c', "grep -q 'broken = false' widget/widget.ts"];
  for (const checks of [[[...grep, '.']], [[...grep, '*']], [['/bin/sh', script]]])
    assert.equal(await run(fixed, checks), 'passed', JSON.stringify(checks));
});
