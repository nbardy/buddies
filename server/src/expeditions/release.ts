import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type BranchState,
  branchState,
  cambium,
  cambiumWorkspace,
  describe,
  git,
  nothingLeft,
  recoverLeftovers,
} from './git';
import type { Preserved, Release, WorktreeAt } from './ledger';

// Ending a worker's or a validation's tree (design.md R1, R2, R11). Ported from oompa's Cambium
// `remove!` (lessons, design.md "Lessons from oompa"): a guard ladder decides whether a tree may
// go; once it passes, nothing a worker made can be lost, so removal is forced (a tree holding a
// submodule is refused by a plain `git worktree remove`, audit 2026-11-01 #9). Before removal:
//   - salvage: a tree whose branch has commits the expedition branch does not hold pins them at
//     refs/salvage/expeditions/<id>/<tree> (oompa run 9f004a39 deleted ~2.5 h of approved work);
//   - harvest: ignored run output (HARVEST_DIRS) is copied into the expedition's folder, because
//     `git status` omits ignored files, so a tree whose only new files were ignored output looked
//     clean and its removal deleted them (oompa swarm 455987ea lost a paid GPU run's raw gauges).
// Each preservation is returned as data and recorded in the same batch as the release.

/** Where an ending tree's leftovers go: its salvage ref and its harvest folder. */
export interface Keep {
  salvageRef: string;
  harvestDir: string;
}

export interface Released {
  release: Release;
  preserved: Preserved[];
}

const only = (release: Release): Released => ({ release, preserved: [] });

/** Ignored output worth keeping, repo-relative (the wave_sim convention oompa harvests too). */
export const HARVEST_DIRS = ['output'];
/** A harvest larger than this is refused and the tree is left for the owner (never truncated). */
export const HARVEST_MAX_BYTES = 512 * 1024 * 1024;
const HARVEST_MAX_FILES = 10_000;
/** Markers of a git operation left half-done in a tree (oompa's `:in-progress` rung). */
const OPERATIONS = [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
];

/** Deletes a scratch branch at whatever tip it has (compare-and-delete at the tip read). */
async function dropScratchBranch(root: string, at: WorktreeAt): Promise<boolean> {
  const ref = `refs/heads/${at.branch}`;
  const tip = await git(root, ['rev-parse', '--verify', '--quiet', ref]);
  return tip.t === 'ok' && (await git(root, ['update-ref', '-d', ref, tip.stdout])).t === 'ok';
}

/**
 * Deletes a branch only while it still points at its base: `update-ref -d <ref> <old>` is an
 * atomic compare-and-delete, so a branch with commits is never deleted. Not `cambium remove
 * --delete-branch`: that runs `git branch -d`, which refuses a branch whose base is not merged
 * into the owner's HEAD (every check tree's base is an unmerged candidate commit).
 */
async function dropEmptyBranch(root: string, at: WorktreeAt): Promise<boolean> {
  const dropped = await git(root, ['update-ref', '-d', `refs/heads/${at.branch}`, at.baseSha]);
  return dropped.t === 'ok';
}

