import type { Attempt, Charter, Entry, Outcome, Question, State, WorkerConfig } from './model';
import { CheckResult, ManagerResult, WorkResult, exploreCap, liveWorkers, queued } from './model';

// What each attempt is told. Every brief is rebuilt from the ledger, so lessons and verified
// results reach every later attempt (expeditions/design.md "Knowledge flows through the Ledger").

/** The crew Buddy's role: short, because it rides every turn's briefing. */
export const CREW_ROLE = [
  'Expedition crew. Each request you receive is one attempt of an expedition: a manager decision,',
  'a work attempt, or an independent check. Do exactly that one attempt, then answer the request.',
  'Your final message MUST end with one fenced ```json block in the shape the request names.',
  'Never start other Buddies, workers or schedules. Use git worktrees for code changes and commit',
  'on your own branch; never push to main. When mentioned in a thread, use the `expedition` tool',
  '(status) to answer questions about your expedition.',
].join(' ');

const JSON_RULE = 'End your final message with exactly one fenced ```json block, nothing after it.';

function charterText(c: Charter): string {
  const done =
    'checks' in c.done
      ? c.done.checks.map((x) => `- ${x}`).join('\n')
      : '- The owner judges completion (no mechanical check).';
  return [
    `GOAL: ${c.goal}`,
    `DONE WHEN:\n${done}`,
    `IN SCOPE:\n${c.inScope.map((x) => `- ${x}`).join('\n') || '- (not listed)'}`,
    `OUT OF SCOPE:\n${c.outOfScope.map((x) => `- ${x}`).join('\n') || '- (not listed)'}`,
  ].join('\n\n');
}

function lessonsText(s: State): string {
  return s.lessons.length
    ? `OWNER LESSONS (binding):\n${s.lessons.map((x) => `- ${x}`).join('\n')}`
    : '';
}

function questionLine(s: State, q: Question): string {
  const attempts = s.attempts.filter(
    (a) => a.spec.kind !== 'manager' && a.spec.questionId === q.id
  );
  return `- ${q.id} [${q.scope}/${q.status}] ${q.title} — ${attempts.length} attempts`;
}

function outcomeText(o: Outcome): string {
  switch (o.t) {
    case 'manager':
      return `manager: ${o.actions.length} actions`;
    case 'work':
      return workText(o.result);
    case 'check':
      return `CHECK ${o.result.verdict.toUpperCase()}: ${o.result.why}`;
    case 'malformed':
      return `MALFORMED ANSWER (${o.error}): ${o.raw.slice(0, 400)}`;
    case 'failed':
      return `RUN ${o.status.toUpperCase()}`;
  }
}

function workText(r: WorkResult): string {
  switch (r.result) {
    case 'claim':
      return `CLAIM: ${r.statement} | evidence: ${r.evidence.join('; ')} | check: ${r.howToCheck}`;
    case 'finding':
      return `FINDING: ${r.statement} | evidence: ${r.evidence.join('; ')}`;
    case 'blocked':
      return `BLOCKED: ${r.need}`;
  }
}

const seatName = (w: WorkerConfig) =>
  [w.provider, w.model, w.reasoningEffort].filter(Boolean).join('/');

function attemptLine(a: Attempt): string {
  const what =
    a.spec.kind === 'manager'
      ? 'manager'
      : a.spec.kind === 'work'
        ? `work on ${a.spec.questionId} (seat ${a.spec.seat})`
        : `check of ${a.spec.claimAttemptId} in panel ${a.spec.panelId}${a.spec.goal ? ' (GOAL)' : ''}`;
  const where = a.phase.t === 'ended' ? outcomeText(a.phase.outcome) : a.phase.t;
  return `- ${a.id} ${what}: ${where}`;
}

function unseenLine(e: Entry): string {
  switch (e.t) {
    case 'attempt_ended':
      return `- ${e.attemptId} ended: ${outcomeText(e.outcome)}`;
    case 'rejected':
      return `- REJECTED ${e.action.do}: ${e.reason}`;
    case 'feedback':
      return `- OWNER ${e.feedback.t}: ${'text' in e.feedback ? e.feedback.text : ''}`;
    default:
      return `- ${e.t}`;
  }
}

