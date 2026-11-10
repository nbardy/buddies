import type { BuddyBuilderEvent } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { useId } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { archivedBuddyIdsAtom } from '../../atoms/buddy-visibility';
import { createConversation } from '../../atoms/commands';
import { buddyTabPath } from './buddy-tabs';
import './BuddyBuilderResultCard.css';

export function BuddyBuilderResultCard({ event }: { event: BuddyBuilderEvent }) {
  const navigate = useNavigate();
  const detailsId = useId();
  const archived = useAtomValue(archivedBuddyIdsAtom);
  const { result } = event;
  const { buddy } = result;
  const manager = result.teamState?.manager;
  const projects = event.action === 'work_created' ? [event.project] : result.projects;
  const buddyQuestions = result.followUpQuestions;
  const runtime = [buddy.model ?? buddy.provider, buddy.reasoning_effort]
    .filter(Boolean)
    .join(' · ');
  const route = `/buddies/${encodeURIComponent(buddy.id)}`;
  const startConversation = () => {
    const id = createConversation({
      workingDirectory: result.homeWorkspace.root_path,
      config: {
        provider: buddy.provider ?? 'codex',
        model: buddy.model ? { mode: 'explicit', modelId: buddy.model } : { mode: 'default' },
        reasoning: buddy.reasoning_effort
          ? { mode: 'explicit', effort: buddy.reasoning_effort }
          : { mode: 'default' },
      },
      kind: {
        t: 'buddy',
        context: { buddyId: buddy.id, workspaceId: result.homeWorkspace.id, buddyProjectId: null },
      },
    });
    void navigate(`/chat/${id}`);
  };

  if (archived.has(buddy.id)) return null;
  return (
    <article className="buddy-created-card ui-row">
      <Link className="buddy-created-card__name" to={route} title={buddy.name}>
        {buddy.name}
      </Link>
      <span className="buddy-created-card__badge">
        {event.action === 'created'
          ? 'Created'
          : event.action === 'work_created'
            ? 'Work saved'
            : 'Updated'}
      </span>
      <button
        className="buddy-created-card__conversation"
        type="button"
        onClick={startConversation}
      >
        Start conversation
      </button>
      <button
        className="buddy-created-card__info"
        type="button"
        popoverTarget={detailsId}
        aria-label={`Details for ${buddy.name}`}
        title="View saved configuration"
      >
        ⓘ
      </button>
      <div id={detailsId} popover="auto" className="buddy-created-card__details">
        <header className="buddy-created-card__details-header ui-row">
          <strong>{buddy.name}</strong>
          <button
            type="button"
            popoverTarget={detailsId}
            popoverTargetAction="hide"
            aria-label="Close Buddy details"
          >
            ×
          </button>
        </header>
        <p>{buddy.role}</p>
        <p className="buddy-created-card__snapshot">Snapshot when saved</p>
        {runtime && <p className="buddy-created-card__runtime">{runtime}</p>}
        {event.action === 'updated' && (
          <p className="buddy-created-card__update">Working brief saved</p>
        )}
        {result.teamState && (
          <div className="buddy-created-card__team">
            {result.teamState.employment.kind === 'direct_report' ? (
              <p>
                Reports to{' '}
                {manager ? (
                  manager.status === 'archived' || archived.has(manager.id) ? (
                    `${manager.name} (archived)`
                  ) : (
                    <Link to={`/buddies/${encodeURIComponent(manager.id)}`}>{manager.name}</Link>
                  )
                ) : (
                  'an unavailable Buddy'
                )}
              </p>
            ) : (
              <p>Top-level Buddy</p>
            )}
            {result.teamState.team.length > 0 && (
              <>
                <span>Direct reports</span>
                <ul>
                  {result.teamState.team.map((report) => (
                    <li key={report.id}>
                      {report.status === 'archived' || archived.has(report.id) ? (
                        `${report.name} (archived)`
                      ) : (
                        <Link to={`/buddies/${encodeURIComponent(report.id)}`}>{report.name}</Link>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {projects && projects.length > 0 && (
          <div className="buddy-created-card__work">
            <span>Saved work</span>
            <ul>
              {projects.map((project) => (
                <li key={project.id}>
                  {archived.has(project.buddy_id) ? (
                    project.title
                  ) : (
                    <Link to={buddyTabPath(project.buddy_id, 'work')}>{project.title}</Link>
                  )}
                  <span className="buddy-created-card__work-status">{project.status}</span>
                  {project.blocked_reason && <p>Blocked: {project.blocked_reason}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {event.action === 'created' && buddyQuestions.length > 0 && (
          <div className="buddy-created-card__questions">
            <span>Questions to sharpen this Buddy</span>
            <ul>
              {buddyQuestions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        )}
        <details className="buddy-created-card__config">
          <summary>
            Saved configuration{event.action === 'updated' ? ` · revision ${event.revision}` : ''}
          </summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      </div>
    </article>
  );
}
