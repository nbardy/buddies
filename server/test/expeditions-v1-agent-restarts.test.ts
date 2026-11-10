import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { keyed } from '@unleashd/shared';
import { getRef } from '../src/expeditions-v1/executor/refs';
import { HASH, agentSpec, git, harness, runIdOf } from './fixtures/agent-runs';

// CONNECT_PLAN §8 step 4, the risky half: Buddy calls across a SIGKILL of the backend (the executor
// lives in it, fixtures/expedition-backend.ts), stops (close, cancel, the minutes cap) and
// checkouts. Real backend on temp stores, real runner, crate, git and Cambium; the agent CLI is
// the only fake. The three restart tests run in order on one harness: each one's restart is the
// next one's backend.

const h = harness('xk-agent-restarts');
let ws = '';
let named = '';
const EXP = '20261111T000000-cccccc';
const expDir = path.join(h.expRoot, EXP);
const brief = (tag: string, mode: string) =>
  `Do the thing. TAG:${tag} MODE:${mode} ANSWER_JSON:{"n":9}`;

before(async () => {
  // The first backend's expedition posts hang: it "dies" between `posting` and the post.
  await h.boot('A', { EXP_HANG: 'post' });
  ws = await h.workspace();
  named = await h.hire(ws, 'slotted');
  h.launchLog(EXP, ws);
});

after(async () => {
  await h.kill();
  for (const file of fs.readdirSync(h.fake('.')).filter((f) => f.endsWith('.pgid')))
    try {
      process.kill(-Number(h.read(file)), 'SIGKILL');
    } catch {}
});

const runsOfPost = async (buddyId: string, postId: string) =>
  (await h.runsOf(buddyId)).filter((r) => r.input.kind === 'post' && r.input.postId === postId);
const postedRecord = (runId: string) =>
  h
    .eventually(
      () => h.record(runId),
      (r) => r.t === 'found' && r.value.t === 'posted',
      `${runId} posted`
    )
    .then((r) => {
      if (r.t !== 'found' || r.value.t !== 'posted') throw new Error('unreachable');
      return r.value;
    });
/** One slot on `named`, held by an ordinary request until `release(tag)`. */
async function holdSlot(tag: string): Promise<void> {
  const capped = await h.http('PATCH', `/api/buddies/${named}`, {
    maxActiveRuns: 1,
    key: `cap-${tag}`,
  });
  assert.equal(capped.status, 200, JSON.stringify(capped.body));
  await h.ask(named, `Hold. TAG:${tag} MODE:hold ANSWER_JSON:{"n":0}`, `hold-${tag}`);
  await h.eventually(() => h.exists(`${tag}.midturn`), Boolean, `${tag} holding the slot`);
}
const byNamed = () => ({ by: { t: 'buddy', id: named } as keyed.Who });

test('a backend killed between writing the record and posting: the restart posts once, one run', {
  timeout: 240_000,
}, async () => {
  const runId = runIdOf(EXP, 'r/before-post', 'a');
  const started = h
    .start(runId, agentSpec('r/before-post', brief('beforepost', 'answer')))
    .catch(() => 'the backend died');
  await h.eventually(
    () => h.record(runId),
    (r) => r.t === 'found' && r.value.t === 'posting',
    'the posting record'
  );
  await h.kill();
  assert.equal(await started, 'the backend died');
  assert.equal(h.spawnsOf('beforepost'), 0);

  await h.boot('B');
  const reports = await h.settledOf(runId);
  assert.deepEqual(
    reports.map((r) => r.raw),
    [{ t: 'ok', out: { n: 9 } }]
  );
  const record = await h.record(runId);
  assert.ok(record.t === 'found' && record.value.t === 'settled');
  const seat = (await h.buddies(ws)).find((b) => b.slug === 'expedition-seat');
  const runs = (await h.runsOf(seat?.id as string)).filter((r) => r.input.kind === 'post');
  assert.equal(runs.length, 1, 'exactly one crate run for the run id');
  assert.equal(h.spawnsOf('beforepost'), 1);
});

