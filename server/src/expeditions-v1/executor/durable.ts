import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';

// The executor's files: one JSON document per record, written whole (tmp, fsync, rename) so a
// crash leaves the old document or the new one, never half of either. Async fs only: these run on
// the server's event loop.

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(value, null, 1)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export type Read<T> = { readonly t: 'found'; readonly value: T } | { readonly t: 'missing' };

/** A record that exists but does not parse is an error, never `missing`: treating it as absent
 * would let `start` run a call a second time. */
export class CorruptRecord extends Error {
  constructor(
    readonly file: string,
    why: string
  ) {
    super(`${file}: ${why}`);
    this.name = 'CorruptRecord';
  }
}

export async function readJson<T>(
  file: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): Promise<Read<T>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { t: 'missing' };
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new CorruptRecord(file, `not JSON (${(e as Error).message})`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new CorruptRecord(file, parsed.error.message);
  return { t: 'found', value: parsed.data };
}

/** A file name for an id that may hold any character and be any length (`<exp>/<key>@<hash>#…`):
 * a readable slug, then enough of the id's sha256 that two ids never share a name. */
export function fileNameOf(id: string): string {
  const slug = id
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 80);
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 24);
  return `${slug}.${digest}`;
}
