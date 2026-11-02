import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OWNER, buddyActor } from '../src/buddies/core';
import type { ExpeditionHost } from '../src/expeditions/host';
import { fixture, git, json, rpcLaunch } from './fixtures/expedition-fixture';
import test from './fixtures/shard';

// Retire (plan A6), end to end on the real sqlite crate, real git, a real bare remote and the
// real Cambium. The emergent-beach expedition is the case: finish left one tree (a killed remove
// had stranded 2582 ` D` lines, so `finish` refused it, a terminal `left`) and kept an unmerged
// attempt branch whose only copy was local. Retire must remove the tree, archive every ref as a
// tag on origin BEFORE deleting it, archive the crew and only its own chats, and freeze the
// expedition so a later boot never folds its ledger again.

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Ticks until the expedition is filed away (or the bound runs out, which the caller asserts). */
async function settle(host: ExpeditionHost, id: string, until: (h: ExpeditionHost) => boolean) {
  for (let i = 0; i < 30 && !until(host); i += 1) await host.tick(id);
}

function bareRemote(f: Fixture): string {
  const remote = path.join(f.scratch, 'remote.git');
  git(f.scratch, 'init', '-q', '--bare', remote);
  git(f.repo, 'remote', 'add', 'origin', remote);
  return remote;
}

const localRefs = (f: Fixture, id: string) =>
  git(
    f.repo,
    'for-each-ref',
    '--format=%(refname)',
    `refs/heads/exp/${id}/`,
    `refs/heads/expedition/${id}`,
    `refs/salvage/expeditions/${id}/`
  );

/** Two work attempts on disjoint custody: w1 commits (kept, unmerged), w2 deletes a tracked file
 * and commits nothing (finish refuses its tree: `left`). Then the owner stops it. */
async function finishedWithLeftovers(f: Fixture) {
  const { id } = await rpcLaunch(f, 'retire', 2);
  const question = (title: string, paths: string[]) => ({
    do: 'add_question',
    title,
    detail: title,
    scope: 'in',
    paths,
    acceptance: { t: 'panel' },
  });
  await f.answer(
    id,
    f.manager(id),
    json({ actions: [question('Fix widget', ['widget']), question('Docs', ['docs'])] })
  );
  const [q1, q2] = f.stateOf(id).questions.map((q) => q.id);
  await f.answer(
    id,
    f.manager(id),
    json({
      actions: [
        { do: 'work', question: q1, seat: 0, brief: 'fix' },
        { do: 'work', question: q2, seat: 1, brief: 'docs' },
      ],
    })
  );
  const work = f.liveAttempts(id).filter((a) => a.kind === 'work');
  assert.equal(work.length, 2);
  const [w1, w2] = work.map((a) => a.id);
  const tip = f.commitIn(f.treeOf(id, w1).path, 'widget/widget.ts');
  const deleted = f.treeOf(id, w2);
  fs.rmSync(path.join(deleted.path, 'docs', 'README.md'));
  await f.answer(id, w1, json({ result: 'finding', statement: 'fixed', evidence: [] }));
  await f.answer(id, w2, json({ result: 'finding', statement: 'nothing', evidence: [] }));
  await f.host.steer(id, 'owner', { t: 'stop' });
  for (let i = 0; i < 5; i += 1) await f.host.tick(id);
  const s = f.stateOf(id);
  assert.equal(s.run.t === 'finished' && s.run.reason, 'owner_stop');
  assert.equal(f.treeOf(id, w2).status.t, 'left', 'finish never removes uncommitted work');
  assert.equal(git(f.repo, 'rev-parse', `refs/heads/exp/${id}/${w1}`), tip, 'unmerged: kept');
  return { id, w1, w2, tip, leftTree: deleted.path };
}

