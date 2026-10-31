import type { ExpeditionDone, ExpeditionValidation, ExpeditionView } from '@unleashd/shared';
import {
  type AttemptPhase,
  type State,
  type Validation,
  attemptLabel,
  attemptsOn,
  checkOutcomeLabel,
  configOf,
  deadlineMs,
  exploreCap,
  live,
  liveWorkers,
  outcomeLabel,
  panels,
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
    })),
    panels: panels(s),
    reflections: s.reflections,
    lessons: s.lessons,
  };
}

function doneView(done: State['charter']['done']): ExpeditionDone {
  return 'checks' in done ? { t: 'checks', checks: done.checks } : { t: 'owner' };
}

function validationView(s: State, v: Validation): ExpeditionValidation {
  return {
    id: v.id,
    label: validationLabel(s, v),
    verdict: !validationComplete(s, v) ? 'running' : validationPassed(s, v) ? 'passed' : 'failed',
    checks: v.runs.map((r) => ({
      checkIndex: r.checkIndex,
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
