import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { rowFamily } from '../../atoms/conversations';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { ChannelLoader } from './ChannelLoader';
import { channelLinkPath } from './channel-link';

// Fix guard: sidebar and directory links still address /chat/:id. Resolve Builder chats
// into their workspace's Channels route so these entry points cannot revive the old UI.
export function BuilderChatRoute({ id, children }: { id: string; children: ReactNode }) {
  const row = useAtomValue(rowFamily(id));
  return row?.kind.t === 'builder' ? <BuilderDestination id={id} cwd={row.cwd} /> : children;
}

function BuilderDestination({ id, cwd }: { id: string; cwd: string }) {
  const overview = useBuddyOverview();
  const workspace = overview.data?.find((entry) => entry.rootPath === cwd);
  if (workspace)
    return (
      <Navigate replace to={channelLinkPath(workspace.id, { kind: 'dm', conversationId: id })} />
    );
  if (overview.data || overview.kind === 'failed')
    return <p role="alert">Could not find this Builder's workspace.</p>;
  return <ChannelLoader label="Opening Buddy Builder…" />;
}
