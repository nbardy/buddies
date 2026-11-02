import { randomUUID } from 'node:crypto';
import type { BuddiesCore } from '@unleashd/buddies-core';
import { type Provider, ProviderSchema } from '@unleashd/shared';
import type { ExecutionGate } from '../buddies/execution-gate';
import { checkedRunConfig } from '../buddies/worker-config';
import { preflight } from './git';
import {
  type Charter,
  type Entry,
  INTEGRATION_TREE,
  type Origin,
  type State,
  charterIssues,
  commandChecks,
  launchNews,
  seatRunConfig,
} from './model';
import { integrationPlace } from './run';
import type { ExpeditionStore } from './store';
import type { Ticker } from './tick';

// Launch (the R4 preflight, one exclusive ledger per launch) and the owner's retire request.

export interface LaunchInput {
  key: string;
  charter: Charter;
  origin: Origin;
  launcherId: string;
  workspaceId: string;
}

/** The chain launches run on (never an expedition id: those are `<slug>-<hex>`). */
const LAUNCH_CHAIN = 'launch:';

/** A host whose gate is disabled (a copied store) never runs an expedition, so it refuses one. */
export function gateIssues(gate: ExecutionGate): string[] {
  switch (gate.t) {
    case 'enabled':
      return [];
    case 'disabled':
      return [`expeditions do not run on this server: ${gate.reason}`];
  }
}

/**
 * Each crew seat checked against the provider catalog (worker-config.ts) and against this host's
 * installed harnesses: one issue per seat. 2026-11-02 visual pass: on a host without codex the
 * default crew (codex work and check seats) drafted with no issue and launched; the manager then
 * planned "send the retry to seat 1 (codex)", and a claude claim's independent check could only
 * run on codex, a spawn that cannot start.
 */
function seatIssues(charter: Charter, installed: (provider: Provider) => boolean): string[] {
  const { crew } = charter;
  const seats = [
    { where: 'manager', seat: crew.manager },
    ...crew.work.map((seat, i) => ({ where: `work seat ${i}`, seat })),
    ...crew.check.map((seat, i) => ({ where: `check seat ${i}`, seat })),
  ];
  return seats.flatMap(({ where, seat }) => {
    try {
      checkedRunConfig(seatRunConfig(seat));
    } catch (error) {
      return [(error as Error).message];
    }
    const provider = ProviderSchema.parse(seat.provider);
    return installed(provider)
      ? []
      : [`${where}: ${provider} is not installed on this host; name a crew without it`];
  });
}

/** How the owner asks to retire: a finished expedition, or an open one stopped first. */
export type RetireMode = 'retire' | 'stop_and_retire';

/** What a retire request did (routes.ts answers each). `retiring`: recorded, the steps run in
 * the background (a request while retiring asks the refused steps again). */
export type Retire =
  | { t: 'retiring' }
  | { t: 'not_finished' }
  | { t: 'already_retired' }
  | { t: 'missing' }
  | { t: 'quarantined'; reason: string }
  | { t: 'disabled'; reason: string };

/** A launch with this (conversation, name) key is still open: the retried call gets it back. */
export type Launched = { t: 'launched'; state: State } | { t: 'already_running'; state: State };

/** A launch the preflight refused (design.md R4), with every reason; nothing was written. */
export class LaunchRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`Expedition launch refused: ${reasons.join('; ')}.`);
  }
}

export interface LaunchPorts {
  core: BuddiesCore;
  gate: ExecutionGate;
  installed: (provider: Provider) => boolean;
  root: string;
  now: () => string;
  store: ExpeditionStore;
  ticker: Ticker;
}

