import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BuddiesCore } from '@unleashd/buddies-core';
import type {
  BuddyContext,
  ExpeditionRetiredView,
  ExpeditionSummary,
  ExpeditionView,
  Provider,
} from '@unleashd/shared';
import { type TurnDirectory, WORKSPACE_DIRECTORY } from '../buddies/briefing';
import type { BuddyEvents } from '../buddies/events';
import type { ExecutionGate } from '../buddies/execution-gate';
import { statusText } from './briefs';
import { type DraftInput, type LaunchOutcome, createDraftStore } from './drafts';
import { LaunchRefused, createLauncher, gateIssues } from './launch';
import type { MeterPorts } from './meter';
import { type Feedback, type State, badge } from './model';
import { retiredView } from './retired';
import { createEffectRunner } from './run';
import { openStore } from './store';
import { createTicker } from './tick';
import { expeditionSummary, expeditionView } from './view';

// The expedition host: the one I/O shell around the pure core (model.ts). It composes the store
// (store.ts: folded ledgers, quarantine, retired snapshots, write chains), observation
// (observe.ts), the effect runner (run.ts), ticks (tick.ts) and launch/retire (launch.ts), and
// answers the routes, the tool and the server.

export interface ExpeditionHostOptions {
  core: BuddiesCore;
  events: BuddyEvents;
  root: string;
  gate: ExecutionGate;
  /** Where attempt cost is read from (meter.ts): conversation records and the transcript store. */
  meter: MeterPorts;
  /** Whether a provider's harness binary is on the PATH the runner spawns with (server: the
   * installed-agent PATH walk). A seat on a missing harness is a launch issue, never a spawn
   * ENOENT mid-expedition. */
  installed: (provider: Provider) => boolean;
  /** A retirement archived the crew Buddy (server.ts: the same as the owner's Archive, which
   * stops its conversations). */
  onBuddyArchived: (buddyId: string) => void;
  /** A retirement archived one of the crew's chats (server.ts: refreshes channel views). */
  onChannelArchived: (channelId: string) => void;
  now?: () => Date;
}

export type ExpeditionHost = ReturnType<typeof createExpeditionHost>;

