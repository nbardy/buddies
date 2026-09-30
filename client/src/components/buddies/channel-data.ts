/**
 * client/src/components/buddies/channel-data.ts
 *
 * Channel data shared by the desktop channel browser and the mobile channel
 * screens: resource URLs, transcript rows, the workspace directory (members,
 * Tasks, @ references), who is replying and the owner's unread state. No JSX,
 * no CSS — mobile may import it (gate G3 allows components/buddies/).
 *
 * Server: server/src/buddies/routes.ts. Everything is a post in a channel;
 * a channel is public (#name), direct (DM between members) or a task's.
 */
import {
  type BuddyMemberExecution,
  type ConversationConfig,
  ConversationConfigSchema,
  type MessageBody,
  legacyBody,
} from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type OutboxEntry, channelOutboxAtom, outboxDrop } from '../../atoms/channel-outbox';
import { warmResources } from '../../atoms/prefetch';
import { invalidateBuddyResources, seedResource } from '../../atoms/resources';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { type PolledState, resource, usePolledFetch } from '../../hooks/usePolledFetch';
import { buddyApi, buddyWrite } from './api';
import { type ChannelReference, type ChannelTask, channelTasks } from './channel-text';
import { activeBuddies, buddyNamesOf, findWorkspace } from './roster';
import type {
  Actor,
  Buddy,
  BuddyOverview,
  Channel,
  ChannelKind,
  ChannelPage,
  ChannelResponse,
  ChannelUnread,
  Cursor,
  Inbox,
  Post,
  PostPage,
  Task,
  ThreadPage,
  ThreadStat,
} from './types';
import { taskStatusView } from './ui-contract';

/** Legacy generated replies carried markers; owner posts remain literal prose. */
export function channelPostBody(post: Post): MessageBody {
  return post.author.kind === 'buddy' && post.conversationId
    ? legacyBody(post.body)
    : { t: 'text', text: post.body };
}

export function authorKey(author: Actor): string {
  switch (author.kind) {
    case 'owner':
      return 'owner';
    case 'buddy':
      return author.id;
  }
}

/** The name a post's author shows as: the owner is "You", a Buddy its name. */
export function authorName(author: Actor, buddyNames: Readonly<Record<string, string>>): string {
  switch (author.kind) {
    case 'owner':
      return 'You';
    case 'buddy':
      return buddyNames[author.id] ?? author.id;
  }
}

// Channels are pushed, not polled: the server's `channel_changed` (a post, a
// read mark, or who is replying) and `buddies_changed` (any other write)
// refresh exactly the views they touch (atoms/resources.ts), and a reconnect
// or a tab returning to view refreshes everything. This poll is only a
// backstop for a lost push.
export const CHANNEL_BACKSTOP_MS = 30_000;

/** Posts per page read; the newest page is what every channel warms. */
export const CHANNEL_PAGE = 50;

// ── The rail ────────────────────────────────────────────────────────────────

/** GET: the owner's requests, its channels in the workspace, unread per channel. */
export function inboxUrl(workspaceId: string): string {
  return `/api/buddies/workspaces/${encodeURIComponent(workspaceId)}/inbox`;
}

export function useWorkspaceInbox(workspaceId: string) {
  return usePolledFetch<Inbox>(inboxUrl(workspaceId), CHANNEL_BACKSTOP_MS);
}

/** Route-addressable channels: public channels and direct channels. Task channels live on their task. */
export type RailChannels = { channels: ChannelUnread[]; direct: ChannelUnread[] };

const NO_RAIL: RailChannels = { channels: [], direct: [] };

export function railChannels(inbox: Inbox | null): RailChannels {
  if (inbox === null) return NO_RAIL;
  const rail: RailChannels = { channels: [], direct: [] };
  for (const entry of inbox.channels) {
    switch (entry.channel.kind.type) {
      case 'public':
        rail.channels.push(entry);
        break;
      case 'direct':
        rail.direct.push(entry);
        break;
      case 'task':
        break;
    }
  }
  return rail;
}

/** A channel's heading: `#name` and its purpose, a DM's other members, a task's channel. */
export type ChannelHeading = { mark: '#' | '@' | '◇'; name: string; about: string };

