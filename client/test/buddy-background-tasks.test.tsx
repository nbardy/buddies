import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import type { ConversationRow } from '@unleashd/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { syntheticConversation, syntheticDetail } from './fixtures/synthetic-conversations';
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { Provider, createStore } = await import('jotai');
const { connectionAtom, rowsAtom } = await import('../src/atoms/conversations');
const { BuddyBackgroundTasks } = await import('../src/components/buddies/BuddyBackgroundTasks');

const T0 = Date.parse('2026-09-13T00:00:00Z');
const make = (id: string, overrides: Partial<ConversationRow> = {}) =>
  syntheticConversation(1, {
    id,
    kind: { t: 'buddy', buddyId: 'lead', workspaceId: 'wave', visibility: 'background' },
    createdAt: T0,
    activityAt: T0,
    messageCount: 0,
    provider: 'codex',
    ...overrides,
  });

const hrefs = (html: string) => [...html.matchAll(/href="(\/chat\/[^"]+)"/g)].map((m) => m[1]);

test('background destination shows running work first, keeps history and drops deleted targets', () => {
  const store = createStore();
  const conversations = new Map(
    [
      make('past', { activityAt: Date.parse('2026-09-13T01:00:00Z') }),
      make('active', { run: 'running', parent: 'owner' }),
      make('owner', {
        kind: { t: 'buddy', buddyId: 'lead', workspaceId: 'wave', visibility: 'foreground' },
        run: 'running',
      }),
      make('other-buddy', {
        kind: { t: 'buddy', buddyId: 'engineer', workspaceId: 'wave', visibility: 'background' },
      }),
    ].map((conversation) => [conversation.id, conversation])
  );
  store.set(rowsAtom, conversations);
  store.set(connectionAtom, {
    socket: { tag: 'closed' },
    server: { tag: 'v3', defaultCwd: '/', loadComplete: true },
  });
  const render = () =>
    renderToStaticMarkup(
      <Provider store={store}>
        <MemoryRouter>
          <BuddyBackgroundTasks buddyId="lead" runs={[]} refresh={async () => {}} />
        </MemoryRouter>
      </Provider>
    );
  assert.deepEqual(hrefs(render()), ['/chat/active', '/chat/past']);
  assert.match(render(), /1 running · 0 queued · 2 total/);

  // Live snapshots change the count; deletion removes its target immediately.
  store.set(rowsAtom, new Map(conversations).set('active', make('active')));
  assert.match(render(), /0 running · 0 queued · 2 total/);
  const remaining = new Map(conversations);
  remaining.delete('active');
  store.set(rowsAtom, remaining);
  assert.deepEqual(hrefs(render()), ['/chat/past']);
});

test('native workers are deduplicated against descendants, and unconfirmed completion stays honest', async () => {
  const { projectBuddyWorkers } = await import('../src/atoms/buddy-background');
  const parent = make('owner', {
    kind: { t: 'buddy', buddyId: 'lead', workspaceId: 'wave', visibility: 'foreground' },
    run: 'running',
  });
  const child = make('child', { kind: { t: 'chat' }, parent: parent.id, run: 'running' });
  const agent = {
    id: 'agent',
    providerThreadId: 'native-child',
    description: 'Implement archive',
    status: 'running' as const,
    toolUses: 4,
    tokens: 0,
    startedAt: new Date(T0),
    statusSource: 'native' as const,
  };
  const details = [
    syntheticDetail(parent.id, { subAgents: [agent] }),
    syntheticDetail(child.id, { sessionId: 'native-child' }),
  ];
  const active = projectBuddyWorkers([parent, child], details);
  assert.equal(active.length, 1);
  assert.equal(active[0].row.id, child.id);
  assert.equal(active[0].status, 'running');
  const unknown = projectBuddyWorkers(
    [{ ...parent, run: 'idle' }],
    [
      syntheticDetail(parent.id, {
        subAgents: [{ ...agent, status: 'completed', statusSource: 'inferred_parent_completion' }],
      }),
    ]
  );
  assert.equal(unknown[0].status, 'unknown');
  assert.equal(unknown[0].row.id, parent.id);
});

