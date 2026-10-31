import { type Charter, type WorkerConfig, sameModel } from './charter';
import type { Attempt, AttemptSpec, CheckSpec, State } from './ledger';
import { byId, questionOf } from './ledger';

// Pure read-only views over a folded State, shared by decide, effects, briefs, news and the page.

export const live = (s: State) =>
  s.attempts.filter((a) => a.phase.t === 'posted' || a.phase.t === 'posting');
export const liveWorkers = (s: State) => live(s).filter((a) => a.spec.kind !== 'manager');
export const queued = (s: State) => s.attempts.filter((a) => a.phase.t === 'planned');
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

/**
 * Worker attempts holding a live slot and their custody: posted or posting, or still planned with
 * a worktree already made for them (admitted, about to be briefed).
 */
export const admitted = (s: State) =>
  s.attempts.filter(
    (a) =>
      a.spec.kind !== 'manager' &&
      (a.phase.t === 'posted' || a.phase.t === 'posting' || a.id in s.worktrees) &&
      a.phase.t !== 'ended'
  );

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
    const ended = members.every((m) => m.phase.t === 'ended');
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
