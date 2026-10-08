// Channel features the T11 client migration dropped and T22 restored, each
// rendered through the real ChannelBrowser against seeded route responses.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type {
  ChannelResponse,
  ChannelUnread,
  Post,
  ThreadStat,
} from '../src/components/buddies/types';
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
const { ChannelBrowser } = await import('../src/components/buddies/ChannelBrowser');
const { workspaceDirectory } = await import('../src/components/buddies/channel-data');
const { Provider } = await import('jotai');
const { jotaiStore } = await import('../src/atoms/store');
const { loadResource } = await import('../src/atoms/resources');

const lead = buddyFixture({ id: 'lead', name: 'Lead' });

const at = (minute: number) => new Date(Date.UTC(2026, 8, 25, 9, minute)).toISOString();
const post = (id: string, minute: number, overrides: Partial<Post> = {}) =>
  postFixture({ id, author: { kind: 'buddy', id: 'lead' }, createdAt: at(minute), ...overrides });
const stat = (root: Post, replies: number, last: Post): ThreadStat => ({
  rootId: root.id,
  replies,
  lastReplyAt: last.createdAt,
  lastReplyOrd: last.ord,
  lastReplyAuthor: last.author,
});

/** Seeds one workspace with one channel and renders the browser at `url`. */
async function renderChannel(opts: {
  ws: string;
  entry: Omit<ChannelUnread, 'channel'>;
  posts: Post[];
  threads?: ThreadStat[];
  url?: string;
  responding?: ChannelResponse[];
}) {
  const channelId = `ch_${opts.ws}`;
  await loadResource({
    key: `/api/buddies/workspaces/${opts.ws}/inbox`,
    load: async () =>
      inboxFixture([{ channel: publicChannel(channelId, 'general', opts.ws), ...opts.entry }]),
  });
  await loadResource({
    key: `/api/buddies/channels/${channelId}/posts?limit=50`,
    load: async () => ({
      posts: opts.posts.map((p) => ({ ...p, channelId })),
      threads: opts.threads ?? [],
    }),
  });
  await loadResource({
    key: `/api/buddies/channels/${channelId}/responding`,
    load: async () => opts.responding ?? [],
  });
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[opts.url ?? `/?channel=${channelId}`]}>
      <Provider store={jotaiStore}>
        <ChannelBrowser
          workspaceId={opts.ws}
          directory={workspaceDirectory(
            [rosterFixture([lead], { id: opts.ws })],
            opts.ws,
            [],
            CODEX_INSTALLED
          )}
          availableConversationIds={new Set()}
        />
      </Provider>
    </MemoryRouter>
  );
}

/** The markup of one post's row, from its `<li>` to the next row. */
function rowOf(html: string, postId: string): string {
  const start = html.indexOf(`data-post-id="${postId}"`);
  assert.notEqual(start, -1, `row ${postId} renders`);
  const end = html.indexOf('<li', start);
  return html.slice(start, end === -1 ? undefined : end);
}

// Feature 1: the channel page carries each root's reply stats beside the
// posts (`threads`); a root with replies says how many and when the last one
// landed, a root without replies shows no thread line at all.
test('channel rows show reply counts and the last reply time', async () => {
  const busy = post('busy', 1);
  const single = post('single', 2);
  const quiet = post('quiet', 3);
  const html = await renderChannel({
    ws: 'ws-counts',
    entry: { unread: 0 },
    posts: [quiet, single, busy],
    threads: [
      stat(busy, 3, post('r3', 30, { rootId: 'busy' })),
      stat(single, 1, post('r1', 20, { rootId: 'single' })),
    ],
  });
  assert.match(rowOf(html, 'busy'), /<strong>3 replies<\/strong><span>Last reply [^<]+<\/span>/);
  assert.match(rowOf(html, 'single'), /<strong>1 reply<\/strong>/);
  assert.doesNotMatch(rowOf(html, 'quiet'), /channel-browser-thread-summary/);
});

// Feature 2: the inbox's read cursor (`lastReadOrd`) places "New messages"
// above the oldest post someone else wrote after it, and bolds the threads
// whose newest reply by someone else landed after it. The owner's own posts
// and replies never count as new.
test('the New messages line and bold threads follow the read cursor', async () => {
  const read = post('read', 1);
  const mark = post('mark', 2);
  const mine = post('mine', 3, { author: { kind: 'owner' } });
  const fresh = post('fresh', 4);
  const newest = post('newest', 5);
  const html = await renderChannel({
    ws: 'ws-unread',
    entry: { unread: 2, lastReadOrd: mark.ord },
    posts: [newest, fresh, mine, mark, read],
    threads: [
      stat(read, 2, post('from-lead', 10, { rootId: 'read' })),
      stat(mark, 1, post('from-me', 11, { rootId: 'mark', author: { kind: 'owner' } })),
      stat(mine, 1, post('seen', 1, { rootId: 'mine' })),
    ],
  });
  assert.equal(html.match(/aria-label="New messages"/g)?.length, 1);
  const line = html.indexOf('aria-label="New messages"');
  assert.ok(html.indexOf('data-post-id="mine"') < line, 'the owner post after the mark is not new');
  assert.ok(line < html.indexOf('data-post-id="fresh"'), 'the line sits above the first new post');
  assert.match(rowOf(html, 'read'), /data-unread="true"/);
  assert.doesNotMatch(rowOf(html, 'mark'), /data-unread/);
  assert.doesNotMatch(rowOf(html, 'mine'), /data-unread/);
});

