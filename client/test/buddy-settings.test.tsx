import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { buddyFixture } from './fixtures/buddy-roster';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { BuddySettings, profileChanges } = await import('../src/components/buddies/BuddySettings');
const { Provider } = await import('jotai');
const { jotaiStore } = await import('../src/atoms/store');
const { loadResource } = await import('../src/atoms/resources');

// Feature 9 (T22): a chosen provider, model or effort can be taken back to the
// server's default. Before, the route could not clear a field, so "Default"
// was offered only while a field was unset and a pick could never be undone.
test('Settings offers Default for a set provider, model and effort; clearing sends null', async () => {
  await loadResource({
    key: '/api/provider-catalog',
    load: async () =>
      ({
        revision: 'r1',
        providers: [
          {
            id: 'claude',
            displayName: 'Claude',
            supportsRequiredMcp: true,
            defaultModelId: 'opus',
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                reasoning: { levels: ['low', 'high'], defaultEffort: 'low' },
              },
            ],
          },
        ],
      }) as never,
  });
  const buddy = buddyFixture({
    id: 'lead',
    name: 'Lead',
    provider: 'claude',
    model: 'opus',
    reasoningEffort: 'high',
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Provider store={jotaiStore}>
        <BuddySettings buddy={buddy} managers={[]} refresh={async () => {}} />
      </Provider>
    </MemoryRouter>
  );
  for (const label of ['Server default', 'Provider default', 'Model default'])
    assert.match(html, new RegExp(`<option value="">${label}</option>`), label);
  assert.match(html, /<option value="high" selected="">high<\/option>/);

  const set = {
    name: 'Lead',
    role: 'Teammate',
    provider: 'claude',
    model: 'opus',
    reasoningEffort: 'high',
    managerId: '',
    maxActiveRuns: 2,
  };
  // The route rejects '' (min length 1); a cleared field must go out as null.
  assert.deepEqual(profileChanges(set, { ...set, provider: '', model: '', reasoningEffort: '' }), {
    provider: null,
    model: null,
    reasoningEffort: null,
  });
});
