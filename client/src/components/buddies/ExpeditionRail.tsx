import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { type ChannelsView, channelsHref, channelsView } from './channels-view';
import { useExpeditionRows, useRetired } from './expedition-api';
import '../../views/conversation-row/ConversationRow.css';

/** One shell's class names: the desktop channel rail or the phone's channel list. */
type Slot = 'section' | 'heading' | 'list' | 'row' | 'hash' | 'name';
export type RailRowClasses = Record<Slot, string>;
export const DESKTOP_ROW: RailRowClasses = {
  section: 'expedition-rail',
  heading: 'channel-browser-rail-section ui-muted',
  list: 'channel-browser-channels',
  row: '',
  hash: 'channel-browser-hash',
  name: 'channel-browser-channel-name ui-truncate',
};
const DOT = { draft: 'queued', running: 'running', paused: 'idle', finished: 'idle' } as const;

/** The Expeditions section, for both shells; absent until the workspace has one. A row opens
 * the expedition in the main pane (`?expedition=`), like a channel; retired ones fold under one
 * "Retired" row and open read-only (`?retired=`). */
export function RailExpeditions({
  workspaceId,
  classes,
}: { workspaceId: string; classes: RailRowClasses }) {
  const rows = useExpeditionRows(workspaceId);
  const retired = useRetired(workspaceId) ?? [];
  const view = channelsView(useLocation().search);
  const navigate = useNavigate();
  const [showRetired, setShowRetired] = useState(false);
  if (rows === null || rows.length + retired.length === 0) return null;
  const go = (to: ChannelsView) => navigate(channelsHref(workspaceId, to));
  const current = (kind: 'expedition' | 'retired', id: string) =>
    view.kind === kind && view.id === id ? 'page' : undefined;
  return (
    <section className={classes.section} aria-label="Expeditions">
      <h3 className={classes.heading}>Expeditions</h3>
      <ul className={classes.list}>
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={classes.row || undefined}
              aria-current={current('expedition', r.id)}
              data-unread={r.t === 'unreadable' || r.needsOwner ? 'unread' : 'read'}
              onClick={() => go({ kind: 'expedition', id: r.id })}
              title={r.t === 'ok' ? r.label : r.reason}
            >
              <span className={`${classes.hash} expedition-rail-dot`} aria-hidden="true">
                <span
                  className="conversation-row__dot"
                  data-status={r.t === 'ok' ? DOT[r.state] : 'unread'}
                />
              </span>
              <span className={classes.name}>{r.t === 'ok' ? r.name : `${r.id} (unreadable)`}</span>
              {r.t === 'ok' && r.needsOwner && (
                <span className="expedition-rail-flag">needs you</span>
              )}
            </button>
          </li>
        ))}
        {retired.length > 0 && (
          <li>
            <button
              type="button"
              className={classes.row || undefined}
              aria-expanded={showRetired}
              onClick={() => setShowRetired(!showRetired)}
            >
              <span className={`${classes.hash} ui-muted`} aria-hidden="true">
                {showRetired ? '▾' : '▸'}
              </span>
              <span className={`${classes.name} ui-muted`}>Retired · {retired.length}</span>
            </button>
          </li>
        )}
        {showRetired &&
          retired.map((r) => (
            <li key={`retired-${r.record.id}`}>
              <button
                type="button"
                className={`${classes.row} expedition-rail-retired`.trim()}
                aria-current={current('retired', r.record.id)}
                onClick={() => go({ kind: 'retired', id: r.record.id })}
              >
                <span className={classes.hash} aria-hidden="true" />
                <span className={`${classes.name} ui-muted`}>{r.record.charter.name}</span>
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
}
