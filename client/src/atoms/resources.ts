import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { jotaiStore } from './store';

// Keyed resource cache behind every read-only HTTP view: remount is free (stale-while-revalidate),
// a late response lands on its own key, and `invalidateResources` is the one push entry point. See
// docs/client-rationale.md#resource-cache.

/**
 * Canonical request: a stable cache key plus a loader.
 *
 * The key is the identity of the DATA, not of the React tree asking for it.
 * Two components requesting the same key share one entry and one in-flight
 * request.
 */
export interface Resource<T> {
  readonly key: string;
  readonly load: (signal: AbortSignal) => Promise<T>;
}

/**
 * What the cache knows about one key.
 *
 * `stale` is the reason this is a sum rather than `{data, loading, error}`:
 * a failed refresh over a value we already hold is a distinct state from a
 * failure with nothing to show, and collapsing them is what forced
 * `useSwarmProjects` to keep its own `prevProjectsRef` shadow copy.
 */
export type ResourceEntry<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'failed'; error: Error }
  | { kind: 'stale'; value: T; error: Error };

/** Stable references — a fresh object here would re-render every subscriber. */
export const IDLE_ENTRY: ResourceEntry<never> = Object.freeze({ kind: 'idle' });
const LOADING_ENTRY: ResourceEntry<never> = Object.freeze({ kind: 'loading' });

/**
 * Unmounted keys retained for instant back-navigation. Mounted keys are never
 * evicted, so this bounds a long-lived PWA session without ever pulling data
 * out from under a visible view.
 */
const RETAINED_KEY_LIMIT = 300;
const RESOURCE_TIMEOUT_MS = 30_000;

const resourceCacheAtom = atom(new Map<string, ResourceEntry<unknown>>());

/**
 * Subscribe to one key. Per-key atoms mean a Buddy panel re-renders when its
 * own request settles and never when an unrelated one does.
 */
export const resourceAtomFamily = atomFamily((key: string) =>
  atom((get): ResourceEntry<unknown> => get(resourceCacheAtom).get(key) ?? LOADING_ENTRY)
);

/** Loaders by key, so invalidation can re-run a request it never saw created. */
const loaders = new Map<string, Resource<unknown>>();
/**
 * One request per key; a second caller joins the first rather than racing it.
 * `rerun`: invalidated after it started, so its answer may predate the change
 * that was pushed. It loads once more when it settles; without that, a push
 * landing mid-request was lost until the next poll.
 */
const inFlight = new Map<
  string,
  { promise: Promise<void>; controller: AbortController; rerun: boolean }
>();
/** Mounted-subscriber counts — eviction and push invalidation both consult this. */
const mounted = new Map<string, number>();

function writeEntry(key: string, entry: ResourceEntry<unknown>): void {
  const cache = jotaiStore.get(resourceCacheAtom);
  if (cache.get(key) === entry) {
    // An unchanged refresh (settledEntry kept the entry): no new Map, no
    // subscriber work — but it IS a use, so it still bumps recency. Returning
    // before the bump (until 2026-09-25) left a key revalidated every visit at
    // its first-load position, so eviction dropped the channel the user keeps
    // returning to ahead of ones opened once. Reordering in place is invisible
    // to readers (same Map, same entries); only `evictRetained` reads order.
    cache.delete(key);
    cache.set(key, entry);
    return;
  }
  const next = new Map(cache);
  // Delete-then-set moves the key to the Map's most-recent end, which is what
  // makes plain insertion order an LRU.
  next.delete(key);
  next.set(key, entry);
  evictRetained(next);
  jotaiStore.set(resourceCacheAtom, next);
}

function evictRetained(cache: Map<string, ResourceEntry<unknown>>): void {
  if (cache.size <= RETAINED_KEY_LIMIT) return;
  for (const key of cache.keys()) {
    if (cache.size <= RETAINED_KEY_LIMIT) return;
    if (mounted.get(key)) continue;
    if (inFlight.has(key)) continue;
    cache.delete(key);
    loaders.delete(key);
    // jotai-family memoizes per-key atoms forever; drop ours with the entry.
    resourceAtomFamily.remove(key);
  }
}

