import { type Charter, type Claim, type WorkerConfig, sameModel } from './charter';
import type { Attempt, AttemptSpec, CheckSpec, Question, State, WorkSpec } from './ledger';
import { attemptOf, byId, questionOf, validationPassed } from './ledger';

// Pure read-only views over a folded State, shared by decide, effects, briefs, news and the page.

export const live = (s: State) =>
  s.attempts.filter((a) => a.phase.t === 'posted' || a.phase.t === 'posting');
export const liveWorkers = (s: State) => live(s).filter((a) => a.spec.kind !== 'manager');
/** A merge into the expedition branch is planned and not yet run (design.md R3). */
export const integrating = (s: State) => s.integrations.some((i) => i.status.t === 'pending');
export const queued = (s: State) => s.attempts.filter((a) => a.phase.t === 'planned');
/** Settled: nothing will run for it any more (it ended, or was dropped before it started). */
export const settled = (a: Attempt) => a.phase.t === 'ended' || a.phase.t === 'dropped';
export const exploreAttempts = (s: State) =>
  s.attempts.filter(
    (a) => a.spec.kind === 'work' && byId(s.questions, a.spec.questionId)?.scope === 'explore'
  ).length;
export const exploreCap = (c: Charter) => Math.floor(c.exploreShare * c.maxAttempts);
export const deadlineMs = (s: State) => Date.parse(s.launchedAt) + s.charter.hours * 3_600_000;

/** Two custody prefixes overlap when one contains the other (`.` is the whole repository). */
const prefixOverlap = (a: string, b: string) =>
  a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export const custodyOverlaps = (a: readonly string[], b: readonly string[]) =>
  a.some((x) => b.some((y) => prefixOverlap(x, y)));

/** A worker attempt's file custody: its question's paths for work, nothing for a check. */
export function custodyOf(s: State, a: Attempt): readonly string[] {
  switch (a.spec.kind) {
    case 'work':
      return questionOf(s, a.spec.questionId).paths;
    case 'manager':
    case 'check':
      return [];
  }
}

/** The attempts that run in a worktree of their own (design.md R1): every one but a manager. */
export type WorkerSpec = WorkSpec | CheckSpec;
export const isWorker = (a: Attempt): a is Attempt<WorkerSpec> => a.spec.kind !== 'manager';

/** Worker attempts holding a live slot and their custody: admitted (worktree intent recorded,
 * about to be briefed), posting or posted. */
export const admitted = (s: State) =>
  s.attempts
    .filter(isWorker)
    .filter((a) => a.phase.t === 'admitted' || a.phase.t === 'posting' || a.phase.t === 'posted');

/** The claim an attempt ended with; checks and integrations are planned only for ended claims
 * (decide.ts), so a missing one is a corrupt ledger. */
export function claimAt(s: State, attemptId: string): Claim {
  const claim = attemptOf(s, attemptId);
  if (
    claim.phase.t !== 'ended' ||
    claim.phase.outcome.t !== 'work' ||
    claim.phase.outcome.result.result !== 'claim'
  )
    throw new Error(`attempt ${attemptId} has no claim`);
  return claim.phase.outcome.result;
}
/** The claim a check verifies. */
export const claimOf = (s: State, spec: CheckSpec): Claim => claimAt(s, spec.claimAttemptId);

/** The work and check attempts on one question (managers belong to no question). */
export const attemptsOn = (s: State, questionId: string) =>
  s.attempts.filter((a) => a.spec.kind !== 'manager' && a.spec.questionId === questionId);

const checks = (s: State): Attempt<CheckSpec>[] =>
  s.attempts.filter((a): a is Attempt<CheckSpec> => a.spec.kind === 'check');

export interface Panel {
  id: string;
  questionId: string;
  claimAttemptId: string;
  goal: boolean;
  verdict: 'pending' | 'verified' | 'not_verified';
}

