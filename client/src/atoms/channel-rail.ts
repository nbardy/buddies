import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { inboxUrl, railChannels } from '../components/buddies/channel-data';
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
