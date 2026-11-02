import type { ExpeditionSummary } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { expeditionRailFamily } from '../../atoms/channel-rail';
import { invalidateBuddyResources } from '../../atoms/resources';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { formatRelativeAge } from '../../utils/turn-diagnostics';
import { buddyWrite } from './api';
import { channelsHref } from './channels-view';
import { useHostAction } from './expedition-action';
import { useOpenExpedition } from './expedition-overlay';
import {
  EXPEDITIONS_POLL_MS,
  EXPEDITIONS_URL,
  RUN_LOOK,
  expeditionGroups,
  expeditionPill,
  ownerActions,
} from './expedition-view';
import '../../views/conversation-row/ConversationRow.css';
import './Expedition.css';

// Expeditions in the channels view (owner, 2026-11-01: "that's where it was supposed to go"), for
// both shells: the rail section, the index pane, and Home's "needs you" list. Every row opens the
// expedition modal over the view it sits in (expedition-overlay.ts), so Back closes it. All three
// read one cached list (GET /api/buddies/expeditions) through expeditionRailFamily.

/** This workspace's expeditions, kept fresh. */
export function useWorkspaceExpeditions(workspaceId: string) {
  usePolledFetch<ExpeditionSummary[]>(EXPEDITIONS_URL, EXPEDITIONS_POLL_MS);
  return useAtomValue(expeditionRailFamily(workspaceId));
}

/** Most rows the rail lists; the section header opens the rest. */
const RAIL_ROWS = 6;

/** The class names of one shell's rail rows: the desktop channel rail or the phone's list. */
export type RailRowClasses = {
  shell: 'desktop' | 'mobile';
  row: string;
  hash: string;
  name: string;
};

const DESKTOP_ROW: RailRowClasses = {
  shell: 'desktop',
  row: '',
  hash: 'channel-browser-hash',
  name: 'channel-browser-channel-name ui-truncate',
};

/** Where an expedition is listed: the channel rail (either shell), the index pane or Home. */
export type RowVariant = { t: 'rail'; classes: RailRowClasses } | { t: 'index' } | { t: 'home' };

/** One expedition as a row, whichever list shows it, so the dot, the pill, the line and the
 * needs-you flag cannot drift apart. δ over the variant; each handler is one layout. */
export function ExpeditionRow({
  expedition,
  variant,
}: { expedition: ExpeditionSummary; variant: RowVariant }) {
  switch (variant.t) {
    case 'rail':
      return <RailRow e={expedition} classes={variant.classes} />;
    case 'index':
      return <IndexRow e={expedition} />;
    case 'home':
      return <HomeRow e={expedition} />;
  }
}

function RailRow({ e, classes }: { e: ExpeditionSummary; classes: RailRowClasses }) {
  const open = useOpenExpedition();
  return (
    <li>
      <button
        type="button"
        className={classes.row || undefined}
        data-unread={RUN_LOOK[e.run.t].emphasis}
        onClick={() => open(e.id)}
        title={`${e.name} — ${expeditionPill(e).label}\n${e.line}`}
      >
        <span className={`${classes.hash} expedition-rail-dot`} aria-hidden="true">
          <span className="conversation-row__dot" data-status={RUN_LOOK[e.run.t].dot} />
        </span>
        <span className={classes.name}>{e.name}</span>
        {RUN_LOOK[e.run.t].needsYou && <span className="expedition-rail-flag">needs you</span>}
      </button>
    </li>
  );
}

function IndexRow({ e }: { e: ExpeditionSummary }) {
  const open = useOpenExpedition();
  const pill = expeditionPill(e);
  return (
    <li>
      <button
        type="button"
        className="expedition-index-row"
        data-needs-you={RUN_LOOK[e.run.t].needsYou || undefined}
        onClick={() => open(e.id)}
      >
        <span className="conversation-row__dot" data-status={RUN_LOOK[e.run.t].dot} />
        <span className="expedition-index-text ui-stack">
          <strong className="ui-truncate">{e.name}</strong>
          <span className="ui-muted ui-truncate">
            launched {formatRelativeAge(Date.parse(e.launchedAt))} · {e.line}
          </span>
        </span>
        <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
      </button>
    </li>
  );
}

