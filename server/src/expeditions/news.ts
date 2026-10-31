import { type ClaimChange, type DoneCheck, type WorkResult, seatLabel } from './charter';
import type {
  Attempt,
  CheckOutcome,
  Entry,
  Outcome,
  State,
  Validation,
  ValidationPhase,
} from './ledger';
import {
  apply,
  attemptOf,
  commandChecks,
  questionOf,
  validationComplete,
  validationOf,
  validationPassed,
} from './ledger';
import { configOf, liveWorkers, verifiedPanels } from './queries';

// Every human-readable rendering of expedition state: the badge line, the chat news posted once
// per decision round, attempt/outcome labels for the page, and full outcome text for briefs.

function runLabel(run: State['run']): string {
  switch (run.t) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'waiting_owner':
      return 'needs you';
    case 'finished':
      return `finished (${run.reason})`;
  }
}

export function badge(s: State, now: string): string {
  const mins = Math.round((Date.parse(now) - Date.parse(s.launchedAt)) / 60_000);
  const elapsed = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`;
  return `⛺ ${s.charter.name} · ${runLabel(s.run)} · ${liveWorkers(s).length} live · ${verifiedPanels(s).length} verified · ${s.attempts.length}/${s.charter.maxAttempts} attempts · ${elapsed}`;
}

/** One chat post per decision round: everything notable since the last post, in order. */
export function withStatus(s: State, out: Entry[], at: string): Entry[] {
  const lines = s.news.flatMap((e) => newsLine(s, e));
  if (lines.length === 0) return out;
  const status: Entry = {
    t: 'status',
    at,
    seq: s.statuses.length,
    // The badge line lives on the page header and the launch badge; chat posts carry only news.
    text: lines.join('\n'),
  };
  apply(s, status);
  return [...out, status];
}

const clip = (text: string, n = 300) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** The chat line for one notable entry (none for an uninteresting one). */
function newsLine(s: State, e: Entry): string[] {
  switch (e.t) {
    case 'attempt_posted': {
      const a = attemptOf(s, e.attemptId);
      return a.spec.kind === 'manager' ? [] : [`▶ ${a.id} started: ${attemptLabel(s, a)}`];
    }
    case 'attempt_ended': {
      const a = attemptOf(s, e.attemptId);
      return [`${a.id} ${outcomeLabel(e.outcome)}`];
    }
    case 'question_added':
      return [`+ question ${e.questionId} [${e.scope}]: ${e.title}`];
    case 'question_closed':
      return [
        `${e.status === 'verified' ? '✓ verified' : '✗ dropped'} ${questionOf(s, e.questionId).title}: ${clip(e.why)}`,
      ];
    case 'rejected':
      return [`refused ${e.action.do}: ${e.reason}`];
    case 'reflection':
      return [`Reflection: ${clip(e.text, 600)}`];
    case 'feedback':
      return [`Owner ${e.feedback.t}${'text' in e.feedback ? `: ${clip(e.feedback.text)}` : ''}`];
    case 'needs_owner':
      return [`Needs you: ${e.question}`];
    case 'validation': {
      // One line per validation, when its last command check is recorded.
      const v = validationOf(s, e.validationId);
      return validationComplete(s, v) ? [validationLabel(s, v)] : [];
    }
    case 'done_requested':
      return ['Done proposed: running the command checks on the expedition branch head.'];
    case 'done_refused':
      return [`Done refused: ${clip(e.reason)}`];
    case 'finished':
      return [`Finished (${e.reason}): ${e.summary}`];
    default:
      return [];
  }
}

export function attemptLabel(s: State, a: Attempt): string {
  switch (a.spec.kind) {
    case 'manager':
      return 'manager decision';
    case 'work':
      return `work on ${a.spec.questionId} (${seatLabel(configOf(s.charter, a.spec))})`;
    case 'check':
      return `${a.spec.goal ? 'goal ' : ''}check of ${a.spec.claimAttemptId} (${seatLabel(configOf(s.charter, a.spec))})`;
  }
}

/** One clipped line per outcome: the chat news and the page. */
export function outcomeLabel(o: Outcome): string {
  switch (o.t) {
    case 'manager':
      return `decided ${o.actions.length} actions`;
    case 'work':
      return o.result.result === 'blocked'
        ? `BLOCKED: ${clip(o.result.need)}`
        : `${o.result.result.toUpperCase()}: ${clip(o.result.statement)}`;
    case 'check':
      return `check ${o.result.verdict.toUpperCase()}: ${clip(o.result.why)}`;
    case 'malformed':
      return `answered without a valid result (${clip(o.error, 120)})`;
    case 'failed':
      return `run ${o.status}`;
  }
}

/** The full outcome, evidence included: what briefs show the next manager and workers. */
export function outcomeDetail(o: Outcome): string {
  switch (o.t) {
    case 'manager':
      return `manager: ${o.actions.length} actions`;
    case 'work':
      return workDetail(o.result);
    case 'check':
      return `CHECK ${o.result.verdict.toUpperCase()}: ${o.result.why}`;
    case 'malformed':
      return `MALFORMED ANSWER (${o.error}): ${o.raw.slice(0, 400)}`;
    case 'failed':
      return `RUN ${o.status.toUpperCase()}`;
  }
}

function workDetail(r: WorkResult): string {
  switch (r.result) {
    case 'claim':
      return `CLAIM: ${r.statement} | ${changeLabel(r.change)} | evidence: ${r.evidence.join('; ')} | check: ${r.howToCheck}`;
    case 'finding':
      return `FINDING: ${r.statement} | evidence: ${r.evidence.join('; ')}`;
    case 'blocked':
      return `BLOCKED: ${r.need}`;
  }
}

export function changeLabel(change: ClaimChange): string {
  switch (change.t) {
    case 'commit':
      return `commit ${change.sha}`;
    case 'no_code':
      return 'no code change';
  }
}

/** A done check as the owner wrote it: a command shows its argv, a judged item its text. */
export function doneCheckLabel(check: DoneCheck): string {
  switch (check.kind) {
    case 'command':
      return `$ ${check.argv.join(' ')} (host-run, ${check.timeoutSeconds}s timeout, exit 0 passes)`;
    case 'judged':
      return `${check.text} (judged by a blind goal-check panel)`;
  }
}

export function checkOutcomeLabel(o: CheckOutcome): string {
  switch (o.t) {
    case 'passed':
      return 'passed';
    case 'failed':
      return `FAILED (exit ${o.exitCode}): ${clip(o.tail.trim().split('\n').slice(-5).join(' / '), 400)}`;
    case 'timed_out':
      return 'TIMED OUT';
    case 'error':
      return `ERROR: ${clip(o.message, 300)}`;
  }
}

/** What a validation ran on and how far it got, one line. */
export function validationLabel(s: State, v: Validation): string {
  const runs = v.runs.map((r) => `check ${r.checkIndex} ${checkOutcomeLabel(r.outcome)}`);
  const state = !validationComplete(s, v)
    ? `running (${v.runs.length}/${commandChecks(s.charter).length})`
    : validationPassed(s, v)
      ? 'PASSED'
      : 'FAILED';
  return `validation ${v.id} of ${subjectOf(v)}: ${state}${runs.length ? ` — ${runs.join('; ')}` : ''}`;
}

function subjectOf(v: Validation): string {
  switch (v.target.t) {
    case 'candidate':
      return `candidate ${v.target.sha.slice(0, 10)} of ${v.target.claimAttemptId}`;
    case 'head':
      return `the head ${shaOf(v.phase)}`;
  }
}

function shaOf(phase: ValidationPhase): string {
  switch (phase.t) {
    case 'planned':
      return '(not yet resolved)';
    case 'started':
      return phase.targetSha.slice(0, 10);
  }
}
