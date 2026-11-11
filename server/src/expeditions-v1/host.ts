import path from 'node:path';
import type { InstalledAgent } from '@unleashd/shared';
import { keyed } from '@unleashd/shared';
import type { BuddiesCore } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import type { ExecutionGate } from '../buddies/execution-gate';
import { type Thread, createOwnerThread } from '../buddies/owner-thread';
import type { HostCommands } from '../buddies/routes';
import type { ConversationRecordStore } from '../conversations/config-records';
import { systemClock } from '../expedition-kernel/clock';
import { currentRunId, liveCalls } from '../expedition-kernel/core';
import { type Expedition, type KernelDeps, open } from '../expedition-kernel/kernel';
import { type Clean, type Previewed, launchClean, preview } from '../expedition-kernel/launch';
import type { Clock } from '../expedition-kernel/ports';
import { keyedRowOf, keyedViewOf } from '../expedition-kernel/projection';
import type { IngestAccessor } from '../ingest/instance';
import { HostExecutor } from './executor';
import type { Answered, AskAnswer } from './executor/asks';
import { CALL_TIMING, type CallTiming } from './executor/calls';
import { ingestMeter, recordsSessionOf } from './executor/usage';
import { createLeader } from './leader';
import { observeBuddyEvents } from './observe';
import { Approvals, type Decided } from './owner/approvals';
import { OwnerBook } from './owner/book';
import { aboutIn } from './owner/candidate';
import { Inbox } from './owner/inbox';
import { expeditionThread, leaderDm } from './owner/thread';
import { buddyProviders } from './providers';

// The keyed expedition host, composed (CONNECT_PLAN §2, §8 step 5): the executor (commands,
// checks, Buddy calls, owner asks), the real Leader and Owner ports, the owner's thread (`consumes`
// and the inbox) and the open kernels, built from the dependencies the old host gets. The server
// builds it only in live mode (service.ts: execution gate enabled AND `UNLEASHD_EXPEDITIONS_V1=1`)
// and boots it in three steps: `load()` before the server listens (the owner books, so `consumes`
// is right for the first request), `start()` after execution adoption, then `open` for every
// unfinished expedition before the Buddy runner starts; `close()` at shutdown. Nothing here
// registers a route.

export type KeyedHostDeps = {
  readonly core: BuddiesCore;
  readonly events: BuddyEvents;
  readonly gate: ExecutionGate;
  /** `expeditionsV1Root(appDataDir)` (call-directory.ts). */
  readonly root: string;
  /** For `~` in a contract's `repo`. */
  readonly home: string;
  /** Conversation records and ingest: what a call's turns cost (executor/usage.ts). */
  readonly records: Pick<ConversationRecordStore, 'getByConversationId'>;
  readonly ingest: IngestAccessor;
  /** The install's agent (a named Buddy with no provider runs on it). */
  readonly installed: () => InstalledAgent;
  readonly logger: Pick<Console, 'warn'>;
  readonly clock?: Clock;
  readonly gates?: KernelDeps['gates'];
  readonly timing?: CallTiming;
};

/** The typecheck gate's zod and tsc: the server's own (server/node_modules). */
const SERVER_DIR = path.resolve(__dirname, '..', '..');
export const SERVER_GATES: KernelDeps['gates'] = {
  zodEntry: path.join(SERVER_DIR, 'node_modules', 'zod'),
  tscBin: path.join(SERVER_DIR, 'node_modules', '.bin', 'tsc'),
};

/** The execution gate is closed: nothing that starts agents may run. */
export type Refused = { readonly t: 'refused'; readonly why: string };
const GATED: {
  readonly [K in ExecutionGate['t']]: <T>(
    g: Extract<ExecutionGate, { t: K }>,
    work: () => Promise<T>
  ) => Promise<T | Refused>;
} = {
  enabled: (_g, work) => work(),
  disabled: async (g) => ({ t: 'refused', why: `Buddy execution is disabled: ${g.reason}` }),
};
export type Opened = { readonly t: 'opened'; readonly expedition: Expedition } | Refused;
export type Launched =
  | { readonly t: 'launched'; readonly expedition: Expedition }
  | { readonly t: 'rejected'; readonly gate: string; readonly issues: readonly string[] }
  | Refused;
