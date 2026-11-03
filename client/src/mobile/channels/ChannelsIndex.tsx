import { useAtomValue } from 'jotai';
import { Navigate } from 'react-router-dom';
import { type ChannelsView, channelsHref } from '../../components/buddies/channels-view';
import {
  buddyWorkspaceActivityAtom,
  overviewWorkspaces,
} from '../../components/buddies/workspace-order';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { MobileEmptyPanel, MobilePage } from '../components/MobileUI';

// Its own module because BOTH device trees route /channels here (App.tsx).
// Living in ChannelsMobile.tsx made the desktop load the mobile channels chunk.

/** /channels — the tab's entry: open the most recently active workspace's channels. */
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
