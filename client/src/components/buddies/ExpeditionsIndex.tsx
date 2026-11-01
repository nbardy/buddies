import type { ExpeditionSummary } from '@unleashd/shared';
import { Link } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { formatRelativeAge } from '../../utils/turn-diagnostics';
import { EXPEDITIONS_URL, expeditionHref, runDot, runLabel, summaryLine } from './expedition-view';
import '../../views/conversation-row/ConversationRow.css';
import './TaskPage.css';

// Every expedition, newest launch first: the sidebar Expeditions header opens this. Each row opens
// the expedition page. Existing classes plus token inline styles (client CSS is at its G8 ceiling).

const POLL_MS = 10_000;

export function ExpeditionsIndex() {
  const list = usePolledFetch<ExpeditionSummary[]>(EXPEDITIONS_URL, POLL_MS);
  if (!list.data)
    return (
      <output className="buddy-panel__empty">
        {list.kind === 'failed' ? list.error.message : 'Loading expeditions…'}
      </output>
    );
  return (
    <section
      className="task-page ui-stack"
      aria-label="Expeditions"
      style={{
        padding: 'var(--sp-4)',
        gap: 'var(--sp-3)',
        overflowY: 'auto',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <h1 className="task-page-heading">⛺ Expeditions</h1>
      {list.data.length === 0 && (
        <p className="ui-muted">
          No expeditions yet. Ask a Buddy to launch one for a big goal with a checkable done.
        </p>
      )}
      {list.data.map((e) => (
        <Link
          key={e.id}
          to={expeditionHref(e.id)}
          className="task-page-section ui-surface ui-card ui-stack"
          style={{
            textDecoration: 'none',
            color: 'inherit',
            padding: 'var(--sp-3)',
            gap: 'var(--sp-2)',
          }}
        >
          <div className="ui-row" style={{ gap: 'var(--sp-3)' }}>
            <span className="conversation-row__dot" data-status={runDot(e.run)} />
            <strong className="ui-truncate">{e.name}</strong>
            <span className="ui-badge" style={{ flex: 'none' }}>
              {runLabel(e.run)}
            </span>
          </div>
          <span className="ui-muted" title={new Date(e.launchedAt).toLocaleString()}>
            launched {formatRelativeAge(Date.parse(e.launchedAt))} · {summaryLine(e)}
          </span>
        </Link>
      ))}
    </section>
  );
}
