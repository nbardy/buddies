import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type Attempt, Expedition, type Launch, type State } from '@unleashd/shared';

// One file per expedition, `<root>/<id>.json` (docs/expeditions-lean-design.md §3.1). Parsed once
// at boot (κ); written whole through tmp + rename, so a torn write cannot happen.

/** A launched record: its state carries the Launch, so handlers never ask "launched?". */
export type Launched = Expedition & { state: Extract<State, { launch: Launch }> };
export const withAttempt = (x: Launched, a: Attempt): Launched => ({
  ...x,
  attempts: x.attempts.map((b) => (b.n === a.n ? a : b)),
});

export type Loaded = { t: 'ok'; x: Expedition } | { t: 'unreadable'; id: string; reason: string };

/** Boot only (sync fs). Directories (`.retired/`, `trees/`, `checks/`, `crews/`, the old
 * `drafts/`) and non-`.json` names (tmp files) are skipped. A file that does not parse is an
 * `unreadable` row with the reason: never skipped, never rewritten. */
export function loadAll(root: string): Map<string, Loaded> {
  const out = new Map<string, Loaded>();
  const entries = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [];
  for (const e of entries.filter((e) => e.isFile() && e.name.endsWith('.json'))) {
    const id = e.name.slice(0, -'.json'.length);
    out.set(id, loadOne(path.join(root, e.name), id));
  }
  return out;
}

function loadOne(file: string, id: string): Loaded {
  try {
    const parsed = Expedition.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success)
      return { t: 'unreadable', id, reason: parsed.error.issues.map((i) => i.message).join('; ') };
    if (parsed.data.id !== id) return { t: 'unreadable', id, reason: `id is ${parsed.data.id}` };
    return { t: 'ok', x: parsed.data };
  } catch (error) {
    return { t: 'unreadable', id, reason: (error as Error).message };
  }
}

export const paths = (root: string, id: string) => ({
  file: path.join(root, `${id}.json`),
  retired: path.join(root, '.retired', `${id}.json`),
  tree: (n: number) => path.join(root, 'trees', `exp-${id}-a${n}`),
  check: (n: number) => path.join(root, 'checks', `${id}-a${n}`),
  crewDir: path.join(root, 'crews', id),
});

export async function save(root: string, x: Expedition): Promise<void> {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const file = paths(root, x.id).file;
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(x, null, 1)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, file);
}

export const retiredTaken = (root: string, id: string) => fs.existsSync(paths(root, id).retired);

/** The retired wrapper goes to `.retired/<id>.json` (never over an existing file), then the
 * live file is unlinked. Nothing parses `.retired/`: the loader skips directories. */
export async function fileRetired(root: string, x: Expedition, at: string): Promise<void> {
  const p = paths(root, x.id);
  await fsp.mkdir(path.dirname(p.retired), { recursive: true, mode: 0o700 });
  const tmp = `${p.file}.retired.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ v: 1, t: 'retired', at, record: x }), { mode: 0o600 });
  try {
    await fsp.copyFile(tmp, p.retired, fs.constants.COPYFILE_EXCL);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  await fsp.unlink(p.file);
}

/** `<slug(name) ≤24>-<6 hex>`. */
export function newId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return `${slug || 'expedition'}-${randomBytes(3).toString('hex')}`;
}
