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
      base: { ref: target.code === 0 ? target.stdout : 'refs/remotes/origin/HEAD', sha: head.stdout },
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
    top.code === 0 ? await resolveBase(root) : { t: 'refused', issue: 'no base: not a git repository' };
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
      issues.push(`check \`${bin}\`: not an executable on PATH, nor mode 100755 on the launch base`);
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
    await fsp.rm(j.dir, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune']);
    await git(repo, ['worktree', 'add', '--detach', j.dir, j.sha]);
    const restore = await oracleFiles(repo, j.base, j.checks, j.oracle);
    if (restore.length > 0)
      await git(j.dir, ['--literal-pathspecs', 'checkout', j.base, '--', ...restore]);
    for (const argv of j.checks) {
      if (stop.aborted) break;
      const outcome = await runOne(argv, j.dir, `${j.dir}.scratch`, stop);
      runs.push({ argv, outcome });
      if (outcome.t !== 'passed' && j.through === 'first_failure') break;
    }
  } catch (error) {
    runs.push({ argv: j.checks[0], outcome: { t: 'error', message: (error as Error).message } });
  } finally {
    await exec('git', repo, ['worktree', 'remove', '--force', j.dir]);
  }
  return runs;
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

/** Audit #3 (kept from command.ts): the check runs in its own process group with a scrubbed env
 * and a throwaway HOME/TMPDIR; on timeout and after exit the whole group is killed, and pipes a
 * `setsid` straggler holds are closed after 2 s so the check always settles. */
async function runOne(
  argv: string[],
  cwd: string,
  scratch: string,
  stop: AbortSignal
): Promise<CheckOutcome> {
  await fsp.rm(scratch, { recursive: true, force: true });
  const home = path.join(scratch, 'home');
  const tmp = path.join(scratch, 'tmp');
  await Promise.all([fsp.mkdir(home, { recursive: true }), fsp.mkdir(tmp, { recursive: true })]);
  const env = { ...pick(CHECK_ENV), HOME: home, TMPDIR: tmp };
  try {
    return await new Promise<CheckOutcome>((resolve) => {
      let tail = '';
      let timedOut = false;
      let code: number | null = null;
      const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: 'pipe' });
      child.stdin.end();
      const keep = (b: Buffer) => {
        tail = (tail + b.toString('utf8')).slice(-TAIL);
      };
      child.stdout.on('data', keep);
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
      const abandon = () => {
        timedOut = true;
        killGroup();
        setTimeout(closePipes, 2000).unref();
      };
      const timer = setTimeout(
        labelled('timer expedition-check-timeout', abandon),
        CHECK_TIMEOUT_MS
      );
      stop.addEventListener('abort', abandon, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
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
        stop.removeEventListener('abort', abandon);
        const failed: CheckOutcome = { t: 'failed', exitCode: code ?? -1, tail: tail.slice(-TAIL) };
        resolve(timedOut ? { t: 'timed_out', tail } : code === 0 ? { t: 'passed' } : failed);
      });
    });
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
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
