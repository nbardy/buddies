import type { ExpeditionView } from '@unleashd/shared';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import '../../views/conversation-row/ConversationRow.css';
import { channelsHref, channelsView } from './channels-view';
import './Expedition.css';

type Slot = 'section' | 'headingRow' | 'heading' | 'list' | 'row' | 'hash' | 'name';
export type RailRowClasses = Record<Slot, string>;
export const DESKTOP_ROW: RailRowClasses = {
  section: 'expedition-rail',
  headingRow: 'channel-browser-rail-section-row ui-row',
  heading: 'channel-browser-rail-section ui-muted',
  list: 'channel-browser-channels',
  row: '',
  hash: 'channel-browser-hash',
  name: 'channel-browser-channel-name ui-truncate',
};
const EXPEDITION_DOT = {
  running: 'running',
  held: 'queued',
  met: 'idle',
  stopped: 'idle',
} as const;

export function RailExpeditions({
  workspaceId,
  classes,
}: {
  workspaceId: string;
  classes: RailRowClasses;
}) {
  const read = usePolledFetch<ExpeditionView[]>(
    `/api/buddies/expeditions?workspaceId=${encodeURIComponent(workspaceId)}`,
    2000
  );
  const current = channelsView(useLocation().search);
  const navigate = useNavigate();
  if (!read.data?.length) return null;
  return (
    <section className={classes.section} aria-label="Expeditions">
      <div className={classes.headingRow}>
        <h3 className={classes.heading}>Expeditions</h3>
      </div>
      <ul className={classes.list}>
        {read.data.map((r) => {
          const needsOwner = r.questions.some((q) => q.kind !== 'manager');
          return (
            <li key={r.id}>
              <button
                type="button"
                className={classes.row}
                aria-current={
                  current.kind === 'expedition' && current.id === r.id ? 'page' : undefined
                }
                title={r.goal}
                onClick={() =>
                  navigate(channelsHref(workspaceId, { kind: 'expedition', id: r.id }))
                }
              >
                <span className={`${classes.hash} expedition-rail-dot`} aria-hidden="true">
                  <span
                    className="conversation-row__dot"
                    data-status={needsOwner ? 'queued' : EXPEDITION_DOT[r.status]}
                  />
                </span>
                <span className={classes.name}>{r.goal.split('\n')[0]}</span>
                <span className="expedition-status" data-alert={needsOwner || undefined}>
                  {needsOwner ? 'Needs you' : r.status}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
