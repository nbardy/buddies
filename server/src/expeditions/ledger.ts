import type {
  Charter,
  CheckResult,
  CommandCheck,
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

/**
 * What an ended attempt cost (design.md R6), read once its Buddy run(s) settled (host meter.ts).
 * `measured`: the provider-counted tokens of every session the attempt's run conversations bound,
 * retries included. No USD: only an estimate could price them, and nothing here is estimated.
 * `unmeasured`: why no count exists (a provider that records none, a run that never executed).
 */
export type AttemptCost =
  | {
      t: 'measured';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | { t: 'unmeasured'; reason: string };

export type Feedback =
  | { t: 'lesson'; text: string }
  | { t: 'note'; text: string }
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'stop' };

/** Where owner feedback came from: the `expedition` tool's steer, or an owner message in the
 * expedition chat (the owner↔crew DM). A chat message carries its post id and ordered id, so the
 * host records each one once and reads only newer ones (host.ts observeChat). */
export type FeedbackVia = { t: 'tool' } | { t: 'chat'; postId: string; ord: string };

/** The newest owner chat message already recorded as feedback. */
export type ChatCursor = { t: 'start' } | { t: 'after'; ord: string };

/** `setup_failed`: the expedition's integration worktree could not be made (design.md R3).
 * `decisions_spent`: the manager-decision cap (queries.ts managerCap) ran out (design.md R9). */
export type FinishReason =
  | 'done'
  | 'attempts_spent'
  | 'decisions_spent'
  | 'deadline'
  | 'owner_stop'
  | 'setup_failed';

/** The workspace repository, resolved by the launch preflight; `branch` is `expedition/<id>`. */
export interface Repo {
  root: string;
  baseSha: string;
  branch: string;
}

/** The expedition's own integration worktree (design.md R3): one Cambium workspace on
 * `repo.branch`, created at `repo.baseSha`. Its name and path are written in `launched`, so the
 * launch entry is the intent the create replays from. */
export interface IntegrationTreeAt {
  name: string;
  path: string;
}

/** Where a worker attempt's worktree is (design.md R1): a work attempt's starts at the expedition
 * branch head, a check's at the commit its claim names. */
export interface WorktreeAt {
  path: string;
  branch: string;
  baseSha: string;
}

/** How a worktree ended: removed (its branch too when it had no commits), kept for its commits,
 * absent (Cambium has no such workspace and nothing of it is left: never made, or a replayed
 * removal), or left in place because removal was refused (uncommitted changes are never forced
 * away) or a partial create left a branch or directory Cambium could not roll back. */
export type Release =
  | { t: 'removed'; branchDeleted: boolean }
  | { t: 'kept'; commits: number }
  | { t: 'absent' }
  | { t: 'left'; reason: string };

/** `failed`: the worktree could not be made (its attempt is dropped, never briefed). */
export type WorktreeStatus =
  | { t: 'creating' }
  | { t: 'ready' }
  | { t: 'failed'; reason: string }
  | Release;

export interface Worktree extends WorktreeAt {
  attemptId: string;
  /** The Cambium workspace name, the key that makes create and remove replayable. */
  name: string;
  status: WorktreeStatus;
}

/** The Cambium name of a worker attempt's or a validation's worktree. */
export const worktreeName = (expeditionId: string, attemptId: string) =>
  `exp-${expeditionId}-${attemptId}`;

// ---------- Validations (design.md R2) ----------

/** What a validation runs the charter's command checks against: a claim's immutable candidate
 * commit, or the expedition branch head when the manager asks done (resolved by the host). */
export type ValidationTarget =
  | { t: 'candidate'; claimAttemptId: string; sha: string }
  | { t: 'head' };

/** One command check's result. The output tail is bounded (command.ts TAIL_CHARS). */
export type CheckOutcome =
  | { t: 'passed' }
  | { t: 'failed'; exitCode: number; tail: string }
  | { t: 'timed_out'; tail: string }
  | { t: 'error'; message: string };

export interface CheckRun {
  /** The check's index in `charter.done.checks` (only `command` checks run). */
  checkIndex: number;
  outcome: CheckOutcome;
}

export type ValidationPhase =
  | { t: 'planned' }
  /** The host resolved the target and recorded its fresh worktree before creating it. */
  | {
      t: 'started';
      targetSha: string;
      tree: WorktreeAt & { name: string };
      treeStatus: WorktreeStatus;
    };

export interface Validation {
  id: string;
  target: ValidationTarget;
  phase: ValidationPhase;
  runs: CheckRun[];
}

// ---------- Integration (design.md R3) ----------

/** Why a candidate was not merged; every refusal names its phase. `merge`: git reported
 * conflicts in `paths` (the merge was aborted); `git`: git refused for another reason (aborted
 * too); `tree`: the integration worktree was not clean on its branch, so nothing was attempted. */
export type IntegrationRefusal =
  | { phase: 'merge'; paths: string[] }
  | { phase: 'git'; reason: string }
  | { phase: 'tree'; reason: string };

export type IntegrationStatus =
  | { t: 'pending' }
  | { t: 'integrated'; mergeSha: string }
  | { t: 'refused'; refusal: IntegrationRefusal };

/** One candidate commit to merge into the expedition branch, in the order the manager asked. */
export interface Integration {
  id: string;
  claimAttemptId: string;
  sha: string;
  status: IntegrationStatus;
}

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
      integrationTree: IntegrationTreeAt;
    }
  /** The integration worktree exists on `expedition/<id>` (made after `launched` named it). */
  | { t: 'integration_tree_ready'; at: string }
  /** It could not be made: the expedition finishes `setup_failed` with the reason. */
  | { t: 'integration_tree_failed'; at: string; reason: string }
  /** Removed at finish; the branch always stays (it is what the owner merges). */
  | { t: 'integration_tree_released'; at: string; release: Release }
  /** Decide's intent, before the merge: integrate this claim's validated commit. */
  | {
      t: 'integration_planned';
      at: string;
      integrationId: string;
      claimAttemptId: string;
      sha: string;
    }
  | { t: 'integrated'; at: string; integrationId: string; sha: string; mergeSha: string }
  | {
      t: 'integration_refused';
      at: string;
      integrationId: string;
      sha: string;
      refusal: IntegrationRefusal;
    }
  /** Intent, written before `git cambium add`: a crash leaves a name the replay adopts. */
  | ({ t: 'worktree_creating'; at: string; attemptId: string; name: string } & WorktreeAt)
  /** Written before the work brief is posted: the brief names this path. */
  | ({ t: 'worktree_ready'; at: string; attemptId: string } & WorktreeAt)
  /** `cambium add` failed (git.ts rolled back what it could): the attempt is dropped. */
  | { t: 'worktree_failed'; at: string; attemptId: string; reason: string }
  | { t: 'worktree_released'; at: string; attemptId: string; release: Release }
  /** Decide's intent: validate a target (a claim's commit as soon as it ends; the head at done). */
  | { t: 'validation_planned'; at: string; validationId: string; target: ValidationTarget }
  /** Host intent, before `cambium add`: the resolved sha (the tree's base) and the tree's name. */
  | ({ t: 'validation_started'; at: string; validationId: string; name: string } & WorktreeAt)
  | { t: 'validation_tree_ready'; at: string; validationId: string }
  /** No tree: every command check is recorded as `error` in the same append. */
  | { t: 'validation_tree_failed'; at: string; validationId: string; reason: string }
  /** One command check ran (host only; never an agent's report). */
  | {
      t: 'validation';
      at: string;
      validationId: string;
      targetSha: string;
      checkIndex: number;
      outcome: CheckOutcome;
    }
  | { t: 'validation_released'; at: string; validationId: string; release: Release }
  /** A manager's done awaiting the head validation (written with its `validation_planned`). */
  | { t: 'done_requested'; at: string; validationId: string; summary: string }
  /** The head validation (or the goal panel) did not hold: the manager is shown why. */
  | { t: 'done_refused'; at: string; reason: string }
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
  /** Its settled run's measured cost, or why there is none (never an estimate). */
  | { t: 'attempt_metered'; at: string; attemptId: string; cost: AttemptCost }
  | {
      t: 'question_added';
      at: string;
      questionId: string;
      title: string;
      detail: string;
      scope: QuestionScope;
      /** File custody: normalized repo-relative prefixes (charter.ts CustodyPath). */
      paths: string[];
      /** Question ids whose verified close this question's work waits for (design.md R5). */
      after: string[];
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
  | { t: 'feedback'; at: string; from: string; via: FeedbackVia; feedback: Feedback }
  | { t: 'needs_owner'; at: string; question: string }
  | { t: 'status'; at: string; seq: number; text: string }
  | { t: 'status_posted'; at: string; seq: number; postId: string }
  | { t: 'finished'; at: string; reason: FinishReason; summary: string };

// ---------- Derived state ----------

export type AttemptPhase =
  | { t: 'planned' }
  /** A worker attempt whose worktree intent is recorded: it holds a slot and its custody. */
  | { t: 'admitted' }
  /** Never started: its worktree could not be made (`worktree_failed`). */
  | { t: 'dropped'; reason: string }
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
  /** Dependencies: work on this question is admitted only once each is closed verified. */
  after: string[];
  status: 'open' | 'verified' | 'dead';
}

