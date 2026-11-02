import type {
  ExpeditionAttempt,
  ExpeditionAttemptCost,
  ExpeditionAttemptPhase,
  ExpeditionAttemptRole,
  ExpeditionBriefing,
  ExpeditionCharterView,
  ExpeditionIntegration,
  ExpeditionSummary,
  ExpeditionValidation,
  ExpeditionView,
  ExpeditionWorktree,
} from '@unleashd/shared';
import {
  type Attempt,
  type AttemptPhase,
  type AttemptSpec,
  type Charter,
  type State,
  type Validation,
  type WorkerConfig,
  allAttempts,
  attemptTitle,
  attemptsOn,
  checkOutcomeLabel,
  configOf,
  costLabel,
  costShort,
  costTotals,
  deadlineMs,
  exploreCap,
  goalSummary,
  headOf,
  integrationHeadline,
  live,
  liveWorkers,
  managerCap,
  managerTurns,
  outcomeParts,
  panels,
  questionOf,
  questionStage,
  queued,
  treeKey,
  validationComplete,
  validationHeadline,
  validationPassed,
  verifications,
  verifiedClaims,
  workerAttempts,
  worktreeOf,
} from './model';

// The expedition modal's data: one pure projection of the folded ledger (no I/O), served by
// GET /api/buddies/expeditions/:id. The modal shows a few of these at a time; nothing here is
// derived twice. `charterView` is shared with drafts (drafts.ts), so both render one Charter tab.

/** A seat as the owner reads it: provider and model, `default model` when the charter named
 * none (the provider picks it at run time), and the effort when set. 2026-11-01 visual pass: a
 * card read only "claude". */
const seatName = (w: WorkerConfig) =>
  [w.provider, modelWord(w.model), w.reasoningEffort].filter(Boolean).join(' · ');

function modelWord(m: WorkerConfig['model']): string {
  switch (m.t) {
    case 'default':
      return 'default model';
    case 'named':
      return m.id;
  }
}

export function charterView(c: Charter): ExpeditionCharterView {
  return {
    name: c.name,
    goal: c.goal,
    goalLine: goalSummary(c.goal),
    done: c.done,
    inScope: c.inScope,
    outOfScope: c.outOfScope,
    roster: {
      manager: seatName(c.crew.manager),
      work: c.crew.work.map(seatName),
      check: c.crew.check.map(seatName),
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
  const counts = countsOf(s);
  const cost = costTotals(s);
  return {
    id: s.id,
    badge: badgeLine,
    run: s.run,
    charter: charterView(c),
    validations: s.validations.map((v) => validationView(s, v)),
    integration: integrationView(s),
    cost,
    line: summaryLine(counts, cost),
    workspaceId: s.workspaceId,
    launchedAt: s.launchedAt,
    deadline: new Date(deadlineMs(s)).toISOString(),
    now,
    crew:
      s.crew.t === 'ready'
        ? { t: 'ready' as const, buddyId: s.crew.buddyId, chatChannelId: s.crew.chatChannelId }
        : { t: 'pending' as const },
    retirement: s.retirement,
    counts,
    questions: s.questions.map((q) => ({
      ...q,
      // By title: the owner reads them (the manager's `after` names only questions it added).
      after: q.after.map((id) => ({ id, title: questionOf(s, id).title })),
      stage: questionStage(s, q),
      attempts: attemptsOn(s, q.id).map((a) => a.id),
    })),
    attempts: allAttempts(s).map((a) => attemptView(s, a)),
    panels: panels(s),
    verifications: verifications(s),
    reflections: s.reflections,
    lessons: s.lessons,
  };
}

/** One row of the expedition list; a retired expedition's snapshot keeps it (retired.ts). */
export function expeditionSummary(s: State): ExpeditionSummary {
  const counts = countsOf(s);
  const cost = costTotals(s);
  return {
    id: s.id,
    name: s.charter.name,
    run: s.run,
    workspaceId: s.workspaceId,
    launchedAt: s.launchedAt,
    counts,
    cost,
    line: summaryLine(counts, cost),
    retirement: s.retirement,
  };
}

/** The list's one progress line (the header's counts, shorter). */
export const summaryLine = (counts: ExpeditionView['counts'], cost: ExpeditionView['cost']) =>
  `${counts.liveWorkers} live · ${counts.verified} verified · ${counts.attempts}/${counts.maxAttempts} attempts · ${cost.short}`;

function attemptView(s: State, a: Attempt): ExpeditionAttempt {
  return {
    ...roleView(a.spec),
    id: a.id,
    label: attemptTitle(s, a),
    seat: seatName(configOf(s.charter, a.spec)),
    phase: phaseView(a.phase),
    live: live(s).some((x) => x.id === a.id),
    briefing: briefingView(s, a),
    worktree: worktreeView(s, a.id),
    cost: attemptCost(s, a.id, a.phase),
  };
}

function roleView(spec: AttemptSpec): ExpeditionAttemptRole {
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
function briefingView(s: State, a: Attempt): ExpeditionBriefing {
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
function attemptCost(s: State, attemptId: string, phase: AttemptPhase): ExpeditionAttemptCost {
  const cost = s.costs[attemptId];
  if (cost)
    return cost.t === 'measured'
      ? { t: 'measured', label: costShort(cost), detail: costLabel(cost) }
      : cost;
  return phase.t === 'ended' ? { t: 'settling' } : { t: 'none' };
}

/** An attempt's worktree, once admission recorded one (managers never have one). */
function worktreeView(s: State, attemptId: string): ExpeditionWorktree {
  if (!(treeKey({ t: 'attempt', attemptId }) in s.trees)) return { t: 'none' };
  const tree = worktreeOf(s, attemptId);
  return { t: 'tree', branch: tree.branch, path: tree.path };
}

function integrationView(s: State): ExpeditionIntegration {
  const refused = s.integrations.filter((i) => i.status.t === 'refused').at(-1);
  return {
    branch: s.repo.branch,
    head: headOf(s),
    integrated: s.integrations.filter((i) => i.status.t === 'integrated').length,
    queued: s.integrations.filter((i) => i.status.t === 'pending').length,
    lastRefusal: refused ? { t: 'refused', label: integrationHeadline(s, refused) } : { t: 'none' },
  };
}

function validationView(s: State, v: Validation): ExpeditionValidation {
  return {
    id: v.id,
    subject:
      v.target.t === 'candidate'
        ? { t: 'candidate', claimAttemptId: v.target.claimAttemptId }
        : { t: 'head' },
    label: validationHeadline(s, v),
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
    running: live(s).length,
    liveWorkers: liveWorkers(s).length,
    maxLive: c.maxLive,
    queued: queued(s).length,
    verified: verifiedClaims(s),
    exploreCap: exploreCap(c),
  };
}
