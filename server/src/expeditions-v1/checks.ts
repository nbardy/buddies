import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { labelled } from '../observability/event-loop-stall';
import { exec, git } from './cambium';

// Keyed launch base, detached worktrees and host processes.

/** The one commit a launch grades and forks from, with the ref it came from (recorded as data). */
export type Base = { ref: string; sha: string };
export type Resolved = { t: 'base'; base: Base } | { t: 'refused'; issue: string };

/**
 * The launch base rule (one typed rule, named here, not a fallback chain): with an `origin`
 * remote, fetch it, then take `refs/remotes/origin/HEAD`, and `refs/remotes/origin/main` only when
 * origin/HEAD is unset. Without an `origin` remote, local `refs/heads/main`. A fetch that fails,
 * or an origin with neither ref, refuses the launch rather than grading a stale local main.
 * Why: in the first trial the workspace's local main was 128 commits behind origin/main, so the
 * preflight graded different code than the attempts ran on.
 */
export async function resolveBase(root: string): Promise<Resolved> {
  const verify = (ref: string) => exec('git', root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const remotes = await exec('git', root, ['remote']);
  if (!remotes.stdout.split('\n').includes('origin')) {
    const local = await verify('refs/heads/main');
    return local.code === 0
      ? { t: 'base', base: { ref: 'refs/heads/main', sha: local.stdout } }
      : { t: 'refused', issue: 'refs/heads/main does not resolve' };
  }
  const fetched = await exec('git', root, ['fetch', '--quiet', 'origin'], true);
  if (fetched.code !== 0)
    return { t: 'refused', issue: `git fetch origin failed: ${fetched.stderr.slice(-300)}` };
  const head = await verify('refs/remotes/origin/HEAD');
  if (head.code === 0) {
    const target = await exec('git', root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    return {
      t: 'base',
      base: {
        ref: target.code === 0 ? target.stdout : 'refs/remotes/origin/HEAD',
        sha: head.stdout,
      },
    };
  }
  const main = await verify('refs/remotes/origin/main');
  return main.code === 0
    ? { t: 'base', base: { ref: 'refs/remotes/origin/main', sha: main.stdout } }
    : { t: 'refused', issue: 'origin has neither refs/remotes/origin/HEAD nor origin/main' };
}

/** A detached worktree of `repo` at `sha` for the length of `use`, removed afterwards whatever
 * `use` does. Its HEAD is checked against `sha` before `use` runs: a tree at the wrong commit
 * would grade or run the wrong code and say nothing. Throws on any git failure. */
export async function withDetachedTree<T>(
  repo: string,
  dir: string,
  sha: string,
  use: (dir: string) => Promise<T>
): Promise<T> {
  try {
    await addDetachedTree(repo, dir, sha);
    return await use(dir);
  } finally {
    await removeDetachedTree(repo, dir);
  }
}

/** The first half of `withDetachedTree`, for a tree that must outlive one call (a review judge's
 * view of the code it judges lasts its whole run, across restarts: executor/calls.ts). Anything
 * at `dir` is replaced; the tree's HEAD is checked against `sha`. Throws on any git failure. */
export async function addDetachedTree(repo: string, dir: string, sha: string): Promise<void> {
  await underRepoLock(repo, async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune']);
    const expected = await git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]);
    await git(repo, ['worktree', 'add', '--detach', dir, expected]);
    const head = await git(dir, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (head !== expected)
      throw new Error(`the worktree at ${dir} is at ${head}, not ${expected} (${sha})`);
  });
}

/** The second half: the tree and its admin entry are gone. Idempotent; never throws for a tree
 * that is already gone. */
export async function removeDetachedTree(repo: string, dir: string): Promise<void> {
  await underRepoLock(repo, async () => {
    await exec('git', repo, ['worktree', 'remove', '--force', dir]);
    await fsp.rm(dir, { recursive: true, force: true });
    await exec('git', repo, ['worktree', 'prune']);
  });
}

/** Worktree setup and teardown, one at a time per repo (the work in the trees runs in parallel).
 * `worktree prune` drops the admin entry of any tree whose directory it cannot see, and a
 * concurrent `worktree add` is briefly in exactly that state, so a parallel prune could remove a
 * tree being made. Keyed expeditions run commands in parallel; the old host queued its checks. */
