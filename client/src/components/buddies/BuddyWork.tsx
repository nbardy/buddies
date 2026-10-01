import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { BuddyRunList } from './BuddyRunList';
import { BuddyTaskCommentForm, BuddyTaskCommentList } from './BuddyTaskComments';
import { buddyWrite } from './api';
import { channelsHref } from './channels-view';
import type { Task, TaskDetail, TaskStatus } from './types';
import { TASK_STATUS, isTaskOpen } from './ui-contract';
import { ActionError, useBuddyAction } from './useBuddyAction';

export const taskDetailUrl = (taskId: string): string =>
  `/api/buddies/tasks/${encodeURIComponent(taskId)}`;

const STATUSES = Object.keys(TASK_STATUS) as TaskStatus[];

/**
 * Display order for siblings (top-level tasks, or one task's todos): `position`, then creation.
 * The crate creates every top-level task at position 0, so creation order breaks those ties until
 * the owner first reorders.
 */
export const byPosition = (tasks: readonly Task[]): Task[] =>
  [...tasks].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));

/**
 * The writes that move `ordered[from]` one place up (-1) or down (+1): every sibling's position
 * becomes its index in the new order, and only the siblings whose position changes are written.
 * The first move renumbers a list of tied zeros; later moves write two tasks.
 */
export function moveTask(
  ordered: readonly Task[],
  from: number,
  delta: -1 | 1
): { task: Task; position: number }[] {
  const to = from + delta;
  const next = [...ordered];
  [next[from], next[to]] = [next[to], next[from]];
  return next.flatMap((task, position) => (task.position === position ? [] : [{ task, position }]));
}

const patchTask = (task: Task, changes: Partial<Pick<Task, 'paused' | 'position'>>) =>
  buddyWrite(taskDetailUrl(task.id), 'PATCH', { baseRevision: task.revision, changes });

/** Move up, move down and pause/resume for one task or todo among its ordered siblings. */
function TaskControls({
  ordered,
  index,
  refresh,
}: {
  ordered: readonly Task[];
  index: number;
  refresh: () => Promise<void>;
}) {
  const task = ordered[index];
  const action = useBuddyAction(refresh);
  const move = (delta: -1 | 1) =>
    void action.run('move', () =>
      Promise.all(moveTask(ordered, index, delta).map((w) => patchTask(w.task, w)))
    );
  // Rendered inside a card's <summary>: a click on a control must not also toggle the card.
  return (
    <span className="buddy-panel__actions" onClick={(event) => event.preventDefault()}>
      <button type="button" disabled={action.busy || index === 0} onClick={() => move(-1)}>
        Move up
      </button>
      <button
        type="button"
        disabled={action.busy || index === ordered.length - 1}
        onClick={() => move(1)}
      >
        Move down
      </button>
      <button
        type="button"
        disabled={action.busy}
        onClick={() => void action.run('pause', () => patchTask(task, { paused: !task.paused }))}
      >
        {task.paused ? 'Resume' : 'Pause'}
      </button>
      <ActionError state={action.state} />
    </span>
  );
}

/** A new task for this Buddy, or a todo under `parentId`. */
export function NewTaskForm({
  ownerId,
  parentId,
  label,
  refresh,
}: {
  ownerId: string;
  parentId?: string;
  label: 'task' | 'todo';
  refresh: () => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [doneCriteria, setDoneCriteria] = useState('');
  const action = useBuddyAction(refresh);
  return (
    <form
      className="buddy-panel__form"
      aria-label={`New ${label}`}
      onSubmit={(event) => {
        event.preventDefault();
        void action
          .run('create', () =>
            buddyWrite('/api/buddies/tasks', 'POST', {
              ownerId,
              ...(parentId === undefined ? {} : { parentId }),
              title: title.trim(),
              doneCriteria: doneCriteria.trim(),
            })
          )
          .then((ok) => {
            if (!ok) return;
            setTitle('');
            setDoneCriteria('');
          });
      }}
    >
      <label>
        New {label}
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Done when
        <input value={doneCriteria} onChange={(event) => setDoneCriteria(event.target.value)} />
      </label>
      <button type="submit" disabled={action.busy || !title.trim() || !doneCriteria.trim()}>
        Add {label}
      </button>
      <ActionError state={action.state} />
    </form>
  );
}

/** Status, next action and blocker, sent as a patch of the changed fields only. */
export function TaskEditForm({ task, refresh }: { task: Task; refresh: () => Promise<void> }) {
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [nextAction, setNextAction] = useState(task.nextAction ?? '');
  const [blockedReason, setBlockedReason] = useState(task.blockedReason ?? '');
  const action = useBuddyAction(refresh);
  const changes = {
    ...(status !== task.status ? { status } : {}),
    ...(nextAction !== (task.nextAction ?? '') ? { nextAction } : {}),
    ...(blockedReason !== (task.blockedReason ?? '') ? { blockedReason } : {}),
  };
  return (
    <form
      className="buddy-panel__form"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run('task', () =>
          buddyWrite(taskDetailUrl(task.id), 'PATCH', { baseRevision: task.revision, changes })
        );
      }}
    >
      <label>
        Status
        <select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {TASK_STATUS[value].label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Next action
        <input value={nextAction} onChange={(event) => setNextAction(event.target.value)} />
      </label>
      <label>
        Blocker
        <input value={blockedReason} onChange={(event) => setBlockedReason(event.target.value)} />
      </label>
      <button type="submit" disabled={action.busy || Object.keys(changes).length === 0}>
        Save task
      </button>
      <ActionError state={action.state} />
    </form>
  );
}

