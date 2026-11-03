import fsp from 'node:fs/promises';
import type { BuddiesCore } from '@unleashd/buddies-core';
import type { Attempt, Expedition, Tree } from '@unleashd/shared';
import { OWNER, buddyActor } from '../buddies/core';
import { archive, archiveSalvage, branches } from './cambium';
import { type Launched, fileRetired, paths, retiredTaken, withAttempt } from './record';

// Retire (docs/expeditions-lean-design.md §3.6): every refusal comes before an irreversible step,
// except archiving, which is idempotent, so a re-retire continues where a refusal stopped it.

export interface RetireDeps {
  core: BuddiesCore;
  root: string;
  now: () => string;
  release: (x: Launched, a: Attempt) => Promise<Tree>;
  commit: (x: Launched) => Promise<Launched>;
  settleCrewRuns: (x: Launched) => Promise<void>;
  onBuddyArchived: (id: string) => void;
  onChannelArchived: (id: string) => void;
}
export type Retired = { t: 'retired' } | { t: 'refused'; reasons: string[] };
const refused = (reasons: string[]): Retired => ({ t: 'refused', reasons });

export const RETIRE: Record<
  'draft' | 'finished',
  (d: RetireDeps, x: Expedition) => Promise<Retired>
> = {
  draft: async (d, x) => {
    if (retiredTaken(d.root, x)) return refused([`.retired/${x.id}.json holds another record`]);
    // Review 2026-11-03: a launch that created the crew and then failed left it active.
    const crew = (await d.core.listBuddies(x.workspaceId)).filter((b) => b.slug === `exp-${x.id}`);
    for (const b of crew.filter((b) => b.status === 'active')) await archiveCrew(d, x.id, b.id);
    await fileRetired(d.root, x, d.now());
    return { t: 'retired' };
  },
  finished: (d, x) => retireFinished(d, x as Launched),
};

async function retireFinished(d: RetireDeps, start: Launched): Promise<Retired> {
  if (retiredTaken(d.root, start))
    return refused([`.retired/${start.id}.json holds another record`]);
  const busy = start.attempts.filter((a) => ['starting', 'running', 'judging'].includes(a.phase.t));
  if (busy.length > 0) return refused(busy.map((a) => `a${a.n} is still ${a.phase.t}`));
  let x = start;
  for (const a of x.attempts.filter((a) => ['planned', 'live', 'left'].includes(a.tree.t)))
    x = withAttempt(x, { ...a, tree: await d.release(x, a) });
  x = await d.commit(x);
  const left = x.attempts.flatMap((a) =>
    a.tree.t === 'left' ? [`a${a.n}: ${a.tree.reason}`] : []
  );
  if (left.length > 0) return refused(left);

  const { repoRoot, crewBuddyId, chatChannelId } = x.state.launch;
  const failures: string[] = [];
  for (const branch of await branches(repoRoot, x.id)) {
    const tag = `archive/expeditions/${x.id}/${branch.split('/').at(-1)}`;
    const r = await archive(repoRoot, branch, tag);
    if (r.t === 'refused') failures.push(r.reason);
    if (r.t === 'failed') failures.push(r.message);
  }
  const salvage = await archiveSalvage(repoRoot, x.id);
  if (salvage.t === 'failed') failures.push(...salvage.messages);
  if (failures.length > 0) return refused(failures);

  await d.settleCrewRuns(x);
  // The crew is archived last of all, after its channels: an archived crew means a retire that
  // stopped later (review 2026-11-03: the self-DM open as the archived crew threw on every retry).
  const status = (await d.core.getBuddy(crewBuddyId)).status;
  if (status === 'active') {
    const crew = buddyActor(crewBuddyId);
    const selfDm = await d.core.openChannel(crew, { kind: 'direct', members: [crew] });
    for (const channelId of [chatChannelId, selfDm.id]) {
      await d.core.setChannelArchived(OWNER, channelId, true, `exp:${x.id}:retire:${channelId}`);
      d.onChannelArchived(channelId);
    }
    await archiveCrew(d, x.id, crewBuddyId);
  }
  await fsp.rm(paths(d.root, x.id).crewDir, { recursive: true, force: true });
  await fileRetired(d.root, x, d.now());
  return { t: 'retired' };
}

async function archiveCrew(d: RetireDeps, id: string, buddyId: string): Promise<void> {
  const key = `exp:${id}:retire:crew`;
  await d.core.updateBuddy(OWNER, { buddyId, changes: { status: 'archived' }, key });
  d.onBuddyArchived(buddyId);
}
