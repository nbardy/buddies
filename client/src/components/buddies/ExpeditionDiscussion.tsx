import type { ExpeditionDiscussion as Discussion, ExpeditionView } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { useScrollActivity } from '../../hooks/useScrollActivity';
import { buddyWrite } from './api';
import { ChannelComposer } from './ChannelComposer';
import { ChannelHistory, ChannelLoader } from './ChannelLoader';
import { Replying, type RowContext, renderRow } from './ChannelRows';
import { type WorkspaceDirectory, useThreadView, useWorkspaceDirectory } from './channel-data';
import { channelsHref } from './channels-view';

type Frame = 'desktop' | 'mobile';

function DiscussionThread({
  thread,
  directory,
  posted,
}: {
  thread: Discussion;
  directory: WorkspaceDirectory;
  posted: RefObject<(() => void) | undefined>;
}) {
  const navigate = useNavigate();
  const { workspaceId } = directory;
  const ids = useAtomValue(listField('idSet'));
  const scroll = useScrollActivity();
  const view = useThreadView(thread.channelId, thread.rootId, null, directory.buddyNames);
  useLayoutEffect(() => {
    posted.current = view.onPosted;
  }, [posted, view.onPosted]);
  const context: RowContext = {
    workspaceId,
    directory,
    availableConversationIds: ids,
    linkedPostId: null,
    openDm: (conversationId) => navigate(channelsHref(workspaceId, { kind: 'dm', conversationId })),
    place: { kind: 'thread' },
  };
  return (
    <div
      className="channel-browser-scroll ui-stack ui-scroll-quiet"
      data-scrolling={scroll['data-scrolling']}
      ref={view.follow.scrollRef}
      onScroll={(event) => {
        view.follow.onScroll(event);
        scroll.onScroll();
      }}
    >
      {(view.thread.latest.kind === 'failed' || view.thread.latest.kind === 'stale') && (
        <p role="alert" className="channel-browser-error">
          {view.thread.latest.error.message}
        </p>
      )}
      {view.thread.latest.kind === 'loading' && <ChannelLoader label="Loading discussion…" />}
      {view.root && (
        <ChannelHistory
          edge={view.thread.edge}
          scrollRef={view.follow.scrollRef}
          onReach={() => void view.thread.loadOlder(view.follow.hold)}
        />
      )}
      {view.root && view.replyRows.length === 0 && view.replying === undefined && (
        <p className="expedition-discussion-empty ui-muted">Ask about this expedition.</p>
      )}
      <ol className="channel-browser-messages">
        {view.replyRows.map((row) => renderRow(row, context))}
      </ol>
      {view.replying !== undefined && <Replying text={view.replying} />}
    </div>
  );
}

export function ExpeditionDiscussion({
  expedition,
  frame,
  refresh,
}: {
  expedition: ExpeditionView;
  frame: Frame;
  refresh(): Promise<void>;
}) {
  const [opened, setOpened] = useState<Discussion>();
  const posted = useRef<() => void>(undefined);
  const directory = useWorkspaceDirectory(expedition.workspaceId);
  const thread = expedition.discussion ?? opened;
  const manager = directory.buddyNames[expedition.managerId];
  // Keep the draft's storage key when the first send creates the thread.
  const draftId = `expedition-discussion:${expedition.id}`;
  return (
    <section className="expedition-discussion ui-stack" aria-label="Chat with the manager">
      {thread ? (
        <DiscussionThread thread={thread} directory={directory} posted={posted} />
      ) : (
        <div className="channel-browser-scroll ui-stack">
          <p className="expedition-discussion-empty ui-muted">
            Ask {manager ?? 'the manager'} about this expedition.
          </p>
        </div>
      )}
      <ChannelComposer
        {...(thread
          ? { channelId: thread.channelId }
          : {
              channelId: null,
              prepareDestination: async () => {
                const destination = await buddyWrite('expedition.discussion', {
                  id: expedition.id,
                });
                setOpened(destination);
                void refresh();
                return destination;
              },
            })}
        rootId={thread?.rootId ?? null}
        draftId={draftId}
        placeholder={manager ? `Message ${manager}` : 'Message the manager'}
        references={directory.references}
        submit={frame === 'desktop' ? 'enter' : 'button'}
        onPosted={() => posted.current?.()}
      />
    </section>
  );
}
