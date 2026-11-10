import path from 'node:path';
import type { keyed } from '@unleashd/shared';
import { z } from 'zod';
import { type Read, fileNameOf, readJson, writeJsonAtomic } from './durable';

// The ref store (CONNECT_PLAN §0.12): the kernel logs a call's `out` but not where its work is, so
// a judge or a later call that names a ref needs the executor's record of it. One record per
// output at `<expDir>/refs/<name>.json`, written before the run that made it reports `ok` or
// `no`: a ref the kernel can see always resolves here.

const v = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.object({ t: z.literal(t), ...shape }).strict();

export const RefRecord = z
  .object({
    ref: z.string().min(1),
    out: z.unknown(),
    /** `out` as JSON: what a check judge reads as `EXPEDITION_OUTPUT`. */
    answerPath: z.string().min(1),
    /** The commit the output is at: a command's is the commit it ran on (it keeps no changes). */
    commit: z.string().min(1),
    /** An agent call with a checkout made a branch (a later step); a command makes none. */
    checkout: z.discriminatedUnion('t', [
      v('none', {}),
      v('branch', {
        branch: z.string().min(1),
        salvage: z.discriminatedUnion('t', [v('none', {}), v('ref', { name: z.string() })]),
      }),
    ]),
    /** The agent conversation that produced it (a later step); a command has none. */
    conversation: z.discriminatedUnion('t', [v('none', {}), v('conversation', { id: z.string() })]),
  })
  .strict();
export type RefRecord = z.infer<typeof RefRecord>;

/** Where a ref's record and answer file are. */
export const refFilesOf = (expDir: string, ref: keyed.RefId) => {
  const name = fileNameOf(ref);
  return {
    record: path.join(expDir, 'refs', `${name}.json`),
    answer: path.join(expDir, 'refs', `${name}.out.json`),
  };
};

/** The answer file first, then the record: a record never points at a missing answer. */
export async function putRef(expDir: string, r: Omit<RefRecord, 'answerPath'>): Promise<RefRecord> {
  const at = refFilesOf(expDir, r.ref);
  await writeJsonAtomic(at.answer, r.out);
  const record = RefRecord.parse({ ...r, answerPath: at.answer });
  await writeJsonAtomic(at.record, record);
  return record;
}

export const getRef = (expDir: string, ref: keyed.RefId): Promise<Read<RefRecord>> =>
  readJson(refFilesOf(expDir, ref).record, RefRecord);
