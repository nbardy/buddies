#!/usr/bin/env node
/**
 * screenshots.mjs — shoot every client screen at phone, tablet and desktop
 * sizes into one reviewable collection, and diff two collections.
 *
 * Usage (a server running, `pnpm dev`):
 *   pnpm screenshots                                   # every screen × every size
 *   pnpm screenshots --sizes phone,desktop
 *   pnpm screenshots --only chat,thread,buddy-memory
 *   pnpm screenshots --workspace project_… --open      # pin a workspace, open the sheet
 *   pnpm screenshots --url http://host:7489 --out /tmp/shots
 *   pnpm screenshots --workspace project_… --channel list_… --thread post_… \
 *     --focus 'Two stale Tasks'   # pin one thread; `focus` scrolls to that text
 *
 * The regression loop:
 *   pnpm screenshots                                   # before → output/screenshots/<A>
 *   … change code …
 *   pnpm screenshots --baseline output/screenshots/<A> # after: same data, same clock,
 *                                                      # then compares and exits 1 if over
 *   pnpm screenshots --compare <A> <B> [--threshold 0.5]   # re-diff any two runs
 *
 * Each run writes output/screenshots/<timestamp>/ (gitignored):
 *   <screen>@<size>.png   one per screen and size
 *   index.html            contact sheet: a row per screen, a column per size
 *   manifest.json         what was shot, what was skipped and why, the data
 *                         ids and clock used (what --baseline replays)
 * A compare adds compare.html, compare.json and diff/ to the AFTER run.
 *
 * Screens point at real data found through the API. A screen whose data is
 * absent is skipped and recorded, never faked. The session is read-only (see
 * openSession): the tool may point at the owner's live server.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS_PATH } from '@unleashd/shared';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';
import { compareRuns } from './lib/screenshot-compare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The app picks its tree with matchMedia('(max-width: 768px)'), so iPad
 * portrait gets the MOBILE tree and iPad landscape the desktop one. Both are
 * listed so the sheet shows exactly where that switch lands.
 */
const SIZES = {
  phone: { width: 375, height: 812, deviceScaleFactor: 2, mobile: true },
  'ipad-portrait': { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
  'ipad-landscape': { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
};

function treeFor(size) {
  return size.width <= 768 ? 'mobile' : 'desktop';
}

// Flags that choose WHAT is shot. --baseline replays them from the before run,
// so passing them as well would make the two runs disagree.
const SELECTION_FLAGS = ['--sizes', '--only', '--workspace', '--channel', '--thread', '--focus'];

function parseArgs(argv) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const args = {
    url: 'http://localhost:7489',
    out: path.join(ROOT, 'output/screenshots', stamp),
    sizes: Object.keys(SIZES),
    only: null,
    workspace: null,
    channel: null,
    thread: null,
    focus: null,
    open: false,
    baseline: null,
    compare: null,
    // 0 by default: a pure refactor must not move a pixel. Raise it for a
    // change that is allowed to (the tokenization codemod budgets 0.5).
    threshold: 0,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    seen.add(flag);
    if (flag === '--url') args.url = argv[++i].replace(/\/$/, '');
    else if (flag === '--out') args.out = path.resolve(argv[++i]);
    else if (flag === '--sizes') args.sizes = argv[++i].split(',').map((s) => s.trim());
    else if (flag === '--only') args.only = argv[++i].split(',').map((s) => s.trim());
    else if (flag === '--workspace') args.workspace = argv[++i];
    else if (flag === '--channel') args.channel = argv[++i];
    else if (flag === '--thread') args.thread = argv[++i];
    else if (flag === '--focus') args.focus = argv[++i];
    else if (flag === '--open') args.open = true;
    else if (flag === '--baseline') args.baseline = path.resolve(argv[++i]);
    else if (flag === '--compare')
      args.compare = [path.resolve(argv[++i]), path.resolve(argv[++i])];
    else if (flag === '--threshold') args.threshold = Number(argv[++i]);
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!Number.isFinite(args.threshold) || args.threshold < 0)
    throw new Error('--threshold is a percentage of changed pixels, e.g. 0.5');
  if (args.baseline) {
    const clash = SELECTION_FLAGS.filter((flag) => seen.has(flag));
    if (clash.length)
      throw new Error(`--baseline replays the before run's selection; drop ${clash.join(', ')}`);
  }
  if ((args.channel || args.thread) && !args.workspace)
    throw new Error('--channel/--thread need --workspace (the ids belong to one workspace)');
  if (args.thread && !args.channel) throw new Error('--thread needs its --channel');
  const unknown = args.sizes.filter((name) => !SIZES[name]);
  if (unknown.length) {
    throw new Error(`Unknown size ${unknown.join(', ')}; known: ${Object.keys(SIZES).join(', ')}`);
  }
  return args;
}

// ── Discovery ──────────────────────────────────────────────────────────────

function apiClient(baseUrl, token) {
  return async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`GET ${pathname} → HTTP ${response.status}`);
    return response.json();
  };
}

