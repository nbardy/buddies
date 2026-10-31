import { z } from 'zod';

// Pattern: pure-core (docs/patterns.md#pure-core)
// Pattern: persisted-state-machine (docs/patterns.md#persisted-state-machine)
// An expedition's ONE persisted state is its append-only ledger. `fold` derives everything else;
// `decide` turns a state into the intent entries to append next; `pendingEffects` names the
// idempotent writes those intents license. The host appends intents BEFORE running effects, so a
// crash at any point resumes from a ledger that explains it (expeditions/design.md).

// ---------- Charter (the owner's WHAT; reflection never edits it) ----------

export const WorkerConfig = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
  })
  .strict();

export type WorkerConfig = z.infer<typeof WorkerConfig>;

/** Who runs each attempt kind. Work and check seats are rosters: the manager picks a work seat;
 * the engine seats every check on a model other than the claim's author (blind and independent). */
export const Crew = z
  .object({
    manager: WorkerConfig,
    work: z.array(WorkerConfig).min(1).max(4),
    check: z.array(WorkerConfig).min(1).max(4),
  })
  .strict();

export const Done = z.union([
  z.object({ checks: z.array(z.string().trim().min(1)).min(1).max(10) }).strict(),
  z.object({ ownerJudgment: z.literal(true) }).strict(),
]);

export const Charter = z
  .object({
    name: z.string().trim().min(1).max(60),
    goal: z.string().trim().min(1).max(4000),
    done: Done,
    inScope: z.array(z.string().trim().min(1)).max(20),
    outOfScope: z.array(z.string().trim().min(1)).max(20),
    maxAttempts: z.number().int().min(2).max(60),
    maxLive: z.number().int().min(1).max(8),
    hours: z.number().min(0.25).max(72),
    exploreShare: z.number().min(0).max(0.5),
    crew: Crew,
  })
  .strict();
export type Charter = z.infer<typeof Charter>;

/** Where status posts go: the thread the launch came from, or the owner↔launcher DM. */
export type Origin = { t: 'thread'; channelId: string; rootId: string } | { t: 'direct' };

// ---------- Attempt results (parsed once, at observation) ----------

export const WorkResult = z.union([
  z
    .object({
      result: z.literal('claim'),
      statement: z.string().min(1),
      evidence: z.array(z.string()),
      howToCheck: z.string().min(1),
    })
    .strict(),
  z
    .object({
      result: z.literal('finding'),
      statement: z.string().min(1),
      evidence: z.array(z.string()),
    })
    .strict(),
  z.object({ result: z.literal('blocked'), need: z.string().min(1) }).strict(),
]);
export type WorkResult = z.infer<typeof WorkResult>;

export const CheckResult = z
  .object({ verdict: z.enum(['verified', 'refuted', 'unclear']), why: z.string().min(1) })
  .strict();
export type CheckResult = z.infer<typeof CheckResult>;

const ref = z.string().min(1);
export const ManagerAction = z.discriminatedUnion('do', [
  z
    .object({
      do: z.literal('add_question'),
      title: z.string().min(1).max(200),
      detail: z.string().min(1).max(2000),
      scope: z.enum(['in', 'explore', 'parked']),
    })
    .strict(),
  z
    .object({
      do: z.literal('work'),
      question: ref,
      seat: z.number().int().min(0),
      brief: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      do: z.literal('check'),
      claimAttempt: ref,
      goal: z.boolean(),
      panel: z.number().int().min(1).max(3),
    })
    .strict(),
  z
    .object({
      do: z.literal('close_question'),
      question: ref,
      status: z.enum(['verified', 'dead']),
      why: z.string().min(1),
    })
    .strict(),
  z.object({ do: z.literal('ask_owner'), question: z.string().min(1) }).strict(),
  z.object({ do: z.literal('done'), summary: z.string().min(1) }).strict(),
  z.object({ do: z.literal('note'), text: z.string().min(1).max(2000) }).strict(),
]);
export type ManagerAction = z.infer<typeof ManagerAction>;
export const ManagerResult = z.object({ actions: z.array(ManagerAction).max(30) }).strict();

