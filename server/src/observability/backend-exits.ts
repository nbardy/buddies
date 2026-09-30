import fs from 'node:fs';
import path from 'node:path';
import type { ErrorJournal } from './error-journal';

/**
 * Backend crashes, journaled by the NEXT backend.
 * Pattern: fix-guards (docs/patterns.md#fix-guards)
 *
 * Why: a dying backend cannot journal its own death (a native SIGBUS or SIGKILL
 * runs no JS). On 2026-09-30 a SIGBUS during a reload drain was logged by the
 * dev runner as "Backend finished its active work" and left no trace outside
 * the terminal. The runner (tools/watch-server.mjs) now appends every exit to
 * EXITS_FILE; this reads the ones not reported yet and journals each crash, so
 * `pnpm errors:list` shows them. Reported progress is a byte offset in
 * CURSOR_FILE, so the append-only record keeps its full history.
 * Guards: `tools/watch-server.test.mjs` (draining SIGKILL is a crash) and
 * `server/test/backend-exits.test.ts` (each crash journaled exactly once).
 */

export const EXITS_FILE = 'backend-exits.jsonl';
const CURSOR_FILE = 'backend-exits.reported';

/** One line of EXITS_FILE, as tools/watch-server.mjs writes it. */
interface BackendExit {
  at: string;
  kind: 'crash' | 'drained' | 'stopped';
  state: 'running' | 'draining' | 'stopping';
  code: number | null;
  signal: string | null;
  uptimeMs: number;
  pid: number;
}

/** An absent file is the meaning "nothing recorded": `pnpm start` runs no dev runner. */
async function readOrEmpty(file: string): Promise<Buffer> {
  try {
    return await fs.promises.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

/** Journals every unreported crash in `directory`; returns how many. */
export async function reportBackendExits(
  journal: Pick<ErrorJournal, 'capture'>,
  directory: string
): Promise<number> {
  const exits = await readOrEmpty(path.join(directory, EXITS_FILE));
  const reported = Number((await readOrEmpty(path.join(directory, CURSOR_FILE))).toString() || 0);
  // A file shorter than the cursor was replaced by hand; start it over.
  const from = reported <= exits.length ? reported : 0;
  // Only whole lines: the runner writes each record with one append.
  const end = exits.lastIndexOf('\n') + 1;
  if (end <= from) return 0;
  const crashes = exits
    .subarray(from, end)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BackendExit)
    .filter((exit) => exit.kind === 'crash');
  for (const exit of crashes) {
    // No milliseconds in the time: the journal's fingerprint normalizes numbers,
    // and "58.982Z" would survive it and split every crash into its own group.
    const at = `${exit.at.slice(0, 19).replace('T', ' ')} UTC`;
    const how = exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`;
    await journal.capture({
      severity: 'error',
      component: 'backend-exit',
      message: `Backend crashed (${how}) while ${exit.state} after ${exit.uptimeMs}ms, pid ${exit.pid}, at ${at}`,
    });
  }
  await fs.promises.writeFile(path.join(directory, CURSOR_FILE), String(end));
  return crashes.length;
}
