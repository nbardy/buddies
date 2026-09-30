import { useAtomValue } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { setConversationDone } from '../../atoms/actions';
import { listField, rowFamily } from '../../atoms/conversations';
import { AppSettingsDropdown } from '../../components/buddies/AppSettingsDropdown';
import { BuddyBackgroundLink } from '../../components/buddies/BuddyBackgroundLink';
import { BuddySigil } from '../../components/buddies/BuddySigil';
import { ArchivedChannels, useArchivedChannels } from '../../components/buddies/ChannelArchive';
import { ChannelDm } from '../../components/buddies/ChannelDm';
import { ChannelHistory, ChannelLoader } from '../../components/buddies/ChannelLoader';
import { TypingDots } from '../../components/buddies/ChannelMarkdown';
import { ChannelWorkers } from '../../components/buddies/ChannelWorkers';
import { TaskFilter } from '../../components/buddies/TaskFilter';
import { WakeIcon, WakeIndicator } from '../../components/buddies/WakeIndicator';
import { errorText } from '../../components/buddies/api';
import { useBuddyDirectActions, useNewBuddy } from '../../components/buddies/buddy-direct-actions';
import {
  type ChannelHeading,
  type WorkspaceDirectory,
  channelFeed,
  channelHeading,
  channelRequestCount,
  channelRows,
  channelUnreadAttr,
  createChannel,
  feedPhase,
  newestServedId,
  railChannels,
  renderFeed,
  taskPostsFeed,
  useChannelFeed,
  useChannelResponding,
  useFollowBottom,
  useMarkRead,
  useThreadView,
  useWarmChannelPosts,
  useWithOutbox,
  useWorkspaceDirectory,
  useWorkspaceInbox,
} from '../../components/buddies/channel-data';
import { channelLinkPath } from '../../components/buddies/channel-link';
import {
  type ChannelsView,
  channelsHref,
  channelsView,
} from '../../components/buddies/channels-view';
import type { Buddy, Channel, ChannelUnread, Inbox } from '../../components/buddies/types';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { mobileConversationRouteState } from '../../utils/conversation-route-state';
import { rowBuddy } from '../../utils/conversation-row';
import {
  MobileEmptyPanel,
  MobileHeaderAction,
  MobilePage,
  MobileSection,
} from '../components/MobileUI';
import { ChannelComposerMobile, MobileChannelComposeFrame } from './ChannelComposerMobile';
import { type RowContext, Row, ScreenHeader, useChannelsDm } from './ChannelRowsMobile';
import { ChannelLanding } from '../../components/buddies/ChannelLanding';
import { ThreadsScreen } from './ThreadsMobile';
import { buddyWorkspaceActivityAtom, overviewWorkspaces } from './ChannelsIndex';

// Channels on a phone, following Slack's mobile app: one screen at a time.
//   Home    — channels and Buddies, tab bar visible
//   Channel — full-height transcript, composer pinned, no tab bar
//   Thread  — the root, its replies, a reply composer
//   Task    — one Task's posts across every channel (the Task filter)
// Same URL as desktop (/buddies/workspaces/:id/channels?channel=&thread=), so
// a link opens the right place on either device. `channel` names a public
// channel or a DM channel. Desktop hover affordances become visible taps here
// (docs/mobile-ui.md: hover needs a touch counterpart).

export function ChannelsMobile() {
  const { workspaceId = '' } = useParams();
  const location = useLocation();
  const screen = channelsView(location.search);
  const directory = useWorkspaceDirectory(workspaceId);
  const inbox = useWorkspaceInbox(workspaceId);
  const archived = useArchivedChannels(workspaceId);
  const rail = useMemo(() => railChannels(inbox.data), [inbox.data]);
  useWarmChannelPosts(rail.channels);
  return renderScreen(screen, {
    workspaceId,
    directory,
    inbox: inbox.data,
    listed: [
      ...rail.channels,
      ...rail.direct,
      ...(archived.data ?? []).map((channel) => ({ channel, unread: 0 })),
    ],
    archived: archived.data ?? [],
    refetchInbox: inbox.refetch,
  });
}

type ScreenContext = {
  workspaceId: string;
  directory: WorkspaceDirectory;
  inbox: Inbox | null;
  archived: readonly Channel[];
  /** Public channels, then DMs: what Home lists and a channel screen can open. */
  listed: readonly ChannelUnread[];
  refetchInbox(): Promise<void>;
};

