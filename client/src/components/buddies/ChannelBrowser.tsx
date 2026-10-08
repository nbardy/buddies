import { mentionsABuddy } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { buddyRailFamily, channelRailFamily } from '../../atoms/channel-rail';
import { listField, rowFamily } from '../../atoms/conversations';
import { openSetupAt, setThreadWidth, threadWidthAtom } from '../../atoms/ui';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { useScrollActivity } from '../../hooks/useScrollActivity';
import { rowBuddy } from '../../utils/conversation-row';
import { Chat } from '../Chat';
import { AppSettingsDropdown } from './AppSettingsDropdown';
import { BuddyRailRow, CreatingBuddyRailRow } from './BuddyRailRow';
import { BuddySigil } from './BuddySigil';
import { ArchivedChannels, ChannelHeaderControls, useArchivedChannels } from './ChannelArchive';
import type { OpenDm } from './ChannelAuthor';
import { ChannelComposer } from './ChannelComposer';
import { ChannelDm } from './ChannelDm';
import { ChannelLanding } from './ChannelLanding';
import { ChannelHistory, ChannelLoader } from './ChannelLoader';
import { LeadRow, Replying, type RowContext, renderRow, renderRows } from './ChannelRows';
import { ChannelSearch } from './ChannelSearch';
import { ChannelStar } from './ChannelStar';
import { ChannelWorkers } from './ChannelWorkers';
import { CopyLinkButton } from './CopyLinkButton';
import { GroupDmNotice } from './GroupDmNotice';
import { HighlightRow } from './HighlightRow';
import { TaskFilter } from './TaskFilter';
import { TaskPage } from './TaskPage';
import { ThreadsPane } from './ThreadsPane';
import { WorkspaceTeamDialog } from './WorkspaceTeamForm';
import { errorText } from './api';
import { useNewBuddy } from './buddy-direct-actions';
import {
  type ChannelHeading,
  type WorkspaceDirectory,
  arrivalOf,
  channelFeed,
  channelHeading,
  channelRequestCount,
  channelRows,
  channelUnreadAttr,
  createChannel,
  feedPhase,
  firstUnreadPostId,
  isGroupDm,
  newestServedId,
  renderFeed,
  unreadThreadIds,
  useChannelFeed,
  useChannelResponding,
  useFollowBottom,
  useMarkRead,
  useThreadView,
  useWarmChannelPosts,
  useWithOutbox,
  useWorkspaceDirectory,
  useWorkspaceInbox,
} from './channel-data';
import { channelLinkPath } from './channel-link';
import { plainChannelText } from './channel-text';
import { type ChannelsView, channelsHref, channelsView } from './channels-view';
import type { Channel, ChannelUnread, Inbox } from './types';
import { initials } from './ui-contract';
import { NEW_WORKSPACE_PATH } from './workspace-home';
import './ChannelBrowser.css';

const NO_THREADS: ReadonlySet<string> = new Set();