/** One workspace's best public channel: its most-replied recent thread, then the most posts. */
async function discoverWorkspace(api, workspace) {
  const inbox = await api(`/api/buddies/workspaces/${encodeURIComponent(workspace.id)}/inbox`);
  const candidates = await Promise.all(
    inbox.channels
      .filter((entry) => entry.channel.kind.type === 'public')
      .map(async ({ channel }) => {
        const page = await api(
          `/api/buddies/channels/${encodeURIComponent(channel.id)}/posts?limit=50`
        );
        // The page carries each root's reply count (`threads`, T22).
        const thread = [...page.threads].sort((a, b) => b.replies - a.replies)[0];
        return {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          channelId: channel.id,
          channelName: channel.kind.name,
          threadRootId: thread?.rootId ?? null,
          taskId: page.posts.find((post) => post.taskId)?.taskId ?? null,
          postCount: page.posts.length,
        };
      })
  );
  return (
    candidates.sort(richness)[0] ?? {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      channelId: null,
      channelName: null,
      threadRootId: null,
      taskId: null,
      postCount: 0,
    }
  );
}

// Richest first: a channel that fills every screen (a thread, a Task filter)
// beats a merely busy one, so a default run leaves as few blanks as possible.
function richness(a, b) {
  return (
    Number(b.threadRootId !== null) - Number(a.threadRootId !== null) ||
    Number(b.taskId !== null) - Number(a.taskId !== null) ||
    b.postCount - a.postCount
  );
}

/**
 * --workspace pins one; otherwise every workspace with an active Buddy is
 * scanned and the richest channel wins. Deliberately NOT the workspace
 * `/channels` opens: that is the most recently active one, which is often a
 * quiet channel with no threads, and the sheet came back half empty.
 */
async function discoverChannel(api, overview, pinnedWorkspaceId) {
  const byId = new Map(
    overview
      .filter((workspace) => workspace.buddies.some((buddy) => buddy.status === 'active'))
      .map((workspace) => [workspace.id, workspace])
  );
  if (pinnedWorkspaceId) {
    const pinned = byId.get(pinnedWorkspaceId);
    if (!pinned) {
      throw new Error(
        `No Buddy workspace ${pinnedWorkspaceId}; known: ${[...byId.keys()].join(', ')}`
      );
    }
    return discoverWorkspace(api, pinned);
  }
  const scanned = await Promise.all([...byId.values()].map((w) => discoverWorkspace(api, w)));
  const best = scanned.sort(richness)[0];
  if (!best) throw new Error('No Buddy workspaces — create a Buddy in a workspace first.');
  return best;
}

// A conversation last touched this recently may still be in use by someone,
// and a transcript that grows between the before and after run is a false diff.
const SETTLED_MS = 60 * 60 * 1000;

/**
 * The longest settled plain chat: not running, not done, idle for an hour.
 * The conversation list only arrives over the WebSocket, so this opens one,
 * reads the first complete row snapshot and closes — it never sends.
 * Wire v3 (shared/src/conversation.ts `EncodedRowsSchema`): `hello` carries
 * every row, `rows` upserts more while the server is still loading. Wire rows
 * omit their defaults, so an absent `run` is 'idle' and an absent `done` false.
 * The v2 `init` shape this used to read made every run fail with "No init".
 */
async function discoverConversation(baseUrl, token) {
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}${WS_PATH}`;
  const socket = new WebSocket(wsUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const rows = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No hello from ${wsUrl} in 30s`)), 30_000);
    const seen = new Map();
    socket.addEventListener('error', () => reject(new Error(`WebSocket ${wsUrl} failed`)));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'hello' || message.type === 'rows') {
        for (const row of message.rows) seen.set(row.id, row);
      }
      const complete = (message.type === 'hello' && !message.loading) || message.type === 'ready';
      if (!complete) return;
      clearTimeout(timer);
      resolve([...seen.values()]);
    });
  }).finally(() => socket.close());
  const cutoff = Date.now() - SETTLED_MS;
  const settled = rows.filter(
    (row) =>
      row.kind.t === 'chat' &&
      (row.run ?? 'idle') === 'idle' &&
      !row.done &&
      row.messageCount > 0 &&
      row.activityAt < cutoff
  );
  const longest = settled.sort((a, b) => b.messageCount - a.messageCount)[0];
  return longest ? { conversationId: longest.id, messageCount: longest.messageCount } : null;
}

