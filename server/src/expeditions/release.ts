import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  type BranchState,
  type GitRun,
  type Registration,
  branchState,
  cambium,
  git,
  registrationOf,
  removeGitOnly,
  snapshotDirty,
} from './git';
import type { Preserved, Release, WorktreeAt } from './ledger';

// Ending every expedition tree (design.md R1, R2, R11): one remove path, removeTree. Ported from oompa's Cambium
// `remove!` (lessons, design.md "Lessons from oompa"): a guard ladder decides whether a tree may
// go; once it passes, nothing a worker made can be lost, so removal is forced (a tree holding a
// submodule is refused by a plain `git worktree remove`, audit 2026-11-01 #9). Before removal:
//   - salvage: a tree whose branch has commits the expedition branch does not hold pins them at
//     refs/salvage/expeditions/<id>/<tree> (oompa run 9f004a39 deleted ~2.5 h of approved work);
//   - harvest: ignored run output (HARVEST_DIRS) is copied into the expedition's folder, because
//     `git status` omits ignored files, so a tree whose only new files were ignored output looked
//     clean and its removal deleted them (oompa swarm 455987ea lost a paid GPU run's raw gauges).
//   - under the retire policy, uncommitted changes are committed from a temporary index and pinned
//     at the tree's `-dirty` salvage ref (git.ts snapshotDirty), so retire never strands a tree.
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

/** How a guarded tree (an attempt's, the integration tree) is ended: `finish` refuses one with
 * uncommitted changes; `retire` ends it whatever it holds, snapshotting those changes first. */
export type ReleasePolicy = { t: 'finish' } | { t: 'retire' };
/** A scratch tree (a validation's, the manager's) skips the ladder: it is discarded forced. */
export type Guard = ReleasePolicy | { t: 'scratch' };

/** A forced remove deletes the whole tree: 124k files took ~15 min on the owner's machine, and
 * the 120 s query timeout killed removes partway (the emergent-beach incident, 2582 ` D`). */
export const REMOVE_TIMEOUT_MS = 15 * 60_000;

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

const exists = (file: string) =>
  fsp.lstat(file).then(
    () => true,
    () => false
  );

async function operationLeft(tree: string, marker: string): Promise<string | undefined> {
  const where = await git(tree, ['rev-parse', '--git-path', marker]);
  if (where.t === 'failed') return marker;
  const file = path.isAbsolute(where.stdout) ? where.stdout : path.join(tree, where.stdout);
  return (await exists(file)) ? marker : undefined;
}

/**
 * What `git status --porcelain=v2` shows in a tree. `tracked_deletions_only`: every line is a
 * deletion of a tracked file, which HEAD still holds, so removing the tree loses nothing (the
 * emergent-beach trees held 2582 ` D` lines after a killed remove had deleted half their files).
 * v2, not v1: git.ts trims stdout, which eats v1's leading space (` D a.txt` became `D a.txt`, a
 * staged deletion); v2 lines start with their kind (`1 .D …`, `? path`).
 */
export type DirtyKind =
  | { t: 'clean' }
  | { t: 'tracked_deletions_only'; lines: string[] }
  | { t: 'modified'; lines: string[] };

const DELETION = /^1 [.D][.D] /;

export function dirtyKind(porcelainV2: string): DirtyKind {
  const lines = porcelainV2.split('\n').filter(Boolean);
  if (lines.length === 0) return { t: 'clean' };
  return lines.every((line) => DELETION.test(line))
    ? { t: 'tracked_deletions_only', lines }
    : { t: 'modified', lines };
}

/** What the guard ladder reads in a tree before anything is removed. */
type Inspection =
  | { t: 'readable'; dirty: DirtyKind; blockers: string[] }
  | { t: 'unreadable'; reason: string };

/**
 * oompa's ladder in its order: git cannot read the tree, it is no longer on its own branch (when
 * that branch exists), or a merge/rebase/cherry-pick/revert is half-done in it. Uncommitted
 * changes are returned as a DirtyKind: what they block is the release policy's decision.
 */
