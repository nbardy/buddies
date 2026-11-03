import type { BuddiesCore } from '@unleashd/buddies-core';
import {
  BuddyAct,
  CHARTER_DEFAULTS,
  type Charter,
  CharterInput,
  type Lesson,
  type Origin,
  attemptResult,
  stateLabel,
} from '@unleashd/shared';
import { z } from 'zod';
import type { BuddyGrant } from '../buddies/grants';
import type { ToolDeps } from '../buddies/mcp';
import type { ExpeditionHost, Seat } from './host';

// The `expedition` Buddy tool (docs/expeditions-lean-design.md §3.7). launch and retire are the
// owner's (HTTP); a Buddy drafts, reads and relays the owner's steering, and a crew's chat seat
// is its expedition's manager (brief.ts CREW_ROLE).

const Action = z.discriminatedUnion('do', [
  z.object({ do: z.literal('draft'), charter: CharterInput }).strict(),
  z.object({ do: z.literal('status'), id: z.string().min(1) }).strict(),
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.literal('act'), id: z.string().min(1), act: BuddyAct }).strict(),
]);
type Action = z.infer<typeof Action>;

/** The thread this turn answers, when a post started it (else the owner DM). */
async function originOf(core: BuddiesCore, grant: BuddyGrant): Promise<Origin> {
  if (!grant.runId || grant.subscribes !== 'self') return { t: 'direct' };
  const run = await core.getRun(grant.runId);
  if (run.input.kind !== 'deliver' && run.input.kind !== 'post') return { t: 'direct' };
  const trigger = await core.getPost(grant.author, run.input.postId);
  return { t: 'thread', channelId: trigger.channelId, rootId: trigger.rootId ?? trigger.id };
}

function here(host: ExpeditionHost, grant: BuddyGrant, id: string) {
  const l = host.get(id);
  if (l.t !== 'ok' || l.x.workspaceId !== grant.workspaceId)
    throw new Error(`no expedition ${id} here`);
  return l.x;
}
function notCrew(host: ExpeditionHost, grant: BuddyGrant, what: string): void {
  if (host.crewOf(grant.buddyId)) throw new Error(`an expedition crew cannot ${what}`);
}

const HANDLE: {
  [K in Action['do']]: (
    h: ExpeditionHost,
    d: ToolDeps,
    g: BuddyGrant,
    a: Extract<Action, { do: K }>
  ) => Promise<unknown>;
} = {
  draft: async (host, deps, grant, { charter }) => {
    notCrew(host, grant, 'draft an expedition');
    const keys = ['maxLive', 'hours', 'seat'] as const;
    const defaulted = keys.filter((k) => charter[k] === undefined);
    const full: Charter = { ...CHARTER_DEFAULTS, ...charter };
    const origin = await originOf(deps.core, grant);
    const x = await host.draft({
      charter: full,
      origin,
      launcherId: grant.buddyId,
      workspaceId: grant.workspaceId,
    });
    const issues = x.state.t === 'draft' ? x.state.issues : [];
    const next =
      'The host posted a card in this chat; the owner launches it. Reply in one line; post no link.';
    return {
      id: x.id,
      issues,
      defaulted: defaulted.map((k) => `${k}: ${JSON.stringify(full[k])}`),
      next,
    };
  },
  status: async (host, _d, grant, { id }) => {
    const x = here(host, grant, id);
    const attempts = x.attempts.map((a) => ({
      n: a.n,
      result: attemptResult(a, x.charter.done),
      lesson: 'end' in a.phase ? lessonText(a.phase.end.lesson) : null,
      branch: a.branch,
    }));
    const deadline = 'launch' in x.state ? x.state.launch.deadline : null;
    return { state: stateLabel(x), deadline, attempts, notes: x.notes.map((n) => n.text) };
  },
  list: async (host, _d, grant) =>
    host.rows().filter((r) => r.t === 'ok' && r.workspaceId === grant.workspaceId),
  act: async (host, _d, grant, { id, act }) => {
    here(host, grant, id);
    const seat = await host.seatOf(grant.buddyId, grant.runId);
    MAY_ACT[seat.t](seat as never, id);
    const acted = await host.act(id, act, grant.buddyId);
    if (acted.t !== 'ok')
      throw new Error(acted.t === 'refused' ? acted.reasons.join('; ') : `no expedition ${id}`);
    // relaunch answers with the new draft: its id is not the one acted on.
    return { id: acted.x.id, state: stateLabel(acted.x) };
  },
};

/** Who may steer: any Buddy outside a crew (relaying the owner), and a crew's manager seat on its
 * own expedition. An attempt turn never steers (it could stop or pass its own work). */
const MAY_ACT: { [K in Seat['t']]: (s: Extract<Seat, { t: K }>, id: string) => void } = {
  none: () => undefined,
  manager: (s, id) => {
    if (s.id !== id) throw new Error('an expedition manager steers only its own expedition');
  },
  attempt: () => {
    throw new Error('an attempt turn cannot steer its expedition; answer the request instead');
  },
};
const lessonText = (l: Lesson) => (l.t === 'lesson' ? l.text : 'no lesson');

export const EXPEDITION_TOOL = {
  description:
    'Draft a self-running expedition (posts a card the owner launches); status, list, act.',
  writes: true,
  schema: z.object({ action: Action }).strict(),
  handler(deps: ToolDeps, grant: BuddyGrant, { action }: { action: Action }) {
    if (!deps.expeditions) throw new Error('Expedition host unavailable');
    const handle = HANDLE[action.do] as (
      h: ExpeditionHost,
      d: ToolDeps,
      g: BuddyGrant,
      a: Action
    ) => Promise<unknown>;
    return handle(deps.expeditions, deps, grant, action);
  },
};
