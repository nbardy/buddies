import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ClaimChange } from './charter';
import type { Release, Repo, WorktreeAt } from './ledger';

// The expedition's git I/O: preflight, the expedition branch, one Cambium worktree per work attempt.
// Pattern: async-liveness (docs/patterns.md#async-liveness) — every call is an async execFile; a
// tick never blocks the server loop on git.
// Pattern: idempotency-keys — every write first looks for its own earlier result (the branch, the
// Cambium workspace by name) and adopts it, and rolls back a partial one (`cambium recover`), so
// replaying an effect after a crash is harmless.
// Cambium keeps its registry inside the repository (`.git/cambium`), so tests use the real tool on
// a temporary repository.

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
/** `cambium add` copies the tree: 15–32 s for 20k files, so a 124k-file repo needs minutes. A
 * timeout kills it partway; ensureWorktree recovers that and records a typed failure. */
const ADD_TIMEOUT_MS = 15 * 60_000;

type GitRun = { t: 'ok'; stdout: string } | { t: 'failed'; message: string };

async function run(
  bin: 'git' | 'git-cambium',
  cwd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS
): Promise<GitRun> {
  try {
    const { stdout } = await exec(bin, args, {
      cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { t: 'ok', stdout: stdout.trim() };
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    return { t: 'failed', message: (e.stderr || e.message).trim().slice(-600) };
  }
}

const git = (cwd: string, args: string[]) => run('git', cwd, args);
/** Cambium runs as `git-cambium` itself, not through `git cambium`: a timeout must kill the process
 * doing the work, not a `git` wrapper whose child would finish the add after we recorded failure. */
const cambium = (cwd: string, args: string[], timeout = GIT_TIMEOUT_MS) =>
  run('git-cambium', cwd, args, timeout);

async function must(ran: Promise<GitRun>, what: string): Promise<string> {
  const done = await ran;
  if (done.t === 'failed') throw new Error(`${what} failed: ${done.message}`);
  return done.stdout;
}

/** Launch preflight (κ at the boundary, design.md R4, minimal): a refusal names every reason. */
export type Preflight =
  | { t: 'ready'; root: string; baseSha: string }
  | { t: 'refused'; reasons: string[] };

export async function preflight(workspaceRoot: string): Promise<Preflight> {
  const [top, head, tool] = await Promise.all([
    git(workspaceRoot, ['rev-parse', '--show-toplevel']),
    git(workspaceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    cambium(workspaceRoot, ['version']),
  ]);
  if (top.t === 'ok' && head.t === 'ok' && tool.t === 'ok')
    return { t: 'ready', root: top.stdout, baseSha: head.stdout };
  const reasons = [
    top.t === 'failed' ? `workspace root ${workspaceRoot} is not a git repository` : '',
    head.t === 'failed' ? 'the base commit (HEAD) does not resolve' : '',
    tool.t === 'failed' ? '`git cambium` is not available' : '',
  ].filter(Boolean);
  return { t: 'refused', reasons };
}

/** Creates the expedition branch at its base; an existing one is a replay and is adopted. */
export async function ensureBranch(repo: Repo): Promise<void> {
  const existing = await git(repo.root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${repo.branch}`,
  ]);
  if (existing.t === 'ok') return;
  await must(git(repo.root, ['branch', repo.branch, repo.baseSha]), `git branch ${repo.branch}`);
}

export const branchHead = (repo: Repo) =>
  must(
    git(repo.root, ['rev-parse', '--verify', `refs/heads/${repo.branch}^{commit}`]),
    `the head of ${repo.branch}`
  );

const CambiumWorkspace = z.object({
  name: z.string(),
  status: z.string(),
  path: z.string(),
  branch: z.string(),
  base_commit: z.string(),
});

async function cambiumWorkspace(root: string, name: string) {
  const listed = z
    .array(CambiumWorkspace.passthrough())
    .parse(JSON.parse(await must(cambium(root, ['list', '--json']), 'cambium list')));
  return listed.find((w) => w.name === name);
}

/** What an interrupted `cambium add` can leave with no registry entry: its branch, its path. */
interface Leftovers {
  branch: boolean;
  dir: boolean;
}
const nothingLeft = (l: Leftovers) => !l.branch && !l.dir;
const describe = (l: Leftovers, at: WorktreeAt) =>
  [l.branch ? `branch ${at.branch}` : '', l.dir ? `directory ${at.path}` : '']
    .filter(Boolean)
    .join(' and ');

async function leftovers(root: string, at: WorktreeAt): Promise<Leftovers> {
  const [branch, dir] = await Promise.all([
    git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${at.branch}`]),
    fsp.lstat(at.path).then(
      () => true,
      () => false
    ),
  ]);
  return { branch: branch.t === 'ok', dir };
}

