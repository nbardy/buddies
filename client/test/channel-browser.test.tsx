import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Channel, Post } from '../src/components/buddies/types';
import { CODEX_INSTALLED, buddyFixture, rosterFixture } from './fixtures/buddy-roster';
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
const { ChannelBrowser, WorkspaceSlack } = await import('../src/components/buddies/ChannelBrowser');
const { channelRows, workspaceDirectory } = await import('../src/components/buddies/channel-data');
const { Provider } = await import('jotai');
const { jotaiStore } = await import('../src/atoms/store');
const { loadResource } = await import('../src/atoms/resources');
const { rowsAtom } = await import('../src/atoms/conversations');
const { syntheticConversation } = await import('./fixtures/synthetic-conversations');

const lead = buddyFixture({ id: 'lead', name: 'Lead', role: 'Own the work' });
const dev = buddyFixture({ id: 'dev', name: 'Dev', role: 'Build the work' });

function render(workspaceId: string, directory: ReturnType<typeof workspaceDirectory>, url = '/') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Provider store={jotaiStore}>
        <ChannelBrowser
          workspaceId={workspaceId}
          directory={directory}
          availableConversationIds={new Set(['conv-aaaa111122223333'])}
        />
      </Provider>
    </MemoryRouter>
  );
}

async function seedSlack() {
  await loadResource({
    key: '/api/buddies/workspaces/ws-slack/inbox',
    load: async () =>
      inboxFixture([{ channel: publicChannel('ch_a', 'Standups', 'ws-slack'), unread: 0 }]),
  });
  await loadResource({
    key: '/api/buddies/channels/ch_a/posts?limit=50',
    load: async () => ({
      posts: [
        postFixture({
          id: 'post_new',
          author: { kind: 'buddy', id: 'dev' },
          purpose: 'handoff',
          body: 'Newer handoff without a live thread.',
          createdAt: '2026-09-21T03:00:00.000Z',
        }),
        postFixture({
          id: 'post_old',
          author: { kind: 'buddy', id: 'lead' },
          purpose: 'standup',
          body: 'Older update from the first run.',
          conversationId: 'conv-aaaa111122223333',
          createdAt: '2026-09-21T01:00:00.000Z',
        }),
      ],
    }),
  });
}

const slackDirectory = () =>
  workspaceDirectory(
    [rosterFixture([lead, dev], { id: 'ws-slack', name: 'unleashd' })],
    'ws-slack',
    [],
    CODEX_INSTALLED
  );

test('channel browser renders a Slack transcript, oldest first, with instance tags', async () => {
  await seedSlack();
  const html = render('ws-slack', slackDirectory(), '/?channel=ch_a');
  assert.match(html, /<h1>unleashd<\/h1>/);
  assert.match(html, /aria-label="Search all channel messages"/);
  assert.match(html, /channel-browser-channel-name[^"]*">Standups</);
  const newerAt = html.indexOf('Newer handoff without a live thread.');
  const olderAt = html.indexOf('Older update from the first run.');
  assert.ok(newerAt !== -1 && olderAt !== -1, 'all posts render');
  assert.ok(olderAt < newerAt, 'transcript reads oldest-first, newest at the bottom');
  // A held thread is a link; a post without provenance carries no instance tag.
  assert.match(html, /href="\/chat\/conv-aaaa111122223333"[^>]*>conv conv-aaa</);
  assert.equal(html.match(/channel-browser-instance/g)?.length, 1);
});

// Regression guard for the instance-uuid feature: two conversations running
// as the SAME Buddy must never collapse into one sender group, or the reader
// loses which instance said what.
test('concurrent conversations of one Buddy start separate message groups', () => {
  const post = (id: string, conversation: string, minute: number): Post =>
    postFixture({
      id,
      author: { kind: 'buddy', id: 'lead' },
      conversationId: conversation,
      createdAt: new Date(Date.UTC(2026, 8, 21, 12, minute)).toISOString(),
    });
  const kinds = (posts: Post[]) =>
    channelRows(posts)
      .filter((row) => row.kind !== 'day')
      .map((row) => row.kind);
  assert.deepEqual(
    kinds([post('c', 'conv-one', 2), post('b', 'conv-two', 1), post('a', 'conv-one', 0)]),
    ['lead', 'lead', 'lead']
  );
  assert.deepEqual(kinds([post('b', 'conv-one', 1), post('a', 'conv-one', 0)]), [
    'lead',
    'continuation',
  ]);
});

test('workspace slack page resolves the workspace name and member names from the overview', async () => {
  await seedSlack();
  await loadResource({
    key: '/api/buddies/overview',
    load: async () => [rosterFixture([lead, dev], { id: 'ws-slack', name: 'unleashd' })],
  });
  await loadResource({ key: '/api/buddies/tasks?workspaceId=ws-slack', load: async () => [] });
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/buddies/workspaces/ws-slack/channels?channel=ch_a']}>
      <Provider store={jotaiStore}>
        <Routes>
          <Route path="/buddies/workspaces/:workspaceId/channels" element={<WorkspaceSlack />} />
        </Routes>
      </Provider>
    </MemoryRouter>
  );
  assert.match(html, /<h1>unleashd<\/h1>/);
  assert.match(html, /Older update from the first run./);
  assert.match(html, /channel-browser-author[^>]*>Lead</);
  // Like Slack, a post author's name opens the DM, not the Buddy page.
  assert.match(html, /<button[^>]*class="channel-browser-author"[^>]*title="Message Lead"/);
  assert.doesNotMatch(html, /<a[^>]*class="channel-browser-author"/);
});

