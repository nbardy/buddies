import type {
  Acceptance,
  Charter,
  CheckResult,
  Claim,
  CommandCheck,
  Feedback,
  ManagerAction,
  Origin,
  QuestionScope,
  WorkResult,
} from './charter';
import { doneChecks } from './charter';

// Pattern: pure-core + persisted-state-machine (docs/patterns.md): the append-only ledger is the
// ONE persisted state; intents land BEFORE effects run, so a crash resumes from it (design.md).

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
export type ManagerSpec = { kind: 'manager' };
export type WorkerSpec = WorkSpec | CheckSpec;
export type AttemptSpec = ManagerSpec | WorkerSpec;

/** How an attempt ended by itself. `malformed` and `failed` are data, never silently dropped. */
export type EndOutcome =
  | { t: 'manager'; actions: ManagerAction[] }
  | { t: 'work'; result: WorkResult }
  | { t: 'check'; result: CheckResult }
  | { t: 'malformed'; error: string; raw: string }
  | { t: 'failed'; status: 'failed' | 'cancelled' }
  /** Asked to stop (owner stop, deadline) and not ended within observe.ts CANCEL_GRACE_MS. */
  | { t: 'abandoned'; reason: string }
  /** Live at a server restart: replanned once under a new id (owner 2026-11-03). Unbudgeted. */
  | { t: 'interrupted'; cause: 'server_restart'; runIds: string[] };

export const interruptedEnd = (o: Outcome): boolean =>
  o.t === 'interrupted' || (o.t === 'unreported_commits' && o.ended.t === 'interrupted');

/** A work attempt ended without a code claim but left commits the manager may claim (R11;
 * incident 2026-11-01: w64130b and w475a3b left commits nothing could integrate). */
export type Outcome = EndOutcome | { t: 'unreported_commits'; shas: string[]; ended: EndOutcome };

export type ClaimState =
  | { t: 'commit'; claim: Claim; sha: string }
  | { t: 'no_code'; claim: Claim }
  | { t: 'none' };

/** Only a work `claim` claims: a commit candidate, or a claim about something other than code. */
export function claimState(o: Outcome): ClaimState {
  if (o.t !== 'work' || o.result.result !== 'claim') return { t: 'none' };
  const claim = o.result;
  return claim.change.t === 'commit'
    ? { t: 'commit', claim, sha: claim.change.sha }
    : { t: 'no_code', claim };
}

export type Round = 'brief' | 'repair';

/** Validator files are trusted as committed at `trustedSha` (the head when declared; pins.ts). */
export type DeclaredAcceptance = { rule: Acceptance; rev: number; trustedSha: string };

export type Adoption =
  | { t: 'pending'; claim: Claim }
  | { t: 'adopted' }
  | { t: 'refused'; reason: string };

