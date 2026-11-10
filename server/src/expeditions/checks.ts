import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '@unleashd/buddies-core';
import {
  type Charter,
  type CheckOutcome,
  type CheckRun,
  type Provider,
  ProviderSchema,
} from '@unleashd/shared';
import type { ExecutionGate } from '../buddies/execution-gate';
import { checkedRunConfig } from '../buddies/worker-config';
import { labelled } from '../observability/event-loop-stall';
import { exec, git } from './cambium';

// Launch preflight and the host-run checks (docs/expeditions-lean-design.md §3.3).

export type Preflight =
  | { t: 'ready'; repoRoot: string; base: Base }
  | { t: 'refused'; issues: string[] };

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

/** Every reason a launch would be refused. It never runs a check (`launchPreflight` does, at
 * launch only: a draft is cheap, a launch is the commitment). */
export async function preflight(p: {
  gate: ExecutionGate;
  workspace: Workspace | undefined;
  charter: Charter;
  installed: (provider: Provider) => boolean;
}): Promise<Preflight> {
  const issues = [...(p.gate.t === 'disabled' ? [p.gate.reason] : []), ...seatIssues(p)];
  if (!p.workspace) return { t: 'refused', issues: ['the workspace is missing', ...issues] };
  const root = p.workspace.rootPath;
  const [top, tool] = await Promise.all([
    exec('git', root, ['rev-parse', '--show-toplevel']),
    exec('git-cambium', root, ['version']),
  ]);
  if (top.code !== 0) issues.push(`${root} is not a git repository`);
  const resolved: Resolved =
    top.code === 0
      ? await resolveBase(root)
      : { t: 'refused', issue: 'no base: not a git repository' };
  if (resolved.t === 'refused' && top.code === 0) issues.push(resolved.issue);
  const baseSha = resolved.t === 'base' ? resolved.base.sha : '';
  if (tool.code !== 0) issues.push('`git cambium` is not available');
  for (const o of p.charter.oracle) {
    const at = await git(top.stdout || root, [
      '--literal-pathspecs',
      'ls-tree',
      '--name-only',
      baseSha,
      '--',
      o.replace(/\/+$/, ''),
    ]);
    if (at.trim() === '') issues.push(`oracle \`${o}\`: not tracked on the launch base`);
  }
  const bins = p.charter.done.t === 'checks' ? p.charter.done.checks.map((c) => c[0]) : [];
  for (const bin of new Set(bins))
    if (!(await executable(top.stdout || root, bin, baseSha)))
      issues.push(
        `check \`${bin}\`: not an executable on PATH, nor mode 100755 on the launch base`
      );
  if (issues.length > 0) return { t: 'refused', issues };
  if (resolved.t === 'refused') return { t: 'refused', issues: [resolved.issue] };
  return { t: 'ready', repoRoot: top.stdout, base: resolved.base };
}

function seatIssues(p: { charter: Charter; installed: (provider: Provider) => boolean }) {
  try {
    checkedRunConfig(p.charter.seat);
  } catch (error) {
    return [(error as Error).message];
  }
  const provider = ProviderSchema.parse(p.charter.seat.provider);
  return p.installed(provider) ? [] : [`${provider} is not installed on this host`];
}

/** Bare or absolute: an executable on PATH. Relative with '/': mode 100755 in the base's tree. */
async function executable(repo: string, bin: string, baseSha: string): Promise<boolean> {
  if (bin.includes('/') && !path.isAbsolute(bin)) {
    const r = await exec('git', repo, ['ls-tree', baseSha, '--', path.normalize(bin)]);
    return r.code === 0 && r.stdout.startsWith('100755 blob ');
  }
  const dirs = path.isAbsolute(bin) ? [''] : (process.env.PATH ?? '').split(path.delimiter);
  const found = await Promise.all(
    dirs.map((d) =>
      fsp.access(path.join(d, bin), fsp.constants.X_OK).then(
        () => true,
        () => false
      )
    )
  );
  return found.some(Boolean);
}

/** Runs the checks on `sha` in a fresh detached checkout, stopping at the first that does not
 * pass. The oracle is first restored from `base`, so the attempt cannot edit the grader: every
 * regular FILE named directly in an argv, plus the charter's declared `oracle` paths (files or
 * directories, restored whole). A directory named in argv is NOT restored: `["pytest","src"]`
 * grades the attempt's `src`, not base's. A tree-setup error is one run with outcome `error`. `stop` (the expedition
 * finished) kills a running check and skips the rest. */
