import { useAtomValue } from 'jotai';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { useTimeTick } from '../../hooks/useTimeTick';
import { shortenHomePath } from '../../utils/directories';
import { formatTimeAgo } from '../../utils/time';
import { ConfigDropdown } from '../ConfigDropdown';
import { PathAutocomplete } from '../PathAutocomplete';
import { BuddySigil, WorkspaceEmblem } from './BuddySigil';
import { buddyApi, errorText } from './api';
import { CHANNEL_BACKSTOP_MS, anyUnread, ownerUnreadTotal, useOwnerInboxes } from './channel-data';
import type { Workspace } from './types';
import {
  type WorkspaceActivity,
  type WorkspaceHomeRow,
  createReady,
  workspaceHomeSections,
} from './workspace-home';
import './WorkspaceHome.css';

// `/` — every Buddy workspace, the four most recently active as tiles, and
// "New workspace" from a folder (owner, #channels-feature 2026-09-25; port of
// 6d04860). Desktop renders it outside the shell, so the page bar below is its
// way to the other top-level pages; phones also keep their tab bar.
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
  // `/?new=1` (the channel rail's "New workspace") opens the creation form on arrival.
  const [params] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');

  const workspaces = overview.data ?? [];
  const totals = new Map(workspaces.map((w) => [w.id, ownerUnreadTotal(inboxes.data, w.id)]));
  const { recent, rest } = workspaceHomeSections(workspaces, totals, entries);

  return (
    <div className="workspace-home">
      <nav className="workspace-home-nav ui-row" aria-label="Pages">
        <span className="workspace-home-brand">unleashd</span>
        {DESTINATIONS.map((destination) => (
          <Link key={destination.to} to={destination.to}>
            {destination.label}
          </Link>
        ))}
        <ConfigDropdown />
      </nav>
      <main className="workspace-home-body ui-stack">
        <header className="workspace-home-header ui-row">
          <h1>Workspaces</h1>
          <button
            type="button"
            className="ui-choice workspace-home-primary"
            onClick={() => setCreating(true)}
            disabled={creating}
          >
            New workspace
          </button>
        </header>
        {creating && <CreateWorkspace onClose={() => setCreating(false)} />}
        {overview.kind === 'failed' && (
          <p className="workspace-home-error" role="alert">
            {overview.error.message}
          </p>
        )}
        {overview.data === null && overview.kind !== 'failed' && (
          <p className="ui-muted">Loading…</p>
        )}
        {overview.data?.length === 0 && (
          <p className="ui-muted">No workspaces yet. Create one from a folder.</p>
        )}
        {recent.length > 0 && (
          <section aria-label="Recent">
            <h2>Recent</h2>
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
          <section aria-label="Other workspaces">
            <h2>{recent.length > 0 ? 'Other workspaces' : 'All workspaces'}</h2>
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
    <Link
      className={`workspace-home-link ui-card workspace-home-${variant}`}
      to={channelsPath(row.id)}
    >
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

function CreateWorkspace({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const recentDirectories = useAtomValue(listField('recentDirs'));
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  const [valid, setValid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const folder = directory.trim();
  const folderName = folder.replace(/\/+$/, '').split('/').pop() ?? '';
  const ready = createReady(folder, valid);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The server resolves the folder and reuses its workspace; a blank name is the folder's.
      const workspace = await buddyApi<Workspace>('/api/buddies/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootPath: folder, ...(name.trim() ? { name: name.trim() } : {}) }),
      });
      navigate(channelsPath(workspace.id));
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <form
      className="workspace-home-create ui-card ui-stack"
      onSubmit={(event) => void handleCreate(event)}
    >
      <div className="ui-stack">
        <span className="ui-muted">Folder</span>
        <PathAutocomplete
          value={directory}
          onChange={setDirectory}
          recentDirectories={recentDirectories}
          placeholder="Search recent folders or type a path…"
          onValidationChange={setValid}
          autoFocus
        />
      </div>
      <label className="ui-stack">
        <span className="ui-muted">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={folderName || 'Defaults to the folder name'}
          autoComplete="off"
          spellCheck={false}
          maxLength={120}
        />
      </label>
      {error && (
        <p className="workspace-home-error" role="alert">
          {error}
        </p>
      )}
      <div className="ui-row workspace-home-actions">
        <button type="button" className="ui-choice" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="submit"
          className="ui-choice workspace-home-primary"
          disabled={!ready || busy}
        >
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </div>
    </form>
  );
}
