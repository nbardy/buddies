import type { ExpeditionView } from '@unleashd/shared';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { backgroundOf } from './expedition-overlay';
import {
  expeditionHref,
  expeditionPollMs,
  expeditionUrl,
  runLabel,
  runTone,
} from './expedition-view';
import './BuddyWorkerThreadBadge.css';
import './Expedition.css';

const BADGE_POLL_MS = 15_000;

// The live badge a launch leaves in its chat (thread, DM or channel): one line, opens the
// expedition modal over the chat (the URL is /expeditions/:id, so the link also travels).
export function ExpeditionBadge({ id }: { id: string }) {
  const [pollMs, setPollMs] = useState(BADGE_POLL_MS);
  const view = usePolledFetch<ExpeditionView>(expeditionUrl(id), pollMs);
  // Derived from the last response (React's state-from-previous-render pattern).
  const nextPollMs = expeditionPollMs(view.data, BADGE_POLL_MS);
  if (nextPollMs !== pollMs) setPollMs(nextPollMs);
  const location = useLocation();
  const v = view.data;
  return (
    <Link
      className="buddy-worker-thread-badge ui-inline-row ui-card expedition-badge"
      to={expeditionHref(id)}
      state={{ background: backgroundOf(location) }}
      aria-label={`Open expedition ${v?.charter.name ?? id}`}
    >
      ⛺ <strong className="ui-truncate">{v?.charter.name ?? 'Expedition'}</strong>
      {v ? (
        <>
          <span className={`expedition-pill expedition-tone-${runTone(v.run)}`}>
            {runLabel(v.run)}
          </span>
          <span className="ui-truncate">
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
