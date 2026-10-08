import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BuddySigil } from '../../components/buddies/BuddySigil';
import { ChannelHeaderControls } from '../../components/buddies/ChannelArchive';
import { ChannelAuthor, type OpenDm } from '../../components/buddies/ChannelAuthor';
import { TypingDots } from '../../components/buddies/ChannelMarkdown';
import { ChannelPostContent } from '../../components/buddies/ChannelPostContent';
import { ConversationEye } from '../../components/buddies/ConversationEye';
import { CopyLinkButton } from '../../components/buddies/CopyLinkButton';
import { ReplyRetry } from '../../components/buddies/HarnessPicker';
import {
  type ChannelRow,
  type WorkspaceDirectory,
  authorName,
  clockTime,
  postPurposeLabel,
  postPurposeTag,
} from '../../components/buddies/channel-data';
import { channelLinkPath, postLink } from '../../components/buddies/channel-link';
import type { Channel, Post } from '../../components/buddies/types';
import { mobileConversationRouteState } from '../../utils/conversation-route-state';

// The mobile transcript's rows and screen header, shared by the channel, thread, Task and
// Threads screens.
// A Buddy DM stays inside Channels (493c1c7): the current query is kept, so Back (dropping `dm`)
// returns to the channel, thread or Home it was opened from.
export function useChannelsDm(): OpenDm {
  const navigate = useNavigate();
  const location = useLocation();
  return (conversationId) => {
    const params = new URLSearchParams(location.search);
    params.set('dm', conversationId);
    navigate(`${location.pathname}?${params}`);
  };
}

// ── Transcript rows ─────────────────────────────────────────────────────────

// Where a row sits: in the channel (tap Thread to open its thread, see who is
// replying), inside the thread already, or in the Task filter (posts from any
// channel, each linked into its own), or a Threads view card (new replies tinted).
// D = Channel ⊕ Thread ⊕ Task ⊕ Card.
export type RowPlace =
  | {
      kind: 'channel';
      threadHref(rootId: string): string;
      responding: ReadonlyMap<string, string>;
    }
  | { kind: 'thread' }
  | { kind: 'task'; workspaceId: string; channelNames: ReadonlyMap<string, string> }
  | { kind: 'card'; unread: ReadonlySet<string> };

export type RowContext = {
  directory: WorkspaceDirectory;
  place: RowPlace;
  // The reply a permalink named (`?post=`); its row is highlighted.
  linkedPostId: string | null;
};

function PostPurpose({ post }: { post: Post }) {
  const label = postPurposeLabel(post);
  return label === null ? null : (
    <span className="mobile-channel-post__purpose" data-purpose={postPurposeTag(post)}>
      {label}
    </span>
  );
}

// Posts carry no reply count (the API has none): every root offers its thread.
function PostFooter({ post, context }: { post: Post; context: RowContext }) {
  switch (context.place.kind) {
    case 'thread':
    case 'card':
      return null;
    case 'task':
      return (
        <div className="mobile-channel-post__footer ui-row">
          <Link
            className="mobile-channel-post__reply ui-inline-row ui-muted"
            to={channelLinkPath(context.place.workspaceId, postLink(post))}
          >
            {context.place.channelNames.get(post.channelId) ?? 'another channel'}
          </Link>
        </div>
      );
    case 'channel': {
      const place = context.place;
      const replying = place.responding.get(post.id);
      return (
        <div className="mobile-channel-post__footer ui-row">
          <Link
            className="mobile-channel-post__reply ui-inline-row ui-muted"
            to={place.threadHref(post.rootId ?? post.id)}
          >
            Thread
          </Link>
          {replying !== undefined && (
            <span className="mobile-channel-post__replying">
              <TypingDots /> {replying}
            </span>
          )}
        </div>
      );
    }
  }
}

function rowUnread(post: Post, context: RowContext): 'true' | undefined {
  switch (context.place.kind) {
    case 'card':
      return context.place.unread.has(post.id) ? 'true' : undefined;
    case 'channel':
    case 'thread':
    case 'task':
      return undefined;
  }
}

export function Row({ row, context }: { row: ChannelRow; context: RowContext }) {
  const openDm = useChannelsDm();
  const location = useLocation();
  // Back from the conversation page returns to this channel screen.
  const linkState = mobileConversationRouteState(location);
  switch (row.kind) {
    case 'day':
      return (
        <li className="mobile-channel-day">
          <span>{row.label}</span>
        </li>
      );
    case 'lead':
      return (
        <li
          className="mobile-channel-post mobile-channel-post--lead"
          data-purpose={postPurposeTag(row.post)}
          data-post-id={row.post.id}
          data-linked={row.post.id === context.linkedPostId ? 'true' : undefined}
          data-unread={rowUnread(row.post, context)}
        >
          <BuddySigil
            className="mobile-channel-post__avatar"
            name={authorName(row.post.author, context.directory.buddyNames)}
          />
          <div className="mobile-channel-post__content">
            <div className="mobile-channel-post__heading">
              <ChannelAuthor
                className="mobile-channel-post__author"
                author={row.post.author}
                buddyNames={context.directory.buddyNames}
                openDm={openDm}
              />
              <time dateTime={row.post.createdAt}>{clockTime(row.post.createdAt)}</time>
              <PostPurpose post={row.post} />
              <ConversationEye
                post={row.post}
                className="mobile-channel-post__reply ui-inline-row ui-muted"
                linkState={linkState}
              />
            </div>
            <ChannelPostContent post={row.post} directory={context.directory} />
            <ReplyRetry post={row.post} />
            <PostFooter post={row.post} context={context} />
          </div>
        </li>
      );
    case 'continuation':
      return (
        <li
          className="mobile-channel-post mobile-channel-post--continuation"
          data-purpose={postPurposeTag(row.post)}
          data-post-id={row.post.id}
          data-linked={row.post.id === context.linkedPostId ? 'true' : undefined}
          data-unread={rowUnread(row.post, context)}
        >
          <div className="mobile-channel-post__content">
            <PostPurpose post={row.post} />
            <ConversationEye
              post={row.post}
              className="mobile-channel-post__reply ui-inline-row ui-muted"
              linkState={linkState}
            />
            <ChannelPostContent post={row.post} directory={context.directory} />
            <ReplyRetry post={row.post} />
            <PostFooter post={row.post} context={context} />
          </div>
        </li>
      );
  }
}

export function ScreenHeader({
  backTo,
  title,
  subtitle,
  link,
  channel,
  settings,
}: {
  backTo: string;
  title: string;
  subtitle: string;
  link: { path: string; label: string };
  channel?: Channel;
  settings?: ReactNode;
}) {
  return (
    <header className="mobile-channel-header ui-row" data-channel-header>
      <Link className="mobile-channel-header__back" to={backTo} aria-label="Back">
        ‹
      </Link>
      <div className="mobile-channel-header__heading">
        <h1>{title}</h1>
      </div>
      {channel && (
        <ChannelHeaderControls channel={channel} description={subtitle}>
          {settings}
        </ChannelHeaderControls>
      )}
      <CopyLinkButton
        className="mobile-channel-header__link channel-header-copy ui-muted"
        path={link.path}
        label={link.label}
      />
    </header>
  );
}
