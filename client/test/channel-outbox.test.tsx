import assert from 'node:assert/strict';
import test from 'node:test';
import { Provider } from 'jotai';
import { renderToStaticMarkup } from 'react-dom/server';
import { outboxDrop, outboxSending, outboxSent } from '../src/atoms/channel-outbox';
import { jotaiStore } from '../src/atoms/store';
import { channelRows, useWithOutbox } from '../src/components/buddies/channel-data';
import type { Post } from '../src/components/buddies/types';
import { postFixture } from './fixtures/channel-posts';

// Send is optimistic (2026-09-25, owner: "a slow delay, it should be
// instant"): the owner's post renders from the outbox before the server
// returns it. The failure modes this guards are the ones a refactor of the
// merge would introduce silently: the message blinking out between the POST
// response and the refetch, or rendering twice once the refetch includes it.

function served(id: string, rootId: string | null): Post {
  return postFixture({
    id,
    channelId: 'channel',
    body: 'hello',
    createdAt: '2026-09-25T00:00:00.000Z',
    ...(rootId === null ? {} : { rootId }),
  });
}

function Feed({ rootId, posts }: { rootId: string | null; posts: readonly Post[] | null }) {
  const shown = useWithOutbox('channel', rootId, posts);
  return <>{shown === null ? 'loading' : shown.map((post) => post.id).join(',')}</>;
}

const render = (rootId: string | null, posts: readonly Post[] | null) =>
  renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <Feed rootId={rootId} posts={posts} />
    </Provider>
  );

test('an owner post shows from Send until the server feed carries it, exactly once', () => {
  outboxSending({
    kind: 'sending',
    key: 'k1',
    channelId: 'channel',
    rootId: null,
    body: 'hello',
    createdAt: '2026-09-25T00:00:00.000Z',
  });
  assert.equal(render(null, []), 'outbox:k1', 'visible while the POST is in flight');
  assert.equal(render('root', []), '', 'a channel post never leaks into a thread');

  outboxSent('k1', served('post_1', null));
  assert.equal(render(null, []), 'post_1', 'still visible before the refetch lands');
  assert.equal(render(null, [served('post_1', null)]), 'post_1', 'never twice');
  assert.equal(render(null, null), 'loading', 'an unloaded feed stays unloaded');

  outboxDrop(new Set(['k1']));
  assert.equal(render(null, []), '');
});

// Posts written in one millisecond share createdAt; sorting by it read them back shuffled
// (2026-09-25). The transcript orders by the server's time-ordered id instead.
test('a channel transcript orders same-millisecond posts by their ordered id', () => {
  const at = '2026-09-25T10:00:00.000Z';
  const newestFirst = ['0199-c', '0199-b', '0199-a'].map((ord) =>
    postFixture({ id: `post_${ord}`, createdAt: at, ord })
  );
  const order = channelRows(newestFirst).flatMap((row) =>
    row.kind === 'day' ? [] : [row.post.ord]
  );
  assert.deepEqual(order, ['0199-a', '0199-b', '0199-c']);
});