/**
 * A rejected load keeps any value we already had. Provenance is in the
 * variant (`stale` carries both), never a silent fall back to the old value.
 */
function failureEntry(
  previous: ResourceEntry<unknown> | undefined,
  error: Error
): ResourceEntry<unknown> {
  if (previous?.kind === 'ready' || previous?.kind === 'stale') {
    return { kind: 'stale', value: previous.value, error };
  }
  return { kind: 'failed', error };
}

/**
 * A successful load, structurally shared with what the entry held. Every poll
 * and push used to hand React a fresh tree, so a channel re-rendered all 50
 * rows — and re-parsed their markdown — on each tick even when nothing
 * changed. Now an equal answer keeps the entry itself (no write at all), and
 * a changed one keeps the identity of every part that did not change.
 */
function settledEntry(
  previous: ResourceEntry<unknown> | undefined,
  value: unknown
): ResourceEntry<unknown> {
  const held =
    previous?.kind === 'ready' || previous?.kind === 'stale' ? previous.value : undefined;
  const shared = share(held, value);
  return previous?.kind === 'ready' && shared === previous.value
    ? previous
    : { kind: 'ready', value: shared };
}

/**
 * The parts of `next` deep-equal to `previous` keep previous's identity.
 * Array elements pair by `id` when they carry one — each new post slides the
 * "latest 50" window and shifts every index — and by position otherwise.
 */
function share(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const held = new Map(previous.map((item, index) => [identity(item, index), item]));
    const shared = next.map((item, index) => share(held.get(identity(item, index)), item));
    const same =
      shared.length === previous.length && shared.every((item, index) => item === previous[index]);
    return same ? previous : shared;
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const keys = Object.keys(next);
    const shared = Object.fromEntries(keys.map((key) => [key, share(previous[key], next[key])]));
    const same =
      keys.length === Object.keys(previous).length &&
      keys.every((key) => key in previous && shared[key] === previous[key]);
    return same ? previous : shared;
  }
  return next;
}

const identity = (item: unknown, index: number): unknown =>
  isPlainObject(item) && typeof item.id === 'string' ? item.id : index;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Fetch `resource` into the cache. Concurrent calls for the same key share one
 * request. Resolves when the entry has settled; the value is read from the
 * store, not returned, so every consumer sees the same snapshot.
 */
// Pattern: one-write-path (docs/patterns.md#one-write-path)
export function loadResource<T>(resource: Resource<T>): Promise<void> {
  loaders.set(resource.key, resource as Resource<unknown>);

  const existing = inFlight.get(resource.key);
  if (existing) return existing.promise;

  const current = jotaiStore.get(resourceCacheAtom).get(resource.key);
  // A first load shows `loading`; a refresh keeps the cached value on screen.
  if (!current) writeEntry(resource.key, LOADING_ENTRY);

  const controller = new AbortController();
  // Unbounded reads hold the shared in-flight slot forever: polls/retries join it and model
  // chips could never leave Loading. Guard: resource-cache.test.ts bounds even an inert loader.
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error('Request timed out. Please retry.'));
    }, RESOURCE_TIMEOUT_MS);
  });
  const promise = Promise.race([
    new Promise<T>((resolve) => resolve(resource.load(controller.signal))),
    deadline,
  ])
    .then((value) => {
      if (controller.signal.aborted) return;
      writeEntry(
        resource.key,
        settledEntry(jotaiStore.get(resourceCacheAtom).get(resource.key), value)
      );
    })
    .catch((cause) => {
      const error = normalizeError(cause);
      if (controller.signal.aborted) return;
      writeEntry(
        resource.key,
        failureEntry(jotaiStore.get(resourceCacheAtom).get(resource.key), error)
      );
    })
    .finally(() => {
      clearTimeout(timeout);
      if (timedOut) controller.abort();
      const settled = inFlight.get(resource.key);
      if (settled?.promise !== promise) return;
      inFlight.delete(resource.key);
      if (settled.rerun) void loadResource(resource);
    });

  inFlight.set(resource.key, { promise, controller, rerun: false });
  return promise;
}

