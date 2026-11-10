import type { Call, Contract, Diff, Disposition, Hash, Key } from '../types';
import { canonicalJson, hashOf } from './hash';
import { dropped } from './reconcile';
import { ATTACHED, type CallStatus, type PlanVersion, type State, lookup } from './state';
import { DISPOSAL, reservationOf, usd } from './tables';

// A plan rewrite (DESIGN §5): the dry run's diff, then the rules gate. Pure: a rewrite that fails
// a gate changes no state (I8) because judging it writes nothing; the host appends the `plan`
// entry only on `apply` (or after the owner approves a `needs-owner`).

export type Asked = { readonly call: Call; readonly hash: Hash };

type Bucket = 'reused' | 'attached' | 'started';
const BUCKET: { readonly [K in CallStatus['t']]: Bucket } = {
  declared: 'started',
  running: 'attached',
  judging: 'attached',
  draining: 'attached',
  cancelling: 'attached',
  settled: 'reused',
};

/** What running the new plan against the log would do. A new hash under a known key counts as
 * started (and the running old one, if any, is replaced). `newCostUsd` is the reservations the
 * started calls would hold: an upper bound, as the dry run shows it. */
export function diffOf(state: State, asked: readonly Asked[]): Diff {
  const diff = { reused: [] as Key[], attached: [] as Key[], started: [] as Key[] };
  let newCostUsd = 0;
  for (const { call, hash } of asked) {
    const known = lookup(state, call.key, hash);
    const bucket = known.t === 'known' ? BUCKET[known.record.status.t] : 'started';
    diff[bucket].push(call.key);
    if (bucket === 'started') newCostUsd = usd(newCostUsd + reservationOf(call).usd);
  }
  return { ...diff, dropped: dropped(state, new Set(asked.map((a) => a.call.key))), newCostUsd };
}

export type Proposal = {
  readonly version: number;
  /** The contract as the rewritten folder carries it. */
  readonly contract: Contract;
  readonly asked: readonly Asked[];
  readonly dispositions: Readonly<Record<Key, Disposition>>;
};

export type Rejection =
  /** The launch plan is written by the host at launch; only later plans are rewrites. */
  | { readonly t: 'no-plan-yet' }
  | { readonly t: 'finished' }
  /** The Contract is the owner's; a change never arrives through a rewrite (I5). */
  | { readonly t: 'contract-changed' }
  | { readonly t: 'stale-version'; readonly current: number; readonly proposed: number }
  | { readonly t: 'duplicate-key'; readonly key: Key }
  | { readonly t: 'hash-mismatch'; readonly key: Key }
  /** Running calls the new plan drops with no `cancel` or `finish`: there is no default. */
  | { readonly t: 'undecided'; readonly keys: readonly Key[] }
  /** Dispositions for calls the new plan does not drop. */
  | { readonly t: 'stray-disposition'; readonly keys: readonly Key[] }
  /** An ask is never cancelled (I6): a dropped ask drains. */
  | { readonly t: 'ask-cancelled'; readonly keys: readonly Key[] };

export type OwnerReason =
  | { readonly t: 'over-auto-apply'; readonly newCostUsd: number; readonly limitUsd: number }
  /** No judged pass since the last applied rewrite (or since launch, for the first one). */
  | { readonly t: 'no-progress' };

/** `dropped`: the dispositions the `plan` entry carries, one per dropped key: the leader's, plus
 * `finish` for every dropped ask. */
export type Accepted = {
  readonly diff: Diff;
  readonly dropped: Readonly<Record<Key, Disposition>>;
};
export type RewriteVerdict =
  | ({ readonly t: 'apply' } & Accepted)
  | ({
      readonly t: 'needs-owner';
      readonly why: readonly [OwnerReason, ...OwnerReason[]];
    } & Accepted)
  | { readonly t: 'reject'; readonly why: Rejection };

/** The rules gate. Hard failures reject; the two judgment calls go to the owner, both named. */
export function judgeRewrite(state: State, p: Proposal): RewriteVerdict {
  const rejection = rejectionOf(state, p);
  if (rejection.t === 'rejected') return { t: 'reject', why: rejection.why };
  const diff = diffOf(state, p.asked);
  const disposal = (key: Key) => DISPOSAL[attachedCall(state, key).t];
  const asks = diff.dropped.filter((k) => disposal(k) === 'finish');
  const cancelledAsks = asks.filter((k) => p.dispositions[k] === 'cancel');
  if (cancelledAsks.length > 0)
    return { t: 'reject', why: { t: 'ask-cancelled', keys: cancelledAsks } };
  const undecided = diff.dropped.filter(
    (k) => disposal(k) === 'choose' && !Object.hasOwn(p.dispositions, k)
  );
  if (undecided.length > 0) return { t: 'reject', why: { t: 'undecided', keys: undecided } };
  const droppedSet = new Set(diff.dropped);
  const stray = Object.keys(p.dispositions)
    .filter((k) => !droppedSet.has(k))
    .sort();
  if (stray.length > 0) return { t: 'reject', why: { t: 'stray-disposition', keys: stray } };
  const dropped: Record<Key, Disposition> = { ...p.dispositions };
  for (const k of asks) dropped[k] = 'finish';
  const why: OwnerReason[] = [];
  if (diff.newCostUsd > state.contract.autoApply.usd)
    why.push({
      t: 'over-auto-apply',
      newCostUsd: diff.newCostUsd,
      limitUsd: state.contract.autoApply.usd,
    });
  if (state.passesSinceRewrite === 0) why.push({ t: 'no-progress' });
  const [first, ...rest] = why;
  return first
    ? { t: 'needs-owner', diff, dropped, why: [first, ...rest] }
    : { t: 'apply', diff, dropped };
}

/** The one attached call of a key `dropped` returned. */
function attachedCall(state: State, key: Key): Call {
  for (const r of state.calls.get(key)?.values() ?? []) if (ATTACHED[r.status.t]) return r.call;
  throw new Error(`${key} has no attached call, but dropped() named it`);
}

type Checked = { t: 'ok' } | { t: 'rejected'; why: Rejection };
function rejectionOf(state: State, p: Proposal): Checked {
  if (state.progress.t === 'finished') return { t: 'rejected', why: { t: 'finished' } };
  const version = VERSION[state.plan.t](state.plan as never, p.version);
  if (version.t === 'rejected') return version;
  if (canonicalJson(p.contract) !== canonicalJson(state.contract))
    return { t: 'rejected', why: { t: 'contract-changed' } };
  const seen = new Set<Key>();
  for (const { call, hash } of p.asked) {
    if (seen.has(call.key)) return { t: 'rejected', why: { t: 'duplicate-key', key: call.key } };
    seen.add(call.key);
    if (hashOf(call) !== hash) return { t: 'rejected', why: { t: 'hash-mismatch', key: call.key } };
  }
  return { t: 'ok' };
}

const VERSION: {
  [K in PlanVersion['t']]: (v: Extract<PlanVersion, { t: K }>, proposed: number) => Checked;
} = {
  unplanned: () => ({ t: 'rejected', why: { t: 'no-plan-yet' } }),
  planned: (v, proposed) =>
    proposed > v.version
      ? { t: 'ok' }
      : { t: 'rejected', why: { t: 'stale-version', current: v.version, proposed } },
};
