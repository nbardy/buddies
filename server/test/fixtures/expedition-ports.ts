import type {
  Clock,
  Disposed,
  DroppedInfo,
  Executor,
  Leader,
  Owner,
  RawOutcome,
  RewriteAt,
  RewriteForOwner,
  RunSpec,
  RunStatus,
  Woken,
} from '../../src/expedition-kernel/ports';

import type { keyed } from '@unleashd/shared';
import type { ExpeditionView } from '../../src/expedition-kernel/ports';

// Scripted ports for the expedition kernel's end-to-end tests. The agent CLIs are the hard
// external boundary, so these are the only fakes; everything else (plan processes, log files,
// gates) is real. The executor models what the real one must do: runs settle asynchronously under
// test control, start is idempotent on the run id and a no-op once the id is closed, it counts
// the runs it actually created, it outlives a kernel (a test drops the kernel and opens a new one
// on the same directory), and it can hold a start in limbo across that crash.

/** Every scripted port pokes this on any event; `until` re-checks its predicate on each poke. */
export class Signal {
  private readonly waiters = new Set<() => void>();
  /** Appended to a timeout's message: what the test can see of the system. */
  context: () => string = () => '';
  poke(): void {
    for (const w of [...this.waiters]) w();
  }
  /** Resolves once `pred()` holds. No polling: it is re-checked when anything happens. */
  until(pred: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!pred()) return;
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for: ${label}\n${this.context()}`));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }
}

export type Run = {
  readonly runId: string;
  readonly spec: RunSpec;
  state: { t: 'running' } | { t: 'settled'; outcome: RawOutcome; spent: keyed.Usage };
};
/** What the executor does with a run it just created: hold it for the test, or end it. */
export type Policy = (
  run: Run
) => 'hold' | { readonly raw: RawOutcome; readonly spent: keyed.Usage };

export const reported = (usd: number): keyed.Usage => ({ t: 'reported', usd });

export class ScriptedExecutor implements Executor {
  readonly runs = new Map<string, Run>();
  readonly closed = new Set<string>();
  /** Runs created per id: what costs money (I1). */
  readonly created = new Map<string, number>();
  readonly startCalls: string[] = [];
  readonly cancels: string[] = [];
  /** Starts received but not applied: in flight from a host that may be dead. */
  readonly limbo: { runId: string; spec: RunSpec }[] = [];
  /** The next N starts matching `pred` go to limbo instead of running. */
  private holds: { pred: (spec: RunSpec) => boolean; n: number }[] = [];
  private readonly listeners = new Set<
    (runId: string, raw: RawOutcome, spent: keyed.Usage) => void
  >();
  closedNoops = 0;
  idempotentNoops = 0;

  constructor(
    readonly signal: Signal,
    public policy: Policy
  ) {}

  holdNext(pred: (spec: RunSpec) => boolean, n = 1): void {
    this.holds.push({ pred, n });
  }

  async start(runId: string, spec: RunSpec): Promise<void> {
    this.startCalls.push(runId);
    const hold = this.holds.find((h) => h.n > 0 && h.pred(spec));
    if (hold) {
      hold.n--;
      this.limbo.push({ runId, spec });
      this.signal.poke();
      return;
    }
    this.apply(runId, spec);
  }

  /** A start in limbo arrives now. */
  land(runId: string): void {
    const i = this.limbo.findIndex((l) => l.runId === runId);
    if (i < 0) throw new Error(`${runId} is not in limbo`);
    const [held] = this.limbo.splice(i, 1);
    if (held) this.apply(held.runId, held.spec);
  }
  /** A start in limbo never arrives. */
  lose(runId: string): void {
    const i = this.limbo.findIndex((l) => l.runId === runId);
    if (i < 0) throw new Error(`${runId} is not in limbo`);
    this.limbo.splice(i, 1);
  }

  private apply(runId: string, spec: RunSpec): void {
    if (this.closed.has(runId)) {
      this.closedNoops++;
      this.signal.poke();
      return;
    }
    if (this.runs.has(runId)) {
      this.idempotentNoops++;
      this.signal.poke();
      return;
    }
    const run: Run = { runId, spec, state: { t: 'running' } };
    this.runs.set(runId, run);
    this.created.set(runId, (this.created.get(runId) ?? 0) + 1);
    this.signal.poke();
    const p = this.policy(run);
    if (p !== 'hold') setImmediate(() => this.end(runId, p.raw, p.spent));
  }

  /** The run ends: asynchronously from the kernel's point of view, like a real harness. */
  end(runId: string, raw: RawOutcome, spent: keyed.Usage): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no run ${runId}`);
    if (run.state.t !== 'running') throw new Error(`${runId} already ended`);
    run.state = { t: 'settled', outcome: raw, spent };
    for (const l of this.listeners) l(runId, raw, spent);
    this.signal.poke();
  }

  async cancel(runId: string): Promise<void> {
    this.cancels.push(runId);
    const run = this.runs.get(runId);
    // A real harness stops soon after; the cancelled turn has spent a little.
    if (run?.state.t === 'running')
      setImmediate(
        () => run.state.t === 'running' && this.end(runId, { t: 'cancelled' }, reported(0.08))
      );
    this.signal.poke();
  }
  async close(runId: string): Promise<void> {
    this.closed.add(runId);
  }
  async status(runId: string): Promise<RunStatus> {
    const run = this.runs.get(runId);
    if (!run) return { t: 'unknown' };
    return run.state.t === 'running'
      ? { t: 'running' }
      : { t: 'settled', outcome: run.state.outcome, spent: run.state.spent };
  }
  onSettled(listener: (runId: string, raw: RawOutcome, spent: keyed.Usage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- reading ----
  running(pred: (r: Run) => boolean = () => true): Run[] {
    return [...this.runs.values()].filter((r) => r.state.t === 'running' && pred(r));
  }
  /** The run of a call key (any attempt, either role) whose spec matches. */
  find(pred: (r: Run) => boolean): Run[] {
    return [...this.runs.values()].filter(pred);
  }
}

/** The key a run spec belongs to, when it carries a call (judges carry only `of`). */
export const specKey = (spec: RunSpec): string =>
  spec.t === 'agent' || spec.t === 'command' || spec.t === 'ask'
    ? spec.call.key
    : `${spec.t}:${spec.of}`;
/** The call key a run id names (`<expedition>/<key>@<hash>#<attempt>:<role>`). */
export const keyOfRun = (runId: string): string => {
  const m = /^[^/]+\/(.*)@[0-9a-f]{64}#\d+:(producer|judge)$/.exec(runId);
  if (!m?.[1]) throw new Error(`not a run id: ${runId}`);
  return m[1];
};
export const roleOfRun = (runId: string): 'producer' | 'judge' =>
  runId.endsWith(':judge') ? 'judge' : 'producer';
export const attemptOfRun = (runId: string): number => Number(/#(\d+):/.exec(runId)?.[1]);

/** What a scripted wake answers: always an act (a real leader can also answer something that is
 * not one; the Leader port reports that as `errored`). */
export type Acted = { readonly act: keyed.LeaderAct; readonly spent: keyed.Usage };
export type WakeScript = (event: keyed.WakeEvent, view: ExpeditionView) => Acted | Promise<Acted>;
export class ScriptedLeader implements Leader {
  readonly events: keyed.WakeEvent[] = [];
  /** The run id of each wake, in the order of `events`. */
  readonly runIds: string[] = [];
  readonly disposeCalls: { diff: keyed.Diff; dropped: readonly DroppedInfo[] }[] = [];
  constructor(
    readonly signal: Signal,
    public script: WakeScript,
    public disposer: (
      diff: keyed.Diff,
      dropped: readonly DroppedInfo[]
    ) => Readonly<Record<keyed.Key, keyed.Disposition>> = () => ({})
  ) {}
  async wake(runId: string, event: keyed.WakeEvent, view: ExpeditionView): Promise<Woken> {
    this.events.push(event);
    this.runIds.push(runId);
    this.signal.poke();
    try {
      return { t: 'acted', ...(await this.script(event, view)) };
    } finally {
      this.signal.poke();
    }
  }
  async dispose(
    _at: RewriteAt,
    diff: keyed.Diff,
    dropped: readonly DroppedInfo[]
  ): Promise<Disposed> {
    this.disposeCalls.push({ diff, dropped });
    return { t: 'decided', dispositions: this.disposer(diff, dropped) };
  }
}
export const cont: Acted = { act: { t: 'continue' }, spent: reported(0.1) };

export class ScriptedOwner implements Owner {
  readonly asked: RewriteForOwner[] = [];
  constructor(public answer: (r: RewriteForOwner) => boolean) {}
  async approve(r: RewriteForOwner): Promise<boolean> {
    this.asked.push(r);
    return this.answer(r);
  }
}

export class ScriptedClock implements Clock {
  private timers: { at: number; fn: () => void }[] = [];
  constructor(public nowMs: number) {}
  now(): Date {
    return new Date(this.nowMs);
  }
  wakeAt(at: Date, fn: () => void): () => void {
    const timer = { at: at.getTime(), fn };
    if (timer.at <= this.nowMs) {
      setImmediate(fn);
      return () => {};
    }
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }
  advance(ms: number): void {
    this.nowMs += ms;
    const due = this.timers.filter((t) => t.at <= this.nowMs);
    this.timers = this.timers.filter((t) => t.at > this.nowMs);
    for (const t of due) t.fn();
  }
}