export type AttemptSpec =
  | { kind: 'manager' }
  | { kind: 'work'; questionId: string; brief: string; seat: number }
  | {
      kind: 'check';
      questionId: string;
      claimAttemptId: string;
      goal: boolean;
      /** Checks planned together share a panel; the panel's majority is the verdict. */
      panelId: string;
      seat: number;
    };

/** What an ended attempt produced. `malformed` and `failed` are data, never silently dropped. */
export type Outcome =
  | { t: 'manager'; actions: ManagerAction[] }
  | { t: 'work'; result: WorkResult }
  | { t: 'check'; result: CheckResult }
  | { t: 'malformed'; error: string; raw: string }
  | { t: 'failed'; status: 'failed' | 'cancelled' };

export type Feedback =
  | { t: 'lesson'; text: string }
  | { t: 'note'; text: string }
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'stop' };

export type FinishReason = 'done' | 'attempts_spent' | 'deadline' | 'owner_stop';

// ---------- Ledger ----------

export type Entry =
  | {
      t: 'launched';
      at: string;
      id: string;
      /** Idempotency: one launch per (conversation, name); a retried tool call returns it. */
      key: string;
      charter: Charter;
      origin: Origin;
      launcherId: string;
      workspaceId: string;
    }
  | { t: 'crew_ready'; at: string; buddyId: string }
  | { t: 'attempt_planned'; at: string; attemptId: string; spec: AttemptSpec }
  /** The exact brief, written before the request post so a replay sends identical bytes. */
  | { t: 'attempt_posting'; at: string; attemptId: string; body: string }
  | { t: 'attempt_posted'; at: string; attemptId: string; requestId: string }
  | { t: 'attempt_ended'; at: string; attemptId: string; outcome: Outcome }
  | {
      t: 'question_added';
      at: string;
      questionId: string;
      title: string;
      detail: string;
      scope: 'in' | 'explore' | 'parked';
    }
  | {
      t: 'question_closed';
      at: string;
      questionId: string;
      status: 'verified' | 'dead';
      why: string;
    }
  | { t: 'manager_applied'; at: string; attemptId: string }
  | { t: 'rejected'; at: string; action: ManagerAction; reason: string }
  | { t: 'feedback'; at: string; from: string; feedback: Feedback }
  | { t: 'needs_owner'; at: string; question: string }
  | { t: 'status'; at: string; seq: number; text: string }
  | { t: 'status_posted'; at: string; seq: number; postId: string }
  | { t: 'finished'; at: string; reason: FinishReason; summary: string };

// ---------- Derived state ----------

export type AttemptPhase =
  | { t: 'planned' }
  | { t: 'posting'; body: string }
  | { t: 'posted'; requestId: string }
  | { t: 'ended'; requestId: string; outcome: Outcome };

export interface Attempt {
  id: string;
  spec: AttemptSpec;
  phase: AttemptPhase;
}

export interface Question {
  id: string;
  title: string;
  detail: string;
  scope: 'in' | 'explore' | 'parked';
  status: 'open' | 'verified' | 'dead';
}

export type Run =
  | { t: 'running' }
  | { t: 'paused' }
  | { t: 'waiting_owner'; question: string }
  | { t: 'finished'; reason: FinishReason; summary: string };

export interface State {
  id: string;
  charter: Charter;
  origin: Origin;
  launcherId: string;
  workspaceId: string;
  launchedAt: string;
  crew: { t: 'pending' } | { t: 'ready'; buddyId: string };
  attempts: Attempt[];
  questions: Question[];
  lessons: string[];
  /** Ledger entries a manager has not yet been shown (results, feedback, rejections). */
  unseen: Entry[];
  run: Run;
  statuses: { seq: number; text: string; postId: string | null }[];
  /** The newest manager attempt whose actions were applied (a `manager_applied` entry). */
  appliedManager: string;
}

const byId = <T extends { id: string }>(rows: T[], id: string) => rows.find((r) => r.id === id);

