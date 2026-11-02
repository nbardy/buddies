import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ClaimChange } from './charter';
import { resolvesOnPath } from './command';
import type { IntegrationRefusal, Lifetime, Repo, WorktreeAt } from './ledger';
import { withinCustody } from './queries';

// The expedition's git I/O: preflight, the expedition branch, one Cambium worktree per attempt.
// Every call is an async execFile (async-liveness); every write first adopts its own earlier
// result and rolls back a partial one (idempotency-keys), so replaying an effect is harmless.

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
/** Copying, merging, snapshotting or removing a whole tree: 124k files took ~15 min (a 120 s
 * timeout killed removes partway, the emergent-beach incident). */
export const TREE_TIMEOUT_MS = 15 * 60_000;

export type GitRun<T = string> = { t: 'ok'; stdout: T } | { t: 'failed'; message: string };

/**
 * The only server environment host git and Cambium see (audit 2026-11-01 #7: a repository hook ran
 * agent-written code with every provider key in reach). `GIT_CONFIG_*` outranks a repository's
 * `core.hooksPath`, so hooks and fsmonitor are off. Known limit (design.md R11): a committed
 * `.gitattributes` filter still runs, with only this environment.
 */
const GIT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];
const IDENTITY = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/;
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => GIT_ENV.includes(k) || IDENTITY.test(k))
  ),
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath',
  GIT_CONFIG_VALUE_0: '/dev/null',
  GIT_CONFIG_KEY_1: 'core.fsmonitor',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_TERMINAL_PROMPT: '0',
});

const text = (stdout: Buffer) => stdout.toString().trim();

