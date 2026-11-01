import type { ExpeditionSummary } from '@unleashd/shared';
import { Link } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import {
  EXPEDITIONS_HREF,
  EXPEDITIONS_URL,
  SIDEBAR_RECENT_EXPEDITIONS,
  expeditionHref,
  runLabel,
  summaryLine,
} from './expedition-view';

// Fix-guard: the Chats sidebar is absent on workspace channels, so adding its section
// left the owner's actual rail unchanged. Guard: channel-browser.test.tsx renders this route.
export function ChannelExpeditions() {
  const list = usePolledFetch<ExpeditionSummary[]>(EXPEDITIONS_URL, 10_000);
  return (
    <section aria-label="Expeditions">
      <div className="channel-browser-rail-section-row ui-row">
        <Link className="channel-browser-rail-section ui-muted" to={EXPEDITIONS_HREF}>
          Expeditions
        </Link>
      </div>
      {(list.kind === 'failed' || list.kind === 'stale') && (
        <p className="channel-browser-rail-empty ui-muted" role="alert">
          Expeditions could not refresh: {list.error.message}
        </p>
      )}
      {list.kind === 'loading' && (
        <p className="channel-browser-rail-empty ui-muted">Loading expeditions…</p>
      )}
      {list.data?.length === 0 && (
        <p className="channel-browser-rail-empty ui-muted">No expeditions yet.</p>
      )}
      <ul className="channel-browser-buddies">
        {list.data?.slice(0, SIDEBAR_RECENT_EXPEDITIONS).map((expedition) => (
          <li key={expedition.id} className="channel-browser-buddy ui-truncate">
            <Link
              className="channel-browser-buddy-link ui-row"
              to={expeditionHref(expedition.id)}
              title={`${expedition.name} — ${runLabel(expedition.run)}\n${summaryLine(expedition)}`}
            >
              <span className="channel-browser-hash ui-muted" aria-hidden="true">
                ⚑
              </span>
              <span className="channel-browser-channel-name ui-truncate">{expedition.name}</span>
              <small className="ui-muted" style={{ flexShrink: 0 }}>
                {runLabel(expedition.run)}
              </small>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
