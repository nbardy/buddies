import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TurnCapabilities, TurnGit } from '@nbardy/agent-cli';
import type { Run, RunConfig } from '@unleashd/buddies-core';
import type { InstalledAgent, keyed } from '@unleashd/shared';
import { profileExecution } from '../../buddies/briefing';
import { type BuddiesCore, OWNER, buddyActor, coreError } from '../../buddies/core';
import { type BuddyEvents, announcePost } from '../../buddies/events';
import type { ExecutionGate } from '../../buddies/execution-gate';
import { EXPEDITION_CALL_PURPOSE, EXPEDITION_RUN_EVIDENCE } from '../../buddies/expedition-calls';
import { checkedRunConfig } from '../../buddies/worker-config';
import { type CallTurn, capabilitiesOf, limitsText, readsOf } from '../../expedition-kernel/access';
import type { Clock, RawOutcome, RunSpec } from '../../expedition-kernel/ports';
import { add, git, release, tip } from '../../expeditions/cambium';
import { addDetachedTree, removeDetachedTree } from '../../expeditions/checks';
import { labelled } from '../../observability/event-loop-stall';
import { observeBuddyEvents } from '../observe';
import { type RunAddress, type RunPaths, parseRunId, runPaths } from './address';
import { readAnswer } from './answer';
import type { ExpeditionContext } from './context';
import { commitOf } from './host-run';
import { keepPrompt } from './prompts';
import {
  type Expected,
  type Last,
  type Posted,
  type Posting,
  type RecordKind,
  type RunOn,
  type RunRecord,
  type SettledRecord,
  type Stop,
  type Tree,
  readRecord,
  recordsUnder,
  writeRecord,
} from './records';
import { type RefRecord, getRef, putRef } from './refs';
import { type NamedRef, agentBody, reviewBody } from './request';
import { Seats } from './seat';
import { NOTHING, type UsageMeter } from './usage';

// Agent calls, review judges and leader wakes as Buddy requests (CONNECT_PLAN §1 step 4, §2). One
// request post per run id, keyed `xk:<runId>`, from a Buddy to itself (a self-DM): the named Buddy
// on its own profile, the workspace's seat Buddy on the call's config (seat.ts), or the contract's
// leader on its profile (a wake: its body is the leader's brief, built by leader.ts). The post carries purpose
// `expedition_call` and evidence `expedition-run:<runId>`, which is how the Buddy server knows the
// turn is a call: it runs in the call's own directory (call-directory.ts) under the tool-less
// `call` grant, and no memory review follows it.
//
//   start:   the prompt file (prompts.ts) → record `posting` (the body, the answer it expects, the
//            tree, the caps, what its turn may do) → tree → post → record `posted`. A crash
//            anywhere replays from the record under the same key.
// What a call's turn may do is decided here, once, by the policy table (expedition-kernel/
// access.ts), and stored in its record; the Buddy server hands it to the harness.
//   observe: the post's request state and its crate runs, read on `changed`/`posted` (debounced),
//            on a 60 s backstop, and on `status`. Terminal = every run settled (no decision-G
//            attempt 2 queued) and the request ended; a request left `awaiting` with every run
//            settled is a cancelled queued run (crate runs.rs cancel_queued, CONNECT_PLAN §0.8).
//   settle:  outcome (the answer parsed and validated, or the stop) → the tree's end (tip, release
//            to a salvage ref) → the ref (before `ok` is reported) → usage → record `settled` →
//            report. Never inside `status`: a settle may wait on ingest, and boot recovery reads
//            every call's status in the kernel's queue.
// Caps are expiries, not cancels: the minutes cap is a labelled timer at `deadlineAt`, re-armed
// whenever the record is observed (a restart's recovery and the watcher's scan both observe it);
// the dollar cap is a 60 s poll. Each is recorded as its `stop`, and the call settles
// `errored("exceeded …")`. Known limit: the crate has no per-request deadline, so the turn itself
// is ended through the cancel path (its run reads "cancelled by request"); the call's own record
// is what says it was an expiry.
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys): the post key is `xk:<runId>`.

export type CallTiming = {
  /** `changed`/`posted` burst → one observation pass. */
  readonly debounceMs: number;
  /** The fallback pass, for a missed event. */
  readonly backstopMs: number;
  /** How often a running call's spend is read against its `max.usd`. */
  readonly usagePollMs: number;
  /** How long a settle waits for ingest to see a call's turns before reporting `unreported`. */
  readonly usageWaitMs: number;
  readonly usageRetryMs: number;
};
export const CALL_TIMING: CallTiming = {
  debounceMs: 1_500,
  backstopMs: 60_000,
  usagePollMs: 60_000,
  usageWaitMs: 60_000,
  usageRetryMs: 2_000,
};

export type BuddyCallDeps = {
  readonly installed: () => InstalledAgent;
  readonly core: BuddiesCore;
  readonly events: BuddyEvents;
  readonly gate: ExecutionGate;
  readonly meter: UsageMeter;
  readonly timing: CallTiming;
  readonly logger: Pick<Console, 'warn'>;
};

/** One run, located. */
export type Located = {
  readonly address: RunAddress;
  readonly ctx: ExpeditionContext;
  readonly paths: RunPaths;
};
/** A leader wake (leader.ts): its body is the leader's brief, its directory the wake's draft
 * folder, its answer one `LeaderAct`, its caps the kernel's `limits.leaderWake`. */
