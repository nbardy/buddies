import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { constants } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { labelled } from '../observability/event-loop-stall';
import type { CommandCheck } from './charter';
import type { CheckOutcome } from './ledger';

// Runs one `command` done check (R2) for the host: never an agent, never a shell, async.

export const TAIL_CHARS = 4000;
/** How long a straggler that escaped the process group (`setsid`) may hold the pipes after exit. */
const PIPE_GRACE_MS = 2000;

/** Audit 2026-11-01 #3: a check (agent code) could read the owner's `~/.ssh`; it now gets no keys
 * and a throwaway HOME. Known limit (R11): no sandbox, a literal home path still reads. */
const CHECK_ENV = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ'];

export async function resolvesOnPath(bin: string): Promise<boolean> {
  const candidates = path.isAbsolute(bin)
    ? [bin]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => path.isAbsolute(dir))
        .map((dir) => path.join(dir, bin));
  const found = await Promise.all(
    candidates.map((file) =>
      fsp
        .access(file, fsp.constants.X_OK)
        .then(() => fsp.stat(file))
        .then(
          (stat) => stat.isFile(),
          () => false
        )
    )
  );
  return found.some(Boolean);
}

/** Runs `argv` as its own process group (a timeout kills all it started); a pidfile lets
 * `killCheck` kill an orphan a crash left, and a replay reruns in a fresh tree (audit #10). */
export async function runCommand(
  check: Pick<CommandCheck, 'argv' | 'timeoutSeconds'>,
  cwd: string,
  scratchDir: string
): Promise<CheckOutcome> {
  await fsp.rm(scratchDir, { recursive: true, force: true });
  const home = path.join(scratchDir, 'home');
  const tmp = path.join(scratchDir, 'tmp');
  await fsp.mkdir(home, { recursive: true, mode: 0o700 });
  await fsp.mkdir(tmp, { recursive: true, mode: 0o700 });
  const env = {
    ...Object.fromEntries(
      CHECK_ENV.flatMap((k) => (k in process.env ? [[k, process.env[k]]] : []))
    ),
    HOME: home,
    TMPDIR: tmp,
  };
  try {
    return await spawnCheck(check, cwd, env, scratchDir);
  } finally {
    await fsp.rm(scratchDir, { recursive: true, force: true });
  }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

function spawnCheck(
  check: Pick<CommandCheck, 'argv' | 'timeoutSeconds'>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  scratchDir: string
): Promise<CheckOutcome> {
  const [bin, ...args] = check.argv;
  return new Promise((resolve, reject) => {
    let tail = '';
    let timedOut = false;
    let exit: Exit = { code: null, signal: null };
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Awaited before resolving, so runCommand never removes the scratch dir under this write.
    const recorded = child.pid === undefined ? Promise.resolve() : recordPid(scratchDir, child.pid);
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-TAIL_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    // A setsid child holds the pipes and 'close' waits for all: close ours or the check stalls.
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
    const settle = (outcome: () => CheckOutcome) => {
      clearTimeout(timer);
      clearTimeout(grace);
      recorded.then(() => resolve(outcome()), reject);
    };
    child.on('error', (error) =>
      settle(() => ({ t: 'error', message: `${bin}: ${error.message}` }))
    );
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      killGroup();
      closePipesSoon();
    });
    child.on('close', () => settle(() => outcomeOf(timedOut, exit, tail)));
  });
}

function outcomeOf(timedOut: boolean, exit: Exit, tail: string): CheckOutcome {
  if (timedOut) return { t: 'timed_out', tail };
  if (exit.code === 0) return { t: 'passed' };
  if (exit.code !== null) return { t: 'failed', exitCode: exit.code, tail };
  // Killed by a signal: the shell's 128 + n convention, and the signal named in the tail.
  return {
    t: 'failed',
    exitCode: 128 + (exit.signal ? constants.signals[exit.signal] : 0),
    tail: `${tail}\n[killed by ${exit.signal ?? 'an unknown signal'}]`.slice(-TAIL_CHARS),
  };
}

const execAsync = promisify(execFile);

export const pidfileOf = (scratchDir: string) => path.join(scratchDir, 'check.pid.json');

const PidRecord = z.object({ pid: z.number().int().positive(), lstart: z.string().min(1) });

/** `ps`'s start time for `pid` (a pid is reused, a (pid, start) pair is not); absent: no process. */
async function startTimeOf(pid: number): Promise<string | undefined> {
  const { stdout } = await execAsync('ps', ['-o', 'lstart=', '-p', String(pid)]).catch(() => ({
    stdout: '', // ps exits 1 when no process has that pid.
  }));
  return stdout.trim() || undefined;
}

async function recordPid(scratchDir: string, pid: number): Promise<void> {
  const lstart = await startTimeOf(pid);
  if (lstart === undefined) return;
  const file = pidfileOf(scratchDir);
  await fsp.writeFile(`${file}.tmp`, JSON.stringify({ pid, lstart }), { mode: 0o600 });
  await fsp.rename(`${file}.tmp`, file);
}

type CheckKill = { t: 'no_record' } | { t: 'not_running' } | { t: 'killed'; pid: number };

/** Kills an orphaned check's group, only while `ps` shows its recorded start time. */
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
