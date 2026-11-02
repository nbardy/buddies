import type { ExpeditionView } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { Link, useNavigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { invalidateChannelResources } from '../../atoms/resources';
import { ChannelComposer } from './ChannelComposer';
import { ChannelFeed, useChannelTimeline } from './ChannelFeed';
import type { RowContext } from './ChannelRows';
import { useWorkspaceDirectory, useWorkspaceInbox } from './channel-data';
import { channelsHref } from './channels-view';
import './Expedition.css';

export function ChatPane({ v }: { v: ExpeditionView }) {
  switch (v.crew.t) {
    case 'ready':
      return (
        <ExpeditionChat
          channelId={v.crew.chatChannelId}
          workspaceId={v.workspaceId}
          // A retiring expedition's crew is being archived: its chat is history.
          writable={v.retirement.t === 'active'}
        />
      );
    case 'pending':
      return <p className="buddy-panel__empty">Starting the crew… its chat opens here.</p>;
  }
}

/** The owner↔crew DM: every update lands here; a post wakes the crew to answer or steer. */
function ExpeditionChat({
  channelId,
  workspaceId,
  writable,
}: { channelId: string; workspaceId: string; writable: boolean }) {
  const navigate = useNavigate();
  const directory = useWorkspaceDirectory(workspaceId);
  const inbox = useWorkspaceInbox(workspaceId);
  const unread = inbox.data?.channels.find((entry) => entry.channel.id === channelId)?.unread ?? 0;
  const timeline = useChannelTimeline(channelId, unread);
  const availableConversationIds = useAtomValue(listField('idSet'));
  const context: RowContext = {
    workspaceId,
    directory,
    availableConversationIds,
    linkedPostId: null,
    openDm: (conversationId) => navigate(channelsHref(workspaceId, { kind: 'dm', conversationId })),
    place: { kind: 'thread' },
  };
  return (
    <section className="expedition-chat ui-stack" aria-label="Expedition chat">
      {/* The same DM, full size in the channels view, the way Slack opens one. */}
      <div className="expedition-chat-head ui-row">
        <h3 className="ui-section__title">Chat</h3>
        <Link
          className="expedition-chat-open ui-muted"
          to={channelsHref(workspaceId, { kind: 'channel', channelId })}
        >
          Open as DM ↗
        </Link>
      </div>
      <ChannelFeed
        timeline={timeline}
        context={context}
        firstUnread={null}
        label="chat"
        density="column"
      />
      {writable && (
        <ChannelComposer
          channelId={channelId}
          rootId={null}
          placeholder="Ask the expedition, or give it a lesson…"
          references={directory.references}
          submit="enter"
          onPosted={() => {
            timeline.follow.pin();
            invalidateChannelResources(channelId, []);
          }}
        />
      )}
    </section>
  );
}