export function TaskDetailBody({
  detail,
  names,
  refresh,
  taskHref,
  comments = true,
}: {
  taskHref?: (taskId: string) => string;
  comments?: boolean;
  detail: TaskDetail;
  names: Readonly<Record<string, string>>;
  refresh: () => Promise<void>;
}) {
  const { task } = detail;
  const todos = byPosition(detail.children);
  return (
    <>
      <details open={taskHref ? undefined : true}>
        <summary>Details · done criteria, evidence and settings</summary>
        <p className="buddy-panel__criteria">
          <strong>Done when</strong> {task.doneCriteria}
        </p>
        {task.evidence.length > 0 && (
          <ul className="buddy-post-list__evidence">
            {task.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        {/* Keyed by revision: a saved or concurrent edit resets the draft. */}
        <TaskEditForm key={task.revision} task={task} refresh={refresh} />
      </details>
      <h4 className="buddy-panel__heading">Subtasks</h4>
      <ul className="buddy-task-list__todos">
        {todos.map((child, index) => (
          <li key={child.id} data-tone={TASK_STATUS[child.status].tone}>
            <span aria-hidden="true">{TASK_STATUS[child.status].glyph}</span>{' '}
            {taskHref ? <Link to={taskHref(child.id)}>{child.title}</Link> : child.title}
            {child.paused ? ' · Paused' : ''}
            {taskHref ? (
              <>
                <span className="ui-muted"> · {TASK_STATUS[child.status].label}</span>
                <details>
                  <summary>Manage</summary>
                  <TaskControls ordered={todos} index={index} refresh={refresh} />
                </details>
              </>
            ) : (
              <TaskControls ordered={todos} index={index} refresh={refresh} />
            )}
          </li>
        ))}
      </ul>
      <details open={taskHref ? undefined : true}>
        <summary>Add subtask</summary>
        <NewTaskForm ownerId={task.ownerId} parentId={task.id} label="todo" refresh={refresh} />
      </details>
      <details open={taskHref ? undefined : true}>
        <summary>Execution history · {detail.runs.length} runs</summary>
        <BuddyRunList runs={detail.runs} refresh={refresh} empty="No runs for this task yet." />
      </details>
      {comments && (
        <>
          <h4 className="buddy-panel__heading">Comments</h4>
          <BuddyTaskCommentForm channelId={detail.channel.id} refresh={refresh} />
          <BuddyTaskCommentList comments={detail.comments} names={names} />
        </>
      )}
    </>
  );
}

/** One task's detail, read only while its card is open. */
export function BuddyTaskPanel({
  taskId,
  names,
}: {
  taskId: string;
  names: Readonly<Record<string, string>>;
}) {
  const detail = usePolledFetch<TaskDetail>(taskDetailUrl(taskId), 0);
  switch (detail.kind) {
    case 'idle':
    case 'loading':
      return <p className="buddy-panel__empty">Loading comments…</p>;
    case 'failed':
      return (
        <p className="buddy-panel__error" role="alert">
          {detail.error.message}
        </p>
      );
    case 'ready':
    case 'stale':
      return <TaskDetailBody detail={detail.data} names={names} refresh={detail.refetch} />;
  }
}

// Pattern: one-definition (docs/patterns.md#one-definition)
// One compact linked row for the task page and the Buddy's Work page.
export function TaskRows({
  tasks,
  refresh,
  taskHref,
}: {
  tasks: readonly Task[];
  refresh: () => Promise<void>;
  taskHref?: (id: string) => string;
}) {
  const ordered = byPosition(tasks);
  return (
    <ul className="landing-requests">
      {ordered.map((task, index) => {
        const status = TASK_STATUS[task.status];
        return (
          <li key={task.id} className="task-line">
            <Link
              className="landing-request"
              to={
                taskHref
                  ? taskHref(task.id)
                  : channelsHref(task.workspaceId, { kind: 'task', channelId: '', taskId: task.id })
              }
            >
              <span className="ui-muted" aria-hidden="true">
                {status.glyph}
              </span>
              <span className="task-line-copy">
                <span className="landing-thread-title">{task.title}</span>
                <span className="task-line-status">{task.paused ? 'Paused' : status.label}</span>
              </span>
              <span className="ui-badge">{task.paused ? 'Paused' : status.label}</span>
              <span className="ui-muted" aria-hidden="true">
                ›
              </span>
            </Link>
            <details className="task-line-menu">
              <summary aria-label={`Actions for ${task.title}`}>•••</summary>
              <div className="ui-popover ui-popover--end">
                <TaskControls ordered={ordered} index={index} refresh={refresh} />
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/** A Buddy's tasks: top-level ones (todos are child tasks, shown inside their task). */
export function BuddyWork({
  buddyId,
  tasks,
  refresh,
}: {
  buddyId: string;
  tasks: readonly Task[];
  names: Readonly<Record<string, string>>;
  refresh: () => Promise<void>;
}) {
  const topLevel = byPosition(tasks.filter((task) => task.parentId === undefined));
  const current = topLevel.filter((task) => isTaskOpen(task.status));
  const finished = topLevel.filter((task) => !isTaskOpen(task.status));
  return (
    <section className="landing ui-stack" aria-label="Work">
      <header className="landing-section-head ui-row">
        <h2>Tasks</h2>
        <span className="landing-count">{current.length} open</span>
      </header>
      {current.length === 0 ? (
        <p className="landing-empty ui-muted">No open tasks.</p>
      ) : (
        <TaskRows tasks={current} refresh={refresh} />
      )}
      <details className="landing-retired">
        <summary>New task</summary>
        <NewTaskForm ownerId={buddyId} label="task" refresh={refresh} />
      </details>
      {finished.length > 0 && (
        <details className="landing-section">
          <summary className="landing-more">Completed & cancelled · {finished.length}</summary>
          <TaskRows tasks={finished} refresh={refresh} />
        </details>
      )}
    </section>
  );
}
