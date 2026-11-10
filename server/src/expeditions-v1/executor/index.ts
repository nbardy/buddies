import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import type { keyed } from '@unleashd/shared';
import type {
  Clock,
  Executor,
  RawOutcome,
  RunSpec,
  RunStatus,
} from '../../expedition-kernel/ports';
import { exec } from '../../expeditions/cambium';
import { type RunAddress, type RunPaths, parseRunId, runPaths } from './address';
import {
  type BuddyCallDeps,
  BuddyCalls,
  type Calls,
  type ExecutorSide,
  type Located,
  NoCalls,
} from './calls';
import { ContextRegistry, type ExpeditionContext } from './context';
import { type HostRun, runCheck, runCommand } from './host-run';
import {
  type Last,
  type RunRecord,
  type Running,
  type Tree,
  readRecord,
  writeRecord,
} from './records';

// The kernel's Executor port over the host (CONNECT_PLAN §1). Every run has one durable record
// (records.ts); every operation on one run id is serialized, reads that record first and acts on
// what it says, so `start` is idempotent on the id, a closed id never starts, and `status`
// answers from disk across restarts. What runs is chosen by one table over the run's kind:
// commands and checks run on the host (host-run.ts), agent calls and review judges are Buddy
// requests (calls.ts), and asks (the owner's, a later step) settle as a typed
// `errored("not implemented: ask")` meanwhile, never a silent no-op.
// One HostExecutor per data root per process: a `running` record whose host pid is not this
// process is a dead host's, and is settled `errored` (D6) with its process group killed.
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys): the run id is the key.

/** Who runs the Buddy-backed kinds: the Buddy server's core, or nobody (a host-only test). */
export type CallHost =
  | { readonly t: 'buddies'; readonly deps: BuddyCallDeps }
  | { readonly t: 'none'; readonly why: string };

export type HostExecutorDeps = {
  /** The kernel's data root: each expedition is `<root>/<id>`. */
  readonly root: string;
  /** For `~` in `contract.repo`. */
  readonly home: string;
  readonly clock: Clock;
  readonly calls: CallHost;
};

type Listener = (runId: string, outcome: RawOutcome, spent: keyed.Usage) => void;
/** A host run costs no dollars. */
const FREE: keyed.Usage = { t: 'reported', usd: 0 };
const RESTARTED: RawOutcome = { t: 'errored', why: 'host restarted during command' };
/** A host run's record: its stop is its process's end, not a recorded `stop`. */
const NOT_STOPPED = { t: 'none' } as const;

/** One run, as a handler gets it. */
type Begin<K extends RunSpec['t']> = {
  readonly address: RunAddress;
  readonly ctx: ExpeditionContext;
  readonly paths: RunPaths;
  readonly spec: Extract<RunSpec, { t: K }>;
};
type Handler<K extends RunSpec['t']> = (ex: HostExecutor, run: Begin<K>) => Promise<void>;
type OnDisk = RunRecord | { readonly t: 'missing' };
type Close<K extends OnDisk['t']> = (
  ex: HostExecutor,
  at: Located,
  r: Extract<OnDisk, { t: K }>
) => Promise<Last | { readonly t: 'already-closed' }>;

export class HostExecutor implements Executor {
  private readonly listeners = new Set<Listener>();
  /** Runs this process started and has not settled: the means to stop each. */
  private readonly live = new Map<string, AbortController>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly contexts: ContextRegistry;
  /** The agent and review kinds. */
  readonly calls: Calls;

  constructor(private readonly deps: HostExecutorDeps) {
    this.contexts = new ContextRegistry(deps.root, deps.home);
    const side: ExecutorSide = {
      root: deps.root,
      clock: deps.clock,
      serial: (runId, task) => this.serial(runId, task),
      emit: (runId, raw, spent) => this.emit(runId, raw, spent),
      locate: (runId) => this.locate(runId),
    };
    this.calls = CALL_HOSTS[deps.calls.t](side, deps.calls as never);
  }

  // ---- the port ----