export function channelHeading(
  kind: ChannelKind,
  buddyNames: Readonly<Record<string, string>>
): ChannelHeading {
  switch (kind.type) {
    case 'public':
      return { mark: '#', name: kind.name, about: kind.purpose };
    case 'direct':
      return {
        mark: '@',
        name: kind.members
          .filter((member) => member.kind === 'buddy')
          .map((member) => authorName(member, buddyNames))
          .join(', '),
        about: 'Direct messages',
      };
    case 'task':
      return { mark: '◇', name: 'Task discussion', about: kind.taskId };
  }
}

/** Warm every rail channel's newest page at idle, so a first switch renders from cache. */
export function useWarmChannelPosts(entries: readonly ChannelUnread[]): void {
  const ids = entries.map((entry) => entry.channel.id).join('\n');
  useEffect(() => {
    if (ids) warmResources(ids.split('\n').map((id) => latestResource(channelFeed(id))));
  }, [ids]);
}

/** Create a public channel as the owner; resolves to the new channel. */
export function createChannel(workspaceId: string, name: string, purpose: string) {
  return buddyWrite<Channel>(
    `/api/buddies/workspaces/${encodeURIComponent(workspaceId)}/channels`,
    'POST',
    { name, purpose }
  );
}

// ── Feeds ───────────────────────────────────────────────────────────────────

/**
 * A feed the owner reads, newest first, keyset-paged: D = Channel ⊕ Thread.
 * A channel's answer is its top-level posts; a thread's is its root beside
 * the replies. `base` is the URL up to the query (ending in `?`); every
 * per-channel key starts with it, which is what invalidation matches.
 */
type FeedPage = { posts: readonly Post[]; next?: Cursor; threads: readonly ThreadStat[] };
export type PostFeed<V> = { base: string; opens: FeedOpening; page(value: V): FeedPage };

// Where a feed's live page starts: D = Newest ⊕ From(a linked post). A reply permalink opens its
// thread FROM the reply (the reply and everything newer), so a reply older than the newest page
// still renders and is scrolled to; the T11 migration opened on the newest page only (T22).
export type FeedOpening = { kind: 'newest' } | { kind: 'from'; postId: string };
const NEWEST: FeedOpening = { kind: 'newest' };
const NO_STATS: readonly ThreadStat[] = [];

export function channelFeed(channelId: string): PostFeed<ChannelPage> {
  return {
    base: `/api/buddies/channels/${encodeURIComponent(channelId)}/posts?`,
    opens: NEWEST,
    page: (value) => value,
  };
}

export function threadFeed(rootId: string, linkedPostId: string | null): PostFeed<ThreadPage> {
  return {
    base: `/api/buddies/posts/${encodeURIComponent(rootId)}/thread?`,
    opens: linkedPostId === null ? NEWEST : { kind: 'from', postId: linkedPostId },
    page: (value) => ({ ...value, threads: NO_STATS }),
  };
}

/** One Task's posts across every channel: the channel browser's Task filter (T22). */
export function taskPostsFeed(taskId: string): PostFeed<PostPage> {
  return {
    base: `/api/buddies/tasks/${encodeURIComponent(taskId)}/posts?`,
    opens: NEWEST,
    page: (value) => ({ ...value, threads: NO_STATS }),
  };
}

// Pages go back by the post's ordered id (a UUIDv7 the server issues in write order).
const cursorQuery = (cursor: Cursor) => `before=${encodeURIComponent(cursor.ord)}`;

function openingQuery(opening: FeedOpening): string {
  switch (opening.kind) {
    case 'newest':
      return '';
    case 'from':
      return `&from=${encodeURIComponent(opening.postId)}`;
  }
}

function latestResource<V>(feed: PostFeed<V>) {
  const url = `${feed.base}limit=${CHANNEL_PAGE}${openingQuery(feed.opens)}`;
  return resource(url, (signal) => buddyApi<V>(url, { signal }));
}

// History the reader paged back into: `pages` pages before `start`, the
// cursor the newest page ended on when paging began. Keyed by its start, so
// new posts landing on the newest page never move it.
type History = { start: Cursor; pages: number };

function historyResource<V>(feed: PostFeed<V>, history: History) {
  const url = `${feed.base}limit=${CHANNEL_PAGE}&${cursorQuery(history.start)}`;
  return resource(`${url}&pages=${history.pages}`, async (signal): Promise<FeedPage> => {
    const posts: Post[] = [];
    const threads: ThreadStat[] = [];
    let cursor: Cursor | undefined = history.start;
    for (let page = 0; page < history.pages && cursor; page += 1) {
      const next: FeedPage = feed.page(
        await buddyApi<V>(`${feed.base}limit=${CHANNEL_PAGE}&${cursorQuery(cursor)}`, { signal })
      );
      posts.push(...next.posts);
      threads.push(...next.threads);
      cursor = next.next;
    }
    return { posts, next: cursor, threads };
  });
}

