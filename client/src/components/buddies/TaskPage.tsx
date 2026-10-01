import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { BuddyRunList } from './BuddyRunList';
import { actorName } from './BuddyTaskComments';
import { NewTaskForm, TaskEditForm, TaskRows, taskDetailUrl } from './BuddyWork';
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
import { isTaskOpen, taskStatusView } from './ui-contract';
import './ChannelLanding.css';

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
  const data = detail.data;
  const status = taskStatusView(data.task.status);
  const current = data.children.filter((child) => isTaskOpen(child.status));
  const finished = data.children.filter((child) => !isTaskOpen(child.status));
  const frame = submit === 'button' ? 'mobile' : 'desktop';
  return (
    <section className="task-page ui-stack" aria-label="Task details">
      <div className="task-page-scroll ui-scroll-quiet">
        <div className="landing ui-stack" data-frame={frame}>
          <header className="landing-section ui-stack">
            <nav
              className="task-page-breadcrumb landing-section-head ui-row"
              aria-label="Task breadcrumb"
            >
              <Link className="landing-more" to={channelsHref(workspaceId, { kind: 'landing' })}>
                ← Home
              </Link>
              {data.task.parentId && (
                <Link className="landing-more ui-truncate" to={href(data.task.parentId)}>
                  Project: {parent?.title ?? data.task.parentId}
                </Link>
              )}
            </nav>
            <h1 className="task-page-heading">{data.task.title}</h1>
            <div className="landing-foot ui-row">
              <span className="landing-chip ui-inline-row">
                {status.glyph} {status.label}
              </span>
              <span className="ui-muted">
                {directory.buddyNames[data.task.ownerId] ?? data.task.ownerId}
              </span>
              {data.task.paused && <span className="ui-badge">Paused</span>}
            </div>
            <p className="task-page-copy">{data.task.doneCriteria}</p>
            <details className="landing-retired">
              <summary className="landing-more">Details & settings</summary>
              <div className="landing-section ui-stack">
                <p className="buddy-panel__criteria">
                  <strong>Done when</strong> {data.task.doneCriteria}
                </p>
                {data.task.evidence.length > 0 && (
                  <ul className="buddy-post-list__evidence">
                    {data.task.evidence.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                <TaskEditForm key={data.task.revision} task={data.task} refresh={detail.refetch} />
                <details>
                  <summary>Execution history · {data.runs.length} runs</summary>
                  <BuddyRunList
                    runs={data.runs}
                    refresh={detail.refetch}
                    empty="No runs for this task yet."
                  />
                </details>
              </div>
            </details>
            {detail.kind === 'stale' && <p role="alert">{detail.error.message}</p>}
          </header>
          <section className="landing-section ui-stack" aria-label="Subtasks">
            <header className="landing-section-head ui-row">
              <h2>Subtasks</h2>
              <span className="landing-count">{current.length} open</span>
            </header>
            {current.length > 0 ? (
              <TaskRows tasks={current} taskHref={href} refresh={detail.refetch} />
            ) : (
              <p className="landing-empty ui-muted">
                {finished.length > 0 ? 'All subtasks are closed.' : 'No subtasks yet.'}
              </p>
            )}
            {finished.length > 0 && (
              <details className="landing-section ui-stack">
                <summary className="landing-more">
                  Completed & cancelled · {finished.length}
                </summary>
                <TaskRows tasks={finished} taskHref={href} refresh={detail.refetch} />
              </details>
            )}
            <details className="landing-retired">
              <summary className="landing-more">Add subtask</summary>
              <NewTaskForm
                ownerId={data.task.ownerId}
                parentId={data.task.id}
                label="todo"
                refresh={detail.refetch}
              />
            </details>
          </section>
          <section className="landing-section ui-stack" aria-label="Discussion">
            <header className="landing-section-head ui-row">
              <h2>Discussion</h2>
            </header>
            {feed.latest.kind === 'stale' || feed.latest.kind === 'failed' ? (
              <p role="alert">{feed.latest.error.message}</p>
            ) : null}
            {feed.edge.kind === 'more' || feed.edge.kind === 'failed' ? (
              <button
                className="landing-more"
                type="button"
                onClick={() => void feed.loadOlder(() => {})}
              >
                Load older comments ↑
              </button>
            ) : null}
            {feed.posts === null ? (
              <p className="landing-empty ui-muted">Loading comments…</p>
            ) : feed.posts.length === 0 ? (
              <div className="landing-retired">
                <p className="landing-empty ui-muted">
                  No comments yet. @mention a Buddy to bring them into the task.
                </p>
              </div>
            ) : (
              <ol className="task-page-comments">
                {[...feed.posts].reverse().map((post) => (
                  <li key={post.id} data-post-id={post.id}>
                    <div className="buddy-post-list__meta">
                      <strong>{actorName(post.author, directory.buddyNames)}</strong>
                      <time dateTime={post.createdAt}>
                        {new Date(post.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </time>
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
                    <div className="landing-foot ui-row">
                      {post.channelId !== data.channel.id && (
                        <Link
                          className="landing-more"
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
                        className="landing-more"
                        type="button"
                        onClick={() =>
                          setReplyTo({ rootId: post.rootId ?? post.id, channelId: post.channelId })
                        }
                      >
                        Reply in thread
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
      <div className="landing landing-composer task-page-footer" data-frame={frame}>
        {replyTo && (
          <div className="landing-foot ui-row">
            <span className="ui-muted">Replying in thread</span>
            <button className="landing-more" type="button" onClick={() => setReplyTo(null)}>
              New comment
            </button>
          </div>
        )}
        <ChannelComposer
          key={replyTo?.rootId ?? data.channel.id}
          channelId={replyTo?.channelId ?? data.channel.id}
          rootId={replyTo?.rootId ?? null}
          references={directory.references}
          autoFocus={replyTo !== null}
          placeholder="Comment on this task · @mention a Buddy"
          submit={submit}
          onPosted={() => {
            void feed.latest.refetch();
          }}
        />
      </div>
    </section>
  );
}
