import type { keyed } from '@unleashd/shared';
import { useLocation, useNavigate } from 'react-router-dom';
import { type ChannelsView, channelsHref, channelsView } from './channels-view';
import { useKeyedRows } from './keyed-api';
import { goalLine, rankRows, statusLabel } from './keyed-timeline';
import '../../views/conversation-row/ConversationRow.css';
import './KeyedExpedition.css';

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

/** The workspace’s keyed expeditions, shared by both shells. */
export function RailExpeditions({
  workspaceId,
  classes,
}: {
  workspaceId: string;
  classes: RailRowClasses;
}) {
  // This workspace's keyed expeditions; none when the backend has no keyed route (404/503) or the
  // list is still loading.
  const keyedRows = useKeyedRows(workspaceId);
  const view = channelsView(useLocation().search);
  const navigate = useNavigate();
  if (keyedRows.length === 0) return null;
  const go = (to: ChannelsView) => navigate(channelsHref(workspaceId, to));
  const current = (kind: 'keyed', id: string) =>
    view.kind === kind && view.id === id ? 'page' : undefined;
  return (
    <section className={classes.section} aria-label="Expeditions">
      <h3 className={classes.heading}>Expeditions</h3>
      <ul className={classes.list}>
        {rankRows(keyedRows).map((r) => (
          <KeyedRailRow
            key={r.id}
            row={r}
            classes={classes}
            current={current('keyed', r.id) === 'page'}
            go={() => go({ kind: 'keyed', id: r.id })}
          />
        ))}
      </ul>
    </section>
  );
}
