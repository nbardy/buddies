import type { ExpeditionSummary } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { Link, useNavigate } from 'react-router-dom';
import { expeditionRailFamily } from '../../atoms/channel-rail';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { formatRelativeAge } from '../../utils/turn-diagnostics';
import { channelsHref } from './channels-view';
import { useOpenExpedition } from './expedition-overlay';
import {
  EXPEDITIONS_POLL_MS,
  EXPEDITIONS_URL,
  needsYou,
  railEmphasis,
  runDot,
  runLabel,
  runTone,
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

/** The desktop rail's section, between Channels and Buddies, in the rail's own row styling. */
export function RailExpeditions({
  workspaceId,
  current,
}: { workspaceId: string; current: boolean }) {
  const { loaded, all, active } = useWorkspaceExpeditions(workspaceId);
  const open = useOpenExpedition();
  const navigate = useNavigate();
  return (
    <>
      <div className="channel-browser-rail-section-row ui-row">
        <Link
          className="channel-browser-rail-section ui-muted"
          to={channelsHref(workspaceId, { kind: 'expeditions' })}
          aria-current={current ? 'page' : undefined}
          title="Every expedition in this workspace"
        >
          Expeditions
        </Link>
      </div>
      <ul className="channel-browser-channels" aria-label="Expeditions">
        {active.slice(0, RAIL_ROWS).map((e) => (
          <li key={e.id}>
            <button
              type="button"
              data-unread={railEmphasis(e.run)}
              onClick={() => open(e.id)}
              title={`${e.name} — ${runLabel(e.run)}\n${summaryLine(e)}`}
            >
              <span className="channel-browser-hash expedition-rail-dot" aria-hidden="true">
                <span className="conversation-row__dot" data-status={runDot(e.run)} />
              </span>
              <span className="channel-browser-channel-name ui-truncate">{e.name}</span>
              {needsYou(e.run) && <span className="expedition-rail-flag">needs you</span>}
            </button>
          </li>
        ))}
        {loaded && all.length > 0 && (
          <li>
            <button
              type="button"
              data-unread="read"
              aria-current={current ? 'page' : undefined}
              onClick={() => navigate(channelsHref(workspaceId, { kind: 'expeditions' }))}
            >
              <span className="channel-browser-hash ui-muted" aria-hidden="true">
                ⋯
              </span>
              <span className="channel-browser-channel-name ui-truncate">
                All expeditions{active.length > RAIL_ROWS ? ` (${all.length})` : ''}
              </span>
            </button>
          </li>
        )}
      </ul>
      {loaded && all.length === 0 && (
        <p className="channel-browser-rail-empty ui-muted">None yet. Ask a Buddy to launch one.</p>
      )}
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
  const finished = all.filter((e) => e.run.t === 'finished');
  return (
    <div className="expedition-index ui-stack">
      {active.length > 0 && <ExpeditionGroup title="Active" rows={active} />}
      {finished.length > 0 && <ExpeditionGroup title="Finished" rows={finished} />}
    </div>
  );
}

function ExpeditionGroup({ title, rows }: { title: string; rows: readonly ExpeditionSummary[] }) {
  const open = useOpenExpedition();
  return (
    <section className="ui-stack" aria-label={title}>
      <h3 className="expedition-index-group ui-muted">{title}</h3>
      <ul className="expedition-index-rows">
        {rows.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="expedition-index-row"
              data-needs-you={needsYou(e.run) || undefined}
              onClick={() => open(e.id)}
            >
              <span className="conversation-row__dot" data-status={runDot(e.run)} />
              <span className="expedition-index-text ui-stack">
                <strong className="ui-truncate">{e.name}</strong>
                <span className="ui-muted ui-truncate">
                  launched {formatRelativeAge(Date.parse(e.launchedAt))} · {summaryLine(e)}
                </span>
              </span>
              <span className={`expedition-pill expedition-tone-${runTone(e.run)}`}>
                {runLabel(e.run)}
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
  const waiting = active.filter((e) => needsYou(e.run)).length;
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
              <span className="landing-request-from ui-row">
                <span className="conversation-row__dot" data-status={runDot(e.run)} />
                {e.name}
              </span>
              <span className="landing-request-body">
                {runLabel(e.run)} · {summaryLine(e)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