function renderScreen(screen: ChannelsView, context: ScreenContext) {
  switch (screen.kind) {
    case 'workers':
      return (
        <ChannelWorkers
          buddyId={screen.buddyId}
          buddyName={context.directory.buddyNames[screen.buddyId] ?? 'Buddy'}
          workspaceId={context.workspaceId}
        />
      );
    case 'home':
      return <ChannelsHome context={context} />;
    case 'landing':
      return <LandingScreen context={context} />;
    case 'threads':
      return (
        <ThreadsScreen
          key={context.workspaceId}
          workspaceId={context.workspaceId}
          directory={context.directory}
        />
      );
    case 'channel':
      return (
        <ChannelScreen key={screen.channelId} channelId={screen.channelId} context={context} />
      );
    case 'thread':
      return (
        <ThreadScreen
          key={screen.rootId}
          channelId={screen.channelId}
          rootId={screen.rootId}
          linkedPostId={screen.linkedPostId}
          context={context}
        />
      );
    case 'task':
      return (
        <TaskScreen
          key={screen.taskId}
          channelId={screen.channelId}
          taskId={screen.taskId}
          context={context}
        />
      );
    case 'dm':
      return (
        <DmScreen
          key={screen.conversationId}
          conversationId={screen.conversationId}
          context={context}
        />
      );
  }
}

// A Buddy DM drawn as a thread. The Buddy Builder chat is the hire flow, so it opens the
// conversation page instead, with Back returning here without `dm`.
function DmScreen({ conversationId, context }: { conversationId: string; context: ScreenContext }) {
  const location = useLocation();
  const navigate = useNavigate();
  const row = useAtomValue(rowFamily(conversationId));
  const buddy = rowBuddy(row);
  const back = new URLSearchParams(location.search);
  back.delete('dm');
  const backSearch = back.size ? `?${back}` : '';
  const builder = row !== null && buddy === null;
  useEffect(() => {
    if (!builder) return;
    navigate(`/chat/${encodeURIComponent(conversationId)}`, {
      replace: true,
      state: mobileConversationRouteState({ ...location, search: backSearch }),
    });
  }, [builder, conversationId, location, backSearch, navigate]);
  if (buddy === null) return <ChannelLoader label="Opening DM…" />;
  const member = context.directory.activeMembers.find((entry) => entry.id === buddy.buddyId);
  const name = member?.name ?? 'Buddy';
  return (
    <ChannelDm
      conversationId={conversationId}
      buddyId={buddy.buddyId}
      buddyName={name}
      buddyRole={member?.role ?? 'Direct message'}
      buddyNames={context.directory.buddyNames}
      tasks={context.directory.taskById}
      frame="mobile"
      linkPath={channelLinkPath(context.workspaceId, { kind: 'dm', conversationId })}
      backTo={`${location.pathname}${backSearch}`}
      onConversation={(next) => {
        back.set('dm', next);
        navigate(`${location.pathname}?${back}`, { replace: true });
      }}
      composeShell={(composer) => (
        <MobileChannelComposeFrame title={name}>{composer}</MobileChannelComposeFrame>
      )}
    />
  );
}

/** The screen's channel as the inbox lists it; a channel the inbox has not listed yet reads as unknown. */
function listedEntry(context: ScreenContext, channelId: string): ChannelUnread | null {
  return context.listed.find((entry) => entry.channel.id === channelId) ?? null;
}

const LOADING_HEADING: ChannelHeading = { mark: '#', name: 'channel', about: '' };

// ── Home ────────────────────────────────────────────────────────────────────

function LandingScreen({ context }: { context: ScreenContext }) {
  const { workspaceId, directory, inbox } = context;
  const general = context.listed.find(
    (entry) => entry.channel.kind.type === 'public' && entry.channel.kind.name === 'general'
  );
  return (
    <MobilePage title="Home" subtitle={directory.workspaceName}>
      <ChannelLanding
        workspaceId={workspaceId}
        directory={directory}
        inbox={inbox}
        generalChannelId={general?.channel.id ?? null}
        frame="mobile"
      />
    </MobilePage>
  );
}