test('a backend killed between posting and the claim: the restart claims it once', {
  timeout: 240_000,
}, async () => {
  await holdSlot('holderone');
  const runId = runIdOf(EXP, 'r/before-claim', 'b');
  await h.start(runId, agentSpec('r/before-claim', brief('beforeclaim', 'answer'), byNamed()));
  const posted = await postedRecord(runId);
  await h.eventually(
    () => runsOfPost(named, posted.postId),
    (runs) => runs.length === 1 && runs[0]?.status === 'queued',
    'the call run queued behind the held slot'
  );
  await h.kill();

  await h.boot('C');
  // The holder's turn was adopted and still holds the slot: the call has not run.
  assert.equal(h.spawnsOf('beforeclaim'), 0);
  h.release('holderone');
  const reports = await h.settledOf(runId);
  assert.deepEqual(
    reports.map((r) => r.raw),
    [{ t: 'ok', out: { n: 9 } }]
  );
  assert.equal((await runsOfPost(named, posted.postId)).length, 1, 'one crate run');
  assert.equal(h.spawnsOf('beforeclaim'), 1);
  assert.equal(h.spawnsOf('holderone'), 1, 'the holder was adopted, not re-run');
});

test('a call executing when the backend dies is adopted, not re-run, and settles once', {
  timeout: 240_000,
}, async () => {
  const runId = runIdOf(EXP, 'r/executing', 'c');
  await h.start(runId, agentSpec('r/executing', brief('executing', 'hold')));
  await h.eventually(() => h.exists('executing.midturn'), Boolean, 'the call mid-turn');
  await h.kill();

  await h.boot('D');
  h.release('executing');
  const reports = await h.settledOf(runId);
  assert.equal(reports.length, 1, 'reported once by the new backend');
  assert.deepEqual(reports[0]?.raw, { t: 'ok', out: { n: 9 } });
  assert.equal(h.spawnsOf('executing'), 1, 'adopted, not re-run');
  const record = await h.record(runId);
  assert.ok(record.t === 'found' && record.value.t === 'settled');
});

