import type { keyed } from '@unleashd/shared';
import {
  ATTACHED,
  type CallRecord,
  type CallStatus,
  type Progress,
  type State,
  lookup,
  rivalOf,
} from './state';
import {
  DISPOSAL,
  HELD_BY_PAUSE,
  REPLACES_RIVAL,
  STARTS_AFTER_DEADLINE,
  reservationOf,
  usd,
} from './tables';

// Reconcile by key (DESIGN §2): for each call the plan asks for, the log decides. Finished →
// return the logged result; running → attach; new → reserve budget and a pool slot, then start.
// Restart recovery, plan rewrites and the cost preview are all this one function.

export type Wait =
  /** Every slot of this pool is held; the call queues until one is released. */
  | { readonly t: 'pool'; readonly pool: string }
  /** It fits the budget, but not beside what running calls have reserved; it queues until they
   * settle and release (their reservations are upper bounds, usually not all spent). */
  | { readonly t: 'budget' }
  /** The owner paused the expedition. */
  | { readonly t: 'paused' };

export type Decision =
  | { readonly t: 'reuse'; readonly outcome: keyed.Outcome }
  | { readonly t: 'attach'; readonly runId: string }
  /** Another hash of this key runs: cancel it, and ask again once it has settled. The new call
   * never starts beside it, so a key has at most one attached run. Never for an ask. */
  | {
      readonly t: 'replace';
      readonly cancel: { readonly hash: keyed.Hash; readonly runId: string };
    }
  /** The host appends `started` (log first), then asks the executor to start the run. */
  | { readonly t: 'start'; readonly reservation: keyed.Reservation }
  | { readonly t: 'wait'; readonly why: Wait }
  /** Final: the host settles the call `refused`, and a replay reuses that answer. */
  | { readonly t: 'refuse'; readonly reason: keyed.Refusal }
  /** The expedition has finished; nothing new starts. */
  | { readonly t: 'closed'; readonly reason: keyed.Finish };

/** A key has at most one attached run, and it is the one the plan asks for (I4). So another hash
 * of this key still attached is replaced first, whatever this hash's own state: asking again for
 * a settled k@h1 while k@h2 runs must stop k@h2, or it runs on unasked and is never offered for
 * a disposition (found by the random driver, seed 1). An ask is the exception: its rival drains
 * (the host's `declared` entry drains it), so it is never cancelled (I6). */
export function decide(state: State, call: keyed.Call, hash: keyed.Hash, now: Date): Decision {
  const rival = rivalOf(state, call.key, hash);
  if (rival.t === 'rival' && REPLACES_RIVAL[call.t])
    return { t: 'replace', cancel: { hash: rival.hash, runId: rival.run.runId } };
  const known = lookup(state, call.key, hash);
  return known.t === 'known'
    ? SAME[known.record.status.t](state, known.record, known.record.status as never, now)
    : ADMIT[state.progress.t](state, state.progress as never, call, now);
}

/** The log knows this exact call. */
const SAME: {
  [K in CallStatus['t']]: (
    s: State,
    r: CallRecord,
    st: Extract<CallStatus, { t: K }>,
    now: Date
  ) => Decision;
} = {
  // Never started, or retried: admitted as new.
  declared: (s, r, _st, now) => ADMIT[s.progress.t](s, s.progress as never, r.call, now),
  running: (_s, _r, st) => ({ t: 'attach', runId: st.run.runId }),
  judging: (_s, _r, st) => ({ t: 'attach', runId: st.run.runId }),
  // Asked for again: it is the plan's again (the host's `declared` entry re-attaches it).
  draining: (_s, _r, st) => ({ t: 'attach', runId: st.run.runId }),
  // Its cancel is already ordered; the plan receives the `cancelled` it settles with.
  cancelling: (_s, _r, st) => ({ t: 'attach', runId: st.run.runId }),
  // Any outcome, `failed` and `refused` included: a judged "no" is a result, and a replayed plan
  // must see the answers it saw before or its control flow forks. Only `retried` reopens one.
  settled: (_s, _r, st) => ({ t: 'reuse', outcome: st.outcome }),
};

const ADMIT: {
  [K in Progress['t']]: (
    s: State,
    p: Extract<Progress, { t: K }>,
    call: keyed.Call,
    now: Date
  ) => Decision;
} = {
  open: (s, _p, call, now) => admit(s, call, now),
  finished: (_s, p) => ({ t: 'closed', reason: p.reason }),
};

/** In order: what can never succeed refuses (an unknown pool, the deadline, a budget the call
 * cannot fit even with nothing else running); what will pass waits (pause, reservations in
 * flight, a full pool). A pause waits rather than refuses because a refusal is final and replayed:
 * a pause would otherwise fail every call made during it, for good. An ask reserves nothing and
 * names no pool, so only the deadline and pause tables exempt it. */
function admit(s: State, call: keyed.Call, now: Date): Decision {
  const reservation = reservationOf(call);
  const unknown = reservation.pools.find((p) => !Object.hasOwn(s.contract.pools, p));
  if (unknown !== undefined) return { t: 'refuse', reason: 'pool' };
  if (!STARTS_AFTER_DEADLINE[call.t] && now.getTime() >= s.deadlineMs)
    return { t: 'refuse', reason: 'deadline' };
  if (usd(s.spentUsd + reservation.usd) > s.contract.budget.usd)
    return { t: 'refuse', reason: 'budget' };
  if (s.paused && HELD_BY_PAUSE[call.t]) return { t: 'wait', why: { t: 'paused' } };
  if (usd(s.spentUsd + s.reservedUsd + reservation.usd) > s.contract.budget.usd)
    return { t: 'wait', why: { t: 'budget' } };
  const full = reservation.pools.find(
    (p) => (s.poolsInUse.get(p) ?? 0) >= (s.contract.pools[p] as number)
  );
  if (full !== undefined) return { t: 'wait', why: { t: 'pool', pool: full } };
  return { t: 'start', reservation };
}

/** The plan's running or judging calls the new plan did not ask for and that a rewrite has not
 * already let go. Each agent or command needs a disposition before the rewrite applies; an ask
 * always drains. The host's own calls (done verdicts, leader wakes) are never the plan's. */
export function dropped(state: State, asked: ReadonlySet<keyed.Key>): keyed.Key[] {
  const out: keyed.Key[] = [];
  for (const [key, byHash] of state.calls)
    if (
      !asked.has(key) &&
      [...byHash.values()].some((r) => ATTACHED[r.status.t] && DISPOSAL[r.call.t] !== 'host')
    )
      out.push(key);
  return out.sort();
}
