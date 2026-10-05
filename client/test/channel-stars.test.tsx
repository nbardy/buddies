import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { Provider } from 'jotai';
import { renderToStaticMarkup } from 'react-dom/server';
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
const { channelRailFamily } = await import('../src/atoms/channel-rail');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { starredChannelIdsAtom, toggleChannelStar } = await import('../src/atoms/ui');
const { ChannelStar } = await import('../src/components/buddies/ChannelStar');

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
