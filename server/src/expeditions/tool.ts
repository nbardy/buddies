import type { BuddiesCore } from '@unleashd/buddies-core';
import { z } from 'zod';
import type { BuddyGrant } from '../buddies/grants';
import type { ToolDeps } from '../buddies/mcp';
import { checkedRunConfig } from '../buddies/worker-config';
import type { ExpeditionHost } from './host';
import { Charter, type Origin } from './model';

// The one `expedition` Buddy tool. Its description is paid on every worker turn
// (tool-contract.test.ts budget), so usage detail lives in BUDDY_TOOL_GUIDE and expeditions/mcp.md.

const Steer = z.union([
  z.object({ t: z.enum(['lesson', 'note']), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ t: z.enum(['pause', 'resume', 'stop']) }).strict(),
]);

export const ExpeditionAction = z.discriminatedUnion('do', [
  z.object({ do: z.literal('launch'), charter: Charter }).strict(),
  z.object({ do: z.literal('status'), id: z.string().min(1) }).strict(),
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.literal('steer'), id: z.string().min(1), feedback: Steer }).strict(),
]);
export type ExpeditionAction = z.infer<typeof ExpeditionAction>;

export const EXPEDITION_DESCRIPTION =
  'Self-running expedition toward a fuzzy goal; counts only verified results; posts status here. launch, status, list, steer.';

/** The thread this turn answers, when it was started by a post (else the owner DM). */
async function originOf(core: BuddiesCore, grant: BuddyGrant): Promise<Origin> {
  if (!grant.runId || grant.subscribes !== 'self') return { t: 'direct' };
  const run = await core.getRun(grant.runId);
  if (run.input.kind !== 'deliver' && run.input.kind !== 'post') return { t: 'direct' };
  const trigger = await core.getPost(grant.author, run.input.postId);
  return { t: 'thread', channelId: trigger.channelId, rootId: trigger.rootId ?? trigger.id };
}

function ownedBy(host: ExpeditionHost, grant: BuddyGrant, id: string): string {
  if (host.workspaceOf(id) !== grant.workspaceId) throw new Error(`no expedition ${id} here`);
  return id;
}

export async function expeditionHandler(
  host: ExpeditionHost,
  core: BuddiesCore,
  grant: BuddyGrant,
  action: ExpeditionAction
): Promise<unknown> {
  switch (action.do) {
    case 'launch': {
      if (host.ofCrew(grant.buddyId))
        throw new Error('an expedition crew cannot launch expeditions');
      const { crew } = action.charter;
      for (const seat of [crew.manager, ...crew.work, ...crew.check]) checkedRunConfig(seat);
      const state = await host.launch({
        key: `${grant.conversationId}:${action.charter.name}`,
        charter: action.charter,
        origin: await originOf(core, grant),
        launcherId: grant.buddyId,
        workspaceId: grant.workspaceId,
      });
      return { id: state.id, status: host.status(state.id) };
    }
    case 'status':
      return host.status(ownedBy(host, grant, action.id));
    case 'list':
      return host.list(grant.workspaceId);
    case 'steer': {
      const id = ownedBy(host, grant, action.id);
      await host.steer(id, grant.buddyId, action.feedback);
      return host.status(id);
    }
  }
}

/** The tool row `mcp.ts` registers (kept here: server/src/buddies is at its line ceiling). */
export const EXPEDITION_TOOL = {
  description: EXPEDITION_DESCRIPTION,
  writes: true,
  schema: z.object({ action: ExpeditionAction }).strict(),
  handler(deps: ToolDeps, grant: BuddyGrant, { action }: { action: ExpeditionAction }) {
    if (!deps.expeditions) throw new Error('Expedition host unavailable');
    return expeditionHandler(deps.expeditions, deps.core, grant, action);
  },
};
