import type { ProviderOf } from './canonical';
import { Change } from './change';
import {
  CUT_AT_DEADLINE,
  type CallRecord,
  type Decision,
  type LiveCall,
  RETRIABLE,
  type State,
  addUsage,
  canonicalJson,
  currentRunId,
  cutOff,
  decide,
  due,
  fold,
  hashOf,
  liveCalls,
  lookup,
  profileOf,
  rivalOf,
  runIdOf,
  stageOf,
  step,
} from './core';
import type { LogStore } from './log-store';
import { type Asker, type Delivery, type PlanHost, PlanProcess } from './plan-process';
import type { Clock, Executor, Leader, Owner, RawOutcome } from './ports';
import { recover } from './recovery';
import type { PlanEnd } from './runner';
import { type Ending, endingOf, judgeRunOf, producerRun } from './runs';

import { keyed } from '@unleashd/shared';
import type { ExpeditionView } from './ports';

// The kernel (docs/expeditions/keyed/v1/DESIGN.md): one expedition's log, its plan process and
// its runs. Every decision and every log append happens inside ONE serialized queue per
// expedition, so each is atomic with respect to the others; executor and leader calls are
// effects issued after the entry that licenses them is durable (log first, R1). The leader's
// side (wakes, rewrites, the done evaluation) is change.ts.
// Pattern: one write path (docs/patterns.md#one-write-path)

export type KernelDeps = {
  readonly executor: Executor;
  readonly leader: Leader;
  readonly owner: Owner;
  readonly clock: Clock;
  readonly providerOf: ProviderOf;
  /** For the typecheck gate (gates.ts `typecheckGate`). */
  readonly gates: {
    readonly zodEntry: string;
    readonly tscBin: string;
  };
  /** What a leader wake and a done review may cost; neither is priced by the contract. */
  readonly limits: { readonly leaderWake: keyed.Max; readonly doneReview: keyed.Max };
};

type Deliver = Asker['deliver'];
export type { Delivery };

export type OwnerResult = { readonly t: 'done' } | { readonly t: 'refused'; readonly why: string };

/** An entry before the host stamps its time. */
export type Body = keyed.Entry extends infer E
  ? E extends keyed.Entry
    ? Omit<E, 'at'>
    : never
  : never;

class Detached extends Error {
  constructor() {
    super('The kernel was detached.');
  }
}

type Proc = { readonly t: 'none' } | { readonly t: 'running'; readonly p: PlanProcess };

const FINISH_OF_DUE = { budget: { t: 'budget' }, deadline: { t: 'deadline' } } as const;

export class Expedition {
  private tail: Promise<unknown> = Promise.resolve();
  private detached = false;
  private proc: Proc = { t: 'none' };
  private waiting: { call: keyed.Call; asker: Asker }[] = [];
  private readonly waiters = new Map<string, Deliver[]>();
  private readonly cancelSent = new Set<string>();
  private readonly faultList: keyed.Fault[] = [];
  private readonly listeners = new Set<(entry: keyed.Entry, state: State) => void>();
  private readonly unsubscribe: () => void;
  private disarm: () => void = () => {};
  private resolveFinished: (f: keyed.Finish) => void = () => {};
  private readonly change: Change;
  /** Resolves when `finished` is in the log. */
  readonly finished: Promise<keyed.Finish>;

  private constructor(
    readonly deps: KernelDeps,
    readonly store: LogStore,
    private log: keyed.Entry[],
    private current: State
  ) {
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
    this.change = new Change(this);
    this.unsubscribe = deps.executor.onSettled((runId, raw, spent) =>
      this.enqueue(() => this.runEnded(runId, raw, spent))
    );
  }

  /** Kernel-internal: `launch.ts` builds one over a new or opened log, then boots it. */
  static over(deps: KernelDeps, store: LogStore, entries: keyed.Entry[]): Expedition {
    return new Expedition(deps, store, entries, fold(entries));
  }

  /** One task, so the first `due` check sees the plan process running: past the deadline, the
   * replayed plan may still reach a candidate whose evaluation `due` must wait for. */
  async boot(): Promise<void> {
    await this.serial(async () => {
      await recover(this);
      if (this.current.progress.t === 'open') this.startPlan(this.version());
    });
    this.armDeadline();
    if (this.current.progress.t === 'finished') this.resolveFinished(this.current.progress.reason);
  }

  // ---- the read view and owner acts ----

