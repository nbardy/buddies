import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buddyFixture, rosterFixture } from './fixtures/buddy-roster';
import { inboxFixture, postFixture, publicChannel } from './fixtures/channel-posts';
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { ChannelsMobile } = await import('../src/mobile/channels/ChannelsMobile');
const { isImmersiveChannelRoute } = await import('../src/mobile/channels/channel-route');
const { channelsView } = await import('../src/components/buddies/channels-view');
const { channelLinkPath, postLink } = await import('../src/components/buddies/channel-link');
const { mobilePrimarySectionForPath, resolveMobileConversationDestination } = await import(
  '../src/utils/conversation-route-state'
);
const { Provider } = await import('jotai');
const { jotaiStore } = await import('../src/atoms/store');
const { loadResource } = await import('../src/atoms/resources');
const { rowsAtom } = await import('../src/atoms/conversations');
const { syntheticConversation } = await import('./fixtures/synthetic-conversations');

const WS = 'ws-phone';
const CHANNELS = `/buddies/workspaces/${WS}/channels`;

// Permalinks are built by desktop (channel-link.ts) but parsed by a separate
// mobile router (channel-route.ts). A link pasted into a bug report from the
// desktop must open the same thread, and the same reply, on a phone.
test('a desktop message permalink opens its thread and reply on mobile', () => {
  const post = postFixture({
    id: 'post_reply',
    channelId: 'ch_a',
    author: { kind: 'buddy', id: 'b1' },
    rootId: 'post_root',
    replyToId: 'post_root',
    purpose: 'reply',
  });
  const reply = new URL(channelLinkPath(WS, postLink(post)), 'http://host');
  assert.equal(reply.pathname, CHANNELS);
  assert.deepEqual(channelsView(reply.search), {
    kind: 'thread',
    channelId: 'ch_a',
    rootId: 'post_root',
    linkedPostId: 'post_reply',
  });
  // A top-level message links to its own thread, which loads it by id however old it is.
  const root = new URL(
    channelLinkPath(WS, postLink(postFixture({ id: 'post_root', channelId: 'ch_a' }))),
    'http://host'
  );
  assert.deepEqual(channelsView(root.search), {
    kind: 'thread',
    channelId: 'ch_a',
    rootId: 'post_root',
    linkedPostId: null,
  });
});

// The channel URL is shared with desktop, so the section and the immersive
// flag are derived from it. Misreading it as the Buddies section would light
// the wrong tab and keep the tab bar over the pinned composer.
test('channel URLs belong to the Channels tab; only channel and thread screens are immersive', () => {
  assert.equal(mobilePrimarySectionForPath(CHANNELS), 'channels');
  assert.equal(mobilePrimarySectionForPath('/channels'), 'channels');
  assert.equal(mobilePrimarySectionForPath(`/buddies/workspaces/${WS}`), 'buddies');
  assert.equal(isImmersiveChannelRoute(CHANNELS, ''), false);
  assert.equal(isImmersiveChannelRoute(CHANNELS, '?channel=list_a'), true);
  assert.equal(isImmersiveChannelRoute(CHANNELS, '?channel=list_a&thread=post_1'), true);
  assert.equal(isImmersiveChannelRoute('/buddies/b1', '?channel=list_a'), false);
  // A DM opened from Channels comes back to the exact channels screen.
  const back = resolveMobileConversationDestination(
    {
      mobileConversationOrigin: {
        section: 'channels',
        pathname: CHANNELS,
        search: '?channel=list_a',
        hash: '',
      },
    },
    null
  );
  assert.deepEqual(back, { path: `${CHANNELS}?channel=list_a`, section: 'channels' });
});

const lead = buddyFixture({ id: 'lead', name: 'Lead', role: 'Own the work', workspaceId: WS });

async function seed() {
  await loadResource({
    key: '/api/buddies/overview',
    load: async () => [rosterFixture([lead], { id: WS, name: 'unleashd' })],
  });
  await loadResource({
    key: `/api/buddies/workspaces/${WS}/inbox`,
    load: async () =>
      inboxFixture([
        { channel: publicChannel('ch_a', 'general', WS), unread: 0 },
        {
          channel: {
            id: 'ch_dm',
            workspaceId: WS,
            kind: { type: 'direct', members: [{ kind: 'owner' }, { kind: 'buddy', id: 'lead' }] },
            createdBy: { kind: 'owner' },
            createdAt: '2026-09-24T00:00:00.000Z',
          },
          unread: 0,
        },
      ]),
  });
  await loadResource({ key: `/api/buddies/tasks?workspaceId=${WS}`, load: async () => [] });
  await loadResource({ key: '/api/buddies/channels/ch_a/responding', load: async () => [] });
  await loadResource({
    key: '/api/buddies/channels/ch_a/posts?limit=50',
    load: async () => ({
      posts: [
        postFixture({
          id: 'post_ask',
          body: '[@Lead](buddy:lead) ship it?',
          createdAt: '2026-09-24T01:00:00.000Z',
        }),
      ],
    }),
  });
}