// The top of a feed: D = More ⊕ Loading ⊕ Failed ⊕ Complete.
export type OlderEdge =
  | { kind: 'more' }
  | { kind: 'loading' }
  | { kind: 'failed'; error: Error }
  | { kind: 'complete' };

type OlderRequest = { kind: 'idle' } | { kind: 'loading' } | { kind: 'failed'; error: Error };
type Paging = { base: string; history: History | null; request: OlderRequest };

const IDLE: OlderRequest = { kind: 'idle' };

function edgeOf(request: OlderRequest, next: Cursor | undefined | null): OlderEdge {
  switch (request.kind) {
    case 'loading':
    case 'failed':
      return request;
    case 'idle':
      if (next === null) return { kind: 'loading' };
      return next === undefined ? { kind: 'complete' } : { kind: 'more' };
  }
}

/**
 * One feed's posts, newest-first, with history on demand. `loadOlder` reads
 * the page before the oldest post held and seeds the grown history key with
 * everything it already holds, so the switch renders at once. `beforePrepend`
 * runs just before the older rows render above the reader (useFollowBottom's
 * `hold`).
 *
 * The newest page keeps polling while history is open; history is fixed at
 * where paging began. Only if more than a page of new posts lands while the
 * reader is paged back does a gap open between the two (left for T14: the API
 * has no "posts after" query to close it).
 */
export function useChannelFeed<V>(feed: PostFeed<V>) {
  // Paging belongs to one feed AND where it opened: a new permalink starts over.
  const identity = `${feed.base}${openingQuery(feed.opens)}`;
  const [held, setHeld] = useState<Paging>({ base: identity, history: null, request: IDLE });
  const paging: Paging =
    held.base === identity ? held : { base: identity, history: null, request: IDLE };
  const latest = usePolledFetch(latestResource(feed), CHANNEL_BACKSTOP_MS);
  const history = usePolledFetch(
    paging.history === null ? null : historyResource(feed, paging.history),
    0
  );
  const newest = latest.data === null ? null : feed.page(latest.data);
  const posts = useMemo(() => {
    if (newest === null) return null;
    if (history.data === null) return newest.posts;
    const seen = new Set(newest.posts.map((post) => post.id));
    return [...newest.posts, ...history.data.posts.filter((post) => !seen.has(post.id))];
  }, [newest, history.data]);
  // The newest page's stats win: they are refreshed with every poll.
  const threads = useMemo(
    () =>
      new Map(
        [...(history.data?.threads ?? NO_STATS), ...(newest?.threads ?? NO_STATS)].map(
          (stat) => [stat.rootId, stat] as const
        )
      ),
    [newest, history.data]
  );
  // `null`: the page that decides the edge has not loaded yet.
  const next =
    paging.history === null
      ? newest === null
        ? null
        : newest.next
      : history.data === null
        ? null
        : history.data.next;
  const edge = edgeOf(paging.request, next);
  const loadOlder = async (beforePrepend: () => void) => {
    if (edge.kind !== 'more' || !next) return;
    setHeld({ ...paging, request: { kind: 'loading' } });
    try {
      const page = feed.page(
        await buddyApi<V>(`${feed.base}limit=${CHANNEL_PAGE}&${cursorQuery(next)}`)
      );
      const grown: History =
        paging.history === null
          ? { start: next, pages: 1 }
          : { start: paging.history.start, pages: paging.history.pages + 1 };
      if (page.posts.length > 0) beforePrepend();
      seedResource(historyResource(feed, grown), {
        posts: [...(history.data?.posts ?? []), ...page.posts],
        next: page.next,
        threads: [...(history.data?.threads ?? NO_STATS), ...page.threads],
      });
      setHeld({ base: identity, history: grown, request: IDLE });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setHeld({ ...paging, request: { kind: 'failed', error } });
    }
  };
  return { latest, posts, threads, edge, loadOlder };
}

/** The newest post a feed has served (never an outbox stand-in): what "read" marks through. */
export function newestServedId(posts: readonly Post[] | null): string | null {
  return posts?.[0]?.id ?? null;
}

// ── Transcript rows ─────────────────────────────────────────────────────────

