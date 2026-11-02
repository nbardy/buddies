import { expeditionRunLabel } from '@unleashd/shared';
import type {
  Acceptance,
  Charter,
  CheckResult,
  ClaimChange,
  DoneCheck,
  Feedback,
  QuestionScope,
  WorkResult,
} from './charter';
import { crewLine, seatLabel } from './charter';
import type {
  Attempt,
  AttemptCost,
  CheckOutcome,
  Entry,
  Integration,
  IntegrationRefusal,
  NewsEntry,
  Outcome,
  State,
  TargetSha,
  Validation,
} from './ledger';
import {
  allAttempts,
  apply,
  attemptOf,
  headOf,
  integrationOf,
  questionOf,
  targetShaOf,
  validationComplete,
  validationOf,
  validationPassed,
} from './ledger';
import { configOf, liveWorkers, verifiedClaims, waitsOn, workerAttempts } from './queries';

// Every human-readable rendering of expedition state. The manager's renderers (`…Label`,
// `…Detail`) name ids it acts on; the owner's (`…Headline`, `…Parts`, news) name titles and shas.

export function badge(s: State, now: string): string {
  const end = s.run.t === 'finished' ? s.run.at : now;
  const mins = Math.round((Date.parse(end) - Date.parse(s.launchedAt)) / 60_000);
  const elapsed = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`;
  return `⛺ ${s.charter.name} · ${expeditionRunLabel(s.run)} · ${liveWorkers(s).length} live · ${verifiedClaims(s)} verified · ${workerAttempts(s)}/${s.charter.maxAttempts} attempts · ${elapsed} · ${costTotals(s).short}`;
}

// ---------- Cost (design.md R6): measured tokens only, never an estimate ----------

/** Compact token count: 950, 41k, 1.3M. */
const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** One measured attempt's cost on its card: one token figure (the detail is its title). */
export const costShort = (c: Extract<AttemptCost, { t: 'measured' }>) =>
  `${tokens(c.inputTokens + c.outputTokens)} tokens`;

export const costLabel = (c: AttemptCost): string =>
  c.t === 'measured'
    ? `${tokens(c.inputTokens)} in · ${tokens(c.outputTokens)} out · cache ${tokens(c.cacheReadTokens)} read, ${tokens(c.cacheWriteTokens)} written`
    : `not measured: ${c.reason}`;

/** Token sums over the measured ended attempts, with the unmeasured (and why) and settling ones:
 * `short` for the badge, `line` for the page header and status. */
export function costTotals(s: State): { short: string; line: string } {
  const ended = allAttempts(s).filter((a) => a.phase.t === 'ended');
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

/** One chat post per decision round: everything notable since the last post, in order. The badge
 * lives on the page header and launch badge; chat posts carry only news. */
export function withStatus(s: State, out: Entry[], at: string): Entry[] {
  const lines = s.news.map((e) => newsLine(s, e)).filter(Boolean);
  if (lines.length === 0) return out;
  const status: Entry = { t: 'status', at, seq: s.statuses.length, text: lines.join('\n').trim() };
  apply(s, status);
  return [...out, status];
}

/**
 * One line of at most `n` characters, cut at a word boundary with `…`, so its markdown cannot open
 * a list or code block that swallows later lines. 2026-11-01 owner screenshot: a raw `slice` read
 * "…Engin". Only a single word longer than `n` (a URL, a hash) is cut inside.
 */
export function clip(text: string, n = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= n) return flat;
  const head = flat.slice(0, n + 1);
  const space = head.lastIndexOf(' ');
  return `${(space > 0 ? head.slice(0, space) : flat.slice(0, n)).replace(/[\s,;:.]+$/, '')}…`;
}

/** A markdown block kept as written, cut at a word boundary past `n`, as its own paragraph. */
export function clipBlock(label: string, text: string, n = 2000): string {
  const body = text.trim();
  const head = body.slice(0, n + 1);
  const space = head.search(/\s\S*$/);
  const cut = body.length <= n ? body : `${head.slice(0, space > 0 ? space : n).trimEnd()}…`;
  return `\n${label}\n\n${cut}\n`;
}

/** Markdown punctuation in a plain name (a charter name is any 1–60 characters) shown literally. */
const literal = (text: string): string => text.replace(/[\\`*_[\]<>#|~]/g, '\\$&');

/** The goal's first sentence as plain prose (headings dropped, quote and list markers stripped),
 * cut at a word boundary, for one-line mentions; the modal renders the full goal. */
export function goalSummary(goal: string, n = 160): string {
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
    c.done.t === 'owner'
      ? 'the owner judges it'
      : c.done.checks
          .map((x) => (x.kind === 'command' ? `$ ${x.argv.join(' ')}` : `judged: ${x.text}`))
          .join('; ');
  return `${c.name}: ${clip(c.goal, 200)} | done when ${done} | budget ${c.maxAttempts} attempts, ${c.maxLive} live, ${c.hours}h, explore ${c.exploreShare} | crew ${crewLine(c.crew)}`;
}

/** The first status of every expedition: what launched, then the planning line on its own. */
export const launchNews = (c: { name: string; goal: string }) =>
  `⛺ Launched **${literal(c.name)}**: ${goalSummary(c.goal)}\n\nPlanning…`;

/** The chat text for one notable entry ('' when it is not news). Titles, never ids: the owner
 * reads the chat (2026-11-01 review: raw ids read as debug). */
function newsLine(s: State, e: NewsEntry): string {
  const title = (attemptId: string) => attemptTitle(s, attemptOf(s, attemptId));
  switch (e.t) {
    case 'attempt_planned': {
      // Only work held by its question's dependencies (design.md R5); it starts once they verify.
      const deps = waitsOn(s, attemptOf(s, e.attemptId));
      const titles = deps.map((q) => quoted(questionOf(s, q).title)).join(', ');
      return deps.length > 0 ? `⏸ ${title(e.attemptId)} waits until ${titles} is verified` : '';
    }
    case 'attempt_retry_planned':
      return `↻ ${title(e.retryOf)} runs again: the server restarted while it ran`;
    case 'attempt_posted': {
      // A worker's start is news; a manager decision's is not (its actions are).
      const a = attemptOf(s, e.attemptId);
      const seat = seatLabel(configOf(s.charter, a.spec));
      return a.spec.kind === 'manager' ? '' : `▶ Started: ${attemptTitle(s, a)} (${seat})`;
    }
    case 'attempt_ended':
      return `${title(e.attemptId)} → ${outcomeLabel(e.outcome)}`;
    case 'question_added':
      // Never a leading `+ `: markdown reads it as a list that swallows the lines after it.
      return `➕ New ${SCOPE_WORD[e.scope]}: ${clip(e.title)}`;
    case 'question_closed':
      return `${e.status === 'verified' ? '✓ verified' : '✗ dropped'} ${questionOf(s, e.questionId).title}: ${clip(e.why)}`;
    case 'rejected':
      return `⛔ refused ${e.action.do}: ${e.reason}`;
    case 'reflection':
      return `Reflection: ${clip(e.text, 600)}`;
    case 'feedback':
      return `Owner ${feedbackText(e.feedback, clip)}`;
    case 'validation_failed':
      return `✗ ${validationHeadline(s, validationOf(s, e.validationId))}`;
    case 'claim_adopted':
      return `${title(e.attemptId)}: its unreported commit was claimed by the manager`;
    case 'claim_refused':
      return `⛔ claim of ${title(e.attemptId)} refused: ${clip(e.reason)}`;
    case 'tick_failed':
      return `⚠ the host failed ${e.failures} ticks in a row, backing off: ${clip(e.reason)}`;
    case 'needs_owner':
      return clipBlock('**Needs you:**', e.question);
    case 'validation': {
      // One line per validation, when its last command check is recorded.
      const v = validationOf(s, e.validationId);
      return validationComplete(v)
        ? `${validationPassed(v) ? '✓' : '✗'} ${validationHeadline(s, v)}`
        : '';
    }
    case 'done_requested':
      return 'Done proposed: running the command checks on the expedition branch head.';
    case 'done_refused':
      return `⛔ Done refused: ${clip(e.reason)}`;
    case 'integrated':
      return `⤵ ${integrationHeadline(s, integrationOf(s, e.integrationId))}`;
    case 'integration_refused':
      return `⛔ ${integrationHeadline(s, integrationOf(s, e.integrationId))}`;
    case 'finished': {
      // At done the owner is told what to merge; the host never writes the owner's branches.
      const merged = s.integrations.filter((i) => i.status.t === 'integrated').length;
      const take = `To take the result, merge branch ${s.repo.branch} (head \`${headOf(s).slice(0, 7)}\`, ${merged} merged ${merged === 1 ? 'claim' : 'claims'}); nothing was written to your checkout.`;
      const summary = clipBlock(`**${expeditionRunLabel(s.run)}:**`, e.summary);
      return e.reason === 'done' ? `${summary}\n${take}` : summary;
    }
  }
}

/** Owner feedback: the chat clips its text (`fit`), a manager's brief keeps it whole. */
export function feedbackText(f: Feedback, fit: (text: string) => string): string {
  switch (f.t) {
    case 'lesson':
    case 'note':
      return `${f.t}: ${fit(f.text)}`;
    case 'extend':
      return `extended the deadline by ${f.hours}h`;
    case 'pause':
    case 'resume':
    case 'stop':
      return f.t;
  }
}

/** How a question's claims are accepted (design.md R11), one line. */
export const acceptanceLabel = (a: Acceptance): string =>
  a.t === 'command'
    ? `$ ${a.argv.join(' ')} on its commit (host-run, ${a.timeoutSeconds}s)`
    : 'an independent check panel';

/** δ over an integration's status: one text per status. */
function byStatus(
  i: Integration,
  pending: string,
  merged: (sha: string) => string,
  refused: (why: string) => string
) {
  switch (i.status.t) {
    case 'pending':
      return pending;
    case 'integrated':
      return merged(i.status.mergeSha);
    case 'refused':
      return refused(refusalLabel(i.status.refusal));
  }
}

/** One integration for the manager: what was merged into the expedition branch, or why not. */
export function integrationLabel(s: State, i: Integration): string {
  const what = `integration ${i.id} of ${i.claimAttemptId} (${i.sha.slice(0, 10)}) into ${s.repo.branch}`;
  return byStatus(
    i,
    `${what}: queued`,
    (sha) => `${what}: MERGED as ${sha.slice(0, 10)}`,
    (why) => `${what}: REFUSED — ${why}`
  );
}

/** An integration for the owner (chat, page): the claim by its title, its sha as code, no ids. */
export function integrationHeadline(s: State, i: Integration): string {
  const what = `\`${i.sha.slice(0, 7)}\` from ${attemptTitle(s, attemptOf(s, i.claimAttemptId))}`;
  return byStatus(
    i,
    `Merging ${what} into ${s.repo.branch}`,
    () => `Merged ${what} into ${s.repo.branch}`,
    (why) => `Could not merge ${what}: ${why}`
  );
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

const SCOPE_WORD: Record<QuestionScope, string> = {
  in: 'question',
  explore: 'exploration question',
  parked: 'parked question',
};

/** A title in quotes, clipped: a question's title is free text from the manager. */
const quoted = (title: string) => `“${clip(title, 80)}”`;

/** What an attempt is, by question title (never a raw id): the page's card title and the news. */
export function attemptTitle(s: State, a: Attempt): string {
  switch (a.spec.kind) {
    case 'manager':
      return 'Manager decision';
    case 'work':
      return `Work on ${quoted(questionOf(s, a.spec.questionId).title)}`;
    case 'check':
      return `${a.spec.goal ? 'Goal check' : 'Check'} of the claim on ${quoted(questionOf(s, a.spec.questionId).title)}`;
  }
}

const WORK_VERDICT = { claim: 'Claim', finding: 'Finding' } as const;
const CHECK_VERDICT: Record<CheckResult['verdict'], string> = {
  verified: 'Verified',
  refuted: 'Refuted',
  unclear: 'Unclear',
};

/** An outcome as a verdict word and its clipped one-line summary: the page's outcome block. */
export function outcomeParts(o: Outcome): { verdict: string; summary: string } {
  switch (o.t) {
    case 'manager':
      return { verdict: 'Decided', summary: `${o.actions.length} actions` };
    case 'work':
      return o.result.result === 'blocked'
        ? { verdict: 'Blocked', summary: clip(o.result.need) }
        : { verdict: WORK_VERDICT[o.result.result], summary: clip(o.result.statement) };
    case 'check':
      return { verdict: CHECK_VERDICT[o.result.verdict], summary: clip(o.result.why) };
    case 'malformed':
      return { verdict: 'No valid result', summary: clip(o.error, 120) };
    case 'unreported_commits':
      return {
        verdict: 'Unreported commits',
        summary: `its branch holds ${o.shas.length} (${o.shas.map((x) => x.slice(0, 10)).join(', ')}): claimable; it ended ${outcomeLabel(o.ended)}`,
      };
    case 'failed':
      return { verdict: 'Run failed', summary: `the run ended ${o.status}` };
    case 'abandoned':
      return { verdict: 'Abandoned', summary: `after the host's stop (${clip(o.reason, 120)})` };
    case 'interrupted':
      return {
        verdict: 'Interrupted',
        summary: 'the server restarted; it runs again on a new session',
      };
  }
}

/** One clipped line per outcome: the chat news. */
function outcomeLabel(o: Outcome): string {
  const { verdict, summary } = outcomeParts(o);
  return `${verdict}: ${summary}`;
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
    case 'unreported_commits':
      return `UNREPORTED COMMITS: its branch holds ${o.shas.join(', ')}; "claim" one to have it validated. It ended: ${outcomeDetail(o.ended)}`;
    case 'failed':
      return `RUN ${o.status.toUpperCase()}`;
    case 'abandoned':
      return `ABANDONED: ${o.reason}`;
    case 'interrupted':
      return `INTERRUPTED: the server restarted and cancelled its runs (${o.runIds.join(', ') || 'none found'}); a work or check attempt is replanned on a new session`;
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

export const changeLabel = (change: ClaimChange): string =>
  change.t === 'commit' ? `commit ${change.sha}` : 'no code change';

/** A done check as the owner wrote it: a command shows its argv, a judged item its text. */
export const doneCheckLabel = (check: DoneCheck): string =>
  check.kind === 'command'
    ? `$ ${check.argv.join(' ')} (host-run, ${check.timeoutSeconds}s timeout, exit 0 passes)`
    : `${check.text} (judged by a blind goal-check panel)`;

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

const couldNotRun = (v: Validation) =>
  v.failure.t === 'failed' ? [`could not run: ${clip(v.failure.reason, 300)}`] : [];

/** What a validation ran on and how far it got, one line (the manager's, with ids). */
export function validationLabel(s: State, v: Validation): string {
  const runs = [
    ...v.runs.map((r) => `check ${r.checkIndex} ${checkOutcomeLabel(r.outcome)}`),
    ...couldNotRun(v),
  ];
  const state = !validationComplete(v)
    ? `running (${v.runs.length}/${v.checks.length})`
    : validationPassed(v)
      ? 'PASSED'
      : 'FAILED';
  const sha = (t: TargetSha) => (t.t === 'at' ? t.sha.slice(0, 10) : '(not yet resolved)');
  const subject =
    v.target.t === 'candidate'
      ? `candidate ${v.target.sha.slice(0, 10)} of ${v.target.claimAttemptId}`
      : `the head ${sha(targetShaOf(s, v))}`;
  return `validation ${v.id} of ${subject}: ${state}${runs.length ? ` — ${runs.join('; ')}` : ''}`;
}

/**
 * A validation for the owner: its target by title and short sha, and only the checks that did not
 * pass. 2026-11-01 visual pass: "validation v37789f of candidate dd142c7227 of wef7487: PASSED —
 * check 0 passed" read as debug output in the chat.
 */
export function validationHeadline(s: State, v: Validation): string {
  const head = (t: TargetSha) => (t.t === 'at' ? ` \`${t.sha.slice(0, 7)}\`` : '');
  const on =
    v.target.t === 'candidate'
      ? `\`${v.target.sha.slice(0, 7)}\` from ${attemptTitle(s, attemptOf(s, v.target.claimAttemptId))}`
      : `the expedition branch head${head(targetShaOf(s, v))}`;
  const total = v.checks.length;
  const problems = [
    ...v.runs
      .filter((r) => r.outcome.t !== 'passed')
      .map((r) => `check ${r.checkIndex + 1}: ${checkOutcomeLabel(r.outcome)}`),
    ...couldNotRun(v),
  ];
  const detail = problems.length > 0 ? ` — ${problems.join('; ')}` : '';
  if (!validationComplete(v)) return `Checks running on ${on} (${v.runs.length}/${total})`;
  return validationPassed(v)
    ? `${total === 1 ? 'Check' : `All ${total} checks`} passed on ${on}`
    : `Checks failed on ${on}${detail}`;
}
