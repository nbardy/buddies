import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { Provider } from 'jotai';
import { renderToStaticMarkup } from 'react-dom/server';
import { CODEX_INSTALLED } from './fixtures/buddy-roster';
import { postFixture } from './fixtures/channel-posts';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { ChannelPostContent } = await import('../src/components/buddies/ChannelPostContent');
const { workspaceDirectory } = await import('../src/components/buddies/channel-data');

const directory = workspaceDirectory([], 'ws-1', [], CODEX_INSTALLED);
const render = (post: Parameters<typeof ChannelPostContent>[0]['post']) =>
  renderToStaticMarkup(
    <Provider>
      <ChannelPostContent post={post} directory={directory} />
    </Provider>
  );

// Fix-guard: a Threads card holds a PREVIEW of a long post (server clipFollowedThreads). Its Edit
// button would open the composer on the clipped text, and Save would overwrite the post with it.
test('a clipped post offers the full message and no Edit; a whole post offers Edit', () => {
  const owner = postFixture({ id: 'p1', author: { kind: 'owner' }, body: 'preview…' });
  const clipped = render({ ...owner, clippedFrom: 5000 });
  assert.match(clipped, /Show full message \(5000 characters\)/);
  assert.doesNotMatch(clipped, /Edit message/);
  const whole = render(owner);
  assert.match(whole, /Edit message/);
  assert.doesNotMatch(whole, /Show full message/);
});
