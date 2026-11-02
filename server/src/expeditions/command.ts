import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { constants } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { labelled } from '../observability/event-loop-stall';
import type { CommandCheck } from './charter';
import type { CheckOutcome } from './ledger';

// Runs one `command` done check (design.md R2) for the host: never an agent, never a shell.
// Pattern: async-liveness (docs/patterns.md#async-liveness) — an async spawn; the server loop
// never waits on a check, however long it runs.

/** The output kept per check: the end is where a failing test or compiler says why. */
export const TAIL_CHARS = 4000;
/** After the check exits (or is killed at its timeout), how long a straggler that escaped the
 * process group (its own session, `setsid`) may hold the output pipes before they are closed. */
export const PIPE_GRACE_MS = 2000;

/**
 * The only server environment a check sees. A check runs code an agent wrote (the candidate
 * commit), so provider keys and tokens in the server's environment must not reach it: it gets
 * what a build needs to find its tools, nothing else. HOME and TMPDIR are a throwaway pair made
 * for this one run (audit 2026-11-01 #3: HOME was the owner's, so a check could read
 * `~/.ssh`, `~/.aws` or a CLI's saved token). Fix-guard: "a check cannot read the owner's home".
 */
const CHECK_ENV = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ'];
const checkEnv = (scratch: CheckScratch): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(CHECK_ENV.flatMap((k) => (k in process.env ? [[k, process.env[k]]] : []))),
  HOME: scratch.home,
  TMPDIR: scratch.tmp,
});

/** A check run's own HOME and TMPDIR, inside `dir` (beside its validation tree, never in it: a
 * check that asserts a clean checkout must not see them). Made empty before the run, removed
 * after it. */
interface CheckScratch {
  dir: string;
  home: string;
  tmp: string;
}

async function freshScratch(dir: string): Promise<CheckScratch> {
  await fsp.rm(dir, { recursive: true, force: true });
  const scratch = { dir, home: path.join(dir, 'home'), tmp: path.join(dir, 'tmp') };
  await fsp.mkdir(scratch.home, { recursive: true, mode: 0o700 });
  await fsp.mkdir(scratch.tmp, { recursive: true, mode: 0o700 });
  return scratch;
}

/**
 * Whether a check's bare or absolute `argv[0]` names an executable file the way `spawn` will look
 * for it under the check's environment (launch preflight, design.md R4; nothing is run): a bare
 * name on the server's PATH (the PATH a check gets), or an absolute path. A relative path with a
 * slash is resolved against the base commit instead (git.ts preflight). A script the expedition
 * itself is meant to create cannot be named as argv[0]: run it through its interpreter
 * (`["sh", "scripts/x.sh"]`).
 */
export async function resolvesOnPath(bin: string): Promise<boolean> {
  const candidates = path.isAbsolute(bin)
    ? [bin]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => path.isAbsolute(dir))
        .map((dir) => path.join(dir, bin));
  const found = await Promise.all(candidates.map(executableFile));
  return found.some(Boolean);
}

async function executableFile(file: string): Promise<boolean> {
  try {
    await fsp.access(file, fsp.constants.X_OK);
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Runs `argv` in `cwd` with a timeout. The process leads its own group, so a timeout kills
 * everything it started (a test runner's workers too), and stragglers are killed once it exits so
 * a background child holding the pipes cannot stall the result. Output (stdout and stderr,
 * interleaved) is kept as a bounded tail.
 *
 * Leading its own group also means a check outlives a server crash. The ledger holds no pid (one
 * could not be trusted across a reboot); instead the scratch dir holds a pidfile (PIDFILE: the
 * pid and its `ps` start time), removed with the scratch dir when the check ends, so only a
 * crash leaves it, and `killCheck` kills the orphan's group only while that same process (same
 * pid AND start time) still runs. On replay the interrupted validation's tree is
 * discarded and its unrecorded checks run again in a FRESH tree at the same sha (host.ts
 * `interrupted`, audit #10), so the two never share build outputs; the recorded outcome is the
 * replayed run's.
 * Known limit: the throwaway HOME hides `$HOME`, not the owner's files. There is no sandbox, and
 * USER/LOGNAME pass through, so a check that names the owner's home by path (or `~user`) still
 * reads it (design.md R11).
 */
export async function runCommand(
  check: Pick<CommandCheck, 'argv' | 'timeoutSeconds'>,
  cwd: string,
  scratchDir: string
): Promise<CheckOutcome> {
  const scratch = await freshScratch(scratchDir);
  try {
    return await spawnCheck(check, cwd, scratch);
  } finally {
    await fsp.rm(scratch.dir, { recursive: true, force: true });
  }
}

function spawnCheck(
  check: Pick<CommandCheck, 'argv' | 'timeoutSeconds'>,
  cwd: string,
  scratch: CheckScratch
): Promise<CheckOutcome> {
  const [bin, ...args] = check.argv;
  return new Promise((resolve, reject) => {
    let tail = '';
    let timedOut = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } = {
      code: null,
      signal: null,
    };
    const child = spawn(bin, args, {
      cwd,
      env: checkEnv(scratch),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Awaited before the outcome is returned, so runCommand never removes the scratch dir under
    // a write still in flight. A write that fails rejects the run like a scratch dir that cannot
    // be made.
    const recorded = child.pid === undefined ? Promise.resolve() : recordPid(scratch, child.pid);
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-TAIL_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ESRCH: the group is already gone.
      }
    };
    // A child that left the group (setsid) survives killGroup and may hold the pipes open, and
    // 'close' waits for every pipe: without this the check never settles and the validation
    // stalls with nothing in the ledger. Closing our ends lets 'close' fire.
    let grace: NodeJS.Timeout | undefined;
    const closePipesSoon = () => {
      grace ??= setTimeout(
        labelled('timer expedition-check-pipe-grace', () => {
          child.stdout.destroy();
          child.stderr.destroy();
        }),
        PIPE_GRACE_MS
      );
    };
    const timer = setTimeout(
      labelled('timer expedition-check-timeout', () => {
        timedOut = true;
        killGroup();
        closePipesSoon();
      }),
      check.timeoutSeconds * 1000
    );
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(grace);
      recorded.then(() => resolve({ t: 'error', message: `${bin}: ${error.message}` }), reject);
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      killGroup();
      closePipesSoon();
    });
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(grace);
      recorded.then(() => resolve(outcomeOf(timedOut, exit, tail)), reject);
    });
  });
}

