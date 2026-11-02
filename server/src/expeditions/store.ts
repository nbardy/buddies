import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type Entry, type State, apply, fold } from './ledger';
import { RETIRED_DIR, type RetiredSnapshot, fileRetired, readRetired } from './retired';

// The ledger file: one line per append batch (a decide batch with its `manager_applied`, an
// intent, an effect's result), so a batch lands whole or not at all.
// Pattern: one-write-path (docs/patterns.md#one-write-path) — every ledger byte is written here.
// The host's store (openStore, below) is the one owner of the folded states, the quarantine,
// the retired snapshots and each expedition's write chain.

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

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the host knows of an expedition id: a ledger it folds, one it set aside because it does
 * not fold (named, with the reason; the other expeditions keep running), a retired snapshot
 * (retired.ts: never folded), or none. */
export type Lookup =
  | { t: 'present' }
  | { t: 'quarantined'; reason: string }
  | { t: 'retired' }
  | { t: 'missing' };

export type ExpeditionStore = ReturnType<typeof openStore>;

/**
 * Boot: every ledger under `root` read and folded once, every retired snapshot read. A ledger that
 * cannot be read or folded is quarantined, so one bad file never stops the server or the other
 * expeditions. `.retired` holds retired folders: never folded again.
 */
export function openStore(root: string) {
  /**
   * Each expedition's folded state, kept current by applying every appended batch (audit
   * 2026-11-01 #8: every event re-folded every ledger from its first entry). Readers get the
   * live object; decide mutates, so it gets a clone (`forDecide`). `counts` is each ledger's
   * entry count: a tick compares it to tell whether a round wrote anything.
   */
  const states = new Map<string, State>();
  const counts = new Map<string, number>();
  /** Ledgers that do not fold, with why. Set aside, never deleted: the file stays for the owner. */
  const quarantined = new Map<string, string>();
  /** Retired expeditions, by id: frozen snapshots, never folded (retired.ts). */
  const retired = new Map<string, RetiredSnapshot>();
  const chains = new Map<string, Promise<void>>();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const quarantine = (id: string, reason: string) => {
    console.warn(`[expeditions] ${id} quarantined: ${reason}`);
    states.delete(id);
    counts.delete(id);
    quarantined.set(id, reason);
  };
  const fileOf = (id: string) => path.join(root, id, 'ledger.jsonl');

  for (const [id, read] of readRetired(root))
    switch (read.t) {
      case 'read':
        retired.set(id, read.snapshot);
        break;
      case 'corrupt':
        quarantine(id, read.reason);
    }
  for (const id of fs.readdirSync(root)) {
    if (id === RETIRED_DIR) continue;
    const file = fileOf(id);
    if (!fs.existsSync(file)) continue;
    const read = readLedgerFile(file);
    switch (read.t) {
      case 'corrupt':
        quarantine(id, read.reason);
        continue;
      case 'read':
        if (read.torn > 0)
          console.warn(`[expeditions] ${id}: dropped a torn last append (${read.torn} bytes)`);
        try {
          states.set(id, fold(read.entries));
          counts.set(id, read.entries.length);
        } catch (error) {
          quarantine(id, `does not fold: ${errorText(error)}`);
        }
    }
  }

  const stateOf = (id: string): State => {
    const state = states.get(id);
    if (state) return state;
    const reason = quarantined.get(id);
    throw new Error(
      reason ? `expedition ${id} is quarantined: ${reason}` : `unknown expedition ${id}`
    );
  };

  /** Durable first (appendBatch), then applied to the cached state. An entry that no longer
   * applies is a broken invariant: the expedition is quarantined, the others go on. */
  async function append(id: string, entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const state = stateOf(id);
    await appendBatch(fileOf(id), entries);
    counts.set(id, (counts.get(id) ?? 0) + entries.length);
    try {
      for (const entry of entries) apply(state, entry);
    } catch (error) {
      quarantine(id, `does not fold: ${errorText(error)}`);
      throw error;
    }
  }

  /** Runs `work` on the chain `id` names: after every earlier tick and append, before later ones. */
  function serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (chains.get(id) ?? Promise.resolve()).then(work);
    chains.set(
      id,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  return {
    append,
    serialized,
    stateOf,
    /** decide applies its own intents as it writes them, so it works on a copy: the cache is
     * applied once, by `append`. */
    forDecide: (id: string): State => structuredClone(stateOf(id)),
    /** Every folded expedition (the live objects: read, never written). */
    states: (): State[] => [...states.values()],
    folds: (id: string): boolean => states.has(id),
    /** Entries in an expedition's ledger: a tick compares it to tell whether a round wrote. */
    written: (id: string): number => counts.get(id) ?? 0,
    /** Creates the ledger exclusively; the state joins the store only once that line is on
     * disk, so every expedition in it folds and no tick ever meets a half-written launch. */
    async create(id: string, first: Entry[]): Promise<void> {
      await createLedger(path.join(root, id), fileOf(id), first);
      states.set(id, fold(first));
      counts.set(id, first.length);
    },
    /** The ledger's last line is `retired`: frozen, moved, and from now on served as a snapshot. */
    async file(id: string, snapshot: RetiredSnapshot): Promise<void> {
      await fileRetired(root, id, snapshot);
      states.delete(id);
      counts.delete(id);
      retired.set(id, snapshot);
    },
    lookup(id: string): Lookup {
      const reason = quarantined.get(id);
      if (reason) return { t: 'quarantined', reason };
      // A retired ledger is served live until its folder is moved (`file`), then as a snapshot.
      if (states.has(id)) return { t: 'present' };
      return retired.has(id) ? { t: 'retired' } : { t: 'missing' };
    },
    /** A retired expedition's frozen record (lookup said `retired`). */
    retiredOf(id: string): RetiredSnapshot {
      const snapshot = retired.get(id);
      if (!snapshot) throw new Error(`expedition ${id} is not retired`);
      return snapshot;
    },
    /** Retired snapshots whose ledger is filed (one still folding is served live). */
    retired: (): RetiredSnapshot[] =>
      [...retired.values()].filter((r) => !states.has(r.summary.id)),
    /** Tests: resolves once every chain's queued work has run. */
    settled: () => Promise.all([...chains.values()]).then(() => undefined),
  };
}