export function managerBrief(s: State): string {
  const c = s.charter;
  return [
    `[expedition ${s.id} · ${c.name} · MANAGER]`,
    'You manage this expedition for one decision. Read the state, decide the next actions, answer.',
    charterText(c),
    lessonsText(s),
    `LIMITS: ${s.attempts.length}/${c.maxAttempts} attempts used, ${liveWorkers(s).length} live, ${queued(s).length} queued, max ${c.maxLive} live. Explore questions may use at most ${exploreCap(c)} work attempts.`,
    `CREW: work seats ${c.crew.work.map((w, i) => `${i}=${seatName(w)}`).join(', ')}. Checks run on ${c.crew.check.map(seatName).join(', ')}, never on the claim's own model; a panel of n checks verifies by majority. Spread competing approaches across seats.`,
    `QUESTIONS:\n${s.questions.map((q) => questionLine(s, q)).join('\n') || '- none yet: plan first'}`,
    `ATTEMPTS:\n${
      s.attempts
        .filter((a) => a.spec.kind !== 'manager')
        .map(attemptLine)
        .join('\n') || '- none'
    }`,
    `NEW SINCE YOUR LAST DECISION:\n${s.unseen.map(unseenLine).join('\n') || '- nothing'}`,
    [
      'HOW TO DECIDE:',
      '- Break the goal into questions (unknowns or subgoals). Keep at least two genuinely different approaches alive until one is verified.',
      '- Ideas outside IN SCOPE go to scope "explore" (budgeted) or "parked" (owner funds it). Never quietly widen scope.',
      '- Start parallel work: one "work" action per question attempt; the host queues beyond the live limit.',
      '- A claim counts only after "check". Ask a check with goal:true when a claim should satisfy DONE WHEN.',
      '- When different approaches fail the same way, the problem is probably upstream: add a question about measurement or setup.',
      '- Kill (close dead) what a check refuted twice or a prediction falsified. Do not repeat work already in ATTEMPTS.',
      '- "done" is refused unless the latest goal check verified it. "ask_owner" only for a decision only the owner can make.',
      '- Work and check attempts are run by other agents with fresh context: write each work brief self-contained.',
    ].join('\n'),
    [
      'ANSWER: a JSON object {"actions":[...]} where each action is one of:',
      '{"do":"add_question","title":"…","detail":"…","scope":"in"|"explore"|"parked"}',
      '{"do":"work","question":"<question id>","seat":<work seat index>,"brief":"<self-contained instructions and the approach to try>"}',
      '{"do":"check","claimAttempt":"<work attempt id>","goal":true|false,"panel":1|2|3}',
      '{"do":"close_question","question":"<id>","status":"verified"|"dead","why":"…"}',
      '{"do":"ask_owner","question":"…"}',
      '{"do":"done","summary":"…"}',
      '{"do":"note","text":"<your reflection: what is working, what is not>"}',
      'Question ids for new questions are assigned by the host; refer to them next time.',
      JSON_RULE,
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function workBrief(s: State, a: Attempt & { spec: { kind: 'work' } }): string {
  const q = s.questions.find((x) => x.id === a.spec.questionId);
  const verified = s.attempts.flatMap((x) =>
    x.phase.t === 'ended' &&
    x.phase.outcome.t === 'check' &&
    x.phase.outcome.result.verdict === 'verified'
      ? [`- verified by ${x.id}`]
      : []
  );
  const findings = s.attempts.flatMap((x) =>
    x.phase.t === 'ended' &&
    x.phase.outcome.t === 'work' &&
    x.phase.outcome.result.result !== 'blocked'
      ? [`- ${x.id}: ${outcomeText(x.phase.outcome)}`]
      : []
  );
  return [
    `[expedition ${s.id} · ${s.charter.name} · WORK ${a.id}]`,
    charterText(s.charter),
    lessonsText(s),
    `YOUR QUESTION (${q?.id}): ${q?.title}\n${q?.detail}`,
    `YOUR BRIEF:\n${a.spec.brief}`,
    `WHAT OTHERS FOUND:\n${findings.join('\n') || '- nothing yet'}${verified.length ? `\n${verified.join('\n')}` : ''}`,
    [
      'RULES: stay inside your question. Code changes go on your own branch in your own git worktree;',
      'commit before you claim, and cite the commit and files as evidence. Before you start, state your',
      'approach and what result you predict; report honestly if the prediction failed.',
    ].join(' '),
    [
      'ANSWER: one of',
      '{"result":"claim","statement":"<what is now true>","evidence":["<commit/file/test/number>"],"howToCheck":"<how an independent agent can verify it>"}',
      '{"result":"finding","statement":"<negative or partial result>","evidence":["…"]}',
      '{"result":"blocked","need":"<what is missing>"}',
      JSON_RULE,
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Blind check: the claim and its evidence, never the author's reasoning. */
export function checkBrief(
  s: State,
  a: Attempt & { spec: { kind: 'check' } },
  claim: WorkResult
): string {
  const statement = claim.result === 'claim' ? claim : null;
  if (!statement) throw new Error('check brief needs a claim');
  return [
    `[expedition ${s.id} · ${s.charter.name} · CHECK ${a.id}]`,
    'You are an independent verifier. Do not trust the claim; reproduce it yourself.',
    `CLAIM: ${statement.statement}`,
    `EVIDENCE CITED: ${statement.evidence.join('; ') || '(none)'}`,
    `SUGGESTED CHECK: ${statement.howToCheck}`,
    a.spec.goal ? charterText(s.charter) : '',
    a.spec.goal
      ? 'This is a GOAL check: verify the claim AND that every DONE WHEN item now holds.'
      : '',
    'Verified only if you reproduced it. Refuted if it is false. Unclear if you could not decide; say why.',
    ['ANSWER: {"verdict":"verified"|"refuted"|"unclear","why":"…"}', JSON_RULE].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------- Parsing answers (κ: once, at observation) ----------

const FENCE = /```json\s*([\s\S]*?)```/g;

function lastJson(body: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const blocks = [...body.matchAll(FENCE)];
  const last = blocks.at(-1);
  if (!last) return { ok: false, error: 'no ```json block' };
  try {
    return { ok: true, value: JSON.parse(last[1] ?? '') };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : error}` };
  }
}

export function parseOutcome(kind: Attempt['spec']['kind'], body: string): Outcome {
  const json = lastJson(body);
  if (!json.ok) return { t: 'malformed', error: json.error, raw: body };
  const malformed = (error: string): Outcome => ({ t: 'malformed', error, raw: body });
  switch (kind) {
    case 'manager': {
      const parsed = ManagerResult.safeParse(json.value);
      return parsed.success
        ? { t: 'manager', actions: parsed.data.actions }
        : malformed(parsed.error.message);
    }
    case 'work': {
      const parsed = WorkResult.safeParse(json.value);
      return parsed.success ? { t: 'work', result: parsed.data } : malformed(parsed.error.message);
    }
    case 'check': {
      const parsed = CheckResult.safeParse(json.value);
      return parsed.success ? { t: 'check', result: parsed.data } : malformed(parsed.error.message);
    }
  }
}

/** The status view the `expedition` tool returns (and the crew answers @mentions from). */
export function statusText(s: State, badgeLine: string): string {
  return [
    badgeLine,
    s.run.t === 'waiting_owner' ? `NEEDS YOU: ${s.run.question}` : '',
    s.run.t === 'finished' ? `FINISHED: ${s.run.summary}` : '',
    charterText(s.charter),
    lessonsText(s),
    `QUESTIONS:\n${s.questions.map((q) => questionLine(s, q)).join('\n') || '- none yet'}`,
    `ATTEMPTS:\n${s.attempts.map(attemptLine).join('\n') || '- none'}`,
    s.crew.t === 'ready' ? `Crew Buddy: ${s.crew.buddyId} (its DM holds every attempt).` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
