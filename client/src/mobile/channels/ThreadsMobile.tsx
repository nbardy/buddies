import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChannelLoader } from '../../components/buddies/ChannelLoader';
import { TypingDots } from '../../components/buddies/ChannelMarkdown';
import {
  type WorkspaceDirectory,
  channelHeading,
  channelRows,
  joinNames,
  useChannelResponding,
  useMarkRead,
} from '../../components/buddies/channel-data';
import { channelsHref } from '../../components/buddies/channels-view';
import {
  type ThreadCard,
  participantNames,
  useThreadsView,
} from '../../components/buddies/threads-view';
import { MobileEmptyPanel, MobilePage } from '../components/MobileUI';
import { ChannelComposerMobile } from './ChannelComposerMobile';
import '../../components/buddies/ThreadsPane.css';
import { Row, type RowContext } from './ChannelRowsMobile';

// The Threads view on a phone (product/buddies/THREADS_VIEW_2026-09-28.md): the desktop pane's
// cards in one column, with the tab bar kept (a list page, not a conversation). "View N previous
// replies" opens the thread screen: a card on a phone is too narrow to page inside.
export function ThreadsScreen({
  workspaceId,
  directory,
}: {
  workspaceId: string;
  directory: WorkspaceDirectory;
}) {
  const threads = useThreadsView(workspaceId);
  const { view, followed } = threads;
  return (
    <MobilePage
      title="Threads"
      subtitle={
        view !== null && view.newReplies > 0
          ? `${view.newReplies} new ${view.newReplies === 1 ? 'reply' : 'replies'}`
          : directory.workspaceName
      }
      headerAside={
        <Link className="threads-fold" to={channelsHref(workspaceId, { kind: 'home' })}>
          Channels
        </Link>
      }
    >
      {view !== null && view.updated > 0 && (
        <button
          type="button"
          className="threads-pill ui-control ui-badge--accent"
          onClick={threads.resort}
        >
          {view.updated} {view.updated === 1 ? 'thread' : 'threads'} updated · Show
        </button>
      )}
      {(followed.kind === 'failed' || followed.kind === 'stale') && (
        <p className="mobile-channel__error" role="alert">
          Threads could not refresh: {followed.error.message}
        </p>
      )}
      {view === null ? (
        <ChannelLoader label="Loading threads…" />
      ) : view.cards.length === 0 ? (
        <MobileEmptyPanel>Threads you start or reply in show up here.</MobileEmptyPanel>
      ) : (
        <ol className="threads-list ui-stack">
          {view.cards.map((card) => (
            <ThreadCardMobile
              key={card.thread.root.id}
              card={card}
              workspaceId={workspaceId}
              directory={directory}
              onPosted={() => void followed.refetch()}
            />
          ))}
        </ol>
      )}
      {threads.more && (
        <button type="button" className="threads-pill ui-control" onClick={threads.showMore}>
          Show more threads
        </button>
      )}
    </MobilePage>
  );
}

function ThreadCardMobile({
  card,
  workspaceId,
  directory,
  onPosted,
}: {
  card: ThreadCard;
  workspaceId: string;
  directory: WorkspaceDirectory;
  onPosted(): void;
}) {
  const { thread } = card;
  const channelId = thread.channel.id;
  const rootId = thread.root.id;
  const heading = channelHeading(thread.channel.kind, directory.buddyNames);
  const replying = useChannelResponding(channelId, directory.buddyNames).get(rootId);
  useMarkRead(
    { kind: 'thread', rootId },
    thread.tail.kind === 'unread',
    card.posts.at(-1)?.id ?? rootId
  );
  const context: RowContext = {
    directory,
    place: { kind: 'card', unread: card.unread },
    linkedPostId: null,
  };
  const rows = useMemo(() => channelRows([...card.posts].reverse()), [card.posts]);
  const threadHref = channelsHref(workspaceId, {
    kind: 'thread',
    channelId,
    rootId,
    linkedPostId: null,
  });
  return (
    <li className="threads-card ui-card ui-surface ui-stack">
      <Link className="threads-head ui-row" to={threadHref}>
        <strong className="ui-truncate">
          {heading.mark}
          {heading.name}
        </strong>
        {thread.channel.archivedAt && <span className="ui-muted">archived</span>}
        <span className="ui-muted ui-truncate">
          {joinNames(participantNames(thread, directory.buddyNames))}
        </span>
        <span className="threads-fold threads-open">Open thread ›</span>
      </Link>
      <ol className="mobile-channel__posts">
        <Row row={{ kind: 'lead', key: rootId, post: thread.root }} context={context} />
      </ol>
      {card.hidden > 0 && (
        <Link className="threads-fold" to={threadHref}>
          View {card.hidden} previous {card.hidden === 1 ? 'reply' : 'replies'}
        </Link>
      )}
      <ol className="mobile-channel__posts">
        {rows.map((row) => (
          <Row key={row.key} row={row} context={context} />
        ))}
      </ol>
      {replying !== undefined && (
        <p className="mobile-channel__replying">
          <TypingDots /> {replying}
        </p>
      )}
      {!thread.channel.archivedAt && (
        <ChannelComposerMobile
          title={`Thread in ${heading.mark} ${heading.name}`}
          channelId={channelId}
          rootId={rootId}
          placeholder="Reply…"
          references={directory.references}
          submit="button"
          onPosted={onPosted}
        />
      )}
    </li>
  );
}
