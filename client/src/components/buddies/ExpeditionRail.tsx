import type { ExpeditionView } from '@unleashd/shared';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { channelsHref, channelsView } from './channels-view';
import './Expedition.css';

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
      <h3 className={classes.heading}>Expeditions</h3>
      <ul className={classes.list}>
        {read.data.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={classes.row}
              aria-current={
                current.kind === 'expedition' && current.id === r.id ? 'page' : undefined
              }
              onClick={() => navigate(channelsHref(workspaceId, { kind: 'expedition', id: r.id }))}
            >
              <span className={classes.hash}>⛺</span>
              <span className={classes.name}>{r.goal.split('\n')[0]}</span>
              <span className="ui-muted">{r.questions.length ? 'needs you' : r.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
