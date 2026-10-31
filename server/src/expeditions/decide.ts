import type { ManagerAction } from './charter';
import type { Entry, Integration, State } from './ledger';
import {
  apply,
  byId,
  commandChecks,
  judgedChecks,
  startedOf,
  validationComplete,
  validationOf,
  validationPassed,
} from './ledger';
import { withStatus } from './news';
import {
  claimAt,
  configOf,
  deadlineMs,
  exploreAttempts,
  exploreCap,
  hostVerifications,
  independentCheckSeats,
  integrating,
  latestGoalPanel,
  managerCap,
  managerTurns,
  panels,
  questionVerified,
  settled,
  verifiedClaims,
  waitsOn,
  workerAttempts,
} from './queries';

// decide: state → intent entries (pure). The guardrails live here: every manager action is
// checked against the charter and the ledger, and a refused one becomes a `rejected` entry the
// next manager turn sees.

export interface Clock {
  now: string;
  /** Fresh ids, deterministic in tests. */
  nextId(prefix: string): string;
}

/**
 * Applies the newest manager result's actions under the guardrails, then the limit rules, then
 * "never idle": an open expedition always has live work, a manager turn, or a question for the owner.
 */
export function decide(s: State, clock: Clock): Entry[] {
  if (s.run.t === 'finished' || s.crew.t === 'pending') return [];
  const out: Entry[] = [];
  const at = clock.now;
  const push = (e: Entry) => {
    out.push(e);
    apply(s, e);
  };
  const setup = setupOf(s);
  switch (setup.t) {
    case 'waiting':
      return [];
    case 'failed':
      push({
        t: 'finished',
        at,
        reason: 'setup_failed',
        summary: `The integration worktree could not be made: ${setup.reason}`,
      });
      return withStatus(s, out, at);
    case 'ready':
      break;
  }

  if (s.unseen.some((e) => e.t === 'feedback' && e.feedback.t === 'stop')) {
    push({ t: 'finished', at, reason: 'owner_stop', summary: 'Stopped by the owner.' });
    return withStatus(s, out, at);
  }
  if (Date.parse(at) >= deadlineMs(s)) {
    push({ t: 'finished', at, reason: 'deadline', summary: 'Deadline reached.' });
    return withStatus(s, out, at);
  }

  const pending = pendingManager(s);
  if (pending) {
    for (const action of pending.actions) applyAction(s, action, clock, push);
    push({ t: 'manager_applied', at, attemptId: pending.attemptId });
  }
  planCandidateValidations(s, clock, push);
  closeHostVerified(s, push, at);
  settleDoneRequest(s, push, at);
  // Re-read through a call: applyAction mutates s.run, which TS's narrowing above cannot see.
  const now = runOf(s);
  if (now === 'finished' || now === 'paused') return withStatus(s, out, at);

  // Manager decisions are not budgeted attempts (design.md R9); they stop at their own cap.
  const managerLive = s.attempts.some((a) => a.spec.kind === 'manager' && a.phase.t !== 'ended');
  const neverPlanned = managerTurns(s) === 0;
  const decisionsLeft = managerTurns(s) < managerCap(s.charter);
  if (s.run.t === 'running' && !managerLive && decisionsLeft && (neverPlanned || managerDue(s)))
    push({ t: 'attempt_planned', at, attemptId: clock.nextId('m'), spec: { kind: 'manager' } });

  // Spent only once nothing can still run: an attempt planned (by this very decision too, a
  // manager included), admitted, queued behind maxLive or custody, or live keeps it open.
  const spent =
    workerAttempts(s) >= s.charter.maxAttempts
      ? { reason: 'attempts_spent' as const, what: `All ${s.charter.maxAttempts} attempts used` }
      : !decisionsLeft
        ? {
            reason: 'decisions_spent' as const,
            what: `All ${managerCap(s.charter)} manager decisions used`,
          }
        : null;
  if (spent && quiescent(s)) {
    push({
      t: 'finished',
      at,
      reason: spent.reason,
      summary: `${spent.what}; ${verifiedClaims(s)} claims verified.`,
    });
    return withStatus(s, out, at);
  }

  // Host validations and merges in flight are work too: their results reach the next manager.
  // Work waiting on unverified dependencies (design.md R5) cannot start by itself, so it does not
  // count as running: an expedition holding only waiting work asks, it never goes quiet.
  const waiting = s.attempts.filter((a) => waitsOn(s, a).length > 0);
  if (s.run.t === 'running' && quiescent(s))
    push({
      t: 'needs_owner',
      at,
      question: `Nothing is running and the manager planned no further work${
        waiting.length > 0
          ? ` (${waiting.map((a) => `${a.id} waits for ${waitsOn(s, a).join(', ')}`).join('; ')}, not verified)`
          : ''
      }. Reply with a lesson or note to continue, or stop it.`,
    });
  return withStatus(s, out, at);
}

