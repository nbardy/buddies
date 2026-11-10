import type { keyed } from '@unleashd/shared';

// What each kind of call is, as tables keyed by `Call['t']`: what it holds, when it may start,
// what it may settle as, and who disposes of it in a rewrite. Adding a kind of call is adding a
// row to each table; the compiler names any table that lacks it.

/** Dollars kept on a micro-dollar grid: reserving and releasing the same amounts many times must
 * land back on exactly the same number, or `spent + reserved <= budget` drifts at the boundary. */
export const usd = (x: number): number => Math.round(x * 1e6) / 1e6;
const uniqueSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

type PerCall<R> = { [K in keyed.Call['t']]: (c: Extract<keyed.Call, { t: K }>) => R };
const per =
  <R>(table: PerCall<R>) =>
  (call: keyed.Call): R =>
    table[call.t](call as never);

/** What `started` must carry for this call: its `max.usd` and one slot in each named pool. A
 * command, an ask and a check reserve no dollars. */
export const reservationOf = per<keyed.Reservation>({
  agent: (c) => ({ usd: usd(c.max.usd), pools: uniqueSorted(c.pools) }),
  command: (c) => ({ usd: 0, pools: uniqueSorted(c.pools) }),
  ask: () => ({ usd: 0, pools: [] }),
  verdict: (c) => ({
    usd: c.verdict.t === 'review' ? usd(c.max.usd) : 0,
    pools: uniqueSorted(c.pools),
  }),
  leader: (c) => ({ usd: usd(c.max.usd), pools: [] }),
});

/** The deadline bounds work, not judgment (DESIGN §6): an ask and a done verdict start after it.
 * A leader wake is reflection on work, so it does not. */
export const STARTS_AFTER_DEADLINE: { readonly [K in keyed.Call['t']]: boolean } = {
  agent: false,
  command: false,
  ask: true,
  verdict: true,
  leader: false,
};
/** What the host cancels at the deadline (`cutOff`), while it is still producing. A judge is part
 * of its call and finishes; a leader wake is short and finishes. */
export const CUT_AT_DEADLINE: { readonly [K in keyed.Call['t']]: boolean } = {
  agent: true,
  command: true,
  ask: false,
  verdict: false,
  leader: false,
};
/** A pause holds back work; a question to the owner who paused is still worth asking, and the
 * host's own judgment and reflection still happen. */
export const HELD_BY_PAUSE: { readonly [K in keyed.Call['t']]: boolean } = {
  agent: true,
  command: true,
  ask: false,
  verdict: false,
  leader: false,
};
/** `finished` waits for these while they run (core/finish.ts `due`). */
export const AWAITED_BY_FINISH: { readonly [K in keyed.Call['t']]: boolean } = {
  agent: false,
  command: false,
  ask: true,
  verdict: true,
  leader: false,
};
/** A rewrite drops a running call the new plan no longer asks for. The plan's own calls need a
 * disposition (`choose`), except an ask, which is never cancelled: it always drains (`finish`).
 * The host's calls are not the plan's and are never dropped. */
export const DISPOSAL: { readonly [K in keyed.Call['t']]: 'choose' | 'finish' | 'host' } = {
  agent: 'choose',
  command: 'choose',
  ask: 'finish',
  verdict: 'host',
  leader: 'host',
};
/** Another hash of this key still attached is cancelled before this one starts (`replace`). An
 * ask is never cancelled: a reworded ask leaves the old one draining (the `declared` entry drains
 * it) and starts beside it. */
export const REPLACES_RIVAL: { readonly [K in keyed.Call['t']]: boolean } = {
  agent: true,
  command: true,
  ask: false,
  verdict: true,
  leader: true,
};

export type Profile = 'judged-agent' | 'agent' | 'command' | 'ask' | 'verdict' | 'leader';
const JUDGED: { readonly [K in Extract<keyed.Call, { t: 'agent' }>['judge']['t']]: Profile } = {
  none: 'agent',
  check: 'judged-agent',
  review: 'judged-agent',
};
export const profileOf = per<Profile>({
  agent: (c) => JUDGED[c.judge.t],
  command: () => 'command',
  ask: () => 'ask',
  verdict: () => 'verdict',
  leader: () => 'leader',
});

/** Which outcomes a run may settle with, by what it is and how far it got. A judged agent's
 * verdict only comes from its judge (after `produced`); `errored` and `cancelled` are never judged
 * (I7); only a command's exit code or a judge says `failed`. An ask only ever settles `passed`:
 * it is never cancelled and its answer is its `out`. `refused` from a started call is the boot
 * path of R1: logged started, never reached the executor, and past the deadline. */
export const OUTCOMES: {
  readonly [P in Profile]: {
    readonly producing: readonly keyed.Outcome['t'][];
    readonly judging: readonly keyed.Outcome['t'][];
  };
} = {
  'judged-agent': {
    producing: ['errored', 'cancelled', 'refused'],
    judging: ['passed', 'failed', 'errored', 'cancelled'],
  },
  agent: { producing: ['passed', 'errored', 'cancelled', 'refused'], judging: [] },
  command: { producing: ['passed', 'failed', 'errored', 'cancelled', 'refused'], judging: [] },
  ask: { producing: ['passed'], judging: [] },
  verdict: { producing: ['passed', 'failed', 'errored', 'cancelled'], judging: [] },
  leader: { producing: ['passed', 'errored'], judging: [] },
};

/** Outcomes a `retried` entry may reopen. A `passed` or `failed` call has a result; reopening it
 * would buy the same work twice. */
export const RETRIABLE: { readonly [K in keyed.Outcome['t']]: boolean } = {
  passed: false,
  failed: false,
  errored: true,
  cancelled: true,
  refused: true,
};

/** `unreported` usage is charged the whole reservation (DESIGN q2, `keyed.Usage` in shared/src/expedition-keyed.ts). */
const CHARGE: {
  [K in keyed.Usage['t']]: (u: Extract<keyed.Usage, { t: K }>, reservedUsd: number) => number;
} = {
  reported: (u) => u.usd,
  unreported: (_, reservedUsd) => reservedUsd,
};
export const chargeOf = (u: keyed.Usage, reservedUsd: number): number =>
  CHARGE[u.t](u as never, reservedUsd);
/** A judged call's producer and judge share one reservation; their usage adds up. One that did
 * not report makes the total unreported (charged whole). */
export const addUsage = (a: keyed.Usage, b: keyed.Usage): keyed.Usage =>
  a.t === 'reported' && b.t === 'reported'
    ? { t: 'reported', usd: usd(a.usd + b.usd) }
    : { t: 'unreported' };

// ---- run ids (R1) ----
export type Role = 'producer' | 'judge';
/** A run's id, derived from its run key: expedition + key + hash + attempt + role. Derived, not
 * issued by the executor, so the host can log `started` before it calls `start`, and a restart
 * re-issues the same id (start is idempotent on it). */
export const runIdOf = (
  expedition: string,
  key: keyed.Key,
  hash: keyed.Hash,
  attempt: number,
  role: Role
): string => `${expedition}/${key}@${hash}#${attempt}:${role}`;
