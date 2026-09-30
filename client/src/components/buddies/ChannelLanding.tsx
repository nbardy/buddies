import { useAtomValue } from 'jotai';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { forgetRetiredHomePins, retiredHomePinsAtom } from '../../atoms/ui';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { formatTimeAgo } from '../../utils/time';
import { BuddySigil } from './BuddySigil';
import { ChannelComposer } from './ChannelComposer';
import { liveRunsUrl } from './BuddyWorkspaceActivity';
import { useThreadsView } from './threads-view';
import {
  type WorkspaceDirectory,
  authorName,
  channelHeading,
  inboxRequests,
  workspaceTasksUrl,
} from './channel-data';
import { channelLinkPath, postLink } from './channel-link';
import { channelsHref } from './channels-view';
import {
  type HomeTask,
  type PinWrite,
  appendPin,
  excerpt,
  statusLabel,
  firstImage,
  importPins,
  movePin,
  unpin,
  homeTasks,
  recentThreads,
  threadLatest,
} from './home-view';
import { mediaUrl } from './channel-text';
import { ActionError, useBuddyAction } from './useBuddyAction';
import { buddyWrite } from './api';
import type { Inbox, Run, Task } from './types';
import './ChannelLanding.css';

// The workspace Home (owner, 2026-09-30): what to pick up, who needs you, where to begin.
// One component for both shells; the shell passes `frame` and the Home does not know which.
// The Tasks section: pins, then recent projects; search finds any Task. Pins are `Task.pin`, stored
// on the server: desktop, phone and Buddies (`task_write`) share them.

const NO_RUNS: readonly Run[] = [];
const NO_IDS: readonly string[] = [];
const DESKTOP_TASKS = 4;
const THREAD_CARDS = 4;

export function ChannelLanding({
  workspaceId,
  directory,
  inbox,
  generalChannelId,
  frame,
}: {
  workspaceId: string;
  directory: WorkspaceDirectory;
  inbox: Inbox | null;
  /** #general: where the Home composer posts; null when the workspace has no such channel. */
  generalChannelId: string | null;
  frame: 'desktop' | 'mobile';
}) {
  const navigate = useNavigate();
  return (
    <div className="landing ui-stack" data-frame={frame}>
      <header className="landing-hero ui-stack">
        <BuddySigil name={directory.workspaceName} className="landing-aura" />
        <BuddySigil name={directory.workspaceName} className="landing-emblem" />
        <h1>What should the team build next?</h1>
        {generalChannelId !== null ? (
          <div className="landing-composer">
            <ChannelComposer
              channelId={generalChannelId}
              placeholder="Describe the work — @mention a Buddy to start it"
              rootId={null}
              references={directory.references}
              submit={frame === 'desktop' ? 'enter' : 'button'}
              onPosted={({ post }) =>
                navigate(
                  channelLinkPath(workspaceId, {
                    kind: 'thread',
                    channelId: post.channelId,
                    rootId: post.id,
                  })
                )
              }
            />
          </div>
        ) : null}
        {directory.activeMembers.length === 0 && (
          <p className="landing-note ui-muted">
            Posting saves a thread{generalChannelId ? ' in #general' : ''}; nobody answers yet. To
            get a reply, hire a Buddy from the rail, then @mention it.
          </p>
        )}
      </header>
      <TaskSection
        workspaceId={workspaceId}
        directory={directory}
        channelId={generalChannelId ?? inbox?.channels[0]?.channel.id ?? null}
        frame={frame}
      />
      <WaitingOnYou workspaceId={workspaceId} directory={directory} inbox={inbox} />
      <RecentThreads workspaceId={workspaceId} directory={directory} />
      <WorkingNow workspaceId={workspaceId} directory={directory} />
    </div>
  );
}

// ── Tasks ───────────────────────────────────────────────────────────────────

