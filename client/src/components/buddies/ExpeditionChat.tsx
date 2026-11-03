import type { ExpeditionChat as Chat } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type ReactNode, useId, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { useScrollActivity } from '../../hooks/useScrollActivity';
import { ChannelComposer, type ComposerSubmit } from './ChannelComposer';
import { ChannelLoader } from './ChannelLoader';
import { Replying, type RowContext, renderRow } from './ChannelRows';
import type { Frame } from './ExpeditionView';
import { ThreadResize, useThreadPaneStyle } from './ThreadResize';
import { type WorkspaceDirectory, useThreadView } from './channel-data';
import { channelsHref } from './channels-view';
import { useExpeditionChat } from './expedition-api';

// The manager chat: the expedition's one thread in the owner<->crew DM (server host.ts chatRoot),
// where a channel's thread pane sits, the same width and drag handle. The crew answers there as
// manager (brief.ts CREW_ROLE); bare commands are the host's (it applies and answers them).

/** A live record's chat takes posts; a retired one's is history. */
export type ChatMode = 'live' | 'retired';
const SUBTITLE: Record<ChatMode, string> = {
  live: 'Ask about attempts, or steer the run',
  retired: 'Read-only history',
};
const SUBMIT: Record<Frame, ComposerSubmit> = { desktop: 'enter', mobile: 'button' };
const COMMANDS = 'Commands: pause · stop · extend 2h · pass · fail · note: …';

export function ExpeditionChat({
  id,
  mode,
  frame,
  directory,
}: { id: string; mode: ChatMode; frame: Frame; directory: WorkspaceDirectory }) {
  const chat = useExpeditionChat(id);
  const body: ReactNode =
    chat.data !== null ? (
      BODY[chat.data.t](chat.data as never, mode, frame, directory)
    ) : chat.kind === 'failed' ? (
      <p className="expedition-chat-empty ui-muted">
        The chat could not load: {chat.error.message}
      </p>
    ) : (
      <ChannelLoader label="Opening the chat…" />
    );
  return FRAME[frame](mode, body);
}

const FRAME: Record<Frame, (mode: ChatMode, body: ReactNode) => ReactNode> = {
  desktop: (mode, body) => <DesktopPane mode={mode}>{body}</DesktopPane>,
  mobile: (_mode, body) => (
    <section className="expedition-chat ui-stack" data-frame="mobile" aria-label="Chat">
      {body}
    </section>
  ),
};

function DesktopPane({ mode, children }: { mode: ChatMode; children: ReactNode }) {
  const style = useThreadPaneStyle();
  const paneId = useId();
  const paneRef = useRef<HTMLElement>(null);
  return (
    <aside
      id={paneId}
      ref={paneRef}
      className="channel-thread ui-stack expedition-chat"
      aria-label="Chat"
      style={style}
    >
      <ThreadResize paneId={paneId} paneRef={paneRef} label="Resize chat" />
      <header className="channel-thread-header ui-row">
        <div>
          <h2>Manager</h2>
          <p>{SUBTITLE[mode]}</p>
        </div>
      </header>
      {children}
    </aside>
  );
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
    <>
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
    </>
  );
}
