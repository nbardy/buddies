import type {
  Attempt,
  Charter,
  CheckSpec,
  Claim,
  EndOutcome,
  Entry,
  Feedback,
  Question,
  State,
  WorkSpec,
} from './model';
import {
  CheckResult,
  ManagerResult,
  WorkResult,
  acceptanceLabel,
  attemptsOn,
  changeLabel,
  claimOf,
  costTotals,
  doneCheckLabel,
  exploreCap,
  integrationLabel,
  integrationOf,
  liveWorkers,
  managerCap,
  managerDirectory,
  managerTurns,
  outcomeDetail,
  questionOf,
  questionStage,
  queued,
  seatLabel,
  validationLabel,
  validationOf,
  waitsOn,
  workerAttempts,
  worktreeOf,
} from './model';

// What each attempt is told. Every brief is rebuilt from the ledger, so lessons and verified
// results reach every later attempt (expeditions/design.md "Knowledge flows through the Ledger").

/** The crew Buddy's role: short, because it rides every turn's briefing. */
export const CREW_ROLE = [
  'Expedition crew. Each request you receive is one attempt of an expedition: a manager decision,',
  'a work attempt, or an independent check. Do exactly that one attempt, then answer the request.',
  'Your final message MUST end with one fenced ```json block in the shape the request names.',
  'Never start other Buddies, workers or schedules. A work or check request names your git worktree, where your turn starts:',
  'work only there, never in any other checkout; never push. When mentioned in a thread, use the `expedition` tool',
  '(status) to answer questions about your expedition. The host records each owner message in your chat with the owner as',
  'steering by itself (pause, resume, stop, "lesson: …", anything else a note for the manager): just acknowledge it briefly.',
].join(' ');

/** Longest owner text kept per chat message (the steer tool's own limit). */
const CHAT_TEXT_MAX = 2000;

/** The most hours one `extend` adds (the charter's own `hours` limit). */
export const EXTEND_MAX_HOURS = 72;

/**
 * An owner chat message as steering (κ, once, at observation; host.ts observeChat): the word
 * pause, resume or stop alone (resume re-plans, R11); `extend 3h` moves the deadline; `lesson: …`
 * a binding lesson every later brief carries; anything else a note the next manager reads (it
 * also answers a pending "needs you"). An `extend` outside 0–72 hours is kept as a note, so the
 * manager and the page show it, never silently clamped.
 */
export function chatFeedback(body: string): Feedback {
  const text = body.trim().slice(0, CHAT_TEXT_MAX);
  const word = text.toLowerCase().replace(/[.!]+$/, '');
  if (word === 'pause' || word === 'resume' || word === 'stop') return { t: word };
  const extend = /^extend:?\s*(\d+(?:\.\d+)?)\s*(h|hours?)?$/i.exec(word);
  const hours = extend ? Number(extend[1]) : 0;
  if (extend && hours > 0 && hours <= EXTEND_MAX_HOURS) return { t: 'extend', hours };
  const lesson = /^lesson:\s*(\S[\s\S]*)$/i.exec(text);
  return lesson ? { t: 'lesson', text: lesson[1] } : { t: 'note', text };
}

const JSON_RULE = 'End your final message with exactly one fenced ```json block, nothing after it.';

function charterText(c: Charter): string {
  const done =
    'checks' in c.done
      ? c.done.checks.map((x, i) => `- [${i}] ${doneCheckLabel(x)}`).join('\n')
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
  const after = q.after.length > 0 ? ` (after: ${q.after.join(', ')})` : '';
  return `- ${q.id} [${q.scope}/${q.status}, stage ${questionStage(s, q)}] ${q.title} (paths: ${q.paths.join(', ')})${after}; accepted by ${acceptanceLabel(q.acceptance.rule)} — ${attemptsOn(s, q.id).length} attempts`;
}

