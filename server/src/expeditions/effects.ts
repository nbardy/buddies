import type {
  Attempt,
  RetireChat,
  Round,
  State,
  Validation,
  Worktree,
  WorktreeStatus,
} from './ledger';
import { attemptOf, validationComplete, worktreeOf } from './ledger';
import {
  type WorkerSpec,
  admitted,
  custodyOf,
  custodyOverlaps,
  isWorker,
  live,
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
  /** Make (or adopt) the manager's detached read-only worktree (design.md R11). */
  | { t: 'create_manager_tree' }
  /** At finish, once no manager runs in it: remove the manager's worktree. */
  | { t: 'release_manager_tree' }
  /** Check a manager's claim of an attempt's unreported commits against its branch (R11). */
  | { t: 'adopt_claim'; attemptId: string }
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
  /** Post a recorded brief or repair request: also the replay path after a crash between record
   * and post (keyed by attempt and round, so a replay returns the same post). */
  | { t: 'post_attempt'; attemptId: string; body: string; round: Round }
  /** Read an ended attempt's measured cost once its runs settled (design.md R6); writes nothing
   * while they are still settling (until meter.ts SETTLE_WINDOW_MS after `endedAt`). */
  | { t: 'meter_attempt'; attemptId: string; requestIds: string[]; endedAt: string }
  | { t: 'post_status'; seq: number; text: string }
  | { t: 'post_badge' }
  /** A finished expedition's live attempt: ask its runs to stop (audit 2026-11-01 #2). */
  | { t: 'cancel_attempt'; attemptId: string }
  // ---------- Retirement (plan A6), in this order, each once the one before it is done ----------
  /** A tree finish left (`left`, `kept`, or an integration tree never made): released again under
   * the retire policy (release.ts), which snapshots uncommitted changes instead of refusing. */
  | { t: 'retire_tree'; tree: RetireTree }
  /** Every expedition ref archived as a tag on origin, then deleted (git.ts archiveBranch). */
  | { t: 'archive_branches' }
  /** The crew chat and the crew's attempts DM archived (never a DM with another Buddy). */
  | { t: 'archive_chats'; chats: RetireChat[] }
  /** The crew Buddy archived (its conversations stop). */
  | { t: 'archive_crew' }
  /** Everything is put away: the last ledger line, `retired`. */
  | { t: 'record_retired' }
  /** The retired ledger frozen as a snapshot and its folder moved to `.retired` (retired.ts). */
  | { t: 'file_retired' };

/** A tree a retirement removes, one handler each in the host. */
export type RetireTree =
  | { t: 'attempt'; attemptId: string }
  | { t: 'validation'; validationId: string }
  | { t: 'integration' }
  | { t: 'manager' };

/** δ over the retirement: an active expedition owes its run's effects, a retiring one those and
 * then its retirement steps, a retired one only its filing. */
export function pendingEffects(s: State): Effect[] {
  if (s.crew.t === 'pending') return [{ t: 'create_crew' }];
  switch (s.retirement.t) {
    case 'active':
      return runEffects(s);
    case 'retiring':
      return [...runEffects(s), ...retireEffects(s)];
    case 'retired':
      return [{ t: 'file_retired' }];
  }
}

function runEffects(s: State): Effect[] {
  const finished = s.run.t === 'finished';
  const effects: Effect[] = [
    // Finished: nothing a live attempt does can matter any more, so its runs are asked to stop
    // (once); its end, or the host's `abandoned` after the grace, then releases its tree. First,
    // so stopping paid runs never waits behind a status post or a tree release.
    ...(finished
      ? s.attempts.flatMap((a): Effect[] =>
          a.phase.t === 'posted' && !(a.id in s.cancels)
            ? [{ t: 'cancel_attempt', attemptId: a.id }]
            : []
        )
      : []),
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
      a.phase.t === 'posting'
        ? [{ t: 'post_attempt', attemptId: a.id, body: a.phase.body, round: a.phase.round }]
        : []
    ),
    // Metering is a read: it runs whatever the run state, finished and paused included.
    ...s.attempts.flatMap((a): Effect[] =>
      a.phase.t === 'ended' && !(a.id in s.costs)
        ? [
            {
              t: 'meter_attempt',
              attemptId: a.id,
              requestIds: s.requests[a.id] ?? [a.phase.requestId],
              endedAt: a.phase.endedAt,
            },
          ]
        : []
    ),
    ...managerTreeEffects(s),
  ];
  switch (s.integrationTree.status.t) {
    case 'creating':
      // A run stopped before its tree was made never makes it (decide finishes first, #1).
      return finished ? effects : [...effects, { t: 'create_integration_tree' }];
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
  const next = s.validations.find((v) => !validationComplete(v));
  if (merge) effects.push({ t: 'integrate', integrationId: merge.id });
  else if (next) effects.push(validationEffect(next));
  for (const attemptId of Object.keys(s.adoptions))
    if (s.adoptions[attemptId].t === 'pending') effects.push({ t: 'adopt_claim', attemptId });
  for (const attempt of s.attempts.filter((a) => a.phase.t === 'admitted'))
    effects.push(admittedEffect(attempt, worktreeOf(s, attempt.id)));
  // A manager is briefed only in its own tree (R11); decide plans none before it is ready.
  if (s.managerTree.t === 'ready')
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

/** The manager's tree is made once the integration tree is ready (a ledger written before R11
 * gets one on its first tick), and released at finish once no manager decision runs in it. */
function managerTreeEffects(s: State): Effect[] {
  const finished = s.run.t === 'finished';
  const managerLive = s.attempts.some(
    (a) => a.spec.kind === 'manager' && (a.phase.t === 'posting' || a.phase.t === 'posted')
  );
  switch (s.managerTree.t) {
    case 'missing':
      return !finished && s.integrationTree.status.t === 'ready'
        ? [{ t: 'create_manager_tree' }]
        : [];
    case 'ready':
      return finished && !managerLive ? [{ t: 'release_manager_tree' }] : [];
    case 'failed':
    case 'released':
      return [];
  }
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
    return held && (finished || validationComplete(v))
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

// ---------- Retirement (plan A6) ----------

const RETIRE_CHATS: readonly RetireChat[] = ['crew_chat', 'attempts'];

/**
 * The next retirement step, one at a time and only once finishing is over: the run finished, no
 * attempt is live (a stop's cancel ends them, or the grace abandons them) and no tree is still
 * held for the finish's own release. A refusal stops the steps until the owner asks again (the
 * reason is on the page). The last line waits for every finish effect, metering included, so the
 * snapshot holds the final cost.
 */
function retireEffects(s: State): Effect[] {
  if (s.retirement.t !== 'retiring' || s.retirement.refused.length > 0) return [];
  if (s.run.t !== 'finished' || live(s).length > 0 || heldTrees(s)) return [];
  const trees = strandedTrees(s);
  if (trees.length > 0) return trees.map((tree): Effect => ({ t: 'retire_tree', tree }));
  if (s.archive.branches.t === 'pending') return [{ t: 'archive_branches' }];
  const chats = RETIRE_CHATS.filter((c) => !s.archive.chats.includes(c));
  if (chats.length > 0) return [{ t: 'archive_chats', chats }];
  if (s.archive.crew.t === 'active') return [{ t: 'archive_crew' }];
  return runEffects(s).length === 0 ? [{ t: 'record_retired' }] : [];
}

/** A tree the finish still releases itself (a live tree, or one being made). */
function heldTrees(s: State): boolean {
  const held = (status: WorktreeStatus) => status.t === 'creating' || status.t === 'ready';
  return (
    Object.values(s.worktrees).some((w) => held(w.status)) ||
    s.validations.some((v) => v.phase.t === 'started' && held(v.phase.treeStatus)) ||
    s.integrationTree.status.t === 'ready' ||
    s.managerTree.t === 'ready'
  );
}

/**
 * Trees finishing left behind (effects.ts used to stop at `left`, a terminal dead end): each
 * worker, validation and integration tree that was refused or kept, the integration tree a stop
 * before setup never made (its create may have left a partial), and a manager tree left.
 */
function strandedTrees(s: State): RetireTree[] {
  return [
    ...Object.values(s.worktrees).flatMap((w): RetireTree[] =>
      stranded(w.status) ? [{ t: 'attempt', attemptId: w.attemptId }] : []
    ),
    ...s.validations.flatMap((v): RetireTree[] =>
      v.phase.t === 'started' && stranded(v.phase.treeStatus)
        ? [{ t: 'validation', validationId: v.id }]
        : []
    ),
    ...(stranded(s.integrationTree.status) || s.integrationTree.status.t === 'creating'
      ? [{ t: 'integration' } as const]
      : []),
    ...(s.managerTree.t === 'released' && stranded(s.managerTree.release)
      ? [{ t: 'manager' } as const]
      : []),
  ];
}

function stranded(status: WorktreeStatus): boolean {
  switch (status.t) {
    case 'left':
    case 'kept':
      return true;
    case 'creating':
    case 'ready':
    case 'failed':
    case 'removed':
    case 'absent':
      return false;
  }
}