export type LeaderSpec = {
  readonly t: 'leader';
  readonly body: string;
  readonly draft: string;
  readonly max: keyed.Max;
};
export type CallSpec = Extract<RunSpec, { t: 'agent' | 'review' }> | LeaderSpec;
type Call = Posting | Posted;

/** What the executor lends its calls: its per-run queue, its report, where a run lives. */
export interface ExecutorSide {
  readonly root: string;
  readonly clock: Clock;
  serial<T>(runId: string, task: () => Promise<T>): Promise<T>;
  /** A run ended: a kernel run is reported to the kernel, a leader wake to its waiting wake. */
  report(kind: RecordKind, runId: string, raw: RawOutcome, spent: keyed.Usage): void;
  locate(runId: string): Promise<Located>;
}

/** How the executor runs the Buddy-backed kinds. Every method runs inside the run's queue. */
export interface Calls {
  start(at: Located, spec: CallSpec): Promise<void>;
  /** A live call as it stands: a `posting` one is posted first. Never settles (see header). */
  current(at: Located, r: Call): Promise<RunRecord>;
  cancel(at: Located, r: Call): Promise<void>;
  close(at: Located, r: Call): Promise<Last>;
  /** Start observing (events, backstop, usage poll, every live call on disk). Returns the stop. */
  watch(): Promise<() => void>;
}

const errored = (why: string): RawOutcome => ({ t: 'errored', why });

/** A call that cannot start is settled at once, durably, so it is not re-run either. */
export async function settleAtStart(
  side: ExecutorSide,
  at: Located,
  kind: RecordKind,
  raw: RawOutcome
): Promise<void> {
  await writeRecord(at.paths.record, {
    t: 'settled',
    runId: at.address.runId,
    kind,
    deadlineAt: side.clock.now().toISOString(),
    tree: { t: 'none' },
    raw,
    spent: NOTHING,
    stop: { t: 'none' },
  });
  side.report(kind, at.address.runId, raw, NOTHING);
}

/** A host with no Buddies (the step-2 executor tests): a call settles `errored(why)`. */
export class NoCalls implements Calls {
  constructor(
    private readonly side: ExecutorSide,
    private readonly why: string
  ) {}
  start(at: Located, spec: CallSpec): Promise<void> {
    return settleAtStart(this.side, at, spec.t, errored(this.why));
  }
  // A posting or posted record exists only where Buddy calls ran: this host cannot read it.
  current(at: Located): Promise<RunRecord> {
    throw new Error(`${at.address.runId} is a Buddy call, and ${this.why}`);
  }
  cancel(at: Located): Promise<void> {
    throw new Error(`${at.address.runId} is a Buddy call, and ${this.why}`);
  }
  close(at: Located): Promise<Last> {
    throw new Error(`${at.address.runId} is a Buddy call, and ${this.why}`);
  }
  async watch(): Promise<() => void> {
    return () => {};
  }
}

const SETTLED = new Set<Run['status']>(['complete', 'failed', 'cancelled']);
const LIVE = new Set<Run['status']>(['queued', 'running']);

/** Where a post's request stands, read with its runs. */
type Standing =
  | { readonly t: 'running' }
  | { readonly t: 'answered'; readonly answerId: string }
  | { readonly t: 'cancelled' }
  | { readonly t: 'failed'; readonly why: string };

function standingOf(request: RequestState, runs: Run[]): Standing {
  const live = runs.some((r) => !SETTLED.has(r.status));
  if (live) return { t: 'running' };
  return REQUEST[request.state](request as never, runs);
}
type RequestState = Awaited<ReturnType<BuddiesCore['getPost']>>['request'];
const REQUEST: {
  readonly [K in RequestState['state']]: (
    r: Extract<RequestState, { state: K }>,
    runs: Run[]
  ) => Standing;
} = {
  answered: (r) => ({ t: 'answered', answerId: r.answerId }),
  cancelled: () => ({ t: 'cancelled' }),
  failed: (_r, runs) => ({ t: 'failed', why: failureOf(runs) }),
  // Every run settled and the request still open: its queued run was cancelled (runs.rs
  // cancel_queued closes no request). With no run seen yet, the run list has not shown it.
  awaiting: (_r, runs) => (runs.length > 0 ? { t: 'cancelled' } : { t: 'running' }),
  none: (_r, runs) => (runs.length > 0 ? { t: 'cancelled' } : { t: 'running' }),
};
const failureOf = (runs: Run[]): string => {
  const last = runs.at(-1);
  return last ? `${last.errorCode ?? 'failed'}: ${last.error ?? ''}`.trim() : 'the request failed';
};

const RUN_CONFIG: {
  readonly [K in RunOn['t']]: (r: Extract<RunOn, { t: K }>) => RunConfig | undefined;
} = {
  profile: () => undefined,
  config: (r) => r.config,
};

/** A cap is an expiry: the stop decides the outcome whatever the turn did after it. */
const STOPPED: {
  readonly [K in Stop['t']]: (s: Extract<Stop, { t: K }>) => RawOutcome | 'by-standing';
} = {
  none: () => 'by-standing',
  cancel: () => 'by-standing',
  minutes: (s) => errored(`exceeded ${s.minutes} min`),
  usd: (s) => errored(`exceeded $${s.usd} (spent $${s.spent.toFixed(4)})`),
};

