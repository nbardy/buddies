import type { ManagerAction } from './charter';
import type { Attempt, Entry, Integration, State, TreeStatus, WorkSpec } from './ledger';
import {
  INTEGRATION_TREE,
  MANAGER_TREE,
  allAttempts,
  apply,
  byId,
  doneValidationChecks,
  judgedChecks,
  treeKey,
  treeOf,
  validationComplete,
  validationOf,
  validationPassed,
  worksOf,
} from './ledger';
import {
  type Panel,
  acceptanceOf,
  attemptClaim,
  candidateValidation,
  claimAt,
  configOf,
  deadlineMs,
  exploreAttempts,
  exploreCap,
  hostVerifications,
  independentCheckSeats,
  integrating,
  interrupted,
  latestGoalPanel,
  managerCap,
  managerOpen,
  managerTurns,
  panels,
  questionVerified,
  settled,
  verifiedClaims,
  waitsOn,
  workerAttempts,
} from './queries';
import { withStatus } from './render';

// decide: state → intent entries (pure). The guardrails live here: every manager action is
// checked against the charter and the ledger; a refused one is a `rejected` entry the next
// manager turn sees.

export interface Clock {
  now: string;
  /** Fresh ids, deterministic in tests. */
  nextId(prefix: string): string;
}
type Push = (e: Entry) => void;

/** The newest manager result's actions under the guardrails, then the limits, then "never idle":
 * an open expedition always has live work, a manager turn, or a question for the owner. */
export function decide(s: State, clock: Clock): Entry[] {
  if (s.run.t === 'finished' || s.crew.t === 'pending') return [];
  const out: Entry[] = [];
  const at = clock.now;
  const push: Push = (e) => {
    out.push(e);
    apply(s, e);
  };
  const finish = (reason: Extract<Entry, { t: 'finished' }>['reason'], summary: string) => {
    push({ t: 'finished', at, reason, summary });
    return withStatus(s, out, at);
  };
  // The owner's stop and the deadline come first: neither may wait on a tree still being made or
  // an observation that keeps failing (audit 2026-11-01 #1, the wedge).
  if (s.unseen.some((e) => e.t === 'feedback' && e.feedback.t === 'stop'))
    return finish('owner_stop', 'Stopped by the owner.');
  if (Date.parse(at) >= deadlineMs(s)) return finish('deadline', 'Deadline reached.');
  const setup = setupOf(s);
  if (setup.t === 'waiting') return [];
  if (setup.t === 'failed') return finish('setup_failed', setup.reason);

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

  if (s.run.t === 'running') retryInterrupted(s, clock, push);

  // Manager decisions are not budgeted attempts (design.md R9); they stop at their own cap.
  const cap = managerCap(s.charter);
  const decisionsLeft = managerTurns(s) < cap;
  const managerFree = s.run.t === 'running' && !managerOpen(s) && decisionsLeft;
  if (managerFree && (managerTurns(s) === 0 || managerDue(s)))
    push({ t: 'attempt_planned', at, attemptId: clock.nextId('m'), spec: { kind: 'manager' } });

  // Spent only once nothing can still run (an attempt planned by this very decision included).
  const verified = `${verifiedClaims(s)} claims verified.`;
  if (quiescent(s) && workerAttempts(s) >= s.charter.maxAttempts)
    return finish('attempts_spent', `All ${s.charter.maxAttempts} attempts used; ${verified}`);
  if (quiescent(s) && !decisionsLeft)
    return finish('decisions_spent', `All ${cap} manager decisions used; ${verified}`);

  // Work waiting on unverified dependencies (design.md R5) cannot start by itself: an expedition
  // holding only waiting work asks, it never goes quiet.
  const waiting = s.workers.filter((a) => waitsOn(s, a).length > 0);
  const waits = waiting.map((a) => `${a.id} waits for ${waitsOn(s, a).join(', ')}`).join('; ');
  const why = waiting.length > 0 ? ` (${waits}, not verified)` : '';
  const question = `Nothing is running and the manager planned no further work${why}. Reply with a lesson or note to continue, or stop it.`;
  if (s.run.t === 'running' && quiescent(s)) push({ t: 'needs_owner', at, question });
  return withStatus(s, out, at);
}

const runOf = (s: State): State['run']['t'] => s.run.t;

