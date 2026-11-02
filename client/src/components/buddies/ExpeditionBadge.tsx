import type { ExpeditionRetiredView, ExpeditionView } from '@unleashd/shared';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { backgroundOf } from './expedition-overlay';
import {
  expeditionHref,
  expeditionPill,
  expeditionPollMs,
  expeditionRead,
  expeditionUrl,
  summaryOf,
} from './expedition-view';
import './BuddyWorkerThreadBadge.css';
import './Expedition.css';

const BADGE_POLL_MS = 15_000;

// The live badge a launch leaves in its chat (thread, DM or channel): one line, opens the
// expedition modal over the chat (the URL is /expeditions/:id, so the link also travels).
export function ExpeditionBadge({ id }: { id: string }) {
  const [pollMs, setPollMs] = useState(BADGE_POLL_MS);
  const view = usePolledFetch<ExpeditionView | ExpeditionRetiredView>(expeditionUrl(id), pollMs);
  // Derived from the last response (React's state-from-previous-render pattern).
  const read = view.data ? expeditionRead(view.data) : null;
  const nextPollMs = expeditionPollMs(read, BADGE_POLL_MS);
  if (nextPollMs !== pollMs) setPollMs(nextPollMs);
  const location = useLocation();
  const v = read ? summaryOf(read) : null;
  return (
    <Link
      className="buddy-worker-thread-badge ui-inline-row ui-card expedition-badge"
      to={expeditionHref(id)}
      state={{ background: backgroundOf(location) }}
      aria-label={`Open expedition ${v?.name ?? id}`}
    >
      ⛺ <strong className="ui-truncate expedition-badge-name">{v?.name ?? 'Expedition'}</strong>
      {v ? (
        <>
          <span className={`expedition-pill expedition-tone-${expeditionPill(v).tone}`}>
            {expeditionPill(v).label}
          </span>
          <span className="ui-truncate expedition-badge-counts">
            {v.counts.live} live · {v.counts.verified} verified · {v.counts.attempts}/
            {v.counts.maxAttempts} · {v.cost.short}
          </span>
        </>
      ) : (
        view.kind === 'failed' && <span>unavailable</span>
      )}{' '}
      ↗
    </Link>
  );
}