function ThreadPane({
  entry,
  heading,
  rootId,
  context,
  onClose,
}: {
  entry: ChannelUnread;
  heading: ChannelHeading;
  rootId: string;
  context: RowContext;
  onClose(): void;
}) {
  const channelId = entry.channel.id;
  const width = useAtomValue(threadWidthAtom);
  const paneId = useId();
  const paneRef = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const scrollActivity = useScrollActivity();
  const { thread, root, replying, replyRows, follow, onPosted } = useThreadView(
    channelId,
    rootId,
    context.linkedPostId,
    context.directory.buddyNames
  );
  return (
    <aside
      id={paneId}
      ref={paneRef}
      className="channel-thread ui-stack"
      aria-label="Thread"
      style={{ width: `min(${width}px, calc(100% - min(320px, 45%)))` }}
    >
      {/* Keep the channel readable when a saved width exceeds the current window.
          Hover/focus left a full-height purple stripe after release; only active drag glows.
          Guard: thread-resize.test.mjs checks release, scrolling, reload and narrow windows. */}
      <div
        className="channel-thread-resize"
        role="separator"
        tabIndex={0}
        aria-label="Resize thread"
        data-resizing={resizing || undefined}
        aria-orientation="vertical"
        aria-controls={paneId}
        aria-valuemin={320}
        aria-valuemax={960}
        aria-valuenow={width}
        title="Drag to resize thread. Arrow keys adjust; double-click resets."
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
          drag.current = {
            x: event.clientX,
            width: paneRef.current?.getBoundingClientRect().width ?? width,
          };
        }}
        onPointerMove={(event) => {
          if (drag.current) setThreadWidth(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={(event) => {
          drag.current = null;
          setResizing(false);
          event.currentTarget.blur();
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setResizing(false);
        }}
        onDoubleClick={() => setThreadWidth(420)}
        onKeyDown={(event) => {
          const next = { ArrowLeft: width + 24, ArrowRight: width - 24, Home: 320, End: 960 }[
            event.key
          ];
          if (next === undefined) return;
          event.preventDefault();
          setThreadWidth(next);
        }}
      />
      <header className="channel-thread-header ui-row">
        <div>
          <h2>Thread</h2>
          <p>
            {heading.mark}
            {heading.name}
          </p>
        </div>
        <div className="channel-thread-header-actions">
          <CopyLinkButton
            className="channel-browser-header-action"
            path={channelLinkPath(context.workspaceId, { kind: 'thread', channelId, rootId })}
            label="Copy link to thread"
          />
          <button type="button" onClick={onClose} aria-label="Close thread" title="Close thread">
            ✕
          </button>
        </div>
      </header>
      <div
        className="channel-browser-scroll ui-stack ui-scroll-quiet"
        data-scrolling={scrollActivity['data-scrolling']}
        ref={follow.scrollRef}
        onScroll={(event) => {
          follow.onScroll(event);
          scrollActivity.onScroll();
        }}
      >
        {(thread.latest.kind === 'failed' || thread.latest.kind === 'stale') && (
          <p className="channel-browser-error" role="alert">
            Thread could not refresh: {thread.latest.error.message}
          </p>
        )}
        {thread.latest.kind === 'loading' && <ChannelLoader label="Loading thread…" />}
        {root && (
          <ol className="channel-browser-messages channel-thread-root">
            <LeadRow post={root} context={context} />
          </ol>
        )}
        {root && (
          <div className="channel-thread-divider ui-muted ui-row">
            <span>Replies</span>
          </div>
        )}
        {root && (
          <ChannelHistory
            edge={thread.edge}
            scrollRef={follow.scrollRef}
            onReach={() => void thread.loadOlder(follow.hold)}
          />
        )}
        <ol className="channel-browser-messages">
          {replyRows.map((row) => renderRow(row, context))}
        </ol>
        {replying !== undefined && (
          <div className="channel-thread-replying">
            <Replying text={replying} />
          </div>
        )}
      </div>
      {isGroupDm(entry.channel.kind) && <GroupDmNotice />}
      {!entry.channel.archivedAt && !isGroupDm(entry.channel.kind) && (
        <ChannelComposer
          key={rootId}
          channelId={channelId}
          rootId={rootId}
          placeholder={root ? `Reply to ${plainChannelText(root.body).slice(0, 40)}…` : 'Reply…'}
          references={context.directory.references}
          submit="enter"
          autoFocus
          onPosted={onPosted}
        />
      )}
    </aside>
  );
}

function ChannelPane({
  entry,
  workspaceId,
  directory,
  availableConversationIds,
  threadId,
  linkedPostId,
  taskFilter,
  channelNames,
  onThread,
  onTaskFilter,
  openDm,
}: {
  entry: ChannelUnread;
  workspaceId: string;
  directory: WorkspaceDirectory;
  availableConversationIds: ReadonlySet<string>;
  threadId: string | null;
  linkedPostId: string | null;
  taskFilter: string | null;
  channelNames: ReadonlyMap<string, string>;
  onThread: (rootId: string | null) => void;
  onTaskFilter: (taskId: string | null) => void;
  openDm: OpenDm;
}) {
  const channelId = entry.channel.id;
  const heading = channelHeading(entry.channel.kind, directory.buddyNames);
  const feed = useChannelFeed(channelFeed(channelId));
  const respondingByRoot = useChannelResponding(channelId, directory.buddyNames);
  const posts = useWithOutbox(channelId, null, feed.posts);
  const rows = useMemo(() => channelRows(posts ?? []), [posts]);
  const follow = useFollowBottom(rows.length, posts, null);
  const scrollActivity = useScrollActivity();
  // What was unread when the owner arrived; this visit's read marks never move it.
  const [arrival] = useState(() => arrivalOf(entry));
  const [opened, setOpened] = useState<ReadonlySet<string>>(NO_THREADS);
  useMarkRead({ kind: 'channel', channelId }, entry.unread > 0, newestServedId(feed.posts));
  const unreadThreads = useMemo(() => {
    const unread = new Set(unreadThreadIds(feed.threads, arrival));
    for (const rootId of opened) unread.delete(rootId);
    if (threadId !== null) unread.delete(threadId);
    return unread;
  }, [feed.threads, arrival, opened, threadId]);
  const firstUnread = useMemo(
    () => (feed.posts === null ? null : firstUnreadPostId(feed.posts, arrival)),
    [feed.posts, arrival]
  );
  const openThread = (rootId: string | null) => {
    if (rootId !== null) setOpened((was) => new Set([...was, rootId]));
    onThread(rootId);
  };
  const base = { workspaceId, directory, availableConversationIds, linkedPostId, openDm };
  const channelContext: RowContext = {
    ...base,
    place: {
      kind: 'channel',
      openThread,
      responding: respondingByRoot,
      threads: feed.threads,
      unreadThreads,
    },
  };
  const threadContext: RowContext = { ...base, place: { kind: 'thread' } };
  return (
    <div className="channel-browser-panes" data-thread={threadId ? 'open' : undefined}>
      <section
        className="channel-browser-pane ui-stack"
        aria-label={`${heading.mark}${heading.name}`}
      >
        <header className="channel-browser-pane-header ui-row" data-channel-header>
          <div className="channel-browser-pane-title">
            <h2>
              <span aria-hidden="true">{heading.mark}</span>
              {heading.name}
            </h2>
          </div>
          <ChannelSearch
            workspaceId={workspaceId}
            channelNames={channelNames}
            buddyNames={directory.buddyNames}
          />
          <div className="channel-browser-pane-actions ui-row">
            <ChannelHeaderControls channel={entry.channel} description={heading.about}>
              <TaskFilter
                className="channel-browser-task-filter"
                posts={feed.posts}
                taskFilter={taskFilter}
                tasks={directory.taskById}
                onTaskFilter={onTaskFilter}
              />
            </ChannelHeaderControls>
            <CopyLinkButton
              className="channel-browser-header-action channel-header-copy"
              path={channelLinkPath(workspaceId, { kind: 'channel', channelId })}
              label="Copy link to channel"
            />
          </div>
        </header>
        {taskFilter === null ? (
          <div
            className="channel-browser-scroll ui-stack ui-scroll-quiet"
            data-scrolling={scrollActivity['data-scrolling']}
            ref={follow.scrollRef}
            onScroll={(event) => {
              follow.onScroll(event);
              scrollActivity.onScroll();
            }}
          >
            {(feed.latest.kind === 'failed' || feed.latest.kind === 'stale') && (
              <p className="channel-browser-error" role="alert">
                Posts could not refresh: {feed.latest.error.message}
              </p>
            )}
            {renderFeed(feedPhase(feed.latest.kind, posts), {
              loading: () => <ChannelLoader label={`Loading ${heading.mark}${heading.name}…`} />,
              failed: () => null,
              empty: () => (
                <div className="channel-browser-empty ui-muted ui-row">
                  <strong>
                    {heading.mark}
                    {heading.name}
                  </strong>
                  <span>No posts yet. Say hello, or @mention a Buddy to ask it something.</span>
                </div>
              ),
              posts: () => (
                <>
                  <ChannelHistory
                    edge={feed.edge}
                    scrollRef={follow.scrollRef}
                    onReach={() => void feed.loadOlder(follow.hold)}
                  />
                  <ol className="channel-browser-messages">
                    {renderRows(rows, channelContext, firstUnread)}
                  </ol>
                </>
              ),
            })}
          </div>
        ) : (
          <TaskPage
            key={taskFilter}
            taskId={taskFilter}
            workspaceId={workspaceId}
            channelId={channelId}
            directory={directory}
            submit="enter"
          />
        )}
        {taskFilter === null && isGroupDm(entry.channel.kind) && <GroupDmNotice />}
        {taskFilter === null && !entry.channel.archivedAt && !isGroupDm(entry.channel.kind) && (
          <ChannelComposer
            channelId={channelId}
            rootId={null}
            placeholder={`Message ${heading.mark}${heading.name}`}
            references={directory.references}
            submit="enter"
            onPosted={(result) => {
              follow.pin();
              void feed.latest.refetch();
              // Mentioning a Buddy opens the thread its reply (or why not) will land in.
              if (mentionsABuddy(result.post.body)) openThread(result.post.id);
            }}
          />
        )}
      </section>
      {threadId && (
        <ThreadPane
          key={threadId}
          entry={entry}
          heading={heading}
          rootId={threadId}
          context={threadContext}
          onClose={() => onThread(null)}
        />
      )}
    </div>
  );
}

// A DM inside the channels view, beside the rail, the way Slack opens one. A Buddy DM is drawn as
// a thread (ChannelDm, 493c1c7). The Buddy Builder chat keeps the conversation page: it is the
// hire flow. Chat is mounted only once the client holds the conversation — the click that opened
// it may have created it, and Chat bounces when it cannot find it (AGENTS.md availability rule).
function DmPane({
  conversationId,
  available,
  workspaceId,
  directory,
  onConversation,
}: {
  conversationId: string;
  available: boolean;
  workspaceId: string;
  directory: WorkspaceDirectory;
  onConversation: OpenDm;
}) {
  const buddy = rowBuddy(useAtomValue(rowFamily(conversationId)));
  if (buddy === null)
    return (
      <section className="channel-browser-dm" aria-label="Direct message">
        {available ? <Chat id={conversationId} /> : <ChannelLoader label="Opening DM…" />}
      </section>
    );
  const member = directory.activeMembers.find((entry) => entry.id === buddy.buddyId);
  return (
    <ChannelDm
      conversationId={conversationId}
      buddyId={buddy.buddyId}
      buddyName={member?.name ?? 'Buddy'}
      buddyRole={member?.role ?? 'Direct message'}
      buddyNames={directory.buddyNames}
      tasks={directory.taskById}
      frame="desktop"
      linkPath={channelLinkPath(workspaceId, { kind: 'dm', conversationId })}
      backTo={null}
      onConversation={onConversation}
      composeShell={(composer) => composer}
    />
  );
}

// Workspace switcher: the name at the top left is a button; its menu lists
// every workspace with channels plus the workspace activity page.
function WorkspaceSwitcher({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const workspaces = useBuddyOverview().data ?? [];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !rootRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="channel-browser-switcher" ref={rootRef}>
      <button
        type="button"
        className="channel-browser-workspace ui-row"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <BuddySigil name={workspaceName} className="channel-browser-workspace-emblem" />
        <h1>{workspaceName}</h1>
        <span className="channel-browser-caret" aria-hidden="true">
          ⇅
        </span>
      </button>
      {open && (
        <div className="channel-browser-switcher-menu" role="menu">
          <ul>
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  role="menuitem"
                  to={`/buddies/workspaces/${encodeURIComponent(workspace.id)}/channels`}
                  aria-current={workspace.id === workspaceId ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                >
                  <span className="channel-browser-workspace-mark" aria-hidden="true">
                    {initials(workspace.name).slice(0, 1)}
                  </span>
                  {workspace.name}
                  {workspace.id === workspaceId && (
                    <span className="channel-browser-switcher-check ui-muted" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            role="menuitem"
            className="channel-browser-switcher-activity"
            to={`/buddies/workspaces/${encodeURIComponent(workspaceId)}`}
            onClick={() => setOpen(false)}
          >
            Workspace activity
          </Link>
          <Link
            role="menuitem"
            className="channel-browser-switcher-new"
            to={NEW_WORKSPACE_PATH}
            onClick={() => setOpen(false)}
          >
            + New workspace
          </Link>
        </div>
      )}
    </div>
  );
}

function NewChannelForm({
  workspaceId,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  onCreated(channelId: string): void;
  onCancel(): void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cleanName = name.trim().replace(/^#/, '');
  return (
    <form
      className="channel-browser-new-channel"
      onSubmit={(event) => {
        event.preventDefault();
        if (!cleanName || !purpose.trim()) return;
        setBusy(true);
        setProblem(null);
        void createChannel(workspaceId, cleanName, purpose.trim())
          .then((channel) => onCreated(channel.id))
          .catch((cause: unknown) => setProblem(errorText(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        <span className="channel-browser-hash ui-muted" aria-hidden="true">
          #
        </span>
        <input
          autoFocus
          value={name}
          maxLength={80}
          placeholder="channel-name"
          aria-label="Channel name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        />
      </label>
      <input
        value={purpose}
        maxLength={400}
        placeholder="What is it for?"
        aria-label="Channel purpose"
        onChange={(event) => setPurpose(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
      />
      {problem && (
        <p className="channel-browser-new-channel-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="channel-browser-new-channel-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !cleanName || !purpose.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
}

// The red count is only what waits on the owner: requests in a DM.
function RequestsBadge({ count }: { count: number }) {
  return count === 0 ? null : (
    <span className="channel-browser-badge" aria-label={`${count} requests waiting on you`}>
      {count}
    </span>
  );
}

function RailChannel({
  entry,
  heading,
  requests,
  current,
  onSelect,
}: {
  entry: ChannelUnread;
  heading: ChannelHeading;
  requests: number;
  current: boolean;
  onSelect(): void;
}) {
  return (
    <HighlightRow
      current={current}
      buttonsRight={<ChannelStar channelId={entry.channel.id} name={heading.name} />}
    >
      <button
        type="button"
        data-unread={channelUnreadAttr(entry.unread)}
        aria-current={current ? 'page' : undefined}
        onClick={onSelect}
        title={heading.about}
      >
        <span className="channel-browser-hash ui-muted" aria-hidden="true">
          {heading.mark}
        </span>
        <span className="channel-browser-channel-name ui-truncate">{heading.name}</span>
        <RequestsBadge count={requests} />
      </button>
    </HighlightRow>
  );
}

// The workspace Home (ChannelLanding), with the archived channels the rail does not list below it.
function ChannelHomePane({
  workspaceId,
  directory,
  archived,
  inbox,
  generalChannelId,
}: {
  workspaceId: string;
  directory: WorkspaceDirectory;
  archived: readonly Channel[];
  inbox: Inbox | null;
  generalChannelId: string | null;
}) {
  return (
    <section className="channel-browser-pane ui-stack" aria-label="Home">
      <div className="channel-browser-scroll ui-stack">
        <ChannelLanding
          workspaceId={workspaceId}
          directory={directory}
          inbox={inbox}
          generalChannelId={generalChannelId}
          frame="desktop"
        />
        <ArchivedChannels workspaceId={workspaceId} channels={archived} />
      </div>
    </section>
  );
}

// Full-screen Slack layout. Mounted OUTSIDE the app shell (see App.tsx): the
// channel rail replaces the conversations sidebar instead of nesting beside
// it. Selection lives in the URL (?channel=, ?task=, ?thread=, ?post=, ?dm=, ?view=threads) so
// reload and Back keep the reader where they were, and any of it can be shared
// as a permalink (channel-link.ts). Selecting anything drops `post`: the
// highlight belongs to the link that was opened, not to later navigation.
// `?channel=` names a public channel or a DM channel; `?dm=` is the owner's
// ongoing chat with a Buddy (a conversation, not a channel).
export function ChannelBrowser({
  workspaceId,
  directory,
  availableConversationIds,
}: {
  workspaceId: string;
  directory: WorkspaceDirectory;
  availableConversationIds: ReadonlySet<string>;
}) {
  const inbox = useWorkspaceInbox(workspaceId);
  const archived = useArchivedChannels(workspaceId);
  const rail = useAtomValue(channelRailFamily(workspaceId));
  const buddyRail = useAtomValue(buddyRailFamily(directory.activeMembers));
  useWarmChannelPosts(rail.channels);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const railScroll = useScrollActivity();
  // The Home composer posts to #general; a workspace without one gets no composer.
  const generalChannelId =
    rail.channels.find(
      (entry) => entry.channel.kind.type === 'public' && entry.channel.kind.name === 'general'
    )?.channel.id ?? null;
  const listed = [
    ...rail.channels,
    ...rail.direct,
    ...(archived.data ?? []).map((channel) => ({ channel, unread: 0 })),
  ];
  const selected =
    listed.find((entry) => entry.channel.id === params.get('channel')) ?? rail.channels[0] ?? null;
  const select = (next: { channel: string; thread: string | null; task?: string | null }) =>
    setParams({
      channel: next.channel,
      ...(next.task ? { task: next.task } : {}),
      ...(next.thread ? { thread: next.thread } : {}),
    });
  // The Task filter names each post's channel; DMs by their Buddy, like the rail.
  const channelNames = useMemo(
    () =>
      new Map(
        (inbox.data?.channels ?? []).map((entry) => {
          const heading = channelHeading(entry.channel.kind, directory.buddyNames);
          return [entry.channel.id, `${heading.mark}${heading.name}`] as const;
        })
      ),
    [inbox.data, directory.buddyNames]
  );
  // One URL grammar for both shells (channels-view.ts). An open DM, a Buddy's workers or the
  // Threads view replaces the channel in the main pane; picking a channel closes it.
  const view = channelsView(params.toString());
  const workers = view.kind === 'workers' ? view.buddyId : null;
  const dm = view.kind === 'dm' ? view.conversationId : null;
  const openDm: OpenDm = (conversationId) => setParams({ dm: conversationId });
  const dmConversation = useAtomValue(rowFamily(dm ?? ''));
  const dmBuddyId = rowBuddy(dmConversation)?.buddyId;
  const newBuddy = useNewBuddy(openDm, workspaceId);
  const [teamCreator, setTeamCreator] = useState(false);
  // The newest unfinished Buddy Builder chat, surfaced in the rail as "Creating buddy".
  const creatingBuddy = useAtomValue(listField('builders')).find((entry) => !entry.done);
  const railRow = (entry: ChannelUnread) => (
    <RailChannel
      key={entry.channel.id}
      entry={entry}
      heading={channelHeading(entry.channel.kind, directory.buddyNames)}
      requests={channelRequestCount(inbox.data, entry.channel.id)}
      current={channelKinds.has(view.kind) && selected?.channel.id === entry.channel.id}
      onSelect={() => select({ channel: entry.channel.id, thread: null })}
    />
  );
  return (
    <div className="channel-browser" aria-label="Channels">
      {teamCreator && (
        <WorkspaceTeamDialog workspaceId={workspaceId} onClose={() => setTeamCreator(false)} />
      )}
      <nav className="channel-browser-rail ui-stack">
        <header className="channel-browser-rail-header ui-stack">
          <div className="channel-browser-rail-header-row ui-row">
            <WorkspaceSwitcher workspaceId={workspaceId} workspaceName={directory.workspaceName} />
            <AppSettingsDropdown />
          </div>
        </header>
        <div className="channel-browser-rail-scroll ui-scroll-quiet" {...railScroll}>
          <ul className="channel-browser-channels channel-browser-rail-views">
            <li>
              <button
                type="button"
                aria-current={view.kind === 'home' || view.kind === 'landing' ? 'page' : undefined}
                onClick={() => setParams({ view: 'home' })}
                title="Pinned projects, recent threads and what needs you"
              >
                <span className="channel-browser-hash ui-muted" aria-hidden="true">
                  ⌂
                </span>
                <span className="channel-browser-channel-name ui-truncate">Home</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                data-unread={channelUnreadAttr(inbox.data?.unreadThreads)}
                aria-current={view.kind === 'threads' ? 'page' : undefined}
                onClick={() => setParams({ view: 'threads' })}
                title="Threads you started or replied in"
              >
                <span className="channel-browser-hash ui-muted" aria-hidden="true">
                  ≡
                </span>
                <span className="channel-browser-channel-name ui-truncate">Threads</span>
              </button>
            </li>
          </ul>
          <div className="channel-browser-rail-section-row ui-row">
            <Link
              className="channel-browser-rail-section ui-muted"
              to={channelsHref(workspaceId, { kind: 'home' })}
              aria-current={view.kind === 'home' ? 'page' : undefined}
            >
              Channels
            </Link>
            <button
              type="button"
              className="channel-browser-rail-add ui-muted"
              onClick={() => setCreating(true)}
              title="New channel"
              aria-label="New channel"
            >
              +
            </button>
          </div>
          {creating && (
            <NewChannelForm
              workspaceId={workspaceId}
              onCancel={() => setCreating(false)}
              onCreated={(channelId) => {
                setCreating(false);
                void inbox.refetch();
                select({ channel: channelId, thread: null });
              }}
            />
          )}
          {(inbox.kind === 'failed' || inbox.kind === 'stale') && (
            <p role="alert">Channels could not refresh: {inbox.error.message}</p>
          )}
          {inbox.data && rail.channels.length === 0 ? (
            <p className="channel-browser-rail-empty ui-muted">No channels yet.</p>
          ) : (
            <ul className="channel-browser-channels">{rail.channels.map(railRow)}</ul>
          )}
          <div className="channel-browser-rail-section-row ui-row">
            <h3 className="channel-browser-rail-section ui-muted">Buddies</h3>
            <button
              type="button"
              className="channel-browser-rail-add ui-muted"
              onClick={() =>
                directory.activeMembers.length === 0 ? setTeamCreator(true) : newBuddy.start()
              }
              disabled={newBuddy.state.kind === 'pending'}
              title="New Buddy"
              aria-label="New Buddy"
            >
              +
            </button>
          </div>
          {newBuddy.state.kind === 'failed' && (
            <p className="channel-browser-rail-empty ui-muted" role="alert">
              {newBuddy.state.message}
            </p>
          )}
          {directory.activeMembers.length === 0 && !creatingBuddy ? (
            <p className="channel-browser-rail-empty ui-muted">No Buddies yet.</p>
          ) : (
            <ul className="channel-browser-buddies">
              {creatingBuddy && (
                <CreatingBuddyRailRow
                  conversationId={creatingBuddy.id}
                  openDm={openDm}
                  current={dm === creatingBuddy.id}
                />
              )}
              {buddyRail.map((member) => (
                <BuddyRailRow
                  key={member.id}
                  member={member}
                  workspaceId={workspaceId}
                  openDm={openDm}
                  current={member.id === (workers ?? dmBuddyId)}
                />
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className="channel-browser-rail-connect ui-row ui-muted"
          onClick={() => openSetupAt('connect-mobile')}
          title="Open Buddies on your phone"
        >
          <span aria-hidden="true">▯</span>
          Connect mobile
        </button>
      </nav>
      <main className="channel-browser-main">
        {mainPane(view, {
          home: () => (
            <ChannelHomePane
              workspaceId={workspaceId}
              directory={directory}
              archived={archived.data ?? []}
              inbox={inbox.data}
              generalChannelId={generalChannelId}
            />
          ),
          workers: (buddyId) => (
            <ChannelWorkers
              buddyId={buddyId}
              buddyName={directory.buddyNames[buddyId] ?? 'Buddy'}
              workspaceId={workspaceId}
            />
          ),
          dm: (conversationId) => (
            <DmPane
              key={conversationId}
              conversationId={conversationId}
              available={availableConversationIds.has(conversationId)}
              workspaceId={workspaceId}
              directory={directory}
              onConversation={openDm}
            />
          ),
          threads: () => (
            <ThreadsPane
              key={workspaceId}
              workspaceId={workspaceId}
              directory={directory}
              availableConversationIds={availableConversationIds}
              openDm={openDm}
            />
          ),
          task: (taskId, channelId) => (
            <TaskPage
              key={taskId}
              taskId={taskId}
              channelId={channelId}
              workspaceId={workspaceId}
              directory={directory}
              submit="enter"
            />
          ),
          channel: () =>
            selected ? (
              <ChannelPane
                key={selected.channel.id}
                entry={selected}
                workspaceId={workspaceId}
                directory={directory}
                availableConversationIds={availableConversationIds}
                threadId={params.get('thread')}
                linkedPostId={params.get('post')}
                taskFilter={params.get('task')}
                channelNames={channelNames}
                onThread={(thread) =>
                  select({ channel: selected.channel.id, thread, task: params.get('task') })
                }
                onTaskFilter={(task) =>
                  select({ channel: selected.channel.id, thread: params.get('thread'), task })
                }
                openDm={openDm}
              />
            ) : (
              <div className="channel-browser-empty ui-muted ui-row">
                <strong>{inbox.data ? 'No channels yet' : 'Loading channels…'}</strong>
                {inbox.data && (
                  <button
                    type="button"
                    className="channel-browser-empty-action"
                    onClick={() => setCreating(true)}
                  >
                    Create the first channel
                  </button>
                )}
              </div>
            ),
        })}
      </main>
    </div>
  );
}

// Desktop's main pane per view. A channel, thread or Task filter all render the channel pane
// (desktop shows a thread beside its channel); Home is the scrollable channel directory.
const channelKinds: ReadonlySet<ChannelsView['kind']> = new Set(['channel', 'thread', 'task']);

type MainPanes = {
  home(): ReactNode;
  workers(buddyId: string): ReactNode;
  dm(conversationId: string): ReactNode;
  threads(): ReactNode;
  channel(): ReactNode;
  task(taskId: string, channelId: string): ReactNode;
};

function mainPane(view: ChannelsView, panes: MainPanes): ReactNode {
  switch (view.kind) {
    case 'home':
    case 'landing':
      return panes.home();
    case 'workers':
      return panes.workers(view.buddyId);
    case 'dm':
      return panes.dm(view.conversationId);
    case 'threads':
      return panes.threads();
    case 'task':
      return panes.task(view.taskId, view.channelId);
    case 'channel':
    case 'thread':
      return panes.channel();
  }
}

// The desktop route: the full-screen Slack surface for one workspace.
export function WorkspaceSlack() {
  const { workspaceId = '' } = useParams();
  const availableConversationIds = useAtomValue(listField('idSet'));
  const directory = useWorkspaceDirectory(workspaceId);
  return (
    <ChannelBrowser
      workspaceId={workspaceId}
      directory={directory}
      availableConversationIds={availableConversationIds}
    />
  );
}
