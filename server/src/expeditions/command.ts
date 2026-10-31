import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { labelled } from '../observability/event-loop-stall';
import type { CommandCheck } from './charter';
import type { CheckOutcome } from './ledger';

// Runs one `command` done check (design.md R2) for the host: never an agent, never a shell.
// Pattern: async-liveness (docs/patterns.md#async-liveness) — an async spawn; the server loop
// never waits on a check, however long it runs.

/** The output kept per check: the end is where a failing test or compiler says why. */
export const TAIL_CHARS = 4000;

/**
 * Runs `argv` in `cwd` with a timeout. The process leads its own group, so a timeout kills
 * everything it started (a test runner's workers too), and stragglers are killed once it exits so
 * a background child holding the pipes cannot stall the result. Output (stdout and stderr,
 * interleaved) is kept as a bounded tail.
 */
export function runCommand(check: CommandCheck, cwd: string): Promise<CheckOutcome> {
  const [bin, ...args] = check.argv;
  return new Promise((resolve) => {
    let tail = '';
    let timedOut = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } = {
      code: null,
      signal: null,
    };
    const child = spawn(bin, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const timer = setTimeout(
      labelled('timer expedition-check-timeout', () => {
        timedOut = true;
        killGroup();
      }),
      check.timeoutSeconds * 1000
    );
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ t: 'error', message: `${bin}: ${error.message}` });
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      killGroup();
    });
    child.on('close', () => {
      clearTimeout(timer);
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
