import type { Attempt, RetireChat, Round, State, Tree, TreeId, TreeStatus } from './ledger';
import {
  type ByTree,
  INTEGRATION_TREE,
  MANAGER_TREE,
  attemptOf,
  byTree,
  treeKey,
  treeOf,
  validationComplete,
  validationOf,
  worktreeOf,
} from './ledger';
import {
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
  /** Merge the next planned candidate into the expedition branch (one at a time, in order). */
  | { t: 'integrate'; integrationId: string }
  /** Check a manager's claim of an attempt's unreported commits against its branch (R11). */
  | { t: 'adopt_claim'; attemptId: string }
  /** Resolve a tree's place, record it (`tree_planned`), then make it. For an attempt this is
   * admission: from the intent on it holds a slot and its custody. */
  | { t: 'plan_tree'; tree: TreeId }
  /** Make or adopt a planned tree: the replay path after a crash between intent and ready. */
  | { t: 'create_tree'; tree: TreeId }
  /** End a tree no one works in any more, under the release its stage asks for (host.ts). */
  | { t: 'release_tree'; tree: TreeId; stage: ReleaseStage }
  /** Run the command checks not yet recorded, in the host, in the background. */
  | { t: 'run_validation'; validationId: string }
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
  // A tree finish left (`left`, `kept`, `failed`) is released again at stage `retiring`, whose
  // policy (release.ts) snapshots uncommitted changes instead of refusing.
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

/**
 * Which release a tree gets: while the expedition runs (an attempt with commits keeps its tree for
 * integration), at finish (every tree goes; uncommitted work leaves it in place), or at retirement
 * (it goes whatever it holds, uncommitted changes snapshotted first).
 */
export type ReleaseStage = 'running' | 'finished' | 'retiring';

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
    ...unpostedStatuses(s).map((x): Effect => ({ t: 'post_status', seq: x.seq, text: x.text })),
    ...releases(s),
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
    // A planned tree is made (or adopted) until the expedition finishes; one a stop caught still
    // being made is released instead, never made (decide finishes first, audit #1).
    ...(finished
      ? []
      : Object.values(s.trees).flatMap((t): Effect[] =>
          t.status.t === 'creating' ? [{ t: 'create_tree', tree: t.id }] : []
        )),
  ];
  // Nothing new starts before the integration tree is ready (a failed one finishes the run).
  if (finished || s.run.t === 'paused' || !ready(s, INTEGRATION_TREE)) return effects;
  // The manager's own tree (design.md R11), made once, after the integration tree.
  if (!(treeKey(MANAGER_TREE) in s.trees)) effects.push({ t: 'plan_tree', tree: MANAGER_TREE });
  // Merges first, one at a time in plan order; validations wait for them, so a head validation
  // planned after a merge validates the merged head. Then one validation at a time, in plan
  // order: command checks may be heavy (builds, GPU runs).
  const merge = s.integrations.find((i) => i.status.t === 'pending');
  const next = s.validations.find((v) => !validationComplete(v));
  if (merge) effects.push({ t: 'integrate', integrationId: merge.id });
  else if (next) effects.push(...validationEffects(s, next.id));
  for (const attemptId of Object.keys(s.adoptions))
    if (s.adoptions[attemptId].t === 'pending') effects.push({ t: 'adopt_claim', attemptId });
  // An admitted attempt is briefed once its tree is ready.
  for (const attempt of s.attempts.filter((a) => a.phase.t === 'admitted'))
    if (worktreeOf(s, attempt.id).status.t === 'ready')
      effects.push({ t: 'brief_attempt', attempt });
  // A manager is briefed only in its own tree (R11); decide plans none before it is ready.
  if (ready(s, MANAGER_TREE))
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
    effects.push({ t: 'plan_tree', tree: { t: 'attempt', attemptId: attempt.id } });
  }
  return effects;
}

const ready = (s: State, id: TreeId) =>
  treeKey(id) in s.trees && treeOf(s, id).status.t === 'ready';

/** The next step for the validation in progress: its first tree, its check job in it once it is
 * ready, or a fresh tree after the job died with a host process and its tree was released. A
 * tree still being made is `create_tree`'s. */
function validationEffects(s: State, validationId: string): Effect[] {
  const v = validationOf(s, validationId);
  const plan: Effect = {
    t: 'plan_tree',
    tree: { t: 'validation', validationId, restart: v.trees.length },
  };
  const key = v.trees.at(-1);
  if (key === undefined) return [plan];
  const status = s.trees[key].status;
  switch (status.t) {
    case 'creating':
      return [];
    case 'ready':
      return [{ t: 'run_validation', validationId }];
    case 'kept':
    case 'removed':
    case 'absent':
    case 'left':
      return [plan];
    case 'failed':
      throw new Error(`incomplete validation ${validationId} has a failed tree`);
  }
}

