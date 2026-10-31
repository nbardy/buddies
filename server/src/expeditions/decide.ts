import type { ManagerAction } from './charter';
import type { Entry, State } from './ledger';
import { apply, byId } from './ledger';
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
  // Re-read through a call: applyAction mutates s.run, which TS's narrowing above cannot see.
  const now = runOf(s);
  if (now === 'finished' || now === 'paused') return withStatus(s, out, at);

  if (s.attempts.length >= s.charter.maxAttempts && live(s).length === 0) {
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

  const idle = s.run.t === 'running' && s.attempts.every((a) => a.phase.t === 'ended');
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
    case 'done':
      if ('ownerJudgment' in s.charter.done) {
        push({ t: 'needs_owner', at, question: `Proposes done: ${action.summary}` });
        return;
      }
      // The guardrail: done only after an independent goal check verified it.
      if (!goalVerified(s)) return reject('done needs the latest goal check to be verified');
      push({ t: 'finished', at, reason: 'done', summary: action.summary });
      return;
    case 'note':
      push({ t: 'reflection', at, text: action.text });
      return;
  }
}