export type Run =
  | { t: 'running' }
  | { t: 'paused' }
  | { t: 'waiting_owner'; question: string }
  /** `at`: when it finished, so the page shows how long it took (not time left). */
  | { t: 'finished'; reason: FinishReason; summary: string; at: string };

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
  /** The integration worktree on `repo.branch` (its base is `repo.baseSha`). */
  integrationTree: WorktreeAt & IntegrationTreeAt & { status: WorktreeStatus };
  /** Candidate merges into `repo.branch`, in plan order (run one at a time). */
  integrations: Integration[];
  /** Worker (work and check) attempts' worktrees, by attempt id. */
  worktrees: Record<string, Worktree>;
  /** Host-run command-check validations, in plan order (run one at a time). */
  validations: Validation[];
  /** A manager's done waits on its head validation; `finished` or `done_refused` settles it. */
  doneRequest: { t: 'none' } | { t: 'validating'; validationId: string; summary: string };
  launchedAt: string;
  crew: { t: 'pending' } | { t: 'ready'; buddyId: string; chatChannelId: string };
  badgePost: { t: 'pending' } | { t: 'posted'; postId: string };
  reflections: { at: string; text: string }[];
  /** Each attempt's exact instructions, by attempt id (absent until briefed). */
  briefs: Record<string, string>;
  /** Each ended attempt's cost, by attempt id (absent until its run settled and was metered). */
  costs: Record<string, AttemptCost>;
  /** Notable entries since the last chat status post. */
  news: Entry[];
  attempts: Attempt[];
  questions: Question[];
  lessons: string[];
  chatCursor: ChatCursor;
  /** Ledger entries a manager has not yet been shown (results, feedback, rejections). */
  unseen: Entry[];
  /** What each manager attempt is shown: the unseen entries at the moment it was planned. */
  shown: Record<string, Entry[]>;
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
    integrationTree: {
      name: first.integrationTree.name,
      path: first.integrationTree.path,
      branch: first.repo.branch,
      baseSha: first.repo.baseSha,
      status: { t: 'creating' },
    },
    integrations: [],
    worktrees: {},
    validations: [],
    doneRequest: { t: 'none' },
    launchedAt: first.at,
    crew: { t: 'pending' },
    badgePost: { t: 'pending' },
    reflections: [],
    briefs: {},
    costs: {},
    news: [],
    attempts: [],
    questions: [],
    lessons: [],
    chatCursor: { t: 'start' },
    unseen: [],
    shown: {},
    run: { t: 'running' },
    statuses: [],
    appliedManagers: new Set(),
  };
  for (const entry of rest) apply(state, entry);
  return state;
}

