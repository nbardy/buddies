import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// The digest of a plan folder (CONNECT_PLAN §5, step 8): a proposal card carries it, a launch
// sends it back, and the server refuses a folder whose files no longer hash to it. Owner
// 2026-11-11: the owner launches what they LOOKED at, not what the folder holds by then (a Buddy
// may keep editing its files after proposing). It covers exactly what a launch copies and runs
// (`LogStore.copyPlan`): contract.md, plan.ts and every file under briefs/, plus the folder's
// own path (the same files elsewhere are another proposal). Guard: expeditions-v1-tool.test.ts.

const FILES = ['contract.md', 'plan.ts'] as const;

/** Every regular file under `dir`, as `/`-joined paths relative to `base`, sorted. */
async function filesUnder(base: string, dir: string): Promise<string[]> {
  const entries = await readdir(path.join(base, dir), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory() ? filesUnder(base, `${dir}/${e.name}`) : Promise.resolve([`${dir}/${e.name}`])
    )
  );
  return nested.flat().sort();
}

export type Digested =
  | { readonly t: 'digest'; readonly digest: string }
  | { readonly t: 'unreadable'; readonly why: string };

export async function digestOf(folder: string): Promise<Digested> {
  try {
    const briefs = await filesUnder(folder, 'briefs').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    const hash = createHash('sha256').update(`folder\0${folder}\0`);
    for (const rel of [...FILES, ...briefs]) {
      const bytes = await readFile(path.join(folder, rel)).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      // A missing file hashes as missing, so adding or deleting one changes the digest.
      hash.update(
        `${rel}\0${bytes === null ? 'missing' : createHash('sha256').update(bytes).digest('hex')}\0`
      );
    }
    return { t: 'digest', digest: hash.digest('hex') };
  } catch (e) {
    return { t: 'unreadable', why: (e as Error).message };
  }
}
