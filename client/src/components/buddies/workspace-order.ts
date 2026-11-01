import { listField } from '../../atoms/conversations';
import type { BuddyOverview } from './types';

// Which workspace a URL with none lands in, for both shells: /channels and /expeditions
// (ChannelsIndex), the phone's workspace switcher, and an unreadable expedition's modal
// (expedition-overlay.ts), which must land where /expeditions would without navigating away.

type OverviewWorkspace = { id: string; name: string; lastActiveMs: number };

/** Latest Buddy conversation activity per workspace (a list index field). */
export const buddyWorkspaceActivityAtom = listField('workspaceActivity');

// Most recently active workspace first (by its Buddies' latest conversation),
// then by name: the Channels tab opens where the team is working, not
// whichever workspace sorts first alphabetically (that was often an empty one).
export function overviewWorkspaces(
  overview: BuddyOverview | null,
  lastActive: ReadonlyMap<string, number>
): OverviewWorkspace[] {
  return (overview ?? [])
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      lastActiveMs: lastActive.get(workspace.id) ?? 0,
    }))
    .sort((a, b) => b.lastActiveMs - a.lastActiveMs || a.name.localeCompare(b.name));
}