// D = Day ⊕ Lead ⊕ Continuation. A Lead opens a sender run (avatar + name); a
// Continuation is a later post by the same instance (author AND the
// conversation it was written from) within GROUP_WINDOW_MS, so two concurrent
// conversations running as one Buddy never merge into one run.
export type ChannelRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'lead'; key: string; post: Post }
  | { kind: 'continuation'; key: string; post: Post };

const GROUP_WINDOW_MS = 5 * 60_000;

function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

function sameInstance(a: Post, b: Post): boolean {
  return authorKey(a.author) === authorKey(b.author) && a.conversationId === b.conversationId;
}

/**
 * `posts` (one channel's top-level posts, or one thread's replies) plus the
 * owner's posts the server has not returned yet (atoms/channel-outbox.ts), so
 * Send shows the message at once. Entries a refetch now includes leave the
 * outbox. `null` stays `null`: nothing loaded yet is not the same as no posts.
 */
export function useWithOutbox(
  channelId: string,
  rootId: string | null,
  posts: readonly Post[] | null
): readonly Post[] | null {
  const outbox = useAtomValue(channelOutboxAtom);
  const served = useMemo(() => new Set(posts?.map((post) => post.id)), [posts]);
  const pending = useMemo(
    () =>
      outbox.flatMap((entry): Post[] => {
        const post = outboxPost(entry);
        return post.channelId === channelId &&
          (post.rootId ?? null) === rootId &&
          !served.has(post.id)
          ? [post]
          : [];
      }),
    [outbox, channelId, rootId, served]
  );
  const confirmed = useMemo(
    () =>
      outbox.flatMap((entry) =>
        entry.kind === 'sent' && served.has(entry.post.id) ? [entry.key] : []
      ),
    [outbox, served]
  );
  useEffect(() => {
    if (confirmed.length > 0) outboxDrop(new Set(confirmed));
  }, [confirmed]);
  return useMemo(() => (posts === null ? null : [...pending, ...posts]), [pending, posts]);
}

function outboxPost(entry: OutboxEntry): Post {
  switch (entry.kind) {
    case 'sent':
      return entry.post;
    case 'sending':
      return {
        id: `outbox:${entry.key}`,
        channelId: entry.channelId,
        author: { kind: 'owner' },
        ...(entry.rootId === null ? {} : { rootId: entry.rootId, replyToId: entry.rootId }),
        body: entry.body,
        evidence: [],
        request: { state: 'none' },
        broadcast: false,
        createdAt: entry.createdAt,
        // After every served post (hex UUIDs sort below 'z'), in the order they were sent.
        ord: `z-outbox-${entry.createdAt}-${entry.key}`,
      };
  }
}

// Posts arrive newest-first; a Slack transcript reads oldest-first with the
// newest message at the bottom, next to the composer.
export function channelRows(newestFirst: readonly Post[]): ChannelRow[] {
  // By the ordered id (write order), never by createdAt: posts written in one millisecond tie on
  // it and came back shuffled (2026-09-25). Plain string order is the id's order.
  const posts = [...newestFirst].sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0));
  const rows: ChannelRow[] = [];
  let previous: Post | null = null;
  for (const post of posts) {
    const newDay = previous === null || dayKey(previous.createdAt) !== dayKey(post.createdAt);
    if (newDay) {
      rows.push({
        kind: 'day',
        key: `day:${dayKey(post.createdAt)}`,
        label: new Date(post.createdAt).toLocaleDateString([], {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        }),
      });
    }
    const continues =
      previous !== null &&
      !newDay &&
      sameInstance(previous, post) &&
      new Date(post.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_WINDOW_MS;
    rows.push({ kind: continues ? 'continuation' : 'lead', key: post.id, post });
    previous = post;
  }
  return rows;
}

// What a feed pane shows: D = Loading ⊕ Failed ⊕ Empty ⊕ Posts.
// `rows.length === 0` alone conflated "never loaded" with "loaded, no posts",
// so every cold channel said "No posts yet" and then flashed its posts in.
export type FeedPhase = 'loading' | 'failed' | 'empty' | 'posts';

export function feedPhase(
  kind: PolledState<unknown>['kind'],
  posts: readonly unknown[] | null
): FeedPhase {
  if (posts === null) return kind === 'failed' ? 'failed' : 'loading';
  return posts.length === 0 ? 'empty' : 'posts';
}

