import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from '@unleashd/buddies-core';
import { type Origin, keyed } from '@unleashd/shared';
import { z } from 'zod';
import { buddyActor } from '../buddies/core';
import type { BuddyGrant } from '../buddies/grants';
import type { ToolDeps } from '../buddies/mcp';
import { createOwnerThread, placeOf } from '../buddies/owner-thread';
import { digestOf } from './digest';
import type { KeyedExpeditions } from './service';

// The keyed half of the `expedition` Buddy tool (CONNECT_PLAN §5, step 8; the other half is
// expeditions/tool.ts). A Buddy writes the expedition file with its own file tools and calls
// `propose`; the tool runs the host's gates, answers with what they found, and on a clean pass posts
// ONE card where the request was made. LAUNCH IS NEVER HERE (§7.2, D8): the card's button calls the
// owner's HTTP route, and a Buddy can neither launch, steer nor stop; `status` and `list` read.

export const ProposeAction = z
  .object({ do: z.literal('propose'), file: z.string().min(1) })
  .strict();
export type ProposeAction = z.infer<typeof ProposeAction>;

const keyedOf = (deps: ToolDeps): KeyedExpeditions => {
  if (!deps.keyed) throw new Error('Keyed expeditions unavailable');
  return deps.keyed;
};

// ---- the file: inside a file the Buddy's workspace owns ----

type Located =
  | { readonly t: 'inside'; readonly file: string }
  | { readonly t: 'refused'; readonly why: string };
