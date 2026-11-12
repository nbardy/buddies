import assert from 'node:assert/strict';
import test from 'node:test';
import { folderGroupKey, normalizeFolderDirectory } from '../src/utils/directories';

/**
 * Regression, incident 2026-09-06. The sidebar's recent-folder groups keyed on
 * the raw working directory, so every oompa worktree iteration got its own
 * group header: 1,107 groups for room-runners-arena-lib alone, each rendering
 * as the same truncated `~/git/room-runners-aren…` with one thread under it.
 *
 * The fold lives in `getProjectRoot`. Narrowing that regex would silently
 * shatter the sidebar again for old oompa transcripts still on disk.
 */
test('sibling worktrees of one repo collapse to a single sidebar group', () => {
  const repo = '/Users/nick/git/room-runners-arena-lib';
  const keys = new Set(
    [
      `${repo}/.wsc1288964-w0-i17`,
      `${repo}/.wsc1288964-w10-i3`,
      `${repo}/.ww8-i11`,
      `${repo}/.workers/worker-4`,
      `${repo}/`,
      repo,
    ].map(folderGroupKey)
  );

  assert.deepEqual([...keys], [repo]);
});

// A hyphenated repo name is not a worktree marker — folding one level too far
// would merge unrelated repos under a shared parent.
test('a plain project directory is its own group', () => {
  assert.equal(
    folderGroupKey('/Users/nick/git/room-runners-arena-lib'),
    '/Users/nick/git/room-runners-arena-lib'
  );
  assert.equal(
    folderGroupKey('/Users/nick/git/unleashd/client'),
    '/Users/nick/git/unleashd/client'
  );
});

// The grouping fold must stay out of normalizeFolderDirectory: that one answers
// "which directory did the user mean", and rewriting a worktree the user typed
// into its parent repo would start the conversation in the wrong tree.
test('normalizeFolderDirectory does not fold worktrees', () => {
  const worktree = '/Users/nick/git/room-runners-arena-lib/.wsc1288964-w0-i17';
  assert.equal(normalizeFolderDirectory(`${worktree}/`), worktree);
});
