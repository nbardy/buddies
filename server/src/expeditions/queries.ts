import { type Charter, type Claim, type WorkerConfig, sameModel } from './charter';
import type { Attempt, AttemptSpec, CheckSpec, ClaimState, Question, State, Validation, WorkSpec } from './ledger';
import {
  MANAGER_TREE,
  allAttempts,
  attemptOf,
  claimState,
  interruptedEnd,
  questionOf,
  treeOf,
  validationPassed,
  workOf,
  worksOf,
} from './ledger';

// Pure read-only views over a folded State, shared by decide, effects, briefs, news and the page.

/** Its request is being posted or is out: a run is (about to be) working on it. */
const isLive = (a: Attempt) => a.phase.t === 'posted' || a.phase.t === 'posting';
export const live = (s: State) => allAttempts(s).filter(isLive);
export const liveWorkers = (s: State) => s.workers.filter(isLive);
/** A manager decision runs in the manager's tree (its request is out). */
export const managerRunning = (s: State) => s.managers.some(isLive);
/** A manager decision is planned or running: decide plans no other until it ends. */
export const managerOpen = (s: State) => s.managers.some((a) => a.phase.t !== 'ended');
/** A merge into the expedition branch is planned and not yet run (design.md R3). */
export const integrating = (s: State) => s.integrations.some((i) => i.status.t === 'pending');
export const isQueued = (a: Attempt) => a.phase.t === 'planned';
export const queued = (s: State) => allAttempts(s).filter(isQueued);
/** Settled: nothing will run for it any more (it ended, or was dropped before it started). */
export const settled = (a: Attempt) => a.phase.t === 'ended' || a.phase.t === 'dropped';
export const exploreAttempts = (s: State) =>
  worksOf(s).filter((a) => questionOf(s, a.spec.questionId).scope === 'explore').length;
/** The owner's budget counts work and check attempts, never manager decisions (design.md R9), nor
 * an attempt a restart interrupted (its `attempt_retry_planned` replan is the one counted). */
export const workerAttempts = (s: State) => s.workers.filter((a) => !interrupted(a)).length;
export const interrupted = (a: Attempt) => a.phase.t === 'ended' && interruptedEnd(a.phase.outcome);
export const managerTurns = (s: State) => s.managers.length;
/** Decisions are bounded apart from the budget so a manager deciding nothing cannot spin: two per
 * budgeted attempt (start it, act on it) plus the first plan and the done. */
export const managerCap = (c: Charter) => 2 * c.maxAttempts + 2;
export const exploreCap = (c: Charter) => Math.floor(c.exploreShare * c.maxAttempts);
export const deadlineMs = (s: State) =>
  Date.parse(s.launchedAt) + (s.charter.hours + s.extendedHours) * 3_600_000;

/** Two custody prefixes overlap when one contains the other (`.` is the whole repository). */
const prefixOverlap = (a: string, b: string) =>
  a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export const custodyOverlaps = (a: readonly string[], b: readonly string[]) =>
  a.some((x) => b.some((y) => prefixOverlap(x, y)));
/** A repo-relative file is in custody when one prefix holds it (git.ts claimHeld). */
export const withinCustody = (file: string, custody: readonly string[]) =>
  custody.some((p) => p === '.' || file === p || file.startsWith(`${p}/`));

/** A worker attempt's file custody: its question's paths for work, nothing otherwise. */
export const custodyOf = (s: State, a: Attempt): readonly string[] =>
  a.spec.kind === 'work' ? questionOf(s, a.spec.questionId).paths : [];

/** Holding a live slot and its custody: admitted (about to be briefed), posting or posted. */
const running = (a: Attempt) =>
  a.phase.t === 'admitted' || a.phase.t === 'posting' || a.phase.t === 'posted';
export const admitted = (s: State) => s.workers.filter(running);

/** What an attempt claims: none until it ended. */
export const attemptClaim = (a: Attempt): ClaimState =>
  a.phase.t === 'ended' ? claimState(a.phase.outcome) : { t: 'none' };
/** The claim an attempt ended with; checks and integrations are planned only for ended claims
 * (decide.ts), so a missing one is a corrupt ledger. */
export function claimAt(s: State, attemptId: string): Claim {
  const claimed = attemptClaim(attemptOf(s, attemptId));
  if (claimed.t === 'none') throw new Error(`attempt ${attemptId} has no claim`);
  return claimed.claim;
}
/** The claim a check verifies. */
export const claimOf = (s: State, spec: CheckSpec): Claim => claimAt(s, spec.claimAttemptId);

/** The work and check attempts on one question (managers belong to no question). */
export const attemptsOn = (s: State, questionId: string) =>
  s.workers.filter((a) => a.spec.questionId === questionId);

