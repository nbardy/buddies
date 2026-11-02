import { type ReactElement, useMemo } from 'react';
import { useScrollActivity } from '../../hooks/useScrollActivity';
import { ChannelHistory, ChannelLoader } from './ChannelLoader';
import { type RowContext, renderRows } from './ChannelRows';
import {
  channelFeed,
  channelRows,
  feedPhase,
  newestServedId,
  renderFeed,
  useChannelFeed,
  useFollowBottom,
  useMarkRead,
  useWithOutbox,
} from './channel-data';

// Pattern: one-definition (docs/patterns.md#one-definition)
// The ONE channel timeline: the channels view's pane and the expedition modal's chat column both
// draw it. Owner 2026-11-03: the modal's chat had no mark-read and no follow-bottom because it
// carried its own copy of this; the behaviour lives in `useChannelTimeline`, so a new surface
// cannot leave it out.

export type ChannelTimeline = ReturnType<typeof useChannelTimeline>;

/** Feed + outbox + rows + follow-bottom + mark-read for one channel's newest posts. */
export function useChannelTimeline(channelId: string, unread: number) {
  const feed = useChannelFeed(channelFeed(channelId));
  const posts = useWithOutbox(channelId, null, feed.posts);
  const rows = useMemo(() => channelRows(posts ?? []), [posts]);
  const follow = useFollowBottom(rows.length, posts, null);
  useMarkRead({ kind: 'channel', channelId }, unread > 0, newestServedId(feed.posts));
  return { feed, posts, rows, follow };
}

/** Where the timeline sits: the channels view's full pane, or the modal's narrow column. */
export type FeedDensity = 'pane' | 'column';

const LAYOUT: Record<FeedDensity, { scroll: string; empty: (label: string) => ReactElement }> = {
  pane: {
    scroll: 'channel-browser-scroll ui-stack ui-scroll-quiet',
    empty: (label) => (
      <div className="channel-browser-empty ui-muted ui-row">
        <strong>{label}</strong>
        <span>No posts yet. Say hello, or @mention a Buddy to ask it something.</span>
      </div>
    ),
  },
  column: {
    scroll: 'channel-browser-scroll ui-scroll-quiet expedition-chat-messages',
    empty: () => <p className="buddy-panel__empty">No messages yet.</p>,
  },
};

export function ChannelFeed({
  timeline,
  context,
  firstUnread,
  label,
  density,
}: {
  timeline: ChannelTimeline;
  context: RowContext;
  firstUnread: string | null;
  label: string;
  density: FeedDensity;
}) {
  const { feed, posts, rows, follow } = timeline;
  const scrollActivity = useScrollActivity();
  const layout = LAYOUT[density];
  return (
    <div
      className={layout.scroll}
      data-scrolling={scrollActivity['data-scrolling']}
      ref={follow.scrollRef}
      onScroll={(event) => {
        follow.onScroll(event);
        scrollActivity.onScroll();
      }}
    >
      {(feed.latest.kind === 'failed' || feed.latest.kind === 'stale') && (
        <p className="channel-browser-error" role="alert">
          Posts could not refresh: {feed.latest.error.message}
        </p>
      )}
      {renderFeed(feedPhase(feed.latest.kind, posts), {
        loading: () => <ChannelLoader label={`Loading ${label}…`} />,
        failed: () => null,
        empty: () => layout.empty(label),
        posts: () => (
          <>
            <ChannelHistory
              edge={feed.edge}
              scrollRef={follow.scrollRef}
              onReach={() => void feed.loadOlder(follow.hold)}
            />
            <ol className="channel-browser-messages">{renderRows(rows, context, firstUnread)}</ol>
          </>
        ),
      })}
    </div>
  );
}
