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

/** What a proposal card needs now (mode, launched, folder unchanged): a cheap read, no gate run. */
export const proposalUrl = (p: Pick<keyed.KeyedProposal, 'digest' | 'folder'>) =>
  `${KEYED_URL}/proposals/${encodeURIComponent(p.digest)}?folder=${encodeURIComponent(p.folder)}`;

/** One workspace's rows. Empty until the list loads, and for good when the backend has no such
 * route (404: not reloaded yet): the rail then shows nothing extra. The list is every workspace's
 * (one cached read); the filter is `rowsOf`. */
export function useKeyedRows(workspaceId: string): keyed.KeyedRow[] {
  return rowsOf(usePolledFetch<keyed.KeyedRow[]>(KEYED_URL, 10_000).data, workspaceId);
}

const NO_ROWS: keyed.KeyedRow[] = [];
const IN_WORKSPACE: {
  readonly [K in keyed.LaunchWorkspace['t']]: (
    w: Extract<keyed.LaunchWorkspace, { t: K }>,
    workspaceId: string
  ) => boolean;
} = {
  workspace: (w, workspaceId) => w.id === workspaceId,
  // Launched before expeditions named their workspace: no rail can claim it.
  none: () => false,
};
/** The rows launched in `workspaceId`. */
export const rowsOf = (rows: keyed.KeyedRow[] | null, workspaceId: string): keyed.KeyedRow[] =>
  rows === null
    ? NO_ROWS
    : rows.filter((r) =>
        (IN_WORKSPACE[r.workspace.t] as (w: keyed.LaunchWorkspace, id: string) => boolean)(
          r.workspace,
          workspaceId
        )
      );

/** One expedition. */
export const useKeyedView = (id: string, pollMs: number) =>
  usePolledFetch<keyed.KeyedView>(keyedUrl(id), pollMs);

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