export function createLauncher(ports: LaunchPorts) {
  const { core, gate, installed, root, now, store, ticker } = ports;
  const { append, stateOf, serialized } = store;

  /**
   * Every reason a launch of this charter is refused, in one list (draft and launch share it):
   * execution disabled on this host, the R4 preflight, the charter's own refusals and each crew
   * seat against the provider catalog. Reads only.
   */
  async function preflightOf(workspaceId: string, charter: Charter) {
    const issues = [
      ...gateIssues(gate),
      ...charterIssues(charter),
      ...seatIssues(charter, installed),
    ];
    const workspace = (await core.listWorkspaces()).find((w) => w.id === workspaceId);
    if (!workspace)
      return { t: 'refused' as const, reasons: [`no workspace ${workspaceId}`, ...issues] };
    const bins = commandChecks(charter).map(({ check }) => check.argv[0]);
    const checked = await preflight(workspace.rootPath, bins);
    switch (checked.t) {
      case 'refused':
        return { t: 'refused' as const, reasons: [...checked.reasons, ...issues] };
      case 'ready':
        return issues.length > 0 ? { t: 'refused' as const, reasons: issues } : checked;
    }
  }

  /**
   * One launch per (conversation, name) while it is open: a retried tool call gets the running
   * expedition back as `already_running`; once that one finished, the same name launches anew.
   */
  async function launchOnce(input: LaunchInput): Promise<Launched> {
    const prior = store.states().find((s) => s.key === input.key && s.run.t !== 'finished');
    if (prior) return { t: 'already_running', state: prior };
    const checked = await preflightOf(input.workspaceId, input.charter);
    if (checked.t === 'refused') throw new LaunchRefused(checked.reasons);
    const id = `${input.charter.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24)}-${randomUUID().slice(0, 6)}`;
    const repo = { root: checked.root, baseSha: checked.baseSha, branch: `expedition/${id}` };
    // One batch: `launched`, the integration tree's intent (its create replays from it) and the
    // launch status (the badge in the thread from the first second).
    const first: Entry[] = [
      { t: 'launched', at: now(), id, ...input, repo },
      {
        t: 'tree_planned',
        at: now(),
        tree: INTEGRATION_TREE,
        place: integrationPlace(root, id, repo),
      },
      { t: 'status', at: now(), seq: 0, text: launchNews(input.charter) },
    ];
    await store.create(id, first);
    await ticker.tick(id);
    return { t: 'launched', state: stateOf(id) };
  }

  /** What a launch of this charter would refuse, without writing anything (the `draft`). */
  async function issues(workspaceId: string, charter: Charter): Promise<string[]> {
    const checked = await preflightOf(workspaceId, charter);
    return checked.t === 'refused' ? checked.reasons : [];
  }

  /** The entries a retire request records, per mode; `not_finished` when it may not retire. */
  const RETIRE_ENTRIES: Record<RetireMode, (s: State, by: string) => Entry[] | 'not_finished'> = {
    retire: (s, by) =>
      s.run.t === 'finished'
        ? [{ t: 'retire_requested', at: now(), by, stop: false }]
        : 'not_finished',
    // The owner's stop rides with the request, so owner_stop finishes it first (decide.ts).
    stop_and_retire: (s, by) =>
      s.run.t === 'finished'
        ? [{ t: 'retire_requested', at: now(), by, stop: false }]
        : [
            { t: 'retire_requested', at: now(), by, stop: true },
            { t: 'feedback', at: now(), from: by, via: { t: 'tool' }, feedback: { t: 'stop' } },
          ],
  };

  /** Through the expedition's chain, like a steer; the steps then run on its ticks. */
  async function requestRetire(id: string, by: string, mode: RetireMode): Promise<Retire> {
    const s = stateOf(id);
    if (s.retirement.t === 'retired') return { t: 'already_retired' };
    const entries = RETIRE_ENTRIES[mode](s, by);
    if (entries === 'not_finished') return { t: 'not_finished' };
    await append(id, entries);
    return { t: 'retiring' };
  }

  async function retire(id: string, by: string, mode: RetireMode): Promise<Retire> {
    if (gate.t === 'disabled') return { t: 'disabled', reason: gateIssues(gate).join('; ') };
    const found = store.lookup(id);
    switch (found.t) {
      case 'missing':
      case 'quarantined':
        return found;
      case 'retired':
        return { t: 'already_retired' };
      case 'present': {
        const recorded = await serialized(id, () => requestRetire(id, by, mode));
        // The owner's word runs at once, whatever a failing streak's backoff says; the steps may
        // take minutes (a forced remove), so the request does not wait for them.
        void ticker.urge(id);
        return recorded;
      }
    }
  }

  return {
    /** Serialized: two concurrent launches with one key cannot both pass the lookup. */
    launch: (input: LaunchInput): Promise<Launched> =>
      serialized(LAUNCH_CHAIN, () => launchOnce(input)),
    issues,
    retire,
  };
}
