import {
  type Call,
  type Contract,
  type Entry,
  type Finish,
  type Hash,
  type Key,
  type Outcome,
  type RefId,
  type Reservation,
  type Usage,
  refOf,
} from '../types';
import { canonicalJson, hashOf } from './hash';
import {
  DISPOSAL,
  HELD_BY_PAUSE,
  OUTCOMES,
  RETRIABLE,
  STARTS_AFTER_DEADLINE,
  chargeOf,
  profileOf,
  reservationOf,
  runIdOf,
  usd,
} from './tables';

// An expedition's whole state is a left fold over its append-only log (DESIGN §2, §4). The fold
// is also the log's validator: an entry that cannot follow the ones before it (a `settled` for a
// call never started, a second `started` for one attempt, a start past a cap, a run id that is not
// the one its run key derives) is a typed error naming its index, never skipped. A skipped entry
// would make I1-I3 unprovable from the log.

export type Run = { readonly runId: string; readonly reserved: Reservation };
/** An agent's answer exists and its judge is running. `spent` is the producer's usage. */
export type Judging = {
  readonly ref: RefId;
  readonly out: unknown;
  readonly judgeRunId: string;
  readonly spent: Usage;
};
export type Stage = { readonly t: 'producing' } | ({ readonly t: 'judging' } & Judging);

/** Forward only, per (key, hash), except that `retried` returns a settled attempt to `declared`
 * as the next attempt. `draining`: dropped by a rewrite and told to finish; it keeps its
 * reservation and slots until it settles. `cancelling`: dropped with `cancel`; the host has
 * cancelled the run and it holds everything until the executor reports it settled. */
export type CallStatus =
  | { readonly t: 'declared' }
  | { readonly t: 'running'; readonly run: Run }
  | { readonly t: 'judging'; readonly run: Run; readonly judging: Judging }
  | { readonly t: 'draining'; readonly run: Run; readonly stage: Stage }
  | { readonly t: 'cancelling'; readonly run: Run; readonly stage: Stage }
  | { readonly t: 'settled'; readonly outcome: Outcome };
export type LiveStatus = Extract<CallStatus, { run: Run }>;

/** `declaredIn`: the newest plan version that asked for this exact call. `attempt` counts from 1;
 * a run id names its attempt, so I1 is "a (key, hash, attempt) starts at most once". */
export type CallRecord = {
  readonly call: Call;
  readonly declaredIn: number;
  readonly attempt: number;
  readonly status: CallStatus;
};
export type PlanVersion =
  | { readonly t: 'unplanned' }
  | { readonly t: 'planned'; readonly version: number };
export type Progress = { readonly t: 'open' } | { readonly t: 'finished'; readonly reason: Finish };

export type State = {
  readonly id: string;
  readonly contract: Contract;
  readonly baseSha: string;
  readonly launchedAtMs: number;
  /** Owner `extend` acts, summed. */
  readonly extendedHours: number;
  /** launch + contract hours + extensions. Pausing does not stop it; the owner extends. */
  readonly deadlineMs: number;
  readonly paused: boolean;
  readonly plan: PlanVersion;
  /** Every call ever declared, by key, then by hash: a key's history survives its replacements. */
  readonly calls: ReadonlyMap<Key, ReadonlyMap<Hash, CallRecord>>;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  /** Slots held per pool; a pool at zero is absent. */
  readonly poolsInUse: ReadonlyMap<string, number>;
  /** Asks started and not settled, as `key@hash`. */
  readonly pendingAsks: ReadonlySet<RefId>;
  /** Passed verdicts of judged agent calls since the last applied `plan` entry (or launch). */
  readonly passesSinceRewrite: number;
  readonly progress: Progress;
};

export class ImpossibleEntry extends Error {
  constructor(
    readonly index: number,
    readonly entry: Entry['t'] | 'none',
    readonly why: string
  ) {
    super(`log entry ${index} (${entry}): ${why}`);
    this.name = 'ImpossibleEntry';
  }
}

// ---- Reading a state ----

export type Lookup =
  | { readonly t: 'known'; readonly record: CallRecord }
  | { readonly t: 'unknown' };
