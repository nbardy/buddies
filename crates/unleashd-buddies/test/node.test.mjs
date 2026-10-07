// The TS boundary: load the built addon, pass sum types in, get sum types and typed errors out.
// Run `pnpm run build` first.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const { BuddiesCore } = createRequire(import.meta.url)('../index.js');

test('a request, its run and its answer cross the napi boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buddies-core-'));
  const path = join(dir, 'core.sqlite');
  const core = await BuddiesCore.open(path);

  const owner = { kind: 'owner' };
  const ws = await core.createWorkspace(owner, { name: 'ws', rootPath: dir });
  const hire = (slug) =>
    core.createBuddy(owner, {
      workspaceId: ws.id,
      slug,
      name: slug.toUpperCase(),
      role: 'r',
      manager: { kind: 'nobody' },
      key: slug,
    });
  const a = { kind: 'buddy', id: (await hire('a')).id };
  const b = { kind: 'buddy', id: (await hire('b')).id };
  const { post } = await core.post(
    a,
    { kind: 'direct', members: [a, b] },
    { kind: 'request', body: 'review this', evidence: [], mentions: [], broadcast: false, key: 'k1' }
  );
  assert.deepEqual(post.request, { state: 'awaiting' });
  const channel = await core.openChannel(b, { kind: 'direct', members: [b, a] });
  assert.equal(channel.id, post.channelId);
  // Members come back in canonical (byte-sorted key) order, whatever order they were named in.
  const sorted = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
  assert.deepEqual(channel.kind, { type: 'direct', members: sorted });

  const claim = await core.claimRun({
    leaseMs: 60_000,
    chatDeadlineMs: 86_400_000,
    turnDeadlineMs: 3_600_000,
  }, []);
  assert.deepEqual(claim.run.input, { kind: 'post', postId: post.id });
  const answer = await core.answer(b, {
    requestId: post.id,
    body: 'lgtm',
    evidence: ['ci'],
    key: 'k2',
  });
  assert.equal(answer.replyToId, post.id);
  assert.deepEqual(answer.evidence, ['ci']);
  assert.deepEqual((await core.getPost(a, post.id)).request, {
    state: 'answered',
    answerId: answer.id,
  });
  const settled = await core.settleRun(claim.run.id, claim.leaseToken, {
    kind: 'complete',
    text: 'ok',
  });
  assert.equal(settled.status, 'complete');

  await assert.rejects(core.getBuddy('nobody'), /^Error: \[not_found\]/);
  await assert.rejects(
    core.writeDoc(a, {
      doc: { buddyId: b.id, scope: { kind: 'buddy' }, kind: 'working', name: '' },
      content: 'x',
      baseRevision: 0,
      reason: 'r',
      key: 'k3',
    }),
    /^Error: \[denied\]/
  );
});

test('open refuses a file that is not a buddies-core database', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'buddies-core-')), 'other.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE buddies (id TEXT)');
  db.close();
  await assert.rejects(BuddiesCore.open(path), /\[wrong_database\]/);
});