test('channel browser shows an empty state without channels', async () => {
  await loadResource({
    key: '/api/buddies/workspaces/ws-bare/inbox',
    load: async () => inboxFixture([]),
  });
  const html = render('ws-bare', workspaceDirectory([], 'ws-bare', [], CODEX_INSTALLED));
  assert.match(html, /No channels yet/);
});

test('channel home keeps archived channels out of the rail and in the scrollable directory', async () => {
  const archived = {
    ...publicChannel('ch_archived', 'old-work', 'ws-archive'),
    archivedAt: '2026-09-27T00:00:00Z',
  };
  await loadResource({
    key: '/api/buddies/workspaces/ws-archive/inbox',
    load: async () =>
      inboxFixture([{ channel: publicChannel('ch_active', 'general', 'ws-archive'), unread: 0 }]),
  });
  await loadResource({
    key: '/api/buddies/workspaces/ws-archive/channels/archived',
    load: async () => [archived],
  });
  const html = render(
    'ws-archive',
    workspaceDirectory(
      [rosterFixture([lead], { id: 'ws-archive', name: 'archive' })],
      'ws-archive',
      [],
      CODEX_INSTALLED
    )
  );
  const rail = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  assert.doesNotMatch(rail, /Archived channels/);
  assert.match(html, /aria-label="Home"/);
  assert.match(html, /Archived channels \(1\)/);
  assert.match(html, /href="\/buddies\/workspaces\/ws-archive\/channels\?channel=ch_archived/);
  assert.doesNotMatch(html, /<details>/);
});

// The body is markdown with app links: an owner mention, a live Task chip and
// inline media must each render as their own element — a regression to plain
// text would show raw `[@Lead](buddy:lead)` tokens and absolute file paths.
// The inbox can still contain direct channels for deep links, but the rail
// presents the Buddy's ongoing DM row instead of duplicating that channel.
test('posts render markdown mentions, Task chips and media; the rail keeps one Buddy list', async () => {
  const dm: Channel = {
    id: 'ch_dm',
    workspaceId: 'ws-rich',
    kind: { type: 'direct', members: [{ kind: 'owner' }, { kind: 'buddy', id: 'lead' }] },
    createdBy: { kind: 'owner' },
    createdAt: '2026-09-23T00:00:00.000Z',
  };
  await loadResource({
    key: '/api/buddies/workspaces/ws-rich/inbox',
    load: async () =>
      inboxFixture(
        [
          { channel: publicChannel('ch_rich', 'general', 'ws-rich'), unread: 1 },
          { channel: dm, unread: 1 },
        ],
        [
          postFixture({
            id: 'ask',
            channelId: 'ch_dm',
            author: { kind: 'buddy', id: 'lead' },
            request: { state: 'awaiting' },
          }),
        ]
      ),
  });
  await loadResource({
    key: '/api/buddies/channels/ch_rich/posts?limit=50',
    load: async () => ({
      posts: [
        postFixture({
          id: 'post_ask',
          channelId: 'ch_rich',
          body: '[@Lead](buddy:lead) is [Ship channels](task:task-ship) done?\n\n![login](/Users/me/.agent-viewer/uploads/channels/ch_rich/abc.png)\n![demo](/Users/me/.agent-viewer/uploads/channels/ch_rich/def.mp4)',
          createdAt: '2026-09-23T01:00:00.000Z',
        }),
      ],
    }),
  });
  await loadResource({ key: '/api/buddies/channels/ch_rich/responding', load: async () => [] });
  const gone = buddyFixture({ id: 'gone', name: 'Gone', status: 'archived' });
  const directory = workspaceDirectory(
    [rosterFixture([lead, gone], { id: 'ws-rich', name: 'rich' })],
    'ws-rich',
    [
      {
        id: 'task-ship',
        workspaceId: 'ws-rich',
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
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:30:00.000Z',
      },
    ],
    CODEX_INSTALLED
  );
  const html = render('ws-rich', directory, '/?channel=ch_rich');
  assert.match(html, /class="channel-browser-author">You</);
  assert.match(html, /<a class="channel-mention" href="\/buddies\/lead"[^>]*>@Lead<\/a>/);
  assert.doesNotMatch(html, /buddy:lead/);
  // Live chip: in-progress tone; a click opens the Task overlay in place (493c1c7).
  assert.match(html, /<button[^>]*class="channel-task-chip" data-tone="active"/);
  // Local media goes through the authenticated file route; .mp4 is a player.
  assert.match(
    html,
    /<img class="channel-media" src="\/api\/files\?path=%2FUsers%2Fme%2F[^"]*abc\.png"/
  );
  assert.match(html, /<video class="channel-media" src="\/api\/files\?path=[^"]*def\.mp4"/);
  // The composer posts to this channel; archived Buddies stay out of the rail.
  assert.match(html, /placeholder="Message #general"/);
  assert.match(html, /channel-browser-buddies/);
  assert.doesNotMatch(html, />Gone</);
  // Direct channel rows are no longer duplicated above the Buddy list.
  assert.doesNotMatch(html, /Direct messages/);
  assert.match(html, /class="channel-browser-buddy-link"[^>]*aria-label="Message Lead"/);
  assert.match(html, /data-unread="new"/);
});