export function fold(entries: readonly Entry[]): State {
  const [first, ...rest] = entries;
  if (!first || first.t !== 'launched') throw new Error('ledger must start with launched');
  const state: State = {
    id: first.id,
    charter: first.charter,
    origin: first.origin,
    launcherId: first.launcherId,
    workspaceId: first.workspaceId,
    launchedAt: first.at,
    crew: { t: 'pending' },
    attempts: [],
    questions: [],
    lessons: [],
    unseen: [],
    run: { t: 'running' },
    statuses: [],
    appliedManager: '',
  };
  for (const entry of rest) apply(state, entry);
  return state;
}

// Pattern: table-driven (docs/patterns.md#table-driven) — one exhaustive handler per entry kind.
function apply(s: State, e: Entry): void {
  switch (e.t) {
    case 'launched':
      throw new Error('launched may only open a ledger');
    case 'crew_ready':
      s.crew = { t: 'ready', buddyId: e.buddyId };
      return;
    case 'attempt_planned':
      s.attempts.push({ id: e.attemptId, spec: e.spec, phase: { t: 'planned' } });
      if (e.spec.kind === 'manager') s.unseen = [];
      return;
    case 'attempt_posting':
      attemptOf(s, e.attemptId).phase = { t: 'posting', body: e.body };
      return;
    case 'attempt_posted':
      attemptOf(s, e.attemptId).phase = { t: 'posted', requestId: e.requestId };
      return;
    case 'attempt_ended': {
      const attempt = attemptOf(s, e.attemptId);
      if (attempt.phase.t !== 'posted') throw new Error(`attempt ${e.attemptId} ended unposted`);
      attempt.phase = { t: 'ended', requestId: attempt.phase.requestId, outcome: e.outcome };
      // A manager's actions are applied, not shown back; its malformed or failed end is shown,
      // so the next manager turn retries instead of the expedition going quiet.
      if (
        attempt.spec.kind !== 'manager' ||
        e.outcome.t === 'malformed' ||
        e.outcome.t === 'failed'
      )
        s.unseen.push(e);
      return;
    }
    case 'manager_applied':
      s.appliedManager = e.attemptId;
      return;
    case 'question_added':
      s.questions.push({
        id: e.questionId,
        title: e.title,
        detail: e.detail,
        scope: e.scope,
        status: 'open',
      });
      return;
    case 'question_closed':
      questionOf(s, e.questionId).status = e.status;
      return;
    case 'rejected':
      s.unseen.push(e);
      return;
    case 'feedback':
      applyFeedback(s, e);
      return;
    case 'needs_owner':
      s.run = { t: 'waiting_owner', question: e.question };
      return;
    case 'status':
      s.statuses.push({ seq: e.seq, text: e.text, postId: null });
      return;
    case 'status_posted': {
      const status = s.statuses.find((x) => x.seq === e.seq);
      if (!status) throw new Error(`status ${e.seq} posted before it was written`);
      status.postId = e.postId;
      return;
    }
    case 'finished':
      s.run = { t: 'finished', reason: e.reason, summary: e.summary };
      return;
  }
}

function applyFeedback(s: State, e: Extract<Entry, { t: 'feedback' }>): void {
  if (s.run.t === 'finished') return;
  switch (e.feedback.t) {
    case 'lesson':
      s.lessons.push(e.feedback.text);
      s.unseen.push(e);
      if (s.run.t === 'waiting_owner') s.run = { t: 'running' };
      return;
    case 'note':
      s.unseen.push(e);
      if (s.run.t === 'waiting_owner') s.run = { t: 'running' };
      return;
    case 'pause':
      s.run = { t: 'paused' };
      return;
    case 'resume':
      s.run = { t: 'running' };
      return;
    case 'stop':
      // `finished` is appended by decide, so the stop is recorded with its reason.
      s.unseen.push(e);
      return;
  }
}

function attemptOf(s: State, id: string): Attempt {
  const attempt = byId(s.attempts, id);
  if (!attempt) throw new Error(`unknown attempt ${id}`);
  return attempt;
}
function questionOf(s: State, id: string): Question {
  const question = byId(s.questions, id);
  if (!question) throw new Error(`unknown question ${id}`);
  return question;
}

