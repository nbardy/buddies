import type { Attempt, RetireChat, Round, State, Tree, TreeId, TreeStatus } from './ledger';
import {
  type ByTree,
  INTEGRATION_TREE,
  MANAGER_TREE,
  allAttempts,
  attemptOf,
  byTree,
  requestsOf,
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
  isQueued,
  live,
  managerRunning,
  settled,
  waitsOn,
} from './queries';

// The idempotent writes a folded state licenses (pure). The host runs them in order (run.ts);
// each is keyed by the expedition and attempt/status id, or adopts its own git result by name.

export type Effect =
  | { t: 'create_crew' }
  /** Merge the next planned candidate into the expedition branch (one at a time, in order). */
  | { t: 'integrate'; integrationId: string }
  /** Check a manager's claim of an attempt's unreported commits against its branch (R11). */
  | { t: 'adopt_claim'; attemptId: string }
  /** Record a tree's place (`tree_planned`), then make it; for an attempt this is admission. */
  | { t: 'plan_tree'; tree: TreeId }
  /** Make or adopt a planned tree: the replay path after a crash between intent and ready. */
  | { t: 'create_tree'; tree: TreeId }
  | { t: 'release_tree'; tree: TreeId; stage: ReleaseStage }
  /** Run the command checks not yet recorded, in the host, in the background. */
  | { t: 'run_validation'; validationId: string }
  | { t: 'brief_attempt'; attempt: Attempt }
  /** Post a recorded brief or repair request (keyed by attempt and round: replay-safe). */
  | { t: 'post_attempt'; attemptId: string; body: string; round: Round }
  /** Read an ended attempt's cost once its runs settled (design.md R6, meter.ts). */
  | { t: 'meter_attempt'; attemptId: string; requestIds: string[]; endedAt: string }
  | { t: 'post_status'; seq: number; text: string }
  | { t: 'post_badge' }
  /** A finished expedition's live attempt: ask its runs to stop (audit 2026-11-01 #2). */
  | { t: 'cancel_attempt'; attemptId: string }
  // Retirement (plan A6), in this order, each once the one before it is done.
  | { t: 'archive_branches' }
  | { t: 'archive_chats'; chats: RetireChat[] }
  | { t: 'archive_crew' }
  | { t: 'record_retired' }
  /** The retired ledger frozen as a snapshot and its folder moved to `.retired` (retired.ts). */
  | { t: 'file_retired' };

/** Which release a tree gets (run.ts STAGES): while running, at finish, or at retirement. */
export type ReleaseStage = 'running' | 'finished' | 'retiring';

/** δ over the retirement: an active expedition owes its run's effects, a retiring one those and
 * its retirement steps, a retired one its filing. */
export function pendingEffects(s: State): Effect[] {
  if (s.crew.t === 'pending') return [{ t: 'create_crew' }];
  return RETIREMENT[s.retirement.t](s);
}
const RETIREMENT: Record<State['retirement']['t'], (s: State) => Effect[]> = {
  active: (s) => runEffects(s),
  retiring: (s) => [...runEffects(s), ...retireEffects(s)],
  retired: () => [{ t: 'file_retired' }],
};

/** `setup` until the integration tree is ready; an owner question does not hold the crew. */
type Phase = 'setup' | 'running' | 'paused' | 'finished';
const started = (s: State): Phase => (ready(s, INTEGRATION_TREE) ? 'running' : 'setup');
const PHASE_OF: Record<State['run']['t'], (s: State) => Phase> = {
  running: started,
  waiting_owner: started,
  paused: () => 'paused',
  finished: () => 'finished',
};
const runEffects = (s: State): Effect[] => PHASE_EFFECTS[PHASE_OF[s.run.t](s)](s);