export function lookup(s: State, key: Key, hash: Hash): Lookup {
  const record = s.calls.get(key)?.get(hash);
  return record ? { t: 'known', record } : { t: 'unknown' };
}

export type LiveCall = {
  readonly key: Key;
  readonly hash: Hash;
  readonly call: Call;
  readonly attempt: number;
  readonly status: LiveStatus;
};
const LIVE: { readonly [K in CallStatus['t']]: boolean } = {
  declared: false,
  running: true,
  judging: true,
  draining: true,
  cancelling: true,
  settled: false,
};
/** Every call holding a reservation, in key then hash order. */
export function liveCalls(s: State): LiveCall[] {
  const out: LiveCall[] = [];
  for (const [key, byHash] of s.calls)
    for (const [hash, r] of byHash)
      if (LIVE[r.status.t])
        out.push({
          key,
          hash,
          call: r.call,
          attempt: r.attempt,
          status: r.status as LiveStatus,
        });
  return out.sort((a, b) => cmp(a.key, b.key) || cmp(a.hash, b.hash));
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Live and still the plan's: running or judging, not dropped. */
export const ATTACHED: { readonly [K in CallStatus['t']]: boolean } = {
  declared: false,
  running: true,
  judging: true,
  draining: false,
  cancelling: false,
  settled: false,
};

export type Rival = { t: 'rival'; hash: Hash; record: CallRecord; run: Run } | { t: 'none' };
/** The attached run of this key under another hash. Draining and cancelling runs are not
 * rivals: they were let go by a rewrite and finish on their own reservation. */
export function rivalOf(s: State, key: Key, hash: Hash): Rival {
  for (const [h, r] of s.calls.get(key) ?? [])
    if (h !== hash && ATTACHED[r.status.t]) {
      const live = r.status as LiveStatus;
      return { t: 'rival', hash: h, record: r, run: live.run };
    }
  return { t: 'none' };
}

export const STAGE_OF: { [K in LiveStatus['t']]: (s: Extract<LiveStatus, { t: K }>) => Stage } = {
  running: () => ({ t: 'producing' }),
  judging: (s) => ({ t: 'judging', ...s.judging }),
  draining: (s) => s.stage,
  cancelling: (s) => s.stage,
};
export const stageOf = (s: LiveStatus): Stage => STAGE_OF[s.t](s as never);

/** The run a live call is waiting on now: its producer's, or its judge's once it produced. */
export const currentRunId = (s: LiveStatus): string => {
  const stage = stageOf(s);
  return stage.t === 'judging' ? stage.judgeRunId : s.run.runId;
};

// ---- The fold ----

export function fold(entries: readonly Entry[]): State {
  const first = entries[0];
  if (!first) throw new ImpossibleEntry(0, 'none', 'an empty log has no launch');
  return foldFrom(launch(first), entries.slice(1), 1);
}

/** Continue a fold: `foldFrom(fold(log.slice(0, n)), log.slice(n), n)` equals `fold(log)`. */
export function foldFrom(start: State, entries: readonly Entry[], firstIndex: number): State {
  return entries.reduce((s, e, i) => step(s, e, firstIndex + i), start);
}

function launch(e: Entry): State {
  if (e.t !== 'launched') throw new ImpossibleEntry(0, e.t, 'the log must open with `launched`');
  const launchedAtMs = timeOf(e.at, (why) => {
    throw new ImpossibleEntry(0, e.t, why);
  });
  return {
    id: e.id,
    contract: e.contract,
    baseSha: e.baseSha,
    launchedAtMs,
    extendedHours: 0,
    deadlineMs: deadlineOf(launchedAtMs, e.contract, 0),
    paused: false,
    plan: { t: 'unplanned' },
    calls: new Map(),
    spentUsd: 0,
    reservedUsd: 0,
    poolsInUse: new Map(),
    pendingAsks: new Set(),
    passesSinceRewrite: 0,
    progress: { t: 'open' },
  };
}

const HOUR_MS = 3_600_000;
const deadlineOf = (launchedAtMs: number, c: Contract, extendedHours: number): number =>
  launchedAtMs + Math.round((c.budget.hours + extendedHours) * HOUR_MS);

function timeOf(at: string, fail: Fail): number {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? fail(`\`at\` is not a time: ${JSON.stringify(at)}`) : ms;
}

type Fail = (why: string) => never;
type Step<K extends Entry['t']> = (s: State, e: Extract<Entry, { t: K }>, fail: Fail) => State;

/** After `finished`, runs still wind down; nothing else may happen. */
const WIND_DOWN: ReadonlySet<Entry['t']> = new Set(['produced', 'settled']);

export function step(s: State, e: Entry, index: number): State {
  const fail: Fail = (why) => {
    throw new ImpossibleEntry(index, e.t, why);
  };
  if (s.progress.t === 'finished' && !WIND_DOWN.has(e.t)) fail('the expedition has finished');
  return (STEP[e.t] as Step<Entry['t']>)(s, e, fail);
}

const currentVersion = (s: State): number => (s.plan.t === 'planned' ? s.plan.version : -1);

const STEP: { [K in Entry['t']]: Step<K> } = {
  launched: (_s, _e, fail) => fail('launched twice'),
  contract: (s, e) => ({
    ...s,
    contract: e.contract,
    deadlineMs: deadlineOf(s.launchedAtMs, e.contract, s.extendedHours),
  }),
  plan: (s, e, fail) => {
    PLAN_NEXT[s.plan.t](s.plan as never, e.version, fail);
    const named = Object.keys(e.dropped).sort();
    if (canonicalJson(named) !== canonicalJson([...e.diff.dropped].sort()))
      fail('the dispositions must name exactly the diff’s dropped keys');
    let calls = s.calls;
    for (const key of named) {
      const attached = [...(calls.get(key) ?? new Map<Hash, CallRecord>())].filter(
        ([, r]) => ATTACHED[r.status.t]
      );
      const only = attached[0];
      if (!only || attached.length > 1)
        fail(`a disposition for ${key}, which has ${attached.length} running calls, not one`);
      const [hash, r] = only;
      const disposition = e.dropped[key] as 'cancel' | 'finish';
      ALLOWED_DISPOSITION[DISPOSAL[r.call.t]](disposition, key, fail);
      const live = r.status as LiveStatus;
      calls = put(calls, key, hash, { ...r, status: DROP[disposition](live.run, stageOf(live)) });
    }
    return { ...s, calls, plan: { t: 'planned', version: e.version }, passesSinceRewrite: 0 };
  },
  declared: (s, e, fail) => {
    const current = currentVersion(s);
    if (e.planVersion !== current)
      fail(`declared under plan ${e.planVersion}, but the current plan is ${current}`);
    if (hashOf(e.call) !== e.hash) fail('the hash is not the call’s hash');
    const key = e.call.key;
    // A key keeps its kind: what a rewrite may do to a running call (cancel it, or only drain it,
    // for an ask) is decided by kind, so an agent and an ask sharing a key would let one cancel
    // the other.
    for (const r of s.calls.get(key)?.values() ?? [])
      if (r.call.t !== e.call.t)
        fail(`${key} has kind ${r.call.t}; it cannot be declared as ${e.call.t}`);
    const calls = DECLARE_RIVAL[e.call.t](s, key, e.hash);
    const known = lookup({ ...s, calls }, key, e.hash);
    const record: CallRecord =
      known.t === 'known'
        ? {
            ...known.record,
            declaredIn: e.planVersion,
            status: REDECLARE[known.record.status.t](
              known.record.status as never,
              rivalOf({ ...s, calls }, key, e.hash).t === 'rival'
            ),
          }
        : { call: e.call, declaredIn: e.planVersion, attempt: 1, status: { t: 'declared' } };
    return { ...s, calls: put(calls, key, e.hash, record) };
  },
  started: (s, e, fail) => {
    const r = need(s, e.key, e.hash, fail);
    if (r.status.t !== 'declared')
      fail(`started while ${r.status.t}: a (key, hash, attempt) starts at most once (I1)`);
    if (e.runId !== runIdOf(s.id, e.key, e.hash, r.attempt, 'producer'))
      fail(`run id ${e.runId} is not the one attempt ${r.attempt}'s run key derives`);
    const rival = rivalOf(s, e.key, e.hash);
    if (rival.t === 'rival')
      fail(`${e.key} still runs under ${rival.hash}; a replace cancels it first`);
    if (canonicalJson(e.reserved) !== canonicalJson(reservationOf(r.call)))
      fail('the reservation is not the call’s reservation');
    if (s.paused && HELD_BY_PAUSE[r.call.t]) fail('started while paused');
    if (!STARTS_AFTER_DEADLINE[r.call.t] && timeOf(e.at, fail) >= s.deadlineMs)
      fail('started after the deadline');
    if (usd(s.spentUsd + s.reservedUsd + e.reserved.usd) > s.contract.budget.usd)
      fail('the reservation exceeds the budget (I2)');
    for (const pool of e.reserved.pools) {
      if (!Object.hasOwn(s.contract.pools, pool)) fail(`pool ${pool} is not in the contract`);
      if ((s.poolsInUse.get(pool) ?? 0) + 1 > (s.contract.pools[pool] as number))
        fail(`pool ${pool} is full`);
    }
    const run: Run = { runId: e.runId, reserved: e.reserved };
    return {
      ...s,
      calls: put(s.calls, e.key, e.hash, { ...r, status: { t: 'running', run } }),
      reservedUsd: usd(s.reservedUsd + e.reserved.usd),
      poolsInUse: shift(s.poolsInUse, e.reserved.pools, 1),
      pendingAsks:
        r.call.t === 'ask' ? new Set([...s.pendingAsks, refOf(e.key, e.hash)]) : s.pendingAsks,
    };
  },
  produced: (s, e, fail) => {
    const r = need(s, e.key, e.hash, fail);
    if (profileOf(r.call) !== 'judged-agent')
      fail('only a judged agent call produces before it settles');
    if (e.judgeRunId !== runIdOf(s.id, e.key, e.hash, r.attempt, 'judge'))
      fail(`judge run id ${e.judgeRunId} is not the one attempt ${r.attempt}'s run key derives`);
    const judging: Judging = {
      ref: e.ref,
      out: e.out,
      judgeRunId: e.judgeRunId,
      spent: e.spent,
    };
    const status = PRODUCE[r.status.t](r.status as never, judging, fail);
    return { ...s, calls: put(s.calls, e.key, e.hash, { ...r, status }) };
  },
  settled: (s, e, fail) => {
    const r = need(s, e.key, e.hash, fail);
    return SETTLE[r.status.t](
      s,
      { key: e.key, hash: e.hash, record: r, status: r.status as never, e },
      fail
    );
  },
  retried: (s, e, fail) => {
    const r = need(s, e.key, e.hash, fail);
    const st = r.status;
    if (st.t !== 'settled') return fail(`retried while ${st.t}: only a settled call retries`);
    if (!RETRIABLE[st.outcome.t])
      fail(`retried a ${st.outcome.t} call: it has a result, so a retry would rebuy it`);
    return {
      ...s,
      calls: put(s.calls, e.key, e.hash, {
        ...r,
        attempt: r.attempt + 1,
        status: { t: 'declared' },
      }),
    };
  },
  review: (s, e, fail) => {
    if (e.planVersion !== currentVersion(s))
      fail(`a review under plan ${e.planVersion}, but the current plan is ${currentVersion(s)}`);
    return s;
  },
  owner: (s, e, fail) => OWNER[e.act.t](s, e.act as never, fail),
  finished: (s, e) => ({ ...s, progress: { t: 'finished', reason: e.reason } }),
};

const PLAN_NEXT: {
  [K in PlanVersion['t']]: (p: Extract<PlanVersion, { t: K }>, next: number, fail: Fail) => void;
} = {
  unplanned: (_p, next, fail) => {
    if (next !== 0) fail(`the launch plan is version 0, not ${next}`);
  },
  planned: (p, next, fail) => {
    if (next <= p.version) fail(`plan version ${next} does not follow ${p.version}`);
  },
};

const ALLOWED_DISPOSITION: {
  readonly [D in 'choose' | 'finish' | 'host']: (
    d: 'cancel' | 'finish',
    key: Key,
    fail: Fail
  ) => void;
} = {
  choose: () => {},
  finish: (d, key, fail) => {
    if (d !== 'finish') fail(`${key} is an ask: an ask is never cancelled, it drains (I6)`);
  },
  host: (_d, key, fail) => fail(`${key} is the host's own call; a rewrite never drops it`),
};

const DROP: { [K in 'cancel' | 'finish']: (run: Run, stage: Stage) => LiveStatus } = {
  finish: (run, stage) => ({ t: 'draining', run, stage }),
  cancel: (run, stage) => ({ t: 'cancelling', run, stage }),
};

type Calls = ReadonlyMap<Key, ReadonlyMap<Hash, CallRecord>>;
/** A reworded ask (same key, new hash) never cancels the old one (I6): declaring the new one
 * drains it, so the owner can still answer it and the new one starts beside it. */
const DECLARE_RIVAL: { readonly [K in Call['t']]: (s: State, key: Key, hash: Hash) => Calls } = {
  agent: (s) => s.calls,
  command: (s) => s.calls,
  verdict: (s) => s.calls,
  leader: (s) => s.calls,
  ask: (s, key, hash) => {
    const rival = rivalOf(s, key, hash);
    if (rival.t === 'none') return s.calls;
    const live = rival.record.status as LiveStatus;
    return put(s.calls, key, rival.hash, {
      ...rival.record,
      status: { t: 'draining', run: live.run, stage: stageOf(live) },
    });
  },
};

/** The current plan asks for this exact call again. A draining call becomes the plan's again
 * (DESIGN: "not re-attached by plans that do not ask for it"; one that does, re-attaches) unless
 * another hash of its key is attached: a key has at most one attached run, so it stays draining
 * until `decide` has replaced that one and the host declares it again. A cancel already ordered
 * cannot be taken back. */
const REDECLARE: {
  [K in CallStatus['t']]: (st: Extract<CallStatus, { t: K }>, rivalled: boolean) => CallStatus;
} = {
  declared: (st) => st,
  running: (st) => st,
  judging: (st) => st,
  draining: (st, rivalled) => (rivalled ? st : UNDRAIN[st.stage.t](st.run, st.stage as never)),
  cancelling: (st) => st,
  settled: (st) => st,
};
const UNDRAIN: { [K in Stage['t']]: (run: Run, stage: Extract<Stage, { t: K }>) => LiveStatus } = {
  producing: (run) => ({ t: 'running', run }),
  judging: (run, { ref, out, judgeRunId, spent }) => ({
    t: 'judging',
    run,
    judging: { ref, out, judgeRunId, spent },
  }),
};

const PRODUCE: {
  [K in CallStatus['t']]: (st: Extract<CallStatus, { t: K }>, j: Judging, fail: Fail) => CallStatus;
} = {
  declared: (_st, _j, fail) => fail('produced before it started'),
  running: (st, judging) => ({ t: 'judging', run: st.run, judging }),
  judging: (_st, _j, fail) => fail('produced twice'),
  // A draining call's judge is part of it and runs on its reservation.
  draining: (st, j, fail) => ({ ...st, stage: judgingStage(st.stage, j, fail) }),
  // A call being cancelled is never judged: an answer that lands now settles `cancelled`.
  cancelling: (_st, _j, fail) => fail('produced while cancelling: it settles cancelled instead'),
  settled: (_st, _j, fail) => fail('produced after it settled'),
};
const judgingStage = (stage: Stage, j: Judging, fail: Fail): Stage =>
  stage.t === 'producing' ? { t: 'judging', ...j } : fail('produced twice');

type Settling<K extends CallStatus['t']> = {
  key: Key;
  hash: Hash;
  record: CallRecord;
  status: Extract<CallStatus, { t: K }>;
  e: Extract<Entry, { t: 'settled' }>;
};
const SETTLE: { [K in CallStatus['t']]: (s: State, x: Settling<K>, fail: Fail) => State } = {
  // A refusal settles a call that never started: it held nothing and costs nothing.
  declared: (s, { key, hash, record, e }, fail) => {
    if (e.outcome.t !== 'refused') fail(`settled ${e.outcome.t} without starting`);
    if (chargeOf(e.spent, 0) !== 0) fail('a refused call spent money');
    return {
      ...s,
      calls: put(s.calls, key, hash, { ...record, status: { t: 'settled', outcome: e.outcome } }),
    };
  },
  running: (s, x, fail) => release(s, x.key, x.hash, x.record, x.status, x.e, fail),
  judging: (s, x, fail) => release(s, x.key, x.hash, x.record, x.status, x.e, fail),
  draining: (s, x, fail) => release(s, x.key, x.hash, x.record, x.status, x.e, fail),
  cancelling: (s, x, fail) => release(s, x.key, x.hash, x.record, x.status, x.e, fail),
  settled: (_s, _x, fail) => fail('settled twice: a settled outcome never changes (I3)'),
};

/** Settling a live run gives back its slots and reservation and charges what it spent. */
function release(
  s: State,
  key: Key,
  hash: Hash,
  record: CallRecord,
  live: LiveStatus,
  e: Extract<Entry, { t: 'settled' }>,
  fail: Fail
): State {
  const profile = profileOf(record.call);
  const stage = stageOf(live);
  if (!OUTCOMES[profile][stage.t].includes(e.outcome.t))
    fail(`a ${profile} call cannot settle ${e.outcome.t} while ${stage.t}`);
  const held = live.run.reserved;
  // R1's boot path: a logged start that never reached the executor ran nothing.
  if (e.outcome.t === 'refused' && chargeOf(e.spent, held.usd) !== 0)
    fail('a call refused after it was logged started never ran, so it spent nothing');
  const passes = profile === 'judged-agent' && e.outcome.t === 'passed' ? 1 : 0;
  const ref = refOf(key, hash);
  return {
    ...s,
    calls: put(s.calls, key, hash, { ...record, status: { t: 'settled', outcome: e.outcome } }),
    reservedUsd: usd(s.reservedUsd - held.usd),
    spentUsd: usd(s.spentUsd + chargeOf(e.spent, held.usd)),
    poolsInUse: shift(s.poolsInUse, held.pools, -1),
    pendingAsks: s.pendingAsks.has(ref)
      ? new Set([...s.pendingAsks].filter((x) => x !== ref))
      : s.pendingAsks,
    passesSinceRewrite: s.passesSinceRewrite + passes,
  };
}

type Act = Extract<Entry, { t: 'owner' }>['act'];
const OWNER: { [K in Act['t']]: (s: State, a: Extract<Act, { t: K }>, fail: Fail) => State } = {
  pause: (s, _a, fail) => (s.paused ? fail('paused twice') : { ...s, paused: true }),
  resume: (s, _a, fail) => (s.paused ? { ...s, paused: false } : fail('resumed while not paused')),
  extend: (s, a) => {
    const extendedHours = s.extendedHours + a.hours;
    return {
      ...s,
      extendedHours,
      deadlineMs: deadlineOf(s.launchedAtMs, s.contract, extendedHours),
    };
  },
};

function need(s: State, key: Key, hash: Hash, fail: Fail): CallRecord {
  const found = lookup(s, key, hash);
  return found.t === 'known' ? found.record : fail(`${key}@${hash} was never declared`);
}

function put(calls: Calls, key: Key, hash: Hash, record: CallRecord): Calls {
  const byHash = new Map(calls.get(key) ?? []);
  byHash.set(hash, record);
  const next = new Map(calls);
  next.set(key, byHash);
  return next;
}

function shift(
  inUse: ReadonlyMap<string, number>,
  pools: readonly string[],
  by: 1 | -1
): ReadonlyMap<string, number> {
  const next = new Map(inUse);
  for (const pool of pools) {
    const n = (next.get(pool) ?? 0) + by;
    if (n === 0) next.delete(pool);
    else next.set(pool, n);
  }
  return next;
}
