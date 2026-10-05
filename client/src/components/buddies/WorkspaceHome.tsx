import { useAtomValue } from 'jotai';
import { Link, useSearchParams } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { useTimeTick } from '../../hooks/useTimeTick';
import { shortenHomePath } from '../../utils/directories';
import { formatTimeAgo } from '../../utils/time';
import { ConfigDropdown } from '../ConfigDropdown';
import { BuddySigil, WorkspaceEmblem } from './BuddySigil';
import { WorkspaceTeamForm } from './WorkspaceTeamForm';
import { CHANNEL_BACKSTOP_MS, anyUnread, ownerUnreadTotal, useOwnerInboxes } from './channel-data';
import {
  type WorkspaceActivity,
  type WorkspaceHomeRow,
  workspaceHomeSections,
} from './workspace-home';
import './ChannelLanding.css';
import './WorkspaceHome.css';

// `/` — every Buddy workspace, the four most recently active as tiles, and
// "New workspace" from a folder (owner, #channels-feature 2026-09-25; port of
// 6d04860). Desktop renders it outside the shell, so the page bar below is its
// way to the other top-level pages; phones also keep their tab bar.
// Restyled on the workspace Home's vocabulary (ChannelLanding.css: aurora hero, display
// type, cards), and onboarding lands here (owner, #buddies-dev 2026-10-05).
const DESTINATIONS = [
  { to: '/chats', label: 'Chats' },
  { to: '/buddies', label: 'Buddies' },
  { to: '/workers', label: 'Workers' },
] as const;

const channelsPath = (workspaceId: string) =>
  `/buddies/workspaces/${encodeURIComponent(workspaceId)}/channels`;

export function WorkspaceHome() {
  const overview = useBuddyOverview(CHANNEL_BACKSTOP_MS);
  const inboxes = useOwnerInboxes();
  const entries = useAtomValue(listField('buddyEntries'));
  // The URL owns "creating": arriving at `/?new=1` while already on `/` must open it too.
  const [params, setParams] = useSearchParams();
  const empty = overview.data?.length === 0;
  const creating = empty || params.get('new') === '1';

  const workspaces = overview.data ?? [];
  const totals = new Map(workspaces.map((w) => [w.id, ownerUnreadTotal(inboxes.data, w.id)]));
  const { recent, rest } = workspaceHomeSections(workspaces, totals, entries);

  return (
    <div className="workspace-home">
      <nav className="workspace-home-nav ui-row" aria-label="Pages">
        {DESTINATIONS.map((destination) => (
          <Link key={destination.to} to={destination.to}>
            {destination.label}
          </Link>
        ))}
        <ConfigDropdown />
      </nav>
      <main className="landing workspace-home-body ui-stack">
        <header className="landing-hero ui-stack">
          <div className="landing-aura" aria-hidden="true" />
          <h1>{empty ? 'Start your first workspace' : 'Where do you want to work?'}</h1>
          {empty && (
            <p className="workspace-home-lede">
              Pick a project folder, say what you are building, and we will staff a team of Buddies
              for it.
            </p>
          )}
          {creating ? (
            <section className="workspace-home-create ui-stack" aria-label="New workspace">
              {!empty && (
                <button
                  type="button"
                  className="workspace-home-close"
                  aria-label="Close new workspace"
                  onClick={() => setParams({}, { replace: true })}
                >
                  ✕
                </button>
              )}
              <WorkspaceTeamForm />
            </section>
          ) : (
            <button
              type="button"
              className="onboarding-primary"
              onClick={() => setParams({ new: '1' }, { replace: true })}
            >
              New workspace
            </button>
          )}
        </header>
        {overview.kind === 'failed' && (
          <p className="workspace-home-error" role="alert">
            {overview.error.message}
          </p>
        )}
        {overview.data === null && overview.kind !== 'failed' && (
          <p className="ui-muted">Loading…</p>
        )}
        {recent.length > 0 && (
          <section className="landing-section ui-stack" aria-label="Recent">
            <div className="landing-section-head ui-row">
              <h2>Recent</h2>
            </div>
            <ul className="workspace-home-tiles">
              {recent.map((row) => (
                <li key={row.id}>
                  <WorkspaceLink row={row} variant="tile" />
                </li>
              ))}
            </ul>
          </section>
        )}
        {rest.length > 0 && (
          <section className="landing-section ui-stack" aria-label="Other workspaces">
            <div className="landing-section-head ui-row">
              <h2>{recent.length > 0 ? 'Other workspaces' : 'All workspaces'}</h2>
            </div>
            <ul className="workspace-home-list ui-stack">
              {rest.map((row) => (
                <li key={row.id}>
                  <WorkspaceLink row={row} variant="row" />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

/** A tile (recent) and a list row share one markup; CSS lays out each variant. */
function WorkspaceLink({ row, variant }: { row: WorkspaceHomeRow; variant: 'tile' | 'row' }) {
  return (
    <Link className={`workspace-home-link workspace-home-${variant}`} to={channelsPath(row.id)}>
      <WorkspaceEmblem className="workspace-home-icon" name={row.name} />
      <span className="workspace-home-copy ui-stack">
        <span className="workspace-home-name ui-truncate">{row.name}</span>
        <span className="workspace-home-path ui-truncate ui-muted">
          {shortenHomePath(row.rootPath)}
        </span>
      </span>
      <Activity activity={row.activity} />
      <Notifications row={row} />
    </Link>
  );
}

/** Requests waiting on you are a count; new channel posts or thread replies are a dot. */
function Notifications({ row }: { row: WorkspaceHomeRow }) {
  const { requests, unreadChannels, unreadThreads } = row.total;
  if (requests > 0) {
    const label = `${requests} ${requests === 1 ? 'request' : 'requests'} waiting on you`;
    return (
      <span className="workspace-home-badge" title={label} aria-label={label}>
        {requests}
      </span>
    );
  }
  if (anyUnread(row.total)) {
    const label = [
      unreadChannels > 0 &&
        `new posts in ${unreadChannels} ${unreadChannels === 1 ? 'channel' : 'channels'}`,
      unreadThreads > 0 &&
        `new replies in ${unreadThreads} ${unreadThreads === 1 ? 'thread' : 'threads'}`,
    ]
      .filter(Boolean)
      .join(', ');
    return <span className="workspace-home-dot" title={label} aria-label={label} />;
  }
  return null;
}

function Activity({ activity }: { activity: WorkspaceActivity }) {
  switch (activity.kind) {
    case 'active':
      return <ActiveBuddies activity={activity} />;
    case 'quiet':
      return null;
  }
}

function ActiveBuddies({ activity }: { activity: Extract<WorkspaceActivity, { kind: 'active' }> }) {
  useTimeTick();
  const names = activity.buddies.map((buddy) => buddy.name).join(', ');
  return (
    <span className="workspace-home-activity ui-row ui-muted" title={`Recently active: ${names}`}>
      {activity.buddies.map((buddy) => (
        <BuddySigil key={buddy.id} className="workspace-home-face" name={buddy.name} />
      ))}
      <time dateTime={new Date(activity.lastActiveMs).toISOString()}>
        {formatTimeAgo(new Date(activity.lastActiveMs))}
      </time>
    </span>
  );
}