/** First swarm project with a recorded run; the dashboard lists the same set. */
async function discoverSwarm(api) {
  const { projects } = await api('/api/swarm-projects');
  return projects[0]?.projectRoot ?? null;
}

function firstBuddy(overview, workspaceId) {
  const buddy = overview
    .find((workspace) => workspace.id === workspaceId)
    ?.buddies.find((candidate) => candidate.status === 'active');
  return { buddyId: buddy?.id ?? null, buddyName: buddy?.name ?? null };
}

async function discover(api, args, token) {
  const overview = await api('/api/buddies/overview');
  const channel = await discoverChannel(api, overview, args.workspace);
  const conversation = await discoverConversation(args.url, token);
  const buddy = firstBuddy(overview, channel.workspaceId);
  const direct = buddy.buddyId
    ? await api(`/api/buddies/${encodeURIComponent(buddy.buddyId)}/direct/chain`)
    : null;
  return {
    ...channel,
    // A pinned channel/thread replaces the richest one discovery picked.
    ...(args.channel ? { channelId: args.channel, channelName: args.channel } : {}),
    ...(args.thread ? { threadRootId: args.thread } : {}),
    conversationId: conversation?.conversationId ?? null,
    conversationMessages: conversation?.messageCount ?? null,
    // The first active Buddy of the discovered workspace (its detail tabs are screens).
    ...buddy,
    directConversationId: direct?.generations?.at(-1) ?? null,
    swarmProject: await discoverSwarm(api),
  };
}

// ── Screens ────────────────────────────────────────────────────────────────

/**
 * Prepare scripts run in the page after navigation and return 'OK' or 'SKIP'
 * (the precondition is absent, e.g. a trigger button is not rendered). They
 * open menus and type into inputs; they never submit — and could not: the
 * session drops every write (see openSession).
 */
const HELPERS = `
  const tick = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
  // React only sees a value set through the native setter plus an input event.
  const typeInto = (input, text) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const clickText = (selector, text) =>
    [...document.querySelectorAll(selector)].find((el) => el.textContent.includes(text))?.click();
  const has = (selector) => (document.querySelector(selector) ? 'OK' : 'SKIP');
`;
const prep = (body) => `(async () => {${HELPERS}${body}})()`;

// Before every shot: no HTTP request in flight for QUIET_MS (see
// waitForNetworkIdle). 500ms outlasts the app's fetch-then-fetch chains; the
// 20s cap flags a page that never goes quiet instead of hanging the run.
const QUIET_MS = 500;
const IDLE_TIMEOUT_MS = 20_000;

// Re-pin message panes that are following their bottom (within the app's own 48px
// follow threshold, channel-data.ts useFollowBottom) just before the shot.
// The app pins once per render; content that grows after it (lazy markdown,
// avatars) left the thread 1px short of the bottom in one run and flush in the
// next, a 7% diff on thread@ipad-portrait (2026-09-25).
const PIN_FOLLOWED_BOTTOMS = `(() => {
  // Pinning every scroll container also scrolled the new-conversation heading offscreen.
  for (const el of document.querySelectorAll('.channel-browser-scroll, .mobile-channel__scroll, .mobile-chat__messages, .messages-container')) {
    if (el.scrollHeight <= el.clientHeight) continue;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap > 0 && gap < 48) el.scrollTop = el.scrollHeight;
  }
})()`;

const clickThen = (target, expect) =>
  prep(`
  const el = document.querySelector(${JSON.stringify(target)});
  if (!el) return 'SKIP';
  el.click();
  await tick();
  return has(${JSON.stringify(expect)});`);

// Matches no conversation, Buddy or path, so the search's own empty state shows.
const NO_MATCH = 'zqxj-no-such-text';

// Type "@" into the channel composer (one component on both trees) so the
// mention picker opens.
const OPEN_MENTION_MENU = prep(`
  const input = document.querySelector('.channel-composer textarea');
  if (!input) return 'SKIP';
  input.focus();
  typeInto(input, '@');
  input.setSelectionRange(1, 1);
  await tick(50);
  return has('.channel-composer-picker');`);

