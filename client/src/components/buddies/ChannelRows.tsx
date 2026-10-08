import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BuddySigil } from './BuddySigil';
import { ChannelAuthor, type OpenDm } from './ChannelAuthor';
import { TypingDots } from './ChannelMarkdown';
import { ChannelPostContent } from './ChannelPostContent';
import { ConversationEye } from './ConversationEye';
import { CopyLinkButton } from './CopyLinkButton';
import { ReplyRetry } from './HarnessPicker';
import {
  type ChannelRow,
  type WorkspaceDirectory,
  authorName,
  clockTime,
  postPurposeLabel,
  postPurposeTag,
} from './channel-data';
import { channelLinkPath, postLink } from './channel-link';
import type { Post, ThreadStat } from './types';

// The desktop transcript's rows, shared by the channel, thread, Task filter and Threads panes.
// Where a row renders decides what its thread affordance does:
// D = Channel(open a thread, show who is replying) ⊕ Thread(already inside one)
//   ⊕ Task(the Task filter: posts from any channel, each linked into its own) ⊕ Card.
export type RowPlace =
  | {
      kind: 'channel';
      openThread(rootId: string): void;
      responding: ReadonlyMap<string, string>;
      threads: ReadonlyMap<string, ThreadStat>;
      unreadThreads: ReadonlySet<string>;
    }
  | { kind: 'thread' }
  | { kind: 'task'; channelNames: ReadonlyMap<string, string> }
  // A Threads view card: inside one thread, with this visit's new replies tinted.
  | { kind: 'card'; unread: ReadonlySet<string> };

export type RowContext = {
  workspaceId: string;
  // The post a permalink named (`?post=`); its row is highlighted.
  linkedPostId: string | null;
  directory: WorkspaceDirectory;
  availableConversationIds: ReadonlySet<string>;
  openDm: OpenDm;
  place: RowPlace;
};

// Instance label: which conversation, of possibly several running as the same
// Buddy, wrote the post. A link only when the client still holds the thread
// (AGENTS.md: "open this conversation" affordances are availability-checked).
function InstanceTag({
  conversationId,
  available,
}: {
  conversationId: string;
  available: boolean;
}) {
  const label = `conv ${conversationId.slice(0, 8)}`;
  return available ? (
    <Link
      className="channel-browser-instance ui-muted"
      to={`/chat/${encodeURIComponent(conversationId)}`}
      title={`Open conversation ${conversationId}`}
    >
      {label}
    </Link>
  ) : (
    <span className="channel-browser-instance ui-muted" title={conversationId}>
      {label}
    </span>
  );
}

function PostPurpose({ post }: { post: Post }) {
  const label = postPurposeLabel(post);
  return label === null ? null : (
    <span className="channel-browser-purpose" data-purpose={postPurposeTag(post)}>
      {label}
    </span>
  );
}

// In the Task filter a row may come from any channel: name it, linked to the
// post in its own channel (the permalink opens the thread when it is a reply).
function PostChannel({ post, context }: { post: Post; context: RowContext }) {
  switch (context.place.kind) {
    case 'channel':
    case 'thread':
    case 'card':
      return null;
    case 'task':
      return (
        <Link
          className="channel-browser-instance ui-muted"
          to={channelLinkPath(context.workspaceId, postLink(post))}
        >
          {context.place.channelNames.get(post.channelId) ?? 'another channel'}
        </Link>
      );
  }
}

// A reply also sent to the channel ("Also send to #channel") names the thread it belongs to.
function BroadcastOrigin({ post, context }: { post: Post; context: RowContext }) {
  const rootId = post.rootId;
  if (!post.broadcast || rootId === undefined) return null;
  switch (context.place.kind) {
    case 'thread':
    case 'card':
      return null;
    case 'task':
      return <span className="channel-browser-instance ui-muted">replied to a thread</span>;
    case 'channel': {
      const place = context.place;
      return (
        <button
          type="button"
          className="channel-browser-instance channel-browser-broadcast ui-muted"
          onClick={() => place.openThread(rootId)}
        >
          replied to a thread
        </button>
      );
    }
  }
}

function PostMeta({ post, context }: { post: Post; context: RowContext }) {
  return (
    <>
      <BroadcastOrigin post={post} context={context} />
      <PostChannel post={post} context={context} />
      <PostPurpose post={post} />
      {post.conversationId && (
        <InstanceTag
          conversationId={post.conversationId}
          available={context.availableConversationIds.has(post.conversationId)}
        />
      )}
    </>
  );
}

export function Replying({ text }: { text: string }) {
  return (
    <span className="channel-browser-replying ui-inline-row ui-muted" aria-live="polite">
      <TypingDots />
      {text}
    </span>
  );
}