// ---------- Views over state ----------

export const live = (s: State) =>
  s.attempts.filter((a) => a.phase.t === 'posted' || a.phase.t === 'posting');
export const liveWorkers = (s: State) => live(s).filter((a) => a.spec.kind !== 'manager');
export const queued = (s: State) => s.attempts.filter((a) => a.phase.t === 'planned');
const exploreAttempts = (s: State) =>
  s.attempts.filter(
    (a) => a.spec.kind === 'work' && byId(s.questions, a.spec.questionId)?.scope === 'explore'
  ).length;
export const exploreCap = (c: Charter) => Math.floor(c.exploreShare * c.maxAttempts);

export type CheckAttempt = Attempt & { spec: Extract<AttemptSpec, { kind: 'check' }> };
const checks = (s: State): CheckAttempt[] =>
  s.attempts.filter((a): a is CheckAttempt => a.spec.kind === 'check');

export interface Panel {
  id: string;
  questionId: string;
  claimAttemptId: string;
  goal: boolean;
  verdict: 'pending' | 'verified' | 'not_verified';
}

/** A panel is verified when a strict majority of its checks verified the claim. */
export function panels(s: State): Panel[] {
  const out = new Map<string, CheckAttempt[]>();
  for (const c of checks(s)) out.set(c.spec.panelId, [...(out.get(c.spec.panelId) ?? []), c]);
  return [...out.entries()].map(([id, members]) => {
    const first = members[0].spec;
    const ended = members.every((m) => m.phase.t === 'ended');
    const yes = members.filter(
      (m) =>
        m.phase.t === 'ended' &&
        m.phase.outcome.t === 'check' &&
        m.phase.outcome.result.verdict === 'verified'
    ).length;
    return {
      id,
      questionId: first.questionId,
      claimAttemptId: first.claimAttemptId,
      goal: first.goal,
      verdict: !ended ? 'pending' : yes * 2 > members.length ? 'verified' : 'not_verified',
    };
  });
}
export const verifiedPanels = (s: State) => panels(s).filter((p) => p.verdict === 'verified');

const goalVerified = (s: State) =>
  panels(s)
    .filter((p) => p.goal)
    .at(-1)?.verdict === 'verified';
const questionVerified = (s: State, questionId: string) =>
  verifiedPanels(s).some((p) => p.questionId === questionId);

/** The roster seat an attempt runs on. */
export function configOf(c: Charter, spec: AttemptSpec): WorkerConfig {
  switch (spec.kind) {
    case 'manager':
      return c.crew.manager;
    case 'work':
      return c.crew.work[spec.seat];
    case 'check':
      return c.crew.check[spec.seat];
  }
}
const sameModel = (a: WorkerConfig, b: WorkerConfig) =>
  a.provider === b.provider && (a.model ?? '') === (b.model ?? '');

// ---------- decide: state → intent entries ----------

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
    return withStatus(s, out, clock);
  }
  const deadline = Date.parse(s.launchedAt) + s.charter.hours * 3_600_000;
  if (Date.parse(at) >= deadline) {
    push({ t: 'finished', at, reason: 'deadline', summary: 'Deadline reached.' });
    return withStatus(s, out, clock);
  }

  const pending = pendingManager(s);
  if (pending) {
    for (const action of pending.actions) applyAction(s, action, clock, push);
    push({ t: 'manager_applied', at, attemptId: pending.attemptId });
  }
  // Re-read through a call: applyAction mutates s.run, which TS's narrowing above cannot see.
  const now = phaseOf(s);
  if (now === 'finished' || now === 'paused') return withStatus(s, out, clock);

  if (s.attempts.length >= s.charter.maxAttempts && live(s).length === 0) {
    push({
      t: 'finished',
      at,
      reason: 'attempts_spent',
      summary: `All ${s.charter.maxAttempts} attempts used; ${verifiedPanels(s).length} claims verified.`,
    });
    return withStatus(s, out, clock);
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
  return withStatus(s, out, clock);
}

