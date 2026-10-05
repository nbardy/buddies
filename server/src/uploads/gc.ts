import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Uploads retention. `POST /api/upload` writes `<uploads>/<conversationId>/<ts>_<name>` and the
 * message carries the absolute path (`[Attached files]\n<path>`); nothing ever deleted them, and
 * the directory reached 701 MB (2026-09-25).
 *
 * The unit of deletion is a top-level entry of the uploads directory. An entry is deleted only when
 * ALL of these hold:
 *   - it is older than `maxAgeMs` (its newest file, re-checked right before deletion);
 *   - its name is not a known conversation id (`protectedNames`: active AND trashed records);
 *   - its name never follows `uploads/` (or the JSON-escaped / URL-encoded forms) in any file under
 *     `referenceRoots` (provider transcripts, the app data directory, the Buddies DB directory);
 *   - it is not `channels/`, whose media belongs to channel posts (channel-media.ts).
 * Any unreadable reference root or file aborts the run with no deletions: a reference we could not
 * read is a reference we cannot rule out.
 *
 * The scan reads every transcript (~10 GB here), so it runs off the event loop at low priority,
 * once a day, measured from the LAST SUCCESSFUL pass (`startUploadsGc`). It used to run on every
 * backend start too: stale entries are mostly kept (still referenced), so each restart re-proved
 * the same answer with a full 10 GB read, 8+ minutes at ~100% CPU on a loaded machine, while the
 * UI showed "Buddies is loading slowly" (2026-10-06). Guard: uploads-gc.test.ts 'restart'.
 */

export const UPLOADS_RETENTION_MS = 30 * 24 * 60 * 60_000;
const UPLOADS_GC_INTERVAL_MS = 24 * 60 * 60_000;
/** The first pass waits this long after boot, so it never competes with startup. */
export const UPLOADS_GC_FIRST_DELAY_MS = 10 * 60_000;
const UPLOADS_GC_RETRY_MS = 60 * 60_000;
// ingest.sqlite is a derived copy of the transcripts, which are scanned at their source: reading
// it again only doubles the bytes (931 MB here).
const DERIVED_STORE = /^ingest\.sqlite(-wal|-shm)?$/;
const UPLOADS_GC_TASK = 'unleashd-uploads-gc' as const;
const ALWAYS_KEPT = new Set(['channels']);
const NEEDLES = ['uploads/', 'uploads\\/', 'uploads%2F', 'uploads%2f'].map((n) => Buffer.from(n));
const MAX_NAME_BYTES = 255;
const CHUNK_BYTES = 1 << 20;

export interface UploadsGcOptions {
  uploadsDir: string;
  referenceRoots: readonly string[];
  protectedNames: readonly string[];
  maxAgeMs: number;
  nowMs: number;
}

export interface UploadsGcReport {
  deleted: { name: string; bytes: number }[];
  keptReferenced: number;
  keptRecent: number;
  scannedFiles: number;
}

type EntryStat = { bytes: number; newestMs: number };

async function entryStat(target: string): Promise<EntryStat> {
  const stat = await fs.promises.lstat(target);
  if (!stat.isDirectory()) return { bytes: stat.size, newestMs: stat.mtimeMs };
  let bytes = 0;
  let newestMs = stat.mtimeMs;
  for (const child of await fs.promises.readdir(target)) {
    const inner = await entryStat(path.join(target, child));
    bytes += inner.bytes;
    newestMs = Math.max(newestMs, inner.newestMs);
  }
  return { bytes, newestMs };
}

function isNameByte(c: number): boolean {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 45 ||
    c === 46 ||
    c === 95
  );
}

/** Adds every name that follows an uploads needle in `data` to `found`. */
function collectNames(data: Buffer, found: Set<string>): void {
  for (const needle of NEEDLES) {
    let at = data.indexOf(needle);
    while (at !== -1) {
      let end = at + needle.length;
      while (end < data.length && isNameByte(data[end])) end += 1;
      if (end > at + needle.length) found.add(data.toString('latin1', at + needle.length, end));
      at = data.indexOf(needle, at + 1);
    }
  }
}