// "N replies · Last reply 10:42" under a thread root in the channel, bold with
// a dot while it has replies the owner has not read, plus the live replying
// indicator. The T11 migration dropped the count (the API had none); T22.
function ThreadSummary({ post, context }: { post: Post; context: RowContext }) {
  switch (context.place.kind) {
    case 'thread':
    case 'task':
    case 'card':
      return null;
    case 'channel': {
      const place = context.place;
      const replying = place.responding.get(post.id);
      const stat = place.threads.get(post.id);
      if (stat === undefined && replying === undefined) return null;
      const unread = place.unreadThreads.has(post.id);
      return (
        <div className="channel-browser-thread-summary ui-row">
          {stat === undefined ? (
            <button type="button" onClick={() => place.openThread(post.id)}>
              <strong>Open thread</strong>
            </button>
          ) : (
            <button
              type="button"
              data-unread={unread || undefined}
              onClick={() => place.openThread(post.id)}
            >
              {unread && (
                <span className="channel-browser-thread-unread" aria-label="New replies" />
              )}
              <strong>
                {stat.replies} {stat.replies === 1 ? 'reply' : 'replies'}
              </strong>
              <span>Last reply {clockTime(stat.lastReplyAt)}</span>
            </button>
          )}
          {replying !== undefined && <Replying text={replying} />}
        </div>
      );
    }
  }
}

function ReplyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h0a2 2 0 0 1-1.5-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReplyAction({ post, context }: { post: Post; context: RowContext }) {
  switch (context.place.kind) {
    case 'thread':
    case 'task':
    case 'card':
      return null;
    case 'channel': {
      const place = context.place;
      return (
        <button
          type="button"
          className="channel-browser-message-action"
          onClick={() => place.openThread(post.rootId ?? post.id)}
          title="Reply in thread"
          aria-label="Reply in thread"
        >
          <ReplyIcon />
        </button>
      );
    }
  }
}

// Slack's hover toolbar: a small floating group pinned to the message's
// top-right corner, straddling its top edge so it never covers the text.
function MessageActions({ post, context }: { post: Post; context: RowContext }) {
  return (
    <div className="channel-browser-message-actions" role="toolbar" aria-label="Message actions">
      <ConversationEye post={post} className="channel-browser-message-action" linkState={null} />
      <ReplyAction post={post} context={context} />
      <CopyLinkButton
        className="channel-browser-message-action"
        path={channelLinkPath(context.workspaceId, postLink(post))}
        label="Copy link to message"
      />
    </div>
  );
}

function PostBody({ post, context }: { post: Post; context: RowContext }) {
  return <ChannelPostContent post={post} directory={context.directory} />;
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

export function LeadRow({
  post,
  context,
  children,
}: { post: Post; context: RowContext; children?: ReactNode }) {
  return (
    <li
      className="channel-browser-message channel-browser-message--lead"
      data-purpose={postPurposeTag(post)}
      data-post-id={post.id}
      data-linked={post.id === context.linkedPostId ? 'true' : undefined}
      data-unread={rowUnread(post, context)}
    >
      <BuddySigil
        className="channel-browser-avatar"
        name={authorName(post.author, context.directory.buddyNames)}
      />
      <div className="channel-browser-message-content">
        <div className="channel-browser-message-heading">
          <ChannelAuthor
            className="channel-browser-author"
            author={post.author}
            buddyNames={context.directory.buddyNames}
            openDm={context.openDm}
          />
          <time dateTime={post.createdAt} title={new Date(post.createdAt).toLocaleString()}>
            {clockTime(post.createdAt)}
          </time>
          <PostMeta post={post} context={context} />
        </div>
        <PostBody post={post} context={context} />
        <ReplyRetry post={post} />
        <ThreadSummary post={post} context={context} />
        {children}
      </div>
      <MessageActions post={post} context={context} />
    </li>
  );
}

function ContinuationRow({ post, context }: { post: Post; context: RowContext }) {
  return (
    <li
      className="channel-browser-message channel-browser-message--continuation"
      data-purpose={postPurposeTag(post)}
      data-post-id={post.id}
      data-linked={post.id === context.linkedPostId ? 'true' : undefined}
      data-unread={rowUnread(post, context)}
    >
      <time
        className="channel-browser-gutter-time ui-muted"
        dateTime={post.createdAt}
        title={new Date(post.createdAt).toLocaleString()}
      >
        {clockTime(post.createdAt)}
      </time>
      <div className="channel-browser-message-content">
        <span className="channel-browser-inline-meta">
          <PostMeta post={post} context={context} />
        </span>
        <PostBody post={post} context={context} />
        <ReplyRetry post={post} />
        <ThreadSummary post={post} context={context} />
      </div>
      <MessageActions post={post} context={context} />
    </li>
  );
}

function DayRow({ label }: { label: string }) {
  return (
    <li className="channel-browser-day ui-row" aria-label={label}>
      <span>{label}</span>
    </li>
  );
}

// Slack's "New messages" line, above the first post the owner had not read
// when they opened the channel (T22). The day divider's rule, in red.
function NewMessagesRow() {
  return (
    <li
      className="channel-browser-day channel-browser-new-messages ui-row"
      aria-label="New messages"
    >
      <span>New messages</span>
    </li>
  );
}

export function renderRows(
  rows: readonly ChannelRow[],
  context: RowContext,
  firstUnread: string | null
) {
  return rows.flatMap((row) =>
    row.kind !== 'day' && row.post.id === firstUnread
      ? [<NewMessagesRow key="new-messages" />, renderRow(row, context)]
      : [renderRow(row, context)]
  );
}

export function renderRow(row: ChannelRow, context: RowContext) {
  switch (row.kind) {
    case 'day':
      return <DayRow key={row.key} label={row.label} />;
    case 'lead':
      return <LeadRow key={row.key} post={row.post} context={context} />;
    case 'continuation':
      return <ContinuationRow key={row.key} post={row.post} context={context} />;
  }
}