test('cold worker discovery reads bounded detail only, reuses quiet sessions and retries partial failures', async () => {
  const { workerDetailsResource } = await import('../src/atoms/buddy-background');
  const { clearResourceCache, resourceCacheSize } = await import('../src/atoms/resources');
  const { jotaiStore } = await import('../src/atoms/store');
  const previousRows = jotaiStore.get(rowsAtom);
  clearResourceCache();
  const original = globalThis.fetch;
  const paths: string[] = [];
  let failing = true;
  globalThis.fetch = async (input) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith('/temporarily-unavailable') && failing)
      return new Response('', { status: 503 });
    const id = path.split('/').at(-1)!;
    return Response.json(syntheticDetail(id));
  };
  try {
    const rows = [make('quiet'), make('temporarily-unavailable')];
    jotaiStore.set(rowsAtom, new Map(rows.map((row) => [row.id, row])));
    const source = workerDetailsResource({
      buddyId: 'lead',
      workspaceId: 'wave',
      includeHistory: true,
    });
    const first = await source.load(new AbortController().signal);
    assert.deepEqual(
      first.details.map((detail) => detail.id),
      ['quiet']
    );
    assert.deepEqual(first.unavailableIds, ['temporarily-unavailable']);
    failing = false;
    const second = await source.load(new AbortController().signal);
    assert.equal(second.details.length, 2);
    assert.deepEqual(second.unavailableIds, []);
    assert.equal(paths.filter((path) => path.endsWith('/quiet')).length, 1);
    assert.equal(paths.filter((path) => path.endsWith('/temporarily-unavailable')).length, 2);
    const size = resourceCacheSize();
    const changed = make('quiet', { activityAt: T0 + 1 });
    jotaiStore.set(
      rowsAtom,
      new Map(rows.map((row) => [row.id, row.id === 'quiet' ? changed : row]))
    );
    await source.load(new AbortController().signal);
    assert.equal(paths.filter((path) => path.endsWith('/quiet')).length, 2);
    assert.equal(resourceCacheSize(), size, 'new activity refreshes the same per-conversation key');
    assert.ok(
      paths.every((path) => !path.includes('/messages')),
      'worker inspection never hydrates transcript bodies'
    );
  } finally {
    globalThis.fetch = original;
    jotaiStore.set(rowsAtom, previousRows);
    clearResourceCache();
  }
});

test('cold rail badges never fetch idle history, but discover running and queued workers', async () => {
  const { buddyWorkerCountsFamily, workerDetailsResource } = await import(
    '../src/atoms/buddy-background'
  );
  const { clearResourceCache } = await import('../src/atoms/resources');
  const { jotaiStore } = await import('../src/atoms/store');
  const previousRows = jotaiStore.get(rowsAtom);
  const original = globalThis.fetch;
  clearResourceCache();
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    paths.push(path);
    return Response.json(syntheticDetail(path.split('/').at(-1)!));
  };
  try {
    const history = Array.from({ length: 1136 }, (_, index) => make(`past-${index}`));
    jotaiStore.set(rowsAtom, new Map(history.map((row) => [row.id, row])));
    const scope = { buddyId: 'lead', workspaceId: 'wave', includeHistory: false };
    const source = workerDetailsResource(scope);
    await source.load(new AbortController().signal);
    assert.deepEqual(paths, [], 'opening an idle rail fetches no historical details');

    const rows = [...history, make('live', { run: 'running' }), make('waiting', { run: 'queued' })];
    jotaiStore.set(rowsAtom, new Map(rows.map((row) => [row.id, row])));
    await source.load(new AbortController().signal);
    assert.deepEqual(paths.sort(), ['/api/conversations/live', '/api/conversations/waiting']);
    assert.equal(jotaiStore.get(buddyWorkerCountsFamily(scope)).active, 2);
  } finally {
    globalThis.fetch = original;
    jotaiStore.set(rowsAtom, previousRows);
    clearResourceCache();
  }
});

test('worker hover text tracks running counts even when the active total stays unchanged', async () => {
  const { BuddyBackgroundLink } = await import('../src/components/buddies/BuddyBackgroundLink');
  const store = createStore();
  store.set(connectionAtom, {
    socket: { tag: 'closed' },
    server: { tag: 'v3', defaultCwd: '/', loadComplete: true },
  });
  const render = () =>
    renderToStaticMarkup(
      <Provider store={store}>
        <MemoryRouter>
          <BuddyBackgroundLink buddyId="lead" workspaceId="wave" name="Lead" />
        </MemoryRouter>
      </Provider>
    );
  const first = make('tooltip-first', { run: 'running' });
  const second = make('tooltip-second', { run: 'running' });
  store.set(
    rowsAtom,
    new Map([
      [first.id, first],
      [second.id, second],
    ])
  );
  assert.match(render(), /data-tooltip="Lead: 2 workers running\. View workers and recent activity"/);
  store.set(
    rowsAtom,
    new Map([
      [first.id, first],
      [second.id, make(second.id, { run: 'queued' })],
    ])
  );
  assert.match(
    render(),
    /data-tooltip="Lead: 1 worker running · 1 queued\. View workers and recent activity"/
  );
});
