import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CODEX_INSTALLED, buddyFixture, rosterFixture } from './fixtures/buddy-roster';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { CHANNEL_PAGE, threadFeed, useThreadSeats, workspaceDirectory } = await import(
  '../src/components/buddies/channel-data'
);
const { mentionChoice } = await import('../src/components/buddies/channel-text');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { Provider } = await import('jotai');

// Regression (task_01a1100d): ThreadsPane, ThreadsMobile and TaskPage mounted a reply composer
// with a rootId but no `seats`, so an @mention there read `loading` forever and Send stayed
// disabled. The composer now loads its own thread's seats from the thread's shared resource.
function Probe({ rootId }: { rootId: string }) {
  const seats = useThreadSeats(rootId);
  const buddy = workspaceDirectory(
    [rosterFixture([buddyFixture({ id: 'lead', name: 'Lead' })])],
    'ws-1',
    [],
    CODEX_INSTALLED
  ).references[0];
  if (buddy.kind !== 'buddy') throw new Error('missing Buddy');
  return <p>{mentionChoice(buddy, new Map(), seats).kind}</p>;
}

test('a reply composer given only a rootId resolves a mention from the thread seats', async () => {
  const render = () =>
    renderToStaticMarkup(
      <Provider store={jotaiStore}>
        <Probe rootId="thread-seats" />
      </Provider>
    );
  assert.match(render(), /loading/);
  // The key the open thread pane polls, so the two share one cache entry.
  await loadResource({
    key: `${threadFeed('thread-seats', null).base}limit=${CHANNEL_PAGE}`,
    load: async () => ({
      seats: [
        {
          buddyId: 'lead',
          config: {
            provider: 'claude',
            model: { mode: 'explicit', modelId: 'claude-opus-5-5' },
            reasoning: { mode: 'explicit', effort: 'high' },
          },
        },
      ],
    }),
  });
  assert.match(render(), /seat/);
});
