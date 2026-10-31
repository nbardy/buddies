import type { Attempt, State, Worktree } from './ledger';
import { attemptOf } from './ledger';
import { admitted, custodyOf, custodyOverlaps, queued } from './queries';

// The idempotent writes a folded state licenses (pure). The host runs them in order; each carries
// an idempotency key derived from the expedition and the attempt/status id (host.ts), or adopts
// its own earlier git result by name (git.ts).

export type Effect =
  /** Create `expedition/<id>` at the base commit the launch recorded. */
  | { t: 'create_branch' }
  | { t: 'create_crew' }
  /** Record a work attempt's worktree intent, then create it (it now holds a slot and custody). */
  | { t: 'admit_work'; attemptId: string }
  /** Create or adopt a recorded worktree: the replay path after a crash between intent and ready. */
  | { t: 'create_worktree'; attemptId: string }
  /** An ended attempt's worktree (keepCommits) or, once finished, every remaining one. */
  | { t: 'release_worktree'; attemptId: string; keepCommits: boolean }
  /** Build and record the brief (then post it). */
  | { t: 'brief_attempt'; attempt: Attempt }
  /** Post a recorded brief: the replay path after a crash between record and post. */
  | { t: 'post_attempt'; attemptId: string; body: string }
  | { t: 'post_status'; seq: number; text: string }
  | { t: 'post_badge' };

export function pendingEffects(s: State): Effect[] {
  if (s.branch.t === 'pending') return [{ t: 'create_branch' }];
  if (s.crew.t === 'pending') return [{ t: 'create_crew' }];
  const badgeEffects: Effect[] = s.badgePost.t === 'pending' ? [{ t: 'post_badge' }] : [];
  const effects: Effect[] = badgeEffects.concat(
    s.statuses
      .filter((x) => x.post.t === 'pending')
      .map((x): Effect => ({ t: 'post_status', seq: x.seq, text: x.text })),
    releases(s)
  );
  if (s.run.t === 'finished' || s.run.t === 'paused') return effects;
  for (const attempt of s.attempts)
    if (attempt.phase.t === 'posting')
      effects.push({ t: 'post_attempt', attemptId: attempt.id, body: attempt.phase.body });
  // Admission (design.md R1): at most maxLive workers, and never two with overlapping custody;
  // a blocked attempt stays queued (in order) until a slot and its paths free up.
  const holding = admitted(s);
  const custody = holding.map((a) => custodyOf(s, a));
  let capacity = s.charter.maxLive - holding.length;
  for (const attempt of queued(s)) {
    const worktree = s.worktrees[attempt.id];
    if (attempt.spec.kind === 'manager') effects.push({ t: 'brief_attempt', attempt });
    else if (worktree) effects.push(admittedEffect(attempt, worktree));
    else if (capacity > 0 && !custody.some((c) => custodyOverlaps(c, custodyOf(s, attempt)))) {
      capacity -= 1;
      custody.push(custodyOf(s, attempt));
      effects.push(
        attempt.spec.kind === 'work'
          ? { t: 'admit_work', attemptId: attempt.id }
          : { t: 'brief_attempt', attempt }
      );
    }
  }
  return effects;
}

/** The next step for an admitted, still-planned work attempt: finish its worktree, then brief. */
function admittedEffect(attempt: Attempt, worktree: Worktree): Effect {
  switch (worktree.status.t) {
    case 'creating':
      return { t: 'create_worktree', attemptId: attempt.id };
    case 'ready':
      return { t: 'brief_attempt', attempt };
    case 'kept':
    case 'removed':
    case 'left':
      throw new Error(`planned attempt ${attempt.id} has a released worktree`);
  }
}

/**
 * Worktrees due for release: an ended attempt's ready one (kept if it has commits, for
 * integration), and once the expedition is finished every one not yet released (trees removed;
 * branches with commits stay).
 */
function releases(s: State): Effect[] {
  const finished = s.run.t === 'finished';
  return Object.values(s.worktrees).flatMap((w): Effect[] => {
    const ended = w.status.t === 'ready' && attemptOf(s, w.attemptId).phase.t === 'ended';
    const open = w.status.t === 'creating' || w.status.t === 'ready' || w.status.t === 'kept';
    return ended || (finished && open)
      ? [{ t: 'release_worktree', attemptId: w.attemptId, keepCommits: !finished }]
      : [];
  });
}
