import { constants } from 'node:fs';
import {
  type FileHandle,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { keyed } from '@unleashd/shared';

// One expedition on disk: a directory holding
//   log.jsonl      append-only, one Entry per line, fsync'd on every append
//   contract.md    the owner's
//   plans/v<N>/    each plan version as applied: plan.ts + briefs/
// State is fold(log); nothing else here is durable state (the plan copies are what the plan
// process runs, and a copy with no `plan` entry is a leftover from a crash, removed at open).

const LOG = 'log.jsonl';
const CONTRACT = 'contract.md';
const PLANS = 'plans';
/** Where an expedition directory keeps its contract and each plan version (readers outside the
 * kernel, the leader's draft folder, read them by these). */
export const contractFileOf = (dir: string): string => path.join(dir, CONTRACT);
export const planDirOf = (dir: string, version: number): string =>
  path.join(dir, PLANS, `v${version}`);

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
  static async create(dir: string, contractMarkdown: string): Promise<LogStore> {
    await mkdir(path.dirname(dir), { recursive: true });
    await mkdir(dir);
    await mkdir(path.join(dir, PLANS));
    await writeFile(path.join(dir, CONTRACT), contractMarkdown, { flag: 'wx' });
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
    const text = await readFile(file, 'utf8');
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
    const fh = await open(file, constants.O_WRONLY | constants.O_APPEND);
    if (repair.t !== 'clean') {
      await fh.truncate(Buffer.byteLength(text.slice(0, end)));
      await fh.sync();
    }
    return { store: new LogStore(dir, fh), entries, repair };
  }

  /** Durable when it resolves: the line is written and fsync'd. */
  async append(entry: keyed.Entry): Promise<void> {
    await this.fh.write(`${JSON.stringify(entry)}\n`);
    await this.fh.sync();
  }

  async close(): Promise<void> {
    await this.fh.close();
  }

  get contractFile(): string {
    return contractFileOf(this.dir);
  }

  planDir(version: number): string {
    return planDirOf(this.dir, version);
  }

  /** Copy a plan folder's `plan.ts` and `briefs/` as plan version `version`. Nothing else in the
   * folder is the plan's (its contract.md is the owner's, read and compared, never copied). */
  async copyPlan(from: string, version: number): Promise<void> {
    const dest = this.planDir(version);
    await mkdir(dest);
    await cp(path.join(from, 'plan.ts'), path.join(dest, 'plan.ts'), {
      errorOnExist: true,
      force: false,
    });
    const briefs = path.join(from, 'briefs');
    if (await isDir(briefs))
      await cp(briefs, path.join(dest, 'briefs'), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
  }

  async removePlan(version: number): Promise<void> {
    await rm(this.planDir(version), { recursive: true, force: true });
  }

  /** Plan copies newer than `current`: a rewrite that crashed or failed between copy and apply. */
  async removePlansAfter(current: number): Promise<number[]> {
    const names = await readdir(path.join(this.dir, PLANS));
    const stale = names
      .map((n) => /^v(\d+)$/.exec(n))
      .flatMap((m) => (m ? [Number(m[1])] : []))
      .filter((v) => v > current);
    for (const v of stale) await this.removePlan(v);
    return stale;
  }
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

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch (e) {
    // A plan with no agent steps has no briefs; any other failure is real.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
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
