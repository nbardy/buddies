import type { BuddiesCore } from '@unleashd/buddies-core';
import { z } from 'zod';
import type { BuddyGrant } from '../buddies/grants';
import type { ToolDeps } from '../buddies/mcp';
import { createProviderCatalog } from '../providers/catalog-service';
import type { ExpeditionHost, Launched, Retire } from './host';
import {
  type CharterDefault,
  CharterRequest,
  Feedback,
  type ModelsOf,
  type Origin,
  type State,
  charterAdvice,
  charterOf,
  charterSummary,
  defaultedLines,
} from './model';

// The one `expedition` Buddy tool. Its description is paid on every worker turn
// (tool-contract.test.ts budget), so usage detail lives in BUDDY_TOOL_GUIDE and expeditions/mcp.md.

export const ExpeditionAction = z.discriminatedUnion('do', [
  z.object({ do: z.literal('draft'), charter: CharterRequest }).strict(),
  z.object({ do: z.literal('launch'), charter: CharterRequest }).strict(),
  z.object({ do: z.literal('status'), id: z.string().min(1) }).strict(),
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.literal('steer'), id: z.string().min(1), feedback: Feedback }).strict(),
  z.object({ do: z.literal('retire'), id: z.string().min(1) }).strict(),
]);
export type ExpeditionAction = z.infer<typeof ExpeditionAction>;

export const EXPEDITION_DESCRIPTION =
  'Self-running expedition to a fuzzy goal; only verified results count. draft (posts a card), launch, status, list, steer.';

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
 * check refuses by name); open for a provider that accepts ad-hoc model ids. */
const catalogModels: ModelsOf = (provider) => {
  const entry = createProviderCatalog().providers.find((p) => p.id === provider);
  if (!entry) return { t: 'closed', models: [] };
  return entry.supportsDynamicModels ? { t: 'open' } : { t: 'closed', models: entry.models };
};

/**
 * The page path as plain data, never a link to post: the host already posted the clickable badge
 * in the launch chat. 2026-11-01 smoke incident: the reply carried `[⛺ name](/expeditions/<id>)`,
 * the Buddy posted it, and the post tool refused the relative path as a missing media attachment.
 */
const pageOf = (s: State) => `/expeditions/${s.id}`;
// 2026-11-01 smoke: "tell the owner in one line" made a DM-launched Buddy answer in plain text, and
// the runner fails a delivery turn that ends without a post ("Couldn't reply"), so say `post`.
const NEXT =
  'The badge (it opens the page) is already in this chat, posted by the host: do not post the page path or a link. Reply with the post tool in this thread, one line saying what launched; updates post on their own, and the owner steers by replying in the expedition chat.';

// 2026-11-01 owner request: a draft is a card in the chat (Info opens the charter, Launch starts
// it), so the Buddy neither pastes the charter nor asks the owner to type "launch it".
const DRAFT_NEXT =
  'The host posted the draft card in this chat (Info shows the charter, issues and defaults; Launch starts it). Reply with the post tool in this thread, one line; do not paste the charter or ask the owner to type "launch it".';
const DRAFT_FIX =
  'Its Launch is disabled until the issues are fixed: say what blocks it, and draft again with the fix (the new card replaces this one).';

/** One open expedition, and one open draft, per (conversation, name). */
const launchKey = (grant: BuddyGrant, charter: { name: string }) =>
  `${grant.conversationId}:${charter.name}`;

function launchReply(launched: Launched, defaulted: CharterDefault[], resolved: string[]) {
  switch (launched.t) {
    case 'launched':
      return {
        id: launched.state.id,
        page: pageOf(launched.state),
        launched: charterSummary(launched.state.charter),
        defaulted: defaultedLines(defaulted),
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
      notCrew(host, grant, 'draft');
      const { charter, defaulted, resolved } = charterOf(action.charter, catalogModels);
      const issues = await host.issues(grant.workspaceId, charter);
      const draft = await host.drafts.draft({
        key: launchKey(grant, charter),
        charter,
        issues,
        advice: charterAdvice(charter),
        defaulted,
        resolved,
        origin: await originOf(core, grant),
        launcherId: grant.buddyId,
        workspaceId: grant.workspaceId,
      });
      return {
        draftId: draft.id,
        ready: issues.length === 0,
        issues,
        advice: draft.advice,
        defaulted: defaultedLines(defaulted),
        resolved,
        drafted: charterSummary(charter),
        next: issues.length === 0 ? DRAFT_NEXT : `${DRAFT_NEXT} ${DRAFT_FIX}`,
      };
    }
    case 'launch': {
      notCrew(host, grant, 'launch');
      const { charter, defaulted, resolved } = charterOf(action.charter, catalogModels);
      const key = launchKey(grant, charter);
      const launched = await host.launch({
        key,
        charter,
        origin: await originOf(core, grant),
        launcherId: grant.buddyId,
        workspaceId: grant.workspaceId,
      });
      // A card drafted under this key would otherwise still offer Launch.
      if (launched.t === 'launched') await host.drafts.launchedByTool(key, launched.state.id);
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
    case 'retire': {
      notCrew(host, grant, 'retire');
      const id = ownedBy(host, grant, action.id);
      return retireAnswer(id, await host.retire(id, grant.buddyId, 'retire'));
    }
  }
}

/** δ: what the Buddy is told per retire outcome; a refusal is an error it can relay. Only a
 * finished expedition retires through the tool (stop it with steer first). */
function retireAnswer(id: string, retired: Retire): string {
  switch (retired.t) {
    case 'retiring':
      return `Retiring ${id}: its trees, branches (archived as tags on origin), chats and crew are put away in the background; its page shows the progress.`;
    case 'already_retired':
      return `${id} is already retired.`;
    case 'not_finished':
      throw new Error(`expedition ${id} is still open: steer it to stop first, then retire it`);
    case 'missing':
      throw new Error(`no expedition ${id} here`);
    case 'quarantined':
      throw new Error(`expedition ${id} is quarantined: ${retired.reason}`);
    case 'disabled':
      throw new Error(retired.reason);
  }
}

/** The tool row `mcp.ts` registers (kept beside its handler, with the rest of expeditions). */
export const EXPEDITION_TOOL = {
  description: EXPEDITION_DESCRIPTION,
  writes: true,
  schema: z.object({ action: ExpeditionAction }).strict(),
  handler(deps: ToolDeps, grant: BuddyGrant, { action }: { action: ExpeditionAction }) {
    if (!deps.expeditions) throw new Error('Expedition host unavailable');
    return expeditionHandler(deps.expeditions, deps.core, grant, action);
  },
};