  get id(): string {
    return this.current.id;
  }
  get dir(): string {
    return this.store.dir;
  }
  state(): State {
    return this.current;
  }
  entries(): readonly keyed.Entry[] {
    return this.log;
  }
  timeline(): keyed.Timeline {
    return keyed.timelineOf(this.log);
  }
  view(): ExpeditionView {
    return {
      id: this.id,
      dir: this.dir,
      state: this.current,
      timeline: this.timeline(),
      faults: [...this.faultList],
    };
  }
  /** Every append, after it is durable. */
  subscribe(listener: (entry: keyed.Entry, state: State) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pause(): Promise<OwnerResult> {
    return this.ownerAct(() =>
      this.current.paused ? 'already paused' : this.append({ t: 'owner', act: { t: 'pause' } })
    );
  }
  resume(): Promise<OwnerResult> {
    return this.ownerAct(() =>
      this.current.paused ? this.append({ t: 'owner', act: { t: 'resume' } }) : 'not paused'
    );
  }
  extend(hours: number): Promise<OwnerResult> {
    return this.ownerAct(async () => {
      await this.append({ t: 'owner', act: { t: 'extend', hours } });
      this.armDeadline();
    });
  }
  stop(): Promise<OwnerResult> {
    return this.ownerAct(() => this.finish({ t: 'stopped', by: 'owner' }));
  }
  retry(key: keyed.Key): Promise<OwnerResult> {
    return this.serial(() => this.retryKeys([key], 'owner'));
  }
  private ownerAct(act: () => Promise<void> | string): Promise<OwnerResult> {
    return this.serial(async () => {
      if (this.current.progress.t === 'finished')
        return { t: 'refused', why: 'the expedition has finished' };
      const refused = await act();
      return typeof refused === 'string' ? { t: 'refused', why: refused } : { t: 'done' };
    });
  }

  /** Drop this kernel as a crash would: kill the plan process, stop listening, write nothing more.
   * A task in flight stops at its next append. The executor and the directory are untouched. */
  async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.unsubscribe();
    this.disarm();
    await this.stopPlan();
    await this.tail.catch(() => {});
    await this.store.close();
  }

  // ---- the queue ----

