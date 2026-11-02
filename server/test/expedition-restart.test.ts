import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Entry, workerAttempts } from '../src/expeditions/model';
import { executeRequestRun, fixture, json, rpcLaunch } from './fixtures/expedition-fixture';
import test from './fixtures/shard';

// Regression: owner 2026-11-03: crews restart on new sessions. Before, a crew run executing at a
// restart ended `lease_expired` and decision G (runs.rs `resume`) continued it ONCE in the SAME
// conversation, on the harness of the backend that died. Now the boot cancels every unsettled
// crew run before adoption (host.ts interruptBootLive), ends its attempt `interrupted`, and the
// expedition replans the work on a fresh run. Real sqlite crate, real git, no runner.

/** Ends every lease the crate holds: one claim clamps them to 1 ms, the next expires them. */
async function expireLeases(f: Awaited<ReturnType<typeof fixture>>) {
  const short = { leaseMs: 1, chatDeadlineMs: 1, turnDeadlineMs: 1 };
  assert.equal(await f.core.claimRun(short, []), null, 'nothing is queued after the boot cancel');
  await sleep(20);
  assert.equal(await f.core.claimRun(short, []), null);
}

const ended = (entries: Entry[], attemptId: string) =>
  entries.find(
    (e): e is Extract<Entry, { t: 'attempt_ended' }> =>
      e.t === 'attempt_ended' && e.attemptId === attemptId
  );

test('a restart cancels the executing manager run and replans the manager on a fresh run', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'restart');
    const m1 = f.manager(id);
    const requestId = f.liveAttempts(id)[0].requestId;
    const { claim, conversationId } = await executeRequestRun(f, requestId);

    // The backend dies mid-turn; the next one boots as server.ts does it.
    const host = f.reboot();
    await host.interruptBootLive();

    assert.deepEqual(ended(f.ledgerOf(id), m1)?.outcome, {
      t: 'interrupted',
      cause: 'server_restart',
      runIds: [claim.run.id],
    });
    assert.equal((await f.core.getRun(claim.run.id)).status, 'cancel_requested');
    // Its holder is gone: the lease ends it cancelled, which decision G never resumes.
    await expireLeases(f);
    assert.equal((await f.core.getRun(claim.run.id)).status, 'cancelled');
    const onConversation = await f.core.listRuns({ kind: 'conversation', conversationId }, 10);
    assert.deepEqual(
      onConversation.map((r) => r.id),
      [claim.run.id],
      'no second attempt of the old run in its conversation'
    );

    host.start();
    await host.tick(id);
    const m2 = f.manager(id);
    assert.notEqual(m2, m1);
    const m2Request = f.liveAttempts(id).find((a) => a.id === m2)!.requestId;
    const s = f.stateOf(id);
    if (s.crew.t !== 'ready') throw new Error('crew expected');
    const runs = (await f.core.listRuns({ kind: 'buddy', buddyId: s.crew.buddyId }, 100)).filter(
      (r) => r.input.kind === 'post' && r.input.postId === m2Request
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'queued');
    assert.equal(runs[0].conversationId ?? null, null, 'a fresh run, never the old conversation');
  } finally {
    await f.close();
  }
});

test('an interrupted work attempt runs again once under a new id, without spending budget', async () => {
  const f = await fixture();
  try {
    const { id } = await rpcLaunch(f, 'retry');
    await f.answer(
      id,
      f.manager(id),
      json({
        actions: [
          {
            do: 'add_question',
            title: 'Fix it',
            detail: 'Fix it',
            scope: 'in',
            paths: ['widget'],
            acceptance: { t: 'panel' },
          },
        ],
      })
    );
    const q = f.stateOf(id).questions[0].id;
    await f.answer(
      id,
      f.manager(id),
      json({ actions: [{ do: 'work', question: q, seat: 0, brief: 'go' }] })
    );
    const w1 = f.liveAttempts(id).find((a) => a.kind === 'work')!;
    await executeRequestRun(f, w1.requestId);
    const budget = workerAttempts(f.stateOf(id));

    const host = f.reboot();
    await host.interruptBootLive();
    host.start();
    await host.tick(id);

    const s = f.stateOf(id);
    assert.equal(ended(f.ledgerOf(id), w1.id)?.outcome.t, 'interrupted');
    const retry = s.retries[w1.id];
    assert.ok(retry, 'the interrupted work is replanned');
    const old = s.attempts.find((a) => a.id === w1.id)!;
    const fresh = s.attempts.find((a) => a.id === retry)!;
    assert.deepEqual(fresh.spec, old.spec, 'the same work, seat and brief');
    assert.equal(fresh.phase.t, 'posted');
    assert.equal(workerAttempts(s), budget, 'a restart spends no attempt');

    // Later ticks never replan it again: one retry per interrupted attempt.
    await host.tick(id);
    assert.equal(
      f.ledgerOf(id).filter((e) => e.t === 'attempt_retry_planned').length,
      1,
      'replanned once'
    );
  } finally {
    await f.close();
  }
});