/**
 * Rolls back what an interrupted `cambium add` left behind. Cambium journals each create, and
 * `cambium recover` removes an incomplete one's linked worktree and unadvanced branch (it leaves
 * operations whose process is still alive alone). Returns what is still there afterwards.
 */
async function recoverLeftovers(root: string, at: WorktreeAt): Promise<Leftovers> {
  const before = await leftovers(root, at);
  if (nothingLeft(before)) return before;
  await cambium(root, ['recover', '--json']);
  return leftovers(root, at);
}

/** The worktree `ensureWorktree` produced: ready, or a typed failure the ledger records. */
export type MadeWorktree = { t: 'ready'; at: WorktreeAt } | { t: 'failed'; reason: string };

/**
 * The attempt's worktree, created at `plan.baseSha` or adopted by its Cambium name after a crash
 * between create and record. An adopted workspace must match the intent (ready, same branch and
 * base). A create interrupted partway (killed process, timeout) leaves a branch and directory
 * with no registry entry (reproduced: SIGKILL during a 20k-file add); those are recovered before
 * adding, and a failed add is recovered too, so a replay never meets "branch already exists".
 * Anything Cambium cannot make or roll back is a typed failure, never a tick that throws forever.
 */
export async function ensureWorktree(
  root: string,
  name: string,
  plan: WorktreeAt
): Promise<MadeWorktree> {
  const base = await git(root, ['rev-parse', '--verify', `${plan.baseSha}^{commit}`]);
  if (base.t === 'failed') return { t: 'failed', reason: `commit ${plan.baseSha} does not exist` };
  const prior = await cambiumWorkspace(root, name);
  if (prior) return adopted(prior, { ...plan, baseSha: base.stdout });
  const stuck = await recoverLeftovers(root, plan);
  if (!nothingLeft(stuck))
    return { t: 'failed', reason: `cambium recover left ${describe(stuck, plan)}` };
  const add = await cambium(
    root,
    ['add', '-b', plan.branch, '-name', name, '-ephemeral', plan.path, base.stdout],
    ADD_TIMEOUT_MS
  );
  if (add.t === 'failed') {
    const left = await recoverLeftovers(root, plan);
    const note = nothingLeft(left) ? '' : ` (still on disk: ${describe(left, plan)})`;
    return { t: 'failed', reason: `cambium add failed: ${add.message}${note}` };
  }
  const made = await cambiumWorkspace(root, name);
  if (!made) return { t: 'failed', reason: `cambium add ${name} left no workspace` };
  return adopted(made, { ...plan, baseSha: base.stdout });
}

function adopted(w: z.infer<typeof CambiumWorkspace>, plan: WorktreeAt): MadeWorktree {
  const mismatch = [
    w.status === 'ready' ? '' : `status ${w.status}`,
    w.branch === plan.branch ? '' : `branch ${w.branch} (expected ${plan.branch})`,
    w.base_commit === plan.baseSha ? '' : `base ${w.base_commit} (expected ${plan.baseSha})`,
  ].filter(Boolean);
  return mismatch.length === 0
    ? { t: 'ready', at: { path: w.path, branch: w.branch, baseSha: w.base_commit } }
    : { t: 'failed', reason: `Cambium workspace ${w.name} does not match: ${mismatch.join(', ')}` };
}