// Pattern: table-driven (docs/patterns.md#table-driven) — one exhaustive handler per entry kind.
const NEWS: ReadonlySet<Entry['t']> = new Set([
  'attempt_planned',
  'attempt_posted',
  'worktree_failed',
  'attempt_ended',
  'question_added',
  'question_closed',
  'rejected',
  'reflection',
  'feedback',
  'needs_owner',
  'validation',
  'done_requested',
  'done_refused',
  'integrated',
  'integration_refused',
  'finished',
] satisfies Entry['t'][]);

/** Folds one entry into the state (decide applies its own intents as it writes them). */
export function apply(s: State, e: Entry): void {
  if (NEWS.has(e.t)) s.news.push(e);
  switch (e.t) {
    case 'launched':
      throw new Error('launched may only open a ledger');
    case 'integration_tree_ready':
      s.integrationTree.status = { t: 'ready' };
      return;
    case 'integration_tree_failed':
      s.integrationTree.status = { t: 'failed', reason: e.reason };
      return;
    case 'integration_tree_released':
      s.integrationTree.status = e.release;
      return;
    case 'integration_planned':
      s.integrations.push({
        id: e.integrationId,
        claimAttemptId: e.claimAttemptId,
        sha: e.sha,
        status: { t: 'pending' },
      });
      return;
    case 'integrated':
      integrationOf(s, e.integrationId).status = { t: 'integrated', mergeSha: e.mergeSha };
      s.unseen.push(e);
      return;
    case 'integration_refused':
      integrationOf(s, e.integrationId).status = { t: 'refused', refusal: e.refusal };
      s.unseen.push(e);
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
      attemptOf(s, e.attemptId).phase = { t: 'admitted' };
      return;
    case 'worktree_ready':
      Object.assign(worktreeOf(s, e.attemptId), {
        path: e.path,
        branch: e.branch,
        baseSha: e.baseSha,
        status: { t: 'ready' },
      });
      return;
    case 'worktree_failed':
      worktreeOf(s, e.attemptId).status = { t: 'failed', reason: e.reason };
      attemptOf(s, e.attemptId).phase = { t: 'dropped', reason: e.reason };
      // Shown to the next manager, which may plan the work again.
      s.unseen.push(e);
      return;
    case 'worktree_released':
      worktreeOf(s, e.attemptId).status = e.release;
      return;
    case 'validation_planned':
      s.validations.push({
        id: e.validationId,
        target: e.target,
        phase: { t: 'planned' },
        runs: [],
      });
      return;
    case 'validation_started':
      validationOf(s, e.validationId).phase = {
        t: 'started',
        targetSha: e.baseSha,
        tree: { name: e.name, path: e.path, branch: e.branch, baseSha: e.baseSha },
        treeStatus: { t: 'creating' },
      };
      return;
    case 'validation_tree_ready':
      startedOf(s, e.validationId).treeStatus = { t: 'ready' };
      return;
    case 'validation_tree_failed':
      startedOf(s, e.validationId).treeStatus = { t: 'failed', reason: e.reason };
      return;
    case 'validation': {
      const v = validationOf(s, e.validationId);
      v.runs.push({ checkIndex: e.checkIndex, outcome: e.outcome });
      // A finished candidate validation is shown to the next manager (it may integrate or retry);
      // a head validation is reported through the done it decides (`finished` / `done_refused`).
      if (validationComplete(s, v) && reportsToManager(v.target)) s.unseen.push(e);
      return;
    }
    case 'validation_released':
      startedOf(s, e.validationId).treeStatus = e.release;
      return;
    case 'done_requested':
      s.doneRequest = { t: 'validating', validationId: e.validationId, summary: e.summary };
      return;
    case 'done_refused':
      s.doneRequest = { t: 'none' };
      s.unseen.push(e);
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
      // A manager is shown what was unseen when it was planned (its brief is built after this).
      if (e.spec.kind === 'manager') {
        s.shown[e.attemptId] = s.unseen;
        s.unseen = [];
      }
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
    case 'attempt_metered':
      s.costs[e.attemptId] = e.cost;
      return;
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
        after: e.after,
        status: 'open',
      });
      // Shown to the next manager: the host assigns question ids, so a turn that only decomposes
      // must be followed by one that can start work on them (never idle, decide.ts).
      s.unseen.push(e);
      return;
    case 'question_closed':
      questionOf(s, e.questionId).status = e.status;
      return;
    case 'rejected':
      s.unseen.push(e);
      return;
    case 'feedback':
      s.chatCursor = cursorAfter(s.chatCursor, e.via);
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
      s.run = { t: 'finished', reason: e.reason, summary: e.summary, at: e.at };
      s.doneRequest = { t: 'none' };
      return;
  }
}

