import { keyed } from '@unleashd/shared';
import {
  type LiveCall,
  STARTS_AFTER_DEADLINE,
  currentRunId,
  liveCalls,
  runIdOf,
  stageOf,
} from './core';
import type { Expedition } from './kernel';
import { judgeRunOf, producerRun } from './runs';

// Boot (R1): the log says what was started; the executor says what became of it. Every logged
// start is settled from the executor's report, left running, re-issued (start is idempotent on its
// derived id), or, when it must not run now, settled having spent nothing and closed. Nothing is
// sent once and forgotten: a `cancelling` call's cancel is re-derived from the log by the kernel.

/** In the kernel's queue, before the plan process starts. */
export async function recover(e: Expedition): Promise<void> {
  const s = e.state();
  await e.store.removePlansAfter(s.plan.t === 'planned' ? s.plan.version : -1);
  // Re-close every settled attempt: a crash may have lost a close, and a start still in flight
  // from the dead process must land on a closed id.
  for (const [key, byHash] of s.calls)
    for (const [hash, r] of byHash)
      if (r.status.t === 'settled')
        for (const role of ['producer', 'judge'] as const)
          e.effect(e.deps.executor.close(runIdOf(s.id, key, hash, r.attempt, role)));
  for (const c of liveCalls(s)) await recoverCall(e, c);
}

const NOTHING = { t: 'reported', usd: 0 } as const;

async function recoverCall(e: Expedition, c: LiveCall): Promise<void> {
  const run = producerRun(c.call);
  // A wake's answer lived in the dead process. Its event recurs (the replayed plan re-asks its
  // review) or is one the leader no longer needs; the wake is charged whole.
  if (run.t === 'leader')
    return e.settle(
      c.key,
      c.hash,
      { t: 'errored', why: 'the host restarted during this wake' },
      { t: 'unreported' }
    );
  const runId = currentRunId(c.status);
  const status = await e.deps.executor.status(runId);
  if (status.t === 'settled') return e.runEnded(runId, status.outcome, status.spent);
  if (status.t === 'running') return;
  // Logged started, and the executor never heard of it.
  const stage = stageOf(c.status);
  if (c.status.t === 'cancelling')
    return e.settle(
      c.key,
      c.hash,
      { t: 'cancelled', partial: keyed.refOf(c.key, c.hash) },
      stage.t === 'judging' ? stage.spent : NOTHING
    );
  const late =
    !STARTS_AFTER_DEADLINE[c.call.t] && e.deps.clock.now().getTime() >= e.state().deadlineMs;
  if (stage.t === 'producing' && late)
    return e.settle(c.key, c.hash, { t: 'refused', reason: 'deadline' }, NOTHING);
  // A judge is part of its call and starts after the deadline too.
  if (stage.t === 'judging') e.effect(e.deps.executor.start(runId, judgeRunOf(c.call, stage.ref)));
  else e.effect(e.deps.executor.start(runId, run.spec));
}
