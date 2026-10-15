import { type Resource, isResourceCached, loadResource } from './resources';

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// Global history warming fetched 41 pages / 17.9 MB on the Buddies directory (2026-10-15).
// Bodies load on open; only view-requested resources warm here. Guard: tools/check-route-loading.mjs.

/** Parallel warm requests. Above this a phone's connection is the bottleneck. */
const PREFETCH_CONCURRENCY = 3;

type IdleScheduler = (callback: () => void) => void;

const scheduleIdle: IdleScheduler = (callback) => {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (idle) idle(callback);
  else setTimeout(callback, 300);
};

/** Run warm jobs PREFETCH_CONCURRENCY at a time; a failed warm is a non-event. */
async function drain(jobs: readonly (() => Promise<unknown>)[]): Promise<void> {
  const queue = jobs.slice();
  const workers = Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      // A warm request that fails has no UI to report to; the lazy load on
      // open reports the failure to the user.
      await job().catch(() => {});
    }
  });
  await Promise.all(workers);
}

/**
 * Warm keyed resources the user is likely to open next — e.g. every channel
 * in the rail — so the first visit renders from cache like a revisit does.
 * Keys already cached are skipped (a mount revalidates them anyway), and
 * loadResource joins any in-flight request for the same key.
 */
export function warmResources(resources: readonly Resource<unknown>[]): void {
  scheduleIdle(() => {
    const cold = resources.filter((resource) => !isResourceCached(resource.key));
    if (cold.length > 0) void drain(cold.map((resource) => () => loadResource(resource)));
  });
}