const runOf = (s: State): State['run']['t'] => s.run.t;

/**
 * A manager turn is due when it has something to act on. While the host validates or merges, a
 * result that waits on it is not news yet: the manager could only say "awaiting validation"
 * (2026-11-01 smoke incident: turns wasted on exactly that). Owner feedback is always news.
 */
function managerDue(s: State): boolean {
  const hostHolds = s.doneRequest.t === 'validating' || integrating(s);
  const spent = workerAttempts(s) >= s.charter.maxAttempts;
  return s.unseen.some(
    (e) =>
      e.t === 'feedback' ||
      (!hostHolds && !claimAwaitingValidation(s, e) && !(spent && managerEcho(e)))
  );
}

/**
 * The manager's own echo: an action the guardrails refused, or a question it just added. Once the
 * budget is spent neither can lead to work, so neither wakes another manager. 2026-11-01 review:
 * a manager asking for work past the budget got "attempt budget spent", which was news, which
 * woke a manager, up to the decision cap (about 2N unmetered turns doing nothing).
 */
const managerEcho = (e: Entry) => e.t === 'rejected' || e.t === 'question_added';

/** An ended code claim whose candidate validation has not finished (charter command checks). */
function claimAwaitingValidation(s: State, e: Entry): boolean {
  if (e.t !== 'attempt_ended' || e.outcome.t !== 'work') return false;
  const result = e.outcome.result;
  if (result.result !== 'claim' || result.change.t !== 'commit') return false;
  if (commandChecks(s.charter).length === 0) return false;
  return !s.validations.some(
    (v) =>
      v.target.t === 'candidate' &&
      v.target.claimAttemptId === e.attemptId &&
      validationComplete(s, v)
  );
}

/** A host-verified claim (queries.ts Verification) closes its open question verified, which
 * unlocks the questions that wait on it (R5). The why names the host's proof. */
function closeHostVerified(s: State, push: (e: Entry) => void, at: string): void {
  for (const h of hostVerifications(s)) {
    if (byId(s.questions, h.questionId)?.status !== 'open') continue;
    push({
      t: 'question_closed',
      at,
      questionId: h.questionId,
      status: 'verified',
      why: `host-verified: ${h.claimAttemptId} passed every command check (validation ${h.validationId}) and merged into ${s.repo.branch} as ${h.mergeSha.slice(0, 10)}`,
    });
  }
}

/** A host validation or merge still to run or finish, or a done waiting on one. */
const hostBusy = (s: State) =>
  s.doneRequest.t === 'validating' ||
  s.validations.some((v) => !validationComplete(s, v)) ||
  integrating(s);

/** Nothing will run by itself any more: every attempt settled or waits on unverified
 * dependencies (R5), and no host validation or merge is in flight. */
const quiescent = (s: State) =>
  s.attempts.every((a) => settled(a) || waitsOn(s, a).length > 0) && !hostBusy(s);

/** Decide runs once the integration worktree exists (the expedition's branch is checked out in
 * it); a tree that could not be made finishes the expedition with the reason. */
