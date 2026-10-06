import { useEffect, useState } from 'react';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { actorName } from './BuddyTaskComments';
import { buddyWrite, postToBuddyDm } from './api';
import type {
  Actor,
  ChannelPage,
  ChannelUnread,
  Inbox,
  Post,
  ThreadPage,
  ThreadStat,
} from './types';
import { ActionError, useBuddyAction } from './useBuddyAction';

export const inboxUrl = (workspaceId: string): string =>
  `/api/buddies/workspaces/${encodeURIComponent(workspaceId)}/inbox`;

const channelPostsUrl = (channelId: string): string =>
  `/api/buddies/channels/${encodeURIComponent(channelId)}/posts?limit=50`;

const isMember = (members: readonly Actor[], buddyId: string) =>
  members.some((member) => member.kind === 'buddy' && member.id === buddyId);

/** The owner↔Buddy DM: the direct channel whose members are exactly the owner and this Buddy. */
export function ownerDirectChannel(inbox: Inbox, buddyId: string): ChannelUnread | undefined {
  return inbox.channels.find(
    ({ channel }) =>
      channel.kind.type === 'direct' &&
      channel.kind.members.length === 2 &&
      channel.kind.members.some((member) => member.kind === 'owner') &&
      isMember(channel.kind.members, buddyId)
  );
}

/** A request's lifecycle as a label; `none` is an ordinary post and shows nothing. */
const REQUEST_LABEL: { [K in Post['request']['state']]: string | null } = {
  none: null,
  awaiting: 'Awaiting an answer',
  answered: 'Answered',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

function AnswerForm({ request, refresh }: { request: Post; refresh: () => Promise<void> }) {
  const [body, setBody] = useState('');
  const action = useBuddyAction(refresh);
  return (
    <form
      className="buddy-panel__form"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run('answer', () =>
          buddyWrite(
            'channel.post',
            { channelId: request.channelId },
            { body, answers: request.id }
          )
        );
      }}
    >
      <textarea
        aria-label="Answer"
        rows={3}
        placeholder="Your answer"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <button type="submit" disabled={action.busy || !body.trim()}>
        Send answer
      </button>
      <ActionError state={action.state} />
    </form>
  );
}

function SendForm({ buddyId, refresh }: { buddyId: string; refresh: () => Promise<void> }) {
  const [body, setBody] = useState('');
  const [request, setRequest] = useState(false);
  const action = useBuddyAction(refresh);
  return (
    <form
      className="buddy-panel__form"
      onSubmit={(event) => {
        event.preventDefault();
        void action
          .run('send', () => postToBuddyDm(buddyId, { body, kind: request ? 'request' : 'inform' }))
          .then((ok) => ok && setBody(''));
      }}
    >
      <textarea
        aria-label="Message"
        rows={3}
        placeholder="Message this Buddy"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <label className="buddy-panel__check">
        <input
          type="checkbox"
          checked={request}
          onChange={(event) => setRequest(event.target.checked)}
        />
        Ask for an answer
      </label>
      <button type="submit" disabled={action.busy || !body.trim()}>
        Send
      </button>
      <ActionError state={action.state} />
    </form>
  );
}

/**
 * Post to a workspace channel AS this Buddy (a standup, a handoff, an announcement), as the Messages
 * tab offered before T11. The server writes it with the Buddy as author; its @mentions start turns as that Buddy's.
 */
export function PostAsBuddyForm({
  buddyId,
  inbox,
  refresh,
}: {
  buddyId: string;
  inbox: Inbox;
  refresh: () => Promise<void>;
}) {
  const channels = inbox.channels.flatMap(({ channel }) =>
    channel.kind.type === 'public' ? [{ id: channel.id, name: channel.kind.name }] : []
  );
  const [channelId, setChannelId] = useState('');
  const [purpose, setPurpose] = useState('standup');
  const [body, setBody] = useState('');
  const action = useBuddyAction(refresh);
  const target = channelId || channels[0]?.id || '';
  if (channels.length === 0) return null;
  return (
    <form
      className="buddy-panel__form"
      aria-label="Post as this Buddy"
      onSubmit={(event) => {
        event.preventDefault();
        void action
          .run('post', () =>
            buddyWrite(
              'channel.post',
              { channelId: target },
              {
                asBuddyId: buddyId,
                purpose: purpose.trim(),
                body,
              }
            )
          )
          .then((ok) => ok && setBody(''));
      }}
    >
      <label>
        Channel
        <select value={target} onChange={(event) => setChannelId(event.target.value)}>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              #{channel.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Kind
        <input
          value={purpose}
          maxLength={200}
          placeholder="standup, handoff, announcement, decision"
          onChange={(event) => setPurpose(event.target.value)}
        />
      </label>
      <textarea
        aria-label="Post"
        rows={3}
        placeholder="Post to the channel as this Buddy"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <button type="submit" disabled={action.busy || !purpose.trim() || !body.trim()}>
        Post as Buddy
      </button>
      <ActionError state={action.state} />
    </form>
  );
}

