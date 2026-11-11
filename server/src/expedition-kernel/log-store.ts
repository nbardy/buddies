import { constants } from 'node:fs';
import { type FileHandle, copyFile, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { keyed } from '@unleashd/shared';

// One expedition on disk: a directory holding
//   log.jsonl      append-only, one Entry per line, fsync'd on every append
//   plans/v<N>.expedition.ts   each applied plan, contract and prompts included
// State is fold(log); an unapplied copy is removed at open.
const LOG = 'log.jsonl';
const PLANS = 'plans';
export const planFileOf = (dir: string, version: number): string =>
  path.join(dir, PLANS, `v${version}.expedition.ts`);

/** A line of the log that is not an Entry. Only the LAST line can be torn by a crash (an append
 * that never finished, so nothing acted on it); any other bad line is a corrupt log and opening
 * it fails rather than guessing. */
export class LogCorrupt extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly why: string
  ) {
    super(`${file}:${line}: ${why}`);
    this.name = 'LogCorrupt';
  }
}

export type Repair =
  | { readonly t: 'clean' }
  /** The last line had no newline: an append cut off by a crash. It was truncated away. */
  | { readonly t: 'truncated-torn-line'; readonly bytes: number; readonly text: string };

export type Opened = {
  readonly store: LogStore;
  readonly entries: keyed.Entry[];
  readonly repair: Repair;
};

export class LogStore {
  private constructor(
    readonly dir: string,
    private readonly fh: FileHandle
  ) {}

  /** A new expedition directory. Fails if `dir` exists: an expedition is never written over. */
  static async create(dir: string): Promise<LogStore> {
    await mkdir(path.dirname(dir), { recursive: true });
    await mkdir(dir);
    await mkdir(path.join(dir, PLANS));
    const fh = await open(
      path.join(dir, LOG),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND
    );
    await fh.sync();
    await syncDir(dir);
    return new LogStore(dir, fh);
  }

  static async open(dir: string): Promise<Opened> {
    const file = path.join(dir, LOG);
    const read = parseLog(file, await readFile(file, 'utf8'));
    const fh = await open(file, constants.O_WRONLY | constants.O_APPEND);
    if (read.repair.t !== 'clean') {
      await fh.truncate(read.wholeBytes);
      await fh.sync();
    }
    return { store: new LogStore(dir, fh), entries: read.entries, repair: read.repair };
  }

  /** Durable when it resolves: the line is written and fsync'd. */
  async append(entry: keyed.Entry): Promise<void> {
    await this.fh.write(`${JSON.stringify(entry)}\n`);
    await this.fh.sync();
  }

  async close(): Promise<void> {
    await this.fh.close();
  }

  planFile(version: number): string {
    return planFileOf(this.dir, version);
  }

  /** One immutable plan version; no neighbouring file is part of it. */
  async copyPlan(from: string, version: number): Promise<void> {
    await copyFile(from, this.planFile(version), constants.COPYFILE_EXCL);
  }

  async removePlan(version: number): Promise<void> {
    await rm(this.planFile(version), { force: true });
  }

  /** Plan copies newer than `current`: a rewrite that crashed or failed between copy and apply. */
  async removePlansAfter(current: number): Promise<number[]> {
    const names = await readdir(path.join(this.dir, PLANS));
    const stale = names
      .map((n) => /^v(\d+)\.expedition\.ts$/.exec(n))
      .flatMap((m) => (m ? [Number(m[1])] : []))
      .filter((v) => v > current);
    for (const v of stale) await this.removePlan(v);
    return stale;
  }
}

/** A log as it is on disk, for a reader that must not write: the keyed host's read-only mode
 * (expeditions-v1/shelf.ts). It never opens the file for writing, so a torn last line stays on
 * disk and is only reported (`LogStore.open` truncates it; a reader must not race a writer). */
export type Tail =
  | { readonly t: 'clean' }
  /** The last line has no newline (an append in flight, or cut off by a crash): left out. */
  | { readonly t: 'torn-last-line'; readonly bytes: number };
export type ReadLog = { readonly entries: keyed.Entry[]; readonly tail: Tail };
export async function readLog(dir: string): Promise<ReadLog> {
  const file = path.join(dir, LOG);
  const { entries, repair } = parseLog(file, await readFile(file, 'utf8'));
  return {
    entries,
    tail: repair.t === 'clean' ? repair : { t: 'torn-last-line', bytes: repair.bytes },
  };
}

/** Every complete line as an entry; a last line with no newline is torn (see LogCorrupt). */
function parseLog(
  file: string,
  text: string
): { entries: keyed.Entry[]; repair: Repair; wholeBytes: number } {
  const end = text.lastIndexOf('\n') + 1;
  const torn = text.slice(end);
  const repair: Repair =
    torn === ''
      ? { t: 'clean' }
      : { t: 'truncated-torn-line', bytes: Buffer.byteLength(torn), text: torn };
  const entries = text
    .slice(0, end)
    .split('\n')
    .slice(0, -1)
    .map((line, i) => parseLine(file, i + 1, line));
  return { entries, repair, wholeBytes: Buffer.byteLength(text.slice(0, end)) };
}

function parseLine(file: string, line: number, text: string): keyed.Entry {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new LogCorrupt(file, line, `not JSON (${(e as Error).message})`);
  }
  const parsed = keyed.Entry.safeParse(json);
  if (!parsed.success)
    throw new LogCorrupt(
      file,
      line,
      `not an entry: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  return parsed.data;
}

/** fsync the directory so a newly created file's name is durable too. */
async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, constants.O_RDONLY);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