/** Provider-counted tokens (R6), or why none exist. No USD: that would be an estimate. */
export type AttemptCost =
  | {
      t: 'measured';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | { t: 'unmeasured'; reason: string };

/** Owner feedback via the `expedition` tool, or an expedition chat message (recorded once). */
export type FeedbackVia = { t: 'tool' } | { t: 'chat'; postId: string; ord: string };

export type ChatCursor = { t: 'start' } | { t: 'after'; ord: string };

export const FINISH_REASONS = [
  'done',
  'attempts_spent',
  'decisions_spent',
  'deadline',
  'owner_stop',
  'setup_failed',
] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

export type Repo = { root: string; baseSha: string; branch: string };

export type WorktreeAt = { path: string; branch: string; baseSha: string };

/** `left`: removal refused (uncommitted changes are never forced) or a create not rolled back. */
export type Release =
  | { t: 'removed'; branchDeleted: boolean }
  | { t: 'kept'; commits: number }
  | { t: 'absent' }
  | { t: 'left'; reason: string };

export type TreeStatus =
  | { t: 'creating' }
  | { t: 'ready' }
  | { t: 'failed'; reason: string }
  | Release;

/** A validation whose job died restarts in a NEW tree, never one an orphan may write into. */
export type TreeId =
  | { t: 'integration' }
  | { t: 'manager' }
  | { t: 'attempt'; attemptId: string }
  | { t: 'validation'; validationId: string; restart: number };

export const INTEGRATION_TREE = { t: 'integration' } as const satisfies TreeId;
export const MANAGER_TREE = { t: 'manager' } as const satisfies TreeId;

export function treeKey(id: TreeId): string {
  switch (id.t) {
    case 'integration':
    case 'manager':
      return id.t;
    case 'attempt':
      return id.attemptId;
    case 'validation':
      return id.restart === 0 ? id.validationId : `${id.validationId}-r${id.restart}`;
  }
}

export type ByTree<A extends unknown[], R> = {
  [K in TreeId['t']]: (id: Extract<TreeId, { t: K }>, ...args: A) => R;
};
export const byTree = <A extends unknown[], R>(table: ByTree<A, R>, id: TreeId, ...args: A): R =>
  (table[id.t] as (id: TreeId, ...args: A) => R)(id, ...args);

export type Lifetime = 'ephemeral' | 'owned';

/** Recorded before the tree is made: a Cambium workspace, or the manager's detached worktree. */
export type Place =
  | ({ t: 'workspace'; name: string; lifetime: Lifetime } & WorktreeAt)
  | { t: 'detached'; path: string };

export type Tree = { id: TreeId; place: Place; status: TreeStatus; preserved: Preserved[] };

export type Workspace = Extract<Place, { t: 'workspace' }> & {
  status: TreeStatus;
  preserved: Preserved[];
};

export type ValidationTarget =
  | { t: 'candidate'; claimAttemptId: string; sha: string }
  | { t: 'head' };

export type SourcePin = { path: string; sha256: string };

export type PinCheck =
  | { t: 'held' }
  | { t: 'changed'; paths: string[] }
  | { t: 'unpinned'; reason: string };

/** The typed record of one host-run check (ported from oompa's `oompa.task-validation/v1`). */
export interface ValidationReport {
  t: 'expedition.validation/v1';
  targetSha: string;
  pins: SourcePin[];
  pinCheck: PinCheck;
}

export type Preserved =
  | { t: 'salvaged'; ref: string; sha: string }
  | { t: 'harvested'; dir: string; files: number; bytes: number };

export type CheckOutcome =
  | { t: 'passed' }
  | { t: 'failed'; exitCode: number; tail: string }
  | { t: 'timed_out'; tail: string }
  | { t: 'error'; message: string };

export type CheckRun = { checkIndex: number; outcome: CheckOutcome; report: ValidationReport };

/** Frozen at plan time: index 0 for a candidate, its `charter.done.checks` index for the head. */
export type ValidationCheck = { index: number; argv: string[]; timeoutSeconds: number };

export type ValidationBasis =
  | { t: 'done' }
  | { t: 'acceptance'; questionId: string; rev: number; trustedSha: string };

export interface Validation {
  id: string;
  target: ValidationTarget;
  basis: ValidationBasis;
  checks: ValidationCheck[];
  /** Tree keys, oldest first: the last is the one its checks run in. */
  trees: string[];
  /** A process that finds `running` without starting the job knows it died (audit #10). */
  job: { t: 'idle' } | { t: 'running' };
  runs: CheckRun[];
  failure: { t: 'none' } | { t: 'failed'; reason: string };
}

/** `tree`: the integration worktree was not clean on its branch, so nothing was attempted. */
export type IntegrationRefusal =
  | { phase: 'merge'; paths: string[] }
  | { phase: 'git'; reason: string }
  | { phase: 'tree'; reason: string };

export type IntegrationStatus =
  | { t: 'pending' }
  | { t: 'integrated'; mergeSha: string }
  | { t: 'refused'; refusal: IntegrationRefusal };

export interface Integration {
  id: string;
  claimAttemptId: string;
  sha: string;
  status: IntegrationStatus;
}

/** `refused` names each step the host would not take, cleared by the owner's next request. */
export type Retirement =
  | { t: 'active' }
  | { t: 'retiring'; at: string; by: string; refused: { branch: string; reason: string }[] }
  | { t: 'retired'; at: string };

export type RetireChat = 'crew_chat' | 'attempts';

export interface Archive {
  tags: { branch: string; sha: string; tag: string }[];
  branches: { t: 'pending' } | { t: 'archived' };
  chats: RetireChat[];
  crew: { t: 'active' } | { t: 'archived' };
}

export type Entry = EntryBody & { at: string };
type EntryBody =
  | {
      t: 'launched';
      id: string;
      /** Idempotency: one launch per (conversation, name); a retried tool call returns it. */
      key: string;
      charter: Charter;
      origin: Origin;
      launcherId: string;
      workspaceId: string;
      repo: Repo;
    }
  /** Intent before the tree is made: a crash leaves a name and path the replay adopts. */
  | { t: 'tree_planned'; tree: TreeId; place: Place }
  | { t: 'tree_ready'; tree: TreeId }
  | { t: 'tree_failed'; tree: TreeId; reason: string }
  | { t: 'tree_released'; tree: TreeId; release: Release; preserved: Preserved[] }
  | { t: 'integration_planned'; integrationId: string; claimAttemptId: string; sha: string }
  | { t: 'integrated'; integrationId: string; sha: string; mergeSha: string }
  | { t: 'integration_refused'; integrationId: string; sha: string; refusal: IntegrationRefusal }
  | {
      t: 'validation_planned';
      validationId: string;
      target: ValidationTarget;
      checks: ValidationCheck[];
    }
  /** Terminal, never re-run (audit #5: a rejected job re-ran every tick, a hot loop). */
  | { t: 'validation_failed'; validationId: string; reason: string }
  | {
      t: 'validation';
      validationId: string;
      targetSha: string;
      checkIndex: number;
      outcome: CheckOutcome;
      report: ValidationReport;
    }
  | { t: 'validation_running'; validationId: string }
  | { t: 'attempt_cancel_requested'; attemptId: string; runIds: string[] }
  | { t: 'done_requested'; validationId: string; summary: string }
  | { t: 'done_refused'; reason: string }
  | { t: 'crew_ready'; buddyId: string; chatChannelId: string }
  | { t: 'badge_posted'; postId: string }
  | { t: 'reflection'; text: string }
  | { t: 'attempt_planned'; attemptId: string; spec: AttemptSpec }
  | { t: 'attempt_retry_planned'; attemptId: string; retryOf: string; spec: WorkSpec | CheckSpec }
  /** The exact brief, written before the request post so a replay sends identical bytes. */
  | { t: 'attempt_posting'; attemptId: string; body: string }
  | { t: 'attempt_posted'; attemptId: string; requestId: string }
  | { t: 'attempt_repair_posting'; attemptId: string; error: string; body: string }
  | { t: 'claim_planned'; attemptId: string; claim: Claim }
  | { t: 'claim_adopted'; attemptId: string }
  | { t: 'claim_refused'; attemptId: string; reason: string }
  | { t: 'tick_failed'; failures: number; reason: string }
  | { t: 'attempt_ended'; attemptId: string; outcome: Outcome }
  | { t: 'attempt_metered'; attemptId: string; cost: AttemptCost }
  | {
      t: 'question_added';
      questionId: string;
      title: string;
      detail: string;
      scope: QuestionScope;
      /** File custody: normalized repo-relative prefixes (charter.ts CustodyPath). */
      paths: string[];
      /** Question ids whose verified close this question's work waits for (R5). */
      after: string[];
      acceptance: Acceptance;
    }
  | { t: 'acceptance_set'; questionId: string; acceptance: Acceptance }
  | { t: 'question_closed'; questionId: string; status: 'verified' | 'dead'; why: string }
  | { t: 'manager_applied'; attemptId: string }
  | { t: 'rejected'; action: ManagerAction; reason: string }
  | { t: 'feedback'; from: string; via: FeedbackVia; feedback: Feedback }
  | { t: 'needs_owner'; question: string }
  | { t: 'status'; seq: number; text: string }
  | { t: 'status_posted'; seq: number; postId: string }
  | { t: 'finished'; reason: FinishReason; summary: string }
  /** `stop`: the owner's stop was recorded with it, so owner_stop finishes it first. */
  | { t: 'retire_requested'; by: string; stop: boolean }
  | { t: 'branch_archived'; branch: string; sha: string; tag: string }
  | { t: 'archive_refused'; branch: string; reason: string }
  | { t: 'branches_archived' }
  | { t: 'chat_archived'; chat: RetireChat; channelId: string }
  | { t: 'crew_archived'; buddyId: string }
  | { t: 'retired' };

type Readers = { news: boolean; manager: boolean };
const FOLD = { news: false, manager: false } as const;
const NEWS = { news: true, manager: false } as const;
const MANAGER = { news: false, manager: true } as const;
const BOTH = { news: true, manager: true } as const;

// Exhaustive: each kind's readers type `s.news` and `s.unseen`, which renderers switch over.
// biome-ignore format: a dense table reads better than one kind per line
const ENTRY = {
  launched: FOLD, tree_planned: FOLD, tree_ready: FOLD, tree_failed: MANAGER, tree_released: FOLD,
  integration_planned: FOLD, integrated: BOTH, integration_refused: BOTH,
  validation_planned: FOLD, validation_failed: BOTH, validation: BOTH, validation_running: FOLD,
  attempt_cancel_requested: FOLD, done_requested: NEWS, done_refused: BOTH, crew_ready: FOLD,
  badge_posted: FOLD, reflection: NEWS, attempt_planned: NEWS, attempt_retry_planned: NEWS,
  attempt_posting: FOLD, attempt_posted: NEWS, attempt_repair_posting: FOLD, claim_planned: FOLD,
  claim_adopted: BOTH, claim_refused: BOTH, tick_failed: NEWS, attempt_ended: BOTH,
  attempt_metered: FOLD, question_added: BOTH, acceptance_set: MANAGER, question_closed: NEWS,
  manager_applied: FOLD, rejected: BOTH, feedback: BOTH, needs_owner: NEWS, status: FOLD,
  status_posted: FOLD, finished: NEWS, retire_requested: FOLD, branch_archived: FOLD,
  archive_refused: FOLD, branches_archived: FOLD, chat_archived: FOLD, crew_archived: FOLD,
  retired: FOLD,
} as const satisfies Record<Entry['t'], Readers>;

type KindsFor<R extends keyof Readers> = {
  [K in Entry['t']]: (typeof ENTRY)[K][R] extends true ? K : never;
}[Entry['t']];
export type NewsEntry = Extract<Entry, { t: KindsFor<'news'> }>;
export type ShownEntry = Extract<Entry, { t: KindsFor<'manager'> }>;

/** Stored lines are unchecked (store.ts): name an unknown kind so the quarantine reason says it. */
function isNews(e: Entry): e is NewsEntry {
  const readers: Readers | undefined = (ENTRY as Record<string, Readers>)[e.t];
  if (readers === undefined) throw new Error(`unknown ledger entry ${e.t}`);
  return readers.news;
}

export type AttemptPhase =
  | { t: 'planned' }
  | { t: 'admitted' }
  | { t: 'dropped'; reason: string }
  | { t: 'posting'; body: string; round: Round }
  | { t: 'posted'; requestId: string; round: Round }
  | { t: 'ended'; requestId: string; outcome: Outcome; endedAt: string };

export interface Attempt<S extends AttemptSpec = AttemptSpec> {
  id: string;
  spec: S;
  phase: AttemptPhase;
  plannedAt: string;
}

export interface Question {
  id: string;
  title: string;
  detail: string;
  scope: QuestionScope;
  paths: string[];
  after: string[];
  acceptance: DeclaredAcceptance;
  status: 'open' | 'verified' | 'dead';
}

export type Run =
  | { t: 'running' }
  | { t: 'paused' }
  | { t: 'waiting_owner'; question: string }
  // `at` stops the badge's clock: "finished · 10m" kept growing after the end (e2e 2026-11-01).
  | { t: 'finished'; at: string; reason: FinishReason; summary: string };

export interface Status {
  seq: number;
  text: string;
  post: { t: 'pending' } | { t: 'posted'; postId: string };
}

export interface State {
  id: string;
  key: string;
  charter: Charter;
  origin: Origin;
  launcherId: string;
  workspaceId: string;
  repo: Repo;
  trees: Record<string, Tree>;
  integrations: Integration[];
  validations: Validation[];
  doneRequest: { t: 'none' } | { t: 'validating'; validationId: string; summary: string };
  launchedAt: string;
  crew: { t: 'pending' } | { t: 'ready'; buddyId: string; chatChannelId: string };
  badgePost: { t: 'pending' } | { t: 'posted'; postId: string };
  reflections: { at: string; text: string }[];
  briefs: Record<string, string>;
  repairs: Record<string, string>;
  requests: Record<string, string[]>;
  adoptions: Record<string, Adoption>;
  extendedHours: number;
  tickFailure: { t: 'none' } | { t: 'failing'; at: string; failures: number; reason: string };
  costs: Record<string, AttemptCost>;
  cancels: Record<string, { at: string; runIds: string[] }>;
  news: NewsEntry[];
  managers: Attempt<ManagerSpec>[];
  workers: Attempt<WorkerSpec>[];
  questions: Question[];
  lessons: string[];
  chatCursor: ChatCursor;
  unseen: ShownEntry[];
  shown: Record<string, ShownEntry[]>;
  run: Run;
  statuses: Status[];
  appliedManagers: Set<string>;
  retries: Record<string, string>;
  retirement: Retirement;
  archive: Archive;
  /** Entries applied since launch: queries.ts `derive` caches its views per revision. */
  revision: number;
}

export const doneValidationChecks = (c: Charter): ValidationCheck[] =>
  commandChecks(c).map(({ index, check: { argv, timeoutSeconds } }) => ({
    index,
    argv,
    timeoutSeconds,
  }));

export function fold(entries: readonly Entry[]): State {
  const [first, ...rest] = entries;
  if (!first || first.t !== 'launched') throw new Error('ledger must start with launched');
  const { id, key, charter, origin, launcherId, workspaceId, repo } = first;
  const state: State = {
    ...{ id, key, charter, origin, launcherId, workspaceId, repo, launchedAt: first.at },
    ...{ trees: {}, integrations: [], validations: [], doneRequest: { t: 'none' } },
    ...{ crew: { t: 'pending' }, badgePost: { t: 'pending' }, reflections: [] },
    ...{ briefs: {}, repairs: {}, requests: {}, adoptions: {}, costs: {}, cancels: {} },
    ...{ extendedHours: 0, tickFailure: { t: 'none' }, news: [], managers: [], workers: [] },
    ...{ questions: [], lessons: [], chatCursor: { t: 'start' }, unseen: [], shown: {} },
    ...{ run: { t: 'running' }, statuses: [], appliedManagers: new Set(), retries: {} },
    retirement: { t: 'active' },
    archive: { tags: [], branches: { t: 'pending' }, chats: [], crew: { t: 'active' } },
    revision: 0,
  };
  for (const entry of rest) apply(state, entry);
  return state;
}

export function apply(s: State, e: Entry): void {
  s.revision += 1;
  if (isNews(e)) s.news.push(e);
  switch (e.t) {
    case 'launched':
      throw new Error('launched may only open a ledger');
    case 'tree_planned': {
      const key = treeKey(e.tree);
      if (key in s.trees) throw new Error(`tree ${key} planned twice`);
      s.trees[key] = { id: e.tree, place: e.place, status: { t: 'creating' }, preserved: [] };
      byTree(PLANNED, e.tree, s, key);
      return;
    }
    case 'tree_ready':
      treeOf(s, e.tree).status = { t: 'ready' };
      return;
    case 'tree_failed':
      treeOf(s, e.tree).status = { t: 'failed', reason: e.reason };
      byTree(FAILED, e.tree, s, e);
      return;
    case 'tree_released': {
      const tree = treeOf(s, e.tree);
      tree.status = e.release;
      tree.preserved.push(...e.preserved);
      return;
    }
    case 'integration_planned': {
      const { integrationId: id, claimAttemptId, sha } = e;
      s.integrations.push({ id, claimAttemptId, sha, status: { t: 'pending' } });
      return;
    }
    case 'integrated':
      integrationOf(s, e.integrationId).status = { t: 'integrated', mergeSha: e.mergeSha };
      s.unseen.push(e);
      return;
    case 'integration_refused':
      integrationOf(s, e.integrationId).status = { t: 'refused', refusal: e.refusal };
      s.unseen.push(e);
      return;
    case 'validation_planned':
      s.validations.push({
        ...{ id: e.validationId, target: e.target, basis: basisOf(s, e.target), checks: e.checks },
        ...{ trees: [], job: { t: 'idle' }, runs: [], failure: { t: 'none' } },
      });
      return;
    case 'validation_failed': {
      const v = validationOf(s, e.validationId);
      v.failure = { t: 'failed', reason: e.reason };
      if (v.target.t === 'candidate') s.unseen.push(e);
      return;
    }
    case 'validation': {
      const v = validationOf(s, e.validationId);
      v.runs.push({ checkIndex: e.checkIndex, outcome: e.outcome, report: e.report });
      // A head validation is reported through the done it decides (`finished` / `done_refused`).
      if (validationComplete(v) && v.target.t === 'candidate') s.unseen.push(e);
      return;
    }
    case 'validation_running': {
      const v = validationOf(s, e.validationId);
      currentTree(s, v);
      v.job = { t: 'running' };
      return;
    }
    case 'attempt_cancel_requested':
      s.cancels[e.attemptId] = { at: e.at, runIds: e.runIds };
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
      planAttempt(s, e.attemptId, e.spec, e.at);
      return;
    case 'attempt_retry_planned':
      if (attemptOf(s, e.retryOf).phase.t !== 'ended' || e.retryOf in s.retries)
        throw new Error(`attempt ${e.retryOf} retried unended or twice`);
      s.workers.push({ id: e.attemptId, spec: e.spec, phase: { t: 'planned' }, plannedAt: e.at });
      s.retries[e.retryOf] = e.attemptId;
      return;
    case 'attempt_posting':
      attemptOf(s, e.attemptId).phase = { t: 'posting', body: e.body, round: 'brief' };
      s.briefs[e.attemptId] = e.body;
      return;
    case 'attempt_repair_posting': {
      const attempt = attemptOf(s, e.attemptId);
      if (attempt.phase.t !== 'posted' || attempt.phase.round !== 'brief')
        throw new Error(`attempt ${e.attemptId} repaired outside its brief round`);
      attempt.phase = { t: 'posting', body: e.body, round: 'repair' };
      s.repairs[e.attemptId] = e.body;
      return;
    }
    case 'attempt_posted': {
      const attempt = attemptOf(s, e.attemptId);
      if (attempt.phase.t !== 'posting') throw new Error(`attempt ${e.attemptId} posted unbriefed`);
      attempt.phase = { t: 'posted', requestId: e.requestId, round: attempt.phase.round };
      s.requests[e.attemptId] = [...(s.requests[e.attemptId] ?? []), e.requestId];
      return;
    }
    case 'attempt_ended': {
      const attempt = attemptOf(s, e.attemptId);
      if (attempt.phase.t !== 'posted') throw new Error(`attempt ${e.attemptId} ended unposted`);
      const { requestId } = attempt.phase;
      attempt.phase = { t: 'ended', requestId, outcome: e.outcome, endedAt: e.at };
      // A manager's malformed/failed/interrupted end is shown, so the next turn retries.
      if (attempt.spec.kind !== 'manager' || END_SHOWN.has(e.outcome.t)) s.unseen.push(e);
      return;
    }
    case 'claim_planned':
      s.adoptions[e.attemptId] = { t: 'pending', claim: e.claim };
      return;
    case 'claim_adopted': {
      const adoption = s.adoptions[e.attemptId];
      const attempt = attemptOf(s, e.attemptId);
      if (adoption?.t !== 'pending' || attempt.phase.t !== 'ended')
        throw new Error(`claim of ${e.attemptId} adopted unplanned`);
      attempt.phase = { ...attempt.phase, outcome: { t: 'work', result: adoption.claim } };
      s.adoptions[e.attemptId] = { t: 'adopted' };
      s.unseen.push(e);
      return;
    }
    case 'claim_refused':
      s.adoptions[e.attemptId] = { t: 'refused', reason: e.reason };
      s.unseen.push(e);
      return;
    case 'tick_failed':
      s.tickFailure = { t: 'failing', at: e.at, failures: e.failures, reason: e.reason };
      return;
    case 'attempt_metered':
      s.costs[e.attemptId] = e.cost;
      return;
    case 'manager_applied':
      s.appliedManagers.add(e.attemptId);
      return;
    case 'question_added': {
      const { questionId: id, title, detail, scope, paths, after } = e;
      const acceptance = { rule: e.acceptance, rev: 0, trustedSha: headOf(s) };
      s.questions.push({ id, title, detail, scope, paths, after, acceptance, status: 'open' });
      // Shown: the host assigns question ids, so a decomposing turn needs a follow-up (decide.ts).
      s.unseen.push(e);
      return;
    }
    case 'acceptance_set': {
      const question = questionOf(s, e.questionId);
      const rev = question.acceptance.rev + 1;
      question.acceptance = { rule: e.acceptance, rev, trustedSha: headOf(s) };
      // Regression 2026-11-01: unshown, a set_acceptance-only turn looked quiescent (the L3 loop).
      s.unseen.push(e);
      return;
    }
    case 'question_closed':
      questionOf(s, e.questionId).status = e.status;
      return;
    case 'rejected':
      s.unseen.push(e);
      return;
    case 'feedback':
      if (e.via.t === 'chat') s.chatCursor = { t: 'after', ord: e.via.ord };
      if (s.run.t !== 'finished') applyFeedback(s, e);
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
      s.run = { t: 'finished', at: e.at, reason: e.reason, summary: e.summary };
      s.doneRequest = { t: 'none' };
      return;
    case 'retire_requested':
      if (s.retirement.t === 'retired') throw new Error('retire requested of a retired expedition');
      s.retirement = { t: 'retiring', at: e.at, by: e.by, refused: [] };
      return;
    case 'branch_archived':
      retiringOf(s);
      s.archive.tags.push({ branch: e.branch, sha: e.sha, tag: e.tag });
      return;
    case 'archive_refused':
      retiringOf(s).refused.push({ branch: e.branch, reason: e.reason });
      return;
    case 'branches_archived':
      retiringOf(s);
      s.archive.branches = { t: 'archived' };
      return;
    case 'chat_archived':
      retiringOf(s);
      s.archive.chats.push(e.chat);
      return;
    case 'crew_archived':
      retiringOf(s);
      s.archive.crew = { t: 'archived' };
      return;
    case 'retired':
      retiringOf(s);
      s.retirement = { t: 'retired', at: e.at };
      return;
  }
  // Regression: a pre-B5 ledger folded with its unknown lines skipped and failed every tick.
  const unknown: never = e;
  throw new Error(`unknown ledger entry ${(unknown as { t: string }).t}`);
}

function planAttempt(s: State, attemptId: string, spec: AttemptSpec, at: string): void {
  switch (spec.kind) {
    case 'manager':
      s.managers.push({ id: attemptId, spec, phase: { t: 'planned' }, plannedAt: at });
      s.shown[attemptId] = s.unseen;
      s.unseen = [];
      return;
    case 'work':
    case 'check':
      s.workers.push({ id: attemptId, spec, phase: { t: 'planned' }, plannedAt: at });
      return;
  }
}

const END_SHOWN: ReadonlySet<Outcome['t']> = new Set(['malformed', 'failed', 'interrupted']);

/** Planning a tree admits its attempt (slot and custody), or gives a validation a fresh tree. */
const PLANNED: ByTree<[State, string], void> = {
  integration: () => undefined,
  manager: () => undefined,
  attempt: ({ attemptId }, s) => {
    attemptOf(s, attemptId).phase = { t: 'admitted' };
  },
  validation: ({ validationId }, s, key) => {
    const v = validationOf(s, validationId);
    v.trees.push(key);
    v.job = { t: 'idle' };
  },
};

/** An unmade attempt tree drops it; integration/manager trees finish the run (decide.ts). */
const FAILED: ByTree<[State, Extract<Entry, { t: 'tree_failed' }>], void> = {
  integration: () => undefined,
  manager: () => undefined,
  attempt: ({ attemptId }, s, e) => {
    attemptOf(s, attemptId).phase = { t: 'dropped', reason: e.reason };
    s.unseen.push(e);
  },
  validation: () => undefined,
};

function retiringOf(s: State): Extract<Retirement, { t: 'retiring' }> {
  if (s.retirement.t !== 'retiring') throw new Error(`retirement step while ${s.retirement.t}`);
  return s.retirement;
}

/** A candidate validation answers for its claim's question's acceptance as it stands now. */
function basisOf(s: State, target: ValidationTarget): ValidationBasis {
  switch (target.t) {
    case 'head':
      return { t: 'done' };
    case 'candidate': {
      const { questionId } = workOf(s, target.claimAttemptId).spec;
      const { rev, trustedSha } = questionOf(s, questionId).acceptance;
      return { t: 'acceptance', questionId, rev, trustedSha };
    }
  }
}

export const commandChecks = (c: Charter): { index: number; check: CommandCheck }[] =>
  doneChecks(c.done).flatMap((check, index) =>
    check.kind === 'command' ? [{ index, check }] : []
  );
export const judgedChecks = (c: Charter): string[] =>
  doneChecks(c.done).flatMap((check) => (check.kind === 'judged' ? [check.text] : []));

/** Every check has an outcome, or the host recorded that it could not run them at all. */
export const validationComplete = (v: Validation) =>
  v.failure.t === 'failed' || v.runs.length >= v.checks.length;
export const validationPassed = (v: Validation) =>
  validationComplete(v) && v.failure.t === 'none' && v.runs.every((r) => r.outcome.t === 'passed');

function applyFeedback(s: State, e: Extract<Entry, { t: 'feedback' }>): void {
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
      // Shown, so a resume re-plans (incident 2026-11-01: it asked the owner again at once).
      s.unseen.push(e);
      s.run = { t: 'running' };
      return;
    case 'extend':
      s.extendedHours += e.feedback.hours;
      s.unseen.push(e);
      return;
    case 'stop':
      // decide appends `finished`, so the stop is recorded with its reason.
      s.unseen.push(e);
      return;
  }
}