/** A work or check attempt a server restart interrupted is planned again, once, same spec, new id
 * (a manager's unseen end makes managerDue plan one). Regression: owner 2026-11-03. */
const ID_PREFIX = { work: 'w', check: 'c' } as const;
function retryInterrupted(s: State, clock: Clock, push: Push): void {
  for (const a of s.workers)
    if (interrupted(a) && !(a.id in s.retries)) {
      const attemptId = clock.nextId(ID_PREFIX[a.spec.kind]);
      push({ t: 'attempt_retry_planned', at: clock.now, attemptId, retryOf: a.id, spec: a.spec });
    }
}

/** A manager turn is due on news: not a result waiting on a host validation or merge (2026-11-01
 * smoke: turns wasted "awaiting validation"), nor, once the budget is spent, its own echo (2026-11-01
 * review: rejections woke managers up to the decision cap). Owner feedback is always news. */
function managerDue(s: State): boolean {
  const hostHolds = s.doneRequest.t === 'validating' || integrating(s);
  const spent = workerAttempts(s) >= s.charter.maxAttempts;
  const echo = (e: Entry) =>
    e.t === 'rejected' || e.t === 'question_added' || e.t === 'acceptance_set';
  return s.unseen.some(
    (e) =>
      e.t === 'feedback' || (!hostHolds && !claimAwaitingValidation(s, e) && !(spent && echo(e)))
  );
}

/** A code claim (ended, or adopted) whose question is accepted by a command and whose candidate
 * validation has not finished. A manager or check end is never one. */
function claimAwaitingValidation(s: State, e: Entry): boolean {
  if (e.t !== 'attempt_ended' && e.t !== 'claim_adopted') return false;
  const attempt = byId(worksOf(s), e.attemptId);
  if (attempt === undefined || attemptClaim(attempt).t !== 'commit') return false;
  if (acceptanceOf(s, attempt.spec.questionId).t !== 'command') return false;
  const validation = candidateValidation(s, attempt);
  return !validation || !validationComplete(validation);
}

/** A host-verified claim closes its open question verified, unlocking those that wait on it (R5).
 * The why is in owner words (2026-11-02 visual pass: the raw-id line was the last in the chat). */
function closeHostVerified(s: State, push: Push, at: string): void {
  for (const h of hostVerifications(s)) {
    if (byId(s.questions, h.questionId)?.status !== 'open') continue;
    const why = `host-verified: its claim passed every command check and merged into ${s.repo.branch} as \`${h.mergeSha.slice(0, 7)}\``;
    push({ t: 'question_closed', at, questionId: h.questionId, status: 'verified', why });
  }
}

/** Nothing will run by itself any more: every attempt settled or waits on unverified dependencies
 * (R5), and no host validation, merge or claim adoption is in flight, nor a done waiting on one. */
const quiescent = (s: State) =>
  allAttempts(s).every((a) => settled(a) || waitsOn(s, a).length > 0) &&
  s.doneRequest.t !== 'validating' &&
  s.validations.every(validationComplete) &&
  !integrating(s) &&
  Object.values(s.adoptions).every((a) => a.t !== 'pending');

/** Decide runs once the integration tree and then the manager's own tree (R11) exist; a tree
 * that could not be made finishes the expedition with the reason. */
type Setup = { t: 'waiting' } | { t: 'ready' } | { t: 'failed'; reason: string };
function setupOf(s: State): Setup {
  const integration = treeSetup(treeOf(s, INTEGRATION_TREE).status, 'integration');
  if (integration.t !== 'ready') return integration;
  if (!(treeKey(MANAGER_TREE) in s.trees)) return { t: 'waiting' };
  return treeSetup(treeOf(s, MANAGER_TREE).status, "manager's");
}
function treeSetup(status: TreeStatus, which: string): Setup {
  if (status.t === 'failed')
    return { t: 'failed', reason: `The ${which} worktree could not be made: ${status.reason}` };
  return status.t === 'creating' ? { t: 'waiting' } : { t: 'ready' };
}

/** Why a claim may not be merged (design.md R3, R11), empty when it may: only its question's
 * CURRENT acceptance decides, never a worker's word alone. */