  start(runId: string, spec: RunSpec): Promise<void> {
    return this.serial(runId, async () => {
      const at = await this.locate(runId);
      const found = await readRecord(at.paths.record);
      if (found.t === 'missing')
        return (HANDLERS[spec.t] as Handler<RunSpec['t']>)(this, { ...at, spec });
      // Any record means this id was started or closed before: a repeat or a late start. A call
      // whose post a crash interrupted is finished now, under the same key.
      if (found.value.t === 'posting') await this.calls.current(at, found.value);
    });
  }

  cancel(runId: string): Promise<void> {
    return this.serial(runId, async () => {
      const at = await this.locate(runId);
      const found = await readRecord(at.paths.record);
      if (found.t === 'missing') return;
      await (CANCEL[found.value.t] as Cancel<RunRecord['t']>)(this, at, found.value);
    });
  }

  /** Observe the Buddy calls (CONNECT_PLAN §1 "Observing settlement"): every live one on disk,
   * then events, a 60 s backstop and the usage poll. Returns the stop. */
  watch(): Promise<() => void> {
    return this.calls.watch();
  }

  close(runId: string): Promise<void> {
    return this.serial(runId, async () => {
      const at = await this.locate(runId);
      const found = await readRecord(at.paths.record);
      const state: OnDisk = found.t === 'found' ? found.value : { t: 'missing' };
      const last = await (CLOSE[state.t] as Close<OnDisk['t']>)(this, at, state);
      if (last.t !== 'already-closed')
        await writeRecord(at.paths.record, { t: 'closed', runId, last });
    });
  }

  status(runId: string): Promise<RunStatus> {
    return this.serial(runId, async () => {
      const at = await this.locate(runId);
      const found = await readRecord(at.paths.record);
      if (found.t === 'missing') return { t: 'unknown' };
      const record = await (CURRENT[found.value.t] as Current<RunRecord['t']>)(
        this,
        at,
        found.value
      );
      return STATUS[record.t](record as never);
    });
  }