export const byId = <T extends { id: string }>(rows: T[], id: string) =>
  rows.find((r) => r.id === id);

/** A row the ledger names; a missing one is a corrupt ledger, never a skipped entry. */
function must<T>(row: T | undefined, missing: string): T {
  if (row === undefined) throw new Error(missing);
  return row;
}

export const allAttempts = (s: State): Attempt[] =>
  [...s.managers, ...s.workers].sort((a, b) => a.plannedAt.localeCompare(b.plannedAt));

export const attemptOf = (s: State, id: string): Attempt =>
  must(byId<Attempt>(s.workers, id) ?? byId<Attempt>(s.managers, id), `unknown attempt ${id}`);

export const requestsOf = (s: State, attemptId: string): string[] =>
  must(s.requests[attemptId], `attempt ${attemptId} posted no request`);

export const worksOf = (s: State): Attempt<WorkSpec>[] =>
  s.workers.filter((a): a is Attempt<WorkSpec> => a.spec.kind === 'work');
export const workOf = (s: State, id: string): Attempt<WorkSpec> =>
  must(byId(worksOf(s), id), `${id} is not a work attempt`);
export const treeOf = (s: State, id: TreeId): Tree =>
  must(s.trees[treeKey(id)], `no tree ${treeKey(id)}`);
