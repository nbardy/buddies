import { useAtomValue } from 'jotai';
import { Link, useLocation } from 'react-router-dom';
import type { BuddyBackgroundWorker, BuddyWorkerStatus } from '../../atoms/buddy-background';
import { connectionAtom, listField, loadCompleteOf, streamFamily } from '../../atoms/conversations';
import { useBuddyWorkers } from '../../hooks/useBuddyData';
import { useTimeTick } from '../../hooks/useTimeTick';
import { mobileConversationRouteState } from '../../utils/conversation-route-state';
import { isRowRunning } from '../../utils/conversation-row';
import { formatTimeAgo } from '../../utils/time';
import {
  buildTurnDiagnosticsViewModel,
  shouldPresentTurnAttempt,
  turnDiagnosticsFromAttempt,
} from '../../utils/turn-diagnostics';
import { BuddyRunList } from './BuddyRunList';
import { conversationPath } from './buddy-tabs';
import type { Run, Task } from './types';
import './BuddyBackgroundTasks.css';

const NO_TASKS: readonly Task[] = [];
const STATUS: Record<BuddyWorkerStatus, string> = {
  running: 'Running',
  queued: 'Queued',
  idle: 'Not running',
  completed: 'Completed',
  error: 'Failed',
  interrupted: 'Interrupted',
  unknown: 'Status unconfirmed',
};

export function BuddyBackgroundTasks({
  buddyId,
  runs,
  refresh,
  fixedWorkspaceId,
  tasks = NO_TASKS,
}: {
  buddyId: string;
  runs: readonly Run[];
  refresh: () => Promise<void>;
  fixedWorkspaceId?: string;
  tasks?: readonly Task[];
}) {
  const { workers, read } = useBuddyWorkers(buddyId, fixedWorkspaceId ?? null);
  const loaded = loadCompleteOf(useAtomValue(connectionAtom).server);
  const running = workers.filter((worker) => worker.status === 'running').length;
  const queued = workers.filter((worker) => worker.status === 'queued').length;
  return (
    <section className="buddy-background-tasks" aria-label="Background workers">
      <div className="buddy-background-tasks-heading">
        <div>
          <h2>Background workers</h2>
          <p>
            {running} running · {queued} queued · {workers.length} total
          </p>
        </div>
      </div>
      <p className="ui-muted">
        Background conversations and session workers. Open a conversation to inspect its work. No
        recent output alone does not mean a worker has stalled.
      </p>
      {(read.kind === 'failed' ||
        read.kind === 'stale' ||
        (read.data?.unavailableIds.length ?? 0) > 0) && (
        <p role="alert">
          Worker activity could not refresh.{' '}
          <button type="button" onClick={() => void read.refetch()}>
            Retry
          </button>
        </p>
      )}
      {workers.length === 0 ? (
        <p className="buddy-background-tasks-empty">
          {loaded && read.kind !== 'loading'
            ? 'No background workers yet.'
            : 'Loading background workers…'}
        </p>
      ) : (
        <ul className="buddy-background-tasks-list">
          {workers.map((worker) => (
            <WorkerRow
              key={worker.id}
              worker={worker}
              run={runs.find((run) => run.conversationId === worker.row.id)}
              tasks={tasks}
            />
          ))}
        </ul>
      )}
      <h3 className="buddy-panel__heading">Recent runs</h3>
      <BuddyRunList runs={runs} refresh={refresh} empty="No runs yet." />
    </section>
  );
}

function WorkerRow({
  worker,
  run,
  tasks,
}: {
  worker: BuddyBackgroundWorker;
  run?: Run;
  tasks: readonly Task[];
}) {
  const { row, parent, agent } = worker;
  const available = useAtomValue(listField('idSet'));
  const streaming = useAtomValue(streamFamily(row.id));
  const location = useLocation();
  const running = isRowRunning(row);
  useTimeTick();
  const attempt = worker.latestAttempt;
  const activity =
    running && attempt && shouldPresentTurnAttempt(attempt, true)
      ? buildTurnDiagnosticsViewModel(turnDiagnosticsFromAttempt(attempt))
      : null;
  const status =
    !agent && worker.status === 'idle' && run
      ? (
          {
            failed: 'error',
            cancelled: 'interrupted',
            complete: 'completed',
            queued: 'queued',
            running: 'running',
            cancel_requested: 'running',
          } as const
        )[run.status]
      : worker.status;
  const title =
    agent?.description ||
    tasks.find((task) => task.id === run?.taskId)?.title ||
    row.label ||
    'Background conversation';
  const preview = agent
    ? status === 'unknown'
      ? undefined
      : agent.currentAction
    : (streaming || row.label).replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim();
  const when = new Date(agent ? (agent.completedAt ?? agent.startedAt) : row.activityAt);
  return (
    <li className="buddy-background-tasks-conversation">
      <div className="buddy-background-tasks-row">
        <strong>{title}</strong>
        <span className={status === 'running' ? 'buddy-background-tasks-running' : undefined}>
          {STATUS[status]}
        </span>
      </div>
      {preview && <p className="buddy-background-tasks-preview">{preview}</p>}
      {activity && (
        <p className="ui-muted">
          {parent?.id === row.id ? 'Parent turn' : 'Turn'} · {activity.title}
        </p>
      )}
      {status === 'unknown' && (
        <p>The parent turn ended; this worker’s result was not confirmed.</p>
      )}
      <div className="buddy-background-tasks-row buddy-background-tasks-meta ui-muted">
        <span>
          {row.provider} ·{' '}
          {agent ? `Session worker · ${agent.toolUses} tool uses` : 'Background conversation'} ·{' '}
          <time dateTime={when.toISOString()}>{formatTimeAgo(when)}</time>
        </span>
        {available.has(row.id) && (
          <Link to={conversationPath(row.id)} state={mobileConversationRouteState(location)}>
            {parent?.id === row.id ? 'Open parent conversation' : 'Open conversation'} →
          </Link>
        )}
      </div>
    </li>
  );
}
