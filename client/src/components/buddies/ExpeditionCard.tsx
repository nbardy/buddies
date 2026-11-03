import { ALLOWED, type Act, counted, stateLabel } from '@unleashd/shared';
import { Suspense, lazy, useState } from 'react';
import { useAct, useExpedition } from './expedition-api';
import './Expedition.css';

export const LazyExpeditionModal = lazy(() =>
  import('./ExpeditionModal').then((m) => ({ default: m.ExpeditionModal }))
);

/** The chat card a draft posts (purpose `expedition`): Info opens the modal, Launch starts it. */
export function ExpeditionCard({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
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
      <button type="button" className="expedition-button" onClick={() => setOpen(true)}>
        Info
      </button>
      {ALLOWED.launch.includes(x.state.t) && (
        <ActButton label="Launch" act={act} send={{ do: 'launch' }} />
      )}
      {act.state.t === 'failed' && <span className="expedition-error">{act.state.error}</span>}
      {open && (
        <Suspense fallback={null}>
          <LazyExpeditionModal id={id} onClose={() => setOpen(false)} />
        </Suspense>
      )}
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