async function scanFile(file: string, found: Set<string>): Promise<void> {
  const handle = await fs.promises.open(file, 'r');
  try {
    // Overlap chunks so a needle + name split across a boundary is still seen whole.
    const overlap = 16 + MAX_NAME_BYTES;
    const buffer = Buffer.alloc(CHUNK_BYTES + overlap);
    let carried = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, carried, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const filled = carried + bytesRead;
      collectNames(buffer.subarray(0, filled), found);
      carried = Math.min(overlap, filled);
      buffer.copy(buffer, 0, filled - carried, filled);
    }
  } finally {
    await handle.close();
  }
}

/** Names referenced under any root. ENOENT roots are absent providers; other errors throw. */
async function collectReferences(
  roots: readonly string[],
  skip: string
): Promise<{ names: Set<string>; files: number }> {
  const names = new Set<string>();
  let files = 0;
  const walk = async (target: string): Promise<void> => {
    if (path.resolve(target) === skip) return;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isDirectory()) {
      for (const child of await fs.promises.readdir(target)) await walk(path.join(target, child));
    } else if (stat.isFile() && !DERIVED_STORE.test(path.basename(target))) {
      await scanFile(target, names);
      files += 1;
    }
  };
  for (const root of roots) await walk(root);
  return { names, files };
}

export async function runUploadsGc(options: UploadsGcOptions): Promise<UploadsGcReport> {
  const uploadsDir = path.resolve(options.uploadsDir);
  const report: UploadsGcReport = {
    deleted: [],
    keptReferenced: 0,
    keptRecent: 0,
    scannedFiles: 0,
  };
  let entries: string[];
  try {
    entries = await fs.promises.readdir(uploadsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report;
    throw error;
  }
  const cutoff = options.nowMs - options.maxAgeMs;
  const stale: string[] = [];
  for (const name of entries) {
    if ((await entryStat(path.join(uploadsDir, name))).newestMs >= cutoff) report.keptRecent += 1;
    else stale.push(name);
  }
  if (stale.length === 0) return report;

  const references = await collectReferences(options.referenceRoots, uploadsDir);
  report.scannedFiles = references.files;
  const protectedNames = new Set(options.protectedNames);
  for (const name of stale) {
    if (ALWAYS_KEPT.has(name) || protectedNames.has(name) || references.names.has(name)) {
      report.keptReferenced += 1;
      continue;
    }
    const target = path.join(uploadsDir, name);
    // Re-check: an upload may have landed in this entry while the scan ran.
    const current = await entryStat(target);
    if (current.newestMs >= cutoff) {
      report.keptRecent += 1;
      continue;
    }
    await fs.promises.rm(target, { recursive: true });
    report.deleted.push({ name, bytes: current.bytes });
  }
  return report;
}

/**
 * Runs one GC pass in a child PROCESS, never a worker thread: the reference roots hold the live
 * SQLite stores. POSIX locks belong to the process, so a close() of any descriptor on a store
 * inode here released every lock the backend held on it; the next outside opener (sqlite3, a
 * second backend) then reset the mapped -shm → SIGBUS in buddies-core.node, twice on 2026-09-30,
 * and deleted the backend's WAL on close. Guard: server/test/sqlite-locks.test.ts.
 */
// Pattern: store-descriptor-isolation (docs/patterns.md#store-descriptor-isolation)
export function runUploadsGcInChild(options: UploadsGcOptions): Promise<UploadsGcReport> {
  return new Promise((resolve, reject) => {
    // The child inherits process.execArgv, so it loads this file the way the parent did
    // (tsx's `--import` in dev, plain CJS in dist). tsx's preflight shares the IPC channel,
    // so both ends read only messages tagged with the task.
    const child = fork(__filename, [UPLOADS_GC_TASK], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let settled = false;
    child.on('message', (message: Partial<GcReply>) => {
      if (message.task !== UPLOADS_GC_TASK || !message.result) return;
      settled = true;
      const { result } = message;
      result.ok ? resolve(result.report) : reject(new Error(result.error));
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (!settled)
        reject(new Error(`uploads GC process exited (${code ?? signal}) without a report`));
    });
    child.send({ task: UPLOADS_GC_TASK, options } satisfies GcRequest);
  });
}

export interface UploadsGcSchedule {
  /** Where the last successful pass is recorded, so a restart does not repeat it. */
  stateFile: string;
  firstDelayMs: number;
}

function readLastSuccessMs(stateFile: string): number | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const at = (parsed as { lastSuccessMs?: unknown }).lastSuccessMs;
    return typeof at === 'number' ? at : null;
  } catch {
    // No record, or an unreadable one: run the pass. That is the safe direction, it only costs a scan.
    return null;
  }
}

