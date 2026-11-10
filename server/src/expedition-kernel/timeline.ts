import type { State } from './core';
import type { Call, Diff, Disposition, Entry, Finish, Hash, Key, Outcome } from './types';
import { refOf } from './types';

// The read view for a UI: the folded state plus a timeline, both pure functions of the log.
// A bar is one attempt of one (key, hash): from `started` to `settled`. A call refused before it
// started is a zero-length bar, so every key the plan asked for appears.

export type BarEnd =
  | { readonly t: 'open' }
  | { readonly t: 'settled'; readonly at: string; readonly outcome: Outcome };
export type Bar = {
  readonly key: Key;
  readonly hash: Hash;
  readonly kind: Call['t'];
  readonly attempt: number;
  /** The plan version current when it started (or was refused). */
  readonly planVersion: number;
  readonly start: string;
  readonly end: BarEnd;
};
export type Marker =
  | {
      readonly t: 'plan';
      readonly at: string;
      readonly version: number;
      readonly by: string;
      readonly why: string;
      readonly diff: Diff;
      readonly dropped: Readonly<Record<Key, Disposition>>;
    }
  | {
      readonly t: 'review';
      readonly at: string;
      readonly planVersion: number;
      readonly question: string;
      readonly decision: 'continue' | 'rewrite' | 'retry' | 'stop';
      readonly why: string;
    }
  | { readonly t: 'finished'; readonly at: string; readonly reason: Finish };
export type Timeline = { readonly bars: readonly Bar[]; readonly markers: readonly Marker[] };

export type Fault = { readonly at: string; readonly what: string };
export type ExpeditionView = {
  readonly id: string;
  readonly dir: string;
  readonly state: State;
  readonly timeline: Timeline;
  /** What the kernel could not act on (an executor reporting what a run cannot do, a plan call
   * that would not canonicalise). Never silent; never state. */
  readonly faults: readonly Fault[];
};

type Fold = {
  version: number;
  kinds: Map<string, Call['t']>;
  attempts: Map<string, number>;
  open: Map<string, number>;
  bars: Bar[];
  markers: Marker[];
};

export function timelineOf(entries: readonly Entry[]): Timeline {
  const f: Fold = {
    version: -1,
    kinds: new Map(),
    attempts: new Map(),
    open: new Map(),
    bars: [],
    markers: [],
  };
  for (const e of entries) (ON[e.t] as (f: Fold, e: Entry) => void)(f, e);
  return { bars: f.bars, markers: f.markers };
}

const attemptOf = (f: Fold, ref: string) => f.attempts.get(ref) ?? 1;
const kindOf = (f: Fold, ref: string): Call['t'] => {
  const kind = f.kinds.get(ref);
  if (kind === undefined) throw new Error(`timeline: ${ref} was never declared`);
  return kind;
};

const ON: { [K in Entry['t']]: (f: Fold, e: Extract<Entry, { t: K }>) => void } = {
  launched: () => {},
  contract: () => {},
  plan: (f, e) => {
    f.version = e.version;
    f.markers.push({
      t: 'plan',
      at: e.at,
      version: e.version,
      by: e.by,
      why: e.why,
      diff: e.diff,
      dropped: e.dropped,
    });
  },
  declared: (f, e) => {
    f.kinds.set(refOf(e.call.key, e.hash), e.call.t);
  },
  started: (f, e) => {
    const ref = refOf(e.key, e.hash);
    f.open.set(ref, f.bars.length);
    f.bars.push({
      key: e.key,
      hash: e.hash,
      kind: kindOf(f, ref),
      attempt: attemptOf(f, ref),
      planVersion: f.version,
      start: e.at,
      end: { t: 'open' },
    });
  },
  produced: () => {},
  settled: (f, e) => {
    const ref = refOf(e.key, e.hash);
    const end: BarEnd = { t: 'settled', at: e.at, outcome: e.outcome };
    const index = f.open.get(ref);
    if (index === undefined) {
      f.bars.push({
        key: e.key,
        hash: e.hash,
        kind: kindOf(f, ref),
        attempt: attemptOf(f, ref),
        planVersion: f.version,
        start: e.at,
        end,
      });
      return;
    }
    f.open.delete(ref);
    f.bars[index] = { ...(f.bars[index] as Bar), end };
  },
  retried: (f, e) => {
    const ref = refOf(e.key, e.hash);
    f.attempts.set(ref, attemptOf(f, ref) + 1);
  },
  review: (f, e) => {
    f.markers.push({
      t: 'review',
      at: e.at,
      planVersion: e.planVersion,
      question: e.question,
      decision: e.decision,
      why: e.why,
    });
  },
  owner: () => {},
  finished: (f, e) => {
    f.markers.push({ t: 'finished', at: e.at, reason: e.reason });
  },
};