const threadUrl = (rootId: string): string =>
  `/api/buddies/posts/${encodeURIComponent(rootId)}/thread?limit=50`;

/** One post's body, evidence and request label: the DM row and each thread reply. */
function PostBody({ post, names }: { post: Post; names: Readonly<Record<string, string>> }) {
  const label = REQUEST_LABEL[post.request.state];
  return (
    <>
      <div className="buddy-post-list__meta">
        <strong>{actorName(post.author, names)}</strong>
        {label && <span className="buddy-dm__request">{label}</span>}
        <time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleString()}</time>
      </div>
      <p className="buddy-post-list__body">{post.body}</p>
      {post.evidence.length > 0 && (
        <ul className="buddy-post-list__evidence">
          {post.evidence.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A DM thread's replies (oldest first) and the owner's reply form; read only while open. */
function ThreadReplies({
  root,
  names,
}: {
  root: Post;
  names: Readonly<Record<string, string>>;
}) {
  const page = usePolledFetch<ThreadPage>(threadUrl(root.id), 0);
  const [body, setBody] = useState('');
  const action = useBuddyAction(page.refetch);
  return (
    <>
      {page.kind === 'failed' && (
        <p className="buddy-panel__error" role="alert">
          {page.error.message}
        </p>
      )}
      {page.data && (
        <ol className="buddy-post-list">
          {[...page.data.posts].reverse().map((reply) => (
            <li key={reply.id}>
              <PostBody post={reply} names={names} />
            </li>
          ))}
        </ol>
      )}
      <form
        className="buddy-panel__form"
        onSubmit={(event) => {
          event.preventDefault();
          void action
            .run('reply', () =>
              buddyWrite(
                'channel.post',
                { channelId: root.channelId },
                { body, replyToId: root.id }
              )
            )
            .then((ok) => ok && setBody(''));
        }}
      >
        <textarea
          aria-label="Reply"
          rows={2}
          placeholder="Reply in thread"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <button type="submit" disabled={action.busy || !body.trim()}>
          Reply
        </button>
        <ActionError state={action.state} />
      </form>
    </>
  );
}

/** A post's thread, collapsed to its reply count and last reply until opened. */
function DmThread({
  root,
  stat,
  names,
}: {
  root: Post;
  stat: ThreadStat | undefined;
  names: Readonly<Record<string, string>>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {stat === undefined
          ? 'Reply'
          : `${stat.replies} ${stat.replies === 1 ? 'reply' : 'replies'} · last reply ${new Date(stat.lastReplyAt).toLocaleString()}`}
      </summary>
      {open && <ThreadReplies root={root} names={names} />}
    </details>
  );
}

/**
 * The owner's own requests to this Buddy that still await its answer (the inbox's `waitingOn`,
 * narrowed to the DM), oldest first.
 */
export function BuddyWaitingOn({
  waitingOn,
  buddyName,
}: {
  waitingOn: readonly Post[];
  buddyName: string;
}) {
  if (waitingOn.length === 0) return null;
  return (
    <>
      <h3 className="buddy-panel__heading">Waiting on {buddyName}</h3>
      <ol className="buddy-post-list" aria-label={`Waiting on ${buddyName}`}>
        {[...waitingOn]
          .sort((a, b) => a.ord.localeCompare(b.ord))
          .map((post) => (
            <li key={post.id}>
              <div className="buddy-post-list__meta">
                <time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleString()}</time>
              </div>
              <p className="buddy-post-list__body">{post.body}</p>
            </li>
          ))}
      </ol>
    </>
  );
}

/** The DM's top-level posts, oldest first, with the owner's answer forms under open requests. */
export function BuddyDirectPosts({
  posts,
  threads,
  awaitingOwner,
  names,
  refresh,
}: {
  posts: readonly Post[];
  threads: readonly ThreadStat[];
  awaitingOwner: ReadonlySet<string>;
  names: Readonly<Record<string, string>>;
  refresh: () => Promise<void>;
}) {
  if (posts.length === 0) return <p className="buddy-panel__empty">No messages yet.</p>;
  return (
    <ol className="buddy-post-list">
      {[...posts].reverse().map((post) => (
        <li key={post.id} data-request={post.request.state}>
          <PostBody post={post} names={names} />
          {awaitingOwner.has(post.id) && <AnswerForm request={post} refresh={refresh} />}
          <DmThread
            root={post}
            stat={threads.find((stat) => stat.rootId === post.id)}
            names={names}
          />
        </li>
      ))}
    </ol>
  );
}

function DirectChannel({
  direct,
  buddyName,
  inbox,
  names,
  refreshInbox,
}: {
  direct: ChannelUnread;
  buddyName: string;
  inbox: Inbox;
  names: Readonly<Record<string, string>>;
  refreshInbox: () => Promise<void>;
}) {
  const channelId = direct.channel.id;
  const page = usePolledFetch<ChannelPage>(channelPostsUrl(channelId), 30_000);
  const newest = page.data?.posts[0]?.id;
  // Seeing the DM reads it through the newest post rendered; a later post stays unread.
  useEffect(() => {
    if (newest === undefined || direct.unread === 0) return;
    void buddyWrite('read', {}, { channelId, postId: newest }).catch((error: unknown) =>
      console.warn('[buddies] could not mark the DM read:', error)
    );
  }, [channelId, newest, direct.unread]);
  const awaitingOwner = new Set(
    inbox.requests.filter((post) => post.channelId === channelId).map((post) => post.id)
  );
  const refresh = async () => {
    await Promise.all([page.refetch(), refreshInbox()]);
  };
  switch (page.kind) {
    case 'idle':
    case 'loading':
      return <p className="buddy-panel__empty">Loading messages…</p>;
    case 'failed':
      return (
        <p className="buddy-panel__error" role="alert">
          {page.error.message}
        </p>
      );
    case 'ready':
    case 'stale':
      return (
        <>
          <BuddyWaitingOn
            waitingOn={inbox.waitingOn.filter((post) => post.channelId === channelId)}
            buddyName={buddyName}
          />
          <BuddyDirectPosts
            posts={page.data.posts}
            threads={page.data.threads}
            awaitingOwner={awaitingOwner}
            names={names}
            refresh={refresh}
          />
        </>
      );
  }
}

/**
 * The Messages tab: the owner's DM with this Buddy. Requests are posts whose
 * `request.state` is tracked; the ones awaiting the owner come from the inbox.
 */
export function BuddyMessages({
  buddyId,
  workspaceId,
  names,
}: {
  buddyId: string;
  workspaceId: string;
  names: Readonly<Record<string, string>>;
}) {
  const inbox = usePolledFetch<Inbox>(inboxUrl(workspaceId), 30_000);
  const direct = inbox.data ? ownerDirectChannel(inbox.data, buddyId) : undefined;
  return (
    <section className="buddy-panel" aria-label="Messages">
      <div className="buddy-panel__title ui-row">
        <h2>Messages</h2>
      </div>
      <SendForm buddyId={buddyId} refresh={inbox.refetch} />
      {inbox.kind === 'failed' && (
        <p className="buddy-panel__error" role="alert">
          {inbox.error.message}
        </p>
      )}
      {(inbox.kind === 'loading' || inbox.kind === 'idle') && (
        <p className="buddy-panel__empty">Loading messages…</p>
      )}
      {inbox.data && direct === undefined && <p className="buddy-panel__empty">No messages yet.</p>}
      {inbox.data && direct && (
        <DirectChannel
          direct={direct}
          buddyName={actorName({ kind: 'buddy', id: buddyId }, names)}
          inbox={inbox.data}
          names={names}
          refreshInbox={inbox.refetch}
        />
      )}
      {inbox.data && (
        <PostAsBuddyForm buddyId={buddyId} inbox={inbox.data} refresh={inbox.refetch} />
      )}
    </section>
  );
}