function outcomeOf(
  timedOut: boolean,
  exit: { code: number | null; signal: NodeJS.Signals | null },
  tail: string
): CheckOutcome {
  if (timedOut) return { t: 'timed_out', tail };
  if (exit.code === 0) return { t: 'passed' };
  // Killed by a signal: the shell's 128 + n convention, and the signal named in the tail.
  if (exit.code === null)
    return {
      t: 'failed',
      exitCode: 128 + (exit.signal ? constants.signals[exit.signal] : 0),
      tail: `${tail}\n[killed by ${exit.signal ?? 'an unknown signal'}]`.slice(-TAIL_CHARS),
    };
  return { t: 'failed', exitCode: exit.code, tail };
}

// ---------- The orphan a crash leaves (design.md R11, Restart) ----------

const execAsync = promisify(execFile);

/** The pidfile inside a check's scratch dir (the dir runCommand is given). */
export const pidfileOf = (scratchDir: string) => path.join(scratchDir, 'check.pid.json');

const PidRecord = z.object({ pid: z.number().int().positive(), lstart: z.string().min(1) });

/** `ps`'s start time for `pid`: a pid is reused, a (pid, start time) pair is not. Absent when
 * no such process runs. */
async function startTimeOf(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const lstart = stdout.trim();
    return lstart === '' ? undefined : lstart;
  } catch {
    return undefined; // ps exits 1 when no process has that pid.
  }
}

/** Writes the check's pid and start time (renamed into place, so a crash never leaves half a
 * record). A check that already exited has no start time: nothing is left to kill, so nothing is
 * written. */
async function recordPid(scratch: CheckScratch, pid: number): Promise<void> {
  const lstart = await startTimeOf(pid);
  if (lstart === undefined) return;
  const file = pidfileOf(scratch.dir);
  await fsp.writeFile(`${file}.tmp`, JSON.stringify({ pid, lstart }), { mode: 0o600 });
  await fsp.rename(`${file}.tmp`, file);
}

/** What `killCheck` found: no pidfile (the check ended, or never started), a pid now held by
 * another process or none, or the orphan's group, killed. */
export type CheckKill = { t: 'no_record' } | { t: 'not_running' } | { t: 'killed'; pid: number };

/**
 * Kills a check an earlier server process left running (the pidfile survives only a crash), so a
 * replayed validation never races an orphan on the same candidate. SIGKILL goes to the whole
 * group (-pid), and only while `ps` still shows the recorded start time for that pid.
 */
export async function killCheck(pidfile: string): Promise<CheckKill> {
  const text = await fsp.readFile(pidfile, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (text === undefined) return { t: 'no_record' };
  const { pid, lstart } = PidRecord.parse(JSON.parse(text));
  if ((await startTimeOf(pid)) !== lstart) return { t: 'not_running' };
  try {
    process.kill(-pid, 'SIGKILL');
    return { t: 'killed', pid };
  } catch {
    return { t: 'not_running' }; // ESRCH: the group ended between the check and the kill.
  }
}