// Expand the channel header's Search pill in place and type a query so the
// results drop below it.
const OPEN_CHANNEL_SEARCH = prep(`
  const pill = document.querySelector('.channel-search-trigger');
  if (!pill) return 'SKIP';
  pill.click();
  await tick(50);
  const input = document.querySelector('.channel-search-panel input');
  if (!input) return false;
  typeInto(input, 'search');
  await tick(1500);
  return has('.channel-search-panel');`);

// Pick the first Buddy from the @ menu with Enter (React handles the native
// keydown), then click its chip on the bar to open the harness/model picker.
// A chip that is disabled means the backend predates member execution.
const OPEN_MENTION_MODEL = prep(`
  const input = document.querySelector('.channel-composer textarea');
  if (!input) return 'SKIP';
  input.focus();
  typeInto(input, '@');
  input.setSelectionRange(1, 1);
  await tick(150);
  const buddy = [...document.querySelectorAll('.channel-composer-picker button')].findIndex(
    (button) => !button.querySelector('.channel-composer-picker-task')
  );
  if (buddy < 0) return 'SKIP';
  for (let step = 0; step < buddy; step += 1) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await tick(150);
  }
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(150);
  const chip = document.querySelector('.channel-composer-mention');
  if (!chip || chip.disabled) return 'SKIP';
  chip.click();
  await tick(150);
  return has('.channel-composer-model');`);

// Use the first real seat in this thread. The chip and bottom picker must show its
// contextual model rather than a profile default, on both composer shells.
const OPEN_THREAD_SELECTION = (rootId, openPicker = false) =>
  prep(`
  const thread = await (await fetch('/api/buddies/posts/' + ${JSON.stringify(rootId)} + '/thread')).json();
  const id = thread.seats?.[0]?.buddyId;
  if (!id) return 'SKIP';
  const buddy = await (await fetch('/api/buddies/' + encodeURIComponent(id))).json();
  const input = [...document.querySelectorAll('.channel-composer textarea')].at(-1);
  if (!input || !buddy.buddy?.name) return 'SKIP';
  input.focus();
  const query = '@' + buddy.buddy.name;
  typeInto(input, query);
  input.setSelectionRange(query.length, query.length);
  await tick(150);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(150);
  const chip = [...document.querySelectorAll('.channel-composer-mention')].at(-1);
  if (!chip || chip.disabled) return 'SKIP';
  ${openPicker ? 'chip.click();' : 'input.blur();'}
  await tick(250);
  return has(${JSON.stringify(openPicker ? '.channel-composer-model' : '.channel-composer-mention')});`);

// Click the first image in a channel post: the viewer must be centred on the page
// (it sat top-left, #bugfixes 2026-10-01).
const OPEN_IMAGE_VIEWER = prep(`
  const link = document.querySelector('.channel-markdown .channel-media-link');
  if (!link) return 'SKIP';
  link.scrollIntoView({ block: 'center' });
  link.click();
  await tick(300);
  return has('dialog.channel-image-overlay[open]');`);

// Scroll the LAST post body containing `text` to the top of its pane, so a
// long reply deep in a thread can be shot at a named spot. Last, because the
// desktop thread pane follows the channel pane in document order.
const scrollToText = (text) =>
  prep(`
  const body = [...document.querySelectorAll('.channel-markdown')].findLast((node) =>
    node.textContent.includes(${JSON.stringify(text)})
  );
  if (!body) return 'SKIP';
  body.scrollIntoView({ block: 'start' });
  return 'OK';`);

// Then focus that post's LAST live Task chip, which opens its hover card —
// the last one sits lowest, where a card is most likely to be cut off.
const hoverTaskIn = (text) =>
  prep(`
  const body = [...document.querySelectorAll('.channel-markdown')].findLast((node) =>
    node.textContent.includes(${JSON.stringify(text)})
  );
  const chip = [...(body?.querySelectorAll('a.channel-task-chip') ?? [])].at(-1);
  if (!chip) return 'SKIP';
  chip.scrollIntoView({ block: 'center' });
  chip.focus();
  return 'OK';`);

/**
 * The Buddy tab list lives once, in the client (buddy-tabs.ts). It is read
 * from source rather than copied here so a new tab gets a screen for free.
 */
