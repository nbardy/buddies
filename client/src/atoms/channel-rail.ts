import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { inboxUrl, railChannels } from '../components/buddies/channel-data';
import type { Inbox } from '../components/buddies/types';
import { type ResourceEntry, resourceAtomFamily } from './resources';
import { starredChannelIdsAtom } from './ui';

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
