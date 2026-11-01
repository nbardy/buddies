import { useAtomValue } from 'jotai';
import { Navigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { type ChannelsView, channelsHref } from '../../components/buddies/channels-view';
import type { BuddyOverview } from '../../components/buddies/types';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { MobileEmptyPanel, MobilePage } from '../components/MobileUI';

// Its own module because BOTH device trees route /channels here (App.tsx).
// Living in ChannelsMobile.tsx made the desktop load the mobile channels chunk.

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

/** /channels — the tab's entry: open the most recently active workspace's channels. Also
 * /expeditions (`screen` expeditions): the old index URL lands on that workspace's index pane. */
export function ChannelsIndex({ screen }: { screen: ChannelsView }) {
  const overview = useBuddyOverview();
  const [first] = overviewWorkspaces(overview.data, useAtomValue(buddyWorkspaceActivityAtom));
  if (first) return <Navigate to={channelsHref(first.id, screen)} replace />;
  return (
    <MobilePage title="Channels" subtitle={overview.data ? 'No workspaces' : 'Loading…'}>
      {overview.data && (
        <MobileEmptyPanel>Create a Buddy in a workspace to start its channels.</MobileEmptyPanel>
      )}
    </MobilePage>
  );
}