function integrationBlockers(s: State, claim: Attempt<WorkSpec>): string[] {
  const questionId = claim.spec.questionId;
  const latest = panels(s)
    .filter((p) => p.claimAttemptId === claim.id)
    .at(-1);
  const rule = acceptanceOf(s, questionId);
  if (rule.t === 'panel')
    return latest
      ? PANEL_BLOCKER[latest.verdict]
      : [`it needs a verified check panel (question ${questionId} is accepted by a panel)`];
  const validation = candidateValidation(s, claim);
  const command = !validation
    ? [
        `its commit has no candidate validation under the current acceptance of ${questionId} ($ ${rule.argv.join(' ')})`,
      ]
    : !validationComplete(validation)
      ? ['its candidate validation is still running']
      : validationPassed(validation)
        ? []
        : ['its candidate validation did not pass'];
  const refuted = latest?.verdict === 'not_verified' ? ['its latest check panel refuted it'] : [];
  return [...command, ...refuted, ...(latest?.verdict === 'pending' ? PANEL_BLOCKER.pending : [])];
}
const PANEL_BLOCKER: Record<Panel['verdict'], string[]> = {
  verified: [],
  pending: ['a check panel on it is still running'],
  not_verified: ['its latest check panel did not verify it'],
};

/** Every unmerged code claim on a command-accepted question is validated by the host on its
 * immutable commit, once per acceptance revision (design.md R2, R11); no agent runs or reports it. */
function planCandidateValidations(s: State, clock: Clock, push: Push): void {
  for (const a of worksOf(s)) {
    const claimed = attemptClaim(a);
    const rule = acceptanceOf(s, a.spec.questionId);
    if (claimed.t !== 'commit' || rule.t !== 'command' || candidateValidation(s, a)) continue;
    if (s.integrations.some((i) => i.claimAttemptId === a.id && i.status.t !== 'refused')) continue;
    const validationId = clock.nextId('v');
    const target = { t: 'candidate', claimAttemptId: a.id, sha: claimed.sha } as const;
    const checks = [{ index: 0, argv: rule.argv, timeoutSeconds: rule.timeoutSeconds }];
    push({ t: 'validation_planned', at: clock.now, validationId, target, checks });
  }
}

/** `merged`: the goal claim's merge has landed. `queued`: planned or landed, enough to start a
 * head validation (it runs after every planned merge); the done then settles against `merged`. */
type GoalMerge = 'merged' | 'queued';
const MERGE_OK: Record<GoalMerge, ReadonlySet<Integration['status']['t']>> = {
  merged: new Set(['integrated']),
  queued: new Set(['integrated', 'pending']),
};

/** With judged items, done needs the latest goal panel verified and its claim merged: an unmerged
 * verified claim would leave the owner a branch without the verified work. */
function judgedBlocker(s: State, merge: GoalMerge): string[] {
  if (judgedChecks(s.charter).length === 0) return [];
  const goal = latestGoalPanel(s);
  if (goal?.verdict !== 'verified')
    return ['done needs the latest goal check to be verified (the charter has judged items)'];
  const id = goal.claimAttemptId;
  const merged = s.integrations.some(
    (i) => i.claimAttemptId === id && MERGE_OK[merge].has(i.status.t)
  );
  return claimAt(s, id).change.t === 'no_code' || merged
    ? []
    : [`the goal claim ${id} is not integrated into ${s.repo.branch}: integrate it before done`];
}

/** A done waiting on its head validation finishes once every command check passed there. */
function settleDoneRequest(s: State, push: Push, at: string): void {
  if (s.doneRequest.t !== 'validating' || s.run.t === 'finished') return;
  const v = validationOf(s, s.doneRequest.validationId);
  if (!validationComplete(v)) return;
  const failed = v.runs
    .filter((r) => r.outcome.t !== 'passed')
    .map((r) => `command check ${r.checkIndex} ${r.outcome.t} on the head ${r.report.targetSha}`);
  const unrun = v.failure.t === 'failed' ? [`the checks could not run: ${v.failure.reason}`] : [];
  const blockers = [...unrun, ...failed, ...judgedBlocker(s, 'merged')];
  push(
    blockers.length > 0
      ? { t: 'done_refused', at, reason: blockers.join('; ') }
      : { t: 'finished', at, reason: 'done', summary: s.doneRequest.summary }
  );
}

/** The newest ended manager attempt whose actions are not yet applied (absent: none pending). */
function pendingManager(s: State): { attemptId: string; actions: ManagerAction[] } | undefined {
  const last = s.managers.at(-1);
  if (!last || last.phase.t !== 'ended' || last.phase.outcome.t !== 'manager') return undefined;
  if (s.appliedManagers.has(last.id)) return undefined;
  return { attemptId: last.id, actions: last.phase.outcome.actions };
}