// Feature 3: a reply permalink asks the thread page FROM the reply, so a reply
// older than the newest page still renders, highlighted, under its root.
test('a reply permalink opens the desktop thread on the linked reply', async () => {
  const root = post('root', 1);
  await loadResource({
    key: '/api/buddies/posts/root/thread?limit=50&from=old-reply',
    load: async () => ({
      root,
      posts: [post('newer', 9, { rootId: 'root' }), post('old-reply', 2, { rootId: 'root' })],
    }),
  });
  const html = await renderChannel({
    ws: 'ws-link',
    entry: { unread: 0 },
    posts: [root],
    url: '/?channel=ch_ws-link&thread=root&post=old-reply',
  });
  const thread = html.slice(html.indexOf('aria-label="Thread"'));
  assert.match(thread, /data-post-id="old-reply" data-linked="true"/);
  assert.ok(thread.indexOf('Body of root.') < thread.indexOf('Body of old-reply.'));
});

// Feature 4: `?task=` swaps the channel transcript for one Task's posts across
// every channel. Each row names its channel and links to the post there (a
// reply's link opens its thread). The route opens the full task page.
test('the Task filter shows one Task across channels, each post linked into its channel', async () => {
  const ws = 'ws-task';
  await loadResource({
    key: `/api/buddies/workspaces/${ws}/inbox`,
    load: async () =>
      inboxFixture([
        { channel: publicChannel('ch_main', 'general', ws), unread: 0 },
        { channel: publicChannel('ch_ops', 'ops', ws), unread: 0 },
      ]),
  });
  await loadResource({
    key: '/api/buddies/channels/ch_main/posts?limit=50',
    load: async () => ({
      posts: [
        post('about-task', 2, { channelId: 'ch_main', taskId: 'task-ship' }),
        post('unrelated', 1, { channelId: 'ch_main', body: 'Only in general.' }),
      ],
      threads: [],
    }),
  });
  await loadResource({ key: '/api/buddies/channels/ch_main/responding', load: async () => [] });
  await loadResource({
    key: '/api/buddies/tasks/task-ship/posts?limit=50',
    load: async () => ({
      posts: [
        post('ops-reply', 4, { channelId: 'ch_ops', rootId: 'ops-root', taskId: 'task-ship' }),
        post('about-task', 2, { channelId: 'ch_main', taskId: 'task-ship' }),
      ],
    }),
  });
  const task = {
    id: 'task-ship',
    workspaceId: ws,
    ownerId: 'lead',
    title: 'Ship channels',
    doneCriteria: 'Shipped',
    status: 'in_progress' as const,
    paused: false,
    epoch: 1,
    evidence: [],
    position: 0,
    pin: 0,
    revision: 1,
    createdAt: at(0),
    updatedAt: at(0),
  };
  await loadResource({
    key: '/api/buddies/tasks/task-ship',
    load: async () => ({
      task,
      children: [],
      comments: [],
      runs: [],
      channel: {
        ...publicChannel('task-channel', 'task', ws),
        kind: { type: 'task', taskId: task.id },
      },
    }),
  });
  const directory = workspaceDirectory(
    [rosterFixture([lead], { id: ws })],
    ws,
    [task],
    CODEX_INSTALLED
  );
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/?channel=ch_main&task=task-ship']}>
      <Provider store={jotaiStore}>
        <ChannelBrowser
          workspaceId={ws}
          directory={directory}
          availableConversationIds={new Set()}
        />
      </Provider>
    </MemoryRouter>
  );
  assert.match(html, /aria-label="Task details"/);
  assert.match(html, /Ship channels/);
  assert.doesNotMatch(html, /Only in general\./, 'the channel transcript is replaced');
  const channels = `/buddies/workspaces/${ws}/channels`;
  assert.match(
    rowOf(html, 'ops-reply'),
    new RegExp(
      `href="${channels}\\?channel=ch_ops&amp;thread=ops-root&amp;post=ops-reply"[^>]*>View in channel<`
    )
  );
  assert.match(
    rowOf(html, 'about-task'),
    new RegExp(
      `href="${channels}\\?channel=ch_main&amp;thread=about-task&amp;post=about-task"[^>]*>View in channel<`
    )
  );
});

test('channel waiting labels distinguish a busy turn, a full pool and an older backend', async () => {
  for (const [waiting, expected] of [
    [{ kind: 'conversation_busy' }, 'answering after its current turn ends'],
    [{ kind: 'pool_full', active: 5, max: 5 }, 'queued at the run limit (5/5)'],
    [undefined, 'queued…'],
  ] as const) {
    const root = post('root', 1);
    const html = await renderChannel({
      ws: `ws-waiting-${waiting?.kind ?? 'old'}`,
      entry: { unread: 0 },
      posts: [root],
      responding: [
        {
          channelId: 'fixture',
          threadRootId: root.id,
          buddyId: lead.id,
          startedAt: root.createdAt,
          state: 'queued',
          waiting,
        },
      ],
    });
    assert.ok(html.includes(expected), html);
    if (waiting?.kind !== 'pool_full') assert.ok(!html.includes('run limit'));
  }
});