function HomeRow({ e }: { e: ExpeditionSummary }) {
  const open = useOpenExpedition();
  return (
    <li>
      <button
        type="button"
        className="landing-request expedition-home-row"
        onClick={() => open(e.id)}
      >
        {/* data-own-dot: the run-state dot replaces the landing row's accent dot
            (ChannelLanding.css owns that rule). */}
        <span className="landing-request-from ui-row" data-own-dot="">
          <span className="conversation-row__dot" data-status={RUN_LOOK[e.run.t].dot} />
          {e.name}
        </span>
        <span className="landing-request-body">
          {expeditionPill(e).label} · {e.line}
        </span>
      </button>
    </li>
  );
}

/** The rail's last row: the count of every expedition, opening the index pane. Desktop's is a
 * button, the phone's a link; both read the same label. */
export function AllExpeditionsRow({
  workspaceId,
  count,
  classes,
  current,
}: { workspaceId: string; count: number; classes: RailRowClasses; current: boolean }) {
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

/** The desktop rail's section, between Channels and Buddies, in the rail's own row styling.
 * Absent until the workspace has an expedition, like the phone's section. */
export function RailExpeditions({
  workspaceId,
  current,
}: { workspaceId: string; current: boolean }) {
  const { loaded, all, active } = useWorkspaceExpeditions(workspaceId);
  if (!loaded || all.length === 0) return null;
  const index = channelsHref(workspaceId, { kind: 'expeditions' });
  return (
    <>
      <div className="channel-browser-rail-section-row ui-row">
        <Link
          className="channel-browser-rail-section ui-muted"
          to={index}
          aria-current={current ? 'page' : undefined}
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
          workspaceId={workspaceId}
          count={all.length}
          classes={DESKTOP_ROW}
          current={current}
        />
      </ul>
    </>
  );
}

/** Every expedition of the workspace: the unfinished first (needing you on top), then finished. */
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
      {active.length > 0 && <ListSection title="Active" rows={active} />}
      {finished.length > 0 && (
        <ListSection title="Finished" rows={finished}>
          {retirable.length > 0 && <RetireAll ids={retirable.map((e) => e.id)} />}
        </ListSection>
      )}
      {retired.length > 0 && (
        // Collapsed: retired expeditions are history, a click away.
        <details className="expedition-index-retired">
          <summary className="expedition-link">{`Retired (${retired.length})`}</summary>
          <ListSection title="Retired" rows={retired} />
        </details>
      )}
    </div>
  );
}

/** "Retire all finished (N)": one retire mutation per expedition; the list refetches after. */
function RetireAll({ ids }: { ids: readonly string[] }) {
  const { state, run } = useHostAction(
    () => Promise.all(ids.map((id) => buddyWrite('expedition.retire', { id }, { mode: 'retire' }))),
    async () => invalidateBuddyResources()
  );
  return (
    <span className="ui-row expedition-launch">
      <button
        type="button"
        className="expedition-button"
        disabled={state.t === 'pending'}
        aria-busy={state.t === 'pending'}
        onClick={run}
      >
        {state.t === 'pending' ? 'Retiring…' : `Retire all finished (${ids.length})`}
      </button>
      {state.t === 'failed' && (
        <span role="alert" className="expedition-error">
          {state.error}
        </span>
      )}
    </span>
  );
}

function ListSection({
  title,
  rows,
  children,
}: { title: string; rows: readonly ExpeditionSummary[]; children?: ReactNode }) {
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

/** The desktop main pane for `?view=expeditions`, framed like a channel. */
export function ExpeditionsPane({ workspaceId }: { workspaceId: string }) {
  return (
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
}

/** Home's list (ChannelLanding, both shells): unfinished expeditions, the ones needing you first.
 * Nothing when none run. */
export function HomeExpeditions({ workspaceId }: { workspaceId: string }) {
  const { active } = useWorkspaceExpeditions(workspaceId);
  if (active.length === 0) return null;
  const waiting = active.filter((e) => RUN_LOOK[e.run.t].needsYou).length;
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