/** Thin dispatcher: one handler per phase, exhaustive by the Record type. */
export function renderFeed<R>(phase: FeedPhase, handlers: Record<FeedPhase, () => R>): R {
  return handlers[phase]();
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function joinNames(names: readonly string[]): string {
  return names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// A post without a purpose is plain conversation, and so is a Buddy's channel
// reply; every other purpose (standup, handoff, reply_failed…) is a label.
// Kept here so the mobile tree never reads a raw `.purpose` (gate G2 guards
// Conversation.purpose there).
export function postPurposeTag(post: Post): string | undefined {
  return post.purpose;
}

export function postPurposeLabel(post: Post): string | null {
  return post.purpose === undefined || post.purpose === 'reply'
    ? null
    : post.purpose.replaceAll('_', ' ');
}

// ── The workspace directory ─────────────────────────────────────────────────

/**
 * What a mentioned Buddy's reply runs on when nobody picks: its profile, the
 * way the server builds a seat (server/src/buddies/channels.ts profileConfig,
 * whose missing-provider default is codex). A provider the client's schema
 * does not know is `unreported` — the picker cannot open at it honestly.
 */
function profileExecution(buddy: Buddy): BuddyMemberExecution {
  const candidate: unknown = {
    provider: buddy.provider ?? 'codex',
    model: buddy.model ? { mode: 'explicit', modelId: buddy.model } : { mode: 'default' },
    reasoning: buddy.reasoningEffort
      ? { mode: 'explicit', effort: buddy.reasoningEffort }
      : { mode: 'default' },
  };
  const parsed = ConversationConfigSchema.safeParse(candidate);
  return parsed.success
    ? { kind: 'profile', config: parsed.data satisfies ConversationConfig }
    : { kind: 'unreported' };
}

// The universal @ menu: active Buddies and every live top-level Task (todos
// are child tasks and stay out); the fuzzy ranker orders them together.
function channelReferences(
  members: readonly Buddy[],
  tasks: readonly ChannelTask[]
): ChannelReference[] {
  return [
    ...members.map(
      (member): ChannelReference => ({
        kind: 'buddy',
        id: member.id,
        label: member.name,
        detail: member.role,
        execution: profileExecution(member),
      })
    ),
    ...tasks
      .filter((task) => task.topLevel && task.status !== 'cancelled')
      .map(
        (task): ChannelReference => ({
          kind: 'task',
          id: task.id,
          label: task.title,
          status: task.status,
          detail: `${taskStatusView(task.status).label} · ${task.ownerName}`,
        })
      ),
  ];
}

export type WorkspaceDirectory = {
  workspaceName: string;
  /** Active Buddies of the workspace: the rail and the @ menu. */
  activeMembers: readonly Buddy[];
  /** Every Buddy's name, archived and other workspaces' included: they author posts. */
  buddyNames: Readonly<Record<string, string>>;
  taskById: ReadonlyMap<string, ChannelTask>;
  /** Every Task of the workspace, todos included: the Home's pinned-project progress. */
  tasks: readonly Task[];
  /** The workspace folder; null while the overview has not loaded it. */
  rootPath: string | null;
  references: readonly ChannelReference[];
};

const NO_TASKS: readonly Task[] = [];
const NO_OVERVIEW: BuddyOverview = [];

/** Every lookup the channel views derive from the overview and a workspace's Tasks. */
export function workspaceDirectory(
  overview: BuddyOverview,
  workspaceId: string,
  tasks: readonly Task[]
): WorkspaceDirectory {
  const workspace = findWorkspace(overview, workspaceId);
  const buddyNames = buddyNamesOf(overview);
  const activeMembers = workspace ? activeBuddies(workspace) : [];
  const viewed = channelTasks(tasks, buddyNames);
  return {
    workspaceName: workspace?.name ?? 'Channels',
    activeMembers,
    buddyNames,
    taskById: new Map(viewed.map((task) => [task.id, task])),
    tasks,
    rootPath: workspace?.rootPath ?? null,
    references: channelReferences(activeMembers, viewed),
  };
}

export function workspaceTasksUrl(workspaceId: string): string {
  return `/api/buddies/tasks?workspaceId=${encodeURIComponent(workspaceId)}`;
}

/** Members, Tasks and the @ index for one workspace, polled and cached. */
export function useWorkspaceDirectory(workspaceId: string): WorkspaceDirectory {
  const overview = useBuddyOverview(CHANNEL_BACKSTOP_MS);
  const tasks = usePolledFetch<Task[]>(workspaceTasksUrl(workspaceId), 15_000);
  return useMemo(
    () => workspaceDirectory(overview.data ?? NO_OVERVIEW, workspaceId, tasks.data ?? NO_TASKS),
    [overview.data, workspaceId, tasks.data]
  );
}

// ── Who is replying ─────────────────────────────────────────────────────────

export function respondingUrl(channelId: string): string {
  return `/api/buddies/channels/${encodeURIComponent(channelId)}/responding`;
}

/**
 * "Ada is replying…", "Ada is queued at the run limit…", or both, per thread root.
 * A root nobody is answering has no entry.
 */
export function respondingText(
  rows: readonly ChannelResponse[],
  buddyNames: Readonly<Record<string, string>>
): ReadonlyMap<string, string> {
  const byRoot = new Map<string, { replying: string[]; queued: string[] }>();
  for (const row of rows) {
    const entry = byRoot.get(row.threadRootId) ?? { replying: [], queued: [] };
    entry[row.state].push(buddyNames[row.buddyId] ?? row.buddyId);
    byRoot.set(row.threadRootId, entry);
  }
  const phrase = (names: string[], verb: string) =>
    names.length === 0 ? [] : [`${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} ${verb}`];
  return new Map(
    [...byRoot].map(([root, { replying, queued }]) => [
      root,
      [...phrase(replying, 'replying…'), ...phrase(queued, 'queued at the run limit…')].join(' · '),
    ])
  );
}

/** Who is composing a reply, as display text by thread root. */
export function useChannelResponding(
  channelId: string,
  buddyNames: Readonly<Record<string, string>>
): ReadonlyMap<string, string> {
  const responding = usePolledFetch<ChannelResponse[]>(
    respondingUrl(channelId),
    CHANNEL_BACKSTOP_MS
  );
  return useMemo(
    () => respondingText(responding.data ?? [], buddyNames),
    [responding.data, buddyNames]
  );
}

// ── Scrolling ───────────────────────────────────────────────────────────────

// Pin to the newest message on open, and keep following new posts only while
// the reader is already at the bottom — never yank someone reading history
// back down on a poll.
//
// `linkedPostId` is the post a permalink named (channel-link.ts `post=`):
// once its row renders, scroll it into view instead — once, so a poll never
// drags the reader back to it — and stop following the bottom.
export function useFollowBottom(rowCount: number, version: unknown, linkedPostId: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const revealedRef = useRef<string | null>(null);
  // Fix guard: DM history loads in separate generations; following only the active
  // transcript left new chats at the top. Observe the whole timeline as it hydrates.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const node = scrollRef.current;
      if (node && followRef.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the re-pin trigger
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || rowCount === 0) return;
    const linked =
      linkedPostId !== null && revealedRef.current !== linkedPostId
        ? node.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(linkedPostId)}"]`)
        : null;
    if (linked) {
      revealedRef.current = linkedPostId;
      followRef.current = false;
      // Scroll only this pane; scrollIntoView would also scroll its ancestors.
      node.scrollTop +=
        linked.getBoundingClientRect().top -
        node.getBoundingClientRect().top -
        node.clientHeight / 4;
      return;
    }
    if (followRef.current) node.scrollTop = node.scrollHeight;
  }, [rowCount, version, linkedPostId]);
  // Older posts render ABOVE the reader (useChannelFeed's loadOlder). Keep
  // their distance from the bottom across that render, or the page they were
  // reading jumps down by everything that loaded. A layout effect, so the
  // restored position is the first one painted.
  const heldRef = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowCount is the prepend trigger
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const held = heldRef.current;
    if (!node || held === null) return;
    heldRef.current = null;
    node.scrollTop = node.scrollHeight - held;
  }, [rowCount]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };
  const pin = () => {
    followRef.current = true;
  };
  const hold = () => {
    const node = scrollRef.current;
    if (node) heldRef.current = node.scrollHeight - node.scrollTop;
  };
  return { scrollRef, contentRef, onScroll, pin, hold };
}