const phaseOf = (s: State): Run['t'] => s.run.t;

/** The newest ended manager attempt whose actions are not yet applied. */
function pendingManager(s: State): { attemptId: string; actions: ManagerAction[] } | undefined {
  const last = s.attempts.filter((a) => a.spec.kind === 'manager').at(-1);
  if (!last || last.phase.t !== 'ended' || last.phase.outcome.t !== 'manager') return undefined;
  if (s.appliedManager === last.id) return undefined;
  return { attemptId: last.id, actions: last.phase.outcome.actions };
}

function applyAction(
  s: State,
  action: ManagerAction,
  clock: Clock,
  push: (e: Entry) => void
): undefined {
  const at = clock.now;
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
      const author = configOf(s.charter, claim.spec);
      const seats = s.charter.crew.check
        .map((config, seat) => ({ config, seat }))
        .filter((x) => !sameModel(x.config, author));
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
      return;
  }
}

// ---------- Status (the badge) ----------

export function badge(s: State, now: string): string {
  const mins = Math.round((Date.parse(now) - Date.parse(s.launchedAt)) / 60_000);
  const elapsed = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`;
  const phase =
    s.run.t === 'running'
      ? 'running'
      : s.run.t === 'paused'
        ? 'paused'
        : s.run.t === 'waiting_owner'
          ? 'needs you'
          : `finished (${s.run.reason})`;
  return `⛺ ${s.charter.name} · ${phase} · ${liveWorkers(s).length} live · ${verifiedPanels(s).length} verified · ${s.attempts.length}/${s.charter.maxAttempts} attempts · ${elapsed}`;
}

/** Milestones worth a thread post: launch, first plan, a verification, owner needed, finish. */
function withStatus(s: State, out: Entry[], clock: Clock): Entry[] {
  const lines: string[] = [];
  for (const e of out) {
    if (e.t === 'needs_owner') lines.push(`Needs you: ${e.question}`);
    if (e.t === 'finished') lines.push(`Finished (${e.reason}): ${e.summary}`);
    if (e.t === 'question_closed' && e.status === 'verified')
      lines.push(`Verified: ${questionOf(s, e.questionId).title}`);
  }
  const added = out.filter((e) => e.t === 'question_added');
  if (added.length > 0 && s.statuses.length === 1)
    lines.push(`Plan:\n${s.questions.map((q) => `- [${q.scope}] ${q.title}`).join('\n')}`);
  if (lines.length === 0) return out;
  const status: Entry = {
    t: 'status',
    at: clock.now,
    seq: s.statuses.length,
    text: `${badge(s, clock.now)}\n${lines.join('\n')}`,
  };
  apply(s, status);
  return [...out, status];
}

// ---------- Effects licensed by the state ----------

export type Effect =
  | { t: 'create_crew' }
  /** Build and record the brief (then post it). */
  | { t: 'brief_attempt'; attempt: Attempt }
  /** Post a recorded brief: the replay path after a crash between record and post. */
  | { t: 'post_attempt'; attemptId: string; body: string }
  | { t: 'post_status'; seq: number; text: string };

export function pendingEffects(s: State): Effect[] {
  if (s.crew.t === 'pending') return [{ t: 'create_crew' }];
  const effects: Effect[] = s.statuses
    .filter((x) => x.postId === null)
    .map((x) => ({ t: 'post_status', seq: x.seq, text: x.text }));
  if (s.run.t === 'finished' || s.run.t === 'paused') return effects;
  for (const attempt of s.attempts)
    if (attempt.phase.t === 'posting')
      effects.push({ t: 'post_attempt', attemptId: attempt.id, body: attempt.phase.body });
  let capacity = s.charter.maxLive - liveWorkers(s).length;
  for (const attempt of queued(s)) {
    if (attempt.spec.kind === 'manager') effects.push({ t: 'brief_attempt', attempt });
    else if (capacity > 0) {
      capacity -= 1;
      effects.push({ t: 'brief_attempt', attempt });
    }
  }
  return effects;
}
