import type { ExpeditionView } from './timeline';
import type {
  AgentCall,
  AskCall,
  CommandCall,
  Diff,
  Disposition,
  Key,
  LeaderAct,
  RefId,
  Reservation,
  Usage,
  WakeEvent,
  Who,
} from './types';

// What the kernel needs from the outside world. The real Executor runs agent calls as Buddy
// worker runs through vendor/agent-cli-tool, commands through expeditions/checks.ts and asks as
// owner posts; the real Leader is a turn of the contract's leader Buddy. Tests script all four.

/** One raw run. The kernel composes judging: a judged agent call is two runs (its producer, then
 * a `check` or `review` of what it produced), and so is a done criterion on a candidate. */
export type RunSpec =
  | { readonly t: 'agent'; readonly call: AgentCall }
  | { readonly t: 'command'; readonly call: CommandCall }
  /** The owner answers it. It holds nothing and is never cancelled. */
  | { readonly t: 'ask'; readonly call: AskCall }
  /** Run `command` on the output stored at `of`: exit 0 is `ok`, non-zero `no`. */
  | { readonly t: 'check'; readonly command: string; readonly of: RefId }
  /** `by` reviews the output at `of` against `brief` and says `ok` or `no`. */
  | { readonly t: 'review'; readonly by: Who; readonly brief: string; readonly of: RefId };

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
  | { readonly t: 'settled'; readonly outcome: RawOutcome; readonly spent: Usage }
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
  onSettled(listener: (runId: string, outcome: RawOutcome, spent: Usage) => void): () => void;
}

/** The host's time. `wakeAt` fires `fn` once when `now()` reaches `at` (at once if it has). */
export interface Clock {
  now(): Date;
  wakeAt(at: Date, fn: () => void): () => void;
}

/** A dropped running call, as the leader sees it when it must choose cancel or finish. */
export type DroppedInfo = {
  readonly key: Key;
  readonly startedAt: string;
  readonly reserved: Reservation;
  readonly stage: 'producing' | 'judging';
};

export type Woken = { readonly act: LeaderAct; readonly spent: Usage };

export interface Leader {
  /** One wake: the kernel has logged it as the call `leader/<n>` and charges `spent` to it. */
  wake(event: WakeEvent, view: ExpeditionView): Promise<Woken>;
  /** Asked only when a submitted rewrite drops running calls: one disposition per dropped key.
   * Part of the rewrite act, so not charged separately. */
  dispose(diff: Diff, dropped: readonly DroppedInfo[]): Promise<Readonly<Record<Key, Disposition>>>;
}

export type RewriteForOwner = {
  readonly diff: Diff;
  readonly why: string;
  readonly reasons: readonly string[];
};
export interface Owner {
  /** A rewrite the rules gate sent to the owner (`needs-owner`). Questions to the owner are not
   * this: they are `ask` calls through the Executor. */
  approve(rewrite: RewriteForOwner): Promise<boolean>;
}
