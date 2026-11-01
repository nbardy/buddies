import {
  type Charter,
  type ClaimChange,
  type DoneCheck,
  type WorkResult,
  crewLine,
  seatLabel,
} from './charter';
import type {
  Attempt,
  AttemptCost,
  CheckOutcome,
  Entry,
  FinishReason,
  Integration,
  IntegrationRefusal,
  Outcome,
  State,
  Validation,
  ValidationPhase,
} from './ledger';
import {
  apply,
  attemptOf,
  commandChecks,
  headOf,
  integrationOf,
  questionOf,
  validationComplete,
  validationOf,
  validationPassed,
} from './ledger';
import { configOf, liveWorkers, verifiedClaims, waitsOn, workerAttempts } from './queries';

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
  return `⛺ ${s.charter.name} · ${runLabel(s.run)} · ${liveWorkers(s).length} live · ${verifiedClaims(s)} verified · ${workerAttempts(s)}/${s.charter.maxAttempts} attempts · ${elapsed} · ${costTotals(s).short}`;
}

// ---------- Cost (design.md R6): measured tokens only, never an estimate ----------

/** Compact token count: 950, 41k, 1.3M. */
export const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** One attempt's cost as shown on the page. */
export function costLabel(c: AttemptCost): string {
  switch (c.t) {
    case 'measured':
      return `${tokens(c.inputTokens)} in · ${tokens(c.outputTokens)} out · cache ${tokens(c.cacheReadTokens)} read, ${tokens(c.cacheWriteTokens)} written`;
    case 'unmeasured':
      return `not measured: ${c.reason}`;
  }
}

/**
 * The expedition's measured spend: token sums over the measured attempts, and how many ended
 * attempts are not measured (with their reasons) or still settling. `short` is the badge's part,
 * `line` the page header's and the status's.
 */
export function costTotals(s: State): { short: string; line: string } {
  const ended = s.attempts.filter((a) => a.phase.t === 'ended');
  const costs = ended.flatMap((a) => (a.id in s.costs ? [s.costs[a.id]] : []));
  const measured = costs.flatMap((c) => (c.t === 'measured' ? [c] : []));
  const reasons = [...new Set(costs.flatMap((c) => (c.t === 'unmeasured' ? [c.reason] : [])))];
  const unmeasured = costs.length - measured.length;
  const settling = ended.length - costs.length;
  const sum = (pick: (c: (typeof measured)[number]) => number) =>
    measured.reduce((n, c) => n + pick(c), 0);
  const input = sum((c) => c.inputTokens);
  const output = sum((c) => c.outputTokens);
  const tail = [
    unmeasured > 0 ? `${unmeasured} not measured (${reasons.join('; ')})` : '',
    settling > 0 ? `${settling} settling` : '',
  ].filter(Boolean);
  const rest = tail.length > 0 ? `; ${tail.join('; ')}` : '';
  if (measured.length === 0)
    return {
      short: ended.length === 0 ? 'no cost yet' : 'cost not measured',
      line: ended.length === 0 ? 'Cost: no attempt has ended yet.' : `Cost: not measured${rest}.`,
    };
  return {
    short: `${tokens(input + output)} tokens`,
    line: `Cost: ${tokens(input)} input + ${tokens(output)} output tokens (cache ${tokens(sum((c) => c.cacheReadTokens))} read, ${tokens(sum((c) => c.cacheWriteTokens))} written) over ${measured.length} measured attempt(s)${rest}. Tokens only: no price is estimated.`,
  };
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
    text: lines.join('\n').trim(),
  };
  apply(s, status);
  return [...out, status];
}

/**
 * One line of at most `n` characters, cut at a word boundary with `…` when cut. Every chat line is
 * one line, so its markdown cannot open a list or code block that swallows the lines after it.
 * 2026-11-01 owner screenshot: the launch post read "…Engin" (a raw `slice` cut a word mid-way).
 * Only a single word longer than `n` (a URL, a hash) is cut inside, since it has no boundary.
 */
export function clip(text: string, n = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= n) return flat;
  const head = flat.slice(0, n + 1);
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : flat.slice(0, n)).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * A markdown block (an owner question, a finish summary) kept as written, lists and code blocks
 * included, cut at a word boundary with `…` past `n` characters. Its own paragraph in the post
 * (blank lines around it), so it neither runs into the lines around it nor swallows them.
 */
export function clipBlock(label: string, text: string, n = 2000): string {
  const body = text.trim();
  const head = body.slice(0, n + 1);
  const space = head.search(/\s\S*$/);
  const cut = body.length <= n ? body : `${head.slice(0, space > 0 ? space : n).trimEnd()}…`;
  return `\n${label}\n\n${cut}\n`;
}