// ── Owner unread ────────────────────────────────────────────────────────────
// The owner's read cursor per channel (post_read, reader 'owner'). The inbox
// counts posts by others after it — replies included — per channel, and lists
// the requests awaiting the owner (DM requests; across workspaces).

/**
 * Every workspace's inbox, one keyed resource: the tab title, the sidebar and
 * the mobile tab read it. The key names the workspaces, so a new workspace in
 * the overview is a new entry rather than a stale one; `channel_changed`
 * refreshes it (atoms/resources.ts invalidateChannelResources).
 */
export const OWNER_INBOXES_KEY = 'buddy-owner-inboxes:';

function ownerInboxesResource(workspaceIds: readonly string[]) {
  return resource(`${OWNER_INBOXES_KEY}${workspaceIds.join(',')}`, async (signal) =>
    Object.fromEntries(
      await Promise.all(
        workspaceIds.map(
          async (id) => [id, await buddyApi<Inbox>(inboxUrl(id), { signal })] as const
        )
      )
    )
  );
}

export type OwnerInboxes = Readonly<Record<string, Inbox>>;

export function useOwnerInboxes() {
  const overview = useBuddyOverview(CHANNEL_BACKSTOP_MS);
  const ids = overview.data?.map((workspace) => workspace.id).join(',') ?? null;
  const source = useMemo(
    () => (ids === null ? null : ownerInboxesResource(ids === '' ? [] : ids.split(','))),
    [ids]
  );
  return usePolledFetch<OwnerInboxes>(source, CHANNEL_BACKSTOP_MS);
}

