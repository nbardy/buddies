import { useAtomValue } from 'jotai';
import { Link } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { formatTimeAgo } from '../../utils/time';
import { buddyWrite } from './api';
import { conversationPath } from './buddy-tabs';
import type { Run, RunInput, RunStatus } from './types';
import { ActionError, useBuddyAction } from './useBuddyAction';

/** Why a run exists, as a label: one handler per RunInput variant. */
const RUN_INPUT_LABEL: { [K in RunInput['kind']]: string } = {
  chat: 'Chat turn',
  post: 'Answering a post',
  deliver: 'New posts in a thread',
  message: 'A message on a request',
  retired: 'Earlier run',
};

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  cancel_requested: 'Cancelling',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const CANCELLABLE: ReadonlySet<RunStatus> = new Set(['queued', 'running']);

/**
 * Runs, newest first. A run keeps its `conversationId` forever, but the client
 * may no longer hold that conversation: only an available one is a link
 * (Chat.tsx bounces an unknown id to `/`, which reads as "Open took me to the
 * conversation list"). Guarded by client/test/buddy-conversation-links.test.tsx.
 */
export function BuddyRunList({
  runs,
  refresh,
  empty,
}: {
  runs: readonly Run[];
  refresh: () => Promise<void>;
  empty: string;
}) {
  const available = useAtomValue(listField('idSet'));
  const action = useBuddyAction(refresh);
  if (runs.length === 0) return <p className="buddy-panel__empty">{empty}</p>;
  return (
    <>
      <ActionError state={action.state} />
      <ul className="buddy-run-list">
        {runs.map((run) => {
          const when = new Date(run.endedAt ?? run.startedAt ?? run.createdAt);
          return (
            <li key={run.id} data-status={run.status}>
              <span className="buddy-run-list__what">
                <strong>{RUN_INPUT_LABEL[run.input.kind]}</strong>
                <span>
                  {RUN_STATUS_LABEL[run.status]} ·{' '}
                  <time dateTime={when.toISOString()} title={when.toLocaleString()}>
                    {formatTimeAgo(when)}
                  </time>
                </span>
                {run.error && <span className="buddy-run-list__error">{run.error}</span>}
              </span>
              {run.conversationId && available.has(run.conversationId) && (
                <Link to={conversationPath(run.conversationId)}>Open</Link>
              )}
              {CANCELLABLE.has(run.status) && (
                <button
                  type="button"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(`cancel:${run.id}`, () =>
                      buddyWrite('run.cancel', { runId: run.id })
                    )
                  }
                >
                  Cancel
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