function render(url: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Provider store={jotaiStore}>
        <Routes>
          <Route path="/buddies/workspaces/:workspaceId/channels" element={<ChannelsMobile />} />
        </Routes>
      </Provider>
    </MemoryRouter>
  );
}

test('mobile channel screen: back to Home, thread link, touch composer', async () => {
  await seed();
  const html = render(`${CHANNELS}?channel=ch_a`);
  assert.match(
    html,
    /class="mobile-channel-header__back"[^>]*href="\/buddies\/workspaces\/ws-phone\/channels"/
  );
  assert.match(html, /<h1># general<\/h1>/);
  assert.match(html, /<a class="channel-mention" href="\/buddies\/lead"[^>]*>@Lead<\/a>/);
  // Every root opens its thread screen at the shared URL (posts carry no reply count).
  assert.match(
    html,
    /class="mobile-channel-post__reply[^"]*" href="\/buddies\/workspaces\/ws-phone\/channels\?channel=ch_a&amp;thread=post_ask"/
  );
  // Touch composer: Return is a newline, so no Shift+Enter hint.
  assert.match(html, /placeholder="Message #general"/);
  assert.doesNotMatch(html, /new line/);
  // a2e4135 (#bugfixes 2026-09-25): pinned in the pane, iOS panning left the
  // composer floating mid-screen. It rides FullscreenComposer, whose editing
  // head names the channel and carries Done.
  assert.match(
    html,
    /class="fullscreen-composer"[\s\S]*class="mobile-channel-compose__head"><span># general<\/span><button type="button">Done<\/button>[\s\S]*placeholder="Message #general"/
  );
});

