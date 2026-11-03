import type { ExpeditionRow } from '@unleashd/shared';
import { atom } from 'jotai';
import { EXPEDITIONS_URL } from '../components/buddies/expedition-api';
import { type ResourceEntry, resourceAtomFamily } from './resources';
import { jotaiStore } from './store';

export const archivedBuddyIdsAtom = atom<ReadonlySet<string>>(new Set<string>());
export function hideArchivedBuddy(buddyId: string): void {
  jotaiStore.set(archivedBuddyIdsAtom, new Set([...jotaiStore.get(archivedBuddyIdsAtom), buddyId]));
}

/** Expedition crew Buddies (the rows' `crewBuddyId`): reached through the expedition card and
 * modal, never listed on the Buddies roster as team members. Empty until the rows load. */
export const expeditionCrewIdsAtom = atom((get): ReadonlySet<string> => {
  const entry = get(resourceAtomFamily(EXPEDITIONS_URL)) as ResourceEntry<ExpeditionRow[]>;
  if (entry.kind !== 'ready' && entry.kind !== 'stale') return NO_CREWS;
  return new Set(
    entry.value.flatMap((r) => (r.t === 'ok' && r.crewBuddyId ? [r.crewBuddyId] : []))
  );
});
// Until the list loads, or while it fails, no crew is known and none is hidden: a crew Buddy
// briefly listed is harmless, a real teammate hidden on a guess is not (deliberate, not a guess).
const NO_CREWS: ReadonlySet<string> = new Set();

/** Every Buddy kept off the rosters (archived ∪ expedition crews): the one set the sidebar, the
 * channel rail and both Buddies directories filter by. */
export const rosterHiddenBuddyIdsAtom = atom(
  (get): ReadonlySet<string> =>
    new Set([...get(archivedBuddyIdsAtom), ...get(expeditionCrewIdsAtom)])
);
