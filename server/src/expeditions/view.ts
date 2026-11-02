import type * as W from '@unleashd/shared';
import * as m from './model';

// The expedition modal's data: one pure projection of the folded ledger (no I/O), served by
// GET /api/buddies/expeditions/:id. `charterView` is shared with drafts (one Charter tab).

/** A seat as the owner reads it: provider, model (`default model` when the provider picks it),
 * effort. 2026-11-01 visual pass: a card read only "claude". */
const seatName = (w: m.WorkerConfig) =>
  [w.provider, w.model.t === 'named' ? w.model.id : 'default model', w.reasoningEffort]
    .filter(Boolean)
    .join(' · ');

export function charterView(c: m.Charter): W.ExpeditionCharterView {
  const { name, goal, done, inScope, outOfScope, maxAttempts, maxLive, hours, exploreShare } = c;
  return {
    name,
    goal,
    goalLine: m.goalSummary(goal),
    done,
    inScope,
    outOfScope,
    roster: {
      manager: seatName(c.crew.manager),
      work: c.crew.work.map(seatName),
      check: c.crew.check.map(seatName),
    },
    limits: { maxAttempts, maxLive, hours, exploreShare },
  };
}

export function expeditionView(s: m.State, badgeLine: string, now: string): W.ExpeditionView {
  const { crew } = s;
  const { name: _name, ...summary } = expeditionSummary(s);
  return {
    ...summary,
    badge: badgeLine,
    charter: charterView(s.charter),
    validations: s.validations.map((v) => validationView(s, v)),
    integration: integrationView(s),
    deadline: new Date(m.deadlineMs(s)).toISOString(),
    now,
    crew:
      crew.t === 'ready'
        ? { t: 'ready', buddyId: crew.buddyId, chatChannelId: crew.chatChannelId }
        : { t: 'pending' },
    questions: s.questions.map((q) => ({
      ...q,
      // By title: the owner reads them (the manager's `after` names only questions it added).
      after: q.after.map((id) => ({ id, title: m.questionOf(s, id).title })),
      stage: m.questionStage(s, q),
      attempts: m.attemptsOn(s, q.id).map((a) => a.id),
    })),
    attempts: m.allAttempts(s).map((a) => attemptView(s, a)),
    panels: m.panels(s),
    verifications: m.verifications(s),
    reflections: s.reflections,
    lessons: s.lessons,
  };
}

/** One row of the expedition list; a retired expedition's snapshot keeps it (retired.ts). */
export function expeditionSummary(s: m.State): W.ExpeditionSummary {
  const counts = countsOf(s);
  const cost = m.costTotals(s);
  const { id, run, workspaceId, launchedAt, retirement } = s;
  const line = summaryLine(counts, cost);
  return { id, name: s.charter.name, run, workspaceId, launchedAt, counts, cost, line, retirement };
}

/** The list's one progress line (the header's counts, shorter). */
export const summaryLine = (counts: W.ExpeditionView['counts'], cost: W.ExpeditionView['cost']) =>
  `${counts.liveWorkers} live · ${counts.verified} verified · ${counts.attempts}/${counts.maxAttempts} attempts · ${cost.short}`;

function attemptView(s: m.State, a: m.Attempt): W.ExpeditionAttempt {
  return {
    ...roleView(a.spec),
    id: a.id,
    label: m.attemptTitle(s, a),
    seat: seatName(m.configOf(s.charter, a.spec)),
    phase: phaseView(a.phase),
    live: m.live(s).some((x) => x.id === a.id),
    briefing: briefingView(s, a),
    worktree: worktreeView(s, a.id),
    cost: attemptCost(s, a.id, a.phase),
  };
}

function roleView(spec: m.AttemptSpec): W.ExpeditionAttemptRole {
  switch (spec.kind) {
    case 'manager':
      return { kind: 'manager' };
    case 'work':
      return { kind: 'work', questionId: spec.questionId, ask: spec.brief };
    case 'check':
      return { kind: 'check', questionId: spec.questionId, goal: spec.goal };
  }
}

/** Its instructions follow its phase: recorded at `posting`, posted from then on. */
function briefingView(s: m.State, a: m.Attempt): W.ExpeditionBriefing {
  switch (a.phase.t) {
    case 'planned':
    case 'admitted':
    case 'dropped':
      return { t: 'unbriefed' };
    case 'posting':
      return { t: 'briefed', brief: s.briefs[a.id] };
    case 'posted':
    case 'ended':
      return { t: 'posted', brief: s.briefs[a.id], requestId: a.phase.requestId };
  }
}

/** An ended attempt's metered cost; `settling` until the host read it (meter.ts). */
function attemptCost(s: m.State, id: string, phase: m.AttemptPhase): W.ExpeditionAttemptCost {
  const cost = s.costs[id];
  if (!cost) return phase.t === 'ended' ? { t: 'settling' } : { t: 'none' };
  return cost.t === 'measured'
    ? { t: 'measured', label: m.costShort(cost), detail: m.costLabel(cost) }
    : cost;
}

/** An attempt's worktree, once admission recorded one (managers never have one). */
function worktreeView(s: m.State, attemptId: string): W.ExpeditionWorktree {
  if (!(m.treeKey({ t: 'attempt', attemptId }) in s.trees)) return { t: 'none' };
  const { branch, path } = m.worktreeOf(s, attemptId);
  return { t: 'tree', branch, path };
}

function integrationView(s: m.State): W.ExpeditionIntegration {
  const count = (t: m.Integration['status']['t']) =>
    s.integrations.filter((i) => i.status.t === t).length;
  const refused = s.integrations.filter((i) => i.status.t === 'refused').at(-1);
  return {
    branch: s.repo.branch,
    head: m.headOf(s),
    integrated: count('integrated'),
    queued: count('pending'),
    lastRefusal: refused
      ? { t: 'refused', label: m.integrationHeadline(s, refused) }
      : { t: 'none' },
  };
}

function validationView(s: m.State, v: m.Validation): W.ExpeditionValidation {
  const { target } = v;
  return {
    id: v.id,
    subject:
      target.t === 'candidate'
        ? { t: 'candidate', claimAttemptId: target.claimAttemptId }
        : { t: 'head' },
    label: m.validationHeadline(s, v),
    verdict: !m.validationComplete(v) ? 'running' : m.validationPassed(v) ? 'passed' : 'failed',
    checks: v.runs.map((r) => ({
      checkIndex: r.checkIndex,
      passed: r.outcome.t === 'passed',
      outcome: m.checkOutcomeLabel(r.outcome),
    })),
  };
}

/** The page's phase: an ended attempt carries its one-line result, a dropped one its reason. */
function phaseView(phase: m.AttemptPhase): W.ExpeditionAttemptPhase {
  switch (phase.t) {
    case 'ended':
      return { t: 'ended', ...m.outcomeParts(phase.outcome) };
    case 'dropped':
      return { t: 'dropped', reason: phase.reason };
    case 'planned':
    case 'admitted':
    case 'posting':
    case 'posted':
      return { t: phase.t };
  }
}

/** The header's and the expedition list's counts (budget, decisions, live, verified). */
function countsOf(s: m.State): W.ExpeditionView['counts'] {
  const c = s.charter;
  return {
    attempts: m.workerAttempts(s),
    maxAttempts: c.maxAttempts,
    decisions: m.managerTurns(s),
    maxDecisions: m.managerCap(c),
    running: m.live(s).length,
    liveWorkers: m.liveWorkers(s).length,
    maxLive: c.maxLive,
    queued: m.queued(s).length,
    verified: m.verifiedClaims(s),
    exploreCap: m.exploreCap(c),
  };
}