function employeeTabs() {
  const source = fs.readFileSync(
    path.join(ROOT, 'client/src/components/buddies/buddy-tabs.ts'),
    'utf8'
  );
  const list = /EMPLOYEE_TABS = \[([^\]]*)\]/.exec(source);
  if (!list) throw new Error('EMPLOYEE_TABS not found in buddy-tabs.ts; update employeeTabs()');
  return [...list[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
}

const enc = encodeURIComponent;
/** The same path (and prepare) on both trees. */
const onBoth = (path, prepare = null) => ({
  desktop: { path, prepare },
  mobile: { path, prepare },
});

/**
 * Every screen, as data: `views` maps a tree to the { path, prepare } that
 * shows the screen there; a tree with no entry has no such screen. `missing`
 * is why the screen cannot be shot at all (its data is absent), or null.
 */
export function buildScreens(found, focus) {
  const chat = found.conversationId && `/chat/${enc(found.conversationId)}`;
  const noChat = chat ? null : 'no settled chat (general, not running, not done, idle ≥1h)';
  const noBuddy = found.buddyId ? null : 'no Buddy';
  const buddy = found.buddyId && `/buddies/${enc(found.buddyId)}`;
  const channels = `/buddies/workspaces/${enc(found.workspaceId)}/channels`;
  const dm = found.directConversationId && `${channels}?dm=${enc(found.directConversationId)}`;
  const channel = found.channelId && `channel=${enc(found.channelId)}`;
  const noChannel = channel ? null : 'no channel with posts in this workspace';
  const thread = found.threadRootId && `${channels}?${channel}&thread=${enc(found.threadRootId)}`;
  const noThread = noChannel ?? (thread ? null : 'no thread with replies in this channel');
  const noFocus = noThread ?? (focus ? null : 'needs --focus <text in a thread post>');
  const swarm = found.swarmProject && `/workers/detail?project=${enc(found.swarmProject)}`;

  return [
    // ── Conversations ──
    { name: 'workspace-home', missing: null, views: onBoth('/') },
    { name: 'gallery', missing: null, views: onBoth('/chats') },
    { name: 'done', missing: null, views: onBoth('/done') },
    {
      name: 'search',
      missing: null,
      views: {
        // Desktop search is a palette over any page; mobile has a search page.
        desktop: {
          path: '/chats',
          prepare: clickThen('.sidebar-search-field', '.search-view--palette'),
        },
        mobile: { path: '/search', prepare: null },
      },
    },
    {
      name: 'search-empty',
      missing: null,
      views: {
        desktop: {
          path: '/chats',
          prepare: prep(`
  document.querySelector('.sidebar-search-field')?.click();
  await tick();
  const input = document.querySelector('.search-view__input');
  if (!input) return 'SKIP';
  typeInto(input, ${JSON.stringify(NO_MATCH)});
  await tick(1200);
  return has('.search-view__status');`),
        },
        mobile: {
          path: '/search',
          prepare: prep(`
  const input = document.querySelector('.search-view__input');
  if (!input) return 'SKIP';
  typeInto(input, ${JSON.stringify(NO_MATCH)});
  await tick(1200);
  return 'OK';`),
        },
      },
    },
    {
      name: 'new-conversation',
      missing: null,
      views: {
        desktop: { path: '/chats', prepare: clickThen('.sidebar-new-btn', '.new-conv-modal') },
        mobile: { path: '/chats', prepare: clickThen('.mobile-ui-header-action', '.ui-sheet') },
      },
    },
    {
      name: 'settings-menu',
      missing: null,
      // The mobile tree has no settings menu, palette or usage panel.
      views: { desktop: { path: '/chats', prepare: clickThen('.config-trigger', '.config-menu') } },
    },
    {
      name: 'usage',
      missing: null,
      views: {
        desktop: {
          path: '/chats',
          prepare: prep(`
  document.querySelector('.config-trigger')?.click();
  await tick();
  clickText('.config-item', 'Usage');
  await tick(1500);
  return has('.usage-panel');`),
        },
      },
    },
    { name: 'chat', missing: noChat, settleMs: 1500, views: onBoth(chat) },
    {
      name: 'chat-picker-open',
      missing: noChat,
      settleMs: 1500,
      views: {
        desktop: {
          path: chat,
          prepare: clickThen('.chat-config-summary', '.config-overlay--popover'),
        },
        mobile: { path: chat, prepare: clickThen('.mobile-chat__model', '.ui-sheet') },
      },
    },
    // ── Buddies ──
    { name: 'buddies', missing: null, views: onBoth('/buddies') },
    ...employeeTabs().map((tab) => ({
      name: `buddy-${tab}`,
      missing: noBuddy,
      views: onBoth(`${buddy}/${tab}`),
    })),
    {
      name: 'buddy-about',
      missing: noBuddy,
      views: onBoth(
        `${buddy}/conversations`,
        clickThen('.buddy-about > summary', '.buddy-about-card')
      ),
    },
    {
      name: 'workspace-activity',
      missing: null,
      views: onBoth(`/buddies/workspaces/${enc(found.workspaceId)}`),
    },
    // ── Channels ──
    { name: 'channels', missing: null, views: onBoth(channels) },
    { name: 'dm', missing: dm ? null : 'no Buddy DM', views: onBoth(dm) },
    {
      name: 'dm-about',
      missing: dm ? null : 'no Buddy DM',
      views: onBoth(dm, clickThen('.buddy-about > summary', '.buddy-about-card')),
    },
    { name: 'channel', missing: noChannel, views: onBoth(`${channels}?${channel}`) },
    {
      name: 'image-viewer',
      missing: noChannel,
      views: onBoth(`${channels}?${channel}`, OPEN_IMAGE_VIEWER),
    },
    { name: 'thread', missing: noThread, views: onBoth(thread) },
    {
      name: 'thread-selection',
      missing: noThread,
      views: onBoth(thread, OPEN_THREAD_SELECTION(found.threadRootId)),
    },
    {
      name: 'thread-selection-picker',
      missing: noThread,
      views: onBoth(thread, OPEN_THREAD_SELECTION(found.threadRootId, true)),
    },
    // The workspace Home. Pins are `Task.pin` on the server and this session refuses writes, so
    // the stars and the reorder menu show only when the data already has pins (task_write or the
    // owner PATCH). Show all exists on desktop only; the phone row lists every card.
    { name: 'landing', missing: null, views: onBoth(`${channels}?view=home`) },
    {
      name: 'landing-menu',
      missing: null,
      views: onBoth(
        `${channels}?view=home`,
        clickThen('.landing-menu-button', '.landing-menu-list')
      ),
    },
    {
      name: 'landing-show-all',
      missing: null,
      views: onBoth(
        `${channels}?view=home`,
        clickThen('.landing-more', '.landing-project:nth-child(5)')
      ),
    },
    {
      name: 'landing-search',
      missing: null,
      views: onBoth(
        `${channels}?view=home`,
        prep(`
  const input = document.querySelector('.landing-search');
  if (!input) return 'SKIP';
  typeInto(input, 'home');
  await tick();
  return has('.landing-project');`)
      ),
    },
    // The Threads view (product/buddies/THREADS_VIEW_2026-09-28.md). Its fold expands in place on
    // desktop only; mobile's opens the thread screen.
    { name: 'threads', missing: null, views: onBoth(`${channels}?view=threads`) },
    {
      name: 'threads-expanded',
      missing: null,
      views: {
        desktop: {
          path: `${channels}?view=threads`,
          prepare: clickThen('.threads-fold', '.threads-card'),
        },
      },
    },
    // The Task filter is desktop-only (the mobile channel screen has no picker).
    {
      name: 'task-filter',
      missing: noChannel ?? (found.taskId ? null : 'no post about a Task in this channel'),
      views: {
        desktop: { path: `${channels}?${channel}&task=${enc(found.taskId)}`, prepare: null },
      },
    },
    {
      name: 'channel-search',
      missing: noChannel,
      views: { desktop: { path: `${channels}?${channel}`, prepare: OPEN_CHANNEL_SEARCH } },
    },
    {
      name: 'mention-menu',
      missing: noChannel,
      views: onBoth(`${channels}?${channel}`, OPEN_MENTION_MENU),
    },
    // The Threads card's reply composer: the same fullscreen editor and @ menu as a channel's.
    // Its layout rules were scoped to the channel screen, so this one shrank (#bugfixes 2026-09-29).
    {
      name: 'threads-mention-menu',
      missing: null,
      views: onBoth(`${channels}?view=threads`, OPEN_MENTION_MENU),
    },
    {
      name: 'mention-model',
      missing: noChannel,
      views: onBoth(`${channels}?${channel}`, OPEN_MENTION_MODEL),
    },
    { name: 'focus', missing: noFocus, views: onBoth(thread, focus && scrollToText(focus)) },
    { name: 'task-hover', missing: noFocus, views: onBoth(thread, focus && hoverTaskIn(focus)) },
    // ── Swarm (quarantined, still shipped) ──
    { name: 'swarm', missing: null, views: onBoth('/workers') },
    { name: 'swarm-detail', missing: swarm ? null : 'no swarm project', views: onBoth(swarm) },
    { name: 'swarm-analytics', missing: null, views: onBoth('/workers/analytics') },
  ];
}

// Streaming is deliberately not a screen: a live turn changes between the
// before and after run by definition, so it could only ever fail a compare.
// The tail-regroup test covers it.

// ── Contact sheet ──────────────────────────────────────────────────────────

function escapeHtml(text) {
  // A screen definition accidentally landed in replace's arguments and crashed every gallery.
  // Guard: thread selection screenshot run finishes with its contact sheet.
  return String(text).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );
}