/** A panel is verified when a strict majority of its checks verified the claim. */
export function panels(s: State): Panel[] {
  const out = new Map<string, Attempt<CheckSpec>[]>();
  for (const c of checks(s)) out.set(c.spec.panelId, [...(out.get(c.spec.panelId) ?? []), c]);
  return [...out.entries()].map(([id, members]) => {
    const first = members[0].spec;
    // A dropped check (its worktree could not be made) settles the panel without a vote.
    const ended = members.every(settled);
    const yes = members.filter(
      (m) =>
        m.phase.t === 'ended' &&
        m.phase.outcome.t === 'check' &&
        m.phase.outcome.result.verdict === 'verified'
    ).length;
    return {
      id,
      questionId: first.questionId,
      claimAttemptId: first.claimAttemptId,
      goal: first.goal,
      verdict: !ended ? 'pending' : yes * 2 > members.length ? 'verified' : 'not_verified',
    };
  });
}
export const verifiedPanels = (s: State) => panels(s).filter((p) => p.verdict === 'verified');

export const goalVerified = (s: State) =>
  panels(s)
    .filter((p) => p.goal)
    .at(-1)?.verdict === 'verified';
export const questionVerified = (s: State, questionId: string) =>
  verifiedPanels(s).some((p) => p.questionId === questionId);

/** The roster seat an attempt runs on. */
export function configOf(c: Charter, spec: AttemptSpec): WorkerConfig {
  switch (spec.kind) {
    case 'manager':
      return c.crew.manager;
    case 'work':
      return c.crew.work[spec.seat];
    case 'check':
      return c.crew.check[spec.seat];
  }
}

/** Check seats independent of a claim's author: never the model that made the claim. */
export const independentCheckSeats = (c: Charter, author: WorkerConfig) =>
  c.crew.check
    .map((config, seat) => ({ config, seat }))
    .filter((x) => !sameModel(x.config, author));

// ---------- Dependencies and stages (design.md R5) ----------

/** A question's dependencies not yet closed verified. */
export const unmetDeps = (s: State, q: Question): string[] =>
  q.after.filter((id) => questionOf(s, id).status !== 'verified');

/** The dependencies a queued attempt waits for: a work attempt on a question whose dependencies
 * are not all verified stays queued (holding no slot or custody), never refused or run. */
export function waitsOn(s: State, a: Attempt): string[] {
  if (a.phase.t !== 'planned') return [];
  switch (a.spec.kind) {
    case 'work':
      return unmetDeps(s, questionOf(s, a.spec.questionId));
    case 'manager':
    case 'check':
      return [];
  }
}

/** Where a question honestly stands: its furthest stage (waiting is held, never failed). */
export type QuestionStage =
  | 'planned'
  | 'waiting'
  | 'implementing'
  | 'claimed'
  | 'checked'
  | 'validated'
  | 'integrated'
  | 'dead';

const workOn = (s: State, questionId: string): Attempt<WorkSpec>[] =>
  s.attempts.filter(
    (a): a is Attempt<WorkSpec> => a.spec.kind === 'work' && a.spec.questionId === questionId
  );
const hasClaim = (a: Attempt) =>
  a.phase.t === 'ended' &&
  a.phase.outcome.t === 'work' &&
  a.phase.outcome.result.result === 'claim';
const running = (a: Attempt) =>
  a.phase.t === 'admitted' || a.phase.t === 'posting' || a.phase.t === 'posted';

/** Pattern: table-driven — the first stage (furthest first) whose test holds; `planned` when
 * none does (the question has no work, or its work is queued for a slot or its custody). */
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
        (v) =>
          v.target.t === 'candidate' && ids.has(v.target.claimAttemptId) && validationPassed(s, v)
      ),
  ],
  ['checked', (s, q) => questionVerified(s, q.id)],
  ['claimed', (s, q) => workOn(s, q.id).some(hasClaim)],
  ['implementing', (s, q) => workOn(s, q.id).some(running)],
  ['waiting', (s, q) => workOn(s, q.id).some((a) => waitsOn(s, a).length > 0)],
];

export function questionStage(s: State, q: Question): QuestionStage {
  const ids = new Set(workOn(s, q.id).map((a) => a.id));
  for (const [stage, holds] of STAGES) if (holds(s, q, ids)) return stage;
  return 'planned';
}