async function inspect(tree: TreePath): Promise<Inspection> {
  const [status, on, branch] = await Promise.all([
    git(tree.path, ['status', '--porcelain=v2']),
    git(tree.path, ['symbolic-ref', '--quiet', 'HEAD']),
    git(tree.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${tree.branch}`]),
  ]);
  if (status.t === 'failed')
    return { t: 'unreadable', reason: `git status failed: ${status.message}` };
  const operations = await Promise.all(OPERATIONS.map((m) => operationLeft(tree.path, m)));
  const offBranch =
    branch.t === 'ok' && (on.t !== 'ok' || on.stdout !== `refs/heads/${tree.branch}`);
  return {
    t: 'readable',
    dirty: dirtyKind(status.stdout),
    blockers: [
      offBranch ? `the tree is no longer on ${tree.branch}` : '',
      ...operations.flatMap((m) => (m ? [`a git operation is half-done (${m})`] : [])),
    ].filter(Boolean),
  };
}

const uncommitted = (lines: string[]) => `uncommitted changes: ${lines.slice(0, 5).join('; ')}`;

/** Whether the ladder lets a tree go, and what was pinned so it could. */
type Clearance = { t: 'clear'; preserved: Preserved[] } | { t: 'blocked'; reason: string };

/** Finish never removes uncommitted work: any change, a deletion included, leaves the tree. */
function finishDirty(dirty: DirtyKind): string[] {
  switch (dirty.t) {
    case 'clean':
      return [];
    case 'tracked_deletions_only':
    case 'modified':
      return [uncommitted(dirty.lines)];
  }
}

/** Retire ends the tree whatever it holds: deletions only lose nothing; anything else is first
 * committed from a temporary index and pinned at the tree's dirty salvage ref. */
async function retireDirty(tree: TreePath, dirty: DirtyKind, keep: Keep): Promise<Preserved[]> {
  switch (dirty.t) {
    case 'clean':
    case 'tracked_deletions_only':
      return [];
    case 'modified': {
      const ref = dirtyRefOf(keep);
      const sha = await snapshotDirty(
        tree.path,
        ref,
        `expedition retire: uncommitted changes in ${tree.path}`
      );
      return [{ t: 'salvaged', ref, sha }];
    }
  }
}

/**
 * Where a retired tree's uncommitted changes are pinned. A sibling of the salvage ref, not under
 * it (plan: `<tree>/dirty`): git cannot hold both `…/<tree>` and `…/<tree>/dirty`, and a tree with
 * unintegrated commits already has `…/<tree>`.
 */
export const dirtyRefOf = (keep: Keep) => `${keep.salvageRef}-dirty`;

/** The thin dispatcher over the guard: one handler per policy. */
async function clearance(tree: TreePath, guard: Guard, keep: Keep): Promise<Clearance> {
  switch (guard.t) {
    case 'scratch':
      return { t: 'clear', preserved: [] };
    case 'finish': {
      const seen = await inspect(tree);
      if (seen.t === 'unreadable') return { t: 'blocked', reason: seen.reason };
      const blockers = [...finishDirty(seen.dirty), ...seen.blockers];
      return blockers.length === 0
        ? { t: 'clear', preserved: [] }
        : { t: 'blocked', reason: blockers.join('; ') };
    }
    case 'retire': {
      const seen = await inspect(tree);
      if (seen.t === 'unreadable') return { t: 'blocked', reason: seen.reason };
      if (seen.blockers.length > 0) return { t: 'blocked', reason: seen.blockers.join('; ') };
      return { t: 'clear', preserved: await retireDirty(tree, seen.dirty, keep) };
    }
  }
}

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

/** What removing one tree did. Its branch is the caller's: only the files and registration go. */
export type Removal =
  | { t: 'removed'; preserved: Preserved[] }
  | { t: 'gone' }
  | { t: 'left'; reason: string; preserved: Preserved[] };

/** The tree being removed: its directory and the branch it should be on (the guard ladder's). */
export type TreePath = Pick<WorktreeAt, 'path' | 'branch'>;

/** Pins the caller's commits once the ladder has cleared the tree (salvage before removal). */
type PinFirst = () => Promise<Preserved[]>;
const pinNothing: PinFirst = async () => [];

/**
 * The one remove path (audit 2026-11-01 #9 and the emergent-beach incident: a plain remove with
 * the 120 s query timeout refused submodules and was killed mid-delete on a 124k-file tree).
 * Dispatches on who holds the tree; each holder is removed forced, with REMOVE_TIMEOUT_MS, after
 * the guard ladder, the salvage pins and the harvest.
 */
export async function removeTree(
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
        cambium(root, ['remove', '-force', held.name], REMOVE_TIMEOUT_MS)
      );
    case 'git_only':
      return removeHeld(tree, guard, keep, pinFirst, () =>
        removeGitOnly(root, held.path, REMOVE_TIMEOUT_MS)
      );
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
  // A registration whose directory a killed remove already deleted: nothing on disk to guard or
  // harvest, so only the registration goes (its branch commits are still pinned first).
  if (!(await exists(tree.path))) {
    const pinned = await pinFirst();
    return removed(await remove(), pinned);
  }
  const cleared = await clearance(tree, guard, keep);
  if (cleared.t === 'blocked') return { t: 'left', reason: cleared.reason, preserved: [] };
  const preserved = [...cleared.preserved, ...(await pinFirst())];
  const harvested = await harvest(tree.path, keep.harvestDir);
  switch (harvested.t) {
    case 'refused':
      return { t: 'left', reason: harvested.reason, preserved };
    case 'copied':
      return removed(await remove(), [...preserved, harvested.preserved]);
    case 'none':
      return removed(await remove(), preserved);
  }
}

const removed = (ran: GitRun, preserved: Preserved[]): Removal =>
  ran.t === 'failed' ? { t: 'left', reason: ran.message, preserved } : { t: 'removed', preserved };

/**
 * No registration holds the path. Nothing there: `gone`. A directory there may be a create
 * interrupted before it registered: `cambium recover` rolls that back. A directory that is still
 * there is not a worktree, and the host never deletes a directory git does not vouch for.
 */
async function goneTree(root: string, tree: TreePath): Promise<Removal> {
  if (!(await exists(tree.path))) return { t: 'gone' };
  await cambium(root, ['recover', '--json']);
  return (await exists(tree.path))
    ? { t: 'left', reason: `${tree.path} remains but is not a registered worktree`, preserved: [] }
    : { t: 'gone' };
}

/** A removal's release for a tree whose branch stays as it is (the integration tree, whose
 * branch is the expedition's result, and the manager's detached tree, which has none). */
function treeOnly(removal: Removal): Released {
  switch (removal.t) {
    case 'removed':
      return { release: { t: 'removed', branchDeleted: false }, preserved: removal.preserved };
    case 'gone':
      return only({ t: 'absent' });
    case 'left':
      return { release: { t: 'left', reason: removal.reason }, preserved: removal.preserved };
  }
}

/**
 * No registration and no directory: `absent` when the branch is gone too (never made, or a
 * replayed release); a branch alone is a removal interrupted before its branch was dropped,
 * dropped now if it is empty.
 */
async function goneRelease(root: string, at: WorktreeAt): Promise<Released> {
  const branch = await branchState(root, at);
  switch (branch.t) {
    case 'missing':
      return only({ t: 'absent' });
    case 'present':
      return only({
        t: 'removed',
        branchDeleted: branch.shas.length === 0 && (await dropEmptyBranch(root, at)),
      });
  }
}

/**
 * Ends an attempt's worktree. No commits beyond its base: remove it and its branch. Commits and
 * `keepCommits`: keep it (integration may need it). Commits at the end: remove the tree (salvage
 * pinned first when the expedition branch does not hold them), and its branch only when the
 * expedition branch `into` already holds its tip; unmerged commits keep their branch for the
 * owner. Under `finish` a tree the guard ladder refuses (uncommitted changes, off its branch, an
 * operation half-done, unharvestable output) is recorded `left`, never forced; under `retire`
 * uncommitted changes are snapshotted and the tree goes.
 */
export async function releaseWorktree(
  root: string,
  at: WorktreeAt,
  keepCommits: boolean,
  into: string,
  keep: Keep,
  policy: ReleasePolicy
): Promise<Released> {
  const [held, branch] = await Promise.all([registrationOf(root, at.path), branchState(root, at)]);
  const kept = keptRelease(held, branch, keepCommits);
  if (kept) return only(kept);
  const pinUnintegrated = async () => {
    const tip = await unintegratedTip(root, at, into);
    return tip ? [await salvage(root, keep.salvageRef, tip)] : [];
  };
  const removal = await removeTree(root, at, held, policy, keep, pinUnintegrated);
  switch (removal.t) {
    case 'gone':
      return goneRelease(root, at);
    case 'left':
      return { release: { t: 'left', reason: removal.reason }, preserved: removal.preserved };
    case 'removed':
      return {
        release: { t: 'removed', branchDeleted: await dropAttemptBranch(root, at, branch, into) },
        preserved: removal.preserved,
      };
  }
}

/** After removal: an empty branch goes; one whose tip `into` holds goes; unmerged commits stay. */
async function dropAttemptBranch(
  root: string,
  at: WorktreeAt,
  branch: BranchState,
  into: string
): Promise<boolean> {
  switch (branch.t) {
    case 'missing':
      return false;
    case 'present':
      return branch.shas.length === 0
        ? dropEmptyBranch(root, at)
        : dropMergedBranch(root, at, into);
  }
}

/** A registered tree kept for its commits (absent: it is not kept). A missing branch has no
 * commits to keep: the guard ladder decides that tree like any other (2026-11-01 review: it
 * counted as a branch with 0 commits, a silent default). A tree no registration holds is not kept
 * either: there is nothing left to keep but its branch. */
function keptRelease(
  held: Registration,
  branch: BranchState,
  keepCommits: boolean
): Release | undefined {
  switch (held.t) {
    case 'gone':
      return undefined;
    case 'cambium':
    case 'git_only':
      switch (branch.t) {
        case 'present':
          return keepCommits && branch.shas.length > 0
            ? { t: 'kept', commits: branch.shas.length }
            : undefined;
        case 'missing':
          return undefined;
      }
  }
}

/**
 * Discards a validation tree (design.md R2): scratch, so a check's build outputs or edits are
 * removed with `--force`, and its branch with them. Commits a check made there are a by-product,
 * never work, but they are salvaged before the branch goes (deleting is never the only copy), and
 * the check's ignored output is harvested first (a paid run's outputs outlive its tree).
 */
export async function discardWorktree(root: string, at: WorktreeAt, keep: Keep): Promise<Released> {
  const [held, branch] = await Promise.all([registrationOf(root, at.path), branchState(root, at)]);
  const pinTip = async () => {
    const tip = branch.t === 'present' ? branch.shas.at(-1) : undefined;
    return tip ? [await salvage(root, keep.salvageRef, tip)] : [];
  };
  const removal = await removeTree(root, at, held, { t: 'scratch' }, keep, pinTip);
  switch (removal.t) {
    case 'gone':
      return goneRelease(root, at);
    case 'left':
      return { release: { t: 'left', reason: removal.reason }, preserved: removal.preserved };
    case 'removed':
      return {
        release: { t: 'removed', branchDeleted: await dropScratchBranch(root, at) },
        preserved: removal.preserved,
      };
  }
}

/**
 * Removes the integration tree and keeps its branch: the branch is the expedition's result,
 * which the owner merges. Under `finish` a tree with uncommitted changes is `left`; the remove is
 * forced once the ladder passes (a plain remove refused a tree holding a submodule).
 */
export async function releaseIntegrationTree(
  root: string,
  tree: TreePath,
  keep: Keep,
  policy: ReleasePolicy
): Promise<Released> {
  const held = await registrationOf(root, tree.path);
  return treeOnly(await removeTree(root, tree, held, policy, keep, pinNothing));
}

/** Removes the manager's detached tree (design.md R11): scratch, read-only by contract. */
export async function releaseDetachedTree(
  root: string,
  dir: string,
  keep: Keep
): Promise<Released> {
  const tree = { path: dir, branch: '(detached)' };
  const held = await registrationOf(root, dir);
  return treeOnly(await removeTree(root, tree, held, { t: 'scratch' }, keep, pinNothing));
}
