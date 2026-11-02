import type { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER } from '../buddies/core';
import { chatFeedback, parseOutcome } from './answers';
import { repairBrief } from './briefs';
import { branchState, claimHeld } from './git';
import {
  type Attempt,
  type AttemptPhase,
  type EndOutcome,
  type Entry,
  type Outcome,
  type State,
  allAttempts,
  attemptOf,
  custodyOf,
  worktreeOf,
} from './model';

// Observation: what the crew's posts and the owner's chat say since the last tick, as entries
// (a settled request becomes `attempt_ended`, an owner message `feedback`). Reads only: the tick
// appends what it returns.

/** Chat posts read per page when looking for new owner messages. */
const CHAT_PAGE = 50;
/** After the host asks a finished expedition's live attempt to stop (audit #2), how long its runs
 * may take to end before the host ends the attempt `abandoned` and releases its tree. */
export const CANCEL_GRACE_MS = 5 * 60_000;

export interface ObservePorts {
  core: BuddiesCore;
  now: () => string;
}

/** What observation produced: the entries, and why any part of it could not be read. */
export interface Observed {
  entries: Entry[];
  failures: string[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Every part observed on its own: one request (or the chat) that cannot be read is a typed
 * failure, and the rest is still recorded and decided on. */
export async function observe(p: ObservePorts, s: State): Promise<Observed> {
  const parts: [string, () => Promise<Entry[]>][] = [
    ['the expedition chat', () => observeChat(p, s)],
    ...allAttempts(s).flatMap((attempt): [string, () => Promise<Entry[]>][] =>
      attempt.phase.t === 'posted'
        ? [[`attempt ${attempt.id}`, () => observeAttempt(p, s, attempt)]]
        : []
    ),
  ];
  const observed: Observed = { entries: [], failures: [] };
  for (const [what, read] of parts) {
    const part = await observing(what, read);
    switch (part.t) {
      case 'ok':
        observed.entries.push(...part.entries);
        break;
      case 'failed':
        observed.failures.push(part.reason);
    }
  }
  return observed;
}

async function observing(
  what: string,
  read: () => Promise<Entry[]>
): Promise<{ t: 'ok'; entries: Entry[] } | { t: 'failed'; reason: string }> {
  try {
    return { t: 'ok', entries: await read() };
  } catch (error) {
    return { t: 'failed', reason: `${what}: ${errorText(error)}` };
  }
}

async function observeAttempt(p: ObservePorts, s: State, attempt: Attempt): Promise<Entry[]> {
  const phase = postedPhase(attempt);
  const request = await p.core.getPost(OWNER, phase.requestId);
  switch (request.request.state) {
    case 'awaiting':
    case 'none':
      return abandonedAfterGrace(p, s, attempt);
    case 'answered': {
      const answer = await p.core.getPost(OWNER, request.request.answerId);
      return answered(p, s, attempt, phase, answer.body);
    }
    case 'failed':
    case 'cancelled':
      return [await ended(p, s, attempt, { t: 'failed', status: request.request.state })];
  }
}

/** Every attempt end goes through here, so no end of a work attempt drops its commits. */
export async function ended(
  p: ObservePorts,
  s: State,
  attempt: Attempt,
  outcome: EndOutcome
): Promise<Entry> {
  return {
    t: 'attempt_ended',
    at: p.now(),
    attemptId: attempt.id,
    outcome: await unreported(s, attempt, outcome),
  };
}

/** A cancelled attempt whose runs did not end within the grace is ended by the host (audit #2):
 * a run that ignores its stop must not hold a tree and a slot forever. */
async function abandonedAfterGrace(p: ObservePorts, s: State, attempt: Attempt): Promise<Entry[]> {
  const cancel = s.cancels[attempt.id];
  if (!cancel || Date.parse(p.now()) - Date.parse(cancel.at) < CANCEL_GRACE_MS) return [];
  const reason = `its runs (${cancel.runIds.join(', ') || 'none found'}) did not end within ${CANCEL_GRACE_MS / 60_000} minutes of the host's stop`;
  return [await ended(p, s, attempt, { t: 'abandoned', reason })];
}

/**
 * An answer. A first answer that does not parse gets ONE repair request on the same seat
 * (design.md R11) instead of ending the attempt, while the expedition runs; any other answer
 * ends it with what it holds. Never on a finished expedition: 2026-11-01 review, an answer that
 * arrived after the owner's stop was repaired, which started a new paid run on the seat that
 * the one-shot cancel (already recorded for the attempt) never stopped.
 */
async function answered(
  p: ObservePorts,
  s: State,
  attempt: Attempt,
  phase: Extract<AttemptPhase, { t: 'posted' }>,
  body: string
): Promise<Entry[]> {
  const parsed = parseOutcome(attempt.spec.kind, body);
  if (parsed.t === 'malformed' && phase.round === 'brief' && s.run.t !== 'finished')
    return [
      {
        t: 'attempt_repair_posting',
        at: p.now(),
        attemptId: attempt.id,
        error: parsed.error,
        body: repairBrief(s, attempt, parsed.error, body),
      },
    ];
  return [await ended(p, s, attempt, await heldOutcome(s, attempt.id, body, parsed))];
}

/**
 * A work attempt that ends with anything but a code claim (a finding, blocked, malformed,
 * failed, cancelled, abandoned) while its branch holds commits beyond its base is
 * `unreported_commits`, with the shas, so the manager can claim them (design.md R11).
 * 2026-11-01 incident: w64130b's verifier commit was dropped with its malformed answer, and
 * w475a3b's ACCEPTANCE_ROUTE.md commit with its `finding`.
 */
async function unreported(s: State, attempt: Attempt, outcome: EndOutcome): Promise<Outcome> {
  if (attempt.spec.kind !== 'work' || reportsCommit(outcome)) return outcome;
  // A missing branch made no commits: it is never created without the worktree.
  const branch = await branchState(s.repo.root, worktreeOf(s, attempt.id));
  switch (branch.t) {
    case 'missing':
      return outcome;
    case 'present':
      return branch.shas.length === 0
        ? outcome
        : { t: 'unreported_commits', shas: branch.shas, ended: outcome };
  }
}

/**
 * The owner's messages in the expedition chat (the owner↔crew DM) since the last one recorded,
 * oldest first, each as a `feedback` entry (answers.ts chatFeedback): answering "needs you" in
 * the chat resumes the run, and pause/resume/stop work there, without the steer tool. Keyed by
 * the post's ordered id (the ledger's chat cursor), so a replay never records one twice.
 */
async function observeChat(p: ObservePorts, s: State): Promise<Entry[]> {
  if (s.crew.t !== 'ready' || s.run.t === 'finished') return [];
  const posts = await chatPostsAfter(p, s.crew.chatChannelId, s.chatCursor);
  return posts
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

/** The chat's top-level posts newer than the cursor, oldest first (pages newest-first). */
async function chatPostsAfter(p: ObservePorts, channelId: string, cursor: State['chatCursor']) {
  const newer = (ord: string) => cursor.t === 'start' || ord > cursor.ord;
  const out: Awaited<ReturnType<BuddiesCore['listPosts']>>['posts'] = [];
  let before: { ord: string } | undefined;
  for (;;) {
    const page = await p.core.listPosts(OWNER, { kind: 'channel', channelId }, before, CHAT_PAGE);
    const fresh = page.posts.filter((post) => newer(post.ord));
    out.push(...fresh);
    if (!page.next || fresh.length < page.posts.length) break;
    before = page.next;
  }
  return out.reverse();
}

/**
 * A work claim's `change` is checked against its own attempt branch (git.ts claimHeld); one the
 * branch does not hold is recorded `malformed` with the reason, so the manager sees it and it is
 * never validated, checked or integrated on the claim's word alone. A commit that edits files
 * outside its question's custody is not held either: custody is enforced, not advisory.
 */
async function heldOutcome(
  s: State,
  attemptId: string,
  body: string,
  outcome: EndOutcome
): Promise<EndOutcome> {
  if (outcome.t !== 'work' || outcome.result.result !== 'claim') return outcome;
  const tree = worktreeOf(s, attemptId);
  const custody = custodyOf(s, attemptOf(s, attemptId));
  const held = await claimHeld(s.repo.root, tree, outcome.result.change, custody);
  switch (held.t) {
    case 'held':
      return outcome;
    case 'not_held':
      return { t: 'malformed', error: held.reason, raw: body };
  }
}

/** A posted attempt's phase (the observer reads only posted attempts). */
function postedPhase(attempt: Attempt): Extract<AttemptPhase, { t: 'posted' }> {
  if (attempt.phase.t !== 'posted') throw new Error(`attempt ${attempt.id} is ${attempt.phase.t}`);
  return attempt.phase;
}

/** The end of a work attempt that reports its commit: a code claim (held or not, its commits are
 * then the claim's business, heldOutcome). */
function reportsCommit(o: EndOutcome): boolean {
  return o.t === 'work' && o.result.result === 'claim' && o.result.change.t === 'commit';
}
