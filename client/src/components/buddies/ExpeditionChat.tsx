import type { ExpeditionChat as Chat } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useScrollActivity } from '../../hooks/useScrollActivity';
import { ChannelComposer, type ComposerSubmit } from './ChannelComposer';
import { ChannelLoader } from './ChannelLoader';
import { Replying, type RowContext, renderRow } from './ChannelRows';
import type { Frame } from './ExpeditionView';
import {
  CHANNEL_BACKSTOP_MS,
  type WorkspaceDirectory,
  threadPageResource,
  useThreadView,
} from './channel-data';
import { channelsHref } from './channels-view';
import { useExpeditionChat } from './expedition-api';

// The manager chat: the expedition's one thread in the owner<->crew DM (server host.ts chatRoot),
// drawn as the Chat tab the way a channel's feed is drawn (rows, then the composer pinned at the
// bottom). The crew answers there as manager (brief.ts CREW_ROLE); bare commands are the host's
// (it applies and answers them).

/** A live record's chat takes posts; a retired one's is history. */
export type ChatMode = 'live' | 'retired';
const SUBMIT: Record<Frame, ComposerSubmit> = { desktop: 'enter', mobile: 'button' };
const COMMANDS = 'Commands: pause · stop · extend 2h · pass · fail · note: …';

export function ExpeditionChat({
  id,
  mode,
  frame,
  directory,
}: { id: string; mode: ChatMode; frame: Frame; directory: WorkspaceDirectory }) {
  const chat = useExpeditionChat(id);
  if (chat.data !== null) return BODY[chat.data.t](chat.data as never, mode, frame, directory);
  return chat.kind === 'failed' ? (
    <p className="expedition-chat-empty ui-muted">The chat could not load: {chat.error.message}</p>
  ) : (
    <ChannelLoader label="Opening the chat…" />
  );
}

/** True while the Chat tab is closed and the thread has a post newer than the newest one seen
 * while it was open (or, before it was ever open, when the view first read the thread). */
export function useChatUnread(id: string, open: boolean): boolean {
  const chat = useExpeditionChat(id);
  const root = chat.data?.t === 'thread' ? chat.data.rootId : null;
  const page = usePolledFetch(root === null ? null : threadPageResource(root), CHANNEL_BACKSTOP_MS);
  const newest = page.data === null ? null : (page.data.posts[0]?.id ?? page.data.root.id);
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => {
    if (open || seen === null) setSeen(newest);
  }, [open, newest, seen]);
  return !open && seen !== null && newest !== seen;
}

const BODY: {
  [K in Chat['t']]: (
    c: Extract<Chat, { t: K }>,
    mode: ChatMode,
    frame: Frame,
    directory: WorkspaceDirectory
  ) => ReactNode;
} = {
  none: (c) => <p className="expedition-chat-empty ui-muted">{c.reason}</p>,
  thread: (c, mode, frame, directory) => (
    <ChatThread chat={c} frame={frame} directory={directory} writable={mode === 'live'} />
  ),
};

function ChatThread({
  chat,
  frame,
  directory,
  writable,
}: {
  chat: Extract<Chat, { t: 'thread' }>;
  frame: Frame;
  directory: WorkspaceDirectory;
  writable: boolean;
}) {
  const navigate = useNavigate();
  const availableConversationIds = useAtomValue(listField('idSet'));
  const scroll = useScrollActivity();
  // The crew is named after its expedition ("⛺ <goal>…", cut off on every row): here it is the
  // Manager (review 2026-11-03).
  const names = useMemo(
    () => ({ ...directory.buddyNames, [chat.crewBuddyId]: 'Manager' }),
    [directory.buddyNames, chat.crewBuddyId]
  );
  const view = useThreadView(chat.channelId, chat.rootId, null, names);
  const context: RowContext = {
    workspaceId: directory.workspaceId,
    directory: { ...directory, buddyNames: names },
    availableConversationIds,
    linkedPostId: null,
    openDm: (conversationId) =>
      navigate(channelsHref(directory.workspaceId, { kind: 'dm', conversationId })),
    place: { kind: 'thread' },
  };
  return (
    <section className="expedition-chat ui-stack" aria-label="Chat with the manager">
      <div
        className="channel-browser-scroll ui-stack ui-scroll-quiet"
        data-scrolling={scroll['data-scrolling']}
        ref={view.follow.scrollRef}
        onScroll={(event) => {
          view.follow.onScroll(event);
          scroll.onScroll();
        }}
      >
        {view.replyRows.length === 0 && view.replying === undefined ? (
          <p className="expedition-chat-empty ui-muted">
            Ask the manager anything: what an attempt learned, which branch to look at.
          </p>
        ) : (
          <ol className="channel-browser-messages">
            {view.replyRows.map((row) => renderRow(row, context))}
          </ol>
        )}
        {view.replying !== undefined && (
          <div className="channel-thread-replying">
            <Replying text={view.replying} />
          </div>
        )}
      </div>
      {writable && (
        <ChannelComposer
          channelId={chat.channelId}
          rootId={chat.rootId}
          placeholder="Message the manager"
          references={directory.references}
          submit={SUBMIT[frame]}
          hint={COMMANDS}
          onPosted={view.onPosted}
        />
      )}
    </section>
  );
}
