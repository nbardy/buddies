import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { Provider } from 'jotai';
import { renderToStaticMarkup } from 'react-dom/server';
import { buddyFixture } from './fixtures/buddy-roster';
import { inboxFixture, publicChannel } from './fixtures/channel-posts';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { buddyRailFamily, channelRailFamily } = await import('../src/atoms/channel-rail');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { starredBuddyIdsAtom, toggleBuddyStar, starredChannelIdsAtom, toggleChannelStar } =
  await import('../src/atoms/ui');
const { BuddyStar, ChannelStar } = await import('../src/components/buddies/ChannelStar');

test('channel stars partition the cached rail without losing unread counts or changing other workspaces', async () => {
  const original = jotaiStore.get(starredChannelIdsAtom);
  const rows = ['alpha', 'beta', 'gamma'].map((name, unread) => ({
    channel: publicChannel(`star-${name}`, name, 'stars-ws'),
    unread,
  }));
  await loadResource({
    key: '/api/buddies/workspaces/stars-ws/inbox',
    load: async () => inboxFixture(rows),
  });
  await loadResource({
    key: '/api/buddies/workspaces/stars-other/inbox',
    load: async () =>
      inboxFixture([{ channel: publicChannel('other', 'other', 'stars-other'), unread: 3 }]),
  });
  const rail = () => jotaiStore.get(channelRailFamily('stars-ws')).channels;
  const renderStar = () =>
    renderToStaticMarkup(
      <Provider store={jotaiStore}>
        <ChannelStar channelId="star-gamma" name="gamma" />
      </Provider>
    );
  try {
    jotaiStore.set(starredChannelIdsAtom, []);
    assert.match(renderStar(), /aria-label="Star #gamma"[^>]*aria-pressed="false"/);
    toggleChannelStar('star-gamma');
    assert.deepEqual(
      rail().map((row) => row.channel.id),
      ['star-gamma', 'star-alpha', 'star-beta']
    );
    assert.equal(rail()[0], rows[2]);
    assert.match(renderStar(), /aria-label="Unstar #gamma"[^>]*aria-pressed="true"/);
    toggleChannelStar('star-beta');
    assert.deepEqual(
      rail().map((row) => row.channel.id),
      ['star-beta', 'star-gamma', 'star-alpha']
    );
    assert.deepEqual(
      jotaiStore.get(channelRailFamily('stars-other')).channels.map((row) => row.channel.id),
      ['other']
    );
    toggleChannelStar('star-gamma');
    toggleChannelStar('star-beta');
    assert.deepEqual(rail(), rows);
  } finally {
    jotaiStore.set(starredChannelIdsAtom, original);
  }
});

test('Buddy stars move only directory members first and expose pressed state', async () => {
  const original = jotaiStore.get(starredBuddyIdsAtom);
  const members = ['alpha', 'beta', 'gamma'].map((name) =>
    buddyFixture({ id: name, name, workspaceId: 'buddy-stars-ws' })
  );
  const other = [buddyFixture({ id: 'other', name: 'Other' })];
  const rail = () => jotaiStore.get(buddyRailFamily(members));
  const renderStar = () =>
    renderToStaticMarkup(
      <Provider store={jotaiStore}>
        <BuddyStar buddyId="gamma" name="gamma" />
      </Provider>
    );
  try {
    jotaiStore.set(starredBuddyIdsAtom, []);
    assert.match(renderStar(), /aria-label="Star gamma"[^>]*aria-pressed="false"/);
    toggleBuddyStar('gamma');
    toggleBuddyStar('absent');
    assert.deepEqual(
      rail().map((buddy) => buddy.id),
      ['gamma', 'alpha', 'beta']
    );
    assert.equal(rail()[0], members[2]);
    assert.match(renderStar(), /aria-label="Unstar gamma"[^>]*aria-pressed="true"/);
    assert.deepEqual(
      jotaiStore.get(buddyRailFamily(other)).map((buddy) => buddy.id),
      ['other']
    );
    toggleBuddyStar('gamma');
    assert.deepEqual(rail(), members);
  } finally {
    jotaiStore.set(starredBuddyIdsAtom, original);
  }
});
