import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type BranchState,
  type GitRun,
  type Registration,
  TREE_MS,
  branchState,
  cambium,
  git,
  pathExists,
  registrationOf,
  removeGitOnly,
  snapshotDirty,
  tipOf,
} from './git';
import type { Preserved, Release, WorktreeAt } from './ledger';

// Ending every tree (R1, R2, R11) via one forced remove path behind oompa's guard ladder. Before
// it: salvage pins (oompa 9f004a39 lost 2.5 h of work), harvest (455987ea lost GPU gauges), and
// retire's dirty snapshot; each returned as data and recorded with the release.

export type Keep = { salvageRef: string; harvestDir: string };
export type Released = { release: Release; preserved: Preserved[] };

const only = (release: Release): Released => ({ release, preserved: [] });

export type ReleasePolicy = { t: 'finish' } | { t: 'retire' };
type Guard = ReleasePolicy | { t: 'scratch' };

/** Ignored output worth keeping (`output/`); a larger harvest keeps the tree, never truncated. */
const LS_IGNORED = [
  'ls-files',
  '-z',
  '--others',
  '--ignored',
  '--exclude-standard',
  '--',
  'output',
];
const HARVEST_MAX_BYTES = 512 * 1024 * 1024;
const HARVEST_MAX_FILES = 10_000;
/** Markers of a git operation left half-done in a tree (oompa's `:in-progress` rung). */
const OPERATIONS = [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
];

const mergedInto = async (root: string, sha: string, into: string) =>
  (await git(root, ['merge-base', '--is-ancestor', sha, `refs/heads/${into}`])).t === 'ok';

async function dropBranch(
  root: string,
  at: WorktreeAt,
  may: (tip: string) => boolean | Promise<boolean>
): Promise<boolean> {
  const ref = `refs/heads/${at.branch}`;
  const tip = await tipOf(root, ref);
  return (
    tip.t === 'at' &&
    (await may(tip.sha)) &&
    (await git(root, ['update-ref', '-d', ref, tip.sha])).t === 'ok'
  );
}

/** Not `cambium remove --delete-branch`: its `git branch -d` refuses a base not merged into HEAD. */
const dropEmptyBranch = (root: string, at: WorktreeAt) =>
  dropBranch(root, at, (tip) => tip === at.baseSha);

async function salvage(root: string, ref: string, sha: string): Promise<Preserved> {
  const pinned = await git(root, ['update-ref', ref, sha]);
  if (pinned.t === 'failed') throw new Error(`could not pin ${ref}: ${pinned.message}`);
  return { t: 'salvaged', ref, sha };
}

/** Porcelain v2: git.ts trims stdout, which ate v1's leading space (` D` read as staged). */
type DirtyKind = 'clean' | 'tracked_deletions_only' | 'modified';
const DELETION = /^1 [.D][.D] /;

type Inspection =
  | { t: 'readable'; dirty: DirtyKind; lines: string[]; blockers: string[] }
  | { t: 'unreadable'; reason: string };

/** oompa's ladder: unreadable, off its own branch (when it exists), or an operation half-done. */
async function inspect(tree: TreePath): Promise<Inspection> {
  const [status, on, branch] = await Promise.all([
    git(tree.path, ['status', '--porcelain=v2']),
    git(tree.path, ['symbolic-ref', '--quiet', 'HEAD']),
    tipOf(tree.path, `refs/heads/${tree.branch}`),
  ]);
  if (status.t === 'failed')
    return { t: 'unreadable', reason: `git status failed: ${status.message}` };
  const operations = await Promise.all(
    OPERATIONS.map(async (marker) => {
      const where = await git(tree.path, ['rev-parse', '--git-path', marker]);
      return where.t === 'failed' || (await pathExists(path.resolve(tree.path, where.stdout)))
        ? [`a git operation is half-done (${marker})`]
        : [];
    })
  );
  const offBranch =
    branch.t === 'at' && (on.t !== 'ok' || on.stdout !== `refs/heads/${tree.branch}`);
  const lines = status.stdout.split('\n').filter(Boolean);
  return {
    t: 'readable',
    dirty:
      lines.length === 0
        ? 'clean'
        : lines.every((line) => DELETION.test(line))
          ? 'tracked_deletions_only'
          : 'modified',
    lines,
    blockers: [offBranch ? [`the tree is no longer on ${tree.branch}`] : [], ...operations].flat(),
  };
}

type Clearance = { t: 'clear'; preserved: Preserved[] } | { t: 'blocked'; reason: string };
const clearOrBlocked = (reasons: string[], preserved: Preserved[] = []): Clearance =>
  reasons.length === 0 ? { t: 'clear', preserved } : { t: 'blocked', reason: reasons.join('; ') };

