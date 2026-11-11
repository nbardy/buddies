import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';

// A card identifies the real path AND exact bytes of the single file. A neighbouring edit cannot
// invalidate it; editing the contract or any prompt does. Guard: expeditions-v1-tool.
export type Digested =
  | { readonly t: 'digest'; readonly digest: string }
  | { readonly t: 'unreadable'; readonly why: string };
export async function digestOf(file: string): Promise<Digested> {
  try {
    const real = await realpath(file);
    const bytes = await readFile(real);
    return {
      t: 'digest',
      digest: createHash('sha256').update(`file\0${real}\0`).update(bytes).digest('hex'),
    };
  } catch (e) {
    return { t: 'unreadable', why: (e as Error).message };
  }
}
