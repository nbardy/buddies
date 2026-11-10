import { AsyncLocalStorage } from 'node:async_hooks';
import { Authored, type FromPlan, ToPlan } from '../protocol';
import type { Input, Key, Outcome } from '../types';

// The plan process's half of the wire (protocol.ts). One Session per process, created when the
// plan starts. Every call, ask and review is a message to the host and resolves only when the host
// answers; the plan keeps nothing that matters, so the host may kill this process at any time.

/** Thrown out of plan code once the plan has ended (`need`, a duplicate key, a host fault). The
 * end message is already sent and later sends are dropped, so plan code that catches it changes
 * nothing. */
export class PlanEnded extends Error {
  constructor() {
    super('The plan has ended.');
  }
}

type Waiter =
  | { readonly t: 'call'; readonly settle: (outcome: Outcome) => void }
  | { readonly t: 'review'; readonly settle: () => void };

type Send = (message: FromPlan, done?: (error: Error | null) => void) => boolean;
type Channel = { ref(): void; unref(): void };

/** The enclosing `x.phase(...)` names. Async-local, so concurrent calls inside `parallel` keep
 * their own phase even when their awaits interleave. */
export const phases = new AsyncLocalStorage<readonly string[]>();

export class Session {
  private nextSeq = 0;
  private readonly waiters = new Map<number, Waiter>();
  private readonly keys = new Set<Key>();
  private ended = false;
  /** Something was sent or received since the last `waiting`. */
  private exchanged = true;

  constructor(
    private readonly send: Send,
    private readonly channel: Channel
  ) {}

  /** Quiescence, without timers. The IPC channel is unref'd while the plan works, so the event
   * loop holds only the plan's own work: pending sends, timers it set, anything else it awaits.
   * When that runs out Node emits `beforeExit`: the plan has nothing left to do but wait for the
   * host. We report the unanswered seqs (once per exchange, so a repeat means nothing changed),
   * then ref the channel so the process stays alive for the answer. Each answer unrefs it again. */
  listen(): void {
    process.on('message', (raw: unknown) => this.receive(raw));
    // The host is gone (it died, or closed the channel): nothing here is worth keeping.
    process.on('disconnect', () => process.exit(0));
    process.on('beforeExit', () => this.idle());
    this.channel.unref();
  }

  /** Reserve a key for this evaluation. A second call under one key is a plan bug: the host
   * could not tell the two apart in the log. */
  claim(key: Key): Key {
    if (this.keys.has(key))
      this.fail(
        `Duplicate key "${key}": two calls in this plan would share one log entry. Give them distinct ids.`
      );
    this.keys.add(key);
    return key;
  }

  call(call: Authored): Promise<Outcome> {
    const checked = Authored.safeParse(call);
    if (!checked.success) this.fail(`Call ${call.key} is malformed: ${checked.error.message}`);
    const seq = this.nextSeq++;
    return new Promise((settle) => {
      this.waiters.set(seq, { t: 'call', settle });
      this.post({ t: 'call', seq, call });
    });
  }

  review(question: string): Promise<void> {
    const seq = this.nextSeq++;
    return new Promise((settle) => {
      this.waiters.set(seq, { t: 'review', settle });
      this.post({ t: 'review', seq, question });
    });
  }

  phase(name: string, edge: 'open' | 'close'): void {
    this.post({ t: 'phase', name, edge });
  }

  candidate(ref: string): void {
    this.end({ t: 'candidate', ref });
  }

  gap(why: string, evidence: Input[]): never {
    this.end({ t: 'gap', why, evidence });
    throw new PlanEnded();
  }

  /** End the plan with `threw` from inside the library. */
  fail(message: string): never {
    this.end({ t: 'threw', message });
    throw new PlanEnded();
  }

  /** End the plan with whatever plan code threw. */
  threw(error: unknown): void {
    if (error instanceof PlanEnded) return;
    this.end({
      t: 'threw',
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }

  private post(message: FromPlan): void {
    if (this.ended) return;
    this.send(message);
    this.exchanged = true;
  }

  private end(message: FromPlan): void {
    if (this.ended) return;
    this.ended = true;
    // Exit once the message is flushed: plan code still awaiting other calls must not run on.
    this.send(message, () => process.exit(0));
  }

  private idle(): void {
    if (this.ended) return;
    if (this.exchanged) {
      this.post({ t: 'waiting', on: [...this.waiters.keys()].sort((a, b) => a - b) });
      this.exchanged = false;
    }
    this.channel.ref();
  }

  private receive(raw: unknown): void {
    this.channel.unref();
    this.exchanged = true;
    this.delivery(raw)();
  }

  /** κ for the host's messages: what to do with one, settling its waiter or ending the plan. */
  private delivery(raw: unknown): () => void {
    const fault = (message: string) => () => this.end({ t: 'threw', message });
    const parsed = ToPlan.safeParse(raw);
    if (!parsed.success) return fault(`Unparseable message from the host: ${parsed.error.message}`);
    const message = parsed.data;
    const waiter = this.waiters.get(message.seq);
    if (!waiter) return fault(`The host answered seq ${message.seq}, which is not outstanding.`);
    this.waiters.delete(message.seq);
    // A host that answers a call with `reviewed` (or a review with an outcome) is broken; say so.
    if (message.t === 'outcome' && waiter.t === 'call') return () => waiter.settle(message.outcome);
    if (message.t === 'reviewed' && waiter.t === 'review') return () => waiter.settle();
    return fault(`The host answered ${waiter.t} seq ${message.seq} with "${message.t}".`);
  }
}

let current: Session | 'not-started' = 'not-started';

export function session(): Session {
  if (current === 'not-started')
    throw new Error('Steps, asks and reviews run only inside plan(...) as the host runs it.');
  return current;
}

/** Start the session over this process's IPC channel. Called once, by the child entry. */
export function openSession(): Session {
  const send = process.send?.bind(process) as Send | undefined;
  const channel = process.channel;
  if (!send || !channel)
    throw new Error('A plan runs only as a child of the expedition host (no IPC channel).');
  if (current !== 'not-started') throw new Error('The plan session is already open.');
  current = new Session(send, channel);
  current.listen();
  return current;
}
