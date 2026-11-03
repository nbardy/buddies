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
  | { t: 'ready'; repoRoot: string; baseSha: string }
  | { t: 'refused'; issues: string[] };

/** Every reason a launch would be refused. It never runs a check: checks may be paid GPU runs. */
export async function preflight(p: {
  gate: ExecutionGate;
  workspace: Workspace | undefined;
  charter: Charter;
  installed: (provider: Provider) => boolean;
}): Promise<Preflight> {
  const issues = [...(p.gate.t === 'disabled' ? [p.gate.reason] : []), ...seatIssues(p)];
  if (!p.workspace) return { t: 'refused', issues: ['the workspace is missing', ...issues] };
  const root = p.workspace.rootPath;
  const [top, main, tool] = await Promise.all([
    exec('git', root, ['rev-parse', '--show-toplevel']),
    exec('git', root, ['rev-parse', '--verify', 'refs/heads/main^{commit}']),
    exec('git-cambium', root, ['version']),
  ]);
  if (top.code !== 0) issues.push(`${root} is not a git repository`);
  if (main.code !== 0) issues.push('refs/heads/main does not resolve');
  if (tool.code !== 0) issues.push('`git cambium` is not available');
  const bins = p.charter.done.t === 'checks' ? p.charter.done.checks.map((c) => c[0]) : [];
  for (const bin of new Set(bins))
    if (!(await executable(top.stdout || root, bin)))
      issues.push(`check \`${bin}\`: not an executable on PATH, nor mode 100755 on main`);
  if (issues.length > 0) return { t: 'refused', issues };
  return { t: 'ready', repoRoot: top.stdout, baseSha: main.stdout };
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

/** Bare or absolute: an executable on PATH. Relative with '/': mode 100755 in main's tree. */
async function executable(repo: string, bin: string): Promise<boolean> {
  if (bin.includes('/') && !path.isAbsolute(bin)) {
    const r = await exec('git', repo, ['ls-tree', 'main', '--', path.normalize(bin)]);
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
 * pass. Every argv element that names a file or directory tracked at `base` is first restored
 * from `base`, so the attempt cannot edit the oracle (files it ADDED in a named directory stay:
 * documented limit). A tree-setup error is one run with outcome `error`. `stop` (the expedition
 * finished) kills a running check and skips the rest. */
export async function runChecks(
  repo: string,
  j: { dir: string; sha: string; base: string; checks: string[][] },
  stop: AbortSignal
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  try {
    await fsp.rm(j.dir, { recursive: true, force: true });
    await git(repo, ['worktree', 'prune']);
    await git(repo, ['worktree', 'add', '--detach', j.dir, j.sha]);
    const restore = await oracleFiles(repo, j.base, j.checks);
    if (restore.length > 0)
      await git(j.dir, ['--literal-pathspecs', 'checkout', j.base, '--', ...restore]);
    for (const argv of j.checks) {
      if (stop.aborted) break;
      const outcome = await runOne(argv, j.dir, `${j.dir}.scratch`, stop);
      runs.push({ argv, outcome });
      if (outcome.t !== 'passed') break;
    }
  } catch (error) {
    runs.push({ argv: j.checks[0], outcome: { t: 'error', message: (error as Error).message } });
  } finally {
    await exec('git', repo, ['worktree', 'remove', '--force', j.dir]);
  }
  return runs;
}

/** The argv elements that are paths tracked at `base`, as literal names. Review 2026-11-03: an
 * empty pathspec list (`["/usr/bin/pytest","-q"]`) or `.` made ls-tree list every root entry, and
 * the restore reset the whole attempt to base; `*` or `:(exclude)x` were read as patterns. */
async function oracleFiles(repo: string, base: string, checks: string[][]): Promise<string[]> {
  const named = [...new Set(checks.flat().map((e) => path.posix.normalize(e).replace(/\/+$/, '')))];
  const paths = named.filter(
    (e) => !e.startsWith('-') && !path.isAbsolute(e) && e !== '.' && !e.split('/').includes('..')
  );
  if (paths.length === 0) return [];
  const args = ['--literal-pathspecs', 'ls-tree', '-z', '--name-only', base, '--', ...paths];
  return (await git(repo, args)).split('\0').filter(Boolean);
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
