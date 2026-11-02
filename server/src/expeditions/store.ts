import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Entry } from './ledger';

// The ledger file: one line per append batch (a decide batch with its `manager_applied`, an
// intent, an effect's result), so a batch lands whole or not at all.
// Pattern: one-write-path (docs/patterns.md#one-write-path) — every ledger byte is written here.

/** One line per batch: a batch lands whole or, torn, not at all. */
const line = (entries: readonly Entry[]) => `${JSON.stringify(entries)}\n`;

/**
 * What boot reads from a ledger file: its entries (with the bytes of a torn last append cut
 * off), or why it does not read. A crash during an append leaves at most a torn LAST line, a
 * batch that never landed: its effect had not run, or replays idempotently.
 */
export type LedgerFile =
  | { t: 'read'; entries: Entry[]; torn: number }
  | { t: 'corrupt'; reason: string };

export function readLedgerFile(file: string): LedgerFile {
  // Sync fs at boot only (createExpeditionHost runs once, before any tick).
  const bytes = fs.readFileSync(file);
  const end = bytes.lastIndexOf(0x0a) + 1;
  const torn = bytes.length - end;
  if (torn > 0) fs.truncateSync(file, end);
  const lines = bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
  try {
    return {
      t: 'read',
      entries: lines.flatMap((l) => JSON.parse(l) as Entry[]),
      torn,
    };
  } catch (error) {
    return { t: 'corrupt', reason: `unreadable line: ${(error as Error).message}` };
  }
}

/**
 * Appends one batch durably: written, then fsynced, before the caller applies it. A write that
 * fails partway is cut back to the size the file had before it, so a failed append never leaves
 * half a line for the next append to be glued onto (audit 2026-11-01 #4: a bare `appendFile`
 * that failed mid-line, ENOSPC say, made the NEXT append's line unreadable, a tear in the middle
 * of the ledger that boot quarantines). Fix-guard: "a failed append leaves the file as it was".
 */
export async function appendBatch(file: string, entries: readonly Entry[]): Promise<void> {
  const handle = await fsp.open(file, 'a', 0o600);
  try {
    const { size } = await handle.stat();
    try {
      await handle.write(line(entries));
      await handle.sync();
    } catch (error) {
      await handle.truncate(size).catch((cut: unknown) => {
        console.warn(`[expeditions] could not cut ${file} back to ${size} bytes:`, cut);
      });
      throw error;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Creates an expedition's directory and ledger exclusively (audit 2026-11-01: creation was not
 * exclusive, so a colliding id would have appended a second launch to another expedition's
 * ledger). `mkdir` without `recursive` and `wx` both refuse what already exists.
 */
export async function createLedger(dir: string, file: string, first: readonly Entry[]) {
  await fsp.mkdir(dir, { mode: 0o700 });
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.write(line(first));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