export async function runChecks(
  repo: string,
  j: {
    dir: string;
    sha: string;
    base: string;
    checks: string[][];
    /** The charter's declared grader paths; [] = none beyond the files argv names. */
    oracle: string[];
    /** `first_failure`: a judged attempt stops at the first check that does not pass. `all`: the
     * launch preflight runs every check once, to learn whether each CAN run. */
    through: 'first_failure' | 'all';
  },
  stop: AbortSignal
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  try {
    await withDetachedTree(repo, j.dir, j.sha, async (dir) => {
      await restoreOracle(repo, dir, j.base, j.checks, j.oracle);
      for (const argv of j.checks) {
        if (stop.aborted) break;
        const outcome = await runOne(argv, dir, `${dir}.scratch`, stop);
        runs.push({ argv, outcome });
        if (outcome.t !== 'passed' && j.through === 'first_failure') break;
      }
    });
  } catch (error) {
    runs.push({ argv: j.checks[0], outcome: { t: 'error', message: (error as Error).message } });
  }
  return runs;
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
    await underRepoLock(repo, async () => {
      await fsp.rm(dir, { recursive: true, force: true });
      await git(repo, ['worktree', 'prune']);
      const expected = await git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]);
      await git(repo, ['worktree', 'add', '--detach', dir, expected]);
      const head = await git(dir, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (head !== expected)
        throw new Error(`the worktree at ${dir} is at ${head}, not ${expected} (${sha})`);
    });
    return await use(dir);
  } finally {
    await underRepoLock(repo, async () => {
      await exec('git', repo, ['worktree', 'remove', '--force', dir]);
      await fsp.rm(dir, { recursive: true, force: true });
      await exec('git', repo, ['worktree', 'prune']);
    });
  }
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

const CHECK_TIMEOUT_MS = 2 * 60 * 60_000;
const TAIL = 4000;
const CHECK_ENV = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ'];

/** A charter check: one host process with the 2 h check bound, no extra env, output kept as a
 * tail. A stop (the expedition finished) reads as `timed_out`, as it always has. */
async function runOne(
  argv: string[],
  cwd: string,
  scratch: string,
  stop: AbortSignal
): Promise<CheckOutcome> {
  const [bin, ...args] = argv;
  if (bin === undefined) return { t: 'error', message: 'the check has an empty argv' };
  const end = await runProcess(
    {
      argv: [bin, ...args],
      cwd,
      scratch,
      timeoutMs: CHECK_TIMEOUT_MS,
      env: {},
      capture: { t: 'tail' },
      onSpawn: () => {},
    },
    stop
  );
  return CHECK_OUTCOME[end.t](end as never);
}
const CHECK_OUTCOME: {
  [K in ProcessEnd['t']]: (e: Extract<ProcessEnd, { t: K }>) => CheckOutcome;
} = {
  exited: (e) => (e.code === 0 ? { t: 'passed' } : { t: 'failed', exitCode: e.code, tail: e.tail }),
  timed_out: (e) => ({ t: 'timed_out', tail: e.tail }),
  stopped: (e) => ({ t: 'timed_out', tail: e.tail }),
  error: (e) => ({ t: 'error', message: e.message }),
};

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

/** Incident 2026-11-01: a DualSPHysics expedition burned 3 attempts on a done-check that failed
 * with FileNotFound in the environment. A check that RUNS and fails is the goal (the attempt must
 * make it pass); one that cannot run can never pass, whatever the crew does. */
export type Ran = { t: 'ran' } | { t: 'cannot_run'; why: string };
export function ranOrNot({ argv, outcome }: CheckRun): Ran {
  const cannot = (why: string): Ran => ({
    t: 'cannot_run',
    why: `check \`${argv.join(' ')}\` cannot run: ${why}`,
  });
  switch (outcome.t) {
    case 'passed':
    case 'timed_out':
      return { t: 'ran' };
    case 'error':
      return cannot(outcome.message);
    case 'failed': {
      if (outcome.exitCode === 126 || outcome.exitCode === 127)
        return cannot(`exit ${outcome.exitCode}`);
      const script = /can't open file '([^']+)': \[Errno 2\] No such file or directory/.exec(
        outcome.tail
      );
      if (script) return cannot(`python found no script ${script[1]}`);
      const module = argv[argv.indexOf('-m') + 1];
      if (argv.includes('-m') && new RegExp(`No module named '?${module}\\b`).test(outcome.tail))
        return cannot(`python found no module ${module}`);
      return { t: 'ran' };
    }
  }
}

export type LaunchPreflight = { t: 'ready' } | { t: 'refused'; issues: string[] };
/** Runs every done check once on the launch base, in a throwaway detached checkout, and refuses
 * the launch for each check that could not run. Bounded by the check timeout. */
export async function launchPreflight(
  repo: string,
  j: { dir: string; baseSha: string; checks: string[][]; oracle: string[] },
  run: typeof runChecks = runChecks
): Promise<LaunchPreflight> {
  const runs = await run(
    repo,
    {
      dir: j.dir,
      sha: j.baseSha,
      base: j.baseSha,
      checks: j.checks,
      oracle: j.oracle,
      through: 'all',
    },
    new AbortController().signal
  );
  const issues = runs.map(ranOrNot).flatMap((r) => (r.t === 'cannot_run' ? [r.why] : []));
  return issues.length > 0 ? { t: 'refused', issues } : { t: 'ready' };
}
