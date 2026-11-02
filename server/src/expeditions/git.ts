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
/** A merge checks files out in the integration tree: bounded like an add, not like a query. */
const MERGE_TIMEOUT_MS = 15 * 60_000;
/** A dirty snapshot's `add -A` hashes every changed file of a tree: bounded like an add. */
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;

export type GitRun<T = string> = { t: 'ok'; stdout: T } | { t: 'failed'; message: string };

/**
 * The only server environment the host's git and Cambium see (audit 2026-11-01 #7): git ran with
 * the full server environment, so a repository hook (post-checkout on a worktree add, post-merge
 * on an integration) ran agent-written code with every provider key in reach. Hooks are off for
 * every host git process, Cambium's children included: `GIT_CONFIG_*` is command-line config, so
 * it outranks a repository's own `core.hooksPath`. HOME stays: git reads the owner's identity
 * (user.name for a merge commit) from it. Fix-guard: "a repository hook never runs for the host".
 * `core.fsmonitor` is off for the same reason (a repository config may name a command for it).
 * Known limit (design.md R11): other config-named commands still run, e.g. a `filter.<x>.smudge`
 * selected by a committed .gitattributes; git has no switch that turns every filter off, and a
 * worker in a linked worktree can write the shared .git/config. They see only this environment.
 */