/** The one process call every host git and Cambium invocation goes through. */
async function run<T = string>(
  bin: 'git' | 'git-cambium',
  cwd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
  env = gitEnv(),
  decode: (stdout: Buffer) => T = text as (stdout: Buffer) => T
): Promise<GitRun<T>> {
  try {
    const { stdout } = await exec(bin, args, {
      cwd,
      env,
      timeout,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { t: 'ok', stdout: decode(stdout) };
  } catch (error) {
    const e = error as { stderr?: Buffer; message: string };
    return { t: 'failed', message: (e.stderr?.toString() || e.message).trim().slice(-600) };
  }
}

export const git = (cwd: string, args: string[], timeout?: number) =>
  run('git', cwd, args, timeout);
/** `git-cambium` itself, not `git cambium`: a timeout must kill the process doing the work. */
export const cambium = (cwd: string, args: string[], timeout?: number) =>
  run('git-cambium', cwd, args, timeout);
/** Push and ls-remote alone reach `origin`, so they alone get the ssh agent socket. */
const remoteGit = (cwd: string, args: string[]) => {
  const sock = process.env.SSH_AUTH_SOCK;
  return run('git', cwd, args, undefined, {
    ...gitEnv(),
    ...(sock === undefined ? {} : { SSH_AUTH_SOCK: sock }),
  });
};

async function must<T>(ran: Promise<GitRun<T>>, what: string): Promise<T> {
  const done = await ran;
  if (done.t === 'failed') throw new Error(`${what} failed: ${done.message}`);
  return done.stdout;
}

/** A git query read as raw bytes (a blob, pins.ts); a failure throws. */
export const gitBytes = (cwd: string, args: string[]) =>
  must(run('git', cwd, args, undefined, undefined, (b) => b), `git ${args[0]}`);

/** The commit a rev names; a git failure reads as `missing` (callers refuse or skip). */
export type Tip = { t: 'missing' } | { t: 'at'; sha: string };

export async function tipOf(cwd: string, rev: string): Promise<Tip> {
  const read = await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return read.t === 'ok' ? { t: 'at', sha: read.stdout } : { t: 'missing' };
}

/** Whether anything is at `file` (a file, a directory, a dangling symlink). */
export const pathExists = (file: string) =>
  fsp.lstat(file).then(
    () => true,
    () => false
  );

type Preflight = { t: 'ready'; root: string; baseSha: string } | { t: 'refused'; reasons: string[] };

/**
 * Launch preflight (design.md R4), never running a check (checks may be paid GPU runs): a git
 * repository, a resolving HEAD, `git cambium`, and every check's `argv[0]`: on PATH or absolute
 * (command.ts), or a relative path committed executable at HEAD (a dirty checkout must not pass).
 */
export async function preflight(workspaceRoot: string, bins: string[]): Promise<Preflight> {
  const [top, head, tool] = await Promise.all([
    git(workspaceRoot, ['rev-parse', '--show-toplevel']),
    tipOf(workspaceRoot, 'HEAD'),
    cambium(workspaceRoot, ['version']),
  ]);
  const repoRoot = top.t === 'ok' ? top.stdout : workspaceRoot;
  const resolves = async (bin: string) => {
    if (!bin.includes('/') || path.isAbsolute(bin)) return resolvesOnPath(bin);
    const listed = await git(repoRoot, ['ls-tree', 'HEAD', '--', path.normalize(bin)]);
    return listed.t === 'ok' && listed.stdout.startsWith('100755 blob ');
  };
  const missing = (
    await Promise.all([...new Set(bins)].map(async (bin) => ((await resolves(bin)) ? [] : [bin])))
  ).flat();
  if (top.t === 'ok' && head.t === 'at' && tool.t === 'ok' && missing.length === 0)
    return { t: 'ready', root: top.stdout, baseSha: head.sha };
  const reasons = [
    top.t === 'failed' ? `workspace root ${workspaceRoot} is not a git repository` : '',
    head.t === 'missing' ? 'the base commit (HEAD) does not resolve' : '',
    tool.t === 'failed' ? '`git cambium` is not available' : '',
    ...missing.map(
      (bin) =>
        `command check executable \`${bin}\` is not found (not on PATH, nor an executable file committed at HEAD)`
    ),
  ].filter(Boolean);
  return { t: 'refused', reasons };
}

export const branchHead = (repo: Repo) =>
  must(
    git(repo.root, ['rev-parse', '--verify', `refs/heads/${repo.branch}^{commit}`]),
    `the head of ${repo.branch}`
  );

const CambiumWorkspace = z
  .object({
    name: z.string(),
    status: z.string(),
    path: z.string(),
    branch: z.string(),
    base_commit: z.string(),
  })
  .passthrough();

const cambiumList = async (root: string) =>
  z
    .array(CambiumWorkspace)
    .parse(JSON.parse(await must(cambium(root, ['list', '--json']), 'cambium list')));

/** What an interrupted `cambium add` can leave with no registry entry, described ('' when none). */
async function leftovers(root: string, at: WorktreeAt): Promise<string> {
  const [branch, dir] = await Promise.all([
    tipOf(root, `refs/heads/${at.branch}`),
    pathExists(at.path),
  ]);
  return [branch.t === 'at' ? `branch ${at.branch}` : '', dir ? `directory ${at.path}` : '']
    .filter(Boolean)
    .join(' and ');
}

/**
 * Rolls back an interrupted `cambium add` (reproduced: SIGKILL during a 20k-file add) and returns
 * what is still left. `cambium recover` is repository-wide (design.md R1 known limits), so it runs
 * only when this attempt's own branch or directory is left over.
 */
async function recoverLeftovers(root: string, at: WorktreeAt): Promise<string> {
  if ((await leftovers(root, at)) === '') return '';
  await cambium(root, ['recover', '--json']);
  return leftovers(root, at);
}

/** A planned tree made where its intent says (`tree_ready`), or a typed failure (`tree_failed`). */
export type MadeWorktree = { t: 'ready' } | { t: 'failed'; reason: string };

/**
 * The attempt's worktree at `plan.baseSha`, or adopted by its Cambium name after a crash (it must
 * match the intent). Leftovers are recovered before and after a failed add, so a replay never
 * meets "branch already exists"; whatever cannot be made is a typed failure.
 */
export async function ensureWorktree(
  root: string,
  name: string,
  plan: WorktreeAt,
  lifetime: Lifetime
): Promise<MadeWorktree> {
  const base = await tipOf(root, plan.baseSha);
  if (base.t === 'missing') return { t: 'failed', reason: `commit ${plan.baseSha} does not exist` };
  const want = { ...plan, baseSha: base.sha };
  const named = async () => (await cambiumList(root)).find((w) => w.name === name);
  const prior = await named();
  if (prior) return adopted(prior, want);
  const stuck = await recoverLeftovers(root, plan);
  if (stuck !== '') return { t: 'failed', reason: `cambium recover left ${stuck}` };
  const flags = lifetime === 'ephemeral' ? ['-ephemeral'] : [];
  const add = await cambium(
    root,
    ['add', '-b', plan.branch, '-name', name, ...flags, plan.path, base.sha],
    TREE_TIMEOUT_MS
  );
  if (add.t === 'failed') {
    const left = await recoverLeftovers(root, plan);
    const note = left === '' ? '' : ` (still on disk: ${left})`;
    return { t: 'failed', reason: `cambium add failed: ${add.message}${note}` };
  }
  const made = await named();
  return made ? adopted(made, want) : { t: 'failed', reason: `cambium add ${name} left no workspace` };
}

function adopted(w: z.infer<typeof CambiumWorkspace>, plan: WorktreeAt): MadeWorktree {
  const mismatch = [
    w.status === 'ready' ? '' : `status ${w.status}`,
    w.branch === plan.branch ? '' : `branch ${w.branch} (expected ${plan.branch})`,
    w.base_commit === plan.baseSha ? '' : `base ${w.base_commit} (expected ${plan.baseSha})`,
  ].filter(Boolean);
  return mismatch.length === 0
    ? { t: 'ready' }
    : { t: 'failed', reason: `Cambium workspace ${w.name} does not match: ${mismatch.join(', ')}` };
}

/** A worktree branch's commits beyond its base, oldest first (`missing`: no such branch). */
export type BranchState = { t: 'missing' } | { t: 'present'; shas: string[] };

export async function branchState(root: string, at: WorktreeAt): Promise<BranchState> {
  const ref = `refs/heads/${at.branch}`;
  if ((await tipOf(root, ref)).t === 'missing') return { t: 'missing' };
  const listed = await must(
    git(root, ['rev-list', '--reverse', `${at.baseSha}..${ref}`]),
    `listing ${at.branch} commits`
  );
  return { t: 'present', shas: listed.split('\n').filter(Boolean) };
}

type ClaimHeld = { t: 'held' } | { t: 'not_held'; reason: string };
const notHeld = (reason: string): ClaimHeld => ({ t: 'not_held', reason });

/**
 * Checks a work claim against its own attempt branch (design.md R2): a `commit` must be new on
 * that branch and change only files in its question's `custody`; `no_code` needs an existing
 * branch with no commits (audit 2026-11-01: a missing branch read as "zero commits").
 */
export async function claimHeld(
  root: string,
  at: WorktreeAt,
  change: ClaimChange,
  custody: readonly string[]
): Promise<ClaimHeld> {
  if (change.t === 'no_code') {
    const branch = await branchState(root, at);
    if (branch.t === 'missing') return notHeld(`the attempt branch ${at.branch} does not exist`);
    const n = branch.shas.length;
    return n === 0
      ? { t: 'held' }
      : notHeld(`claimed no code, but the attempt branch ${at.branch} has ${n} commit(s)`);
  }
  const ancestor = (of: string) => git(root, ['merge-base', '--is-ancestor', change.sha, of]);
  const [onBranch, inBase] = await Promise.all([
    ancestor(`refs/heads/${at.branch}`),
    ancestor(at.baseSha),
  ]);
  if (onBranch.t !== 'ok' || inBase.t !== 'failed')
    return notHeld(
      `claimed commit ${change.sha} is not a new commit on the attempt branch ${at.branch}`
    );
  const changed = await must(
    git(root, ['diff', '--name-only', '--no-renames', at.baseSha, change.sha]),
    `listing the files ${change.sha} changes`
  );
  const outside = changed
    .split('\n')
    .filter((file) => file !== '' && !withinCustody(file, custody));
  return outside.length === 0
    ? { t: 'held' }
    : notHeld(
        `claimed commit ${change.sha} changes files outside its question's paths (${custody.join(', ')}): ${outside.slice(0, 10).join(', ')}`
      );
}

// ---------- Integration (design.md R3) ----------

type Merged = { t: 'integrated'; mergeSha: string } | { t: 'refused'; refusal: IntegrationRefusal };
const refused = (refusal: IntegrationRefusal): Merged => ({ t: 'refused', refusal });

/** Aborts a merge left half-done (MERGE_HEAD present). */
async function abortMerge(tree: string): Promise<void> {
  if ((await tipOf(tree, 'MERGE_HEAD')).t === 'at')
    await must(git(tree, ['merge', '--abort']), 'git merge --abort');
}

/**
 * Merges candidate `sha` into the expedition branch in its integration tree (`--no-ff`). Replay
 * safe: an interrupted merge is aborted, and a candidate already merged on the branch's own
 * first-parent history returns that merge. A conflict is aborted and refused with its paths.
 */
export async function mergeCandidate(
  tree: WorktreeAt,
  sha: string,
  message: string,
  expectedHead: string
): Promise<Merged> {
  await abortMerge(tree.path);
  const merges = await must(
    git(tree.path, ['rev-list', '--first-parent', '--merges', '--parents', 'HEAD', `^${tree.baseSha}`]),
    'listing integration merges'
  );
  const prior = merges
    .split('\n')
    .map((line) => line.split(' '))
    .find((commits) => commits.slice(2).includes(sha))?.[0];
  if (prior) return { t: 'integrated', mergeSha: prior };
  // Audit 2026-11-01 #6: a branch moved outside the host would hand the owner unvalidated commits.
  const head = await tipOf(tree.path, 'HEAD');
  if (head.t === 'missing' || head.sha !== expectedHead)
    return refused({
      phase: 'tree',
      reason: `the expedition branch head is ${head.t === 'at' ? head.sha : 'unreadable'}, not ${expectedHead} as the ledger records: it moved outside the host`,
    });
  const [on, status] = await Promise.all([
    git(tree.path, ['symbolic-ref', '--quiet', 'HEAD']),
    git(tree.path, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  const blockers = [
    on.t === 'ok' && on.stdout === `refs/heads/${tree.branch}`
      ? ''
      : `the integration tree is not on ${tree.branch}`,
    status.t === 'failed' ? `git status failed: ${status.message}` : '',
    status.t === 'ok' && status.stdout !== '' ? 'the integration tree has uncommitted changes' : '',
  ].filter(Boolean);
  if (blockers.length > 0) return refused({ phase: 'tree', reason: blockers.join('; ') });
  if ((await git(tree.path, ['merge-base', '--is-ancestor', sha, 'HEAD'])).t === 'ok')
    return refused({ phase: 'git', reason: `${sha} is already in ${tree.branch} without a merge of its own` });
  const merged = await git(tree.path, ['merge', '--no-ff', '-m', message, sha], TREE_TIMEOUT_MS);
  if (merged.t === 'ok')
    return {
      t: 'integrated',
      mergeSha: await must(git(tree.path, ['rev-parse', 'HEAD']), 'the merge commit'),
    };
  const conflicted = await git(tree.path, ['diff', '--name-only', '--diff-filter=U']);
  const paths = conflicted.t === 'ok' ? conflicted.stdout.split('\n').filter(Boolean) : [];
  await abortMerge(tree.path);
  return paths.length > 0
    ? refused({ phase: 'merge', paths })
    : refused({ phase: 'git', reason: merged.message });
}

// ---------- The manager's tree (design.md R11) ----------

/** `dir` with symlinks resolved as git prints it (macOS /var is /private/var); a removed path
 * resolves through its parent, so a registration whose directory is gone still matches. */
async function canonicalPath(dir: string): Promise<string> {
  const whole = path.resolve(dir);
  const parent = path.dirname(whole);
  return fsp
    .realpath(whole)
    .catch(async () =>
      path.join(await fsp.realpath(parent).catch(() => parent), path.basename(whole))
    );
}

/** Moves the manager's detached tree to `sha`, discarding whatever a turn left (read-only). */
export async function syncDetachedTree(dir: string, sha: string): Promise<void> {
  await must(git(dir, ['checkout', '--quiet', '--detach', '--force', sha]), `checkout ${sha}`);
  await must(git(dir, ['clean', '-fdq']), 'git clean');
}

/** The manager's detached worktree at `sha`: adopted when registered, else pruned and added. */
export async function ensureDetachedTree(
  root: string,
  dir: string,
  sha: string
): Promise<MadeWorktree> {
  try {
    if ((await registrationOf(root, dir)).t === 'gone') {
      await git(root, ['worktree', 'prune']);
      if (await pathExists(dir))
        return { t: 'failed', reason: `${dir} exists and is not a worktree` };
      const add = await git(root, ['worktree', 'add', '--quiet', '--detach', dir, sha], TREE_TIMEOUT_MS);
      if (add.t === 'failed') return { t: 'failed', reason: `git worktree add: ${add.message}` };
    }
    await syncDetachedTree(dir, sha);
    return { t: 'ready' };
  } catch (error) {
    return { t: 'failed', reason: (error as Error).message };
  }
}

// ---------- Release and archive (design.md Retire) ----------

/** Who holds the tree at a path, matched by real path: a Cambium workspace, a plain git worktree
 * (the manager's tree, or one a killed remove dropped from Cambium), or nothing. */
export type Registration =
  | { t: 'cambium'; name: string }
  | { t: 'git_only'; path: string }
  | { t: 'gone' };

export async function registrationOf(root: string, dir: string): Promise<Registration> {
  const [want, listed] = await Promise.all([canonicalPath(dir), cambiumList(root)]);
  const paths = await Promise.all(listed.map((w) => canonicalPath(w.path)));
  const held = listed.find((_, i) => paths[i] === want);
  if (held) return { t: 'cambium', name: held.name };
  const worktrees = await must(git(root, ['worktree', 'list', '--porcelain']), 'git worktree list');
  const registered = await Promise.all(
    worktrees
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => canonicalPath(line.slice('worktree '.length)))
  );
  return registered.includes(want) ? { t: 'git_only', path: dir } : { t: 'gone' };
}

/** Removes a plain worktree; `--force` twice (submodules, locks, changes: the guard ladder has
 * already decided), then `prune` drops a registration whose directory was already gone. */
export async function removeGitOnly(root: string, dir: string): Promise<GitRun> {
  const removed = await git(root, ['worktree', 'remove', '--force', '--force', dir], TREE_TIMEOUT_MS);
  const pruned = await git(root, ['worktree', 'prune']);
  return removed.t === 'failed' ? removed : pruned;
}

/**
 * Commits everything a tree holds (not ignored files, which the harvest keeps) on top of its HEAD
 * from a temporary copy of its index (keeping the stat cache), and pins it at `ref`. Known limit:
 * uncommitted edits inside a submodule are not in the snapshot.
 */
export async function snapshotDirty(tree: string, ref: string, message: string): Promise<string> {
  const indexAt = await must(git(tree, ['rev-parse', '--git-path', 'index']), 'the index path');
  const scratch = await fsp.mkdtemp(path.join(tmpdir(), 'expedition-snapshot-'));
  const temp = path.join(scratch, 'index');
  try {
    await fsp.copyFile(path.resolve(tree, indexAt), temp);
    const env = { ...gitEnv(), GIT_INDEX_FILE: temp };
    const step = (args: string[]) =>
      must(run('git', tree, args, TREE_TIMEOUT_MS, env), `git ${args[0]}`);
    await step(['add', '-A']);
    const treeSha = await step(['write-tree']);
    // A snapshot already pinned at `ref` (a retire asked again after a killed forced remove) is
    // the only copy of the edits (no reflog): kept as a second parent, swapped compare-and-swap.
    const prior = await tipOf(tree, ref);
    const old = prior.t === 'at' ? prior.sha : '';
    const parents = prior.t === 'at' ? ['-p', 'HEAD', '-p', prior.sha] : ['-p', 'HEAD'];
    const commit = await step(['commit-tree', treeSha, ...parents, '-m', message]);
    await must(git(tree, ['update-ref', ref, commit, old]), `pinning ${ref}`);
    return commit;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

/** Every ref an expedition left: attempt branches, the expedition branch, salvage pins. */
export async function expeditionRefs(root: string, id: string): Promise<string[]> {
  const listed = await must(
    git(root, [
      'for-each-ref',
      '--format=%(refname)',
      `refs/heads/exp/${id}/`,
      `refs/heads/expedition/${id}`,
      `refs/salvage/expeditions/${id}/`,
    ]),
    'listing expedition refs'
  );
  return listed.split('\n').filter(Boolean);
}

type Archived = { t: 'archived'; sha: string; tag: string } | { t: 'refused'; reason: string };
const archiveRefused = (reason: string): Archived => ({ t: 'refused', reason });

/**
 * Archives `ref` as `refs/tags/<tag>` on `origin`, then deletes it, each step checked: the tag is
 * made at the tip (or adopted at that same commit), pushed, read back by `ls-remote`, and the ref
 * is deleted compare-and-delete at the tip read. A refusal leaves the ref: never only-copy local.
 */
export async function archiveBranch(root: string, ref: string, tag: string): Promise<Archived> {
  const tip = await tipOf(root, ref);
  if (tip.t === 'missing') return archiveRefused(`${ref} does not resolve to a commit`);
  const { sha } = tip;
  const tagRef = `refs/tags/${tag}`;
  const existing = await tipOf(root, tagRef);
  if (existing.t === 'at' && existing.sha !== sha)
    return archiveRefused(`tag ${tag} exists at ${existing.sha}, not at ${sha}`);
  if (existing.t === 'missing') {
    const made = await git(root, ['update-ref', tagRef, sha, '']);
    if (made.t === 'failed') return archiveRefused(`creating ${tag}: ${made.message}`);
  }
  const pushed = await remoteGit(root, ['push', '--quiet', 'origin', `${tagRef}:${tagRef}`]);
  if (pushed.t === 'failed') return archiveRefused(`pushing ${tag}: ${pushed.message}`);
  const remote = await remoteGit(root, ['ls-remote', 'origin', tagRef]);
  if (remote.t === 'failed') return archiveRefused(`reading ${tag} on origin: ${remote.message}`);
  if (remote.stdout !== `${sha}\t${tagRef}`)
    return archiveRefused(
      `origin does not hold ${tag} at exactly ${sha} (ls-remote: ${remote.stdout || 'nothing'})`
    );
  const dropped = await git(root, ['update-ref', '-d', ref, sha]);
  return dropped.t === 'ok'
    ? { t: 'archived', sha, tag }
    : archiveRefused(`deleting ${ref} at ${sha}: ${dropped.message}`);
}
