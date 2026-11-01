import type { ExpeditionSummary } from '@unleashd/shared';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { toggleGalleryCollapsed } from '../atoms/ui';
import { usePolledFetch } from '../hooks/usePolledFetch';
import {
  EXPEDITIONS_HREF,
  EXPEDITIONS_URL,
  SIDEBAR_RECENT_EXPEDITIONS,
  expeditionHref,
  runDot,
  runLabel,
  summaryLine,
} from './buddies/expedition-view';

// The sidebar's Expeditions section (owner, 2026-11-01): the header opens every expedition
// (/expeditions); under it, the newest few with a running dot. Between Channels and Buddies.

const POLL_MS = 10_000;
const COLLAPSE_KEY = '__expeditions__';
const NONE: readonly ExpeditionSummary[] = [];
const rowLink = { textDecoration: 'none', color: 'inherit', gap: 'var(--sp-3)' };
// `.folder-group-count` is a 24px numeric column; these labels are words, so they size to fit.
const label = { flex: 'none', whiteSpace: 'nowrap' } as const;

export function SidebarExpeditions({ collapsed }: { collapsed: boolean }) {
  const list = usePolledFetch<ExpeditionSummary[]>(EXPEDITIONS_URL, POLL_MS);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const all = list.data ?? NONE;
  const running = all.filter((e) => e.run.t === 'running').length;
  return (
    <div className="sidebar-section">
      <div className="folder-group">
        <div
          className="folder-group-header ui-control ui-row"
          onClick={() => toggleGalleryCollapsed(COLLAPSE_KEY)}
        >
          <button
            type="button"
            className="folder-group-name ui-truncate folder-group-name-button"
            onClick={(event) => {
              event.stopPropagation();
              navigate(EXPEDITIONS_HREF);
            }}
          >
            Expeditions
          </button>
          <span
            className="folder-group-count ui-muted"
            style={label}
            title={`${running} running of ${all.length}`}
          >
            {running > 0 ? `${running} running` : all.length || ''}
          </span>
        </div>
        {!collapsed && list.data?.length === 0 && (
          <div className="folder-group-all-done ui-muted">No expeditions yet</div>
        )}
        {!collapsed &&
          all.slice(0, SIDEBAR_RECENT_EXPEDITIONS).map((e) => {
            const href = expeditionHref(e.id);
            const isActive = pathname === href;
            return (
              <Link
                key={e.id}
                to={href}
                className={`folder-group-header ui-control ui-row sidebar-channels-row ${isActive ? 'active' : ''}`}
                style={rowLink}
                aria-current={isActive ? 'page' : undefined}
                title={`${e.name} — ${runLabel(e.run)}\n${summaryLine(e)}`}
              >
                <span className="conversation-row__dot" data-status={runDot(e.run)} />
                <span className="folder-group-name ui-truncate">{e.name}</span>
                <span className="folder-group-count ui-muted" style={label}>
                  {runLabel(e.run)}
                </span>
              </Link>
            );
          })}
      </div>
    </div>
  );
}
