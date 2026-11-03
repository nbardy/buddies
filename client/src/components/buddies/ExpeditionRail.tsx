import { Suspense, useState } from 'react';
import { LazyExpeditionModal } from './ExpeditionCard';
import { useExpeditionRows } from './expedition-api';
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

/** The Expeditions section, for both shells; absent until the workspace has one. */
export function RailExpeditions({
  workspaceId,
  classes,
}: { workspaceId: string; classes: RailRowClasses }) {
  const rows = useExpeditionRows(workspaceId);
  const [open, setOpen] = useState<string | null>(null);
  if (rows === null || rows.length === 0) return null;
  return (
    <section className={classes.section} aria-label="Expeditions">
      <h3 className={classes.heading}>Expeditions</h3>
      <ul className={classes.list}>
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={classes.row || undefined}
              data-unread={r.t === 'unreadable' || r.needsOwner ? 'unread' : 'read'}
              onClick={() => setOpen(r.id)}
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
      </ul>
      {open && (
        <Suspense fallback={null}>
          <LazyExpeditionModal id={open} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </section>
  );
}