test('retire removes what finish left, archives every ref on origin, and freezes the expedition', async () => {
  const f = await fixture();
  try {
    const remote = bareRemote(f);
    const { id, w1, w2, tip, leftTree } = await finishedWithLeftovers(f);
    const s = f.stateOf(id);
    if (s.crew.t !== 'ready') throw new Error('crew expected');
    const crew = s.crew;
    // A DM the crew has with another Buddy is not the crew's own: it must survive the retire.
    const foreign = await f.core.openChannel(OWNER, {
      kind: 'direct',
      members: [buddyActor(crew.buddyId), buddyActor(f.lead.id)],
    });
    const attemptsDm = await f.core.openChannel(buddyActor(crew.buddyId), {
      kind: 'direct',
      members: [buddyActor(crew.buddyId)],
    });
    // w2's branch is empty: retire's remove drops it (nothing to archive). Every other ref is
    // archived: w1's unmerged branch, its salvage pin and the expedition branch.
    const before = localRefs(f, id)
      .split('\n')
      .filter((ref) => ref !== `refs/heads/exp/${id}/${w2}`);
    assert.equal(before.length, 3, `attempt branch, expedition branch and salvage: ${before}`);
    const tips = new Map(before.map((ref) => [ref, git(f.repo, 'rev-parse', ref)]));

    assert.deepEqual(await f.host.retire(id, 'owner', 'retire'), { t: 'retiring' });
    // Metering waits for its runs' settle window; the final line waits for metering.
    f.setClock(Date.parse('2026-11-01T06:00:00Z'));
    await settle(f.host, id, (h) => h.lookup(id).t === 'retired');
    assert.equal(f.host.lookup(id).t, 'retired');

    // The tree finish left is gone; nothing of the expedition is left in the owner's repo but
    // what origin holds, each tag at the tip its ref had.
    assert.equal(fs.existsSync(leftTree), false);
    assert.ok(!git(f.repo, 'worktree', 'list', '--porcelain').includes(path.basename(leftTree)));
    assert.equal(localRefs(f, id), '');
    const tags = new Map(
      git(remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags/')
        .split('\n')
        .map((line) => line.split(' ') as [string, string])
    );
    assert.equal(tags.get(`refs/tags/archive/expeditions/${id}/${w1}`), tip);
    assert.equal(tags.size, tips.size, 'one tag per ref');
    for (const sha of tips.values()) assert.ok([...tags.values()].includes(sha));

    assert.equal((await f.core.getBuddy(crew.buddyId)).status, 'archived');
    const archivedAt = async (channelId: string) =>
      (await f.core.openChannel(OWNER, { kind: 'id', id: channelId })).archivedAt;
    assert.ok(await archivedAt(crew.chatChannelId), 'the crew chat is archived');
    assert.ok(await archivedAt(attemptsDm.id), "the crew's attempts DM is archived");
    assert.equal(await archivedAt(foreign.id), undefined, 'a DM with another Buddy stays');

    // Frozen: a snapshot, the folder moved, `retired` the last ledger line.
    const retiredDir = path.join(f.root, '.retired');
    assert.ok(fs.existsSync(path.join(retiredDir, `${id}.json`)));
    assert.equal(fs.existsSync(path.join(f.root, id)), false);
    const ledger = fs
      .readFileSync(path.join(retiredDir, id, 'ledger.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => JSON.parse(line) as { t: string }[]);
    assert.equal(ledger.at(-1)?.t, 'retired');

    // A later boot serves it from the snapshot and never folds it.
    const boot = f.hostWith();
    try {
      assert.deepEqual(boot.lookup(id), { t: 'retired' });
      const row = boot.summaries().find((x) => x.id === id);
      assert.equal(row?.retirement.t, 'retired');
      assert.equal(boot.retiredView(id).summary.id, id);
      assert.ok(!boot.crews().includes(crew.buddyId), 'a retired crew is not a live crew');
      assert.deepEqual(await boot.retire(id, 'owner', 'retire'), { t: 'already_retired' });
    } finally {
      boot.close();
    }
  } finally {
    await f.close();
  }
});

test('stop_and_retire stops an open expedition first; a ref origin cannot confirm is never deleted', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'stop-retire', 2);
    assert.deepEqual(await f.host.retire(id, 'owner', 'retire'), { t: 'not_finished' });
    assert.deepEqual(await f.host.retire(id, 'owner', 'stop_and_retire'), { t: 'retiring' });
    await f.host.tick(id);
    assert.ok(
      f.stateOf(id).attempts.every((a) => a.id in f.stateOf(id).cancels || a.phase.t === 'ended')
    );
    // The live manager's queued run was cancelled; its request stays open until the grace ends
    // it `abandoned`. Then metering's settle window.
    f.setClock(Date.parse('2026-11-01T06:00:00Z'));
    await settle(f.host, id, () => {
      const s = f.stateOf(id);
      return s.retirement.t === 'retiring' && s.retirement.refused.length > 0;
    });

    const kinds = f.ledgerOf(id).map((e) => e.t);
    const requested = kinds.indexOf('retire_requested');
    assert.ok(requested >= 0 && kinds.indexOf('finished') > requested);
    const s = f.stateOf(id);
    assert.equal(s.run.t === 'finished' && s.run.reason, 'owner_stop');
    // No origin: the archive is refused, visible, and the expedition branch is still there.
    if (s.retirement.t !== 'retiring') throw new Error('still retiring');
    assert.match(s.retirement.refused[0].reason, /origin|push/);
    assert.ok(f.branchExists(`expedition/${id}`), 'never deleted while its only copy is local');
    assert.equal(f.host.view(id).retirement.t, 'retiring');

    // The owner fixes the remote and asks again: retire is idempotent.
    const remote = bareRemote(f);
    assert.deepEqual(await f.host.retire(id, 'owner', 'retire'), { t: 'retiring' });
    await settle(f.host, id, (h) => h.lookup(id).t === 'retired');
    assert.equal(f.host.lookup(id).t, 'retired');
    assert.ok(git(remote, 'rev-parse', `refs/tags/archive/expeditions/${id}/expedition`));
    assert.equal(f.branchExists(`expedition/${id}`), false);
  } finally {
    await f.close();
  }
});

// Retirement is what let B5 change the ledger format (one tree model): every live ledger was
// retired first and is served from its snapshot. A ledger still in the older per-kind tree format
// must not fold with those lines skipped (stored lines are parsed unchecked): that left it with no
// integration tree, failing every tick. It is quarantined at boot, and the file stays.
test('a ledger with an entry of no known kind is quarantined at boot, never folded around it', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'old-format');
    const at = '2026-11-01T00:00:00Z';
    fs.appendFileSync(
      f.ledgerPath(id),
      `${JSON.stringify([{ t: 'integration_tree_ready', at }])}\n`
    );
    f.restart();
    const found = f.host.lookup(id);
    assert.equal(found.t, 'quarantined');
    assert.match(
      found.t === 'quarantined' ? found.reason : '',
      /unknown ledger entry integration_tree_ready/
    );
    assert.ok(fs.existsSync(f.ledgerPath(id)), 'the file stays for the owner');
  } finally {
    await f.close();
  }
});
