import type { ExpeditionSummary } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { Link, useLocation } from 'react-router-dom';
import { type SummaryRead, expeditionSummaryFamily } from '../../atoms/channel-rail';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { backgroundOf } from './expedition-overlay';
import {
  EXPEDITIONS_POLL_MS,
  EXPEDITIONS_URL,
  expeditionHref,
  expeditionPill,
  pollMsOf,
} from './expedition-view';
import './BuddyWorkerThreadBadge.css';
import './Expedition.css';

/** The settled list stops polling; every other read keeps the list fresh. */
const listPollMs = (read: SummaryRead) =>
  read.t === 'found' ? pollMsOf(read.summary, EXPEDITIONS_POLL_MS) : EXPEDITIONS_POLL_MS;

function BadgeCounts({ s }: { s: ExpeditionSummary }) {
  const pill = expeditionPill(s);
  return (
    <>
      <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
      <span className="ui-truncate expedition-badge-counts">
        {s.counts.live} live · {s.counts.verified} verified · {s.counts.attempts}/
        {s.counts.maxAttempts} · {s.cost.short}
      </span>
    </>
  );
}

/** δ over what the cached list says about this expedition. */
function BadgeBody({ read }: { read: SummaryRead }) {
  switch (read.t) {
    case 'found':
      return <BadgeCounts s={read.summary} />;
    case 'unavailable':
    case 'missing':
      return <span>unavailable</span>;
    case 'pending':
      return null;
  }
}

const nameOf = (read: SummaryRead) => (read.t === 'found' ? read.summary.name : 'Expedition');

// The live badge a launch leaves in its chat (thread, DM or channel): one line, opens the
// expedition modal over the chat (the URL is /expeditions/:id, so the link also travels). It reads
// the one cached list (GET /api/buddies/expeditions, shared with the rail and index), so N badges
// are one request, not N full-view polls; the modal fetches the full view when opened.
export function ExpeditionBadge({ id }: { id: string }) {
  const read = useAtomValue(expeditionSummaryFamily(id));
  usePolledFetch<ExpeditionSummary[]>(EXPEDITIONS_URL, listPollMs(read));
  const location = useLocation();
  return (
    <Link
      className="buddy-worker-thread-badge ui-inline-row ui-card expedition-badge"
      to={expeditionHref(id)}
      state={{ background: backgroundOf(location) }}
      aria-label={`Open expedition ${read.t === 'found' ? read.summary.name : id}`}
    >
      ⛺ <strong className="ui-truncate expedition-badge-name">{nameOf(read)}</strong>
      <BadgeBody read={read} /> ↗
    </Link>
  );
}
