import type { ExpeditionCrews } from '@unleashd/shared';
import { atom } from 'jotai';
import { EXPEDITION_CREWS_URL } from '../components/buddies/expedition-view';
import { type ResourceEntry, resourceAtomFamily } from './resources';
import { jotaiStore } from './store';

export const archivedBuddyIdsAtom = atom<ReadonlySet<string>>(new Set<string>());
export function hideArchivedBuddy(buddyId: string): void {
  jotaiStore.set(archivedBuddyIdsAtom, new Set([...jotaiStore.get(archivedBuddyIdsAtom), buddyId]));
}

/** Expedition crew Buddies (one per expedition, server expeditions/host.ts `crews`): reached
 * through the expedition badge and modal, never listed on the Buddies roster as team members.
 * Read from the server's explicit list, never guessed from a name. Empty until it loads. */
export const expeditionCrewIdsAtom = atom((get): ReadonlySet<string> => {
  const entry = get(resourceAtomFamily(EXPEDITION_CREWS_URL)) as ResourceEntry<ExpeditionCrews>;
  return entry.kind === 'ready' || entry.kind === 'stale'
    ? new Set(entry.value.buddyIds)
    : NO_CREWS;
});
const NO_CREWS: ReadonlySet<string> = new Set();