// A reply permalink opens its thread FROM the reply (`&from=`, T22): the
// linked reply is on the first page however old it is, highlighted, the root
// sits on top and older replies wait behind the flame.
test('a reply permalink opens its thread with the reply highlighted and the root on top', async () => {
  await seed();
  const reply = (number: number) =>
    postFixture({
      id: `reply-${number}`,
      author: { kind: 'buddy', id: 'lead' },
      rootId: 'post_ask',
      purpose: 'reply',
      body: `Reply number ${number}.`,
      createdAt: new Date(Date.UTC(2026, 8, 24, 2, number - 100)).toISOString(),
    });
  await loadResource({
    key: '/api/buddies/posts/post_ask/thread?limit=50&from=reply-120',
    load: async () => ({
      root: postFixture({ id: 'post_ask', body: '[@Lead](buddy:lead) ship it?' }),
      posts: [125, 124, 123, 122, 121, 120].map(reply),
      next: { createdAt: '2026-09-24T02:19:00.000Z', id: 'reply-119' },
    }),
  });
  const html = render(`${CHANNELS}?channel=ch_a&thread=post_ask&post=reply-120`);
  const at = ['ship it?', 'class="channel-history"', 'Reply number 120.', 'Reply number 125.'].map(
    (needle) => html.indexOf(needle)
  );
  assert.ok(!at.includes(-1), `missing: ${at}`);
  assert.deepEqual(
    at,
    [...at].sort((a, b) => a - b),
    'root, flame, linked reply, newest'
  );
  assert.match(html, /data-post-id="reply-120" data-linked="true"/);
  assert.match(html, /class="mobile-channel-compose__head"><span>Thread in # general<\/span>/);
  assert.doesNotMatch(html, /Also send to channel|type="checkbox"/);
});

test('mobile channels Home lists channels and Buddies with a visible Wake', async () => {
  await seed();
  const html = render(CHANNELS);
  assert.match(html, /mobile-channels-row__name[^"]*">general</);
  assert.match(html, /Add channel/);
  assert.doesNotMatch(html, /Direct messages/);
  assert.match(html, /mobile-channels-row__name[^"]*">Lead</);
  assert.match(html, /aria-label="Wake Lead: catch up on the channels and act"/);
});

// PORT-3 left these desktop-only (e9e3426): a phone could not start a Buddy, a running Builder
// chat vanished from Home, and a posted reply gave no way into the conversation that wrote it.
test('mobile Home starts and lists a Buddy setup chat; a held post offers its conversation', async () => {
  await seed();
  await loadResource({
    key: '/api/buddies/channels/ch_a/posts?limit=50',
    load: async () => ({
      posts: [
        postFixture({ id: 'post_held', conversationId: 'conv-held', body: 'Held.' }),
        postFixture({ id: 'post_gone', conversationId: 'conv-deleted', body: 'Gone.' }),
      ],
    }),
  });
  const at = Date.parse('2026-09-21');
  const builder = (id: string, done: boolean, minutes: number) =>
    syntheticConversation(1, {
      id,
      kind: { t: 'builder' },
      done,
      createdAt: at + minutes * 60_000,
      activityAt: at + minutes * 60_000,
    });
  const rows = [
    builder('builder-open', false, 2),
    builder('builder-done', true, 3),
    syntheticConversation(2, { id: 'conv-held' }),
  ];
  jotaiStore.set(rowsAtom, new Map(rows.map((row) => [row.id, row])));
  try {
    const home = render(CHANNELS);
    assert.match(home, /mobile-channels-row__name[^"]*">New Buddy</);
    assert.equal(home.match(/Creating buddy<\/em>/g)?.length, 1, 'one setup row: the open one');
    assert.match(home, /aria-label="Archive Buddy setup"/);
    const channel = render(`${CHANNELS}?channel=ch_a`);
    // Only the post whose conversation the client holds gets the eye.
    assert.equal(channel.match(/aria-label="Open the conversation"/g)?.length, 1);
    assert.match(channel, /aria-label="Open the conversation" href="\/chat\/conv-held"/);
  } finally {
    jotaiStore.set(rowsAtom, new Map());
  }
});

// Regression guard: the Channels tab once opened the alphabetically first
// workspace (an empty one) instead of where the team was active.
test('the Channels tab opens the most recently active workspace first', async () => {
  const { overviewWorkspaces } = await import('../src/mobile/channels/ChannelsIndex');
  const ordered = overviewWorkspaces(
    [
      rosterFixture([], { id: 'a', name: 'alpha-empty' }),
      rosterFixture([], { id: 'u', name: 'unleashd' }),
    ],
    new Map([['u', Date.parse('2026-09-24T01:00:00.000Z')]])
  );
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ['u', 'a']
  );
});

// Feature audit 2026-09-26: the Task filter (one Task's posts across every
// channel) was desktop-only after the lean rewrite. Mobile had one until then,
// in the Buddy Mailbox channel reader (d382234: "on mobile the only Task filter
// over channel posts"). A desktop `?channel=&task=` link must open it on a
// phone too, and each post must link into its own channel.
test('the mobile Task page opens from a channel with details and links each post into its own channel', async () => {
  const ws = 'ws-phone-task';
  const base = `/buddies/workspaces/${ws}/channels`;
  await loadResource({
    key: '/api/buddies/overview',
    load: async () => [rosterFixture([lead], { id: ws, name: 'unleashd' })],
  });
  await loadResource({
    key: `/api/buddies/workspaces/${ws}/inbox`,
    load: async () =>
      inboxFixture([
        { channel: publicChannel('ch_gen', 'general', ws), unread: 0 },
        { channel: publicChannel('ch_ops', 'ops', ws), unread: 0 },
      ]),
  });
  await loadResource({
    key: `/api/buddies/tasks?workspaceId=${ws}`,
    load: async () => [
      {
        id: 'task-ship',
        workspaceId: ws,
        ownerId: 'lead',
        title: 'Ship channels',
        doneCriteria: 'Shipped',
        status: 'in_progress',
        paused: false,
        epoch: 1,
        evidence: [],
        position: 0,
        revision: 1,
        createdAt: '2026-09-24T00:00:00.000Z',
        updatedAt: '2026-09-24T00:00:00.000Z',
      },
    ],
  });
  await loadResource({ key: '/api/buddies/channels/ch_gen/responding', load: async () => [] });
  const aboutTask = postFixture({
    id: 'about-task',
    channelId: 'ch_gen',
    taskId: 'task-ship',
    body: 'Started on it.',
    createdAt: '2026-09-24T01:00:00.000Z',
  });
  await loadResource({
    key: '/api/buddies/channels/ch_gen/posts?limit=50',
    load: async () => ({ posts: [aboutTask] }),
  });
  await loadResource({
    key: '/api/buddies/tasks/task-ship/posts?limit=50',
    load: async () => ({
      posts: [
        postFixture({
          id: 'ops-reply',
          channelId: 'ch_ops',
          rootId: 'ops-root',
          taskId: 'task-ship',
          body: 'Deployed to staging.',
          createdAt: '2026-09-24T02:00:00.000Z',
        }),
        aboutTask,
      ],
    }),
  });

  const channel = render(`${base}?channel=ch_gen`);
  // The old header exposed Archive and “All posts” as permanent chrome; keep
  // Task filtering available inside settings without occupying the reading header.
  assert.match(channel, /aria-label="Channel description"/);
  assert.match(channel, /<details class="channel-header-settings">/);
  assert.match(channel, /ui-popover ui-popover--end ui-stack"><select/);
  assert.match(channel, /aria-label="Copy link to channel"/);
  assert.match(
    channel,
    /<select class="mobile-channel__task-filter ui-control" aria-label="Filter by Task"/
  );
  assert.match(channel, /<option value="task-ship">Task: Ship channels<\/option>/);

  const url = `${base}?channel=ch_gen&task=task-ship`;
  assert.deepEqual(channelsView(new URL(url, 'http://x').search), {
    kind: 'task',
    channelId: 'ch_gen',
    taskId: 'task-ship',
  });
  await loadResource({
    key: '/api/buddies/tasks/task-ship',
    load: async () => ({
      task: {
        id: 'task-ship',
        workspaceId: ws,
        ownerId: 'lead',
        title: 'Ship channels',
        doneCriteria: 'Shipped',
        status: 'in_progress',
        paused: false,
        epoch: 1,
        evidence: [],
        position: 0,
        pin: 0,
        revision: 1,
        createdAt: '2026-09-24T00:00:00.000Z',
        updatedAt: '2026-09-24T00:00:00.000Z',
      },
      channel: {
        ...publicChannel('task-channel', 'task', ws),
        kind: { type: 'task', taskId: 'task-ship' },
      },
      children: [],
      comments: [],
      runs: [],
    }),
  });
  const html = render(url);
  assert.match(html, /<h1 class="task-page-heading">Ship channels<\/h1>/);
  assert.match(html, /href="[^"]*view=home"/);
  assert.match(html, /Discussion/);
  assert.match(html, /Deployed to staging\./);
  assert.match(html, /Started on it\./);
  // The reply links to itself inside its thread in #ops, not into #general.
  assert.match(
    html,
    new RegExp(
      `href="${base}\\?channel=ch_ops&amp;thread=ops-root&amp;post=ops-reply"[^>]*>View in channel</a>`
    )
  );
});

test('archived channel links retain history and hide channel/thread composers on mobile', async () => {
  await seed();
  const channel = { ...publicChannel('ch_a', 'general', WS), archivedAt: '2026-09-27T00:00:00Z' };
  await loadResource({
    key: `/api/buddies/workspaces/${WS}/inbox`,
    load: async () => inboxFixture([]),
  });
  await loadResource({
    key: `/api/buddies/workspaces/${WS}/channels?archived=1`,
    load: async () => [channel],
  });
  const render = (search: string) =>
    renderToStaticMarkup(
      <Provider store={jotaiStore}>
        <MemoryRouter initialEntries={[`${CHANNELS}${search}`]}>
          <Routes>
            <Route path="/buddies/workspaces/:workspaceId/channels" element={<ChannelsMobile />} />
          </Routes>
        </MemoryRouter>
      </Provider>
    );
  const home = render('');
  assert.match(home, /Archived channels \(1\)/);
  assert.doesNotMatch(home, /<details>/);
  const page = render('?channel=ch_a');
  assert.match(page, /general/);
  assert.match(page, /Restore/);
  assert.doesNotMatch(page, /<textarea/);
  assert.doesNotMatch(render('?channel=ch_a&thread=post_root'), /<textarea/);
  assert.deepEqual(channelsView('?channel=ch_a&workers=lead'), {
    kind: 'workers',
    buddyId: 'lead',
  });
  assert.equal(isImmersiveChannelRoute(CHANNELS, '?workers=lead'), true);
});