export interface Panel {
  id: string;
  questionId: string;
  claimAttemptId: string;
  goal: boolean;
  verdict: 'pending' | 'verified' | 'not_verified';
}

/** A panel is verified when a strict majority of its checks verified the claim. */
function panelsOf(s: State): Panel[] {
  const out = new Map<string, Attempt<CheckSpec>[]>();
  // An interrupted check never voted: its replan (same panel, new id) takes its seat.
  for (const c of s.workers)
    if (c.spec.kind === 'check' && !interrupted(c))
      out.set(c.spec.panelId, [...(out.get(c.spec.panelId) ?? []), c as Attempt<CheckSpec>]);
  return [...out.entries()].map(([id, members]) => {
    const { questionId, claimAttemptId, goal } = members[0].spec;
    // A dropped check (its worktree could not be made) settles the panel without a vote.
    const yes = members.filter(
      (m) =>
        m.phase.t === 'ended' &&
        m.phase.outcome.t === 'check' &&
        m.phase.outcome.result.verdict === 'verified'
    ).length;
    const verdict = !members.every(settled)
      ? 'pending'
      : yes * 2 > members.length
        ? 'verified'
        : 'not_verified';
    return { id, questionId, claimAttemptId, goal, verdict };
  });
}

/**
 * Why a claim counts as verified (design.md R9): a panel majority, or the host's own proof (its
 * command acceptance passed on the commit and the commit was merged). 2026-11-01 smoke incident:
 * a done on host checks alone left its question open and the badge at "0 verified".
 */
export type Verification =
  | { t: 'panel'; questionId: string; claimAttemptId: string; panelId: string }
  | {
      t: 'host';
      questionId: string;
      claimAttemptId: string;
      validationId: string;
      mergeSha: string;
    };
type HostVerification = Extract<Verification, { t: 'host' }>;

/** The panel and verification views every reader shares, computed once per state revision. */
interface Derived {
  revision: number;
  panels: Panel[];
  /** Host-verified claims a later panel has not refuted. */
  host: HostVerification[];
  verifications: Verification[];
  /** Questions whose newest settled panel verified them, or with a host-verified claim. */
  verifiedQuestions: ReadonlySet<string>;
}

// Rebuilding panels per reader was O(claims x checks) per tick. Cached per revision, not per
// object: decide mutates the state it reads (ledger.ts apply), and a stale panel would let an
// integrate pass a check panel the same decision just planned.
const DERIVED = new WeakMap<State, Derived>();

export function derive(s: State): Derived {
  const cached = DERIVED.get(s);
  if (cached?.revision === s.revision) return cached;
  const fresh = deriveAt(s);
  DERIVED.set(s, fresh);
  return fresh;
}

/** The newest SETTLED panel decides, by key: a later refutation withdraws an earlier verification
 * (a stale one must not unlock dependants, R5). */
const latestSettled = (panels: Panel[], key: (p: Panel) => string) =>
  new Map(panels.filter((p) => p.verdict !== 'pending').map((p) => [key(p), p.verdict]));

function deriveAt(s: State): Derived {
  const panels = panelsOf(s);
  // A refutation withdraws panel and host verification alike, so every reader agrees (2026-11-01
  // review: only questionVerified applied it, so a refuted integrated claim closed verified).
  const byClaim = latestSettled(panels, (p) => p.claimAttemptId);
  const refuted = (claimAttemptId: string) => byClaim.get(claimAttemptId) === 'not_verified';
  const host = s.integrations.flatMap((i): HostVerification[] => {
    const claim = workOf(s, i.claimAttemptId);
    const validation = candidateValidation(s, claim);
    if (i.status.t !== 'integrated' || !validation || !validationPassed(validation)) return [];
    if (refuted(claim.id)) return [];
    const { questionId } = claim.spec;
    const { mergeSha } = i.status;
    return [{ t: 'host', questionId, claimAttemptId: claim.id, validationId: validation.id, mergeSha }];
  });
  const panelVerified = panels.flatMap((p): Verification[] =>
    p.verdict === 'verified' && !refuted(p.claimAttemptId)
      ? [{ t: 'panel', questionId: p.questionId, claimAttemptId: p.claimAttemptId, panelId: p.id }]
      : []
  );
  const byQuestion = latestSettled(panels, (p) => p.questionId);
  return {
    revision: s.revision,
    panels,
    host,
    verifications: [...panelVerified, ...host],
    verifiedQuestions: new Set([
      ...[...byQuestion].filter(([, verdict]) => verdict === 'verified').map(([q]) => q),
      ...host.map((h) => h.questionId),
    ]),
  };
}