function TaskSection({
  workspaceId,
  directory,
  channelId,
  frame,
}: {
  workspaceId: string;
  directory: WorkspaceDirectory;
  channelId: string | null;
  frame: 'desktop' | 'mobile';
}) {
  const tasks = usePolledFetch<Task[]>(workspaceTasksUrl(workspaceId), 15_000);
  const action = useBuddyAction(async () => tasks.refetch());
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const cards = homeTasks(directory.tasks, query);
  const shown =
    frame === 'desktop' && !showAll && !searching ? cards.slice(0, DESKTOP_TASKS) : cards;
  const retired = useAtomValue(retiredHomePinsAtom)[workspaceId] ?? NO_IDS;
  // Pins are a Task field (`task_write` `pin`): the same write path, authority and change push
  // Buddies use. One CAS update per Task whose key changes.
  const save = async (writes: readonly PinWrite[]) => {
    for (const { task, pin } of writes) {
      await buddyWrite(`/api/buddies/tasks/${encodeURIComponent(task.id)}`, 'PATCH', {
        baseRevision: task.revision,
        changes: { pin },
      });
    }
  };
  const write = (writes: readonly PinWrite[]) => void action.run('pin', () => save(writes));
  return (
    <section className="landing-section ui-stack" aria-label="Tasks">
      <div className="landing-section-head ui-row">
        <h2>Tasks</h2>
        {frame === 'desktop' && !searching && cards.length > DESKTOP_TASKS && (
          <button type="button" className="landing-more" onClick={() => setShowAll((all) => !all)}>
            {showAll ? 'Show fewer' : `Show all (${cards.length})`}
          </button>
        )}
      </div>
      <input
        type="search"
        className="landing-search"
        placeholder="Search Tasks"
        aria-label="Search Tasks"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ActionError state={action.state} />
      {retired.length > 0 && tasks.data && (
        <RetiredPins
          saved={retired.length}
          imports={importPins(tasks.data, retired)}
          busy={action.busy}
          onImport={(imports) =>
            void action.run('import', async () => {
              await save(imports);
              forgetRetiredHomePins(workspaceId);
            })
          }
          onDiscard={() => forgetRetiredHomePins(workspaceId)}
        />
      )}
      {cards.length === 0 ? (
        <p className="landing-empty ui-muted">
          {searching
            ? 'No Task matches.'
            : 'Recent projects (Tasks with todos) and your pins show here. Search to pin any Task.'}
        </p>
      ) : (
        <ul className="landing-projects">
          {shown.map((entry) => (
            <TaskCard
              key={entry.task.id}
              entry={entry}
              workspaceId={workspaceId}
              channelId={channelId}
              buddyNames={directory.buddyNames}
              busy={action.busy}
              onTogglePin={() =>
                write(entry.pinned ? unpin(entry.task) : appendPin(directory.tasks, entry.task))
              }
              menu={{
                earlier: () => write(movePin(directory.tasks, entry.task, -1)),
                later: () => write(movePin(directory.tasks, entry.task, 1)),
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Pins this device saved before pins were shared: import them as server pins, or discard them. */
function RetiredPins({
  saved,
  imports,
  busy,
  onImport,
  onDiscard,
}: {
  saved: number;
  imports: readonly PinWrite[];
  busy: boolean;
  onImport(imports: readonly PinWrite[]): void;
  onDiscard(): void;
}) {
  const stale = saved - imports.length;
  return (
    <div className="landing-retired ui-card ui-surface ui-stack">
      <p>
        {saved === 1 ? '1 pin was' : `${saved} pins were`} saved on this device before pins were
        shared with your Buddies.
        {stale > 0 && ` ${stale} no longer ${stale === 1 ? 'matches' : 'match'} an unpinned Task.`}
      </p>
      <div className="ui-row">
        {imports.length > 0 && (
          <button
            type="button"
            className="ui-control"
            disabled={busy}
            onClick={() => onImport(imports)}
          >
            Import {imports.length === 1 ? '1 pin' : `${imports.length} pins`}
          </button>
        )}
        <button type="button" className="ui-control" disabled={busy} onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}

function TaskCard({
  entry,
  workspaceId,
  channelId,
  buddyNames,
  busy,
  onTogglePin,
  menu,
}: {
  entry: HomeTask;
  workspaceId: string;
  channelId: string | null;
  buddyNames: Readonly<Record<string, string>>;
  busy: boolean;
  onTogglePin(): void;
  menu: { earlier(): void; later(): void };
}) {
  const { task, progress, next } = entry;
  const owner = buddyNames[task.ownerId] ?? 'Buddy';
  const title = <span className="landing-project-title">{task.title}</span>;
  return (
    <li className="landing-project ui-card ui-surface" data-status={task.status}>
      <div className="landing-project-body ui-stack">
        <div className="landing-project-top ui-row">
          <span className="landing-status-row ui-row">
            <span role="img" title={owner} aria-label={`Owner: ${owner}`}>
              <BuddySigil name={owner} className="landing-chip-face" />
            </span>
            <span className="landing-status" data-status={task.status}>
              {statusLabel(task.status)}
            </span>
          </span>
          <span className="landing-card-actions ui-row">
            {entry.pinned && <ReorderMenu title={task.title} menu={menu} />}
            <button
              type="button"
              className="landing-pin ui-control"
              aria-pressed={entry.pinned}
              disabled={busy}
              aria-label={`${entry.pinned ? 'Unpin' : 'Pin'} ${task.title}`}
              title={entry.pinned ? 'Unpin' : 'Pin to Home (shared with your Buddies)'}
              onClick={onTogglePin}
            >
              {entry.pinned ? '★' : '☆'}
            </button>
          </span>
        </div>
        {channelId ? (
          <Link
            className="landing-project-link"
            to={channelsHref(workspaceId, { kind: 'task', channelId, taskId: task.id })}
          >
            {title}
          </Link>
        ) : (
          title
        )}
        {next && <p className="landing-project-next">{next}</p>}
      </div>
      <ProgressFoot progress={progress} />
    </li>
  );
}

function ReorderMenu({
  title,
  menu,
}: {
  title: string;
  menu: { earlier(): void; later(): void };
}) {
  const [open, setOpen] = useState(false);
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="landing-menu">
      <button
        type="button"
        className="landing-menu-button ui-control"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Reorder ${title}`}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        <div className="landing-menu-list ui-surface" role="menu">
          <button type="button" role="menuitem" onClick={run(menu.earlier)}>
            Move earlier
          </button>
          <button type="button" role="menuitem" onClick={run(menu.later)}>
            Move later
          </button>
        </div>
      )}
    </div>
  );
}

function ProgressFoot({ progress }: { progress: HomeTask['progress'] }) {
  switch (progress.kind) {
    case 'none':
      return (
        <div className="landing-foot ui-stack">
          <span className="landing-progress-label ui-muted">No todos yet</span>
          <span className="landing-bar landing-bar--dashed" aria-hidden="true" />
        </div>
      );
    case 'no_active':
      return (
        <div className="landing-foot ui-stack">
          <span className="landing-progress-label ui-muted">No active todos</span>
          <span className="landing-bar landing-bar--dashed" aria-hidden="true" />
        </div>
      );
    case 'counted': {
      const share = (count: number) => `${(count / progress.total) * 100}%`;
      const rest = [
        progress.inProgress > 0 ? `${progress.inProgress} in progress` : null,
        progress.blocked > 0 ? `${progress.blocked} blocked` : null,
      ].filter((part) => part !== null);
      return (
        <div className="landing-foot ui-stack">
          <span className="landing-progress-label ui-row">
            <span>
              <strong>
                {progress.done} of {progress.total}
              </strong>{' '}
              · {progress.percent}%
            </span>
            {rest.length > 0 && <span className="ui-muted">{rest.join(' · ')}</span>}
          </span>
          {/* Only green is progress; the tinted segments are unfinished work, named in the label. */}
          <span
            className="landing-bar"
            role="progressbar"
            aria-label="Todos done"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            aria-valuetext={`${progress.done} of ${progress.total} todos done`}
          >
            <span className="landing-bar-done" style={{ width: share(progress.done) }} />
            <span className="landing-bar-active" style={{ width: share(progress.inProgress) }} />
            <span className="landing-bar-blocked" style={{ width: share(progress.blocked) }} />
          </span>
        </div>
      );
    }
  }
}

// ── Waiting on you ──────────────────────────────────────────────────────────

function WaitingOnYou({
  workspaceId,
  directory,
  inbox,
}: {
  workspaceId: string;
  directory: WorkspaceDirectory;
  inbox: Inbox | null;
}) {
  // A loading inbox is not "nothing needs you": render nothing until it arrives.
  if (inbox === null) return null;
  const requests = inboxRequests(inbox);
  if (requests.length === 0) return null;
  return (
    <section className="landing-section ui-stack" aria-label="Waiting on you">
      <div className="landing-section-head ui-row">
        <h2>Waiting on you</h2>
        <span className="ui-muted">{requests.length}</span>
      </div>
      <ul className="landing-requests ui-stack">
        {requests.map((post) => (
          <li key={post.id}>
            <Link
              className="landing-request ui-card ui-surface ui-stack"
              to={channelLinkPath(workspaceId, postLink(post))}
            >
              <span className="landing-request-from">
                {authorName(post.author, directory.buddyNames)} asks
              </span>
              <span className="landing-request-body">{excerpt(post.body, 160)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Recent threads ──────────────────────────────────────────────────────────

function RecentThreads({
  workspaceId,
  directory,
}: {
  workspaceId: string;
  directory: WorkspaceDirectory;
}) {
  const { followed } = useThreadsView(workspaceId);
  const threads = recentThreads(followed.data?.threads ?? [], THREAD_CARDS);
  if (followed.data === null) return null;
  return (
    <section className="landing-section ui-stack" aria-label="Pick up where you left off">
      <div className="landing-section-head ui-row">
        <h2>Pick up where you left off</h2>
        <Link className="landing-all ui-muted" to={channelsHref(workspaceId, { kind: 'threads' })}>
          All threads ›
        </Link>
      </div>
      {threads.length === 0 ? (
        <p className="landing-empty ui-muted">Threads you start or reply in show up here.</p>
      ) : (
        <ul className="landing-threads">
          {threads.map((thread) => {
            const latest = threadLatest(thread);
            const image = firstImage(thread.root.body) ?? firstImage(latest.body);
            const heading = channelHeading(thread.channel.kind, directory.buddyNames);
            return (
              <li key={thread.root.id}>
                <Link
                  className="landing-thread ui-card ui-surface"
                  to={channelLinkPath(workspaceId, {
                    kind: 'thread',
                    channelId: thread.channel.id,
                    rootId: thread.root.id,
                  })}
                >
                  {image ? (
                    <img
                      className="landing-thread-image"
                      src={mediaUrl(image)}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="landing-thread-lead" aria-hidden="true">
                      {excerpt(thread.root.body, 90)}
                    </span>
                  )}
                  <span className="landing-thread-meta ui-stack">
                    <span className="landing-thread-title">{excerpt(thread.root.body, 80)}</span>
                    <span className="landing-thread-latest ui-muted">
                      {authorName(latest.author, directory.buddyNames)}: {excerpt(latest.body, 90)}
                    </span>
                    <span className="landing-thread-foot ui-muted">
                      {heading.mark}
                      {heading.name} · {thread.replies} {thread.replies === 1 ? 'reply' : 'replies'}{' '}
                      · {formatTimeAgo(new Date(latest.createdAt))}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Working now ─────────────────────────────────────────────────────────────

function WorkingNow({
  workspaceId,
  directory,
}: {
  workspaceId: string;
  directory: WorkspaceDirectory;
}) {
  const live = usePolledFetch<Run[]>(liveRunsUrl(workspaceId), 5_000);
  const runs = live.data ?? NO_RUNS;
  if (runs.length === 0) return null;
  return (
    <section className="landing-working ui-row" aria-label="Working now">
      <span className="landing-working-dot" aria-hidden="true" />
      <span className="ui-muted">Working now</span>
      <ul className="ui-row">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              className="landing-chip ui-row"
              to={channelsHref(workspaceId, { kind: 'workers', buddyId: run.buddyId })}
            >
              <BuddySigil
                name={directory.buddyNames[run.buddyId] ?? 'Buddy'}
                className="landing-chip-face"
              />
              <span>
                {directory.buddyNames[run.buddyId] ?? 'Buddy'}
                {run.status === 'queued' ? ' · queued' : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