  onSettled(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- for the handlers ----

  /** A run the host does itself: record it, start it, settle it when it ends. Returns once the
   * `running` record is durable; the work goes on after. */
  async hostRun<K extends RunSpec['t']>(
    run: Begin<K>,
    minutes: number,
    work: (h: HostRun) => Promise<RawOutcome>
  ): Promise<void> {
    const { runId } = run.address;
    const deadlineAt = new Date(this.deps.clock.now().getTime() + minutes * 60_000).toISOString();
    await writeRecord(run.paths.record, {
      t: 'running',
      runId,
      kind: run.spec.t,
      deadlineAt,
      tree: { t: 'detached', path: run.paths.tree },
      host: { pid: process.pid },
      process: { t: 'starting' },
    });
    const abort = new AbortController();
    this.live.set(runId, abort);
    const h: HostRun = {
      address: run.address,
      ctx: run.ctx,
      paths: run.paths,
      signal: abort.signal,
      onSpawn: (pid) => void this.spawned(run.paths, runId, pid),
    };
    void work(h)
      .catch((e: unknown): RawOutcome => ({ t: 'errored', why: (e as Error).message }))
      .then((raw) => this.settle(run.paths, runId, raw));
  }

  /** A kind with no handler yet: settled at once, durably, so it is not re-run either. */
  async notImplemented<K extends RunSpec['t']>(run: Begin<K>): Promise<void> {
    const raw: RawOutcome = { t: 'errored', why: `not implemented: ${run.spec.t}` };
    await writeRecord(run.paths.record, {
      t: 'settled',
      runId: run.address.runId,
      kind: run.spec.t,
      deadlineAt: this.deps.clock.now().toISOString(),
      tree: { t: 'none' },
      raw,
      spent: FREE,
      stop: NOT_STOPPED,
    });
    this.emit(run.address.runId, raw, FREE);
  }

  // ---- internals ----

  async locate(runId: string): Promise<Located> {
    const address = parseRunId(runId);
    const ctx = await this.contexts.get(address.expedition);
    return { address, ctx, paths: runPaths(ctx.dir, runId) };
  }

  private settle(paths: RunPaths, runId: string, raw: RawOutcome): Promise<void> {
    return this.serial(runId, async () => {
      this.live.delete(runId);
      const found = await readRecord(paths.record);
      // Closed meanwhile (the kernel settled the call): nothing may report under it.
      if (found.t === 'missing' || found.value.t !== 'running') return;
      const { host: _host, process: _process, ...kept } = found.value;
      await writeRecord(paths.record, {
        ...kept,
        t: 'settled',
        raw,
        spent: FREE,
        stop: NOT_STOPPED,
      });
      this.emit(runId, raw, FREE);
    }).catch(() => {
      // The record could not be written: the run stays `running` on disk and the next boot
      // settles it `errored`. Nothing is reported that is not durable.
    });
  }

  /** The process group exists: record it with its leader's start time (see records.ts). */
  private async spawned(paths: RunPaths, runId: string, pid: number): Promise<void> {
    const leaderStart = await startTimeOf(pid);
    if (leaderStart.t === 'gone') return; // it already exited; the settle follows
    await this.serial(runId, async () => {
      const found = await readRecord(paths.record);
      if (found.t !== 'found' || found.value.t !== 'running') return;
      await writeRecord(paths.record, {
        ...found.value,
        process: { t: 'spawned', pgid: pid, leaderStart: leaderStart.lstart },
      });
    }).catch(() => {});
  }

  isOrphan(r: Running): boolean {
    return r.host.pid !== process.pid;
  }
  /** Stop a running host run: a dead host's is reaped, this host's is aborted (its settle then
   * finds the tombstone and reports nothing). What it settled as, if it did. */
  async stop(at: Located, r: Running): Promise<Last> {
    if (!this.isOrphan(r)) {
      this.live.get(r.runId)?.abort();
      return { t: 'never-settled' };
    }
    const reaped = await this.reap(at, r);
    return { t: 'settled', raw: reaped.raw, spent: reaped.spent };
  }

  /** A dead host's run (D6): kill its process group while the same leader runs, remove its tree,
   * settle it `errored`. A retry is the owner's or the leader's, explicitly. */
  async reap(at: Located, r: Running): Promise<Extract<RunRecord, { t: 'settled' }>> {
    await killIfSameLeader(r.process);
    await removeTree(at.ctx.repo, r.tree);
    const { host: _host, process: _process, ...kept } = r;
    const settled = {
      ...kept,
      t: 'settled',
      raw: RESTARTED,
      spent: FREE,
      stop: NOT_STOPPED,
    } as const;
    await writeRecord(at.paths.record, settled);
    return settled;
  }

  emit(runId: string, raw: RawOutcome, spent: keyed.Usage): void {
    for (const l of this.listeners) l(runId, raw, spent);
  }

  /** One operation per run id at a time, in call order. */
  serial<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    this.queues.set(runId, tail);
    void tail.then(() => {
      if (this.queues.get(runId) === tail) this.queues.delete(runId);
    });
    return run;
  }
}

// ---- tables ----

const notImplemented =
  <K extends RunSpec['t']>(): Handler<K> =>
  (ex, run) =>
    ex.notImplemented(run);

/** What runs each kind. Asks need the owner: a later step. */
const HANDLERS: { [K in RunSpec['t']]: Handler<K> } = {
  command: (ex, run) =>
    ex.hostRun(run, run.spec.call.maxMinutes, (h) => runCommand(h, run.spec.call)),
  check: (ex, run) => ex.hostRun(run, run.spec.maxMinutes, (h) => runCheck(h, run.spec)),
  agent: (ex, run) => ex.calls.start(run, run.spec),
  review: (ex, run) => ex.calls.start(run, run.spec),
  ask: notImplemented(),
};

const CALL_HOSTS: {
  [K in CallHost['t']]: (side: ExecutorSide, host: Extract<CallHost, { t: K }>) => Calls;
} = {
  buddies: (side, host) => new BuddyCalls(side, host.deps),
  none: (side, host) => new NoCalls(side, host.why),
};

