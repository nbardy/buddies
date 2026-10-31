import type { Attempt, State, Validation, Worktree, WorktreeStatus } from './ledger';
import { attemptOf, validationComplete, worktreeOf } from './ledger';
import {
  type WorkerSpec,
  admitted,
  custodyOf,
  custodyOverlaps,
  isWorker,
  queued,
  settled,
  waitsOn,
} from './queries';

// The idempotent writes a folded state licenses (pure). The host runs them in order; each carries
// an idempotency key derived from the expedition and the attempt/status id (host.ts), or adopts
// its own earlier git result by name (git.ts).

export type Effect =
  | { t: 'create_crew' }
  /** Create (or adopt) the integration worktree `launched` named, on `expedition/<id>`. */
  | { t: 'create_integration_tree' }
  /** Merge the next planned candidate into the expedition branch (one at a time, in order). */
  | { t: 'integrate'; integrationId: string }
  /** At finish: remove the integration worktree, keeping its branch for the owner to merge. */
  | { t: 'release_integration_tree' }
  /** Record a worker attempt's worktree intent, then create it (it now holds a slot and custody). */
  | { t: 'admit'; attempt: Attempt<WorkerSpec> }
  /** Create or adopt a recorded worktree: the replay path after a crash between intent and ready. */
  | { t: 'create_worktree'; attemptId: string }
  /** A settled attempt's worktree (keepCommits) or, once finished, every idle one. */
  | { t: 'release_worktree'; attemptId: string; keepCommits: boolean }
  /** Resolve a planned validation's sha, record its tree intent, create the tree. */
  | { t: 'start_validation'; validationId: string }
  /** Create or adopt a recorded validation tree (the replay path, as `create_worktree`). */
  | { t: 'create_validation_tree'; validationId: string }
  /** Run the command checks not yet recorded, in the host, in the background. */
  | { t: 'run_validation'; validationId: string }
  /** A validation's tree, once its checks are recorded (or the expedition finished): discarded. */
  | { t: 'release_validation'; validationId: string }
  /** Build and record the brief (then post it). */
  | { t: 'brief_attempt'; attempt: Attempt }
  /** Post a recorded brief: the replay path after a crash between record and post. */
  | { t: 'post_attempt'; attemptId: string; body: string }
  | { t: 'post_status'; seq: number; text: string }
  | { t: 'post_badge' };

export function pendingEffects(s: State): Effect[] {
  if (s.crew.t === 'pending') return [{ t: 'create_crew' }];
  const finished = s.run.t === 'finished';
  const effects: Effect[] = [
    ...(s.badgePost.t === 'pending' ? [{ t: 'post_badge' } as const] : []),
    ...s.statuses
      .filter((x) => x.post.t === 'pending')
      .map((x): Effect => ({ t: 'post_status', seq: x.seq, text: x.text })),
    ...releases(s),
    ...validationReleases(s),
    ...(finished && s.integrationTree.status.t === 'ready'
      ? [{ t: 'release_integration_tree' } as const]
      : []),
    // A recorded brief is a committed intent: it is completed whatever the run state, because
    // the post may already exist (keyed, so the replay returns it) and its worker may be running.
    ...s.attempts.flatMap((a): Effect[] =>
      a.phase.t === 'posting' ? [{ t: 'post_attempt', attemptId: a.id, body: a.phase.body }] : []
    ),
  ];
  switch (s.integrationTree.status.t) {
    case 'creating':
      return [...effects, { t: 'create_integration_tree' }];
    case 'failed': // decide finishes the expedition with the reason
    case 'kept':
    case 'removed':
    case 'absent':
    case 'left':
      return effects;
    case 'ready':
      break;
  }
  if (finished || s.run.t === 'paused') return effects;
  // Merges first, one at a time in plan order; validations wait for them, so a head validation
  // planned after a merge validates the merged head. Then one validation at a time, in plan
  // order: command checks may be heavy (builds, GPU runs).
  const merge = s.integrations.find((i) => i.status.t === 'pending');
  const next = s.validations.find((v) => !validationComplete(s, v));
  if (merge) effects.push({ t: 'integrate', integrationId: merge.id });
  else if (next) effects.push(validationEffect(next));
  for (const attempt of s.attempts.filter((a) => a.phase.t === 'admitted'))
    effects.push(admittedEffect(attempt, worktreeOf(s, attempt.id)));
  for (const attempt of queued(s).filter((a) => !isWorker(a)))
    effects.push({ t: 'brief_attempt', attempt });
  // Admission (design.md R1): at most maxLive workers, and never two with overlapping custody;
  // a blocked attempt stays queued (in order) until a slot and its paths free up. Work whose
  // question's dependencies are not verified (R5) waits too, holding neither slot nor custody.
  const holding = admitted(s);
  const custody = holding.map((a) => custodyOf(s, a));
  let capacity = s.charter.maxLive - holding.length;
  for (const attempt of queued(s).filter(isWorker)) {
    if (waitsOn(s, attempt).length > 0) continue;
    const paths = custodyOf(s, attempt);
    if (capacity <= 0 || custody.some((c) => custodyOverlaps(c, paths))) continue;
    capacity -= 1;
    custody.push(paths);
    effects.push({ t: 'admit', attempt });
  }
  return effects;
}

/** The next step for the validation in progress. */
function validationEffect(v: Validation): Effect {
  switch (v.phase.t) {
    case 'planned':
      return { t: 'start_validation', validationId: v.id };
    case 'started':
      return validationTreeEffect(v.id, v.phase.treeStatus);
  }
}

function validationTreeEffect(validationId: string, tree: WorktreeStatus): Effect {
  switch (tree.t) {
    case 'creating':
      return { t: 'create_validation_tree', validationId };
    case 'ready':
      return { t: 'run_validation', validationId };
    case 'failed':
    case 'kept':
    case 'removed':
    case 'absent':
    case 'left':
      throw new Error(`incomplete validation ${validationId} has a ${tree.t} tree`);
  }
}

/** Validation trees are scratch: discarded once every check is recorded, or at finish (the host
 * never removes a tree its own check job is still running in, host.ts). A `failed` tree has no
 * release: ensureWorktree already ran `cambium recover` on what a failed add left, and anything
 * still on disk is named in the failure reason (the same as a worker tree, `releases` below). */
function validationReleases(s: State): Effect[] {
  const finished = s.run.t === 'finished';
  return s.validations.flatMap((v): Effect[] => {
    if (v.phase.t !== 'started') return [];
    const status = v.phase.treeStatus.t;
    const held = status === 'creating' || status === 'ready';
    return held && (finished || validationComplete(s, v))
      ? [{ t: 'release_validation', validationId: v.id }]
      : [];
  });
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
