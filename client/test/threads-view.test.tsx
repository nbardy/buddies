import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { FollowedThread, Post } from '../src/components/buddies/types';
import { CODEX_INSTALLED, buddyFixture, rosterFixture } from './fixtures/buddy-roster';
import { postFixture, publicChannel } from './fixtures/channel-posts';
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { holdThreads, threadsUrl } = await import('../src/components/buddies/threads-view');
const { ThreadsPane } = await import('../src/components/buddies/ThreadsPane');
const { workspaceDirectory } = await import('../src/components/buddies/channel-data');
const { Provider } = await import('jotai');
const { jotaiStore } = await import('../src/atoms/store');
const { loadResource } = await import('../src/atoms/resources');

const lead = { kind: 'buddy', id: 'lead' } as const;
const reply = (id: string, at: string, author: Post['author'] = lead) =>
  postFixture({ id, rootId: `root-${id[0]}`, author, createdAt: `2026-09-28T0${at}:00:00.000Z` });

function thread(
  root: string,
  replies: number,
  tail: FollowedThread['tail'],
  channel = publicChannel('ch_a', 'general')
): FollowedThread {
  return {
    channel,
    root: postFixture({ id: root, channelId: channel.id }),
    replies,
    participants: [{ kind: 'owner' }, lead],
    tail,
  };
}

// THREADS_VIEW_2026-09-28.md §2: cards never move, shrink or un-tint under the reader.
test('a read card keeps its place, its replies and its tint while the server re-sorts', () => {
  const a1 = reply('a1', '1');
  const b1 = reply('b1', '2');
  const first = holdThreads(
    null,
    [
      thread('root-a', 1, { kind: 'unread', hidden: 0, posts: [a1] }),
      thread('root-b', 5, { kind: 'caught_up', hidden: 4, posts: [b1] }),
    ],
    false
  );
  assert.deepEqual(
    first.cards.map((card) => card.thread.root.id),
    ['root-a', 'root-b']
  );
  assert.equal(first.newReplies, 1);

  // The owner read `a`: the server now sorts it below `b` and sends its tail as caught up.
  const read = holdThreads(
    first.held,
    [
      thread('root-b', 5, { kind: 'caught_up', hidden: 4, posts: [b1] }),
      thread('root-a', 1, { kind: 'caught_up', hidden: 0, posts: [a1] }),
    ],
    false
  );
  assert.deepEqual(
    read.cards.map((card) => card.thread.root.id),
    ['root-a', 'root-b'],
    'reading never re-sorts'
  );
  assert.equal(read.updated, 0, 'reading is not an update');
  assert.ok(read.cards[0].unread.has('a1'), 'the tint outlives the read mark');

  // A Buddy replies in the lower card: it grows in place and the pill offers the re-sort.
  const b2 = reply('b2', '3');
  const grown = holdThreads(
    read.held,
    [
      thread('root-b', 6, { kind: 'unread', hidden: 5, posts: [b2] }),
      thread('root-a', 1, { kind: 'caught_up', hidden: 0, posts: [a1] }),
    ],
    false
  );
  assert.deepEqual(
    grown.cards.map((card) => card.thread.root.id),
    ['root-a', 'root-b']
  );
  assert.equal(grown.updated, 1);
  assert.deepEqual(
    grown.cards[1].posts.map((post) => post.id),
    ['b1', 'b2'],
    'the card never shrinks'
  );
  assert.equal(grown.cards[1].hidden, 4, 'six replies, two shown');

  const resorted = holdThreads(
    grown.held,
    [
      thread('root-b', 6, { kind: 'unread', hidden: 5, posts: [b2] }),
      thread('root-a', 1, { kind: 'caught_up', hidden: 0, posts: [a1] }),
    ],
    true
  );
  assert.deepEqual(
    resorted.cards.map((card) => card.thread.root.id),
    ['root-b', 'root-a']
  );
  assert.equal(resorted.updated, 0);
});

test("the owner's own reply from a card is not an update", () => {
  const a1 = reply('a1', '1');
  const first = holdThreads(
    null,
    [thread('root-a', 1, { kind: 'caught_up', hidden: 0, posts: [a1] })],
    false
  );
  const mine = reply('a2', '2', { kind: 'owner' });
  const after = holdThreads(
    first.held,
    [thread('root-a', 2, { kind: 'caught_up', hidden: 0, posts: [a1, mine] })],
    false
  );
  assert.equal(after.updated, 0);
});

test('the Threads pane renders the fold, tinted new replies and a real thread link', async () => {
  const general = publicChannel('ch_a', 'general', 'ws-threads');
  await loadResource({
    key: threadsUrl('ws-threads', 30),
    load: async () => ({
      threads: [
        thread(
          'root-a',
          4,
          { kind: 'unread', hidden: 2, posts: [reply('a3', '3'), reply('a4', '4')] },
          general
        ),
      ],
      more: false,
    }),
  });
  await loadResource({ key: '/api/buddies/channels/ch_a/responding', load: async () => [] });
  const directory = workspaceDirectory(
    [rosterFixture([buddyFixture({ id: 'lead', name: 'Lead' })], { id: 'ws-threads' })],
    'ws-threads',
    [],
    CODEX_INSTALLED
  );
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Provider store={jotaiStore}>
        <ThreadsPane
          workspaceId="ws-threads"
          directory={directory}
          availableConversationIds={new Set()}
          openDm={() => {}}
        />
      </Provider>
    </MemoryRouter>
  );
  assert.match(html, /View 2 previous replies/);
  assert.match(html, /2 new replies/);
  assert.equal(html.match(/data-unread="true"/g)?.length, 2, 'the two new replies, not the root');
  assert.match(
    html,
    /href="\/buddies\/workspaces\/ws-threads\/channels\?channel=ch_a&amp;thread=root-a"/
  );
  assert.match(html, /Lead and you/);
});