/** Wait before the next pass: a day after the last success, never sooner than the boot delay. */
export function gcDelayMs(
  lastSuccessMs: number | null,
  nowMs: number,
  firstDelayMs: number
): number {
  const due = lastSuccessMs === null ? nowMs : lastSuccessMs + UPLOADS_GC_INTERVAL_MS;
  return Math.max(firstDelayMs, due - nowMs);
}

/** One pass a day, starting `firstDelayMs` after boot or a day after the last success. */
// Pattern: fix-guard (docs/patterns.md#fix-guards): the schedule is persisted, never "on every start".
export function startUploadsGc(
  inputs: () => Promise<Omit<UploadsGcOptions, 'nowMs'>>,
  schedule: UploadsGcSchedule
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const arm = (delayMs: number) => {
    timer = setTimeout(() => void pass(), delayMs);
    timer.unref();
  };
  const pass = async () => {
    let succeeded = false;
    try {
      const report = await runUploadsGcInChild({ ...(await inputs()), nowMs: Date.now() });
      const freed = report.deleted.reduce((sum, entry) => sum + entry.bytes, 0);
      console.log(
        `[uploads-gc] deleted ${report.deleted.length} entries (${(freed / 1e6).toFixed(1)} MB); ` +
          `kept ${report.keptReferenced} referenced, ${report.keptRecent} recent; ` +
          `scanned ${report.scannedFiles} files`
      );
      fs.writeFileSync(schedule.stateFile, JSON.stringify({ lastSuccessMs: Date.now() }));
      succeeded = true;
    } catch (error) {
      console.warn('[uploads-gc] pass aborted, nothing deleted after the failure:', error);
    }
    if (!stopped) arm(succeeded ? UPLOADS_GC_INTERVAL_MS : UPLOADS_GC_RETRY_MS);
  };
  arm(gcDelayMs(readLastSuccessMs(schedule.stateFile), Date.now(), schedule.firstDelayMs));
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

type GcRequest = { task: typeof UPLOADS_GC_TASK; options: UploadsGcOptions };
type GcReply = {
  task: typeof UPLOADS_GC_TASK;
  result: { ok: true; report: UploadsGcReport } | { ok: false; error: string };
};

if (process.argv[2] === UPLOADS_GC_TASK && process.send) {
  const reply = (result: GcReply['result']) =>
    process.send?.({ task: UPLOADS_GC_TASK, result } satisfies GcReply, () => process.disconnect());
  const onRequest = (message: Partial<GcRequest>) => {
    if (message.task !== UPLOADS_GC_TASK || !message.options) return;
    process.off('message', onRequest);
    // A 10 GB read must never outrank the user's foreground work.
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
    runUploadsGc(message.options).then(
      (report) => reply({ ok: true, report }),
      (error: unknown) => reply({ ok: false, error: String((error as Error)?.stack ?? error) })
    );
  };
  process.on('message', onRequest);
}
