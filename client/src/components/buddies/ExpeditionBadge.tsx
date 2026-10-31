import type { ExpeditionView } from '@unleashd/shared';
import { Link } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { expeditionHref, expeditionUrl, runLabel } from './expedition-view';
import './BuddyWorkerThreadBadge.css';

// The live badge a launch leaves in its chat (thread, DM or channel): one line, opens the page.
export function ExpeditionBadge({ id }: { id: string }) {
  const view = usePolledFetch<ExpeditionView>(expeditionUrl(id), 15_000);
  const v = view.data;
  const stats = v
    ? ` · ${runLabel(v.run)} · ${v.counts.live} live · ${v.counts.verified} verified · ${v.counts.attempts}/${v.counts.maxAttempts}`
    : view.kind === 'failed'
      ? ' · unavailable'
      : '';
  return (
    <Link
      className="buddy-worker-thread-badge ui-inline-row ui-card"
      to={expeditionHref(id)}
      aria-label={`Open expedition ${v?.name ?? id}`}
    >
      ⛺ {v?.name ?? 'Expedition'}
      {stats} ↗
    </Link>
  );
}