function ChannelsHome({ context }: { context: ScreenContext }) {
  const overview = useBuddyOverview();
  const workspaces = overviewWorkspaces(overview.data, useAtomValue(buddyWorkspaceActivityAtom));
  const [switching, setSwitching] = useState(false);
  const [creating, setCreating] = useState(false);
  const { workspaceId, directory, inbox } = context;
  const rail = railChannels(inbox);
  const row = (entry: ChannelUnread) => {
    const heading = channelHeading(entry.channel.kind, directory.buddyNames);
    const requests = channelRequestCount(inbox, entry.channel.id);
    return (
      <li key={entry.channel.id}>
        <Link
          className="mobile-channels-row ui-row"
          data-unread={channelUnreadAttr(entry.unread)}
          to={channelsHref(workspaceId, { kind: 'channel', channelId: entry.channel.id })}
        >
          <span className="mobile-channels-row__hash" aria-hidden="true">
            {heading.mark}
          </span>
          <span className="mobile-channels-row__name ui-truncate">{heading.name}</span>
          {requests > 0 && (
            <span
              className="mobile-channels-row__badge"
              aria-label={`${requests} requests waiting on you`}
            >
              {requests}
            </span>
          )}
        </Link>
      </li>
    );
  };
  return (
    <MobilePage
      title={directory.workspaceName}
      subtitle="Channels and Buddies"
      headerAside={
        <div className="mobile-channels-header-aside ui-row">
          {workspaces.length > 1 ? (
            <MobileHeaderAction
              aria-expanded={switching}
              onClick={() => setSwitching((value) => !value)}
            >
              Switch
            </MobileHeaderAction>
          ) : null}
          <AppSettingsDropdown />
        </div>
      }
    >
      {switching && (
        <ul className="mobile-channels-list mobile-channels-workspaces">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Link
                className="mobile-channels-row ui-row"
                to={channelsHref(workspace.id, { kind: 'home' })}
                replace
                aria-current={workspace.id === workspaceId ? 'page' : undefined}
                onClick={() => setSwitching(false)}
              >
                <span className="mobile-channels-row__mark" aria-hidden="true">
                  {workspace.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="mobile-channels-row__name ui-truncate">{workspace.name}</span>
                {workspace.id === workspaceId && <span aria-hidden="true">✓</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <ul className="mobile-channels-list">
        <li>
          <Link
            className="mobile-channels-row ui-row"
            to={channelsHref(workspaceId, { kind: 'landing' })}
          >
            <span className="mobile-channels-row__hash" aria-hidden="true">
              ⌂
            </span>
            <span className="mobile-channels-row__name ui-truncate">Home</span>
          </Link>
        </li>
        <li>
          <Link
            className="mobile-channels-row ui-row"
            data-unread={channelUnreadAttr(inbox?.unreadThreads)}
            to={channelsHref(workspaceId, { kind: 'threads' })}
          >
            <span className="mobile-channels-row__hash" aria-hidden="true">
              ≡
            </span>
            <span className="mobile-channels-row__name ui-truncate">Threads</span>
          </Link>
        </li>
      </ul>
      <MobileSection title="Channels">
        <ul className="mobile-channels-list">
          {rail.channels.map(row)}
          <li>
            {creating ? (
              <NewChannelForm
                workspaceId={workspaceId}
                onCancel={() => setCreating(false)}
                onCreated={() => {
                  setCreating(false);
                  void context.refetchInbox();
                }}
              />
            ) : (
              <button
                type="button"
                className="mobile-channels-row ui-row mobile-channels-row--add"
                onClick={() => setCreating(true)}
              >
                <span className="mobile-channels-row__hash" aria-hidden="true">
                  +
                </span>
                <span className="mobile-channels-row__name ui-truncate">Add channel</span>
              </button>
            )}
          </li>
        </ul>
        {inbox === null && <MobileEmptyPanel>Loading channels…</MobileEmptyPanel>}
      </MobileSection>
      <ArchivedChannels workspaceId={workspaceId} channels={context.archived} />
      <MobileSection title="Buddies" meta="Tap to message · ☀ to wake">
        <BuddySection members={directory.activeMembers} workspaceId={workspaceId} />
      </MobileSection>
    </MobilePage>
  );
}

// The rail's '+' and "Creating buddy" row (desktop e9e3426), as touch rows: New Buddy starts a
// Buddy Builder chat, which DmScreen hands to the conversation page; × archives that setup chat.
function BuddySection({
  members,
  workspaceId,
}: {
  members: readonly Buddy[];
  workspaceId: string;
}) {
  const openDm = useChannelsDm();
  const newBuddy = useNewBuddy(openDm, workspaceId);
  const creating = useAtomValue(listField('builders')).find((entry) => !entry.done);
  return (
    <ul className="mobile-channels-list">
      <li>
        <button
          type="button"
          className="mobile-channels-row ui-row mobile-channels-row--add"
          disabled={newBuddy.state.kind === 'pending'}
          onClick={newBuddy.start}
        >
          <span className="mobile-channels-row__hash" aria-hidden="true">
            +
          </span>
          <span className="mobile-channels-row__name ui-truncate">New Buddy</span>
        </button>
        {newBuddy.state.kind === 'failed' && (
          <p className="mobile-channels-new__problem" role="alert">
            {newBuddy.state.message}
          </p>
        )}
      </li>
      {creating && (
        <li className="mobile-channels-buddy ui-row">
          <button
            type="button"
            className="mobile-channels-row ui-row"
            onClick={() => openDm(creating.id)}
          >
            <BuddySigil className="mobile-channels-row__sigil" name="Creating buddy" />
            <em className="mobile-channels-row__name ui-truncate">Creating buddy</em>
          </button>
          <button
            type="button"
            className="mobile-channels-wake ui-muted"
            aria-label="Archive Buddy setup"
            onClick={() => setConversationDone(creating.id, true)}
          >
            ×
          </button>
        </li>
      )}
      {members.map((member) => (
        <BuddyRow key={member.id} member={member} />
      ))}
    </ul>
  );
}

// Slack's DM row: tapping the Buddy opens the conversation (its one ongoing
// DM, history kept). Wake is a visible button, since touch has no hover.
function BuddyRow({ member }: { member: Buddy }) {
  // The DM opens inside Channels; Back returns here, not to the Buddies tab.
  const openDm = useChannelsDm();
  const location = useLocation();
  const direct = useBuddyDirectActions(member.id);
  const { action } = direct;
  return (
    <li
      className="mobile-channels-buddy ui-row"
      data-worker-row="mobile"
      data-failed={action.kind === 'failed' || undefined}
    >
      <button
        type="button"
        className="mobile-channels-row ui-row"
        disabled={action.kind === 'pending'}
        onClick={() => direct.openDm(openDm)}
      >
        <BuddySigil className="mobile-channels-row__sigil" name={member.name} />
        <span className="mobile-channels-row__stack ui-stack">
          <span className="mobile-channels-row__name ui-truncate">{member.name}</span>
          <span className="mobile-channels-row__detail ui-truncate ui-muted">
            {action.kind === 'failed' ? action.message : member.role}
          </span>
        </span>
      </button>
      <BuddyBackgroundLink
        buddyId={member.id}
        workspaceId={member.workspaceId}
        name={member.name}
      />
      {direct.woken && (
        <WakeIndicator
          key={direct.woken.attempt}
          conversationId={direct.woken.conversationId}
          name={member.name}
          className="mobile-channels-wake-status ui-inline-row ui-muted"
          doneClassName="mobile-channels-wake-done"
          linkState={mobileConversationRouteState(location)}
        />
      )}
      <button
        type="button"
        className="mobile-channels-wake ui-muted"
        aria-label={`Wake ${member.name}: catch up on the channels and act`}
        disabled={action.kind === 'pending'}
        onClick={direct.wake}
      >
        <WakeIcon />
      </button>
    </li>
  );
}

function NewChannelForm({
  workspaceId,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  onCreated(): void;
  onCancel(): void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cleanName = name.trim().replace(/^#/, '');
  return (
    <form
      className="mobile-channels-new"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setProblem(null);
        void createChannel(workspaceId, cleanName, purpose.trim())
          .then(onCreated)
          .catch((cause: unknown) => setProblem(errorText(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <input
        value={name}
        maxLength={80}
        placeholder="# channel-name"
        aria-label="Channel name"
        onChange={(event) => setName(event.target.value)}
      />
      <input
        value={purpose}
        maxLength={400}
        placeholder="What is it for?"
        aria-label="Channel purpose"
        onChange={(event) => setPurpose(event.target.value)}
      />
      {problem && (
        <p className="mobile-channels-new__problem" role="alert">
          {problem}
        </p>
      )}
      <div className="mobile-channels-new__actions">
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

// ── Channel ─────────────────────────────────────────────────────────────────

function ChannelScreen({ channelId, context }: { channelId: string; context: ScreenContext }) {
  const { workspaceId, directory } = context;
  const entry = listedEntry(context, channelId);
  const heading = entry
    ? channelHeading(entry.channel.kind, directory.buddyNames)
    : LOADING_HEADING;
  const feed = useChannelFeed(channelFeed(channelId));
  const responding = useChannelResponding(channelId, directory.buddyNames);
  const posts = useWithOutbox(channelId, null, feed.posts);
  const rows = useMemo(() => channelRows(posts ?? []), [posts]);
  const follow = useFollowBottom(rows.length, posts, null);
  useMarkRead(
    { kind: 'channel', channelId },
    entry !== null && entry.unread > 0,
    newestServedId(feed.posts)
  );
  const rowContext: RowContext = {
    directory,
    place: {
      kind: 'channel',
      threadHref: (rootId) =>
        channelsHref(workspaceId, { kind: 'thread', channelId, rootId, linkedPostId: null }),
      responding,
    },
    linkedPostId: null,
  };
  const title = `${heading.mark} ${heading.name}`;
  const navigate = useNavigate();
  return (
    <div className="mobile-channel ui-stack">
      <ScreenHeader
        backTo={channelsHref(workspaceId, { kind: 'home' })}
        title={title}
        channel={entry?.channel}
        subtitle={heading.about}
        settings={
          <TaskFilter
            className="mobile-channel__task-filter"
            posts={feed.posts}
            taskFilter={null}
            tasks={directory.taskById}
            onTaskFilter={(taskId) =>
              taskId !== null &&
              navigate(channelsHref(workspaceId, { kind: 'task', channelId, taskId }))
            }
          />
        }
        link={{
          path: channelLinkPath(workspaceId, { kind: 'channel', channelId }),
          label: 'Copy link to channel',
        }}
      />
      <div className="mobile-channel__scroll" ref={follow.scrollRef} onScroll={follow.onScroll}>
        {(feed.latest.kind === 'failed' || feed.latest.kind === 'stale') && (
          <p className="mobile-channel__error" role="alert">
            Posts could not refresh: {feed.latest.error.message}
          </p>
        )}
        {renderFeed(feedPhase(feed.latest.kind, posts), {
          loading: () => <ChannelLoader label={`Loading ${title}…`} />,
          failed: () => null,
          empty: () => (
            <MobileEmptyPanel>No posts yet. @mention a Buddy to ask it something.</MobileEmptyPanel>
          ),
          posts: () => (
            <>
              <ChannelHistory
                edge={feed.edge}
                scrollRef={follow.scrollRef}
                onReach={() => void feed.loadOlder(follow.hold)}
              />
              <ol className="mobile-channel__posts">
                {rows.map((row) => (
                  <Row key={row.key} row={row} context={rowContext} />
                ))}
              </ol>
            </>
          ),
        })}
      </div>
      {!entry?.channel.archivedAt && (
        <ChannelComposerMobile
          title={title}
          channelId={channelId}
          rootId={null}
          placeholder={`Message ${heading.mark}${heading.name}`}
          references={directory.references}
          submit="button"
          onPosted={() => {
            follow.pin();
            void feed.latest.refetch();
          }}
        />
      )}
    </div>
  );
}

// ── Task ────────────────────────────────────────────────────────────────────

// The Task filter: one Task's posts from every channel, newest page first and
// paged back like a channel; each row links to the post in its own channel.
function TaskScreen({
  channelId,
  taskId,
  context,
}: {
  channelId: string;
  taskId: string;
  context: ScreenContext;
}) {
  const { workspaceId, directory } = context;
  const feed = useChannelFeed(taskPostsFeed(taskId));
  const rows = useMemo(() => channelRows(feed.posts ?? []), [feed.posts]);
  const follow = useFollowBottom(rows.length, feed.posts, null);
  const channelNames = useMemo(
    () =>
      new Map(
        context.listed.map((entry) => {
          const heading = channelHeading(entry.channel.kind, directory.buddyNames);
          return [entry.channel.id, `${heading.mark}${heading.name}`] as const;
        })
      ),
    [context.listed, directory.buddyNames]
  );
  const rowContext: RowContext = {
    directory,
    place: { kind: 'task', workspaceId, channelNames },
    linkedPostId: null,
  };
  return (
    <div className="mobile-channel ui-stack">
      <ScreenHeader
        backTo={channelsHref(workspaceId, { kind: 'channel', channelId })}
        title={`Task: ${directory.taskById.get(taskId)?.title ?? taskId}`}
        subtitle="One Task, across every channel"
        link={{
          path: channelsHref(workspaceId, { kind: 'task', channelId, taskId }),
          label: 'Copy link to Task filter',
        }}
      />
      <div className="mobile-channel__scroll" ref={follow.scrollRef} onScroll={follow.onScroll}>
        {(feed.latest.kind === 'failed' || feed.latest.kind === 'stale') && (
          <p className="mobile-channel__error" role="alert">
            Task posts could not refresh: {feed.latest.error.message}
          </p>
        )}
        {renderFeed(feedPhase(feed.latest.kind, feed.posts), {
          loading: () => <ChannelLoader label="Loading the Task's posts…" />,
          failed: () => null,
          empty: () => <MobileEmptyPanel>No posts about this Task yet.</MobileEmptyPanel>,
          posts: () => (
            <>
              <ChannelHistory
                edge={feed.edge}
                scrollRef={follow.scrollRef}
                onReach={() => void feed.loadOlder(follow.hold)}
              />
              <ol className="mobile-channel__posts">
                {rows.map((row) => (
                  <Row key={row.key} row={row} context={rowContext} />
                ))}
              </ol>
            </>
          ),
        })}
      </div>
    </div>
  );
}

// ── Thread ──────────────────────────────────────────────────────────────────

function ThreadScreen({
  channelId,
  rootId,
  linkedPostId,
  context,
}: {
  channelId: string;
  rootId: string;
  linkedPostId: string | null;
  context: ScreenContext;
}) {
  const { workspaceId, directory } = context;
  const entry = listedEntry(context, channelId);
  const heading = entry
    ? channelHeading(entry.channel.kind, directory.buddyNames)
    : LOADING_HEADING;
  const { thread, root, replying, replyRows, follow, onPosted } = useThreadView(
    channelId,
    rootId,
    linkedPostId,
    directory.buddyNames
  );
  const rowContext: RowContext = { directory, place: { kind: 'thread' }, linkedPostId };
  return (
    <div className="mobile-channel ui-stack">
      <ScreenHeader
        backTo={channelsHref(workspaceId, { kind: 'channel', channelId })}
        title="Thread"
        subtitle={`${heading.mark} ${heading.name}`}
        link={{
          path: channelLinkPath(workspaceId, { kind: 'thread', channelId, rootId }),
          label: 'Copy link to thread',
        }}
      />
      <div className="mobile-channel__scroll" ref={follow.scrollRef} onScroll={follow.onScroll}>
        {(thread.latest.kind === 'failed' || thread.latest.kind === 'stale') && (
          <p className="mobile-channel__error" role="alert">
            Thread could not refresh: {thread.latest.error.message}
          </p>
        )}
        {thread.latest.kind === 'loading' && <ChannelLoader label="Loading thread…" />}
        {root && (
          <ol className="mobile-channel__posts">
            <Row row={{ kind: 'lead', key: root.id, post: root }} context={rowContext} />
          </ol>
        )}
        {root && <div className="mobile-channel-divider ui-row ui-muted">Replies</div>}
        {root && (
          <ChannelHistory
            edge={thread.edge}
            scrollRef={follow.scrollRef}
            onReach={() => void thread.loadOlder(follow.hold)}
          />
        )}
        <ol className="mobile-channel__posts">
          {replyRows.map((row) => (
            <Row key={row.key} row={row} context={rowContext} />
          ))}
        </ol>
        {replying !== undefined && (
          <p className="mobile-channel__replying">
            <TypingDots /> {replying}
          </p>
        )}
      </div>
      {!entry?.channel.archivedAt && (
        <ChannelComposerMobile
          title={`Thread in ${heading.mark} ${heading.name}`}
          channelId={channelId}
          rootId={rootId}
          placeholder="Reply…"
          references={directory.references}
          seats={thread.latest.data?.seats}
          submit="button"
          onPosted={onPosted}
        />
      )}
    </div>
  );
}
