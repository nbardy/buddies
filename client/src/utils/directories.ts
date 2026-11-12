/**
 * Working-directory normalization shared by both view trees.
 *
 * Extracted from Sidebar.tsx so the mobile create sheet and the desktop
 * new-conversation modal agree on what "the same folder" means — otherwise
 * `~/git/foo` and `~/git/foo/` show up as two different recent directories.
 */

export const ROOT_DIRECTORY = '/';

const HOME_PREFIX = /^\/Users\/[^/]+/;

/**
 * `/Users/<name>/…` → `~/…`, for DISPLAY only; never feed the result back as
 * a path. Was the same regex inline in 13 files.
 * Pattern: one-definition (docs/patterns.md#one-definition)
 */
export function shortenHomePath(path: string): string {
  return path.replace(HOME_PREFIX, '~');
}

export function normalizeFolderDirectory(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return ROOT_DIRECTORY;
  const withoutTrailingSlashes = trimmed.replace(/\/+$/, '');
  return withoutTrailingSlashes || ROOT_DIRECTORY;
}

/**
 * Sidebar group key: the project root, so per-iteration worktrees share one group. Not folded into
 * normalizeFolderDirectory, which must keep the directory the user meant (guard: folder-
 * grouping.test.ts). See docs/client-rationale.md#folder-group-key.
 */
export function folderGroupKey(workingDirectory: string): string {
  return getProjectRoot(normalizeFolderDirectory(workingDirectory));
}

/*
 * Worktree folding. Oompa workers and Claude Code run in git worktrees under the
 * project root (`<repo>/.w<id>-i<iter>`, `<repo>/.workers/worker-N`,
 * `<repo>/.claude/worktrees/<branch>`). The oompa viewer is gone, but its old transcripts
 * are still on disk and must keep folding into one group (folder-grouping.test.ts).
 */

/**
 * Detect if a working directory is a git worktree (not a real project root).
 * Covers:
 *   - Oompa worktrees:       ~/git/project/.wu5-i3
 *   - Worker directories:    ~/git/project/.workers/worker-0
 *   - Claude Code worktrees: ~/git/project/.claude/worktrees/some-branch
 */
export function isWorktreeDirectory(workingDirectory: string): boolean {
  return (
    /\/\.w[^/]+-i\d+$/.test(workingDirectory) ||
    /\/\.workers\/worker-\d+$/.test(workingDirectory) ||
    workingDirectory.includes('/.claude/worktrees/')
  );
}

/**
 * Strip worktree subfolder to get the project root directory.
 * Handles both oompa's `.w<id>-i<iter>` pattern and the `.workers/worker-N` pattern.
 */
export function getProjectRoot(workerDir: string): string {
  return workerDir
    .replace(/\/\.w[^/]+-i\d+$/, '') // .wN-iN oompa worktree pattern
    .replace(/\/\.workers\/worker-\d+$/, ''); // .workers/worker-N worktree pattern
}
