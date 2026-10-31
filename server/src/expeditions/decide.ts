import type { ManagerAction } from './charter';
import type { Entry, State } from './ledger';
import {
  apply,
  byId,
  commandChecks,
  judgedChecks,
  startedOf,
  validationComplete,
  validationOf,
} from './ledger';
import { withStatus } from './news';
import {
  configOf,
  deadlineMs,
  exploreAttempts,
  exploreCap,
  goalVerified,
  independentCheckSeats,
  live,
  questionVerified,
  verifiedPanels,
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
  settleDoneRequest(s, push, at);
  // Re-read through a call: applyAction mutates s.run, which TS's narrowing above cannot see.
  const now = runOf(s);
  if (now === 'finished' || now === 'paused') return withStatus(s, out, at);

  if (s.attempts.length >= s.charter.maxAttempts && live(s).length === 0 && !validating(s)) {
    push({
      t: 'finished',
      at,
      reason: 'attempts_spent',
      summary: `All ${s.charter.maxAttempts} attempts used; ${verifiedPanels(s).length} claims verified.`,
    });
    return withStatus(s, out, at);
  }

  const managerLive = s.attempts.some((a) => a.spec.kind === 'manager' && a.phase.t !== 'ended');
  const neverPlanned = !s.attempts.some((a) => a.spec.kind === 'manager');
  const budgetLeft = s.attempts.length < s.charter.maxAttempts;
  if (s.run.t === 'running' && !managerLive && budgetLeft && (neverPlanned || s.unseen.length > 0))
    push({ t: 'attempt_planned', at, attemptId: clock.nextId('m'), spec: { kind: 'manager' } });

  // Host validations in flight are work too: their results reach the next manager.
  const idle =
    s.run.t === 'running' && s.attempts.every((a) => a.phase.t === 'ended') && !validating(s);
  if (idle)
    push({
      t: 'needs_owner',
      at,
      question:
        'Nothing is running and the manager planned no further work. Reply with a lesson or note to continue, or stop it.',
    });
  return withStatus(s, out, at);
}

const runOf = (s: State): State['run']['t'] => s.run.t;

/** A host validation still to run or finish, or a done waiting on one. */
const validating = (s: State) =>
  s.doneRequest.t === 'validating' || s.validations.some((v) => !validationComplete(s, v));

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

/** Why done cannot finish now beyond the head validation: the goal panel, when judged items exist. */
const judgedBlocker = (s: State): string[] =>
  judgedChecks(s.charter).length > 0 && !goalVerified(s)
    ? ['done needs the latest goal check to be verified (the charter has judged items)']
    : [];

/** A done waiting on its head validation finishes once every command check passed there. */
function settleDoneRequest(s: State, push: (e: Entry) => void, at: string): void {
  if (s.doneRequest.t !== 'validating' || s.run.t === 'finished') return;
  const v = validationOf(s, s.doneRequest.validationId);
  if (!validationComplete(s, v)) return;
  const sha = startedOf(s, v.id).targetSha;
  const failed = v.runs
    .filter((r) => r.outcome.t !== 'passed')
    .map((r) => `command check ${r.checkIndex} ${r.outcome.t} on the head ${sha}`);
  const blockers = [...failed, ...judgedBlocker(s)];
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
    case 'add_question':
      push({
        t: 'question_added',
        at,
        questionId: clock.nextId('q'),
        title: action.title,
        detail: action.detail,
        scope: action.scope,
        paths: action.paths,
      });
      return;
    case 'work': {
      const question = byId(s.questions, action.question);
      if (!question) return reject(`no question ${action.question}`);
      if (question.status !== 'open')
        return reject(`question ${question.id} is ${question.status}`);
      if (question.scope === 'parked') return reject('parked questions need owner funding');
      if (question.scope === 'explore' && exploreAttempts(s) >= exploreCap(s.charter))
        return reject(`explore share spent (${exploreCap(s.charter)} attempts)`);
      if (s.attempts.length >= s.charter.maxAttempts) return reject('attempt budget spent');
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
      if (s.attempts.length + action.panel > s.charter.maxAttempts)
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
    case 'close_question': {
      const question = byId(s.questions, action.question);
      if (!question) return reject(`no question ${action.question}`);
      if (action.status === 'verified' && !questionVerified(s, question.id))
        return reject('a question closes verified only after a check verified it');
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
      const judged = judgedBlocker(s);
      if (judged.length > 0) return reject(judged.join('; '));
      if (commandChecks(s.charter).length === 0) {
        push({ t: 'finished', at, reason: 'done', summary: action.summary });
        return;
      }
      // TODO(R3): integration moves the head; a passed head validation then still names the sha
      // it ran on, and done must refuse when the head moved since.
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
