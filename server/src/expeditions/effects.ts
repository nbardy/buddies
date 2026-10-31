import type { Attempt, State, Worktree } from './ledger';
import { attemptOf, worktreeOf } from './ledger';
import {
  type WorkerSpec,
  admitted,
  custodyOf,
  custodyOverlaps,
  isWorker,
  queued,
  settled,
} from './queries';

// The idempotent writes a folded state licenses (pure). The host runs them in order; each carries
// an idempotency key derived from the expedition and the attempt/status id (host.ts), or adopts
// its own earlier git result by name (git.ts).

export type Effect =
  /** Create `expedition/<id>` at the base commit the launch recorded. */
  | { t: 'create_branch' }
  | { t: 'create_crew' }
  /** Record a worker attempt's worktree intent, then create it (it now holds a slot and custody). */
  | { t: 'admit'; attempt: Attempt<WorkerSpec> }
  /** Create or adopt a recorded worktree: the replay path after a crash between intent and ready. */
  | { t: 'create_worktree'; attemptId: string }
  /** A settled attempt's worktree (keepCommits) or, once finished, every idle one. */
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
  const effects: Effect[] = [
    ...(s.badgePost.t === 'pending' ? [{ t: 'post_badge' } as const] : []),
    ...s.statuses
      .filter((x) => x.post.t === 'pending')
      .map((x): Effect => ({ t: 'post_status', seq: x.seq, text: x.text })),
    ...releases(s),
    // A recorded brief is a committed intent: it is completed whatever the run state, because
    // the post may already exist (keyed, so the replay returns it) and its worker may be running.
    ...s.attempts.flatMap((a): Effect[] =>
      a.phase.t === 'posting' ? [{ t: 'post_attempt', attemptId: a.id, body: a.phase.body }] : []
    ),
  ];
  if (s.run.t === 'finished' || s.run.t === 'paused') return effects;
  for (const attempt of s.attempts.filter((a) => a.phase.t === 'admitted'))
    effects.push(admittedEffect(attempt, worktreeOf(s, attempt.id)));
  for (const attempt of queued(s).filter((a) => !isWorker(a)))
    effects.push({ t: 'brief_attempt', attempt });
  // Admission (design.md R1): at most maxLive workers, and never two with overlapping custody;
  // a blocked attempt stays queued (in order) until a slot and its paths free up.
  const holding = admitted(s);
  const custody = holding.map((a) => custodyOf(s, a));
  let capacity = s.charter.maxLive - holding.length;
  for (const attempt of queued(s).filter(isWorker)) {
    const paths = custodyOf(s, attempt);
    if (capacity <= 0 || custody.some((c) => custodyOverlaps(c, paths))) continue;
    capacity -= 1;
    custody.push(paths);
    effects.push({ t: 'admit', attempt });
  }
  return effects;
}

/** The next step for an admitted attempt: finish its worktree, then brief it. */
function admittedEffect(attempt: Attempt, worktree: Worktree): Effect {
  switch (worktree.status.t) {
    case 'creating':
      return { t: 'create_worktree', attemptId: attempt.id };
    case 'ready':
      return { t: 'brief_attempt', attempt };
    case 'failed':
    case 'kept':
    case 'removed':
    case 'absent':
    case 'left':
      throw new Error(`admitted attempt ${attempt.id} has a ${worktree.status.t} worktree`);
  }
}

/**
 * Worktrees due for release. A tree is released only once no worker can be in it: its attempt
 * settled, or the expedition finished before the attempt was briefed. A posting or posted
 * attempt's tree is never pulled from under its running worker, even after finish; it is released
 * when that attempt ends (the host keeps observing a finished expedition while attempts are live).
 * Before finish a tree with commits is kept for integration; at finish every tree goes and only
 * branches without commits are deleted.
 */
function releases(s: State): Effect[] {
  const finished = s.run.t === 'finished';
  return Object.values(s.worktrees).flatMap((w): Effect[] =>
    due(w, attemptOf(s, w.attemptId), finished)
      ? [{ t: 'release_worktree', attemptId: w.attemptId, keepCommits: !finished }]
      : []
  );
}

function due(w: Worktree, attempt: Attempt, finished: boolean): boolean {
  switch (w.status.t) {
    case 'creating':
    case 'ready':
      return settled(attempt) || (finished && attempt.phase.t === 'admitted');
    case 'kept':
      return finished;
    case 'failed':
    case 'removed':
    case 'absent':
    case 'left':
      return false;
  }
}
