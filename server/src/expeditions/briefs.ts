import * as m from './model';

// What each attempt is told, rebuilt from the ledger so lessons reach every later attempt.

export const CREW_ROLE = [
  'Expedition crew. Each request you receive is one attempt of an expedition: a manager decision,',
  'a work attempt, or an independent check. Do exactly that one attempt, then answer the request.',
  'Your final message MUST end with one fenced ```json block in the shape the request names.',
  'Never start other Buddies, workers or schedules. A work or check request names your git worktree, where your turn starts:',
  'work only there, never in any other checkout; never push. When mentioned in a thread, use the `expedition` tool',
  '(status) to answer questions about your expedition. The host records each owner message in your chat with the owner as',
  'steering by itself (pause, resume, stop, "lesson: …", anything else a note for the manager): just acknowledge it briefly.',
].join(' ');

const JSON_RULE = 'End your final message with exactly one fenced ```json block, nothing after it.';

const sections = (parts: string[]) => parts.filter(Boolean).join('\n\n');
const bullets = (items: string[], none: string) => items.map((x) => `- ${x}`).join('\n') || none;

function charterText(c: m.Charter): string {
  const done =
    c.done.t === 'checks'
      ? c.done.checks.map((x, i) => `- [${i}] ${m.doneCheckLabel(x)}`).join('\n')
      : '- The owner judges completion (no mechanical check).';
  return [
    `GOAL: ${c.goal}`,
    `DONE WHEN:\n${done}`,
    `IN SCOPE:\n${bullets(c.inScope, '- (not listed)')}`,
    `OUT OF SCOPE:\n${bullets(c.outOfScope, '- (not listed)')}`,
  ].join('\n\n');
}

const lessonsText = (s: m.State) =>
  s.lessons.length ? `OWNER LESSONS (binding):\n${bullets(s.lessons, '')}` : '';

function questionLine(s: m.State, q: m.Question): string {
  const after = q.after.length > 0 ? ` (after: ${q.after.join(', ')})` : '';
  return `- ${q.id} [${q.scope}/${q.status}, stage ${m.questionStage(s, q)}] ${q.title} (paths: ${q.paths.join(', ')})${after}; accepted by ${m.acceptanceLabel(q.acceptance.rule)} — ${m.attemptsOn(s, q.id).length} attempts`;
}

const questionsText = (s: m.State, none: string) =>
  `QUESTIONS:\n${s.questions.map((q) => questionLine(s, q)).join('\n') || none}`;

const attemptsText = (s: m.State, attempts: m.Attempt[]) =>
  `ATTEMPTS:\n${attempts.map((a) => `- ${a.id} ${specLine(a.spec)}: ${phaseDetail(s, a)}`).join('\n') || '- none'}`;

const validationsText = (s: m.State) =>
  `VALIDATIONS (host-run commands: a question's command acceptance on a candidate, the DONE WHEN commands on the head at done):\n${bullets(
    s.validations.map((v) => m.validationLabel(s, v)),
    '- none yet'
  )}`;

const integrationsText = (s: m.State) =>
  `INTEGRATION (the host merges validated claims into ${s.repo.branch}, one at a time; new work starts at its head):\n${bullets(
    s.integrations.map((i) => m.integrationLabel(s, i)),
    '- nothing merged yet'
  )}`;

function specLine(spec: m.AttemptSpec): string {
  switch (spec.kind) {
    case 'manager':
      return 'manager';
    case 'work':
      return `work on ${spec.questionId} (seat ${spec.seat})`;
    case 'check':
      return `check of ${spec.claimAttemptId} in panel ${spec.panelId}${spec.goal ? ' (GOAL)' : ''}`;
  }
}

function phaseDetail(s: m.State, a: m.Attempt): string {
  switch (a.phase.t) {
    case 'ended':
      return m.outcomeDetail(a.phase.outcome);
    case 'dropped':
      return `NOT STARTED (no worktree): ${a.phase.reason}`;
    case 'planned': {
      const deps = m.waitsOn(s, a);
      return deps.length > 0 ? `waiting for ${deps.join(', ')} to be verified` : 'planned';
    }
    case 'admitted':
    case 'posting':
    case 'posted':
      return a.phase.t;
  }
}