export function workspaceOf(s: State, id: TreeId): Workspace {
  const { place, status, preserved } = treeOf(s, id);
  if (place.t !== 'workspace') throw new Error(`tree ${treeKey(id)} is ${place.t}`);
  return { ...place, status, preserved };
}
export type TargetSha = { t: 'unresolved' } | { t: 'at'; sha: string };
export function targetShaOf(s: State, v: Validation): TargetSha {
  const key = v.trees.at(-1);
  return key === undefined
    ? { t: 'unresolved' }
    : { t: 'at', sha: workspaceOf(s, s.trees[key].id).baseSha };
}
export const worktreeOf = (s: State, attemptId: string): Workspace =>
  workspaceOf(s, { t: 'attempt', attemptId });
export const currentTree = (s: State, v: Validation): Tree =>
  s.trees[must(v.trees.at(-1), `validation ${v.id} has no tree`)];
export const validationOf = (s: State, id: string): Validation =>
  must(byId(s.validations, id), `unknown validation ${id}`);
export const integrationOf = (s: State, id: string): Integration =>
  must(byId(s.integrations, id), `unknown integration ${id}`);
export const questionOf = (s: State, id: string): Question =>
  must(byId(s.questions, id), `unknown question ${id}`);

export const headOf = (s: State): string =>
  s.integrations.flatMap((i) => (i.status.t === 'integrated' ? [i.status.mergeSha] : [])).at(-1) ??
  s.repo.baseSha;
