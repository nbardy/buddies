import type { ExpeditionRow, keyed } from '@unleashd/shared';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { type ChannelsView, channelsHref, channelsView } from './channels-view';
import { useExpeditionRows, useRetired } from './expedition-api';
import { useKeyedRows } from './keyed-api';
import { goalLine, rankRows, statusLabel } from './keyed-timeline';
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
/** The dot shares the header pill's colour (Expedition.css), and a flag names every state but
 * running (review 2026-11-03: a relaunch left two identical rows told apart by dot colour). */
const DOT = { draft: 'draft', running: 'running', paused: 'paused', finished: 'idle' } as const;
const FLAG = { draft: 'draft', running: null, paused: 'paused', finished: 'ended' } as const;

function Flag({ row }: { row: Extract<ExpeditionRow, { t: 'ok' }> }) {
  const text = row.needsOwner ? 'needs you' : FLAG[row.state];
  return text === null ? null : (
    <span className="expedition-rail-flag" data-alert={row.needsOwner || undefined}>
      {text}
    </span>
  );
}

/** One keyed expedition: its goal, its state, and "needs you" while an ask or an approval waits
 * (the row says so: `KeyedRow.needsYou`, so the rail reads no view per row). */
function KeyedRailRow({
  row,
  classes,
  current,
  go,
}: {
  row: keyed.KeyedRow;
  classes: RailRowClasses;
  current: boolean;
  go(): void;
}) {
  return (
    <li>
      <button
        type="button"
        className={classes.row || undefined}
        aria-current={current ? 'page' : undefined}
        data-unread={row.needsYou ? 'unread' : 'read'}
        onClick={go}
        title={row.goal}
      >
        <span className={`${classes.hash} expedition-rail-dot`} aria-hidden="true">
          <span className="conversation-row__dot" data-status={KEYED_DOT[row.status.t]} />
        </span>
        <span className={classes.name}>{goalLine(row.goal)}</span>
        <span className="expedition-rail-flag" data-alert={row.needsYou || undefined}>
          {row.needsYou ? 'needs you' : statusLabel(row.status)}
        </span>
      </button>
    </li>
  );
}
const KEYED_DOT = { running: 'running', paused: 'paused', finished: 'idle' } as const;

/** The Expeditions section, for both shells; absent until the workspace has one. A row opens
 * the expedition in the main pane (`?expedition=`), like a channel; retired ones fold under one
 * "Retired" row and open read-only (`?retired=`). */
export function RailExpeditions({
  workspaceId,
  classes,
}: {
  workspaceId: string;
  classes: RailRowClasses;
}) {
  const rows = useExpeditionRows(workspaceId) ?? [];
  // This workspace's keyed expeditions; none when the backend has no keyed route (404/503) or the
  // list is still loading.
  const keyedRows = useKeyedRows(workspaceId);
  const retired = useRetired(workspaceId) ?? [];
  const view = channelsView(useLocation().search);
  const navigate = useNavigate();
  const [showRetired, setShowRetired] = useState(false);
  if (rows.length + keyedRows.length + retired.length === 0) return null;
  const go = (to: ChannelsView) => navigate(channelsHref(workspaceId, to));
  const current = (kind: 'expedition' | 'retired' | 'keyed', id: string) =>
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
              {r.t === 'ok' && <Flag row={r} />}
            </button>
          </li>
        ))}
        {rankRows(keyedRows).map((r) => (
          <KeyedRailRow
            key={r.id}
            row={r}
            classes={classes}
            current={current('keyed', r.id) === 'page'}
            go={() => go({ kind: 'keyed', id: r.id })}
          />
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