function shownLine(s: m.State, e: m.ShownEntry): string {
  switch (e.t) {
    case 'validation':
    case 'validation_failed':
      return `- ${m.validationLabel(s, m.validationOf(s, e.validationId))}`;
    case 'done_refused':
      return `- DONE REFUSED: ${e.reason}`;
    case 'integrated':
    case 'integration_refused':
      return `- ${m.integrationLabel(s, m.integrationOf(s, e.integrationId))}`;
    case 'attempt_ended':
      return `- ${e.attemptId} ended: ${m.outcomeDetail(e.outcome)}`;
    case 'tree_failed':
      return `- ${m.treeKey(e.tree)} NOT STARTED, its worktree could not be made: ${e.reason}`;
    case 'rejected':
      return `- REJECTED ${e.action.do}: ${e.reason}`;
    case 'feedback':
      return `- OWNER ${m.feedbackText(e.feedback, (text) => text)}`;
    case 'question_added':
      return `- QUESTION ADDED ${e.questionId} [${e.scope}] ${e.title} (paths: ${e.paths.join(', ')}; accepted by ${m.acceptanceLabel(e.acceptance)}): start work on it by this id`;
    case 'claim_adopted':
      return `- CLAIM ADOPTED for ${e.attemptId}: its commit is now its claim (validated or checked as its question's acceptance says)`;
    case 'claim_refused':
      return `- CLAIM REFUSED for ${e.attemptId}: ${e.reason}`;
    case 'acceptance_set':
      return `- ACCEPTANCE SET for ${e.questionId}: ${m.acceptanceLabel(e.acceptance)} (its unmerged claims are validated again under it)`;
  }
}

function managerBrief(s: m.State, id: string): string {
  const c = s.charter;
  return sections([
    `[expedition ${s.id} · ${c.name} · MANAGER]`,
    'You manage this expedition for one decision. Read the state, decide the next actions, answer.',
    charterText(c),
    lessonsText(s),
    `YOUR DIRECTORY: ${m.managerDirectory(s)} (your own detached checkout of the expedition branch head, reset before every decision). Read only: never edit or commit there; the host merges in its own tree.`,
    `LIMITS: ${m.workerAttempts(s)}/${c.maxAttempts} work and check attempts used, ${m.liveWorkers(s).length} live, ${m.queued(s).length} queued, max ${c.maxLive} live. Explore questions may use at most ${m.exploreCap(c)} work attempts. This is decision ${m.managerTurns(s)} of at most ${m.managerCap(c)}; you are woken only when there is something to act on, never to wait for the host.`,
    `CREW: work seats ${c.crew.work.map((w, i) => `${i}=${m.seatLabel(w)}`).join(', ')}. Checks run on ${c.crew.check.map(m.seatLabel).join(', ')}, never on the claim's own model; a panel of n checks verifies by majority. Spread competing approaches across seats.`,
    questionsText(s, '- none yet: plan first'),
    attemptsText(s, s.workers),
    validationsText(s),
    integrationsText(s),
    `NEW SINCE YOUR LAST DECISION:\n${s.shown[id].map((e) => shownLine(s, e)).join('\n') || '- nothing'}`,
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
    ANSWER_FORMAT.manager,
  ]);
}

const ANSWER_FORMAT: Record<m.AttemptSpec['kind'], string> = {
  manager: [
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
  ].join('\n'),
  work: [
    'ANSWER: one of',
    '{"result":"claim","statement":"<what is now true>","change":{"t":"commit","sha":"<full sha of your commit in YOUR WORKTREE>"} or {"t":"no_code"},"evidence":["<commit/file/test/number>"],"howToCheck":"<how an independent agent can verify it>"}',
    '{"result":"finding","statement":"<negative or partial result>","evidence":["…"]}',
    '{"result":"blocked","need":"<what is missing>"}',
    JSON_RULE,
  ].join('\n'),
  check: ['ANSWER: {"verdict":"verified"|"refuted"|"unclear","why":"…"}', JSON_RULE].join('\n'),
};

const REPAIR_QUOTE = 6000;

/** The one repair request a malformed answer gets (R11), on the same seat and worktree
 * (2026-11-01: a bare JSON object and a prose answer were dropped unrepaired). */
export function repairBrief(s: m.State, attempt: m.Attempt, error: string, raw: string): string {
  const quoted = raw.length > REPAIR_QUOTE ? `…${raw.slice(-REPAIR_QUOTE)}` : raw;
  return [
    `[expedition ${s.id} · ${s.charter.name} · REPAIR ${attempt.id}]`,
    `Your answer to attempt ${attempt.id} could not be read (${error}). Do not redo the work: reply with the same result in the required format. Your answer must end with the json block.`,
    ANSWER_FORMAT[attempt.spec.kind],
    `YOUR PREVIOUS ANSWER:\n${quoted}`,
  ].join('\n\n');
}

