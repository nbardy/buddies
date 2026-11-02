import type { BuddiesCore } from '@unleashd/buddies-core';
import { z } from 'zod';
import type { BuddyGrant } from '../buddies/grants';
import type { ToolDeps } from '../buddies/mcp';
import { createProviderCatalog } from '../providers/catalog-service';
import type { ExpeditionHost } from './host';
import type { Retire } from './launch';
import {
  CharterRequest,
  Feedback,
  type ModelsOf,
  type Origin,
  charterAdvice,
  charterOf,
  charterSummary,
  defaultedLines,
} from './model';

// The one `expedition` Buddy tool. Its description is paid on every worker turn
// (tool-contract.test.ts budget), so usage detail lives in BUDDY_TOOL_GUIDE and expeditions/mcp.md.

const ExpeditionAction = z.discriminatedUnion('do', [
  z.object({ do: z.literal('draft'), charter: CharterRequest }).strict(),
  z.object({ do: z.literal('launch'), charter: CharterRequest }).strict(),
  z.object({ do: z.literal('status'), id: z.string().min(1) }).strict(),
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.literal('steer'), id: z.string().min(1), feedback: Feedback }).strict(),
  z.object({ do: z.literal('retire'), id: z.string().min(1) }).strict(),
]);
type ExpeditionAction = z.infer<typeof ExpeditionAction>;

/** The thread this turn answers, when it was started by a post (else the owner DM). */
async function originOf(core: BuddiesCore, grant: BuddyGrant): Promise<Origin> {
  if (!grant.runId || grant.subscribes !== 'self') return { t: 'direct' };
  const run = await core.getRun(grant.runId);
  if (run.input.kind !== 'deliver' && run.input.kind !== 'post') return { t: 'direct' };
  const trigger = await core.getPost(grant.author, run.input.postId);
  return { t: 'thread', channelId: trigger.channelId, rootId: trigger.rootId ?? trigger.id };
}

/** The installed catalog's models (none for an unknown provider: the seat check refuses it). */
const catalogModels: ModelsOf = (provider) => {
  const entry = createProviderCatalog().providers.find((p) => p.id === provider);
  if (!entry) return { t: 'closed', models: [] };
  return entry.supportsDynamicModels ? { t: 'open' } : { t: 'closed', models: entry.models };
};

// The page path is plain data, never a link to post: 2026-11-01 smoke, the Buddy posted
// `[⛺ name](/expeditions/<id>)` and the post tool refused it as a missing media attachment. And
// "tell the owner in one line" made a Buddy answer without a post, which fails a delivery turn.
const NEXT =
  'The badge (it opens the page) is already in this chat, posted by the host: do not post the page path or a link. Reply with the post tool in this thread, one line saying what launched; updates post on their own, and the owner steers by replying in the expedition chat.';
// 2026-11-01 owner request: a draft is a card (Info, Launch), never a pasted charter.
const DRAFT_NEXT =
  'The host posted the draft card in this chat (Info shows the charter, issues and defaults; Launch starts it). Reply with the post tool in this thread, one line; do not paste the charter or ask the owner to type "launch it".';
const DRAFT_FIX =
  'Its Launch is disabled until the issues are fixed: say what blocks it, and draft again with the fix (the new card replaces this one).';

async function expeditionHandler(
  host: ExpeditionHost,
  core: BuddiesCore,
  grant: BuddyGrant,
  action: ExpeditionAction
): Promise<unknown> {
  // A crew Buddy runs its own expedition's attempts: it may read, never launch or steer (a worker
  // could otherwise resume a run the owner paused).
  const notCrew = (what: string) => {
    if (host.ofCrew(grant.buddyId))
      throw new Error(`an expedition crew cannot ${what} expeditions`);
  };
  const ownedBy = (id: string) => {
    if (host.workspaceOf(id) !== grant.workspaceId) throw new Error(`no expedition ${id} here`);
    return id;
  };
  /** One open expedition, and one open draft, per (conversation, name). */
  const keyOf = (charter: { name: string }) => `${grant.conversationId}:${charter.name}`;
  const launchInput = async (charter: ReturnType<typeof charterOf>['charter']) => ({
    key: keyOf(charter),
    charter,
    origin: await originOf(core, grant),
    launcherId: grant.buddyId,
    workspaceId: grant.workspaceId,
  });
  switch (action.do) {
    case 'draft': {
      notCrew('draft');
      const { charter, defaulted, resolved } = charterOf(action.charter, catalogModels);
      const issues = await host.issues(grant.workspaceId, charter);
      const input = await launchInput(charter);
      const advice = charterAdvice(charter);
      const draft = await host.drafts.draft({ ...input, issues, advice, defaulted, resolved });
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
      notCrew('launch');
      const { charter, defaulted, resolved } = charterOf(action.charter, catalogModels);
      const input = await launchInput(charter);
      const launched = await host.launch(input);
      const { state } = launched;
      const page = `/expeditions/${state.id}`;
      if (launched.t === 'already_running')
        // Not a fresh launch: the charter is the running one's, so no defaults are reported.
        return {
          id: state.id,
          page,
          alreadyRunning: `An expedition named "${state.charter.name}" launched from this conversation is still ${state.run.t}; nothing new was launched. Stop it first, or use another name.`,
          running: charterSummary(state.charter),
        };
      // A card drafted under this key would otherwise still offer Launch.
      await host.drafts.launchedByTool(input.key, state.id);
      return {
        id: state.id,
        page,
        launched: charterSummary(state.charter),
        defaulted: defaultedLines(defaulted),
        resolved,
        next: NEXT,
      };
    }
    case 'status':
      return host.status(ownedBy(action.id));
    case 'list':
      return host.list(grant.workspaceId);
    case 'steer': {
      notCrew('steer');
      const id = ownedBy(action.id);
      await host.steer(id, grant.buddyId, action.feedback);
      return host.status(id);
    }
    case 'retire': {
      notCrew('retire');
      const id = ownedBy(action.id);
      return retireAnswer(id, await host.retire(id, grant.buddyId, 'retire'));
    }
  }
}

/** δ per retire outcome; a refusal is an error the Buddy relays. Only a finished expedition
 * retires through the tool (stop it with steer first). */
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

/** The tool row `mcp.ts` registers. */
export const EXPEDITION_TOOL = {
  description:
    'Self-running expedition to a fuzzy goal; only verified results count. draft (posts a card), launch, status, list, steer.',
  writes: true,
  schema: z.object({ action: ExpeditionAction }).strict(),
  handler(deps: ToolDeps, grant: BuddyGrant, { action }: { action: ExpeditionAction }) {
    if (!deps.expeditions) throw new Error('Expedition host unavailable');
    return expeditionHandler(deps.expeditions, deps.core, grant, action);
  },
};
