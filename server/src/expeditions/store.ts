import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type Entry, type State, apply, fold } from './ledger';
import { RETIRED_DIR, type RetiredSnapshot, fileRetired, readRetired } from './retired';

// Pattern: one-write-path (docs/patterns.md#one-write-path): every ledger byte is written here,
// one line per append batch, so a batch lands whole or (a torn last line) not at all.

const line = (entries: readonly Entry[]) => `${JSON.stringify(entries)}\n`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type LedgerFile = { t: 'read'; entries: Entry[]; torn: number } | { t: 'corrupt'; reason: string };

/** Boot only (sync fs): a torn last append is cut off; it never landed, so it replays. */
function readLedgerFile(file: string): LedgerFile {
  const bytes = fs.readFileSync(file);
  const end = bytes.lastIndexOf(0x0a) + 1;
  const torn = bytes.length - end;
  if (torn > 0) fs.truncateSync(file, end);
  const lines = bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
  try {
    return { t: 'read', entries: lines.flatMap((l) => JSON.parse(l) as Entry[]), torn };
  } catch (error) {
    return { t: 'corrupt', reason: `unreadable line: ${errorText(error)}` };
  }
}

/** Fix-guard (audit 2026-11-01 #4): a failed append is cut back, never glued to the next one. */
async function appendBatch(file: string, entries: readonly Entry[]): Promise<void> {
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

/** Exclusive (audit 2026-11-01: a colliding id appended a second launch to another ledger). */
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

export type Lookup =
  | { t: 'present' }
  | { t: 'quarantined'; reason: string }
  | { t: 'retired' }
  | { t: 'missing' };

export type ExpeditionStore = ReturnType<typeof openStore>;

/** Boot folds each ledger once (a bad one is quarantined); `append` keeps it current (audit #8). */
export function openStore(root: string) {
  const states = new Map<string, State>();
  const counts = new Map<string, number>();
  /** Ledgers that do not fold, with why. The file stays for the owner. */
  const quarantined = new Map<string, string>();
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
  const load = (id: string, entries: Entry[]) => {
    states.set(id, fold(entries));
    counts.set(id, entries.length);
  };

  for (const [id, read] of readRetired(root))
    if (read.t === 'read') retired.set(id, read.snapshot);
    else quarantine(id, read.reason);
  for (const id of fs.readdirSync(root)) {
    if (id === RETIRED_DIR || !fs.existsSync(fileOf(id))) continue;
    const read = readLedgerFile(fileOf(id));
    if (read.t === 'corrupt') {
      quarantine(id, read.reason);
      continue;
    }
    if (read.torn > 0)
      console.warn(`[expeditions] ${id}: dropped a torn last append (${read.torn} bytes)`);
    try {
      load(id, read.entries);
    } catch (error) {
      quarantine(id, `does not fold: ${errorText(error)}`);
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

  /** Durable first, then applied; an entry that no longer applies quarantines the expedition. */
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

  function serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (chains.get(id) ?? Promise.resolve()).then(work);
    const ignore = () => undefined;
    chains.set(id, next.then(ignore, ignore));
    return next;
  }

  return {
    append,
    serialized,
    stateOf,
    /** decide applies its own intents as it writes them, so it works on a copy. */
    forDecide: (id: string): State => structuredClone(stateOf(id)),
    states: (): State[] => [...states.values()],
    folds: (id: string): boolean => states.has(id),
    written: (id: string): number => counts.get(id) ?? 0,
    async create(id: string, first: Entry[]): Promise<void> {
      await createLedger(path.join(root, id), fileOf(id), first);
      load(id, first);
    },
    /** The ledger's last line is `retired`: frozen, moved, and served as a snapshot. */
    async file(id: string, snapshot: RetiredSnapshot): Promise<void> {
      await fileRetired(root, id, snapshot);
      states.delete(id);
      counts.delete(id);
      retired.set(id, snapshot);
    },
    lookup(id: string): Lookup {
      const reason = quarantined.get(id);
      if (reason) return { t: 'quarantined', reason };
      if (states.has(id)) return { t: 'present' };
      return retired.has(id) ? { t: 'retired' } : { t: 'missing' };
    },
    retiredOf(id: string): RetiredSnapshot {
      const snapshot = retired.get(id);
      if (!snapshot) throw new Error(`expedition ${id} is not retired`);
      return snapshot;
    },
    /** Snapshots whose ledger is filed (one still folding is served live). */
    retired: (): RetiredSnapshot[] =>
      [...retired.values()].filter((r) => !states.has(r.summary.id)),
    settled: () => Promise.all([...chains.values()]).then(() => undefined),
  };
}
