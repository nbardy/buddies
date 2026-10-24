import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { loadResource, invalidateChannelResources, retainResourceKey } = await import(
  '../src/atoms/resources'
);
const { CHANNEL_PAGE, READ_BATCH_MS, markThreadRead, seatsResource, threadFeed } = await import(
  '../src/components/buddies/channel-data'
);

// Regression (threads request storm, 2026-10-23): a 30-card Threads view made 30 full thread GETs on
// mount (one per composer), POSTed /read once per unread card, and every resulting
// `channel_changed` refetched all 30 mounted thread keys again: K unread cards = K waves of 30+
// GETs. This drives the real batchers and the real invalidation over a counting fetch.
const ROOTS = Array.from({ length: 30 }, (_, i) => `root_${i}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const calls: Array<{ method: string; url: string; body?: unknown }> = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ method: init?.method ?? 'GET', url, body });
  const answer = url.includes('/threads/seats?roots=')
    ? Object.fromEntries(
        decodeURIComponent(url.split('roots=')[1])
          .split(',')
          .map((id) => [id, { kind: 'seats', seats: [] }])
      )
    : { ok: true };
  return new Response(JSON.stringify(answer), {
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const threadKey = (root: string) => `${threadFeed(root, null).base}limit=${CHANNEL_PAGE}`;

test('30 composers asking for seats, and 30 cards marking read, are one request each', async () => {
  calls.length = 0;
  await Promise.all(ROOTS.map((root) => loadResource(seatsResource(root))));
  await Promise.all(ROOTS.map((root) => markThreadRead(root, `${root}_post`)));
  const seats = calls.filter((call) => call.url.includes('/threads/seats'));
  assert.equal(seats.length, 1);
  assert.equal(decodeURIComponent(seats[0].url.split('roots=')[1]).split(',').length, 30);
  const reads = calls.filter((call) => call.url === '/api/buddies/read');
  assert.equal(reads.length, 1);
  assert.equal((reads[0].body as { reads: unknown[] }).reads.length, 30);
  assert.ok(READ_BATCH_MS < 1000);
});

test('a read mark refreshes the Threads list, not the 30 mounted threads; a post refreshes its own', async () => {
  const loads = new Map<string, number>();
  const counted = (key: string) => ({
    key,
    load: async () => {
      loads.set(key, (loads.get(key) ?? 0) + 1);
      return key;
    },
  });
  const listKey = '/api/buddies/workspaces/w/threads?limit=30';
  const keys = [listKey, '/api/buddies/unread', ...ROOTS.map(threadKey)];
  const seatKeys = ROOTS.map((root) => seatsResource(root).key);
  const all = [...keys, ...seatKeys];
  const releases = all.map((key) => retainResourceKey(key));
  await Promise.all(all.map((key) => loadResource(counted(key))));
  const count = (key: string) => (loads.get(key) ?? 0) - 1; // refetches since the first load
  const refetched = () => all.filter((key) => count(key) > 0).length;

  invalidateChannelResources('ch', []); // what a (batched) read mark pushes
  await wait(5);
  assert.equal(count(listKey), 1);
  assert.equal(refetched(), 2, 'only the list and /unread, never a thread or its seats');

  invalidateChannelResources('ch', ['root_7']); // a reply landed in one thread
  await wait(5);
  assert.equal(count(threadKey('root_7')), 1);
  assert.equal(count(seatsResource('root_7').key), 1);
  assert.equal(count(threadKey('root_8')), 0);

  invalidateChannelResources('ch', 'all'); // an older backend's frame: the wide wave, still correct
  await wait(5);
  assert.equal(count(threadKey('root_8')), 1);
  for (const release of releases) release();
});
