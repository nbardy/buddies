import type {
  Charter,
  CheckResult,
  ManagerAction,
  Origin,
  QuestionScope,
  WorkResult,
} from './charter';

// Pattern: pure-core (docs/patterns.md#pure-core)
// Pattern: persisted-state-machine (docs/patterns.md#persisted-state-machine)
// An expedition's ONE persisted state is its append-only ledger. `fold` derives everything else;
// decide.ts turns a state into the intent entries to append next; effects.ts names the idempotent
// writes those intents license. The host appends intents BEFORE running effects, so a crash at
// any point resumes from a ledger that explains it (expeditions/design.md).

export type WorkSpec = { kind: 'work'; questionId: string; brief: string; seat: number };
export type CheckSpec = {
  kind: 'check';
  questionId: string;
  claimAttemptId: string;
  goal: boolean;
  /** Checks planned together share a panel; the panel's majority is the verdict. */
  panelId: string;
  seat: number;
};
export type AttemptSpec = { kind: 'manager' } | WorkSpec | CheckSpec;

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

/** The workspace repository, resolved by the launch preflight; `branch` is `expedition/<id>`. */
export interface Repo {
  root: string;
  baseSha: string;
  branch: string;
}

/** Where a work attempt's worktree is (design.md R1). */
export interface WorktreeAt {
  path: string;
  branch: string;
  baseSha: string;
}

/** How a worktree ended: removed (its branch too when it had no commits), kept for its commits,
 * or left in place because removal was refused (uncommitted changes are never forced away). */
export type Release =
  | { t: 'removed'; branchDeleted: boolean }
  | { t: 'kept'; commits: number }
  | { t: 'left'; reason: string };

export type WorktreeStatus = { t: 'creating' } | { t: 'ready' } | Release;

export interface Worktree extends WorktreeAt {
  attemptId: string;
  /** The Cambium workspace name, the key that makes create and remove replayable. */
  name: string;
  status: WorktreeStatus;
}

/** The Cambium name of an attempt's worktree. */
export const worktreeName = (expeditionId: string, attemptId: string) =>
  `exp-${expeditionId}-${attemptId}`;

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
      repo: Repo;
    }
  /** `expedition/<id>` exists at the base commit (created after `launched` recorded it). */
  | { t: 'branch_ready'; at: string }
  /** Intent, written before `git cambium add`: a crash leaves a name the replay adopts. */
  | ({ t: 'worktree_creating'; at: string; attemptId: string; name: string } & WorktreeAt)
  /** Written before the work brief is posted: the brief names this path. */
  | ({ t: 'worktree_ready'; at: string; attemptId: string } & WorktreeAt)
  | { t: 'worktree_released'; at: string; attemptId: string; release: Release }
  /** The crew Buddy and the owner↔crew DM: the expedition's chat, where every update lands. */
  | { t: 'crew_ready'; at: string; buddyId: string; chatChannelId: string }
  /** The one clickable badge post in the chat the launch came from. */
  | { t: 'badge_posted'; at: string; postId: string }
  /** A manager's reflection (its `note` action), kept for the page and the chat. */
  | { t: 'reflection'; at: string; text: string }
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
      scope: QuestionScope;
      /** File custody: normalized repo-relative prefixes (charter.ts CustodyPath). */
      paths: string[];
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

export interface Attempt<S extends AttemptSpec = AttemptSpec> {
  id: string;
  spec: S;
  phase: AttemptPhase;
}

export interface Question {
  id: string;
  title: string;
  detail: string;
  scope: QuestionScope;
  paths: string[];
  status: 'open' | 'verified' | 'dead';
}

export type Run =
  | { t: 'running' }
  | { t: 'paused' }
  | { t: 'waiting_owner'; question: string }
  | { t: 'finished'; reason: FinishReason; summary: string };

/** A chat status post: written to the ledger first, then posted. */
export interface Status {
  seq: number;
  text: string;
  post: { t: 'pending' } | { t: 'posted'; postId: string };
}

export interface State {
  id: string;
  /** The launch idempotency key (see the `launched` entry). */
  key: string;
  charter: Charter;
  origin: Origin;
  launcherId: string;
  workspaceId: string;
  repo: Repo;
  branch: { t: 'pending' } | { t: 'ready' };
  /** Work attempts' worktrees, by attempt id. */
  worktrees: Record<string, Worktree>;
  launchedAt: string;
  crew: { t: 'pending' } | { t: 'ready'; buddyId: string; chatChannelId: string };
  badgePost: { t: 'pending' } | { t: 'posted'; postId: string };
  reflections: { at: string; text: string }[];
  /** Each attempt's exact instructions, by attempt id (absent until briefed). */
  briefs: Record<string, string>;
  /** Notable entries since the last chat status post. */
  news: Entry[];
  attempts: Attempt[];
  questions: Question[];
  lessons: string[];
  /** Ledger entries a manager has not yet been shown (results, feedback, rejections). */
  unseen: Entry[];
  run: Run;
  statuses: Status[];
  /** Manager attempts whose actions were applied (`manager_applied` entries). */
  appliedManagers: Set<string>;
}