export function contactSheet(manifest) {
  const header = manifest.sizes
    .map((name) => {
      const s = SIZES[name];
      return `<th>${escapeHtml(name)}<small>${s.width}×${s.height} · ${treeFor(s)} tree</small></th>`;
    })
    .join('');
  const rows = manifest.screens
    .map((screen) => {
      const cells = manifest.sizes
        .map((size) => {
          const shot = manifest.shots.find((s) => s.screen === screen && s.size === size);
          if (shot) {
            return `<td><a href="${escapeHtml(shot.file)}" target="_blank"><img src="${escapeHtml(shot.file)}" loading="lazy"></a></td>`;
          }
          const skip = manifest.skipped.find((s) => s.screen === screen && s.size === size);
          return `<td class="skip">${escapeHtml(skip?.reason ?? 'not shot')}</td>`;
        })
        .join('');
      return `<tr><th scope="row">${escapeHtml(screen)}</th>${cells}</tr>`;
    })
    .join('\n');
  const found = manifest.found;
  return `<!doctype html>
<meta charset="utf-8">
<title>Screenshots · ${escapeHtml(manifest.createdAt)}</title>
<style>
  body { margin: 0; background: #111418; color: #c9ccd1; font: 13px/1.4 system-ui, sans-serif; }
  header { padding: 16px 20px; border-bottom: 1px solid #2a2f36; }
  header h1 { margin: 0 0 4px; font-size: 16px; }
  header p { margin: 0; color: #8a919b; }
  table { border-collapse: collapse; }
  th, td { padding: 12px; border-bottom: 1px solid #2a2f36; vertical-align: top; text-align: left; }
  thead th { position: sticky; top: 0; background: #111418; z-index: 1; }
  thead small { display: block; color: #8a919b; font-weight: 400; }
  tbody th { width: 140px; }
  img { display: block; max-height: 640px; max-width: 520px; border: 1px solid #2a2f36; border-radius: 6px; }
  td.skip { color: #8a919b; font-style: italic; }
</style>
<header>
  <h1>Screenshots · ${manifest.shots.length} shot, ${manifest.skipped.length} skipped</h1>
  <p>${escapeHtml(manifest.createdAt)} · ${escapeHtml(manifest.baseUrl)} · clock ${escapeHtml(new Date(manifest.clockMs).toISOString())} · workspace ${escapeHtml(found.workspaceName)} · #${escapeHtml(found.channelName ?? '—')} · Buddy ${escapeHtml(found.buddyName ?? '—')} · click a shot for full size</p>
</header>
<table>
  <thead><tr><th></th>${header}</tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
`;
}