const isListed = (entry: ChannelUnread) => entry.channel.kind.type !== 'task';

/** Requests awaiting the owner that sit in one of `inbox`'s channels. */
export function inboxRequests(inbox: Inbox): Post[] {
  const channels = new Set(inbox.channels.map((entry) => entry.channel.id));
  return inbox.requests.filter((post) => channels.has(post.channelId));
}

// What a nav item shows: the badge counts requests waiting on the owner, the
// dot says some rail channel has anything new. `workspaceId` null sums all.
// `requests` is global in every inbox, so it is counted by post id, once.
export type OwnerUnreadTotal = { requests: number; unreadChannels: number; unreadThreads: number };

export function ownerUnreadTotal(
  inboxes: OwnerInboxes | null,
  workspaceId: string | null
): OwnerUnreadTotal {
  const requests = new Set<string>();
  let unreadChannels = 0;
  let unreadThreads = 0;
  for (const [id, inbox] of Object.entries(inboxes ?? {})) {
    if (workspaceId !== null && id !== workspaceId) continue;
    for (const post of inboxRequests(inbox)) requests.add(post.id);
    unreadChannels += inbox.channels.filter((entry) => isListed(entry) && entry.unread > 0).length;
    unreadThreads += inbox.unreadThreads;
  }
  return { requests: requests.size, unreadChannels, unreadThreads };
}

/** New posts in a channel or new replies in a followed thread: the one "something is new" dot. */
export function anyUnread(total: OwnerUnreadTotal): boolean {
  return total.unreadChannels > 0 || total.unreadThreads > 0;
}

/** Requests awaiting the owner in one channel: a DM row's badge. */
export function channelRequestCount(inbox: Inbox | null, channelId: string): number {
  return inbox?.requests.filter((post) => post.channelId === channelId).length ?? 0;
}

// Slack's rail: a channel with anything new reads bold; a quiet one dims.
// Unknown until the inbox loads, so it renders as neither.
export function channelUnreadAttr(unread: number | undefined): 'new' | 'read' | undefined {
  if (unread === undefined) return undefined;
  return unread > 0 ? 'new' : 'read';
}

/**
 * Where the owner stood when they opened a channel, from the inbox's read cursor:
 * D = NeverRead ⊕ ReadThrough(ord). Snapshotted once per visit, so the "New messages" line and
 * the bold threads stay put while this visit marks the channel read (T22: both were dropped in
 * the T11 migration because the inbox exposed no cursor).
 */
export type ChannelArrival = { kind: 'never-read' } | { kind: 'read-through'; ord: string };

export function arrivalOf(entry: ChannelUnread): ChannelArrival {
  return entry.lastReadOrd === undefined
    ? { kind: 'never-read' }
    : { kind: 'read-through', ord: entry.lastReadOrd };
}

function unreadAt(arrival: ChannelArrival, ord: string): boolean {
  switch (arrival.kind) {
    case 'never-read':
      return true;
    case 'read-through':
      return ord > arrival.ord;
  }
}

/** Where "New messages" goes: the oldest loaded top-level post by someone else after the mark. */
export function firstUnreadPostId(
  newestFirst: readonly Post[],
  arrival: ChannelArrival
): string | null {
  let first: string | null = null;
  for (const post of newestFirst)
    if (post.author.kind !== 'owner' && unreadAt(arrival, post.ord)) first = post.id;
  return first;
}

