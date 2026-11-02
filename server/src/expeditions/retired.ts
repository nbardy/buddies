import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ExpeditionRetiredView, ExpeditionSummary } from '@unleashd/shared';
import { z } from 'zod';
import type { State } from './ledger';
import { expeditionSummary } from './view';

// A retired expedition (plan A6) is frozen: `<root>/.retired/<id>.json` holds its summary and its
// last status report, and its folder (ledger, harvest) moves to `<root>/.retired/<id>/`. Boot
// reads the snapshots and never folds a retired ledger again, so code that changes the ledger
// format owes nothing to a retired expedition.

export const RETIRED_DIR = '.retired';

const Counts = z.object({
  attempts: z.number(),
  maxAttempts: z.number(),
  decisions: z.number(),
  maxDecisions: z.number(),
  live: z.number(),
  maxLive: z.number(),
  queued: z.number(),
  verified: z.number(),
  exploreCap: z.number(),
});

const FinishReason = z.enum([
  'done',
  'attempts_spent',
  'decisions_spent',
  'deadline',
  'owner_stop',
  'setup_failed',
]);

/** κ for a snapshot file: the summary as the list serves it (a retired run is always finished). */
const Snapshot = z
  .object({
    t: z.literal('expedition.retired/v1'),
    summary: z
      .object({
        id: z.string(),
        name: z.string(),
        workspaceId: z.string(),
        launchedAt: z.string(),
        run: z
          .object({
            t: z.literal('finished'),
            at: z.string(),
            reason: FinishReason,
            summary: z.string(),
          })
          .strict(),
        counts: Counts.strict(),
        cost: z.object({ short: z.string(), line: z.string() }).strict(),
        retirement: z.object({ t: z.literal('retired'), at: z.string() }).strict(),
      })
      .strict(),
    report: z.string(),
  })
  .strict();
export type RetiredSnapshot = z.infer<typeof Snapshot>;

export const retiredView = (snapshot: RetiredSnapshot): ExpeditionRetiredView => ({
  t: 'retired',
  summary: snapshot.summary satisfies ExpeditionSummary,
  report: snapshot.report,
});

/** What boot reads in `.retired`: each snapshot, or why one does not read (set aside, named). */
export type RetiredFile =
  | { t: 'read'; snapshot: RetiredSnapshot }
  | { t: 'corrupt'; reason: string };

/** Sync fs at boot only (createExpeditionHost runs once, before any tick). */
export function readRetired(root: string): Map<string, RetiredFile> {
  const dir = path.join(root, RETIRED_DIR);
  const out = new Map<string, RetiredFile>();
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const id = name.slice(0, -'.json'.length);
    try {
      const parsed = Snapshot.safeParse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      out.set(
        id,
        parsed.success
          ? { t: 'read', snapshot: parsed.data }
          : { t: 'corrupt', reason: `retired snapshot: ${parsed.error.message}` }
      );
    } catch (error) {
      out.set(id, { t: 'corrupt', reason: `retired snapshot: ${(error as Error).message}` });
    }
  }
  return out;
}

/** The frozen record of a state whose last line is `retired`; `report` is its status text. */
export function snapshotOf(s: State, report: string): RetiredSnapshot {
  const tags = s.archive.tags.map((t) => `- ${t.branch} → tag ${t.tag} at ${t.sha.slice(0, 10)}`);
  return Snapshot.parse({
    t: 'expedition.retired/v1',
    summary: expeditionSummary(s),
    report: tags.length > 0 ? `${report}\n\nArchived on origin:\n${tags.join('\n')}` : report,
  });
}

/**
 * Writes the snapshot (a temp file renamed into place: whole or absent), then moves the
 * expedition's folder under `.retired`. A crash between the two is replayed from the ledger,
 * whose last line is already `retired`; the rename is atomic, so the folder is in one place.
 */
export async function fileRetired(root: string, id: string, snapshot: RetiredSnapshot) {
  const dir = path.join(root, RETIRED_DIR);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.json`);
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file);
  await fsp.rename(path.join(root, id), path.join(dir, id));
}
