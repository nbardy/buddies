import type {
  ExpeditionAttemptCost,
  ExpeditionAttemptPhase,
  ExpeditionCharterView,
  ExpeditionDone,
  ExpeditionIntegration,
  ExpeditionValidation,
  ExpeditionView,
  ExpeditionWorktree,
} from '@unleashd/shared';
import {
  type AttemptPhase,
  type Charter,
  type State,
  type Validation,
  attemptTitle,
  attemptsOn,
  checkOutcomeLabel,
  configOf,
  costLabel,
  costTotals,
  deadlineMs,
  exploreCap,
  headOf,
  integrationLabel,
  live,
  liveWorkers,
  managerCap,
  managerTurns,
  outcomeParts,
  panels,
  questionOf,
  questionStage,
  queued,
  seatLabel,
  validationComplete,
  validationLabel,
  validationPassed,
  verifications,
  verifiedClaims,
  workerAttempts,
} from './model';

// The expedition modal's data: one pure projection of the folded ledger (no I/O), served by
// GET /api/buddies/expeditions/:id. The modal shows a few of these at a time; nothing here is
// derived twice. `charterView` is shared with drafts (drafts.ts), so both render one Charter tab.

export function charterView(c: Charter): ExpeditionCharterView {
  return {
    name: c.name,
    goal: c.goal,
    done: doneView(c.done),
    inScope: c.inScope,
    outOfScope: c.outOfScope,
    roster: {
      manager: seatLabel(c.crew.manager),
      work: c.crew.work.map(seatLabel),
      check: c.crew.check.map(seatLabel),
    },
    limits: {
      maxAttempts: c.maxAttempts,
      maxLive: c.maxLive,
      hours: c.hours,
      exploreShare: c.exploreShare,
    },
  };
}

export function expeditionView(s: State, badgeLine: string, now: string): ExpeditionView {
  const c = s.charter;
  return {
    id: s.id,
    badge: badgeLine,
    run: s.run,
    charter: charterView(c),
    validations: s.validations.map(validationView),
    integration: integrationView(s),
    cost: costTotals(s),
    workspaceId: s.workspaceId,
    launchedAt: s.launchedAt,
    deadline: new Date(deadlineMs(s)).toISOString(),
    now,
    crew:
      s.crew.t === 'ready'
        ? { t: 'ready' as const, buddyId: s.crew.buddyId, chatChannelId: s.crew.chatChannelId }
        : { t: 'pending' as const },
    counts: countsOf(s),
    questions: s.questions.map((q) => ({
      ...q,
      // By title: the owner reads them (the manager's `after` names only questions it added).
      after: q.after.map((id) => ({ id, title: questionOf(s, id).title })),
      stage: questionStage(s, q),
      attempts: attemptsOn(s, q.id).map((a) => a.id),
    })),
    attempts: s.attempts.map((a) => ({
      id: a.id,
      kind: a.spec.kind,
      label: attemptTitle(s, a),
      ask: a.spec.kind === 'work' ? a.spec.brief : null,
      seat: seatLabel(configOf(c, a.spec)),
      questionId: a.spec.kind === 'manager' ? null : a.spec.questionId,
      phase: phaseView(a.phase),
      live: live(s).some((x) => x.id === a.id),
      brief: s.briefs[a.id] ?? null,
      requestId: a.phase.t === 'posted' || a.phase.t === 'ended' ? a.phase.requestId : null,
      worktree: worktreeView(s, a.id),
      cost: attemptCost(s, a.id, a.phase),
    })),
    panels: panels(s),
    verifications: verifications(s),
    reflections: s.reflections,
    lessons: s.lessons,
  };
}

function doneView(done: Charter['done']): ExpeditionDone {
  return 'checks' in done ? { t: 'checks', checks: done.checks } : { t: 'owner' };
}

/** An ended attempt's metered cost; `settling` until the host read it (meter.ts). */
function attemptCost(s: State, attemptId: string, phase: AttemptPhase): ExpeditionAttemptCost {
  const cost = s.costs[attemptId];
  if (cost) return cost.t === 'measured' ? { t: 'measured', label: costLabel(cost) } : cost;
  return phase.t === 'ended' ? { t: 'settling' } : { t: 'none' };
}

/** An attempt's worktree, once admission recorded one (managers never have one). */
function worktreeView(s: State, attemptId: string): ExpeditionWorktree {
  const tree = s.worktrees[attemptId];
  return tree ? { t: 'tree', branch: tree.branch, path: tree.path } : { t: 'none' };
}

function integrationView(s: State): ExpeditionIntegration {
  const refused = s.integrations.filter((i) => i.status.t === 'refused').at(-1);
  return {
    branch: s.repo.branch,
    head: headOf(s),
    integrated: s.integrations.filter((i) => i.status.t === 'integrated').length,
    queued: s.integrations.filter((i) => i.status.t === 'pending').length,
    lastRefusal: refused ? { t: 'refused', label: integrationLabel(s, refused) } : { t: 'none' },
  };
}

function validationView(v: Validation): ExpeditionValidation {
  return {
    id: v.id,
    subject:
      v.target.t === 'candidate'
        ? { t: 'candidate', claimAttemptId: v.target.claimAttemptId }
        : { t: 'head' },
    label: validationLabel(v),
    verdict: !validationComplete(v) ? 'running' : validationPassed(v) ? 'passed' : 'failed',
    checks: v.runs.map((r) => ({
      checkIndex: r.checkIndex,
      passed: r.outcome.t === 'passed',
      outcome: checkOutcomeLabel(r.outcome),
    })),
  };
}

/** The page's phase: an ended attempt carries its one-line result, a dropped one its reason. */
function phaseView(phase: AttemptPhase): ExpeditionAttemptPhase {
  switch (phase.t) {
    case 'ended':
      return { t: 'ended', ...outcomeParts(phase.outcome) };
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
export function countsOf(s: State): ExpeditionView['counts'] {
  const c = s.charter;
  return {
    attempts: workerAttempts(s),
    maxAttempts: c.maxAttempts,
    decisions: managerTurns(s),
    maxDecisions: managerCap(c),
    live: liveWorkers(s).length,
    maxLive: c.maxLive,
    queued: queued(s).length,
    verified: verifiedClaims(s),
    exploreCap: exploreCap(c),
  };
}
