import { useAtomValue } from 'jotai';
import { Link, useParams } from 'react-router-dom';
import { listField, rowFamily } from '../../atoms/conversations';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { shortenHomePath } from '../../utils/directories';
import { formatTimeAgo } from '../../utils/time';
import { activeBuddies, findWorkspace } from './roster';
import type { Run, RunInput, RunStatus } from './types';
import { initials } from './ui-contract';
import './BuddyWorkspaceActivity.css';

// What a workspace's Buddies are running now: the roster from the overview,
// each Buddy's live runs from GET /api/buddies/runs?liveInWorkspace=.

const NO_CONVERSATION_ID = '__workspace_run_without_conversation__';
const NO_RUNS: readonly Run[] = [];

export function liveRunsUrl(workspaceId: string): string {
  return `/api/buddies/runs?liveInWorkspace=${encodeURIComponent(workspaceId)}`;
}

/** Why a run exists, as a label: one entry per RunInput variant. */
const RUN_KIND: Record<RunInput['kind'], string> = {
  chat: 'chat',
  post: 'post',
  deliver: 'delivery',
  message: 'message',
  retired: 'earlier',
};

/** A live run's state; finished runs never appear in a live listing. */
const RUN_STATUS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  cancel_requested: 'Stopping',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function RunRow({ run, available }: { run: Run; available: boolean }) {
  const conversation = useAtomValue(rowFamily(run.conversationId ?? NO_CONVERSATION_ID));
  const title = conversation?.label ?? `Run ${run.id.slice(0, 8)}`;
  const body = (
    <>
      <span className="buddy-workspace-job-dot" aria-hidden="true" />
      <span className="buddy-workspace-job-kind">{RUN_KIND[run.input.kind]}</span>
      <span className="buddy-workspace-job-title ui-truncate">{title}</span>
      <span className="buddy-workspace-job-meta ui-muted">
        {RUN_STATUS[run.status]}
        {run.startedAt ? ` · ${formatTimeAgo(new Date(run.startedAt))}` : ''}
      </span>
    </>
  );
  return run.conversationId && available ? (
    <Link className="buddy-workspace-job" to={`/chat/${encodeURIComponent(run.conversationId)}`}>
      {body}
    </Link>
  ) : (
    <div className="buddy-workspace-job">{body}</div>
  );
}

export function BuddyWorkspaceActivity() {
  const { workspaceId = '' } = useParams();
  const availableConversationIds = useAtomValue(listField('idSet'));
  const overview = useBuddyOverview();
  const live = usePolledFetch<Run[]>(liveRunsUrl(workspaceId), 5_000);
  const workspace = overview.data ? findWorkspace(overview.data, workspaceId) : undefined;
  const runs = live.data ?? NO_RUNS;
  const failed = overview.kind === 'failed' ? overview : live.kind === 'failed' ? live : null;

  return (
    <main className="buddy-workspace-page">
      <header className="buddy-workspace-header">
        <Link className="buddy-workspace-back ui-muted" to="/buddies">
          ← Buddies
        </Link>
        <div className="buddy-workspace-heading-row">
          <div>
            <p className="buddy-workspace-eyebrow ui-muted">Workspace</p>
            <h1>{workspace?.name ?? 'Workspace activity'}</h1>
            {workspace && (
              <p className="buddy-workspace-path ui-muted">{shortenHomePath(workspace.rootPath)}</p>
            )}
          </div>
          {live.data && (
            <div
              className="buddy-workspace-active-summary ui-inline-row ui-muted"
              aria-live="polite"
            >
              <span className={runs.length ? 'is-running' : ''} aria-hidden="true" />
              {runs.length ? `${runs.length} running` : 'No active runs'}
            </div>
          )}
        </div>
        <p>
          <Link
            className="buddy-workspace-channels-open ui-card"
            to={`/buddies/workspaces/${encodeURIComponent(workspaceId)}/channels`}
          >
            Open channels
          </Link>
        </p>
      </header>

      {(overview.kind === 'loading' || live.kind === 'loading') && (
        <p className="buddy-workspace-state ui-card">Loading workspace activity…</p>
      )}
      {failed && (
        <div className="buddy-workspace-state ui-card buddy-workspace-state--error" role="alert">
          <p>{failed.error.message}</p>
          <button type="button" onClick={failed.refetch}>
            Retry
          </button>
        </div>
      )}
      {workspace && (
        <section className="buddy-workspace-members" aria-label="Buddies and live runs">
          {activeBuddies(workspace).map((member) => {
            const own = runs.filter((run) => run.buddyId === member.id);
            return (
              <article className="buddy-workspace-member ui-card" key={member.id}>
                <div className="buddy-workspace-member-header ui-row">
                  <span className="buddy-workspace-avatar ui-inline-row" aria-hidden="true">
                    {initials(member.name)}
                  </span>
                  <div className="buddy-workspace-identity">
                    <Link to={`/buddies/${encodeURIComponent(member.id)}`}>{member.name}</Link>
                    <span>{member.role}</span>
                  </div>
                  <span className="buddy-workspace-member-count">
                    {own.length ? `${own.length} active` : 'Idle'}
                  </span>
                </div>
                <div className="buddy-workspace-jobs">
                  {own.length ? (
                    own.map((run) => (
                      <RunRow
                        key={run.id}
                        run={run}
                        available={
                          !!run.conversationId && availableConversationIds.has(run.conversationId)
                        }
                      />
                    ))
                  ) : (
                    <p className="buddy-workspace-idle">Nothing running.</p>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