function cursorAfter(cursor: ChatCursor, via: FeedbackVia): ChatCursor {
  switch (via.t) {
    case 'tool':
      return cursor;
    case 'chat':
      return { t: 'after', ord: via.ord };
  }
}

function reportsToManager(target: ValidationTarget): boolean {
  switch (target.t) {
    case 'candidate':
      return true;
    case 'head':
      return false;
  }
}

/** The charter's command checks with their indexes (none for owner judgment). */
export function commandChecks(c: Charter): { index: number; check: CommandCheck }[] {
  const checks = 'checks' in c.done ? c.done.checks : [];
  return checks.flatMap((check, index) => (check.kind === 'command' ? [{ index, check }] : []));
}
/** The charter's judged done items (the goal panel verifies them). */
export function judgedChecks(c: Charter): string[] {
  const checks = 'checks' in c.done ? c.done.checks : [];
  return checks.flatMap((check) => (check.kind === 'judged' ? [check.text] : []));
}

/** Every command check has a recorded outcome (a failed tree records `error` for each). */
export const validationComplete = (s: State, v: Validation) =>
  v.runs.length >= commandChecks(s.charter).length;
export const validationPassed = (s: State, v: Validation) =>
  validationComplete(s, v) && v.runs.every((r) => r.outcome.t === 'passed');

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
export function validationOf(s: State, id: string): Validation {
  const validation = byId(s.validations, id);
  if (!validation) throw new Error(`unknown validation ${id}`);
  return validation;
}
/** A validation the ledger says started (its tree recorded); otherwise a corrupt ledger. */
export function startedOf(s: State, id: string): Extract<ValidationPhase, { t: 'started' }> {
  const { phase } = validationOf(s, id);
  if (phase.t !== 'started') throw new Error(`validation ${id} is ${phase.t}`);
  return phase;
}
export function integrationOf(s: State, id: string): Integration {
  const integration = byId(s.integrations, id);
  if (!integration) throw new Error(`unknown integration ${id}`);
  return integration;
}

/** The expedition branch head as the ledger knows it: the newest merge the host made, else the
 * launch base. (The branch is written only by the host's integration worktree.) */
export const headOf = (s: State): string =>
  s.integrations.flatMap((i) => (i.status.t === 'integrated' ? [i.status.mergeSha] : [])).at(-1) ??
  s.repo.baseSha;

export function questionOf(s: State, id: string): Question {
  const question = byId(s.questions, id);
  if (!question) throw new Error(`unknown question ${id}`);
  return question;
}