/** A worktree branch's commits beyond its base (`missing`: no such branch). */
type BranchState = { t: 'missing' } | { t: 'present'; commits: number };

async function branchState(root: string, at: WorktreeAt): Promise<BranchState> {
  const ref = `refs/heads/${at.branch}`;
  const exists = await git(root, ['rev-parse', '--verify', '--quiet', ref]);
  if (exists.t === 'failed') return { t: 'missing' };
  const count = await must(
    git(root, ['rev-list', '--count', `${at.baseSha}..${ref}`]),
    `counting ${at.branch} commits`
  );
  return { t: 'present', commits: Number(count) };
}

/** Whether a work claim's `change` is what its attempt branch holds (design.md R2). */
export type ClaimHeld = { t: 'held' } | { t: 'not_held'; reason: string };

/**
 * The host checks a claim against its own attempt branch instead of trusting its word: a `commit`
 * must be a new commit on that branch (an ancestor of its tip, not of its base), so a claim cannot
 * name the head or another attempt's passing commit; `no_code` means the branch has no commits, so
 * an attempt that committed cannot skip candidate validation by saying it changed nothing.
 */
export async function claimHeld(
  root: string,
  at: WorktreeAt,
  change: ClaimChange
): Promise<ClaimHeld> {
  switch (change.t) {
    case 'commit': {
      const ref = `refs/heads/${at.branch}`;
      const [onBranch, inBase] = await Promise.all([
        git(root, ['merge-base', '--is-ancestor', change.sha, ref]),
        git(root, ['merge-base', '--is-ancestor', change.sha, at.baseSha]),
      ]);
      return onBranch.t === 'ok' && inBase.t === 'failed'
        ? { t: 'held' }
        : {
            t: 'not_held',
            reason: `claimed commit ${change.sha} is not a new commit on the attempt branch ${at.branch}`,
          };
    }
    case 'no_code': {
      const branch = await branchState(root, at);
      const commits = branch.t === 'present' ? branch.commits : 0;
      return commits === 0
        ? { t: 'held' }
        : {
            t: 'not_held',
            reason: `claimed no code, but the attempt branch ${at.branch} has ${commits} commit(s)`,
          };
    }
  }
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

/**
 * Ends an attempt's worktree. No commits beyond its base: remove it and its branch. Commits and
 * `keepCommits`: keep it (integration may need it). Commits at the end: remove the tree but never
 * the branch. A refused removal (uncommitted changes) is recorded, never forced.
 */
export async function releaseWorktree(
  root: string,
  name: string,
  at: WorktreeAt,
  keepCommits: boolean
): Promise<Release> {
  if (!(await cambiumWorkspace(root, name))) return releaseUnregistered(root, at);
  const branch = await branchState(root, at);
  const commits = branch.t === 'present' ? branch.commits : 0;
  if (commits > 0 && keepCommits) return { t: 'kept', commits };
  const removed = await cambium(root, ['remove', name]);
  if (removed.t === 'failed') return { t: 'left', reason: removed.message };
  return { t: 'removed', branchDeleted: commits === 0 && (await dropEmptyBranch(root, at)) };
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
  const empty = branch.t === 'present' && branch.commits === 0;
  return { t: 'removed', branchDeleted: empty && (await dropEmptyBranch(root, at)) };
}

/**
 * Discards a validation tree (design.md R2): scratch, so a check's build outputs or edits are
 * removed with `--force`; its branch is dropped only while it still points at its base (a check
 * that committed keeps its branch, reported as `branchDeleted: false`).
 */
export async function discardWorktree(
  root: string,
  name: string,
  at: WorktreeAt
): Promise<Release> {
  if (!(await cambiumWorkspace(root, name))) return releaseUnregistered(root, at);
  const removed = await cambium(root, ['remove', '-force', name]);
  if (removed.t === 'failed') return { t: 'left', reason: removed.message };
  return { t: 'removed', branchDeleted: await dropEmptyBranch(root, at) };
}