/** The branch tip when it holds commits `into` (the expedition branch) does not: unintegrated. */
async function unintegratedTip(root: string, at: WorktreeAt, into: string) {
  const tip = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${at.branch}`]);
  if (tip.t === 'failed' || tip.stdout === at.baseSha) return undefined;
  const merged = await git(root, ['merge-base', '--is-ancestor', tip.stdout, `refs/heads/${into}`]);
  return merged.t === 'ok' ? undefined : tip.stdout;
}

/**
 * Deletes a branch whose tip is already in `into` (the expedition branch): its commits are kept
 * there, so the per-attempt branch is only clutter in the owner's repository. Compare-and-delete
 * at the tip just read, so a branch that moved is never deleted.
 */
async function dropMergedBranch(root: string, at: WorktreeAt, into: string): Promise<boolean> {
  const ref = `refs/heads/${at.branch}`;
  const tip = await git(root, ['rev-parse', '--verify', '--quiet', ref]);
  if (tip.t === 'failed') return false;
  const merged = await git(root, ['merge-base', '--is-ancestor', tip.stdout, `refs/heads/${into}`]);
  if (merged.t === 'failed') return false;
  return (await git(root, ['update-ref', '-d', ref, tip.stdout])).t === 'ok';
}

/** Pins `sha` at the salvage ref before anything that names it is deleted. */
async function salvage(root: string, ref: string, sha: string): Promise<Preserved> {
  const pinned = await git(root, ['update-ref', ref, sha]);
  if (pinned.t === 'failed') throw new Error(`could not pin ${ref}: ${pinned.message}`);
  return { t: 'salvaged', ref, sha };
}

/**
 * Why a worker's tree may not be removed (empty: it may), oompa's ladder in its order: git cannot
 * read it, it has uncommitted or untracked changes, it is no longer on its own branch (when that
 * branch exists), or a merge/rebase/cherry-pick/revert is half-done in it.
 */
async function removalBlockers(at: WorktreeAt, branch: BranchState): Promise<string[]> {
  const [status, on] = await Promise.all([
    git(at.path, ['status', '--porcelain']),
    git(at.path, ['symbolic-ref', '--quiet', 'HEAD']),
  ]);
  if (status.t === 'failed') return [`git status failed: ${status.message}`];
  const operations = await Promise.all(OPERATIONS.map((m) => operationLeft(at.path, m)));
  const offBranch =
    branch.t === 'present' && (on.t !== 'ok' || on.stdout !== `refs/heads/${at.branch}`);
  return [
    status.stdout === ''
      ? ''
      : `uncommitted changes: ${status.stdout.split('\n').slice(0, 5).join('; ')}`,
    offBranch ? `the tree is no longer on ${at.branch}` : '',
    ...operations.flatMap((m) => (m ? [`a git operation is half-done (${m})`] : [])),
  ].filter(Boolean);
}

async function operationLeft(tree: string, marker: string): Promise<string | undefined> {
  const where = await git(tree, ['rev-parse', '--git-path', marker]);
  if (where.t === 'failed') return marker;
  const file = path.isAbsolute(where.stdout) ? where.stdout : path.join(tree, where.stdout);
  return (await exists(file)) ? marker : undefined;
}

const exists = (file: string) =>
  fsp.lstat(file).then(
    () => true,
    () => false
  );

type Harvest =
  | { t: 'none' }
  | { t: 'copied'; preserved: Preserved }
  | { t: 'refused'; reason: string };

/**
 * Copies the tree's ignored files under HARVEST_DIRS into `dest` at the same relative paths
 * (copy-on-write where the filesystem clones). Regular files only; a harvest over the bounds is
 * refused whole, so the caller keeps the tree rather than half its output.
 */
async function harvest(tree: string, dest: string): Promise<Harvest> {
  const listed = await git(tree, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    ...HARVEST_DIRS,
  ]);
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

/** Harvests, then force-removes a registered tree whose guards passed. */
async function harvestAndRemove(
  root: string,
  name: string,
  at: WorktreeAt,
  keep: Keep,
  preserved: Preserved[]
): Promise<{ t: 'removed'; preserved: Preserved[] } | { t: 'left'; released: Released }> {
  const harvested = await harvest(at.path, keep.harvestDir);
  switch (harvested.t) {
    case 'refused':
      return {
        t: 'left',
        released: { release: { t: 'left', reason: harvested.reason }, preserved },
      };
    case 'copied':
      preserved.push(harvested.preserved);
      break;
    case 'none':
      break;
  }
  const removed = await cambium(root, ['remove', '-force', name]);
  return removed.t === 'failed'
    ? { t: 'left', released: { release: { t: 'left', reason: removed.message }, preserved } }
    : { t: 'removed', preserved };
}

/**
 * Ends an attempt's worktree. No commits beyond its base: remove it and its branch. Commits and
 * `keepCommits`: keep it (integration may need it). Commits at the end: remove the tree (salvage
 * pinned first when the expedition branch does not hold them), and its branch only when the
 * expedition branch `into` already holds its tip; unmerged commits keep their branch for the
 * owner. A tree the guard ladder refuses (uncommitted changes, off its branch, an operation
 * half-done, unharvestable output) is recorded `left`, never forced.
 */
export async function releaseWorktree(
  root: string,
  name: string,
  at: WorktreeAt,
  keepCommits: boolean,
  into: string,
  keep: Keep
): Promise<Released> {
  if (!(await cambiumWorkspace(root, name))) return only(await releaseUnregistered(root, at));
  const branch = await branchState(root, at);
  const kept = keptRelease(branch, keepCommits);
  if (kept) return only(kept);
  const blockers = await removalBlockers(at, branch);
  if (blockers.length > 0) return only({ t: 'left', reason: blockers.join('; ') });
  const tip = await unintegratedTip(root, at, into);
  const preserved = tip ? [await salvage(root, keep.salvageRef, tip)] : [];
  const removed = await harvestAndRemove(root, name, at, keep, preserved);
  if (removed.t === 'left') return removed.released;
  switch (branch.t) {
    case 'missing':
      return { release: { t: 'removed', branchDeleted: false }, preserved: removed.preserved };
    case 'present': {
      const branchDeleted =
        branch.shas.length === 0
          ? await dropEmptyBranch(root, at)
          : await dropMergedBranch(root, at, into);
      return { release: { t: 'removed', branchDeleted }, preserved: removed.preserved };
    }
  }
}

/** A tree kept for its commits (absent: it is not kept). A missing branch has no commits to
 * keep: the guard ladder decides that tree like any other (2026-11-01 review: it counted as a
 * branch with 0 commits, a silent default). */
function keptRelease(branch: BranchState, keepCommits: boolean): Release | undefined {
  switch (branch.t) {
    case 'present':
      return keepCommits && branch.shas.length > 0
        ? { t: 'kept', commits: branch.shas.length }
        : undefined;
    case 'missing':
      return undefined;
  }
}

/**
 * No Cambium workspace by that name. Nothing on disk: `absent` (never made, or a replayed
 * release). A partial create's branch and directory are rolled back by `cambium recover`. A branch
 * alone is a removal interrupted before its branch was dropped: dropped now if it is empty.
 */
async function releaseUnregistered(root: string, at: WorktreeAt): Promise<Release> {
  const left = await recoverLeftovers(root, at);
  if (nothingLeft(left)) return { t: 'absent' };
  if (left.dir)
    return { t: 'left', reason: `no Cambium workspace, but ${describe(left, at)} remain` };
  const branch = await branchState(root, at);
  const empty = branch.t === 'present' && branch.shas.length === 0;
  return { t: 'removed', branchDeleted: empty && (await dropEmptyBranch(root, at)) };
}

/**
 * Discards a validation tree (design.md R2): scratch, so a check's build outputs or edits are
 * removed with `--force`, and its branch with them. Commits a check made there are a by-product,
 * never work, but they are salvaged before the branch goes (deleting is never the only copy), and
 * the check's ignored output is harvested first (a paid run's outputs outlive its tree).
 */
export async function discardWorktree(
  root: string,
  name: string,
  at: WorktreeAt,
  keep: Keep
): Promise<Released> {
  if (!(await cambiumWorkspace(root, name))) return only(await releaseUnregistered(root, at));
  const branch = await branchState(root, at);
  const tip = branch.t === 'present' ? branch.shas.at(-1) : undefined;
  const preserved = tip ? [await salvage(root, keep.salvageRef, tip)] : [];
  const removed = await harvestAndRemove(root, name, at, keep, preserved);
  if (removed.t === 'left') return removed.released;
  return {
    release: { t: 'removed', branchDeleted: await dropScratchBranch(root, at) },
    preserved: removed.preserved,
  };
}