const GIT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];
const IDENTITY = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/;
export const gitEnv = (): NodeJS.ProcessEnv => ({
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

/** How a run's stdout is read: trimmed text (a query), or raw bytes (a blob whose bytes are hashed). */
type Decode<T> = (stdout: Buffer) => T;
const text: Decode<string> = (stdout) => stdout.toString().trim();
const bytes: Decode<Buffer> = (stdout) => stdout;

/** The one process call every host git and Cambium invocation goes through (pins.ts included). */
async function run<T>(
  bin: 'git' | 'git-cambium',
  cwd: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv; decode: Decode<T> }
): Promise<GitRun<T>> {
  try {
    const { stdout } = await exec(bin, args, {
      cwd,
      env: opts.env,
      timeout: opts.timeout,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { t: 'ok', stdout: opts.decode(stdout) };
  } catch (error) {
    const e = error as { stderr?: Buffer; message: string };
    return { t: 'failed', message: (e.stderr?.toString() || e.message).trim().slice(-600) };
  }
}

export const git = (cwd: string, args: string[], timeout = GIT_TIMEOUT_MS) =>
  run('git', cwd, args, { timeout, env: gitEnv(), decode: text });
/** Cambium runs as `git-cambium` itself, not through `git cambium`: a timeout must kill the process
 * doing the work, not a `git` wrapper whose child would finish the add after we recorded failure. */
export const cambium = (cwd: string, args: string[], timeout = GIT_TIMEOUT_MS) =>
  run('git-cambium', cwd, args, { timeout, env: gitEnv(), decode: text });
/** Push and ls-remote reach `origin`, so they alone also get the ssh agent socket (gitEnv strips
 * it; no local git or Cambium call needs it). */
const remoteGit = (cwd: string, args: string[]) => {
  const sock = process.env.SSH_AUTH_SOCK;
  const env = { ...gitEnv(), ...(sock === undefined ? {} : { SSH_AUTH_SOCK: sock }) };
  return run('git', cwd, args, { timeout: GIT_TIMEOUT_MS, env, decode: text });
};

async function must<T>(ran: Promise<GitRun<T>>, what: string): Promise<T> {
  const done = await ran;
  if (done.t === 'failed') throw new Error(`${what} failed: ${done.message}`);
  return done.stdout;
}

/** A git query read as bytes (a blob, pins.ts): a failure (a timeout, a broken repository) throws. */
export const gitBytes = (cwd: string, args: string[]) =>
  must(
    run('git', cwd, args, { timeout: GIT_TIMEOUT_MS, env: gitEnv(), decode: bytes }),
    `git ${args[0]}`
  );

/** The commit a ref or revision names, or nothing there. A git failure reads as `missing`, as
 * every caller did before this was shared: each then refuses or skips, never invents a commit. */
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

/** Launch preflight (κ at the boundary, design.md R4): a refusal names every reason. */
export type Preflight =
  | { t: 'ready'; root: string; baseSha: string }
  | { t: 'refused'; reasons: string[] };

/**
 * Refuses a launch unless the workspace root is a git repository, its base commit (HEAD)
 * resolves, `git cambium` is available, and every command check's `argv[0]` resolves (`bins`):
 * a bare name or absolute path on the host (command.ts resolvesOnPath), a relative path with a
 * slash as an executable file COMMITTED at the base (a validation tree is a checkout of a commit,
 * so an untracked or uncommitted script in a dirty shared checkout must not pass). It never runs
 * a check: checks may be paid GPU runs.
 */
export async function preflight(workspaceRoot: string, bins: string[]): Promise<Preflight> {
  const [top, head, tool] = await Promise.all([
    git(workspaceRoot, ['rev-parse', '--show-toplevel']),
    tipOf(workspaceRoot, 'HEAD'),
    cambium(workspaceRoot, ['version']),
  ]);
  const repoRoot = top.t === 'ok' ? top.stdout : workspaceRoot;
  const resolves = (bin: string) =>
    bin.includes('/') && !path.isAbsolute(bin)
      ? committedExecutable(repoRoot, bin)
      : resolvesOnPath(bin);
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

/** Whether `file` (repo-relative) is an executable blob in HEAD's tree (mode 100755). */
async function committedExecutable(repoRoot: string, file: string): Promise<boolean> {
  const listed = await git(repoRoot, ['ls-tree', 'HEAD', '--', path.normalize(file)]);
  return listed.t === 'ok' && listed.stdout.startsWith('100755 blob ');
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

const cambiumList = async (root: string) =>
  z
    .array(CambiumWorkspace.passthrough())
    .parse(JSON.parse(await must(cambium(root, ['list', '--json']), 'cambium list')));

const cambiumWorkspace = async (root: string, name: string) =>
  (await cambiumList(root)).find((w) => w.name === name);

/** What an interrupted `cambium add` can leave with no registry entry: its branch, its path. */
export interface Leftovers {
  branch: boolean;
  dir: boolean;
}
export const nothingLeft = (l: Leftovers) => !l.branch && !l.dir;
export const describe = (l: Leftovers, at: WorktreeAt) =>
  [l.branch ? `branch ${at.branch}` : '', l.dir ? `directory ${at.path}` : '']
    .filter(Boolean)
    .join(' and ');

async function leftovers(root: string, at: WorktreeAt): Promise<Leftovers> {
  const [branch, dir] = await Promise.all([
    tipOf(root, `refs/heads/${at.branch}`),
    pathExists(at.path),
  ]);
  return { branch: branch.t === 'at', dir };
}

/**
 * Rolls back what an interrupted `cambium add` left behind. Cambium journals each create, and
 * `cambium recover` removes an incomplete one's linked worktree and unadvanced branch (it leaves
 * operations whose process is still alive alone). Returns what is still there afterwards.
 * Repository-wide: Cambium has no per-workspace recover, so this also rolls back other agents'
 * DEAD incomplete creates in the owner's repository (design.md R1 known limits). It runs only
 * when this attempt's own branch or directory is left over.
 */
export async function recoverLeftovers(root: string, at: WorktreeAt): Promise<Leftovers> {
  const before = await leftovers(root, at);
  if (nothingLeft(before)) return before;
  await cambium(root, ['recover', '--json']);
  return leftovers(root, at);
}

const lifetimeFlags = (l: Lifetime): string[] => {
  switch (l) {
    case 'ephemeral':
      return ['-ephemeral'];
    case 'owned':
      return [];
  }
};

/** Whether a planned tree now exists where its intent says (`tree_ready`), or a typed failure
 * the ledger records (`tree_failed`). The ledger's planned place is the tree's place. */
export type MadeWorktree = { t: 'ready' } | { t: 'failed'; reason: string };

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
  plan: WorktreeAt,
  lifetime: Lifetime
): Promise<MadeWorktree> {
  const base = await tipOf(root, plan.baseSha);
  if (base.t === 'missing') return { t: 'failed', reason: `commit ${plan.baseSha} does not exist` };
  const prior = await cambiumWorkspace(root, name);
  if (prior) return adopted(prior, { ...plan, baseSha: base.sha });
  const stuck = await recoverLeftovers(root, plan);
  if (!nothingLeft(stuck))
    return { t: 'failed', reason: `cambium recover left ${describe(stuck, plan)}` };
  const add = await cambium(
    root,
    ['add', '-b', plan.branch, '-name', name, ...lifetimeFlags(lifetime), plan.path, base.sha],
    ADD_TIMEOUT_MS
  );
  if (add.t === 'failed') {
    const left = await recoverLeftovers(root, plan);
    const note = nothingLeft(left) ? '' : ` (still on disk: ${describe(left, plan)})`;
    return { t: 'failed', reason: `cambium add failed: ${add.message}${note}` };
  }
  const made = await cambiumWorkspace(root, name);
  if (!made) return { t: 'failed', reason: `cambium add ${name} left no workspace` };
  return adopted(made, { ...plan, baseSha: base.sha });
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

/** Whether a work claim's `change` is what its attempt branch holds (design.md R2). */
export type ClaimHeld = { t: 'held' } | { t: 'not_held'; reason: string };

/**
 * The host checks a claim against its own attempt branch instead of trusting its word: a `commit`
 * must be a new commit on that branch (an ancestor of its tip, not of its base), so a claim cannot
 * name the head or another attempt's passing commit, and it may change only files inside its
 * question's custody (`custody`, repo-relative prefixes), so admission's "no overlapping custody
 * at once" holds for what is merged, not only for what was briefed. `no_code` means the branch
 * has no commits, so an attempt that committed cannot skip candidate validation.
 */
export async function claimHeld(
  root: string,
  at: WorktreeAt,
  change: ClaimChange,
  custody: readonly string[]
): Promise<ClaimHeld> {
  switch (change.t) {
    case 'commit': {
      const ref = `refs/heads/${at.branch}`;
      const [onBranch, inBase] = await Promise.all([
        git(root, ['merge-base', '--is-ancestor', change.sha, ref]),
        git(root, ['merge-base', '--is-ancestor', change.sha, at.baseSha]),
      ]);
      if (onBranch.t !== 'ok' || inBase.t !== 'failed')
        return {
          t: 'not_held',
          reason: `claimed commit ${change.sha} is not a new commit on the attempt branch ${at.branch}`,
        };
      const changed = await must(
        git(root, ['diff', '--name-only', '--no-renames', at.baseSha, change.sha]),
        `listing the files ${change.sha} changes`
      );
      const outside = changed
        .split('\n')
        .filter(Boolean)
        .filter((file) => !withinCustody(file, custody));
      return outside.length === 0
        ? { t: 'held' }
        : {
            t: 'not_held',
            reason: `claimed commit ${change.sha} changes files outside its question's paths (${custody.join(', ')}): ${outside.slice(0, 10).join(', ')}`,
          };
    }
    case 'no_code':
      return noCodeHeld(await branchState(root, at), at);
  }
}

/** `no_code` holds only on an attempt branch that exists with no commits: a missing branch is
 * not "zero commits" (audit 2026-11-01: that fallback hid a branch deleted under the attempt). */
function noCodeHeld(branch: BranchState, at: WorktreeAt): ClaimHeld {
  switch (branch.t) {
    case 'missing':
      return { t: 'not_held', reason: `the attempt branch ${at.branch} does not exist` };
    case 'present':
      return branch.shas.length === 0
        ? { t: 'held' }
        : {
            t: 'not_held',
            reason: `claimed no code, but the attempt branch ${at.branch} has ${branch.shas.length} commit(s)`,
          };
  }
}

// ---------- Integration (design.md R3) ----------

/** What one merge into the expedition branch did. */
export type Merged =
  | { t: 'integrated'; mergeSha: string }
  | { t: 'refused'; refusal: IntegrationRefusal };

/**
 * The merge commit on the branch's own first-parent history whose second parent is `sha`
 * (absent: none). Only the expedition's commits are walked (`^base`), so this stays cheap on a
 * large repository. This is how a replay recognises a merge it already made.
 */
async function priorMerge(tree: WorktreeAt, sha: string): Promise<string | undefined> {
  const merges = await must(
    git(tree.path, [
      'rev-list',
      '--first-parent',
      '--merges',
      '--parents',
      'HEAD',
      `^${tree.baseSha}`,
    ]),
    'listing integration merges'
  );
  return merges
    .split('\n')
    .map((line) => line.split(' '))
    .find((commits) => commits.slice(2).includes(sha))?.[0];
}

/** Why the integration tree cannot take a merge now (empty: it can). */
async function treeBlockers(tree: WorktreeAt): Promise<string[]> {
  const [on, status] = await Promise.all([
    git(tree.path, ['symbolic-ref', '--quiet', 'HEAD']),
    git(tree.path, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  const expected = `refs/heads/${tree.branch}`;
  return [
    on.t === 'ok' && on.stdout === expected ? '' : `the integration tree is not on ${tree.branch}`,
    status.t === 'failed' ? `git status failed: ${status.message}` : '',
    status.t === 'ok' && status.stdout !== '' ? 'the integration tree has uncommitted changes' : '',
  ].filter(Boolean);
}

/**
 * Merges candidate `sha` into the expedition branch in its integration tree (`git merge --no-ff`).
 * Replay-safe: a merge a crash interrupted (MERGE_HEAD present) is aborted first, and a candidate
 * already merged returns its existing merge commit instead of merging again. A conflict is aborted
 * and refused with the conflicted paths, leaving the tree clean at the branch head; any other git
 * failure is aborted and refused with git's message. The owner's checkout is never touched.
 */
export async function mergeCandidate(
  tree: WorktreeAt,
  sha: string,
  message: string,
  expectedHead: string
): Promise<Merged> {
  if ((await tipOf(tree.path, 'MERGE_HEAD')).t === 'at')
    await must(git(tree.path, ['merge', '--abort']), 'git merge --abort');
  const prior = await priorMerge(tree, sha);
  if (prior) return { t: 'integrated', mergeSha: prior };
  // The branch must be where the ledger left it (audit 2026-11-01 #6): anything else moved it, and
  // merging on top would hand the owner commits no validation ever saw.
  const head = await tipOf(tree.path, 'HEAD');
  if (head.t === 'missing' || head.sha !== expectedHead)
    return {
      t: 'refused',
      refusal: {
        phase: 'tree',
        reason: `the expedition branch head is ${head.t === 'at' ? head.sha : 'unreadable'}, not ${expectedHead} as the ledger records: it moved outside the host`,
      },
    };
  const blockers = await treeBlockers(tree);
  if (blockers.length > 0)
    return { t: 'refused', refusal: { phase: 'tree', reason: blockers.join('; ') } };
  const contained = await git(tree.path, ['merge-base', '--is-ancestor', sha, 'HEAD']);
  if (contained.t === 'ok')
    return {
      t: 'refused',
      refusal: {
        phase: 'git',
        reason: `${sha} is already in ${tree.branch} without a merge of its own`,
      },
    };
  const merged = await git(tree.path, ['merge', '--no-ff', '-m', message, sha], MERGE_TIMEOUT_MS);
  if (merged.t === 'ok')
    return {
      t: 'integrated',
      mergeSha: await must(git(tree.path, ['rev-parse', 'HEAD']), 'the merge commit'),
    };
  const conflicted = await git(tree.path, ['diff', '--name-only', '--diff-filter=U']);
  const paths = conflicted.t === 'ok' ? conflicted.stdout.split('\n').filter(Boolean) : [];
  if ((await tipOf(tree.path, 'MERGE_HEAD')).t === 'at')
    await must(git(tree.path, ['merge', '--abort']), 'git merge --abort');
  return paths.length > 0
    ? { t: 'refused', refusal: { phase: 'merge', paths } }
    : { t: 'refused', refusal: { phase: 'git', reason: merged.message } };
}

// ---------- The manager's tree (design.md R11) ----------

/**
 * `dir` with symlinks resolved, comparable with what git and Cambium print (macOS: /var is
 * /private/var). A path already removed resolves through its parent, so a registration whose
 * directory is gone still matches the path the ledger recorded.
 */
async function canonicalPath(dir: string): Promise<string> {
  const whole = path.resolve(dir);
  return fsp
    .realpath(whole)
    .catch(async () =>
      path.join(
        await fsp.realpath(path.dirname(whole)).catch(() => path.dirname(whole)),
        path.basename(whole)
      )
    );
}

async function worktreePaths(root: string): Promise<string[]> {
  const listed = await must(git(root, ['worktree', 'list', '--porcelain']), 'git worktree list');
  return Promise.all(
    listed
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => canonicalPath(line.slice('worktree '.length)))
  );
}

/**
 * Moves a detached tree to `sha`, discarding anything a turn left there: the manager's tree is
 * read-only by contract and host-owned, so every decision starts from the current head.
 */
export async function syncDetachedTree(dir: string, sha: string): Promise<void> {
  await must(git(dir, ['checkout', '--quiet', '--detach', '--force', sha]), `checkout ${sha}`);
  await must(git(dir, ['clean', '-fdq']), 'git clean');
}

/**
 * The manager's detached worktree at `sha`: adopted when a crash left it registered, made with
 * `git worktree add --detach` otherwise (no branch: a manager never commits). A directory left
 * by an interrupted add is pruned first; anything still in the way is a typed failure.
 */
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
      const add = await git(
        root,
        ['worktree', 'add', '--quiet', '--detach', dir, sha],
        ADD_TIMEOUT_MS
      );
      if (add.t === 'failed') return { t: 'failed', reason: `git worktree add: ${add.message}` };
    }
    await syncDetachedTree(dir, sha);
    return { t: 'ready' };
  } catch (error) {
    return { t: 'failed', reason: (error as Error).message };
  }
}

// ---------- Release and archive (design.md Retire) ----------

/**
 * Who holds the tree at a path: a Cambium workspace (removed through Cambium), a plain git
 * worktree registration with no Cambium entry (the manager's tree, or a tree whose Cambium entry
 * a killed remove already dropped), or nothing. Matched by real path, so one lookup serves every
 * tree kind and a name the ledger never had (the manager's tree) needs no special case.
 */
export type Registration =
  | { t: 'cambium'; name: string }
  | { t: 'git_only'; path: string }
  | { t: 'gone' };

export async function registrationOf(root: string, dir: string): Promise<Registration> {
  const [want, listed] = await Promise.all([canonicalPath(dir), cambiumList(root)]);
  const paths = await Promise.all(listed.map((w) => canonicalPath(w.path)));
  const held = listed.find((_, i) => paths[i] === want);
  if (held) return { t: 'cambium', name: held.name };
  return (await worktreePaths(root)).includes(want) ? { t: 'git_only', path: dir } : { t: 'gone' };
}

/**
 * Removes a plain git worktree registration and its files. `--force` twice: a tree holding a
 * submodule, a locked tree, or local changes is refused otherwise; the caller's guard ladder has
 * already decided it may go. `prune` then drops a registration whose directory was already gone.
 */
export async function removeGitOnly(root: string, dir: string, timeout: number): Promise<GitRun> {
  const removed = await git(root, ['worktree', 'remove', '--force', '--force', dir], timeout);
  const pruned = await git(root, ['worktree', 'prune']);
  if (removed.t === 'failed') return removed;
  return pruned;
}

/**
 * Commits everything a tree holds (tracked edits, deletions and untracked files; not ignored
 * files, which the harvest keeps) on top of its HEAD without touching its index or branch, and
 * pins the commit at `ref`. A temporary copy of the tree's own index keeps git's stat cache, so a
 * large tree is not rehashed. Known limit: a submodule is recorded at its HEAD; uncommitted edits
 * inside a submodule are not in the snapshot.
 */
export async function snapshotDirty(tree: string, ref: string, message: string): Promise<string> {
  const indexAt = await must(git(tree, ['rev-parse', '--git-path', 'index']), 'the index path');
  const index = path.isAbsolute(indexAt) ? indexAt : path.join(tree, indexAt);
  const scratch = await fsp.mkdtemp(path.join(tmpdir(), 'expedition-snapshot-'));
  const temp = path.join(scratch, 'index');
  try {
    await fsp.copyFile(index, temp);
    const env = { ...gitEnv(), GIT_INDEX_FILE: temp };
    const step = (args: string[]) =>
      must(
        run('git', tree, args, { timeout: SNAPSHOT_TIMEOUT_MS, env, decode: text }),
        `git ${args[0]}`
      );
    await step(['add', '-A']);
    const treeSha = await step(['write-tree']);
    // A snapshot already pinned at `ref` (a retire whose forced remove was killed partway, then
    // asked again) is kept as a second parent, never overwritten: the half-deleted tree's new
    // snapshot records deletions, and the first one is the only copy of the uncommitted edits
    // (refs/salvage has no reflog). The update is compare-and-swap against the pin read.
    const prior = await tipOf(tree, ref);
    const parents = prior.t === 'at' ? ['-p', 'HEAD', '-p', prior.sha] : ['-p', 'HEAD'];
    const commit = await step(['commit-tree', treeSha, ...parents, '-m', message]);
    const old = prior.t === 'at' ? prior.sha : '';
    await must(git(tree, ['update-ref', ref, commit, old]), `pinning ${ref}`);
    return commit;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

/** Every ref an expedition left in the owner's repository: its attempt branches, its expedition
 * branch, and its salvage pins (older code's leftovers included: they share these prefixes). */
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

/** One ref archived as a tag on `origin`, then deleted locally; or why it was kept. */
export type Archived =
  | { t: 'archived'; sha: string; tag: string }
  | { t: 'refused'; reason: string };

/**
 * Archives `ref` (a full ref name) as `refs/tags/<tag>` on `origin`, and only then deletes it.
 * Each step is checked before the next: the tip is read; the tag is created at it, or an existing
 * tag at that same commit is adopted (a replay), and a tag at any other commit is refused; the tag
 * is pushed; `ls-remote` must show exactly that commit on the remote; and the ref is deleted with
 * compare-and-delete at the tip read, so a ref that moved meanwhile is kept. Any refusal leaves
 * the ref where it was: a branch is never deleted while its only copy is local.
 */
export async function archiveBranch(root: string, ref: string, tag: string): Promise<Archived> {
  const tip = await tipOf(root, ref);
  if (tip.t === 'missing') return { t: 'refused', reason: `${ref} does not resolve to a commit` };
  const sha = tip.sha;
  const tagRef = `refs/tags/${tag}`;
  const existing = await tipOf(root, tagRef);
  if (existing.t === 'at' && existing.sha !== sha)
    return { t: 'refused', reason: `tag ${tag} exists at ${existing.sha}, not at ${sha}` };
  if (existing.t === 'missing') {
    const made = await git(root, ['update-ref', tagRef, sha, '']);
    if (made.t === 'failed') return { t: 'refused', reason: `creating ${tag}: ${made.message}` };
  }
  const pushed = await remoteGit(root, ['push', '--quiet', 'origin', `${tagRef}:${tagRef}`]);
  if (pushed.t === 'failed') return { t: 'refused', reason: `pushing ${tag}: ${pushed.message}` };
  const remote = await remoteGit(root, ['ls-remote', 'origin', tagRef]);
  if (remote.t === 'failed')
    return { t: 'refused', reason: `reading ${tag} on origin: ${remote.message}` };
  if (remote.stdout !== `${sha}\t${tagRef}`)
    return {
      t: 'refused',
      reason: `origin does not hold ${tag} at exactly ${sha} (ls-remote: ${remote.stdout || 'nothing'})`,
    };
  const dropped = await git(root, ['update-ref', '-d', ref, sha]);
  return dropped.t === 'ok'
    ? { t: 'archived', sha, tag }
    : { t: 'refused', reason: `deleting ${ref} at ${sha}: ${dropped.message}` };
}