type Prepared =
  | { readonly t: 'ready'; readonly posting: Posting }
  | { readonly t: 'refused'; readonly why: string };
const refused = (why: string): Prepared => ({ t: 'refused', why });

/** A crate rejection of the request's own data is permanent; anything else may be transient. */
const permanent = (e: unknown): boolean => {
  const typed = coreError(e);
  return typed !== null && typed.httpStatus < 500;
};

export class BuddyCalls implements Calls {
  private readonly seats: Seats;
  /** Live calls this process observes, by run id. */
  private readonly watched = new Set<string>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly side: ExecutorSide,
    private readonly d: BuddyCallDeps
  ) {
    this.seats = new Seats(d.core);
  }

  // ---- the port, per run ----

  async start(at: Located, spec: CallSpec): Promise<void> {
    let prepared: Prepared;
    try {
      prepared = await this.prepare(at, spec);
    } catch (e) {
      if (!permanent(e)) throw e;
      prepared = refused((e as Error).message);
    }
    if (prepared.t === 'refused')
      return settleAtStart(this.side, at, spec.t, errored(prepared.why));
    // Before the post, never rewritten: the one copy of the prompt the turn is sent (F4).
    await keepPrompt(at.paths.prompt, prepared.posting.body);
    await writeRecord(at.paths.record, prepared.posting);
    await this.post(at, prepared.posting);
  }

  async current(at: Located, r: Call): Promise<RunRecord> {
    const now = r.t === 'posting' ? await this.post(at, r) : r;
    if (now.t === 'posted') this.track(now);
    return now;
  }

  async cancel(at: Located, r: Call): Promise<void> {
    const now = await this.current(at, r);
    if (now.t === 'posted') await this.stop(at, now, { t: 'cancel' });
  }

  async close(at: Located, r: Call): Promise<Last> {
    const now = await this.current(at, r);
    if (now.t === 'settled') return { t: 'settled', raw: now.raw, spent: now.spent };
    if (now.t !== 'posted') return { t: 'never-settled' };
    // Cancel first, tombstone after (the caller): a crash between leaves a cancelled call that
    // recovery closes again, never a queued run a late claim could start.
    await this.cancelRuns(now);
    await this.endTree(at.ctx, now);
    this.untrack(now.runId);
    return { t: 'never-settled' };
  }

  async watch(): Promise<() => void> {
    const t = this.d.timing;
    const stopEvents = observeBuddyEvents(this.d.events, t, 'expedition-calls', () => this.pass());
    const usage = setInterval(
      labelled('timer expedition-calls-usage', () => this.pollUsage()),
      t.usagePollMs
    );
    usage.unref();
    for (const runId of await this.liveOnDisk()) this.watched.add(runId);
    this.pass();
    return () => {
      stopEvents();
      clearInterval(usage);
      for (const timer of this.deadlines.values()) clearTimeout(timer);
      this.deadlines.clear();
    };
  }

  // ---- preparing and posting ----

  private async prepare(at: Located, spec: CallSpec): Promise<Prepared> {
    if (this.d.gate.t === 'disabled')
      return refused(`Buddy execution is disabled: ${this.d.gate.reason}`);
    const ws = at.ctx.workspace;
    if (ws.t === 'none')
      return refused(
        'this expedition was launched without a Buddy workspace, so no Buddy can run it'
      );
    return (PREPARE[spec.t] as Prepare<CallSpec['t']>)(this, at, spec, ws.id);
  }

  /** The Buddy a call runs as, and on what. */
  async seatOf(
    who: keyed.Who,
    at: Located,
    workspaceId: string
  ): Promise<{ buddyId: string; runOn: RunOn }> {
    return (WHO[who.t] as Who<keyed.Who['t']>)(who as never, this.seats, at, workspaceId);
  }

  async providerOf(seat: { buddyId: string; runOn: RunOn }): Promise<string> {
    if (seat.runOn.t === 'config') return seat.runOn.config.provider;
    const execution = profileExecution(
      await this.d.core.getBuddy(seat.buddyId),
      this.d.installed()
    );
    if (execution.kind === 'no-agent')
      throw new Error(`Buddy ${seat.buddyId} has no agent to run on`);
    return execution.provider;
  }

  /** The record a call starts with. */
  posting(
    at: Located,
    x: {
      kind: CallSpec['t'];
      seat: { buddyId: string; runOn: RunOn };
      body: string;
      expected: Expected;
      tree: Tree;
      base: string;
      max: keyed.Max;
      capabilities: TurnCapabilities;
    }
  ): Posting {
    const deadline = this.side.clock.now().getTime() + x.max.minutes * 60_000;
    return {
      t: 'posting',
      runId: at.address.runId,
      kind: x.kind,
      deadlineAt: new Date(deadline).toISOString(),
      tree: x.tree,
      capabilities: x.capabilities,
      buddyId: x.seat.buddyId,
      body: x.body,
      runOn: x.seat.runOn,
      expected: x.expected,
      base: x.base,
      maxMinutes: x.max.minutes,
      maxUsd: x.max.usd,
    };
  }

  /** posting → posted. A rejected post (or tree) settles the call; a transient failure throws and
   * leaves `posting`, finished by the next `status` or watcher pass. */
  private async post(at: Located, r: Posting): Promise<RunRecord> {
    if (this.d.gate.t === 'disabled')
      throw new Error(
        `${r.runId} is not posted: Buddy execution is disabled (${this.d.gate.reason})`
      );
    const tree = await startTree(at.ctx, r);
    if (tree.t === 'failed') return this.settleRefused(at, r, tree.why);
    const self = buddyActor(r.buddyId);
    let write: Awaited<ReturnType<BuddiesCore['post']>>;
    try {
      write = await this.d.core.post(
        self,
        { kind: 'direct', members: [self] },
        {
          kind: 'request',
          body: r.body,
          purpose: EXPEDITION_CALL_PURPOSE,
          evidence: [`${EXPEDITION_RUN_EVIDENCE}${r.runId}`],
          runConfig: RUN_CONFIG[r.runOn.t](r.runOn as never),
          mentions: [],
          broadcast: false,
          key: `xk:${r.runId}`,
        }
      );
    } catch (e) {
      if (!permanent(e)) throw e;
      return this.settleRefused(at, r, `the request was refused: ${(e as Error).message}`);
    }
    const posted: Posted = {
      ...r,
      t: 'posted',
      postId: write.post.id,
      postedAt: this.side.clock.now().toISOString(),
      crateRunIds: [],
      stop: { t: 'none' },
    };
    await writeRecord(at.paths.record, posted);
    this.track(posted);
    // Wakes the runner, as every post writer does (a replayed key created nothing new).
    if (write.created) await announcePost(this.d, OWNER, write.post);
    return posted;
  }

  private async settleRefused(at: Located, r: Call, why: string): Promise<SettledRecord> {
    await this.endTree(at.ctx, r);
    const settled = settledOf(r, errored(why), NOTHING);
    await writeRecord(at.paths.record, settled);
    this.untrack(r.runId);
    this.side.report(r.kind, r.runId, settled.raw, settled.spent);
    return settled;
  }

  // ---- observing ----

  private track(r: Posted): void {
    this.watched.add(r.runId);
    if (this.deadlines.has(r.runId) || r.stop.t !== 'none') return;
    const delay = Math.min(Math.max(0, Date.parse(r.deadlineAt) - Date.now()), 2 ** 31 - 1);
    const minutes = r.maxMinutes;
    const timer = setTimeout(
      labelled('timer expedition-call-deadline', () => {
        this.deadlines.delete(r.runId);
        this.inQueue(r.runId, (at, now) => this.stop(at, now, { t: 'minutes', minutes }));
      }),
      delay
    );
    timer.unref();
    this.deadlines.set(r.runId, timer);
  }

  private untrack(runId: string): void {
    this.watched.delete(runId);
    const timer = this.deadlines.get(runId);
    if (timer) clearTimeout(timer);
    this.deadlines.delete(runId);
  }

  /** One observation of every live call, each in its own queue. */
  private pass(): void {
    for (const runId of this.watched) this.inQueue(runId, (at, r) => this.step(at, r));
  }

  /** `work` on the run's current record, when it is a posted call. */
  private inQueue(runId: string, work: (at: Located, r: Posted) => Promise<unknown>): void {
    this.side
      .serial(runId, async () => {
        const at = await this.side.locate(runId);
        const found = await readRecord(at.paths.record);
        if (found.t === 'missing') return;
        const r = found.value;
        if (r.t === 'posting') return this.current(at, r);
        if (r.t !== 'posted') return this.untrack(runId);
        return work(at, r);
      })
      .catch((e: unknown) =>
        this.d.logger.warn(`[expeditions-v1] ${runId}: ${(e as Error).message}`)
      );
  }

  /** Read the post and its runs; settle when the request is over. */
  private async step(at: Located, r: Posted): Promise<void> {
    const runs = await this.runsOf(r);
    const seen = runs.map((x) => x.id);
    const known =
      seen.length === r.crateRunIds.length && seen.every((id) => r.crateRunIds.includes(id));
    const now: Posted = known ? r : { ...r, crateRunIds: seen };
    if (!known) await writeRecord(at.paths.record, now);
    const post = await this.d.core.getPost(OWNER, r.postId);
    const standing = standingOf(post.request, runs);
    if (standing.t === 'running') return this.track(now);
    await this.settle(at, now, standing, runs);
  }

  /** The post's runs. While a known run is live, only the known ones are read; otherwise the
   * Buddy's run list is scanned for runs of this post (a decision-G attempt 2 appears there). */
  private async runsOf(r: Posted): Promise<Run[]> {
    const known = await Promise.all(r.crateRunIds.map((id) => this.d.core.getRun(id)));
    if (known.some((x) => LIVE.has(x.status) || x.status === 'cancel_requested')) return known;
    const listed = await this.d.core.listRuns({ kind: 'buddy', buddyId: r.buddyId }, 2000);
    const ofPost = listed.filter((x) => x.input.kind === 'post' && x.input.postId === r.postId);
    const byId = new Map([...known, ...ofPost].map((x) => [x.id, x]));
    return [...byId.values()].sort((a, b) => a.attempt - b.attempt);
  }

  // ---- stopping ----

  /** Record why, then end its crate runs; the settle follows from the next observation. */
  private async stop(at: Located, r: Posted, why: Stop): Promise<void> {
    if (r.stop.t !== 'none') return;
    const stopped: Posted = { ...r, stop: why };
    await writeRecord(at.paths.record, stopped);
    const timer = this.deadlines.get(r.runId);
    if (timer) clearTimeout(timer);
    this.deadlines.delete(r.runId);
    await this.cancelRuns(stopped);
    this.inQueue(r.runId, (a, now) => this.step(a, now));
  }

  /** The owner's cancel, as the runs route does it: a queued run ends now, a running one is asked
   * to stop and the runner kills its turn (`cancelled` event). */
  private async cancelRuns(r: Posted): Promise<void> {
    for (const run of await this.runsOf(r)) {
      if (!LIVE.has(run.status)) continue;
      try {
        const cancelled = await this.d.core.cancelRun(OWNER, run.id);
        this.d.events.emit({ kind: 'cancelled', run: cancelled });
      } catch (e) {
        // It settled between the read and the cancel.
        if (!coreError(e)) throw e;
      }
    }
    this.d.events.emit({ kind: 'changed' });
  }

  private pollUsage(): void {
    for (const runId of this.watched)
      this.inQueue(runId, async (at, r) => {
        if (r.stop.t !== 'none') return;
        const runs = await this.runsOf(r);
        const metered = await this.d.meter.spent(conversationsOf(runs), Date.parse(r.postedAt));
        if (metered.t === 'priced' && metered.usd >= r.maxUsd)
          await this.stop(at, r, { t: 'usd', usd: r.maxUsd, spent: metered.usd });
      });
  }

  // ---- settling ----

  private async settle(
    at: Located,
    r: Posted,
    standing: Exclude<Standing, { t: 'running' }>,
    runs: Run[]
  ) {
    const byStop = (STOPPED[r.stop.t] as (s: Stop) => RawOutcome | 'by-standing')(r.stop);
    const raw = byStop === 'by-standing' ? await this.outcome(r, standing) : byStop;
    const end = await this.endTree(at.ctx, r);
    await (REF[r.kind as CallSpec['t']] as StoreRef)(at, r, raw, end, runs);
    const spent = await this.spentOf(r, runs);
    const settled = settledOf(r, raw, spent);
    await writeRecord(at.paths.record, settled);
    this.untrack(r.runId);
    this.side.report(r.kind, r.runId, raw, spent);
  }

  private async outcome(r: Posted, s: Exclude<Standing, { t: 'running' }>): Promise<RawOutcome> {
    switch (s.t) {
      case 'answered':
        if (r.tree.t === 'none') return errored('an answered call has no working directory');
        return readAnswer(
          r.expected,
          (await this.d.core.getPost(OWNER, s.answerId)).body,
          r.tree.path
        );
      case 'cancelled':
        return { t: 'cancelled' };
      case 'failed':
        return errored(s.why);
    }
  }

  /** The call's tree at its end: its commit, and where its branch and dirty work went. */
  async endTree(ctx: ExpeditionContext, r: Call): Promise<TreeEnd> {
    return (TREE_END[r.tree.t] as (c: ExpeditionContext, r: Call, t: Tree) => Promise<TreeEnd>)(
      ctx,
      r,
      r.tree
    );
  }

  /** Spend, waiting a bounded time for ingest. A call no run of which ever started spent nothing. */
  private async spentOf(r: Posted, runs: Run[]): Promise<keyed.Usage> {
    const conversations = conversationsOf(runs);
    if (conversations.length === 0) return NOTHING;
    const since = Date.parse(r.postedAt);
    const until = Date.now() + this.d.timing.usageWaitMs;
    for (;;) {
      const metered = await this.d.meter.spent(conversations, since);
      if (metered.t === 'priced') return { t: 'reported', usd: metered.usd };
      if (metered.t === 'unpriced' || Date.now() >= until) return { t: 'unreported' };
      await new Promise((resolve) => setTimeout(resolve, this.d.timing.usageRetryMs));
    }
  }

  /** Every live call record under the root (a restarted host observes what the dead one left). */
  private async liveOnDisk(): Promise<string[]> {
    return (await recordsUnder(this.side.root)).flatMap((r) =>
      r.t === 'posting' || r.t === 'posted' ? [r.runId] : []
    );
  }
}