/** A sibling of the salvage ref: git cannot hold both `…/<tree>` and `…/<tree>/dirty`. */
export const dirtyRefOf = (keep: Keep) => `${keep.salvageRef}-dirty`;

/** Finish keeps any uncommitted change; retire snapshots modifications (deletions lose nothing). */
const POLICY: Record<
  ReleasePolicy['t'],
  (tree: TreePath, seen: Extract<Inspection, { t: 'readable' }>, keep: Keep) => Promise<Clearance>
> = {
  finish: async (_tree, seen) =>
    clearOrBlocked([
      ...(seen.dirty === 'clean'
        ? []
        : [`uncommitted changes: ${seen.lines.slice(0, 5).join('; ')}`]),
      ...seen.blockers,
    ]),
  retire: async (tree, seen, keep) => {
    if (seen.blockers.length > 0 || seen.dirty !== 'modified') return clearOrBlocked(seen.blockers);
    const ref = dirtyRefOf(keep);
    const message = `expedition retire: uncommitted changes in ${tree.path}`;
    return clearOrBlocked(
      [],
      [{ t: 'salvaged', ref, sha: await snapshotDirty(tree.path, ref, message) }]
    );
  },
};

async function clearance(tree: TreePath, guard: Guard, keep: Keep): Promise<Clearance> {
  if (guard.t === 'scratch') return clearOrBlocked([]);
  const seen = await inspect(tree);
  return seen.t === 'unreadable'
    ? { t: 'blocked', reason: seen.reason }
    : POLICY[guard.t](tree, seen, keep);
}

type Harvest =
  | { t: 'none' }
  | { t: 'copied'; preserved: Preserved }
  | { t: 'refused'; reason: string };

/** Copies ignored output into `dest` (CoW); over the bounds it is refused whole (tree kept). */
async function harvest(tree: string, dest: string): Promise<Harvest> {
  const listed = await git(tree, LS_IGNORED);
  if (listed.t === 'failed')
    return { t: 'refused', reason: `listing ignored output: ${listed.message}` };
  const files: { rel: string; size: number }[] = [];
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    const stat = await fsp.lstat(path.join(tree, rel)).catch(() => undefined);
    if (stat?.isFile()) files.push({ rel, size: stat.size });
  }
  if (files.length === 0) return { t: 'none' };
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  if (bytes > HARVEST_MAX_BYTES || files.length > HARVEST_MAX_FILES)
    return {
      t: 'refused',
      reason: `ignored output (${files.length} files, ${bytes} bytes) exceeds the harvest bound (${HARVEST_MAX_FILES} files, ${HARVEST_MAX_BYTES} bytes): the tree is kept`,
    };
  for (const f of files) {
    const to = path.join(dest, f.rel);
    await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    await fsp.copyFile(path.join(tree, f.rel), to, fsp.constants.COPYFILE_FICLONE);
  }
  return { t: 'copied', preserved: { t: 'harvested', dir: dest, files: files.length, bytes } };
}

type Removal =
  | { t: 'removed'; preserved: Preserved[] }
  | { t: 'gone' }
  | { t: 'left'; reason: string; preserved: Preserved[] };

type TreePath = Pick<WorktreeAt, 'path' | 'branch'>;

type PinFirst = () => Promise<Preserved[]>;

const removed = (ran: GitRun, preserved: Preserved[]): Removal =>
  ran.t === 'failed' ? { t: 'left', reason: ran.message, preserved } : { t: 'removed', preserved };

async function removeTree(
  root: string,
  tree: TreePath,
  held: Registration,
  guard: Guard,
  keep: Keep,
  pinFirst: PinFirst
): Promise<Removal> {
  switch (held.t) {
    case 'cambium':
      return removeHeld(tree, guard, keep, pinFirst, () =>
        cambium(root, ['remove', '-force', held.name], TREE_MS)
      );
    case 'git_only':
      return removeHeld(tree, guard, keep, pinFirst, () => removeGitOnly(root, held.path));
    case 'gone':
      return goneTree(root, tree);
  }
}

