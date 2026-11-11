import type { BuddiesCore } from '@unleashd/buddies-core';
import {
  BuddyAct,
  CHARTER_DEFAULTS,
  type Charter,
  CharterInput,
  type Done,
  type Lesson,
  type Origin,
  attemptResult,
  stateLabel,
} from '@unleashd/shared';
import { z } from 'zod';
import type { BuddyGrant } from '../buddies/grants';
import type { ToolDeps } from '../buddies/mcp';
import { isKeyedId } from '../expeditions-v1/shelf';
import { ProposeAction, keyedList, keyedStatus, propose } from '../expeditions-v1/tool';
import type { ExpeditionHost, Seat } from './host';

// The `expedition` Buddy tool (docs/expeditions-lean-design.md §3.7). launch and retire are the
// owner's (HTTP); a Buddy drafts, reads and relays the owner's steering, and a crew's chat seat
// is its expedition's manager (brief.ts CREW_ROLE). `propose` is the keyed host's (expeditions-v1/
// tool.ts, CONNECT_PLAN §5): new expeditions use it, `draft` and `act` serve the old host's records
// until it is deleted (§6), and `status` / `list` answer for both (a keyed id is told by its shape).

const Action = z.discriminatedUnion('do', [
  z.object({ do: z.literal('draft'), charter: CharterInput }).strict(),
  z.object({ do: z.literal('status'), id: z.string().min(1) }).strict(),
  z.object({ do: z.literal('list') }).strict(),
  z.object({ do: z.literal('act'), id: z.string().min(1), act: BuddyAct }).strict(),
  // Last: the union's indexes are in the contract snapshot's $refs.
  ProposeAction,
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

/** What the drafted `done` asks of the owner, echoed in the draft reply. Owner 2026-11-03: an
 * owner-judged draft waited on a pass/fail the owner did not want to give ("you need to be able
 * to review own work"), when a command could have decided it. */
const DONE_HINT: Record<Done['t'], string> = {
  checks: 'Judged by the checks: the host passes an attempt when they all exit 0.',
  owner:
    "Judged by the owner: every attempt waits for the owner's pass or fail. If a command can " +
    'decide the result, redraft with done: {t: "checks"} instead.',
};

function here(host: ExpeditionHost, grant: BuddyGrant, id: string) {
  const l = host.get(id);
  if (l.t !== 'ok' || l.x.workspaceId !== grant.workspaceId)
    throw new Error(`no expedition ${id} here`);
  return l.x;
}
function notCrew(host: ExpeditionHost, grant: BuddyGrant, what: string): void {
  if (host.crewOf(grant.buddyId)) throw new Error(`an expedition crew cannot ${what}`);
}

type Handler<K extends Action['do']> = (
  d: ToolDeps,
  g: BuddyGrant,
  a: Extract<Action, { do: K }>
) => Promise<unknown>;
/** The old host's, which a deployment may lack (`deps.expeditions`). */
const oldHost = (d: ToolDeps): ExpeditionHost => {
  if (!d.expeditions) throw new Error('Expedition host unavailable');
  return d.expeditions;
};

const HANDLE: { [K in Action['do']]: Handler<K> } = {
  propose,
  draft: async (deps, grant, { charter }) => {
    const host = oldHost(deps);
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
      done: DONE_HINT[full.done.t],
      next,
    };
  },
  status: (deps, grant, { id }) =>
    isKeyedId(id) ? keyedStatus(deps, grant, id) : oldStatus(deps, grant, id),
  // No old host composed = no old expeditions to list; the keyed ones still read.
  list: async (deps, grant) => [
    ...(deps.expeditions?.rows() ?? []).filter(
      (r) => r.t === 'ok' && r.workspaceId === grant.workspaceId
    ),
    ...(await keyedList(deps, grant)),
  ],
  act: async (deps, grant, { id, act }) => {
    const host = oldHost(deps);
    here(host, grant, id);
    const seat = await host.seatOf(grant.buddyId, grant.runId);
    (MAY_ACT[seat.t] as (s: Seat, id: string, a: BuddyActT) => void)(seat, id, act);
    const acted = await host.act(id, act, grant.buddyId);
    if (acted.t !== 'ok')
      throw new Error(acted.t === 'refused' ? acted.reasons.join('; ') : `no expedition ${id}`);
    // relaunch answers with the new draft: its id is not the one acted on.
    return { id: acted.x.id, state: stateLabel(acted.x) };
  },
};

async function oldStatus(deps: ToolDeps, grant: BuddyGrant, id: string) {
  const x = here(oldHost(deps), grant, id);
  const attempts = x.attempts.map((a) => ({
    n: a.n,
    result: attemptResult(a, x.charter.done),
    lesson: 'end' in a.phase ? lessonText(a.phase.end.lesson) : null,
    branch: a.branch,
  }));
  const deadline = 'launch' in x.state ? x.state.launch.deadline : null;
  return { state: stateLabel(x), deadline, attempts, notes: x.notes.map((n) => n.text) };
}

/** Who may steer. A Buddy outside a crew relays pause, resume, stop, extend and note; verdict and
 * relaunch are the owner's words, relayed only by the manager seat (a crew turn the owner
 * started) on its own expedition. Review 2026-11-03: any Buddy could pass an owner-judged
 * attempt, recorded as the owner's verdict, and a Buddy's post to the crew was obeyed as the
 * owner's. A crew turn someone else started and an attempt turn never steer. */
type BuddyActT = z.infer<typeof BuddyAct>;
const OWNERS_WORDS: ReadonlySet<BuddyActT['do']> = new Set(['verdict', 'relaunch']);
const MAY_ACT: {
  [K in Seat['t']]: (s: Extract<Seat, { t: K }>, id: string, a: BuddyActT) => void;
} = {
  none: (_s, _id, a) => {
    if (OWNERS_WORDS.has(a.do))
      throw new Error(`${a.do} is the owner's: in the expedition's chat or view`);
  },
  manager: (s, id) => {
    if (s.id !== id) throw new Error('an expedition manager steers only its own expedition');
  },
  crew: () => {
    throw new Error("only the owner's chat with the crew steers its expedition");
  },
  attempt: () => {
    throw new Error('an attempt turn cannot steer its expedition; answer the request instead');
  },
};
const lessonText = (l: Lesson) => (l.t === 'lesson' ? l.text : 'no lesson');

// Sent on every Buddy turn: keep it tight. The authoring API (expedition-kernel/authoring/index.ts)
// is the source of truth; the complete one-file example is in the keyed v1 docs.
const DESCRIPTION = `Self-running expeditions; only the OWNER launches, steers or stops.
propose {file}: write one absolute .ts file inside your workspace, then call. Gate issues post nothing; fix and propose again. Clean posts a Launch card with cost and advisory limits; edits need a new proposal.
status {id}, list: read. draft, act: OLD expeditions only.
Import only 'expedition' and 'zod'. export default expedition({contract, plan: async (x) => held}).
contract: {goal, leader: Buddy id, repo, budget:{usd,hours}, autoApply:{usd}, pools:{provider:concurrency}, done:[{check:cmd}|{review:{rubric:text,by:seat}}|{owner:question}], rules:[text]}; optional leaderWake, doneReview:{usd,minutes}. Leader rewrites must preserve this owner literal.
role({by:seat(provider,model,effort)|buddy(id),usd,minutes}): .brief(text | item=>text), .reads(paths), .web(), .checkout(), .returns(zod), .lists(zod), .needs(pool), .judged(check(cmd | item=>cmd) | review(text,another-provider-seat)). command(cmd | item=>cmd,{minutes}).
steps({a:spec}) makes await a({item,reads,on,continues,id}); item is required only for an item function. Result: passed with out/ref, or non-pass. need(result,why), passed(results), parallel(items,fn); x.phase(name,fn), x.review(q), x.ask(q), x.confirm(q). Return held.
Example: docs/expeditions/keyed/v1/examples/01-gtm.expedition.ts.`;

export const EXPEDITION_TOOL = {
  description: DESCRIPTION,
  writes: true,
  schema: z.object({ action: Action }).strict(),
  handler(deps: ToolDeps, grant: BuddyGrant, { action }: { action: Action }) {
    return (HANDLE[action.do] as Handler<Action['do']>)(deps, grant, action);
  },
};
