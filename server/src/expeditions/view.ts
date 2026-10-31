import type {
  ExpeditionAttemptCost,
  ExpeditionDone,
  ExpeditionIntegration,
  ExpeditionValidation,
  ExpeditionView,
  ExpeditionWorktree,
} from '@unleashd/shared';
import {
  type AttemptPhase,
  type State,
  type Validation,
  attemptLabel,
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
  outcomeLabel,
  panels,
  questionStage,
  queued,
  seatLabel,
  validationComplete,
  validationLabel,
  validationPassed,
  verifiedPanels,
} from './model';

// The expedition page's data: one pure projection of the folded ledger (no I/O), served by
// GET /api/expeditions/:id. The page shows a few of these at a time; nothing here is derived twice.

export function expeditionView(s: State, badgeLine: string, now: string): ExpeditionView {
  const c = s.charter;
  return {
    id: s.id,
    name: c.name,
    badge: badgeLine,
    run: s.run,
    goal: c.goal,
    done: doneView(c.done),
    validations: s.validations.map((v) => validationView(s, v)),
    integration: integrationView(s),
    cost: costTotals(s),
    inScope: c.inScope,
    outOfScope: c.outOfScope,
    workspaceId: s.workspaceId,
    launchedAt: s.launchedAt,
    deadline: new Date(deadlineMs(s)).toISOString(),
    now,
    crew:
      s.crew.t === 'ready'
        ? { t: 'ready' as const, buddyId: s.crew.buddyId, chatChannelId: s.crew.chatChannelId }
        : { t: 'pending' as const },
    roster: {
      manager: seatLabel(c.crew.manager),
      work: c.crew.work.map(seatLabel),
      check: c.crew.check.map(seatLabel),
    },
    counts: {
      attempts: s.attempts.length,
      maxAttempts: c.maxAttempts,
      live: liveWorkers(s).length,
      maxLive: c.maxLive,
      queued: queued(s).length,
      verified: verifiedPanels(s).length,
      exploreCap: exploreCap(c),
    },
    questions: s.questions.map((q) => ({
      ...q,
      stage: questionStage(s, q),
      attempts: attemptsOn(s, q.id).map((a) => a.id),
    })),
    attempts: s.attempts.map((a) => ({
      id: a.id,
      kind: a.spec.kind,
      label: attemptLabel(s, a),
      seat: seatLabel(configOf(c, a.spec)),
      questionId: a.spec.kind === 'manager' ? null : a.spec.questionId,
      phase: a.phase.t,
      live: live(s).some((x) => x.id === a.id),
      brief: s.briefs[a.id] ?? null,
      outcome: phaseOutcome(a.phase),
      requestId: a.phase.t === 'posted' || a.phase.t === 'ended' ? a.phase.requestId : null,
      worktree: worktreeView(s, a.id),
      cost: attemptCost(s, a.id, a.phase),
    })),
    panels: panels(s),
    reflections: s.reflections,
    lessons: s.lessons,
  };
}

function doneView(done: State['charter']['done']): ExpeditionDone {
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

function validationView(s: State, v: Validation): ExpeditionValidation {
  return {
    id: v.id,
    subject:
      v.target.t === 'candidate'
        ? { t: 'candidate', claimAttemptId: v.target.claimAttemptId }
        : { t: 'head' },
    label: validationLabel(s, v),
    verdict: !validationComplete(s, v) ? 'running' : validationPassed(s, v) ? 'passed' : 'failed',
    checks: v.runs.map((r) => ({
      checkIndex: r.checkIndex,
      passed: r.outcome.t === 'passed',
      outcome: checkOutcomeLabel(r.outcome),
    })),
  };
}

/** The page's one-line result: an ended attempt's outcome, a dropped one's reason. */
function phaseOutcome(phase: AttemptPhase): string | null {
  switch (phase.t) {
    case 'ended':
      return outcomeLabel(phase.outcome);
    case 'dropped':
      return `not started: ${phase.reason}`;
    case 'planned':
    case 'admitted':
    case 'posting':
    case 'posted':
      return null;
  }
}