export type AskAnswered = Answered | { readonly t: 'missing'; readonly why: string };
export type ApprovalAnswered = Decided | { readonly t: 'missing'; readonly why: string };

export type KeyedHost = ReturnType<typeof createKeyedHost>;

export function createKeyedHost(d: KeyedHostDeps) {
  const clock = d.clock ?? systemClock;
  const timing = d.timing ?? CALL_TIMING;
  const book = new OwnerBook(d.root);
  const ownerThread = createOwnerThread({ core: d.core, events: d.events });
  const executor = new HostExecutor({
    root: d.root,
    home: d.home,
    clock,
    calls: {
      t: 'buddies',
      deps: {
        core: d.core,
        events: d.events,
        gate: d.gate,
        meter: ingestMeter({ sessionOf: recordsSessionOf(d.records), ingest: d.ingest }),
        timing,
        logger: d.logger,
        book,
      },
    },
  });
  const providers = buddyProviders(d.core, d.installed);
  const kernels = new Map<string, Expedition>();
  const threads = new Map<string, Promise<Thread>>();

  /** The expedition's thread, its root posted (quietly) and known to the book. */
  const threadOf = (id: string): Promise<Thread> => {
    const known = threads.get(id);
    if (known) return known;
    const making = (async () => {
      const e = kernelOf(id);
      const { contract } = e.state();
      const channelId = await leaderDm(d.core, contract.leader);
      const thread = expeditionThread({
        id,
        goal: contract.goal,
        leader: contract.leader,
        channelId,
      });
      await book.threadPosted(id, channelId, await ownerThread.threadRoot(thread));
      return thread;
    })();
    threads.set(id, making);
    making.catch(() => threads.delete(id));
    return making;
  };
  const kernelOf = (id: string): Expedition => {
    const e = kernels.get(id);
    if (!e) throw new Error(`no open expedition ${id}`);
    return e;
  };

  const approvals = new Approvals({ thread: ownerThread, threadOf });
  const leader = createLeader({ executor, book });
  const inbox = new Inbox({ book, thread: ownerThread, approvals });
  const deps: KernelDeps = {
    executor,
    leader,
    owner: approvals,
    clock,
    providerOf: providers.providerOf,
    gates: d.gates ?? SERVER_GATES,
  };

  /** Run `work` only while Buddy execution is enabled: launch and open start agents (§7.1-2). */
  const whenEnabled = <T>(work: () => Promise<T>): Promise<T | Refused> =>
    (GATED[d.gate.t] as (g: ExecutionGate, w: () => Promise<T>) => Promise<T | Refused>)(
      d.gate,
      work
    );
  const adopt = async (e: Expedition): Promise<void> => {
    kernels.set(e.id, e);
    await threadOf(e.id);
  };
  const readInbox = () => {
    for (const e of kernels.values())
      void threadOf(e.id)
        .then((thread) => inbox.read({ kernel: e, thread }))
        .catch((err: unknown) =>
          d.logger.warn(`[expeditions-v1] ${e.id} owner thread: ${(err as Error).message}`)
        );
  };

  const stops: (() => void)[] = [];

  /** The gates on a folder; writes nothing (the owner's `POST /preview`, and launch). */
  const previewFolder = async (folder: string): Promise<Previewed> => {
    await providers.refresh();
    return preview(deps, folder);
  };
  /** Launch a folder that passed `preview` (the owner's HTTP route only, never a tool: §7.2). */
  const launchPreviewed = (
    clean: Clean,
    baseSha: string,
    workspace: keyed.LaunchWorkspace
  ): Promise<Launched> =>
    whenEnabled(async (): Promise<Launched> => {
      const r = await launchClean(deps, d.root, clean, baseSha, workspace);
      if (r.t === 'rejected') return r;
      await adopt(r.expedition);
      return { t: 'launched', expedition: r.expedition };
    });

  return {
    executor,
    leader,
    owner: approvals,
    book,
    deps,

    /** HostCommands.consumes (buddies/routes.ts): an owner reply in a thread this host owns. */
    consumes: ((channelId, _body, thread) =>
      book.consumes(channelId, thread)) satisfies HostCommands['consumes'],

    /** The owner books: every thread and ask root this host posted, so `consumes` knows them.
     * Before the server listens (boot race, step 6): an owner reply is consumed from the first
     * request on. Then the bus keeps the index current. Returns what could not be read. */
    async load(): Promise<string[]> {
      const failed = await book.loadAll();
      stops.push(
        d.events.on((e) => {
          if (e.kind === 'posted') book.noticed(e.post);
        })
      );
      return failed;
    },

    /** Observe calls, asks and the owner's threads (after execution adoption). */
    async start(): Promise<void> {
      stops.push(await executor.watch());
      stops.push(observeBuddyEvents(d.events, timing, 'expedition-owner', readInbox));
    },

    preview: previewFolder,
    launchClean: launchPreviewed,

    /** Preview, then launch at `baseSha`. */
    async launch(
      folder: string,
      baseSha: string,
      workspace: keyed.LaunchWorkspace
    ): Promise<Launched> {
      const p = await previewFolder(folder);
      return p.t === 'rejected' ? p : launchPreviewed(p, baseSha, workspace);
    },

    /** Open one existing expedition (boot recovery re-issues its starts: §7.1, behind the gate). */
    open(id: string): Promise<Opened> {
      return whenEnabled(async (): Promise<Opened> => {
        const known = kernels.get(id);
        if (known) return { t: 'opened', expedition: known };
        await providers.refresh();
        const { expedition } = await open(deps, path.join(d.root, id));
        await adopt(expedition);
        return { t: 'opened', expedition };
      });
    },

    get: (id: string): Expedition | undefined => kernels.get(id),

    /** The wire view, with the approval only the Owner port holds. */
    view(id: string): keyed.KeyedView | undefined {
      const e = kernels.get(id);
      return e ? keyedViewOf(e.view(), approvals.pendingOf(id), aboutIn(e.view())) : undefined;
    },
    /** The list row of an open expedition. */
    row(e: Expedition): keyed.KeyedRow {
      return keyedRowOf(e.state(), approvals.pendingOf(e.id));
    },
    /** Every expedition this host has open (launched or opened). */
    opened(): readonly Expedition[] {
      return [...kernels.values()];
    },

    /** The owner answers a pending ask directly (the future `POST /:id/asks/:ref`). */
    async answerAsk(id: string, ref: keyed.RefId, answer: AskAnswer): Promise<AskAnswered> {
      const e = kernels.get(id);
      if (!e) return { t: 'missing', why: `no open expedition ${id}` };
      const live = liveCalls(e.state()).find(
        (c) => c.call.t === 'ask' && keyed.refOf(c.key, c.hash) === ref
      );
      if (!live) return { t: 'missing', why: `no pending ask ${ref}` };
      return executor.answer(currentRunId(live.status), answer);
    },

    /** The owner answers the waiting rewrite directly (the future `POST /:id/approval`). */
    async answerApproval(id: string, approved: boolean): Promise<ApprovalAnswered> {
      if (!kernels.has(id)) return { t: 'missing', why: `no open expedition ${id}` };
      return approvals.decide(id, approved);
    },

    /** Shutdown (§3): stop observing, detach every kernel (each kills its plan process) and
     * kill every command and check process group (their runs are reaped `errored` at the next
     * boot, D6). Running Buddy turns go on: the next backend adopts them. */
    async close(): Promise<void> {
      for (const stop of stops.splice(0)) stop();
      await Promise.all([...kernels.values()].map((e) => e.detach()));
      kernels.clear();
      await executor.shutdown();
    },
  };
}
