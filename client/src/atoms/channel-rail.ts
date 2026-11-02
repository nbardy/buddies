import type { ExpeditionSummary } from '@unleashd/shared';
import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { inboxUrl, railChannels } from '../components/buddies/channel-data';
import { EXPEDITIONS_URL, activeExpeditions } from '../components/buddies/expedition-view';
import type { Buddy, Inbox } from '../components/buddies/types';
import { rosterHiddenBuddyIdsAtom } from './buddy-visibility';
import { type ResourceEntry, resourceAtomFamily } from './resources';
import { starredBuddyIdsAtom, starredChannelIdsAtom } from './ui';

// Pattern: one-store-one-index (docs/patterns.md#one-store-one-index)
/** Both shells partition the cached channel rail, preserving order within each group. */
export const channelRailFamily = atomFamily((workspaceId: string) =>
  atom((get) => {
    const entry = get(resourceAtomFamily(inboxUrl(workspaceId))) as ResourceEntry<Inbox>;
    const rail = railChannels(
      entry.kind === 'ready' || entry.kind === 'stale' ? entry.value : null
    );
    const stars = new Set(get(starredChannelIdsAtom));
    return {
      ...rail,
      channels: [
        ...rail.channels.filter((row) => stars.has(row.channel.id)),
        ...rail.channels.filter((row) => !stars.has(row.channel.id)),
      ],
    };
  })
);

// Pattern: one-store-one-index (docs/patterns.md#one-store-one-index)
/** Both shells partition the directory's active roster without fetching a second copy. */
export const buddyRailFamily = atomFamily((members: readonly Buddy[]) =>
  atom((get) => {
    const stars = new Set(get(starredBuddyIdsAtom));
    // Expedition crews are reached through their badge and modal, not the Buddies rail.
    const hidden = get(rosterHiddenBuddyIdsAtom);
    const team = members.filter((buddy) => !hidden.has(buddy.id));
    return [
      ...team.filter((buddy) => stars.has(buddy.id)),
      ...team.filter((buddy) => !stars.has(buddy.id)),
    ];
  })
);

const NO_EXPEDITIONS: readonly ExpeditionSummary[] = [];

// Pattern: one-store-one-index (docs/patterns.md#one-store-one-index)
/** One workspace's expeditions from the one cached list (GET /api/buddies/expeditions): `all` for
 * the index pane, `active` (unfinished, needing the owner first) for the rail and Home. `loaded`
 * tells "none yet" from "not fetched yet". */
export const expeditionRailFamily = atomFamily((workspaceId: string) =>
  atom((get) => {
    const entry = get(resourceAtomFamily(EXPEDITIONS_URL)) as ResourceEntry<ExpeditionSummary[]>;
    const list = entry.kind === 'ready' || entry.kind === 'stale' ? entry.value : NO_EXPEDITIONS;
    return {
      loaded: entry.kind === 'ready' || entry.kind === 'stale',
      all: list.filter((e) => e.workspaceId === workspaceId),
      active: activeExpeditions(list, workspaceId),
    };
  })
);

/** One expedition's row from the one cached list: what the chat badge shows, so N badges cost one
 * list request, not N full-view polls. `pending`: the list is not here yet; `unavailable`: it
 * failed with nothing cached; `missing`: the list is here and has no such expedition. */
export type SummaryRead =
  | { t: 'pending' }
  | { t: 'unavailable' }
  | { t: 'missing' }
  | { t: 'found'; summary: ExpeditionSummary };

export const expeditionSummaryFamily = atomFamily((id: string) =>
  atom((get): SummaryRead => {
    const entry = get(resourceAtomFamily(EXPEDITIONS_URL)) as ResourceEntry<ExpeditionSummary[]>;
    switch (entry.kind) {
      case 'idle':
      case 'loading':
        return { t: 'pending' };
      case 'failed':
        return { t: 'unavailable' };
      case 'ready':
      case 'stale': {
        const summary = entry.value.find((e) => e.id === id);
        return summary ? { t: 'found', summary } : { t: 'missing' };
      }
    }
  })
);