/** δ over the phase: each phase's effects in order, around the ones every phase owes. */
const PHASE_EFFECTS: Record<Phase, (s: State) => Effect[]> = {
  setup: (s) => [...always(s), ...creates(s)],
  paused: (s) => [...always(s), ...creates(s)],
  running: (s) => [...always(s), ...creates(s), ...starts(s)],
  // Cancels first, so stopping paid runs never waits behind a status post or a release. A tree a
  // stop caught still being made is released, never made (decide finishes first, audit #1).
  finished: (s) => [...cancels(s), ...always(s)],
};

/** What every phase owes: the badge, statuses, due releases, recorded posts and metering. */
function always(s: State): Effect[] {
  return [
    ...(s.badgePost.t === 'pending' ? [{ t: 'post_badge' } as const] : []),
    ...unpostedStatuses(s).map((x): Effect => ({ t: 'post_status', seq: x.seq, text: x.text })),
    ...releases(s),
    // A recorded brief is a committed intent: completed whatever the run state (its post may
    // exist and its worker run). Metering is a read: it runs whatever the run state too.
    ...allAttempts(s).flatMap(({ id: attemptId, phase }): Effect[] =>
      phase.t === 'posting'
        ? [{ t: 'post_attempt', attemptId, body: phase.body, round: phase.round }]
        : []
    ),
    ...allAttempts(s).flatMap(({ id: attemptId, phase }): Effect[] =>
      phase.t === 'ended' && !(attemptId in s.costs)
        ? [
            {
              t: 'meter_attempt',
              attemptId,
              requestIds: requestsOf(s, attemptId),
              endedAt: phase.endedAt,
            },
          ]
        : []
    ),
  ];
}

const cancels = (s: State): Effect[] =>
  allAttempts(s)
    .filter((a) => a.phase.t === 'posted' && !(a.id in s.cancels))
    .map((a) => ({ t: 'cancel_attempt', attemptId: a.id }));

const creates = (s: State): Effect[] =>
  Object.values(s.trees)
    .filter((t) => t.status.t === 'creating')
    .map((t) => ({ t: 'create_tree', tree: t.id }));