/** What the guardrails make of one manager action: the entries it writes, or why it is refused. */
type Decision = { t: 'accept'; entries: Entry[] } | { t: 'reject'; reason: string };
const accept = (...entries: Entry[]): Decision => ({ t: 'accept', entries });
const reject = (reason: string): Decision => ({ t: 'reject', reason });

type Do = ManagerAction['do'];
type Handler<K extends Do> = (s: State, a: Extract<ManagerAction, { do: K }>, c: Clock) => Decision;

/** δ: one handler per manager action, then one write path for its decision. Entries are pushed
 * only after the handler decided, so a handler reads the state its action met. */
function applyAction(s: State, action: ManagerAction, clock: Clock, push: Push) {
  // TS cannot correlate ACTIONS[action.do] with action's own variant.
  const decision = (ACTIONS[action.do] as Handler<Do>)(s, action, clock);
  if (decision.t === 'reject')
    push({ t: 'rejected', at: clock.now, action, reason: decision.reason });
  else for (const e of decision.entries) push(e);
}

/** Why an action cannot use this question, or none when it is open. */
function closedQuestion(s: State, id: string): string | undefined {
  const question = byId(s.questions, id);
  if (!question) return `no question ${id}`;
  return question.status === 'open' ? undefined : `question ${question.id} is ${question.status}`;
}