test('close on a queued call cancels its run, which is never claimed; a cancelled queued call is cancelled', {
  timeout: 240_000,
}, async () => {
  await holdSlot('holdertwo');
  const closed = runIdOf(EXP, 'r/closed', 'd');
  const cancelled = runIdOf(EXP, 'r/queued-cancel', 'e');
  await h.start(closed, agentSpec('r/closed', brief('closedcall', 'answer'), byNamed()));
  await h.start(cancelled, agentSpec('r/queued-cancel', brief('qcancel', 'answer'), byNamed()));
  const closedPost = await postedRecord(closed);
  const cancelledPost = await postedRecord(cancelled);
  for (const p of [closedPost, cancelledPost])
    await h.eventually(
      () => runsOfPost(named, p.postId),
      (runs) => runs[0]?.status === 'queued',
      'queued behind the held slot'
    );

  await h.close(closed);
  const tomb = await h.record(closed);
  assert.ok(tomb.t === 'found' && tomb.value.t === 'closed');
  assert.equal((await runsOfPost(named, closedPost.postId))[0]?.status, 'cancelled');

  // A queued run's cancel leaves its request `awaiting` (crate runs.rs cancel_queued); it is
  // still read as cancelled.
  await h.cancel(cancelled);
  const [report] = await h.settledOf(cancelled);
  assert.deepEqual(report?.raw, { t: 'cancelled' });
  assert.deepEqual(report?.spent, { t: 'reported', usd: 0 }, 'it never ran');
  const thread = await h.http('GET', `/api/buddies/posts/${cancelledPost.postId}/thread`);
  const root = thread.body.root as { id: string; request: { state: string } };
  assert.equal(root?.request.state, 'awaiting');

  // The slot frees; neither call ever runs.
  h.release('holdertwo');
  await h.eventually(
    async () => (await h.runsOf(named)).filter((r) => r.status === 'running').length,
    (n) => n === 0,
    'the holder to finish'
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(h.spawnsOf('closedcall'), 0, 'a closed call is never claimed');
  assert.equal(h.spawnsOf('qcancel'), 0);
  const late = await h.status(closed);
  assert.deepEqual(late, {
    t: 'settled',
    outcome: { t: 'cancelled' },
    spent: { t: 'reported', usd: 0 },
  });
});

test('the minutes cap stops a call as an expiry: errored("exceeded …"), recorded as a minutes stop', {
  timeout: 240_000,
}, async () => {
  const runId = runIdOf(EXP, 'r/minutes', 'f');
  await h.start(
    runId,
    agentSpec('r/minutes', brief('minutes', 'hang'), { max: { usd: 20, minutes: 0.05 } })
  );
  const [report] = await h.settledOf(runId);
  assert.deepEqual(report?.raw, { t: 'errored', why: 'exceeded 0.05 min' });
  const record = await h.record(runId);
  assert.ok(record.t === 'found' && record.value.t === 'settled');
  assert.deepEqual(record.value.t === 'settled' && record.value.stop, {
    t: 'minutes',
    minutes: 0.05,
  });
  // The turn is gone.
  const pid = Number(h.read('minutes.midturn'));
  await h.eventually(
    () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    (alive) => !alive,
    'the capped turn to end'
  );
});

test('a checkout call commits on its own branch from its base; the ref records it; the tree is released', {
  timeout: 240_000,
}, async () => {
  const runId = runIdOf(EXP, 'r/checkout', '1');
  await h.start(runId, agentSpec('r/checkout', brief('checkout', 'commit'), { tree: 'checkout' }));
  const [report] = await h.settledOf(runId);
  assert.deepEqual(report?.raw, { t: 'ok', out: { n: 9 } });
  const ref = await getRef(expDir, keyed.refOf('r/checkout', HASH('1')));
  assert.ok(ref.t === 'found' && ref.value.checkout.t === 'branch');
  if (ref.t !== 'found' || ref.value.checkout.t !== 'branch') return;
  const { branch } = ref.value.checkout;
  assert.match(branch, new RegExp(`^expedition/${EXP}/r-checkout-11111111-a1$`));
  assert.equal(git(h.repo, 'rev-parse', branch), ref.value.commit, 'the ref is the branch tip');
  assert.equal(git(h.repo, 'rev-parse', `${ref.value.commit}^`), h.base, 'one commit on the base');
  assert.equal(git(h.repo, 'show', `${ref.value.commit}:made-by-call.txt`), 'work');
  const cwd = h.read('checkout.cwd');
  assert.ok(
    !git(h.repo, 'worktree', 'list', '--porcelain').includes(cwd),
    'the worktree is released'
  );
  assert.equal(git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', "the owner's checkout");
});

test('a cancelled checkout call keeps its dirty work at a salvage ref, its partial', {
  timeout: 240_000,
}, async () => {
  const runId = runIdOf(EXP, 'r/salvage', '2');
  await h.start(runId, agentSpec('r/salvage', brief('salvage', 'dirty'), { tree: 'checkout' }));
  await h.eventually(() => h.exists('salvage.midturn'), Boolean, 'the call mid-turn');
  await h.cancel(runId);
  const [report] = await h.settledOf(runId);
  assert.deepEqual(report?.raw, { t: 'cancelled' });
  const partial = await getRef(expDir, keyed.refOf('r/salvage', HASH('2')));
  assert.ok(partial.t === 'found' && partial.value.checkout.t === 'branch');
  if (partial.t !== 'found' || partial.value.checkout.t !== 'branch') return;
  assert.equal(partial.value.out, null);
  assert.equal(partial.value.commit, h.base, 'nothing was committed');
  const salvage = partial.value.checkout.salvage;
  assert.equal(salvage.t, 'ref');
  if (salvage.t !== 'ref') return;
  assert.equal(git(h.repo, 'show', `${salvage.name}:half-done.txt`), 'partial');
});