function workBrief(s: m.State, id: string, spec: m.WorkSpec): string {
  const q = m.questionOf(s, spec.questionId);
  const tree = m.worktreeOf(s, id);
  // The derived verifications: a claim a later panel refuted is not listed.
  const verified = m.verifications(s).map((v) => `- ${verificationLine(v)}`);
  const findings = s.workers.flatMap((x) =>
    x.phase.t === 'ended' &&
    x.phase.outcome.t === 'work' &&
    x.phase.outcome.result.result !== 'blocked'
      ? [`- ${x.id}: ${m.outcomeDetail(x.phase.outcome)}`]
      : []
  );
  return sections([
    `[expedition ${s.id} · ${s.charter.name} · WORK ${id}]`,
    charterText(s.charter),
    lessonsText(s),
    `YOUR QUESTION (${q.id}): ${q.title}\n${q.detail}`,
    `YOUR BRIEF:\n${spec.brief}`,
    [
      `YOUR WORKTREE: ${tree.path} (branch ${tree.branch}, based on ${tree.baseSha}).`,
      'Your turn starts there. Work and commit ONLY in that directory, on that branch. Never edit any other',
      `checkout. Your files: ${q.paths.join(', ')}. A code claim must name its commit's full sha.`,
      `Your claim is accepted by ${m.acceptanceLabel(q.acceptance.rule)}.`,
    ].join(' '),
    `WHAT OTHERS FOUND:\n${findings.join('\n') || '- nothing yet'}${verified.length ? `\n${verified.join('\n')}` : ''}`,
    [
      'RULES: stay inside your question. Commit before you claim, and cite the files and tests as',
      'evidence. Before you start, state your',
      'approach and what result you predict; report honestly if the prediction failed.',
    ].join(' '),
    ANSWER_FORMAT.work,
  ]);
}

const verificationLine = (v: m.Verification) =>
  `${v.claimAttemptId}'s claim on ${v.questionId} verified by ${v.t === 'panel' ? `check panel ${v.panelId}` : 'the host (its command passed) and merged'}`;

function checkBrief(s: m.State, id: string, spec: m.CheckSpec, statement: m.Claim): string {
  const tree = m.worktreeOf(s, id);
  return sections([
    `[expedition ${s.id} · ${s.charter.name} · CHECK ${id}]`,
    'You are an independent verifier. Do not trust the claim; reproduce it yourself.',
    `CLAIM: ${statement.statement}`,
    [
      `YOUR WORKTREE: ${tree.path}, checked out at ${tree.baseSha} (the claim names ${m.changeLabel(statement.change)}; branch ${tree.branch}).`,
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
    ANSWER_FORMAT.check,
  ]);
}

export function briefOf(s: m.State, attempt: m.Attempt): string {
  const { spec } = attempt;
  switch (spec.kind) {
    case 'manager':
      return managerBrief(s, attempt.id);
    case 'work':
      return workBrief(s, attempt.id, spec);
    case 'check':
      return checkBrief(s, attempt.id, spec, m.claimOf(s, spec));
  }
}

export function statusText(s: m.State, badgeLine: string): string {
  const { run, tickFailure: fail } = s;
  return sections([
    badgeLine,
    run.t === 'waiting_owner' ? `NEEDS YOU: ${run.question}` : '',
    run.t === 'finished' ? `FINISHED: ${run.summary}` : '',
    fail.t === 'failing'
      ? `HOST TROUBLE: ${fail.failures} ticks failed in a row (last at ${fail.at}): ${fail.reason}`
      : '',
    charterText(s.charter),
    lessonsText(s),
    questionsText(s, '- none yet'),
    stagesText(s),
    attemptsText(s, m.allAttempts(s)),
    validationsText(s),
    integrationsText(s),
    m.costTotals(s).line,
    s.crew.t === 'ready' ? `Crew Buddy: ${s.crew.buddyId} (its DM holds every attempt).` : '',
  ]);
}

function stagesText(s: m.State): string {
  const counts = new Map<string, number>();
  for (const q of s.questions) {
    const stage = m.questionStage(s, q);
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  return counts.size === 0
    ? ''
    : `STAGES: ${[...counts].map(([stage, n]) => `${n} ${stage}`).join(', ')}`;
}