const repoLocks = new Map<string, Promise<void>>();
function underRepoLock(repo: string, task: () => Promise<void>): Promise<void> {
  const run = (repoLocks.get(repo) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  repoLocks.set(repo, tail);
  void tail.then(() => {
    if (repoLocks.get(repo) === tail) repoLocks.delete(repo);
  });
  return run;
}

/** The oracle files (`oracleFiles`) put back as they are at `base`, in the tree at `dir`. */
export async function restoreOracle(
  repo: string,
  dir: string,
  base: string,
  checks: string[][],
  oracle: string[]
): Promise<void> {
  const restore = await oracleFiles(repo, base, checks, oracle);
  if (restore.length > 0)
    await git(dir, ['--literal-pathspecs', 'checkout', base, '--', ...restore]);
}

/** What to restore from `base`, as literal names. Argv-inferred protection covers regular files
 * only (ls-tree type blob): a directory in argv (`pytest src`, `make -C server test`) is the thing
 * UNDER TEST, and restoring it graded base instead of the attempt (audit 2026-11-03). Directories
 * are protected only when the charter declares them in `oracle`. Review 2026-11-03: an empty
 * pathspec list or `.` made ls-tree list every root entry, and `*` or `:(exclude)x` were read as
 * patterns; hence the filters and --literal-pathspecs. */
async function oracleFiles(
  repo: string,
  base: string,
  checks: string[][],
  oracle: string[]
): Promise<string[]> {
  const clean = (e: string) => path.posix.normalize(e).replace(/\/+$/, '');
  const named = [...new Set(checks.flat().map(clean))];
  const paths = named.filter(
    (e) => !e.startsWith('-') && !path.isAbsolute(e) && e !== '.' && !e.split('/').includes('..')
  );
  const files =
    paths.length === 0
      ? []
      : (await git(repo, ['--literal-pathspecs', 'ls-tree', '-z', base, '--', ...paths]))
          .split('\0')
          .filter(Boolean)
          .map((row) => row.split('\t'))
          .filter(([meta]) => meta.split(' ')[1] === 'blob')
          .map(([, name]) => name);
  return [...new Set([...files, ...oracle.map(clean)])];
}

const TAIL = 4000;
const CHECK_ENV = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ'];

/** Whether stdout is kept apart from the mixed tail (a command whose stdout is its JSON answer). */
export type Capture =
  | { readonly t: 'tail' }
  | { readonly t: 'stdout'; readonly limitBytes: number };
export type Stdout =
  | { readonly t: 'not-captured' }
  | { readonly t: 'captured'; readonly text: string }
  | { readonly t: 'overflowed'; readonly limitBytes: number };
export type ProcessSpec = {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  /** Removed and recreated: the process's HOME and TMPDIR live here, and it is removed after. */
  readonly scratch: string;
  readonly timeoutMs: number;
  /** Added to the scrubbed env (HOME and TMPDIR stay the scratch ones). */
  readonly env: Readonly<Record<string, string>>;
  readonly capture: Capture;
  /** The process group exists (its id is the child's pid). Called once, synchronously. */
  readonly onSpawn: (pid: number) => void;
};
export type ProcessEnd =
  /** It exited; `code` is 128 when a signal ended it. `tail` mixes stdout and stderr. */
  | { readonly t: 'exited'; readonly code: number; readonly tail: string; readonly stdout: Stdout }
  | { readonly t: 'timed_out'; readonly tail: string }
  /** `stop` fired. */
  | { readonly t: 'stopped'; readonly tail: string }
  /** It never ran (spawn failed: ENOENT, EACCES). */
  | { readonly t: 'error'; readonly message: string };

/** Audit #3 (kept from command.ts): a host process runs in its own process group with a scrubbed
 * env and a throwaway HOME/TMPDIR, with no shell; on timeout, on `stop` and after exit the whole
 * group is killed, and pipes a `setsid` straggler holds are closed after 2 s so it always settles. */
export async function runProcess(spec: ProcessSpec, stop: AbortSignal): Promise<ProcessEnd> {
  const { argv, cwd, scratch } = spec;
  await fsp.rm(scratch, { recursive: true, force: true });
  const home = path.join(scratch, 'home');
  const tmp = path.join(scratch, 'tmp');
  await Promise.all([fsp.mkdir(home, { recursive: true }), fsp.mkdir(tmp, { recursive: true })]);
  const env = { ...pick(CHECK_ENV), ...spec.env, HOME: home, TMPDIR: tmp };
  try {
    return await new Promise<ProcessEnd>((resolve) => {
      let tail = '';
      let ended: 'running' | 'timed_out' | 'stopped' = 'running';
      let code: number | null = null;
      const out = stdoutOf(spec.capture);
      const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: 'pipe' });
      child.stdin.end();
      const keep = (b: Buffer) => {
        tail = (tail + b.toString('utf8')).slice(-TAIL);
      };
      child.stdout.on('data', (b: Buffer) => {
        keep(b);
        out.add(b);
      });
      child.stderr.on('data', keep);
      const killGroup = () => {
        try {
          process.kill(-(child.pid ?? 0), 'SIGKILL');
        } catch {} // ESRCH: the group is already gone
      };
      const closePipes = labelled('timer expedition-check-pipes', () => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
      const abandon = (why: 'timed_out' | 'stopped') => () => {
        if (ended === 'running') ended = why;
        killGroup();
        setTimeout(closePipes, 2000).unref();
      };
      const onStop = abandon('stopped');
      const timer = setTimeout(
        labelled('timer expedition-check-timeout', abandon('timed_out')),
        Math.min(spec.timeoutMs, MAX_TIMER_MS)
      );
      if (stop.aborted) onStop();
      else stop.addEventListener('abort', onStop, { once: true });
      child.on('spawn', () => spec.onSpawn(child.pid as number));
      child.on('error', (e) => {
        clearTimeout(timer);
        stop.removeEventListener('abort', onStop);
        resolve({ t: 'error', message: `${argv[0]}: ${e.message}` });
      });
      child.on('exit', (c, signal) => {
        code = c ?? 128;
        tail = signal ? `${tail}\n[killed by ${signal}]` : tail;
        killGroup();
        setTimeout(closePipes, 2000).unref();
      });
      child.on('close', () => {
        clearTimeout(timer);
        stop.removeEventListener('abort', onStop);
        const last = tail.slice(-TAIL);
        resolve(
          ended === 'running'
            ? { t: 'exited', code: code ?? -1, tail: last, stdout: out.result() }
            : { t: ended, tail: last }
        );
      });
    });
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}
/** setTimeout's ceiling: a longer delay is not clamped but fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function stdoutOf(capture: Capture): { add(b: Buffer): void; result(): Stdout } {
  if (capture.t === 'tail') return { add: () => {}, result: () => ({ t: 'not-captured' }) };
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    add: (b) => {
      bytes += b.length;
      if (bytes <= capture.limitBytes) chunks.push(b);
    },
    result: () =>
      bytes > capture.limitBytes
        ? { t: 'overflowed', limitBytes: capture.limitBytes }
        : { t: 'captured', text: Buffer.concat(chunks).toString('utf8') },
  };
}

const pick = (keys: string[]) =>
  Object.fromEntries(
    keys.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]]]))
  );