/**
 * Hold `value` under `resource.key` as though it had just loaded. For a value
 * assembled from reads already made: a feed that paged back seeds its new
 * window key with the posts it holds plus the page it fetched
 * (components/buddies/channel-data.ts `useChannelFeed`), so switching to that
 * key renders at once instead of flashing the loader. Mounting it still
 * revalidates.
 */
export function seedResource<T>(resource: Resource<T>, value: T): void {
  loaders.set(resource.key, resource as Resource<unknown>);
  writeEntry(
    resource.key,
    settledEntry(jotaiStore.get(resourceCacheAtom).get(resource.key), value)
  );
}

/**
 * Re-run the loader for every MOUNTED key the predicate selects. Unmounted keys revalidate on
 * remount; refreshing them here is a request storm. See docs/client-rationale.md#invalidate-
 * resources.
 */
export function invalidateResources(matches: (key: string) => boolean): void {
  for (const key of mounted.keys()) {
    const resource = loaders.get(key);
    if (!resource || !matches(key)) continue;
    const running = inFlight.get(key);
    if (running) running.rerun = true;
    else void loadResource(resource);
  }
}

/**
 * "The Buddy database changed" — refresh every cached Buddy view in place.
 *
 * One call site instead of twenty: subscribed panels update without a spinner,
 * and cached-but-unmounted keys stay correct for the next visit. Buddy keys are
 * either the request URL (`/api/buddies/...`) or an explicit `buddy-` prefix
 * for the multi-request loads that have no single URL.
 */
export const invalidateBuddyResources = (): void =>
  invalidateResources((key) => key.startsWith('/api/buddies') || key.startsWith('buddy-'));

/**
 * One channel changed (`channel_changed`): refresh its `/api/buddies/channels/<id>` keys plus
 * mounted threads, owner inboxes, the Threads view and task keys, which the push does not name. See docs/client-
 * rationale.md#invalidate-channel.
 */
export const invalidateChannelResources = (channelId: string): void => {
  const channel = `/api/buddies/channels/${encodeURIComponent(channelId)}`;
  invalidateResources(
    (key) =>
      key === channel ||
      key.startsWith(`${channel}/`) ||
      /^\/api\/buddies\/posts\/[^/]+\/thread/.test(key) ||
      /^\/api\/buddies\/workspaces\/[^/]+\/inbox$/.test(key) ||
      /^\/api\/buddies\/workspaces\/[^/]+\/threads\?/.test(key) ||
      key.startsWith('buddy-owner-inboxes:') ||
      /^\/api\/buddies\/tasks\/[^/?]+(\/posts\?.*)?$/.test(key)
  );
};

/**
 * Drop cached data outright. For sign-out / hard reset only: unlike
 * invalidation this leaves subscribers with no value to show.
 */
export function clearResourceCache(): void {
  for (const { controller } of inFlight.values()) controller.abort();
  inFlight.clear();
  for (const key of jotaiStore.get(resourceCacheAtom).keys()) resourceAtomFamily.remove(key);
  loaders.clear();
  jotaiStore.set(resourceCacheAtom, new Map());
}

/** Called by usePolledFetch only; keeps mounted keys out of the eviction sweep. */
export function retainResourceKey(key: string): () => void {
  mounted.set(key, (mounted.get(key) ?? 0) + 1);
  return () => {
    const next = (mounted.get(key) ?? 1) - 1;
    if (next <= 0) mounted.delete(key);
    else mounted.set(key, next);
  };
}

/** True once `key` holds an entry — prefetch skips it; a mount revalidates it. */
export const isResourceCached = (key: string): boolean =>
  jotaiStore.get(resourceCacheAtom).has(key);

/** Test seam: inspect cache size without exporting the atom itself. */
export const resourceCacheSize = (): number => jotaiStore.get(resourceCacheAtom).size;