  /** Run `task` alone, then re-derive what follows from the new state (`afterChange`). */
  serial<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.detached) throw new Detached();
      const out = await task();
      await this.afterChange();
      return out;
    });
    this.tail = run.catch((e: unknown) => {
      if (!(e instanceof Detached)) this.fault(`kernel: ${(e as Error).stack ?? String(e)}`);
    });
    return run;
  }
  private enqueue(task: () => unknown): void {
    this.serial(task).catch(() => {});
  }

  /** The one write path: validated by the fold first, durable before anything acts on it. */
  async append(body: Body): Promise<void> {
    if (this.detached) throw new Detached();
    const entry = keyed.Entry.parse({ ...body, at: this.deps.clock.now().toISOString() });
    const next = step(this.current, entry, this.log.length);
    await this.store.append(entry);
    this.log.push(entry);
    this.current = next;
    for (const l of this.listeners) l(entry, next);
  }

  fault(what: string): void {
    this.faultList.push({ at: this.deps.clock.now().toISOString(), what });
  }

  planDir(version: number): string {
    return this.store.planDir(version);
  }
  version(): number {
    const plan = this.current.plan;
    if (plan.t === 'unplanned') throw new Error('no plan yet: launch writes plan 0');
    return plan.version;
  }

  // ---- asking for a call: reconcile by key ----

  /** The host's own call (a leader wake, a done verdict): resolves when it settles. */
  hostCall(build: (s: State) => keyed.Call): Promise<Delivery> {
    return new Promise((deliver) => {
      this.enqueue(() => this.request(build(this.current), { deliver, alive: () => true }));
    });
  }

  private async request(call: keyed.Call, asker: Asker): Promise<void> {
    for (const r of this.current.calls.get(call.key)?.values() ?? [])
      if (r.call.t !== call.t) {
        const why = `${call.key} has kind ${r.call.t}; a ${call.t} call cannot reuse its key`;
        this.fault(why);
        return asker.deliver({ t: 'outcome', outcome: { t: 'errored', why } });
      }
    await this.consider(call, asker);
  }

  /** Declare the call under the current plan if the log does not already (or it should re-attach
   * a draining run), then act on what `decide` says. */
  private async consider(call: keyed.Call, asker: Asker): Promise<void> {
    const hash = hashOf(call);
    const known = lookup(this.current, call.key, hash);
    const declare =
      known.t === 'unknown' ||
      known.record.declaredIn < this.version() ||
      (known.record.status.t === 'draining' && rivalOf(this.current, call.key, hash).t === 'none');
    if (declare) await this.append({ t: 'declared', call, hash, planVersion: this.version() });
    const d = decide(this.current, call, hash, this.deps.clock.now());
    await (DECIDED[d.t] as Act<Decision['t']>)(this, { call, hash, asker }, d);
  }

  awaitSettle(key: keyed.Key, hash: keyed.Hash, deliver: Deliver): void {
    const ref = keyed.refOf(key, hash);
    this.waiters.set(ref, [...(this.waiters.get(ref) ?? []), deliver]);
  }
  wait(call: keyed.Call, asker: Asker): void {
    this.waiting.push({ call, asker });
  }

  /** `started` is durable before the run is asked for (R1). */
  async start(
    call: keyed.Call,
    hash: keyed.Hash,
    asker: Asker,
    reserved: keyed.Reservation
  ): Promise<void> {
    const found = lookup(this.current, call.key, hash);
    if (found.t === 'unknown') throw new Error(`${call.key} was decided before it was declared`);
    const runId = runIdOf(this.id, call.key, hash, found.record.attempt, 'producer');
    await this.append({ t: 'started', key: call.key, hash, runId, reserved });
    this.awaitSettle(call.key, hash, asker.deliver);
    this.launchRun(call, hash, runId);
  }
  private launchRun(call: keyed.Call, hash: keyed.Hash, runId: string): void {
    const run = producerRun(call);
    if (run.t === 'executor') this.effect(this.deps.executor.start(runId, run.spec));
    else void this.runWake(run.call, hash, runId);
  }

  /** Cancel a run, once per kernel life; a `cancelling` call's cancel is re-derived from the log
   * after every change, so a restart sends it again. */
  cancelRun(runId: string): void {
    if (this.cancelSent.has(runId)) return;
    this.cancelSent.add(runId);
    this.effect(this.deps.executor.cancel(runId));
  }
  /** An executor call issued after the entry that licenses it; a failure is a fault. */
  effect(p: Promise<void>): void {
    p.catch((e: unknown) => this.fault(`executor: ${(e as Error).message}`));
  }

  // ---- settling ----

  /** Every settlement goes through here: append, close both run ids of the attempt, answer whoever
   * waits, and wake the leader once for a drained call. */
  async settle(
    key: keyed.Key,
    hash: keyed.Hash,
    outcome: keyed.Outcome,
    spent: keyed.Usage
  ): Promise<void> {
    const found = lookup(this.current, key, hash);
    if (found.t === 'unknown') throw new Error(`${key}@${hash} settled before it was declared`);
    const { attempt, status } = found.record;
    await this.append({ t: 'settled', key, hash, outcome, spent });
    for (const role of ['producer', 'judge'] as const)
      this.effect(this.deps.executor.close(runIdOf(this.id, key, hash, attempt, role)));
    const ref = keyed.refOf(key, hash);
    const waiting = this.waiters.get(ref) ?? [];
    this.waiters.delete(ref);
    for (const deliver of waiting) deliver({ t: 'outcome', outcome });
    if (status.t === 'draining') this.wakeOnce({ t: 'drained', key });
  }

  /** A raw run ended. Only the run a live call is waiting on counts; anything else is a late or
   * duplicate report (a closed attempt, a status already read at boot). */
  async runEnded(runId: string, raw: RawOutcome, spent: keyed.Usage): Promise<void> {
    const live = liveCalls(this.current).find((c) => currentRunId(c.status) === runId);
    if (!live) return;
    const stage = stageOf(live.status);
    const ending = endingOf(profileOf(live.call), {
      ref: keyed.refOf(live.key, live.hash),
      raw,
      spent: stage.t === 'judging' ? addUsage(stage.spent, spent) : spent,
      cancelling: live.status.t === 'cancelling',
      stage,
    });
    await (ENDED[ending.t] as (e: Expedition, c: LiveCall, x: Ending) => Promise<void>)(
      this,
      live,
      ending
    );
  }
  async produced(c: LiveCall, out: unknown, spent: keyed.Usage): Promise<void> {
    const ref = keyed.refOf(c.key, c.hash);
    const judgeRunId = runIdOf(this.id, c.key, c.hash, c.attempt, 'judge');
    await this.append({ t: 'produced', key: c.key, hash: c.hash, ref, out, judgeRunId, spent });
    this.effect(this.deps.executor.start(judgeRunId, judgeRunOf(c.call, ref)));
  }

  /** A leader wake runs outside the queue; its answer settles its `leader/<n>` call. `runId` is
   * the one `started` logged, so a real leader turn is keyed by it (a restart re-derives the same
   * id) and the settle below closes it like any run. */
  private async runWake(call: keyed.LeaderCall, hash: keyed.Hash, runId: string): Promise<void> {
    const settle = (outcome: keyed.Outcome, spent: keyed.Usage) =>
      this.enqueue(() => this.settle(call.key, hash, outcome, spent));
    try {
      const woken = await this.deps.leader.wake(runId, call.event, this.view());
      settle({ t: 'passed', ref: keyed.refOf(call.key, hash), out: woken.act }, woken.spent);
    } catch (e) {
      settle(
        { t: 'errored', why: `the leader's wake failed: ${(e as Error).message}` },
        { t: 'unreported' }
      );
    }
  }

  // ---- after every change ----

  private async afterChange(): Promise<void> {
    if (this.detached) return;
    for (const c of liveCalls(this.current))
      if (c.status.t === 'cancelling' && producerRun(c.call).t === 'executor')
        this.cancelRun(currentRunId(c.status));
    const pending = this.waiting;
    this.waiting = [];
    for (const w of pending) if (w.asker.alive()) await this.consider(w.call, w.asker);
    this.budgetMarks();
    await this.checkDue();
  }

  private budgetMarks(): void {
    const s = this.current;
    if (s.progress.t === 'finished') return;
    for (const percent of [50, 80] as const)
      if (s.spentUsd >= (s.contract.budget.usd * percent) / 100)
        this.wakeOnce({ t: 'budget-mark', percent });
  }
  /** Wake the leader for `event` unless a wake for it is already in the log. */
  private wakeOnce(event: keyed.BaseWake): void {
    const seen = canonicalJson(event);
    for (const byHash of this.current.calls.values())
      for (const r of byHash.values())
        if (r.call.t === 'leader' && canonicalJson(r.call.event) === seen) return;
    this.change.wake(event);
  }

  /** The deadline and the budget (core/finish.ts): cut off what may not run on, and finish once
   * judges and asks are done and the plan has nothing in flight it could still act on. */
  private async checkDue(): Promise<void> {
    const now = this.deps.clock.now();
    if (this.current.progress.t === 'finished') return;
    for (const c of cutOff(this.current, now)) this.cancelRun(currentRunId(c.status));
    const d = due(this.current, now);
    if (d.t === 'no' || this.change.ending) return;
    const settledPlan = this.proc.t === 'none' || this.proc.p.settled();
    if (settledPlan) await this.finish(FINISH_OF_DUE[d.t]);
  }

  /** Only the host writes `finished` (I5). Producers still running are cancelled and wind down;
   * judges, verdicts and asks finish. */
  async finish(reason: keyed.Finish): Promise<void> {
    if (this.current.progress.t === 'finished') return;
    await this.append({ t: 'finished', reason });
    void this.stopPlan();
    for (const c of liveCalls(this.current))
      if (CUT_AT_DEADLINE[c.call.t] && stageOf(c.status).t === 'producing')
        this.cancelRun(currentRunId(c.status));
    this.resolveFinished(reason);
  }

  private armDeadline(): void {
    this.disarm();
    this.disarm = this.deps.clock.wakeAt(new Date(this.current.deadlineMs), () =>
      this.enqueue(() => {})
    );
  }

  // ---- retry ----

  /** Reopen the newest settled `errored`, `cancelled` or `refused` attempt of each key as its next
   * attempt, then re-run the plan so it asks again. All or nothing. */
  async retryKeys(keys: readonly keyed.Key[], by: string): Promise<OwnerResult> {
    if (this.current.progress.t === 'finished')
      return { t: 'refused', why: 'the expedition has finished' };
    type Found = { t: 'retriable'; key: keyed.Key; hash: keyed.Hash } | { t: 'not'; why: string };
    const found = keys.map((key): Found => {
      const records = [
        ...(this.current.calls.get(key) ?? new Map<keyed.Hash, CallRecord>()).entries(),
      ].sort(([, a], [, b]) => b.declaredIn - a.declaredIn);
      const newest = records[0];
      if (!newest) return { t: 'not', why: `${key} was never asked for` };
      const [hash, r] = newest;
      if (r.status.t !== 'settled')
        return { t: 'not', why: `${key} is ${r.status.t}, not settled` };
      if (!RETRIABLE[r.status.outcome.t])
        return {
          t: 'not',
          why: `${key} ${r.status.outcome.t}: it has a result, so a retry would rebuy it`,
        };
      return { t: 'retriable', key, hash };
    });
    const refused = found.flatMap((f) => (f.t === 'not' ? [f.why] : []));
    if (refused.length > 0) return { t: 'refused', why: refused.join('; ') };
    for (const f of found)
      if (f.t === 'retriable') await this.append({ t: 'retried', key: f.key, hash: f.hash, by });
    this.restartPlan(this.version());
    return { t: 'done' };
  }

  // ---- the plan process ----

  private startPlan(version: number): void {
    this.proc = {
      t: 'running',
      p: new PlanProcess(this.planHost, version, this.store.planDir(version)),
    };
  }
  private async stopPlan(): Promise<void> {
    const proc = this.proc;
    this.proc = { t: 'none' };
    if (proc.t === 'running') await proc.p.kill();
  }
  /** Kill the plan process and run `version` from the top: every call it re-issues is answered from
   * the log. The old process's answers and waits die with it. */
  restartPlan(version: number): void {
    void this.stopPlan();
    this.startPlan(version);
  }
  /** The leader continued at `question`: let the plan past it. */
  answerReview(question: string): void {
    if (this.proc.t === 'running') this.proc.p.answerReview(question);
  }
  private readonly planHost: PlanHost = {
    enqueue: (task) => this.enqueue(task),
    request: (call, asker) => this.request(call, asker),
    canonCtx: (version) => ({
      contract: this.current.contract,
      folder: this.store.planDir(version),
      providerOf: this.deps.providerOf,
    }),
    fault: (what) => this.fault(what),
    continued: (version, question) =>
      this.log.some(
        (e) =>
          e.t === 'review' &&
          e.planVersion === version &&
          e.question === question &&
          e.decision === 'continue'
      ),
    wakeReview: (question) => this.change.wake({ t: 'review', question }),
    ended: (end) => PLAN_END[end.t](this.change, end as never),
  };
}