async function removeHeld(
  tree: TreePath,
  guard: Guard,
  keep: Keep,
  pinFirst: PinFirst,
  remove: () => Promise<GitRun>
): Promise<Removal> {
  // Its directory a killed remove already deleted: only the registration goes (commits pinned).
  if (!(await pathExists(tree.path))) {
    const pinned = await pinFirst();
    return removed(await remove(), pinned);
  }
  const cleared = await clearance(tree, guard, keep);
  if (cleared.t === 'blocked') return { t: 'left', reason: cleared.reason, preserved: [] };
  const preserved = [...cleared.preserved, ...(await pinFirst())];
  const harvested = await harvest(tree.path, keep.harvestDir);
  if (harvested.t === 'refused') return { t: 'left', reason: harvested.reason, preserved };
  const copied = harvested.t === 'copied' ? [harvested.preserved] : [];
  return removed(await remove(), [...preserved, ...copied]);
}

/** No registration: `cambium recover`; a directory git does not vouch for is never deleted. */
async function goneTree(root: string, tree: TreePath): Promise<Removal> {
  if (!(await pathExists(tree.path))) return { t: 'gone' };
  await cambium(root, ['recover', '--json']);
  return (await pathExists(tree.path))
    ? { t: 'left', reason: `${tree.path} remains but is not a registered worktree`, preserved: [] }
    : { t: 'gone' };
}

async function settle(
  removal: Removal,
  gone: () => Promise<Released>,
  dropped: () => Promise<boolean>
): Promise<Released> {
  switch (removal.t) {
    case 'gone':
      return gone();
    case 'left':
      return { release: { t: 'left', reason: removal.reason }, preserved: removal.preserved };
    case 'removed':
      return {
        release: { t: 'removed', branchDeleted: await dropped() },
        preserved: removal.preserved,
      };
  }
}

async function goneRelease(root: string, at: WorktreeAt): Promise<Released> {
  const branch = await branchState(root, at);
  return branch.t === 'missing'
    ? only({ t: 'absent' })
    : only({
        t: 'removed',
        branchDeleted: branch.shas.length === 0 && (await dropEmptyBranch(root, at)),
      });
}

/** An attempt tree: kept with commits under `keepCommits`, else removed (unintegrated pinned). */
export async function releaseWorktree(
  root: string,
  at: WorktreeAt,
  keepCommits: boolean,
  into: string,
  keep: Keep,
  policy: ReleasePolicy
): Promise<Released> {
  const [held, branch] = await Promise.all([registrationOf(root, at.path), branchState(root, at)]);
  // A missing branch has no commits to keep (2026-11-01 review: it counted as 0, a silent default).
  if (held.t !== 'gone' && branch.t === 'present' && keepCommits && branch.shas.length > 0)
    return only({ t: 'kept', commits: branch.shas.length });
  const pinUnintegrated = async () => {
    const tip = await tipOf(root, `refs/heads/${at.branch}`);
    if (tip.t === 'missing' || tip.sha === at.baseSha || (await mergedInto(root, tip.sha, into)))
      return [];
    return [await salvage(root, keep.salvageRef, tip.sha)];
  };
  const removal = await removeTree(root, at, held, policy, keep, pinUnintegrated);
  return settle(
    removal,
    () => goneRelease(root, at),
    async () => dropAttemptBranch(root, at, branch, into)
  );
}

function dropAttemptBranch(root: string, at: WorktreeAt, branch: BranchState, into: string) {
  switch (branch.t) {
    case 'missing':
      return false;
    case 'present':
      return branch.shas.length === 0
        ? dropEmptyBranch(root, at)
        : dropBranch(root, at, (tip) => mergedInto(root, tip, into));
  }
}

/** A validation tree (R2): scratch and forced, after salvage and harvest; its branch goes. */
export async function discardWorktree(root: string, at: WorktreeAt, keep: Keep): Promise<Released> {
  const [held, branch] = await Promise.all([registrationOf(root, at.path), branchState(root, at)]);
  const pinTip = async () => {
    const tip = branch.t === 'present' ? branch.shas.at(-1) : undefined;
    return tip ? [await salvage(root, keep.salvageRef, tip)] : [];
  };
  const removal = await removeTree(root, at, held, { t: 'scratch' }, keep, pinTip);
  return settle(
    removal,
    () => goneRelease(root, at),
    () => dropBranch(root, at, () => true)
  );
}

export async function releaseIntegrationTree(
  root: string,
  tree: TreePath,
  keep: Keep,
  guard: Guard
) {
  const held = await registrationOf(root, tree.path);
  const removal = await removeTree(root, tree, held, guard, keep, async () => []);
  return settle(
    removal,
    async () => only({ t: 'absent' }),
    async () => false
  );
}

export const releaseDetachedTree = (root: string, dir: string, keep: Keep) =>
  releaseIntegrationTree(root, { path: dir, branch: '(detached)' }, keep, { t: 'scratch' });