/** Thread roots whose newest reply, by someone else, landed after the mark: bold in the channel. */
export function unreadThreadIds(
  threads: ReadonlyMap<string, ThreadStat>,
  arrival: ChannelArrival
): ReadonlySet<string> {
  const unread = new Set<string>();
  for (const stat of threads.values())
    if (stat.lastReplyAuthor.kind !== 'owner' && unreadAt(arrival, stat.lastReplyOrd))
      unread.add(stat.rootId);
  return unread;
}

// Starts false and reads `document` only in the effect: components render
// through react-dom/server in client tests, where there is no document.
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

// What the owner reads: D = Channel (its top-level cursor) ⊕ Thread (a followed thread's cursor,
// THREADS_VIEW_2026-09-28.md). Until then the thread pane moved the CHANNEL cursor through a
// reply, which marked top-level posts newer than it read unseen.
export type ReadTarget =
  | { kind: 'channel'; channelId: string }
  | { kind: 'thread'; rootId: string };

function readUrl(target: ReadTarget): string {
  switch (target.kind) {
    case 'channel':
      return `/api/buddies/channels/${encodeURIComponent(target.channelId)}/read`;
    case 'thread':
      return `/api/buddies/threads/${encodeURIComponent(target.rootId)}/read`;
  }
}

/**
 * The owner is looking at a channel or thread: mark it read through the newest
 * post rendered whenever it is on screen with something unread. A post that
 * lands after this render stays unread until the next refresh shows it; the
 * server's push clears it on the owner's other devices.
 */
export function useMarkRead(
  target: ReadTarget,
  hasUnread: boolean,
  newestPostId: string | null
): void {
  const visible = useDocumentVisible();
  const url = readUrl(target);
  useEffect(() => {
    if (!visible || !hasUnread || newestPostId === null) return;
    void buddyApi(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: newestPostId }),
    }).catch((error: unknown) => console.warn(`[channels] could not mark ${url} read:`, error));
  }, [url, newestPostId, hasUnread, visible]);
}

/**
 * One open thread, as both shells render it: the root, its replies (with the
 * outbox), who is replying, bottom-following, and the thread read mark. The
 * desktop pane and the mobile screen each carried a copy of this wiring.
 */
export function useThreadView(
  channelId: string,
  rootId: string,
  linkedPostId: string | null,
  buddyNames: Readonly<Record<string, string>>
) {
  const thread = useChannelFeed(threadFeed(rootId, linkedPostId));
  const root = thread.latest.data?.root;
  const replying = useChannelResponding(channelId, buddyNames).get(rootId);
  const replies = useWithOutbox(channelId, rootId, thread.posts);
  const replyRows = useMemo(() => channelRows(replies ?? []), [replies]);
  const follow = useFollowBottom(
    replyRows.length + (replying === undefined ? 0 : 1),
    thread.posts,
    linkedPostId
  );
  // A thread the owner does not follow has no cursor; the server ignores the mark.
  useMarkRead({ kind: 'thread', rootId }, true, newestServedId(thread.posts) ?? root?.id ?? null);
  const onPosted = () => {
    follow.pin();
    void thread.latest.refetch();
  };
  return { thread, root, replying, replyRows, follow, onPosted };
}

/**
 * The browser tab title carries the owner's unread state: `(3) Unleashd` for
 * requests waiting on them, `• Unleashd` when channels only have new posts.
 * Mounted once, in AppInner, so it holds on every route.
 */
export function useOwnerUnreadTitle(): void {
  const inboxes = useOwnerInboxes();
  const total = ownerUnreadTotal(inboxes.data, null);
  const baseTitle = useRef(document.title);
  useEffect(() => {
    const prefix = total.requests > 0 ? `(${total.requests}) ` : anyUnread(total) ? '• ' : '';
    document.title = `${prefix}${baseTitle.current}`;
  }, [total.requests, total.unreadChannels, total.unreadThreads]);
}

/** Archive changes navigation and unread counts on both shells through the shared keyed cache. */
export async function setChannelArchived(channelId: string, archived: boolean): Promise<void> {
  await buddyWrite(`/api/buddies/channels/${encodeURIComponent(channelId)}/archive`, 'POST', {
    archived,
  });
  invalidateBuddyResources();
}
