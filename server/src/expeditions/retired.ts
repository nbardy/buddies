import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ExpeditionRetiredView, ExpeditionSummary } from '@unleashd/shared';
import { z } from 'zod';
import { FINISH_REASONS, type State } from './ledger';
import { expeditionSummary, summaryLine } from './view';

// A retired expedition (plan A6) is frozen: `<root>/.retired/<id>.json` holds its summary and last
// status report, and its folder moves to `<root>/.retired/<id>/`. A retired ledger is never folded
// again. The snapshot has its own frozen shape (`expedition.retired/v1`); the served summary is
// derived on read, so a wire change never strands a snapshot on disk.

export const RETIRED_DIR = '.retired';

const n = z.number();
/** `live`: none once retired (retirement waits until nothing is live). */
const Counts = z.strictObject({
  ...{ attempts: n, maxAttempts: n, decisions: n, maxDecisions: n, live: n, maxLive: n },
  ...{ queued: n, verified: n, exploreCap: n },
});

const Snapshot = z.strictObject({
  t: z.literal('expedition.retired/v1'),
  summary: z.strictObject({
    id: z.string(),
    name: z.string(),
    workspaceId: z.string(),
    launchedAt: z.string(),
    run: z.strictObject({
      t: z.literal('finished'),
      at: z.string(),
      reason: z.enum(FINISH_REASONS),
      summary: z.string(),
    }),
    counts: Counts,
    cost: z.strictObject({ short: z.string(), line: z.string() }),
    retirement: z.strictObject({ t: z.literal('retired'), at: z.string() }),
  }),
  report: z.string(),
});
export type RetiredSnapshot = z.infer<typeof Snapshot>;

export function retiredView(snapshot: RetiredSnapshot): ExpeditionRetiredView {
  const { live, ...counts } = snapshot.summary.counts;
  const served: ExpeditionSummary['counts'] = { ...counts, running: live, liveWorkers: live };
  const line = summaryLine(served, snapshot.summary.cost);
  const summary = { ...snapshot.summary, counts: served, line };
  return { t: 'retired', summary, report: snapshot.report };
}

type RetiredFile = { t: 'read'; snapshot: RetiredSnapshot } | { t: 'corrupt'; reason: string };

function readSnapshot(file: string): RetiredFile {
  try {
    return { t: 'read', snapshot: Snapshot.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  } catch (error) {
    return { t: 'corrupt', reason: `retired snapshot: ${(error as Error).message}` };
  }
}

/** Boot only (sync fs): each snapshot in `.retired`, or why it does not read. */
export function readRetired(root: string): Map<string, RetiredFile> {
  const dir = path.join(root, RETIRED_DIR);
  if (!fs.existsSync(dir)) return new Map();
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  return new Map(names.map((n) => [n.slice(0, -'.json'.length), readSnapshot(path.join(dir, n))]));
}

/** The frozen record of a state whose last line is `retired`; `report` is its status text. */
export function snapshotOf(s: State, report: string): RetiredSnapshot {
  const tags = s.archive.tags.map((t) => `- ${t.branch} → tag ${t.tag} at ${t.sha.slice(0, 10)}`);
  const { line: _line, counts, ...summary } = expeditionSummary(s);
  const { running: _running, liveWorkers, ...rest } = counts;
  return Snapshot.parse({
    t: 'expedition.retired/v1',
    summary: { ...summary, counts: { ...rest, live: liveWorkers } },
    report: tags.length > 0 ? `${report}\n\nArchived on origin:\n${tags.join('\n')}` : report,
  });
}

/** Snapshot first (temp + rename: whole or absent), then the folder; a crash between replays
 * from the ledger, whose last line is already `retired`. */
export async function fileRetired(root: string, id: string, snapshot: RetiredSnapshot) {
  const dir = path.join(root, RETIRED_DIR);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.json`);
  await fsp.writeFile(`${file}.tmp`, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(`${file}.tmp`, file);
  await fsp.rename(path.join(root, id), path.join(dir, id));
}