type Setup = { t: 'waiting' } | { t: 'ready' } | { t: 'failed'; reason: string };
function setupOf(s: State): Setup {
  const tree = s.integrationTree.status;
  switch (tree.t) {
    case 'creating':
      return { t: 'waiting' };
    case 'failed':
      return { t: 'failed', reason: tree.reason };
    case 'ready':
    case 'kept':
    case 'removed':
    case 'absent':
    case 'left':
      return { t: 'ready' };
  }
}

/**
 * Why a claim may not be merged into the expedition branch (design.md R3), empty when it may: its
 * commit's candidate validation passed (when the charter has command checks), and its latest
 * check panel verified it (when one ran). With no command checks a verified panel is required:
 * nothing reaches the branch on a worker's word alone.
 */
function integrationBlockers(s: State, claimAttemptId: string): string[] {
  const hasCommands = commandChecks(s.charter).length > 0;
  const validation = s.validations.find(
    (v) => v.target.t === 'candidate' && v.target.claimAttemptId === claimAttemptId
  );
  const validationBlocker = !hasCommands
    ? []
    : !validation
      ? ['its commit has no candidate validation']
      : !validationComplete(s, validation)
        ? ['its candidate validation is still running']
        : !validationPassed(s, validation)
          ? ['its candidate validation did not pass']
          : [];
  const own = panels(s).filter((p) => p.claimAttemptId === claimAttemptId);
  const latest = own.at(-1);
  const panelBlocker = !latest
    ? hasCommands
      ? []
      : ['it needs a verified check panel (the charter has no command checks)']
    : latest.verdict === 'pending'
      ? ['a check panel on it is still running']
      : latest.verdict === 'not_verified'
        ? ['its latest check panel did not verify it']
        : [];
  return [...validationBlocker, ...panelBlocker];
}

/**
 * Every ended code claim's candidate commit is validated once by the host (design.md R2), as soon
 * as it ends: no agent runs or reports command checks. A charter without command checks has
 * nothing to run.
 */
function planCandidateValidations(s: State, clock: Clock, push: (e: Entry) => void): void {
  if (commandChecks(s.charter).length === 0) return;
  const validated = new Set(
    s.validations.flatMap((v) => (v.target.t === 'candidate' ? [v.target.claimAttemptId] : []))
  );
  for (const a of s.attempts) {
    if (a.phase.t !== 'ended' || a.phase.outcome.t !== 'work' || validated.has(a.id)) continue;
    const result = a.phase.outcome.result;
    if (result.result !== 'claim' || result.change.t !== 'commit') continue;
    push({
      t: 'validation_planned',
      at: clock.now,
      validationId: clock.nextId('v'),
      target: { t: 'candidate', claimAttemptId: a.id, sha: result.change.sha },
    });
  }
}

/**
 * Why done cannot finish now beyond the head validation, when judged items exist: the latest goal
 * panel verified a claim, and that claim's commit is merged into the expedition branch. A goal
 * panel checks the claim's own candidate tree, so a verified goal claim that was never integrated
 * (or whose merge was refused) would leave the owner a branch without the verified work.
 */
function judgedBlocker(s: State, merge: GoalMerge): string[] {
  if (judgedChecks(s.charter).length === 0) return [];
  const goal = latestGoalPanel(s);
  if (goal?.verdict !== 'verified')
    return ['done needs the latest goal check to be verified (the charter has judged items)'];
  return goalClaimBlocker(s, goal.claimAttemptId, merge);
}

/** `merged`: the goal claim's merge has landed. `queued`: it is planned or landed — enough to
 * start a head validation, which runs only after every planned merge (effects.ts); the done then
 * settles against `merged`, so a refused merge still refuses it. */
type GoalMerge = 'merged' | 'queued';
const MERGE_OK: Record<GoalMerge, ReadonlySet<Integration['status']['t']>> = {
  merged: new Set(['integrated']),
  queued: new Set(['integrated', 'pending']),
};