// ---- tables ----

type Prepare<K extends CallSpec['t']> = (
  c: BuddyCalls,
  at: Located,
  spec: Extract<CallSpec, { t: K }>,
  workspaceId: string
) => Promise<Prepared>;

/** Every ref a body names must exist now; a missing one refuses the call. */
async function namedRefs(
  ctx: ExpeditionContext,
  refs: readonly keyed.RefId[]
): Promise<{ t: 'ok'; refs: Map<keyed.RefId, NamedRef> } | { t: 'missing'; why: string }> {
  const out = new Map<keyed.RefId, NamedRef>();
  for (const ref of refs) {
    const found = await getRef(ctx.dir, ref);
    if (found.t === 'missing') return { t: 'missing', why: `no stored output at ${ref}` };
    out.set(ref, { ref, record: found.value });
  }
  return { t: 'ok', refs: out };
}

const REFS_OF_CONTEXT: {
  readonly [K in keyed.AgentCall['context']['t']]: (
    c: Extract<keyed.AgentCall['context'], { t: K }>
  ) => keyed.RefId[];
} = {
  cold: () => [],
  continue: (c) => [c.of],
};

const PREPARE: { readonly [K in CallSpec['t']]: Prepare<K> } = {
  agent: async (c, at, { call }, ws) => {
    const named = await namedRefs(at.ctx, [
      ...call.inputs.flatMap((i) => (i.t === 'ref' ? [i.ref] : [])),
      ...REFS_OF_CONTEXT[call.context.t](call.context as never),
    ]);
    if (named.t === 'missing') return refused(named.why);
    const base = await commitOf(at.ctx, call.base);
    if (base.t === 'missing') return refused(base.why);
    const seat = await c.seatOf(call.by, at, ws);
    const tree = TREE_OF[call.tree](at, call.key);
    // The tree is made here, before the capability set: a checkout's set names the git metadata
    // its commits write, which exists only once the worktree does. Idempotent (post() makes it
    // again and finds it made), so a start replayed after a crash names the same directories.
    const made = await makeTree(at.ctx, base.sha, tree);
    if (made.t === 'failed') return refused(made.why);
    const commits = await (GIT_OF[tree.t] as (t: Tree) => Promise<TurnGit>)(tree);
    const expected: Expected = { t: 'typed', schema: call.output };
    const capabilities = capabilitiesOf(
      TURN_OF[call.tree](
        at,
        {
          reads: unique([
            ...[...named.refs.values()].map((n) => path.dirname(n.record.answerPath)),
            ...call.grant.reads.map((p) => path.resolve(at.ctx.repo, p)),
          ]),
          web: call.grant.web,
        },
        commits
      )
    );
    const body = agentBody({
      address: at.address,
      provider: await c.providerOf(seat),
      ctx: at.ctx,
      call,
      refs: named.refs,
      tree,
      base: base.sha,
      expected,
      capabilities,
    });
    return {
      t: 'ready',
      posting: c.posting(at, {
        kind: 'agent',
        seat,
        body,
        expected,
        tree,
        base: base.sha,
        max: call.max,
        capabilities,
      }),
    };
  },
  review: async (c, at, spec, ws) => {
    const named = await namedRefs(at.ctx, [spec.of]);
    if (named.t === 'missing') return refused(named.why);
    const judged = named.refs.get(spec.of) as NamedRef;
    const seat = await c.seatOf(spec.by, at, ws);
    const view = (JUDGE_VIEW[judged.record.checkout.t] as JudgeView)(at, judged.record);
    const expected: Expected = { t: 'verdict' };
    // The judged output, what its producer could read, and the code it committed (read-only).
    const capabilities = capabilitiesOf({
      t: 'judge',
      reads: unique([
        path.dirname(judged.record.answerPath),
        ...judged.record.reads,
        ...view.reads,
      ]),
    });
    const tree = view.tree;
    const body = reviewBody({
      address: at.address,
      provider: await c.providerOf(seat),
      ctx: at.ctx,
      brief: spec.brief,
      judged,
      tree,
      expected,
      capabilities,
    });
    return {
      t: 'ready',
      posting: c.posting(at, {
        kind: 'review',
        seat,
        body,
        expected,
        tree,
        base: judged.record.commit,
        max: spec.max,
        capabilities,
      }),
    };
  },
  // The leader on its own profile, in its draft folder: it reads the expedition directory and
  // writes only the draft. Its brief is leader-brief.ts; the limits go first, as for every call.
  leader: async (c, at, spec) => {
    const capabilities = capabilitiesOf({ t: 'leader', expDir: at.ctx.dir, draft: spec.draft });
    return {
      t: 'ready',
      posting: c.posting(at, {
        kind: 'leader',
        seat: { buddyId: at.ctx.leader, runOn: { t: 'profile' } },
        body: `${limitsText(await c.providerOf({ buddyId: at.ctx.leader, runOn: { t: 'profile' } }), capabilities)}\n\n${spec.body}`,
        expected: { t: 'act', folder: spec.draft },
        tree: { t: 'dir', path: spec.draft },
        base: at.ctx.baseSha,
        max: spec.max,
        capabilities,
      }),
    };
  },
};

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

