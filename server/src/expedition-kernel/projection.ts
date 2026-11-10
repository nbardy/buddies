import { keyed } from '@unleashd/shared';
import type { CallRecord, State } from './core';
import type { ExpeditionView } from './ports';

// The wire projection of one expedition (shared/src/expedition-keyed.ts `KeyedRow`, `KeyedView`):
// a pure function of the kernel's state and timeline. The state holds Maps and Sets; what leaves
// here is plain JSON with every field present, grouped the way a client draws it (one lane per
// key), so the client derives nothing.

export function keyedRowOf(s: State): keyed.KeyedRow {
  return {
    id: s.id,
    goal: s.contract.goal,
    status: statusOf(s),
    plan: s.plan.t === 'planned' ? { t: 'planned', version: s.plan.version } : { t: 'unplanned' },
    spentUsd: s.spentUsd,
    reservedUsd: s.reservedUsd,
    budget: { ...s.contract.budget },
    launchedAt: new Date(s.launchedAtMs).toISOString(),
    deadline: new Date(s.deadlineMs).toISOString(),
  };
}

/** `approval` is the Owner port's: the kernel does not hold a rewrite waiting for the owner. */
export function keyedViewOf(
  view: ExpeditionView,
  approval: keyed.PendingApproval
): keyed.KeyedView {
  const s = view.state;
  const barsByKey = new Map<keyed.Key, keyed.Bar[]>();
  for (const bar of view.timeline.bars)
    barsByKey.set(bar.key, [...(barsByKey.get(bar.key) ?? []), bar]);
  const lanes = [...s.calls].map(([key, byHash]): keyed.Lane => {
    const newest = newestOf([...byHash.values()], key);
    return { key, kind: newest.call.t, status: newest.status.t, bars: barsByKey.get(key) ?? [] };
  });
  return {
    ...keyedRowOf(s),
    lanes,
    markers: [...view.timeline.markers],
    asks: pendingAsks(s, view.timeline),
    approval,
    faults: [...view.faults],
  };
}

const STATUS = {
  running: { t: 'running' },
  paused: { t: 'paused' },
} as const satisfies Record<string, keyed.KeyedStatus>;
const statusOf = (s: State): keyed.KeyedStatus =>
  s.progress.t === 'finished'
    ? { t: 'finished', reason: s.progress.reason }
    : STATUS[s.paused ? 'paused' : 'running'];

/** The record the newest plan version declared (a key keeps its kind across hashes). */
function newestOf(records: readonly CallRecord[], key: keyed.Key): CallRecord {
  const [first, ...rest] = records;
  if (!first) throw new Error(`projection: ${key} has no declared call`);
  return rest.reduce((a, b) => (b.declaredIn >= a.declaredIn ? b : a), first);
}

function pendingAsks(s: State, timeline: keyed.Timeline): keyed.PendingAsk[] {
  const openBar = new Map<keyed.RefId, keyed.Bar>();
  for (const bar of timeline.bars)
    if (bar.end.t === 'open') openBar.set(keyed.refOf(bar.key, bar.hash), bar);
  const asks: keyed.PendingAsk[] = [];
  for (const [key, byHash] of s.calls)
    for (const [hash, r] of byHash) {
      const ref = keyed.refOf(key, hash);
      if (!s.pendingAsks.has(ref) || r.call.t !== 'ask') continue;
      const bar = openBar.get(ref);
      if (!bar) throw new Error(`projection: the pending ask ${ref} has no open bar`);
      asks.push({ ref, key, question: r.call.question, answer: r.call.answer, askedAt: bar.start });
    }
  return asks;
}