export function createExpeditionHost(options: ExpeditionHostOptions) {
  const { core, events, root, gate, meter, installed } = options;
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const store = openStore(root);
  const { stateOf, serialized } = store;
  const effects = createEffectRunner({
    core,
    events,
    root,
    meter,
    now,
    store,
    onBuddyArchived: options.onBuddyArchived,
    onChannelArchived: options.onChannelArchived,
    // Late-bound: a check job ends (and wakes its expedition) only after construction.
    wake: (id) => void ticker.tick(id),
  });
  const ticker = createTicker({ core, events, gate, now, store, effects });
  const launcher = createLauncher({ core, gate, installed, root, now, store, ticker });

  /** A crew's own directory: its expedition's folder in the host store, never a git checkout.
   * 2026-11-01 review: non-attempt crew turns (a mention, the owner's chat, a worker the crew
   * spawned) started in managerDirectory, which is the owner's checkout before setup and after
   * finish, or the integration tree the host merges into; and a seat whose cwd moved between
   * the two could not resume its session. One fixed directory for every such turn. */
  async function crewDirectory(id: string): Promise<TurnDirectory> {
    const dir = path.join(root, id, 'crew');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return { t: 'crew', path: dir };
  }

  /**
   * κ for a Buddy turn's directory when its run names none (crate RunConfig.cwd `default`): a
   * crew's turn (a mention, the owner's chat) in the crew's own directory; any other Buddy's in
   * its workspace root. An attempt run carries its tree as its cwd (postAttempt).
   */
  async function turnDirectory(context: BuddyContext): Promise<TurnDirectory> {
    const id = crewOf(context.buddyId);
    return id ? crewDirectory(id) : WORKSPACE_DIRECTORY;
  }

  /** Every ready crew's Buddy id. */
  const crews = (): string[] =>
    store.states().flatMap((s) => (s.crew.t === 'ready' ? [s.crew.buddyId] : []));

  /** The expedition a Buddy crews (from the cached states: no fold per Buddy turn). */
  function crewOf(buddyId: string): string | undefined {
    return store.states().find((s) => s.crew.t === 'ready' && s.crew.buddyId === buddyId)?.id;
  }

  // Drafts launch through the same path; a refusal is data for the card, not a thrown error.
  const drafts = createDraftStore({
    core,
    events,
    dir: path.join(root, 'drafts'),
    issues: launcher.issues,
    now,
    // Every folded expedition carries its launch key and time (fold reads its `launched` entry).
    launches: () => store.states().map((s) => ({ key: s.key, id: s.id, at: s.launchedAt })),
    launch: (input): Promise<LaunchOutcome> =>
      launcher.launch(input).catch((error: unknown) => {
        if (error instanceof LaunchRefused) return { t: 'refused', reasons: error.reasons };
        throw error;
      }),
  });

  return {
    issues: launcher.issues,
    launch: launcher.launch,
    drafts: {
      ...drafts,
      /** A copied store drafts nothing either: the gate refuses before any file is written. */
      draft: async (input: DraftInput) => {
        if (gate.t === 'disabled') throw new Error(gateIssues(gate).join('; '));
        return drafts.draft(input);
      },
    },
    async steer(id: string, from: string, feedback: Feedback): Promise<State> {
      if (gate.t === 'disabled') throw new Error(gateIssues(gate).join('; '));
      stateOf(id);
      // Through the chain: a steer never interleaves its write with a running tick's.
      await serialized(id, () =>
        store.append(id, [{ t: 'feedback', at: now(), from, via: { t: 'tool' }, feedback }])
      );
      // The owner's word retries at once, whatever a failing streak's backoff says.
      await ticker.urge(id);
      return stateOf(id);
    },
    lookup: store.lookup,
    retire: launcher.retire,
    /** A retired expedition's frozen record (lookup said `retired`). */
    retiredView: (id: string): ExpeditionRetiredView => retiredView(store.retiredOf(id)),
    view(id: string): ExpeditionView {
      const s = stateOf(id);
      return expeditionView(s, badge(s, now()), now());
    },
    /** The status report; a retired expedition's is its frozen one. */
    status(id: string): string {
      switch (store.lookup(id).t) {
        case 'retired':
          return store.retiredOf(id).report;
        case 'present':
        case 'quarantined':
        case 'missing': {
          const s = stateOf(id);
          return statusText(s, badge(s, now()));
        }
      }
    },
    /** Only expeditions that fold: a quarantined ledger never fails the listing. */
    list(workspaceId: string): { id: string; badge: string }[] {
      return store
        .states()
        .filter((s) => s.workspaceId === workspaceId)
        .map((s) => ({ id: s.id, badge: badge(s, now()) }));
    },
    /** Every foldable expedition and every retired one, newest launch first (quarantined
     * ledgers are in neither). */
    summaries(): ExpeditionSummary[] {
      return [
        ...store.states().map(expeditionSummary),
        ...store.retired().map((r) => retiredView(r).summary),
      ].sort((a, b) => b.launchedAt.localeCompare(a.launchedAt));
    },
    /** The expedition a crew Buddy belongs to, so a mentioned crew can answer about itself. */
    ofCrew: crewOf,
    /** Every crew Buddy (the client keeps them off the Buddies roster). */
    crews,
    /** policy-port.ts CrewRegistry: adoption, session scope and shutdown ask it. */
    crewBuddyIds: (): ReadonlySet<string> => new Set(crews()),
    interruptBootLive: ticker.interruptBootLive,
    /** Starts ticking (server.ts: after `interruptBootLive` and execution adoption). */
    start: ticker.start,
    turnDirectory,
    workspaceOf(id: string): string {
      switch (store.lookup(id).t) {
        case 'retired':
          return store.retiredOf(id).summary.workspaceId;
        case 'present':
        case 'quarantined':
        case 'missing':
          return stateOf(id).workspaceId;
      }
    },
    /** Tests drive ticks directly. */
    tick: ticker.tick,
    /** Tests: resolves once no validation check job runs and the ticks they woke have settled. */
    async drain(): Promise<void> {
      do {
        await Promise.all(effects.jobs());
        await store.settled();
      } while (effects.jobs().length > 0);
    },
    close: ticker.close,
  };
}