const realpathOf = (p: string): Promise<string | null> => realpath(p).catch(() => null);
const within = (dir: string, target: string): boolean => {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
/** The file's real path when it lies inside one of the workspace's registered folders (symlinks
 * resolved on both sides, so a link cannot lead out). */
async function locate(workspace: Workspace, file: string): Promise<Located> {
  if (!path.isAbsolute(file))
    return { t: 'refused', why: `file must be an absolute path, got ${file}` };
  if (!file.endsWith('.ts')) return { t: 'refused', why: 'file must be a .ts file' };
  const real = await realpathOf(file);
  if (real === null) return { t: 'refused', why: `no such file: ${file}` };
  if (!(await stat(real)).isFile()) return { t: 'refused', why: `not a regular file: ${file}` };
  const roots = await Promise.all((workspace.folders ?? [workspace.rootPath]).map(realpathOf));
  return roots.some((r) => r !== null && within(r, real))
    ? { t: 'inside', file: real }
    : {
        t: 'refused',
        why: `${file} is outside this workspace's folders: write the expedition file inside one of them`,
      };
}

// ---- propose ----

const cardBody = (p: keyed.KeyedProposal): string =>
  `⛺ Proposed expedition: ${p.preview.goal.split('\n')[0]}\n` +
  `Budget $${p.preview.budget.usd} / ${p.preview.budget.hours} h · first wave ${p.preview.firstWave.length} call(s), up to $${p.preview.costUsd} · launch it from this card.\n` +
  `File: ${p.file}`;

/** The thread this turn answers, when a post started it (else the owner DM). */
async function originOf(deps: ToolDeps, grant: BuddyGrant): Promise<Origin> {
  if (!grant.runId || grant.subscribes !== 'self') return { t: 'direct' };
  const run = await deps.core.getRun(grant.runId);
  if (run.input.kind !== 'deliver' && run.input.kind !== 'post') return { t: 'direct' };
  const trigger = await deps.core.getPost(grant.author, run.input.postId);
  return { t: 'thread', channelId: trigger.channelId, rootId: trigger.rootId ?? trigger.id };
}

/** The unenforced limits a reader must know before trusting "no web" or "read-only". */
type Advisory = {
  label: string;
  from: keyed.TurnSource;
  turn: string;
  provider: string;
  advisory: readonly string[];
};
const advisoryOf = (access: readonly keyed.TurnAccess[]): Advisory[] =>
  access.flatMap((a) => {
    const g = keyed.advisoryGrants(a);
    // A harness we know nothing about enforces nothing we can name: say so as the limit itself.
    return g.t === 'unknown'
      ? [{ label: a.label, from: a.from, turn: a.turn, provider: 'unknown', advisory: [g.why] }]
      : g.advisory.length > 0
        ? [
            {
              label: a.label,
              from: a.from,
              turn: a.turn,
              provider: g.provider,
              advisory: g.advisory,
            },
          ]
        : [];
  });

export async function propose(deps: ToolDeps, grant: BuddyGrant, { file }: ProposeAction) {
  const host = keyedOf(deps);
  const workspace = (await deps.core.listWorkspaces()).find((w) => w.id === grant.workspaceId);
  if (!workspace) throw new Error(`no workspace ${grant.workspaceId}`);
  const located = await locate(workspace, file);
  if (located.t === 'refused') throw new Error(located.why);
  const before = await digestOf(located.file);
  if (before.t === 'unreadable') throw new Error(`cannot read ${located.file}: ${before.why}`);
  const proposing = await host.propose(located.file);
  if (proposing.t === 'unavailable')
    throw new Error(`Keyed expeditions cannot be proposed now: ${proposing.why}`);
  if (proposing.t === 'rejected')
    return {
      t: 'rejected',
      gate: proposing.gate,
      issues: proposing.issues,
      next: 'Nothing was posted. Fix the file and call propose again.',
    };
  const after = await digestOf(located.file);
  if (after.t !== 'digest' || after.digest !== before.digest)
    throw new Error('the file changed while it was being checked: propose it again');
  const proposal: keyed.KeyedProposal = {
    file: located.file,
    workspaceId: grant.workspaceId,
    digest: before.digest,
    preview: proposing.preview,
  };
  // The key IS the digest (digest.ts): the same file proposed again post nothing; an edited file
  // posts a NEW card, and the older card then reads "changed since proposed" with no Launch (the
  // client asks `GET …/proposals/:digest`), so exactly one card per version is ever launchable.
  const launcher = buddyActor(grant.buddyId);
  const cardId = await createOwnerThread(deps).inform(
    launcher,
    placeOf(await originOf(deps, grant), launcher),
    { body: cardBody(proposal), purpose: 'expedition', key: `kexp:${proposal.digest}` },
    `${keyed.PROPOSAL_EVIDENCE}${JSON.stringify(proposal)}`,
    'announce'
  );
  const p = proposal.preview;
  return {
    t: 'clean',
    defaults: p.defaults,
    goal: p.goal,
    leader: p.leader,
    repo: p.repo,
    budget: p.budget,
    firstWave: p.firstWave,
    costUsd: p.costUsd,
    advisory: advisoryOf(p.access),
    card: cardId,
    next: 'A card with a Launch button is in the chat; only the owner launches. Reply in one line and post no link. If you change the file, propose again (a new card replaces this one).',
  };
}

// ---- status and list: the keyed projection, for this workspace ----

const keyedHere = async (deps: ToolDeps, grant: BuddyGrant): Promise<keyed.KeyedRow[]> =>
  (await keyedOf(deps).rows()).filter(
    (r) => r.workspace.t === 'workspace' && r.workspace.id === grant.workspaceId
  );

/** A row as `list` shows it; `t: 'keyed'` tells it from an older expedition's row (`t: 'ok'`). */
export async function keyedList(deps: ToolDeps, grant: BuddyGrant) {
  return (await keyedHere(deps, grant)).map((r) => ({ t: 'keyed' as const, ...r }));
}

const END_WORD: {
  readonly [K in keyed.BarEnd['t']]: (e: Extract<keyed.BarEnd, { t: K }>) => string;
} = {
  open: () => 'open',
  settled: (e) => e.outcome.t,
};
const lastOutcome = (bars: readonly keyed.Bar[]): string => {
  const last = bars.at(-1);
  return last === undefined
    ? 'none'
    : (END_WORD[last.end.t] as (e: keyed.BarEnd) => string)(last.end);
};

/** One expedition compactly: the row, each key's lane in one line, what waits for the owner. */
export async function keyedStatus(deps: ToolDeps, grant: BuddyGrant, id: string) {
  const row = (await keyedHere(deps, grant)).find((r) => r.id === id);
  if (!row) throw new Error(`no expedition ${id} here`);
  const v = await keyedOf(deps).view(id);
  if (v.t !== 'ok') throw new Error(v.why);
  return {
    t: 'keyed' as const,
    ...row,
    lanes: v.view.lanes.map((l) => ({
      key: l.key,
      kind: l.kind,
      status: l.status,
      attempts: l.bars.length,
      lastOutcome: lastOutcome(l.bars),
    })),
    asks: v.view.asks.map((a) => a.question),
    approval: v.view.approval.t,
    faults: v.view.faults.map((f) => f.what),
  };
}
