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
import { ContextRegistry, type ExpeditionContext } from './context';
import { type HostRun, runCheck, runCommand } from './host-run';
import { type RunRecord, type Running, readRecord, writeRecord } from './records';

// The kernel's Executor port over the host (CONNECT_PLAN §1). Every run has one durable record
// (records.ts); every operation on one run id is serialized, reads that record first and acts on
// what it says, so `start` is idempotent on the id, a closed id never starts, and `status`
// answers from disk across restarts. What runs is chosen by one table over the run's kind; the
// kinds that need a Buddy (agent, review) or the owner (ask) are later steps and settle as a
// typed `errored("not implemented: <kind>")` meanwhile, never a silent no-op.
// One HostExecutor per data root per process: a `running` record whose host pid is not this
// process is a dead host's, and is settled `errored` (D6) with its process group killed.
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys): the run id is the key.

export type HostExecutorDeps = {
  /** The kernel's data root: each expedition is `<root>/<id>`. */
  readonly root: string;
  /** For `~` in `contract.repo`. */
  readonly home: string;
  readonly clock: Clock;
};

type Listener = (runId: string, outcome: RawOutcome, spent: keyed.Usage) => void;
/** A host run costs no dollars. */
const FREE: keyed.Usage = { t: 'reported', usd: 0 };
const RESTARTED: RawOutcome = { t: 'errored', why: 'host restarted during command' };

/** One run, as a handler gets it. */
type Begin<K extends RunSpec['t']> = {
  readonly address: RunAddress;
  readonly ctx: ExpeditionContext;
  readonly paths: RunPaths;
  readonly spec: Extract<RunSpec, { t: K }>;
};
type Handler<K extends RunSpec['t']> = (ex: HostExecutor, run: Begin<K>) => Promise<void>;
type Located = Omit<Begin<RunSpec['t']>, 'spec'>;
type OnDisk = RunRecord | { readonly t: 'missing' };
type Last = Extract<RunRecord, { t: 'closed' }>['last'];
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

  constructor(private readonly deps: HostExecutorDeps) {
    this.contexts = new ContextRegistry(deps.root, deps.home);
  }

  // ---- the port ----

  start(runId: string, spec: RunSpec): Promise<void> {
    return this.serial(runId, async () => {
      const at = await this.locate(runId);
      const found = await readRecord(at.paths.record);
      // Any record means this id was started or closed before: a repeat or a late start.
      if (found.t === 'found') return;
      await (HANDLERS[spec.t] as Handler<RunSpec['t']>)(this, { ...at, spec });
    });
  }

  cancel(runId: string): Promise<void> {
    return this.serial(runId, async () => {
      const at = await this.locate(runId);
      const found = await readRecord(at.paths.record);
      if (found.t === 'found' && found.value.t === 'running') await this.stop(at, found.value);
    });
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
      const r = found.value;
      const record = r.t === 'running' && this.isOrphan(r) ? await this.reap(at, r) : r;
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
    });
    this.emit(run.address.runId, raw, FREE);
  }

  // ---- internals ----

  private async locate(runId: string): Promise<Located> {
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
      await writeRecord(paths.record, { ...kept, t: 'settled', raw, spent: FREE });
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
  /** Stop a running run: a dead host's is reaped, this host's is aborted (its settle then finds
   * the tombstone and reports nothing). What it settled as, if it did. */
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
  private async reap(at: Located, r: Running): Promise<Extract<RunRecord, { t: 'settled' }>> {
    await killIfSameLeader(r.process);
    await removeTree(at.ctx.repo, r.tree);
    const { host: _host, process: _process, ...kept } = r;
    const settled = { ...kept, t: 'settled', raw: RESTARTED, spent: FREE } as const;
    await writeRecord(at.paths.record, settled);
    return settled;
  }

  private emit(runId: string, raw: RawOutcome, spent: keyed.Usage): void {
    for (const l of this.listeners) l(runId, raw, spent);
  }

  /** One operation per run id at a time, in call order. */
  private serial<T>(runId: string, task: () => Promise<T>): Promise<T> {
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

/** What runs each kind. Agent runs, reviews and asks need a Buddy or the owner: later steps. */
const HANDLERS: { [K in RunSpec['t']]: Handler<K> } = {
  command: (ex, run) =>
    ex.hostRun(run, run.spec.call.maxMinutes, (h) => runCommand(h, run.spec.call)),
  check: (ex, run) => ex.hostRun(run, run.spec.maxMinutes, (h) => runCheck(h, run.spec)),
  agent: notImplemented(),
  review: notImplemented(),
  ask: notImplemented(),
};

/** Closing an id, by what its record says: afterwards nothing runs or reports under it. */
const CLOSE: { [K in OnDisk['t']]: Close<K> } = {
  missing: async () => ({ t: 'never-settled' }),
  running: (ex, at, r) => ex.stop(at, r),
  settled: async (_ex, _at, r) => ({ t: 'settled', raw: r.raw, spent: r.spent }),
  closed: async () => ({ t: 'already-closed' }),
};

const STATUS: { [K in RunRecord['t']]: (r: Extract<RunRecord, { t: K }>) => RunStatus } = {
  running: () => ({ t: 'running' }),
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

async function removeTree(repo: string, tree: Running['tree']): Promise<void> {
  if (tree.t === 'none') return;
  await exec('git', repo, ['worktree', 'remove', '--force', tree.path]);
  await rm(tree.path, { recursive: true, force: true });
  await exec('git', repo, ['worktree', 'prune']);
}
