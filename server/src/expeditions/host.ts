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

// The expedition host: the one I/O shell around the pure core (model.ts). It composes the store,
// the effect runner (run.ts), ticks (tick.ts) and launch/retire (launch.ts), and answers the
// routes, the tool and the server.

export interface ExpeditionHostOptions {
  core: BuddiesCore;
  events: BuddyEvents;
  root: string;
  gate: ExecutionGate;
  /** Where attempt cost is read from (meter.ts). */
  meter: MeterPorts;
  /** Whether a provider's harness is on the runner's PATH: a seat on a missing harness is a
   * launch issue, never a spawn ENOENT mid-expedition. */
  installed: (provider: Provider) => boolean;
  /** A retirement archived the crew Buddy (server.ts: as the owner's Archive, which stops its
   * conversations) or one of the crew's chats (refreshes channel views). */
  onBuddyArchived: (buddyId: string) => void;
  onChannelArchived: (channelId: string) => void;
  now?: () => Date;
}

export type ExpeditionHost = ReturnType<typeof createExpeditionHost>;

export function createExpeditionHost(options: ExpeditionHostOptions) {
  const { core, events, root, gate, installed } = options;
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const store = openStore(root);
  const { stateOf, serialized } = store;
  // `wake` is late-bound: a check job ends (and wakes its expedition) only after construction.
  const wake = (id: string) => void ticker.tick(id);
  const effects = createEffectRunner({ ...options, now, store, wake });
  const ticker = createTicker({ core, events, gate, now, store, effects });
  const launcher = createLauncher({ core, gate, installed, root, now, store, ticker });
  /** A copied store drafts and steers nothing: the gate refuses before any write. */
  const refuseDisabled = () => {
    if (gate.t === 'disabled') throw new Error(gateIssues(gate).join('; '));
  };
  /** Every ready crew's Buddy id. */
  const crews = (): string[] =>
    store.states().flatMap((s) => (s.crew.t === 'ready' ? [s.crew.buddyId] : []));
  /** The expedition a Buddy crews (from the cached states: no fold per Buddy turn). */
  const crewOf = (buddyId: string): string | undefined =>
    store.states().find((s) => s.crew.t === 'ready' && s.crew.buddyId === buddyId)?.id;
  const retired = (id: string) => store.lookup(id).t === 'retired';

  /** κ for a turn whose run names no cwd: a crew's in its own folder in the host store, never a
   * git checkout (2026-11-01 review: a seat whose cwd moved could not resume); others' in the
   * workspace root. */
  async function turnDirectory(context: BuddyContext): Promise<TurnDirectory> {
    const id = crewOf(context.buddyId);
    if (!id) return WORKSPACE_DIRECTORY;
    const dir = path.join(root, id, 'crew');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    return { t: 'crew', path: dir };
  }

  // Drafts launch through the same path; a refusal is data for the card, not a thrown error.
  const drafts = createDraftStore({
    core,
    events,
    dir: path.join(root, 'drafts'),
    issues: launcher.issues,
    now,
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
      draft: async (input: DraftInput) => {
        refuseDisabled();
        return drafts.draft(input);
      },
    },
    async steer(id: string, from: string, feedback: Feedback): Promise<State> {
      refuseDisabled();
      stateOf(id);
      // Through the chain: a steer never interleaves its write with a running tick's.
      await serialized(id, () =>
        store.append(id, [{ t: 'feedback', at: now(), from, via: { t: 'tool' }, feedback }])
      );
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
      if (retired(id)) return store.retiredOf(id).report;
      const s = stateOf(id);
      return statusText(s, badge(s, now()));
    },
    /** Only expeditions that fold: a quarantined ledger never fails the listing. */
    list: (workspaceId: string): { id: string; badge: string }[] =>
      store
        .states()
        .filter((s) => s.workspaceId === workspaceId)
        .map((s) => ({ id: s.id, badge: badge(s, now()) })),
    /** Every foldable and every retired expedition, newest launch first. */
    summaries: (): ExpeditionSummary[] =>
      [
        ...store.states().map(expeditionSummary),
        ...store.retired().map((r) => retiredView(r).summary),
      ].sort((a, b) => b.launchedAt.localeCompare(a.launchedAt)),
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
    workspaceOf: (id: string): string =>
      retired(id) ? store.retiredOf(id).summary.workspaceId : stateOf(id).workspaceId,
    /** Tests drive ticks directly. */
    tick: ticker.tick,
    /** Tests: resolves once no check job runs and the ticks they woke have settled. */
    async drain(): Promise<void> {
      do {
        await Promise.all(effects.jobs());
        await store.settled();
      } while (effects.jobs().length > 0);
    },
    close: ticker.close,
  };
}
