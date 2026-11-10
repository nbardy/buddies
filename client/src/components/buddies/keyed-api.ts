import type { keyed } from '@unleashd/shared';
import { useState } from 'react';
import { invalidateBuddyResources } from '../../atoms/resources';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { errorText } from './api';

// Keyed expeditions over HTTP (CONNECT_PLAN §4). Reads are keyed by URL in the resource cache, so
// the rail's per-row fetch and the open view share one entry. Writes are `buddyWrite('keyed.*')`
// calls handed to `useKeyedWrite`, which refreshes everything under /api/buddies when they land.

export const KEYED_URL = '/api/buddies/keyed-expeditions';
export const keyedUrl = (id: string) => `${KEYED_URL}/${encodeURIComponent(id)}`;

/** The list. Null until it loads, and null for good when the backend has no such route (404: not
 * reloaded yet; 503: the feature flag is off): the rail then shows nothing extra. */
export function useKeyedRows(): keyed.KeyedRow[] | null {
  return usePolledFetch<keyed.KeyedRow[]>(KEYED_URL, 10_000).data;
}

/** One expedition. `enabled` off (a finished row in the rail) reads the cache and never fetches. */
export const useKeyedView = (id: string, pollMs: number, enabled = true) =>
  usePolledFetch<keyed.KeyedView>(keyedUrl(id), pollMs, enabled);

/** What a failed read says. A 404 or 503 is "this backend does not serve it", not a fault. */
export const unavailableText = (error: string): string =>
  error === 'HTTP 404' || error === 'HTTP 503'
    ? 'Keyed expeditions are not available on this backend (not reloaded yet, or switched off).'
    : error;

export type WriteState = { t: 'idle' } | { t: 'pending' } | { t: 'failed'; error: string };

/** One owner write at a time; a refusal's reason shows inline beside the controls. */
export function useKeyedWrite() {
  const [state, setState] = useState<WriteState>({ t: 'idle' });
  const run = (send: () => Promise<unknown>) => {
    setState({ t: 'pending' });
    send()
      .then(() => {
        invalidateBuddyResources();
        setState({ t: 'idle' });
      })
      .catch((cause: unknown) => setState({ t: 'failed', error: errorText(cause) }));
  };
  return { state, run };
}
