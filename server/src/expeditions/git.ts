import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Release, Repo, WorktreeAt } from './ledger';

// The expedition's git I/O: preflight, the expedition branch, one Cambium worktree per work attempt.
// Pattern: async-liveness (docs/patterns.md#async-liveness) — every call is an async execFile; a
// tick never blocks the server loop on git.
// Pattern: idempotency-keys — every write first looks for its own earlier result (the branch, the
// Cambium workspace by name) and adopts it, so replaying an effect after a crash is harmless.
// Cambium keeps its registry inside the repository (`.git/cambium`), so tests use the real tool on
// a temporary repository.

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

type GitRun = { t: 'ok'; stdout: string } | { t: 'failed'; message: string };

async function git(cwd: string, args: string[]): Promise<GitRun> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { t: 'ok', stdout: stdout.trim() };
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    return { t: 'failed', message: (e.stderr || e.message).trim().slice(-600) };
  }
}

async function must(cwd: string, args: string[]): Promise<string> {
  const run = await git(cwd, args);
  if (run.t === 'failed') throw new Error(`git ${args.join(' ')} failed: ${run.message}`);
  return run.stdout;
}

/** Launch preflight (κ at the boundary, design.md R4, minimal): a refusal names every reason. */
export type Preflight =
  | { t: 'ready'; root: string; baseSha: string }
  | { t: 'refused'; reasons: string[] };

export async function preflight(workspaceRoot: string): Promise<Preflight> {
  const [top, head, cambium] = await Promise.all([
    git(workspaceRoot, ['rev-parse', '--show-toplevel']),
    git(workspaceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(workspaceRoot, ['cambium', 'version']),
  ]);
  if (top.t === 'ok' && head.t === 'ok' && cambium.t === 'ok')
    return { t: 'ready', root: top.stdout, baseSha: head.stdout };
  const reasons = [
    top.t === 'failed' ? `workspace root ${workspaceRoot} is not a git repository` : '',
    head.t === 'failed' ? 'the base commit (HEAD) does not resolve' : '',
    cambium.t === 'failed' ? '`git cambium` is not available' : '',
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
  await must(repo.root, ['branch', repo.branch, repo.baseSha]);
}

export const branchHead = (repo: Repo) =>
  must(repo.root, ['rev-parse', '--verify', `refs/heads/${repo.branch}^{commit}`]);

const CambiumWorkspace = z.object({
  name: z.string(),
  path: z.string(),
  branch: z.string(),
  base_commit: z.string(),
});

async function cambiumWorkspace(root: string, name: string) {
  const listed = z
    .array(CambiumWorkspace.passthrough())
    .parse(JSON.parse(await must(root, ['cambium', 'list', '--json'])));
  return listed.find((w) => w.name === name);
}

/**
 * The attempt's worktree, created from `plan.baseSha` or, after a crash between create and record,
 * adopted by its Cambium name. Either way the path/branch/base come from Cambium's own record.
 */
export async function ensureWorktree(
  root: string,
  name: string,
  plan: WorktreeAt
): Promise<WorktreeAt> {
  const prior = await cambiumWorkspace(root, name);
  if (!prior)
    await must(root, [
      'cambium',
      'add',
      '-b',
      plan.branch,
      '-name',
      name,
      '-ephemeral',
      plan.path,
      plan.baseSha,
    ]);
  const made = prior ?? (await cambiumWorkspace(root, name));
  if (!made) throw new Error(`cambium add ${name} left no workspace`);
  return { path: made.path, branch: made.branch, baseSha: made.base_commit };
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
  if (!(await cambiumWorkspace(root, name))) return { t: 'removed', branchDeleted: false };
  const commits = Number(
    await must(root, ['rev-list', '--count', `${at.baseSha}..refs/heads/${at.branch}`])
  );
  if (commits > 0 && keepCommits) return { t: 'kept', commits };
  const empty = commits === 0;
  const removed = await git(root, [
    'cambium',
    'remove',
    ...(empty ? ['--delete-branch'] : []),
    name,
  ]);
  return removed.t === 'ok'
    ? { t: 'removed', branchDeleted: empty }
    : { t: 'left', reason: removed.message };
}