export const panels = (s: State) => derive(s).panels;
export const hostVerifications = (s: State) => derive(s).host;
export const verifications = (s: State) => derive(s).verifications;
/** Distinct verified claims: the badge's and the page's "verified" count. */
export const verifiedClaims = (s: State) =>
  new Set(verifications(s).map((v) => v.claimAttemptId)).size;
export const questionVerified = (s: State, questionId: string) =>
  derive(s).verifiedQuestions.has(questionId);

/** The newest goal panel (absent: no goal check was ever asked). */
export const latestGoalPanel = (s: State): Panel | undefined =>
  panels(s)
    .filter((p) => p.goal)
    .at(-1);

/**
 * The validation of a claim's commit under its question's CURRENT acceptance revision (design.md
 * R11; absent: none planned). 2026-11-01 review: one validation per claim, kept whatever the
 * acceptance became, meant a claim first validated by a command that could not pass never integrated.
 */
export function candidateValidation(s: State, claim: Attempt<WorkSpec>): Validation | undefined {
  const { rev } = questionOf(s, claim.spec.questionId).acceptance;
  return s.validations
    .filter(
      (v) =>
        v.target.t === 'candidate' &&
        v.target.claimAttemptId === claim.id &&
        v.basis.t === 'acceptance' &&
        v.basis.rev === rev
    )
    .at(-1);
}

/** Where a manager turn starts (design.md R11): its own detached read-only tree, never the owner's
 * checkout (audit 2026-11-01 #6). A manager is briefed only once it is ready (plan.ts). */
export function managerDirectory(s: State): string {
  const tree = treeOf(s, MANAGER_TREE);
  if (tree.status.t !== 'ready')
    throw new Error(`expedition ${s.id} has no manager tree (${tree.status.t})`);
  return tree.place.path;
}

/** A question's acceptance rule (charter.ts Acceptance). */
export const acceptanceOf = (s: State, questionId: string) =>
  questionOf(s, questionId).acceptance.rule;

/** The roster seat an attempt runs on. */
export const configOf = (c: Charter, spec: AttemptSpec): WorkerConfig =>
  spec.kind === 'manager' ? c.crew.manager : c.crew[spec.kind][spec.seat];

/** Check seats independent of a claim's author: never the model that made the claim. */
export const independentCheckSeats = (c: Charter, author: WorkerConfig) =>
  c.crew.check
    .map((config, seat) => ({ config, seat }))
    .filter((x) => !sameModel(x.config, author));

// ---------- Dependencies and stages (design.md R5) ----------

/** The dependencies a queued work attempt waits for (not yet closed verified): it stays queued,
 * holding no slot or custody, never refused or run. */
export const waitsOn = (s: State, a: Attempt): string[] =>
  a.phase.t === 'planned' && a.spec.kind === 'work'
    ? questionOf(s, a.spec.questionId).after.filter((id) => questionOf(s, id).status !== 'verified')
    : [];

/** Where a question honestly stands: its furthest stage (waiting is held, never failed). */
type QuestionStage =
  | 'planned'
  | 'waiting'
  | 'implementing'
  | 'claimed'
  | 'checked'
  | 'validated'
  | 'integrated'
  | 'dead';

const workOn = (s: State, questionId: string): Attempt<WorkSpec>[] =>
  worksOf(s).filter((a) => a.spec.questionId === questionId);

/** Table-driven: the first stage (furthest first) whose test holds; `planned` when none does. */
const STAGES: [QuestionStage, (s: State, q: Question, ids: Set<string>) => boolean][] = [
  ['dead', (_s, q) => q.status === 'dead'],
  [
    'integrated',
    (s, _q, ids) =>
      s.integrations.some((i) => i.status.t === 'integrated' && ids.has(i.claimAttemptId)),
  ],
  [
    'validated',
    (s, _q, ids) =>
      s.validations.some(
        (v) => v.target.t === 'candidate' && ids.has(v.target.claimAttemptId) && validationPassed(v)
      ),
  ],
  ['checked', (s, q) => questionVerified(s, q.id)],
  ['claimed', (s, q) => workOn(s, q.id).some((a) => attemptClaim(a).t !== 'none')],
  ['implementing', (s, q) => workOn(s, q.id).some(running)],
  ['waiting', (s, q) => workOn(s, q.id).some((a) => waitsOn(s, a).length > 0)],
];

export function questionStage(s: State, q: Question): QuestionStage {
  const ids = new Set(workOn(s, q.id).map((a) => a.id));
  for (const [stage, holds] of STAGES) if (holds(s, q, ids)) return stage;
  return 'planned';
}
