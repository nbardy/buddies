import type { BuddiesCore } from '@unleashd/buddies-core';
import { z } from 'zod';
import type { BuddyGrant } from '../buddies/grants';
import type { ToolDeps } from '../buddies/mcp';
import { createProviderCatalog } from '../providers/catalog-service';
import type { ExpeditionHost, Launched } from './host';
import {
  CharterRequest,
  type ModelsOf,
  type Origin,
  type State,
  charterAdvice,
  charterOf,
  charterSummary,
} from './model';

// The one `expedition` Buddy tool. Its description is paid on every worker turn
// (tool-contract.test.ts budget), so usage detail lives in BUDDY_TOOL_GUIDE and expeditions/mcp.md.

const Steer = z.union([
  z.object({ t: z.enum(['lesson', 'note']), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ t: z.enum(['pause', 'resume', 'stop']) }).strict(),
]);

export const ExpeditionAction = z.discriminatedUnion('do', [
  z.object({ do: z.literal('draft'), charter: CharterRequest }).strict(),
  z.object({ do: z.literal('launch'), charter: CharterRequest }).strict(),
  z.object({ do: z.literal('status'), id: z.string().min(1) }).strict(),
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.literal('steer'), id: z.string().min(1), feedback: Steer }).strict(),
]);
export type ExpeditionAction = z.infer<typeof ExpeditionAction>;

export const EXPEDITION_DESCRIPTION =
  'Self-running expedition to a fuzzy goal; only verified results count. draft (validate only), launch, status, list, steer.';

/** The thread this turn answers, when it was started by a post (else the owner DM). */
async function originOf(core: BuddiesCore, grant: BuddyGrant): Promise<Origin> {
  if (!grant.runId || grant.subscribes !== 'self') return { t: 'direct' };
  const run = await core.getRun(grant.runId);
  if (run.input.kind !== 'deliver' && run.input.kind !== 'post') return { t: 'direct' };
  const trigger = await core.getPost(grant.author, run.input.postId);
  return { t: 'thread', channelId: trigger.channelId, rootId: trigger.rootId ?? trigger.id };
}

/** A crew Buddy runs its own expedition's attempts: it may read status, never launch or steer
 * (a worker could otherwise resume a run the owner paused, or stop it). */
function notCrew(host: ExpeditionHost, grant: BuddyGrant, what: string): void {
  if (host.ofCrew(grant.buddyId)) throw new Error(`an expedition crew cannot ${what} expeditions`);
}

/** The installed catalog's models for a provider (none for an unknown provider, which the seat
 * check refuses by name). */
const catalogModels: ModelsOf = (provider) =>
  createProviderCatalog().providers.find((p) => p.id === provider)?.models ?? [];

/**
 * The page path as plain data, never a link to post: the host already posted the clickable badge
 * in the launch chat. 2026-11-01 smoke incident: the reply carried `[⛺ name](/expeditions/<id>)`,
 * the Buddy posted it, and the post tool refused the relative path as a missing media attachment.
 */
const pageOf = (s: State) => `/expeditions/${s.id}`;
const NEXT =
  'The badge (it opens the page) is already in this chat, posted by the host: do not post the page path or a link. Tell the owner in one line what launched; updates post on their own, and the owner steers by replying in the expedition chat.';

function launchReply(launched: Launched, defaulted: string[], resolved: string[]) {
  switch (launched.t) {
    case 'launched':
      return {
        id: launched.state.id,
        page: pageOf(launched.state),
        launched: charterSummary(launched.state.charter),
        defaulted,
        resolved,
        next: NEXT,
      };
    case 'already_running':
      // Not a fresh launch: the charter is the running one's, so no defaults are reported.
      return {
        id: launched.state.id,
        page: pageOf(launched.state),
        alreadyRunning: `An expedition named "${launched.state.charter.name}" launched from this conversation is still ${launched.state.run.t}; nothing new was launched. Stop it first, or use another name.`,
        running: charterSummary(launched.state.charter),
      };
  }
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
    case 'draft': {
      const { charter, defaulted, resolved } = charterOf(action.charter, catalogModels);
      const issues = await host.issues(grant.workspaceId, charter);
      return {
        ready: issues.length === 0,
        issues,
        advice: charterAdvice(charter),
        defaulted,
        resolved,
        charter,
      };
    }
    case 'launch': {
      notCrew(host, grant, 'launch');
      const { charter, defaulted, resolved } = charterOf(action.charter, catalogModels);
      const launched = await host.launch({
        key: `${grant.conversationId}:${charter.name}`,
        charter,
        origin: await originOf(core, grant),
        launcherId: grant.buddyId,
        workspaceId: grant.workspaceId,
      });
      return launchReply(launched, defaulted, resolved);
    }
    case 'status':
      return host.status(ownedBy(host, grant, action.id));
    case 'list':
      return host.list(grant.workspaceId);
    case 'steer': {
      notCrew(host, grant, 'steer');
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