function goalClaimBlocker(s: State, claimAttemptId: string, merge: GoalMerge): string[] {
  const { change } = claimAt(s, claimAttemptId);
  switch (change.t) {
    case 'no_code':
      return [];
    case 'commit':
      return s.integrations.some(
        (i) => i.claimAttemptId === claimAttemptId && MERGE_OK[merge].has(i.status.t)
      )
        ? []
        : [
            `the goal claim ${claimAttemptId} is not integrated into ${s.repo.branch}: integrate it before done`,
          ];
  }
}

/** A done waiting on its head validation finishes once every command check passed there. */
function settleDoneRequest(s: State, push: (e: Entry) => void, at: string): void {
  if (s.doneRequest.t !== 'validating' || s.run.t === 'finished') return;
  const v = validationOf(s, s.doneRequest.validationId);
  if (!validationComplete(s, v)) return;
  const sha = startedOf(s, v.id).targetSha;
  const failed = v.runs
    .filter((r) => r.outcome.t !== 'passed')
    .map((r) => `command check ${r.checkIndex} ${r.outcome.t} on the head ${sha}`);
  const blockers = [...failed, ...judgedBlocker(s, 'merged')];
  if (blockers.length > 0) {
    push({ t: 'done_refused', at, reason: blockers.join('; ') });
    return;
  }
  push({ t: 'finished', at, reason: 'done', summary: s.doneRequest.summary });
}

/** The newest ended manager attempt whose actions are not yet applied (absent: none pending). */
function pendingManager(s: State): { attemptId: string; actions: ManagerAction[] } | undefined {
  const last = s.attempts.filter((a) => a.spec.kind === 'manager').at(-1);
  if (!last || last.phase.t !== 'ended' || last.phase.outcome.t !== 'manager') return undefined;
  if (s.appliedManagers.has(last.id)) return undefined;
  return { attemptId: last.id, actions: last.phase.outcome.actions };
}

