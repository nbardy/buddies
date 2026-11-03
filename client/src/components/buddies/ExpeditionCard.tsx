import { ALLOWED, type Act, counted, stateLabel } from '@unleashd/shared';
import { Link } from 'react-router-dom';
import { channelsHref } from './channels-view';
import { useAct, useExpedition } from './expedition-api';
import './Expedition.css';

/** The chat card a draft posts (purpose `expedition`): Open shows it in the main pane (the
 * expedition view), Launch starts it. */
export function ExpeditionCard({ id }: { id: string }) {
  const read = useExpedition(id, 10_000);
  const act = useAct(id);
  if (read.data === null)
    return (
      <div className="expedition-card ui-muted">
        {read.kind === 'loading' || read.kind === 'idle'
          ? 'Loading expedition…'
          : read.error.message === 'HTTP 404'
            ? 'Expedition no longer listed'
            : `Expedition unavailable (${read.error.message})`}
      </div>
    );
  const x = read.data;
  const issues = x.state.t === 'draft' ? x.state.issues.length : 0;
  return (
    <div className="expedition-card ui-row">
      <strong className="ui-truncate">⛺ {x.charter.name}</strong>
      <span className="expedition-pill" data-state={x.state.t}>
        {stateLabel(x)}
      </span>
      <span className="ui-muted">
        {counted(x)}/{x.charter.maxAttempts}
        {issues > 0 && ` · ${issues} issues`}
      </span>
      <Link
        className="expedition-button"
        to={channelsHref(x.workspaceId, { kind: 'expedition', id })}
      >
        Open
      </Link>
      {ALLOWED.launch.includes(x.state.t) && (
        <ActButton label="Launch" act={act} send={{ do: 'launch' }} />
      )}
      {act.state.t === 'failed' && <span className="expedition-error">{act.state.error}</span>}
    </div>
  );
}

/** One owner act as a button; disabled while any act of this expedition is pending. */
export function ActButton({
  label,
  act,
  send,
}: { label: string; act: ReturnType<typeof useAct>; send: Act }) {
  return (
    <button
      type="button"
      className="expedition-button"
      disabled={act.state.t === 'pending'}
      onClick={() => act.run(send)}
    >
      {label}
    </button>
  );
}
