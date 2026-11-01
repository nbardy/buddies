import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { constants } from 'node:os';
import path from 'node:path';
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
 * what a build needs to find its tools and a home, nothing else.
 */
const CHECK_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'];
const checkEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(CHECK_ENV.flatMap((k) => (k in process.env ? [[k, process.env[k]]] : [])));

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
 * Known limit: leading its own group also means a check outlives a server crash. The ledger holds
 * no pid (one could not be trusted across a reboot), so on replay `run_validation` runs the
 * interrupted check again in the same tree while the orphan may still be running there; the two
 * can race on build outputs, and the orphan is never killed (it ends at its own pace, unbounded
 * by the timeout). The recorded outcome is always the replayed run's.
 */
export function runCommand(
  check: Pick<CommandCheck, 'argv' | 'timeoutSeconds'>,
  cwd: string
): Promise<CheckOutcome> {
  const [bin, ...args] = check.argv;
  return new Promise((resolve) => {
    let tail = '';
    let timedOut = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } = {
      code: null,
      signal: null,
    };
    const child = spawn(bin, args, {
      cwd,
      env: checkEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      resolve({ t: 'error', message: `${bin}: ${error.message}` });
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      killGroup();
      closePipesSoon();
    });
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(outcomeOf(timedOut, exit, tail));
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