// A channel and a thread each open on their newest page, with the flame above
// it while the page says older posts remain (`next`), and a thread keeps its
// root on top.
test('the channel and thread panes open on their newest page and page back', async () => {
  const post = (id: string, minute: number, overrides: Partial<Post> = {}) =>
    postFixture({
      id,
      channelId: 'ch_long',
      author: { kind: 'buddy', id: 'lead' },
      createdAt: new Date(Date.UTC(2026, 8, 24, 9, minute)).toISOString(),
      ...overrides,
    });
  // A full page, newest-first, with a cursor: more sits before it.
  const fullPage = (prefix: string, overrides: Partial<Post>) => ({
    posts: Array.from({ length: 50 }, (_, index) =>
      post(`${prefix}-${49 - index}`, 200 - index, overrides)
    ),
    next: { createdAt: '2026-09-24T09:10:00.000Z', id: `${prefix}-0` },
  });
  await loadResource({
    key: '/api/buddies/workspaces/ws-long/inbox',
    load: async () =>
      inboxFixture([{ channel: publicChannel('ch_long', 'general', 'ws-long'), unread: 0 }]),
  });
  await loadResource({
    key: '/api/buddies/channels/ch_long/posts?limit=50',
    load: async () => fullPage('top', {}),
  });
  await loadResource({
    key: '/api/buddies/posts/root/thread?limit=50',
    load: async () => ({ root: post('root', 1), ...fullPage('reply', { rootId: 'root' }) }),
  });
  await loadResource({ key: '/api/buddies/channels/ch_long/responding', load: async () => [] });
  const html = render(
    'ws-long',
    workspaceDirectory([rosterFixture([lead], { id: 'ws-long' })], 'ws-long', [], CODEX_INSTALLED),
    '/?channel=ch_long&thread=root'
  );
  const [channelPane, threadPane = ''] = html.split('aria-label="Thread"');
  const inOrder = (pane: string, needles: string[]) => {
    const at = needles.map((needle) => pane.indexOf(needle));
    assert.deepEqual(
      needles.filter((_, index) => at[index] === -1),
      [],
      'missing from the pane'
    );
    assert.deepEqual(
      at,
      [...at].sort((a, b) => a - b),
      `out of order: ${needles.join(' < ')}`
    );
  };
  const flame = 'class="channel-history"';
  inOrder(channelPane, [flame, 'Body of top-0.', 'Body of top-49.']);
  inOrder(threadPane, ['Body of root.', flame, 'Body of reply-0.', 'Body of reply-49.']);
});

// 493c1c7: the rail had no way to start a Buddy, a running Builder chat vanished from Channels,
// and a posted reply gave no way into the conversation that wrote it.
test('the rail starts and lists a Buddy setup chat; a held post offers its conversation', async () => {
  await seedSlack();
  const at = Date.parse('2026-09-21');
  const builder = (id: string, done: boolean, minutes: number) =>
    syntheticConversation(1, {
      id,
      kind: { t: 'builder' },
      done,
      createdAt: at + minutes * 60_000,
      activityAt: at + minutes * 60_000,
    });
  jotaiStore.set(
    rowsAtom,
    new Map(
      [
        builder('builder-new', false, 2),
        builder('builder-old', false, 1),
        builder('builder-done', true, 3),
        syntheticConversation(2, { id: 'conv-aaaa111122223333' }),
      ].map((row) => [row.id, row])
    )
  );
  try {
    const html = render('ws-slack', slackDirectory(), '/?channel=ch_a');
    assert.match(html, /aria-label="New Buddy"/);
    assert.equal(
      html.match(/Continue Creating buddy/g)?.length,
      1,
      'one setup row: the newest open'
    );
    assert.match(html, /<button[^>]*aria-label="Continue Creating buddy"/);
    // Only the post whose conversation the client holds gets the eye.
    assert.equal(
      html.match(/aria-label="Open the conversation" href="\/chat\/conv-aaaa111122223333"/g)
        ?.length,
      1
    );
  } finally {
    jotaiStore.set(rowsAtom, new Map());
  }
});
