import { atom } from 'jotai';
import { archivedBuddyIdsAtom } from '../../atoms/buddy-visibility';
import type { BuddyOverview } from '../../components/buddies/types';
import {
  type DirectoryEntry,
  directoryEntries,
  filterDirectoryEntries,
} from '../../components/buddies/ui-contract';

export interface MobileBuddyGroup {
  id: string;
  name: string;
  entries: DirectoryEntry[];
}

// Directory membership, search, counts and grouping in one projection: a group
// per workspace (a Buddy has exactly one home workspace), workspaces by name.
export function mobileBuddyDirectoryAtom(overview: BuddyOverview | null, query: string) {
  return atom((get) => {
    const hidden = get(archivedBuddyIdsAtom);
    const entries = directoryEntries(overview ?? []).filter((entry) => !hidden.has(entry.buddy.id));
    const filtered = filterDirectoryEntries(entries, query);
    const groups = new Map<string, MobileBuddyGroup>();
    for (const entry of filtered) {
      const group = groups.get(entry.workspace.id) ?? {
        id: entry.workspace.id,
        name: entry.workspace.name,
        entries: [],
      };
      group.entries.push(entry);
      groups.set(group.id, group);
    }
    return {
      groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
      total: entries.length,
      matched: filtered.length,
    };
  });
}
