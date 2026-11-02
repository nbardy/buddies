import type { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER } from '../buddies/core';
import { chatFeedback, parseOutcome } from './answers';
import { repairBrief } from './briefs';
import { branchState, claimHeld } from './git';
import {
  type Attempt,
  type ClaimChange,
  type EndOutcome,
  type Entry,
  type Outcome,
  type Round,
  type State,
  allAttempts,
  attemptOf,
  custodyOf,
  worktreeOf,
} from './model';

// Observation: what the crew's posts and the owner's chat say since the last tick, as entries.
// Reads only: the tick appends what it returns.

/** Chat posts read per page when looking for new owner messages. */
const CHAT_PAGE = 50;
/** How long a stopped attempt's runs may take to end before the host ends it `abandoned` (audit #2). */
export const CANCEL_GRACE_MS = 5 * 60_000;

export interface ObservePorts {
  core: BuddiesCore;
  now: () => string;
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type Part = [string, () => Promise<Entry[]>];

/** Every part observed on its own: one request (or the chat) that cannot be read is a typed
 * failure, and the rest is still recorded and decided on. */
export async function observe(p: ObservePorts, s: State) {
  const parts: Part[] = [['the expedition chat', () => observeChat(p, s)]];
  for (const a of allAttempts(s))
    if (a.phase.t === 'posted') parts.push([`attempt ${a.id}`, () => observeAttempt(p, s, a)]);
  const observed = { entries: [] as Entry[], failures: [] as string[] };
  for (const [what, read] of parts)
    await read().then(
      (entries) => observed.entries.push(...entries),
      (error: unknown) => observed.failures.push(`${what}: ${errorText(error)}`)
    );
  return observed;
}

async function observeAttempt(p: ObservePorts, s: State, attempt: Attempt): Promise<Entry[]> {
  if (attempt.phase.t !== 'posted') throw new Error(`attempt ${attempt.id} is ${attempt.phase.t}`);
  const { round } = attempt.phase;
  const { request } = await p.core.getPost(OWNER, attempt.phase.requestId);
  switch (request.state) {
    case 'awaiting':
    case 'none':
      return abandonedAfterGrace(p, s, attempt);
    case 'answered':
      return answered(p, s, attempt, round, (await p.core.getPost(OWNER, request.answerId)).body);
    case 'failed':
    case 'cancelled':
      return [await ended(p, s, attempt, { t: 'failed', status: request.state })];
  }
}

/** Every attempt end goes through here: a work end that is not a code claim while its branch has
 * commits is `unreported_commits`, so the manager can claim them (design.md R11). 2026-11-01
 * incident: w64130b's and w475a3b's commits were dropped with a malformed answer and a finding. */
export async function ended(p: ObservePorts, s: State, a: Attempt, o: EndOutcome): Promise<Entry> {
  const end: Entry = { t: 'attempt_ended', at: p.now(), attemptId: a.id, outcome: o };
  const reportsCommit =
    o.t === 'work' && o.result.result === 'claim' && o.result.change.t === 'commit';
  if (a.spec.kind !== 'work' || reportsCommit) return end;
  // A missing branch made no commits: it is never created without the worktree.
  const branch = await branchState(s.repo.root, worktreeOf(s, a.id));
  const shas = branch.t === 'present' ? branch.shas : [];
  const unreported: Outcome = { t: 'unreported_commits', shas, ended: o };
  return shas.length === 0 ? end : { ...end, outcome: unreported };
}

/** A cancelled attempt whose runs did not end within the grace is ended by the host (audit #2):
 * a run that ignores its stop must not hold a tree and a slot forever. */
async function abandonedAfterGrace(p: ObservePorts, s: State, attempt: Attempt): Promise<Entry[]> {
  const cancel = s.cancels[attempt.id];
  if (!cancel || Date.parse(p.now()) - Date.parse(cancel.at) < CANCEL_GRACE_MS) return [];
  const reason = `its runs (${cancel.runIds.join(', ') || 'none found'}) did not end within ${CANCEL_GRACE_MS / 60_000} minutes of the host's stop`;
  return [await ended(p, s, attempt, { t: 'abandoned', reason })];
}

/** A first answer that does not parse gets ONE repair request on the same seat (design.md R11),
 * never on a finished expedition (2026-11-01 review: a repair after the stop started a paid run). */
async function answered(p: ObservePorts, s: State, attempt: Attempt, round: Round, body: string) {
  const parsed = parseOutcome(attempt.spec.kind, body);
  if (parsed.t === 'malformed' && round === 'brief' && s.run.t !== 'finished') {
    const repair = { error: parsed.error, body: repairBrief(s, attempt, parsed.error, body) };
    const e: Entry = { t: 'attempt_repair_posting', at: p.now(), attemptId: attempt.id, ...repair };
    return [e];
  }
  return [await ended(p, s, attempt, await heldOutcome(s, attempt.id, body, parsed))];
}

/** The owner's chat messages since the chat cursor, oldest first, as `feedback` (answers.ts), so
 * pause/resume/stop work there; keyed by the post's ordered id, a replay never records one twice. */
async function observeChat(p: ObservePorts, s: State): Promise<Entry[]> {
  if (s.crew.t !== 'ready' || s.run.t === 'finished') return [];
  const cursor = s.chatCursor;
  const channelId = s.crew.chatChannelId;
  const newer = (ord: string) => cursor.t === 'start' || ord > cursor.ord;
  const posts: Awaited<ReturnType<BuddiesCore['listPosts']>>['posts'] = [];
  // Pages come newest first; stop at the first page that reaches the cursor.
  for (let before: { ord: string } | undefined; ; ) {
    const page = await p.core.listPosts(OWNER, { kind: 'channel', channelId }, before, CHAT_PAGE);
    const fresh = page.posts.filter((post) => newer(post.ord));
    posts.push(...fresh);
    if (!page.next || fresh.length < page.posts.length) break;
    before = page.next;
  }
  return posts
    .reverse()
    .filter((post) => post.author.kind === 'owner')
    .map(
      (post): Entry => ({
        t: 'feedback',
        at: p.now(),
        from: 'owner',
        via: { t: 'chat', postId: post.id, ord: post.ord },
        feedback: chatFeedback(post.body),
      })
    );
}

/** A claim's change holds only when the attempt's own branch holds it inside its question's
 * custody (git.ts claimHeld); custody is enforced, not advisory. */
export const holds = (s: State, attemptId: string, change: ClaimChange) =>
  claimHeld(s.repo.root, worktreeOf(s, attemptId), change, custodyOf(s, attemptOf(s, attemptId)));

/** A work claim its branch does not hold is `malformed`: never acted on by the claim's word. */
async function heldOutcome(s: State, id: string, body: string, o: EndOutcome): Promise<EndOutcome> {
  if (o.t !== 'work' || o.result.result !== 'claim') return o;
  const held = await holds(s, id, o.result.change);
  return held.t === 'held' ? o : { t: 'malformed', error: held.reason, raw: body };
}