/** A record as it stands now: a dead host's run is reaped, a call's post is finished. */
type Current<K extends RunRecord['t']> = (
  ex: HostExecutor,
  at: Located,
  r: Extract<RunRecord, { t: K }>
) => Promise<RunRecord>;
const CURRENT: { [K in RunRecord['t']]: Current<K> } = {
  running: async (ex, at, r) => (ex.isOrphan(r) ? ex.reap(at, r) : r),
  posting: (ex, at, r) => ex.calls.current(at, r),
  posted: (ex, at, r) => ex.calls.current(at, r),
  settled: async (_ex, _at, r) => r,
  closed: async (_ex, _at, r) => r,
};

type Cancel<K extends RunRecord['t']> = (
  ex: HostExecutor,
  at: Located,
  r: Extract<RunRecord, { t: K }>
) => Promise<void>;
const ended = async () => {};
/** Cancelling a run, by its record. A settled or closed one has nothing left to stop. */
const CANCEL: { [K in RunRecord['t']]: Cancel<K> } = {
  running: async (ex, at, r) => {
    await ex.stop(at, r);
  },
  posting: (ex, at, r) => ex.calls.cancel(at, r),
  posted: (ex, at, r) => ex.calls.cancel(at, r),
  settled: ended,
  closed: ended,
};

/** Closing an id, by what its record says: afterwards nothing runs or reports under it. */
const CLOSE: { [K in OnDisk['t']]: Close<K> } = {
  missing: async () => ({ t: 'never-settled' }),
  running: (ex, at, r) => ex.stop(at, r),
  posting: (ex, at, r) => ex.calls.close(at, r),
  posted: (ex, at, r) => ex.calls.close(at, r),
  settled: async (_ex, _at, r) => ({ t: 'settled', raw: r.raw, spent: r.spent }),
  closed: async () => ({ t: 'already-closed' }),
};

const STATUS: { [K in RunRecord['t']]: (r: Extract<RunRecord, { t: K }>) => RunStatus } = {
  running: () => ({ t: 'running' }),
  posting: () => ({ t: 'running' }),
  posted: () => ({ t: 'running' }),
  settled: (r) => ({ t: 'settled', outcome: r.raw, spent: r.spent }),
  // Only a settled call's ids are closed, so the kernel does not ask about one; if it does, the
  // truthful answer is the outcome it settled with, or that it was stopped before it could run.
  closed: (r) =>
    r.last.t === 'settled'
      ? { t: 'settled', outcome: r.last.raw, spent: r.last.spent }
      : { t: 'settled', outcome: { t: 'cancelled' }, spent: FREE },
};

// ---- processes and trees ----

type StartTime = { readonly t: 'running'; readonly lstart: string } | { readonly t: 'gone' };
/** `ps -o lstart=` under the C locale, so a later host reads the same text for the same process. */
function startTimeOf(pid: number): Promise<StartTime> {
  return new Promise((resolve) =>
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 10_000 },
      (error, stdout) => {
        const lstart = stdout.trim();
        resolve(error || lstart === '' ? { t: 'gone' } : { t: 'running', lstart });
      }
    )
  );
}

async function killIfSameLeader(p: Running['process']): Promise<void> {
  if (p.t === 'starting') return;
  const now = await startTimeOf(p.pgid);
  if (now.t === 'gone' || now.lstart !== p.leaderStart) return;
  try {
    process.kill(-p.pgid, 'SIGKILL');
  } catch {} // ESRCH: the group ended between the check and the kill
}

/** A dead host run's tree. Only a host run (command, check) is reaped, and its tree is detached;
 * a call's directory or checkout is the call's to end (calls.ts), so it is left as it is. */
const REMOVE_TREE: {
  [K in Tree['t']]: (repo: string, tree: Extract<Tree, { t: K }>) => Promise<void>;
} = {
  none: async () => {},
  dir: async () => {},
  checkout: async () => {},
  detached: async (repo, tree) => {
    await exec('git', repo, ['worktree', 'remove', '--force', tree.path]);
    await rm(tree.path, { recursive: true, force: true });
    await exec('git', repo, ['worktree', 'prune']);
  },
};
const removeTree = (repo: string, tree: Tree): Promise<void> =>
  REMOVE_TREE[tree.t](repo, tree as never);
