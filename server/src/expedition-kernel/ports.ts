import type { keyed } from '@unleashd/shared';
import type { State } from './core';

// What the kernel needs from the outside world. The real Executor runs agent calls as Buddy
// worker runs through vendor/agent-cli-tool, commands through expeditions/checks.ts and asks as
// owner posts; the real Leader is a turn of the contract's leader Buddy. Tests script all four.

/** The kernel's read view: the folded state plus its timeline, both pure functions of the log.
 * `state` holds Maps, so this is for the server's own ports; the wire gets `keyed.KeyedView`
 * (projection.ts). */
export type ExpeditionView = {
  readonly id: string;
  readonly dir: string;
  readonly state: State;
  readonly timeline: keyed.Timeline;
  readonly faults: readonly keyed.Fault[];
  /** The log itself, for what the state does not keep (each call's spend). */
  readonly entries: readonly keyed.Entry[];
};

/** One raw run. The kernel composes judging: a judged agent call is two runs (its producer, then
 * a `check` or `review` of what it produced), and so is a done criterion on a candidate. */
export type RunSpec =
  | { readonly t: 'agent'; readonly call: keyed.AgentCall }
  | { readonly t: 'command'; readonly call: keyed.CommandCall }
  /** The owner answers it. It holds nothing and is never cancelled. */
  | { readonly t: 'ask'; readonly call: keyed.AskCall }
  /** Run `command` on the output stored at `of`: exit 0 is `ok`, non-zero `no`. Past
   * `maxMinutes` it is killed and `errored`. */
  | {
      readonly t: 'check';
      readonly command: string;
      readonly of: keyed.RefId;
      readonly maxMinutes: number;
    }
  /** `by` reviews the output at `of` against `brief` and says `ok` or `no`, within `max` (its
   * call's: a judge shares its producer's bound). */
  | {
      readonly t: 'review';
      readonly by: keyed.Who;
      readonly brief: string;
      readonly of: keyed.RefId;
      readonly max: keyed.Max;
    };

export type RawOutcome =
  /** An agent answered, a command or check exited 0, a review said yes, or the owner answered.
   * `out` is the parsed answer. */
  | { readonly t: 'ok'; readonly out: unknown }
  /** A command or check exited non-zero, or a review said no. */
  | { readonly t: 'no'; readonly why: string }
  /** The turn or the spawn failed. */
  | { readonly t: 'errored'; readonly why: string }
  | { readonly t: 'cancelled' };

export type RunStatus =
  | { readonly t: 'running' }
  | { readonly t: 'settled'; readonly outcome: RawOutcome; readonly spent: keyed.Usage }
  /** The executor has no record of it: the start never arrived (or has not arrived yet). */
  | { readonly t: 'unknown' };

/** Run ids are derived by the kernel from the run key (expedition, key, hash, attempt, role), and
 * `started` is in the log before `start` is called (R1). So `start` must be idempotent on the id,
 * and a closed id must never start: a start that lands late (a crashed host's request still in
 * flight) is then a no-op instead of a run no ledger holds. */
export interface Executor {
  /** Idempotent on `runId`. A no-op once `runId` is closed. */
  start(runId: string, spec: RunSpec): Promise<void>;
  cancel(runId: string): Promise<void>;
  /** The call that owned `runId` has settled; nothing may run under it again. */
  close(runId: string): Promise<void>;
  /** Boot: what became of a run the log says was started. */
  status(runId: string): Promise<RunStatus>;
  onSettled(listener: (runId: string, outcome: RawOutcome, spent: keyed.Usage) => void): () => void;
}

/** The host's time. `wakeAt` fires `fn` once when `now()` reaches `at` (at once if it has). */
export interface Clock {
  now(): Date;
  wakeAt(at: Date, fn: () => void): () => void;
}

/** A dropped running call, as the leader sees it when it must choose cancel or finish. */
export type DroppedInfo = {
  readonly key: keyed.Key;
  readonly startedAt: string;
  readonly reserved: keyed.Reservation;
  readonly stage: 'producing' | 'judging';
};

/** How a wake ended. Either way it cost `spent`: an answer that is not an act is still a paid turn,
 * and the kernel settles the wake `errored` and charges it. */
export type Woken =
  | { readonly t: 'acted'; readonly act: keyed.LeaderAct; readonly spent: keyed.Usage }
  | { readonly t: 'errored'; readonly why: string; readonly spent: keyed.Usage };

/** Which rewrite a disposition is asked for: its expedition and the file the leader submitted. */
export type RewriteAt = { readonly expedition: string; readonly file: string };
/** The leader's choice per dropped key, or why it could not be read (a rejection of the rewrite,
 * shown at the next wake). */
export type Disposed =
  | {
      readonly t: 'decided';
      readonly dispositions: Readonly<Record<keyed.Key, keyed.Disposition>>;
    }
  | { readonly t: 'invalid'; readonly issues: readonly string[] };

export interface Leader {
  /** One wake: the kernel has logged it as the call `leader/<n>`, started under `runId`, and
   * charges `spent` to it. `runId` is derived from the log (start is keyed by it, so a wake
   * re-issued after a restart is the same turn), and the kernel closes it when the wake settles. */
  wake(runId: string, event: keyed.WakeEvent, view: ExpeditionView): Promise<Woken>;
  /** Asked only when a submitted rewrite drops running calls: one disposition per dropped key.
   * Part of the rewrite act, so not charged separately. */
  dispose(at: RewriteAt, diff: keyed.Diff, dropped: readonly DroppedInfo[]): Promise<Disposed>;
}

export type RewriteForOwner = {
  readonly expedition: string;
  readonly diff: keyed.Diff;
  readonly why: string;
  readonly reasons: readonly string[];
};
export interface Owner {
  /** A rewrite the rules gate sent to the owner (`needs-owner`). Questions to the owner are not
   * this: they are `ask` calls through the Executor. */
  approve(rewrite: RewriteForOwner): Promise<boolean>;
}