function applyAction(
  s: State,
  action: ManagerAction,
  clock: Clock,
  push: (e: Entry) => void
): undefined {
  const at = clock.now;
  // Returns `undefined` so a guard reads `return reject(...)` (lint forbids returning a void call).
  const reject = (reason: string): undefined => {
    push({ t: 'rejected', at, action, reason });
    return undefined;
  };
  switch (action.do) {
    case 'add_question': {
      const unknown = action.after.filter((q) => !byId(s.questions, q));
      if (unknown.length > 0) return reject(`after names no question ${unknown.join(', ')}`);
      push({
        t: 'question_added',
        at,
        questionId: clock.nextId('q'),
        title: action.title,
        detail: action.detail,
        scope: action.scope,
        paths: action.paths,
        after: action.after,
      });
      return;
    }
    case 'work': {
      const question = byId(s.questions, action.question);
      if (!question) return reject(`no question ${action.question}`);
      if (question.status !== 'open')
        return reject(`question ${question.id} is ${question.status}`);
      if (question.scope === 'parked') return reject('parked questions need owner funding');
      if (question.scope === 'explore' && exploreAttempts(s) >= exploreCap(s.charter))
        return reject(`explore share spent (${exploreCap(s.charter)} attempts)`);
      if (workerAttempts(s) >= s.charter.maxAttempts) return reject('attempt budget spent');
      if (action.seat >= s.charter.crew.work.length)
        return reject(`no work seat ${action.seat} (0..${s.charter.crew.work.length - 1})`);
      push({
        t: 'attempt_planned',
        at,
        attemptId: clock.nextId('w'),
        spec: { kind: 'work', questionId: question.id, brief: action.brief, seat: action.seat },
      });
      return;
    }
    case 'check': {
      const claim = byId(s.attempts, action.claimAttempt);
      if (!claim || claim.spec.kind !== 'work')
        return reject(`no work attempt ${action.claimAttempt}`);
      if (claim.phase.t !== 'ended' || claim.phase.outcome.t !== 'work')
        return reject('that attempt has no parsed result');
      if (claim.phase.outcome.result.result !== 'claim') return reject('only claims are checked');
      if (workerAttempts(s) + action.panel > s.charter.maxAttempts)
        return reject('attempt budget spent');
      // Independence: a check never runs on the model that made the claim.
      const seats = independentCheckSeats(s.charter, configOf(s.charter, claim.spec));
      if (seats.length === 0) return reject('every check seat uses the claim author model');
      const panelId = clock.nextId('p');
      for (let n = 0; n < action.panel; n += 1)
        push({
          t: 'attempt_planned',
          at,
          attemptId: clock.nextId('c'),
          spec: {
            kind: 'check',
            questionId: claim.spec.questionId,
            claimAttemptId: claim.id,
            goal: action.goal,
            panelId,
            seat: seats[n % seats.length].seat,
          },
        });
      return;
    }
    case 'integrate': {
      const claim = byId(s.attempts, action.claimAttempt);
      if (!claim || claim.spec.kind !== 'work')
        return reject(`no work attempt ${action.claimAttempt}`);
      if (
        claim.phase.t !== 'ended' ||
        claim.phase.outcome.t !== 'work' ||
        claim.phase.outcome.result.result !== 'claim' ||
        claim.phase.outcome.result.change.t !== 'commit'
      )
        return reject('only a claim with a commit is integrated');
      // The head a done validates stays fixed until that done settles.
      if (s.doneRequest.t === 'validating')
        return reject('done is being validated on the current head');
      if (s.integrations.some((i) => i.claimAttemptId === claim.id && i.status.t !== 'refused'))
        return reject(`${claim.id} is already integrated or being integrated`);
      const blockers = integrationBlockers(s, claim.id);
      if (blockers.length > 0) return reject(blockers.join('; '));
      push({
        t: 'integration_planned',
        at,
        integrationId: clock.nextId('i'),
        claimAttemptId: claim.id,
        sha: claim.phase.outcome.result.change.sha,
      });
      return;
    }
    case 'close_question': {
      const question = byId(s.questions, action.question);
      if (!question) return reject(`no question ${action.question}`);
      if (action.status === 'verified' && !questionVerified(s, question.id))
        return reject(
          'a question closes verified only after a check panel verified it, or its claim passed every command check and was integrated'
        );
      push({
        t: 'question_closed',
        at,
        questionId: question.id,
        status: action.status,
        why: action.why,
      });
      return;
    }
    case 'ask_owner':
      push({ t: 'needs_owner', at, question: action.question });
      return;
    case 'done': {
      if ('ownerJudgment' in s.charter.done) {
        push({ t: 'needs_owner', at, question: `Proposes done: ${action.summary}` });
        return;
      }
      // The guardrails (design.md R2): the goal panel verified the judged items, and every
      // command check passed on the expedition branch head, run by the host, never an agent.
      if (s.doneRequest.t === 'validating') return reject('done is already being validated');
      const hasCommands = commandChecks(s.charter).length > 0;
      const judged = judgedBlocker(s, hasCommands ? 'queued' : 'merged');
      if (judged.length > 0) return reject(judged.join('; '));
      if (!hasCommands) {
        // Nothing validates the head, so done never finishes over a merge still to run.
        if (integrating(s)) return reject('an integration is still running');
        push({ t: 'finished', at, reason: 'done', summary: action.summary });
        return;
      }
      // The head validation starts only after every merge planned before it (effects.ts), and no
      // merge is accepted while it runs, so it validates the head the owner is told to merge.
      const validationId = clock.nextId('v');
      push({ t: 'validation_planned', at, validationId, target: { t: 'head' } });
      push({ t: 'done_requested', at, validationId, summary: action.summary });
      return;
    }
    case 'note':
      push({ t: 'reflection', at, text: action.text });
      return;
  }
}