/** What a running expedition starts: its manager tree, merges, validations, claims, briefs. */
function starts(s: State): Effect[] {
  const effects: Effect[] = [];
  if (!(treeKey(MANAGER_TREE) in s.trees)) effects.push({ t: 'plan_tree', tree: MANAGER_TREE });
  // Merges first, one at a time in plan order; validations wait for them (a head validation
  // validates the merged head), one at a time: command checks may be heavy (builds, GPU runs).
  const merge = s.integrations.find((i) => i.status.t === 'pending');
  const next = s.validations.find((v) => !validationComplete(v));
  if (merge) effects.push({ t: 'integrate', integrationId: merge.id });
  else if (next) effects.push(...validationEffects(s, next.id));
  for (const attemptId of Object.keys(s.adoptions))
    if (s.adoptions[attemptId].t === 'pending') effects.push({ t: 'adopt_claim', attemptId });
  for (const attempt of s.workers.filter((a) => a.phase.t === 'admitted'))
    if (worktreeOf(s, attempt.id).status.t === 'ready')
      effects.push({ t: 'brief_attempt', attempt });
  // A manager is briefed only in its own tree (R11).
  if (ready(s, MANAGER_TREE))
    for (const attempt of s.managers.filter(isQueued))
      effects.push({ t: 'brief_attempt', attempt });
  // Admission (design.md R1): at most maxLive workers, never two with overlapping custody; a
  // blocked attempt stays queued in order. Work on unverified dependencies (R5) waits too.
  const holding = admitted(s);
  const custody = holding.map((a) => custodyOf(s, a));
  let capacity = s.charter.maxLive - holding.length;
  for (const attempt of s.workers.filter(isQueued)) {
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

/** The validation in progress: its first tree, its check job, or a fresh tree after a dead job's. */
function validationEffects(s: State, validationId: string): Effect[] {
  const v = validationOf(s, validationId);
  const tree = { t: 'validation', validationId, restart: v.trees.length } as const;
  const plan: Effect = { t: 'plan_tree', tree };
  const key = v.trees.at(-1);
  if (key === undefined) return [plan];
  const status = s.trees[key].status.t;
  if (status === 'failed')
    throw new Error(`incomplete validation ${validationId} has a failed tree`);
  const NEXT: Record<Exclude<TreeStatus['t'], 'failed'>, Effect[]> = {
    creating: [],
    ready: [{ t: 'run_validation', validationId }],
    kept: [plan],
    removed: [plan],
    absent: [plan],
    left: [plan],
  };
  return NEXT[status];
}

/** Trees due for release: a held one no one is in any more, a kept one once finished. A `failed`
 * tree has none: ensureWorktree recovered what the add left (retirement releases the rest). */
function releases(s: State): Effect[] {
  const finished = s.run.t === 'finished';
  const stage: ReleaseStage = finished ? 'finished' : 'running';
  return Object.values(s.trees)
    .filter((t) => due(s, t, finished))
    .map((t) => ({ t: 'release_tree', tree: t.id, stage }));
}

function due(s: State, tree: Tree, finished: boolean): boolean {
  return HELD.has(tree.status.t)
    ? byTree(VACATED, tree.id, s, finished)
    : tree.status.t === 'kept' && finished;
}

/** Whether no one works in a held tree any more (run.ts never removes one its check job runs in). */
const VACATED: ByTree<[State, boolean], boolean> = {
  integration: (_id, _s, finished) => finished,
  manager: (_id, s, finished) => finished && !managerRunning(s),
  attempt: ({ attemptId }, s, finished) => {
    const attempt = attemptOf(s, attemptId);
    return settled(attempt) || (finished && attempt.phase.t === 'admitted');
  },
  validation: ({ validationId }, s, finished) =>
    finished || validationComplete(validationOf(s, validationId)),
};

const RETIRE_CHATS: readonly RetireChat[] = ['crew_chat', 'attempts'];

/** The next retirement step, one at a time, once finishing is over; a refusal stops them until
 * the owner asks again. The last line waits for every finish effect, so the snapshot holds the cost. */
function retireEffects(s: State): Effect[] {
  if (s.retirement.t !== 'retiring' || s.retirement.refused.length > 0) return [];
  const trees = Object.values(s.trees);
  if (s.run.t !== 'finished' || live(s).length > 0 || trees.some((t) => HELD.has(t.status.t)))
    return [];
  // A tree finishing left behind: refused, kept, or `failed` (a failed add can leave it on disk,
  // and archive_branches would delete the branch it is checked out on). Released `absent` if gone.
  const stranded = trees.filter((t) => STRANDED.has(t.status.t));
  if (stranded.length > 0)
    return stranded.map((t) => ({ t: 'release_tree', tree: t.id, stage: 'retiring' }));
  if (s.archive.branches.t === 'pending') return [{ t: 'archive_branches' }];
  const chats = RETIRE_CHATS.filter((c) => !s.archive.chats.includes(c));
  // Statuses go out while the chat is open: an archived channel refuses every post.
  if (chats.length > 0)
    return unpostedStatuses(s).length > 0 ? [] : [{ t: 'archive_chats', chats }];
  if (s.archive.crew.t === 'active') return [{ t: 'archive_crew' }];
  return runEffects(s).length === 0 ? [{ t: 'record_retired' }] : [];
}
const HELD: ReadonlySet<TreeStatus['t']> = new Set(['creating', 'ready']);
const STRANDED: ReadonlySet<TreeStatus['t']> = new Set(['left', 'kept', 'failed']);

/** Statuses still to post. None once a retirement archived the chat: such a status (a later
 * `tick_failed`, a steer) failed every tick and kept `record_retired` waiting forever (plan A6). */
const unpostedStatuses = (s: State) =>
  s.archive.chats.includes('crew_chat') ? [] : s.statuses.filter((x) => x.post.t === 'pending');