/** What a review judge sees of the work beyond its answer file, by the judged ref's checkout.
 * Until 2026-11-11 a judge of a checkout call got only the answer: the producer's worktree is
 * released at its settle, so a reviewer could not read the implementation at its committed version. Now it reads a detached checkout of exactly the judged commit
 * and the diff against the call's base. Guard: expeditions-v1-agent-restarts.test.ts. */
type JudgeView = (at: Located, judged: RefRecord) => { tree: Tree; reads: readonly string[] };
const JUDGE_VIEW: {
  readonly [K in RefRecord['checkout']['t']]: (
    at: Located,
    judged: RefRecord & { checkout: Extract<RefRecord['checkout'], { t: K }> }
  ) => { tree: Tree; reads: readonly string[] };
} = {
  none: (at) => ({ tree: { t: 'dir', path: at.paths.work }, reads: [] }),
  branch: (at, judged) => ({
    tree: {
      t: 'judge-checkout',
      path: at.paths.work,
      code: at.paths.tree,
      commit: judged.commit,
      base: judged.checkout.base,
      diff: path.join(at.paths.work, 'changes.diff'),
    },
    reads: [at.paths.tree],
  }),
};
/** An agent call's turn, by its `tree` field (the policy is expedition-kernel/access.ts). */
const TURN_OF: {
  readonly [K in keyed.AgentCall['tree']]: (
    at: Located,
    g: { readonly reads: readonly string[]; readonly web: boolean },
    git: TurnGit
  ) => CallTurn;
} = {
  none: (at, g) => ({ t: 'call', work: at.paths.work, ...g }),
  checkout: (at, g, git) => ({ t: 'checkout', tree: at.paths.tree, ...g, git }),
};

