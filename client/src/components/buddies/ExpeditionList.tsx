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
  summaryLine,
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
export type RailRowClasses = { row: string; hash: string; name: string };

const DESKTOP_ROW: RailRowClasses = {
  row: '',
  hash: 'channel-browser-hash',
  name: 'channel-browser-channel-name ui-truncate',
};

/** One expedition as a rail row, shared by both shells so the dot, the emphasis and the
 * needs-you flag cannot drift apart. */
export function ExpeditionRailRow({
  expedition: e,
  classes,
}: { expedition: ExpeditionSummary; classes: RailRowClasses }) {
  const open = useOpenExpedition();
  return (
    <li>
      <button
        type="button"
        className={classes.row || undefined}
        data-unread={RUN_LOOK[e.run.t].emphasis}
        onClick={() => open(e.id)}
        title={`${e.name} — ${expeditionPill(e).label}\n${summaryLine(e)}`}
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

/** The rail's last row: the count of every expedition, opening the index pane. */
export function allExpeditionsLabel(count: number): string {
  return `All expeditions (${count})`;
}

/** The desktop rail's section, between Channels and Buddies, in the rail's own row styling.
 * Absent until the workspace has an expedition, like the phone's section. */
export function RailExpeditions({
  workspaceId,
  current,
}: { workspaceId: string; current: boolean }) {
  const { loaded, all, active } = useWorkspaceExpeditions(workspaceId);
  const navigate = useNavigate();
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
          <ExpeditionRailRow key={e.id} expedition={e} classes={DESKTOP_ROW} />
        ))}
        <li>
          <button
            type="button"
            data-unread="read"
            aria-current={current ? 'page' : undefined}
            onClick={() => navigate(index)}
          >
            <span className="channel-browser-hash ui-muted" aria-hidden="true">
              ⋯
            </span>
            <span className="channel-browser-channel-name ui-truncate">
              {allExpeditionsLabel(all.length)}
            </span>
          </button>
        </li>
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
      {active.length > 0 && <ExpeditionGroup title="Active" rows={active} />}
      {finished.length > 0 && (
        <ExpeditionGroup title="Finished" rows={finished}>
          {retirable.length > 0 && <RetireAll ids={retirable.map((e) => e.id)} />}
        </ExpeditionGroup>
      )}
      {retired.length > 0 && (
        // Collapsed: retired expeditions are history, a click away.
        <details className="expedition-index-retired">
          <summary className="expedition-link">{`Retired (${retired.length})`}</summary>
          <ExpeditionGroup title="Retired" rows={retired} />
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

function ExpeditionGroup({
  title,
  rows,
  children,
}: { title: string; rows: readonly ExpeditionSummary[]; children?: ReactNode }) {
  const open = useOpenExpedition();
  return (
    <section className="ui-stack" aria-label={title}>
      <h3 className="expedition-index-group ui-muted">{title}</h3>
      {children}
      <ul className="expedition-index-rows">
        {rows.map((e) => (
          <li key={e.id}>
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
                  launched {formatRelativeAge(Date.parse(e.launchedAt))} · {summaryLine(e)}
                </span>
              </span>
              <span className={`expedition-pill expedition-tone-${expeditionPill(e).tone}`}>
                {expeditionPill(e).label}
              </span>
            </button>
          </li>
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
  const open = useOpenExpedition();
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
          <li key={e.id}>
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
                {expeditionPill(e).label} · {summaryLine(e)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