/**
 * Trees due for release: one no one can be in any more (`vacated`), and an attempt tree kept for
 * its commits once the expedition finished. A posting or posted attempt's tree is never pulled
 * from under its running worker, even after finish; it is released when that attempt ends (the
 * host keeps observing a finished expedition while attempts are live). A `failed` tree has no
 * release: ensureWorktree already ran `cambium recover` on what a failed add left, and anything
 * still on disk is named in the failure reason (retirement releases it, `strandedTrees`).
 */
function releases(s: State): Effect[] {
  const finished = s.run.t === 'finished';
  const stage: ReleaseStage = finished ? 'finished' : 'running';
  return Object.values(s.trees).flatMap((t): Effect[] =>
    due(s, t, finished) ? [{ t: 'release_tree', tree: t.id, stage }] : []
  );
}

function due(s: State, tree: Tree, finished: boolean): boolean {
  switch (tree.status.t) {
    case 'creating':
    case 'ready':
      return byTree(VACATED, tree.id, s, finished);
    case 'kept':
      return finished;
    case 'failed':
    case 'removed':
    case 'absent':
    case 'left':
      return false;
  }
}

/** Whether no one works in a held tree any more. The integration tree serves until finish; the
 * manager's until no manager decision runs in it; an attempt's until the attempt settled (or the
 * run finished before it was briefed); a validation's until every check is recorded or the run
 * finished (the host never removes a tree its own check job still runs in, host.ts). */
const VACATED: ByTree<[State, boolean], boolean> = {
  integration: (_id, _s, finished) => finished,
  manager: (_id, s, finished) =>
    finished &&
    !s.attempts.some(
      (a) => a.spec.kind === 'manager' && (a.phase.t === 'posting' || a.phase.t === 'posted')
    ),
  attempt: ({ attemptId }, s, finished) => {
    const attempt = attemptOf(s, attemptId);
    return settled(attempt) || (finished && attempt.phase.t === 'admitted');
  },
  validation: ({ validationId }, s, finished) =>
    finished || validationComplete(validationOf(s, validationId)),
};

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
  const trees = Object.values(s.trees);
  if (s.run.t !== 'finished' || live(s).length > 0 || trees.some((t) => held(t.status))) return [];
  const stranded = trees.filter((t) => strandedStatus(t.status));
  if (stranded.length > 0)
    return stranded.map((t): Effect => ({ t: 'release_tree', tree: t.id, stage: 'retiring' }));
  if (s.archive.branches.t === 'pending') return [{ t: 'archive_branches' }];
  const chats = RETIRE_CHATS.filter((c) => !s.archive.chats.includes(c));
  // Statuses go out while the chat is open: an archived channel refuses every post.
  if (chats.length > 0)
    return unpostedStatuses(s).length > 0 ? [] : [{ t: 'archive_chats', chats }];
  if (s.archive.crew.t === 'active') return [{ t: 'archive_crew' }];
  return runEffects(s).length === 0 ? [{ t: 'record_retired' }] : [];
}

/**
 * Statuses still to post to the crew chat. None once a retirement archived that chat: core
 * refuses a post to an archived channel, so a status written after (a `tick_failed` from a
 * failing retire step, a tool steer) stayed pending, failed every tick, and kept `record_retired`
 * waiting forever (review of plan A6). Such a status is on the page only.
 */
function unpostedStatuses(s: State) {
  if (s.archive.chats.includes('crew_chat')) return [];
  return s.statuses.filter((x) => x.post.t === 'pending');
}

/** A tree the finish still releases itself (a live tree, or one being made). */
const held = (status: TreeStatus) => status.t === 'creating' || status.t === 'ready';

/**
 * A tree finishing left behind (effects.ts used to stop at `left`, a terminal dead end): refused
 * (`left`), kept for its commits, or `failed`: a failed add can leave a registration or directory
 * on disk (git.ts ensureWorktree names it "still on disk"), and archive_branches would then delete
 * the branch it is checked out on, stranding the tree after retirement. Releasing a tree that is
 * not there is `absent` (release.ts goneTree), so a clean failure costs one lookup.
 */
function strandedStatus(status: TreeStatus): boolean {
  switch (status.t) {
    case 'left':
    case 'kept':
    case 'failed':
      return true;
    case 'creating':
    case 'ready':
    case 'removed':
    case 'absent':
      return false;
  }
}