/** What a commit in the tree writes outside it (agent-cli `TurnGit`). Only a checkout is a linked
 * worktree; the exact directories come from git itself, because the worktree's git directory is
 * named by git (`worktrees/tree`, `tree1`, ... as checkout paths all end in `tree`). The branch's
 * ref and reflog directories are its parent directories (`refs/heads/expedition/<id>/`): the
 * finest grain a sandbox root allows, so sibling branches of the same expedition share them. */
const GIT_OF: {
  readonly [K in Tree['t']]: (t: Extract<Tree, { t: K }>) => Promise<TurnGit>;
} = {
  none: async () => ({ t: 'none' }),
  detached: async () => ({ t: 'none' }),
  dir: async () => ({ t: 'none' }),
  'judge-checkout': async () => ({ t: 'none' }),
  checkout: (t) => worktreeGit(t.path, t.branch),
};
/** The metadata `git commit` on `branch` in the linked worktree `tree` writes outside it. Guard:
 * server/test/expeditions-v1-worktree-git.test.ts (a real commit writes nowhere else). */
export async function worktreeGit(tree: string, branch: string): Promise<TurnGit> {
  const [gitDir, commonDir] = (
    await git(tree, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  ).split('\n');
  if (!gitDir || !commonDir) throw new Error(`git rev-parse in ${tree} named no git directory`);
  const branchDir = path.posix.dirname(branch);
  const refs = path.join(commonDir, 'refs', 'heads', branchDir);
  const logs = path.join(commonDir, 'logs', 'refs', 'heads', branchDir);
  // A sandbox root must exist; the reflog directory may not yet (no reflog written so far).
  await mkdir(refs, { recursive: true });
  await mkdir(logs, { recursive: true });
  const dirs = await Promise.all(
    [gitDir, path.join(commonDir, 'objects'), refs, logs].map((d) => realpath(d))
  );
  return { t: 'worktree', dirs };
}

type Who<K extends keyed.Who['t']> = (
  w: Extract<keyed.Who, { t: K }>,
  seats: Seats,
  at: Located,
  workspaceId: string
) => Promise<{ buddyId: string; runOn: RunOn }>;
const WHO: { readonly [K in keyed.Who['t']]: Who<K> } = {
  buddy: async (w) => ({ buddyId: w.id, runOn: { t: 'profile' } }),
  // An anonymous seat: the workspace's seat Buddy on exactly this config (worker-config.ts κ: a
  // provider without required MCP, or a model or effort the catalog lacks, is refused here).
  seat: async (w, seats, at, ws) => {
    const config = checkedRunConfig({
      provider: w.provider,
      model: w.model,
      reasoningEffort: w.effort,
    });
    const buddyId = await seats.seatFor(ws, at.ctx.poolSlots);
    return {
      buddyId,
      runOn: {
        t: 'config',
        config: {
          provider: config.provider,
          model: config.model ?? w.model,
          reasoningEffort: config.reasoningEffort ?? w.effort,
        },
      },
    };
  },
};

const slug = (key: string) =>
  key
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
/** A call's tree, by its `tree` field. A checkout's branch, Cambium workspace and salvage ref are
 * functions of the run id, so a replayed start names the same ones. */
const TREE_OF: {
  readonly [K in keyed.AgentCall['tree']]: (at: Located, key: keyed.Key) => Tree;
} = {
  none: (at) => ({ t: 'dir', path: at.paths.work }),
  checkout: (at, key) => {
    const a = at.address;
    const hash8 = a.ref.slice(a.ref.lastIndexOf('@') + 1, a.ref.lastIndexOf('@') + 9);
    const name = `${slug(key)}-${hash8}-a${a.attempt}`;
    return {
      t: 'checkout',
      path: at.paths.tree,
      branch: `expedition/${a.expedition}/${name}`,
      workspace: `xk-${createHash('sha256').update(a.runId).digest('hex').slice(0, 16)}`,
      salvageRef: `refs/salvage/expeditions/${a.expedition}/${name}`,
    };
  },
};

type TreeEnd = {
  readonly commit: string;
  readonly checkout: RefRecord['checkout'];
};
const atBase = async (_ctx: ExpeditionContext, r: Call): Promise<TreeEnd> => ({
  commit: r.base,
  checkout: { t: 'none' },
});
const TREE_END: {
  readonly [K in Tree['t']]: (
    ctx: ExpeditionContext,
    r: Call,
    t: Extract<Tree, { t: K }>
  ) => Promise<TreeEnd>;
} = {
  none: atBase,
  detached: atBase,
  dir: atBase,
  // The judge's view of the code goes when the judge does (a settle, a close, a refused post).
  'judge-checkout': async (ctx, r, t) => {
    await removeDetachedTree(ctx.repo, t.code);
    return atBase(ctx, r);
  },
  // The branch's tip is the call's commit (the base when nothing was committed); the worktree goes
  // back to Cambium with dirty work snapshotted at the salvage ref. Both are idempotent, so a
  // settle replayed after a crash ends the same way.
  checkout: async (ctx, r, t) => {
    const at = await tip(ctx.repo, t.branch, t.path);
    const released = await release(ctx.repo, t.workspace, t.salvageRef);
    const salvage: Extract<RefRecord['checkout'], { t: 'branch' }>['salvage'] =
      released.t === 'removed' && released.salvageRef
        ? { t: 'ref', name: released.salvageRef }
        : { t: 'none' };
    return {
      commit: at.t === 'tip' ? at.sha : r.base,
      checkout: { t: 'branch', branch: t.branch, base: r.base, salvage },
    };
  },
};

type Started = { readonly t: 'ready' } | { readonly t: 'failed'; readonly why: string };
/** Make the call's tree if it is not there yet (a replayed post finds it made). */
async function startTree(ctx: ExpeditionContext, r: Call): Promise<Started> {
  return makeTree(ctx, r.base, r.tree);
}
function makeTree(ctx: ExpeditionContext, base: string, tree: Tree): Promise<Started> {
  return (TREE_START[tree.t] as (c: ExpeditionContext, b: string, t: Tree) => Promise<Started>)(
    ctx,
    base,
    tree
  );
}
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false
  );