// ── Main ───────────────────────────────────────────────────────────────────

function printCompare(report) {
  for (const pair of report.pairs.filter((p) => p.over)) {
    process.stdout.write(`  over: ${pair.file} — ${pair.label}\n`);
  }
  process.stdout.write(
    `${report.overCount} of ${report.pairs.length} over ${report.thresholdPct}% · ${path.join(report.after, 'compare.html')}\n`
  );
  return report.failed ? 1 : 0;
}

async function capture(args) {
  const token = resolveAuthToken();
  const api = apiClient(args.url, token);
  const baseline = args.baseline
    ? JSON.parse(fs.readFileSync(path.join(args.baseline, 'manifest.json'), 'utf8'))
    : null;
  // The baseline's data ids, clock and selection, so the after run shoots the
  // same things at the same instant; otherwise discover fresh.
  const found = baseline?.found ?? (await discover(api, args, token));
  const clockMs = baseline?.clockMs ?? Date.now();
  const selection = baseline?.selection ?? {
    sizes: args.sizes,
    only: args.only,
    focus: args.focus,
  };
  fs.mkdirSync(args.out, { recursive: true });
  process.stdout.write(
    `workspace ${found.workspaceName} · #${found.channelName} · chat ${found.conversationId} · Buddy ${found.buddyName}\n`
  );
  const screens = buildScreens(found, selection.focus).filter(
    (screen) => !selection.only || selection.only.includes(screen.name)
  );

  // The app warms the 12 most recent chats' history in idle time, 3 at a time
  // (atoms/prefetch.ts). Against a real data dir that queue ran past 30s and
  // kept every screen from ever going network-idle, yet it paints nothing on
  // the screen under test. The chat screens' own transcript is NOT ignored.
  const prefetch = new RegExp(
    `/api/conversations/(?!${found.conversationId ?? '-'}(?:$|[/?]))[^/?]+$`
  );
  const session = await openSession({ baseUrl: args.url, token, clockMs });
  const shots = [];
  const skipped = [];
  let blockedWrites;
  try {
    for (const sizeName of selection.sizes) {
      const size = SIZES[sizeName];
      const tree = treeFor(size);
      await session.setViewport(size);
      for (const screen of screens) {
        const record = (reason) => skipped.push({ screen: screen.name, size: sizeName, reason });
        const view = screen.views[tree];
        if (screen.missing) {
          record(screen.missing);
          continue;
        }
        if (!view) {
          record(`${tree} tree has no such screen`);
          continue;
        }
        // One slow or broken page must not end a 150-shot run: record it and
        // move on. The compare then flags the screen as missing from this run.
        try {
          await session.goto(`${args.url}${view.path}`, screen.settleMs ?? 1000);
          // Requests still open at capture time (empty when the page went quiet).
          let pending = await session.waitForNetworkIdle(QUIET_MS, IDLE_TIMEOUT_MS, prefetch);
          // Continue is a device-local dismissal, unlike "Check again", which invokes CLIs.
          // Temporary servers deliberately have no agent CLIs; their prompt hid every screen.
          await session.evaluate(
            prep(`
            const prompt = document.querySelector('dialog[aria-labelledby="dependencies-title"]');
            [...(prompt?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'Continue')?.click();
            await tick(100);`)
          );
          if (view.prepare) {
            if ((await session.evaluate(view.prepare)) === 'SKIP') {
              record('precondition absent on the page');
              continue;
            }
            // What the prepare opened (usage panel, search) fetches its own data.
            await sleep(300);
            pending = [
              ...pending,
              ...(await session.waitForNetworkIdle(QUIET_MS, IDLE_TIMEOUT_MS, prefetch)),
            ];
          }
          // Data arrived; give React and lazy markdown/katex one beat to paint it.
          await sleep(400);
          await session.evaluate(PIN_FOLLOWED_BOTTOMS);
          await sleep(100);
          const file = `${screen.name}@${sizeName}.png`;
          await session.capture(path.join(args.out, file));
          shots.push({ screen: screen.name, size: sizeName, file, path: view.path, pending });
          const open = pending.length ? ` (still loading after 20s: ${pending.join(' ')})` : '';
          process.stdout.write(`saved ${file}${open}\n`);
        } catch (error) {
          record(`page failed: ${error.message}`);
        }
      }
    }
    blockedWrites = await session.blockedWrites();
  } finally {
    await session.close();
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    baseUrl: args.url,
    clockMs,
    found,
    selection,
    sizes: selection.sizes,
    screens: screens.map((screen) => screen.name),
    shots,
    skipped,
    blockedWrites,
  };
  fs.writeFileSync(path.join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const sheet = path.join(args.out, 'index.html');
  fs.writeFileSync(sheet, contactSheet(manifest));

  process.stdout.write(`\n${shots.length} screenshot(s), ${skipped.length} skipped\n${sheet}\n`);
  for (const skip of skipped) {
    process.stdout.write(`  skipped ${skip.screen}@${skip.size}: ${skip.reason}\n`);
  }
  process.stdout.write(
    `blocked writes: ${blockedWrites.length} (${[...new Set(blockedWrites)].join(', ') || 'none'})\n`
  );
  if (args.open) execFile('open', [sheet]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.compare) {
    process.exitCode = printCompare(await compareRuns(...args.compare, args.threshold));
    return;
  }
  await capture(args);
  if (args.baseline) {
    process.exitCode = printCompare(await compareRuns(args.baseline, args.out, args.threshold));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
}
