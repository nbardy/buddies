import { useAtomValue } from 'jotai';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { BuddyRunList } from './BuddyRunList';
import { NewTaskForm, TaskEditForm, TaskRows, taskDetailUrl } from './BuddyWork';
import { ChannelComposer, type ComposerSubmit } from './ChannelComposer';
import { ChannelMarkdown } from './ChannelMarkdown';
import { LeadRow, type RowContext } from './ChannelRows';
import { TaskProgress } from './TaskProgress';
import {
  CHANNEL_BACKSTOP_MS,
  type WorkspaceDirectory,
  taskPostsFeed,
  useChannelFeed,
} from './channel-data';
import { channelsHref } from './channels-view';
import { projectProgress } from './home-view';
import type { TaskDetail } from './types';
import { isTaskOpen, taskStatusView } from './ui-contract';
import './ChannelBrowser.css';
import './TaskPage.css';

// Home opened only a message filter, hiding criteria and children.
// Guard: task-page.test.tsx renders the Home destination and checks its linked hierarchy.
// Raw evidence logs overwhelmed the task page and pushed discussion below dozens of paths.
// Guard: task-page.test.tsx excludes evidence logs and keeps secondary history collapsed.
// Action, criteria and discussion used equally faint labels, obscuring the reading order.
// Guard: task-page.test.tsx checks distinct action/blocker sections before criteria and discussion.
// Subtasks were hidden below discussion; keep the checklist and shared Home progress first.
// Guard: task-page.test.tsx checks visible subtasks and progress before the task brief.
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
  const navigate = useNavigate();
  const availableConversationIds = useAtomValue(listField('idSet'));
  const detail = usePolledFetch<TaskDetail>(taskDetailUrl(taskId), CHANNEL_BACKSTOP_MS);
  const feed = useChannelFeed(taskPostsFeed(taskId));
  const [replyTo, setReplyTo] = useState<{ rootId: string; channelId: string } | null>(null);
  const href = (id: string) => channelsHref(workspaceId, { kind: 'task', channelId, taskId: id });
  const [editing, setEditing] = useState(false);
  const task = detail.data?.task;
  const parent = task?.parentId ? directory.tasks.find((item) => item.id === task.parentId) : null;
  if (!detail.data)
    return <output>{detail.kind === 'failed' ? detail.error.message : 'Loading task…'}</output>;
  const data = detail.data;
  const status = taskStatusView(data.task.status);
  const current = data.children.filter((child) => isTaskOpen(child.status));
  const finished = data.children.filter((child) => !isTaskOpen(child.status));
  const context: RowContext = {
    workspaceId,
    directory,
    availableConversationIds,
    linkedPostId: null,
    openDm: (conversationId) => navigate(channelsHref(workspaceId, { kind: 'dm', conversationId })),
    place: { kind: 'thread' },
  };
  return (
    <section className="task-page ui-stack" aria-label="Task details">
      <div className="task-page-scroll ui-scroll-quiet">
        <div className="task-page-column ui-stack">
          <header className="task-page-section ui-stack">
            <nav className="task-page-breadcrumb ui-row" aria-label="Task breadcrumb">
              <Link className="ui-choice" to={channelsHref(workspaceId, { kind: 'landing' })}>
                ← Home
              </Link>
              {data.task.parentId && (
                <Link className="ui-choice ui-truncate" to={href(data.task.parentId)}>
                  Project: {parent?.title ?? data.task.parentId}
                </Link>
              )}
            </nav>
            <h1 className="task-page-heading">{data.task.title}</h1>
            <div className="task-page-actions ui-row">
              <span className="ui-badge">
                {status.glyph} {status.label}
              </span>
              <span className="ui-muted">
                {directory.buddyNames[data.task.ownerId] ?? data.task.ownerId}
              </span>
              {data.task.paused && <span className="ui-badge">Paused</span>}
            </div>
          </header>
          <section className="task-page-section ui-stack" aria-label="Subtasks">
            <h2 className="ui-section__title">Subtasks · {current.length} open</h2>
            <TaskProgress progress={projectProgress(data.children)} />
            {current.length > 0 ? (
              <TaskRows tasks={current} taskHref={href} refresh={detail.refetch} />
            ) : (
              <p className="buddy-panel__empty">
                {finished.length > 0 ? 'All subtasks are closed.' : 'No subtasks yet.'}
              </p>
            )}
            {finished.length > 0 && (
              <details className="task-page-section ui-stack">
                <summary className="ui-choice">Completed & cancelled · {finished.length}</summary>
                <TaskRows tasks={finished} taskHref={href} refresh={detail.refetch} />
              </details>
            )}
            <details className="ui-surface ui-card">
              <summary className="ui-choice">Add subtask</summary>
              <NewTaskForm
                ownerId={data.task.ownerId}
                parentId={data.task.id}
                label="todo"
                refresh={detail.refetch}
              />
            </details>
          </section>
          {data.task.nextAction && (
            <section
              className="task-page-next ui-surface ui-card ui-stack"
              aria-label="Next action"
            >
              <h2 className="ui-section__title">Next action</h2>
              <TaskCopy text={data.task.nextAction} directory={directory} />
            </section>
          )}
          {data.task.blockedReason && (
            <section className="task-page-section ui-stack" aria-label="Blocker">
              <h2 className="ui-section__title">Blocked by</h2>
              <TaskCopy text={data.task.blockedReason} directory={directory} />
            </section>
          )}
          <section className="task-page-section ui-stack" aria-label="Completion criteria">
            <header className="ui-section__header">
              <h2 className="ui-section__title">Done when</h2>
              <button className="ui-choice" type="button" onClick={() => setEditing(!editing)}>
                {editing ? 'Cancel editing' : 'Edit task'}
              </button>
            </header>
            {editing && (
              <section className="ui-surface ui-card ui-stack" aria-label="Edit task">
                <h3>Update task progress</h3>
                <p className="buddy-panel__empty">Change the status, next action or blocker.</p>
                <TaskEditForm
                  className="task-page-edit"
                  key={data.task.revision}
                  task={data.task}
                  refresh={detail.refetch}
                />
              </section>
            )}
            <TaskCopy text={data.task.doneCriteria} directory={directory} />
          </section>
          {detail.kind === 'stale' && <p role="alert">{detail.error.message}</p>}
          <section className="task-page-section ui-stack" aria-label="Discussion">
            <header className="ui-section__header">
              <h2 className="ui-section__title">Discussion</h2>
            </header>
            {feed.latest.kind === 'stale' || feed.latest.kind === 'failed' ? (
              <p role="alert">{feed.latest.error.message}</p>
            ) : null}
            {feed.edge.kind === 'more' || feed.edge.kind === 'failed' ? (
              <button
                className="ui-choice"
                type="button"
                onClick={() => void feed.loadOlder(() => {})}
              >
                Load older comments ↑
              </button>
            ) : null}
            {feed.posts === null ? (
              <p className="buddy-panel__empty">Loading comments…</p>
            ) : feed.posts.length === 0 ? (
              <div className="ui-surface ui-card">
                <p className="buddy-panel__empty">
                  No comments yet. @mention a Buddy to bring them into the task.
                </p>
              </div>
            ) : (
              <ol className="channel-browser-messages">
                {[...feed.posts].reverse().map((post) => (
                  <LeadRow key={post.id} post={post} context={context}>
                    <div className="task-page-actions ui-row">
                      {post.channelId !== data.channel.id && (
                        <Link
                          className="ui-choice"
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
                        className="ui-choice"
                        onClick={() =>
                          setReplyTo({ rootId: post.rootId ?? post.id, channelId: post.channelId })
                        }
                      >
                        Reply in thread
                      </button>
                    </div>
                  </LeadRow>
                ))}
              </ol>
            )}
          </section>
          <details className="task-page-section ui-stack" aria-label="Execution history">
            <summary className="ui-choice">Execution history · {data.runs.length} runs</summary>
            <BuddyRunList
              runs={data.runs}
              refresh={detail.refetch}
              empty="No runs for this task yet."
            />
          </details>
        </div>
      </div>
      <div className="task-page-column task-page-footer ui-stack">
        {replyTo && (
          <div className="task-page-actions ui-row">
            <span className="ui-muted">Replying in thread</span>
            <button className="ui-choice" type="button" onClick={() => setReplyTo(null)}>
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

/** Keep long task briefs readable without rewriting the authoritative task text. */
function TaskCopy({ text, directory }: { text: string; directory: WorkspaceDirectory }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 200 || text.split('\n').length > 5;
  return (
    <div className="task-page-copy">
      <div className={long && !expanded ? 'task-page-preview' : undefined}>
        <ChannelMarkdown
          body={{ t: 'text', text }}
          buddyNames={directory.buddyNames}
          tasks={directory.taskById}
        />
      </div>
      {long && (
        <button
          type="button"
          className="ui-choice"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  );
}
