import type { CanonCtx } from './canonical';
import { canonicalise } from './canonical';
import type { Authored } from './protocol';
import { type PlanEnd, type PlanHandle, runPlan } from './runner';
import type { Call, Finish, Outcome } from './types';

// One run of one plan version in its child process (runner.ts), as the kernel sees it: every
// call it authors is canonicalised and asked for through the kernel; every answer goes back by
// seq. A killed process's events are dropped: the next one re-asks, and the log answers.

/** An answer for whoever asked for a call: the plan, or the host itself. */
export type Delivery =
  | { readonly t: 'outcome'; readonly outcome: Outcome }
  | { readonly t: 'closed'; readonly reason: Finish };
export type Asker = { readonly deliver: (d: Delivery) => void; readonly alive: () => boolean };

export interface PlanHost {
  /** Run `task` in the kernel's serialized queue. */
  enqueue(task: () => unknown): void;
  request(call: Call, asker: Asker): Promise<void>;
  canonCtx(version: number): CanonCtx;
  fault(what: string): void;
  /** The leader already continued at `question` under `version`. */
  continued(version: number, question: string): boolean;
  wakeReview(question: string): void;
  ended(end: PlanEnd): void;
}

export class PlanProcess {
  private alive = true;
  /** It reported waiting on nothing but seqs the host has not answered. A `waiting` report can be
   * stale (sent before the plan read an answer), so answered seqs are remembered: a stale report
   * made the deadline finish a plan that was about to end with a gap (e2e deadline test). */
  private quiet = false;
  private over = false;
  private readonly answered = new Set<number>();
  private readonly reviews = new Map<string, number[]>();
  private readonly handle: PlanHandle;

  constructor(
    private readonly host: PlanHost,
    readonly version: number,
    folder: string
  ) {
    const on =
      <A extends unknown[]>(fn: (...a: A) => unknown) =>
      (...a: A) =>
        host.enqueue(() => (this.alive ? fn(...a) : undefined));
    this.handle = runPlan({
      folder,
      onCall: on((seq: number, a: Authored) => this.onCall(seq, a)),
      onReview: on((seq: number, q: string) => this.onReview(seq, q)),
      onPhase: () => {},
      onWaiting: on((seqs: readonly number[]) => {
        this.quiet = seqs.every((seq) => !this.answered.has(seq));
      }),
      onEnd: on((end: PlanEnd) => {
        this.over = true;
        host.ended(end);
      }),
    });
  }

  /** It has nothing in flight it could still act on: waiting on the host only, or ended. */
  settled(): boolean {
    return this.quiet || this.over;
  }

  async kill(): Promise<void> {
    this.alive = false;
    await this.handle.kill();
  }

  /** The leader continued at `question`: let the plan past it. */
  answerReview(question: string): void {
    for (const seq of this.reviews.get(question) ?? [])
      this.reply(seq, () => this.handle.reviewed(seq));
    this.reviews.delete(question);
  }

  private reply(seq: number, send: () => void): void {
    this.quiet = false;
    this.answered.add(seq);
    send();
  }

  private async onCall(seq: number, authored: Authored): Promise<void> {
    this.quiet = false;
    const asker: Asker = {
      alive: () => this.alive,
      deliver: (d) => {
        if (this.alive && d.t === 'outcome')
          this.reply(seq, () => this.handle.answer(seq, d.outcome));
      },
    };
    const canon = canonicalise(authored, this.host.canonCtx(this.version));
    if (canon.t === 'invalid') {
      // Deterministic from the folder and the item, so a replay fails the same way.
      const why = `${authored.key} does not canonicalise: ${canon.issues.join('; ')}`;
      this.host.fault(why);
      return asker.deliver({ t: 'outcome', outcome: { t: 'errored', why } });
    }
    await this.host.request(canon.call, asker);
  }

  private onReview(seq: number, question: string): void {
    this.quiet = false;
    if (this.host.continued(this.version, question)) {
      this.reply(seq, () => this.handle.reviewed(seq));
      return;
    }
    this.reviews.set(question, [...(this.reviews.get(question) ?? []), seq]);
    this.host.wakeReview(question);
  }
}
