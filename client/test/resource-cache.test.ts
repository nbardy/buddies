import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Resource,
  type ResourceEntry,
  clearResourceCache,
  invalidateChannelResources,
  invalidateResources,
  isResourceCached,
  loadResource,
  resourceAtomFamily,
  resourceCacheSize,
  retainResourceKey,
} from '../src/atoms/resources';
import { jotaiStore } from '../src/atoms/store';

const read = <T>(key: string) => jotaiStore.get(resourceAtomFamily(key)) as ResourceEntry<T>;

/** A loader whose resolution the test controls, so races are deterministic. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test.beforeEach(() => clearResourceCache());

// The reason this module exists. Before it, every usePolledFetch result lived
// in component useState, so leaving a page and coming back refetched from zero
// behind a spinner. If a future change moves reads back into the component, or
// makes a second load bypass the cache, this fails.
test('a second read of a settled key serves the cached value without refetching', async () => {
  let calls = 0;
  const resource: Resource<string> = {
    key: '/api/thing',
    load: async () => {
      calls += 1;
      return 'value';
    },
  };

  await loadResource(resource);
  const settled = read<string>('/api/thing');
  assert.equal(settled.kind, 'ready');
  assert.equal(settled.kind === 'ready' && settled.value, 'value');
  assert.equal(calls, 1);

  // Remount: the entry is already 'ready', so a subscriber renders it
  // immediately rather than showing a spinner. The reload below is the
  // background revalidation that follows.
  await loadResource(resource);
  assert.equal(calls, 2, 'revalidates in the background');
  assert.equal(read<string>('/api/thing').kind, 'ready', 'never drops back to loading');
});

// Regression guard for the bug that RoutedBuddyData / RoutedBuddyLoadError /
// routedResult existed to work around in useBuddyDetailData, and that
// BuddyTeamConfiguration and BuddyTaskComments each re-solved by hand. That
// machinery was deleted in favour of this property: a response can only ever
// be read back under the key that asked for it.
test('a slow response for one key cannot be read under another key', async () => {
  const slow = deferred<string>();
  const fast = deferred<string>();

  const buddyA: Resource<string> = { key: 'buddy-detail:A', load: () => slow.promise };
  const buddyB: Resource<string> = { key: 'buddy-detail:B', load: () => fast.promise };

  const pendingA = loadResource(buddyA);
  const pendingB = loadResource(buddyB);

  // B (the buddy now on screen) answers first, A (the one navigated away from)
  // answers second — the ordering that used to let the stale one win.
  fast.resolve('B data');
  await pendingB;
  slow.resolve('A data');
  await pendingA;

  const entryB = read<string>('buddy-detail:B');
  assert.equal(entryB.kind, 'ready');
  assert.equal(entryB.kind === 'ready' && entryB.value, 'B data');
});

test('concurrent readers of one key share a single request', async () => {
  let calls = 0;
  const gate = deferred<string>();
  const resource: Resource<string> = {
    key: '/api/shared',
    load: () => {
      calls += 1;
      return gate.promise;
    },
  };

  const first = loadResource(resource);
  const second = loadResource(resource);
  gate.resolve('once');
  await Promise.all([first, second]);

  assert.equal(calls, 1, 'two subscribers, one fetch');
});

test('a hung read releases its shared slot, reports failure and can retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hung = deferred<string>();
  let signal!: AbortSignal;
  const key = '/api/buddies/posts/hung/thread?limit=50';
  const pending = loadResource({
    key,
    load: (requestSignal) => {
      signal = requestSignal;
      return hung.promise; // Deliberately ignores abort, as a stalled loader might.
    },
  });
  t.mock.timers.tick(30_000);
  await pending;
  const failed = read(key);
  assert.equal(failed.kind, 'failed');
  assert.match(failed.kind === 'failed' ? failed.error.message : '', /timed out/);
  assert.equal(signal.aborted, true);
  await loadResource({ key, load: async () => 'retried' });
  hung.resolve('late obsolete answer');
  await new Promise((resolve) => setImmediate(resolve));
  const retried = read<string>(key);
  assert.equal(retried.kind === 'ready' && retried.value, 'retried');
});

test('a loader AbortError without cache cancellation is a visible failure', async () => {
  const key = '/api/aborted-read';
  await loadResource({
    key,
    load: async () => {
      throw new DOMException('Read aborted', 'AbortError');
    },
  });
  assert.equal(read(key).kind, 'failed', 'never leaves the cache stuck loading');
});

// Guards the deleted `prevProjectsRef` in useSwarmProjects: a failed refresh
// must keep the last-known value on screen rather than blanking the view, and
// must still report the error.
test('a failed refresh keeps the previous value and reports the failure', async () => {
  let attempt = 0;
  const resource: Resource<string> = {
    key: '/api/flaky',
    load: async () => {
      attempt += 1;
      if (attempt === 1) return 'first';
      throw new Error('offline');
    },
  };

  await loadResource(resource);
  await loadResource(resource);

  const entry = read<string>('/api/flaky');
  assert.equal(entry.kind, 'stale');
  assert.equal(entry.kind === 'stale' && entry.value, 'first');
  assert.equal(entry.kind === 'stale' && entry.error.message, 'offline');
});

// Push path: one call refreshes every matching MOUNTED view in place. A future
// change that drops entries instead of re-running their loaders would leave
// panels showing a spinner until their next poll tick; one that also re-runs
// unmounted keys turns a burst of WS events into a request storm (a remount
// revalidates anyway, so nothing is gained).
test('invalidation refreshes mounted keys in place and leaves the rest alone', async () => {
  let value = 'v1';
  let retainedLoads = 0;
  const live: Resource<string> = { key: '/api/buddies/live', load: async () => value };
  const retained: Resource<string> = {
    key: '/api/buddies/retained',
    load: async () => {
      retainedLoads += 1;
      return 'retained';
    },
  };
  const unrelated: Resource<string> = { key: '/api/swarm-runs', load: async () => 'untouched' };

  const release = retainResourceKey(live.key);
  await Promise.all([loadResource(live), loadResource(retained), loadResource(unrelated)]);

  value = 'v2';
  invalidateResources((key) => key.startsWith('/api/buddies'));
  // Invalidation re-enters loadResource, so awaiting a fresh call for the same
  // key joins the in-flight refresh rather than starting a third one.
  await loadResource(live);

  const refreshed = read<string>('/api/buddies/live');
  assert.equal(refreshed.kind === 'ready' && refreshed.value, 'v2');
  assert.equal(retainedLoads, 1, 'unmounted keys are not refetched');
  const untouched = read<string>('/api/swarm-runs');
  assert.equal(untouched.kind === 'ready' && untouched.value, 'untouched');
  release();
});

// Eviction bounds a long-lived PWA session. Evicting a key a view is currently
// showing would turn the fix into a new flicker, so mounted keys are exempt.
test('eviction never discards a key a mounted view is reading', async () => {
  const release = retainResourceKey('/api/pinned');
  await loadResource({ key: '/api/pinned', load: async () => 'pinned' });

  // Overflow the retention limit with unmounted keys.
  for (let i = 0; i < 320; i += 1) {
    await loadResource({ key: `/api/filler/${i}`, load: async () => i });
  }

  assert.ok(resourceCacheSize() <= 100, 'cache stays bounded');
  const pinned = read<string>('/api/pinned');
  assert.equal(pinned.kind === 'ready' && pinned.value, 'pinned');
  release();
});

// The render-cost fix. Before structural sharing every poll and push wrote a
// fresh value, so each open channel re-rendered all 50 rows and re-parsed
// their markdown every few seconds with nothing new. A change that writes
// unconditionally again brings that back without failing anything else.
test('a refresh that returns equal data leaves the entry itself untouched', async () => {
  const resource: Resource<Array<{ id: string; body: string }>> = {
    key: '/api/buddies/channels/c/posts',
    load: async () => [{ id: 'p1', body: 'hello' }],
  };
  await loadResource(resource);
  const before = read('/api/buddies/channels/c/posts');
  await loadResource(resource);
  assert.equal(read('/api/buddies/channels/c/posts'), before);
});

// Posts arrive as a sliding "latest N" window: a new post shifts every index.
// Pairing elements by position would give every row a new object on every
// new post; pairing by `id` re-renders only the new one.
test('a new post keeps the identity of every unchanged post in the window', async () => {
  let posts = [
    { id: 'p3', body: 'three' },
    { id: 'p2', body: 'two' },
  ];
  const resource: Resource<typeof posts> = {
    key: '/api/buddies/channels/c/posts',
    load: async () => structuredClone(posts),
  };
  await loadResource(resource);
  const first = read<typeof posts>('/api/buddies/channels/c/posts');
  posts = [{ id: 'p4', body: 'four' }, ...posts.slice(0, 1)];
  await loadResource(resource);
  const second = read<typeof posts>('/api/buddies/channels/c/posts');
  assert.ok(first.kind === 'ready' && second.kind === 'ready');
  assert.equal(second.value[1], first.value[0], 'p3 keeps its identity');
  assert.deepEqual(second.value[0], { id: 'p4', body: 'four' });
});

// With polling reduced to a backstop, a push is the only prompt refresh. A
// load already in flight may have read the server before the pushed change;
// joining it would show the old answer until the next poll (30s).
test('an invalidation while a load is in flight loads once more after it', async () => {
  const gate = deferred<string>();
  let server = 'before';
  let calls = 0;
  const resource: Resource<string> = {
    key: '/api/buddies/channels/c/responding',
    load: () => {
      calls += 1;
      return calls === 1 ? gate.promise : Promise.resolve(server);
    },
  };
  const release = retainResourceKey(resource.key);
  const first = loadResource(resource);
  server = 'after';
  invalidateResources(() => true);
  assert.equal(calls, 1, 'joins the running load instead of racing it');
  gate.resolve('before');
  await first;
  await new Promise((resolve) => setImmediate(resolve)); // the rerun settles
  const entry = read<string>(resource.key);
  assert.equal(entry.kind === 'ready' && entry.value, 'after');
  assert.equal(calls, 2);
  release();
});

// A Buddy's mention reply reaches the client only as `channel_changed`, whose
// id may be any channel kind. The channel's own keys refresh, and so do the
// keys the push cannot address by channel: the open thread, the owner's
// inboxes (rail unread counts, requests, the tab title), task details
// (their comments are the task channel) and the Task filter's cross-channel
// feed (T22). Until 2026-09-25 the rail waited out
// the 30 s backstop poll for a reply.
test('a channel change refreshes that channel, threads and inboxes, not other channels', async () => {
  const loads = new Map<string, number>();
  const keys = [
    '/api/buddies/channels/ch_a/posts?limit=50',
    '/api/buddies/channels/ch_a/responding',
    '/api/buddies/posts/root/thread?limit=50',
    '/api/buddies/workspaces/w/inbox',
    'buddy-owner-inboxes:w,v',
    '/api/buddies/tasks/t1',
    '/api/buddies/tasks/t1/posts?limit=50',
    '/api/buddies/channels/ch_b/posts?limit=50',
    '/api/buddies/channels/ch_ab/posts?limit=50',
  ];
  const releases = keys.map((key) => retainResourceKey(key));
  const counted = (key: string): Resource<string> => ({
    key,
    load: async () => {
      loads.set(key, (loads.get(key) ?? 0) + 1);
      return key;
    },
  });
  await Promise.all(keys.map((key) => loadResource(counted(key))));
  invalidateChannelResources('ch_a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    keys.map((key) => loads.get(key)),
    [2, 2, 2, 2, 2, 2, 2, 1, 1]
  );
  for (const release of releases) release();
});

// A key revalidated with unchanged data is still a use. writeEntry returned
// before the LRU bump on an equal refresh, so the channel a user keeps
// reopening kept its first-load position and was evicted ahead of keys
// touched once since.
test('an unchanged refresh still counts as recent use for eviction', async () => {
  const favourite: Resource<string> = { key: '/api/favourite', load: async () => 'same' };
  await loadResource(favourite);
  for (let i = 0; i < 299; i += 1) {
    await loadResource({ key: `/api/filler/${i}`, load: async () => i });
  }
  await loadResource(favourite); // equal answer: entry kept, recency bumped
  await loadResource({ key: '/api/filler/overflow', load: async () => 'overflow' });

  assert.ok(isResourceCached('/api/favourite'), 'the recently used key survives');
  assert.ok(!isResourceCached('/api/filler/0'), 'the least recently used key goes');
});

// Regression (2026-10-08 audit: a threads tab reached ~17GB): a hidden tab refetched every matching
// key on every push. A push while hidden must not load; visibility return refreshes via
// usePolledFetch, so nothing is lost.
test('a push while the tab is hidden does not refetch mounted keys', async () => {
  const key = '/api/buddies/channels/ch_hidden';
  let loads = 0;
  const resource: Resource<number> = { key, load: async () => ++loads };
  const release = retainResourceKey(key);
  await loadResource(resource);
  assert.equal(loads, 1);

  const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { hidden: true }, configurable: true });
  try {
    invalidateChannelResources('ch_hidden');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loads, 1, 'hidden: no refetch');
  } finally {
    if (realDocument) Object.defineProperty(globalThis, 'document', realDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }

  invalidateChannelResources('ch_hidden');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 2, 'visible: refetched');
  release();
});
