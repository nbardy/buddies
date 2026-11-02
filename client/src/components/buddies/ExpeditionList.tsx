import type { ExpeditionSummary } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import type { ComponentProps, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { expeditionRailFamily } from '../../atoms/channel-rail';
import { invalidateBuddyResources } from '../../atoms/resources';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { formatRelativeAge } from '../../utils/turn-diagnostics';
import { ActionButton } from './ExpeditionCards';
import { buddyWrite } from './api';
import { channelsHref } from './channels-view';
import { useOpenExpedition } from './expedition-overlay';
import {
  EXPEDITIONS_POLL_MS,
  EXPEDITIONS_URL,
  RUN_LOOK,
  expeditionGroups,
  expeditionPill,
  needsYou,
  ownerActions,
} from './expedition-view';
import '../../views/conversation-row/ConversationRow.css';
import './Expedition.css';

// Expeditions in the channels view (owner, 2026-11-01), both shells; all read one cached list.

export function useWorkspaceExpeditions(workspaceId: string) {
  usePolledFetch<ExpeditionSummary[]>(EXPEDITIONS_URL, EXPEDITIONS_POLL_MS);
  return useAtomValue(expeditionRailFamily(workspaceId));
}

/** Most rows the rail lists; the section header opens the rest. */
const RAIL_ROWS = 6;

type RailShell = 'desktop' | 'mobile';
export type RailRowClasses = { shell: RailShell; row: string; hash: string; name: string };

const DESKTOP_ROW: RailRowClasses = {
  shell: 'desktop',
  row: '',
  hash: 'channel-browser-hash',
  name: 'channel-browser-channel-name ui-truncate',
};

export type RowVariant = { t: 'rail'; classes: RailRowClasses } | { t: 'index' } | { t: 'home' };

/** One expedition as a row in any list, so dot, pill, line and needs-you flag cannot drift. */
type RowProps = { expedition: ExpeditionSummary; variant: RowVariant };
export function ExpeditionRow({ expedition: e, variant }: RowProps) {
  const open = useOpenExpedition();
  return (
    <li>
      <button type="button" onClick={() => open(e.id)} {...rowLook(e, variant)} />
    </li>
  );
}

type RowLook = ComponentProps<'button'> & { 'data-unread'?: string; 'data-needs-you'?: true };

function rowLook(e: ExpeditionSummary, variant: RowVariant): RowLook {
  const pill = expeditionPill(e);
  const dot = <span className="conversation-row__dot" data-status={RUN_LOOK[e.run.t].dot} />;
  switch (variant.t) {
    case 'rail':
      return {
        className: variant.classes.row || undefined,
        'data-unread': RUN_LOOK[e.run.t].emphasis,
        title: `${e.name} — ${pill.label}\n${e.line}`,
        children: (
          <>
            <span className={`${variant.classes.hash} expedition-rail-dot`} aria-hidden="true">
              {dot}
            </span>
            <span className={variant.classes.name}>{e.name}</span>
            {needsYou(e) && <span className="expedition-rail-flag">needs you</span>}
          </>
        ),
      };
    case 'index':
      return {
        className: 'expedition-index-row',
        'data-needs-you': needsYou(e) || undefined,
        children: (
          <>
            {dot}
            <span className="expedition-index-text ui-stack">
              <strong className="ui-truncate">{e.name}</strong>
              <span className="ui-muted ui-truncate">
                launched {formatRelativeAge(Date.parse(e.launchedAt))} · {e.line}
              </span>
            </span>
            <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
          </>
        ),
      };
    case 'home':
      return {
        className: 'landing-request expedition-home-row',
        children: (
          <>
            {/* data-own-dot: replaces the landing row's accent dot (ChannelLanding.css). */}
            <span className="landing-request-from ui-row" data-own-dot="">
              {dot}
              {e.name}
            </span>
            <span className="landing-request-body">
              {pill.label} · {e.line}
            </span>
          </>
        ),
      };
  }
}

/** The rail's last row, opening the index pane. */
type AllRowProps = {
  workspaceId: string;
  count: number;
  classes: RailRowClasses;
  current: boolean;
};
export function AllExpeditionsRow({ workspaceId, count, classes, current }: AllRowProps) {
  const navigate = useNavigate();
  const index = channelsHref(workspaceId, { kind: 'expeditions' });
  const label = (
    <>
      <span className={`${classes.hash} ui-muted`} aria-hidden="true">
        ⋯
      </span>
      <span className={classes.name}>{`All expeditions (${count})`}</span>
    </>
  );
  switch (classes.shell) {
    case 'desktop':
      return (
        <li>
          <button
            type="button"
            data-unread="read"
            aria-current={current ? 'page' : undefined}
            onClick={() => navigate(index)}
          >
            {label}
          </button>
        </li>
      );
    case 'mobile':
      return (
        <li>
          <Link className={classes.row} data-unread="read" to={index}>
            {label}
          </Link>
        </li>
      );
  }
}

/** The desktop rail's section, between Channels and Buddies; absent until there is one. */
export function RailExpeditions(p: { workspaceId: string; current: boolean }) {
  const { loaded, all, active } = useWorkspaceExpeditions(p.workspaceId);
  if (!loaded || all.length === 0) return null;
  const index = channelsHref(p.workspaceId, { kind: 'expeditions' });
  return (
    <>
      <div className="channel-browser-rail-section-row ui-row">
        <Link
          className="channel-browser-rail-section ui-muted"
          to={index}
          aria-current={p.current ? 'page' : undefined}
          title="Every expedition in this workspace"
        >
          Expeditions
        </Link>
      </div>
      <ul className="channel-browser-channels" aria-label="Expeditions">
        {active.slice(0, RAIL_ROWS).map((e) => (
          <ExpeditionRow key={e.id} expedition={e} variant={{ t: 'rail', classes: DESKTOP_ROW }} />
        ))}
        <AllExpeditionsRow
          workspaceId={p.workspaceId}
          count={all.length}
          classes={DESKTOP_ROW}
          current={p.current}
        />
      </ul>
    </>
  );
}

export function ExpeditionList({ workspaceId }: { workspaceId: string }) {
  const { loaded, all, active } = useWorkspaceExpeditions(workspaceId);
  if (!loaded) return <p className="expedition-index-empty ui-muted">Loading expeditions…</p>;
  if (all.length === 0)
    return (
      <p className="expedition-index-empty ui-muted">
        No expeditions in this workspace yet. Ask a Buddy to launch one for a big goal with a
        checkable done.
      </p>
    );
  const { finished, retired } = expeditionGroups(all);
  const retirable = finished.filter((e) => ownerActions(e).t === 'retire');
  return (
    <div className="expedition-index ui-stack">
      <ListSection title="Active" rows={active} />
      <ListSection title="Finished" rows={finished}>
        {retirable.length > 0 && <RetireAll ids={retirable.map((e) => e.id)} />}
      </ListSection>
      {retired.length > 0 && (
        <details className="expedition-index-retired">
          <summary className="expedition-link">{`Retired (${retired.length})`}</summary>
          <ListSection title="Retired" rows={retired} />
        </details>
      )}
    </div>
  );
}

const RetireAll = ({ ids }: { ids: readonly string[] }) => (
  <ActionButton
    act={() =>
      Promise.all(ids.map((id) => buddyWrite('expedition.retire', { id }, { mode: 'retire' })))
    }
    refetch={async () => invalidateBuddyResources()}
    label={`Retire all finished (${ids.length})`}
    busy="Retiring…"
  />
);

type SectionProps = { title: string; rows: readonly ExpeditionSummary[]; children?: ReactNode };
function ListSection({ title, rows, children }: SectionProps) {
  if (rows.length === 0) return null;
  return (
    <section className="ui-stack" aria-label={title}>
      <h3 className="expedition-index-group ui-muted">{title}</h3>
      {children}
      <ul className="expedition-index-rows">
        {rows.map((e) => (
          <ExpeditionRow key={e.id} expedition={e} variant={{ t: 'index' }} />
        ))}
      </ul>
    </section>
  );
}

export const ExpeditionsPane = ({ workspaceId }: { workspaceId: string }) => (
  <section className="channel-browser-pane ui-stack" aria-label="Expeditions">
    <header className="channel-browser-pane-header ui-row">
      <div className="channel-browser-pane-title">
        <h2>Expeditions</h2>
      </div>
    </header>
    <div className="channel-browser-scroll ui-stack ui-scroll-quiet">
      <ExpeditionList workspaceId={workspaceId} />
    </div>
  </section>
);

export function HomeExpeditions({ workspaceId }: { workspaceId: string }) {
  const { active } = useWorkspaceExpeditions(workspaceId);
  if (active.length === 0) return null;
  const waiting = active.filter(needsYou).length;
  return (
    <section className="landing-section ui-stack" aria-label="Expeditions">
      <div className="landing-section-head ui-row">
        <h2>Expeditions</h2>
        <span className="landing-count">{waiting > 0 ? `${waiting} need you` : active.length}</span>
        <Link className="landing-more" to={channelsHref(workspaceId, { kind: 'expeditions' })}>
          All expeditions
        </Link>
      </div>
      <ul className="landing-requests">
        {active.map((e) => (
          <ExpeditionRow key={e.id} expedition={e} variant={{ t: 'home' }} />
        ))}
      </ul>
    </section>
  );
}