// Pattern: table-driven (docs/patterns.md#table-driven) — one exhaustive handler per action.
const ACTIONS: { [K in Do]: Handler<K> } = {
  add_question: (s, action, clock) => {
    const unknown = action.after.filter((q) => !byId(s.questions, q));
    if (unknown.length > 0) return reject(`after names no question ${unknown.join(', ')}`);
    const { title, detail, scope, paths, after, acceptance } = action;
    const added = { questionId: clock.nextId('q'), title, detail, scope, paths, after, acceptance };
    return accept({ t: 'question_added', at: clock.now, ...added });
  },

  set_acceptance: (s, action, clock) => {
    const refused = closedQuestion(s, action.question);
    if (refused) return reject(refused);
    const { question: questionId, acceptance } = action;
    return accept({ t: 'acceptance_set', at: clock.now, questionId, acceptance });
  },

  claim: (s, action, clock) => {
    const attempt = byId(worksOf(s), action.attempt);
    if (!attempt) return reject(`no work attempt ${action.attempt}`);
    // Claimable: the host records every end that left unclaimed commits (observe.ts ended).
    if (attempt.phase.t !== 'ended' || attempt.phase.outcome.t !== 'unreported_commits')
      return reject(
        `only a work attempt that ended with unreported commits is claimed; ${attempt.id} is ${attempt.phase.t === 'ended' ? attempt.phase.outcome.t : attempt.phase.t}`
      );
    const prior = s.adoptions[attempt.id];
    if (prior && prior.t !== 'refused')
      return reject(`${attempt.id} is already claimed (${prior.t})`);
    const { statement, sha, evidence, howToCheck } = action.claim;
    const claim = {
      result: 'claim',
      statement,
      change: { t: 'commit', sha },
      evidence,
      howToCheck,
    } as const;
    return accept({ t: 'claim_planned', at: clock.now, attemptId: attempt.id, claim });
  },

  work: (s, action, clock) => {
    const refused = closedQuestion(s, action.question);
    if (refused) return reject(refused);
    const question = byId(s.questions, action.question)!;
    if (question.scope === 'parked') return reject('parked questions need owner funding');
    if (question.scope === 'explore' && exploreAttempts(s) >= exploreCap(s.charter))
      return reject(`explore share spent (${exploreCap(s.charter)} attempts)`);
    if (workerAttempts(s) >= s.charter.maxAttempts) return reject('attempt budget spent');
    if (action.seat >= s.charter.crew.work.length)
      return reject(`no work seat ${action.seat} (0..${s.charter.crew.work.length - 1})`);
    const { brief, seat } = action;
    const spec = { kind: 'work', questionId: question.id, brief, seat } as const;
    return accept({ t: 'attempt_planned', at: clock.now, attemptId: clock.nextId('w'), spec });
  },

  check: (s, action, clock) => {
    const claim = byId(worksOf(s), action.claimAttempt);
    if (!claim) return reject(`no work attempt ${action.claimAttempt}`);
    if (attemptClaim(claim).t === 'none')
      return reject('only claims are checked: that attempt ended with no parsed claim');
    if (workerAttempts(s) + action.panel > s.charter.maxAttempts)
      return reject('attempt budget spent');
    // Independence: a check never runs on the model that made the claim.
    const seats = independentCheckSeats(s.charter, configOf(s.charter, claim.spec));
    if (seats.length === 0) return reject('every check seat uses the claim author model');
    const panelId = clock.nextId('p');
    const { questionId } = claim.spec;
    return accept(
      ...Array.from(
        { length: action.panel },
        (_, n): Entry => ({
          t: 'attempt_planned',
          at: clock.now,
          attemptId: clock.nextId('c'),
          spec: {
            kind: 'check',
            questionId,
            claimAttemptId: claim.id,
            goal: action.goal,
            panelId,
            seat: seats[n % seats.length].seat,
          },
        })
      )
    );
  },

  integrate: (s, action, clock) => {
    const claim = byId(worksOf(s), action.claimAttempt);
    if (!claim) return reject(`no work attempt ${action.claimAttempt}`);
    const claimed = attemptClaim(claim);
    if (claimed.t !== 'commit') return reject('only a claim with a commit is integrated');
    // The head a done validates stays fixed until that done settles.
    if (s.doneRequest.t === 'validating')
      return reject('done is being validated on the current head');
    if (s.integrations.some((i) => i.claimAttemptId === claim.id && i.status.t !== 'refused'))
      return reject(`${claim.id} is already integrated or being integrated`);
    const blockers = integrationBlockers(s, claim);
    if (blockers.length > 0) return reject(blockers.join('; '));
    const [integrationId, claimAttemptId, { sha }] = [clock.nextId('i'), claim.id, claimed];
    return accept({ t: 'integration_planned', at: clock.now, integrationId, claimAttemptId, sha });
  },

  close_question: (s, action, clock) => {
    const question = byId(s.questions, action.question);
    if (!question) return reject(`no question ${action.question}`);
    if (action.status === 'verified' && !questionVerified(s, question.id))
      return reject(
        'a question closes verified only after a check panel verified it, or its claim passed every command check and was integrated'
      );
    const { status, why } = action;
    return accept({ t: 'question_closed', at: clock.now, questionId: question.id, status, why });
  },

  ask_owner: (_s, action, clock) =>
    accept({ t: 'needs_owner', at: clock.now, question: action.question }),

  // δ over how the charter decides completion: the owner judges it, or the typed checks do.
  done: (s, action, clock) => DONE_BY[s.charter.done.t](s, action.summary, clock),

  note: (_s, action, clock) => accept({ t: 'reflection', at: clock.now, text: action.text }),
};

type DoneBy = (s: State, summary: string, clock: Clock) => Decision;
const DONE_BY: Record<State['charter']['done']['t'], DoneBy> = {
  owner: (_s, summary, clock) =>
    accept({ t: 'needs_owner', at: clock.now, question: `Proposes done: ${summary}` }),
  checks: doneByChecks,
};

/** The guardrails (design.md R2): the goal panel verified the judged items, and every command
 * check passed on the expedition branch head, run by the host, never an agent. */
function doneByChecks(s: State, summary: string, clock: Clock): Decision {
  const at = clock.now;
  if (s.doneRequest.t === 'validating') return reject('done is already being validated');
  const checks = doneValidationChecks(s.charter);
  const hasCommands = checks.length > 0;
  const judged = judgedBlocker(s, hasCommands ? 'queued' : 'merged');
  if (judged.length > 0) return reject(judged.join('; '));
  if (!hasCommands)
    // Nothing validates the head, so done never finishes over a merge still to run.
    return integrating(s)
      ? reject('an integration is still running')
      : accept({ t: 'finished', at, reason: 'done', summary });
  // The head validation starts only after every merge planned before it (plan.ts), and no merge
  // is accepted while it runs, so it validates the head the owner is told to merge.
  const validationId = clock.nextId('v');
  return accept(
    { t: 'validation_planned', at, validationId, target: { t: 'head' }, checks },
    { t: 'done_requested', at, validationId, summary }
  );
}
