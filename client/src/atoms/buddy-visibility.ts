import { atom } from 'jotai';
import { jotaiStore } from './store';

export const archivedBuddyIdsAtom = atom<ReadonlySet<string>>(new Set<string>());
export function hideArchivedBuddy(buddyId: string): void {
  jotaiStore.set(archivedBuddyIdsAtom, new Set([...jotaiStore.get(archivedBuddyIdsAtom), buddyId]));
}
