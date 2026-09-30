import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { actorName } from './BuddyTaskComments';
import { TaskDetailBody, taskDetailUrl } from './BuddyWork';
import { ChannelComposer, type ComposerSubmit } from './ChannelComposer';
import { ChannelMarkdown } from './ChannelMarkdown';
import {
  CHANNEL_BACKSTOP_MS,
  type WorkspaceDirectory,
  channelPostBody,
  taskPostsFeed,
  useChannelFeed,
} from './channel-data';
import { channelsHref } from './channels-view';
import type { TaskDetail } from './types';
import { taskStatusView } from './ui-contract';

// Home opened only a message filter, hiding criteria and children.
// Guard: task-page.test.tsx renders the Home destination and checks its linked hierarchy.
// Pattern: one-write-path (docs/patterns.md#one-write-path)
export function TaskPage({
  taskId,
  workspaceId,
  channelId,
  directory,
  submit,
}: {
  taskId: string;
  workspaceId: string;
  channelId: string;
  directory: WorkspaceDirectory;
  submit: ComposerSubmit;
}) {
  const detail = usePolledFetch<TaskDetail>(taskDetailUrl(taskId), CHANNEL_BACKSTOP_MS);
  const feed = useChannelFeed(taskPostsFeed(taskId));
  const [replyTo, setReplyTo] = useState<{ rootId: string; channelId: string } | null>(null);
  const href = (id: string) => channelsHref(workspaceId, { kind: 'task', channelId, taskId: id });
  const task = detail.data?.task;
  const parent = task?.parentId ? directory.tasks.find((item) => item.id === task.parentId) : null;
  if (!detail.data)
    return <output>{detail.kind === 'failed' ? detail.error.message : 'Loading task…'}</output>;
  const status = taskStatusView(detail.data.task.status);
  return (
    <section
      className="ui-stack ui-card"
      aria-label="Task details"
      style={{
        minHeight: 0,
        minWidth: 0,
        flex: 1,
        padding: 'var(--sp-6)',
        gap: 'var(--sp-6)',
      }}
    >
      <div
        className="ui-stack"
        style={{ overflowY: 'auto', minHeight: 0, minWidth: 0, flex: 1, gap: 'var(--sp-6)' }}
      >
        <nav className="ui-stack" style={{ gap: 'var(--sp-3)' }}>
          <Link to={channelsHref(workspaceId, { kind: 'landing' })}>← Home</Link>
          {task?.parentId && (
            <Link to={href(task.parentId)}>Project: {parent?.title ?? task.parentId}</Link>
          )}
        </nav>
        <header>
          <h2>{detail.data.task.title}</h2>
          <p className="ui-muted">
            {status.label} ·{' '}
            {directory.buddyNames[detail.data.task.ownerId] ?? detail.data.task.ownerId}
          </p>
        </header>
        {detail.kind === 'stale' && <p role="alert">{detail.error.message}</p>}
        <TaskDetailBody
          detail={detail.data}
          names={directory.buddyNames}
          refresh={detail.refetch}
          taskHref={href}
          comments={false}
        />
        <h3>Discussion</h3>
        {feed.latest.kind === 'stale' || feed.latest.kind === 'failed' ? (
          <p role="alert">{feed.latest.error.message}</p>
        ) : null}
        {feed.edge.kind === 'more' || feed.edge.kind === 'failed' ? (
          <button
            type="button"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => void feed.loadOlder(() => {})}
          >
            Load older comments
          </button>
        ) : null}
        {feed.posts === null ? (
          <p>Loading comments…</p>
        ) : feed.posts.length === 0 ? (
          <p>No comments yet. @mention a Buddy to bring them into the task.</p>
        ) : (
          <ol className="buddy-post-list" style={{ minWidth: 0 }}>
            {[...feed.posts].reverse().map((post) => (
              <li key={post.id} data-post-id={post.id} style={{ minWidth: 0 }}>
                <div className="buddy-post-list__meta" style={{ flexWrap: 'wrap' }}>
                  <strong>{actorName(post.author, directory.buddyNames)}</strong>
                  <time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleString()}</time>
                </div>
                <ChannelMarkdown
                  body={channelPostBody(post)}
                  buddyNames={directory.buddyNames}
                  tasks={directory.taskById}
                />
                {post.evidence.length > 0 && (
                  <ul className="buddy-post-list__evidence">
                    {post.evidence.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                {post.channelId !== detail.data.channel.id && (
                  <Link
                    to={channelsHref(workspaceId, {
                      kind: 'thread',
                      channelId: post.channelId,
                      rootId: post.rootId ?? post.id,
                      linkedPostId: post.id,
                    })}
                  >
                    View in channel
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setReplyTo({ rootId: post.rootId ?? post.id, channelId: post.channelId })
                  }
                >
                  Reply in thread
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {replyTo && (
        <div className="ui-row">
          <span>Replying in thread</span>
          <button type="button" onClick={() => setReplyTo(null)}>
            New comment
          </button>
        </div>
      )}
      <ChannelComposer
        key={replyTo?.rootId ?? detail.data.channel.id}
        channelId={replyTo?.channelId ?? detail.data.channel.id}
        rootId={replyTo?.rootId ?? null}
        references={directory.references}
        autoFocus={replyTo !== null}
        placeholder="Comment on this task · @mention a Buddy"
        submit={submit}
        onPosted={() => {
          void feed.latest.refetch();
        }}
      />
    </section>
  );
}