// ---- dispatch tables ----

type Asking = { readonly call: keyed.Call; readonly hash: keyed.Hash; readonly asker: Asker };
type Act<K extends Decision['t']> = (
  e: Expedition,
  a: Asking,
  d: Extract<Decision, { t: K }>
) => Promise<void> | void;
/** What the host does with each decision. Thin: each row is one effect. */
const DECIDED: { [K in Decision['t']]: Act<K> } = {
  reuse: (_e, a, d) => a.asker.deliver({ t: 'outcome', outcome: d.outcome }),
  attach: (e, a) => e.awaitSettle(a.call.key, a.hash, a.asker.deliver),
  start: (e, a, d) => e.start(a.call, a.hash, a.asker, d.reservation),
  wait: (e, a) => e.wait(a.call, a.asker),
  replace: (e, a, d) => {
    e.cancelRun(d.cancel.runId);
    e.wait(a.call, a.asker);
  },
  refuse: async (e, a, d) => {
    e.awaitSettle(a.call.key, a.hash, a.asker.deliver);
    await e.settle(
      a.call.key,
      a.hash,
      { t: 'refused', reason: d.reason },
      { t: 'reported', usd: 0 }
    );
  },
  closed: (_e, a, d) => a.asker.deliver({ t: 'closed', reason: d.reason }),
};

const ENDED: {
  [K in Ending['t']]: (e: Expedition, c: LiveCall, x: Extract<Ending, { t: K }>) => Promise<void>;
} = {
  settle: (e, c, x) => e.settle(c.key, c.hash, x.outcome, x.spent),
  produce: (e, c, x) => e.produced(c, x.out, x.spent),
  fault: async (e, c, x) => e.fault(`${c.key}: ${x.why}`),
};

const PLAN_END: { [K in PlanEnd['t']]: (c: Change, end: Extract<PlanEnd, { t: K }>) => void } = {
  candidate: (c, end) => c.evaluate(end.ref),
  gap: (c, end) => c.wake({ t: 'ended-unmet', gaps: [end.why] }),
  threw: (c, end) => c.wake({ t: 'stuck', why: `the plan threw: ${end.message}` }),
  crashed: (c, end) =>
    c.wake({
      t: 'stuck',
      why: `the plan process exited (${end.exit.t === 'code' ? `code ${end.exit.code}` : end.exit.signal}): ${end.stderr.slice(-500)}`,
    }),
  killed: () => {},
};

export { launch, open } from './launch';