export function fold(entries: readonly Entry[]): State {
  const [first, ...rest] = entries;
  if (!first || first.t !== 'launched') throw new Error('ledger must start with launched');
  const state: State = {
    id: first.id,
    key: first.key,
    charter: first.charter,
    origin: first.origin,
    launcherId: first.launcherId,
    workspaceId: first.workspaceId,
    repo: first.repo,
    branch: { t: 'pending' },
    worktrees: {},
    launchedAt: first.at,
    crew: { t: 'pending' },
    badgePost: { t: 'pending' },
    reflections: [],
    briefs: {},
    news: [],
    attempts: [],
    questions: [],
    lessons: [],
    unseen: [],
    run: { t: 'running' },
    statuses: [],
    appliedManagers: new Set(),
  };
  for (const entry of rest) apply(state, entry);
  return state;
}

// Pattern: table-driven (docs/patterns.md#table-driven) — one exhaustive handler per entry kind.
const NEWS: ReadonlySet<Entry['t']> = new Set([
  'attempt_posted',
  'attempt_ended',
  'question_added',
  'question_closed',
  'rejected',
  'reflection',
  'feedback',
  'needs_owner',
  'finished',
] satisfies Entry['t'][]);

/** Folds one entry into the state (decide applies its own intents as it writes them). */
export function apply(s: State, e: Entry): void {
  if (NEWS.has(e.t)) s.news.push(e);
  switch (e.t) {
    case 'launched':
      throw new Error('launched may only open a ledger');
    case 'branch_ready':
      s.branch = { t: 'ready' };
      return;
    case 'worktree_creating':
      s.worktrees[e.attemptId] = {
        attemptId: e.attemptId,
        name: e.name,
        path: e.path,
        branch: e.branch,
        baseSha: e.baseSha,
        status: { t: 'creating' },
      };
      return;
    case 'worktree_ready':
      Object.assign(worktreeOf(s, e.attemptId), {
        path: e.path,
        branch: e.branch,
        baseSha: e.baseSha,
        status: { t: 'ready' },
      });
      return;
    case 'worktree_released':
      worktreeOf(s, e.attemptId).status = e.release;
      return;
    case 'crew_ready':
      s.crew = { t: 'ready', buddyId: e.buddyId, chatChannelId: e.chatChannelId };
      return;
    case 'badge_posted':
      s.badgePost = { t: 'posted', postId: e.postId };
      return;
    case 'reflection':
      s.reflections.push({ at: e.at, text: e.text });
      return;
    case 'attempt_planned':
      s.attempts.push({ id: e.attemptId, spec: e.spec, phase: { t: 'planned' } });
      if (e.spec.kind === 'manager') s.unseen = [];
      return;
    case 'attempt_posting':
      attemptOf(s, e.attemptId).phase = { t: 'posting', body: e.body };
      s.briefs[e.attemptId] = e.body;
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
      s.appliedManagers.add(e.attemptId);
      return;
    case 'question_added':
      s.questions.push({
        id: e.questionId,
        title: e.title,
        detail: e.detail,
        scope: e.scope,
        paths: e.paths,
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
      s.statuses.push({ seq: e.seq, text: e.text, post: { t: 'pending' } });
      s.news = [];
      return;
    case 'status_posted': {
      const status = s.statuses.find((x) => x.seq === e.seq);
      if (!status) throw new Error(`status ${e.seq} posted before it was written`);
      status.post = { t: 'posted', postId: e.postId };
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

export const byId = <T extends { id: string }>(rows: T[], id: string) =>
  rows.find((r) => r.id === id);

/** An attempt the ledger names; a missing one is a corrupt ledger, never a skipped entry. */
export function attemptOf(s: State, id: string): Attempt {
  const attempt = byId(s.attempts, id);
  if (!attempt) throw new Error(`unknown attempt ${id}`);
  return attempt;
}
export function worktreeOf(s: State, attemptId: string): Worktree {
  const worktree = s.worktrees[attemptId];
  if (!worktree) throw new Error(`attempt ${attemptId} has no worktree`);
  return worktree;
}
export function questionOf(s: State, id: string): Question {
  const question = byId(s.questions, id);
  if (!question) throw new Error(`unknown question ${id}`);
  return question;
}