const TREE_START: {
  readonly [K in Tree['t']]: (
    ctx: ExpeditionContext,
    base: string,
    t: Extract<Tree, { t: K }>
  ) => Promise<Started>;
} = {
  none: async () => ({ t: 'ready' }),
  detached: async () => ({ t: 'failed', why: 'a call never runs in a detached tree' }),
  dir: async (_ctx, _base, t) => {
    await mkdir(t.path, { recursive: true, mode: 0o700 });
    return { t: 'ready' };
  },
  // A replayed post (a restart before it) makes the view again from scratch: the same commit,
  // HEAD verified, the same diff. Read-only to the judge by its capability set, not by mode bits.
  'judge-checkout': async (ctx, _base, t) => {
    await mkdir(t.path, { recursive: true, mode: 0o700 });
    try {
      await addDetachedTree(ctx.repo, t.code, t.commit);
      // Straight to the file: a large diff never passes through a buffer.
      await git(ctx.repo, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        `--output=${t.diff}`,
        t.base,
        t.commit,
      ]);
    } catch (e) {
      return {
        t: 'failed',
        why: `the judged code could not be checked out: ${(e as Error).message}`,
      };
    }
    return { t: 'ready' };
  },
  checkout: async (ctx, base, t) => {
    if (await exists(t.path)) return { t: 'ready' };
    await mkdir(path.dirname(t.path), { recursive: true, mode: 0o700 });
    const added = await add(ctx.repo, {
      workspace: t.workspace,
      branch: t.branch,
      path: t.path,
      baseSha: base,
    });
    return added.t === 'ok' ? { t: 'ready' } : { t: 'failed', why: added.message };
  },
};