/** Questions counted by stage (design.md R5): waiting is held work, never a failure. */
function stagesText(s: State): string {
  const counts = new Map<string, number>();
  for (const q of s.questions) {
    const stage = questionStage(s, q);
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  return counts.size === 0
    ? ''
    : `STAGES: ${[...counts].map(([stage, n]) => `${n} ${stage}`).join(', ')}`;
}

/** Every validation so far, newest last: what the host ran and how each check ended. */
function validationsText(s: State): string {
  return `VALIDATIONS (host-run commands: a question's command acceptance on a candidate, the DONE WHEN commands on the head at done):\n${s.validations.map((v) => `- ${validationLabel(v)}`).join('\n') || '- none yet'}`;
}

/** Every merge into the expedition branch so far, in order. */
function integrationsText(s: State): string {
  return `INTEGRATION (the host merges validated claims into ${s.repo.branch}, one at a time; new work starts at its head):\n${s.integrations.map((i) => `- ${integrationLabel(s, i)}`).join('\n') || '- nothing merged yet'}`;
}

function attemptLine(s: State, a: Attempt): string {
  const what =
    a.spec.kind === 'manager'
      ? 'manager'
      : a.spec.kind === 'work'
        ? `work on ${a.spec.questionId} (seat ${a.spec.seat})`
        : `check of ${a.spec.claimAttemptId} in panel ${a.spec.panelId}${a.spec.goal ? ' (GOAL)' : ''}`;
  return `- ${a.id} ${what}: ${phaseDetail(s, a)}`;
}

function phaseDetail(s: State, a: Attempt): string {
  switch (a.phase.t) {
    case 'ended':
      return outcomeDetail(a.phase.outcome);
    case 'dropped':
      return `NOT STARTED (no worktree): ${a.phase.reason}`;
    case 'planned': {
      const deps = waitsOn(s, a);
      return deps.length > 0 ? `waiting for ${deps.join(', ')} to be verified` : 'planned';
    }
    case 'admitted':
    case 'posting':
    case 'posted':
      return a.phase.t;
  }
}

function unseenLine(s: State, e: Entry): string {
  switch (e.t) {
    case 'validation':
      return `- ${validationLabel(validationOf(s, e.validationId))}`;
    case 'done_refused':
      return `- DONE REFUSED: ${e.reason}`;
    case 'integrated':
    case 'integration_refused':
      return `- ${integrationLabel(s, integrationOf(s, e.integrationId))}`;
    case 'attempt_ended':
      return `- ${e.attemptId} ended: ${outcomeDetail(e.outcome)}`;
    case 'worktree_failed':
      return `- ${e.attemptId} NOT STARTED, its worktree could not be made: ${e.reason}`;
    case 'rejected':
      return `- REJECTED ${e.action.do}: ${e.reason}`;
    case 'feedback':
      return `- OWNER ${e.feedback.t}: ${'text' in e.feedback ? e.feedback.text : ''}`;
    case 'question_added':
      return `- QUESTION ADDED ${e.questionId} [${e.scope}] ${e.title} (paths: ${e.paths.join(', ')}; accepted by ${acceptanceLabel(e.acceptance)}): start work on it by this id`;
    case 'validation_failed':
      return `- ${validationLabel(validationOf(s, e.validationId))}`;
    case 'claim_adopted':
      return `- CLAIM ADOPTED for ${e.attemptId}: its commit is now its claim (validated or checked as its question's acceptance says)`;
    case 'claim_refused':
      return `- CLAIM REFUSED for ${e.attemptId}: ${e.reason}`;
    default:
      return `- ${e.t}`;
  }
}

function managerBrief(s: State, id: string): string {
  const c = s.charter;
  return [
    `[expedition ${s.id} · ${c.name} · MANAGER]`,
    'You manage this expedition for one decision. Read the state, decide the next actions, answer.',
    charterText(c),
    lessonsText(s),
    `YOUR DIRECTORY: ${managerDirectory(s)} (your own detached checkout of the expedition branch head, reset before every decision). Read only: never edit or commit there; the host merges in its own tree.`,
    `LIMITS: ${workerAttempts(s)}/${c.maxAttempts} work and check attempts used, ${liveWorkers(s).length} live, ${queued(s).length} queued, max ${c.maxLive} live. Explore questions may use at most ${exploreCap(c)} work attempts. This is decision ${managerTurns(s)} of at most ${managerCap(c)}; you are woken only when there is something to act on, never to wait for the host.`,
    `CREW: work seats ${c.crew.work.map((w, i) => `${i}=${seatLabel(w)}`).join(', ')}. Checks run on ${c.crew.check.map(seatLabel).join(', ')}, never on the claim's own model; a panel of n checks verifies by majority. Spread competing approaches across seats.`,
    `QUESTIONS:\n${s.questions.map((q) => questionLine(s, q)).join('\n') || '- none yet: plan first'}`,
    `ATTEMPTS:\n${
      s.attempts
        .filter((a) => a.spec.kind !== 'manager')
        .map((a) => attemptLine(s, a))
        .join('\n') || '- none'
    }`,
    validationsText(s),
    integrationsText(s),
    `NEW SINCE YOUR LAST DECISION:\n${s.shown[id].map((e) => unseenLine(s, e)).join('\n') || '- nothing'}`,
    [
      'HOW TO DECIDE:',
      '- Break the goal into questions (unknowns or subgoals). Keep at least two genuinely different approaches alive until one is verified.',
      '- Ideas outside IN SCOPE go to scope "explore" (budgeted) or "parked" (owner funds it). Never quietly widen scope.',
      '- Start parallel work: one "work" action per question attempt; the host queues beyond the live limit.',
      '- Each question owns file paths (repo-relative prefixes, "." = whole repo). Work on overlapping paths runs one at a time, so split questions by the files they touch to run them in parallel.',
      '- "after" lists question ids a question depends on: work on it waits (stage waiting, not refused) until each is closed verified. Integrate a dependency\'s claim before closing it when the dependent work builds on its code.',
      '- ACCEPTANCE: every question names how its claims are accepted. {"t":"command","argv":[…],"timeoutSeconds":n}: the host runs that argv on the claim\'s exact commit in a fresh tree (exit 0 passes); use a command that can pass for THIS step (its own tests, a build), never the final goal verifier for a preparation step. {"t":"panel"}: an independent check panel on another model must verify it ("check" action). Change it with "set_acceptance": that re-validates the question\'s unmerged claims, and only the current acceptance decides. The validator files a command names are trusted as they are on the expedition branch when you declare it: a candidate that changes them is refused (re-declare to trust new bytes).',
      "- The DONE WHEN commands ($ …) run on the expedition branch head at done only, never on a candidate unless you name one as a question's acceptance. No agent runs or reports host commands.",
      '- A claim counts as verified after a "check" panel verifies it, or (host-verified) when its command acceptance PASSED on its commit and you integrated it: the host then closes its question verified, which unlocks the questions after it. Ask a check with goal:true when a claim should satisfy the judged DONE WHEN items: those always need a panel. A claim whose validation FAILED is not done: send work to fix it.',
      '- A work attempt that ended with UNREPORTED COMMITS made commits it did not claim: "claim" names one of its commits (full sha) as its claim, and the host checks it is on that attempt\'s branch and inside its paths before accepting it.',
      '- When different approaches fail the same way, the problem is probably upstream: add a question about measurement or setup.',
      '- Kill (close dead) what a check refuted twice or a prediction falsified. Do not repeat work already in ATTEMPTS.',
      '- "integrate" merges a claim\'s commit into the expedition branch. It is accepted only once its question\'s acceptance holds (its command PASSED on the commit, or a panel verified it) and no later panel refuted it. A merge conflict is refused with the conflicting paths: send work to redo it on the current head. Integrate before "done": done runs the DONE WHEN commands on the branch head, which holds only integrated work.',
      '- "done" needs the latest goal check verified (when there are judged items); the host then runs every command check on the head, and refuses done unless all pass. "ask_owner" only for a decision only the owner can make.',
      '- Work and check attempts are run by other agents with fresh context: write each work brief self-contained.',
    ].join('\n'),
    answerFormat('manager'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** What each attempt kind must answer: its brief's last section, and the repair request's. */
function answerFormat(kind: Attempt['spec']['kind']): string {
  switch (kind) {
    case 'manager':
      return [
        'ANSWER: a JSON object {"actions":[...]} where each action is one of:',
        '{"do":"add_question","title":"…","detail":"…","scope":"in"|"explore"|"parked","paths":["<repo-relative prefix the work may edit>"],"after":["<existing question id>"] (optional),"acceptance":{"t":"command","argv":["<exe>","<arg>"],"timeoutSeconds":<n>}|{"t":"panel"}}',
        '{"do":"set_acceptance","question":"<question id>","acceptance":{"t":"command","argv":[…],"timeoutSeconds":<n>}|{"t":"panel"}}',
        '{"do":"work","question":"<question id>","seat":<work seat index>,"brief":"<self-contained instructions and the approach to try>"}',
        '{"do":"check","claimAttempt":"<work attempt id>","goal":true|false,"panel":1|2|3}',
        '{"do":"claim","attempt":"<work attempt id that ended malformed or with unreported commits>","claim":{"statement":"…","sha":"<full sha on its branch>","evidence":["…"],"howToCheck":"…"}}',
        '{"do":"integrate","claimAttempt":"<work attempt id whose claim passed>"}',
        '{"do":"close_question","question":"<id>","status":"verified"|"dead","why":"…"}',
        '{"do":"ask_owner","question":"…"}',
        '{"do":"done","summary":"<for the owner: what is true now, tasks by title, no attempt or validation ids>"}',
        '{"do":"note","text":"<your reflection: what is working, what is not>"}',
        'Question ids for new questions are assigned by the host: the next decision is shown them and starts work on them.',
        JSON_RULE,
      ].join('\n');
    case 'work':
      return [
        'ANSWER: one of',
        '{"result":"claim","statement":"<what is now true>","change":{"t":"commit","sha":"<full sha of your commit in YOUR WORKTREE>"} or {"t":"no_code"},"evidence":["<commit/file/test/number>"],"howToCheck":"<how an independent agent can verify it>"}',
        '{"result":"finding","statement":"<negative or partial result>","evidence":["…"]}',
        '{"result":"blocked","need":"<what is missing>"}',
        JSON_RULE,
      ].join('\n');
    case 'check':
      return ['ANSWER: {"verdict":"verified"|"refuted"|"unclear","why":"…"}', JSON_RULE].join('\n');
  }
}

/** Longest part of a malformed answer quoted back in its repair request. */
const REPAIR_QUOTE = 6000;

/**
 * The one repair request a malformed answer gets (design.md R11), on the same seat and, for a
 * worker, in the same worktree (host.ts matches its run by these bytes). 2026-11-01 incident: a
 * manager answered a bare JSON object and a worker a prose summary of its commit; both were
 * dropped as malformed with no second chance.
 */
export function repairBrief(s: State, attempt: Attempt, error: string, raw: string): string {
  const quoted = raw.length > REPAIR_QUOTE ? `…${raw.slice(-REPAIR_QUOTE)}` : raw;
  return [
    `[expedition ${s.id} · ${s.charter.name} · REPAIR ${attempt.id}]`,
    `Your answer to attempt ${attempt.id} could not be read (${error}). Do not redo the work: reply with the same result in the required format. Your answer must end with the json block.`,
    answerFormat(attempt.spec.kind),
    `YOUR PREVIOUS ANSWER:\n${quoted}`,
  ].join('\n\n');
}

function workBrief(s: State, id: string, spec: WorkSpec): string {
  const q = questionOf(s, spec.questionId);
  const tree = worktreeOf(s, id);
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
      ? [`- ${x.id}: ${outcomeDetail(x.phase.outcome)}`]
      : []
  );
  return [
    `[expedition ${s.id} · ${s.charter.name} · WORK ${id}]`,
    charterText(s.charter),
    lessonsText(s),
    `YOUR QUESTION (${q.id}): ${q.title}\n${q.detail}`,
    `YOUR BRIEF:\n${spec.brief}`,
    [
      `YOUR WORKTREE: ${tree.path} (branch ${tree.branch}, based on ${tree.baseSha}).`,
      'Your turn starts there. Work and commit ONLY in that directory, on that branch. Never edit any other',
      `checkout. Your files: ${q.paths.join(', ')}. A code claim must name its commit's full sha.`,
      `Your claim is accepted by ${acceptanceLabel(q.acceptance.rule)}.`,
    ].join(' '),
    `WHAT OTHERS FOUND:\n${findings.join('\n') || '- nothing yet'}${verified.length ? `\n${verified.join('\n')}` : ''}`,
    [
      'RULES: stay inside your question. Commit before you claim, and cite the files and tests as',
      'evidence. Before you start, state your',
      'approach and what result you predict; report honestly if the prediction failed.',
    ].join(' '),
    answerFormat('work'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Blind check: the claim and its evidence, never the author's reasoning. */
function checkBrief(s: State, id: string, spec: CheckSpec, statement: Claim): string {
  const tree = worktreeOf(s, id);
  return [
    `[expedition ${s.id} · ${s.charter.name} · CHECK ${id}]`,
    'You are an independent verifier. Do not trust the claim; reproduce it yourself.',
    `CLAIM: ${statement.statement}`,
    [
      `YOUR WORKTREE: ${tree.path}, checked out at ${tree.baseSha} (the claim names ${changeLabel(statement.change)}; branch ${tree.branch}).`,
      'Your turn starts there. Reproduce the claim there only: never create other worktrees, never edit any',
      'other checkout, and do not commit.',
    ].join(' '),
    `EVIDENCE CITED: ${statement.evidence.join('; ') || '(none)'}`,
    `SUGGESTED CHECK: ${statement.howToCheck}`,
    spec.goal ? charterText(s.charter) : '',
    spec.goal
      ? 'This is a GOAL check: verify the claim AND that every judged DONE WHEN item now holds. Command checks ($ …) are run by the host, not by you.'
      : '',
    'Verified only if you reproduced it. Refuted if it is false. Unclear if you could not decide; say why.',
    answerFormat('check'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The brief for one attempt, built from the ledger as it stands. */
export function briefOf(s: State, attempt: Attempt): string {
  const { spec } = attempt;
  switch (spec.kind) {
    case 'manager':
      return managerBrief(s, attempt.id);
    case 'work':
      return workBrief(s, attempt.id, spec);
    case 'check':
      return checkBrief(s, attempt.id, spec, claimOf(s, spec));
  }
}

// ---------- Parsing answers (κ: once, at observation) ----------

const FENCE = /```json\s*([\s\S]*?)```/g;

type Json = { ok: true; value: unknown } | { ok: false; error: string };

/** Where an answer's result was read from: its last fenced block (with any text after it), or a
 * bare object that ends the answer. */
type Found =
  | { t: 'fence'; json: Json; after: string }
  | { t: 'bare'; json: Json }
  | { t: 'none'; error: string };

/**
 * The answer's result (design.md R11): a bare top-level JSON object that ends the answer after
 * the last fenced ```json block (or with no fence at all), else that last fenced block. A bare
 * final object wins over an earlier fence: 2026-11-01 review, an answer quoting a fenced snippet
 * (a config it edited, a worker's result) and ending with its own bare result parsed the snippet,
 * and lost the repair turn on it. 2026-11-01 incident: a manager answered `{"actions":[…]}` with
 * no fence and the decision was dropped. The schema check after this is unchanged and strict.
 */
function findJson(body: string): Found {
  const last = [...body.matchAll(FENCE)].at(-1);
  const tailStart = last ? (last.index ?? 0) + last[0].length : 0;
  const bare = trailingObject(body.slice(tailStart));
  if (bare) return { t: 'bare', json: bare };
  if (last) return { t: 'fence', json: parsed(last[1] ?? ''), after: body.slice(tailStart) };
  return { t: 'none', error: 'no ```json block or final JSON object' };
}

function parsed(text: string): Json {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : error}` };
  }
}

const isObject = (j: Json) => j.ok && typeof j.value === 'object' && j.value !== null;

/**
 * The bare JSON object that ends `text` (absent: none). It starts at a `{` that opens a line; the
 * first such line whose suffix parses as one object wins, so the object is the longest one. Line
 * starts only: trying every `{` re-parsed the suffix from each brace, quadratic on a large
 * brace-heavy answer (2026-11-01 review).
 */
function trailingObject(text: string): Json | undefined {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith('}')) return undefined;
  for (const m of trimmed.matchAll(/^[ \t]*\{/gm)) {
    const tried = parsed(trimmed.slice((m.index ?? 0) + m[0].length - 1));
    if (isObject(tried)) return tried;
  }
  return undefined;
}

export function parseOutcome(kind: Attempt['spec']['kind'], body: string): EndOutcome {
  const found = findJson(body);
  const malformed = (error: string): EndOutcome => ({ t: 'malformed', error, raw: body });
  if (found.t === 'none') return malformed(found.error);
  if (!found.json.ok) return malformed(found.json.error);
  const value = found.json.value;
  switch (kind) {
    case 'manager': {
      const parsed = ManagerResult.safeParse(value);
      return parsed.success
        ? { t: 'manager', actions: parsed.data.actions }
        : malformed(parsed.error.message);
    }
    case 'work': {
      const parsed = WorkResult.safeParse(value);
      return parsed.success ? { t: 'work', result: parsed.data } : malformed(parsed.error.message);
    }
    case 'check': {
      const ambiguous = verdictAmbiguity(body, found);
      if (ambiguous) return malformed(ambiguous);
      const parsed = CheckResult.safeParse(value);
      return parsed.success ? { t: 'check', result: parsed.data } : malformed(parsed.error.message);
    }
  }
}

/**
 * A check's verdict must be explicit (ported from oompa's `explicit-approval?`): exactly one
 * verdict in the answer, and it ends the answer. Oompa incident (audit 2026-11-01): its queue
 * reviewer approved on any `\bAPPROVED\b`, so "NOT APPROVED" passed; its strict parse also
 * refuses a quoted example verdict followed by the real one, and prose after the verdict. Here
 * the enum already refuses "not verified" and plain prose; this refuses the other two shapes, in
 * fences and bare objects alike (every `"verdict":` key in the answer counts), so a panel vote
 * counts only an unambiguous final verdict. Returns why it is ambiguous (none: it is not).
 */
function verdictAmbiguity(body: string, found: Found): string | undefined {
  const verdicts = body.match(/"verdict"\s*:/g)?.length ?? 0;
  if (verdicts > 1) return `${verdicts} verdicts in the answer: give exactly one verdict`;
  if (found.t === 'fence' && found.after.trim() !== '')
    return 'text follows the verdict block: the verdict must end the answer';
  return undefined;
}

/** The status view the `expedition` tool returns (and the crew answers @mentions from). */
export function statusText(s: State, badgeLine: string): string {
  return [
    badgeLine,
    s.run.t === 'waiting_owner' ? `NEEDS YOU: ${s.run.question}` : '',
    s.run.t === 'finished' ? `FINISHED: ${s.run.summary}` : '',
    s.tickFailure.t === 'failing'
      ? `HOST TROUBLE: ${s.tickFailure.failures} ticks failed in a row (last at ${s.tickFailure.at}): ${s.tickFailure.reason}`
      : '',
    charterText(s.charter),
    lessonsText(s),
    `QUESTIONS:\n${s.questions.map((q) => questionLine(s, q)).join('\n') || '- none yet'}`,
    stagesText(s),
    `ATTEMPTS:\n${s.attempts.map((a) => attemptLine(s, a)).join('\n') || '- none'}`,
    validationsText(s),
    integrationsText(s),
    costTotals(s).line,
    s.crew.t === 'ready' ? `Crew Buddy: ${s.crew.buddyId} (its DM holds every attempt).` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
