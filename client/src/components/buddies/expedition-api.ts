import type { Act, Expedition, ExpeditionRow } from '@unleashd/shared';
import { useState } from 'react';
import { invalidateBuddyResources } from '../../atoms/resources';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { buddyWrite, errorText } from './api';

// Keys under /api/buddies: `buddies_changed` refreshes every mounted card, rail and modal.

export const EXPEDITIONS_URL = '/api/buddies/expeditions';
export const expeditionUrl = (id: string) => `${EXPEDITIONS_URL}/${encodeURIComponent(id)}`;

/** Needs-you and unreadable rows first, then open ones, then finished. */
const rank = (r: ExpeditionRow) =>
  r.t === 'unreadable' || r.needsOwner ? 0 : r.state === 'finished' ? 2 : 1;

/** This workspace's rows, plus every unreadable one (it cannot say its workspace). */
export function useExpeditionRows(workspaceId: string): ExpeditionRow[] | null {
  const rows = usePolledFetch<ExpeditionRow[]>(EXPEDITIONS_URL, 10_000);
  if (rows.data === null) return null;
  return rows.data
    .filter((r) => r.t === 'unreadable' || r.workspaceId === workspaceId)
    .sort((a, b) => rank(a) - rank(b));
}

export const useExpedition = (id: string, pollMs: number) =>
  usePolledFetch<Expedition>(expeditionUrl(id), pollMs);

export type ActState = { t: 'idle' } | { t: 'pending' } | { t: 'failed'; error: string };

/** One owner act; a refusal's reasons show inline under the controls. */
export function useAct(id: string) {
  const [state, setState] = useState<ActState>({ t: 'idle' });
  const run = (act: Act) => {
    setState({ t: 'pending' });
    buddyWrite('expedition.act', { id }, act)
      .then(() => {
        invalidateBuddyResources();
        setState({ t: 'idle' });
      })
      .catch((cause: unknown) => setState({ t: 'failed', error: errorText(cause) }));
  };
  return { state, run };
}
