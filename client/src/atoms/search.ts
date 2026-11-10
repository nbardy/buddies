import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { fuzzyMatch } from '../utils/fuzzyMatch';
import { listField, rowFamily } from './conversations';

// =============================================================================
// Search state (views/search) — sum type, never a '' sentinel (T2). One atom for
// both trees: the mobile Search tab keeps its query across a visit to a chat
// and back; the desktop palette starts empty each time it opens.
// =============================================================================

export type SearchQuery = { kind: 'idle' } | { kind: 'searching'; query: string };

export const searchQueryAtom = atom<SearchQuery>({ kind: 'idle' });

/**
 * Local conversation matches, newest first. `folder` scopes to a working
 * directory prefix ('' = everywhere). Idle → every id in scope (rows subscribe
 * per id). Searching → fuzzyMatch over folder, id and label (rows carry no
 * bodies; deep history is /api/search). Only a live query or a folder scope
 * reads rows, so an idle page does no work on conversation events.
 */
export const searchMatchesFamily = atomFamily((folder: string) =>
  atom((get): readonly string[] => {
    const state = get(searchQueryAtom);
    const ids = get(listField('order'));
    const query = state.kind === 'searching' ? state.query.trim() : '';
    if (query.length === 0 && folder === '') return ids;
    return ids.filter((id) => {
      const row = get(rowFamily(id));
      if (!row?.cwd.startsWith(folder)) return false;
      return (
        fuzzyMatch(query, row.cwd) !== null ||
        fuzzyMatch(query, row.id) !== null ||
        fuzzyMatch(query, row.label) !== null
      );
    });
  })
);