type StoreRef = (
  at: Located,
  r: Posted,
  raw: RawOutcome,
  end: TreeEnd,
  runs: Run[]
) => Promise<void>;
const conversationOf = (runs: Run[]): RefRecord['conversation'] => {
  const id = runs
    .map((x) => x.conversationId)
    .filter((c): c is string => !!c)
    .at(-1);
  return id ? { t: 'conversation', id } : { t: 'none' };
};
const store =
  (out: (raw: RawOutcome) => unknown): StoreRef =>
  async (at, r, raw, end, runs) => {
    await putRef(at.ctx.dir, {
      ref: at.address.ref,
      out: out(raw),
      commit: end.commit,
      checkout: end.checkout,
      conversation: conversationOf(runs),
      reads: [...readsOf(r.capabilities)],
    });
  };
const nothingStored: StoreRef = async () => {};
/** An agent's output exists when it answered (`out`) or was cancelled (its partial work: the
 * commit and salvage ref, `out: null`). A judge stores nothing: its producer's ref is the one at
 * this address, and a verdict call's output is its outcome. */
const AGENT_REF: { readonly [K in RawOutcome['t']]: StoreRef } = {
  ok: store((raw) => (raw as Extract<RawOutcome, { t: 'ok' }>).out),
  cancelled: store(() => null),
  no: nothingStored,
  errored: nothingStored,
};
const REF: { readonly [K in CallSpec['t']]: StoreRef } = {
  agent: (at, r, raw, end, runs) => AGENT_REF[raw.t](at, r, raw, end, runs),
  review: nothingStored,
  // A wake's act is logged with its call; its edits are the draft folder itself.
  leader: nothingStored,
};

const conversationsOf = (runs: Run[]): string[] => [
  ...new Set(runs.flatMap((x) => (x.conversationId && x.startedAt ? [x.conversationId] : []))),
];

const STOP_OF: { readonly [K in Call['t']]: (r: Extract<Call, { t: K }>) => Stop } = {
  posting: () => ({ t: 'none' }),
  posted: (r) => r.stop,
};
function settledOf(r: Call, raw: RawOutcome, spent: keyed.Usage): SettledRecord {
  return {
    t: 'settled',
    runId: r.runId,
    kind: r.kind,
    deadlineAt: r.deadlineAt,
    tree: r.tree,
    raw,
    spent,
    stop: STOP_OF[r.t](r as never),
  };
}

/** Where a kernel run id's record is under a data root (call-directory.ts reads it). */
export const recordPathOf = (root: string, runId: string): string => {
  const a = parseRunId(runId);
  return runPaths(path.join(root, a.expedition), runId).record;
};