/** Markdown punctuation in a plain name (a charter name is any 1–60 characters) shown literally. */
export const literal = (text: string): string => text.replace(/[\\`*_[\]<>#|~]/g, '\\$&');

/**
 * The goal's first sentence as plain prose, for a one-line mention (the launch post, the badge's
 * fallback text): headings dropped, quote and list markers stripped,
 * cut at a word boundary. The full goal renders as markdown in the modal.
 */
export function goalSummary(goal: string, n = 160): string {
  // A heading is a title ("## Goal"), not prose: it is dropped, not folded into the sentence.
  const prose = goal
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .map((line) => line.replace(/^\s*(>\s*|[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .filter(Boolean)
    .join(' ');
  // A sentence ends at . ! ? before a capital or the end: "e.g. the" does not end one.
  const sentence = /^(.+?[.!?])(\s+(?=[A-Z"'(\[])|$)/.exec(prose)?.[1] ?? prose;
  return clip(sentence, n);
}

/** The tool result's one-paragraph account of what a launch started. */
export function charterSummary(c: Charter): string {
  const done =
    'checks' in c.done
      ? c.done.checks
          .map((x) => (x.kind === 'command' ? `$ ${x.argv.join(' ')}` : `judged: ${x.text}`))
          .join('; ')
      : 'the owner judges it';
  return `${c.name}: ${clip(c.goal, 200)} | done when ${done} | budget ${c.maxAttempts} attempts, ${c.maxLive} live, ${c.hours}h, explore ${c.exploreShare} | crew ${crewLine(c.crew)}`;
}

/** The first status of every expedition: what launched, then the planning line on its own. */
export const launchNews = (c: { name: string; goal: string }) =>
  `⛺ Launched **${literal(c.name)}**: ${goalSummary(c.goal)}\n\nPlanning…`;

/** The chat line for one notable entry (none for an uninteresting one). */
function newsLine(s: State, e: Entry): string[] {
  switch (e.t) {
    case 'attempt_planned': {
      // Only work held by its question's dependencies (design.md R5); it starts once they verify.
      const deps = waitsOn(s, attemptOf(s, e.attemptId));
      return deps.length > 0
        ? [`⏸ ${e.attemptId} waiting: needs ${deps.join(', ')} verified first`]
        : [];
    }
    case 'attempt_posted': {
      const a = attemptOf(s, e.attemptId);
      return a.spec.kind === 'manager' ? [] : [`▶ ${a.id} started: ${attemptLabel(s, a)}`];
    }
    case 'attempt_ended': {
      const a = attemptOf(s, e.attemptId);
      return [`${a.id} ${outcomeLabel(e.outcome)}`];
    }
    case 'question_added':
      // Never a leading `+ `: markdown reads it as a list that swallows the lines after it.
      return [`➕ question ${e.questionId} (${e.scope}): ${clip(e.title)}`];
    case 'question_closed':
      return [
        `${e.status === 'verified' ? '✓ verified' : '✗ dropped'} ${questionOf(s, e.questionId).title}: ${clip(e.why)}`,
      ];
    case 'rejected':
      return [`⛔ refused ${e.action.do}: ${e.reason}`];
    case 'reflection':
      return [`Reflection: ${clip(e.text, 600)}`];
    case 'feedback':
      return [`Owner ${e.feedback.t}${'text' in e.feedback ? `: ${clip(e.feedback.text)}` : ''}`];
    case 'needs_owner':
      return [clipBlock('**Needs you:**', e.question)];
    case 'validation': {
      // One line per validation, when its last command check is recorded.
      const v = validationOf(s, e.validationId);
      return validationComplete(s, v)
        ? [`${validationPassed(s, v) ? '✓' : '✗'} ${validationLabel(s, v)}`]
        : [];
    }
    case 'done_requested':
      return ['Done proposed: running the command checks on the expedition branch head.'];
    case 'done_refused':
      return [`⛔ Done refused: ${clip(e.reason)}`];
    case 'integrated':
      return [`⤵ ${integrationLabel(s, integrationOf(s, e.integrationId))}`];
    case 'integration_refused':
      return [`⛔ ${integrationLabel(s, integrationOf(s, e.integrationId))}`];
    case 'finished':
      return [clipBlock(`**Finished (${e.reason}):**`, e.summary), ...mergeLine(s, e.reason)];
    default:
      return [];
  }
}

/** At done the owner is told what to merge; the host never writes the owner's branches. */
function mergeLine(s: State, reason: FinishReason): string[] {
  const merged = s.integrations.filter((i) => i.status.t === 'integrated').length;
  switch (reason) {
    case 'done':
      return [
        `To take the result, merge branch ${s.repo.branch} (head ${headOf(s).slice(0, 10)}, ${merged} integrated claim(s)); nothing was written to your checkout.`,
      ];
    case 'attempts_spent':
    case 'decisions_spent':
    case 'deadline':
    case 'owner_stop':
    case 'setup_failed':
      return [];
  }
}

/** One integration: what was merged into the expedition branch, or why it was not. */
export function integrationLabel(s: State, i: Integration): string {
  const what = `integration ${i.id} of ${i.claimAttemptId} (${i.sha.slice(0, 10)}) into ${s.repo.branch}`;
  switch (i.status.t) {
    case 'pending':
      return `${what}: queued`;
    case 'integrated':
      return `${what}: MERGED as ${i.status.mergeSha.slice(0, 10)}`;
    case 'refused':
      return `${what}: REFUSED — ${refusalLabel(i.status.refusal)}`;
  }
}

function refusalLabel(r: IntegrationRefusal): string {
  switch (r.phase) {
    case 'merge':
      return `merge conflict in ${r.paths.join(', ')} (aborted; the branch is unchanged)`;
    case 'git':
      return `git refused the merge: ${clip(r.reason)}`;
    case 'tree':
      return `the integration tree could not take a merge: ${clip(r.reason)}`;
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
